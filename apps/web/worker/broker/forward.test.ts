import { env } from "cloudflare:test";
import type { EffortLevel } from "@oncue/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { LogFields } from "../log";
import {
  COUNT_TOKENS_PATH,
  createProviderDouble,
  type DoubleMode,
  type RecordedCall,
} from "../test/provider-double";
import { deriveKeyring, type Keyring, sealCredential } from "./envelope";
import { FAILURE_POLICY, type ForwardDeps, forwardModelRequest } from "./forward";
import { PROMPT_COUNTS_HEADER, PromptCountCache } from "./prompt-counts";
import { PROVIDER_ADAPTERS, type ProviderAdapter } from "./providers/adapter";
import { mintToken, type TokenScope } from "./tokens";

const NOW_MS = 1_800_000_000_000;
const NOW_ISO = "2026-09-05T00:00:00.000Z";
const WORKSPACE = "wsp_fwd";
const SESSION = "sess_fwd";
const CONNECTION = "mc_fwd";
const GENERATION = 3;

/** Short enough for the secret scanner, distinctive enough to search for. */
const API_KEY = "sk-ant-leakcanary0001";

const MODEL = PROVIDER_ADAPTERS.anthropic.defaultModel.modelId;

function randomKeyText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function keyrings(): Promise<{
  credential: Keyring<"credential">;
  token: Keyring<"token">;
}> {
  const secret = `1:${randomKeyText()}`;
  const credential = await deriveKeyring(secret, "credential");
  const token = await deriveKeyring(secret, "token");
  if (credential.kind !== "ok" || token.kind !== "ok") {
    throw new Error("expected both keyrings");
  }
  return { credential: credential.keyring, token: token.keyring };
}

const SCOPE: TokenScope = {
  sessionId: SESSION,
  sandboxGeneration: GENERATION,
  connectionId: CONNECTION,
  workspaceId: WORKSPACE,
  modelId: MODEL,
  effort: null,
};

function requestBody(model: string = MODEL): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({ model, messages: [] })).buffer as ArrayBuffer;
}

interface Harness {
  readonly deps: ForwardDeps;
  readonly logs: LogFields[];
  readonly token: string;
  /** What the double received, for header assertions. */
  readonly calls: readonly RecordedCall[];
  setMode(mode: DoubleMode): void;
}

async function harness(
  options: {
    sealed?: string;
    fetchThrows?: boolean;
    provider?: "anthropic" | "openai";
    respondWith?: Response;
    /** The effort the token is minted for; none by default, as for a model without one. */
    effort?: EffortLevel | null;
  } = {},
): Promise<Harness> {
  const rings = await keyrings();
  const provider = options.provider ?? "anthropic";
  const double = createProviderDouble(provider);
  const logs: LogFields[] = [];
  const sealed =
    options.sealed ??
    (await sealCredential(
      rings.credential,
      { connectionId: CONNECTION, workspaceId: WORKSPACE, provider },
      API_KEY,
    ));

  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'api_key', ?, 'active', '...0001', NULL, ?, ?, ?)`,
  )
    .bind(CONNECTION, WORKSPACE, provider, sealed, NOW_ISO, NOW_ISO, NOW_ISO)
    .run();
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, created_at, updated_at)
     VALUES (?, ?, NULL, 'active', ?, ?, ?)`,
  )
    .bind(SESSION, WORKSPACE, GENERATION, NOW_ISO, NOW_ISO)
    .run();

  function chooseFetch(): typeof fetch {
    if (options.fetchThrows === true) {
      return () => Promise.reject(new Error("connection interrupted"));
    }
    if (options.respondWith !== undefined) {
      const canned = options.respondWith;
      return () => Promise.resolve(canned.clone());
    }
    return double.fetchImpl;
  }
  const fetchImpl = chooseFetch();

  return {
    logs,
    // Scoped to this provider's model: the broker refuses a body for another.
    token: await mintToken(
      rings.token,
      {
        ...SCOPE,
        modelId: PROVIDER_ADAPTERS[provider].defaultModel.modelId,
        effort: options.effort ?? null,
      },
      NOW_MS,
    ),
    calls: double.calls,
    setMode: (mode) => double.setMode(mode),
    deps: {
      db: env.DB,
      credentialKeyring: rings.credential,
      tokenKeyring: rings.token,
      fetchImpl,
      originFor: (_adapter: ProviderAdapter) => "https://provider.double",
      now: () => NOW_MS,
      log: (fields) => logs.push(fields),
      release: "test",
      environment: "local",
      waitUntil: (work) => {
        void work;
      },
    },
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_fwd', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW_ISO, NOW_ISO),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_fwd', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, NOW_ISO, NOW_ISO),
  ]);
  await env.DB.prepare("DELETE FROM model_connection").run();
  await env.DB.prepare("DELETE FROM session_index").run();
});

