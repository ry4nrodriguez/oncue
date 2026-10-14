/**
 * Questions the agent asks the user, on the bridge's side (records 04 and 12).
 * Every harness asks through its own channel (OpenCode's question tool, Claude
 * Code's AskUserQuestion, OnCue's tool for Codex, OnCue's Pi extension); each
 * adapter turns the ask into `question_asked` with the shared shape below and
 * answers through `RuntimeClient.replyQuestion`. This module is pure state that
 * `agent.ts` drives: one question waits at a time, the session object decides
 * whether it is shown, and the user's answer or dismissal comes back as a
 * `bridge.question` frame. Nothing here times out; the harness's call waits.
 *
 * The questions are the agent's words and untrusted: they are bounded here and
 * redacted with every other draft before they leave the sandbox.
 */

import { LIMITS, QUESTION_LIMITS } from "@oncue/protocol";

/** One question in the shape every adapter produces. */
export interface RuntimeQuestion {
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiple: boolean;
  readonly allowOther: boolean;
}

/** One question as a harness gave it, before bounding: any field may be missing or wrong. */
export interface RawQuestion {
  readonly id?: unknown;
  readonly header?: unknown;
  readonly text?: unknown;
  readonly options?: unknown;
  readonly multiple?: unknown;
  readonly allowOther?: unknown;
}

/**
 * Why a question ends unanswered: the user dismissed it (or the session object
 * did, for the user's message or pause), another was already waiting, no run
 * was active, the object refused it, its run ended, or a subagent asked it
 * (only the primary agent talks to the user, record 12).
 */
export type DismissReason =
  | "dismissed"
  | "one_at_a_time"
  | "no_run"
  | "refused"
  | "run_ended"
  | "from_subagent";

/** How a waiting question ends: the answers, one list per question in order, or a dismissal. */
export type QuestionReply =
  | { readonly kind: "answer"; readonly answers: readonly (readonly string[])[] }
  | { readonly kind: "dismiss"; readonly reason: DismissReason };

/** What the session object says became of a question (`bridge.question`). */
export type QuestionOutcome = "answered" | "dismissed" | "refused";

const ID_CHARS = LIMITS.idChars;
/** The few words the collapsed card shows. */
export const HEADER_CHARS = 64;

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/**
 * The shared shape from what a harness sent, bounded to the protocol's limits.
 * Questions keep their positions, because a harness reads answers by position:
 * one with no text borrows its header, and past the fourth they are not shown
 * (and answered as skipped). A choice with no label is dropped, as is a
 * repeated label, which would make an answer ambiguous; a question left with
 * no choices takes a typed answer. Null when there is no question at all.
 */
export function boundQuestions(raw: readonly RawQuestion[]): RuntimeQuestion[] | null {
  const questions: RuntimeQuestion[] = [];
  for (const [index, entry] of raw.slice(0, QUESTION_LIMITS.questionsPerAsk).entries()) {
    const body =
      text(entry.text, LIMITS.summaryTextChars) ||
      text(entry.header, LIMITS.summaryTextChars) ||
      `Question ${index + 1}`;
    const labels = new Set<string>();
    const options: { label: string; description: string }[] = [];
    for (const option of Array.isArray(entry.options) ? entry.options : []) {
      const record = typeof option === "object" && option !== null ? option : {};
      const label = text((record as Record<string, unknown>).label, LIMITS.shortTextChars);
      if (label === "" || labels.has(label)) {
        continue;
      }
      labels.add(label);
      options.push({
        label,
        description: text((record as Record<string, unknown>).description, LIMITS.shortTextChars),
      });
      if (options.length === QUESTION_LIMITS.optionsPerQuestion) {
        break;
      }
    }
    const id = text(entry.id, ID_CHARS);
    const header = text(entry.header, HEADER_CHARS);
    questions.push({
      id: id === "" ? `q${index + 1}` : id,
      header: header === "" ? body.slice(0, HEADER_CHARS) : header,
      text: body,
      options,
      multiple: entry.multiple === true && options.length > 1,
      allowOther: entry.allowOther !== false || options.length === 0,
    });
  }
  return questions.length === 0 ? null : questions;
}

