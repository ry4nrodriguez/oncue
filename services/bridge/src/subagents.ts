/**
 * Subagents on the bridge's side (record 12, "Subagents"). Pure state that
 * `agent.ts` drives, one per run. OpenCode starts a subagent as a child
 * conversation of the primary agent's, and every event of either arrives on
 * the same stream, so this module decides whose each event is and keeps a
 * subagent's messages, idle, and errors from ever reaching the primary
 * agent's turn.
 *
 * - A `task` call is held at OpenCode's permission gate (`ask`). Only the
 *   primary agent's start of the built-in `general` or `explore` while fewer
 *   than `MAX_RUNNING_SUBAGENTS` run, and fewer than `MAX_SUBAGENTS_PER_RUN`
 *   were allowed in the run, takes a slot and is forwarded to the session
 *   object's permission gate as `start_subagent` (`permissions.ts`); every
 *   other is refused here, before any card. The object's answer settles the
 *   slot, and a start it allows counts against the run's limit for good.
 * - A child conversation (`session_created` naming the primary agent's as its
 *   parent) takes one approved slot; one that arrives without a slot (a
 *   subtask sent straight to the API skips the gate) is aborted at once.
 * - The child's id becomes the subagent's `agentId`. `agent.started` is sent
 *   once the primary agent's `task` call names the child (its metadata
 *   arrives just after `session.created`); the child's own drafts wait until
 *   then, bounded by `MAX_HELD_DRAFTS`.
 * - A `task` call that names any other conversation (OpenCode's `task_id`
 *   resumes one that already exists) would run it unseen and past the limit,
 *   so that conversation is aborted and nothing is announced.
 * - The call settling ends the subagent with `agent.completed`. A run that
 *   winds down aborts every subagent still running, and a run that ends
 *   reports each one it took with it as cancelled. An abort that fails is
 *   forgotten, so the next stop, wind-down, or run end asks again.
 */

import { LIMITS, SUBAGENT_NAMES, type TokenCounts } from "@oncue/protocol";
import {
  advance,
  draft,
  emptyNormalizerState,
  type NormalizeContext,
  type NormalizerState,
  type RuntimeEvent,
  shortText,
  summaryText,
  type ToolPart,
} from "./normalize";
import type { Draft } from "./protocol";

/** OpenCode's tool that starts a subagent, and the permission that gates it. */
export const SUBAGENT_TOOL = "task";
/** At most this many subagents run at once in a session's run. */
export const MAX_RUNNING_SUBAGENTS = 4;
/** At most this many are started in one run; the object holds the same bound. */
export const MAX_SUBAGENTS_PER_RUN = 16;
/**
 * A subagent's drafts held before its `agent.started`. Past this they are
 * dropped and counted, except what ends a row already held (`holdDrafts`).
 */
export const MAX_HELD_DRAFTS = 64;

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

function isSubagentName(value: string | null | undefined): value is SubagentName {
  return (
    value !== null && value !== undefined && (SUBAGENT_NAMES as readonly string[]).includes(value)
  );
}

export type SubagentPhase =
  /** Its conversation exists; the primary agent's call has not named it yet. */
  | "pending"
  /** `agent.started` has been sent. */
  | "running"
  /** `agent.completed` has been sent. */
  | "settled"
  /** Aborted and never announced: it began without an allowed slot, or a call named it without starting it. */
  | "refused";

export interface TrackedSubagent {
  /** The child conversation's id, which is the protocol's `agentId`. */
  readonly agentId: string;
  readonly name: SubagentName;
  /** The primary agent's `task` call; null until that call names this conversation. */
  readonly callId: string | null;
  readonly phase: SubagentPhase;
  readonly startedAtMs: number;
  /**
   * An abort was asked of it (by the user, by the run winding down, or because
   * it was refused) and has not failed. Its end then reads as cancelled, and
   * no second abort is sent.
   */
  readonly stopRequested: boolean;
  readonly toolCalls: number;
  readonly tokens: number;
  /** Its own normalizer, so its message and call ids never meet the primary agent's. */
  readonly normalizer: NormalizerState;
  readonly held: readonly Draft[];
  readonly droppedDrafts: number;
}

