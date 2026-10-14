// The sandbox lifecycle (record 11) as pure plans; the caller supplies the
// clock and ids and performs the effects.
//
// A Durable Object has one alarm and `setAlarm` overwrites it, so each owner
// exposes its next deadline and the shell arms the `earliest`; every owner
// re-derives what is due from stored facts, so an early fire is harmless.
//
// The user's stop, the idle stop, and the planned replacement before Modal's
// 24-hour ceiling share one stored, idempotent step sequence (`StopRow`), so a
// double fire or an eviction mid-stop converges instead of repeating a step.
// The user's stop skips the checkpoint (record 02).

import type { PayloadOf, ProtocolEvent, RunState, SandboxState } from "@oncue/protocol";
import {
  buildEvent,
  CHECKPOINT_FAILURE_TEXT,
  canTransition,
  isTerminal,
  SANDBOX_STATES,
} from "@oncue/protocol";

export interface LifecycleSettings {
  /** Record 11: roughly twenty minutes without activity. */
  readonly idleMs: number;
  /** How long a sandbox may live from attach, which is Modal's `timeout`. */
  readonly lifetimeMs: number;
  /** How far before the ceiling the planned replacement starts. */
  readonly ceilingMarginMs: number;
  /** How long the stop waits for the bridge's checkpoint report. */
  readonly checkpointTimeoutMs: number;
  /** One keep-alive request's extension. */
  readonly keepAliveMs: number;
}

const MINUTE_MS = 60 * 1000;

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  idleMs: 20 * MINUTE_MS,
  lifetimeMs: 24 * 60 * MINUTE_MS,
  ceilingMarginMs: 30 * MINUTE_MS,
  checkpointTimeoutMs: 90 * 1000,
  keepAliveMs: 60 * MINUTE_MS,
};

/** The first probe after a socket closes, then the second, measured from the one before. */
export const PROBE_DELAYS_MS = [15_000, 30_000] as const;

/** How long a stop step is held while its effect runs. */
export const STEP_LEASE_MS = 30_000;

/**
 * How often the alarm looks at a generation whose provisioning is unsettled.
 * Provisioning runs in the object's memory, so an object restarted or evicted
 * meanwhile (a deploy, or a long image build with nobody connected) leaves
 * the generation `provisioning`, or live with no expiry, with nothing driving
 * it. Every interval the alarm checks, and a generation nothing drives is
 * recovered.
 */
export const PROVISION_CHECK_MS = 90_000;

/**
 * How long a recovery may keep finding the provider unreachable before the
 * generation fails: past every bound the in-memory provisioning has.
 */
export const PROVISION_GIVE_UP_MS = 20 * 60_000;

const TERMINATE_BACKOFF_BASE_MS = 5_000;
const TERMINATE_BACKOFF_MAX_MS = 5 * MINUTE_MS;

export interface LifecycleEnv {
  readonly ONCUE_ENV: string;
  readonly ONCUE_IDLE_ALARM_SECONDS?: string | undefined;
  readonly ONCUE_CEILING_SECONDS?: string | undefined;
}

function seconds(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value * 1000 : null;
}

/**
 * The overrides apply only locally, so a hosted deployment cannot stop
 * sandboxes a minute after they go quiet. The ceiling margin shrinks with a
 * short lifetime so the sandbox is not due for replacement on attach.
 */
export function lifecycleSettings(env: LifecycleEnv): LifecycleSettings {
  if (env.ONCUE_ENV !== "local") {
    return DEFAULT_LIFECYCLE_SETTINGS;
  }
  const idleMs = seconds(env.ONCUE_IDLE_ALARM_SECONDS) ?? DEFAULT_LIFECYCLE_SETTINGS.idleMs;
  const lifetimeMs = seconds(env.ONCUE_CEILING_SECONDS) ?? DEFAULT_LIFECYCLE_SETTINGS.lifetimeMs;
  return {
    ...DEFAULT_LIFECYCLE_SETTINGS,
    idleMs,
    lifetimeMs,
    ceilingMarginMs: Math.min(DEFAULT_LIFECYCLE_SETTINGS.ceilingMarginMs, lifetimeMs / 5),
  };
}

export type CheckpointKind = "branch_push" | "local_commit" | "patch_bundle";

export interface CheckpointFact {
  readonly checkpointId: string;
  readonly kind: CheckpointKind;
  readonly headSha: string | null;
}

export type StopCause = "idle" | "lifetime_ceiling" | "user_requested";

export type StopStep =
  | "checkpoint"
  | "awaiting_checkpoint"
  | "revoke"
  | "terminate"
  | "replace"
  | "done";

