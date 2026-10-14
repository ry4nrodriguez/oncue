import { LIMITS } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  ASK_USER_TOOL_DEFINITION,
  alignAnswers,
  answerText,
  askUserQuestions,
  boundQuestions,
  DISMISSED_TEXTS,
  dismissedText,
  INITIAL_QUESTIONS,
  onQuestionAsked,
  onQuestionFrame,
  onQuestionRunEnded,
  onQuestionSettled,
  type QuestionsState,
  type RuntimeQuestion,
} from "./questions";

const DATABASE: RuntimeQuestion = {
  id: "q1",
  header: "Database",
  text: "Which database?",
  options: [
    { label: "Postgres", description: "Relational" },
    { label: "SQLite", description: "One file" },
  ],
  multiple: false,
  allowOther: true,
};

const ASK = { requestId: "que_1", callId: "call_1", questions: [DATABASE], askedCount: 1 };

function waitingOn(): QuestionsState {
  return onQuestionAsked(INITIAL_QUESTIONS, ASK, { runActive: true, newRef: () => "ref_1" }).state;
}

describe("boundQuestions", () => {
  it("keeps a well-formed question as it came", () => {
    expect(
      boundQuestions([
        {
          id: "q1",
          header: " Database ",
          text: "Which database?",
          options: DATABASE.options,
          multiple: false,
          allowOther: true,
        },
      ]),
    ).toEqual([DATABASE]);
  });

  it("is null with no question at all", () => {
    expect(boundQuestions([])).toBeNull();
  });

  it("keeps positions: a question with no text borrows its header, then its number", () => {
    const bound = boundQuestions([{ header: "Scope", text: "" }, { text: 7 }]) as RuntimeQuestion[];
    expect(bound.map((question) => [question.id, question.text, question.header])).toEqual([
      ["q1", "Scope", "Scope"],
      ["q2", "Question 2", "Question 2"],
    ]);
  });

  it("shows at most four questions and six choices, dropping blank and repeated labels", () => {
    const options = [
      { label: "", description: "blank" },
      "not an option",
      { label: "A", description: 3 },
      { label: "A", description: "again" },
      ...["B", "C", "D", "E", "F", "G"].map((label) => ({ label, description: label })),
    ];
    const bound = boundQuestions(
      Array.from({ length: 6 }, () => ({ text: "Pick", options, multiple: true })),
    ) as RuntimeQuestion[];
    expect(bound).toHaveLength(4);
    expect(bound[0]?.options.map((option) => option.label)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(bound[0]?.options[0]?.description).toBe("");
    expect(bound[0]?.multiple).toBe(true);
  });

  it("takes a typed answer when there is nothing to choose, and several only from several", () => {
    const [free, single] = boundQuestions([
      { text: "Anything else?", options: "none", allowOther: false, multiple: true },
      { text: "One?", options: [{ label: "Only" }], allowOther: false, multiple: true },
    ]) as RuntimeQuestion[];
    expect(free).toMatchObject({ options: [], allowOther: true, multiple: false });
    expect(single).toMatchObject({ allowOther: false, multiple: false });
  });

  it("cuts every field to the protocol's bounds", () => {
    const long = "x".repeat(LIMITS.summaryTextChars + 50);
    const [question] = boundQuestions([
      {
        id: "i".repeat(500),
        header: long,
        text: long,
        options: [{ label: long, description: long }],
      },
    ]) as RuntimeQuestion[];
    expect(question?.id).toHaveLength(LIMITS.idChars);
    expect(question?.header).toHaveLength(64);
    expect(question?.text).toHaveLength(LIMITS.summaryTextChars);
    expect(question?.options[0]?.label).toHaveLength(LIMITS.shortTextChars);
    expect(question?.options[0]?.description).toHaveLength(LIMITS.shortTextChars);
  });
});

describe("alignAnswers and answerText", () => {
  it("gives one list per question asked, skipping the missing and the unshown", () => {
    expect(alignAnswers(6, [["A"], [], ["x".repeat(LIMITS.summaryTextChars + 1)]])).toEqual([
      ["A"],
      [],
      ["x".repeat(LIMITS.summaryTextChars)],
      [],
      [],
      [],
    ]);
    expect(alignAnswers(1, [["1", "2", "3", "4", "5", "6", "7", "8"]])[0]).toHaveLength(7);
  });

  it("writes each question and its answer for a harness without its own shape", () => {
    expect(answerText([DATABASE, { ...DATABASE, text: "Which hosts?" }], [["Postgres"]])).toBe(
      "The user answered:\n\nWhich database?\nAnswer: Postgres\n\nWhich hosts?\nAnswer: (skipped)",
    );
  });
});

describe("askUserQuestions", () => {
  it("reads the tool's input into raw questions that always take a typed answer", () => {
    expect(
      askUserQuestions({
        questions: [{ header: "H", question: "Q?", options: [], multiple: true }, "junk"],
      }),
    ).toEqual([
      { header: "H", text: "Q?", options: [], multiple: true, allowOther: true },
      {
        header: undefined,
        text: undefined,
        options: undefined,
        multiple: undefined,
        allowOther: true,
      },
    ]);
    expect(askUserQuestions(null)).toEqual([]);
    expect(askUserQuestions({ questions: "no" })).toEqual([]);
  });

  it("offers the card's own bounds to the model", () => {
    expect(ASK_USER_TOOL_DEFINITION.inputSchema.properties.questions.maxItems).toBe(4);
  });
});

describe("the waiting question", () => {
  it("asks once while a run is active, under a fresh reference", () => {
    const step = onQuestionAsked(INITIAL_QUESTIONS, ASK, {
      runActive: true,
      newRef: () => "ref_1",
    });
    expect(step.state.waiting).toEqual({
      requestId: "que_1",
      ref: "ref_1",
      callId: "call_1",
      questions: [DATABASE],
      askedCount: 1,
    });
    expect(step.effects).toEqual([
      { kind: "emit_question", ref: "ref_1", callId: "call_1", questions: [DATABASE] },
    ]);
  });

  it("dismisses a question asked with no active run, and a second one while one waits", () => {
    const idle = onQuestionAsked(INITIAL_QUESTIONS, ASK, { runActive: false, newRef: () => "r" });
    expect(idle.state).toBe(INITIAL_QUESTIONS);
    expect(idle.effects[0]).toEqual({
      kind: "reply_question",
      requestId: "que_1",
      reply: { kind: "dismiss", reason: "no_run" },
    });
    const state = waitingOn();
    const second = onQuestionAsked(
      state,
      { ...ASK, requestId: "que_2" },
      {
        runActive: true,
        newRef: () => "ref_2",
      },
    );
    expect(second.state).toBe(state);
    expect(second.effects[0]).toEqual({
      kind: "reply_question",
      requestId: "que_2",
      reply: { kind: "dismiss", reason: "one_at_a_time" },
    });
  });

  it("dismisses a question a subagent asked, which never reaches the user", () => {
    const child = onQuestionAsked(INITIAL_QUESTIONS, ASK, {
      runActive: true,
      newRef: () => "r",
      fromSubagent: true,
    });
    expect(child.state).toBe(INITIAL_QUESTIONS);
    expect(child.effects[0]).toEqual({
      kind: "reply_question",
      requestId: "que_1",
      reply: { kind: "dismiss", reason: "from_subagent" },
    });
  });

  it("ignores the waiting question offered again, as a reconnected stream lists it", () => {
    const state = waitingOn();
    for (const runActive of [true, false]) {
      expect(onQuestionAsked(state, ASK, { runActive, newRef: () => "ref_again" })).toEqual({
        state,
        effects: [],
      });
    }
  });

  it("says why a question ended unanswered, so a second ask is not taken for the user's choice", () => {
    expect(dismissedText({ kind: "dismiss", reason: "dismissed" })).toBe(
      "The user dismissed the question.",
    );
    expect(dismissedText({ kind: "dismiss", reason: "one_at_a_time" })).toBe(
      "Only one question can wait at a time; ask again after the first is answered.",
    );
    const texts = Object.values(DISMISSED_TEXTS);
    expect(new Set(texts).size).toBe(texts.length);
    expect(dismissedText({ kind: "dismiss", reason: "no_run" })).not.toBe(
      DISMISSED_TEXTS.dismissed,
    );
  });

  it("answers in order on the object's answer, and dismisses on a dismissal or refusal", () => {
    const answered = onQuestionFrame(waitingOn(), {
      requestRef: "ref_1",
      outcome: "answered",
      answers: [["SQLite"]],
    });
    expect(answered.state.waiting).toBeNull();
    expect(answered.effects).toEqual([
      {
        kind: "reply_question",
        requestId: "que_1",
        reply: { kind: "answer", answers: [["SQLite"]] },
      },
    ]);
    expect(
      onQuestionFrame(waitingOn(), { requestRef: "ref_1", outcome: "answered", answers: null })
        .effects[0],
    ).toEqual({
      kind: "reply_question",
      requestId: "que_1",
      reply: { kind: "answer", answers: [[]] },
    });
    for (const outcome of ["dismissed", "refused"] as const) {
      expect(
        onQuestionFrame(waitingOn(), { requestRef: "ref_1", outcome, answers: null }).effects,
      ).toEqual([
        {
          kind: "reply_question",
          requestId: "que_1",
          reply: { kind: "dismiss", reason: outcome },
        },
      ]);
    }
  });

  it("logs a frame for a question it is not waiting on", () => {
    for (const state of [INITIAL_QUESTIONS, waitingOn()]) {
      const step = onQuestionFrame(state, {
        requestRef: "ref_other",
        outcome: "dismissed",
        answers: null,
      });
      expect(step.state).toBe(state);
      expect(step.effects[0]?.kind).toBe("log");
    }
  });

  it("forgets a question the harness settled itself, and only that one", () => {
    expect(onQuestionSettled(waitingOn(), "que_1").state.waiting).toBeNull();
    const state = waitingOn();
    expect(onQuestionSettled(state, "que_other")).toEqual({ state, effects: [] });
    expect(onQuestionSettled(INITIAL_QUESTIONS, "que_1").effects).toEqual([]);
  });

  it("dismisses the waiting question when its run ends, and does nothing with none", () => {
    expect(onQuestionRunEnded(waitingOn()).effects).toEqual([
      {
        kind: "reply_question",
        requestId: "que_1",
        reply: { kind: "dismiss", reason: "run_ended" },
      },
    ]);
    expect(onQuestionRunEnded(INITIAL_QUESTIONS)).toEqual({
      state: INITIAL_QUESTIONS,
      effects: [],
    });
  });
});