/**
 * One list of answers per question the harness asked, in order: a missing
 * entry, or a question past the fourth that was never shown, is skipped, and
 * an entry is cut to the protocol's bounds. The object already checked the
 * shape; this keeps a harness from being handed a misaligned list.
 */
export function alignAnswers(
  askedCount: number,
  answers: readonly (readonly string[])[],
): string[][] {
  return Array.from({ length: askedCount }, (_, index) =>
    index < QUESTION_LIMITS.questionsPerAsk
      ? (answers[index] ?? [])
          .slice(0, QUESTION_LIMITS.answersPerQuestion)
          .map((answer) => answer.slice(0, LIMITS.summaryTextChars))
      : [],
  );
}

/**
 * What a harness without its own answer shape tells the model: each question
 * and what the user said, in plain lines.
 */
export function answerText(
  questions: readonly RuntimeQuestion[],
  answers: readonly (readonly string[])[],
): string {
  const lines = questions.map((question, index) => {
    const given = answers[index] ?? [];
    return `${question.text}\nAnswer: ${given.length === 0 ? "(skipped)" : given.join(", ")}`;
  });
  return `The user answered:\n\n${lines.join("\n\n")}`;
}

/**
 * What the model is told when its question ends unanswered, so a second ask
 * in parallel is not mistaken for the user's choice. OpenCode's reject takes
 * no text, so only the other harnesses say these words.
 */
export const DISMISSED_TEXTS: Readonly<Record<DismissReason, string>> = {
  dismissed: "The user dismissed the question.",
  one_at_a_time: "Only one question can wait at a time; ask again after the first is answered.",
  no_run: "The question was not shown to the user because no run is active.",
  refused: "OnCue did not show the question to the user; continue without the answer.",
  run_ended: "The run ended before the user answered.",
  from_subagent:
    "A subagent cannot ask the user. Finish with what you have and say what you could not settle.",
};

/** The words for a dismissal. */
export function dismissedText(reply: Extract<QuestionReply, { kind: "dismiss" }>): string {
  return DISMISSED_TEXTS[reply.reason];
}

/**
 * OnCue's own question tool, for a harness whose native one cannot reach the
 * user (Codex's refuses outside its plan mode; Pi has none). The same shape
 * the card shows, so nothing is lost in translation.
 */
export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_TOOL_DEFINITION = {
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user up to four questions before choosing between approaches, when the answer changes what you build and you cannot find it in the repository. Each question offers two to six short choices with a one-line description, and the user may also type their own answer. The run waits until the user answers or dismisses the card; the answer comes back as the tool's result. Do not ask for anything you can find out yourself, and never ask for a credential.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: QUESTION_LIMITS.questionsPerAsk,
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "A few words naming the question." },
            question: { type: "string", description: "The complete question." },
            options: {
              type: "array",
              maxItems: QUESTION_LIMITS.optionsPerQuestion,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "One to five words." },
                  description: { type: "string", description: "What choosing it means." },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiple: { type: "boolean", description: "Whether several choices may be chosen." },
          },
          required: ["header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
} as const;

/** `ask_user`'s input as raw questions; an unreadable call has none. */
export function askUserQuestions(args: unknown): RawQuestion[] {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const questions = Array.isArray(record.questions) ? record.questions : [];
  return questions.map((entry) => {
    const question =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    return {
      header: question.header,
      text: question.question,
      options: question.options,
      multiple: question.multiple,
      allowOther: true,
    };
  });
}

export interface WaitingQuestion {
  /** The harness's own id for the waiting call, which a reply names. */
  readonly requestId: string;
  /** The bridge's reference: what it sends as `questionId`, and what `bridge.question` echoes. */
  readonly ref: string;
  readonly callId: string | null;
  readonly questions: readonly RuntimeQuestion[];
  /** How many questions the harness asked, which can exceed what is shown. */
  readonly askedCount: number;
}

export interface QuestionsState {
  readonly waiting: WaitingQuestion | null;
}

export const INITIAL_QUESTIONS: QuestionsState = { waiting: null };

