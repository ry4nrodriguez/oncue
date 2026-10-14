/**
 * Runtime events to OnCue protocol event drafts, through two tables: no clock,
 * no event ids, no sequence numbers. `EVENT_TABLE` has a row per
 * `RuntimeEvent.kind` (a handler, or `DROP` for a known kind with no home), and
 * an unknown kind becomes debug `tool.output`. `TOOL_PART_TRANSITIONS` is total
 * over previous phase and incoming status, so a tool call cannot complete twice
 * or skip its prefix.
 *
 * `message.started` is emitted only for assistant messages (the user's message
 * arrives on the same wire), and every started message and tool call gets a
 * terminal: when the turn ends, open ones are closed here, because after an
 * abort OpenCode reports idle before it completes the aborted message. The
 * normalizer returns what an event means as a `RunSignal`; `agent.ts` decides
 * what happens to the run.
 */

import { type EventType, LIMITS, type PayloadOf, type TokenCounts } from "@oncue/protocol";
import type { RelayFailure } from "./agent";
import { OPENCODE_RUNTIME } from "./opencode";
import type { Draft } from "./protocol";
import type { RuntimeQuestion } from "./questions";
import type { PromptCounts, PromptCountsReading } from "./relay";

export type { PromptCounts, PromptCountsReading };

import type { RuntimePlan } from "./runtime";

export type ToolStatus = "pending" | "running" | "completed" | "error";

export interface ToolPart {
  readonly callId: string;
  /** The harness's own tool id (OpenCode's: bash, read, glob, grep, edit, write, apply_patch, webfetch, websearch, todowrite, task, skill, question, invalid, or something newer). The adapter's `toolCategory` maps it. */
  readonly tool: string;
  readonly status: ToolStatus;
  readonly title: string | null;
  /** Already bounded to the protocol's inline JSON limit by the parser. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: string | null;
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  /** The subagent a `task` call started, once the harness names it (`subagents.ts`). */
  readonly childSessionId?: string;
}

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface DiffFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/**
 * The bridge's intermediate vocabulary: what every runtime adapter's parser
 * produces from its harness's wire, and the only thing the reducer and this
 * normalizer read. OpenCode's parser is `opencode-wire.ts`. `sessionId` is the
 * harness conversation an event belongs to, when the wire says; the reducer
 * tells the primary agent's events from a subagent's by it (`subagents.ts`).
 */
export type RuntimeEvent = RuntimeEventBody & { readonly sessionId?: string };

type RuntimeEventBody =
  | { readonly kind: "server_connected" }
  | {
      readonly kind: "message_started";
      readonly messageId: string;
      readonly role: "assistant" | "user";
    }
  | {
      readonly kind: "text_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
    }
  /** A text part delivered whole (no `delta`). Replaces what was accumulated for that part. */
  | {
      readonly kind: "text_part";
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
    }
  | {
      readonly kind: "step_finished";
      readonly messageId: string;
      readonly reason: string;
      readonly usage: CallUsage | null;
    }
  | {
      readonly kind: "message_completed";
      readonly messageId: string;
      readonly finish: string | null;
      readonly usage: CallUsage | null;
      readonly error: { readonly name: string; readonly message: string } | null;
      /**
       * The harness reports this message's tokens after it (Codex's
       * `thread/tokenUsage/updated`), so `message.completed` waits for the next
       * `usage_reported` or the end of the turn. The run sees the text at once.
       */
      readonly usageFollows?: boolean;
    }
  /** One model call finished, reported apart from any message (Codex). */
  | { readonly kind: "usage_reported"; readonly usage: CallUsage }
  /** What the Model Broker said about the prompt of a successful call, from the relay. */
  | { readonly kind: "prompt_counts"; readonly reading: PromptCountsReading }
  | { readonly kind: "tool_part"; readonly messageId: string; readonly part: ToolPart }
  | { readonly kind: "todos"; readonly items: readonly TodoItem[] }
  | { readonly kind: "session_idle" }
  | {
      readonly kind: "session_error";
      readonly name: string;
      readonly message: string;
      readonly status: number | null;
    }
  | { readonly kind: "session_diff"; readonly files: readonly DiffFile[] }
  | { readonly kind: "file_edited"; readonly path: string }
  /**
   * The harness is holding a tool call until someone answers. The reducer
   * handles it (`secrets.ts` for OnCue's secret tool, `permissions.ts` for the
   * rest); the normalizer drops it, and the call still shows as a tool row.
   * `callId` is null for an ask the harness tied to no call.
   */
  | {
      readonly kind: "permission_asked";
      readonly requestId: string;
      readonly permission: string;
      readonly callId: string | null;
      /**
       * OpenCode's patterns and metadata for the ask; absent where the harness
       * gives none. For `task`, the patterns name the subagent.
       */
      readonly patterns?: readonly string[] | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
      /** The held call's input, where the harness sends it with the ask. */
      readonly input?: Readonly<Record<string, unknown>> | undefined;
    }
  /** A harness conversation began; a subagent's names the conversation that started it. */
  | {
      readonly kind: "session_created";
      readonly sessionId: string;
      readonly parentId: string | null;
      readonly title: string;
      readonly agent: string | null;
    }
  /**
   * A harness is waiting on the user's answer to up to four questions. The
   * reducer handles it (`questions.ts`); the normalizer drops it, and the
   * asking call still shows as a tool row.
   */
  | {
      readonly kind: "question_asked";
      readonly requestId: string;
      readonly callId: string | null;
      readonly questions: readonly RuntimeQuestion[];
      /** How many the harness asked; past the fourth they are answered as skipped. */
      readonly askedCount: number;
    }
  /** The harness says a question was answered or withdrawn. The reducer forgets it. */
  | { readonly kind: "question_settled"; readonly requestId: string }
  /**
   * The harness settled a permission request, whoever answered it: the bridge,
   * a reject it spread to every pending ask, or something inside the sandbox.
   */
  | { readonly kind: "permission_replied"; readonly requestId: string }
  /** A reasoning part. Dropped, but its ids are remembered so its streamed deltas are dropped too. */
  | { readonly kind: "reasoning"; readonly messageId: string; readonly partId: string }
  /** In `HOMELESS_KINDS`. Dropped, and the list proves it was a choice. */
  | { readonly kind: "homeless"; readonly wireKind: string }
  /** Never seen: debug `tool.output`. `raw` is size-capped by the parser. */
  | { readonly kind: "unknown"; readonly wireKind: string; readonly raw: string };

