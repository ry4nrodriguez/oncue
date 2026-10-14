/**
 * Resolves a repository's commands and where each came from, in record 08's
 * layers: platform defaults, detection from repository files, then
 * `.oncue/project.yaml`. `Sourced<T>` carries the layer so a session can show
 * its resolved environment with provenance.
 *
 * Pure: `detect` takes a read-only view of the repository, `readProjectYaml`
 * the file's text, and `resolve` both computed layers, so the interpreter and
 * the tests call the same functions.
 */

import { MAX_SECRETS, refuseSecretName } from "./secret-names";

export type ConfigurationSource = "platform_default" | "detected" | "repository_file";

export interface Sourced<T> {
  readonly value: T;
  readonly source: ConfigurationSource;
}

function sourced<T>(value: T, source: ConfigurationSource): Sourced<T> {
  return { value, source };
}

export interface RepositoryFiles {
  /** `null` means the path does not exist. Never throws on a missing file. */
  readonly readFile: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
}

export interface DetectedCommands {
  readonly test: string | null;
  readonly lint: string | null;
  readonly typecheck: string | null;
  readonly build: string | null;
  readonly dev: string | null;
}

const COMMAND_KEYS = ["test", "lint", "typecheck", "build", "dev"] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];

const LOCKFILE_BY_MANAGER: ReadonlyArray<{
  readonly manager: "pnpm" | "yarn" | "npm";
  readonly lockfile: string;
}> = [
  { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
  { manager: "yarn", lockfile: "yarn.lock" },
  { manager: "npm", lockfile: "package-lock.json" },
];

/** The package manager whose lockfile is present, npm otherwise (npm needs no lockfile to be runnable). */
function detectPackageManager(files: RepositoryFiles): "pnpm" | "yarn" | "npm" {
  for (const { manager, lockfile } of LOCKFILE_BY_MANAGER) {
    if (files.exists(lockfile)) {
      return manager;
    }
  }
  return "npm";
}

/** How to install a repository's dependencies from the lockfile it committed. */
export interface InstallStep {
  readonly command: string;
  readonly lockfile: string;
}

const INSTALL_COMMAND_BY_MANAGER: Readonly<Record<"pnpm" | "yarn" | "npm", string>> = {
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
  npm: "npm ci",
};

/**
 * The install verification runs before any check, or null when the repository
 * committed no lockfile: without one an install would resolve its own versions,
 * and what was verified would not be what was committed.
 */
export function detectInstall(files: RepositoryFiles): InstallStep | null {
  for (const { manager, lockfile } of LOCKFILE_BY_MANAGER) {
    if (files.exists(lockfile)) {
      return { command: INSTALL_COMMAND_BY_MANAGER[manager], lockfile };
    }
  }
  return null;
}

function runScriptCommand(manager: "pnpm" | "yarn" | "npm", scriptName: string): string {
  if (manager === "npm") {
    return `npm run ${scriptName}`;
  }
  // Always `<manager> run <script>`: the bare `<manager> <script>` form can
  // collide with a manager's own subcommands (`pnpm add`).
  return `${manager} run ${scriptName}`;
}

/**
 * Proposes a command for each of `test`, `lint`, `typecheck`, `build`, and
 * `dev` that `package.json` defines, with the lockfile's package manager. A
 * missing or unparsable `package.json` detects nothing: detection is
 * best-effort (record 08).
 */
export function detect(files: RepositoryFiles): DetectedCommands {
  const packageJsonText = files.readFile("package.json");
  const scripts = parsePackageJsonScripts(packageJsonText);
  if (scripts === null) {
    return { test: null, lint: null, typecheck: null, build: null, dev: null };
  }
  const manager = detectPackageManager(files);
  const result: Record<CommandKey, string | null> = {
    test: null,
    lint: null,
    typecheck: null,
    build: null,
    dev: null,
  };
  for (const key of COMMAND_KEYS) {
    const scriptName = scripts[key];
    if (typeof scriptName === "string") {
      result[key] = runScriptCommand(manager, key);
    }
  }
  return result;
}

function parsePackageJsonScripts(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      return null;
    }
    return scripts as Record<string, unknown>;
  } catch {
    return null;
  }
}

// A deliberately small reader for record 08's subset.

export interface ProjectFilePreview {
  readonly port: number;
  readonly health_path: string;
}

