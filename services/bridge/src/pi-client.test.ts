import { describe, expect, it } from "vitest";
import type { LineChannel } from "./codex-client";
import type { RuntimeEvent } from "./normalize";
import { PI_HOLD_TITLE, PI_QUESTION_TITLE, PI_VERSION } from "./pi";
import { createPiClient, PI_SECRET_TOOL, piImages } from "./pi-client";
import type { PromptTurn } from "./runtime";

const STATE = {
  model: { id: "claude-sonnet-4-5-20250929", provider: "oncue" },
  isStreaming: false,
  sessionId: "abc123",
};

/** A fake Pi on the other end of the runtime host: it sees every line and answers each command as the test says. */
class FakePi {
  readonly sent: Array<Record<string, unknown>> = [];
  private lineHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  answers: Record<string, (command: Record<string, unknown>) => unknown> = {
    get_state: () => STATE,
    set_model: () => ({ id: "other" }),
    set_thinking_level: () => undefined,
    prompt: () => undefined,
    abort: () => undefined,
  };
  failures: Record<string, string> = {};

  readonly channel: LineChannel = {
    send: (line) => {
      const command = JSON.parse(line) as Record<string, unknown>;
      this.sent.push(command);
      const type = command.type as string;
      if (command.id === undefined) {
        return;
      }
      const failure = this.failures[type];
      if (failure !== undefined) {
        queueMicrotask(() =>
          this.push({
            id: command.id,
            type: "response",
            command: type,
            success: false,
            error: failure,
          }),
        );
        return;
      }
      const answer = this.answers[type];
      if (answer !== undefined) {
        queueMicrotask(() =>
          this.push({
            id: command.id,
            type: "response",
            command: type,
            success: true,
            data: answer(command),
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

  commands(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((command) => command.type === type);
  }
}

const TURN: PromptTurn = {
  conversation: null,
  title: "OnCue run run_1",
  text: "Fix it",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  effort: "none",
};

function setup(options: { readonly connect?: boolean; readonly timeoutMs?: number } = {}) {
  const pi = new FakePi();
  const files = new Map<string, Uint8Array>([["/att/a.png", new Uint8Array([1, 2, 3])]]);
  const client = createPiClient({
    connect: () => Promise.resolve(options.connect === false ? null : pi.channel),
    readFile: (path) => {
      const bytes = files.get(path);
      return bytes === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(bytes);
    },
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
    now: () => 5,
  });
  return { pi, client };
}

function collect(client: ReturnType<typeof createPiClient>): {
  readonly events: RuntimeEvent[];
  readonly ended: Promise<void>;
  readonly stop: () => void;
} {
  const events: RuntimeEvent[] = [];
  const controller = new AbortController();
  const ended = client.subscribe(4098, (event) => events.push(event), controller.signal);
  return { events, ended, stop: () => controller.abort() };
}

describe("health", () => {
  it("is healthy on the pinned version once the session's model is on OnCue's provider", async () => {
    const { pi, client } = setup();
    expect(await client.health(4098)).toEqual({ kind: "healthy", version: PI_VERSION });
    // A second check asks nothing.
    expect(await client.health(4098)).toEqual({ kind: "healthy", version: PI_VERSION });
    expect(pi.commands("get_state")).toHaveLength(1);
  });

  it("is not yet while nothing listens, while the extension has not loaded, or with no session", async () => {
    expect(await setup({ connect: false }).client.health(1)).toMatchObject({ kind: "not_yet" });
    const noExtension = setup();
    noExtension.pi.answers.get_state = () => ({
      ...STATE,
      model: { id: "x", provider: "anthropic" },
    });
    expect(await noExtension.client.health(1)).toMatchObject({
      kind: "not_yet",
      detail: expect.stringContaining("extension did not load"),
    });
    const noModel = setup();
    noModel.pi.answers.get_state = () => ({ sessionId: "s" });
    expect(await noModel.client.health(1)).toMatchObject({ kind: "not_yet" });
    const noSession = setup();
    noSession.pi.answers.get_state = () => ({ ...STATE, sessionId: undefined });
    expect(await noSession.client.health(1)).toEqual({
      kind: "not_yet",
      detail: "pi named no session",
    });
  });

  it("is not yet when get_state fails or goes unanswered", async () => {
    const failing = setup();
    failing.pi.failures.get_state = "boom";
    expect(await failing.client.health(1)).toEqual({ kind: "not_yet", detail: "boom" });
    const silent = setup({ timeoutMs: 5 });
    delete silent.pi.answers.get_state;
    expect(await silent.client.health(1)).toMatchObject({
      kind: "not_yet",
      detail: expect.stringContaining("no answer"),
    });
  });
});

describe("prompt", () => {
  it("sets the run's effort, sends the text, and holds the session's own id as the conversation", async () => {
    const { pi, client } = setup();
    expect(await client.prompt(4098, TURN)).toEqual({ kind: "held", conversation: "abc123" });
    expect(pi.commands("set_thinking_level")).toEqual([
      { id: expect.any(String), type: "set_thinking_level", level: "off" },
    ]);
    expect(pi.commands("prompt")).toEqual([
      { id: expect.any(String), type: "prompt", message: "Fix it" },
    ]);
    expect(pi.commands("set_model")).toEqual([]);
  });

  it("sends no effort when the run has none, and steers a second prompt into the busy session", async () => {
    const { pi, client } = setup();
    await client.prompt(4098, { ...TURN, effort: null });
    await client.prompt(4098, { ...TURN, effort: null, conversation: "abc123", text: "Also this" });
    expect(pi.commands("set_thinking_level")).toEqual([]);
    expect(pi.commands("prompt").map((command) => command.streamingBehavior)).toEqual([
      undefined,
      "steer",
    ]);
    // Once Pi settles, the next prompt is a prompt again.
    pi.push({ type: "agent_settled" });
    await client.prompt(4098, { ...TURN, effort: null, text: "Next" });
    expect(pi.commands("prompt")[2]?.streamingBehavior).toBeUndefined();
  });

  it("switches the model when the run names another one, and says so when Pi refuses it", async () => {
    const { pi, client } = setup();
    await client.prompt(4098, { ...TURN, model: { provider: "anthropic", modelId: "other" } });
    expect(pi.commands("set_model")).toEqual([
      { id: expect.any(String), type: "set_model", provider: "oncue", modelId: "other" },
    ]);
    const refusing = setup();
    refusing.pi.failures.set_model = "Model not found: oncue/elsewhere";
    expect(
      await refusing.client.prompt(4098, {
        ...TURN,
        model: { provider: "anthropic", modelId: "elsewhere" },
      }),
    ).toEqual({
      kind: "refused",
      detail: "pi refused the prompt: Model not found: oncue/elsewhere",
    });
  });

  it("passes the attached images Pi can read, and leaves out what it cannot", async () => {
    const { pi, client } = setup();
    await client.prompt(4098, {
      ...TURN,
      files: [
        { type: "file", mime: "image/png", url: "file:///att/a.png", filename: "a.png" },
        { type: "file", mime: "image/png", url: "file:///att/missing.png", filename: "m.png" },
        { type: "file", mime: "text/plain", url: "file:///att/a.txt", filename: "a.txt" },
        { type: "file", mime: "image/png", url: "https://elsewhere/a.png", filename: "b.png" },
      ],
    });
    expect(pi.commands("prompt")[0]?.images).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
  });

  it("is refused when Pi is not ready or refuses the prompt", async () => {
    expect(await setup({ connect: false }).client.prompt(1, TURN)).toMatchObject({
      kind: "refused",
      detail: expect.stringContaining("pi is not ready"),
    });
    const refusing = setup();
    refusing.pi.failures.prompt = "Agent is streaming";
    expect(await refusing.client.prompt(1, TURN)).toEqual({
      kind: "refused",
      detail: "pi refused the prompt: Agent is streaming",
    });
  });
});

describe("abort", () => {
  it("sends abort and reports whether Pi took it", async () => {
    const { pi, client } = setup();
    expect(await client.abort(4098, "abc123")).toBe(false);
    await client.health(4098);
    expect(await client.abort(4098, "abc123")).toBe(true);
    pi.failures.abort = "nothing to abort";
    expect(await client.abort(4098, "abc123")).toBe(false);
  });
});

describe("extension UI requests", () => {
  const hold = {
    type: "extension_ui_request",
    id: "uuid-1",
    method: "input",
    title: PI_HOLD_TITLE,
    placeholder: JSON.stringify({
      tool: PI_SECRET_TOOL,
      toolCallId: "call_sec",
      input: { name: "STRIPE_TEST_KEY" },
    }),
  };

  it("turns OnCue's hold into a permission and the held call's input, then answers only when told", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    const { events, stop } = collect(client);
    pi.push(hold);
    expect(events).toEqual([
      { kind: "server_connected" },
      {
        kind: "permission_asked",
        requestId: "uuid-1",
        permission: "oncue_secret_request",
        callId: "call_sec",
      },
      {
        kind: "tool_part",
        messageId: "call_sec",
        part: expect.objectContaining({
          callId: "call_sec",
          status: "running",
          input: { name: "STRIPE_TEST_KEY" },
        }),
      },
    ]);
    expect(pi.sent.filter((line) => line.type === "extension_ui_response")).toEqual([]);
    expect(await client.replyHeld(4098, "uuid-1", "reject", "The user denied this request.")).toBe(
      true,
    );
    expect(pi.sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "uuid-1",
      value: JSON.stringify({ reply: "reject", message: "The user denied this request." }),
    });
    // Answered once.
    expect(await client.replyHeld(4098, "uuid-1", "once", null)).toBe(false);
    stop();
  });

  it("answers a held call once with the bridge's word", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    pi.push(hold);
    expect(await client.replyHeld(4098, "uuid-1", "once", null)).toBe(true);
    expect(pi.sent.at(-1)?.value).toBe(JSON.stringify({ reply: "once", message: null }));
  });

  it("cancels every other dialog, and a hold it cannot read, and ignores a notification", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    const { events } = collect(client);
    pi.push({
      type: "extension_ui_request",
      id: "c1",
      method: "confirm",
      title: "Sure?",
      message: "",
    });
    pi.push({ ...hold, id: "c2", placeholder: "not json" });
    pi.push({ ...hold, id: "c3", placeholder: JSON.stringify({ tool: 1 }) });
    pi.push({ ...hold, id: "c4", placeholder: undefined });
    pi.push({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
    expect(pi.sent.filter((line) => line.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "c1", cancelled: true },
      { type: "extension_ui_response", id: "c2", cancelled: true },
      { type: "extension_ui_response", id: "c3", cancelled: true },
      { type: "extension_ui_response", id: "c4", cancelled: true },
    ]);
    expect(events.filter((event) => event.kind === "permission_asked")).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "homeless", wireKind: "extension_ui_request/notify" });
  });
});

describe("subscribe", () => {
  it("opens at once, delivers what arrived before it, then streams mapped events", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    pi.push({ type: "message_start", message: { role: "assistant" } });
    const { events, stop, ended } = collect(client);
    pi.push({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    });
    pi.push("garbage");
    pi.push({ id: "nobody", type: "response", command: "x", success: true });
    pi.push({ type: "response", command: "parse", success: false, error: "bad" });
    expect(events).toEqual([
      { kind: "server_connected" },
      { kind: "message_started", messageId: "pi-m1", role: "assistant" },
      { kind: "text_delta", messageId: "pi-m1", partId: "pi-m1-0", text: "Hi" },
      { kind: "unknown", wireKind: "garbled", raw: "garbage" },
    ]);
    stop();
    await ended;
  });

  it("ends when the runtime host closes, failing what was waiting, and starts over on the next check", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    const { ended } = collect(client);
    delete pi.answers.abort;
    const aborting = client.abort(4098, "abc123");
    pi.close();
    await ended;
    expect(await aborting).toBe(false);
    pi.push({ type: "agent_start" });
    expect(await client.health(4098)).toMatchObject({ kind: "healthy" });
    expect(pi.commands("get_state")).toHaveLength(2);
    // A close from a channel that is no longer current changes nothing.
    expect(await client.health(4098)).toMatchObject({ kind: "healthy" });
  });

