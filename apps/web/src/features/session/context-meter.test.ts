import type { MessageView, RunView, SessionView, TokenUsage } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelConnectionSummary, ModelSpecSummary } from "@/lib/api/setup";
import {
  COMPACTION_DROP,
  catalogOfConnections,
  compactTokens,
  contextMeterOf,
  costOf,
  formatUsd,
  percentUsed,
  shareOf,
} from "./context-meter";

const SONNET: ModelSpecSummary = {
  modelId: "claude-sonnet-4-5-20250929",
  name: "Claude Sonnet 4.5",
  contextWindow: 200_000,
  effort: null,
  defaultEffort: null,
  price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  status: "legacy",
  recommended: false,
};
const CATALOG: ModelCatalog = { anthropic: [SONNET], openai: [] };

type MeterView = Pick<SessionView, "messages" | "runs" | "run" | "sandbox">;

function run(runId: string, generation: number, modelId = SONNET.modelId): RunView {
  return {
    runId,
    sandboxGeneration: generation,
    model: { provider: "anthropic", modelId },
  } as unknown as RunView;
}

/** A call's usage the way the bridge writes it now. */
function usage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  extra: Partial<TokenUsage> = {},
): TokenUsage {
  return {
    usedTokens: input + cacheRead + cacheWrite + output,
    maxTokens: 200_000,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: 0,
    ...extra,
  };
}

function answer(messageId: string, runId: string | null, used: TokenUsage | null): MessageView {
  return { messageId, runId, role: "assistant", usage: used } as unknown as MessageView;
}

function viewOf(
  messages: readonly MessageView[],
  runs: readonly RunView[],
  generation = runs.at(-1)?.sandboxGeneration ?? 0,
): MeterView {
  return {
    messages: new Map(messages.map((message) => [message.messageId, message])) as never,
    runs: new Map(runs.map((each) => [each.runId, each])) as never,
    run: runs.at(-1) ?? null,
    sandbox: { generation } as SessionView["sandbox"],
  };
}

