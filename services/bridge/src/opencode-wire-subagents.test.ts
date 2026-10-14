import { describe, expect, it } from "vitest";
import { parseServerEvent, parseToolPart } from "./opencode-wire";

describe("subagents on the OpenCode wire (record 12)", () => {
  it("tags every event about a conversation with its id, a subagent's included", () => {
    expect(
      parseServerEvent({ type: "session.idle", properties: { sessionID: "ses_child" } }),
    ).toEqual({ kind: "session_idle", sessionId: "ses_child" });
    // An event naming no conversation is left untagged.
    expect(parseServerEvent({ type: "server.connected", properties: {} })).toEqual({
      kind: "server_connected",
    });
  });

  it("reads a subagent's conversation from session.created, with its parent and its name", () => {
    expect(
      parseServerEvent({
        type: "session.created",
        properties: {
          sessionID: "ses_child",
          info: {
            id: "ses_child",
            parentID: "ses_root",
            title: "Find the A file (@general subagent)",
            agent: "general",
          },
        },
      }),
    ).toEqual({
      kind: "session_created",
      sessionId: "ses_child",
      parentId: "ses_root",
      title: "Find the A file (@general subagent)",
      agent: "general",
    });
    expect(
      parseServerEvent({
        type: "session.created",
        properties: { sessionID: "ses_root", info: {} },
      }),
    ).toEqual({
      kind: "session_created",
      sessionId: "ses_root",
      parentId: null,
      title: "",
      agent: null,
    });
    expect(parseServerEvent({ type: "session.created", properties: {} })).toMatchObject({
      kind: "unknown",
      wireKind: "session.created",
    });
    expect(
      parseServerEvent({ type: "session.created", properties: { info: { title: "no id" } } }),
    ).toMatchObject({ kind: "unknown", wireKind: "session.created" });
  });

  it("reads what a permission ask is about: for task, the subagent's name", () => {
    expect(
      parseServerEvent({
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_root",
          permission: "task",
          patterns: ["general", 7],
          tool: { messageID: "msg_1", callID: "toolu_1" },
        },
      }),
    ).toEqual({
      kind: "permission_asked",
      requestId: "per_1",
      permission: "task",
      callId: "toolu_1",
      patterns: ["general"],
      metadata: {},
      sessionId: "ses_root",
    });
    expect(
      parseServerEvent({
        type: "permission.asked",
        properties: { id: "per_1", permission: "bash", tool: { callID: "c" } },
      }),
    ).toMatchObject({ kind: "permission_asked", patterns: [] });
  });

  it("names the subagent a task call started from its metadata, once it has one", () => {
    const running = parseToolPart({
      callID: "toolu_1",
      tool: "task",
      state: {
        status: "running",
        input: { description: "d", prompt: "p", subagent_type: "general" },
        metadata: { parentSessionId: "ses_root", sessionId: "ses_child" },
        time: { start: 1 },
      },
    });
    expect(running?.childSessionId).toBe("ses_child");
    const before = parseToolPart({
      callID: "toolu_1",
      tool: "task",
      state: { status: "running", input: {}, time: { start: 1 } },
    });
    expect(before).not.toHaveProperty("childSessionId");
  });
});
