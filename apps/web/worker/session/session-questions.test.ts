// Questions at the object's boundary (records 04 and 12): the sandbox is
// trusted only for the fact that its harness waits on the user; the object
// mints the id, holds one question at a time, tells the bridge what the user
// decided, ends a question with its run, and resumes a run the idle stop
// paused once the user answers.

import { runInDurableObject } from "cloudflare:test";
import { LIMITS } from "@oncue/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ageEvents,
  eventsOfType,
  eventTypes,
  fireAlarm,
  followUpCommand,
  MODAL_CREDENTIAL,
  OWNER_USER_ID,
  openClient,
  REPOSITORY,
  readyBridge,
  registerSessionWorlds,
  reportCheckpoint,
  runRowOf,
  type SessionWorld,
  seedModelConnection,
  sessionGeneration,
  sessionOnRealDriver,
  setAttachmentExpiry,
  settle,
  type TestBridge,
  WORLD_TIME,
  waitFor,
  waitingForUserInD1,
} from "../test/session-world";
import { QUESTION_IDLE_DETAIL } from "./lifecycle";
import { resumeRunWith } from "./object/resume";
import { MAX_QUESTIONS_PER_RUN } from "./questions";
import { MAX_QUESTION_REFUSALS } from "./session-object";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const MIN = 60_000;

const QUESTIONS = [
  {
    id: "q1",
    header: "Database",
    text: "Which database should the service use?",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "SQLite", description: "One file" },
    ],
    multiple: false,
    allowOther: true,
  },
  {
    id: "q2",
    header: "Targets",
    text: "Which targets?",
    options: [
      { label: "Web", description: "" },
      { label: "iOS", description: "" },
    ],
    multiple: true,
    allowOther: false,
  },
];

async function runningWorld(
  sessionId: string,
  repository = false,
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(
    sessionId,
    repository ? { repository: REPOSITORY } : undefined,
  );
  const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
  if (repository) {
    bridge.ack({ grantId: String((bridge.grants("git")[0] as Record<string, unknown>).grantId) });
    bridge.ack({ grantId: String((bridge.grants("model")[0] as Record<string, unknown>).grantId) });
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
  }
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

function ask(bridge: TestBridge, ref: string, overrides: Record<string, unknown> = {}) {
  return bridge.event("question.asked", {
    runId: "run_1",
    payload: { questionId: ref, toolCallId: "call_q", questions: QUESTIONS, ...overrides },
  });
}

async function asked(world: SessionWorld, count = 1): Promise<string> {
  await waitFor(
    async () => (await eventsOfType(world.stub, "question.asked")).length === count,
    `${count} stored question(s)`,
  );
  await settle();
  const stored = (await eventsOfType(world.stub, "question.asked")).at(-1);
  return (stored?.payload as { questionId: string } | undefined)?.questionId as string;
}

async function questionRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) =>
    state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT id, run_id, state, sandbox_ref, requested_generation, answers_json FROM question ORDER BY rowid",
      )
      .toArray(),
  );
}

function answer(commandId: string, questionId: string, answers: string[][], state = "running") {
  return {
    type: "question.resolve",
    commandId,
    runId: "run_1",
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state },
    payload: { action: "answer", questionId, answers },
  };
}

function dismiss(commandId: string, questionId: string) {
  return {
    type: "question.resolve",
    commandId,
    runId: "run_1",
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "running" },
    payload: { action: "dismiss", questionId },
  };
}

async function rejection(world: SessionWorld, commandId: string) {
  const rejected = await eventsOfType(world.stub, "command.rejected");
  return rejected.find((event) => (event.payload as { commandId: string }).commandId === commandId)
    ?.payload;
}

