import { describe, expect, it } from "vitest";
import { EVENT_CATALOG, EVENT_TYPES, type EventType, eventTypesIn } from "./catalog";
import { EVENT_FAMILIES, type EventFamily } from "./define";
import { PROTOCOL_VERSION } from "./envelope";
import {
  assertNever,
  buildEvent,
  type EventIn,
  type ParseSource,
  type PayloadInputOf,
  type ProtocolEvent,
  parseCommittedEvent,
  parseEvent,
  parseEventJson,
} from "./events";
import { PAYLOAD_DEFAULTS, testModelRecord } from "./testing";

const RECORD_04_EVENT_TYPES = [
  "runtime.connected",
  "runtime.ready",
  "runtime.heartbeat",
  "run.queued",
  "run.started",
  "run.paused",
  "run.interrupted",
  "run.verified",
  "run.completed_with_warnings",
  "run.completed",
  "run.blocked",
  "run.failed",
  "run.cancelled",
  "runtime.disconnected",
  "message.started",
  "message.delta",
  "message.completed",
  "status.updated",
  "plan.created",
  "plan.updated",
  "plan.completed",
  "plan.blocked",
  "plan.cancelled",
  "tool.requested",
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
  "file.changed",
  "repository.status",
  "repository.checkpointed",
  "diff.updated",
  "git.committed",
  "git.push.requested",
  "git.push.completed",
  "git.push.failed",
  "git.push.withheld",
  "pull_request.described",
  "pull_request.created",
  "pull_request.updated",
  "pull_request.state_changed",
  "policy.proposed",
  "policy.updated",
  "policy.declined",
  "command.acknowledged",
  "command.rejected",
  "message.queued",
  "sandbox.keepalive.updated",
  "sandbox.provisioning",
  "sandbox.attached",
  "sandbox.idle",
  "sandbox.checkpointed",
  "sandbox.checkpoint_failed",
  "sandbox.output",
  "sandbox.stopped",
  "sandbox.replaced",
  "sandbox.credentials_revoked",
  "review.imported",
  "review.updated",
  "review.selected",
  "review.addressed",
  "review.dismissed",
  "verification.started",
  "verification.result",
  "verification.completed",
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "approval.mode_changed",
  "secrets.disclosed",
  "secrets.supplied",
  "question.asked",
  "question.answered",
  "question.dismissed",
  "artifact.uploading",
  "artifact.created",
  "artifact.failed",
  "agent.started",
  "agent.completed",
] as const;

const NOW = "2026-09-01T12:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "a".repeat(64);

const artifact = {
  artifactId: "art_1",
  kind: "log",
  contentType: "text/plain",
  byteSize: 1024,
  label: "test output",
} as const;

function frame<T extends EventType>(
  type: T,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const spec = EVENT_CATALOG[type];
  return {
    eventId: "evt_1",
    sessionId: "sess_1",
    runId: spec.scope === "run" ? "run_1" : null,
    sandboxGeneration: 3,
    runtimeSequence: spec.origin === "control" ? null : 42,
    type,
    occurredAt: NOW,
    protocolVersion: PROTOCOL_VERSION,
    payload,
    ...overrides,
  };
}

function sourceFor(type: EventType): ParseSource {
  return EVENT_CATALOG[type].origin === "control" ? "control" : "sandbox";
}

function expectAccepted<T extends EventType>(type: T, payload: PayloadInputOf<T>): ProtocolEvent {
  const result = parseEvent(frame(type, payload), sourceFor(type));
  if (!result.ok) {
    throw new Error(`${type} rejected: ${result.reason} ${result.detail}`);
  }
  expect(result.value.type).toBe(type);
  return result.value;
}

function expectRejected(type: EventType, payload: unknown, detailIncludes: string): void {
  const result = parseEvent(frame(type, payload), sourceFor(type));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("payload");
  expect(result.detail).toContain(detailIncludes);
}

