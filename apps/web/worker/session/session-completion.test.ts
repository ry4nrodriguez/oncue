// The completion gate at the object's boundary (record 14): a `run.verified`
// is accepted only when the object's records back it. A refused claim is never
// stored; the supported outcome ends the run instead, and a socket that keeps
// claiming is cut off.

import { runInDurableObject } from "cloudflare:test";
import { TEST_SHA, testCompletionSummary } from "@oncue/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import {
  completeVerification,
  eventCount,
  eventsOfType,
  finishRun,
  followUpCommand,
  openClient,
  readyBridge,
  recordCheck,
  registerSessionWorlds,
  runRowOf,
  type SessionWorld,
  sessionOnRealDriver,
  settle,
  type TestBridge,
  waitFor,
} from "../test/session-world";
import { MAX_OUTCOME_REFUSALS } from "./session-object";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

/** A session whose run is running, so a terminal event has a run to end. */
async function runningWorld(
  sessionId: string,
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

async function lastRuntimeSequence(world: SessionWorld): Promise<number | null> {
  return runInDurableObject(
    world.stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ last: number | null }>("SELECT last_runtime_sequence AS last FROM session")
        .one().last,
  );
}

async function warningsOf(world: SessionWorld): Promise<string[]> {
  const events = await eventsOfType(world.stub, "run.completed_with_warnings");
  const payload = events[0]?.payload as { warnings: Array<{ text: string }> } | undefined;
  return (payload?.warnings ?? []).map((warning) => warning.text);
}

async function checkRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT run_id, check_id, attempt, sandbox_generation, classification, revision, result, evidence_artifact_id FROM verification_check ORDER BY check_id, attempt",
    ),
  ]);
}