describe("a question.asked frame", () => {
  it("is stored under the object's id, keeps the bridge's reference, and waits on the user", async () => {
    const { world, bridge } = await runningWorld("sess_q_admit");
    expect(await waitingForUserInD1(world.sessionId)).toBe(false);
    bridge.send(ask(bridge, "sandbox_ref_1"));
    const questionId = await asked(world);

    expect(questionId).not.toBe("sandbox_ref_1");
    const [stored] = await eventsOfType(world.stub, "question.asked");
    expect(stored?.payload).toMatchObject({ toolCallId: "call_q", questions: QUESTIONS });
    expect(await questionRows(world)).toEqual([
      {
        id: questionId,
        run_id: "run_1",
        state: "open",
        sandbox_ref: "sandbox_ref_1",
        requested_generation: 1,
        answers_json: null,
      },
    ]);
    // The run keeps working; only the sidebar's "needs you" changes.
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
    await waitFor(() => waitingForUserInD1(world.sessionId), "the projection to say waiting");
    expect(bridge.frames("bridge.question")).toEqual([]);
  });

  it("is refused, and the bridge told, for a run that is not the session's", async () => {
    const { world, bridge } = await runningWorld("sess_q_wrong_run");
    const frame = ask(bridge, "ref_other");
    (frame as { runId: string }).runId = "run_other";
    bridge.send(frame);
    await waitFor(() => bridge.frames("bridge.question").length === 1, "the refusal");
    expect(bridge.frames("bridge.question")[0]).toEqual({
      type: "bridge.question",
      sessionId: world.sessionId,
      sandboxGeneration: 1,
      requestRef: "ref_other",
      outcome: "refused",
      answers: null,
    });
    expect(await eventsOfType(world.stub, "question.asked")).toEqual([]);
    expect(await questionRows(world)).toEqual([]);
  });

  it("refuses a second question while one waits without counting it", async () => {
    const { world, bridge } = await runningWorld("sess_q_second");
    bridge.send(ask(bridge, "ref_1"));
    await asked(world);
    for (let index = 0; index <= MAX_QUESTION_REFUSALS; index += 1) {
      bridge.send(ask(bridge, `ref_extra_${index}`));
    }
    await waitFor(
      () => bridge.frames("bridge.question").length === MAX_QUESTION_REFUSALS + 1,
      "the refusals",
    );
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
    expect((await questionRows(world)).map((row) => row.sandbox_ref)).toEqual(["ref_1"]);
  });

  it("refuses past the run's bound, and closes a socket that keeps asking", async () => {
    const { world, bridge } = await runningWorld("sess_q_bound");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO run_question_count (run_id, admitted) VALUES ('run_1', ?)",
        MAX_QUESTIONS_PER_RUN,
      );
    });
    for (let index = 0; index <= MAX_QUESTION_REFUSALS; index += 1) {
      bridge.send(ask(bridge, `ref_${index}`));
    }
    await waitFor(
      () => bridge.client.readyState !== WebSocket.OPEN,
      "the socket closed after the bound",
    );
    expect(await eventsOfType(world.stub, "question.asked")).toEqual([]);
  });
});

