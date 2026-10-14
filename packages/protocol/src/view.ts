import type { EphemeralEventType } from "./catalog";
import {
  assertNever,
  type CommittedEvent,
  type CommittedEventOf,
  type PayloadOf,
  type ProtocolEventOf,
} from "./events";
import {
  type AgentId,
  type ApprovalId,
  type ArtifactId,
  type ArtifactRef,
  type CheckId,
  type CheckpointId,
  type CommandId,
  type FileChange,
  type InlineJson,
  LIMITS,
  type MessageId,
  type ModelRecord,
  type PlanId,
  type PushId,
  type QuestionId,
  type ReviewItemId,
  type RunId,
  type SessionId,
  type Timestamp,
  type TokenUsage,
  type ToolCallId,
  type UntrustedText,
} from "./schema";
import {
  type ApprovalState,
  canTransition,
  type PlanState,
  type RunOutcome,
  type RunState,
  type SandboxState,
  type VerificationCheckState,
} from "./states";

// Folds record 04's event stream into the state the timeline renders. The
// session object uses the same fold for admission and approval checks, so the
// two cannot drift. The timeline holds order; the maps hold state, so a late
// event touches one map entry and never scans the timeline.

export type MessagePart = PayloadOf<"message.completed">["parts"][number];
export type MessageRole = "user" | PayloadOf<"message.started">["role"];
export type StopReason = PayloadOf<"message.completed">["stopReason"];
export type ToolCategory = PayloadOf<"tool.requested">["category"];
export type ToolResult = PayloadOf<"tool.completed">["result"];
export type ToolFailureCategory = PayloadOf<"tool.failed">["category"];
export type PlanStep = PayloadOf<"plan.created">["steps"][number];
export type PlanStepStatus = PlanStep["status"];
export type SessionPolicy = PayloadOf<"policy.updated">["to"];
export type VerificationMethod = PayloadOf<"verification.started">["method"];
export type CheckClassification = PayloadOf<"verification.started">["classification"];
export type CheckSource = PayloadOf<"verification.started">["source"];
export type PullRequestState = PayloadOf<"pull_request.state_changed">["to"];
export type ReviewActionState = PayloadOf<"review.updated">["actionState"];
export type ProgressPhase = PayloadOf<"status.updated">["phase"];
export type CommandType = PayloadOf<"command.acknowledged">["commandType"];
export type ArtifactProducer = PayloadOf<"artifact.uploading">["producer"];
export type ArtifactKind = ArtifactRef["kind"];
export type SandboxProvider = PayloadOf<"sandbox.provisioning">["provider"];

/**
 * The `runtimeName` and `runtimeVersion` a bridge reports when it has no agent
 * runtime; shared so the writer and the fold spell it the same way.
 */
export const NO_RUNTIME = "none";

export type RunTransition = "started" | "paused" | "interrupted" | RunOutcome;
export type PlanChange = "created" | "revised" | "completed" | "blocked" | "cancelled";
export type ApprovalChange = "requested" | "resolved" | "expired";
export type PushChange = "requested" | "completed" | "failed";
export type PullRequestChange = "created" | "updated" | "state_changed";
export type ReviewChange = "imported" | "addressed";

export type TimelineItem = { readonly sequence: number } & (
  | { readonly kind: "message"; readonly messageId: MessageId }
  | { readonly kind: "progress"; readonly stepId: string }
  | { readonly kind: "plan"; readonly planId: PlanId; readonly change: PlanChange }
  | { readonly kind: "tool"; readonly toolCallId: ToolCallId }
  | { readonly kind: "approval"; readonly approvalId: ApprovalId; readonly change: ApprovalChange }
  | { readonly kind: "secrets" }
  /** Whether a launch's selection reached the sandbox. An approval's delivery shows on its own card. */
  | {
      readonly kind: "secrets_supplied";
      readonly names: readonly string[];
      readonly delivered: boolean;
    }
  | { readonly kind: "check"; readonly checkId: CheckId }
  | { readonly kind: "verification"; readonly runId: RunId }
  | { readonly kind: "changes"; readonly runId: RunId }
  | { readonly kind: "commit"; readonly sha: string }
  | { readonly kind: "push"; readonly pushId: PushId; readonly change: PushChange }
  | { readonly kind: "pull_request"; readonly number: number; readonly change: PullRequestChange }
  /** One policy event. Its detail is `view.policy.changes`' entry with the same sequence. */
  | { readonly kind: "policy"; readonly change: PolicyChangeView["kind"] }
  | { readonly kind: "artifact"; readonly artifactId: ArtifactId }
  | { readonly kind: "review"; readonly reviewItemId: ReviewItemId; readonly change: ReviewChange }
  | {
      readonly kind: "run";
      readonly runId: RunId;
      readonly transition: RunTransition;
      /**
       * Why the run paused, on a `paused` row only. A run can pause more than
       * once and `RunView.pause` holds only the latest, so each row keeps its own.
       */
      readonly pause?: PayloadOf<"run.paused">;
    }
  | { readonly kind: "sandbox"; readonly generation: number }
  /** One row per question asked; it reads the question's state, open or settled. */
  | { readonly kind: "question"; readonly questionId: QuestionId }
);

export type RunEnding =
  | ({ readonly outcome: "verified" } & PayloadOf<"run.verified">)
  | ({ readonly outcome: "completed_with_warnings" } & PayloadOf<"run.completed_with_warnings">)
  | ({ readonly outcome: "completed" } & PayloadOf<"run.completed">)
  | ({ readonly outcome: "blocked" } & PayloadOf<"run.blocked">)
  | ({ readonly outcome: "failed" } & PayloadOf<"run.failed">)
  | ({ readonly outcome: "cancelled" } & PayloadOf<"run.cancelled">);

export type RunView = {
  readonly runId: RunId;
  readonly state: RunState;
  readonly outcome: RunOutcome | null;
  readonly trigger: PayloadOf<"run.queued">["trigger"] | null;
  readonly instructionMessageId: MessageId | null;
  readonly model: ModelRecord | null;
  readonly continuesRunId: RunId | null;
  readonly queuedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly endedAt: Timestamp | null;
  readonly branch: string | null;
  readonly baseSha: string | null;
  readonly resumedFrom: CheckpointId | null;
  readonly pause: PayloadOf<"run.paused"> | null;
  readonly interruption: PayloadOf<"run.interrupted"> | null;
  readonly ending: RunEnding | null;
  readonly sandboxGeneration: number;
};

export type MessageView = {
  readonly messageId: MessageId;
  readonly runId: RunId | null;
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly streaming: boolean;
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage | null;
  readonly delivery: PayloadOf<"message.queued">["delivery"] | null;
  readonly at: Timestamp;
  /** Set on a subagent's message (record 12); absent on the primary agent's and the user's. */
  readonly agentId?: AgentId;
};

export type ProgressStepView = {
  readonly stepId: string;
  readonly runId: RunId;
  readonly phase: ProgressPhase;
  readonly label: string;
  readonly description: string | null;
  readonly status: "active" | "complete";
  readonly at: Timestamp;
};

export type ChainStatus = "pending" | "active" | "complete";

export type PlanStepView = PlanStep & { readonly chainStatus: ChainStatus };

export type PlanView = {
  readonly planId: PlanId;
  readonly runId: RunId;
  readonly revision: number;
  readonly state: PlanState;
  readonly title: string;
  readonly description: string | null;
  readonly steps: readonly PlanStepView[];
  readonly activeStepId: string | null;
  readonly expectedVerification: readonly string[];
  readonly changeSummary: string | null;
  readonly completionSummary: string | null;
  readonly blockedQuestion: string | null;
  readonly cancelReason: PayloadOf<"plan.cancelled">["reason"] | null;
  readonly updatedAt: Timestamp;
};

// AI Elements' Tool component switches on these seven values.
export type ToolUiState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ToolFailure = {
  readonly errorText: string;
  readonly category: ToolFailureCategory;
  readonly evidence: readonly ArtifactRef[];
};

export type ToolApproval = {
  readonly approvalId: ApprovalId;
  readonly state: ApprovalState;
  readonly decision: "approved" | "rejected" | null;
  readonly decidedBy: string | null;
};

export type ToolOutputChunk = {
  readonly chunkIndex: number;
  readonly stream: PayloadOf<"tool.output">["stream"];
  readonly text: string;
};

export type ToolView = {
  readonly toolCallId: ToolCallId;
  readonly runId: RunId;
  readonly state: ToolUiState;
  readonly category: ToolCategory;
  readonly title: string;
  readonly runtimeName: string;
  readonly input: InlineJson;
  readonly inputComplete: boolean;
  readonly approval: ToolApproval | null;
  readonly requestedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly result: ToolResult | null;
  readonly failure: ToolFailure | null;
  // The last chunks this client saw, newest last, within the caps below.
  readonly output: readonly ToolOutputChunk[];
  // True when `output` is not everything the call printed, so the panel says
  // output is missing instead of drawing an empty box.
  readonly outputDropped: boolean;
  /** Set on a subagent's call (record 12); absent on the primary agent's. */
  readonly agentId?: AgentId;
};

// Shared by tool calls and sandbox rows. `requested` is separate from
// `running` because a call awaiting approval can wait indefinitely.
export type ActionState = "requested" | "running" | "completed" | "failed";

// One step per event the sandbox row can rest on. `runtime.disconnected`
// splits three ways by its fields: reconnecting, requested shutdown, or lost.
export type SandboxActionStep =
  | "requested"
  | "provisioning"
  | "attached"
  | "connected"
  | "ready"
  | "idle"
  | "checkpointed"
  | "reconnecting"
  | "disconnected"
  | "lost"
  // `states.ts` allows attached|active|idle -> replaced directly, so no
  // `sandbox.stopped` follows a replacement; this step settles the row.
  | "replaced"
  | "stopped"
  | "failed";

/**
 * The sandbox and runtime lifecycle of one generation, as a single row that
 * updates in place. Not a `ToolView`: these events are correlated by
 * generation and carry no `toolCallId`, though they render with the same row
 * component.
 */
export type SandboxActionView = {
  readonly generation: number;
  readonly step: SandboxActionStep;
  readonly state: ActionState;
  readonly provider: SandboxProvider | null;
  readonly label: string;
  readonly detail: string | null;
  // The event's own prose, where it carries any: `sandbox.replaced`'s
  // explanation, `runtime.disconnected`'s detail, an unsaved-work warning.
  readonly explanation: string | null;
  readonly durationMs: number | null;
  readonly at: Timestamp;
  readonly updatedAt: Timestamp;
  // Every step this generation has been through, in order, so an expanded
  // row can show the sequence rather than only where it sits now.
  readonly steps: readonly SandboxStepView[];
  // What the sandbox printed, relayed by the control plane. Untrusted: it
  // never sets `step` or `state`. Bounded to `SANDBOX_OUTPUT_TAIL_LINES`.
  readonly output: readonly SandboxOutputLine[];
  readonly providerSandboxId: string | null;
  // When the sandbox began running and when it ended, for a duration that
  // ticks while it runs and freezes once it stops.
  readonly runningSince: Timestamp | null;
  readonly endedAt: Timestamp | null;
};

export type SandboxStepView = {
  readonly step: SandboxActionStep;
  readonly label: string;
  readonly detail: string | null;
  readonly at: Timestamp;
};

export type SandboxOutputLine = {
  readonly stream: PayloadOf<"sandbox.output">["stream"];
  readonly at: Timestamp;
  readonly text: string;
};

export const SANDBOX_OUTPUT_TAIL_LINES = 500;

/** The steps at which a generation has ended, for `endedAt`. */
const SANDBOX_ENDED_STEPS: ReadonlySet<SandboxActionStep> = new Set([
  "stopped",
  "failed",
  "replaced",
  "lost",
  "disconnected",
]);

export type ApprovalView = {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly state: ApprovalState;
  readonly title: string;
  readonly intendedAction: string;
  readonly category: PayloadOf<"approval.requested">["category"];
  readonly risk: PayloadOf<"approval.requested">["risk"];
  readonly resource: string;
  readonly requestedScope: string;
  readonly expiresAt: Timestamp;
  readonly toolCallId: ToolCallId | null;
  /** The kind of tool behind a permission ask, for the card's verb; null for secrets and older events. */
  readonly toolCategory: ToolCategory | null;
  /** The subagent whose call asked; absent for the primary agent's asks and older events. */
  readonly agentId?: AgentId;
  readonly requestedAt: Timestamp;
  readonly resolution: {
    readonly decision: "approved" | "rejected";
    readonly decidedBy: string;
    readonly commandId: CommandId;
    readonly decidedForGeneration: number;
    /** What the answer covers; `once` for older events and secrets. */
    readonly scope: PayloadOf<"approval.resolved">["scope"] & {};
    /** A saved choice answered, not a click on the card. */
    readonly automatic: boolean;
    readonly at: Timestamp;
  } | null;
  readonly expiredEffect: PayloadOf<"approval.expired">["effect"] | null;
  /**
   * Whether the value an approval released reached the sandbox: null until the
   * bridge answers the grant. Approved and supplied are different facts.
   */
  readonly delivered: boolean | null;
};

export type AskedQuestion = PayloadOf<"question.asked">["questions"][number];

/**
 * One ask of up to four questions (record 12). Open until the user answers or
 * dismisses it, or its run ends; the answers are what the agent was told.
 */
