/**
 * The one row for everything OnCue does on the user's behalf: tool calls and
 * sandbox lifecycles share it so the timeline has a single vocabulary. It
 * composes `Collapsible` and `CodeBlock` directly because the vendored
 * `ai-elements` task and tool rows label by state adjective, which record 13
 * forbids. The header is a `CollapsibleTrigger` so an expandable row is a real
 * button with an accessible name, `aria-expanded`, and keyboard operation.
 */

import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import type { ActionMark } from "./actions";

// `requested` is separate from `running` so a call waiting on approval is not animated as running.

/**
 * Steps and output lines are append-only, so position is a stable key; text
 * can repeat and would not be.
 */
export function keyed<T>(
  items: readonly T[],
): readonly { readonly key: string; readonly item: T }[] {
  return items.map((item, position) => ({ key: String(position), item }));
}

export type ActionRowState = "requested" | "running" | "completed" | "failed";

export type ActionFact = { readonly label: string; readonly value: string };

/** One line of the sequence an action went through, in the event's own words. */
export type ActionStep = {
  readonly label: string;
  readonly detail: string | null;
  /** The offset from the first step, already formatted ("0s", "+2.4s"). */
  readonly offset: string;
  readonly state: ActionRowState;
};

export type ActionOutputLine = {
  /** A short tag for where the line came from, or null for a plain line. */
  readonly tag: string | null;
  readonly text: string;
};

export type ActionOutput = {
  readonly title: string;
  readonly lines: readonly ActionOutputLine[];
  // `tool.output` is ephemeral; the panel says when output is missing rather
  // than drawing an empty box.
  readonly dropped: boolean;
  /** Characters the sandbox cut to stay inside the protocol's inline limit; unlike `dropped`, the cause is size. */
  readonly cut?: number | null | undefined;
};

/**
 * Past this many lines the panel shows only the last ones, where a command says
 * how it ended. Bounds the DOM nodes a long log adds until the reader asks for more.
 */
export const OUTPUT_PREVIEW_LINES = 40;

export type ActionRowProps = {
  readonly mark: ActionMark;
  readonly label: string;
  readonly state: ActionRowState;
  // Readable without expanding; each failure category reads differently.
  readonly failure: { readonly summary: string; readonly tone: string } | null;
  /** The steps so far, oldest first. Empty for an action with a single step. */
  readonly steps: readonly ActionStep[];
  readonly facts: readonly ActionFact[];
  readonly input: unknown;
  readonly output: ActionOutput | null;
  readonly testId: string;
  /**
   * Whether the label shimmers. Unset, it follows `state === "running"`; a
   * sandbox passes its own, since for it running is the settled state.
   */
  readonly live?: boolean | undefined;
  /** A short fact beside the chevron, such as how long the call took. */
  readonly meta?: string | undefined;
  /** Keeps the output behind its own fold inside the expanded row (the sandbox's start-up log). */
  readonly foldOutput?: boolean | undefined;
};

// Part of the row's accessible name, so a screen reader hears the outcome.
const STATE_WORD: Record<ActionRowState, string> = {
  requested: "waiting to start",
  running: "running",
  completed: "completed",
  failed: "failed",
};

// `shimmer` (globals.css) drops the animation under reduced motion.
const STATE_LABEL_CLASS: Record<ActionRowState, string> = {
  requested: "text-muted-foreground",
  running: "text-text",
  completed: "text-text",
  failed: "text-text",
};

// Only a failed step is coloured, so it stands out in a long sequence.
const STEP_LABEL_CLASS: Record<ActionRowState, string> = {
  requested: "text-muted-foreground",
  running: "text-text",
  completed: "text-text",
  failed: TONE_TEXT_CLASS.danger,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      {children}
    </div>
  );
}

