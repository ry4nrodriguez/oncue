// Subagents at the object's boundary (record 12): `agent.started` admitted only
// within the live run that names it, once, and within the run's bound;
// `agent.completed` only for a subagent still running on the sandbox that
// reports it; a subagent's own messages and calls only for one admitted; a
// stop only for one of the run's running subagents, which then reaches the
// bridge. A frame for a run that ended first is dropped without counting, and
// an interruption ends the subagents its sandbox left running.

import { runInDurableObject } from "cloudflare:test";
import { agentStatusOf, type CommittedEvent, foldEvents } from "@oncue/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ageProbe,
  allowSubagentStart,
  attachmentStates,
  eventsOfType,
  fireAlarm,
  followUpCommand,
  openClient,
  probeRow,
  quietRepositoryWorld,
  readyBridge,
  registerSessionWorlds,
  runRowOf,
  type SessionWorld,
  sessionOnRealDriver,
  settle,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { MAX_PERMISSION_ASKS_PER_RUN } from "./permission-asks";
import {
  agentRunsIn,
  decideAgentCompleted,
  decideAgentStarted,
  decideAgentTagged,
  MAX_AGENTS_PER_RUN,
} from "./subagents";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

function started(bridge: TestBridge, runId: string, agentId: string, callId = `call_${agentId}`) {
  return bridge.event("agent.started", {
    runId,
    payload: { agentId, parentToolCallId: callId },
  });
}

/** Sends a subagent's start for a call the object allowed to start one. */
async function announce(
  world: SessionWorld,
  bridge: TestBridge,
  runId: string,
  agentId: string,
): Promise<void> {
  await allowSubagentStart(world, runId, `call_${agentId}`, bridge.generation);
  bridge.send(started(bridge, runId, agentId));
}

function completed(
  bridge: TestBridge,
  runId: string,
  agentId: string,
  status: "completed" | "failed" | "cancelled" = "completed",
) {
  return bridge.event("agent.completed", {
    runId,
    payload: {
      agentId,
      status,
      usage: { tokens: 120, toolCalls: 2, durationMs: 900 },
      resultSummary: `${agentId} ${status}`,
    },
  });
}

async function subagentRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT agent_id, run_id, name, description, status, result_summary FROM subagent ORDER BY started_at, agent_id",
    ),
  ]);
}

function stopCommand(commandId: string, runId: string, agentId: string) {
  return {
    type: "agent.stop",
    commandId,
    runId,
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "running" },
    payload: { agentId },
  };
}

/** A fresh session with run_1 running on a ready bridge. */
async function runningWorld(sessionId: string) {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await eventsOfType(world.stub, "run.started")).length === 1, "run");
  return { world, bridge };
}

/** A subagent's own call, tagged with its id. */
function agentCall(bridge: TestBridge, runId: string, agentId: string, callId: string) {
  return bridge.event("tool.requested", { runId, payload: { toolCallId: callId, agentId } });
}

function cancelCommand(commandId: string, runId: string) {
  return {
    type: "run.cancel",
    commandId,
    runId,
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "running" },
    payload: { reason: null, checkpointFirst: false },
  };
}

/** The close code of the bridge's socket, or null while it is open. */
function closeCodeOf(bridge: TestBridge): () => number | null {
  let closed: number | null = null;
  bridge.client.addEventListener("close", (event: CloseEvent) => {
    closed = event.code;
  });
  return () => closed;
}

async function storedCallIds(world: SessionWorld): Promise<string[]> {
  return (await eventsOfType(world.stub, "tool.requested")).map(
    (event) => (event.payload as { toolCallId: string }).toolCallId,
  );
}