describe("catalog", () => {
  it("declares exactly the types record 04 names, in its order", () => {
    expect(EVENT_TYPES).toEqual(RECORD_04_EVENT_TYPES);
    expect(EVENT_TYPES).toHaveLength(79);
  });

  it("groups by record 04's headings, not by type prefix", () => {
    expect(eventTypesIn("policy")).toEqual([
      "policy.proposed",
      "policy.updated",
      "policy.declined",
      "command.acknowledged",
      "command.rejected",
      "message.queued",
      "sandbox.keepalive.updated",
    ]);
    const counts = Object.fromEntries(
      EVENT_FAMILIES.map((family) => [family, eventTypesIn(family).length]),
    );
    expect(counts).toEqual({
      lifecycle: 14,
      messages: 4,
      plans: 5,
      tools: 5,
      files: 4,
      git: 9,
      policy: 7,
      sandbox: 9,
      review: 5,
      verification: 3,
      approvals: 6,
      questions: 3,
      artifacts: 3,
      agents: 2,
    });
  });

  it("marks exactly the streaming classes ephemeral", () => {
    const ephemeral = EVENT_TYPES.filter((type) => EVENT_CATALOG[type].durability === "ephemeral");
    expect(ephemeral).toEqual(["runtime.heartbeat", "message.delta", "tool.output"]);
  });
});

