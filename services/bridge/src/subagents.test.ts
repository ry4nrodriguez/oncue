import { LIMITS } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import type { NormalizeContext, RuntimeEvent, ToolPart } from "./normalize";
import type { Draft } from "./protocol";
import {
  holdDrafts,
  liveCount,
  MAX_HELD_DRAFTS,
  MAX_RUNNING_SUBAGENTS,
  MAX_SUBAGENTS_PER_RUN,
  NO_SUBAGENTS,
  onAbortFailed,
  onChildEvent,
  onRootToolPart,
  onRunEnded,
  onSessionCreated,
  onStopAsked,
  onTaskAnswered,
  onTaskAsked,
  onWindDown,
  routeOf,
  type SubagentState,
  TASK_REFUSALS,
  tagDraft,
  taskResult,
} from "./subagents";

const ROOT = "ses_root";
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" };
const RUNNING = { fromRoot: true, runRunning: true };

function ctx(): NormalizeContext {
  let issued = 0;
  return { nowMs: 1_000, newId: () => `id_${++issued}`, runId: "run_1", contextWindow: 200_000 };
}

/** A start asked and, when it took a slot, allowed by the session object. */
function ask(state: SubagentState, callId: string, name = "general") {
  const step = onTaskAsked(
    state,
    { requestId: `per_${callId}`, callId, patterns: [name] },
    RUNNING,
  );
  return step.forward === null
    ? step
    : { ...step, state: onTaskAnswered(step.state, `per_${callId}`, "once") };
}

function created(state: SubagentState, sessionId: string, agent = "general") {
  return onSessionCreated(
    state,
    { sessionId, parentId: ROOT, agent },
    { rootConversation: ROOT, nowMs: 500 },
  );
}

function taskPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    callId: "call_1",
    tool: "task",
    status: "running",
    title: "Find the A file",
    input: { description: "Find the A file", prompt: "Find A.", subagent_type: "general" },
    output: null,
    error: null,
    exitCode: null,
    startedAtMs: 400,
    endedAtMs: null,
    ...overrides,
  };
}

const rootCtx = { runId: "run_1", nowMs: 2_000, model: MODEL, rootConversation: ROOT };

/** The primary agent's call that names a conversation already there, as `task_id` makes it. */
function resumePart(
  callId: string,
  sessionId: string,
  overrides: Partial<ToolPart> = {},
): ToolPart {
  return taskPart({
    callId,
    childSessionId: sessionId,
    input: { description: "Carry on", prompt: "Carry on.", task_id: sessionId },
    ...overrides,
  });
}

const ABORTED_LOG = {
  kind: "log",
  line: "aborted a conversation a task call named but was not allowed to start",
};

/** One subagent that ran and ended, and a second call allowed and not yet started. */
function endedThenAllowed(): SubagentState {
  const ended = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
  return ask(ended, "call_2").state;
}

/** One subagent allowed, created, and announced through its call's metadata. */
function announced(): SubagentState {
  const allowed = ask(NO_SUBAGENTS, "call_1").state;
  const made = created(allowed, "ses_child").state;
  return onRootToolPart(made, taskPart({ childSessionId: "ses_child" }), rootCtx).state;
}

describe("routeOf", () => {
  const state = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;

  it("reads untagged events and anything before the run's conversation as the primary agent's", () => {
    expect(routeOf(state, ROOT, undefined)).toEqual({ kind: "root" });
    expect(routeOf(state, null, "ses_child")).toEqual({ kind: "root" });
    expect(routeOf(state, ROOT, ROOT)).toEqual({ kind: "root" });
  });

  it("tells a subagent's events from a stranger's", () => {
    expect(routeOf(state, ROOT, "ses_child")).toEqual({ kind: "child", agentId: "ses_child" });
    expect(routeOf(state, ROOT, "ses_other")).toEqual({ kind: "foreign" });
  });
});

