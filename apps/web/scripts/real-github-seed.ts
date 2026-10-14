/**
 * Writes the GitHub rows a live session needs for one real repository,
 * without a browser sign-in: `seed-local.ts --real-github-repo owner/name`.
 *
 * The App's install flow returns to the App's registered callback URL, which
 * names port 5173, so on any other port slot nobody can finish it. A session
 * needs much less than that flow: an active `github_installation` row naming
 * the App's installation, and a verified `repository_connection` row naming
 * the repository. Every clone, push, file read, and pull request then mints
 * its own installation token from the App's id and private key.
 *
 * What this cannot supply is the user-to-server token the install flow
 * exchanges a code for. The Worker uses it only to re-verify an installation
 * (`verifyInstallation`), and skips that for eight hours after
 * `last_verified_at`. So the rows are written verified now, with a sealed
 * marker in place of the user token whose expiry ends that same window, and
 * an already-expired refresh token. When the window closes the Worker marks
 * the installation `unauthorized` without calling GitHub, and running the
 * helper again restores it.
 *
 * GitHub calls, in order: the App JWT reads the repository's installation;
 * one installation token, narrowed to that repository with `metadata: read`,
 * reads its id and default branch from the mint's own answer and is revoked
 * at once. No token is printed, and the App's settings are never touched.
 */

import { deriveUserId, deriveWorkspaceId } from "../worker/auth/register";
import { deriveKeyring, sealCredential } from "../worker/broker/envelope";
import {
  type GitHubAppDeps,
  githubFetch,
  githubHeaders,
  mintAppJwt,
  revokeInstallationToken,
} from "../worker/github/app";
import { githubTokenContext } from "../worker/github/envelope-context";
import { INSTALLATION_REVERIFY_INTERVAL_MS } from "../worker/github/install";
import { GITHUB_API_ORIGIN } from "../worker/github/origin";
import { deriveInstallationRowId } from "../worker/github/store";

/** Sealed where the user token would be. Nothing ever opens it inside the window this helper sets. */
export const NO_USER_TOKEN_MARKER = "oncue-local-helper:no-user-token";

const REPOSITORY_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function parseRepositoryFlag(raw: string | undefined): {
  readonly owner: string;
  readonly name: string;
} {
  if (raw === undefined || !REPOSITORY_NAME.test(raw)) {
    throw new Error(
      `--real-github-repo needs a repository as owner/name, got ${raw === undefined ? "nothing" : `"${raw}"`}`,
    );
  }
  const [owner = "", name = ""] = raw.split("/");
  return { owner, name };
}

/**
 * A dotenv value as the Worker receives it: a double-quoted value has its
 * `\n` escapes expanded, which is how a PEM is stored on one line.
 */
export function dotenvValue(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replaceAll("\\n", "\n");
  }
  return raw;
}

export interface RealGitHubApp {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly apiOrigin: string;
}

/**
 * The real App from `.dev.vars.real`, refused unless the composed `.dev.vars`
 * names the same App: rows written for an App the running Worker does not use
 * could never mint a token there.
 */
export function realGitHubApp(
  real: ReadonlyMap<string, string>,
  composed: ReadonlyMap<string, string>,
): RealGitHubApp {
  const appId = dotenvValue(real.get("ONCUE_GITHUB_APP_ID"));
  const privateKeyPem = dotenvValue(real.get("ONCUE_GITHUB_APP_PRIVATE_KEY"));
  if (appId === undefined || appId === "" || privateKeyPem === undefined || privateKeyPem === "") {
    throw new Error(
      "apps/web/.dev.vars.real has no ONCUE_GITHUB_APP_ID and ONCUE_GITHUB_APP_PRIVATE_KEY; the helper needs the real App",
    );
  }
  if (dotenvValue(composed.get("ONCUE_GITHUB_APP_ID")) !== appId) {
    throw new Error(
      "apps/web/.dev.vars does not use the real GitHub App from .dev.vars.real; compose it with `pnpm dev:live` or `pnpm dev:real` first, or the rows would name an App the Worker does not use",
    );
  }
  const override = dotenvValue(composed.get("ONCUE_GITHUB_API_ORIGIN"));
  return {
    appId,
    privateKeyPem,
    apiOrigin: override === undefined || override.trim() === "" ? GITHUB_API_ORIGIN : override,
  };
}

