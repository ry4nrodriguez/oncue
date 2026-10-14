// The session's Git policy (records 07 and 09). A change that removes
// authority applies at once; one that adds authority waits for the user's
// click; a model tool call never grants authority by itself. Proposals come
// from the untrusted sandbox, so the direction is computed from the stored
// policy, never read from the proposal.

import type { PayloadOf } from "@oncue/protocol";

export type SessionPolicy = PayloadOf<"policy.updated">["to"];
export type PolicyDirection = PayloadOf<"policy.proposed">["direction"];

/**
 * Commit on, push and draft pull request off until the user turns them on
 * (`manual`). The idle and ceiling checkpoint push is stopped only by
 * `push: "never"`.
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  version: 1,
  commit: "auto",
  push: "manual",
  pullRequest: "manual",
  planApproval: "proceed",
  fileEdits: "allowed",
};

/** The most proposals one run may have admitted. A sixth is refused. */
export const MAX_PROPOSALS_PER_RUN = 5;

/** Each dimension's values, least authority first. */
const AUTHORITY = {
  commit: ["manual", "auto"],
  push: ["never", "manual", "auto"],
  pullRequest: ["never", "manual", "auto_after_verification"],
} as const;

type GitDimension = keyof typeof AUTHORITY;
const GIT_DIMENSIONS: readonly GitDimension[] = ["commit", "push", "pullRequest"];

function rank(dimension: GitDimension, value: string): number {
  return (AUTHORITY[dimension] as readonly string[]).indexOf(value);
}

export interface PolicyFieldChange {
  readonly field: GitDimension;
  readonly from: string;
  readonly to: string;
  readonly widens: boolean;
}

/** The Git fields that differ, in a fixed order, each marked as adding or removing authority. */
export function changedFields(
  from: SessionPolicy,
  to: SessionPolicy,
): readonly PolicyFieldChange[] {
  const changes: PolicyFieldChange[] = [];
  for (const field of GIT_DIMENSIONS) {
    if (from[field] !== to[field]) {
      changes.push({
        field,
        from: from[field],
        to: to[field],
        widens: rank(field, to[field]) > rank(field, from[field]),
      });
    }
  }
  return changes;
}

/** Null when nothing changed. Computed from the stored policy, never taken from the proposal. */
export function directionOf(from: SessionPolicy, to: SessionPolicy): PolicyDirection | null {
  const changes = changedFields(from, to);
  if (changes.length === 0) {
    return null;
  }
  const widening = changes.some((change) => change.widens);
  const narrowing = changes.some((change) => !change.widens);
  if (widening && narrowing) {
    return "mixed";
  }
  return widening ? "widening" : "narrowing";
}

/** True when the policy lets an action happen without asking again. */
export function allowsPush(policy: SessionPolicy): boolean {
  return policy.push === "auto";
}

export function allowsPullRequest(policy: SessionPolicy): boolean {
  return policy.push === "auto" && policy.pullRequest === "auto_after_verification";
}

/** A checkpoint is the object's own push: only `never` withholds its grant. */
export function allowsCheckpointPush(policy: SessionPolicy): boolean {
  return policy.push !== "never";
}

export type ProposalRefusal =
  | "run_not_running"
  | "unknown_message"
  | "stale_version"
  | "outside_this_step"
  | "no_change"
  | "too_many_proposals";

export interface ProposalContext {
  readonly stored: SessionPolicy;
  /** Whether a run is running on the generation the proposal came from. */
  readonly runRunning: boolean;
  /** Whether `triggeringMessageId` names a message the session's user sent in that run. */
  readonly messageIsUsers: boolean;
  /** Proposals already admitted for that run. */
  readonly admittedThisRun: number;
}

export type ProposalDecision =
  | { readonly kind: "refuse"; readonly reason: ProposalRefusal }
  | { readonly kind: "apply_now"; readonly to: SessionPolicy }
  | { readonly kind: "hold"; readonly to: SessionPolicy; readonly direction: "widening" | "mixed" };

