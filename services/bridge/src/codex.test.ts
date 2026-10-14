import { RUNTIME_CATALOG } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  CODEX_DISABLED_FEATURES,
  CODEX_PATH_DIR,
  CODEX_PORT,
  CODEX_RUNTIME,
  CODEX_VERSION,
  codexConfigArgs,
  plannedCodexSpawn,
} from "./codex";
import {
  AGENT_UID,
  ALLOWED_CWD,
  CODEX_BINARY,
  NODE_BINARY,
  RUNTIME_HOST_PATH,
  reviewRequest,
} from "./supervisor-protocol";

const OPTIONS = {
  port: CODEX_PORT,
  relayPort: 5001,
  toolPort: 5002,
  model: { provider: "openai", modelId: "gpt-6-sol" },
  modelSpec: null,
} as const;

/** The value one `-c` key was given, or undefined. */
function configValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    const entry = args[index + 1] as string;
    if (args[index] === "-c" && entry.startsWith(`${key}=`)) {
      return entry.slice(key.length + 1);
    }
  }
  return undefined;
}

describe("codexConfigArgs", () => {
  const args = codexConfigArgs({
    relayPort: 5001,
    modelId: "gpt-6-sol",
    effort: null,
    contextWindow: null,
  });

  it("sends every model request to the relay as the Responses API, with no login and no key", () => {
    expect(configValue(args, "model_provider")).toBe('"oncue"');
    expect(configValue(args, "model_providers.oncue")).toBe(
      '{ name = "OnCue relay", base_url = "http://127.0.0.1:5001/v1", wire_api = "responses", requires_openai_auth = false }',
    );
    expect(configValue(args, "model")).toBe('"gpt-6-sol"');
    expect(args.join(" ")).not.toMatch(/api_key|env_key|sk-/);
  });

  it("runs no sandbox and asks no approvals of its own, and phones nobody", () => {
    expect(configValue(args, "sandbox_mode")).toBe('"danger-full-access"');
    expect(configValue(args, "approval_policy")).toBe('"never"');
    expect(configValue(args, "analytics.enabled")).toBe("false");
    expect(configValue(args, "feedback.enabled")).toBe("false");
    expect(configValue(args, "check_for_update_on_startup")).toBe("false");
  });

  it("turns subagents off (record 12) and every feature that reaches beyond the sandbox", () => {
    const disabled = args.flatMap((arg, index) => (arg === "--disable" ? [args[index + 1]] : []));
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    expect(disabled).toContain("multi_agent");
    // What removes the subagent tools on 0.157.1 (`codex-local.test.ts` checks the request).
    expect(configValue(args, "agents.enabled")).toBe("false");
  });

  it("names an effort and a context window only when there is one", () => {
    expect(configValue(args, "model_reasoning_effort")).toBeUndefined();
    expect(configValue(args, "model_context_window")).toBeUndefined();
    const withBoth = codexConfigArgs({
      relayPort: 1,
      modelId: "m",
      effort: "high",
      contextWindow: 400_000,
    });
    expect(configValue(withBoth, "model_reasoning_effort")).toBe('"high"');
    expect(configValue(withBoth, "model_context_window")).toBe("400000");
  });
});

describe("plannedCodexSpawn", () => {
  it("is exactly what the supervisor's codex row allows", () => {
    const plan = plannedCodexSpawn(OPTIONS);
    expect(plan.argv.slice(0, 7)).toEqual([
      NODE_BINARY,
      RUNTIME_HOST_PATH,
      "--port",
      String(CODEX_PORT),
      "--",
      CODEX_BINARY,
      "app-server",
    ]);
    expect(plan).toMatchObject({ runtime: "codex", cwd: ALLOWED_CWD, uid: AGENT_UID });
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "allowed",
    });
  });

  it("gives Codex its own home under the agent's, its helpers on PATH, and no credential", () => {
    const plan = plannedCodexSpawn(OPTIONS);
    expect(Object.keys(plan.env).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    expect(plan.env.CODEX_HOME).toBe("/home/oncue-agent/.codex");
    expect(plan.env.PATH?.startsWith(`${CODEX_PATH_DIR}:`)).toBe(true);
  });

  it("takes the dev host's binary, Node, host, home, and the catalog's context window", () => {
    const plan = plannedCodexSpawn({
      ...OPTIONS,
      binary: "/dev/codex",
      hostPaths: { node: "/dev/node", host: "/dev/host.mjs" },
      home: "/dev/home",
      cwd: "/dev/work",
      pathPrefix: "/dev/bin",
      modelSpec: {
        name: "Sol",
        contextWindow: 400_000,
        maxOutput: 128_000,
        effortLevels: null,
        imageInput: true,
      },
    });
    expect(plan.argv.slice(0, 6)).toEqual([
      "/dev/node",
      "/dev/host.mjs",
      "--port",
      "4097",
      "--",
      "/dev/codex",
    ]);
    expect(plan.env.PATH?.startsWith("/dev/bin:")).toBe(true);
    expect(plan.cwd).toBe("/dev/work");
    expect(configValue(plan.argv, "model_context_window")).toBe("400000");
    // A binary other than the image's is the dev host's, and the real supervisor refuses it.
    expect(reviewRequest({ op: "start_agent", requestId: "r", ...plan })).toMatchObject({
      kind: "refused",
      denial: "binary_not_allowed",
    });
  });
});

describe("CODEX_RUNTIME", () => {
  it("is the catalog's Codex: OpenAI only, the pinned version, images, and a held call", () => {
    expect(CODEX_VERSION).toBe(RUNTIME_CATALOG.codex.pinnedVersion);
    expect(CODEX_RUNTIME).toMatchObject({
      id: "codex",
      providers: ["openai"],
      defaultPort: CODEX_PORT,
      profile: {
        control: "stdio-json-rpc",
        toolDelivery: "rpc-dynamic",
        steerIsOnePrompt: true,
        holdsToolCalls: "permission_gate",
        images: true,
      },
    });
    expect(CODEX_RUNTIME.presentToolName("secret_request")).toBe("oncue_secret_request");
  });

  it.each([
    ["exec_command", "shell"],
    ["write_stdin", "shell"],
    ["apply_patch", "file_write"],
    ["view_image", "file_read"],
    ["web_search", "web"],
    ["oncue_git_commit", "other"],
  ])("files %s under %s", (tool, category) => {
    expect(CODEX_RUNTIME.toolCategory(tool)).toBe(category);
  });
});
