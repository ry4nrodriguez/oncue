/**
 * The bridge's reducer, where every decision is made. `step(state, input, ctx)`
 * is total, synchronous, and pure: clocks and ids come from `StepContext`, and
 * the shell (`agent-io.ts`) performs effects after the state is committed,
 * which serialises commands, runtime events, relay failures, and process exits.
 *
 * Invariants held by the types:
 *
 * - At most one active run, one checkpoint, and one mid-run diff rebuild.
 * - A run winding down cannot also complete (`phase` is a discriminant).
 * - A git grant is consumed once, and each commandId and grantId gets one ack,
 *   replayed verbatim on redelivery.
 * - No token is ever in the state: model and push tokens go straight to their
 *   holders by effect, and an upload token lives only in its `upload` effect.
 * - Byte payloads (patches, check logs) live in the interpreter, never here.
 * - Effects carry `Draft`s; the interpreter stamps sequences, ids, and times.
 */

import type { EffortLevel, PayloadOf } from "@oncue/protocol";
import { commitMessageOrFallback } from "./commit-message";
import {
  DIFF_ARTIFACT_LABELS,
  DIFF_CONTENT_TYPE,
  type DiffBody,
  type DiffBuild,
  type DiffRefs,
  type DiffReport,
  type DiffScope,
  diffKey,
  diffUpdatedDraft,
  repositoryStatusDraft,
  type TurnBase,
} from "./diff-report";
import type {
  AckOutcome,
  AckRef,
  AckRejection,
  AttachmentFetch,
  CommandFrame,
  DeliverableCommand,
  GrantFrame,
  ModelGrantCatalogEntry,
  ModelGrantSpec,
  SessionFrame,
  SessionPolicy,
} from "./frames";
import type { PushFailureReason } from "./git";
import {
  advance,
  draft,
  emptyNormalizerState,
  type NormalizerState,
  type PromptCountsReading,
  type RuntimeEvent,
  summaryText,
  type ToolOverflow,
  type Unbranded,
} from "./normalize";
import {
  DEADLINE_GRACE_MS,
  dropUnsent as dropUnsentAsks,
  INITIAL_PERMISSIONS,
  onAsk,
  onCallSettled,
  onApprovalDeadline as onPermissionDeadline,
  onApprovalFrame as onPermissionFrame,
  onRequestSettled as onPermissionSettled,
  onRunEnded as onPermissionsRunEnded,
  ownsRef,
  type PermissionsState,
  type PermissionsStep,
  pump as pumpPermissions,
} from "./permissions";
import type { Draft } from "./protocol";
import {
  INITIAL_QUESTIONS,
  onQuestionAsked,
  onQuestionFrame,
  onQuestionRunEnded,
  onQuestionSettled,
  type QuestionReply,
  type QuestionsState,
  type QuestionsStep,
} from "./questions";
import { describeDefinition, type InstallStep, type ResolvedDefinition } from "./repo-config";
import { promptableModels, type RuntimeId, type RuntimeModel, type RuntimePlan } from "./runtime";
import { DEFAULT_RUNTIME_ID, isRuntimeId, runtimePlan } from "./runtimes";
import {
  hasUnsentRequest,
  INITIAL_SECRETS,
  onApprovalDeadline,
  onApprovalFrame,
  onPermissionAsked,
  onRequestSettled as onRequestSettledSecret,
  onRunEnded,
  onSecretGrant,
  onSecretsWritten,
  onShutdown,
  onToolPart,
  pump as pumpSecrets,
  SECRET_TOOL_NAME,
  type SecretsState,
  type SecretsStep,
} from "./secrets";
import {
  NO_SUBAGENTS,
  onAbortFailed,
  onChildEvent,
  onRootToolPart,
  onSessionCreated,
  onStopAsked,
  onRunEnded as onSubagentRunEnded,
  onTaskAnswered,
  onTaskAsked,
  onWindDown,
  routeOf,
  SUBAGENT_TOOL,
  type SubagentState,
  type SubagentStep,
  type TrackedSubagent,
} from "./subagents";
import { ALLOWED_CWD } from "./supervisor-protocol";
import {
  awaitedArtifact,
  type CheckRunOutcome,
  isDone,
  planChecks,
  startVerification,
  stepVerify,
  type VerifyEffect,
  type VerifyInput,
  type VerifyState,
  type Where,
} from "./verify";

export type RuntimePhase =
  /** Not asked for yet: the workspace or the model grant is still pending. */
  | { readonly kind: "not_started" }
  /** `start_runtime` is in flight. */
  | { readonly kind: "starting" }
  /** Process is up; `/global/health` has not answered. `runtime.ready` is NOT sent. */
  | {
      readonly kind: "probing";
      readonly attempts: number;
      readonly startedAtMs: number;
      readonly port: number;
    }
  /**
   * Health answered; the event subscription is being opened. `runtime.ready`
   * waits for the stream's first event, because a server-sent stream has no
   * replay and a run prompted earlier would lose the events in between.
   */
  | {
      readonly kind: "listening";
      readonly version: string;
      readonly port: number;
      readonly startedAtMs: number;
    }
  | { readonly kind: "ready"; readonly version: string; readonly port: number }
  /** Not restarted. Later commands ack `no_runtime`; the sandbox stays for the user to stop. */
  | { readonly kind: "exited"; readonly code: number | null };

export type WorkspacePhase =
  /** No grant yet and no `workspace: "none"` yet. */
  | { readonly kind: "pending" }
  | {
      readonly kind: "cloning";
      readonly grantId: string;
      readonly branch: string;
      /** The task branch, or null until the first push names it. */
      readonly taskBranch: string | null;
      readonly baseSha: string;
    }
  | {
      readonly kind: "ready";
      readonly branch: string;
      readonly taskBranch: string | null;
      readonly baseSha: string;
      readonly headSha: string;
    }
  /** No repository on this session. `run.started` uses `EMPTY_TREE_SHA` and `NO_REPOSITORY_BRANCH`. */
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly detail: string };

export type ModelPhase =
  | { readonly kind: "none" }
  | {
      readonly kind: "held";
      readonly grantId: string;
      /** The session's harness, from the first model grant. A session never changes it. */
      readonly runtime: RuntimeId;
      readonly model: RuntimeModel;
      /** The grant's facts about the model, for the runtime's config. */
      readonly modelSpec: ModelGrantSpec | null;
      /** The other models the session may change to, from the grant; absent when it listed none. */
      readonly catalog?: readonly ModelGrantCatalogEntry[] | undefined;
    };

export type RunPhase =
  /** Ack sent; `prompt` effect in flight; `run.started` not yet emitted. */
  | "prompting"
  | "running"
  /** OpenCode went idle; the bridge's Git is snapshotting the tree and measuring the run's diffs before verification. */
  | "diffing"
  /** `verification` is running the repository's checks. The terminal event is verification's. */
  | "verifying"
  /** OpenCode was told to abort, or a check was signalled. No terminal event of ours follows. */
  | "winding_down";

export interface ActiveRun {
  readonly runId: string;
  readonly commandId: string;
  /** The harness's own conversation id. Null while `prompting` a fresh one; set once the harness accepts the prompt. */
  readonly conversation: string | null;
  readonly phase: RunPhase;
  /** Why we are winding down. The object already committed `run.cancelled`; `run.paused` was emitted by us. */
  readonly windDown: "cancelled_by_object" | "paused_model_failure" | null;
  readonly startedAtMs: number;
  readonly instructionText: string;
  readonly contextWindow: number | null;
  /** The run's effort from its record; every prompt of the run names it as the variant. */
  readonly effort: EffortLevel | null;
  /** `instruction.messageId`s prompted into this run. A NEW commandId carrying one is `duplicate`. */
  readonly promptedMessageIds: readonly string[];
  readonly normalizer: NormalizerState;
  readonly lastAssistantText: string | null;
  readonly toolsRun: number;
  /** The structured skip from `run.start` or a steering `run.follow_up`. Once asked for, it holds for the run. */
  readonly skipRequiredChecks: boolean;
  /**
   * The run only runs the repository's checks (record 14): the runtime is never
   * prompted, and the run verifies even when nothing changed.
   */
  readonly checksOnly: boolean;
  /** The snapshot taken as the run started, which the turn's diff is measured from. Null with no repository, or when it could not be taken. */
  readonly turnBaseSha: string | null;
  /** Set when the run enters `verifying`, and kept while a cancelled verification winds down. */
  readonly verification: VerifyState | null;
  /** The subagents the run's agent started (`subagents.ts`). */
  readonly subagents: SubagentState;
}

export type RunSlot = { readonly kind: "idle" } | ({ readonly kind: "active" } & ActiveRun);

/**
 * Bounded idempotency ring of recent acks by commandId and grantId, oldest
 * forgotten past `limit`. A redelivery replays the earlier outcome (record 01).
 */
export interface DecidedRing {
  readonly entries: readonly { readonly id: string; readonly outcome: AckOutcome }[];
  readonly limit: number;
}

export type CheckpointReason = Extract<
  DeliverableCommand,
  { readonly type: "checkpoint.create" }
>["payload"]["reason"];

export type CheckpointPhase =
  | { readonly kind: "idle" }
  /** The `checkpoint` effect is in flight. `runId` is the run the checkpoint's run-scoped events charge to; null when no run ever started. */
  | {
      readonly kind: "running";
      readonly commandId: string;
      readonly checkpointId: string;
      readonly reason: CheckpointReason;
      readonly runId: string | null;
      readonly startedAtMs: number;
      /** Set when this checkpoint is a publish: the user's push, reported as `git.*` events too. */
      readonly publish: PublishInFlight | null;
      /**
       * The push grant's branch, kept because the grant is spent when the
       * checkpoint starts; adopted as the task branch once the push lands.
       */
      readonly pushedBranch: string | null;
    }
  /** The patch bundle is declared; the object's upload grant and the PUT decide `patch_bundle` or `local_commit`. */
  | {
      readonly kind: "uploading";
      readonly checkpointId: string;
      readonly reason: CheckpointReason;
      readonly runId: string;
      readonly startedAtMs: number;
      readonly headSha: string;
      readonly artifactId: string;
      readonly byteSize: number;
    };

/** Coordinates only. The token went to the interpreter's holder through `hold_push_token`. */
export interface HeldPushGrant {
  readonly grantId: string;
  readonly ref: string;
  readonly repository: { readonly fullName: string; readonly cloneUrl: string };
}

/** An `artifact.uploading` this generation declared and has not yet heard settle. */
export interface PendingUpload {
  readonly artifactId: string;
  readonly purpose: "checkpoint" | "tool_output" | "verification_log" | "diff" | "tree";
}

/**
 * Mid-run rebuilds of the session diff. A `diff_changed` signal starts one
 * when none is in flight and the last began at least
 * `DIFF_REBUILD_INTERVAL_MS` ago; otherwise it is remembered, and a timer or
 * the settling build starts the next.
 */
export interface DiffRebuild {
  readonly lastStartedAtMs: number | null;
  readonly inFlight: boolean;
  readonly wanted: boolean;
  readonly timerArmed: boolean;
}

export interface AgentState {
  readonly sessionId: string;
  readonly generation: number;
  readonly runtime: RuntimePhase;
  readonly workspace: WorkspacePhase;
  readonly model: ModelPhase;
  /**
   * The models the harness process was configured for when it was started, or
   * null before a start. A later model grant outside it is refused, since the
   * process reads its configuration once (record 15).
   */
  readonly spawnedModels: readonly RuntimeModel[] | null;
  readonly run: RunSlot;
  /** The last commit known to be on the remote: the clone's verified head, then each pushed checkpoint. */
  readonly durableHead: string | null;
  readonly pushGrant: HeldPushGrant | null;
  readonly checkpoint: CheckpointPhase;
  readonly uploads: readonly PendingUpload[];
  /**
   * A `run.start` accepted while the previous run winds down after a cancel,
   * prompted when the runtime reports idle. One slot: a second is `wrong_state`.
   */
  readonly pendingStart: RunStartFrame | null;
  /** The finished run's harness conversation, reused when the next `run.start` names it in `continuesRunId`. */
  readonly lastRun: {
    readonly runId: string;
    readonly conversation: string;
    readonly promptedMessageIds: readonly string[];
    /** What a publish of this run's work is committed as, and how its checks ended (record 07). */
    readonly commitSubject: string;
    readonly verification: VerificationAtCommit;
  } | null;
  readonly decided: DecidedRing;
  readonly project: ResolvedDefinition | null;
  /** How verification installs dependencies, from the lockfile the clone found. */
  readonly install: InstallStep | null;
  /** Set by `runtime.shutdown`; the shell closes the link once the runtime is down. */
  readonly stopping: boolean;
  readonly diffRebuild: DiffRebuild;
  /**
   * The first unpushed instruction, which names the next publish's commit, so
   * a "push this" run names the commit for the work rather than the asking.
   * Null once a push has carried the work.
   */
  readonly unpublishedSubject: string | null;
  /** The Git policy the object last sent (`bridge.policy`). Null until it does: no proposal is made against a policy the bridge was never told. */
  readonly policy: SessionPolicy | null;
  /** `diffKey` of the last session diff emitted, so a rebuild or a checkpoint that measured nothing new sends nothing. */
  readonly lastSessionDiff: string | null;
  /**
   * The tree listing last uploaded for the review's file tree, by digest,
   * so a diff whose tree has not changed names the same artifact again.
   */
  readonly lastTree: { readonly digest: string; readonly artifact: TreeArtifact } | null;
  /** The held tool call, the secrets written, and the grants being written. Names only, never a value. */
  readonly secrets: SecretsState;
  /** The harness's other permission asks, held until the session object answers (record 09). */
  readonly permissions: PermissionsState;
  /** The question the harness is waiting on the user to answer, if any. */
  readonly questions: QuestionsState;
  /**
   * The tip of the agent's `git_commit` chain this generation (record 07), which
   * the next snapshot is parented on. Null when the durable head is the tip.
   */
  readonly chainTip: string | null;
  /** The `git_commit` call whose snapshot is in flight, so calls are taken one at a time, with the message the event will carry. */
  readonly commitInFlight: { readonly requestId: string; readonly message: string } | null;
  /**
   * A resume's context summary that arrived on a checks-only start. The object
   * sends it once, so it is kept for the next prompted run (record 14).
   */
  readonly resumeContext: string | null;
  /** Commits admitted in the active run, against `MAX_COMMITS_PER_RUN`. */
  readonly commitsThisRun: number;
  /** The latest `pull_request_describe` call, each field the last value given; its title names a publish's final commit. */
  readonly described: DescribeToolCall | null;
}

export function initialAgentState(sessionId: string, generation: number): AgentState {
  return {
    sessionId,
    generation,
    runtime: { kind: "not_started" },
    workspace: { kind: "pending" },
    model: { kind: "none" },
    spawnedModels: null,
    run: { kind: "idle" },
    durableHead: null,
    pushGrant: null,
    checkpoint: { kind: "idle" },
    uploads: [],
    pendingStart: null,
    lastRun: null,
    decided: { entries: [], limit: DECIDED_RING_LIMIT },
    project: null,
    install: null,
    stopping: false,
    diffRebuild: IDLE_REBUILD,
    policy: null,
    unpublishedSubject: null,
    lastSessionDiff: null,
    lastTree: null,
    secrets: INITIAL_SECRETS,
    permissions: INITIAL_PERMISSIONS,
    questions: INITIAL_QUESTIONS,
    chainTip: null,
    commitInFlight: null,
    commitsThisRun: 0,
    resumeContext: null,
    described: null,
  };
}

const IDLE_REBUILD: DiffRebuild = {
  lastStartedAtMs: null,
  inFlight: false,
  wanted: false,
  timerArmed: false,
};

export type StartOutcome =
  | { readonly kind: "started"; readonly pid: number; readonly port: number }
  | { readonly kind: "failed"; readonly detail: string };

export type HealthOutcome =
  | { readonly kind: "healthy"; readonly version: string }
  /** Connection refused or not yet answering. Expected during startup; `detail` says what answered. */
  | { readonly kind: "not_yet"; readonly detail: string };

export type CloneOutcome =
  | {
      readonly kind: "cloned";
      readonly headSha: string;
      readonly project: ResolvedDefinition;
      readonly install: InstallStep | null;
    }
  | {
      readonly kind: "failed";
      /**
       * `restore`: the clone landed but the grant's patch bundle could not be
       * fetched or applied. `branch_missing`: the branch is gone from GitHub.
       * `commit_missing`: the commit the session must resume at is gone from
       * GitHub. The last two carry a sentence for the person as `detail`.
       */
      readonly category:
        | "auth"
        | "not_found"
        | "network"
        | "branch_missing"
        | "commit_missing"
        | "timed_out"
        | "restore"
        | "unknown";
      readonly detail: string;
    };

/** What the interpreter reports from `runCheckpoint`, minus the patch bytes it keeps for the upload. */
export type CheckpointOutcome =
  | {
      readonly kind: "failed";
      /** `git.ts`'s fixed category, never git's own text. */
      readonly detail: PayloadOf<"sandbox.checkpoint_failed">["failure"];
    }
  | { readonly kind: "unchanged"; readonly headSha: string }
  | { readonly kind: "pushed"; readonly headSha: string }
  | {
      readonly kind: "bundled";
      readonly headSha: string;
      readonly byteSize: number;
      readonly push: PushNotDone;
    }
  | {
      readonly kind: "committed_only";
      readonly headSha: string;
      readonly push: PushNotDone;
      /** The files whose changes hold a supplied secret, when that is why nothing was published. */
      readonly secretPaths?: readonly string[] | undefined;
    };

