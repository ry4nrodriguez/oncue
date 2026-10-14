import { describe, expect, it } from "vitest";
import type { DurableEventType } from "./catalog";
import { parseEvent } from "./events";
import { LIMITS } from "./schema";
import { type EventOverrides, makeCommittedEvent, makeEvent } from "./testing";
import { agentStatusOf, applyEvent, emptyView, foldEvents } from "./view";

function committed<T extends DurableEventType>(
  type: T,
  sequence: number,
  overrides: EventOverrides<T> = {},
) {
  return makeCommittedEvent(
    type,
    { eventId: `evt_${sequence}`, ...overrides },
    {
      sessionSequence: sequence,
    },
  );
}

describe("the agents family", () => {
  it("parses a started and a completed subagent from the sandbox", () => {
    for (const type of ["agent.started", "agent.completed"] as const) {
      const result = parseEvent(makeEvent(type), "sandbox");
      expect(result.ok, type).toBe(true);
    }
  });

  it("refuses a subagent the control plane claims to have run", () => {
    const result = parseEvent(makeEvent("agent.started"), "control");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_origin");
    }
  });

  it("lets the control plane end a subagent its sandbox can no longer report", () => {
    const ended = makeEvent("agent.completed", {
      runtimeSequence: null,
      payload: { status: "cancelled", resultSummary: null },
    });
    expect(parseEvent(ended, "control").ok).toBe(true);
    // The sandbox's own still takes its place in the runtime sequence.
    const fromSandbox = parseEvent(ended, "sandbox");
    expect(fromSandbox.ok).toBe(false);
    if (!fromSandbox.ok) {
      expect(fromSandbox.reason).toBe("missing_runtime_sequence");
    }
  });

  it("allows only OpenCode's two built-in subagents by name", () => {
    const event = makeEvent("agent.started");
    const result = parseEvent(
      { ...event, payload: { ...event.payload, name: "repo-defined" } },
      "sandbox",
    );
    expect(result.ok).toBe(false);
  });

  it("bounds the prompt and the result to the summary limit", () => {
    const started = makeEvent("agent.started");
    const longPrompt = parseEvent(
      {
        ...started,
        payload: { ...started.payload, prompt: "x".repeat(LIMITS.summaryTextChars + 1) },
      },
      "sandbox",
    );
    expect(longPrompt.ok).toBe(false);
    const completed = makeEvent("agent.completed");
    const longResult = parseEvent(
      {
        ...completed,
        payload: { ...completed.payload, resultSummary: "y".repeat(LIMITS.summaryTextChars + 1) },
      },
      "sandbox",
    );
    expect(longResult.ok).toBe(false);
  });

  it("reads a stored message or call without an agent id as the primary agent's", () => {
    const view = foldEvents([
      committed("message.started", 1, { payload: { messageId: "msg_a", role: "assistant" } }),
      committed("tool.requested", 2, { payload: { toolCallId: "call_a" } }),
    ]);
    expect(view.timeline.map((item) => item.kind)).toEqual(["message", "tool"]);
    expect(view.agents.size).toBe(0);
  });
});

