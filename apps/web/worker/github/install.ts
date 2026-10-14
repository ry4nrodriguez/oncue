/**
 * Record 07's repository connection flow and the install URL that starts it.
 *
 * `completeInstall` verifies the signed `state`, exchanges the `code`, learns
 * who the token belongs to (`GET /user`) and what they can see
 * (`GET /user/installations`), and only then writes. Every redirect value is a
 * claim until GitHub repeats it for the user's own token; the
 * `installation_id` in particular can be spoofed.
 *
 * `verifyInstallation` runs before each session start: it refreshes the user
 * token when needed and confirms the user still reaches the installation.
 * Any failure marks the installation `unauthorized`; there is no fallback to
 * the App's own credentials.
 *
 * Tokens are opened for one request at a time and never returned, logged, or
 * stored unsealed; GitHub's `error_description` is never kept. Nothing here
 * reads `env`.
 */

import { type Keyring, openCredential, sealCredential } from "../broker/envelope";
import { isPlainObject, readStringField } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";
import { log } from "../log";
import { githubFetch, githubHeaders, type UpstreamFailure } from "./app";
import { githubTokenContext } from "./envelope-context";
import { checkInstallState, type InstallStateSubject, mintInstallState } from "./install-state";
import {
  ACCOUNT_TYPES,
  type AccountType,
  deriveInstallationRowId,
  type InstallationSummary,
  insertOrUpdateInstallation,
  linkGitHubIdentity,
  type RepositoryInput,
  readSealedInstallationTokens,
  replaceRepositoryConnections,
  setInstallationStatusByRowId,
  touchInstallationVerified,
  updateInstallationTokens,
} from "./store";

export interface GitHubInstallDeps {
  readonly db: D1Database;
  readonly credentialKeyring: Keyring<"credential">;
  /** Signs and checks the OAuth `state`; the same keyring `worker/broker/tokens.ts` signs with. */
  readonly tokenKeyring: Keyring<"token">;
  readonly fetchImpl: typeof fetch;
  /** Resolved by the route through `resolveGitHubOrigin`. REST calls go here. */
  readonly apiOrigin: string;
  /** The App install page and the OAuth token endpoint go here. */
  readonly webOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly release: string;
  readonly environment: string;
  readonly now: () => string;
  readonly nowMs: () => number;
  readonly newId: () => string;
}

// Record 07: re-verify after at most eight hours of continued work.
export const INSTALLATION_REVERIFY_INTERVAL_MS = 8 * 60 * 60 * 1000;

// A token this close to expiry is treated as expired, so it cannot fail under
// the session's first Git operation.
export const USER_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const OAUTH_TOKEN_PATH = "/login/oauth/access_token";

function readNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value !== "number") {
    return null;
  }
  return value;
}

function unreachable(): UpstreamFailure {
  return { kind: "failed", category: "unreachable", status: null };
}

function rejected(status: number): UpstreamFailure {
  return { kind: "failed", category: "rejected", status };
}

function malformedResponse(status: number): UpstreamFailure {
  return { kind: "failed", category: "malformed_response", status };
}

type JsonReply = { readonly kind: "ok"; readonly body: unknown } | UpstreamFailure;

// One user-token GET, parsed only as far as "200 with JSON"; each caller reads
// its own fields, and any malformation lands in `malformed_response`.
async function getJson(deps: GitHubInstallDeps, path: string, token: string): Promise<JsonReply> {
  const upstream = await githubFetch(deps.fetchImpl, `${deps.apiOrigin}${path}`, {
    headers: githubHeaders(token),
  });
  if (upstream === null) {
    return unreachable();
  }
  if (upstream.status !== 200) {
    return rejected(upstream.status);
  }
  const parsed = safeJsonParse(await upstream.text());
  if (!parsed.ok) {
    return malformedResponse(upstream.status);
  }
  return { kind: "ok", body: parsed.value };
}

interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly refreshExpiresInSeconds: number;
}

function tokenPairIn(body: Record<string, unknown>): TokenPair | null {
  const accessToken = readStringField(body, "access_token");
  if (accessToken === null) {
    return null;
  }
  const refreshToken = readStringField(body, "refresh_token");
  if (refreshToken === null) {
    return null;
  }
  const expiresInSeconds = readNumberField(body, "expires_in");
  if (expiresInSeconds === null) {
    return null;
  }
  const refreshExpiresInSeconds = readNumberField(body, "refresh_token_expires_in");
  if (refreshExpiresInSeconds === null) {
    return null;
  }
  return { accessToken, refreshToken, expiresInSeconds, refreshExpiresInSeconds };
}