/** A `task` ask holding a slot: waiting on the user's answer, or allowed and waiting for its conversation. */
export interface SubagentSlot {
  readonly callId: string;
  readonly name: SubagentName;
  /** OpenCode's request id, which the object's answer settles. */
  readonly requestId: string;
  /** The session object allowed it; only then may a conversation take it. */
  readonly approved: boolean;
}

/** A `task` call that named a conversation it was not allowed to start, which was aborted for it. */
export interface RefusedResume {
  readonly callId: string;
  /** The conversation the call named. */
  readonly agentId: string;
}

export interface SubagentState {
  readonly agents: readonly TrackedSubagent[];
  /** `task` asks holding a slot whose conversation has not appeared yet; the running limit counts them. */
  readonly allowed: readonly SubagentSlot[];
  /**
   * Refused calls that have not settled, so their conversations may still be
   * working; the running limit counts them. Each names a tracked conversation.
   */
  readonly resumes: readonly RefusedResume[];
  /** Starts the session object allowed in this run. It only goes up, so nothing gives a start its place in the run's limit back. */
  readonly started: number;
}

export const NO_SUBAGENTS: SubagentState = { agents: [], allowed: [], resumes: [], started: 0 };

export type SubagentEffect =
  | { readonly kind: "abort"; readonly agentId: string }
  /** A line for the bridge's own log; never a model's or a tool's words. */
  | { readonly kind: "log"; readonly line: string }
  | {
      readonly kind: "reply";
      readonly requestId: string;
      readonly reply: "once" | "reject";
      readonly message: string | null;
    };

export interface SubagentStep {
  readonly state: SubagentState;
  readonly drafts: readonly Draft[];
  readonly effects: readonly SubagentEffect[];
}

const UNCHANGED = (state: SubagentState): SubagentStep => ({ state, drafts: [], effects: [] });

/** The words a refused `task` call returns to the model. */
export const TASK_REFUSALS = {
  noRun: "No run is active.",
  noCall: "OnCue could not tell which call asked to start this subagent.",
  nested: "A subagent cannot start another subagent.",
  name: "Only the general and explore subagents are available here.",
  busy: `${MAX_RUNNING_SUBAGENTS} subagents are already running. Wait for one to finish, then start another.`,
  spent: `This run has started its limit of ${MAX_SUBAGENTS_PER_RUN} subagents.`,
} as const;

function live(agent: TrackedSubagent): boolean {
  return agent.phase === "pending" || agent.phase === "running";
}

/** Running subagents, the allowed ones not yet started, and the refused calls still open. */
export function liveCount(state: SubagentState): number {
  return state.agents.filter(live).length + state.allowed.length + state.resumes.length;
}

/** Whether its conversation may still be working: a live one, one refused, or one a call still open named. */
function mayRun(state: SubagentState, agent: TrackedSubagent): boolean {
  return (
    live(agent) ||
    agent.phase === "refused" ||
    state.resumes.some((entry) => entry.agentId === agent.agentId)
  );
}

function find(state: SubagentState, agentId: string): TrackedSubagent | undefined {
  return state.agents.find((agent) => agent.agentId === agentId);
}

function replace(state: SubagentState, next: TrackedSubagent): SubagentState {
  return {
    ...state,
    agents: state.agents.map((agent) => (agent.agentId === next.agentId ? next : agent)),
  };
}

export type SubagentRoute =
  | { readonly kind: "root" }
  | { readonly kind: "child"; readonly agentId: string }
  /** A conversation that is neither the run's nor one of its subagents'; dropped. */
  | { readonly kind: "foreign" };

/**
 * Whose event this is. Untagged events and everything before the run's
 * conversation is known are the primary agent's, as they were before
 * subagents existed.
 */