describe("contextMeterOf", () => {
  it("is empty before the first answer, with the window from the run's model", () => {
    const meter = contextMeterOf(viewOf([], [run("r1", 1)]), CATALOG);
    expect(meter).toMatchObject({
      used: null,
      window: 200_000,
      breakdown: { kind: "none" },
      compactsAt: null,
      note: null,
    });
    expect(meter.costUsd).toBeNull();
    expect(contextMeterOf(viewOf([], []), undefined).window).toBeNull();
  });

  it("fills from the latest answer, cache included, and sums every answer for the session", () => {
    const meter = contextMeterOf(
      viewOf(
        [
          answer("m1", "r1", usage(2, 0, 9_402, 87)),
          // A user's message and an answer still streaming carry no usage.
          { messageId: "u1", runId: "r1", role: "user", usage: null } as unknown as MessageView,
          answer("m2", "r1", null),
          answer("m3", "r1", usage(2, 9_402, 457, 253)),
        ],
        [run("r1", 1)],
      ),
      CATALOG,
    );
    expect(meter.used).toBe(10_114);
    expect(meter.window).toBe(200_000);
    // No prompt counts and no status: this call carried none, so there is no breakdown, never a guess.
    expect(meter.breakdown).toEqual({ kind: "none" });
    expect(meter.costLow).toBe(false);
    expect(meter.costUsd).toBeCloseTo(
      (4 * 3 + 9_402 * 0.3 + 9_859 * 3.75 + 340 * 15) / 1_000_000,
      12,
    );
    expect(meter.costPartial).toBe(false);
  });

  it("counts reasoning as output, and a message's spend over its last call", () => {
    const spent = {
      inputTokens: 10,
      outputTokens: 100,
      cachedInputTokens: 5_000,
      cacheWriteTokens: 200,
      reasoningTokens: 40,
    };
    const meter = contextMeterOf(
      viewOf(
        [
          answer(
            "m1",
            "r1",
            usage(5, 2_500, 100, 50, { reasoningTokens: 20, usedTokens: 2_675, spent }),
          ),
        ],
        [run("r1", 1)],
      ),
      CATALOG,
    );
    expect(meter.used).toBe(2_675);
    // The cost is the whole spend, reasoning priced as output.
    expect(meter.costUsd).toBeCloseTo(
      (10 * 3 + 5_000 * 0.3 + 200 * 3.75 + 140 * 15) / 1_000_000,
      12,
    );
  });

  it("shows an answer from before the split by its size alone, and says the totals run low", () => {
    const meter = contextMeterOf(
      viewOf(
        [
          answer("m1", "r1", {
            usedTokens: 255,
            maxTokens: 200_000,
            inputTokens: 2,
            outputTokens: 253,
          }),
          answer("m2", "r1", { usedTokens: 300, maxTokens: 200_000 }),
        ],
        [run("r1", 1)],
      ),
      CATALOG,
    );
    expect(meter).toMatchObject({ used: 300, breakdown: { kind: "none" }, costLow: true });
    // Priced from input and output alone, or the size as input when there is nothing else.
    expect(meter.costUsd).toBeCloseTo((302 * 3 + 253 * 15) / 1_000_000, 12);
    expect(
      contextMeterOf(
        viewOf(
          [answer("m1", "r1", { usedTokens: 9, maxTokens: 10, outputTokens: 9 })],
          [run("r1", 1)],
        ),
        CATALOG,
      ).costUsd,
    ).toBeCloseTo((9 * 15) / 1_000_000, 12);
  });

  it("starts over at a new sandbox generation, and says the conversation began from a summary", () => {
    const before = answer("m1", "r1", usage(2, 150_000, 500, 400));
    const waiting = contextMeterOf(viewOf([before], [run("r1", 1), run("r2", 2)]), CATALOG);
    expect(waiting).toMatchObject({
      used: null,
      window: 200_000,
      note: { kind: "fresh_after_resume" },
    });
    // The cost still counts the first sandbox's calls.
    expect(waiting.costUsd).toBeGreaterThan(0);
    const after = contextMeterOf(
      viewOf([before, answer("m2", "r2", usage(2, 0, 6_000, 100))], [run("r1", 1), run("r2", 2)]),
      CATALOG,
    );
    expect(after).toMatchObject({ used: 6_102, note: { kind: "fresh_after_resume" } });
    // A sandbox already replaced, before the next run is queued, also starts over.
    expect(contextMeterOf(viewOf([before], [run("r1", 1)], 2), CATALOG).used).toBeNull();
  });

  it("reads a large drop within one sandbox as a compaction, and a small one as nothing", () => {
    const big = answer("m1", "r1", usage(2, 160_000, 1_000, 900));
    const compacted = answer("m2", "r1", usage(2, 0, 30_000, 2_000));
    const meter = contextMeterOf(viewOf([big, compacted], [run("r1", 1)]), CATALOG);
    expect(meter.note).toEqual({ kind: "compacted", from: 161_902, to: 32_002 });
    expect(meter.used).toBe(32_002);
    // Dropping the last answer's reasoning shrinks the next call a little.
    const slight = answer("m2", "r1", usage(2, 161_000, 0, 10));
    expect(contextMeterOf(viewOf([big, slight], [run("r1", 1)]), CATALOG).note).toBeNull();
    expect(COMPACTION_DROP).toBe(0.25);
  });

  it("sizes only the primary agent's context, and counts a subagent's spend in the cost", () => {
    const primary = answer("m1", "r1", usage(2, 9_402, 457, 253));
    // A subagent's own conversation: smaller, later, and no compaction of the primary agent's.
    const child = {
      ...answer("c1", "r1", usage(2, 0, 1_500, 120)),
      agentId: "ses_child",
    } as unknown as MessageView;
    const meter = contextMeterOf(viewOf([primary, child], [run("r1", 1)]), CATALOG);
    expect(meter.used).toBe(10_114);
    expect(meter.note).toBeNull();
    const alone = contextMeterOf(viewOf([primary], [run("r1", 1)]), CATALOG);
    expect(meter.costUsd).toBeCloseTo(
      (alone.costUsd ?? 0) + (2 * 3 + 1_500 * 3.75 + 120 * 15) / 1_000_000,
      12,
    );
    // With only a subagent's answers so far, the primary agent's context is still unknown.
    expect(contextMeterOf(viewOf([child], [run("r1", 1)]), CATALOG).used).toBeNull();
  });

  it("keeps the last real size when an answer is cancelled before its call answers", () => {
    const real = answer("m1", "r1", usage(2, 38_000, 2_000, 400));
    const cancelled = answer("m2", "r1", { ...usage(0, 0, 0, 0), usedTokens: 0 });
    const meter = contextMeterOf(viewOf([real, cancelled], [run("r1", 1)]), CATALOG);
    expect(meter).toMatchObject({ used: 40_402, note: null });
  });

  it("does not read the provider dropping a long reasoning from the next call as a compaction", () => {
    // A high-effort answer: its size counts 30k of reasoning the next call does not read back.
    const thought = answer(
      "m1",
      "r1",
      usage(2, 40_000, 1_000, 500, { reasoningTokens: 30_000, usedTokens: 71_502 }),
    );
    const next = answer("m2", "r1", usage(2, 41_000, 1_200, 300));
    const meter = contextMeterOf(viewOf([thought, next], [run("r1", 1)]), CATALOG);
    expect(meter.used).toBe(42_502);
    expect(meter.note).toBeNull();
  });

  it("flags the estimate when an OpenAI call reads past the long-context price threshold", () => {
    const sol: ModelSpecSummary = { ...SONNET, modelId: "gpt-6-sol", contextWindow: 1_050_000 };
    const catalog: ModelCatalog = { anthropic: [SONNET], openai: [sol] };
    const openai = (generation: number) =>
      ({
        ...run("r1", generation),
        model: { provider: "openai", modelId: "gpt-6-sol" },
      }) as unknown as RunView;
    const long = answer("m1", "r1", usage(2, 280_000, 0, 100));
    expect(contextMeterOf(viewOf([long], [openai(1)]), catalog).costLongContext).toBe(true);
    const short = answer("m1", "r1", usage(2, 200_000, 0, 100));
    expect(contextMeterOf(viewOf([short], [openai(1)]), catalog).costLongContext).toBe(false);
    // Anthropic prices its whole window at one rate.
    expect(contextMeterOf(viewOf([long], [run("r1", 1)]), catalog).costLongContext).toBe(false);
    // With no price at all there is no estimate to flag.
    expect(
      contextMeterOf(viewOf([long], [openai(1)]), { anthropic: [], openai: [] }).costLongContext,
    ).toBe(false);
  });

  it("prices only answers whose model it knows, and says so", () => {
    const meter = contextMeterOf(
      viewOf(
        [
          answer("m1", "r1", usage(1_000_000, 0, 0, 0)),
          answer("m2", "r2", usage(1_000_000, 0, 0, 0)),
          answer("m3", null, usage(1, 0, 0, 0)),
        ],
        [run("r1", 1), run("r2", 1, "unlisted-model")],
      ),
      CATALOG,
    );
    expect(meter.costUsd).toBeCloseTo(3, 10);
    expect(meter.costPartial).toBe(true);
    const unpriced = contextMeterOf(
      viewOf([answer("m1", "r1", usage(1, 0, 0, 0))], [run("r1", 1, "unlisted-model")]),
      CATALOG,
    );
    expect(unpriced).toMatchObject({ costUsd: null, costPartial: false });
    const noModel = { ...run("r1", 1), model: null } as unknown as RunView;
    expect(
      contextMeterOf(viewOf([answer("m1", "r1", usage(1, 0, 0, 0))], [noModel]), CATALOG).costUsd,
    ).toBeNull();
    const otherProvider = { ...run("r1", 1), model: { provider: "oncue-fake", modelId: "x" } };
    expect(
      contextMeterOf(
        viewOf([answer("m1", "r1", usage(1, 0, 0, 0))], [otherProvider as unknown as RunView]),
        CATALOG,
      ).costUsd,
    ).toBeNull();
  });
});