/**
 * One model call's tokens as a harness reports them, each kind counted once:
 * `input` excludes the cache, `output` excludes `reasoning`. A parser for a
 * provider whose input count includes cached tokens subtracts them.
 */
export interface CallUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** What one call's answer says about its prompt. */
export type CallPrompt =
  | { readonly kind: "counts"; readonly counts: PromptCounts }
  | { readonly kind: "status"; readonly status: "pending" | "unavailable" };

/** Prompt keys remembered per run; a run rarely sees more than a few prompts. */
export const PROMPT_MEMORY_LIMIT = 16;

/** The same for a harness that reports only input and output. */
export function plainUsage(input: number, output: number): CallUsage {
  return { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * A report with every count zero is no reading: OpenCode puts one on a message
 * aborted before its call answered, and Pi on a failed one. Taken as a size it
 * would empty the gauge and look like a compaction.
 */
export function readingOf(usage: CallUsage | null): CallUsage | null {
  if (usage === null) {
    return null;
  }
  const any =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.reasoning > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0;
  return any ? usage : null;
}

function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * What the timeline has already been told about one call. A settled call stays
 * `settled`, so the part OpenCode re-sends after an abort emits nothing.
 */
export type ToolPhase = "pending" | "running" | "settled";

export interface TrackedTool {
  readonly phase: ToolPhase;
  readonly startedAtMs: number | null;
  readonly title: string;
  readonly tool: string;
}

export type TrackedPart =
  | { readonly kind: "text"; readonly partId: string }
  | { readonly kind: "tool"; readonly callId: string };

export interface TrackedMessage {
  /** The user's own message rides the same wire; nothing of it is re-emitted, the instruction is already on the timeline. */
  readonly role: "assistant" | "user";
  readonly textByPartId: ReadonlyMap<string, string>;
  /** Text parts and tool calls in arrival order, which is the order `message.completed` reports. */
  readonly parts: readonly TrackedPart[];
  /** Reasoning part ids, so their `message.part.delta`s are dropped rather than streamed as text. */
  readonly reasoningPartIds: ReadonlySet<string>;
  /** The latest `step_finished`'s tokens: the call that sets the conversation's size. */
  readonly lastCall: CallUsage | null;
  readonly stopReason: string | null;
  readonly completed: boolean;
  /** Finished, with `message.completed` held for the tokens the harness reports next. */
  readonly awaitingUsage: boolean;
}

export interface NormalizerState {
  readonly tools: ReadonlyMap<string, TrackedTool>;
  readonly messages: ReadonlyMap<string, TrackedMessage>;
  readonly plan: { readonly planId: string; readonly revision: number } | null;
  /** Lazily emitted synthetic call for `unknown` kinds; null until the first one. */
  readonly debugToolCallId: string | null;
  readonly debugChunkIndex: number;
  /**
   * Calls reported by `usage_reported` that no message has taken yet: the
   * latest, and the sum. The next message completed without tokens of its own takes them.
   */
  readonly unclaimed: { readonly last: CallUsage; readonly sum: CallUsage } | null;
  /**
   * What the latest call's answer will carry about its prompt; cleared once a
   * message uses it, so a later message without a fresh reading carries none.
   */
  readonly promptCounts?: CallPrompt | null;
  /** Counts the broker gave for each prompt key this run, so a later "pending" for the same prompt is still exact. */
  readonly promptMemory?: ReadonlyMap<string, PromptCounts>;
}

export const emptyNormalizerState: NormalizerState = {
  tools: new Map(),
  messages: new Map(),
  plan: null,
  debugToolCallId: null,
  debugChunkIndex: 0,
  unclaimed: null,
};

/** What an event MEANS to the run, separate from what it renders as. `agent.ts` reads this and never a kind. */
export type RunSignal =
  | { readonly kind: "none" }
  | { readonly kind: "idle" }
  | { readonly kind: "error"; readonly name: string; readonly message: string }
  /** A `session_error` shaped like the relay's refusal; a backstop for the relay's own `model_failure` input. */
  | { readonly kind: "model_failure"; readonly failure: RelayFailure }
  | { readonly kind: "assistant_text"; readonly text: string }
  /** `overflow` is the whole output when `tool.completed` could carry only a cut of it; the reducer stages it as an artifact. */
  | { readonly kind: "tool_settled"; readonly overflow: ToolOverflow | null }
  /** OpenCode reported a changed diff. The reducer decides whether and when the bridge's own Git measures it. */
  | { readonly kind: "diff_changed" };

export interface ToolOverflow {
  readonly toolCallId: string;
  readonly text: string;
}

export interface NormalizeContext {
  readonly nowMs: number;
  /** Plan ids and the synthetic debug call id. Never an event id. */
  readonly newId: () => string;
  readonly runId: string;
  /** From the run's `ModelRecord`; null leaves `usage` null rather than inventing a ceiling. */
  readonly contextWindow: number | null;
  /** The harness's own compaction point for this model, where known (`RuntimePlan.autoCompactAt`). */
  readonly compactsAt?: number | null;
  /** The session's harness: its name on tool rows and its tool-category table. OpenCode's when absent. */
  readonly runtime?: Pick<RuntimePlan, "id" | "toolCategory"> | undefined;
}

export interface Advance {
  readonly state: NormalizerState;
  readonly drafts: readonly Draft[];
  readonly signal: RunSignal;
}

/**
 * `PayloadOf<T>` carries valibot's brands on every id; a draft is written
 * with plain strings and checked structurally. `stampDraft` runs the real
 * parser, which is where a wrong value is caught.
 */
export type Unbranded<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Unbranded<U>[]
    : T extends object
      ? { [K in keyof T]: Unbranded<T[K]> }
      : T;

export function draft<T extends EventType>(
  type: T,
  runId: string | null,
  payload: Unbranded<PayloadOf<T>>,
): Draft<T> {
  return { type, runId, payload } as unknown as Draft<T>;
}

export function shortText(text: string): string {
  return text.slice(0, LIMITS.shortTextChars);
}

export function summaryText(text: string): string {
  return text.slice(0, LIMITS.summaryTextChars);
}

function bodyText(text: string): string {
  return text.slice(0, LIMITS.bodyTextChars);
}

function streamChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += LIMITS.streamChunkChars) {
    chunks.push(text.slice(at, at + LIMITS.streamChunkChars));
  }
  return chunks;
}

