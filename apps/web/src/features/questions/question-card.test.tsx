import {
  type CommittedEvent,
  foldEvents,
  type QuestionView,
  type SessionView,
} from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Timeline, TimelineRow } from "@/features/session/Timeline";
import {
  answerOf,
  choose,
  type QuestionAnswer,
  QuestionCard,
  questionAnnouncement,
  typeOther,
} from "./QuestionCard";
import { answerWords, QuestionRow, questionHeadline } from "./QuestionRow";

afterEach(cleanup);

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const DATABASE = {
  id: "q1",
  header: "Database",
  text: "Which database should the service use?",
  options: [
    { label: "Postgres", description: "Relational, already in the stack" },
    { label: "SQLite", description: "" },
  ],
  multiple: false,
  allowOther: true,
};
const TARGETS = {
  id: "q2",
  header: "Targets",
  text: "Which targets?",
  options: [
    { label: "Web", description: "Browsers" },
    { label: "iOS", description: "Phones" },
    { label: "Android", description: "Phones" },
  ],
  multiple: true,
  allowOther: true,
};
const NAME = {
  id: "q3",
  header: "Name",
  text: "What is it called?",
  options: [],
  multiple: false,
  allowOther: true,
};

function questionView(
  questions: QuestionView["questions"],
  overrides: Partial<QuestionView> = {},
): QuestionView {
  return {
    questionId: "qst_1" as QuestionView["questionId"],
    runId: "run_1" as QuestionView["runId"],
    toolCallId: null,
    questions,
    state: "open",
    answers: null,
    dismissal: null,
    askedAt: "2026-10-04T12:00:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

function card(questions: QuestionView["questions"], sending = false) {
  const onAnswer = vi.fn<(answer: QuestionAnswer) => boolean>(() => true);
  const onClosedWithFocus = vi.fn();
  const result = render(
    <QuestionCard
      question={questionView(questions)}
      onAnswer={onAnswer}
      sending={sending}
      onClosedWithFocus={onClosedWithFocus}
    />,
  );
  return { onAnswer, onClosedWithFocus, ...result };
}

const options = () => screen.getAllByTestId("question-option");

describe("answerOf, choose, typeOther", () => {
  it("answers a single choice with the choice, or the typed answer that replaced it", () => {
    expect(answerOf(DATABASE, { chosen: ["SQLite"], other: "" })).toEqual(["SQLite"]);
    expect(answerOf(DATABASE, { chosen: [], other: "  DuckDB " })).toEqual(["DuckDB"]);
    expect(answerOf(DATABASE, { chosen: ["SQLite"], other: "DuckDB" })).toEqual(["DuckDB"]);
    expect(answerOf({ ...DATABASE, allowOther: false }, { chosen: [], other: "x" })).toEqual([]);
  });

  it("answers several in the card's order, then the typed answer", () => {
    expect(answerOf(TARGETS, { chosen: ["Android", "Web"], other: "Watch" })).toEqual([
      "Web",
      "Android",
      "Watch",
    ]);
  });

  it("replaces one choice with another, keeps one chosen again, toggles several, and clears a choice typed over", () => {
    expect(choose(DATABASE, { chosen: ["Postgres"], other: "x" }, "SQLite")).toEqual({
      chosen: ["SQLite"],
      other: "",
    });
    // As a radio: choosing the chosen one again keeps it.
    expect(choose(DATABASE, { chosen: ["SQLite"], other: "" }, "SQLite").chosen).toEqual([
      "SQLite",
    ]);
    expect(choose(TARGETS, { chosen: ["Web"], other: "y" }, "iOS")).toEqual({
      chosen: ["Web", "iOS"],
      other: "y",
    });
    expect(choose(TARGETS, { chosen: ["Web", "iOS"], other: "" }, "Web").chosen).toEqual(["iOS"]);
    expect(typeOther(DATABASE, { chosen: ["SQLite"], other: "" }, "D")).toEqual({
      chosen: [],
      other: "D",
    });
    expect(typeOther(TARGETS, { chosen: ["Web"], other: "" }, "D")).toEqual({
      chosen: ["Web"],
      other: "D",
    });
  });
});

describe("QuestionCard", () => {
  it("shows one question with its choices, key numbers, and a typed answer, and submits it", () => {
    const { onAnswer } = card([DATABASE]);
    const region = screen.getByRole("region", { name: DATABASE.text });
    // One question needs no counter, and the last question's action is Submit.
    expect(screen.queryByTestId("question-card-counter")).toBeNull();
    expect(screen.getByTestId("question-next").textContent).toContain("Submit");
    expect(options().map((row) => row.textContent)).toEqual([
      "PostgresRelational, already in the stack1",
      "SQLite2",
    ]);
    expect(within(region).getByText("3")).toBeTruthy();
    expect(screen.getByPlaceholderText("Type your own answer here")).toBeTruthy();
    // A radio is named by its label alone, described by its muted line; the
    // number key is for the eye only.
    expect(
      screen.getByRole("radio", {
        name: "Postgres",
        description: "Relational, already in the stack",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: "SQLite", description: "" })).toBeTruthy();
    expect(within(region).getByText("1").closest("[aria-hidden='true']")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    expect(options()[1]?.getAttribute("data-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("question-next"));
    expect(onAnswer).toHaveBeenCalledWith({
      action: "answer",
      questionId: "qst_1",
      answers: [["SQLite"]],
    });
  });

  it("walks several questions with a counter, Next, and Skip, and sends one answer each", () => {
    const { onAnswer } = card([DATABASE, TARGETS, NAME]);
    expect(screen.getByTestId("question-card-counter").textContent).toBe("1/3");
    // The pill is for the eye; a screen reader hears the position in words.
    expect(screen.getByTestId("question-card-counter").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Question 1 of 3").className).toContain("sr-only");
    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(screen.getByTestId("question-next"));

    expect(screen.getByTestId("question-card-counter").textContent).toBe("2/3");
    expect(screen.getByRole("heading").textContent).toBe("Which targets?");
    fireEvent.click(screen.getByRole("checkbox", { name: /Web/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Android/ }));
    expect(options().filter((row) => row.getAttribute("data-selected") === "true")).toHaveLength(2);
    fireEvent.change(screen.getByTestId("question-other-input"), {
      target: { value: "Watch" },
    });
    expect(screen.getByTestId("question-other").className).toContain("bg-surface");
    fireEvent.click(screen.getByTestId("question-next"));

    expect(screen.getByTestId("question-card-counter").textContent).toBe("3/3");
    // A question with nothing to choose is a typed answer alone; skipping it sends it empty.
    expect(screen.queryAllByTestId("question-option")).toHaveLength(0);
    fireEvent.change(screen.getByTestId("question-other-input"), { target: { value: "Ledger" } });
    fireEvent.click(screen.getByTestId("question-skip"));
    expect(onAnswer).toHaveBeenCalledWith({
      action: "answer",
      questionId: "qst_1",
      answers: [["Postgres"], ["Web", "Android", "Watch"], []],
    });
  });

  it("keeps focus in the card from question to question, and never takes it from elsewhere", () => {
    card([DATABASE, TARGETS, NAME]);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Enter", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getAllByRole("checkbox")[0]);
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    fireEvent.click(screen.getByTestId("question-next"));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("steps back and forward with the arrows, keeping each answer, never past the furthest reached", () => {
    const { onAnswer } = card([DATABASE, TARGETS, NAME]);
    const previous = () => screen.getByTestId("question-card-previous") as HTMLButtonElement;
    const forward = () => screen.getByTestId("question-card-forward") as HTMLButtonElement;
    expect(previous().disabled).toBe(true);
    expect(forward().disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(screen.getByTestId("question-next"));
    fireEvent.click(screen.getByRole("checkbox", { name: /iOS/ }));
    expect(forward().disabled).toBe(true);

    fireEvent.click(previous());
    expect(screen.getByTestId("question-card-counter").textContent).toBe("1/3");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Postgres/ }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));

    fireEvent.click(forward());
    expect(screen.getByTestId("question-card-counter").textContent).toBe("2/3");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /iOS/ }).checked).toBe(true);
    expect(forward().disabled).toBe(true);

    fireEvent.click(screen.getByTestId("question-next"));
    fireEvent.click(screen.getByTestId("question-next"));
    expect(onAnswer).toHaveBeenCalledWith({
      action: "answer",
      questionId: "qst_1",
      answers: [["SQLite"], ["iOS"], []],
    });
  });

  it("shows no arrows for a single question, and holds them while an answer is on its way", () => {
    card([DATABASE]);
    expect(screen.queryByTestId("question-card-previous")).toBeNull();
    cleanup();
    card([DATABASE, TARGETS], true);
    expect((screen.getByTestId("question-card-forward") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("question-card-previous") as HTMLButtonElement).disabled).toBe(true);
  });

  it("skips a middle question and forgets what was picked on it", () => {
    const { onAnswer } = card([TARGETS, DATABASE]);
    fireEvent.click(screen.getByRole("checkbox", { name: /iOS/ }));
    fireEvent.click(screen.getByTestId("question-skip"));
    expect(screen.getByTestId("question-card-counter").textContent).toBe("2/2");
    fireEvent.click(screen.getByTestId("question-next"));
    expect(onAnswer).toHaveBeenCalledWith({
      action: "answer",
      questionId: "qst_1",
      answers: [[], []],
    });
  });

  it("is answered from the keyboard: numbers pick, the next number types, ⌘↵ or Ctrl+↵ goes on", () => {
    const { onAnswer } = card([DATABASE, TARGETS]);
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "2" });
    expect(options()[1]?.getAttribute("data-selected")).toBe("true");
    // A number with no row, and a key that is not a number, do nothing.
    fireEvent.keyDown(region, { key: "9" });
    fireEvent.keyDown(region, { key: "a" });
    fireEvent.keyDown(region, { key: "Enter", ctrlKey: true });
    expect(screen.getByTestId("question-card-counter").textContent).toBe("2/2");

    fireEvent.keyDown(region, { key: "1" });
    fireEvent.keyDown(region, { key: "3" });
    // The Other row's number moves focus to its box; a number typed there is text.
    fireEvent.keyDown(region, { key: "4" });
    const input = screen.getByTestId("question-other-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "1" });
    expect(options()[0]?.getAttribute("data-selected")).toBe("true");
    // A picked row is a radio or a checkbox; a number key on it still picks.
    fireEvent.keyDown(screen.getByRole("checkbox", { name: /Web/ }), { key: "2" });
    // A number held with a modifier is another shortcut's, and picks nothing.
    for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
      fireEvent.keyDown(region, { key: "1", [modifier]: true });
    }
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onAnswer).toHaveBeenCalledWith({
      action: "answer",
      questionId: "qst_1",
      answers: [["SQLite"], ["Web", "iOS", "Android"]],
    });
  });

  it("keeps a chosen single choice whether it is clicked or picked by its number again", () => {
    card([DATABASE]);
    const region = screen.getByRole("region");
    fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
    fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
    expect(options()[1]?.getAttribute("data-selected")).toBe("true");
    fireEvent.keyDown(region, { key: "2" });
    expect(options()[1]?.getAttribute("data-selected")).toBe("true");
  });

  it("does nothing with the Other row's number when there is no typed answer", () => {
    card([{ ...DATABASE, allowOther: false }]);
    fireEvent.keyDown(screen.getByRole("region"), { key: "3" });
    expect(screen.queryByTestId("question-other-input")).toBeNull();
  });

  it("folds to one line on Escape or the chevron, and opens again, focus following", () => {
    const { onAnswer } = card([DATABASE]);
    screen.getByRole("radio", { name: "Postgres" }).focus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Postgres" }), { key: "Escape" });
    const region = screen.getByRole("region", { name: "Asking: Database" });
    expect(region.getAttribute("data-collapsed")).toBe("true");
    // The control that undoes the fold takes the focus the fold took away.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand" }));
    // Folded, the numbers pick nothing and ⌘↵ answers nothing.
    fireEvent.keyDown(region, { key: "1" });
    fireEvent.keyDown(region, { key: "Enter", metaKey: true });
    fireEvent.keyDown(region, { key: "Enter", ctrlKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse" }));
    expect(options()[0]?.getAttribute("data-selected")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByTestId("question-card").getAttribute("data-collapsed")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand" }));
  });

  it("never takes focus from elsewhere on the page when it folds", () => {
    card([DATABASE]);
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("dismisses on the ×, folded or not", () => {
    const { onAnswer } = card([DATABASE]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the questions" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ action: "dismiss", questionId: "qst_1" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByTestId("question-card").getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the questions" }));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith({ action: "dismiss", questionId: "qst_1" });
  });

  it("gives focus back when it closes with focus in it, and only then", () => {
    const first = card([DATABASE]);
    screen.getByRole("radio", { name: "Postgres" }).focus();
    first.unmount();
    expect(first.onClosedWithFocus).toHaveBeenCalledTimes(1);

    const second = card([DATABASE]);
    const outside = document.createElement("input");
    document.body.append(outside);
    screen.getByRole("radio", { name: "Postgres" }).focus();
    outside.focus();
    second.unmount();
    expect(second.onClosedWithFocus).not.toHaveBeenCalled();
    outside.remove();

    // Never focused at all: nothing to give back.
    const third = card([DATABASE]);
    third.unmount();
    expect(third.onClosedWithFocus).not.toHaveBeenCalled();
  });

  it("announces itself in words a screen reader reads", () => {
    expect(questionAnnouncement(questionView([DATABASE]))).toBe(
      "The agent asked you a question: Database",
    );
    expect(questionAnnouncement(questionView([DATABASE, TARGETS]))).toBe(
      "The agent asked you 2 questions, starting with: Database",
    );
    expect(questionAnnouncement(questionView([]))).toBe(
      "The agent asked you 0 questions, starting with: ",
    );
  });

  it("waits while an answer is on its way", () => {
    const { onAnswer } = card([DATABASE, TARGETS], true);
    expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("question-skip") as HTMLButtonElement).disabled).toBe(true);
    const close = screen.getByRole("button", {
      name: "Dismiss the questions",
    }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Enter", ctrlKey: true });
    expect(screen.getByTestId("question-card-counter").textContent).toBe("1/2");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

function fold(settle: "answered" | "dismissed" | "open", reason = "user") {
  const events: CommittedEvent[] = [
    makeCommittedEvent(
      "question.asked",
      { payload: { toolCallId: "call_q", questions: [DATABASE, TARGETS] } },
      { sessionSequence: 1 },
    ),
  ];
  if (settle === "answered") {
    events.push(
      makeCommittedEvent(
        "question.answered",
        { payload: { answers: [["Postgres"], []] } },
        { sessionSequence: 2 },
      ),
    );
  }
  if (settle === "dismissed") {
    events.push(
      makeCommittedEvent(
        "question.dismissed",
        { payload: { reason: reason as "user" } },
        { sessionSequence: 2 },
      ),
    );
  }
  return foldEvents(events);
}

function row(view: SessionView) {
  const item = view.timeline.find((entry) => entry.kind === "question");
  if (item === undefined) {
    throw new Error("no question row");
  }
  render(<TimelineRow view={view} item={item} />);
  return screen.getByTestId("row-question");
}

describe("QuestionRow", () => {
  it("reads Asking while the card waits, and opens to the questions", () => {
    const element = row(fold("open"));
    expect(element.getAttribute("data-state")).toBe("open");
    expect(element.textContent).toBe("Asking Database");
    fireEvent.click(screen.getByTestId("question-row-trigger"));
    expect(screen.getByTestId("question-row-items").textContent).toBe(
      "Which database should the service use?Which targets?",
    );
    expect(screen.queryAllByTestId("question-row-answer")).toHaveLength(0);
  });

  it("reads Asked once answered, and opens to each answer, a skipped one as skipped", () => {
    const element = row(fold("answered"));
    expect(element.textContent).toBe("Asked 2 questions");
    fireEvent.click(screen.getByTestId("question-row-trigger"));
    expect(screen.getAllByTestId("question-row-answer").map((line) => line.textContent)).toEqual([
      "Postgres",
      "Skipped",
    ]);
  });

  it.each([
    ["user", "Dismissed"],
    ["message_sent", "Dismissed: you sent a message instead"],
    ["run_paused", "Dismissed: you paused the run"],
    ["run_ended", "Not answered: the run ended"],
    ["sandbox_replaced", "Not answered: the sandbox was replaced"],
  ])("folds quietly, and opens to why a %s dismissal left it unanswered", (reason, words) => {
    expect(row(fold("dismissed", reason)).textContent).toBe("Asked 2 questions");
    fireEvent.click(screen.getByTestId("question-row-trigger"));
    expect(screen.getByTestId("question-row-dismissal").textContent).toBe(words);
    expect(screen.queryAllByTestId("question-row-answer")).toHaveLength(0);
  });

  it("draws nothing for a question the view does not hold, and words for one question", () => {
    const { container } = render(
      <QuestionRow view={fold("open")} questionId={"qst_other" as QuestionView["questionId"]} />,
    );
    expect(container.textContent).toBe("");
    const one = questionView([DATABASE], { state: "answered", answers: null });
    expect(questionHeadline(one)).toBe("Asked 1 question");
    expect(answerWords(one, 0)).toBe("Skipped");
    expect(questionHeadline(questionView([]))).toBe("Asking a question");
  });

  it("stands in for the asking call's own tool row on the timeline", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "tool.requested",
        { payload: { toolCallId: "call_q", runtimeName: "question", title: "question" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.requested",
        { payload: { toolCallId: "call_other", title: "pnpm test" } },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent(
        "question.asked",
        { payload: { toolCallId: "call_q", questions: [DATABASE] } },
        { sessionSequence: 3 },
      ),
    ]);
    render(<Timeline view={view} sessionId="sess_1" />);
    for (const trigger of screen.getAllByTestId("activity-trigger")) {
      fireEvent.click(trigger);
    }
    expect(screen.getAllByTestId("row-question")).toHaveLength(1);
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryByText("question")).toBeNull();
  });
});
