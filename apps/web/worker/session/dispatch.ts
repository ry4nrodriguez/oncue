// Plans what the object owes the bridge: frames to send, rows recording the
// intent, and events an ack produces. Delivery is at-least-once and a lost ack
// is answered by a resend (record 04). Pure; the caller supplies clock and ids.
// A `bridge_dispatch` row is an intent, never a credential: grant rows hold
// only the coordinates a token is minted from, and the shell mints at send time.

import type {
  AckFrame,
  AckRejection,
  DeliverableCommand,
  DeliverableCommandType,
} from "@oncue/bridge";
import type {
  EventType,
  ModelRecord,
  ProtocolCommand,
  ProtocolEvent,
  RunOutcome,
  RunState,
} from "@oncue/protocol";
import { buildEvent, type EffortLevel, isTerminal } from "@oncue/protocol";
import { grantTaskBranch } from "./branch-naming";

export type DispatchState = "pending" | "sent" | "accepted" | "rejected";

/** Coordinates a token is minted FROM. No arm carries a token, a key, or a keyring. */
export type DispatchKind =
  | {
      readonly kind: "command";
      readonly commandJson: string;
      /** The run the bridge charges the command to; see `chargedRunId`. */
      readonly runId: string | null;
      /** Record 11's context summary for a resumed run's first prompt. Absent on older rows. */
      readonly context?: string | null;
    }
  | {
      readonly kind: "model_grant";
      readonly connectionId: string;
      readonly modelId: string;
      readonly providerId: string;
      readonly workspace: "repository" | "none";
      /** The run's effort at planning time; older rows carry none. */
      readonly effort: EffortLevel | null;
    }
  | {
      readonly kind: "git_grant";
      readonly installationId: number;
      readonly repositoryId: number;
      readonly fullName: string;
      readonly cloneUrl: string;
      /** The branch to clone: the task branch once named, the base branch before. */
      readonly branch: string;
      /** Null until the first push names it. Absent on older rows, whose `branch` is the task branch. */
      readonly taskBranch?: string | null;
      readonly baseSha: string;
      /** The last pushed checkpoint, or `baseSha` before any. Absent on older rows. */
      readonly headSha?: string;
      /** A patch bundle checkpoint newer than `headSha`, restored after the clone. */
      readonly restoreArtifactId?: string | null;
    }
  | {
      readonly kind: "push_grant";
      readonly installationId: number;
      readonly repositoryId: number;
      readonly fullName: string;
      readonly cloneUrl: string;
      readonly ref: string;
      readonly parentSha: string;
    }
  | {
      readonly kind: "upload_grant";
      readonly artifactId: string;
      readonly maxBytes: number;
    }
  /** Development secrets owed to the bridge, by name only: values are opened at send time, never stored. */
  | {
      readonly kind: "secret_grant";
      readonly names: readonly string[];
      /** The bridge's reference for the held tool call an approval releases, or null for a launch's selection. */
      readonly requestRef: string | null;
      readonly approvalId: string | null;
    };

/**
 * The value `bridge_dispatch.kind` stores. Its CHECK allows only three kinds
 * and SQLite cannot alter a CHECK on existing tables, so later grant kinds are
 * stored as `git_grant`; the kind in `payload_json` is the truth.
 */
export const DISPATCH_COLUMN_KIND: Readonly<
  Record<DispatchKind["kind"], "command" | "model_grant" | "git_grant">
> = {
  command: "command",
  model_grant: "model_grant",
  git_grant: "git_grant",
  push_grant: "git_grant",
  upload_grant: "git_grant",
  secret_grant: "git_grant",
};

export interface DispatchRow {
  readonly intentId: string;
  readonly generation: number;
  readonly kind: DispatchKind;
  readonly state: DispatchState;
  readonly attempts: number;
  readonly createdAt: string;
}

export interface HeldMessage {
  readonly messageId: string;
  readonly commandId: string;
  readonly issuedByUserId: string;
  readonly text: string;
  readonly attachments: readonly unknown[];
  readonly heldAt: string;
  /** The follow-up's own `skipRequiredChecks`, carried onto the `run.start` it is released as. */
  readonly skipRequiredChecks: boolean;
  /** The effort the follow-up named for the run it starts; absent keeps the model record's. */
  readonly effort?: EffortLevel | null;
}

/** The `session_repository` row, or null for a session with no repository. */
export type SessionRepository = Extract<DispatchKind, { kind: "git_grant" }> & {
  readonly gitGrantRevoked: boolean;
};

