/**
 * Maps each harness's permission asks onto OnCue's categories (record 09,
 * "Agent permissions"). Pure. An ask nothing here recognises is
 * `other_request`, which always asks the user and is never silently allowed.
 */

import type { ClassifiedAsk } from "./permissions";
import type { ToolCategory } from "./runtime";

/** One held call as the harness raised it, harness-neutral. */
export interface HarnessAsk {
  /** OpenCode's permission key, or Claude Code's tool name. */
  readonly permission: string;
  /** OpenCode's patterns (a path glob, a file, a tool name); empty where the harness gives none. */
  readonly patterns: readonly string[];
  /** OpenCode's metadata for the ask; empty where the harness gives none. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The held call's own input, where the harness sends it with the ask (Claude Code). */
  readonly input: Readonly<Record<string, unknown>> | null;
  /** The harness's tool behind the ask, when the bridge has seen its call; null when it has not. */
  readonly tool: string | null;
}

export interface ClassifyContext {
  /** The work tree; a path under it is inside the project. */
  readonly cwd: string;
  readonly toolCategory: (tool: string) => ToolCategory;
}

/**
 * OpenCode's own rule for secret files: a path ending `.env` or containing
 * `.env.`, except `.env.example`. Matched without regard to case, so `.ENV`
 * on a case-insensitive file system is a secret file too.
 */
export function isSecretFilePath(path: string): boolean {
  if (/\.env\.example$/i.test(path)) {
    return false;
  }
  return /\.env$/i.test(path) || /\.env\./i.test(path);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A glob like `/etc/*` names the directory it covers. */
function globDirectory(pattern: string): string {
  return pattern.replace(/\/?\*+$/, "") || "/";
}

/** Names shown before the rest are counted: the card has one line. */
const LISTED = 3;

/** Several paths on one line: the first few, and how many more. */
function listOf(items: readonly string[]): string {
  const shown = items.slice(0, LISTED).join(", ");
  return items.length > LISTED ? `${shown} (+${items.length - LISTED})` : shown;
}

/**
 * Something shaped like a path, not a command: absolute, home-relative, or
 * explicitly relative, on one line, with no spaces.
 */
function isPathLike(value: string): boolean {
  return /^(\/|~\/|\.{1,2}\/)/.test(value) && !/\s/.test(value);
}

/**
 * The path or address a call's input names, for a one-line summary. Never a
 * command, a search pattern, or a query (record 04: no raw command content),
 * and an address keeps only its origin and path, since a query string can
 * carry a token.
 */
function inputTarget(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "notebook_path", "path"]) {
    const value = text(record[key]);
    if (value !== null) {
      return value;
    }
  }
  const url = text(record.url);
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function toolCategoryOf(ask: HarnessAsk, ctx: ClassifyContext): ToolCategory | null {
  return ask.tool === null ? null : ctx.toolCategory(ask.tool);
}

function named(what: string, target: string | null): string {
  return target === null ? what : `${what}: ${target}`;
}

function other(ask: HarnessAsk, ctx: ClassifyContext): ClassifiedAsk {
  const paths = ask.patterns.filter(isPathLike);
  return {
    category: "other_request",
    resource: named(ask.permission, paths.length > 0 ? listOf(paths) : inputTarget(ask.input)),
    toolCategory: toolCategoryOf(ask, ctx),
  };
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/**
 * The paths an `external_directory` ask covers. A file tool names one file;
 * a shell command names every directory it reaches (`metadata.directories`),
 * and one "Allow once" answers for all of them, so the card lists them all.
 */
function outsidePaths(ask: HarnessAsk): string {
  const file = text(ask.metadata.filepath) ?? text(ask.metadata.filePath);
  if (file !== null) {
    return file;
  }
  const directories = stringList(ask.metadata.directories);
  const paths = directories.length > 0 ? directories : ask.patterns.map(globDirectory);
  return paths.length > 0 ? listOf(paths) : "a path outside the project";
}

/**
 * OpenCode's asks under OnCue's configuration: `external_directory` for a
 * path outside the project, `read` for a secret file (OnCue allows every
 * other read), `doom_loop` for the same call with the same input three
 * times in a row, and `task` for starting a subagent. A resource names the tool and its path, never a command.
 */
export function classifyOpenCodeAsk(ask: HarnessAsk, ctx: ClassifyContext): ClassifiedAsk {
  switch (ask.permission) {
    case "external_directory":
      return {
        category: "outside_project",
        resource: outsidePaths(ask),
        toolCategory: toolCategoryOf(ask, ctx),
      };
    case "read": {
      // The read tool names the file relative to the work tree. OpenCode also
      // asks `read` for an MCP resource, which is not a secret file.
      const path = text(ask.metadata.filepath) ?? text(ask.metadata.filePath) ?? ask.patterns[0];
      if (path === undefined || !isSecretFilePath(path)) {
        return other(ask, ctx);
      }
      return { category: "secret_file", resource: path, toolCategory: "file_read" };
    }
    case "task": {
      // The bridge forwards only the primary agent's start of a built-in
      // subagent within the run's limit; its description is the model's words.
      const name = ask.patterns[0] ?? "a";
      const description = text(ask.metadata.description);
      return {
        category: "start_subagent",
        resource: description === null ? `${name} subagent` : `${name} subagent: ${description}`,
        toolCategory: null,
      };
    }
    case "doom_loop": {
      const tool = text(ask.metadata.tool) ?? ask.patterns[0] ?? ask.tool ?? "a tool";
      return {
        category: "repeated_action",
        resource: named(tool, inputTarget(ask.metadata.input)),
        toolCategory: ctx.toolCategory(tool),
      };
    }
    default:
      return other(ask, ctx);
  }
}

const CLAUDE_PATH_TOOLS: Readonly<Record<string, ToolCategory>> = {
  Read: "file_read",
  NotebookRead: "file_read",
  Edit: "file_write",
  MultiEdit: "file_write",
  Write: "file_write",
  NotebookEdit: "file_write",
  Glob: "search",
  Grep: "search",
  LS: "search",
};

function isInside(path: string, cwd: string): boolean {
  if (/^[~$]/.test(path)) {
    // The shell expands these to the home directory or a variable.
    return false;
  }
  if (!path.startsWith("/")) {
    // Relative to the work tree, unless it climbs out of it.
    return !path.split("/").includes("..");
  }
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return (path === cwd || path.startsWith(root)) && !path.split("/").includes("..");
}

/**
 * Claude Code's `can_use_tool` asks: a file tool on a secret file (to read or
 * to write it), a file tool on a path outside the work tree, or anything else
 * Claude Code asks about. Under OnCue's flags the file tools are allowed by
 * name, so Claude Code raises only the last kind today (record 09).
 */
export function classifyClaudeAsk(ask: HarnessAsk, ctx: ClassifyContext): ClassifiedAsk {
  const toolCategory = CLAUDE_PATH_TOOLS[ask.permission];
  const input = ask.input ?? {};
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path) ?? null;
  if (toolCategory !== undefined && path !== null) {
    if (isSecretFilePath(path)) {
      return { category: "secret_file", resource: path, toolCategory };
    }
    if (!isInside(path, ctx.cwd)) {
      return { category: "outside_project", resource: path, toolCategory };
    }
  }
  return {
    category: "other_request",
    resource: named(ask.permission, inputTarget(input)),
    toolCategory: ctx.toolCategory(ask.permission),
  };
}

/** A harness whose gate holds only OnCue's own tools: anything else it raises asks the user. */
export function classifyOtherAsk(ask: HarnessAsk, ctx: ClassifyContext): ClassifiedAsk {
  return other(ask, ctx);
}
