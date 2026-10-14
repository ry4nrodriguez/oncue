import { displayStatusOf, type RunOutcome, type SessionView } from "@oncue/protocol";
import { FileDiff, GitBranch, GitPullRequest, Pin, ShieldCheck, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ROW_ACTION } from "@/components/ui/button-classes";
import { ChangeCounts } from "@/features/diff/ChangeCard";
import { diffForScope, filesWord } from "@/features/diff/review-model";
import {
  behaviorSummary,
  DEFAULT_POLICY,
  type SessionPolicy,
} from "@/features/policy/policy-words";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { OUTCOME_TONE, requiredEvidenceLine } from "@/features/verification/outcomes";
import { cn } from "@/lib/utils";
import { namedBranch } from "./branch";
import type { SubmitResult } from "./Composer";
import {
  canContinue,
  continueNeedsNewKey,
  MODEL_CONNECTIONS_PATH,
  sandboxIsLive,
} from "./composer-state";
import {
  KEY_GUIDANCE,
  modelFailureNote,
  modelFailureNoteText,
  pausedModelFailureOf,
  type RunConnectionState,
} from "./model-failure";
import { STATUS_LABELS } from "./status";
import { type CommandOutcome, useCommandAction } from "./use-commands";

/** The rail's one-switch Git behaviour, written as a `policy.set` with action `set`. */
export type PolicySwitch = {
  readonly policyVersion: number;
  readonly commit: SessionPolicy["commit"];
  readonly push: SessionPolicy["push"];
  readonly pullRequest: SessionPolicy["pullRequest"];
  /** The task branch's name, when the session has none yet and the person chose one. */
  readonly branchName?: string;
};

/** A plain anchor rather than a router link, since session views render outside a router in tests. */
export function ModelConnectionsLink({ className }: { className?: string }) {
  return (
    <a
      href={MODEL_CONNECTIONS_PATH}
      data-testid="model-connections-link"
      className={cn("mt-1 inline-block text-text underline underline-offset-2", className)}
    >
      Open Model providers
    </a>
  );
}

const LOST_LINE = "Work stopped when the sandbox was lost. Continue from the last checkpoint.";
const STOPPED_LINE = "The sandbox stopped. Continue from the last checkpoint.";

