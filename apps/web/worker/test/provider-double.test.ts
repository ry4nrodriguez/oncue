// The provider double's Responses API tool calls, the wire Codex speaks: each
// mode calls the tool under the name the harness offered, only while the
// newest input is not already that tool's result.

import { describe, expect, it } from "vitest";
import {
  cachedUsage,
  createProviderDouble,
  EDIT_FILE_PATH,
  promptTokensOf,
  QUESTION_ECHO_PREFIX,
  questionMarker,
  REQUESTED_SECRET_NAME,
  responsesToolNames,
} from "./provider-double";

const URL = "https://api.openai.com/v1/responses";

function body(tools: string[], newest: string = "message"): string {
  return JSON.stringify({
    model: "gpt-6-sol",
    tools: tools.map((name) => ({ type: "function", name })),
    input: [{ type: "message" }, { type: newest }],
  });
}

async function frames(response: Response): Promise<string> {
  return await response.text();
}

describe("the provider double on the Responses API", () => {
  it.each([
    ["edit_file", ["exec_command", "oncue_git_commit"], "exec_command", EDIT_FILE_PATH],
    [
      "propose_push",
      ["exec_command", "oncue_policy_propose"],
      "oncue_policy_propose",
      "auto_after_verification",
    ],
    ["request_secret", ["oncue_secret_request"], "oncue_secret_request", REQUESTED_SECRET_NAME],
  ] as const)(
    "%s calls the offered tool, by the name it was offered under",
    async (mode, tools, name, needle) => {
      const double = createProviderDouble("openai", mode);
      const text = await frames(
        await double.fetchImpl(URL, { method: "POST", body: body([...tools]) }),
      );
      expect(text).toContain('"type":"function_call"');
      expect(text).toContain(`"name":"${name}"`);
      expect(text).toContain(needle);
      expect(text).toContain("response.completed");
    },
  );

  it("answers in text once the newest input is the tool's result, or when the tool is not offered", async () => {
    const double = createProviderDouble("openai", "edit_file");
    const after = await frames(
      await double.fetchImpl(URL, {
        method: "POST",
        body: body(["exec_command"], "function_call_output"),
      }),
    );
    expect(after).not.toContain("function_call");
    expect(after).toContain("response.output_text.delta");
    const unoffered = await frames(
      await double.fetchImpl(URL, { method: "POST", body: body(["view_image"]) }),
    );
    expect(unoffered).not.toContain('"type":"function_call"');
  });

  it("finds a tool Codex 0.157 offers in an additional_tools item or names in code mode's exec", async () => {
    const codeMode = JSON.stringify({
      model: "gpt-6-sol",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "custom",
                  name: "exec",
                  description:
                    "Run JavaScript that calls exec_command, apply_patch, oncue_git_commit.",
                },
                { type: "function", name: "oncue_secret_request" },
              ],
            },
          ],
        },
        { type: "message" },
      ],
    });
    for (const [mode, name] of [
      ["edit_file", "exec_command"],
      ["request_secret", "oncue_secret_request"],
    ] as const) {
      const text = await frames(
        await createProviderDouble("openai", mode).fetchImpl(URL, {
          method: "POST",
          body: codeMode,
        }),
      );
      expect(text).toContain(`"name":"${name}"`);
    }
    expect(
      responsesToolNames({
        input: [{ tools: [{ name: "exec", description: "calls exec_command, not Exec" }] }],
      }),
    ).toEqual(["exec", "exec_command"]);
  });

  it("ignores a body that is not JSON, and an Anthropic request, for these modes", async () => {
    const double = createProviderDouble("openai", "edit_file");
    const garbled = await frames(await double.fetchImpl(URL, { method: "POST", body: "not json" }));
    expect(garbled).not.toContain('"type":"function_call"');
    const bytes = await frames(
      await double.fetchImpl(URL, {
        method: "POST",
        body: new TextEncoder().encode(body(["exec_command"])),
      }),
    );
    expect(bytes).toContain('"type":"function_call"');
    const anthropic = createProviderDouble("anthropic", "ok");
    const text = await frames(
      await anthropic.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: body(["exec_command"]),
      }),
    );
    expect(text).not.toContain("function_call");
  });
});