  it("returns at once with no connection", async () => {
    const { client } = setup();
    await collect(client).ended;
  });
});

describe("piImages", () => {
  it("reads nothing for a turn with no files", async () => {
    expect(await piImages(TURN, () => Promise.reject(new Error("unused")))).toEqual([]);
  });
});

describe("the question dialog", () => {
  const input = {
    questions: [
      {
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "One file" },
        ],
      },
    ],
  };
  const ask = {
    type: "extension_ui_request",
    id: "q-1",
    method: "input",
    title: PI_QUESTION_TITLE,
    placeholder: JSON.stringify({ toolCallId: "call_q", input }),
  };

  it("becomes a question with its call's row, answered with the text the model reads", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    const { events, stop } = collect(client);
    pi.push(ask);
    expect(events.slice(1)).toEqual([
      {
        kind: "tool_part",
        messageId: "call_q",
        part: expect.objectContaining({ callId: "call_q", tool: "oncue_ask_user", input }),
      },
      {
        kind: "question_asked",
        requestId: "q-1",
        callId: "call_q",
        askedCount: 1,
        questions: [expect.objectContaining({ text: "Which database?", allowOther: true })],
      },
    ]);
    expect(pi.sent.filter((line) => line.type === "extension_ui_response")).toEqual([]);
    expect(await client.replyHeld(4098, "q-1", "once", null)).toBe(false);
    expect(
      await client.replyQuestion(4098, "q-1", { kind: "answer", answers: [["Postgres"]] }),
    ).toBe(true);
    expect(pi.sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q-1",
      value: JSON.stringify({
        answered: true,
        text: "The user answered:\n\nWhich database?\nAnswer: Postgres",
      }),
    });
    expect(await client.replyQuestion(4098, "q-1", { kind: "dismiss", reason: "dismissed" })).toBe(
      false,
    );
    stop();
  });

  it("says a dismissal, keeps the row out with no call id, and cancels a dialog it cannot read", async () => {
    const { pi, client } = setup();
    await client.health(4098);
    const { events } = collect(client);
    pi.push({ ...ask, placeholder: JSON.stringify({ input }) });
    expect(events.at(-1)).toMatchObject({ kind: "question_asked", callId: null });
    expect(events.filter((event) => event.kind === "tool_part")).toEqual([]);
    await client.replyQuestion(4098, "q-1", { kind: "dismiss", reason: "dismissed" });
    expect(pi.sent.at(-1)?.value).toBe(
      JSON.stringify({ answered: false, text: "The user dismissed the question." }),
    );
    pi.push({ ...ask, id: "q-4", placeholder: JSON.stringify({ input }) });
    await client.replyQuestion(4098, "q-4", { kind: "dismiss", reason: "no_run" });
    expect(pi.sent.at(-1)?.value).toBe(
      JSON.stringify({
        answered: false,
        text: "The question was not shown to the user because no run is active.",
      }),
    );
    pi.push({ ...ask, id: "q-2", placeholder: "not json" });
    pi.push({ ...ask, id: "q-3", placeholder: JSON.stringify({ input: { questions: [] } }) });
    expect(pi.sent.slice(-2)).toEqual([
      { type: "extension_ui_response", id: "q-2", cancelled: true },
      { type: "extension_ui_response", id: "q-3", cancelled: true },
    ]);
  });
});