export type QuestionsEffect =
  | {
      readonly kind: "emit_question";
      readonly ref: string;
      readonly callId: string | null;
      readonly questions: readonly RuntimeQuestion[];
    }
  | { readonly kind: "reply_question"; readonly requestId: string; readonly reply: QuestionReply }
  | { readonly kind: "log"; readonly line: string };

export interface QuestionsStep {
  readonly state: QuestionsState;
  readonly effects: readonly QuestionsEffect[];
}

function dismiss(reason: DismissReason): QuestionReply {
  return { kind: "dismiss", reason };
}

export interface QuestionAskedContext {
  readonly runActive: boolean;
  readonly newRef: () => string;
  /** A conversation other than the primary agent's asked: a subagent, which never reaches the user. */
  readonly fromSubagent?: boolean;
}

/**
 * A harness is waiting on the user. One at a time, and only while a run is
 * active. The question already waiting, offered again (a stream that
 * reconnected lists what is pending), changes nothing.
 */
export function onQuestionAsked(
  state: QuestionsState,
  asked: {
    readonly requestId: string;
    readonly callId: string | null;
    readonly questions: readonly RuntimeQuestion[];
    readonly askedCount: number;
  },
  ctx: QuestionAskedContext,
): QuestionsStep {
  if (state.waiting !== null && state.waiting.requestId === asked.requestId) {
    return { state, effects: [] };
  }
  if (ctx.fromSubagent === true) {
    return {
      state,
      effects: [
        { kind: "reply_question", requestId: asked.requestId, reply: dismiss("from_subagent") },
        { kind: "log", line: "dismissed a question a subagent asked" },
      ],
    };
  }
  if (!ctx.runActive) {
    return {
      state,
      effects: [
        { kind: "reply_question", requestId: asked.requestId, reply: dismiss("no_run") },
        { kind: "log", line: "dismissed a question asked with no active run" },
      ],
    };
  }
  if (state.waiting !== null) {
    return {
      state,
      effects: [
        { kind: "reply_question", requestId: asked.requestId, reply: dismiss("one_at_a_time") },
        { kind: "log", line: "dismissed a second question while one waits" },
      ],
    };
  }
  const ref = ctx.newRef();
  return {
    state: {
      waiting: {
        requestId: asked.requestId,
        ref,
        callId: asked.callId,
        questions: asked.questions,
        askedCount: Math.max(asked.askedCount, asked.questions.length),
      },
    },
    effects: [{ kind: "emit_question", ref, callId: asked.callId, questions: asked.questions }],
  };
}

/** The object's word on a question this bridge asked. */
export function onQuestionFrame(
  state: QuestionsState,
  frame: {
    readonly requestRef: string;
    readonly outcome: QuestionOutcome;
    readonly answers: readonly (readonly string[])[] | null;
  },
): QuestionsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.ref !== frame.requestRef) {
    return { state, effects: [{ kind: "log", line: "a question frame for no waiting question" }] };
  }
  const reply: QuestionReply =
    frame.outcome === "answered"
      ? { kind: "answer", answers: alignAnswers(waiting.askedCount, frame.answers ?? []) }
      : dismiss(frame.outcome === "refused" ? "refused" : "dismissed");
  return {
    state: { waiting: null },
    effects: [{ kind: "reply_question", requestId: waiting.requestId, reply }],
  };
}

/** The harness says the question was answered or withdrawn by someone other than this bridge. */
export function onQuestionSettled(state: QuestionsState, requestId: string): QuestionsStep {
  if (state.waiting === null || state.waiting.requestId !== requestId) {
    return { state, effects: [] };
  }
  return {
    state: { waiting: null },
    effects: [{ kind: "log", line: "the harness settled the waiting question itself" }],
  };
}

/** A run that ends takes its question with it, so the harness's call does not wait forever. */
export function onQuestionRunEnded(state: QuestionsState): QuestionsStep {
  if (state.waiting === null) {
    return { state, effects: [] };
  }
  return {
    state: { waiting: null },
    effects: [
      { kind: "reply_question", requestId: state.waiting.requestId, reply: dismiss("run_ended") },
    ],
  };
}