export interface StopRow {
  readonly generation: number;
  readonly cause: StopCause;
  readonly step: StopStep;
  readonly startedAtMs: number;
  /** Null: the step can run now. A number: the step waits until then. */
  readonly dueAtMs: number | null;
  readonly attempts: number;
  readonly checkpoint: CheckpointFact | null;
  readonly warning: string | null;
  /** The user who asked, for the user's stop's `run.cancelled`. */
  readonly requestedByUserId: string | null;
  /** The ceiling's replacement resumes this run on the next generation. */
  readonly interruptedRunId: string | null;
}

export interface ProbeRow {
  readonly generation: number;
  readonly dueAtMs: number;
  readonly attempts: number;
}

export interface AttachmentFact {
  readonly state: SandboxState;
  readonly provider: "fake" | "modal";
  readonly expiresAtMs: number | null;
  /** When the generation's provisioning began; absent where nothing needs it. */
  readonly startedAtMs?: number;
}

export interface LifecycleView {
  readonly nowMs: number;
  readonly sessionId: string;
  readonly generation: number;
  /** The current generation's attachment, or null before the first. */
  readonly attachment: AttachmentFact | null;
  readonly currentRunId: string | null;
  readonly runState: RunState | null;
  /** The state of the run the current stop's replacement would resume, or null when it names none. */
  readonly interruptedRunState: RunState | null;
  /** When the current generation last committed an event. */
  readonly lastActivityMs: number | null;
  /**
   * Whether a question waits on the user. A run waiting on one is idle: the
   * sandbox stops on its normal timer and the answer resumes the run. Absent
   * reads as none.
   */
  readonly questionOpen?: boolean;
  /**
   * Whether the current run's newest pause in this generation says the
   * provider rejected the run's key. Such a run cannot use this sandbox again:
   * it resumes only on a new one, once the key is replaced. Absent reads as no.
   */
  readonly rejectedKeyPause?: boolean;
  readonly keepAliveUntilMs: number | null;
  readonly bridgeConnected: boolean;
  readonly hasRepository: boolean;
  readonly lastCheckpoint: CheckpointFact | null;
  /** The current generation's stop, in whatever step it reached. */
  readonly stop: StopRow | null;
  readonly probe: ProbeRow | null;
  /**
   * The current generation while its provisioning is unsettled
   * (`provisioningUnsettled`): when it began, and whether this object's
   * memory is still driving it.
   */
  readonly provisioning: { readonly startedAtMs: number; readonly inMemory: boolean } | null;
  readonly settings: LifecycleSettings;
}

const LIVE_STATES: ReadonlySet<SandboxState> = new Set([
  "attached",
  "active",
  "idle",
  "checkpointing",
]);

const STARTING_STATES: ReadonlySet<SandboxState> = new Set(["requested", "provisioning", "ready"]);

/** Record 11's first activity rule, plus a run on its way to executing. */
const ACTIVE_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "provisioning",
  "ready",
  "running",
  "waiting_for_approval",
]);

export function isLive(attachment: AttachmentFact | null): attachment is AttachmentFact {
  return attachment !== null && LIVE_STATES.has(attachment.state);
}

/**
 * Whether a generation's provisioning has not reached its end: the row is
 * still `provisioning`, or it is live with no expiry stored. A bridge is
 * accepted while the row is `provisioning` and its `runtime.ready` moves the
 * row on, so a provisioning lost after that leaves a live row with no
 * ceiling, which only the alarm's check can still give one.
 */
export function provisioningUnsettled(
  attachment: AttachmentFact | null,
): attachment is AttachmentFact {
  if (attachment === null) {
    return false;
  }
  return (
    attachment.state === "provisioning" || (isLive(attachment) && attachment.expiresAtMs === null)
  );
}

export function runIsActive(runState: RunState | null): boolean {
  return runState !== null && ACTIVE_RUN_STATES.has(runState);
}

/** A run that has not reached one of record 01's terminal outcomes, so a cancel still means something. */
function runIsOpen(runState: RunState | null): boolean {
  return runState !== null && !isTerminal("run", runState);
}

export function earliest(candidates: readonly (number | null)[]): number | null {
  let soonest: number | null = null;
  for (const candidate of candidates) {
    if (candidate !== null && (soonest === null || candidate < soonest)) {
      soonest = candidate;
    }
  }
  return soonest;
}

/** A running run whose agent is only waiting on the user's answer to a question. */
function waitingOnQuestion(view: LifecycleView): boolean {
  return view.questionOpen === true && view.runState === "running";
}

