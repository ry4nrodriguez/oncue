/**
 * `DELETE /api/sessions/:id`: record 19's first four steps, then the job.
 * `authorizeSessionRequest` is the fresh authorization check. The index row
 * is marked and the request recorded first, in one batch: from then on the
 * session is out of the list, every other route refuses it, and the job owes
 * it, so a failure anywhere after cannot strand it. The session object is
 * then told, so it refuses new work and stops its sandbox before the answer;
 * if it cannot be reached, the job's first step tells it instead. The job
 * (`worker/deletion/job.ts`) starts straight away and the scheduled handler
 * retries it until every store is done.
 *
 * Answers 202 with `deletion_pending`, the same for a repeated request, which
 * neither records a second request nor stops anything twice.
 */

import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import type { DeletionOutcome } from "../deletion/job";
import { prepareModalCredential } from "./sessions";

const SESSION_DELETE_PATH = /^\/api\/sessions\/([^/]+)$/;

export function extractDeleteSessionId(pathname: string): string | null {
  const match = SESSION_DELETE_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  return sessionId === undefined ? null : sessionId;
}

/** The two things the route reaches beyond D1, injectable for tests. */
export interface DeleteSessionDeps {
  /** The object's `/internal/delete`; its body is the object's to judge. */
  callDelete(sessionId: string, body: Record<string, unknown>): Promise<Response>;
  /** Starts one job attempt for the request without holding the response. */
  startDeletion(requestId: string): void;
}

export function realDeleteDeps(
  env: Env,
  runDeletion: (requestId: string) => Promise<DeletionOutcome>,
  defer: (work: Promise<unknown>) => void,
): DeleteSessionDeps {
  return {
    callDelete(sessionId, body) {
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch("https://session/internal/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    startDeletion(requestId) {
      defer(runDeletion(requestId));
    },
  };
}

export async function handleDeleteSession(
  request: Request,
  env: Env,
  sessionId: string,
  deps: DeleteSessionDeps,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, sessionId, allowlistCache, {
    allowDeletionPending: true,
  });
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }
  const workspaceId = actorWorkspaceId(outcome.actor);
  const userId = actorUserId(outcome.actor);

  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE session_index SET state = 'deletion_pending', updated_at = ? WHERE session_id = ? AND workspace_id = ?",
    ).bind(now, sessionId, workspaceId),
    // One open request per session: a repeated delete adds nothing.
    env.DB.prepare(
      `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM deletion_request WHERE session_id = ? AND completed_at IS NULL)`,
    ).bind(requestId, sessionId, workspaceId, userId, now, sessionId),
  ]);

  // A deletion never waits on Modal: without a usable pair the object opens
  // its own, and a stop that cannot finish yet keeps the job owed. A refusal
  // or an unreachable object is left to the job, which tells it again.
  const modal = await prepareModalCredential(env, workspaceId);
  await deps
    .callDelete(sessionId, {
      requestedByUserId: userId,
      ...(modal.kind === "ready" ? { modalCredential: modal.credential } : {}),
    })
    .catch(() => undefined);

  const open = await env.DB.prepare(
    "SELECT id FROM deletion_request WHERE session_id = ? AND completed_at IS NULL ORDER BY requested_at LIMIT 1",
  )
    .bind(sessionId)
    .first<{ id: string }>();
  if (open !== null) {
    deps.startDeletion(open.id);
  }

  return Response.json({ sessionId, state: "deletion_pending" }, { status: 202 });
}
