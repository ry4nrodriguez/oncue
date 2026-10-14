import { describe, expect, it } from "vitest";
import {
  type CheckRecord,
  judgeVerifiedClaim,
  REFUSAL_WARNINGS,
  type RefusalReason,
  type VerifiedClaim,
  warningsFor,
} from "./completion";

const REVISION = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const OTHER_REVISION = "1e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";

function check(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    checkId: "chk_test",
    attempt: 1,
    sandboxGeneration: 1,
    classification: "required",
    revision: REVISION,
    result: "passed",
    evidenceArtifactId: "art_test",
    ...overrides,
  };
}

/** A claim the gate accepts: one required check, passed in the attached generation, with its log stored. */
function backedClaim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    runOutcome: null,
    attachedGeneration: 1,
    summary: { requiredTotal: 1, userSkippedCount: 0, sandboxGeneration: 1 },
    checks: [check()],
    committedArtifactIds: new Set(["art_test"]),
    missingRequiredSecrets: [],
    declarationInvalid: false,
    ...overrides,
  };
}

function reasonsOf(claim: VerifiedClaim): readonly RefusalReason[] {
  const judgement = judgeVerifiedClaim(claim);
  return judgement.kind === "refuse" ? judgement.reasons : [];
}

describe("judgeVerifiedClaim", () => {
  it("accepts a claim every required check backs, in the attached generation, with evidence stored", () => {
    expect(judgeVerifiedClaim(backedClaim())).toEqual({ kind: "accept" });
  });

  it("judges the newest attempt of each check and ignores recommended and informational ones", () => {
    // Attempts arrive in any order: the newest wins whichever way they come.
    const claim = backedClaim({
      checks: [
        check({ attempt: 1, result: "failed", evidenceArtifactId: null }),
        check({ attempt: 3 }),
        check({ attempt: 2, result: "inconclusive" }),
        check({ checkId: "chk_lint", classification: "recommended", result: "failed" }),
        check({ checkId: "chk_note", classification: "informational", result: null }),
      ],
    });
    expect(judgeVerifiedClaim(claim)).toEqual({ kind: "accept" });
  });

  it("refuses a session that started without a required secret, however green the checks", () => {
    expect(
      reasonsOf(backedClaim({ missingRequiredSecrets: ["DATABASE_URL", "REDIS_URL"] })),
    ).toEqual([{ kind: "required_secret_missing", names: ["DATABASE_URL", "REDIS_URL"] }]);
    expect(judgeVerifiedClaim(backedClaim({ missingRequiredSecrets: [] }))).toEqual({
      kind: "accept",
    });
  });

  it("refuses a run that already has an outcome", () => {
    expect(reasonsOf(backedClaim({ runOutcome: "completed_with_warnings" }))).toEqual([
      { kind: "run_already_ended" },
    ]);
  });

  it("refuses a claim with no verification summary, or one from another generation", () => {
    expect(reasonsOf(backedClaim({ summary: null }))).toEqual([
      { kind: "no_verification_summary" },
    ]);
    expect(
      reasonsOf(
        backedClaim({
          summary: { requiredTotal: 1, userSkippedCount: 0, sandboxGeneration: 0 },
        }),
      ),
    ).toEqual([{ kind: "no_verification_summary" }]);
  });

  it("refuses a run with no required check recorded", () => {
    expect(reasonsOf(backedClaim({ checks: [] }))).toEqual([{ kind: "no_required_checks" }]);
    expect(reasonsOf(backedClaim({ checks: [check({ classification: "recommended" })] }))).toEqual([
      { kind: "no_required_checks" },
    ]);
  });

  it("refuses a claim whose user skipped a required check", () => {
    expect(
      reasonsOf(
        backedClaim({
          summary: { requiredTotal: 1, userSkippedCount: 1, sandboxGeneration: 1 },
          checks: [check({ result: "skipped", evidenceArtifactId: null })],
        }),
      ),
    ).toEqual([
      { kind: "user_skipped" },
      { kind: "required_not_passed", checkId: "chk_test", result: "skipped" },
    ]);
  });

  it("refuses a claim that names more required checks than were recorded", () => {
    expect(
      reasonsOf(
        backedClaim({ summary: { requiredTotal: 2, userSkippedCount: 0, sandboxGeneration: 1 } }),
      ),
    ).toEqual([{ kind: "required_missing", recorded: 1, claimed: 2 }]);
  });

  it.each([
    ["failed", "failed"],
    ["inconclusive", "inconclusive"],
    ["no result yet", null],
  ] as const)("refuses a required check that %s", (_name, result) => {
    expect(reasonsOf(backedClaim({ checks: [check({ result })] }))).toEqual([
      { kind: "required_not_passed", checkId: "chk_test", result },
    ]);
  });

  it("refuses a required check recorded in an earlier generation, whatever its result", () => {
    expect(
      reasonsOf(backedClaim({ checks: [check({ sandboxGeneration: 0 })], attachedGeneration: 1 })),
    ).toEqual([{ kind: "older_generation", checkId: "chk_test" }]);
  });

  it("refuses required checks that ran at different revisions", () => {
    expect(
      reasonsOf(
        backedClaim({
          summary: { requiredTotal: 2, userSkippedCount: 0, sandboxGeneration: 1 },
          checks: [check(), check({ checkId: "chk_types", revision: OTHER_REVISION })],
        }),
      ),
    ).toEqual([{ kind: "mixed_revisions" }]);
  });

  it("refuses a passed check whose evidence is missing or not yet committed", () => {
    expect(reasonsOf(backedClaim({ checks: [check({ evidenceArtifactId: null })] }))).toEqual([
      { kind: "evidence_missing", checkId: "chk_test" },
    ]);
    expect(reasonsOf(backedClaim({ committedArtifactIds: new Set() }))).toEqual([
      { kind: "evidence_missing", checkId: "chk_test" },
    ]);
  });

  it("reports every reason that applies, not only the first", () => {
    const reasons = reasonsOf(
      backedClaim({
        runOutcome: "failed",
        summary: null,
        checks: [check({ result: "failed" }), check({ checkId: "chk_old", sandboxGeneration: 0 })],
      }),
    );
    expect(reasons.map((reason) => reason.kind)).toEqual([
      "run_already_ended",
      "no_verification_summary",
      "required_not_passed",
      "older_generation",
    ]);
  });
});

