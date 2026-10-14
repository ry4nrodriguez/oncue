/**
 * The reducer's handling of the harness's own permission asks (record 09,
 * "Agent permissions"): forwarded one at a time as `approval.requested`,
 * answered `once` or `reject` from the object's frame, never `always`, and
 * rejected when the run ends. OnCue's secret tool keeps its own path.
 */

import { parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentEffect,
  type AgentInput,
  type AgentState,
  initialAgentState,
  type StepContext,
  type StepOutcome,
  step,
} from "./agent";
import {
  buildCommandFrame,
  buildGrantFrame,
  type DeliverableCommand,
  type ModelGrantFrame,
} from "./frames";
import type { RuntimeEvent } from "./normalize";
import { OPENCODE_PORT } from "./opencode";
import { DEADLINE_GRACE_MS } from "./permissions";
import { bridgeConfig, type SequenceCursor, stampDraft } from "./protocol";

const IDENTITY = { sessionId: "sess_1", generation: 3 };
const CONFIG = bridgeConfig({ ...IDENTITY, bootstrapCredential: "cred" }, "wss://oncue.example");

function ctx(): StepContext {
  let issued = 0;
  return {
    nowMs: 50_000,
    nowIso: "2026-10-04T00:00:50.000Z",
    newId: () => `id_${++issued}`,
    relayPort: 5001,
    toolPort: 5002,
  };
}

