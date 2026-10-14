import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { deriveKeyring, sealCredential } from "../broker/envelope";
import { createClerkDouble } from "../test/clerk-double";
import { createProviderDouble } from "../test/provider-double";
import {
  extractModelConnectionId,
  extractRecheckModelConnectionId,
  extractRevokeModelConnectionId,
  handleCreateModelConnection,
  handleListModelConnections,
  handleRecheckModelConnection,
  handleReplaceModelConnectionCredential,
  handleRevokeModelConnection,
} from "./model-connections";

const BASE_URL = "https://oncue.example/api/model-connections";
const NOW = "2026-09-05T00:00:00.000Z";
const FAKE_KEY = "sk-ant-fake0001";

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_BROKER_KEYRING?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function requestAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Request> {
  const authed = await double.requestAs(subject, url);
  const headers = new Headers({ cookie: authed.headers.get("cookie") ?? "" });
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
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

async function insertConnection(
  workspaceId: string,
  connectionId: string,
  overrides: { provider?: string; status?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'api_key', 'oncue1.1.nonce.cipher', ?, '...0001', NULL, ?, ?, ?)`,
  )
    .bind(
      connectionId,
      workspaceId,
      overrides.provider ?? "anthropic",
      overrides.status ?? "active",
      NOW,
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_connection").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("path matchers", () => {
  it("extracts the id from a replace path and rejects the base and revoke paths", () => {
    expect(extractModelConnectionId("/api/model-connections/mc_1")).toBe("mc_1");
    expect(extractModelConnectionId("/api/model-connections")).toBeNull();
    expect(extractModelConnectionId("/api/model-connections/mc_1/revoke")).toBeNull();
  });

  it("extracts the id from a revoke path and rejects everything else", () => {
    expect(extractRevokeModelConnectionId("/api/model-connections/mc_1/revoke")).toBe("mc_1");
    expect(extractRevokeModelConnectionId("/api/model-connections/mc_1")).toBeNull();
    expect(extractRevokeModelConnectionId("/api/model-connections")).toBeNull();
  });

  it("extracts the id from a re-check path and rejects everything else", () => {
    expect(extractRecheckModelConnectionId("/api/model-connections/mc_1/recheck")).toBe("mc_1");
    expect(extractRecheckModelConnectionId("/api/model-connections/mc_1/revoke")).toBeNull();
    expect(extractRecheckModelConnectionId("/api/model-connections/mc_1")).toBeNull();
    expect(extractRecheckModelConnectionId("/api/model-connections//recheck")).toBeNull();
  });
});

describe("handleListModelConnections", () => {
  it("returns 401 for an unauthenticated request", async () => {
    const response = await handleListModelConnections(
      new Request(BASE_URL),
      env,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns 403 for a verified subject that is not allowlisted", async () => {
    const subject = "user_list_blocked";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL);

    const response = await handleListModelConnections(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "someone_else" }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_allowlisted" });
  });

  it("returns an empty list for a workspace with no connections", async () => {
    const subject = "user_list_empty";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL);

    const response = await handleListModelConnections(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connections: [] });
  });

  it("returns the caller's connections in the exact wire shape", async () => {
    const subject = "user_list_has_one";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_listed");
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL);

    const response = await handleListModelConnections(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connections: unknown[];
      catalog: Record<string, { modelId: string }[]>;
      pricesAsOf: string;
    };
    expect(body.connections).toEqual([
      {
        connectionId: "mc_listed",
        provider: "anthropic",
        status: "active",
        providerAccountHint: "...0001",
        lastValidatedAt: NOW,
        createdAt: NOW,
        activeSessions: 0,
      },
    ]);
    // The catalog for both providers rides along, connected or not, so the
    // Model providers page can show what a key would unlock.
    expect(Object.keys(body.catalog).sort()).toEqual(["anthropic", "openai"]);
    expect(body.catalog.anthropic?.map((spec) => spec.modelId)).toContain("claude-opus-5-5");
    expect(body.catalog.openai?.map((spec) => spec.modelId)).toContain("gpt-6-sol");
    expect(body.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("counts the active sessions each connection still serves", async () => {
    const subject = "user_list_counts_sessions";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_counted");
    await insertConnection(workspaceId, "mc_idle", { provider: "openai" });
    for (const [sessionId, state] of [
      ["sess_on_key_1", "active"],
      ["sess_on_key_2", "active"],
      ["sess_on_key_archived", "archived"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, model_connection_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'mc_counted', ?, ?)`,
      )
        .bind(sessionId, workspaceId, state, NOW, NOW)
        .run();
    }
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL);

    const response = await handleListModelConnections(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    const body = (await response.json()) as {
      connections: { connectionId: string; activeSessions: number }[];
    };
    expect(body.connections.map((row) => [row.connectionId, row.activeSessions]).sort()).toEqual([
      ["mc_counted", 2],
      ["mc_idle", 0],
    ]);
  });
});

