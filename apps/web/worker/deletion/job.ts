// The session deletion job (record 19, steps 4 to 8). Each `deletion_request`
// row is worked through the same steps on every attempt, and every step is
// safe to repeat, so a crash anywhere is mended by running again:
//
//   guard      only a session whose index row says `deletion_pending` (or is
//              gone) is touched; any other request closes as `skipped`
//   stop       the session object refuses new work and its sandbox stops
//   r2         every object under the session's own prefix, plus the keys
//              its rows name (attachments by exact key), is removed
//   d1         the rows keyed by the session go, except the index row
//   object     the object erases its own storage
//   receipt    one batch marks the request complete and removes the index row
//
// R2 goes before the rows that name its keys, so a rerun can always find what
// is left. The request stays open, with the step it stopped at, until the
// receipt is written, and only that batch writes it.

import { log } from "../log";
import type { DeleteSessionResult, EraseSessionResult } from "../session/session-object";
import { planObjectRemoval } from "./ownership";
import { forgetReleasedRefs, readReleasedRefHash } from "./released-refs";

export type DeletionStep = "stop" | "r2" | "d1" | "object" | "receipt";

export type DeletionOutcome =
  | { readonly kind: "completed" }
  /** Closed without touching the session: its index row is not being deleted. */
  | { readonly kind: "skipped" }
  /** No such request, or one already complete: nothing to do. */
  | { readonly kind: "nothing_owed" }
  | { readonly kind: "pending"; readonly step: DeletionStep };

/** The session object as the job reaches it; each call answers or throws. */
export interface DeletionObjects {
  /** Whether a delete already reached the object; changes nothing. */
  marked(sessionId: string): Promise<boolean>;
  close(sessionId: string, requestedByUserId: string): Promise<DeleteSessionResult>;
  erase(sessionId: string): Promise<EraseSessionResult>;
}

export interface DeletionEnv {
  readonly DB: D1Database;
  /** Optional at run time: a deployment without R2 has no objects to remove. */
  readonly ARTIFACTS?: R2Bucket | undefined;
  readonly ONCUE_RELEASE: string;
  readonly ONCUE_ENV: string;
}

/** R2 deletes at most 1,000 keys per call, and lists at most 1,000 per page. */
export const R2_DELETE_BATCH = 1000;

/** Prefix pages one attempt lists; a session holding more finishes on the next attempt. */
export const R2_LIST_PAGES = 10;

/** The object's answers that mean no sandbox is left running. */
const SANDBOX_ENDED: ReadonlySet<string> = new Set(["stopped", "not_running"]);

/** How many owed requests one scheduled run works, so each run's cost is bounded. */
export const DELETION_BATCH = 5;

/**
 * Artifact rows one attempt reads. Every artifact's key is under the session's
 * prefix, which the listing removes whatever the rows say, so rows past this
 * bound cost a session nothing.
 */
export const ARTIFACT_ROWS_PER_ATTEMPT = 1000;

/**
 * How long the scheduled run leaves an owed request alone after an attempt,
 * by how long ago the deletion was asked for. A young request is tried on
 * every run, which covers a sandbox that is still stopping; one still owed
 * after that is one whose stop cannot finish yet, and it is retried hourly,
 * then every six hours, so a stuck deletion wakes its object and the provider
 * a bounded number of times a day. Judged by age, not by attempts, so retries
 * that come quickly (a repeated request, a test's own runs) use up nothing.
 */
export const RETRY_WAITS = [
  { olderThanMs: 24 * 60 * 60 * 1000, waitMs: 6 * 60 * 60 * 1000 },
  { olderThanMs: 30 * 60 * 1000, waitMs: 60 * 60 * 1000 },
] as const;