describe("question.resolve", () => {
  it("records the user's answers and tells the waiting harness", async () => {
    const { world, bridge } = await runningWorld("sess_q_answer");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    const client = await openClient(world);
    await client.send(answer("cmd_answer", questionId, [["Postgres"], ["Web", "Android"]]));

    const [answered] = await eventsOfType(world.stub, "question.answered");
    expect(answered).toMatchObject({
      runId: "run_1",
      payload: {
        questionId,
        answers: [["Postgres"], ["Web", "Android"]],
        decidedBy: "user_1",
        commandId: "cmd_answer",
      },
    });
    await waitFor(() => bridge.frames("bridge.question").length === 1, "the answer frame");
    expect(bridge.frames("bridge.question")[0]).toMatchObject({
      requestRef: "ref_1",
      outcome: "answered",
      answers: [["Postgres"], ["Web", "Android"]],
    });
    expect((await questionRows(world))[0]).toMatchObject({
      state: "answered",
      answers_json: JSON.stringify([["Postgres"], ["Web", "Android"]]),
    });
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to stop waiting",
    );
  });

  it("dismisses on the card's ×, and the harness hears it", async () => {
    const { world, bridge } = await runningWorld("sess_q_dismiss");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    const client = await openClient(world);
    await client.send(dismiss("cmd_dismiss", questionId));
    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toEqual({
      questionId,
      reason: "user",
      decidedBy: "user_1",
      commandId: "cmd_dismiss",
    });
    await waitFor(() => bridge.frames("bridge.question").length === 1, "the dismissal frame");
    expect(bridge.frames("bridge.question")[0]).toMatchObject({
      outcome: "dismissed",
      answers: null,
    });
  });

  it.each([
    ["an id that is not the open question's", "qst_unknown", [["Postgres"]]],
    ["more answers than questions", null, [["a"], ["b"], ["c"]]],
  ])("is refused for %s", async (_label, id, answers) => {
    const { world, bridge } = await runningWorld(`sess_q_refuse_${_label.length}`);
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    const client = await openClient(world);
    await client.send(answer("cmd_bad", id ?? questionId, answers));
    expect(await rejection(world, "cmd_bad")).toMatchObject({ reason: "wrong_state" });
    expect(await eventsOfType(world.stub, "question.answered")).toEqual([]);
    expect(bridge.frames("bridge.question")).toEqual([]);
  });

  it("is refused with no question open at all", async () => {
    const { world } = await runningWorld("sess_q_none");
    const client = await openClient(world);
    await client.send(dismiss("cmd_none", "qst_1"));
    expect(await rejection(world, "cmd_none")).toMatchObject({
      reason: "wrong_state",
      detail: "no open question matches this id",
    });
  });

  it("tells a bridge that reconnected what became of its question", async () => {
    const { world, bridge } = await runningWorld("sess_q_reconnect");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    bridge.close();
    await waitFor(
      async () =>
        runInDurableObject(world.stub, (_instance, state) =>
          state.getWebSockets("bridge").every((ws) => ws.readyState !== WebSocket.OPEN),
        ),
      "the bridge to leave",
    );
    const client = await openClient(world);
    await client.send(answer("cmd_offline", questionId, [["SQLite"]]));
    const again = await readyBridge(world, 1).catch(() => null);
    const reconnected =
      again ??
      (() => {
        throw new Error("no reconnect");
      })();
    await waitFor(() => reconnected.frames("bridge.question").length >= 1, "the resent answer");
    expect(reconnected.frames("bridge.question")[0]).toMatchObject({
      requestRef: "ref_1",
      outcome: "answered",
      answers: [["SQLite"]],
    });
  });
});

describe("a message while a question waits", () => {
  it("dismisses the question as answered in the user's words, then delivers the message", async () => {
    const { world, bridge } = await runningWorld("sess_q_message");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_msg", "msg_1", "run_1", "running"));

    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toMatchObject({
      questionId,
      reason: "message_sent",
      commandId: "cmd_msg",
    });
    const types = await eventTypes(world.stub);
    expect(types.indexOf("question.dismissed")).toBeLessThan(types.indexOf("message.queued"));
    await waitFor(() => bridge.commands("run.follow_up").length === 1, "the steer");
    const dismissedAt = bridge.received.findIndex((frame) => frame.type === "bridge.question");
    const steerAt = bridge.received.indexOf(bridge.commands("run.follow_up")[0] as never);
    expect(dismissedAt).toBeGreaterThanOrEqual(0);
    expect(dismissedAt).toBeLessThan(steerAt);
  });
});

describe("a question does not outlive its run", () => {
  it("is dismissed when the run ends", async () => {
    const { world, bridge } = await runningWorld("sess_q_run_end");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    bridge.send(bridge.event("run.completed", { runId: "run_1" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "question.dismissed")).length === 1,
      "the dismissal",
    );
    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toEqual({
      questionId,
      reason: "run_ended",
      decidedBy: null,
      commandId: null,
    });
  });

  it("is dismissed when the bridge pauses the run, whose turn it aborted", async () => {
    const { world, bridge } = await runningWorld("sess_q_bridge_pause");
    bridge.send(ask(bridge, "ref_1"));
    await asked(world);
    bridge.send(
      bridge.event("run.paused", {
        runId: "run_1",
        payload: {
          reason: "model_failure",
          modelFailure: { category: "authentication_failed", message: "no", retries: 0 },
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "question.dismissed")).length === 1,
      "the dismissal",
    );
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
  });

  it("is dismissed when the runtime is lost and the run fails", async () => {
    const { world, bridge } = await runningWorld("sess_q_runtime_lost");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    bridge.send(
      bridge.event("runtime.disconnected", {
        payload: { reason: "runtime_crashed", expectReconnect: false },
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "failed",
      "the failed run",
    );
    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toEqual({
      questionId,
      reason: "run_ended",
      decidedBy: null,
      commandId: null,
    });
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to stop waiting",
    );
  });

  it("is dismissed when the user pauses the run, and the harness hears it", async () => {
    const { world, bridge } = await runningWorld("sess_q_user_pause");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    const client = await openClient(world);
    await client.send({
      type: "run.pause",
      commandId: "cmd_pause",
      runId: "run_1",
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "running" },
      payload: { reason: "user_requested" },
    });
    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toEqual({
      questionId,
      reason: "run_paused",
      decidedBy: "user_1",
      commandId: "cmd_pause",
    });
    const types = await eventTypes(world.stub);
    expect(types.indexOf("question.dismissed")).toBeLessThan(types.indexOf("run.paused"));
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
    await waitFor(() => bridge.frames("bridge.question").length === 1, "the dismissal frame");
    expect(bridge.frames("bridge.question")[0]).toMatchObject({
      requestRef: "ref_1",
      outcome: "dismissed",
    });
    // Nothing is left for a late answer to wait on.
    await client.send(answer("cmd_after_pause", questionId, [["SQLite"]], "paused"));
    expect(await rejection(world, "cmd_after_pause")).toMatchObject({
      detail: "no open question matches this id",
    });
  });

  it("is dismissed when the user cancels the run", async () => {
    const { world, bridge } = await runningWorld("sess_q_cancel");
    bridge.send(ask(bridge, "ref_1"));
    await asked(world);
    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel",
      runId: "run_1",
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "running" },
      payload: { reason: null, checkpointFirst: false },
    });
    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toMatchObject({
      reason: "run_ended",
    });
  });
});

