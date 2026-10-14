/**
 * The timeline row for one verification check: name, state in words, time,
 * and a chevron when there is output. Only a failure is coloured. "Full
 * output" downloads the latest attempt's log.
 */
import type { CheckView, SessionView } from "@oncue/protocol";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/features/session/actions";
import { cn } from "@/lib/utils";
import { type CheckDisplayState, checkDisplayState } from "./check-display";
import { CHECK_STATE_WORDS } from "./outcomes";
import { checkStateClass, FullOutputLink } from "./TestsView";

export function CheckRow({
  view,
  checkId,
  sessionId,
}: {
  view: SessionView;
  checkId: CheckView["checkId"];
  sessionId: string | null;
}) {
  const check = view.verification.checks.get(checkId);
  const latest = check?.latest?.result ?? null;
  const runEnded = check !== undefined && view.runs.get(check.runId)?.outcome != null;
  // A row drawn before `verification.started` has folded reads as running.
  const state: CheckDisplayState =
    check === undefined ? "running" : checkDisplayState(check, runEnded);
  const name = check?.name ?? checkId;
  const line = (
    <>
      <span className="min-w-0 truncate text-text">{name}</span>
      <span className="shrink-0 text-faint">·</span>
      <span
        className={cn("shrink-0", checkStateClass(state), state === "running" ? "shimmer" : "")}
      >
        {CHECK_STATE_WORDS[state]}
      </span>
      {latest === null ? null : (
        <>
          <span className="shrink-0 text-faint">·</span>
          <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
            {formatDuration(latest.durationMs)}
          </span>
        </>
      )}
    </>
  );
  const summary = latest?.summary ?? "";
  if (summary.length === 0) {
    return (
      <div
        data-testid="row-check"
        data-state={state}
        className="flex min-w-0 items-center gap-2 py-1.5 pl-1 text-[13px] text-muted-foreground"
      >
        {line}
        {latest === null || check === undefined ? null : (
          <span className="ml-auto shrink-0 text-[12px]">
            <FullOutputLink sessionId={sessionId} result={latest} describe={check.name} />
          </span>
        )}
      </div>
    );
  }
  return (
    <Collapsible data-testid="row-check" data-state={state}>
      <CollapsibleTrigger
        aria-label={`${name}, ${CHECK_STATE_WORDS[state]}`}
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-left text-[13px] text-muted-foreground hover:bg-hover"
      >
        {line}
        <ChevronDown
          className="ml-auto size-3 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 space-y-1.5 pl-1 text-[12px]">
          <pre
            data-testid="check-summary"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-2 font-mono text-[11px] text-text leading-5"
          >
            {summary}
          </pre>
          {latest === null || check === undefined ? null : (
            <FullOutputLink sessionId={sessionId} result={latest} describe={check.name} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
