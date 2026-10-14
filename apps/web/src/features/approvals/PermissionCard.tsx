/**
 * The agent's own permission ask (record 09, "Agent permissions"): a card
 * above the composer while it waits, and one folded line in the timeline once
 * it is settled. Every word on the card was written by the session object. A
 * click sends the approval id, the decision, and how far it reaches; the
 * object refuses a reach the card did not offer.
 */

import type { ApprovalScope, ApprovalView } from "@oncue/protocol";
import { Check, X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { ActionRow, DecisionCard } from "@/components/decision/DecisionCard";
import { type AnswerHandler, useCommandAction } from "@/features/session/use-commands";
import {
  CATEGORY_LABEL,
  cardScopes,
  DENY_DESCRIPTION,
  isPermissionCategory,
  SCOPE_BUTTON,
  SCOPE_DESCRIPTION,
  settledLine,
} from "./approval-modes";

export interface PermissionAnswer {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
  readonly scope?: ApprovalScope;
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The card for one ask. The screen keys it by the approval's id, so a new ask
 * never inherits the last one's state. Its buttons are off while an answer is
 * out and once it is accepted; an answer that did not leave, that the object
 * refused, or that got no reply in time gives them back and says why.
 */
export function PermissionCard({
  approval,
  onAnswer,
}: {
  approval: ApprovalView;
  onAnswer?: AnswerHandler<PermissionAnswer> | undefined;
}) {
  const titleId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const decision = useCommandAction(approval.approvalId);
  if (!isPermissionCategory(approval.category)) {
    return null;
  }
  const answer = (choice: PermissionAnswer["decision"], scope?: ApprovalScope) => {
    if (onAnswer === undefined) {
      return;
    }
    void decision.run(() =>
      onAnswer({
        approvalId: approval.approvalId,
        decision: choice,
        ...(scope === undefined ? {} : { scope }),
      }),
    );
  };
  const title = <span data-testid="permission-title">{approval.title}</span>;
  // Each allow the card offers, then Deny: one press answers.
  const choices = [
    ...cardScopes(approval.category).map((scope) => ({
      key: `allow-${scope}`,
      label: SCOPE_BUTTON[scope],
      description: SCOPE_DESCRIPTION[scope],
      act: () => answer("approved", scope),
    })),
    {
      key: "deny",
      label: "Deny",
      description: DENY_DESCRIPTION,
      act: () => answer("rejected"),
    },
  ];
  // A number answers only while focus is in the card and no modifier is held.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      collapsed ||
      decision.busy ||
      onAnswer === undefined ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    const choice = choices[Number(event.key) - 1];
    if (/^[1-9]$/.test(event.key) && choice !== undefined) {
      event.preventDefault();
      choice.act();
    }
  };
  return (
    <DecisionCard
      testId="permission-card"
      titleId={titleId}
      title={title}
      collapsed={collapsed}
      collapsedLabel={title}
      onToggleCollapsed={() => setCollapsed(!collapsed)}
      onKeyDown={onKeyDown}
    >
      <div data-category={approval.category} className="flex flex-col gap-1 pb-2">
        <p className="px-2 pb-1.5 text-[12.5px] text-muted-foreground">
          {CATEGORY_LABEL[approval.category]} · Denied if not answered by{" "}
          <time dateTime={approval.expiresAt}>{timeOfDay(approval.expiresAt)}</time>
        </p>
        {onAnswer === undefined ? null : (
          <div aria-busy={decision.busy} className="flex flex-col gap-1">
            {choices.map((choice, at) => (
              <ActionRow
                key={choice.key}
                index={at + 1}
                label={choice.label}
                description={choice.description}
                disabled={decision.busy}
                onClick={choice.act}
                testId={choice.key === "deny" ? "permission-deny" : `permission-${choice.key}`}
              />
            ))}
          </div>
        )}
        {decision.problem === null ? null : (
          <p
            role="status"
            data-testid="permission-problem"
            className="px-2 pt-1 text-[12px] text-danger"
          >
            {decision.problem}
          </p>
        )}
      </div>
    </DecisionCard>
  );
}

/** The timeline's folded line for a settled ask: what was asked and how it was answered. */
export function PermissionLine({ approval }: { approval: ApprovalView }) {
  if (!isPermissionCategory(approval.category) || approval.state === "requested") {
    return null;
  }
  const allowed = approval.state === "approved";
  const Mark = allowed ? Check : X;
  return (
    <p
      data-testid="row-permission"
      data-state={approval.state}
      className="my-1 flex min-w-0 items-start gap-2 text-[12.5px] text-muted-foreground"
    >
      <Mark className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{settledLine(approval)}</span>
    </p>
  );
}
