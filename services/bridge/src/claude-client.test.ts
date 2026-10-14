import { describe, expect, it } from "vitest";
import { CLAUDE_SECRET_TOOL, CLAUDE_VERSION } from "./claude";
import {
  CLAUDE_PENDING_SESSION,
  claudeContent,
  claudeQuestionAnswer,
  createClaudeClient,
} from "./claude-client";
import type { LineChannel } from "./codex-client";
import type { RuntimeEvent } from "./normalize";
import type { PromptTurn } from "./runtime";

/** A fake Claude Code on the other end of the runtime host: it answers each control request as the test says. */
class FakeClaude {
  readonly sent: Array<Record<string, unknown>> = [];
  private lineHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  answers: Record<string, (request: Record<string, unknown>) => Record<string, unknown>> = {
    initialize: () => ({ commands: [], models: [], account: {} }),
    get_binary_version: () => ({ version: "2.1.290" }),
    set_model: () => ({}),
    interrupt: () => ({}),
  };
  failures: Record<string, string> = {};

  readonly channel: LineChannel = {
    send: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      this.sent.push(message);
      if (message.type !== "control_request") {
        return;
      }
      const id = message.request_id as string;
      const request = message.request as Record<string, unknown>;
      const subtype = request.subtype as string;
      const failure = this.failures[subtype];
      if (failure !== undefined) {
        queueMicrotask(() =>
          this.push({
            type: "control_response",
            response: { subtype: "error", request_id: id, error: failure },
          }),
        );
        return;
      }
      const answer = this.answers[subtype];
      if (answer !== undefined) {
        queueMicrotask(() =>
          this.push({
            type: "control_response",
            response: { subtype: "success", request_id: id, response: answer(request) },
          }),
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

  controls(subtype: string): Array<Record<string, unknown>> {
    return this.sent.filter(
      (message) =>
        message.type === "control_request" &&
        (message.request as Record<string, unknown>).subtype === subtype,
    );
  }

  users(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === "user");
  }

  responses(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === "control_response");
  }
}

const TURN: PromptTurn = {
  conversation: null,
  title: "OnCue run run_1",
  text: "Fix it",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  effort: "high",
};

function setup(options: { readonly connect?: boolean; readonly timeoutMs?: number } = {}) {
  const claude = new FakeClaude();
  const client = createClaudeClient({
    connect: () => Promise.resolve(options.connect === false ? null : claude.channel),
    readFile: (path) =>
      path === "/att/a.png"
        ? Promise.resolve(new Uint8Array([1, 2, 3]))
        : Promise.reject(new Error("missing")),
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
    now: () => 5,
  });
  return { claude, client };
}

function collect(client: ReturnType<typeof createClaudeClient>) {
  const events: RuntimeEvent[] = [];
  const controller = new AbortController();
  const ended = client.subscribe(4099, (event) => events.push(event), controller.signal);
  return { events, ended, stop: () => controller.abort() };
}

describe("health", () => {
  it("initializes the control protocol once and reports the version the binary gives", async () => {
    const { claude, client } = setup();
    expect(await client.health(4099)).toEqual({ kind: "healthy", version: "2.1.290" });
    expect(await client.health(4099)).toEqual({ kind: "healthy", version: "2.1.290" });
    expect(claude.controls("initialize")).toHaveLength(1);
  });

  it("keeps the pinned version when the binary does not say, and takes system/init's later", async () => {
    const { claude, client } = setup();
    claude.failures.get_binary_version = "unknown subtype";
    expect(await client.health(4099)).toEqual({ kind: "healthy", version: CLAUDE_VERSION });
    claude.push({
      type: "system",
      subtype: "init",
      session_id: "s1",
      claude_code_version: "2.1.299",
    });
    expect(await client.health(4099)).toEqual({ kind: "healthy", version: "2.1.299" });
    const silent = setup();
    silent.claude.answers.get_binary_version = () => ({});
    expect(await silent.client.health(4099)).toEqual({ kind: "healthy", version: CLAUDE_VERSION });
  });

  it("is not yet while nothing listens, or while initialize fails or goes unanswered", async () => {
    expect(await setup({ connect: false }).client.health(1)).toMatchObject({ kind: "not_yet" });
    const failing = setup();
    failing.claude.failures.initialize = "not ready";
    expect(await failing.client.health(1)).toEqual({ kind: "not_yet", detail: "not ready" });
    const silent = setup({ timeoutMs: 5 });
    delete silent.claude.answers.initialize;
    expect(await silent.client.health(1)).toMatchObject({
      kind: "not_yet",
      detail: expect.stringContaining("no answer"),
    });
  });
});

describe("prompt", () => {
  it("writes the user's message and sends no effort, which the broker writes", async () => {
    const { claude, client } = setup();
    expect(await client.prompt(4099, TURN)).toEqual({
      kind: "held",
      conversation: CLAUDE_PENDING_SESSION,
    });
    expect(claude.users()).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Fix it" }] },
        parent_tool_use_id: null,
        session_id: "",
      },
    ]);
    expect(JSON.stringify(claude.sent)).not.toContain("effort");
    expect(claude.controls("set_model")).toEqual([]);
  });

  it("names Claude Code's own session once it said it, and keeps the one it was given before", async () => {
    const { claude, client } = setup();
    expect(await client.prompt(4099, { ...TURN, conversation: "earlier" })).toMatchObject({
      conversation: "earlier",
    });
    claude.push({ type: "system", subtype: "init", session_id: "s1" });
    expect(await client.prompt(4099, TURN)).toEqual({ kind: "held", conversation: "s1" });
    expect(claude.users()[1]?.session_id).toBe("s1");
  });

  it("switches the model when a later run names another, and says so when Claude Code refuses", async () => {
    const { claude, client } = setup();
    await client.prompt(4099, TURN);
    await client.prompt(4099, {
      ...TURN,
      model: { provider: "anthropic", modelId: "claude-opus-5-5" },
    });
    expect(claude.controls("set_model").map((message) => message.request)).toEqual([
      { subtype: "set_model", model: "claude-opus-5-5" },
    ]);
    claude.failures.set_model = "model not available";
    expect(
      await client.prompt(4099, { ...TURN, model: { provider: "anthropic", modelId: "other" } }),
    ).toEqual({ kind: "refused", detail: "claude refused the prompt: model not available" });
  });

  it("is refused when Claude Code is not ready", async () => {
    expect(await setup({ connect: false }).client.prompt(1, TURN)).toMatchObject({
      kind: "refused",
      detail: expect.stringContaining("claude is not ready"),
    });
  });
});