describe("the window after a change of model", () => {
  const OPUS: ModelSpecSummary = {
    ...SONNET,
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
  };
  const BOTH: ModelCatalog = { anthropic: [SONNET, OPUS], openai: [] };
  const sized = usage(10, 0, 9_000, 200, { compactsAtTokens: 150_000 });

  it("is the chosen model's as soon as it is chosen, and drops the old model's compaction point", () => {
    const view = viewOf([answer("m1", "r1", sized)], [run("r1", 1)]);
    expect(contextMeterOf(view, BOTH)).toMatchObject({ window: 200_000, compactsAt: 150_000 });
    const chosen = contextMeterOf(view, BOTH, { provider: "anthropic", modelId: OPUS.modelId });
    // The size is still the last answer's; only what it is measured against moves.
    expect(chosen).toMatchObject({ used: sized.usedTokens, window: 1_000_000, compactsAt: null });
  });

  it("keeps the answer's own figures while the chosen model is the one that answered", () => {
    const view = viewOf([answer("m1", "r1", sized)], [run("r1", 1)]);
    const same = contextMeterOf(view, BOTH, { provider: "anthropic", modelId: SONNET.modelId });
    expect(same).toMatchObject({ window: 200_000, compactsAt: 150_000 });
  });

  it("is the new run's model's while that run has not answered, then that answer's own", () => {
    const waiting = viewOf([answer("m1", "r1", sized)], [run("r1", 1), run("r2", 1, OPUS.modelId)]);
    expect(contextMeterOf(waiting, BOTH)).toMatchObject({ window: 1_000_000, compactsAt: null });
    const answered = viewOf(
      [
        answer("m1", "r1", sized),
        answer("m2", "r2", usage(10, 9_000, 300, 100, { maxTokens: 900_000 })),
      ],
      [run("r1", 1), run("r2", 1, OPUS.modelId)],
    );
    expect(contextMeterOf(answered, BOTH).window).toBe(900_000);
  });

  it("says nothing of the window for a changed model the catalog does not list, rather than the old one's", () => {
    const view = viewOf(
      [answer("m1", "r1", sized)],
      [run("r1", 1), run("r2", 1, "claude-unlisted-9")],
    );
    expect(contextMeterOf(view, BOTH).window).toBeNull();
  });
});

