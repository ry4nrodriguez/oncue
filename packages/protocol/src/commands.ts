/**
 * Record 04's commands sent to the runtime. Each command carries a unique id
 * and the session or run state its issuer expects, so a client that has
 * fallen behind is rejected rather than applied (record 01's idempotency
 * rule). Acknowledgement is separate from completion, so no payload carries a
 * result: completion is observed only through the events a command causes.
 * Payloads mirror the durable event each command produces, so the session
 * object can build that event directly.
 */

import { ATTACHMENT_LIMITS } from "./attachments";
import { branchName } from "./branch-name";
import type { RunIdFor } from "./envelope";
import { approvalMode, approvalScope } from "./families/approvals";
import { questionAnswers } from "./families/questions";
import {
  agentId,
  approvalId,
  array,
  artifactRef,
  bodyText,
  boolean,
  boundedList,
  type CommandId,
  commandId,
  counter,
  effortLevel,
  exactOptional,
  type GenericSchema,
  type InferOutput,
  LIMITS,
  literal,
  maxLength,
  messageId,
  minLength,
  modelRecord,
  nullable,
  type ParseFailure,
  picklist,
  pipe,
  proposalId,
  questionId,
  reviewItemId,
  runId,
  type SessionId,
  safeParse,
  strictObject,
  summaryText,
  type Timestamp,
  toFailure,
  type UserId,
  variant,
} from "./schema";
import { isTerminal, RUN_STATES, type RunState, SESSION_STATES, type SessionState } from "./states";

// A message's uploaded files, by reference. The control plane replaces each
// reference with its own record of the upload before anything is committed,
// so the browser's content type, size, or label is never what is shown.
const messageAttachments = pipe(array(artifactRef), maxLength(ATTACHMENT_LIMITS.perMessage));

const contextItem = variant("kind", [
  strictObject({ kind: literal("note"), text: summaryText }),
  strictObject({ kind: literal("artifact"), artifact: artifactRef }),
  strictObject({ kind: literal("review_items"), reviewItemIds: boundedList(reviewItemId) }),
]);

// Every non-terminal run state, derived from `states.ts` so it cannot drift.
const CANCELLABLE_RUN_STATES: readonly RunState[] = RUN_STATES.filter(
  (state) => !isTerminal("run", state),
);

interface RunCommandSpec<P extends GenericSchema = GenericSchema> {
  readonly scope: "run";
  readonly allowedRunStates: readonly RunState[];
  readonly payload: P;
}

interface SessionCommandSpec<P extends GenericSchema = GenericSchema> {
  readonly scope: "session";
  readonly allowedSessionStates: readonly SessionState[];
  readonly payload: P;
}

type CommandSpecInput = RunCommandSpec | SessionCommandSpec;

function defineCommands<const D extends Record<string, CommandSpecInput>>(specs: D): D {
  return specs;
}

