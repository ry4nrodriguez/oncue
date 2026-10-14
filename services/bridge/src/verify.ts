/**
 * Verification as a pure planner in the shape of `agent.ts`: which checks run,
 * in what order, how each attempt is classified, and which outcome the records
 * support (record 14). `agent.ts` owns when it starts and what its effects
 * become.
 *
 * Only a failed `test` check is retried once; a timeout is never retried or
 * compared. A failed required check is re-run on the base checkout within
 * `BASE_COMPARISON_BUDGET_MS` to tell a new failure from one the base already
 * had. Each attempt emits at most three frames (`verification.started`,
 * `artifact.uploading`, `verification.result`), and a result carries its log
 * as evidence only when the upload landed within the run's artifact budget.
 */

import type { PayloadOf } from "@oncue/protocol";
import { draft, summaryText, type Unbranded } from "./normalize";
import type { Draft } from "./protocol";
import type { CommandKey, InstallStep, ResolvedDefinition, Sourced } from "./repo-config";

export type CheckCategory = "setup" | "test" | "typecheck" | "lint" | "build";
export type Classification = "required" | "recommended" | "informational";
type ResultKind = PayloadOf<"verification.result">["result"];
type SkipReason = NonNullable<PayloadOf<"verification.result">["skipReason"]>;
type InconclusiveReason = NonNullable<PayloadOf<"verification.result">["inconclusiveReason"]>;
type BaseComparison = PayloadOf<"verification.result">["baseComparison"];
type ArtifactRef = Unbranded<PayloadOf<"verification.result">["evidence"][number]>;
type ProposedOutcome = PayloadOf<"verification.completed">["proposedOutcome"];

export const MAX_CHECKS_PER_RUN = 10;
/** Record 14's per-check wall limit. Every committed event resets the object's idle alarm, so each gap stays under it. */
export const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
/** Preparing the base checkout, installing there, and re-running the check, together. */
export const BASE_COMPARISON_BUDGET_MS = 5 * 60 * 1000;
/** Only a failed check in the `test` category gets a second attempt. */
export const MAX_ATTEMPTS = 2;
export const SUMMARY_TAIL_CHARS = 4_000;
/** Record 03's per-run artifact limit. The object refuses past it, so the planner does not ask. */
export const RUN_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const LOG_CONTENT_TYPE = "text/plain; charset=utf-8";
/** After SIGTERM on a cancel, how long a check has before SIGKILL. */
export const CANCEL_GRACE_MS = 5_000;

export interface PlannedCheck {
  readonly checkId: string;
  readonly name: string;
  readonly category: CheckCategory;
  readonly classification: Classification;
  readonly command: string;
  /** Record 14: why the check applies. */
  readonly reason: string;
}

/**
 * The install first when there is a lockfile, then `test` and `typecheck`
 * (required), then `lint` and `build` (recommended); `dev` is never a check.
 * With no command there is no install, since it would verify nothing.
 */
export function planChecks(
  project: ResolvedDefinition | null,
  install: InstallStep | null,
  newId: () => string,
): readonly PlannedCheck[] {
  if (project === null) {
    return [];
  }
  const commands: PlannedCheck[] = [];
  for (const [key, classification] of CHECK_CLASSIFICATION) {
    const command = project.commands[key];
    if (command.value !== null) {
      commands.push({
        checkId: newId(),
        name: key,
        category: key,
        classification,
        command: command.value,
        reason: reasonFor(key, command),
      });
    }
  }
  if (commands.length === 0) {
    return [];
  }
  const setup: PlannedCheck[] =
    install === null
      ? []
      : [
          {
            checkId: newId(),
            name: "install",
            category: "setup",
            classification: "informational",
            command: install.command,
            reason: `${install.lockfile} is committed`,
          },
        ];
  return [...setup, ...commands].slice(0, MAX_CHECKS_PER_RUN);
}

/** The classification table. Order is run order. */
export const CHECK_CLASSIFICATION: readonly (readonly [
  Exclude<CommandKey, "dev">,
  Classification,
])[] = [
  ["test", "required"],
  ["typecheck", "required"],
  ["lint", "recommended"],
  ["build", "recommended"],
];