/** `{ output }` cut until it fits the protocol's inline JSON limit; escaping can grow a string, so cut and re-measure. */
export function inlineOutput(output: string): {
  readonly value: Readonly<Record<string, unknown>>;
  readonly truncated: boolean;
} {
  let value: Record<string, unknown> = { output };
  let keep = output.length;
  let truncated = false;
  while (JSON.stringify(value).length > LIMITS.inlineJsonChars) {
    keep = Math.floor(Math.min(keep, LIMITS.inlineJsonChars) / 2);
    value = { output: output.slice(0, keep), truncated: true, droppedChars: output.length - keep };
    truncated = true;
  }
  return { value, truncated };
}

export type ToolDraftKind =
  | "requested_partial"
  | "requested_complete"
  | "started"
  | "completed"
  | "failed";

/**
 * Total over `(previous | "unseen") x incoming`. "unseen" rows synthesise the
 * requested/started prefix for a call whose `pending` was skipped or missed;
 * backwards moves are empty cells. The `settled` row is empty because OpenCode
 * re-sends a settled part: after an abort the bash call arrives `completed`
 * after `session.idle`, when the close-out has already failed it.
 */
export const TOOL_PART_TRANSITIONS: Readonly<
  Record<ToolPhase | "unseen", Readonly<Record<ToolStatus, readonly ToolDraftKind[]>>>
> = {
  unseen: {
    pending: ["requested_partial"],
    running: ["requested_complete", "started"],
    completed: ["requested_complete", "started", "completed"],
    error: ["requested_complete", "started", "failed"],
  },
  pending: {
    pending: ["requested_partial"],
    running: ["requested_complete", "started"],
    completed: ["requested_complete", "started", "completed"],
    error: ["requested_complete", "started", "failed"],
  },
  running: {
    pending: [],
    running: [],
    completed: ["completed"],
    error: ["failed"],
  },
  settled: {
    pending: [],
    running: [],
    completed: [],
    error: [],
  },
};

/** Permission text -> denied_by_policy; a timeout message -> timeout; anything else OpenCode reports is a runtime error. */
export function toolFailureCategory(error: string): PayloadOf<"tool.failed">["category"] {
  if (/timed?\s?out/i.test(error)) {
    return "timeout";
  }
  if (/permission|denied|not allowed|disabled|rejected/i.test(error)) {
    return "denied_by_policy";
  }
  return "runtime_error";
}

/** The synthetic call every unknown-kind debug line is attributed to, once per run. */
export const DEBUG_TOOL_TITLE = "Unmapped runtime events";

function durationOf(part: ToolPart, tracked: TrackedTool | undefined, nowMs: number): number {
  const start = part.startedAtMs ?? tracked?.startedAtMs ?? null;
  const end = part.endedAtMs ?? nowMs;
  return start === null ? 0 : Math.max(0, end - start);
}

