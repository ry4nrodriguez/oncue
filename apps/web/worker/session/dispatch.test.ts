import type { AckFrame } from "@oncue/bridge";
import type { CommandId, EventType, ModelRecord } from "@oncue/protocol";
import { makeCommand, TEST_IDS, TEST_TIME, testModelRecord } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  chargedRunId,
  DISPATCH_COLUMN_KIND,
  type DispatchRow,
  type DispatchStateView,
  type HeldMessage,
  isRunTerminalEvent,
  MAX_DISPATCH_ATTEMPTS,
  planDispatch,
  planRunRow,
  planRuntimeLoss,
  RUN_EVENT_ROW,
  type RunEventType,
  type SessionRepository,
} from "./dispatch";

const REPOSITORY: SessionRepository = {
  kind: "git_grant",
  installationId: 4001,
  repositoryId: 501,
  fullName: "acme/widgets",
  cloneUrl: "https://github.com/acme/widgets.git",
  branch: "oncue/fix-it-1a2b",
  baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  gitGrantRevoked: false,
};

function view(overrides: Partial<DispatchStateView> = {}): DispatchStateView {
  return {
    sessionId: TEST_IDS.sessionId,
    workspaceId: "ws_1",
    generation: 1,
    runtimeReady: true,
    bridgeAttached: true,
    rows: [],
    held: [],
    currentRunId: TEST_IDS.runId,
    currentRunOpen: true,
    repository: null,
    model: testModelRecord(),
    ...overrides,
  };
}

function commandRow(
  overrides: Partial<Omit<DispatchRow, "kind">> & { readonly commandId?: string } = {},
): DispatchRow {
  const command = makeCommand("run.start", {
    commandId: (overrides.commandId ?? "cmd_start") as CommandId,
  });
  return {
    intentId: command.commandId,
    generation: 1,
    kind: { kind: "command", commandJson: JSON.stringify(command), runId: "run_1" },
    state: "pending",
    attempts: 0,
    createdAt: TEST_TIME,
    ...overrides,
  };
}

function grantRow(
  kind: "model_grant" | "git_grant",
  overrides: Partial<Omit<DispatchRow, "kind">> = {},
): DispatchRow {
  const { gitGrantRevoked: _revoked, ...need } = REPOSITORY;
  return {
    intentId: kind === "model_grant" ? "grant_model" : "grant_git",
    generation: 1,
    kind:
      kind === "model_grant"
        ? {
            kind: "model_grant",
            connectionId: "conn_1",
            modelId: "claude-sonnet-4-5",
            providerId: "anthropic",
            workspace: "none",
            effort: null,
          }
        : need,
    state: "sent",
    attempts: 1,
    createdAt: TEST_TIME,
    ...overrides,
  };
}

function held(messageId = "msg_held_1"): HeldMessage {
  return {
    messageId,
    commandId: `cmd_${messageId}`,
    issuedByUserId: TEST_IDS.userId,
    text: "And also update the docs.",
    attachments: [],
    heldAt: TEST_TIME,
    skipRequiredChecks: false,
  };
}

function ack(ref: AckFrame["ref"], outcome: AckFrame["outcome"]): AckFrame {
  return {
    type: "bridge.ack",
    sessionId: TEST_IDS.sessionId,
    sandboxGeneration: 1,
    ref,
    outcome,
  };
}

const CONNECTED = {
  kind: "bridge_connected",
  now: TEST_TIME,
  mintedGrantIds: ["grant_git", "grant_model"],
  newEventId: () => "evt_rejected",
} as const;

