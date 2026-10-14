import { LIMITS, parseCommandPayload, QUESTION_LIMITS } from "@oncue/protocol";
import { testModelRecord } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  answerResumes,
  answersMessage,
  isCountedQuestionRefusal,
  judgeQuestion,
  MAX_QUESTIONS_PER_RUN,
  questionEnding,
} from "./questions";
import { RESUME_CONTEXT_LIMITS } from "./resume-context";

const ADMISSIBLE = {
  runMatches: true,
  runState: "running",
  openQuestionExists: false,
  admittedThisRun: 0,
};

describe("judgeQuestion", () => {
  it("admits a question from the running current run, also beside an open approval", () => {
    expect(judgeQuestion(ADMISSIBLE)).toEqual({ kind: "admit" });
    expect(judgeQuestion({ ...ADMISSIBLE, runState: "waiting_for_approval" })).toEqual({
      kind: "admit",
    });
  });

  it.each([
    [{ runMatches: false }, "run_not_running"],
    [{ runState: null }, "run_not_running"],
    [{ runState: "paused" }, "run_not_running"],
    [{ openQuestionExists: true }, "question_open"],
    [{ admittedThisRun: MAX_QUESTIONS_PER_RUN }, "too_many_questions"],
  ])("refuses %j as %s", (change, reason) => {
    expect(judgeQuestion({ ...ADMISSIBLE, ...change })).toEqual({ kind: "refuse", reason });
  });

  it("counts every refusal but an honest race with an open question", () => {
    expect(isCountedQuestionRefusal("question_open")).toBe(false);
    expect(isCountedQuestionRefusal("run_not_running")).toBe(true);
    expect(isCountedQuestionRefusal("too_many_questions")).toBe(true);
  });
});

describe("questionEnding and answerResumes", () => {
  it("ends a question with its run, or with a pause the bridge made, never an idle stop's", () => {
    expect(questionEnding(null, null)).toBe("run_ended");
    expect(questionEnding("cancelled", null)).toBe("run_ended");
    expect(questionEnding("completed", "sandbox_replaced")).toBe("run_ended");
    expect(questionEnding("paused", "bridge_paused")).toBe("run_ended");
    expect(questionEnding("paused", null)).toBeNull();
    expect(questionEnding("paused", "sandbox_replaced")).toBeNull();
    expect(questionEnding("running", "bridge_paused")).toBeNull();
  });

  it("ends one whose run the replacement restarts, but keeps one a lost sandbox interrupted", () => {
    expect(questionEnding("interrupted", "sandbox_replaced")).toBe("sandbox_replaced");
    expect(questionEnding("interrupted", null)).toBeNull();
    expect(questionEnding("interrupted", "bridge_paused")).toBeNull();
    expect(questionEnding("running", "sandbox_replaced")).toBeNull();
  });

  it("resumes only a run whose sandbox stopped", () => {
    expect(answerResumes("paused")).toBe(true);
    expect(answerResumes("interrupted")).toBe(true);
    expect(answerResumes("running")).toBe(false);
    expect(answerResumes(null)).toBe(false);
  });
});

describe("answersMessage", () => {
  const question = {
    id: "q1",
    header: "H",
    text: "Which?",
    options: [],
    multiple: true,
    allowOther: true,
  };

  it("quotes each question and the answer, and says a skipped one was skipped", () => {
    expect(
      answersMessage(
        [question, { ...question, text: "And?\nTwo lines" }, { ...question, text: "Last?" }],
        [["A", "B"], []],
      ),
    ).toBe(
      [
        "Answers to your questions:",
        "",
        "You asked, quoted:",
        "> Which?",
        "They answered, quoted:",
        "> A, B",
        "",
        "You asked, quoted:",
        "> And?",
        "> Two lines",
        "They skipped this question.",
        "",
        "You asked, quoted:",
        "> Last?",
        "They skipped this question.",
      ].join("\n"),
    );
  });

  it("stays a valid message for the largest questions and answers the protocol allows", () => {
    // Every character a line break, the worst case for quoting.
    const text = "\n".repeat(LIMITS.summaryTextChars);
    const questions = Array.from({ length: QUESTION_LIMITS.questionsPerAsk }, (_, index) => ({
      ...question,
      id: `q${index}`,
      text,
    }));
    const answers = questions.map(() =>
      Array.from({ length: QUESTION_LIMITS.answersPerQuestion }, () => text),
    );
    const message = answersMessage(questions, answers);

    expect(message.length).toBeLessThanOrEqual(LIMITS.bodyTextChars);
    // Each question and answer was clipped before it was quoted.
    const quotedLines = message.split("\n").filter((line) => line.startsWith(">"));
    expect(quotedLines.length).toBeLessThanOrEqual(
      QUESTION_LIMITS.questionsPerAsk *
        (RESUME_CONTEXT_LIMITS.questionChars + RESUME_CONTEXT_LIMITS.answerChars + 2),
    );
    // Nothing the agent or the user wrote stands as a line of OnCue's own.
    const own = new Set([
      "Answers to your questions:",
      "",
      "You asked, quoted:",
      "They answered, quoted:",
      "They skipped this question.",
    ]);
    for (const line of message.split("\n")) {
      expect(line.startsWith(">") || own.has(line)).toBe(true);
    }
    const parsed = parseCommandPayload("run.start", {
      instruction: { messageId: "msg_1", text: message, attachments: [] },
      model: testModelRecord(),
      continuesRunId: null,
    });
    expect(parsed.ok).toBe(true);
  });

  it("cuts the whole to one message's length", () => {
    const long = "x".repeat(LIMITS.bodyTextChars);
    const message = answersMessage(
      Array.from({ length: 40 }, () => ({ ...question, text: long })),
      [],
    );
    expect(message.length).toBe(LIMITS.bodyTextChars);
    expect(message.endsWith(" [cut]")).toBe(true);
  });
});
