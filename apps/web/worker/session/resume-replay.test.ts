import type { EventType, ProtocolEvent } from "@oncue/protocol";
import { type EventOverrides, makeEvent, testPlanStep } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  foldReplay,
  pathsIn,
  REPLAY_READS,
  RESUME_PROMPT_TEXT,
  type ReplayRow,
} from "./resume-replay";

let sequence = 0;
function row<T extends EventType>(type: T, overrides: EventOverrides<T> = {}): ReplayRow {
  sequence += 1;
  const event = makeEvent(type, { eventId: `evt_${sequence}`, ...overrides }) as ProtocolEvent;
  return { sequence, runId: event.runId, event };
}

function queued(runId: string, messageId: string, text: string, trigger = "initial"): ReplayRow {
  return row("run.queued", {
    runId,
    payload: {
      instruction: { messageId, text, attachments: [] },
      trigger: trigger as "initial",
    },
  });
}

function assistant(runId: string, text: string): ReplayRow {
  return row("message.completed", {
    runId,
    payload: {
      messageId: `msg_${sequence}`,
      role: "assistant",
      parts: [
        { type: "reasoning_summary", text: "Thinking." },
        { type: "text", text },
      ],
    },
  });
}

describe("foldReplay", () => {
  it("folds a session's runs into turns, in commit order, whatever order the reads returned", () => {
    const rows = [
      queued("run_1", "msg_a", "Fix the bug"),
      row("message.queued", {
        payload: {
          messageId: "msg_steer",
          text: "Use the helper",
          delivery: "steer_current_run",
          deliveredToRunId: "run_1",
        },
      }),
      row("tool.requested", {
        runId: "run_1",
        payload: {
          toolCallId: "call_1",
          title: "src/a.ts",
          runtimeName: "edit",
          category: "file_write",
          input: { filePath: "src/a.ts" },
        },
      }),
      row("tool.completed", { runId: "run_1", payload: { toolCallId: "call_1" } }),
      row("tool.requested", {
        runId: "run_1",
        payload: { toolCallId: "call_2", title: "", runtimeName: "bash", category: "shell" },
      }),
      row("tool.failed", { runId: "run_1", payload: { toolCallId: "call_2" } }),
      row("tool.requested", {
        runId: "run_1",
        payload: { toolCallId: "call_3", title: "npm test", category: "shell" },
      }),
      row("diff.updated", { runId: "run_1", payload: { scope: "session" } }),
      row("diff.updated", {
        runId: "run_1",
        payload: {
          scope: "turn",
          files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      }),
      row("verification.started", { runId: "run_1", payload: { checkId: "chk_1", name: "test" } }),
      row("verification.result", {
        runId: "run_1",
        payload: { checkId: "chk_1", result: "failed" },
      }),
      row("verification.result", {
        runId: "run_1",
        payload: { checkId: "chk_1", attempt: 2, result: "passed" },
      }),
      row("verification.result", {
        runId: "run_1",
        payload: { checkId: "chk_nameless", result: "skipped" },
      }),
      assistant("run_1", "Looking."),
      assistant("run_1", "Fixed it."),
      row("run.verified", { runId: "run_1" }),
      queued("run_2", "msg_b", "Now the docs", "follow_up"),
      assistant("run_2", "   "),
      row("run.failed", { runId: "run_2" }),
    ];
    const fold = foldReplay({ rows: [...rows].reverse(), promptMessageId: "msg_prompt" });
    expect(fold.unreadEarlierTurns).toBe(0);
    expect(fold.turns).toEqual([
      {
        runId: "run_1",
        instruction: "Fix the bug",
        checksOnly: false,
        steers: ["Use the helper"],
        tools: [
          { name: "src/a.ts", category: "file_write", outcome: "completed", paths: ["src/a.ts"] },
          { name: "bash", category: "shell", outcome: "failed", paths: [] },
          { name: "npm test", category: "shell", outcome: "unfinished", paths: [] },
        ],
        filesChanged: ["src/a.ts"],
        checks: [
          { name: "test", result: "passed" },
          { name: "chk_nameless", result: "skipped" },
        ],
        outcome: "verified",
        finalMessage: "Fixed it.",
      },
      {
        runId: "run_2",
        instruction: "Now the docs",
        checksOnly: false,
        steers: [],
        tools: [],
        filesChanged: [],
        checks: [],
        outcome: "failed",
        finalMessage: null,
      },
    ]);
  });

  it("leaves out the prompt's own instruction, OnCue's resume prompt, and a checks run's text", () => {
    const fold = foldReplay({
      rows: [
        queued("run_1", "msg_prompt", "Fix the bug"),
        row("tool.requested", { runId: "run_1", payload: { toolCallId: "c", title: "ls" } }),
        queued("run_2", "msg_resume", RESUME_PROMPT_TEXT),
        assistant("run_2", "Resumed."),
        queued("run_3", "msg_checks", "Run the checks", "checks_requested"),
        row("run.completed", { runId: "run_3" }),
        row("message.queued", {
          payload: {
            messageId: "msg_prompt",
            text: "Fix the bug",
            delivery: "steer_current_run",
            deliveredToRunId: "run_3",
          },
        }),
      ],
      promptMessageId: "msg_prompt",
    });
    expect(fold.turns.map((t) => [t.runId, t.instruction, t.checksOnly, t.steers])).toEqual([
      ["run_1", null, false, []],
      ["run_2", null, false, []],
      ["run_3", null, true, []],
    ]);
    expect(fold.turns[2]?.outcome).toBe("done, with no files changed");
  });

  it("drops turns with nothing to say, and the debug row of unmapped events", () => {
    const fold = foldReplay({
      rows: [
        queued("run_1", "msg_prompt", "Continue"),
        row("tool.requested", {
          runId: "run_1",
          payload: { toolCallId: "dbg", title: "Unmapped runtime events" },
        }),
        row("message.completed", {
          runId: "run_1",
          payload: { role: "system", parts: [{ type: "text", text: "system words" }] },
        }),
        // A row with no run, whatever its envelope says, starts no turn.
        { ...queued("run_x", "msg_x", "orphan"), runId: null },
        { ...assistant("run_1", "no run"), runId: null },
      ],
      promptMessageId: "msg_prompt",
    });
    expect(fold.turns).toEqual([]);
  });

  it("counts runs whose run.queued was not read, and shows none of their events", () => {
    const fold = foldReplay({
      rows: [
        assistant("run_old", "old words"),
        row("tool.completed", { runId: "run_old", payload: { toolCallId: "x" } }),
        row("run.verified", { runId: "run_older" }),
        row("message.queued", {
          payload: {
            messageId: "msg_s",
            text: "steer",
            delivery: "steer_current_run",
            deliveredToRunId: "run_oldest",
          },
        }),
        row("message.queued", {
          payload: {
            messageId: "msg_n",
            text: "next",
            delivery: "run_next",
            deliveredToRunId: null,
          },
        }),
        queued("run_new", "msg_new", "New task"),
      ],
      promptMessageId: "msg_prompt",
    });
    expect(fold.unreadEarlierTurns).toBe(3);
    expect(fold.turns.map((t) => t.runId)).toEqual(["run_new"]);
  });

  it("keeps the plan's last revision, marks it complete, and forgets a cancelled one", () => {
    const steps = [testPlanStep({ stepId: "s1", title: "Read", status: "complete" })];
    const created = row("plan.created", { payload: { steps } });
    const done = row("plan.completed");
    expect(foldReplay({ rows: [done, created], promptMessageId: "p" }).plan).toEqual({
      steps: [{ title: "Read", status: "complete" }],
      completed: true,
    });
    const updated = row("plan.updated", {
      payload: { steps: [testPlanStep({ stepId: "s2", title: "Fix", status: "active" })] },
    });
    expect(foldReplay({ rows: [created, done, updated], promptMessageId: "p" }).plan).toEqual({
      steps: [{ title: "Fix", status: "active" }],
      completed: false,
    });
    expect(
      foldReplay({ rows: [created, row("plan.cancelled")], promptMessageId: "p" }).plan,
    ).toBeNull();
    // A completion read without its plan names nothing.
    expect(foldReplay({ rows: [row("plan.completed")], promptMessageId: "p" }).plan).toBeNull();
  });

  it("keeps each question the agent asked in its run, with what the user answered", () => {
    const ask = (questionId: string) =>
      row("question.asked", {
        runId: "run_q",
        payload: {
          questionId,
          questions: [
            {
              id: "q1",
              header: "DB",
              text: "Which database?",
              options: [],
              multiple: false,
              allowOther: true,
            },
          ],
        },
      });
    const fold = foldReplay({
      rows: [
        queued("run_q", "msg_q", "Build it"),
        ask("qst_1"),
        row("question.answered", {
          runId: "run_q",
          payload: { questionId: "qst_1", answers: [["Postgres"]] },
        }),
        ask("qst_2"),
        row("question.dismissed", { runId: "run_q", payload: { questionId: "qst_2" } }),
        ask("qst_3"),
        // A settlement for a question this replay did not read changes nothing.
        row("question.answered", {
          runId: "run_q",
          payload: { questionId: "qst_unread", answers: [] },
        }),
        row("question.dismissed", { runId: "run_unread", payload: { questionId: "qst_x" } }),
      ],
      promptMessageId: "msg_prompt",
    });
    expect(fold.turns[0]?.questions).toEqual([
      { asked: ["Which database?"], answers: [["Postgres"]], outcome: "answered" },
      { asked: ["Which database?"], answers: null, outcome: "dismissed", dismissal: "user" },
      { asked: ["Which database?"], answers: null, outcome: "open" },
    ]);
    // A turn of only a question still has something to say.
    expect(
      foldReplay({
        rows: [queued("run_q", "msg_prompt", "asked"), ask("qst_9")],
        promptMessageId: "msg_prompt",
      }).turns,
    ).toHaveLength(1);
    expect(
      Object.hasOwn(
        foldReplay({ rows: [queued("run_n", "msg_n", "x")], promptMessageId: "p" }).turns[0] ?? {},
        "questions",
      ),
    ).toBe(false);
  });

  it("reads one event type per read, each bounded", () => {
    const types = REPLAY_READS.map((read) => read.type);
    expect(new Set(types).size).toBe(types.length);
    expect(REPLAY_READS.every((read) => read.limit > 0 && read.limit <= 1500)).toBe(true);
  });
});

describe("pathsIn", () => {
  it("finds paths under the keys harnesses use, and nothing else", () => {
    expect(pathsIn({ filePath: "a.ts", command: "ls" })).toEqual(["a.ts"]);
    expect(pathsIn({ file_path: "b.ts" })).toEqual(["b.ts"]);
    expect(pathsIn({ path: "c", paths: ["d", 3, ""], files: [] })).toEqual(["c", "d"]);
    expect(pathsIn({ path: "" })).toEqual([]);
    expect(pathsIn({ path: 7 })).toEqual([]);
    expect(pathsIn(["a"])).toEqual([]);
    expect(pathsIn(null)).toEqual([]);
    expect(pathsIn("a")).toEqual([]);
  });
});
