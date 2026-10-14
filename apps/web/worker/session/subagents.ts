// Subagents in the session object (record 12): what it admits of the bridge's
// `agent.started` and `agent.completed` and of a subagent's own messages and
// calls, and the bound it holds. A subagent is the sandbox's claim, so each
// frame is judged against the object's own rows, read by key or by run, never
// by scanning the log.

/**
 * Matches the bridge's own limit (`MAX_SUBAGENTS_PER_RUN`), so an honest bridge
 * never meets it. The bridge counts from zero in each sandbox, so the object
 * counts a run's subagents per sandbox generation too.
 */
export const MAX_AGENTS_PER_RUN = 16;

export type AgentRefusal =
  | "agent_run_not_running"
  | "too_many_agents"
  | "agent_already_started"
  | "agent_call_not_allowed"
  | "agent_not_running"
  | "agent_not_admitted";

/**
 * `drop` is a frame that is not stored and not held against the socket: its
 * run ended in the object before the bridge heard, so an honest bridge sends
 * it. `refuse` is a claim the rows do not support, and counts.
 */
export type AgentDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "drop" }
  | { readonly kind: "refuse"; readonly reason: AgentRefusal };

/**
 * Where the run a frame names stands. `live` is the session's current run in
 * a state the bridge may be working in (`LIVE_RUN_STATES`); `ended` is any run
 * of the session with an outcome; `other` is every remaining case, an unknown
 * run among them.
 */
export type AgentRunStanding = "live" | "ended" | "other";

const ADMIT: AgentDecision = { kind: "admit" };

/**
 * A claim the rows do not support. A cancel commits the run's end before the
 * bridge hears of it, and a held message can make the next run current in the
 * same step, so what the bridge sent meanwhile for the ended run is dropped
 * rather than counted.
 */
function unsupported(run: AgentRunStanding, reason: AgentRefusal): AgentDecision {
  return run === "ended" ? { kind: "drop" } : { kind: "refuse", reason };
}

/** What the rows say of a start in a live run. */
export interface AgentStartFacts {
  /** Subagents this run already started on the frame's sandbox generation. */
  readonly startedThisRun: number;
  readonly alreadyKnown: boolean;
  /**
   * The object allowed the frame's `parentToolCallId` to start a subagent in
   * this run on this sandbox: the bridge forwards every start as a
   * `start_subagent` ask naming that call, and announces a subagent only
   * after the answer.
   */
  readonly callAllowed: boolean;
  /** Another subagent of the run on this sandbox already names that call. */
  readonly callTaken: boolean;
}

/**
 * A subagent is started only within the live run that names it, once, within
 * the run's bound, and by a call the object itself allowed to start one, so
 * an announcement cannot turn some other call's row into a subagent's.
 * `facts` is read only for a live run.
 */
export function decideAgentStarted(context: {
  readonly run: AgentRunStanding;
  readonly facts: () => AgentStartFacts;
}): AgentDecision {
  if (context.run !== "live") {
    return unsupported(context.run, "agent_run_not_running");
  }
  const facts = context.facts();
  if (facts.alreadyKnown) {
    return { kind: "refuse", reason: "agent_already_started" };
  }
  if (facts.startedThisRun >= MAX_AGENTS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_agents" };
  }
  if (!facts.callAllowed || facts.callTaken) {
    return { kind: "refuse", reason: "agent_call_not_allowed" };
  }
  return ADMIT;
}

/** A subagent's row as a frame is judged against it. */
export interface AgentRow {
  readonly runId: string;
  readonly sandboxGeneration: number;
  readonly status: string;
}

/** What a frame says of itself: its run and the sandbox generation that sent it. */
export interface AgentFrame {
  readonly runId: string | null;
  readonly sandboxGeneration: number;
}

function sameRunAndSandbox(row: AgentRow, frame: AgentFrame): boolean {
  return row.runId === frame.runId && row.sandboxGeneration === frame.sandboxGeneration;
}

/**
 * Whether a subagent is running where a frame or a command says it is: in that
 * run, on that sandbox. One a lost sandbox left behind is not, though its run
 * may have been continued on a new one.
 */
export function agentRunsIn(row: AgentRow | null, frame: AgentFrame): boolean {
  return row !== null && row.status === "running" && sameRunAndSandbox(row, frame);
}

/**
 * A subagent ends once, in the run and on the sandbox that started it. Its run
 * may already have ended: a cancel commits the run's end before the bridge
 * reports what it took down with it. `run` is read only when the row does not
 * support the end.
 */
export function decideAgentCompleted(context: {
  readonly row: AgentRow | null;
  readonly frame: AgentFrame;
  readonly run: () => AgentRunStanding;
}): AgentDecision {
  if (agentRunsIn(context.row, context.frame)) {
    return ADMIT;
  }
  return unsupported(context.run(), "agent_not_running");
}

/**
 * A message or call that carries an `agentId` is stored only for a subagent the
 * object admitted in that run on that sandbox. The bridge sends a subagent's
 * rows after its `agent.started`, so one that names no admitted subagent is
 * either a start the cancel race dropped or a claim the rows do not support.
 */
export function decideAgentTagged(context: {
  readonly row: AgentRow | null;
  readonly frame: AgentFrame;
  readonly run: () => AgentRunStanding;
}): AgentDecision {
  if (context.row !== null && sameRunAndSandbox(context.row, context.frame)) {
    return ADMIT;
  }
  return unsupported(context.run(), "agent_not_admitted");
}
