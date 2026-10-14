import { describe, expect, it } from "vitest";
import { piConfig } from "./pi";
import {
  forwardToolCall,
  holdDecision,
  installOnCueExtension,
  type PiExtensionApi,
  type PiToolCallContext,
  type PiToolCallEvent,
  type PiToolCallResult,
  type PiToolDefinition,
  parsePiOnCueDocument,
  questionResult,
} from "./pi-extension";

const CONFIG = piConfig({
  relayPort: 5001,
  toolPort: 5002,
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  modelSpec: {
    name: "Sonnet 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    effortLevels: ["low"],
    imageInput: false,
  },
});

/** What the extension registered, as Pi would hold it. */
class FakePi implements PiExtensionApi {
  readonly providers: Array<[string, Readonly<Record<string, unknown>>]> = [];
  readonly tools: PiToolDefinition[] = [];
  handler: ((event: PiToolCallEvent, ctx: PiToolCallContext) => Promise<PiToolCallResult>) | null =
    null;

  registerProvider(name: string, config: Readonly<Record<string, unknown>>): void {
    this.providers.push([name, config]);
  }
  registerTool(tool: PiToolDefinition): void {
    this.tools.push(tool);
  }
  on(
    _event: "tool_call",
    handler: (event: PiToolCallEvent, ctx: PiToolCallContext) => Promise<PiToolCallResult>,
  ): void {
    this.handler = handler;
  }
}

function toolServer(answer: (body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return Promise.resolve(new Response(JSON.stringify(answer(body))));
  };
  return { calls, fetch };
}

function install(answer: (body: Record<string, unknown>) => unknown = () => ({})) {
  const pi = new FakePi();
  const server = toolServer(answer);
  installOnCueExtension(pi, {
    config: JSON.stringify(CONFIG),
    schema: (json) => ({ wrapped: json }),
    fetch: server.fetch,
  });
  return { pi, server };
}

describe("installOnCueExtension", () => {
  it("registers the model as OnCue's provider, pointed at the relay with the placeholder", () => {
    const { pi } = install();
    expect(pi.providers).toEqual([
      [
        "oncue",
        {
          name: "OnCue relay",
          baseUrl: "http://127.0.0.1:5001",
          apiKey: "oncue-relay",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-sonnet-4-5-20250929",
              name: "Sonnet 4.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 64_000,
            },
          ],
        },
      ],
    ]);
  });

  it("registers OnCue's four tools and its question tool under the prefix, each schema taken as Pi's schema type", () => {
    const { pi } = install();
    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "oncue_policy_propose",
      "oncue_pull_request_describe",
      "oncue_git_commit",
      "oncue_secret_request",
      "oncue_ask_user",
    ]);
    expect(pi.tools[0]?.parameters).toEqual({ wrapped: CONFIG.tools[0]?.inputSchema });
    expect(pi.tools[0]?.label).toBe("policy_propose");
  });

  it("forwards a call to the tool server under OnCue's own name, and returns its text", async () => {
    const { pi, server } = install(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "Committed abc123." }] },
    }));
    const result = await pi.tools[2]?.execute("call_1", { message: "Fix it" }, undefined);
    expect(result).toEqual({
      content: [{ type: "text", text: "Committed abc123." }],
      details: undefined,
    });
    expect(server.calls).toEqual([
      {
        url: `http://127.0.0.1:5002/mcp`,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "git_commit", arguments: { message: "Fix it" } },
        },
      },
    ]);
  });

  it("makes the tool server's error answer the call's failure", async () => {
    const { pi } = install(() => ({
      result: { content: [{ type: "text", text: "Not committed." }], isError: true },
    }));
    await expect(pi.tools[2]?.execute("call_1", {}, undefined)).rejects.toThrow("Not committed.");
    const empty = install(() => ({ result: { isError: true } }));
    await expect(empty.pi.tools[0]?.execute("c", {}, undefined)).rejects.toThrow(
      "The tool failed.",
    );
  });

  it("holds secret_request until the bridge says once, and blocks anything else it says", async () => {
    const { pi } = install();
    const asked: Array<[string, string | undefined]> = [];
    const ctx = (answer: string | undefined): PiToolCallContext => ({
      hasUI: true,
      ui: {
        input: (title, placeholder) => {
          asked.push([title, placeholder]);
          return Promise.resolve(answer);
        },
      },
    });
    const event = {
      toolName: "oncue_secret_request",
      toolCallId: "call_sec",
      input: { name: "STRIPE_TEST_KEY" },
    };
    expect(await pi.handler?.(event, ctx(JSON.stringify({ reply: "once", message: null })))).toBe(
      undefined,
    );
    expect(asked[0]).toEqual([
      CONFIG.holdTitle,
      JSON.stringify({ tool: "oncue_secret_request", toolCallId: "call_sec", input: event.input }),
    ]);
    expect(
      await pi.handler?.(event, ctx(JSON.stringify({ reply: "reject", message: "Denied." }))),
    ).toEqual({ block: true, reason: "Denied." });
    expect(await pi.handler?.(event, ctx(undefined))).toEqual({
      block: true,
      reason: "Nobody answered this request.",
    });
    expect(await pi.handler?.(event, { ...ctx(undefined), hasUI: false })).toEqual({
      block: true,
      reason: "Nothing can answer this request here.",
    });
  });

  it("lets every other tool through without asking", async () => {
    const { pi } = install();
    const ctx: PiToolCallContext = {
      hasUI: true,
      ui: { input: () => Promise.reject(new Error("never asked")) },
    };
    expect(await pi.handler?.({ toolName: "bash", toolCallId: "c", input: {} }, ctx)).toBe(
      undefined,
    );
    expect(
      await pi.handler?.({ toolName: "oncue_git_commit", toolCallId: "c", input: {} }, ctx),
    ).toBe(undefined);
  });

  it("refuses to start without its document", () => {
    expect(() =>
      installOnCueExtension(new FakePi(), {
        config: undefined,
        schema: (json) => json,
        fetch: () => Promise.reject(new Error("unused")),
      }),
    ).toThrow("PI_ONCUE_CONFIG");
  });
});

