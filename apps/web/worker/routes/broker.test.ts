import { env } from "cloudflare:test";
import { brokerForwardPath } from "@oncue/bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { deriveKeyring, type Keyring, sealCredential } from "../broker/envelope";
import { PROVIDER_ADAPTERS } from "../broker/providers/adapter";
import {
  checkForForward,
  mintToken,
  TOKEN_REFRESH_WINDOW_MS,
  TOKEN_TTL_MS,
} from "../broker/tokens";
import { createClerkDouble } from "../test/clerk-double";
import { createProviderDouble } from "../test/provider-double";
import {
  extractBrokerTokenSessionId,
  extractForwardSessionId,
  handleForwardModelRequest,
  handleIssueBrokerToken,
  handleRefreshBrokerToken,
} from "./broker";

const NOW = "2026-09-05T00:00:00.000Z";
const MODEL_ID = PROVIDER_ADAPTERS.anthropic.defaultModel.modelId;

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_BROKER_KEYRING?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function postJsonAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  url: string,
  body: unknown,
): Promise<Request> {
  const authed = await double.requestAs(subject, url);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authed.headers.get("cookie") ?? "" },
    body: JSON.stringify(body),
  });
}

function bearerRequest(
  url: string,
  options: { method?: string; bearer?: string | null; body?: BodyInit } = {},
): Request {
  const headers = new Headers();
  if (options.bearer !== null && options.bearer !== undefined) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  }
  return new Request(url, {
    method: options.method ?? "POST",
    headers,
    body: options.body ?? null,
  });
}

async function seedWorkspace(subject: string): Promise<string> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
  ]);
  return workspaceId;
}

// Derived from the test secret miniflare gives every isolate, to seal real
// ciphertext: a fake `credential_reference` would fail as tampered before
// reaching the double.
async function verificationCredentialKeyring(): Promise<Keyring<"credential">> {
  const result = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");
  if (result.kind !== "ok") {
    throw new Error("expected the test keyring to derive");
  }
  return result.keyring;
}