export function routeOf(
  state: SubagentState,
  rootConversation: string | null,
  sessionId: string | undefined,
): SubagentRoute {
  if (sessionId === undefined || rootConversation === null || sessionId === rootConversation) {
    return { kind: "root" };
  }
  return find(state, sessionId) === undefined
    ? { kind: "foreign" }
    : { kind: "child", agentId: sessionId };
}

/**
 * OpenCode holds a `task` call and asks. `fromRoot` is whether the primary
 * agent asked; `runRunning` whether the run is past its prompt and not
 * winding down. `forward` is the subagent's name when the ask took a slot and
 * goes to the user's approval mode; the cap is checked first, so a start the
 * run cannot take never shows a card.
 */
export function onTaskAsked(
  state: SubagentState,
  ask: {
    readonly requestId: string;
    readonly callId: string | null;
    readonly patterns: readonly string[];
  },
  ctx: { readonly fromRoot: boolean; readonly runRunning: boolean },
): SubagentStep & { readonly forward: SubagentName | null } {
  const reject = (message: string) => ({
    state,
    drafts: [],
    effects: [
      { kind: "reply" as const, requestId: ask.requestId, reply: "reject" as const, message },
    ],
    forward: null,
  });
  if (!ctx.runRunning) {
    return reject(TASK_REFUSALS.noRun);
  }
  if (!ctx.fromRoot) {
    return reject(TASK_REFUSALS.nested);
  }
  const name = ask.patterns[0];
  if (ask.patterns.length !== 1 || !isSubagentName(name)) {
    return reject(TASK_REFUSALS.name);
  }
  if (ask.callId === null) {
    return reject(TASK_REFUSALS.noCall);
  }
  const held = state.allowed.find((slot) => slot.callId === ask.callId);
  if (held?.approved === true) {
    // Asked again for a call already let through.
    return {
      state,
      drafts: [],
      effects: [{ kind: "reply", requestId: ask.requestId, reply: "once", message: null }],
      forward: null,
    };
  }
  if (held !== undefined) {
    // Asked again while the first ask waits on the user: the same slot.
    return { state, drafts: [], effects: [], forward: name };
  }
  if (liveCount(state) >= MAX_RUNNING_SUBAGENTS) {
    return reject(TASK_REFUSALS.busy);
  }
  // Starts still waiting on the user count too, so the run's limit is never passed by answering them all.
  const waiting = state.allowed.filter((slot) => !slot.approved).length;
  if (state.started + waiting >= MAX_SUBAGENTS_PER_RUN) {
    return reject(TASK_REFUSALS.spent);
  }
  return {
    state: {
      ...state,
      allowed: [
        ...state.allowed,
        { callId: ask.callId, name, requestId: ask.requestId, approved: false },
      ],
    },
    drafts: [],
    effects: [],
    forward: name,
  };
}

/**
 * The session object answered a forwarded start. Allowed, its slot waits for
 * the conversation and the start is counted against the run's limit; refused,
 * the slot is given back uncounted. Any other request is not a start's, and
 * changes nothing.
 */
export function onTaskAnswered(
  state: SubagentState,
  requestId: string,
  reply: "once" | "reject",
): SubagentState {
  const slot = state.allowed.find((entry) => entry.requestId === requestId);
  if (slot === undefined) {
    return state;
  }
  if (reply === "reject") {
    return { ...state, allowed: state.allowed.filter((entry) => entry !== slot) };
  }
  if (slot.approved) {
    return state;
  }
  return {
    ...state,
    allowed: state.allowed.map((entry) => (entry === slot ? { ...slot, approved: true } : entry)),
    started: state.started + 1,
  };
}

/** A conversation aborted without being announced, remembered so its late events and asks are known as its. */
function refusedAgent(agentId: string, name: SubagentName, nowMs: number): TrackedSubagent {
  return {
    agentId,
    name,
    callId: null,
    phase: "refused",
    startedAtMs: nowMs,
    stopRequested: true,
    toolCalls: 0,
    tokens: 0,
    normalizer: emptyNormalizerState,
    held: [],
    droppedDrafts: 0,
  };
}