export interface DispatchStateView {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly generation: number;
  /** True once `runtime.ready` was committed for this generation. Gates every command. */
  readonly runtimeReady: boolean;
  /** True while a negotiated bridge socket for this generation is open. */
  readonly bridgeAttached: boolean;
  /** Every `bridge_dispatch` row for this generation, in any state, oldest first. */
  readonly rows: readonly DispatchRow[];
  /** `released_at IS NULL`, oldest first. */
  readonly held: readonly HeldMessage[];
  readonly currentRunId: string | null;
  /** False once the current run reached an outcome: nothing here ends it a second time. */
  readonly currentRunOpen: boolean;
  readonly repository: SessionRepository | null;
  /** From the current run's `run.queued`: what the model grant and a continuation use. */
  readonly model: ModelRecord | null;
}

export type DispatchInput =
  /** A bridge socket for the current generation finished its handshake. The redelivery point. */
  | {
      readonly kind: "bridge_connected";
      readonly now: string;
      readonly mintedGrantIds: readonly [string, string];
      readonly newEventId: () => string;
    }
  /** `planCommand` accepted a client command. Only deliverable types produce a row. */
  | {
      readonly kind: "command_admitted";
      readonly command: ProtocolCommand;
      readonly now: string;
      /** From `chargedRunId`: the run the bridge's events for this command will name. */
      readonly runId: string | null;
      /** Set only on the `run.start` a resumed generation opens with. */
      readonly context?: string;
      /**
       * For the model grant a client's `run.start` needs first when it names
       * another model or effort than the generation's newest grant. Absent,
       * no grant is planned.
       */
      readonly mintedGrantId?: string;
    }
  /** `runtime.ready` was committed. Flushes every pending command row. */
  | { readonly kind: "runtime_ready"; readonly now: string }
  | {
      readonly kind: "ack";
      readonly frame: AckFrame;
      readonly now: string;
      readonly eventId: string;
    }
  /** A run reached a terminal event (from ingest, or the object's own `run.cancelled`). */
  | {
      readonly kind: "run_terminal";
      readonly runId: string;
      readonly now: string;
      readonly mintedRunId: string;
      readonly mintedCommandId: string;
      /** For the model grant a continuation at a different effort needs. */
      readonly mintedGrantId: string;
    }
  /** `repository.status` was committed, or the git-grant alarm fired: the token has done its one job. */
  | { readonly kind: "repository_status" }
  /** The stop asks the bridge to checkpoint: an optional push grant, then the object's `checkpoint.create`. */
  | {
      readonly kind: "checkpoint_requested";
      readonly command: DeliverableCommand;
      readonly now: string;
      readonly push: { readonly grantId: string; readonly parentSha: string } | null;
    }
  /** `artifact.uploading` was admitted within policy: the bridge is owed a one-time upload grant. */
  | {
      readonly kind: "upload_requested";
      readonly artifactId: string;
      readonly grantId: string;
      readonly maxBytes: number;
      readonly now: string;
    }
  /** The user confirmed secrets at launch, or approved one: the bridge is owed their values. */
  | {
      readonly kind: "secrets_requested";
      readonly grantId: string;
      readonly names: readonly string[];
      readonly requestRef: string | null;
      readonly approvalId: string | null;
      readonly now: string;
    }
  /** The generation ended (stop, failure). Open rows are abandoned; held messages survive. */
  | { readonly kind: "generation_ended" };

export type DispatchRowChange =
  | { readonly kind: "insert_dispatch"; readonly row: DispatchRow }
  | {
      readonly kind: "mark_dispatch";
      readonly intentId: string;
      readonly state: DispatchState;
      readonly bumpAttempts: boolean;
    }
  | { readonly kind: "delete_open_for_generation"; readonly generation: number }
  | { readonly kind: "hold_message"; readonly row: HeldMessage }
  | { readonly kind: "release_message"; readonly messageId: string; readonly runId: string }
  | { readonly kind: "mark_git_grant_revoked" }
  /** The cached run row for a `run.failed` this planner emits, in the same transaction as the event that proves it. */
  | { readonly kind: "fail_run"; readonly runId: string };

/** A frame the shell must send, with the credential it must mint first as a HOLE the planner cannot fill. */
export type OutboundFrame =
  | {
      readonly kind: "command";
      readonly intentId: string;
      readonly command: DeliverableCommand;
      readonly runId: string | null;
      readonly context: string | null;
    }
  | {
      readonly kind: "model_grant";
      readonly intentId: string;
      readonly need: Extract<DispatchKind, { kind: "model_grant" }>;
    }
  | {
      readonly kind: "git_grant";
      readonly intentId: string;
      readonly need: Extract<DispatchKind, { kind: "git_grant" }>;
    }
  | {
      readonly kind: "push_grant";
      readonly intentId: string;
      readonly need: Extract<DispatchKind, { kind: "push_grant" }>;
    }
  | {
      readonly kind: "upload_grant";
      readonly intentId: string;
      readonly need: Extract<DispatchKind, { kind: "upload_grant" }>;
    }
  | {
      readonly kind: "secret_grant";
      readonly intentId: string;
      readonly need: Extract<DispatchKind, { kind: "secret_grant" }>;
    };