describe("the credential never escapes", () => {
  // Runs a real forward against a real sealed credential, then scans every log
  // line, the stored row, and the outcome for the key's bytes.
  it("puts no part of the key in a log line, the stored row, or the outcome", async () => {
    const h = await harness();

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    expect(outcome.kind).toBe("streamed");
    expect(h.logs.length).toBeGreaterThan(0);

    const logged = JSON.stringify(h.logs);
    expect(logged.includes(API_KEY)).toBe(false);
    expect(logged.includes("sk-ant")).toBe(false);
    expect(logged.includes("leakcanary")).toBe(false);

    // Every field of the outcome, not just `kind`, which could never hold a key.
    const outcomeText = JSON.stringify(outcome, (key, value) =>
      key === "response" ? "<Response>" : value,
    );
    expect(outcomeText.includes(API_KEY)).toBe(false);
    expect(outcomeText.includes("leakcanary")).toBe(false);

    const row = await env.DB.prepare("SELECT * FROM model_connection WHERE connection_id = ?")
      .bind(CONNECTION)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row).includes(API_KEY)).toBe(false);
    expect(JSON.stringify(row).includes("leakcanary")).toBe(false);
  });

  it("puts no part of the key in a log line when the forward fails either", async () => {
    const h = await harness();
    h.setMode("auth_failed");

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    expect(JSON.stringify(h.logs).includes("leakcanary")).toBe(false);
  });

  /** Only the log allowlist's own fields, so nothing can ride along unnoticed. */
  it("logs the provider and the outcome and nothing resembling content", async () => {
    const h = await harness();

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.provider).toBe("anthropic");
    expect(h.logs[0]?.result).toBe("ok");
    expect(h.logs[0]?.operation).toBe("broker.forward");
    expect(h.logs[0]?.sessionId).toBe(SESSION);
    expect(h.logs[0]?.sandboxGeneration).toBe(String(GENERATION));
  });

  it("hands the credential to the provider in that provider's own header", () => {
    const headers = new Headers();
    PROVIDER_ADAPTERS.anthropic.applyCredential(headers, API_KEY);

    expect(headers.get("x-api-key")).toBe(API_KEY);
  });
});