describe("claudeContent", () => {
  it("puts the attached images Claude Code can read after the text, and leaves out what it cannot", async () => {
    const content = await claudeContent(
      {
        ...TURN,
        files: [
          { type: "file", mime: "image/png", url: "file:///att/a.png", filename: "a.png" },
          { type: "file", mime: "image/png", url: "file:///att/missing.png", filename: "m.png" },
          { type: "file", mime: "text/plain", url: "file:///att/a.txt", filename: "a.txt" },
          { type: "file", mime: "image/png", url: "https://x/a.png", filename: "b.png" },
        ],
      },
      (path) =>
        path === "/att/a.png"
          ? Promise.resolve(new Uint8Array([1, 2, 3]))
          : Promise.reject(new Error("missing")),
    );
    expect(content).toEqual([
      { type: "text", text: "Fix it" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });
});

describe("abort", () => {
  it("interrupts, and reports whether Claude Code took it", async () => {
    const { claude, client } = setup();
    expect(await client.abort(4099, "s1")).toBe(false);
    await client.health(4099);
    expect(await client.abort(4099, "s1")).toBe(true);
    claude.failures.interrupt = "nothing running";
    expect(await client.abort(4099, "s1")).toBe(false);
  });
});

describe("permission prompts", () => {
  const ask = {
    type: "control_request",
    request_id: "perm-1",
    request: {
      subtype: "can_use_tool",
      tool_name: CLAUDE_SECRET_TOOL,
      input: { name: "STRIPE_TEST_KEY" },
      tool_use_id: "toolu_04",
    },
  };

  it("surfaces a can_use_tool as a permission and the call's input, and answers only when told", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    const { events, stop } = collect(client);
    claude.push(ask);
    expect(events).toEqual([
      { kind: "server_connected" },
      {
        kind: "permission_asked",
        requestId: "perm-1",
        permission: "mcp__oncue__secret_request",
        callId: "toolu_04",
        input: { name: "STRIPE_TEST_KEY" },
      },
      {
        kind: "tool_part",
        messageId: "toolu_04",
        part: expect.objectContaining({
          callId: "toolu_04",
          status: "running",
          input: { name: "STRIPE_TEST_KEY" },
        }),
      },
    ]);
    expect(claude.responses()).toEqual([]);
    expect(await client.replyHeld(4099, "perm-1", "once", null)).toBe(true);
    expect(claude.responses().at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "perm-1",
        response: { behavior: "allow", updatedInput: { name: "STRIPE_TEST_KEY" } },
      },
    });
    expect(await client.replyHeld(4099, "perm-1", "once", null)).toBe(false);
    stop();
  });

  it("denies with the reducer's words, or plain ones", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    claude.push(ask);
    await client.replyHeld(4099, "perm-1", "reject", "OnCue does not answer this kind of request.");
    expect(claude.responses().at(-1)?.response).toMatchObject({
      response: { behavior: "deny", message: "OnCue does not answer this kind of request." },
    });
    claude.push({ ...ask, request_id: "perm-2", request: { subtype: "can_use_tool" } });
    await client.replyHeld(4099, "perm-2", "reject", null);
    expect(claude.responses().at(-1)?.response).toMatchObject({
      request_id: "perm-2",
      response: { behavior: "deny", message: "The user did not allow this." },
    });
  });

  it("forgets an ask Claude Code withdrew, and refuses a request it does not serve", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    const { events } = collect(client);
    claude.push(ask);
    claude.push({ type: "control_cancel_request", request_id: "perm-1" });
    expect(await client.replyHeld(4099, "perm-1", "once", null)).toBe(false);
    claude.push({
      type: "control_request",
      request_id: "hook-1",
      request: { subtype: "hook_callback" },
    });
    expect(claude.responses()).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "hook-1",
          error: "OnCue does not serve hook_callback",
        },
      },
    ]);
    expect(events.slice(-2)).toEqual([
      { kind: "homeless", wireKind: "control_cancel_request" },
      { kind: "homeless", wireKind: "control_request/hook_callback" },
    ]);
  });
});

