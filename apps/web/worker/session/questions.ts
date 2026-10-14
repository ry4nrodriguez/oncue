// Questions the agent asks the user (records 04 and 12), as pure decisions.
// `object/question-gate.ts` reads the rows and performs them. A question has
// no deadline: it waits through an idle stop, and an answer given after the
// sandbox stopped resumes the run with the answers as its message.

import type { AskedQuestion, RunState } from "@oncue/protocol";
import { isTerminal, LIMITS } from "@oncue/protocol";
import { clip, quoted, RESUME_CONTEXT_LIMITS } from "./resume-context";

/** Questions admitted per run: the object's own bound on rows from an untrusted peer. */
export const MAX_QUESTIONS_PER_RUN = 10;

export type QuestionRefusal = "question_open" | "run_not_running" | "too_many_questions";

/** The run states a question may be asked in: the agent is working, perhaps also holding an approval. */
const ASKING_STATES: ReadonlySet<string> = new Set(["running", "waiting_for_approval"]);

export function judgeQuestion(input: {
  /** The event names the session's current run. */
  readonly runMatches: boolean;
  readonly runState: string | null;
  readonly openQuestionExists: boolean;
  readonly admittedThisRun: number;
}): { readonly kind: "admit" } | { readonly kind: "refuse"; readonly reason: QuestionRefusal } {
  if (!input.runMatches || input.runState === null || !ASKING_STATES.has(input.runState)) {
    return { kind: "refuse", reason: "run_not_running" };
  }
  if (input.openQuestionExists) {
    return { kind: "refuse", reason: "question_open" };
  }
  if (input.admittedThisRun >= MAX_QUESTIONS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_questions" };
  }
  return { kind: "admit" };
}

/** A second question while one waits is an honest race, not a broken bridge. */
export function isCountedQuestionRefusal(reason: QuestionRefusal): boolean {
  return reason !== "question_open";
}

/**
 * Why the object is sweeping: the bridge paused the run (its turn was aborted,
 * and the harness's call with it), or the planned replacement interrupted the
 * run to restart it on a new sandbox, where its harness's call no longer exists.
 */
export type QuestionSweepCause = "bridge_paused" | "sandbox_replaced";

/**
 * How an open question ends because of its run, or null while it stays open:
 * a run that ended, or one the bridge paused, ends it as `run_ended`; a run
 * the replacement interrupted ends it as `sandbox_replaced`, so the restarted
 * run's agent is told it went unanswered and can ask again. The idle stop's
 * own pause and a lost sandbox's interruption keep it open, so an answer can
 * resume the run.
 */
export function questionEnding(
  runState: RunState | null,
  cause: QuestionSweepCause | null,
): "run_ended" | "sandbox_replaced" | null {
  if (runState === null || isTerminal("run", runState)) {
    return "run_ended";
  }
  if (cause === "bridge_paused" && runState === "paused") {
    return "run_ended";
  }
  if (cause === "sandbox_replaced" && runState === "interrupted") {
    return "sandbox_replaced";
  }
  return null;
}

/** Whether an answer resumes the run on a new sandbox instead of reaching the waiting harness. */
export function answerResumes(runState: RunState | null): boolean {
  return runState === "paused" || runState === "interrupted";
}

/** Cuts text to `limit` characters in all, saying so. */
function capped(text: string, limit: number): string {
  const note = " [cut]";
  return text.length <= limit ? text : `${text.slice(0, limit - note.length)}${note}`;
}

/**
 * The message a resumed run starts with when the user answered after the
 * sandbox stopped: OnCue's words around the questions and the user's answers.
 * The agent's questions and the user's answers are quoted and clipped, as the
 * resume context quotes them, and the whole fits a message.
 */
export function answersMessage(
  questions: readonly AskedQuestion[],
  answers: readonly (readonly string[])[],
): string {
  const parts = questions.map((question, index) => {
    const given = answers[index] ?? [];
    const lines = [
      "You asked, quoted:",
      quoted(clip(question.text, RESUME_CONTEXT_LIMITS.questionChars)),
    ];
    if (given.length === 0) {
      lines.push("They skipped this question.");
    } else {
      lines.push("They answered, quoted:");
      lines.push(quoted(clip(given.join(", "), RESUME_CONTEXT_LIMITS.answerChars)));
    }
    return lines.join("\n");
  });
  return capped(`Answers to your questions:\n\n${parts.join("\n\n")}`, LIMITS.bodyTextChars);
}
