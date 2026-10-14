import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_HOMELESS, createClaudeEventMapper, parseClaudeLine } from "./claude-wire";
import { plainUsage, type RuntimeEvent } from "./normalize";

/** Claude Code's stdout as the Agent SDK's declarations describe it; not a recording (see the `.meta.json`). */
const FIXTURE = readFileSync(
  fileURLToPath(new URL("../fixtures/claude-stream-json-docs-derived.jsonl", import.meta.url)),
  "utf8",
)
  .split("\n")
  .filter((line) => line !== "");

function clock(): () => number {
  let at = 1_000;
  return () => {
    at += 10;
    return at;
  };
}

function mapAll(lines: readonly string[]): RuntimeEvent[] {
  const mapper = createClaudeEventMapper(clock());
  return lines.flatMap((line) => {
    const parsed = parseClaudeLine(line);
    return parsed.kind === "message" ? [...mapper.events(parsed.type, parsed.record)] : [];
  });
}

describe("parseClaudeLine", () => {
  it("tells the control protocol's three shapes from a message", () => {
    expect(
      parseClaudeLine(
        '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool"}}',
      ),
    ).toEqual({ kind: "control_request", requestId: "r1", request: { subtype: "can_use_tool" } });
    expect(
      parseClaudeLine(
        '{"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"version":"2"}}}',
      ),
    ).toEqual({
      kind: "control_response",
      requestId: "r2",
      ok: true,
      response: { version: "2" },
      error: null,
    });
    expect(
      parseClaudeLine(
        '{"type":"control_response","response":{"subtype":"error","request_id":"r3","error":"no"}}',
      ),
    ).toMatchObject({ kind: "control_response", ok: false, error: "no", response: {} });
    expect(
      parseClaudeLine(
        '{"type":"control_response","response":{"subtype":"error","request_id":"r4"}}',
      ),
    ).toMatchObject({ error: "error" });
    expect(parseClaudeLine('{"type":"control_cancel_request","request_id":"r5"}')).toEqual({
      kind: "control_cancel",
      requestId: "r5",
    });
    expect(parseClaudeLine('{"type":"result","subtype":"success"}')).toMatchObject({
      kind: "message",
      type: "result",
    });
  });

  it("calls anything malformed garbled, never throwing", () => {
    for (const line of [
      "not json",
      "[]",
      '{"no":"type"}',
      '{"type":"control_request","request":{}}',
      '{"type":"control_request","request_id":"r"}',
      '{"type":"control_response","response":{}}',
      '{"type":"control_cancel_request"}',
    ]) {
      expect(parseClaudeLine(line).kind).toBe("garbled");
    }
  });
});

