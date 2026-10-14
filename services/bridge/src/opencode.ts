/**
 * The OpenCode runtime adapter (`runtime.ts`): the pure `OPENCODE_RUNTIME` and
 * the OpenCode server's client. No caller sees OpenCode's HTTP shapes; SSE
 * frames are parsed in `opencode-wire.ts`. The supervisor starts the agent as
 * uid 1001 and re-enforces the environment allowlist `plannedRuntimeSpawn`
 * plans.
 */

import { RUNTIME_CATALOG, SUBAGENT_NAMES } from "@oncue/protocol";
import type { SpawnRequest } from "./agent";
import { classifyOpenCodeAsk } from "./ask-category";
import type { ModelGrantCatalogEntry, ModelGrantSpec } from "./frames";
import { parsePendingQuestions, parseServerEvent } from "./opencode-wire";
import {
  type RuntimeClient,
  type RuntimeModel,
  type RuntimePlan,
  type RuntimeSpawnOptions,
  type SwitchFacts,
  switchableEntries,
  type ToolCategory,
} from "./runtime";
import { secretPermissionKey } from "./secrets";
import {
  AGENT_UID,
  ALLOWED_BINARY,
  ALLOWED_CWD,
  ATTACHMENTS_ROOT,
  SECRETS_DIR,
} from "./supervisor-protocol";
import { TOOL_SERVER_NAME, TOOL_SERVER_PATH } from "./tool-server";

export const OPENCODE_BINARY = ALLOWED_BINARY;
export const OPENCODE_VERSION = RUNTIME_CATALOG.opencode.pinnedVersion;
export const AGENT_HOME = "/home/oncue-agent";
/**
 * The agent's own temporary directory, handed to OpenCode and every check as
 * `TMPDIR`, because a sandbox's `/tmp` is 777 with no sticky bit and any user
 * could replace the agent's files there. The image creates it agent-owned and
 * 0700. Only processes running as the agent user may ever be given it, never
 * one running as root or the bridge user.
 */
export const AGENT_TMP_DIRNAME = ".tmp";

export function agentTmpDir(home: string): string {
  return `${home}/${AGENT_TMP_DIRNAME}`;
}
export const WORKSPACE = ALLOWED_CWD;
/** The port the bridge asks OpenCode to bind; fixed, so every session starts OpenCode with the same argv. */
export const OPENCODE_PORT = 4096;
/**
 * Every request-answer call is bounded: a health probe that never settles
 * would silently stop the probe chain, as one did on a cold container.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The OpenCode server's client. `prompt` resolves on 204, not when the turn
 * finishes; OpenCode queues a prompt on a busy session itself, so steering is
 * one call. `replyHeld` never sends `always`, which would save a rule, and its
 * `true` means OpenCode accepted the reply, not that the call ran: a request
 * left behind by an aborted call also answers 200. `subscribe` resolves when
 * the event stream ends, however it ends.
 */
export type OpenCodeClient = RuntimeClient;

function origin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * SSE framing: `data:` lines accumulate until a blank line ends the event. A
 * payload that is not JSON comes back as `undefined` so the caller can report
 * it as `unknown` rather than lose count.
 */
export class SseDecoder {
  private pending = "";
  private data: string[] = [];

  push(chunk: string): unknown[] {
    const events: unknown[] = [];
    let rest = `${this.pending}${chunk}`;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = rest.slice(0, newline).replace(/\r$/, "");
      rest = rest.slice(newline + 1);
      if (line.length === 0) {
        if (this.data.length > 0) {
          const payload = this.data.join("\n");
          this.data = [];
          try {
            events.push(JSON.parse(payload));
          } catch {
            events.push(undefined);
          }
        }
        continue;
      }
      if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
      // `event:`, `id:`, `retry:` and comments carry nothing the bridge reads.
    }
    this.pending = rest;
    return events;
  }
}