/**
 * A run paused because the provider rejected its key. Nothing can run on its
 * sandbox until the key is replaced, and Continue then needs a new sandbox, so
 * the idle stop does not wait out the idle period for it.
 */
function pausedOnRejectedKey(view: LifecycleView): boolean {
  return view.rejectedKeyPause === true && view.runState === "paused";
}

/**
 * The idle period runs from the last activity; a run paused on a rejected key
 * has none to wait out, so its sandbox is due at once. A keep-alive the user
 * asked for is honoured either way.
 */
export function idleDeadline(view: LifecycleView): number | null {
  if (
    !isLive(view.attachment) ||
    view.stop !== null ||
    (runIsActive(view.runState) && !waitingOnQuestion(view)) ||
    view.lastActivityMs === null
  ) {
    return null;
  }
  const idleMs = pausedOnRejectedKey(view) ? 0 : view.settings.idleMs;
  return Math.max(view.lastActivityMs + idleMs, view.keepAliveUntilMs ?? 0);
}

/** Record 11: the replacement is scheduled before the ceiling, keep-alive or not. */
export function ceilingDeadline(view: LifecycleView): number | null {
  const attachment = view.attachment;
  if (!isLive(attachment) || view.stop !== null || attachment.expiresAtMs === null) {
    return null;
  }
  return attachment.expiresAtMs - view.settings.ceilingMarginMs;
}

/**
 * The next whole `PROVISION_CHECK_MS` after the provisioning began, so the
 * alarm wakes an object that lost its provisioning, and the value is stable
 * between checks: every rearm in between computes the same moment and writes
 * nothing.
 */
export function provisioningCheckDeadline(view: LifecycleView): number | null {
  const provisioning = view.provisioning;
  if (provisioning === null || view.stop !== null) {
    return null;
  }
  const elapsed = Math.max(0, view.nowMs - provisioning.startedAtMs);
  return (
    provisioning.startedAtMs + (Math.floor(elapsed / PROVISION_CHECK_MS) + 1) * PROVISION_CHECK_MS
  );
}

export function lifecycleDeadline(view: LifecycleView): number | null {
  const stop = view.stop;
  const stopDue = stop === null || stop.step === "done" ? null : (stop.dueAtMs ?? view.nowMs);
  return earliest([
    idleDeadline(view),
    ceilingDeadline(view),
    stopDue,
    view.probe?.dueAtMs ?? null,
    provisioningCheckDeadline(view),
  ]);
}

export type AlarmAction =
  | { readonly kind: "none" }
  | { readonly kind: "advance_stop" }
  | { readonly kind: "probe" }
  | { readonly kind: "clear_probe" }
  | { readonly kind: "recover_provisioning" }
  | { readonly kind: "begin_stop"; readonly cause: "idle" | "lifetime_ceiling" };

/**
 * ```
 * stop in progress   due          -> advance_stop
 *                    not yet due  -> none (and nothing else: the stop owns the generation)
 * probe due          still owed   -> probe (current generation, live, Modal, no bridge)
 *                    otherwise    -> clear_probe
 * provisioning       unsettled, nothing in memory drives it, a check interval old
 *                                 -> recover_provisioning
 * ceiling due                     -> begin_stop lifetime_ceiling (before idle: it is not optional)
 * idle due                        -> begin_stop idle (at once for a run paused on a rejected key)
 * otherwise                       -> none
 * ```
 */
export function planAlarm(view: LifecycleView): AlarmAction {
  const stop = view.stop;
  if (stop !== null && stop.step !== "done") {
    return (stop.dueAtMs ?? view.nowMs) <= view.nowMs ? { kind: "advance_stop" } : { kind: "none" };
  }
  const probe = view.probe;
  if (probe !== null && probe.dueAtMs <= view.nowMs) {
    const owed =
      probe.generation === view.generation &&
      isLive(view.attachment) &&
      view.attachment.provider === "modal" &&
      !view.bridgeConnected;
    return owed ? { kind: "probe" } : { kind: "clear_probe" };
  }
  const provisioning = view.provisioning;
  if (
    provisioning !== null &&
    !provisioning.inMemory &&
    view.nowMs - provisioning.startedAtMs >= PROVISION_CHECK_MS
  ) {
    return { kind: "recover_provisioning" };
  }
  const ceiling = ceilingDeadline(view);
  if (ceiling !== null && ceiling <= view.nowMs) {
    return { kind: "begin_stop", cause: "lifetime_ceiling" };
  }
  const idle = idleDeadline(view);
  if (idle !== null && idle <= view.nowMs) {
    return { kind: "begin_stop", cause: "idle" };
  }
  return { kind: "none" };
}