describe("the exact breakdown", () => {
  const prompt = { systemTokens: 9_000, toolsTokens: 14_000, oncueToolsTokens: 1_900 };
  const counted = (extra: Partial<TokenUsage> = {}) =>
    answer("m1", "r1", usage(3, 40_000, 2_000, 500, { prompt, ...extra }));

  it("splits the size into the counted parts and the conversation, which is the rest exactly", () => {
    const meter = contextMeterOf(viewOf([counted()], [run("r1", 1)]), CATALOG);
    expect(meter.used).toBe(42_503);
    expect(meter.breakdown).toEqual({
      kind: "exact",
      categories: [
        { id: "system", label: "System prompt", tokens: 9_000 },
        { id: "tools", label: "Tools", tokens: 14_000 },
        { id: "oncueTools", label: "OnCue tools", tokens: 1_900 },
        { id: "conversation", label: "Conversation", tokens: 17_603 },
      ],
    });
    if (meter.breakdown.kind === "exact") {
      const sum = meter.breakdown.categories.reduce((total, part) => total + part.tokens, 0);
      expect(sum).toBe(meter.used);
    }
  });

  it("leaves out a part the prompt does not have, and keeps the conversation", () => {
    const meter = contextMeterOf(
      viewOf([counted({ prompt: { ...prompt, oncueToolsTokens: 0 } })], [run("r1", 1)]),
      CATALOG,
    );
    expect(
      meter.breakdown.kind === "exact" && meter.breakdown.categories.map((part) => part.id),
    ).toEqual(["system", "tools", "conversation"]);
  });

  it("says pending or unavailable as the broker said it", () => {
    for (const promptStatus of ["pending", "unavailable"] as const) {
      const meter = contextMeterOf(
        viewOf(
          [answer("m1", "r1", usage(3, 40_000, 2_000, 500, { promptStatus }))],
          [run("r1", 1)],
        ),
        CATALOG,
      );
      expect(meter.breakdown).toEqual({ kind: promptStatus });
    }
  });

  it("shows nothing for counts that cannot fit in the size", () => {
    const meter = contextMeterOf(
      viewOf([counted({ prompt: { ...prompt, systemTokens: 50_000 } })], [run("r1", 1)]),
      CATALOG,
    );
    expect(meter.breakdown).toEqual({ kind: "none" });
  });

  it("says a provider without a counter has no breakdown, rather than guessing one", () => {
    const openai = { ...run("r1", 1), model: { provider: "openai", modelId: "gpt-6-sol" } };
    const meter = contextMeterOf(
      viewOf([answer("m1", "r1", usage(3, 40_000, 0, 500))], [openai as unknown as RunView]),
      CATALOG,
    );
    expect(meter.breakdown).toEqual({ kind: "unsupported", provider: "openai" });
    const noModel = { ...run("r1", 1), model: null } as unknown as RunView;
    expect(
      contextMeterOf(viewOf([answer("m1", "r1", usage(3, 1, 0, 5))], [noModel]), CATALOG).breakdown,
    ).toEqual({ kind: "unsupported", provider: "unknown" });
  });

  it("passes on the harness's own compaction point", () => {
    const meter = contextMeterOf(
      viewOf([counted({ compactsAtTokens: 168_000 })], [run("r1", 1)]),
      CATALOG,
    );
    expect(meter.compactsAt).toBe(168_000);
  });
});

