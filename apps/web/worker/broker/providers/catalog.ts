// The model catalog: one static table per provider. Static because a run
// record must be reproducible, the picker must not wait on a provider call,
// and OpenAI's `GET /models` carries no capabilities. Every row is transcribed
// from the provider's documentation as of `PRICES_AS_OF` (`docs/decisions.md`);
// `catalog.test.ts` holds the invariants.
//
// Effort levels are the provider's own words and order, exactly as documented:
// GPT-6 Astra returns 400 on `none`, so it is not offered; Haiku 4.5 and
// Sonnet 4.5 have no effort parameter, so they carry `null` and the composer
// shows no control. The broker sends the recorded level on every request, so
// a provider default never applies; `defaultEffort` is only where the slider
// opens.

import { EFFORT_LEVELS, type EffortLevel } from "@oncue/protocol";
import type { ProviderId } from "./adapter";

export { EFFORT_LEVELS, type EffortLevel };

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The date the prices and limits below were read from the providers' pages. */
export const PRICES_AS_OF = "2026-09-23";

/**
 * The date the cache prices were read: Anthropic's pricing page
 * (platform.claude.com/docs/en/about-claude/pricing, "5m cache writes" and
 * "Cache hits and refreshes") and OpenAI's (developers.openai.com/api/docs/pricing,
 * "Cached input" and "Cache writes" at short context, 272K input tokens or fewer).
 */
export const CACHE_PRICES_AS_OF = "2026-10-05";

export interface ModelSpec {
  readonly provider: ProviderId;
  /** The provider's own id, sent as `model` on every request. */
  readonly modelId: string;
  /** The provider's own display name. */
  readonly name: string;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /** The synchronous max output in tokens. */
  readonly maxOutput: number;
  /** The levels the provider documents for this model; `null` when it has no effort parameter. */
  readonly effort: readonly EffortLevel[] | null;
  /** Where the slider opens: the documented default, or our choice where none is documented. */
  readonly defaultEffort: EffortLevel | null;
  /** How the model thinks: steered by effort (`adaptive`), by a token budget (`extended`), or not at all. */
  readonly thinking: "adaptive" | "extended" | "none";
  /**
   * The provider's list price on `PRICES_AS_OF`, in USD per million tokens.
   * The cache prices were read on `CACHE_PRICES_AS_OF`: Anthropic's 5-minute
   * cache write, which is what OpenCode asks for, and OpenAI's short-context
   * rates. Only the browser's cost estimate reads them.
   */
  readonly price: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cacheReadPerMTok: number;
    readonly cacheWritePerMTok: number;
  };
  /** `legacy` rows stay only so something can still name them (the cost guard pins Sonnet 4.5). */
  readonly status: "current" | "legacy";
  /** The model a fresh connection starts on; exactly one per provider. */
  readonly recommended: boolean;
  /**
   * Whether the model reads a message's images; true only where a source says
   * so. False sends images to the agent as files it can read but not see.
   */
  readonly imageInput: boolean;
}

const ANTHROPIC_EFFORT: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Anthropic, from the models overview, the effort page, and the pricing page. */
const CLAUDE_OPUS_5_5: ModelSpec = {
  provider: "anthropic",
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  effort: ANTHROPIC_EFFORT,
  defaultEffort: "medium",
  thinking: "adaptive",
  // Opus 5.5 reads its cache at 0.05 times input, not the usual 0.1: the
  // pricing page's footnote 2, as of `CACHE_PRICES_AS_OF`.
  price: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  status: "current",
  recommended: true,
  imageInput: true,
};

export const ANTHROPIC_MODELS: readonly ModelSpec[] = [
  {
    provider: "anthropic",
    modelId: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effort: ANTHROPIC_EFFORT,
    defaultEffort: "high",
    thinking: "adaptive",
    // Fable 5.1 reads its cache at 0.025 times input: the pricing page's
    // footnote 1, as of `CACHE_PRICES_AS_OF`.
    price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5 },
    status: "current",
    recommended: false,
    imageInput: true,
  },
  CLAUDE_OPUS_5_5,
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effort: ANTHROPIC_EFFORT,
    defaultEffort: "high",
    thinking: "adaptive",
    price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    status: "current",
    recommended: false,
    imageInput: true,
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    effort: null,
    defaultEffort: null,
    thinking: "extended",
    price: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    status: "current",
    recommended: false,
    imageInput: true,
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    effort: null,
    defaultEffort: null,
    thinking: "extended",
    price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    status: "legacy",
    recommended: false,
    imageInput: true,
  },
];

const GPT6_EFFORT: readonly EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

/** OpenAI, from each model's own page and the reasoning guide. */
const GPT_6_SOL: ModelSpec = {
  provider: "openai",
  modelId: "gpt-6-sol",
  name: "GPT-6 Sol",
  contextWindow: 1_050_000,
  maxOutput: 128_000,
  effort: GPT6_EFFORT,
  defaultEffort: "medium",
  thinking: "adaptive",
  price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  status: "current",
  recommended: true,
  imageInput: true,
};

export const OPENAI_MODELS: readonly ModelSpec[] = [
  {
    provider: "openai",
    modelId: "gpt-6-astra",
    name: "GPT-6 Astra",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    // Astra's page lists no `none`; the reasoning guide says setting it
    // returns HTTP 400.
    effort: ["low", "medium", "high", "xhigh", "max"],
    // Undocumented; `medium` matches its siblings' default.
    defaultEffort: "medium",
    thinking: "adaptive",
    price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
    status: "current",
    recommended: false,
    imageInput: true,
  },
  GPT_6_SOL,
  {
    provider: "openai",
    modelId: "gpt-6-luna",
    name: "GPT-6 Luna",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    effort: GPT6_EFFORT,
    defaultEffort: "medium",
    thinking: "adaptive",
    price: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cacheReadPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
    },
    status: "current",
    recommended: false,
    imageInput: true,
  },
];

const CATALOG: Readonly<Record<ProviderId, readonly ModelSpec[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
};

/** Every model of a provider, current and legacy, in the provider's own order. */
export function catalogFor(provider: ProviderId): readonly ModelSpec[] {
  return CATALOG[provider];
}

/**
 * The row for an id, or `null`: an id is validated against this at every
 * trust boundary. The provider is a string because a stored run record's
 * provider is one (the fake driver's `oncue-fake` among them), and an
 * unknown provider has no rows rather than no table.
 */
export function findModel(provider: string, modelId: string): ModelSpec | null {
  const models = (CATALOG as Readonly<Record<string, readonly ModelSpec[] | undefined>>)[provider];
  return models?.find((spec) => spec.modelId === modelId) ?? null;
}

const RECOMMENDED: Readonly<Record<ProviderId, ModelSpec>> = {
  anthropic: CLAUDE_OPUS_5_5,
  openai: GPT_6_SOL,
};

/**
 * The row with `recommended: true`, named as a constant so the lookup has no
 * "not found" arm; the catalog test proves the two agree.
 */
export function recommendedModel(provider: ProviderId): ModelSpec {
  return RECOMMENDED[provider];
}

/** A model with no effort parameter accepts only `null`, which is what its run records. */
export function acceptsEffort(spec: ModelSpec, effort: EffortLevel | null): boolean {
  if (spec.effort === null) {
    return effort === null;
  }
  return effort !== null && spec.effort.includes(effort);
}
