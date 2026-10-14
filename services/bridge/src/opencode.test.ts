import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./normalize";
import {
  AGENT_HOME,
  createOpenCodeClient,
  OPENCODE_BINARY,
  OPENCODE_OUTPUT_TOKEN_MAX,
  OPENCODE_PORT,
  OPENCODE_RUNTIME,
  openCodeAutoCompactAt,
  opencodeConfig,
  plannedRuntimeSpawn,
  RELAY_PLACEHOLDER_API_KEY,
  SseDecoder,
} from "./opencode";
import { ALLOWED_ENV_KEYS, reviewRequest } from "./supervisor-protocol";

const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5" };

describe("plannedRuntimeSpawn", () => {
  const plan = plannedRuntimeSpawn({
    port: OPENCODE_PORT,
    relayPort: 5001,
    toolPort: 5002,
    model: MODEL,
    modelSpec: null,
  });

  it("names the pinned binary, the serve flags, the workspace, and the agent uid", () => {
    expect(plan.argv).toEqual([
      OPENCODE_BINARY,
      "serve",
      "--port",
      "4096",
      "--hostname",
      "127.0.0.1",
      "--log-level",
      "WARN",
      "--print-logs",
    ]);
    expect(plan.cwd).toBe("/workspace");
    expect(plan.uid).toBe(1001);
  });

  it("gives the agent exactly the allowlisted environment and nothing inherited", () => {
    expect(Object.keys(plan.env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "LANG",
        "TMPDIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
      ].sort(),
    );
    expect(plan.env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: AGENT_HOME,
      LANG: "C.UTF-8",
      TMPDIR: "/home/oncue-agent/.tmp",
      XDG_DATA_HOME: "/home/oncue-agent/.local/share",
      XDG_CONFIG_HOME: "/home/oncue-agent/.config",
      XDG_STATE_HOME: "/home/oncue-agent/.local/state",
      XDG_CACHE_HOME: "/home/oncue-agent/.cache",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
    for (const key of Object.keys(plan.env)) {
      expect(ALLOWED_ENV_KEYS).toContain(key);
    }
    expect(JSON.stringify(plan.env)).not.toMatch(/ANTHROPIC|GITHUB|ONCUE_|TOKEN|SECRET/);
  });

  it("is a request the supervisor's own review allows", () => {
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "allowed",
    });
  });

  it("carries the config document, and only the config, in OPENCODE_CONFIG_CONTENT", () => {
    expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT ?? "")).toEqual(
      opencodeConfig({
        workspace: "/workspace",
        relayPort: 5001,
        toolPort: 5002,
        model: MODEL,
        modelSpec: null,
        secretsDir: "/var/lib/oncue/secrets",
        attachmentsDir: "/var/lib/oncue/attachments",
      }),
    );
  });
});

