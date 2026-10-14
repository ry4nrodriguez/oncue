/**
 * `/api/repositories` and the browser-facing half of record 07's connection
 * flow: the install link and GitHub's callback. Handlers parse, call
 * `worker/github/**`, and shape a `Response`; SQL, crypto, and authorization
 * live there.
 *
 * The callback is a GitHub-initiated GET, so the same-origin guard does not
 * apply; the signed OAuth `state` (`install-state.ts`) protects it instead. No
 * response carries a token, envelope, key, or GitHub error text; the callback
 * answers with a redirect and a reason that must stay in step with the
 * browser's `GitHubCallbackReason`.
 */

import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { deriveKeyring, type KeyringResult } from "../broker/envelope";
import type { GitHubAppDeps } from "../github/app";
import {
  buildInstallUrl,
  type CompleteInstallOutcome,
  completeInstall,
  type GitHubInstallDeps,
  type InstallRefusal,
} from "../github/install";
import { GITHUB_API_ORIGIN, GITHUB_WEB_ORIGIN, resolveGitHubOrigin } from "../github/origin";
import { listRepositoryConnections, setRepositoryRemoved } from "../github/store";

// A union, so a refusal without a browser sentence is a compile error.
export type CallbackReason =
  | "cancelled"
  | "pending_approval"
  | "not_visible"
  | "exchange_failed"
  | "state_invalid";

/**
 * A total map from `completeInstall`'s refusals onto what a person is told.
 * `state_rejected` and `state_not_callers` both become `state_invalid`, so a
 * stolen link's follower cannot learn it was genuine.
 */
const REFUSAL_REASON: Record<InstallRefusal, CallbackReason> = {
  state_rejected: "state_invalid",
  state_not_callers: "state_invalid",
  code_rejected: "exchange_failed",
  installation_not_visible: "not_visible",
  identity_linked_to_another_user: "not_visible",
};

const credentialKeyringCache = new Map<string | undefined, Promise<KeyringResult<"credential">>>();
const tokenKeyringCache = new Map<string | undefined, Promise<KeyringResult<"token">>>();

// HKDF plus `importKey` is real cost, so each keyring is derived once per
// distinct secret. Keying by the secret lets a test reach the unconfigured
// path with a different value.
function cachedKeyring<P extends "credential" | "token">(
  cache: Map<string | undefined, Promise<KeyringResult<P>>>,
  secret: string | undefined,
  purpose: P,
): Promise<KeyringResult<P>> {
  const cached = cache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveKeyring(secret, purpose);
  cache.set(secret, derived);
  return derived;
}

/**
 * Every setting the GitHub flow needs, or the reason it cannot run. One reader
 * for both the App and install dependencies, so origin resolution and the
 * bound `fetch` are done in one place.
 */
export type GitHubConfig =
  | {
      readonly kind: "configured";
      readonly deps: GitHubInstallDeps;
      readonly appDeps: GitHubAppDeps;
      readonly appSlug: string;
    }
  | { readonly kind: "unconfigured" };

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Every setting is required together: a flow that discovered a missing client
// secret at the token exchange would already have sent the user to GitHub.
export async function readGitHubConfig(env: Env): Promise<GitHubConfig> {
  const appSlug = nonEmpty(env.ONCUE_GITHUB_APP_SLUG);
  const appId = nonEmpty(env.ONCUE_GITHUB_APP_ID);
  const privateKeyPem = nonEmpty(env.ONCUE_GITHUB_APP_PRIVATE_KEY);
  const clientId = nonEmpty(env.ONCUE_GITHUB_CLIENT_ID);
  const clientSecret = nonEmpty(env.ONCUE_GITHUB_CLIENT_SECRET);
  if (
    appSlug === null ||
    appId === null ||
    privateKeyPem === null ||
    clientId === null ||
    clientSecret === null
  ) {
    return { kind: "unconfigured" };
  }

  const credential = await cachedKeyring(
    credentialKeyringCache,
    env.ONCUE_BROKER_KEYRING,
    "credential",
  );
  const token = await cachedKeyring(tokenKeyringCache, env.ONCUE_BROKER_KEYRING, "token");
  if (credential.kind !== "ok" || token.kind !== "ok") {
    return { kind: "unconfigured" };
  }

  // Bound, not the bare global: workerd throws "Illegal invocation" when `fetch`
  // loses its `this`, and unit tests that inject a closure never see it.
  const fetchImpl = fetch.bind(globalThis);
  const apiOrigin = resolveGitHubOrigin(
    GITHUB_API_ORIGIN,
    env.ONCUE_ENV,
    env.ONCUE_GITHUB_API_ORIGIN,
  );

  return {
    kind: "configured",
    appSlug,
    appDeps: {
      fetchImpl,
      apiOrigin,
      appId,
      privateKeyPem,
      now: () => Date.now(),
    },
    deps: {
      db: env.DB,
      credentialKeyring: credential.keyring,
      tokenKeyring: token.keyring,
      fetchImpl,
      apiOrigin,
      webOrigin: resolveGitHubOrigin(GITHUB_WEB_ORIGIN, env.ONCUE_ENV, env.ONCUE_GITHUB_API_ORIGIN),
      clientId,
      clientSecret,
      release: env.ONCUE_RELEASE,
      environment: env.ONCUE_ENV,
      now: () => new Date().toISOString(),
      nowMs: () => Date.now(),
      newId: () => `rc_${crypto.randomUUID()}`,
    },
  };
}