export type QuestionView = {
  readonly questionId: QuestionId;
  readonly runId: RunId;
  readonly toolCallId: ToolCallId | null;
  readonly questions: readonly AskedQuestion[];
  readonly state: "open" | "answered" | "dismissed";
  /** One entry per question, in order; empty is a skipped question. Null until answered. */
  readonly answers: readonly (readonly string[])[] | null;
  readonly dismissal: PayloadOf<"question.dismissed">["reason"] | null;
  readonly askedAt: Timestamp;
  readonly settledAt: Timestamp | null;
};

export type CheckAttemptView = {
  readonly attempt: number;
  readonly startedAt: Timestamp | null;
  readonly result: PayloadOf<"verification.result"> | null;
};

export type CheckView = {
  readonly checkId: CheckId;
  readonly runId: RunId;
  readonly name: string;
  readonly category: string | null;
  readonly classification: CheckClassification | null;
  readonly source: CheckSource | null;
  readonly method: VerificationMethod | null;
  readonly revision: string | null;
  readonly baseRevision: string | null;
  readonly status: VerificationCheckState;
  readonly attempts: readonly CheckAttemptView[];
  readonly latest: CheckAttemptView | null;
};

export type VerificationSummaryView = PayloadOf<"verification.completed"> & {
  readonly runId: RunId;
  readonly at: Timestamp;
};

export type VerificationView = {
  readonly checks: ReadonlyMap<CheckId, CheckView>;
  readonly summaries: ReadonlyMap<RunId, VerificationSummaryView>;
};

export type CommitView = {
  readonly hash: string;
  readonly parentSha: string | null;
  readonly branch: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorInitials: string;
  readonly authorType: PayloadOf<"git.committed">["authorType"];
  readonly date: Timestamp;
  readonly files: readonly FileChange[];
  readonly additions: number;
  readonly deletions: number;
  readonly verificationState: PayloadOf<"git.committed">["verificationState"];
  readonly policy: PayloadOf<"git.committed">["policy"];
};

export type PushView = {
  readonly pushId: PushId;
  readonly state: "requested" | "completed" | "failed";
  readonly branch: string;
  /** Null while a push is only requested: the bridge has not built its commit yet. */
  readonly headSha: string | null;
  readonly commitCount: number | null;
  readonly policy: PayloadOf<"git.push.requested">["policy"] | null;
  readonly remoteSha: string | null;
  readonly failure: {
    /** The bridge's category, or `branch_not_pushable` when the object withheld the push. */
    readonly category: PayloadOf<"git.push.failed">["category"] | "branch_not_pushable";
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly at: Timestamp;
};

export type PullRequestView = {
  readonly number: number;
  readonly url: string | null;
  readonly title: string | null;
  readonly state: PullRequestState;
  readonly baseBranch: string | null;
  readonly headBranch: string | null;
  readonly headSha: string | null;
  readonly verificationSectionVersion: number | null;
  readonly mergedSha: string | null;
  readonly lastActor: UntrustedText | null;
  readonly updatedAt: Timestamp;
};

export type CheckpointView = {
  readonly checkpointId: CheckpointId;
  readonly kind: PayloadOf<"repository.checkpointed">["kind"];
  readonly headSha: string | null;
  readonly bundle: ArtifactRef | null;
  readonly reason:
    | PayloadOf<"repository.checkpointed">["reason"]
    | PayloadOf<"sandbox.checkpointed">["reason"];
  readonly at: Timestamp;
};

export type DiffView = PayloadOf<"diff.updated"> & { readonly at: Timestamp };

export type GitView = {
  readonly branch: string | null;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: ReadonlyMap<string, FileChange>;
  readonly commits: readonly CommitView[];
  /** The latest `turn` diff each run reported. */
  readonly turnDiffs: ReadonlyMap<RunId, DiffView>;
  /** The latest `session` diff: everything since the session's recorded base. */
  readonly sessionDiff: DiffView | null;
  readonly checkpoint: CheckpointView | null;
  readonly pushes: ReadonlyMap<PushId, PushView>;
  readonly pullRequest: PullRequestView | null;
  /**
   * What the agent said the pull request and its branch should be called,
   * the latest value of each field across its `pull_request.described`
   * events, or null before it said anything.
   */
  readonly description: PullRequestDescription | null;
};

export type PullRequestDescription = {
  readonly title: string | null;
  readonly body: string | null;
  readonly branchName: string | null;
};

export type RuntimeView = {
  readonly connected: boolean;
  readonly ready: boolean;
  readonly bridgeVersion: string;
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  readonly capabilities: readonly string[];
  readonly healthChecks: PayloadOf<"runtime.ready">["healthChecks"];
  readonly startupMs: number | null;
  readonly lastDisconnect: PayloadOf<"runtime.disconnected"> | null;
};

export type SandboxView = {
  readonly generation: number;
  readonly state: SandboxState | null;
  readonly provider: SandboxProvider | null;
  readonly providerSandboxId: string | null;
  readonly provisioning: Omit<PayloadOf<"sandbox.provisioning">, "provider"> | null;
  readonly expiresAt: Timestamp | null;
  readonly startupMs: number | null;
  readonly cacheFallback: boolean;
  readonly idleSince: Timestamp | null;
  readonly stopAt: Timestamp | null;
  readonly keepAlive: PayloadOf<"sandbox.keepalive.updated"> | null;
  readonly stop: PayloadOf<"sandbox.stopped"> | null;
  readonly replacement: PayloadOf<"sandbox.replaced"> | null;
  readonly runtime: RuntimeView | null;
};

/**
 * One policy event, as the timeline shows it. A `proposed` entry is the
 * confirmation card while `pendingProposal` still names its proposal, and a
 * plain line once it was confirmed, declined, or replaced.
 */
export type PolicyChangeView = { readonly sequence: number } & (
  | ({ readonly kind: "proposed" } & Pick<
      PayloadOf<"policy.proposed">,
      "proposalId" | "from" | "to" | "direction" | "rationale"
    >)
  | ({ readonly kind: "updated" } & Pick<
      PayloadOf<"policy.updated">,
      "proposalId" | "from" | "to" | "confirmedBy"
    >)
  | { readonly kind: "declined"; readonly proposalId: PayloadOf<"policy.declined">["proposalId"] }
);

export type PolicyView = {
  readonly current: SessionPolicy | null;
  readonly pendingProposal: (PayloadOf<"policy.proposed"> & { readonly at: Timestamp }) | null;
  readonly lastUpdate: PayloadOf<"policy.updated"> | null;
  /** Every policy event in order. Small: a run admits at most five proposals. */
  readonly changes: readonly PolicyChangeView[];
};

export type ReviewItemView = {
  readonly reviewItemId: ReviewItemId;
  readonly actionState: ReviewActionState;
  readonly githubId: string;
  readonly pullRequestNumber: number;
  readonly author: UntrustedText;
  readonly authorType: PayloadOf<"review.imported">["authorType"];
  readonly body: UntrustedText;
  readonly sourceType: PayloadOf<"review.imported">["sourceType"];
  readonly location: PayloadOf<"review.imported">["location"];
  readonly threadId: string | null;
  readonly parentId: string | null;
  readonly githubState: PayloadOf<"review.imported">["githubState"];
  readonly locationCurrent: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly addressed: PayloadOf<"review.addressed"> | null;
  readonly dismissal: { readonly userId: string; readonly reason: string | null } | null;
};

export type ReviewsView = {
  readonly items: ReadonlyMap<ReviewItemId, ReviewItemView>;
  readonly unresolvedCount: number;
};

export type ArtifactView = {
  readonly artifactId: ArtifactId;
  readonly state: "uploading" | "created" | "failed";
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly producer: ArtifactProducer;
  readonly declaredBytes: number | null;
  readonly ref: ArtifactRef | null;
  readonly checksum: PayloadOf<"artifact.created">["checksum"] | null;
  readonly classification: PayloadOf<"artifact.created">["classification"] | null;
  readonly expiresAt: Timestamp | null;
  readonly supersedes: ArtifactId | null;
  readonly failure: Omit<PayloadOf<"artifact.failed">, "artifactId"> | null;
  readonly at: Timestamp;
};

export type CommandView = {
  readonly commandId: CommandId;
  readonly commandType: CommandType;
  readonly state: "acknowledged" | "rejected";
  readonly acceptedBy: PayloadOf<"command.acknowledged">["acceptedBy"] | null;
  readonly rejection: Omit<PayloadOf<"command.rejected">, "commandId" | "commandType"> | null;
  readonly at: Timestamp;
};

export type LiveMessagePart = {
  readonly type: "text" | "reasoning_summary";
  readonly text: string;
};

export type LiveToolOutput = {
  readonly text: string;
  readonly streaming: boolean;
  readonly droppedBytes: number;
  readonly truncatedChars: number;
  readonly lastChunkIndex: number;
};

export type LiveHeartbeat = PayloadOf<"runtime.heartbeat"> & { readonly observedAt: Timestamp };

// Uncommitted state from ephemeral events. Never enters the timeline, never
// advances appliedThrough, and the next committed event for the same message
// or tool replaces it.
export type LiveView = {
  readonly messages: ReadonlyMap<MessageId, readonly LiveMessagePart[]>;
  readonly toolOutput: ReadonlyMap<ToolCallId, LiveToolOutput>;
  readonly heartbeat: LiveHeartbeat | null;
};

export type StreamView = {
  readonly pending: ReadonlyMap<number, CommittedEvent>;
  readonly awaiting: number | null;
};

/**
 * A subagent's state as the timeline shows it. `running` until its
 * `agent.completed`; `agentStatusOf` reads a running subagent as cancelled
 * once its run ended or its sandbox is gone, since either took it down.
 */
export type AgentStatus = "running" | PayloadOf<"agent.completed">["status"];

export type AgentView = {
  readonly agentId: AgentId;
  readonly runId: RunId;
  /** The sandbox it runs in. It never outlives that sandbox, though its run may be continued on a new one. */
  readonly sandboxGeneration: number;
  /** The primary agent's call that started it; null only while its `agent.started` has not been seen. */
  readonly parentToolCallId: ToolCallId | null;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly promptTruncated: boolean;
  readonly model: PayloadOf<"agent.started">["model"];
  readonly status: AgentStatus;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp | null;
  readonly usage: PayloadOf<"agent.completed">["usage"] | null;
  readonly resultSummary: string | null;
  /** Its own messages and tool calls, in order; they never enter the session's timeline. */
  readonly timeline: readonly TimelineItem[];
};

export type SessionView = {
  readonly sessionId: SessionId | null;
  readonly appliedThrough: number;
  readonly stream: StreamView;
  readonly run: RunView | null;
  readonly runs: ReadonlyMap<RunId, RunView>;
  readonly sandbox: SandboxView;
  readonly policy: PolicyView;
  /** What the launch disclosed (record 08): names only, null for a session that declared none. */
  readonly secrets: PayloadOf<"secrets.disclosed"> | null;
  /** The latest choice in this session's approval menu (record 09), or null when none was made here. */
  readonly approvalMode: PayloadOf<"approval.mode_changed">["mode"] | null;
  readonly timeline: readonly TimelineItem[];
  readonly messages: ReadonlyMap<MessageId, MessageView>;
  readonly progress: ReadonlyMap<string, ProgressStepView>;
  readonly tools: ReadonlyMap<ToolCallId, ToolView>;
  readonly sandboxActions: ReadonlyMap<number, SandboxActionView>;
  readonly plan: PlanView | null;
  readonly plans: ReadonlyMap<PlanId, PlanView>;
  readonly approvals: ReadonlyMap<ApprovalId, ApprovalView>;
  readonly openApprovalIds: readonly ApprovalId[];
  readonly questions: ReadonlyMap<QuestionId, QuestionView>;
  /** The question waiting on the user; at most one is open in a session. */
  readonly openQuestionId: QuestionId | null;
  readonly verification: VerificationView;
  readonly git: GitView;
  readonly reviews: ReviewsView;
  readonly artifacts: ReadonlyMap<ArtifactId, ArtifactView>;
  readonly commands: ReadonlyMap<CommandId, CommandView>;
  readonly agents: ReadonlyMap<AgentId, AgentView>;
  readonly live: LiveView;
};

export const EMPTY_SANDBOX: SandboxView = {
  generation: 0,
  state: null,
  provider: null,
  providerSandboxId: null,
  provisioning: null,
  expiresAt: null,
  startupMs: null,
  cacheFallback: false,
  idleSince: null,
  stopAt: null,
  keepAlive: null,
  stop: null,
  replacement: null,
  runtime: null,
};

export const EMPTY_GIT: GitView = {
  branch: null,
  baseSha: null,
  headSha: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  additions: 0,
  deletions: 0,
  changedFiles: new Map(),
  commits: [],
  turnDiffs: new Map(),
  sessionDiff: null,
  checkpoint: null,
  pushes: new Map(),
  pullRequest: null,
  description: null,
};

export function emptyView(): SessionView {
  return {
    sessionId: null,
    appliedThrough: 0,
    stream: { pending: new Map(), awaiting: null },
    run: null,
    runs: new Map(),
    sandbox: EMPTY_SANDBOX,
    policy: { current: null, pendingProposal: null, lastUpdate: null, changes: [] },
    secrets: null,
    approvalMode: null,
    timeline: [],
    messages: new Map(),
    progress: new Map(),
    tools: new Map(),
    sandboxActions: new Map(),
    plan: null,
    plans: new Map(),
    approvals: new Map(),
    openApprovalIds: [],
    questions: new Map(),
    openQuestionId: null,
    verification: { checks: new Map(), summaries: new Map() },
    git: EMPTY_GIT,
    reviews: { items: new Map(), unresolvedCount: 0 },
    artifacts: new Map(),
    commands: new Map(),
    agents: new Map(),
    live: { messages: new Map(), toolOutput: new Map(), heartbeat: null },
  };
}

export const LIVE_TERMINAL_CAP = LIMITS.inlineTextChars;

/**
 * The cap on the per-call output tail `ToolView` keeps. `tool.output` is
 * ephemeral, so a tab holds its tail for the whole session; both a count cap
 * and a character cap are needed because either alone is unbounded. The
 * character cap is half of `LIMITS.streamChunkChars`, and one oversized newest
 * chunk is kept anyway (see `tailWithinCaps`).
 */
export const TOOL_OUTPUT_TAIL_CHUNKS = 32;
export const TOOL_OUTPUT_TAIL_CHARS = LIMITS.streamChunkChars / 2;

const DENIAL_CATEGORIES: ReadonlySet<ToolFailureCategory> = new Set([
  "denied_by_policy",
  "approval_rejected",
  "approval_expired",
]);

const SANDBOX_ACTION_STATE: Record<SandboxActionStep, ActionState> = {
  requested: "requested",
  provisioning: "running",
  attached: "running",
  connected: "running",
  ready: "running",
  idle: "running",
  checkpointed: "running",
  reconnecting: "running",
  disconnected: "completed",
  lost: "failed",
  replaced: "completed",
  stopped: "completed",
  failed: "failed",
};

/**
 * Record 13: a row's label comes from the event's fields. Each table is a
 * `Record` over the event's closed picklist, so a new reason fails to compile.
 */
const PROVISIONING_LABEL: Record<PayloadOf<"sandbox.provisioning">["reason"], string> = {
  initial: "Starting a sandbox",
  resume: "Starting a sandbox to resume this session",
  replacement: "Starting a replacement sandbox",
  retry: "Retrying the sandbox start",
};

const CACHE_REUSE_DETAIL: Record<PayloadOf<"sandbox.provisioning">["cacheReuse"], string> = {
  base_image: "reusing the base image",
  repository_environment: "reusing the prepared repository environment",
  none: "building the environment from scratch",
};

const REPLACED_LABEL: Record<PayloadOf<"sandbox.replaced">["reason"], string> = {
  resume: "Replacing the sandbox to resume this session",
  lifetime_ceiling: "Replacing the sandbox at its lifetime ceiling",
  policy_change: "Replacing the sandbox after a policy change",
  failure: "Replacing the sandbox after a failure",
};

/**
 * Labels for the generation `sandbox.replaced` retires, in the past tense.
 * Without them the old generation would still read as running.
 */
const SUPERSEDED_LABEL: Record<PayloadOf<"sandbox.replaced">["reason"], string> = {
  resume: "Sandbox replaced to resume this session",
  lifetime_ceiling: "Sandbox replaced at its lifetime ceiling",
  policy_change: "Sandbox replaced after a policy change",
  failure: "Sandbox replaced after a failure",
};

/**
 * Only `failure` means the retired generation ended badly; the other reasons
 * retire a healthy sandbox on purpose.
 */
const SUPERSEDED_STEP: Record<PayloadOf<"sandbox.replaced">["reason"], SandboxActionStep> = {
  resume: "replaced",
  lifetime_ceiling: "replaced",
  policy_change: "replaced",
  failure: "failed",
};

const CHECKPOINT_LABEL: Record<PayloadOf<"sandbox.checkpointed">["kind"], string> = {
  branch_push: "Pushed the session's branch",
  local_commit: "Committed the work inside the sandbox",
  patch_bundle: "Saved the work as a patch bundle",
};

const CHECKPOINT_DETAIL: Record<PayloadOf<"sandbox.checkpointed">["reason"], string> = {
  idle: "because the sandbox went idle",
  user: "at your request",
  lifetime_ceiling: "before the sandbox reaches its lifetime ceiling",
  policy_change: "after a policy change",
  cancel: "before cancelling the run",
  pause: "before pausing the run",
};

/**
 * Why a checkpoint could not be taken, from the bridge's fixed category. Git's
 * own message is never sent because it could contain an agent-chosen path.
 * The session object's stop warning uses the same words.
 */
export const CHECKPOINT_FAILURE_TEXT: Record<
  PayloadOf<"sandbox.checkpoint_failed">["failure"],
  string
> = {
  read_tree_failed:
    "Git could not read the last saved checkpoint, so nothing since it was saved, pushed, or bundled.",
  add_failed:
    "Git could not read a file in the work tree (a file only the agent can read is enough), so nothing since the last checkpoint was saved, pushed, or bundled.",
  write_tree_failed:
    "Git could not record the work tree, so nothing since the last checkpoint was saved, pushed, or bundled.",
  parent_unreadable:
    "Git could not read the last saved checkpoint, so nothing since it was saved, pushed, or bundled.",
  commit_failed:
    "Git could not commit the work, so nothing since the last checkpoint was saved, pushed, or bundled.",
  timed_out:
    "Saving the work took too long, so nothing since the last checkpoint was saved, pushed, or bundled.",
  scratch_unavailable:
    "OnCue could not prepare its own working space in the sandbox, so nothing since the last checkpoint was saved, pushed, or bundled.",
  unknown:
    "Something went wrong while saving the work, so nothing since the last checkpoint was saved, pushed, or bundled.",
};

const STOPPED_LABEL: Record<PayloadOf<"sandbox.stopped">["reason"], string> = {
  idle: "Sandbox stopped after going idle",
  keepalive_expired: "Sandbox stopped when its keep-alive expired",
  lifetime_ceiling: "Sandbox stopped at its lifetime ceiling",
  user_requested: "Sandbox stopped at your request",
  policy: "Sandbox stopped by policy",
  provisioning_failed: "Sandbox never finished starting",
  failure: "Sandbox stopped after a failure",
  disappeared: "Sandbox disappeared from the provider",
  emergency_termination: "Sandbox terminated by an emergency stop",
};

const DISCONNECTED_LABEL: Record<PayloadOf<"runtime.disconnected">["reason"], string> = {
  runtime_exited: "The agent runtime exited",
  runtime_crashed: "The agent runtime crashed",
  shutdown_requested: "The agent runtime shut down on request",
  connection_lost: "Lost the connection to the agent runtime",
  timeout: "The agent runtime stopped responding",
  generation_replaced: "The agent runtime moved to a replacement sandbox",
  boot_failed: "The agent runtime could not be started",
};

// A clean shutdown is finished; any other disconnect that will not reconnect
// lost the runtime.
const CLEAN_DISCONNECTS: ReadonlySet<PayloadOf<"runtime.disconnected">["reason"]> = new Set([
  "shutdown_requested",
  "generation_replaced",
]);

const UNRESOLVED_REVIEW_STATES: ReadonlySet<ReviewActionState> = new Set([
  "unreviewed",
  "selected",
  "in_progress",
  "needs_clarification",
]);

export function chainStatusOf(status: PlanStepStatus): ChainStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "active":
    case "blocked":
      return "active";
    case "complete":
    case "skipped":
      return "complete";
    default:
      return assertNever(status, "unhandled plan step status");
  }
}

