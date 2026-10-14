import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  codexDynamicTools,
  codexInput,
  codexVersionOf,
  createCodexClient,
  type LineChannel,
  nodeLineChannel,
} from "./codex-client";
import type { RuntimeEvent } from "./normalize";
import type { PromptTurn } from "./runtime";

/** A fake app-server on the other end of the channel: it sees every line and answers as the test says. */
class FakeServer {
  readonly sent: Array<Record<string, unknown>> = [];
  private lineHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  /** Answers each request by method; a method with no entry gets no answer. */
  answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => ({ userAgent: "oncue_bridge/0.157.1 (Linux; x86_64)" }),
    "thread/start": () => ({ thread: { id: "th_1" } }),
    "turn/start": () => ({ turn: { id: "tu_1" } }),
    "turn/steer": () => ({ turnId: "tu_1" }),
    "turn/interrupt": () => ({}),
  };
  failures: Record<string, string> = {};

  readonly channel: LineChannel = {
    send: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      this.sent.push(message);
      const method = message.method as string | undefined;
      if (method === undefined || message.id === undefined) {
        return;
      }
      const failure = this.failures[method];
      if (failure !== undefined) {
        queueMicrotask(() => this.push({ id: message.id, error: { message: failure } }));
        return;
      }
      const answer = this.answers[method];
      if (answer !== undefined) {
        queueMicrotask(() =>
          this.push({ id: message.id, result: answer(message.params as Record<string, unknown>) }),
        );
      }
    },
    onLine: (handler) => {
      this.lineHandler = handler;
    },
    onClose: (handler) => {
      this.closeHandler = handler;
    },
    close: () => {
      this.closeHandler?.();
    },
  };

  push(message: unknown): void {
    this.lineHandler?.(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(): void {
    this.closeHandler?.();
  }

  replies(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.method === undefined);
  }
}

const TURN: PromptTurn = {
  conversation: null,
  title: "OnCue run run_1",
  text: "Fix it",
  model: { provider: "openai", modelId: "gpt-6-sol" },
  effort: "low",
};