describe("shareOf", () => {
  it("gives a part's share of the window always to one decimal", () => {
    expect(shareOf(563_500, 1_000_000)).toBe("56.4%");
    expect(shareOf(20_000, 1_000_000)).toBe("2.0%");
    expect(shareOf(10_000, 1_000_000)).toBe("1.0%");
    expect(shareOf(5_000, 1_000_000)).toBe("0.5%");
    expect(shareOf(159, 1_000_000)).toBe("0.0%");
    expect(shareOf(0, 1_000_000)).toBe("0.0%");
    expect(shareOf(5, 0)).toBe("0.0%");
    expect(shareOf(300, 200)).toBe("100.0%");
  });
});

describe("costOf", () => {
  it("charges cache reads and writes at their own prices, or as input where none is listed", () => {
    const tokens = {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
    };
    expect(costOf(tokens, SONNET.price)).toBeCloseTo(3 + 0.3 + 3.75 + 15, 10);
    expect(costOf(tokens, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(3 + 3 + 3 + 15, 10);
  });
});

describe("catalogOfConnections", () => {
  it("takes each connected provider's models, and nothing from a connection without them", () => {
    const connections: ModelConnectionSummary[] = [
      { modelConnectionId: "c1", label: "Anthropic", provider: "anthropic", models: [SONNET] },
      { modelConnectionId: "c2", label: "OpenAI", provider: "openai" },
      { modelConnectionId: "c3", label: "Old" },
    ];
    expect(catalogOfConnections(connections)).toEqual({ anthropic: [SONNET], openai: [] });
  });
});

describe("formatting", () => {
  it("writes token counts in a few characters", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(10_114)).toBe("10.1k");
    expect(compactTokens(12_000)).toBe("12k");
    expect(compactTokens(161_902)).toBe("161.9k");
    expect(compactTokens(623_300)).toBe("623.3k");
    expect(compactTokens(200_000)).toBe("200k");
    expect(compactTokens(999_949)).toBe("999.9k");
    expect(compactTokens(999_950)).toBe("1M");
    expect(compactTokens(1_000_000)).toBe("1M");
    expect(compactTokens(1_050_000)).toBe("1.1M");
  });

  it("rounds the share up from nothing and never past the whole", () => {
    expect(percentUsed(0, 200_000)).toBe(0);
    expect(percentUsed(10, 200_000)).toBe(1);
    expect(percentUsed(66_000, 200_000)).toBe(33);
    expect(percentUsed(250_000, 200_000)).toBe(100);
    expect(percentUsed(5, 0)).toBe(0);
  });

  it("writes dollars to the cent, and a sliver as under a cent", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.4249)).toBe("$0.42");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
});