function toolDraft(
  kind: ToolDraftKind,
  part: ToolPart,
  tracked: TrackedTool | undefined,
  ctx: NormalizeContext,
): Draft {
  const title = shortText(part.title ?? tracked?.title ?? part.tool);
  switch (kind) {
    case "requested_partial":
    case "requested_complete":
      return draft("tool.requested", ctx.runId, {
        toolCallId: part.callId,
        category: (ctx.runtime ?? OPENCODE_RUNTIME).toolCategory(part.tool),
        title,
        runtimeName: shortText(part.tool),
        input: part.input,
        inputComplete: kind === "requested_complete",
        approvalId: null,
      });
    case "started":
      return draft("tool.started", ctx.runId, { toolCallId: part.callId });
    case "completed":
      return draft("tool.completed", ctx.runId, {
        toolCallId: part.callId,
        durationMs: durationOf(part, tracked, ctx.nowMs),
        exitCode: part.exitCode,
        result: {
          kind: "inline",
          summary: summaryText(title),
          value: inlineOutput(part.output ?? "").value,
        },
      });
    case "failed": {
      const error = part.error ?? "tool failed";
      return draft("tool.failed", ctx.runId, {
        toolCallId: part.callId,
        durationMs: durationOf(part, tracked, ctx.nowMs),
        exitCode: part.exitCode,
        errorText: summaryText(error),
        category: toolFailureCategory(error),
        evidence: [],
      });
    }
  }
}

/**
 * `durationMs` from the part's own `time.start`/`time.end` when both are present,
 * else from the tracked start and `ctx.nowMs`, never negative. The result's
 * output is cut to the inline limit.
 */
function advanceTool(state: NormalizerState, part: ToolPart, ctx: NormalizeContext): Advance {
  const tracked = state.tools.get(part.callId);
  const previous = tracked?.phase ?? "unseen";
  const kinds = TOOL_PART_TRANSITIONS[previous][part.status];
  const drafts = kinds.map((kind) => toolDraft(kind, part, tracked, ctx));
  const tools = new Map(state.tools);
  const incomingSettled = part.status === "completed" || part.status === "error";
  // Only the move INTO settled counts: a re-sent settled part is a no-op.
  const settledNow = incomingSettled && previous !== "settled";
  if (settledNow) {
    tools.set(part.callId, {
      phase: "settled",
      startedAtMs: part.startedAtMs ?? tracked?.startedAtMs ?? null,
      title: part.title ?? tracked?.title ?? part.tool,
      tool: part.tool,
    });
  } else if (kinds.length > 0) {
    tools.set(part.callId, {
      phase: part.status === "pending" ? "pending" : "running",
      startedAtMs: part.startedAtMs ?? tracked?.startedAtMs ?? ctx.nowMs,
      title: part.title ?? tracked?.title ?? part.tool,
      tool: part.tool,
    });
  }
  const output = part.output ?? "";
  const overflow =
    settledNow && part.status === "completed" && inlineOutput(output).truncated
      ? { toolCallId: part.callId, text: output }
      : null;
  return {
    state: { ...state, tools },
    drafts,
    signal: settledNow ? { kind: "tool_settled", overflow } : { kind: "none" },
  };
}

/** Every call the timeline still has open, in arrival order. */
function openTools(state: NormalizerState): [string, TrackedTool][] {
  return [...state.tools].filter(([, tracked]) => tracked.phase !== "settled");
}

const EMPTY_MESSAGE: TrackedMessage = {
  role: "assistant",
  textByPartId: new Map(),
  parts: [],
  reasoningPartIds: new Set(),
  lastCall: null,
  stopReason: null,
  completed: false,
  awaitingUsage: false,
};

const USER_MESSAGE: TrackedMessage = { ...EMPTY_MESSAGE, role: "user" };

/**
 * The tracked message, started on the timeline if it was not already. A
 * message never announced is taken to be the assistant's: OpenCode announces
 * the user's message (`message.updated`, role user) before any part of it.
 */
function ensureMessage(
  state: NormalizerState,
  messageId: string,
  ctx: NormalizeContext,
): { readonly state: NormalizerState; readonly message: TrackedMessage; readonly drafts: Draft[] } {
  const existing = state.messages.get(messageId);
  if (existing !== undefined) {
    return { state, message: existing, drafts: [] };
  }
  const messages = new Map(state.messages);
  messages.set(messageId, EMPTY_MESSAGE);
  return {
    state: { ...state, messages },
    message: EMPTY_MESSAGE,
    drafts: [draft("message.started", ctx.runId, { messageId, role: "assistant" })],
  };
}

/** Parts of the user's own message are nothing: the instruction is already on the timeline. */
function isUserMessage(state: NormalizerState, messageId: string): boolean {
  return state.messages.get(messageId)?.role === "user";
}

function withMessage(
  state: NormalizerState,
  messageId: string,
  message: TrackedMessage,
): NormalizerState {
  const messages = new Map(state.messages);
  messages.set(messageId, message);
  return { ...state, messages };
}

function withPart(message: TrackedMessage, part: TrackedPart): TrackedMessage {
  const present = message.parts.some((existing) =>
    existing.kind === "text" && part.kind === "text"
      ? existing.partId === part.partId
      : existing.kind === "tool" && part.kind === "tool" && existing.callId === part.callId,
  );
  return present ? message : { ...message, parts: [...message.parts, part] };
}

function partIndex(message: TrackedMessage, partId: string): number {
  const index = message.parts.findIndex((part) => part.kind === "text" && part.partId === partId);
  return index === -1 ? message.parts.length : index;
}

