import { describe, expect, it } from "vitest";
import {
  APPROVAL_TRANSITIONS,
  canTransition,
  isTerminal,
  MACHINES,
  MODEL_FAILURE_CATEGORIES,
  nextStates,
  PLAN_TRANSITIONS,
  REVIEW_ACTION_TRANSITIONS,
  RUN_OUTCOMES,
  RUN_STATES,
  RUN_TRANSITIONS,
  type RunState,
  runStateAfterSandboxLoss,
  SANDBOX_TRANSITIONS,
  SESSION_TRANSITIONS,
  VERIFICATION_CHECK_TRANSITIONS,
} from "./states";

describe("session machine (record 10)", () => {
  it("allows every transition in SESSION_TRANSITIONS", () => {
    expect(canTransition("session", "active", "archived")).toBe(true);
    expect(canTransition("session", "active", "deletion_pending")).toBe(true);
    expect(canTransition("session", "archived", "active")).toBe(true);
    expect(canTransition("session", "archived", "deletion_pending")).toBe(true);
  });

  it("forbids a move out of the terminal deletion_pending state", () => {
    expect(canTransition("session", "deletion_pending", "active")).toBe(false);
  });

  it("has no state left over in the table", () => {
    expect(Object.keys(SESSION_TRANSITIONS)).toHaveLength(3);
  });
});

describe("run machine (record 01, fenced transition block)", () => {
  it("allows every transition in the fenced block verbatim", () => {
    expect(canTransition("run", "created", "queued")).toBe(true);
    expect(canTransition("run", "queued", "provisioning")).toBe(true);
    expect(canTransition("run", "queued", "cancelled")).toBe(true);
    expect(canTransition("run", "provisioning", "ready")).toBe(true);
    expect(canTransition("run", "provisioning", "cancelled")).toBe(true);
    expect(canTransition("run", "provisioning", "failed")).toBe(true);
    expect(canTransition("run", "ready", "running")).toBe(true);
    expect(canTransition("run", "running", "waiting_for_approval")).toBe(true);
    expect(canTransition("run", "waiting_for_approval", "running")).toBe(true);
    expect(canTransition("run", "running", "paused")).toBe(true);
    expect(canTransition("run", "paused", "provisioning")).toBe(true);
    expect(canTransition("run", "running", "interrupted")).toBe(true);
    expect(canTransition("run", "interrupted", "provisioning")).toBe(true);
    expect(canTransition("run", "running", "verified")).toBe(true);
    expect(canTransition("run", "running", "completed_with_warnings")).toBe(true);
    expect(canTransition("run", "running", "blocked")).toBe(true);
    expect(canTransition("run", "running", "failed")).toBe(true);
    expect(canTransition("run", "running", "cancelled")).toBe(true);
  });

  it("forbids a move the fenced block does not list", () => {
    // paused returns through provisioning; it cannot resume directly.
    expect(canTransition("run", "paused", "running")).toBe(false);
    // a terminal outcome never re-opens.
    expect(canTransition("run", "verified", "running")).toBe(false);
    expect(canTransition("run", "cancelled", "queued")).toBe(false);
    // work never starts without a sandbox.
    expect(canTransition("run", "queued", "running")).toBe(false);
  });

  it("lets a user stop a run from every state before it reaches a terminal one", () => {
    for (const from of RUN_STATES) {
      if (isTerminal("run", from)) continue;
      expect(canTransition("run", from, "cancelled")).toBe(true);
    }
  });

  it("marks exactly the six outcome states terminal, and nothing else", () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(isTerminal("run", outcome)).toBe(true);
    }
    const nonTerminal: readonly RunState[] = [
      "created",
      "queued",
      "provisioning",
      "ready",
      "running",
      "waiting_for_approval",
      "paused",
      "interrupted",
    ];
    for (const state of nonTerminal) {
      expect(isTerminal("run", state)).toBe(false);
    }
  });

  it("has a row for every run state", () => {
    expect(Object.keys(RUN_TRANSITIONS)).toHaveLength(14);
  });

  it("lets a running run end Done, and a Done run go nowhere (record 14)", () => {
    expect(RUN_OUTCOMES).toContain("completed");
    expect(canTransition("run", "running", "completed")).toBe(true);
    expect(isTerminal("run", "completed")).toBe(true);
    for (const from of [
      "queued",
      "provisioning",
      "ready",
      "paused",
      "waiting_for_approval",
    ] as const) {
      expect(canTransition("run", from, "completed")).toBe(false);
    }
  });
});

