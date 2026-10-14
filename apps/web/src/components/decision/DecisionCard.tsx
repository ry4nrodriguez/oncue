/**
 * The frame and rows of a card that asks the user something above the
 * composer: the agent's questions now, and any later card that asks for a
 * choice (record 13). One bordered panel the composer's width, a header with
 * an optional counter, the title, collapse and close; a body of option rows;
 * and a footer of actions. Neutral throughout: no accent colour, so a
 * decision never looks like the composer's send.
 */

import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/** The ring every focusable part of a decision card draws: neutral, never the accent. */
export const DECISION_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-text/60 focus-visible:outline-offset-2";

/** A secondary action in the footer, such as Skip. */
export const DECISION_SECONDARY = cn(
  "flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-text disabled:opacity-60",
  DECISION_FOCUS,
);

/** The primary action in the footer, such as Next: filled, but neutral. */
export const DECISION_PRIMARY = cn(
  "flex h-8 items-center gap-2 rounded-lg border border-border bg-hover-strong px-3 font-medium text-[13px] text-text transition-colors hover:bg-hover disabled:opacity-60",
  DECISION_FOCUS,
);

/** A row's resting look: a light fill that keeps muted text at full contrast. */
export const DECISION_ROW = "border-transparent bg-surface hover:border-border";

/** A chosen row, or a typed answer that has words: the same fill and a firm edge. */
export const DECISION_SELECTED = "border-text/40 bg-surface";

/** A key on the keyboard, drawn small and bordered: a row's number, or ⌘ and ↵. */
export function KeyCap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border px-1 font-sans text-[11px] text-muted-foreground leading-none",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

const ICON_BUTTON = cn(
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-40",
  DECISION_FOCUS,
);

/** Stepping between the card's pages; the forward step goes only as far as the user has been. */
export interface DecisionNavigation {
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
}