describe("planDispatch: bridge_connected", () => {
  it("plans a git grant then a model grant for a session with a repository, and sends both before any command", () => {
    const plan = planDispatch(
      view({ repository: REPOSITORY, runtimeReady: false, rows: [commandRow()] }),
      CONNECTED,
    );
    expect(plan.frames.map((frame) => frame.kind)).toEqual(["git_grant", "model_grant"]);
    expect(plan.frames[1]).toMatchObject({ need: { workspace: "repository" } });
    expect(plan.rows).toEqual([
      { kind: "insert_dispatch", row: expect.objectContaining({ intentId: "grant_git" }) },
      { kind: "insert_dispatch", row: expect.objectContaining({ intentId: "grant_model" }) },
      { kind: "mark_dispatch", intentId: "grant_git", state: "sent", bumpAttempts: true },
      { kind: "mark_dispatch", intentId: "grant_model", state: "sent", bumpAttempts: true },
    ]);
    expect(plan.events).toEqual([]);
  });

  it("plans only a model grant with workspace 'none' when the session has no repository", () => {
    const plan = planDispatch(view({ runtimeReady: false }), CONNECTED);
    expect(plan.frames).toEqual([
      {
        kind: "model_grant",
        intentId: "grant_model",
        need: expect.objectContaining({ workspace: "none", effort: null }),
      },
    ]);
  });

  it("mints the model grant for the current run's effort", () => {
    const plan = planDispatch(
      view({ runtimeReady: false, model: { ...testModelRecord(), effort: "medium" } }),
      CONNECTED,
    );
    expect(plan.frames[0]).toMatchObject({ need: { effort: "medium" } });
  });

  it("plans no git grant once the grant was revoked, and no model grant when the session has no run yet", () => {
    const plan = planDispatch(
      view({
        repository: { ...REPOSITORY, gitGrantRevoked: true },
        model: null,
        currentRunId: null,
      }),
      CONNECTED,
    );
    expect(plan).toEqual({
      rows: [],
      frames: [],
      events: [],
      continuation: null,
      revokeGitToken: false,
      checkpointRefused: false,
      secretsSettled: null,
    });
  });

  it("does not plan a grant a second time for the same generation, and re-sends only the open one", () => {
    const plan = planDispatch(
      view({
        repository: REPOSITORY,
        rows: [grantRow("git_grant", { state: "accepted" }), grantRow("model_grant")],
      }),
      CONNECTED,
    );
    expect(plan.frames.map((frame) => frame.intentId)).toEqual(["grant_model"]);
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "grant_model", state: "sent", bumpAttempts: true },
    ]);
  });

  it("re-sends open command rows only once the runtime is ready", () => {
    const notReady = planDispatch(
      view({ runtimeReady: false, rows: [grantRow("model_grant"), commandRow({ state: "sent" })] }),
      CONNECTED,
    );
    expect(notReady.frames.map((frame) => frame.kind)).toEqual(["model_grant"]);

    const ready = planDispatch(
      view({ rows: [grantRow("model_grant"), commandRow({ state: "sent", attempts: 2 })] }),
      CONNECTED,
    );
    expect(ready.frames.map((frame) => frame.kind)).toEqual(["model_grant", "command"]);
    expect(ready.rows).toContainEqual({
      kind: "mark_dispatch",
      intentId: "cmd_start",
      state: "sent",
      bumpAttempts: true,
    });
  });

  it("gives up on a command past MAX_DISPATCH_ATTEMPTS with command.rejected { unsupported }, and on a grant silently", () => {
    const plan = planDispatch(
      view({
        rows: [
          grantRow("model_grant", { attempts: MAX_DISPATCH_ATTEMPTS }),
          commandRow({ state: "sent", attempts: MAX_DISPATCH_ATTEMPTS }),
        ],
      }),
      CONNECTED,
    );
    expect(plan.frames).toEqual([]);
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "grant_model", state: "rejected", bumpAttempts: false },
      { kind: "mark_dispatch", intentId: "cmd_start", state: "rejected", bumpAttempts: false },
    ]);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      type: "command.rejected",
      eventId: "evt_rejected",
      payload: {
        commandId: "cmd_start",
        commandType: "run.start",
        reason: "unsupported",
        detail: "bridge never acknowledged",
      },
    });
  });
});