function reasonFor(key: CommandKey, command: Sourced<string | null>): string {
  return command.source === "repository_file"
    ? `.oncue/project.yaml declares commands.${key}`
    : `package.json has a ${key} script`;
}

/** What the run's summary says, fixed when verification starts. */
export interface RunFacts {
  readonly runId: string;
  readonly whatChanged: string;
  readonly why: string;
  readonly branch: string | null;
  readonly startedAtMs: number;
}

export type CheckRunOutcome =
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly timedOut: boolean;
      readonly durationMs: number;
      /** The exact size of the log the interpreter staged for this attempt, cut marker included. */
      readonly logBytes: number;
      /** The last `SUMMARY_TAIL_CHARS` of that log. */
      readonly tail: string;
    }
  /** The supervisor refused, failed, or was unreachable. */
  | { readonly kind: "could_not_run"; readonly detail: string };

export type Where =
  | { readonly kind: "workspace" }
  | { readonly kind: "base"; readonly dir: string };

export type VerifyEffect =
  | { readonly kind: "emit"; readonly draft: Draft }
  | {
      readonly kind: "run_check";
      readonly checkRunId: string;
      readonly command: string;
      readonly where: Where;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "signal_check";
      readonly checkRunId: string;
      readonly escalateAfterMs: number;
    }
  /** Check `baseSha` out into the named base directory and hand it to the agent user. */
  | { readonly kind: "prepare_base"; readonly dir: string; readonly baseSha: string }
  /** The log `run_check` produced for `checkRunId` becomes artifact `artifactId`'s bytes. */
  | { readonly kind: "stage_log"; readonly artifactId: string; readonly checkRunId: string };

export type VerifyInput =
  | {
      readonly kind: "check_settled";
      readonly checkRunId: string;
      readonly outcome: CheckRunOutcome;
    }
  | { readonly kind: "base_prepared"; readonly dir: string; readonly ok: boolean }
  | { readonly kind: "upload_settled"; readonly artifactId: string; readonly ok: boolean }
  | { readonly kind: "cancel" };

export interface VerifyContext {
  readonly nowMs: number;
  readonly newId: () => string;
}

/** One check's latest attempt, as `verification.result` recorded it. */
export interface CheckRecord {
  readonly check: PlannedCheck;
  readonly attempt: number;
  readonly result: ResultKind;
  readonly skipReason: SkipReason | null;
  readonly inconclusiveReason: InconclusiveReason | null;
  readonly baseComparison: BaseComparison;
  readonly evidence: readonly ArtifactRef[];
}

/** An attempt that ended and is waiting on its comparison or its log before its result is emitted. */
interface EndedAttempt {
  readonly check: PlannedCheck;
  readonly checkRunId: string;
  readonly attempt: number;
  readonly result: ResultKind;
  readonly skipReason: SkipReason | null;
  readonly inconclusiveReason: InconclusiveReason | null;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly summary: string;
  readonly logBytes: number;
  readonly baseComparison: BaseComparison;
  /** A failed test's first attempt: run it again once this one is recorded. */
  readonly retry: boolean;
}

type BaseTree =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly dir: string; readonly installed: "no" | "ok" | "failed" }
  | { readonly kind: "unavailable" };

export type VerifyStep =
  | {
      readonly kind: "running";
      readonly check: PlannedCheck;
      readonly checkRunId: string;
      readonly attempt: number;
    }
  | {
      readonly kind: "preparing_base";
      readonly ended: EndedAttempt;
      readonly dir: string;
      readonly deadlineMs: number;
    }
  | {
      readonly kind: "base_install" | "base_check";
      readonly ended: EndedAttempt;
      readonly checkRunId: string;
      readonly deadlineMs: number;
    }
  | { readonly kind: "uploading"; readonly ended: EndedAttempt; readonly artifactId: string }
  /** Verification is over. `agent.ts` finishes the run on seeing this. */
  | { readonly kind: "done" };