export interface RealRepository {
  readonly installationId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly repositoryId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** Whether the one lookup token was revoked; it lapses within the hour either way. */
  readonly revoked: boolean;
}

async function jsonOf(answer: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await answer.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function field<T>(body: Record<string, unknown> | null, key: string, kind: string): T {
  const value = body?.[key];
  if (typeof value !== kind) {
    throw new Error(`GitHub's answer has no ${kind} ${key}`);
  }
  return value as T;
}

/**
 * The App's installation on `owner/name`, and the repository's id and default
 * branch. The token minted for the second read is revoked before returning,
 * whatever happened in between, and appears in no error.
 */
export async function lookUpRealRepository(
  deps: GitHubAppDeps,
  repository: { readonly owner: string; readonly name: string },
): Promise<RealRepository> {
  const signed = await mintAppJwt(deps);
  if (signed.kind !== "signed") {
    throw new Error(
      "the App private key in .dev.vars.real is not a PKCS#8 PEM the Worker can import",
    );
  }
  const fullName = `${repository.owner}/${repository.name}`;
  const located = await githubFetch(
    deps.fetchImpl,
    `${deps.apiOrigin}/repos/${fullName}/installation`,
    { method: "GET", headers: githubHeaders(signed.jwt) },
  );
  if (located === null) {
    throw new Error("GitHub did not answer the installation lookup");
  }
  if (located.status === 404) {
    throw new Error(`the App is not installed on ${fullName}; install it there once first`);
  }
  if (located.status !== 200) {
    throw new Error(`GitHub answered ${located.status} to the installation lookup`);
  }
  const installation = await jsonOf(located);
  const installationId = field<number>(installation, "id", "number");
  const account = installation?.account as Record<string, unknown> | null | undefined;
  const accountType = field<string>(account ?? null, "type", "string");
  if (accountType !== "User" && accountType !== "Organization") {
    throw new Error(`GitHub named an account type OnCue does not store: ${accountType}`);
  }

  const headers = githubHeaders(signed.jwt);
  headers.set("content-type", "application/json");
  const minted = await githubFetch(
    deps.fetchImpl,
    `${deps.apiOrigin}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        repositories: [repository.name],
        permissions: { metadata: "read" },
      }),
    },
  );
  if (minted === null) {
    throw new Error("GitHub did not answer the repository lookup");
  }
  if (minted.status !== 201) {
    throw new Error(`GitHub answered ${minted.status} to the repository lookup`);
  }
  const body = await jsonOf(minted);
  const token = typeof body?.token === "string" ? body.token : null;
  let revoked = false;
  let read: Omit<RealRepository, "revoked">;
  try {
    const listed = Array.isArray(body?.repositories) ? (body.repositories as unknown[]) : [];
    const found = listed.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).full_name === fullName,
    );
    if (found === undefined) {
      throw new Error(`GitHub's answer does not list ${fullName}`);
    }
    read = {
      installationId,
      accountId: field<number>(account ?? null, "id", "number"),
      accountLogin: field<string>(account ?? null, "login", "string"),
      accountType,
      repositoryId: field<number>(found, "id", "number"),
      fullName,
      defaultBranch: field<string>(found, "default_branch", "string"),
    };
  } finally {
    if (token !== null) {
      revoked = (await revokeInstallationToken(deps, token)).kind === "revoked";
    }
  }
  return { ...read, revoked };
}