export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) {
    return "?";
  }
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  if (last === undefined) {
    return first.slice(0, 2).toUpperCase();
  }
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

// The fold never invents a tool outcome (record 04): output states come only
// from tool.completed, tool.failed, or an approval decision.
export function toolUiState(
  tool: Pick<ToolView, "inputComplete" | "result" | "failure" | "approval">,
): ToolUiState {
  if (tool.failure !== null) {
    return DENIAL_CATEGORIES.has(tool.failure.category) ? "output-denied" : "output-error";
  }
  if (tool.result !== null) {
    return "output-available";
  }
  if (tool.approval !== null) {
    switch (tool.approval.state) {
      case "requested":
        return "approval-requested";
      case "approved":
        return "approval-responded";
      case "rejected":
      case "expired":
        return "output-denied";
      default:
        return assertNever(tool.approval.state, "unhandled approval state");
    }
  }
  return tool.inputComplete ? "input-available" : "input-streaming";
}

function withState(tool: ToolView): ToolView {
  return { ...tool, state: toolUiState(tool) };
}

// Newest chunks win. The newest is kept even when it alone exceeds the
// character cap, so the tail never renders empty.
function tailWithinCaps(chunks: readonly ToolOutputChunk[]): readonly ToolOutputChunk[] {
  const tail: ToolOutputChunk[] = [];
  let chars = 0;
  for (const chunk of [...chunks].reverse()) {
    if (
      tail.length > 0 &&
      (tail.length >= TOOL_OUTPUT_TAIL_CHUNKS || chars + chunk.text.length > TOOL_OUTPUT_TAIL_CHARS)
    ) {
      return tail;
    }
    tail.unshift(chunk);
    chars += chunk.text.length;
  }
  return tail;
}

function appendToolOutput(tool: ToolView, payload: PayloadOf<"tool.output">): ToolView {
  const newest = tool.output.at(-1);
  // A first chunk that is not chunk zero means this client joined the stream
  // late, which is the same hole as a chunk the runtime dropped.
  const expected = newest === undefined ? 0 : newest.chunkIndex + 1;
  const appended = [
    ...tool.output,
    { chunkIndex: payload.chunkIndex, stream: payload.stream, text: payload.text },
  ];
  const kept = tailWithinCaps(appended);
  return {
    ...tool,
    output: kept,
    outputDropped:
      tool.outputDropped ||
      payload.chunkIndex !== expected ||
      payload.droppedBytes > 0 ||
      kept.length !== appended.length,
  };
}

/**
 * Output is missing only when this client has evidence there was some. An
 * empty tail is not evidence, since many tools emit no `tool.output`; a live
 * buffer is, because `tool.output` can arrive before the `tool.requested` that
 * creates the row.
 */
function settleToolOutput(tool: ToolView, live: LiveToolOutput | undefined): ToolView {
  return tool.output.length === 0 && live !== undefined ? { ...tool, outputDropped: true } : tool;
}

function toolApprovalOf(approval: ApprovalView): ToolApproval {
  return {
    approvalId: approval.approvalId,
    state: approval.state,
    decision: approval.resolution?.decision ?? null,
    decidedBy: approval.resolution?.decidedBy ?? null,
  };
}

function checkStatusOf(latest: CheckAttemptView | null): VerificationCheckState {
  if (latest === null) {
    return "pending";
  }
  return latest.result === null ? "running" : latest.result.result;
}

function outcomeOf(state: RunState): RunOutcome | null {
  switch (state) {
    case "verified":
    case "completed_with_warnings":
    case "completed":
    case "blocked":
    case "failed":
    case "cancelled":
      return state;
    default:
      return null;
  }
}

function isUnresolved(state: ReviewActionState): boolean {
  return UNRESOLVED_REVIEW_STATES.has(state);
}

class Cow<R, M extends R> {
  private owned: M | null = null;
  constructor(
    private readonly base: R,
    private readonly copy: (base: R) => M,
  ) {}
  read(): R {
    return this.owned ?? this.base;
  }
  write(): M {
    this.owned ??= this.copy(this.base);
    return this.owned;
  }
  get touched(): boolean {
    return this.owned !== null;
  }
}

function cowMap<K, V>(base: ReadonlyMap<K, V>): Cow<ReadonlyMap<K, V>, Map<K, V>> {
  return new Cow(base, (map) => new Map(map));
}

function cowList<T>(base: readonly T[]): Cow<readonly T[], T[]> {
  return new Cow(base, (list) => [...list]);
}

type Scalars = Omit<
  SessionView,
  | "stream"
  | "runs"
  | "timeline"
  | "messages"
  | "progress"
  | "tools"
  | "sandboxActions"
  | "plans"
  | "approvals"
  | "openApprovalIds"
  | "artifacts"
  | "commands"
  | "verification"
  | "git"
  | "reviews"
  | "agents"
  | "live"
>;