export interface VerifyState {
  readonly facts: RunFacts;
  readonly revision: string;
  readonly baseRevision: string | null;
  readonly skipRequired: boolean;
  readonly checks: readonly PlannedCheck[];
  /** Index into `checks` of the check in progress. */
  readonly index: number;
  readonly records: readonly CheckRecord[];
  readonly environmentFailed: boolean;
  readonly declaredBytes: number;
  readonly base: BaseTree;
  readonly step: VerifyStep;
  readonly cancelled: boolean;
}

export interface VerifyOutcome {
  readonly state: VerifyState;
  readonly effects: readonly VerifyEffect[];
}

export interface VerifyStart {
  readonly facts: RunFacts;
  readonly checks: readonly PlannedCheck[];
  /** What the checks run against. */
  readonly revision: string;
  /** The session's recorded base, or null when there is none to compare with. */
  readonly baseRevision: string | null;
  readonly skipRequired: boolean;
}

function emit(value: Draft): VerifyEffect {
  return { kind: "emit", draft: value };
}

export function startVerification(start: VerifyStart, ctx: VerifyContext): VerifyOutcome {
  const state: VerifyState = {
    facts: start.facts,
    revision: start.revision,
    baseRevision: start.baseRevision,
    skipRequired: start.skipRequired,
    checks: start.checks,
    index: 0,
    records: [],
    environmentFailed: false,
    declaredBytes: 0,
    base: { kind: "none" },
    step: { kind: "done" },
    cancelled: false,
  };
  if (start.checks.length === 0) {
    return { state, effects: [emit(noChecksDraft(start.facts, ctx.nowMs))] };
  }
  return advance(state, ctx, []);
}

export function isDone(state: VerifyState): boolean {
  return state.step.kind === "done";
}

/** The artifact the planner is waiting to hear about, if any. */
export function awaitedArtifact(state: VerifyState): string | null {
  return state.step.kind === "uploading" ? state.step.artifactId : null;
}

export function stepVerify(
  state: VerifyState,
  input: VerifyInput,
  ctx: VerifyContext,
): VerifyOutcome {
  if (input.kind === "cancel") {
    return cancel(state);
  }
  const step = state.step;
  if (state.cancelled) {
    // A cancelled verification ends when whatever was in flight settles, and records nothing more.
    return settlesStep(step, input)
      ? { state: { ...state, step: { kind: "done" } }, effects: [] }
      : { state, effects: [] };
  }
  switch (input.kind) {
    case "check_settled":
      if (step.kind === "running" && step.checkRunId === input.checkRunId) {
        return settleAttempt(state, step, input.outcome, ctx);
      }
      if (
        (step.kind === "base_install" || step.kind === "base_check") &&
        step.checkRunId === input.checkRunId
      ) {
        return settleBaseRun(state, step, input.outcome, ctx);
      }
      return { state, effects: [] };
    case "base_prepared":
      if (step.kind !== "preparing_base" || step.dir !== input.dir) {
        return { state, effects: [] };
      }
      if (!input.ok) {
        return finishAttempt(
          { ...state, base: { kind: "unavailable" } },
          { ...step.ended, baseComparison: "not_comparable" },
          ctx,
        );
      }
      return runOnBase(
        { ...state, base: { kind: "ready", dir: step.dir, installed: "no" } },
        step.ended,
        step.deadlineMs,
        ctx,
      );
    case "upload_settled":
      if (step.kind !== "uploading" || step.artifactId !== input.artifactId) {
        return { state, effects: [] };
      }
      return record(state, step.ended, input.ok ? [logRef(step.artifactId, step.ended)] : [], ctx);
  }
}

function settlesStep(step: VerifyStep, input: Exclude<VerifyInput, { kind: "cancel" }>): boolean {
  switch (input.kind) {
    case "check_settled":
      return (
        (step.kind === "running" || step.kind === "base_install" || step.kind === "base_check") &&
        step.checkRunId === input.checkRunId
      );
    case "base_prepared":
      return step.kind === "preparing_base" && step.dir === input.dir;
    case "upload_settled":
      return step.kind === "uploading" && step.artifactId === input.artifactId;
  }
}

