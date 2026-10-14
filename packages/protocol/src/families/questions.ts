import { defineFamily } from "../define";
import {
  array,
  boolean,
  commandId,
  maxLength,
  minLength,
  nullable,
  picklist,
  pipe,
  questionId,
  shortText,
  strictObject,
  string,
  summaryText,
  toolCallId,
  userId,
} from "../schema";

/**
 * Bounds on what the agent may ask in one go. Four questions of up to six
 * choices each is what every supported harness's own question tool allows at
 * most, so nothing a harness accepts is cut.
 */
export const QUESTION_LIMITS = {
  questionsPerAsk: 4,
  optionsPerQuestion: 6,
  /** The choices plus one typed answer. */
  answersPerQuestion: 7,
} as const;

// The agent's words: text, never authority. Every field is bounded so four
// full questions stay well inside one event.
export const questionOption = strictObject({
  label: pipe(string(), minLength(1), maxLength(256)),
  description: shortText,
});

export const askedQuestion = strictObject({
  /** The harness's own key for the question, or its position; it names the answer. */
  id: pipe(string(), minLength(1), maxLength(128)),
  /** A few words for the collapsed card and the timeline. */
  header: shortText,
  text: summaryText,
  options: pipe(array(questionOption), maxLength(QUESTION_LIMITS.optionsPerQuestion)),
  multiple: boolean(),
  /** Whether the user may type an answer of their own. */
  allowOther: boolean(),
});

/** One question's answer: the chosen labels and any typed text, in order. Empty is skipped. */
export const questionAnswer = pipe(
  array(summaryText),
  maxLength(QUESTION_LIMITS.answersPerQuestion),
);

export const questionAnswers = pipe(
  array(questionAnswer),
  maxLength(QUESTION_LIMITS.questionsPerAsk),
);

export const QUESTION_EVENTS = defineFamily("questions", {
  // The agent asked through its harness's own question tool, which waits for
  // the answer. The object mints `questionId` and keeps the bridge's reference.
  "question.asked": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      questionId,
      toolCallId: nullable(toolCallId),
      questions: pipe(
        array(askedQuestion),
        minLength(1),
        maxLength(QUESTION_LIMITS.questionsPerAsk),
      ),
    }),
  },
  // Control-origin: only the user, on a socket the object verified, answers.
  "question.answered": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      questionId,
      /** One entry per question, in order. */
      answers: questionAnswers,
      decidedBy: userId,
      commandId,
    }),
  },
  // `user` is the card's dismiss, `message_sent` a message sent while the card
  // was open, and `run_paused` the user's pause. `run_ended` is the run ending
  // first and `sandbox_replaced` the planned replacement restarting the run;
  // neither names a user.
  "question.dismissed": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      questionId,
      reason: picklist(["user", "message_sent", "run_paused", "run_ended", "sandbox_replaced"]),
      decidedBy: nullable(userId),
      commandId: nullable(commandId),
    }),
  },
});
