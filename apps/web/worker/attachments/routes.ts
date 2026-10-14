// Composer attachments over HTTP (docs/decisions.md). An upload belongs to the
// workspace until a message claims it, so Home can attach a file before its
// session exists. The bridge's fetch uses a one-time bearer, never a cookie.
//
// The type comes from the bytes, and a response is only a raster image or an
// opaque download with `nosniff` and a sandboxing CSP, so no upload can run as
// a page on OnCue's origin.

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_REFUSAL_TEXT,
  type AttachmentRefusal,
  cleanAttachmentName,
  sniffAttachment,
} from "@oncue/protocol";
import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import {
  AUTHORIZE_DENIAL_HTTP_STATUS,
  authorizeActor,
  authorizeSessionRequest,
} from "../auth/authorize";
import { isKnownSession } from "../session/known-session";
import {
  attachmentObjectKey,
  countUnclaimed,
  discardUnclaimed,
  insertUpload,
  readSessionAttachment,
  refOf,
  sweepUnclaimedAttachments,
} from "./store";

export type AttachmentRoute =
  | { readonly kind: "upload" }
  | { readonly kind: "discard"; readonly attachmentId: string }
  | { readonly kind: "view"; readonly sessionId: string; readonly attachmentId: string }
  | { readonly kind: "fetch"; readonly sessionId: string; readonly attachmentId: string };

const COLLECTION = "/api/attachments";
const ONE = /^\/api\/attachments\/([^/]+)$/;
const SESSION_ONE = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)(\/content)?$/;

export function matchAttachmentRoute(pathname: string, method: string): AttachmentRoute | null {
  if (pathname === COLLECTION) {
    return method === "POST" ? { kind: "upload" } : null;
  }
  const one = ONE.exec(pathname);
  if (one !== null) {
    return method === "DELETE" ? { kind: "discard", attachmentId: one[1] as string } : null;
  }
  const scoped = SESSION_ONE.exec(pathname);
  if (scoped !== null && method === "GET") {
    return {
      kind: scoped[3] === undefined ? "view" : "fetch",
      sessionId: scoped[1] as string,
      attachmentId: scoped[2] as string,
    };
  }
  return null;
}

/** Percent-encoded so any file name survives a header. */
export const FILE_NAME_HEADER = "x-oncue-file-name";

const REFUSAL_STATUS: Readonly<Record<AttachmentRefusal, number>> = {
  empty: 400,
  too_large: 413,
  unsupported_type: 415,
};

function refusal(reason: AttachmentRefusal): Response {
  return Response.json(
    { error: reason, message: ATTACHMENT_REFUSAL_TEXT[reason] },
    { status: REFUSAL_STATUS[reason] },
  );
}

function storageUnavailable(): Response {
  return Response.json({ error: "attachment_storage_unavailable" }, { status: 503 });
}

function unavailable(): Response {
  return Response.json({ error: "attachment_unavailable" }, { status: 404 });
}