describe("envelope rules derived from the catalog", () => {
  const connected = {
    bridgeVersion: "0.1.0",
    runtimeName: "opencode",
    runtimeVersion: "1.4.2",
    protocolVersion: 1,
    capabilities: ["tools"],
  };

  it("requires runId on a run-scoped type and forbids it on a session-scoped type", () => {
    const missing = parseEvent(
      frame("tool.started", { toolCallId: "tc_1" }, { runId: null }),
      "sandbox",
    );
    expect(missing).toMatchObject({ ok: false, reason: "missing_run_id" });
    const extra = parseEvent(frame("runtime.connected", connected, { runId: "run_1" }), "sandbox");
    expect(extra).toMatchObject({ ok: false, reason: "unexpected_run_id" });
  });

  it("derives runtimeSequence from origin", () => {
    const sandboxWithout = parseEvent(
      frame("runtime.connected", connected, { runtimeSequence: null }),
      "sandbox",
    );
    expect(sandboxWithout).toMatchObject({ ok: false, reason: "missing_runtime_sequence" });
    const controlWith = parseEvent(
      frame(
        "approval.expired",
        { approvalId: "apr_1", effect: "tool_denied" },
        { runtimeSequence: 7 },
      ),
      "control",
    );
    expect(controlWith).toMatchObject({ ok: false, reason: "unexpected_runtime_sequence" });
  });

  it("rejects a sandbox frame carrying a control-origin type", () => {
    const resolved = frame("approval.resolved", {
      approvalId: "apr_1",
      decision: "approved",
      decidedBy: "user_1",
      commandId: "cmd_1",
      decidedForGeneration: 3,
    });
    expect(parseEvent(resolved, "sandbox")).toMatchObject({ ok: false, reason: "wrong_origin" });
    expect(parseEvent(resolved, "control").ok).toBe(true);
    expect(parseEvent(resolved, "storage").ok).toBe(true);
  });

  it("accepts an either-origin type from both sides with the matching sequence rule", () => {
    const paused = { reason: "user_requested", detail: "Paused by user", checkpointId: null };
    expect(parseEvent(frame("run.paused", paused, { runtimeSequence: null }), "control").ok).toBe(
      true,
    );
    expect(parseEvent(frame("run.paused", paused, { runtimeSequence: 9 }), "sandbox").ok).toBe(
      true,
    );
    expect(
      parseEvent(frame("run.paused", paused, { runtimeSequence: 9 }), "control"),
    ).toMatchObject({
      ok: false,
      reason: "unexpected_runtime_sequence",
    });
  });

  it("accepts Done only from the sandbox: the control plane never claims a run changed nothing", () => {
    const done = {
      summary: {
        whatChanged: "Answered the question.",
        why: "Asked for it.",
        verificationPerformed: "None: this run changed no files.",
        limitations: [],
        nextStep: null,
      },
      evidence: [],
      branch: null,
      pullRequestNumber: null,
      usage: null,
      durationMs: 10,
    };
    expect(parseEvent(frame("run.completed", done, { runtimeSequence: 4 }), "sandbox").ok).toBe(
      true,
    );
    expect(parseEvent(frame("run.completed", done, { runtimeSequence: null }), "control").ok).toBe(
      false,
    );
  });

  it("lets the control plane commit completed_with_warnings, but never verified", () => {
    const tail = {
      summary: {
        whatChanged: "Edited the README.",
        why: "Asked for it.",
        verificationPerformed: "None passed.",
        limitations: [],
        nextStep: null,
      },
      evidence: [],
      branch: "oncue/task-1",
      pullRequestNumber: null,
      usage: null,
      durationMs: 10,
    };
    const warned = {
      ...tail,
      warnings: [{ text: "No passing test.", recommendedAction: "Run it." }],
    };
    expect(
      parseEvent(frame("run.completed_with_warnings", warned, { runtimeSequence: null }), "control")
        .ok,
    ).toBe(true);
    expect(
      parseEvent(frame("run.completed_with_warnings", warned, { runtimeSequence: 4 }), "sandbox")
        .ok,
    ).toBe(true);
    expect(
      parseEvent(frame("run.verified", tail, { runtimeSequence: null }), "control"),
    ).toMatchObject({ ok: false, reason: "wrong_origin" });
  });

  it("rejects an unknown type, a wrong version, an extra envelope field, and malformed JSON", () => {
    expect(
      parseEvent(frame("tool.started", {}, { type: "tool.exploded" }), "sandbox"),
    ).toMatchObject({
      ok: false,
      reason: "unknown_type",
    });
    expect(parseEvent(frame("tool.started", {}, { protocolVersion: 2 }), "sandbox")).toMatchObject({
      ok: false,
      reason: "unsupported_version",
    });
    expect(parseEvent(frame("tool.started", {}, { origin: "sandbox" }), "sandbox")).toMatchObject({
      ok: false,
      reason: "envelope",
    });
    expect(parseEventJson("{not json", "sandbox")).toMatchObject({
      ok: false,
      reason: "malformed_json",
    });
    expect(parseEventJson("x".repeat(256 * 1024 + 1), "sandbox")).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("never echoes a received value in the failure detail", () => {
    const secret = "sk-live-do-not-log";
    const result = parseEvent(frame("tool.started", { toolCallId: 12, extra: secret }), "sandbox");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(secret);
    expect(result.detail).not.toContain("12");
    expect(result.detail).toContain("payload.toolCallId");
  });

  it("commits durable events with a stamp and refuses ephemeral ones", () => {
    const committed = parseCommittedEvent({
      ...frame("tool.started", { toolCallId: "tc_1" }),
      sessionSequence: 10,
      committedAt: NOW,
    });
    expect(committed).toMatchObject({
      ok: true,
      value: { sessionSequence: 10, type: "tool.started" },
    });
    const delta = parseCommittedEvent({
      ...frame("message.delta", {
        messageId: "msg_1",
        partIndex: 0,
        part: { type: "text", text: "hi" },
      }),
      sessionSequence: 11,
      committedAt: NOW,
    });
    expect(delta).toMatchObject({ ok: false, reason: "ephemeral" });
    expect(parseCommittedEvent(frame("tool.started", { toolCallId: "tc_1" }))).toMatchObject({
      ok: false,
      reason: "envelope",
    });
  });

  it("builds through the same parser and throws with the field named", () => {
    const event = buildEvent("tool.started", {
      eventId: "evt_9",
      sessionId: "sess_1",
      runId: "run_1",
      sandboxGeneration: 1,
      runtimeSequence: 0,
      occurredAt: NOW,
      payload: { toolCallId: "tc_9" },
    });
    expect(event.runId).toBe("run_1");
    expect(() =>
      buildEvent("approval.expired", {
        eventId: "evt_9",
        sessionId: "sess_1",
        runId: "run_1",
        sandboxGeneration: 1,
        runtimeSequence: null,
        occurredAt: NOW,
        payload: { approvalId: "apr_1", effect: "shrug" as "tool_denied" },
      }),
    ).toThrow(/payload\.effect/);
  });
});

describe("lifecycle", () => {
  it("accepts a verified outcome with a completion summary", () => {
    expectAccepted("run.verified", {
      summary: {
        whatChanged: "Added a regression test",
        why: "The bug was untested",
        verificationPerformed: "pnpm test",
        limitations: [],
        nextStep: null,
      },
      evidence: [artifact],
      branch: "oncue/fix-login-7f3a",
      pullRequestNumber: 12,
      usage: { usedTokens: 1200, maxTokens: 200000 },
      durationMs: 90000,
    });
  });
  it("accepts a run.queued whose model record predates the effort level, and rejects a level outside the list", () => {
    const { effort: _effort, ...before } = testModelRecord();
    const queued = PAYLOAD_DEFAULTS["run.queued"]();
    const accepted = expectAccepted("run.queued", { ...queued, model: before });
    expect(
      Object.hasOwn((accepted as { payload: { model: object } }).payload.model, "effort"),
    ).toBe(false);
    expectRejected(
      "run.queued",
      { ...queued, model: { ...testModelRecord(), effort: "turbo" } },
      "payload.model.effort",
    );
  });
  it("rejects a pause reason outside the closed list", () => {
    expectRejected(
      "run.paused",
      { reason: "coffee_break", detail: "x", checkpointId: null },
      "payload.reason",
    );
  });
});

describe("messages", () => {
  it("accepts a completed message with every part kind", () => {
    expectAccepted("message.completed", {
      messageId: "msg_1",
      role: "assistant",
      parts: [
        { type: "text", text: "Done." },
        { type: "reasoning_summary", text: "Checked the tests first." },
        { type: "tool_ref", toolCallId: "tc_1" },
        { type: "source_url", url: "https://example.com", title: "Example" },
        { type: "source_document", path: "README.md", title: "Readme" },
        { type: "artifact_ref", artifact },
        { type: "code", code: "const a = 1;", language: "typescript" },
        { type: "step_start" },
      ],
      stopReason: "end_turn",
      usage: null,
    });
  });
  const message = { messageId: "msg_1", role: "assistant", parts: [], stopReason: "end_turn" };
  it("accepts usage split by cache, and usage from before the split", () => {
    const split = {
      usedTokens: 10_114,
      maxTokens: 200_000,
      inputTokens: 2,
      outputTokens: 253,
      cachedInputTokens: 9_402,
      cacheWriteTokens: 457,
      reasoningTokens: 0,
      spent: {
        inputTokens: 4,
        outputTokens: 300,
        cachedInputTokens: 9_402,
        cacheWriteTokens: 9_859,
        reasoningTokens: 18,
      },
    };
    expectAccepted("message.completed", { ...message, usage: split } as never);
    const older = expectAccepted("message.completed", {
      ...message,
      usage: { usedTokens: 255, maxTokens: 200_000, inputTokens: 2, outputTokens: 253 },
    } as never) as unknown as { payload: { usage: object } };
    expect(Object.hasOwn(older.payload.usage, "spent")).toBe(false);
  });
  it("rejects a spent total missing a kind or carrying a negative count", () => {
    const usage = { usedTokens: 1, maxTokens: 10 };
    const spent = {
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const { reasoningTokens: _reasoning, ...partial } = spent;
    expectRejected(
      "message.completed",
      { ...message, usage: { ...usage, spent: partial } },
      "payload.usage.spent.reasoningTokens",
    );
    expectRejected(
      "message.completed",
      { ...message, usage: { ...usage, cacheWriteTokens: -1 } },
      "payload.usage.cacheWriteTokens",
    );
  });
  it("rejects a completed message without a stop reason", () => {
    expectRejected(
      "message.completed",
      { messageId: "msg_1", role: "assistant", parts: [], usage: null },
      "payload.stopReason",
    );
  });
});

describe("plans", () => {
  const plan = {
    planId: "plan_1",
    revision: 2,
    title: "Fix login",
    steps: [{ stepId: "s1", title: "Reproduce", status: "complete" as const }],
    activeStepId: null,
    expectedVerification: ["pnpm test"],
  };
  it("accepts a revision with a change summary", () => {
    expectAccepted("plan.updated", { ...plan, changeSummary: "Found the bug in the reducer." });
  });
  it("rejects a step status outside the five-value list", () => {
    expectRejected(
      "plan.updated",
      { ...plan, steps: [{ stepId: "s1", title: "x", status: "done" }], changeSummary: null },
      "payload.steps.0.status",
    );
  });
});

describe("tools", () => {
  it("accepts an artifact-backed result", () => {
    expectAccepted("tool.completed", {
      toolCallId: "tc_1",
      durationMs: 1240,
      exitCode: 0,
      result: { kind: "artifact", summary: "42 tests passed", artifact, truncated: false },
    });
  });
  it("rejects an artifact result that names no artifact", () => {
    expectRejected(
      "tool.completed",
      {
        toolCallId: "tc_1",
        durationMs: 1,
        exitCode: 0,
        result: { kind: "artifact", summary: "x", truncated: false },
      },
      "payload.result.artifact",
    );
  });
});

describe("files", () => {
  it("accepts an inline diff", () => {
    expectAccepted("diff.updated", {
      scope: "turn",
      baseSha: SHA,
      headSha: SHA,
      files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
      additions: 3,
      deletions: 1,
      body: { kind: "inline", patch: "--- a\n+++ b\n" },
      truncated: false,
    });
  });
  it("rejects a diff without a turn or session scope", () => {
    const diff = {
      baseSha: SHA,
      headSha: SHA,
      files: [],
      additions: 0,
      deletions: 0,
      body: { kind: "inline", patch: "" },
      truncated: false,
    };
    expectRejected("diff.updated", diff, "scope");
    expectRejected("diff.updated", { ...diff, scope: "workspace" }, "payload.scope");
  });
  it("rejects a file status AI Elements cannot render", () => {
    expectRejected(
      "file.changed",
      {
        change: { path: "src/a.ts", status: "changed", additions: 0, deletions: 0 },
        byAgent: true,
      },
      "payload.change.status",
    );
  });
});

describe("git", () => {
  it("accepts a commit in the Commit component's shape", () => {
    expectAccepted("git.committed", {
      commitSha: SHA,
      parentSha: null,
      branch: "oncue/fix-login-7f3a",
      message: "Add regression test",
      authorType: "agent",
      authorName: "OnCue Agent",
      committedAt: NOW,
      files: [{ path: "src/a.test.ts", status: "added", additions: 20, deletions: 0 }],
      additions: 20,
      deletions: 0,
      verificationState: "passing",
      policy: { policyVersion: 1, rule: "auto_commit", approvalId: null },
    });
  });
  it("rejects a push failure category outside record 07's list", () => {
    expectRejected(
      "git.push.failed",
      {
        pushId: "push_1",
        branch: "b",
        headSha: SHA,
        category: "unknown_reason",
        message: "x",
        retryable: false,
      },
      "payload.category",
    );
  });
});

describe("policy", () => {
  const policy = {
    version: 1,
    commit: "auto",
    push: "auto",
    pullRequest: "auto_after_verification",
    planApproval: "proceed",
    fileEdits: "allowed",
  } as const;
  it("accepts a confirmed policy change with before and after", () => {
    expectAccepted("policy.updated", {
      proposalId: "prop_1",
      from: policy,
      to: { ...policy, version: 2, push: "never" },
      confirmedBy: "immediate_narrowing",
      userId: "user_1",
      effectiveAt: NOW,
    });
  });
  it("rejects a confirmation source the control plane does not recognise", () => {
    expectRejected(
      "policy.updated",
      {
        proposalId: null,
        from: policy,
        to: policy,
        confirmedBy: "agent",
        userId: null,
        effectiveAt: NOW,
      },
      "payload.confirmedBy",
    );
  });
});

describe("sandbox", () => {
  it("accepts a planned stop with a checkpoint", () => {
    expectAccepted("sandbox.stopped", {
      outcome: "stopped",
      reason: "idle",
      checkpointId: "ckpt_1",
      unsavedWorkWarning: null,
      diagnostics: [],
    });
  });
  it("rejects a stop that does not say whether the sandbox failed", () => {
    expectRejected(
      "sandbox.stopped",
      { reason: "idle", checkpointId: null, unsavedWorkWarning: null, diagnostics: [] },
      "payload.outcome",
    );
  });
});

describe("review", () => {
  const imported = {
    reviewItemId: "rev_1",
    githubId: "123",
    pullRequestNumber: 12,
    author: "octocat",
    authorType: "human",
    body: "Please rename this.",
    sourceType: "review_comment",
    location: { path: "src/a.ts", line: 10, side: "RIGHT", commitSha: SHA },
    threadId: null,
    parentId: null,
    githubState: "commented",
    locationCurrent: true,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
  it("accepts an imported inline comment", () => {
    expectAccepted("review.imported", imported);
  });
  it("rejects a diff side GitHub does not use", () => {
    expectRejected(
      "review.imported",
      { ...imported, location: { ...imported.location, side: "TOP" } },
      "payload.location.side",
    );
  });
});

describe("verification", () => {
  it("rejects a check start that does not say why the check applies", () => {
    expectRejected(
      "verification.started",
      {
        checkId: "chk_1",
        name: "unit tests",
        category: "test",
        classification: "required",
        source: "repository_requirement",
        method: { kind: "command", command: "pnpm test", cwd: null },
        revision: SHA,
        baseRevision: null,
        attempt: 1,
      },
      "reason",
    );
  });
  it("accepts a structured test result", () => {
    expectAccepted("verification.result", {
      checkId: "chk_1",
      attempt: 1,
      result: "passed",
      skipReason: null,
      inconclusiveReason: null,
      exitCode: 0,
      durationMs: 4200,
      summary: "42 passed",
      baseComparison: "not_compared",
      structured: {
        passed: 42,
        failed: 0,
        skipped: 0,
        total: 42,
        suites: [
          { name: "events", status: "passed", tests: [{ name: "parses", status: "passed" }] },
        ],
      },
      evidence: [artifact],
    });
  });
  it("rejects a fifth outcome value", () => {
    expectRejected(
      "verification.result",
      {
        checkId: "chk_1",
        attempt: 1,
        result: "errored",
        skipReason: null,
        inconclusiveReason: null,
        exitCode: 1,
        durationMs: 1,
        summary: "x",
        baseComparison: "not_compared",
        structured: null,
        evidence: [],
      },
      "payload.result",
    );
  });
});

describe("approvals", () => {
  const request = {
    approvalId: "apr_1",
    title: "Use the STRIPE_TEST_KEY secret",
    intendedAction: "Inject the optional development secret into the sandbox",
    category: "development_secret",
    risk: "medium",
    resource: "STRIPE_TEST_KEY",
    requestedScope: "This session only",
    expiresAt: NOW,
    toolCallId: "tc_1",
  } as const;
  it("accepts a request described in plain language", () => {
    expectAccepted("approval.requested", request);
  });
  it("rejects a request with no expiration", () => {
    const { expiresAt: _omitted, ...withoutExpiry } = request;
    expectRejected("approval.requested", withoutExpiry, "payload.expiresAt");
  });
});

describe("questions", () => {
  const question = {
    id: "q1",
    header: "Database",
    text: "Which database?",
    options: [{ label: "Postgres", description: "Relational" }],
    multiple: false,
    allowOther: true,
  };
  const asked: PayloadInputOf<"question.asked"> = {
    questionId: "qst_1",
    toolCallId: null,
    questions: [question],
  };

  it("accepts an ask from the sandbox and refuses one minted by the control plane", () => {
    expectAccepted("question.asked", asked);
    expect(
      parseEvent(frame("question.asked", asked, { runtimeSequence: null }), "control"),
    ).toMatchObject({ ok: false, reason: "wrong_origin" });
  });

  it("bounds an ask to four questions of six choices, and at least one question", () => {
    expectRejected("question.asked", { ...asked, questions: [] }, "payload.questions");
    expectRejected(
      "question.asked",
      { ...asked, questions: [question, question, question, question, question] },
      "payload.questions",
    );
    expectRejected(
      "question.asked",
      {
        ...asked,
        questions: [{ ...question, options: Array.from({ length: 7 }, () => question.options[0]) }],
      },
      "payload.questions.0.options",
    );
    expectRejected(
      "question.asked",
      { ...asked, questions: [{ ...question, options: [{ label: "", description: "" }] }] },
      "payload.questions.0.options.0.label",
    );
  });

  it("refuses an answer or a dismissal from the sandbox", () => {
    const answered = frame(
      "question.answered",
      { questionId: "qst_1", answers: [["Postgres"]], decidedBy: "user_1", commandId: "cmd_1" },
      { runtimeSequence: 7 },
    );
    expect(parseEvent(answered, "sandbox")).toMatchObject({ ok: false, reason: "wrong_origin" });
    const dismissed = frame(
      "question.dismissed",
      { questionId: "qst_1", reason: "run_ended", decidedBy: null, commandId: null },
      { runtimeSequence: 8 },
    );
    expect(parseEvent(dismissed, "sandbox")).toMatchObject({ ok: false, reason: "wrong_origin" });
    for (const reason of ["run_ended", "sandbox_replaced"] as const) {
      expectAccepted("question.dismissed", {
        questionId: "qst_1",
        reason,
        decidedBy: null,
        commandId: null,
      });
    }
    expectAccepted("question.dismissed", {
      questionId: "qst_1",
      reason: "run_paused",
      decidedBy: "user_1",
      commandId: "cmd_pause",
    });
  });
});

describe("artifacts", () => {
  const created = {
    artifact,
    checksum: { algorithm: "sha256", value: SHA256 },
    producer: "tool",
    classification: "temporary",
    expiresAt: NOW,
    supersedes: null,
  } as const;
  it("accepts durable metadata with a checksum", () => {
    expectAccepted("artifact.created", created);
  });
  it("rejects a checksum that is not a sha256 digest", () => {
    expectRejected(
      "artifact.created",
      { ...created, checksum: { algorithm: "sha256", value: "/tmp/output.log" } },
      "payload.checksum.value",
    );
  });
});

describe("agent permissions (record 09)", () => {
  const asked = {
    approvalId: "apr_1",
    title: "Read /etc/hosts, outside the project",
    intendedAction: "x",
    category: "outside_project",
    risk: "medium",
    resource: "/etc/hosts",
    requestedScope: "Files outside the project",
    expiresAt: NOW,
    toolCallId: null,
  } as const;
  const resolved = {
    approvalId: "apr_1",
    decision: "approved",
    decidedBy: "user_1",
    commandId: "cmd_1",
    decidedForGeneration: 1,
  } as const;

  it("accepts each permission category, with and without the tool's kind", () => {
    for (const category of [
      "outside_project",
      "secret_file",
      "repeated_action",
      "start_subagent",
      "other_request",
    ] as const) {
      expectAccepted("approval.requested", { ...asked, category });
    }
    expectAccepted("approval.requested", { ...asked, toolCategory: "shell" });
    // A subagent's ask names it; older events have no field.
    expectAccepted("approval.requested", { ...asked, agentId: "ses_child" });
  });

  it("rejects a tool kind and a scope it does not know", () => {
    expectRejected(
      "approval.requested",
      { ...asked, toolCategory: "root" },
      "payload.toolCategory",
    );
    expectRejected("approval.resolved", { ...resolved, scope: "forever" }, "payload.scope");
  });

  it("reads a resolution's scope and automatic flag as optional", () => {
    expectAccepted("approval.resolved", resolved);
    expectAccepted("approval.resolved", { ...resolved, scope: "always", automatic: true });
  });

  it("names the menu's choice and who made it", () => {
    expectAccepted("approval.mode_changed", {
      mode: "always",
      decidedBy: "user_1",
      commandId: "c",
    });
    expectRejected(
      "approval.mode_changed",
      { mode: "never", decidedBy: "user_1", commandId: "c" },
      "payload.mode",
    );
  });
});

// Compile-time proofs: a type missing from either list fails to compile, and
// the error names it.
type Listed = (typeof RECORD_04_EVENT_TYPES)[number];
type Unlisted = Exclude<EventType, Listed>;
type Undeclared = Exclude<Listed, EventType>;
const LIST_MATCHES_CATALOG: [
  [Unlisted] extends [never] ? true : Unlisted,
  [Undeclared] extends [never] ? true : Undeclared,
] = [true, true];

function familyOfEvent(event: ProtocolEvent): EventFamily {
  switch (event.type) {
    case "runtime.connected":
    case "runtime.ready":
    case "runtime.heartbeat":
    case "run.queued":
    case "run.started":
    case "run.paused":
    case "run.interrupted":
    case "run.verified":
    case "run.completed_with_warnings":
    case "run.completed":
    case "run.blocked":
    case "run.failed":
    case "run.cancelled":
    case "runtime.disconnected":
      return "lifecycle";
    case "message.started":
    case "message.delta":
    case "message.completed":
    case "status.updated":
      return "messages";
    case "plan.created":
    case "plan.updated":
    case "plan.completed":
    case "plan.blocked":
    case "plan.cancelled":
      return "plans";
    case "tool.requested":
    case "tool.started":
    case "tool.output":
    case "tool.completed":
    case "tool.failed":
      return "tools";
    case "file.changed":
    case "repository.status":
    case "repository.checkpointed":
    case "diff.updated":
      return "files";
    case "git.committed":
    case "git.push.requested":
    case "git.push.completed":
    case "git.push.failed":
    case "git.push.withheld":
    case "pull_request.described":
    case "pull_request.created":
    case "pull_request.updated":
    case "pull_request.state_changed":
      return "git";
    case "policy.proposed":
    case "policy.updated":
    case "policy.declined":
    case "command.acknowledged":
    case "command.rejected":
    case "message.queued":
    case "sandbox.keepalive.updated":
      return "policy";
    case "sandbox.provisioning":
    case "sandbox.attached":
    case "sandbox.idle":
    case "sandbox.checkpointed":
    case "sandbox.checkpoint_failed":
    case "sandbox.output":
    case "sandbox.stopped":
    case "sandbox.replaced":
    case "sandbox.credentials_revoked":
      return "sandbox";
    case "review.imported":
    case "review.updated":
    case "review.selected":
    case "review.addressed":
    case "review.dismissed":
      return "review";
    case "verification.started":
    case "verification.result":
    case "verification.completed":
      return "verification";
    case "approval.requested":
    case "approval.resolved":
    case "approval.expired":
    case "approval.mode_changed":
    case "secrets.disclosed":
    case "secrets.supplied":
      return "approvals";
    case "question.asked":
    case "question.answered":
    case "question.dismissed":
      return "questions";
    case "artifact.uploading":
    case "artifact.created":
    case "artifact.failed":
      return "artifacts";
    case "agent.started":
    case "agent.completed":
      return "agents";
    default:
      return assertNever(event);
  }
}

function approvalStatus(event: EventIn<"approvals">): string {
  switch (event.type) {
    case "approval.requested":
      return `waiting on ${event.payload.approvalId}`;
    case "approval.resolved":
      return event.payload.decision;
    case "approval.expired":
      return event.payload.effect;
    case "approval.mode_changed":
      return event.payload.mode;
    case "secrets.disclosed":
      return `${event.payload.supplied.length} supplied`;
    case "secrets.supplied":
      return event.payload.delivered ? "delivered" : "not delivered";
    default:
      return assertNever(event);
  }
}

describe("exhaustiveness", () => {
  it("switches over the closed union and narrows inside a family switch", () => {
    expect(LIST_MATCHES_CATALOG).toEqual([true, true]);
    const stub = { type: "tool.started" } as ProtocolEvent;
    expect(familyOfEvent(stub)).toBe("tools");
    for (const type of EVENT_TYPES) {
      expect(familyOfEvent({ type } as ProtocolEvent)).toBe(EVENT_CATALOG[type].family);
    }
    const resolved = expectAccepted("approval.resolved", {
      approvalId: "apr_1",
      decision: "rejected",
      decidedBy: "user_1",
      commandId: "cmd_1",
      decidedForGeneration: 3,
    });
    expect(resolved.type === "approval.resolved" && approvalStatus(resolved)).toBe("rejected");
  });
});