describe("request header passthrough", () => {
  it("forwards anthropic-beta from passthroughHeaders to the provider", async () => {
    const h = await harness();

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
      passthroughHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
    });

    const call = h.calls.at(-1);
    expect(call?.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
  });

  it("does not forward anthropic-beta when passthroughHeaders is absent", async () => {
    const h = await harness();

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    const call = h.calls.at(-1);
    expect(call?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("never forwards a header the adapter did not name, even when it is present in passthroughHeaders", async () => {
    const h = await harness();

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
      passthroughHeaders: { "anthropic-version": "2020-01-01", authorization: "Bearer stolen" },
    });

    const call = h.calls.at(-1);
    // The adapter still pins its own version; a passed-through one never wins.
    expect(call?.headers["anthropic-version"]).not.toBe("2020-01-01");
    expect(call?.headers.authorization).not.toBe("Bearer stolen");
  });

  it("openai forwards no request headers, so passthroughHeaders is inert for it", async () => {
    const h = await harness({ provider: "openai" });

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(PROVIDER_ADAPTERS.openai.defaultModel.modelId),
      contentType: "application/json",
      passthroughHeaders: { "anthropic-beta": "should-not-appear" },
    });

    const call = h.calls.at(-1);
    expect(call?.headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("denials", () => {
  const cases: readonly [string, (h: Harness) => Parameters<typeof forwardModelRequest>[1]][] = [
    [
      "no bearer at all",
      () => ({ sessionId: SESSION, bearer: null, body: requestBody(), contentType: null }),
    ],
    [
      "a token this keyring never signed",
      () => ({
        sessionId: SESSION,
        bearer: "ot1.1.abc.def",
        body: requestBody(),
        contentType: null,
      }),
    ],
    [
      "a token minted for another session",
      (h) => ({
        sessionId: "sess_someone_else",
        bearer: h.token,
        body: requestBody(),
        contentType: null,
      }),
    ],
    [
      "a body asking for a model the token does not name",
      (h) => ({
        sessionId: SESSION,
        bearer: h.token,
        body: requestBody("some-other-model"),
        contentType: null,
      }),
    ],
    [
      "a body that is not JSON",
      (h) => ({
        sessionId: SESSION,
        bearer: h.token,
        body: new TextEncoder().encode("not json").buffer as ArrayBuffer,
        contentType: null,
      }),
    ],
    [
      "a body that is JSON but not an object",
      (h) => ({
        sessionId: SESSION,
        bearer: h.token,
        body: new TextEncoder().encode('"a string"').buffer as ArrayBuffer,
        contentType: null,
      }),
    ],
    [
      "a null body",
      (h) => ({
        sessionId: SESSION,
        bearer: h.token,
        body: new TextEncoder().encode("null").buffer as ArrayBuffer,
        contentType: null,
      }),
    ],
    [
      "a body whose model is not a string",
      (h) => ({
        sessionId: SESSION,
        bearer: h.token,
        body: new TextEncoder().encode('{"model":7}').buffer as ArrayBuffer,
        contentType: null,
      }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`denies ${name}`, async () => {
      const h = await harness();

      expect(await forwardModelRequest(h.deps, build(h))).toEqual({ kind: "denied" });
    });
  }

  /** The status flip lands on the very next forward, with no cache. */
  it("denies once the connection is revoked", async () => {
    const h = await harness();
    await env.DB.prepare("UPDATE model_connection SET status = 'revoked'").run();

    expect(
      await forwardModelRequest(h.deps, {
        sessionId: SESSION,
        bearer: h.token,
        body: requestBody(),
        contentType: "application/json",
      }),
    ).toEqual({ kind: "denied" });
  });

  it("denies a token from a generation the session has moved past", async () => {
    const h = await harness();
    await env.DB.prepare("UPDATE session_index SET sandbox_generation = 9").run();

    expect(
      await forwardModelRequest(h.deps, {
        sessionId: SESSION,
        bearer: h.token,
        body: requestBody(),
        contentType: "application/json",
      }),
    ).toEqual({ kind: "denied" });
  });

  it("logs nothing at all for a denial, so a probe leaves no provider trail", async () => {
    const h = await harness();

    await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: null,
      body: requestBody(),
      contentType: null,
    });

    expect(h.logs).toEqual([]);
  });
});

describe("the seven failure categories", () => {
  const byMode: readonly [DoubleMode, string][] = [
    ["rate_limited", "rate_limited"],
    ["auth_failed", "authentication_failed"],
    ["model_unavailable", "model_unavailable"],
    ["rejected", "request_rejected"],
    ["overloaded", "temporary_service_failure"],
  ];

  for (const [mode, category] of byMode) {
    it(`reports ${category} when the provider answers ${mode}`, async () => {
      const h = await harness();
      h.setMode(mode);

      const outcome = await forwardModelRequest(h.deps, {
        sessionId: SESSION,
        bearer: h.token,
        body: requestBody(),
        contentType: "application/json",
      });

      if (outcome.kind !== "failed") {
        throw new Error(`expected a failure, got ${outcome.kind}`);
      }
      expect(outcome.category).toBe(category);
      expect(outcome.retrySafe).toBe(FAILURE_POLICY[outcome.category].retrySafe);
      const logged = h.logs.filter((line) => line.operation === "broker.forward");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.errorCategory).toBe(category);
      expect(logged[0]?.result).toBe("failed");
    });
  }

  /** OpenAI is the provider whose 429 distinguishes a quota from a rate limit. */
  it("reports usage_limit_reached for an exhausted OpenAI allowance", async () => {
    const h = await harness({ provider: "openai" });
    h.setMode("usage_limit");

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(PROVIDER_ADAPTERS.openai.defaultModel.modelId),
      contentType: "application/json",
    });

    if (outcome.kind !== "failed") {
      throw new Error(`expected a failure, got ${outcome.kind}`);
    }
    expect(outcome.category).toBe("usage_limit_reached");
  });

  // broker_failure is the one category no provider can cause: OnCue could not
  // use its own credential.
  it("reports broker_failure when the stored credential cannot be opened", async () => {
    const h = await harness({ sealed: "oncue1.9.bm9uY2U.Y2lwaGVy" });

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    if (outcome.kind !== "failed") {
      throw new Error(`expected a failure, got ${outcome.kind}`);
    }
    expect(outcome.category).toBe("broker_failure");
    expect(outcome.status).toBe(502);
  });

  it("reports temporary_service_failure when the provider cannot be reached at all", async () => {
    const h = await harness({ fetchThrows: true });

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    if (outcome.kind !== "failed") {
      throw new Error(`expected a failure, got ${outcome.kind}`);
    }
    expect(outcome.category).toBe("temporary_service_failure");
    expect(outcome.retrySafe).toBe(true);
  });

  // A proxy may answer with HTML; classification falls back to the status.
  it("classifies on status alone when the error body is not JSON", async () => {
    const h = await harness({
      respondWith: new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    });

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    if (outcome.kind !== "failed") {
      throw new Error(`expected a failure, got ${outcome.kind}`);
    }
    expect(outcome.category).toBe("temporary_service_failure");
  });

  it("covers all seven categories between this suite and the policy table", () => {
    expect(Object.keys(FAILURE_POLICY).sort()).toEqual(
      [
        "authentication_failed",
        "broker_failure",
        "model_unavailable",
        "rate_limited",
        "request_rejected",
        "temporary_service_failure",
        "usage_limit_reached",
      ].sort(),
    );
  });

  /** Record 06: an invalid key marks the connection so the user is asked to replace it. */
  it("marks the connection invalid when the provider rejects its credential and the key check agrees", async () => {
    const h = await harness();
    const pending: Promise<unknown>[] = [];
    const deps: ForwardDeps = {
      ...h.deps,
      waitUntil: (work) => {
        pending.push(work);
      },
    };
    h.setMode("auth_failed");

    await forwardModelRequest(deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });
    await Promise.all(pending);

    const row = await env.DB.prepare("SELECT status FROM model_connection WHERE connection_id = ?")
      .bind(CONNECTION)
      .first<{ status: string }>();
    expect(row?.status).toBe("invalid");
  });

  it("leaves the connection active for a failure that says nothing about the key", async () => {
    const h = await harness();
    const pending: Promise<unknown>[] = [];
    const deps: ForwardDeps = { ...h.deps, waitUntil: (work) => pending.push(work) };
    h.setMode("rate_limited");

    await forwardModelRequest(deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });
    await Promise.all(pending);

    const row = await env.DB.prepare("SELECT status FROM model_connection WHERE connection_id = ?")
      .bind(CONNECTION)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});