describe("planDispatch: command_admitted", () => {
  it("does nothing for a command the bridge never sees", () => {
    const plan = planDispatch(view(), {
      kind: "command_admitted",
      command: makeCommand("context.add"),
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(plan.rows).toEqual([]);
    expect(plan.frames).toEqual([]);
  });

  it("holds a run_next follow-up as a message, with no row and no frame", () => {
    const command = makeCommand("run.follow_up", {
      payload: { delivery: "run_next", messageId: "msg_next", text: "Later." },
    });
    const plan = planDispatch(view(), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(plan.frames).toEqual([]);
    expect(plan.rows).toEqual([
      {
        kind: "hold_message",
        row: {
          messageId: "msg_next",
          commandId: command.commandId,
          issuedByUserId: command.issuedByUserId,
          text: "Later.",
          attachments: [],
          heldAt: TEST_TIME,
          skipRequiredChecks: false,
        },
      },
    ]);
  });

  it("holds the follow-up's request to skip the required checks with the message", () => {
    const command = makeCommand("run.follow_up", {
      payload: {
        delivery: "run_next",
        messageId: "msg_next",
        skipRequiredChecks: true,
        effort: "xhigh",
      },
    });
    const plan = planDispatch(view(), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(plan.rows[0]).toMatchObject({
      kind: "hold_message",
      row: { messageId: "msg_next", skipRequiredChecks: true, effort: "xhigh" },
    });
  });

  it.each([
    [
      "a steering follow-up",
      makeCommand("run.follow_up", { payload: { delivery: "steer_current_run" } }),
    ],
    ["a cancel", makeCommand("run.cancel")],
    ["a run start", makeCommand("run.start")],
  ])("sends %s at once when the runtime is ready and a bridge is attached", (_name, command) => {
    const plan = planDispatch(view(), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(plan.frames).toEqual([
      { kind: "command", intentId: command.commandId, command, runId: "run_1", context: null },
    ]);
    expect(plan.rows).toEqual([
      {
        kind: "insert_dispatch",
        row: {
          intentId: command.commandId,
          generation: 1,
          kind: {
            kind: "command",
            commandJson: JSON.stringify(command),
            runId: "run_1",
            context: null,
          },
          state: "sent",
          attempts: 1,
          createdAt: TEST_TIME,
        },
      },
    ]);
  });

  it("leaves a run start pending when the runtime is not ready, even with a bridge attached", () => {
    const plan = planDispatch(view({ runtimeReady: false }), {
      kind: "command_admitted",
      command: makeCommand("run.start"),
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(plan.frames).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ row: { state: "pending", attempts: 0 } });
  });

  it("sends a shutdown whenever a bridge is attached, runtime or not, and holds it when none is", () => {
    const command = makeCommand("runtime.shutdown");
    const attached = planDispatch(view({ runtimeReady: false }), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(attached.frames).toHaveLength(1);

    const detached = planDispatch(view({ bridgeAttached: false }), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
    });
    expect(detached.frames).toEqual([]);
    expect(detached.rows[0]).toMatchObject({ row: { state: "pending" } });
  });
});

describe("planDispatch: command_admitted, a run.start on another model or effort (record 15)", () => {
  const OTHER = {
    provider: "openai",
    modelId: "gpt-6-sol",
    modelConnectionId: "conn_2",
    authenticationType: "api_key" as const,
    contextWindow: 1_050_000,
    effort: "low" as const,
  };
  const start = (model: ModelRecord, payload: { readonly checksOnly?: boolean } = {}) =>
    makeCommand("run.start", {
      commandId: "cmd_start_2" as CommandId,
      payload: { model, continuesRunId: "run_1", ...payload },
    });
  const admitted = (command: ReturnType<typeof start>, mintedGrantId: string | undefined) =>
    ({
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_2",
      ...(mintedGrantId === undefined ? {} : { mintedGrantId }),
    }) as const;

  it("sends a model grant for the changed model ahead of the start, on the same socket", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant", { state: "accepted" })] }),
      admitted(start(OTHER), "grant_change"),
    );
    const need = {
      kind: "model_grant",
      connectionId: "conn_2",
      modelId: "gpt-6-sol",
      providerId: "openai",
      workspace: "none",
      effort: "low",
    };
    expect(plan.rows).toEqual([
      {
        kind: "insert_dispatch",
        row: {
          intentId: "grant_change",
          generation: 1,
          kind: need,
          state: "sent",
          attempts: 1,
          createdAt: TEST_TIME,
        },
      },
      {
        kind: "insert_dispatch",
        row: expect.objectContaining({ intentId: "cmd_start_2", state: "sent" }),
      },
    ]);
    expect(plan.frames.map((frame) => frame.kind)).toEqual(["model_grant", "command"]);
    expect(plan.frames[0]).toEqual({ kind: "model_grant", intentId: "grant_change", need });
  });

  it("names the repository workspace on the grant of a session that has one", () => {
    const plan = planDispatch(
      view({ repository: REPOSITORY, rows: [grantRow("model_grant")] }),
      admitted(start(OTHER), "grant_change"),
    );
    expect(plan.frames[0]).toMatchObject({ need: { workspace: "repository" } });
  });

  it("grants again for the same model at another effort, since the token fixes the effort", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      admitted(start({ ...testModelRecord(), effort: "high" }), "grant_effort"),
    );
    expect(plan.frames[0]).toMatchObject({
      kind: "model_grant",
      need: { connectionId: "conn_1", modelId: "claude-sonnet-4-5", effort: "high" },
    });
  });

  it("grants again for the same model on another connection: the token names whose key is charged", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      admitted(start({ ...testModelRecord(), modelConnectionId: "conn_9" }), "grant_key"),
    );
    expect(plan.frames[0]).toMatchObject({ kind: "model_grant", need: { connectionId: "conn_9" } });
  });

  it("plans no grant for a start on the model and effort the generation already holds", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      admitted(start(testModelRecord()), "grant_unused"),
    );
    expect(plan.frames.map((frame) => frame.kind)).toEqual(["command"]);
    expect(plan.rows).toHaveLength(1);
  });

  it("reads a record stored before effort existed as no effort, and looks past the rows that are not grants", () => {
    const { effort: _effort, ...older } = testModelRecord();
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant"), commandRow({ state: "accepted" })] }),
      admitted(start(older), "grant_unused"),
    );
    expect(plan.frames.map((frame) => frame.kind)).toEqual(["command"]);
  });

  it("grants again for the same model id under another provider", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      admitted(start({ ...testModelRecord(), provider: "openai" }), "grant_provider"),
    );
    expect(plan.frames[0]).toMatchObject({ kind: "model_grant", need: { providerId: "openai" } });
  });

  it("compares against the newest grant the bridge did not refuse", () => {
    const refusedChange: DispatchRow = {
      ...grantRow("model_grant", { state: "rejected" }),
      intentId: "grant_refused",
      kind: {
        kind: "model_grant",
        connectionId: "conn_2",
        modelId: "gpt-6-sol",
        providerId: "openai",
        workspace: "none",
        effort: "low",
      },
    };
    const rows = [grantRow("model_grant", { state: "accepted" }), refusedChange];
    // The bridge still holds the first model, so a start on it needs nothing.
    expect(
      planDispatch(view({ rows }), admitted(start(testModelRecord()), "grant_unused")).frames.map(
        (frame) => frame.kind,
      ),
    ).toEqual(["command"]);
    // And a start on the refused model asks again rather than assume it is held.
    expect(
      planDispatch(view({ rows }), admitted(start(OTHER), "grant_again")).frames.map(
        (frame) => frame.kind,
      ),
    ).toEqual(["model_grant", "command"]);
  });

  it("plans no grant before the generation's first: the bridge's hello plans that one for the current run", () => {
    const plan = planDispatch(
      view({ runtimeReady: false, bridgeAttached: false, rows: [] }),
      admitted(start(OTHER), "grant_unused"),
    );
    expect(plan.frames).toEqual([]);
    expect(plan.rows).toEqual([
      { kind: "insert_dispatch", row: expect.objectContaining({ intentId: "cmd_start_2" }) },
    ]);
  });

  it("keeps the grant and the start pending while no bridge is attached", () => {
    const plan = planDispatch(
      view({ bridgeAttached: false, rows: [grantRow("model_grant")] }),
      admitted(start(OTHER), "grant_change"),
    );
    expect(plan.frames).toEqual([]);
    expect(plan.rows).toEqual([
      {
        kind: "insert_dispatch",
        row: expect.objectContaining({ intentId: "grant_change", state: "pending", attempts: 0 }),
      },
      {
        kind: "insert_dispatch",
        row: expect.objectContaining({ intentId: "cmd_start_2", state: "pending", attempts: 0 }),
      },
    ]);
  });

  it("plans no grant for a checks-only run, which prompts no model", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      admitted(start(OTHER, { checksOnly: true }), "grant_unused"),
    );
    expect(plan.frames.map((frame) => frame.kind)).toEqual(["command"]);
  });

  it("plans no grant when the caller minted no id for one, or for a command that is not a start", () => {
    expect(
      planDispatch(
        view({ rows: [grantRow("model_grant")] }),
        admitted(start(OTHER), undefined),
      ).frames.map((frame) => frame.kind),
    ).toEqual(["command"]);
    const cancel = planDispatch(view({ rows: [grantRow("model_grant")] }), {
      kind: "command_admitted",
      command: makeCommand("run.cancel"),
      now: TEST_TIME,
      runId: "run_1",
      mintedGrantId: "grant_unused",
    });
    expect(cancel.frames.map((frame) => frame.kind)).toEqual(["command"]);
  });
});