describe("onTaskAsked", () => {
  it("holds a slot for a built-in subagent from the primary agent and forwards it to the user's mode", () => {
    const step = onTaskAsked(
      NO_SUBAGENTS,
      { requestId: "per_1", callId: "call_1", patterns: ["explore"] },
      RUNNING,
    );
    // No answer of its own: the session object's gate answers it.
    expect(step.effects).toEqual([]);
    expect(step.forward).toBe("explore");
    expect(step.state.allowed).toEqual([
      { callId: "call_1", name: "explore", requestId: "per_1", approved: false },
    ]);
    expect(liveCount(step.state)).toBe(1);
    // A conversation cannot take a slot the object has not allowed.
    expect(created(step.state, "ses_child", "explore").effects).toEqual([
      { kind: "abort", agentId: "ses_child" },
    ]);
  });

  it("keeps the slot when the object allows it and gives it back when it refuses", () => {
    const held = onTaskAsked(
      NO_SUBAGENTS,
      { requestId: "per_1", callId: "call_1", patterns: ["general"] },
      RUNNING,
    ).state;
    expect(onTaskAnswered(held, "per_1", "once").allowed).toEqual([
      { callId: "call_1", name: "general", requestId: "per_1", approved: true },
    ]);
    expect(onTaskAnswered(held, "per_1", "reject").allowed).toEqual([]);
    // Another request's answer is not a start's.
    expect(onTaskAnswered(held, "per_other", "reject")).toBe(held);
  });

  it("forwards a repeat while the first ask waits, without a second slot", () => {
    const held = onTaskAsked(
      NO_SUBAGENTS,
      { requestId: "per_1", callId: "call_1", patterns: ["general"] },
      RUNNING,
    ).state;
    const again = onTaskAsked(
      held,
      { requestId: "per_2", callId: "call_1", patterns: ["general"] },
      RUNNING,
    );
    expect(again).toMatchObject({ state: held, effects: [], forward: "general" });
  });

  it("refuses an ask that names no call", () => {
    const step = onTaskAsked(
      NO_SUBAGENTS,
      { requestId: "per_1", callId: null, patterns: ["general"] },
      RUNNING,
    );
    expect(step.effects[0]).toMatchObject({ reply: "reject", message: TASK_REFUSALS.noCall });
    expect(step.forward).toBeNull();
  });

  it("refuses with no running run, from a subagent, or for any other name", () => {
    const refused = (
      patterns: readonly string[],
      context: { fromRoot: boolean; runRunning: boolean },
    ) =>
      onTaskAsked(NO_SUBAGENTS, { requestId: "per_1", callId: "call_1", patterns }, context)
        .effects[0];
    expect(refused(["general"], { fromRoot: true, runRunning: false })).toMatchObject({
      reply: "reject",
      message: TASK_REFUSALS.noRun,
    });
    expect(refused(["general"], { fromRoot: false, runRunning: true })).toMatchObject({
      reply: "reject",
      message: TASK_REFUSALS.nested,
    });
    expect(refused(["evil"], RUNNING)).toMatchObject({ message: TASK_REFUSALS.name });
    expect(refused([], RUNNING)).toMatchObject({ message: TASK_REFUSALS.name });
    expect(refused(["general", "explore"], RUNNING)).toMatchObject({
      message: TASK_REFUSALS.name,
    });
  });

  it("answers a repeated ask for a call it already let through without counting it twice", () => {
    const once = ask(NO_SUBAGENTS, "call_1").state;
    const again = ask(once, "call_1");
    expect(again.state).toBe(once);
    expect(again.effects[0]).toMatchObject({ reply: "once" });
    expect(again.forward).toBeNull();
  });

  it(`refuses a start past ${MAX_RUNNING_SUBAGENTS} running`, () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_RUNNING_SUBAGENTS; index += 1) {
      state = ask(state, `call_${index}`).state;
    }
    const fifth = ask(state, "call_extra");
    // Refused before any card: the user is never asked for a start the run cannot take.
    expect(fifth.effects[0]).toMatchObject({ reply: "reject", message: TASK_REFUSALS.busy });
    expect(fifth.forward).toBeNull();
    expect(fifth.state).toBe(state);
  });

  it(`refuses past ${MAX_SUBAGENTS_PER_RUN} in one run, even with none running`, () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN; index += 1) {
      const callId = `call_${index}`;
      state = created(ask(state, callId).state, `ses_${index}`).state;
      state = onRootToolPart(
        state,
        taskPart({ callId, status: "completed", childSessionId: `ses_${index}` }),
        rootCtx,
      ).state;
    }
    expect(liveCount(state)).toBe(0);
    expect(state.started).toBe(MAX_SUBAGENTS_PER_RUN);
    const more = ask(state, "call_more");
    expect(more.effects[0]).toMatchObject({ reply: "reject", message: TASK_REFUSALS.spent });
    expect(more.forward).toBeNull();
  });

  it("counts a start against the run's limit when the object allows it, and never gives it back", () => {
    const held = onTaskAsked(
      NO_SUBAGENTS,
      { requestId: "per_1", callId: "call_1", patterns: ["general"] },
      RUNNING,
    ).state;
    expect(held.started).toBe(0);
    // A start the user refuses was never one.
    expect(onTaskAnswered(held, "per_1", "reject").started).toBe(0);
    const allowed = onTaskAnswered(held, "per_1", "once");
    expect(allowed.started).toBe(1);
    // An answer delivered twice counts once.
    expect(onTaskAnswered(allowed, "per_1", "once")).toBe(allowed);
    // The call failing before any conversation began ends its slot, not its count.
    const failed = onRootToolPart(allowed, taskPart({ status: "error", error: "boom" }), rootCtx);
    expect(failed.state).toMatchObject({ allowed: [], started: 1 });
  });

  it("counts starts still waiting on the user toward the run's limit", () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN - 1; index += 1) {
      state = onRootToolPart(
        ask(state, `call_${index}`).state,
        taskPart({ callId: `call_${index}`, status: "error", error: "boom" }),
        rootCtx,
      ).state;
    }
    const waiting = onTaskAsked(
      state,
      { requestId: "per_last", callId: "call_last", patterns: ["general"] },
      RUNNING,
    );
    expect(waiting.forward).toBe("general");
    // Fifteen allowed and one waiting: a seventeenth could pass the limit if both were allowed.
    expect(ask(waiting.state, "call_more").effects[0]).toMatchObject({
      message: TASK_REFUSALS.spent,
    });
  });

  it("does not count a child conversation nobody allowed against the run's limit", () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN + 1; index += 1) {
      state = created(state, `ses_sneaky_${index}`).state;
    }
    expect(state.started).toBe(0);
    expect(ask(state, "call_1").forward).toBe("general");
  });
});

