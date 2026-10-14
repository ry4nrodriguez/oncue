import { RUN_OUTCOMES, RUN_STATES, type RunState } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import type { SessionListRow } from "@/lib/api/sessions";
import { activityLabel, activityOf, endedRunId, isWorking } from "./session-activity";

function row(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    sessionId: "s1",
    title: "Fix the bug",
    state: "active",
    lastActivityAt: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    repositoryFullName: null,
    taskBranch: null,
    waitingForUser: false,
    currentRunId: "run_1",
    currentRunState: "running",
    ...overrides,
  };
}

const WORKING_STATES: readonly RunState[] = [
  "created",
  "queued",
  "provisioning",
  "ready",
  "running",
];
const NEEDS_YOU_STATES: readonly RunState[] = ["waiting_for_approval", "paused", "interrupted"];

describe("activityOf", () => {
  it("says working while the run is being set up or run", () => {
    for (const state of WORKING_STATES) {
      expect(activityOf(row({ currentRunState: state }), undefined, false)).toEqual({
        kind: "working",
      });
    }
  });

  it("says needs you while the run waits on a decision or a Continue", () => {
    for (const state of NEEDS_YOU_STATES) {
      expect(activityOf(row({ currentRunState: state }), undefined, false)).toEqual({
        kind: "needs_you",
      });
    }
  });

  it("covers every run state record 01 names, in exactly one of the three groups", () => {
    const grouped = new Set([...WORKING_STATES, ...NEEDS_YOU_STATES, ...RUN_OUTCOMES]);
    expect([...grouped].sort()).toEqual([...RUN_STATES].sort());
  });

  it("says needs you for an open card even while the run works, because the card is what waits", () => {
    expect(activityOf(row({ waitingForUser: true }), undefined, false)).toEqual({
      kind: "needs_you",
    });
  });

  it("says finished for an ended run nobody has seen, naming the outcome", () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(activityOf(row({ currentRunState: outcome }), undefined, false)).toEqual({
        kind: "finished",
        outcome,
      });
    }
  });

  it("says nothing once that run was seen, and again for the next run that ends", () => {
    const ended = row({ currentRunId: "run_1", currentRunState: "verified" });
    expect(activityOf(ended, "run_1", false)).toEqual({ kind: "idle" });
    const next = row({ currentRunId: "run_2", currentRunState: "failed" });
    expect(activityOf(next, "run_1", false)).toEqual({ kind: "finished", outcome: "failed" });
  });

  it("says nothing for the session on screen, whose run ended in front of the user", () => {
    expect(activityOf(row({ currentRunState: "verified" }), undefined, true)).toEqual({
      kind: "idle",
    });
  });

  it("says nothing for an archived session, or one not projected since migration 0015", () => {
    expect(activityOf(row({ state: "archived" }), undefined, false)).toEqual({ kind: "idle" });
    expect(activityOf(row({ state: "archived", waitingForUser: true }), undefined, false)).toEqual({
      kind: "idle",
    });
    expect(activityOf(row({ currentRunState: null }), undefined, false)).toEqual({ kind: "idle" });
    expect(activityOf(row({ currentRunId: null }), undefined, false)).toEqual({ kind: "idle" });
  });
});

describe("isWorking and endedRunId", () => {
  it("only an active session's set-up or running run keeps the list polling", () => {
    expect(isWorking(row({ currentRunState: "provisioning" }))).toBe(true);
    expect(isWorking(row({ currentRunState: "paused" }))).toBe(false);
    expect(isWorking(row({ currentRunState: "verified" }))).toBe(false);
    expect(isWorking(row({ currentRunState: null }))).toBe(false);
    expect(isWorking(row({ state: "archived" }))).toBe(false);
  });

  it("names the run only once it has ended", () => {
    expect(endedRunId(row({ currentRunState: "cancelled" }))).toBe("run_1");
    expect(endedRunId(row({ currentRunState: "running" }))).toBeNull();
    expect(endedRunId(row({ currentRunState: null }))).toBeNull();
    expect(endedRunId(row({ currentRunId: null, currentRunState: "verified" }))).toBeNull();
  });
});

describe("activityLabel", () => {
  it("says each dot in words, and draws none when idle", () => {
    expect(activityLabel({ kind: "working" })).toBe("Working");
    expect(activityLabel({ kind: "needs_you" })).toBe("Needs you");
    expect(activityLabel({ kind: "finished", outcome: "completed" })).toBe("Done, not opened yet");
    expect(activityLabel({ kind: "finished", outcome: "completed_with_warnings" })).toBe(
      "Completed with warnings, not opened yet",
    );
    expect(activityLabel({ kind: "idle" })).toBeNull();
  });
});