describe("planDispatch: runtime_ready", () => {
  it("flushes every pending command row in order and nothing else", () => {
    const plan = planDispatch(
      view({
        rows: [
          grantRow("model_grant", { state: "pending", attempts: 0 }),
          commandRow({ commandId: "cmd_a" }),
          commandRow({ commandId: "cmd_b", state: "sent", attempts: 1 }),
          commandRow({ commandId: "cmd_c" }),
        ],
      }),
      { kind: "runtime_ready", now: TEST_TIME },
    );
    expect(plan.frames.map((frame) => frame.intentId)).toEqual(["cmd_a", "cmd_c"]);
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "cmd_a", state: "sent", bumpAttempts: true },
      { kind: "mark_dispatch", intentId: "cmd_c", state: "sent", bumpAttempts: true },
    ]);
  });
});

describe("planDispatch: ack", () => {
  const ackInput = (frame: AckFrame) =>
    ({ kind: "ack", frame, now: TEST_TIME, eventId: "evt_ack" }) as const;

  it("does nothing for an unknown intent, or one already settled", () => {
    const unknown = planDispatch(
      view(),
      ackInput(ack({ commandId: "nope" }, { kind: "accepted" })),
    );
    expect(unknown.rows).toEqual([]);

    const settled = planDispatch(
      view({ rows: [commandRow({ state: "accepted", attempts: 1 })] }),
      ackInput(ack({ commandId: "cmd_start" }, { kind: "accepted" })),
    );
    expect(settled.rows).toEqual([]);
    expect(settled.events).toEqual([]);
  });

  it("turns an accepted command ack into command.acknowledged { acceptedBy: bridge }", () => {
    const plan = planDispatch(
      view({ rows: [commandRow({ state: "sent", attempts: 1 })] }),
      ackInput(ack({ commandId: "cmd_start" }, { kind: "accepted" })),
    );
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "cmd_start", state: "accepted", bumpAttempts: false },
    ]);
    expect(plan.events[0]).toMatchObject({
      type: "command.acknowledged",
      eventId: "evt_ack",
      payload: { commandId: "cmd_start", commandType: "run.start", acceptedBy: "bridge" },
    });
  });

  it.each([
    ["wrong_state", "wrong_state"],
    ["duplicate", "duplicate"],
    ["no_runtime", "wrong_state"],
    ["unsupported", "unsupported"],
    ["malformed", "unsupported"],
  ] as const)("maps a %s rejection onto command.rejected { %s }", (reason, mapped) => {
    const plan = planDispatch(
      view({ rows: [commandRow({ state: "sent", attempts: 1 })] }),
      ackInput(ack({ commandId: "cmd_start" }, { kind: "rejected", reason })),
    );
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "cmd_start", state: "rejected", bumpAttempts: false },
    ]);
    expect(plan.events[0]).toMatchObject({
      type: "command.rejected",
      payload: { commandId: "cmd_start", reason: mapped, expectedState: null, actualState: null },
    });
  });

  it("marks an accepted grant and emits nothing: a grant has no timeline row", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("git_grant")] }),
      ackInput(ack({ grantId: "grant_git" }, { kind: "accepted" })),
    );
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "grant_git", state: "accepted", bumpAttempts: false },
    ]);
    expect(plan.events).toEqual([]);
  });

  it("fails the current run at provisioning when the bridge rejects the model grant", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")] }),
      ackInput(ack({ grantId: "grant_model" }, { kind: "rejected", reason: "wrong_state" })),
    );
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "grant_model", state: "rejected", bumpAttempts: false },
      { kind: "fail_run", runId: TEST_IDS.runId },
    ]);
    expect(plan.events[0]).toMatchObject({
      type: "run.failed",
      runId: TEST_IDS.runId,
      payload: { stage: "provisioning", error: { category: "model_grant_rejected" } },
    });
  });

  it("only marks a rejected model grant when the current run already reached an outcome", () => {
    const plan = planDispatch(
      view({ rows: [grantRow("model_grant")], currentRunOpen: false }),
      ackInput(ack({ grantId: "grant_model" }, { kind: "rejected", reason: "wrong_state" })),
    );
    expect(plan.rows).toEqual([
      { kind: "mark_dispatch", intentId: "grant_model", state: "rejected", bumpAttempts: false },
    ]);
    expect(plan.events).toEqual([]);
  });

  it("only marks a rejected git grant, and a rejected model grant with no current run", () => {
    const git = planDispatch(
      view({ rows: [grantRow("git_grant")] }),
      ackInput(ack({ grantId: "grant_git" }, { kind: "rejected", reason: "wrong_state" })),
    );
    expect(git.rows).toHaveLength(1);
    expect(git.events).toEqual([]);

    const noRun = planDispatch(
      view({ rows: [grantRow("model_grant")], currentRunId: null, model: null }),
      ackInput(ack({ grantId: "grant_model" }, { kind: "rejected", reason: "no_runtime" })),
    );
    expect(noRun.rows).toHaveLength(1);
    expect(noRun.events).toEqual([]);
  });
});

