/**
 * The Pi runtime adapter's pure half: how the supervisor starts Pi's RPC mode
 * under the runtime host, and the document OnCue's Pi extension reads. Pi has
 * no MCP client or permission system, so the extension registers the relay as
 * the model's provider (Pi holds no credential), forwards OnCue's tools to the
 * bridge's loopback tool server, and holds `secret_request` by asking the
 * bridge through Pi's extension UI protocol.
 *
 * The flags keep Pi from loading anything a repository or the agent's home
 * could supply (extensions, skills, prompt templates, themes, a project's
 * `.pi/`), keep its session in memory, and keep it off the network except for
 * the relay; it still reads the repository's `AGENTS.md`. Built from Pi
 * 0.87.1's documentation and type declarations, and not yet run against a
 * live Pi.
 */

import { type EffortLevel, RUNTIME_CATALOG } from "@oncue/protocol";
import type { SpawnRequest } from "./agent";
import { classifyOtherAsk } from "./ask-category";
import type { ModelGrantSpec } from "./frames";
import { AGENT_HOME, agentTmpDir, RELAY_PLACEHOLDER_API_KEY, WORKSPACE } from "./opencode";
import { ASK_USER_TOOL_DEFINITION } from "./questions";
import type { RuntimeModel, RuntimePlan, RuntimeSpawnOptions, ToolCategory } from "./runtime";
import { SECRET_TOOL_NAME } from "./secrets";
import { AGENT_UID, hostedArgvPrefix, PI_BINARY, PI_EXTENSION_PATH } from "./supervisor-protocol";
import { ONCUE_TOOL_DEFINITIONS, TOOL_SERVER_PATH } from "./tool-server";

export const PI_VERSION = RUNTIME_CATALOG.pi.pinnedVersion;
/** Where the runtime host serves Pi's stdio in the sandbox. */
export const PI_PORT = 4098;
/** The provider name OnCue's extension registers; the only one Pi is started on. */
export const PI_PROVIDER_ID = "oncue";
/** The prefix the model sees OnCue's tools under, as in OpenCode and Codex. */
export const PI_TOOL_PREFIX = "oncue_";
/** The title of the extension UI dialog that holds a call; the bridge answers only these. */
export const PI_HOLD_TITLE = "oncue.hold";
/** The title of the dialog OnCue's question tool opens; the bridge shows it as the user's card. */
export const PI_QUESTION_TITLE = "oncue.question";
/** The environment key the extension reads its document from. */
export const PI_CONFIG_ENV = "PI_ONCUE_CONFIG";

/** Pi's API for each provider OnCue routes: its own names (`docs/custom-provider.md`). */
export const PI_PROVIDER_API: Readonly<Record<string, string>> = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
};

/**
 * Where each provider's client sends a request: Pi's Anthropic client appends
 * `/v1/messages` to a bare origin, its OpenAI client `/responses` to a `/v1`
 * base (Pi 0.87.1's documented `baseUrl`s). Both land on the relay's paths.
 */
export function piBaseUrl(provider: string, relayPort: number): string {
  const origin = `http://127.0.0.1:${relayPort}`;
  return provider === "openai" ? `${origin}/v1` : origin;
}

/** What Pi is told about a model the Worker's catalog does not list: text only, conservative limits. */
const UNLISTED_MODEL = { contextWindow: 200_000, maxOutput: 32_000, imageInput: false } as const;

/** The document `pi-extension.ts` reads: ports, the model, and the tools, and no credential. */
export interface PiOnCueConfig {
  readonly version: 1;
  readonly provider: {
    readonly id: string;
    readonly api: string;
    readonly baseUrl: string;
    /** The relay's placeholder. The relay drops it and attaches the broker token itself. */
    readonly apiKey: string;
  };
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly reasoning: boolean;
    readonly input: readonly ("text" | "image")[];
    readonly contextWindow: number;
    readonly maxTokens: number;
  };
  /** The bridge's loopback tool server. */
  readonly toolUrl: string;
  readonly toolPrefix: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }[];
  /** OnCue's names of the tools whose calls wait for the bridge's answer before they run. */
  readonly held: readonly string[];
  readonly holdTitle: string;
  /** OnCue's question tool, whose call waits for the user's answer through the bridge. */
  readonly question: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly title: string;
  };
}