// One draft per applyEvent or foldEvents call. Each collection is copied at
// most once per draft, so replaying n events costs O(n).
class Draft {
  private readonly scalars: { -readonly [K in keyof Scalars]: Scalars[K] };
  private readonly pending: Cow<ReadonlyMap<number, CommittedEvent>, Map<number, CommittedEvent>>;
  private readonly runs: Cow<ReadonlyMap<RunId, RunView>, Map<RunId, RunView>>;
  private readonly timeline: Cow<readonly TimelineItem[], TimelineItem[]>;
  private readonly messages: Cow<ReadonlyMap<MessageId, MessageView>, Map<MessageId, MessageView>>;
  private readonly progress: Cow<
    ReadonlyMap<string, ProgressStepView>,
    Map<string, ProgressStepView>
  >;
  private readonly tools: Cow<ReadonlyMap<ToolCallId, ToolView>, Map<ToolCallId, ToolView>>;
  private readonly sandboxActions: Cow<
    ReadonlyMap<number, SandboxActionView>,
    Map<number, SandboxActionView>
  >;
  private readonly plans: Cow<ReadonlyMap<PlanId, PlanView>, Map<PlanId, PlanView>>;
  private readonly approvals: Cow<
    ReadonlyMap<ApprovalId, ApprovalView>,
    Map<ApprovalId, ApprovalView>
  >;
  private readonly openApprovalIds: Cow<readonly ApprovalId[], ApprovalId[]>;
  private readonly artifacts: Cow<
    ReadonlyMap<ArtifactId, ArtifactView>,
    Map<ArtifactId, ArtifactView>
  >;
  private readonly commands: Cow<ReadonlyMap<CommandId, CommandView>, Map<CommandId, CommandView>>;
  private readonly agents: Cow<ReadonlyMap<AgentId, AgentView>, Map<AgentId, AgentView>>;
  // Each subagent's timeline copied at most once per draft, then appended to.
  private readonly agentTimelines = new Map<AgentId, TimelineItem[]>();
  private readonly checks: Cow<ReadonlyMap<CheckId, CheckView>, Map<CheckId, CheckView>>;
  private readonly verificationSummaries: Cow<
    ReadonlyMap<RunId, VerificationSummaryView>,
    Map<RunId, VerificationSummaryView>
  >;
  private git: GitView;
  private readonly changedFiles: Cow<ReadonlyMap<string, FileChange>, Map<string, FileChange>>;
  private readonly commits: Cow<readonly CommitView[], CommitView[]>;
  private readonly turnDiffs: Cow<ReadonlyMap<RunId, DiffView>, Map<RunId, DiffView>>;
  private readonly pushes: Cow<ReadonlyMap<PushId, PushView>, Map<PushId, PushView>>;
  private readonly reviewItems: Cow<
    ReadonlyMap<ReviewItemId, ReviewItemView>,
    Map<ReviewItemId, ReviewItemView>
  >;
  private unresolvedCount: number;
  private readonly liveMessages: Cow<
    ReadonlyMap<MessageId, readonly LiveMessagePart[]>,
    Map<MessageId, readonly LiveMessagePart[]>
  >;
  private readonly liveToolOutput: Cow<
    ReadonlyMap<ToolCallId, LiveToolOutput>,
    Map<ToolCallId, LiveToolOutput>
  >;
  private liveHeartbeat: LiveHeartbeat | null;
  private changed = false;

  constructor(private readonly base: SessionView) {
    this.scalars = {
      sessionId: base.sessionId,
      appliedThrough: base.appliedThrough,
      run: base.run,
      sandbox: base.sandbox,
      policy: base.policy,
      secrets: base.secrets,
      approvalMode: base.approvalMode,
      plan: base.plan,
      questions: base.questions,
      openQuestionId: base.openQuestionId,
    };
    this.pending = cowMap(base.stream.pending);
    this.runs = cowMap(base.runs);
    this.timeline = cowList(base.timeline);
    this.messages = cowMap(base.messages);
    this.progress = cowMap(base.progress);
    this.tools = cowMap(base.tools);
    this.sandboxActions = cowMap(base.sandboxActions);
    this.plans = cowMap(base.plans);
    this.approvals = cowMap(base.approvals);
    this.openApprovalIds = cowList(base.openApprovalIds);
    this.artifacts = cowMap(base.artifacts);
    this.commands = cowMap(base.commands);
    this.agents = cowMap(base.agents);
    this.checks = cowMap(base.verification.checks);
    this.verificationSummaries = cowMap(base.verification.summaries);
    this.git = base.git;
    this.changedFiles = cowMap(base.git.changedFiles);
    this.commits = cowList(base.git.commits);
    this.turnDiffs = cowMap(base.git.turnDiffs);
    this.pushes = cowMap(base.git.pushes);
    this.reviewItems = cowMap(base.reviews.items);
    this.unresolvedCount = base.reviews.unresolvedCount;
    this.liveMessages = cowMap(base.live.messages);
    this.liveToolOutput = cowMap(base.live.toolOutput);
    this.liveHeartbeat = base.live.heartbeat;
  }

  finish(): SessionView {
    if (!this.changed) {
      return this.base;
    }
    const pendingMap = this.pending.read();
    return {
      ...this.scalars,
      stream: {
        pending: pendingMap,
        awaiting: pendingMap.size === 0 ? null : this.scalars.appliedThrough + 1,
      },
      runs: this.runs.read(),
      timeline: this.timeline.read(),
      messages: this.messages.read(),
      progress: this.progress.read(),
      tools: this.tools.read(),
      sandboxActions: this.sandboxActions.read(),
      plans: this.plans.read(),
      approvals: this.approvals.read(),
      openApprovalIds: this.openApprovalIds.read(),
      artifacts: this.artifacts.read(),
      commands: this.commands.read(),
      agents: this.finishAgents(),
      verification:
        this.checks.touched || this.verificationSummaries.touched
          ? { checks: this.checks.read(), summaries: this.verificationSummaries.read() }
          : this.base.verification,
      git:
        this.git !== this.base.git ||
        this.changedFiles.touched ||
        this.commits.touched ||
        this.turnDiffs.touched ||
        this.pushes.touched
          ? {
              ...this.git,
              changedFiles: this.changedFiles.read(),
              commits: this.commits.read(),
              turnDiffs: this.turnDiffs.read(),
              pushes: this.pushes.read(),
            }
          : this.base.git,
      reviews:
        this.reviewItems.touched || this.unresolvedCount !== this.base.reviews.unresolvedCount
          ? { items: this.reviewItems.read(), unresolvedCount: this.unresolvedCount }
          : this.base.reviews,
      live:
        this.liveMessages.touched ||
        this.liveToolOutput.touched ||
        this.liveHeartbeat !== this.base.live.heartbeat
          ? {
              messages: this.liveMessages.read(),
              toolOutput: this.liveToolOutput.read(),
              heartbeat: this.liveHeartbeat,
            }
          : this.base.live,
    };
  }

  // Record 04: clients order by the session sequence, never by
  // runtimeSequence. A sequence at or below appliedThrough was already
  // folded; one past the next waits in `pending` until the gap fills.
  admit(event: CommittedEvent): void {
    const sequence = event.sessionSequence;
    if (sequence <= this.scalars.appliedThrough || this.pending.read().has(sequence)) {
      return;
    }
    if (sequence !== this.scalars.appliedThrough + 1) {
      this.changed = true;
      this.pending.write().set(sequence, event);
      return;
    }
    this.apply(event);
    for (;;) {
      const next = this.scalars.appliedThrough + 1;
      const buffered = this.pending.read().get(next);
      if (buffered === undefined) {
        return;
      }
      this.pending.write().delete(next);
      this.apply(buffered);
    }
  }

  applyLive(event: ProtocolEventOf<EphemeralEventType>): void {
    switch (event.type) {
      case "runtime.heartbeat":
        this.changed = true;
        this.liveHeartbeat = { ...event.payload, observedAt: event.occurredAt };
        return;
      case "message.delta": {
        const { messageId, partIndex, part } = event.payload;
        const committed = this.messages.read().get(messageId);
        if (committed !== undefined && !committed.streaming) {
          return;
        }
        this.changed = true;
        const parts = [...(this.liveMessages.read().get(messageId) ?? [])];
        const existing = parts[partIndex];
        parts[partIndex] =
          existing === undefined || existing.text === ""
            ? { type: part.type, text: part.text }
            : { type: existing.type, text: existing.text + part.text };
        for (let index = 0; index < parts.length; index += 1) {
          parts[index] ??= { type: "text", text: "" };
        }
        this.liveMessages.write().set(messageId, parts);
        return;
      }
      case "tool.output": {
        const { toolCallId, chunkIndex, text, droppedBytes } = event.payload;
        const tool = this.tools.read().get(toolCallId);
        if (tool !== undefined && (tool.result !== null || tool.failure !== null)) {
          return;
        }
        const current = this.liveToolOutput.read().get(toolCallId);
        if (current !== undefined && chunkIndex <= current.lastChunkIndex) {
          return;
        }
        this.changed = true;
        let combined = (current?.text ?? "") + text;
        let truncatedChars = current?.truncatedChars ?? 0;
        if (combined.length > LIVE_TERMINAL_CAP) {
          truncatedChars += combined.length - LIVE_TERMINAL_CAP;
          combined = combined.slice(combined.length - LIVE_TERMINAL_CAP);
        }
        this.liveToolOutput.write().set(toolCallId, {
          text: combined,
          streaming: true,
          droppedBytes: (current?.droppedBytes ?? 0) + droppedBytes,
          truncatedChars,
          lastChunkIndex: chunkIndex,
        });
        if (tool !== undefined) {
          this.tools.write().set(toolCallId, appendToolOutput(tool, event.payload));
        }
        return;
      }
      default:
        assertNever(event);
    }
  }

