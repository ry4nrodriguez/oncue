// The completion gate (record 14): the bridge proposes `run.verified`, and this
// decides whether the object's own check rows back it. Each refusal reason
// becomes a warning on the `run.completed_with_warnings` committed instead.
// The bridge's counts are only a cross-check, never the evidence.

import type { PayloadOf } from "@oncue/protocol";

export type CheckResult = PayloadOf<"verification.result">["result"];
export type CheckClassification = PayloadOf<"verification.started">["classification"];

/** One `verification_check` row. `result` is null until the attempt's `verification.result` committed. */
export interface CheckRecord {
  readonly checkId: string;
  readonly attempt: number;
  readonly sandboxGeneration: number;
  readonly classification: CheckClassification;
  readonly revision: string;
  readonly result: CheckResult | null;
  readonly evidenceArtifactId: string | null;
}

/** The `run_verification` row: the bridge's rollup, recorded from `verification.completed`. */
export interface VerificationSummaryRecord {
  readonly requiredTotal: number;
  readonly userSkippedCount: number;
  readonly sandboxGeneration: number;
}

export interface VerifiedClaim {
  /** The run row's outcome, or null while the run is open or has no row. */
  readonly runOutcome: string | null;
  readonly attachedGeneration: number;
  readonly summary: VerificationSummaryRecord | null;
  /** Every row for the run, any classification, any attempt. */
  readonly checks: readonly CheckRecord[];
  /** Artifact ids whose `artifact` row is `created`: the upload finished and R2 confirmed it. */
  readonly committedArtifactIds: Pick<ReadonlySet<string>, "has">;
  /**
   * Required secrets the launch recorded as missing (record 08), from the
   * object's rows: checks passing without them do not show the project works.
   */
  readonly missingRequiredSecrets: readonly string[];
  readonly declarationInvalid: boolean;
}

export type RefusalReason =
  | { readonly kind: "run_already_ended" }
  | { readonly kind: "no_verification_summary" }
  | { readonly kind: "no_required_checks" }
  | { readonly kind: "user_skipped" }
  | { readonly kind: "required_missing"; readonly recorded: number; readonly claimed: number }
  | {
      readonly kind: "required_not_passed";
      readonly checkId: string;
      readonly result: CheckResult | null;
    }
  | { readonly kind: "older_generation"; readonly checkId: string }
  | { readonly kind: "mixed_revisions" }
  | { readonly kind: "evidence_missing"; readonly checkId: string }
  /** Record 08: the session started without a required development secret. */
  | { readonly kind: "required_secret_missing"; readonly names: readonly string[] }
  /** Record 08: the project file was refused, so the session started without secrets. */
  | { readonly kind: "project_file_invalid" };

export type VerifiedJudgement =
  | { readonly kind: "accept" }
  | { readonly kind: "refuse"; readonly reasons: readonly RefusalReason[] };

export interface CompletionWarning {
  readonly text: string;
  readonly recommendedAction: string;
}

type WarningTable = {
  readonly [K in RefusalReason["kind"]]: (
    reason: Extract<RefusalReason, { readonly kind: K }>,
  ) => CompletionWarning;
};

const RERUN = "Run the required checks again and let the run end on their result.";