export function piConfig(options: {
  readonly relayPort: number;
  readonly toolPort: number;
  readonly model: RuntimeModel;
  readonly modelSpec: ModelGrantSpec | null;
}): PiOnCueConfig {
  const spec = options.modelSpec;
  return {
    version: 1,
    provider: {
      id: PI_PROVIDER_ID,
      api: PI_PROVIDER_API[options.model.provider] ?? "anthropic-messages",
      baseUrl: piBaseUrl(options.model.provider, options.relayPort),
      apiKey: RELAY_PLACEHOLDER_API_KEY,
    },
    model: {
      id: options.model.modelId,
      name: spec?.name ?? options.model.modelId,
      // A model with no documented levels takes none: Pi then sends no thinking at all.
      reasoning: spec === null ? true : spec.effortLevels !== null,
      input: (spec?.imageInput ?? UNLISTED_MODEL.imageInput) ? ["text", "image"] : ["text"],
      contextWindow: spec?.contextWindow ?? UNLISTED_MODEL.contextWindow,
      maxTokens: spec?.maxOutput ?? UNLISTED_MODEL.maxOutput,
    },
    toolUrl: `http://127.0.0.1:${options.toolPort}${TOOL_SERVER_PATH}`,
    toolPrefix: PI_TOOL_PREFIX,
    tools: ONCUE_TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
    held: [SECRET_TOOL_NAME],
    holdTitle: PI_HOLD_TITLE,
    question: {
      name: ASK_USER_TOOL_DEFINITION.name,
      description: ASK_USER_TOOL_DEFINITION.description,
      inputSchema: ASK_USER_TOOL_DEFINITION.inputSchema,
      title: PI_QUESTION_TITLE,
    },
  };
}

/**
 * RPC mode, the one extension, nothing discovered, no trust for a project's
 * own resources, an in-memory session, and no network but the relay (Pi
 * 0.87.1's `docs/cli.md`).
 */
export function piArgs(options: {
  readonly extensionPath: string;
  readonly modelId: string;
}): readonly string[] {
  return [
    "--mode",
    "rpc",
    "--no-session",
    "--extension",
    options.extensionPath,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--offline",
    "--provider",
    PI_PROVIDER_ID,
    "--model",
    options.modelId,
  ];
}

/**
 * Pi under the runtime host as the agent user in `/workspace`, with exactly
 * this environment: no key, no `ONCUE_*`, the extension's document, and Pi's
 * switches for no catalog refresh, version check, or telemetry. The
 * supervisor's `pi` row checks the argv's head and every key.
 */
export function plannedPiSpawn(options: RuntimeSpawnOptions): SpawnRequest {
  const home = options.home ?? AGENT_HOME;
  return {
    runtime: "pi",
    argv: [
      ...hostedArgvPrefix(options.port, options.binary ?? PI_BINARY, options.hostPaths),
      ...piArgs({
        extensionPath: options.extensionPath ?? PI_EXTENSION_PATH,
        modelId: options.model.modelId,
      }),
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
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      [PI_CONFIG_ENV]: JSON.stringify(
        piConfig({
          relayPort: options.relayPort,
          toolPort: options.toolPort,
          model: options.model,
          modelSpec: options.modelSpec,
        }),
      ),
    },
    uid: AGENT_UID,
  };
}

/** Pi's thinking level for a run's effort: OnCue's words are Pi's, except `none`, which Pi calls `off`. */
export function piThinkingLevel(effort: EffortLevel): string {
  return effort === "none" ? "off" : effort;
}

/** Pi's built-in tools -> protocol category (`docs/cli.md`, Tools). Unlisted is `other`. */
export const PI_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  bash: "shell",
  read: "file_read",
  edit: "file_write",
  write: "file_write",
  grep: "search",
  find: "search",
  ls: "search",
};

export const PI_RUNTIME: RuntimePlan = {
  id: "pi",
  pinnedVersion: PI_VERSION,
  providers: RUNTIME_CATALOG.pi.providers,
  defaultPort: PI_PORT,
  profile: {
    control: "stdio-json-rpc",
    toolDelivery: "extension",
    // A prompt into a streaming session is queued with `streamingBehavior: "steer"`.
    steerIsOnePrompt: true,
    // The extension's `tool_call` handler waits on the bridge's answer.
    holdsToolCalls: "permission_gate",
    // A prompt's `images`.
    images: true,
    // Its extension registers the one model it started on.
    modelSwitch: "none",
  },
  planSpawn: plannedPiSpawn,
  toolCategory: (tool) => PI_TOOL_CATEGORY[tool] ?? "other",
  presentToolName: (oncueName) => `${PI_TOOL_PREFIX}${oncueName}`,
  classifyAsk: classifyOtherAsk,
  rejectSettlesOtherAsks: false,
};
