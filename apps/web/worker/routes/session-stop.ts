/**
 * `POST /api/sessions/:id/sandbox/stop`: the owner stops their session's
 * sandbox. As with creation, the Worker opens the Modal credential and passes
 * it through one call; the object never stores it.
 *
 * Answers: `stopped` (200), `stopping` (202, the object's alarm finishes it),
 * `not_running` (409), or the driver's failure category (502). The session,
 * its events, and its branch remain; only the compute ends.
 */

import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import type { StopSandboxResult } from "../session/session-object";
import { prepareModalCredential } from "./sessions";

const SESSION_STOP_PATH = /^\/api\/sessions\/([^/]+)\/sandbox\/stop$/;

export function extractStopSessionId(pathname: string): string | null {
  const match = SESSION_STOP_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  return sessionId === undefined ? null : sessionId;
}

export interface StopCaller {
  callStop(sessionId: string, body: Record<string, unknown>): Promise<Response>;
}

export function realStopCaller(env: Env): StopCaller {
  return {
    async callStop(sessionId: string, body: Record<string, unknown>): Promise<Response> {
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch("https://session/internal/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

export async function handleStopSandbox(
  request: Request,
  env: Env,
  sessionId: string,
  caller: StopCaller,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }

  const modal = await prepareModalCredential(env, actorWorkspaceId(outcome.actor));
  if (modal.kind === "refused") {
    return modal.response;
  }

  let response: Response;
  try {
    response = await caller.callStop(sessionId, {
      requestedByUserId: actorUserId(outcome.actor),
      modalCredential: modal.credential,
    });
  } catch {
    return Response.json({ error: "failed to reach the session object" }, { status: 502 });
  }
  if (!response.ok) {
    return Response.json({ error: "the session object rejected the stop" }, { status: 502 });
  }
  const result = (await response.json()) as StopSandboxResult;
  if (result.kind === "not_running") {
    return Response.json({ error: "not_running" }, { status: 409 });
  }
  if (result.kind === "failed") {
    return Response.json(
      { error: "stop_failed", category: result.category, message: result.message },
      { status: 502 },
    );
  }
  // Accepted but not finished; the object's alarm carries the stop on.
  return Response.json(
    { sessionId, generation: result.generation },
    { status: result.kind === "stopping" ? 202 : 200 },
  );
}