function cancel(state: VerifyState): VerifyOutcome {
  if (state.cancelled || state.step.kind === "done") {
    return { state: { ...state, cancelled: true }, effects: [] };
  }
  const step = state.step;
  const cancelled: VerifyState = { ...state, cancelled: true };
  switch (step.kind) {
    case "running":
    case "base_install":
    case "base_check":
      return {
        state: cancelled,
        effects: [
          { kind: "signal_check", checkRunId: step.checkRunId, escalateAfterMs: CANCEL_GRACE_MS },
        ],
      };
    case "preparing_base":
      return { state: cancelled, effects: [] };
    case "uploading":
      // Nothing is running; the log's upload settles on its own.
      return { state: { ...cancelled, step: { kind: "done" } }, effects: [] };
  }
}

function startedDraft(state: VerifyState, check: PlannedCheck, attempt: number): Draft {
  return draft("verification.started", state.facts.runId, {
    checkId: check.checkId,
    name: check.name.slice(0, 256),
    category: check.category,
    classification: check.classification,
    source: "repository_requirement",
    method: { kind: "command", command: summaryText(check.command), cwd: null },
    revision: state.revision,
    baseRevision: state.baseRevision,
    attempt,
    reason: check.reason.slice(0, 256),
  });
}

const SKIP_SUMMARY: Readonly<Record<"environment_failed" | "user_requested", string>> = {
  environment_failed: "Not run: installing the repository's dependencies failed.",
  user_requested: "Not run: the request asked to skip required checks.",
};

/** The next check, skipping any that cannot or should not run, or the end. */
function advance(state: VerifyState, ctx: VerifyContext, effects: VerifyEffect[]): VerifyOutcome {
  let next = state;
  while (next.index < next.checks.length) {
    const check = next.checks[next.index] as PlannedCheck;
    const skip: "environment_failed" | "user_requested" | null =
      next.environmentFailed && check.category !== "setup"
        ? "environment_failed"
        : next.skipRequired && check.classification === "required"
          ? "user_requested"
          : null;
    if (skip === null) {
      const checkRunId = ctx.newId();
      return {
        state: { ...next, step: { kind: "running", check, checkRunId, attempt: 1 } },
        effects: [
          ...effects,
          emit(startedDraft(next, check, 1)),
          {
            kind: "run_check",
            checkRunId,
            command: check.command,
            where: { kind: "workspace" },
            timeoutMs: CHECK_TIMEOUT_MS,
          },
        ],
      };
    }
    effects.push(
      emit(startedDraft(next, check, 1)),
      emit(
        draft("verification.result", next.facts.runId, {
          checkId: check.checkId,
          attempt: 1,
          result: "skipped",
          skipReason: skip,
          inconclusiveReason: null,
          exitCode: null,
          durationMs: 0,
          summary: SKIP_SUMMARY[skip],
          baseComparison: "not_compared",
          structured: null,
          evidence: [],
        }),
      ),
    );
    next = {
      ...next,
      index: next.index + 1,
      records: [
        ...next.records,
        {
          check,
          attempt: 1,
          result: "skipped",
          skipReason: skip,
          inconclusiveReason: null,
          baseComparison: "not_compared",
          evidence: [],
        },
      ],
    };
  }
  return finish(next, ctx, effects);
}

/** How an attempt's own process ended, before retry or comparison. */
function classify(
  outcome: Extract<CheckRunOutcome, { kind: "exited" }>,
  attempt: number,
): Pick<EndedAttempt, "result" | "inconclusiveReason"> {
  if (outcome.timedOut) {
    return { result: "inconclusive", inconclusiveReason: "timeout" };
  }
  if (outcome.exitCode === 0 && outcome.signal === null) {
    return attempt > 1
      ? { result: "inconclusive", inconclusiveReason: "flaky" }
      : { result: "passed", inconclusiveReason: null };
  }
  return { result: "failed", inconclusiveReason: null };
}