export function createOpenCodeClient(fetchImpl: typeof fetch): RuntimeClient {
  async function createSession(port: number, title: string): Promise<string | null> {
    const response = await fetchImpl(`${origin(port)}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = await readJson(response);
    const id =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>).id : undefined;
    return typeof id === "string" ? id : null;
  }

  return {
    async health(port) {
      try {
        // An explicit controller held in scope, not `AbortSignal.timeout`,
        // whose unreferenced timer can be garbage-collected before it fires.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetchImpl(`${origin(port)}/global/health`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          return { kind: "not_yet", detail: `status ${response.status}` };
        }
        const body = await readJson(response);
        const record =
          typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        if (record.healthy !== true) {
          return { kind: "not_yet", detail: `body ${JSON.stringify(body).slice(0, 200)}` };
        }
        return {
          kind: "healthy",
          version: typeof record.version === "string" ? record.version : "unknown",
        };
      } catch (error) {
        return { kind: "not_yet", detail: error instanceof Error ? error.message : "fetch threw" };
      }
    },

    async prompt(port, { conversation, title, text, model, effort, files = [] }) {
      try {
        const sessionId = conversation ?? (await createSession(port, title));
        if (sessionId === null) {
          return { kind: "refused", detail: "opencode did not create a session" };
        }
        const response = await fetchImpl(
          `${origin(port)}/session/${encodeURIComponent(sessionId)}/prompt_async`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
              model: { providerID: model.provider, modelID: model.modelId },
              ...(effort === null ? {} : { variant: effort }),
              parts: [{ type: "text", text }, ...files],
            }),
          },
        );
        if (response.status !== 204 && !response.ok) {
          return {
            kind: "refused",
            detail: `opencode answered ${response.status} to prompt_async`,
          };
        }
        return { kind: "held", conversation: sessionId };
      } catch (error) {
        return {
          kind: "refused",
          detail: `opencode unreachable: ${error instanceof Error ? error.message : "unknown"}`,
        };
      }
    },

    async abort(port, conversation) {
      try {
        const response = await fetchImpl(
          `${origin(port)}/session/${encodeURIComponent(conversation)}/abort`,
          { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        return response.ok && (await readJson(response)) === true;
      } catch {
        return false;
      }
    },

    async replyHeld(port, requestId, reply, message) {
      try {
        const response = await fetchImpl(
          `${origin(port)}/permission/${encodeURIComponent(requestId)}/reply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message === null ? { reply } : { reply, message }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        return response.ok;
      } catch {
        return false;
      }
    },

    // OpenCode waits on a question with no deadline. A reply is one list of
    // labels or typed text per question; a dismissal is its `reject`.
    async replyQuestion(port, requestId, reply) {
      try {
        const action = reply.kind === "answer" ? "reply" : "reject";
        const response = await fetchImpl(
          `${origin(port)}/question/${encodeURIComponent(requestId)}/${action}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...(reply.kind === "answer"
              ? {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ answers: reply.answers }),
                }
              : {}),
          },
        );
        return response.ok;
      } catch {
        return false;
      }
    },

    // A question asked while the event stream was down is still waiting here,
    // with no deadline; the bridge reads this list after each reconnect.
    async pendingQuestions(port) {
      try {
        const response = await fetchImpl(`${origin(port)}/question`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return response.ok ? parsePendingQuestions(await response.json()) : [];
      } catch {
        return [];
      }
    },

    async subscribe(port, onEvent, signal, log = () => {}, room = () => Promise.resolve()) {
      try {
        const response = await fetchImpl(`${origin(port)}/event`, {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (!response.ok || response.body === null) {
          log(`opencode event stream refused: status ${response.status}`);
          return;
        }
        const decoder = new SseDecoder();
        const text = new TextDecoder();
        const reader = response.body.getReader();
        for (;;) {
          // While the bridge's unsent events are over their bound, the stream
          // is left unread, so what arrives meanwhile waits in the socket and
          // OpenCode rather than in the bridge.
          await room();
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          for (const event of decoder.push(text.decode(value, { stream: true }))) {
            onEvent(parseServerEvent(event));
          }
        }
      } catch (error) {
        // A dropped stream (or the abort signal) ends the subscription; the
        // shell decides whether to open another.
        log(`opencode event stream ended: ${error instanceof Error ? error.message : "unknown"}`);
      }
    },
  };
}

export type { RuntimeSpawnOptions } from "./runtime";

/**
 * `opencode serve` as uid 1001 in `/workspace` with exactly this environment,
 * so Modal's Secret variables, which every `Sandbox.exec` inherits, never reach
 * the agent: no provider key, no `GITHUB_TOKEN`, no `ONCUE_*`. The agent's only
 * route to a model is the loopback relay.
 */
export function plannedRuntimeSpawn(options: RuntimeSpawnOptions): SpawnRequest {
  const home = options.home ?? AGENT_HOME;
  return {
    argv: [
      options.binary ?? OPENCODE_BINARY,
      "serve",
      "--port",
      String(options.port),
      "--hostname",
      "127.0.0.1",
      "--log-level",
      "WARN",
      "--print-logs",
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
      // The repository is untrusted: its `opencode.json`, `.opencode/` agents,
      // modes, plugins, and commands would otherwise be merged over this
      // document and could loosen its permission rules.
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(
        opencodeConfig({
          workspace: options.cwd ?? WORKSPACE,
          relayPort: options.relayPort,
          toolPort: options.toolPort,
          model: options.model,
          modelSpec: options.modelSpec,
          catalog: options.catalog,
          secretsDir: options.secretsDir ?? SECRETS_DIR,
          attachmentsDir: options.attachmentsDir ?? ATTACHMENTS_ROOT,
        }),
      ),
    },
    uid: AGENT_UID,
  };
}

/** OpenCode's default primary agent, which every prompt reaches because none names another. */
export const OPENCODE_PRIMARY_AGENT = "build";

/** What the relay accepts in place of a provider key. The relay drops it and attaches the broker token itself. */
export const RELAY_PLACEHOLDER_API_KEY = "oncue-relay";

/**
 * The model's config entry: name and limits, so a model newer than OpenCode's
 * own list still runs, and one variant per documented effort level carrying
 * the provider client's own option. The Model Broker enforces the recorded
 * level on every request, so the variant is not the guarantee.
 */
function modelEntry(model: RuntimeModel, spec: ModelGrantSpec): Readonly<Record<string, unknown>> {
  const variants =
    spec.effortLevels === null
      ? {}
      : {
          variants: Object.fromEntries(
            spec.effortLevels.map((level) => [
              level,
              model.provider === "openai" ? { reasoningEffort: level } : { effort: level },
            ]),
          ),
        };
  return {
    name: spec.name,
    limit: { context: spec.contextWindow, output: spec.maxOutput },
    // Stated either way so OpenCode's own list cannot disagree with the
    // catalog; otherwise OpenCode replaces an image it thinks the model cannot
    // read with an error line.
    modalities: { input: spec.imageInput ? ["text", "image"] : ["text"], output: ["text"] },
    ...variants,
  };
}

/** What decides which models one OpenCode process can be prompted with (`switchableEntries`). */
const OPENCODE_SWITCH: SwitchFacts = {
  providers: RUNTIME_CATALOG.opencode.providers,
  profile: { modelSwitch: "per_prompt" },
};

/**
 * The provider entries: the model the process starts on and every other model
 * the session may change to (record 15), each provider pointed at the relay
 * with a placeholder key. OpenCode reads this once at start and a prompt names
 * its model, so a later run on another model needs nothing but a prompt. The
 * relay holds one token for one model, so declaring a model here does not let
 * the agent reach it.
 */
function providerEntries(options: {
  readonly relayPort: number;
  readonly model: RuntimeModel;
  readonly modelSpec: ModelGrantSpec | null;
  readonly catalog?: readonly ModelGrantCatalogEntry[] | undefined;
}): Readonly<Record<string, unknown>> {
  const declared: readonly {
    readonly provider: string;
    readonly modelId: string;
    readonly spec: ModelGrantSpec | null;
  }[] = [
    { ...options.model, spec: options.modelSpec },
    ...switchableEntries(OPENCODE_SWITCH, options.model, options.catalog),
  ];
  const providers = [...new Set(declared.map((entry) => entry.provider))];
  return Object.fromEntries(
    providers.map((provider) => {
      const models = declared.filter(
        (entry): entry is typeof entry & { readonly spec: ModelGrantSpec } =>
          entry.provider === provider && entry.spec !== null,
      );
      return [
        provider,
        {
          options: {
            baseURL: `http://127.0.0.1:${options.relayPort}/v1`,
            apiKey: RELAY_PLACEHOLDER_API_KEY,
          },
          ...(models.length === 0
            ? {}
            : {
                models: Object.fromEntries(
                  models.map((entry) => [entry.modelId, modelEntry(entry, entry.spec)]),
                ),
              }),
        },
      ];
    }),
  );
}