describe("planDispatch: run_terminal", () => {
  const terminal = {
    kind: "run_terminal",
    runId: TEST_IDS.runId,
    now: TEST_TIME,
    mintedRunId: "run_next",
    mintedCommandId: "cmd_next",
    mintedGrantId: "grant_next",
  } as const;

  it("does nothing with no held message, or with no model to continue on", () => {
    expect(planDispatch(view(), terminal).continuation).toBeNull();
    expect(planDispatch(view({ held: [held()], model: null }), terminal).continuation).toBeNull();
  });

  it("releases the oldest held message as a run.start continuing the finished run on the same model", () => {
    const plan = planDispatch(view({ held: [held("msg_first"), held("msg_second")] }), terminal);
    expect(plan.rows).toEqual([
      { kind: "release_message", messageId: "msg_first", runId: "run_next" },
    ]);
    expect(plan.continuation?.runId).toBe("run_next");
    expect(plan.continuation?.command).toEqual({
      commandId: "cmd_next",
      sessionId: TEST_IDS.sessionId,
      runId: null,
      issuedAt: TEST_TIME,
      issuedByUserId: TEST_IDS.userId,
      expected: { scope: "session", state: "active" },
      type: "run.start",
      payload: {
        instruction: { messageId: "msg_first", text: "And also update the docs.", attachments: [] },
        model: testModelRecord(),
        continuesRunId: TEST_IDS.runId,
      },
    });
  });

  it("releases a held message at the effort it named, with a fresh model grant when the generation's differs", () => {
    const lowHeld = { ...held("msg_low"), effort: "low" as const };
    const plan = planDispatch(
      view({ held: [lowHeld], rows: [grantRow("model_grant")], bridgeAttached: true }),
      terminal,
    );
    expect(plan.continuation?.command.payload).toMatchObject({
      model: { ...testModelRecord(), effort: "low" },
    });
    expect(plan.rows).toEqual([
      { kind: "release_message", messageId: "msg_low", runId: "run_next" },
      {
        kind: "insert_dispatch",
        row: expect.objectContaining({
          intentId: "grant_next",
          state: "sent",
          attempts: 1,
          kind: expect.objectContaining({ kind: "model_grant", effort: "low" }),
        }),
      },
    ]);
    expect(plan.frames).toEqual([
      {
        kind: "model_grant",
        intentId: "grant_next",
        need: expect.objectContaining({ effort: "low" }),
      },
    ]);

    // A session with a repository names it on the re-grant, as at hello.
    const withRepository = planDispatch(
      view({ held: [lowHeld], rows: [grantRow("model_grant")], repository: REPOSITORY }),
      terminal,
    );
    expect(withRepository.frames[0]).toMatchObject({ need: { workspace: "repository" } });

    // With no bridge to send it to, the grant waits as a pending row.
    const detached = planDispatch(
      view({ held: [lowHeld], rows: [grantRow("model_grant")], bridgeAttached: false }),
      terminal,
    );
    expect(detached.rows[1]).toMatchObject({ row: { state: "pending", attempts: 0 } });
    expect(detached.frames).toEqual([]);
  });

  it("plans no grant when the held message names no effort, the same one, or no grant exists yet", () => {
    const same = planDispatch(view({ held: [held()], rows: [grantRow("model_grant")] }), terminal);
    expect(same.rows).toHaveLength(1);
    expect(same.continuation?.command.payload).toMatchObject({ model: testModelRecord() });
    const explicit = planDispatch(
      view({ held: [{ ...held(), effort: null }], rows: [grantRow("model_grant")] }),
      terminal,
    );
    expect(explicit.rows).toHaveLength(1);
    // No grant row yet: the bridge's hello plans the first grant.
    const first = planDispatch(view({ held: [{ ...held(), effort: "low" }], rows: [] }), terminal);
    expect(first.rows).toHaveLength(1);
    expect(first.continuation?.command.payload).toMatchObject({ model: { effort: "low" } });
  });

  it("re-issues the held message's request to skip the required checks on the run.start", () => {
    const skipping = { ...held("msg_skip"), skipRequiredChecks: true };
    const plan = planDispatch(view({ held: [skipping] }), terminal);
    expect(plan.continuation?.command.payload).toMatchObject({
      instruction: { messageId: "msg_skip" },
      skipRequiredChecks: true,
    });
  });
});