function settleAttempt(
  state: VerifyState,
  step: Extract<VerifyStep, { kind: "running" }>,
  outcome: CheckRunOutcome,
  ctx: VerifyContext,
): VerifyOutcome {
  const check = step.check;
  if (outcome.kind === "could_not_run") {
    return record(
      state,
      {
        check,
        checkRunId: step.checkRunId,
        attempt: step.attempt,
        result: "skipped",
        skipReason: "could_not_run",
        inconclusiveReason: null,
        exitCode: null,
        durationMs: 0,
        summary: summaryText(`Could not run: ${outcome.detail}`),
        logBytes: 0,
        baseComparison: "not_compared",
        retry: false,
      },
      [],
      ctx,
    );
  }
  const classified = classify(outcome, step.attempt);
  const ended: EndedAttempt = {
    check,
    checkRunId: step.checkRunId,
    attempt: step.attempt,
    ...classified,
    skipReason: null,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    summary: outcome.tail.length === 0 ? "(no output)" : tailOf(outcome.tail),
    logBytes: outcome.logBytes,
    baseComparison: "not_compared",
    retry:
      classified.result === "failed" && check.category === "test" && step.attempt < MAX_ATTEMPTS,
  };
  if (
    ended.result === "failed" &&
    !ended.retry &&
    check.classification === "required" &&
    state.baseRevision !== null
  ) {
    return compareWithBase(state, ended, ctx);
  }
  return finishAttempt(state, ended, ctx);
}

export function tailOf(text: string): string {
  return text.length > SUMMARY_TAIL_CHARS ? text.slice(text.length - SUMMARY_TAIL_CHARS) : text;
}

function compareWithBase(
  state: VerifyState,
  ended: EndedAttempt,
  ctx: VerifyContext,
): VerifyOutcome {
  const deadlineMs = ctx.nowMs + BASE_COMPARISON_BUDGET_MS;
  switch (state.base.kind) {
    case "unavailable":
      return finishAttempt(state, { ...ended, baseComparison: "not_comparable" }, ctx);
    case "ready":
      return runOnBase(state, ended, deadlineMs, ctx);
    case "none": {
      const dir = ctx.newId();
      return {
        state: { ...state, step: { kind: "preparing_base", ended, dir, deadlineMs } },
        effects: [{ kind: "prepare_base", dir, baseSha: state.baseRevision as string }],
      };
    }
  }
}

function setupCheck(state: VerifyState): PlannedCheck | null {
  return state.checks.find((check) => check.category === "setup") ?? null;
}

/** With the base checkout ready: install there first when it has not been, then the check. */
function runOnBase(
  state: VerifyState,
  ended: EndedAttempt,
  deadlineMs: number,
  ctx: VerifyContext,
): VerifyOutcome {
  const base = state.base;
  if (base.kind !== "ready" || base.installed === "failed") {
    return finishAttempt(state, { ...ended, baseComparison: "not_comparable" }, ctx);
  }
  const remaining = Math.min(CHECK_TIMEOUT_MS, deadlineMs - ctx.nowMs);
  if (remaining <= 0) {
    return finishAttempt(state, { ...ended, baseComparison: "not_comparable" }, ctx);
  }
  const install = setupCheck(state);
  const installing = install !== null && base.installed === "no";
  const checkRunId = ctx.newId();
  return {
    state: {
      ...state,
      step: { kind: installing ? "base_install" : "base_check", ended, checkRunId, deadlineMs },
    },
    effects: [
      {
        kind: "run_check",
        checkRunId,
        command: installing ? install.command : ended.check.command,
        where: { kind: "base", dir: base.dir },
        timeoutMs: remaining,
      },
    ],
  };
}