  private apply(event: CommittedEvent): void {
    this.changed = true;
    this.scalars.appliedThrough = event.sessionSequence;
    this.scalars.sessionId ??= event.sessionId;
    switch (event.type) {
      case "runtime.connected":
        this.onRuntimeConnected(event);
        return;
      case "runtime.ready":
        this.onRuntimeReady(event);
        return;
      case "run.queued":
        this.onRunQueued(event);
        return;
      case "run.started":
        this.onRunStarted(event);
        return;
      case "run.paused":
        this.onRunPaused(event);
        return;
      case "run.interrupted":
        this.onRunInterrupted(event);
        return;
      case "run.verified":
        this.onRunEnded(event, { outcome: "verified", ...event.payload });
        return;
      case "run.completed_with_warnings":
        this.onRunEnded(event, { outcome: "completed_with_warnings", ...event.payload });
        return;
      case "run.completed":
        this.onRunEnded(event, { outcome: "completed", ...event.payload });
        return;
      case "run.blocked":
        this.onRunEnded(event, { outcome: "blocked", ...event.payload });
        return;
      case "run.failed":
        this.onRunEnded(event, { outcome: "failed", ...event.payload });
        return;
      case "run.cancelled":
        this.onRunEnded(event, { outcome: "cancelled", ...event.payload });
        return;
      case "runtime.disconnected":
        this.onRuntimeDisconnected(event);
        return;
      case "message.started":
        this.onMessageStarted(event);
        return;
      case "message.completed":
        this.onMessageCompleted(event);
        return;
      case "status.updated":
        this.onStatusUpdated(event);
        return;
      case "plan.created":
        this.onPlanBody(event, "proposed", "created", null);
        return;
      case "plan.updated":
        this.onPlanBody(
          event,
          event.payload.changeSummary === null ? "active" : "revised",
          event.payload.changeSummary === null ? null : "revised",
          event.payload.changeSummary,
        );
        return;
      case "plan.completed":
        this.onPlanEnded(event, "completed", "completed", {
          completionSummary: event.payload.summary,
        });
        return;
      case "plan.blocked":
        this.onPlanEnded(event, "blocked", "blocked", {
          blockedQuestion: event.payload.question,
          activeStepId: event.payload.stepId,
        });
        return;
      case "plan.cancelled":
        this.onPlanEnded(event, "cancelled", "cancelled", {
          cancelReason: event.payload.reason,
        });
        return;
      case "tool.requested":
        this.onToolRequested(event);
        return;
      case "tool.started":
        this.onToolStarted(event);
        return;
      case "tool.completed":
        this.onToolCompleted(event);
        return;
      case "tool.failed":
        this.onToolFailed(event);
        return;
      case "file.changed":
        this.changedFiles.write().set(event.payload.change.path, event.payload.change);
        return;
      case "repository.status":
        this.onRepositoryStatus(event);
        return;
      case "repository.checkpointed":
        this.setCheckpoint(event.payload, event.occurredAt);
        return;
      case "diff.updated":
        this.onDiffUpdated(event);
        return;
      case "git.committed":
        this.onGitCommitted(event);
        return;
      case "git.push.requested":
        this.onPushRequested(event);
        return;
      case "git.push.completed":
        this.onPushCompleted(event);
        return;
      case "git.push.failed":
        this.onPushFailed(event);
        return;
      case "git.push.withheld":
        this.onPushWithheld(event);
        return;
      case "pull_request.described": {
        const earlier = this.git.description;
        this.git = {
          ...this.git,
          description: {
            title: event.payload.title ?? earlier?.title ?? null,
            body: event.payload.body ?? earlier?.body ?? null,
            branchName: event.payload.branchName ?? earlier?.branchName ?? null,
          },
        };
        return;
      }
      case "pull_request.created":
        this.onPullRequestCreated(event);
        return;
      case "pull_request.updated":
        this.onPullRequestUpdated(event);
        return;
      case "pull_request.state_changed":
        this.onPullRequestStateChanged(event);
        return;
      case "policy.proposed": {
        const { proposalId, from, to, direction, rationale } = event.payload;
        this.scalars.policy = {
          ...this.scalars.policy,
          pendingProposal: { ...event.payload, at: event.occurredAt },
        };
        this.policyChange(event.sessionSequence, {
          kind: "proposed",
          proposalId,
          from,
          to,
          direction,
          rationale,
        });
        return;
      }
      case "policy.updated":
        this.onPolicyUpdated(event);
        return;
      case "policy.declined":
        // Only the card the user answered closes: a newer proposal stays open.
        if (this.scalars.policy.pendingProposal?.proposalId === event.payload.proposalId) {
          this.scalars.policy = { ...this.scalars.policy, pendingProposal: null };
        }
        this.policyChange(event.sessionSequence, {
          kind: "declined",
          proposalId: event.payload.proposalId,
        });
        return;
      case "command.acknowledged":
        this.commands.write().set(event.payload.commandId, {
          commandId: event.payload.commandId,
          commandType: event.payload.commandType,
          state: "acknowledged",
          acceptedBy: event.payload.acceptedBy,
          rejection: null,
          at: event.occurredAt,
        });
        return;
      case "command.rejected": {
        const { commandId, commandType, ...rejection } = event.payload;
        this.commands.write().set(commandId, {
          commandId,
          commandType,
          state: "rejected",
          acceptedBy: null,
          rejection,
          at: event.occurredAt,
        });
        return;
      }
      case "message.queued":
        this.onMessageQueued(event);
        return;
      case "secrets.disclosed":
        this.scalars.secrets = event.payload;
        this.push({ kind: "secrets", sequence: event.sessionSequence });
        return;
      case "secrets.supplied":
        this.onSecretsSupplied(event);
        return;
      case "sandbox.keepalive.updated":
        this.scalars.sandbox = { ...this.scalars.sandbox, keepAlive: event.payload };
        return;
      case "sandbox.provisioning":
        this.onSandboxProvisioning(event);
        return;
      case "sandbox.attached":
        this.onSandboxAttached(event);
        return;
      case "sandbox.output":
        this.onSandboxOutput(event);
        return;
      case "sandbox.idle":
        this.sandboxAction(event, "idle", {
          label:
            event.payload.keepAliveUntil === null
              ? "Sandbox idle, stopping when its timer expires"
              : "Sandbox idle, held open by a keep-alive",
          detail: `stopping at ${event.payload.stopAt}`,
        });
        this.scalars.sandbox = {
          ...this.scalars.sandbox,
          state: this.sandboxStateAfter("idle"),
          idleSince: event.payload.idleSince,
          stopAt: event.payload.stopAt,
        };
        return;
      case "sandbox.checkpointed":
        this.sandboxAction(event, "checkpointed", {
          label: CHECKPOINT_LABEL[event.payload.kind],
          detail: CHECKPOINT_DETAIL[event.payload.reason],
          // The work was saved, so an earlier failure's reason is not the row's.
          explanation: null,
          durationMs: event.payload.durationMs,
        });
        this.setCheckpoint(event.payload, event.occurredAt);
        this.scalars.sandbox = {
          ...this.scalars.sandbox,
          state: this.sandboxStateAfter("checkpointing"),
        };
        return;
      case "sandbox.checkpoint_failed":
        // Nothing was saved. A push waiting on this checkpoint has no commit
        // for `git.push.failed` to name, so this failure settles it.
        this.settlePushesOnFailedCheckpoint(event);
        this.sandboxAction(event, "checkpointed", {
          label: "Could not save the work",
          detail: CHECKPOINT_DETAIL[event.payload.reason],
          explanation: CHECKPOINT_FAILURE_TEXT[event.payload.failure],
          durationMs: event.payload.durationMs,
        });
        this.scalars.sandbox = {
          ...this.scalars.sandbox,
          state: this.sandboxStateAfter("checkpointing"),
        };
        return;
      case "sandbox.stopped":
        this.sandboxAction(event, event.payload.outcome === "failed" ? "failed" : "stopped", {
          label: STOPPED_LABEL[event.payload.reason],
          detail: event.payload.checkpointId === null ? "no checkpoint saved" : "work checkpointed",
          explanation: event.payload.unsavedWorkWarning,
        });
        this.scalars.sandbox = {
          ...this.scalars.sandbox,
          state: event.payload.outcome,
          stop: event.payload,
        };
        return;
      case "sandbox.replaced": {
        // Settle the retired generation first, so the new row can carry its
        // provider until its own `sandbox.provisioning` arrives.
        const retired = this.settleSupersededGeneration(event);
        this.sandboxAction(event, "requested", {
          label: REPLACED_LABEL[event.payload.reason],
          detail:
            event.payload.restoredFrom === null
              ? `replacing generation ${event.payload.previousGeneration}`
              : `restoring ${event.payload.restoredFrom}`,
          explanation: event.payload.explanation,
          provider: retired?.provider ?? null,
        });
        this.scalars.sandbox = {
          ...EMPTY_SANDBOX,
          generation: event.sandboxGeneration,
          state: "requested",
          keepAlive: this.scalars.sandbox.keepAlive,
          replacement: event.payload,
        };
        return;
      }
      case "sandbox.credentials_revoked": {
        // A step, not an end: `sandbox.stopped` ends the row.
        const existing = this.sandboxActions.read().get(event.sandboxGeneration);
        if (existing !== undefined) {
          this.sandboxAction(event, existing.step, {
            label: "Took back the sandbox's credentials",
            detail: event.payload.grants
              .map((grant) => `${grant.kind} ${grant.outcome.replace("_", " ")}`)
              .join(", "),
          });
        }
        return;
      }
      case "review.imported":
        this.onReviewImported(event);
        return;
      case "review.updated":
        this.updateReview(event.payload.reviewItemId, (item) => ({
          ...item,
          actionState: event.payload.actionState,
          body: event.payload.body ?? item.body,
          githubState: event.payload.githubState,
          locationCurrent: event.payload.locationCurrent,
          updatedAt: event.payload.updatedAt,
        }));
        return;
      case "review.selected":
        for (const reviewItemId of event.payload.reviewItemIds) {
          this.updateReview(reviewItemId, (item) => ({
            ...item,
            actionState: "selected",
            updatedAt: event.occurredAt,
          }));
        }
        return;
      case "review.addressed":
        this.updateReview(event.payload.reviewItemId, (item) => ({
          ...item,
          actionState: event.payload.outcome,
          addressed: event.payload,
          updatedAt: event.occurredAt,
        }));
        this.push({
          kind: "review",
          reviewItemId: event.payload.reviewItemId,
          change: "addressed",
          sequence: event.sessionSequence,
        });
        return;
      case "review.dismissed":
        this.updateReview(event.payload.reviewItemId, (item) => ({
          ...item,
          actionState: "dismissed",
          dismissal: { userId: event.payload.userId, reason: event.payload.reason },
          updatedAt: event.occurredAt,
        }));
        return;
      case "verification.started":
        this.onVerificationStarted(event);
        return;
      case "verification.result":
        this.onVerificationResult(event);
        return;
      case "verification.completed":
        this.verificationSummaries
          .write()
          .set(event.runId, { ...event.payload, runId: event.runId, at: event.occurredAt });
        this.push({ kind: "verification", runId: event.runId, sequence: event.sessionSequence });
        return;
      case "approval.requested":
        this.onApprovalRequested(event);
        return;
      case "approval.resolved":
        this.onApprovalResolved(event);
        return;
      case "approval.expired":
        this.onApprovalExpired(event);
        return;
      case "approval.mode_changed":
        this.scalars.approvalMode = event.payload.mode;
        return;
      case "question.asked":
        this.onQuestionAsked(event);
        return;
      case "question.answered":
        this.settleQuestion(event, event.payload.questionId, "answered", event.payload.answers);
        return;
      case "question.dismissed":
        this.settleQuestion(
          event,
          event.payload.questionId,
          "dismissed",
          null,
          event.payload.reason,
        );
        return;
      case "artifact.uploading":
        this.onArtifactUploading(event);
        return;
      case "artifact.created":
        this.onArtifactCreated(event);
        return;
      case "artifact.failed":
        this.onArtifactFailed(event);
        return;
      case "agent.started":
        this.onAgentStarted(event);
        return;
      case "agent.completed":
        this.onAgentCompleted(event);
        return;
      default:
        assertNever(event);
    }
  }

  private push(item: TimelineItem): void {
    this.timeline.write().push(item);
  }

  /** A subagent's message or call goes on its own timeline, never the session's. */
  private pushFor(item: TimelineItem, agentId: AgentId | undefined, event: CommittedEvent): void {
    if (agentId === undefined) {
      this.push(item);
      return;
    }
    this.agentEntry(agentId, event);
    let owned = this.agentTimelines.get(agentId);
    if (owned === undefined) {
      owned = [...(this.agents.read().get(agentId)?.timeline ?? [])];
      this.agentTimelines.set(agentId, owned);
    }
    owned.push(item);
  }

  /**
   * The subagent's entry, made as a placeholder when its own events arrive
   * before its `agent.started`, so they still stay off the session's timeline.
   */
  private agentEntry(agentId: AgentId, event: CommittedEvent): AgentView {
    const existing = this.agents.read().get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    const placeholder: AgentView = {
      agentId,
      runId: event.runId as RunId,
      sandboxGeneration: event.sandboxGeneration,
      parentToolCallId: null,
      name: "general",
      description: "Subagent",
      prompt: "",
      promptTruncated: false,
      model: null,
      status: "running",
      startedAt: event.occurredAt,
      endedAt: null,
      usage: null,
      resultSummary: null,
      timeline: [],
    };
    this.agents.write().set(agentId, placeholder);
    return placeholder;
  }

  private finishAgents(): ReadonlyMap<AgentId, AgentView> {
    if (this.agentTimelines.size === 0) {
      return this.agents.read();
    }
    const agents = this.agents.write();
    for (const [agentId, timeline] of this.agentTimelines) {
      const agent = agents.get(agentId);
      if (agent !== undefined) {
        agents.set(agentId, { ...agent, timeline: [...timeline] });
      }
    }
    return agents;
  }

  private onAgentStarted(event: CommittedEventOf<"agent.started">): void {
    const { agentId, parentToolCallId, name, description, prompt, promptTruncated, model } =
      event.payload;
    const existing = this.agentEntry(agentId, event);
    this.agents.write().set(agentId, {
      ...existing,
      runId: event.runId,
      sandboxGeneration: event.sandboxGeneration,
      parentToolCallId,
      name,
      description,
      prompt,
      promptTruncated,
      model,
      startedAt: event.occurredAt,
    });
  }

  private onAgentCompleted(event: CommittedEventOf<"agent.completed">): void {
    const { agentId, status, usage, resultSummary } = event.payload;
    const existing = this.agentEntry(agentId, event);
    this.agents.write().set(agentId, {
      ...existing,
      status,
      usage,
      resultSummary,
      endedAt: event.occurredAt,
    });
  }

  // One row per generation, updated in place. The timeline entry is pushed
  // only when the generation is first seen.
  private sandboxAction(
    event: CommittedEvent,
    step: SandboxActionStep,
    fields: {
      readonly label: string;
      readonly detail?: string | null;
      readonly explanation?: string | null;
      // Null as well as absent: a provider carried forward may never have
      // been named.
      readonly provider?: SandboxProvider | null;
      readonly durationMs?: number;
      readonly providerSandboxId?: string;
    },
  ): void {
    const generation = event.sandboxGeneration;
    const existing = this.sandboxActions.read().get(generation);
    const detail = fields.detail ?? null;
    const ended = SANDBOX_ENDED_STEPS.has(step);
    this.sandboxActions.write().set(generation, {
      generation,
      step,
      state: SANDBOX_ACTION_STATE[step],
      provider: fields.provider ?? existing?.provider ?? null,
      label: fields.label,
      detail,
      // An explicit null clears a stale reason; an absent field keeps it.
      explanation:
        fields.explanation === undefined ? (existing?.explanation ?? null) : fields.explanation,
      durationMs: fields.durationMs ?? existing?.durationMs ?? null,
      at: existing?.at ?? event.occurredAt,
      updatedAt: event.occurredAt,
      steps: [
        ...(existing?.steps ?? []),
        { step, label: fields.label, detail, at: event.occurredAt },
      ],
      output: existing?.output ?? [],
      providerSandboxId: fields.providerSandboxId ?? existing?.providerSandboxId ?? null,
      runningSince: existing?.runningSince ?? (step === "attached" ? event.occurredAt : null),
      // A reconnect reopens the row: a generation ends only when it is
      // stopped, failed, or replaced.
      endedAt: ended ? (existing?.endedAt ?? event.occurredAt) : null,
    });
    if (existing === undefined) {
      this.push({ kind: "sandbox", generation, sequence: event.sessionSequence });
    }
  }

  /**
   * Appends a sandbox output line to its generation's tail without changing
   * the step, state, or label. A generation with no row gets none invented.
   */
  private onSandboxOutput(event: CommittedEventOf<"sandbox.output">): void {
    const generation = event.sandboxGeneration;
    const existing = this.sandboxActions.read().get(generation);
    if (existing === undefined) {
      return;
    }
    const appended = [
      ...existing.output,
      ...event.payload.lines.map((line) => ({
        stream: event.payload.stream,
        at: line.at,
        text: line.text,
      })),
    ];
    this.sandboxActions.write().set(generation, {
      ...existing,
      output: appended.slice(-SANDBOX_OUTPUT_TAIL_LINES),
    });
  }

  /**
   * Closes the row for the generation `sandbox.replaced` retires and returns
   * it so the caller can carry its provider forward. A replaced generation
   * gets no `sandbox.stopped` (record 04), so this is its last event. A
   * generation this client never saw gets no row invented.
   */
  private settleSupersededGeneration(
    event: CommittedEventOf<"sandbox.replaced">,
  ): SandboxActionView | undefined {
    const generation = event.payload.previousGeneration;
    const retired = this.sandboxActions.read().get(generation);
    if (retired === undefined) {
      return undefined;
    }
    const step = SUPERSEDED_STEP[event.payload.reason];
    const label = SUPERSEDED_LABEL[event.payload.reason];
    const detail = `replaced by generation ${event.sandboxGeneration}`;
    this.sandboxActions.write().set(generation, {
      ...retired,
      step,
      state: SANDBOX_ACTION_STATE[step],
      label,
      detail,
      updatedAt: event.occurredAt,
      steps: [...retired.steps, { step, label, detail, at: event.occurredAt }],
      endedAt: retired.endedAt ?? event.occurredAt,
    });
    return retired;
  }

