import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { deriveKeyring, sealCredential } from "../broker/envelope";
import { PROVIDER_ADAPTERS } from "../broker/providers/adapter";
import { runDeletion } from "../deletion/job";
import { releasedRefHash } from "../deletion/released-refs";
import { deriveInstallationRowId } from "../github/store";
import { modalTokenContext } from "../modal/envelope-context";
import { createClerkDouble } from "../test/clerk-double";
import { createGitHubDouble, githubTestSettings } from "../test/github-double";
import { createProviderDouble, type DoubleMode } from "../test/provider-double";
import { createBody } from "../test/session-world";
import {
  BRANCH_HOLDER_SQL,
  CREATING_DELETE_SQL,
  CREATING_SWEEP_BATCH,
  CREATING_SWEEP_MAX_AGE_MS,
  CREATING_SWEEP_SQL,
  handleCreateSession,
  type ObjectCaller,
  preflightModelKey,
  realSessionProbe,
  refuseHostedStandIn,
  sameBranchChoice,
  sweepCreatingSessions,
} from "./sessions";

/** A probe for ids no object ever committed a session under. */
const noSession = async () => false;

const url = "https://worker/api/sessions";

interface RawInstruction {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly unknown[];
}

// `unknown` so cases can send a number or empty string and prove the route
// refuses them.
interface RawCreateSessionRequest {
  readonly commandId: string;
  readonly instruction: RawInstruction;
  readonly fake?: { readonly scriptName: string; readonly framePacingMs: number | null };
  readonly repositoryConnectionId?: unknown;
  readonly [field: string]: unknown;
}

function requestBody(overrides: Partial<RawCreateSessionRequest> = {}): RawCreateSessionRequest {
  return {
    commandId: "cmd_1",
    instruction: { messageId: "msg_1", text: "Fix it", attachments: [] },
    ...overrides,
  };
}

async function postRequestAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  bodyText: string,
): Promise<Request> {
  const authed = await double.requestAs(subject, url);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authed.headers.get("cookie") ?? "" },
    body: bodyText,
  });
}

async function postJsonAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  body: unknown,
): Promise<Request> {
  return postRequestAs(double, subject, JSON.stringify(body));
}

function okCaller(): ObjectCaller {
  return {
    async callCreate(sessionId) {
      return Response.json({ sessionId, runId: "run_1", plan: "accept" });
    },
  };
}

function capturingCaller(): { caller: ObjectCaller; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const caller: ObjectCaller = {
    async callCreate(sessionId, body) {
      bodies.push(body);
      return Response.json({ sessionId, runId: "run_1", plan: "accept" });
    },
  };
  return { caller, bodies };
}

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_ENV?: string;
  ONCUE_BROKER_KEYRING?: string;
  ONCUE_SANDBOX_CONTROLLER_ORIGIN?: string;
  ONCUE_SANDBOX_CONTROLLER_TOKEN?: string;
  ONCUE_MODEL_ALLOWLIST?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

/** What a deployment that can really create sandboxes has set. */
const CONTROLLER_CONFIGURED = {
  ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run",
  ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
} as const;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM session_index").run();
  await env.DB.prepare("DELETE FROM model_connection").run();
  await env.DB.prepare("DELETE FROM modal_connection").run();
});

const CONNECTED_SUBJECT = "user_with_a_key";

