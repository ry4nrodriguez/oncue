/**
 * The privilege boundary between the bridge (uid 1000) and the root supervisor,
 * as a pure function (record 02). `reviewRequest` maps a parsed request to
 * `allowed | refused` with no I/O, and the supervisor performs nothing it did
 * not first review. There is no general `exec` verb and no file verb. The agent
 * verbs let the caller choose only that the one allowed program runs, not what
 * runs; the check verbs run a caller-chosen command, but only as the agent user
 * with the agent's environment, which the agent can already do, and they put
 * the output where the agent cannot reach it afterwards.
 *
 * Both bundles import this file, so it touches no Node API.
 */

import { refuseSecretName, refuseSecretValue, MAX_SECRETS as SECRETS_CAP } from "./secret-names";

export type AgentSignal = "SIGTERM" | "SIGKILL";

export type SupervisorRequest =
  /** Hand /workspace to the agent uid after the bridge has finished cloning into it. */
  | { readonly op: "chown_workspace"; readonly requestId: string; readonly uid: number }
  | {
      readonly op: "start_agent";
      readonly requestId: string;
      /** Which `RUNTIME_SPAWN_RULES` row the request is reviewed against; absent means OpenCode. */
      readonly runtime?: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly uid: number;
    }
  /** `signal` is any string on the wire; `reviewRequest` is where it narrows. */
  | { readonly op: "signal"; readonly requestId: string; readonly signal: string }
  /** Resolves when the agent exits. */
  | { readonly op: "wait"; readonly requestId: string }
  /**
   * `/bin/sh -c <command>` as the agent uid in its own process group. Resolves
   * when the check ends, or when the supervisor killed it at `timeoutMs`.
   * Output goes to `outputPath`, which the supervisor creates.
   */
  | {
      readonly op: "run_check";
      readonly requestId: string;
      readonly checkRunId: string;
      readonly command: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly uid: number;
      readonly timeoutMs: number;
      readonly outputPath: string;
    }
  | {
      readonly op: "signal_check";
      readonly requestId: string;
      readonly checkRunId: string;
      readonly signal: string;
    }
  /** Hand a base checkout the bridge wrote under `BASE_TREE_ROOT` to the agent uid. */
  | {
      readonly op: "prepare_base";
      readonly requestId: string;
      readonly dir: string;
      readonly uid: number;
    }
  /**
   * One development secret for the agent (record 08), written to
   * `secretFilePath(name)` in a directory only root can write, readable by the
   * agent's group alone, and added to the environment of later checks. The
   * path is never a field, and the value appears in no response or log.
   */
  | {
      readonly op: "write_secret";
      readonly requestId: string;
      readonly name: string;
      readonly value: string;
    }
  /** Remove every secret file and forget every value: the runtime is shutting down. */
  | { readonly op: "clear_secrets"; readonly requestId: string }
  /**
   * Hands a message's attachment directory, written by the bridge under
   * `ATTACHMENTS_ROOT`, to the agent uid with `prepare_base`'s chown. The files
   * keep the bridge's modes (0600 in a 0700 directory), so afterwards only the
   * agent can read them.
   */
  | {
      readonly op: "prepare_attachments";
      readonly requestId: string;
      readonly dir: string;
      readonly uid: number;
    };

/** A request `reviewRequest` allowed: the same shape with the signal narrowed. */
export type AllowedRequest =
  | Exclude<SupervisorRequest, { op: "signal" | "signal_check" }>
  | { readonly op: "signal"; readonly requestId: string; readonly signal: AgentSignal }
  | {
      readonly op: "signal_check";
      readonly requestId: string;
      readonly checkRunId: string;
      readonly signal: AgentSignal;
    };

/** How a check ended, as the supervisor measured it. */
export interface CheckExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The supervisor killed the group at `timeoutMs`. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** What was written to the output file, never more than `MAX_CHECK_OUTPUT_BYTES`. */
  readonly outputBytes: number;
  /** The check wrote more than `MAX_CHECK_OUTPUT_BYTES`; the rest was dropped. */
  readonly truncated: boolean;
}

