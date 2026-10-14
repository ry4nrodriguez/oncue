import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS, parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  type Advance,
  advance,
  DEBUG_TOOL_TITLE,
  EVENT_TABLE,
  emptyNormalizerState,
  type NormalizeContext,
  type NormalizerState,
  PLAN_TITLE,
  PROMPT_MEMORY_LIMIT,
  type PromptCountsReading,
  plainUsage,
  type RunSignal,
  type RuntimeEvent,
  readingOf,
  TOOL_PART_TRANSITIONS,
  type ToolPart,
  toolFailureCategory,
} from "./normalize";
import { OPENCODE_RUNTIME, OPENCODE_TOOL_CATEGORY } from "./opencode";
import { HOMELESS_KINDS, isHomeless, parseServerEvent } from "./opencode-wire";
import { bridgeConfig, type Draft, type SequenceCursor, stampDraft } from "./protocol";

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  let issued = 0;
  return {
    nowMs: 10_000,
    newId: () => `id_${++issued}`,
    runId: "run_1",
    contextWindow: 200_000,
    ...overrides,
  };
}

const CONFIG = bridgeConfig(
  { sessionId: "sess_1", generation: 1, bootstrapCredential: "boot" },
  "wss://oncue.example",
);

/**
 * Every draft the normalizer produces must survive the real parser: stamp it
 * (which runs `buildEvent`), then parse it back the way the object would.
 */