describe("opencodeConfig", () => {
  it("is exactly this document", () => {
    expect(
      opencodeConfig({
        relayPort: 5001,
        toolPort: 5002,
        model: MODEL,
        modelSpec: null,
        secretsDir: "/var/lib/oncue/secrets",
        attachmentsDir: "/var/lib/oncue/attachments",
      }),
    ).toEqual({
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      model: "anthropic/claude-sonnet-5",
      provider: {
        anthropic: {
          options: { baseURL: "http://127.0.0.1:5001/v1", apiKey: RELAY_PLACEHOLDER_API_KEY },
        },
      },
      // OpenCode holds a call to OnCue's one secret tool, and each subagent
      // start, until the bridge answers.
      permission: {
        task: { "*": "deny", general: "ask", explore: "ask" },
        question: "deny",
        oncue_secret_request: "ask",
        external_directory: {
          "/var/lib/oncue/secrets/*": "allow",
          "/var/lib/oncue/attachments/*": "allow",
        },
      },
      // Only the agent a run prompts may ask the user; every other agent keeps the deny.
      agent: {
        build: { permission: { question: "allow" } },
        // No model of their own: a subagent runs the model its run was prompted with.
        general: { permission: { task: "deny", "oncue_*": "deny" } },
        explore: { permission: { task: "deny", "oncue_*": "deny" } },
      },
      subagent_depth: 1,
      // A denial fails the call and the model goes on, as the denial's words say.
      experimental: { continue_loop_on_deny: true },
      mcp: {
        oncue: { type: "remote", url: "http://127.0.0.1:5002/mcp", enabled: true, oauth: false },
      },
    });
  });

  it("points every provider the grant lists at the relay and declares each model the session may change to", () => {
    const spec = {
      name: "Any",
      contextWindow: 200_000,
      maxOutput: 64_000,
      effortLevels: null,
      imageInput: false,
    };
    const config = opencodeConfig({
      relayPort: 5001,
      toolPort: 5002,
      model: MODEL,
      modelSpec: spec,
      catalog: [
        // The model it starts on is listed once, not twice.
        { ...MODEL, spec },
        { provider: "anthropic", modelId: "claude-opus-5-5", spec },
        { provider: "openai", modelId: "gpt-6-sol", spec },
        // A provider OpenCode cannot drive through the relay is left out.
        { provider: "elsewhere", modelId: "other-1", spec },
      ],
      secretsDir: "/s",
      attachmentsDir: "/a",
    });
    const relay = { baseURL: "http://127.0.0.1:5001/v1", apiKey: RELAY_PLACEHOLDER_API_KEY };
    const provider = config.provider as Record<
      string,
      { options: unknown; models: Record<string, unknown> }
    >;
    expect(Object.keys(provider).sort()).toEqual(["anthropic", "openai"]);
    expect(provider.anthropic?.options).toEqual(relay);
    expect(provider.openai?.options).toEqual(relay);
    expect(Object.keys(provider.anthropic?.models ?? {})).toEqual([
      MODEL.modelId,
      "claude-opus-5-5",
    ]);
    expect(Object.keys(provider.openai?.models ?? {})).toEqual(["gpt-6-sol"]);
    // The model a prompt that names none would run stays the one it starts on.
    expect(config.model).toBe(`${MODEL.provider}/${MODEL.modelId}`);
  });

  it("names the work tree's own instruction files, since the repository's configuration is ignored", () => {
    const config = opencodeConfig({
      workspace: "/workspace",
      relayPort: 5001,
      toolPort: 5002,
      model: MODEL,
      modelSpec: null,
      secretsDir: "/var/lib/oncue/secrets",
      attachmentsDir: "/var/lib/oncue/attachments",
    });
    expect(config.instructions).toEqual(["/workspace/AGENTS.md", "/workspace/CLAUDE.md"]);
  });

  it("declares a catalog model with its limits and one variant per effort level, in the client's own option", () => {
    const spec = {
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      effortLevels: ["low", "medium", "high", "xhigh", "max"] as const,
      imageInput: true,
    };
    const anthropic = opencodeConfig({
      relayPort: 1,
      toolPort: 2,
      model: { provider: "anthropic", modelId: "claude-opus-5-5" },
      modelSpec: { ...spec, effortLevels: [...spec.effortLevels] },
      secretsDir: "/s",
      attachmentsDir: "/a",
    });
    expect(
      (anthropic.provider as Record<string, Record<string, unknown>>).anthropic?.models,
    ).toEqual({
      "claude-opus-5-5": {
        name: "Claude Opus 5.5",
        limit: { context: 1_000_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        variants: {
          low: { effort: "low" },
          medium: { effort: "medium" },
          high: { effort: "high" },
          xhigh: { effort: "xhigh" },
          max: { effort: "max" },
        },
      },
    });
    const openai = opencodeConfig({
      relayPort: 1,
      toolPort: 2,
      model: { provider: "openai", modelId: "gpt-6-sol" },
      modelSpec: {
        name: "GPT-6 Sol",
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        effortLevels: ["none", "low"],
        imageInput: true,
      },
      secretsDir: "/s",
      attachmentsDir: "/a",
    });
    expect((openai.provider as Record<string, Record<string, unknown>>).openai?.models).toEqual({
      "gpt-6-sol": {
        name: "GPT-6 Sol",
        limit: { context: 1_050_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" } },
      },
    });
    // A model the catalog says reads no images is declared text-only, so
    // OpenCode never sends it one (no catalog row is like this today).
    const textOnly = opencodeConfig({
      relayPort: 1,
      toolPort: 2,
      model: { provider: "openai", modelId: "text-only-model" },
      modelSpec: {
        name: "Text only",
        contextWindow: 1_000,
        maxOutput: 100,
        effortLevels: null,
        imageInput: false,
      },
      secretsDir: "/s",
      attachmentsDir: "/a",
    });
    expect(
      (textOnly.provider as Record<string, Record<string, Record<string, unknown>>>).openai
        ?.models?.["text-only-model"],
    ).toMatchObject({ modalities: { input: ["text"], output: ["text"] } });
    // A model with no effort levels gets its limits and no variants.
    const haiku = opencodeConfig({
      relayPort: 1,
      toolPort: 2,
      model: { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
      modelSpec: {
        name: "Claude Haiku 4.5",
        contextWindow: 200_000,
        maxOutput: 64_000,
        effortLevels: null,
        imageInput: true,
      },
      secretsDir: "/s",
      attachmentsDir: "/a",
    });
    expect((haiku.provider as Record<string, Record<string, unknown>>).anthropic?.models).toEqual({
      "claude-haiku-4-5-20251001": {
        name: "Claude Haiku 4.5",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    });
  });

  it("never holds a real credential: the placeholder is what the relay drops", () => {
    expect(
      JSON.stringify(
        opencodeConfig({
          relayPort: 1,
          toolPort: 2,
          model: MODEL,
          modelSpec: null,
          secretsDir: "/s",
          attachmentsDir: "/a",
        }),
      ),
    ).not.toMatch(/sk-|ot1\./);
  });
});

describe("composer attachments: a model's image input is a key OpenCode reads", () => {
  it("names `modalities` with an `image` input in the pinned model config schema", () => {
    const doc = JSON.stringify(
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL("../fixtures/opencode-openapi-1.18.30.json", import.meta.url)),
          "utf8",
        ),
      ).components.schemas.ProviderConfig,
    );
    expect(doc).toContain('"modalities"');
    expect(doc).toContain('"image"');
  });
});

describe("record 12: subagents are OpenCode's two built-in ones, one level deep", () => {
  const config = opencodeConfig({
    relayPort: 5001,
    toolPort: 5002,
    model: MODEL,
    modelSpec: null,
    secretsDir: "/var/lib/oncue/secrets",
    attachmentsDir: "/var/lib/oncue/attachments",
  });

  it("asks for the built-in subagents, denies every other name, and allows no nesting", () => {
    expect((config.permission as Record<string, unknown>).task).toEqual({
      "*": "deny",
      general: "ask",
      explore: "ask",
    });
    expect(config.subagent_depth).toBe(1);
    // Asked of the bridge, never allowed outright: the bridge holds the limit.
    expect(JSON.stringify(config.permission)).not.toMatch(/"(general|explore)":"allow"/);
    const { build, ...agents } = config.agent as Record<
      string,
      { model?: string; permission: unknown }
    >;
    // The primary agent alone may ask the user; it names no model of its own.
    expect(build).toEqual({ permission: { question: "allow" } });
    expect(Object.keys(agents).sort()).toEqual(["explore", "general"]);
    for (const agent of Object.values(agents)) {
      // Unpinned, so it runs the model of the message that started it, which
      // is the run's also after the session changed model.
      expect(agent.model).toBeUndefined();
      // No nesting, and none of OnCue's own tools: those are the primary agent's.
      expect(agent.permission).toEqual({ task: "deny", "oncue_*": "deny" });
    }
  });

  it("the pinned OpenAPI document still names both keys, so a rename fails here before it fails in a sandbox", () => {
    const doc = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../fixtures/opencode-openapi-1.18.30.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      components: {
        schemas: {
          Config: { properties: Record<string, unknown> };
          PermissionConfig: { anyOf: { properties?: Record<string, unknown> }[] };
          PermissionActionConfig: { enum: string[] };
        };
      };
    };
    const schemas = doc.components.schemas;
    expect(
      (schemas.Config.properties.experimental as { properties: Record<string, unknown> }).properties
        .continue_loop_on_deny,
    ).toEqual({ type: "boolean" });
    expect(Object.keys(schemas.Config.properties)).toEqual(
      expect.arrayContaining([
        "permission",
        "subagent_depth",
        "agent",
        "share",
        "autoupdate",
        "snapshot",
        "model",
        "provider",
      ]),
    );
    const permissionObject = schemas.PermissionConfig.anyOf.find(
      (arm) => arm.properties !== undefined,
    );
    // `external_directory` is the gate in front of a read outside the project,
    // which the secrets directory needs allowed by path.
    expect(Object.keys(permissionObject?.properties ?? {})).toEqual(
      expect.arrayContaining(["task", "question", "external_directory"]),
    );
    expect(schemas.PermissionActionConfig.enum).toContain("deny");
    // The secret pause also relies on `ask` being an action, and on a key
    // OpenCode does not name itself (a tool-server tool's) being accepted
    // through `additionalProperties`.
    expect(schemas.PermissionActionConfig.enum).toContain("ask");
    expect(
      (permissionObject as { additionalProperties?: unknown } | undefined)?.additionalProperties,
    ).toBeDefined();
  });
});