describe("the idle stop while a question waits", () => {
  async function stoppedWhileAsking(sessionId: string) {
    const { world, bridge } = await runningWorld(sessionId, true);
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    // A run waiting on its question is idle: the normal timer stops the sandbox.
    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the idle checkpoint");
    expect((await runRowOf(world.stub, "run_1")).state).toBe("paused");
    expect((await eventsOfType(world.stub, "run.paused"))[0]?.payload).toMatchObject({
      reason: "idle_stop",
      detail: QUESTION_IDLE_DETAIL,
    });
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle" });
    // The real bridge says its runtime is gone as the stop shuts it down; the
    // paused run has no turn to lose, so it stays paused.
    bridge.send(
      bridge.event("runtime.disconnected", {
        payload: { reason: "shutdown_requested", expectReconnect: false },
      }),
    );
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    expect((await questionRows(world))[0]).toMatchObject({ state: "open" });
    return { world, questionId };
  }

  it("is dismissed with its run when the session is archived, and no later answer resumes anything", async () => {
    const { world, questionId } = await stoppedWhileAsking("sess_q_idle_archive");
    const archive = (cancelOpenRun: boolean) =>
      runInDurableObject(world.stub, (instance) =>
        instance.archiveSession({
          requestedByUserId: OWNER_USER_ID,
          modalCredential: MODAL_CREDENTIAL,
          cancelOpenRun,
        }),
      );
    // A run paused on its question is still open, so archiving asks first.
    expect(await archive(false)).toEqual({ kind: "run_open" });

    expect(await archive(true)).toEqual({ kind: "archived", sandbox: "not_running" });

    expect((await runRowOf(world.stub, "run_1")).state).toBe("cancelled");
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
    const generation = await sessionGeneration(world.stub);
    const client = await openClient(world);
    await client.send(answer("cmd_archived", questionId, [["SQLite"], []], "cancelled"));
    await settle();
    expect(await sessionGeneration(world.stub)).toBe(generation);
  });

  it("refuses an answer while the session is archived, even with the question still open", async () => {
    const { world, questionId } = await stoppedWhileAsking("sess_q_idle_archived_answer");
    // Archived by hand with the run and its question left open, which only a
    // crash between archiving's writes could leave behind.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'archived'");
    });
    const generation = await sessionGeneration(world.stub);
    const client = await openClient(world);

    await client.send(answer("cmd_read_only", questionId, [["SQLite"], []], "paused"));

    expect(await rejection(world, "cmd_read_only")).toMatchObject({
      reason: "wrong_state",
      actualState: "archived",
    });
    expect((await questionRows(world))[0]).toMatchObject({ state: "open" });
    expect(await sessionGeneration(world.stub)).toBe(generation);
  });

  it("keeps the question open, and an answer resumes the run with the answers as its message", async () => {
    const { world, questionId } = await stoppedWhileAsking("sess_q_idle_answer");
    const client = await openClient(world);
    await client.send(answer("cmd_late", questionId, [["SQLite"], []], "paused"));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "provisioning",
      "the resume",
    );
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as {
      runId: string;
      context: string;
      command: { commandId: string; payload: { instruction: { text: string } } };
    };
    expect(start.runId).toBe("run_1");
    expect(start.command.commandId).toBe("cmd_late");
    expect(start.command.payload.instruction.text).toBe(
      [
        "Answers to your questions:",
        "",
        "You asked, quoted:",
        "> Which database should the service use?",
        "They answered, quoted:",
        "> SQLite",
        "",
        "You asked, quoted:",
        "> Which targets?",
        "They skipped this question.",
      ].join("\n"),
    );
    expect(start.context).toContain("You asked the user, quoted:");
    expect(start.context).toContain("> Which database should the service use?");
    expect(start.context).toContain("> SQLite");
    expect(start.context).toContain("They skipped this question.");
  });

  it("refuses an answer that would resume the run on a model connection that is not active", async () => {
    const { world, questionId } = await stoppedWhileAsking("sess_q_idle_broken_key");
    const client = await openClient(world);
    try {
      await seedModelConnection(world.workspaceId, "invalid");
      await client.send(answer("cmd_late_invalid", questionId, [["SQLite"], []], "paused"));
      expect(await rejection(world, "cmd_late_invalid")).toMatchObject({
        reason: "wrong_state",
        detail:
          "this run's model connection is not active; add a working key under Settings, Model providers and start a new session",
      });
      expect(await eventsOfType(world.stub, "question.answered")).toEqual([]);
      expect((await questionRows(world))[0]).toMatchObject({ state: "open" });
      expect((await runRowOf(world.stub, "run_1")).state).toBe("paused");
      expect(await sessionGeneration(world.stub)).toBe(1);
    } finally {
      await seedModelConnection(world.workspaceId);
    }
    // With a working key again, the same answer resumes the run.
    await client.send(answer("cmd_late_active", questionId, [["SQLite"], []], "paused"));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "provisioning",
      "the resume",
    );
  });

  it("resumes nothing with a message the run.start schema would refuse", async () => {
    const { world } = await stoppedWhileAsking("sess_q_idle_too_long");
    const resumed = await runInDurableObject(world.stub, (instance) =>
      resumeRunWith(instance as unknown as Parameters<typeof resumeRunWith>[0], "run_1", {
        commandId: "cmd_long",
        issuedAt: WORLD_TIME,
        issuedByUserId: "user_1",
        text: "x".repeat(LIMITS.bodyTextChars + 1),
      }),
    );
    expect(resumed).toBe(false);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("paused");
    expect(await sessionGeneration(world.stub)).toBe(1);
  });

  it("a dismissal after the stop resumes nothing", async () => {
    const { world, questionId } = await stoppedWhileAsking("sess_q_idle_dismiss");
    const client = await openClient(world);
    await client.send(dismiss("cmd_x", questionId));
    await settle();
    expect((await runRowOf(world.stub, "run_1")).state).toBe("paused");
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
  });

  it("a message after the stop dismisses the question and continues the run as usual", async () => {
    const { world } = await stoppedWhileAsking("sess_q_idle_message");
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_cont", "msg_cont", "run_1", "paused"));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "provisioning",
      "the resume",
    );
    expect((await questionRows(world))[0]).toMatchObject({ state: "dismissed" });
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as {
      context: string;
      command: { payload: { instruction: { text: string } } };
    };
    expect(start.command.payload.instruction.text).toBe("Message msg_cont");
    expect(start.context).toContain("They sent a message instead of answering.");
  });
});

