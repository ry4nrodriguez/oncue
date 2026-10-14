import { defineFamily } from "../define";
import {
  artifactRef,
  boolean,
  boundedList,
  checkId,
  counter,
  exactOptional,
  literal,
  nullable,
  number,
  picklist,
  sha,
  shortText,
  strictObject,
  summaryText,
  variant,
} from "../schema";

export const verificationResult = picklist(["passed", "failed", "skipped", "inconclusive"]);
export const checkClassification = picklist(["required", "recommended", "informational"]);
export const checkSource = picklist(["repository_requirement", "change_aware", "user_instruction"]);

export const verificationMethod = variant("kind", [
  strictObject({ kind: literal("command"), command: summaryText, cwd: nullable(shortText) }),
  strictObject({ kind: literal("browser"), url: shortText, interaction: nullable(summaryText) }),
  strictObject({ kind: literal("review"), description: summaryText }),
]);

const testStatus = picklist(["passed", "failed", "skipped", "running"]);

// The shape AI Elements' TestResults renders, passed through unchanged.
export const testSummary = strictObject({
  passed: counter,
  failed: counter,
  skipped: counter,
  total: counter,
  durationMs: exactOptional(counter),
  suites: boundedList(
    strictObject({
      name: shortText,
      status: testStatus,
      tests: boundedList(
        strictObject({
          name: shortText,
          status: testStatus,
          durationMs: exactOptional(counter),
          error: exactOptional(
            strictObject({ message: summaryText, stack: exactOptional(summaryText) }),
          ),
        }),
      ),
    }),
  ),
});

const outcomeCounts = strictObject({
  total: counter,
  passed: counter,
  failed: counter,
  skipped: counter,
  inconclusive: counter,
});

export const VERIFICATION_EVENTS = defineFamily("verification", {
  "verification.started": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      checkId,
      name: shortText,
      category: shortText,
      classification: checkClassification,
      source: checkSource,
      method: verificationMethod,
      revision: sha,
      baseRevision: nullable(sha),
      attempt: counter,
      // Record 14: why this check applies, e.g. "package.json script test".
      reason: shortText,
    }),
  },
  // Emitted per attempt: record 14 records every attempt, not only the passing
  // one. The outcome enum stays at record 14's four values; "unavailable" and
  // "could not run" are skip reasons rather than fifth and sixth outcomes.
  "verification.result": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      checkId,
      attempt: counter,
      result: verificationResult,
      skipReason: nullable(
        picklist([
          "not_applicable",
          "user_requested",
          "unavailable",
          "could_not_run",
          "environment_failed",
        ]),
      ),
      inconclusiveReason: nullable(
        picklist(["flaky", "timeout", "incomplete_evidence", "base_not_comparable"]),
      ),
      exitCode: nullable(number()),
      durationMs: counter,
      summary: summaryText,
      baseComparison: picklist([
        "not_compared",
        "new_failure",
        "reproduced_on_base",
        "not_comparable",
      ]),
      structured: nullable(testSummary),
      evidence: boundedList(artifactRef),
    }),
  },
  // Record 14: the control plane validates a verified outcome against these
  // counts, so the rollup is data the Durable Object can check.
  "verification.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      proposedOutcome: picklist([
        "verified",
        "completed_with_warnings",
        "blocked",
        "failed",
        "cancelled",
      ]),
      required: outcomeCounts,
      recommended: outcomeCounts,
      warnings: boundedList(summaryText),
      userSkipped: boundedList(checkId),
      baselineComparisonAvailable: boolean(),
    }),
  },
});