// Registers the subject and gives its workspace one active connection, doing
// the two inserts `registerActor` would, since the connection needs the
// workspace first.
async function giveWorkspaceAConnection(
  subject: string,
  connectionId: string,
  status: string = "active",
): Promise<string> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  const now = "2026-09-05T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, now, now),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, now, now),
  ]);
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, 'anthropic', 'api_key', 'oncue1.1.n.c', ?, '...0001', NULL, ?, ?, ?)`,
  )
    .bind(connectionId, workspaceId, status, now, now, now)
    .run();
  return workspaceId;
}

describe("the model a session is created with", () => {
  // A workspace with no key still submits on the fake driver locally; a hosted
  // Worker refuses it (see "a hosted deployment's refusal of stand-ins").
  it("uses the fake driver's model when the workspace has no connection", async () => {
    const double = await createClerkDouble();
    const allowed = "user_no_key";
    const request = await postJsonAs(double, allowed, requestBody());
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.model).toEqual({
      provider: "oncue-fake",
      modelId: "fake-driver",
      modelConnectionId: "placeholder",
      authenticationType: "api_key",
      contextWindow: null,
      effort: null,
    });
  });

  // Falling back here would run a scripted transcript for someone with real
  // provider access configured.
  it("refuses a request that names no connection once the workspace has one", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const request = await postJsonAs(double, allowed, requestBody());

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      okCaller(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      reason: "connection_required",
    });
  });

  it("records the real model when the request names an active connection", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const request = await postJsonAs(double, allowed, {
      ...requestBody(),
      modelConnectionId: "mc_1",
    });
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.model).toEqual({
      provider: "anthropic",
      modelId: PROVIDER_ADAPTERS.anthropic.defaultModel.modelId,
      modelConnectionId: "mc_1",
      authenticationType: "api_key",
      contextWindow: PROVIDER_ADAPTERS.anthropic.defaultModel.contextWindow,
      effort: PROVIDER_ADAPTERS.anthropic.defaultModel.defaultEffort,
    });
  });

  it("records the model and effort the request names", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const request = await postJsonAs(double, allowed, {
      ...requestBody(),
      modelConnectionId: "mc_1",
      modelId: "claude-sonnet-5",
      effort: "xhigh",
    });
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    expect(bodies[0]?.model).toMatchObject({ modelId: "claude-sonnet-5", effort: "xhigh" });
  });

  it("answers 400 for a model off the catalog and for an effort the model does not document", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    for (const [extra, reason] of [
      [{ modelId: "gpt-6-sol" }, "model_unavailable"],
      [{ effort: "none" }, "effort_unsupported"],
    ] as const) {
      const request = await postJsonAs(double, allowed, {
        ...requestBody(),
        modelConnectionId: "mc_1",
        ...extra,
      });
      const response = await handleCreateSession(
        request,
        envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
        capturingCaller().caller,
        createAllowlistCache(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request", reason });
    }
  });

  it("refuses a model the local cost guard does not list, naming what it allows", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const guarded = envWith({
      CLERK_JWT_KEY: double.jwtKey,
      ONCUE_USER_ALLOWLIST: allowed,
      ONCUE_MODEL_ALLOWLIST: "claude-sonnet-4-5-20250929",
    });
    // The recommended model is not on the list.
    const refused = await handleCreateSession(
      await postJsonAs(double, allowed, { ...requestBody(), modelConnectionId: "mc_1" }),
      guarded,
      capturingCaller().caller,
      createAllowlistCache(),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "invalid_request",
      reason: "model_not_allowed",
      allowed: ["claude-sonnet-4-5-20250929"],
    });
    // The listed one starts, at null effort because it has no effort parameter.
    const { caller, bodies } = capturingCaller();
    const started = await handleCreateSession(
      await postJsonAs(double, allowed, {
        ...requestBody(),
        modelConnectionId: "mc_1",
        modelId: "claude-sonnet-4-5-20250929",
      }),
      guarded,
      caller,
      createAllowlistCache(),
    );
    expect(started.status).toBe(201);
    expect(bodies[0]?.model).toMatchObject({ modelId: "claude-sonnet-4-5-20250929", effort: null });
  });

  it("runs OpenCode when the request names no harness, and records it on the index and the object", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      await postJsonAs(double, allowed, { ...requestBody(), modelConnectionId: "mc_1" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    expect(bodies[0]?.runtime).toEqual({ id: "opencode", version: "1.18.30" });
    const row = await env.DB.prepare("SELECT runtime FROM session_index").first<{
      runtime: string;
    }>();
    expect(row?.runtime).toBe("opencode");
  });

  it.each([
    [
      "a harness the catalog does not name",
      { runtime: "cursor" },
      {},
      400,
      "runtime_unknown_runtime",
    ],
    [
      "a harness the operator has not allowed",
      { runtime: "opencode" },
      { ONCUE_RUNTIME_ALLOWLIST: "something-else" },
      403,
      "runtime_not_allowed",
    ],
    [
      "a harness the allowlist names but the image does not install",
      { runtime: "claude" },
      { ONCUE_RUNTIME_ALLOWLIST: "opencode,claude" },
      400,
      "runtime_not_in_image",
    ],
  ])("refuses %s, and creates nothing", async (_name, extra, envExtra, status, reason) => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      await postJsonAs(double, allowed, { ...requestBody(), modelConnectionId: "mc_1", ...extra }),
      {
        ...envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
        ...envExtra,
      } as Env,
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: "invalid_request", reason });
    expect(bodies).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM session_index").first()).toEqual({
      n: 0,
    });
  });

  it("answers 403 for a connection id that is not the caller's", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_1");
    const request = await postJsonAs(double, allowed, {
      ...requestBody(),
      modelConnectionId: "mc_someone_elses",
    });

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      okCaller(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(403);
  });

  it("answers 409 for the caller's own connection that is no longer active", async () => {
    const double = await createClerkDouble();
    const allowed = CONNECTED_SUBJECT;
    await giveWorkspaceAConnection(allowed, "mc_dead", "invalid");
    const request = await postJsonAs(double, allowed, {
      ...requestBody(),
      modelConnectionId: "mc_dead",
    });

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      okCaller(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "not_active" });
  });

  it("answers 400 for a connection id that is not a string", async () => {
    const double = await createClerkDouble();
    const allowed = "user_no_key";
    const request = await postJsonAs(double, allowed, {
      ...requestBody(),
      modelConnectionId: 7,
    });

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: allowed }),
      okCaller(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "malformed" });
  });
});

describe("checking the model key before a session is created", () => {
  const SUBJECT = "user_key_check";
  const CONNECTION = "mc_checked";
  const LONG_AGO = "2026-09-05T00:00:00.000Z";
  /** Short enough for the secret scanner, distinctive enough to search for. */
  const KEY = "sk-fake-preflight01";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A connection whose key really opens, as a connected workspace's does.
  async function giveWorkspaceARealKey(
    options: { provider?: "anthropic" | "openai"; lastValidatedAt?: string; status?: string } = {},
  ): Promise<string> {
    const provider = options.provider ?? "anthropic";
    const userId = await deriveUserId(SUBJECT);
    const workspaceId = await deriveWorkspaceId(SUBJECT);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(userId, LONG_AGO, LONG_AGO),
      env.DB.prepare(
        "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(workspaceId, userId, LONG_AGO, LONG_AGO),
    ]);
    const keyringResult = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");
    if (keyringResult.kind !== "ok") {
      throw new Error("the test runner always configures a keyring");
    }
    const sealed = await sealCredential(
      keyringResult.keyring,
      { connectionId: CONNECTION, workspaceId, provider },
      KEY,
    );
    await env.DB.prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference,
         status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'api_key', ?, ?, '...ht01', NULL, ?, ?, ?)`,
    )
      .bind(
        CONNECTION,
        workspaceId,
        provider,
        sealed,
        options.status ?? "active",
        options.lastValidatedAt ?? LONG_AGO,
        LONG_AGO,
        LONG_AGO,
      )
      .run();
    return workspaceId;
  }

  async function create(
    overrides: Parameters<typeof envWith>[0] = {},
  ): Promise<{ response: Response; created: number }> {
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      await postJsonAs(double, SUBJECT, { ...requestBody(), modelConnectionId: CONNECTION }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT, ...overrides }),
      caller,
      createAllowlistCache(),
    );
    return { response, created: bodies.length };
  }

  async function connectionRow(): Promise<{ status: string; last_validated_at: string }> {
    const row = await env.DB.prepare(
      "SELECT status, last_validated_at FROM model_connection WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .first<{ status: string; last_validated_at: string }>();
    if (row === null) {
      throw new Error("expected the connection row");
    }
    return row;
  }

  it.each(["anthropic", "openai"] as const)(
    "refuses the create, marks the connection, and makes nothing when %s rejects the key",
    async (provider) => {
      await giveWorkspaceARealKey({ provider });
      const providerDouble = createProviderDouble(provider, "auth_failed");
      vi.stubGlobal("fetch", providerDouble.fetchImpl);

      const { response, created } = await create();

      expect(response.status).toBe(409);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: "model_key_rejected",
        provider,
        modelConnectionId: CONNECTION,
      });
      expect(text.includes(KEY)).toBe(false);
      // Nothing was requested of the session object, and no row was written.
      expect(created).toBe(0);
      const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_index").first<{
        n: number;
      }>();
      expect(sessions?.n).toBe(0);
      expect((await connectionRow()).status).toBe("invalid");
      expect(providerDouble.calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/v1/models",
      ]);
    },
  );

  it("starts the session and records the validation when the provider accepts the key", async () => {
    await giveWorkspaceARealKey();
    const providerDouble = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);

    const { response, created } = await create();

    expect(response.status).toBe(201);
    expect(created).toBe(1);
    expect(providerDouble.calls).toHaveLength(1);
    const row = await connectionRow();
    expect(row.status).toBe("active");
    expect(row.last_validated_at > LONG_AGO).toBe(true);
  });

  it.each([
    "rate_limited",
    "overloaded",
    "usage_limit",
    "model_unavailable",
  ] as const satisfies readonly DoubleMode[])(
    "starts anyway when the provider answers %s, which says nothing about the key",
    async (mode) => {
      await giveWorkspaceARealKey();
      vi.stubGlobal("fetch", createProviderDouble("anthropic", mode).fetchImpl);

      const { response, created } = await create();

      expect(response.status).toBe(201);
      expect(created).toBe(1);
      expect(await connectionRow()).toEqual({ status: "active", last_validated_at: LONG_AGO });
    },
  );

  it("starts anyway when the provider cannot be reached", async () => {
    await giveWorkspaceARealKey();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no route to provider")));

    const { response } = await create();

    expect(response.status).toBe(201);
    expect(await connectionRow()).toEqual({ status: "active", last_validated_at: LONG_AGO });
  });

  it("does not ask the provider about a key validated a moment ago", async () => {
    await giveWorkspaceARealKey({ lastValidatedAt: new Date(Date.now() - 60_000).toISOString() });
    const providerDouble = createProviderDouble("anthropic", "auth_failed");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);

    const { response } = await create();

    expect(response.status).toBe(201);
    expect(providerDouble.calls).toEqual([]);
    expect((await connectionRow()).status).toBe("active");
  });

  it("asks once for sessions started one after another", async () => {
    await giveWorkspaceARealKey();
    const providerDouble = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);

    expect((await create()).response.status).toBe(201);
    expect((await create()).response.status).toBe(201);

    expect(providerDouble.calls).toHaveLength(1);
  });

  it("starts without a check when no keyring can open the key", async () => {
    await giveWorkspaceARealKey();
    const providerDouble = createProviderDouble("anthropic", "auth_failed");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);

    const { response } = await create({ ONCUE_BROKER_KEYRING: "" });

    expect(response.status).toBe(201);
    expect(providerDouble.calls).toEqual([]);
  });

  it("asks no provider anything for a workspace on the fake driver", async () => {
    const providerDouble = createProviderDouble("anthropic", "auth_failed");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);
    const double = await createClerkDouble();
    const subject = "user_no_key_no_check";

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(providerDouble.calls).toEqual([]);
  });

  it("does not reach the provider while admission is stopped", async () => {
    await giveWorkspaceARealKey();
    const providerDouble = createProviderDouble("anthropic", "auth_failed");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);
    await env.DB.prepare(
      "UPDATE platform_control SET run_admission = 'stopped' WHERE id = 1",
    ).run();
    try {
      const { response } = await create();
      expect(response.status).toBe(503);
    } finally {
      await env.DB.prepare("UPDATE platform_control SET run_admission = 'open' WHERE id = 1").run();
    }
    expect(providerDouble.calls).toEqual([]);
    expect((await connectionRow()).status).toBe("active");
  });

  // `resolveModel` has already answered for these when the route runs; the
  // check reads the row again, so a revoke in between is still refused.
  it("answers as an inactive connection when the key was revoked or is gone by the time it is checked", async () => {
    const workspaceId = await giveWorkspaceARealKey({ status: "revoked" });
    const providerDouble = createProviderDouble("anthropic");
    vi.stubGlobal("fetch", providerDouble.fetchImpl);

    for (const modelConnectionId of [CONNECTION, "mc_gone"]) {
      const refusal = await preflightModelKey(envWith({}), workspaceId, {
        provider: "anthropic",
        modelConnectionId,
      });
      expect(refusal?.status).toBe(409);
      expect(await refusal?.json()).toEqual({ error: "invalid_request", reason: "not_active" });
    }
    expect(providerDouble.calls).toEqual([]);
  });
});

