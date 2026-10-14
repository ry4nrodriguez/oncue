import { describe, expect, it } from "vitest";
import { type DurableEventType, type EphemeralEventType, EVENT_CATALOG } from "./catalog";
import {
  type BuildInput,
  buildEvent,
  type CommittedEvent,
  type CommittedEventOf,
  type PayloadInputOf,
  type PayloadOf,
  type ProtocolEventOf,
} from "./events";
import { LIMITS } from "./schema";
import {
  applyEvent,
  applyLiveEvent,
  chainStatusOf,
  DISPLAY_STATUSES,
  discardLive,
  displayStatusOf,
  emptyView,
  foldEvents,
  initialsOf,
  LIVE_TERMINAL_CAP,
  NO_RUNTIME,
  type SessionView,
  TOOL_OUTPUT_TAIL_CHARS,
  TOOL_OUTPUT_TAIL_CHUNKS,
  type ToolView,
  toolUiState,
} from "./view";

const T0 = "2026-09-01T12:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
const SHA256 = "b".repeat(64);

const screenshot = {
  artifactId: "art_shot",
  kind: "screenshot",
  contentType: "image/png",
  byteSize: 2048,
  label: "home page",
} as const;

const model = {
  provider: "anthropic",
  modelId: "claude-sonnet",
  modelConnectionId: "conn_1",
  authenticationType: "api_key",
  contextWindow: 200000,
  effort: null,
} as const;

const summary = {
  whatChanged: "Fixed the login redirect.",
  why: "The redirect dropped the return path.",
  verificationPerformed: "Ran the unit suite.",
  limitations: [],
  nextStep: null,
} satisfies PayloadInputOf<"run.verified">["summary"];

const policy = {
  version: 1,
  commit: "auto",
  push: "manual",
  pullRequest: "manual",
  planApproval: "proceed",
  fileEdits: "allowed",
} as const;

const outcomeTail = {
  evidence: [],
  branch: "oncue/task-1",
  pullRequestNumber: null,
  usage: null,
  durationMs: 1000,
} satisfies Pick<
  PayloadInputOf<"run.verified">,
  "evidence" | "branch" | "pullRequestNumber" | "usage" | "durationMs"
>;

type EmitOptions = {
  readonly runId?: string;
  readonly generation?: number;
  readonly at?: string;
};

// Assigns session sequences the way the Durable Object does: one counter,
// in commit order, independent of the runtime sequence on sandbox events.
class Stream {
  private sequence = 0;
  private runtimeSequence = 100;
  readonly events: CommittedEvent[] = [];

  emit<T extends DurableEventType>(
    type: T,
    payload: PayloadInputOf<T>,
    options: EmitOptions = {},
  ): CommittedEventOf<T> {
    const spec = EVENT_CATALOG[type];
    this.sequence += 1;
    this.runtimeSequence += 1;
    const input = {
      eventId: `evt_${this.sequence}`,
      sessionId: "sess_1",
      runId: spec.scope === "run" ? (options.runId ?? "run_1") : null,
      sandboxGeneration: options.generation ?? 1,
      runtimeSequence: spec.origin === "control" ? null : this.runtimeSequence,
      occurredAt: options.at ?? T0,
      payload,
    } as BuildInput<T>;
    const event = {
      ...buildEvent(type, input),
      sessionSequence: this.sequence,
      committedAt: options.at ?? T0,
    } as CommittedEventOf<T>;
    this.events.push(event);
    return event;
  }

  fold(): SessionView {
    return foldEvents(this.events);
  }
}

function live<T extends EphemeralEventType>(
  type: T,
  payload: PayloadInputOf<T>,
  runtimeSequence = 900,
): ProtocolEventOf<T> {
  const spec = EVENT_CATALOG[type];
  return buildEvent(type, {
    eventId: `live_${runtimeSequence}`,
    sessionId: "sess_1",
    runId: spec.scope === "run" ? "run_1" : null,
    sandboxGeneration: 1,
    runtimeSequence,
    occurredAt: T0,
    payload,
  } as BuildInput<T>);
}

function startRun(stream: Stream, runId = "run_1"): void {
  stream.emit(
    "run.queued",
    {
      commandId: `cmd_${runId}`,
      instruction: { messageId: `msg_user_${runId}`, text: "Fix the login bug", attachments: [] },
      model,
      trigger: "initial",
      continuesRunId: null,
    },
    { runId },
  );
  stream.emit("sandbox.provisioning", {
    provider: "modal",
    reason: "initial",
    attempt: 1,
    cacheReuse: "repository_environment",
  });
  stream.emit("sandbox.attached", {
    provider: "modal",
    providerSandboxId: "sb_1",
    startupMs: 1200,
    expiresAt: "2026-09-02T12:00:00.000Z",
    cacheFallback: false,
  });
  stream.emit("runtime.connected", {
    bridgeVersion: "0.1.0",
    runtimeName: "opencode",
    runtimeVersion: "1.0.0",
    protocolVersion: 1,
    capabilities: ["tools"],
  });
  stream.emit("runtime.ready", {
    runtimeName: "opencode",
    runtimeVersion: "1.0.0",
    healthChecks: [{ name: "git", passed: true }],
    startupMs: 300,
  });
  stream.emit(
    "run.started",
    { baseSha: SHA, branch: "oncue/task-1", resumedFrom: null },
    { runId },
  );
}

function requestTool(
  stream: Stream,
  toolCallId: string,
  approvalId: string | null = null,
): CommittedEventOf<"tool.requested"> {
  return stream.emit("tool.requested", {
    toolCallId,
    category: "shell",
    title: "pnpm test",
    runtimeName: "bash",
    input: { command: "pnpm test" },
    inputComplete: true,
    approvalId,
  });
}

