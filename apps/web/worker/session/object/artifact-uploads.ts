// Artifact uploads and restores (record 03) and composer attachment fetches.

import { buildEvent, type CommittedEvent, type ProtocolEventOf } from "@oncue/protocol";
import {
  ARTIFACT_LIMITS,
  type ArtifactProducer,
  artifactObjectKey,
  classificationFor,
  expiresAtFor,
  labelFor,
  planArtifactAuthorization,
} from "../../artifacts/policy";
import { spendAttachmentToken } from "../attachment-access";
import { type GrantRevocation, grantDeliverable } from "../lifecycle";
import { mintBootstrapCredential, sha256Hex } from "./credentials";
import type { SessionHost } from "./host";
import { readAttachment, readEndedGeneration, readStopRow } from "./store-lifecycle";
import { readArtifactRow } from "./store-session";
import type {
  ArtifactAuthorizeBody,
  ArtifactAuthorizeResult,
  ArtifactCompleteBody,
  ArtifactCompleteResult,
  ArtifactFailBody,
  ArtifactReadResult,
  SessionRow,
} from "./types";

/**
 * Revokes every unspent artifact token of the generation, restore tokens too,
 * since they also open an artifact; the recorded outcome is the upload
 * tokens'. An artifact declared but never started is failed here, as nothing
 * is left to upload it; one already uploading is left to its endpoint.
 */
export function revokeArtifactTokens(
  host: SessionHost,
  session: SessionRow,
  generation: number,
): GrantRevocation["outcome"] {
  const uploads = host.objectCtx.storage.sql.exec(
    "UPDATE artifact_access SET used_at = 'revoked' WHERE generation = ? AND purpose = 'upload' AND used_at IS NULL",
    generation,
  );
  uploads.toArray();
  const outcome = uploads.rowsWritten > 0 ? "revoked" : "not_held";
  host.objectCtx.storage.sql.exec(
    "UPDATE artifact_access SET used_at = 'revoked' WHERE generation = ? AND purpose = 'restore' AND used_at IS NULL",
    generation,
  );
  const unstarted = host.objectCtx.storage.sql
    .exec<{ id: string; run_id: string }>(
      `SELECT a.id AS id, a.run_id AS run_id FROM artifact AS a
         WHERE a.state = 'uploading'
           AND a.id IN (
             SELECT json_extract(envelope_json, '$.payload.artifactId') FROM event
             WHERE event_type = 'artifact.uploading' AND sandbox_generation = ?)
           AND NOT EXISTS (
             SELECT 1 FROM artifact_access AS x
             WHERE x.artifact_id = a.id AND x.purpose = 'upload'
               AND x.used_at IS NOT NULL AND x.used_at != 'revoked')`,
      generation,
    )
    .toArray();
  failArtifacts(
    host,
    session,
    unstarted,
    "upload",
    "The sandbox ended before this artifact was uploaded, so the upload was cancelled.",
  );
  return outcome;
}

/** The bridge's fetch of one attachment: spends its one-time token for the current generation. */
export async function authorizeAttachmentFetch(
  host: SessionHost,
  attachmentId: string,
  token: string,
): Promise<{ readonly kind: "authorized" | "refused" }> {
  const session = host.readSession();
  if (session === null) {
    return { kind: "refused" };
  }
  const spent = spendAttachmentToken({
    sql: host.objectCtx.storage.sql,
    attachmentId,
    tokenSha256: await sha256Hex(token),
    generation: session.sandboxGeneration,
    nowMs: Date.now(),
    now: new Date().toISOString(),
  });
  return { kind: spent ? "authorized" : "refused" };
}

/** A one-time bearer for one artifact, kept only as its hash, like the bootstrap credential. */
export async function mintArtifactToken(
  host: SessionHost,
  artifactId: string,
  purpose: "upload" | "restore",
  generation: number,
  nowMs: number,
): Promise<string> {
  const token = mintBootstrapCredential();
  host.objectCtx.storage.sql.exec(
    "INSERT INTO artifact_access (token_sha256, artifact_id, purpose, generation, expires_at_ms, used_at) VALUES (?,?,?,?,?,NULL)",
    await sha256Hex(token),
    artifactId,
    purpose,
    generation,
    nowMs + ARTIFACT_LIMITS.tokenTtlMs,
  );
  return token;
}

/**
 * Record 03: the bridge declared an artifact and the object checks it against
 * policy before handing out a token. A refusal commits `artifact.failed` at
 * the authorize stage, so no artifact is ever silently absent.
 */