describe("the planned replacement while a question waits", () => {
  it("dismisses the question, tells the restarted run why, and lets it ask again", async () => {
    const { world, bridge } = await runningWorld("sess_q_ceiling", true);
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    await waitFor(() => waitingForUserInD1(world.sessionId), "the projection to say waiting");
    await setAttachmentExpiry(world.stub, 1, Date.now() + 29 * MIN);
    await fireAlarm(world.stub);
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the ceiling checkpoint");
    reportCheckpoint(bridge, { checkpointId: "ckpt_ceiling", reason: "lifetime_ceiling" });
    await waitFor(async () => (await sessionGeneration(world.stub)) === 2, "generation 2");

    expect((await eventsOfType(world.stub, "question.dismissed"))[0]?.payload).toEqual({
      questionId,
      reason: "sandbox_replaced",
      decidedBy: null,
      commandId: null,
    });
    const types = await eventTypes(world.stub);
    expect(types.indexOf("run.interrupted")).toBeLessThan(types.indexOf("question.dismissed"));
    expect(types.indexOf("question.dismissed")).toBeLessThan(types.indexOf("sandbox.replaced"));
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to stop waiting",
    );

    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as { runId: string; context: string };
    expect(start.runId).toBe("run_1");
    expect(start.context).toContain("> Which database should the service use?");
    expect(start.context).toContain(
      "The sandbox was replaced before they answered; ask again if you still need the answer.",
    );
    // The restarted run works without a question holding it idle, and may ask again.
    next.send(next.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    const view = await runInDurableObject(world.stub, (instance) =>
      instance.lifecycleView(instance.readSession() as never, Date.now()),
    );
    expect(view.questionOpen).toBe(false);
    next.send(ask(next, "ref_2"));
    const second = await asked(world, 2);
    expect((await questionRows(world)).at(-1)).toMatchObject({
      id: second,
      state: "open",
      sandbox_ref: "ref_2",
      requested_generation: 2,
    });
    expect(next.frames("bridge.question")).toEqual([]);
  });

  it("counts only the current run's question in the current generation as waiting", async () => {
    const { world, bridge } = await runningWorld("sess_q_scope");
    bridge.send(ask(bridge, "ref_1"));
    await asked(world);
    const questionOpen = () =>
      runInDurableObject(
        world.stub,
        (instance) =>
          instance.lifecycleView(instance.readSession() as never, Date.now()).questionOpen,
      );
    expect(await questionOpen()).toBe(true);
    const alter = (sql: string) =>
      runInDurableObject(world.stub, (_instance, state) => {
        state.storage.sql.exec(sql);
      });
    await alter("UPDATE question SET requested_generation = 0");
    expect(await questionOpen()).toBe(false);
    await alter("UPDATE question SET requested_generation = 1, run_id = 'run_other'");
    expect(await questionOpen()).toBe(false);
  });
});