describe("subscribe", () => {
  it("opens at once, delivers what arrived before it, then streams mapped events", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    claude.push({
      type: "stream_event",
      event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 3 } } },
    });
    const { events, stop, ended } = collect(client);
    claude.push({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    });
    claude.push("garbage");
    claude.push({
      type: "control_response",
      response: { subtype: "success", request_id: "nobody" },
    });
    expect(events).toEqual([
      { kind: "server_connected" },
      { kind: "message_started", messageId: "m1", role: "assistant" },
      { kind: "text_delta", messageId: "m1", partId: "m1-0", text: "Hi" },
      { kind: "unknown", wireKind: "garbled", raw: "garbage" },
    ]);
    stop();
    await ended;
  });

  it("ends when the runtime host closes, failing what was waiting, and starts over on the next check", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    const { ended } = collect(client);
    delete claude.answers.interrupt;
    const aborting = client.abort(4099, "s1");
    claude.close();
    await ended;
    expect(await aborting).toBe(false);
    expect(await client.health(4099)).toMatchObject({ kind: "healthy" });
    expect(claude.controls("initialize")).toHaveLength(2);
  });

  it("returns at once with no connection", async () => {
    const { client } = setup();
    await collect(client).ended;
  });
});

describe("AskUserQuestion", () => {
  const questions = [
    {
      question: "Which database?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Relational" },
        { label: "SQLite", description: "One file" },
      ],
      multiSelect: false,
    },
    {
      question: "Which targets?",
      header: "Targets",
      options: [
        { label: "Web", description: "Browsers" },
        { label: "iOS", description: "Phones" },
      ],
      multiSelect: true,
    },
  ];
  const ask = {
    type: "control_request",
    request_id: "ask-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions },
      tool_use_id: "toolu_q",
    },
  };

  it("surfaces the ask as a question, with its call's row, and no permission", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    const { events, stop } = collect(client);
    claude.push(ask);
    expect(events.slice(1)).toEqual([
      {
        kind: "tool_part",
        messageId: "toolu_q",
        part: expect.objectContaining({ callId: "toolu_q", tool: "AskUserQuestion" }),
      },
      {
        kind: "question_asked",
        requestId: "ask-1",
        callId: "toolu_q",
        askedCount: 2,
        questions: [
          expect.objectContaining({ text: "Which database?", multiple: false, allowOther: true }),
          expect.objectContaining({ header: "Targets", multiple: true }),
        ],
      },
    ]);
    // A question is never answered through the permission path.
    expect(await client.replyHeld(4099, "ask-1", "once", null)).toBe(false);
    expect(claude.responses()).toEqual([]);
    stop();
  });

  it("answers with the original questions and each answer keyed by its text", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    claude.push(ask);
    expect(
      await client.replyQuestion(4099, "ask-1", {
        kind: "answer",
        answers: [["Postgres"], ["Web", "Android too"]],
      }),
    ).toBe(true);
    expect(claude.responses().at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "ask-1",
        response: {
          behavior: "allow",
          updatedInput: {
            questions,
            answers: { "Which database?": "Postgres", "Which targets?": "Web, Android too" },
          },
        },
      },
    });
    expect(
      await client.replyQuestion(4099, "ask-1", { kind: "dismiss", reason: "dismissed" }),
    ).toBe(false);
  });

  it("says a skipped question was skipped, and denies a dismissal in plain words", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    claude.push(ask);
    await client.replyQuestion(4099, "ask-1", { kind: "answer", answers: [[]] });
    expect(claude.responses().at(-1)?.response).toMatchObject({
      response: {
        updatedInput: {
          answers: { "Which database?": "(skipped)", "Which targets?": "(skipped)" },
        },
      },
    });
    claude.push({ ...ask, request_id: "ask-2" });
    await client.replyQuestion(4099, "ask-2", { kind: "dismiss", reason: "dismissed" });
    expect(claude.responses().at(-1)?.response).toMatchObject({
      request_id: "ask-2",
      response: { behavior: "deny", message: "The user dismissed the question." },
    });
    // A second ask in parallel is told why, not that the user dismissed it.
    claude.push({ ...ask, request_id: "ask-3" });
    await client.replyQuestion(4099, "ask-3", { kind: "dismiss", reason: "one_at_a_time" });
    expect(claude.responses().at(-1)?.response).toMatchObject({
      request_id: "ask-3",
      response: {
        behavior: "deny",
        message: "Only one question can wait at a time; ask again after the first is answered.",
      },
    });
  });

  it("denies an ask it cannot read, and forgets one Claude Code withdrew", async () => {
    const { claude, client } = setup();
    await client.health(4099);
    const { events } = collect(client);
    claude.push({
      ...ask,
      request_id: "ask-bad",
      request: { ...ask.request, input: { questions: "nope" } },
    });
    expect(claude.responses().at(-1)?.response).toMatchObject({
      request_id: "ask-bad",
      response: { behavior: "deny", message: "OnCue could not read the question." },
    });
    claude.push(ask);
    claude.push({ type: "control_cancel_request", request_id: "ask-1" });
    expect(events.at(-1)).toEqual({ kind: "question_settled", requestId: "ask-1" });
    expect(
      await client.replyQuestion(4099, "ask-1", { kind: "dismiss", reason: "dismissed" }),
    ).toBe(false);
  });

  it("skips a question whose text it cannot key an answer by", () => {
    expect(
      claudeQuestionAnswer({ questions: [{ header: "No text" }, { question: "Yes?" }] }, [
        ["a"],
        ["b"],
      ]),
    ).toEqual({
      questions: [{ header: "No text" }, { question: "Yes?" }],
      answers: { "Yes?": "b" },
    });
    expect(claudeQuestionAnswer({}, [])).toEqual({ questions: [], answers: {} });
  });
});