export type StopEffect =
  | { readonly kind: "issue_checkpoint"; readonly reason: "idle" | "lifetime_ceiling" }
  | { readonly kind: "revoke_credentials" }
  | { readonly kind: "terminate" }
  | {
      readonly kind: "provision_replacement";
      readonly previousGeneration: number;
      readonly restoredFrom: string | null;
      readonly resumeRunId: string | null;
    };

export interface StopPlan {
  readonly row: StopRow;
  readonly events: readonly ProtocolEvent[];
  /** Where the attachment row must end up; the shell walks record 11's machine to it. */
  readonly attachmentState: SandboxState | null;
}

const NO_CHECKPOINT_WARNING =
  "The sandbox's bridge was not connected, so no checkpoint was taken before it stopped.";

const CHECKPOINT_TIMEOUT_WARNING =
  "The checkpoint did not finish in time, so work since the last saved checkpoint may be lost.";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sessionEvent<T extends ProtocolEvent["type"]>(
  view: LifecycleView,
  type: T,
  eventId: string,
  runId: string | null,
  payload: Parameters<typeof buildEvent<T>>[1]["payload"],
): ProtocolEvent {
  return buildEvent(type, {
    eventId,
    sessionId: view.sessionId,
    runId,
    sandboxGeneration: view.generation,
    runtimeSequence: null,
    occurredAt: iso(view.nowMs),
    payload,
  } as never) as ProtocolEvent;
}

function interruptibleRun(view: LifecycleView): string | null {
  return view.runState === "running" || view.runState === "waiting_for_approval"
    ? view.currentRunId
    : null;
}

/**
 * The first step of a stop. Only an idle or ceiling stop with a repository and
 * a bridge checkpoints; a skipped checkpoint with work to save carries a
 * warning rather than stopping silently (record 11).
 */
export function beginStop(
  view: LifecycleView,
  cause: StopCause,
  requestedByUserId: string | null,
  newEventId: () => string,
): StopPlan {
  const wantsCheckpoint = cause !== "user_requested" && view.hasRepository;
  const canCheckpoint = wantsCheckpoint && view.bridgeConnected;
  const row: StopRow = {
    generation: view.generation,
    cause,
    step: canCheckpoint ? "checkpoint" : "revoke",
    startedAtMs: view.nowMs,
    dueAtMs: null,
    attempts: 0,
    checkpoint: null,
    warning: wantsCheckpoint && !canCheckpoint ? NO_CHECKPOINT_WARNING : null,
    requestedByUserId,
    interruptedRunId: cause === "lifetime_ceiling" ? interruptibleRun(view) : null,
  };
  if (cause !== "idle") {
    return { row, events: [], attachmentState: null };
  }
  // A run that was only waiting on the user's answer pauses with the sandbox;
  // its question stays open, and the answer resumes it.
  const paused =
    waitingOnQuestion(view) && view.currentRunId !== null
      ? [
          sessionEvent(view, "run.paused", newEventId(), view.currentRunId, {
            reason: "idle_stop",
            detail: QUESTION_IDLE_DETAIL,
            checkpointId: null,
          }),
        ]
      : [];
  return {
    row,
    events: [
      sessionEvent(view, "sandbox.idle", newEventId(), null, {
        idleSince: iso(view.lastActivityMs ?? view.nowMs),
        stopAt: iso(view.nowMs),
        keepAliveUntil: view.keepAliveUntilMs === null ? null : iso(view.keepAliveUntilMs),
      }),
      ...paused,
    ],
    attachmentState: "idle",
  };
}

/** What the idle stop's pause says when the run was waiting on a question. */
export const QUESTION_IDLE_DETAIL =
  "The sandbox stopped while the agent waited for your answer. Answering resumes the run.";

/**
 * The row to store before a step's effect runs: due a lease later, so a
 * throwing effect is retried then, not at once. The effect's signal overwrites it.
 */
export function leaseStep(row: StopRow, nowMs: number): StopRow {
  return { ...row, dueAtMs: nowMs + STEP_LEASE_MS };
}

const USER_STOP_DURING_CHECKPOINT_WARNING =
  "Stopped at your request before the checkpoint finished, so work since the last saved checkpoint may be lost.";