describe("the documented session, mapped", () => {
  const events = mapAll(FIXTURE);

  it("streams text by the Messages API's block index, and does not repeat it from the finished message", () => {
    expect(
      events.filter((event) => event.kind === "text_delta" || event.kind === "text_part"),
    ).toEqual([
      { kind: "text_delta", messageId: "msg_01", partId: "msg_01-1", text: "Running " },
      { kind: "text_delta", messageId: "msg_01", partId: "msg_01-1", text: "the tests." },
      { kind: "text_delta", messageId: "msg_03", partId: "msg_03-0", text: "All 3 passed." },
      { kind: "text_delta", messageId: "msg_05", partId: "msg_05-0", text: "Thanks." },
      { kind: "text_delta", messageId: "msg_06", partId: "msg_06-0", text: "Partial" },
    ]);
  });

  it("drops thinking as reasoning", () => {
    expect(events.filter((event) => event.kind === "reasoning")).toEqual([
      { kind: "reasoning", messageId: "msg_01", partId: "msg_01-0" },
      { kind: "reasoning", messageId: "msg_01", partId: "msg_01-0" },
      { kind: "reasoning", messageId: "msg_01", partId: "msg_01-0" },
      { kind: "reasoning", messageId: "msg_01", partId: "msg_01-a0" },
    ]);
  });

  it("makes each tool call a row from its finished input, settled by its result", () => {
    const tools = events.flatMap((event) => (event.kind === "tool_part" ? [event] : []));
    expect(tools.map((event) => [event.messageId, event.part.callId, event.part.status])).toEqual([
      ["msg_01", "toolu_01", "running"],
      ["msg_01", "toolu_01", "completed"],
      ["msg_02", "toolu_02", "running"],
      ["msg_02", "toolu_02", "completed"],
      ["msg_04", "toolu_04", "running"],
      ["msg_04", "toolu_04", "completed"],
      // The subagent line, shown rather than dropped.
      ["toolu_09", "toolu_09", "running"],
    ]);
    expect(tools[1]?.part).toEqual({
      callId: "toolu_01",
      tool: "Bash",
      title: "npm test",
      input: { command: "npm test", description: "Run the tests" },
      status: "completed",
      output: "3 passed",
      error: null,
      exitCode: null,
      startedAtMs: 1_010,
      endedAtMs: 1_020,
    });
  });

  it("makes TodoWrite's list the plan", () => {
    expect(events.filter((event) => event.kind === "todos")).toEqual([
      {
        kind: "todos",
        items: [
          { id: "todo-0", content: "Run the tests", status: "completed" },
          { id: "todo-1", content: "Report", status: "in_progress" },
        ],
      },
    ]);
  });

  it("completes each streamed message with its stop reason and usage", () => {
    const completed = events.flatMap((event) =>
      event.kind === "message_completed" ? [event] : [],
    );
    expect(completed.map((event) => [event.messageId, event.finish, event.usage])).toEqual([
      ["msg_01", "tool_use", plainUsage(10, 20)],
      ["msg_02", "tool_use", plainUsage(10, 8)],
      ["msg_03", "end_turn", plainUsage(10, 4)],
      ["msg_04", "tool_use", plainUsage(10, 6)],
      ["msg_05", "end_turn", plainUsage(10, 2)],
    ]);
  });

  it("keeps the Messages API's cache counters apart from its input", () => {
    const stream = (event: object) => JSON.stringify({ type: "stream_event", event });
    const usage = {
      input_tokens: 3,
      output_tokens: 1,
      cache_creation_input_tokens: 450,
      cache_read_input_tokens: 9_400,
    };
    const mapped = mapAll([
      stream({ type: "message_start", message: { id: "msg_c", role: "assistant", usage } }),
      stream({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 40 },
      }),
      stream({ type: "message_stop" }),
    ]);
    expect(mapped.find((event) => event.kind === "message_completed")).toMatchObject({
      usage: { input: 3, output: 40, reasoning: 0, cacheRead: 9_400, cacheWrite: 450 },
    });
  });

  it("ends a clean turn idle, an interrupted one as OpenCode's abort, and a failed one with its error", () => {
    expect(
      events.filter((event) => event.kind === "session_idle" || event.kind === "session_error"),
    ).toEqual([
      { kind: "session_idle" },
      { kind: "session_idle" },
      {
        kind: "session_error",
        name: "MessageAbortedError",
        message: "the turn was interrupted",
        status: null,
      },
      { kind: "session_idle" },
      {
        kind: "session_error",
        name: "ClaudeTurnFailed",
        message: "API Error: 401 authentication_error",
        status: 401,
      },
      { kind: "session_idle" },
    ]);
  });

  it("keeps only the never-seen system line for the debug channel", () => {
    expect(events.filter((event) => event.kind === "unknown")).toEqual([
      expect.objectContaining({ kind: "unknown", wireKind: "system/brand_new" }),
    ]);
  });
});