/**
 * The subagents the primary agent may start, by OpenCode's own names (record
 * 12). A repository's or a home directory's own agents are denied by name.
 */
export const OPENCODE_SUBAGENTS = SUBAGENT_NAMES;

/**
 * The config document. Sharing, autoupdate, and snapshots are off; every
 * provider it names points at the relay with a placeholder key (the client
 * refuses to start without one, and the relay drops it). `task` is `ask` for
 * the two built-in subagents only, so the bridge forwards each start to the
 * session object's permission gate after holding the run's limit
 * (`subagents.ts`), and denied for every other name; `subagent_depth: 1` lets
 * the primary agent start subagents and no subagent start another. Each
 * subagent runs the run's model, through the same relay. `question` is allowed
 * for the primary agent alone (the bridge answers it for the user, and no
 * other agent may wait on the user), and `oncue_secret_request` is `ask`.
 * `mcp.oncue` is the bridge's loopback tool server, which asks for no OAuth.
 * With the repository's own configuration switched off
 * (`OPENCODE_DISABLE_PROJECT_CONFIG`), its root `AGENTS.md` or `CLAUDE.md` is
 * named here so the agent still reads it.
 */
export function opencodeConfig(options: {
  /** The work tree, whose instruction files are named by absolute path. */
  readonly workspace?: string | undefined;
  readonly relayPort: number;
  readonly toolPort: number;
  readonly model: RuntimeModel;
  readonly modelSpec: ModelGrantSpec | null;
  /** The other models the session may change to; absent declares the one model. */
  readonly catalog?: readonly ModelGrantCatalogEntry[] | undefined;
  readonly secretsDir: string;
  readonly attachmentsDir: string;
}): Readonly<Record<string, unknown>> {
  return {
    // Never publish a session; the binary is pinned and checksummed, so it must
    // not update itself; no shadow git repository inside the workspace.
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    model: `${options.model.provider}/${options.model.modelId}`,
    provider: providerEntries(options),
    // `ask` holds a call to OnCue's secret tool until the bridge answers for
    // the user. A subagent's start asks too. OpenCode's own defaults also ask
    // before a path outside the project, a read of a `.env` file, and the same
    // call three times over; the bridge forwards each of those, and a start
    // within the run's limit, to the session object, which answers from the
    // user's approval mode or a card (record 09). The repository's
    // configuration is ignored at spawn, so it cannot loosen these rules.
    permission: {
      task: {
        "*": "deny",
        ...Object.fromEntries(OPENCODE_SUBAGENTS.map((name) => [name, "ask"])),
      },
      question: "deny",
      [secretPermissionKey(TOOL_SERVER_NAME)]: "ask",
      // The two places outside the work tree the agent is meant to read are
      // allowed by path, so they never ask: its secrets directory and the
      // composer's attachments.
      external_directory: {
        [`${options.secretsDir}/*`]: "allow",
        [`${options.attachmentsDir}/*`]: "allow",
      },
    },
    ...(options.workspace === undefined
      ? {}
      : { instructions: [`${options.workspace}/AGENTS.md`, `${options.workspace}/CLAUDE.md`] }),
    // The one agent a run prompts. Its `question` rule comes after the
    // top-level deny, so it alone may ask the user (record 12). Each subagent
    // keeps the top-level `question` deny, may not start another subagent, and
    // may not call OnCue's own tools: a secret, a commit, a policy, or a pull
    // request is the primary agent's to ask for. It names no model, so it runs
    // the one its run was prompted with, also after the session changes model.
    agent: {
      [OPENCODE_PRIMARY_AGENT]: { permission: { question: "allow" } },
      ...Object.fromEntries(
        OPENCODE_SUBAGENTS.map((name) => [
          name,
          { permission: { task: "deny", [`${TOOL_SERVER_NAME}_*`]: "deny" } },
        ]),
      ),
    },
    subagent_depth: 1,
    // A denied tool call fails that call and the model goes on, as the
    // denial's words tell it to; without this OpenCode ends the turn there.
    experimental: { continue_loop_on_deny: true },
    mcp: {
      [TOOL_SERVER_NAME]: {
        type: "remote",
        url: `http://127.0.0.1:${options.toolPort}${TOOL_SERVER_PATH}`,
        enabled: true,
        oauth: false,
      },
    },
  };
}