function completeTool(stream: Stream, toolCallId: string): CommittedEventOf<"tool.completed"> {
  return stream.emit("tool.completed", {
    toolCallId,
    durationMs: 250,
    exitCode: 0,
    result: { kind: "inline", summary: "42 passed", value: { passed: 42 } },
  });
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

function tool(view: SessionView, toolCallId: string): ToolView {
  const found = view.tools.get(toolCallId as ToolView["toolCallId"]);
  if (found === undefined) {
    throw new Error(`tool ${toolCallId} missing`);
  }
  return found;
}

function fullStream(): Stream {
  const stream = new Stream();
  startRun(stream);
  stream.emit("message.started", { messageId: "msg_a1", role: "assistant" });
  stream.emit("status.updated", {
    stepId: "step_1",
    phase: "investigating",
    label: "Reading the router",
    description: "Looking at redirect handling",
    status: "active",
  });
  stream.emit("plan.created", {
    planId: "plan_1",
    revision: 1,
    title: "Fix redirect",
    description: "Two steps",
    steps: [
      { stepId: "s1", title: "Find the bug", status: "complete" },
      { stepId: "s2", title: "Fix and test", status: "active" },
      { stepId: "s3", title: "Open PR", status: "pending" },
    ],
    activeStepId: "s2",
    expectedVerification: ["pnpm test"],
  });
  stream.emit("tool.requested", {
    toolCallId: "tc_read",
    category: "file_read",
    title: "Read router.ts",
    runtimeName: "read",
    input: { path: "src/router.ts" },
    inputComplete: true,
    approvalId: null,
  });
  stream.emit("tool.started", { toolCallId: "tc_read" });
  stream.emit("tool.completed", {
    toolCallId: "tc_read",
    durationMs: 12,
    exitCode: null,
    result: { kind: "none", summary: "120 lines" },
  });
  requestTool(stream, "tc_push", "apr_1");
  stream.emit("approval.requested", {
    approvalId: "apr_1",
    title: "Push to origin",
    intendedAction: "Push the task branch",
    category: "external_action",
    risk: "medium",
    resource: "github.com/acme/app",
    requestedScope: "oncue/task-1",
    expiresAt: "2026-09-01T13:00:00.000Z",
    toolCallId: "tc_push",
  });
  stream.emit("approval.resolved", {
    approvalId: "apr_1",
    decision: "approved",
    decidedBy: "user_1",
    commandId: "cmd_apr_1",
    decidedForGeneration: 1,
  });
  stream.emit("tool.started", { toolCallId: "tc_push" });
  completeTool(stream, "tc_push");
  stream.emit("file.changed", {
    change: { path: "src/router.ts", status: "modified", additions: 4, deletions: 1 },
    byAgent: true,
  });
  stream.emit("artifact.uploading", {
    artifactId: "art_shot",
    kind: "screenshot",
    contentType: "image/png",
    declaredBytes: 2048,
    producer: "screenshot",
  });
  stream.emit("artifact.created", {
    artifact: screenshot,
    checksum: { algorithm: "sha256", value: SHA256 },
    producer: "screenshot",
    classification: "essential_evidence",
    expiresAt: null,
    supersedes: null,
  });
  stream.emit("git.committed", {
    commitSha: SHA2,
    parentSha: SHA,
    branch: "oncue/task-1",
    message: "Fix login redirect",
    authorType: "agent",
    authorName: "OnCue Agent",
    committedAt: "2026-09-01T12:05:00.000Z",
    files: [{ path: "src/router.ts", status: "modified", additions: 4, deletions: 1 }],
    additions: 4,
    deletions: 1,
    verificationState: "none",
    policy: { policyVersion: 1, rule: "auto_commit", approvalId: null },
  });
  stream.emit("verification.started", {
    checkId: "chk_unit",
    name: "Unit tests",
    category: "test",
    classification: "required",
    source: "repository_requirement",
    method: { kind: "command", command: "pnpm test", cwd: null },
    revision: SHA2,
    baseRevision: SHA,
    attempt: 1,
    reason: "package.json script test",
  });
  stream.emit("verification.result", {
    checkId: "chk_unit",
    attempt: 1,
    result: "passed",
    skipReason: null,
    inconclusiveReason: null,
    exitCode: 0,
    durationMs: 3000,
    summary: "42 passed",
    baseComparison: "not_compared",
    structured: {
      passed: 42,
      failed: 0,
      skipped: 1,
      total: 43,
      durationMs: 3000,
      suites: [
        {
          name: "router",
          status: "passed",
          tests: [{ name: "redirects home", status: "passed", durationMs: 4 }],
        },
      ],
    },
    evidence: [],
  });
  stream.emit("verification.completed", {
    proposedOutcome: "verified",
    required: { total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0 },
    recommended: { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0 },
    warnings: [],
    userSkipped: [],
    baselineComparisonAvailable: true,
  });
  stream.emit("repository.status", {
    branch: "oncue/task-1",
    headSha: SHA2,
    baseSha: SHA,
    ahead: 1,
    behind: 0,
    dirty: false,
    changedFileCount: 1,
    untrackedFileCount: 0,
    additions: 4,
    deletions: 1,
  });
  stream.emit("git.push.requested", {
    pushId: "push_1",
    branch: "oncue/task-1",
    headSha: SHA2,
    commitCount: 1,
    policy: { policyVersion: 1, rule: "explicit_approval", approvalId: "apr_1" },
  });
  stream.emit("git.push.completed", {
    pushId: "push_1",
    branch: "oncue/task-1",
    headSha: SHA2,
    remoteSha: SHA2,
  });
  stream.emit("pull_request.created", {
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Fix login redirect",
    draft: true,
    baseBranch: "main",
    headBranch: "oncue/task-1",
    headSha: SHA2,
    verificationSectionVersion: 1,
  });
  stream.emit("plan.updated", {
    planId: "plan_1",
    revision: 2,
    title: "Fix redirect",
    description: "Two steps",
    steps: [
      { stepId: "s1", title: "Find the bug", status: "complete" },
      { stepId: "s2", title: "Fix and test", status: "complete" },
      { stepId: "s3", title: "Open PR", status: "complete" },
    ],
    activeStepId: null,
    expectedVerification: ["pnpm test"],
    changeSummary: null,
  });
  stream.emit("plan.completed", { planId: "plan_1", revision: 2, summary: "All steps done" });
  stream.emit("status.updated", {
    stepId: "step_1",
    phase: "finishing",
    label: "Reading the router",
    status: "complete",
  });
  stream.emit("message.completed", {
    messageId: "msg_a1",
    role: "assistant",
    parts: [
      { type: "reasoning_summary", text: "Checked the redirect path", durationMs: 800 },
      { type: "text", text: "Fixed and pushed." },
      { type: "tool_ref", toolCallId: "tc_push" },
      { type: "code", code: "return next", language: "typescript" },
    ],
    stopReason: "end_turn",
    usage: { usedTokens: 5000, maxTokens: 200000, inputTokens: 4000, outputTokens: 1000 },
  });
  stream.emit("run.verified", { summary, ...outcomeTail, pullRequestNumber: 7 });
  stream.emit("review.imported", {
    reviewItemId: "rev_1",
    githubId: "gh_1",
    pullRequestNumber: 7,
    author: "octocat",
    authorType: "human",
    body: "Please add a test",
    sourceType: "review_comment",
    location: { path: "src/router.ts", line: 10, side: "RIGHT", commitSha: SHA2 },
    threadId: null,
    parentId: null,
    githubState: "changes_requested",
    locationCurrent: true,
    createdAt: T0,
    updatedAt: T0,
  });
  stream.emit("policy.proposed", {
    proposalId: "prop_1",
    triggeringMessageId: null,
    from: policy,
    to: { ...policy, version: 2, push: "auto" },
    direction: "widening",
    rationale: "Push after each verified commit",
  });
  stream.emit("policy.updated", {
    proposalId: "prop_1",
    from: policy,
    to: { ...policy, version: 2, push: "auto" },
    confirmedBy: "user_confirmation",
    userId: "user_1",
    effectiveAt: T0,
  });
  stream.emit("command.acknowledged", {
    commandId: "cmd_run_1",
    commandType: "run.start",
    acceptedBy: "control_plane",
  });
  stream.emit("sandbox.keepalive.updated", {
    expiresAt: "2026-09-01T14:00:00.000Z",
    requestedBy: "user",
    minutes: 120,
  });
  stream.emit("sandbox.idle", {
    idleSince: T0,
    stopAt: "2026-09-01T12:30:00.000Z",
    keepAliveUntil: null,
  });
  stream.emit("sandbox.checkpointed", {
    checkpointId: "ckpt_1",
    kind: "branch_push",
    headSha: SHA2,
    bundle: null,
    reason: "idle",
    durationMs: 900,
  });
  stream.emit("sandbox.stopped", {
    outcome: "stopped",
    reason: "idle",
    checkpointId: "ckpt_1",
    unsavedWorkWarning: null,
    diagnostics: [],
  });
  return stream;
}

describe("folding a full stream", () => {
  const view = fullStream().fold();

  it("tracks the session and the applied cursor", () => {
    expect(view.sessionId).toBe("sess_1");
    expect(view.appliedThrough).toBe(41);
    expect(view.stream).toEqual({ pending: new Map(), awaiting: null });
  });

  it("carries the run state, outcome, and ending", () => {
    expect(view.run?.runId).toBe("run_1");
    expect(view.run?.state).toBe("verified");
    expect(view.run?.outcome).toBe("verified");
    expect(view.run?.ending).toMatchObject({ outcome: "verified", summary, pullRequestNumber: 7 });
    expect(view.run?.model).toEqual(model);
    expect(view.run?.branch).toBe("oncue/task-1");
    expect(view.run?.baseSha).toBe(SHA);
    expect(view.run?.startedAt).toBe(T0);
    expect(view.run?.endedAt).toBe(T0);
    expect(view.runs.get(must(view.run).runId)).toBe(view.run);
    expect(displayStatusOf(view)).toBe("verified");
  });

  it("orders the timeline by session sequence and keeps identity only", () => {
    const sequences = view.timeline.map((item) => item.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(view.timeline.map((item) => item.kind)).toEqual([
      "message",
      "sandbox",
      "run",
      "message",
      "progress",
      "plan",
      "tool",
      "tool",
      "approval",
      "approval",
      "artifact",
      "commit",
      "check",
      "verification",
      "push",
      "push",
      "pull_request",
      "plan",
      "run",
      "review",
      "policy",
      "policy",
    ]);
    expect(view.policy.changes.map((change) => change.kind)).toEqual(["proposed", "updated"]);
    for (const item of view.timeline) {
      expect(Object.keys(item).length).toBeLessThanOrEqual(4);
    }
  });

  it("renders messages with a role and a parts array for the Message component", () => {
    const user = view.messages.get(must(must(view.run).instructionMessageId));
    expect(user).toMatchObject({
      role: "user",
      streaming: false,
      parts: [{ type: "text", text: "Fix the login bug" }],
    });
    const assistant = view.messages.get("msg_a1" as never);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.stopReason).toBe("end_turn");
    expect(assistant?.usage).toEqual({
      usedTokens: 5000,
      maxTokens: 200000,
      inputTokens: 4000,
      outputTokens: 1000,
    });
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      "reasoning_summary",
      "text",
      "tool_ref",
      "code",
    ]);
    expect(assistant?.parts[0]).toEqual({
      type: "reasoning_summary",
      text: "Checked the redirect path",
      durationMs: 800,
    });
    expect(assistant?.parts[3]).toEqual({
      type: "code",
      code: "return next",
      language: "typescript",
    });
  });

  it("renders tool calls with the Tool component's state and fields", () => {
    const read = tool(view, "tc_read");
    expect(read).toMatchObject({
      state: "output-available",
      title: "Read router.ts",
      runtimeName: "read",
      category: "file_read",
      input: { path: "src/router.ts" },
      approval: null,
      startedAt: T0,
      durationMs: 12,
      result: { kind: "none", summary: "120 lines" },
      failure: null,
    });
    const push = tool(view, "tc_push");
    expect(push.state).toBe("output-available");
    expect(push.approval).toEqual({
      approvalId: "apr_1",
      state: "approved",
      decision: "approved",
      decidedBy: "user_1",
    });
    expect(push.result).toEqual({ kind: "inline", summary: "42 passed", value: { passed: 42 } });
  });

  it("renders the active plan and its steps for Plan, Task, and ChainOfThought", () => {
    expect(view.plan).toMatchObject({
      planId: "plan_1",
      state: "completed",
      revision: 2,
      title: "Fix redirect",
      description: "Two steps",
      activeStepId: null,
      completionSummary: "All steps done",
    });
    expect(view.plan?.steps.map((step) => [step.title, step.status, step.chainStatus])).toEqual([
      ["Find the bug", "complete", "complete"],
      ["Fix and test", "complete", "complete"],
      ["Open PR", "complete", "complete"],
    ]);
    expect(view.plans.get(must(view.plan).planId)).toBe(view.plan);
  });

  it("renders progress steps with a label, description, and status", () => {
    expect([...view.progress.values()]).toEqual([
      {
        stepId: "step_1",
        runId: "run_1",
        phase: "finishing",
        label: "Reading the router",
        description: null,
        status: "complete",
        at: T0,
      },
    ]);
  });

  it("renders verification checks, attempts, test results, and the rollup", () => {
    const check = view.verification.checks.get("chk_unit" as never);
    expect(check).toMatchObject({
      name: "Unit tests",
      classification: "required",
      status: "passed",
      method: { kind: "command", command: "pnpm test" },
    });
    expect(check?.attempts).toHaveLength(1);
    expect(check?.latest?.startedAt).toBe(T0);
    expect(check?.latest?.result?.structured).toMatchObject({
      passed: 42,
      failed: 0,
      skipped: 1,
      total: 43,
      durationMs: 3000,
      suites: [{ name: "router", status: "passed" }],
    });
    expect(view.verification.summaries.get("run_1" as never)).toMatchObject({
      runId: "run_1",
      proposedOutcome: "verified",
      required: { total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0 },
      baselineComparisonAvailable: true,
    });
  });

  it("renders git state, commits, pushes, and the pull request", () => {
    expect(view.git).toMatchObject({
      branch: "oncue/task-1",
      baseSha: SHA,
      headSha: SHA2,
      ahead: 1,
      behind: 0,
      dirty: false,
      additions: 4,
      deletions: 1,
    });
    expect([...view.git.changedFiles.keys()]).toEqual(["src/router.ts"]);
    expect(view.git.commits).toEqual([
      expect.objectContaining({
        hash: SHA2,
        message: "Fix login redirect",
        authorInitials: "OA",
        date: "2026-09-01T12:05:00.000Z",
        files: [{ path: "src/router.ts", status: "modified", additions: 4, deletions: 1 }],
      }),
    ]);
    expect(view.git.pushes.get("push_1" as never)).toMatchObject({
      state: "completed",
      commitCount: 1,
      remoteSha: SHA2,
    });
    expect(view.git.pullRequest).toMatchObject({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      state: "draft",
      headSha: SHA2,
      verificationSectionVersion: 1,
    });
    expect(view.git.checkpoint).toMatchObject({ checkpointId: "ckpt_1", reason: "idle" });
  });

  it("renders approvals, artifacts, reviews, policy, commands, and the sandbox", () => {
    expect(view.openApprovalIds).toEqual([]);
    expect(view.approvals.get("apr_1" as never)).toMatchObject({
      state: "approved",
      title: "Push to origin",
      risk: "medium",
      resource: "github.com/acme/app",
      resolution: { decision: "approved", decidedBy: "user_1", decidedForGeneration: 1 },
    });
    expect(view.artifacts.get("art_shot" as never)).toMatchObject({
      state: "created",
      kind: "screenshot",
      declaredBytes: 2048,
      ref: screenshot,
      classification: "essential_evidence",
    });
    expect(view.reviews.unresolvedCount).toBe(1);
    expect(view.reviews.items.get("rev_1" as never)?.actionState).toBe("unreviewed");
    expect(view.policy.current?.push).toBe("auto");
    expect(view.policy.pendingProposal).toBeNull();
    expect(view.commands.get("cmd_run_1" as never)?.state).toBe("acknowledged");
    expect(view.sandbox).toMatchObject({
      generation: 1,
      state: "stopped",
      provider: "modal",
      providerSandboxId: "sb_1",
      expiresAt: "2026-09-02T12:00:00.000Z",
      idleSince: T0,
      keepAlive: { minutes: 120, requestedBy: "user" },
      runtime: { connected: true, ready: true, runtimeName: "opencode" },
    });
    expect(view.sandbox.stop?.reason).toBe("idle");
  });

  it("keeps the live buffers empty when nothing ephemeral was applied", () => {
    expect(view.live).toEqual({ messages: new Map(), toolOutput: new Map(), heartbeat: null });
  });
});

describe("idempotency and ordering (record 04)", () => {
  it("returns the same view reference for a duplicate event", () => {
    const stream = fullStream();
    let view = emptyView();
    for (const event of stream.events) {
      view = applyEvent(view, event);
      const again = applyEvent(view, event);
      expect(again).toBe(view);
    }
    const replayed = foldEvents([...stream.events, ...stream.events]);
    expect(replayed).toEqual(view);
    expect(applyEvent(view, must(stream.events[3]))).toBe(view);
  });

  it("folds the same view from any arrival order", () => {
    const stream = fullStream();
    const inOrder = stream.fold();
    const reversed = foldEvents([...stream.events].reverse());
    expect(reversed).toEqual(inOrder);
    const interleaved = stream.events.flatMap((event, index) =>
      index % 2 === 0 ? [] : [event, must(stream.events[index - 1])],
    );
    if (stream.events.length % 2 === 1) {
      interleaved.push(must(stream.events.at(-1)));
    }
    expect(foldEvents(interleaved)).toEqual(inOrder);
  });

  it("holds an event past a gap without applying it and says what it is waiting for", () => {
    const stream = fullStream();
    const [first, second, third] = stream.events as [
      CommittedEvent,
      CommittedEvent,
      CommittedEvent,
    ];
    let view = applyEvent(emptyView(), first);
    view = applyEvent(view, third);
    expect(view.appliedThrough).toBe(1);
    expect(view.stream.awaiting).toBe(2);
    expect(view.stream.pending.get(3)).toBe(third);
    expect(view.sandbox.state).toBeNull();
    expect(applyEvent(view, third)).toBe(view);
    view = applyEvent(view, second);
    expect(view.appliedThrough).toBe(3);
    expect(view.stream.awaiting).toBeNull();
    expect(view.stream.pending.size).toBe(0);
    expect(view.sandbox.state).toBe("attached");
  });

  it("orders by session sequence even when runtime sequence disagrees", () => {
    const stream = new Stream();
    startRun(stream);
    const a = stream.emit("message.started", { messageId: "msg_1", role: "assistant" });
    const b = stream.emit("message.started", { messageId: "msg_2", role: "assistant" });
    const swapped = [
      { ...a, sessionSequence: b.sessionSequence },
      { ...b, sessionSequence: a.sessionSequence },
    ];
    expect(must(swapped[0]).runtimeSequence).toBeLessThan(must(must(swapped[1]).runtimeSequence));
    const view = foldEvents([...stream.events.slice(0, -2), ...swapped]);
    const messages = view.timeline.filter((item) => item.kind === "message");
    expect(messages.map((item) => (item.kind === "message" ? item.messageId : null))).toEqual([
      "msg_user_run_1",
      "msg_2",
      "msg_1",
    ]);
  });

  it("starts a fresh fold from an existing view", () => {
    const stream = fullStream();
    const half = foldEvents(stream.events.slice(0, 10));
    const rest = foldEvents(stream.events.slice(10), half);
    expect(rest).toEqual(stream.fold());
  });
});