/** `to` as the object will store it: the proposal's Git fields on the stored policy, one version on. */
function nextPolicy(stored: SessionPolicy, to: SessionPolicy): SessionPolicy {
  return {
    ...stored,
    commit: to.commit,
    push: to.push,
    pullRequest: to.pullRequest,
    version: stored.version + 1,
  };
}

export function decideProposal(
  context: ProposalContext,
  proposal: Pick<PayloadOf<"policy.proposed">, "from" | "to">,
): ProposalDecision {
  if (!context.runRunning) {
    return { kind: "refuse", reason: "run_not_running" };
  }
  if (!context.messageIsUsers) {
    return { kind: "refuse", reason: "unknown_message" };
  }
  if (context.admittedThisRun >= MAX_PROPOSALS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_proposals" };
  }
  if (proposal.from.version !== context.stored.version) {
    return { kind: "refuse", reason: "stale_version" };
  }
  if (
    proposal.to.planApproval !== context.stored.planApproval ||
    proposal.to.fileEdits !== context.stored.fileEdits
  ) {
    return { kind: "refuse", reason: "outside_this_step" };
  }
  const direction = directionOf(context.stored, proposal.to);
  if (direction === null) {
    return { kind: "refuse", reason: "no_change" };
  }
  const to = nextPolicy(context.stored, proposal.to);
  if (direction === "narrowing") {
    return { kind: "apply_now", to };
  }
  return { kind: "hold", to, direction };
}

export interface OpenProposal {
  readonly proposalId: string;
  /** The stored policy's version when the proposal was held. */
  readonly baseVersion: number;
  readonly to: SessionPolicy;
}

export type ConfirmationRefusal = "no_open_proposal" | "superseded" | "stale_version";

export type ConfirmationDecision =
  | { readonly kind: "refuse"; readonly reason: ConfirmationRefusal }
  | { readonly kind: "apply"; readonly to: SessionPolicy }
  | { readonly kind: "decline" };

/**
 * The user's click. It names the proposal and the version the card showed;
 * a card that was superseded, or whose policy moved underneath it, changes
 * nothing.
 */
export function decideConfirmation(
  stored: SessionPolicy,
  open: OpenProposal | null,
  click: {
    readonly proposalId: string;
    readonly policyVersion: number;
    readonly accept: boolean;
  },
): ConfirmationDecision {
  if (open === null) {
    return { kind: "refuse", reason: "no_open_proposal" };
  }
  if (open.proposalId !== click.proposalId) {
    return { kind: "refuse", reason: "superseded" };
  }
  if (!click.accept) {
    return { kind: "decline" };
  }
  if (click.policyVersion !== stored.version || open.baseVersion !== stored.version) {
    return { kind: "refuse", reason: "stale_version" };
  }
  return { kind: "apply", to: open.to };
}

/** A product control writes the policy directly; the control is its own confirmation. */
export function decideControl(
  stored: SessionPolicy,
  change: Pick<SessionPolicy, "commit" | "push" | "pullRequest">,
  policyVersion: number,
):
  | { readonly kind: "refuse"; readonly reason: "stale_version" | "no_change" }
  | {
      readonly kind: "apply";
      readonly to: SessionPolicy;
    } {
  if (policyVersion !== stored.version) {
    return { kind: "refuse", reason: "stale_version" };
  }
  const to = nextPolicy(stored, { ...stored, ...change });
  if (directionOf(stored, to) === null) {
    return { kind: "refuse", reason: "no_change" };
  }
  return { kind: "apply", to };
}

/** The incident rule's policy: every remote action off, written as `system`. */
export function lockedDown(stored: SessionPolicy): SessionPolicy | null {
  if (stored.push === "never" && stored.pullRequest === "never") {
    return null;
  }
  return { ...stored, push: "never", pullRequest: "never", version: stored.version + 1 };
}