/** Only GitHub's own https URL is linked; anything else is shown as text. */
export function safeGitHubUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    // The value came from GitHub's API, but the link is drawn from stored text.
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function Row({
  icon,
  children,
  testId,
}: {
  icon: ReactNode;
  children: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-2 py-[3px] text-[13px] text-muted-foreground"
    >
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** The session's changes in one line, "+72 -3 · 4 files"; opens the session-wide diff. */
function RailChanges({ view, onOpen }: { view: SessionView; onOpen?: (() => void) | undefined }) {
  const diff = diffForScope(view, "session", null);
  const body =
    diff === null ? (
      <span className="text-faint">No changes yet</span>
    ) : (
      <>
        <ChangeCounts additions={diff.additions} deletions={diff.deletions} />
        {/* A leading space collapses at the start of a flex item; the margin does not. */}
        <span className="ml-1 text-muted-foreground">· {filesWord(diff.files.length)}</span>
      </>
    );
  const className =
    "-ml-1 flex w-full min-w-0 items-center gap-2 rounded-md py-[3px] pr-2 pl-1 text-left text-[13px] text-muted-foreground";
  const icon = <FileDiff className="size-4 shrink-0 text-faint" aria-hidden="true" />;
  return onOpen === undefined || diff === null ? (
    <div data-testid="rail-changes" className={className}>
      {icon}
      <span className="flex min-w-0 flex-1 items-center truncate">{body}</span>
    </div>
  ) : (
    <button
      type="button"
      data-testid="rail-changes"
      aria-label="Review all changes"
      onClick={onOpen}
      className={cn(className, "transition-colors hover:bg-hover")}
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-center truncate">{body}</span>
    </button>
  );
}

/**
 * The latest run's outcome and its required checks, "Verified · test passed,
 * typecheck passed". A button when the screen can open the Tests view.
 */
function RailOutcome({
  outcome,
  evidence,
  onOpenTests,
}: {
  outcome: RunOutcome;
  evidence: string | null;
  onOpenTests?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className={cn("shrink-0 font-medium", TONE_TEXT_CLASS[OUTCOME_TONE[outcome]])}>
        {STATUS_LABELS[outcome]}
      </span>
      {evidence === null ? null : (
        <span className="min-w-0 truncate text-muted-foreground"> · {evidence}</span>
      )}
    </>
  );
  const className =
    "-ml-1 flex w-full min-w-0 items-center gap-1 rounded-md py-[3px] pr-2 pl-1 text-left text-[13px]";
  return onOpenTests === undefined ? (
    <div data-testid="rail-outcome" className={className}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      data-testid="rail-outcome"
      onClick={onOpenTests}
      className={cn(className, "transition-colors hover:bg-hover")}
    >
      {body}
    </button>
  );
}

/** Brings the open approval or question card into view and focuses it, for keyboard and screen reader users. */
function showCard(testId = "approval-card"): void {
  const card = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (card === null) {
    return;
  }
  card.scrollIntoView({ block: "center" });
  card.setAttribute("tabindex", "-1");
  card.focus({ preventScroll: true });
}

export function ContextRail({
  view,
  taskBranch = null,
  baseBranch = null,
  existingBranch = false,
  suggestedBranch,
  onUnpin,
  onOpenChanges,
  onContinue,
  onRunChecks,
  onOpenTests,
  onSetPolicy,
  onOpenPullRequest,
  runConnection = "active",
  keyStateKnown = true,
}: {
  /**
   * Writes the same policy record as the confirmation card (records 07 and 09).
   * Absent where no command can be sent; the line is then read-only.
   */
  onSetPolicy?: (change: PolicySwitch) => Promise<CommandOutcome> | undefined;
  /** Opens the review pane on every change in the session. */
  onOpenChanges?: () => void;
  /** Opens the review panel's Tests tab on the latest run. */
  onOpenTests?: () => void;
  view: SessionView;
  /** Where the run's model connection stands; Continue is offered only while it is active. */
  runConnection?: RunConnectionState;
  /** False while the connections on hand may predate the run's pause; the rail then says nothing about the key. */
  keyStateKnown?: boolean;
  /** The branch recorded in `session_index`, shown until `run.started` names one. */
  taskBranch?: string | null;
  /** The branch the session started from; null for the default branch or an older session. */
  baseBranch?: string | null;
  /** The session works directly on `taskBranch`, an existing branch, and pushes there. */
  existingBranch?: boolean;
  /** The name a first push would give the branch: the typed choice, else `oncue/<slug>-<hex>`. */
  suggestedBranch?: string | undefined;
  /** Opens the panel's Pull request tab. */
  onOpenPullRequest?: (() => void) | undefined;
  onUnpin?: () => void;
  /** Sends the Continue follow-up; shown only while `canContinue` holds, the composer's own test. */
  onContinue?: () => Promise<SubmitResult> | SubmitResult;
  /** Starts a checks-only run (record 14); passed only while the latest run has ended. */
  onRunChecks?: (() => Promise<CommandOutcome | null>) | undefined;
}) {
  const [continuing, setContinuing] = useState(false);
  const [continueProblem, setContinueProblem] = useState<string | null>(null);
  // Each button is off while its command is out, and says so when it fails.
  const checks = useCommandAction(view.run?.runId ?? null);
  const policySwitch = useCommandAction((view.policy.current ?? DEFAULT_POLICY).version);
  const status = displayStatusOf(view);
  const pullRequest = view.git.pullRequest;
  const policy = view.policy.current ?? DEFAULT_POLICY;
  // One switch for the common case: push after each run and keep a draft pull request up to date.
  const publishes = policy.push === "auto";
  const run = view.run;
  const sandboxLive = sandboxIsLive(view.sandbox.state);
  const runModelUsable = runConnection === "active";
  const needsNewKey = continueNeedsNewKey(run, sandboxLive, runModelUsable);
  // A run paused on `model_failure` also reads as `waiting_for_input` (record 15),
  // so this is checked ahead of the generic question line. The note under the
  // composer is built from the same call.
  const pausedOnModel = pausedModelFailureOf(run);
  const failureNote =
    pausedOnModel === null
      ? null
      : modelFailureNote({
          failure: pausedOnModel,
          sandboxLive,
          connection: keyStateKnown ? runConnection : null,
        });
  const modelFailureText = failureNote === null ? null : modelFailureNoteText(failureNote);
  // The key guidance, and the link to where keys are replaced, go together.
  const showsKeyGuidance = failureNote === null ? needsNewKey : failureNote.linksToKeys;
  const approvalWaiting =
    modelFailureText === null && !needsNewKey && view.openApprovalIds.length > 0;
  // An open question is answered on its card, which also resumes a stopped run.
  const questionWaiting =
    modelFailureText === null && !needsNewKey && !approvalWaiting && view.openQuestionId !== null;
  const needsYou =
    modelFailureText ??
    (needsNewKey && runConnection !== "active"
      ? KEY_GUIDANCE[runConnection]
      : view.openApprovalIds.length > 0
        ? "An approval is waiting"
        : status === "waiting_for_input"
          ? "The agent asked you a question"
          : null);
  // The line comes from the run's interruption reason; the unsaved-work
  // warning beneath it is informational only.
  const continueLine =
    view.openQuestionId !== null || !canContinue(run, sandboxLive, runModelUsable)
      ? null
      : run?.state === "interrupted" && run.interruption?.reason === "sandbox_lost"
        ? LOST_LINE
        : STOPPED_LINE;
  const unsavedWorkWarning = view.sandbox.stop?.unsavedWorkWarning ?? null;

  async function continueRun(send: () => Promise<SubmitResult> | SubmitResult) {
    setContinuing(true);
    setContinueProblem(null);
    try {
      const result = await send();
      setContinueProblem(
        result === true
          ? null
          : result === "unanswered"
            ? "OnCue didn't answer in time. Try again."
            : "Not continued. The note under the message box says why.",
      );
    } finally {
      setContinuing(false);
    }
  }

  return (
    <aside
      data-testid="context-rail"
      // Full width on a narrow screen, where a fixed width would overflow.
      className="absolute top-14 right-2 left-2 z-20 overflow-hidden rounded-xl border border-border bg-popover shadow-[0_8px_28px_-10px_rgb(0_0_0/35%)] lg:right-4 lg:left-auto lg:w-[286px]"
    >
      <div className="px-3 pt-2 pb-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-[11px] text-faint uppercase tracking-wide">
            Session
          </span>
          {onUnpin ? (
            <button
              type="button"
              aria-label="Unpin session details"
              onClick={onUnpin}
              className="-mr-1 flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
            >
              <Pin className="size-[15px]" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {continueLine !== null ? (
          <div
            data-testid="needs-you"
            className="my-1.5 flex items-start gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-[12px] text-text"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              {/* A model failure stays named after the sandbox is gone. */}
              <p>{modelFailureText ?? continueLine}</p>
              {showsKeyGuidance ? <ModelConnectionsLink /> : null}
              {unsavedWorkWarning === null ? null : (
                <p
                  data-testid="unsaved-work-warning"
                  className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"
                >
                  {unsavedWorkWarning}
                </p>
              )}
              {onContinue === undefined ? null : (
                <button
                  type="button"
                  data-testid="rail-continue"
                  disabled={continuing}
                  onClick={() => void continueRun(onContinue)}
                  className="mt-2 rounded-md bg-accent px-2.5 py-1 font-medium text-[12px] text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
                >
                  Continue
                </button>
              )}
              {continueProblem === null ? null : (
                <p role="status" data-testid="rail-continue-problem" className="mt-1 text-danger">
                  {continueProblem}
                </p>
              )}
            </div>
          </div>
        ) : needsYou ? (
          <div
            data-testid="needs-you"
            className="my-1.5 flex items-start gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-[12px] text-text"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              {approvalWaiting || questionWaiting ? (
                // The card is in the conversation or above the composer; this takes the reader to it.
                <button
                  type="button"
                  data-testid={approvalWaiting ? "needs-you-approval" : "needs-you-question"}
                  className="text-left underline-offset-2 hover:underline focus-visible:underline"
                  onClick={() => showCard(approvalWaiting ? "approval-card" : "question-card")}
                >
                  {needsYou}
                </button>
              ) : (
                <p>{needsYou}</p>
              )}
              {showsKeyGuidance ? <ModelConnectionsLink /> : null}
            </div>
          </div>
        ) : null}

        <RailChanges view={view} onOpen={onOpenChanges} />
        <Row icon={<GitBranch className="size-4" aria-hidden="true" />} testId="rail-branch">
          {namedBranch(view, taskBranch) ?? (
            <span className="text-faint">Branch named at the first push</span>
          )}
          {existingBranch ? (
            <span
              className="block text-[12px] text-muted-foreground"
              data-testid="rail-branch-mode"
            >
              Existing branch, pushed to directly
            </span>
          ) : baseBranch === null ? null : (
            <span
              className="block text-[12px] text-muted-foreground"
              data-testid="rail-branch-mode"
            >
              From {baseBranch}
            </span>
          )}
        </Row>
        <Row
          icon={<GitPullRequest className="size-4" aria-hidden="true" />}
          testId="rail-pull-request"
        >
          {/* The row opens the panel's Pull request tab, which names the branch and links to GitHub. */}
          <button
            type="button"
            onClick={onOpenPullRequest}
            disabled={onOpenPullRequest === undefined}
            data-testid="rail-pull-request-open"
            className={cn(
              "text-left disabled:cursor-default",
              pullRequest === null ? "text-faint" : "text-text",
              onOpenPullRequest === undefined ? "" : "underline-offset-2 hover:underline",
            )}
          >
            {pullRequest === null
              ? "No pull request yet"
              : `#${pullRequest.number} · ${pullRequest.state}`}
          </button>
        </Row>
        <Row icon={<ShieldCheck className="size-4" aria-hidden="true" />}>
          <span data-testid="rail-git-behavior">{behaviorSummary(policy)}</span>
        </Row>
        {onSetPolicy === undefined ? null : (
          <div className="pb-1 pl-7">
            {(() => {
              const branchKnown = namedBranch(view, taskBranch) !== null;
              const setPolicy = (branchName?: string) =>
                policySwitch.run(
                  () =>
                    onSetPolicy({
                      policyVersion: policy.version,
                      commit: policy.commit,
                      push: publishes ? "manual" : "auto",
                      pullRequest: publishes ? "manual" : "auto_after_verification",
                      ...(branchName === undefined ? {} : { branchName }),
                    }) ?? null,
                );
              return (
                <>
                  <button
                    type="button"
                    data-testid="rail-policy-switch"
                    aria-pressed={publishes}
                    aria-busy={policySwitch.busy}
                    disabled={policySwitch.busy}
                    onClick={() =>
                      // A first push names the branch.
                      void setPolicy(
                        !publishes && !branchKnown && suggestedBranch !== undefined
                          ? suggestedBranch
                          : undefined,
                      )
                    }
                    className={cn(ROW_ACTION, "px-1.5 py-0.5 text-text")}
                  >
                    {publishes ? "Stop pushing" : "Push and open a draft pull request"}
                  </button>
                  {policySwitch.problem === null ? null : (
                    <p
                      role="status"
                      data-testid="rail-policy-problem"
                      className="px-1.5 text-[12px] text-danger"
                    >
                      {policySwitch.problem}
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {run?.outcome == null ? null : (
          <RailOutcome
            outcome={run.outcome}
            evidence={requiredEvidenceLine(view, run.runId)}
            onOpenTests={onOpenTests}
          />
        )}
        {run?.outcome == null || onRunChecks === undefined ? null : (
          <>
            <button
              type="button"
              data-testid="rail-run-checks"
              aria-busy={checks.busy}
              disabled={checks.busy}
              onClick={() => void checks.run(onRunChecks)}
              className={cn(ROW_ACTION, "mt-1 px-1.5 py-0.5 text-text")}
            >
              Run checks
            </button>
            {checks.problem === null ? null : (
              <p
                role="status"
                data-testid="rail-run-checks-problem"
                className="px-1.5 text-[12px] text-danger"
              >
                {checks.problem}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
