/**
 * A run whose agent started three subagents, for the timeline's and the
 * Agents view's tests: one running a command, one that reported back, and one
 * that failed. Built from real committed events, so the components meet the
 * shapes the fold produces.
 */
import type { CommittedEvent, DurableEventType } from "@oncue/protocol";
import { type EventOverrides, makeCommittedEvent } from "@oncue/protocol/testing";

export const RUNNING_AGENT = "ses_running";
export const DONE_AGENT = "ses_done";
export const FAILED_AGENT = "ses_failed";

export const LONG_PROMPT = [
  "Research task, read-only. Do not comment on, review, or touch any pull request.",
  "",
  "Report on the recent pull requests in this repository:",
  ...Array.from(
    { length: 12 },
    (_, index) => `${index + 1}. Theme ${index + 1}: what changed and why.`,
  ),
  "",
  "Keep the report under about 1,200 words.",
].join("\n");

export function subagentFixtureEvents(
  base = "2026-10-04T12:00:00.000Z",
  options: {
    readonly runEnded?: boolean;
    /** The primary agent runs a command of its own while the last subagent works. */
    readonly primaryWorking?: boolean;
  } = {},
): CommittedEvent[] {
  let sequence = 0;
  const at = (seconds: number) => new Date(Date.parse(base) + seconds * 1000).toISOString();
  const events: CommittedEvent[] = [];
  const add = <T extends DurableEventType>(
    type: T,
    seconds: number,
    overrides: EventOverrides<T> = {},
  ) => {
    sequence += 1;
    events.push(
      makeCommittedEvent(
        type,
        { eventId: `evt_${sequence}`, occurredAt: at(seconds), ...overrides },
        { sessionSequence: sequence },
      ) as CommittedEvent,
    );
  };
  const task = (callId: string, description: string, seconds: number) => {
    add("tool.requested", seconds, {
      payload: {
        toolCallId: callId,
        category: "other",
        title: description,
        runtimeName: "task",
        input: { description, prompt: "…", subagent_type: "general" },
        inputComplete: true,
      },
    });
    add("tool.started", seconds, { payload: { toolCallId: callId } });
  };

  add("run.queued", 0);
  add("run.started", 1);
  add("message.queued", 0, {
    runId: null,
    payload: {
      messageId: "msg_user",
      text: "Use subagents to review the recent pull requests.",
      delivery: "steer_current_run",
      deliveredToRunId: "run_1",
    },
  });

  task("call_done", "Read the deployment notes", 2);
  add("agent.started", 2, {
    payload: {
      agentId: DONE_AGENT,
      parentToolCallId: "call_done",
      name: "explore",
      description: "Read the deployment notes",
      prompt: "Read docs/deploy.md and summarise the steps.",
    },
  });
  add("tool.requested", 3, {
    payload: {
      toolCallId: "call_done_read",
      category: "file_read",
      title: "docs/deploy.md",
      runtimeName: "read",
      agentId: DONE_AGENT,
    },
  });
  add("tool.completed", 4, { payload: { toolCallId: "call_done_read", agentId: DONE_AGENT } });
  add("message.completed", 5, {
    payload: {
      messageId: "msg_done",
      role: "assistant",
      parts: [{ type: "text", text: "Deploys run through `pnpm deploy:hosted`." }],
      stopReason: "end_turn",
      usage: { usedTokens: 900, maxTokens: 200_000, inputTokens: 800, outputTokens: 100 },
      agentId: DONE_AGENT,
    },
  });
  add("agent.completed", 6, {
    payload: {
      agentId: DONE_AGENT,
      status: "completed",
      usage: { tokens: 900, toolCalls: 1, durationMs: 4000 },
      resultSummary: "Deploys run through `pnpm deploy:hosted`; migrations go first.",
    },
  });
  add("tool.completed", 6, { payload: { toolCallId: "call_done" } });

  task("call_failed", "Check the flaky test", 7);
  add("agent.started", 7, {
    payload: {
      agentId: FAILED_AGENT,
      parentToolCallId: "call_failed",
      name: "general",
      description: "Check the flaky test",
      prompt: "Run the flaky test ten times.",
    },
  });
  add("agent.completed", 8, {
    payload: {
      agentId: FAILED_AGENT,
      status: "failed",
      usage: { tokens: 0, toolCalls: 0, durationMs: 1000 },
      resultSummary: "Subagent failed: the model refused the request.",
    },
  });
  add("tool.failed", 8, {
    payload: { toolCallId: "call_failed", errorText: "Subagent failed", category: "runtime_error" },
  });

  task("call_running", "Review recent pull requests", 9);
  add("agent.started", 9, {
    payload: {
      agentId: RUNNING_AGENT,
      parentToolCallId: "call_running",
      name: "general",
      description: "Review recent pull requests",
      prompt: LONG_PROMPT,
    },
  });
  add("message.completed", 10, {
    payload: {
      messageId: "msg_running_1",
      role: "assistant",
      parts: [{ type: "text", text: "Fetching the list first." }],
      stopReason: "tool_use",
      usage: { usedTokens: 67_500, maxTokens: 200_000, inputTokens: 67_000, outputTokens: 500 },
      agentId: RUNNING_AGENT,
    },
  });
  add("tool.requested", 11, {
    payload: {
      toolCallId: "call_running_bash",
      category: "shell",
      title: "gh pr list --state all",
      runtimeName: "bash",
      agentId: RUNNING_AGENT,
    },
  });
  add("tool.started", 11, { payload: { toolCallId: "call_running_bash", agentId: RUNNING_AGENT } });
  add("message.completed", 12, {
    payload: {
      messageId: "msg_parent",
      role: "assistant",
      parts: [
        { type: "text", text: "I started a subagent to go through the recent pull requests." },
      ],
      stopReason: "tool_use",
      usage: null,
    },
  });
  if (options.primaryWorking === true) {
    add("tool.requested", 13, {
      payload: {
        toolCallId: "call_primary",
        category: "shell",
        title: "pnpm test",
        runtimeName: "bash",
      },
    });
    add("tool.started", 13, { payload: { toolCallId: "call_primary" } });
  }
  if (options.runEnded === true) {
    add("run.cancelled", 20);
  }
  return events;
}