export interface ProjectFileCommands {
  readonly dev?: string;
  readonly test?: string;
  readonly lint?: string;
  readonly typecheck?: string;
  readonly build?: string;
}

/** Names only (record 08): a repository file says a secret is needed and never which stored value that means. */
export interface ProjectFileSecrets {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** A hostile file must not be able to fill the disclosure card. */
export const MAX_DECLARED_SECRETS = MAX_SECRETS;

export interface ProjectFile {
  readonly version?: number;
  readonly commands?: ProjectFileCommands;
  readonly preview?: ProjectFilePreview;
  readonly secrets?: ProjectFileSecrets;
}

export interface ProjectYamlError {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export type ProjectYamlResult =
  | { readonly kind: "ok"; readonly file: ProjectFile }
  | { readonly kind: "error"; readonly error: ProjectYamlError };

const TOP_LEVEL_KEYS = new Set(["version", "commands", "preview", "secrets"]);
const SECRET_LISTS = new Set(["required", "optional"]);
const NAME_REFUSALS = {
  malformed: "is not a secret name",
  reserved: "is reserved",
  platform_credential: "is a platform credential",
} as const;
const COMMAND_SUBKEYS = new Set(["dev", "test", "lint", "typecheck", "build"]);
const PREVIEW_SUBKEYS = new Set(["port", "health_path"]);

function fail(line: number, text: string, reason: string): ProjectYamlResult {
  return { kind: "error", error: { line, text, reason } };
}

/** `true` for a blank line or a `#`-prefixed comment. */
function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

function indentOf(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char !== " ") {
      break;
    }
    count += 1;
  }
  return count;
}

/** A list item's text before a ` #` comment. Safe only for secret names, which hold neither a space nor a `#`. */
function stripTrailingComment(text: string): string {
  const hash = text.search(/\s#/);
  return hash === -1 ? text : text.slice(0, hash);
}

/**
 * Splits `key: value` at the first colon (an empty value means a nested block
 * follows). Null when the key is empty or holds a space, quote, bracket, or
 * `#`, which the caller rejects.
 */
function splitKeyValue(
  content: string,
): { readonly key: string; readonly rawValue: string } | null {
  const colonIndex = content.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const key = content.slice(0, colonIndex).trim();
  const rest = content.slice(colonIndex + 1);
  if (key.length === 0 || /[\s"'[\]{}#]/.test(key)) {
    return null;
  }
  return { key, rawValue: rest.trim() };
}

/** A bare integer, or a double-quoted / single-quoted / bare string scalar. No flow sequences, no anchors. */
function parseScalar(
  rawValue: string,
):
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "integer"; readonly value: number }
  | null {
  if (rawValue.length === 0) {
    return null;
  }
  if (/^-?\d+$/.test(rawValue)) {
    return { kind: "integer", value: Number.parseInt(rawValue, 10) };
  }
  if (
    rawValue.startsWith("[") ||
    rawValue.startsWith("{") ||
    rawValue.startsWith("&") ||
    rawValue.startsWith("*")
  ) {
    return null;
  }
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2)
  ) {
    return { kind: "string", value: rawValue.slice(1, -1) };
  }
  if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
    return null;
  }
  return { kind: "string", value: rawValue };
}

/**
 * Reads the subset of YAML record 08's `.oncue/project.yaml` uses: `version`,
 * `commands` (dev, test, lint, typecheck, build), `preview` (port,
 * health_path), and `secrets` (`required` and `optional` name lists, the only
 * lists accepted). Anything else (anchors, aliases, flow collections, other
 * lists or keys, multiple documents) is rejected with its line number, never
 * guessed at: the file is untrusted, and a lenient reader is a
 * parser-differential surface.
 */