describe("confirming a rejected key before marking it", () => {
  const input = () => ({
    sessionId: SESSION,
    bearer: "",
    body: requestBody(),
    contentType: "application/json",
  });

  /** The model request is refused as unauthorized; the key check gets `check`'s answer. */
  function unauthorizedRequestThen(check: typeof fetch): {
    fetchImpl: typeof fetch;
    paths: string[];
  } {
    const paths: string[] = [];
    return {
      paths,
      fetchImpl: (target, init) => {
        const url = String(target);
        paths.push(new URL(url).pathname);
        if (url.endsWith(PROVIDER_ADAPTERS.anthropic.requestPath)) {
          return Promise.resolve(
            Response.json(
              { type: "error", error: { type: "authentication_error", message: "no" } },
              { status: 401 },
            ),
          );
        }
        return check(target, init);
      },
    };
  }

  async function run(
    h: Harness,
    overrides: Partial<ForwardDeps>,
  ): Promise<{
    outcome: Awaited<ReturnType<typeof forwardModelRequest>>;
    row: { status: string; last_validated_at: string; updated_at: string };
  }> {
    const pending: Promise<unknown>[] = [];
    const outcome = await forwardModelRequest(
      { ...h.deps, ...overrides, waitUntil: (work) => pending.push(work) },
      { ...input(), bearer: h.token },
    );
    await Promise.all(pending);
    const row = await env.DB.prepare(
      "SELECT status, last_validated_at, updated_at FROM model_connection WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .first<{ status: string; last_validated_at: string; updated_at: string }>();
    if (row === null) {
      throw new Error("expected the connection row");
    }
    return { outcome, row };
  }

  it("asks the provider about the key itself, with the same key, after an unauthorized answer", async () => {
    const h = await harness();
    h.setMode("auth_failed");

    const { outcome } = await run(h, {});

    expect(outcome).toMatchObject({ kind: "failed", category: "authentication_failed" });
    expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
      PROVIDER_ADAPTERS.anthropic.requestPath,
      "/v1/models",
    ]);
    expect(h.calls.map((call) => call.headers["x-api-key"])).toEqual([API_KEY, API_KEY]);
    expect(h.logs.map((line) => [line.operation, line.result])).toEqual([
      ["broker.forward.key_check", "rejected"],
      ["broker.forward", "failed"],
    ]);
    expect(JSON.stringify(h.logs).includes("leakcanary")).toBe(false);
  });

  it.each(["anthropic", "openai"] as const)(
    "fails only the run, as model_unavailable, when %s still accepts the key",
    async (provider) => {
      const h = await harness({ provider });
      h.setMode("request_forbidden");
      const body = requestBody(PROVIDER_ADAPTERS[provider].defaultModel.modelId);
      const pending: Promise<unknown>[] = [];

      const outcome = await forwardModelRequest(
        { ...h.deps, waitUntil: (work) => pending.push(work) },
        { ...input(), bearer: h.token, body },
      );
      await Promise.all(pending);

      if (outcome.kind !== "failed") {
        throw new Error(`expected a failure, got ${outcome.kind}`);
      }
      expect(outcome.category).toBe("model_unavailable");
      expect(outcome.retrySafe).toBe(false);
      expect(outcome.status).toBe(FAILURE_POLICY.model_unavailable.sandboxStatus);
      expect(outcome.message).toBe(FAILURE_POLICY.model_unavailable.message);
      const row = await env.DB.prepare(
        "SELECT status, last_validated_at FROM model_connection WHERE connection_id = ?",
      )
        .bind(CONNECTION)
        .first<{ status: string; last_validated_at: string }>();
      // The key just validated, and the row says so.
      expect(row).toEqual({ status: "active", last_validated_at: new Date(NOW_MS).toISOString() });
      expect(h.logs.map((line) => [line.operation, line.result, line.errorCategory])).toEqual([
        ["broker.forward.key_check", "accepted", undefined],
        ["broker.forward", "failed", "model_unavailable"],
      ]);
    },
  );

  it.each([
    ["is rate limiting", () => Promise.resolve(new Response("{}", { status: 429 }))],
    ["has a temporary problem", () => Promise.resolve(new Response("{}", { status: 503 }))],
    ["cannot be reached", () => Promise.reject(new Error("no route"))],
  ] as const)(
    "reports the rejection without marking the connection when the key check %s",
    async (_name, check) => {
      const h = await harness();
      const routed = unauthorizedRequestThen(check);

      const { outcome, row } = await run(h, { fetchImpl: routed.fetchImpl });

      // Still the clean refusal the provider gave, never a broker failure.
      expect(outcome).toMatchObject({
        kind: "failed",
        category: "authentication_failed",
        status: 403,
        retrySafe: false,
      });
      expect(routed.paths).toEqual([PROVIDER_ADAPTERS.anthropic.requestPath, "/v1/models"]);
      expect(row).toEqual({ status: "active", last_validated_at: NOW_ISO, updated_at: NOW_ISO });
      expect(h.logs.map((line) => [line.operation, line.result])).toEqual([
        ["broker.forward.key_check", "inconclusive"],
        ["broker.forward", "failed"],
      ]);
    },
  );

  it("stops waiting for a key check that never answers, and marks nothing", async () => {
    const h = await harness();
    const signals: AbortSignal[] = [];
    const routed = unauthorizedRequestThen((_target, init) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return new Promise<Response>(() => undefined);
    });

    const { outcome, row } = await run(h, { fetchImpl: routed.fetchImpl, keyCheckTimeoutMs: 20 });

    expect(outcome).toMatchObject({ kind: "failed", category: "authentication_failed" });
    expect(signals[0]?.aborted).toBe(true);
    expect(row.status).toBe("active");
  });

  it("does not check the key for a failure that says nothing about it", async () => {
    const h = await harness();
    h.setMode("model_unavailable");

    const { outcome } = await run(h, {});

    expect(outcome).toMatchObject({ kind: "failed", category: "model_unavailable" });
    expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
      PROVIDER_ADAPTERS.anthropic.requestPath,
    ]);
  });

  it("leaves a key alone that was replaced while the old one was being refused", async () => {
    const h = await harness();
    h.setMode("auth_failed");
    const rejecting: typeof fetch = async (target, init) => {
      if (String(target).endsWith("/v1/models")) {
        await env.DB.prepare(
          "UPDATE model_connection SET credential_reference = 'oncue1.1.new.key' WHERE connection_id = ?",
        )
          .bind(CONNECTION)
          .run();
      }
      return h.deps.fetchImpl(target, init);
    };

    const { outcome, row } = await run(h, { fetchImpl: rejecting });

    expect(outcome).toMatchObject({ kind: "failed", category: "authentication_failed" });
    expect(row.status).toBe("active");
  });
});

