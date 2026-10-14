/**
 * The Claude Code adapter's pure half: how the supervisor starts Claude Code
 * in stream-json mode under the runtime host, as the agent user. The bridge
 * speaks the stream-json protocol directly rather than depending on the Agent
 * SDK. The flags and environment make Claude Code:
 *
 * - send every model request to the loopback relay with the relay's
 *   placeholder as its token, so it holds no credential; name the run's model
 *   for background requests too, since the broker's token allows no other; and
 *   name no effort (`CLAUDE_CODE_EFFORT_LEVEL=unset`) so the broker writes the run's;
 * - read no settings, hooks, or memory files (`--setting-sources ""`) and
 *   connect no MCP server but OnCue's (`--strict-mcp-config`);
 * - start no subagent, ask the user only through `AskUserQuestion`, which
 *   reaches the bridge as a permission prompt and becomes the question card,
 *   and send every other permission prompt the allow list does not cover to
 *   the bridge;
 * - send no non-essential traffic and never update itself.
 *
 * Provisional: built from the Agent SDK 0.3.283 type declarations and Claude
 * Code's documented settings, not yet checked against a real run.
 */

import { RUNTIME_CATALOG } from "@oncue/protocol";
import type { SpawnRequest } from "./agent";
import { classifyClaudeAsk } from "./ask-category";
import { AGENT_HOME, agentTmpDir, RELAY_PLACEHOLDER_API_KEY, WORKSPACE } from "./opencode";
import type { RuntimePlan, RuntimeSpawnOptions, ToolCategory } from "./runtime";
import { SECRET_TOOL_NAME } from "./secrets";
import { AGENT_UID, CLAUDE_BINARY, hostedArgvPrefix } from "./supervisor-protocol";
import {
  COMMIT_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  POLICY_TOOL_NAME,
  TOOL_SERVER_NAME,
  TOOL_SERVER_PATH,
} from "./tool-server";

export const CLAUDE_VERSION = RUNTIME_CATALOG.claude.pinnedVersion;
/** Where the runtime host serves Claude Code's stdio in the sandbox. */
export const CLAUDE_PORT = 4099;

/** The name the model sees one of OnCue's tools under: Claude Code's `mcp__<server>__<tool>`. */
export function claudeToolName(oncueName: string): string {
  return `mcp__${TOOL_SERVER_NAME}__${oncueName}`;
}

/**
 * Tools that run without asking: Claude Code's coding tools and three of
 * OnCue's. `secret_request` is left out on purpose, so calling it asks, and
 * the bridge holds the ask for the user.
 */
export const CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  claudeToolName(POLICY_TOOL_NAME),
  claudeToolName(DESCRIBE_TOOL_NAME),
  claudeToolName(COMMIT_TOOL_NAME),
];

/**
 * Claude Code's question tool. It is offered but never pre-allowed, so every
 * call reaches the bridge as `can_use_tool` and waits for the user's card.
 */
export const CLAUDE_QUESTION_TOOL = "AskUserQuestion";

/**
 * Tools the model is never offered: subagents (record 12's one primary
 * agent), plan mode's hand-back to the user, and skills and slash commands,
 * which load files the session did not choose.
 */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  "Task",
  "Agent",
  "ExitPlanMode",
  "EnterPlanMode",
  "Skill",
  "SlashCommand",
];

/** The flags after `claude`. A test reads them flag by flag. */
export function claudeArgs(options: {
  readonly modelId: string;
  readonly toolPort: number;
}): readonly string[] {
  const mcp = {
    mcpServers: {
      [TOOL_SERVER_NAME]: {
        type: "http",
        url: `http://127.0.0.1:${options.toolPort}${TOOL_SERVER_PATH}`,
      },
    },
  };
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    options.modelId,
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    "stdio",
    "--setting-sources",
    "",
    "--mcp-config",
    JSON.stringify(mcp),
    "--strict-mcp-config",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    CLAUDE_DISALLOWED_TOOLS.join(","),
  ];
}

/**
 * `node runtime-host.mjs --port N -- claude <flags>` as the agent user in
 * `/workspace`, with exactly this environment: the relay's placeholder as the
 * one credential-shaped key, no `ONCUE_*`, and Claude Code's state under the
 * agent's own home. The supervisor's `claude` row checks the argv's head,
 * every key, and the placeholder's value.
 */
export function plannedClaudeSpawn(options: RuntimeSpawnOptions): SpawnRequest {
  const home = options.home ?? AGENT_HOME;
  return {
    runtime: "claude",
    argv: [
      ...hostedArgvPrefix(options.port, options.binary ?? CLAUDE_BINARY, options.hostPaths),
      ...claudeArgs({ modelId: options.model.modelId, toolPort: options.toolPort }),
    ],
    cwd: options.cwd ?? WORKSPACE,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      TMPDIR: agentTmpDir(home),
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${options.relayPort}`,
      ANTHROPIC_AUTH_TOKEN: RELAY_PLACEHOLDER_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "unset",
      ANTHROPIC_SMALL_FAST_MODEL: options.model.modelId,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: options.model.modelId,
    },
    uid: AGENT_UID,
  };
}

/** Claude Code's own tool names -> protocol category. Unlisted is `other`. */
export const CLAUDE_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  Bash: "shell",
  BashOutput: "shell",
  KillShell: "shell",
  Read: "file_read",
  Edit: "file_write",
  MultiEdit: "file_write",
  Write: "file_write",
  NotebookEdit: "file_write",
  Glob: "search",
  Grep: "search",
  LS: "search",
  WebFetch: "web",
  WebSearch: "web",
};

export const CLAUDE_RUNTIME: RuntimePlan = {
  id: "claude",
  pinnedVersion: CLAUDE_VERSION,
  providers: RUNTIME_CATALOG.claude.providers,
  defaultPort: CLAUDE_PORT,
  profile: {
    control: "stdio-json-rpc",
    toolDelivery: "loopback-mcp",
    // A user message sent while a turn runs is queued by Claude Code itself.
    steerIsOnePrompt: true,
    // `can_use_tool` waits for the bridge's answer.
    holdsToolCalls: "permission_gate",
    // Image blocks in a user message.
    images: true,
    // Never run against another model than the one it started on.
    modelSwitch: "none",
  },
  planSpawn: plannedClaudeSpawn,
  toolCategory: (tool) => CLAUDE_TOOL_CATEGORY[tool] ?? "other",
  presentToolName: claudeToolName,
  classifyAsk: classifyClaudeAsk,
  rejectSettlesOtherAsks: false,
};

/** The permission key the reducer holds for the user: OnCue's secret tool under Claude Code's name. */
export const CLAUDE_SECRET_TOOL = claudeToolName(SECRET_TOOL_NAME);