export function readProjectYaml(text: string): ProjectYamlResult {
  const lines = text.split("\n");
  let version: number | undefined;
  let commands: Record<string, string> | undefined;
  let preview: { port?: number; health_path?: string } | undefined;
  let secrets: { required: string[]; optional: string[] } | undefined;
  let section: "commands" | "preview" | "secrets" | null = null;
  /** The open list under `secrets`, and the indentation of the key that opened it. */
  let secretList: { readonly key: "required" | "optional"; readonly indent: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) {
      continue;
    }
    const lineNumber = index + 1;
    if (isBlankOrComment(rawLine)) {
      continue;
    }
    if (rawLine.startsWith("---") || rawLine.startsWith("...")) {
      return fail(lineNumber, rawLine, "multi-document markers are not supported");
    }
    const indent = indentOf(rawLine);
    const content = rawLine.slice(indent);
    if (section === "secrets" && indent > 0 && content.startsWith("-")) {
      // The one place a list is read: a name under `secrets.required` or
      // `secrets.optional`, indented deeper than the key that opened the list.
      if (secretList === null || indent <= secretList.indent) {
        return fail(
          lineNumber,
          rawLine,
          'a name must sit under "secrets.required" or "secrets.optional"',
        );
      }
      const name = stripTrailingComment(content.slice(1)).trim();
      if (name.length === 0) {
        return fail(lineNumber, rawLine, "a list item needs a name");
      }
      const refusal = refuseSecretName(name);
      if (refusal !== null) {
        return fail(lineNumber, rawLine, `"${name}" ${NAME_REFUSALS[refusal]}`);
      }
      // biome-ignore lint/style/noNonNullAssertion: secrets is assigned whenever section === "secrets"
      const declared = secrets!;
      if (declared.required.includes(name) || declared.optional.includes(name)) {
        return fail(lineNumber, rawLine, `"${name}" is declared twice`);
      }
      if (declared.required.length + declared.optional.length >= MAX_DECLARED_SECRETS) {
        return fail(lineNumber, rawLine, `at most ${MAX_DECLARED_SECRETS} secrets may be declared`);
      }
      declared[secretList.key].push(name);
      continue;
    }
    if (/^[-*&]/.test(content) || content.includes("<<")) {
      return fail(lineNumber, rawLine, "lists, anchors, and aliases are not supported");
    }
    const split = splitKeyValue(content);
    if (split === null) {
      return fail(lineNumber, rawLine, 'expected a "key: value" line');
    }
    const { key, rawValue } = split;

    if (indent === 0) {
      section = null;
      secretList = null;
      if (!TOP_LEVEL_KEYS.has(key)) {
        return fail(lineNumber, rawLine, `unknown top-level key "${key}"`);
      }
      if (key === "version") {
        const scalar = parseScalar(rawValue);
        if (scalar === null || scalar.kind !== "integer") {
          return fail(lineNumber, rawLine, '"version" must be an integer');
        }
        version = scalar.value;
        continue;
      }
      if (rawValue.length > 0) {
        return fail(lineNumber, rawLine, `"${key}" must introduce a nested block, not a scalar`);
      }
      if (key === "commands") {
        commands = {};
        section = "commands";
      } else if (key === "secrets") {
        secrets = { required: [], optional: [] };
        section = "secrets";
      } else {
        preview = {};
        section = "preview";
      }
      continue;
    }

    // A nested line, exactly one level deep; any deeper nesting, or an
    // indented line with no open section, is rejected.
    if (section === null) {
      return fail(lineNumber, rawLine, "unexpected indentation with no open section");
    }
    if (section === "secrets") {
      if (secretList !== null && indent > secretList.indent) {
        return fail(lineNumber, rawLine, 'expected a "- NAME" list item');
      }
      if (!SECRET_LISTS.has(key)) {
        return fail(lineNumber, rawLine, `unknown key "${key}" under "secrets"`);
      }
      if (rawValue.length > 0) {
        return fail(lineNumber, rawLine, `"secrets.${key}" must introduce a list, not a scalar`);
      }
      secretList = { key: key as "required" | "optional", indent };
      continue;
    }
    if (rawValue.length === 0) {
      return fail(lineNumber, rawLine, `"${key}" must have a scalar value`);
    }
    const scalar = parseScalar(rawValue);
    if (scalar === null) {
      return fail(lineNumber, rawLine, `could not read the value for "${key}"`);
    }
    if (section === "commands") {
      if (!COMMAND_SUBKEYS.has(key)) {
        return fail(lineNumber, rawLine, `unknown key "${key}" under "commands"`);
      }
      if (scalar.kind !== "string") {
        return fail(lineNumber, rawLine, `"commands.${key}" must be a string`);
      }
      // biome-ignore lint/style/noNonNullAssertion: commands is assigned above whenever section === "commands"
      commands![key] = scalar.value;
      continue;
    }
    if (!PREVIEW_SUBKEYS.has(key)) {
      return fail(lineNumber, rawLine, `unknown key "${key}" under "preview"`);
    }
    if (key === "port") {
      if (scalar.kind !== "integer") {
        return fail(lineNumber, rawLine, '"preview.port" must be an integer');
      }
      // biome-ignore lint/style/noNonNullAssertion: preview is assigned above whenever section === "preview"
      preview!.port = scalar.value;
      continue;
    }
    if (scalar.kind !== "string") {
      return fail(lineNumber, rawLine, '"preview.health_path" must be a string');
    }
    // biome-ignore lint/style/noNonNullAssertion: preview is assigned above whenever section === "preview"
    preview!.health_path = scalar.value;
  }

  const file: ProjectFile = {
    ...(version !== undefined ? { version } : {}),
    ...(commands !== undefined ? { commands: commands as ProjectFileCommands } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(preview !== undefined && preview.port !== undefined && preview.health_path !== undefined
      ? { preview: { port: preview.port, health_path: preview.health_path } }
      : {}),
  };
  return { kind: "ok", file };
}