describe("parsePiOnCueDocument", () => {
  it("reads what piConfig wrote, and nothing malformed", () => {
    expect(parsePiOnCueDocument(JSON.stringify(CONFIG))?.model.id).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(parsePiOnCueDocument(undefined)).toBeNull();
    expect(parsePiOnCueDocument("{")).toBeNull();
    expect(parsePiOnCueDocument(JSON.stringify({ ...CONFIG, version: 2 }))).toBeNull();
    expect(
      parsePiOnCueDocument(
        JSON.stringify({ ...CONFIG, provider: { ...CONFIG.provider, apiKey: "" } }),
      ),
    ).toBeNull();
    expect(
      parsePiOnCueDocument(
        JSON.stringify({ ...CONFIG, model: { ...CONFIG.model, maxTokens: "1" } }),
      ),
    ).toBeNull();
    expect(parsePiOnCueDocument(JSON.stringify({ ...CONFIG, held: "secret_request" }))).toBeNull();
  });

  it("keeps only the well-formed tools, inputs, and held names", () => {
    const parsed = parsePiOnCueDocument(
      JSON.stringify({
        ...CONFIG,
        model: { ...CONFIG.model, input: ["text", 7] },
        tools: [...CONFIG.tools, { name: "" }, "x", { name: "n", description: 1 }],
        held: ["secret_request", 3, ""],
      }),
    );
    expect(parsed?.tools).toHaveLength(4);
    expect(parsed?.model.input).toEqual(["text"]);
    expect(parsed?.held).toEqual(["secret_request"]);
  });
});

describe("forwardToolCall", () => {
  it("returns a JSON-RPC error's message as an error answer", async () => {
    const server = toolServer(() => ({ error: { code: -32602, message: "unknown tool" } }));
    expect(await forwardToolCall(server, "u", "t", {}, undefined)).toEqual({
      text: "unknown tool",
      isError: true,
    });
    const bare = toolServer(() => ({ error: {} }));
    expect(await forwardToolCall(bare, "u", "t", {}, undefined)).toEqual({
      text: "The tool failed.",
      isError: true,
    });
  });

  it("answers a failed request as an error rather than throwing, and passes the call's signal", async () => {
    const down = { fetch: () => Promise.reject(new Error("ECONNREFUSED")) };
    expect(await forwardToolCall(down, "u", "t", {}, undefined)).toMatchObject({ isError: true });
    let seen: AbortSignal | null | undefined;
    const signal = new AbortController().signal;
    await forwardToolCall(
      {
        fetch: (_url, init) => {
          seen = init.signal;
          return Promise.resolve(new Response('{"result":{"content":[{"type":"image"}]}}'));
        },
      },
      "u",
      "t",
      {},
      signal,
    );
    expect(seen).toBe(signal);
  });
});

