// Approval decisions (records 04 and 09); pure, no storage or clock. The
// sandbox is trusted only for the secret name in `resource`: every field on the
// card comes from the object's own rows and clock, so a click approves only
// what the card said.

import { isSecretName } from "@oncue/bridge";
import type { PayloadOf } from "@oncue/protocol";
import { actionForCategory, decideAction, type ExpiryEffect } from "../policy/tiers";

type RequestedPayload = PayloadOf<"approval.requested">;

/** Shorter than the idle stop, and within how long OpenCode holds a permission request. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalEnv {
  readonly ONCUE_ENV: string;
  readonly ONCUE_APPROVAL_TTL_SECONDS?: string | undefined;
}

/** Only a local environment may shorten the expiry, so a hosted deployment cannot expire every card at once. */
export function approvalTtlMs(env: ApprovalEnv): number {
  const value = Number(env.ONCUE_APPROVAL_TTL_SECONDS);
  if (env.ONCUE_ENV !== "local" || !Number.isInteger(value) || value <= 0) {
    return APPROVAL_TTL_MS;
  }
  return value * 1000;
}

/** The most approvals one run may have admitted. A sixth is refused. */
export const MAX_APPROVALS_PER_RUN = 5;

/** The two things read from a sandbox's request. Everything else it sent is discarded. */
export type ApprovalClaim = Pick<RequestedPayload, "category" | "resource">;

export interface RequestContext {
  /** The frame names the session's current run, and that run is `running`. */
  readonly runRunning: boolean;
  readonly openApprovalExists: boolean;
  readonly admittedThisRun: number;
  /** The optional names of the declaration pinned at launch, never the bridge's later read of the file. */
  readonly declaredOptional: readonly string[];
  /** Names whose delivery the bridge has acknowledged for the current generation. */
  readonly suppliedThisGeneration: readonly string[];
  readonly deniedThisRun: readonly string[];
}

export type RequestRefusal =
  | "not_offered"
  | "malformed_name"
  | "run_not_running"
  | "approval_open"
  | "too_many_requests"
  | "not_declared"
  | "already_supplied"
  | "already_denied"
  | "not_saved";

export type RequestJudgement =
  | { readonly kind: "candidate"; readonly name: string }
  | { readonly kind: "refuse"; readonly reason: RequestRefusal };

/** The checks that need no row; run first so a malformed frame costs no read. */
export function judgeClaim(claim: ApprovalClaim): RequestJudgement | null {
  const action = actionForCategory(claim.category);
  if (action === null || decideAction(action, { approved: false }).kind !== "ask") {
    return { kind: "refuse", reason: "not_offered" };
  }
  if (!isSecretName(claim.resource)) {
    return { kind: "refuse", reason: "malformed_name" };
  }
  return null;
}

/**
 * Everything decidable from the object's own rows. A `candidate` still needs
 * the D1 read of whether a value is saved.
 */
export function judgeRequest(context: RequestContext, claim: ApprovalClaim): RequestJudgement {
  const action = actionForCategory(claim.category);
  if (action === null || decideAction(action, { approved: false }).kind !== "ask") {
    return { kind: "refuse", reason: "not_offered" };
  }
  if (!isSecretName(claim.resource)) {
    return { kind: "refuse", reason: "malformed_name" };
  }
  // Checked before the run state: while an approval is open the run is
  // waiting, and an honest repeat must not count as a hostile frame.
  if (context.openApprovalExists) {
    return { kind: "refuse", reason: "approval_open" };
  }
  if (!context.runRunning) {
    return { kind: "refuse", reason: "run_not_running" };
  }
  if (context.admittedThisRun >= MAX_APPROVALS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_requests" };
  }
  if (!context.declaredOptional.includes(claim.resource)) {
    return { kind: "refuse", reason: "not_declared" };
  }
  if (context.suppliedThisGeneration.includes(claim.resource)) {
    return { kind: "refuse", reason: "already_supplied" };
  }
  if (context.deniedThisRun.includes(claim.resource)) {
    return { kind: "refuse", reason: "already_denied" };
  }
  return { kind: "candidate", name: claim.resource };
}

export type SavedCheck =
  | { readonly kind: "admit"; readonly name: string }
  | { readonly kind: "refuse"; readonly reason: "not_saved" };

export function settleSavedCheck(name: string, saved: boolean): SavedCheck {
  return saved ? { kind: "admit", name } : { kind: "refuse", reason: "not_saved" };
}

const UNCOUNTED: readonly RequestRefusal[] = [
  "approval_open",
  "already_supplied",
  "already_denied",
];

/**
 * Whether a refusal counts toward closing the socket. The uncounted three are
 * honest repeats that cost only keyed local reads (and are not logged, so the
 * sandbox cannot fill a log); `not_saved` counts because it costs a D1 read.
 */
export function isCountedRefusal(reason: RequestRefusal): boolean {
  return !UNCOUNTED.includes(reason);
}

export type ApprovalCard = Pick<
  RequestedPayload,
  "title" | "intendedAction" | "category" | "risk" | "resource" | "requestedScope" | "expiresAt"
>;

/** What the user is shown, in the object's words. `name` has passed `isSecretName`. */
export function cardFor(input: {
  readonly name: string;
  readonly generation: number;
  readonly now: string;
  readonly ttlMs: number;
}): ApprovalCard {
  return {
    title: `Supply ${input.name}`,
    intendedAction: `Give this session the saved development secret ${input.name}. The repository's code can read it, and the model provider may see it.`,
    category: "development_secret",
    risk: "medium",
    resource: input.name,
    requestedScope: `This session's sandbox (generation ${input.generation}), until it stops`,
    expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
  };
}

export interface OpenApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly expiresAtMs: number;
  /** The waiting tool call is gone: its generation ended or its run stopped waiting without a decision. */
  readonly orphaned: boolean;
}

export interface ApprovalExpiry {
  readonly approvalId: string;
  readonly runId: string;
  readonly effect: ExpiryEffect;
}

/**
 * Silence denies: a past-deadline approval expires with `tool_denied`. An
 * orphaned one expires with `run_paused`, which resumes nothing, and no
 * decision is carried to a new sandbox because the waiting call died with its
 * process.
 */
export function planSweep(
  open: readonly OpenApproval[],
  nowMs: number,
): { readonly expire: readonly ApprovalExpiry[] } {
  const expire: ApprovalExpiry[] = [];
  for (const approval of open) {
    if (approval.orphaned) {
      expire.push({ approvalId: approval.approvalId, runId: approval.runId, effect: "run_paused" });
    } else if (approval.expiresAtMs <= nowMs) {
      expire.push({
        approvalId: approval.approvalId,
        runId: approval.runId,
        effect: "tool_denied",
      });
    }
  }
  return { expire };
}
