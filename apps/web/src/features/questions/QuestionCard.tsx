/**
 * The agent's questions, one at a time, above the composer (record 13). The
 * user picks a choice (or several, or types their own), skips, or dismisses
 * the card; the last question's Submit sends one answer per question. Keys
 * work while focus is inside the expanded card: a number picks its row, ⌘↵ or
 * Ctrl+↵ goes on, and Escape folds the card to one line. Every string is the
 * agent's and renders as text.
 */

import type { AskedQuestion, QuestionView } from "@oncue/protocol";
import { Command, CornerDownLeft } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  DECISION_FOCUS,
  DECISION_PRIMARY,
  DECISION_ROW,
  DECISION_SECONDARY,
  DECISION_SELECTED,
  DecisionCard,
  KeyCap,
  OptionRow,
} from "@/components/decision/DecisionCard";
import { cn } from "@/lib/utils";

export type QuestionAnswer =
  | {
      readonly action: "answer";
      readonly questionId: string;
      /** One list per question, in order: the chosen labels, then any typed answer. */
      readonly answers: readonly (readonly string[])[];
    }
  | { readonly action: "dismiss"; readonly questionId: string };

/** What the user has done with one question so far. */
interface Draft {
  readonly chosen: readonly string[];
  readonly other: string;
}

const EMPTY: Draft = { chosen: [], other: "" };

/** One question's answer: the chosen labels in the card's order, then the typed text. */
export function answerOf(question: AskedQuestion, draft: Draft): string[] {
  const chosen = question.options
    .map((option) => option.label)
    .filter((label) => draft.chosen.includes(label));
  const other = question.allowOther ? draft.other.trim() : "";
  if (!question.multiple && other !== "") {
    return [other];
  }
  return other === "" ? chosen : [...chosen, other];
}

/**
 * A choice made: one replaces another, and choosing it again keeps it, as a
 * radio does whether clicked or picked by its number; several toggle.
 */
export function choose(question: AskedQuestion, draft: Draft, label: string): Draft {
  if (question.multiple) {
    return {
      ...draft,
      chosen: draft.chosen.includes(label)
        ? draft.chosen.filter((entry) => entry !== label)
        : [...draft.chosen, label],
    };
  }
  // A single choice clears a typed answer, which would otherwise win.
  return { chosen: [label], other: "" };
}

/** Typing an answer to a single choice deselects the row it replaces. */
export function typeOther(question: AskedQuestion, draft: Draft, other: string): Draft {
  return question.multiple ? { ...draft, other } : { chosen: [], other };
}