export async function authorizeUpload(
  host: SessionHost,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"artifact.uploading">,
): Promise<void> {
  const payload = event.payload;
  const runId = event.runId as string;
  if (readArtifactRow(host.objectCtx.storage.sql, payload.artifactId) !== null) {
    return;
  }
  // An artifact whose every upload token expired unspent will never upload, so
  // it is failed before the run's budget is counted. One with no token yet or a
  // live one is left alone.
  failArtifacts(
    host,
    session,
    host.objectCtx.storage.sql
      .exec<{ id: string; run_id: string }>(
        `SELECT a.id AS id, a.run_id AS run_id FROM artifact AS a
           WHERE a.state = 'uploading' AND a.run_id = ?
             AND EXISTS (
               SELECT 1 FROM artifact_access AS x
               WHERE x.artifact_id = a.id AND x.purpose = 'upload')
             AND NOT EXISTS (
               SELECT 1 FROM artifact_access AS x
               WHERE x.artifact_id = a.id AND x.purpose = 'upload'
                 AND ((x.used_at IS NULL AND x.expires_at_ms > ?)
                      OR (x.used_at IS NOT NULL AND x.used_at != 'revoked')))`,
        runId,
        Date.now(),
      )
      .toArray(),
    "upload",
    "The upload token expired before the upload started, so the artifact was not stored.",
  );
  const runBytes = host.objectCtx.storage.sql
    .exec<{ bytes: number }>(
      "SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM artifact WHERE run_id = ? AND state != 'failed'",
      runId,
    )
    .one().bytes;
  // Once the stop has begun revoking, there is no grant to give and nothing
  // later would fail this artifact, so it fails now rather than stay `uploading`.
  const decision = grantDeliverable(
    readAttachment(host.objectCtx.storage.sql, session.sandboxGeneration),
    readStopRow(host.objectCtx.storage.sql, session.sandboxGeneration),
  )
    ? planArtifactAuthorization(payload.declaredBytes, runBytes)
    : ({
        kind: "refused",
        reason: "The sandbox was stopping, so the artifact's upload was not authorized.",
      } as const);
  const now = new Date().toISOString();
  const insert = (state: "uploading" | "failed"): void => {
    host.objectCtx.storage.sql.exec(
      `INSERT INTO artifact (id, session_id, run_id, kind, content_type, byte_size, checksum, state, classification, object_key, created_at)
         VALUES (?,?,?,?,?,?,NULL,?,?,?,?)`,
      payload.artifactId,
      session.id,
      runId,
      payload.kind,
      payload.contentType,
      payload.declaredBytes,
      state,
      classificationFor(payload.producer),
      artifactObjectKey(session.workspaceId, session.id, runId, payload.artifactId),
      now,
    );
  };
  if (decision.kind === "refused") {
    host.commitControlEvents(
      session,
      [
        buildEvent("artifact.failed", {
          eventId: crypto.randomUUID(),
          sessionId: session.id,
          runId,
          sandboxGeneration: session.sandboxGeneration,
          runtimeSequence: null,
          occurredAt: now,
          payload: {
            artifactId: payload.artifactId,
            stage: "authorize",
            reason: decision.reason,
            retryable: false,
          },
        }),
      ],
      now,
      () => insert("failed"),
    );
    return;
  }
  host.objectCtx.storage.transactionSync(() => insert("uploading"));
  await host.dispatch({
    kind: "upload_requested",
    artifactId: payload.artifactId,
    grantId: crypto.randomUUID(),
    maxBytes: payload.declaredBytes,
    now,
  });
}

/**
 * Checks and spends a one-time artifact token. An upload token works only
 * while the artifact is uploading and no other upload token for it was spent,
 * so a redelivered grant cannot start a second upload; a restore token works
 * only for a created artifact. Neither works once its generation ended, even
 * one minted after the revocation by a grant still in flight.
 */
export async function authorizeArtifact(
  host: SessionHost,
  body: ArtifactAuthorizeBody,
): Promise<ArtifactAuthorizeResult> {
  const hash = await sha256Hex(body.token);
  const access = host.objectCtx.storage.sql
    .exec<{
      artifact_id: string;
      purpose: string;
      generation: number;
      expires_at_ms: number;
      used_at: string | null;
    }>(
      "SELECT artifact_id, purpose, generation, expires_at_ms, used_at FROM artifact_access WHERE token_sha256 = ?",
      hash,
    )
    .toArray()[0];
  const artifact = readArtifactRow(host.objectCtx.storage.sql, body.artifactId);
  if (
    access === undefined ||
    artifact === null ||
    access.artifact_id !== body.artifactId ||
    access.purpose !== body.purpose ||
    access.used_at !== null ||
    access.generation <= (readEndedGeneration(host.objectCtx.storage.sql) ?? 0) ||
    access.expires_at_ms <= Date.now() ||
    artifact.state !== (body.purpose === "upload" ? "uploading" : "created")
  ) {
    return { kind: "refused" };
  }
  const spent =
    body.purpose === "upload" &&
    host.objectCtx.storage.sql
      .exec<{ spent: number }>(
        "SELECT EXISTS(SELECT 1 FROM artifact_access WHERE artifact_id = ? AND purpose = 'upload' AND used_at IS NOT NULL AND used_at != 'revoked') AS spent",
        body.artifactId,
      )
      .one().spent === 1;
  if (spent) {
    return { kind: "refused" };
  }
  host.objectCtx.storage.sql.exec(
    "UPDATE artifact_access SET used_at = ? WHERE token_sha256 = ?",
    new Date().toISOString(),
    hash,
  );
  return {
    kind: "authorized",
    objectKey: artifact.objectKey,
    contentType: artifact.contentType,
    declaredBytes: artifact.byteSize,
  };
}