/** Why a checkpoint that had a commit did not push it. */
export type PushNotDone =
  | "no_grant"
  | "grant_spent"
  | "ref_mismatch"
  | "secret_in_changes"
  | "secret_scan_failed"
  | PushFailureReason;

/** The two reasons nothing at all was published, push or bundle. */
function withheldForSecret(push: PushNotDone): boolean {
  return push === "secret_in_changes" || push === "secret_scan_failed";
}

export type PromptOutcome =
  | { readonly kind: "held"; readonly conversation: string }
  | { readonly kind: "refused"; readonly detail: string };

/** What the relay saw when the broker refused, in record 06's categories. */
export interface RelayFailure {
  readonly category:
    | "temporary_service_failure"
    | "rate_limited"
    | "usage_limit_reached"
    | "authentication_failed"
    | "model_unavailable"
    | "request_rejected"
    | "broker_failure";
  readonly message: string;
}

export type AgentInput =
  /** The handshake was accepted. Fired on the first connect and on every reconnect. */
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "frame"; readonly frame: SessionFrame }
  | { readonly kind: "clone_settled"; readonly grantId: string; readonly result: CloneOutcome }
  | { readonly kind: "chown_settled"; readonly ok: boolean; readonly detail: string }
  | { readonly kind: "runtime_started"; readonly result: StartOutcome }
  | { readonly kind: "health"; readonly result: HealthOutcome }
  /** `turnBase` is the snapshot taken before the prompt was sent, when the effect asked for one and Git could take it. */
  | {
      readonly kind: "prompt_settled";
      readonly runId: string;
      readonly result: PromptOutcome;
      readonly turnBase: TurnBase | null;
    }
  | {
      readonly kind: "abort_settled";
      readonly runId: string;
      /** The conversation the abort was for: the run's own, or a subagent's. */
      readonly conversation: string;
      readonly ok: boolean;
    }
  | { readonly kind: "runtime_event"; readonly event: RuntimeEvent }
  | { readonly kind: "model_failure"; readonly failure: RelayFailure }
  /** What the broker said about a successful call's prompt, as the relay read it. */
  | { readonly kind: "prompt_counts"; readonly reading: PromptCountsReading }
  /** The supervisor answered for every secret of a grant; `failedNames` are the ones it could not write. */
  | {
      readonly kind: "secrets_written";
      readonly grantId: string;
      readonly failedNames: readonly string[];
    }
  /** The approval card's expiry, as the object said it, has passed. */
  | { readonly kind: "approval_deadline"; readonly ref: string }
  /** The agent called the `policy_propose` tool on the bridge's loopback endpoint (records 07 and 09). */
  | { readonly kind: "policy_tool_called"; readonly call: PolicyToolCall }
  /** The agent called the `pull_request_describe` tool (record 07). */
  | { readonly kind: "describe_tool_called"; readonly call: DescribeToolCall }
  /** The agent called the `git_commit` tool (record 07); `requestId` is what the interpreter answers the model on. */
  | {
      readonly kind: "commit_tool_called";
      readonly requestId: string;
      readonly call: CommitToolCall;
    }
  /** The `commit_work` effect ran. */
  | { readonly kind: "commit_settled"; readonly requestId: string; readonly result: CommitOutcome }
  | {
      readonly kind: "runtime_exited";
      readonly code: number | null;
      readonly signal: string | null;
    }
  /** `diff` is the session's diff at the checkpoint's head, when the effect asked for one and Git could measure it. */
  | {
      readonly kind: "checkpoint_settled";
      readonly checkpointId: string;
      readonly result: CheckpointOutcome;
      readonly diff: DiffReport | null;
      /** The one commit a publish made, measured against its parent; null for the object's own checkpoints and when it could not be measured. */
      readonly commit: DiffReport | null;
    }
  | {
      readonly kind: "diffs_built";
      readonly runId: string;
      readonly purpose: DiffPurpose;
      readonly result: DiffBuild;
    }
  /** The rebuild timer fired. */
  | { readonly kind: "diff_rebuild_due" }
  | { readonly kind: "upload_settled"; readonly artifactId: string; readonly ok: boolean }
  | {
      readonly kind: "check_settled";
      readonly runId: string;
      readonly checkRunId: string;
      readonly outcome: CheckRunOutcome;
    }
  | {
      readonly kind: "base_prepared";
      readonly runId: string;
      readonly dir: string;
      readonly ok: boolean;
    };

export interface SpawnRequest {
  /** Which row of the supervisor's `RUNTIME_SPAWN_RULES` reviews it. Absent is OpenCode's. */
  readonly runtime?: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Explicit and complete. `supervisor-protocol.ts` refuses any other key. */
  readonly env: Readonly<Record<string, string>>;
  readonly uid: number;
}