  private setRun(run: RunView): void {
    this.runs.write().set(run.runId, run);
    if (this.scalars.run?.runId === run.runId) {
      this.scalars.run = run;
    }
  }

  private runFor(event: CommittedEvent & { readonly runId: RunId }): RunView {
    const known = this.runs.read().get(event.runId);
    if (known !== undefined) {
      return known;
    }
    const stub: RunView = {
      runId: event.runId,
      state: "created",
      outcome: null,
      trigger: null,
      instructionMessageId: null,
      model: null,
      continuesRunId: null,
      queuedAt: event.occurredAt,
      startedAt: null,
      endedAt: null,
      branch: null,
      baseSha: null,
      resumedFrom: null,
      pause: null,
      interruption: null,
      ending: null,
      sandboxGeneration: event.sandboxGeneration,
    };
    this.runs.write().set(stub.runId, stub);
    this.scalars.run ??= stub;
    return stub;
  }

  // Record 01 has no run.provisioning or run.ready event: those states come
  // from sandbox and runtime events, so the run table guards them.
  private moveCurrentRun(to: RunState): void {
    const run = this.scalars.run;
    if (run === null || !canTransition("run", run.state, to)) {
      return;
    }
    this.setRun({ ...run, state: to, outcome: outcomeOf(to) });
  }

  private sandboxStateAfter(to: SandboxState): SandboxState | null {
    const from = this.scalars.sandbox.state;
    return from !== null && canTransition("sandbox", from, to) ? to : from;
  }

  private onRuntimeConnected(event: CommittedEventOf<"runtime.connected">): void {
    const { runtimeName, runtimeVersion, bridgeVersion } = event.payload;
    this.sandboxAction(event, "connected", {
      // A bridge with no agent runtime says so rather than printing the
      // placeholder fields as a sentence.
      label:
        runtimeName === NO_RUNTIME
          ? "Bridge connected, waiting for the agent runtime"
          : `Connected to ${runtimeName} ${runtimeVersion}`,
      detail: `bridge ${bridgeVersion}`,
    });
    this.scalars.sandbox = {
      ...this.scalars.sandbox,
      runtime: {
        connected: true,
        ready: false,
        bridgeVersion: event.payload.bridgeVersion,
        runtimeName: event.payload.runtimeName,
        runtimeVersion: event.payload.runtimeVersion,
        capabilities: event.payload.capabilities,
        healthChecks: [],
        startupMs: null,
        lastDisconnect: null,
      },
    };
  }

  private onRuntimeReady(event: CommittedEventOf<"runtime.ready">): void {
    const { runtimeName, runtimeVersion, healthChecks: checks } = event.payload;
    const passed = checks.filter((check) => check.passed).length;
    this.sandboxAction(event, "ready", {
      label:
        passed === checks.length
          ? `${runtimeName} ${runtimeVersion} is ready`
          : `${runtimeName} ${runtimeVersion} is ready with failing startup checks`,
      detail: `${passed} of ${checks.length} startup checks passed`,
      durationMs: event.payload.startupMs,
    });
    const runtime = this.scalars.sandbox.runtime;
    if (runtime !== null) {
      this.scalars.sandbox = {
        ...this.scalars.sandbox,
        state: this.sandboxStateAfter("active"),
        runtime: {
          ...runtime,
          ready: true,
          runtimeName,
          runtimeVersion,
          healthChecks: checks,
          startupMs: event.payload.startupMs,
        },
      };
    }
    this.moveCurrentRun("ready");
  }

  private onRuntimeDisconnected(event: CommittedEventOf<"runtime.disconnected">): void {
    const { reason, detail, expectReconnect } = event.payload;
    this.sandboxAction(
      event,
      expectReconnect ? "reconnecting" : CLEAN_DISCONNECTS.has(reason) ? "disconnected" : "lost",
      {
        label: DISCONNECTED_LABEL[reason],
        detail: expectReconnect ? "reconnecting" : null,
        explanation: detail,
      },
    );
    const runtime = this.scalars.sandbox.runtime;
    if (runtime === null) {
      return;
    }
    this.scalars.sandbox = {
      ...this.scalars.sandbox,
      runtime: { ...runtime, connected: false, ready: false, lastDisconnect: event.payload },
    };
  }

  private onRunQueued(event: CommittedEventOf<"run.queued">): void {
    const { instruction, model, trigger, continuesRunId } = event.payload;
    const run: RunView = {
      runId: event.runId,
      state: "queued",
      outcome: null,
      trigger,
      instructionMessageId: instruction.messageId,
      model,
      continuesRunId,
      queuedAt: event.occurredAt,
      startedAt: null,
      endedAt: null,
      branch: null,
      baseSha: null,
      resumedFrom: null,
      pause: null,
      interruption: null,
      ending: null,
      sandboxGeneration: event.sandboxGeneration,
    };
    this.runs.write().set(run.runId, run);
    this.scalars.run = run;
    this.addUserMessage(
      instruction.messageId,
      event.runId,
      instruction.text,
      instruction.attachments,
      null,
      event,
    );
  }

  private addUserMessage(
    messageId: MessageId,
    runId: RunId | null,
    text: string,
    attachments: readonly ArtifactRef[],
    delivery: MessageView["delivery"],
    event: CommittedEvent,
  ): void {
    const parts: MessagePart[] = [{ type: "text", text }];
    for (const artifact of attachments) {
      parts.push({ type: "artifact_ref", artifact });
    }
    this.messages.write().set(messageId, {
      messageId,
      runId,
      role: "user",
      parts,
      streaming: false,
      stopReason: null,
      usage: null,
      delivery,
      at: event.occurredAt,
    });
    this.push({ kind: "message", messageId, sequence: event.sessionSequence });
  }

  private onRunStarted(event: CommittedEventOf<"run.started">): void {
    const run = this.runFor(event);
    this.setRun({
      ...run,
      state: "running",
      outcome: null,
      startedAt: run.startedAt ?? event.occurredAt,
      branch: event.payload.branch,
      baseSha: event.payload.baseSha,
      resumedFrom: event.payload.resumedFrom,
      sandboxGeneration: event.sandboxGeneration,
    });
    this.scalars.sandbox = {
      ...this.scalars.sandbox,
      state: this.sandboxStateAfter("active"),
    };
    this.push({
      kind: "run",
      runId: event.runId,
      transition: "started",
      sequence: event.sessionSequence,
    });
  }

  private onRunPaused(event: CommittedEventOf<"run.paused">): void {
    const run = this.runFor(event);
    this.setRun({ ...run, state: "paused", outcome: null, pause: event.payload });
    this.push({
      kind: "run",
      runId: event.runId,
      transition: "paused",
      pause: event.payload,
      sequence: event.sessionSequence,
    });
  }

  private onRunInterrupted(event: CommittedEventOf<"run.interrupted">): void {
    const run = this.runFor(event);
    this.setRun({ ...run, state: "interrupted", outcome: null, interruption: event.payload });
    this.push({
      kind: "run",
      runId: event.runId,
      transition: "interrupted",
      sequence: event.sessionSequence,
    });
  }

  private onRunEnded(event: CommittedEvent & { readonly runId: RunId }, ending: RunEnding): void {
    const run = this.runFor(event);
    this.setRun({
      ...run,
      state: ending.outcome,
      outcome: ending.outcome,
      endedAt: event.occurredAt,
      ending,
    });
    this.push({
      kind: "run",
      runId: event.runId,
      transition: ending.outcome,
      sequence: event.sessionSequence,
    });
  }

  private onMessageStarted(event: CommittedEventOf<"message.started">): void {
    const { messageId, role, agentId } = event.payload;
    const existing = this.messages.read().get(messageId);
    if (existing === undefined) {
      this.messages.write().set(messageId, {
        messageId,
        runId: event.runId,
        role,
        parts: [],
        streaming: true,
        stopReason: null,
        usage: null,
        delivery: null,
        at: event.occurredAt,
        ...(agentId === undefined ? {} : { agentId }),
      });
      this.pushFor({ kind: "message", messageId, sequence: event.sessionSequence }, agentId, event);
      return;
    }
    if (existing.stopReason === null) {
      this.messages.write().set(messageId, { ...existing, streaming: true });
    }
  }

  private onMessageCompleted(event: CommittedEventOf<"message.completed">): void {
    const { messageId, role, parts, stopReason, usage, agentId } = event.payload;
    const existing = this.messages.read().get(messageId);
    this.messages.write().set(messageId, {
      messageId,
      runId: event.runId,
      role,
      parts,
      streaming: false,
      stopReason,
      usage,
      delivery: null,
      at: existing?.at ?? event.occurredAt,
      ...(agentId === undefined ? {} : { agentId }),
    });
    if (existing === undefined) {
      this.pushFor({ kind: "message", messageId, sequence: event.sessionSequence }, agentId, event);
    }
    if (this.liveMessages.read().has(messageId)) {
      this.liveMessages.write().delete(messageId);
    }
  }

  private onStatusUpdated(event: CommittedEventOf<"status.updated">): void {
    const { stepId, phase, label, description, status } = event.payload;
    const known = this.progress.read().has(stepId);
    this.progress.write().set(stepId, {
      stepId,
      runId: event.runId,
      phase,
      label,
      description: description ?? null,
      status,
      at: event.occurredAt,
    });
    if (!known) {
      this.push({ kind: "progress", stepId, sequence: event.sessionSequence });
    }
  }

  private onMessageQueued(event: CommittedEventOf<"message.queued">): void {
    const { messageId, text, delivery, deliveredToRunId, attachments } = event.payload;
    this.addUserMessage(messageId, deliveredToRunId, text, attachments ?? [], delivery, event);
  }

  private onPlanBody(
    event: CommittedEventOf<"plan.created"> | CommittedEventOf<"plan.updated">,
    state: PlanState,
    change: PlanChange | null,
    changeSummary: string | null,
  ): void {
    const body = event.payload;
    const existing = this.plans.read().get(body.planId);
    const plan: PlanView = {
      planId: body.planId,
      runId: event.runId,
      revision: body.revision,
      state,
      title: body.title,
      description: body.description ?? null,
      steps: body.steps.map((step) => ({ ...step, chainStatus: chainStatusOf(step.status) })),
      activeStepId: body.activeStepId,
      expectedVerification: body.expectedVerification,
      changeSummary: changeSummary ?? existing?.changeSummary ?? null,
      completionSummary: null,
      blockedQuestion: null,
      cancelReason: null,
      updatedAt: event.occurredAt,
    };
    this.plans.write().set(plan.planId, plan);
    this.scalars.plan = plan;
    if (change !== null) {
      this.push({ kind: "plan", planId: plan.planId, change, sequence: event.sessionSequence });
    }
  }

  private onPlanEnded(
    event:
      | CommittedEventOf<"plan.completed">
      | CommittedEventOf<"plan.blocked">
      | CommittedEventOf<"plan.cancelled">,
    state: PlanState,
    change: PlanChange,
    patch: Partial<
      Pick<PlanView, "completionSummary" | "blockedQuestion" | "cancelReason" | "activeStepId">
    >,
  ): void {
    const existing = this.plans.read().get(event.payload.planId);
    if (existing === undefined) {
      return;
    }
    const plan: PlanView = {
      ...existing,
      ...patch,
      state,
      revision: event.payload.revision,
      updatedAt: event.occurredAt,
    };
    this.plans.write().set(plan.planId, plan);
    if (this.scalars.plan?.planId === plan.planId) {
      this.scalars.plan = plan;
    }
    this.push({ kind: "plan", planId: plan.planId, change, sequence: event.sessionSequence });
  }

  private onToolRequested(event: CommittedEventOf<"tool.requested">): void {
    const { toolCallId, category, title, runtimeName, input, inputComplete, approvalId, agentId } =
      event.payload;
    const existing = this.tools.read().get(toolCallId);
    const linked = approvalId === null ? null : (this.approvals.read().get(approvalId) ?? null);
    const approval =
      linked !== null
        ? toolApprovalOf(linked)
        : approvalId !== null
          ? { approvalId, state: "requested" as const, decision: null, decidedBy: null }
          : (existing?.approval ?? null);
    this.tools.write().set(
      toolCallId,
      withState({
        toolCallId,
        runId: event.runId,
        state: "input-streaming",
        category,
        title,
        runtimeName,
        input,
        inputComplete,
        approval,
        requestedAt: existing?.requestedAt ?? event.occurredAt,
        startedAt: existing?.startedAt ?? null,
        durationMs: existing?.durationMs ?? null,
        exitCode: existing?.exitCode ?? null,
        result: existing?.result ?? null,
        failure: existing?.failure ?? null,
        output: existing?.output ?? [],
        outputDropped: existing?.outputDropped ?? false,
        ...(agentId === undefined ? {} : { agentId }),
      }),
    );
    if (existing === undefined) {
      this.pushFor({ kind: "tool", toolCallId, sequence: event.sessionSequence }, agentId, event);
    }
  }