describe("onSessionCreated", () => {
  it("ignores the run's own conversation, another conversation's child, and a repeat", () => {
    const allowed = ask(NO_SUBAGENTS, "call_1").state;
    const own = onSessionCreated(
      allowed,
      { sessionId: ROOT, parentId: null, agent: null },
      { rootConversation: ROOT, nowMs: 1 },
    );
    expect(own.state).toBe(allowed);
    const before = onSessionCreated(
      allowed,
      { sessionId: "ses_child", parentId: ROOT, agent: "general" },
      { rootConversation: null, nowMs: 1 },
    );
    expect(before.state).toBe(allowed);
    const stranger = onSessionCreated(
      allowed,
      { sessionId: "ses_child", parentId: "ses_other", agent: "general" },
      { rootConversation: ROOT, nowMs: 1 },
    );
    expect(stranger.state).toBe(allowed);
    const made = created(allowed, "ses_child").state;
    expect(created(made, "ses_child").state).toBe(made);
  });

  it("takes the allowed slot for its name and waits for its call", () => {
    const state = created(ask(NO_SUBAGENTS, "call_1", "explore").state, "ses_child", "explore");
    expect(state.effects).toEqual([]);
    expect(state.state.allowed).toEqual([]);
    expect(state.state.agents[0]).toMatchObject({
      agentId: "ses_child",
      name: "explore",
      phase: "pending",
      callId: null,
      startedAtMs: 500,
    });
  });

  it("aborts a child conversation nobody allowed, and remembers it so its events drop", () => {
    const step = created(NO_SUBAGENTS, "ses_sneaky", "evil");
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_sneaky" }]);
    expect(step.state.agents[0]).toMatchObject({
      phase: "refused",
      name: "general",
      stopRequested: true,
    });
    expect(routeOf(step.state, ROOT, "ses_sneaky")).toEqual({
      kind: "child",
      agentId: "ses_sneaky",
    });
  });

  it("stops remembering refused conversations past a bound, but still aborts them", () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN * 2; index += 1) {
      state = created(state, `ses_${index}`).state;
    }
    const step = created(state, "ses_last");
    expect(step.state.agents).toHaveLength(MAX_SUBAGENTS_PER_RUN * 2);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_last" }]);
  });
});

