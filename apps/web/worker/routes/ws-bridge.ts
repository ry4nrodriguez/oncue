/**
 * `GET /ws/bridge/:sessionId/:generation`: the server half of the bridge's
 * outbound WebSocket (record 02).
 *
 * The route cannot check the bootstrap credential: it is random per
 * generation and only its hash lives in the session object's storage. The
 * route forwards the bearer as `x-oncue-bridge-credential`; the object
 * compares in constant time, closes an unauthenticated socket with 4401, and
 * refuses a superseded generation's credential only after that, so an
 * attacker learns nothing about which generation is current. Keeping hashes
 * out of D1 is why unauthenticated upgrades reach the object at all.
 *
 * Only for a session the control plane has recorded, though. An id nobody
 * created is refused here with the 404 its object would give, before any
 * object is woken to give it (`../session/known-session.ts`).
 */

import type { SandboxReference } from "../sandbox/driver";
import { isKnownSession } from "../session/known-session";
import { BRIDGE_CREDENTIAL_HEADER } from "../session/session-object";

const BRIDGE_PATH = /^\/ws\/bridge\/([^/]+)\/([^/]+)$/;

function parseGeneration(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A session id is any non-empty, slash-free string (an opaque `idFromName`
 * key); a generation must be a non-negative integer, since it goes into a
 * Durable Object path segment.
 */
export function extractBridgeRoute(pathname: string): SandboxReference | null {
  const match = BRIDGE_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  const rawGeneration = match[2];
  if (sessionId === undefined || rawGeneration === undefined) {
    return null;
  }
  const generation = parseGeneration(rawGeneration);
  if (generation === null) {
    return null;
  }
  return { sessionId, generation };
}

const BEARER_PREFIX = "Bearer ";

/** `bridgeConnectHeaders` in `services/bridge/src/main.ts` is the other half of this shape. */
function presentedCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

// Rebuilt from scratch, as `routes/ws.ts` does: only `Upgrade` and the
// presented credential cross this boundary.
function buildForwardedBridgeUpgrade(originalUrl: URL, presented: string | null): Request {
  const headers = new Headers({ Upgrade: "websocket" });
  if (presented !== null) {
    headers.set(BRIDGE_CREDENTIAL_HEADER, presented);
  }
  return new Request(new URL(`${originalUrl.origin}${originalUrl.pathname}`), { headers });
}

export async function handleBridgeWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = extractBridgeRoute(url.pathname);
  if (route === null) {
    return new Response("not found", { status: 400 });
  }
  if (!(await isKnownSession(env.DB, route.sessionId))) {
    return new Response("session not found", { status: 404 });
  }
  const stub = env.SESSION.get(env.SESSION.idFromName(route.sessionId));
  return stub.fetch(buildForwardedBridgeUpgrade(url, presentedCredential(request)));
}
