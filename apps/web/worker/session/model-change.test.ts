import type { ModelRecord } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { resolveRuntime } from "../runtime/resolve";
import {
  type ConnectionFact,
  canSwitchLive,
  decideModelChange,
  type ModelChangeInput,
  sameModel,
} from "./model-change";

const SONNET: ModelRecord = {
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  modelConnectionId: "conn_anthropic",
  authenticationType: "api_key",
  contextWindow: 1_000_000,
  effort: "high",
};

/** What the browser sends for another model: only the connection and model ids are believed. */
const SOL_AS_SENT: ModelRecord = {
  provider: "openai",
  modelId: "gpt-6-sol",
  modelConnectionId: "conn_openai",
  authenticationType: "subscription",
  contextWindow: 7,
  effort: "low",
};

const OPENAI_KEY: ConnectionFact = { provider: "openai", authType: "api_key", status: "active" };

function input(overrides: Partial<ModelChangeInput> = {}): ModelChangeInput {
  return {
    requested: SOL_AS_SENT,
    continuesRunId: "run_1",
    checksOnly: false,
    latest: { runId: "run_1", state: "completed", model: SONNET },
    connection: OPENAI_KEY,
    envName: "hosted",
    modelAllowlist: undefined,
    resolveRuntime: (provider, effort) =>
      resolveRuntime({ requested: undefined, allowlist: undefined, provider, effort }),
    ...overrides,
  };
}

describe("sameModel", () => {
  it("is the connection, the provider, and the model together; effort and the rest are not the model", () => {
    const elsewise: ModelRecord = { ...SONNET, effort: "low", contextWindow: null };
    expect(sameModel(SONNET, elsewise)).toBe(true);
    expect(sameModel(SONNET, { ...SONNET, modelConnectionId: "conn_other" })).toBe(false);
    expect(sameModel(SONNET, { ...SONNET, modelId: "claude-opus-5-5" })).toBe(false);
    expect(sameModel(SONNET, { ...SONNET, provider: "openai" })).toBe(false);
  });
});

describe("decideModelChange: a start that keeps the model", () => {
  it("is `same` before the session has a run, without looking at anything else", () => {
    expect(decideModelChange(input({ latest: null, connection: null }))).toEqual({ kind: "same" });
  });

  it("is `same` for the latest run's connection and model at another effort", () => {
    expect(
      decideModelChange(input({ requested: { ...SONNET, effort: "low" }, connection: null })),
    ).toEqual({ kind: "same" });
  });
});