describe("streaming through", () => {
  it("returns the provider's stream without buffering or rewriting it", async () => {
    const h = await harness();

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });

    if (outcome.kind !== "streamed") {
      throw new Error(`expected a stream, got ${outcome.kind}`);
    }
    const text = await outcome.response.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes(API_KEY)).toBe(false);
    expect(outcome.response.headers.get("content-type")).not.toBeNull();
  });

  it("logs the provider's token counts once the answer has been read, and nothing of its text", async () => {
    const h = await harness();

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: "application/json",
    });
    if (outcome.kind !== "streamed") {
      throw new Error(`expected a stream, got ${outcome.kind}`);
    }
    expect(h.logs).toHaveLength(1);
    const text = await outcome.response.text();

    expect(h.logs).toHaveLength(2);
    const usage = h.logs[1];
    expect(usage?.operation).toBe("broker.forward.usage");
    expect(usage?.result).toBe("ended");
    expect(usage?.provider).toBe("anthropic");
    expect(usage?.sessionId).toBe(SESSION);
    // The double's own report, read from the bytes that passed.
    const reported = (name: string) => Number(new RegExp(`"${name}":(\\d+)`).exec(text)?.[1]);
    expect(usage?.inputTokens).toBe(reported("input_tokens"));
    expect(usage?.cacheWriteTokens).toBe(reported("cache_creation_input_tokens"));
    expect(usage?.cacheReadTokens).toBe(0);
    expect(usage?.outputTokens).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(usage).includes("chunk-")).toBe(false);
    expect(JSON.stringify(usage).includes(API_KEY)).toBe(false);
  });

  it("logs no counts for an answer with an empty body", async () => {
    const empty = await harness({ respondWith: new Response("", { status: 200 }) });
    const outcome = await forwardModelRequest(empty.deps, {
      sessionId: SESSION,
      bearer: empty.token,
      body: requestBody(),
      contentType: "application/json",
    });
    if (outcome.kind !== "streamed") {
      throw new Error(`expected a stream, got ${outcome.kind}`);
    }
    await outcome.response.text();
    const line = empty.logs.find((each) => each.operation === "broker.forward.usage");
    expect(line).toBeDefined();
    expect(line?.inputTokens).toBeUndefined();
  });

  it("logs no usage line for an answer with no body at all", async () => {
    const none = await harness({ respondWith: new Response(null, { status: 204 }) });
    const bodiless = await forwardModelRequest(none.deps, {
      sessionId: SESSION,
      bearer: none.token,
      body: requestBody(),
      contentType: "application/json",
    });
    if (bodiless.kind !== "streamed") {
      throw new Error(`expected a stream, got ${bodiless.kind}`);
    }
    expect(bodiless.response.body).toBeNull();
    expect(none.logs.map((each) => each.operation)).toEqual(["broker.forward"]);
  });

  it("forwards a request that carries no content type", async () => {
    const h = await harness();

    const outcome = await forwardModelRequest(h.deps, {
      sessionId: SESSION,
      bearer: h.token,
      body: requestBody(),
      contentType: null,
    });

    expect(outcome.kind).toBe("streamed");
  });
});

