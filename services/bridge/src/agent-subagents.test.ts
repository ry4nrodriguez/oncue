/**
 * Subagents through the reducer: the recorded OpenCode wire
 * (`fixtures/opencode-subagents-recorded.jsonl`) replayed through `step`, plus
 * the cases the recording does not reach. The rule under test throughout: a
 * subagent's events never reach the primary agent's turn.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentEffect,
  type AgentInput,
  type AgentState,
  initialAgentState,
  type StepContext,
  type StepOutcome,
  step,
} from "./agent";
import {
  buildCommandFrame,
  buildGrantFrame,
  type CommandFrame,
  type DeliverableCommand,
  type ModelGrantFrame,
} from "./frames";
import type { RuntimeEvent } from "./normalize";
import { OPENCODE_PORT } from "./opencode";
import { parseServerEvent } from "./opencode-wire";
import { bridgeConfig, type Draft, type SequenceCursor, stampDraft } from "./protocol";
import { MAX_RUNNING_SUBAGENTS, TASK_REFUSALS } from "./subagents";

const IDENTITY = { sessionId: "sess_1", generation: 3 };
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" };
const CONFIG = bridgeConfig({ ...IDENTITY, bootstrapCredential: "cred" }, "wss://oncue.example");

function ctx(nowMs = 50_000): StepContext {
  let issued = 0;
  return {
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    newId: () => `id_${++issued}`,
    relayPort: 5001,
    toolPort: 5002,
  };
}

/** Every emitted draft must survive the real parser as the object would run it. */
function run(state: AgentState, input: AgentInput, nowMs = 50_000): StepOutcome {
  const result = step(state, input, ctx(nowMs));
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `evt_${++issued}`, now: () => "2026-10-04T00:00:00.000Z" };
  for (const effect of result.effects) {
    if (effect.kind === "emit") {
      const parsed = parseEventJson(
        JSON.stringify(stampDraft(CONFIG, cursor, io, effect.draft)),
        "sandbox",
      );
      expect(parsed.ok, `${effect.draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
    }
  }
  return result;
}

function command(
  type: DeliverableCommand["type"],
  payload: Record<string, unknown>,
  commandId: string,
  runId: string | null = "run_1",
): AgentInput {
  const frame: CommandFrame = buildCommandFrame(
    IDENTITY,
    {
      commandId,
      sessionId: "sess_1",
      runId: type === "run.start" ? null : runId,
      issuedAt: "2026-10-04T00:00:00.000Z",
      issuedByUserId: "usr_1",
      expected: { scope: "session", state: "active" },
      type,
      payload,
    } as unknown as DeliverableCommand,
    runId,
    null,
  );
  return { kind: "frame", frame: { kind: "command", frame } };
}

function ready(): AgentState {
  const grant = buildGrantFrame(IDENTITY, {
    kind: "model",
    grantId: "grant_model",
    expiresAt: "2026-10-04T00:10:00.000Z",
    token: "ot1.token",
    effort: null,
    modelSpec: null,
    brokerOrigin: "https://oncue.example",
    model: MODEL,
    runtime: "opencode",
    workspace: "none",
  }) as ModelGrantFrame;
  let state = run(initialAgentState("sess_1", 3), {
    kind: "frame",
    frame: { kind: "grant", frame: grant },
  }).state;
  state = run(state, {
    kind: "runtime_started",
    result: { kind: "started", pid: 42, port: OPENCODE_PORT },
  }).state;
  state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
  return run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
}

/** A run OpenCode holds in `conversation`. */
function running(conversation: string): AgentState {
  const started = run(
    ready(),
    command(
      "run.start",
      {
        instruction: { messageId: "msg_1", text: "Use subagents.", attachments: [] },
        model: {
          ...MODEL,
          modelConnectionId: "conn_1",
          authenticationType: "api_key",
          contextWindow: 200_000,
          effort: null,
        },
        continuesRunId: null,
      },
      "cmd_start",
    ),
  ).state;
  return run(started, {
    kind: "prompt_settled",
    turnBase: null,
    runId: "run_1",
    result: { kind: "held", conversation },
  }).state;
}

const event = (value: RuntimeEvent): AgentInput => ({ kind: "runtime_event", event: value });
const drafts = (effects: readonly AgentEffect[]): Draft[] =>
  effects.flatMap((effect) => (effect.kind === "emit" ? [effect.draft] : []));

type Line = { readonly event?: unknown; readonly marker?: { readonly phase: string } };

function phase(name: string): { readonly root: string; readonly events: RuntimeEvent[] } {
  const lines = readFileSync(
    fileURLToPath(new URL("../fixtures/opencode-subagents-recorded.jsonl", import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
  const start = lines.findIndex((line) => line.marker?.phase === name);
  const end = lines.findIndex(
    (line, index) => index > start && line.marker !== undefined && line.marker.phase !== name,
  );
  const slice = lines.slice(start + 1, end === -1 ? undefined : end);
  const events = slice.flatMap((line) =>
    line.event === undefined ? [] : [parseServerEvent(line.event)],
  );
  const root = events.find(
    (entry): entry is Extract<RuntimeEvent, { kind: "session_created" }> =>
      entry.kind === "session_created" && entry.parentId === null,
  );
  if (root === undefined) {
    throw new Error(`no root conversation in phase ${name}`);
  }
  return { root: root.sessionId, events };
}

interface Replayed {
  readonly state: AgentState;
  readonly drafts: Draft[];
  readonly effects: AgentEffect[];
}

/** The object's answer to a forwarded subagent start (`bridge.approval`). */
const approval = (requestRef: string, outcome: "allowed" | "denied" | "pending"): AgentInput =>
  ({
    kind: "frame",
    frame: { kind: "approval", requestRef, outcome, expiresAt: null },
  }) as AgentInput;

/** The cards a step sent for subagent starts. */
function startCards(effects: readonly AgentEffect[]): string[] {
  return drafts(effects).flatMap((entry) =>
    entry.type === "approval.requested" &&
    (entry.payload as { category: string }).category === "start_subagent"
      ? [(entry.payload as { approvalId: string }).approvalId]
      : [],
  );
}

/**
 * Replays events. Each subagent start the bridge forwards is answered as the
 * session object answers under `answer`: "allowed" is a saved choice (Allow
 * for this session), and null leaves every card open.
 */
function replay(
  state: AgentState,
  events: readonly RuntimeEvent[],
  nowMs = 60_000,
  answer: "allowed" | "denied" | null = "allowed",
): Replayed {
  let current = state;
  const all: AgentEffect[] = [];
  const settle = (effects: readonly AgentEffect[]) => {
    all.push(...effects);
    if (answer === null) {
      return;
    }
    for (const ref of startCards(effects)) {
      const answered = run(current, approval(ref, answer), nowMs);
      current = answered.state;
      settle(answered.effects);
    }
  };
  for (const entry of events) {
    const result = run(current, event(entry), nowMs);
    current = result.state;
    settle(result.effects);
  }
  return { state: current, drafts: drafts(all), effects: all };
}

describe("the recorded subagent wire through the reducer", () => {
  it("two subagents side by side: allowed, announced, tagged, and ended, and the turn ends only on the primary agent's idle", () => {
    const { root, events } = phase("parallel");
    const start = running(root);
    // Up to the first child's idle the run must still be running.
    const childIdle = events.findIndex(
      (entry) => entry.kind === "session_idle" && entry.sessionId !== root,
    );
    const before = replay(start, events.slice(0, childIdle + 1));
    expect(before.state.run.kind === "active" && before.state.run.phase).toBe("running");
    const all = replay(before.state, events.slice(childIdle + 1));
    const effects = [...before.effects, ...all.effects];
    const emittedDrafts = [...before.drafts, ...all.drafts];

    // Both `task` asks went to the session object as subagent starts, one
    // card at a time, and its saved choice allowed each.
    expect(
      drafts(effects)
        .filter((entry) => entry.type === "approval.requested")
        .map((entry) => entry.payload),
    ).toMatchObject([
      {
        category: "start_subagent",
        resource: "general subagent: Find the A file",
        toolCallId: "toolu_stub_1_0",
      },
      {
        category: "start_subagent",
        resource: "explore subagent: Read the README",
        toolCallId: "toolu_stub_1_1",
      },
    ]);
    expect(
      effects.filter((effect) => effect.kind === "reply_permission").map((effect) => effect.reply),
    ).toEqual(["once", "once"]);

    const started = emittedDrafts.filter((entry) => entry.type === "agent.started");
    expect(started.map((entry) => entry.payload)).toMatchObject([
      {
        parentToolCallId: "toolu_stub_1_0",
        name: "general",
        description: "Find the A file",
        model: MODEL,
      },
      { parentToolCallId: "toolu_stub_1_1", name: "explore", description: "Read the README" },
    ]);
    const agentIds = started.map((entry) => (entry.payload as { agentId: string }).agentId);
    expect(agentIds.every((id) => id !== root)).toBe(true);

    const completed = emittedDrafts.filter((entry) => entry.type === "agent.completed");
    expect(completed.map((entry) => entry.payload)).toMatchObject([
      {
        status: "completed",
        resultSummary: "Subagent A found it in src/a.ts.",
        usage: { toolCalls: 1 },
      },
      {
        status: "completed",
        resultSummary: "Subagent B read the README.",
        usage: { toolCalls: 1 },
      },
    ]);

    // Every message and call of a subagent carries its id, and nothing of
    // theirs reaches the primary agent's rows.
    const childCalls = new Set(["toolu_stub_2_0", "toolu_stub_3_0"]);
    for (const entry of emittedDrafts) {
      const payload = entry.payload as { agentId?: string; toolCallId?: string };
      if (payload.toolCallId !== undefined && childCalls.has(payload.toolCallId)) {
        expect(agentIds).toContain(payload.agentId);
      }
    }
    const untaggedMessages = emittedDrafts.filter(
      (entry) =>
        entry.type === "message.completed" &&
        (entry.payload as { agentId?: string }).agentId === undefined,
    );
    // The primary agent's two messages: the one that called `task` twice, and its answer.
    expect(untaggedMessages.map((entry) => JSON.stringify(entry.payload))).toEqual([
      expect.stringContaining('"toolCallId":"toolu_stub_1_1"'),
      expect.stringContaining("Both subagents reported back."),
    ]);
    // Each subagent's `agent.started` comes before its own rows.
    for (const agentId of agentIds) {
      const announcedAt = emittedDrafts.findIndex(
        (entry) =>
          entry.type === "agent.started" &&
          (entry.payload as { agentId: string }).agentId === agentId,
      );
      const firstRow = emittedDrafts.findIndex(
        (entry) =>
          (entry.payload as { agentId?: string }).agentId === agentId &&
          entry.type !== "agent.started",
      );
      expect(announcedAt).toBeLessThan(firstRow);
    }
    // The primary agent's idle ended the run, once.
    expect(emittedDrafts.filter((entry) => entry.type === "run.completed")).toHaveLength(1);
    expect(all.state.run.kind).toBe("idle");
  });

  it("a subagent whose model call fails ends failed, and the primary agent carries on", () => {
    const { root, events } = phase("failure");
    const replayed = replay(running(root), events);
    const completed = replayed.drafts.filter((entry) => entry.type === "agent.completed");
    expect(completed.map((entry) => entry.payload)).toMatchObject([
      { status: "failed", resultSummary: expect.stringContaining("Subagent failed") },
    ]);
    // The child's own error failed nothing of the run's.
    expect(replayed.drafts.map((entry) => entry.type)).not.toContain("run.failed");
    expect(replayed.drafts.filter((entry) => entry.type === "run.completed")).toHaveLength(1);
  });

  it("the user stops one subagent: its conversation is aborted and it ends cancelled", () => {
    const { root, events } = phase("stop");
    const runningBash = events.findIndex(
      (entry) =>
        entry.kind === "tool_part" && entry.part.tool === "bash" && entry.part.status === "running",
    );
    const before = replay(running(root), events.slice(0, runningBash + 1));
    const started = before.drafts.find((entry) => entry.type === "agent.started");
    const agentId = (started?.payload as { agentId?: string } | undefined)?.agentId ?? "";
    expect(agentId).not.toBe("");
    const stopped = run(before.state, command("agent.stop", { agentId }, "cmd_stop"));
    expect(stopped.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_stop" }, outcome: { kind: "accepted" } },
      { kind: "abort", runId: "run_1", conversation: agentId },
    ]);
    const after = replay(stopped.state, events.slice(runningBash + 1));
    expect(
      after.drafts
        .filter((entry) => entry.type === "agent.completed")
        .map((entry) => entry.payload),
    ).toMatchObject([{ agentId, status: "cancelled" }]);
    // The child's own abort error and late terminals did not end or fail the run early.
    expect(after.drafts.filter((entry) => entry.type === "run.completed")).toHaveLength(1);
    expect(after.drafts.map((entry) => entry.type)).not.toContain("run.failed");
  });
});

describe("subagents in the reducer, beyond the recording", () => {
  const ROOT = "ses_root";
  const ask = (callId: string, name = "general", sessionId = ROOT): RuntimeEvent => ({
    kind: "permission_asked",
    requestId: `per_${callId}`,
    permission: "task",
    callId,
    patterns: [name],
    sessionId,
  });
  const created = (sessionId: string, agent = "general"): RuntimeEvent => ({
    kind: "session_created",
    sessionId,
    parentId: ROOT,
    title: `x (@${agent} subagent)`,
    agent,
  });
  const taskPart = (
    callId: string,
    status: "running" | "completed",
    childSessionId?: string,
  ): RuntimeEvent => ({
    kind: "tool_part",
    messageId: "msg_root",
    sessionId: ROOT,
    part: {
      callId,
      tool: "task",
      status,
      title: "x",
      input: { description: "Look around", prompt: "Look around.", subagent_type: "general" },
      output: status === "completed" ? "<task_result>done</task_result>" : null,
      error: null,
      exitCode: null,
      startedAtMs: 1,
      endedAtMs: null,
      ...(childSessionId === undefined ? {} : { childSessionId }),
    },
  });

  /** One subagent allowed, created, and announced. */
  function withChild(): AgentState {
    return replay(running(ROOT), [
      ask("call_1"),
      created("ses_child"),
      taskPart("call_1", "running", "ses_child"),
    ]).state;
  }

  it(`allows ${MAX_RUNNING_SUBAGENTS} subagents at once and refuses the next with a clear reason`, () => {
    const replayed = replay(
      running(ROOT),
      Array.from({ length: MAX_RUNNING_SUBAGENTS + 1 }, (_, index) => ask(`call_${index}`)),
    );
    const replies = replayed.effects.filter((effect) => effect.kind === "reply_permission");
    expect(replies.map((effect) => effect.reply)).toEqual([
      "once",
      "once",
      "once",
      "once",
      "reject",
    ]);
    expect(replies.at(-1)).toMatchObject({ message: TASK_REFUSALS.busy });
  });

  it("refuses a task ask from a subagent, for a repository's own agent, and with no run", () => {
    const nested = replay(withChild(), [ask("call_9", "general", "ses_child")]);
    expect(nested.effects.find((effect) => effect.kind === "reply_permission")).toMatchObject({
      reply: "reject",
      message: TASK_REFUSALS.nested,
    });
    const repoAgent = replay(running(ROOT), [ask("call_9", "evil")]);
    expect(repoAgent.effects.find((effect) => effect.kind === "reply_permission")).toMatchObject({
      message: TASK_REFUSALS.name,
    });
    const idle = replay(ready(), [ask("call_9")]);
    expect(idle.effects.find((effect) => effect.kind === "reply_permission")).toMatchObject({
      reply: "reject",
      message: TASK_REFUSALS.noRun,
    });
  });

  it("a subagent's idle and error never end or fail the primary agent's run", () => {
    const replayed = replay(withChild(), [
      {
        kind: "session_error",
        name: "APIError",
        message: "boom",
        status: 500,
        sessionId: "ses_child",
      },
      { kind: "session_idle", sessionId: "ses_child" },
    ]);
    expect(replayed.state.run.kind === "active" && replayed.state.run.phase).toBe("running");
    expect(replayed.drafts.map((entry) => entry.type)).not.toContain("run.failed");
    const ended = replay(replayed.state, [{ kind: "session_idle", sessionId: ROOT }]);
    expect(ended.drafts.map((entry) => entry.type)).toContain("run.completed");
  });

  it("holds a subagent's rows that arrive before its call names it, then releases them after it is announced", () => {
    const early = replay(running(ROOT), [
      ask("call_1"),
      created("ses_child"),
      {
        kind: "message_started",
        messageId: "msg_child",
        role: "assistant",
        sessionId: "ses_child",
      },
    ]);
    expect(early.drafts.map((entry) => entry.type)).toEqual(["approval.requested"]);
    const named = replay(early.state, [taskPart("call_1", "running", "ses_child")]);
    // The subagent first, then the primary agent's own call row.
    expect(named.drafts.map((entry) => entry.type)).toEqual([
      "agent.started",
      "message.started",
      "message.started",
      "tool.requested",
      "tool.started",
    ]);
    expect(named.drafts[1]?.payload).toMatchObject({
      messageId: "msg_child",
      agentId: "ses_child",
    });
    expect(named.drafts[2]?.payload).toEqual({ messageId: "msg_root", role: "assistant" });
  });

  it("drops a conversation that is neither the run's nor one of its subagents'", () => {
    const state = running(ROOT);
    const replayed = replay(state, [
      { kind: "message_started", messageId: "msg_x", role: "assistant", sessionId: "ses_stranger" },
      { kind: "session_idle", sessionId: "ses_stranger" },
    ]);
    expect(replayed.effects).toEqual([]);
    expect(replayed.state).toEqual(state);
  });

  it("aborts a child conversation nobody allowed, such as a subtask sent straight to the API", () => {
    const replayed = replay(running(ROOT), [created("ses_sneaky")]);
    expect(replayed.effects).toEqual([
      { kind: "abort", runId: "run_1", conversation: "ses_sneaky" },
    ]);
    const after = replay(replayed.state, [
      { kind: "message_started", messageId: "msg_s", role: "assistant", sessionId: "ses_sneaky" },
    ]);
    expect(after.effects).toEqual([]);
  });

  it("cancelling the run aborts every running subagent, and its end reports them cancelled", () => {
    const cancelled = run(
      withChild(),
      command("run.cancel", { reason: null, checkpointFirst: false }, "cmd_cancel"),
    );
    expect(cancelled.effects).toEqual(
      expect.arrayContaining([
        { kind: "abort", runId: "run_1", conversation: ROOT },
        { kind: "abort", runId: "run_1", conversation: "ses_child" },
      ]),
    );
    const ended = replay(cancelled.state, [{ kind: "session_idle", sessionId: ROOT }], 70_000);
    expect(
      ended.drafts
        .filter((entry) => entry.type === "agent.completed")
        .map((entry) => entry.payload),
    ).toMatchObject([{ agentId: "ses_child", status: "cancelled" }]);
    // Already asked to stop, so the end aborts nothing twice.
    expect(ended.effects.filter((effect) => effect.kind === "abort")).toEqual([]);
  });

  it("a runtime that exits under a running subagent ends it cancelled with the run", () => {
    const exited = run(withChild(), { kind: "runtime_exited", code: 1, signal: null });
    const types = drafts(exited.effects).map((entry) => entry.type);
    expect(types).toContain("run.failed");
    expect(types).toContain("agent.completed");
    expect(exited.effects).toContainEqual({
      kind: "abort",
      runId: "run_1",
      conversation: "ses_child",
    });
  });

  it("refuses to stop a subagent that is not running, or in a run that is not this one", () => {
    const unknown = run(withChild(), command("agent.stop", { agentId: "ses_nobody" }, "cmd_stop"));
    expect(unknown.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_stop" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    const otherRun = run(
      withChild(),
      command("agent.stop", { agentId: "ses_child" }, "cmd_stop", "run_9"),
    );
    expect(otherRun.effects[0]).toMatchObject({
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
    const noRun = run(ready(), command("agent.stop", { agentId: "ses_child" }, "cmd_stop"));
    expect(noRun.effects[0]).toMatchObject({ outcome: { kind: "rejected" } });
  });

  it("the primary agent's completed task ends its subagent before the call's own row settles", () => {
    const replayed = replay(withChild(), [taskPart("call_1", "completed", "ses_child")]);
    expect(replayed.drafts.map((entry) => entry.type)).toEqual([
      "agent.completed",
      "tool.completed",
    ]);
    expect(replayed.drafts[0]?.payload).toMatchObject({
      status: "completed",
      resultSummary: "done",
    });
  });

  it("a subagent's diff report still asks the bridge's own Git to measure", () => {
    const replayed = replay(withChild(), [
      { kind: "session_diff", files: [], sessionId: "ses_child" },
    ]);
    expect(replayed.effects).toEqual([]);
  });

  /** The primary agent's call naming a conversation already there, as `task_id` makes it. */
  const resumePart = (
    callId: string,
    status: "running" | "error",
    sessionId: string,
  ): RuntimeEvent => ({
    kind: "tool_part",
    messageId: "msg_root",
    sessionId: ROOT,
    part: {
      callId,
      tool: "task",
      status,
      title: "x",
      input: { description: "Carry on", prompt: "Carry on.", task_id: sessionId },
      output: null,
      error: status === "error" ? "Task cancelled" : null,
      exitCode: null,
      startedAtMs: 1,
      endedAtMs: null,
      childSessionId: sessionId,
    },
  });
  const aborts = (effects: readonly AgentEffect[]) =>
    effects.filter((effect) => effect.kind === "abort");
  const types = (entries: readonly Draft[]) => entries.map((entry) => entry.type);

  it("a task call that resumes an ended subagent by task_id has that conversation aborted, and nothing is announced", () => {
    const ended = replay(withChild(), [taskPart("call_1", "completed", "ses_child")]).state;
    const resumed = replay(ended, [ask("call_2"), resumePart("call_2", "running", "ses_child")]);
    expect(aborts(resumed.effects)).toEqual([
      { kind: "abort", runId: "run_1", conversation: "ses_child" },
    ]);
    expect(resumed.effects).toContainEqual({
      kind: "log",
      line: "aborted a conversation a task call named but was not allowed to start",
    });
    // The call is the primary agent's own row and nothing more: no second subagent.
    expect(types(resumed.drafts)).toEqual(["approval.requested", "tool.requested", "tool.started"]);
    // What the resumed conversation does in the meantime reaches nobody's rows.
    const working = replay(resumed.state, [
      {
        kind: "message_started",
        messageId: "msg_again",
        role: "assistant",
        sessionId: "ses_child",
      },
      { kind: "session_idle", sessionId: "ses_child" },
    ]);
    expect(working.effects).toEqual([]);
    expect(working.state.run.kind === "active" && working.state.run.phase).toBe("running");
    const settled = replay(working.state, [resumePart("call_2", "error", "ses_child")]);
    expect(types(settled.drafts)).toEqual(["tool.failed"]);
    expect(aborts(settled.effects)).toEqual([]);
  });

  it("a conversation a task call resumes from an earlier run is aborted, and its asks are refused", () => {
    const resumed = replay(running(ROOT), [
      ask("call_1"),
      resumePart("call_1", "running", "ses_earlier"),
    ]);
    expect(aborts(resumed.effects)).toEqual([
      { kind: "abort", runId: "run_1", conversation: "ses_earlier" },
    ]);
    expect(types(resumed.drafts)).not.toContain("agent.started");
    const asked = run(
      resumed.state,
      event({
        kind: "permission_asked",
        requestId: "per_earlier",
        permission: "external_directory",
        callId: "call_earlier_read",
        patterns: ["/etc/*"],
        sessionId: "ses_earlier",
      }),
    );
    expect(asked.effects).toEqual([
      expect.objectContaining({
        kind: "reply_permission",
        requestId: "per_earlier",
        reply: "reject",
      }),
    ]);
    // The run winding down asks nothing twice: its abort is already on its way.
    const cancelled = run(
      resumed.state,
      command("run.cancel", { reason: null, checkpointFirst: false }, "cmd_cancel"),
    );
    expect(aborts(cancelled.effects)).toEqual([
      { kind: "abort", runId: "run_1", conversation: ROOT },
    ]);
  });

  describe("an abort that fails", () => {
    const failedAbort = (conversation: string, runId = "run_1"): AgentInput => ({
      kind: "abort_settled",
      runId,
      conversation,
      ok: false,
    });
    const stopped = () =>
      run(withChild(), command("agent.stop", { agentId: "ses_child" }, "cmd_stop")).state;

    it("is forgotten, so a second stop sends the abort again", () => {
      const failed = run(stopped(), failedAbort("ses_child"));
      expect(failed.effects).toEqual([
        {
          kind: "log",
          line: "a subagent's abort failed; the next stop, wind-down, or run end asks again",
        },
      ]);
      const again = run(
        failed.state,
        command("agent.stop", { agentId: "ses_child" }, "cmd_stop_2"),
      );
      expect(again.effects).toEqual([
        { kind: "ack", ref: { commandId: "cmd_stop_2" }, outcome: { kind: "accepted" } },
        { kind: "abort", runId: "run_1", conversation: "ses_child" },
      ]);
    });

    it("is asked again when the run winds down, and when it ends", () => {
      const failed = run(stopped(), failedAbort("ses_child")).state;
      const cancelled = run(
        failed,
        command("run.cancel", { reason: null, checkpointFirst: false }, "cmd_cancel"),
      );
      expect(aborts(cancelled.effects)).toEqual([
        { kind: "abort", runId: "run_1", conversation: ROOT },
        { kind: "abort", runId: "run_1", conversation: "ses_child" },
      ]);
      const failedAgain = run(cancelled.state, failedAbort("ses_child")).state;
      const ended = replay(failedAgain, [{ kind: "session_idle", sessionId: ROOT }], 70_000);
      expect(aborts(ended.effects)).toEqual([
        { kind: "abort", runId: "run_1", conversation: "ses_child" },
      ]);
    });

    it("changes nothing while a stop's abort is on its way or went through", () => {
      const state = stopped();
      const settled = run(state, {
        kind: "abort_settled",
        runId: "run_1",
        conversation: "ses_child",
        ok: true,
      });
      expect(settled).toEqual({ state, effects: [] });
      const again = run(state, command("agent.stop", { agentId: "ses_child" }, "cmd_stop_2"));
      expect(again.effects).toEqual([
        { kind: "ack", ref: { commandId: "cmd_stop_2" }, outcome: { kind: "accepted" } },
      ]);
    });

    it("changes nothing for the run's own conversation, another run, or no run", () => {
      const state = stopped();
      expect(run(state, failedAbort(ROOT))).toEqual({ state, effects: [] });
      expect(run(state, failedAbort("ses_child", "run_9"))).toEqual({ state, effects: [] });
      const idle = ready();
      expect(run(idle, failedAbort("ses_child"))).toEqual({ state: idle, effects: [] });
    });
  });
});

describe("subagents under the user's approval mode (record 09)", () => {
  const ROOT = "ses_root";
  const ask = (callId: string, name = "explore"): RuntimeEvent => ({
    kind: "permission_asked",
    requestId: `per_${callId}`,
    permission: "task",
    callId,
    patterns: [name],
    metadata: { description: "Read the README", subagent_type: name },
    sessionId: ROOT,
  });
  const replies = (effects: readonly AgentEffect[]) =>
    effects.flatMap((effect) => (effect.kind === "reply_permission" ? [effect] : []));
  const requested = (effects: readonly AgentEffect[]) =>
    drafts(effects).flatMap((entry) =>
      entry.type === "approval.requested" ? [entry.payload as Record<string, unknown>] : [],
    );
  const slots = (state: AgentState) =>
    state.run.kind === "active" ? state.run.subagents.allowed : [];

  it("under Allow once, a start shows a card naming the subagent and waits for the answer", () => {
    const asked = replay(running(ROOT), [ask("call_1")], 60_000, null);
    expect(requested(asked.effects)).toEqual([
      expect.objectContaining({
        category: "start_subagent",
        resource: "explore subagent: Read the README",
        toolCallId: "call_1",
      }),
    ]);
    // Nothing answers OpenCode until the object does.
    expect(replies(asked.effects)).toEqual([]);
    const ref = startCards(asked.effects)[0] as string;
    const pending = run(asked.state, approval(ref, "pending"));
    expect(replies(pending.effects)).toEqual([]);
    const allowed = run(pending.state, approval(ref, "allowed"));
    expect(replies(allowed.effects)).toEqual([
      { kind: "reply_permission", requestId: "per_call_1", reply: "once", message: null },
    ]);
    expect(slots(allowed.state)).toEqual([
      { callId: "call_1", name: "explore", requestId: "per_call_1", approved: true },
    ]);
  });

  it("a denied start is refused and gives its slot back", () => {
    const asked = replay(running(ROOT), [ask("call_1")], 60_000, null);
    const denied = run(asked.state, approval(startCards(asked.effects)[0] as string, "denied"));
    expect(replies(denied.effects)).toEqual([
      expect.objectContaining({ requestId: "per_call_1", reply: "reject" }),
    ]);
    expect(slots(denied.state)).toEqual([]);
  });

  it(`refuses past ${MAX_RUNNING_SUBAGENTS} without a card, counting starts still waiting on the user, after the asks ahead`, () => {
    const asked = replay(
      running(ROOT),
      Array.from({ length: MAX_RUNNING_SUBAGENTS + 1 }, (_, index) => ask(`call_${index}`)),
      60_000,
      null,
    );
    // One card out at a time; the fifth takes no slot and never becomes a card.
    expect(requested(asked.effects)).toHaveLength(1);
    expect(slots(asked.state)).toHaveLength(MAX_RUNNING_SUBAGENTS);
    // OpenCode spreads a reject to every pending ask, so the refusal waits
    // until the four ahead of it are answered.
    expect(replies(asked.effects)).toEqual([]);
    let state = asked.state;
    const effects: AgentEffect[] = [];
    let cards = startCards(asked.effects);
    while (cards.length > 0) {
      const answered = run(state, approval(cards[0] as string, "allowed"));
      state = answered.state;
      effects.push(...answered.effects);
      cards = startCards(answered.effects);
    }
    expect(requested(effects)).toHaveLength(MAX_RUNNING_SUBAGENTS - 1);
    expect(replies(effects).map((effect) => [effect.requestId, effect.reply])).toEqual([
      ...Array.from({ length: MAX_RUNNING_SUBAGENTS }, (_, index) => [`per_call_${index}`, "once"]),
      [`per_call_${MAX_RUNNING_SUBAGENTS}`, "reject"],
    ]);
    expect(replies(effects).at(-1)).toMatchObject({ message: TASK_REFUSALS.busy });
  });

  it("refuses at once a start the run cannot take when nothing else waits", () => {
    const state = replay(
      running(ROOT),
      Array.from({ length: MAX_RUNNING_SUBAGENTS }, (_, index) => ask(`call_${index}`)),
    ).state;
    const fifth = run(state, event(ask("call_extra")));
    expect(replies(fifth.effects)).toEqual([
      expect.objectContaining({ requestId: "per_call_extra", reply: "reject" }),
    ]);
    expect(requested(fifth.effects)).toEqual([]);
  });

  /** One subagent allowed, created, and announced, with one read of its own in flight. */
  function withChildCall(): AgentState {
    return replay(running(ROOT), [
      ask("call_1"),
      {
        kind: "session_created",
        sessionId: "ses_child",
        parentId: ROOT,
        title: "x",
        agent: "explore",
      },
      {
        kind: "tool_part",
        messageId: "msg_root",
        sessionId: ROOT,
        part: {
          callId: "call_1",
          tool: "task",
          status: "running",
          title: "x",
          input: { description: "Read the README", prompt: "Read it.", subagent_type: "explore" },
          output: null,
          error: null,
          exitCode: null,
          startedAtMs: 1,
          endedAtMs: null,
          childSessionId: "ses_child",
        },
      },
      {
        kind: "tool_part",
        messageId: "msg_child",
        sessionId: "ses_child",
        part: {
          callId: "call_child_read",
          tool: "read",
          status: "running",
          title: null,
          input: { filePath: "/etc/hosts" },
          output: null,
          error: null,
          exitCode: null,
          startedAtMs: 2,
          endedAtMs: null,
        },
      },
    ]).state;
  }

  it("a subagent's own ask names it, and the call and tool are the subagent's", () => {
    const asked = run(
      withChildCall(),
      event({
        kind: "permission_asked",
        requestId: "per_outside",
        permission: "external_directory",
        callId: "call_child_read",
        patterns: ["/etc/*"],
        metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
        sessionId: "ses_child",
      }),
    );
    expect(requested(asked.effects)).toEqual([
      expect.objectContaining({
        category: "outside_project",
        resource: "/etc/hosts",
        toolCallId: "call_child_read",
        toolCategory: "file_read",
        agentId: "ses_child",
      }),
    ]);
  });

  it("refuses a subagent's secret ask at once, so the run's secret slot stays free", () => {
    const asked = run(
      withChildCall(),
      event({
        kind: "permission_asked",
        requestId: "per_secret",
        permission: "oncue_secret_request",
        callId: "call_child_secret",
        sessionId: "ses_child",
      }),
    );
    expect(replies(asked.effects)).toEqual([
      expect.objectContaining({ requestId: "per_secret", reply: "reject" }),
    ]);
    expect(asked.state.secrets.waiting).toBeNull();
    expect(requested(asked.effects)).toEqual([]);
  });

  it("refuses a secret ask from every conversation but the primary agent's", () => {
    const secretAsk = (sessionId: string): AgentInput =>
      event({
        kind: "permission_asked",
        requestId: `per_secret_${sessionId}`,
        permission: "oncue_secret_request",
        callId: `call_secret_${sessionId}`,
        sessionId,
      });
    const child = (sessionId: string): RuntimeEvent => ({
      kind: "session_created",
      sessionId,
      parentId: ROOT,
      title: "x",
      agent: "explore",
    });
    // One subagent waiting for its call to name it, one that ended, one nobody
    // allowed, and a conversation the run never heard of.
    const state = replay(withChildCall(), [
      {
        kind: "tool_part",
        messageId: "msg_root",
        sessionId: ROOT,
        part: {
          callId: "call_1",
          tool: "task",
          status: "completed",
          title: "x",
          input: {},
          output: "<task_result>done</task_result>",
          error: null,
          exitCode: null,
          startedAtMs: 1,
          endedAtMs: 3,
          childSessionId: "ses_child",
        },
      },
      ask("call_2"),
      child("ses_waiting"),
      child("ses_sneaky"),
    ]).state;
    for (const sessionId of ["ses_waiting", "ses_child", "ses_sneaky", "ses_stranger"]) {
      const asked = run(state, secretAsk(sessionId));
      expect(replies(asked.effects), sessionId).toEqual([
        {
          kind: "reply_permission",
          requestId: `per_secret_${sessionId}`,
          reply: "reject",
          message: expect.stringContaining("A subagent cannot ask for a secret."),
        },
      ]);
      expect(asked.state.secrets, sessionId).toEqual(state.secrets);
      expect(requested(asked.effects), sessionId).toEqual([]);
    }
    // The primary agent's own secret request still takes the run's one place.
    const own = run(state, secretAsk(ROOT));
    expect(replies(own.effects)).toEqual([]);
    expect(own.state.secrets.waiting).toMatchObject({ requestId: `per_secret_${ROOT}` });
  });

  it("a subagent's read of a secret file asks the user in its name, and holds no secret request", () => {
    const asked = run(
      withChildCall(),
      event({
        kind: "permission_asked",
        requestId: "per_env",
        permission: "read",
        callId: "call_child_read",
        patterns: [".env"],
        sessionId: "ses_child",
      }),
    );
    // A permission card like any other of the subagent's, never a secret request.
    expect(requested(asked.effects)).toEqual([
      expect.objectContaining({
        category: "secret_file",
        resource: ".env",
        toolCallId: "call_child_read",
        toolCategory: "file_read",
        agentId: "ses_child",
      }),
    ]);
    expect(replies(asked.effects)).toEqual([]);
    expect(asked.state.secrets.waiting).toBeNull();
    // The primary agent's secret request is taken while that card is out, and waits its turn behind it.
    const secret = run(
      asked.state,
      event({
        kind: "permission_asked",
        requestId: "per_secret",
        permission: "oncue_secret_request",
        callId: "call_root_secret",
        sessionId: ROOT,
      }),
    );
    expect(replies(secret.effects)).toEqual([]);
    expect(secret.state.secrets.waiting).toMatchObject({ requestId: "per_secret" });
    // Denied, the read is refused to the subagent and nothing of the run's is.
    const ref = asked.state.permissions.held[0]?.ref as string;
    const denied = run(secret.state, approval(ref, "denied"));
    expect(replies(denied.effects)).toEqual([
      expect.objectContaining({ requestId: "per_env", reply: "reject" }),
    ]);
    expect(denied.state.run.kind === "active" && denied.state.run.phase).toBe("running");
  });

  it("dismisses a question a subagent asks; only the primary agent talks to the user", () => {
    const asked = run(
      withChildCall(),
      event({
        kind: "question_asked",
        requestId: "que_child",
        callId: "call_child_q",
        questions: [
          {
            id: "q1",
            header: "Which",
            text: "Which one?",
            options: [],
            multiple: false,
            allowOther: true,
          },
        ],
        askedCount: 1,
        sessionId: "ses_child",
      }),
    );
    expect(asked.effects).toContainEqual({
      kind: "reply_question",
      requestId: "que_child",
      reply: { kind: "dismiss", reason: "from_subagent" },
    });
    expect(drafts(asked.effects).map((entry) => entry.type)).not.toContain("question.asked");
    expect(asked.state.questions.waiting).toBeNull();
  });

  it("refuses an ask from a subagent that has ended", () => {
    const ended = replay(withChildCall(), [
      {
        kind: "tool_part",
        messageId: "msg_root",
        sessionId: ROOT,
        part: {
          callId: "call_1",
          tool: "task",
          status: "completed",
          title: "x",
          input: {},
          output: "<task_result>done</task_result>",
          error: null,
          exitCode: null,
          startedAtMs: 1,
          endedAtMs: 3,
          childSessionId: "ses_child",
        },
      },
    ]).state;
    const asked = run(
      ended,
      event({
        kind: "permission_asked",
        requestId: "per_late",
        permission: "external_directory",
        callId: "call_child_read",
        patterns: ["/etc/*"],
        sessionId: "ses_child",
      }),
    );
    expect(replies(asked.effects)).toEqual([
      expect.objectContaining({ requestId: "per_late", reply: "reject" }),
    ]);
  });
});
