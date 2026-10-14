import { LIMITS } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  HOMELESS_KINDS,
  isHomeless,
  parsePart,
  parsePendingQuestions,
  parseServerEvent,
  parseToolPart,
  UNKNOWN_RAW_CAP_BYTES,
} from "./opencode-wire";

function part(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", ...overrides };
}

function toolPart(state: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return part({ type: "tool", callID: "call_1", tool: "bash", state, ...overrides });
}

describe("parseServerEvent: the kinds the bridge maps", () => {
  it("server.connected", () => {
    expect(parseServerEvent({ type: "server.connected", properties: {} })).toEqual({
      kind: "server_connected",
    });
  });

  it("message.updated for a user message is a user message_started", () => {
    expect(
      parseServerEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_u", role: "user", time: { created: 1 } },
        },
      }),
    ).toEqual({ kind: "message_started", messageId: "msg_u", role: "user", sessionId: "ses_1" });
  });

  it("message.updated for an assistant message without time.completed is message_started", () => {
    expect(
      parseServerEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_a", role: "assistant", time: { created: 1 } },
        },
      }),
    ).toEqual({
      kind: "message_started",
      messageId: "msg_a",
      role: "assistant",
      sessionId: "ses_1",
    });
  });

  it("message.updated with time.completed is message_completed carrying finish, tokens, and the error", () => {
    expect(
      parseServerEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "msg_a",
            role: "assistant",
            time: { created: 1, completed: 9 },
            finish: "stop",
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        },
      }),
    ).toEqual({
      kind: "message_completed",
      messageId: "msg_a",
      finish: "stop",
      usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      error: { name: "MessageAbortedError", message: "aborted" },
      sessionId: "ses_1",
    });
  });

  it("message.updated with an unknown role is unknown, not a throw", () => {
    expect(
      parseServerEvent({
        type: "message.updated",
        properties: { sessionID: "ses_1", info: { id: "msg", role: "system" } },
      }),
    ).toMatchObject({ kind: "unknown", wireKind: "message.updated" });
  });

  it("message.part.delta with field text is text_delta carrying only the delta", () => {
    expect(
      parseServerEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "prt_1",
          field: "text",
          delta: " world",
        },
      }),
    ).toEqual({
      kind: "text_delta",
      messageId: "msg_1",
      partId: "prt_1",
      text: " world",
      sessionId: "ses_1",
    });
  });

  it("message.part.delta for a field nobody has seen is unknown under that field's name", () => {
    expect(
      parseServerEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "prt_1",
          field: "metadata",
          delta: "x",
        },
      }),
    ).toMatchObject({ kind: "unknown", wireKind: "message.part.delta/metadata" });
  });

  it("message.part.delta missing its ids or delta is unknown, never a throw", () => {
    expect(
      parseServerEvent({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_1", field: "text", delta: "x" },
      }),
    ).toMatchObject({ kind: "unknown", wireKind: "message.part.delta" });
    expect(
      parseServerEvent({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text" },
      }),
    ).toMatchObject({ kind: "unknown", wireKind: "message.part.delta" });
  });

  it("todo.updated numbers the items, since OpenCode's todos carry no id", () => {
    expect(
      parseServerEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses_1",
          todos: [
            { content: "one", status: "completed", priority: "high" },
            { content: "two", status: "weird", priority: "low" },
          ],
        },
      }),
    ).toEqual({
      kind: "todos",
      items: [
        { id: "todo_1", content: "one", status: "completed" },
        { id: "todo_2", content: "two", status: "pending" },
      ],
      sessionId: "ses_1",
    });
  });

  it("todo.updated without a list is unknown", () => {
    expect(parseServerEvent({ type: "todo.updated", properties: { todos: 3 } })).toMatchObject({
      kind: "unknown",
      wireKind: "todo.updated",
    });
  });

  it("session.idle", () => {
    expect(parseServerEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })).toEqual({
      kind: "session_idle",
      sessionId: "ses_1",
    });
  });

  it("session.error carries the name, message, and status code", () => {
    expect(
      parseServerEvent({
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: {
            name: "APIError",
            data: { message: "nope", statusCode: 429, isRetryable: true },
          },
        },
      }),
    ).toEqual({
      kind: "session_error",
      name: "APIError",
      message: "nope",
      status: 429,
      sessionId: "ses_1",
    });
    expect(parseServerEvent({ type: "session.error", properties: {} })).toEqual({
      kind: "session_error",
      name: "UnknownError",
      message: "UnknownError",
      status: null,
    });
  });

  it("session.diff keeps the files that name a path and normalises status", () => {
    expect(
      parseServerEvent({
        type: "session.diff",
        properties: {
          sessionID: "ses_1",
          diff: [
            { file: "a.ts", status: "added", additions: 2, deletions: 0, patch: "+a" },
            { file: "b.ts", status: "weird", additions: -1, deletions: 1.5 },
            { additions: 1, deletions: 1 },
          ],
        },
      }),
    ).toEqual({
      kind: "session_diff",
      files: [
        { path: "a.ts", status: "added", additions: 2, deletions: 0, patch: "+a" },
        { path: "b.ts", status: "modified", additions: 0, deletions: 1, patch: "" },
      ],
      sessionId: "ses_1",
    });
  });

  it("file.edited", () => {
    expect(parseServerEvent({ type: "file.edited", properties: { file: "README.md" } })).toEqual({
      kind: "file_edited",
      path: "README.md",
    });
    expect(parseServerEvent({ type: "file.edited", properties: {} })).toMatchObject({
      kind: "unknown",
      wireKind: "file.edited",
    });
  });
});