export interface DispatchPlan {
  readonly rows: readonly DispatchRowChange[];
  /** In order, on one socket: grants before commands. */
  readonly frames: readonly OutboundFrame[];
  /** `command.acknowledged { acceptedBy: "bridge" }`, `command.rejected`, and a rejected model grant's `run.failed`, built here. */
  readonly events: readonly ProtocolEvent[];
  /** A released continuation `run.start` and its run id; the shell commits it like a client command. */
  readonly continuation: { readonly command: DeliverableCommand; readonly runId: string } | null;
  /** Asks the shell to revoke the clone's token if it still holds it. */
  readonly revokeGitToken: boolean;
  /** The bridge refused the `checkpoint.create` this plan acknowledges, so the stop must move on without it. */
  readonly checkpointRefused: boolean;
  /** The bridge answered a secret grant: the names it covered, and whether every file is in place. */
  readonly secretsSettled: {
    readonly names: readonly string[];
    readonly approvalId: string | null;
    readonly accepted: boolean;
  } | null;
}

export const GIT_GRANT_TIMEOUT_MS = 10 * 60 * 1000;
/** A push to one branch, not a clone, so a shorter timeout (record 07). */
export const PUSH_GRANT_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_DISPATCH_ATTEMPTS = 5;
export const SHUTDOWN_GRACE_MS = 2_000;

const EMPTY_PLAN: DispatchPlan = {
  rows: [],
  frames: [],
  events: [],
  continuation: null,
  revokeGitToken: false,
  checkpointRefused: false,
  secretsSettled: null,
};

const DELIVERABLE_COMMAND_TYPES: ReadonlySet<string> = new Set<DeliverableCommandType>([
  "run.start",
  "run.follow_up",
  "run.cancel",
  "agent.stop",
  "checkpoint.create",
  "runtime.shutdown",
]);

function isDeliverable(command: ProtocolCommand): command is DeliverableCommand {
  return DELIVERABLE_COMMAND_TYPES.has(command.type);
}

/** Record 04's mapping from the bridge's five reasons onto `command.rejected`'s own enum. */
const REJECTION_REASON: Record<AckRejection, "wrong_state" | "duplicate" | "unsupported"> = {
  wrong_state: "wrong_state",
  duplicate: "duplicate",
  no_runtime: "wrong_state",
  unsupported: "unsupported",
  malformed: "unsupported",
};

function isOpen(row: DispatchRow): boolean {
  return row.state === "pending" || row.state === "sent";
}

function commandOf(row: DispatchRow & { readonly kind: { readonly kind: "command" } }) {
  return JSON.parse(row.kind.commandJson) as DeliverableCommand;
}

function rejectedEvent(
  view: DispatchStateView,
  command: DeliverableCommand,
  reason: "wrong_state" | "duplicate" | "unsupported",
  detail: string,
  eventId: string,
  now: string,
): ProtocolEvent {
  return buildEvent("command.rejected", {
    eventId,
    sessionId: view.sessionId,
    runId: null,
    sandboxGeneration: view.generation,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      commandId: command.commandId,
      commandType: command.type,
      reason,
      expectedState: null,
      actualState: null,
      detail,
    },
  });
}

function outboundFor(row: DispatchRow): OutboundFrame {
  const kind = row.kind;
  switch (kind.kind) {
    case "command":
      return {
        kind: "command",
        intentId: row.intentId,
        command: JSON.parse(kind.commandJson),
        runId: kind.runId,
        context: kind.context ?? null,
      };
    case "model_grant":
      return { kind: "model_grant", intentId: row.intentId, need: kind };
    case "git_grant":
      return { kind: "git_grant", intentId: row.intentId, need: kind };
    case "push_grant":
      return { kind: "push_grant", intentId: row.intentId, need: kind };
    case "upload_grant":
      return { kind: "upload_grant", intentId: row.intentId, need: kind };
    case "secret_grant":
      return { kind: "secret_grant", intentId: row.intentId, need: kind };
  }
}

/**
 * The redelivery point. Each grant is planned at most once per generation and
 * every open row is re-sent; after `MAX_DISPATCH_ATTEMPTS` unacknowledged
 * sends a row is given up (a command as `command.rejected`, a grant silently).
 */