describe("handleCreateModelConnection", () => {
  it("returns 401 for an unauthenticated request", async () => {
    const response = await handleCreateModelConnection(
      new Request(BASE_URL, { method: "POST" }),
      env,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 reason provider for an unrecognized provider", async () => {
    const subject = "user_bad_provider";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "not-a-real-provider", credential: FAKE_KEY },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "provider" });
  });

  it("returns 400 reason provider when the body is not JSON", async () => {
    const subject = "user_garbage_body";
    const double = await createClerkDouble();
    const authed = await double.requestAs(subject, BASE_URL);
    const request = new Request(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authed.headers.get("cookie") ?? "" },
      body: "{not json",
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "provider" });
  });

  it("returns 400 reason credential for a missing credential", async () => {
    const subject = "user_missing_credential";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic" },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "credential" });
  });

  it("returns 400 reason credential for a credential that is only whitespace", async () => {
    const subject = "user_whitespace_credential";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic", credential: "   " },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "credential" });
  });

  it("returns 503 broker_unavailable when the keyring will not derive", async () => {
    const subject = "user_no_keyring";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic", credential: FAKE_KEY },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_BROKER_KEYRING: "",
      }),
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

  it("returns 422 validation_failed when the provider rejects the credential", async () => {
    vi.stubGlobal("fetch", createProviderDouble("anthropic", "auth_failed").fetchImpl);
    const subject = "user_bad_key";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic", credential: FAKE_KEY },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      category: "authentication_failed",
    });
  });

  it("creates a connection, never echoing the submitted credential", async () => {
    vi.stubGlobal("fetch", createProviderDouble("anthropic", "ok").fetchImpl);
    const subject = "user_creates_connection";
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic", credential: FAKE_KEY },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    const rawText = await response.clone().text();
    expect(rawText).not.toContain(FAKE_KEY);

    const body = (await response.json()) as { connection: Record<string, unknown> };
    expect(body.connection).toMatchObject({
      provider: "anthropic",
      status: "active",
      providerAccountHint: "...0001",
    });
    expect(typeof body.connection.connectionId).toBe("string");
    expect(Object.keys(body.connection).sort()).toEqual(
      [
        "connectionId",
        "provider",
        "status",
        "providerAccountHint",
        "lastValidatedAt",
        "createdAt",
      ].sort(),
    );
  });

  it("returns 409 already_connected for a provider that already holds a key, without asking the provider", async () => {
    const providerDouble = createProviderDouble("anthropic", "ok");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);
    const subject = "user_creates_twice";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_first", { status: "invalid" });
    const double = await createClerkDouble();
    const request = await requestAs(double, subject, BASE_URL, {
      method: "POST",
      body: { provider: "anthropic", credential: FAKE_KEY },
    });

    const response = await handleCreateModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_connected", connectionId: "mc_first" });
    expect(providerDouble.calls).toHaveLength(0);
  });
});

