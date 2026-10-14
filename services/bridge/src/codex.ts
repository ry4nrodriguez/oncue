/**
 * The Codex adapter's pure half: how the supervisor starts Codex's app-server
 * under the runtime host. The configuration is `-c key=value` arguments, so
 * nothing is written into the agent's home and the supervisor reviews all of
 * it as argv. It makes Codex:
 *
 * - send every model request to the loopback relay as the Responses API with
 *   no login and no key, so Codex holds no credential;
 * - run commands with no sandbox or approvals of its own: the Modal sandbox
 *   and the Unix-user boundary are the sandbox, and bubblewrap may not start
 *   under gVisor;
 * - start no subagents (record 12) and none of the desktop features that
 *   reach beyond the sandbox;
 * - send no analytics and never check for an update.
 *
 * Every key was accepted by the pinned Codex 0.157.1 (macOS build). On
 * 0.157.1 `--disable multi_agent` alone no longer removes the subagent tools;
 * `agents.enabled = false` does. The Linux build is not yet exercised.
 */

import { RUNTIME_CATALOG } from "@oncue/protocol";
import type { SpawnRequest } from "./agent";
import { classifyOtherAsk } from "./ask-category";
import { AGENT_HOME, agentTmpDir, WORKSPACE } from "./opencode";
import type { RuntimePlan, RuntimeSpawnOptions, ToolCategory } from "./runtime";
import { AGENT_UID, CODEX_BINARY, hostedArgvPrefix } from "./supervisor-protocol";

export const CODEX_VERSION = RUNTIME_CATALOG.codex.pinnedVersion;
/** Where the runtime host serves Codex's stdio in the sandbox. */
export const CODEX_PORT = 4097;
/** Beside the binary in the image: ripgrep and the helpers Codex looks for on its PATH. */
export const CODEX_PATH_DIR = "/opt/codex/codex-path";
/** The name the relay's model provider is given inside Codex. */
export const CODEX_PROVIDER_ID = "oncue";

/** Desktop features that reach beyond the sandbox, and subagents. Accepted by 0.157.1. */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  "multi_agent",
  "goals",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "computer_use",
  "image_generation",
  "realtime_conversation",
  "tool_suggest",
  "hooks",
  "memories",
];

/** A TOML string, quoted, for a `-c` value. */
function toml(value: string): string {
  return JSON.stringify(value);
}

/** The `-c` and `--disable` arguments, as a value a test reads key by key. */
export function codexConfigArgs(options: {
  readonly relayPort: number;
  readonly modelId: string;
  readonly effort: string | null;
  readonly contextWindow: number | null;
}): readonly string[] {
  const config: string[] = [
    `model_provider=${toml(CODEX_PROVIDER_ID)}`,
    `model_providers.${CODEX_PROVIDER_ID}={ name = "OnCue relay", base_url = ${toml(
      `http://127.0.0.1:${options.relayPort}/v1`,
    )}, wire_api = "responses", requires_openai_auth = false }`,
    `model=${toml(options.modelId)}`,
    `approval_policy="never"`,
    // Record 12's one primary agent: on 0.157.1 this, not the feature flag, removes the subagent tools.
    "agents.enabled=false",
    `sandbox_mode="danger-full-access"`,
    "analytics.enabled=false",
    "feedback.enabled=false",
    "check_for_update_on_startup=false",
  ];
  if (options.effort !== null) {
    config.push(`model_reasoning_effort=${toml(options.effort)}`);
  }
  if (options.contextWindow !== null) {
    config.push(`model_context_window=${options.contextWindow}`);
  }
  return [
    ...config.flatMap((entry) => ["-c", entry]),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
}

/**
 * `node runtime-host.mjs --port N -- codex app-server <config>` as the agent
 * user in `/workspace`, with exactly this environment: no key, no `ONCUE_*`,
 * `CODEX_HOME` under the agent's own home. The supervisor's `codex` row
 * checks the argv's head and every key.
 */
export function plannedCodexSpawn(options: RuntimeSpawnOptions): SpawnRequest {
  const home = options.home ?? AGENT_HOME;
  return {
    runtime: "codex",
    argv: [
      ...hostedArgvPrefix(options.port, options.binary ?? CODEX_BINARY, options.hostPaths),
      "app-server",
      ...codexConfigArgs({
        relayPort: options.relayPort,
        modelId: options.model.modelId,
        // Each turn names the run's effort itself (`turn/start`'s `effort`).
        effort: null,
        contextWindow: options.modelSpec?.contextWindow ?? null,
      }),
    ],
    cwd: options.cwd ?? WORKSPACE,
    env: {
      PATH: `${options.pathPrefix ?? CODEX_PATH_DIR}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      LANG: "C.UTF-8",
      TMPDIR: agentTmpDir(home),
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      CODEX_HOME: `${home}/.codex`,
    },
    uid: AGENT_UID,
  };
}

/** Codex's own tool names -> protocol category. Unlisted is `other`. */
export const CODEX_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  exec_command: "shell",
  write_stdin: "shell",
  apply_patch: "file_write",
  view_image: "file_read",
  web_search: "web",
};

/** The prefix the model sees OnCue's tools under in Codex, as in OpenCode, so a tool list reads the same. */
export const CODEX_TOOL_PREFIX = "oncue_";

export const CODEX_RUNTIME: RuntimePlan = {
  id: "codex",
  pinnedVersion: CODEX_VERSION,
  providers: RUNTIME_CATALOG.codex.providers,
  defaultPort: CODEX_PORT,
  profile: {
    control: "stdio-json-rpc",
    toolDelivery: "rpc-dynamic",
    // `turn/steer` adds a message to the active turn.
    steerIsOnePrompt: true,
    // The bridge answers a dynamic tool call when it is ready, so it holds one itself.
    holdsToolCalls: "permission_gate",
    // `localImage` input.
    images: true,
    // Never run against another model than the one it started on.
    modelSwitch: "none",
  },
  planSpawn: plannedCodexSpawn,
  toolCategory: (tool) => CODEX_TOOL_CATEGORY[tool] ?? "other",
  presentToolName: (oncueName) => `${CODEX_TOOL_PREFIX}${oncueName}`,
  classifyAsk: classifyOtherAsk,
  rejectSettlesOtherAsks: false,
};
