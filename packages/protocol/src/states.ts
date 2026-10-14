/**
 * Seven state machines behind one `canTransition` entry point. Each machine
 * keeps its own state alphabet, so `canTransition("run", "checkpointing",
 * "verified")` fails to compile instead of returning `false`.
 *
 * States are spelled as their architecture records spell the identifier; where
 * a record uses Title Case prose for a wire value, the snake_case form is used.
 * This file imports no schema so it can be tested on its own.
 */

/* =============================================================================
 * The generic shape. `Transitions<S>` is a total mapped type: every member of
 * `S` needs a row, and a row may list only members of `S`.
 * ========================================================================== */

export type Transitions<S extends string> = { readonly [From in S]: readonly S[] };

export interface Machine<S extends string> {
  readonly states: readonly S[];
  readonly initial: S;
  readonly transitions: Transitions<S>;
}

/* =============================================================================
 * Session (record 10, "Session and run states"). The record has no transition
 * list; the moves come from its prose and record 19's no-trash deletion rule.
 * ========================================================================== */

/** Record 10's "Deletion pending" is the display label for `deletion_pending`. */
export const SESSION_STATES = ["active", "archived", "deletion_pending"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_TRANSITIONS: Transitions<SessionState> = {
  active: ["archived", "deletion_pending"],
  archived: ["active", "deletion_pending"],
  // Record 19: deletion is not recoverable and there is no trash.
  deletion_pending: [],
};

/* =============================================================================
 * Run (record 01, "Run operational state model"), transcribed from the
 * record's one-transition-per-line block.
 * ========================================================================== */

export const RUN_STATES = [
  "created",
  "queued",
  "provisioning",
  "ready",
  "running",
  "waiting_for_approval",
  "paused",
  "interrupted",
  "verified",
  "completed_with_warnings",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Record 14's six outcome states, which are record 01's six terminals.
 * `completed` ("Done") is a run that changed no files, so no checks ran and it
 * claims nothing about verification.
 */
export const RUN_OUTCOMES = [
  "verified",
  "completed_with_warnings",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const satisfies readonly RunState[];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RUN_TRANSITIONS: Transitions<RunState> = {
  created: ["queued", "cancelled"],
  queued: ["provisioning", "cancelled"],
  provisioning: ["ready", "cancelled", "failed"],
  ready: ["running", "cancelled", "failed"],
  running: [
    "waiting_for_approval",
    "paused",
    "interrupted",
    "verified",
    "completed_with_warnings",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ],
  waiting_for_approval: ["running", "cancelled", "blocked"],
  paused: ["provisioning", "cancelled"],
  interrupted: ["provisioning", "cancelled", "failed"],
  verified: [],
  completed_with_warnings: [],
  completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

/* =============================================================================
 * Sandbox (record 11, "Sandbox lifecycle"), transcribed from the record's
 * block. A replacement is a new sandbox at a higher generation, so `replaced`
 * is terminal here.
 * ========================================================================== */

export const SANDBOX_STATES = [
  "requested",
  "provisioning",
  "ready",
  "attached",
  "active",
  "idle",
  "checkpointing",
  "stopped",
  "failed",
  "replaced",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const SANDBOX_TRANSITIONS: Transitions<SandboxState> = {
  requested: ["provisioning"],
  provisioning: ["ready", "failed"],
  ready: ["attached", "failed"],
  attached: ["active", "stopped", "failed", "replaced"],
  active: ["idle", "stopped", "failed", "replaced"],
  idle: ["active", "checkpointing", "failed", "replaced"],
  checkpointing: ["stopped", "failed", "replaced"],
  stopped: [],
  failed: [],
  replaced: [],
};

/* =============================================================================
 * Plan (record 12, "Plan lifecycle"), transcribed from the record's block.
 * ========================================================================== */

export const PLAN_STATES = [
  "proposed",
  "active",
  "revised",
  "completed",
  "blocked",
  "cancelled",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const PLAN_TRANSITIONS: Transitions<PlanState> = {
  proposed: ["active", "cancelled"],
  active: ["revised", "completed", "blocked", "cancelled"],
  revised: ["active", "completed", "blocked", "cancelled"],
  blocked: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

/* =============================================================================
 * Verification check (record 14, "Verification record"). The record names four
 * results but no transitions; `pending` and `running` exist because a check
 * records start and end times. A retry of a flaky check is a new attempt, a
 * new instance of this machine, not a move back to `pending`.
 * ========================================================================== */

export const VERIFICATION_CHECK_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "inconclusive",
] as const;
export type VerificationCheckState = (typeof VERIFICATION_CHECK_STATES)[number];

export const VERIFICATION_CHECK_TRANSITIONS: Transitions<VerificationCheckState> = {
  // A user can skip a check before it starts.
  pending: ["running", "skipped"],
  running: ["passed", "failed", "skipped", "inconclusive"],
  passed: [],
  failed: [],
  skipped: [],
  inconclusive: [],
};

/* =============================================================================
 * Approval (record 04's approval flow; the run waits in record 10's
 * "waiting_for_approval").
 * ========================================================================== */

export const APPROVAL_STATES = ["requested", "approved", "rejected", "expired"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const APPROVAL_TRANSITIONS: Transitions<ApprovalState> = {
  requested: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

/* =============================================================================
 * Review action (record 16, "Review-task model"), with snake_case identifiers
 * for the record's Title Case labels.
 * ========================================================================== */

export const REVIEW_ACTION_STATES = [
  "unreviewed",
  "selected",
  "in_progress",
  "addressed",
  "dismissed",
  "needs_clarification",
  "outdated",
] as const;
export type ReviewActionState = (typeof REVIEW_ACTION_STATES)[number];

export const REVIEW_ACTION_TRANSITIONS: Transitions<ReviewActionState> = {
  unreviewed: ["selected", "dismissed", "needs_clarification", "outdated"],
  selected: ["in_progress", "unreviewed", "dismissed", "needs_clarification", "outdated"],
  in_progress: ["addressed", "needs_clarification", "dismissed", "outdated"],
  needs_clarification: ["selected", "dismissed", "outdated"],
  // GitHub can remap a comment after it is addressed, or the user can
  // decide the response needs to be reclassified.
  addressed: ["outdated", "unreviewed"],
  dismissed: ["unreviewed"],
  outdated: ["unreviewed", "dismissed"],
};

/* =============================================================================
 * Model failure categories (record 15, "Failure categories"). A closed
 * classification of why a run failed, not a lifecycle, so it has no
 * transition table and no entry in `MACHINES`.
 * ========================================================================== */

export const MODEL_FAILURE_CATEGORIES = [
  "temporary_service_failure",
  "rate_limited",
  "usage_limit_reached",
  "authentication_failed",
  "model_unavailable",
  "request_rejected",
  "broker_failure",
] as const;
export type ModelFailureCategory = (typeof MODEL_FAILURE_CATEGORIES)[number];

/* =============================================================================
 * The registry and the one entry point.
 * ========================================================================== */

export const MACHINES = {
  session: { states: SESSION_STATES, initial: "active", transitions: SESSION_TRANSITIONS },
  run: { states: RUN_STATES, initial: "created", transitions: RUN_TRANSITIONS },
  sandbox: { states: SANDBOX_STATES, initial: "requested", transitions: SANDBOX_TRANSITIONS },
  plan: { states: PLAN_STATES, initial: "proposed", transitions: PLAN_TRANSITIONS },
  verificationCheck: {
    states: VERIFICATION_CHECK_STATES,
    initial: "pending",
    transitions: VERIFICATION_CHECK_TRANSITIONS,
  },
  approval: { states: APPROVAL_STATES, initial: "requested", transitions: APPROVAL_TRANSITIONS },
  reviewAction: {
    states: REVIEW_ACTION_STATES,
    initial: "unreviewed",
    transitions: REVIEW_ACTION_TRANSITIONS,
  },
} as const satisfies Record<string, Machine<string>>;

export type MachineName = keyof typeof MACHINES;
export type StateOf<M extends MachineName> = (typeof MACHINES)[M]["states"][number];

/**
 * `from` and `to` are constrained to the named machine's own alphabet, so a
 * state from another machine fails `tsc`.
 */
export function canTransition<M extends MachineName>(
  machine: M,
  from: StateOf<M>,
  to: StateOf<M>,
): boolean {
  const transitions = MACHINES[machine].transitions as Transitions<StateOf<M>>;
  return transitions[from].includes(to);
}

export function isTerminal<M extends MachineName>(machine: M, state: StateOf<M>): boolean {
  const transitions = MACHINES[machine].transitions as Transitions<StateOf<M>>;
  return transitions[state].length === 0;
}

export function nextStates<M extends MachineName>(
  machine: M,
  from: StateOf<M>,
): readonly StateOf<M>[] {
  const transitions = MACHINES[machine].transitions as Transitions<StateOf<M>>;
  return transitions[from];
}

/* =============================================================================
 * Sandbox loss -> run state (record 01, "Losing a sandbox"). Keyed on how the
 * sandbox left and whether a checkpoint is known, as the record's table is.
 * ========================================================================== */

export type SandboxLossKind = "stopped" | "failed" | "replaced";
export type CheckpointKnown = "checkpointed" | "uncheckpointed";

/**
 * Record 01's table. `replaced` with a known checkpoint yields `interrupted`;
 * the caller then applies the existing `interrupted -> provisioning` edge.
 */
export const SANDBOX_LOSS_TO_RUN: Readonly<
  Record<SandboxLossKind, Readonly<Record<CheckpointKnown, RunState>>>
> = {
  stopped: { checkpointed: "paused", uncheckpointed: "interrupted" },
  replaced: { checkpointed: "interrupted", uncheckpointed: "interrupted" },
  failed: { checkpointed: "interrupted", uncheckpointed: "failed" },
};

/**
 * Record 01: a run still in `provisioning` when its sandbox fails moves to
 * `failed`, whatever the checkpoint, because no work started that a checkpoint
 * could restore. Other rows assume the run is `running`; `currentRun` is not
 * otherwise checked, since the record does not cover other states.
 */
export function runStateAfterSandboxLoss(
  currentRun: RunState,
  sandboxLeftAs: SandboxLossKind,
  checkpoint: CheckpointKnown,
): RunState {
  if ((currentRun === "provisioning" || currentRun === "ready") && sandboxLeftAs === "failed") {
    return "failed";
  }
  return SANDBOX_LOSS_TO_RUN[sandboxLeftAs][checkpoint];
}