describe("handleReplaceModelConnectionCredential", () => {
  it("returns 400 reason credential for an empty credential", async () => {
    const subject = "user_replace_bad_credential";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_replace_1");
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_replace_1`;
    const request = await requestAs(double, subject, url, {
      method: "PUT",
      body: { credential: "" },
    });

    const response = await handleReplaceModelConnectionCredential(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_replace_1",
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "credential" });
  });

  it("returns 404 not_found for a connection the caller does not own, without any provider call", async () => {
    const subject = "user_replace_missing";
    await seedWorkspace(subject);
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_does_not_exist`;
    const request = await requestAs(double, subject, url, {
      method: "PUT",
      body: { credential: FAKE_KEY },
    });

    const response = await handleReplaceModelConnectionCredential(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_does_not_exist",
      createAllowlistCache(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("returns 422 validation_failed when the provider rejects the replacement credential", async () => {
    vi.stubGlobal("fetch", createProviderDouble("anthropic", "auth_failed").fetchImpl);
    const subject = "user_replace_rejected";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_replace_2", { status: "invalid" });
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_replace_2`;
    const request = await requestAs(double, subject, url, {
      method: "PUT",
      body: { credential: FAKE_KEY },
    });

    const response = await handleReplaceModelConnectionCredential(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_replace_2",
      createAllowlistCache(),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      category: "authentication_failed",
    });
  });

  it("replaces the credential, returning 200 and never echoing it", async () => {
    vi.stubGlobal("fetch", createProviderDouble("anthropic", "ok").fetchImpl);
    const subject = "user_replace_ok";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_replace_3", { status: "invalid" });
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_replace_3`;
    const request = await requestAs(double, subject, url, {
      method: "PUT",
      body: { credential: FAKE_KEY },
    });

    const response = await handleReplaceModelConnectionCredential(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_replace_3",
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const rawText = await response.clone().text();
    expect(rawText).not.toContain(FAKE_KEY);
    const body = (await response.json()) as { connection: { status: string } };
    expect(body.connection.status).toBe("active");
  });
});

describe("handleRevokeModelConnection", () => {
  it("returns 404 not_found for a connection the caller does not own", async () => {
    const subject = "user_revoke_missing";
    await seedWorkspace(subject);
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_missing/revoke`;
    const request = await requestAs(double, subject, url, { method: "POST" });

    const response = await handleRevokeModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_missing",
      createAllowlistCache(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("revokes the connection and returns its final summary", async () => {
    const subject = "user_revoke_ok";
    const workspaceId = await seedWorkspace(subject);
    await insertConnection(workspaceId, "mc_revoke_1");
    const double = await createClerkDouble();
    const url = `${BASE_URL}/mc_revoke_1/revoke`;
    const request = await requestAs(double, subject, url, { method: "POST" });

    const response = await handleRevokeModelConnection(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "mc_revoke_1",
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connection: { status: string } };
    expect(body.connection.status).toBe("revoked");
  });
});

describe("handleRecheckModelConnection", () => {
  const SUBJECT = "user_recheck";
  const CONNECTION = "mc_recheck";
  /** Short enough for the secret scanner, distinctive enough to search for. */
  const STORED_KEY = "sk-ant-recheck00001";

  // A connection whose key really opens, as one made through the create route does.
  async function seedRealKey(status: string = "active"): Promise<void> {
    const workspaceId = await seedWorkspace(SUBJECT);
    const keyringResult = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");
    if (keyringResult.kind !== "ok") {
      throw new Error("the test runner always configures a keyring");
    }
    const sealed = await sealCredential(
      keyringResult.keyring,
      { connectionId: CONNECTION, workspaceId, provider: "anthropic" },
      STORED_KEY,
    );
    await env.DB.prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference,
         status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, 'anthropic', 'api_key', ?, ?, '...0001', NULL, ?, ?, ?)`,
    )
      .bind(CONNECTION, workspaceId, sealed, status, NOW, NOW, NOW)
      .run();
  }

  async function recheck(
    connectionId: string = CONNECTION,
    overrides: Parameters<typeof envWith>[0] = {},
  ): Promise<Response> {
    const double = await createClerkDouble();
    return handleRecheckModelConnection(
      await requestAs(double, SUBJECT, `${BASE_URL}/${connectionId}/recheck`, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT, ...overrides }),
      connectionId,
      createAllowlistCache(),
    );
  }

  it("returns 401 for an unauthenticated request", async () => {
    const response = await handleRecheckModelConnection(
      new Request(`${BASE_URL}/${CONNECTION}/recheck`, { method: "POST" }),
      env,
      CONNECTION,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
  });

  it("returns an invalid connection to active when the provider accepts its key", async () => {
    await seedRealKey("invalid");
    const provider = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", provider.fetchImpl);

    const response = await recheck();

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { check: string; connection: Record<string, unknown> };
    expect(body.check).toBe("accepted");
    expect(body.connection).toMatchObject({
      connectionId: CONNECTION,
      provider: "anthropic",
      status: "active",
      providerAccountHint: "...0001",
    });
    expect((body.connection.lastValidatedAt as string) > NOW).toBe(true);
    expect(text.includes(STORED_KEY)).toBe(false);
    expect(text.includes("oncue1.")).toBe(false);
    expect(provider.calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/models"]);
  });

  it("marks an active connection invalid when the provider rejects its key", async () => {
    await seedRealKey();
    vi.stubGlobal("fetch", createProviderDouble("anthropic", "auth_failed").fetchImpl);

    const response = await recheck();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      check: "rejected",
      connection: { connectionId: CONNECTION, status: "invalid", lastValidatedAt: NOW },
    });
  });

  it.each([
    ["active", "rate_limited"],
    ["invalid", "overloaded"],
  ] as const)(
    "changes nothing for a connection that is %s when the provider answers %s",
    async (status, mode) => {
      await seedRealKey(status);
      vi.stubGlobal("fetch", createProviderDouble("anthropic", mode).fetchImpl);

      const response = await recheck();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        check: "unreachable",
        connection: { status, lastValidatedAt: NOW },
      });
    },
  );

  it("says unreachable, changing nothing, when the provider cannot be reached at all", async () => {
    await seedRealKey("invalid");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no route to provider")));

    const response = await recheck();

    expect(await response.json()).toMatchObject({
      check: "unreachable",
      connection: { status: "invalid" },
    });
  });

  it("refuses a revoked connection, which holds no key, without asking the provider", async () => {
    const workspaceId = await seedWorkspace(SUBJECT);
    await insertConnection(workspaceId, CONNECTION, { status: "revoked" });
    const provider = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", provider.fetchImpl);

    const response = await recheck();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "revoked" });
    expect(provider.calls).toEqual([]);
  });

  it("returns 404 for another workspace's connection, without asking the provider or touching it", async () => {
    const otherWorkspace = await seedWorkspace("user_recheck_other");
    await seedWorkspace(SUBJECT);
    await insertConnection(otherWorkspace, CONNECTION);
    const provider = createProviderDouble("anthropic", "auth_failed");
    vi.stubGlobal("fetch", provider.fetchImpl);

    const response = await recheck();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(provider.calls).toEqual([]);
    const row = await env.DB.prepare("SELECT status FROM model_connection WHERE connection_id = ?")
      .bind(CONNECTION)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("returns 404 when the connection goes while its key is being checked", async () => {
    await seedRealKey();
    const provider = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      await env.DB.prepare("DELETE FROM model_connection WHERE connection_id = ?")
        .bind(CONNECTION)
        .run();
      return provider.fetchImpl(input, init);
    });

    const response = await recheck();

    expect(response.status).toBe(404);
  });

  it("returns 503 broker_failure when the stored value will not open, never blaming the provider", async () => {
    const workspaceId = await seedWorkspace(SUBJECT);
    await insertConnection(workspaceId, CONNECTION);
    const provider = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", provider.fetchImpl);

    const response = await recheck();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ category: "broker_failure" });
    expect(provider.calls).toEqual([]);
  });

  it("returns 503 broker_failure when the keyring will not derive", async () => {
    await seedRealKey();
    const response = await recheck(CONNECTION, { ONCUE_BROKER_KEYRING: "" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ category: "broker_failure" });
  });
});
