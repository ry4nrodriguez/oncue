/**
 * `/api/modal-connection`: the HTTP shell around the workspace's Modal
 * credential; `worker/modal/connections.ts` makes every decision. A workspace
 * has exactly one Modal connection, so no route takes an id and a caller
 * cannot name anyone else's. Responses are built from
 * `ModalConnectionSummary`, which has no credential field.
 */

import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { isPlainObject } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";
import {
  createModalCredentialTester,
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  type ModalTestFailureReason,
} from "../modal/client";
import {
  disconnectModalConnection,
  readModalConnection,
  saveModalConnection,
} from "../modal/connections";
import { readControllerConfig } from "../sandbox/origin";
import { cachedCredentialKeyring } from "./credential-keyring";
import { type Defer, startImageWarm } from "./image-warm";

/**
 * A total table, so a new reason is a compile error. A verdict on the pasted
 * credential is 422 (the user can act); an unreachable or refusing controller
 * is 503 (retry).
 */
const TEST_FAILURE_STATUS: Record<ModalTestFailureReason, number> = {
  invalid_credentials: 422,
  no_environment_access: 422,
  unreachable: 503,
  controller_unavailable: 503,
};

function denialResponse(reason: "unauthenticated" | "not_allowlisted"): Response {
  return Response.json({ error: reason }, { status: reason === "unauthenticated" ? 401 : 403 });
}

function testFailedResponse(reason: ModalTestFailureReason): Response {
  return Response.json({ error: "test_failed", reason }, { status: TEST_FAILURE_STATUS[reason] });
}

async function parsedRequestBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = safeJsonParse(await request.text());
  return parsed.ok && isPlainObject(parsed.value) ? parsed.value : {};
}

/** `null` for absent, a non-string, or a value that is empty once trimmed. */
function tokenFrom(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Absent, empty, and non-string all mean "use the Modal workspace's default
// Environment".
function environmentFrom(value: unknown): string | null {
  return tokenFrom(value);
}

/** `GET /api/modal-connection`: the workspace's connection, or `null`. Never the credential. */
export async function handleReadModalConnection(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const connection = await readModalConnection(env.DB, actorWorkspaceId(outcome.actor));
  return Response.json({ connection }, { status: 200 });
}

/**
 * `POST /api/modal-connection`: tests the pair against the user's Modal
 * account before storing it, and returns the Modal workspace name so the
 * screen can show which account was connected.
 */
export async function handleSaveModalConnection(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
  defer: Defer = () => undefined,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const body = await parsedRequestBody(request);
  const tokenId = tokenFrom(body.tokenId);
  if (tokenId === null) {
    return Response.json({ error: "invalid_request", reason: "tokenId" }, { status: 400 });
  }
  const tokenSecret = tokenFrom(body.tokenSecret);
  if (tokenSecret === null) {
    return Response.json({ error: "invalid_request", reason: "tokenSecret" }, { status: 400 });
  }

  // Without OnCue's controller settings no pair can be tested, and an untested
  // pair is never stored.
  const controller = readControllerConfig(env, env.ONCUE_ENV);
  if (controller.kind === "unconfigured") {
    return testFailedResponse("controller_unavailable");
  }
  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    return testFailedResponse("controller_unavailable");
  }

  const result = await saveModalConnection(
    {
      db: env.DB,
      keyring: keyringResult.keyring,
      test: createModalCredentialTester({
        access: controller.settings,
        // Bound, not the bare global: workerd throws "Illegal invocation" when `fetch`
        // loses its `this`.
        fetchImpl: fetch.bind(globalThis),
        timeoutMs: DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
      }),
      now: () => new Date().toISOString(),
      newId: () => `mdl_${crypto.randomUUID()}`,
    },
    actorWorkspaceId(outcome.actor),
    { tokenId, tokenSecret, environmentName: environmentFrom(body.environmentName) },
  );
  if (result.kind === "rejected") {
    return testFailedResponse(result.reason);
  }
  // A new workspace, or a new credential for one, has the image built now
  // rather than inside its first session's start.
  defer(startImageWarm(env, actorWorkspaceId(outcome.actor), true));
  return Response.json({ connection: result.summary }, { status: 200 });
}

/**
 * `DELETE /api/modal-connection`: removes the row and its sealed bytes. No
 * connection is a 404, so nobody believes a nonexistent credential was
 * withdrawn.
 */
export async function handleDisconnectModalConnection(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const result = await disconnectModalConnection(env.DB, actorWorkspaceId(outcome.actor));
  if (result.kind === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ disconnected: true }, { status: 200 });
}