describe("folding subagents", () => {
  const started = committed("agent.started", 3, {
    payload: { agentId: "ses_child_1", parentToolCallId: "call_task" },
  });

  it("keeps a subagent's messages and calls on its own timeline", () => {
    const view = foldEvents([
      committed("tool.requested", 1, { payload: { toolCallId: "call_task", title: "task" } }),
      committed("message.started", 2, { payload: { messageId: "msg_parent", role: "assistant" } }),
      started,
      committed("message.started", 4, {
        payload: { messageId: "msg_child", role: "assistant", agentId: "ses_child_1" },
      }),
      committed("tool.requested", 5, {
        payload: { toolCallId: "call_child", agentId: "ses_child_1" },
      }),
      committed("message.completed", 6, {
        payload: {
          messageId: "msg_child_2",
          role: "assistant",
          parts: [{ type: "text", text: "found it" }],
          stopReason: "end_turn",
          usage: null,
          agentId: "ses_child_1",
        },
      }),
    ]);
    expect(view.timeline.map((item) => item.kind)).toEqual(["tool", "message"]);
    const agent = view.agents.get("ses_child_1" as never);
    expect(agent?.timeline.map((item) => item.kind)).toEqual(["message", "tool", "message"]);
    expect(agent?.parentToolCallId).toBe("call_task");
    expect(agent?.status).toBe("running");
    // The child's rows are still in the shared maps, so the same rows render them.
    expect(view.tools.get("call_child" as never)?.agentId).toBe("ses_child_1");
    expect(view.messages.get("msg_child" as never)?.agentId).toBe("ses_child_1");
    expect(view.tools.get("call_task" as never)).not.toHaveProperty("agentId");
    expect(view.messages.get("msg_parent" as never)).not.toHaveProperty("agentId");
    expect(view.messages.get("msg_child_2" as never)?.parts).toHaveLength(1);
  });

  it("records how a subagent ended", () => {
    const view = foldEvents([
      { ...started, sessionSequence: 1 } as never,
      committed("agent.completed", 2, {
        payload: {
          agentId: "ses_child_1",
          status: "failed",
          usage: { tokens: 10, toolCalls: 1, durationMs: 900 },
          resultSummary: "Subagent failed",
        },
      }),
    ]);
    const agent = view.agents.get("ses_child_1" as never);
    expect(agent?.status).toBe("failed");
    expect(agent?.usage?.toolCalls).toBe(1);
    expect(agent?.resultSummary).toBe("Subagent failed");
    expect(agent?.endedAt).not.toBeNull();
  });

  it("holds a subagent's rows that arrive before it is announced, then fills it in", () => {
    const early = foldEvents([
      committed("tool.requested", 1, {
        payload: { toolCallId: "call_child", agentId: "ses_child_1" },
      }),
    ]);
    expect(early.timeline).toHaveLength(0);
    expect(early.agents.get("ses_child_1" as never)?.parentToolCallId).toBeNull();
    const later = applyEvent(early, { ...started, sessionSequence: 2 } as never);
    const agent = later.agents.get("ses_child_1" as never);
    expect(agent?.parentToolCallId).toBe("call_task");
    expect(agent?.timeline).toHaveLength(1);
    expect(agent?.description).toBe("Find where the retry budget is defined");
  });

  it("an announcement or ending for an unseen subagent still makes its entry", () => {
    const view = foldEvents([
      committed("agent.completed", 1, { payload: { agentId: "ses_orphan", status: "cancelled" } }),
    ]);
    expect(view.agents.get("ses_orphan" as never)?.status).toBe("cancelled");
  });

  it("reads a subagent still running when its run ended as cancelled", () => {
    const queued = committed("run.queued", 1);
    const view = foldEvents([queued, { ...started, sessionSequence: 2 } as never]);
    const agent = view.agents.get("ses_child_1" as never);
    if (agent === undefined) {
      throw new Error("no agent");
    }
    expect(agentStatusOf(view, agent)).toBe("running");
    const ended = applyEvent(view, committed("run.cancelled", 3));
    expect(agentStatusOf(ended, agent)).toBe("cancelled");
    expect(agentStatusOf(emptyView(), { ...agent, status: "completed" })).toBe("completed");
    // A subagent whose run the view never saw is taken at its word.
    expect(agentStatusOf(emptyView(), agent)).toBe("running");
  });

  it("reads a subagent still running when its sandbox is gone as cancelled, though its run goes on", () => {
    const view = foldEvents([
      committed("run.queued", 1),
      committed("run.started", 2),
      { ...started, sessionSequence: 3 } as never,
    ]);
    const agent = view.agents.get("ses_child_1" as never);
    if (agent === undefined) {
      throw new Error("no agent");
    }
    expect(agent.sandboxGeneration).toBe(1);
    expect(agentStatusOf(view, agent)).toBe("running");
    // The sandbox was lost: nothing reports the subagent's end.
    const interrupted = applyEvent(view, committed("run.interrupted", 4));
    expect(agentStatusOf(interrupted, agent)).toBe("cancelled");
    // Continued on a new sandbox, the run is running again and the subagent is not.
    const continued = applyEvent(
      interrupted,
      committed("run.started", 5, { sandboxGeneration: 2 }),
    );
    expect(continued.runs.get(agent.runId)?.state).toBe("running");
    expect(agentStatusOf(continued, agent)).toBe("cancelled");
    // One the new sandbox starts in the same run is running.
    const again = applyEvent(
      continued,
      committed("agent.started", 6, {
        sandboxGeneration: 2,
        payload: { agentId: "ses_child_2", parentToolCallId: "call_task_2" },
      }),
    );
    const second = again.agents.get("ses_child_2" as never);
    expect(second?.sandboxGeneration).toBe(2);
    expect(second === undefined ? null : agentStatusOf(again, second)).toBe("running");
  });
});