describe("warningsFor", () => {
  it("names every reason in the user's terms, one warning per reason", () => {
    const reasons: RefusalReason[] = [
      { kind: "run_already_ended" },
      { kind: "no_verification_summary" },
      { kind: "no_required_checks" },
      { kind: "user_skipped" },
      { kind: "required_missing", recorded: 1, claimed: 2 },
      { kind: "required_not_passed", checkId: "chk_a", result: "failed" },
      { kind: "required_not_passed", checkId: "chk_b", result: "skipped" },
      { kind: "required_not_passed", checkId: "chk_c", result: "inconclusive" },
      { kind: "required_not_passed", checkId: "chk_d", result: null },
      { kind: "required_not_passed", checkId: "chk_e", result: "passed" },
      { kind: "older_generation", checkId: "chk_f" },
      { kind: "mixed_revisions" },
      { kind: "evidence_missing", checkId: "chk_g" },
      { kind: "required_secret_missing", names: ["DATABASE_URL"] },
    ];
    const warnings = warningsFor(reasons);
    expect(warnings).toHaveLength(reasons.length);
    expect(warnings.map((warning) => warning.text)).toEqual([
      "The sandbox reported this run as verified after it had already ended.",
      "The sandbox claimed the run was verified without finishing verification.",
      "No required check was recorded, so nothing proves the change works.",
      "A required check was skipped at your request, so the run cannot be verified.",
      "The sandbox claimed 2 required checks but recorded 1.",
      "Required check chk_a failed.",
      "Required check chk_b was skipped.",
      "Required check chk_c was inconclusive.",
      "Required check chk_d has no result.",
      "Required check chk_e passed.",
      "Required check chk_f ran in an earlier sandbox, not the one that finished this run.",
      "The required checks ran against different revisions of the change.",
      "The output of required check chk_g was not stored.",
      "This session started without the required secret DATABASE_URL, so passing checks do not show the project works.",
    ]);
    for (const warning of warnings) {
      expect(warning.recommendedAction.length).toBeGreaterThan(0);
    }
  });

  it("names several missing secrets in the plural", () => {
    expect(
      warningsFor([{ kind: "required_secret_missing", names: ["DATABASE_URL", "REDIS_URL"] }])[0]
        ?.text,
    ).toBe(
      "This session started without the required secrets DATABASE_URL, REDIS_URL, so passing checks do not show the project works.",
    );
  });

  it("has an entry for every reason", () => {
    expect(Object.keys(REFUSAL_WARNINGS).sort()).toEqual(
      [
        "evidence_missing",
        "mixed_revisions",
        "no_required_checks",
        "no_verification_summary",
        "older_generation",
        "required_missing",
        "required_not_passed",
        "required_secret_missing",
        "project_file_invalid",
        "run_already_ended",
        "user_skipped",
      ].sort(),
    );
  });
});

describe("a project file the reader refused", () => {
  it("refuses a verified claim with its own reason and words", () => {
    const judgement = judgeVerifiedClaim(backedClaim({ declarationInvalid: true }));
    expect(judgement).toMatchObject({ kind: "refuse" });
    const reasons = judgement.kind === "refuse" ? judgement.reasons : [];
    expect(reasons).toContainEqual({ kind: "project_file_invalid" });
    expect(JSON.stringify(warningsFor(reasons))).toContain("could not be read exactly");
  });
});