describe("createClaudeEventMapper, edge rows", () => {
  const mapper = () => createClaudeEventMapper(clock());

  it("lists every homeless type as homeless", () => {
    const m = mapper();
    for (const key of CLAUDE_HOMELESS) {
      const [type, subtype] = key.split("/");
      const record = subtype === undefined ? { type } : { type, subtype };
      expect(m.events(type as string, record)).toEqual([{ kind: "homeless", wireKind: key }]);
    }
  });

  it("calls a known type with a shape it cannot read unknown, naming the type", () => {
    const m = mapper();
    expect(m.events("stream_event", {})[0]).toMatchObject({
      kind: "unknown",
      wireKind: "stream_event",
    });
    expect(
      m.events("stream_event", { event: { type: "message_start", message: {} } })[0],
    ).toMatchObject({
      kind: "unknown",
    });
    expect(m.events("stream_event", { event: { type: "message_stop" } })[0]).toMatchObject({
      kind: "unknown",
    });
    expect(m.events("stream_event", { event: { type: "message_delta" } })[0]).toMatchObject({
      kind: "unknown",
    });
    expect(
      m.events("stream_event", { event: { type: "content_block_delta", index: 0 } })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(m.events("stream_event", { event: { type: "future_event" } })[0]).toMatchObject({
      kind: "unknown",
    });
    expect(m.events("assistant", { message: { id: "m" } })[0]).toMatchObject({ kind: "unknown" });
    expect(m.events("user", {})[0]).toMatchObject({ kind: "unknown" });
    expect(m.events("system", {})[0]).toMatchObject({ kind: "unknown", wireKind: "system/" });
    expect(m.events("keep_alive", { type: "keep_alive" })[0]).toMatchObject({
      kind: "unknown",
      wireKind: "keep_alive",
    });
  });

  it("reads a text delta with no text, or a block with no index, as unknown, and a ping as homeless", () => {
    const m = mapper();
    m.events("stream_event", { event: { type: "message_start", message: { id: "m1" } } });
    expect(
      m.events("stream_event", {
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
      })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(
      m.events("stream_event", { event: { type: "content_block_start", content_block: {} } })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(
      m.events("stream_event", {
        event: { type: "content_block_start", index: 1, content_block: {} },
      }),
    ).toEqual([{ kind: "homeless", wireKind: "stream_event/content_block_start/none" }]);
    expect(m.events("stream_event", { event: { type: "ping" } })).toEqual([
      { kind: "homeless", wireKind: "stream_event/ping" },
    ]);
    // No usage on the start, and none on the delta: no usage on the completion.
    m.events("stream_event", { event: { type: "message_delta", delta: {} } });
    expect(m.events("stream_event", { event: { type: "message_stop" } })).toEqual([
      { kind: "message_completed", messageId: "m1", finish: null, usage: null, error: null },
    ]);
  });

  it("starts a message it never saw stream, and takes its text whole", () => {
    const m = mapper();
    expect(
      m.events("assistant", {
        message: {
          id: "m9",
          content: [
            { type: "text", text: "Whole." },
            { type: "tool_use", id: 7, name: "Bash" },
            { type: "image" },
          ],
        },
      }),
    ).toEqual([
      { kind: "message_started", messageId: "m9", role: "assistant" },
      { kind: "text_part", messageId: "m9", partId: "m9-a0", text: "Whole." },
    ]);
    expect(m.events("assistant", { message: { id: "m9", content: [] } })).toEqual([
      { kind: "homeless", wireKind: "assistant/empty" },
    ]);
  });

  it("settles a failed call with its own text or a plain one, and ignores a result for no known call", () => {
    const m = mapper();
    m.events("assistant", {
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } },
          { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "TODO" } },
        ],
      },
    });
    const settled = m.events("user", {
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true },
          { type: "tool_result", tool_use_id: "t2", content: { odd: true }, is_error: true },
          { type: "tool_result", tool_use_id: "gone", content: "x" },
          { type: "text", text: "not a result" },
        ],
      },
    });
    expect(settled.map((event) => (event.kind === "tool_part" ? event.part : null))).toEqual([
      expect.objectContaining({
        callId: "t1",
        title: "src/a.ts",
        status: "error",
        error: "no such file",
      }),
      expect.objectContaining({
        callId: "t2",
        title: "TODO",
        status: "error",
        error: "the tool failed",
      }),
    ]);
    expect(m.events("user", { message: { content: [{ type: "text" }] } })).toEqual([
      { kind: "homeless", wireKind: "user/other" },
    ]);
  });

  it("titles a fetch by its URL and a tool with nothing to show by its name, and bounds a large input", () => {
    const m = mapper();
    const [, fetch] = m.events("assistant", {
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://x" } }],
      },
    });
    expect(fetch).toMatchObject({ part: { title: "https://x" } });
    const [, bare] = m.events("assistant", {
      message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "LS" }] },
    });
    expect(bare).toMatchObject({ part: { title: "LS", input: {} } });
    const [, big] = m.events("assistant", {
      message: {
        id: "m3",
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "Write",
            input: { file_path: "a", content: "x".repeat(100_000) },
          },
        ],
      },
    });
    expect(big).toMatchObject({ part: { input: { truncated: true } } });
  });

  it("reads a TodoWrite with no list as no plan, and drops an item it cannot read", () => {
    const m = mapper();
    const events = m.events("assistant", {
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "t1", name: "TodoWrite", input: {} },
          {
            type: "tool_use",
            id: "t2",
            name: "TodoWrite",
            input: { todos: [{ content: "a", status: "blocked" }, { status: "pending" }] },
          },
        ],
      },
    });
    expect(events.filter((event) => event.kind === "todos")).toEqual([
      { kind: "todos", items: [] },
    ]);
  });

  it("ends a turn that failed with no words as the result's own subtype", () => {
    const m = mapper();
    expect(m.events("result", { subtype: "error_max_turns", errors: ["too many", 3] })[0]).toEqual({
      kind: "session_error",
      name: "ClaudeTurnFailed",
      message: "too many",
      status: null,
    });
    expect(m.events("result", { subtype: "error_max_budget_usd" })[0]).toMatchObject({
      message: "the turn ended error_max_budget_usd",
    });
    expect(m.events("result", {})[0]).toMatchObject({ message: "the turn ended without a result" });
  });
});