describe("the edges of delivering a decision", () => {
  it("tells a reconnecting bridge nothing about a question still open", async () => {
    const { world, bridge } = await runningWorld("sess_q_reconnect_open");
    bridge.send(ask(bridge, "ref_1"));
    await asked(world);
    bridge.close();
    const again = await readyBridge(world, 1);
    await settle();
    expect(again.frames("bridge.question")).toEqual([]);
  });

  it("does nothing for a question that is unknown or still open", async () => {
    const { world, bridge } = await runningWorld("sess_q_deliver_open");
    bridge.send(ask(bridge, "ref_1"));
    const questionId = await asked(world);
    await runInDurableObject(world.stub, async (instance) => {
      await instance.deliverQuestionDecision("qst_unknown", "cmd_x", WORLD_TIME);
      await instance.deliverQuestionDecision(questionId, "cmd_y", WORLD_TIME);
    });
    await settle();
    expect(bridge.frames("bridge.question")).toEqual([]);
  });

  it("resumes nothing for a run that is not stopped, after any resume under way", async () => {
    const { world } = await runningWorld("sess_q_resume_edges");
    const resumed = await runInDurableObject(world.stub, async (instance, state) => {
      const host = instance as unknown as Parameters<typeof resumeRunWith>[0];
      host.resuming = Promise.resolve();
      const message = {
        commandId: "cmd_r",
        issuedAt: WORLD_TIME,
        issuedByUserId: "user_1",
        text: "Answers to your questions:",
      };
      const first = await resumeRunWith(host, "run_1", message);
      host.resuming = null;
      // Stopped, but its sandbox still live: a resume would start a second runtime.
      state.storage.sql.exec("UPDATE run SET state = 'paused' WHERE id = 'run_1'");
      const second = await resumeRunWith(host, "run_1", message);
      state.storage.sql.exec("UPDATE run SET state = 'running' WHERE id = 'run_1'");
      return first || second;
    });
    expect(resumed).toBe(false);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
  });
});
