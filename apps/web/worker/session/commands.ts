// Plans one inbound command: a receipt, the events to commit, and the rows to
// write. Pure; the caller supplies the clock and ids. The order of checks is a
// correctness property (record 01): idempotency, admission, ownership, actual
// state, then the command's own rule. `command.expected` is what the issuer
// believed and `actualExpectation` what storage holds; a `wrong_state`
// rejection reports both (record 04).

import type {
  ApprovalState,
  PayloadOf,
  PermissionCategory,
  ProtocolCommand,
  ProtocolEvent,
  RunOutcome,
  RunState,
  SessionState,
} from "@oncue/protocol";
import { buildEvent, canIssueCommand } from "@oncue/protocol";
import type { AdmissionDecision } from "../admission";
import {
  decideConfirmation,
  decideControl,
  type OpenProposal,
  type SessionPolicy,
} from "../policy/git-policy";
import type { RuntimeResolution } from "../runtime/resolve";
import { applyModeChoice, offeredScopes, type SessionMode } from "./permission-asks";

/** The one open question, as the planner needs it; read only for a `question.resolve`, a follow-up, or a pause. */
export interface OpenQuestionFact {
  readonly questionId: string;
  readonly runId: string;
  readonly questionCount: number;
}

export interface OpenApproval {
  readonly approvalId: string;
  readonly state: ApprovalState;
  readonly requestedGeneration: number;
  /** Set for a harness permission ask (record 09); null for a secret, which is always one request. */
  readonly category?: PermissionCategory | null;
}

export type ActualExpectation =
  | { readonly scope: "run"; readonly state: RunState }
  | { readonly scope: "session"; readonly state: SessionState };

export type CommandRejectReason =
  | "wrong_state"
  | "stale_generation"
  | "unknown_approval"
  | "not_owner"
  | "admission_closed"
  | "duplicate"
  /** A refused harness, or an attachment this session cannot claim. */
  | "unsupported";

/**
 * What `decideModelChange` (`model-change.ts`) found for a `run.start` that
 * names another model than the session's latest run (record 15).
 */
export type ModelChangeOutcome =
  | { readonly kind: "changed" }
  | {
      readonly kind: "refused";
      readonly reason: "wrong_state" | "unsupported";
      readonly detail: string;
    };

export interface RunRowInsert {
  readonly runId: string;
  readonly state: RunState;
  readonly trigger: string;
  readonly instructionMessageId: string | null;
  readonly continuesRunId: string | null;
  readonly sandboxGeneration: number;
  readonly createdByCommandId: string;
  readonly queuedAt: string;
}

export interface RunRowUpdate {
  readonly runId: string;
  readonly state: RunState;
  readonly outcome: RunOutcome | null;
}

export interface ApprovalRowUpdate {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
  readonly decidedCommandId: string;
  readonly decidedForGeneration: number;
  readonly decidedAt: string;
}

export type CommandPlanRow =
  | { readonly kind: "insert_run"; readonly row: RunRowInsert }
  | { readonly kind: "update_run"; readonly row: RunRowUpdate }
  | { readonly kind: "update_approval"; readonly row: ApprovalRowUpdate }
  /** The policy now in force, with no proposal left open: a confirm, a decline, and a control all close the card. */
  | { readonly kind: "write_policy"; readonly policy: SessionPolicy }
  /** A card's "Allow for this session" (record 09). */
  | { readonly kind: "save_session_rule"; readonly category: PermissionCategory }
  /** The approval menu's choice, as the session keeps it. */
  | { readonly kind: "write_session_mode"; readonly mode: SessionMode }
  /** "Allow once" or "Always allow" in the menu: the session's per-category answers go. */
  | { readonly kind: "clear_session_rules" }
  /** The open question answered or dismissed, with the answers kept for a resume. */
  | {
      readonly kind: "settle_question";
      readonly questionId: string;
      readonly state: "answered" | "dismissed";
      readonly answersJson: string | null;
      readonly at: string;
    };