function settleBaseRun(
  state: VerifyState,
  step: Extract<VerifyStep, { kind: "base_install" | "base_check" }>,
  outcome: CheckRunOutcome,
  ctx: VerifyContext,
): VerifyOutcome {
  const base = state.base;
  const exitedCleanly =
    outcome.kind === "exited" &&
    !outcome.timedOut &&
    outcome.exitCode === 0 &&
    outcome.signal === null;
  if (step.kind === "base_install") {
    const installed = exitedCleanly ? "ok" : "failed";
    const next: VerifyState =
      base.kind === "ready" ? { ...state, base: { ...base, installed } } : state;
    return runOnBase(next, step.ended, step.deadlineMs, ctx);
  }
  const comparison: BaseComparison =
    outcome.kind === "could_not_run" || outcome.timedOut
      ? "not_comparable"
      : exitedCleanly
        ? "new_failure"
        : "reproduced_on_base";
  return finishAttempt(state, { ...step.ended, baseComparison: comparison }, ctx);
}

/** Declare the attempt's log, or record it at once when there is none to upload or no budget left. */
function finishAttempt(state: VerifyState, ended: EndedAttempt, ctx: VerifyContext): VerifyOutcome {
  if (ended.logBytes <= 0 || state.declaredBytes + ended.logBytes > RUN_ARTIFACT_BYTES) {
    return record(state, ended, [], ctx);
  }
  const artifactId = ctx.newId();
  return {
    state: {
      ...state,
      declaredBytes: state.declaredBytes + ended.logBytes,
      step: { kind: "uploading", ended, artifactId },
    },
    effects: [
      emit(
        draft("artifact.uploading", state.facts.runId, {
          artifactId,
          kind: "log",
          contentType: LOG_CONTENT_TYPE,
          declaredBytes: ended.logBytes,
          producer: "verification",
        }),
      ),
      { kind: "stage_log", artifactId, checkRunId: ended.checkRunId },
    ],
  };
}

function logRef(artifactId: string, ended: EndedAttempt): ArtifactRef {
  return {
    artifactId,
    kind: "log",
    contentType: LOG_CONTENT_TYPE,
    byteSize: ended.logBytes,
    label: `${ended.check.name} output, attempt ${ended.attempt}`.slice(0, 256),
  };
}

/** Emit the attempt's result, keep it as the check's latest record, and move on. */
function record(
  state: VerifyState,
  ended: EndedAttempt,
  evidence: readonly ArtifactRef[],
  ctx: VerifyContext,
): VerifyOutcome {
  const effects: VerifyEffect[] = [
    emit(
      draft("verification.result", state.facts.runId, {
        checkId: ended.check.checkId,
        attempt: ended.attempt,
        result: ended.result,
        skipReason: ended.skipReason,
        inconclusiveReason: ended.inconclusiveReason,
        exitCode: ended.exitCode,
        durationMs: ended.durationMs,
        summary: ended.summary,
        baseComparison: ended.baseComparison,
        structured: null,
        evidence,
      }),
    ),
  ];
  const kept: CheckRecord = {
    check: ended.check,
    attempt: ended.attempt,
    result: ended.result,
    skipReason: ended.skipReason,
    inconclusiveReason: ended.inconclusiveReason,
    baseComparison: ended.baseComparison,
    evidence,
  };
  const records = [
    ...state.records.filter((existing) => existing.check.checkId !== ended.check.checkId),
    kept,
  ];
  if (ended.retry) {
    const checkRunId = ctx.newId();
    const attempt = ended.attempt + 1;
    return {
      state: {
        ...state,
        records,
        step: { kind: "running", check: ended.check, checkRunId, attempt },
      },
      effects: [
        ...effects,
        emit(startedDraft(state, ended.check, attempt)),
        {
          kind: "run_check",
          checkRunId,
          command: ended.check.command,
          where: { kind: "workspace" },
          timeoutMs: CHECK_TIMEOUT_MS,
        },
      ],
    };
  }
  const environmentFailed =
    state.environmentFailed || (ended.check.category === "setup" && ended.result !== "passed");
  return advance(
    { ...state, records, environmentFailed, index: state.index + 1, step: { kind: "done" } },
    ctx,
    effects,
  );
}

// The outcome the records support.

export interface Warning {
  readonly text: string;
  readonly recommendedAction: string;
}

const CLASS_LABEL: Readonly<Record<Classification, string>> = {
  required: "Required check",
  recommended: "Recommended check",
  informational: "Step",
};

