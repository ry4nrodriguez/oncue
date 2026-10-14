import type { ModelRecord, RunView } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import type { ModelSpecSummary } from "@/lib/api/setup";
import type { ModelRow } from "./ModelPicker";
import {
  canSwitchModel,
  isAnotherModel,
  switchRecord,
  switchRowOf,
  switchSummary,
} from "./model-switch";

const SONNET: ModelRecord = {
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  modelConnectionId: "conn_anthropic",
  authenticationType: "api_key",
  contextWindow: 1_000_000,
  effort: "high",
};

type RunFacts = Pick<RunView, "state" | "outcome" | "model">;

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return { state: "completed", outcome: "completed", model: SONNET, ...overrides };
}

function spec(overrides: Partial<ModelSpecSummary> = {}): ModelSpecSummary {
  return {
    modelId: "gpt-6-sol",
    name: "GPT-6 Sol",
    contextWindow: 1_050_000,
    effort: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    status: "current",
    recommended: true,
    ...overrides,
  };
}

function row(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    key: "conn_openai::gpt-6-sol",
    connectionId: "conn_openai",
    modelId: "gpt-6-sol",
    name: "GPT-6 Sol",
    provider: "openai",
    label: "openai sk-…9f2c",
    spec: spec(),
    ...overrides,
  };
}

describe("canSwitchModel", () => {
  it("is true once the latest run has ended, whatever its outcome", () => {
    expect(canSwitchModel(run())).toBe(true);
    expect(canSwitchModel(run({ state: "failed", outcome: "failed" }))).toBe(true);
  });

  it("is true on a paused or interrupted run, which the change ends and continues", () => {
    expect(canSwitchModel(run({ state: "paused", outcome: null }))).toBe(true);
    expect(canSwitchModel(run({ state: "interrupted", outcome: null }))).toBe(true);
  });

  it("is false while a run is working, before any run, and for a run with no model record", () => {
    for (const state of ["queued", "provisioning", "ready", "running", "waiting_for_approval"]) {
      expect(canSwitchModel(run({ state: state as RunView["state"], outcome: null }))).toBe(false);
    }
    expect(canSwitchModel(null)).toBe(false);
    expect(canSwitchModel(run({ model: null }))).toBe(false);
  });
});

describe("isAnotherModel", () => {
  it("compares the connection and the model, so the run's own row is not a change", () => {
    const own = { connectionId: "conn_anthropic", modelId: "claude-sonnet-5" };
    expect(isAnotherModel(run(), own)).toBe(false);
    expect(isAnotherModel(run(), { ...own, modelId: "claude-opus-5-5" })).toBe(true);
    expect(isAnotherModel(run(), { ...own, connectionId: "conn_other" })).toBe(true);
    expect(isAnotherModel(null, own)).toBe(true);
  });
});

describe("switchRowOf", () => {
  it("finds the chosen row, and nothing once its key has left the list or no choice is made", () => {
    const rows = [row()];
    expect(switchRowOf(rows, { connectionId: "conn_openai", modelId: "gpt-6-sol" })).toBe(rows[0]);
    expect(switchRowOf(rows, { connectionId: "conn_gone", modelId: "gpt-6-sol" })).toBeUndefined();
    expect(switchRowOf(rows, null)).toBeUndefined();
  });
});

describe("switchRecord", () => {
  it("names the connection and model with the catalog's window and the effort asked for", () => {
    expect(switchRecord(row(), "low")).toEqual({
      provider: "openai",
      modelId: "gpt-6-sol",
      modelConnectionId: "conn_openai",
      authenticationType: "api_key",
      contextWindow: 1_050_000,
      effort: "low",
    });
  });

  it("falls to the model's default for an effort it does not offer, or none named", () => {
    const anthropic = row({
      provider: "anthropic",
      spec: spec({ effort: ["low", "medium", "high"], defaultEffort: "high" }),
    });
    expect(switchRecord(anthropic, "none")?.effort).toBe("high");
    expect(switchRecord(anthropic, undefined)?.effort).toBe("high");
    expect(switchRecord(anthropic, null)?.effort).toBe("high");
  });

  it("records no effort for a model without one", () => {
    expect(
      switchRecord(row({ spec: spec({ effort: null, defaultEffort: null }) }), "high"),
    ).toMatchObject({ effort: null });
  });

  it("is null for a row with no provider or no catalog entry, which cannot be a change", () => {
    expect(switchRecord(row({ provider: undefined }), "low")).toBeNull();
    expect(switchRecord(row({ spec: null }), "low")).toBeNull();
  });
});