function world(overrides: { connect?: () => Promise<LineChannel | null> } = {}) {
  const server = new FakeServer();
  const calls: Array<{ name: string; args: unknown }> = [];
  const events: RuntimeEvent[] = [];
  let toolAnswer: () => Promise<{ text: string; isError: boolean }> = async () => ({
    text: "done",
    isError: false,
  });
  const client = createCodexClient({
    connect: overrides.connect ?? (async () => server.channel),
    callTool: (name, args) => {
      calls.push({ name, args });
      return toolAnswer();
    },
    cwd: "/workspace",
    requestTimeoutMs: 200,
  });
  return {
    server,
    client,
    calls,
    events,
    setToolAnswer(next: () => Promise<{ text: string; isError: boolean }>) {
      toolAnswer = next;
    },
    async ready() {
      expect(await client.health(4097)).toEqual({ kind: "healthy", version: "0.157.1" });
      void client.subscribe(4097, (event) => events.push(event), new AbortController().signal);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the pure helpers", () => {
  it("reads Codex's version out of its user agent", () => {
    expect(codexVersionOf("oncue_bridge/0.157.1 (Linux 6; x86_64) unknown")).toBe("0.157.1");
    expect(codexVersionOf("nothing")).toBe("unknown");
    expect(codexVersionOf(7)).toBe("unknown");
  });

  it("hands Codex OnCue's four tools and its question tool under the names the model sees", () => {
    expect(codexDynamicTools().map((tool) => tool.name)).toEqual([
      "oncue_policy_propose",
      "oncue_pull_request_describe",
      "oncue_git_commit",
      "oncue_secret_request",
      "oncue_ask_user",
    ]);
    expect(codexDynamicTools()[0]).toMatchObject({ type: "function" });
  });

  it("sends the text, then each attached image as a local file", () => {
    expect(
      codexInput({
        ...TURN,
        files: [
          {
            type: "file",
            mime: "image/png",
            url: "file:///var/lib/oncue/attachments/m1/a%20b.png",
            filename: "a b.png",
          },
          { type: "file", mime: "image/png", url: "https://elsewhere/x.png", filename: "x.png" },
        ],
      }),
    ).toEqual([
      { type: "text", text: "Fix it", text_elements: [] },
      { type: "localImage", path: "/var/lib/oncue/attachments/m1/a b.png" },
    ]);
    expect(codexInput(TURN)).toHaveLength(1);
  });
});

describe("createCodexClient", () => {
  it("is not ready while nothing listens, and says why", async () => {
    const { client } = world({ connect: async () => null });
    expect(await client.health(4097)).toEqual({
      kind: "not_yet",
      detail: "the runtime host is not listening yet",
    });
    expect(await client.prompt(4097, TURN)).toMatchObject({ kind: "refused" });
  });

  it("handshakes once, then answers healthy from memory", async () => {
    const { server, client } = world();
    expect(await client.health(4097)).toEqual({ kind: "healthy", version: "0.157.1" });
    expect(await client.health(4097)).toMatchObject({ kind: "healthy" });
    expect(server.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(server.sent[0]?.params).toMatchObject({ capabilities: { experimentalApi: true } });
  });

  it("is not ready when initialize fails or times out", async () => {
    const failing = world();
    failing.server.failures.initialize = "busy";
    expect(await failing.client.health(4097)).toEqual({ kind: "not_yet", detail: "busy" });
    const silent = world();
    delete silent.server.answers.initialize;
    expect(await silent.client.health(4097)).toMatchObject({
      kind: "not_yet",
      detail: "initialize got no answer in 200 ms",
    });
  });

  it("starts a thread with OnCue's tools and no sandbox or approvals of its own, then a turn at the run's effort", async () => {
    const { server, client } = world();
    expect(await client.prompt(4097, TURN)).toEqual({ kind: "held", conversation: "th_1" });
    const start = server.sent.find((message) => message.method === "thread/start");
    expect(start?.params).toMatchObject({
      model: "gpt-6-sol",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const turn = server.sent.find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({ threadId: "th_1", effort: "low" });
  });

  it("names no effort for a model with none, and continues a thread it is given", async () => {
    const { server, client } = world();
    await client.prompt(4097, { ...TURN, conversation: "th_9", effort: null });
    expect(server.sent.some((message) => message.method === "thread/start")).toBe(false);
    const turn = server.sent.find((message) => message.method === "turn/start");
    expect(turn?.params).toEqual({
      threadId: "th_9",
      input: [{ type: "text", text: "Fix it", text_elements: [] }],
    });
  });

  it("steers the active turn instead of starting another", async () => {
    const { server, client } = world();
    await client.prompt(4097, TURN);
    await client.prompt(4097, { ...TURN, conversation: "th_1", text: "Also this" });
    const steer = server.sent.find((message) => message.method === "turn/steer");
    expect(steer?.params).toMatchObject({ threadId: "th_1", expectedTurnId: "tu_1" });
  });

  it("starts a fresh turn once the last one completed", async () => {
    const { server, client, ready } = world();
    await ready();
    await client.prompt(4097, TURN);
    server.push({
      method: "turn/completed",
      params: { threadId: "th_1", turn: { id: "tu_1", status: "completed" } },
    });
    await client.prompt(4097, { ...TURN, conversation: "th_1" });
    expect(server.sent.filter((message) => message.method === "turn/start")).toHaveLength(2);
  });

  it("refuses a prompt when the thread or turn cannot start", async () => {
    const noThread = world();
    noThread.server.answers["thread/start"] = () => ({});
    expect(await noThread.client.prompt(4097, TURN)).toEqual({
      kind: "refused",
      detail: "codex did not start a thread",
    });
    const noTurn = world();
    noTurn.server.failures["turn/start"] = "model unknown";
    expect(await noTurn.client.prompt(4097, TURN)).toEqual({
      kind: "refused",
      detail: "codex refused the prompt: model unknown",
    });
  });

  it("keeps a turn id from turn/started over one it did not answer with", async () => {
    const { server, client, ready } = world();
    await ready();
    server.answers["turn/start"] = () => ({});
    server.push({ method: "turn/started", params: { threadId: "th_1", turn: { id: "tu_live" } } });
    await client.prompt(4097, { ...TURN, conversation: "th_1" });
    expect(await client.abort(4097, "th_1")).toBe(true);
    expect(server.sent.find((message) => message.method === "turn/interrupt")?.params).toEqual({
      threadId: "th_1",
      turnId: "tu_live",
    });
  });

  it("interrupts the active turn, and answers false with none, or when the interrupt fails", async () => {
    const { server, client } = world();
    expect(await client.abort(4097, "th_1")).toBe(false);
    await client.prompt(4097, TURN);
    server.failures["turn/interrupt"] = "gone";
    expect(await client.abort(4097, "th_1")).toBe(false);
  });

  it("hands every notification on as events, the early ones after the stream opens", async () => {
    const { server, client, events } = world();
    await client.health(4097);
    server.push({ method: "item/agentMessage/delta", params: { itemId: "m", delta: "Hi" } });
    server.push("not json");
    void client.subscribe(4097, (event) => events.push(event), new AbortController().signal);
    expect(events.map((event) => event.kind)).toEqual([
      "server_connected",
      "text_delta",
      "unknown",
    ]);
    server.push({
      method: "turn/completed",
      params: { threadId: "th_1", turn: { status: "completed" } },
    });
    expect(events.at(-1)).toEqual({ kind: "session_idle" });
    server.push({ id: 999, result: {} });
  });

  it("answers OnCue's tools in-process, a tool it does not know as a failure, and a tool that throws", async () => {
    const { server, calls, ready, setToolAnswer } = world();
    await ready();
    server.push({
      id: 0,
      method: "item/tool/call",
      params: { tool: "oncue_policy_propose", callId: "c1", arguments: { push: "auto" } },
    });
    server.push({ id: 1, method: "item/tool/call", params: { tool: "shell", callId: "c2" } });
    await flush();
    setToolAnswer(async () => {
      throw new Error("boom");
    });
    server.push({
      id: 2,
      method: "item/tool/call",
      params: { tool: "oncue_git_commit", arguments: {} },
    });
    await flush();
    await flush();
    expect(calls).toEqual([
      { name: "policy_propose", args: { push: "auto" } },
      { name: "", args: undefined },
      { name: "git_commit", args: {} },
    ]);
    expect(server.replies()).toEqual([
      { id: 0, result: { contentItems: [{ type: "inputText", text: "done" }], success: true } },
      { id: 1, result: { contentItems: [{ type: "inputText", text: "done" }], success: true } },
      {
        id: 2,
        result: { contentItems: [{ type: "inputText", text: "The tool failed." }], success: false },
      },
    ]);
  });

  it("holds secret_request as a permission and answers only when told, once or not at all", async () => {
    const { server, client, calls, events, ready } = world();
    await ready();
    server.push({
      id: 0,
      method: "item/tool/call",
      params: {
        tool: "oncue_secret_request",
        callId: "c_secret",
        turnId: "tu_1",
        arguments: { name: "STRIPE_TEST_KEY" },
      },
    });
    expect(events.slice(-2)).toEqual([
      {
        kind: "permission_asked",
        requestId: "0",
        permission: "oncue_secret_request",
        callId: "c_secret",
      },
      expect.objectContaining({
        kind: "tool_part",
        messageId: "tu_1",
        part: expect.objectContaining({ callId: "c_secret", input: { name: "STRIPE_TEST_KEY" } }),
      }),
    ]);
    expect(server.replies()).toEqual([]);
    expect(await client.replyHeld(4097, "0", "once", null)).toBe(true);
    expect(calls).toEqual([{ name: "secret_request", args: { name: "STRIPE_TEST_KEY" } }]);
    expect(server.replies()[0]).toMatchObject({ id: 0, result: { success: true } });
    // Answered once: a second reply finds nothing.
    expect(await client.replyHeld(4097, "0", "once", null)).toBe(false);

    server.push({ id: 5, method: "item/tool/call", params: { tool: "oncue_secret_request" } });
    expect(events.at(-2)).toMatchObject({ requestId: "5", callId: "5" });
    expect(await client.replyHeld(4097, "5", "reject", null)).toBe(true);
    expect(server.replies()[1]).toEqual({
      id: 5,
      result: {
        contentItems: [{ type: "inputText", text: "The user did not allow this." }],
        success: false,
      },
    });
    server.push({ id: 6, method: "item/tool/call", params: { tool: "oncue_secret_request" } });
    await client.replyHeld(4097, "6", "reject", "No.");
    expect(server.replies()[2]).toMatchObject({ result: { contentItems: [{ text: "No." }] } });
  });

  it("answers questions with nothing, declines approvals, and refuses the rest", async () => {
    const { server, ready } = world();
    await ready();
    server.push({ id: 10, method: "item/tool/requestUserInput", params: {} });
    server.push({ id: 11, method: "item/commandExecution/requestApproval", params: {} });
    server.push({ id: 12, method: "item/fileChange/requestApproval", params: {} });
    server.push({ id: 13, method: "execCommandApproval", params: {} });
    server.push({ id: 14, method: "applyPatchApproval", params: {} });
    server.push({ id: 15, method: "account/chatgptAuthTokens/refresh", params: {} });
    expect(server.replies()).toEqual([
      { id: 10, result: { answers: {} } },
      { id: 11, result: { decision: "decline" } },
      { id: 12, result: { decision: "decline" } },
      { id: 13, result: { decision: "denied" } },
      { id: 14, result: { decision: "denied" } },
      {
        id: 15,
        error: { code: -32601, message: "OnCue does not serve account/chatgptAuthTokens/refresh" },
      },
    ]);
  });

  it("forgets everything when the connection closes: pending requests fail, the stream ends, the handshake repeats", async () => {
    const { server, client, events } = world();
    await client.health(4097);
    const ended = client.subscribe(
      4097,
      (event) => events.push(event),
      new AbortController().signal,
    );
    delete server.answers["thread/start"];
    const prompt = client.prompt(4097, TURN);
    await flush();
    server.close();
    expect(await prompt).toEqual({
      kind: "refused",
      detail: "codex refused the prompt: the runtime host closed the connection",
    });
    await ended;
    expect(await client.replyHeld(4097, "0", "once", null)).toBe(false);
    expect(await client.health(4097)).toMatchObject({ kind: "healthy" });
    expect(server.sent.filter((message) => message.method === "initialize")).toHaveLength(2);
  });

  it("ends a subscription on abort, and resolves at once with no connection", async () => {
    const { client } = world({ connect: async () => null });
    await client.subscribe(4097, () => {}, new AbortController().signal);
    const live = world();
    await live.client.health(4097);
    const controller = new AbortController();
    const ended = live.client.subscribe(4097, () => {}, controller.signal);
    controller.abort();
    await ended;
  });
});

describe("nodeLineChannel", () => {
  it("answers null when nothing listens", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await nodeLineChannel(port)).toBeNull();
  });

  it("frames lines both ways, across chunk boundaries, skipping blank ones", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (data: string) => received.push(data));
      socket.write('{"a":1}\n{"b"');
      setTimeout(() => socket.write(':2}\n\n{"c":3}\n'), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const channel = await nodeLineChannel(port);
    const lines: string[] = [];
    channel?.onLine((line) => lines.push(line));
    let closed = false;
    channel?.onClose(() => {
      closed = true;
    });
    channel?.send('{"hello":true}');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(received.join("")).toBe('{"hello":true}\n');
    channel?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("ask_user", () => {
  const args = {
    questions: [
      {
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "One file" },
        ],
      },
      { header: "Name", question: "What should it be called?", options: [] },
    ],
  };

  it("holds the call as a question and answers with each question and answer", async () => {
    const { server, client, calls, events, ready } = world();
    await ready();
    server.push({
      id: 7,
      method: "item/tool/call",
      params: { tool: "oncue_ask_user", callId: "c_q", turnId: "tu_1", arguments: args },
    });
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({
        kind: "tool_part",
        part: expect.objectContaining({ callId: "c_q", tool: "oncue_ask_user" }),
      }),
      {
        kind: "question_asked",
        requestId: "7",
        callId: "c_q",
        askedCount: 2,
        questions: [
          expect.objectContaining({ header: "Database", allowOther: true }),
          expect.objectContaining({ text: "What should it be called?", options: [] }),
        ],
      },
    ]);
    expect(server.replies()).toEqual([]);
    expect(calls).toEqual([]);
    // Not a permission: the secret path does not answer it.
    expect(await client.replyHeld(4097, "7", "once", null)).toBe(false);
    expect(
      await client.replyQuestion(4097, "7", { kind: "answer", answers: [["SQLite"], ["Ledger"]] }),
    ).toBe(true);
    expect(server.replies()).toEqual([
      {
        id: 7,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: "The user answered:\n\nWhich database?\nAnswer: SQLite\n\nWhat should it be called?\nAnswer: Ledger",
            },
          ],
          success: true,
        },
      },
    ]);
    expect(await client.replyQuestion(4097, "7", { kind: "dismiss", reason: "dismissed" })).toBe(
      false,
    );
  });

  it("fails a dismissed call in plain words, and an unreadable one at once", async () => {
    const { server, client, ready } = world();
    await ready();
    server.push({
      id: 8,
      method: "item/tool/call",
      params: { tool: "oncue_ask_user", arguments: args },
    });
    expect(await client.replyQuestion(4097, "8", { kind: "dismiss", reason: "dismissed" })).toBe(
      true,
    );
    server.push({
      id: 9,
      method: "item/tool/call",
      params: { tool: "oncue_ask_user", arguments: { questions: [] } },
    });
    expect(server.replies()).toEqual([
      {
        id: 8,
        result: {
          contentItems: [{ type: "inputText", text: "The user dismissed the question." }],
          success: false,
        },
      },
      {
        id: 9,
        result: {
          contentItems: [{ type: "inputText", text: "OnCue could not read the question." }],
          success: false,
        },
      },
    ]);
    // A second ask in parallel is told why, not that the user dismissed it.
    server.push({
      id: 11,
      method: "item/tool/call",
      params: { tool: "oncue_ask_user", arguments: args },
    });
    await client.replyQuestion(4097, "11", { kind: "dismiss", reason: "one_at_a_time" });
    expect(server.replies().at(-1)).toEqual({
      id: 11,
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "Only one question can wait at a time; ask again after the first is answered.",
          },
        ],
        success: false,
      },
    });
    // A secret call is never answered as a question.
    server.push({ id: 10, method: "item/tool/call", params: { tool: "oncue_secret_request" } });
    expect(await client.replyQuestion(4097, "10", { kind: "dismiss", reason: "dismissed" })).toBe(
      false,
    );
  });
});
