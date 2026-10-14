// The `message_attachment` table: an upload belongs to its workspace until a
// message claims it for one session. The browser names only ids; every other
// field is rebuilt from the Worker's own row, so nothing the browser says about
// a file reaches the timeline or the sandbox.

import { type ArtifactRef, ATTACHMENT_LIMITS, type AttachmentKind } from "@oncue/protocol";

export interface AttachmentRow {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly uploadedByUserId: string;
  readonly sessionId: string | null;
  readonly name: string;
  readonly contentType: string;
  readonly kind: AttachmentKind;
  readonly byteSize: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly createdAt: string;
}

interface StoredRow {
  readonly attachment_id: string;
  readonly workspace_id: string;
  readonly session_id: string | null;
  readonly name: string;
  readonly content_type: string;
  readonly kind: AttachmentKind;
  readonly byte_size: number;
  readonly object_key: string;
}

/** Keyed by workspace because on Home the session does not exist yet; the id is the Worker's own UUID. */
export function attachmentObjectKey(workspaceId: string, attachmentId: string): string {
  return `workspaces/${workspaceId}/attachments/${attachmentId}`;
}

/** Every attachment is kind `file`; its content type says whether it is an image. */
export function refOf(row: {
  readonly attachmentId: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly name: string;
}): ArtifactRef {
  return {
    artifactId: row.attachmentId as ArtifactRef["artifactId"],
    kind: "file",
    contentType: row.contentType,
    byteSize: row.byteSize,
    label: row.name,
  };
}

export async function countUnclaimed(db: D1Database, workspaceId: string): Promise<number> {
  const { results } = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM message_attachment WHERE workspace_id = ? AND session_id IS NULL",
    )
    .bind(workspaceId)
    .all<{ count: number }>();
  return results.reduce((total, row) => total + row.count, 0);
}

export async function insertUpload(db: D1Database, row: AttachmentRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO message_attachment (
         attachment_id, workspace_id, uploaded_by_user_id, session_id, name, content_type,
         kind, byte_size, sha256, object_key, created_at, claimed_at
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      row.attachmentId,
      row.workspaceId,
      row.uploadedByUserId,
      row.name,
      row.contentType,
      row.kind,
      row.byteSize,
      row.sha256,
      row.objectKey,
      row.createdAt,
    )
    .run();
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly refs: readonly ArtifactRef[] }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * Claims every named upload for one session or refuses the whole message.
 * Re-claiming by the same session succeeds, so a retried message works; an
 * upload in another workspace reads as missing.
 */
export async function claimAttachments(
  db: D1Database,
  claim: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly attachmentIds: readonly string[];
    readonly now: string;
  },
): Promise<ClaimOutcome> {
  const ids = claim.attachmentIds;
  if (ids.length === 0) {
    return { kind: "claimed", refs: [] };
  }
  if (ids.length > ATTACHMENT_LIMITS.perMessage) {
    return {
      kind: "refused",
      detail: `a message can carry at most ${ATTACHMENT_LIMITS.perMessage} attachments`,
    };
  }
  if (new Set(ids).size !== ids.length) {
    return { kind: "refused", detail: "the same attachment is named twice" };
  }
  const placeholders = ids.map(() => "?").join(", ");
  const found = await db
    .prepare(
      `SELECT attachment_id, workspace_id, session_id, name, content_type, kind, byte_size, object_key
       FROM message_attachment WHERE workspace_id = ? AND attachment_id IN (${placeholders})`,
    )
    .bind(claim.workspaceId, ...ids)
    .all<StoredRow>();
  const byId = new Map(found.results.map((row) => [row.attachment_id, row]));
  const rows: StoredRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined || (row.session_id !== null && row.session_id !== claim.sessionId)) {
      return { kind: "refused", detail: "an attachment is not available; upload it again" };
    }
    rows.push(row);
  }
  const updated = await db
    .prepare(
      `UPDATE message_attachment SET session_id = ?, claimed_at = COALESCE(claimed_at, ?)
       WHERE workspace_id = ? AND attachment_id IN (${placeholders})
         AND (session_id IS NULL OR session_id = ?)`,
    )
    .bind(claim.sessionId, claim.now, claim.workspaceId, ...ids, claim.sessionId)
    .run();
  if (updated.meta.changes !== ids.length) {
    // Another session claimed one between the read and the write.
    return { kind: "refused", detail: "an attachment is not available; upload it again" };
  }
  return {
    kind: "claimed",
    refs: rows.map((row) =>
      refOf({
        attachmentId: row.attachment_id,
        contentType: row.content_type,
        byteSize: row.byte_size,
        name: row.name,
      }),
    ),
  };
}