export type SupervisorResult =
  | { readonly op: "chown_workspace" }
  | { readonly op: "start_agent"; readonly pid: number }
  | { readonly op: "signal" }
  | {
      readonly op: "wait";
      readonly code: number | null;
      readonly signal: string | null;
    }
  | ({ readonly op: "run_check" } & CheckExit)
  | { readonly op: "signal_check" }
  | { readonly op: "prepare_base" }
  | { readonly op: "write_secret" }
  | { readonly op: "clear_secrets" }
  | { readonly op: "prepare_attachments" };

export type PermissionDenial =
  | "binary_not_allowed"
  | "runtime_not_allowed"
  | "uid_not_allowed"
  | "cwd_not_allowed"
  | "env_key_not_allowed"
  | "env_value_too_long"
  | "signal_not_allowed"
  | "check_id_not_allowed"
  | "command_too_long"
  | "timeout_not_allowed"
  | "output_path_not_allowed"
  | "base_dir_not_allowed"
  | "secret_name_not_allowed"
  | "secret_value_not_allowed"
  | "too_many_secrets"
  | "attachment_dir_not_allowed";

export type Refusal =
  /** Did not parse, or named an op this supervisor does not have. */
  | { readonly reason: "malformed" }
  /** Parsed and `reviewRequest` said no. `detail` never echoes a value. */
  | { readonly reason: "not_permitted"; readonly detail: PermissionDenial }
  /** Permitted and the operating system refused. */
  | { readonly reason: "failed"; readonly detail: string }
  /**
   * A second `start_agent` or `run_check` while one is running, a signal or
   * wait with no agent, or a `signal_check` naming no running check.
   */
  | { readonly reason: "no_such_agent" | "already_running" | "no_such_check" };

export type SupervisorResponse =
  | { readonly requestId: string; readonly ok: true; readonly result: SupervisorResult }
  | { readonly requestId: string; readonly ok: false; readonly refusal: Refusal };

// These constants ARE the privilege boundary.

/** OpenCode's binary: the one program the supervisor starts directly. Not a prefix, not a directory. */
export const ALLOWED_BINARY = "/opt/opencode/opencode";

/**
 * The image's Node (`NODE_INSTALL_COMMANDS` in `images.py`), which runs the
 * runtime host for a harness that talks over stdio.
 */
export const NODE_BINARY = "/usr/local/bin/node";

/**
 * The runtime host (`runtime-host.ts`): root-owned, readable by the agent user,
 * writable by nothing else. It serves a stdio harness's stdin and stdout on one
 * loopback port and holds no credential.
 */
export const RUNTIME_HOST_PATH = "/usr/local/lib/oncue/runtime-host.mjs";

/**
 * Codex's binary in the image (`CODEX_INSTALL_DIR` in `images.py`): the
 * linux-x64 musl build from the pinned npm package, root-owned.
 */
export const CODEX_BINARY = "/opt/codex/bin/codex";

/**
 * Where an image that carries Pi puts its command: the pinned npm package,
 * root-owned under its own prefix. A Node script the runtime host starts.
 */
export const PI_BINARY = "/opt/pi/bin/pi";

/**
 * OnCue's Pi extension, beside the runtime host: root-owned and read-only, so
 * neither the agent nor the bridge can change what Pi loads into itself.
 */
export const PI_EXTENSION_PATH = "/usr/local/lib/oncue/pi-extension.mjs";

/**
 * Where an image that carries Claude Code puts its binary (root-owned, under
 * `/opt`). No image carries it yet.
 */
export const CLAUDE_BINARY = "/opt/claude/bin/claude";

/** What the relay takes in place of a provider credential; `opencode.ts`'s `RELAY_PLACEHOLDER_API_KEY`. */
export const RELAY_PLACEHOLDER = "oncue-relay";
/** The only uid it will start a process as, and chown to. `images.py`'s `AGENT_UID`. */
export const AGENT_UID = 1001;
/** `images.py`'s `AGENT_WORKDIR`. */
export const ALLOWED_CWD = "/workspace";