function planBridgeConnected(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "bridge_connected" }>,
): DispatchPlan {
  const rows: DispatchRowChange[] = [];
  const frames: OutboundFrame[] = [];
  const events: ProtocolEvent[] = [];
  const open: DispatchRow[] = view.rows.filter(isOpen);
  const [gitGrantId, modelGrantId] = input.mintedGrantIds;

  const hasGitGrant = view.rows.some((row) => row.kind.kind === "git_grant");
  if (view.repository !== null && !view.repository.gitGrantRevoked && !hasGitGrant) {
    const { gitGrantRevoked: _revoked, ...need } = view.repository;
    const row: DispatchRow = {
      intentId: gitGrantId,
      generation: view.generation,
      kind: need,
      state: "pending",
      attempts: 0,
      createdAt: input.now,
    };
    rows.push({ kind: "insert_dispatch", row });
    open.push(row);
  }
  const hasModelGrant = view.rows.some((row) => row.kind.kind === "model_grant");
  if (view.model !== null && !hasModelGrant) {
    const row: DispatchRow = {
      intentId: modelGrantId,
      generation: view.generation,
      kind: {
        kind: "model_grant",
        connectionId: view.model.modelConnectionId,
        modelId: view.model.modelId,
        providerId: view.model.provider,
        workspace: view.repository === null ? "none" : "repository",
        effort: view.model.effort ?? null,
      },
      state: "pending",
      attempts: 0,
      createdAt: input.now,
    };
    rows.push({ kind: "insert_dispatch", row });
    open.push(row);
  }

  const send = (row: DispatchRow): void => {
    if (row.attempts >= MAX_DISPATCH_ATTEMPTS) {
      rows.push({
        kind: "mark_dispatch",
        intentId: row.intentId,
        state: "rejected",
        bumpAttempts: false,
      });
      if (row.kind.kind === "command") {
        events.push(
          rejectedEvent(
            view,
            commandOf(row as DispatchRow & { readonly kind: { readonly kind: "command" } }),
            "unsupported",
            "bridge never acknowledged",
            input.newEventId(),
            input.now,
          ),
        );
      }
      return;
    }
    frames.push(outboundFor(row));
    rows.push({ kind: "mark_dispatch", intentId: row.intentId, state: "sent", bumpAttempts: true });
  };

  for (const row of open.filter((row) => row.kind.kind === "git_grant")) {
    send(row);
  }
  for (const row of open.filter((row) => row.kind.kind === "model_grant")) {
    send(row);
  }
  for (const row of open.filter(
    (row) =>
      row.kind.kind === "push_grant" ||
      row.kind.kind === "upload_grant" ||
      row.kind.kind === "secret_grant",
  )) {
    send(row);
  }
  for (const row of open.filter((row) => row.kind.kind === "command")) {
    const command = commandOf(row as DispatchRow & { readonly kind: { readonly kind: "command" } });
    if (view.runtimeReady || command.type === "checkpoint.create") {
      send(row);
    }
  }
  return { ...EMPTY_PLAN, rows, frames, events };
}

function planCommandAdmitted(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "command_admitted" }>,
): DispatchPlan {
  const command = input.command;
  // A client `checkpoint.create` stops here; the bridge only acts on the
  // object's own, sent with its push grant through `checkpoint_requested`.
  if (!isDeliverable(command) || command.type === "checkpoint.create") {
    return EMPTY_PLAN;
  }
  if (command.type === "run.follow_up" && command.payload.delivery === "run_next") {
    const payload = command.payload;
    return {
      ...EMPTY_PLAN,
      rows: [
        {
          kind: "hold_message",
          row: {
            messageId: payload.messageId,
            commandId: command.commandId,
            issuedByUserId: command.issuedByUserId,
            text: payload.text,
            attachments: payload.attachments,
            heldAt: input.now,
            skipRequiredChecks: payload.skipRequiredChecks === true,
            // Spread, not `undefined`, for `exactOptionalPropertyTypes`.
            ...(payload.effort === undefined ? {} : { effort: payload.effort }),
          },
        },
      ],
    };
  }
  // A shutdown needs a bridge and nothing more; every other command waits
  // for the runtime the bridge starts.
  const deliverable =
    command.type === "runtime.shutdown"
      ? view.bridgeAttached
      : view.runtimeReady && view.bridgeAttached;
  const context = input.context ?? null;
  const row: DispatchRow = {
    intentId: command.commandId,
    generation: view.generation,
    kind: { kind: "command", commandJson: JSON.stringify(command), runId: input.runId, context },
    state: deliverable ? "sent" : "pending",
    attempts: deliverable ? 1 : 0,
    createdAt: input.now,
  };
  const rows: DispatchRowChange[] = [];
  const frames: OutboundFrame[] = [];
  // The broker token names one model and one effort, so a run on another needs
  // a fresh model grant, sent ahead of its start on the same socket. A first
  // grant is planned at the bridge's hello instead, from the run then current.
  const need = regrantFor(view, command, input.mintedGrantId, input.now);
  if (need !== null) {
    rows.push({ kind: "insert_dispatch", row: need.row });
    if (view.bridgeAttached) {
      frames.push({ kind: "model_grant", intentId: need.row.intentId, need: need.kind });
    }
  }
  rows.push({ kind: "insert_dispatch", row });
  if (deliverable) {
    frames.push({
      kind: "command",
      intentId: command.commandId,
      command,
      runId: input.runId,
      context,
    });
  }
  return { ...EMPTY_PLAN, rows, frames };
}