export const COMMAND_CATALOG = defineCommands({
  // Record 10: with no active run, a user message starts one. The session
  // object mints the runId. `continuesRunId` names a prior run being resumed.
  // `skipRequiredChecks`, here and on `run.follow_up`, is the user's explicit
  // skip; absent means false, and nothing infers a skip from message text.
  "run.start": {
    scope: "session",
    allowedSessionStates: ["active"],
    payload: strictObject({
      instruction: strictObject({
        messageId,
        text: bodyText,
        attachments: messageAttachments,
      }),
      model: modelRecord,
      continuesRunId: nullable(runId),
      skipRequiredChecks: exactOptional(boolean()),
      // Record 14: run the repository's checks without prompting the agent.
      // The instruction is kept for the timeline and never sent to the runtime.
      checksOnly: exactOptional(boolean()),
    }),
  },
  // Record 10: a message during active work steers the current run or is
  // queued for the next. A steer on a `paused` or `interrupted` run resumes
  // it on a new generation.
  "run.follow_up": {
    scope: "run",
    allowedRunStates: ["running", "waiting_for_approval", "paused", "interrupted"],
    payload: strictObject({
      messageId,
      text: bodyText,
      attachments: messageAttachments,
      delivery: picklist(["steer_current_run", "run_next"]),
      skipRequiredChecks: exactOptional(boolean()),
      // For `run_next`, the next run's effort; absent keeps the current one.
      // A steer carries none, because changing effort mid-run restarts the
      // provider's prompt cache.
      effort: exactOptional(nullable(effortLevel)),
    }),
  },
  "run.pause": {
    scope: "run",
    allowedRunStates: ["running", "waiting_for_approval"],
    payload: strictObject({
      reason: picklist(["user_requested", "idle_stop", "no_progress", "lifetime_ceiling"]),
    }),
  },
  // Record 10: legal from any state the run has not already left.
  "run.cancel": {
    scope: "run",
    allowedRunStates: CANCELLABLE_RUN_STATES,
    payload: strictObject({
      reason: nullable(summaryText),
      checkpointFirst: boolean(),
    }),
  },
  "approval.resolve": {
    scope: "run",
    allowedRunStates: ["waiting_for_approval"],
    // Who decided and when are not the browser's to say: the control plane
    // records the user it verified on the socket and its own clock.
    // `scope` widens an approval of the agent's own permission ask to the
    // session or the workspace; absent means this request only.
    payload: strictObject({
      approvalId,
      decision: picklist(["approved", "rejected"]),
      scope: exactOptional(approvalScope),
    }),
  },
  // Record 09: the approvals picker below the composer. The object writes the
  // session's mode; the browser saves the workspace's default.
  "approval.mode": {
    scope: "session",
    allowedSessionStates: ["active"],
    payload: strictObject({ mode: approvalMode }),
  },
  // The user's answer to the agent's open question, or its dismissal. Like
  // `approval.resolve`, who answered and when are the control plane's to say.
  // A paused or interrupted run is answered too: the answer then resumes it.
  "question.resolve": {
    scope: "run",
    allowedRunStates: ["running", "waiting_for_approval", "paused", "interrupted"],
    payload: variant("action", [
      strictObject({ action: literal("answer"), questionId, answers: questionAnswers }),
      strictObject({ action: literal("dismiss"), questionId }),
    ]),
  },
  "context.add": {
    scope: "run",
    allowedRunStates: ["running", "waiting_for_approval"],
    payload: strictObject({
      items: pipe(array(contextItem), minLength(1), maxLength(LIMITS.listItems)),
    }),
  },
  // Record 12: stops one subagent of the run; the run and its other subagents
  // go on. The bridge aborts that subagent's own conversation.
  "agent.stop": {
    scope: "run",
    allowedRunStates: ["running", "waiting_for_approval"],
    payload: strictObject({ agentId }),
  },
  // Record 04: a session-level action on the current sandbox, not one run,
  // so it stays available while archiving.
  "checkpoint.create": {
    scope: "session",
    allowedSessionStates: ["active", "archived"],
    payload: strictObject({
      reason: picklist(["user_requested", "idle", "lifetime_ceiling", "pause", "cancel"]),
    }),
  },
  // Records 07 and 09: the user's side of the session's Git policy. `confirm`
  // and `decline` answer the open proposal by id, and `confirm` names the
  // policy version the card showed, so a stale click changes nothing. `set`
  // writes the policy directly. The agent never issues this command; its
  // proposals wait for one of these.
  "policy.set": {
    scope: "session",
    allowedSessionStates: ["active"],
    payload: variant("action", [
      strictObject({
        action: literal("confirm"),
        proposalId,
        policyVersion: counter,
        // The task branch's name, chosen at the first push (`branch-name.ts`);
        // ignored once the session has one.
        branchName: exactOptional(branchName),
      }),
      strictObject({ action: literal("decline"), proposalId }),
      strictObject({
        action: literal("set"),
        policyVersion: counter,
        commit: picklist(["auto", "manual"]),
        push: picklist(["auto", "manual", "never"]),
        pullRequest: picklist(["auto_after_verification", "manual", "never"]),
        branchName: exactOptional(branchName),
      }),
    ]),
  },
  // Always issuable: a clean runtime teardown must not be blocked by the
  // gate that blocks new work.
  "runtime.shutdown": {
    scope: "session",
    allowedSessionStates: SESSION_STATES,
    payload: strictObject({
      reason: picklist(["idle", "replaced", "terminated", "cancelled"]),
      graceMs: counter,
    }),
  },
});

export type CommandCatalog = typeof COMMAND_CATALOG;
export type CommandType = keyof CommandCatalog & string;
export const COMMAND_TYPES = Object.keys(COMMAND_CATALOG) as readonly CommandType[];

export function isCommandType(value: string): value is CommandType {
  return Object.hasOwn(COMMAND_CATALOG, value);
}