/**
 * The user's stop joins a stop already under way; from then on it is the
 * user's (`user_requested`, ending in `run.cancelled`). A checkpoint in
 * progress is abandoned; other steps keep their place and lease.
 *
 * ```
 * checkpoint | awaiting_checkpoint          -> revoke, the user's, with the warning
 * revoke | terminate                         -> same step and lease, the user's
 * replace                                    -> replacement cancelled (below)
 * done, ceiling, replacement still provisioning -> replacement cancelled (below)
 * done, anything else                        -> null: nothing left to stop
 * ```
 *
 * A replacement with no generation yet is cancelled, cancelling the runs it
 * would resume. Only the shell knows whether one is in flight
 * (`replacementPending`); once it has a generation, it is an ordinary stop.
 */
export function joinUserStop(
  view: LifecycleView,
  row: StopRow,
  requestedByUserId: string,
  replacementPending: boolean,
  newEventId: () => string,
): StopPlan | null {
  if (row.step === "done") {
    return row.cause === "lifetime_ceiling" && replacementPending
      ? cancelReplacement(view, row, requestedByUserId, newEventId)
      : null;
  }
  if (row.step === "replace") {
    return cancelReplacement(view, row, requestedByUserId, newEventId);
  }
  const joined: StopRow = { ...row, cause: "user_requested", requestedByUserId };
  if (row.step === "checkpoint" || row.step === "awaiting_checkpoint") {
    return {
      row: {
        ...joined,
        step: "revoke",
        dueAtMs: null,
        warning: USER_STOP_DURING_CHECKPOINT_WARNING,
      },
      events: [],
      attachmentState: null,
    };
  }
  return { row: joined, events: [], attachmentState: null };
}

function cancelReplacement(
  view: LifecycleView,
  row: StopRow,
  requestedByUserId: string,
  newEventId: () => string,
): StopPlan {
  // Only runs still open: one the user already cancelled, or that ended, keeps its outcome.
  const open = [
    runIsOpen(view.interruptedRunState) ? row.interruptedRunId : null,
    runIsOpen(view.runState) ? view.currentRunId : null,
  ];
  const runs = [...new Set(open)].filter((runId): runId is string => runId !== null);
  return {
    row: {
      ...row,
      cause: "user_requested",
      requestedByUserId,
      step: "done",
      dueAtMs: null,
    },
    events: [
      sessionEvent(view, "sandbox.stopped", newEventId(), null, {
        outcome: "stopped",
        reason: "user_requested",
        checkpointId: row.checkpoint?.checkpointId ?? null,
        unsavedWorkWarning: row.warning,
        diagnostics: [],
      }),
      ...runs.map((runId) => userCancelled(view, runId, requestedByUserId, newEventId)),
    ],
    // `replaced` ends a sandbox; the attachment already says it is over.
    attachmentState: null,
  };
}

function userCancelled(
  view: LifecycleView,
  runId: string,
  userId: string,
  newEventId: () => string,
): ProtocolEvent {
  return sessionEvent(view, "run.cancelled", newEventId(), runId, {
    by: { kind: "user", userId },
    checkpointId: null,
    summary: null,
    evidence: [],
    branch: null,
    pullRequestNumber: null,
    usage: null,
    durationMs: 0,
  });
}

const ENDED_STATES: ReadonlySet<SandboxState> = new Set(["stopped", "failed", "replaced"]);

/**
 * Whether a freshly minted credential may still reach its bridge. A stop can
 * revoke while a mint awaits GitHub, and a token minted after that revocation
 * must not reach the sandbox. A stop still at its checkpoint step has not
 * revoked yet, so its own push grant must still be delivered.
 */
export function grantDeliverable(attachment: AttachmentFact | null, stop: StopRow | null): boolean {
  if (attachment === null || ENDED_STATES.has(attachment.state)) {
    return false;
  }
  return stop === null || stop.step === "checkpoint" || stop.step === "awaiting_checkpoint";
}

/** The effect a runnable step owes, or null for a step that only waits. */
export function effectFor(row: StopRow): StopEffect | null {
  switch (row.step) {
    case "checkpoint":
      return {
        kind: "issue_checkpoint",
        reason: row.cause === "lifetime_ceiling" ? "lifetime_ceiling" : "idle",
      };
    case "revoke":
      return { kind: "revoke_credentials" };
    case "terminate":
      return { kind: "terminate" };
    case "replace":
      return {
        kind: "provision_replacement",
        previousGeneration: row.generation,
        restoredFrom: row.checkpoint?.checkpointId ?? null,
        resumeRunId: row.interruptedRunId,
      };
    case "awaiting_checkpoint":
    case "done":
      return null;
  }
}

export type GrantRevocation = {
  readonly kind: "model" | "git" | "push" | "upload";
  readonly outcome: "revoked" | "not_held" | "failed";
};