/** Whether the modifier that goes with ↵ is down: ⌘ on a Mac, Ctrl elsewhere; either is taken. */
function submitChord(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

/** What a screen reader hears, politely, when a question card opens. */
export function questionAnnouncement(question: QuestionView): string {
  const count = question.questions.length;
  const first = question.questions[0]?.header ?? "";
  return count === 1
    ? `The agent asked you a question: ${first}`
    : `The agent asked you ${count} questions, starting with: ${first}`;
}

export function QuestionCard({
  question,
  onAnswer,
  sending = false,
  onClosedWithFocus,
}: {
  question: QuestionView;
  /** Returns whether the answer left on the socket; the card stays until the object settles it. */
  onAnswer: (answer: QuestionAnswer) => boolean;
  /** An answer is on its way; the controls wait for it. */
  sending?: boolean;
  /** The card went away while focus was in it; the caller puts focus somewhere useful. */
  onClosedWithFocus?: (() => void) | undefined;
}) {
  const titleId = useId();
  const otherInputId = useId();
  const otherInput = useRef<HTMLInputElement | null>(null);
  const [index, setIndex] = useState(0);
  // The furthest question the user has reached; the forward arrow stops there,
  // so moving ahead still goes through Next or Skip.
  const [reached, setReached] = useState(0);
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => question.questions.map(() => EMPTY));
  const [collapsed, setCollapsed] = useState(false);
  const choices = useRef<HTMLFieldSetElement | null>(null);
  // Whether focus was in the card when it last moved: a control that went
  // disabled or away drops focus to the page, which still counts as in it.
  const focusInside = useRef(false);
  const closedWithFocus = useRef(onClosedWithFocus);
  closedWithFocus.current = onClosedWithFocus;
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (focusInside.current && (active === null || active === document.body)) {
        closedWithFocus.current?.();
      }
    },
    [],
  );
  const total = question.questions.length;
  const current = question.questions[index] as AskedQuestion;
  const draft = drafts[index] ?? EMPTY;
  const last = index === total - 1;

  // A key that moved to the next question took its focused row away with it;
  // focus goes to the new question's first row, never away from elsewhere.
  useEffect(() => {
    if (index > 0 && document.activeElement === document.body) {
      choices.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, [index]);

  const goTo = (target: number) => {
    setIndex(target);
    setReached((furthest) => Math.max(furthest, target));
  };

  const update = (next: Draft) =>
    setDrafts((all) => all.map((entry, at) => (at === index ? next : entry)));

  const submit = (finalDrafts: readonly Draft[]) => {
    onAnswer({
      action: "answer",
      questionId: question.questionId,
      answers: question.questions.map((asked, at) => answerOf(asked, finalDrafts[at] ?? EMPTY)),
    });
  };

  const next = () => {
    if (sending) {
      return;
    }
    if (last) {
      submit(drafts);
      return;
    }
    goTo(index + 1);
  };

  // A skipped question is sent empty, whatever was picked on it.
  const skip = () => {
    if (sending) {
      return;
    }
    const skipped = drafts.map((entry, at) => (at === index ? EMPTY : entry));
    setDrafts(skipped);
    if (last) {
      submit(skipped);
      return;
    }
    goTo(index + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A folded card shows no question, so nothing is answered from it.
    if (collapsed) {
      return;
    }
    if (submitChord(event)) {
      event.preventDefault();
      next();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCollapsed(true);
      return;
    }
    // Numbers pick only while focus is on the card itself, never while typing,
    // and a number held with a modifier is someone else's shortcut.
    const typing = event.target instanceof HTMLInputElement && event.target.type === "text";
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    if (typing || modified || !/^[1-9]$/.test(event.key)) {
      return;
    }
    const at = Number(event.key) - 1;
    const option = current.options[at];
    if (option !== undefined) {
      event.preventDefault();
      update(choose(current, draft, option.label));
    } else if (at === current.options.length && current.allowOther) {
      event.preventDefault();
      otherInput.current?.focus();
    }
  };

  const otherIndex = current.options.length + 1;
  const options = (
    <>
      {current.options.map((option, at) => (
        <OptionRow
          key={option.label}
          index={at + 1}
          name={`${titleId}-${index}`}
          label={option.label}
          description={option.description}
          selected={draft.chosen.includes(option.label)}
          multiple={current.multiple}
          onSelect={() => update(choose(current, draft, option.label))}
          testId="question-option"
        />
      ))}
      {current.allowOther ? (
        <div
          data-testid="question-other"
          className={cn(
            "rounded-xl border px-3 py-2",
            draft.other.trim() === "" ? DECISION_ROW : DECISION_SELECTED,
          )}
        >
          <div className="flex items-center gap-3">
            <label
              htmlFor={otherInputId}
              className="min-w-0 flex-1 text-[14px] text-text leading-5"
            >
              Other
            </label>
            <span aria-hidden="true" className="flex">
              <KeyCap>{otherIndex}</KeyCap>
            </span>
          </div>
          <input
            ref={otherInput}
            id={otherInputId}
            data-testid="question-other-input"
            type="text"
            value={draft.other}
            maxLength={4096}
            placeholder="Type your own answer here"
            onChange={(event) => update(typeOther(current, draft, event.target.value))}
            className={cn(
              "mt-2 h-9 w-full rounded-lg border border-border bg-canvas px-3 text-[14px] text-text placeholder:text-faint",
              DECISION_FOCUS,
            )}
          />
        </div>
      ) : null}
    </>
  );
  return (
    <DecisionCard
      testId="question-card"
      titleId={titleId}
      counter={total > 1 ? `${index + 1}/${total}` : undefined}
      counterLabel={total > 1 ? `Question ${index + 1} of ${total}` : undefined}
      navigation={
        total > 1
          ? {
              onPrevious: () => setIndex(Math.max(0, index - 1)),
              onNext: () => setIndex(Math.min(reached, index + 1)),
              canPrevious: index > 0 && !sending,
              canNext: index < reached && !sending,
            }
          : undefined
      }
      title={current.text}
      collapsed={collapsed}
      collapsedLabel={`Asking: ${current.header}`}
      onToggleCollapsed={() => setCollapsed(!collapsed)}
      onClose={() => onAnswer({ action: "dismiss", questionId: question.questionId })}
      closeLabel="Dismiss the questions"
      closeDisabled={sending}
      onFocusInside={(inside) => {
        focusInside.current = inside;
      }}
      onKeyDown={onKeyDown}
      footer={
        <>
          <button
            type="button"
            data-testid="question-skip"
            disabled={sending}
            onClick={skip}
            className={DECISION_SECONDARY}
          >
            Skip
          </button>
          <button
            type="button"
            data-testid="question-next"
            disabled={sending}
            onClick={next}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            className={DECISION_PRIMARY}
          >
            {last ? "Submit" : "Next"}
            <span className="flex items-center gap-0.5" aria-hidden="true">
              <KeyCap className="text-text">
                <Command className="size-3" />
              </KeyCap>
              <KeyCap className="text-text">
                <CornerDownLeft className="size-3" />
              </KeyCap>
            </span>
          </button>
        </>
      }
    >
      <fieldset ref={choices} className="flex flex-col gap-1" data-testid="question-options">
        <legend className="sr-only">{current.text}</legend>
        {options}
      </fieldset>
    </DecisionCard>
  );
}
