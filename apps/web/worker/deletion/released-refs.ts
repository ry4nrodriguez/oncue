// The task branch a deleted session leaves on GitHub, remembered on the
// deletion receipt as a hash for a few days (record 19, "The job").
//
// The `push` webhook decides whether the App pushed outside every session's
// branch from `session_index`, and the receipt removes that row while the
// branch stays. A delivery that arrives after the receipt would then read as a
// foreign push and lock down every session of the repository, so the webhook
// asks here first.

/**
 * How long a released branch is remembered. Long enough for a delayed or
 * redelivered push delivery; short, because for that long the App's own push
 * to this ref is not treated as an incident.
 */
export const RELEASED_REF_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** SHA-256 over the repository's GitHub id and the full ref, so the receipt holds no branch name. */
export async function releasedRefHash(githubRepositoryId: number, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${githubRepositoryId}\n${ref}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The hash for the branch a session being deleted holds, read from its index
 * row before the receipt removes it; null when it has no task branch or no
 * repository.
 */
export async function readReleasedRefHash(
  db: D1Database,
  sessionId: string,
  workspaceId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT si.task_branch AS task_branch, rc.github_repository_id AS github_repository_id
         FROM session_index AS si
         JOIN repository_connection AS rc
           ON rc.repository_connection_id = si.repository_connection_id
        WHERE si.session_id = ? AND si.workspace_id = ? AND si.task_branch IS NOT NULL`,
    )
    .bind(sessionId, workspaceId)
    .first<{ task_branch: string; github_repository_id: number }>();
  return row === null
    ? null
    : releasedRefHash(row.github_repository_id, `refs/heads/${row.task_branch}`);
}

/** Whether a session deleted within the window pushed to this ref. One lookup on the partial index. */
export async function wasReleasedRef(
  db: D1Database,
  githubRepositoryId: number,
  ref: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM deletion_request
        WHERE released_ref_hash = ? AND completed_at > ? LIMIT 1`,
    )
    .bind(
      await releasedRefHash(githubRepositoryId, ref),
      new Date(now.getTime() - RELEASED_REF_WINDOW_MS).toISOString(),
    )
    .first<{ found: number }>();
  return row !== null;
}

/** Blanks the hashes past the window, so a receipt ends up holding identifiers and times only. */
export async function forgetReleasedRefs(db: D1Database, now: Date): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE deletion_request SET released_ref_hash = NULL
        WHERE released_ref_hash IS NOT NULL AND completed_at <= ?`,
    )
    .bind(new Date(now.getTime() - RELEASED_REF_WINDOW_MS).toISOString())
    .run();
  return result.meta.changes;
}