type ModelGrantKind = Extract<DispatchKind, { kind: "model_grant" }>;

/**
 * The model grant a `run.start` needs before it, or null: the generation has
 * a grant already and the run's model, connection, or effort differs from the
 * newest one the bridge did not refuse. A checks-only run prompts no model.
 */
function regrantFor(
  view: DispatchStateView,
  command: DeliverableCommand,
  mintedGrantId: string | undefined,
  now: string,
): { readonly row: DispatchRow; readonly kind: ModelGrantKind } | null {
  if (
    mintedGrantId === undefined ||
    command.type !== "run.start" ||
    command.payload.checksOnly === true
  ) {
    return null;
  }
  const granted = latestModelGrant(view.rows);
  const model = command.payload.model;
  const effort = model.effort ?? null;
  if (
    granted === null ||
    (granted.connectionId === model.modelConnectionId &&
      granted.modelId === model.modelId &&
      granted.providerId === model.provider &&
      granted.effort === effort)
  ) {
    return null;
  }
  const kind: ModelGrantKind = {
    kind: "model_grant",
    connectionId: model.modelConnectionId,
    modelId: model.modelId,
    providerId: model.provider,
    workspace: view.repository === null ? "none" : "repository",
    effort,
  };
  return {
    kind,
    row: {
      intentId: mintedGrantId,
      generation: view.generation,
      kind,
      state: view.bridgeAttached ? "sent" : "pending",
      attempts: view.bridgeAttached ? 1 : 0,
      createdAt: now,
    },
  };
}

/** The newest model grant the bridge did not refuse, or null when the generation has none. */
function latestModelGrant(rows: readonly DispatchRow[]): ModelGrantKind | null {
  for (const row of [...rows].reverse()) {
    if (row.kind.kind === "model_grant" && row.state !== "rejected") {
      return row.kind;
    }
  }
  return null;
}

/**
 * The push grant goes out before the command on the same socket, so the bridge
 * holds the token when it accepts. Without a push the bridge writes a patch
 * bundle instead. A checkpoint needs only git, so both go out once a bridge is
 * attached, runtime or not.
 */
function planCheckpointRequested(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "checkpoint_requested" }>,
): DispatchPlan {
  const rows: DispatchRowChange[] = [];
  const frames: OutboundFrame[] = [];
  const attached = view.bridgeAttached;
  const repository = view.repository;
  const insert = (intentId: string, kind: DispatchKind): void => {
    rows.push({
      kind: "insert_dispatch",
      row: {
        intentId,
        generation: view.generation,
        kind,
        state: attached ? "sent" : "pending",
        attempts: attached ? 1 : 0,
        createdAt: input.now,
      },
    });
  };
  // Push only to the named task branch, never the cloned branch: before the
  // first push the clone is the base branch, and a grant for it would let the
  // bridge push there. No task branch means no grant.
  const pushTarget = repository === null ? null : grantTaskBranch(repository);
  if (input.push !== null && repository !== null && pushTarget !== null) {
    const need: Extract<DispatchKind, { kind: "push_grant" }> = {
      kind: "push_grant",
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      cloneUrl: repository.cloneUrl,
      ref: `refs/heads/${pushTarget}`,
      parentSha: input.push.parentSha,
    };
    insert(input.push.grantId, need);
    if (attached) {
      frames.push({ kind: "push_grant", intentId: input.push.grantId, need });
    }
  }
  const command = input.command;
  insert(command.commandId, {
    kind: "command",
    commandJson: JSON.stringify(command),
    runId: null,
    context: null,
  });
  if (attached) {
    frames.push({
      kind: "command",
      intentId: command.commandId,
      command,
      runId: null,
      context: null,
    });
  }
  return { ...EMPTY_PLAN, rows, frames };
}