describe("onRootToolPart", () => {
  it("passes over every call but task", () => {
    const state = ask(NO_SUBAGENTS, "call_1").state;
    expect(onRootToolPart(state, taskPart({ tool: "bash" }), rootCtx).state).toBe(state);
  });

  it("announces a subagent when its call names it, releasing what it held, in order", () => {
    const made = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;
    const held = onChildEvent(
      made,
      "ses_child",
      { kind: "message_started", messageId: "msg_c", role: "assistant" },
      ctx(),
    );
    expect(held.drafts).toEqual([]);
    const step = onRootToolPart(held.state, taskPart({ childSessionId: "ses_child" }), rootCtx);
    expect(step.drafts.map((entry) => entry.type)).toEqual(["agent.started", "message.started"]);
    expect(step.drafts[0]?.payload).toEqual({
      agentId: "ses_child",
      parentToolCallId: "call_1",
      name: "general",
      description: "Find the A file",
      prompt: "Find A.",
      promptTruncated: false,
      model: MODEL,
    });
    expect(step.drafts[1]?.payload).toMatchObject({ messageId: "msg_c", agentId: "ses_child" });
    expect(step.state.agents[0]).toMatchObject({ phase: "running", callId: "call_1", held: [] });
  });

  it("cuts a long prompt and says so, and names a call with no description by its subagent", () => {
    const made = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;
    const long = "p".repeat(LIMITS.summaryTextChars + 10);
    const step = onRootToolPart(
      made,
      taskPart({ childSessionId: "ses_child", input: { prompt: long } }),
      { ...rootCtx, model: null },
    );
    expect(step.drafts[0]?.payload).toMatchObject({
      description: "general subagent",
      promptTruncated: true,
      model: null,
    });
    expect((step.drafts[0]?.payload as { prompt?: string } | undefined)?.prompt).toHaveLength(
      LIMITS.summaryTextChars,
    );
    const empty = onRootToolPart(
      made,
      taskPart({ childSessionId: "ses_child", input: {} }),
      rootCtx,
    );
    expect(empty.drafts[0]?.payload).toMatchObject({ prompt: "", promptTruncated: false });
  });

  it("ends a subagent with what it reported when its call completes", () => {
    const step = onRootToolPart(
      announced(),
      taskPart({
        status: "completed",
        output:
          '<task id="ses_child" state="completed">\n<task_result>\nFound it in src/a.ts.\n</task_result>\n</task>',
      }),
      rootCtx,
    );
    expect(step.drafts).toEqual([
      {
        type: "agent.completed",
        runId: "run_1",
        payload: {
          agentId: "ses_child",
          status: "completed",
          usage: { tokens: 0, toolCalls: 0, durationMs: 1_500 },
          resultSummary: "Found it in src/a.ts.",
        },
      },
    ]);
    expect(step.state.agents[0]?.phase).toBe("settled");
    // A call that re-sends its settled part ends nothing twice.
    expect(onRootToolPart(step.state, taskPart({ status: "completed" }), rootCtx).drafts).toEqual(
      [],
    );
  });

  it("reads a failed call as failed, and a cancelled or stopped one as cancelled", () => {
    const failed = onRootToolPart(
      announced(),
      taskPart({ status: "error", error: "Subagent failed (task_id: ses_child): boom" }),
      rootCtx,
    );
    expect(failed.drafts[0]?.payload).toMatchObject({
      status: "failed",
      resultSummary: "Subagent failed (task_id: ses_child): boom",
    });
    const cancelled = onRootToolPart(
      announced(),
      taskPart({ status: "error", error: "Task cancelled" }),
      rootCtx,
    );
    expect(cancelled.drafts[0]?.payload).toMatchObject({ status: "cancelled" });
    const stopped = onStopAsked(announced(), "ses_child").state;
    const ended = onRootToolPart(stopped, taskPart({ status: "completed", output: "" }), rootCtx);
    expect(ended.drafts[0]?.payload).toMatchObject({ status: "cancelled", resultSummary: null });
    const silent = onRootToolPart(announced(), taskPart({ status: "error", error: null }), rootCtx);
    expect(silent.drafts[0]?.payload).toMatchObject({ status: "failed", resultSummary: null });
  });

  it("announces and ends at once a subagent whose call settles before naming it otherwise", () => {
    const made = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;
    const step = onRootToolPart(
      made,
      taskPart({ status: "completed", childSessionId: "ses_child", output: "plain answer" }),
      rootCtx,
    );
    expect(step.drafts.map((entry) => entry.type)).toEqual(["agent.started", "agent.completed"]);
    expect(step.drafts[1]?.payload).toMatchObject({ resultSummary: "plain answer" });
  });

  it("ends the slot of a call that settled before any conversation began", () => {
    const allowed = ask(NO_SUBAGENTS, "call_1").state;
    const step = onRootToolPart(allowed, taskPart({ status: "error", error: "denied" }), rootCtx);
    expect(step.state.allowed).toEqual([]);
    expect(step.drafts).toEqual([]);
    expect(liveCount(step.state)).toBe(0);
  });

  it("does nothing for a call that names no conversation and has no subagent", () => {
    const claimed = announced();
    const step = onRootToolPart(claimed, taskPart({ callId: "call_unknown" }), rootCtx);
    expect(step).toEqual({ state: claimed, drafts: [], effects: [] });
  });
});