/** Stops at `limit` bytes, so a lying or absent `content-length` cannot make the Worker hold more. */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | "too_large"> {
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone; the answer is the same.
      }
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeName(raw: string | null): string | null {
  if (raw === null) {
    return "attachment";
  }
  try {
    return cleanAttachmentName(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

async function deleteQuietly(bucket: R2Bucket, objectKey: string): Promise<void> {
  try {
    await bucket.delete(objectKey);
  } catch {
    // Not the caller's failure: without its row the object is unreachable.
  }
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleUploadAttachment(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: outcome.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    return storageUnavailable();
  }
  // An image is the largest attachment allowed.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > ATTACHMENT_LIMITS.imageBytes) {
    return refusal("too_large");
  }
  const name = decodeName(request.headers.get(FILE_NAME_HEADER));
  if (name === null) {
    return Response.json({ error: "invalid_name" }, { status: 400 });
  }
  const workspaceId = actorWorkspaceId(outcome.actor);
  await sweepUnclaimedAttachments(env.DB, bucket, new Date(), workspaceId);
  if ((await countUnclaimed(env.DB, workspaceId)) >= ATTACHMENT_LIMITS.unclaimedPerWorkspace) {
    return Response.json({ error: "too_many_pending" }, { status: 429 });
  }
  const bytes = await readBounded(request.body, ATTACHMENT_LIMITS.imageBytes);
  if (bytes === "too_large") {
    return refusal("too_large");
  }
  const sniffed = sniffAttachment(bytes, name);
  if (!sniffed.ok) {
    return refusal(sniffed.reason);
  }
  const attachmentId = crypto.randomUUID();
  const objectKey = attachmentObjectKey(workspaceId, attachmentId);
  const sha256 = await sha256HexOf(bytes);
  const stored = await bucket
    .put(objectKey, bytes, { sha256, httpMetadata: { contentType: sniffed.contentType } })
    .then(
      () => true,
      () => false,
    );
  if (!stored) {
    return Response.json({ error: "upload_failed" }, { status: 502 });
  }
  const row = {
    attachmentId,
    workspaceId,
    uploadedByUserId: actorUserId(outcome.actor),
    sessionId: null,
    name,
    contentType: sniffed.contentType,
    kind: sniffed.kind,
    byteSize: bytes.byteLength,
    sha256,
    objectKey,
    createdAt: new Date().toISOString(),
  };
  const indexed = await insertUpload(env.DB, row).then(
    () => true,
    () => false,
  );
  if (!indexed) {
    // Bytes no row describes would never be claimed or swept.
    await deleteQuietly(bucket, objectKey);
    return Response.json({ error: "upload_failed" }, { status: 502 });
  }
  return Response.json({ attachment: refOf(row) }, { status: 201 });
}

export async function handleDiscardAttachment(
  request: Request,
  env: Env,
  attachmentId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: outcome.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  const objectKey = await discardUnclaimed(env.DB, actorWorkspaceId(outcome.actor), attachmentId);
  if (objectKey === null) {
    return unavailable();
  }
  if (env.ARTIFACTS !== undefined) {
    await deleteQuietly(env.ARTIFACTS, objectKey);
  }
  return new Response(null, { status: 204 });
}

/** Printable ASCII for old clients plus the real name (RFC 6266, RFC 8187). */
export function contentDisposition(disposition: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cross-origin-resource-policy": "same-origin",
} as const;

export async function handleViewAttachment(
  request: Request,
  env: Env,
  route: { readonly sessionId: string; readonly attachmentId: string },
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, route.sessionId, allowlistCache);
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
  const found = await readSessionAttachment(env.DB, route.sessionId, route.attachmentId);
  if (found === null) {
    return unavailable();
  }
  const object = await bucket.get(found.objectKey);
  if (object === null) {
    return unavailable();
  }
  // Anything but a recognised raster image is a download the browser will not render.
  const image = found.kind === "image";
  return new Response(object.body, {
    headers: {
      ...SAFE_HEADERS,
      "content-type": image ? found.contentType : "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": contentDisposition(image ? "inline" : "attachment", found.name),
      // Immutable bytes behind an owner check, so thumbnails need not refetch.
      "cache-control": "private, max-age=3600",
    },
  });
}

/** The DO's answer to a fetch token. */
export type AttachmentFetchAuthorization =
  | { readonly kind: "authorized" }
  | { readonly kind: "refused" };

export async function handleFetchAttachment(
  request: Request,
  env: Env,
  route: { readonly sessionId: string; readonly attachmentId: string },
): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // The token is checked in the session's object, which an id nobody created
  // would otherwise wake into existence.
  if (!(await isKnownSession(env.DB, route.sessionId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const stub = env.SESSION.get(env.SESSION.idFromName(route.sessionId));
  const answer = await stub.fetch("https://session/internal/attachments/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachmentId: route.attachmentId, token }),
  });
  const authorized = (await answer.json()) as AttachmentFetchAuthorization;
  if (authorized.kind !== "authorized") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    return storageUnavailable();
  }
  const found = await readSessionAttachment(env.DB, route.sessionId, route.attachmentId);
  const object = found === null ? null : await bucket.get(found.objectKey);
  if (object === null) {
    return unavailable();
  }
  return new Response(object.body, {
    headers: {
      ...SAFE_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
    },
  });
}