describe("parseServerEvent: the homeless and the unknown", () => {
  it.each(HOMELESS_KINDS.filter((kind) => !kind.startsWith("message.part.updated/")))(
    "%s is homeless, never unknown",
    (kind) => {
      const wireKind = kind.endsWith(".") ? `${kind}anything` : kind;
      expect(parseServerEvent({ type: wireKind, properties: {} })).toEqual({
        kind: "homeless",
        wireKind,
      });
    },
  );

  it("isHomeless matches exact entries and prefixes only", () => {
    expect(isHomeless("session.status")).toBe(true);
    expect(isHomeless("session.next.text.delta")).toBe(true);
    expect(isHomeless("session.statusx")).toBe(false);
    expect(isHomeless("session.idle")).toBe(false);
  });

  it("a kind nobody has seen is unknown with its JSON capped", () => {
    const big = "x".repeat(UNKNOWN_RAW_CAP_BYTES * 2);
    const event = parseServerEvent({ type: "mystery.kind", properties: { big } });
    expect(event).toMatchObject({ kind: "unknown", wireKind: "mystery.kind" });
    if (event.kind !== "unknown") {
      throw new Error("expected unknown");
    }
    expect(event.raw).toHaveLength(UNKNOWN_RAW_CAP_BYTES);
  });

  it.each([7, null, "text", []])("%j is unknown with no kind to name", (raw) => {
    expect(parseServerEvent(raw)).toMatchObject({ kind: "unknown", wireKind: "" });
  });
});