/**
 * OpenCode tool id to protocol category. Categories drive policy, so a wrong
 * default is a security mistake: anything unlisted is `"other"`, the most
 * restrictive category that renders.
 */
export const OPENCODE_TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  bash: "shell",
  read: "file_read",
  glob: "search",
  grep: "search",
  edit: "file_write",
  write: "file_write",
  apply_patch: "file_write",
  webfetch: "web",
  websearch: "web",
  todowrite: "other",
  task: "other",
  skill: "other",
  question: "other",
  invalid: "other",
};

/**
 * OpenCode's pure half. It serves HTTP on loopback, takes OnCue's tools from
 * the loopback MCP server under `<server>_<tool>`, queues a steer on a busy
 * session itself, and holds a tool call with its own permission gate.
 */
/**
 * OpenCode's cap on the output it reserves room for (`OUTPUT_TOKEN_MAX` in
 * 1.18.30). `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` would change it, and the
 * supervisor's spawn rule never passes it.
 */
export const OPENCODE_OUTPUT_TOKEN_MAX = 32_000;

/**
 * When OpenCode 1.18.30 compacts on its own (`SessionCompaction.isOverflow`):
 * once an answer's `tokens.total` reaches the window less the output it
 * reserves, `min(limit.output, OUTPUT_TOKEN_MAX)`, with no `limit.input` and no
 * `compaction` setting in the config this module writes. `tokens.total` is the
 * same sum as `usedTokens`.
 */