async function callObject<T>(
  env: Env,
  sessionId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const response = await stub.fetch(`https://session/internal/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`the session object answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export function realDeletionObjects(env: Env): DeletionObjects {
  return {
    // No Modal pair crosses here: the object opens its own when the stop needs it.
    close: (sessionId, requestedByUserId) =>
      callObject(env, sessionId, "delete", { requestedByUserId }),
    erase: (sessionId) => callObject(env, sessionId, "deletion/erase", {}),
    marked: async (sessionId) =>
      (await callObject<{ marked: boolean }>(env, sessionId, "deletion/marked", {})).marked,
  };
}

interface RequestRow {
  readonly id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly requested_by_user_id: string;
  readonly completed_at: string | null;
}

function report(
  env: DeletionEnv,
  sessionId: string,
  result: string,
  severity: "info" | "warn",
  errorCategory?: string,
): void {
  log({
    timestamp: new Date().toISOString(),
    severity,
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "session.deletion",
    result,
    sessionId,
    ...(errorCategory === undefined ? {} : { errorCategory }),
  });
}

/**
 * Keys under the session's own prefix, a bounded number of pages per attempt.
 * `complete` is false when more remain for the next attempt.
 */
async function listSessionPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ readonly keys: readonly string[]; readonly complete: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < R2_LIST_PAGES; page += 1) {
    const listed = await bucket.list({
      prefix,
      limit: R2_DELETE_BATCH,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...listed.objects.map((object) => object.key));
    if (!listed.truncated) {
      return { keys, complete: true };
    }
    cursor = listed.cursor;
  }
  return { keys, complete: false };
}

/**
 * Steps 5 and 6 for R2: every object under the session's prefix, built from
 * the request's own ids, which catches one whose upload landed before any row
 * named it; and every key a row names, removed only where ownership matches
 * (attachments live under the workspace, so they are found by row, never by
 * prefix).
 */
async function removeObjects(env: DeletionEnv, row: RequestRow): Promise<number> {
  const [indexed, attachments] = (await env.DB.batch([
    env.DB.prepare(
      "SELECT object_key FROM artifact_index WHERE session_id = ? AND workspace_id = ? LIMIT ?",
    ).bind(row.session_id, row.workspace_id, ARTIFACT_ROWS_PER_ATTEMPT),
    env.DB.prepare(
      "SELECT attachment_id, object_key FROM message_attachment WHERE session_id = ? AND workspace_id = ?",
    ).bind(row.session_id, row.workspace_id),
  ])) as [
    D1Result<{ readonly object_key: string }>,
    D1Result<{ readonly attachment_id: string; readonly object_key: string }>,
  ];
  const plan = planObjectRemoval(
    row.workspace_id,
    row.session_id,
    indexed.results.map((result) => result.object_key),
    attachments.results.map((result) => ({
      attachmentId: result.attachment_id,
      objectKey: result.object_key,
    })),
  );
  const bucket = env.ARTIFACTS;
  if (bucket === undefined) {
    if (plan.owned.length > 0) {
      throw new Error("objects to remove and no bucket bound");
    }
    return plan.skipped;
  }
  const listed = await listSessionPrefix(
    bucket,
    `workspaces/${row.workspace_id}/sessions/${row.session_id}/`,
  );
  const keys = [...new Set([...plan.owned, ...listed.keys])];
  for (let start = 0; start < keys.length; start += R2_DELETE_BATCH) {
    await bucket.delete(keys.slice(start, start + R2_DELETE_BATCH));
  }
  if (!listed.complete) {
    throw new Error("more objects under the prefix than one attempt lists");
  }
  return plan.skipped;
}

/**
 * Step 5 and 6 for D1. Rows are matched on the session and the workspace the
 * request was authorized for, so a row another workspace wrote stays. The
 * index row goes last, with the receipt.
 */
async function removeRows(env: DeletionEnv, row: RequestRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifact_index WHERE session_id = ? AND workspace_id = ?").bind(
      row.session_id,
      row.workspace_id,
    ),
    env.DB.prepare("DELETE FROM message_attachment WHERE session_id = ? AND workspace_id = ?").bind(
      row.session_id,
      row.workspace_id,
    ),
    env.DB.prepare("DELETE FROM audit_entry WHERE session_id = ? AND workspace_id = ?").bind(
      row.session_id,
      row.workspace_id,
    ),
    env.DB.prepare(
      `DELETE FROM projection_cursor WHERE session_id IN (
         SELECT session_id FROM session_index WHERE session_id = ? AND workspace_id = ?)`,
    ).bind(row.session_id, row.workspace_id),
  ]);
}

/**
 * Step 8, once: every open request for the session completes in the batch
 * that removes its index row, so a rerun finds nothing owed and never writes
 * a second receipt. The receipt keeps a hash of the session's task branch for
 * a few days, read from the row before it goes: the branch stays on GitHub,
 * and a push delivered late must still be known as a session's.
 */
