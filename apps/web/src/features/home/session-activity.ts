/**
 * What a sidebar row's status mark says, from the list row alone: working,
 * needs you (a card or a paused run), finished (ended and not yet opened,
 * per `seen-runs.ts`), or nothing.
 */

import { RUN_OUTCOMES, type RunOutcome, type RunState } from "@oncue/protocol";
import { STATUS_LABELS } from "@/features/session/status";
import type { SessionListRow } from "@/lib/api/sessions";

export type SessionActivity =
  | { readonly kind: "working" }
  | { readonly kind: "needs_you" }
  | { readonly kind: "finished"; readonly outcome: RunOutcome }
  | { readonly kind: "idle" };

type RunPhase = "working" | "needs_you" | "ended";

/**
 * Record 01's run states grouped as record 13's status vocabulary groups them.
 * A total `Record`, so a new run state is a compile error here.
 */
const RUN_PHASE: Record<RunState, RunPhase> = {
  created: "working",
  queued: "working",
  provisioning: "working",
  ready: "working",
  running: "working",
  waiting_for_approval: "needs_you",
  paused: "needs_you",
  interrupted: "needs_you",
  verified: "ended",
  completed_with_warnings: "ended",
  completed: "ended",
  blocked: "ended",
  failed: "ended",
  cancelled: "ended",
};

const WORKING: SessionActivity = { kind: "working" };
const NEEDS_YOU: SessionActivity = { kind: "needs_you" };
const IDLE: SessionActivity = { kind: "idle" };

function isRunOutcome(state: RunState): state is RunOutcome {
  return (RUN_OUTCOMES as readonly RunState[]).includes(state);
}

/** Whether the row's current run is being set up or run, which is what keeps the list polling. */
export function isWorking(row: SessionListRow): boolean {
  return (
    row.state === "active" &&
    row.currentRunState !== null &&
    RUN_PHASE[row.currentRunState] === "working"
  );
}

/** Whether the row's current run has not reached an outcome, so archiving would cancel it. */
export function runOpen(row: SessionListRow): boolean {
  return row.currentRunState !== null && !isRunOutcome(row.currentRunState);
}

/** The run id a user who opens this session now has seen end, or `null` while no run has ended. */
export function endedRunId(row: SessionListRow): string | null {
  if (row.currentRunId === null || row.currentRunState === null) {
    return null;
  }
  return isRunOutcome(row.currentRunState) ? row.currentRunId : null;
}

/**
 * `open` is true for the session on screen: its run ends in front of the
 * user, so it never asks to be looked at. An archived session shows nothing;
 * the mark is about work that is live or waiting.
 */
export function activityOf(
  row: SessionListRow,
  seenRunId: string | undefined,
  open: boolean,
): SessionActivity {
  if (row.state !== "active") {
    return IDLE;
  }
  if (row.waitingForUser) {
    return NEEDS_YOU;
  }
  const state = row.currentRunState;
  if (state === null || row.currentRunId === null) {
    return IDLE;
  }
  if (!isRunOutcome(state)) {
    return RUN_PHASE[state] === "working" ? WORKING : NEEDS_YOU;
  }
  if (open || seenRunId === row.currentRunId) {
    return IDLE;
  }
  return { kind: "finished", outcome: state };
}

/** The words a screen reader hears, and a pointer's tooltip shows, for a mark. `null` draws none. */
export function activityLabel(activity: SessionActivity): string | null {
  switch (activity.kind) {
    case "working":
      return "Working";
    case "needs_you":
      return "Needs you";
    case "finished":
      return `${STATUS_LABELS[activity.outcome]}, not opened yet`;
    case "idle":
      return null;
  }
}