describe("handleCreateSession", () => {
  it("denies an unauthenticated request", async () => {
    const response = await handleCreateSession(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      }),
      env,
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
  });

  it("denies a verified subject that is not on the allowlist", async () => {
    const double = await createClerkDouble();
    const request = await postJsonAs(double, "user_blocked", requestBody());

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "someone_else" }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects malformed JSON with 400 malformed_json", async () => {
    const subject = "user_sends_garbage";
    const double = await createClerkDouble();
    const request = await postRequestAs(double, subject, "{not json");

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed_json" });
  });

  it("rejects a JSON body that is not an object with reason not_an_object", async () => {
    const subject = "user_sends_an_array";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, [1, 2, 3]);

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "not_an_object" });
  });

  it("rejects a missing commandId with reason command_id", async () => {
    const subject = "user_omits_command_id";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, {
      instruction: { messageId: "msg_1", text: "Fix it", attachments: [] },
    });

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "command_id" });
  });

  it("rejects an instruction the protocol schema rejects, with reason instruction", async () => {
    const subject = "user_sends_bad_instruction";
    const double = await createClerkDouble();
    const request = await postJsonAs(
      double,
      subject,
      requestBody({
        instruction: { messageId: "msg_1", attachments: [] } as unknown as RawInstruction,
      }),
    );

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string; reason: string };
    expect(result.error).toBe("invalid_request");
    expect(result.reason).toBe("instruction");
  });

  it("refuses a fake driver hint from a hosted environment with reason fake_driver", async () => {
    const subject = "user_tries_fake_hosted";
    const double = await createClerkDouble();
    const request = await postJsonAs(
      double,
      subject,
      requestBody({ fake: { scriptName: "seven-event", framePacingMs: 50 } }),
    );

    const response = await handleCreateSession(
      request,
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_ENV: "hosted",
      }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "fake_driver" });
  });

  it("refuses a malformed fake driver hint locally with reason fake_driver", async () => {
    const subject = "user_sends_bad_fake_hint";
    const double = await createClerkDouble();
    const request = await postJsonAs(
      double,
      subject,
      requestBody({ fake: { scriptName: "not-a-real-script", framePacingMs: 50 } }),
    );

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason: "fake_driver" });
  });

  it("honours a valid fake driver hint locally, overriding the default script and pacing", async () => {
    const subject = "user_honours_fake_hint_locally";
    const { caller, bodies } = capturingCaller();
    const double = await createClerkDouble();
    const request = await postJsonAs(
      double,
      subject,
      requestBody({ fake: { scriptName: "long-stream", framePacingMs: 5 } }),
    );

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.scriptName).toBe("long-stream");
    expect(bodies[0]?.framePacingMs).toBe(5);
  });

  it("falls back to the seven-event default at 120ms when no fake hint is given", async () => {
    const subject = "user_gets_the_default_driver";
    const { caller, bodies } = capturingCaller();
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    expect(bodies[0]?.scriptName).toBe("seven-event");
    expect(bodies[0]?.framePacingMs).toBe(120);
  });

  it("carries the user's request to skip the required checks to the object, false when absent", async () => {
    const subject = "user_skips_required_checks";
    const { caller, bodies } = capturingCaller();
    const double = await createClerkDouble();
    const env = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });

    const skipping = await handleCreateSession(
      await postJsonAs(double, subject, requestBody({ skipRequiredChecks: true })),
      env,
      caller,
      createAllowlistCache(),
    );
    expect(skipping.status).toBe(201);
    expect(bodies[0]?.skipRequiredChecks).toBe(true);

    const plain = await handleCreateSession(
      await postJsonAs(double, subject, requestBody({ commandId: "cmd_2" })),
      env,
      caller,
      createAllowlistCache(),
    );
    expect(plain.status).toBe(201);
    expect(bodies[1]?.skipRequiredChecks).toBe(false);

    const refused = await handleCreateSession(
      await postJsonAs(double, subject, requestBody({ skipRequiredChecks: "yes" })),
      env,
      caller,
      createAllowlistCache(),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "invalid_request",
      reason: "skip_required_checks",
    });
    expect(bodies).toHaveLength(2);
  });

  it("claims the first message's uploads for the new session and hands the object the Worker's record of each (composer attachments)", async () => {
    const subject = "user_attaches_on_home";
    const workspaceId = await deriveWorkspaceId(subject);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
         content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
       VALUES (?, ?, 'u', NULL, 'screen.png', 'image/png', 'image', 12, 'x', ?, '2026-09-27T00:00:00.000Z', NULL)`,
    )
      .bind(id, workspaceId, `workspaces/${workspaceId}/attachments/${id}`)
      .run();
    const { caller, bodies } = capturingCaller();
    const double = await createClerkDouble();
    const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });
    const claimed = {
      artifactId: id,
      kind: "file",
      contentType: "text/html",
      byteSize: 1,
      label: "not the name",
    };

    const response = await handleCreateSession(
      await postJsonAs(
        double,
        subject,
        requestBody({
          commandId: "cmd_attach",
          instruction: { messageId: "msg_1", text: "Look", attachments: [claimed] },
        }),
      ),
      testEnv,
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    const sent = bodies[0] as { instruction: { attachments: unknown[] } };
    expect(sent.instruction.attachments).toEqual([
      { artifactId: id, kind: "file", contentType: "image/png", byteSize: 12, label: "screen.png" },
    ]);
    const row = await env.DB.prepare(
      "SELECT session_id FROM message_attachment WHERE attachment_id = ?",
    )
      .bind(id)
      .first<{ session_id: string }>();
    expect(row?.session_id).toBe(sessionId);

    // One the workspace never uploaded refuses the launch and creates nothing.
    const refused = await handleCreateSession(
      await postJsonAs(
        double,
        subject,
        requestBody({
          commandId: "cmd_attach_missing",
          instruction: {
            messageId: "msg_1",
            text: "Look",
            attachments: [{ ...claimed, artifactId: "att_never_uploaded" }],
          },
        }),
      ),
      testEnv,
      caller,
      createAllowlistCache(),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "invalid_request",
      reason: "attachments",
      detail: "an attachment is not available; upload it again",
    });
    expect(bodies).toHaveLength(1);
  });

  it("mints a UUIDv5-shaped session id, inserts a creating row with the VERIFIED workspace id and a derived title, and returns 201 on success", async () => {
    const subject = "user_creates_session";
    const double = await createClerkDouble();
    const request = await postJsonAs(
      double,
      subject,
      requestBody({
        instruction: { messageId: "msg_1", text: "Fix the bug\nmore detail", attachments: [] },
      }),
    );

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    const result = (await response.json()) as { sessionId: string; plan: string };
    expect(result.plan).toBe("accept");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const row = await env.DB.prepare(
      "SELECT state, workspace_id, title FROM session_index WHERE session_id = ?",
    )
      .bind(result.sessionId)
      .first<{ state: string; workspace_id: string; title: string | null }>();
    expect(row).toEqual({
      state: "creating",
      workspace_id: await deriveWorkspaceId(subject),
      title: "Fix the bug",
    });
  });

  it("derives the same session id for a retry with the same commandId, and the object's already_processed answer becomes a 200", async () => {
    const subject = "user_retries_create";
    let calls = 0;
    const idempotentCaller: ObjectCaller = {
      async callCreate(sessionId) {
        calls += 1;
        const plan = calls === 1 ? "accept" : "already_processed";
        return Response.json({ sessionId, runId: "run_1", plan });
      },
    };
    const double = await createClerkDouble();
    const body = requestBody({ commandId: "cmd_retry_1" });

    const first = await handleCreateSession(
      await postJsonAs(double, subject, body),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      idempotentCaller,
      createAllowlistCache(),
    );
    expect(first.status).toBe(201);
    const firstResult = (await first.json()) as { sessionId: string; plan: string };
    expect(firstResult.plan).toBe("accept");

    const second = await handleCreateSession(
      await postJsonAs(double, subject, body),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      idempotentCaller,
      createAllowlistCache(),
    );
    expect(second.status).toBe(200);
    const secondResult = (await second.json()) as { sessionId: string; plan: string };
    expect(secondResult.plan).toBe("already_processed");
    expect(secondResult.sessionId).toBe(firstResult.sessionId);
  });

  it("ignores any body-supplied workspaceId or ownerUserId, using the verified actor instead", async () => {
    const subject = "user_cannot_forge_workspace";
    const double = await createClerkDouble();
    const forgedBody = {
      ...requestBody(),
      workspaceId: "wsp_attacker_controlled",
      ownerUserId: "usr_attacker_controlled",
    };
    const request = await postJsonAs(double, subject, forgedBody);

    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(201);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.workspaceId).toBe(await deriveWorkspaceId(subject));
    expect(bodies[0]?.ownerUserId).toBe(await deriveUserId(subject));
  });

  it("fails closed with the literal 'admission stopped' body when run admission is stopped", async () => {
    await env.DB.prepare(
      "UPDATE platform_control SET run_admission = 'stopped' WHERE id = 1",
    ).run();

    const subject = "user_admission_stopped";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(503);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("admission stopped");

    await env.DB.prepare("UPDATE platform_control SET run_admission = 'open' WHERE id = 1").run();
  });

  it("reports another refusal reason distinctly from admission_stopped", async () => {
    await env.DB.prepare(
      "UPDATE platform_control SET workspace_concurrent_sandbox_cap = 0 WHERE id = 1",
    ).run();

    const subject = "user_workspace_cap";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      okCaller(),
      createAllowlistCache(),
    );
    expect(response.status).toBe(503);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("admission refused: workspace_cap_reached");

    await env.DB.prepare(
      "UPDATE platform_control SET workspace_concurrent_sandbox_cap = 3 WHERE id = 1",
    ).run();
  });

  it("leaves the creating row in place when the call to the object throws, and the sweep later removes it (step-3 failure)", async () => {
    const subject = "user_object_throws";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());
    const throwingCaller: ObjectCaller = {
      async callCreate() {
        throw new Error("network error reaching the object");
      },
    };

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      throwingCaller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(502);
    const result = (await response.json()) as { sessionId: string; error: string };
    expect(result.error).toBe("failed to reach the session object");

    const beforeSweep = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
      .bind(result.sessionId)
      .first<{ state: string }>();
    expect(beforeSweep).toEqual({ state: "creating" });

    // The row is fresh, so a sweep "now" does not remove it yet.
    const removedNow = await sweepCreatingSessions(env.DB, noSession, new Date());
    expect(removedNow).toBe(0);
    const stillThere = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
      .bind(result.sessionId)
      .first<{ state: string }>();
    expect(stillThere).toEqual({ state: "creating" });

    // Sweeping from far enough in the future age it past the bounded window.
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const removedLater = await sweepCreatingSessions(env.DB, noSession, farFuture);
    expect(removedLater).toBe(1);
    const afterSweep = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
      .bind(result.sessionId)
      .first<{ state: string }>();
    expect(afterSweep).toBeNull();
  });

  it("answers 410 and keeps no row when a delete reached the session's object first", async () => {
    const subject = "user_object_tombstoned";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());
    const tombstoned: ObjectCaller = {
      async callCreate(sessionId) {
        return Response.json({ sessionId, runId: "run_x", plan: "deleted" });
      },
    };

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      tombstoned,
      createAllowlistCache(),
    );

    expect(response.status).toBe(410);
    const result = (await response.json()) as { sessionId: string; error: string };
    expect(result.error).toBe("session_deleted");
    expect(
      await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
        .bind(result.sessionId)
        .first(),
    ).toBeNull();
  });

  it("hands a refused create's uploads back only when its own row went, never those of a session still being deleted", async () => {
    const subject = "user_retries_deleted";
    const workspaceId = await deriveWorkspaceId(subject);
    const double = await createClerkDouble();
    const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });
    const upload = async (): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
           content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
         VALUES (?, ?, 'u', NULL, 'screen.png', 'image/png', 'image', 12, 'x', ?, '2026-09-27T00:00:00.000Z', NULL)`,
      )
        .bind(id, workspaceId, `workspaces/${workspaceId}/attachments/${id}`)
        .run();
      return id;
    };
    const create = async (commandId: string, attachmentId: string, caller: ObjectCaller) =>
      handleCreateSession(
        await postJsonAs(
          double,
          subject,
          requestBody({
            commandId,
            instruction: {
              messageId: "msg_1",
              text: "Look",
              attachments: [
                {
                  artifactId: attachmentId,
                  kind: "file",
                  contentType: "text/html",
                  byteSize: 1,
                  label: "not the name",
                },
              ],
            },
          }),
        ),
        testEnv,
        caller,
        createAllowlistCache(),
      );
    const claimedBy = async (attachmentId: string) =>
      (
        await env.DB.prepare("SELECT session_id FROM message_attachment WHERE attachment_id = ?")
          .bind(attachmentId)
          .first<{ session_id: string | null }>()
      )?.session_id;
    const tombstoned: ObjectCaller = {
      async callCreate(sessionId) {
        return Response.json({ sessionId, runId: "run_x", plan: "deleted" });
      },
    };

    // A session that was made, then deleted: its row and its uploads are the deletion job's.
    const kept = await upload();
    const made = await create("cmd_retry_deleted", kept, capturingCaller().caller);
    expect(made.status).toBe(201);
    const { sessionId } = (await made.json()) as { sessionId: string };
    await env.DB.prepare("UPDATE session_index SET state = 'deletion_pending' WHERE session_id = ?")
      .bind(sessionId)
      .run();

    const retried = await create("cmd_retry_deleted", kept, tombstoned);

    expect(retried.status).toBe(410);
    expect(await claimedBy(kept)).toBe(sessionId);
    expect(
      await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
        .bind(sessionId)
        .first(),
    ).toEqual({ state: "deletion_pending" });

    // A create that made nothing: its own row goes, and its uploads go back to the workspace.
    const released = await upload();
    const refused = await create("cmd_never_made", released, tombstoned);

    expect(refused.status).toBe(410);
    expect(await claimedBy(released)).toBeNull();
  });

  it("reports a 502 when the object answers but rejects creation", async () => {
    const subject = "user_object_rejects";
    const double = await createClerkDouble();
    const request = await postJsonAs(double, subject, requestBody());
    const rejectingCaller: ObjectCaller = {
      async callCreate() {
        return Response.json({ error: "nope" }, { status: 500 });
      },
    };

    const response = await handleCreateSession(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      rejectingCaller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(502);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("the session object rejected creation");
  });
});

