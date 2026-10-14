import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "./adapter";
import {
  ANTHROPIC_MODELS,
  acceptsEffort,
  CACHE_PRICES_AS_OF,
  catalogFor,
  EFFORT_LEVELS,
  findModel,
  isEffortLevel,
  OPENAI_MODELS,
  PRICES_AS_OF,
  recommendedModel,
} from "./catalog";

// The table's internal soundness, so nothing downstream needs a fallback arm.
// The rows themselves are transcriptions of provider pages (`docs/decisions.md`).
describe("the model catalog", () => {
  const all = [...ANTHROPIC_MODELS, ...OPENAI_MODELS];

  it("names each model once, under its own provider", () => {
    const ids = all.map((spec) => spec.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of ANTHROPIC_MODELS) {
      expect(spec.provider).toBe("anthropic");
    }
    for (const spec of OPENAI_MODELS) {
      expect(spec.provider).toBe("openai");
    }
  });

  it("recommends exactly one model per provider, the ones decision D1 named", () => {
    for (const provider of PROVIDER_IDS) {
      expect(catalogFor(provider).filter((spec) => spec.recommended)).toHaveLength(1);
    }
    expect(recommendedModel("anthropic").modelId).toBe("claude-opus-5-5");
    expect(recommendedModel("openai").modelId).toBe("gpt-6-sol");
  });

  it("says which models read images, true only where a source was read (composer attachments)", () => {
    // Every row reads images.
    expect(all.filter((spec) => spec.imageInput).map((spec) => spec.modelId)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5-20250929",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
  });

  it("gives every model with effort a default among its own levels, and adaptive thinking", () => {
    for (const spec of all) {
      if (spec.effort === null) {
        expect(spec.defaultEffort).toBeNull();
        expect(spec.thinking).not.toBe("adaptive");
        continue;
      }
      expect(spec.effort.length).toBeGreaterThan(0);
      expect(spec.defaultEffort).not.toBeNull();
      expect(spec.effort).toContain(spec.defaultEffort);
      expect(spec.thinking).toBe("adaptive");
      // Levels are listed in the catalog's own ascending order, each once.
      const ranks = spec.effort.map((level) => EFFORT_LEVELS.indexOf(level));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(new Set(ranks).size).toBe(ranks.length);
    }
  });

  it("carries the documented facts that matter most: Astra refuses none, Sonnet 4.5 is the one legacy row", () => {
    expect(findModel("openai", "gpt-6-astra")?.effort).not.toContain("none");
    expect(findModel("openai", "gpt-6-sol")?.effort).toContain("none");
    expect(all.filter((spec) => spec.status === "legacy").map((spec) => spec.modelId)).toEqual([
      "claude-sonnet-4-5-20250929",
    ]);
    expect(findModel("anthropic", "claude-haiku-4-5-20251001")?.effort).toBeNull();
    for (const spec of all) {
      expect(spec.contextWindow).toBeGreaterThan(0);
      expect(spec.maxOutput).toBeGreaterThan(0);
      expect(spec.price.inputPerMTok).toBeGreaterThan(0);
      expect(spec.price.outputPerMTok).toBeGreaterThan(0);
      expect(spec.name.length).toBeGreaterThan(0);
    }
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices a cache read below input and a cache write above it, as both providers do", () => {
    for (const spec of all) {
      expect(spec.price.cacheReadPerMTok).toBeGreaterThan(0);
      expect(spec.price.cacheReadPerMTok).toBeLessThan(spec.price.inputPerMTok);
      // Both providers price a short-lived cache write at 1.25 times input:
      // Anthropic's 5-minute write, and OpenAI's write for GPT-5.6 and later
      // (prompt-caching guide; the GPT-6 rows' listed prices agree), as of `CACHE_PRICES_AS_OF`.
      expect(spec.price.cacheWritePerMTok).toBeCloseTo(spec.price.inputPerMTok * 1.25, 6);
    }
    // Opus 5.5 reads its cache at 0.05 times input, Fable 5.1 at 0.025; the rest at 0.1.
    expect(findModel("anthropic", "claude-opus-5-5")?.price.cacheReadPerMTok).toBe(0.2);
    expect(findModel("anthropic", "claude-fable-5-1")?.price.cacheReadPerMTok).toBe(0.25);
    expect(findModel("anthropic", "claude-sonnet-4-5-20250929")?.price.cacheReadPerMTok).toBe(0.3);
    expect(CACHE_PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("finds a model by id under its provider only", () => {
    expect(findModel("anthropic", "claude-opus-5-5")?.name).toBe("Claude Opus 5.5");
    expect(findModel("openai", "claude-opus-5-5")).toBeNull();
    expect(findModel("anthropic", "not-a-model")).toBeNull();
  });

  it("accepts an effort only from the model's own list, and null only where there is no list", () => {
    const opus = findModel("anthropic", "claude-opus-5-5");
    const haiku = findModel("anthropic", "claude-haiku-4-5-20251001");
    const astra = findModel("openai", "gpt-6-astra");
    if (opus === null || haiku === null || astra === null) {
      throw new Error("catalog rows missing");
    }
    expect(acceptsEffort(opus, "medium")).toBe(true);
    expect(acceptsEffort(opus, "none")).toBe(false);
    expect(acceptsEffort(opus, null)).toBe(false);
    expect(acceptsEffort(haiku, null)).toBe(true);
    expect(acceptsEffort(haiku, "low")).toBe(false);
    expect(acceptsEffort(astra, "none")).toBe(false);
    expect(acceptsEffort(astra, "max")).toBe(true);
  });

  it("tells a level from any other value", () => {
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("very high")).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
    expect(isEffortLevel(null)).toBe(false);
  });

  it("recommends the row the table flags, for every provider", () => {
    for (const provider of PROVIDER_IDS) {
      const flagged = catalogFor(provider).find((spec) => spec.recommended);
      expect(recommendedModel(provider)).toBe(flagged);
    }
  });
});
