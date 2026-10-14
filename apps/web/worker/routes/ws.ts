/**
 * The client WebSocket upgrade path. `authorizeSessionRequest` validates the
 * Clerk session (cookie only), resolves the actor, and confirms they own the
 * session before anything reaches the object.
 *
 * The request to the object is built new: only the `after` query parameter,
 * `Upgrade: websocket`, and the verified `x-oncue-user-id` cross. Building
 * fresh leaves no branch where a client-supplied header could slip through.
 *
 * A denial is delivered by accepting the socket and closing it with a coded
 * reason (4401/4403), because a plain HTTP 401/403 to an upgrade reaches the
 * browser as an opaque 1006.
 */

import { actorUserId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import {
  AUTHORIZE_DENIAL_WS_CLOSE_CODE,
  AUTHORIZE_DENIAL_WS_CLOSE_REASON,
  authorizeSessionRequest,
} from "../auth/authorize";

const SESSION_CLIENT_PATH = /^\/ws\/sessions\/([^/]+)\/client$/;

export function extractClientSessionId(pathname: string): string | null {
  const match = SESSION_CLIENT_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  return sessionId === undefined ? null : sessionId;
}

function acceptThenClose(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  const client = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

function buildForwardedUpgrade(originalUrl: URL, userId: string): Request {
  const forwardedUrl = new URL(`${originalUrl.origin}${originalUrl.pathname}`);
  const after = originalUrl.searchParams.get("after");
  if (after !== null) {
    forwardedUrl.searchParams.set("after", after);
  }
  return new Request(forwardedUrl, {
    headers: {
      Upgrade: "websocket",
      "x-oncue-user-id": userId,
    },
  });
}

export async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = extractClientSessionId(url.pathname);
  if (sessionId === null) {
    return new Response("not found", { status: 404 });
  }

  const outcome = await authorizeSessionRequest(env, request, sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return acceptThenClose(
      AUTHORIZE_DENIAL_WS_CLOSE_CODE[outcome.reason],
      AUTHORIZE_DENIAL_WS_CLOSE_REASON[outcome.reason],
    );
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  return stub.fetch(buildForwardedUpgrade(url, actorUserId(outcome.actor)));
}
