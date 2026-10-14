/**
 * The session's context meter, derived from the session view alone. Every
 * figure comes from `message.completed`'s `usage`, which the bridge builds
 * from the harness's own token report (record 04). "Context used" is the
 * latest answer's whole input, cached or not, plus what it wrote: the size of
 * the conversation the next model call reads (`docs/decisions.md`). The
 * breakdown is exact or absent: the system prompt and tools are the provider's
 * own counts (`prompt`), and the conversation is the rest of the size. A
 * subagent's answers (record 12) are a conversation of their own: they never
 * size the primary agent's context, but their spend is in the cost.
 */

import type { MessageView, RunView, SessionView, TokenUsage } from "@oncue/protocol";
import type {
  ModelCatalog,
  ModelConnectionSummary,
  ModelPrice,
  ModelProvider,
  ModelSpecSummary,
} from "@/lib/api/setup";

/** Tokens by kind, each counted once; `output` includes reasoning. */
export interface TokenSplit {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export type ContextNote =
  /** This sandbox generation's harness started over from the session's summary. */
  | { readonly kind: "fresh_after_resume" }
  /** The size fell by more than `COMPACTION_DROP` between two answers: the harness compacted. */
  | { readonly kind: "compacted"; readonly from: number; readonly to: number };

export type CategoryId = "system" | "tools" | "oncueTools" | "conversation";

/** One part of the size, in the order the bar draws them. */
export interface ContextCategory {
  readonly id: CategoryId;
  readonly label: string;
  readonly tokens: number;
}

export const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = {
  system: "System prompt",
  tools: "Tools",
  oncueTools: "OnCue tools",
  conversation: "Conversation",
};

export type ContextBreakdown =
  /** Every part is exact, and they sum to `used`. A part the prompt does not have is left out. */
  | { readonly kind: "exact"; readonly categories: readonly ContextCategory[] }
  /** The provider can be counted, and the broker had not counted this prompt by its answer. */
  | { readonly kind: "pending" }
  /** The broker could not count this prompt for now: repeated failures, a rate limit, or the session's budget. */
  | { readonly kind: "unavailable" }
  /** The answer's provider has no counter OnCue uses, so there is no breakdown, never a guess. */
  | { readonly kind: "unsupported"; readonly provider: string }
  /** No answer yet, or an answer whose call carried no counts (one without tools), or an older record. */
  | { readonly kind: "none" };

export interface ContextMeterView {
  /** The latest answer's conversation size, or `null` before this conversation's first answer. */
  readonly used: number | null;
  /** The model's window, from the answer or else the catalog; `null` when neither knows. */
  readonly window: number | null;
  readonly breakdown: ContextBreakdown;
  /** The size at which the harness compacts on its own, where its rule is known; else `null`. */
  readonly compactsAt: number | null;
  /** Some answers were recorded before cache counts were kept, so the cost runs low. */
  readonly costLow: boolean;
  /** USD at list prices; `null` when no answer's model has a price. */
  readonly costUsd: number | null;
  /** Some answers' tokens could not be priced, so the cost leaves them out. */
  readonly costPartial: boolean;
  /**
   * Some OpenAI call read more than `OPENAI_LONG_CONTEXT_ABOVE` tokens, which
   * OpenAI prices higher than the catalog's short-context rates, so the cost runs low.
   */
  readonly costLongContext: boolean;
  readonly note: ContextNote | null;
}

/**
 * A fall in a call's input larger than this share of the previous call's reads
 * as a compaction. Input alone is compared because a provider drops the last
 * answer's reasoning from the next call, which a high-effort answer makes large;
 * without a compaction a call's input only grows.
 */
export const COMPACTION_DROP = 0.25;

/**
 * OpenAI's short-context prices hold up to this many input tokens a call; past
 * it a call costs more (developers.openai.com/api/docs/pricing, as of the catalog's `CACHE_PRICES_AS_OF`).
 */
export const OPENAI_LONG_CONTEXT_ABOVE = 272_000;

const ZERO: TokenSplit = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** True for usage recorded with the cache split; older usage has only input and output. */
function hasSplit(usage: TokenUsage): boolean {
  return usage.cacheWriteTokens !== undefined;
}

/**
 * What the call read: input, cache read, and cache write. An answer from
 * before the split has only its size to go on.
 */
function inputSideOf(usage: TokenUsage): number {
  const split = splitOf(usage);
  return split === null ? usage.usedTokens : split.input + split.cacheRead + split.cacheWrite;
}

function splitOf(usage: TokenUsage): TokenSplit | null {
  if (!hasSplit(usage)) {
    return null;
  }
  return {
    input: usage.inputTokens ?? 0,
    cacheRead: usage.cachedInputTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0),
  };
}