describe("sandbox machine (record 11)", () => {
  it("allows every transition in SANDBOX_TRANSITIONS", () => {
    expect(canTransition("sandbox", "requested", "provisioning")).toBe(true);
    expect(canTransition("sandbox", "provisioning", "ready")).toBe(true);
    expect(canTransition("sandbox", "provisioning", "failed")).toBe(true);
    expect(canTransition("sandbox", "ready", "attached")).toBe(true);
    expect(canTransition("sandbox", "ready", "failed")).toBe(true);
    expect(canTransition("sandbox", "attached", "active")).toBe(true);
    expect(canTransition("sandbox", "attached", "failed")).toBe(true);
    expect(canTransition("sandbox", "attached", "replaced")).toBe(true);
    expect(canTransition("sandbox", "active", "idle")).toBe(true);
    expect(canTransition("sandbox", "active", "failed")).toBe(true);
    expect(canTransition("sandbox", "active", "replaced")).toBe(true);
    expect(canTransition("sandbox", "idle", "active")).toBe(true);
    expect(canTransition("sandbox", "idle", "checkpointing")).toBe(true);
    expect(canTransition("sandbox", "idle", "failed")).toBe(true);
    expect(canTransition("sandbox", "idle", "replaced")).toBe(true);
    expect(canTransition("sandbox", "checkpointing", "stopped")).toBe(true);
    expect(canTransition("sandbox", "checkpointing", "failed")).toBe(true);
  });

  it("forbids a move the table does not list", () => {
    // requested cannot skip straight to ready.
    expect(canTransition("sandbox", "requested", "ready")).toBe(false);
    // stopped, failed, and replaced are terminal for this generation.
    expect(canTransition("sandbox", "stopped", "active")).toBe(false);
    expect(canTransition("sandbox", "failed", "replaced")).toBe(false);
  });

  it("has a row for every sandbox state", () => {
    expect(Object.keys(SANDBOX_TRANSITIONS)).toHaveLength(10);
  });
});

describe("plan machine (record 12, fenced transition block)", () => {
  it("allows every transition in the fenced block verbatim", () => {
    expect(canTransition("plan", "proposed", "active")).toBe(true);
    expect(canTransition("plan", "active", "revised")).toBe(true);
    expect(canTransition("plan", "revised", "active")).toBe(true);
    expect(canTransition("plan", "active", "completed")).toBe(true);
    expect(canTransition("plan", "revised", "completed")).toBe(true);
    expect(canTransition("plan", "active", "blocked")).toBe(true);
    expect(canTransition("plan", "active", "cancelled")).toBe(true);
  });

  it("lets a blocked plan resume once the user answers", () => {
    expect(canTransition("plan", "blocked", "active")).toBe(true);
    expect(canTransition("plan", "blocked", "cancelled")).toBe(true);
  });

  it("forbids a move the fenced block does not list", () => {
    // a blocked plan resumes through active, never straight back to revised.
    expect(canTransition("plan", "blocked", "revised")).toBe(false);
    // a plan cannot finish before it starts.
    expect(canTransition("plan", "proposed", "completed")).toBe(false);
    // terminals never re-open.
    expect(canTransition("plan", "completed", "active")).toBe(false);
    expect(canTransition("plan", "cancelled", "active")).toBe(false);
  });

  it("has a row for every plan state", () => {
    expect(Object.keys(PLAN_TRANSITIONS)).toHaveLength(6);
  });
});

describe("verificationCheck machine (record 14)", () => {
  it("allows every transition in VERIFICATION_CHECK_TRANSITIONS", () => {
    expect(canTransition("verificationCheck", "pending", "running")).toBe(true);
    expect(canTransition("verificationCheck", "pending", "skipped")).toBe(true);
    expect(canTransition("verificationCheck", "running", "passed")).toBe(true);
    expect(canTransition("verificationCheck", "running", "failed")).toBe(true);
    expect(canTransition("verificationCheck", "running", "skipped")).toBe(true);
    expect(canTransition("verificationCheck", "running", "inconclusive")).toBe(true);
  });

  it("forbids a move out of a recorded result", () => {
    expect(canTransition("verificationCheck", "passed", "running")).toBe(false);
    expect(canTransition("verificationCheck", "inconclusive", "pending")).toBe(false);
  });

  it("has a row for every verification-check state", () => {
    expect(Object.keys(VERIFICATION_CHECK_TRANSITIONS)).toHaveLength(6);
  });
});

describe("approval machine (record 04)", () => {
  it("allows every transition in APPROVAL_TRANSITIONS", () => {
    expect(canTransition("approval", "requested", "approved")).toBe(true);
    expect(canTransition("approval", "requested", "rejected")).toBe(true);
    expect(canTransition("approval", "requested", "expired")).toBe(true);
  });

  it("forbids a move out of a decided approval", () => {
    expect(canTransition("approval", "approved", "rejected")).toBe(false);
    expect(canTransition("approval", "expired", "requested")).toBe(false);
  });

  it("has a row for every approval state", () => {
    expect(Object.keys(APPROVAL_TRANSITIONS)).toHaveLength(4);
  });
});