describe("a task call that names a conversation it did not start", () => {
  it("aborts a subagent that already ended instead of resuming it, and announces nothing", () => {
    const allowed = endedThenAllowed();
    const step = onRootToolPart(allowed, resumePart("call_2", "ses_child"), rootCtx);
    expect(step.drafts).toEqual([]);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_child" }, ABORTED_LOG]);
    // The call started nothing, so no conversation may take its slot.
    expect(step.state.allowed).toEqual([]);
    expect(step.state.resumes).toEqual([{ callId: "call_2", agentId: "ses_child" }]);
    expect(step.state.agents[0]).toMatchObject({ phase: "settled", stopRequested: true });
    // Its events stay dropped, and it cannot be stopped as if it were running.
    const event: RuntimeEvent = { kind: "message_started", messageId: "m", role: "assistant" };
    expect(onChildEvent(step.state, "ses_child", event, ctx()).state).toBe(step.state);
    expect(onStopAsked(step.state, "ses_child").accepted).toBe(false);
    // Aborted once for the call, however often the call's part repeats.
    const again = onRootToolPart(step.state, resumePart("call_2", "ses_child"), rootCtx);
    expect(again).toEqual({ state: step.state, drafts: [], effects: [] });
  });

  it("counts the refused call as running until it settles, and against the run's limit for good", () => {
    const refused = onRootToolPart(
      endedThenAllowed(),
      resumePart("call_2", "ses_child"),
      rootCtx,
    ).state;
    expect(liveCount(refused)).toBe(1);
    expect(refused.started).toBe(2);
    const settled = onRootToolPart(
      refused,
      resumePart("call_2", "ses_child", { status: "error", error: "Task cancelled" }),
      rootCtx,
    );
    expect(settled.drafts).toEqual([]);
    expect(settled.effects).toEqual([]);
    expect(settled.state.resumes).toEqual([]);
    expect(liveCount(settled.state)).toBe(0);
    expect(settled.state.started).toBe(2);
  });

  it(`cannot pass ${MAX_SUBAGENTS_PER_RUN} a run by resuming one subagent again and again`, () => {
    let state = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
    const aborts: string[] = [];
    for (let index = 1; index < MAX_SUBAGENTS_PER_RUN; index += 1) {
      const callId = `call_again_${index}`;
      const asked = ask(state, callId);
      expect(asked.forward).toBe("general");
      const running = onRootToolPart(asked.state, resumePart(callId, "ses_child"), rootCtx);
      aborts.push(
        ...running.effects.flatMap((effect) => (effect.kind === "abort" ? [effect.agentId] : [])),
      );
      state = onRootToolPart(
        running.state,
        resumePart(callId, "ses_child", { status: "completed", output: "" }),
        rootCtx,
      ).state;
    }
    // Every resume was aborted, and none got its place in the run's limit back.
    expect(aborts).toEqual(Array.from({ length: MAX_SUBAGENTS_PER_RUN - 1 }, () => "ses_child"));
    expect(state.started).toBe(MAX_SUBAGENTS_PER_RUN);
    expect(ask(state, "call_more").effects[0]).toMatchObject({
      reply: "reject",
      message: TASK_REFUSALS.spent,
    });
  });

  it("aborts and remembers a conversation the run never knew, such as an earlier run's subagent", () => {
    const allowed = ask(NO_SUBAGENTS, "call_1").state;
    const step = onRootToolPart(allowed, resumePart("call_1", "ses_earlier"), rootCtx);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_earlier" }, ABORTED_LOG]);
    expect(step.state.agents).toMatchObject([
      { agentId: "ses_earlier", phase: "refused", stopRequested: true, callId: null },
    ]);
    // Known now, so its events and asks are its own rather than a stranger's.
    expect(routeOf(step.state, ROOT, "ses_earlier")).toEqual({
      kind: "child",
      agentId: "ses_earlier",
    });
    expect(step.state.allowed).toEqual([]);
    expect(liveCount(step.state)).toBe(1);
  });

  it("aborts a running subagent another call names, and its end reads as cancelled", () => {
    const allowed = ask(announced(), "call_2").state;
    const step = onRootToolPart(allowed, resumePart("call_2", "ses_child"), rootCtx);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_child" }, ABORTED_LOG]);
    expect(step.drafts).toEqual([]);
    // Without the call's own `task_id` to read, the conversation being another call's says the same.
    const unread = onRootToolPart(
      allowed,
      taskPart({ callId: "call_2", childSessionId: "ses_child" }),
      rootCtx,
    );
    expect(unread.effects).toEqual(step.effects);
    const ended = onRootToolPart(
      step.state,
      taskPart({ status: "completed", output: "partial" }),
      rootCtx,
    );
    expect(ended.drafts[0]?.payload).toMatchObject({ agentId: "ses_child", status: "cancelled" });
  });

  it("aborts a conversation still waiting for its call when a call's own task_id names it", () => {
    const made = created(ask(ask(NO_SUBAGENTS, "call_1").state, "call_2").state, "ses_child").state;
    const step = onRootToolPart(made, resumePart("call_2", "ses_child"), rootCtx);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_child" }, ABORTED_LOG]);
    expect(step.drafts).toEqual([]);
    expect(step.state.agents[0]).toMatchObject({ phase: "pending", stopRequested: true });
  });

  it("aborts a conversation nobody allowed again when a call names it", () => {
    const refused = created(NO_SUBAGENTS, "ses_sneaky").state;
    const step = onRootToolPart(refused, taskPart({ childSessionId: "ses_sneaky" }), rootCtx);
    expect(step.drafts).toEqual([]);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_sneaky" }, ABORTED_LOG]);
    expect(step.state.resumes).toEqual([{ callId: "call_1", agentId: "ses_sneaky" }]);
  });

  it("never aborts the run's own conversation, whatever a call names", () => {
    const allowed = ask(NO_SUBAGENTS, "call_1").state;
    const step = onRootToolPart(allowed, resumePart("call_1", ROOT), rootCtx);
    expect(step).toEqual({ state: allowed, drafts: [], effects: [] });
    // Before the run's conversation is known, any conversation named could be it.
    const early = onRootToolPart(allowed, resumePart("call_1", "ses_earlier"), {
      ...rootCtx,
      rootConversation: null,
    });
    expect(early).toEqual({ state: allowed, drafts: [], effects: [] });
  });

  it("has nothing to abort once the call has settled", () => {
    const allowed = endedThenAllowed();
    const step = onRootToolPart(
      allowed,
      resumePart("call_2", "ses_child", { status: "completed", output: "late" }),
      rootCtx,
    );
    expect(step.drafts).toEqual([]);
    expect(step.effects).toEqual([]);
    expect(step.state.allowed).toEqual([]);
    expect(step.state.started).toBe(2);
  });

  it("aborts a conversation it has no room to remember, each time its call says so", () => {
    let state = NO_SUBAGENTS;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN * 2; index += 1) {
      state = created(state, `ses_${index}`).state;
    }
    const allowed = ask(state, "call_1").state;
    const step = onRootToolPart(allowed, resumePart("call_1", "ses_earlier"), rootCtx);
    expect(step.effects).toEqual([{ kind: "abort", agentId: "ses_earlier" }, ABORTED_LOG]);
    expect(step.state.agents).toHaveLength(MAX_SUBAGENTS_PER_RUN * 2);
    expect(step.state.resumes).toEqual([]);
    expect(step.state.allowed).toEqual([]);
    const again = onRootToolPart(step.state, resumePart("call_1", "ses_earlier"), rootCtx);
    expect(again.effects).toEqual(step.effects);
  });

  it(`remembers at most ${MAX_SUBAGENTS_PER_RUN} refused calls at once`, () => {
    let state = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
    for (let index = 0; index < MAX_SUBAGENTS_PER_RUN + 2; index += 1) {
      state = onRootToolPart(state, resumePart(`call_r${index}`, "ses_child"), rootCtx).state;
    }
    expect(state.resumes).toHaveLength(MAX_SUBAGENTS_PER_RUN);
    expect(state.resumes.at(-1)).toEqual({
      callId: `call_r${MAX_SUBAGENTS_PER_RUN + 1}`,
      agentId: "ses_child",
    });
  });
});

