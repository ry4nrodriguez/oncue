import { foldEvents } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  currentSandboxAction,
  formatElapsed,
  sandboxInTransition,
  sandboxPhaseOf,
  sandboxRunningMs,
  stepOffsets,
} from "./sandbox-time";

const T0 = "2026-09-02T00:00:00.000Z";
const T1 = "2026-09-02T00:00:02.400Z";
const T2 = "2026-09-02T00:01:05.000Z";

function running() {
  return foldEvents([
    makeCommittedEvent(
      "sandbox.provisioning",
      { payload: { provider: "modal" }, occurredAt: T0 },
      { sessionSequence: 1 },
    ),
    makeCommittedEvent(
      "sandbox.attached",
      { payload: { provider: "modal", providerSandboxId: "sb-1" }, occurredAt: T1 },
      { sessionSequence: 2 },
    ),
  ]);
}

describe("sandboxPhaseOf", () => {
  it("reads none, starting, running, stopped, and failed off the row", () => {
    expect(sandboxPhaseOf(undefined)).toBe("none");
    const starting = foldEvents([
      makeCommittedEvent(
        "sandbox.provisioning",
        { payload: { provider: "modal" } },
        { sessionSequence: 1 },
      ),
    ]);
    expect(sandboxPhaseOf(currentSandboxAction(starting))).toBe("starting");
    expect(sandboxPhaseOf(currentSandboxAction(running()))).toBe("running");

    const stopped = foldEvents([
      makeCommittedEvent(
        "sandbox.stopped",
        { payload: { outcome: "stopped", reason: "user_requested", checkpointId: null } },
        { sessionSequence: 1 },
      ),
    ]);
    expect(sandboxPhaseOf(currentSandboxAction(stopped))).toBe("stopped");

    const failed = foldEvents([
      makeCommittedEvent(
        "sandbox.stopped",
        { payload: { outcome: "failed", reason: "provisioning_failed", checkpointId: null } },
        { sessionSequence: 1 },
      ),
    ]);
    expect(sandboxPhaseOf(currentSandboxAction(failed))).toBe("failed");
  });
});

describe("sandboxRunningMs", () => {
  it("is in transition from the request until the runtime is ready", () => {
    expect(sandboxInTransition(undefined)).toBe(false);
    expect(sandboxInTransition(currentSandboxAction(running()))).toBe(true);
    const ready = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal", providerSandboxId: "sb-1" }, occurredAt: T1 },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent("runtime.ready", { occurredAt: T2 }, { sessionSequence: 2 }),
    ]);
    expect(sandboxInTransition(currentSandboxAction(ready))).toBe(false);
  });

  it("is null before the sandbox runs, live while it runs, and frozen once it ends", () => {
    expect(sandboxRunningMs(undefined, Date.parse(T2))).toBeNull();
    const live = currentSandboxAction(running());
    expect(sandboxRunningMs(live, Date.parse(T2))).toBe(Date.parse(T2) - Date.parse(T1));

    const ended = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal" }, occurredAt: T1 },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.stopped",
        {
          payload: { outcome: "stopped", reason: "user_requested", checkpointId: null },
          occurredAt: T2,
        },
        { sessionSequence: 2 },
      ),
    ]);
    const frozen = currentSandboxAction(ended);
    expect(sandboxRunningMs(frozen, Date.parse(T2) + 60_000)).toBe(Date.parse(T2) - Date.parse(T1));
  });
});

describe("stepOffsets and formatElapsed", () => {
  it("offsets each step from the first", () => {
    const action = currentSandboxAction(running());
    expect(stepOffsets(action?.steps ?? [])).toEqual(["0s", "+2.4s"]);
    expect(stepOffsets([])).toEqual([]);
  });

  it("reads as a clock at every scale", () => {
    expect(formatElapsed(2400)).toBe("2.4s");
    expect(formatElapsed(16_900)).toBe("16s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });
});

describe("currentSandboxAction", () => {
  it("prefers the fold's current generation and falls back to the highest row", () => {
    const stream = foldEvents([
      makeCommittedEvent(
        "sandbox.provisioning",
        { payload: { provider: "modal" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.replaced",
        { sandboxGeneration: 2, payload: { previousGeneration: 1 } },
        { sessionSequence: 2 },
      ),
    ]);
    expect(currentSandboxAction(stream)?.generation).toBe(2);

    const rowsOnly = foldEvents([
      makeCommittedEvent(
        "sandbox.stopped",
        {
          sandboxGeneration: 3,
          payload: { outcome: "stopped", reason: "idle", checkpointId: null },
        },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.stopped",
        {
          sandboxGeneration: 2,
          payload: { outcome: "stopped", reason: "idle", checkpointId: null },
        },
        { sessionSequence: 2 },
      ),
    ]);
    expect(currentSandboxAction(rowsOnly)?.generation).toBe(3);
    expect(currentSandboxAction(foldEvents([]))).toBeUndefined();
  });
});