describe("planDispatch: repository_status and generation_ended", () => {
  it("marks the git grant revoked and asks the shell to revoke its token", () => {
    expect(planDispatch(view(), { kind: "repository_status" })).toEqual({
      rows: [{ kind: "mark_git_grant_revoked" }],
      frames: [],
      events: [],
      continuation: null,
      revokeGitToken: true,
      checkpointRefused: false,
      secretsSettled: null,
    });
  });

  it("abandons the generation's open rows and keeps held messages", () => {
    expect(planDispatch(view({ held: [held()] }), { kind: "generation_ended" })).toEqual({
      rows: [{ kind: "delete_open_for_generation", generation: 1 }],
      frames: [],
      events: [],
      continuation: null,
      revokeGitToken: false,
      checkpointRefused: false,
      secretsSettled: null,
    });
  });
});

describe("chargedRunId", () => {
  it("charges a run.start to the run the object minted, which the command cannot name", () => {
    expect(chargedRunId(makeCommand("run.start"), "run_minted")).toBe("run_minted");
  });

  it("charges every other command to the run it names itself", () => {
    expect(chargedRunId(makeCommand("run.cancel"), "run_minted")).toBe("run_1");
    expect(chargedRunId(makeCommand("runtime.shutdown"), "run_minted")).toBeNull();
  });
});

describe("isRunTerminalEvent", () => {
  it("names record 01's five terminals and nothing else", () => {
    expect(
      [
        "run.verified",
        "run.completed_with_warnings",
        "run.blocked",
        "run.failed",
        "run.cancelled",
        "run.started",
        "run.paused",
        "message.completed",
      ].map((type) => isRunTerminalEvent(type as EventType)),
    ).toEqual([true, true, true, true, true, false, false, false]);
  });
});

describe("planRunRow", () => {
  const RUN = TEST_IDS.runId;

  it("is total over the run event types, and moves the row exactly as the view moves run.state", () => {
    expect(RUN_EVENT_ROW).toEqual({
      "run.queued": null,
      "run.started": { kind: "started" },
      "run.paused": { kind: "paused" },
      "run.interrupted": null,
      "run.verified": { kind: "ended", outcome: "verified" },
      "run.completed_with_warnings": { kind: "ended", outcome: "completed_with_warnings" },
      "run.completed": { kind: "ended", outcome: "completed" },
      "run.blocked": { kind: "ended", outcome: "blocked" },
      "run.failed": { kind: "ended", outcome: "failed" },
      "run.cancelled": null,
    } satisfies Record<RunEventType, unknown>);
  });

  it.each(Object.keys(RUN_EVENT_ROW) as RunEventType[])(
    "%s for the current run answers its table entry, tagged with the run id",
    (type) => {
      const entry = RUN_EVENT_ROW[type];
      expect(planRunRow({ type, runId: RUN }, RUN)).toEqual(
        entry === null ? null : { ...entry, runId: RUN },
      );
    },
  );

  it("moves the current run to ready on runtime.ready, which names no run", () => {
    expect(planRunRow({ type: "runtime.ready", runId: null }, RUN)).toEqual({
      kind: "ready",
      runId: RUN,
    });
  });

  it("moves nothing with no current run, for a run that is not current, or for a non-run event", () => {
    expect(planRunRow({ type: "runtime.ready", runId: null }, null)).toBeNull();
    expect(planRunRow({ type: "run.started", runId: RUN }, null)).toBeNull();
    expect(planRunRow({ type: "run.verified", runId: RUN }, "run_other")).toBeNull();
    expect(planRunRow({ type: "repository.status", runId: null }, RUN)).toBeNull();
    expect(planRunRow({ type: "message.completed", runId: RUN }, RUN)).toBeNull();
  });
});

describe("planRuntimeLoss", () => {
  it.each([
    [null, "nothing"],
    ["verified", "nothing"],
    ["cancelled", "nothing"],
    ["paused", "nothing"],
    ["queued", "fail_provisioning"],
    ["provisioning", "fail_provisioning"],
    ["ready", "fail_execution"],
    ["running", "fail_execution"],
    ["waiting_for_approval", "fail_execution"],
  ] as const)("a bridge giving up while the run is %s means %s", (state, expected) => {
    expect(planRuntimeLoss(state)).toBe(expected);
  });
});

describe("DISPATCH_COLUMN_KIND", () => {
  it("stores every kind under a value the column's original CHECK allows", () => {
    expect(DISPATCH_COLUMN_KIND).toEqual({
      command: "command",
      model_grant: "model_grant",
      git_grant: "git_grant",
      push_grant: "git_grant",
      upload_grant: "git_grant",
      secret_grant: "git_grant",
    });
  });
});