/**
 * What one answer cost in tokens. An older answer has no cache counts, so its
 * input and output are all there is; without even those, its size stands in
 * as input.
 */
export function spentOf(usage: TokenUsage): TokenSplit {
  if (usage.spent !== undefined) {
    return {
      input: usage.spent.inputTokens,
      cacheRead: usage.spent.cachedInputTokens,
      cacheWrite: usage.spent.cacheWriteTokens,
      output: usage.spent.outputTokens + usage.spent.reasoningTokens,
    };
  }
  const split = splitOf(usage);
  if (split !== null) {
    return split;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return { ...ZERO, input: usage.usedTokens };
  }
  return { ...ZERO, input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 };
}

/**
 * A catalog from the connections' own lists, for a body that carried no whole
 * catalog: each connected provider's models, nothing for the rest.
 */
export function catalogOfConnections(connections: readonly ModelConnectionSummary[]): ModelCatalog {
  const catalog: Record<ModelProvider, readonly ModelSpecSummary[]> = { anthropic: [], openai: [] };
  for (const connection of connections) {
    if (connection.provider !== undefined && connection.models !== undefined) {
      catalog[connection.provider] = connection.models;
    }
  }
  return catalog;
}

/** The model a run names: enough to find its catalog row and to tell two models apart. */
export type MeterModel = Pick<NonNullable<RunView["model"]>, "provider" | "modelId">;

/** The catalog row a model names, or `undefined` for a model this build does not list. */
function specOfModel(catalog: ModelCatalog | undefined, model: MeterModel | null | undefined) {
  if (catalog === undefined || model === null || model === undefined) {
    return undefined;
  }
  const rows = (catalog as Readonly<Record<string, ModelCatalog[ModelProvider] | undefined>>)[
    model.provider
  ];
  return rows?.find((row) => row.modelId === model.modelId);
}

/** The catalog row a run's model names. */
function specOf(catalog: ModelCatalog | undefined, run: RunView | undefined) {
  return specOfModel(catalog, run?.model);
}

function sameModel(a: MeterModel, b: MeterModel): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

/** The latest answer's exact breakdown, or why there is none. */
function breakdownOf(answer: Answer | undefined): ContextBreakdown {
  if (answer === undefined || !hasSplit(answer.usage)) {
    return { kind: "none" };
  }
  const { prompt, promptStatus, usedTokens } = answer.usage;
  if (prompt === undefined) {
    if (promptStatus !== undefined) {
      return { kind: promptStatus };
    }
    const provider = answer.run?.model?.provider ?? "unknown";
    return provider === "anthropic" ? { kind: "none" } : { kind: "unsupported", provider };
  }
  const counted = prompt.systemTokens + prompt.toolsTokens + prompt.oncueToolsTokens;
  // The bridge sends only counts that fit; a stored event that breaks that shows nothing.
  if (counted > usedTokens) {
    return { kind: "none" };
  }
  const parts: ContextCategory[] = [
    { id: "system", label: CATEGORY_LABELS.system, tokens: prompt.systemTokens },
    { id: "tools", label: CATEGORY_LABELS.tools, tokens: prompt.toolsTokens },
    { id: "oncueTools", label: CATEGORY_LABELS.oncueTools, tokens: prompt.oncueToolsTokens },
  ];
  return {
    kind: "exact",
    categories: [
      ...parts.filter((part) => part.tokens > 0),
      { id: "conversation", label: CATEGORY_LABELS.conversation, tokens: usedTokens - counted },
    ],
  };
}

/** USD for tokens at a list price. A missing cache price is charged as plain input. */
export function costOf(tokens: TokenSplit, price: ModelPrice): number {
  const perToken =
    tokens.input * price.inputPerMTok +
    tokens.cacheRead * (price.cacheReadPerMTok ?? price.inputPerMTok) +
    tokens.cacheWrite * (price.cacheWritePerMTok ?? price.inputPerMTok) +
    tokens.output * price.outputPerMTok;
  return perToken / 1_000_000;
}

interface Answer {
  readonly message: MessageView;
  readonly usage: TokenUsage;
  readonly run: RunView | undefined;
  readonly generation: number;
}

/**
 * The meter for a session. Cheap enough per render: one pass over the messages.
 * `chosen` is a model the owner picked for the next run and has not sent yet.
 */
