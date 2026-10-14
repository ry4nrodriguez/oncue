/**
 * A question on the timeline: one quiet folded row, "Asking Database" while
 * the card waits and "Asked 2 questions" once it is answered or dismissed,
 * that opens to each question and what the user said, or that it was
 * dismissed and why (record 13).
 */

import type { QuestionView, SessionView } from "@oncue/protocol";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const DISMISSAL_WORDS: Record<NonNullable<QuestionView["dismissal"]>, string> = {
  user: "Dismissed",
  message_sent: "Dismissed: you sent a message instead",
  run_paused: "Dismissed: you paused the run",
  run_ended: "Not answered: the run ended",
  sandbox_replaced: "Not answered: the sandbox was replaced",
};

/** The row's one line. */
export function questionHeadline(question: QuestionView): string {
  if (question.state === "open") {
    return `Asking ${question.questions[0]?.header ?? "a question"}`;
  }
  const count = question.questions.length;
  return `Asked ${count} ${count === 1 ? "question" : "questions"}`;
}

/** What the user said to one question, in words. */
export function answerWords(question: QuestionView, index: number): string | null {
  if (question.state !== "answered") {
    return null;
  }
  const given = question.answers?.[index] ?? [];
  return given.length === 0 ? "Skipped" : given.join(", ");
}

export function QuestionRow({
  view,
  questionId,
}: {
  view: SessionView;
  questionId: QuestionView["questionId"];
}) {
  const [open, setOpen] = useState(false);
  const question = view.questions.get(questionId);
  if (question === undefined) {
    return null;
  }
  const headline = questionHeadline(question);
  const dismissal = question.dismissal === null ? null : DISMISSAL_WORDS[question.dismissal];
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full"
      data-testid="row-question"
      data-state={question.state}
    >
      <CollapsibleTrigger
        data-testid="question-row-trigger"
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-left text-[13px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-text/60 focus-visible:outline-offset-2"
      >
        <span className="min-w-0 truncate text-muted-foreground">{headline}</span>
        <ChevronDown
          className="ml-auto size-3 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      {open ? (
        <CollapsibleContent>
          <div className="mt-0.5 mb-1 ml-2 space-y-2 border-border-soft border-l pl-3">
            <ol className="space-y-2" data-testid="question-row-items">
              {question.questions.map((asked, index) => {
                const words = answerWords(question, index);
                return (
                  // Questions keep their positions, so the index is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <li key={index} className="text-[13px]">
                    <p className="whitespace-pre-wrap break-words text-text">{asked.text}</p>
                    {words === null ? null : (
                      <p
                        className="whitespace-pre-wrap break-words text-muted-foreground"
                        data-testid="question-row-answer"
                      >
                        {words}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            {dismissal === null ? null : (
              <p className="text-[13px] text-muted-foreground" data-testid="question-row-dismissal">
                {dismissal}
              </p>
            )}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
