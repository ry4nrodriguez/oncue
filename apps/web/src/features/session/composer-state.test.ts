import { type RunState, SANDBOX_STATES } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  canContinue,
  continueNeedsNewKey,
  deliveryFor,
  intentFor,
  intentLabel,
  type RunForIntent,
  sandboxIsLive,
  WAIT_GUIDANCE,
  waitReason,
} from "./composer-state";

type PauseReason = NonNullable<RunForIntent["pause"]>["reason"];
type InterruptionReason = NonNullable<RunForIntent["interruption"]>["reason"];

function run(state: RunState, extra: Partial<RunForIntent> = {}): RunForIntent {
  return { state, ending: null, pause: null, interruption: null, ...extra };
}

function paused(reason: PauseReason): RunForIntent {
  return run("paused", {
    pause: makeCommittedEvent("run.paused", { payload: { reason } }).payload,
  });
}

function interrupted(reason: InterruptionReason): RunForIntent {
  return run("interrupted", {
    interruption: makeCommittedEvent("run.interrupted", { payload: { reason } }).payload,
  });
}

const PAUSES_THAT_CONTINUE: readonly PauseReason[] = [
  "user_requested",
  "idle_stop",
  "no_progress",
  "approval_expired",
  "lifetime_ceiling",
];

const INTERRUPTIONS_THAT_CONTINUE: readonly InterruptionReason[] = [
  "sandbox_lost",
  "sandbox_failed",
  "bridge_timeout",
  "runtime_exited",
];

describe("sandboxIsLive", () => {
  it("counts no sandbox, and a stopped, failed, or replaced one, as not live", () => {
    expect(sandboxIsLive(null)).toBe(false);
    const live = SANDBOX_STATES.filter((state) => sandboxIsLive(state));
    expect(live).toEqual([
      "requested",
      "provisioning",
      "ready",
      "attached",
      "active",
      "idle",
      "checkpointing",
    ]);
  });
});

describe("intentFor", () => {
  it("starts the next run with no run, or once the run has ended, live sandbox or not", () => {
    const ended = run("verified", {
      ending: { outcome: "verified", ...makeCommittedEvent("run.verified").payload },
    });
    for (const live of [true, false]) {
      expect(intentFor(null, live)).toBe("start_next");
      expect(intentFor(ended, live)).toBe("start_next");
    }
  });

  it("steers a running or waiting run whatever the sandbox scalar says", () => {
    for (const live of [true, false]) {
      expect(intentFor(run("running"), live)).toBe("steer");
      expect(intentFor(run("waiting_for_approval"), live)).toBe("steer");
    }
  });

  it("queues behind a run that has not started yet", () => {
    for (const state of ["created", "queued", "provisioning", "ready"] as const) {
      expect(intentFor(run(state), false)).toBe("run_next");
    }
  });

  it("continues a paused run with no live sandbox, a model failure included", () => {
    for (const reason of PAUSES_THAT_CONTINUE) {
      expect(intentFor(paused(reason), false)).toBe("resume");
      // The object refuses any message while the sandbox is still up.
      expect(intentFor(paused(reason), true)).toBe("wait");
    }
    expect(intentFor(run("paused"), false)).toBe("resume");
    // With the run's connection still active, a model-failure pause resumes
    // once the sandbox idled out; while it is still up, nothing changes.
    expect(intentFor(paused("model_failure"), false)).toBe("resume");
    expect(intentFor(paused("model_failure"), true)).toBe("wait");
    // While the run's connection is not active the object refuses any Continue,
    // so none is offered, whatever paused the run.
    expect(intentFor(paused("model_failure"), false, false)).toBe("wait");
    expect(canContinue(paused("model_failure"), false, false)).toBe(false);
    expect(canContinue(paused("idle_stop"), false, false)).toBe(false);
  });

  it("offers no Continue for an interrupted run whose connection is not active, and leaves a replacement to the object", () => {
    for (const reason of INTERRUPTIONS_THAT_CONTINUE) {
      expect(canContinue(interrupted(reason), false, false)).toBe(false);
      expect(intentFor(interrupted(reason), false, false)).toBe("wait");
    }
    expect(canContinue(interrupted("sandbox_replaced"), false, false)).toBe(false);
  });
});