describe("reviewAction machine (record 16)", () => {
  it("allows every transition in REVIEW_ACTION_TRANSITIONS", () => {
    expect(canTransition("reviewAction", "unreviewed", "selected")).toBe(true);
    expect(canTransition("reviewAction", "unreviewed", "dismissed")).toBe(true);
    expect(canTransition("reviewAction", "unreviewed", "needs_clarification")).toBe(true);
    expect(canTransition("reviewAction", "unreviewed", "outdated")).toBe(true);
    expect(canTransition("reviewAction", "selected", "in_progress")).toBe(true);
    expect(canTransition("reviewAction", "selected", "unreviewed")).toBe(true);
    expect(canTransition("reviewAction", "selected", "dismissed")).toBe(true);
    expect(canTransition("reviewAction", "selected", "needs_clarification")).toBe(true);
    expect(canTransition("reviewAction", "selected", "outdated")).toBe(true);
    expect(canTransition("reviewAction", "in_progress", "addressed")).toBe(true);
    expect(canTransition("reviewAction", "in_progress", "needs_clarification")).toBe(true);
    expect(canTransition("reviewAction", "in_progress", "dismissed")).toBe(true);
    expect(canTransition("reviewAction", "in_progress", "outdated")).toBe(true);
    expect(canTransition("reviewAction", "needs_clarification", "selected")).toBe(true);
    expect(canTransition("reviewAction", "needs_clarification", "dismissed")).toBe(true);
    expect(canTransition("reviewAction", "needs_clarification", "outdated")).toBe(true);
    expect(canTransition("reviewAction", "addressed", "outdated")).toBe(true);
    expect(canTransition("reviewAction", "addressed", "unreviewed")).toBe(true);
    expect(canTransition("reviewAction", "dismissed", "unreviewed")).toBe(true);
    expect(canTransition("reviewAction", "outdated", "unreviewed")).toBe(true);
    expect(canTransition("reviewAction", "outdated", "dismissed")).toBe(true);
  });

  it("forbids a move the table does not list", () => {
    expect(canTransition("reviewAction", "dismissed", "selected")).toBe(false);
    expect(canTransition("reviewAction", "addressed", "selected")).toBe(false);
  });

  it("has a row for every review-action state", () => {
    expect(Object.keys(REVIEW_ACTION_TRANSITIONS)).toHaveLength(7);
  });
});

describe("nextStates", () => {
  it("returns the same edges canTransition checks against", () => {
    expect(nextStates("approval", "requested")).toEqual(["approved", "rejected", "expired"]);
    expect(nextStates("run", "verified")).toEqual([]);
  });
});

describe("model failure categories (record 15)", () => {
  it("are a plain closed enum, not one of the machines", () => {
    expect(MODEL_FAILURE_CATEGORIES).toEqual([
      "temporary_service_failure",
      "rate_limited",
      "usage_limit_reached",
      "authentication_failed",
      "model_unavailable",
      "request_rejected",
      "broker_failure",
    ]);
    expect(Object.keys(MACHINES)).not.toContain("modelFailureCategory");
  });
});

describe("sandbox loss -> run state (record 01, 'Losing a sandbox')", () => {
  it("maps stopped, keyed on whether a checkpoint is known", () => {
    expect(runStateAfterSandboxLoss("running", "stopped", "checkpointed")).toBe("paused");
    expect(runStateAfterSandboxLoss("running", "stopped", "uncheckpointed")).toBe("interrupted");
  });

  it("maps replaced to interrupted regardless of checkpoint", () => {
    expect(runStateAfterSandboxLoss("running", "replaced", "checkpointed")).toBe("interrupted");
    expect(runStateAfterSandboxLoss("running", "replaced", "uncheckpointed")).toBe("interrupted");
  });

  it("maps failed, keyed on whether a checkpoint is known", () => {
    expect(runStateAfterSandboxLoss("running", "failed", "checkpointed")).toBe("interrupted");
    expect(runStateAfterSandboxLoss("running", "failed", "uncheckpointed")).toBe("failed");
  });

  it("overrides to failed when the run was still provisioning, checkpoint or not", () => {
    expect(runStateAfterSandboxLoss("provisioning", "failed", "checkpointed")).toBe("failed");
    expect(runStateAfterSandboxLoss("provisioning", "failed", "uncheckpointed")).toBe("failed");
  });

  it("treats a ready run like a provisioning one, because no agent work has started", () => {
    expect(runStateAfterSandboxLoss("ready", "failed", "checkpointed")).toBe("failed");
    expect(runStateAfterSandboxLoss("ready", "failed", "uncheckpointed")).toBe("failed");
  });

  it("treats a waiting_for_approval run like a running one, because work is underway", () => {
    expect(runStateAfterSandboxLoss("waiting_for_approval", "stopped", "checkpointed")).toBe(
      "paused",
    );
    expect(runStateAfterSandboxLoss("waiting_for_approval", "failed", "uncheckpointed")).toBe(
      "failed",
    );
  });

  it("does not apply the provisioning override to a loss kind other than failed", () => {
    expect(runStateAfterSandboxLoss("provisioning", "stopped", "checkpointed")).toBe("paused");
    expect(runStateAfterSandboxLoss("provisioning", "replaced", "uncheckpointed")).toBe(
      "interrupted",
    );
  });

  it("produces a state that is a legal RUN_TRANSITIONS destination from running", () => {
    const kinds = ["stopped", "failed", "replaced"] as const;
    const known = ["checkpointed", "uncheckpointed"] as const;
    for (const kind of kinds) {
      for (const checkpoint of known) {
        const result = runStateAfterSandboxLoss("running", kind, checkpoint);
        expect(canTransition("run", "running", result)).toBe(true);
      }
    }
  });
});