describe("the subagent decisions", () => {
  const facts =
    (
      startedThisRun: number,
      alreadyKnown: boolean,
      call: "allowed" | "taken" | "unknown" = "allowed",
    ) =>
    () => ({
      startedThisRun,
      alreadyKnown,
      callAllowed: call !== "unknown",
      callTaken: call === "taken",
    });
  const unread = () => {
    throw new Error("read for a run that is not live");
  };

  it("start a subagent only in a live run, once, within the bound, by a call the object allowed", () => {
    expect(decideAgentStarted({ run: "live", facts: facts(0, false) })).toEqual({ kind: "admit" });
    expect(decideAgentStarted({ run: "live", facts: facts(0, true) })).toEqual({
      kind: "refuse",
      reason: "agent_already_started",
    });
    expect(decideAgentStarted({ run: "live", facts: facts(MAX_AGENTS_PER_RUN, false) })).toEqual({
      kind: "refuse",
      reason: "too_many_agents",
    });
    // A call the object never allowed to start a subagent, or one that already started one.
    for (const call of ["unknown", "taken"] as const) {
      expect(decideAgentStarted({ run: "live", facts: facts(0, false, call) })).toEqual({
        kind: "refuse",
        reason: "agent_call_not_allowed",
      });
    }
    expect(decideAgentStarted({ run: "other", facts: unread })).toEqual({
      kind: "refuse",
      reason: "agent_run_not_running",
    });
    // The run ended before the bridge heard: not stored, and not held against it.
    expect(decideAgentStarted({ run: "ended", facts: unread })).toEqual({ kind: "drop" });
  });

  const row = { runId: "run_1", sandboxGeneration: 2, status: "running" };
  const frame = { runId: "run_1", sandboxGeneration: 2 };

  it("end a subagent only where it runs: that run, that sandbox", () => {
    expect(agentRunsIn(row, frame)).toBe(true);
    expect(decideAgentCompleted({ row, frame, run: unread })).toEqual({ kind: "admit" });
    for (const unsupported of [
      null,
      { ...row, status: "completed" },
      { ...row, runId: "run_2" },
      // Left running by an earlier sandbox of the same run.
      { ...row, sandboxGeneration: 1 },
    ]) {
      expect(agentRunsIn(unsupported, frame)).toBe(false);
      expect(decideAgentCompleted({ row: unsupported, frame, run: () => "live" })).toEqual({
        kind: "refuse",
        reason: "agent_not_running",
      });
      expect(decideAgentCompleted({ row: unsupported, frame, run: () => "ended" })).toEqual({
        kind: "drop",
      });
    }
  });

  it("store a tagged message or call only for a subagent admitted in that run on that sandbox", () => {
    expect(decideAgentTagged({ row, frame, run: unread })).toEqual({ kind: "admit" });
    // Its end may already be stored; the rows it sent before still belong to it.
    expect(decideAgentTagged({ row: { ...row, status: "completed" }, frame, run: unread })).toEqual(
      { kind: "admit" },
    );
    for (const unsupported of [
      null,
      { ...row, runId: "run_2" },
      { ...row, sandboxGeneration: 1 },
    ]) {
      expect(decideAgentTagged({ row: unsupported, frame, run: () => "other" })).toEqual({
        kind: "refuse",
        reason: "agent_not_admitted",
      });
      expect(decideAgentTagged({ row: unsupported, frame, run: () => "ended" })).toEqual({
        kind: "drop",
      });
    }
  });
});