export function DecisionCard({
  testId,
  titleId,
  title,
  counter,
  counterLabel,
  navigation,
  collapsed,
  collapsedLabel,
  onToggleCollapsed,
  onClose,
  closeLabel,
  closeDisabled = false,
  onKeyDown,
  onFocusInside,
  children,
  footer,
}: {
  testId: string;
  /** The heading's id; the card is labelled by it. */
  titleId: string;
  title: ReactNode;
  /** A short position such as "1/4", in a neutral pill before the title. */
  counter?: string | undefined;
  /** The counter in words for a screen reader, such as "Question 1 of 4". */
  counterLabel?: string | undefined;
  /** Previous and next arrows in the header, for a card with several pages. */
  navigation?: DecisionNavigation | undefined;
  collapsed: boolean;
  /** The one line a collapsed card shows. */
  collapsedLabel: ReactNode;
  onToggleCollapsed: () => void;
  /** Absent where the card cannot be closed. */
  onClose?: (() => void) | undefined;
  closeLabel?: string | undefined;
  /** The close waits, as while an answer is on its way. */
  closeDisabled?: boolean | undefined;
  onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  /**
   * Whether focus is in the card, told as it moves. Focus that falls to the
   * page, as when a control is disabled or removed under it, still counts.
   */
  onFocusInside?: ((inside: boolean) => void) | undefined;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const section = useRef<HTMLElement | null>(null);
  const expandButton = useRef<HTMLButtonElement | null>(null);
  const collapseButton = useRef<HTMLButtonElement | null>(null);
  const shownCollapsed = useRef(collapsed);
  // Folding swaps the header for one line, taking the focused control with
  // it; focus follows to the control that undoes the fold, but only when it
  // was in the card, never pulled from elsewhere on the page.
  useEffect(() => {
    if (shownCollapsed.current === collapsed) {
      return;
    }
    shownCollapsed.current = collapsed;
    const active = document.activeElement;
    if (active !== null && active !== document.body && !section.current?.contains(active)) {
      return;
    }
    (collapsed ? expandButton : collapseButton).current?.focus();
  }, [collapsed]);
  const close =
    onClose === undefined ? null : (
      <button
        type="button"
        aria-label={closeLabel ?? "Close"}
        data-testid={`${testId}-close`}
        disabled={closeDisabled}
        onClick={onClose}
        className={ICON_BUTTON}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    );
  return (
    <section
      ref={section}
      data-testid={testId}
      data-collapsed={collapsed ? "true" : "false"}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusInside?.(true)}
      onBlur={(event) => {
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) {
          onFocusInside?.(false);
        }
      }}
      className="rounded-2xl border border-border bg-composer"
    >
      {collapsed ? (
        <div className="flex items-center gap-2 py-2 pr-2 pl-4">
          <p id={titleId} className="min-w-0 flex-1 truncate text-[13px] text-text">
            {collapsedLabel}
          </p>
          <button
            ref={expandButton}
            type="button"
            aria-label="Expand"
            aria-expanded={false}
            data-testid={`${testId}-expand`}
            onClick={onToggleCollapsed}
            className={ICON_BUTTON}
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </button>
          {close}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2.5 pt-3 pr-2 pb-1 pl-4">
            {counter === undefined ? null : (
              <>
                <span
                  data-testid={`${testId}-counter`}
                  aria-hidden={counterLabel === undefined ? undefined : true}
                  className="mt-px shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-[12px] text-text tabular-nums"
                >
                  {counter}
                </span>
                {counterLabel === undefined ? null : (
                  <span className="sr-only">{counterLabel}</span>
                )}
              </>
            )}
            <h2
              id={titleId}
              className="min-w-0 flex-1 pt-0.5 font-medium text-[14px] text-text leading-5"
            >
              {title}
            </h2>
            {navigation === undefined ? null : (
              <>
                <button
                  type="button"
                  aria-label="Previous question"
                  data-testid={`${testId}-previous`}
                  disabled={!navigation.canPrevious}
                  onClick={navigation.onPrevious}
                  className={ICON_BUTTON}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next question"
                  data-testid={`${testId}-forward`}
                  disabled={!navigation.canNext}
                  onClick={navigation.onNext}
                  className={ICON_BUTTON}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </>
            )}
            <button
              ref={collapseButton}
              type="button"
              aria-label="Collapse"
              aria-expanded={true}
              data-testid={`${testId}-collapse`}
              onClick={onToggleCollapsed}
              className={ICON_BUTTON}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
            {close}
          </div>
          {/* The rows scroll and the header and footer stay, so a short
              window or a phone never pushes the actions off-screen. */}
          <div
            data-testid={`${testId}-body`}
            className="max-h-[min(40dvh,28rem)] overflow-y-auto px-2 py-1"
          >
            {children}
          </div>
          {footer === undefined ? null : (
            <div className="flex items-center justify-end gap-2 px-3 pt-1 pb-3">{footer}</div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One choice: its label, a muted line under it, and its number key on the
 * right. A native radio for one choice and a checkbox for several, hidden
 * behind the row, so a screen reader and the arrow keys treat it as one;
 * several show a check on each chosen row.
 */
export function OptionRow({
  index,
  name,
  label,
  description,
  selected,
  multiple,
  onSelect,
  testId,
}: {
  /** The row's position, from 1: its number key. */
  index: number;
  /** The group's name, shared by the rows of one question. */
  name: string;
  label: string;
  description: string;
  selected: boolean;
  multiple: boolean;
  onSelect: () => void;
  testId?: string | undefined;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <label
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-text/60 has-[:focus-visible]:outline-offset-2",
        // The fill keeps muted text at full contrast; a firm edge and a check mark the choice.
        selected ? DECISION_SELECTED : DECISION_ROW,
      )}
    >
      {/* Named by its label alone; the muted line describes it. */}
      <input
        type={multiple ? "checkbox" : "radio"}
        name={name}
        checked={selected}
        onChange={onSelect}
        aria-labelledby={labelId}
        aria-describedby={description === "" ? undefined : descriptionId}
        className="sr-only"
      />
      {multiple ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
            selected ? "border-text bg-text text-canvas" : "border-border",
          )}
        >
          {selected ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block break-words text-[14px] text-text leading-5">
          {label}
        </span>
        {description === "" ? null : (
          <span
            id={descriptionId}
            className="block truncate text-[13px] text-muted-foreground leading-5"
          >
            {description}
          </span>
        )}
      </span>
      {selected && !multiple ? (
        <Check className="size-4 shrink-0 text-text" aria-hidden="true" />
      ) : null}
      {/* The number is a hint for the eye; the radio is named by its label. */}
      <span aria-hidden="true" className="flex shrink-0">
        <KeyCap>{index}</KeyCap>
      </span>
    </label>
  );
}

/**
 * One answer that acts at once: the same look as an option row, but a button,
 * so arrow keys never answer by accident. Its number key is a hint the card's
 * own key handler acts on.
 */
export function ActionRow({
  index,
  label,
  description,
  onClick,
  disabled,
  testId,
}: {
  /** The row's position, from 1: its number key. */
  index: number;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  testId?: string | undefined;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      aria-keyshortcuts={String(index)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-60",
        DECISION_ROW,
        DECISION_FOCUS,
      )}
    >
      <span className="min-w-0 flex-1">
        <span id={labelId} data-label className="block break-words text-[14px] text-text leading-5">
          {label}
        </span>
        <span
          id={descriptionId}
          className="block truncate text-[13px] text-muted-foreground leading-5"
        >
          {description}
        </span>
      </span>
      <span aria-hidden="true" className="flex shrink-0">
        <KeyCap>{index}</KeyCap>
      </span>
    </button>
  );
}