export function openCodeAutoCompactAt(spec: {
  readonly contextWindow: number;
  readonly maxOutput: number;
}): number {
  return Math.max(0, spec.contextWindow - Math.min(spec.maxOutput, OPENCODE_OUTPUT_TOKEN_MAX));
}

export const OPENCODE_RUNTIME: RuntimePlan = {
  id: "opencode",
  autoCompactAt: openCodeAutoCompactAt,
  pinnedVersion: OPENCODE_VERSION,
  providers: RUNTIME_CATALOG.opencode.providers,
  defaultPort: OPENCODE_PORT,
  profile: {
    control: "http",
    toolDelivery: "loopback-mcp",
    steerIsOnePrompt: true,
    holdsToolCalls: "permission_gate",
    images: true,
    // A prompt names its model, and `opencodeConfig` points every provider
    // the grant lists at the relay.
    modelSwitch: "per_prompt",
  },
  planSpawn: plannedRuntimeSpawn,
  toolCategory: (tool) => OPENCODE_TOOL_CATEGORY[tool] ?? "other",
  presentToolName: (oncueName) => `${TOOL_SERVER_NAME}_${oncueName}`,
  classifyAsk: classifyOpenCodeAsk,
  // OpenCode's `Permission.reply` fails every other pending request of the
  // session with the reject.
  rejectSettlesOtherAsks: true,
};
