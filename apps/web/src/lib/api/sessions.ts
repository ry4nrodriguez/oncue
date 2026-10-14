import { type ArtifactRef, type EffortLevel, RUN_STATES, type RunState } from "@oncue/protocol";

// Each call splits a pure status-to-result parser from `fetch` so it is
// tested without a network. `HomeRoute` switches on `CreateSessionResult` to
// decide whether the composer clears its draft.

export type RefusalReason = "admission_stopped" | "admission_refused";

/** Why the Worker would not let a session work directly on a branch (record 07). */
export type BranchRefusal =
  | "default"
  | "protected"
  | "in_use"
  | "deleting"
  | "missing"
  | "unconfirmed";

/**
 * Why the Worker would not start on the chosen model. Each means the composer's
 * list of models is out of date, so Home reads it again.
 */
export type ModelRefusal =
  /** The provider refused the stored key when the Worker asked, just now. */
  | "key_rejected"
  /** The chosen connection was revoked or marked invalid since the list was read. */
  | "not_active"
  /** The request named no connection, but the workspace has one by now. */
  | "connection_required"
  /** A hosted Worker starts no session without an active model connection. */
  | "none_connected";

/** The providers a refusal can name; anything else reads as `null`. */
export type RefusedProvider = "anthropic" | "openai";

/** How a session uses its branch: push to a new `oncue/` branch, or to the chosen one itself. */
export type BranchMode = "new_branch" | "existing_branch";

export type CreateSessionResult =
  | { readonly kind: "created"; readonly sessionId: string }
  | {
      readonly kind: "branch_refused";
      readonly reason: BranchRefusal;
      /** The caller's own session that holds the branch, for `in_use`; never another workspace's. */
      readonly sessionId: string | null;
    }
  /** The branch moved on GitHub after the disclosure card was read: read it again at the new tip. */
  | { readonly kind: "base_moved" }
  | {
      readonly kind: "model_refused";
      readonly reason: ModelRefusal;
      /** The provider that rejected the key, when the Worker named one. */
      readonly provider: RefusedProvider | null;
    }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly error: string | null }
  | { readonly kind: "denied" }
  | { readonly kind: "invalid"; readonly error: string | null }
  | { readonly kind: "unreachable" };

export const REFUSAL_COPY: Record<RefusalReason, string> = {
  admission_stopped: "New sessions are paused right now. Try again shortly.",
  admission_refused: "OnCue can't start a new session right now. Try again in a moment.",
};

// The Worker's `error` codes for a refused create (`worker/routes/sessions.ts`),
// as sentences for the composer. An unknown code falls back to the status's line.
const CREATE_ERROR_COPY: Record<string, string> = {
  modal_connection_required: "Connect your Modal account before starting a session.",
  modal_credential_unusable:
    "Your Modal connection can't be opened. Reconnect Modal in settings, then try again.",
  controller_unconfigured:
    "This deployment has no working sandbox controller, so it can't start a session. Whoever runs it needs to set the controller's https origin and token.",
  github_unconfigured:
    "This deployment has no GitHub App configured, so it can't create a task branch.",
  github_reverification_required:
    "GitHub needs to verify your access again. Reconnect GitHub, then try again.",
  "failed to reach the session object": "OnCue couldn't start the session. Try again in a moment.",
  "the session object rejected creation":
    "OnCue couldn't start the session. Try again in a moment.",
  secrets_unreadable:
    "OnCue couldn't read what this repository asks for, so it didn't start a session without showing you. Try again in a moment.",
  secrets_disclosure:
    "What this repository asks for changed while you were deciding. Send again to see it.",
  invalid_request:
    "OnCue couldn't start this session with what was selected. Pick the repository and model again.",
  session_deleted:
    "The session this message started was deleted, so nothing was sent. Send it again to start a new one.",
  command_reused:
    "This message was already sent with a different repository or branch. Send it again to start a new session.",
  model_not_allowed: "That model isn't enabled here. Pick another model and try again.",
};

export const BRANCH_REFUSAL_COPY: Record<BranchRefusal, string> = {
  default:
    "A session can't work directly on the repository's default branch. Start a new branch from it instead.",
  protected:
    "That branch is protected on GitHub, so a session can't push to it. Start a new branch from it instead.",
  in_use:
    "Another session is already working on that branch. Continue there, or start a new branch from it.",
  deleting:
    "A session being deleted still holds this branch. It is released when the deletion finishes.",
  missing: "That branch is no longer on GitHub. Pick another one.",
  unconfirmed:
    "GitHub couldn't confirm that branch can be pushed to, so OnCue didn't start working on it. Try again in a moment.",
};