describe("sweepCreatingSessions", () => {
  const OLD = "2026-01-01T00:00:00.000Z";
  async function seed(sessionId: string, state: string, createdAt: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
       VALUES (?, 'ws_sweep', NULL, ?, ?, ?)`,
    )
      .bind(sessionId, state, createdAt, createdAt)
      .run();
  }
  async function remaining(): Promise<string[]> {
    const rows = await env.DB.prepare(
      "SELECT session_id FROM session_index WHERE workspace_id = 'ws_sweep' ORDER BY session_id",
    ).all<{ session_id: string }>();
    return rows.results.map((row) => row.session_id);
  }

  it("returns 0 when there is nothing to sweep", async () => {
    const removed = await sweepCreatingSessions(
      env.DB,
      noSession,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    expect(removed).toBe(0);
  });

  it("removes only stale creating rows, never a session that left creating", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    await seed("ses_stale", "creating", OLD);
    await seed("ses_fresh", "creating", new Date(now.getTime() - 60_000).toISOString());
    await seed("ses_active", "active", OLD);
    await seed("ses_archived", "archived", OLD);
    await seed("ses_deleting", "deletion_pending", OLD);

    expect(await sweepCreatingSessions(env.DB, noSession, now)).toBe(1);
    expect(await remaining()).toEqual(["ses_active", "ses_archived", "ses_deleting", "ses_fresh"]);
  });

  // The window is an hour, so a session whose first projection a D1 outage
  // delayed keeps its row unless the outage lasted that long.
  it("keeps a creating row for an hour and sweeps it after", async () => {
    expect(CREATING_SWEEP_MAX_AGE_MS).toBe(60 * 60 * 1000);
    const now = new Date("2026-09-27T12:00:00.000Z");
    const minutesAgo = (minutes: number) =>
      new Date(now.getTime() - minutes * 60 * 1000).toISOString();
    await seed("ses_59_minutes", "creating", minutesAgo(59));
    await seed("ses_61_minutes", "creating", minutesAgo(61));

    expect(await sweepCreatingSessions(env.DB, noSession, now)).toBe(1);
    expect(await remaining()).toEqual(["ses_59_minutes"]);
  });

  it("deletes at most one batch per run, oldest first, and drains a backlog over runs", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    const extra = 5;
    for (let index = 0; index < CREATING_SWEEP_BATCH + extra; index += 1) {
      // Oldest first by created_at; the ids sort the same way.
      const at = new Date(Date.parse(OLD) + index * 1000).toISOString();
      await seed(`ses_${String(index).padStart(4, "0")}`, "creating", at);
    }

    expect(await sweepCreatingSessions(env.DB, noSession, now)).toBe(CREATING_SWEEP_BATCH);
    const left = await remaining();
    expect(left).toHaveLength(extra);
    // The newest survived the first run: the batch took the oldest.
    expect(left[0]).toBe(`ses_${String(CREATING_SWEEP_BATCH).padStart(4, "0")}`);

    expect(await sweepCreatingSessions(env.DB, noSession, now)).toBe(extra);
    expect(await remaining()).toEqual([]);
  });

  it("keeps a stale row whose object committed a session, and one whose object cannot answer", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    await seed("ses_committed", "creating", OLD);
    await seed("ses_unreachable", "creating", OLD);
    await seed("ses_never", "creating", OLD);
    const asked: string[] = [];
    const probe = async (sessionId: string) => {
      asked.push(sessionId);
      if (sessionId === "ses_unreachable") {
        throw new Error("the object did not answer");
      }
      return sessionId === "ses_committed";
    };

    expect(await sweepCreatingSessions(env.DB, probe, now)).toBe(1);
    expect(await remaining()).toEqual(["ses_committed", "ses_unreachable"]);
    expect(asked.sort()).toEqual(["ses_committed", "ses_never", "ses_unreachable"]);
  });

  it("asks the real object: one that committed keeps its row, an id never used loses it", async () => {
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await seed("ses_probe_real_never", "creating", OLD);
    await seed("ses_probe_real_committed", "creating", OLD);
    await runInDurableObject(
      env.SESSION.get(env.SESSION.idFromName("ses_probe_real_committed")),
      async (instance) => {
        await instance.createSession(
          createBody("ses_probe_real_committed", { workspaceId: "ws_sweep" }),
        );
      },
    );
    // Its first projection would have moved the row; put it back to stuck.
    await env.DB.prepare(
      "UPDATE session_index SET state = 'creating', last_projected_sequence = 0 WHERE session_id = ?",
    )
      .bind("ses_probe_real_committed")
      .run();

    expect(await sweepCreatingSessions(env.DB, realSessionProbe(env), now)).toBe(1);
    expect(await remaining()).toEqual(["ses_probe_real_committed"]);
  });

  it("treats an object that answers with an error as unable to tell", async () => {
    const failing = {
      ...env,
      SESSION: {
        idFromName: () => "x",
        get: () => ({ fetch: async () => new Response("no", { status: 500 }) }),
      },
    } as unknown as Env;
    await expect(realSessionProbe(failing)("ses_any")).rejects.toThrow("answered 500");
  });

  // Timer work must be bounded and indexed: SQLite's plan shows the select
  // walks the partial index and the delete finds rows by key.
  it("reads through the partial creating index and deletes by primary key", async () => {
    const plan = async (sql: string, ...params: unknown[]) =>
      (
        await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...params)
          .all<{ detail: string }>()
      ).results.map((row) => row.detail);
    const select = await plan(CREATING_SWEEP_SQL, OLD, CREATING_SWEEP_BATCH);
    const remove = await plan(CREATING_DELETE_SQL, "ses_x");

    expect(select.some((detail) => detail.includes("idx_session_index_creating_sweep"))).toBe(true);
    expect(remove.some((detail) => /PRIMARY KEY|sqlite_autoindex_session_index/.test(detail))).toBe(
      true,
    );
    expect([...select, ...remove].filter((detail) => /^SCAN session_index$/.test(detail))).toEqual(
      [],
    );
  });
});

// Record 07 at the route. Cases seed a real installation and repository
// connection and reach GitHub through `worker/test/github-double.ts` via a
// stubbed global `fetch`. A request naming no repository behaves as before.
const GITHUB_ENV = {
  ...(await githubTestSettings()),
  ONCUE_GITHUB_API_ORIGIN: "https://github.double",
};

describe("creating a session with a repository", () => {
  const BRANCH_SUBJECT = "user_with_a_repo";
  const INSTALLATION_ID = 4001;
  const REPOSITORY_ID = 501;
  const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  const NOW = "2026-09-05T00:00:00.000Z";

  async function seedRepository(
    subject: string,
    options: {
      repositoryStatus?: string;
      installationStatus?: string;
      repositoryConnectionId?: string;
    } = {},
  ): Promise<{ workspaceId: string; repositoryConnectionId: string }> {
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
    const rowId = await deriveInstallationRowId(workspaceId, INSTALLATION_ID);
    // `last_verified_at` is NOW-as-in-the-test's clock, so `verifyInstallation`
    // takes its inside-the-window path and makes no network call. The refresh
    // path has its own coverage in `worker/github/install.test.ts`.
    await env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference, refresh_token_reference,
         user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 42, 'acme', 'Organization', ?, 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
    )
      .bind(
        rowId,
        workspaceId,
        INSTALLATION_ID,
        options.installationStatus ?? "active",
        new Date(Date.now() + 3_600_000).toISOString(),
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
        NOW,
        NOW,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme/widgets', 'main', ?, ?, ?)`,
    )
      .bind(
        options.repositoryConnectionId ?? "rc_1",
        workspaceId,
        rowId,
        REPOSITORY_ID,
        options.repositoryStatus ?? "verified",
        NOW,
        NOW,
      )
      .run();
    return { workspaceId, repositoryConnectionId: options.repositoryConnectionId ?? "rc_1" };
  }

  function githubDouble(): ReturnType<typeof createGitHubDouble> {
    return createGitHubDouble({
      users: [{ id: 42, login: "octocat" }],
      installations: [
        {
          installationId: INSTALLATION_ID,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue-local",
          visibleToUserIds: [42],
        },
      ],
      repositoriesByInstallation: {
        [INSTALLATION_ID]: [{ id: REPOSITORY_ID, fullName: "acme/widgets", defaultBranch: "main" }],
      },
      refsByRepository: { "acme/widgets": { main: BASE_SHA } },
    });
  }

  async function create(
    body: Record<string, unknown>,
    overrides: Record<string, string | undefined> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const double = await createClerkDouble();
    const request = await postJsonAs(double, BRANCH_SUBJECT, body);
    const response = await handleCreateSession(
      request,
      {
        ...env,
        ...GITHUB_ENV,
        ...overrides,
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: BRANCH_SUBJECT,
      } as unknown as Env,
      okCaller(),
      createAllowlistCache(),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** The same request, returning what the session object was handed. */
  async function createCapturing(
    body: Record<string, unknown>,
  ): Promise<{ status: number; sent: Record<string, unknown> | undefined }> {
    const double = await createClerkDouble();
    const request = await postJsonAs(double, BRANCH_SUBJECT, body);
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      request,
      {
        ...env,
        ...GITHUB_ENV,
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: BRANCH_SUBJECT,
      } as unknown as Env,
      caller,
      createAllowlistCache(),
    );
    return { status: response.status, sent: bodies[0] };
  }

  beforeEach(async () => {
    await env.DB.batch([
      // First: both reference a repository connection.
      env.DB.prepare("DELETE FROM repository_secret_disclosure"),
      env.DB.prepare("DELETE FROM development_secret"),
      env.DB.prepare("DELETE FROM repository_connection"),
      env.DB.prepare("DELETE FROM github_installation"),
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records no branch at the start: the row holds the base commit and a null task branch", async () => {
    await seedRepository(BRANCH_SUBJECT);
    const double = githubDouble();
    vi.stubGlobal("fetch", double.fetchImpl);

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }));

    expect(result.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT repository_connection_id, task_branch, base_commit_sha FROM session_index WHERE session_id = ?",
    )
      .bind(result.body.sessionId)
      .first<{
        repository_connection_id: string;
        task_branch: string | null;
        base_commit_sha: string;
      }>();
    expect(row?.repository_connection_id).toBe("rc_1");
    // Record 07: the first push names the branch; nothing is created on GitHub
    // for a session that may never push.
    expect(row?.task_branch).toBeNull();
    expect(row?.base_commit_sha).toBe(BASE_SHA);
    expect(double.calls.filter((call) => call.path.endsWith("/git/refs"))).toEqual([]);
  });

  it("hands the base branch and commit to the session object, with no task branch yet", async () => {
    await seedRepository(BRANCH_SUBJECT);
    vi.stubGlobal("fetch", githubDouble().fetchImpl);
    const { caller, bodies } = capturingCaller();
    const double = await createClerkDouble();

    await handleCreateSession(
      await postJsonAs(double, BRANCH_SUBJECT, requestBody({ repositoryConnectionId: "rc_1" })),
      {
        ...env,
        ...GITHUB_ENV,
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: BRANCH_SUBJECT,
      } as unknown as Env,
      caller,
      createAllowlistCache(),
    );

    expect(bodies.at(0)?.taskBranch).toBeNull();
    expect(bodies.at(0)?.baseCommitSha).toBe(BASE_SHA);
    // The identifiers the object mints the git grant from travel too.
    expect(bodies.at(0)?.repository).toEqual({
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      fullName: "acme/widgets",
      cloneUrl: "https://github.double/acme/widgets.git",
      taskBranch: null,
      baseSha: BASE_SHA,
      // What the clone and a draft pull request need: the base branch, and this app's own origin.
      baseBranch: "main",
      appOrigin: "https://worker",
    });
  });

  // Record 07: GitHub reads an empty `repository_ids` as every repository, so
  // this asserts on what the double actually received.
  it("mints one token narrowed to that one repository, read for the project file, and revokes it", async () => {
    await seedRepository(BRANCH_SUBJECT);
    const double = githubDouble();
    vi.stubGlobal("fetch", double.fetchImpl);

    await create(requestBody({ repositoryConnectionId: "rc_1" }));

    const mints = double.calls.filter((call) => call.path.includes("access_tokens"));
    expect(mints.map((call) => call.tokenNarrowing)).toEqual([
      // The declaration is read before anything is created, with no write token:
      // the branch is pushed later under the push grant's own token.
      { repositoryIds: [REPOSITORY_ID], permissions: { contents: "read" } },
    ]);
    const revocations = double.calls.filter((call) => call.path === "/installation/token");
    expect(revocations.map((call) => call.tokenRevoked)).toEqual([true]);
  });

  describe("with a project file that declares secrets", () => {
    const FILE = "secrets:\n  required:\n    - DATABASE_URL\n  optional:\n    - STRIPE_TEST_KEY\n";

    async function declaring(saved: readonly string[]) {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      await env.DB.prepare("DELETE FROM repository_secret_disclosure").run();
      await env.DB.prepare("DELETE FROM development_secret").run();
      for (const name of saved) {
        await env.DB.prepare(
          `INSERT INTO development_secret (
             secret_id, workspace_id, repository_connection_id, name, value_reference, status, created_at, updated_at
           ) VALUES (?, ?, 'rc_1', ?, 'oncue1.1.n.v', 'active', ?, ?)`,
        )
          .bind(`dsc_${name}`, workspaceId, name, NOW, NOW)
          .run();
      }
      const double = githubDouble();
      double.setFile("acme/widgets", ".oncue/project.yaml", FILE);
      vi.stubGlobal("fetch", double.fetchImpl);
      return double;
    }

    const branchesCreated = (double: ReturnType<typeof githubDouble>) =>
      double.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs"));

    it("refuses a launch that never saw the card, and creates nothing", async () => {
      const double = await declaring(["DATABASE_URL"]);

      const created = await create(requestBody({ repositoryConnectionId: "rc_1" }));

      expect(created).toEqual({
        status: 409,
        body: { error: "secrets_disclosure", reason: "disclosure_required", baseSha: BASE_SHA },
      });
      expect(branchesCreated(double)).toEqual([]);
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_index").first();
      expect(rows).toEqual({ n: 0 });
    });

    it("launches with the card's answer and hands the object names only", async () => {
      await declaring(["DATABASE_URL", "STRIPE_TEST_KEY"]);
      const created = await createCapturing(
        requestBody({
          repositoryConnectionId: "rc_1",
          secrets: { baseSha: BASE_SHA, optional: ["STRIPE_TEST_KEY"] },
        }),
      );

      expect(created.status).toBe(201);
      expect(created.sent?.secrets).toEqual({
        baseSha: BASE_SHA,
        pinned: [
          { name: "DATABASE_URL", kind: "required", selected: true },
          { name: "STRIPE_TEST_KEY", kind: "optional", selected: true },
        ],
        missingRequired: [],
        declarationInvalid: false,
      });
      expect(JSON.stringify(created.sent)).not.toContain("oncue1.");
      const remembered = await env.DB.prepare(
        "SELECT names_json FROM repository_secret_disclosure WHERE repository_connection_id = 'rc_1'",
      ).first<{ names_json: string }>();
      expect(JSON.parse(remembered?.names_json ?? "[]")).toEqual([
        "DATABASE_URL",
        "STRIPE_TEST_KEY",
      ]);
    });

    it.each([
      ["a name the file does not declare", { optional: ["DEPLOY_KEY"] }, 400, "undeclared_name"],
      ["a name with nothing saved", { optional: ["STRIPE_TEST_KEY"] }, 400, "unsaved_name"],
    ])("refuses %s, whatever the browser claims", async (_label, answer, status, reason) => {
      const double = await declaring(["DATABASE_URL"]);
      const created = await create(
        requestBody({ repositoryConnectionId: "rc_1", secrets: { baseSha: BASE_SHA, ...answer } }),
      );
      expect(created).toMatchObject({ status, body: { reason } });
      expect(branchesCreated(double)).toEqual([]);
    });

    it("needs an explicit start-anyway when a required secret is missing, and records which", async () => {
      await declaring([]);
      const answer = { baseSha: BASE_SHA, optional: [] };
      expect(
        await create(requestBody({ repositoryConnectionId: "rc_1", secrets: answer })),
      ).toMatchObject({ status: 409, body: { reason: "missing_required" } });

      const created = await createCapturing(
        requestBody({
          repositoryConnectionId: "rc_1",
          secrets: { ...answer, startWithoutMissing: true },
        }),
      );
      expect(created.status).toBe(201);
      expect(created.sent?.secrets).toMatchObject({ missingRequired: ["DATABASE_URL"] });
    });

    it("refuses when the base moved since the card was drawn", async () => {
      const double = await declaring(["DATABASE_URL"]);
      const shown = "9".repeat(40);
      double.setFile("acme/widgets", ".oncue/project.yaml", FILE, { ref: shown });

      const created = await create(
        requestBody({ repositoryConnectionId: "rc_1", secrets: { baseSha: shown, optional: [] } }),
      );

      // Its own code, naming the tip the card should be read at again.
      expect(created).toEqual({
        status: 409,
        body: { error: "base_moved", baseSha: expect.stringMatching(/^[0-9a-f]{40}$/) },
      });
    });

    it("refuses a launch when the file cannot be read, rather than starting without the card", async () => {
      const double = await declaring([]);
      double.setFile("acme/widgets", ".oncue/project.yaml", "elsewhere", { kind: "symlink" });
      expect(await create(requestBody({ repositoryConnectionId: "rc_1" }))).toEqual({
        status: 502,
        body: { error: "secrets_unreadable" },
      });
      expect(branchesCreated(double)).toEqual([]);
    });

    it("launches without secrets when the reader refuses the file", async () => {
      const double = await declaring([]);
      double.setFile("acme/widgets", ".oncue/project.yaml", "secrets:\n  required:\n    - PATH\n");
      const created = await createCapturing(requestBody({ repositoryConnectionId: "rc_1" }));
      expect(created.status).toBe(201);
      // Not "declares nothing": the session is degraded for a file nobody could read.
      expect(created.sent?.secrets).toEqual({
        baseSha: expect.any(String),
        pinned: [],
        missingRequired: [],
        declarationInvalid: true,
      });
    });
  });

  describe("choosing the branch", () => {
    const RELEASE_SHA = "7".repeat(40);
    const FEATURE_SHA = "8".repeat(40);

    function branchesDouble(
      options: { protected?: readonly string[] } = {},
    ): ReturnType<typeof createGitHubDouble> {
      return createGitHubDouble({
        users: [{ id: 42, login: "octocat" }],
        installations: [
          {
            installationId: INSTALLATION_ID,
            account: { login: "acme", type: "Organization" },
            appSlug: "oncue-local",
            visibleToUserIds: [42],
          },
        ],
        repositoriesByInstallation: {
          [INSTALLATION_ID]: [
            { id: REPOSITORY_ID, fullName: "acme/widgets", defaultBranch: "main" },
          ],
        },
        refsByRepository: {
          "acme/widgets": {
            main: BASE_SHA,
            "release/1.4": RELEASE_SHA,
            "feature/login": FEATURE_SHA,
          },
        },
        protectedBranchesByRepository: { "acme/widgets": options.protected ?? [] },
      });
    }

    async function indexRow(sessionId: unknown) {
      return env.DB.prepare(
        "SELECT task_branch, base_branch, branch_mode, base_commit_sha FROM session_index WHERE session_id = ?",
      )
        .bind(sessionId)
        .first<{
          task_branch: string | null;
          base_branch: string | null;
          branch_mode: string | null;
          base_commit_sha: string;
        }>();
    }

    /** A session already on `branch`, in `workspaceId`, through the given connection. */
    async function holder(
      workspaceId: string,
      repositoryConnectionId: string,
      state: string,
      branch = "feature/login",
    ): Promise<void> {
      await env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, repository_connection_id, task_branch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(`ses_holder_${state}`, workspaceId, state, repositoryConnectionId, branch, NOW, NOW)
        .run();
    }

    it("starts from a chosen branch's tip and still names a new task branch at the first push", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble({ protected: ["release/1.4"] });
      vi.stubGlobal("fetch", double.fetchImpl);

      const created = await createCapturing(
        requestBody({ repositoryConnectionId: "rc_1", branch: "release/1.4" }),
      );

      expect(created.status).toBe(201);
      // A protected branch is a fine place to start from; nothing pushes to it.
      expect(created.sent?.baseCommitSha).toBe(RELEASE_SHA);
      expect(created.sent?.taskBranch).toBeNull();
      expect(created.sent?.repository).toMatchObject({
        taskBranch: null,
        baseSha: RELEASE_SHA,
        baseBranch: "release/1.4",
      });
      expect(created.sent?.repository).not.toHaveProperty("existingBranch");
      expect(await indexRow(created.sent?.sessionId)).toEqual({
        task_branch: null,
        base_branch: "release/1.4",
        branch_mode: "new_branch",
        base_commit_sha: RELEASE_SHA,
      });
    });

    it("records the default branch and a new task branch when the request names neither", async () => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const created = await createCapturing(requestBody({ repositoryConnectionId: "rc_1" }));
      expect(await indexRow(created.sent?.sessionId)).toMatchObject({
        task_branch: null,
        base_branch: "main",
        branch_mode: "new_branch",
      });
    });

    it("works directly on an existing branch: it is the task branch from creation, and a pull request targets the default", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble();
      vi.stubGlobal("fetch", double.fetchImpl);

      const created = await createCapturing(
        requestBody({
          repositoryConnectionId: "rc_1",
          branch: "feature/login",
          branchMode: "existing_branch",
        }),
      );

      expect(created.status).toBe(201);
      expect(created.sent?.taskBranch).toBe("feature/login");
      expect(created.sent?.baseCommitSha).toBe(FEATURE_SHA);
      expect(created.sent?.repository).toMatchObject({
        taskBranch: "feature/login",
        baseSha: FEATURE_SHA,
        baseBranch: "main",
        existingBranch: true,
      });
      // Written with the row, so the push webhook knows the branch from the start.
      expect(await indexRow(created.sent?.sessionId)).toEqual({
        task_branch: "feature/login",
        base_branch: "feature/login",
        branch_mode: "existing_branch",
        base_commit_sha: FEATURE_SHA,
      });
      // The default branch was read live, under the same single read token.
      const mints = double.calls.filter((call) => call.tokenNarrowing !== undefined);
      expect(mints.map((call) => call.tokenNarrowing)).toEqual([
        { repositoryIds: [REPOSITORY_ID], permissions: { contents: "read" } },
      ]);
      expect(double.calls.some((call) => call.path === "/repos/acme/widgets")).toBe(true);
    });

    it("refuses to work directly on the default branch", async () => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "main",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: { error: "branch_refused", reason: "default" } });
    });

    it("refuses a branch that became the default on GitHub since the install cached it", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble();
      double.setDefaultBranch("acme/widgets", "feature/login");
      vi.stubGlobal("fetch", double.fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: { error: "branch_refused", reason: "default" } });
    });

    it("refuses to work directly on a protected branch, and writes no row", async () => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble({ protected: ["feature/login"] }).fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: { error: "branch_refused", reason: "protected" } });
      const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM session_index").first<{
        count: number;
      }>();
      expect(rows?.count).toBe(0);
    });

    it.each(["new_branch", "existing_branch"])(
      "refuses a branch GitHub no longer has (%s)",
      async (branchMode) => {
        await seedRepository(BRANCH_SUBJECT);
        vi.stubGlobal("fetch", branchesDouble().fetchImpl);
        expect(
          await create(requestBody({ repositoryConnectionId: "rc_1", branch: "gone", branchMode })),
        ).toEqual({ status: 409, body: { error: "branch_refused", reason: "missing" } });
      },
    );

    it("refuses a branch another of the caller's sessions holds, and names it", async () => {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      await holder(workspaceId, "rc_1", "active");
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({
        status: 409,
        body: { error: "branch_refused", reason: "in_use", sessionId: "ses_holder_active" },
      });
    });

    it.each(["creating", "archived"])(
      "counts a %s session as holding its branch",
      async (state) => {
        const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
        await holder(workspaceId, "rc_1", state);
        vi.stubGlobal("fetch", branchesDouble().fetchImpl);
        const result = await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        );
        expect(result.body).toMatchObject({ error: "branch_refused", reason: "in_use" });
      },
    );

    it("keeps holding a branch whose session is being deleted, since its object may still push", async () => {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      await holder(workspaceId, "rc_1", "deletion_pending");
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const result = await create(
        requestBody({
          repositoryConnectionId: "rc_1",
          branch: "feature/login",
          branchMode: "existing_branch",
        }),
      );
      // Worded as its own case and not linked: nobody continues in a session being deleted.
      expect(result).toEqual({
        status: 409,
        body: { error: "branch_refused", reason: "deleting" },
      });
    });

    it("releases the branch when the deletion's receipt removes the holder's row, so another session can work on it", async () => {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      await holder(workspaceId, "rc_1", "deletion_pending");
      await env.DB.prepare(
        `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
         VALUES ('del_holder', 'ses_holder_deletion_pending', ?, 'user_x', ?)`,
      )
        .bind(workspaceId, NOW)
        .run();
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const body = requestBody({
        repositoryConnectionId: "rc_1",
        branch: "feature/login",
        branchMode: "existing_branch",
      });
      expect((await create(body)).body).toMatchObject({ reason: "deleting" });

      // The real job, with the object's two answers scripted.
      const outcome = await runDeletion(
        env,
        {
          marked: async () => true,
          close: async () => ({ kind: "deleting", sandbox: "stopped" }),
          erase: async () => ({ kind: "erased" }),
        },
        "del_holder",
      );
      expect(outcome).toEqual({ kind: "completed" });

      const created = await create(body);
      expect(created.status).toBe(201);
      const taken = await env.DB.prepare(
        "SELECT session_id, branch_mode FROM session_index WHERE task_branch = 'feature/login'",
      ).all<{ session_id: string; branch_mode: string }>();
      expect(taken.results).toEqual([
        { session_id: created.body.sessionId, branch_mode: "existing_branch" },
      ]);
      // The receipt remembers the branch it released, as a hash.
      expect(
        await env.DB.prepare(
          "SELECT released_ref_hash FROM deletion_request WHERE id = 'del_holder'",
        ).first(),
      ).toEqual({
        released_ref_hash: await releasedRefHash(REPOSITORY_ID, "refs/heads/feature/login"),
      });
    });

    it("refuses a branch a ruleset guards, which the branch API does not call protected", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble();
      double.setRulesets("acme/widgets", [
        {
          id: 7,
          name: "Feature branches",
          target: "branch",
          enforcement: "active",
          include: ["refs/heads/feature/**"],
          exclude: [],
          rules: ["non_fast_forward"],
          source: "Organization",
        },
      ]);
      vi.stubGlobal("fetch", double.fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: { error: "branch_refused", reason: "protected" } });
    });

    it("works on a branch whose only rulesets do not guard pushes or exclude it", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble();
      double.setRulesets("acme/widgets", [
        {
          id: 1,
          name: "Branch names",
          target: "branch",
          enforcement: "active",
          include: ["~ALL"],
          exclude: [],
          rules: ["creation", "branch_name_pattern"],
        },
        {
          id: 2,
          name: "Everything but features",
          target: "branch",
          enforcement: "active",
          include: ["~ALL"],
          exclude: ["refs/heads/feature/*"],
          rules: ["update"],
        },
        {
          id: 3,
          name: "Only evaluated",
          target: "branch",
          enforcement: "evaluate",
          include: ["~ALL"],
          exclude: [],
          rules: ["update"],
        },
      ]);
      vi.stubGlobal("fetch", double.fetchImpl);
      const result = await create(
        requestBody({
          repositoryConnectionId: "rc_1",
          branch: "feature/login",
          branchMode: "existing_branch",
        }),
      );
      expect(result.status).toBe(201);
    });

    it("refuses, failing closed, when GitHub will not say which rules apply to the branch", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const double = branchesDouble();
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/rules/branches/")
          ? new Response("", { status: 500 })
          : double.fetchImpl(input, init)) as typeof fetch);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 502, body: { error: "branch_refused", reason: "unconfirmed" } });
    });

    it("refuses a retry that reuses the command id for another branch or repository", async () => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      expect(
        (
          await create(
            requestBody({
              repositoryConnectionId: "rc_1",
              branch: "feature/login",
              branchMode: "existing_branch",
            }),
          )
        ).status,
      ).toBe(201);
      const reused = { error: "invalid_request", reason: "command_reused" };
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "release/1.4",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: reused });
      expect(
        await create(requestBody({ repositoryConnectionId: "rc_1", branch: "feature/login" })),
      ).toEqual({ status: 409, body: reused });
      expect(await create(requestBody({ repositoryConnectionId: "rc_1" }))).toEqual({
        status: 409,
        body: reused,
      });
    });

    it("refuses a branch another workspace's session holds on the same GitHub repository, without naming it", async () => {
      await seedRepository(BRANCH_SUBJECT);
      const theirs = await seedRepository("user_someone_else", {
        repositoryConnectionId: "rc_theirs",
      });
      await holder(theirs.workspaceId, "rc_theirs", "active");
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      expect(
        await create(
          requestBody({
            repositoryConnectionId: "rc_1",
            branch: "feature/login",
            branchMode: "existing_branch",
          }),
        ),
      ).toEqual({ status: 409, body: { error: "branch_refused", reason: "in_use" } });
    });

    it("lets another session start from a held branch, since it pushes elsewhere", async () => {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      await holder(workspaceId, "rc_1", "active");
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const result = await create(
        requestBody({ repositoryConnectionId: "rc_1", branch: "feature/login" }),
      );
      expect(result.status).toBe(201);
    });

    it("answers a retry of the same session rather than refusing it as held", async () => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const body = requestBody({
        repositoryConnectionId: "rc_1",
        branch: "feature/login",
        branchMode: "existing_branch",
      });
      expect((await create(body)).status).toBe(201);
      expect((await create(body)).status).toBe(201);
    });

    // The check before the claim can pass while another create takes the branch;
    // the insert judges and takes it in one statement.
    it("refuses when another session takes the branch between the check and the insert, and hands back its uploads", async () => {
      const { workspaceId } = await seedRepository(BRANCH_SUBJECT);
      const upload = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
           content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
         VALUES (?, ?, 'u', NULL, 'screen.png', 'image/png', 'image', 12, 'x', ?, '2026-09-27T00:00:00.000Z', NULL)`,
      )
        .bind(upload, workspaceId, `workspaces/${workspaceId}/attachments/${upload}`)
        .run();
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      const racing = new Proxy(env.DB, {
        get(target, property) {
          if (property !== "prepare") {
            return Reflect.get(target, property);
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.trimStart().startsWith("INSERT INTO session_index")) {
              return statement;
            }
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  await holder(workspaceId, "rc_1", "active");
                  return statement.bind(...values).run();
                },
              }),
            };
          };
        },
      });
      const result = await create(
        requestBody({
          repositoryConnectionId: "rc_1",
          branch: "feature/login",
          branchMode: "existing_branch",
          instruction: {
            messageId: "msg_1",
            text: "Fix it",
            attachments: [
              {
                artifactId: upload,
                kind: "file",
                contentType: "image/png",
                byteSize: 12,
                label: "s",
              },
            ],
          },
        }),
        { DB: racing as unknown as string },
      );
      expect(result).toEqual({
        status: 409,
        body: { error: "branch_refused", reason: "in_use", sessionId: "ses_holder_active" },
      });
      const mine = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM session_index WHERE session_id <> 'ses_holder_active'",
      ).first<{ count: number }>();
      expect(mine?.count).toBe(0);
      // Unclaimed again, so sending the message once more can carry it.
      expect(
        await env.DB.prepare(
          "SELECT session_id, claimed_at FROM message_attachment WHERE attachment_id = ?",
        )
          .bind(upload)
          .first(),
      ).toEqual({ session_id: null, claimed_at: null });
    });

    it.each([
      ["a name OnCue cannot push to", { branch: "has space" }],
      ["a name that reads as an option", { branch: "-x" }],
      ["a mode it does not know", { branch: "feature/login", branchMode: "sideways" }],
      ["working on a branch without naming one", { branchMode: "existing_branch" }],
      ["a branch that is not a string", { branch: 7 }],
    ])("refuses %s", async (_, fields) => {
      await seedRepository(BRANCH_SUBJECT);
      vi.stubGlobal("fetch", branchesDouble().fetchImpl);
      expect(await create(requestBody({ repositoryConnectionId: "rc_1", ...fields }))).toEqual({
        status: 400,
        body: { error: "invalid_request", reason: "branch" },
      });
    });

    it("refuses a branch with no repository to hold it", async () => {
      expect(await create(requestBody({ branch: "feature/login" }))).toEqual({
        status: 400,
        body: { error: "invalid_request", reason: "branch" },
      });
    });

    it("judges a retry against the stored choice, and does not judge a row from before the choice", () => {
      const record = {
        repositoryConnectionId: "rc_1",
        githubRepositoryId: REPOSITORY_ID,
        taskBranch: null,
        baseBranch: "main",
        branchMode: "new_branch" as const,
        baseCommitSha: BASE_SHA,
        repository: null,
        secrets: null,
      };
      const row = {
        repository_connection_id: "rc_1",
        task_branch: "oncue/named-since-1a2b",
        base_branch: "main",
        branch_mode: "new_branch",
      };
      // A task branch named since creation is not a different choice.
      expect(sameBranchChoice(row, record)).toBe(true);
      expect(sameBranchChoice({ ...row, branch_mode: null, base_branch: null }, record)).toBe(true);
      expect(sameBranchChoice({ ...row, repository_connection_id: "rc_9" }, record)).toBe(false);
      expect(sameBranchChoice({ ...row, base_branch: "release/1.4" }, record)).toBe(false);
    });

    it("finds a branch's holder through its index, not a scan", async () => {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${BRANCH_HOLDER_SQL}`)
        .bind("feature/login", REPOSITORY_ID, "ses_x")
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      expect(details.some((detail) => detail.includes("idx_session_index_task_branch"))).toBe(true);
      expect(details.filter((detail) => /^SCAN /.test(detail))).toEqual([]);
    });
  });

  it("refuses a repository connection id that is not a usable string", async () => {
    await seedRepository(BRANCH_SUBJECT);

    expect((await create(requestBody({ repositoryConnectionId: 7 }))).status).toBe(400);
    expect((await create(requestBody({ repositoryConnectionId: "" }))).status).toBe(400);
  });

  // Collapsed with "no such repository" so a caller cannot probe which
  // connection ids exist in other workspaces.
  it("refuses another workspace's repository as if it did not exist", async () => {
    await seedRepository(BRANCH_SUBJECT);
    await seedRepository("user_someone_else", { repositoryConnectionId: "rc_theirs" });

    const result = await create(requestBody({ repositoryConnectionId: "rc_theirs" }));

    expect(result.status).toBe(403);
    expect(result.body.reason).toBe("not_usable");
  });

  it("refuses a repository the user disconnected", async () => {
    await seedRepository(BRANCH_SUBJECT, { repositoryStatus: "disconnected" });

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }));

    expect(result.status).toBe(409);
    expect(result.body.reason).toBe("not_connected");
  });

  it("refuses a repository whose installation is no longer active", async () => {
    await seedRepository(BRANCH_SUBJECT, { installationStatus: "suspended" });

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }));

    expect(result.status).toBe(409);
    expect(result.body.reason).toBe("not_connected");
  });

  // Better than creating a session against a repository this deployment could
  // never push to.
  it("refuses when the deployment has no GitHub App", async () => {
    await seedRepository(BRANCH_SUBJECT);

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }), {
      ONCUE_GITHUB_APP_PRIVATE_KEY: undefined,
    });

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("github_unconfigured");
  });

  it("writes no session row when GitHub cannot be reached for the launch", async () => {
    await seedRepository(BRANCH_SUBJECT);
    const double = githubDouble();
    double.setMode("token_mint_fails");
    vi.stubGlobal("fetch", double.fetchImpl);

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }));

    expect(result.status).toBe(502);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM session_index").first<{
      count: number;
    }>();
    expect(rows?.count).toBe(0);
  });

  it("never answers with a token or an App key", async () => {
    await seedRepository(BRANCH_SUBJECT);
    vi.stubGlobal("fetch", githubDouble().fetchImpl);

    const result = await create(requestBody({ repositoryConnectionId: "rc_1" }));

    const text = JSON.stringify(result.body);
    expect(/gh[supo]_/.test(text)).toBe(false);
    expect(text.includes("PRIVATE KEY")).toBe(false);
  });
});