async function insertConnection(
  workspaceId: string,
  connectionId: string,
  overrides: { provider?: string; status?: string; sealed?: string } = {},
): Promise<void> {
  const provider = overrides.provider ?? "anthropic";
  const sealed =
    overrides.sealed ??
    (await sealCredential(
      await verificationCredentialKeyring(),
      { connectionId, workspaceId, provider },
      "sk-ant-fake0001",
    ));
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'api_key', ?, ?, '...0001', NULL, ?, ?, ?)`,
  )
    .bind(connectionId, workspaceId, provider, sealed, overrides.status ?? "active", NOW, NOW, NOW)
    .run();
}

async function insertSession(
  sessionId: string,
  workspaceId: string,
  options: { state?: string; generation?: number | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      workspaceId,
      options.state ?? "active",
      options.generation === undefined ? 3 : options.generation,
      NOW,
      NOW,
    )
    .run();
}

// The same key material as `broker.ts`'s private cache, since `deriveKeyring`
// is a pure function of the test secret; used to inspect or forge tokens.
async function verificationTokenKeyring(): Promise<Keyring<"token">> {
  const result = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "token");
  if (result.kind !== "ok") {
    throw new Error("expected the test keyring to derive");
  }
  return result.keyring;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM session_index").run();
  await env.DB.prepare("DELETE FROM model_connection").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("path matchers", () => {
  it("extracts a session id from the broker-token path and rejects near misses", () => {
    expect(extractBrokerTokenSessionId("/api/sessions/sess_1/broker-token")).toBe("sess_1");
    expect(extractBrokerTokenSessionId("/api/sessions/sess_1")).toBeNull();
    expect(extractBrokerTokenSessionId("/api/broker/token/refresh")).toBeNull();
  });

  it("extracts a session id from the forward path and rejects near misses", () => {
    expect(extractForwardSessionId("/api/broker/sessions/sess_1/v1/messages")).toBe("sess_1");
    expect(extractForwardSessionId("/api/broker/sessions/sess_1")).toBeNull();
    expect(extractForwardSessionId("/api/sessions/sess_1/broker-token")).toBeNull();
  });

  // The bridge's relay path builder must produce a path this route's extractor
  // reads the same session id back from.
  it("round-trips the bridge's own forward path through this route's extractor", () => {
    for (const sessionId of ["sess_1", "sess_with_underscores", "sess-with-dashes"]) {
      expect(extractForwardSessionId(brokerForwardPath(sessionId))).toBe(sessionId);
    }
  });
});

describe("handleIssueBrokerToken", () => {
  const url = "https://oncue.example/api/sessions/sess_issue/broker-token";

  it("returns 401 for an unauthenticated request", async () => {
    const response = await handleIssueBrokerToken(
      new Request(url, { method: "POST" }),
      env,
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 with the authorize denial reason for a session the caller does not own", async () => {
    const subject = "user_issue_not_owner";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, { modelConnectionId: "mc_1" });

    const response = await handleIssueBrokerToken(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "resource_not_found" });
  });

  it("returns 403 forbidden when the named connection is not active", async () => {
    const subject = "user_issue_inactive";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_inactive", { status: "invalid" });
    await insertSession("sess_issue", workspaceId);
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, { modelConnectionId: "mc_inactive" });

    const response = await handleIssueBrokerToken(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 403 forbidden when the request names no connection", async () => {
    const subject = "user_issue_no_connection_named";
    const workspaceId = await seedWorkspace(subject);
    await insertSession("sess_issue", workspaceId);
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, {});

    const response = await handleIssueBrokerToken(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 409 no_generation when the session has not been projected yet", async () => {
    const subject = "user_issue_no_generation";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_no_gen");
    await insertSession("sess_issue", workspaceId, { generation: null });
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, { modelConnectionId: "mc_no_gen" });

    const response = await handleIssueBrokerToken(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_generation" });
  });

  it("returns 503 broker_unavailable when the token keyring will not derive", async () => {
    const subject = "user_issue_no_keyring";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_no_keyring");
    await insertSession("sess_issue", workspaceId);
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, { modelConnectionId: "mc_no_keyring" });

    const response = await handleIssueBrokerToken(
      request,
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_BROKER_KEYRING: "not-a-valid-keyring",
      }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "model_failure",
      category: "broker_failure",
      retrySafe: true,
      message: "OnCue could not complete this request.",
    });
  });

  it("mints a token scoped to exactly the session, generation, connection, and model", async () => {
    const subject = "user_issue_ok";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_ok");
    await insertSession("sess_issue", workspaceId, { generation: 7 });
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, url, { modelConnectionId: "mc_ok" });
    const beforeMs = Date.now();

    const response = await handleIssueBrokerToken(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_issue",
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; expiresAt: string };
    expect(typeof body.token).toBe("string");

    const tokenKeyring = await verificationTokenKeyring();
    const checked = await checkForForward(tokenKeyring, body.token, Date.now());
    if (checked.kind !== "valid") {
      throw new Error("expected the minted token to verify");
    }
    expect(checked.claims).toMatchObject({
      sessionId: "sess_issue",
      sandboxGeneration: 7,
      connectionId: "mc_ok",
      workspaceId,
      modelId: MODEL_ID,
      effort: PROVIDER_ADAPTERS.anthropic.defaultModel.defaultEffort,
    });

    const expiresAtMs = Date.parse(body.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeMs + TOKEN_TTL_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(beforeMs + TOKEN_TTL_MS + 5000);
  });
});

describe("handleRefreshBrokerToken", () => {
  const url = "https://oncue.example/api/broker/token/refresh";

  it("returns 403 with no Authorization header", async () => {
    const response = await handleRefreshBrokerToken(bearerRequest(url, { bearer: null }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 503 broker_unavailable when the token keyring will not derive", async () => {
    const response = await handleRefreshBrokerToken(
      bearerRequest(url, { bearer: "whatever" }),
      envWith({ ONCUE_BROKER_KEYRING: "also-not-valid" }),
    );
    expect(response.status).toBe(503);
  });

  it("returns 403 for a malformed bearer token", async () => {
    const response = await handleRefreshBrokerToken(
      bearerRequest(url, { bearer: "not-a-real-token" }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 403 when the connection behind an otherwise-valid token has been revoked", async () => {
    const workspaceId = await seedWorkspace("user_refresh_revoked");
    await insertConnection(workspaceId, "mc_refresh_revoked", { status: "revoked" });
    await insertSession("sess_refresh_revoked", workspaceId, { generation: 2 });
    const tokenKeyring = await verificationTokenKeyring();
    const token = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_refresh_revoked",
        sandboxGeneration: 2,
        connectionId: "mc_refresh_revoked",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      Date.now(),
    );

    const response = await handleRefreshBrokerToken(bearerRequest(url, { bearer: token }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 403 once the token's generation has ended, so a stopping sandbox cannot renew past its stop", async () => {
    const workspaceId = await seedWorkspace("user_refresh_ended");
    await insertConnection(workspaceId, "mc_refresh_ended");
    await insertSession("sess_refresh_ended", workspaceId, { generation: 2 });
    // What the stop's revoke step writes, and retries before each terminate.
    await env.DB.prepare(
      "UPDATE session_index SET ended_sandbox_generation = 2 WHERE session_id = ?",
    )
      .bind("sess_refresh_ended")
      .run();
    const tokenKeyring = await verificationTokenKeyring();
    const token = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_refresh_ended",
        sandboxGeneration: 2,
        connectionId: "mc_refresh_ended",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      Date.now(),
    );

    const response = await handleRefreshBrokerToken(bearerRequest(url, { bearer: token }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("refreshes an EXPIRED token, preserving its scope and refresh ceiling", async () => {
    const workspaceId = await seedWorkspace("user_refresh_ok");
    await insertConnection(workspaceId, "mc_refresh_ok");
    await insertSession("sess_refresh_ok", workspaceId, { generation: 5 });
    const tokenKeyring = await verificationTokenKeyring();
    const mintedAtMs = Date.now() - TOKEN_TTL_MS - 5000; // already past its own expiry
    const expiredToken = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_refresh_ok",
        sandboxGeneration: 5,
        connectionId: "mc_refresh_ok",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      mintedAtMs,
    );

    const response = await handleRefreshBrokerToken(
      bearerRequest(url, { bearer: expiredToken }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; expiresAt: string };

    const nowMs = Date.now();
    const reChecked = await checkForForward(tokenKeyring, body.token, nowMs);
    if (reChecked.kind !== "valid") {
      throw new Error("expected the refreshed token to verify");
    }
    expect(reChecked.claims).toMatchObject({
      sessionId: "sess_refresh_ok",
      sandboxGeneration: 5,
      connectionId: "mc_refresh_ok",
      workspaceId,
      modelId: MODEL_ID,
      effort: null,
    });
    // The refresh ceiling never moves: it is still `mintedAtMs + the window`,
    // not recomputed from `nowMs`.
    expect(reChecked.claims.refreshableUntil).toBe(mintedAtMs + TOKEN_REFRESH_WINDOW_MS);
    expect(Date.parse(body.expiresAt)).toBe(reChecked.claims.expiresAt);
  });
});

describe("handleForwardModelRequest", () => {
  const url = "https://oncue.example/api/broker/sessions/sess_forward/v1/messages";

  function noopWaitUntil(): (work: Promise<unknown>) => void {
    return () => {};
  }

  it("returns 503 broker_unavailable when a keyring will not derive", async () => {
    const response = await handleForwardModelRequest(
      bearerRequest(url, { bearer: "whatever" }),
      envWith({ ONCUE_BROKER_KEYRING: "still-not-valid" }),
      "sess_forward",
      noopWaitUntil(),
    );
    expect(response.status).toBe(503);
  });

  it("returns 403 forbidden with no bearer token", async () => {
    const response = await handleForwardModelRequest(
      bearerRequest(url, { bearer: null, body: JSON.stringify({ model: MODEL_ID }) }),
      env,
      "sess_forward",
      noopWaitUntil(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns 403 forbidden when the token names a different session than the path", async () => {
    const workspaceId = await seedWorkspace("user_forward_wrong_session");
    await insertConnection(workspaceId, "mc_forward_wrong_session");
    await insertSession("sess_other", workspaceId, { generation: 1 });
    const tokenKeyring = await verificationTokenKeyring();
    const token = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_other",
        sandboxGeneration: 1,
        connectionId: "mc_forward_wrong_session",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      Date.now(),
    );

    const response = await handleForwardModelRequest(
      bearerRequest(url, { bearer: token, body: JSON.stringify({ model: MODEL_ID }) }),
      env,
      "sess_forward",
      noopWaitUntil(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("streams the provider double's response on a valid forward", async () => {
    const double = createProviderDouble("anthropic", "ok");
    vi.stubGlobal("fetch", double.fetchImpl);
    const workspaceId = await seedWorkspace("user_forward_ok");
    await insertConnection(workspaceId, "mc_forward_ok");
    await insertSession("sess_forward", workspaceId, { generation: 4 });
    const tokenKeyring = await verificationTokenKeyring();
    const token = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_forward",
        sandboxGeneration: 4,
        connectionId: "mc_forward_ok",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      Date.now(),
    );

    const response = await handleForwardModelRequest(
      bearerRequest(url, {
        bearer: token,
        body: JSON.stringify({ model: MODEL_ID, messages: [] }),
      }),
      env,
      "sess_forward",
      noopWaitUntil(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("message_stop");
  });

  it("reports a provider failure with its status, category, and a passed-through retry-after header", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
    );
    const workspaceId = await seedWorkspace("user_forward_rate_limited");
    await insertConnection(workspaceId, "mc_forward_rate_limited");
    await insertSession("sess_forward", workspaceId, { generation: 1 });
    const tokenKeyring = await verificationTokenKeyring();
    const token = await mintToken(
      tokenKeyring,
      {
        sessionId: "sess_forward",
        sandboxGeneration: 1,
        connectionId: "mc_forward_rate_limited",
        workspaceId,
        modelId: MODEL_ID,
        effort: null,
      },
      Date.now(),
    );

    const response = await handleForwardModelRequest(
      bearerRequest(url, {
        bearer: token,
        body: JSON.stringify({ model: MODEL_ID, messages: [] }),
      }),
      env,
      "sess_forward",
      noopWaitUntil(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: "model_failure",
      category: "rate_limited",
      retrySafe: true,
      message: "The provider asked us to wait before trying again.",
    });
  });
});