// A plain `pre`: terminal output is not a language, and highlighting would load shiki per row.
function OutputBlock({ output }: { output: ActionOutput }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, output.lines.length - OUTPUT_PREVIEW_LINES);
  const shown = hidden === 0 ? output.lines : output.lines.slice(hidden);
  const cut = output.cut ?? 0;
  return (
    <>
      {hidden === 0 ? null : (
        <button
          type="button"
          data-testid="action-output-show-all"
          onClick={() => setShowAll(true)}
          className="rounded-md text-[11px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          Show all {output.lines.length} lines ({hidden} earlier {hidden === 1 ? "line" : "lines"}{" "}
          hidden)
        </button>
      )}
      {shown.length === 0 ? null : (
        <pre
          data-testid="action-output"
          className="max-h-64 overflow-auto rounded-md border border-border-soft bg-surface p-2 font-mono text-[11px] text-text leading-5"
        >
          {keyed(shown).map(({ key, item: line }) => (
            <div key={key} className="flex gap-2">
              {line.tag === null ? null : (
                <span className="w-[72px] shrink-0 select-none text-faint">{line.tag}</span>
              )}
              <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
            </div>
          ))}
        </pre>
      )}
      {cut > 0 ? (
        <p className="text-[11px] text-faint" data-testid="action-output-cut">
          The sandbox kept the start of this output; the last {cut.toLocaleString("en-US")}{" "}
          {cut === 1 ? "character was" : "characters were"} too long to keep.
        </p>
      ) : null}
      {output.dropped ? (
        <p className={cn("text-[11px]", TONE_TEXT_CLASS.caution)}>
          Output is not replayed after a reconnect, so some or all of this call's output is no
          longer available.
        </p>
      ) : null}
    </>
  );
}

export function ActionRow({
  mark: Mark,
  label,
  state,
  failure,
  steps,
  facts,
  input,
  output,
  testId,
  live,
  meta,
  foldOutput = false,
}: ActionRowProps) {
  const [outputOpen, setOutputOpen] = useState(false);
  const accessibleName = `${label}, ${failure?.summary ?? STATE_WORD[state]}`;
  const inTransition = live ?? state === "running";
  return (
    <Collapsible className="w-full" data-testid={testId} data-state-kind={state}>
      <CollapsibleTrigger
        aria-label={accessibleName}
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-left text-[13px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        <Mark className="h-3.5 w-auto shrink-0 text-faint" />
        <span
          className={cn(
            "min-w-0 truncate",
            STATE_LABEL_CLASS[state],
            inTransition ? "shimmer" : "",
          )}
        >
          {label}
        </span>
        {failure === null ? null : (
          <span className={cn("shrink-0 text-[12px]", failure.tone)} data-testid="action-failure">
            {failure.summary}
          </span>
        )}
        {meta === undefined ? null : (
          <span
            className="ml-auto shrink-0 font-mono text-[11px] text-faint tabular-nums"
            data-testid="action-meta"
          >
            {meta}
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180",
            meta === undefined ? "ml-auto" : "",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        {/* Indented to the sentence's left edge so the details read as part of the row. */}
        <div
          className="mt-0.5 mb-2 space-y-3 pt-1 pr-2 pb-1 pl-[26px] text-[12px]"
          data-testid="action-panel"
        >
          {steps.length === 0 ? null : (
            <ol className="space-y-1" data-testid="action-steps">
              {keyed(steps).map(({ key, item: step }) => (
                <li key={key} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Mark className="h-3 w-auto shrink-0 text-faint" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={STEP_LABEL_CLASS[step.state]}>{step.label}</span>
                    {step.detail === null ? null : (
                      <span className="text-faint"> · {step.detail}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                    {step.offset}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {facts.length === 0 ? null : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {facts.map((fact) => (
                <div key={fact.label} className="contents">
                  <dt className="text-faint">{fact.label}</dt>
                  <dd className="min-w-0 break-words font-mono text-text">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {input === null || input === undefined ? null : (
            <Section title="Call">
              <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
            </Section>
          )}

          {output === null ? null : foldOutput ? (
            <Collapsible open={outputOpen} onOpenChange={setOutputOpen}>
              <CollapsibleTrigger
                data-testid="action-output-trigger"
                className="group flex w-full items-center gap-2 rounded-md py-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  {output.title}
                </span>
                <span className="text-[11px] text-faint">
                  · {output.lines.length} {output.lines.length === 1 ? "line" : "lines"}
                </span>
                <ChevronDown
                  className="ml-auto size-3 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              {outputOpen ? (
                <CollapsibleContent>
                  <div className="pt-1.5">
                    <OutputBlock output={output} />
                  </div>
                </CollapsibleContent>
              ) : (
                <div hidden>
                  <OutputBlock output={output} />
                </div>
              )}
            </Collapsible>
          ) : (
            <Section title={output.title}>
              <OutputBlock output={output} />
            </Section>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