describe("late tool output", () => {
  it("attaches a committed result to the right call after thousands of later events", () => {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_early");
    stream.emit("tool.started", { toolCallId: "tc_early" });
    for (let index = 0; index < 3000; index += 1) {
      stream.emit("message.completed", {
        messageId: `msg_${index}`,
        role: "assistant",
        parts: [{ type: "text", text: `step ${index}` }],
        stopReason: "end_turn",
        usage: null,
      });
    }
    requestTool(stream, "tc_late");
    const before = stream.fold();
    expect(tool(before, "tc_early").state).toBe("input-available");
    const after = applyEvent(before, completeTool(stream, "tc_early"));
    expect(tool(after, "tc_early").state).toBe("output-available");
    expect(tool(after, "tc_early").result?.summary).toBe("42 passed");
    expect(tool(after, "tc_late").state).toBe("input-available");
    expect(after.timeline).toBe(before.timeline);
    expect(after.messages).toBe(before.messages);
    expect(after.timeline.filter((item) => item.kind === "tool")).toHaveLength(2);
  });

  it("attaches ephemeral output to the right call without touching the timeline", () => {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_1");
    requestTool(stream, "tc_2");
    const view = stream.fold();
    const chunk = live("tool.output", {
      toolCallId: "tc_1",
      chunkIndex: 0,
      stream: "stdout",
      text: "hello",
      droppedBytes: 0,
    });
    const next = applyLiveEvent(view, chunk);
    expect(next.live.toolOutput.get("tc_1" as never)).toEqual({
      text: "hello",
      streaming: true,
      droppedBytes: 0,
      truncatedChars: 0,
      lastChunkIndex: 0,
    });
    expect(next.live.toolOutput.has("tc_2" as never)).toBe(false);
    expect(next.timeline).toBe(view.timeline);
    expect(next.appliedThrough).toBe(view.appliedThrough);
    // The chunk reaches the call's own bounded tail as well as the live
    // terminal, so an expanded row has something to show once streaming ends.
    expect(next.tools.get("tc_1" as never)?.output).toEqual([
      { chunkIndex: 0, stream: "stdout", text: "hello" },
    ]);
    expect(next.tools.get("tc_2" as never)).toBe(view.tools.get("tc_2" as never));
  });
});

describe("ephemeral events", () => {
  const stream = new Stream();
  startRun(stream);
  stream.emit("message.started", { messageId: "msg_1", role: "assistant" });
  requestTool(stream, "tc_1");
  const base = stream.fold();

  it("never enter the committed timeline or advance the cursor", () => {
    const heartbeat = live("runtime.heartbeat", {
      uptimeMs: 5000,
      runtimeProcessAlive: true,
      lastProgressAt: T0,
    });
    const delta = live("message.delta", {
      messageId: "msg_1",
      partIndex: 0,
      part: { type: "text", text: "Hel" },
    });
    let view = applyLiveEvent(base, heartbeat);
    view = applyLiveEvent(view, delta);
    expect(view.timeline).toBe(base.timeline);
    expect(view.appliedThrough).toBe(base.appliedThrough);
    expect(view.messages).toBe(base.messages);
    expect(view.live.heartbeat).toEqual({
      uptimeMs: 5000,
      runtimeProcessAlive: true,
      lastProgressAt: T0,
      observedAt: T0,
    });
  });

  it("accumulate message deltas by part index until the completed message replaces them", () => {
    let view = applyLiveEvent(
      base,
      live("message.delta", {
        messageId: "msg_1",
        partIndex: 1,
        part: { type: "text", text: "Hel" },
      }),
    );
    view = applyLiveEvent(
      view,
      live("message.delta", {
        messageId: "msg_1",
        partIndex: 1,
        part: { type: "text", text: "lo" },
      }),
    );
    view = applyLiveEvent(
      view,
      live("message.delta", {
        messageId: "msg_1",
        partIndex: 0,
        part: { type: "reasoning_summary", text: "Thinking" },
      }),
    );
    expect(view.live.messages.get("msg_1" as never)).toEqual([
      { type: "reasoning_summary", text: "Thinking" },
      { type: "text", text: "Hello" },
    ]);
    const completed = applyEvent(
      view,
      stream.emit("message.completed", {
        messageId: "msg_1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
        stopReason: "end_turn",
        usage: null,
      }),
    );
    expect(completed.live.messages.has("msg_1" as never)).toBe(false);
    expect(completed.messages.get("msg_1" as never)?.streaming).toBe(false);
    const stale = applyLiveEvent(
      completed,
      live("message.delta", {
        messageId: "msg_1",
        partIndex: 0,
        part: { type: "text", text: "!" },
      }),
    );
    expect(stale).toBe(completed);
  });

  it("drop repeated chunks, stop streaming on completion, and cap the buffer", () => {
    const chunk = (chunkIndex: number, text: string) =>
      live("tool.output", {
        toolCallId: "tc_1",
        chunkIndex,
        stream: "terminal",
        text,
        droppedBytes: 1,
      });
    let view = applyLiveEvent(base, chunk(0, "a"));
    view = applyLiveEvent(view, chunk(1, "b"));
    expect(applyLiveEvent(view, chunk(1, "b"))).toBe(view);
    expect(applyLiveEvent(view, chunk(0, "a"))).toBe(view);
    expect(view.live.toolOutput.get("tc_1" as never)).toMatchObject({
      text: "ab",
      droppedBytes: 2,
      lastChunkIndex: 1,
    });
    const piece = "x".repeat(LIMITS.streamChunkChars);
    const pieces = LIVE_TERMINAL_CAP / LIMITS.streamChunkChars;
    for (let index = 0; index < pieces; index += 1) {
      view = applyLiveEvent(view, chunk(2 + index, piece));
    }
    expect(view.live.toolOutput.get("tc_1" as never)).toMatchObject({
      text: piece.repeat(pieces),
      truncatedChars: 2,
    });
    const done = applyEvent(view, {
      ...completeTool(stream, "tc_1"),
      sessionSequence: view.appliedThrough + 1,
    });
    expect(done.appliedThrough).toBe(view.appliedThrough + 1);
    expect(done.live.toolOutput.get("tc_1" as never)?.streaming).toBe(false);
    expect(applyLiveEvent(done, chunk(2 + pieces, "late"))).toBe(done);
    const cleared = discardLive(done);
    expect(cleared.live).toEqual({ messages: new Map(), toolOutput: new Map(), heartbeat: null });
    expect(discardLive(cleared)).toBe(cleared);
  });

  it("leave the live map untouched when a call finishes without ever streaming", () => {
    const finished = applyEvent(base, {
      ...completeTool(stream, "tc_1"),
      sessionSequence: base.appliedThrough + 1,
    });
    expect(finished.tools.get("tc_1" as never)?.state).toBe("output-available");
    expect(finished.live).toBe(base.live);
  });
});

describe("agent permissions (record 09)", () => {
  function asked(): Stream {
    const stream = new Stream();
    startRun(stream);
    stream.emit("approval.requested", {
      approvalId: "apr_p",
      title: "Read /etc/hosts, outside the project",
      intendedAction: "The agent wants to use a path outside the repository's work tree.",
      category: "outside_project",
      risk: "medium",
      resource: "/etc/hosts",
      requestedScope: "Files outside the project",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: null,
      toolCategory: "file_read",
    });
    return stream;
  }

  it("keeps the tool's kind, and reads none from an older request", () => {
    const view = asked().fold();
    expect(view.approvals.get("apr_p" as never)?.toolCategory).toBe("file_read");
    const older = new Stream();
    startRun(older);
    older.emit("approval.requested", {
      approvalId: "apr_o",
      title: "Supply A_NAME",
      intendedAction: "x",
      category: "development_secret",
      risk: "medium",
      resource: "A_NAME",
      requestedScope: "x",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: null,
    });
    expect(older.fold().approvals.get("apr_o" as never)?.toolCategory).toBeNull();
    expect(older.fold().approvals.get("apr_o" as never)).not.toHaveProperty("agentId");
  });

  it("keeps the subagent whose call asked", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("approval.requested", {
      approvalId: "apr_s",
      title: "Explore subagent: Read /etc/hosts, outside the project",
      intendedAction: "x",
      category: "outside_project",
      risk: "medium",
      resource: "/etc/hosts",
      requestedScope: "Files outside the project",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: "call_child",
      toolCategory: "file_read",
      agentId: "ses_child",
    });
    expect(stream.fold().approvals.get("apr_s" as never)?.agentId).toBe("ses_child");
  });

  it("records what an answer covers and whether a saved choice gave it", () => {
    const stream = asked();
    stream.emit("approval.resolved", {
      approvalId: "apr_p",
      decision: "approved",
      decidedBy: "user_1",
      commandId: "cmd_1",
      decidedForGeneration: 1,
      scope: "session",
      automatic: true,
    });
    const view = stream.fold();
    expect(view.approvals.get("apr_p" as never)?.resolution).toMatchObject({
      scope: "session",
      automatic: true,
    });
    expect(view.run?.state).toBe("running");
  });

  it("reads an older resolution as one request, answered by a click", () => {
    const stream = asked();
    stream.emit("approval.resolved", {
      approvalId: "apr_p",
      decision: "approved",
      decidedBy: "user_1",
      commandId: "cmd_1",
      decidedForGeneration: 1,
    });
    expect(stream.fold().approvals.get("apr_p" as never)?.resolution).toMatchObject({
      scope: "once",
      automatic: false,
    });
  });

  it("follows the menu's latest choice", () => {
    const stream = new Stream();
    expect(stream.fold().approvalMode).toBeNull();
    stream.emit("approval.mode_changed", { mode: "session", decidedBy: "user_1", commandId: "c1" });
    expect(stream.fold().approvalMode).toBe("session");
    stream.emit("approval.mode_changed", { mode: "always", decidedBy: "user_1", commandId: "c2" });
    expect(stream.fold().approvalMode).toBe("always");
  });
});