function planUploadRequested(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "upload_requested" }>,
): DispatchPlan {
  const need: Extract<DispatchKind, { kind: "upload_grant" }> = {
    kind: "upload_grant",
    artifactId: input.artifactId,
    maxBytes: input.maxBytes,
  };
  const attached = view.bridgeAttached;
  return {
    ...EMPTY_PLAN,
    rows: [
      {
        kind: "insert_dispatch",
        row: {
          intentId: input.grantId,
          generation: view.generation,
          kind: need,
          state: attached ? "sent" : "pending",
          attempts: attached ? 1 : 0,
          createdAt: input.now,
        },
      },
    ],
    frames: attached ? [{ kind: "upload_grant", intentId: input.grantId, need }] : [],
  };
}

/** A secret needs the supervisor, not OpenCode, so its grant goes as soon as a bridge is attached. */
function planSecretsRequested(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "secrets_requested" }>,
): DispatchPlan {
  const need: Extract<DispatchKind, { kind: "secret_grant" }> = {
    kind: "secret_grant",
    names: input.names,
    requestRef: input.requestRef,
    approvalId: input.approvalId,
  };
  const attached = view.bridgeAttached;
  return {
    ...EMPTY_PLAN,
    rows: [
      {
        kind: "insert_dispatch",
        row: {
          intentId: input.grantId,
          generation: view.generation,
          kind: need,
          state: attached ? "sent" : "pending",
          attempts: attached ? 1 : 0,
          createdAt: input.now,
        },
      },
    ],
    frames: attached ? [{ kind: "secret_grant", intentId: input.grantId, need }] : [],
  };
}

/**
 * The run the bridge's events for an admitted command will name. A `run.start`
 * carries no run id (the object mints it), so the minted id travels on the frame.
 */
export function chargedRunId(command: ProtocolCommand, mintedRunId: string): string | null {
  return command.type === "run.start" ? mintedRunId : command.runId;
}

function planRuntimeReady(view: DispatchStateView): DispatchPlan {
  const pending = view.rows.filter((row) => row.state === "pending" && row.kind.kind === "command");
  return {
    ...EMPTY_PLAN,
    rows: pending.map((row) => ({
      kind: "mark_dispatch",
      intentId: row.intentId,
      state: "sent",
      bumpAttempts: true,
    })),
    frames: pending.map(outboundFor),
  };
}

function planAck(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "ack" }>,
): DispatchPlan {
  const ref = input.frame.ref;
  const intentId = "commandId" in ref ? ref.commandId : ref.grantId;
  const row = view.rows.find((candidate) => candidate.intentId === intentId);
  // A redelivered frame may be acked twice; an unknown ack is noise.
  if (row === undefined || !isOpen(row)) {
    return EMPTY_PLAN;
  }
  const outcome = input.frame.outcome;
  const rows: DispatchRowChange[] = [
    { kind: "mark_dispatch", intentId, state: outcome.kind, bumpAttempts: false },
  ];
  if (row.kind.kind === "command") {
    const command = commandOf(row as DispatchRow & { readonly kind: { readonly kind: "command" } });
    const event =
      outcome.kind === "accepted"
        ? buildEvent("command.acknowledged", {
            eventId: input.eventId,
            sessionId: view.sessionId,
            runId: null,
            sandboxGeneration: view.generation,
            runtimeSequence: null,
            occurredAt: input.now,
            payload: {
              commandId: command.commandId,
              commandType: command.type,
              acceptedBy: "bridge",
            },
          })
        : rejectedEvent(
            view,
            command,
            REJECTION_REASON[outcome.reason],
            `the bridge rejected the command: ${outcome.reason}`,
            input.eventId,
            input.now,
          );
    return {
      ...EMPTY_PLAN,
      rows,
      events: [event],
      checkpointRefused: outcome.kind === "rejected" && command.type === "checkpoint.create",
    };
  }
  if (row.kind.kind === "secret_grant") {
    return {
      ...EMPTY_PLAN,
      rows,
      secretsSettled: {
        names: row.kind.names,
        approvalId: row.kind.approvalId,
        accepted: outcome.kind === "accepted",
      },
    };
  }
  // Grants have no timeline row. A refused model grant fails the run, since
  // the bridge cannot run without one.
  if (
    outcome.kind === "rejected" &&
    row.kind.kind === "model_grant" &&
    view.currentRunId !== null &&
    view.currentRunOpen
  ) {
    rows.push({ kind: "fail_run", runId: view.currentRunId });
    return {
      ...EMPTY_PLAN,
      rows,
      events: [
        buildEvent("run.failed", {
          eventId: input.eventId,
          sessionId: view.sessionId,
          runId: view.currentRunId,
          sandboxGeneration: view.generation,
          runtimeSequence: null,
          occurredAt: input.now,
          payload: {
            stage: "provisioning",
            error: {
              category: "model_grant_rejected",
              message: `the bridge rejected the model grant: ${outcome.reason}`,
            },
            summary: null,
            evidence: [],
            branch: null,
            pullRequestNumber: null,
            usage: null,
            durationMs: 0,
          },
        }),
      ],
    };
  }
  return { ...EMPTY_PLAN, rows };
}