/** The part joined to the message if new, and `text` appended to what it holds. */
function appendText(
  message: TrackedMessage,
  partId: string,
  text: string,
): { readonly message: TrackedMessage; readonly index: number } {
  const joined = withPart(message, { kind: "text", partId });
  const textByPartId = new Map(joined.textByPartId);
  textByPartId.set(partId, `${textByPartId.get(partId) ?? ""}${text}`);
  return { message: { ...joined, textByPartId }, index: partIndex(joined, partId) };
}

function stopReasonOf(
  finish: string | null,
  error: { readonly name: string } | null,
): PayloadOf<"message.completed">["stopReason"] {
  if (error !== null) {
    return error.name === "MessageAbortedError" ? "cancelled" : "error";
  }
  switch (finish) {
    case "tool-calls":
    case "tool_use":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "error":
      return "error";
    default:
      return "end_turn";
  }
}

function assistantText(message: TrackedMessage): string {
  return message.parts
    .flatMap((part) => (part.kind === "text" ? [message.textByPartId.get(part.partId) ?? ""] : []))
    .filter((text) => text.length > 0)
    .join("\n");
}

function completedParts(
  message: TrackedMessage,
): Unbranded<PayloadOf<"message.completed">["parts"]> {
  const parts: Unbranded<PayloadOf<"message.completed">["parts"][number]>[] = [];
  for (const part of message.parts) {
    if (part.kind === "tool") {
      parts.push({ type: "tool_ref", toolCallId: part.callId });
      continue;
    }
    const text = message.textByPartId.get(part.partId) ?? "";
    if (text.length > 0) {
      parts.push({ type: "text", text: bodyText(text) });
    }
  }
  return parts.slice(0, LIMITS.listItems);
}

/**
 * The usage fields for a call's prompt. Counts that do not fit inside the size
 * are not this call's, so they are left out rather than shown.
 */
function promptFieldsOf(
  prompt: CallPrompt | null,
  used: number,
): Partial<Unbranded<NonNullable<PayloadOf<"message.completed">["usage"]>>> {
  if (prompt === null) {
    return {};
  }
  if (prompt.kind === "status") {
    return { promptStatus: prompt.status };
  }
  const { systemTokens, toolsTokens, oncueToolsTokens } = prompt.counts;
  if (systemTokens + toolsTokens + oncueToolsTokens > used) {
    return {};
  }
  return {
    prompt: {
      systemTokens: tokens(systemTokens),
      toolsTokens: tokens(toolsTokens),
      oncueToolsTokens: tokens(oncueToolsTokens),
    },
  };
}

function tokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countsOf(usage: CallUsage): Unbranded<TokenCounts> {
  return {
    inputTokens: tokens(usage.input),
    outputTokens: tokens(usage.output),
    cachedInputTokens: tokens(usage.cacheRead),
    cacheWriteTokens: tokens(usage.cacheWrite),
    reasoningTokens: tokens(usage.reasoning),
  };
}

function sameCounts(a: Unbranded<TokenCounts>, b: Unbranded<TokenCounts>): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.reasoningTokens === b.reasoningTokens
  );
}

/**
 * The conversation's size after a message is its last call's whole input,
 * cached or not, plus what that call wrote, which the next call reads back
 * (`docs/decisions.md`). `spent` is every call the message accounts for, and
 * is left out when it is that one call.
 */
function usageOf(
  context: CallUsage | null,
  spent: CallUsage | null,
  contextWindow: number | null,
  prompt: CallPrompt | null = null,
  compactsAt: number | null = null,
): Unbranded<PayloadOf<"message.completed">["usage"]> {
  if (context === null || contextWindow === null) {
    return null;
  }
  const split = countsOf(context);
  const used =
    split.inputTokens +
    split.cachedInputTokens +
    split.cacheWriteTokens +
    split.outputTokens +
    split.reasoningTokens;
  const total = spent === null ? split : countsOf(spent);
  return {
    usedTokens: used,
    maxTokens: Math.max(contextWindow, used),
    ...split,
    ...(sameCounts(total, split) ? {} : { spent: total }),
    ...promptFieldsOf(prompt, used),
    ...(compactsAt === null ? {} : { compactsAtTokens: tokens(compactsAt) }),
  };
}

const STEP_STATUS: Readonly<
  Record<TodoItem["status"], PayloadOf<"plan.created">["steps"][number]["status"]>
> = {
  pending: "pending",
  in_progress: "active",
  completed: "complete",
  cancelled: "skipped",
};

export const PLAN_TITLE = "Task plan";

function planBody(planId: string, revision: number, items: readonly TodoItem[]) {
  const steps = items.slice(0, LIMITS.listItems).map((item) => ({
    stepId: shortText(item.id),
    title: shortText(item.content),
    status: STEP_STATUS[item.status],
  }));
  const active = items.find((item) => item.status === "in_progress");
  return {
    planId,
    revision,
    title: PLAN_TITLE,
    steps,
    activeStepId: active === undefined ? null : shortText(active.id),
    expectedVerification: [],
  };
}