export const ALLOWED_SIGNALS: readonly AgentSignal[] = ["SIGTERM", "SIGKILL"];

/**
 * Every environment key the agent may be given. A key not here is a refusal,
 * not a silent drop: a silent drop would let a caller believe the agent got a
 * setting it did not. Absent on purpose: every `ONCUE_*`, every provider key
 * name, anything ending in TOKEN, KEY, SECRET, or PASSWORD.
 */
export const BASE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

/** OpenCode's keys: the base, the switch that ignores the repository's own configuration, and OnCue's configuration document. */
export const ALLOWED_ENV_KEYS: readonly string[] = [
  ...BASE_ENV_KEYS,
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
];

/**
 * One row per harness: what `start_agent` may start for it, and with which
 * environment. The rows are the privilege boundary for starting an agent.
 * A `direct` row's `argv[0]` is exactly `binary`; a `hosted` row's argv begins
 * exactly `[NODE_BINARY, RUNTIME_HOST_PATH, "--port", <port>, "--", binary]`,
 * and the harness's own flags that follow cannot make it another program.
 * No `envKeys` entry ends in TOKEN, KEY, SECRET, or PASSWORD; a
 * `placeholderKeys` entry is accepted only with exactly `RELAY_PLACEHOLDER`.
 */
export type RuntimeSpawnRule =
  | {
      readonly kind: "direct";
      readonly binary: string;
      readonly envKeys: readonly string[];
      readonly placeholderKeys: readonly string[];
    }
  | {
      readonly kind: "hosted";
      readonly binary: string;
      readonly envKeys: readonly string[];
      readonly placeholderKeys: readonly string[];
    };

export const RUNTIME_SPAWN_RULES: Readonly<Record<string, RuntimeSpawnRule>> = {
  opencode: {
    kind: "direct",
    binary: ALLOWED_BINARY,
    envKeys: ALLOWED_ENV_KEYS,
    placeholderKeys: [],
  },
  // Codex's app-server talks JSON-RPC over stdio, under the runtime host. Its
  // configuration is argv (`-c`); its one extra key is its state directory.
  // It needs no key: its model provider sets `requires_openai_auth = false`.
  codex: {
    kind: "hosted",
    binary: CODEX_BINARY,
    envKeys: [...BASE_ENV_KEYS, "CODEX_HOME"],
    placeholderKeys: [],
  },
  // Pi's RPC mode talks JSON lines over stdio, under the runtime host. Its extra
  // keys keep it off the network except for the relay (no catalog refresh,
  // version check, or telemetry) and name the document OnCue's extension
  // reads, which holds no credential.
  pi: {
    kind: "hosted",
    binary: PI_BINARY,
    envKeys: [
      ...BASE_ENV_KEYS,
      "PI_OFFLINE",
      "PI_SKIP_VERSION_CHECK",
      "PI_TELEMETRY",
      "PI_ONCUE_CONFIG",
    ],
    placeholderKeys: [],
  },
  // Claude Code's stream-json mode talks JSON lines over stdio, under the
  // runtime host. Its keys: its state directory, the relay as API origin, no
  // non-essential traffic or self-update, no effort of its own (the broker
  // writes the run's), and the run's model for its background requests. It
  // refuses to start without a credential, so `ANTHROPIC_AUTH_TOKEN` is a
  // placeholder key, accepted only as `oncue-relay`, which the relay drops.
  claude: {
    kind: "hosted",
    binary: CLAUDE_BINARY,
    envKeys: [
      ...BASE_ENV_KEYS,
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ],
    placeholderKeys: ["ANTHROPIC_AUTH_TOKEN"],
  },
};

/** A `start_agent` naming no runtime is OpenCode's. */
export const DEFAULT_SPAWN_RUNTIME = "opencode";