/**
 * Releases the oldest held message as a `run.start` continuing the ended run,
 * so a held message takes the same run-start path as a client's.
 */
function planRunTerminal(
  view: DispatchStateView,
  input: Extract<DispatchInput, { kind: "run_terminal" }>,
): DispatchPlan {
  const held = view.held[0];
  if (held === undefined || view.model === null) {
    return EMPTY_PLAN;
  }
  // The next run runs at the effort the follow-up named, or the record's.
  const effort = held.effort === undefined ? (view.model.effort ?? null) : held.effort;
  const model = { ...view.model, effort };
  const command: DeliverableCommand = {
    commandId: input.mintedCommandId,
    sessionId: view.sessionId,
    runId: null,
    issuedAt: input.now,
    issuedByUserId: held.issuedByUserId,
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: {
        messageId: held.messageId,
        text: held.text,
        attachments: held.attachments,
      },
      model,
      continuesRunId: input.runId,
      ...(held.skipRequiredChecks ? { skipRequiredChecks: true } : {}),
    },
  } as DeliverableCommand;
  const rows: DispatchRowChange[] = [
    { kind: "release_message", messageId: held.messageId, runId: input.mintedRunId },
  ];
  const frames: OutboundFrame[] = [];
  // The broker token fixes the effort, so a run at another effort needs a
  // fresh model grant. A first grant is planned at the bridge's hello instead.
  const granted = latestModelGrantEffort(view.rows);
  if (granted !== undefined && granted !== effort) {
    const need: Extract<DispatchKind, { kind: "model_grant" }> = {
      kind: "model_grant",
      connectionId: model.modelConnectionId,
      modelId: model.modelId,
      providerId: model.provider,
      workspace: view.repository === null ? "none" : "repository",
      effort,
    };
    const row: DispatchRow = {
      intentId: input.mintedGrantId,
      generation: view.generation,
      kind: need,
      state: view.bridgeAttached ? "sent" : "pending",
      attempts: view.bridgeAttached ? 1 : 0,
      createdAt: input.now,
    };
    rows.push({ kind: "insert_dispatch", row });
    if (view.bridgeAttached) {
      frames.push({ kind: "model_grant", intentId: row.intentId, need });
    }
  }
  return {
    ...EMPTY_PLAN,
    rows,
    frames,
    continuation: { command, runId: input.mintedRunId },
  };
}

/** The newest model grant's effort, or `undefined` when there is no grant. */
function latestModelGrantEffort(rows: readonly DispatchRow[]): EffortLevel | null | undefined {
  for (const row of [...rows].reverse()) {
    if (row.kind.kind === "model_grant") {
      return row.kind.effort;
    }
  }
  return undefined;
}

/**
 * ```
 * bridge_connected   -> plan the two grants once per generation, re-send every open row
 *                       (grants first, commands only once runtimeReady), give up past MAX_DISPATCH_ATTEMPTS
 * command_admitted   -> run_next held; steer, cancel, start rows sent iff runtimeReady && bridgeAttached;
 *                       shutdown sent iff bridgeAttached; anything else nothing. A client's run.start on another
 *                       model, connection, or effort than the generation's newest grant gets a model grant first
 * runtime_ready      -> flush every pending command row
 * ack                -> unknown or settled intent nothing; accepted command -> command.acknowledged { bridge };
 *                       rejected command -> command.rejected; rejected model grant -> run.failed { provisioning }
 * run_terminal       -> release the oldest held message as a continuation run.start at the effort it named,
 *                       plus a model grant at that effort when it differs from the generation's, or nothing
 * repository_status  -> mark_git_grant_revoked, revokeGitToken. Idempotent.
 * checkpoint_requested -> push grant row (repository and push) then the checkpoint.create row, both sent iff bridgeAttached
 * upload_requested   -> upload grant row, sent iff bridgeAttached
 * secrets_requested  -> secret grant row holding names only, sent iff bridgeAttached
 * ack secret grant   -> secretsSettled { names, approvalId, accepted }
 * ack rejected checkpoint.create -> command.rejected and checkpointRefused
 * generation_ended   -> delete_open_for_generation. Held messages SURVIVE.
 * ```
 */