function quote(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/**
 * The two rows, written as the install flow writes them: the installation
 * row's id derived as `completeInstall` derives it and the same upserts, so a
 * later real sign-in on slot 0 updates these rows rather than adding others.
 */
export async function realGitHubStatements(options: {
  readonly subject: string;
  readonly keyringSecret: string;
  readonly repository: RealRepository;
  readonly nowMs: number;
  /** An existing connection keeps its id, which sessions may hold. */
  readonly repositoryConnectionId: string;
}): Promise<{ readonly statements: string[]; readonly validUntil: string }> {
  const keyring = await deriveKeyring(options.keyringSecret, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("ONCUE_BROKER_KEYRING in .dev.vars is not a usable keyring");
  }
  const { repository } = options;
  const userId = await deriveUserId(options.subject);
  const workspaceId = await deriveWorkspaceId(options.subject);
  const installationRowId = await deriveInstallationRowId(workspaceId, repository.installationId);
  const now = new Date(options.nowMs).toISOString();
  const validUntil = new Date(options.nowMs + INSTALLATION_REVERIFY_INTERVAL_MS).toISOString();
  const userToken = await sealCredential(
    keyring.keyring,
    githubTokenContext(installationRowId, workspaceId, "user_token"),
    NO_USER_TOKEN_MARKER,
  );
  const refreshToken = await sealCredential(
    keyring.keyring,
    githubTokenContext(installationRowId, workspaceId, "refresh_token"),
    NO_USER_TOKEN_MARKER,
  );
  return {
    validUntil,
    statements: [
      `INSERT INTO user (id, status, created_at, updated_at) VALUES (${quote(userId)}, 'active', ${quote(now)}, ${quote(now)}) ON CONFLICT (id) DO NOTHING`,
      `INSERT INTO external_identity (provider, subject, user_id, created_at) VALUES ('clerk', ${quote(options.subject)}, ${quote(userId)}, ${quote(now)}) ON CONFLICT (provider, subject) DO NOTHING`,
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (${quote(workspaceId)}, ${quote(userId)}, 'private', ${quote(now)}, ${quote(now)}) ON CONFLICT (id) DO NOTHING`,
      `INSERT INTO workspace_member (workspace_id, user_id, role, created_at) VALUES (${quote(workspaceId)}, ${quote(userId)}, 'owner', ${quote(now)}) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      `INSERT INTO github_installation (installation_row_id, workspace_id, github_installation_id, github_user_id, account_login, account_type, status, user_token_reference, refresh_token_reference, user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at)
     VALUES (${quote(installationRowId)}, ${quote(workspaceId)}, ${repository.installationId}, ${repository.accountId}, ${quote(repository.accountLogin)}, ${quote(repository.accountType)}, 'active', ${quote(userToken)}, ${quote(refreshToken)}, ${quote(validUntil)}, ${quote(now)}, ${quote(now)}, ${quote(now)}, ${quote(now)})
     ON CONFLICT (workspace_id, github_installation_id) DO UPDATE SET github_user_id = excluded.github_user_id, account_login = excluded.account_login, account_type = excluded.account_type, status = 'active', user_token_reference = excluded.user_token_reference, refresh_token_reference = excluded.refresh_token_reference, user_token_expires_at = excluded.user_token_expires_at, refresh_token_expires_at = excluded.refresh_token_expires_at, last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
      `INSERT INTO repository_connection (repository_connection_id, workspace_id, installation_row_id, github_repository_id, full_name, default_branch, status, created_at, updated_at)
     VALUES (${quote(options.repositoryConnectionId)}, ${quote(workspaceId)}, ${quote(installationRowId)}, ${repository.repositoryId}, ${quote(repository.fullName)}, ${quote(repository.defaultBranch)}, 'verified', ${quote(now)}, ${quote(now)})
     ON CONFLICT (workspace_id, github_repository_id) DO UPDATE SET installation_row_id = excluded.installation_row_id, full_name = excluded.full_name, default_branch = excluded.default_branch, status = 'verified', updated_at = excluded.updated_at`,
    ],
  };
}