export function contextMeterOf(
  view: Pick<SessionView, "messages" | "runs" | "run" | "sandbox">,
  catalog: ModelCatalog | undefined,
  chosen: MeterModel | null = null,
): ContextMeterView {
  const answers: Answer[] = [];
  for (const message of view.messages.values()) {
    if (message.role !== "assistant" || message.usage === null) {
      continue;
    }
    const run = message.runId === null ? undefined : view.runs.get(message.runId);
    answers.push({
      message,
      usage: message.usage,
      run,
      generation: run?.sandboxGeneration ?? 0,
    });
  }

  let costLow = false;
  let costUsd: number | null = null;
  let costPartial = false;
  let costLongContext = false;
  for (const answer of answers) {
    const spent = spentOf(answer.usage);
    costLow ||= !hasSplit(answer.usage);
    costLongContext ||=
      answer.run?.model?.provider === "openai" &&
      inputSideOf(answer.usage) > OPENAI_LONG_CONTEXT_ABOVE;
    const price = specOf(catalog, answer.run)?.price;
    if (price === undefined) {
      costPartial = true;
      continue;
    }
    costUsd = (costUsd ?? 0) + costOf(spent, price);
  }
  if (costUsd === null) {
    costPartial = false;
    costLongContext = false;
  }

  // The harness's conversation lives as long as its sandbox generation; a new
  // one starts over from the session's summary. Only the primary agent's
  // answers size it: a subagent's report its own, smaller conversation.
  const generation = Math.max(view.run?.sandboxGeneration ?? 0, view.sandbox.generation);
  const primary = answers.filter((answer) => answer.message.agentId === undefined);
  // An answer that reports no tokens (one cancelled before its call answered)
  // sizes nothing, so it neither empties the gauge nor reads as a compaction.
  const current = primary.filter(
    (answer) => answer.generation === generation && answer.usage.usedTokens > 0,
  );
  const earlier = primary.some((answer) => answer.generation < generation);
  const latest = current.at(-1);

  let note: ContextNote | null = earlier ? { kind: "fresh_after_resume" } : null;
  for (let index = current.length - 1; index > 0; index -= 1) {
    const before = current[index - 1] as Answer;
    const after = current[index] as Answer;
    if (inputSideOf(after.usage) < inputSideOf(before.usage) * (1 - COMPACTION_DROP)) {
      note = { kind: "compacted", from: before.usage.usedTokens, to: after.usage.usedTokens };
      break;
    }
  }

  // The window is the next call's: the chosen model's, else the current
  // run's. The latest answer's own figures stand only while that answer's
  // model is still the one reading; after a change of model they describe the
  // model that was left, so the catalog's window is used until the new one answers.
  const reader = chosen ?? view.run?.model ?? null;
  const answered = latest?.run?.model ?? null;
  const changed = reader !== null && answered !== null && !sameModel(reader, answered);
  const window = changed
    ? (specOfModel(catalog, reader)?.contextWindow ?? null)
    : (latest?.usage.maxTokens ?? specOfModel(catalog, reader)?.contextWindow ?? null);
  return {
    used: latest?.usage.usedTokens ?? null,
    window,
    breakdown: breakdownOf(latest),
    compactsAt: changed ? null : (latest?.usage.compactsAtTokens ?? null),
    costLow,
    costUsd,
    costPartial,
    costLongContext,
    note,
  };
}

/** A token count in a few characters: 950, 10.1k, 623.3k, 1.2M. */
export function compactTokens(value: number): string {
  if (value < 1_000) {
    return String(value);
  }
  if (value < 999_950) {
    return `${trimmed(value / 1_000)}k`;
  }
  return `${trimmed(value / 1_000_000)}M`;
}

function trimmed(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/** A part's share of the window, always to one decimal as the expanded rows give it: 1.0%, 0.5%, 0.0%. */
export function shareOf(tokens: number, window: number): string {
  if (window <= 0 || tokens <= 0) {
    return "0.0%";
  }
  return `${Math.min(100, (tokens / window) * 100).toFixed(1)}%`;
}

/** The share of the window used, as a whole percent; under one percent but above zero reads as 1. */
export function percentUsed(used: number, window: number): number {
  if (window <= 0 || used <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(1, Math.round((used / window) * 100)));
}

/** Dollars to the cent; a sum below one cent reads as under it rather than as nothing. */
export function formatUsd(value: number): string {
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(2)}`;
}