/** One warning per record that did not pass, in run order. */
export function warningsFor(records: readonly CheckRecord[]): Warning[] {
  const warnings: Warning[] = [];
  for (const entry of records) {
    const label = `${CLASS_LABEL[entry.check.classification]} ${entry.check.name}`;
    switch (entry.result) {
      case "passed":
        break;
      case "skipped":
        warnings.push(
          entry.skipReason === "user_requested"
            ? {
                text: `${label} was skipped at your request`,
                recommendedAction: `Run ${entry.check.name} before merging`,
              }
            : entry.skipReason === "environment_failed"
              ? {
                  text: `${label} was not run because installing dependencies failed`,
                  recommendedAction: "Open the install log and fix the install",
                }
              : {
                  text: `${label} could not be run in the sandbox`,
                  recommendedAction: `Run ${entry.check.name} yourself before merging`,
                },
        );
        break;
      case "inconclusive":
        warnings.push(
          entry.inconclusiveReason === "flaky"
            ? {
                text: `${label} failed once and passed on a second attempt, so its result is flaky`,
                recommendedAction: "Look at both attempts' output before trusting it",
              }
            : {
                text: `${label} did not finish within ${CHECK_TIMEOUT_MS / 60_000} minutes`,
                recommendedAction: `Run ${entry.check.name} yourself before merging`,
              },
        );
        break;
      case "failed":
        warnings.push(failureWarning(label, entry));
        break;
    }
  }
  return warnings;
}

function failureWarning(label: string, entry: CheckRecord): Warning {
  if (entry.check.category === "setup") {
    return {
      text: `Installing dependencies with ${entry.check.command.slice(0, 200)} failed`,
      recommendedAction: "Open the install log and fix the install",
    };
  }
  switch (entry.baseComparison) {
    case "reproduced_on_base":
      return {
        text: `${label} fails, and fails on the base revision too`,
        recommendedAction: "Decide whether the existing failure affects this change",
      };
    case "new_failure":
      return {
        text: `${label} fails on this change and passes on the base revision`,
        recommendedAction: "Fix the failure before merging",
      };
    case "not_comparable":
      return {
        text: `${label} fails and could not be compared with the base revision`,
        recommendedAction: `Check whether ${entry.check.name} fails on the base revision`,
      };
    case "not_compared":
      return {
        text: `${label} fails`,
        recommendedAction: "Open its output and fix the failure",
      };
  }
}

export const NO_CHECKS_WARNING: Warning = {
  text: "No verification checks were declared, so this run is unverified",
  recommendedAction:
    "Add test or typecheck scripts to package.json, or declare them in .oncue/project.yaml",
};

export const NO_REQUIRED_WARNING: Warning = {
  text: "No required check (test or typecheck) was declared, so this run cannot be verified",
  recommendedAction: "Add a test or typecheck script to package.json",
};

/**
 * `run.verified` when there is a required check and every one passed;
 * `run.failed` when a required check failed and the base did not reproduce it;
 * `run.completed_with_warnings` otherwise.
 */
export function proposedOutcome(
  records: readonly CheckRecord[],
): Exclude<ProposedOutcome, "blocked" | "cancelled"> {
  const required = records.filter((entry) => entry.check.classification === "required");
  if (required.length > 0 && required.every((entry) => entry.result === "passed")) {
    return "verified";
  }
  return required.some(isNewlyFailingRequired) ? "failed" : "completed_with_warnings";
}

function isNewlyFailingRequired(entry: CheckRecord): boolean {
  return (
    entry.check.classification === "required" &&
    entry.result === "failed" &&
    (entry.baseComparison === "new_failure" || entry.baseComparison === "not_compared")
  );
}

function counts(records: readonly CheckRecord[], classification: Classification) {
  const scoped = records.filter((entry) => entry.check.classification === classification);
  const of = (result: ResultKind) => scoped.filter((entry) => entry.result === result).length;
  return {
    total: scoped.length,
    passed: of("passed"),
    failed: of("failed"),
    skipped: of("skipped"),
    inconclusive: of("inconclusive"),
  };
}