export type StopSignal =
  | { readonly kind: "checkpoint_issued" }
  /** The bridge could not be told: no current bridge, or it refused the command. */
  | { readonly kind: "checkpoint_unavailable" }
  | { readonly kind: "checkpointed"; readonly checkpoint: CheckpointFact }
  | { readonly kind: "checkpoint_timed_out" }
  /** The bridge said it could not take the checkpoint at all: nothing was saved. */
  | {
      readonly kind: "checkpoint_failed";
      readonly failure: PayloadOf<"sandbox.checkpoint_failed">["failure"];
    }
  | { readonly kind: "revoked"; readonly grants: readonly GrantRevocation[] }
  | { readonly kind: "terminated" }
  | { readonly kind: "terminate_failed" }
  | { readonly kind: "replaced" };

const REVOCATION_REASON: Record<StopCause, "idle" | "lifetime_ceiling" | "user_requested"> = {
  idle: "idle",
  lifetime_ceiling: "lifetime_ceiling",
  user_requested: "user_requested",
};

export function terminateBackoffMs(attempts: number): number {
  return Math.min(TERMINATE_BACKOFF_BASE_MS * 2 ** attempts, TERMINATE_BACKOFF_MAX_MS);
}

function unchanged(row: StopRow): StopPlan {
  return { row, events: [], attachmentState: null };
}

/**
 * ```
 * checkpoint           checkpoint_issued       -> awaiting_checkpoint, due now + timeout, attachment checkpointing
 * checkpoint | awaiting checkpoint_unavailable -> revoke, with the no-checkpoint warning
 * checkpoint | awaiting checkpointed           -> revoke, checkpoint recorded
 * checkpoint | awaiting checkpoint_failed       -> revoke, with the failure's own warning
 * awaiting_checkpoint  checkpoint_timed_out    -> revoke, with the timeout warning
 * revoke               revoked                 -> sandbox.credentials_revoked; terminate
 * terminate            terminated              -> idle: sandbox.stopped { idle }, attachment stopped; done
 *                                                 user: sandbox.stopped { user_requested } + run.cancelled; attachment stopped; done
 *                                                 ceiling: run.interrupted { sandbox_replaced } when a run was executing; attachment replaced; replace
 *                      terminate_failed        -> terminate again after backoff
 * replace              replaced                -> done
 * any other pair                               -> unchanged (a late or duplicate signal changes nothing)
 * ```
 */
export function onStopSignal(
  view: LifecycleView,
  row: StopRow,
  signal: StopSignal,
  newEventId: () => string,
): StopPlan {
  switch (signal.kind) {
    case "checkpoint_issued":
      if (row.step !== "checkpoint") {
        return unchanged(row);
      }
      return {
        row: {
          ...row,
          step: "awaiting_checkpoint",
          dueAtMs: view.nowMs + view.settings.checkpointTimeoutMs,
        },
        events: [],
        attachmentState: "checkpointing",
      };
    case "checkpoint_unavailable":
      // Either step: the refusal is an ack, which can land after the row moved on to wait.
      if (row.step !== "checkpoint" && row.step !== "awaiting_checkpoint") {
        return unchanged(row);
      }
      return {
        row: { ...row, step: "revoke", dueAtMs: null, warning: NO_CHECKPOINT_WARNING },
        events: [],
        attachmentState: null,
      };
    case "checkpointed":
      if (row.step !== "checkpoint" && row.step !== "awaiting_checkpoint") {
        return unchanged(row);
      }
      return {
        row: { ...row, step: "revoke", dueAtMs: null, checkpoint: signal.checkpoint },
        events: [],
        attachmentState: null,
      };
    case "checkpoint_failed":
      // Either step: the report can land before the row moves on to wait.
      // Nothing was saved, so no checkpoint is recorded.
      if (row.step !== "checkpoint" && row.step !== "awaiting_checkpoint") {
        return unchanged(row);
      }
      return {
        row: {
          ...row,
          step: "revoke",
          dueAtMs: null,
          warning: `The checkpoint could not save the work. ${CHECKPOINT_FAILURE_TEXT[signal.failure]}`,
        },
        events: [],
        attachmentState: null,
      };
    case "checkpoint_timed_out":
      if (row.step !== "awaiting_checkpoint") {
        return unchanged(row);
      }
      return {
        row: { ...row, step: "revoke", dueAtMs: null, warning: CHECKPOINT_TIMEOUT_WARNING },
        events: [],
        attachmentState: null,
      };
    case "revoked":
      if (row.step !== "revoke") {
        return unchanged(row);
      }
      return {
        row: { ...row, step: "terminate", dueAtMs: null },
        events: [
          sessionEvent(view, "sandbox.credentials_revoked", newEventId(), null, {
            reason: REVOCATION_REASON[row.cause],
            grants: [...signal.grants],
          }),
        ],
        attachmentState: null,
      };
    case "terminated":
      if (row.step !== "terminate") {
        return unchanged(row);
      }
      return planTerminated(view, row, newEventId);
    case "terminate_failed":
      if (row.step !== "terminate") {
        return unchanged(row);
      }
      return {
        row: {
          ...row,
          attempts: row.attempts + 1,
          dueAtMs: view.nowMs + terminateBackoffMs(row.attempts),
        },
        events: [],
        attachmentState: null,
      };
    case "replaced":
      if (row.step !== "replace") {
        return unchanged(row);
      }
      return { row: { ...row, step: "done", dueAtMs: null }, events: [], attachmentState: null };
  }
}