describe("agent.started and agent.completed", () => {
  it("stores a subagent of the running run and its end, and shows both", async () => {
    const { world, bridge } = await runningWorld("sess_agents_stored");
    await announce(world, bridge, "run_1", "ses_child_1");
    bridge.send(completed(bridge, "run_1", "ses_child_1"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.completed")).length === 1,
      "the subagent's end",
    );
    expect(await subagentRows(world)).toEqual([
      {
        agent_id: "ses_child_1",
        run_id: "run_1",
        name: "explore",
        description: "Find where the retry budget is defined",
        status: "completed",
        result_summary: "ses_child_1 completed",
      },
    ]);
  });

  it("refuses a start outside the live run, a second start of the same subagent, and an end for one not running", async () => {
    const { world, bridge } = await runningWorld("sess_agents_refused");
    bridge.send(started(bridge, "run_other", "ses_elsewhere"));
    await announce(world, bridge, "run_1", "ses_child_1");
    bridge.send(started(bridge, "run_1", "ses_child_1", "call_again"));
    bridge.send(completed(bridge, "run_1", "ses_unknown"));
    await settle();
    expect(await eventsOfType(world.stub, "agent.started")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "agent.completed")).toEqual([]);
    expect((await subagentRows(world)).map((row) => row.agent_id)).toEqual(["ses_child_1"]);
  });

  it("refuses a start for a run that has not started, and for a run that is neither current nor ended", async () => {
    const world = await sessionOnRealDriver("sess_agents_not_live");
    const bridge = await readyBridge(world);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("ready");
    await announce(world, bridge, "run_1", "ses_too_early");
    // A run parked behind the current one, as a pause the user never continued leaves it.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO run (id, session_id, state, outcome, trigger, sandbox_generation, created_by_command_id, queued_at)
           VALUES ('run_parked', ?, 'paused', NULL, 'user_message', 1, 'cmd_parked', ?)`,
        world.sessionId,
        WORLD_TIME,
      );
    });
    await announce(world, bridge, "run_parked", "ses_parked");
    await settle();
    expect(await subagentRows(world)).toEqual([]);
  });

  it(`admits at most ${MAX_AGENTS_PER_RUN} a run`, async () => {
    const { world, bridge } = await runningWorld("sess_agents_bounded");
    for (let index = 0; index <= MAX_AGENTS_PER_RUN; index += 1) {
      await announce(world, bridge, "run_1", `ses_child_${index}`);
    }
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === MAX_AGENTS_PER_RUN,
      "the bounded starts",
    );
    await settle();
    expect(await eventsOfType(world.stub, "agent.started")).toHaveLength(MAX_AGENTS_PER_RUN);
  });

  it("closes a socket that keeps claiming subagents the rows do not support", async () => {
    const { bridge } = await runningWorld("sess_agents_closed");
    const closed = closeCodeOf(bridge);
    for (let index = 0; index < 4; index += 1) {
      bridge.send(completed(bridge, "run_1", `ses_ghost_${index}`));
    }
    await waitFor(() => closed() !== null, "the socket to close");
    expect(closed()).toBe(4001);
  });

  it("keeps the socket of a bridge whose subagents were announced after the run's cancel was committed", async () => {
    const { world, bridge } = await runningWorld("sess_agents_cancel_race");
    const closed = closeCodeOf(bridge);
    await announce(world, bridge, "run_1", "ses_before");
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent admitted before the cancel",
    );
    const client = await openClient(world);
    await client.send(cancelCommand("cmd_cancel", "run_1"));
    expect((await runRowOf(world.stub, "run_1")).state).toBe("cancelled");

    // What the bridge had sent before it heard: two more subagents, their
    // rows, and then the end of every subagent the run took down.
    for (const agentId of ["ses_racing_1", "ses_racing_2"]) {
      bridge.send(started(bridge, "run_1", agentId));
      bridge.send(agentCall(bridge, "run_1", agentId, `call_in_${agentId}`));
    }
    bridge.send(completed(bridge, "run_1", "ses_before", "cancelled"));
    bridge.send(completed(bridge, "run_1", "ses_racing_1", "cancelled"));
    bridge.send(completed(bridge, "run_1", "ses_racing_2", "cancelled"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.completed")).length === 1,
      "the end of the subagent the rows hold",
    );
    await settle();

    expect(closed()).toBeNull();
    expect((await subagentRows(world)).map((row) => [row.agent_id, row.status])).toEqual([
      ["ses_before", "cancelled"],
    ]);
    expect(await eventsOfType(world.stub, "agent.started")).toHaveLength(1);
    expect(await storedCallIds(world)).toEqual([]);
    // Six frames went unstored and uncounted, so the socket still has its
    // whole budget: three claims the rows do not support leave it open.
    for (let index = 0; index < 3; index += 1) {
      bridge.send(completed(bridge, "run_unknown", `ses_ghost_${index}`));
    }
    await settle();
    expect(closed()).toBeNull();
  });

  it("drops the same frames when the cancel released a held message as the next run", async () => {
    const { world, bridge } = await runningWorld("sess_agents_cancel_next");
    const closed = closeCodeOf(bridge);
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_next", "msg_next", "run_1", "running", "run_next"));
    await client.send(cancelCommand("cmd_cancel", "run_1"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.queued")).length === 2,
      "the held message's run",
    );

    for (const agentId of ["ses_racing_1", "ses_racing_2"]) {
      bridge.send(started(bridge, "run_1", agentId));
      bridge.send(completed(bridge, "run_1", agentId, "cancelled"));
    }
    await settle();

    expect(closed()).toBeNull();
    expect(await subagentRows(world)).toEqual([]);
    expect(await eventsOfType(world.stub, "agent.completed")).toEqual([]);
  });

  it("admits the end of a subagent its run took down after the run's own end was committed", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_agents_after_end");
    // run_1 ran in the quiet world; a subagent row still running for it.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO subagent (agent_id, run_id, sandbox_generation, parent_tool_call_id, name, description, status, started_at)
           VALUES ('ses_late', 'run_1', 1, 'call_late', 'general', 'Late', 'running', ?)`,
        WORLD_TIME,
      );
    });
    bridge.send(completed(bridge, "run_1", "ses_late", "cancelled"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.completed")).length === 1,
      "the late end",
    );
    expect((await subagentRows(world))[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("the call that starts a subagent", () => {
  function startAsk(bridge: TestBridge, ref: string, callId: string) {
    return bridge.event("approval.requested", {
      runId: "run_1",
      payload: {
        approvalId: ref,
        title: "Agent permission",
        intendedAction: "The agent asked for a permission.",
        category: "start_subagent",
        risk: "medium",
        resource: "explore subagent: Find where the retry budget is defined",
        requestedScope: "This request",
        expiresAt: "2099-01-01T00:00:00.000Z",
        toolCallId: callId,
      },
    });
  }

  it("is one the object allowed: a start the approval mode answered is admitted", async () => {
    const world = await sessionOnRealDriver("sess_agents_allowed_call", {
      body: { approvalMode: "session" },
    });
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(startAsk(bridge, "ref_start", "call_task"));
    await waitFor(
      () => bridge.frames("bridge.approval").some((frame) => frame.outcome === "allowed"),
      "the allowed start",
    );
    bridge.send(started(bridge, "run_1", "ses_child_1", "call_task"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent",
    );
    expect((await subagentRows(world)).map((row) => row.agent_id)).toEqual(["ses_child_1"]);
  });

  it("is not allowed while its card waits, and is once the user allows it", async () => {
    const { world, bridge } = await runningWorld("sess_agents_card_call");
    bridge.send(startAsk(bridge, "ref_start", "call_task"));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "waiting_for_approval",
      "the card",
    );
    bridge.send(started(bridge, "run_1", "ses_early", "call_task"));
    await settle();
    expect(await subagentRows(world)).toEqual([]);

    const [card] = await eventsOfType(world.stub, "approval.requested");
    const client = await openClient(world);
    await client.send({
      type: "approval.resolve",
      commandId: "cmd_allow_start",
      runId: "run_1",
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "waiting_for_approval" },
      payload: {
        approvalId: (card?.payload as { approvalId: string } | undefined)?.approvalId,
        decision: "approved",
      },
    });
    bridge.send(started(bridge, "run_1", "ses_child_1", "call_task"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent",
    );
    expect((await subagentRows(world)).map((row) => row.agent_id)).toEqual(["ses_child_1"]);
  });

  it("is refused when invented, when it is another call of the run, and when a subagent already took it", async () => {
    const { world, bridge } = await runningWorld("sess_agents_invented_call");
    // The primary agent's own command, which an announcement must not be able to claim.
    bridge.send(
      bridge.event("tool.requested", { runId: "run_1", payload: { toolCallId: "call_shell" } }),
    );
    bridge.send(started(bridge, "run_1", "ses_invented", "call_nowhere"));
    bridge.send(started(bridge, "run_1", "ses_disguise", "call_shell"));
    await announce(world, bridge, "run_1", "ses_child_1");
    bridge.send(started(bridge, "run_1", "ses_second", "call_ses_child_1"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the allowed start",
    );
    await settle();
    expect((await subagentRows(world)).map((row) => row.agent_id)).toEqual(["ses_child_1"]);
  });

  it("is not refused once the run's asks are past the cap the object records", async () => {
    const { world, bridge } = await runningWorld("sess_agents_unrecorded_call");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO run_permission_count (run_id, asked) VALUES ('run_1', ?)",
        MAX_PERMISSION_ASKS_PER_RUN + 1,
      );
    });
    bridge.send(started(bridge, "run_1", "ses_unrecorded", "call_unrecorded"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent",
    );
  });

  it("is not one allowed on an earlier sandbox of the run", async () => {
    const { world, bridge: lost } = await runningWorld("sess_agents_stale_call");
    await allowSubagentStart(world, "run_1", "call_stale", 1);
    await loseSandbox(world, lost);
    const bridge = await continueOnNewSandbox(world);
    bridge.send(started(bridge, "run_1", "ses_stale", "call_stale"));
    await settle();
    expect(await subagentRows(world)).toEqual([]);
  });
});

describe("a subagent's own messages and calls", () => {
  it("are stored for a subagent the object admitted", async () => {
    const { world, bridge } = await runningWorld("sess_agents_tagged");
    await announce(world, bridge, "run_1", "ses_child_1");
    bridge.send(agentCall(bridge, "run_1", "ses_child_1", "call_child"));
    bridge.send(
      bridge.event("message.completed", {
        runId: "run_1",
        payload: {
          messageId: "msg_child",
          role: "assistant",
          parts: [{ type: "text", text: "Found it." }],
          agentId: "ses_child_1",
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the subagent's message",
    );
    expect(await storedCallIds(world)).toEqual(["call_child"]);
  });

  it("are not stored under an agentId no agent.started announced, and close a socket that keeps sending them", async () => {
    const { world, bridge } = await runningWorld("sess_agents_invented");
    const closed = closeCodeOf(bridge);
    bridge.send(agentCall(bridge, "run_1", "ses_invented", "call_invented_0"));
    // The primary agent's own call is untouched by the refusal beside it.
    bridge.send(
      bridge.event("tool.requested", { runId: "run_1", payload: { toolCallId: "call_primary" } }),
    );
    await waitFor(async () => (await storedCallIds(world)).length === 1, "the primary call");
    expect(await storedCallIds(world)).toEqual(["call_primary"]);
    expect(closed()).toBeNull();

    for (let index = 1; index < 4; index += 1) {
      bridge.send(agentCall(bridge, "run_1", "ses_invented", `call_invented_${index}`));
    }
    await waitFor(() => closed() !== null, "the socket to close");
    expect(closed()).toBe(4001);
    expect(await storedCallIds(world)).toEqual(["call_primary"]);
  });

  it("are not stored under a subagent of another run", async () => {
    const { world, bridge } = await runningWorld("sess_agents_other_run");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO subagent (agent_id, run_id, sandbox_generation, parent_tool_call_id, name, description, status, started_at)
           VALUES ('ses_elsewhere', 'run_0', 1, 'call_elsewhere', 'general', 'Earlier', 'completed', ?)`,
        WORLD_TIME,
      );
    });
    bridge.send(agentCall(bridge, "run_1", "ses_elsewhere", "call_borrowed"));
    await settle();
    expect(await storedCallIds(world)).toEqual([]);
  });
});

/** Loses generation 1's sandbox under a running run_1 that holds a checkpoint, so the run is interrupted. */
async function loseSandbox(world: SessionWorld, bridge: TestBridge): Promise<void> {
  bridge.send(
    bridge.event("repository.checkpointed", {
      runId: "run_1",
      payload: { checkpointId: "ckpt_periodic", headSha: "9".repeat(40), reason: "periodic" },
    }),
  );
  await waitFor(
    async () => (await eventsOfType(world.stub, "repository.checkpointed")).length === 1,
    "the checkpoint",
  );
  bridge.close();
  await waitFor(async () => (await probeRow(world.stub, 1)) !== null, "the probe");
  world.setController((operation) =>
    operation === "getStatus"
      ? Response.json(
          { kind: "error", category: "not_found", message: "no such sandbox", retryable: false },
          { status: 404 },
        )
      : undefined,
  );
  await ageProbe(world.stub, 1);
  await fireAlarm(world.stub);
  expect((await runRowOf(world.stub, "run_1")).state).toBe("interrupted");
  world.setController(null);
}

/** Continues the interrupted run_1 on generation 2 and brings it to running there. */
async function continueOnNewSandbox(world: SessionWorld): Promise<TestBridge> {
  const client = await openClient(world);
  await client.send(followUpCommand("cmd_continue", "msg_continue", "run_1", "interrupted"));
  await waitFor(
    async () =>
      (await attachmentStates(world.stub)).some(
        (row) => row.generation === 2 && row.state === "attached",
      ),
    "generation 2 to attach",
  );
  const bridge = await readyBridge(world, 2);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return bridge;
}

describe("subagents of a run whose sandbox was lost", () => {
  it("are ended by the object with the interruption, each once", async () => {
    const { world, bridge } = await runningWorld("sess_agents_interrupted");
    await announce(world, bridge, "run_1", "ses_orphan_1");
    await announce(world, bridge, "run_1", "ses_orphan_2");
    await announce(world, bridge, "run_1", "ses_done");
    bridge.send(completed(bridge, "run_1", "ses_done"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.completed")).length === 1,
      "the subagent that ended on its own",
    );

    await loseSandbox(world, bridge);

    const ends = (await eventsOfType(world.stub, "agent.completed")).slice(1);
    expect(ends).toEqual([
      expect.objectContaining({
        runId: "run_1",
        sandboxGeneration: 1,
        runtimeSequence: null,
        payload: {
          agentId: "ses_orphan_1",
          status: "cancelled",
          usage: { tokens: 0, toolCalls: 0, durationMs: expect.any(Number) },
          resultSummary: null,
        },
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ agentId: "ses_orphan_2", status: "cancelled" }),
      }),
    ]);
    const settledRows = [
      ["ses_done", "completed"],
      ["ses_orphan_1", "cancelled"],
      ["ses_orphan_2", "cancelled"],
    ];
    expect((await subagentRows(world)).map((row) => [row.agent_id, row.status]).sort()).toEqual(
      settledRows,
    );

    // Continued on a new sandbox, the run is running again and shows none of
    // the lost sandbox's subagents running; one the new sandbox starts is.
    const continued = await continueOnNewSandbox(world);
    await announce(world, continued, "run_1", "ses_new");
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 4,
      "the new sandbox's subagent",
    );
    const log = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ envelope_json: string }>(
          "SELECT envelope_json FROM event ORDER BY session_sequence",
        )
        .toArray()
        .map((row) => JSON.parse(row.envelope_json) as CommittedEvent),
    );
    const view = foldEvents(log);
    expect(view.run?.state).toBe("running");
    expect(
      [...view.agents.values()].map((agent) => [agent.agentId, agentStatusOf(view, agent)]).sort(),
    ).toEqual([...settledRows, ["ses_new", "running"]].sort());
  });

  it("do not count toward the continued run's bound, and cannot be stopped, ended, or written to from the new sandbox", async () => {
    const { world, bridge: lost } = await runningWorld("sess_agents_continued");
    await loseSandbox(world, lost);
    // What a sandbox that stopped without reporting leaves: a full run's worth
    // of rows still marked running, on the generation that is gone.
    await runInDurableObject(world.stub, (_instance, state) => {
      for (let index = 0; index < MAX_AGENTS_PER_RUN; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO subagent (agent_id, run_id, sandbox_generation, parent_tool_call_id, name, description, status, started_at)
             VALUES (?, 'run_1', 1, ?, 'general', 'Left behind', 'running', ?)`,
          `ses_left_${index}`,
          `call_left_${index}`,
          WORLD_TIME,
        );
      }
    });
    const bridge = await continueOnNewSandbox(world);

    // The new bridge counts from zero, and so does the object for its sandbox.
    for (let index = 0; index <= MAX_AGENTS_PER_RUN; index += 1) {
      await announce(world, bridge, "run_1", `ses_new_${index}`);
    }
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === MAX_AGENTS_PER_RUN,
      "the new sandbox's subagents",
    );
    await settle();
    expect(await eventsOfType(world.stub, "agent.started")).toHaveLength(MAX_AGENTS_PER_RUN);

    const client = await openClient(world);
    await client.send(stopCommand("cmd_stop_left", "run_1", "ses_left_0"));
    await settle();
    expect(
      (await eventsOfType(world.stub, "command.rejected")).map(
        (event) => (event as { payload: { commandId: string; reason: string } }).payload,
      ),
    ).toEqual([expect.objectContaining({ commandId: "cmd_stop_left", reason: "wrong_state" })]);
    expect(bridge.commands("agent.stop")).toEqual([]);

    bridge.send(completed(bridge, "run_1", "ses_left_0"));
    bridge.send(agentCall(bridge, "run_1", "ses_left_0", "call_into_left"));
    await settle();
    expect(await eventsOfType(world.stub, "agent.completed")).toEqual([]);
    expect(await storedCallIds(world)).toEqual([]);
    expect(
      (await subagentRows(world)).filter((row) => row.agent_id === "ses_left_0")[0],
    ).toMatchObject({ status: "running" });
  });
});

describe("agent.stop", () => {
  it("is acknowledged and delivered to the bridge for a running subagent of the run", async () => {
    const { world, bridge } = await runningWorld("sess_agents_stop");
    await announce(world, bridge, "run_1", "ses_child_1");
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent",
    );
    const client = await openClient(world);
    await client.send(stopCommand("cmd_stop", "run_1", "ses_child_1"));
    await waitFor(() => bridge.commands("agent.stop").length === 1, "the stop to reach the bridge");
    const [frame] = bridge.commands("agent.stop");
    expect(frame).toMatchObject({
      runId: "run_1",
      command: { type: "agent.stop", payload: { agentId: "ses_child_1" } },
    });
    bridge.ack({ commandId: "cmd_stop" });
    await waitFor(
      async () =>
        (await eventsOfType(world.stub, "command.acknowledged")).some(
          (event) =>
            (event as { payload: { commandId: string; acceptedBy: string } }).payload.commandId ===
              "cmd_stop" &&
            (event as { payload: { acceptedBy: string } }).payload.acceptedBy === "bridge",
        ),
      "the bridge's acknowledgement",
    );
  });

  it("is refused for a subagent that is not running in the run, and never reaches the bridge", async () => {
    const { world, bridge } = await runningWorld("sess_agents_stop_refused");
    await announce(world, bridge, "run_1", "ses_child_1");
    bridge.send(completed(bridge, "run_1", "ses_child_1"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.completed")).length === 1,
      "the subagent's end",
    );
    const client = await openClient(world);
    await client.send(stopCommand("cmd_stop_done", "run_1", "ses_child_1"));
    await client.send(stopCommand("cmd_stop_nobody", "run_1", "ses_nobody"));
    await settle();
    const rejected = (await eventsOfType(world.stub, "command.rejected")).map(
      (event) => (event as { payload: { commandId: string; reason: string } }).payload,
    );
    expect(rejected).toEqual([
      expect.objectContaining({ commandId: "cmd_stop_done", reason: "wrong_state" }),
      expect.objectContaining({ commandId: "cmd_stop_nobody", reason: "wrong_state" }),
    ]);
    expect(bridge.commands("agent.stop")).toEqual([]);
  });
});