describe("effort at the broker", () => {
  /** A fetch that keeps the upstream URL and body, answering an empty success. */
  function capturing(): {
    readonly fetchImpl: typeof fetch;
    readonly seen: { url: string; body: unknown }[];
  } {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const body = init?.body;
      seen.push({
        url: String(input),
        body: JSON.parse(new TextDecoder().decode(body as ArrayBuffer)),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  it.each([
    ["anthropic", "output_config", "/v1/messages"],
    ["openai", "reasoning", "/v1/responses"],
  ] as const)(
    "writes the token's effort into a %s request in the provider's own field, on its path",
    async (provider, field, path) => {
      const h = await harness({ provider, effort: "medium" });
      const upstream = capturing();
      const outcome = await forwardModelRequest(
        { ...h.deps, fetchImpl: upstream.fetchImpl },
        {
          sessionId: SESSION,
          bearer: h.token,
          body: requestBody(PROVIDER_ADAPTERS[provider].defaultModel.modelId),
          contentType: "application/json",
        },
      );
      expect(outcome.kind).toBe("streamed");
      expect(upstream.seen[0]?.url).toBe(`https://provider.double${path}`);
      expect(upstream.seen[0]?.body).toMatchObject({ [field]: { effort: "medium" } });
    },
  );

  // Composer attachments: an image a message carries reaches the provider in
  // the provider's own content block, whether or not the effort was rewritten.
  it.each([
    [
      "anthropic",
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
      "messages",
    ],
    [
      "openai",
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
      "input",
    ],
  ] as const)(
    "passes a %s image content block through untouched",
    async (provider, message, key) => {
      for (const effort of [null, "medium"] as const) {
        const h = await harness({ provider, effort });
        const upstream = capturing();
        const model = PROVIDER_ADAPTERS[provider].defaultModel.modelId;
        const body = new TextEncoder().encode(JSON.stringify({ model, [key]: [message] }))
          .buffer as ArrayBuffer;
        await forwardModelRequest(
          { ...h.deps, fetchImpl: upstream.fetchImpl },
          { sessionId: SESSION, bearer: h.token, body, contentType: "application/json" },
        );
        const sent = upstream.seen[0] as { body: Record<string, unknown> };
        expect(sent.body[key]).toEqual([message]);
        await env.DB.prepare("DELETE FROM model_connection WHERE connection_id = ?")
          .bind(CONNECTION)
          .run();
        await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?").bind(SESSION).run();
      }
    },
  );

  it("forwards a body that already names the token's effort unchanged", async () => {
    const h = await harness({ effort: "low" });
    const upstream = capturing();
    const body = new TextEncoder().encode(
      JSON.stringify({ model: MODEL, messages: [], output_config: { effort: "low", other: 1 } }),
    ).buffer as ArrayBuffer;
    await forwardModelRequest(
      { ...h.deps, fetchImpl: upstream.fetchImpl },
      { sessionId: SESSION, bearer: h.token, body, contentType: "application/json" },
    );
    expect(upstream.seen[0]?.body).toEqual({
      model: MODEL,
      messages: [],
      output_config: { effort: "low", other: 1 },
    });
  });

  it("refuses a body naming another effort than the token's", async () => {
    const h = await harness({ effort: "low" });
    const upstream = capturing();
    const body = new TextEncoder().encode(
      JSON.stringify({ model: MODEL, output_config: { effort: "max" } }),
    ).buffer as ArrayBuffer;
    expect(
      await forwardModelRequest(
        { ...h.deps, fetchImpl: upstream.fetchImpl },
        { sessionId: SESSION, bearer: h.token, body, contentType: null },
      ),
    ).toEqual({ kind: "denied" });
    expect(upstream.seen).toEqual([]);
  });

  it("refuses any named effort when the token was minted for none", async () => {
    const h = await harness();
    const upstream = capturing();
    const body = new TextEncoder().encode(
      JSON.stringify({ model: MODEL, output_config: { effort: "low" } }),
    ).buffer as ArrayBuffer;
    expect(
      await forwardModelRequest(
        { ...h.deps, fetchImpl: upstream.fetchImpl },
        { sessionId: SESSION, bearer: h.token, body, contentType: null },
      ),
    ).toEqual({ kind: "denied" });
    expect(upstream.seen).toEqual([]);
  });
});

describe("the prompt's counts", () => {
  const SYSTEM = [{ type: "text", text: "You are the agent. ".repeat(200) }];
  const TOOLS = [
    { name: "bash", description: "Run a command. ".repeat(50), input_schema: { type: "object" } },
    { name: "oncue_git_commit", description: "Commit. ".repeat(20), input_schema: {} },
  ];
  function agentBody(system: unknown = SYSTEM, tools: unknown = TOOLS): ArrayBuffer {
    return new TextEncoder().encode(
      JSON.stringify({ model: MODEL, system, tools, messages: [{ role: "user", content: "hi" }] }),
    ).buffer as ArrayBuffer;
  }

  async function forward(
    h: Harness,
    deps: ForwardDeps,
    body: ArrayBuffer,
    passthroughHeaders: Record<string, string> = {},
  ) {
    const outcome = await forwardModelRequest(deps, {
      sessionId: SESSION,
      bearer: h.token,
      body,
      contentType: "application/json",
      passthroughHeaders,
    });
    if (outcome.kind !== "streamed") {
      throw new Error(`expected a stream, got ${outcome.kind}`);
    }
    await outcome.response.text();
    const header = outcome.response.headers.get(PROMPT_COUNTS_HEADER);
    return header === null ? null : (JSON.parse(header) as Record<string, unknown>);
  }

  function counting(h: Harness, overrides: Partial<ForwardDeps> = {}) {
    const work: Promise<unknown>[] = [];
    const deps: ForwardDeps = {
      ...h.deps,
      promptCounts: new PromptCountCache(),
      waitUntil: (pending) => work.push(pending),
      ...overrides,
    };
    return { deps, work };
  }

  it("answers pending with the prompt's key, counts after the answer with the session's key, then answers the provider's counts", async () => {
    const h = await harness();
    const { deps, work } = counting(h);

    const first = await forward(h, deps, agentBody(), { "anthropic-beta": "beta-flag" });
    expect(first).toEqual({ key: expect.stringMatching(/^[0-9a-f]{16}$/), status: "pending" });
    expect(work).toHaveLength(1);
    await Promise.all(work);

    const counts = h.calls.filter((call) => call.url.endsWith(COUNT_TOKENS_PATH));
    expect(counts).toHaveLength(4);
    for (const call of counts) {
      expect(call.headers["x-api-key"]).toBe(API_KEY);
      expect(call.headers["anthropic-version"]).toBeDefined();
      // The forward's beta flags reach the counter too.
      expect(call.headers["anthropic-beta"]).toBe("beta-flag");
    }
    const answers = counts.map((call) => call.counted?.inputTokens ?? -1);
    expect(await forward(h, deps, agentBody())).toEqual({
      key: first?.key,
      systemTokens: (answers[1] ?? 0) - (answers[0] ?? 0),
      toolsTokens: (answers[2] ?? 0) - (answers[1] ?? 0),
      oncueToolsTokens: (answers[3] ?? 0) - (answers[2] ?? 0),
    });
    // Known now, so no second count.
    expect(work).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(API_KEY);
    expect(JSON.stringify(h.logs)).not.toContain("You are the agent");
  });

  it("gives a changed prompt its own key, and counts it again", async () => {
    const h = await harness();
    const { deps, work } = counting(h);
    const first = await forward(h, deps, agentBody());
    await Promise.all(work);
    const changed = await forward(h, deps, agentBody([{ type: "text", text: "Another prompt." }]));
    expect(changed?.status).toBe("pending");
    expect(changed?.key).not.toBe(first?.key);
    expect(work).toHaveLength(2);
  });

  it("remembers counts in the isolate's own cache when none is passed", async () => {
    const h = await harness();
    const work: Promise<unknown>[] = [];
    const deps: ForwardDeps = { ...h.deps, waitUntil: (pending) => work.push(pending) };
    const unique = agentBody([
      { type: "text", text: `Only this test's prompt ${crypto.randomUUID()}` },
    ]);
    expect((await forward(h, deps, unique))?.status).toBe("pending");
    await Promise.all(work);
    expect((await forward(h, deps, unique))?.systemTokens).toBeGreaterThan(0);
  });

  it("says nothing for a call without tools", async () => {
    const h = await harness();
    const { deps, work } = counting(h);
    expect(await forward(h, deps, requestBody())).toBeNull();
    expect(work).toHaveLength(0);
  });

  it("says nothing, and never throws, for tools too deep to read", async () => {
    const h = await harness();
    const { deps, work } = counting(h);
    // Built as text: an object this deep cannot be stringified to send.
    const text = `{"model":"${MODEL}","tools":[${"[".repeat(20_000)}1${"]".repeat(20_000)}],"messages":[]}`;
    const body = new TextEncoder().encode(text).buffer as ArrayBuffer;
    expect(await forward(h, deps, body)).toBeNull();
    expect(work).toHaveLength(0);
  });

  it("says nothing for a provider whose counter is not used", async () => {
    const openai = await harness({ provider: "openai" });
    const { deps, work } = counting(openai);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: PROVIDER_ADAPTERS.openai.defaultModel.modelId,
        tools: TOOLS,
        input: [],
      }),
    ).buffer as ArrayBuffer;
    expect(await forward(openai, deps, body)).toBeNull();
    expect(work).toHaveLength(0);
  });

  it("after the counter's 429, says unavailable and counts nothing more for the connection", async () => {
    const h = await harness();
    const { deps, work } = counting(h, {
      // The forward itself is answered; only the counter is refused.
      fetchImpl: async (input, init) =>
        String(input).endsWith(COUNT_TOKENS_PATH)
          ? Response.json({ type: "error" }, { status: 429 })
          : createProviderDouble("anthropic").fetchImpl(input, init),
    });
    expect((await forward(h, deps, agentBody()))?.status).toBe("pending");
    await Promise.all(work);
    const another = await forward(h, deps, agentBody([{ type: "text", text: "Different." }]));
    expect(another?.status).toBe("unavailable");
    expect(work).toHaveLength(1);
  });
});