describe("replyHeld", () => {
  function clientAnswering(respond: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createOpenCodeClient((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return respond();
    }) as typeof fetch);
    return { client, calls };
  }

  it("answers OpenCode's held request once, and carries a rejection's words to the model", async () => {
    const { client, calls } = clientAnswering(() => Response.json(true));

    expect(await client.replyHeld(4096, "per_1", "once", null)).toBe(true);
    expect(await client.replyHeld(4096, "per 2", "reject", "The user denied this.")).toBe(true);

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/permission/per_1/reply",
      "http://127.0.0.1:4096/permission/per%202/reply",
    ]);
    expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { reply: "once" },
      { reply: "reject", message: "The user denied this." },
    ]);
    // Never `always`: that would save a rule inside OpenCode.
    expect(JSON.stringify(calls)).not.toContain("always");
  });

  it("is false for a request that is already gone and for an OpenCode that is", async () => {
    expect(
      await clientAnswering(() => new Response("", { status: 404 })).client.replyHeld(
        4096,
        "per_1",
        "once",
        null,
      ),
    ).toBe(false);
    expect(
      await clientAnswering(() => {
        throw new Error("ECONNREFUSED");
      }).client.replyHeld(4096, "per_1", "reject", "x"),
    ).toBe(false);
  });
});

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  };
}