/**
 * A conversation began. One whose parent is the run's conversation is a
 * subagent: it takes the first allowed slot for its name, or is aborted.
 */
export function onSessionCreated(
  state: SubagentState,
  created: {
    readonly sessionId: string;
    readonly parentId: string | null;
    readonly agent: string | null;
  },
  ctx: { readonly rootConversation: string | null; readonly nowMs: number },
): SubagentStep {
  if (
    created.parentId === null ||
    ctx.rootConversation === null ||
    created.parentId !== ctx.rootConversation ||
    find(state, created.sessionId) !== undefined
  ) {
    return UNCHANGED(state);
  }
  const slot = state.allowed.findIndex((entry) => entry.approved && entry.name === created.agent);
  const refused = refusedAgent(
    created.sessionId,
    isSubagentName(created.agent) ? created.agent : "general",
    ctx.nowMs,
  );
  if (slot === -1) {
    return {
      state: remember(state, refused),
      drafts: [],
      effects: [{ kind: "abort", agentId: created.sessionId }],
    };
  }
  return {
    state: {
      ...state,
      agents: [...state.agents, { ...refused, phase: "pending", stopRequested: false }],
      allowed: state.allowed.filter((_, index) => index !== slot),
    },
    drafts: [],
    effects: [],
  };
}

/**
 * Keeps a refused conversation, so its late events and asks are known as its
 * rather than read as a stranger's. Bounded: past twice the run's limit a new
 * one is aborted all the same and not kept.
 */