export type ScopeOfCommand<T extends CommandType> = CommandCatalog[T]["scope"];
export type CommandPayloadOf<T extends CommandType> = InferOutput<CommandCatalog[T]["payload"]>;

/**
 * Compile-time gate on the twelve command names: changing a key in
 * `COMMAND_CATALOG` makes an arm below non-`never` and fails `tsc`.
 */
type ExpectedCommandType =
  | "run.start"
  | "run.follow_up"
  | "run.pause"
  | "run.cancel"
  | "approval.resolve"
  | "approval.mode"
  | "question.resolve"
  | "context.add"
  | "agent.stop"
  | "checkpoint.create"
  | "policy.set"
  | "runtime.shutdown";

type CommandTypesMatchExpected = [
  Exclude<ExpectedCommandType, CommandType> extends never ? true : never,
  Exclude<CommandType, ExpectedCommandType> extends never ? true : never,
];
export const COMMAND_TYPES_MATCH_EXPECTED: CommandTypesMatchExpected = [true, true];

/**
 * The state a command's issuer believes holds, scoped by the command's own
 * `scope` so a run-scoped command without a runId cannot be written.
 */
export type CommandExpectation<T extends CommandType> =
  ScopeOfCommand<T> extends "run"
    ? { readonly scope: "run"; readonly state: RunState }
    : { readonly scope: "session"; readonly state: SessionState };

export type CommandEnvelopeFields<T extends CommandType> = {
  readonly commandId: CommandId;
  readonly sessionId: SessionId;
  readonly runId: RunIdFor<ScopeOfCommand<T>>;
  readonly issuedAt: Timestamp;
  readonly issuedByUserId: UserId;
  readonly expected: CommandExpectation<T>;
};

export type CommandOf<T extends CommandType> = T extends CommandType
  ? CommandEnvelopeFields<T> & { readonly type: T; readonly payload: CommandPayloadOf<T> }
  : never;

export type ProtocolCommand = CommandOf<CommandType>;

/**
 * Validates one command's payload. A rejection names the field path and
 * expectation, never the received value.
 */
export function parseCommandPayload<T extends CommandType>(
  type: T,
  raw: unknown,
): { readonly ok: true; readonly value: CommandPayloadOf<T> } | ParseFailure {
  const spec = COMMAND_CATALOG[type];
  const result = safeParse(spec.payload, raw);
  if (!result.success) {
    return toFailure("payload", result.issues, "payload");
  }
  return { ok: true, value: result.output as CommandPayloadOf<T> };
}

type Expectation =
  | { readonly scope: "run"; readonly state: RunState }
  | { readonly scope: "session"; readonly state: SessionState };

/**
 * Whether `type` may be issued given the state its issuer expects. A scope
 * mismatch between command and expectation returns false rather than throwing.
 */
export function canIssueCommand(type: CommandType, expected: Expectation): boolean {
  // Widened explicitly: indexing by a union `type` infers a union of literal
  // tuples, whose `.includes` accepts only states common to every entry.
  const spec: CommandSpecInput = COMMAND_CATALOG[type];
  if (spec.scope === "run") {
    if (expected.scope !== "run") return false;
    return spec.allowedRunStates.includes(expected.state);
  }
  if (expected.scope !== "session") return false;
  return spec.allowedSessionStates.includes(expected.state);
}

export interface CommandExpectations {
  readonly expected: Expectation;
  /**
   * Command ids the session already applied, so a retry returns the earlier
   * result instead of applying twice (record 01). Checked on the command path
   * because several events legitimately share one command id.
   */
  readonly processedCommandIds: ReadonlySet<string>;
}

export type CommandAdmission =
  | { readonly kind: "accept" }
  | { readonly kind: "already_processed"; readonly commandId: string }
  | { readonly kind: "wrong_state"; readonly type: CommandType };

/**
 * The admission decision for an inbound command. Idempotency is checked
 * before state, so a retry is reported as a repeat, not an illegal transition.
 */
export function admitCommand(
  type: CommandType,
  id: string,
  expectations: CommandExpectations,
): CommandAdmission {
  if (expectations.processedCommandIds.has(id)) {
    return { kind: "already_processed", commandId: id };
  }
  if (!canIssueCommand(type, expectations.expected)) {
    return { kind: "wrong_state", type };
  }
  return { kind: "accept" };
}

export { commandId };
