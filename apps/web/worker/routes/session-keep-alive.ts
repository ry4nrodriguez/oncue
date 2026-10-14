/**
 * `POST /api/sessions/:id/sandbox/keep-alive`: the owner extends the idle
 * deadline (record 11). The object bounds it: at most an hour, never past the
 * planned replacement, only while a sandbox is live. Answers the recorded
 * expiry or `409 not_running`.
 */

import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import type { KeepAliveResult } from "../session/session-object";

const SESSION_KEEP_ALIVE_PATH = /^\/api\/sessions\/([^/]+)\/sandbox\/keep-alive$/;

export function extractKeepAliveSessionId(pathname: string): string | null {
  return SESSION_KEEP_ALIVE_PATH.exec(pathname)?.[1] ?? null;
}

export async function handleKeepAlive(
  request: Request,
  env: Env,
  sessionId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }
  // The same two failures the stop route answers 502 for: the object could
  // not be reached, or it answered with an error rather than a result.
  let response: Response;
  try {
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    response = await stub.fetch("https://session/internal/keep-alive", { method: "POST" });
  } catch {
    return Response.json({ error: "failed to reach the session object" }, { status: 502 });
  }
  if (!response.ok) {
    return Response.json({ error: "the session object rejected the keep-alive" }, { status: 502 });
  }
  const result = (await response.json()) as KeepAliveResult;
  if (result.kind === "not_running") {
    return Response.json({ error: "not_running" }, { status: 409 });
  }
  return Response.json({ expiresAt: result.expiresAt }, { status: 200 });
}