function describeRecord(entry: CheckRecord): string {
  const detail =
    entry.result === "failed" && entry.baseComparison === "reproduced_on_base"
      ? " (also fails on base)"
      : entry.result === "failed" && entry.baseComparison === "new_failure"
        ? " (passes on base)"
        : entry.result === "inconclusive" && entry.inconclusiveReason !== null
          ? ` (${entry.inconclusiveReason})`
          : entry.result === "skipped" && entry.skipReason !== null
            ? ` (${entry.skipReason.replace("_", " ")})`
            : "";
  return `${entry.check.name} ${entry.result}${detail}`;
}

function outcomeTail(facts: RunFacts, evidence: readonly ArtifactRef[], nowMs: number) {
  return {
    evidence,
    branch: facts.branch,
    pullRequestNumber: null,
    usage: null,
    durationMs: Math.max(0, nowMs - facts.startedAtMs),
  };
}

function finish(state: VerifyState, ctx: VerifyContext, effects: VerifyEffect[]): VerifyOutcome {
  const done: VerifyState = { ...state, step: { kind: "done" } };
  const records = state.records;
  const outcome = proposedOutcome(records);
  const warnings = warningsFor(records);
  if (!records.some((entry) => entry.check.classification === "required")) {
    warnings.push(NO_REQUIRED_WARNING);
  }
  const userSkipped = records
    .filter((entry) => entry.skipReason === "user_requested")
    .map((entry) => entry.check.checkId);
  effects.push(
    emit(
      draft("verification.completed", state.facts.runId, {
        proposedOutcome: outcome,
        required: counts(records, "required"),
        recommended: counts(records, "recommended"),
        warnings: warnings.map((warning) => summaryText(warning.text)),
        userSkipped,
        baselineComparisonAvailable: records.some(
          (entry) =>
            entry.baseComparison === "new_failure" || entry.baseComparison === "reproduced_on_base",
        ),
      }),
    ),
  );
  const facts = state.facts;
  const evidence = records
    .filter((entry) => entry.check.classification === "required")
    .flatMap((entry) => entry.evidence);
  const summary = {
    whatChanged: summaryText(facts.whatChanged),
    why: summaryText(facts.why),
    verificationPerformed: summaryText(records.map(describeRecord).join("; ")),
    limitations: warnings.map((warning) => summaryText(warning.text)),
    nextStep: null,
  };
  const tail = outcomeTail(facts, evidence, ctx.nowMs);
  switch (outcome) {
    case "verified":
      effects.push(emit(draft("run.verified", facts.runId, { summary, ...tail })));
      break;
    case "failed": {
      const failing = records.find(isNewlyFailingRequired) as CheckRecord;
      effects.push(
        emit(
          draft("run.failed", facts.runId, {
            stage: "verification",
            error: {
              category: "required_check_failed",
              message: summaryText(
                failureWarning(`${CLASS_LABEL.required} ${failing.check.name}`, failing).text,
              ),
            },
            summary,
            ...tail,
          }),
        ),
      );
      break;
    }
    case "completed_with_warnings":
      effects.push(
        emit(
          draft("run.completed_with_warnings", facts.runId, {
            summary,
            warnings: warnings.map((warning) => ({
              text: summaryText(warning.text),
              recommendedAction: summaryText(warning.recommendedAction),
            })),
            ...tail,
          }),
        ),
      );
      break;
  }
  return { state: done, effects };
}

/** A run with nothing to verify: a repository that resolves no checks, or no repository at all. */
export function noChecksDraft(
  facts: RunFacts,
  nowMs: number,
): Draft<"run.completed_with_warnings"> {
  return draft("run.completed_with_warnings", facts.runId, {
    summary: {
      whatChanged: summaryText(facts.whatChanged),
      why: summaryText(facts.why),
      verificationPerformed: "None: no checks were declared",
      limitations: [NO_CHECKS_WARNING.text],
      nextStep: null,
    },
    warnings: [NO_CHECKS_WARNING],
    ...outcomeTail(facts, [], nowMs),
  });
}