describe("holdDecision", () => {
  it("allows only an explicit once, and gives a reason for everything else", () => {
    expect(holdDecision(JSON.stringify({ reply: "once" }))).toBeUndefined();
    expect(holdDecision(JSON.stringify({ reply: "reject" }))).toEqual({
      block: true,
      reason: "The user did not allow this.",
    });
    expect(holdDecision(JSON.stringify({ reply: "always" }))).toMatchObject({ block: true });
    expect(holdDecision("not json")).toMatchObject({ block: true });
  });
});

describe("the question tool", () => {
  function questionTool() {
    const { pi } = install();
    const tool = pi.tools.find((entry) => entry.name === "oncue_ask_user");
    if (tool === undefined) {
      throw new Error("no question tool");
    }
    return tool;
  }

  it("opens the question dialog with the call's questions and returns the bridge's text", async () => {
    const tool = questionTool();
    expect(tool.parameters).toEqual({ wrapped: CONFIG.question.inputSchema });
    const opened: Array<{ title: string; placeholder: string | undefined; signal: unknown }> = [];
    const controller = new AbortController();
    const result = await tool.execute("call_q", { questions: [] }, controller.signal, undefined, {
      hasUI: true,
      ui: {
        input: async (title, placeholder, options) => {
          opened.push({ title, placeholder, signal: options?.signal });
          return JSON.stringify({ answered: true, text: "The user answered: yes" });
        },
      },
    });
    expect(opened).toEqual([
      {
        title: "oncue.question",
        placeholder: JSON.stringify({ toolCallId: "call_q", input: { questions: [] } }),
        signal: controller.signal,
      },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: "The user answered: yes" }],
      details: undefined,
    });
  });

  it("fails the call when nothing can show it, and passes no signal it was not given", async () => {
    const tool = questionTool();
    await expect(tool.execute("c", {}, undefined)).rejects.toThrow(
      "Nothing can show the question here.",
    );
    await expect(
      tool.execute("c", {}, undefined, undefined, { hasUI: false, ui: { input: async () => "" } }),
    ).rejects.toThrow("Nothing can show the question here.");
    const seen: unknown[] = [];
    await expect(
      tool.execute("c", {}, undefined, undefined, {
        hasUI: true,
        ui: {
          input: async (_title, _placeholder, options) => {
            seen.push(options);
            return undefined;
          },
        },
      }),
    ).rejects.toThrow("Nobody answered the question.");
    expect(seen).toEqual([{}]);
  });

  it("is not registered from a document that has none", () => {
    const pi = new FakePi();
    const { question: _dropped, ...older } = CONFIG;
    installOnCueExtension(pi, {
      config: JSON.stringify(older),
      schema: (json) => ({ wrapped: json }),
      fetch: toolServer(() => ({})).fetch,
    });
    expect(pi.tools.map((tool) => tool.name)).not.toContain("oncue_ask_user");
  });
});

describe("questionResult", () => {
  it("returns an answer, and fails a dismissal or anything unreadable", () => {
    expect(questionResult(JSON.stringify({ answered: true, text: "ok" }))).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    });
    expect(questionResult(JSON.stringify({ answered: true }))).toEqual({
      content: [{ type: "text", text: "" }],
      details: undefined,
    });
    expect(() => questionResult(JSON.stringify({ answered: false, text: "Dismissed." }))).toThrow(
      "Dismissed.",
    );
    expect(() => questionResult(JSON.stringify(null))).toThrow("The user dismissed the question.");
    expect(() => questionResult(undefined)).toThrow("Nobody answered the question.");
  });
});