function advanceTodos(
  state: NormalizerState,
  items: readonly TodoItem[],
  ctx: NormalizeContext,
): Advance {
  if (items.length === 0) {
    return { state, drafts: [], signal: { kind: "none" } };
  }
  const drafts: Draft[] = [];
  let plan: { readonly planId: string; readonly revision: number };
  if (state.plan === null) {
    plan = { planId: ctx.newId(), revision: 1 };
    drafts.push(draft("plan.created", ctx.runId, planBody(plan.planId, plan.revision, items)));
  } else {
    plan = { planId: state.plan.planId, revision: state.plan.revision + 1 };
    drafts.push(
      draft("plan.updated", ctx.runId, {
        ...planBody(plan.planId, plan.revision, items),
        changeSummary: null,
      }),
    );
  }
  const done = items.every((item) => item.status === "completed" || item.status === "cancelled");
  if (done) {
    drafts.push(
      draft("plan.completed", ctx.runId, {
        planId: plan.planId,
        revision: plan.revision,
        summary: summaryText(`${items.length} step${items.length === 1 ? "" : "s"} finished`),
      }),
    );
  }
  // A finished plan is forgotten so a later list starts a new one.
  return { state: { ...state, plan: done ? null : plan }, drafts, signal: { kind: "none" } };
}

type Handler<K extends RuntimeEvent["kind"]> = (
  state: NormalizerState,
  event: Extract<RuntimeEvent, { kind: K }>,
  ctx: NormalizeContext,
) => Advance;

const NONE = (state: NormalizerState): Advance => ({ state, drafts: [], signal: { kind: "none" } });

const DROP = NONE;

/**
 * The one `message.completed` a message gets, and the tracked message marked
 * so a second is a no-op. The context comes from the message's last step, else
 * the harness's figure for the message; a message with neither takes the calls
 * reported since the last message that did.
 */
function completeMessage(
  state: NormalizerState,
  messageId: string,
  message: TrackedMessage,
  finish: string | null,
  usage: CallUsage | null,
  error: { readonly name: string; readonly message: string } | null,
  ctx: NormalizeContext,
  /** False for a message released before its report, which leaves the report to the message it belongs to. */
  claim = true,
): { readonly state: NormalizerState; readonly draft: Draft; readonly text: string } {
  const own = usage ?? message.lastCall;
  const claimed = own === null && claim ? state.unclaimed : null;
  const context = message.lastCall ?? usage ?? claimed?.last ?? null;
  const spent = usage ?? message.lastCall ?? claimed?.sum ?? null;
  const completed: TrackedMessage = {
    ...message,
    stopReason: finish ?? message.stopReason,
    completed: true,
    awaitingUsage: false,
  };
  // The reading is this message's alone; the next message needs its own call's.
  const next = {
    ...(claimed === null ? state : { ...state, unclaimed: null }),
    promptCounts: null,
  };
  return {
    state: withMessage(next, messageId, completed),
    draft: draft("message.completed", ctx.runId, {
      messageId,
      role: "assistant",
      parts: completedParts(completed),
      stopReason: stopReasonOf(completed.stopReason, error),
      usage: usageOf(
        context,
        spent,
        ctx.contextWindow,
        state.promptCounts ?? null,
        ctx.compactsAt ?? null,
      ),
    }),
    text: assistantText(completed),
  };
}

/**
 * The turn is over: fail every open call, then complete every open assistant
 * message, so the timeline never holds a start without its terminal. OpenCode's
 * own late terminals then emit nothing.
 */
function closeOpen(
  state: NormalizerState,
  ctx: NormalizeContext,
  reason: { readonly errorText: string; readonly error: { name: string; message: string } | null },
): { readonly state: NormalizerState; readonly drafts: Draft[] } {
  const drafts: Draft[] = [];
  let next = state;
  for (const [callId, tracked] of openTools(state)) {
    const advanced = advanceTool(
      next,
      {
        callId,
        tool: tracked.tool,
        status: "error",
        title: tracked.title,
        input: {},
        output: null,
        error: reason.errorText,
        exitCode: null,
        startedAtMs: tracked.startedAtMs,
        endedAtMs: null,
      },
      ctx,
    );
    next = advanced.state;
    drafts.push(...advanced.drafts);
  }
  for (const [messageId, message] of state.messages) {
    if (message.role !== "assistant" || message.completed) {
      continue;
    }
    // A message held for its tokens had already finished; the turn's end is not its error.
    const done = completeMessage(
      next,
      messageId,
      message,
      null,
      null,
      message.awaitingUsage ? null : reason.error,
      ctx,
    );
    next = done.state;
    drafts.push(done.draft);
  }
  return { state: next, drafts };
}

/** OpenCode's halt on a rejected permission it asked outside a tool (`doom_loop`). */
function isPermissionRejection(event: Extract<RuntimeEvent, { kind: "session_error" }>): boolean {
  return (
    event.name === "PermissionRejectedError" ||
    event.name === "PermissionCorrectedError" ||
    event.message.startsWith("The user rejected permission to use this specific tool call")
  );
}

function modelFailureOf(
  event: Extract<RuntimeEvent, { kind: "session_error" }>,
): RelayFailure | null {
  if (event.name === "ProviderAuthError" || event.status === 401 || event.status === 403) {
    return { category: "authentication_failed", message: event.message };
  }
  if (event.status === 429) {
    return { category: "rate_limited", message: event.message };
  }
  return null;
}

/**
 * One handler per runtime event kind. OpenCode opens a text part with "" and
 * closes it with the whole text, so `text_part` only streams text past what the
 * deltas carried. `session_diff` is only a signal: the diff itself always comes
 * from the bridge's own Git, never OpenCode's report.
 */