describe("planDispatch: checkpoints and uploads", () => {
  const checkpoint = makeCommand("checkpoint.create", { payload: { reason: "idle" } });
  const request = (push: { grantId: string; parentSha: string } | null) =>
    ({ kind: "checkpoint_requested", command: checkpoint, now: TEST_TIME, push }) as const;

  it("names the task branch in the push grant while the clone is still the base branch, and mints none without a name", () => {
    const unpushed = { ...REPOSITORY, branch: "main", taskBranch: "oncue/named-0a1b" };
    const named = planDispatch(
      view({ repository: unpushed, runtimeReady: false }),
      request({ grantId: "grant_push", parentSha: "p".repeat(40) }),
    );
    expect(named.frames[0]).toMatchObject({
      kind: "push_grant",
      need: { ref: "refs/heads/oncue/named-0a1b" },
    });
    const unnamed = planDispatch(
      view({
        repository: { ...REPOSITORY, branch: "main", taskBranch: null },
        runtimeReady: false,
      }),
      request({ grantId: "grant_push", parentSha: "p".repeat(40) }),
    );
    expect(unnamed.frames.map((frame) => frame.kind)).toEqual(["command"]);
    expect(unnamed.rows.filter((row) => row.kind === "insert_dispatch")).toHaveLength(1);
  });

  it("sends the push grant before the checkpoint command, on a bridge with no runtime yet", () => {
    const plan = planDispatch(
      view({ repository: REPOSITORY, runtimeReady: false }),
      request({ grantId: "grant_push", parentSha: "p".repeat(40) }),
    );
    const need = {
      kind: "push_grant",
      installationId: 4001,
      repositoryId: 501,
      fullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      ref: "refs/heads/oncue/fix-it-1a2b",
      parentSha: "p".repeat(40),
    };
    expect(plan.frames).toEqual([
      { kind: "push_grant", intentId: "grant_push", need },
      {
        kind: "command",
        intentId: checkpoint.commandId,
        command: checkpoint,
        runId: null,
        context: null,
      },
    ]);
    expect(plan.rows).toEqual([
      {
        kind: "insert_dispatch",
        row: {
          intentId: "grant_push",
          generation: 1,
          kind: need,
          state: "sent",
          attempts: 1,
          createdAt: TEST_TIME,
        },
      },
      expect.objectContaining({ kind: "insert_dispatch" }),
    ]);
  });

  it("holds both rows pending with no bridge attached", () => {
    const plan = planDispatch(
      view({ repository: REPOSITORY, bridgeAttached: false }),
      request({ grantId: "grant_push", parentSha: "p".repeat(40) }),
    );
    expect(plan.frames).toEqual([]);
    expect(plan.rows.map((row) => (row.kind === "insert_dispatch" ? row.row.state : null))).toEqual(
      ["pending", "pending"],
    );
  });

  it("sends the command alone with no push to make or no repository to push to", () => {
    for (const plan of [
      planDispatch(view({ repository: REPOSITORY }), request(null)),
      planDispatch(view(), request({ grantId: "grant_push", parentSha: "p".repeat(40) })),
    ]) {
      expect(plan.frames.map((frame) => frame.kind)).toEqual(["command"]);
    }
  });

  it("plans nothing for a checkpoint.create a client sent: only the object's own reaches the bridge", () => {
    const plan = planDispatch(view({ repository: REPOSITORY }), {
      kind: "command_admitted",
      command: checkpoint,
      now: TEST_TIME,
      runId: null,
    });
    expect(plan.rows).toEqual([]);
    expect(plan.frames).toEqual([]);
  });

  it("plans an upload grant for a declared artifact, sent only to an attached bridge", () => {
    const input = {
      kind: "upload_requested",
      artifactId: "art_1",
      grantId: "grant_upload",
      maxBytes: 42,
      now: TEST_TIME,
    } as const;
    const need = { kind: "upload_grant", artifactId: "art_1", maxBytes: 42 };
    expect(planDispatch(view(), input).frames).toEqual([
      { kind: "upload_grant", intentId: "grant_upload", need },
    ]);
    const detached = planDispatch(view({ bridgeAttached: false }), input);
    expect(detached.frames).toEqual([]);
    expect(detached.rows[0]).toMatchObject({ row: { state: "pending", kind: need } });
  });

  it("carries a resume context on the command row and its frame", () => {
    const command = makeCommand("run.start");
    const plan = planDispatch(view(), {
      kind: "command_admitted",
      command,
      now: TEST_TIME,
      runId: "run_1",
      context: "summary",
    });
    expect(plan.frames[0]).toMatchObject({ context: "summary" });
    expect(plan.rows[0]).toMatchObject({ row: { kind: { context: "summary" } } });
  });

  it("redelivers open push and upload grants and a checkpoint before the runtime is up, and reads an old row with no context as none", () => {
    const pushRow: DispatchRow = {
      intentId: "grant_push",
      generation: 1,
      kind: {
        kind: "push_grant",
        installationId: 4001,
        repositoryId: 501,
        fullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        ref: "refs/heads/oncue/fix-it-1a2b",
        parentSha: "p".repeat(40),
      },
      state: "sent",
      attempts: 1,
      createdAt: TEST_TIME,
    };
    const uploadRow: DispatchRow = {
      ...pushRow,
      intentId: "grant_upload",
      kind: { kind: "upload_grant", artifactId: "art_1", maxBytes: 42 },
    };
    const checkpointRow = commandRow({ commandId: "cmd_ckpt", state: "pending" });
    const checkpointCommand = makeCommand("checkpoint.create", {
      commandId: "cmd_ckpt" as CommandId,
    });
    const plan = planDispatch(
      view({
        runtimeReady: false,
        model: null,
        rows: [
          pushRow,
          uploadRow,
          {
            ...checkpointRow,
            kind: { kind: "command", commandJson: JSON.stringify(checkpointCommand), runId: null },
          },
          commandRow({ commandId: "cmd_start", state: "pending" }),
        ],
      }),
      CONNECTED,
    );
    expect(plan.frames.map((frame) => [frame.kind, frame.intentId])).toEqual([
      ["push_grant", "grant_push"],
      ["upload_grant", "grant_upload"],
      ["command", "cmd_ckpt"],
    ]);
    expect(plan.frames[2]).toMatchObject({ context: null });
  });

  it("tells the shell the checkpoint was refused only for a rejected checkpoint command", () => {
    const command = makeCommand("checkpoint.create", { commandId: "cmd_ckpt" as CommandId });
    const row: DispatchRow = {
      ...commandRow({ commandId: "cmd_ckpt", state: "sent" }),
      kind: { kind: "command", commandJson: JSON.stringify(command), runId: null },
    };
    const rejected = planDispatch(view({ rows: [row] }), {
      kind: "ack",
      frame: ack({ commandId: "cmd_ckpt" }, { kind: "rejected", reason: "wrong_state" }),
      now: TEST_TIME,
      eventId: "evt_1",
    });
    expect(rejected.checkpointRefused).toBe(true);
    const accepted = planDispatch(view({ rows: [row] }), {
      kind: "ack",
      frame: ack({ commandId: "cmd_ckpt" }, { kind: "accepted" }),
      now: TEST_TIME,
      eventId: "evt_1",
    });
    expect(accepted.checkpointRefused).toBe(false);
    const otherRejected = planDispatch(view({ rows: [commandRow({ state: "sent" })] }), {
      kind: "ack",
      frame: ack({ commandId: "cmd_start" }, { kind: "rejected", reason: "wrong_state" }),
      now: TEST_TIME,
      eventId: "evt_1",
    });
    expect(otherRejected.checkpointRefused).toBe(false);
  });
});