describe("the provider double's ask_question mode", () => {
  const MESSAGES = "https://api.anthropic.com/v1/messages";
  const ask = (messages: unknown[], tools = ["question", "bash"]) =>
    JSON.stringify({ tools: tools.map((name) => ({ name })), messages });

  it("asks the set the task names through the runtime's question tool, once", async () => {
    const double = createProviderDouble("anthropic", "ask_question");
    const first = await frames(
      await double.fetchImpl(MESSAGES, {
        method: "POST",
        body: ask([{ role: "user", content: `Build it ${questionMarker("multi")}` }]),
      }),
    );
    expect(first).toContain('"name":"question"');
    expect(first).toContain("Which platforms should it ship on?");
    const plain = await frames(
      await double.fetchImpl(MESSAGES, {
        method: "POST",
        body: ask([{ role: "user", content: "Build it" }]),
      }),
    );
    expect(plain).toContain("Which database should the service use?");
    // No question tool offered (the title call): the ordinary stream.
    const title = await frames(
      await double.fetchImpl(MESSAGES, { method: "POST", body: ask([], []) }),
    );
    expect(title).toContain("chunk-0");
  });

  it("repeats the user's answer from the tool's result or a resumed run's message", async () => {
    const double = createProviderDouble("anthropic", "ask_question");
    const answered = await frames(
      await double.fetchImpl(MESSAGES, {
        method: "POST",
        body: ask([
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_double_question" }] },
          {
            role: "user",
            content: [{ type: "tool_result", content: [{ type: "text", text: "SQLite" }] }],
          },
        ]),
      }),
    );
    // The reply streams a word per delta.
    expect(answered).toContain(`"text":"${QUESTION_ECHO_PREFIX.split(" ")[0]} "`);
    expect(answered).toContain("SQLite");
    const resumed = await frames(
      await double.fetchImpl(MESSAGES, {
        method: "POST",
        body: ask([{ role: "user", content: "Answers to your questions: DuckDB" }]),
      }),
    );
    expect(resumed).toContain("DuckDB");
    // Asked already and nothing answered yet: the ordinary stream.
    const again = await frames(
      await double.fetchImpl(MESSAGES, {
        method: "POST",
        body: ask([
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_double_question" }] },
          { role: "user", content: [{ type: "text", text: "and?" }, 7, null] },
        ]),
      }),
    );
    expect(again).toContain("chunk-0");
  });
});

describe("the provider double's token counts", () => {
  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  function conversation(turns: number): string {
    return JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      system: [{ type: "text", text: "You are the agent. ".repeat(400) }],
      messages: Array.from({ length: turns }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index} `.repeat(50),
      })),
    });
  }

  it("writes a conversation's prefix to the cache once and reads it back on the next call, as Anthropic reports", async () => {
    const double = createProviderDouble("anthropic");
    const first = await (
      await double.fetchImpl(ANTHROPIC_URL, { method: "POST", body: conversation(1) })
    ).text();
    const second = await (
      await double.fetchImpl(ANTHROPIC_URL, { method: "POST", body: conversation(3) })
    ).text();
    const [one, two] = double.calls.map((call) => call.usage);
    expect(one).toEqual({
      input: 2,
      cacheRead: 0,
      cacheWrite: promptTokensOf(conversation(1)) - 2,
      output: 3,
    });
    expect(two?.cacheRead).toBe((one?.cacheWrite ?? 0) + (one?.cacheRead ?? 0));
    expect((two?.input ?? 0) + (two?.cacheRead ?? 0) + (two?.cacheWrite ?? 0)).toBe(
      promptTokensOf(conversation(3)),
    );
    // Anthropic counts the cache apart from `input_tokens`.
    expect(first).toContain(`"cache_creation_input_tokens":${one?.cacheWrite}`);
    expect(second).toContain(`"cache_read_input_tokens":${two?.cacheRead}`);
    expect(second).toContain(`"input_tokens":2,`);
  });

  it("keeps another conversation, such as a title request, out of the cache it reads", () => {
    const cache = new Map<string, number>();
    cachedUsage(cache, "anthropic", conversation(1), 3);
    const title = JSON.stringify({ system: "Write a title.", messages: [{ content: "x" }] });
    expect(cachedUsage(cache, "anthropic", title, 3).cacheRead).toBe(0);
    // A shorter request than the cached prefix cannot have read it.
    expect(cachedUsage(cache, "anthropic", "{}", 3)).toEqual({
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 3,
    });
    expect(
      cachedUsage(cache, "anthropic", "not json at all, and long enough".repeat(10), 1).input,
    ).toBe(2);
  });

  it("reads the cache back after the client moves its cache breakpoint to the newest message", () => {
    const cache = new Map<string, number>();
    const marked = (turns: number) => {
      const body = JSON.parse(conversation(turns)) as { messages: Record<string, unknown>[] };
      const last = body.messages.at(-1) as Record<string, unknown>;
      last.cache_control = { type: "ephemeral" };
      return JSON.stringify(body);
    };
    const first = cachedUsage(cache, "anthropic", marked(1), 3);
    expect(cachedUsage(cache, "anthropic", marked(3), 3).cacheRead).toBe(first.cacheWrite);
  });

  it("counts cached tokens inside the input, as OpenAI reports", async () => {
    const double = createProviderDouble("openai");
    const request = JSON.stringify({
      instructions: "Be brief. ".repeat(300),
      input: [{ type: "message" }],
    });
    await (await double.fetchImpl(URL, { method: "POST", body: request })).text();
    const answer = await (await double.fetchImpl(URL, { method: "POST", body: request })).text();
    const usage = double.calls[1]?.usage;
    expect(usage?.cacheRead).toBe(promptTokensOf(request) - 2);
    expect(usage?.cacheWrite).toBe(0);
    expect(answer).toContain(`"input_tokens":${promptTokensOf(request)}`);
    expect(answer).toContain(`"cached_tokens":${usage?.cacheRead}`);
  });
});