describe("a run.verified the records do not back", () => {
  it("is never stored; the outcome the records support is committed instead and ends the run", async () => {
    const { world, bridge } = await runningWorld("sess_gate_forged");
    // A message held for the next run proves the downgraded outcome fires
    // the same `run_terminal` reaction a bridge terminal does.
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_next", "msg_next", "run_1", "running", "run_next"));
    const before = await eventCount(world.stub);
    const sequenceBefore = await lastRuntimeSequence(world);

    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    await waitFor(() => bridge.commands("run.start").length >= 2, "the released message");
    await settle();

    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    const [downgraded] = await eventsOfType(world.stub, "run.completed_with_warnings");
    expect(downgraded).toMatchObject({
      runId: "run_1",
      sandboxGeneration: 1,
      runtimeSequence: null,
      payload: {
        summary: testCompletionSummary(),
        warnings: [
          {
            text: "The sandbox claimed the run was verified without finishing verification.",
            recommendedAction: expect.any(String),
          },
          {
            text: "No required check was recorded, so nothing proves the change works.",
            recommendedAction: expect.any(String),
          },
        ],
      },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "completed_with_warnings",
      outcome: "completed_with_warnings",
    });
    // The refused frame still consumed its sequence slot, so the bridge is
    // never asked to replay it.
    expect(await lastRuntimeSequence(world)).toBe((sequenceBefore ?? -1) + 1);
    expect(bridge.frames("replay_from")).toEqual([]);
    // The downgrade, its `run.queued`, and the continuation's acknowledgement.
    expect(await eventCount(world.stub)).toBe(before + 3);
    expect(bridge.commands("run.start")[1]).toMatchObject({
      command: { payload: { continuesRunId: "run_1" } },
    });
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("is accepted when every required check passed in this generation with its log stored", async () => {
    const { world, bridge } = await runningWorld("sess_gate_backed");
    await recordCheck(world, bridge, { checkId: "chk_test" });
    await recordCheck(world, bridge, { checkId: "chk_lint", classification: "recommended" });
    completeVerification(bridge, { requiredTotal: 1 });
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "verified",
      "the verified outcome",
    );

    expect(await eventsOfType(world.stub, "run.verified")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "run.completed_with_warnings")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ outcome: "verified" });
    expect(await checkRows(world)).toEqual([
      {
        run_id: "run_1",
        check_id: "chk_lint",
        attempt: 1,
        sandbox_generation: 1,
        classification: "recommended",
        revision: expect.any(String),
        result: "passed",
        evidence_artifact_id: "art_chk_lint_1",
      },
      {
        run_id: "run_1",
        check_id: "chk_test",
        attempt: 1,
        sandbox_generation: 1,
        classification: "required",
        revision: expect.any(String),
        result: "passed",
        evidence_artifact_id: "art_chk_test_1",
      },
    ]);
  });

  it("is refused when a required check failed", async () => {
    const { world, bridge } = await runningWorld("sess_gate_failed");
    await recordCheck(world, bridge, { checkId: "chk_test", result: "failed" });
    completeVerification(bridge);
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await warningsOf(world)).toEqual(["Required check chk_test failed."]);
  });

  it("is refused when the user skipped a required check", async () => {
    const { world, bridge } = await runningWorld("sess_gate_skipped");
    await recordCheck(world, bridge, {
      checkId: "chk_test",
      result: "skipped",
      skipReason: "user_requested",
      evidence: null,
    });
    completeVerification(bridge, { userSkipped: ["chk_test"] });
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await warningsOf(world)).toEqual([
      "A required check was skipped at your request, so the run cannot be verified.",
      "Required check chk_test was skipped.",
    ]);
  });

  it("is refused when the required records belong to an earlier generation", async () => {
    const { world, bridge } = await runningWorld("sess_gate_older");
    await recordCheck(world, bridge, { checkId: "chk_test" });
    completeVerification(bridge);
    // What an earlier sandbox left behind: the same rows, stamped with the
    // generation that wrote them.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE verification_check SET sandbox_generation = 0");
    });
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await warningsOf(world)).toEqual([
      "Required check chk_test ran in an earlier sandbox, not the one that finished this run.",
    ]);
  });

  it("is refused when the required checks ran at different revisions", async () => {
    const { world, bridge } = await runningWorld("sess_gate_revisions");
    await recordCheck(world, bridge, { checkId: "chk_test" });
    await recordCheck(world, bridge, { checkId: "chk_types", revision: TEST_SHA });
    completeVerification(bridge, { requiredTotal: 2 });
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await warningsOf(world)).toEqual([
      "The required checks ran against different revisions of the change.",
    ]);
  });

  it("is refused while a required check's log is declared but not yet committed", async () => {
    const { world, bridge } = await runningWorld("sess_gate_evidence");
    await recordCheck(world, bridge, { checkId: "chk_test", evidence: "declared" });
    completeVerification(bridge);
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await warningsOf(world)).toEqual([
      "The output of required check chk_test was not stored.",
    ]);
  });

  it("is refused for a run that already ended, and commits no second outcome", async () => {
    const world = await sessionOnRealDriver("sess_gate_ended");
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    const before = await eventCount(world.stub);
    const sequenceBefore = (await lastRuntimeSequence(world)) as number;

    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await lastRuntimeSequence(world)) === sequenceBefore + 1,
      "the frame's slot",
    );
    await settle();

    expect(await eventCount(world.stub)).toBe(before);
    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      outcome: "completed_with_warnings",
    });
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it(`closes the socket with 4001 after more than ${MAX_OUTCOME_REFUSALS} refusals`, async () => {
    const { world, bridge } = await runningWorld("sess_gate_cut_off");
    let close: { code: number; reason: string } | null = null;
    bridge.client.addEventListener("close", (event: CloseEvent) => {
      close = { code: event.code, reason: event.reason };
    });

    for (let claim = 0; claim <= MAX_OUTCOME_REFUSALS; claim += 1) {
      bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    }
    await waitFor(() => close !== null, "the close");

    expect(close).toEqual({ code: 4001, reason: "outcome refused" });
    // The first claim ended the run; the rest were refused as late and stored nothing.
    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    expect(await eventsOfType(world.stub, "run.completed_with_warnings")).toHaveLength(1);
  });
});

describe("the user's request to skip the required checks", () => {
  it("travels from the create body onto the first run.start the bridge is sent", async () => {
    const world = await sessionOnRealDriver("sess_gate_skip_create", {
      body: { skipRequiredChecks: true },
    });
    const bridge = await readyBridge(world);
    expect(bridge.commands("run.start")[0]).toMatchObject({
      command: { payload: { instruction: { messageId: "msg_1" }, skipRequiredChecks: true } },
    });
  });
});