// The Modal credential is opened in the Worker and handed to the object in the
// create body; the rows hold a real sealed envelope because every case is
// about opening it.
describe("the Modal credential a session is created with", () => {
  const NOW = "2026-09-08T00:00:00.000Z";

  async function seedWorkspaceFor(subject: string): Promise<string> {
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

  async function giveWorkspaceModal(
    subject: string,
    options: { status?: string; corrupt?: boolean } = {},
  ): Promise<void> {
    const workspaceId = await seedWorkspaceFor(subject);
    const keyringResult = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");
    if (keyringResult.kind !== "ok") {
      throw new Error("the test runner always configures a keyring");
    }
    const connectionId = `mdl_${subject}`;
    const seal = (half: "token_id" | "token_secret", value: string) =>
      sealCredential(
        keyringResult.keyring,
        modalTokenContext(connectionId, workspaceId, half),
        value,
      );
    await env.DB.prepare(
      `INSERT INTO modal_connection (
         connection_id, workspace_id, token_id_reference, token_secret_reference,
         modal_workspace_name, environment_name, status, last_validated_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme-workspace', 'staging', ?, ?, ?, ?)`,
    )
      .bind(
        connectionId,
        workspaceId,
        options.corrupt === true ? "not-an-envelope" : await seal("token_id", "ak-fake0001"),
        await seal("token_secret", "as-fake0001"),
        options.status ?? "active",
        NOW,
        NOW,
        NOW,
      )
      .run();
  }

  it("passes null for a workspace that has not connected Modal", async () => {
    const subject = "user_modal_none";
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    // Null, not a refusal: `selectSandboxDriver` then runs the fake, as every
    // local session does.
    expect(bodies[0]?.modalCredential).toBeNull();
  });

  it("opens the pair and hands it to the session object", async () => {
    const subject = "user_modal_ready";
    await giveWorkspaceModal(subject);
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.modalCredential).toEqual({
      tokenId: "ak-fake0001",
      tokenSecret: "as-fake0001",
      environmentName: "staging",
    });
  });

  it("passes null for a connection whose credential has stopped working", async () => {
    const subject = "user_modal_invalid";
    await giveWorkspaceModal(subject, { status: "invalid" });
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );

    expect(bodies[0]?.modalCredential).toBeNull();
  });

  // A rotated keyring or moved ciphertext is a fault, never downgraded to a
  // scripted transcript.
  it("refuses, and creates nothing, when the stored envelope will not open", async () => {
    const subject = "user_modal_corrupt";
    await giveWorkspaceModal(subject, { corrupt: true });
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "modal_credential_unusable" });
    expect(bodies).toEqual([]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM session_index").first<{
      count: number;
    }>();
    expect(rows?.count).toBe(0);
  });

  // No keyring can open nothing, the same as no connection; refusing every
  // session there would break a local setup that never configured the broker.
  it("runs on the fake when the deployment has no keyring", async () => {
    const subject = "user_modal_no_keyring";
    await giveWorkspaceModal(subject);
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_BROKER_KEYRING: "",
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.modalCredential).toBeNull();
  });

  // On a deployment with a controller, falling back would hand the user a
  // scripted transcript as a real session, and the browser's setup gate cannot
  // prevent it (record 01).
  it("refuses when the controller is configured and the workspace has no Modal connection", async () => {
    const subject = "user_modal_gap";
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ...CONTROLLER_CONFIGURED,
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "modal_connection_required" });
    expect(bodies).toEqual([]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM session_index").first<{
      count: number;
    }>();
    expect(rows?.count).toBe(0);
  });

  it("refuses on a configured deployment when the connection has stopped working", async () => {
    const subject = "user_modal_gap_invalid";
    await giveWorkspaceModal(subject, { status: "invalid" });
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ...CONTROLLER_CONFIGURED,
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(409);
    expect(bodies).toEqual([]);
  });

  // A controller but no keyring can create no real sandbox either, so running
  // the fake there would be the same silent substitution.
  it("refuses on a configured deployment with no keyring", async () => {
    const subject = "user_modal_gap_no_keyring";
    await giveWorkspaceModal(subject);
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_BROKER_KEYRING: "",
        ...CONTROLLER_CONFIGURED,
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(409);
    expect(bodies).toEqual([]);
  });

  it("creates the session on a configured deployment when the workspace has connected Modal", async () => {
    const subject = "user_modal_gap_ready";
    await giveWorkspaceModal(subject);
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ...CONTROLLER_CONFIGURED,
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.modalCredential).toEqual({
      tokenId: "ak-fake0001",
      tokenSecret: "as-fake0001",
      environmentName: "staging",
    });
  });

  // An origin the driver would refuse is not a configured controller. Locally
  // that means the fake; hosted it is refused (`refuseHostedStandIn`).
  it("runs on the fake locally when the controller origin is unusable", async () => {
    const subject = "user_modal_gap_plain_http";
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_SANDBOX_CONTROLLER_ORIGIN: "ftp://controller.internal",
        ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
      }),
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    expect(bodies[0]?.modalCredential).toBeNull();
  });

  it("never opens another workspace's Modal credential", async () => {
    await giveWorkspaceModal("user_modal_theirs");
    const subject = "user_modal_mine";
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();

    await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      caller,
      createAllowlistCache(),
    );

    expect(bodies[0]?.modalCredential).toBeNull();
  });
});