export function planDispatch(view: DispatchStateView, input: DispatchInput): DispatchPlan {
  switch (input.kind) {
    case "bridge_connected":
      return planBridgeConnected(view, input);
    case "command_admitted":
      return planCommandAdmitted(view, input);
    case "runtime_ready":
      return planRuntimeReady(view);
    case "ack":
      return planAck(view, input);
    case "run_terminal":
      return planRunTerminal(view, input);
    case "repository_status":
      return { ...EMPTY_PLAN, rows: [{ kind: "mark_git_grant_revoked" }], revokeGitToken: true };
    case "checkpoint_requested":
      return planCheckpointRequested(view, input);
    case "upload_requested":
      return planUploadRequested(view, input);
    case "secrets_requested":
      return planSecretsRequested(view, input);
    case "generation_ended":
      return {
        ...EMPTY_PLAN,
        rows: [{ kind: "delete_open_for_generation", generation: view.generation }],
      };
  }
}

/** Record 01's six terminal run events. */
export function isRunTerminalEvent(type: ProtocolEvent["type"]): boolean {
  return (
    type === "run.verified" ||
    type === "run.completed_with_warnings" ||
    type === "run.completed" ||
    type === "run.blocked" ||
    type === "run.failed" ||
    type === "run.cancelled"
  );
}

/** Every `run.*` event type in the catalog, so the table below is total over them. */
export type RunEventType = Extract<EventType, `run.${string}`>;

/** What a committed event does to the cached `run` row. `ready` is guarded by the row's own state in SQL. */
export type RunRowChange =
  | { readonly kind: "ready" }
  | { readonly kind: "started" }
  | { readonly kind: "paused" }
  | { readonly kind: "ended"; readonly outcome: RunOutcome };

/**
 * How each run event moves the `run` row, matching `packages/protocol/src/view.ts`.
 * Total, so a new run event fails to compile until placed here. `null` types
 * are control-origin: their emitting paths write the row themselves.
 */
export const RUN_EVENT_ROW: Readonly<Record<RunEventType, RunRowChange | null>> = {
  // Inserted with its `run.queued` by `planAndCommit`.
  "run.queued": null,
  "run.started": { kind: "started" },
  "run.paused": { kind: "paused" },
  // Control origin, owned by the sandbox-loss path.
  "run.interrupted": null,
  "run.verified": { kind: "ended", outcome: "verified" },
  "run.completed_with_warnings": { kind: "ended", outcome: "completed_with_warnings" },
  // Record 14, "Done": the run changed no files and ran no checks.
  "run.completed": { kind: "ended", outcome: "completed" },
  "run.blocked": { kind: "ended", outcome: "blocked" },
  "run.failed": { kind: "ended", outcome: "failed" },
  // Control origin: `run.cancel` and `stopSandbox` write the row with the event.
  "run.cancelled": null,
};

function isRunEventType(type: EventType): type is RunEventType {
  return type.startsWith("run.");
}

/**
 * The row update a sandbox-origin event owes the current run, or null. A run
 * event must name the current run, so a late terminal for an older run is ignored.
 */
export function planRunRow(
  event: { readonly type: EventType; readonly runId: string | null },
  currentRunId: string | null,
): (RunRowChange & { readonly runId: string }) | null {
  if (currentRunId === null) {
    return null;
  }
  if (event.type === "runtime.ready") {
    return { kind: "ready", runId: currentRunId };
  }
  if (!isRunEventType(event.type)) {
    return null;
  }
  const change = RUN_EVENT_ROW[event.type];
  if (change === null || event.runId !== currentRunId) {
    return null;
  }
  return { ...change, runId: currentRunId };
}

/** What a final `runtime.disconnected` does to the current run; an ended or paused run is left alone. */
export type RuntimeLossPlan = "fail_provisioning" | "fail_execution" | "nothing";

export function planRuntimeLoss(runState: RunState | null): RuntimeLossPlan {
  // A paused run has no turn in flight to lose: the idle stop's shutdown ends
  // the runtime under it, and Continue or an answer resumes it on a new one.
  if (runState === null || runState === "paused" || isTerminal("run", runState)) {
    return "nothing";
  }
  if (runState === "queued" || runState === "provisioning") {
    return "fail_provisioning";
  }
  return "fail_execution";
}