/** The argv a hosted harness starts with, up to and including its binary. The dev host passes its own Node and host. */
export function hostedArgvPrefix(
  port: number,
  binary: string,
  paths: { readonly node: string; readonly host: string } = {
    node: NODE_BINARY,
    host: RUNTIME_HOST_PATH,
  },
): readonly string[] {
  return [paths.node, paths.host, "--port", String(port), "--", binary];
}

const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;

/**
 * The argv half of a rule, with the binaries passed in so the dev host can
 * point them at its own install (`local-supervisor.ts`).
 */
export function reviewRuntimeArgv(
  rule: RuntimeSpawnRule,
  argv: readonly string[],
  paths: { readonly binary: string; readonly node: string; readonly host: string } = {
    binary: rule.binary,
    node: NODE_BINARY,
    host: RUNTIME_HOST_PATH,
  },
): PermissionDenial | null {
  if (rule.kind === "direct") {
    return argv[0] === paths.binary ? null : "binary_not_allowed";
  }
  const port = argv[3] ?? "";
  if (
    argv[0] !== paths.node ||
    argv[1] !== paths.host ||
    argv[2] !== "--port" ||
    !PORT_PATTERN.test(port) ||
    Number(port) > 65_535 ||
    argv[4] !== "--" ||
    argv[5] !== paths.binary
  ) {
    return "binary_not_allowed";
  }
  return null;
}

/** The environment half: every key in the rule, a placeholder key only with the placeholder, every value bounded. */
export function reviewRuntimeEnv(
  rule: RuntimeSpawnRule,
  env: Readonly<Record<string, string>>,
): PermissionDenial | null {
  for (const [key, value] of Object.entries(env)) {
    if (rule.placeholderKeys.includes(key)) {
      if (value !== RELAY_PLACEHOLDER) {
        return "env_key_not_allowed";
      }
      continue;
    }
    if (!rule.envKeys.includes(key)) {
      return "env_key_not_allowed";
    }
    if (envValueTooLong(value)) {
      return "env_value_too_long";
    }
  }
  return null;
}

/** The rule a `start_agent` is reviewed against, or null for a runtime with none. */
export function spawnRuleFor(runtime: string | undefined): RuntimeSpawnRule | null {
  // A Map, so an inherited name such as `toString` is never a row.
  return new Map(Object.entries(RUNTIME_SPAWN_RULES)).get(runtime ?? DEFAULT_SPAWN_RUNTIME) ?? null;
}

export const MAX_ENV_VALUE_BYTES = 64 * 1024;

/**
 * A check may also be told it runs under CI, which turns off the watch modes
 * and interactive prompts test runners otherwise fall into. Nothing else.
 */
export const CHECK_ENV_KEYS: readonly string[] = [...ALLOWED_ENV_KEYS, "CI"];

/**
 * Created by the supervisor at start, owned by root, and outside the bridge's
 * home: in a directory the bridge owns, the bridge could swap an entry for a
 * symlink before root creates a file through it.
 */
export const VERIFICATION_ROOT = "/var/lib/oncue";
/** root:bridge 0750. The bridge reads a finished log; the agent cannot even traverse to it. */
export const CHECK_OUTPUT_DIR = `${VERIFICATION_ROOT}/checks`;
/**
 * root:bridge 0771. The bridge creates one base checkout per run in it; the
 * agent can reach a checkout it was handed by name, but cannot list, create,
 * or replace one.
 */
export const BASE_TREE_ROOT = `${VERIFICATION_ROOT}/base`;

/**
 * root:agent 0750, created by the supervisor at start so no component of a
 * secret's path is writable by the agent or the bridge (the symlink trap on
 * `VERIFICATION_ROOT`). The agent's group can list and read; the bridge cannot
 * traverse. Outside `/workspace`, so no checkpoint or bundle holds it.
 */
export const SECRETS_DIR = `${VERIFICATION_ROOT}/secrets`;
/** As many as a project file may declare. */
export const MAX_SECRETS = SECRETS_CAP;

/**
 * root:bridge 0771, like `BASE_TREE_ROOT`: the bridge makes one directory per
 * message; the agent reaches one only by name and cannot list, create, or
 * replace one. Outside `/workspace`, so no attachment is committed or bundled.
 */