/** Record 03: R2 confirmed the object, so the session commits `artifact.created`. */
export function completeArtifact(
  host: SessionHost,
  body: ArtifactCompleteBody,
): ArtifactCompleteResult {
  const artifact = readArtifactRow(host.objectCtx.storage.sql, body.artifactId);
  if (artifact === null || artifact.state !== "uploading" || artifact.byteSize !== body.byteSize) {
    return { kind: "refused" };
  }
  const session = host.readSession() as SessionRow;
  const producer = host.objectCtx.storage.sql
    .exec<{ producer: string }>(
      "SELECT json_extract(envelope_json, '$.payload.producer') AS producer FROM event WHERE event_type = 'artifact.uploading' AND json_extract(envelope_json, '$.payload.artifactId') = ? LIMIT 1",
      body.artifactId,
    )
    .one().producer as ArtifactProducer;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const classification = classificationFor(producer);
  const expiresAt = expiresAtFor(producer, nowMs);
  host.commitControlEvents(
    session,
    [
      buildEvent("artifact.created", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: artifact.runId,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: {
          artifact: {
            artifactId: body.artifactId,
            kind: artifact.kind,
            contentType: artifact.contentType,
            byteSize: body.byteSize,
            label: labelFor(artifact.kind),
          },
          checksum: { algorithm: "sha256", value: body.sha256 },
          producer,
          classification,
          expiresAt,
          supersedes: null,
        },
      }),
    ],
    now,
    () => {
      host.objectCtx.storage.sql.exec(
        "UPDATE artifact SET state = 'created', checksum = ? WHERE id = ?",
        body.sha256,
        body.artifactId,
      );
    },
  );
  return {
    kind: "created",
    index: {
      artifactId: body.artifactId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      runId: artifact.runId,
      kind: artifact.kind,
      producer,
      contentType: artifact.contentType,
      byteSize: body.byteSize,
      sha256: body.sha256,
      classification,
      objectKey: artifact.objectKey,
      expiresAt,
      createdAt: now,
    },
  };
}

/** Record 03: an upload that did not finish is recorded, never announced as created. */
export function failArtifact(
  host: SessionHost,
  body: ArtifactFailBody,
): { readonly kind: "failed" | "refused" } {
  const artifact = readArtifactRow(host.objectCtx.storage.sql, body.artifactId);
  if (artifact === null || artifact.state !== "uploading") {
    return { kind: "refused" };
  }
  failArtifacts(
    host,
    host.readSession() as SessionRow,
    [{ id: body.artifactId, run_id: artifact.runId }],
    body.stage,
    body.reason,
  );
  return { kind: "failed" };
}

/** `artifact.failed` for each upload, each row failed in the same transaction. Nothing for none. */
function failArtifacts(
  host: SessionHost,
  session: SessionRow,
  uploads: readonly { readonly id: string; readonly run_id: string }[],
  stage: "upload" | "validate",
  reason: string,
): void {
  if (uploads.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  host.commitControlEvents(
    session,
    uploads.map((upload) =>
      buildEvent("artifact.failed", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: upload.run_id,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: { artifactId: upload.id, stage, reason, retryable: false },
      }),
    ),
    now,
    () => {
      for (const upload of uploads) {
        host.objectCtx.storage.sql.exec(
          "UPDATE artifact SET state = 'failed' WHERE id = ?",
          upload.id,
        );
      }
    },
  );
}

export function readArtifact(host: SessionHost, artifactId: string): ArtifactReadResult {
  const artifact = readArtifactRow(host.objectCtx.storage.sql, artifactId);
  if (artifact === null || artifact.state !== "created") {
    return { kind: "not_found" };
  }
  return {
    kind: "found",
    objectKey: artifact.objectKey,
    contentType: artifact.contentType,
    artifactKind: artifact.kind,
    byteSize: artifact.byteSize,
  };
}