export interface CommandPlanInput {
  readonly command: ProtocolCommand;
  /** Whether this command id has already been committed (record 01). */
  readonly alreadyProcessed: boolean;
  readonly ownerUserId: string;
  readonly admission: AdmissionDecision;
  readonly actualExpectation: ActualExpectation;
  /** The session's own state, which a run-scoped command's expectation does not carry. */
  readonly sessionState: SessionState;
  readonly currentGeneration: number;
  /**
   * Whether a sandbox is live or starting. Continue (a steer on a paused or
   * interrupted run) starts a new generation, so it is refused while one is.
   */
  readonly computeAttached: boolean;
  /** False only when a command would start a new generation on a model connection that is no longer active. */
  readonly modelConnectionActive: boolean;
  /** False only for a `run.follow_up` naming an effort its run's model does not document. */
  readonly effortAccepted: boolean;
  /**
   * `decideModelChange`'s answer for a `run.start` that names another model
   * than the session's latest run; null or absent for one that keeps it. A
   * refusal rejects the start; a change is recorded as the run's trigger.
   */
  readonly modelChange?: ModelChangeOutcome | null;
  /**
   * `resolveRuntime`'s judgement for a `run.start`; null or absent otherwise.
   * A refusal rejects the start; a resolution is recorded on its `run.queued`.
   */
  readonly runtime?: RuntimeResolution | null;
  /** Why the message's attachments could not be claimed, or null. */
  readonly attachmentRefusal?: string | null;
  readonly openApproval: OpenApproval | null;
  /** The open question; read for a `question.resolve`, a follow-up, or a pause, absent or null otherwise. */
  readonly openQuestion?: OpenQuestionFact | null;
  /** The Git policy and its open proposal; set only for a `policy.set`. */
  readonly policy: { readonly stored: SessionPolicy; readonly open: OpenProposal | null } | null;
  /** For an `agent.stop`, whether that subagent of the run is running; absent otherwise. */
  readonly agentRunning?: boolean;
  readonly firstEventId: string;
  readonly domainEventId: string;
  readonly mintedRunId: string;
  readonly now: string;
  /** Set only when the object releases a held `run_next` message as a new run; clients never send it. */
  readonly trigger?: "queued_message";
}

export type CommandPlan =
  | { readonly kind: "already_processed"; readonly commandId: string }
  | {
      readonly kind: "reject";
      readonly reason: CommandRejectReason;
      readonly detail: string;
      readonly event: ProtocolEvent;
    }
  | {
      readonly kind: "accept";
      readonly events: readonly ProtocolEvent[];
      readonly rows: readonly CommandPlanRow[];
    };

interface Rejection {
  readonly reason: CommandRejectReason;
  readonly detail: string;
  readonly expectedState: string | null;
  readonly actualState: string | null;
}

/** Run-scoped commands that give a run more to do; the session-scoped ones are gated by the catalog. */
const RUN_WORK_COMMANDS: ReadonlySet<ProtocolCommand["type"]> = new Set([
  "run.follow_up",
  "approval.resolve",
  // An answer lets a waiting run go on, and resumes a paused one on a new sandbox.
  "question.resolve",
  "context.add",
]);