describe("approval folding into tool state", () => {
  function pending(): { stream: Stream; view: SessionView } {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_1", "apr_1");
    stream.emit("approval.requested", {
      approvalId: "apr_1",
      title: "Run a shell command",
      intendedAction: "Run pnpm test",
      category: "external_action",
      risk: "low",
      resource: "sandbox",
      requestedScope: "one command",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: "tc_1",
    });
    return { stream, view: stream.fold() };
  }

  it("moves the run to waiting_for_approval and the tool to approval-requested", () => {
    const { view } = pending();
    expect(view.run?.state).toBe("waiting_for_approval");
    expect(displayStatusOf(view)).toBe("waiting_for_approval");
    expect(view.openApprovalIds).toEqual(["apr_1"]);
    expect(tool(view, "tc_1").state).toBe("approval-requested");
  });

  it("says supplied only from the grant's answer, never from the approval", () => {
    const { stream, view } = pending();
    expect(view.approvals.get("apr_1" as never)?.delivered).toBeNull();
    const approved = applyEvent(
      view,
      stream.emit("approval.resolved", {
        approvalId: "apr_1",
        decision: "approved",
        decidedBy: "user_1",
        commandId: "cmd_1",
        decidedForGeneration: 1,
      }),
    );
    expect(approved.approvals.get("apr_1" as never)?.delivered).toBeNull();
    const failed = applyEvent(
      approved,
      stream.emit("secrets.supplied", { names: ["A_NAME"], approvalId: "apr_1", delivered: false }),
    );
    expect(failed.approvals.get("apr_1" as never)?.delivered).toBe(false);
    expect(failed.timeline.some((item) => item.kind === "secrets_supplied")).toBe(false);
  });

  it("gives a launch's delivery its own row, and ignores an approval it never saw", () => {
    const { stream, view } = pending();
    const launch = applyEvent(
      view,
      stream.emit("secrets.supplied", { names: ["A_NAME"], approvalId: null, delivered: true }),
    );
    expect(launch.timeline.at(-1)).toMatchObject({
      kind: "secrets_supplied",
      names: ["A_NAME"],
      delivered: true,
    });
    const unknown = applyEvent(
      launch,
      stream.emit("secrets.supplied", { names: ["A_NAME"], approvalId: "apr_9", delivered: true }),
    );
    expect(unknown.approvals.size).toBe(1);
    expect(unknown.timeline.length).toBe(launch.timeline.length);
  });

  it("approved: approval-responded, run resumes, then output-available", () => {
    const { stream, view } = pending();
    const approved = applyEvent(
      view,
      stream.emit("approval.resolved", {
        approvalId: "apr_1",
        decision: "approved",
        decidedBy: "user_1",
        commandId: "cmd_1",
        decidedForGeneration: 1,
      }),
    );
    expect(tool(approved, "tc_1").state).toBe("approval-responded");
    expect(tool(approved, "tc_1").approval?.decision).toBe("approved");
    expect(approved.run?.state).toBe("running");
    expect(approved.openApprovalIds).toEqual([]);
    expect(approved.approvals.get("apr_1" as never)?.state).toBe("approved");
    const started = applyEvent(approved, stream.emit("tool.started", { toolCallId: "tc_1" }));
    expect(tool(started, "tc_1").state).toBe("approval-responded");
    const done = applyEvent(started, completeTool(stream, "tc_1"));
    expect(tool(done, "tc_1").state).toBe("output-available");
  });

  it("rejected: output-denied from the decision and from the tool's own failure", () => {
    const { stream, view } = pending();
    const rejected = applyEvent(
      view,
      stream.emit("approval.resolved", {
        approvalId: "apr_1",
        decision: "rejected",
        decidedBy: "user_1",
        commandId: "cmd_1",
        decidedForGeneration: 1,
      }),
    );
    expect(tool(rejected, "tc_1").state).toBe("output-denied");
    expect(rejected.run?.state).toBe("running");
    const failed = applyEvent(
      rejected,
      stream.emit("tool.failed", {
        toolCallId: "tc_1",
        durationMs: 0,
        exitCode: null,
        errorText: "Approval rejected",
        category: "approval_rejected",
        evidence: [],
      }),
    );
    expect(tool(failed, "tc_1").state).toBe("output-denied");
    expect(tool(failed, "tc_1").failure?.errorText).toBe("Approval rejected");
  });

  it("expired with a denied tool resumes the run; other effects wait for the run event", () => {
    const { stream, view } = pending();
    const denied = applyEvent(
      view,
      stream.emit("approval.expired", { approvalId: "apr_1", effect: "tool_denied" }),
    );
    expect(tool(denied, "tc_1").state).toBe("output-denied");
    expect(denied.run?.state).toBe("running");
    expect(denied.approvals.get("apr_1" as never)?.expiredEffect).toBe("tool_denied");

    const other = pending();
    const paused = applyEvent(
      other.view,
      other.stream.emit("approval.expired", { approvalId: "apr_1", effect: "run_paused" }),
    );
    expect(paused.run?.state).toBe("waiting_for_approval");
    const afterPause = applyEvent(
      paused,
      other.stream.emit("run.paused", {
        reason: "approval_expired",
        detail: "No decision in time",
        checkpointId: null,
      }),
    );
    expect(afterPause.run?.state).toBe("paused");
    expect(displayStatusOf(afterPause)).toBe("waiting_for_input");
  });

  it("links an approval that arrives before its tool request", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("approval.requested", {
      approvalId: "apr_1",
      title: "Run a shell command",
      intendedAction: "Run pnpm test",
      category: "external_action",
      risk: "low",
      resource: "sandbox",
      requestedScope: "one command",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: "tc_1",
    });
    requestTool(stream, "tc_1", "apr_1");
    expect(tool(stream.fold(), "tc_1").state).toBe("approval-requested");
  });

  it("keeps the run waiting while another approval is still open", () => {
    const { stream, view } = pending();
    const second = applyEvent(
      view,
      stream.emit("approval.requested", {
        approvalId: "apr_2",
        title: "Add a secret",
        intendedAction: "Read DATABASE_URL",
        category: "development_secret",
        risk: "high",
        resource: "DATABASE_URL",
        requestedScope: "this run",
        expiresAt: "2026-09-01T13:00:00.000Z",
        toolCallId: null,
      }),
    );
    const one = applyEvent(
      second,
      stream.emit("approval.resolved", {
        approvalId: "apr_1",
        decision: "approved",
        decidedBy: "user_1",
        commandId: "cmd_1",
        decidedForGeneration: 1,
      }),
    );
    expect(one.openApprovalIds).toEqual(["apr_2"]);
    expect(one.run?.state).toBe("waiting_for_approval");
  });

  it("ignores decisions for approvals it never saw", () => {
    const stream = new Stream();
    startRun(stream);
    const before = stream.fold();
    const after = applyEvent(
      before,
      stream.emit("approval.resolved", {
        approvalId: "apr_ghost",
        decision: "approved",
        decidedBy: "user_1",
        commandId: "cmd_1",
        decidedForGeneration: 1,
      }),
    );
    expect(after.approvals.size).toBe(0);
    expect(after.timeline).toBe(before.timeline);
  });
});

describe("tool state never invents an outcome", () => {
  it("stays on the input side until a completion or failure event is folded", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("tool.requested", {
      toolCallId: "tc_1",
      category: "shell",
      title: "pnpm test",
      runtimeName: "bash",
      input: { command: "pn" },
      inputComplete: false,
      approvalId: null,
    });
    expect(tool(stream.fold(), "tc_1").state).toBe("input-streaming");
    requestTool(stream, "tc_1");
    stream.emit("tool.started", { toolCallId: "tc_1" });
    const view = stream.fold();
    expect(tool(view, "tc_1")).toMatchObject({
      state: "input-available",
      startedAt: T0,
      result: null,
      failure: null,
      durationMs: null,
    });
    expect(view.timeline.filter((item) => item.kind === "tool")).toHaveLength(1);
  });

  it("maps every failure category onto output-error or output-denied", () => {
    const denied = toolUiState({
      inputComplete: true,
      result: null,
      approval: null,
      failure: { errorText: "x", category: "denied_by_policy", evidence: [] },
    });
    const errored = toolUiState({
      inputComplete: true,
      result: null,
      approval: null,
      failure: { errorText: "x", category: "timeout", evidence: [] },
    });
    expect(denied).toBe("output-denied");
    expect(errored).toBe("output-error");
  });

  it("ignores lifecycle events for a call it never saw requested", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("tool.started", { toolCallId: "tc_ghost" });
    completeTool(stream, "tc_ghost");
    expect(stream.fold().tools.size).toBe(0);
  });
});

describe("run outcomes", () => {
  function ended(emit: (stream: Stream) => CommittedEvent): {
    view: SessionView;
    event: CommittedEvent;
  } {
    const stream = new Stream();
    startRun(stream);
    const event = emit(stream);
    return { view: stream.fold(), event };
  }

  it("verified", () => {
    const { view } = ended((s) => s.emit("run.verified", { summary, ...outcomeTail }));
    expect(view.run).toMatchObject({ state: "verified", outcome: "verified" });
    expect(displayStatusOf(view)).toBe("verified");
  });

  it("completed_with_warnings", () => {
    const { view } = ended((s) =>
      s.emit("run.completed_with_warnings", {
        summary,
        warnings: [{ text: "One flaky test", recommendedAction: "Re-run it" }],
        ...outcomeTail,
      }),
    );
    expect(view.run?.outcome).toBe("completed_with_warnings");
    expect(view.run?.ending).toMatchObject({
      outcome: "completed_with_warnings",
      warnings: [{ text: "One flaky test" }],
    });
    expect(displayStatusOf(view)).toBe("completed_with_warnings");
  });

  it("completed: Done, a run that changed no files and ran no checks (record 14)", () => {
    const { view } = ended((s) => s.emit("run.completed", { summary, ...outcomeTail }));
    expect(view.run).toMatchObject({ state: "completed", outcome: "completed" });
    expect(view.run?.ending).toMatchObject({ outcome: "completed", summary });
    expect(displayStatusOf(view)).toBe("completed");
  });

  it("blocked", () => {
    const { view } = ended((s) =>
      s.emit("run.blocked", {
        summary: null,
        blockedOn: { kind: "question", question: "Which database?" },
        ...outcomeTail,
      }),
    );
    expect(view.run?.outcome).toBe("blocked");
    expect(view.run?.ending).toMatchObject({ blockedOn: { kind: "question" } });
    expect(displayStatusOf(view)).toBe("blocked");
  });

  it("failed", () => {
    const { view } = ended((s) =>
      s.emit("run.failed", {
        stage: "verification",
        error: { category: "runtime", message: "Tests crashed" },
        summary: null,
        ...outcomeTail,
      }),
    );
    expect(view.run?.outcome).toBe("failed");
    expect(view.run?.ending).toMatchObject({ stage: "verification" });
    expect(displayStatusOf(view)).toBe("failed");
  });

  it("cancelled", () => {
    const { view } = ended((s) =>
      s.emit("run.cancelled", {
        by: { kind: "user", userId: "user_1" },
        checkpointId: null,
        summary: null,
        ...outcomeTail,
      }),
    );
    expect(view.run?.outcome).toBe("cancelled");
    expect(view.run?.endedAt).toBe(T0);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "run", transition: "cancelled" });
    expect(displayStatusOf(view)).toBe("cancelled");
  });

  it("records an ending for a run it never saw queued instead of dropping it", () => {
    const stream = new Stream();
    stream.emit("run.failed", {
      stage: "provisioning",
      error: { category: "provider", message: "No capacity" },
      summary: null,
      ...outcomeTail,
    });
    const view = stream.fold();
    expect(view.run).toMatchObject({ state: "failed", outcome: "failed", model: null });
  });
});