function denialResponse(reason: "unauthenticated" | "not_allowlisted"): Response {
  return Response.json({ error: reason }, { status: reason === "unauthenticated" ? 401 : 403 });
}

/** `GET /api/repositories`: every repository connection the caller's workspace has. */
export async function handleListRepositories(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const connections = await listRepositoryConnections(env.DB, actorWorkspaceId(outcome.actor));
  // Projected, not forwarded: internal ids are omitted so the browser cannot
  // enumerate them, and the status is the effective one, combining the row with
  // its installation, so the page never shows "Verified" for a repository that
  // `resolveRepository` would refuse.
  const repositories = connections.map(projectRepository);
  return Response.json({ repositories }, { status: 200 });
}

/** The six fields the browser parses, with the EFFECTIVE status (see the list route). */
function projectRepository(connection: {
  readonly repositoryConnectionId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly status: "verified" | "disconnected";
  readonly installationStatus: string;
  readonly removedAt: string | null;
  readonly createdAt: string;
}) {
  return {
    repositoryConnectionId: connection.repositoryConnectionId,
    fullName: connection.fullName,
    defaultBranch: connection.defaultBranch,
    status:
      connection.installationStatus === "active" ? connection.status : ("disconnected" as const),
    removedAt: connection.removedAt,
    createdAt: connection.createdAt,
  };
}

const REPOSITORY_REMOVE_PATH = /^\/api\/repositories\/([^/]+)$/;
const REPOSITORY_RESTORE_PATH = /^\/api\/repositories\/([^/]+)\/restore$/;

/** For `DELETE /api/repositories/:id`. */
export function extractRemoveRepositoryId(pathname: string): string | null {
  return REPOSITORY_REMOVE_PATH.exec(pathname)?.[1] ?? null;
}

/** For `POST /api/repositories/:id/restore`. */
export function extractRestoreRepositoryId(pathname: string): string | null {
  return REPOSITORY_RESTORE_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * Remove and restore a repository in OnCue (record 07). Neither touches
 * GitHub. A row that is not the caller's is "not found".
 */
export async function handleSetRepositoryRemoved(
  request: Request,
  env: Env,
  repositoryConnectionId: string,
  removed: boolean,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }
  const now = new Date().toISOString();
  const row = await setRepositoryRemoved(
    env.DB,
    actorWorkspaceId(outcome.actor),
    repositoryConnectionId,
    removed ? now : null,
    now,
  );
  if (row === null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ repository: projectRepository(row) }, { status: 200 });
}

/**
 * `POST /api/github/install-url`: a fresh install URL with a signed OAuth
 * `state` for this caller. A POST because it mints something, which also puts
 * it under the same-origin guard.
 */
export async function handleCreateInstallUrl(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }

  const installUrl = await buildInstallUrl(
    config.deps,
    {
      workspaceId: actorWorkspaceId(outcome.actor),
      userId: actorUserId(outcome.actor),
    },
    config.appSlug,
  );
  return Response.json({ installUrl }, { status: 201 });
}

const REPOSITORIES_PATH = "/repositories";

function redirectToRepositories(reason: CallbackReason | null): Response {
  const location =
    reason === null
      ? REPOSITORIES_PATH
      : `${REPOSITORIES_PATH}?github=${encodeURIComponent(reason)}`;
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * The outcome of `completeInstall` as a redirect. An upstream failure and a
 * refusal are both a reason on the query string; only `installed` returns the
 * user to a clean `/repositories`.
 */
function callbackRedirect(outcome: CompleteInstallOutcome): Response {
  if (outcome.kind === "installed") {
    return redirectToRepositories(null);
  }
  if (outcome.kind === "refused") {
    return redirectToRepositories(REFUSAL_REASON[outcome.reason]);
  }
  // Unreachable, rejected, or unreadable all mean "try again".
  return redirectToRepositories("exchange_failed");
}

/**
 * `GET /api/github/callback` (record 07). `setup_action=request` means an
 * organization admin must approve, so there is nothing to link; no `code`
 * means the user did not install; an `installation_id` that is not a positive
 * integer is treated as an invalid state. `completeInstall` checks the
 * signed-in workspace against the one the `state` was minted for.
 */
export async function handleGitHubCallback(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return denialResponse(outcome.reason);
  }

  const url = new URL(request.url);
  if (url.searchParams.get("setup_action") === "request") {
    return redirectToRepositories("pending_approval");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) {
    return redirectToRepositories("cancelled");
  }

  const installationId = Number(url.searchParams.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return redirectToRepositories("state_invalid");
  }

  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    return redirectToRepositories("exchange_failed");
  }

  const completed = await completeInstall(
    config.deps,
    {
      workspaceId: actorWorkspaceId(outcome.actor),
      userId: actorUserId(outcome.actor),
    },
    { code, state, installationId },
  );
  return callbackRedirect(completed);
}