/** Every emitted draft must survive the real parser as the object would run it. */
function run(state: AgentState, input: AgentInput, context = ctx()): StepOutcome {
  const result = step(state, input, context);
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `evt_${++issued}`, now: () => "2026-10-04T00:00:00.000Z" };
  for (const effect of result.effects) {
    if (effect.kind === "emit") {
      const parsed = parseEventJson(
        JSON.stringify(stampDraft(CONFIG, cursor, io, effect.draft)),
        "sandbox",
      );
      expect(parsed.ok, `${effect.draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
    }
  }
  return result;
}

function command(type: DeliverableCommand["type"], payload: Record<string, unknown>) {
  return {
    kind: "frame" as const,
    frame: {
      kind: "command" as const,
      frame: buildCommandFrame(
        IDENTITY,
        {
          commandId: `cmd_${type}`,
          sessionId: "sess_1",
          runId: type === "run.start" ? null : "run_1",
          issuedAt: "2026-10-04T00:00:00.000Z",
          issuedByUserId: "usr_1",
          expected: { scope: "session", state: "active" },
          type,
          payload,
        } as unknown as DeliverableCommand,
        type === "runtime.shutdown" ? null : "run_1",
        null,
      ),
    },
  };
}

function running(runtime: "opencode" | "claude" = "opencode"): AgentState {
  const grant = buildGrantFrame(IDENTITY, {
    kind: "model",
    grantId: "grant_model",
    expiresAt: "2026-10-04T00:10:00.000Z",
    token: "ot1.token",
    effort: null,
    modelSpec: null,
    brokerOrigin: "https://oncue.example",
    model: { provider: "anthropic", modelId: "claude-sonnet-5" },
    runtime,
    workspace: "none",
  }) as ModelGrantFrame;
  let state = run(initialAgentState("sess_1", 3), {
    kind: "frame",
    frame: { kind: "grant", frame: grant },
  }).state;
  state = run(state, {
    kind: "runtime_started",
    result: { kind: "started", pid: 42, port: OPENCODE_PORT },
  }).state;
  state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
  state = run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
  state = run(
    state,
    command("run.start", {
      instruction: { messageId: "msg_1", text: "Read the hosts file.", attachments: [] },
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        modelConnectionId: "conn_1",
        authenticationType: "api_key",
        contextWindow: 200_000,
        effort: null,
      },
      continuesRunId: null,
    }),
  ).state;
  return run(state, {
    kind: "prompt_settled",
    turnBase: null,
    runId: "run_1",
    result: { kind: "held", conversation: "ses_1" },
  }).state;
}

const event = (value: RuntimeEvent): AgentInput => ({ kind: "runtime_event", event: value });

const readPart = (callId: string, status: "running" | "completed" = "running") =>
  event({
    kind: "tool_part",
    messageId: "msg_a",
    part: {
      callId,
      tool: "read",
      status,
      title: null,
      input: { filePath: "/etc/hosts" },
      output: status === "completed" ? "ok" : null,
      error: null,
      exitCode: null,
      startedAtMs: 1,
      endedAtMs: status === "completed" ? 2 : null,
    },
  });

const outsideAsk = (requestId: string, callId: string | null = "call_1") =>
  event({
    kind: "permission_asked",
    requestId,
    permission: "external_directory",
    callId,
    patterns: ["/etc/*"],
    metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
  });

function requested(effects: readonly AgentEffect[]) {
  return effects.flatMap((effect) =>
    effect.kind === "emit" && effect.draft.type === "approval.requested"
      ? [effect.draft.payload as Record<string, unknown>]
      : [],
  );
}

function replies(effects: readonly AgentEffect[]) {
  return effects.flatMap((effect) => (effect.kind === "reply_permission" ? [effect] : []));
}

const secretAsk = (requestId: string, callId: string) =>
  event({ kind: "permission_asked", requestId, permission: "oncue_secret_request", callId });

const secretPart = (callId: string, tool = "oncue_secret_request") =>
  event({
    kind: "tool_part",
    messageId: "msg_a",
    part: {
      callId,
      tool,
      status: "running",
      title: null,
      input: { name: "STRIPE_TEST_KEY" },
      output: null,
      error: null,
      exitCode: null,
      startedAtMs: 1,
      endedAtMs: null,
    },
  });

const approval = (requestRef: string, outcome: string): AgentInput =>
  ({
    kind: "frame",
    frame: { kind: "approval", requestRef, outcome, expiresAt: null },
  }) as AgentInput;

describe("a harness permission ask", () => {
  it("is forwarded with OnCue's category, the bounded resource, the tool's kind, and the call", () => {
    const seen = run(running(), readPart("call_1")).state;
    const asked = run(seen, outsideAsk("per_1"));
    expect(requested(asked.effects)).toEqual([
      expect.objectContaining({
        category: "outside_project",
        resource: "/etc/hosts",
        toolCategory: "file_read",
        toolCallId: "call_1",
      }),
    ]);
    expect(replies(asked.effects)).toEqual([]);
    expect(asked.state.permissions.held).toHaveLength(1);
  });

  it("names no tool kind when the bridge has not seen the call", () => {
    const asked = run(running(), outsideAsk("per_1", null));
    const [payload] = requested(asked.effects);
    expect(payload).not.toHaveProperty("toolCategory");
    expect(payload?.toolCallId).toBeNull();
  });

  it("answers once when the object allows, and forwards the next ask then", () => {
    let state = run(running(), outsideAsk("per_1")).state;
    const second = run(state, outsideAsk("per_2", "call_2"));
    expect(requested(second.effects)).toEqual([]);
    state = second.state;
    const ref = state.permissions.held[0]?.ref as string;
    const allowed = run(state, approval(ref, "allowed"));
    expect(replies(allowed.effects)).toEqual([
      { kind: "reply_permission", requestId: "per_1", reply: "once", message: null },
    ]);
    expect(requested(allowed.effects)).toHaveLength(1);
    expect(JSON.stringify(allowed.effects)).not.toContain('"always"');
  });

  it("rejects with the object's reason when denied", () => {
    const state = run(running(), outsideAsk("per_1")).state;
    const ref = state.permissions.held[0]?.ref as string;
    const denied = run(state, approval(ref, "denied"));
    expect(replies(denied.effects)).toEqual([
      expect.objectContaining({ requestId: "per_1", reply: "reject" }),
    ]);
    expect(denied.state.permissions.held).toEqual([]);
  });

  it("denies on the bridge's own deadline when no frame can say so", () => {
    const state = run(running(), outsideAsk("per_1")).state;
    const ref = state.permissions.held[0]?.ref as string;
    const late = run(state, { kind: "approval_deadline", ref });
    expect(replies(late.effects)).toEqual([
      expect.objectContaining({ requestId: "per_1", reply: "reject" }),
    ]);
  });

  it("is rejected with every other held ask when the run ends", () => {
    let state = run(running(), outsideAsk("per_1")).state;
    state = run(state, outsideAsk("per_2", "call_2")).state;
    // A cancel aborts the turn; the run ends when the harness goes idle.
    state = run(state, command("run.cancel", { reason: null, checkpointFirst: false })).state;
    const ended = run(state, event({ kind: "session_idle" }));
    expect(replies(ended.effects).map((reply) => [reply.requestId, reply.reply])).toEqual([
      ["per_1", "reject"],
      ["per_2", "reject"],
    ]);
    expect(ended.state.permissions.held).toEqual([]);
  });

  it("is rejected on shutdown", () => {
    const state = run(running(), outsideAsk("per_1")).state;
    const down = run(state, command("runtime.shutdown", { reason: "idle", graceMs: 1000 }));
    expect(replies(down.effects)).toEqual([
      expect.objectContaining({ requestId: "per_1", reply: "reject" }),
    ]);
  });

  it("is rejected at once with no run active", () => {
    let state = running();
    state = { ...state, run: { kind: "idle" } };
    const asked = run(state, outsideAsk("per_1"));
    expect(replies(asked.effects)).toEqual([
      expect.objectContaining({
        requestId: "per_1",
        reply: "reject",
        message: "No run is active.",
      }),
    ]);
    expect(requested(asked.effects)).toEqual([]);
  });

  it("stops being followed when its call settles some other way", () => {
    let state = run(running(), readPart("call_1")).state;
    state = run(state, outsideAsk("per_1")).state;
    state = run(state, outsideAsk("per_2", "call_2")).state;
    const settled = run(state, {
      ...readPart("call_2", "completed"),
    });
    expect(settled.state.permissions.held.map((held) => held.requestId)).toEqual(["per_1"]);
  });

  it("keeps OnCue's secret tool on its own path", () => {
    const asked = run(
      running(),
      event({
        kind: "permission_asked",
        requestId: "per_s",
        permission: "oncue_secret_request",
        callId: "call_s",
      }),
    );
    expect(asked.state.secrets.waiting).toMatchObject({ requestId: "per_s" });
    expect(asked.state.permissions.held).toEqual([]);
  });

  it("holds a permission ask back while a secret card is open, then forwards it where a reject does not spread", () => {
    const secretKey = "mcp__oncue__secret_request";
    let state = run(
      running("claude"),
      event({
        kind: "permission_asked",
        requestId: "per_s",
        permission: secretKey,
        callId: "call_s",
      }),
    ).state;
    state = run(state, secretPart("call_s", secretKey)).state;
    const held = run(state, outsideAsk("per_1"));
    expect(requested(held.effects)).toEqual([]);
    const secretRef = held.state.secrets.waiting?.ref as string;
    const closed = run(held.state, approval(secretRef, "denied"));
    expect(requested(closed.effects)).toEqual([
      expect.objectContaining({ category: "other_request" }),
    ]);
  });

  it("forgets a permission ask OpenCode rejected along with a denied secret", () => {
    let state = run(running(), secretAsk("per_s", "call_s")).state;
    state = run(state, secretPart("call_s")).state;
    const held = run(state, outsideAsk("per_1"));
    const secretRef = held.state.secrets.waiting?.ref as string;
    const closed = run(held.state, approval(secretRef, "denied"));
    expect(requested(closed.effects)).toEqual([]);
    expect(closed.state.permissions.held).toEqual([]);
    expect(replies(closed.effects).map((reply) => reply.requestId)).toEqual(["per_s"]);
  });

  it("holds a secret request while a permission card is out, and sends it once that card is answered", () => {
    let state = run(running(), outsideAsk("per_1")).state;
    state = run(state, secretAsk("per_s", "call_s")).state;
    const named = run(state, secretPart("call_s"));
    // Not refused, and not shown beside the permission card.
    expect(replies(named.effects)).toEqual([]);
    expect(requested(named.effects)).toEqual([]);
    expect(named.state.secrets.waiting).toMatchObject({ name: "STRIPE_TEST_KEY", asked: false });
    const ref = named.state.permissions.held[0]?.ref as string;
    const allowed = run(named.state, approval(ref, "allowed"));
    expect(replies(allowed.effects)).toEqual([
      { kind: "reply_permission", requestId: "per_1", reply: "once", message: null },
    ]);
    expect(requested(allowed.effects)).toEqual([
      expect.objectContaining({ category: "development_secret", resource: "STRIPE_TEST_KEY" }),
    ]);
    // And a permission ask arriving now waits behind the secret's card.
    expect(requested(run(allowed.state, outsideAsk("per_2", "call_2")).effects)).toEqual([]);
  });

  it("sends a waiting secret request before the next queued permission ask", () => {
    let state = run(running("claude"), outsideAsk("per_1")).state;
    state = run(state, outsideAsk("per_2", "call_2")).state;
    const secretKey = "mcp__oncue__secret_request";
    state = run(
      state,
      event({
        kind: "permission_asked",
        requestId: "per_s",
        permission: secretKey,
        callId: "call_s",
      }),
    ).state;
    state = run(state, secretPart("call_s", secretKey)).state;
    const ref = state.permissions.held[0]?.ref as string;
    const denied = run(state, approval(ref, "denied"));
    expect(requested(denied.effects)).toEqual([
      expect.objectContaining({ category: "development_secret" }),
    ]);
    expect(denied.state.permissions.held.map((held) => [held.requestId, held.forwarded])).toEqual([
      ["per_2", false],
    ]);
  });

  it("forwards none of the asks OpenCode rejected along with a denied one", () => {
    let state = run(running(), outsideAsk("per_1")).state;
    state = run(state, outsideAsk("per_2", "call_2")).state;
    state = run(state, secretAsk("per_s", "call_s")).state;
    const ref = state.permissions.held[0]?.ref as string;
    const denied = run(state, approval(ref, "denied"));
    expect(replies(denied.effects).map((reply) => reply.requestId)).toEqual(["per_1"]);
    expect(requested(denied.effects)).toEqual([]);
    expect(denied.state.permissions.held).toEqual([]);
    // The secret request was never shown, so it is forgotten too.
    expect(denied.state.secrets.waiting).toBeNull();
  });

  it("drops an ask OpenCode says it settled, whoever answered it", () => {
    let state = run(running(), outsideAsk("per_1")).state;
    state = run(state, outsideAsk("per_2", "call_2")).state;
    state = run(state, secretAsk("per_s", "call_s")).state;
    const replied = (requestId: string) => event({ kind: "permission_replied", requestId });
    state = run(state, replied("per_2")).state;
    expect(state.permissions.held.map((held) => held.requestId)).toEqual(["per_1"]);
    state = run(state, replied("per_s")).state;
    expect(state.secrets.waiting).toBeNull();
    // The one out stays for its frame.
    expect(run(state, replied("per_1")).state.permissions.held).toHaveLength(1);
  });

  it("arms its own deadline when an ask is sent, past the card's expiry, so a lost answer cannot hold the queue", () => {
    const before = Date.now();
    const asked = run(running(), outsideAsk("per_1"));
    const [payload] = requested(asked.effects);
    const timer = asked.effects.find((effect) => effect.kind === "approval_timer") as
      | { ref: string; atMs: number }
      | undefined;
    expect(timer?.ref).toBe(payload?.approvalId);
    expect(timer?.atMs).toBe(Date.parse(payload?.expiresAt as string) + DEADLINE_GRACE_MS);
    expect(timer?.atMs as number).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    // No frame ever came: the deadline denies it and the next ask goes out.
    const second = run(asked.state, outsideAsk("per_2", "call_2"));
    const late = run(second.state, { kind: "approval_deadline", ref: timer?.ref as string });
    expect(replies(late.effects)).toEqual([
      expect.objectContaining({ requestId: "per_1", reply: "reject" }),
    ]);
  });

  it("maps Claude Code's can_use_tool for a read outside the work tree", () => {
    const asked = run(
      running("claude"),
      event({
        kind: "permission_asked",
        requestId: "perm-1",
        permission: "Read",
        callId: "toolu_1",
        input: { file_path: "/home/oncue-agent/.npmrc" },
      }),
    );
    expect(requested(asked.effects)).toEqual([
      expect.objectContaining({
        category: "outside_project",
        resource: "/home/oncue-agent/.npmrc",
      }),
    ]);
  });
});
