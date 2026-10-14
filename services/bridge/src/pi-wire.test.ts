import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plainUsage, type RuntimeEvent } from "./normalize";
import { createPiEventMapper, PI_HOMELESS, parsePiLine } from "./pi-wire";

/** Pi's stdout as its 0.87.1 documentation describes it; not a recording (see the `.meta.json`). */
const FIXTURE = readFileSync(
  fileURLToPath(new URL("../fixtures/pi-rpc-docs-derived.jsonl", import.meta.url)),
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

/** Every session event of a stream, mapped, in order. */
function mapAll(lines: readonly string[]): RuntimeEvent[] {
  const mapper = createPiEventMapper(clock());
  return lines.flatMap((line) => {
    const message = parsePiLine(line);
    return message.kind === "event" ? [...mapper.events(message.type, message.record)] : [];
  });
}

describe("parsePiLine", () => {
  it("tells a response, an extension UI request, and a session event apart", () => {
    expect(
      parsePiLine('{"id":"oncue-1","type":"response","command":"prompt","success":true}'),
    ).toEqual({
      kind: "response",
      id: "oncue-1",
      command: "prompt",
      success: true,
      data: undefined,
      error: null,
    });
    expect(
      parsePiLine(
        '{"type":"response","command":"set_model","success":false,"error":"Model not found"}',
      ),
    ).toMatchObject({ kind: "response", id: null, success: false, error: "Model not found" });
    expect(
      parsePiLine(
        '{"type":"extension_ui_request","id":"u1","method":"confirm","title":"t","message":"m"}',
      ),
    ).toMatchObject({ kind: "ui_request", id: "u1", method: "confirm" });
    expect(parsePiLine('{"type":"agent_settled"}')).toEqual({
      kind: "event",
      type: "agent_settled",
      record: { type: "agent_settled" },
    });
  });

  it("calls anything else garbled, never throwing", () => {
    expect(parsePiLine("not json")).toEqual({ kind: "garbled", raw: "not json" });
    expect(parsePiLine("[1]")).toMatchObject({ kind: "garbled" });
    expect(parsePiLine('{"no":"type"}')).toMatchObject({ kind: "garbled" });
    expect(parsePiLine('{"type":"extension_ui_request","method":"input"}')).toMatchObject({
      kind: "garbled",
    });
    expect((parsePiLine(`x${"y".repeat(5_000)}`) as { raw: string }).raw.length).toBe(2_000);
  });
});

describe("the documented session, mapped", () => {
  const events = mapAll(FIXTURE);

  it("numbers each assistant message and streams its text by content block", () => {
    const texts = events.filter(
      (event) => event.kind === "text_delta" || event.kind === "text_part",
    );
    expect(texts).toEqual([
      { kind: "text_delta", messageId: "pi-m1", partId: "pi-m1-1", text: "Running " },
      { kind: "text_delta", messageId: "pi-m1", partId: "pi-m1-1", text: "the tests." },
      { kind: "text_part", messageId: "pi-m1", partId: "pi-m1-1", text: "Running the tests." },
      { kind: "text_delta", messageId: "pi-m3", partId: "pi-m3-0", text: "Done." },
      { kind: "text_part", messageId: "pi-m3", partId: "pi-m3-0", text: "Done." },
      { kind: "text_delta", messageId: "pi-m5", partId: "pi-m5-0", text: "Recovered." },
      { kind: "text_delta", messageId: "pi-m6", partId: "pi-m6-0", text: "Partial" },
    ]);
  });

  it("drops thinking as reasoning, never as text", () => {
    expect(events.filter((event) => event.kind === "reasoning")).toEqual([
      { kind: "reasoning", messageId: "pi-m1", partId: "pi-m1-0" },
      { kind: "reasoning", messageId: "pi-m1", partId: "pi-m1-0" },
      { kind: "reasoning", messageId: "pi-m1", partId: "pi-m1-0" },
    ]);
  });

  it("makes each tool execution one row, running then settled, under the message that asked", () => {
    const tools = events.flatMap((event) => (event.kind === "tool_part" ? [event] : []));
    expect(tools.map((event) => [event.messageId, event.part.callId, event.part.status])).toEqual([
      ["pi-m1", "call_abc123", "running"],
      ["pi-m1", "call_abc123", "completed"],
      ["pi-m2", "call_sec", "running"],
      ["pi-m2", "call_sec", "completed"],
    ]);
    expect(tools[1]?.part).toEqual({
      callId: "call_abc123",
      tool: "bash",
      title: "ls -la",
      input: { command: "ls -la" },
      status: "completed",
      output: "complete output",
      error: null,
      exitCode: null,
      startedAtMs: 1_010,
      endedAtMs: 1_020,
    });
  });

  it("completes each assistant message with its stop reason and usage", () => {
    const completed = events.flatMap((event) =>
      event.kind === "message_completed" ? [event] : [],
    );
    expect(completed.map((event) => [event.messageId, event.finish, event.usage])).toEqual([
      ["pi-m1", "toolUse", plainUsage(100, 20)],
      ["pi-m2", "toolUse", plainUsage(150, 10)],
      ["pi-m3", "stop", plainUsage(200, 5)],
      ["pi-m4", "error", plainUsage(0, 0)],
      ["pi-m5", "stop", plainUsage(10, 2)],
      ["pi-m6", "aborted", plainUsage(0, 0)],
    ]);
    expect(completed[3]?.error).toEqual({ name: "PiTurnFailed", message: "529 overloaded" });
  });

  it("keeps pi-ai's cache counters apart from its input", () => {
    const mapped = mapAll([
      JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: { input: 2, output: 30, cacheRead: 9_400, cacheWrite: 450, totalTokens: 9_882 },
          stopReason: "stop",
        },
      }),
    ]);
    expect(mapped.find((event) => event.kind === "message_completed")).toMatchObject({
      usage: { input: 2, output: 30, reasoning: 0, cacheRead: 9_400, cacheWrite: 450 },
    });
  });

  it("ends a clean run and a recovered one idle, and an aborted one as OpenCode's abort does", () => {
    const ends = events.filter(
      (event) => event.kind === "session_idle" || event.kind === "session_error",
    );
    expect(ends).toEqual([
      { kind: "session_idle" },
      // The retried error is not where the run ended.
      { kind: "session_idle" },
      {
        kind: "session_error",
        name: "MessageAbortedError",
        message: "the turn was interrupted",
        status: null,
      },
      { kind: "session_idle" },
    ]);
  });

  it("keeps an extension's error for the debug channel and drops the known rest as homeless", () => {
    expect(events.filter((event) => event.kind === "unknown")).toEqual([
      expect.objectContaining({ kind: "unknown", wireKind: "extension_error" }),
    ]);
    const homeless = new Set(
      events.flatMap((event) => (event.kind === "homeless" ? [event.wireKind] : [])),
    );
    expect(homeless).toEqual(
      new Set([
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "message_start/user",
        "message_end/user",
        "message_update/text_start",
        "message_update/toolcall_start",
        "message_update/toolcall_delta",
        "message_update/toolcall_end",
        "tool_execution_update",
        "queue_update",
        "auto_retry_start",
        "auto_retry_end",
      ]),
    );
  });
});

