/**
 * One renderer per run outcome, in a table keyed by outcome so a new outcome
 * is a compile error. Payload strings come from the sandbox or the object and
 * are rendered as text.
 */
import type { CheckView, RunEnding, RunId, RunOutcome, SessionView } from "@oncue/protocol";
import type { ReactNode } from "react";
import { STATUS_LABELS } from "@/features/session/status";
import { type StatusTone, TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import { type CheckDisplayState, checkDisplayState } from "./check-display";

export const OUTCOME_TONE: Record<RunOutcome, StatusTone> = {
  verified: "positive",
  completed_with_warnings: "caution",
  completed: "faint",
  blocked: "danger",
  failed: "danger",
  cancelled: "faint",
};

/**
 * The class an outcome's word carries in a row. Only a bad ending is
 * coloured; "Verified" is a fact in plain text, not a celebration.
 */
export function outcomeLabelClass(outcome: RunOutcome): string {
  const tone = OUTCOME_TONE[outcome];
  return tone === "danger" || tone === "caution" ? TONE_TEXT_CLASS[tone] : "text-text";
}

/** The words a check's state reads as in an evidence line. */
export const CHECK_STATE_WORDS: Record<CheckDisplayState, string> = {
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  inconclusive: "inconclusive",
  not_finished: "not finished",
};

type FailureStage = Extract<RunEnding, { outcome: "failed" }>["stage"];

export const FAILURE_STAGE_WORDS: Record<FailureStage, string> = {
  provisioning: "while starting the sandbox",
  execution: "while running",
  implementation: "while making the change",
  verification: "during verification",
  checkpoint: "while saving a checkpoint",
  external_action: "during an external action",
};

/** A run's checks in the order they were first recorded. */
export function checksForRun(view: SessionView, runId: RunId): readonly CheckView[] {
  return [...view.verification.checks.values()].filter((check) => check.runId === runId);
}

/**
 * "tests passed, typecheck passed": each required check of the run with its
 * state, or `null` when the run recorded no required check.
 */
export function requiredEvidenceLine(view: SessionView, runId: RunId): string | null {
  const required = checksForRun(view, runId).filter((check) => check.classification === "required");
  if (required.length === 0) {
    return null;
  }
  const runEnded = view.runs.get(runId)?.outcome != null;
  return required
    .map((check) => `${check.name} ${CHECK_STATE_WORDS[checkDisplayState(check, runEnded)]}`)
    .join(", ");
}

type OutcomeDetailProps<O extends RunOutcome> = {
  readonly ending: Extract<RunEnding, { outcome: O }>;
};

function Detail({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 space-y-0.5 text-[12px] text-muted-foreground">{children}</div>;
}

/** What each outcome says beneath its label, beyond the evidence line. */
const OUTCOME_DETAIL: {
  [O in RunOutcome]: (props: OutcomeDetailProps<O>) => ReactNode;
} = {
  verified: () => null,
  completed_with_warnings: ({ ending }) =>
    ending.warnings.length === 0 ? null : (
      <Detail>
        <ul className="list-disc space-y-0.5 pl-4" data-testid="outcome-warnings">
          {ending.warnings.map((warning, index) => (
            // Warnings have no id and never reorder once committed.
            // biome-ignore lint/suspicious/noArrayIndexKey: a committed, fixed list
            <li key={index} className="whitespace-pre-wrap break-words">
              <span className="text-text">{warning.text}</span>
              {warning.recommendedAction.length === 0 ? null : (
                <span> {warning.recommendedAction}</span>
              )}
            </li>
          ))}
        </ul>
      </Detail>
    ),
  // Record 14, "Done": nothing to check, and the row says why none ran.
  completed: () => (
    <Detail>
      <p data-testid="outcome-no-changes">No files changed, so no checks ran.</p>
    </Detail>
  ),
  blocked: ({ ending }) => (
    <Detail>
      <p className="whitespace-pre-wrap break-words" data-testid="outcome-blocked-on">
        {ending.blockedOn.kind === "question" || ending.blockedOn.kind === "decision"
          ? `Waiting on: ${ending.blockedOn.question}`
          : ending.blockedOn.kind === "model_failure"
            ? `Waiting on the model: ${ending.blockedOn.failure.message}`
            : `Waiting on ${ending.blockedOn.kind}: ${ending.blockedOn.resource}`}
      </p>
    </Detail>
  ),
  failed: ({ ending }) => (
    <Detail>
      <p className="whitespace-pre-wrap break-words" data-testid="outcome-failure-stage">
        Failed {FAILURE_STAGE_WORDS[ending.stage]}: {ending.error.message}
      </p>
    </Detail>
  ),
  cancelled: () => null,
};

function OutcomeDetail({ ending }: { ending: RunEnding }) {
  const render = OUTCOME_DETAIL[ending.outcome] as (props: { ending: RunEnding }) => ReactNode;
  return <>{render({ ending })}</>;
}

/**
 * The timeline row for a run that ended. `onOpenTests` opens the Tests view
 * on this run; the evidence line is its control when there is one.
 */
export function RunOutcomeRow({
  view,
  runId,
  outcome,
  onOpenTests,
}: {
  view: SessionView;
  runId: RunId;
  outcome: RunOutcome;
  onOpenTests?: ((runId: RunId) => void) | undefined;
}) {
  const ending = view.runs.get(runId)?.ending ?? null;
  const evidence = requiredEvidenceLine(view, runId);
  return (
    <div data-testid="row-run" data-outcome={outcome} className="py-1.5 pl-1 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 font-medium", outcomeLabelClass(outcome))}>
          {STATUS_LABELS[outcome]}
        </span>
        {evidence === null ? null : onOpenTests === undefined ? (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="outcome-evidence">
            · {evidence}
          </span>
        ) : (
          <button
            type="button"
            data-testid="outcome-evidence"
            onClick={() => onOpenTests(runId)}
            aria-label={`Open the checks for this run: ${evidence}`}
            className="min-w-0 truncate text-left text-muted-foreground underline-offset-2 hover:text-text hover:underline"
          >
            · {evidence}
          </button>
        )}
      </div>
      {ending === null || ending.outcome !== outcome ? null : <OutcomeDetail ending={ending} />}
    </div>
  );
}