// A hosted deployment never runs a session on the fake driver or the scripted
// model: either would pass a scripted transcript off as a real session.
describe("a hosted deployment's refusal of stand-ins", () => {
  const HOSTED = { ONCUE_ENV: "hosted", ...CONTROLLER_CONFIGURED } as const;

  it("lets a local deployment run on the fake and the scripted model", () => {
    expect(refuseHostedStandIn(envWith({ ONCUE_ENV: "local" }), true)).toBeNull();
  });

  it("refuses a hosted deployment with no usable controller", async () => {
    const refused = refuseHostedStandIn(envWith({ ONCUE_ENV: "hosted" }), false);

    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ error: "controller_unconfigured" });
  });

  it("refuses a hosted workspace with no model connection", async () => {
    const refused = refuseHostedStandIn(envWith(HOSTED), true);

    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toEqual({ error: "model_connection_required" });
  });

  it("lets a hosted deployment with a controller and a model connection go on", () => {
    expect(refuseHostedStandIn(envWith(HOSTED), false)).toBeNull();
  });

  async function createHosted(
    subject: string,
    overrides: Parameters<typeof envWith>[0],
  ): Promise<{ response: Response; bodies: Record<string, unknown>[] }> {
    const double = await createClerkDouble();
    const { caller, bodies } = capturingCaller();
    const response = await handleCreateSession(
      await postJsonAs(double, subject, requestBody()),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_ENV: "hosted",
        ...overrides,
      }),
      caller,
      createAllowlistCache(),
    );
    return { response, bodies };
  }

  async function sessionRows(): Promise<number> {
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM session_index").first<{
      count: number;
    }>();
    return rows?.count ?? 0;
  }

  // The test runner blanks both controller bindings, so each case sets only
  // what it means to have.
  it.each([
    ["no origin", "user_hosted_no_origin", { ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token" }],
    [
      "no token",
      "user_hosted_no_token",
      { ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run" },
    ],
    [
      "a plain-HTTP origin",
      "user_hosted_plain_http",
      {
        ONCUE_SANDBOX_CONTROLLER_ORIGIN: "http://controller.internal",
        ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
      },
    ],
  ])("refuses the create, and writes nothing, with %s", async (_label, subject, controller) => {
    const { response, bodies } = await createHosted(subject, controller);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "controller_unconfigured" });
    expect(bodies).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("refuses the create, and writes nothing, when the workspace has no model connection", async () => {
    const { response, bodies } = await createHosted("user_hosted_no_key", CONTROLLER_CONFIGURED);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_connection_required" });
    expect(bodies).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  // `resolveModel` counts active connections only, so a workspace whose one key
  // was rejected would otherwise run the scripted model.
  it("refuses the create when the workspace's only key is invalid", async () => {
    const subject = "user_hosted_invalid_key";
    await giveWorkspaceAConnection(subject, "mc_invalid", "invalid");

    const { response, bodies } = await createHosted(subject, CONTROLLER_CONFIGURED);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_connection_required" });
    expect(bodies).toEqual([]);
  });
});