/**
 * Hands back the uploads a create claimed for a session it then could not
 * write, so the person can send them again. Only a session with no row can
 * have lost them this way.
 */
export async function releaseAttachments(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE message_attachment SET session_id = NULL, claimed_at = NULL WHERE session_id = ?",
    )
    .bind(sessionId)
    .run();
}

export interface SessionAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly kind: AttachmentKind;
  readonly objectKey: string;
}

/** An unclaimed upload belongs to no session yet, so it reads as null. */
export async function readSessionAttachment(
  db: D1Database,
  sessionId: string,
  attachmentId: string,
): Promise<SessionAttachment | null> {
  const row = await db
    .prepare(
      `SELECT name, content_type, kind, object_key FROM message_attachment
       WHERE attachment_id = ? AND session_id = ?`,
    )
    .bind(attachmentId, sessionId)
    .first<{ name: string; content_type: string; kind: AttachmentKind; object_key: string }>();
  return row === null
    ? null
    : { name: row.name, contentType: row.content_type, kind: row.kind, objectKey: row.object_key };
}

/**
 * Hands uploads back to the workspace when the message that claimed them made
 * no session (a create refused because the session was deleted), so the
 * unclaimed sweep removes them rather than leaving rows no deletion will find.
 */
export async function releaseClaims(
  db: D1Database,
  release: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly attachmentIds: readonly string[];
  },
): Promise<void> {
  const ids = release.attachmentIds;
  if (ids.length === 0) {
    return;
  }
  await db
    .prepare(
      `UPDATE message_attachment SET session_id = NULL, claimed_at = NULL
       WHERE workspace_id = ? AND session_id = ? AND attachment_id IN (${ids.map(() => "?").join(", ")})`,
    )
    .bind(release.workspaceId, release.sessionId, ...ids)
    .run();
}

/** Returns the object key for the caller to delete; a claimed attachment answers null, like a missing one. */
export async function discardUnclaimed(
  db: D1Database,
  workspaceId: string,
  attachmentId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `DELETE FROM message_attachment
       WHERE attachment_id = ? AND workspace_id = ? AND session_id IS NULL
       RETURNING object_key`,
    )
    .bind(attachmentId, workspaceId)
    .first<{ object_key: string }>();
  return row?.object_key ?? null;
}

/** How many unclaimed uploads one scheduled run removes at most. */
export const SWEEP_BATCH = 100;

/**
 * Removes uploads unclaimed for a day, bytes first, so an object is never left
 * with no row. Each upload sweeps its own workspace so abandoned drafts do not
 * count against the cap; the `scheduled` handler sweeps every workspace.
 */
export async function sweepUnclaimedAttachments(
  db: D1Database,
  bucket: R2Bucket | undefined,
  now: Date = new Date(),
  workspaceId: string | null = null,
): Promise<number> {
  if (bucket === undefined) {
    return 0;
  }
  const cutoff = new Date(now.getTime() - ATTACHMENT_LIMITS.unclaimedTtlMs).toISOString();
  const stale = await (workspaceId === null
    ? db
        .prepare(
          `SELECT attachment_id, object_key FROM message_attachment
           WHERE session_id IS NULL AND created_at < ? LIMIT ?`,
        )
        .bind(cutoff, SWEEP_BATCH)
    : db
        .prepare(
          `SELECT attachment_id, object_key FROM message_attachment
           WHERE workspace_id = ? AND session_id IS NULL AND created_at < ? LIMIT ?`,
        )
        .bind(workspaceId, cutoff, SWEEP_BATCH)
  ).all<{ attachment_id: string; object_key: string }>();
  let removed = 0;
  for (const row of stale.results) {
    const deleted = await bucket.delete(row.object_key).then(
      () => true,
      () => false,
    );
    if (!deleted) {
      continue;
    }
    await db
      .prepare("DELETE FROM message_attachment WHERE attachment_id = ? AND session_id IS NULL")
      .bind(row.attachment_id)
      .run();
    removed += 1;
  }
  return removed;
}
