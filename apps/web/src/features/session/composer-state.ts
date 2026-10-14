import type { RunView, SandboxState } from "@oncue/protocol";
import { nanoid } from "nanoid";

/**
 * Composer state that must survive a remount or a failed send: one idempotency
 * id reused until the send succeeds, and a locally persisted draft.
 */
const DRAFT_PREFIX = "oncue.draft.";

/**
 * What a send will do. `steer` and `run_next` are `run.follow_up` deliveries;
 * `start_next` is a `run.start`; `resume` steers a paused or interrupted run
 * whose sandbox is gone, which the object resumes on a new generation. `wait`
 * sends nothing: the run is paused or interrupted and the object would refuse
 * every message until its sandbox stops (`waitReason` says why).
 */
export type SubmitIntent = "steer" | "run_next" | "start_next" | "resume" | "wait";

/** The run fields the intent is derived from, so a test can pass a stub. */
export type RunForIntent = Pick<RunView, "state" | "ending" | "pause" | "interruption">;

/** The sandbox states in which nothing is running that a steer could reach. */
const ENDED_SANDBOX_STATES: ReadonlySet<SandboxState> = new Set(["stopped", "failed", "replaced"]);

/** Whether a run could still be using the sandbox; the non-live states are those in which the object accepts a Continue. */
export function sandboxIsLive(state: SandboxState | null): boolean {
  return state !== null && !ENDED_SANDBOX_STATES.has(state);
}

/**
 * Whether a message would continue the run: it is paused or interrupted, its
 * sandbox is gone, and its model connection is still active. A run interrupted
 * by the planned replacement is excluded, since the object resumes it itself
 * and a Continue would race it.
 */
export function canContinue(
  run: RunForIntent | null,
  sandboxLive: boolean,
  runModelUsable = true,
): boolean {
  if (run === null || run.ending !== null || sandboxLive || !runModelUsable) {
    return false;
  }
  if (run.state === "interrupted") {
    return run.interruption?.reason !== "sandbox_replaced";
  }
  return run.state === "paused";
}

/** Where keys are added, which the guidance links to. */
export const MODEL_CONNECTIONS_PATH = "/settings/model-providers";

/**
 * Whether the next message needs a new generation that the inactive model
 * connection cannot have. The object would refuse it, so the composer offers
 * no send and says what to do about the key (`model-failure.ts`).
 */
export function continueNeedsNewKey(
  run: RunForIntent | null,
  sandboxLive: boolean,
  runModelUsable: boolean,
): boolean {
  if (runModelUsable || sandboxLive || run === null) {
    return false;
  }
  return run.ending !== null || canContinue(run, sandboxLive);
}

function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

export function loadDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    // Blocked storage is a lost convenience, never an error the user sees.
    return "";
  }
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text === "") {
      window.localStorage.removeItem(draftKey(sessionId));
    } else {
      window.localStorage.setItem(draftKey(sessionId), text);
    }
  } catch {
    // As above.
  }
}

export function clearDraft(sessionId: string): void {
  saveDraft(sessionId, "");
}

/**
 * Assigns an idempotency id once and hands back the same one on every retry,
 * so a double click or a resend after a dropped socket is one message.
 */
export function nextCommandId(pending: string | null, newId: () => string = nanoid): string {
  return pending ?? newId();
}

export function canSubmit(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Whether a message steers, queues, or starts a run (record 13). A steer is
 * valid only while the run is `running` or `waiting_for_approval`, so other
 * live states queue, except `resume` (see `canContinue`). A paused or
 * interrupted run takes only a Continue, and only once its sandbox has
 * stopped (record 10), so until then nothing is offered.
 */
export function intentFor(
  run: RunForIntent | null,
  sandboxLive: boolean,
  runModelUsable = true,
): SubmitIntent {
  if (run === null || run.ending !== null) {
    return "start_next";
  }
  if (canContinue(run, sandboxLive, runModelUsable)) {
    return "resume";
  }
  if (run.state === "running" || run.state === "waiting_for_approval") {
    return "steer";
  }
  if (run.state === "paused" || run.state === "interrupted") {
    return "wait";
  }
  return "run_next";
}

/**
 * Why a paused or interrupted run takes no message now, or null when a
 * message can be sent or the key's own note already explains.
 */
export function waitReason(
  run: RunForIntent | null,
  sandboxLive: boolean,
  runModelUsable = true,
): "sandbox_running" | "replacing" | null {
  if (
    intentFor(run, sandboxLive, runModelUsable) !== "wait" ||
    continueNeedsNewKey(run, sandboxLive, runModelUsable)
  ) {
    return null;
  }
  return run?.state === "interrupted" && run.interruption?.reason === "sandbox_replaced"
    ? "replacing"
    : "sandbox_running";
}

export const WAIT_GUIDANCE: Record<"sandbox_running" | "replacing", string> = {
  sandbox_running:
    "This run is paused or interrupted, and its sandbox is still running, so a message can't reach it. Stop the run to send a new message from here, or wait: once the idle sandbox stops, Continue picks the run up from its last checkpoint.",
  replacing:
    "OnCue is moving this run to a new sandbox and will resume it itself. Send your message once it is running again.",
};

export function intentLabel(intent: SubmitIntent): string {
  switch (intent) {
    case "steer":
      return "Steers this run";
    case "run_next":
      return "Runs next";
    case "start_next":
      return "Starts the next run";
    case "resume":
      return "Continue";
    case "wait":
      return "Can't send to this run yet";
  }
}

/**
 * The `run.follow_up` delivery for an intent. The composer's label and the sent
 * command both read this one mapping so they cannot drift.
 */
export function deliveryFor(
  intent: Exclude<SubmitIntent, "start_next" | "wait">,
): "steer_current_run" | "run_next" {
  return intent === "run_next" ? "run_next" : "steer_current_run";
}
