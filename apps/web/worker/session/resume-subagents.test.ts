// A resumed run's context and subagents (record 12): a subagent's own messages
// and calls are not the primary agent's turn, and each subagent the turn
// started is one quoted line saying how it ended and what it reported.

import type { EventType, ProtocolEvent } from "@oncue/protocol";
import { type EventOverrides, makeEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { composeResumeContext, RESUME_CONTEXT_LIMITS, type ResumeTurn } from "./resume-context";
import { foldReplay, REPLAY_READS, type ReplayRow } from "./resume-replay";

let sequence = 0;
function row<T extends EventType>(type: T, overrides: EventOverrides<T> = {}): ReplayRow {
  sequence += 1;
  const event = makeEvent(type, { eventId: `evt_${sequence}`, ...overrides }) as ProtocolEvent;
  return { sequence, runId: event.runId, event };
}

const queued = row("run.queued", {
  runId: "run_1",
  payload: { instruction: { messageId: "msg_a", text: "Map the repo", attachments: [] } },
});

describe("the resume replay and subagents", () => {
  it("reads both subagent event types, each bounded", () => {
    expect(REPLAY_READS.filter((read) => read.type.startsWith("agent."))).toEqual([
      { type: "agent.started", limit: 100 },
      { type: "agent.completed", limit: 100 },
    ]);
  });

  it("keeps a subagent's messages and calls out of the turn, and shows the subagent instead", () => {
    const fold = foldReplay({
      rows: [
        queued,
        row("agent.started", {
          runId: "run_1",
          payload: { agentId: "ses_a", description: "Find the retry budget", name: "explore" },
        }),
        row("tool.requested", {
          runId: "run_1",
          payload: { toolCallId: "call_child", title: "grep retry", agentId: "ses_a" },
        }),
        row("tool.completed", {
          runId: "run_1",
          payload: { toolCallId: "call_child", agentId: "ses_a" },
        }),
        row("message.completed", {
          runId: "run_1",
          payload: {
            messageId: "msg_child",
            role: "assistant",
            parts: [{ type: "text", text: "child words" }],
            agentId: "ses_a",
          },
        }),
        row("agent.completed", {
          runId: "run_1",
          payload: { agentId: "ses_a", status: "completed", resultSummary: "In src/retry.ts." },
        }),
        row("agent.started", {
          runId: "run_1",
          payload: { agentId: "ses_b", description: "Read the notes", name: "general" },
        }),
        // An end for a subagent this replay never saw started names nothing.
        row("agent.completed", { runId: "run_1", payload: { agentId: "ses_unseen" } }),
        row("message.completed", {
          runId: "run_1",
          payload: {
            messageId: "msg_parent",
            role: "assistant",
            parts: [{ type: "text", text: "The budget is in src/retry.ts." }],
          },
        }),
      ],
      promptMessageId: "msg_prompt",
    });
    const [turn] = fold.turns;
    expect(turn?.tools).toEqual([]);
    expect(turn?.finalMessage).toBe("The budget is in src/retry.ts.");
    expect(turn?.subagents).toEqual([
      {
        name: "explore",
        description: "Find the retry budget",
        status: "completed",
        result: "In src/retry.ts.",
      },
      { name: "general", description: "Read the notes", status: "running", result: null },
    ]);
  });

  it("keeps a turn whose only record is a subagent", () => {
    const fold = foldReplay({
      rows: [
        row("run.queued", {
          runId: "run_2",
          payload: {
            instruction: { messageId: "msg_prompt", text: "Continue", attachments: [] },
          },
        }),
        row("agent.started", { runId: "run_2", payload: { agentId: "ses_c" } }),
      ],
      promptMessageId: "msg_prompt",
    });
    expect(fold.turns).toHaveLength(1);
  });

  it("writes one quoted line per subagent, clips its report, and caps the lines", () => {
    const subagents = Array.from(
      { length: RESUME_CONTEXT_LIMITS.subagentsPerTurn + 2 },
      (_, i) => ({
        name: "explore",
        description: `Task ${i}\nwith a break`,
        status: i === 0 ? "running" : "failed",
        result: i === 1 ? "x".repeat(RESUME_CONTEXT_LIMITS.subagentResultChars + 5) : null,
      }),
    );
    const turn: ResumeTurn = {
      runId: "run_1",
      instruction: "Map the repo",
      checksOnly: false,
      steers: [],
      tools: [],
      filesChanged: [],
      checks: [],
      outcome: null,
      finalMessage: null,
      subagents,
    };
    const text = composeResumeContext({
      reason: "resume",
      repository: null,
      checkpoint: null,
      lostWork: null,
      turns: [turn],
      unreadEarlierTurns: 0,
      plan: null,
      policy: null,
      budgetChars: 64_000,
    });
    expect(text).toContain(
      "Subagents you started in this turn, quoted (name, how it ended: task, then what it reported):",
    );
    expect(text).toContain("> explore, stopped with the run: Task 0 with a break");
    expect(text).toContain(
      `> explore, failed: Task 1 with a break -> ${"x".repeat(RESUME_CONTEXT_LIMITS.subagentResultChars)} [cut at ${RESUME_CONTEXT_LIMITS.subagentResultChars} characters]`,
    );
    expect(text).toContain("2 more subagents in this turn are left out.");
    // A turn recorded before subagents existed has none to show.
    const plain = composeResumeContext({
      reason: "resume",
      repository: null,
      checkpoint: null,
      lostWork: null,
      turns: [{ ...turn, subagents: undefined } as unknown as ResumeTurn],
      unreadEarlierTurns: 0,
      plan: null,
      policy: null,
      budgetChars: 64_000,
    });
    expect(plain).not.toContain("Subagents you started");
    const one = composeResumeContext({
      reason: "resume",
      repository: null,
      checkpoint: null,
      lostWork: null,
      turns: [{ ...turn, subagents: subagents.slice(1, 2) }],
      unreadEarlierTurns: 0,
      plan: null,
      policy: null,
      budgetChars: 64_000,
    });
    expect(one).toContain("> explore, failed: Task 1 with a break");
    expect(one).not.toContain("more subagents in this turn are left out");
  });
});
