/**
 * `POST /api/sessions/:id/archive` and `POST /api/sessions/:id/unarchive`
 * (record 10). Archiving keeps everything: the session becomes read-only, an
 * open run is cancelled only when the body confirms it, and the sandbox stops
 * the way an idle one does, checkpointing first. Restoring opens the session
 * again; its next message resumes it on a new sandbox.
 *
 * The object is asked first and the index row written after it agrees, so the
 * list never shows a state the object refuses. Answers: 200 with the new
 * state; 409 `run_open` when a run is open and `cancelOpenRun` was not set;
 * 403 for a session that is missing, someone else's, or being deleted.
 */

import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import type { ArchiveSessionResult, UnarchiveSessionResult } from "../session/session-object";
import { prepareModalCredential } from "./sessions";

const SESSION_ARCHIVE_PATH = /^\/api\/sessions\/([^/]+)\/(archive|unarchive)$/;

export interface ArchiveRoute {
  readonly sessionId: string;
  readonly archived: boolean;
}

export function matchArchiveRoute(pathname: string, method: string): ArchiveRoute | null {
  const match = SESSION_ARCHIVE_PATH.exec(pathname);
  if (match === null || method !== "POST") {
    return null;
  }
  return { sessionId: match[1] as string, archived: match[2] === "archive" };
}

export interface ArchiveCaller {
  call(
    sessionId: string,
    path: "archive" | "unarchive",
    body: Record<string, unknown>,
  ): Promise<Response>;
}

export function realArchiveCaller(env: Env): ArchiveCaller {
  return {
    call(sessionId, path, body) {
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch(`https://session/internal/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

async function readCancelOpenRun(request: Request): Promise<boolean> {
  const body = (await request.json().catch(() => null)) as { cancelOpenRun?: unknown } | null;
  return body !== null && typeof body === "object" && body.cancelOpenRun === true;
}

export async function handleArchiveSession(
  request: Request,
  env: Env,
  route: ArchiveRoute,
  caller: ArchiveCaller,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, route.sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }
  const workspaceId = actorWorkspaceId(outcome.actor);

  let body: Record<string, unknown> = {};
  if (route.archived) {
    // As for a deletion: archiving never waits on Modal, and the object opens
    // its own pair when the route could not.
    const modal = await prepareModalCredential(env, workspaceId);
    body = {
      requestedByUserId: actorUserId(outcome.actor),
      cancelOpenRun: await readCancelOpenRun(request),
      ...(modal.kind === "ready" ? { modalCredential: modal.credential } : {}),
    };
  }

  let response: Response;
  try {
    response = await caller.call(route.sessionId, route.archived ? "archive" : "unarchive", body);
  } catch {
    return Response.json({ error: "failed to reach the session object" }, { status: 502 });
  }
  if (!response.ok) {
    return Response.json({ error: "the session object rejected the change" }, { status: 502 });
  }
  const result = (await response.json()) as ArchiveSessionResult | UnarchiveSessionResult;
  if (result.kind === "run_open") {
    return Response.json({ error: "run_open" }, { status: 409 });
  }
  if (result.kind === "deleting" || result.kind === "no_session") {
    return Response.json({ error: "resource_not_found" }, { status: 403 });
  }

  const state = route.archived ? "archived" : "active";
  // Never out of `deletion_pending`. A row still `creating` moves too: the
  // object has just said it holds the session, and a projection that found
  // the row `creating` afterwards would write the state of an older snapshot.
  await env.DB.prepare(
    `UPDATE session_index SET state = ?, updated_at = ?
     WHERE session_id = ? AND workspace_id = ? AND state IN ('creating', 'active', 'archived')`,
  )
    .bind(state, new Date().toISOString(), route.sessionId, workspaceId)
    .run();
  return Response.json({ sessionId: route.sessionId, state }, { status: 200 });
}