describe("createOpenCodeClient", () => {
  it("health: healthy with the version when /global/health says so", async () => {
    const { calls, fetch } = fakeFetch(() => Response.json({ healthy: true, version: "1.18.30" }));
    const client = createOpenCodeClient(fetch);
    await expect(client.health(4096)).resolves.toEqual({ kind: "healthy", version: "1.18.30" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/global/health");
  });

  it.each([
    ["a refused connection", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["a non-2xx answer", () => new Response("", { status: 503 })],
    ["a body that is not healthy", () => Response.json({ healthy: false })],
    ["a body that is not JSON", () => new Response("nope", { status: 200 })],
  ])("health: %s is not_yet, never a throw", async (_name, answer) => {
    const client = createOpenCodeClient(fakeFetch(answer).fetch);
    await expect(client.health(4096)).resolves.toMatchObject({ kind: "not_yet" });
  });

  it("prompt on a fresh run: creates a session, then prompt_async with the model and one text part", async () => {
    const { calls, fetch } = fakeFetch((call) =>
      call.url.endsWith("/session")
        ? Response.json({ id: "ses_new" })
        : new Response(null, { status: 204 }),
    );
    const client = createOpenCodeClient(fetch);
    await expect(
      client.prompt(4096, {
        conversation: null,
        title: "OnCue run run_1",
        text: "Do the thing",
        model: MODEL,
        effort: "medium",
      }),
    ).resolves.toEqual({
      kind: "held",
      conversation: "ses_new",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/session",
      "http://127.0.0.1:4096/session/ses_new/prompt_async",
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ title: "OnCue run run_1" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      // The run's effort names the model's variant of that level.
      variant: "medium",
      parts: [{ type: "text", text: "Do the thing" }],
    });
  });

  it("prompt with attachments puts each image after the text, as OpenCode's own file part", async () => {
    const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createOpenCodeClient(fetch);
    const image = {
      type: "file" as const,
      mime: "image/png",
      url: "file:///var/lib/oncue/attachments/m1/1-screen.png",
      filename: "screen.png",
    };
    await client.prompt(4096, {
      conversation: "ses_1",
      title: "t",
      text: "Look",
      model: MODEL,
      effort: null,
      files: [image],
    });
    expect(JSON.parse(String(calls[0]?.init?.body)).parts).toEqual([
      { type: "text", text: "Look" },
      image,
    ]);
  });

  it("prompt into an existing session skips the create", async () => {
    const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createOpenCodeClient(fetch);
    await expect(
      client.prompt(4096, {
        conversation: "ses_1",
        title: "t",
        text: "More",
        model: MODEL,
        effort: null,
      }),
    ).resolves.toEqual({
      kind: "held",
      conversation: "ses_1",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_1/prompt_async",
    ]);
  });

  it.each([
    [
      "the session create fails",
      () => new Response("", { status: 500 }),
      "opencode did not create a session",
    ],
    ["the create answers no id", () => Response.json({}), "opencode did not create a session"],
    [
      "opencode is unreachable",
      () => Promise.reject(new Error("ECONNREFUSED")),
      "opencode unreachable: ECONNREFUSED",
    ],
  ])("prompt is refused when %s", async (_name, answer, detail) => {
    const client = createOpenCodeClient(fakeFetch(answer).fetch);
    await expect(
      client.prompt(4096, {
        conversation: null,
        title: "t",
        text: "x",
        model: MODEL,
        effort: null,
      }),
    ).resolves.toEqual({
      kind: "refused",
      detail,
    });
  });

  it("prompt is refused when prompt_async answers an error", async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith("/session")
        ? Response.json({ id: "s" })
        : new Response("", { status: 404 }),
    );
    await expect(
      createOpenCodeClient(fetch).prompt(4096, {
        conversation: null,
        title: "t",
        text: "x",
        model: MODEL,
        effort: null,
      }),
    ).resolves.toEqual({
      kind: "refused",
      detail: "opencode answered 404 to prompt_async",
    });
  });

  it("abort posts to the session's abort route and reads the boolean", async () => {
    const { calls, fetch } = fakeFetch(() => Response.json(true));
    await expect(createOpenCodeClient(fetch).abort(4096, "ses_1")).resolves.toBe(true);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:4096/session/ses_1/abort",
      init: { method: "POST" },
    });
    await expect(
      createOpenCodeClient(fakeFetch(() => Response.json(false)).fetch).abort(4096, "s"),
    ).resolves.toBe(false);
    await expect(
      createOpenCodeClient(fakeFetch(() => Promise.reject(new Error("x"))).fetch).abort(4096, "s"),
    ).resolves.toBe(false);
  });

  it("subscribe reads the SSE stream, parses each event, and resolves when it ends", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"type":"session.idle","properties":{"sessionID":"s"}}\n'),
        );
        controller.enqueue(encoder.encode("\ndata: not json\n\n"));
        controller.close();
      },
    });
    const { calls, fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    const seen: RuntimeEvent[] = [];
    await createOpenCodeClient(fetch).subscribe(
      4096,
      (event) => seen.push(event),
      new AbortController().signal,
    );
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/event");
    expect(seen).toEqual([
      { kind: "server_connected" },
      { kind: "session_idle", sessionId: "s" },
      { kind: "unknown", wireKind: "", raw: "" },
    ]);
  });

  it("subscribe waits for the bridge's room before each read, leaving the stream unread meanwhile", async () => {
    let pull = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        const encoder = new TextEncoder();
        if (pull === 1) {
          controller.enqueue(
            encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
          );
          return;
        }
        controller.close();
      },
    });
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    const seen: RuntimeEvent[] = [];
    let release: () => void = () => {};
    let rooms = 0;
    const room = () => {
      rooms += 1;
      // The second read waits until the bridge has room again.
      return rooms === 2 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    };
    const done = createOpenCodeClient(fetch).subscribe(
      4096,
      (event) => seen.push(event),
      new AbortController().signal,
      () => {},
      room,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([{ kind: "server_connected" }]);
    expect(rooms).toBe(2);
    let ended = false;
    void done.then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Paused: the end of the stream is not even read until there is room.
    expect(ended).toBe(false);
    release();
    await done;
    expect(seen).toEqual([{ kind: "server_connected" }]);
  });

  it("subscribe resolves rather than throws when the stream cannot be opened", async () => {
    await expect(
      createOpenCodeClient(fakeFetch(() => Promise.reject(new Error("x"))).fetch).subscribe(
        4096,
        () => {},
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      createOpenCodeClient(fakeFetch(() => new Response("", { status: 500 })).fetch).subscribe(
        4096,
        () => {},
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("SseDecoder", () => {
  it("joins multi-line data, ignores other fields, and survives a chunk boundary inside a line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('event: message\nid: 1\ndata: {"a":\ndata: 1}\n')).toEqual([]);
    expect(decoder.push('\r\n: comment\ndata: {"b":2}\n\ndata: {"c"')).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(decoder.push(":3}\n\n")).toEqual([{ c: 3 }]);
  });
});

describe("replyQuestion", () => {
  function clientAnswering(respond: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createOpenCodeClient((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return respond();
    }) as typeof fetch);
    return { client, calls };
  }

  it("replies with one list per question, and rejects a dismissal with no body", async () => {
    const { client, calls } = clientAnswering(() => Response.json(true));
    expect(
      await client.replyQuestion(4096, "que_1", {
        kind: "answer",
        answers: [["Postgres"], ["Web", "my own"]],
      }),
    ).toBe(true);
    expect(
      await client.replyQuestion(4096, "que 2", { kind: "dismiss", reason: "dismissed" }),
    ).toBe(true);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["http://127.0.0.1:4096/question/que_1/reply", "POST"],
      ["http://127.0.0.1:4096/question/que%202/reject", "POST"],
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      answers: [["Postgres"], ["Web", "my own"]],
    });
    expect(calls[1]?.init?.body).toBeUndefined();
  });

  it("is false for a question already gone and for an OpenCode that is", async () => {
    expect(
      await clientAnswering(() => new Response("{}", { status: 404 })).client.replyQuestion(
        4096,
        "que_1",
        { kind: "dismiss", reason: "dismissed" },
      ),
    ).toBe(false);
    expect(
      await clientAnswering(() => {
        throw new Error("ECONNREFUSED");
      }).client.replyQuestion(4096, "que_1", { kind: "answer", answers: [] }),
    ).toBe(false);
  });
});

describe("pendingQuestions", () => {
  function clientListing(respond: () => Response | Promise<Response>) {
    const urls: string[] = [];
    const client = createOpenCodeClient((async (input: string | URL | Request) => {
      urls.push(String(input));
      return respond();
    }) as typeof fetch);
    return { client, urls };
  }

  it("lists the questions OpenCode is waiting on", async () => {
    const { client, urls } = clientListing(() =>
      Response.json([
        {
          id: "que_1",
          sessionID: "ses_1",
          questions: [{ question: "Which database?", header: "Database", options: [] }],
        },
      ]),
    );
    expect(await client.pendingQuestions?.(4096)).toMatchObject([
      { kind: "question_asked", requestId: "que_1", questions: [{ text: "Which database?" }] },
    ]);
    expect(urls).toEqual(["http://127.0.0.1:4096/question"]);
  });

  it("is empty for a refusal and for an OpenCode that is gone", async () => {
    expect(
      await clientListing(() => new Response("no", { status: 500 })).client.pendingQuestions?.(
        4096,
      ),
    ).toEqual([]);
    expect(
      await clientListing(() => {
        throw new Error("ECONNREFUSED");
      }).client.pendingQuestions?.(4096),
    ).toEqual([]);
  });
});

describe("OpenCode 1.18.30's own compaction point", () => {
  it("is the window less the output it reserves, at most OUTPUT_TOKEN_MAX", () => {
    // Sonnet 4.5: 200k window, 64k output, of which OpenCode reserves 32k.
    expect(openCodeAutoCompactAt({ contextWindow: 200_000, maxOutput: 64_000 })).toBe(168_000);
    expect(openCodeAutoCompactAt({ contextWindow: 200_000, maxOutput: 8_000 })).toBe(192_000);
    expect(openCodeAutoCompactAt({ contextWindow: 10_000, maxOutput: 64_000 })).toBe(0);
    expect(OPENCODE_OUTPUT_TOKEN_MAX).toBe(32_000);
    expect(OPENCODE_RUNTIME.autoCompactAt).toBe(openCodeAutoCompactAt);
  });

  it("rests on a config that sets no compaction and no input limit", () => {
    const config = JSON.stringify(
      opencodeConfig({
        relayPort: 1,
        toolPort: 2,
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
        modelSpec: {
          name: "Claude Sonnet 4.5",
          contextWindow: 200_000,
          maxOutput: 64_000,
          effortLevels: null,
          imageInput: true,
        },
        secretsDir: "/s",
        attachmentsDir: "/a",
      }),
    );
    expect(config).not.toContain("compaction");
    expect(config).toContain('"limit":{"context":200000,"output":64000}');
    expect(ALLOWED_ENV_KEYS).not.toContain("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX");
  });
});
