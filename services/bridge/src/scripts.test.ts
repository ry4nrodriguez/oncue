import { TEST_BRANCH, TEST_SHA } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { loadBridgeScript } from "./scripts";

describe("seven-event script", () => {
  it("is the runtime's half of the acceptance stream: six sandbox-origin events from run.started on, runtimeSequence 0..5", () => {
    const script = loadBridgeScript("seven-event");

    expect(script.frames.map((frame) => frame.type)).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.verified",
    ]);
    expect(script.frames.map((frame) => frame.runtimeSequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // `runtime.connected` is the bridge's own frame (sent by `protocol.ts` after
  // `bridge.welcome`); a stand-in that sends it hides a bridge that does not.
  it("never emits runtime.connected, which is the bridge's own event to send", () => {
    const script = loadBridgeScript("seven-event");
    expect(script.frames.some((frame) => frame.type === "runtime.connected")).toBe(false);
    expect(script.frames.some((frame) => frame.type === "runtime.ready")).toBe(false);
  });
});

// `run.started` is where the rail's branch comes from, so a session with a
// repository must see its own branch rather than the fixture's.
describe("seven-event script with a session's real branch", () => {
  it("puts the caller's branch and base commit on run.started", () => {
    const script = loadBridgeScript("seven-event", {
      branch: "oncue/fix-login-7f3a",
      baseSha: "1".repeat(40),
    });

    const started = script.frames.find((frame) => frame.type === "run.started");
    expect(started?.payload).toMatchObject({
      branch: "oncue/fix-login-7f3a",
      baseSha: "1".repeat(40),
    });
  });

  it("keeps the fixture's own branch when the caller has none", () => {
    const script = loadBridgeScript("seven-event");

    const started = script.frames.find((frame) => frame.type === "run.started");
    expect(started?.payload).toMatchObject({ branch: TEST_BRANCH, baseSha: TEST_SHA });
  });

  /**
   * A session with a repository but no expected base commit still names its
   * branch; the base sha stays whatever the run reports.
   */
  it("accepts a branch without a base commit", () => {
    const script = loadBridgeScript("seven-event", { branch: "oncue/task-0001" });

    const started = script.frames.find((frame) => frame.type === "run.started");
    expect(started?.payload).toMatchObject({ branch: "oncue/task-0001", baseSha: TEST_SHA });
  });
});

describe("long-stream script", () => {
  it("has 2000 durable, sandbox-origin frames", () => {
    const script = loadBridgeScript("long-stream");

    expect(script.frames).toHaveLength(2000);
    expect(script.frames.every((frame) => frame.type === "file.changed")).toBe(true);
    expect(script.frames.map((frame) => frame.runtimeSequence)).toEqual(
      Array.from({ length: 2000 }, (_, index) => index),
    );
  });
});

describe("loadBridgeScript: remapping ids onto a real session", () => {
  it("remaps sessionId and a run-scoped frame's runId, leaving a session-scoped frame's null runId alone", () => {
    const script = loadBridgeScript("seven-event", { sessionId: "sess_real", runId: "run_real" });

    expect(script.frames.every((frame) => frame.sessionId === "sess_real")).toBe(true);
    const staleFrames = loadBridgeScript("stale-generation", { sessionId: "s", runId: "r" });
    const sessionScoped = staleFrames.frames.find((frame) => frame.runId === null);
    expect(sessionScoped?.runId).toBeNull();
    const runStarted = script.frames.find((frame) => frame.type === "run.started");
    expect(runStarted?.runId).toBe("run_real");
  });

  it("remaps ids on a fixture-backed script without touching the file on disk", () => {
    const remapped = loadBridgeScript("stale-generation", { sessionId: "sess_real" });
    const original = loadBridgeScript("stale-generation");

    expect(remapped.frames.every((frame) => frame.sessionId === "sess_real")).toBe(true);
    expect(original.frames[0]?.sessionId).toBe("sess_fixture");
  });

  it("returns the script unchanged when no ids are given", () => {
    const script = loadBridgeScript("seven-event");
    expect(script.frames[0]?.sessionId).toBe("sess_1");
  });
});

describe("fixture-backed scripts", () => {
  it("loads stale-generation.jsonl without modifying it", () => {
    const script = loadBridgeScript("stale-generation");

    expect(script.frames.length).toBeGreaterThan(0);
    expect(script.frames.some((frame) => frame.sandboxGeneration === 0)).toBe(true);
  });

  it("loads sequence-gap.jsonl without modifying it", () => {
    const script = loadBridgeScript("sequence-gap");

    expect(script.frames.length).toBeGreaterThan(0);
    const sequences = script.frames
      .map((frame) => frame.runtimeSequence)
      .filter((value): value is number => value !== null);
    // The gap: sequence 3 and 4 are skipped between run.started (2) and
    // message.started (5).
    expect(sequences).toEqual([0, 1, 2, 5, 6]);
  });
});