describe("run and sandbox lifecycle", () => {
  it("walks queued, provisioning, ready, running from sandbox and runtime events", () => {
    const stream = new Stream();
    const states: string[] = [];
    startRun(stream);
    let view = emptyView();
    for (const event of stream.events) {
      view = applyEvent(view, event);
      states.push(`${event.type}:${view.run?.state ?? "none"}:${displayStatusOf(view)}`);
    }
    expect(states).toEqual([
      "run.queued:queued:starting_environment",
      "sandbox.provisioning:provisioning:starting_environment",
      "sandbox.attached:provisioning:starting_environment",
      "runtime.connected:provisioning:starting_environment",
      "runtime.ready:ready:working",
      "run.started:running:working",
    ]);
    expect(view.sandbox.state).toBe("active");
  });

  // A run can pause twice for different reasons; the earlier row must not take the later one's.
  it("keeps each pause's own reason on its timeline row", () => {
    const stream = new Stream();
    startRun(stream);
    const failure = {
      category: "authentication_failed" as const,
      message: "The provider rejected this connection's credential.",
      retries: 0,
    };
    stream.emit("run.paused", {
      reason: "model_failure",
      detail: "Model request failed: authentication_failed",
      modelFailure: failure,
      checkpointId: null,
    });
    stream.emit("run.paused", { reason: "user_requested", detail: "", checkpointId: null });
    const view = stream.fold();

    const pauses = view.timeline.flatMap((item) =>
      item.kind === "run" && item.transition === "paused" ? [item.pause] : [],
    );
    expect(pauses.map((pause) => pause?.reason)).toEqual(["model_failure", "user_requested"]);
    expect(pauses[0]?.modelFailure).toEqual(failure);
    expect(view.run?.pause?.reason).toBe("user_requested");
    // No other run row carries one.
    expect(
      view.timeline.some(
        (item) => item.kind === "run" && item.transition !== "paused" && "pause" in item,
      ),
    ).toBe(false);
  });

  it("reports idle before any run, and resuming once a paused run provisions again", () => {
    expect(displayStatusOf(emptyView())).toBe("idle");
    const stream = new Stream();
    startRun(stream);
    stream.emit("run.paused", { reason: "user_requested", detail: "Paused", checkpointId: null });
    expect(displayStatusOf(stream.fold())).toBe("paused");
    stream.emit("sandbox.provisioning", {
      provider: "modal",
      reason: "resume",
      attempt: 1,
      cacheReuse: "base_image",
    });
    expect(displayStatusOf(stream.fold())).toBe("resuming");

    const lost = new Stream();
    startRun(lost);
    lost.emit("run.interrupted", {
      reason: "sandbox_lost",
      detail: "Gone",
      resumableFrom: "ckpt_1",
      externalActionsPending: [],
    });
    const view = lost.fold();
    expect(view.run?.interruption?.resumableFrom).toBe("ckpt_1");
    // Nothing resumes a lost sandbox's run until the user continues it.
    expect(displayStatusOf(view)).toBe("paused");
    expect(DISPLAY_STATUSES).toHaveLength(13);
  });

  it("shows an interruption as resuming only when the object replaces the sandbox itself", () => {
    const statusFor = (reason: PayloadOf<"run.interrupted">["reason"]) => {
      const stream = new Stream();
      startRun(stream);
      stream.emit("run.interrupted", {
        reason,
        detail: "Interrupted",
        resumableFrom: null,
        externalActionsPending: [],
      });
      return displayStatusOf(stream.fold());
    };
    expect(statusFor("sandbox_replaced")).toBe("resuming");
    for (const reason of [
      "sandbox_lost",
      "sandbox_failed",
      "bridge_timeout",
      "runtime_exited",
    ] as const) {
      expect(statusFor(reason)).toBe("paused");
    }
  });

  it("moves to a new generation on replacement and forgets the old runtime", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("runtime.disconnected", {
      reason: "generation_replaced",
      detail: "Ceiling",
      exitCode: null,
      diagnostics: [],
      expectReconnect: true,
    });
    expect(stream.fold().sandbox.runtime?.connected).toBe(false);
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 1,
        reason: "lifetime_ceiling",
        restoredFrom: "ckpt_1",
        explanation: "Modal ceiling reached",
      },
      { generation: 2 },
    );
    const replaced = stream.fold();
    expect(replaced.sandbox).toMatchObject({
      generation: 2,
      state: "requested",
      runtime: null,
      replacement: { previousGeneration: 1 },
    });
    stream.emit(
      "sandbox.provisioning",
      { provider: "modal", reason: "replacement", attempt: 1, cacheReuse: "base_image" },
      { generation: 2 },
    );
    stream.emit(
      "sandbox.attached",
      {
        provider: "modal",
        providerSandboxId: "sb_2",
        startupMs: 900,
        expiresAt: "2026-09-03T12:00:00.000Z",
        cacheFallback: true,
      },
      { generation: 2 },
    );
    const attached = stream.fold();
    expect(attached.sandbox).toMatchObject({
      generation: 2,
      state: "attached",
      providerSandboxId: "sb_2",
      replacement: { previousGeneration: 1 },
    });
    stream.emit(
      "sandbox.stopped",
      {
        outcome: "failed",
        reason: "failure",
        checkpointId: null,
        unsavedWorkWarning: "Uncommitted edits were lost",
        diagnostics: [],
      },
      { generation: 2 },
    );
    expect(stream.fold().sandbox.state).toBe("failed");
  });

  it("keeps a steered follow-up's attachments on its message", () => {
    const stream = new Stream();
    startRun(stream);
    const image = {
      artifactId: "att_1",
      kind: "file" as const,
      contentType: "image/png",
      byteSize: 120,
      label: "screen.png",
    };
    stream.emit("message.queued", {
      messageId: "msg_steer",
      commandId: "cmd_steer",
      text: "Like this",
      delivery: "steer_current_run",
      deliveredToRunId: "run_1",
      attachments: [image],
    });
    expect(stream.fold().messages.get("msg_steer" as never)?.parts).toEqual([
      { type: "text", text: "Like this" },
      { type: "artifact_ref", artifact: image },
    ]);
  });

  it("handles a second run and queued user messages", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("run.verified", { summary, ...outcomeTail });
    stream.emit("message.queued", {
      messageId: "msg_q",
      commandId: "cmd_q",
      text: "Also update the docs",
      delivery: "run_next",
      deliveredToRunId: null,
    });
    stream.emit(
      "run.queued",
      {
        commandId: "cmd_run_2",
        instruction: {
          messageId: "msg_q",
          text: "Also update the docs",
          attachments: [screenshot],
        },
        model,
        trigger: "follow_up",
        continuesRunId: "run_1",
      },
      { runId: "run_2" },
    );
    const view = stream.fold();
    expect(view.run?.runId).toBe("run_2");
    expect(view.run?.continuesRunId).toBe("run_1");
    expect(view.runs.get("run_1" as never)?.outcome).toBe("verified");
    expect(view.messages.get("msg_q" as never)?.parts).toEqual([
      { type: "text", text: "Also update the docs" },
      { type: "artifact_ref", artifact: screenshot },
    ]);
    expect(view.messages.get("msg_q" as never)?.runId).toBe("run_2");
  });
});