function expectValid(drafts: readonly Draft[]): void {
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `evt_${++issued}`, now: () => "2026-09-11T00:00:00.000Z" };
  for (const draft of drafts) {
    const event = stampDraft(CONFIG, cursor, io, draft);
    const parsed = parseEventJson(JSON.stringify(event), "sandbox");
    expect(parsed.ok, `${draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
  }
}

function step(state: NormalizerState, event: RuntimeEvent, ctx = context()): Advance {
  const result = advance(state, event, ctx);
  expectValid(result.drafts);
  return result;
}

function tool(overrides: Partial<ToolPart>): ToolPart {
  return {
    callId: "t1",
    tool: "bash",
    status: "running",
    title: "pnpm test",
    input: { command: "pnpm test" },
    output: null,
    error: null,
    exitCode: null,
    startedAtMs: 1000,
    endedAtMs: null,
    ...overrides,
  };
}

function toolEvent(overrides: Partial<ToolPart>): RuntimeEvent {
  return { kind: "tool_part", messageId: "msg_1", part: tool(overrides) };
}

const types = (result: Advance): string[] => result.drafts.map((draft) => draft.type);

function payload<T>(draft: Draft | undefined): T {
  if (draft === undefined) {
    throw new Error("expected a draft");
  }
  return draft.payload as T;
}

describe("TOOL_PART_TRANSITIONS", () => {
  it("is total over (previous | unseen) x incoming", () => {
    const previous = ["unseen", "pending", "running", "settled"] as const;
    const incoming = ["pending", "running", "completed", "error"] as const;
    for (const from of previous) {
      for (const to of incoming) {
        expect(Array.isArray(TOOL_PART_TRANSITIONS[from][to])).toBe(true);
      }
    }
  });

  it("synthesises the requested/started prefix for a call first seen late", () => {
    expect(TOOL_PART_TRANSITIONS.unseen.completed).toEqual([
      "requested_complete",
      "started",
      "completed",
    ]);
    expect(TOOL_PART_TRANSITIONS.unseen.error).toEqual(["requested_complete", "started", "failed"]);
    expect(TOOL_PART_TRANSITIONS.pending.running).toEqual(["requested_complete", "started"]);
  });

  it("makes backwards moves empty cells rather than errors", () => {
    expect(TOOL_PART_TRANSITIONS.running.pending).toEqual([]);
    expect(TOOL_PART_TRANSITIONS.running.running).toEqual([]);
  });

  it("makes every move out of settled empty: OpenCode re-sends a settled part after an abort", () => {
    expect(Object.values(TOOL_PART_TRANSITIONS.settled).every((cell) => cell.length === 0)).toBe(
      true,
    );
  });
});

describe("tool parts", () => {
  it("running when unseen: tool.requested (input complete) then tool.started, and the call is tracked", () => {
    const result = step(emptyNormalizerState, toolEvent({ status: "running" }));

    expect(result.drafts).toEqual([
      {
        type: "message.started",
        runId: "run_1",
        payload: { messageId: "msg_1", role: "assistant" },
      },
      {
        type: "tool.requested",
        runId: "run_1",
        payload: {
          toolCallId: "t1",
          category: "shell",
          title: "pnpm test",
          runtimeName: "bash",
          input: { command: "pnpm test" },
          inputComplete: true,
          approvalId: null,
        },
      },
      { type: "tool.started", runId: "run_1", payload: { toolCallId: "t1" } },
    ]);
    expect(result.state.tools.get("t1")).toEqual({
      phase: "running",
      startedAtMs: 1000,
      title: "pnpm test",
      tool: "bash",
    });
    expect(result.signal).toEqual({ kind: "none" });
  });

  it("completed after running: one tool.completed with the inline output, and the call is settled", () => {
    const first = step(emptyNormalizerState, toolEvent({ status: "running" }));
    const then = step(
      first.state,
      toolEvent({ status: "completed", output: "42 passed", exitCode: 0, endedAtMs: 4500 }),
    );

    expect(then.drafts).toEqual([
      {
        type: "tool.completed",
        runId: "run_1",
        payload: {
          toolCallId: "t1",
          durationMs: 3500,
          exitCode: 0,
          result: { kind: "inline", summary: "pnpm test", value: { output: "42 passed" } },
        },
      },
    ]);
    expect(then.state.tools.get("t1")?.phase).toBe("settled");
    expect(then.signal).toEqual({ kind: "tool_settled", overflow: null });
  });

  it("pending: a partial tool.requested; then running completes the input and starts", () => {
    const pending = step(emptyNormalizerState, toolEvent({ status: "pending", startedAtMs: null }));
    expect(types(pending)).toEqual(["message.started", "tool.requested"]);
    expect(pending.drafts[1]?.payload).toMatchObject({ inputComplete: false });
    expect(pending.state.tools.get("t1")?.phase).toBe("pending");

    const running = step(pending.state, toolEvent({ status: "running" }));
    expect(types(running)).toEqual(["tool.requested", "tool.started"]);
    expect(running.drafts[0]?.payload).toMatchObject({ inputComplete: true });
  });

  it("running twice emits nothing the second time (OpenCode re-sends running as output accumulates)", () => {
    const first = step(emptyNormalizerState, toolEvent({ status: "running" }));
    expect(step(first.state, toolEvent({ status: "running" })).drafts).toEqual([]);
  });

  it("error when unseen: requested, started, then tool.failed with the category read from the text", () => {
    const result = step(
      emptyNormalizerState,
      toolEvent({
        callId: "t2",
        tool: "task",
        status: "error",
        error: "The user rejected permission to use this specific tool call.",
        endedAtMs: 1200,
      }),
    );
    expect(types(result)).toEqual([
      "message.started",
      "tool.requested",
      "tool.started",
      "tool.failed",
    ]);
    expect(result.drafts[3]?.payload).toMatchObject({
      toolCallId: "t2",
      durationMs: 200,
      category: "denied_by_policy",
      evidence: [],
    });
    expect(result.signal).toEqual({ kind: "tool_settled", overflow: null });
  });

  it("a settled part re-sent emits nothing and signals nothing", () => {
    const first = step(
      emptyNormalizerState,
      toolEvent({ status: "completed", output: "", endedAtMs: 2000 }),
    );
    const again = step(
      first.state,
      toolEvent({ status: "completed", output: "", endedAtMs: 2000 }),
    );
    expect(again.drafts).toEqual([]);
    expect(again.signal).toEqual({ kind: "none" });
    expect(step(first.state, toolEvent({ status: "error", error: "late" })).drafts).toEqual([]);
    expect(step(first.state, toolEvent({ status: "running" })).drafts).toEqual([]);
  });

  it("measures duration from the tracked start and the clock when the part carries no end", () => {
    const first = step(emptyNormalizerState, toolEvent({ status: "running", startedAtMs: 4000 }));
    const done = step(
      first.state,
      toolEvent({ status: "completed", startedAtMs: null, output: "x" }),
    );
    expect(done.drafts[0]?.payload).toMatchObject({ durationMs: 6000 });
  });

  it("cuts an output that would not fit the inline limit and says so", () => {
    const output = "o".repeat(LIMITS.inlineJsonChars * 2);
    const result = step(
      emptyNormalizerState,
      toolEvent({ status: "completed", output, endedAtMs: 2000 }),
    );
    const value = payload<{ result: { value: Record<string, unknown> } }>(
      result.drafts.find((draft) => draft.type === "tool.completed"),
    ).result.value;
    expect(value.truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(LIMITS.inlineJsonChars);
    expect(result.signal).toEqual({
      kind: "tool_settled",
      overflow: { toolCallId: "t1", text: output },
    });
  });

  it("a completed output that fits carries no overflow, and a failed one never does", () => {
    const fits = step(emptyNormalizerState, toolEvent({ status: "completed", output: "short" }));
    expect(fits.signal).toEqual({ kind: "tool_settled", overflow: null });
    const failed = step(
      emptyNormalizerState,
      toolEvent({ status: "error", output: "o".repeat(LIMITS.inlineJsonChars * 2), error: "x" }),
    );
    expect(failed.signal).toEqual({ kind: "tool_settled", overflow: null });
  });

  it("falls back to the tool id as the title", () => {
    const result = step(
      emptyNormalizerState,
      toolEvent({ title: null, tool: "grep", status: "running" }),
    );
    expect(result.drafts[1]?.payload).toMatchObject({ title: "grep", category: "search" });
  });

  it("a tool part of the user's own message is nothing", () => {
    const user = step(emptyNormalizerState, {
      kind: "message_started",
      messageId: "msg_1",
      role: "user",
    });
    expect(step(user.state, toolEvent({ status: "running" }))).toEqual({
      state: user.state,
      drafts: [],
      signal: { kind: "none" },
    });
  });
});

describe("toolCategory and toolFailureCategory", () => {
  it.each([
    ["bash", "shell"],
    ["edit", "file_write"],
    ["write", "file_write"],
    ["apply_patch", "file_write"],
    ["read", "file_read"],
    ["grep", "search"],
    ["glob", "search"],
    ["webfetch", "web"],
    ["websearch", "web"],
    ["todowrite", "other"],
    ["task", "other"],
    ["question", "other"],
    ["something-new", "other"],
  ])("%s -> %s", (id, category) => {
    expect(OPENCODE_RUNTIME.toolCategory(id)).toBe(category);
  });

  it("lists every tool id OpenCode 1.18.30 ships", () => {
    expect(Object.keys(OPENCODE_TOOL_CATEGORY).sort()).toEqual(
      [
        "apply_patch",
        "bash",
        "edit",
        "glob",
        "grep",
        "invalid",
        "question",
        "read",
        "skill",
        "task",
        "todowrite",
        "webfetch",
        "websearch",
        "write",
      ].sort(),
    );
  });

  it.each([
    ["Tool execution aborted", "runtime_error"],
    ["The user rejected permission to use this tool", "denied_by_policy"],
    ["task is disabled", "denied_by_policy"],
    ["command timed out after 30s", "timeout"],
    ["ENOENT", "runtime_error"],
  ])("%s -> %s", (text, category) => {
    expect(toolFailureCategory(text)).toBe(category);
  });
});

describe("messages", () => {
  it("message_started for an assistant message emits message.started once", () => {
    const first = step(emptyNormalizerState, {
      kind: "message_started",
      messageId: "m1",
      role: "assistant",
    });
    expect(first.drafts).toEqual([
      { type: "message.started", runId: "run_1", payload: { messageId: "m1", role: "assistant" } },
    ]);
    expect(
      step(first.state, { kind: "message_started", messageId: "m1", role: "assistant" }).drafts,
    ).toEqual([]);
  });

  it("the user's message is tracked as the user's with no draft, and its text part and delta are nothing", () => {
    const user = step(emptyNormalizerState, {
      kind: "message_started",
      messageId: "u1",
      role: "user",
    });
    expect(user.drafts).toEqual([]);
    expect(user.state.messages.get("u1")?.role).toBe("user");

    // The recording: `message.updated` (role user) then `message.part.updated/text` for it.
    const part = step(user.state, {
      kind: "text_part",
      messageId: "u1",
      partId: "p1",
      text: "Add a README section describing the test command.",
    });
    expect(part).toEqual({ state: user.state, drafts: [], signal: { kind: "none" } });
    expect(
      step(user.state, { kind: "text_delta", messageId: "u1", partId: "p1", text: "x" }).drafts,
    ).toEqual([]);
    expect(
      step(user.state, {
        kind: "message_completed",
        messageId: "u1",
        finish: null,
        usage: null,
        error: null,
      }).drafts,
    ).toEqual([]);
    expect(
      step(user.state, { kind: "step_finished", messageId: "u1", reason: "stop", usage: null })
        .drafts,
    ).toEqual([]);
    expect(step(user.state, { kind: "reasoning", messageId: "u1", partId: "r1" }).drafts).toEqual(
      [],
    );
    expect(
      step(user.state, { kind: "message_started", messageId: "u1", role: "user" }).drafts,
    ).toEqual([]);
  });

  it("text_delta emits an ephemeral message.delta and accumulates; the first one starts the message", () => {
    const first = step(emptyNormalizerState, {
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "Hel",
    });
    expect(first.drafts).toEqual([
      { type: "message.started", runId: "run_1", payload: { messageId: "m1", role: "assistant" } },
      {
        type: "message.delta",
        runId: "run_1",
        payload: { messageId: "m1", partIndex: 0, part: { type: "text", text: "Hel" } },
      },
    ]);
    const second = step(first.state, {
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "lo",
    });
    expect(types(second)).toEqual(["message.delta"]);
    expect(second.state.messages.get("m1")?.textByPartId.get("p1")).toBe("Hello");
  });

  it("splits a delta larger than a stream chunk into several", () => {
    const text = "d".repeat(LIMITS.streamChunkChars + 1);
    const result = step(emptyNormalizerState, {
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text,
    });
    expect(types(result)).toEqual(["message.started", "message.delta", "message.delta"]);
  });

  it("the recorded shape: a text part opens empty, streams as deltas, and closes whole, all silent but the deltas", () => {
    const opened = step(emptyNormalizerState, {
      kind: "text_part",
      messageId: "m1",
      partId: "p1",
      text: "",
    });
    expect(types(opened)).toEqual(["message.started"]);
    let state = opened.state;
    for (const text of ["I'll add", " a section."]) {
      const delta = step(state, { kind: "text_delta", messageId: "m1", partId: "p1", text });
      expect(types(delta)).toEqual(["message.delta"]);
      state = delta.state;
    }
    const closed = step(state, {
      kind: "text_part",
      messageId: "m1",
      partId: "p1",
      text: "I'll add a section.",
    });
    expect(closed.drafts).toEqual([]);
    expect(closed.state.messages.get("m1")?.textByPartId.get("p1")).toBe("I'll add a section.");
  });

  it("text_part that extends what streamed emits the remainder as a delta; one that does not replaces silently", () => {
    const partial = step(emptyNormalizerState, {
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "partial",
    });
    const extended = step(partial.state, {
      kind: "text_part",
      messageId: "m1",
      partId: "p1",
      text: "partial and the rest",
    });
    expect(extended.drafts).toEqual([
      {
        type: "message.delta",
        runId: "run_1",
        payload: { messageId: "m1", partIndex: 0, part: { type: "text", text: " and the rest" } },
      },
    ]);
    const replaced = step(partial.state, {
      kind: "text_part",
      messageId: "m1",
      partId: "p1",
      text: "whole",
    });
    expect(replaced.drafts).toEqual([]);
    expect(replaced.state.messages.get("m1")?.textByPartId.get("p1")).toBe("whole");
  });

  it("reasoning registers the part and its deltas are dropped, never streamed as text", () => {
    const reasoning = step(emptyNormalizerState, {
      kind: "reasoning",
      messageId: "m1",
      partId: "r1",
    });
    expect(types(reasoning)).toEqual(["message.started"]);
    expect(reasoning.state.messages.get("m1")?.reasoningPartIds.has("r1")).toBe(true);
    const delta = step(reasoning.state, {
      kind: "text_delta",
      messageId: "m1",
      partId: "r1",
      text: "hidden",
    });
    expect(delta.drafts).toEqual([]);
    expect(delta.state.messages.get("m1")?.textByPartId.size).toBe(0);
    const done = step(delta.state, {
      kind: "message_completed",
      messageId: "m1",
      finish: "stop",
      usage: null,
      error: null,
    });
    expect(done.drafts[0]?.payload).toMatchObject({ parts: [] });
    expect(JSON.stringify(done.drafts)).not.toContain("hidden");
  });

  it("message_completed carries the parts in order, the stop reason, and usage from the message", () => {
    let state = step(emptyNormalizerState, {
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "First.",
    }).state;
    state = step(state, {
      kind: "tool_part",
      messageId: "m1",
      part: tool({ status: "completed", output: "ok", endedAtMs: 2000 }),
    }).state;
    state = step(state, { kind: "text_delta", messageId: "m1", partId: "p2", text: "Done." }).state;
    const result = step(state, {
      kind: "message_completed",
      messageId: "m1",
      finish: "stop",
      usage: plainUsage(100, 20),
      error: null,
    });

    expect(result.drafts).toEqual([
      {
        type: "message.completed",
        runId: "run_1",
        payload: {
          messageId: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "First." },
            { type: "tool_ref", toolCallId: "t1" },
            { type: "text", text: "Done." },
          ],
          stopReason: "end_turn",
          usage: {
            usedTokens: 120,
            maxTokens: 200_000,
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        },
      },
    ]);
    expect(result.signal).toEqual({ kind: "assistant_text", text: "First.\nDone." });
    expect(result.state.messages.get("m1")?.completed).toBe(true);
  });

  it("message_completed twice emits once (OpenCode sends the completed message.updated twice)", () => {
    const first = step(emptyNormalizerState, {
      kind: "message_completed",
      messageId: "m1",
      finish: "stop",
      usage: null,
      error: null,
    });
    expect(types(first)).toEqual(["message.started", "message.completed"]);
    expect(
      step(first.state, {
        kind: "message_completed",
        messageId: "m1",
        finish: "stop",
        usage: null,
        error: null,
      }).drafts,
    ).toEqual([]);
  });

  it.each([
    ["tool-calls", null, "tool_use"],
    ["length", null, "max_tokens"],
    ["error", null, "error"],
    ["unknown-reason", null, "end_turn"],
    ["stop", { name: "MessageAbortedError", message: "aborted" }, "cancelled"],
    ["stop", { name: "APIError", message: "x" }, "error"],
  ] as const)("finish %s with error %j -> %s", (finish, error, stopReason) => {
    const result = step(emptyNormalizerState, {
      kind: "message_completed",
      messageId: "m1",
      finish,
      usage: null,
      error,
    });
    expect(result.drafts[1]?.payload).toMatchObject({ stopReason });
  });

  it("uses step_finished's reason and tokens when the message carries none, and null usage without a context window", () => {
    const stepped = step(emptyNormalizerState, {
      kind: "step_finished",
      messageId: "m1",
      reason: "length",
      usage: plainUsage(1, 1),
    });
    const done = step(
      stepped.state,
      { kind: "message_completed", messageId: "m1", finish: null, usage: null, error: null },
      context({ contextWindow: null }),
    );
    expect(done.drafts[0]?.payload).toMatchObject({ stopReason: "max_tokens", usage: null });
  });
});

describe("token usage", () => {
  // The recorded session's second call: almost all of its input came from the cache.
  const cached = { input: 2, output: 253, reasoning: 0, cacheRead: 9_402, cacheWrite: 457 };
  const split = {
    usedTokens: 10_114,
    maxTokens: 200_000,
    inputTokens: 2,
    outputTokens: 253,
    cachedInputTokens: 9_402,
    cacheWriteTokens: 457,
    reasoningTokens: 0,
  };
  type Completed = Extract<RuntimeEvent, { kind: "message_completed" }>;
  const complete = (usage: Completed["usage"]): Completed => ({
    kind: "message_completed",
    messageId: "m1",
    finish: "stop",
    usage,
    error: null,
  });
  const usageIn = (result: Advance): unknown => {
    const made = result.drafts.find((each) => each.type === "message.completed");
    return (made?.payload as { usage?: unknown } | undefined)?.usage;
  };

  it("counts the cache read and written, and the output, as the conversation's size", () => {
    expect(usageIn(step(emptyNormalizerState, complete(cached)))).toEqual(split);
  });

  it("counts reasoning in, and never reports a size past the window as the window", () => {
    const result = step(
      emptyNormalizerState,
      complete({ ...cached, reasoning: 47 }),
      context({ contextWindow: 10_000 }),
    );
    expect(usageIn(result)).toMatchObject({
      usedTokens: 10_161,
      maxTokens: 10_161,
      reasoningTokens: 47,
    });
  });

  it("takes the size from the last step and the spend from the message when a message spans steps", () => {
    const stepped = step(emptyNormalizerState, {
      kind: "step_finished",
      messageId: "m1",
      reason: "stop",
      usage: cached,
    });
    const whole = { input: 4, output: 322, reasoning: 18, cacheRead: 9_402, cacheWrite: 9_859 };
    expect(usageIn(step(stepped.state, complete(whole)))).toEqual({
      ...split,
      spent: {
        inputTokens: 4,
        outputTokens: 322,
        cachedInputTokens: 9_402,
        cacheWriteTokens: 9_859,
        reasoningTokens: 18,
      },
    });
  });

  it("takes an all-zero report, as on a message aborted before its call answered, as no reading", () => {
    const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    expect(usageIn(step(emptyNormalizerState, complete(zero)))).toBeNull();
    const stepped = step(emptyNormalizerState, {
      kind: "step_finished",
      messageId: "m1",
      reason: "stop",
      usage: zero,
    });
    expect(stepped.state.messages.get("m1")?.lastCall).toBeNull();
    const reported = step(emptyNormalizerState, { kind: "usage_reported", usage: zero });
    expect(reported.state.unclaimed).toBeNull();
    expect(readingOf(null)).toBeNull();
    expect(readingOf({ ...zero, reasoning: 1 })).toEqual({ ...zero, reasoning: 1 });
  });

  it("clamps a count no provider should send to a whole number of tokens", () => {
    const odd = { input: -5, output: 2.7, reasoning: Number.NaN, cacheRead: 1, cacheWrite: 0 };
    expect(usageIn(step(emptyNormalizerState, complete(odd)))).toMatchObject({
      usedTokens: 3,
      inputTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
    });
  });

  describe("the broker's prompt counts", () => {
    const counts = { systemTokens: 6_000, toolsTokens: 3_000, oncueToolsTokens: 800 };
    // Both fit inside the recorded call's 10,114 tokens.
    const other = { systemTokens: 5_000, toolsTokens: 3_000, oncueToolsTokens: 800 };
    const A = "aaaaaaaaaaaaaaaa";
    const B = "bbbbbbbbbbbbbbbb";
    const read = (reading: PromptCountsReading): RuntimeEvent => ({
      kind: "prompt_counts",
      reading,
    });
    const countsFor = (key: string, value = counts): RuntimeEvent =>
      read({ kind: "counts", key, counts: value });
    const statusFor = (key: string, status: "pending" | "unavailable"): RuntimeEvent =>
      read({ kind: "status", key, status });
    let answered = 0;
    // Each answer is a new message, as each call's is.
    const answer = (state: NormalizerState, ctx = context()) =>
      step(state, { ...complete(cached), messageId: `m${++answered}` }, ctx);

    it("rides the next answer's usage, beside the harness's own compaction point", () => {
      const held = step(emptyNormalizerState, countsFor(A));
      expect(held.drafts).toEqual([]);
      const result = answer(held.state, context({ compactsAt: 168_000 }));
      expect(usageIn(result)).toEqual({ ...split, prompt: counts, compactsAtTokens: 168_000 });
    });

    it("is used by one answer only, so the next answer without its own reading carries none", () => {
      const first = answer(step(emptyNormalizerState, countsFor(A)).state);
      expect(usageIn(first)).toMatchObject({ prompt: counts });
      expect(usageIn(answer(first.state))).toEqual(split);
    });

    it("gives a call with no header, such as one without tools, no breakdown rather than the last call's", () => {
      const counted = step(emptyNormalizerState, countsFor(A)).state;
      const noTools = step(counted, read({ kind: "none" })).state;
      expect(usageIn(answer(noTools))).toEqual(split);
    });

    it("says pending or unavailable for a prompt it has no counts for", () => {
      expect(usageIn(answer(step(emptyNormalizerState, statusFor(A, "pending")).state))).toEqual({
        ...split,
        promptStatus: "pending",
      });
      expect(
        usageIn(answer(step(emptyNormalizerState, statusFor(A, "unavailable")).state)),
      ).toEqual({ ...split, promptStatus: "unavailable" });
    });

    it("follows a prompt that changes mid-run, and keeps each prompt's own counts", () => {
      let state = answer(step(emptyNormalizerState, countsFor(A)).state).state;
      // The prompt changes: the broker has not counted B yet.
      const changed = answer(step(state, statusFor(B, "pending")).state);
      expect(usageIn(changed)).toEqual({ ...split, promptStatus: "pending" });
      state = step(changed.state, countsFor(B, other)).state;
      expect(usageIn(answer(state))).toMatchObject({ prompt: other });
    });

    it("keeps two interleaved prompts apart: a later pending for A is A's counts, not B's", () => {
      let state = step(emptyNormalizerState, countsFor(A)).state;
      state = step(state, countsFor(B, other)).state;
      state = step(state, statusFor(A, "pending")).state;
      expect(usageIn(answer(state))).toMatchObject({ prompt: counts });
      state = step(emptyNormalizerState, countsFor(A)).state;
      state = step(state, countsFor(B, other)).state;
      state = step(state, statusFor(B, "unavailable")).state;
      expect(usageIn(answer(state))).toMatchObject({ prompt: other });
    });

    it("forgets the oldest prompt past its limit, and leaves off counts that cannot fit", () => {
      let state = emptyNormalizerState;
      for (let index = 0; index <= PROMPT_MEMORY_LIMIT; index += 1) {
        state = step(state, countsFor(index.toString(16).padStart(16, "0"))).state;
      }
      expect(state.promptMemory?.size).toBe(PROMPT_MEMORY_LIMIT);
      state = step(state, statusFor("0".repeat(16), "pending")).state;
      expect(usageIn(answer(state))).toEqual({ ...split, promptStatus: "pending" });
      const tooBig = step(emptyNormalizerState, countsFor(A, { ...counts, systemTokens: 20_000 }));
      expect(usageIn(answer(tooBig.state))).toEqual(split);
    });
  });

  describe("tokens reported after the message (Codex)", () => {
    const held: Completed = { ...complete(null), usageFollows: true };
    function finished(): Advance {
      const typed = step(emptyNormalizerState, {
        kind: "text_part",
        messageId: "m1",
        partId: "m1",
        text: "Done.",
      });
      return step(typed.state, held);
    }

    it("holds message.completed, but hands the run its text at once", () => {
      const result = finished();
      expect(types(result)).toEqual([]);
      expect(result.signal).toEqual({ kind: "assistant_text", text: "Done." });
      expect(step(result.state, held).drafts).toEqual([]);
      expect(step(result.state, complete(cached)).drafts).toEqual([]);
    });

    it("hands the run no text when the held message has none", () => {
      expect(step(emptyNormalizerState, held).signal).toEqual({ kind: "none" });
    });

    it("completes the held message with the call reported next", () => {
      const result = step(finished().state, { kind: "usage_reported", usage: cached });
      expect(types(result)).toEqual(["message.completed"]);
      expect(usageIn(result)).toEqual(split);
      expect(result.signal).toEqual({ kind: "none" });
      expect(result.state.unclaimed).toBeNull();
    });

    it("gives the calls before the answer to the answer's spend", () => {
      let state = step(emptyNormalizerState, { kind: "usage_reported", usage: cached }).state;
      expect(state.unclaimed?.sum).toEqual(cached);
      state = step(state, { kind: "text_part", messageId: "m1", partId: "m1", text: "x" }).state;
      state = step(state, held).state;
      const result = step(state, { kind: "usage_reported", usage: cached });
      expect(usageIn(result)).toEqual({
        ...split,
        spent: {
          inputTokens: 4,
          outputTokens: 506,
          cachedInputTokens: 18_804,
          cacheWriteTokens: 914,
          reasoningTokens: 0,
        },
      });
    });

    it("leaves calls for a message with no tokens of its own, and not for one with them", () => {
      const reported = step(emptyNormalizerState, { kind: "usage_reported", usage: cached }).state;
      const own = step(reported, complete(plainUsage(1, 1)));
      expect(usageIn(own)).toMatchObject({ usedTokens: 2 });
      expect(own.state.unclaimed).not.toBeNull();
      const none = step(reported, complete(null));
      expect(usageIn(none)).toEqual(split);
      expect(none.state.unclaimed).toBeNull();
    });

    it("releases a held message, without tokens, once another item begins, leaving the report for the next", () => {
      const toolStarts = step(finished().state, {
        kind: "tool_part",
        messageId: "turn_1",
        part: tool({ status: "running", output: null }),
      });
      // The release comes first, so the message completes before the tool's rows.
      expect(types(toolStarts)[0]).toBe("message.completed");
      expect(toolStarts.drafts[0]?.payload).toMatchObject({ messageId: "m1", usage: null });
      expect(toolStarts.state.messages.get("m1")?.completed).toBe(true);
      // The call's report, when it comes, goes to the next message without tokens.
      const reported = step(toolStarts.state, { kind: "usage_reported", usage: cached });
      expect(types(reported)).toEqual([]);
      expect(reported.state.unclaimed?.last).toEqual(cached);
    });

    it("gives a call's report to the second of two messages it wrote, not the first", () => {
      let state = finished().state;
      const second = step(state, { kind: "message_started", messageId: "m2", role: "assistant" });
      expect(
        second.drafts.find((made) => made.type === "message.completed")?.payload,
      ).toMatchObject({ messageId: "m1", usage: null });
      state = step(second.state, {
        kind: "text_part",
        messageId: "m2",
        partId: "m2",
        text: "And more.",
      }).state;
      state = step(state, { ...held, messageId: "m2" }).state;
      const reported = step(state, { kind: "usage_reported", usage: cached });
      expect(reported.drafts[0]?.payload).toMatchObject({ messageId: "m2", usage: split });
    });

    it("keeps holding through the held message's own text and through events that begin nothing", () => {
      const state = finished().state;
      expect(
        step(state, { kind: "text_part", messageId: "m1", partId: "m1", text: "Done." }).drafts,
      ).toEqual([]);
      expect(step(state, { kind: "session_diff", files: [] }).drafts).toEqual([]);
      expect(
        step(state, { kind: "session_diff", files: [] }).state.messages.get("m1")?.awaitingUsage,
      ).toBe(true);
    });

    it("completes a message still held when the turn ends, and not as an error", () => {
      const result = step(finished().state, {
        kind: "session_error",
        name: "MessageAbortedError",
        message: "aborted",
        status: null,
      });
      expect(
        result.drafts.find((made) => made.type === "message.completed")?.payload,
      ).toMatchObject({ stopReason: "end_turn", usage: null });
    });
  });
});

describe("closing the turn", () => {
  /** An assistant message with streamed text and a running bash, as the abort found it. */
  function openTurn(): NormalizerState {
    let state = step(emptyNormalizerState, {
      kind: "message_started",
      messageId: "msg_1",
      role: "assistant",
    }).state;
    state = step(state, {
      kind: "text_delta",
      messageId: "msg_1",
      partId: "p1",
      text: "Running",
    }).state;
    state = step(state, toolEvent({ status: "pending", startedAtMs: null })).state;
    state = step(state, toolEvent({ callId: "t2", status: "running", title: "sleep 90" })).state;
    return state;
  }

  it("session_error fails every open call and completes every open message, cancelled for an abort", () => {
    const result = step(openTurn(), {
      kind: "session_error",
      name: "MessageAbortedError",
      message: "Aborted",
      status: null,
    });
    expect(types(result)).toEqual([
      "tool.requested",
      "tool.started",
      "tool.failed",
      "tool.failed",
      "message.completed",
    ]);
    expect(result.drafts[2]?.payload).toMatchObject({
      toolCallId: "t1",
      errorText: "Aborted",
      category: "runtime_error",
    });
    expect(result.drafts[3]?.payload).toMatchObject({ toolCallId: "t2", errorText: "Aborted" });
    expect(result.drafts[4]?.payload).toMatchObject({
      messageId: "msg_1",
      stopReason: "cancelled",
      parts: [
        { type: "text", text: "Running" },
        { type: "tool_ref", toolCallId: "t1" },
        { type: "tool_ref", toolCallId: "t2" },
      ],
    });
    expect(result.signal).toEqual({
      kind: "error",
      name: "MessageAbortedError",
      message: "Aborted",
    });
    expect([...result.state.tools.values()].every((tracked) => tracked.phase === "settled")).toBe(
      true,
    );
    expect(result.state.messages.get("msg_1")?.completed).toBe(true);
  });

  it("after the close-out, OpenCode's own late terminals emit nothing (the recorded order after an abort)", () => {
    const closed = step(openTurn(), {
      kind: "session_error",
      name: "MessageAbortedError",
      message: "Aborted",
      status: null,
    }).state;
    const idle = step(closed, { kind: "session_idle" });
    expect(idle).toEqual({ state: closed, drafts: [], signal: { kind: "idle" } });
    const late = step(
      closed,
      toolEvent({
        callId: "t2",
        status: "completed",
        output: "(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
        exitCode: null,
      }),
    );
    expect(late.drafts).toEqual([]);
    expect(late.signal).toEqual({ kind: "none" });
    expect(
      step(late.state, {
        kind: "message_completed",
        messageId: "msg_1",
        finish: null,
        usage: null,
        error: { name: "MessageAbortedError", message: "Aborted" },
      }).drafts,
    ).toEqual([]);
  });

  it("session_error that is not an abort completes the open message as an error", () => {
    const result = step(openTurn(), {
      kind: "session_error",
      name: "UnknownError",
      message: "boom",
      status: 500,
    });
    expect(result.drafts.at(-1)?.payload).toMatchObject({ stopReason: "error" });
    expect(result.signal).toEqual({ kind: "error", name: "UnknownError", message: "boom" });
  });

  it("session_idle with an open message and call closes them too: end_turn and a failed call", () => {
    const result = step(openTurn(), { kind: "session_idle" });
    expect(types(result)).toEqual([
      "tool.requested",
      "tool.started",
      "tool.failed",
      "tool.failed",
      "message.completed",
    ]);
    expect(result.drafts[4]?.payload).toMatchObject({ stopReason: "end_turn" });
    expect(result.drafts[2]?.payload).toMatchObject({ category: "runtime_error" });
    expect(result.signal).toEqual({ kind: "idle" });
  });

  it("session_idle with nothing open is the idle signal and no draft", () => {
    expect(step(emptyNormalizerState, { kind: "session_idle" })).toEqual({
      state: emptyNormalizerState,
      drafts: [],
      signal: { kind: "idle" },
    });
  });
});

describe("plans", () => {
  const items = [
    { id: "todo_1", content: "Run tests", status: "completed" as const },
    { id: "todo_2", content: "Write docs", status: "in_progress" as const },
  ];

  it("the first todo list creates the plan at revision 1", () => {
    const result = step(emptyNormalizerState, { kind: "todos", items });
    expect(result.drafts).toEqual([
      {
        type: "plan.created",
        runId: "run_1",
        payload: {
          planId: "id_1",
          revision: 1,
          title: PLAN_TITLE,
          steps: [
            { stepId: "todo_1", title: "Run tests", status: "complete" },
            { stepId: "todo_2", title: "Write docs", status: "active" },
          ],
          activeStepId: "todo_2",
          expectedVerification: [],
        },
      },
    ]);
    expect(result.state.plan).toEqual({ planId: "id_1", revision: 1 });
  });

  it("a later list updates the plan at the next revision", () => {
    const first = step(emptyNormalizerState, { kind: "todos", items });
    const next = step(first.state, {
      kind: "todos",
      items: [
        items[0] as (typeof items)[number],
        { id: "todo_2", content: "Write docs", status: "cancelled" },
      ],
    });
    expect(types(next)).toEqual(["plan.updated", "plan.completed"]);
    expect(next.drafts[0]?.payload).toMatchObject({
      revision: 2,
      changeSummary: null,
      activeStepId: null,
    });
    expect(next.drafts[1]?.payload).toEqual({
      planId: "id_1",
      revision: 2,
      summary: "2 steps finished",
    });
    expect(next.state.plan).toBeNull();
  });

  it("an empty list is nothing", () => {
    expect(step(emptyNormalizerState, { kind: "todos", items: [] }).drafts).toEqual([]);
  });
});

describe("signals and repository events", () => {
  it.each([
    [{ name: "ProviderAuthError", status: null }, "authentication_failed"],
    [{ name: "APIError", status: 401 }, "authentication_failed"],
    [{ name: "APIError", status: 403 }, "authentication_failed"],
    [{ name: "APIError", status: 429 }, "rate_limited"],
  ])("session_error %j is a model_failure signal", (shape, category) => {
    const result = step(emptyNormalizerState, { kind: "session_error", message: "m", ...shape });
    expect(result.signal).toEqual({ kind: "model_failure", failure: { category, message: "m" } });
  });

  it.each([
    {
      name: "UnknownError",
      message:
        "The user rejected permission to use this specific tool call with the following feedback: The user denied this.",
    },
    { name: "PermissionRejectedError", message: "x" },
    { name: "PermissionCorrectedError", message: "x" },
  ])("a denied repeated call (%j) ends the run as the agent stopping, not a failure", (shape) => {
    expect(
      step(emptyNormalizerState, { kind: "session_error", status: null, ...shape }).signal,
    ).toEqual({ kind: "idle" });
  });

  it("any other session_error is the error signal", () => {
    expect(
      step(emptyNormalizerState, {
        kind: "session_error",
        name: "MessageAbortedError",
        message: "aborted",
        status: null,
      }).signal,
    ).toEqual({
      kind: "error",
      name: "MessageAbortedError",
      message: "aborted",
    });
  });

  it("session_diff drafts nothing, whatever OpenCode reports, and asks for the bridge's own diff", () => {
    for (const files of [
      [],
      [{ path: "README.md", status: "modified" as const, additions: 3, deletions: 1, patch: "+x" }],
    ]) {
      expect(step(emptyNormalizerState, { kind: "session_diff", files })).toEqual({
        state: emptyNormalizerState,
        drafts: [],
        signal: { kind: "diff_changed" },
      });
    }
  });

  it("file_edited is one file.changed by the agent", () => {
    expect(step(emptyNormalizerState, { kind: "file_edited", path: "src/a.ts" }).drafts).toEqual([
      {
        type: "file.changed",
        runId: "run_1",
        payload: {
          change: { path: "src/a.ts", status: "modified", additions: 0, deletions: 0 },
          byAgent: true,
        },
      },
    ]);
  });

  it("homeless and server_connected produce nothing", () => {
    for (const event of [
      { kind: "homeless", wireKind: "session.status" },
      { kind: "homeless", wireKind: "server.heartbeat" },
      { kind: "server_connected" },
    ] as const) {
      expect(step(emptyNormalizerState, event)).toEqual({
        state: emptyNormalizerState,
        drafts: [],
        signal: { kind: "none" },
      });
    }
  });
});

describe("unknown kinds", () => {
  it("the first unknown kind creates the synthetic debug tool once, then every one is a tool.output line", () => {
    const first = step(emptyNormalizerState, {
      kind: "unknown",
      wireKind: "mystery.kind",
      raw: "{}",
    });
    expect(first.drafts).toEqual([
      {
        type: "tool.requested",
        runId: "run_1",
        payload: {
          toolCallId: "id_1",
          category: "other",
          title: DEBUG_TOOL_TITLE,
          runtimeName: "opencode",
          input: {},
          inputComplete: true,
          approvalId: null,
        },
      },
      {
        type: "tool.output",
        runId: "run_1",
        payload: {
          toolCallId: "id_1",
          chunkIndex: 0,
          stream: "terminal",
          text: "mystery.kind {}",
          droppedBytes: 0,
        },
      },
    ]);
    const second = step(first.state, { kind: "unknown", wireKind: "other.kind", raw: "1" });
    expect(types(second)).toEqual(["tool.output"]);
    expect(second.drafts[0]?.payload).toMatchObject({ toolCallId: "id_1", chunkIndex: 1 });
  });
});

describe("EVENT_TABLE", () => {
  it("has a row for every RuntimeEvent kind", () => {
    const kinds: RuntimeEvent["kind"][] = [
      "server_connected",
      "message_started",
      "text_delta",
      "text_part",
      "step_finished",
      "message_completed",
      "tool_part",
      "todos",
      "session_idle",
      "session_error",
      "session_diff",
      "file_edited",
      "permission_asked",
      "session_created",
      "question_asked",
      "permission_replied",
      "question_settled",
      "reasoning",
      "usage_reported",
      "prompt_counts",
      "homeless",
      "unknown",
    ];
    expect(Object.keys(EVENT_TABLE).sort()).toEqual([...kinds].sort());
  });
});

/** One line of a recording: an OpenCode event, or a marker the recorder wrote between phases. */
type FixtureLine =
  | { readonly at: string; readonly event: { readonly type: string } & Record<string, unknown> }
  | { readonly at: string; readonly marker: { readonly phase: string; readonly note: string } };

function readFixture(relative: string): readonly FixtureLine[] {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

interface Emitted {
  /** 1-based line in the fixture the draft came from. */
  readonly line: number;
  readonly draft: Draft;
}

interface Replayed {
  readonly drafts: readonly Emitted[];
  /** Every signal but `diff_changed`, which the recording sends many times and the lifecycle ignores. */
  readonly signals: readonly RunSignal[];
  readonly diffAsks: number;
  readonly unknownKinds: readonly string[];
  readonly state: NormalizerState;
}

/** Wire-parse and normalise every event line through one normalizer, in order. */
function replay(
  lines: readonly (FixtureLine & { readonly n: number })[],
  ctx = context(),
): Replayed {
  let state = emptyNormalizerState;
  const drafts: Emitted[] = [];
  const signals: RunSignal[] = [];
  const unknownKinds: string[] = [];
  let diffAsks = 0;
  for (const line of lines) {
    if (!("event" in line)) {
      continue;
    }
    const event = parseServerEvent(line.event);
    if (event.kind === "unknown") {
      unknownKinds.push(event.wireKind);
    }
    const result = advance(state, event, ctx);
    state = result.state;
    drafts.push(...result.drafts.map((draft) => ({ line: line.n, draft })));
    if (result.signal.kind === "diff_changed") {
      diffAsks += 1;
    } else if (result.signal.kind !== "none") {
      signals.push(result.signal);
    }
  }
  return { drafts, signals, diffAsks, unknownKinds, state };
}

const draftTypes = (replayed: Replayed): string[] => replayed.drafts.map((e) => e.draft.type);
const ofType = (replayed: Replayed, type: string): Draft[] =>
  replayed.drafts.filter((e) => e.draft.type === type).map((e) => e.draft);
const messageText = (draft: Draft): string =>
  payload<{ parts: readonly { type: string; text?: string }[] }>(draft)
    .parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("\n");

/**
 * The invariants every replay must hold, whatever the phase did: one
 * `message.started` per message and one `message.completed` after it, every
 * delta between the two; one `tool.requested` first, one `tool.started`, and
 * exactly one terminal per call, in that order; drafts in fixture order.
 */
function expectWellFormed(replayed: Replayed): void {
  expectValid(replayed.drafts.map((e) => e.draft));
  for (let i = 1; i < replayed.drafts.length; i += 1) {
    expect((replayed.drafts[i] as Emitted).line).toBeGreaterThanOrEqual(
      (replayed.drafts[i - 1] as Emitted).line,
    );
  }
  const started = new Map<string, number>();
  const completed = new Map<string, number>();
  const toolPhases = new Map<string, string[]>();
  replayed.drafts.forEach(({ draft }, index) => {
    const p = draft.payload as { messageId?: string; toolCallId?: string };
    switch (draft.type) {
      case "message.started":
        expect(started.has(p.messageId as string), `${p.messageId} started twice`).toBe(false);
        started.set(p.messageId as string, index);
        break;
      case "message.delta":
        expect(started.has(p.messageId as string)).toBe(true);
        expect(completed.has(p.messageId as string), `delta after completed`).toBe(false);
        break;
      case "message.completed":
        expect(started.has(p.messageId as string), `${p.messageId} completed unstarted`).toBe(true);
        expect(completed.has(p.messageId as string), `${p.messageId} completed twice`).toBe(false);
        completed.set(p.messageId as string, index);
        break;
      case "tool.requested":
      case "tool.started":
      case "tool.completed":
      case "tool.failed":
      case "tool.output": {
        const phases = toolPhases.get(p.toolCallId as string) ?? [];
        phases.push(draft.type);
        toolPhases.set(p.toolCallId as string, phases);
        break;
      }
      default:
        break;
    }
  });
  for (const [messageId, at] of started) {
    expect(completed.get(messageId), `${messageId} never completed`).toBeGreaterThan(at);
  }
  for (const [callId, phases] of toolPhases) {
    if (phases.includes("tool.output")) {
      // The debug call: never terminal, by design.
      continue;
    }
    expect(phases[0], callId).toBe("tool.requested");
    const startedAt = phases.indexOf("tool.started");
    expect(startedAt, `${callId} never started`).toBeGreaterThan(0);
    expect(phases.filter((phase) => phase === "tool.started")).toHaveLength(1);
    const terminals = phases.filter(
      (phase) => phase === "tool.completed" || phase === "tool.failed",
    );
    expect(terminals, `${callId} terminals`).toHaveLength(1);
    expect(phases.at(-1)).toBe(terminals[0]);
    // Once started, a call is never requested again.
    expect(phases.slice(startedAt + 1).includes("tool.requested"), callId).toBe(false);
  }
}

describe("the recorded OpenCode 1.18.30 session", () => {
  const RECORDING = "../fixtures/opencode-session-recorded.jsonl";
  const numbered = readFixture(RECORDING).map((line, index) => ({ ...line, n: index + 1 }));

  /** The lines between one phase's first marker and the next phase's first marker. */
  function phase(name: string): (FixtureLine & { readonly n: number })[] {
    const names = numbered.map((line) => ("marker" in line ? line.marker.phase : null));
    let current: string | null = null;
    const lines: (FixtureLine & { readonly n: number })[] = [];
    numbered.forEach((line, index) => {
      const marker = names[index];
      if (marker !== null && marker !== undefined) {
        current = marker;
      }
      if (current === name) {
        lines.push(line);
      }
    });
    return lines;
  }

  const PHASES = ["task", "steer", "cancel", "task-denied", "question-denied", "environment"];

  it("marks the six phases the recorder promised", () => {
    const seen = [
      ...new Set(numbered.flatMap((line) => ("marker" in line ? [line.marker.phase] : []))),
    ];
    expect(seen).toEqual(["setup", ...PHASES, "done"]);
    for (const name of PHASES) {
      expect(
        phase(name).some((line) => "event" in line),
        name,
      ).toBe(true);
    }
  });

  it("sizes the conversation as OpenCode's own total for each call, cache included", () => {
    const totals = numbered.flatMap((line) => {
      if (!("event" in line) || line.event.type !== "message.part.updated") {
        return [];
      }
      const part = (
        line.event.properties as { part: { type: string; tokens?: { total?: number } } }
      ).part;
      return part.type === "step-finish" ? [part.tokens?.total] : [];
    });
    const used = ofType(
      replay(numbered, context({ contextWindow: 1_000_000 })),
      "message.completed",
    )
      .map((made) => payload<{ usage: { usedTokens: number } | null }>(made).usage?.usedTokens)
      .filter((value) => value !== undefined && value > 0);
    expect(totals.length).toBeGreaterThan(0);
    expect(used).toEqual(totals);
  });

  it("every wire kind present is mapped or on the homeless list: zero unknown kinds", () => {
    const whole = replay(numbered);
    expect(whole.unknownKinds).toEqual([]);
    const wireKinds = [
      ...new Set(numbered.flatMap((line) => ("event" in line ? [line.event.type] : []))),
    ].sort();
    // The table from the recording. A new kind in a future recording lands
    // here AND in `unknownKinds` above, so both lines fail together.
    expect(wireKinds).toEqual([
      "catalog.updated",
      "file.edited",
      "file.watcher.updated",
      "integration.updated",
      "message.part.delta",
      "message.part.updated",
      "message.updated",
      "plugin.added",
      "reference.updated",
      "server.connected",
      "server.heartbeat",
      "session.created",
      "session.diff",
      "session.error",
      "session.idle",
      "session.status",
      "session.updated",
    ]);
    for (const kind of wireKinds) {
      const mapped = [
        "file.edited",
        "message.part.delta",
        "message.part.updated",
        "message.updated",
        "server.connected",
        "session.created",
        "session.diff",
        "session.error",
        "session.idle",
      ].includes(kind);
      expect(mapped || isHomeless(kind), kind).toBe(true);
    }
    expect(HOMELESS_KINDS).toContain("server.heartbeat");
    expect(HOMELESS_KINDS).not.toContain("message.part.delta");
  });

  it.each(PHASES)(
    "%s: every draft validates, in fixture order, and every start gets its end",
    (name) => {
      expectWellFormed(replay(phase(name)));
    },
  );

  it("no draft carries a model key, a GitHub token, or a bearer header", () => {
    const text = JSON.stringify(replay(numbered).drafts.map((e) => e.draft));
    for (const needle of ["sk-ant", "ghp_", "Bearer "]) {
      expect(text).not.toContain(needle);
    }
    // The environment phase printed `env | sort` verbatim into a tool result
    // and a message; the check above covered that output too.
    const environment = replay(phase("environment"));
    const output = payload<{ result: { value: { output: string } } }>(
      ofType(environment, "tool.completed")[0],
    ).result.value.output;
    expect(output).toContain("HOME=/home/oncue-agent");
  });

  it("task: one assistant message per model step, each started once and completed once, the edit's tool triple, the README's file.changed, and the streamed text", () => {
    const task = replay(phase("task"));
    // Four `message.updated` (role assistant) ids: OpenCode opens one message
    // per model step (a tool-calls step, two read steps, the edit, the
    // summary), all parented to the one user message. The user's own
    // `message.updated` and its text part produce nothing.
    const started = ofType(task, "message.started").map((d) => payload<{ messageId: string }>(d));
    expect(started).toHaveLength(4);
    expect(new Set(started.map((p) => p.messageId)).size).toBe(4);
    expect(started.every((p) => p.messageId.startsWith("msg_"))).toBe(true);
    const completed = ofType(task, "message.completed");
    expect(completed).toHaveLength(4);
    expect(completed.map((d) => payload<{ stopReason: string }>(d).stopReason)).toEqual([
      "tool_use",
      "tool_use",
      "tool_use",
      "end_turn",
    ]);
    expect(messageText(completed[3] as Draft)).toContain('Added a "Testing" section');
    expect(messageText(completed[2] as Draft)).toBe(
      'I\'ll add a "Testing" section describing the `npm test` command.',
    );

    // The text streamed as `message.part.delta`: 22 deltas in the phase, 2 of
    // them for (empty) reasoning parts that are dropped.
    expect(ofType(task, "message.delta")).toHaveLength(20);
    expect(
      ofType(task, "message.delta")
        .filter((d) => payload<{ messageId: string }>(d).messageId === started[2]?.messageId)
        .map((d) => payload<{ part: { text: string } }>(d).part.text)
        .join(""),
    ).toBe('I\'ll add a "Testing" section describing the `npm test` command.');

    const requested = ofType(task, "tool.requested").map((d) =>
      payload<{ toolCallId: string; category: string; runtimeName: string; title: string }>(d),
    );
    const edit = requested.find((p) => p.runtimeName === "edit");
    expect(edit).toMatchObject({ category: "file_write", title: "edit" });
    const editId = edit?.toolCallId as string;
    expect(
      task.drafts
        .filter((e) => (e.draft.payload as { toolCallId?: string }).toolCallId === editId)
        .map((e) => e.draft.type),
    ).toEqual(["tool.requested", "tool.requested", "tool.started", "tool.completed"]);
    expect(
      requested
        .filter((p) => p.toolCallId !== editId)
        .map((p) => p.runtimeName)
        .sort(),
    ).toEqual(["bash", "bash", "bash", "bash", "read", "read", "read", "read"]);
    expect(ofType(task, "tool.completed")).toHaveLength(5);
    expect(ofType(task, "tool.failed")).toEqual([]);

    expect(ofType(task, "file.changed").map((d) => d.payload)).toEqual([
      {
        change: {
          path: "/private/workspace/README.md",
          status: "modified",
          additions: 0,
          deletions: 0,
        },
        byAgent: true,
      },
    ]);
    // OpenCode's `session.diff` was empty on every one of its sends even
    // though `git status` showed README.md modified. That is why each send
    // only asks for the bridge's own diff and never becomes `diff.updated`.
    expect(ofType(task, "diff.updated")).toEqual([]);
    expect(task.diffAsks).toBeGreaterThan(0);
    expect(ofType(task, "plan.created")).toEqual([]);

    // Five tools settle (bash; read, read, bash; edit), then the two messages
    // that carried text report it; the first two messages had tools only.
    expect(task.signals.map((s) => s.kind)).toEqual([
      "tool_settled",
      "tool_settled",
      "tool_settled",
      "tool_settled",
      "tool_settled",
      "assistant_text",
      "assistant_text",
      "idle",
    ]);
    expect(draftTypes(task).filter((t) => t !== "message.delta" && !t.startsWith("tool."))).toEqual(
      [
        "message.started",
        "message.completed",
        "message.started",
        "message.completed",
        "message.started",
        "file.changed",
        "message.completed",
        "message.started",
        "message.completed",
      ],
    );
  });

  it("steer: the bash completes, the second prompt is queued into the same turn, and the steering text lands in the last message", () => {
    const steer = replay(phase("steer"));
    const requested = ofType(steer, "tool.requested").map((d) =>
      payload<{ toolCallId: string; input: { command?: string } }>(d),
    );
    const sleep = requested.find((p) => p.input.command === "sleep 20");
    expect(sleep).toBeDefined();
    expect(
      ofType(steer, "tool.completed").map((d) => payload<{ toolCallId: string }>(d).toolCallId),
    ).toContain(sleep?.toolCallId);
    expect(ofType(steer, "tool.failed")).toEqual([]);

    // `prompt_async` on a busy session: OpenCode announced the second user
    // message at once (line 166, nothing emitted for it), let the running
    // step finish, and parented the next assistant messages to the steering
    // prompt. One `session.idle` closed both prompts as one turn.
    expect(steer.signals.filter((s) => s.kind === "idle")).toHaveLength(1);
    const completed = ofType(steer, "message.completed");
    expect(ofType(steer, "message.started")).toHaveLength(3);
    expect(completed).toHaveLength(3);
    const last = messageText(completed[2] as Draft);
    expect(last).toContain("main");
    expect(last.toLowerCase()).toContain("lint");
  });

  it("cancel: the aborted bash ends as tool.failed and the message as cancelled at session.error, and everything after is silent", () => {
    const cancel = replay(phase("cancel"));
    const failed = ofType(cancel, "tool.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      errorText: "Aborted",
      category: "runtime_error",
      exitCode: null,
    });
    expect(ofType(cancel, "tool.completed")).toEqual([]);
    const completed = ofType(cancel, "message.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ stopReason: "cancelled" });

    // What the reducer needs: `error` named MessageAbortedError (it stays
    // silent while winding down after its own `run.cancelled`), then idle.
    // OpenCode sent idle twice, once before and once after it completed the
    // aborted message; the second is a no-op for a run already finished.
    expect(cancel.signals).toEqual([
      { kind: "error", name: "MessageAbortedError", message: "Aborted" },
      { kind: "idle" },
      { kind: "idle" },
    ]);
    // The recorded order: session.error (line 236), idle (238), the bash
    // `completed` with exit null (240), the message completed with the abort
    // (241), idle (243). Nothing after 236 emits a draft.
    const errorLine = phase("cancel").find(
      (line) => "event" in line && line.event.type === "session.error",
    )?.n as number;
    expect(cancel.drafts.filter((e) => e.line > errorLine)).toEqual([]);
    expect(cancel.drafts.filter((e) => e.line === errorLine).map((e) => e.draft.type)).toEqual([
      "tool.failed",
      "message.completed",
    ]);
  });

  it.each([
    ["task-denied", "task", "Task tool"],
    ["question-denied", "question", "question"],
  ])(
    "%s: the %s tool was withheld from the model rather than denied, so no tool part and no tool.failed exists; the model says the tool is unavailable",
    (name, toolId, mention) => {
      // With `task` and `question` denied, OpenCode 1.18.30 removes the tools
      // from the model's toolset, so the recording holds no denied call; the
      // hand-written sample below covers `denied_by_policy`.
      const denied = replay(phase(name));
      expect(
        ofType(denied, "tool.requested").map(
          (d) => payload<{ runtimeName: string }>(d).runtimeName,
        ),
      ).not.toContain(toolId);
      expect(ofType(denied, "tool.failed")).toEqual([]);
      const completed = ofType(denied, "message.completed");
      expect(completed.length).toBeGreaterThan(0);
      const text = completed.map(messageText).join("\n");
      expect(text).toContain(mention);
      expect(text).toMatch(/don't have|not available|unavailable/i);
      expect(denied.signals.at(-1)).toEqual({ kind: "idle" });
    },
  );

  it("environment: the bash ran and the model repeated its output, and the turn ended idle", () => {
    const environment = replay(phase("environment"));
    expect(ofType(environment, "tool.completed")).toHaveLength(1);
    expect(ofType(environment, "message.completed")).toHaveLength(2);
    expect(messageText(ofType(environment, "message.completed")[1] as Draft)).toContain("AGENT=1");
    expect(environment.signals.at(-1)).toEqual({ kind: "idle" });
  });

  it("the whole recording through one normalizer leaves no open message or call", () => {
    const whole = replay(numbered);
    expectWellFormed(whole);
    expect(
      [...whole.state.messages.values()].filter((m) => m.role === "assistant" && !m.completed),
    ).toEqual([]);
    expect([...whole.state.tools.values()].filter((t) => t.phase !== "settled")).toEqual([]);
    // No `todo.updated` fired for this task: no plan events at all.
    expect(draftTypes(whole).filter((t) => t.startsWith("plan."))).toEqual([]);
  });
});

describe("the hand-written sample recording", () => {
  const lines = readFixture("../fixtures/samples/opencode-session-sample.jsonl").map(
    (line, index) => ({ ...line, n: index + 1 }),
  );

  it("normalises end to end into a timeline whose every draft the protocol accepts, and covers what the recording could not", () => {
    const replayed = replay(lines);
    expectWellFormed(replayed);
    expect(draftTypes(replayed)).toEqual([
      "message.started",
      "message.delta",
      "message.delta",
      "tool.requested",
      "tool.started",
      "tool.completed",
      "plan.created",
      "tool.requested",
      "tool.requested",
      "tool.started",
      "file.changed",
      "tool.completed",
      "tool.requested",
      "tool.started",
      "tool.failed",
      "plan.updated",
      "plan.completed",
      "message.delta",
      "tool.requested",
      "tool.output",
      "message.completed",
    ]);
    expect(replayed.signals.map((s) => s.kind)).toEqual([
      "tool_settled",
      "tool_settled",
      "tool_settled",
      "assistant_text",
      "idle",
    ]);
    expect([...replayed.state.tools.values()].every((t) => t.phase === "settled")).toBe(true);
    expect(ofType(replayed, "tool.failed")[0]?.payload).toMatchObject({
      category: "denied_by_policy",
    });
    expect(replayed.unknownKinds).toEqual(["mystery.kind"]);
  });
});
