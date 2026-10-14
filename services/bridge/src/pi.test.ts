import { RUNTIME_CATALOG } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  PI_CONFIG_ENV,
  PI_HOLD_TITLE,
  PI_PORT,
  PI_RUNTIME,
  PI_VERSION,
  piArgs,
  piBaseUrl,
  piConfig,
  piThinkingLevel,
  plannedPiSpawn,
} from "./pi";
import { parsePiOnCueDocument } from "./pi-extension";
import {
  AGENT_UID,
  ALLOWED_CWD,
  NODE_BINARY,
  PI_BINARY,
  PI_EXTENSION_PATH,
  RUNTIME_HOST_PATH,
  reviewRequest,
} from "./supervisor-protocol";
import { ONCUE_TOOL_DEFINITIONS, TOOL_SERVER_PATH } from "./tool-server";

const OPTIONS = {
  port: PI_PORT,
  relayPort: 5001,
  toolPort: 5002,
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  modelSpec: {
    name: "Sonnet 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    effortLevels: ["low", "medium", "high"],
    imageInput: true,
  },
} as const;

describe("piArgs", () => {
  const args = piArgs({ extensionPath: PI_EXTENSION_PATH, modelId: "m" });

  it("runs RPC mode with OnCue's extension and nothing a repository or home could add", () => {
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args[args.indexOf("--extension") + 1]).toBe(PI_EXTENSION_PATH);
    for (const flag of [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
    ]) {
      expect(args).toContain(flag);
    }
  });

  it("keeps the session in memory, stays offline, and starts on OnCue's provider and the run's model", () => {
    expect(args).toContain("--no-session");
    expect(args).toContain("--offline");
    expect(args[args.indexOf("--provider") + 1]).toBe("oncue");
    expect(args[args.indexOf("--model") + 1]).toBe("m");
    expect(args.join(" ")).not.toMatch(/api-key|sk-/);
  });
});

