import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { CODEX_RUNTIME } from "./codex";
import { CODEX_HOMELESS, codexNotificationEvents, parseCodexLine } from "./codex-wire";
import { advance, emptyNormalizerState, type RuntimeEvent } from "./normalize";
import { bridgeConfig, type Draft, type SequenceCursor, stampDraft } from "./protocol";

const CONFIG = bridgeConfig(
  { sessionId: "sess_1", generation: 1, bootstrapCredential: "boot" },
  "wss://oncue.example",
);

function expectValid(drafts: readonly Draft[]): void {
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `evt_${++issued}`, now: () => "2026-09-27T00:00:00.000Z" };
  for (const draft of drafts) {
    const event = stampDraft(CONFIG, cursor, io, draft);
    const parsed = parseEventJson(JSON.stringify(event), "sandbox");
    expect(parsed.ok, `${draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
  }
}

describe("parseCodexLine", () => {
  it("tells responses, errors, notifications, and server requests apart, id 0 included", () => {
    expect(parseCodexLine('{"id":1,"result":{"ok":true}}')).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
    expect(parseCodexLine('{"id":"a","error":{"message":"no"}}')).toEqual({
      kind: "error_response",
      id: "a",
      message: "no",
    });
    expect(parseCodexLine('{"id":2,"error":{}}')).toMatchObject({ message: "error" });
    expect(parseCodexLine('{"method":"turn/started","params":{"threadId":"t"}}')).toEqual({
      kind: "notification",
      method: "turn/started",
      params: { threadId: "t" },
    });
    expect(parseCodexLine('{"id":0,"method":"item/tool/call","params":{}}')).toEqual({
      kind: "server_request",
      id: 0,
      method: "item/tool/call",
      params: {},
    });
    expect(parseCodexLine('{"method":"initialized"}')).toEqual({
      kind: "notification",
      method: "initialized",
      params: {},
    });
  });

  it.each([["not json"], ["[1]"], ['{"id":1.5,"result":1}'], ['{"result":1}']])(
    "calls %s garbled, never throwing",
    (line) => {
      expect(parseCodexLine(line).kind).toBe("garbled");
    },
  );
});

describe("codexNotificationEvents", () => {
  const item = (type: string, fields: Record<string, unknown> = {}) => ({
    item: { type, id: "it_1", ...fields },
    threadId: "th",
    turnId: "tu",
    startedAtMs: 1_000,
    completedAtMs: 2_000,
  });

  it("maps an agent message: started, streamed, then its whole text and its end", () => {
    expect(codexNotificationEvents("item/started", item("agentMessage", { text: "" }))).toEqual([
      { kind: "message_started", messageId: "it_1", role: "assistant" },
    ]);
    expect(
      codexNotificationEvents("item/agentMessage/delta", { itemId: "it_1", delta: "Hi" }),
    ).toEqual([{ kind: "text_delta", messageId: "it_1", partId: "it_1", text: "Hi" }]);
    expect(
      codexNotificationEvents("item/completed", item("agentMessage", { text: "Hi." })),
    ).toEqual([
      { kind: "text_part", messageId: "it_1", partId: "it_1", text: "Hi." },
      {
        kind: "message_completed",
        messageId: "it_1",
        finish: "stop",
        usage: null,
        error: null,
        usageFollows: true,
      },
    ]);
    expect(codexNotificationEvents("item/completed", item("agentMessage"))).toContainEqual(
      expect.objectContaining({ kind: "text_part", text: "" }),
    );
  });

  it("maps a call's token report to usage counting each kind once", () => {
    // OpenAI counts cached and cache-write tokens inside input, and reasoning inside output.
    const last = {
      totalTokens: 12_400,
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      cacheWriteInputTokens: 2_500,
      outputTokens: 400,
      reasoningOutputTokens: 150,
    };
    expect(
      codexNotificationEvents("thread/tokenUsage/updated", {
        tokenUsage: { total: last, last, modelContextWindow: 258_400 },
      }),
    ).toEqual([
      {
        kind: "usage_reported",
        usage: { input: 500, output: 250, reasoning: 150, cacheRead: 9_000, cacheWrite: 2_500 },
      },
    ]);
    expect(
      codexNotificationEvents("thread/tokenUsage/updated", {
        tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } },
      }),
    ).toEqual([
      {
        kind: "usage_reported",
        usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    // Known but sizing nothing: homeless, never a debug row.
    expect(
      codexNotificationEvents("thread/tokenUsage/updated", { tokenUsage: { last: {} } }),
    ).toEqual([{ kind: "homeless", wireKind: "thread/tokenUsage/updated" }]);
    expect(codexNotificationEvents("thread/tokenUsage/updated", {})[0]?.kind).toBe("homeless");
  });

  it("maps a command's start and end, with its output, exit, and times", () => {
    const [started] = codexNotificationEvents(
      "item/started",
      item("commandExecution", { command: "ls", cwd: "/workspace", status: "inProgress" }),
    );
    expect(started).toEqual({
      kind: "tool_part",
      messageId: "tu",
      part: {
        callId: "it_1",
        status: "running",
        startedAtMs: 1_000,
        endedAtMs: null,
        tool: "exec_command",
        title: "ls",
        input: { command: "ls", cwd: "/workspace" },
        output: null,
        error: null,
        exitCode: null,
      },
    });
    const [done] = codexNotificationEvents(
      "item/completed",
      item("commandExecution", {
        command: "ls",
        status: "failed",
        aggregatedOutput: "no",
        exitCode: 2,
      }),
    );
    expect(done).toMatchObject({
      part: {
        status: "error",
        output: "no",
        exitCode: 2,
        error: "command failed",
        endedAtMs: 2_000,
      },
    });
    const [quiet] = codexNotificationEvents(
      "item/completed",
      item("commandExecution", { status: "completed" }),
    );
    expect(quiet).toMatchObject({
      part: { title: "", output: "", input: { command: "", cwd: "" } },
    });
  });

  it("maps a file change, naming its paths, and a declined one as failed", () => {
    const [change] = codexNotificationEvents(
      "item/completed",
      item("fileChange", {
        status: "declined",
        changes: [{ path: "a.ts", kind: "update", diff: "" }, { kind: "add" }, null],
      }),
    );
    expect(change).toMatchObject({
      part: { tool: "apply_patch", title: "a.ts", input: { paths: ["a.ts"] }, status: "error" },
    });
    const [none] = codexNotificationEvents(
      "item/started",
      item("fileChange", { status: "inProgress" }),
    );
    expect(none).toMatchObject({ part: { input: { paths: [] }, output: null } });
  });

  it("maps MCP, dynamic, web search, and image view calls", () => {
    expect(
      codexNotificationEvents(
        "item/completed",
        item("mcpToolCall", {
          server: "s",
          tool: "t",
          status: "failed",
          error: { message: "boom" },
        }),
      )[0],
    ).toMatchObject({ part: { tool: "mcp__s__t", status: "error", error: "boom" } });
    expect(
      codexNotificationEvents("item/completed", item("mcpToolCall", { status: "failed" }))[0],
    ).toMatchObject({ part: { tool: "mcp__mcp__tool", error: "the tool failed" } });
    expect(
      codexNotificationEvents(
        "item/completed",
        item("mcpToolCall", { status: "completed", result: { a: 1 } }),
      )[0],
    ).toMatchObject({ part: { output: '{"a":1}', error: null } });
    expect(
      codexNotificationEvents(
        "item/completed",
        item("dynamicToolCall", {
          tool: "oncue_git_commit",
          status: "completed",
          success: false,
          contentItems: [{ type: "inputText", text: "Not committed." }, { type: "inputImage" }],
          arguments: { message: "x" },
        }),
      )[0],
    ).toMatchObject({
      part: {
        tool: "oncue_git_commit",
        status: "error",
        error: "Not committed.",
        input: { message: "x" },
      },
    });
    expect(
      codexNotificationEvents("item/completed", item("dynamicToolCall", { status: "failed" }))[0],
    ).toMatchObject({ part: { tool: "tool", error: "the tool failed" } });
    expect(
      codexNotificationEvents("item/started", item("dynamicToolCall", { status: "inProgress" }))[0],
    ).toMatchObject({ part: { status: "running", error: null, output: null } });
    expect(
      codexNotificationEvents(
        "item/completed",
        item("webSearch", { status: "completed", query: "q" }),
      )[0],
    ).toMatchObject({ part: { tool: "web_search", title: "q" } });
    expect(
      codexNotificationEvents("item/completed", item("webSearch", { status: "completed" }))[0],
    ).toMatchObject({ part: { title: "web search" } });
    expect(
      codexNotificationEvents(
        "item/completed",
        item("imageView", { status: "completed", path: "a.png" }),
      )[0],
    ).toMatchObject({ part: { tool: "view_image", title: "a.png" } });
    expect(
      codexNotificationEvents("item/started", item("imageView", { status: "inProgress" }))[0],
    ).toMatchObject({ part: { title: "image" } });
  });

  it("bounds a tool input past the inline limit", () => {
    const [big] = codexNotificationEvents(
      "item/started",
      item("dynamicToolCall", { status: "inProgress", arguments: { body: "x".repeat(40_000) } }),
    );
    expect(big).toMatchObject({ part: { input: { truncated: true } } });
  });

  it("drops reasoning, rows it has no use for, and shows a subagent that appears anyway", () => {
    expect(codexNotificationEvents("item/started", item("reasoning"))).toEqual([
      { kind: "reasoning", messageId: "it_1", partId: "it_1" },
    ]);
    expect(codexNotificationEvents("item/completed", item("userMessage"))).toEqual([
      { kind: "homeless", wireKind: "item/completed/userMessage" },
    ]);
    const [started] = codexNotificationEvents("item/started", item("collabAgentToolCall"));
    expect(started).toMatchObject({
      kind: "tool_part",
      part: { tool: "collabAgentToolCall", status: "running" },
    });
    const [ended] = codexNotificationEvents("item/completed", item("subAgentActivity"));
    expect(ended).toMatchObject({ part: { status: "completed", output: "" } });
  });

  it("maps the plan, the diff, and each way a turn ends", () => {
    expect(
      codexNotificationEvents("turn/plan/updated", {
        plan: [
          { step: "Read", status: "completed" },
          { step: "Fix", status: "inProgress" },
          { step: "Ship", status: "pending" },
          { step: "Odd", status: "weird" },
          null,
        ],
      }),
    ).toEqual([
      {
        kind: "todos",
        items: [
          { id: "step-0", content: "Read", status: "completed" },
          { id: "step-1", content: "Fix", status: "in_progress" },
          { id: "step-2", content: "Ship", status: "pending" },
        ],
      },
    ]);
    expect(codexNotificationEvents("turn/diff/updated", {})).toEqual([
      { kind: "session_diff", files: [] },
    ]);
    expect(codexNotificationEvents("turn/completed", { turn: { status: "completed" } })).toEqual([
      { kind: "session_idle" },
    ]);
    expect(
      codexNotificationEvents("turn/completed", { turn: { status: "interrupted" } })[0],
    ).toMatchObject({
      kind: "session_error",
      name: "MessageAbortedError",
    });
    expect(
      codexNotificationEvents("turn/completed", {
        turn: { status: "failed", error: { message: "quota" } },
      }),
    ).toEqual([
      { kind: "session_error", name: "CodexTurnFailed", message: "quota", status: null },
      { kind: "session_idle" },
    ]);
    expect(
      codexNotificationEvents("turn/completed", { turn: { status: "failed" } })[0],
    ).toMatchObject({
      message: "the turn ended failed",
    });
  });

  it("calls a known method with a bad shape unknown, a listed one homeless, and anything else unknown", () => {
    for (const [method, params] of [
      ["item/started", {}],
      ["item/completed", { item: { type: "commandExecution", id: "x", status: "weird" } }],
      ["item/completed", { item: { type: "brandNew", id: "x" } }],
      ["item/agentMessage/delta", { itemId: 1 }],
      ["turn/plan/updated", {}],
      ["turn/completed", {}],
      ["something/new", { a: 1 }],
    ] as const) {
      expect(codexNotificationEvents(method, params)[0]?.kind, method).toBe("unknown");
    }
    expect(codexNotificationEvents("thread/goal/updated", {})).toEqual([
      { kind: "homeless", wireKind: "thread/goal/updated" },
    ]);
    expect(codexNotificationEvents("warning", {})[0]?.kind).toBe("homeless");
    expect(CODEX_HOMELESS).toContain("error");
  });
});

/** One line of the recording: a JSON-RPC message in either direction, or a marker. */
type RecordedLine =
  | { readonly at: string; readonly dir: "in" | "out"; readonly message: Record<string, unknown> }
  | { readonly at: string; readonly marker: { readonly phase: string; readonly note: string } };

describe("the recorded Codex 0.157.1 session (scripted model)", () => {
  const lines = readFileSync(
    fileURLToPath(new URL("../fixtures/codex-session-recorded.jsonl", import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedLine);

  function eventsOf(phase: string | null): RuntimeEvent[] {
    let current: string | null = null;
    const events: RuntimeEvent[] = [];
    for (const line of lines) {
      if ("marker" in line) {
        current = line.marker.phase;
        continue;
      }
      if ((phase === null || current === phase) && line.dir === "in") {
        const message = parseCodexLine(JSON.stringify(line.message));
        if (message.kind === "notification") {
          events.push(...codexNotificationEvents(message.method, message.params));
        }
      }
    }
    return events;
  }

  const PHASES = ["answer", "edit", "tool", "held", "steer_and_abort", "follow_up"];

  it("marks the phases the recorder promised", () => {
    const seen = [
      ...new Set(lines.flatMap((line) => ("marker" in line ? [line.marker.phase] : []))),
    ];
    expect(seen).toEqual(["setup", ...PHASES]);
  });

  it("maps every method it holds, or lists it as homeless: zero unknown", () => {
    expect(eventsOf(null).filter((event) => event.kind === "unknown")).toEqual([]);
  });

  it.each(PHASES)("%s: ends idle, and every draft the normalizer makes validates", (phase) => {
    const events = eventsOf(phase);
    expect(events.at(-1)).toEqual({ kind: "session_idle" });
    let state = emptyNormalizerState;
    const drafts: Draft[] = [];
    for (const event of events) {
      const next = advance(state, event, {
        nowMs: 10_000,
        newId: () => "id_1",
        runId: "run_1",
        contextWindow: null,
        runtime: CODEX_RUNTIME,
      });
      state = next.state;
      drafts.push(...next.drafts);
    }
    expectValid(drafts);
  });

  it("every agent message completes with the call that wrote it, and every call is counted once", () => {
    const completed: { messageId: string; usage: unknown }[] = [];
    let state = emptyNormalizerState;
    for (const event of eventsOf(null)) {
      const next = advance(state, event, {
        nowMs: 10_000,
        newId: () => "id_1",
        runId: "run_1",
        contextWindow: 258_400,
        runtime: CODEX_RUNTIME,
      });
      state = next.state;
      for (const made of next.drafts) {
        if (made.type === "message.completed") {
          const payload = made.payload as { messageId: string; usage: unknown };
          completed.push({ messageId: payload.messageId, usage: payload.usage });
        }
      }
    }
    // The scripted model reports 10 in and 5 out on every call.
    const oneCall = {
      usedTokens: 15,
      maxTokens: 258_400,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const answers = completed.filter((entry) => entry.messageId.startsWith("msg_stub"));
    expect(answers.length).toBeGreaterThan(0);
    expect(answers[0]).toEqual({ messageId: "msg_stub_1", usage: oneCall });
    // A tool call's own model call is spent by the answer that follows it.
    expect(answers[1]).toEqual({
      messageId: "msg_stub_3",
      usage: {
        ...oneCall,
        spent: {
          inputTokens: 20,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    });
  });

  it("edit: the shell command is one tool row, category shell, that completes", () => {
    const tools = eventsOf("edit").flatMap((event) =>
      event.kind === "tool_part" ? [event.part] : [],
    );
    expect(tools.map((part) => [part.tool, part.status])).toEqual([
      ["exec_command", "running"],
      ["exec_command", "completed"],
    ]);
    expect(CODEX_RUNTIME.toolCategory("exec_command")).toBe("shell");
  });

  it("steer_and_abort: the interrupt reads as OpenCode's abort does", () => {
    const events = eventsOf("steer_and_abort");
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ kind: "session_error", name: "MessageAbortedError" }),
      { kind: "session_idle" },
    ]);
  });
});