  private onToolStarted(event: CommittedEventOf<"tool.started">): void {
    const tool = this.tools.read().get(event.payload.toolCallId);
    if (tool === undefined) {
      return;
    }
    this.tools
      .write()
      .set(tool.toolCallId, withState({ ...tool, startedAt: tool.startedAt ?? event.occurredAt }));
  }

  private onToolCompleted(event: CommittedEventOf<"tool.completed">): void {
    const { toolCallId, durationMs, exitCode, result } = event.payload;
    const tool = this.tools.read().get(toolCallId);
    if (tool === undefined) {
      return;
    }
    this.tools
      .write()
      .set(
        toolCallId,
        withState(
          settleToolOutput(
            { ...tool, durationMs, exitCode, result, failure: null },
            this.liveToolOutput.read().get(toolCallId),
          ),
        ),
      );
    this.settleLiveOutput(toolCallId);
  }

  private onToolFailed(event: CommittedEventOf<"tool.failed">): void {
    const { toolCallId, durationMs, exitCode, errorText, category, evidence } = event.payload;
    const tool = this.tools.read().get(toolCallId);
    if (tool === undefined) {
      return;
    }
    this.tools.write().set(
      toolCallId,
      withState(
        settleToolOutput(
          {
            ...tool,
            durationMs,
            exitCode,
            result: null,
            failure: { errorText, category, evidence },
          },
          this.liveToolOutput.read().get(toolCallId),
        ),
      ),
    );
    this.settleLiveOutput(toolCallId);
  }

  private settleLiveOutput(toolCallId: ToolCallId): void {
    const live = this.liveToolOutput.read().get(toolCallId);
    if (live?.streaming) {
      this.liveToolOutput.write().set(toolCallId, { ...live, streaming: false });
    }
  }

  private refreshToolApproval(approval: ApprovalView): void {
    if (approval.toolCallId === null) {
      return;
    }
    const tool = this.tools.read().get(approval.toolCallId);
    if (tool === undefined) {
      return;
    }
    this.tools
      .write()
      .set(tool.toolCallId, withState({ ...tool, approval: toolApprovalOf(approval) }));
  }

  private onRepositoryStatus(event: CommittedEventOf<"repository.status">): void {
    const { branch, headSha, baseSha, ahead, behind, dirty, additions, deletions } = event.payload;
    this.git = {
      ...this.git,
      branch,
      headSha,
      baseSha,
      ahead,
      behind,
      dirty,
      additions,
      deletions,
    };
  }

  private setCheckpoint(
    payload: PayloadOf<"repository.checkpointed"> | PayloadOf<"sandbox.checkpointed">,
    at: Timestamp,
  ): void {
    this.git = {
      ...this.git,
      checkpoint: {
        checkpointId: payload.checkpointId,
        kind: payload.kind,
        headSha: payload.headSha,
        bundle: payload.bundle,
        reason: payload.reason,
        at,
      },
    };
  }

  // A turn diff is one run's change: the first per run adds the change card,
  // later ones replace it. Only the session diff moves the git summary.
  private onDiffUpdated(event: CommittedEventOf<"diff.updated">): void {
    const diff: DiffView = { ...event.payload, at: event.occurredAt };
    if (event.payload.scope === "turn") {
      if (!this.turnDiffs.read().has(event.runId)) {
        this.push({ kind: "changes", runId: event.runId, sequence: event.sessionSequence });
      }
      this.turnDiffs.write().set(event.runId, diff);
      return;
    }
    const { baseSha, headSha, files, additions, deletions } = event.payload;
    const changed = this.changedFiles.write();
    changed.clear();
    for (const file of files) {
      changed.set(file.path, file);
    }
    this.git = {
      ...this.git,
      baseSha,
      headSha,
      additions,
      deletions,
      sessionDiff: diff,
    };
  }

  private onGitCommitted(event: CommittedEventOf<"git.committed">): void {
    const p = event.payload;
    this.commits.write().push({
      hash: p.commitSha,
      parentSha: p.parentSha,
      branch: p.branch,
      message: p.message,
      authorName: p.authorName,
      authorInitials: initialsOf(p.authorName),
      authorType: p.authorType,
      date: p.committedAt,
      files: p.files,
      additions: p.additions,
      deletions: p.deletions,
      verificationState: p.verificationState,
      policy: p.policy,
    });
    this.git = { ...this.git, branch: p.branch, headSha: p.commitSha };
    this.push({ kind: "commit", sha: p.commitSha, sequence: event.sessionSequence });
  }

  private onPushRequested(event: CommittedEventOf<"git.push.requested">): void {
    const { pushId, branch, headSha, commitCount, policy } = event.payload;
    this.pushes.write().set(pushId, {
      pushId,
      state: "requested",
      branch,
      headSha,
      commitCount,
      policy,
      remoteSha: null,
      failure: null,
      at: event.occurredAt,
    });
    this.push({ kind: "push", pushId, change: "requested", sequence: event.sessionSequence });
  }

  private onPushCompleted(event: CommittedEventOf<"git.push.completed">): void {
    const { pushId, branch, headSha, remoteSha } = event.payload;
    const existing = this.pushes.read().get(pushId);
    this.pushes.write().set(pushId, {
      pushId,
      state: "completed",
      branch,
      headSha,
      commitCount: existing?.commitCount ?? null,
      policy: existing?.policy ?? null,
      remoteSha,
      failure: null,
      at: event.occurredAt,
    });
    this.push({ kind: "push", pushId, change: "completed", sequence: event.sessionSequence });
  }

  /**
   * Settles only the newest waiting push, because the control plane settles
   * exactly one publish per checkpoint (`finishPublish`). Older stranded
   * pushes are not explained by this failure.
   */
  private settlePushesOnFailedCheckpoint(
    event: CommittedEventOf<"sandbox.checkpoint_failed">,
  ): void {
    let waiting: PushId | null = null;
    for (const [pushId, push] of this.pushes.read()) {
      if (push.state === "requested") {
        waiting = pushId;
      }
    }
    if (waiting === null) {
      return;
    }
    const push = this.pushes.read().get(waiting);
    if (push === undefined) {
      return;
    }
    this.pushes.write().set(waiting, {
      ...push,
      state: "failed",
      failure: {
        category: "unknown",
        message: CHECKPOINT_FAILURE_TEXT[event.payload.failure],
        retryable: false,
      },
      at: event.occurredAt,
    });
    this.push({ kind: "push", pushId: waiting, change: "failed", sequence: event.sessionSequence });
  }

  private onPushFailed(event: CommittedEventOf<"git.push.failed">): void {
    const { pushId, branch, headSha, category, message, retryable } = event.payload;
    const existing = this.pushes.read().get(pushId);
    this.pushes.write().set(pushId, {
      pushId,
      state: "failed",
      branch,
      headSha,
      commitCount: existing?.commitCount ?? null,
      policy: existing?.policy ?? null,
      remoteSha: null,
      failure: { category, message, retryable },
      at: event.occurredAt,
    });
    this.push({ kind: "push", pushId, change: "failed", sequence: event.sessionSequence });
  }

  /** The object kept the push from GitHub: it reads as a failed push, with the object's sentence. */
  private onPushWithheld(event: CommittedEventOf<"git.push.withheld">): void {
    const { pushId, branch, message } = event.payload;
    const existing = this.pushes.read().get(pushId);
    this.pushes.write().set(pushId, {
      pushId,
      state: "failed",
      branch,
      headSha: null,
      commitCount: existing?.commitCount ?? null,
      policy: existing?.policy ?? null,
      remoteSha: null,
      failure: { category: "branch_not_pushable", message, retryable: false },
      at: event.occurredAt,
    });
    this.push({ kind: "push", pushId, change: "failed", sequence: event.sessionSequence });
  }

  private onPullRequestCreated(event: CommittedEventOf<"pull_request.created">): void {
    const p = event.payload;
    this.git = {
      ...this.git,
      pullRequest: {
        number: p.number,
        url: p.url,
        title: p.title,
        state: p.draft ? "draft" : "open",
        baseBranch: p.baseBranch,
        headBranch: p.headBranch,
        headSha: p.headSha,
        verificationSectionVersion: p.verificationSectionVersion,
        mergedSha: null,
        lastActor: null,
        updatedAt: event.occurredAt,
      },
    };
    this.push({
      kind: "pull_request",
      number: p.number,
      change: "created",
      sequence: event.sessionSequence,
    });
  }

  private pullRequestFor(number: number, at: Timestamp): PullRequestView {
    const existing = this.git.pullRequest;
    if (existing?.number === number) {
      return existing;
    }
    return {
      number,
      url: null,
      title: null,
      state: "open",
      baseBranch: null,
      headBranch: null,
      headSha: null,
      verificationSectionVersion: null,
      mergedSha: null,
      lastActor: null,
      updatedAt: at,
    };
  }

  private onPullRequestUpdated(event: CommittedEventOf<"pull_request.updated">): void {
    const { number, headSha, verificationSectionVersion } = event.payload;
    const existing = this.pullRequestFor(number, event.occurredAt);
    this.git = {
      ...this.git,
      pullRequest: {
        ...existing,
        headSha,
        verificationSectionVersion,
        updatedAt: event.occurredAt,
      },
    };
    this.push({
      kind: "pull_request",
      number,
      change: "updated",
      sequence: event.sessionSequence,
    });
  }

  private onPullRequestStateChanged(event: CommittedEventOf<"pull_request.state_changed">): void {
    const { number, to, actor, mergedSha, changedAt } = event.payload;
    const existing = this.pullRequestFor(number, event.occurredAt);
    this.git = {
      ...this.git,
      pullRequest: {
        ...existing,
        state: to,
        mergedSha: mergedSha ?? existing.mergedSha,
        lastActor: actor,
        updatedAt: changedAt,
      },
    };
    this.push({
      kind: "pull_request",
      number,
      change: "state_changed",
      sequence: event.sessionSequence,
    });
  }

  /**
   * Every update closes the open card: a held proposal was made against the
   * version this update replaces, and the session object drops it too.
   */
  private onPolicyUpdated(event: CommittedEventOf<"policy.updated">): void {
    const { proposalId, from, to, confirmedBy } = event.payload;
    this.scalars.policy = {
      ...this.scalars.policy,
      current: to,
      pendingProposal: null,
      lastUpdate: event.payload,
    };
    this.policyChange(event.sessionSequence, {
      kind: "updated",
      proposalId,
      from,
      to,
      confirmedBy,
    });
  }

  private policyChange(
    sequence: number,
    change: PolicyChangeView extends infer C
      ? C extends unknown
        ? Omit<C, "sequence">
        : never
      : never,
  ): void {
    this.scalars.policy = {
      ...this.scalars.policy,
      changes: [...this.scalars.policy.changes, { ...change, sequence } as PolicyChangeView],
    };
    this.push({ kind: "policy", change: change.kind, sequence });
  }

  private onSandboxProvisioning(event: CommittedEventOf<"sandbox.provisioning">): void {
    const { provider, ...provisioning } = event.payload;
    const attempt = provisioning.attempt > 1 ? `attempt ${provisioning.attempt}, ` : "";
    this.sandboxAction(event, "provisioning", {
      label: PROVISIONING_LABEL[provisioning.reason],
      detail: `${attempt}${CACHE_REUSE_DETAIL[provisioning.cacheReuse]}`,
      provider,
    });
    const current = this.scalars.sandbox;
    const sameGeneration = current.generation === event.sandboxGeneration;
    this.scalars.sandbox = {
      ...(sameGeneration ? current : EMPTY_SANDBOX),
      generation: event.sandboxGeneration,
      state: "provisioning",
      provider,
      provisioning,
      keepAlive: current.keepAlive,
      replacement: sameGeneration ? current.replacement : null,
    };
    this.moveCurrentRun("provisioning");
  }

  private onSandboxAttached(event: CommittedEventOf<"sandbox.attached">): void {
    const { provider, providerSandboxId, startupMs, expiresAt, cacheFallback } = event.payload;
    this.sandboxAction(event, "attached", {
      label: cacheFallback ? "Sandbox running, built without its cache" : "Sandbox running",
      detail: providerSandboxId,
      provider,
      durationMs: startupMs,
      providerSandboxId,
    });
    const current = this.scalars.sandbox;
    const sameGeneration = current.generation === event.sandboxGeneration;
    this.scalars.sandbox = {
      ...(sameGeneration ? current : EMPTY_SANDBOX),
      generation: event.sandboxGeneration,
      state: "attached",
      provider,
      providerSandboxId,
      startupMs,
      expiresAt,
      cacheFallback,
      keepAlive: current.keepAlive,
    };
  }

  private onReviewImported(event: CommittedEventOf<"review.imported">): void {
    const p = event.payload;
    const existing = this.reviewItems.read().get(p.reviewItemId);
    const actionState = existing?.actionState ?? "unreviewed";
    if (existing === undefined && isUnresolved(actionState)) {
      this.unresolvedCount += 1;
    }
    this.reviewItems.write().set(p.reviewItemId, {
      reviewItemId: p.reviewItemId,
      actionState,
      githubId: p.githubId,
      pullRequestNumber: p.pullRequestNumber,
      author: p.author,
      authorType: p.authorType,
      body: p.body,
      sourceType: p.sourceType,
      location: p.location,
      threadId: p.threadId,
      parentId: p.parentId,
      githubState: p.githubState,
      locationCurrent: p.locationCurrent,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      addressed: existing?.addressed ?? null,
      dismissal: existing?.dismissal ?? null,
    });
    if (existing === undefined) {
      this.push({
        kind: "review",
        reviewItemId: p.reviewItemId,
        change: "imported",
        sequence: event.sessionSequence,
      });
    }
  }

