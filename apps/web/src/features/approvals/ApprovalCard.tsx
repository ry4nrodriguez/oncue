/**
 * The approval of records 04 and 09. The card names the action, target,
 * scope, and expiry, all written by the session object, never the sandbox.
 * A click sends only the approval id and the decision. Silence approves
 * nothing, so the card shows its expiry.
 */

import type { ApprovalChange, ApprovalView, SessionView } from "@oncue/protocol";
import { KeyRound } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { type AnswerHandler, useCommandAction } from "@/features/session/use-commands";
import { isPermissionCategory } from "./approval-modes";
import { PermissionLine } from "./PermissionCard";

export interface ApprovalAnswer {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
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
  children?: React.ReactNode;
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
          <KeyRound className="size-4" />
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function settledTitle(approval: ApprovalView): string {
  if (approval.state === "approved") {
    return `You approved ${approval.resource}`;
  }
  if (approval.state === "rejected") {
    return `You denied ${approval.resource}`;
  }
  return approval.expiredEffect === "tool_denied"
    ? `The request for ${approval.resource} expired`
    : `The request for ${approval.resource} ended with the sandbox`;
}

/** Approved and supplied are different facts: "Supplied" is said only from the sandbox's answer. */
function deliveryWords(delivered: boolean | null): string {
  if (delivered === null) {
    return "Approved, not delivered yet.";
  }
  return delivered
    ? "Supplied to this sandbox."
    : "Approved, not delivered. The saved value could not be put in place. Save it again under Settings, Repositories.";
}

export function ApprovalRow({
  view,
  approvalId,
  change,
  onAnswer,
}: {
  view: SessionView;
  approvalId: string;
  change: ApprovalChange;
  /** Absent in a read-only surface: the card then shows the request without its buttons. */
  onAnswer?: AnswerHandler<ApprovalAnswer> | undefined;
}) {
  const titleId = useId();
  // Both buttons are off while a decision is out and once it is accepted. A
  // decision that did not leave, or that the object refused, frees them and
  // says why.
  const decision = useCommandAction(approvalId);
  const approval = view.approvals.get(approvalId as ApprovalView["approvalId"]);
  if (approval === undefined) {
    return null;
  }
  if (isPermissionCategory(approval.category)) {
    // The agent's own ask waits above the composer; the log keeps one line once it settles.
    return change === "requested" ? null : <PermissionLine approval={approval} />;
  }
  if (change !== "requested") {
    const testId =
      approval.state === "approved"
        ? "row-approval-approved"
        : approval.state === "rejected"
          ? "row-approval-denied"
          : "row-approval-expired";
    return (
      <Shell testId={testId} titleId={titleId} title={settledTitle(approval)}>
        <p className="text-[12px] text-muted-foreground">
          {approval.state === "approved"
            ? deliveryWords(approval.delivered)
            : "The run continued without it."}
        </p>
      </Shell>
    );
  }
  if (approval.state !== "requested") {
    return (
      <Shell
        testId="row-approval-asked"
        titleId={titleId}
        title={`The agent asked for ${approval.resource}`}
      />
    );
  }
  return (
    <Shell
      testId="approval-card"
      titleId={titleId}
      title={approval.title}
      actions={
        onAnswer === undefined ? undefined : (
          <>
            <div className="flex gap-1.5 pt-1.5" aria-busy={decision.busy}>
              <Button
                variant="outline"
                size="sm"
                aria-describedby={titleId}
                disabled={decision.busy}
                onClick={() =>
                  void decision.run(() =>
                    onAnswer({ approvalId: approval.approvalId, decision: "rejected" }),
                  )
                }
                className="h-7 rounded-md border-border px-2.5 text-[12px] text-text"
              >
                Deny
              </Button>
              <Button
                size="sm"
                aria-describedby={titleId}
                disabled={decision.busy}
                onClick={() =>
                  void decision.run(() =>
                    onAnswer({ approvalId: approval.approvalId, decision: "approved" }),
                  )
                }
                className="h-7 rounded-md px-2.5 text-[12px]"
              >
                Approve
              </Button>
            </div>
            {decision.problem === null ? null : (
              <p
                role="status"
                data-testid="approval-problem"
                className="pt-1 text-[12px] text-danger"
              >
                {decision.problem}
              </p>
            )}
          </>
        )
      }
    >
      <p className="text-[12px] text-muted-foreground">{approval.intendedAction}</p>
      <dl className="space-y-0.5 text-[12px]">
        <Fact label="Target">
          <span data-testid="approval-target">{approval.resource}</span>
        </Fact>
        <Fact label="Scope">
          <span data-testid="approval-scope">{approval.requestedScope}</span>
        </Fact>
        <Fact label="Expires">
          <time data-testid="approval-expiry" dateTime={approval.expiresAt}>
            {timeOfDay(approval.expiresAt)}
          </time>
        </Fact>
      </dl>
      <p className="text-[12px] text-muted-foreground">
        Nothing is supplied unless you approve. If you do nothing, the request expires and the run
        continues without it.
      </p>
    </Shell>
  );
}

/**
 * What the launch disclosed (record 08): the names the session started with,
 * the optional ones left out, and any required one it started without. Names
 * only; the event has no field a value could be in.
 */
export function SecretsDisclosedRow({ view }: { view: SessionView }) {
  const titleId = useId();
  const disclosed = view.secrets;
  if (disclosed === null) {
    return null;
  }
  const title = disclosed.invalid
    ? "Started without secrets: the project file could not be read"
    : disclosed.missing.length > 0
      ? `Started without ${disclosed.missing.join(", ")}`
      : disclosed.supplied.length > 0
        ? `Starting with ${disclosed.supplied.join(", ")}`
        : "Starting with no secrets";
  return (
    <Shell testId="row-secrets-disclosed" titleId={titleId} title={title}>
      {disclosed.missing.length > 0 && disclosed.supplied.length > 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Starting with: {disclosed.supplied.join(", ")}
        </p>
      ) : null}
      {disclosed.invalid ? (
        <p className="text-[12px] text-muted-foreground">
          .oncue/project.yaml was refused at launch, so whatever it asked for was not supplied, and
          this session's runs cannot end verified.
        </p>
      ) : null}
      {disclosed.missing.length > 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Nothing is saved for it, so parts of the project may not run, and this session's runs
          cannot end verified.
        </p>
      ) : null}
      {disclosed.withheld.length > 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Not supplied: {disclosed.withheld.join(", ")}. The agent can ask for one, and you decide
          then.
        </p>
      ) : null}
    </Shell>
  );
}

/** A launch's selection reached the sandbox, or did not. Names only. */
export function SecretsSuppliedRow({
  names,
  delivered,
}: {
  names: readonly string[];
  delivered: boolean;
}) {
  const titleId = useId();
  if (delivered) {
    return (
      <Shell
        testId="row-secrets-supplied"
        titleId={titleId}
        title={`Supplied ${names.join(", ")}`}
      />
    );
  }
  return (
    <Shell
      testId="row-secrets-not-supplied"
      titleId={titleId}
      title={`Could not supply ${names.join(", ")}`}
    >
      <p className="text-[12px] text-muted-foreground">
        The saved value could not be put in place. Save it again under Settings, Repositories. If it
        is required, this sandbox's runs cannot end verified.
      </p>
    </Shell>
  );
}