type TokenExchange =
  | { readonly kind: "ok"; readonly pair: TokenPair }
  /** GitHub answered 200 with an `error` body: a bad or reused code, or a dead refresh token. */
  | { readonly kind: "rejected_by_github" }
  | UpstreamFailure;

/**
 * The one POST to `/login/oauth/access_token`, for both the code exchange and
 * the refresh (GitHub distinguishes them by `grant_type`). GitHub answers a
 * bad code or refresh token with 200 and an `error` body, so `error` is
 * checked first. `error_description` is never kept: it can echo the rejected
 * token.
 */
async function exchangeAtTokenEndpoint(
  deps: GitHubInstallDeps,
  grant: Readonly<Record<string, string>>,
): Promise<TokenExchange> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("user-agent", "oncue");
  const upstream = await githubFetch(deps.fetchImpl, `${deps.webOrigin}${OAUTH_TOKEN_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ client_id: deps.clientId, client_secret: deps.clientSecret, ...grant }),
  });
  if (upstream === null) {
    return unreachable();
  }
  if (upstream.status !== 200) {
    return rejected(upstream.status);
  }
  const parsed = safeJsonParse(await upstream.text());
  if (!parsed.ok) {
    return malformedResponse(upstream.status);
  }
  if (!isPlainObject(parsed.value)) {
    return malformedResponse(upstream.status);
  }
  if (readStringField(parsed.value, "error") !== null) {
    return { kind: "rejected_by_github" };
  }
  const pair = tokenPairIn(parsed.value);
  if (pair === null) {
    return malformedResponse(upstream.status);
  }
  return { kind: "ok", pair };
}

interface VerifiedUser {
  readonly id: number;
  readonly login: string;
}

function userIn(body: unknown): VerifiedUser | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const id = readNumberField(body, "id");
  if (id === null) {
    return null;
  }
  const login = readStringField(body, "login");
  if (login === null) {
    return null;
  }
  return { id, login };
}

/** The entries of `GET /user/installations`, still unparsed: only the one the redirect named is read. */
function installationsIn(body: unknown): readonly unknown[] | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const installations = body.installations;
  if (!Array.isArray(installations)) {
    return null;
  }
  return installations;
}

function isInstallationWithId(
  installationId: number,
): (entry: unknown) => entry is Record<string, unknown> {
  return (entry): entry is Record<string, unknown> =>
    isPlainObject(entry) && entry.id === installationId;
}

interface InstallationAccount {
  readonly login: string;
  readonly type: AccountType;
}

// Parsed rather than cast: GitHub's claim is going into the table, and a bad
// value must be a typed refusal before any row is written, not a CHECK error
// after.
function accountIn(entry: Record<string, unknown>): InstallationAccount | null {
  const account = entry.account;
  if (!isPlainObject(account)) {
    return null;
  }
  const login = readStringField(account, "login");
  if (login === null) {
    return null;
  }
  const type = readStringField(account, "type");
  if (type === null) {
    return null;
  }
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  return { login, type: type as AccountType };
}

function repositoryIn(entry: unknown): RepositoryInput | null {
  if (!isPlainObject(entry)) {
    return null;
  }
  const githubRepositoryId = readNumberField(entry, "id");
  if (githubRepositoryId === null) {
    return null;
  }
  const fullName = readStringField(entry, "full_name");
  if (fullName === null) {
    return null;
  }
  const defaultBranch = readStringField(entry, "default_branch");
  if (defaultBranch === null) {
    return null;
  }
  return { githubRepositoryId, fullName, defaultBranch };
}

// Every entry or none: linking the readable part of a list would silently show
// the user a subset of what they authorized.
/** GitHub's largest page. A user with more repositories than this needs a second request. */
export const REPOSITORIES_PAGE_SIZE = 100;
/** Enough for two thousand repositories; past it the listing stops rather than loops. */
export const REPOSITORIES_MAX_PAGES = 20;

// GitHub answers thirty repositories per page by default, so every page is
// read until one comes back short.
async function listInstallationRepositories(
  deps: GitHubInstallDeps,
  installationId: number,
  token: string,
): Promise<
  { readonly kind: "ok"; readonly repositories: readonly RepositoryInput[] } | UpstreamFailure
> {
  const all: RepositoryInput[] = [];
  for (let page = 1; page <= REPOSITORIES_MAX_PAGES; page += 1) {
    const reply = await getJson(
      deps,
      `/user/installations/${installationId}/repositories?per_page=${REPOSITORIES_PAGE_SIZE}&page=${page}`,
      token,
    );
    if (reply.kind === "failed") {
      return reply;
    }
    const repositories = repositoriesIn(reply.body);
    if (repositories === null) {
      return malformedResponse(200);
    }
    all.push(...repositories);
    if (repositories.length < REPOSITORIES_PAGE_SIZE) {
      break;
    }
  }
  return { kind: "ok", repositories: all };
}

function repositoriesIn(body: unknown): readonly RepositoryInput[] | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const entries = body.repositories;
  if (!Array.isArray(entries)) {
    return null;
  }
  const repositories: RepositoryInput[] = [];
  for (const entry of entries) {
    const repository = repositoryIn(entry);
    if (repository === null) {
      return null;
    }
    repositories.push(repository);
  }
  return repositories;
}

function expiryAfter(nowMs: number, seconds: number): string {
  return new Date(nowMs + seconds * 1000).toISOString();
}

interface SealedPair {
  readonly sealedUserToken: string;
  readonly sealedRefreshToken: string;
  readonly userTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

// Both tokens are sealed under `githubTokenContext`, which binds the
// installation row id into the AEAD tag, so the row id is derived first.
async function sealPair(
  deps: GitHubInstallDeps,
  installationRowId: string,
  workspaceId: string,
  pair: TokenPair,
  nowMs: number,
): Promise<SealedPair> {
  return {
    sealedUserToken: await sealCredential(
      deps.credentialKeyring,
      githubTokenContext(installationRowId, workspaceId, "user_token"),
      pair.accessToken,
    ),
    sealedRefreshToken: await sealCredential(
      deps.credentialKeyring,
      githubTokenContext(installationRowId, workspaceId, "refresh_token"),
      pair.refreshToken,
    ),
    userTokenExpiresAt: expiryAfter(nowMs, pair.expiresInSeconds),
    refreshTokenExpiresAt: expiryAfter(nowMs, pair.refreshExpiresInSeconds),
  };
}

/** What GitHub's redirect carried. Every field is a claim until the flow below confirms it. */
export interface InstallCallbackInput {
  readonly code: string;
  readonly state: string;
  readonly installationId: number;
}

export type InstallRefusal =
  /** `checkInstallState` refused: not ours, not fresh, or not a state at all. */
  | "state_rejected"
  /** Ours, but minted for a different workspace than the signed-in caller's. */
  | "state_not_callers"
  /** GitHub would not exchange the code: bad, expired, or already used. */
  | "code_rejected"
  /** The redirect named an installation the authenticated user cannot see. */
  | "installation_not_visible"
  /** This GitHub account is already the external identity of a different OnCue user. */
  | "identity_linked_to_another_user";

export type CompleteInstallOutcome =
  | {
      readonly kind: "installed";
      readonly installationRowId: string;
      readonly githubInstallationId: number;
      readonly githubUserId: number;
      readonly accountLogin: string;
      readonly repositories: readonly RepositoryInput[];
    }
  | { readonly kind: "refused"; readonly reason: InstallRefusal }
  | UpstreamFailure;

/**
 * Record 07's connection flow, in order. `subject` is the verified workspace
 * and user, never anything off the redirect.
 *
 * After `checkInstallState` (did we mint it, is it fresh), the workspace is
 * compared, because a genuine state replayed by another user would pass the
 * first check. The identity link is written before the installation, so
 * `linkGitHubIdentity` refusing a GitHub account owned by another OnCue user
 * leaves no installation row to undo.
 */
export async function completeInstall(
  deps: GitHubInstallDeps,
  subject: InstallStateSubject,
  input: InstallCallbackInput,
): Promise<CompleteInstallOutcome> {
  const nowMs = deps.nowMs();
  const state = await checkInstallState(deps.tokenKeyring, input.state, nowMs);
  if (state.kind === "rejected") {
    return { kind: "refused", reason: "state_rejected" };
  }
  if (state.claims.workspaceId !== subject.workspaceId) {
    return { kind: "refused", reason: "state_not_callers" };
  }

  const exchange = await exchangeAtTokenEndpoint(deps, { code: input.code });
  if (exchange.kind === "failed") {
    return exchange;
  }
  if (exchange.kind === "rejected_by_github") {
    return { kind: "refused", reason: "code_rejected" };
  }
  const { pair } = exchange;

  const userReply = await getJson(deps, "/user", pair.accessToken);
  if (userReply.kind === "failed") {
    return userReply;
  }
  const user = userIn(userReply.body);
  if (user === null) {
    return malformedResponse(200);
  }

  const installationsReply = await getJson(deps, "/user/installations", pair.accessToken);
  if (installationsReply.kind === "failed") {
    return installationsReply;
  }
  const installations = installationsIn(installationsReply.body);
  if (installations === null) {
    return malformedResponse(200);
  }
  // Record 07: the redirect's `installation_id` can be spoofed. Only the list
  // GitHub returned for the user's own token decides what they can see.
  const match = installations.find(isInstallationWithId(input.installationId));
  if (match === undefined) {
    log({
      timestamp: deps.now(),
      severity: "warn",
      service: "web-worker",
      release: deps.release,
      environment: deps.environment,
      operation: "github.install",
      result: "installation not visible to user",
    });
    return { kind: "refused", reason: "installation_not_visible" };
  }
  const account = accountIn(match);
  if (account === null) {
    return malformedResponse(200);
  }

  const listed = await listInstallationRepositories(deps, input.installationId, pair.accessToken);
  if (listed.kind === "failed") {
    return listed;
  }
  const repositories = listed.repositories;

  const now = deps.now();
  const linked = await linkGitHubIdentity(deps.db, subject.userId, user.id, now);
  if (linked === "linked_to_another_user") {
    return { kind: "refused", reason: "identity_linked_to_another_user" };
  }

  const installationRowId = await deriveInstallationRowId(
    subject.workspaceId,
    input.installationId,
  );
  const sealed = await sealPair(deps, installationRowId, subject.workspaceId, pair, nowMs);
  await insertOrUpdateInstallation(deps.db, {
    installationRowId,
    workspaceId: subject.workspaceId,
    githubInstallationId: input.installationId,
    githubUserId: user.id,
    accountLogin: account.login,
    accountType: account.type,
    ...sealed,
    now,
  });
  await replaceRepositoryConnections(deps.db, {
    workspaceId: subject.workspaceId,
    installationRowId,
    repositories,
    newId: deps.newId,
    now,
  });

  return {
    kind: "installed",
    installationRowId,
    githubInstallationId: input.installationId,
    githubUserId: user.id,
    accountLogin: account.login,
    repositories,
  };
}

export type VerifyRefusal =
  /** No such installation in this workspace. Another workspace's row reads the same. */
  | "not_found"
  /** Record 07 step 8. The row is `unauthorized`; the caller asks the user to reconnect GitHub. */
  | "reverification_required";

// The status for each refusal wherever a route answers
// `github_reverification_required`. `not_found` does not reveal that the
// installation belongs to someone else.
export const VERIFY_REFUSAL_STATUS: Readonly<Record<VerifyRefusal, number>> = {
  not_found: 403,
  reverification_required: 409,
};

export type VerifyInstallationOutcome =
  | { readonly kind: "verified"; readonly installation: InstallationSummary }
  | { readonly kind: "refused"; readonly reason: VerifyRefusal };

/**
 * Every failure after the row is read: marks it `unauthorized` (record 07)
 * and tells the caller to ask for reconnection. No fallback to the App's own
 * credentials, and only the category is logged.
 */
async function disable(
  deps: GitHubInstallDeps,
  installationRowId: string,
  errorCategory: string,
): Promise<VerifyInstallationOutcome> {
  await setInstallationStatusByRowId(deps.db, installationRowId, "unauthorized", deps.now());
  log({
    timestamp: deps.now(),
    severity: "warn",
    service: "web-worker",
    release: deps.release,
    environment: deps.environment,
    operation: "github.verify",
    result: "reverification required",
    errorCategory,
  });
  return { kind: "refused", reason: "reverification_required" };
}

type UsableToken =
  | { readonly kind: "ok"; readonly token: string }
  | { readonly kind: "unusable"; readonly errorCategory: string };

/**
 * Refreshes the user token. GitHub rotates the refresh token on every
 * exchange, so both envelopes are replaced before the new access token is
 * used. Plaintext exists only inside this function.
 */
async function refreshUserToken(
  deps: GitHubInstallDeps,
  installationRowId: string,
  workspaceId: string,
  sealedRefreshToken: string,
  nowMs: number,
): Promise<UsableToken> {
  const opened = await openCredential(
    deps.credentialKeyring,
    githubTokenContext(installationRowId, workspaceId, "refresh_token"),
    sealedRefreshToken,
  );
  if (opened.kind !== "ok") {
    return { kind: "unusable", errorCategory: `envelope_${opened.kind}` };
  }
  const exchange = await exchangeAtTokenEndpoint(deps, {
    grant_type: "refresh_token",
    refresh_token: opened.plaintext,
  });
  if (exchange.kind === "failed") {
    return { kind: "unusable", errorCategory: exchange.category };
  }
  if (exchange.kind === "rejected_by_github") {
    return { kind: "unusable", errorCategory: "refresh_rejected" };
  }
  const sealed = await sealPair(deps, installationRowId, workspaceId, exchange.pair, nowMs);
  await updateInstallationTokens(deps.db, installationRowId, sealed, deps.now());
  return { kind: "ok", token: exchange.pair.accessToken };
}

/**
 * Record 07 re-verification, called before each session start.
 *
 * A row verified within `INSTALLATION_REVERIFY_INTERVAL_MS` with a fresh user
 * token answers without a network call. A row that is not `active` is refused
 * and left as it is, keeping its more specific reason. Otherwise the user
 * token is refreshed if near expiry, then `GET /user/installations` must still
 * show the installation. Any failure, including an unreachable GitHub,
 * disables the row; the user reconnects to restore it.
 */
export async function verifyInstallation(
  deps: GitHubInstallDeps,
  workspaceId: string,
  installationRowId: string,
): Promise<VerifyInstallationOutcome> {
  const found = await readSealedInstallationTokens(deps.db, workspaceId, installationRowId);
  if (found.kind === "absent") {
    return { kind: "refused", reason: "not_found" };
  }
  const { installation } = found;
  if (installation.status !== "active") {
    return { kind: "refused", reason: "reverification_required" };
  }

  const nowMs = deps.nowMs();
  const tokenNearExpiry =
    nowMs >= Date.parse(found.userTokenExpiresAt) - USER_TOKEN_REFRESH_MARGIN_MS;
  const verifiedRecently =
    nowMs - Date.parse(installation.lastVerifiedAt) < INSTALLATION_REVERIFY_INTERVAL_MS;
  if (verifiedRecently && !tokenNearExpiry) {
    return { kind: "verified", installation };
  }

  let token: UsableToken;
  if (tokenNearExpiry) {
    if (nowMs >= Date.parse(found.refreshTokenExpiresAt)) {
      return disable(deps, installationRowId, "refresh_token_expired");
    }
    token = await refreshUserToken(
      deps,
      installationRowId,
      workspaceId,
      found.sealedRefreshToken,
      nowMs,
    );
  } else {
    const opened = await openCredential(
      deps.credentialKeyring,
      githubTokenContext(installationRowId, workspaceId, "user_token"),
      found.sealedUserToken,
    );
    token =
      opened.kind === "ok"
        ? { kind: "ok", token: opened.plaintext }
        : { kind: "unusable", errorCategory: `envelope_${opened.kind}` };
  }
  if (token.kind === "unusable") {
    return disable(deps, installationRowId, token.errorCategory);
  }

  const reply = await getJson(deps, "/user/installations", token.token);
  if (reply.kind === "failed") {
    return disable(deps, installationRowId, reply.category);
  }
  const installations = installationsIn(reply.body);
  if (installations === null) {
    return disable(deps, installationRowId, "malformed_response");
  }
  if (installations.find(isInstallationWithId(installation.githubInstallationId)) === undefined) {
    return disable(deps, installationRowId, "installation_not_visible");
  }

  const now = deps.now();
  await touchInstallationVerified(deps.db, installationRowId, now);
  return { kind: "verified", installation: { ...installation, lastVerifiedAt: now } };
}

/**
 * The install URL, `{webOrigin}/apps/{appSlug}/installations/new`, with a
 * freshly signed `state`. Minted per click and never embedded in `/api/me`,
 * which may be cached, so each state is fresh and not replayable across loads.
 */
export async function buildInstallUrl(
  deps: GitHubInstallDeps,
  subject: InstallStateSubject,
  appSlug: string,
): Promise<string> {
  const state = await mintInstallState(deps.tokenKeyring, subject, deps.nowMs());
  return `${deps.webOrigin}/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
}