describe("plans, reviews, policy, verification, git edges", () => {
  it("marks a revision and a block, and cancels", () => {
    const stream = new Stream();
    startRun(stream);
    const body = {
      planId: "plan_1",
      revision: 1,
      title: "Plan",
      steps: [{ stepId: "s1", title: "Do it", status: "blocked", blockedReason: "Need creds" }],
      activeStepId: "s1",
      expectedVerification: [],
    } satisfies PayloadInputOf<"plan.created">;
    stream.emit("plan.created", body);
    stream.emit("plan.updated", { ...body, revision: 2, changeSummary: "Switched approach" });
    let view = stream.fold();
    expect(view.plan).toMatchObject({
      state: "revised",
      revision: 2,
      changeSummary: "Switched approach",
      description: null,
    });
    expect(view.plan?.steps[0]?.chainStatus).toBe("active");
    stream.emit("plan.updated", { ...body, revision: 3, changeSummary: null });
    view = stream.fold();
    expect(view.plan?.state).toBe("active");
    expect(view.plan?.changeSummary).toBe("Switched approach");
    stream.emit("plan.blocked", {
      planId: "plan_1",
      revision: 3,
      stepId: "s1",
      question: "Creds?",
    });
    view = stream.fold();
    expect(view.plan).toMatchObject({ state: "blocked", blockedQuestion: "Creds?" });
    stream.emit("plan.cancelled", { planId: "plan_1", revision: 3, reason: "superseded" });
    view = stream.fold();
    expect(view.plan).toMatchObject({ state: "cancelled", cancelReason: "superseded" });
    expect(
      view.timeline
        .filter((item) => item.kind === "plan")
        .map((item) => (item.kind === "plan" ? item.change : null)),
    ).toEqual(["created", "revised", "blocked", "cancelled"]);
    stream.emit("plan.completed", { planId: "plan_ghost", revision: 1, summary: "?" });
    expect(stream.fold().plans.size).toBe(1);
    expect(chainStatusOf("skipped")).toBe("complete");
    expect(chainStatusOf("pending")).toBe("pending");
  });

  it("counts unresolved reviews through selection, addressing, and dismissal", () => {
    const stream = new Stream();
    startRun(stream);
    const imported = {
      githubId: "gh",
      pullRequestNumber: 7,
      author: "octocat",
      authorType: "human",
      body: "Comment",
      sourceType: "issue_comment",
      location: null,
      threadId: null,
      parentId: null,
      githubState: "commented",
      locationCurrent: true,
      createdAt: T0,
      updatedAt: T0,
    } satisfies Omit<PayloadInputOf<"review.imported">, "reviewItemId">;
    stream.emit("review.imported", { ...imported, reviewItemId: "rev_1" });
    stream.emit("review.imported", { ...imported, reviewItemId: "rev_2" });
    stream.emit("review.imported", { ...imported, reviewItemId: "rev_2", body: "Edited" });
    expect(stream.fold().reviews.unresolvedCount).toBe(2);
    stream.emit("review.selected", {
      reviewItemIds: ["rev_1", "rev_ghost"],
      commandId: "c",
      userId: "u",
    });
    stream.emit("review.addressed", {
      reviewItemId: "rev_1",
      outcome: "addressed",
      summary: "Added the test",
      question: null,
      commits: [SHA2],
      verificationChecks: ["pnpm test"],
      verified: true,
    });
    stream.emit("review.dismissed", { reviewItemId: "rev_2", userId: "u", reason: null });
    let view = stream.fold();
    expect(view.reviews.unresolvedCount).toBe(0);
    expect(view.reviews.items.get("rev_1" as never)?.actionState).toBe("addressed");
    expect(view.reviews.items.get("rev_2" as never)).toMatchObject({
      actionState: "dismissed",
      body: "Edited",
    });
    stream.emit("review.updated", {
      reviewItemId: "rev_2",
      actionState: "unreviewed",
      body: null,
      githubState: "commented",
      locationCurrent: false,
      updatedAt: T0,
    });
    view = stream.fold();
    expect(view.reviews.unresolvedCount).toBe(1);
    expect(view.reviews.items.get("rev_2" as never)?.body).toBe("Edited");
  });

  it("keeps a proposal pending until any update lands, or the user declines it", () => {
    const stream = new Stream();
    stream.emit("policy.proposed", {
      proposalId: "prop_1",
      triggeringMessageId: null,
      from: policy,
      to: { ...policy, version: 2, push: "auto" },
      direction: "widening",
      rationale: "Faster",
    });
    stream.emit("policy.updated", {
      proposalId: "prop_other",
      from: policy,
      to: { ...policy, version: 2, commit: "manual" },
      confirmedBy: "product_control",
      userId: "user_1",
      effectiveAt: T0,
    });
    let view = stream.fold();
    expect(view.policy.pendingProposal).toBeNull();
    expect(view.policy.current?.commit).toBe("manual");
    const held = {
      triggeringMessageId: null,
      from: policy,
      to: { ...policy, version: 3, push: "auto" as const },
      direction: "widening" as const,
      rationale: "Faster",
    };
    stream.emit("policy.proposed", { ...held, proposalId: "prop_2" });
    stream.emit("policy.declined", { proposalId: "prop_old", userId: "user_1", declinedAt: T0 });
    expect(stream.fold().policy.pendingProposal?.proposalId).toBe("prop_2");
    stream.emit("policy.declined", { proposalId: "prop_2", userId: "user_1", declinedAt: T0 });
    expect(stream.fold().policy.pendingProposal).toBeNull();
    stream.emit("policy.declined", { proposalId: "prop_2", userId: "user_1", declinedAt: T0 });
    stream.emit("policy.proposed", { ...held, proposalId: "prop_1" });
    expect(stream.fold().policy.pendingProposal?.proposalId).toBe("prop_1");
    stream.emit("policy.updated", {
      proposalId: "prop_1",
      from: policy,
      to: { ...policy, version: 3, push: "auto" },
      confirmedBy: "user_confirmation",
      userId: "user_1",
      effectiveAt: T0,
    });
    view = stream.fold();
    expect(view.policy.pendingProposal).toBeNull();
    expect(view.policy.current?.version).toBe(3);
  });

  it("records every verification attempt and a result for an undeclared check", () => {
    const stream = new Stream();
    startRun(stream);
    const started = {
      checkId: "chk_1",
      name: "e2e",
      category: "test",
      classification: "recommended",
      source: "change_aware",
      method: { kind: "browser", url: "http://localhost:3000", interaction: null },
      revision: SHA2,
      baseRevision: null,
      reason: "the change touched the home page",
    } as const;
    const result = {
      checkId: "chk_1",
      skipReason: null,
      inconclusiveReason: null,
      exitCode: 1,
      durationMs: 10,
      summary: "flaky",
      baseComparison: "not_compared",
      structured: null,
      evidence: [],
    } satisfies Omit<PayloadInputOf<"verification.result">, "attempt" | "result">;
    stream.emit("verification.started", { ...started, attempt: 1 });
    stream.emit("verification.result", {
      ...result,
      attempt: 1,
      result: "inconclusive",
      inconclusiveReason: "flaky",
    });
    stream.emit("verification.started", { ...started, attempt: 2 });
    let view = stream.fold();
    let check = view.verification.checks.get("chk_1" as never);
    expect(check?.status).toBe("running");
    expect(check?.attempts).toHaveLength(2);
    stream.emit("verification.result", { ...result, attempt: 2, result: "passed", exitCode: 0 });
    stream.emit("verification.result", {
      ...result,
      checkId: "chk_undeclared",
      attempt: 1,
      result: "skipped",
      skipReason: "unavailable",
    });
    view = stream.fold();
    check = view.verification.checks.get("chk_1" as never);
    expect(check?.status).toBe("passed");
    expect(check?.attempts.map((attempt) => attempt.result?.result ?? "running")).toEqual([
      "inconclusive",
      "passed",
    ]);
    expect(check?.attempts[0]?.startedAt).toBe(T0);
    expect(view.verification.checks.get("chk_undeclared" as never)).toMatchObject({
      name: "chk_undeclared",
      classification: null,
      status: "skipped",
    });
    expect(view.timeline.filter((item) => item.kind === "check")).toHaveLength(2);
  });

  it("keeps the latest value of each field the agent described, and adds no timeline item", () => {
    const stream = new Stream();
    startRun(stream);
    expect(stream.fold().git.description).toBeNull();
    stream.emit("pull_request.described", {
      title: "Fix login redirect",
      body: "First account.",
      branchName: "oncue/fix-login-redirect",
    });
    const before = stream.fold().timeline.length;
    stream.emit("pull_request.described", {
      title: null,
      body: "Second account.",
      branchName: null,
    });
    const view = stream.fold();
    expect(view.git.description).toEqual({
      title: "Fix login redirect",
      body: "Second account.",
      branchName: "oncue/fix-login-redirect",
    });
    expect(view.timeline).toHaveLength(before);
  });

  it("replaces changed files from a diff, tracks push failures and PR state changes", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("file.changed", {
      change: { path: "a.ts", status: "added", additions: 1, deletions: 0 },
      byAgent: true,
    });
    stream.emit("diff.updated", {
      scope: "session",
      baseSha: SHA,
      headSha: SHA2,
      files: [{ path: "b.ts", status: "modified", additions: 2, deletions: 2 }],
      additions: 2,
      deletions: 2,
      body: { kind: "inline", patch: "--- a\n+++ b\n" },
      truncated: false,
    });
    stream.emit("repository.checkpointed", {
      checkpointId: "ckpt_r",
      kind: "local_commit",
      headSha: SHA2,
      bundle: null,
      reason: "periodic",
    });
    stream.emit("git.push.failed", {
      pushId: "push_x",
      branch: "oncue/task-1",
      headSha: SHA2,
      category: "workflow_file_rejected",
      message: "Workflow files need a token scope",
      retryable: false,
    });
    stream.emit("pull_request.updated", {
      number: 9,
      headSha: SHA2,
      verificationSectionVersion: 2,
      changed: ["head"],
    });
    stream.emit("pull_request.state_changed", {
      number: 9,
      from: "open",
      to: "merged",
      actor: "octocat",
      mergedSha: SHA2,
      changedAt: "2026-09-01T12:10:00.000Z",
    });
    stream.emit("artifact.failed", {
      artifactId: "art_missing",
      stage: "upload",
      reason: "Network",
      retryable: true,
    });
    stream.emit("artifact.uploading", {
      artifactId: "art_2",
      kind: "log",
      contentType: "text/plain",
      declaredBytes: 10,
      producer: "tool",
    });
    stream.emit("artifact.failed", {
      artifactId: "art_2",
      stage: "validate",
      reason: "Checksum mismatch",
      retryable: false,
    });
    stream.emit("command.rejected", {
      commandId: "cmd_bad",
      commandType: "run.pause",
      reason: "wrong_state",
      expectedState: "running",
      actualState: "verified",
      detail: "Run already finished",
    });
    const view = stream.fold();
    expect([...view.git.changedFiles.keys()]).toEqual(["b.ts"]);
    expect(view.git.sessionDiff?.body).toEqual({ kind: "inline", patch: "--- a\n+++ b\n" });
    expect(view.git.checkpoint?.checkpointId).toBe("ckpt_r");
    expect(view.git.pushes.get("push_x" as never)).toMatchObject({
      state: "failed",
      commitCount: null,
      failure: { category: "workflow_file_rejected", retryable: false },
    });
    expect(view.git.pullRequest).toMatchObject({
      number: 9,
      url: null,
      state: "merged",
      mergedSha: SHA2,
      lastActor: "octocat",
      updatedAt: "2026-09-01T12:10:00.000Z",
    });
    expect(view.artifacts.has("art_missing" as never)).toBe(false);
    expect(view.artifacts.get("art_2" as never)).toMatchObject({
      state: "failed",
      failure: { stage: "validate", retryable: false },
    });
    expect(view.commands.get("cmd_bad" as never)).toMatchObject({
      state: "rejected",
      rejection: { reason: "wrong_state" },
    });
  });

  it("keeps one turn diff per run, and one timeline item for each run's first", () => {
    const stream = new Stream();
    startRun(stream);
    const diff = {
      scope: "turn",
      baseSha: SHA,
      headSha: SHA2,
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
      body: { kind: "inline", patch: "--- a\n+++ b\n" },
      truncated: false,
    } satisfies PayloadInputOf<"diff.updated">;
    const first = stream.emit("diff.updated", diff);
    const before = stream.fold();
    expect(before.git.turnDiffs.get("run_1" as never)).toMatchObject({ additions: 1 });
    expect(before.timeline.at(-1)).toEqual({
      kind: "changes",
      runId: "run_1",
      sequence: first.sessionSequence,
    });

    const after = applyEvent(
      before,
      stream.emit("diff.updated", {
        ...diff,
        files: [{ path: "a.ts", status: "modified", additions: 5, deletions: 2 }],
        additions: 5,
        deletions: 2,
      }),
    );
    expect(after.git.turnDiffs.get("run_1" as never)).toMatchObject({ additions: 5 });
    expect(after.git.turnDiffs).not.toBe(before.git.turnDiffs);
    expect(after.timeline).toBe(before.timeline);
    // A turn diff is one run's change, so it leaves the session summary alone.
    expect(after.git.sessionDiff).toBeNull();
    expect(after.git.changedFiles).toBe(before.git.changedFiles);
    expect(after.git.additions).toBe(0);

    const second = stream.emit("diff.updated", diff, { runId: "run_2" });
    const both = applyEvent(after, second);
    expect([...both.git.turnDiffs.keys()]).toEqual(["run_1", "run_2"]);
    expect(both.timeline.filter((item) => item.kind === "changes")).toEqual([
      { kind: "changes", runId: "run_1", sequence: first.sessionSequence },
      { kind: "changes", runId: "run_2", sequence: second.sessionSequence },
    ]);

    const session = applyEvent(
      both,
      stream.emit("diff.updated", { ...diff, scope: "session", additions: 6, deletions: 2 }),
    );
    expect(session.git.sessionDiff).toMatchObject({ scope: "session", additions: 6 });
    expect(session.git.additions).toBe(6);
    expect(session.git.turnDiffs).toBe(both.git.turnDiffs);
    expect(session.timeline).toBe(both.timeline);
  });

  it("keeps each run's verification summary rather than only the latest", () => {
    const stream = new Stream();
    startRun(stream);
    const counts = { total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0 };
    const completed = {
      proposedOutcome: "verified",
      required: counts,
      recommended: { ...counts, total: 0, passed: 0 },
      warnings: [],
      userSkipped: [],
      baselineComparisonAvailable: false,
    } satisfies PayloadInputOf<"verification.completed">;
    stream.emit("verification.completed", completed);
    const before = stream.fold();
    const after = applyEvent(
      before,
      stream.emit(
        "verification.completed",
        { ...completed, proposedOutcome: "completed_with_warnings", userSkipped: ["chk_unit"] },
        { runId: "run_2" },
      ),
    );
    expect(before.verification.summaries.size).toBe(1);
    expect(after.verification.summaries.get("run_1" as never)).toMatchObject({
      proposedOutcome: "verified",
    });
    expect(after.verification.summaries.get("run_2" as never)).toMatchObject({
      runId: "run_2",
      proposedOutcome: "completed_with_warnings",
      userSkipped: ["chk_unit"],
    });
    expect(after.verification.checks).toBe(before.verification.checks);
    expect(after.timeline.filter((item) => item.kind === "verification")).toHaveLength(2);

    const unrelated = applyEvent(
      after,
      stream.emit("file.changed", {
        change: { path: "a.ts", status: "added", additions: 1, deletions: 0 },
        byAgent: true,
      }),
    );
    expect(unrelated.verification).toBe(after.verification);
    expect(unrelated.git.turnDiffs).toBe(after.git.turnDiffs);
  });

  it("derives author initials for the Commit component", () => {
    expect(initialsOf("OnCue Agent")).toBe("OA");
    expect(initialsOf("Ada Lovelace King")).toBe("AK");
    expect(initialsOf("octocat")).toBe("OC");
    expect(initialsOf("   ")).toBe("?");
  });
});

