import { PROMPT_COUNTS_HEADER as BRIDGE_HEADER, readPromptCounts } from "@oncue/bridge";
import { describe, expect, it } from "vitest";
import {
  type CountOutcome,
  type CountTokens,
  countPrompt,
  FAILURES_BEFORE_UNAVAILABLE,
  KEY_HEX_CHARS,
  MAX_REMEMBERED,
  ONCUE_TOOL_PREFIXES,
  PROMPT_COUNTS_HEADER,
  PromptCountCache,
  promptCountsHeader,
  promptKey,
  promptShapeOf,
  providerCounter,
  RATE_LIMIT_PAUSE_MS,
  RETRY_AFTER_FAILURE_MS,
  SESSION_PROMPTS_PER_WINDOW,
  SESSION_WINDOW_MS,
} from "./prompt-counts";

const SYSTEM = [{ type: "text", text: "You are the agent.", cache_control: { type: "ephemeral" } }];
const BASH = { name: "bash", description: "Run a command", input_schema: { type: "object" } };
const COMMIT = {
  name: "oncue_git_commit",
  description: "Commit",
  input_schema: { type: "object" },
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5-20250929",
    system: SYSTEM,
    tools: [BASH, { ...COMMIT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

/** A counter that answers from a table keyed by what the body holds, and records each body. */
function tableCounter(table: (body: Readonly<Record<string, unknown>>) => CountOutcome) {
  const seen: Readonly<Record<string, unknown>>[] = [];
  const count: CountTokens = async (counted) => {
    seen.push(counted);
    return table(counted);
  };
  return { count, seen };
}

/** 10 for the message frame, +100 for the system prompt, +1000 per harness tool, +50 per OnCue tool. */
function additive(counted: Readonly<Record<string, unknown>>): number {
  const tools = (counted.tools as { name: string }[] | undefined) ?? [];
  return (
    10 +
    (counted.system === undefined ? 0 : 100) +
    tools.reduce(
      (sum, tool) =>
        sum + (tool.name.startsWith("oncue_") || tool.name.startsWith("mcp__oncue__") ? 50 : 1000),
      0,
    )
  );
}

describe("promptShapeOf", () => {
  it("splits OnCue's tools from the harness's, without cache breakpoints", () => {
    const shape = promptShapeOf(body());
    expect(shape).toEqual({
      model: "claude-sonnet-4-5-20250929",
      system: [{ type: "text", text: "You are the agent." }],
      harnessTools: [BASH],
      oncueTools: [COMMIT],
    });
  });

  it("takes Claude Code's mcp__oncue__ names as OnCue's tools too", () => {
    const claude = { ...COMMIT, name: "mcp__oncue__git_commit" };
    const shape = promptShapeOf(body({ tools: [BASH, claude] }));
    expect(shape?.oncueTools).toEqual([claude]);
    expect(shape?.harnessTools).toEqual([BASH]);
    expect(ONCUE_TOOL_PREFIXES).toEqual(["oncue_", "mcp__oncue__"]);
  });

  it("is nothing for a call with no tools, such as a title request, or no model", () => {
    expect(promptShapeOf(body({ tools: [] }))).toBeNull();
    expect(promptShapeOf(body({ tools: undefined }))).toBeNull();
    expect(promptShapeOf(body({ model: 5 }))).toBeNull();
  });

  it("reads a tool with no name as the harness's, and a missing system prompt as none", () => {
    const shape = promptShapeOf(body({ system: undefined, tools: [{ input_schema: {} }, "odd"] }));
    expect(shape?.system).toBeNull();
    expect(shape?.harnessTools).toEqual([{ input_schema: {} }, "odd"]);
    expect(shape?.oncueTools).toEqual([]);
  });
});

describe("promptKey", () => {
  it("is stable when only a cache breakpoint moves, and changes with the prompt or the model", async () => {
    const plain = promptShapeOf(body({ tools: [BASH, COMMIT] }));
    const marked = promptShapeOf(body());
    if (plain === null || marked === null) {
      throw new Error("no shape");
    }
    expect(await promptKey(plain)).toBe(await promptKey(marked));
    expect(await promptKey(plain)).toMatch(/^[0-9a-f]{64}$/);
    expect(await promptKey({ ...plain, model: "other" })).not.toBe(await promptKey(plain));
    expect(await promptKey({ ...plain, system: "changed" })).not.toBe(await promptKey(plain));
  });
});

describe("countPrompt", () => {
  const shape = promptShapeOf(body());
  if (shape === null) {
    throw new Error("no shape");
  }

  it("counts cumulatively, so the parts are differences that add up to the whole prompt", async () => {
    const { count, seen } = tableCounter(additive);
    expect(await countPrompt(shape, count)).toEqual({
      systemTokens: 100,
      toolsTokens: 1000,
      oncueToolsTokens: 50,
    });
    expect(seen).toHaveLength(4);
    // Every count carries the one minimal message and the model, and no breakpoints.
    for (const counted of seen) {
      expect(counted.model).toBe("claude-sonnet-4-5-20250929");
      expect(counted.messages).toEqual([{ role: "user", content: "." }]);
      expect(JSON.stringify(counted)).not.toContain("cache_control");
    }
    expect(seen.map((counted) => (counted.tools as unknown[] | undefined)?.length ?? 0)).toEqual([
      0, 0, 1, 2,
    ]);
  });

  it("counts a body once when a part is empty", async () => {
    const { count, seen } = tableCounter(additive);
    expect(await countPrompt({ ...shape, system: null, oncueTools: [] }, count)).toEqual({
      systemTokens: 0,
      toolsTokens: 1000,
      oncueToolsTokens: 0,
    });
    expect(seen).toHaveLength(2);
    const onlyOncue = tableCounter(additive);
    expect(await countPrompt({ ...shape, harnessTools: [] }, onlyOncue.count)).toEqual({
      systemTokens: 100,
      toolsTokens: 0,
      oncueToolsTokens: 50,
    });
    expect(onlyOncue.seen).toHaveLength(3);
  });

  it("fails when any count fails or a part would count below nothing, and says when it was a rate limit", async () => {
    let calls = 0;
    const failing: CountTokens = async () => (++calls === 3 ? "failed" : 10);
    expect(await countPrompt(shape, failing)).toBe("failed");
    const shrinking = tableCounter((counted) => (counted.tools === undefined ? 500 : 100));
    expect(await countPrompt(shape, shrinking.count)).toBe("failed");
    let limited = 0;
    const rateLimited: CountTokens = async () => (++limited === 2 ? "rate_limited" : "failed");
    expect(await countPrompt(shape, rateLimited)).toBe("rate_limited");
  });
});

describe("PromptCountCache", () => {
  const counts = { systemTokens: 1, toolsTokens: 2, oncueToolsTokens: 3 };
  const scope = { sessionId: "s1", connectionId: "c1" };
  const at = (now: number) => () => now;

  it("counts a prompt once, then answers its counts", async () => {
    const cache = new PromptCountCache();
    expect(cache.decide("k", scope, 0)).toEqual({ kind: "status", status: "pending", start: true });
    // While counting, a second forward does not start another count.
    expect(cache.decide("k", scope, 0)).toEqual({
      kind: "status",
      status: "pending",
      start: false,
    });
    await cache.fill("k", scope, at(0), async () => counts);
    expect(cache.decide("k", scope, 0)).toEqual({ kind: "counts", counts });
    expect(cache.size).toBe(1);
  });

  it("says pending after one failure and unavailable after repeated ones, retrying after a pause", async () => {
    const cache = new PromptCountCache();
    cache.decide("k", scope, 0);
    await cache.fill("k", scope, at(1_000), async () => "failed");
    expect(cache.decide("k", scope, 1_000 + RETRY_AFTER_FAILURE_MS - 1)).toEqual({
      kind: "status",
      status: "pending",
      start: false,
    });
    expect(cache.decide("k", scope, 1_000 + RETRY_AFTER_FAILURE_MS)).toMatchObject({
      start: true,
    });
    await cache.fill("k", scope, at(2_000_000), async () => {
      throw new Error("boom");
    });
    expect(FAILURES_BEFORE_UNAVAILABLE).toBe(2);
    expect(cache.decide("k", scope, 2_000_001)).toEqual({
      kind: "status",
      status: "unavailable",
      start: false,
    });
    // A later retry still says unavailable while it counts.
    expect(cache.decide("k", scope, 2_000_000 + RETRY_AFTER_FAILURE_MS)).toEqual({
      kind: "status",
      status: "unavailable",
      start: true,
    });
  });

  it("pauses all counting for a connection after a rate limit, but not for another connection", async () => {
    const cache = new PromptCountCache();
    cache.decide("k", scope, 0);
    await cache.fill("k", scope, at(0), async () => "rate_limited");
    expect(cache.decide("other", scope, 1)).toEqual({
      kind: "status",
      status: "unavailable",
      start: false,
    });
    expect(cache.decide("other", { ...scope, connectionId: "c2" }, 1)).toMatchObject({
      start: true,
    });
    expect(cache.decide("third", scope, RATE_LIMIT_PAUSE_MS)).toMatchObject({ start: true });
  });

  it("counts at most a few distinct prompts per session in a window", () => {
    const cache = new PromptCountCache();
    for (let index = 0; index < SESSION_PROMPTS_PER_WINDOW; index += 1) {
      expect(cache.decide(`k${index}`, scope, index)).toMatchObject({ start: true });
    }
    expect(cache.decide("one-too-many", scope, 100)).toEqual({
      kind: "status",
      status: "unavailable",
      start: false,
    });
    // Another session has its own budget, and the window moves on.
    expect(cache.decide("one-too-many", { ...scope, sessionId: "s2" }, 100)).toMatchObject({
      start: true,
    });
    expect(cache.decide("later", scope, SESSION_WINDOW_MS)).toMatchObject({ start: true });
  });

  it("takes a count whose entry was forgotten while counting as a first failure", async () => {
    const cache = new PromptCountCache();
    await cache.fill("evicted", scope, at(0), async () => "failed");
    expect(cache.decide("evicted", scope, 1)).toEqual({
      kind: "status",
      status: "pending",
      start: false,
    });
  });

  it("forgets the least recently used prompt past its limit", async () => {
    const cache = new PromptCountCache();
    for (let index = 0; index <= MAX_REMEMBERED; index += 1) {
      const key = `k${index}`;
      const session = { ...scope, sessionId: `s${index}` };
      cache.decide(key, session, 0);
      await cache.fill(key, session, at(0), async () => counts);
    }
    expect(cache.size).toBe(MAX_REMEMBERED);
    expect(cache.decide("k0", { ...scope, sessionId: "fresh" }, 0)).toMatchObject({
      kind: "status",
    });
  });
});

describe("the header", () => {
  it("carries the key with the counts or a status, in a form the bridge's relay reads back", () => {
    const counts = { systemTokens: 9_402, toolsTokens: 14_000, oncueToolsTokens: 1_900 };
    const key = "0123456789abcdef".repeat(4);
    expect(PROMPT_COUNTS_HEADER).toBe(BRIDGE_HEADER);
    expect(readPromptCounts(promptCountsHeader(key, { kind: "counts", counts }))).toEqual({
      kind: "counts",
      key: key.slice(0, KEY_HEX_CHARS),
      counts,
    });
    expect(
      readPromptCounts(
        promptCountsHeader(key, { kind: "status", status: "unavailable", start: false }),
      ),
    ).toEqual({ kind: "status", key: key.slice(0, KEY_HEX_CHARS), status: "unavailable" });
  });
});

describe("providerCounter", () => {
  function counter(answer: () => Response | Promise<Response>) {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return answer();
    }) as typeof fetch;
    const count = providerCounter({
      fetchImpl,
      url: "https://provider.test/v1/messages/count_tokens",
      headers: new Headers({ "x-api-key": "k" }),
    });
    return { count, seen };
  }

  it("posts the body with the given headers and reads input_tokens", async () => {
    const { count, seen } = counter(() => Response.json({ input_tokens: 42 }));
    expect(await count({ model: "m" })).toBe(42);
    expect(seen[0]?.url).toBe("https://provider.test/v1/messages/count_tokens");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ model: "m" }));
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls a 429 a rate limit", async () => {
    expect(
      await counter(() => Response.json({ error: "rate" }, { status: 429 })).count({ model: "m" }),
    ).toBe("rate_limited");
  });

  it.each([
    ["a refusal", () => Response.json({ error: "bad" }, { status: 400 })],
    ["a non-integer", () => Response.json({ input_tokens: 4.5 })],
    ["a negative count", () => Response.json({ input_tokens: -1 })],
    ["no count", () => Response.json({})],
    ["a body that is not JSON", () => new Response("nope")],
    [
      "a network failure",
      () => {
        throw new Error("down");
      },
    ],
  ])("gives no count for %s", async (_name, answer) => {
    expect(await counter(answer).count({ model: "m" })).toBe("failed");
  });
});
