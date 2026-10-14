/**
 * Session creation over HTTP (record 03). The Worker authorizes, derives the
 * session id, inserts `session_index` as `creating`, then calls the session
 * object, which is authoritative from then on and re-decides admission itself.
 *
 * A failed call to the object does not delete the `creating` row, because a
 * timeout is indistinguishable from a slow success; `sweepCreatingSessions`
 * removes stuck rows later. The row's workspace is the verified one from
 * `authorizeActor`, never a body field. `commandId` derives the session and
 * run ids, so a retried request reaches the same object.
 */

import { decideAdmission, readPlatformControl } from "../admission";
import { claimAttachments, releaseAttachments, releaseClaims } from "../attachments/store";
import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { type ResolveModelOutcome, resolveModel } from "../broker/connections";
import { checkStoredKey, KEY_CHECK_FRESH_MS } from "../broker/key-check";
import { allowedModels, modelAllowed } from "../broker/model-guard";
import { VERIFY_REFUSAL_STATUS, verifyInstallation } from "../github/install";
import { type ResolveRepositoryOutcome, resolveRepository } from "../github/repositories";
import { log } from "../log";
import type { ModalCredential } from "../modal/client";
import { openModalCredential } from "../modal/connections";
import { resolveRuntime } from "../runtime/resolve";
import { DEFAULT_FAKE_DRIVER, FAKE_DRIVER_MODEL, selectFakeDriver } from "../sandbox/fake-request";
import { readControllerConfig } from "../sandbox/origin";
import { judgeLaunch } from "../secrets/declaration";
import { readRepositoryDeclaration } from "../secrets/disclosure";
import { savedSecretNames, writeDisclosedNames } from "../secrets/store";
import type {
  CreateSessionRepository,
  CreateSessionSecretsRecord,
} from "../session/session-object";
import {
  type BranchChoice,
  type BranchMode,
  type CreateSessionSecrets,
  deriveRunId,
  deriveSessionId,
  deriveSessionTitle,
  parseCreateSessionRequest,
} from "./create-session-request";
import { cachedCredentialKeyring } from "./credential-keyring";
import { connectionDeps } from "./model-connections";
import { readGitHubConfig } from "./repositories";

export interface ObjectCaller {
  callCreate(sessionId: string, body: Record<string, unknown>): Promise<Response>;
}