const PROVIDER_NAME: Record<RefusedProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** What to say when the chosen model could not be started on; Home links to Settings beside it. */
export function modelRefusalCopy(reason: ModelRefusal, provider: RefusedProvider | null): string {
  switch (reason) {
    case "key_rejected":
      return `${provider === null ? "The provider" : PROVIDER_NAME[provider]} rejected this key. Replace it in Settings or pick another model.`;
    case "not_active":
      return "That model's key was removed or is no longer accepted. Pick a model again, or add a key in Settings.";
    case "connection_required":
      return "Your model keys changed since this page loaded. Pick a model and send again.";
    case "none_connected":
      return "Add a model key in Settings before starting a session.";
  }
}

export const BASE_MOVED_COPY =
  "The branch moved on GitHub while you were deciding. Check what it asks for and send again.";

export function createFailureCopy(
  result: Exclude<CreateSessionResult, { kind: "created" }>,
): string {
  switch (result.kind) {
    case "branch_refused":
      return BRANCH_REFUSAL_COPY[result.reason];
    case "base_moved":
      return BASE_MOVED_COPY;
    case "model_refused":
      return modelRefusalCopy(result.reason, result.provider);
    case "refused":
      return (
        (result.error === null ? undefined : CREATE_ERROR_COPY[result.error]) ??
        REFUSAL_COPY[result.reason]
      );
    case "invalid":
      return (
        (result.error === null ? undefined : CREATE_ERROR_COPY[result.error]) ??
        CREATE_ERROR_COPY.invalid_request ??
        ""
      );
    case "denied":
      return "You're signed out. Sign in again to start a session.";
    case "unreachable":
      return "OnCue couldn't reach the server. Check your connection and try again.";
  }
}

export interface SessionListRow {
  readonly sessionId: string;
  readonly title: string | null;
  readonly state: "active" | "archived";
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  /** `null` for a session created without a repository. */
  readonly repositoryFullName: string | null;
  /** The branch the session pushes to, or `null` before the first push names one or without a repository. */
  readonly taskBranch: string | null;
  /**
   * The branch the session started from, or `null` without a repository or on
   * a session from before the choice, which started from the default branch.
   */
  readonly baseBranch?: string | null;
  /** `existing_branch` when the session works directly on `taskBranch`. Absent reads as `new_branch`. */
  readonly branchMode?: BranchMode;
  /** A card is waiting on the user. Read as false when absent from an older response. */
  readonly waitingForUser: boolean;
  /** The harness the session runs. Absent from older responses. */
  readonly runtime?: string;
  /**
   * The current run and its last projected state, for the sidebar's status
   * dot. Absent or unknown values are `null` so the row shows no status
   * rather than failing the list.
   */
  readonly currentRunId: string | null;
  readonly currentRunState: RunState | null;
}

function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export type ListSessionsResult =
  | { readonly kind: "listed"; readonly sessions: readonly SessionListRow[] }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refusalReasonFrom(body: unknown): RefusalReason {
  const error: unknown = isRecord(body) ? body.error : undefined;
  if (typeof error === "string" && error.includes("stopped")) {
    return "admission_stopped";
  }
  return "admission_refused";
}

function errorCodeFrom(body: unknown): string | null {
  const error: unknown = isRecord(body) ? body.error : undefined;
  return typeof error === "string" ? error : null;
}

/**
 * Why the Worker refused the request itself, as opposed to the person: its
 * `invalid_request` names a reason, such as a model this deployment does not
 * enable. `null` for every other body, a denied sign-in among them.
 */
function refusedRequestReason(body: unknown): string | null {
  if (!isRecord(body) || body.error !== "invalid_request") {
    return null;
  }
  return typeof body.reason === "string" ? body.reason : "invalid_request";
}

/**
 * A refusal about the chosen model, whatever its status: the key the provider
 * rejected, a connection that is revoked, invalid, gone, or newly required, or
 * none at all where a hosted Worker requires one.
 */
function modelRefusalFrom(
  body: unknown,
): Extract<CreateSessionResult, { kind: "model_refused" }> | null {
  if (!isRecord(body)) {
    return null;
  }
  if (body.error === "model_connection_required") {
    return { kind: "model_refused", reason: "none_connected", provider: null };
  }
  if (body.error === "model_key_rejected") {
    const provider = body.provider;
    return {
      kind: "model_refused",
      reason: "key_rejected",
      provider: provider === "anthropic" || provider === "openai" ? provider : null,
    };
  }
  if (body.error !== "invalid_request") {
    return null;
  }
  // `not_usable` is an id the workspace no longer has, which reads the same to the person.
  if (body.reason === "not_active" || body.reason === "not_usable") {
    return { kind: "model_refused", reason: "not_active", provider: null };
  }
  if (body.reason === "connection_required") {
    return { kind: "model_refused", reason: "connection_required", provider: null };
  }
  return null;
}