describe("decideModelChange: a start that names another model", () => {
  it("changes between runs, storing a record built from the connection row and the catalog", () => {
    expect(decideModelChange(input())).toEqual({
      kind: "changed",
      model: {
        provider: "openai",
        modelId: "gpt-6-sol",
        modelConnectionId: "conn_openai",
        // The row's and the catalog's, never the browser's.
        authenticationType: "api_key",
        contextWindow: 1_050_000,
        effort: "low",
      },
      supersedesRunId: null,
    });
  });

  it("changes to another model on the same connection", () => {
    const decision = decideModelChange(
      input({
        requested: { ...SONNET, modelId: "claude-opus-5-5", effort: "medium" },
        connection: { provider: "anthropic", authType: "api_key", status: "active" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "changed",
      model: { provider: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
    });
  });

  it("records a subscription connection as one", () => {
    const decision = decideModelChange(
      input({ connection: { ...OPENAI_KEY, authType: "subscription" } }),
    );
    expect(decision).toMatchObject({ model: { authenticationType: "subscription" } });
  });

  it("opens on the model's own default effort when the start names none", () => {
    const { effort: _effort, ...unnamed } = SOL_AS_SENT;
    const decision = decideModelChange(input({ requested: unnamed }));
    expect(decision).toMatchObject({ kind: "changed" });
    expect(decision.kind === "changed" && decision.model.effort).not.toBeUndefined();
  });

  it("records no effort for a model that has none", () => {
    const decision = decideModelChange(
      input({
        requested: { ...SONNET, modelId: "claude-sonnet-4-5-20250929", effort: null },
        connection: { provider: "anthropic", authType: "api_key", status: "active" },
      }),
    );
    expect(decision).toMatchObject({ kind: "changed", model: { effort: null } });
  });

  it.each([
    "verified",
    "completed_with_warnings",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ] as const)("changes after a run that ended %s, ending nothing", (state) => {
    expect(
      decideModelChange(input({ latest: { runId: "run_1", state, model: SONNET } })),
    ).toMatchObject({ kind: "changed", supersedesRunId: null });
  });

  it.each(["paused", "interrupted"] as const)(
    "changes on a %s run and names it as the run to end first, since a run keeps its model",
    (state) => {
      expect(
        decideModelChange(input({ latest: { runId: "run_1", state, model: SONNET } })),
      ).toMatchObject({ kind: "changed", supersedesRunId: "run_1" });
    },
  );

  it.each([
    "created",
    "queued",
    "provisioning",
    "ready",
    "running",
    "waiting_for_approval",
  ] as const)("refuses while the latest run is %s: nothing changes inside a run", (state) => {
    expect(decideModelChange(input({ latest: { runId: "run_1", state, model: SONNET } }))).toEqual({
      kind: "refused",
      reason: "wrong_state",
      detail: "the model can be changed only between runs; stop this run first",
    });
  });

  it("refuses a checks-only run, which prompts no model", () => {
    expect(decideModelChange(input({ checksOnly: true }))).toEqual({
      kind: "refused",
      reason: "unsupported",
      detail: "a checks-only run prompts no model, so it cannot change it",
    });
  });

  it.each([null, "run_0"])(
    "refuses a start that continues %s rather than the latest run, so a stale tab cannot move the model",
    (continuesRunId) => {
      expect(decideModelChange(input({ continuesRunId }))).toEqual({
        kind: "refused",
        reason: "wrong_state",
        detail:
          "the model can be changed only on a message that continues the session's latest run",
      });
    },
  );

  it("refuses a connection that is absent or another workspace's, as one answer", () => {
    expect(decideModelChange(input({ connection: null }))).toEqual({
      kind: "refused",
      reason: "wrong_state",
      detail: "that model connection is not available in this workspace",
    });
  });

  it.each(["invalid", "expired", "revoked", "attention_required"])(
    "refuses a connection that is %s",
    (status) => {
      expect(decideModelChange(input({ connection: { ...OPENAI_KEY, status } }))).toEqual({
        kind: "refused",
        reason: "wrong_state",
        detail:
          "that model connection is not active; add a working key under Settings, Model providers",
      });
    },
  );

  it("refuses a model named under a provider the connection is not", () => {
    expect(
      decideModelChange(
        input({ connection: { provider: "anthropic", authType: "api_key", status: "active" } }),
      ),
    ).toEqual({
      kind: "refused",
      reason: "unsupported",
      detail: "that model is not one this connection's provider offers",
    });
  });

  it("refuses a model the catalog does not hold", () => {
    expect(
      decideModelChange(input({ requested: { ...SOL_AS_SENT, modelId: "gpt-not-real" } })),
    ).toMatchObject({ kind: "refused", reason: "unsupported" });
  });

  it("refuses an effort the model does not offer, and none where it requires one", () => {
    const refusal = {
      kind: "refused",
      reason: "unsupported",
      detail: "that model does not offer that effort level",
    };
    // Anthropic's models document no `none`; a model with levels cannot run with no level.
    const opus = (effort: NonNullable<ModelRecord["effort"]> | null) =>
      decideModelChange(
        input({
          requested: { ...SONNET, modelId: "claude-opus-5-5", effort },
          connection: { provider: "anthropic", authType: "api_key", status: "active" },
        }),
      );
    expect(opus("none")).toEqual(refusal);
    expect(opus(null)).toEqual(refusal);
    // A model with no effort parameter takes none.
    expect(
      decideModelChange(
        input({
          requested: { ...SONNET, modelId: "claude-sonnet-4-5-20250929", effort: "high" },
          connection: { provider: "anthropic", authType: "api_key", status: "active" },
        }),
      ),
    ).toEqual(refusal);
  });

  it("refuses a model outside a local Worker's cost guard, and ignores the guard when hosted", () => {
    const pinned = { modelAllowlist: "claude-sonnet-4-5-20250929" };
    expect(decideModelChange(input({ ...pinned, envName: "local" }))).toEqual({
      kind: "refused",
      reason: "unsupported",
      detail: "this OnCue is pinned to other models",
    });
    expect(decideModelChange(input({ ...pinned, envName: "hosted" }))).toMatchObject({
      kind: "changed",
    });
  });

  it("refuses a model the session's harness cannot run, in the harness check's own words", () => {
    const decision = decideModelChange(
      input({
        // A session on Codex, which speaks only OpenAI's API, asked for an Anthropic model.
        latest: { runId: "run_1", state: "completed", model: SOL_AS_SENT },
        requested: SONNET,
        connection: { provider: "anthropic", authType: "api_key", status: "active" },
        resolveRuntime: (provider, effort) =>
          resolveRuntime({ requested: "codex", allowlist: "codex", provider, effort }),
      }),
    );
    expect(decision).toEqual({
      kind: "refused",
      reason: "unsupported",
      detail: "Codex cannot run this model's provider",
    });
  });
});

describe("canSwitchLive", () => {
  it("is true only for a harness that takes a model per prompt behind a bridge that says it configures one", () => {
    expect(canSwitchLive("opencode", ["model_switch"])).toBe(true);
    expect(canSwitchLive("opencode", ["tools", "model_switch"])).toBe(true);
  });

  it("is false for an older bridge, which names no such capability or has not connected", () => {
    expect(canSwitchLive("opencode", [])).toBe(false);
    expect(canSwitchLive("opencode", null)).toBe(false);
  });

  it.each(["codex", "pi", "claude"] as const)(
    "is false for %s, which keeps the model it started on",
    (runtime) => {
      expect(canSwitchLive(runtime, ["model_switch"])).toBe(false);
    },
  );
});