export function realObjectCaller(env: Env): ObjectCaller {
  return {
    async callCreate(sessionId: string, body: Record<string, unknown>): Promise<Response> {
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch("https://session/internal/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

/**
 * How long a row may sit in `creating` before the sweep asks its object
 * whether it can be removed.
 */
export const CREATING_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;
// The most `creating` rows one sweep looks at, so each five-minute cron run has
// a fixed, bounded cost.
export const CREATING_SWEEP_BATCH = 100;

/**
 * A total table over refusal reasons, so a new reason is a compile error.
 * `not_usable` (403) covers both "no such connection" and "not yours" so ids
 * cannot be probed across workspaces; `not_active` (409) tells the owner to
 * replace their connection (record 06).
 */
const RESOLVE_REFUSAL_STATUS: Record<
  Extract<ResolveModelOutcome, { kind: "refused" }>["reason"],
  number
> = {
  malformed: 400,
  connection_required: 400,
  not_usable: 403,
  not_active: 409,
  model_unavailable: 400,
  effort_unsupported: 400,
};

/**
 * The repository twin of `RESOLVE_REFUSAL_STATUS`. `not_usable` (403) hides
 * whether the row exists; `not_connected` (409) tells the owner to reconnect
 * a removed repository or suspended installation (record 07).
 */
const REPOSITORY_REFUSAL_STATUS: Record<
  Extract<ResolveRepositoryOutcome, { kind: "refused" }>["reason"],
  number
> = {
  malformed: 400,
  not_usable: 403,
  not_connected: 409,
};

/**
 * The Git facts recorded on `session_index` and handed to the object so it can
 * mint the sandbox's git grant itself. Identifiers only; the App private key
 * stays in this Worker.
 */
interface TaskBranchRecord {
  readonly repositoryConnectionId: string | null;
  /** GitHub's id for the repository, which the branch hold is judged by across workspaces. */
  readonly githubRepositoryId: number | null;
  /** The existing branch the session works on directly, else null until the first push names one. */
  readonly taskBranch: string | null;
  /** The branch the base commit was read from (`session_index.base_branch`). */
  readonly baseBranch: string | null;
  readonly branchMode: BranchMode | null;
  readonly baseCommitSha: string | null;
  readonly repository: CreateSessionRepository | null;
  /** What the launch disclosed, as this Worker re-derived it. Null when the repository declares nothing. */
  readonly secrets: CreateSessionSecretsRecord | null;
}

const NO_REPOSITORY: TaskBranchRecord = {
  repositoryConnectionId: null,
  githubRepositoryId: null,
  taskBranch: null,
  baseBranch: null,
  branchMode: null,
  baseCommitSha: null,
  repository: null,
  secrets: null,
};

/**
 * Why a branch cannot be worked on directly (record 07). The default branch
 * and a protected branch (classic protection or a ruleset rule that guards
 * pushes) are never a session's to push to; `in_use` is another session
 * holding it, or `deleting` when that session is on its way to deletion and
 * still holds it until deletion removes its row; `missing` is a branch GitHub
 * no longer has; `unconfirmed` is
 * GitHub not answering for its rules.
 */
export type BranchRefusal =
  | "default"
  | "protected"
  | "in_use"
  | "deleting"
  | "missing"
  | "unconfirmed";

function refuseBranch(
  reason: BranchRefusal,
  extra: Readonly<Record<string, string>> = {},
  status = 409,
): Response {
  return Response.json({ error: "branch_refused", reason, ...extra }, { status });
}

/**
 * Another session of the same GitHub repository, in any workspace and any
 * state, whose branch this is. A session on its way to deletion still holds
 * it: its object can keep working until deletion closes it. Served by
 * `idx_session_index_task_branch`.
 */
export const BRANCH_HOLDER_SQL = `SELECT other.session_id AS session_id, other.workspace_id AS workspace_id, other.state AS state
   FROM session_index AS other
   JOIN repository_connection AS rc
     ON rc.repository_connection_id = other.repository_connection_id
  WHERE other.task_branch = ?1
    AND rc.github_repository_id = ?2
    AND other.session_id <> ?3
  LIMIT 1`;

/**
 * The refusal for a branch another session holds. The holder is named only
 * when it is the caller's own, so a session id never crosses workspaces.
 */
async function branchHeld(
  db: D1Database,
  input: {
    readonly branch: string;
    readonly githubRepositoryId: number;
    readonly sessionId: string;
    readonly workspaceId: string;
  },
): Promise<Response | null> {
  const holder = await db
    .prepare(BRANCH_HOLDER_SQL)
    .bind(input.branch, input.githubRepositoryId, input.sessionId)
    .first<{ session_id: string; workspace_id: string; state: string }>();
  if (holder === null) {
    return null;
  }
  // A session being deleted is not one to continue in, so it is not named.
  if (holder.state === "deletion_pending") {
    return refuseBranch("deleting");
  }
  return refuseBranch(
    "in_use",
    holder.workspace_id === input.workspaceId ? { sessionId: holder.session_id } : {},
  );
}

/** Why a launch was refused over its secrets, and the status each earns. */
const LAUNCH_REFUSAL_STATUS: Record<
  Extract<ReturnType<typeof judgeLaunch>, { kind: "refuse" }>["reason"],
  number
> = {
  // The repository declares secrets and the request carried no answer: the
  // browser shows the card and asks again.
  disclosure_required: 409,
  missing_required: 409,
  // A ticked name this Worker's own read does not back: a stale card or a
  // forged request.
  undeclared_name: 400,
  unsaved_name: 400,
};

type PrepareBranchOutcome =
  | { readonly kind: "ready"; readonly record: TaskBranchRecord }
  | { readonly kind: "refused"; readonly response: Response };

/**
 * Resolves the repository, re-verifies the installation, reads the
 * declaration, and records the base commit, all before the `session_index` row
 * exists, so every refusal writes nothing. The task branch is named later, at
 * the first push (record 07).
 */
async function prepareTaskBranch(
  env: Env,
  workspaceId: string,
  raw: unknown,
  selection: CreateSessionSecrets | null,
  choice: BranchChoice,
): Promise<PrepareBranchOutcome> {
  const resolved = await resolveRepository(env.DB, workspaceId, raw);
  if (resolved.kind === "refused") {
    return {
      kind: "refused",
      response: Response.json(
        { error: "invalid_request", reason: resolved.reason },
        { status: REPOSITORY_REFUSAL_STATUS[resolved.reason] },
      ),
    };
  }
  if (resolved.kind === "none") {
    // A branch names nothing without a repository to hold it.
    return choice.name === null
      ? { kind: "ready", record: NO_REPOSITORY }
      : {
          kind: "refused",
          response: Response.json({ error: "invalid_request", reason: "branch" }, { status: 400 }),
        };
  }

  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    // Refuse rather than create a session against a repository this deployment
    // could never push to.
    return {
      kind: "refused",
      response: Response.json({ error: "github_unconfigured" }, { status: 503 }),
    };
  }

  const repository = resolved.repository;
  const verified = await verifyInstallation(config.deps, workspaceId, repository.installationRowId);
  if (verified.kind === "refused") {
    return {
      kind: "refused",
      response: Response.json(
        { error: "github_reverification_required", reason: verified.reason },
        { status: VERIFY_REFUSAL_STATUS[verified.reason] },
      ),
    };
  }

  // Record 08: this Worker reads the declaration itself, at the commit the card
  // was drawn from, and judges the launch against it before anything is
  // created. The browser's selection is only a claim. The branch is the one the
  // user chose, read from GitHub under the same token.
  const existing = choice.mode === "existing_branch";
  const branchName = choice.name ?? repository.defaultBranch;
  const declared = await readRepositoryDeclaration(
    config.appDeps,
    {
      installationId: repository.githubInstallationId,
      repositoryId: repository.githubRepositoryId,
      fullName: repository.fullName,
      branch: branchName,
      readDefaultBranch: existing,
    },
    selection === null ? null : selection.baseSha,
  );
  if (
    declared.kind === "failed" &&
    declared.reason === "base_branch_missing" &&
    choice.name !== null
  ) {
    return { kind: "refused", response: refuseBranch("missing") };
  }
  if (declared.kind === "failed" && declared.reason === "branch_rules_unreadable") {
    // Fail closed: a branch GitHub would not say is unguarded is not pushed to.
    return { kind: "refused", response: refuseBranch("unconfirmed", {}, 502) };
  }
  if (declared.kind === "failed" || declared.declaration.kind === "unreadable") {
    // Never "declares nothing": that would start a session without the card.
    return {
      kind: "refused",
      response: Response.json({ error: "secrets_unreadable" }, { status: 502 }),
    };
  }
  // Record 07: a session never pushes to the default branch or a protected one.
  // The held check is the insert's own, so two creates cannot both take it.
  if (existing && declared.defaultBranch === branchName) {
    return { kind: "refused", response: refuseBranch("default") };
  }
  if (existing && declared.protected) {
    return { kind: "refused", response: refuseBranch("protected") };
  }
  const scope = { workspaceId, repositoryConnectionId: repository.repositoryConnectionId };
  // A file the reader refuses supplies nothing; the card has already shown its line and reason.
  const declaredSecrets =
    declared.declaration.kind === "declared" ? declared.declaration.secrets : null;
  const launch = judgeLaunch(
    declaredSecrets,
    declaredSecrets === null ? [] : await savedSecretNames(env.DB, scope),
    selection,
  );
  if (launch.kind === "refuse") {
    return {
      kind: "refused",
      response: Response.json(
        { error: "secrets_disclosure", reason: launch.reason, baseSha: declared.baseSha },
        { status: LAUNCH_REFUSAL_STATUS[launch.reason] },
      ),
    };
  }

  // Nothing is created on GitHub here. A branch that moved between the card and
  // this request is refused so the browser reads the card again at the new tip.
  if (selection !== null && selection.baseSha !== declared.tipSha) {
    return {
      kind: "refused",
      response: Response.json({ error: "base_moved", baseSha: declared.tipSha }, { status: 409 }),
    };
  }
  return {
    kind: "ready",
    record: {
      repositoryConnectionId: repository.repositoryConnectionId,
      githubRepositoryId: repository.githubRepositoryId,
      taskBranch: existing ? branchName : null,
      baseBranch: branchName,
      branchMode: choice.mode,
      baseCommitSha: declared.baseSha,
      repository: {
        installationId: repository.githubInstallationId,
        repositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        // Resolved as the install flow does, so a local session clones from the
        // GitHub double.
        cloneUrl: `${config.deps.webOrigin}/${repository.fullName}.git`,
        // Working directly on a branch: it already exists, so it is the session's
        // branch from the start and nothing names one at the first push.
        taskBranch: existing ? branchName : null,
        baseSha: declared.baseSha,
        // What a draft pull request targets: the chosen branch, or for a session
        // on an existing branch the default branch (an open pull request for the
        // branch is adopted with its own base).
        baseBranch: existing ? (declared.defaultBranch as string) : branchName,
        ...(existing ? { existingBranch: true } : {}),
      },
      // The user chose to start despite an unreadable file, which may have named a
      // required secret, so the session is degraded (record 08).
      secrets:
        declared.declaration.kind === "invalid"
          ? {
              baseSha: declared.baseSha,
              pinned: [],
              missingRequired: [],
              declarationInvalid: true,
            }
          : declaredSecrets === null
            ? null
            : {
                baseSha: declared.baseSha,
                pinned: launch.pinned,
                missingRequired: launch.missingRequired,
                declarationInvalid: false,
              },
    },
  };
}

/**
 * Whether a stored `session_index` row was created from the same branch
 * choice. A row from before migration 0018 carries no mode and is not judged.
 * A new task branch may have been named since, so only an existing branch's
 * name is compared.
 */
export function sameBranchChoice(
  row: {
    readonly repository_connection_id: string | null;
    readonly task_branch: string | null;
    readonly base_branch: string | null;
    readonly branch_mode: string | null;
  },
  branch: TaskBranchRecord,
): boolean {
  if (row.repository_connection_id !== branch.repositoryConnectionId) {
    return false;
  }
  if (row.branch_mode === null) {
    return true;
  }
  return (
    row.branch_mode === branch.branchMode &&
    row.base_branch === branch.baseBranch &&
    (branch.branchMode !== "existing_branch" || row.task_branch === branch.taskBranch)
  );
}

/**
 * Refuses a create that a hosted deployment could run only on a stand-in.
 * Locally the fake driver and the scripted model are how `pnpm dev`, the
 * end-to-end suite, and Vitest run sessions. Hosted, either would pass a
 * scripted transcript off as a real session, so the create is refused before
 * anything is written.
 *
 * `scriptedModel` is true when the workspace has no active model connection,
 * which would run a real sandbox behind the scripted model.
 */
export function refuseHostedStandIn(env: Env, scriptedModel: boolean): Response | null {
  // A plain string: `env.ONCUE_ENV` is typed as the literal "local".
  const envName: string = env.ONCUE_ENV;
  if (envName === "local") {
    return null;
  }
  if (readControllerConfig(env, envName).kind === "unconfigured") {
    // 503, like `github_unconfigured`: the operator has to fix the deployment.
    return Response.json({ error: "controller_unconfigured" }, { status: 503 });
  }
  if (scriptedModel) {
    return Response.json({ error: "model_connection_required" }, { status: 409 });
  }
  return null;
}

export type ModalCredentialOutcome =
  | { readonly kind: "ready"; readonly credential: ModalCredential | null }
  | { readonly kind: "refused"; readonly response: Response };

/**
 * Opens the workspace's Modal token pair in the Worker and passes it through
 * one call. The object never stores it; it opens its own copy when it needs a
 * driver with no request to carry one (cleanup, stop steps, the alarm's probe,
 * and a resume).
 *
 * A missing credential selects the fake driver only on a deployment with no
 * sandbox controller, which `refuseHostedStandIn` allows only locally. Where a
 * controller exists it is refused: the browser's
 * setup gate cannot be trusted to prevent a scripted transcript posing as a
 * real session. An envelope that will not open is always refused.
 */
export async function prepareModalCredential(
  env: Env,
  workspaceId: string,
): Promise<ModalCredentialOutcome> {
  // 409, not 400: the request is well-formed, but the workspace's state has to
  // change.
  const withoutCredential = (): ModalCredentialOutcome =>
    readControllerConfig(env, env.ONCUE_ENV).kind === "configured"
      ? {
          kind: "refused",
          response: Response.json({ error: "modal_connection_required" }, { status: 409 }),
        }
      : { kind: "ready", credential: null };

  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    // No keyring means no envelope can be opened, the same as no connection.
    return withoutCredential();
  }
  const opened = await openModalCredential(env.DB, keyringResult.keyring, workspaceId);
  if (opened.kind === "unusable") {
    return {
      kind: "refused",
      response: Response.json({ error: "modal_credential_unusable" }, { status: 503 }),
    };
  }
  if (opened.kind === "absent") {
    return withoutCredential();
  }
  return { kind: "ready", credential: opened.credential };
}

/**
 * Asks the provider about the chosen connection's key before anything is
 * created, so a key the provider has since refused costs no sandbox. Returns
 * the refusal, or `null` to go ahead.
 *
 * Only the provider's own rejection of the key refuses. A provider that is
 * slow, limiting, or unreachable says nothing about the key, and a key
 * validated in the last few minutes is not asked about again.
 */
export async function preflightModelKey(
  env: Env,
  workspaceId: string,
  model: { readonly provider: string; readonly modelConnectionId: string },
): Promise<Response | null> {
  const keyringResult = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyringResult.kind !== "ok") {
    // Nothing can be opened to check; the broker answers for it at the first request.
    return null;
  }
  const startedAt = Date.now();
  const checked = await checkStoredKey(
    connectionDeps(env, keyringResult.keyring),
    { workspaceId, connectionId: model.modelConnectionId },
    { freshForMs: KEY_CHECK_FRESH_MS },
  );
  // Logged so a slow send can be attributed to the key check, and a refused
  // one to what the provider said.
  log({
    timestamp: new Date().toISOString(),
    severity: "info",
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "api.sessions.create.key_check",
    result: checked.kind,
    provider: model.provider,
    durationMs: Date.now() - startedAt,
  });
  if (checked.kind === "rejected") {
    return Response.json(
      {
        error: "model_key_rejected",
        provider: model.provider,
        modelConnectionId: model.modelConnectionId,
      },
      { status: 409 },
    );
  }
  if (checked.kind === "absent" || checked.kind === "no_key") {
    // Revoked since `resolveModel` read it: the answer that read would give now.
    return Response.json(
      { error: "invalid_request", reason: "not_active" },
      { status: RESOLVE_REFUSAL_STATUS.not_active },
    );
  }
  return null;
}

export async function handleCreateSession(
  request: Request,
  env: Env,
  caller: ObjectCaller,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const startedAt = Date.now();
  const authOutcome = await authorizeActor(env, request, allowlistCache);
  if (authOutcome.kind === "denied") {
    const status = authOutcome.reason === "unauthenticated" ? 401 : 403;
    return Response.json({ error: authOutcome.reason }, { status });
  }
  const actor = authOutcome.actor;
  const workspaceId = actorWorkspaceId(actor);
  const ownerUserId = actorUserId(actor);

  const bodyText = await request.text();
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return Response.json({ error: "malformed_json" }, { status: 400 });
  }

  const resolved = await resolveModel(env.DB, workspaceId, raw);
  if (resolved.kind === "refused") {
    return Response.json(
      { error: "invalid_request", reason: resolved.reason },
      { status: RESOLVE_REFUSAL_STATUS[resolved.reason] },
    );
  }
  // The cost guard (model-guard.ts): a Worker pinned to certain models refuses
  // the rest and names which it allows.
  if (resolved.kind === "resolved") {
    const allowlist = (env as { readonly ONCUE_MODEL_ALLOWLIST?: string | undefined })
      .ONCUE_MODEL_ALLOWLIST;
    if (!modelAllowed(env.ONCUE_ENV, allowlist, resolved.model.modelId)) {
      return Response.json(
        {
          error: "invalid_request",
          reason: "model_not_allowed",
          allowed: [...(allowedModels(env.ONCUE_ENV, allowlist) ?? [])],
        },
        { status: 403 },
      );
    }
  }
  const model = resolved.kind === "fake" ? FAKE_DRIVER_MODEL : resolved.model;

  // The harness (runtime/resolve.ts) must be one the image installs and the
  // deployment allows, able to drive this model's provider at its effort.
  // Refused, never swapped.
  const runtime = resolveRuntime({
    requested: (raw as { readonly runtime?: unknown }).runtime,
    allowlist: (env as { readonly ONCUE_RUNTIME_ALLOWLIST?: string | undefined })
      .ONCUE_RUNTIME_ALLOWLIST,
    provider: model.provider,
    effort: model.effort ?? null,
  });
  if (runtime.kind === "refused") {
    return Response.json(
      { error: "invalid_request", reason: `runtime_${runtime.reason}`, detail: runtime.detail },
      { status: runtime.reason === "not_allowed" ? 403 : 400 },
    );
  }

  const parsed = parseCreateSessionRequest(raw, model);
  if (!parsed.ok) {
    return Response.json({ error: "invalid_request", reason: parsed.reason }, { status: 400 });
  }

  const fakeDriver = selectFakeDriver(raw, env.ONCUE_ENV);
  if (fakeDriver.kind === "refused") {
    return Response.json({ error: "invalid_request", reason: "fake_driver" }, { status: 400 });
  }
  const driverRequest = fakeDriver.kind === "scripted" ? fakeDriver.request : DEFAULT_FAKE_DRIVER;
  const standIn = refuseHostedStandIn(env, resolved.kind === "fake");
  if (standIn !== null) {
    return standIn;
  }

  const control = await readPlatformControl(env.DB);
  const decision = decideAdmission(control, {
    workspaceActiveSandboxCount: 0,
    platformActiveSandboxCount: 0,
  });
  if (decision.kind === "refuse") {
    const message =
      decision.reason === "admission_stopped"
        ? "admission stopped"
        : `admission refused: ${decision.reason}`;
    return Response.json({ error: message }, { status: 503 });
  }

  const {
    commandId,
    instruction,
    skipRequiredChecks,
    secrets: selection,
    branch: branchChoice,
    approvalMode,
  } = parsed.value;

  // After admission, so a workspace over its cap never reaches GitHub or the
  // model provider, and before the `session_index` insert, so a refusal leaves
  // no row. The three are independent and run in parallel, so the key check
  // adds little to the repository read.
  const githubStartedAt = Date.now();
  let githubMs = 0;
  const [prepared, modal, keyRefusal] = await Promise.all([
    prepareTaskBranch(env, workspaceId, raw, selection, branchChoice).then((outcome) => {
      githubMs = Date.now() - githubStartedAt;
      return outcome;
    }),
    prepareModalCredential(env, workspaceId),
    resolved.kind === "resolved" ? preflightModelKey(env, workspaceId, resolved.model) : null,
  ]);
  // First, because a rejected key has already been marked invalid and the
  // user has to act on it whatever else was wrong.
  if (keyRefusal !== null) {
    return keyRefusal;
  }
  if (prepared.kind === "refused") {
    return prepared.response;
  }
  const branch = prepared.record;
  if (modal.kind === "refused") {
    return modal.response;
  }

  const sessionId = await deriveSessionId(workspaceId, commandId);
  const runId = await deriveRunId(commandId);
  const title = deriveSessionTitle(instruction.text);
  const now = new Date().toISOString();
  // Refused before the attachments are claimed, so a branch already held costs
  // nothing. The insert below repeats the check atomically.
  const held =
    branch.taskBranch === null || branch.githubRepositoryId === null
      ? null
      : await branchHeld(env.DB, {
          branch: branch.taskBranch,
          githubRepositoryId: branch.githubRepositoryId,
          sessionId,
          workspaceId,
        });
  if (held !== null) {
    return held;
  }
  // Attachments are claimed for the new session before anything else is
  // written, and the message carries the Worker's record of each. A retry
  // derives the same session id, so its claim finds them already claimed.
  const claimed = await claimAttachments(env.DB, {
    workspaceId,
    sessionId,
    attachmentIds: instruction.attachments.map((ref) => ref.artifactId),
    now,
  });
  if (claimed.kind === "refused") {
    return Response.json(
      { error: "invalid_request", reason: "attachments", detail: claimed.detail },
      { status: 400 },
    );
  }
  // One statement, so the branch hold is judged and taken together: at most one
  // session of a repository holds a branch (record 07). A session with no
  // existing branch binds a null branch, which no row matches.
  const inserted = await env.DB.prepare(
    `INSERT INTO session_index (
       session_id, workspace_id, task_id, state, title,
       repository_connection_id, task_branch, base_commit_sha, model_connection_id,
       runtime, base_branch, branch_mode, created_at, updated_at
     )
     SELECT ?1, ?2, ?3, 'creating', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
      WHERE NOT EXISTS (
        SELECT 1 FROM session_index AS other
          JOIN repository_connection AS rc
            ON rc.repository_connection_id = other.repository_connection_id
         WHERE other.task_branch = ?6
           AND rc.github_repository_id = ?13
           AND other.session_id <> ?1)
     ON CONFLICT (session_id) DO NOTHING`,
  )
    .bind(
      sessionId,
      workspaceId,
      null,
      title,
      branch.repositoryConnectionId,
      branch.taskBranch,
      branch.baseCommitSha,
      // The connection the session's runs charge, for the Model providers page's
      // session count. The fake driver charges nothing.
      resolved.kind === "fake" ? null : model.modelConnectionId,
      runtime.runtime.id,
      branch.baseBranch,
      branch.branchMode,
      now,
      branch.githubRepositoryId,
    )
    .run();
  if (inserted.meta.changes === 0) {
    // Nothing written: a retry of this same session (its row is there), or
    // another session took the branch since the check above.
    const mine = await env.DB.prepare(
      "SELECT repository_connection_id, task_branch, base_branch, branch_mode FROM session_index WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{
        repository_connection_id: string | null;
        task_branch: string | null;
        base_branch: string | null;
        branch_mode: string | null;
      }>();
    if (mine === null) {
      // Another create took the branch after this one claimed its uploads.
      await releaseAttachments(env.DB, sessionId);
      return (
        (await branchHeld(env.DB, {
          branch: branch.taskBranch as string,
          githubRepositoryId: branch.githubRepositoryId as number,
          sessionId,
          workspaceId,
        })) ?? refuseBranch("in_use")
      );
    }
    // The same command id reaches the same session, so a retry naming another
    // repository or branch would otherwise be answered as if it were the first.
    if (!sameBranchChoice(mine, branch)) {
      return Response.json({ error: "invalid_request", reason: "command_reused" }, { status: 409 });
    }
  }

  let response: Response;
  try {
    response = await caller.callCreate(sessionId, {
      sessionId,
      workspaceId,
      taskId: null,
      ownerUserId,
      title,
      commandId,
      issuedAt: now,
      instruction: { ...instruction, attachments: [...claimed.refs] },
      model,
      runtime: runtime.runtime,
      continuesRunId: null,
      skipRequiredChecks,
      ...(approvalMode === "session" ? { approvalMode } : {}),
      mintedRunId: runId,
      scriptName: driverRequest.scriptName,
      framePacingMs: driverRequest.framePacingMs,
      taskBranch: branch.taskBranch,
      baseCommitSha: branch.baseCommitSha,
      repository:
        branch.repository === null
          ? null
          : // Where a pull request's "open the session" link leads: this Worker, as the browser reached it.
            { ...branch.repository, appOrigin: new URL(request.url).origin },
      redactionSecrets: [],
      secrets: branch.secrets,
      driverFailures: {},
      modalCredential: modal.credential,
    });
  } catch {
    // The `creating` row stays for the sweep: see the module comment.
    return Response.json(
      { error: "failed to reach the session object", sessionId },
      { status: 502 },
    );
  }
  if (!response.ok) {
    return Response.json(
      { error: "the session object rejected creation", sessionId },
      { status: 502 },
    );
  }
  if (branch.secrets !== null && branch.repositoryConnectionId !== null) {
    // Remembered so the next card can mark new names. A failure here fails no
    // launch.
    await writeDisclosedNames(
      env.DB,
      { workspaceId, repositoryConnectionId: branch.repositoryConnectionId },
      branch.secrets.pinned.map((entry) => entry.name),
      now,
    ).catch(() => undefined);
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (result.plan === "deleted") {
    // A delete reached the object first, perhaps of this very session on an
    // earlier try with the same command id. Nothing was made, so the row this
    // request wrote goes too (never one a deletion still owns).
    const removed = await env.DB.prepare(CREATING_DELETE_SQL).bind(sessionId).run();
    if (removed.meta.changes > 0) {
      // Its uploads go back to the workspace, so the unclaimed sweep removes
      // them instead of leaving them on a session nothing will delete. Only
      // when this request's own row went: a row still `deletion_pending`
      // belongs to a deletion whose job finds these uploads by their claim.
      await releaseClaims(env.DB, {
        workspaceId,
        sessionId,
        attachmentIds: instruction.attachments.map((ref) => ref.artifactId),
      });
    }
    return Response.json({ error: "session_deleted", sessionId }, { status: 410 });
  }
  const status = result.plan === "already_processed" ? 200 : 201;
  // Logged so a slow send can be attributed to the declaration read.
  const stamp = {
    timestamp: new Date().toISOString(),
    severity: "info" as const,
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    sessionId,
  };
  log({
    ...stamp,
    operation: "api.sessions.create",
    result: String(status),
    durationMs: Date.now() - startedAt,
  });
  log({
    ...stamp,
    operation: "api.sessions.create.declaration",
    result: "read",
    durationMs: githubMs,
  });
  return Response.json({ sessionId, ...result }, { status });
}

/**
 * The inner select walks the partial index `idx_session_index_creating_sweep`
 * and the delete finds rows by primary key; `sessions.test.ts` asserts both
 * query plans so a lost index fails a test instead of scanning.
 */
/** The oldest stuck `creating` rows, through the partial index `idx_session_index_creating_sweep`. */
export const CREATING_SWEEP_SQL = `SELECT session_id FROM session_index
   WHERE state = 'creating' AND created_at < ?
   ORDER BY created_at
   LIMIT ?`;

/** One stuck row, by key, and only while it is still `creating`. */
export const CREATING_DELETE_SQL =
  "DELETE FROM session_index WHERE session_id = ? AND state = 'creating'";

/** Asks a session's object whether it ever committed the session. Throws when it cannot tell. */
export type SessionProbe = (sessionId: string) => Promise<boolean>;

export function realSessionProbe(env: Env): SessionProbe {
  return async (sessionId) => {
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const response = await stub.fetch("https://session/internal/exists", { method: "POST" });
    if (!response.ok) {
      throw new Error(`the session object answered ${response.status}`);
    }
    return ((await response.json()) as { exists: boolean }).exists;
  };
}

/**
 * Removes rows stuck in `creating` only once their object confirms it never
 * committed a session. An object that did has a projection still owed, which
 * the probe retries; an object that cannot answer keeps its row for the next
 * run. Returns how many rows went.
 */
export async function sweepCreatingSessions(
  db: D1Database,
  probe: SessionProbe,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - CREATING_SWEEP_MAX_AGE_MS).toISOString();
  const stuck = await db
    .prepare(CREATING_SWEEP_SQL)
    .bind(cutoff, CREATING_SWEEP_BATCH)
    .all<{ session_id: string }>();
  let removed = 0;
  for (const { session_id: sessionId } of stuck.results) {
    const exists = await probe(sessionId).catch(() => true);
    if (exists) {
      continue;
    }
    const result = await db.prepare(CREATING_DELETE_SQL).bind(sessionId).run();
    removed += result.meta.changes;
  }
  return removed;
}
