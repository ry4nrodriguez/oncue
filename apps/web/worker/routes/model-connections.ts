/**
 * `/api/model-connections`: the HTTP shell around record 06's model
 * connections; `worker/broker/connections.ts` makes every decision. Responses
 * are built from `ConnectionSummary`, which has no credential field, and
 * forwarded unchanged to the browser's parser.
 */

import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import {
  activeSessionsByConnection,
  type ConnectionDeps,
  createConnection,
  listConnections,
  readConnection,
  replaceCredential,
  revokeConnection,
} from "../broker/connections";
import type { Keyring } from "../broker/envelope";
import { FAILURE_POLICY } from "../broker/forward";
import { checkStoredKey } from "../broker/key-check";
import {
  isPlainObject,
  PROVIDER_IDS,
  parseProviderId,
  resolveProviderOrigin,
} from "../broker/providers/adapter";
import { catalogFor, PRICES_AS_OF } from "../broker/providers/catalog";
import { safeJsonParse } from "../json";
import { cachedCredentialKeyring } from "./credential-keyring";

/** Same shape `worker/routes/broker.ts` answers with for the same failure. */
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

export function connectionDeps(env: Env, keyring: Keyring<"credential">): ConnectionDeps {
  return {
    db: env.DB,
    keyring,
    // Bound, not the bare global: workerd throws "Illegal invocation" when `fetch`
    // loses its `this`, and unit tests that inject a closure never see it.
    fetchImpl: fetch.bind(globalThis),
    originFor: (adapter) =>
      resolveProviderOrigin(adapter, env.ONCUE_ENV, env.ONCUE_PROVIDER_DOUBLE_ORIGIN),
    now: () => new Date().toISOString(),
    newId: () => `mc_${crypto.randomUUID()}`,
  };
}

/** `null` for absent, a non-string, or a value that is empty once trimmed. */
function credentialFrom(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function parsedRequestBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = safeJsonParse(await request.text());
  return parsed.ok && isPlainObject(parsed.value) ? parsed.value : {};
}

function denialResponse(reason: "unauthenticated" | "not_allowlisted"): Response {
  return Response.json({ error: reason }, { status: reason === "unauthenticated" ? 401 : 403 });
}

const MODEL_CONNECTION_PATH = /^\/api\/model-connections\/([^/]+)$/;
const MODEL_CONNECTION_REVOKE_PATH = /^\/api\/model-connections\/([^/]+)\/revoke$/;
const MODEL_CONNECTION_RECHECK_PATH = /^\/api\/model-connections\/([^/]+)\/recheck$/;

/** For `PUT /api/model-connections/:id`, in the style of `session-delete.ts`. */
export function extractModelConnectionId(pathname: string): string | null {
  const match = MODEL_CONNECTION_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const connectionId = match[1];
  return connectionId === undefined ? null : connectionId;
}

/** For `POST /api/model-connections/:id/revoke`. */
export function extractRevokeModelConnectionId(pathname: string): string | null {
  const match = MODEL_CONNECTION_REVOKE_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const connectionId = match[1];
  return connectionId === undefined ? null : connectionId;
}

/** For `POST /api/model-connections/:id/recheck`. */
export function extractRecheckModelConnectionId(pathname: string): string | null {
  const match = MODEL_CONNECTION_RECHECK_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  const connectionId = match[1];
  return connectionId === undefined ? null : connectionId;
}

/** `GET /api/model-connections`: every connection the caller's workspace has. */
export async function handleListModelConnections(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const workspaceId = actorWorkspaceId(outcome.actor);
  const [rows, sessions] = await Promise.all([
    listConnections(env.DB, workspaceId),
    activeSessionsByConnection(env.DB, workspaceId),
  ]);
  const connections = rows.map((row) => ({
    ...row,
    activeSessions: sessions.get(row.connectionId) ?? 0,
  }));
  // The catalog rides along so the Model providers page can show what a key
  // would unlock before one exists, from the same table the picker reads.
  const catalog = Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, catalogFor(provider)]),
  );
  return Response.json({ connections, catalog, pricesAsOf: PRICES_AS_OF }, { status: 200 });
}

/**
 * `POST /api/model-connections`: validates the credential against the
 * provider before writing anything, so a known-bad key is never stored.
 */
export async function handleCreateModelConnection(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const body = await parsedRequestBody(request);
  const provider = typeof body.provider === "string" ? parseProviderId(body.provider) : null;
  if (provider === null) {
    return Response.json({ error: "invalid_request", reason: "provider" }, { status: 400 });
  }
  const credential = credentialFrom(body.credential);
  if (credential === null) {
    return Response.json({ error: "invalid_request", reason: "credential" }, { status: 400 });
  }

  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const result = await createConnection(
    connectionDeps(env, keyringResult.keyring),
    actorWorkspaceId(outcome.actor),
    provider,
    credential,
  );
  if (result.kind === "already_connected") {
    return Response.json(
      { error: "already_connected", connectionId: result.connectionId },
      { status: 409 },
    );
  }
  if (result.kind === "rejected") {
    return Response.json(
      { error: "validation_failed", category: result.category },
      { status: 422 },
    );
  }
  return Response.json({ connection: result.summary }, { status: 201 });
}

/**
 * `PUT /api/model-connections/:id`: the same provider validation and
 * credential rule as create, so an invalid value never costs a provider call.
 */
export async function handleReplaceModelConnectionCredential(
  request: Request,
  env: Env,
  connectionId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const body = await parsedRequestBody(request);
  const credential = credentialFrom(body.credential);
  if (credential === null) {
    return Response.json({ error: "invalid_request", reason: "credential" }, { status: 400 });
  }

  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const result = await replaceCredential(
    connectionDeps(env, keyringResult.keyring),
    actorWorkspaceId(outcome.actor),
    connectionId,
    credential,
  );
  if (result.kind === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (result.kind === "rejected") {
    return Response.json(
      { error: "validation_failed", category: result.category },
      { status: 422 },
    );
  }
  return Response.json({ connection: result.summary }, { status: 200 });
}

// Revocation destroys the sealed bytes, so it needs no credential or keyring.
export async function handleRevokeModelConnection(
  request: Request,
  env: Env,
  connectionId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const result = await revokeConnection(
    env.DB,
    actorWorkspaceId(outcome.actor),
    connectionId,
    new Date().toISOString(),
  );
  if (result.kind === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ connection: result.summary }, { status: 200 });
}

/**
 * `POST /api/model-connections/:id/recheck`: asks the provider about the stored
 * key now. `check` says what the provider answered and `connection` is the row
 * afterwards: accepted returns an invalid key to active, rejected marks it
 * invalid, and unreachable changes nothing. A revoked connection holds no key,
 * so it is refused.
 */
export async function handleRecheckModelConnection(
  request: Request,
  env: Env,
  connectionId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }
  const workspaceId = actorWorkspaceId(outcome.actor);

  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return brokerUnavailableResponse();
  }

  const checked = await checkStoredKey(connectionDeps(env, keyringResult.keyring), {
    workspaceId,
    connectionId,
  });
  if (checked.kind === "absent") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (checked.kind === "no_key") {
    return Response.json({ error: "revoked" }, { status: 409 });
  }
  if (checked.kind === "unusable") {
    return brokerUnavailableResponse();
  }
  const connection = await readConnection(env.DB, workspaceId, connectionId);
  if (connection === null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json(
    { connection, check: checked.kind === "inconclusive" ? "unreachable" : checked.kind },
    { status: 200 },
  );
}