function planTerminated(view: LifecycleView, row: StopRow, newEventId: () => string): StopPlan {
  const checkpointId = row.checkpoint?.checkpointId ?? null;
  if (row.cause === "lifetime_ceiling") {
    const events =
      row.interruptedRunId === null
        ? []
        : [
            sessionEvent(view, "run.interrupted", newEventId(), row.interruptedRunId, {
              reason: "sandbox_replaced",
              detail: "The sandbox reached its lifetime ceiling and is being replaced.",
              resumableFrom: checkpointId,
              externalActionsPending: [],
            }),
          ];
    return {
      row: { ...row, step: "replace", dueAtMs: null },
      events,
      attachmentState: "replaced",
    };
  }
  const stopped = sessionEvent(view, "sandbox.stopped", newEventId(), null, {
    outcome: "stopped",
    reason: row.cause,
    checkpointId,
    unsavedWorkWarning: row.warning,
    diagnostics: [],
  });
  const events: ProtocolEvent[] = [stopped];
  if (row.cause === "user_requested" && view.currentRunId !== null && runIsOpen(view.runState)) {
    // Only an open run: an ended run keeps its outcome rather than gaining a
    // second ending the fold would ignore.
    events.push(
      userCancelled(view, view.currentRunId, row.requestedByUserId as string, newEventId),
    );
  }
  return {
    row: { ...row, step: "done", dueAtMs: null },
    events,
    attachmentState: "stopped",
  };
}

/** Reconciliation (record 02) starts only for a live Modal sandbox the provider can be asked about. */
export function planSocketClosed(view: LifecycleView): ProbeRow | null {
  if (!isLive(view.attachment) || view.attachment.provider !== "modal" || view.stop !== null) {
    return null;
  }
  return {
    generation: view.generation,
    dueAtMs: view.nowMs + PROBE_DELAYS_MS[0],
    attempts: 0,
  };
}

export type ProbeAnswer = "live" | "gone" | "unknown";

export type RunLossAction = "interrupt" | "fail_provisioning" | "fail_execution" | "none";

export type ProbePlan =
  | { readonly kind: "clear" }
  | { readonly kind: "retry"; readonly probe: ProbeRow }
  /** The provider agrees the sandbox is gone; `planLoss` says what that means once its credentials are revoked. */
  | { readonly kind: "lost" };

export interface LossPlan {
  /** `sandbox.stopped { failed, disappeared }` and, for an executing run with a checkpoint, `run.interrupted`. */
  readonly events: readonly ProtocolEvent[];
  readonly runAction: RunLossAction;
  readonly warning: string;
}

function lostWorkWarning(checkpoint: CheckpointFact | null): string {
  if (checkpoint === null || checkpoint.headSha === null) {
    return "The sandbox was lost before any checkpoint was saved, so work inside it was not kept.";
  }
  return `The sandbox was lost. Work since the checkpoint at ${checkpoint.headSha.slice(0, 7)} was not kept.`;
}

/**
 * A reconnected bridge makes the answer moot; `live` or `unknown` is retried
 * once and then dropped. Only `gone` for the current generation is a loss.
 */
export function planProbeAnswer(view: LifecycleView, answer: ProbeAnswer): ProbePlan {
  const probe = view.probe;
  if (
    probe === null ||
    probe.generation !== view.generation ||
    view.bridgeConnected ||
    !isLive(view.attachment) ||
    view.stop !== null
  ) {
    return { kind: "clear" };
  }
  if (answer !== "gone") {
    const next = PROBE_DELAYS_MS[probe.attempts + 1];
    return next === undefined
      ? { kind: "clear" }
      : {
          kind: "retry",
          probe: { ...probe, dueAtMs: view.nowMs + next, attempts: probe.attempts + 1 },
        };
  }
  return { kind: "lost" };
}