describe("continueNeedsNewKey", () => {
  it("is true only where a Continue is withheld for want of an active connection", () => {
    expect(continueNeedsNewKey(paused("model_failure"), false, false)).toBe(true);
    expect(continueNeedsNewKey(interrupted("sandbox_lost"), false, false)).toBe(true);
    // An active connection, a live sandbox, a replacement, or no run: nothing withheld.
    expect(continueNeedsNewKey(paused("model_failure"), false, true)).toBe(false);
    expect(continueNeedsNewKey(paused("model_failure"), true, false)).toBe(false);
    expect(continueNeedsNewKey(interrupted("sandbox_replaced"), false, false)).toBe(false);
    expect(continueNeedsNewKey(run("running"), false, false)).toBe(false);
    expect(continueNeedsNewKey(null, false, false)).toBe(false);
    // A run that ended: its next message is a run.start on the same model,
    // which the object refuses too, unless the sandbox is live or the key active.
    const ended = run("verified", {
      ending: { outcome: "verified", ...makeCommittedEvent("run.verified").payload },
    });
    expect(continueNeedsNewKey(ended, false, false)).toBe(true);
    expect(continueNeedsNewKey(ended, true, false)).toBe(false);
    expect(continueNeedsNewKey(ended, false, true)).toBe(false);
  });

  it("continues an interrupted run with no live sandbox, unless the object is replacing it", () => {
    for (const reason of INTERRUPTIONS_THAT_CONTINUE) {
      expect(intentFor(interrupted(reason), false)).toBe("resume");
      expect(intentFor(interrupted(reason), true)).toBe("wait");
    }
    expect(intentFor(run("interrupted"), false)).toBe("resume");
    expect(intentFor(interrupted("sandbox_replaced"), false)).toBe("wait");
  });

  it("agrees with canContinue, which the rail's Continue button reads", () => {
    expect(canContinue(null, false)).toBe(false);
    expect(canContinue(paused("idle_stop"), false)).toBe(true);
    expect(canContinue(paused("idle_stop"), true)).toBe(false);
    expect(canContinue(run("running"), false)).toBe(false);
  });
});

describe("waitReason", () => {
  it("says a paused or interrupted run waits for its sandbox to stop", () => {
    expect(waitReason(paused("model_failure"), true)).toBe("sandbox_running");
    expect(waitReason(interrupted("sandbox_lost"), true)).toBe("sandbox_running");
    expect(waitReason(run("paused"), true)).toBe("sandbox_running");
  });

  it("says OnCue is resuming a run it is moving to a new sandbox, live or not", () => {
    expect(waitReason(interrupted("sandbox_replaced"), false)).toBe("replacing");
    expect(waitReason(interrupted("sandbox_replaced"), true)).toBe("replacing");
  });

  it("is null where a message can be sent, or the refused-key note explains instead", () => {
    expect(waitReason(null, true)).toBeNull();
    expect(waitReason(run("running"), true)).toBeNull();
    expect(waitReason(run("queued"), false)).toBeNull();
    expect(waitReason(paused("model_failure"), false)).toBeNull();
    expect(waitReason(paused("model_failure"), false, false)).toBeNull();
    // A live sandbox refuses the message whatever the key's state.
    expect(waitReason(paused("model_failure"), true, false)).toBe("sandbox_running");
    expect(waitReason(interrupted("sandbox_replaced"), false, false)).toBe("replacing");
  });

  it("has words for each reason", () => {
    expect(WAIT_GUIDANCE.sandbox_running).toContain("Stop the run");
    expect(WAIT_GUIDANCE.replacing).toContain("new sandbox");
  });
});

describe("intentLabel and deliveryFor", () => {
  it("names each intent, and a Continue steers the run it resumes", () => {
    expect(intentLabel("steer")).toBe("Steers this run");
    expect(intentLabel("run_next")).toBe("Runs next");
    expect(intentLabel("start_next")).toBe("Starts the next run");
    expect(intentLabel("resume")).toBe("Continue");
    expect(intentLabel("wait")).toBe("Can't send to this run yet");
    expect(deliveryFor("steer")).toBe("steer_current_run");
    expect(deliveryFor("resume")).toBe("steer_current_run");
    expect(deliveryFor("run_next")).toBe("run_next");
  });
});