describe("onChildEvent", () => {
  it("tags a subagent's rows with its id and counts its calls and tokens", () => {
    let state = announced();
    const events: RuntimeEvent[] = [
      { kind: "message_started", messageId: "msg_c", role: "assistant" },
      {
        kind: "tool_part",
        messageId: "msg_c",
        part: {
          ...taskPart({ callId: "call_ls", tool: "bash", status: "completed", output: "a" }),
        },
      },
      {
        kind: "message_completed",
        messageId: "msg_c",
        finish: "stop",
        usage: { input: 12, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        error: null,
      },
    ];
    const drafts = [];
    for (const event of events) {
      const step = onChildEvent(state, "ses_child", event, ctx());
      state = step.state;
      drafts.push(...step.drafts);
    }
    expect(
      drafts.every((entry) => (entry.payload as { agentId?: string }).agentId === "ses_child"),
    ).toBe(true);
    expect(state.agents[0]).toMatchObject({ toolCalls: 1, tokens: 19 });
  });

  it("closes only its own rows when it goes idle or fails, and drops its plan", () => {
    const opened = onChildEvent(
      announced(),
      "ses_child",
      { kind: "message_started", messageId: "msg_c", role: "assistant" },
      ctx(),
    ).state;
    const idle = onChildEvent(opened, "ses_child", { kind: "session_idle" }, ctx());
    expect(idle.drafts.map((entry) => entry.type)).toEqual(["message.completed"]);
    const failed = onChildEvent(
      opened,
      "ses_child",
      { kind: "session_error", name: "APIError", message: "boom", status: 400 },
      ctx(),
    );
    expect(failed.drafts.map((entry) => entry.type)).toEqual(["message.completed"]);
    const todos = onChildEvent(opened, "ses_child", { kind: "todos", items: [] }, ctx());
    expect(todos.state).toBe(opened);
  });

  it("drops events for an unknown, refused, or settled subagent", () => {
    const event: RuntimeEvent = { kind: "message_started", messageId: "m", role: "assistant" };
    expect(onChildEvent(NO_SUBAGENTS, "ses_x", event, ctx()).state).toBe(NO_SUBAGENTS);
    const refused = created(NO_SUBAGENTS, "ses_sneaky").state;
    expect(onChildEvent(refused, "ses_sneaky", event, ctx()).state).toBe(refused);
    const settled = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
    expect(onChildEvent(settled, "ses_child", event, ctx()).state).toBe(settled);
  });

  it(`holds at most ${MAX_HELD_DRAFTS} drafts before it is announced, counting the rest`, () => {
    let state = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;
    for (let index = 0; index < MAX_HELD_DRAFTS + 3; index += 1) {
      state = onChildEvent(
        state,
        "ses_child",
        { kind: "message_started", messageId: `msg_${index}`, role: "assistant" },
        ctx(),
      ).state;
    }
    expect(state.agents[0]?.held).toHaveLength(MAX_HELD_DRAFTS);
    expect(state.agents[0]?.droppedDrafts).toBe(3);
    // Said once, as a count and nothing of what was dropped, when it is announced.
    const step = onRootToolPart(state, taskPart({ childSessionId: "ses_child" }), rootCtx);
    expect(step.effects).toEqual([
      { kind: "log", line: "dropped 3 of a subagent's events held before it was announced" },
    ]);
    expect(step.drafts).toHaveLength(MAX_HELD_DRAFTS + 1);
    expect(
      onRootToolPart(step.state, taskPart({ childSessionId: "ses_child" }), rootCtx).effects,
    ).toEqual([]);
  });

  it("keeps the end of a held message whose streamed text filled the held drafts", () => {
    let state = created(ask(NO_SUBAGENTS, "call_1").state, "ses_child").state;
    const events: RuntimeEvent[] = [
      { kind: "message_started", messageId: "msg_c", role: "assistant" },
      ...Array.from(
        { length: MAX_HELD_DRAFTS + 5 },
        (_, index): RuntimeEvent => ({
          kind: "text_delta",
          messageId: "msg_c",
          partId: "prt_1",
          text: `${index} `,
        }),
      ),
      { kind: "message_completed", messageId: "msg_c", finish: "stop", usage: null, error: null },
    ];
    for (const event of events) {
      state = onChildEvent(state, "ses_child", event, ctx()).state;
    }
    const held = state.agents[0]?.held ?? [];
    expect(held).toHaveLength(MAX_HELD_DRAFTS);
    expect(held[0]?.type).toBe("message.started");
    // The row is closed: its end took the place of the newest streamed piece.
    expect(held.at(-1)?.type).toBe("message.completed");
    expect(state.agents[0]?.droppedDrafts).toBe(7);
  });
});

describe("holdDrafts", () => {
  const row = (type: string, id: string): Draft =>
    ({
      type,
      runId: "run_1",
      payload: type.startsWith("message.") ? { messageId: id } : { toolCallId: id },
    }) as unknown as Draft;
  const full = (type: string): Draft[] =>
    Array.from({ length: MAX_HELD_DRAFTS }, (_, index) => row(type, `row_${index}`));

  it("holds everything while there is room", () => {
    const kept = holdDrafts([row("message.started", "m")], [row("message.delta", "m")]);
    expect(kept.held.map((entry) => entry.type)).toEqual(["message.started", "message.delta"]);
    expect(kept.dropped).toBe(0);
  });

  it("drops a streamed piece that arrives when the held drafts are full", () => {
    const held = full("message.started");
    const kept = holdDrafts(held, [row("message.delta", "row_0"), row("tool.output", "call_x")]);
    expect(kept.held).toEqual(held);
    expect(kept.dropped).toBe(2);
  });

  it("gives the newest streamed piece's place to anything that is not one", () => {
    const held = [
      row("message.started", "m"),
      ...Array.from({ length: MAX_HELD_DRAFTS - 1 }, (_, index) => ({
        ...row("message.delta", "m"),
        payload: { messageId: "m", partIndex: index },
      })),
    ] as Draft[];
    const kept = holdDrafts(held, [row("tool.requested", "call_1"), row("tool.failed", "call_1")]);
    expect(kept.held).toHaveLength(MAX_HELD_DRAFTS);
    expect(kept.held.slice(-2).map((entry) => entry.type)).toEqual([
      "tool.requested",
      "tool.failed",
    ]);
    // The two newest pieces went, the oldest stayed.
    expect(kept.held.at(-3)?.payload).toMatchObject({ partIndex: MAX_HELD_DRAFTS - 4 });
    expect(kept.dropped).toBe(2);
  });

  it("keeps what ends a held row past the limit, and drops what starts a new one", () => {
    const held = full("tool.requested");
    const kept = holdDrafts(held, [
      row("tool.completed", "row_0"),
      row("tool.failed", "row_1"),
      row("message.started", "msg_new"),
      // Its start was dropped just above, so its end has no row to close.
      row("message.completed", "msg_new"),
      row("tool.started", "row_2"),
    ]);
    expect(kept.held.slice(MAX_HELD_DRAFTS).map((entry) => entry.type)).toEqual([
      "tool.completed",
      "tool.failed",
    ]);
    expect(kept.dropped).toBe(3);
  });

  it(`never holds more than twice ${MAX_HELD_DRAFTS}`, () => {
    const held = full("message.started");
    const ends = full("message.completed");
    const closed = holdDrafts(held, ends);
    expect(closed.held).toHaveLength(MAX_HELD_DRAFTS * 2);
    expect(closed.dropped).toBe(0);
    const more = holdDrafts(closed.held, [row("message.completed", "row_0")]);
    expect(more.held).toHaveLength(MAX_HELD_DRAFTS * 2);
    expect(more.dropped).toBe(1);
  });
});

describe("stopping", () => {
  it("aborts one running subagent once, and refuses one that is not running", () => {
    const first = onStopAsked(announced(), "ses_child");
    expect(first.accepted).toBe(true);
    expect(first.effects).toEqual([{ kind: "abort", agentId: "ses_child" }]);
    const second = onStopAsked(first.state, "ses_child");
    expect(second.accepted).toBe(true);
    expect(second.effects).toEqual([]);
    expect(onStopAsked(NO_SUBAGENTS, "ses_child").accepted).toBe(false);
    const settled = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
    expect(onStopAsked(settled, "ses_child").accepted).toBe(false);
  });

  it("asks again after an abort that failed: on a second stop, on wind-down, and when the run ends", () => {
    const stopped = onStopAsked(announced(), "ses_child").state;
    const failed = onAbortFailed(stopped, "ses_child");
    expect(failed.agents[0]?.stopRequested).toBe(false);
    const again = onStopAsked(failed, "ses_child");
    expect(again.accepted).toBe(true);
    expect(again.effects).toEqual([{ kind: "abort", agentId: "ses_child" }]);
    expect(onWindDown(failed).effects).toEqual([{ kind: "abort", agentId: "ses_child" }]);
    expect(onRunEnded(failed, { runId: "run_1", nowMs: 9_000 }).effects).toEqual([
      { kind: "abort", agentId: "ses_child" },
    ]);
    // A stop that did not go through is not what ended it.
    const ended = onRootToolPart(failed, taskPart({ status: "completed", output: "ok" }), rootCtx);
    expect(ended.drafts[0]?.payload).toMatchObject({ status: "completed" });
  });

  it("asks again for a refused conversation and a resumed one whose abort failed", () => {
    const sneaky = onAbortFailed(created(NO_SUBAGENTS, "ses_sneaky").state, "ses_sneaky");
    expect(sneaky.agents[0]).toMatchObject({ phase: "refused", stopRequested: false });
    expect(onWindDown(sneaky).effects).toEqual([{ kind: "abort", agentId: "ses_sneaky" }]);
    const resumed = onRootToolPart(
      endedThenAllowed(),
      resumePart("call_2", "ses_child"),
      rootCtx,
    ).state;
    // While the abort is on its way nothing asks twice.
    expect(onWindDown(resumed).effects).toEqual([]);
    const failed = onAbortFailed(resumed, "ses_child");
    expect(failed.agents[0]).toMatchObject({ phase: "settled", stopRequested: false });
    expect(onRunEnded(failed, { runId: "run_1", nowMs: 9_000 })).toEqual({
      drafts: [],
      effects: [{ kind: "abort", agentId: "ses_child" }],
    });
  });

  it("changes nothing when the failed abort was not a subagent's to retry", () => {
    const running = announced();
    // The run's own conversation, or one nobody tracks.
    expect(onAbortFailed(running, ROOT)).toBe(running);
    // No abort was on its way: a second failure for the same stop.
    expect(onAbortFailed(running, "ses_child")).toBe(running);
    // It ended in the meantime, so there is nothing left to stop.
    const stopped = onStopAsked(running, "ses_child").state;
    const ended = onRootToolPart(stopped, taskPart({ status: "error", error: "x" }), rootCtx).state;
    expect(onAbortFailed(ended, "ses_child")).toBe(ended);
  });

  it("winds every running subagent down and forgets unstarted slots", () => {
    const two = created(ask(announced(), "call_2").state, "ses_child_2").state;
    const withSlot = ask(two, "call_3").state;
    const wound = onWindDown(withSlot);
    expect(wound.effects).toEqual([
      { kind: "abort", agentId: "ses_child" },
      { kind: "abort", agentId: "ses_child_2" },
    ]);
    expect(wound.state.allowed).toEqual([]);
    expect(onWindDown(wound.state).effects).toEqual([]);
  });

  it("reports each announced subagent a finished run took with it, and aborts every live one", () => {
    const two = created(ask(announced(), "call_2").state, "ses_child_2").state;
    const ended = onRunEnded(two, { runId: "run_1", nowMs: 9_000 });
    expect(ended.drafts.map((entry) => entry.payload)).toEqual([
      {
        agentId: "ses_child",
        status: "cancelled",
        usage: { tokens: 0, toolCalls: 0, durationMs: 8_500 },
        resultSummary: null,
      },
    ]);
    expect(ended.effects).toEqual([
      { kind: "abort", agentId: "ses_child" },
      { kind: "abort", agentId: "ses_child_2" },
    ]);
    const stopped = onStopAsked(announced(), "ses_child").state;
    expect(onRunEnded(stopped, { runId: "run_1", nowMs: 9_000 }).effects).toEqual([]);
    const settled = onRootToolPart(announced(), taskPart({ status: "completed" }), rootCtx).state;
    expect(onRunEnded(settled, { runId: "run_1", nowMs: 9_000 })).toEqual({
      drafts: [],
      effects: [],
    });
  });
});

describe("helpers", () => {
  it("reads a task's result from its tag, else its whole output", () => {
    expect(taskResult("<task><task_result> ok </task_result></task>")).toBe("ok");
    expect(taskResult("  just text  ")).toBe("just text");
    expect(taskResult("</task_result> backwards <task_result>")).toBe(
      "</task_result> backwards <task_result>",
    );
    expect(taskResult("x".repeat(LIMITS.summaryTextChars + 5))).toHaveLength(
      LIMITS.summaryTextChars,
    );
  });

  it("tags only message and call drafts", () => {
    const plan = { type: "plan.created", runId: "run_1", payload: {} } as never;
    expect(tagDraft(plan, "ses_child")).toBe(plan);
  });
});