function remember(state: SubagentState, refused: TrackedSubagent): SubagentState {
  return state.agents.length >= MAX_SUBAGENTS_PER_RUN * 2
    ? state
    : { ...state, agents: [...state.agents, refused] };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** What `task` reported back: its `<task_result>` when it has one, else the whole output, trimmed. */
export function taskResult(output: string): string {
  const open = output.indexOf("<task_result>");
  const close = output.lastIndexOf("</task_result>");
  const body =
    open !== -1 && close > open ? output.slice(open + "<task_result>".length, close) : output;
  return summaryText(body.trim());
}

function startedDraft(
  agent: TrackedSubagent,
  callId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: { readonly runId: string; readonly model: { provider: string; modelId: string } | null },
): Draft {
  const prompt = str(input.prompt) ?? "";
  const description = str(input.description);
  return draft("agent.started", ctx.runId, {
    agentId: agent.agentId,
    parentToolCallId: callId,
    name: agent.name,
    description: shortText(description ?? `${agent.name} subagent`),
    prompt: prompt.slice(0, LIMITS.summaryTextChars),
    promptTruncated: prompt.length > LIMITS.summaryTextChars,
    model: ctx.model,
  });
}

function completedDraft(
  agent: TrackedSubagent,
  status: "completed" | "failed" | "cancelled",
  resultSummary: string | null,
  ctx: { readonly runId: string; readonly nowMs: number },
): Draft {
  return draft("agent.completed", ctx.runId, {
    agentId: agent.agentId,
    status,
    usage: {
      tokens: agent.tokens,
      toolCalls: agent.toolCalls,
      durationMs: Math.max(0, ctx.nowMs - agent.startedAtMs),
    },
    resultSummary,
  });
}

/** Announces a correlated subagent and releases what it held, saying once how much was dropped. */
function announce(
  agent: TrackedSubagent,
  callId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: { readonly runId: string; readonly model: { provider: string; modelId: string } | null },
): {
  readonly agent: TrackedSubagent;
  readonly drafts: readonly Draft[];
  readonly effects: readonly SubagentEffect[];
} {
  return {
    agent: { ...agent, callId, phase: "running", held: [] },
    drafts: [startedDraft(agent, callId, input, ctx), ...agent.held],
    effects:
      agent.droppedDrafts === 0
        ? []
        : [
            {
              kind: "log",
              line: `dropped ${agent.droppedDrafts} of a subagent's events held before it was announced`,
            },
          ],
  };
}

/**
 * Whether the conversation a call names is the one it was just allowed to
 * start: created under the run and still waiting for its call. One the call's
 * own `task_id` names was there before the call, whatever else is true of it.
 */
function startedBy(named: TrackedSubagent | undefined, part: ToolPart): boolean {
  return named !== undefined && named.phase === "pending" && part.input.task_id !== named.agentId;
}

/**
 * A `task` call named a conversation it was not allowed to start, as
 * OpenCode's `task_id` does to resume one. Its work would be unseen, unstopped,
 * and outside the run's limit, so the conversation is aborted, once for the
 * call, and remembered until the call settles.
 */
function refuseResume(
  state: SubagentState,
  callId: string,
  agentId: string,
  nowMs: number,
): SubagentStep {
  if (state.resumes.some((entry) => entry.callId === callId)) {
    return UNCHANGED(state);
  }
  const known = find(state, agentId);
  const tracked =
    known === undefined
      ? remember(state, refusedAgent(agentId, "general", nowMs))
      : replace(state, { ...known, stopRequested: true });
  return {
    state: {
      ...tracked,
      // The call started nothing, so no conversation may take its slot.
      allowed: state.allowed.filter((slot) => slot.callId !== callId),
      // One the run had no room to remember is aborted all the same, and again if its call says so again.
      resumes:
        find(tracked, agentId) === undefined
          ? state.resumes
          : [...state.resumes, { callId, agentId }].slice(-MAX_SUBAGENTS_PER_RUN),
    },
    drafts: [],
    effects: [
      { kind: "abort", agentId },
      {
        kind: "log",
        line: "aborted a conversation a task call named but was not allowed to start",
      },
    ],
  };
}

/**
 * The primary agent's `task` call moved. Its metadata names the child
 * conversation, which announces the subagent; its settling ends it. A call
 * that names any other conversation but the run's own has that conversation
 * aborted. A slot the call never used ends with it, still counted.
 */
export function onRootToolPart(
  state: SubagentState,
  part: ToolPart,
  ctx: {
    readonly runId: string;
    readonly nowMs: number;
    readonly model: { provider: string; modelId: string } | null;
    /** The run's own conversation, which no call's naming it may abort; null until the harness holds it. */
    readonly rootConversation: string | null;
  },
): SubagentStep {
  if (part.tool !== SUBAGENT_TOOL) {
    return UNCHANGED(state);
  }
  const settled = part.status === "completed" || part.status === "error";
  const next: SubagentState = settled
    ? {
        ...state,
        allowed: state.allowed.filter((slot) => slot.callId !== part.callId),
        resumes: state.resumes.filter((entry) => entry.callId !== part.callId),
      }
    : state;
  const byCall = next.agents.find((agent) => agent.callId === part.callId);
  const child = part.childSessionId;
  const named = child === undefined ? undefined : find(next, child);
  // Until the run's own conversation is known, nothing can be told from it, so nothing is aborted.
  const foreign =
    child !== undefined && ctx.rootConversation !== null && child !== ctx.rootConversation;
  if (byCall === undefined && foreign && !startedBy(named, part)) {
    // Settled, the conversation has nothing left to abort.
    return settled ? UNCHANGED(next) : refuseResume(next, part.callId, child, ctx.nowMs);
  }
  let agent = byCall ?? named;
  if (agent === undefined || !live(agent)) {
    return UNCHANGED(next);
  }
  const drafts: Draft[] = [];
  const effects: SubagentEffect[] = [];
  if (agent.phase === "pending") {
    const announced = announce(agent, part.callId, part.input, ctx);
    agent = announced.agent;
    drafts.push(...announced.drafts);
    effects.push(...announced.effects);
  }
  if (settled) {
    const failed = part.status === "error";
    const error = part.error ?? "";
    const status =
      agent.stopRequested || (failed && /cancel/i.test(error))
        ? "cancelled"
        : failed
          ? "failed"
          : "completed";
    const summary = failed ? summaryText(error) : taskResult(part.output ?? "");
    drafts.push(completedDraft(agent, status, summary.length === 0 ? null : summary, ctx));
    agent = { ...agent, phase: "settled" };
  }
  return { state: replace(next, agent), drafts, effects };
}

const AGENT_TAGGED: ReadonlySet<string> = new Set([
  "message.started",
  "message.delta",
  "message.completed",
  "tool.requested",
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
]);

/** The subagent's id on each of its message and call drafts; other drafts pass as they are. */
export function tagDraft(value: Draft, agentId: string): Draft {
  return AGENT_TAGGED.has(value.type)
    ? ({ ...value, payload: { ...value.payload, agentId } } as Draft)
    : value;
}

type Counts = Partial<Record<keyof TokenCounts, number>>;

/**
 * What a subagent's messages spent: every call each one accounts for, cache
 * reads and writes included, since they are billed too. Each message's
 * `spent` when it has one, else its last call, which was then its only one.
 * Never `usedTokens`, the context's size, which each message would repeat.
 */
function tokensOf(drafts: readonly Draft[]): number {
  let total = 0;
  for (const entry of drafts) {
    if (entry.type === "message.completed") {
      const usage = (entry.payload as { usage: (Counts & { spent?: Counts }) | null }).usage;
      const counts = usage?.spent ?? usage ?? {};
      total +=
        (counts.inputTokens ?? 0) +
        (counts.cachedInputTokens ?? 0) +
        (counts.cacheWriteTokens ?? 0) +
        (counts.outputTokens ?? 0) +
        (counts.reasoningTokens ?? 0);
    }
  }
  return total;
}

/** Streamed pieces of a row, which reads without them: the first to go when the held drafts are full. */
const STREAMED: ReadonlySet<string> = new Set(["message.delta", "tool.output"]);
/** What ends a row. */
const CLOSING: ReadonlySet<string> = new Set([
  "message.completed",
  "tool.completed",
  "tool.failed",
]);

/** The message or call a draft is a row of. */
function rowOf(entry: Draft): string | null {
  const payload = entry.payload as { readonly messageId?: unknown; readonly toolCallId?: unknown };
  return str(payload.messageId) ?? str(payload.toolCallId);
}

/** Whether a draft ends a row that has a draft held, with room left past the limit to keep it. */
function closesHeldRow(held: readonly Draft[], entry: Draft): boolean {
  const row = rowOf(entry);
  return (
    CLOSING.has(entry.type) &&
    held.length < MAX_HELD_DRAFTS * 2 &&
    held.some((kept) => rowOf(kept) === row)
  );
}

/** Takes the newest streamed piece out of the held drafts, when there is one. */
function dropStreamed(held: Draft[]): boolean {
  const at = held.findLastIndex((kept) => STREAMED.has(kept.type));
  if (at === -1) {
    return false;
  }
  held.splice(at, 1);
  return true;
}

/**
 * Adds a pending subagent's drafts to those held, at most `MAX_HELD_DRAFTS`.
 * When they are full a streamed piece gives up its place first, the newest
 * one held. What ends a row that has a draft held is kept even past the
 * limit, never past twice it, so a held row is not left open on the timeline.
 */
export function holdDrafts(
  held: readonly Draft[],
  incoming: readonly Draft[],
): { readonly held: readonly Draft[]; readonly dropped: number } {
  const next = [...held];
  let dropped = 0;
  for (const entry of incoming) {
    if (next.length < MAX_HELD_DRAFTS) {
      next.push(entry);
    } else if (STREAMED.has(entry.type)) {
      dropped += 1;
    } else if (dropStreamed(next)) {
      next.push(entry);
      dropped += 1;
    } else if (closesHeldRow(next, entry)) {
      next.push(entry);
    } else {
      dropped += 1;
    }
  }
  return { held: next, dropped };
}

/**
 * One of a subagent's own events, through its own normalizer. Its idle and
 * its errors close its own rows and nothing else; its plan is dropped, since
 * the run's plan is the primary agent's.
 */
export function onChildEvent(
  state: SubagentState,
  agentId: string,
  event: RuntimeEvent,
  ctx: NormalizeContext,
): SubagentStep {
  const agent = find(state, agentId);
  if (agent === undefined || agent.phase === "refused" || agent.phase === "settled") {
    return UNCHANGED(state);
  }
  if (event.kind === "todos") {
    return UNCHANGED(state);
  }
  const advanced = advance(agent.normalizer, event, ctx);
  const drafts = advanced.drafts.map((entry) => tagDraft(entry, agentId));
  let next: TrackedSubagent = {
    ...agent,
    normalizer: advanced.state,
    toolCalls: agent.toolCalls + (advanced.signal.kind === "tool_settled" ? 1 : 0),
    tokens: agent.tokens + tokensOf(drafts),
  };
  if (next.phase === "pending") {
    const kept = holdDrafts(next.held, drafts);
    next = { ...next, held: kept.held, droppedDrafts: next.droppedDrafts + kept.dropped };
    return { state: replace(state, next), drafts: [], effects: [] };
  }
  return { state: replace(state, next), drafts, effects: [] };
}

/**
 * The user asked to stop one subagent. Accepted only while it runs. A stop
 * whose abort is on its way, or went through, sends no second one; one whose
 * abort failed (`onAbortFailed`) sends it again.
 */
export function onStopAsked(
  state: SubagentState,
  agentId: string,
): { readonly accepted: boolean } & SubagentStep {
  const agent = find(state, agentId);
  if (agent === undefined || !live(agent)) {
    return { accepted: false, ...UNCHANGED(state) };
  }
  return {
    accepted: true,
    state: replace(state, { ...agent, stopRequested: true }),
    drafts: [],
    effects: agent.stopRequested ? [] : [{ kind: "abort", agentId }],
  };
}

/**
 * An abort did not go through, so the conversation may still be working. Its
 * stop is forgotten: the next stop, wind-down, or run end asks again instead
 * of taking it as done.
 */
export function onAbortFailed(state: SubagentState, agentId: string): SubagentState {
  const agent = find(state, agentId);
  return agent === undefined || !agent.stopRequested || !mayRun(state, agent)
    ? state
    : replace(state, { ...agent, stopRequested: false });
}

/** Asks every conversation that may still be working, and has no abort on its way, to stop. */
function abortRemaining(state: SubagentState): SubagentStep {
  const effects: SubagentEffect[] = [];
  const agents = state.agents.map((agent) => {
    if (!mayRun(state, agent) || agent.stopRequested) {
      return agent;
    }
    effects.push({ kind: "abort", agentId: agent.agentId });
    return { ...agent, stopRequested: true };
  });
  return { state: { ...state, agents }, drafts: [], effects };
}

/** The run is winding down: every subagent still running is aborted, and its end reads as cancelled. */
export function onWindDown(state: SubagentState): SubagentStep {
  const asked = abortRemaining(state);
  return { ...asked, state: { ...asked.state, allowed: [] } };
}

/**
 * The run ended. Each subagent it announced and never ended is reported
 * cancelled, and any still alive is aborted, since nothing will answer for it.
 */
export function onRunEnded(
  state: SubagentState,
  ctx: { readonly runId: string; readonly nowMs: number },
): Omit<SubagentStep, "state"> {
  return {
    drafts: state.agents
      .filter((agent) => agent.phase === "running")
      .map((agent) => completedDraft(agent, "cancelled", null, ctx)),
    effects: abortRemaining(state).effects,
  };
}