describe("switchSummary", () => {
  it("names the model, whose key is charged, and the effort the next run opens on", () => {
    expect(switchSummary({ row: row(), run: run(), usedTokens: 12_000 })).toEqual({
      modelName: "GPT-6 Sol",
      charged: "OpenAI key (openai sk-…9f2c)",
      effort: "high",
      shortfalls: [],
      endsRun: false,
    });
  });

  it("names the key by its provider alone when the connection's label says no more", () => {
    expect(
      switchSummary({ row: row({ label: "openai" }), run: run(), usedTokens: null }).charged,
    ).toBe("OpenAI key");
    expect(
      switchSummary({
        row: row({ provider: undefined, label: "A key" }),
        run: run(),
        usedTokens: null,
      }).charged,
    ).toBe("A key");
  });

  it("says a paused run will be ended, since a run keeps its model", () => {
    expect(
      switchSummary({ row: row(), run: run({ state: "paused", outcome: null }), usedTokens: null })
        .endsRun,
    ).toBe(true);
  });

  it("warns when the conversation is larger than the other model's window", () => {
    const small = row({ name: "Haiku 4.5", spec: spec({ contextWindow: 200_000 }) });
    expect(switchSummary({ row: small, run: run(), usedTokens: 250_000 }).shortfalls).toEqual([
      "This conversation is about 250k tokens, more than Haiku 4.5's 200k window. Earlier turns will be summarized or dropped.",
    ]);
  });

  it("warns when the conversation is close to the other model's window", () => {
    const small = row({ name: "Haiku 4.5", spec: spec({ contextWindow: 200_000 }) });
    expect(switchSummary({ row: small, run: run(), usedTokens: 170_000 }).shortfalls).toEqual([
      "This conversation is about 170k tokens, close to Haiku 4.5's 200k window.",
    ]);
  });

  it("says nothing when the window is merely smaller, the conversation fits, or its size or the window is unknown", () => {
    const small = row({ name: "Haiku 4.5", spec: spec({ contextWindow: 200_000 }) });
    // The meter shows the window; a smaller one that still fits is not a warning.
    expect(switchSummary({ row: small, run: run(), usedTokens: 10_000 }).shortfalls).toEqual([]);
    expect(switchSummary({ row: small, run: run(), usedTokens: null }).shortfalls).toEqual([]);
    expect(switchSummary({ row: row(), run: run(), usedTokens: null }).shortfalls).toEqual([]);
    expect(
      switchSummary({ row: row({ spec: null }), run: run(), usedTokens: 5 }).shortfalls,
    ).toEqual([]);
  });

  it("opens on the run's effort where the model offers it, else the model's default or none, and warns of neither", () => {
    const none = row({ name: "Sonnet 4.5", spec: spec({ effort: null, defaultEffort: null }) });
    expect(switchSummary({ row: none, run: run(), usedTokens: null })).toMatchObject({
      effort: null,
      shortfalls: [],
    });
    const fewer = row({ spec: spec({ effort: ["low", "medium"], defaultEffort: "medium" }) });
    expect(switchSummary({ row: fewer, run: run(), usedTokens: null })).toMatchObject({
      effort: "medium",
      shortfalls: [],
    });
    expect(
      switchSummary({
        row: row(),
        run: run({ model: { ...SONNET, effort: null } }),
        usedTokens: null,
      }),
    ).toMatchObject({ effort: "medium", shortfalls: [] });
  });
});