async function writeReceipt(env: DeletionEnv, row: RequestRow, now: string): Promise<void> {
  const releasedRef = await readReleasedRefHash(env.DB, row.session_id, row.workspace_id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE deletion_request
         SET completed_at = ?, failed_step = NULL, outcome = 'deleted', released_ref_hash = ?
       WHERE session_id = ? AND workspace_id = ? AND completed_at IS NULL`,
    ).bind(now, releasedRef, row.session_id, row.workspace_id),
    env.DB.prepare("DELETE FROM session_index WHERE session_id = ? AND workspace_id = ?").bind(
      row.session_id,
      row.workspace_id,
    ),
  ]);
}

/**
 * Whether the request's session may be touched: its index row says
 * `deletion_pending` for the request's workspace, or, with the row already
 * gone, its object says a delete reached it. A row in any other state means
 * the request predates the object being told (an older Worker's projection
 * made the session active again), and someone may still be using it.
 */
async function sessionIsDeleting(
  env: DeletionEnv,
  objects: DeletionObjects,
  row: RequestRow,
): Promise<boolean> {
  const index = await env.DB.prepare(
    "SELECT state, workspace_id FROM session_index WHERE session_id = ?",
  )
    .bind(row.session_id)
    .first<{ state: string; workspace_id: string }>();
  if (index === null) {
    return objects.marked(row.session_id);
  }
  return index.state === "deletion_pending" && index.workspace_id === row.workspace_id;
}

/** Closes the request without touching the session, saying why. */
async function skip(env: DeletionEnv, row: RequestRow, now: string): Promise<void> {
  report(env, row.session_id, "skipped", "warn", "session_not_deleting");
  await env.DB.prepare(
    `UPDATE deletion_request
       SET completed_at = ?, failed_step = NULL, outcome = 'skipped', skip_reason = 'session_not_deleting'
     WHERE id = ? AND completed_at IS NULL`,
  )
    .bind(now, row.id)
    .run();
}

/** Records where an attempt stopped; the request stays open for the next one. */
async function holdAt(
  env: DeletionEnv,
  row: RequestRow,
  step: DeletionStep,
): Promise<DeletionOutcome> {
  report(env, row.session_id, "pending", "warn", step);
  await env.DB.prepare(
    "UPDATE deletion_request SET failed_step = ? WHERE id = ? AND completed_at IS NULL",
  )
    .bind(step, row.id)
    .run()
    .catch(() => undefined);
  return { kind: "pending", step };
}

/** One attempt at one request. Never throws once the request is read. */
export async function runDeletion(
  env: DeletionEnv,
  objects: DeletionObjects,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<DeletionOutcome> {
  const row = await env.DB.prepare(
    `SELECT id, session_id, workspace_id, requested_by_user_id, completed_at
     FROM deletion_request WHERE id = ?`,
  )
    .bind(requestId)
    .first<RequestRow>();
  if (row === null || row.completed_at !== null) {
    return { kind: "nothing_owed" };
  }
  let step: DeletionStep = "stop";
  try {
    await env.DB.prepare(
      "UPDATE deletion_request SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?",
    )
      .bind(now().toISOString(), row.id)
      .run();
    if (!(await sessionIsDeleting(env, objects, row))) {
      await skip(env, row, now().toISOString());
      return { kind: "skipped" };
    }
    const closed = await objects.close(row.session_id, row.requested_by_user_id);
    if (closed.kind === "deleting" && !SANDBOX_ENDED.has(closed.sandbox)) {
      return await holdAt(env, row, step);
    }
    step = "r2";
    const skipped = await removeObjects(env, row);
    if (skipped > 0) {
      report(env, row.session_id, "skipped_foreign_objects", "warn", "foreign_object");
    }
    step = "d1";
    await removeRows(env, row);
    step = "object";
    const erased = await objects.erase(row.session_id);
    if (erased.kind !== "erased") {
      return await holdAt(env, row, step);
    }
    step = "receipt";
    await writeReceipt(env, row, now().toISOString());
  } catch {
    return holdAt(env, row, step);
  }
  report(env, row.session_id, "completed", "info");
  return { kind: "completed" };
}

/**
 * The scheduled handler's share: the owed requests least recently tried, a
 * bounded batch per run, leaving out the ones still waiting out a retry
 * (`RETRY_WAITS`). One request failing never stops the others. Released
 * branch hashes past their window are blanked on the way out.
 */
export async function runPendingDeletions(
  env: DeletionEnv,
  objects: DeletionObjects,
  now: () => Date = () => new Date(),
): Promise<readonly DeletionOutcome[]> {
  const nowMs = now().getTime();
  const [oldest, older] = RETRY_WAITS;
  const before = (ms: number) => new Date(nowMs - ms).toISOString();
  const owed = await env.DB.prepare(
    `SELECT id FROM deletion_request
      WHERE completed_at IS NULL
        AND (last_attempt_at IS NULL OR last_attempt_at <= CASE
              WHEN requested_at <= ? THEN ?
              WHEN requested_at <= ? THEN ?
              ELSE ? END)
      ORDER BY last_attempt_at LIMIT ?`,
  )
    .bind(
      before(oldest.olderThanMs),
      before(oldest.waitMs),
      before(older.olderThanMs),
      before(older.waitMs),
      before(0),
      DELETION_BATCH,
    )
    .all<{ id: string }>();
  const outcomes: DeletionOutcome[] = [];
  for (const { id } of owed.results) {
    outcomes.push(await runDeletion(env, objects, id, now));
  }
  await forgetReleasedRefs(env.DB, now());
  return outcomes;
}