export type AgentEffect =
  /** Send a protocol event. The shell stamps it (`stampDraft`) and sends it on the current link, or holds a durable one in the outbox ring while the link is down. */
  | { readonly kind: "emit"; readonly draft: Draft }
  | { readonly kind: "ack"; readonly ref: AckRef; readonly outcome: AckOutcome }
  /** Hand the token to `relay.ts`'s closure holder. It goes nowhere else. */
  | {
      readonly kind: "set_model_token";
      readonly token: string;
      readonly brokerOrigin: string;
      readonly expiresAt: string;
    }
  /** The interpreter wraps the grant in a `SingleUse` and clones as uid 1000. */
  | { readonly kind: "clone"; readonly grant: GrantFrame & { readonly kind: "git" } }
  | { readonly kind: "chown_workspace"; readonly uid: number }
  | { readonly kind: "start_runtime"; readonly port: number; readonly request: SpawnRequest }
  | { readonly kind: "probe_health"; readonly port: number; readonly afterMs: number }
  | { readonly kind: "subscribe_events"; readonly port: number }
  /**
   * `conversation === null` means the harness starts one first. `turnBase` asks
   * for the turn's snapshot before the prompt is sent, so nothing the agent does
   * can land ahead of it.
   */
  | {
      readonly kind: "prompt";
      readonly runId: string;
      readonly conversation: string | null;
      readonly text: string;
      readonly model: RuntimeModel;
      readonly effort: EffortLevel | null;
      readonly turnBase: DiffRefs | null;
      /** Fetched and handed to the agent before the prompt is sent. */
      readonly attachments: readonly AttachmentFetch[];
      readonly messageId: string;
      /** Whether the model reads images (`ModelGrantSpec.imageInput`). */
      readonly imageInput: boolean;
    }
  /** Snapshot the tree and measure it: at run end the status and both diffs, mid-run the session's diff alone. */
  | {
      readonly kind: "build_diffs";
      readonly runId: string;
      readonly purpose: DiffPurpose;
      readonly refs: DiffRefs;
      readonly turnBaseSha: string | null;
    }
  | { readonly kind: "diff_rebuild_timer"; readonly afterMs: number }
  | { readonly kind: "abort"; readonly runId: string; readonly conversation: string }
  | { readonly kind: "signal_runtime"; readonly signal: "SIGTERM" | "SIGKILL" }
  /**
   * Hand each value to the supervisor, which writes it where only the agent
   * reads, and to the redactor. The only place a value appears.
   */
  | {
      readonly kind: "write_secrets";
      readonly grantId: string;
      readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
  /** Answer the harness's held tool call through its permission gate. An accepted reply is not read as "the call ran". */
  | {
      readonly kind: "reply_permission";
      readonly requestId: string;
      readonly reply: "once" | "reject";
      readonly message: string | null;
    }
  | { readonly kind: "approval_timer"; readonly ref: string; readonly atMs: number }
  /** Answer or dismiss the question the harness is waiting on. */
  | { readonly kind: "reply_question"; readonly requestId: string; readonly reply: QuestionReply }
  | { readonly kind: "clear_secrets" }
  /** Hand the push token to the interpreter's single-use holder. It goes nowhere else until the `checkpoint` effect names its grant. */
  | {
      readonly kind: "hold_push_token";
      readonly grantId: string;
      readonly token: string;
      readonly cloneUrl: string;
      readonly ref: string;
    }
  /** Snapshot the work tree as one commit on `parentSha` with the agent's message. Nothing is pushed. */
  | {
      readonly kind: "commit_work";
      readonly requestId: string;
      readonly runId: string;
      readonly message: string;
      readonly parentSha: string;
    }
  /** Answer a `git_commit` call the reducer refused, in one sentence the model reads. */
  | {
      readonly kind: "commit_answer";
      readonly requestId: string;
      readonly text: string;
      readonly isError: boolean;
    }
  /**
   * Run `runCheckpoint` as the bridge uid. `pushGrantId` names the held grant,
   * or null to bundle; `sessionBaseSha` asks for the session's diff at the head.
   */
  | {
      readonly kind: "checkpoint";
      readonly checkpointId: string;
      readonly reason: CheckpointReason;
      readonly durableHeadSha: string;
      /** The commit message of a publish; null for the object's own checkpoints, which keep `checkpointMessage`. */
      readonly message: string | null;
      readonly parentSha: string;
      /** Null until the first push names the branch; the push grant's ref then does. */
      readonly sessionBranch: string | null;
      /** The branch the sandbox cloned; `pushExact` refuses a grant naming it while the session has no branch. */
      readonly cloneBranch: string;
      readonly pushGrantId: string | null;
      readonly sessionBaseSha: string | null;
    }
  /** Keep bytes for an artifact the reducer just declared, until an upload grant arrives. */
  | {
      readonly kind: "stage_upload";
      readonly artifactId: string;
      readonly source:
        | { readonly kind: "checkpoint"; readonly checkpointId: string }
        | { readonly kind: "text"; readonly text: string }
        | { readonly kind: "check_log"; readonly checkRunId: string }
        | { readonly kind: "diff"; readonly digest: string };
    }
  /** If no grant has taken the staged bytes by then, drop them and settle the upload as failed. */
  | { readonly kind: "upload_deadline"; readonly artifactId: string; readonly afterMs: number }
  /** Through the supervisor, as the agent user; the interpreter reads the log back and settles `check_settled`. */
  | {
      readonly kind: "run_check";
      readonly runId: string;
      readonly checkRunId: string;
      readonly command: string;
      readonly where: Where;
      readonly timeoutMs: number;
    }
  /** SIGTERM now, SIGKILL after `escalateAfterMs` if the check is still there. */
  | { readonly kind: "signal_check"; readonly checkRunId: string; readonly escalateAfterMs: number }
  /** Check `baseSha` out under the base root as the bridge, then hand it to the agent user. */
  | {
      readonly kind: "prepare_base";
      readonly runId: string;
      readonly dir: string;
      readonly baseSha: string;
    }
  /** PUT the staged bytes with the grant's bearer. The token lives in this effect and in the request, nowhere else. */
  | {
      readonly kind: "upload";
      readonly artifactId: string;
      readonly url: string;
      readonly token: string;
      readonly maxBytes: number;
    }
  /** After the runtime is down on `runtime.shutdown`, and never while a checkpoint is still settling: `runLink` finishes with `shutdown` and the process exits 0. */
  | { readonly kind: "close_link" }
  /** Never a token: the reducer has none to log. */
  | { readonly kind: "log"; readonly line: string };

export interface StepContext {
  readonly nowMs: number;
  readonly nowIso: string;
  /** Plan ids and the like. Never a credential, never an event id (the stamper mints those). */
  readonly newId: () => string;
  /** The relay's bound port, fixed for the process; OpenCode's config names it. */
  readonly relayPort: number;
  /** The tool server's bound port (`tool-server.ts`), fixed for the process; OpenCode's config names it too. */
  readonly toolPort: number;
  /** The port the harness serves on. The sandbox uses the adapter's `defaultPort`; the dev host picks a free one per bridge. */
  readonly runtimePort?: number | undefined;
  /** The runtime binary to spawn. Defaults to the sandbox's allowlisted path; the dev host overrides it. */
  readonly runtimeBinary?: string | undefined;
  /** The runtime's working directory. Defaults to the sandbox's `/workspace`; the dev host overrides it. */
  readonly runtimeCwd?: string | undefined;
  /** The runtime's `HOME` and XDG base. Defaults to the sandbox agent's home; the dev host overrides it. */
  readonly runtimeHome?: string | undefined;
  /** Where the supervisor writes development secrets. Defaults to the image's `SECRETS_DIR`; the dev host overrides it. */
  readonly runtimeSecretsDir?: string | undefined;
  /** Where the dev host keeps attachments; the image uses `ATTACHMENTS_ROOT`. */
  readonly runtimeAttachmentsDir?: string | undefined;
  /** Each other harness's binary on the dev host, by runtime id; the image's own path otherwise. */
  readonly runtimeBinaries?: Readonly<Record<string, string>> | undefined;
  /** The dev host's Node and runtime host, for a harness under the host; the image's otherwise. */
  readonly runtimeHost?: { readonly node: string; readonly host: string } | undefined;
  /** The dev host's build of OnCue's Pi extension; the image's otherwise. */
  readonly runtimeExtension?: string | undefined;
}

export interface StepOutcome {
  readonly state: AgentState;
  readonly effects: readonly AgentEffect[];
}

/** A repo-less session's `run.started` still needs a 40-hex sha. Git's empty tree. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const NO_REPOSITORY_BRANCH = "workspace";
export const DECIDED_RING_LIMIT = 512;
export const HEALTH_POLL_INTERVAL_MS = 250;
// 90 seconds: a cold OpenCode loads its plugin catalogue and reaches for
// models.dev before it answers, and a fresh container has no cache.
export const HEALTH_POLL_ATTEMPTS = 360;
export const AGENT_UID = 1001;
/** `runtime.disconnected` has no boot-failure reason yet; the detail carries the stage. */
export const BOOT_FAILURE_PREFIX = "boot failed";
/** Declared uploads waiting on a grant; past this a tool output is simply not offered. */
export const UPLOADS_LIMIT = 32;
/** Record 03's per-artifact ceiling. Larger tool outputs keep only their inline cut. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const CHECKPOINT_PATCH_CONTENT_TYPE = "text/x-diff";
export const CHECKPOINT_PATCH_LABEL = "Checkpoint patch bundle";
export const TOOL_OUTPUT_CONTENT_TYPE = "text/plain; charset=utf-8";
/** How long a declared check log waits for its upload grant before its result is recorded without it. */
export const LOG_GRANT_WAIT_MS = 120_000;
/** At most one mid-run rebuild of the session diff starts in this long. */
export const DIFF_REBUILD_INTERVAL_MS = 15_000;

export type DiffPurpose = "run_end" | "mid_run";

/** `repository.checkpointed.reason` and `sandbox.checkpointed.reason` for each `checkpoint.create` reason. */
export const CHECKPOINT_REASONS: Readonly<
  Record<
    CheckpointReason,
    {
      readonly repository: PayloadOf<"repository.checkpointed">["reason"];
      readonly sandbox: PayloadOf<"sandbox.checkpointed">["reason"];
    }
  >
> = {
  idle: { repository: "idle_shutdown", sandbox: "idle" },
  lifetime_ceiling: { repository: "pre_replacement", sandbox: "lifetime_ceiling" },
  user_requested: { repository: "user_requested", sandbox: "user" },
  pause: { repository: "pause", sandbox: "pause" },
  cancel: { repository: "user_requested", sandbox: "cancel" },
};

function outcome(state: AgentState, ...effects: AgentEffect[]): StepOutcome {
  return { state, effects };
}

function log(line: string): AgentEffect {
  return { kind: "log", line };
}

function emit(value: Draft): AgentEffect {
  return { kind: "emit", draft: value };
}

/** The earlier outcome for an id, or null when it is new. */
export function replayedAck(ring: DecidedRing, id: string): AckOutcome | null {
  const entry = ring.entries.find((candidate) => candidate.id === id);
  return entry === undefined ? null : entry.outcome;
}

export function decide(ring: DecidedRing, id: string, outcomeOf: AckOutcome): DecidedRing {
  const entries = [...ring.entries, { id, outcome: outcomeOf }];
  return { limit: ring.limit, entries: entries.slice(Math.max(0, entries.length - ring.limit)) };
}

function ackRef(frame: CommandFrame | GrantFrame): AckRef {
  return frame.type === "bridge.command"
    ? { commandId: frame.command.commandId }
    : { grantId: frame.grantId };
}

function idOf(frame: CommandFrame | GrantFrame): string {
  return frame.type === "bridge.command" ? frame.command.commandId : frame.grantId;
}

/** Records the outcome and puts the ack first among the effects. */
function acked(
  state: AgentState,
  frame: CommandFrame | GrantFrame,
  outcomeOf: AckOutcome,
  ...effects: AgentEffect[]
): StepOutcome {
  return outcome(
    { ...state, decided: decide(state.decided, idOf(frame), outcomeOf) },
    { kind: "ack", ref: ackRef(frame), outcome: outcomeOf },
    ...effects,
  );
}

function rejected(reason: AckRejection): AckOutcome {
  return { kind: "rejected", reason };
}

const ACCEPTED: AckOutcome = { kind: "accepted" };

/** The name the session's work goes by: its task branch, or the branch it cloned until one is named. */
function branchOf(workspace: WorkspacePhase): string {
  return workspace.kind === "ready" || workspace.kind === "cloning"
    ? (workspace.taskBranch ?? workspace.branch)
    : NO_REPOSITORY_BRANCH;
}

/** `refs/heads/<name>` to `<name>`; the object's push grant names the branch it minted. */
function branchFromRef(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

function baseShaOf(workspace: WorkspacePhase): string {
  return workspace.kind === "ready" || workspace.kind === "cloning"
    ? workspace.baseSha
    : EMPTY_TREE_SHA;
}

function headShaOf(workspace: WorkspacePhase): string {
  return workspace.kind === "ready" ? workspace.headSha : baseShaOf(workspace);
}

/** Clone failures whose detail is already a sentence for the person, shown without the "boot failed" prefix. */
export const PERSON_FACING_CLONE_FAILURES: ReadonlySet<string> = new Set([
  "commit_missing",
  "branch_missing",
  "timed_out",
]);

function bootFailure(
  stage: string,
  detail: string,
  personFacing = false,
): Draft<"runtime.disconnected"> {
  return draft("runtime.disconnected", null, {
    reason: "boot_failed",
    detail: summaryText(personFacing ? detail : `${BOOT_FAILURE_PREFIX}: ${stage}: ${detail}`),
    exitCode: null,
    diagnostics: [],
    expectReconnect: false,
  });
}

export function runStartedDraft(runId: string, workspace: WorkspacePhase): Draft<"run.started"> {
  return draft("run.started", runId, {
    baseSha: baseShaOf(workspace),
    branch: branchOf(workspace),
    resumedFrom: null,
  });
}

/** When the turn base could not be measured: the clone's head, with nothing counted. Sent anyway, because it is what ends the object's Git grant. */
function unmeasuredStatusDraft(
  runId: string,
  workspace: Extract<WorkspacePhase, { kind: "ready" }>,
): Draft<"repository.status"> {
  return repositoryStatusDraft(runId, {
    branch: workspace.taskBranch ?? workspace.branch,
    headSha: workspace.headSha,
    baseSha: workspace.baseSha,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFileCount: 0,
    untrackedFileCount: 0,
    additions: 0,
    deletions: 0,
  });
}

function diffRefsOf(state: AgentState): DiffRefs | null {
  const workspace = state.workspace;
  return workspace.kind === "ready"
    ? {
        branch: workspace.taskBranch ?? workspace.branch,
        baseSha: workspace.baseSha,
        parentSha: state.durableHead ?? workspace.headSha,
      }
    : null;
}

function outcomeTail(run: ActiveRun, workspace: WorkspacePhase, nowMs: number) {
  return {
    evidence: [],
    branch: workspace.kind === "ready" ? (workspace.taskBranch ?? workspace.branch) : null,
    pullRequestNumber: null,
    usage: null,
    durationMs: Math.max(0, nowMs - run.startedAtMs),
  };
}

function runFailedDraft(
  run: ActiveRun,
  workspace: WorkspacePhase,
  nowMs: number,
  category: string,
  message: string,
): Draft<"run.failed"> {
  return draft("run.failed", run.runId, {
    stage: "execution",
    error: { category: category.slice(0, 256), message: summaryText(message) },
    summary: null,
    ...outcomeTail(run, workspace, nowMs),
  });
}

/** What a checks-only run's summary says: it prompted no one, so there is no agent message to quote. */
export const CHECKS_ONLY_WHAT_CHANGED =
  "Ran the repository's checks on the current code. The agent was not asked anything.";

/** What a run's completion summary says it did and why, from what the agent last said and what was asked. */
export function runFacts(run: ActiveRun): { readonly whatChanged: string; readonly why: string } {
  return {
    whatChanged: run.checksOnly
      ? CHECKS_ONLY_WHAT_CHANGED
      : (run.lastAssistantText ?? "The agent finished without a final message."),
    why: `Requested: ${run.instructionText}`,
  };
}

export const DONE_VERIFICATION_TEXT = "None: this run changed no files, so no checks ran.";

/**
 * The run changed no files, so it ends without checks and claims nothing about
 * verification; the last change's checks still stand (record 14).
 */
function runCompletedDraft(
  run: ActiveRun,
  workspace: WorkspacePhase,
  nowMs: number,
): Draft<"run.completed"> {
  const facts = runFacts(run);
  return draft("run.completed", run.runId, {
    summary: {
      whatChanged: summaryText(facts.whatChanged),
      why: summaryText(facts.why),
      verificationPerformed: DONE_VERIFICATION_TEXT,
      limitations: [],
      nextStep: null,
    },
    ...outcomeTail(run, workspace, nowMs),
  });
}

function runPausedDraft(runId: string, failure: RelayFailure): Draft<"run.paused"> {
  return draft("run.paused", runId, {
    reason: "model_failure",
    detail: summaryText(`Model request failed: ${failure.category}`),
    modelFailure: { category: failure.category, message: summaryText(failure.message), retries: 0 },
    checkpointId: null,
  });
}

const PAUSING_CATEGORIES: ReadonlySet<RelayFailure["category"]> = new Set([
  "authentication_failed",
  "usage_limit_reached",
  "model_unavailable",
]);

export type VerificationAtCommit = PayloadOf<"git.committed">["verificationState"];

/** Git's convention for a subject line. */
export const COMMIT_SUBJECT_CHARS = 72;

/** The commit a publish makes is named after what the user asked for: the first line of the instruction, cut to a subject's length. */
export function commitSubjectFor(instructionText: string): string {
  const firstLine = instructionText.trim().split("\n", 1)[0] as string;
  const subject = firstLine.trim().slice(0, COMMIT_SUBJECT_CHARS).trim();
  return subject === "" ? "Update from OnCue" : subject;
}

const VERIFICATION_BY_OUTCOME: Readonly<Record<string, VerificationAtCommit>> = {
  "run.verified": "passing",
  "run.failed": "failing",
  "run.completed_with_warnings": "partial",
};

/** How the run's checks ended, read off the terminal event verification proposed. A run that recorded no check has none, whatever it ended as. */
function verificationOf(
  effects: readonly AgentEffect[],
  recordedChecks: number,
): VerificationAtCommit {
  if (recordedChecks === 0) {
    return "none";
  }
  for (const effect of effects) {
    const state = effect.kind === "emit" ? VERIFICATION_BY_OUTCOME[effect.draft.type] : undefined;
    if (state !== undefined) {
      return state;
    }
  }
  return "none";
}

/**
 * How a run ended, for what `finishRun` keeps. `done` changed no files, so the
 * pending work and its check result are unchanged (record 14); `checks`
 * prompted nobody, so only the checks' result is new.
 */
export type RunEnding = "work" | "done" | "checks";

/** Everything the run tracked is preserved on `lastRun` for the next start's continuity checks. */
function finishRun(
  state: AgentState,
  run: ActiveRun,
  verification: VerificationAtCommit = "none",
  ending: RunEnding = "work",
): AgentState {
  // A checks-only run ends as one however it ends: verified, cancelled while
  // a check ran, or told no checks were declared.
  if (run.checksOnly || ending === "checks") {
    return {
      ...state,
      run: { kind: "idle" },
      // The next message continues the agent's conversation by naming this
      // run, so the conversation moves onto it. A run that recorded no check
      // leaves the last result standing.
      lastRun:
        state.lastRun === null
          ? null
          : {
              ...state.lastRun,
              runId: run.runId,
              promptedMessageIds: [...state.lastRun.promptedMessageIds, ...run.promptedMessageIds],
              verification: verification === "none" ? state.lastRun.verification : verification,
            },
    };
  }
  if (ending === "done") {
    return {
      ...state,
      run: { kind: "idle" },
      lastRun:
        run.conversation === null
          ? state.lastRun
          : {
              runId: run.runId,
              conversation: run.conversation,
              promptedMessageIds: run.promptedMessageIds,
              commitSubject:
                state.lastRun?.commitSubject ??
                state.described?.title ??
                state.unpublishedSubject ??
                commitSubjectFor(run.instructionText),
              verification: state.lastRun?.verification ?? "none",
            },
    };
  }
  // The agent's own title for the work when it gave one (record 07), else
  // the first instruction whose work has not been pushed yet.
  const subject =
    state.described?.title ?? state.unpublishedSubject ?? commitSubjectFor(run.instructionText);
  return {
    ...state,
    run: { kind: "idle" },
    unpublishedSubject: subject,
    lastRun:
      run.conversation === null
        ? state.lastRun
        : {
            runId: run.runId,
            conversation: run.conversation,
            promptedMessageIds: run.promptedMessageIds,
            commitSubject: subject,
            verification,
          },
  };
}

/** A `run.start` the parser let through: it names the run the object queued. */
export type RunStartFrame = CommandFrame & {
  readonly command: { readonly type: "run.start" };
  readonly runId: string;
};

function startRun(
  state: AgentState,
  frame: RunStartFrame,
  model: Extract<ModelPhase, { kind: "held" }>,
  ctx: StepContext,
): StepOutcome {
  const command = frame.command;
  const runId = frame.runId;
  const continues =
    state.lastRun !== null && command.payload.continuesRunId === state.lastRun.runId
      ? state.lastRun.conversation
      : null;
  const run: ActiveRun = {
    runId,
    commandId: command.commandId,
    conversation: continues,
    phase: "prompting",
    windDown: null,
    startedAtMs: ctx.nowMs,
    instructionText: command.payload.instruction.text,
    contextWindow: command.payload.model.contextWindow,
    effort: command.payload.model.effort ?? null,
    promptedMessageIds: [command.payload.instruction.messageId],
    normalizer: emptyNormalizerState,
    lastAssistantText: null,
    toolsRun: 0,
    skipRequiredChecks: command.payload.skipRequiredChecks === true,
    checksOnly: command.payload.checksOnly === true,
    turnBaseSha: null,
    verification: null,
    subagents: NO_SUBAGENTS,
  };
  if (run.checksOnly) {
    return startChecksRun(
      {
        ...state,
        pendingStart: null,
        commitsThisRun: 0,
        resumeContext: frame.context ?? state.resumeContext,
      },
      { ...run, conversation: null },
      ctx,
    );
  }
  // The resume context is prepended to the prompt but kept out of
  // `instructionText`, which the completion summary quotes as the user's words.
  const context = frame.context ?? (continues === null ? state.resumeContext : null);
  const text =
    context === null
      ? command.payload.instruction.text
      : `${context}\n\n${command.payload.instruction.text}`;
  return outcome(
    {
      ...state,
      run: { kind: "active", ...run },
      pendingStart: null,
      commitsThisRun: 0,
      resumeContext: null,
    },
    {
      kind: "prompt",
      runId,
      conversation: continues,
      text,
      model: model.model,
      effort: run.effort,
      turnBase: diffRefsOf(state),
      attachments: frame.attachments ?? [],
      messageId: command.payload.instruction.messageId,
      imageInput: model.modelSpec?.imageInput ?? false,
    },
  );
}

/**
 * A checks-only run skips the prompt and goes straight to the run's end
 * (record 14). With no turn base there is no turn diff, so it always verifies.
 */
function startChecksRun(state: AgentState, run: ActiveRun, ctx: StepContext): StepOutcome {
  const running: ActiveRun = { ...run, phase: "running" };
  const started = emit(runStartedDraft(run.runId, state.workspace));
  const ended = endRun({ ...state, run: { kind: "active", ...running } }, running, ctx);
  return outcome(ended.state, started, ...ended.effects);
}

/**
 * `close_link` once the shutdown was asked for, the runtime is down, and no
 * checkpoint is still settling. Every arm that can be the last of those calls this.
 */
function closeLinkIfDone(state: AgentState): readonly AgentEffect[] {
  return state.stopping &&
    state.checkpoint.kind === "idle" &&
    (state.runtime.kind === "not_started" || state.runtime.kind === "exited")
    ? [{ kind: "close_link" }]
    : [];
}

/** The run the checkpoint's run-scoped events charge to: the active one, else the last one that ran. */
function chargedRunId(state: AgentState): string | null {
  return state.run.kind === "active" ? state.run.runId : (state.lastRun?.runId ?? null);
}

function checkpointedDrafts(
  phase: Extract<CheckpointPhase, { kind: "running" | "uploading" }>,
  kind: PayloadOf<"repository.checkpointed">["kind"],
  headSha: string,
  bundle: Unbranded<PayloadOf<"sandbox.checkpointed">["bundle"]>,
  nowMs: number,
): readonly AgentEffect[] {
  const reasons = CHECKPOINT_REASONS[phase.reason];
  const effects: AgentEffect[] = [];
  if (phase.runId !== null) {
    effects.push(
      emit(
        draft("repository.checkpointed", phase.runId, {
          checkpointId: phase.checkpointId,
          kind,
          headSha,
          bundle,
          reason: reasons.repository,
        }),
      ),
    );
  }
  effects.push(
    emit(
      draft("sandbox.checkpointed", null, {
        checkpointId: phase.checkpointId,
        kind,
        headSha,
        bundle,
        reason: reasons.sandbox,
        durationMs: Math.max(0, nowMs - phase.startedAtMs),
      }),
    ),
  );
  return effects;
}

function withoutUpload(uploads: readonly PendingUpload[], artifactId: string): PendingUpload[] {
  return uploads.filter((upload) => upload.artifactId !== artifactId);
}

/** After a run ends: the held `run.start`, if any, is prompted now. */
function releasePending(state: AgentState, ctx: StepContext): StepOutcome {
  const pending = state.pendingStart;
  if (pending === null || state.model.kind !== "held") {
    return outcome({ ...state, pendingStart: null });
  }
  return startRun(state, pending, state.model, ctx);
}

/** Starts the runtime once the model grant is held and the workspace is ready (after chown) or absent. */
function maybeStart(state: AgentState, ctx: StepContext): StepOutcome {
  if (
    state.model.kind !== "held" ||
    state.runtime.kind !== "not_started" ||
    (state.workspace.kind !== "ready" && state.workspace.kind !== "none") ||
    state.stopping
  ) {
    return outcome(state);
  }
  const runtime = runtimeOf(state);
  const port = ctx.runtimePort ?? runtime.defaultPort;
  return outcome(
    {
      ...state,
      runtime: { kind: "starting" },
      spawnedModels: promptableModels(runtime, state.model.model, state.model.catalog),
    },
    {
      kind: "start_runtime",
      port,
      request: runtime.planSpawn({
        port,
        relayPort: ctx.relayPort,
        toolPort: ctx.toolPort,
        model: state.model.model,
        modelSpec: state.model.modelSpec,
        catalog: state.model.catalog,
        binary:
          runtime.id === DEFAULT_RUNTIME_ID ? ctx.runtimeBinary : ctx.runtimeBinaries?.[runtime.id],
        cwd: ctx.runtimeCwd,
        home: ctx.runtimeHome,
        secretsDir: ctx.runtimeSecretsDir,
        attachmentsDir: ctx.runtimeAttachmentsDir,
        hostPaths: ctx.runtimeHost,
        extensionPath: ctx.runtimeExtension,
      }),
    },
  );
}

/**
 * The session's harness: the one its model grant named. Before the first
 * grant nothing has started, and the default answers for the log lines.
 */
/** The harness's own compaction point for the session's model, where both are known. */
function compactsAtOf(state: AgentState): number | null {
  const spec = state.model.kind === "held" ? state.model.modelSpec : null;
  const rule = runtimeOf(state).autoCompactAt;
  return spec === null || rule === undefined ? null : rule(spec);
}

export function runtimeOf(state: AgentState): RuntimePlan {
  return runtimePlan(state.model.kind === "held" ? state.model.runtime : DEFAULT_RUNTIME_ID);
}

/**
 * The reducer's entry point: one arm per input kind. A model failure the user
 * must fix pauses the run; other categories are only logged, since the runtime
 * retries safe failures itself (record 15).
 */
export function step(state: AgentState, input: AgentInput, ctx: StepContext): StepOutcome {
  return withSubagentLifecycle(state, stepSecretsLifecycle(state, input, ctx), ctx);
}

/**
 * A run's subagents go with it: when the run starts winding down each one
 * still running is aborted, and when it ends each one it took with it is
 * reported cancelled (`subagents.ts`). Every way a run winds down or ends
 * passes here.
 */
function withSubagentLifecycle(
  before: AgentState,
  stepped: StepOutcome,
  ctx: StepContext,
): StepOutcome {
  const was = before.run;
  if (was.kind !== "active" || was.subagents.agents.length + was.subagents.allowed.length === 0) {
    return stepped;
  }
  const now = stepped.state.run;
  if (now.kind !== "active" || now.runId !== was.runId) {
    const ended = onSubagentRunEnded(was.subagents, { runId: was.runId, nowMs: ctx.nowMs });
    return {
      state: stepped.state,
      effects: [
        ...stepped.effects,
        ...subagentEffects(was.runId, { state: NO_SUBAGENTS, ...ended }),
      ],
    };
  }
  if (now.phase === "winding_down" && was.phase !== "winding_down") {
    const wound = onWindDown(now.subagents);
    return {
      state: { ...stepped.state, run: { ...now, subagents: wound.state } },
      effects: [...stepped.effects, ...subagentEffects(was.runId, wound)],
    };
  }
  return stepped;
}

/** `subagents.ts`'s drafts and effects as the reducer's. */
function subagentEffects(runId: string, stepped: SubagentStep): AgentEffect[] {
  return [
    ...stepped.drafts.map(emit),
    ...stepped.effects.map((effect): AgentEffect => {
      if (effect.kind === "abort") {
        return { kind: "abort", runId, conversation: effect.agentId };
      }
      if (effect.kind === "log") {
        return log(effect.line);
      }
      return {
        kind: "reply_permission",
        requestId: effect.requestId,
        reply: effect.reply,
        message: effect.message,
      };
    }),
  ];
}

/**
 * An abort came back. One that failed for a subagent is forgotten
 * (`subagents.ts`), so the next stop, wind-down, or run end asks again. The
 * run's own abort changes nothing here: the idle that follows ends the run.
 */
function stepAbortSettled(
  state: AgentState,
  input: Extract<AgentInput, { kind: "abort_settled" }>,
): StepOutcome {
  const run = state.run;
  if (input.ok || run.kind !== "active" || run.runId !== input.runId) {
    return outcome(state);
  }
  const subagents = onAbortFailed(run.subagents, input.conversation);
  if (subagents === run.subagents) {
    return outcome(state);
  }
  return outcome(
    { ...state, run: { ...run, subagents } },
    log("a subagent's abort failed; the next stop, wind-down, or run end asks again"),
  );
}

function stepSecretsLifecycle(state: AgentState, input: AgentInput, ctx: StepContext): StepOutcome {
  const stepped = stepInner(state, input, ctx);
  // A held tool call or a waiting question does not outlive its run: OpenCode
  // leaves an aborted call's permission request pending, so it is rejected
  // here, where every run ending passes.
  const wasActive = state.run.kind === "active" ? state.run.runId : null;
  const stillActive = stepped.state.run.kind === "active" ? stepped.state.run.runId : null;
  if (wasActive === null || wasActive === stillActive) {
    return stepped;
  }
  let next = stepped;
  if (next.state.permissions.held.length > 0) {
    const asks = applyPermissions(
      next.state,
      onPermissionsRunEnded(next.state.permissions),
      wasActive,
    );
    next = { state: asks.state, effects: [...next.effects, ...asks.effects] };
  }
  if (next.state.secrets.waiting !== null) {
    const ended = applySecrets(next.state, onRunEnded(next.state.secrets), wasActive);
    next = { state: ended.state, effects: [...next.effects, ...ended.effects] };
  }
  if (next.state.questions.waiting !== null) {
    const ended = applyQuestions(next.state, onQuestionRunEnded(next.state.questions), null);
    next = { state: ended.state, effects: [...next.effects, ...ended.effects] };
  }
  return next;
}

/** What the bridge believes a card's expiry is; the object's own clock decides. */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** A secret card out: it holds the next permission ask back, since the object shows one card at a time. */
function secretCardOpen(state: AgentState): boolean {
  return state.secrets.waiting?.asked === true;
}

/** A secret card out, or one waiting to go out: either takes the next turn from the permission asks. */
function secretTakesTurn(state: AgentState): boolean {
  return secretCardOpen(state) || hasUnsentRequest(state.secrets);
}

/** A permission card out: it holds a secret's card back. */
function permissionCardOut(state: AgentState): boolean {
  return state.permissions.held[0]?.forwarded === true;
}

/** Whether the harness spreads one reject to every other pending ask of the session (OpenCode does). */
function rejectSpreads(state: AgentState): boolean {
  return runtimeOf(state).rejectSettlesOtherAsks;
}

/** The requests a step tells the harness to reject. */
function rejectedIn(
  effects: readonly (PermissionsStep["effects"][number] | SecretsStep["effects"][number])[],
): readonly string[] {
  return effects.flatMap((effect) =>
    effect.kind === "reply_permission" && effect.reply === "reject" ? [effect.requestId] : [],
  );
}

/** `questions.ts` decides; this turns its effects into the reducer's. */
function applyQuestions(
  state: AgentState,
  stepped: QuestionsStep,
  runId: string | null,
): StepOutcome {
  const effects: AgentEffect[] = stepped.effects.map((effect) => {
    if (effect.kind === "emit_question") {
      // The object mints the id the card answers by and keeps this one as
      // the reference it echoes back.
      return emit(
        draft("question.asked", runId as string, {
          questionId: effect.ref,
          toolCallId: effect.callId,
          questions: effect.questions.map((question) => ({
            ...question,
            options: [...question.options],
          })),
        }),
      );
    }
    return effect.kind === "log" ? log(effect.line) : effect;
  });
  return { state: { ...state, questions: stepped.state }, effects };
}

/**
 * Sends the next card when none is out: a secret request first, since one
 * waits only while a permission card was out, then the next permission ask.
 */
function pumpCards(outcome: StepOutcome, runId: string | null): StepOutcome {
  const state = outcome.state;
  if (secretCardOpen(state) || permissionCardOut(state)) {
    return outcome;
  }
  const sent = hasUnsentRequest(state.secrets)
    ? translateSecrets(state, pumpSecrets(state.secrets, false), runId)
    : translatePermissions(state, pumpPermissions(state.permissions, false), runId);
  return { state: sent.state, effects: [...outcome.effects, ...sent.effects] };
}

/**
 * `permissions.ts` decides; this applies its step and sends the next card.
 * Where the harness spreads a reject, a secret request it took with it and
 * that was never shown is forgotten too.
 */
function applyPermissions(
  state: AgentState,
  stepped: PermissionsStep,
  runId: string | null,
): StepOutcome {
  const applied = translatePermissions(settleStarts(state, stepped), stepped, runId);
  const rejected = rejectedIn(stepped.effects);
  const settled =
    rejectSpreads(state) && rejected.length > 0
      ? {
          ...applied.state,
          secrets: onRequestSettledSecret(applied.state.secrets, {
            except: rejected[0] as string,
          }).state,
        }
      : applied.state;
  return pumpCards({ state: settled, effects: applied.effects }, runId);
}

/**
 * A subagent start the object answered: allowed, its slot waits for the
 * conversation; refused, the slot is given back to the run's limit.
 */
function settleStarts(state: AgentState, stepped: PermissionsStep): AgentState {
  const run = state.run;
  if (run.kind !== "active" || run.subagents.allowed.length === 0) {
    return state;
  }
  let subagents = run.subagents;
  for (const effect of stepped.effects) {
    if (effect.kind === "reply_permission") {
      subagents = onTaskAnswered(subagents, effect.requestId, effect.reply);
    }
  }
  return subagents === run.subagents ? state : { ...state, run: { ...run, subagents } };
}

/** The run a card is charged to: the one named, or the active one. */
function chargedRunOf(state: AgentState, runId: string | null): string | null {
  return runId ?? (state.run.kind === "active" ? state.run.runId : null);
}

/**
 * Turns `permissions.ts`'s effects into the reducer's. The object keeps only
 * the category, resource, tool kind, and call id, and writes the card itself.
 * A card sent arms the bridge's own deadline, so an answer that never arrives
 * cannot hold the queue.
 */
function translatePermissions(
  state: AgentState,
  stepped: PermissionsStep,
  runId: string | null,
): StepOutcome {
  const next: AgentState = { ...state, permissions: stepped.state };
  const effects: AgentEffect[] = [];
  const chargedRun = chargedRunOf(state, runId);
  for (const effect of stepped.effects) {
    switch (effect.kind) {
      case "emit_ask": {
        if (chargedRun === null) {
          effects.push(log("a permission ask with no run to charge it to"));
          break;
        }
        const expiresAt = Date.now() + APPROVAL_TTL_MS;
        effects.push(
          emit(
            draft("approval.requested", chargedRun, {
              approvalId: effect.ref,
              title: "Agent permission",
              intendedAction: "The agent asked for a permission.",
              category: effect.ask.category,
              risk: "medium",
              resource: effect.ask.resource,
              requestedScope: "This request",
              expiresAt: new Date(expiresAt).toISOString(),
              toolCallId: effect.callId,
              ...(effect.ask.toolCategory === null
                ? {}
                : { toolCategory: effect.ask.toolCategory }),
              ...(effect.agentId === undefined ? {} : { agentId: effect.agentId }),
            } as never),
          ),
          { kind: "approval_timer", ref: effect.ref, atMs: expiresAt + DEADLINE_GRACE_MS },
        );
        break;
      }
      case "log":
        effects.push(log(effect.line));
        break;
      default:
        effects.push(effect);
    }
  }
  return { state: next, effects };
}

/**
 * `secrets.ts` decides; this applies its step and sends the next card. Where
 * the harness spreads a reject, the permission asks it took with it are
 * forgotten rather than forwarded.
 */
function applySecrets(state: AgentState, stepped: SecretsStep, runId: string | null): StepOutcome {
  const applied = translateSecrets(state, stepped, runId);
  const settled =
    rejectSpreads(state) && rejectedIn(stepped.effects).length > 0
      ? { ...applied.state, permissions: dropUnsentAsks(applied.state.permissions) }
      : applied.state;
  return pumpCards({ state: settled, effects: applied.effects }, runId);
}

/**
 * Turns `secrets.ts`'s effects into the reducer's. The ack is remembered like
 * any other, so a redelivered grant gets the same answer.
 */
function translateSecrets(
  state: AgentState,
  stepped: SecretsStep,
  runId: string | null,
): StepOutcome {
  let next: AgentState = { ...state, secrets: stepped.state };
  const effects: AgentEffect[] = [];
  const chargedRun = chargedRunOf(state, runId);
  for (const effect of stepped.effects) {
    switch (effect.kind) {
      case "emit_request":
        if (chargedRun === null) {
          effects.push(log("a secret request with no run to charge it to"));
          break;
        }
        effects.push(
          emit(
            // The object keeps only `resource` and `toolCallId` and writes the
            // card itself; the rest is filled with what the bridge believes it asks.
            draft("approval.requested", chargedRun, {
              approvalId: effect.ref,
              title: `Supply ${effect.name}`,
              intendedAction: `The agent asked for the development secret ${effect.name}.`,
              category: "development_secret",
              risk: "medium",
              resource: effect.name,
              requestedScope: "This session's sandbox, until it stops",
              expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
              toolCallId: effect.callId,
            } as never),
          ),
        );
        break;
      case "ack": {
        const decision = effect.accepted ? ACCEPTED : rejected("wrong_state");
        next = { ...next, decided: decide(next.decided, effect.grantId, decision) };
        effects.push({ kind: "ack", ref: { grantId: effect.grantId }, outcome: decision });
        break;
      }
      case "log":
        effects.push(log(effect.line));
        break;
      default:
        effects.push(effect);
    }
  }
  return { state: next, effects };
}

function stepInner(state: AgentState, input: AgentInput, ctx: StepContext): StepOutcome {
  switch (input.kind) {
    case "secrets_written": {
      const written = applySecrets(
        state,
        onSecretsWritten(state.secrets, input.grantId, input.failedNames),
        null,
      );
      // A run.start held for these files is prompted now (see the frame arm).
      if (
        written.state.secrets.writes.length > 0 ||
        written.state.pendingStart === null ||
        written.state.run.kind === "active"
      ) {
        return written;
      }
      const released = releasePending(written.state, ctx);
      return { state: released.state, effects: [...written.effects, ...released.effects] };
    }
    case "approval_deadline":
      if (ownsRef(state.permissions, input.ref)) {
        return applyPermissions(
          state,
          onPermissionDeadline(
            state.permissions,
            input.ref,
            secretTakesTurn(state),
            rejectSpreads(state),
          ),
          null,
        );
      }
      return applySecrets(state, onApprovalDeadline(state.secrets, input.ref), null);
    case "connected":
    case "disconnected":
      return outcome(state);
    case "frame":
      return stepFrame(state, input.frame, ctx);
    case "clone_settled":
      return stepCloneSettled(state, input.grantId, input.result);
    case "chown_settled":
      if (state.workspace.kind !== "ready") {
        return outcome(state, log("chown settled with no clone to hand over"));
      }
      if (!input.ok) {
        return outcome(
          { ...state, workspace: { kind: "failed", detail: input.detail } },
          emit(bootFailure("chown", input.detail)),
        );
      }
      return maybeStart(state, ctx);
    case "runtime_started":
      return stepRuntimeStarted(state, input.result, ctx);
    case "health":
      return stepHealth(state, input.result);
    case "prompt_settled":
      return stepPromptSettled(state, input.runId, input.result, input.turnBase, ctx);
    case "abort_settled":
      return stepAbortSettled(state, input);
    case "runtime_event":
      return stepRuntimeEvent(state, input.event, ctx);
    case "model_failure":
      return stepModelFailure(state, input.failure);
    case "prompt_counts":
      // Between runs there is no answer to carry them, so they are dropped quietly.
      return state.run.kind === "active"
        ? stepRuntimeEvent(state, { kind: "prompt_counts", reading: input.reading }, ctx)
        : outcome(state);
    case "policy_tool_called":
      return stepPolicyTool(state, input.call, ctx);
    case "describe_tool_called":
      return stepDescribeTool(state, input.call);
    case "commit_tool_called":
      return stepCommitTool(state, input.requestId, input.call);
    case "commit_settled":
      return stepCommitSettled(state, input.requestId, input.result, ctx);
    case "runtime_exited":
      return stepRuntimeExited(state, input.code, ctx);
    case "checkpoint_settled":
      return stepCheckpointSettled(
        state,
        input.checkpointId,
        input.result,
        input.diff,
        input.commit,
        ctx,
      );
    case "diffs_built":
      return input.purpose === "run_end"
        ? stepRunEndDiffs(state, input.runId, input.result, ctx)
        : stepMidRunDiffs(state, input.runId, input.result, ctx);
    case "diff_rebuild_due":
      return requestRebuild(
        { ...state, diffRebuild: { ...state.diffRebuild, timerArmed: false } },
        ctx,
      );
    case "upload_settled":
      return stepUploadSettled(state, input.artifactId, input.ok, ctx);
    case "check_settled":
      return stepVerification(
        state,
        input.runId,
        { kind: "check_settled", checkRunId: input.checkRunId, outcome: input.outcome },
        ctx,
      );
    case "base_prepared":
      return stepVerification(
        state,
        input.runId,
        { kind: "base_prepared", dir: input.dir, ok: input.ok },
        ctx,
      );
  }
}

function stepFrame(state: AgentState, frame: SessionFrame, ctx: StepContext): StepOutcome {
  switch (frame.kind) {
    case "malformed":
      return frame.ref === null
        ? outcome(state, log(`dropped a malformed frame: ${frame.detail}`))
        : outcome(state, { kind: "ack", ref: frame.ref, outcome: rejected("malformed") });
    case "command":
      return stepCommand(state, frame.frame, ctx);
    case "grant":
      return stepGrant(state, frame.frame, ctx);
    case "policy":
      return outcome({ ...state, policy: frame.policy });
    case "approval":
      if (ownsRef(state.permissions, frame.requestRef)) {
        return applyPermissions(
          state,
          onPermissionFrame(state.permissions, frame, secretTakesTurn(state), rejectSpreads(state)),
          null,
        );
      }
      return applySecrets(state, onApprovalFrame(state.secrets, frame), null);
    case "question":
      return applyQuestions(state, onQuestionFrame(state.questions, frame), null);
  }
}

/** What the tool accepts: the Git fields the agent wants changed, and why. A field left out keeps its value. */
export interface PolicyToolCall {
  readonly commit?: SessionPolicy["commit"] | undefined;
  readonly push?: SessionPolicy["push"] | undefined;
  readonly pullRequest?: SessionPolicy["pullRequest"] | undefined;
  readonly rationale: string;
}

/**
 * `policy.propose` becomes `policy.proposed`. The bridge fills in what the model
 * must not choose (the asking message and the policy version) and decides
 * nothing: the object computes the direction and refuses a stale proposal.
 */
function stepPolicyTool(state: AgentState, call: PolicyToolCall, ctx: StepContext): StepOutcome {
  if (state.run.kind !== "active" || state.policy === null) {
    return outcome(state, log("dropped a policy_propose call: no active run or no policy yet"));
  }
  const from = state.policy;
  const to: SessionPolicy = {
    ...from,
    commit: call.commit ?? from.commit,
    push: call.push ?? from.push,
    pullRequest: call.pullRequest ?? from.pullRequest,
  };
  return outcome(
    state,
    emit(
      draft("policy.proposed", null, {
        proposalId: ctx.newId() as PayloadOf<"policy.proposed">["proposalId"],
        triggeringMessageId: state.run.promptedMessageIds.at(
          -1,
        ) as PayloadOf<"policy.proposed">["triggeringMessageId"],
        from,
        to,
        direction: "mixed",
        rationale: summaryText(call.rationale),
      }),
    ),
  );
}

/** What the describe tool accepts, already checked by `parseDescribeToolCall`. Null keeps what an earlier call said. */
export interface DescribeToolCall {
  readonly branchName: string | null;
  readonly title: string | null;
  readonly body: string | null;
}

/**
 * `pull_request_describe` becomes `pull_request.described`, charged to the
 * active run. Text, not authority: the object admits it only while that run
 * is running, and it opens and pushes nothing.
 */
function stepDescribeTool(state: AgentState, call: DescribeToolCall): StepOutcome {
  if (state.run.kind !== "active") {
    return outcome(state, log("dropped a pull_request_describe call: no active run"));
  }
  // The latest value of each field, as the object keeps it, so a publish's
  // final commit can be named after the title the agent gave.
  const described: DescribeToolCall = {
    branchName: call.branchName ?? state.described?.branchName ?? null,
    title: call.title ?? state.described?.title ?? null,
    body: call.body ?? state.described?.body ?? null,
  };
  return outcome(
    { ...state, described },
    emit(
      draft("pull_request.described", state.run.runId, {
        title: call.title,
        body: call.body,
        branchName: call.branchName,
      }),
    ),
  );
}

/** What the commit tool accepts, already checked by `parseCommitToolCall`. */
export interface CommitToolCall {
  /** Subject line, then an optional body after a blank line, the way git reads it. */
  readonly message: string;
}

/** Record 07: the agent commits as it goes, but not without end; a run that commits more than this is looping. */
export const MAX_COMMITS_PER_RUN = 30;

export type CommitOutcome =
  | {
      readonly kind: "committed";
      readonly sha: string;
      readonly parentSha: string;
      readonly commit: DiffReport | null;
    }
  | { readonly kind: "unchanged"; readonly sha: string }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * `git_commit` (record 07): the bridge's own Git snapshots the work tree on the
 * agent's last commit, so the agent's `.git` is never read, and nothing is
 * pushed. One at a time, during an active run, under `commit: auto`, with no
 * checkpoint in flight, and at most `MAX_COMMITS_PER_RUN`; every refusal is
 * answered to the model. `commit: manual` governs this tool only: a user-directed
 * push is the user's own consent, and the idle or ceiling checkpoint is not an
 * agent commit (records 07 and 09).
 */
function stepCommitTool(state: AgentState, requestId: string, call: CommitToolCall): StepOutcome {
  const refuse = (text: string) =>
    outcome(state, { kind: "commit_answer", requestId, text, isError: true });
  if (state.run.kind !== "active") {
    return refuse("Not committed: no run is active.");
  }
  // Narrowing applies at once, so the latest policy is read on every call. A
  // policy that has not arrived yet is not taken as permission.
  if (state.policy === null) {
    return refuse(
      "Not committed: the session's Git policy has not reached the sandbox yet; try again in a moment.",
    );
  }
  if (state.policy.commit === "manual") {
    return refuse(
      "Not committed: the user asked not to commit until they say so (the session's commit policy is manual). Leave the changes in the work tree; nothing is lost, and do not run git commit yourself.",
    );
  }
  if (state.workspace.kind !== "ready") {
    return refuse("Not committed: the repository is not ready.");
  }
  if (state.checkpoint.kind !== "idle") {
    return refuse("Not committed: a checkpoint is in progress; try again in a moment.");
  }
  if (state.commitInFlight !== null) {
    return refuse("Not committed: the previous commit is still being made; wait for its answer.");
  }
  if (state.commitsThisRun >= MAX_COMMITS_PER_RUN) {
    return refuse(
      `Not committed: this run has already made ${MAX_COMMITS_PER_RUN} commits, the most a run may.`,
    );
  }
  return outcome(
    {
      ...state,
      commitInFlight: { requestId, message: call.message },
      commitsThisRun: state.commitsThisRun + 1,
    },
    {
      kind: "commit_work",
      requestId,
      runId: state.run.runId,
      message: call.message,
      parentSha: state.chainTip ?? state.durableHead ?? state.workspace.headSha,
    },
  );
}

/** A commit becomes the chain's tip and is reported as `git.committed`; the model was already answered. */
function stepCommitSettled(
  state: AgentState,
  requestId: string,
  result: CommitOutcome,
  ctx: StepContext,
): StepOutcome {
  if (state.commitInFlight === null || state.commitInFlight.requestId !== requestId) {
    return outcome(state, log("a commit settled that was not in flight"));
  }
  const message = state.commitInFlight.message;
  const next: AgentState = { ...state, commitInFlight: null };
  if (result.kind === "failed") {
    return outcome(next, log(`git_commit failed: ${result.detail}`));
  }
  if (result.kind === "unchanged") {
    return outcome(
      next,
      log(`git_commit made no commit: the tree is unchanged at ${result.sha.slice(0, 8)}`),
    );
  }
  if (state.run.kind !== "active" || state.workspace.kind !== "ready") {
    // The run ended while the snapshot ran; the commit exists in the scratch
    // objects and the next checkpoint's parent is still right.
    return outcome(
      { ...next, chainTip: result.sha },
      log("git_commit settled after its run ended"),
    );
  }
  return outcome(
    { ...next, chainTip: result.sha },
    emit(
      draft("git.committed", state.run.runId, {
        commitSha: result.sha,
        parentSha: result.parentSha,
        branch: state.workspace.taskBranch ?? state.workspace.branch,
        message: summaryText(message),
        // The agent asked for this commit through its `git_commit` tool.
        authorType: "agent",
        authorName: COMMIT_AUTHOR_NAME,
        committedAt: ctx.nowIso,
        files: result.commit === null ? [] : result.commit.files,
        additions: result.commit === null ? 0 : result.commit.additions,
        deletions: result.commit === null ? 0 : result.commit.deletions,
        verificationState: "none",
        policy: {
          policyVersion: state.policy?.version ?? 1,
          rule: "auto_commit",
          approvalId: null,
        },
      } as PayloadOf<"git.committed">),
    ),
  );
}

/**
 * The object asked for a shutdown or checkpoint and owns the run's terminal
 * event, so the run winds down with no event of ours. Only the move into
 * winding down aborts, so two commands sent back to back do not abort twice.
 */
function windDownForObject(state: AgentState): {
  readonly run: RunSlot;
  readonly effects: readonly AgentEffect[];
} {
  if (state.run.kind !== "active" || state.run.phase === "winding_down") {
    return { run: state.run, effects: [] };
  }
  if (state.run.phase === "verifying") {
    return cancelVerification(state.run);
  }
  return {
    run: { ...state.run, phase: "winding_down", windDown: "cancelled_by_object" },
    // A run measuring its diffs has an idle runtime, and its build ends it.
    effects:
      state.run.conversation === null || state.run.phase === "diffing"
        ? []
        : [
            {
              kind: "abort",
              runId: state.run.runId,
              conversation: state.run.conversation,
            },
          ],
  };
}

/**
 * Order: a replayed ack first, then the command type, then runtime readiness,
 * then the command's own rule. A cancel or shutdown emits no run event: the
 * object already committed the run's terminal. Every ack is written to `decided`.
 */
function stepCommand(state: AgentState, frame: CommandFrame, ctx: StepContext): StepOutcome {
  const command = frame.command;
  const replayed = replayedAck(state.decided, command.commandId);
  if (replayed !== null) {
    return outcome(state, {
      kind: "ack",
      ref: { commandId: command.commandId },
      outcome: replayed,
    });
  }
  if (command.type === "runtime.shutdown") {
    const wound = windDownForObject(state);
    // The secrets go with the runtime: the files are removed and forgotten.
    const asks = applyPermissions(state, onPermissionsRunEnded(state.permissions), null);
    const secretsCleared = applySecrets(asks.state, onShutdown(asks.state.secrets), null);
    const cleared = applyQuestions(
      secretsCleared.state,
      onQuestionRunEnded(secretsCleared.state.questions),
      null,
    );
    const effects: AgentEffect[] = [
      ...wound.effects,
      ...asks.effects,
      ...secretsCleared.effects,
      ...cleared.effects,
    ];
    const stopping: AgentState = {
      ...cleared.state,
      run: wound.run,
      stopping: true,
      pendingStart: null,
    };
    if (state.runtime.kind === "not_started" || state.runtime.kind === "exited") {
      effects.push(...closeLinkIfDone(stopping));
    } else {
      effects.push({ kind: "signal_runtime", signal: "SIGTERM" });
    }
    return acked(stopping, frame, ACCEPTED, ...effects);
  }
  if (command.type === "checkpoint.create") {
    return stepCheckpointCreate(state, frame, command.payload.reason, ctx);
  }
  if (state.runtime.kind !== "ready" || state.stopping) {
    return acked(state, frame, rejected("no_runtime"));
  }
  switch (command.type) {
    case "run.start": {
      if (frame.runId === null) {
        // The parser refuses a `run.start` frame that names no run; this is
        // the reducer saying the same about a frame handed to it directly.
        return acked(state, frame, rejected("malformed"));
      }
      const start: RunStartFrame = { ...frame, command, runId: frame.runId };
      // A run's record names its model. A start for another model than the
      // one granted would be prompted on the granted one, so it is refused
      // rather than run under the wrong name; a checks-only run prompts none.
      if (
        state.model.kind === "held" &&
        command.payload.checksOnly !== true &&
        !sameModel(state.model.model, command.payload.model)
      ) {
        return acked(state, frame, rejected("wrong_state"));
      }
      if (state.run.kind === "active") {
        if (state.run.phase === "winding_down" && state.pendingStart === null) {
          return acked({ ...state, pendingStart: start }, frame, ACCEPTED);
        }
        return acked(state, frame, rejected("wrong_state"));
      }
      if (state.pendingStart !== null || state.model.kind !== "held") {
        return acked(state, frame, rejected("wrong_state"));
      }
      const messageId = command.payload.instruction.messageId;
      if (state.lastRun?.promptedMessageIds.includes(messageId) === true) {
        return acked(state, frame, rejected("duplicate"));
      }
      if (state.secrets.writes.length > 0) {
        // The launch's secrets are being written; the prompt waits for the
        // supervisor so the agent's first tool call finds the files in place.
        return acked({ ...state, pendingStart: start }, frame, ACCEPTED);
      }
      const started = startRun(state, start, state.model, ctx);
      return acked(started.state, frame, ACCEPTED, ...started.effects);
    }
    case "run.follow_up": {
      if (command.payload.delivery === "run_next") {
        // The object holds these for the next run; acking keeps a stray one
        // from being retried forever.
        return acked(state, frame, ACCEPTED);
      }
      const run = state.run;
      if (run.kind !== "active" || run.phase !== "running" || run.conversation === null) {
        return acked(state, frame, rejected("wrong_state"));
      }
      if (run.promptedMessageIds.includes(command.payload.messageId)) {
        return acked(state, frame, rejected("duplicate"));
      }
      if (state.model.kind !== "held") {
        return acked(state, frame, rejected("wrong_state"));
      }
      return acked(
        {
          ...state,
          run: {
            ...run,
            promptedMessageIds: [...run.promptedMessageIds, command.payload.messageId],
            skipRequiredChecks:
              run.skipRequiredChecks || command.payload.skipRequiredChecks === true,
          },
        },
        frame,
        ACCEPTED,
        {
          kind: "prompt",
          runId: run.runId,
          conversation: run.conversation,
          text: command.payload.text,
          model: state.model.model,
          effort: run.effort,
          turnBase: null,
          attachments: frame.attachments ?? [],
          messageId: command.payload.messageId,
          imageInput: state.model.modelSpec?.imageInput ?? false,
        },
      );
    }
    case "agent.stop": {
      const run = state.run;
      if (run.kind !== "active" || run.runId !== frame.runId) {
        return acked(state, frame, rejected("wrong_state"));
      }
      const stopped = onStopAsked(run.subagents, command.payload.agentId);
      if (!stopped.accepted) {
        return acked(state, frame, rejected("wrong_state"));
      }
      return acked(
        { ...state, run: { ...run, subagents: stopped.state } },
        frame,
        ACCEPTED,
        ...subagentEffects(run.runId, stopped),
      );
    }
    case "run.cancel": {
      const run = state.run;
      if (run.kind !== "active") {
        return acked(state, frame, rejected("wrong_state"));
      }
      if (run.phase === "winding_down") {
        return acked(state, frame, ACCEPTED);
      }
      if (run.phase === "verifying") {
        const wound = cancelVerification(run);
        return acked({ ...state, run: wound.run }, frame, ACCEPTED, ...wound.effects);
      }
      const effects: AgentEffect[] =
        run.conversation === null || run.phase === "diffing"
          ? []
          : [{ kind: "abort", runId: run.runId, conversation: run.conversation }];
      return acked(
        { ...state, run: { ...run, phase: "winding_down", windDown: "cancelled_by_object" } },
        frame,
        ACCEPTED,
        ...effects,
      );
    }
    default:
      return acked(state, frame, rejected("unsupported"));
  }
}

/**
 * A checkpoint needs git, not the runtime, so it is admitted in any runtime
 * phase. An active run winds down as for `runtime.shutdown`.
 */
function stepCheckpointCreate(
  state: AgentState,
  frame: CommandFrame,
  reason: CheckpointReason,
  ctx: StepContext,
): StepOutcome {
  if (state.workspace.kind !== "ready" || state.checkpoint.kind !== "idle") {
    return acked(state, frame, rejected("wrong_state"));
  }
  const wound = windDownForObject(state);
  const effects: AgentEffect[] = [...wound.effects];
  const checkpointId = ctx.newId();
  const runId = chargedRunId(state);
  const durableHeadSha = state.durableHead ?? state.workspace.headSha;
  // The agent's commits come first: the checkpoint's snapshot sits on top of
  // them, and the push carries the chain with the messages the agent wrote.
  const parentSha = state.chainTip ?? durableHeadSha;
  // A publish is the user's push; the grant's id is the push's id, so the
  // object can match the report to the push it asked for.
  const publish: PublishInFlight | null =
    reason === "user_requested" && state.pushGrant !== null && state.lastRun !== null
      ? {
          pushId: state.pushGrant.grantId,
          // The agent's title or the user's first line; cleaned as every
          // commit message is, so the event says what the commit says.
          message: commitMessageOrFallback(state.lastRun.commitSubject),
          verification: state.lastRun.verification,
          parentSha,
          // The push grant's ref names the branch; a workspace that has none
          // yet is on the base branch, which is not the name the work gets.
          branch:
            state.workspace.taskBranch ??
            branchFromRef(state.pushGrant.ref) ??
            state.workspace.branch,
          policyVersion: state.policy?.version ?? 1,
        }
      : null;
  effects.push({
    kind: "checkpoint",
    checkpointId,
    reason,
    message: publish === null ? null : publish.message,
    durableHeadSha,
    parentSha,
    // Null until the first push names the branch; the push grant's ref then does.
    sessionBranch: state.workspace.taskBranch,
    cloneBranch: state.workspace.branch,
    pushGrantId: state.pushGrant?.grantId ?? null,
    sessionBaseSha: runId === null ? null : state.workspace.baseSha,
  });
  return acked(
    {
      ...state,
      run: wound.run,
      checkpoint: {
        kind: "running",
        commandId: frame.command.commandId,
        checkpointId,
        reason,
        runId,
        startedAtMs: ctx.nowMs,
        publish,
        pushedBranch: state.pushGrant === null ? null : branchFromRef(state.pushGrant.ref),
      },
      // Single use: the grant is spent by this checkpoint whether or not the push runs.
      pushGrant: null,
    },
    frame,
    ACCEPTED,
    ...effects,
  );
}

function sameModel(a: RuntimeModel, b: RuntimeModel): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Why a model grant naming another model than the one held is refused, or
 * null (record 15). Nothing changes inside a run, so a run still working keeps
 * its model; and a harness already started takes only a model it was
 * configured for, since it reads its configuration once.
 */
function modelChangeRefusal(state: AgentState, next: RuntimeModel): AckRejection | null {
  if (state.model.kind !== "held" || sameModel(state.model.model, next)) {
    return null;
  }
  if (state.run.kind === "active" && state.run.phase !== "winding_down") {
    return "wrong_state";
  }
  if (
    state.spawnedModels !== null &&
    !state.spawnedModels.some((model) => sameModel(model, next))
  ) {
    return "unsupported";
  }
  return null;
}

/**
 * A second model or push grant is a rotation, not an error; a git grant is
 * single use; a model grant for a different runtime is refused, since a
 * session keeps its harness. A model grant naming another model changes the
 * model the next run is prompted with, where `modelChangeRefusal` allows it.
 */
function stepGrant(state: AgentState, frame: GrantFrame, ctx: StepContext): StepOutcome {
  const replayed = replayedAck(state.decided, frame.grantId);
  if (replayed !== null) {
    return outcome(state, { kind: "ack", ref: { grantId: frame.grantId }, outcome: replayed });
  }
  if (frame.kind === "model") {
    if (!isRuntimeId(frame.runtime)) {
      return acked(state, frame, rejected("unsupported"));
    }
    if (state.model.kind === "held" && state.model.runtime !== frame.runtime) {
      return acked(state, frame, rejected("wrong_state"));
    }
    const refusal = modelChangeRefusal(state, frame.model);
    if (refusal !== null) {
      return acked(state, frame, rejected(refusal));
    }
    // The first grant's list is what the harness is started with; a later
    // grant from an object that sends none keeps it.
    const catalog =
      frame.catalog !== undefined && frame.catalog.length > 0
        ? frame.catalog
        : state.model.kind === "held"
          ? state.model.catalog
          : undefined;
    const workspace: WorkspacePhase =
      state.workspace.kind === "pending" && frame.workspace === "none"
        ? { kind: "none" }
        : state.workspace;
    const held: AgentState = {
      ...state,
      workspace,
      model: {
        kind: "held",
        grantId: frame.grantId,
        runtime: frame.runtime,
        model: frame.model,
        modelSpec: frame.modelSpec,
        ...(catalog === undefined ? {} : { catalog }),
      },
    };
    const started = maybeStart(held, ctx);
    return acked(
      started.state,
      frame,
      ACCEPTED,
      {
        kind: "set_model_token",
        token: frame.token,
        brokerOrigin: frame.brokerOrigin,
        expiresAt: frame.expiresAt,
      },
      ...started.effects,
    );
  }
  if (frame.kind === "push") {
    if (state.workspace.kind !== "ready") {
      return acked(state, frame, rejected("wrong_state"));
    }
    return acked(
      {
        ...state,
        pushGrant: { grantId: frame.grantId, ref: frame.ref, repository: frame.repository },
      },
      frame,
      ACCEPTED,
      {
        kind: "hold_push_token",
        grantId: frame.grantId,
        token: frame.token,
        cloneUrl: frame.repository.cloneUrl,
        ref: frame.ref,
      },
    );
  }
  if (frame.kind === "secret") {
    // Not acknowledged here: the ack follows the supervisor's answer, so the
    // object's "supplied" means the file is in place.
    return applySecrets(state, onSecretGrant(state.secrets, frame), null);
  }
  if (frame.kind === "upload") {
    if (!state.uploads.some((upload) => upload.artifactId === frame.artifactId)) {
      return acked(state, frame, rejected("wrong_state"));
    }
    return acked(state, frame, ACCEPTED, {
      kind: "upload",
      artifactId: frame.artifactId,
      url: frame.url,
      token: frame.token,
      maxBytes: frame.maxBytes,
    });
  }
  if (state.workspace.kind !== "pending") {
    return acked(state, frame, rejected("wrong_state"));
  }
  return acked(
    {
      ...state,
      workspace: {
        kind: "cloning",
        grantId: frame.grantId,
        branch: frame.branch,
        taskBranch: frame.taskBranch,
        baseSha: frame.baseSha,
      },
    },
    frame,
    ACCEPTED,
    { kind: "clone", grant: frame },
  );
}

function stepCloneSettled(state: AgentState, grantId: string, result: CloneOutcome): StepOutcome {
  const workspace = state.workspace;
  if (workspace.kind !== "cloning" || workspace.grantId !== grantId) {
    return outcome(state, log("clone settled for a grant the workspace is not waiting on"));
  }
  if (result.kind === "failed") {
    return outcome(
      { ...state, workspace: { kind: "failed", detail: result.detail } },
      emit(
        bootFailure(
          `clone (${result.category})`,
          result.detail,
          PERSON_FACING_CLONE_FAILURES.has(result.category),
        ),
      ),
    );
  }
  return outcome(
    {
      ...state,
      workspace: {
        kind: "ready",
        branch: workspace.branch,
        taskBranch: workspace.taskBranch,
        baseSha: workspace.baseSha,
        headSha: result.headSha,
      },
      // The clone verified HEAD against the grant's headSha, so this is the
      // remote's tip as the object knows it.
      durableHead: result.headSha,
      project: result.project,
      install: result.install,
    },
    log(describeDefinition(result.project)),
    { kind: "chown_workspace", uid: AGENT_UID },
  );
}

/** A checkpoint that is also the user's push, reported as `git.*` events too. */
export interface PublishInFlight {
  readonly pushId: string;
  readonly message: string;
  readonly verification: VerificationAtCommit;
  readonly parentSha: string;
  readonly branch: string;
  readonly policyVersion: number;
}

/** The commit's author, as `git.ts`'s `CHECKPOINT_AUTHOR` writes it. */
const COMMIT_AUTHOR_NAME = "OnCue";

const PUSH_FAILURE_CATEGORY: Readonly<
  Record<PushNotDone, PayloadOf<"git.push.failed">["category"]>
> = {
  workflow_file_rejected: "workflow_file_rejected",
  ref_mismatch: "wrong_ref",
  rejected: "non_fast_forward",
  authentication_failed: "authentication",
  network: "network",
  no_grant: "unknown",
  grant_spent: "unknown",
  unknown: "unknown",
  secret_in_changes: "secret_in_changes",
  secret_scan_failed: "secret_in_changes",
};

const PUSH_FAILURE_MESSAGE: Readonly<Record<PushNotDone, string>> = {
  workflow_file_rejected:
    "GitHub blocked the push because it changes a file under .github/workflows, which OnCue has no permission to change.",
  ref_mismatch: "The bridge refused to push to anything but the session branch.",
  rejected: "GitHub rejected the push.",
  authentication_failed: "GitHub refused the push's credential.",
  network: "The push could not reach GitHub.",
  no_grant: "The push had no credential to use.",
  grant_spent: "The push's credential had already been used.",
  unknown: "The push failed.",
  secret_in_changes:
    "OnCue published nothing because the changes contain a development secret supplied to this session.",
  secret_scan_failed:
    "OnCue published nothing because the changes could not be checked for the development secrets supplied to this session.",
};

/** How many files a withheld checkpoint's message names before it counts the rest. */
const MAX_NAMED_SECRET_PATHS = 5;

/** A push failure's words. A withheld one names the files, which is what the user has to go and fix. */
function pushFailureMessage(result: Extract<CheckpointOutcome, { push: PushNotDone }>): string {
  const base = PUSH_FAILURE_MESSAGE[result.push];
  const paths = result.kind === "committed_only" ? (result.secretPaths ?? []) : [];
  if (paths.length === 0) {
    return base;
  }
  // A few names, counted, rather than every path cut mid-name at the schema's limit.
  const shown = paths.slice(0, MAX_NAMED_SECRET_PATHS).join(", ");
  const more = paths.length - MAX_NAMED_SECRET_PATHS;
  const named = more > 0 ? `${shown}, and ${more} more` : shown;
  return `${base} Found in: ${named}. Remove the value from the files, and the work stays in the sandbox until then.`;
}

/** What a publish reports beside the checkpoint's own events (record 07). An unchanged tree reports nothing. */
function publishDrafts(
  phase: Extract<CheckpointPhase, { kind: "running" }>,
  result: CheckpointOutcome,
  commit: DiffReport | null,
  ctx: StepContext,
  branch: string,
): readonly AgentEffect[] {
  const publish = phase.publish;
  if (phase.runId === null) {
    return [];
  }
  if (publish === null) {
    // No push was asked for, except that work withheld because it holds a
    // secret is reported on the run whoever asked for the checkpoint.
    if (result.kind !== "committed_only" || !withheldForSecret(result.push)) {
      return [];
    }
    return [
      emit(
        draft("git.push.failed", phase.runId, {
          pushId: ctx.newId(),
          branch,
          headSha: result.headSha,
          category: PUSH_FAILURE_CATEGORY[result.push],
          message: summaryText(pushFailureMessage(result)),
          retryable: false,
        } as PayloadOf<"git.push.failed">),
      ),
    ];
  }
  if (result.kind === "pushed") {
    // A head that is the agent's own last commit made no commit of its own:
    // the chain was pushed as it stood, and each commit was reported when
    // the agent made it.
    const finalCommit =
      result.headSha === publish.parentSha
        ? []
        : [
            emit(
              draft("git.committed", phase.runId, {
                commitSha: result.headSha,
                parentSha: publish.parentSha,
                branch: publish.branch,
                message: summaryText(publish.message),
                // The user's push policy asked for this commit, and asking for
                // the push is consent to commit what it carries (record 07).
                // The agent's own commits are its `git_commit` calls.
                authorType: "user",
                authorName: COMMIT_AUTHOR_NAME,
                committedAt: ctx.nowIso,
                files: commit === null ? [] : commit.files,
                additions: commit === null ? 0 : commit.additions,
                deletions: commit === null ? 0 : commit.deletions,
                verificationState: publish.verification,
                policy: {
                  policyVersion: publish.policyVersion,
                  rule: "auto_push",
                  approvalId: null,
                },
              } as PayloadOf<"git.committed">),
            ),
          ];
    return [
      ...finalCommit,
      emit(
        draft("git.push.completed", phase.runId, {
          pushId: publish.pushId,
          branch: publish.branch,
          headSha: result.headSha,
          remoteSha: result.headSha,
        } as PayloadOf<"git.push.completed">),
      ),
    ];
  }
  if (result.kind === "bundled" || result.kind === "committed_only") {
    return [
      emit(
        draft("git.push.failed", phase.runId, {
          pushId: publish.pushId,
          branch: publish.branch,
          headSha: result.headSha,
          category: PUSH_FAILURE_CATEGORY[result.push],
          message: summaryText(pushFailureMessage(result)),
          retryable: result.push === "network",
        } as PayloadOf<"git.push.failed">),
      ),
    ];
  }
  return [];
}

function stepCheckpointSettled(
  state: AgentState,
  checkpointId: string,
  result: CheckpointOutcome,
  diff: DiffReport | null,
  commit: DiffReport | null,
  ctx: StepContext,
): StepOutcome {
  const phase = state.checkpoint;
  if (phase.kind !== "running" || phase.checkpointId !== checkpointId) {
    return outcome(state, log("checkpoint settled for a checkpoint that is not running"));
  }
  // Before the checkpointed events: the object stops the sandbox on those.
  const reported =
    phase.runId === null || diff === null
      ? { state, effects: [] }
      : emitSessionDiffIfNew(state, phase.runId, diff, ctx);
  const settled = settleCheckpointResult(reported.state, phase, result, ctx);
  // Before the checkpoint's own report: the object revokes the push token on
  // `repository.checkpointed`, and by then it must have heard how the push went.
  return outcome(
    settled.state,
    ...reported.effects,
    ...publishDrafts(
      phase,
      result,
      commit,
      ctx,
      state.workspace.kind === "ready"
        ? (state.workspace.taskBranch ?? state.workspace.branch)
        : "",
    ),
    ...settled.effects,
  );
}

function settleCheckpointResult(
  state: AgentState,
  phase: Extract<CheckpointPhase, { kind: "running" }>,
  result: CheckpointOutcome,
  ctx: StepContext,
): StepOutcome {
  const checkpointId = phase.checkpointId;
  const idle: AgentState = { ...state, checkpoint: { kind: "idle" } };
  switch (result.kind) {
    case "failed":
      // Said durably, so the object ends a stop's wait now rather than waiting
      // out its deadline. It also settles a waiting publish.
      return outcome(
        idle,
        log(`checkpoint ${checkpointId} failed: ${result.detail}`),
        emit(
          draft("sandbox.checkpoint_failed", null, {
            checkpointId,
            reason: CHECKPOINT_REASONS[phase.reason].sandbox,
            failure: result.detail,
            durationMs: Math.max(0, ctx.nowMs - phase.startedAtMs),
          }),
        ),
        ...closeLinkIfDone(idle),
      );
    case "pushed": {
      // A workspace with no task branch adopts the one the push grant named.
      const workspace =
        state.workspace.kind === "ready" &&
        state.workspace.taskBranch === null &&
        phase.pushedBranch !== null
          ? { ...state.workspace, taskBranch: phase.pushedBranch }
          : state.workspace;
      const next: AgentState = {
        ...idle,
        workspace,
        durableHead: result.headSha,
        chainTip: null,
        unpublishedSubject: null,
      };
      return outcome(
        next,
        ...checkpointedDrafts(phase, "branch_push", result.headSha, null, ctx.nowMs),
        ...closeLinkIfDone(next),
      );
    }
    case "unchanged":
      return outcome(
        idle,
        ...checkpointedDrafts(phase, "branch_push", result.headSha, null, ctx.nowMs),
        ...closeLinkIfDone(idle),
      );
    case "committed_only":
      return outcome(
        idle,
        ...checkpointedDrafts(phase, "local_commit", result.headSha, null, ctx.nowMs),
        ...closeLinkIfDone(idle),
      );
    case "bundled": {
      if (phase.runId === null) {
        return outcome(
          idle,
          log(
            "checkpoint bundled with no run to charge the artifact to; reported as a local commit",
          ),
          ...checkpointedDrafts(phase, "local_commit", result.headSha, null, ctx.nowMs),
          ...closeLinkIfDone(idle),
        );
      }
      const artifactId = ctx.newId();
      return outcome(
        {
          ...state,
          checkpoint: {
            kind: "uploading",
            checkpointId,
            reason: phase.reason,
            runId: phase.runId,
            startedAtMs: phase.startedAtMs,
            headSha: result.headSha,
            artifactId,
            byteSize: result.byteSize,
          },
          uploads: [...state.uploads, { artifactId, purpose: "checkpoint" as const }].slice(
            -UPLOADS_LIMIT,
          ),
        },
        emit(
          draft("artifact.uploading", phase.runId, {
            artifactId,
            kind: "patch",
            contentType: CHECKPOINT_PATCH_CONTENT_TYPE,
            declaredBytes: result.byteSize,
            producer: "checkpoint",
          }),
        ),
        { kind: "stage_upload", artifactId, source: { kind: "checkpoint", checkpointId } },
      );
    }
  }
}

/** A bundle's PUT decides `patch_bundle` or `local_commit`; any other artifact's settle is forgotten. */
function stepUploadSettled(
  state: AgentState,
  artifactId: string,
  ok: boolean,
  ctx: StepContext,
): StepOutcome {
  if (!state.uploads.some((upload) => upload.artifactId === artifactId)) {
    return outcome(state, log("upload settled for an artifact this generation never declared"));
  }
  const uploads = withoutUpload(state.uploads, artifactId);
  // A tree listing that never landed is forgotten, so the next diff with the
  // same tree declares it again rather than naming an artifact nobody stored.
  const settled = state.uploads.find((upload) => upload.artifactId === artifactId);
  const lastTree = !ok && settled?.purpose === "tree" ? null : state.lastTree;
  const after: AgentState = { ...state, uploads, lastTree };
  const phase = state.checkpoint;
  if (phase.kind !== "uploading" || phase.artifactId !== artifactId) {
    const run = state.run;
    if (
      run.kind === "active" &&
      run.verification !== null &&
      awaitedArtifact(run.verification) === artifactId
    ) {
      return stepVerification(after, run.runId, { kind: "upload_settled", artifactId, ok }, ctx);
    }
    return outcome(after);
  }
  const idle: AgentState = { ...after, checkpoint: { kind: "idle" } };
  const drafts = ok
    ? checkpointedDrafts(
        phase,
        "patch_bundle",
        phase.headSha,
        {
          artifactId,
          kind: "patch",
          contentType: CHECKPOINT_PATCH_CONTENT_TYPE,
          byteSize: phase.byteSize,
          label: CHECKPOINT_PATCH_LABEL,
        },
        ctx.nowMs,
      )
    : checkpointedDrafts(phase, "local_commit", phase.headSha, null, ctx.nowMs);
  return outcome(idle, ...drafts, ...closeLinkIfDone(idle));
}

/** Declares a cut tool output as an artifact; the bytes go to the interpreter, the state keeps the id. */
function stageToolOverflow(
  state: AgentState,
  run: ActiveRun,
  overflow: ToolOverflow,
  ctx: StepContext,
): { readonly state: AgentState; readonly effects: readonly AgentEffect[] } {
  const declaredBytes = new TextEncoder().encode(overflow.text).byteLength;
  if (declaredBytes > MAX_ARTIFACT_BYTES) {
    return {
      state,
      effects: [
        log(`tool ${overflow.toolCallId} output exceeds the artifact ceiling; kept inline only`),
      ],
    };
  }
  if (state.uploads.length >= UPLOADS_LIMIT) {
    return {
      state,
      effects: [
        log(`tool ${overflow.toolCallId} output not offered: ${UPLOADS_LIMIT} uploads pending`),
      ],
    };
  }
  const artifactId = ctx.newId();
  return {
    state: { ...state, uploads: [...state.uploads, { artifactId, purpose: "tool_output" }] },
    effects: [
      emit(
        draft("artifact.uploading", run.runId, {
          artifactId,
          kind: "tool_output",
          contentType: TOOL_OUTPUT_CONTENT_TYPE,
          declaredBytes,
          producer: "tool",
        }),
      ),
      { kind: "stage_upload", artifactId, source: { kind: "text", text: overflow.text } },
    ],
  };
}

function stepRuntimeStarted(
  state: AgentState,
  result: StartOutcome,
  ctx: StepContext,
): StepOutcome {
  if (state.runtime.kind !== "starting") {
    return outcome(state, log("runtime start settled while the runtime was not starting"));
  }
  if (result.kind === "failed") {
    const exited: AgentState = { ...state, runtime: { kind: "exited", code: null } };
    return outcome(exited, emit(bootFailure("start", result.detail)), ...closeLinkIfDone(exited));
  }
  return outcome(
    {
      ...state,
      runtime: { kind: "probing", attempts: 0, startedAtMs: ctx.nowMs, port: result.port },
    },
    { kind: "probe_health", port: result.port, afterMs: 0 },
  );
}

function stepHealth(state: AgentState, result: HealthOutcome): StepOutcome {
  const runtime = state.runtime;
  if (runtime.kind !== "probing") {
    return outcome(state);
  }
  if (result.kind === "healthy") {
    return outcome(
      {
        ...state,
        runtime: {
          kind: "listening",
          version: result.version,
          port: runtime.port,
          startedAtMs: runtime.startedAtMs,
        },
      },
      log(
        `${runtimeOf(state).id} ${result.version} answered health after ${runtime.attempts + 1} probes; listening`,
      ),
      { kind: "subscribe_events", port: runtime.port },
    );
  }
  const attempts = runtime.attempts + 1;
  // The first probe and then one in forty: enough to see what the runtime
  // answered while it boots, without a line every quarter second.
  const probeLog =
    attempts === 1 || attempts % 40 === 0
      ? [log(`${runtimeOf(state).id} health probe ${attempts}: ${result.detail}`)]
      : [];
  if (attempts >= HEALTH_POLL_ATTEMPTS) {
    return outcome(
      { ...state, runtime: { kind: "exited", code: null } },
      { kind: "signal_runtime", signal: "SIGKILL" },
      emit(bootFailure("health", `no healthy answer after ${attempts} probes`)),
    );
  }
  return outcome({ ...state, runtime: { ...runtime, attempts } }, ...probeLog, {
    kind: "probe_health",
    port: runtime.port,
    afterMs: HEALTH_POLL_INTERVAL_MS,
  });
}

function stepPromptSettled(
  state: AgentState,
  runId: string,
  result: PromptOutcome,
  turnBase: TurnBase | null,
  ctx: StepContext,
): StepOutcome {
  const run = state.run;
  if (run.kind !== "active" || run.runId !== runId) {
    return outcome(state, log("prompt settled for a run that is not active"));
  }
  if (run.phase === "running" || run.phase === "diffing" || run.phase === "verifying") {
    // A steer's prompt_async answered. Nothing changes: the run is already under way.
    return result.kind === "held"
      ? outcome(state)
      : outcome(state, log(`follow-up prompt refused: ${result.detail}`));
  }
  if (result.kind === "refused") {
    if (run.phase === "winding_down") {
      return releasePending(finishRun(state, run), ctx);
    }
    return outcome(
      finishRun(state, run),
      emit(runFailedDraft(run, state.workspace, ctx.nowMs, "runtime_error", result.detail)),
    );
  }
  if (run.phase === "winding_down") {
    // The prompt landed after a cancel began, so the runtime is now working on
    // it: abort again, against the conversation that just started.
    return outcome(
      { ...state, run: { ...run, conversation: result.conversation } },
      { kind: "abort", runId: run.runId, conversation: result.conversation },
    );
  }
  const effects: AgentEffect[] = [emit(runStartedDraft(run.runId, state.workspace))];
  if (state.workspace.kind === "ready") {
    effects.push(
      emit(
        turnBase === null || turnBase.status === null
          ? unmeasuredStatusDraft(run.runId, state.workspace)
          : repositoryStatusDraft(run.runId, turnBase.status),
      ),
    );
  }
  return outcome(
    {
      ...state,
      run: {
        ...run,
        phase: "running",
        conversation: result.conversation,
        turnBaseSha: turnBase?.sha ?? null,
      },
    },
    ...effects,
  );
}

function pauseForModelFailure(
  state: AgentState,
  run: ActiveRun,
  failure: RelayFailure,
): StepOutcome {
  const effects: AgentEffect[] = [emit(runPausedDraft(run.runId, failure))];
  if (run.conversation !== null) {
    effects.push({ kind: "abort", runId: run.runId, conversation: run.conversation });
  }
  return outcome(
    {
      ...state,
      run: { kind: "active", ...run, phase: "winding_down", windDown: "paused_model_failure" },
    },
    ...effects,
  );
}

function stepModelFailure(state: AgentState, failure: RelayFailure): StepOutcome {
  const run = state.run;
  if (run.kind !== "active" || run.phase !== "running") {
    return outcome(state, log(`model failure with no running run: ${failure.category}`));
  }
  if (!PAUSING_CATEGORIES.has(failure.category)) {
    return outcome(state, log(`model failure the runtime retries itself: ${failure.category}`));
  }
  return pauseForModelFailure(state, run, failure);
}

/**
 * The run lifecycle, driven by the normalizer's signal. Tool parts still settle
 * while winding down so the timeline closes them. Once the runtime is idle, the
 * diffs and verification own the run's ending.
 */
function stepRuntimeEvent(
  state: AgentState,
  event: RuntimeEvent,
  ctx: StepContext,
  heldCallSeen = false,
): StepOutcome {
  if (state.runtime.kind === "listening" && event.kind === "server_connected") {
    const { version, port, startedAtMs } = state.runtime;
    return outcome(
      { ...state, runtime: { kind: "ready", version, port } },
      log(`${runtimeOf(state).id} event stream connected; runtime ready`),
      emit(
        draft("runtime.ready", null, {
          runtimeName: runtimeOf(state).id,
          runtimeVersion: version.slice(0, 256),
          healthChecks: [
            { name: "global_health", passed: true },
            { name: "event_stream", passed: true },
          ],
          startupMs: Math.max(0, ctx.nowMs - startedAtMs),
        }),
      ),
    );
  }
  if (event.kind === "permission_asked" && event.permission === SUBAGENT_TOOL) {
    return stepTaskAsked(state, event, ctx);
  }
  if (event.kind === "question_asked") {
    const active = state.run.kind === "active" ? state.run : null;
    return applyQuestions(
      state,
      onQuestionAsked(state.questions, event, {
        runActive: active !== null && active.phase === "running",
        newRef: ctx.newId,
        // Only the primary agent talks to the user; OpenCode denies a
        // subagent the tool, and one that asks anyway is dismissed.
        fromSubagent: conversationRoute(state, event.sessionId).kind !== "root",
      }),
      active?.runId ?? null,
    );
  }
  if (event.kind === "question_settled") {
    return applyQuestions(state, onQuestionSettled(state.questions, event.requestId), null);
  }
  if (event.kind === "permission_asked") {
    const plan = runtimeOf(state);
    const secretKey = plan.presentToolName(SECRET_TOOL_NAME);
    const route = conversationRoute(state, event.sessionId);
    if (event.permission === secretKey && route.kind !== "root") {
      // OnCue's tools are the primary agent's; a subagent's secret ask would
      // hold the run's one secret slot after the subagent is gone.
      return outcome(state, {
        kind: "reply_permission",
        requestId: event.requestId,
        reply: "reject",
        message: SUBAGENT_SECRET_REFUSAL,
      });
    }
    if (event.permission === secretKey && event.callId !== null) {
      return applySecrets(
        state,
        onPermissionAsked(
          state.secrets,
          { requestId: event.requestId, permission: event.permission, callId: event.callId },
          {
            permissionKey: secretKey,
            runActive: state.run.kind === "active",
            newRef: ctx.newId,
          },
        ),
        null,
      );
    }
    // A subagent's call lives in its own normalizer, and its card names it.
    const child = route.kind === "child" ? route.agent : null;
    if (child !== null && child.phase !== "running" && child.phase !== "pending") {
      return outcome(state, {
        kind: "reply_permission",
        requestId: event.requestId,
        reply: "reject",
        message: "This subagent has stopped.",
      });
    }
    const tool =
      event.callId === null || state.run.kind !== "active"
        ? null
        : ((child?.normalizer ?? state.run.normalizer).tools.get(event.callId)?.tool ?? null);
    const ask = plan.classifyAsk(
      {
        permission: event.permission,
        patterns: event.patterns ?? [],
        metadata: event.metadata ?? {},
        input: event.input ?? null,
        tool,
      },
      { cwd: ctx.runtimeCwd ?? ALLOWED_CWD, toolCategory: plan.toolCategory },
    );
    return applyPermissions(
      state,
      onAsk(
        state.permissions,
        {
          requestId: event.requestId,
          callId: event.callId,
          ask,
          ...(child === null ? {} : { agentId: child.agentId }),
        },
        {
          runActive: state.run.kind === "active",
          newRef: ctx.newId,
          blocked: secretTakesTurn(state),
          cascade: rejectSpreads(state),
        },
      ),
      null,
    );
  }
  if (event.kind === "permission_replied") {
    // Answered by the bridge, by a reject the harness spread, or from inside
    // the sandbox: a request never shown is not shown now.
    // The secret first, so a settled one is not sent as the next card.
    const secrets = applySecrets(
      state,
      onRequestSettledSecret(state.secrets, { requestId: event.requestId }),
      null,
    );
    const asks = applyPermissions(
      secrets.state,
      onPermissionSettled(
        secrets.state.permissions,
        event.requestId,
        secretTakesTurn(secrets.state),
      ),
      null,
    );
    return { state: asks.state, effects: [...secrets.effects, ...asks.effects] };
  }
  const run = state.run;
  if (run.kind !== "active") {
    return outcome(
      state,
      log(
        `${runtimeOf(state).id} event ${event.kind === "unknown" ? `unknown ${event.wireKind}` : event.kind} with no active run`,
      ),
    );
  }
  if (
    event.kind === "tool_part" &&
    (event.part.status === "completed" || event.part.status === "error") &&
    state.permissions.held.some((held) => held.callId === event.part.callId)
  ) {
    // The held call ended some other way, so it is not forwarded later.
    const settled = applyPermissions(
      state,
      onCallSettled(state.permissions, event.part.callId, secretTakesTurn(state)),
      run.runId,
    );
    const rest = stepRuntimeEvent(settled.state, event, ctx, heldCallSeen);
    return { state: rest.state, effects: [...settled.effects, ...rest.effects] };
  }
  if (event.kind === "tool_part" && state.secrets.waiting !== null && !heldCallSeen) {
    // The held call's part carries the input the permission event lacks. It is
    // also normalised below like any other part, so the timeline shows the call.
    const held = applySecrets(
      state,
      onToolPart(state.secrets, event.part, permissionCardOut(state)),
      run.runId,
    );
    const rest = stepRuntimeEvent(held.state, event, ctx, true);
    return { state: rest.state, effects: [...held.effects, ...rest.effects] };
  }
  if (event.kind === "session_created") {
    const created = onSessionCreated(run.subagents, event, {
      rootConversation: run.conversation,
      nowMs: ctx.nowMs,
    });
    return outcome(
      { ...state, run: { ...run, subagents: created.state } },
      ...subagentEffects(run.runId, created),
    );
  }
  const route = routeOf(run.subagents, run.conversation, event.sessionId);
  if (route.kind === "foreign") {
    return outcome(state);
  }
  if (route.kind === "child") {
    const child = onChildEvent(run.subagents, route.agentId, event, {
      nowMs: ctx.nowMs,
      newId: ctx.newId,
      runId: run.runId,
      contextWindow: run.contextWindow,
      runtime: runtimeOf(state),
    });
    // A subagent's diff report still asks the bridge's own Git to measure.
    const rebuild =
      event.kind === "session_diff" && run.phase === "running"
        ? requestRebuild({ ...state, run: { ...run, subagents: child.state } }, ctx)
        : outcome({ ...state, run: { ...run, subagents: child.state } });
    return outcome(rebuild.state, ...subagentEffects(run.runId, child), ...rebuild.effects);
  }
  const forSubagents =
    event.kind === "tool_part"
      ? onRootToolPart(run.subagents, event.part, {
          runId: run.runId,
          nowMs: ctx.nowMs,
          rootConversation: run.conversation,
          model:
            state.model.kind === "held"
              ? { provider: state.model.model.provider, modelId: state.model.model.modelId }
              : null,
        })
      : null;
  if (forSubagents !== null) {
    const tracked: AgentState = { ...state, run: { ...run, subagents: forSubagents.state } };
    const rest = stepRootEvent(tracked, event, ctx);
    return {
      state: rest.state,
      effects: [...subagentEffects(run.runId, forSubagents), ...rest.effects],
    };
  }
  return stepRootEvent(state, event, ctx);
}

/**
 * OpenCode holds a `task` call (`subagents.ts`). The bridge refuses a start
 * the run cannot take, so it never shows a card; one within the run's limit
 * holds a slot and goes to the session object's permission gate as
 * `start_subagent`, which answers from the user's approval mode or a card.
 */
function stepTaskAsked(
  state: AgentState,
  event: Extract<RuntimeEvent, { kind: "permission_asked" }>,
  ctx: StepContext,
): StepOutcome {
  const run = state.run;
  const subagents = run.kind === "active" ? run.subagents : NO_SUBAGENTS;
  const asked = onTaskAsked(
    subagents,
    { requestId: event.requestId, callId: event.callId, patterns: event.patterns ?? [] },
    {
      fromRoot: run.kind === "active" && conversationRoute(state, event.sessionId).kind === "root",
      runRunning: run.kind === "active" && run.phase === "running",
    },
  );
  if (run.kind !== "active") {
    return outcome(state, ...subagentEffects("", asked));
  }
  const tracked: AgentState = { ...state, run: { ...run, subagents: asked.state } };
  const refused = asked.effects.find(
    (effect) => effect.kind === "reply" && effect.reply === "reject",
  );
  if (asked.forward === null && (refused === undefined || !rejectSpreads(state))) {
    return outcome(tracked, ...subagentEffects(run.runId, asked));
  }
  const ask = runtimeOf(state).classifyAsk(
    {
      permission: event.permission,
      patterns: event.patterns ?? [],
      metadata: event.metadata ?? {},
      input: event.input ?? null,
      tool: SUBAGENT_TOOL,
    },
    { cwd: ctx.runtimeCwd ?? ALLOWED_CWD, toolCategory: runtimeOf(state).toolCategory },
  );
  return applyPermissions(
    tracked,
    onAsk(
      tracked.permissions,
      {
        requestId: event.requestId,
        callId: event.callId,
        ask,
        // OpenCode spreads a reject to every other pending ask, so a start
        // the run cannot take is refused in turn, after the asks ahead of it.
        ...(refused?.kind === "reply" && refused.message !== null
          ? { refusal: refused.message }
          : {}),
      },
      {
        runActive: true,
        newRef: ctx.newId,
        blocked: secretTakesTurn(tracked),
        cascade: rejectSpreads(tracked),
      },
    ),
    null,
  );
}

/** What a subagent's secret ask is told: OnCue's tools are denied to subagents. */
const SUBAGENT_SECRET_REFUSAL =
  "A subagent cannot ask for a secret. Report what you need to the agent that started you.";

/**
 * Whose conversation an event names, while a run is active: the primary
 * agent's, a subagent the run tracks, or neither. Untagged events, and every
 * event while no run is active or before its conversation is known, are the
 * primary agent's.
 */
function conversationRoute(
  state: AgentState,
  sessionId: string | undefined,
):
  | { readonly kind: "root" }
  | { readonly kind: "child"; readonly agent: TrackedSubagent }
  | { readonly kind: "foreign" } {
  const run = state.run;
  if (run.kind !== "active") {
    return { kind: "root" };
  }
  const route = routeOf(run.subagents, run.conversation, sessionId);
  if (route.kind !== "child") {
    return route;
  }
  const agent = run.subagents.agents.find((entry) => entry.agentId === route.agentId);
  return agent === undefined ? { kind: "foreign" } : { kind: "child", agent };
}

/** The primary agent's own event: the run lifecycle, driven by the normalizer's signal. */
function stepRootEvent(state: AgentState, event: RuntimeEvent, ctx: StepContext): StepOutcome {
  const run = state.run;
  if (run.kind !== "active") {
    return outcome(state);
  }
  const advanced = advance(run.normalizer, event, {
    nowMs: ctx.nowMs,
    newId: ctx.newId,
    runId: run.runId,
    contextWindow: run.contextWindow,
    compactsAt: compactsAtOf(state),
    runtime: runtimeOf(state),
  });
  const effects: AgentEffect[] = advanced.drafts.map(emit);
  const next: ActiveRun = { ...run, normalizer: advanced.state };
  const signal = advanced.signal;
  if (
    (next.phase === "diffing" || next.phase === "verifying" || next.verification !== null) &&
    (signal.kind === "idle" || signal.kind === "error" || signal.kind === "model_failure")
  ) {
    return outcome({ ...state, run: { kind: "active", ...next } }, ...effects);
  }
  switch (signal.kind) {
    case "none":
      return outcome({ ...state, run: { kind: "active", ...next } }, ...effects);
    case "diff_changed": {
      const asked = requestRebuild({ ...state, run: { kind: "active", ...next } }, ctx);
      return outcome(asked.state, ...effects, ...asked.effects);
    }
    case "assistant_text":
      return outcome(
        { ...state, run: { kind: "active", ...next, lastAssistantText: signal.text } },
        ...effects,
      );
    case "tool_settled": {
      const counted: AgentState = {
        ...state,
        run: { kind: "active", ...next, toolsRun: next.toolsRun + 1 },
      };
      if (signal.overflow === null) {
        return outcome(counted, ...effects);
      }
      const staged = stageToolOverflow(counted, next, signal.overflow, ctx);
      return outcome(staged.state, ...effects, ...staged.effects);
    }
    case "idle": {
      if (next.phase === "prompting") {
        return outcome(
          { ...state, run: { kind: "active", ...next } },
          ...effects,
          log(`${runtimeOf(state).id} idle before the prompt was held; ignored`),
        );
      }
      if (next.phase === "running") {
        const ending = endRun(state, next, ctx);
        return outcome(ending.state, ...effects, ...ending.effects);
      }
      const released = releasePending(finishRun(state, next), ctx);
      return outcome(released.state, ...effects, ...released.effects);
    }
    case "error": {
      if (next.phase === "winding_down") {
        return outcome(
          { ...state, run: { kind: "active", ...next } },
          ...effects,
          ...(signal.name === "MessageAbortedError"
            ? []
            : [log(`${runtimeOf(state).id} error while winding down: ${signal.name}`)]),
        );
      }
      return outcome(
        finishRun(state, next),
        ...effects,
        emit(runFailedDraft(next, state.workspace, ctx.nowMs, signal.name, signal.message)),
      );
    }
    case "model_failure": {
      if (next.phase !== "running") {
        return outcome({ ...state, run: { kind: "active", ...next } }, ...effects);
      }
      const paused = pauseForModelFailure(
        { ...state, run: { kind: "active", ...next } },
        next,
        signal.failure,
      );
      return outcome(paused.state, ...effects, ...paused.effects);
    }
  }
}

function stepRuntimeExited(state: AgentState, code: number | null, ctx: StepContext): StepOutcome {
  const effects: AgentEffect[] = [
    emit(
      draft("runtime.disconnected", null, {
        reason: state.stopping
          ? "shutdown_requested"
          : code === 0
            ? "runtime_exited"
            : "runtime_crashed",
        detail: summaryText(
          code === null
            ? `${runtimeOf(state).id} was stopped by a signal`
            : `${runtimeOf(state).id} exited with code ${code}`,
        ),
        exitCode: code,
        diagnostics: [],
        expectReconnect: false,
      }),
    ),
  ];
  let next: AgentState = { ...state, runtime: { kind: "exited", code }, pendingStart: null };
  if (state.pendingStart !== null && state.run.kind !== "active") {
    // A start held for its secrets or for a wind-down that never came: the
    // object accepted it, so its end is said rather than dropped.
    effects.push(
      emit(
        draft("run.failed", state.pendingStart.runId, {
          stage: "provisioning",
          error: {
            category: "runtime_exited",
            message: "The agent runtime exited before the run could be prompted.",
          },
          summary: null,
          evidence: [],
          branch: null,
          pullRequestNumber: null,
          usage: null,
          durationMs: 0,
        } as PayloadOf<"run.failed">),
      ),
    );
  }
  const run = state.run;
  // Diffs and checks run without the runtime, so the run carries on and ends itself.
  if (run.kind === "active" && run.verification === null && run.phase !== "diffing") {
    if (run.phase !== "winding_down") {
      effects.push(
        emit(
          runFailedDraft(
            run,
            state.workspace,
            ctx.nowMs,
            "runtime_exited",
            "the agent runtime exited",
          ),
        ),
      );
    }
    next = finishRun(next, run);
  }
  effects.push(...closeLinkIfDone(next));
  return outcome(next, ...effects);
}

/** The runtime went idle: the tree is measured first so the diffs describe what verification checks. */
function endRun(state: AgentState, run: ActiveRun, ctx: StepContext): StepOutcome {
  const refs = diffRefsOf(state);
  if (refs === null) {
    // No repository: nothing changed and nothing to check (record 14). A
    // checks-only run still asks, and is told none were declared.
    return run.checksOnly
      ? beginVerification(state, run, headShaOf(state.workspace), ctx)
      : endDone(state, run, ctx);
  }
  return outcome(
    { ...state, run: { kind: "active", ...run, phase: "diffing" } },
    {
      kind: "build_diffs",
      runId: run.runId,
      purpose: "run_end",
      refs,
      turnBaseSha: run.turnBaseSha,
    },
  );
}

/**
 * The run-end build settled. Its facts are emitted even for a wound-down run,
 * since they describe the tree, not the outcome.
 */
function stepRunEndDiffs(
  state: AgentState,
  runId: string,
  build: DiffBuild,
  ctx: StepContext,
): StepOutcome {
  const run = state.run;
  if (
    run.kind !== "active" ||
    run.runId !== runId ||
    (run.phase !== "diffing" && run.phase !== "winding_down") ||
    run.verification !== null
  ) {
    return outcome(state, log("run-end diffs settled for a run that is not measuring them"));
  }
  const effects: AgentEffect[] = [];
  let next: AgentState = state;
  let revision = headShaOf(state.workspace);
  if (build.kind === "failed") {
    effects.push(log(`run-end snapshot failed: ${build.detail}`));
  } else {
    revision = build.headSha;
    if (build.status !== null) {
      effects.push(emit(repositoryStatusDraft(runId, build.status)));
    }
    const declared = new Map<string, DiffBody>();
    if (build.turn !== null && build.turn.files.length > 0) {
      const turn = emitDiff(next, runId, "turn", build.turn, declared, ctx);
      next = turn.state;
      effects.push(...turn.effects);
    }
    if (build.session !== null) {
      const session = emitDiff(next, runId, "session", build.session, declared, ctx);
      next = { ...session.state, lastSessionDiff: diffKey(build.session) };
      effects.push(...session.effects);
    }
  }
  if (run.phase === "winding_down") {
    const released = releasePending(finishRun(next, run), ctx);
    return outcome(released.state, ...effects, ...released.effects);
  }
  if (changedNoFiles(build, run)) {
    const done = endDone(next, run, ctx);
    return outcome(done.state, ...effects, ...done.effects);
  }
  const verifying = beginVerification(next, run, revision, ctx);
  return outcome(verifying.state, ...effects, ...verifying.effects);
}

/**
 * Only a measured turn with no files "changed nothing" (record 14). Anything
 * unmeasured verifies, because not knowing is not the same as no change.
 */
export function changedNoFiles(build: DiffBuild, run: ActiveRun): boolean {
  return (
    !run.checksOnly &&
    build.kind === "built" &&
    build.turn !== null &&
    build.turn.files.length === 0
  );
}

/** The run ends Done: its terminal event, and the pending start if one is waiting. */
function endDone(state: AgentState, run: ActiveRun, ctx: StepContext): StepOutcome {
  const released = releasePending(finishRun(state, run, "none", "done"), ctx);
  return outcome(
    released.state,
    emit(runCompletedDraft(run, state.workspace, ctx.nowMs)),
    ...released.effects,
  );
}

/** A mid-run rebuild settled: the session's diff goes out if it says something new, and a rebuild asked for meanwhile is asked for again. */
function stepMidRunDiffs(
  state: AgentState,
  runId: string,
  build: DiffBuild,
  ctx: StepContext,
): StepOutcome {
  let next: AgentState = { ...state, diffRebuild: { ...state.diffRebuild, inFlight: false } };
  const effects: AgentEffect[] = [];
  const run = next.run;
  const current =
    run.kind === "active" &&
    run.runId === runId &&
    (run.phase === "running" || run.phase === "diffing");
  if (build.kind === "failed") {
    effects.push(log(`mid-run snapshot failed: ${build.detail}`));
  } else if (current && build.session !== null) {
    const reported = emitSessionDiffIfNew(next, runId, build.session, ctx);
    next = reported.state;
    effects.push(...reported.effects);
  }
  if (next.diffRebuild.wanted) {
    const asked = requestRebuild(
      { ...next, diffRebuild: { ...next.diffRebuild, wanted: false } },
      ctx,
    );
    return outcome(asked.state, ...effects, ...asked.effects);
  }
  return outcome(next, ...effects);
}

/** At most one mid-run rebuild in flight and one per interval; a request in between is remembered. */
function requestRebuild(state: AgentState, ctx: StepContext): StepOutcome {
  const run = state.run;
  const refs = diffRefsOf(state);
  const rebuild = state.diffRebuild;
  if (run.kind !== "active" || run.phase !== "running" || refs === null) {
    return outcome({ ...state, diffRebuild: { ...rebuild, wanted: false } });
  }
  if (rebuild.inFlight || rebuild.timerArmed) {
    return outcome({ ...state, diffRebuild: { ...rebuild, wanted: true } });
  }
  const sinceLast =
    rebuild.lastStartedAtMs === null
      ? Number.POSITIVE_INFINITY
      : ctx.nowMs - rebuild.lastStartedAtMs;
  if (sinceLast < DIFF_REBUILD_INTERVAL_MS) {
    return outcome(
      { ...state, diffRebuild: { ...rebuild, timerArmed: true, wanted: false } },
      { kind: "diff_rebuild_timer", afterMs: DIFF_REBUILD_INTERVAL_MS - sinceLast },
    );
  }
  return outcome(
    {
      ...state,
      diffRebuild: { lastStartedAtMs: ctx.nowMs, inFlight: true, wanted: false, timerArmed: false },
    },
    { kind: "build_diffs", runId: run.runId, purpose: "mid_run", refs, turnBaseSha: null },
  );
}

function emitSessionDiffIfNew(
  state: AgentState,
  runId: string,
  report: DiffReport,
  ctx: StepContext,
): { readonly state: AgentState; readonly effects: readonly AgentEffect[] } {
  const key = diffKey(report);
  if (key === state.lastSessionDiff) {
    return { state, effects: [] };
  }
  const emitted = emitDiff(state, runId, "session", report, new Map(), ctx);
  return { state: { ...emitted.state, lastSessionDiff: key }, effects: emitted.effects };
}

/**
 * One `diff.updated`. A held patch is declared as a `diff` artifact first; with
 * no room for another upload the inline cut travels instead.
 */
type TreeArtifact = NonNullable<Parameters<typeof diffUpdatedDraft>[4]>;

/** The tree listing's content type: one path per line, UTF-8. */
export const TREE_CONTENT_TYPE = "text/plain; charset=utf-8";
const TREE_ARTIFACT_LABEL = "tree.txt";

/**
 * The tree listing for the review's file tree: reused while the tree is
 * unchanged, else declared as a new artifact. None when there is no room.
 */
function treeArtifactFor(
  state: AgentState,
  runId: string,
  report: DiffReport,
  ctx: StepContext,
): {
  readonly state: AgentState;
  readonly tree: TreeArtifact | null;
  readonly effects: readonly AgentEffect[];
} {
  if (report.paths.length === 0) {
    return { state, tree: null, effects: [] };
  }
  if (state.lastTree !== null && state.lastTree.digest === report.treeDigest) {
    return { state, tree: state.lastTree.artifact, effects: [] };
  }
  const text = report.paths.join("\n");
  const byteSize = Buffer.byteLength(text, "utf8");
  if (state.uploads.length >= UPLOADS_LIMIT || byteSize > MAX_ARTIFACT_BYTES) {
    return { state, tree: null, effects: [] };
  }
  const artifactId = ctx.newId();
  const artifact: TreeArtifact = {
    artifactId,
    kind: "file",
    contentType: TREE_CONTENT_TYPE,
    byteSize,
    label: TREE_ARTIFACT_LABEL,
  };
  return {
    state: {
      ...state,
      uploads: [...state.uploads, { artifactId, purpose: "tree" }],
      lastTree: { digest: report.treeDigest, artifact },
    },
    tree: artifact,
    effects: [
      emit(
        draft("artifact.uploading", runId, {
          artifactId,
          kind: "file",
          contentType: TREE_CONTENT_TYPE,
          declaredBytes: byteSize,
          producer: "agent",
        }),
      ),
      { kind: "stage_upload", artifactId, source: { kind: "text", text } },
      { kind: "upload_deadline", artifactId, afterMs: LOG_GRANT_WAIT_MS },
    ],
  };
}

function emitDiff(
  state0: AgentState,
  runId: string,
  scope: DiffScope,
  report: DiffReport,
  declared: Map<string, DiffBody>,
  ctx: StepContext,
): { readonly state: AgentState; readonly effects: readonly AgentEffect[] } {
  const listed = treeArtifactFor(state0, runId, report, ctx);
  const state = listed.state;
  const tree = listed.tree;
  const before = listed.effects;
  const patch = report.patch;
  if (patch.kind === "inline") {
    return {
      state,
      effects: [
        ...before,
        emit(diffUpdatedDraft(runId, scope, report, { kind: "inline", patch: patch.text }, tree)),
      ],
    };
  }
  const reused = declared.get(report.digest);
  if (reused !== undefined) {
    return {
      state,
      effects: [...before, emit(diffUpdatedDraft(runId, scope, report, reused, tree))],
    };
  }
  if (state.uploads.length >= UPLOADS_LIMIT || patch.byteSize > MAX_ARTIFACT_BYTES) {
    return {
      state,
      effects: [
        ...before,
        log(`${scope} diff patch not offered as an artifact; its inline cut travels`),
        emit(diffUpdatedDraft(runId, scope, report, { kind: "inline", patch: patch.cut }, tree)),
      ],
    };
  }
  const artifactId = ctx.newId();
  const body: DiffBody = {
    kind: "artifact",
    artifact: {
      artifactId,
      kind: "diff",
      contentType: DIFF_CONTENT_TYPE,
      byteSize: patch.byteSize,
      label: DIFF_ARTIFACT_LABELS[scope],
    },
  };
  declared.set(report.digest, body);
  return {
    state: { ...state, uploads: [...state.uploads, { artifactId, purpose: "diff" }] },
    effects: [
      ...before,
      emit(
        draft("artifact.uploading", runId, {
          artifactId,
          kind: "diff",
          contentType: DIFF_CONTENT_TYPE,
          declaredBytes: patch.byteSize,
          producer: "agent",
        }),
      ),
      { kind: "stage_upload", artifactId, source: { kind: "diff", digest: report.digest } },
      { kind: "upload_deadline", artifactId, afterMs: LOG_GRANT_WAIT_MS },
      emit(diffUpdatedDraft(runId, scope, report, body, tree)),
    ],
  };
}

/**
 * The checks the repository resolved run now, against `revision`. None
 * resolved ends the run at once with warnings saying no checks were declared.
 */
function beginVerification(
  state: AgentState,
  run: ActiveRun,
  revision: string,
  ctx: StepContext,
): StepOutcome {
  const workspace = state.workspace;
  const ready = workspace.kind === "ready";
  const started = startVerification(
    {
      facts: {
        runId: run.runId,
        ...runFacts(run),
        branch: ready ? (workspace.taskBranch ?? workspace.branch) : null,
        startedAtMs: run.startedAtMs,
      },
      checks: planChecks(ready ? state.project : null, ready ? state.install : null, ctx.newId),
      revision,
      baseRevision: ready ? workspace.baseSha : null,
      skipRequired: run.skipRequiredChecks,
    },
    { nowMs: ctx.nowMs, newId: ctx.newId },
  );
  return settleVerification(
    state,
    { ...run, phase: "verifying", verification: started.state },
    started.effects,
    ctx,
  );
}

/** A cancel, a shutdown, or a checkpoint while verifying: signal the running check and let it settle. */
function cancelVerification(run: ActiveRun & { readonly kind: "active" }): {
  readonly run: RunSlot;
  readonly effects: readonly AgentEffect[];
} {
  if (run.verification === null) {
    return { run: { ...run, phase: "winding_down", windDown: "cancelled_by_object" }, effects: [] };
  }
  const cancelled = stepVerify(run.verification, { kind: "cancel" }, { nowMs: 0, newId: () => "" });
  const wound: ActiveRun = {
    ...run,
    phase: "winding_down",
    windDown: "cancelled_by_object",
    verification: cancelled.state,
  };
  return {
    run: { kind: "active", ...wound },
    effects: mapVerifyEffects(run.runId, cancelled.effects).effects,
  };
}

function stepVerification(
  state: AgentState,
  runId: string,
  input: VerifyInput,
  ctx: StepContext,
): StepOutcome {
  const run = state.run;
  if (run.kind !== "active" || run.runId !== runId || run.verification === null) {
    return outcome(state, log(`verification ${input.kind} for a run that is not verifying`));
  }
  const stepped = stepVerify(run.verification, input, { nowMs: ctx.nowMs, newId: ctx.newId });
  return settleVerification(state, { ...run, verification: stepped.state }, stepped.effects, ctx);
}

/** Apply verification's effects; when it is done, the run ends and a held `run.start` goes next. */
function settleVerification(
  state: AgentState,
  run: ActiveRun,
  verifyEffects: readonly VerifyEffect[],
  ctx: StepContext,
): StepOutcome {
  const mapped = mapVerifyEffects(run.runId, verifyEffects);
  const uploads = [...state.uploads, ...mapped.uploads];
  if (run.verification !== null && isDone(run.verification)) {
    const released = releasePending(
      finishRun(
        { ...state, uploads },
        run,
        verificationOf(mapped.effects, run.verification.records.length),
      ),
      ctx,
    );
    return outcome(released.state, ...mapped.effects, ...released.effects);
  }
  return outcome({ ...state, uploads, run: { kind: "active", ...run } }, ...mapped.effects);
}

function mapVerifyEffects(
  runId: string,
  effects: readonly VerifyEffect[],
): { readonly effects: readonly AgentEffect[]; readonly uploads: readonly PendingUpload[] } {
  const mapped: AgentEffect[] = [];
  const uploads: PendingUpload[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "emit":
        mapped.push(emit(effect.draft));
        break;
      case "run_check":
        mapped.push({
          kind: "run_check",
          runId,
          checkRunId: effect.checkRunId,
          command: effect.command,
          where: effect.where,
          timeoutMs: effect.timeoutMs,
        });
        break;
      case "signal_check":
        mapped.push(effect);
        break;
      case "prepare_base":
        mapped.push({ kind: "prepare_base", runId, dir: effect.dir, baseSha: effect.baseSha });
        break;
      case "stage_log":
        uploads.push({ artifactId: effect.artifactId, purpose: "verification_log" });
        mapped.push(
          {
            kind: "stage_upload",
            artifactId: effect.artifactId,
            source: { kind: "check_log", checkRunId: effect.checkRunId },
          },
          { kind: "upload_deadline", artifactId: effect.artifactId, afterMs: LOG_GRANT_WAIT_MS },
        );
        break;
    }
  }
  return { effects: mapped, uploads };
}

/** For the interpreter's tests and one diagnostic line. Never contains a credential, by construction of `AgentState`. */
export type AgentSnapshot = AgentState;

/** Type-level check that no state field is named `token`. */
export type _NoTokenInState = Extract<keyof AgentState, "token"> extends never ? true : never;
export const _noTokenInState: _NoTokenInState = true;

export type ToolFailureCategory = PayloadOf<"tool.failed">["category"];