/** One warning per reason, in the words the timeline shows. */
export const REFUSAL_WARNINGS: WarningTable = {
  run_already_ended: () => ({
    text: "The sandbox reported this run as verified after it had already ended.",
    recommendedAction: "No action: the run keeps the outcome it ended with.",
  }),
  no_verification_summary: () => ({
    text: "The sandbox claimed the run was verified without finishing verification.",
    recommendedAction: RERUN,
  }),
  no_required_checks: () => ({
    text: "No required check was recorded, so nothing proves the change works.",
    recommendedAction:
      "Declare a test or typecheck command in .oncue/project.yaml or package.json and run again.",
  }),
  user_skipped: () => ({
    text: "A required check was skipped at your request, so the run cannot be verified.",
    recommendedAction: "Run the skipped check before merging.",
  }),
  required_missing: (reason) => ({
    text: `The sandbox claimed ${reason.claimed} required checks but recorded ${reason.recorded}.`,
    recommendedAction: RERUN,
  }),
  required_not_passed: (reason) => ({
    text: `Required check ${reason.checkId} ${describeResult(reason.result)}.`,
    recommendedAction: RERUN,
  }),
  older_generation: (reason) => ({
    text: `Required check ${reason.checkId} ran in an earlier sandbox, not the one that finished this run.`,
    recommendedAction: RERUN,
  }),
  mixed_revisions: () => ({
    text: "The required checks ran against different revisions of the change.",
    recommendedAction: RERUN,
  }),
  evidence_missing: (reason) => ({
    text: `The output of required check ${reason.checkId} was not stored.`,
    recommendedAction: RERUN,
  }),
  project_file_invalid: () => ({
    text: "This session started without secrets because .oncue/project.yaml could not be read exactly, so passing checks do not show the project works as declared.",
    recommendedAction:
      "Fix the project file at the line the launch named, and start a new session.",
  }),
  required_secret_missing: (reason) => ({
    text: `This session started without the required secret${reason.names.length === 1 ? "" : "s"} ${reason.names.join(", ")}, so passing checks do not show the project works.`,
    recommendedAction:
      "Save the value under Settings, Repositories, Secrets, and start a new session.",
  }),
};

function describeResult(result: CheckResult | null): string {
  switch (result) {
    case null:
      return "has no result";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "was skipped";
    case "inconclusive":
      return "was inconclusive";
  }
}

export function warningsFor(reasons: readonly RefusalReason[]): CompletionWarning[] {
  return reasons.map((reason) =>
    (REFUSAL_WARNINGS[reason.kind] as (reason: RefusalReason) => CompletionWarning)(reason),
  );
}

/** The newest attempt of every check the run recorded, keyed by check id. */
function latestAttempts(checks: readonly CheckRecord[]): readonly CheckRecord[] {
  const latest = new Map<string, CheckRecord>();
  for (const check of checks) {
    const seen = latest.get(check.checkId);
    if (seen === undefined || check.attempt > seen.attempt) {
      latest.set(check.checkId, check);
    }
  }
  return [...latest.values()];
}

/**
 * Verified (record 14) means every required check passed in the finishing
 * sandbox, at one revision, with evidence stored. Every applicable reason is
 * reported, not just the first, and records from another generation never count.
 */
export function judgeVerifiedClaim(claim: VerifiedClaim): VerifiedJudgement {
  const reasons: RefusalReason[] = [];
  if (claim.runOutcome !== null) {
    reasons.push({ kind: "run_already_ended" });
  }
  if (claim.missingRequiredSecrets.length > 0) {
    reasons.push({ kind: "required_secret_missing", names: claim.missingRequiredSecrets });
  }
  if (claim.declarationInvalid) {
    reasons.push({ kind: "project_file_invalid" });
  }
  const summary =
    claim.summary !== null && claim.summary.sandboxGeneration === claim.attachedGeneration
      ? claim.summary
      : null;
  if (summary === null) {
    reasons.push({ kind: "no_verification_summary" });
  } else if (summary.userSkippedCount > 0) {
    reasons.push({ kind: "user_skipped" });
  }
  const required = latestAttempts(claim.checks).filter(
    (check) => check.classification === "required",
  );
  if (required.length === 0) {
    reasons.push({ kind: "no_required_checks" });
  } else if (summary !== null && required.length < summary.requiredTotal) {
    reasons.push({
      kind: "required_missing",
      recorded: required.length,
      claimed: summary.requiredTotal,
    });
  }
  const revisions = new Set<string>();
  for (const check of required) {
    if (check.sandboxGeneration !== claim.attachedGeneration) {
      reasons.push({ kind: "older_generation", checkId: check.checkId });
      continue;
    }
    revisions.add(check.revision);
    if (check.result !== "passed") {
      reasons.push({ kind: "required_not_passed", checkId: check.checkId, result: check.result });
    } else if (
      check.evidenceArtifactId === null ||
      !claim.committedArtifactIds.has(check.evidenceArtifactId)
    ) {
      reasons.push({ kind: "evidence_missing", checkId: check.checkId });
    }
  }
  if (revisions.size > 1) {
    reasons.push({ kind: "mixed_revisions" });
  }
  return reasons.length === 0 ? { kind: "accept" } : { kind: "refuse", reasons };
}