export const EVENT_TABLE: { readonly [K in RuntimeEvent["kind"]]: Handler<K> } = {
  server_connected: NONE,

  message_started(state, event, ctx) {
    if (event.role !== "assistant") {
      return state.messages.has(event.messageId)
        ? NONE(state)
        : NONE(withMessage(state, event.messageId, USER_MESSAGE));
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    return { state: ensured.state, drafts: ensured.drafts, signal: { kind: "none" } };
  },

  text_delta(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    if (ensured.message.reasoningPartIds.has(event.partId)) {
      return { state: ensured.state, drafts: ensured.drafts, signal: { kind: "none" } };
    }
    const appended = appendText(ensured.message, event.partId, event.text);
    const drafts: Draft[] = [
      ...ensured.drafts,
      ...streamChunks(event.text).map((text) =>
        draft("message.delta", ctx.runId, {
          messageId: event.messageId,
          partIndex: appended.index,
          part: { type: "text", text },
        }),
      ),
    ];
    return {
      state: withMessage(ensured.state, event.messageId, appended.message),
      drafts,
      signal: { kind: "none" },
    };
  },

  text_part(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    const message = withPart(ensured.message, { kind: "text", partId: event.partId });
    const accumulated = message.textByPartId.get(event.partId) ?? "";
    // Whole text that extends what streamed: the remainder is what the deltas
    // would have said. Anything else replaces silently, since
    // `message.completed` carries the whole text.
    const remainder =
      event.text.length > accumulated.length && event.text.startsWith(accumulated)
        ? event.text.slice(accumulated.length)
        : "";
    const textByPartId = new Map(message.textByPartId);
    textByPartId.set(event.partId, event.text);
    const index = partIndex(message, event.partId);
    return {
      state: withMessage(ensured.state, event.messageId, { ...message, textByPartId }),
      drafts: [
        ...ensured.drafts,
        ...streamChunks(remainder).map((text) =>
          draft("message.delta", ctx.runId, {
            messageId: event.messageId,
            partIndex: index,
            part: { type: "text", text },
          }),
        ),
      ],
      signal: { kind: "none" },
    };
  },

  reasoning(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    const reasoningPartIds = new Set(ensured.message.reasoningPartIds);
    reasoningPartIds.add(event.partId);
    return {
      state: withMessage(ensured.state, event.messageId, { ...ensured.message, reasoningPartIds }),
      drafts: ensured.drafts,
      signal: { kind: "none" },
    };
  },

  step_finished(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    return {
      state: withMessage(ensured.state, event.messageId, {
        ...ensured.message,
        lastCall: readingOf(event.usage) ?? ensured.message.lastCall,
        stopReason: event.reason,
      }),
      drafts: ensured.drafts,
      signal: { kind: "none" },
    };
  },

  message_completed(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    if (ensured.message.completed || ensured.message.awaitingUsage) {
      return NONE(state);
    }
    const usage = readingOf(event.usage);
    if (event.usageFollows === true && usage === null) {
      const held: TrackedMessage = {
        ...ensured.message,
        stopReason: event.finish ?? ensured.message.stopReason,
        awaitingUsage: true,
      };
      const text = assistantText(held);
      return {
        state: withMessage(ensured.state, event.messageId, held),
        drafts: ensured.drafts,
        signal: text.length > 0 ? { kind: "assistant_text", text } : { kind: "none" },
      };
    }
    const done = completeMessage(
      ensured.state,
      event.messageId,
      ensured.message,
      event.finish,
      usage,
      event.error,
      ctx,
    );
    return {
      state: done.state,
      drafts: [...ensured.drafts, done.draft],
      signal: done.text.length > 0 ? { kind: "assistant_text", text: done.text } : { kind: "none" },
    };
  },

  /**
   * A call the harness reported apart from its message. It completes the
   * message held for it, or waits for the next message that has no tokens.
   */
  usage_reported(state, event, ctx) {
    if (readingOf(event.usage) === null) {
      return NONE(state);
    }
    const sum = state.unclaimed === null ? event.usage : addUsage(state.unclaimed.sum, event.usage);
    const reported: NormalizerState = { ...state, unclaimed: { last: event.usage, sum } };
    const held = [...state.messages].find(([, message]) => message.awaitingUsage);
    if (held === undefined) {
      return NONE(reported);
    }
    const [messageId, message] = held;
    const done = completeMessage(reported, messageId, message, null, null, null, ctx);
    return { state: done.state, drafts: [done.draft], signal: { kind: "none" } };
  },

  prompt_counts: (state, event) => NONE(rememberPrompt(state, event.reading)),

  tool_part(state, event, ctx) {
    if (isUserMessage(state, event.messageId)) {
      return NONE(state);
    }
    const ensured = ensureMessage(state, event.messageId, ctx);
    const message = withPart(ensured.message, { kind: "tool", callId: event.part.callId });
    const advanced = advanceTool(
      withMessage(ensured.state, event.messageId, message),
      event.part,
      ctx,
    );
    return { ...advanced, drafts: [...ensured.drafts, ...advanced.drafts] };
  },

  todos: (state, event, ctx) => advanceTodos(state, event.items, ctx),

  session_idle(state, _event, ctx) {
    const closed = closeOpen(state, ctx, {
      errorText: "OpenCode went idle before the call settled",
      error: null,
    });
    return { state: closed.state, drafts: closed.drafts, signal: { kind: "idle" } };
  },

  session_error(state, event, ctx) {
    const closed = closeOpen(state, ctx, {
      errorText: event.message,
      error: { name: event.name, message: event.message },
    });
    if (isPermissionRejection(event)) {
      // The user denied a repeated call, which OpenCode asks outside any tool
      // and answers by stopping: the run ends as the agent stopping, not a failure.
      return { state: closed.state, drafts: closed.drafts, signal: { kind: "idle" } };
    }
    const failure = modelFailureOf(event);
    return {
      state: closed.state,
      drafts: closed.drafts,
      signal:
        failure !== null
          ? { kind: "model_failure", failure }
          : { kind: "error", name: event.name, message: event.message },
    };
  },

  session_diff: (state) => ({ state, drafts: [], signal: { kind: "diff_changed" } }),

  file_edited: (state, event, ctx) => ({
    state,
    drafts: [
      draft("file.changed", ctx.runId, {
        change: { path: event.path.slice(0, 4096), status: "modified", additions: 0, deletions: 0 },
        byAgent: true,
      }),
    ],
    signal: { kind: "none" },
  }),

  homeless: DROP,

  // The reducer answers it (`secrets.ts`, `permissions.ts`); the timeline sees the call's own tool row.
  permission_asked: DROP,

  // The reducer tracks subagents itself (`subagents.ts`); a conversation is no row.
  session_created: DROP,

  // The reducer answers both (`questions.ts`); the asking call is its own tool row.
  question_asked: DROP,
  question_settled: DROP,

  // The reducer forgets the request.
  permission_replied: DROP,

  unknown(state, event, ctx) {
    const drafts: Draft[] = [];
    let next = state;
    if (next.debugToolCallId === null) {
      next = { ...next, debugToolCallId: ctx.newId() };
      drafts.push(
        draft("tool.requested", ctx.runId, {
          toolCallId: next.debugToolCallId as string,
          category: "other",
          title: DEBUG_TOOL_TITLE,
          runtimeName: (ctx.runtime ?? OPENCODE_RUNTIME).id,
          input: {},
          inputComplete: true,
          approvalId: null,
        }),
      );
    }
    const line = `${event.wireKind} ${event.raw}`;
    const text = line.slice(0, LIMITS.streamChunkChars);
    drafts.push(
      draft("tool.output", ctx.runId, {
        toolCallId: next.debugToolCallId as string,
        chunkIndex: next.debugChunkIndex,
        stream: "terminal",
        text,
        droppedBytes: line.length - text.length,
      }),
    );
    return {
      state: { ...next, debugChunkIndex: next.debugChunkIndex + 1 },
      drafts,
      signal: { kind: "none" },
    };
  },
};

/**
 * Holds what the latest call's answer will say about its prompt. Counts are
 * remembered by key, so a call the broker answers "pending" or "unavailable"
 * for a prompt this run has already seen counted is still exact.
 */
function rememberPrompt(state: NormalizerState, reading: PromptCountsReading): NormalizerState {
  if (reading.kind === "none") {
    return { ...state, promptCounts: null };
  }
  const memory = new Map(state.promptMemory ?? []);
  if (reading.kind === "counts") {
    memory.delete(reading.key);
    memory.set(reading.key, reading.counts);
    while (memory.size > PROMPT_MEMORY_LIMIT) {
      memory.delete(memory.keys().next().value as string);
    }
    return {
      ...state,
      promptMemory: memory,
      promptCounts: { kind: "counts", counts: reading.counts },
    };
  }
  const known = memory.get(reading.key);
  return {
    ...state,
    promptCounts:
      known === undefined
        ? { kind: "status", status: reading.status }
        : { kind: "counts", counts: known },
  };
}

/** Events that begin or extend an item, which means a held message's call has moved on. */
const RELEASING_KINDS: ReadonlySet<RuntimeEvent["kind"]> = new Set([
  "message_started",
  "text_delta",
  "text_part",
  "reasoning",
  "tool_part",
]);

/**
 * A message held for its tokens is completed, with no tokens, once another
 * item begins: its call has gone on to a tool or a second message, so the
 * report may not come until a long command ends, and it would describe more
 * than this message. The report stays for the next message without its own.
 */
function releaseHeld(
  state: NormalizerState,
  event: RuntimeEvent,
  ctx: NormalizeContext,
): { readonly state: NormalizerState; readonly drafts: readonly Draft[] } {
  if (!RELEASING_KINDS.has(event.kind)) {
    return { state, drafts: [] };
  }
  const about = (event as { readonly messageId?: string }).messageId;
  const drafts: Draft[] = [];
  let next = state;
  for (const [messageId, message] of state.messages) {
    if (!message.awaitingUsage || messageId === about) {
      continue;
    }
    const done = completeMessage(next, messageId, message, null, null, null, ctx, false);
    next = done.state;
    drafts.push(done.draft);
  }
  return { state: next, drafts };
}

export function advance(
  state: NormalizerState,
  event: RuntimeEvent,
  ctx: NormalizeContext,
): Advance {
  const released = releaseHeld(state, event, ctx);
  const handler = EVENT_TABLE[event.kind] as Handler<RuntimeEvent["kind"]>;
  const result = handler(released.state, event, ctx);
  return released.drafts.length === 0
    ? result
    : { ...result, drafts: [...released.drafts, ...result.drafts] };
}