// Record 13: one sandbox row per generation, labelled from the event's own
// fields and settling as the lifecycle progresses.
describe("sandbox and runtime rows", () => {
  function labelsFor(stream: Stream, generation = 1): string {
    const action = stream.fold().sandboxActions.get(generation);
    return `${action?.step}:${action?.state}:${action?.label}`;
  }

  it("invents no row for a revocation on a generation it never saw", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit(
      "sandbox.credentials_revoked",
      { reason: "disappeared", grants: [] },
      { generation: 5 },
    );
    expect(stream.fold().sandboxActions.has(5)).toBe(false);
  });

  it("says a checkpoint could not save the work, and why, without git's words", () => {
    // A file only the agent's user can read makes the bridge's `git add` fail.
    const stream = new Stream();
    startRun(stream);
    stream.emit("sandbox.idle", { idleSince: T0, stopAt: T0, keepAliveUntil: null });
    stream.emit("sandbox.checkpoint_failed", {
      checkpointId: "ckpt_1",
      reason: "idle",
      failure: "add_failed",
      durationMs: 300,
    });
    expect(labelsFor(stream)).toBe("checkpointed:running:Could not save the work");
    const action = stream.fold().sandboxActions.get(1);
    expect(action?.detail).toBe("because the sandbox went idle");
    expect(action?.explanation).toContain("could not read a file in the work tree");
    // Nothing was saved, so the session's checkpoint is not moved.
    expect(stream.fold().git.checkpoint).toBeNull();
  });

  it("reads a push the object withheld as a failed push with the object's sentence", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("git.push.requested", {
      pushId: "push_1",
      branch: "feature/login",
      headSha: null,
      commitCount: 1,
      policy: { policyVersion: 1, rule: "auto_push", approvalId: null },
    });
    stream.emit("git.push.withheld", {
      pushId: "push_1",
      branch: "feature/login",
      reason: "protected",
      message: "OnCue did not push: a ruleset now guards this branch.",
    });
    const view = stream.fold();
    expect(view.git.pushes.get("push_1" as never)).toMatchObject({
      state: "failed",
      headSha: null,
      commitCount: 1,
      failure: {
        category: "branch_not_pushable",
        message: "OnCue did not push: a ruleset now guards this branch.",
        retryable: false,
      },
    });
    expect(view.timeline.filter((item) => item.kind === "push").at(-1)).toMatchObject({
      change: "failed",
    });
    // One the view never saw requested still reads as failed.
    const alone = new Stream();
    startRun(alone);
    alone.emit("git.push.withheld", {
      pushId: "push_2",
      branch: "feature/login",
      reason: "unconfirmed",
      message: "x",
    });
    expect(alone.fold().git.pushes.get("push_2" as never)).toMatchObject({
      state: "failed",
      commitCount: null,
      policy: null,
    });
  });

  it("settles a push waiting on a checkpoint that could not be taken", () => {
    // A push waiting on a checkpoint that failed must not stay "requested".
    const stream = new Stream();
    startRun(stream);
    stream.emit("git.push.requested", {
      pushId: "push_1",
      branch: "oncue/task-1",
      headSha: null,
      commitCount: 1,
      policy: { policyVersion: 1, rule: "auto_push", approvalId: null },
    });
    stream.emit("sandbox.checkpoint_failed", {
      checkpointId: "ckpt_1",
      reason: "user",
      failure: "add_failed",
      durationMs: 300,
    });
    const view = stream.fold();
    const push = view.git.pushes.get("push_1" as never);
    expect(push?.state).toBe("failed");
    expect(push?.failure?.message).toContain("could not read a file in the work tree");
    expect(view.timeline.filter((item) => item.kind === "push").at(-1)).toMatchObject({
      change: "failed",
    });
  });

  it("settles only the newest waiting push when a checkpoint fails", () => {
    // The control plane settles exactly one publish, the most recent in its
    // grant window, so the fold must not explain an older stranded push.
    const stream = new Stream();
    startRun(stream);
    const requested = (pushId: string) =>
      stream.emit("git.push.requested", {
        pushId,
        branch: "oncue/task-1",
        headSha: null,
        commitCount: 1,
        policy: { policyVersion: 1, rule: "auto_push", approvalId: null },
      });
    requested("push_stranded");
    requested("push_now");
    stream.emit("sandbox.checkpoint_failed", {
      checkpointId: "ckpt_1",
      reason: "user",
      failure: "add_failed",
      durationMs: 300,
    });
    const view = stream.fold();
    expect(view.git.pushes.get("push_now" as never)?.state).toBe("failed");
    expect(view.git.pushes.get("push_stranded" as never)?.state).toBe("requested");
    expect(
      view.timeline.filter((item) => item.kind === "push" && item.change === "failed"),
    ).toHaveLength(1);
  });

  it("drops a failed checkpoint's explanation once one succeeds", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit("sandbox.checkpoint_failed", {
      checkpointId: "ckpt_1",
      reason: "user",
      failure: "add_failed",
      durationMs: 300,
    });
    expect(stream.fold().sandboxActions.get(1)?.explanation).toContain("could not read a file");
    stream.emit("sandbox.checkpointed", {
      checkpointId: "ckpt_2",
      kind: "branch_push",
      headSha: SHA,
      bundle: null,
      reason: "user",
      durationMs: 400,
    });
    // The work was saved after all; the old reason must not stay on the row.
    expect(stream.fold().sandboxActions.get(1)?.explanation).toBeNull();
  });

  it("keeps one row per generation and updates it in place", () => {
    const stream = new Stream();
    startRun(stream);
    expect(labelsFor(stream)).toBe("ready:running:opencode 1.0.0 is ready");

    stream.emit("sandbox.idle", { idleSince: T0, stopAt: T0, keepAliveUntil: null });
    expect(labelsFor(stream)).toBe("idle:running:Sandbox idle, stopping when its timer expires");

    stream.emit("sandbox.checkpointed", {
      checkpointId: "ckpt_1",
      kind: "branch_push",
      headSha: SHA,
      bundle: null,
      reason: "idle",
      durationMs: 400,
    });
    expect(labelsFor(stream)).toBe("checkpointed:running:Pushed the session's branch");
    // Read after the sandbox went idle, so the words say what already happened.
    expect(stream.fold().sandboxActions.get(1)?.detail).toBe("because the sandbox went idle");

    stream.emit("sandbox.credentials_revoked", {
      reason: "idle",
      grants: [
        { kind: "push", outcome: "revoked" },
        { kind: "upload", outcome: "not_held" },
      ],
    });
    expect(labelsFor(stream)).toBe("checkpointed:running:Took back the sandbox's credentials");
    expect(stream.fold().sandboxActions.get(1)?.detail).toBe("push revoked, upload not held");

    stream.emit("sandbox.stopped", {
      outcome: "stopped",
      reason: "idle",
      checkpointId: "ckpt_1",
      unsavedWorkWarning: null,
      diagnostics: [],
    });
    expect(labelsFor(stream)).toBe("stopped:completed:Sandbox stopped after going idle");

    const view = stream.fold();
    const rows = view.timeline.filter((item) => item.kind === "sandbox");
    expect(rows).toEqual([{ kind: "sandbox", generation: 1, sequence: 2 }]);
    expect(view.sandboxActions.get(1)).toMatchObject({
      generation: 1,
      provider: "modal",
      detail: "work checkpointed",
      at: T0,
      updatedAt: T0,
    });
  });

  it("does not render a replacement start the way it renders a first start", () => {
    const first = new Stream();
    first.emit("sandbox.provisioning", {
      provider: "modal",
      reason: "initial",
      attempt: 1,
      cacheReuse: "repository_environment",
    });
    const again = new Stream();
    again.emit("sandbox.provisioning", {
      provider: "modal",
      reason: "replacement",
      attempt: 2,
      cacheReuse: "none",
    });

    expect(first.fold().sandboxActions.get(1)).toMatchObject({
      step: "provisioning",
      state: "running",
      label: "Starting a sandbox",
      detail: "reusing the prepared repository environment",
    });
    expect(again.fold().sandboxActions.get(1)).toMatchObject({
      label: "Starting a replacement sandbox",
      detail: "attempt 2, building the environment from scratch",
    });
  });

  it("gives every provisioning reason and every stop reason its own sentence", () => {
    const provisioning = (["initial", "resume", "replacement", "retry"] as const).map((reason) => {
      const stream = new Stream();
      stream.emit("sandbox.provisioning", {
        provider: "fake",
        reason,
        attempt: 1,
        cacheReuse: "base_image",
      });
      return stream.fold().sandboxActions.get(1)?.label;
    });
    expect(new Set(provisioning).size).toBe(provisioning.length);

    const stops = (
      [
        "idle",
        "keepalive_expired",
        "lifetime_ceiling",
        "user_requested",
        "policy",
        "provisioning_failed",
        "failure",
        "disappeared",
        "emergency_termination",
      ] as const
    ).map((reason) => {
      const stream = new Stream();
      stream.emit("sandbox.stopped", {
        outcome: "failed",
        reason,
        checkpointId: null,
        unsavedWorkWarning: "Uncommitted edits were lost",
        diagnostics: [],
      });
      const action = stream.fold().sandboxActions.get(1);
      expect(action).toMatchObject({
        step: "failed",
        state: "failed",
        detail: "no checkpoint saved",
        explanation: "Uncommitted edits were lost",
      });
      return action?.label;
    });
    expect(new Set(stops).size).toBe(stops.length);
  });

  /**
   * A bridge with no agent runtime reports `NO_RUNTIME` in both fields; the
   * row reads as the bridge waiting, not a runtime called "none".
   */
  it("labels a runtime.connected with no runtime as the bridge waiting, and keeps the runtime label otherwise", () => {
    const bridgeOnly = new Stream();
    bridgeOnly.emit("runtime.connected", {
      bridgeVersion: "abc1234",
      runtimeName: NO_RUNTIME,
      runtimeVersion: NO_RUNTIME,
      protocolVersion: 1,
      capabilities: [],
    });
    expect(bridgeOnly.fold().sandboxActions.get(1)).toMatchObject({
      step: "connected",
      state: "running",
      label: "Bridge connected, waiting for the agent runtime",
      detail: "bridge abc1234",
    });

    const withRuntime = new Stream();
    withRuntime.emit("runtime.connected", {
      bridgeVersion: "abc1234",
      runtimeName: "opencode",
      runtimeVersion: "1.0.0",
      protocolVersion: 1,
      capabilities: ["tools"],
    });
    expect(withRuntime.fold().sandboxActions.get(1)?.label).toBe("Connected to opencode 1.0.0");
  });

  it("splits a disconnect three ways on the fields the event carries", () => {
    const disconnect = (
      reason: "generation_replaced" | "shutdown_requested" | "connection_lost",
      expectReconnect: boolean,
    ) => {
      const stream = new Stream();
      stream.emit("runtime.disconnected", {
        reason,
        detail: "the bridge went away",
        exitCode: null,
        diagnostics: [],
        expectReconnect,
      });
      return stream.fold().sandboxActions.get(1);
    };

    expect(disconnect("generation_replaced", true)).toMatchObject({
      step: "reconnecting",
      state: "running",
      detail: "reconnecting",
      explanation: "the bridge went away",
    });
    expect(disconnect("shutdown_requested", false)).toMatchObject({
      step: "disconnected",
      state: "completed",
      label: "The agent runtime shut down on request",
      detail: null,
    });
    expect(disconnect("connection_lost", false)).toMatchObject({
      step: "lost",
      state: "failed",
      label: "Lost the connection to the agent runtime",
    });
  });

  it("names a cache fallback, a keep-alive, and a failing startup check", () => {
    const stream = new Stream();
    stream.emit("sandbox.attached", {
      provider: "modal",
      providerSandboxId: "sb_9",
      startupMs: 900,
      expiresAt: "2026-09-02T12:00:00.000Z",
      cacheFallback: true,
    });
    expect(stream.fold().sandboxActions.get(1)).toMatchObject({
      label: "Sandbox running, built without its cache",
      detail: "sb_9",
      durationMs: 900,
    });

    stream.emit("sandbox.idle", { idleSince: T0, stopAt: T0, keepAliveUntil: T0 });
    expect(stream.fold().sandboxActions.get(1)?.label).toBe(
      "Sandbox idle, held open by a keep-alive",
    );

    stream.emit("runtime.ready", {
      runtimeName: "opencode",
      runtimeVersion: "1.0.0",
      healthChecks: [
        { name: "git", passed: true },
        { name: "network", passed: false },
      ],
      startupMs: 300,
    });
    expect(stream.fold().sandboxActions.get(1)).toMatchObject({
      label: "opencode 1.0.0 is ready with failing startup checks",
      detail: "1 of 2 startup checks passed",
    });
  });

  it("opens a second row when the generation is replaced", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 1,
        reason: "lifetime_ceiling",
        restoredFrom: "ckpt_1",
        explanation: "Modal ceiling reached",
      },
      { generation: 2 },
    );
    expect(stream.fold().sandboxActions.get(2)).toMatchObject({
      step: "requested",
      state: "requested",
      // Carried from generation 1: a replacement runs where its predecessor
      // did, and null would draw the local driver's glyph.
      provider: "modal",
      label: "Replacing the sandbox at its lifetime ceiling",
      detail: "restoring ckpt_1",
      explanation: "Modal ceiling reached",
    });

    stream.emit(
      "sandbox.provisioning",
      { provider: "modal", reason: "replacement", attempt: 1, cacheReuse: "base_image" },
      { generation: 2 },
    );
    const view = stream.fold();
    expect(view.timeline.filter((item) => item.kind === "sandbox")).toHaveLength(2);
    // The replacement's own explanation survives the next event in the row.
    expect(view.sandboxActions.get(2)).toMatchObject({
      step: "provisioning",
      provider: "modal",
      explanation: "Modal ceiling reached",
    });
    // `sandbox.replaced` is the last event generation 1 gets (`states.ts`
    // allows attached|active|idle -> replaced), so it must settle the row.
    expect(view.sandboxActions.get(1)).toMatchObject({
      step: "replaced",
      state: "completed",
      label: "Sandbox replaced at its lifetime ceiling",
      detail: "replaced by generation 2",
    });
  });

  it("carries the provider forward so the replacement is not drawn as the fake", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 1,
        reason: "resume",
        restoredFrom: null,
        explanation: "Resuming after a pause",
      },
      { generation: 2 },
    );
    // Before `sandbox.provisioning` names one, the provider is the replaced
    // generation's.
    expect(stream.fold().sandboxActions.get(2)?.provider).toBe("modal");
  });

  it("settles a replaced generation as failed when that is why it was replaced", () => {
    const stream = new Stream();
    startRun(stream);
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 1,
        reason: "failure",
        restoredFrom: null,
        explanation: "The runtime stopped answering",
      },
      { generation: 2 },
    );
    expect(stream.fold().sandboxActions.get(1)).toMatchObject({
      step: "failed",
      state: "failed",
      label: "Sandbox replaced after a failure",
    });
  });

  it("invents no row for a generation this client never saw", () => {
    const stream = new Stream();
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 3,
        reason: "resume",
        restoredFrom: null,
        explanation: "Resuming after a pause",
      },
      { generation: 4 },
    );
    const view = stream.fold();
    expect(view.sandboxActions.get(3)).toBeUndefined();
    expect(view.timeline.filter((item) => item.kind === "sandbox")).toHaveLength(1);
  });

  it("falls back to replacing a generation when no checkpoint was restored", () => {
    const stream = new Stream();
    stream.emit(
      "sandbox.replaced",
      {
        previousGeneration: 3,
        reason: "policy_change",
        restoredFrom: null,
        explanation: "Policy tightened",
      },
      { generation: 4 },
    );
    expect(stream.fold().sandboxActions.get(4)).toMatchObject({
      label: "Replacing the sandbox after a policy change",
      detail: "replacing generation 3",
    });
  });
});