  private updateReview(
    reviewItemId: ReviewItemId,
    update: (item: ReviewItemView) => ReviewItemView,
  ): void {
    const existing = this.reviewItems.read().get(reviewItemId);
    if (existing === undefined) {
      return;
    }
    const next = update(existing);
    const was = isUnresolved(existing.actionState);
    const now = isUnresolved(next.actionState);
    if (was !== now) {
      this.unresolvedCount += now ? 1 : -1;
    }
    this.reviewItems.write().set(reviewItemId, next);
  }

  private onVerificationStarted(event: CommittedEventOf<"verification.started">): void {
    const p = event.payload;
    const existing = this.checks.read().get(p.checkId);
    const attempt: CheckAttemptView = {
      attempt: p.attempt,
      startedAt: event.occurredAt,
      result: null,
    };
    const attempts = existing === undefined ? [attempt] : [...existing.attempts, attempt];
    this.checks.write().set(p.checkId, {
      checkId: p.checkId,
      runId: event.runId,
      name: p.name,
      category: p.category,
      classification: p.classification,
      source: p.source,
      method: p.method,
      revision: p.revision,
      baseRevision: p.baseRevision,
      status: "running",
      attempts,
      latest: attempt,
    });
    if (existing === undefined) {
      this.push({ kind: "check", checkId: p.checkId, sequence: event.sessionSequence });
    }
  }

  private onVerificationResult(event: CommittedEventOf<"verification.result">): void {
    const p = event.payload;
    const existing = this.checks.read().get(p.checkId);
    const attempts = [...(existing?.attempts ?? [])];
    const index = attempts.findIndex((candidate) => candidate.attempt === p.attempt);
    const previous = index === -1 ? undefined : attempts[index];
    const attempt: CheckAttemptView = {
      attempt: p.attempt,
      startedAt: previous?.startedAt ?? null,
      result: p,
    };
    if (previous === undefined) {
      attempts.push(attempt);
    } else {
      attempts[index] = attempt;
    }
    const latest = attempts[attempts.length - 1] ?? attempt;
    this.checks.write().set(p.checkId, {
      checkId: p.checkId,
      runId: existing?.runId ?? event.runId,
      name: existing?.name ?? p.checkId,
      category: existing?.category ?? null,
      classification: existing?.classification ?? null,
      source: existing?.source ?? null,
      method: existing?.method ?? null,
      revision: existing?.revision ?? null,
      baseRevision: existing?.baseRevision ?? null,
      status: checkStatusOf(latest),
      attempts,
      latest,
    });
    if (existing === undefined) {
      this.push({ kind: "check", checkId: p.checkId, sequence: event.sessionSequence });
    }
  }

  // Question events are rare, so the map is copied whole on each.
  private onQuestionAsked(event: CommittedEventOf<"question.asked">): void {
    const p = event.payload;
    if (this.scalars.questions.has(p.questionId)) {
      return;
    }
    const questions = new Map(this.scalars.questions);
    questions.set(p.questionId, {
      questionId: p.questionId,
      runId: event.runId,
      toolCallId: p.toolCallId,
      questions: p.questions,
      state: "open",
      answers: null,
      dismissal: null,
      askedAt: event.occurredAt,
      settledAt: null,
    });
    this.scalars.questions = questions;
    this.scalars.openQuestionId = p.questionId;
    this.push({ kind: "question", questionId: p.questionId, sequence: event.sessionSequence });
  }

  private settleQuestion(
    event: CommittedEvent,
    questionId: QuestionId,
    state: "answered" | "dismissed",
    answers: readonly (readonly string[])[] | null,
    dismissal: QuestionView["dismissal"] = null,
  ): void {
    const existing = this.scalars.questions.get(questionId);
    if (existing === undefined || existing.state !== "open") {
      return;
    }
    const questions = new Map(this.scalars.questions);
    questions.set(questionId, {
      ...existing,
      state,
      answers,
      dismissal,
      settledAt: event.occurredAt,
    });
    this.scalars.questions = questions;
    if (this.scalars.openQuestionId === questionId) {
      this.scalars.openQuestionId = null;
    }
  }

  private onApprovalRequested(event: CommittedEventOf<"approval.requested">): void {
    const p = event.payload;
    const approval: ApprovalView = {
      approvalId: p.approvalId,
      runId: event.runId,
      state: "requested",
      title: p.title,
      intendedAction: p.intendedAction,
      category: p.category,
      risk: p.risk,
      resource: p.resource,
      requestedScope: p.requestedScope,
      expiresAt: p.expiresAt,
      toolCallId: p.toolCallId,
      toolCategory: p.toolCategory ?? null,
      ...(p.agentId === undefined ? {} : { agentId: p.agentId }),
      requestedAt: event.occurredAt,
      resolution: null,
      expiredEffect: null,
      delivered: null,
    };
    const existing = this.approvals.read().get(p.approvalId);
    this.approvals.write().set(p.approvalId, approval);
    if (existing === undefined) {
      this.openApprovalIds.write().push(p.approvalId);
    }
    // Record 04, approval flow step 2.
    this.moveCurrentRun("waiting_for_approval");
    this.refreshToolApproval(approval);
    this.push({
      kind: "approval",
      approvalId: p.approvalId,
      change: "requested",
      sequence: event.sessionSequence,
    });
  }

  private closeApproval(approval: ApprovalView, resumeRun: boolean): void {
    this.approvals.write().set(approval.approvalId, approval);
    const open = this.openApprovalIds.read();
    const index = open.indexOf(approval.approvalId);
    if (index !== -1) {
      this.openApprovalIds.write().splice(index, 1);
    }
    if (resumeRun && this.openApprovalIds.read().length === 0) {
      this.moveCurrentRun("running");
    }
    this.refreshToolApproval(approval);
  }

  private onApprovalResolved(event: CommittedEventOf<"approval.resolved">): void {
    const p = event.payload;
    const existing = this.approvals.read().get(p.approvalId);
    if (existing === undefined) {
      return;
    }
    this.closeApproval(
      {
        ...existing,
        state: p.decision,
        resolution: {
          decision: p.decision,
          decidedBy: p.decidedBy,
          commandId: p.commandId,
          decidedForGeneration: p.decidedForGeneration,
          scope: p.scope ?? "once",
          automatic: p.automatic === true,
          at: event.occurredAt,
        },
      },
      true,
    );
    this.push({
      kind: "approval",
      approvalId: p.approvalId,
      change: "resolved",
      sequence: event.sessionSequence,
    });
  }

  private onSecretsSupplied(event: CommittedEventOf<"secrets.supplied">): void {
    const p = event.payload;
    if (p.approvalId === null) {
      this.push({
        kind: "secrets_supplied",
        names: p.names,
        delivered: p.delivered,
        sequence: event.sessionSequence,
      });
      return;
    }
    const existing = this.approvals.read().get(p.approvalId);
    if (existing !== undefined) {
      this.approvals.write().set(p.approvalId, { ...existing, delivered: p.delivered });
    }
  }

  // The run's own move after an expiry arrives as run.paused or run.failed;
  // only a denied tool lets work continue without a further run event.
  private onApprovalExpired(event: CommittedEventOf<"approval.expired">): void {
    const p = event.payload;
    const existing = this.approvals.read().get(p.approvalId);
    if (existing === undefined) {
      return;
    }
    this.closeApproval(
      { ...existing, state: "expired", expiredEffect: p.effect },
      p.effect === "tool_denied",
    );
    this.push({
      kind: "approval",
      approvalId: p.approvalId,
      change: "expired",
      sequence: event.sessionSequence,
    });
  }

  private onArtifactUploading(event: CommittedEventOf<"artifact.uploading">): void {
    const p = event.payload;
    const existing = this.artifacts.read().get(p.artifactId);
    if (existing !== undefined && existing.state === "created") {
      return;
    }
    this.artifacts.write().set(p.artifactId, {
      artifactId: p.artifactId,
      state: "uploading",
      kind: p.kind,
      contentType: p.contentType,
      producer: p.producer,
      declaredBytes: p.declaredBytes,
      ref: null,
      checksum: null,
      classification: null,
      expiresAt: null,
      supersedes: null,
      failure: null,
      at: event.occurredAt,
    });
  }

  private onArtifactCreated(event: CommittedEventOf<"artifact.created">): void {
    const p = event.payload;
    const existing = this.artifacts.read().get(p.artifact.artifactId);
    this.artifacts.write().set(p.artifact.artifactId, {
      artifactId: p.artifact.artifactId,
      state: "created",
      kind: p.artifact.kind,
      contentType: p.artifact.contentType,
      producer: p.producer,
      declaredBytes: existing?.declaredBytes ?? null,
      ref: p.artifact,
      checksum: p.checksum,
      classification: p.classification,
      expiresAt: p.expiresAt,
      supersedes: p.supersedes,
      failure: null,
      at: event.occurredAt,
    });
    this.push({
      kind: "artifact",
      artifactId: p.artifact.artifactId,
      sequence: event.sessionSequence,
    });
  }

  private onArtifactFailed(event: CommittedEventOf<"artifact.failed">): void {
    const { artifactId, ...failure } = event.payload;
    const existing = this.artifacts.read().get(artifactId);
    if (existing === undefined) {
      return;
    }
    this.artifacts.write().set(artifactId, { ...existing, state: "failed", failure });
  }
}

export function applyEvent(view: SessionView, event: CommittedEvent): SessionView {
  const draft = new Draft(view);
  draft.admit(event);
  return draft.finish();
}

export function applyLiveEvent(
  view: SessionView,
  event: ProtocolEventOf<EphemeralEventType>,
): SessionView {
  const draft = new Draft(view);
  draft.applyLive(event);
  return draft.finish();
}

export function foldEvents(
  events: Iterable<CommittedEvent>,
  from: SessionView = emptyView(),
): SessionView {
  const draft = new Draft(from);
  for (const event of events) {
    draft.admit(event);
  }
  return draft.finish();
}

/**
 * A subagent's status as shown. One still running was taken down, whether or
 * not its own end was reported, when its run has ended, when its run is
 * interrupted (its sandbox was lost or is being replaced), or when its run has
 * since started on another sandbox than the one the subagent ran in.
 */
export function agentStatusOf(view: SessionView, agent: AgentView): AgentStatus {
  if (agent.status !== "running") {
    return agent.status;
  }
  const run = view.runs.get(agent.runId);
  if (run === undefined) {
    return "running";
  }
  const gone =
    run.ending !== null ||
    run.state === "interrupted" ||
    run.sandboxGeneration !== agent.sandboxGeneration;
  return gone ? "cancelled" : "running";
}

// After a reconnect the live buffers describe a stream the client is no
// longer on; the replayed committed events carry everything durable.
export function discardLive(view: SessionView): SessionView {
  if (
    view.live.messages.size === 0 &&
    view.live.toolOutput.size === 0 &&
    view.live.heartbeat === null
  ) {
    return view;
  }
  // Only a call still streaming loses output here: the replay carries no
  // `tool.output`, so the rest is gone. A finished call's tail is already
  // complete, and a cap cut was flagged by `appendToolOutput`.
  const tools = new Map(view.tools);
  for (const [toolCallId, live] of view.live.toolOutput) {
    const tool = view.tools.get(toolCallId);
    if (live.streaming && tool !== undefined && !tool.outputDropped) {
      tools.set(toolCallId, { ...tool, outputDropped: true });
    }
  }
  return {
    ...view,
    tools,
    live: { messages: new Map(), toolOutput: new Map(), heartbeat: null },
  };
}

// Record 13's display statuses, plus `idle` for a session with no run.
export const DISPLAY_STATUSES = [
  "idle",
  "starting_environment",
  "working",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
  "resuming",
  "verified",
  "completed_with_warnings",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export function displayStatusOf(view: SessionView): DisplayStatus {
  const run = view.run;
  if (run === null) {
    return "idle";
  }
  const resuming = run.pause !== null || run.interruption !== null;
  // An open question waits on the user whatever the run is doing meanwhile;
  // an approval card is the more specific answer when both are open.
  if (
    view.openQuestionId !== null &&
    run.outcome === null &&
    run.state !== "waiting_for_approval"
  ) {
    return "waiting_for_input";
  }
  switch (run.state) {
    case "created":
    case "queued":
    case "provisioning":
      return resuming ? "resuming" : "starting_environment";
    case "ready":
    case "running":
      return "working";
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "paused":
      switch (run.pause?.reason) {
        case "model_failure":
        case "no_progress":
        case "approval_expired":
          return "waiting_for_input";
        default:
          return "paused";
      }
    // Only the planned replacement at the lifetime ceiling resumes on its
    // own; every other interruption waits for the user to continue it.
    case "interrupted":
      return run.interruption?.reason === "sandbox_replaced" ? "resuming" : "paused";
    case "verified":
    case "completed_with_warnings":
    case "completed":
    case "blocked":
    case "failed":
    case "cancelled":
      return run.state;
    default:
      return assertNever(run.state, "unhandled run state");
  }
}