describe("piConfig", () => {
  it("points the provider at the relay with the placeholder, by the provider's own API", () => {
    const anthropic = piConfig(OPTIONS);
    expect(anthropic.provider).toEqual({
      id: "oncue",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:5001",
      apiKey: "oncue-relay",
    });
    const openai = piConfig({ ...OPTIONS, model: { provider: "openai", modelId: "gpt-6-sol" } });
    expect(openai.provider.api).toBe("openai-responses");
    expect(openai.provider.baseUrl).toBe("http://127.0.0.1:5001/v1");
    expect(piBaseUrl("openai", 9)).toBe("http://127.0.0.1:9/v1");
    // A provider OnCue does not route falls back to the Messages API, which the relay serves.
    expect(piConfig({ ...OPTIONS, model: { provider: "other", modelId: "x" } }).provider.api).toBe(
      "anthropic-messages",
    );
  });

  it("describes the model from the grant's catalog entry", () => {
    expect(piConfig(OPTIONS).model).toEqual({
      id: "claude-sonnet-4-5-20250929",
      name: "Sonnet 4.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    const noLevels = piConfig({
      ...OPTIONS,
      modelSpec: { ...OPTIONS.modelSpec, effortLevels: null, imageInput: false },
    });
    expect(noLevels.model).toMatchObject({ reasoning: false, input: ["text"] });
  });

  it("describes a model the catalog does not list conservatively: text only", () => {
    expect(piConfig({ ...OPTIONS, modelSpec: null }).model).toEqual({
      id: "claude-sonnet-4-5-20250929",
      name: "claude-sonnet-4-5-20250929",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  });

  it("names the tool server, every OnCue tool, and the one held call", () => {
    const config = piConfig(OPTIONS);
    expect(config.toolUrl).toBe(`http://127.0.0.1:5002${TOOL_SERVER_PATH}`);
    expect(config.tools.map((tool) => tool.name)).toEqual(
      ONCUE_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    expect(config.held).toEqual(["secret_request"]);
    expect(config.holdTitle).toBe(PI_HOLD_TITLE);
  });

  it("is a document the extension reads back whole", () => {
    const config = piConfig(OPTIONS);
    expect(parsePiOnCueDocument(JSON.stringify(config))).toEqual({
      provider: config.provider,
      model: config.model,
      toolUrl: config.toolUrl,
      toolPrefix: config.toolPrefix,
      tools: config.tools,
      held: config.held,
      holdTitle: config.holdTitle,
      question: config.question,
    });
  });

  it("reads a document with no question tool as having none", () => {
    const { question: _dropped, ...older } = piConfig(OPTIONS);
    expect(parsePiOnCueDocument(JSON.stringify(older))?.question).toBeNull();
  });
});

describe("plannedPiSpawn", () => {
  it("is exactly what the supervisor's pi row allows", () => {
    const plan = plannedPiSpawn(OPTIONS);
    expect(plan.argv.slice(0, 8)).toEqual([
      NODE_BINARY,
      RUNTIME_HOST_PATH,
      "--port",
      String(PI_PORT),
      "--",
      PI_BINARY,
      "--mode",
      "rpc",
    ]);
    expect(plan).toMatchObject({ runtime: "pi", cwd: ALLOWED_CWD, uid: AGENT_UID });
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "allowed",
    });
  });

  it("turns off Pi's own network use and carries the extension's document, and no credential", () => {
    const plan = plannedPiSpawn(OPTIONS);
    expect(Object.keys(plan.env).sort()).toEqual([
      "HOME",
      "LANG",
      "PATH",
      "PI_OFFLINE",
      "PI_ONCUE_CONFIG",
      "PI_SKIP_VERSION_CHECK",
      "PI_TELEMETRY",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    expect(plan.env).toMatchObject({
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    expect(JSON.parse(plan.env[PI_CONFIG_ENV] ?? "")).toEqual(piConfig(OPTIONS));
    expect(plan.env[PI_CONFIG_ENV]).not.toMatch(/sk-|ot1\./);
  });

  it("takes the dev host's command, Node, host, extension, home, and working directory", () => {
    const plan = plannedPiSpawn({
      ...OPTIONS,
      binary: "/dev/pi",
      hostPaths: { node: "/dev/node", host: "/dev/host.mjs" },
      extensionPath: "/dev/pi-extension.mjs",
      home: "/dev/home",
      cwd: "/dev/work",
    });
    expect(plan.argv.slice(0, 6)).toEqual([
      "/dev/node",
      "/dev/host.mjs",
      "--port",
      "4098",
      "--",
      "/dev/pi",
    ]);
    expect(plan.argv[plan.argv.indexOf("--extension") + 1]).toBe("/dev/pi-extension.mjs");
    expect(plan.env.HOME).toBe("/dev/home");
    expect(plan.cwd).toBe("/dev/work");
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "refused",
      denial: "binary_not_allowed",
    });
  });

  it("is refused a key its row does not list", () => {
    const plan = plannedPiSpawn(OPTIONS);
    expect(
      reviewRequest({
        op: "start_agent",
        requestId: "r",
        ...plan,
        env: { ...plan.env, ANTHROPIC_API_KEY: "sk-no" },
      }),
    ).toMatchObject({ kind: "refused", denial: "env_key_not_allowed" });
  });
});

describe("PI_RUNTIME", () => {
  it("is the catalog's Pi: both providers, the pinned version, images, and a held call", () => {
    expect(PI_VERSION).toBe(RUNTIME_CATALOG.pi.pinnedVersion);
    expect(PI_RUNTIME).toMatchObject({
      id: "pi",
      providers: ["anthropic", "openai"],
      defaultPort: PI_PORT,
      profile: {
        control: "stdio-json-rpc",
        toolDelivery: "extension",
        steerIsOnePrompt: true,
        holdsToolCalls: "permission_gate",
        images: true,
      },
    });
    expect(PI_RUNTIME.presentToolName("secret_request")).toBe("oncue_secret_request");
  });

  it("calls no effort off, and every other level by OnCue's own word", () => {
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("xhigh")).toBe("xhigh");
    expect(piThinkingLevel("low")).toBe("low");
  });

  it.each([
    ["bash", "shell"],
    ["read", "file_read"],
    ["edit", "file_write"],
    ["write", "file_write"],
    ["grep", "search"],
    ["find", "search"],
    ["ls", "search"],
    ["oncue_git_commit", "other"],
  ])("files %s under %s", (tool, category) => {
    expect(PI_RUNTIME.toolCategory(tool)).toBe(category);
  });
});