// `tool.output` is ephemeral, so the tail must be bounded and must never imply
// a command printed nothing when nobody was listening.
describe("the bounded tool output tail", () => {
  function streamingTool(): SessionView {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_1");
    return stream.fold();
  }

  const chunk = (chunkIndex: number, text: string, droppedBytes = 0) =>
    live("tool.output", {
      toolCallId: "tc_1",
      chunkIndex,
      stream: "stdout",
      text,
      droppedBytes,
    });

  it("keeps chunks in order and claims nothing was lost", () => {
    let view = applyLiveEvent(streamingTool(), chunk(0, "one\n"));
    view = applyLiveEvent(view, chunk(1, "two\n"));
    expect(view.tools.get("tc_1" as never)).toMatchObject({
      output: [
        { chunkIndex: 0, stream: "stdout", text: "one\n" },
        { chunkIndex: 1, stream: "stdout", text: "two\n" },
      ],
      outputDropped: false,
    });
  });

  it("admits a gap, a runtime drop, and joining the stream late", () => {
    const gap = applyLiveEvent(applyLiveEvent(streamingTool(), chunk(0, "a")), chunk(2, "c"));
    expect(gap.tools.get("tc_1" as never)?.outputDropped).toBe(true);

    const dropped = applyLiveEvent(streamingTool(), chunk(0, "a", 4096));
    expect(dropped.tools.get("tc_1" as never)?.outputDropped).toBe(true);

    const late = applyLiveEvent(streamingTool(), chunk(7, "mid-stream"));
    expect(late.tools.get("tc_1" as never)).toMatchObject({
      output: [{ chunkIndex: 7, stream: "stdout", text: "mid-stream" }],
      outputDropped: true,
    });
  });

  it("caps the tail by chunk count and by characters", () => {
    let byCount = streamingTool();
    for (let index = 0; index <= TOOL_OUTPUT_TAIL_CHUNKS; index += 1) {
      byCount = applyLiveEvent(byCount, chunk(index, `${index}\n`));
    }
    const counted = byCount.tools.get("tc_1" as never);
    expect(counted?.output).toHaveLength(TOOL_OUTPUT_TAIL_CHUNKS);
    expect(counted?.output.at(0)?.chunkIndex).toBe(1);
    expect(counted?.outputDropped).toBe(true);

    const half = "y".repeat(TOOL_OUTPUT_TAIL_CHARS - 1);
    let byChars = applyLiveEvent(streamingTool(), chunk(0, half));
    byChars = applyLiveEvent(byChars, chunk(1, half));
    const chars = byChars.tools.get("tc_1" as never);
    expect(chars?.output).toHaveLength(1);
    expect(chars?.output.at(0)?.chunkIndex).toBe(1);
    expect(chars?.outputDropped).toBe(true);
  });

  it("keeps the newest chunk even when it alone exceeds the character cap", () => {
    const huge = "z".repeat(LIMITS.streamChunkChars);
    const view = applyLiveEvent(streamingTool(), chunk(0, huge));
    expect(view.tools.get("tc_1" as never)?.output).toHaveLength(1);
  });

  /**
   * A call that printed nothing has not lost output: many tools emit no
   * `tool.output` at all.
   */
  it("claims nothing is missing from a settled call that never had output", () => {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_1");
    completeTool(stream, "tc_1");
    expect(stream.fold().tools.get("tc_1" as never)).toMatchObject({
      state: "output-available",
      output: [],
      outputDropped: false,
    });

    const failing = new Stream();
    startRun(failing);
    requestTool(failing, "tc_2");
    failing.emit("tool.failed", {
      toolCallId: "tc_2",
      durationMs: 90,
      exitCode: null,
      errorText: "The policy denied this command.",
      category: "denied_by_policy",
      evidence: [],
    });
    expect(failing.fold().tools.get("tc_2" as never)).toMatchObject({
      state: "output-denied",
      outputDropped: false,
    });
  });

  /**
   * The one settled shape that IS missing output: chunks arrived before the
   * `tool.requested` that creates the row, so they landed in the live buffer
   * and never in the tail.
   */
  it("marks a settled call whose output arrived before its row as missing it", () => {
    const stream = new Stream();
    startRun(stream);
    let view = applyLiveEvent(stream.fold(), chunk(0, "early\n"));
    requestTool(stream, "tc_1");
    completeTool(stream, "tc_1");
    view = foldEvents(stream.events, view);
    expect(view.tools.get("tc_1" as never)).toMatchObject({
      output: [],
      outputDropped: true,
    });
  });

  it("marks a tail dropped when the client leaves the stream", () => {
    const view = applyLiveEvent(streamingTool(), chunk(0, "partial"));
    const cleared = discardLive(view);
    expect(cleared.tools.get("tc_1" as never)).toMatchObject({
      output: [{ chunkIndex: 0, stream: "stdout", text: "partial" }],
      outputDropped: true,
    });
    // Already flagged, so a second pass leaves the entry alone.
    expect(discardLive({ ...cleared, live: view.live }).tools.get("tc_1" as never)).toBe(
      cleared.tools.get("tc_1" as never),
    );
  });

  /**
   * A reconnect only interrupts the call still streaming. Other tails ended
   * with their call or were flagged by `appendToolOutput` when a cap cut them.
   */
  it("leaves a finished call's tail alone when the client leaves the stream", () => {
    const stream = new Stream();
    startRun(stream);
    requestTool(stream, "tc_1");
    requestTool(stream, "tc_2");
    let view = applyLiveEvent(stream.fold(), chunk(0, "all of it\n"));
    view = applyLiveEvent(
      view,
      live("tool.output", {
        toolCallId: "tc_2",
        chunkIndex: 0,
        stream: "stdout",
        text: "still going\n",
        droppedBytes: 0,
      }),
    );
    completeTool(stream, "tc_1");
    view = foldEvents(stream.events, view);
    expect(view.tools.get("tc_1" as never)?.outputDropped).toBe(false);

    const cleared = discardLive(view);
    expect(cleared.tools.get("tc_1" as never)?.outputDropped).toBe(false);
    // The one still streaming when the client left is the one that lost output.
    expect(cleared.tools.get("tc_2" as never)?.outputDropped).toBe(true);
  });
});

describe("questions", () => {
  const asked: PayloadInputOf<"question.asked"> = {
    questionId: "qst_1",
    toolCallId: "tc_q",
    questions: [
      {
        id: "q1",
        header: "Database",
        text: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "One file" },
        ],
        multiple: false,
        allowOther: true,
      },
      {
        id: "q2",
        header: "Targets",
        text: "Which targets?",
        options: [
          { label: "Web", description: "" },
          { label: "iOS", description: "" },
        ],
        multiple: true,
        allowOther: false,
      },
    ],
  };

  function askedStream(): Stream {
    const stream = new Stream();
    startRun(stream);
    stream.emit("question.asked", asked);
    return stream;
  }

  it("opens the question, adds one timeline row, and waits on the user", () => {
    const view = askedStream().fold();
    expect(view.openQuestionId).toBe("qst_1");
    const question = must(view.questions.get("qst_1" as never));
    expect(question.state).toBe("open");
    expect(question.toolCallId).toBe("tc_q");
    expect(question.questions).toHaveLength(2);
    expect(question.answers).toBeNull();
    expect(view.timeline.filter((item) => item.kind === "question")).toHaveLength(1);
    expect(view.run?.state).toBe("running");
    expect(displayStatusOf(view)).toBe("waiting_for_input");
  });

  it("settles on the answer and keeps what the agent was told", () => {
    const stream = askedStream();
    stream.emit("question.answered", {
      questionId: "qst_1",
      answers: [["Postgres"], ["Web", "iOS"]],
      decidedBy: "user_1",
      commandId: "cmd_q",
    });
    const view = stream.fold();
    expect(view.openQuestionId).toBeNull();
    const question = must(view.questions.get("qst_1" as never));
    expect(question.state).toBe("answered");
    expect(question.answers).toEqual([["Postgres"], ["Web", "iOS"]]);
    expect(question.settledAt).toBe(T0);
    expect(displayStatusOf(view)).toBe("working");
    // Still one row: the settled question replaces the open one in place.
    expect(view.timeline.filter((item) => item.kind === "question")).toHaveLength(1);
  });

  it("settles on a dismissal with its reason, and ignores a second settlement", () => {
    const stream = askedStream();
    stream.emit("question.dismissed", {
      questionId: "qst_1",
      reason: "message_sent",
      decidedBy: "user_1",
      commandId: "cmd_m",
    });
    stream.emit("question.answered", {
      questionId: "qst_1",
      answers: [["SQLite"], []],
      decidedBy: "user_1",
      commandId: "cmd_late",
    });
    const question = must(stream.fold().questions.get("qst_1" as never));
    expect(question.state).toBe("dismissed");
    expect(question.dismissal).toBe("message_sent");
    expect(question.answers).toBeNull();
  });

  it("ignores a settlement for a question it never saw, and a repeated ask", () => {
    const stream = askedStream();
    stream.emit("question.answered", {
      questionId: "qst_other",
      answers: [],
      decidedBy: "user_1",
      commandId: "cmd_x",
    });
    stream.emit("question.asked", { ...asked, questions: [must(asked.questions[0])] });
    const view = stream.fold();
    expect(view.questions.size).toBe(1);
    expect(must(view.questions.get("qst_1" as never)).questions).toHaveLength(2);
    expect(view.openQuestionId).toBe("qst_1");
  });

  it("keeps the newest open question when a second one opens", () => {
    const stream = askedStream();
    stream.emit("question.dismissed", {
      questionId: "qst_1",
      reason: "user",
      decidedBy: "user_1",
      commandId: "cmd_d",
    });
    stream.emit("question.asked", { ...asked, questionId: "qst_2" });
    const view = stream.fold();
    expect(view.openQuestionId).toBe("qst_2");
    // Settling the first again leaves the open one alone.
    const later = applyEvent(
      view,
      stream.emit("question.dismissed", {
        questionId: "qst_1",
        reason: "run_ended",
        decidedBy: null,
        commandId: null,
      }),
    );
    expect(later.openQuestionId).toBe("qst_2");
  });

  it("says waiting for approval when an approval is open beside the question", () => {
    const stream = askedStream();
    stream.emit("approval.requested", {
      approvalId: "apr_1",
      title: "Supply KEY",
      intendedAction: "Supply KEY",
      category: "development_secret",
      risk: "medium",
      resource: "KEY",
      requestedScope: "this sandbox",
      expiresAt: "2026-09-01T13:00:00.000Z",
      toolCallId: null,
    });
    expect(displayStatusOf(stream.fold())).toBe("waiting_for_approval");
  });

  it("stops saying waiting once the run has ended", () => {
    const stream = askedStream();
    stream.emit("run.cancelled", {
      by: { kind: "user", userId: "user_1" },
      checkpointId: null,
      summary: null,
      ...outcomeTail,
    });
    const view = stream.fold();
    expect(view.openQuestionId).toBe("qst_1");
    expect(displayStatusOf(view)).toBe("cancelled");
  });
});
