/**
 * The commands the session screen sends, each built from typed inputs. The
 * browser mints its own ids as plain strings; this is the one place they are
 * given the protocol's id brands, which the session object validates again.
 */
import type {
  ArtifactRef,
  CommandId,
  CommandPayloadOf,
  EffortLevel,
  ModelRecord,
  RunId,
  RunView,
} from "@oncue/protocol";
import type { OutgoingCommand } from "./use-session";

type MessageId = CommandPayloadOf<"run.start">["instruction"]["messageId"];
type ApprovalId = CommandPayloadOf<"approval.resolve">["approvalId"];
export type PolicyPayload = CommandPayloadOf<"policy.set">;
type ProposalId = Extract<PolicyPayload, { readonly action: "decline" }>["proposalId"];

export function asCommandId(id: string): CommandId {
  return id as CommandId;
}

function asMessageId(id: string): MessageId {
  return id as MessageId;
}

export function asProposalId(id: string): ProposalId {
  return id as ProposalId;
}

/** A new run, continuing `continuesRunId`'s conversation. The message id is the command id. */
export function startRunCommand(input: {
  readonly commandId: string;
  readonly text: string;
  readonly model: ModelRecord;
  readonly continuesRunId: RunId | null;
  readonly attachments?: readonly ArtifactRef[];
  readonly skipRequiredChecks?: boolean;
  readonly checksOnly?: boolean;
}): OutgoingCommand<"run.start"> {
  return {
    type: "run.start",
    commandId: asCommandId(input.commandId),
    runId: null,
    expected: { scope: "session", state: "active" },
    payload: {
      instruction: {
        messageId: asMessageId(input.commandId),
        text: input.text,
        attachments: [...(input.attachments ?? [])],
      },
      model: input.model,
      continuesRunId: input.continuesRunId,
      // Absent rather than false when not asked for, so the command omits the field.
      ...(input.skipRequiredChecks === true ? { skipRequiredChecks: true } : {}),
      ...(input.checksOnly === true ? { checksOnly: true } : {}),
    },
  };
}

/** A message into a run that has not ended: a steer, or held for the next run. */
export function followUpCommand(input: {
  readonly commandId: string;
  readonly run: Pick<RunView, "runId" | "state">;
  readonly text: string;
  readonly delivery: "steer_current_run" | "run_next";
  readonly attachments?: readonly ArtifactRef[];
  readonly skipRequiredChecks?: boolean;
  /** Only a held message may change the next run's effort. */
  readonly effort?: EffortLevel | null;
}): OutgoingCommand<"run.follow_up"> {
  return {
    type: "run.follow_up",
    commandId: asCommandId(input.commandId),
    runId: input.run.runId,
    expected: { scope: "run", state: input.run.state },
    payload: {
      messageId: asMessageId(input.commandId),
      text: input.text,
      attachments: [...(input.attachments ?? [])],
      delivery: input.delivery,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.skipRequiredChecks === true ? { skipRequiredChecks: true } : {}),
    },
  };
}

/** Ends the run as cancelled and keeps the sandbox (record 10). */
export function cancelRunCommand(
  run: Pick<RunView, "runId" | "state">,
  commandId: string,
): OutgoingCommand<"run.cancel"> {
  return {
    type: "run.cancel",
    commandId: asCommandId(commandId),
    runId: run.runId,
    expected: { scope: "run", state: run.state },
    payload: { reason: null, checkpointFirst: false },
  };
}

/** Only the approval id and decision: who decided and when are the control plane's to record. */
export function approvalCommand(
  runId: RunId,
  commandId: string,
  answer: { readonly approvalId: string; readonly decision: "approved" | "rejected" },
): OutgoingCommand<"approval.resolve"> {
  return {
    type: "approval.resolve",
    commandId: asCommandId(commandId),
    runId,
    expected: { scope: "run", state: "waiting_for_approval" },
    payload: { approvalId: answer.approvalId as ApprovalId, decision: answer.decision },
  };
}

export function policyCommand(
  commandId: string,
  payload: PolicyPayload,
): OutgoingCommand<"policy.set"> {
  return {
    type: "policy.set",
    commandId: asCommandId(commandId),
    runId: null,
    expected: { scope: "session", state: "active" },
    payload,
  };
}