/**
 * Record 01's losing-a-sandbox table, applied after the lost generation's
 * credentials are revoked:
 *
 * ```
 * failed, checkpoint known      executing run -> interrupted, resumable from the checkpoint
 * failed, no checkpoint         executing run -> failed at execution
 * a run that never started work               -> failed at provisioning
 * a run already over                          -> left alone
 * ```
 *
 * "Executing" is `running` or `waiting_for_approval`. Null when the loss is
 * no longer this generation's to record (moved on, already committed, or a stop
 * took over).
 */
export function planLoss(
  view: LifecycleView,
  generation: number,
  newEventId: () => string,
): LossPlan | null {
  if (view.generation !== generation || !isLive(view.attachment) || view.stop !== null) {
    return null;
  }
  const warning = lostWorkWarning(view.lastCheckpoint);
  const checkpointId = view.lastCheckpoint?.checkpointId ?? null;
  const events: ProtocolEvent[] = [
    sessionEvent(view, "sandbox.stopped", newEventId(), null, {
      outcome: "failed",
      reason: "disappeared",
      checkpointId,
      unsavedWorkWarning: warning,
      diagnostics: [],
    }),
  ];
  const executing = interruptibleRun(view);
  if (executing !== null && checkpointId !== null) {
    events.push(
      sessionEvent(view, "run.interrupted", newEventId(), executing, {
        reason: "sandbox_lost",
        detail: warning,
        resumableFrom: checkpointId,
        externalActionsPending: [],
      }),
    );
    return { events, runAction: "interrupt", warning };
  }
  if (executing !== null) {
    return { events, runAction: "fail_execution", warning };
  }
  return {
    events,
    runAction: runIsActive(view.runState) ? "fail_provisioning" : "none",
    warning,
  };
}

export type KeepAlivePlan =
  | { readonly kind: "refused" }
  | { readonly kind: "extended"; readonly expiresAtMs: number; readonly minutes: number };

/** Bounded: never past the planned replacement, which keep-alive does not postpone. */
export function planKeepAlive(view: LifecycleView): KeepAlivePlan {
  if (!isLive(view.attachment) || view.stop !== null) {
    return { kind: "refused" };
  }
  const ceiling = ceilingDeadline(view);
  const wanted = view.nowMs + view.settings.keepAliveMs;
  const expiresAtMs = ceiling === null ? wanted : Math.min(wanted, ceiling);
  return {
    kind: "extended",
    expiresAtMs,
    minutes: Math.max(0, Math.round((expiresAtMs - view.nowMs) / MINUTE_MS)),
  };
}

export type ComputeDecision =
  | { readonly kind: "attached" }
  | { readonly kind: "wait_for_stop" }
  | { readonly kind: "provision" };

/**
 * Whether a command that needs compute has it. A starting generation counts as
 * attached, so a second resume joins it; a stop in progress is waited out.
 */
export function planCompute(view: LifecycleView): ComputeDecision {
  const attachment = view.attachment;
  if (
    attachment !== null &&
    (LIVE_STATES.has(attachment.state) || STARTING_STATES.has(attachment.state))
  ) {
    return { kind: "attached" };
  }
  if (view.stop !== null && view.stop.step !== "done") {
    return { kind: "wait_for_stop" };
  }
  return { kind: "provision" };
}

/**
 * The shortest path through record 11's machine, excluding `from` and
 * including `to`, so the attachment row moves only along allowed edges.
 */
export function sandboxPath(from: SandboxState, to: SandboxState): readonly SandboxState[] | null {
  if (from === to) {
    return [];
  }
  const previous = new Map<SandboxState, SandboxState>();
  const queue: SandboxState[] = [from];
  while (queue.length > 0) {
    const state = queue.shift() as SandboxState;
    for (const next of SANDBOX_STATES) {
      // `idle -> active` is a wake-up, never a waypoint: a stop must not pass
      // back through active.
      const wakes = state === "idle" && next === "active" && to !== "active";
      if (wakes || !canTransition("sandbox", state, next) || next === from || previous.has(next)) {
        continue;
      }
      previous.set(next, state);
      if (next === to) {
        const path: SandboxState[] = [to];
        let cursor = state;
        while (cursor !== from) {
          path.unshift(cursor);
          cursor = previous.get(cursor) as SandboxState;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