/** Admission, ownership, actual state, then the command's own rule; the order matters. */
function findRejection(input: CommandPlanInput): Rejection | null {
  const { command } = input;
  if (command.type === "run.start" && input.admission.kind !== "admit") {
    return {
      reason: "admission_closed",
      detail: input.admission.reason,
      expectedState: null,
      actualState: null,
    };
  }
  if (command.issuedByUserId !== input.ownerUserId) {
    return {
      reason: "not_owner",
      detail: "the issuing user does not own this session",
      expectedState: null,
      actualState: null,
    };
  }
  if (input.sessionState !== "active" && RUN_WORK_COMMANDS.has(command.type)) {
    // An archived session is read-only and a deleting one takes no new work.
    // Cancelling and pausing still stop work, so they stay open.
    return {
      reason: "wrong_state",
      detail: `${command.type} is not valid while the session is ${input.sessionState}`,
      expectedState: command.expected.state,
      actualState: input.sessionState,
    };
  }
  if (!canIssueCommand(command.type, input.actualExpectation)) {
    return {
      reason: "wrong_state",
      detail: `${command.type} is not valid while ${input.actualExpectation.scope} is ${input.actualExpectation.state}`,
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (
    command.type === "run.follow_up" &&
    (input.actualExpectation.state === "paused" || input.actualExpectation.state === "interrupted")
  ) {
    // A held message would wait for a terminal event a paused run never
    // sends, and resuming onto a live sandbox would start a second runtime.
    if (command.payload.delivery === "run_next" || input.computeAttached) {
      return {
        reason: "wrong_state",
        detail: input.computeAttached
          ? `a ${input.actualExpectation.state} run is continued only once its sandbox has stopped`
          : `a ${input.actualExpectation.state} run is continued with a steer, not held for a next run`,
        expectedState: command.expected.state,
        actualState: input.actualExpectation.state,
      };
    }
  }
  if (input.modelChange?.kind === "refused") {
    return {
      reason: input.modelChange.reason,
      detail: input.modelChange.detail,
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (!input.modelConnectionActive) {
    // Fixed wording, never the provider's: only the connection's status was read.
    return {
      reason: "wrong_state",
      detail:
        "this run's model connection is not active; add a working key under Settings, Model providers and start a new session",
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (!input.effortAccepted) {
    return {
      reason: "wrong_state",
      detail: "this run's model does not offer that effort level",
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (input.runtime?.kind === "refused") {
    return {
      reason: "unsupported",
      detail: input.runtime.detail,
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (typeof input.attachmentRefusal === "string") {
    return {
      reason: "unsupported",
      detail: input.attachmentRefusal,
      expectedState: null,
      actualState: null,
    };
  }
  if (command.type === "policy.set") {
    const decision = decidePolicySet(input, command.payload);
    if (decision.kind === "refuse") {
      return {
        reason: "wrong_state",
        detail: POLICY_REFUSALS[decision.reason],
        expectedState: command.expected.state,
        actualState: input.actualExpectation.state,
      };
    }
  }
  if (command.type === "agent.stop" && input.agentRunning !== true) {
    return {
      reason: "wrong_state",
      detail: "that subagent is not running in this run",
      expectedState: command.expected.state,
      actualState: input.actualExpectation.state,
    };
  }
  if (command.type === "question.resolve") {
    const refusal = questionRefusal(input, command.payload, command.runId as string);
    if (refusal !== null) {
      return {
        reason: "wrong_state",
        detail: refusal,
        expectedState: command.expected.state,
        actualState: input.actualExpectation.state,
      };
    }
  }
  if (command.type === "approval.resolve") {
    const payload = command.payload;
    const open = input.openApproval;
    if (open === null || open.approvalId !== payload.approvalId || open.state !== "requested") {
      return {
        reason: "unknown_approval",
        detail: "no open approval matches this id",
        expectedState: "requested",
        actualState: open === null ? null : open.state,
      };
    }
    if (open.requestedGeneration !== input.currentGeneration) {
      return {
        reason: "stale_generation",
        detail: `approval requested under generation ${open.requestedGeneration}, current is ${input.currentGeneration}`,
        expectedState: null,
        actualState: null,
      };
    }
    // A wider answer than the card offers, or a denial that claims a scope,
    // is refused whatever the browser sent (record 09).
    const scope = payload.scope ?? "once";
    const offered =
      open.category === undefined || open.category === null
        ? ["once"]
        : offeredScopes(open.category);
    if (!offered.includes(scope) || (payload.decision === "rejected" && scope !== "once")) {
      return {
        reason: "unsupported",
        detail: "this approval offers only Allow once or Deny",
        expectedState: null,
        actualState: null,
      };
    }
  }
  return null;
}

type QuestionResolvePayload = Extract<ProtocolCommand, { type: "question.resolve" }>["payload"];

/** Why a `question.resolve` is refused, or null. */
function questionRefusal(
  input: CommandPlanInput,
  payload: QuestionResolvePayload,
  runId: string,
): string | null {
  const open = input.openQuestion ?? null;
  if (open === null || open.questionId !== payload.questionId || open.runId !== runId) {
    return "no open question matches this id";
  }
  if (payload.action === "answer" && payload.answers.length > open.questionCount) {
    return "there are more answers than questions";
  }
  const stopped =
    input.actualExpectation.state === "paused" || input.actualExpectation.state === "interrupted";
  if (payload.action === "answer" && stopped && input.computeAttached) {
    // The answer resumes the run, and resuming onto a live sandbox would start
    // a second runtime. Only the idle stop's pause gets here, while it stops.
    return "the sandbox is still stopping; the answer can resume the run once it has stopped";
  }
  return null;
}

function questionSettled(
  input: CommandPlanInput,
  runId: string,
  questionId: string,
  answers: readonly (readonly string[])[] | null,
  reason: "user" | "message_sent" | "run_paused",
): PlanBody {
  const command = input.command;
  const envelope = {
    eventId: input.domainEventId,
    sessionId: command.sessionId,
    runId,
    sandboxGeneration: input.currentGeneration,
    runtimeSequence: null,
    occurredAt: input.now,
  };
  const decidedBy = command.issuedByUserId as PayloadOf<"question.answered">["decidedBy"];
  const id = questionId as PayloadOf<"question.answered">["questionId"];
  const event =
    answers === null
      ? buildEvent("question.dismissed", {
          ...envelope,
          payload: { questionId: id, reason, decidedBy, commandId: command.commandId },
        })
      : buildEvent("question.answered", {
          ...envelope,
          payload: {
            questionId: id,
            answers: answers.map((answer) => [...answer]),
            decidedBy,
            commandId: command.commandId,
          },
        });
  return {
    domainEvents: [event],
    rows: [
      {
        kind: "settle_question",
        questionId,
        state: answers === null ? "dismissed" : "answered",
        answersJson: answers === null ? null : JSON.stringify(answers),
        at: input.now,
      },
    ],
  };
}

function acknowledgedEvent(input: CommandPlanInput): ProtocolEvent {
  return buildEvent("command.acknowledged", {
    eventId: input.firstEventId,
    sessionId: input.command.sessionId,
    runId: null,
    sandboxGeneration: input.currentGeneration,
    runtimeSequence: null,
    occurredAt: input.now,
    payload: {
      commandId: input.command.commandId,
      commandType: input.command.type,
      acceptedBy: "control_plane",
    },
  });
}

interface PlanBody {
  readonly domainEvents: readonly ProtocolEvent[];
  readonly rows: readonly CommandPlanRow[];
}

type PolicySetPayload = Extract<ProtocolCommand, { type: "policy.set" }>["payload"];

const POLICY_REFUSALS = {
  no_open_proposal: "no policy change is waiting for confirmation",
  superseded: "that policy change was replaced by a newer one",
  stale_version: "the session's policy changed after this was shown; review it again",
  no_change: "the policy already says that",
} as const;

/** `git-policy.ts` decides; this picks which decision the action asks for. */
function decidePolicySet(input: CommandPlanInput, payload: PolicySetPayload) {
  const { stored, open } = input.policy as NonNullable<CommandPlanInput["policy"]>;
  if (payload.action === "set") {
    return decideControl(stored, payload, payload.policyVersion);
  }
  return decideConfirmation(stored, open, {
    proposalId: payload.proposalId,
    policyVersion: payload.action === "confirm" ? payload.policyVersion : stored.version,
    accept: payload.action === "confirm",
  });
}

function planPolicySet(
  input: CommandPlanInput,
  command: Extract<ProtocolCommand, { type: "policy.set" }>,
): PlanBody {
  const { stored } = input.policy as NonNullable<CommandPlanInput["policy"]>;
  const decision = decidePolicySet(input, command.payload);
  const envelope = {
    eventId: input.domainEventId,
    sessionId: command.sessionId,
    runId: null,
    sandboxGeneration: input.currentGeneration,
    runtimeSequence: null,
    occurredAt: input.now,
  };
  if (decision.kind === "apply") {
    const updated = buildEvent("policy.updated", {
      ...envelope,
      payload: {
        proposalId: command.payload.action === "confirm" ? command.payload.proposalId : null,
        from: stored,
        to: decision.to,
        confirmedBy: command.payload.action === "confirm" ? "user_confirmation" : "product_control",
        userId: command.issuedByUserId,
        effectiveAt: input.now,
      },
    });
    return { domainEvents: [updated], rows: [{ kind: "write_policy", policy: decision.to }] };
  }
  // `findRejection` already refused the rest, so this is a decline.
  const declined = buildEvent("policy.declined", {
    ...envelope,
    payload: {
      proposalId: (command.payload as Extract<PolicySetPayload, { action: "decline" }>).proposalId,
      userId: command.issuedByUserId,
      declinedAt: input.now,
    },
  });
  return { domainEvents: [declined], rows: [{ kind: "write_policy", policy: stored }] };
}

function planBody(input: CommandPlanInput): PlanBody {
  const { command } = input;
  if (command.type === "policy.set") {
    return planPolicySet(input, command);
  }
  if (command.type === "run.start") {
    const payload = command.payload;
    // A client `run.start` that continues a run is a follow-up, or a model
    // change when the owner named another model for it (record 15); a released
    // `run_next` message passes `queued_message`. Checks-only runs are always
    // `checks_requested` (record 14).
    const trigger =
      payload.checksOnly === true
        ? "checks_requested"
        : payload.continuesRunId === null
          ? "initial"
          : input.modelChange?.kind === "changed"
            ? "model_change"
            : (input.trigger ?? "follow_up");
    const domainEvent = buildEvent("run.queued", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: input.mintedRunId,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        commandId: command.commandId,
        instruction: payload.instruction,
        model: payload.model,
        ...(input.runtime?.kind === "resolved" ? { runtime: input.runtime.runtime } : {}),
        trigger,
        continuesRunId: payload.continuesRunId,
      },
    });
    return {
      domainEvents: [domainEvent],
      rows: [
        {
          kind: "insert_run",
          row: {
            runId: input.mintedRunId,
            state: "queued",
            trigger,
            instructionMessageId: payload.instruction.messageId,
            continuesRunId: payload.continuesRunId,
            sandboxGeneration: input.currentGeneration,
            createdByCommandId: command.commandId,
            queuedAt: input.now,
          },
        },
      ],
    };
  }
  if (command.type === "question.resolve") {
    const payload = command.payload;
    return questionSettled(
      input,
      command.runId,
      payload.questionId,
      payload.action === "answer" ? payload.answers : null,
      "user",
    );
  }
  if (command.type === "run.follow_up") {
    const payload = command.payload;
    // A message sent while a question waits answers it in the user's own
    // words: the card is dismissed and the message is delivered as usual.
    const open = input.openQuestion ?? null;
    const dismissal =
      open !== null && open.runId === command.runId
        ? questionSettled(
            { ...input, domainEventId: `${input.domainEventId}-question` },
            command.runId,
            open.questionId,
            null,
            "message_sent",
          )
        : null;
    const domainEvent = buildEvent("message.queued", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: null,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        messageId: payload.messageId,
        commandId: command.commandId,
        text: payload.text,
        delivery: payload.delivery,
        deliveredToRunId: payload.delivery === "steer_current_run" ? command.runId : null,
        // Omitted when empty, so the event keeps its shape without attachments.
        ...(payload.attachments.length === 0 ? {} : { attachments: payload.attachments }),
      },
    });
    return dismissal === null
      ? { domainEvents: [domainEvent], rows: [] }
      : { domainEvents: [...dismissal.domainEvents, domainEvent], rows: dismissal.rows };
  }
  if (command.type === "run.pause") {
    const payload = command.payload;
    // The user's pause aborts the turn the harness asked in, so the question
    // closes with it rather than wait while the sandbox idles; a later answer
    // could not reach the run until then.
    const open = input.openQuestion ?? null;
    const dismissal =
      open !== null && open.runId === command.runId
        ? questionSettled(
            { ...input, domainEventId: `${input.domainEventId}-question` },
            command.runId,
            open.questionId,
            null,
            "run_paused",
          )
        : null;
    const domainEvent = buildEvent("run.paused", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: command.runId,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: { reason: payload.reason, detail: "", checkpointId: null },
    });
    const pausedRow: CommandPlanRow = {
      kind: "update_run",
      row: { runId: command.runId, state: "paused", outcome: null },
    };
    return {
      domainEvents: dismissal === null ? [domainEvent] : [...dismissal.domainEvents, domainEvent],
      rows: dismissal === null ? [pausedRow] : [...dismissal.rows, pausedRow],
    };
  }
  if (command.type === "run.cancel") {
    const domainEvent = buildEvent("run.cancelled", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: command.runId,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        by: { kind: "user", userId: command.issuedByUserId },
        checkpointId: null,
        summary: null,
        evidence: [],
        branch: null,
        pullRequestNumber: null,
        usage: null,
        durationMs: 0,
      },
    });
    return {
      domainEvents: [domainEvent],
      rows: [
        {
          kind: "update_run",
          row: { runId: command.runId, state: "cancelled", outcome: "cancelled" },
        },
      ],
    };
  }
  if (command.type === "approval.mode") {
    const domainEvent = buildEvent("approval.mode_changed", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: null,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        mode: command.payload.mode,
        decidedBy: command.issuedByUserId as PayloadOf<"approval.mode_changed">["decidedBy"],
        commandId: command.commandId,
      },
    });
    const choice = applyModeChoice(command.payload.mode);
    return {
      domainEvents: [domainEvent],
      rows: [
        { kind: "write_session_mode", mode: choice.session },
        ...(choice.clearsRules ? [{ kind: "clear_session_rules" as const }] : []),
      ],
    };
  }
  if (command.type === "approval.resolve") {
    const payload = command.payload;
    // A permission ask records what the answer covers; a secret's event keeps its old shape.
    const category = input.openApproval?.category ?? null;
    const scope = payload.scope ?? "once";
    const domainEvent = buildEvent("approval.resolved", {
      eventId: input.domainEventId,
      sessionId: command.sessionId,
      runId: command.runId,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        approvalId: payload.approvalId,
        decision: payload.decision,
        // The user the Worker verified on this socket; a browser does not get
        // to say who decided.
        decidedBy: command.issuedByUserId as PayloadOf<"approval.resolved">["decidedBy"],
        commandId: command.commandId,
        decidedForGeneration: input.currentGeneration,
        ...(category === null ? {} : { scope }),
      },
    });
    return {
      domainEvents: [domainEvent],
      rows: [
        ...(category !== null && payload.decision === "approved" && scope === "session"
          ? [{ kind: "save_session_rule" as const, category }]
          : []),
        {
          kind: "update_approval",
          row: {
            approvalId: payload.approvalId,
            decision: payload.decision,
            decidedBy: command.issuedByUserId,
            decidedCommandId: command.commandId,
            decidedForGeneration: input.currentGeneration,
            // The object's clock, for the same reason.
            decidedAt: input.now,
          },
        },
        // Either way the run goes on; a denial rejects only the tool call (record 09).
        { kind: "update_run", row: { runId: command.runId, state: "running", outcome: null } },
      ],
    };
  }
  // context.add, agent.stop, checkpoint.create, and runtime.shutdown only
  // acknowledge. Nothing drives their side effects from here: context.add has
  // no delivery to the runtime, a stop is the bridge's to carry out and ends
  // with the subagent's `agent.completed`, and a client's checkpoint.create
  // must not bypass the publish gate, which is the only push path.
  return { domainEvents: [], rows: [] };
}

export function planCommand(input: CommandPlanInput): CommandPlan {
  if (input.alreadyProcessed) {
    return { kind: "already_processed", commandId: input.command.commandId };
  }
  const rejection = findRejection(input);
  if (rejection !== null) {
    const event = buildEvent("command.rejected", {
      eventId: input.firstEventId,
      sessionId: input.command.sessionId,
      runId: null,
      sandboxGeneration: input.currentGeneration,
      runtimeSequence: null,
      occurredAt: input.now,
      payload: {
        commandId: input.command.commandId,
        commandType: input.command.type,
        reason: rejection.reason,
        expectedState: rejection.expectedState,
        actualState: rejection.actualState,
        detail: rejection.detail,
      },
    });
    return { kind: "reject", reason: rejection.reason, detail: rejection.detail, event };
  }
  const body = planBody(input);
  return {
    kind: "accept",
    events: [acknowledgedEvent(input), ...body.domainEvents],
    rows: body.rows,
  };
}
