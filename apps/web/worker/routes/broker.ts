/**
 * The HTTP legs of record 06's Model Broker: issuing a session's model token,
 * refreshing one, and forwarding a signed model request. `worker/broker/**`
 * makes every authorization and cryptographic decision; this file parses,
 * calls, and shapes a `Response`.
 *
 * The issue route is authenticated as the session owner. Refresh and forward
 * are bearer-token routes: the current token (possibly expired, for refresh)
 * is the proof.
 */

import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import { readAuthorizedConnection, resolveModel } from "../broker/connections";
import { deriveKeyring, type KeyringResult } from "../broker/envelope";
import { FAILURE_POLICY, type ForwardDeps, forwardModelRequest } from "../broker/forward";
import { resolveProviderOrigin } from "../broker/providers/adapter";
import {
  checkForRefresh,
  mintToken,
  renewToken,
  TOKEN_REFRESH_WINDOW_MS,
  TOKEN_TTL_MS,
  type TokenScope,
} from "../broker/tokens";
import { safeJsonParse } from "../json";
import { log } from "../log";
import { exactlyOne } from "../sql";

// HKDF plus `importKey` per keyring entry is the largest term in the broker's
// cost, so each keyring is derived once per distinct secret. Keying by the
// secret lets tests reach the unconfigured and malformed paths.
const credentialKeyringCache = new Map<string | undefined, Promise<KeyringResult<"credential">>>();
const tokenKeyringCache = new Map<string | undefined, Promise<KeyringResult<"token">>>();

function cachedCredentialKeyring(secret: string | undefined): Promise<KeyringResult<"credential">> {
  const cached = credentialKeyringCache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveKeyring(secret, "credential");
  credentialKeyringCache.set(secret, derived);
  return derived;
}

function cachedTokenKeyring(secret: string | undefined): Promise<KeyringResult<"token">> {
  const cached = tokenKeyringCache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveKeyring(secret, "token");
  tokenKeyringCache.set(secret, derived);
  return derived;
}

/** What every one of these three routes answers when a keyring will not derive. */
function brokerUnavailableResponse(): Response {
  const policy = FAILURE_POLICY.broker_failure;
  return Response.json(
    {
      error: "model_failure",
      category: "broker_failure",
      retrySafe: policy.retrySafe,
      message: policy.message,
    },
    { status: 503 },
  );
}

function forbiddenResponse(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

// The mint functions never return their claims, so `expiresAt` is recomputed
// here with the same formula, capped at `refreshableUntil`.
function expiresAtIso(nowMs: number, refreshableUntil: number): string {
  return new Date(Math.min(nowMs + TOKEN_TTL_MS, refreshableUntil)).toISOString();
}

async function parsedRequestBody(request: Request): Promise<unknown> {
  const parsed = safeJsonParse(await request.text());
  return parsed.ok ? parsed.value : undefined;
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return null;
  }
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}

const SESSION_BROKER_TOKEN_PATH = /^\/api\/sessions\/([^/]+)\/broker-token$/;
const BROKER_FORWARD_PATH = /^\/api\/broker\/sessions\/([^/]+)\/v1\/messages$/;

/** For `POST /api/sessions/:sessionId/broker-token`, in the style of `session-delete.ts`. */
export function extractBrokerTokenSessionId(pathname: string): string | null {
  const match = SESSION_BROKER_TOKEN_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  return sessionId === undefined ? null : sessionId;
}

/** For `POST /api/broker/sessions/:sessionId/v1/messages`. */
export function extractForwardSessionId(pathname: string): string | null {
  const match = BROKER_FORWARD_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const sessionId = match[1];
  return sessionId === undefined ? null : sessionId;
}

/**
 * `POST /api/sessions/:sessionId/broker-token`: mints a model token for one of
 * the owner's active connections, authorized through `resolveModel`. The
 * sandbox path does not use it: the session object mints the bridge's token
 * itself against the run's recorded connection.
 *
 * The current `session_index.sandbox_generation` goes into the claims so the
 * mint and `readAuthorizedConnection` cannot disagree; `NULL` (no generation
 * yet) is a 409.
 */
