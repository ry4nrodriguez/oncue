// Record 03's artifact upload and downloads. The bridge's PUT carries a
// one-time bearer the object spends before a byte is read; the body streams at
// exactly the declared length into R2 with the SHA-256 R2 verifies, and
// `artifact.created` commits only after R2 accepts it. The R2 binding avoids
// putting an S3 credential in the Worker.
//
// Artifact bytes are untrusted: they are always served as an attachment with
// `nosniff` and a sandboxing CSP, never under the declared content type.

import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import { isKnownSession } from "../session/known-session";
import type {
  ArtifactAuthorizeResult,
  ArtifactCompleteResult,
  ArtifactReadResult,
} from "../session/session-object";
import { downloadNameFor } from "./policy";

const ARTIFACT_PATH = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)(\/restore)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ArtifactPath {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly restore: boolean;
}

export function matchArtifactPath(pathname: string): ArtifactPath | null {
  const match = ARTIFACT_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  return {
    sessionId: match[1] as string,
    artifactId: match[2] as string,
    restore: match[3] !== undefined,
  };
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token.length === 0 ? null : token;
}

function unavailable(): Response {
  return Response.json({ error: "artifact_unavailable" }, { status: 404 });
}

function storageUnavailable(): Response {
  return Response.json({ error: "artifact_storage_unavailable" }, { status: 503 });
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

async function callObject<T>(
  env: Env,
  sessionId: string,
  operation: "authorize" | "complete" | "fail" | "read",
  body: unknown,
): Promise<T> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const response = await stub.fetch(`https://session/internal/artifacts/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

// R2 error 10037, BadDigest.
function isChecksumRefusal(error: unknown): boolean {
  return String(error).includes("10037");
}

export async function handleUploadArtifact(
  request: Request,
  env: Env,
  path: ArtifactPath,
): Promise<Response> {
  const token = bearerFrom(request);
  if (token === null) {
    return forbidden();
  }
  // The token is checked in the session's object, which an id nobody created
  // would otherwise wake into existence.
  if (!(await isKnownSession(env.DB, path.sessionId))) {
    return forbidden();
  }
  const authorized = await callObject<ArtifactAuthorizeResult>(env, path.sessionId, "authorize", {
    artifactId: path.artifactId,
    token,
    purpose: "upload",
  });
  if (authorized.kind !== "authorized") {
    return forbidden();
  }
  const fail = (stage: "upload" | "validate", reason: string) =>
    callObject(env, path.sessionId, "fail", { artifactId: path.artifactId, stage, reason });
  // Checked after the token is spent, so a missing bucket records
  // `artifact.failed` rather than leaving the artifact `uploading` forever.
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    await fail("upload", "Artifact storage is not configured on this deployment.");
    return storageUnavailable();
  }
  const sha256 = request.headers.get("x-oncue-sha256") ?? "";
  const body = request.body;
  if (
    !SHA256_HEX.test(sha256) ||
    Number(request.headers.get("content-length")) !== authorized.declaredBytes ||
    body === null
  ) {
    await fail("validate", "The upload did not carry the declared length and a SHA-256 checksum.");
    return Response.json({ error: "upload_invalid" }, { status: 400 });
  }
  const fixed = new FixedLengthStream(authorized.declaredBytes);
  const stored = await Promise.all([
    bucket.put(authorized.objectKey, fixed.readable, {
      sha256,
      httpMetadata: { contentType: authorized.contentType },
    }),
    body.pipeTo(fixed.writable),
  ]).then(
    () => null,
    (error: unknown) => error,
  );
  if (stored !== null) {
    const checksum = isChecksumRefusal(stored);
    await fail(
      checksum ? "validate" : "upload",
      checksum
        ? "Storage refused the upload because its checksum did not match its bytes."
        : "Storage did not accept the upload.",
    );
    return checksum
      ? Response.json({ error: "checksum_mismatch" }, { status: 400 })
      : Response.json({ error: "upload_failed" }, { status: 502 });
  }
  const completed = await callObject<ArtifactCompleteResult>(env, path.sessionId, "complete", {
    artifactId: path.artifactId,
    byteSize: authorized.declaredBytes,
    sha256,
  });
  if (completed.kind !== "created") {
    // The session no longer wants this artifact; do not leave its bytes behind.
    await bucket.delete(authorized.objectKey);
    return Response.json({ error: "upload_refused" }, { status: 409 });
  }
  const index = completed.index;
  // The D1 index is a projection; the download reads the session object, so a
  // failure here costs discovery, never the artifact.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO artifact_index (
       artifact_id, workspace_id, session_id, run_id, kind, producer, content_type,
       byte_size, sha256, classification, object_key, expires_at, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      index.artifactId,
      index.workspaceId,
      index.sessionId,
      index.runId,
      index.kind,
      index.producer,
      index.contentType,
      index.byteSize,
      index.sha256,
      index.classification,
      index.objectKey,
      index.expiresAt,
      index.createdAt,
    )
    .run()
    .then(
      () => undefined,
      () => undefined,
    );
  return Response.json({ artifactId: path.artifactId }, { status: 201 });
}

const DOWNLOAD_HEADERS = {
  "content-type": "application/octet-stream",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
  "cache-control": "private, no-store",
} as const;

export async function handleDownloadArtifact(
  request: Request,
  env: Env,
  path: ArtifactPath,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, path.sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    return storageUnavailable();
  }
  const found = await callObject<ArtifactReadResult>(env, path.sessionId, "read", {
    artifactId: path.artifactId,
  });
  if (found.kind !== "found") {
    return unavailable();
  }
  // A missing object is reported as unavailable; its metadata is kept.
  const object = await bucket.get(found.objectKey);
  if (object === null) {
    return unavailable();
  }
  return new Response(object.body, {
    headers: {
      ...DOWNLOAD_HEADERS,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="${downloadNameFor(found.artifactKind, path.artifactId)}"`,
    },
  });
}

export async function handleRestoreArtifact(
  request: Request,
  env: Env,
  path: ArtifactPath,
): Promise<Response> {
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    return storageUnavailable();
  }
  const token = bearerFrom(request);
  if (token === null) {
    return forbidden();
  }
  if (!(await isKnownSession(env.DB, path.sessionId))) {
    return forbidden();
  }
  const authorized = await callObject<ArtifactAuthorizeResult>(env, path.sessionId, "authorize", {
    artifactId: path.artifactId,
    token,
    purpose: "restore",
  });
  if (authorized.kind !== "authorized") {
    return forbidden();
  }
  const object = await bucket.get(authorized.objectKey);
  if (object === null) {
    return unavailable();
  }
  return new Response(object.body, { headers: DOWNLOAD_HEADERS });
}
