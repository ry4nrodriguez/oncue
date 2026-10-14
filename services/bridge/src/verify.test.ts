import { parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { bridgeConfig, type Draft, type SequenceCursor, stampDraft } from "./protocol";
import type { ResolvedDefinition } from "./repo-config";
import {
  BASE_COMPARISON_BUDGET_MS,
  CANCEL_GRACE_MS,
  CHECK_TIMEOUT_MS,
  type CheckRecord,
  type CheckRunOutcome,
  LOG_CONTENT_TYPE,
  MAX_CHECKS_PER_RUN,
  NO_CHECKS_WARNING,
  NO_REQUIRED_WARNING,
  type PlannedCheck,
  planChecks,
  proposedOutcome,
  RUN_ARTIFACT_BYTES,
  type RunFacts,
  SUMMARY_TAIL_CHARS,
  startVerification,
  stepVerify,
  tailOf,
  type VerifyContext,
  type VerifyEffect,
  type VerifyInput,
  type VerifyOutcome,
  type VerifyState,
} from "./verify";

const CONFIG = bridgeConfig(
  { sessionId: "sess_1", generation: 3, bootstrapCredential: "boot" },
  "wss://oncue.example",
);
const REVISION = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const BASE = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const FACTS: RunFacts = {
  runId: "run_1",
  whatChanged: "Added a README section.",
  why: "Requested: Add a README section.",
  branch: "oncue/readme",
  startedAtMs: 1_000,
};

function project(
  commands: Partial<Record<"test" | "typecheck" | "lint" | "build" | "dev", string>>,
  source: "detected" | "repository_file" = "detected",
): ResolvedDefinition {
  const entry = (value: string | undefined) =>
    value === undefined ? { value: null, source: "platform_default" as const } : { value, source };
  return {
    commands: {
      dev: entry(commands.dev),
      test: entry(commands.test),
      lint: entry(commands.lint),
      typecheck: entry(commands.typecheck),
      build: entry(commands.build),
    },
    preview: { value: null, source: "platform_default" },
  };
}

/** A clock the test advances and ids it can predict. */
class World {
  nowMs = 10_000;
  private issued = 0;
  readonly emitted: Draft[] = [];
  ctx(): VerifyContext {
    return { nowMs: this.nowMs, newId: () => `id_${++this.issued}` };
  }
  /** Every emitted draft must survive the real parser. */
  take(result: VerifyOutcome): VerifyOutcome {
    const cursor: SequenceCursor = { next: 0 };
    const io = { newEventId: () => "evt", now: () => "2026-09-16T00:00:00.000Z" };
    for (const effect of result.effects) {
      if (effect.kind === "emit") {
        const parsed = parseEventJson(
          JSON.stringify(stampDraft(CONFIG, cursor, io, effect.draft)),
          "sandbox",
        );
        expect(parsed.ok, `${effect.draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
        this.emitted.push(effect.draft);
      }
    }
    return result;
  }
  start(
    checks: readonly PlannedCheck[],
    overrides: Partial<{ skipRequired: boolean; baseRevision: string | null }> = {},
  ): VerifyOutcome {
    return this.take(
      startVerification(
        {
          facts: FACTS,
          checks,
          revision: REVISION,
          baseRevision: overrides.baseRevision === undefined ? BASE : overrides.baseRevision,
          skipRequired: overrides.skipRequired ?? false,
        },
        this.ctx(),
      ),
    );
  }
  step(state: VerifyState, input: VerifyInput): VerifyOutcome {
    return this.take(stepVerify(state, input, this.ctx()));
  }
  types(): string[] {
    return this.emitted.map((entry) => entry.type);
  }
  last<T extends Draft["type"]>(type: T): Extract<Draft, { type: T }> {
    const found = [...this.emitted].reverse().find((entry) => entry.type === type);
    if (found === undefined) {
      throw new Error(`nothing emitted of type ${type}`);
    }
    return found as Extract<Draft, { type: T }>;
  }
  all<T extends Draft["type"]>(type: T): Extract<Draft, { type: T }>[] {
    return this.emitted.filter((entry) => entry.type === type) as Extract<Draft, { type: T }>[];
  }
}

function check(
  name: "install" | "test" | "typecheck" | "lint" | "build",
  overrides: Partial<PlannedCheck> = {},
): PlannedCheck {
  const classification =
    name === "install"
      ? "informational"
      : name === "test" || name === "typecheck"
        ? "required"
        : "recommended";
  return {
    checkId: `chk_${name}`,
    name,
    category: name === "install" ? "setup" : name,
    classification,
    command: name === "install" ? "pnpm install --frozen-lockfile" : `pnpm run ${name}`,
    reason: `package.json has a ${name} script`,
    ...overrides,
  };
}

function exited(
  exitCode: number | null,
  overrides: Partial<CheckRunOutcome> = {},
): CheckRunOutcome {
  return {
    kind: "exited",
    exitCode,
    signal: null,
    timedOut: false,
    durationMs: 250,
    logBytes: 42,
    tail: exitCode === 0 ? "ok\n" : "not ok\n",
    ...overrides,
  } as CheckRunOutcome;
}

function running(outcome: VerifyOutcome): Extract<VerifyEffect, { kind: "run_check" }> {
  const effect = outcome.effects.find((entry) => entry.kind === "run_check");
  if (effect === undefined || effect.kind !== "run_check") {
    throw new Error(`expected a run_check among ${outcome.effects.map((e) => e.kind).join(", ")}`);
  }
  return effect;
}

function staged(outcome: VerifyOutcome): Extract<VerifyEffect, { kind: "stage_log" }> {
  const effect = outcome.effects.find((entry) => entry.kind === "stage_log");
  if (effect === undefined || effect.kind !== "stage_log") {
    throw new Error(`expected a stage_log among ${outcome.effects.map((e) => e.kind).join(", ")}`);
  }
  return effect;
}

/** Settle the running check, then its log's upload. */
function settleWithLog(
  world: World,
  outcome: VerifyOutcome,
  result: CheckRunOutcome,
  uploaded = true,
): VerifyOutcome {
  const settled = world.step(outcome.state, {
    kind: "check_settled",
    checkRunId: running(outcome).checkRunId,
    outcome: result,
  });
  return world.step(settled.state, {
    kind: "upload_settled",
    artifactId: staged(settled).artifactId,
    ok: uploaded,
  });
}

describe("planChecks: the classification table", () => {
  let n = 0;
  const ids = () => `id_${++n}`;

  it("installs first, then test and typecheck as required, then lint and build as recommended, never dev", () => {
    const checks = planChecks(
      project({
        dev: "pnpm run dev",
        build: "pnpm run build",
        lint: "pnpm run lint",
        typecheck: "pnpm run typecheck",
        test: "pnpm run test",
      }),
      { command: "pnpm install --frozen-lockfile", lockfile: "pnpm-lock.yaml" },
      ids,
    );
    expect(checks.map((entry) => [entry.name, entry.category, entry.classification])).toEqual([
      ["install", "setup", "informational"],
      ["test", "test", "required"],
      ["typecheck", "typecheck", "required"],
      ["lint", "lint", "recommended"],
      ["build", "build", "recommended"],
    ]);
    expect(checks[0]?.reason).toBe("pnpm-lock.yaml is committed");
    expect(checks[1]?.reason).toBe("package.json has a test script");
    expect(new Set(checks.map((entry) => entry.checkId)).size).toBe(checks.length);
  });

  it("names the repository file when that is where the command came from", () => {
    const [only] = planChecks(project({ test: "make test" }, "repository_file"), null, ids);
    expect(only).toMatchObject({
      command: "make test",
      reason: ".oncue/project.yaml declares commands.test",
    });
  });

  it("plans nothing without a repository, without commands, or with only a dev server", () => {
    const install = { command: "npm ci", lockfile: "package-lock.json" };
    expect(planChecks(null, install, ids)).toEqual([]);
    expect(planChecks(project({}), install, ids)).toEqual([]);
    expect(planChecks(project({ dev: "vite" }), install, ids)).toEqual([]);
  });

  it("never plans more than ten", () => {
    expect(MAX_CHECKS_PER_RUN).toBe(10);
  });
});

describe("startVerification", () => {
  it("with no checks ends at once with warnings saying none were declared", () => {
    const world = new World();
    const outcome = world.start([]);

    expect(outcome.state.step).toEqual({ kind: "done" });
    expect(world.types()).toEqual(["run.completed_with_warnings"]);
    expect(world.last("run.completed_with_warnings").payload).toMatchObject({
      warnings: [NO_CHECKS_WARNING],
      summary: { verificationPerformed: "None: no checks were declared" },
      evidence: [],
      branch: "oncue/readme",
      durationMs: 9_000,
    });
  });

  it("starts the first check in the workspace under the ten-minute limit", () => {
    const world = new World();
    const outcome = world.start([check("test")]);

    expect(world.types()).toEqual(["verification.started"]);
    expect(world.last("verification.started").payload).toEqual({
      checkId: "chk_test",
      name: "test",
      category: "test",
      classification: "required",
      source: "repository_requirement",
      method: { kind: "command", command: "pnpm run test", cwd: null },
      revision: REVISION,
      baseRevision: BASE,
      attempt: 1,
      reason: "package.json has a test script",
    });
    expect(running(outcome)).toEqual({
      kind: "run_check",
      checkRunId: "id_1",
      command: "pnpm run test",
      where: { kind: "workspace" },
      timeoutMs: CHECK_TIMEOUT_MS,
    });
  });
});

describe("one passing check, end to end", () => {
  it("started, log declared, result with the log in evidence, completed, verified", () => {
    const world = new World();
    let outcome = world.start([check("test")]);
    const settled = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: exited(0),
    });
    expect(world.last("artifact.uploading").payload).toEqual({
      artifactId: "id_2",
      kind: "log",
      contentType: LOG_CONTENT_TYPE,
      declaredBytes: 42,
      producer: "verification",
    });
    expect(staged(settled)).toEqual({ kind: "stage_log", artifactId: "id_2", checkRunId: "id_1" });
    world.nowMs = 20_000;
    outcome = world.step(settled.state, { kind: "upload_settled", artifactId: "id_2", ok: true });

    expect(world.types()).toEqual([
      "verification.started",
      "artifact.uploading",
      "verification.result",
      "verification.completed",
      "run.verified",
    ]);
    const evidence = {
      artifactId: "id_2",
      kind: "log",
      contentType: LOG_CONTENT_TYPE,
      byteSize: 42,
      label: "test output, attempt 1",
    };
    expect(world.last("verification.result").payload).toEqual({
      checkId: "chk_test",
      attempt: 1,
      result: "passed",
      skipReason: null,
      inconclusiveReason: null,
      exitCode: 0,
      durationMs: 250,
      summary: "ok\n",
      baseComparison: "not_compared",
      structured: null,
      evidence: [evidence],
    });
    expect(world.last("verification.completed").payload).toEqual({
      proposedOutcome: "verified",
      required: { total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0 },
      recommended: { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0 },
      warnings: [],
      userSkipped: [],
      baselineComparisonAvailable: false,
    });
    expect(world.last("run.verified").payload).toEqual({
      summary: {
        whatChanged: "Added a README section.",
        why: "Requested: Add a README section.",
        verificationPerformed: "test passed",
        limitations: [],
        nextStep: null,
      },
      evidence: [evidence],
      branch: "oncue/readme",
      pullRequestNumber: null,
      usage: null,
      durationMs: 19_000,
    });
    expect(outcome.state.step).toEqual({ kind: "done" });
  });

  it("keeps the last 4,000 characters of output as the summary", () => {
    const long = `${"a".repeat(10)}${"b".repeat(SUMMARY_TAIL_CHARS)}`;
    expect(tailOf(long)).toBe("b".repeat(SUMMARY_TAIL_CHARS));
    const world = new World();
    settleWithLog(world, world.start([check("test")]), exited(0, { tail: tailOf(long) }));
    expect(world.last("verification.result").payload.summary).toBe("b".repeat(SUMMARY_TAIL_CHARS));
  });

  it("records a result with no evidence when the log never landed, so the object will not verify it", () => {
    const world = new World();
    settleWithLog(world, world.start([check("test")]), exited(0), false);
    expect(world.last("verification.result").payload.evidence).toEqual([]);
    expect(world.last("run.verified").payload.evidence).toEqual([]);
  });

  it("does not ask for more artifact bytes than a run may hold", () => {
    const world = new World();
    const outcome = world.start([check("test")]);
    const settled = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: exited(0, { logBytes: RUN_ARTIFACT_BYTES + 1 }),
    });
    expect(settled.effects.some((effect) => effect.kind === "stage_log")).toBe(false);
    expect(world.types()).not.toContain("artifact.uploading");
    expect(world.last("verification.result").payload.evidence).toEqual([]);
  });
});

describe("the install step", () => {
  it("installs, then runs the checks", () => {
    const world = new World();
    let outcome = world.start([check("install"), check("test")]);
    expect(running(outcome).command).toBe("pnpm install --frozen-lockfile");
    outcome = settleWithLog(world, outcome, exited(0));
    expect(running(outcome).command).toBe("pnpm run test");
    outcome = settleWithLog(world, outcome, exited(0));
    expect(world.last("verification.completed").payload.proposedOutcome).toBe("verified");
    expect(world.last("run.verified").payload.evidence).toHaveLength(1);
  });

  it("a failed install skips every later check with environment_failed and ends with warnings", () => {
    const world = new World();
    const outcome = settleWithLog(
      world,
      world.start([check("install"), check("test"), check("lint")]),
      exited(1),
    );

    expect(outcome.effects.some((effect) => effect.kind === "run_check")).toBe(false);
    const results = world.all("verification.result").map((entry) => entry.payload);
    expect(results.map((entry) => [entry.checkId, entry.result, entry.skipReason])).toEqual([
      ["chk_install", "failed", null],
      ["chk_test", "skipped", "environment_failed"],
      ["chk_lint", "skipped", "environment_failed"],
    ]);
    expect(world.all("verification.started")).toHaveLength(3);
    expect(world.last("verification.completed").payload).toMatchObject({
      proposedOutcome: "completed_with_warnings",
      required: { total: 1, skipped: 1 },
      recommended: { total: 1, skipped: 1 },
    });
    expect(world.last("run.completed_with_warnings").payload.warnings.map((w) => w.text)).toEqual([
      "Installing dependencies with pnpm install --frozen-lockfile failed",
      "Required check test was not run because installing dependencies failed",
      "Recommended check lint was not run because installing dependencies failed",
    ]);
  });

  it("an install that could not run at all counts as a failed environment too", () => {
    const world = new World();
    const outcome = world.start([check("install"), check("test")]);
    world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: { kind: "could_not_run", detail: "supervisor unreachable" },
    });
    const results = world.all("verification.result").map((entry) => entry.payload);
    expect(results.map((entry) => [entry.result, entry.skipReason])).toEqual([
      ["skipped", "could_not_run"],
      ["skipped", "environment_failed"],
    ]);
    expect(results[0]?.summary).toBe("Could not run: supervisor unreachable");
    expect(world.types()).not.toContain("artifact.uploading");
  });
});

describe("the user's skip", () => {
  it("skips required checks with user_requested, still runs the rest, and ends with warnings", () => {
    const world = new World();
    let outcome = world.start([check("test"), check("typecheck"), check("lint")], {
      skipRequired: true,
    });
    expect(running(outcome).command).toBe("pnpm run lint");
    outcome = settleWithLog(world, outcome, exited(0));

    expect(
      world
        .all("verification.result")
        .map((entry) => [entry.payload.checkId, entry.payload.skipReason]),
    ).toEqual([
      ["chk_test", "user_requested"],
      ["chk_typecheck", "user_requested"],
      ["chk_lint", null],
    ]);
    expect(world.last("verification.completed").payload).toMatchObject({
      proposedOutcome: "completed_with_warnings",
      userSkipped: ["chk_test", "chk_typecheck"],
    });
    expect(world.last("run.completed_with_warnings").payload.warnings[0]).toEqual({
      text: "Required check test was skipped at your request",
      recommendedAction: "Run test before merging",
    });
  });
});

describe("retries", () => {
  it("a failed test that passes on its second attempt is inconclusive (flaky), with both attempts kept", () => {
    const world = new World();
    let outcome = world.start([check("test")]);
    outcome = settleWithLog(world, outcome, exited(1));
    expect(running(outcome).command).toBe("pnpm run test");
    outcome = settleWithLog(world, outcome, exited(0));

    const results = world.all("verification.result").map((entry) => entry.payload);
    expect(results.map((entry) => [entry.attempt, entry.result, entry.inconclusiveReason])).toEqual(
      [
        [1, "failed", null],
        [2, "inconclusive", "flaky"],
      ],
    );
    expect(results.map((entry) => entry.evidence[0]?.label)).toEqual([
      "test output, attempt 1",
      "test output, attempt 2",
    ]);
    expect(world.all("verification.started").map((entry) => entry.payload.attempt)).toEqual([1, 2]);
    expect(world.all("artifact.uploading")).toHaveLength(2);
    expect(world.last("verification.completed").payload).toMatchObject({
      proposedOutcome: "completed_with_warnings",
      required: { total: 1, inconclusive: 1 },
    });
  });

  it("never retries a failed check outside the test category", () => {
    const world = new World();
    const outcome = settleWithLog(world, world.start([check("lint")]), exited(1));
    expect(outcome.state.step).toEqual({ kind: "done" });
    expect(world.all("verification.started")).toHaveLength(1);
  });

  it("stops at two attempts", () => {
    const world = new World();
    let outcome = world.start([check("test")], { baseRevision: null });
    outcome = settleWithLog(world, outcome, exited(1));
    outcome = settleWithLog(world, outcome, exited(1));
    expect(outcome.state.step).toEqual({ kind: "done" });
    expect(world.all("verification.started")).toHaveLength(2);
  });
});

describe("timeouts", () => {
  it("a timed-out check is inconclusive (timeout), not retried and not compared", () => {
    const world = new World();
    const outcome = settleWithLog(
      world,
      world.start([check("test")]),
      exited(null, { signal: "SIGKILL", timedOut: true, durationMs: CHECK_TIMEOUT_MS }),
    );
    expect(outcome.effects.some((effect) => effect.kind === "prepare_base")).toBe(false);
    expect(world.all("verification.started")).toHaveLength(1);
    expect(world.last("verification.result").payload).toMatchObject({
      result: "inconclusive",
      inconclusiveReason: "timeout",
      baseComparison: "not_compared",
    });
    expect(world.last("run.completed_with_warnings").payload.warnings[0]?.text).toBe(
      "Required check test did not finish within 30 minutes",
    );
  });
});

describe("base comparison", () => {
  /** A required typecheck that fails, up to the prepare_base effect. */
  function failingTypecheck(world: World, checks = [check("typecheck")]) {
    const started = world.start(checks);
    const failed = world.step(started.state, {
      kind: "check_settled",
      checkRunId: running(started).checkRunId,
      outcome: exited(2),
    });
    return failed;
  }

  it("prepares the base checkout, re-runs the failing check there, and a pass there is a new failure: run.failed", () => {
    const world = new World();
    const failed = failingTypecheck(world);
    expect(failed.effects).toEqual([{ kind: "prepare_base", dir: "id_2", baseSha: BASE }]);
    expect(world.types()).toEqual(["verification.started"]);

    world.nowMs += 1_000;
    const prepared = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: true });
    expect(running(prepared)).toEqual({
      kind: "run_check",
      checkRunId: "id_3",
      command: "pnpm run typecheck",
      where: { kind: "base", dir: "id_2" },
      timeoutMs: BASE_COMPARISON_BUDGET_MS - 1_000,
    });
    const onBase = world.step(prepared.state, {
      kind: "check_settled",
      checkRunId: "id_3",
      outcome: exited(0),
    });
    expect(staged(onBase).checkRunId).toBe("id_1");
    world.step(onBase.state, {
      kind: "upload_settled",
      artifactId: staged(onBase).artifactId,
      ok: true,
    });

    expect(world.last("verification.result").payload).toMatchObject({
      result: "failed",
      exitCode: 2,
      baseComparison: "new_failure",
    });
    expect(world.last("verification.completed").payload).toMatchObject({
      proposedOutcome: "failed",
      baselineComparisonAvailable: true,
    });
    expect(world.last("run.failed").payload).toMatchObject({
      stage: "verification",
      error: {
        category: "required_check_failed",
        message: "Required check typecheck fails on this change and passes on the base revision",
      },
      summary: { verificationPerformed: "typecheck failed (passes on base)" },
    });
  });

  it("a failure on the base too is reproduced_on_base: completed with warnings", () => {
    const world = new World();
    const failed = failingTypecheck(world);
    const prepared = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: true });
    settleWithLog(world, prepared, exited(1));
    expect(world.last("verification.result").payload.baseComparison).toBe("reproduced_on_base");
    expect(world.last("run.completed_with_warnings").payload.warnings[0]).toEqual({
      text: "Required check typecheck fails, and fails on the base revision too",
      recommendedAction: "Decide whether the existing failure affects this change",
    });
  });

  it.each([
    ["the base checkout could not be made", "prepare"],
    ["the check timed out on the base", "timeout"],
    ["the check could not run on the base", "could_not_run"],
  ])("is not_comparable when %s: completed with warnings", (_name, how) => {
    const world = new World();
    const failed = failingTypecheck(world);
    let outcome: VerifyOutcome;
    if (how === "prepare") {
      const refused = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: false });
      outcome = world.step(refused.state, {
        kind: "upload_settled",
        artifactId: staged(refused).artifactId,
        ok: true,
      });
    } else {
      const prepared = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: true });
      outcome = settleWithLog(
        world,
        prepared,
        how === "timeout"
          ? exited(null, { timedOut: true, signal: "SIGKILL" })
          : { kind: "could_not_run", detail: "refused: cwd_not_allowed" },
      );
    }
    expect(outcome.state.step).toEqual({ kind: "done" });
    expect(world.last("verification.result").payload.baseComparison).toBe("not_comparable");
    expect(world.last("verification.completed").payload.proposedOutcome).toBe(
      "completed_with_warnings",
    );
  });

  it("is not_comparable once the budget is spent before the base is ready", () => {
    const world = new World();
    const failed = failingTypecheck(world);
    world.nowMs += BASE_COMPARISON_BUDGET_MS;
    const prepared = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: true });
    expect(prepared.effects.some((effect) => effect.kind === "run_check")).toBe(false);
    world.step(prepared.state, {
      kind: "upload_settled",
      artifactId: staged(prepared).artifactId,
      ok: true,
    });
    expect(world.last("verification.result").payload.baseComparison).toBe("not_comparable");
  });

  it("installs on the base first when the repository has a lockfile, once per run, and reuses the checkout", () => {
    const world = new World();
    const started = world.start([check("install"), check("test"), check("typecheck")]);
    let outcome = settleWithLog(world, started, exited(0));
    // test fails twice, then compares.
    outcome = settleWithLog(world, outcome, exited(1));
    const secondAttempt = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: exited(1),
    });
    const prepare = secondAttempt.effects[0];
    expect(prepare?.kind).toBe("prepare_base");
    const dir = prepare?.kind === "prepare_base" ? prepare.dir : "";
    const prepared = world.step(secondAttempt.state, { kind: "base_prepared", dir, ok: true });
    expect(running(prepared)).toMatchObject({
      command: "pnpm install --frozen-lockfile",
      where: { kind: "base", dir },
    });
    const installed = world.step(prepared.state, {
      kind: "check_settled",
      checkRunId: running(prepared).checkRunId,
      outcome: exited(0),
    });
    expect(running(installed)).toMatchObject({
      command: "pnpm run test",
      where: { kind: "base", dir },
    });
    outcome = settleWithLog(world, installed, exited(1));

    // typecheck fails: no second prepare, no second install.
    const typecheckFailed = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: exited(1),
    });
    expect(running(typecheckFailed)).toMatchObject({
      command: "pnpm run typecheck",
      where: { kind: "base", dir },
    });
    settleWithLog(world, typecheckFailed, exited(0));
    expect(
      world
        .all("verification.result")
        .map((entry) => [entry.payload.checkId, entry.payload.baseComparison]),
    ).toEqual([
      ["chk_install", "not_compared"],
      ["chk_test", "not_compared"],
      ["chk_test", "reproduced_on_base"],
      ["chk_typecheck", "new_failure"],
    ]);
    expect(world.last("verification.completed").payload.proposedOutcome).toBe("failed");
  });

  it("a failed install on the base makes the comparison not_comparable, and later ones too", () => {
    const world = new World();
    const started = world.start([check("install"), check("typecheck")]);
    const outcome = settleWithLog(world, started, exited(0));
    const failed = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: running(outcome).checkRunId,
      outcome: exited(1),
    });
    const prepare = failed.effects[0];
    const dir = prepare?.kind === "prepare_base" ? prepare.dir : "";
    const prepared = world.step(failed.state, { kind: "base_prepared", dir, ok: true });
    const installFailed = world.step(prepared.state, {
      kind: "check_settled",
      checkRunId: running(prepared).checkRunId,
      outcome: exited(1),
    });
    expect(installFailed.effects.some((effect) => effect.kind === "run_check")).toBe(false);
    world.step(installFailed.state, {
      kind: "upload_settled",
      artifactId: staged(installFailed).artifactId,
      ok: true,
    });
    expect(world.last("verification.result").payload.baseComparison).toBe("not_comparable");
  });

  it("does not compare a recommended check, or anything when the session has no base", () => {
    const world = new World();
    settleWithLog(world, world.start([check("lint")]), exited(1));
    expect(world.last("verification.result").payload.baseComparison).toBe("not_compared");
    expect(world.last("run.completed_with_warnings").payload.warnings[0]?.text).toBe(
      "Recommended check lint fails",
    );

    const bare = new World();
    const failed = bare.step(bare.start([check("typecheck")], { baseRevision: null }).state, {
      kind: "check_settled",
      checkRunId: "id_1",
      outcome: exited(1),
    });
    expect(failed.effects.some((effect) => effect.kind === "prepare_base")).toBe(false);
    bare.step(failed.state, {
      kind: "upload_settled",
      artifactId: staged(failed).artifactId,
      ok: true,
    });
    expect(bare.last("verification.completed").payload.proposedOutcome).toBe("failed");
  });

  it("ignores a settle for another base directory or another check", () => {
    const world = new World();
    const failed = failingTypecheck(world);
    expect(world.step(failed.state, { kind: "base_prepared", dir: "other", ok: true }).state).toBe(
      failed.state,
    );
    expect(
      world.step(failed.state, { kind: "check_settled", checkRunId: "other", outcome: exited(0) })
        .state,
    ).toBe(failed.state);
    expect(
      world.step(failed.state, { kind: "upload_settled", artifactId: "other", ok: true }).state,
    ).toBe(failed.state);
  });
});

describe("cancel", () => {
  it("signals a running check with an escalation, then ends without recording anything more", () => {
    const world = new World();
    const outcome = world.start([check("test"), check("lint")]);
    const cancelled = world.step(outcome.state, { kind: "cancel" });
    expect(cancelled.effects).toEqual([
      { kind: "signal_check", checkRunId: "id_1", escalateAfterMs: CANCEL_GRACE_MS },
    ]);
    expect(cancelled.state.step.kind).toBe("running");

    expect(world.step(cancelled.state, { kind: "cancel" }).effects).toEqual([]);
    expect(
      world.step(cancelled.state, {
        kind: "check_settled",
        checkRunId: "other",
        outcome: exited(0),
      }).state.step.kind,
    ).toBe("running");
    const ended = world.step(cancelled.state, {
      kind: "check_settled",
      checkRunId: "id_1",
      outcome: exited(null, { signal: "SIGTERM" }),
    });
    expect(ended.state.step).toEqual({ kind: "done" });
    expect(ended.effects).toEqual([]);
    expect(world.types()).toEqual(["verification.started"]);
  });

  it("while waiting on a log's upload ends at once", () => {
    const world = new World();
    const outcome = world.start([check("test")]);
    const settled = world.step(outcome.state, {
      kind: "check_settled",
      checkRunId: "id_1",
      outcome: exited(0),
    });
    const cancelled = world.step(settled.state, { kind: "cancel" });
    expect(cancelled).toMatchObject({ state: { step: { kind: "done" } }, effects: [] });
  });

  it("while the base is prepared, or a base run is in flight", () => {
    const world = new World();
    const started = world.start([check("typecheck")]);
    const failed = world.step(started.state, {
      kind: "check_settled",
      checkRunId: "id_1",
      outcome: exited(1),
    });
    const whilePreparing = world.step(failed.state, { kind: "cancel" });
    expect(whilePreparing.effects).toEqual([]);
    expect(
      world.step(whilePreparing.state, { kind: "base_prepared", dir: "id_2", ok: true }).state.step,
    ).toEqual({ kind: "done" });

    const prepared = world.step(failed.state, { kind: "base_prepared", dir: "id_2", ok: true });
    expect(world.step(prepared.state, { kind: "cancel" }).effects).toEqual([
      {
        kind: "signal_check",
        checkRunId: running(prepared).checkRunId,
        escalateAfterMs: CANCEL_GRACE_MS,
      },
    ]);
  });

  it("after verification finished changes nothing", () => {
    const world = new World();
    const done = settleWithLog(world, world.start([check("test")]), exited(0));
    const after = world.step(done.state, { kind: "cancel" });
    expect(after.effects).toEqual([]);
    expect(after.state.step).toEqual({ kind: "done" });
  });
});

describe("the terminal table", () => {
  function recordOf(
    name: "install" | "test" | "typecheck" | "lint",
    result: CheckRecord["result"],
    overrides: Partial<CheckRecord> = {},
  ): CheckRecord {
    return {
      check: check(name),
      attempt: 1,
      result,
      skipReason: null,
      inconclusiveReason: null,
      baseComparison: "not_compared",
      evidence: [],
      ...overrides,
    };
  }

  it.each<[string, CheckRecord[], string]>([
    [
      "every required check passed",
      [recordOf("test", "passed"), recordOf("typecheck", "passed")],
      "verified",
    ],
    [
      "required passed and a recommended one failed",
      [recordOf("test", "passed"), recordOf("lint", "failed")],
      "verified",
    ],
    ["no required check at all", [recordOf("lint", "passed")], "completed_with_warnings"],
    ["nothing recorded", [], "completed_with_warnings"],
    [
      "a required check skipped",
      [
        recordOf("test", "passed"),
        recordOf("typecheck", "skipped", { skipReason: "user_requested" }),
      ],
      "completed_with_warnings",
    ],
    [
      "a required check inconclusive",
      [recordOf("test", "inconclusive", { inconclusiveReason: "flaky" })],
      "completed_with_warnings",
    ],
    [
      "a required failure reproduced on base",
      [recordOf("test", "failed", { baseComparison: "reproduced_on_base" })],
      "completed_with_warnings",
    ],
    [
      "a required failure that could not be compared",
      [recordOf("test", "failed", { baseComparison: "not_comparable" })],
      "completed_with_warnings",
    ],
    [
      "a required failure new on this change",
      [recordOf("test", "failed", { baseComparison: "new_failure" })],
      "failed",
    ],
    [
      "a required failure never compared",
      [recordOf("test", "failed", { baseComparison: "not_compared" })],
      "failed",
    ],
    [
      "a new failure beside a skip",
      [
        recordOf("test", "skipped", { skipReason: "user_requested" }),
        recordOf("typecheck", "failed", { baseComparison: "new_failure" }),
      ],
      "failed",
    ],
    [
      "a recommended failure only, with no required check",
      [recordOf("lint", "failed")],
      "completed_with_warnings",
    ],
  ])("%s -> %s", (_name, records, outcome) => {
    expect(proposedOutcome(records)).toBe(outcome);
  });

  it("warns when no required check was declared, even when the others passed", () => {
    const world = new World();
    settleWithLog(world, world.start([check("lint")]), exited(0));
    expect(world.last("run.completed_with_warnings").payload.warnings).toEqual([
      NO_REQUIRED_WARNING,
    ]);
    expect(world.last("verification.completed").payload.warnings).toEqual([
      NO_REQUIRED_WARNING.text,
    ]);
  });
});