// Precedence: file over detection over platform defaults.

export interface ResolvedCommands {
  readonly dev: Sourced<string | null>;
  readonly test: Sourced<string | null>;
  readonly lint: Sourced<string | null>;
  readonly typecheck: Sourced<string | null>;
  readonly build: Sourced<string | null>;
}

export interface ResolvedDefinition {
  readonly commands: ResolvedCommands;
  readonly preview: Sourced<ProjectFilePreview | null>;
}

const PLATFORM_DEFAULTS: DetectedCommands = {
  test: null,
  lint: null,
  typecheck: null,
  build: null,
  dev: null,
};

function resolveCommand(
  key: CommandKey,
  detected: DetectedCommands,
  file: ProjectFile | null,
): Sourced<string | null> {
  const fromFile = file?.commands?.[key];
  if (typeof fromFile === "string") {
    return sourced(fromFile, "repository_file");
  }
  const fromDetection = detected[key];
  if (fromDetection !== null) {
    return sourced(fromDetection, "detected");
  }
  return sourced(PLATFORM_DEFAULTS[key], "platform_default");
}

/**
 * Layers `.oncue/project.yaml` over `detect`'s proposal over the platform
 * default (`null`, no command), per record 08. Every field carries the layer
 * that answered it.
 */
export function resolve(detected: DetectedCommands, file: ProjectFile | null): ResolvedDefinition {
  return {
    commands: {
      dev: resolveCommand("dev", detected, file),
      test: resolveCommand("test", detected, file),
      lint: resolveCommand("lint", detected, file),
      typecheck: resolveCommand("typecheck", detected, file),
      build: resolveCommand("build", detected, file),
    },
    preview:
      file?.preview !== undefined
        ? sourced<ProjectFilePreview | null>(file.preview, "repository_file")
        : sourced<ProjectFilePreview | null>(null, "platform_default"),
  };
}

export const PROJECT_FILE_PATH = ".oncue/project.yaml";

const SOURCE_LABEL: Readonly<Record<ConfigurationSource, string>> = {
  platform_default: "platform default",
  detected: "detected",
  repository_file: PROJECT_FILE_PATH,
};

export const DESCRIBED_COMMAND_MAX_CHARS = 200;

/**
 * One line per resolved command with the layer that answered it, for the
 * bridge's log and the session's output; a preview is named when declared.
 */
export function describeDefinition(definition: ResolvedDefinition): string {
  const parts: string[] = [];
  for (const key of COMMAND_KEYS) {
    const command = definition.commands[key];
    if (command.value !== null) {
      // The file is the repository's, so its text is bounded before it enters
      // the session's committed output.
      const shown =
        command.value.length > DESCRIBED_COMMAND_MAX_CHARS
          ? `${command.value.slice(0, DESCRIBED_COMMAND_MAX_CHARS)}…`
          : command.value;
      parts.push(`${key} = ${shown} (${SOURCE_LABEL[command.source]})`);
    }
  }
  const preview = definition.preview.value;
  if (preview !== null) {
    parts.push(
      `preview on port ${preview.port} at ${preview.health_path} (${SOURCE_LABEL[definition.preview.source]})`,
    );
  }
  return parts.length === 0
    ? "environment definition: no commands resolved"
    : `environment definition: ${parts.join("; ")}`;
}