describe("parsePart", () => {
  it("a text part is text_part carrying the whole text, whether it opens empty or closes full", () => {
    expect(parsePart(part({ type: "text", text: "", time: { start: 1 } }))).toEqual({
      kind: "text_part",
      messageId: "msg_1",
      partId: "prt_1",
      text: "",
    });
    expect(parsePart(part({ type: "text", text: "hello", time: { start: 1, end: 2 } }))).toEqual({
      kind: "text_part",
      messageId: "msg_1",
      partId: "prt_1",
      text: "hello",
    });
  });

  it("a reasoning part is reasoning with its ids and never its text", () => {
    expect(parsePart(part({ type: "reasoning", text: "secret" }))).toEqual({
      kind: "reasoning",
      messageId: "msg_1",
      partId: "prt_1",
    });
  });

  it("a step-finish part records the reason and tokens", () => {
    expect(
      parsePart(
        part({
          type: "step-finish",
          reason: "stop",
          cost: 0,
          // The recorded session's second step.
          tokens: {
            total: 10_114,
            input: 2,
            output: 253,
            reasoning: 0,
            cache: { write: 457, read: 9_402 },
          },
        }),
      ),
    ).toEqual({
      kind: "step_finished",
      messageId: "msg_1",
      reason: "stop",
      usage: { input: 2, output: 253, reasoning: 0, cacheRead: 9_402, cacheWrite: 457 },
    });
  });

  it("reads tokens with no reasoning or cache figures as zero, and tokens without input as none", () => {
    expect(
      parsePart(part({ type: "step-finish", reason: "stop", tokens: { input: 3, output: 4 } })),
    ).toMatchObject({
      usage: { input: 3, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(
      parsePart(part({ type: "step-finish", reason: "stop", tokens: { output: 4 } })),
    ).toMatchObject({ usage: null });
  });

  it.each(["step-start", "file", "patch", "snapshot", "agent", "subtask", "retry", "compaction"])(
    "a %s part is homeless under its message.part.updated/ name",
    (type) => {
      expect(parsePart(part({ type }))).toEqual({
        kind: "homeless",
        wireKind: `message.part.updated/${type}`,
      });
    },
  );

  it("a part type nobody has seen is unknown", () => {
    expect(parsePart(part({ type: "hologram" }))).toMatchObject({
      kind: "unknown",
      wireKind: "message.part.updated/hologram",
    });
  });

  it("a part missing its message id is unknown, never a throw", () => {
    expect(parsePart({ type: "text", text: "x" })).toMatchObject({
      kind: "unknown",
      wireKind: "message.part.updated/text",
    });
    expect(parsePart(null)).toMatchObject({ kind: "unknown" });
  });

  it("a tool part becomes tool_part", () => {
    expect(
      parsePart(
        toolPart({ status: "running", input: { command: "ls" }, title: "ls", time: { start: 5 } }),
      ),
    ).toEqual({
      kind: "tool_part",
      messageId: "msg_1",
      part: {
        callId: "call_1",
        tool: "bash",
        status: "running",
        title: "ls",
        input: { command: "ls" },
        output: null,
        error: null,
        exitCode: null,
        startedAtMs: 5,
        endedAtMs: null,
      },
    });
  });
});

describe("parseToolPart", () => {
  it("reads every field of a completed part", () => {
    expect(
      parseToolPart(
        toolPart({
          status: "completed",
          input: { command: "pnpm test" },
          output: "42 passed",
          title: "pnpm test",
          metadata: { exit: 0 },
          time: { start: 1000, end: 4500 },
        }),
      ),
    ).toEqual({
      callId: "call_1",
      tool: "bash",
      status: "completed",
      title: "pnpm test",
      input: { command: "pnpm test" },
      output: "42 passed",
      error: null,
      exitCode: 0,
      startedAtMs: 1000,
      endedAtMs: 4500,
    });
  });

  it("reads an error part", () => {
    expect(
      parseToolPart(
        toolPart({ status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } }),
      ),
    ).toMatchObject({ status: "error", error: "boom", exitCode: null });
  });

  it.each([
    ["a status it does not know", toolPart({ status: "queued", input: {} })],
    ["no state", part({ type: "tool", callID: "c", tool: "bash" })],
    ["no callID", part({ type: "tool", tool: "bash", state: { status: "pending", input: {} } })],
    ["not an object", 4],
  ])("refuses %s as null", (_name, raw) => {
    expect(parseToolPart(raw)).toBeNull();
  });

  it("replaces an input that would not fit the protocol's inline JSON limit with a preview", () => {
    const parsed = parseToolPart(
      toolPart({ status: "pending", input: { text: "y".repeat(LIMITS.inlineJsonChars) }, raw: "" }),
    );
    expect(parsed?.input).toMatchObject({ truncated: true });
    expect(JSON.stringify(parsed?.input).length).toBeLessThanOrEqual(LIMITS.inlineJsonChars);
  });

  it("treats a non-object input as empty", () => {
    expect(parseToolPart(toolPart({ status: "pending", input: "raw", raw: "raw" }))?.input).toEqual(
      {},
    );
  });
});

describe("parseServerEvent: the harness's own asks", () => {
  it("keeps a permission ask's patterns and metadata, as OpenCode 1.18.30 sends them", () => {
    expect(
      parseServerEvent({
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          permission: "external_directory",
          patterns: ["/etc/*", 7],
          metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
          always: ["/etc/*"],
          tool: { messageID: "msg_1", callID: "call_1" },
        },
      }),
    ).toEqual({
      kind: "permission_asked",
      requestId: "per_1",
      permission: "external_directory",
      callId: "call_1",
      patterns: ["/etc/*"],
      metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
      // The conversation that asked, so a subagent's ask is told from the primary agent's.
      sessionId: "ses_1",
    });
  });

  it("keeps an ask tied to no call, which still needs an answer", () => {
    expect(
      parseServerEvent({
        type: "permission.asked",
        properties: { id: "per_2", permission: "doom_loop", patterns: "bash", metadata: null },
      }),
    ).toEqual({
      kind: "permission_asked",
      requestId: "per_2",
      permission: "doom_loop",
      callId: null,
      patterns: [],
      metadata: {},
    });
  });

  it("drops an ask with no id or permission, which no reply could name", () => {
    expect(
      parseServerEvent({ type: "permission.asked", properties: { permission: "read" } }),
    ).toEqual({ kind: "homeless", wireKind: "permission.asked" });
    expect(parseServerEvent({ type: "permission.asked", properties: { id: "per_3" } })).toEqual({
      kind: "homeless",
      wireKind: "permission.asked",
    });
  });

  it("reads a reply to a permission request, whoever sent it", () => {
    expect(
      parseServerEvent({
        type: "permission.replied",
        properties: { sessionID: "ses_1", requestID: "per_2", reply: "reject" },
      }),
    ).toEqual({ kind: "permission_replied", requestId: "per_2", sessionId: "ses_1" });
    expect(parseServerEvent({ type: "permission.replied", properties: {} })).toEqual({
      kind: "homeless",
      wireKind: "permission.replied",
    });
  });
});

describe("parseServerEvent: questions", () => {
  // OpenCode 1.18.30's `question.asked`, as its OpenAPI document gives it.
  const asked = {
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "One file" },
          ],
          multiple: false,
        },
        {
          question: "Which targets?",
          header: "Targets",
          options: [
            { label: "Web", description: "" },
            { label: "iOS", description: "" },
          ],
          multiple: true,
          custom: false,
        },
      ],
      tool: { messageID: "msg_1", callID: "call_q" },
    },
  };

  it("maps an ask to the shared shape, a typed answer allowed unless custom is false", () => {
    expect(parseServerEvent(asked)).toEqual({
      kind: "question_asked",
      sessionId: "ses_1",
      requestId: "que_1",
      callId: "call_q",
      askedCount: 2,
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
    });
  });

  it("names no call when the ask has no tool, and drops an ask it cannot read", () => {
    const { tool: _tool, ...untooled } = asked.properties;
    expect(parseServerEvent({ type: "question.asked", properties: untooled })).toMatchObject({
      kind: "question_asked",
      callId: null,
    });
    for (const properties of [
      { id: "que_1", questions: "no" },
      { questions: asked.properties.questions },
      { id: "que_1", questions: [] },
    ]) {
      expect(parseServerEvent({ type: "question.asked", properties })).toEqual({
        kind: "homeless",
        wireKind: "question.asked",
      });
    }
    expect(
      parseServerEvent({ type: "question.asked", properties: { id: "que_1", questions: ["x"] } }),
    ).toMatchObject({ kind: "question_asked", questions: [{ text: "Question 1" }] });
  });

  it("reads a reply or a rejection as the question settled", () => {
    for (const type of ["question.replied", "question.rejected"]) {
      expect(
        parseServerEvent({
          type,
          properties: { sessionID: "ses_1", requestID: "que_1", answers: [["Postgres"]] },
        }),
      ).toEqual({ kind: "question_settled", requestId: "que_1", sessionId: "ses_1" });
      expect(parseServerEvent({ type, properties: {} })).toEqual({
        kind: "homeless",
        wireKind: type,
      });
    }
  });

  it("reads `GET /question` as the same asks, leaving out what it cannot read", () => {
    expect(parsePendingQuestions([asked.properties, { id: "que_bad" }, null])).toEqual([
      parseServerEvent(asked),
    ]);
    expect(parsePendingQuestions({ not: "a list" })).toEqual([]);
    // Each keeps the conversation that asked, so a subagent's is told apart.
    const { sessionID: _session, ...untagged } = asked.properties;
    expect(parsePendingQuestions([untagged])[0]).not.toHaveProperty("sessionId");
  });
});
