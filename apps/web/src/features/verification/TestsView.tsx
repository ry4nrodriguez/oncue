/**
 * The review pane's Tests tab: one expandable row per check the run recorded.
 * The header shows the run's outcome separately from the checks, because the
 * control plane decides it and every check can pass without a verified run.
 * The output summary comes from the sandbox and is untrusted, so it renders as
 * a text node in a `<pre>`, never as markup.
 */
import type {
  CheckAttemptView,
  CheckClassification,
  CheckView,
  RunId,
  SessionView,
} from "@oncue/protocol";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/features/session/actions";
import { useArtifactDownload } from "@/features/session/artifact-download";
import { STATUS_LABELS } from "@/features/session/status";
import { type StatusTone, TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import { type CheckDisplayState, checkDisplayState } from "./check-display";
import { CHECK_STATE_WORDS, checksForRun, OUTCOME_TONE } from "./outcomes";

type AttemptResult = NonNullable<CheckAttemptView["result"]>;

/**
 * Only a failure is coloured. Everything else is text; the words carry it.
 * `faint` marks a state with nothing to report yet.
 */
export const CHECK_STATE_TONE: Record<CheckDisplayState, StatusTone | "plain"> = {
  pending: "faint",
  running: "faint",
  passed: "plain",
  failed: "danger",
  skipped: "plain",
  inconclusive: "plain",
  not_finished: "faint",
};

export function checkStateClass(state: CheckDisplayState): string {
  const tone = CHECK_STATE_TONE[state];
  return tone === "plain" ? "text-muted-foreground" : TONE_TEXT_CLASS[tone];
}

/** What a non-required check says about itself; a required one says nothing. */
export const CLASSIFICATION_LABELS: Record<CheckClassification, string | null> = {
  required: null,
  recommended: "recommended",
  informational: "informational",
};

export const BASE_COMPARISON_WORDS: Record<
  Exclude<AttemptResult["baseComparison"], "not_compared">,
  string
> = {
  new_failure: "New failure: it passes on the base revision.",
  reproduced_on_base: "Reproduced on base: it fails on the base revision too.",
  not_comparable: "Not comparable with the base revision.",
};

const SKIP_WORDS: Record<NonNullable<AttemptResult["skipReason"]>, string> = {
  not_applicable: "not applicable",
  user_requested: "skipped at your request",
  unavailable: "unavailable",
  could_not_run: "could not run",
  environment_failed: "the environment failed to set up",
};

const INCONCLUSIVE_WORDS: Record<NonNullable<AttemptResult["inconclusiveReason"]>, string> = {
  flaky: "flaky: passed only on a retry",
  timeout: "timed out",
  incomplete_evidence: "incomplete evidence",
  base_not_comparable: "base not comparable",
};

function resultWord(result: AttemptResult): string {
  const reason =
    result.skipReason !== null
      ? SKIP_WORDS[result.skipReason]
      : result.inconclusiveReason !== null
        ? INCONCLUSIVE_WORDS[result.inconclusiveReason]
        : null;
  return reason === null ? result.result : `${result.result} (${reason})`;
}

export function FullOutputLink({
  sessionId,
  result,
  describe,
}: {
  sessionId: string | null;
  result: AttemptResult;
  describe: string;
}) {
  const artifact = result.evidence[0];
  const { busy, unavailable, download } = useArtifactDownload(
    sessionId,
    artifact?.artifactId ?? "",
    artifact?.label ?? null,
  );
  if (artifact === undefined) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void download()}
        aria-label={`Full output for ${describe}`}
        data-testid="check-full-output"
        className="text-text underline underline-offset-2 hover:text-accent-text disabled:opacity-60"
      >
        Full output
      </button>
      {unavailable ? (
        <span role="status" data-testid="artifact-unavailable" className="text-danger">
          Artifact unavailable
        </span>
      ) : null}
    </span>
  );
}