/** Pure. 201 and 200 (the idempotent retry) both become `created`. Never throws. */
export function parseCreateSessionResponse(status: number, body: unknown): CreateSessionResult {
  if (status === 201 || status === 200) {
    const sessionId: unknown = isRecord(body) ? body.sessionId : undefined;
    if (typeof sessionId === "string") {
      return { kind: "created", sessionId };
    }
    return { kind: "unreachable" };
  }
  if (status === 400 || status === 403 || status === 409) {
    const modelRefusal = modelRefusalFrom(body);
    if (modelRefusal !== null) {
      return modelRefusal;
    }
  }
  // A 403 can also refuse what was chosen, which signing in again cannot fix.
  const refusedReason = status === 403 ? refusedRequestReason(body) : null;
  if (refusedReason !== null) {
    return { kind: "invalid", error: refusedReason };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if ((status === 409 || status === 502) && isRecord(body) && body.error === "branch_refused") {
    const reason = body.reason;
    if (
      reason === "default" ||
      reason === "protected" ||
      reason === "in_use" ||
      reason === "deleting" ||
      reason === "missing" ||
      reason === "unconfirmed"
    ) {
      return {
        kind: "branch_refused",
        reason,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      };
    }
  }
  if (status === 409 && isRecord(body) && body.error === "base_moved") {
    return { kind: "base_moved" };
  }
  // Any other 400 or 409 maps to `invalid`, so the composer keeps the draft.
  // 410: a retried send whose session was deleted meanwhile. The composer
  // drops the command id on any refusal, so sending again makes a new one.
  if (status === 400 || status === 409 || status === 410) {
    // A reused command id is the one refusal whose reason the composer words itself.
    const reused = isRecord(body) && body.reason === "command_reused";
    return { kind: "invalid", error: reused ? "command_reused" : errorCodeFrom(body) };
  }
  // 502 means a provider or the session object failed the Worker. The server
  // was reached, so its code is reported rather than "unreachable".
  if (status === 502 || status === 503) {
    return { kind: "refused", reason: refusalReasonFrom(body), error: errorCodeFrom(body) };
  }
  return { kind: "unreachable" };
}

/**
 * `modelConnectionId` is only a reference: the Worker re-checks ownership and
 * status and builds the run's model record itself. Omitted with no active
 * connection, in which case a local Worker runs the fake driver and a hosted
 * one refuses with `model_connection_required`.
 */
export async function createSession(input: {
  commandId: string;
  text: string;
  modelConnectionId?: string | undefined;
  /** A catalog id for the connection's provider; absent means its recommended model. */
  modelId?: string | undefined;
  /** The first run's effort; absent means the model's default, `null` a model with none. */
  effort?: EffortLevel | null | undefined;
  /** The harness the session runs; absent means the Worker's default. */
  runtime?: string | undefined;
  repositoryConnectionId?: string | undefined;
  /**
   * The branch the session works from: absent for the repository's default
   * branch. With `branchMode: "existing_branch"` the session pushes to it.
   */
  branch?: string | undefined;
  branchMode?: BranchMode | undefined;
  /** The first message's uploaded attachments; the Worker claims them for the new session. */
  attachments?: readonly ArtifactRef[] | undefined;
  /** Skip required checks on the first run. Sent only when true. */
  skipRequiredChecks?: boolean | undefined;
  /** "Allow for this session" chosen on Home (record 09). Sent only when set. */
  approvalMode?: "session" | undefined;
  /**
   * The disclosure card's answer: the commit it was read at and secret names,
   * never values. The Worker re-derives the launch and refuses a mismatch.
   * Omitted when the repository asks for nothing.
   */
  secrets?:
    | {
        readonly baseSha: string;
        readonly optional: readonly string[];
        readonly startWithoutMissing: boolean;
      }
    | undefined;
}): Promise<CreateSessionResult> {
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: input.commandId,
        instruction: {
          messageId: input.commandId,
          text: input.text,
          attachments: [...(input.attachments ?? [])],
        },
        ...(input.modelConnectionId === undefined
          ? {}
          : { modelConnectionId: input.modelConnectionId }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        ...(input.repositoryConnectionId === undefined
          ? {}
          : { repositoryConnectionId: input.repositoryConnectionId }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.branchMode === undefined ? {} : { branchMode: input.branchMode }),
        ...(input.skipRequiredChecks === true ? { skipRequiredChecks: true } : {}),
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    return parseCreateSessionResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}

function parseSessionRow(raw: unknown): SessionListRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const sessionId: unknown = raw.sessionId;
  const title: unknown = raw.title;
  const state: unknown = raw.state;
  const lastActivityAt: unknown = raw.lastActivityAt;
  const createdAt: unknown = raw.createdAt;
  const repositoryFullName: unknown = raw.repositoryFullName;
  const taskBranch: unknown = raw.taskBranch;
  const waitingForUser: unknown = raw.waitingForUser ?? false;
  const currentRunId: unknown = raw.currentRunId ?? null;
  if (typeof sessionId !== "string") {
    return null;
  }
  if (title !== null && typeof title !== "string") {
    return null;
  }
  if (state !== "active" && state !== "archived") {
    return null;
  }
  if (lastActivityAt !== null && typeof lastActivityAt !== "string") {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  if (repositoryFullName !== null && typeof repositoryFullName !== "string") {
    return null;
  }
  if (taskBranch !== null && typeof taskBranch !== "string") {
    return null;
  }
  if (typeof waitingForUser !== "boolean") {
    return null;
  }
  if (currentRunId !== null && typeof currentRunId !== "string") {
    return null;
  }
  const row: SessionListRow = {
    sessionId,
    title,
    state,
    lastActivityAt,
    createdAt,
    repositoryFullName,
    taskBranch,
    waitingForUser,
    currentRunId,
    currentRunState: isRunState(raw.currentRunState) ? raw.currentRunState : null,
  };
  const withRuntime = typeof raw.runtime === "string" ? { ...row, runtime: raw.runtime } : row;
  // Older Workers send neither field; a row reads as the default branch then.
  return {
    ...withRuntime,
    ...(typeof raw.baseBranch === "string" ? { baseBranch: raw.baseBranch } : {}),
    ...(raw.branchMode === "existing_branch" ? { branchMode: "existing_branch" as const } : {}),
  };
}

/** Pure. Never throws. */
export function parseListSessionsResponse(status: number, body: unknown): ListSessionsResult {
  if (status === 200) {
    const rawSessions: unknown = isRecord(body) ? body.sessions : undefined;
    if (!Array.isArray(rawSessions)) {
      return { kind: "unreachable" };
    }
    const sessions: SessionListRow[] = [];
    for (const item of rawSessions) {
      const row = parseSessionRow(item);
      if (row === null) {
        return { kind: "unreachable" };
      }
      sessions.push(row);
    }
    return { kind: "listed", sessions };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

export async function listSessions(): Promise<ListSessionsResult> {
  try {
    const response = await fetch("/api/sessions");
    const body: unknown = await response.json().catch(() => null);
    return parseListSessionsResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}

export type StopSandboxResult =
  | { readonly kind: "stopped"; readonly generation: number }
  /** The stop is under way but has not ended the sandbox yet. */
  | { readonly kind: "stopping"; readonly generation: number }
  | { readonly kind: "not_running" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unreachable" };

/** Pure. `POST /api/sessions/:id/sandbox/stop`'s answers, never throws. */
export function parseStopSandboxResponse(status: number, body: unknown): StopSandboxResult {
  if (status === 200 || status === 202) {
    const generation: unknown = isRecord(body) ? body.generation : undefined;
    if (typeof generation !== "number") {
      return { kind: "unreachable" };
    }
    return status === 200 ? { kind: "stopped", generation } : { kind: "stopping", generation };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 409) {
    return { kind: "not_running" };
  }
  if (status === 502) {
    const message: unknown = isRecord(body) ? body.message : undefined;
    return {
      kind: "failed",
      message: typeof message === "string" ? message : "The sandbox could not be stopped.",
    };
  }
  return { kind: "unreachable" };
}

export async function stopSandbox(sessionId: string): Promise<StopSandboxResult> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sandbox/stop`, {
      method: "POST",
    });
    const body: unknown = await response.json().catch(() => null);
    return parseStopSandboxResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}

export type DeleteSessionResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed" }
  | { readonly kind: "unreachable" };

/** Pure. `DELETE /api/sessions/:id` answers 202 once the session is closed and queued for erasure. */
export function parseDeleteSessionResponse(status: number): DeleteSessionResult {
  if (status === 202 || status === 200) {
    return { kind: "deleted" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 502) {
    return { kind: "failed" };
  }
  return { kind: "unreachable" };
}

export async function deleteSession(sessionId: string): Promise<DeleteSessionResult> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    return parseDeleteSessionResponse(response.status);
  } catch {
    return { kind: "unreachable" };
  }
}

export type ArchiveSessionResult =
  | { readonly kind: "changed"; readonly state: "active" | "archived" }
  /** A run is still open; archiving cancels it, so the user is asked first. */
  | { readonly kind: "run_open" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed" }
  | { readonly kind: "unreachable" };

/** Pure. The archive and unarchive routes' answers, never throws. */
export function parseArchiveSessionResponse(status: number, body: unknown): ArchiveSessionResult {
  if (status === 200) {
    const state: unknown = isRecord(body) ? body.state : undefined;
    return state === "active" || state === "archived"
      ? { kind: "changed", state }
      : { kind: "unreachable" };
  }
  if (status === 409) {
    return { kind: "run_open" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 502) {
    return { kind: "failed" };
  }
  return { kind: "unreachable" };
}

async function postArchive(url: string, body: unknown): Promise<ArchiveSessionResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json().catch(() => null);
    return parseArchiveSessionResponse(response.status, parsed);
  } catch {
    return { kind: "unreachable" };
  }
}

/** Archives the session; `cancelOpenRun` is the user's confirmation that its open run may end. */
export function archiveSession(
  sessionId: string,
  cancelOpenRun: boolean,
): Promise<ArchiveSessionResult> {
  return postArchive(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { cancelOpenRun });
}

export function unarchiveSession(sessionId: string): Promise<ArchiveSessionResult> {
  return postArchive(`/api/sessions/${encodeURIComponent(sessionId)}/unarchive`, {});
}

export type KeepSandboxAliveResult =
  | { readonly kind: "kept"; readonly expiresAt: string }
  | { readonly kind: "not_running" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

/** Pure. `POST /api/sessions/:id/sandbox/keep-alive`'s answers, never throws. */
export function parseKeepSandboxAliveResponse(
  status: number,
  body: unknown,
): KeepSandboxAliveResult {
  if (status === 200) {
    const expiresAt: unknown = isRecord(body) ? body.expiresAt : undefined;
    return typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))
      ? { kind: "kept", expiresAt }
      : { kind: "unreachable" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 409) {
    return { kind: "not_running" };
  }
  return { kind: "unreachable" };
}

/** Holds the running sandbox open for another hour of the user's own compute. */
export async function keepSandboxAlive(sessionId: string): Promise<KeepSandboxAliveResult> {
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/sandbox/keep-alive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const body: unknown = await response.json().catch(() => null);
    return parseKeepSandboxAliveResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}

export type FetchArtifactResult =
  | { readonly kind: "fetched"; readonly blob: Blob }
  | { readonly kind: "unavailable" };

/** `GET /api/sessions/:id/artifacts/:artifactId`. Anything but a 200 is "unavailable". Never throws. */
export async function fetchArtifact(
  sessionId: string,
  artifactId: string,
): Promise<FetchArtifactResult> {
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
    if (response.status !== 200) {
      return { kind: "unavailable" };
    }
    return { kind: "fetched", blob: await response.blob() };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * A file at the session's base commit (`GET /api/sessions/:id/files?path=`,
 * record 13). The Worker reads it from GitHub and decides its kind.
 */
export type SessionFileResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly blob: Blob }
  | { readonly kind: "binary" }
  | { readonly kind: "too_large"; readonly size: number | null }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_a_file" }
  | { readonly kind: "reconnect_github" }
  | { readonly kind: "unavailable" };

/** Where a file at the base commit is read, or downloaded whole. */
export function sessionFileUrl(sessionId: string, path: string, download = false): string {
  const query = new URLSearchParams({ path });
  if (download) {
    query.set("download", "1");
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/files?${query.toString()}`;
}

/** Never throws: a dropped connection, or an answer it does not know, is `unavailable`. */
export async function fetchSessionFile(
  sessionId: string,
  path: string,
): Promise<SessionFileResult> {
  try {
    const response = await fetch(sessionFileUrl(sessionId, path));
    if (response.status === 200) {
      const kind = response.headers.get("x-oncue-file-kind");
      if (kind === "text") {
        return { kind: "text", text: await response.text() };
      }
      if (kind === "image") {
        return { kind: "image", blob: await response.blob() };
      }
      return { kind: "binary" };
    }
    const body = (await response.json().catch(() => null)) as {
      readonly error?: unknown;
      readonly size?: unknown;
    } | null;
    if (response.status === 413) {
      return { kind: "too_large", size: typeof body?.size === "number" ? body.size : null };
    }
    if (response.status === 404 && body?.error === "not_found") {
      return { kind: "not_found" };
    }
    if (response.status === 422) {
      return { kind: "not_a_file" };
    }
    if (body?.error === "github_reverification_required") {
      return { kind: "reconnect_github" };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