describe("planDispatch: development secrets", () => {
  const input = {
    kind: "secrets_requested",
    grantId: "grant_secret",
    names: ["DATABASE_URL"],
    requestRef: "ref_1",
    approvalId: "apr_1",
    now: TEST_TIME,
  } as const;
  const need = {
    kind: "secret_grant",
    names: ["DATABASE_URL"],
    requestRef: "ref_1",
    approvalId: "apr_1",
  } as const;
  const row = (state: DispatchRow["state"]): DispatchRow => ({
    intentId: "grant_secret",
    generation: 1,
    kind: need,
    state,
    attempts: 1,
    createdAt: TEST_TIME,
  });
  const ack = (outcome: AckFrame["outcome"]) =>
    ({
      kind: "ack",
      frame: { ref: { grantId: "grant_secret" }, outcome } as AckFrame,
      now: TEST_TIME,
      eventId: "evt_ack",
    }) as const;

  it("stores names and never a value, and sends only to an attached bridge", () => {
    const plan = planDispatch(view(), input);
    expect(plan.frames).toEqual([{ kind: "secret_grant", intentId: "grant_secret", need }]);
    expect(plan.rows).toEqual([
      {
        kind: "insert_dispatch",
        row: { ...row("sent"), attempts: 1 },
      },
    ]);
    const detached = planDispatch(view({ bridgeAttached: false }), input);
    expect(detached.frames).toEqual([]);
    expect(detached.rows[0]).toMatchObject({ row: { state: "pending", attempts: 0 } });
  });

  it("redelivers an open secret grant to a bridge that reconnects, before the runtime is up", () => {
    const plan = planDispatch(
      view({ runtimeReady: false, model: null, rows: [row("sent")] }),
      CONNECTED,
    );
    expect(plan.frames).toEqual([{ kind: "secret_grant", intentId: "grant_secret", need }]);
  });

  it("tells the shell what an acknowledged grant delivered, accepted or not, and says nothing twice", () => {
    expect(
      planDispatch(view({ rows: [row("sent")] }), ack({ kind: "accepted" })).secretsSettled,
    ).toEqual({ names: ["DATABASE_URL"], approvalId: "apr_1", accepted: true });
    expect(
      planDispatch(view({ rows: [row("sent")] }), ack({ kind: "rejected", reason: "malformed" }))
        .secretsSettled,
    ).toEqual({ names: ["DATABASE_URL"], approvalId: "apr_1", accepted: false });
    expect(
      planDispatch(view({ rows: [row("accepted")] }), ack({ kind: "accepted" })).secretsSettled,
    ).toBeNull();
    expect(
      planDispatch(view(), { kind: "runtime_ready", now: TEST_TIME }).secretsSettled,
    ).toBeNull();
  });
});