export async function handleIssueBrokerToken(
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
  const workspaceId = actorWorkspaceId(outcome.actor);

  const resolved = await resolveModel(env.DB, workspaceId, await parsedRequestBody(request));
  if (resolved.kind !== "resolved") {
    return forbiddenResponse();
  }

  // The session id is the one `authorizeSessionRequest` just found, so the row
  // exists.
  const generationRow = await exactlyOne<{ readonly sandbox_generation: number | null }>(
    env.DB.prepare("SELECT sandbox_generation FROM session_index WHERE session_id = ?").bind(
      sessionId,
    ),
    "session vanished after authorization",
  );
  if (generationRow.sandbox_generation === null) {
    return Response.json({ error: "no_generation" }, { status: 409 });
  }

  const keyringResult = await cachedTokenKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const scope: TokenScope = {
    sessionId,
    sandboxGeneration: generationRow.sandbox_generation,
    connectionId: resolved.model.modelConnectionId,
    workspaceId,
    modelId: resolved.model.modelId,
    effort: resolved.model.effort ?? null,
  };
  const nowMs = Date.now();
  const token = await mintToken(keyringResult.keyring, scope, nowMs);
  return Response.json(
    { token, expiresAt: expiresAtIso(nowMs, nowMs + TOKEN_REFRESH_WINDOW_MS) },
    { status: 200 },
  );
}

/**
 * `POST /api/broker/token/refresh`: the old token is the only proof, and an
 * expired one is accepted so a long run can refresh mid-stream. The same
 * `readAuthorizedConnection` check as a forward runs first, so a connection
 * revoked mid-stream cannot be refreshed past.
 */
export async function handleRefreshBrokerToken(request: Request, env: Env): Promise<Response> {
  const bearer = bearerFrom(request);
  if (bearer === null) {
    return forbiddenResponse();
  }

  const keyringResult = await cachedTokenKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const nowMs = Date.now();
  const checked = await checkForRefresh(keyringResult.keyring, bearer, nowMs);
  if (checked.kind === "rejected") {
    return forbiddenResponse();
  }
  const claims = checked.claims;

  const authorized = await readAuthorizedConnection(env.DB, claims);
  if (authorized.kind === "denied") {
    return forbiddenResponse();
  }

  const token = await renewToken(keyringResult.keyring, claims, nowMs);
  return Response.json(
    { token, expiresAt: expiresAtIso(nowMs, claims.refreshableUntil) },
    { status: 200 },
  );
}

/**
 * `POST /api/broker/sessions/:sessionId/v1/messages`: the forwarding leg.
 * `forwardModelRequest` does all the work; `waitUntil` is a plain callback so
 * a test can pass a recorder.
 */
export async function handleForwardModelRequest(
  request: Request,
  env: Env,
  sessionId: string,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> {
  const [credentialKeyringResult, tokenKeyringResult] = await Promise.all([
    cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING),
    cachedTokenKeyring(env.ONCUE_BROKER_KEYRING),
  ]);
  if (credentialKeyringResult.kind !== "ok" || tokenKeyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const deps: ForwardDeps = {
    db: env.DB,
    credentialKeyring: credentialKeyringResult.keyring,
    tokenKeyring: tokenKeyringResult.keyring,
    // Bound, not the bare global: workerd throws "Illegal invocation" when `fetch`
    // loses its `this`, and unit tests that inject a closure never see it.
    fetchImpl: fetch.bind(globalThis),
    originFor: (adapter) =>
      resolveProviderOrigin(adapter, env.ONCUE_ENV, env.ONCUE_PROVIDER_DOUBLE_ORIGIN),
    now: () => Date.now(),
    log,
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    waitUntil,
  };

  const outcome = await forwardModelRequest(deps, {
    sessionId,
    bearer: bearerFrom(request),
    body: await request.arrayBuffer(),
    contentType: request.headers.get("content-type"),
    // Every inbound header. `forwardModelRequest` alone decides which reach the
    // provider (the adapter's `forwardedRequestHeaders`).
    passthroughHeaders: Object.fromEntries(request.headers.entries()),
  });

  if (outcome.kind === "streamed") {
    return outcome.response;
  }
  if (outcome.kind === "denied") {
    return forbiddenResponse();
  }

  const headers = new Headers();
  if (outcome.retryAfter !== null) {
    headers.set("retry-after", outcome.retryAfter);
  }
  return Response.json(
    {
      error: "model_failure",
      category: outcome.category,
      retrySafe: outcome.retrySafe,
      message: outcome.message,
    },
    { status: outcome.status, headers },
  );
}
