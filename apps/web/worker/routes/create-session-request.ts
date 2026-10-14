/**
 * The create-session request boundary. The browser sends only `commandId`,
 * `instruction`, and optional `skipRequiredChecks`, secret selection, branch
 * choice, and approval mode; the Worker supplies the model and every
 * other field itself, and re-reads the branch from GitHub, so none can be
 * forged.
 *
 * `instruction` is validated through the protocol's own
 * `parseCommandPayload("run.start", ...)`, so this file owns no limits of its
 * own. Session and run ids are UUIDv5 values derived from `commandId`, so a
 * retry after a lost response reaches the same session object, which dedupes
 * it. Workers have no native UUIDv5, so `uuidv5` implements it on SHA-1.
 */

import {
  type CommandPayloadOf,
  LIMITS,
  type ModelRecord,
  parseCommandPayload,
} from "@oncue/protocol";
import { isWorkableBranchName } from "../github/branches";

export type RunStartPayload = CommandPayloadOf<"run.start">;
export type Instruction = RunStartPayload["instruction"];

export interface CreateSessionRequest {
  readonly commandId: string;
  readonly instruction: Instruction;
  /** The user's request to skip the required checks. False when the body omits it. */
  readonly skipRequiredChecks: boolean;
  /**
   * What the user answered on the disclosure card, or null. Only a claim: the
   * Worker re-derives the launch from its own read of the project file at
   * `baseSha`.
   */
  readonly secrets: CreateSessionSecrets | null;
  /** Which branch the session works from, and how (record 07). */
  readonly branch: BranchChoice;
  /**
   * "Allow for this session" chosen on Home before the session existed
   * (record 09). `ask` when the body omits it; the workspace's `always` is
   * read from D1, never from the browser.
   */
  readonly approvalMode: "ask" | "session";
}

/**
 * `new_branch`: start from `name` (null for the repository's default branch)
 * and push to a new `oncue/` task branch. `existing_branch`: work directly on
 * `name`, an existing branch, and push there.
 */
export type BranchMode = "new_branch" | "existing_branch";

export interface BranchChoice {
  readonly name: string | null;
  readonly mode: BranchMode;
}

/** Omitted from the body: the default branch and a new task branch, as every session before the choice. */
export const DEFAULT_BRANCH_CHOICE: BranchChoice = { name: null, mode: "new_branch" };

function parseBranchChoice(raw: Record<string, unknown>): BranchChoice | "invalid" {
  const { branch, branchMode } = raw;
  const mode = branchMode === undefined ? "new_branch" : branchMode;
  if (mode !== "new_branch" && mode !== "existing_branch") {
    return "invalid";
  }
  if (branch === undefined || branch === null) {
    // Working directly on a branch needs one named; the default is refused anyway.
    return mode === "existing_branch" ? "invalid" : DEFAULT_BRANCH_CHOICE;
  }
  if (typeof branch !== "string" || !isWorkableBranchName(branch)) {
    return "invalid";
  }
  return { name: branch, mode };
}

export interface CreateSessionSecrets {
  /** The commit the card's declaration was read at. */
  readonly baseSha: string;
  readonly optional: readonly string[];
  readonly startWithoutMissing: boolean;
}

/** More names than a project file may declare is not a selection from one. */
const MAX_SELECTED_SECRETS = 20;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function parseSecrets(raw: unknown): CreateSessionSecrets | null | "invalid" {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPlainObject(raw)) {
    return "invalid";
  }
  const { baseSha, optional, startWithoutMissing } = raw;
  if (typeof baseSha !== "string" || !COMMIT_SHA.test(baseSha)) {
    return "invalid";
  }
  if (
    !Array.isArray(optional) ||
    optional.length > MAX_SELECTED_SECRETS ||
    !optional.every((name) => typeof name === "string" && name.length <= 64)
  ) {
    return "invalid";
  }
  if (startWithoutMissing !== undefined && typeof startWithoutMissing !== "boolean") {
    return "invalid";
  }
  return {
    baseSha,
    optional: [...new Set(optional as string[])],
    startWithoutMissing: startWithoutMissing === true,
  };
}

export type CreateSessionParse =
  | { readonly ok: true; readonly value: CreateSessionRequest }
  | { readonly ok: false; readonly reason: "not_an_object" }
  | { readonly ok: false; readonly reason: "command_id" }
  | { readonly ok: false; readonly reason: "skip_required_checks" }
  | { readonly ok: false; readonly reason: "secrets" }
  | { readonly ok: false; readonly reason: "branch" }
  | { readonly ok: false; readonly reason: "approval_mode" }
  | { readonly ok: false; readonly reason: "instruction"; readonly detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `model` is passed in, so the payload validated here carries the model
// `resolveModel` chose and this module depends on neither the sandbox nor the
// broker.
export function parseCreateSessionRequest(raw: unknown, model: ModelRecord): CreateSessionParse {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "not_an_object" };
  }
  const commandId = raw.commandId;
  if (
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    commandId.length > LIMITS.idChars
  ) {
    return { ok: false, reason: "command_id" };
  }
  const skipRequiredChecks = raw.skipRequiredChecks === undefined ? false : raw.skipRequiredChecks;
  if (typeof skipRequiredChecks !== "boolean") {
    return { ok: false, reason: "skip_required_checks" };
  }
  const secrets = parseSecrets(raw.secrets);
  if (secrets === "invalid") {
    return { ok: false, reason: "secrets" };
  }
  const branch = parseBranchChoice(raw);
  if (branch === "invalid") {
    return { ok: false, reason: "branch" };
  }
  const approvalMode = raw.approvalMode === undefined ? "ask" : raw.approvalMode;
  if (approvalMode !== "ask" && approvalMode !== "session") {
    return { ok: false, reason: "approval_mode" };
  }
  const parsed = parseCommandPayload("run.start", {
    instruction: raw.instruction,
    model,
    continuesRunId: null,
    skipRequiredChecks,
  });
  if (!parsed.ok) {
    return { ok: false, reason: "instruction", detail: parsed.detail };
  }
  return {
    ok: true,
    value: {
      commandId,
      instruction: parsed.value.instruction,
      skipRequiredChecks,
      secrets,
      branch,
      approvalMode,
    },
  };
}

/** First non-empty line, trimmed to 80 chars. Used for session_index.title. */
export function deriveSessionTitle(text: string): string {
  const firstNonEmptyLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstNonEmptyLine.trim().slice(0, 80);
}

const SESSION_ID_NAMESPACE = "7d6f9d2c-9d3b-5b1a-8f7e-2c4a1b6e9d10";
const RUN_ID_NAMESPACE = "3a1e5c7f-4b2d-5e9a-b6c3-8d2f7a1c4e90";

function parseUuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * RFC 4122 version 5: SHA-1 over the namespace bytes followed by the name's
 * UTF-8 bytes, truncated to 16 bytes, with the version nibble and the
 * variant bits overwritten before formatting as 8-4-4-4-12 hex.
 */
async function uuidv5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = parseUuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveSessionId(workspaceId: string, commandId: string): Promise<string> {
  return uuidv5(SESSION_ID_NAMESPACE, `${workspaceId}:${commandId}`);
}

export function deriveRunId(commandId: string): Promise<string> {
  return uuidv5(RUN_ID_NAMESPACE, commandId);
}