function CheckItem({
  check,
  runEnded,
  sessionId,
}: {
  check: CheckView;
  runEnded: boolean;
  sessionId: string | null;
}) {
  const latest = check.latest?.result ?? null;
  const state = checkDisplayState(check, runEnded);
  const attempts = check.attempts;
  const classification =
    check.classification === null ? null : CLASSIFICATION_LABELS[check.classification];
  return (
    <li data-testid="tests-check" data-check-id={check.checkId} data-state={state}>
      <Collapsible>
        <CollapsibleTrigger
          aria-label={`${check.name}, ${CHECK_STATE_WORDS[state]}`}
          className="group flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-hover"
        >
          <span className="min-w-0 truncate text-text">{check.name}</span>
          {classification === null ? null : (
            <span className="shrink-0 text-[11px] text-faint" data-testid="check-classification">
              {classification}
            </span>
          )}
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
          {attempts.length > 1 ? (
            <span className="shrink-0 text-[11px] text-faint">{attempts.length} attempts</span>
          ) : null}
          <ChevronDown
            className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-3 pb-3 text-[12px] text-muted-foreground">
            {attempts.length > 1 ? (
              <ol className="space-y-0.5" data-testid="check-attempts">
                {attempts.map((attempt) => (
                  <li key={attempt.attempt} className="flex flex-wrap items-center gap-x-2">
                    <span className="text-text">Attempt {attempt.attempt}</span>
                    <span>{attempt.result === null ? "running" : resultWord(attempt.result)}</span>
                    {attempt.result === null ? null : (
                      <>
                        <span className="font-mono text-[11px] text-faint tabular-nums">
                          {formatDuration(attempt.result.durationMs)}
                        </span>
                        <FullOutputLink
                          sessionId={sessionId}
                          result={attempt.result}
                          describe={`${check.name}, attempt ${attempt.attempt}`}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ol>
            ) : latest === null ? null : (
              <p>{resultWord(latest)}</p>
            )}
            {latest === null || latest.baseComparison === "not_compared" ? null : (
              <p data-testid="check-base-comparison">
                {BASE_COMPARISON_WORDS[latest.baseComparison]}
              </p>
            )}
            {latest === null || latest.summary.length === 0 ? null : (
              <pre
                data-testid="check-summary"
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-2 font-mono text-[11px] text-text leading-5"
              >
                {latest.summary}
              </pre>
            )}
            {latest === null || attempts.length > 1 ? null : (
              <FullOutputLink sessionId={sessionId} result={latest} describe={check.name} />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function TestsView({
  view,
  sessionId,
  runId,
}: {
  view: SessionView;
  sessionId: string | null;
  runId: RunId | null;
}) {
  const checks = runId === null ? [] : checksForRun(view, runId);
  const run = runId === null ? undefined : view.runs.get(runId);
  const runEnded = run?.outcome != null;
  const displayStates = checks.map((check) => checkDisplayState(check, runEnded));
  const counts = {
    passed: displayStates.filter((state) => state === "passed").length,
    failed: displayStates.filter((state) => state === "failed").length,
    other: displayStates.filter((state) => state !== "passed" && state !== "failed").length,
  };
  const outcome = run?.outcome ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tests-view">
      {checks.length === 0 ? (
        <p className="p-3 text-[13px] text-muted-foreground">
          No checks have run for this turn yet.
        </p>
      ) : (
        <>
          <div
            data-testid="tests-summary"
            className="flex shrink-0 flex-wrap items-center gap-x-2 border-border border-b px-3 py-2 text-[12px] text-muted-foreground"
          >
            <span className="text-text">{counts.passed} passed</span>
            {counts.failed === 0 ? null : (
              <span className={TONE_TEXT_CLASS.danger}>{counts.failed} failed</span>
            )}
            {counts.other === 0 ? null : <span>{counts.other} other</span>}
            {outcome === null ? null : (
              <>
                <span className="text-faint">·</span>
                <span
                  className={
                    OUTCOME_TONE[outcome] === "danger" ? TONE_TEXT_CLASS.danger : "text-text"
                  }
                >
                  {STATUS_LABELS[outcome]}
                </span>
              </>
            )}
          </div>
          <ul className="scroll-pill min-h-0 flex-1 divide-y divide-border-soft overflow-y-auto">
            {checks.map((check) => (
              <CheckItem
                key={check.checkId}
                check={check}
                runEnded={runEnded}
                sessionId={sessionId}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
