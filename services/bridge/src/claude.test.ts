import { RUNTIME_CATALOG } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_PORT,
  CLAUDE_QUESTION_TOOL,
  CLAUDE_RUNTIME,
  CLAUDE_SECRET_TOOL,
  CLAUDE_VERSION,
  claudeArgs,
  plannedClaudeSpawn,
} from "./claude";
import {
  AGENT_UID,
  ALLOWED_CWD,
  CLAUDE_BINARY,
  NODE_BINARY,
  RUNTIME_HOST_PATH,
  reviewRequest,
} from "./supervisor-protocol";

const OPTIONS = {
  port: CLAUDE_PORT,
  relayPort: 5001,
  toolPort: 5002,
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  modelSpec: null,
} as const;

/** The value one flag was given. */
function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

describe("claudeArgs", () => {
  const args = claudeArgs({ modelId: "claude-sonnet-4-5-20250929", toolPort: 5002 });

  it("speaks stream-json both ways, streams partial messages, and runs the run's model", () => {
    expect(flag(args, "--input-format")).toBe("stream-json");
    expect(flag(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(flag(args, "--model")).toBe("claude-sonnet-4-5-20250929");
  });

  it("reads no settings file and connects OnCue's tool server alone", () => {
    expect(flag(args, "--setting-sources")).toBe("");
    expect(JSON.parse(flag(args, "--mcp-config") ?? "")).toEqual({
      mcpServers: { oncue: { type: "http", url: "http://127.0.0.1:5002/mcp" } },
    });
    expect(args).toContain("--strict-mcp-config");
  });

  it("sends its permission prompts to the bridge, and asks for secret_request alone of OnCue's tools", () => {
    expect(flag(args, "--permission-mode")).toBe("default");
    expect(flag(args, "--permission-prompt-tool")).toBe("stdio");
    const allowed = (flag(args, "--allowedTools") ?? "").split(",");
    expect(allowed).toEqual([...CLAUDE_ALLOWED_TOOLS]);
    expect(allowed).toContain("mcp__oncue__git_commit");
    expect(allowed).not.toContain(CLAUDE_SECRET_TOOL);
  });

  it("offers no subagent (record 12)", () => {
    const disallowed = (flag(args, "--disallowedTools") ?? "").split(",");
    expect(disallowed).toEqual([...CLAUDE_DISALLOWED_TOOLS]);
    for (const tool of ["Task", "Agent"]) {
      expect(disallowed).toContain(tool);
      expect(CLAUDE_ALLOWED_TOOLS).not.toContain(tool);
    }
  });

  it("offers its question tool, never pre-allowed, so every ask reaches the bridge", () => {
    const disallowed = (flag(args, "--disallowedTools") ?? "").split(",");
    expect(disallowed).not.toContain(CLAUDE_QUESTION_TOOL);
    expect(CLAUDE_ALLOWED_TOOLS).not.toContain(CLAUDE_QUESTION_TOOL);
    expect(flag(args, "--allowedTools")?.split(",")).not.toContain(CLAUDE_QUESTION_TOOL);
  });
});

describe("plannedClaudeSpawn", () => {
  it("is exactly what the supervisor's claude row allows", () => {
    const plan = plannedClaudeSpawn(OPTIONS);
    expect(plan.argv.slice(0, 6)).toEqual([
      NODE_BINARY,
      RUNTIME_HOST_PATH,
      "--port",
      String(CLAUDE_PORT),
      "--",
      CLAUDE_BINARY,
    ]);
    expect(plan).toMatchObject({ runtime: "claude", cwd: ALLOWED_CWD, uid: AGENT_UID });
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "allowed",
    });
  });

  it("points it at the relay with the placeholder, names no effort, and keeps its background on the run's model", () => {
    const plan = plannedClaudeSpawn(OPTIONS);
    expect(plan.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:5001",
      ANTHROPIC_AUTH_TOKEN: "oncue-relay",
      CLAUDE_CODE_EFFORT_LEVEL: "unset",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-4-5-20250929",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5-20250929",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CONFIG_DIR: "/home/oncue-agent/.claude",
    });
    expect(Object.keys(plan.env).filter((key) => /(TOKEN|KEY|SECRET|PASSWORD)$/.test(key))).toEqual(
      ["ANTHROPIC_AUTH_TOKEN"],
    );
  });

  it("is refused a real credential in the placeholder's place", () => {
    const plan = plannedClaudeSpawn(OPTIONS);
    expect(
      reviewRequest({
        op: "start_agent",
        requestId: "r",
        ...plan,
        env: { ...plan.env, ANTHROPIC_AUTH_TOKEN: "sk-ant-real" },
      }),
    ).toMatchObject({ kind: "refused", denial: "env_key_not_allowed" });
    expect(
      reviewRequest({
        op: "start_agent",
        requestId: "r",
        ...plan,
        env: { ...plan.env, ANTHROPIC_API_KEY: "oncue-relay" },
      }),
    ).toMatchObject({ kind: "refused", denial: "env_key_not_allowed" });
  });

  it("takes the dev host's binary, Node, host, home, and working directory", () => {
    const plan = plannedClaudeSpawn({
      ...OPTIONS,
      binary: "/dev/claude",
      hostPaths: { node: "/dev/node", host: "/dev/host.mjs" },
      home: "/dev/home",
      cwd: "/dev/work",
    });
    expect(plan.argv.slice(0, 6)).toEqual([
      "/dev/node",
      "/dev/host.mjs",
      "--port",
      "4099",
      "--",
      "/dev/claude",
    ]);
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe("/dev/home/.claude");
    expect(plan.cwd).toBe("/dev/work");
  });
});

describe("CLAUDE_RUNTIME", () => {
  it("is the catalog's Claude Code: Anthropic only, the pinned version, images, and a held call", () => {
    expect(CLAUDE_VERSION).toBe(RUNTIME_CATALOG.claude.pinnedVersion);
    expect(CLAUDE_RUNTIME).toMatchObject({
      id: "claude",
      providers: ["anthropic"],
      defaultPort: CLAUDE_PORT,
      profile: {
        control: "stdio-json-rpc",
        toolDelivery: "loopback-mcp",
        steerIsOnePrompt: true,
        holdsToolCalls: "permission_gate",
        images: true,
      },
    });
    expect(CLAUDE_RUNTIME.presentToolName("secret_request")).toBe(CLAUDE_SECRET_TOOL);
    expect(CLAUDE_SECRET_TOOL).toBe("mcp__oncue__secret_request");
  });

  it.each([
    ["Bash", "shell"],
    ["Read", "file_read"],
    ["Edit", "file_write"],
    ["MultiEdit", "file_write"],
    ["Write", "file_write"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["WebFetch", "web"],
    ["TodoWrite", "other"],
    ["mcp__oncue__git_commit", "other"],
  ])("files %s under %s", (tool, category) => {
    expect(CLAUDE_RUNTIME.toolCategory(tool)).toBe(category);
  });
});