export const ATTACHMENTS_ROOT = `${VERIFICATION_ROOT}/attachments`;

/** `<root>/<segment>` exactly, the rule `isBaseTreeDir` applies to base checkouts. */
export function isAttachmentDir(dir: string, root: string): boolean {
  const prefix = `${root}/`;
  return dir.startsWith(prefix) && PATH_SEGMENT_PATTERN.test(dir.slice(prefix.length));
}

export function reviewPrepareAttachments(
  request: Extract<SupervisorRequest, { op: "prepare_attachments" }>,
  root: string,
): PermissionDenial | null {
  if (request.uid !== AGENT_UID) {
    return "uid_not_allowed";
  }
  if (!isAttachmentDir(request.dir, root)) {
    return "attachment_dir_not_allowed";
  }
  return null;
}

/** The one file a secret is written to. `name` has passed `refuseSecretName`, so it is one path segment. */
export function secretFilePath(name: string): string {
  return `${SECRETS_DIR}/${name}`;
}

/** Record 14's per-check wall limit. */
export const MAX_CHECK_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_CHECK_COMMAND_BYTES = 4096;
/** Record 03's per-artifact limit: past this a log is cut, since it could not be uploaded whole anyway. */
export const MAX_CHECK_OUTPUT_BYTES = 25 * 1024 * 1024;
/** A check run id, and a base checkout's directory name: one path segment with no dots. */
export const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Inside the bridge user's 0700 home, mode 0600. The filesystem is the
 * authentication: the agent's uid cannot traverse `/opt/oncue`, and Node does
 * not expose `SO_PEERCRED`.
 */
export const SUPERVISOR_SOCKET = "/opt/oncue/supervisor.sock";

export type Review =
  | { readonly kind: "allowed"; readonly request: AllowedRequest }
  | { readonly kind: "refused"; readonly denial: PermissionDenial };

