/**
 * The one-click confirmation of records 07 and 09. A permissive change the
 * agent proposed does nothing until the user allows it; Allow sends the
 * proposal id and the policy version it was drawn from, so a stale banner
 * confirms nothing. Pending, it is one line above the composer; answered, a
 * timeline line listing every field that changed.
 */

import { isBranchName, type PolicyChangeView, type SessionView } from "@oncue/protocol";
import { ShieldCheck } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { type AnswerHandler, useCommandAction } from "@/features/session/use-commands";
import {
  allowSentence,
  changeLines,
  DEFAULT_POLICY,
  type SessionPolicy,
  updateTitle,
} from "./policy-words";

export type PolicyAnswer =
  | {
      readonly action: "confirm";
      readonly proposalId: string;
      readonly policyVersion: number;
      /** The task branch's name, when the card asked for one (the session had none). */
      readonly branchName?: string;
    }
  | { readonly action: "decline"; readonly proposalId: string };

/** What a push needs to know about the branch: whether one exists, and what to call it otherwise. */
export interface BranchChoice {
  /** The session's task branch, or null until the first push names it. */
  readonly taskBranch: string | null;
  /** The name a first push would give it: what the person chose in the Pull request tab, else `oncue/<slug>-<hex>`. */
  readonly suggested: string;
}

function ChangeList({ from, to }: { from: SessionPolicy; to: SessionPolicy }) {
  return (
    <ul className="space-y-0.5 text-[12px] text-muted-foreground">
      {changeLines(from, to).map((line) => (
        <li key={line.field} data-testid="policy-change-line">
          <span className="text-text">{line.label}:</span> {line.from}{" "}
          <span aria-hidden="true">→</span>
          <span className="sr-only">becomes</span> <span className="text-text">{line.to}</span>
        </li>
      ))}
    </ul>
  );
}

function Shell({
  testId,
  titleId,
  title,
  children,
  actions,
}: {
  testId: string;
  titleId: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={titleId}
      className="my-2 overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground"
          aria-hidden="true"
        >
          <ShieldCheck className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p id={titleId} className="font-medium text-[13px] text-text">
            {title}
          </p>
          {children}
          {/* Under the text, at the left: the floating rail covers the row's right edge. */}
          {actions}
        </div>
      </div>
    </section>
  );
}

export function PolicyRow({
  view,
  change,
  onAnswer,
  branch,
  repository = null,
}: {
  view: SessionView;
  change: PolicyChangeView;
  /** Absent in a read-only surface: the banner then shows the question without its buttons. */
  onAnswer?: AnswerHandler<PolicyAnswer> | undefined;
  /** Absent where the branch is not the banner's business, such as a read-only surface. */
  branch?: BranchChoice | undefined;
  /** The repository's full name, for the question; null leaves it out. */
  repository?: string | null | undefined;
}) {
  const titleId = useId();
  // Allow and Decline are off while either answer is out and once one is
  // accepted, so a double click sends one command.
  const answer = useCommandAction(change.kind === "proposed" ? change.proposalId : null);
  // A push on a session with no branch yet names it: the name chosen in the
  // Pull request tab, or the suggestion, travels with Allow.
  const namesBranch =
    branch !== undefined &&
    branch.taskBranch === null &&
    change.kind === "proposed" &&
    change.to.push !== "never" &&
    isBranchName(branch.suggested);
  const branchName = namesBranch && branch !== undefined ? branch.suggested : null;
  if (change.kind === "declined") {
    return (
      <Shell testId="row-policy-declined" titleId={titleId} title="You declined the change">
        <p className="text-[12px] text-muted-foreground">Nothing about this session changed.</p>
      </Shell>
    );
  }
  if (change.kind === "updated") {
    return (
      <Shell testId="row-policy-updated" titleId={titleId} title={updateTitle(change.confirmedBy)}>
        <ChangeList from={change.from} to={change.to} />
      </Shell>
    );
  }
  const pending = view.policy.pendingProposal?.proposalId === change.proposalId;
  if (!pending) {
    return (
      <Shell
        testId="row-policy-proposed"
        titleId={titleId}
        title="The agent proposed a Git behavior change"
      >
        <ChangeList from={change.from} to={change.to} />
      </Shell>
    );
  }
  const policyVersion = (view.policy.current ?? DEFAULT_POLICY).version;
  return (
    <section
      data-testid="policy-card"
      aria-labelledby={titleId}
      className="rounded-xl border border-border bg-surface px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p id={titleId} className="min-w-0 flex-1 text-[13px] text-text leading-5">
          {allowSentence(change.from, change.to, repository)}
        </p>
        {onAnswer === undefined ? null : (
          <div className="flex shrink-0 gap-1.5" aria-busy={answer.busy}>
            <Button
              variant="outline"
              size="sm"
              aria-describedby={titleId}
              disabled={answer.busy}
              onClick={() =>
                void answer.run(() =>
                  onAnswer({ action: "decline", proposalId: change.proposalId }),
                )
              }
              className="h-7 rounded-md border-border px-2.5 text-[12px] text-muted-foreground"
            >
              Decline
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-describedby={titleId}
              disabled={answer.busy}
              onClick={() =>
                void answer.run(() =>
                  onAnswer({
                    action: "confirm",
                    proposalId: change.proposalId,
                    policyVersion,
                    ...(branchName === null ? {} : { branchName }),
                  }),
                )
              }
              className="h-7 rounded-md border-border px-2.5 text-[12px] text-text"
            >
              Allow
            </Button>
          </div>
        )}
      </div>
      {answer.problem === null ? null : (
        <p role="status" data-testid="policy-problem" className="mt-1 pl-7 text-[12px] text-danger">
          {answer.problem}
        </p>
      )}
    </section>
  );
}