describe("createPiEventMapper, edge rows", () => {
  const mapper = () => createPiEventMapper(clock());

  it("lists every homeless type as homeless", () => {
    const m = mapper();
    for (const type of PI_HOMELESS) {
      expect(m.events(type, { type })).toEqual([{ kind: "homeless", wireKind: type }]);
    }
  });

  it("calls a known type with a shape it cannot read unknown, naming the type", () => {
    const m = mapper();
    expect(m.events("message_start", {})[0]).toMatchObject({
      kind: "unknown",
      wireKind: "message_start",
    });
    expect(m.events("message_end", { message: {} })[0]).toMatchObject({ kind: "unknown" });
    expect(m.events("tool_execution_start", { toolName: "bash" })[0]).toMatchObject({
      kind: "unknown",
    });
    expect(m.events("tool_execution_end", { toolCallId: "c" })[0]).toMatchObject({
      kind: "unknown",
    });
    expect(m.events("brand_new_event", { type: "brand_new_event" })[0]).toMatchObject({
      kind: "unknown",
      wireKind: "brand_new_event",
    });
  });

  it("reads no update outside an assistant message, and none with a bad block", () => {
    const m = mapper();
    const update = { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } };
    expect(m.events("message_update", update)[0]).toMatchObject({ kind: "unknown" });
    m.events("message_start", { message: { role: "assistant" } });
    expect(
      m.events("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(
      m.events("message_update", {
        assistantMessageEvent: { type: "text_end", contentIndex: 0 },
      })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(
      m.events("message_update", { assistantMessageEvent: { type: "thinking_delta" } })[0],
    ).toMatchObject({ kind: "unknown" });
    expect(m.events("message_update", { assistantMessageEvent: {} })[0]).toMatchObject({
      kind: "unknown",
    });
  });

  it("numbers an assistant message that ended without a start, and reports a provider error with no text", () => {
    const m = mapper();
    expect(
      m.events("message_end", { message: { role: "assistant", stopReason: "error" } }),
    ).toEqual([
      {
        kind: "message_completed",
        messageId: "pi-m1",
        finish: "error",
        usage: null,
        error: { name: "PiTurnFailed", message: "the model request failed" },
      },
    ]);
    expect(m.events("agent_settled", {})).toEqual([
      {
        kind: "session_error",
        name: "PiTurnFailed",
        message: "the model request failed",
        status: null,
      },
      { kind: "session_idle" },
    ]);
    // Settling reports it once.
    expect(m.events("agent_settled", {})).toEqual([{ kind: "session_idle" }]);
  });

  it("settles a tool that ended without a start, failed, with its own text or a plain one", () => {
    const m = mapper();
    expect(
      m.events("tool_execution_end", {
        toolCallId: "c1",
        toolName: "read",
        args: { path: "src/a.ts" },
        result: { content: [{ type: "text", text: "no such file" }, { type: "image" }] },
        isError: true,
      }),
    ).toEqual([
      {
        kind: "tool_part",
        messageId: "c1",
        part: {
          callId: "c1",
          tool: "read",
          title: "src/a.ts",
          input: { path: "src/a.ts" },
          status: "error",
          output: null,
          error: "no such file",
          exitCode: null,
          startedAtMs: 1_010,
          endedAtMs: 1_020,
        },
      },
    ]);
    const [plain] = m.events("tool_execution_end", {
      toolCallId: "c2",
      toolName: "grep",
      args: { pattern: "TODO" },
      result: "not a result",
      isError: true,
    });
    expect(plain).toMatchObject({ part: { title: "TODO", error: "the tool failed" } });
    const [named] = m.events("tool_execution_start", {
      toolCallId: "c3",
      toolName: "oncue_git_commit",
    });
    expect(named).toMatchObject({ part: { title: "oncue_git_commit", input: {} } });
  });

  it("bounds a large tool input", () => {
    const m = mapper();
    const [event] = m.events("tool_execution_start", {
      toolCallId: "c",
      toolName: "write",
      args: { path: "big.txt", content: "x".repeat(100_000) },
    });
    expect(event).toMatchObject({ part: { input: { truncated: true } } });
  });
});