function isAgentSignal(value: string): value is AgentSignal {
  return (ALLOWED_SIGNALS as readonly string[]).includes(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function envValueTooLong(value: string): boolean {
  // Byte length, not code units: the limit exists so one variable cannot be
  // used to exhaust the environment, and that is a property of bytes.
  return byteLength(value) > MAX_ENV_VALUE_BYTES;
}

function reviewEnv(
  env: Readonly<Record<string, string>>,
  allowed: readonly string[],
): PermissionDenial | null {
  for (const [key, value] of Object.entries(env)) {
    if (!allowed.includes(key)) {
      return "env_key_not_allowed";
    }
    if (envValueTooLong(value)) {
      return "env_value_too_long";
    }
  }
  return null;
}

/** Where checks may run and write. The sandbox's are `SANDBOX_CHECK_PATHS`; the dev host passes its own. */
export interface CheckPaths {
  readonly workspace: string;
  readonly baseTreeRoot: string;
  readonly checkOutputDir: string;
}

export const SANDBOX_CHECK_PATHS: CheckPaths = {
  workspace: ALLOWED_CWD,
  baseTreeRoot: BASE_TREE_ROOT,
  checkOutputDir: CHECK_OUTPUT_DIR,
};

/** `<root>/<segment>` exactly: no deeper path, no `..`, no trailing slash. */
export function isBaseTreeDir(dir: string, paths: CheckPaths): boolean {
  const prefix = `${paths.baseTreeRoot}/`;
  return dir.startsWith(prefix) && PATH_SEGMENT_PATTERN.test(dir.slice(prefix.length));
}

export function checkOutputPath(checkRunId: string, paths: CheckPaths): string {
  return `${paths.checkOutputDir}/${checkRunId}.log`;
}

/**
 * `run_check`'s rules, in the order a refusal names them: the id, the uid,
 * the directory (the workspace or a base checkout), the environment, the
 * command's size, the time limit, and the output path, which must be the one
 * the id names. Shared with the dev host's stand-in, which passes its own paths.
 */
export function reviewRunCheck(
  request: Extract<SupervisorRequest, { op: "run_check" }>,
  paths: CheckPaths,
): PermissionDenial | null {
  if (!PATH_SEGMENT_PATTERN.test(request.checkRunId)) {
    return "check_id_not_allowed";
  }
  if (request.uid !== AGENT_UID) {
    return "uid_not_allowed";
  }
  if (request.cwd !== paths.workspace && !isBaseTreeDir(request.cwd, paths)) {
    return "cwd_not_allowed";
  }
  const env = reviewEnv(request.env, CHECK_ENV_KEYS);
  if (env !== null) {
    return env;
  }
  if (byteLength(request.command) > MAX_CHECK_COMMAND_BYTES) {
    return "command_too_long";
  }
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_CHECK_TIMEOUT_MS
  ) {
    return "timeout_not_allowed";
  }
  if (request.outputPath !== checkOutputPath(request.checkRunId, paths)) {
    return "output_path_not_allowed";
  }
  return null;
}

export function reviewPrepareBase(
  request: Extract<SupervisorRequest, { op: "prepare_base" }>,
  paths: CheckPaths,
): PermissionDenial | null {
  if (request.uid !== AGENT_UID) {
    return "uid_not_allowed";
  }
  if (!isBaseTreeDir(request.dir, paths)) {
    return "base_dir_not_allowed";
  }
  return null;
}

/**
 * Total and pure. `start_agent` must match its runtime's row (argv, uid, cwd,
 * env keys, placeholders, value sizes); the other verbs have their own narrow
 * rules. Flags after the binary are not checked, because a flag cannot make the
 * binary something else; if that stops being true, the argv allowlist belongs
 * here.
 */
export function reviewRequest(request: SupervisorRequest): Review {
  switch (request.op) {
    case "chown_workspace":
      if (request.uid !== AGENT_UID) {
        return { kind: "refused", denial: "uid_not_allowed" };
      }
      return { kind: "allowed", request };
    case "start_agent": {
      const rule = spawnRuleFor(request.runtime);
      if (rule === null) {
        return { kind: "refused", denial: "runtime_not_allowed" };
      }
      const argv = reviewRuntimeArgv(rule, request.argv);
      if (argv !== null) {
        return { kind: "refused", denial: argv };
      }
      if (request.uid !== AGENT_UID) {
        return { kind: "refused", denial: "uid_not_allowed" };
      }
      if (request.cwd !== ALLOWED_CWD) {
        return { kind: "refused", denial: "cwd_not_allowed" };
      }
      const env = reviewRuntimeEnv(rule, request.env);
      if (env !== null) {
        return { kind: "refused", denial: env };
      }
      return { kind: "allowed", request };
    }
    case "signal":
      if (!isAgentSignal(request.signal)) {
        return { kind: "refused", denial: "signal_not_allowed" };
      }
      return { kind: "allowed", request: { ...request, signal: request.signal } };
    case "wait":
      return { kind: "allowed", request };
    case "run_check": {
      const denial = reviewRunCheck(request, SANDBOX_CHECK_PATHS);
      return denial === null ? { kind: "allowed", request } : { kind: "refused", denial };
    }
    case "signal_check":
      if (!PATH_SEGMENT_PATTERN.test(request.checkRunId)) {
        return { kind: "refused", denial: "check_id_not_allowed" };
      }
      if (!isAgentSignal(request.signal)) {
        return { kind: "refused", denial: "signal_not_allowed" };
      }
      return { kind: "allowed", request: { ...request, signal: request.signal } };
    case "prepare_base": {
      const denial = reviewPrepareBase(request, SANDBOX_CHECK_PATHS);
      return denial === null ? { kind: "allowed", request } : { kind: "refused", denial };
    }
    case "write_secret":
      // The control plane's rules again: the request arrives through the bridge,
      // and root does not take the bridge's word for what it may write.
      if (refuseSecretName(request.name) !== null) {
        return { kind: "refused", denial: "secret_name_not_allowed" };
      }
      if (refuseSecretValue(request.value) !== null) {
        return { kind: "refused", denial: "secret_value_not_allowed" };
      }
      return { kind: "allowed", request };
    case "clear_secrets":
      return { kind: "allowed", request };
    case "prepare_attachments": {
      const denial = reviewPrepareAttachments(request, ATTACHMENTS_ROOT);
      return denial === null ? { kind: "allowed", request } : { kind: "refused", denial };
    }
  }
}

// Newline-delimited JSON over a `SOCK_STREAM` Unix socket, correlated by
// `requestId`, so a `wait` (hours) does not block a `signal`.

/** Longer than any allowed request and short enough that a runaway peer cannot hold memory. */
export const MAX_LINE_BYTES = 1024 * 1024;

export function encodeRequest(request: SupervisorRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeResponse(response: SupervisorResponse): string {
  return `${JSON.stringify(response)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== null && Object.values(record).every(isString);
}

/**
 * The best-effort request id of a line `parseRequest` rejected, so the
 * refusal can still be correlated. Empty when there is nothing to correlate.
 */
export function requestIdOf(line: string): string {
  const record = parseJsonLine(line);
  const id = record?.requestId;
  return isString(id) ? id : "";
}

export function parseRequest(line: string): SupervisorRequest | null {
  const record = parseJsonLine(line);
  if (record === null) {
    return null;
  }
  const requestId = record.requestId;
  if (!isString(requestId) || requestId.length === 0) {
    return null;
  }
  switch (record.op) {
    case "chown_workspace":
      return Number.isInteger(record.uid)
        ? { op: "chown_workspace", requestId, uid: record.uid as number }
        : null;
    case "start_agent": {
      const { argv, cwd, env, uid, runtime } = record;
      if (!isStringArray(argv) || argv.length === 0) {
        return null;
      }
      if (!isString(cwd) || !isStringRecord(env) || !Number.isInteger(uid)) {
        return null;
      }
      if (runtime !== undefined && !isString(runtime)) {
        return null;
      }
      return {
        op: "start_agent",
        requestId,
        ...(runtime === undefined ? {} : { runtime }),
        argv,
        cwd,
        env,
        uid: uid as number,
      };
    }
    case "signal":
      return isString(record.signal) ? { op: "signal", requestId, signal: record.signal } : null;
    case "wait":
      return { op: "wait", requestId };
    case "run_check": {
      const { checkRunId, command, cwd, env, uid, timeoutMs, outputPath } = record;
      if (!isString(checkRunId) || !isString(command) || command.length === 0) {
        return null;
      }
      if (!isString(cwd) || !isStringRecord(env) || !isString(outputPath)) {
        return null;
      }
      if (!Number.isInteger(uid) || !Number.isInteger(timeoutMs)) {
        return null;
      }
      return {
        op: "run_check",
        requestId,
        checkRunId,
        command,
        cwd,
        env,
        uid: uid as number,
        timeoutMs: timeoutMs as number,
        outputPath,
      };
    }
    case "signal_check":
      return isString(record.checkRunId) && isString(record.signal)
        ? { op: "signal_check", requestId, checkRunId: record.checkRunId, signal: record.signal }
        : null;
    case "prepare_base":
      return isString(record.dir) && Number.isInteger(record.uid)
        ? { op: "prepare_base", requestId, dir: record.dir, uid: record.uid as number }
        : null;
    case "write_secret":
      return isString(record.name) && isString(record.value)
        ? { op: "write_secret", requestId, name: record.name, value: record.value }
        : null;
    case "clear_secrets":
      return { op: "clear_secrets", requestId };
    case "prepare_attachments":
      return isString(record.dir) && Number.isInteger(record.uid)
        ? { op: "prepare_attachments", requestId, dir: record.dir, uid: record.uid as number }
        : null;
    default:
      return null;
  }
}

function isCounter(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseCheckExit(record: Record<string, unknown>): CheckExit | null {
  const { exitCode, signal, timedOut, durationMs, outputBytes, truncated } = record;
  if (exitCode !== null && !Number.isInteger(exitCode)) {
    return null;
  }
  if (signal !== null && !isString(signal)) {
    return null;
  }
  if (typeof timedOut !== "boolean" || typeof truncated !== "boolean") {
    return null;
  }
  if (!isCounter(durationMs) || !isCounter(outputBytes)) {
    return null;
  }
  return {
    exitCode: exitCode as number | null,
    signal: signal as string | null,
    timedOut,
    durationMs,
    outputBytes,
    truncated,
  };
}

function parseResult(value: unknown): SupervisorResult | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  switch (record.op) {
    case "chown_workspace":
    case "signal":
    case "signal_check":
    case "prepare_base":
    case "write_secret":
    case "clear_secrets":
    case "prepare_attachments":
      return { op: record.op };
    case "start_agent":
      return Number.isInteger(record.pid) ? { op: "start_agent", pid: record.pid as number } : null;
    case "wait": {
      const { code, signal } = record;
      if (code !== null && !Number.isInteger(code)) {
        return null;
      }
      if (signal !== null && !isString(signal)) {
        return null;
      }
      return { op: "wait", code: code as number | null, signal: signal as string | null };
    }
    case "run_check": {
      const exit = parseCheckExit(record);
      return exit === null ? null : { op: "run_check", ...exit };
    }
    default:
      return null;
  }
}

/**
 * Every `PermissionDenial`, as a total record so a denial missing here is a
 * compile error: a refusal the client cannot parse never settles.
 */
const PERMISSION_DENIAL_TABLE: Readonly<Record<PermissionDenial, true>> = {
  binary_not_allowed: true,
  runtime_not_allowed: true,
  uid_not_allowed: true,
  cwd_not_allowed: true,
  env_key_not_allowed: true,
  env_value_too_long: true,
  signal_not_allowed: true,
  check_id_not_allowed: true,
  command_too_long: true,
  timeout_not_allowed: true,
  output_path_not_allowed: true,
  base_dir_not_allowed: true,
  secret_name_not_allowed: true,
  secret_value_not_allowed: true,
  too_many_secrets: true,
  attachment_dir_not_allowed: true,
};
const PERMISSION_DENIALS: readonly string[] = Object.keys(PERMISSION_DENIAL_TABLE);

function parseRefusal(value: unknown): Refusal | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  switch (record.reason) {
    case "malformed":
    case "no_such_agent":
    case "already_running":
    case "no_such_check":
      return { reason: record.reason };
    case "not_permitted":
      return isString(record.detail) && PERMISSION_DENIALS.includes(record.detail)
        ? { reason: "not_permitted", detail: record.detail as PermissionDenial }
        : null;
    case "failed":
      return isString(record.detail) ? { reason: "failed", detail: record.detail } : null;
    default:
      return null;
  }
}

export function parseResponse(line: string): SupervisorResponse | null {
  const record = parseJsonLine(line);
  if (record === null) {
    return null;
  }
  const requestId = record.requestId;
  if (!isString(requestId)) {
    return null;
  }
  if (record.ok === true) {
    const result = parseResult(record.result);
    return result === null ? null : { requestId, ok: true, result };
  }
  if (record.ok === false) {
    const refusal = parseRefusal(record.refusal);
    return refusal === null ? null : { requestId, ok: false, refusal };
  }
  return null;
}

/**
 * Splits a byte stream into lines. A line past `MAX_LINE_BYTES` comes back as
 * `null` and is discarded up to the next newline, so a peer that stops sending
 * newlines costs bounded memory.
 */
export class LineSplitter {
  private pending = "";
  private discarding = false;

  push(chunk: string): (string | null)[] {
    const lines: (string | null)[] = [];
    let rest = `${this.pending}${chunk}`;
    this.pending = "";
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      lines.push(line.length > MAX_LINE_BYTES ? null : line);
    }
    if (this.discarding) {
      return lines;
    }
    if (rest.length > MAX_LINE_BYTES) {
      this.discarding = true;
      lines.push(null);
      return lines;
    }
    this.pending = rest;
    return lines;
  }
}
