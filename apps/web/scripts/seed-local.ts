/**
 * Seeds the local D1 with a connected workspace, so `pnpm dev` lands on Home
 * ready to send a task.
 *
 * Credentials are sealed with the Worker's own `sealCredential` under the same
 * contexts and keyring the routes use, and ids match what
 * `worker/auth/register.ts` derives, so the Worker cannot tell a seeded row
 * from a real one. The GitHub double must recognise the seeded token and
 * installation, so `e2e/dev-services.ts` seeds it from the constants exported
 * here.
 *
 * Runs under `tsx` from `scripts/dev.mjs` before the dev server starts, as one
 * `wrangler d1 execute --local` call: each wrangler invocation opens the dev
 * server's SQLite file, and several in a row can reset a live request. Tests
 * that run while the server is up use `e2e/local-d1.ts` instead.
 *
 * `--modal-from-home` seals the real Modal token pair from `~/.modal.toml`
 * instead of the placeholder pair, for `pnpm dev:modal`.
 *
 * `--real-github-repo owner/name` instead writes only the real App's
 * installation and that repository, for the live composition on a port slot
 * where the App's install flow cannot return (`real-github-seed.ts`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveUserId, deriveWorkspaceId } from "../worker/auth/register";
import { deriveKeyring, sealCredential } from "../worker/broker/envelope";
import { githubTokenContext } from "../worker/github/envelope-context";
import { modalTokenContext } from "../worker/modal/envelope-context";
import {
  lookUpRealRepository,
  parseRepositoryFlag,
  realGitHubApp,
  realGitHubStatements,
} from "./real-github-seed";

export const SEED_GITHUB_USER_ID = 42;
export const SEED_GITHUB_LOGIN = "octocat";
export const SEED_INSTALLATION_ID = 4001;
export const SEED_ACCOUNT_LOGIN = "acme";
export const SEED_USER_TOKEN = "ghu_seeded_local_user_token";
export const SEED_REPOSITORIES = [
  { id: 501, fullName: "acme/widgets", defaultBranch: "main" },
  { id: 502, fullName: "acme/legacy", defaultBranch: "main" },
  { id: 503, fullName: "acme/api", defaultBranch: "main" },
] as const;

const webRoot = fileURLToPath(new URL("..", import.meta.url));

function devVars(): Map<string, string> {
  return readVarsFile(join(webRoot, ".dev.vars"));
}

/**
 * Why wrangler failed, from the stderr lines that name an error. The statement
 * is left out because it can carry a sealed credential and wrangler echoes it.
 */
export function wranglerFailureReason(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /sqlite|error|locked|busy|ENOENT|EBUSY/i.test(line))
    .filter((line) => !/insert |update |select |delete |values/i.test(line));
  return lines.slice(0, 3).join(" | ").slice(0, 400) || "wrangler printed no error line";
}

function queryLocal<T>(sql: string): T[] {
  let output: string;
  try {
    output = execFileSync(
      "pnpm",
      ["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql],
      { cwd: webRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    throw new Error(`wrangler d1 execute failed: ${wranglerFailureReason(stderr)}`);
  }
  const parsed = JSON.parse(output) as { results: T[] }[];
  return parsed.flatMap((entry) => entry.results);
}

/**
 * Runs one read. The seed uses `wrangler` (`queryLocal`) before the server
 * starts; a test passes `e2e/local-d1.ts`'s `queryD1` so no second process
 * opens the file.
 */
export type LocalQuery = <T>(sql: string) => T[] | Promise<T[]>;

export async function existingIdsFor(
  subject: string,
  query: LocalQuery = queryLocal,
): Promise<ExistingIds> {
  const workspaceId = await deriveWorkspaceId(subject);
  const installation = (
    await query<{ installation_row_id: string }>(
      `SELECT installation_row_id FROM github_installation WHERE workspace_id = '${workspaceId}' AND github_installation_id = ${SEED_INSTALLATION_ID}`,
    )
  )[0];
  const modal = (
    await query<{ connection_id: string }>(
      `SELECT connection_id FROM modal_connection WHERE workspace_id = '${workspaceId}'`,
    )
  )[0];
  return {
    ...(installation === undefined ? {} : { installationRowId: installation.installation_row_id }),
    ...(modal === undefined ? {} : { modalConnectionId: modal.connection_id }),
  };
}

function quote(value: string | number | null): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** The developer's own Modal token pair, read the way the Modal CLI reads it. */
function modalPairFromHome(): { tokenId: string; tokenSecret: string } {
  const text = readFileSync(join(homedir(), ".modal.toml"), "utf8");
  const tokenId = /token_id\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const tokenSecret = /token_secret\s*=\s*"([^"]+)"/.exec(text)?.[1];
  if (tokenId === undefined || tokenSecret === undefined) {
    throw new Error("~/.modal.toml has no token_id / token_secret pair");
  }
  return { tokenId, tokenSecret };
}

/**
 * The ids the workspace's rows already carry, if any. An envelope binds its
 * row's id in the AEAD tag, so a re-seed must seal under the existing id, as
 * `saveModalConnection` does, or the row cannot be opened.
 */
export interface ExistingIds {
  readonly installationRowId?: string;
  readonly modalConnectionId?: string;
}

export async function seedStatements(options: {
  subject: string;
  keyringSecret: string;
  modalPair: { tokenId: string; tokenSecret: string };
  modalWorkspaceName: string;
  existing?: ExistingIds;
  /**
   * The live composition: the developer's Anthropic key from the macOS
   * keychain, sealed as the model-key screen seals it, and no GitHub rows,
   * which the real App writes through its install flow. The key goes from the
   * keychain into the sealer and nowhere else.
   */
  live?: { modelKey: string };
}): Promise<string[]> {
  const keyring = await deriveKeyring(options.keyringSecret, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("ONCUE_BROKER_KEYRING in .dev.vars is not a usable keyring");
  }
  const workspaceId = await deriveWorkspaceId(options.subject);
  const now = new Date().toISOString();
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const installationRowId =
    options.existing?.installationRowId ?? `ghi_seed_${workspaceId.slice(4, 12)}`;
  const userToken = await sealCredential(
    keyring.keyring,
    githubTokenContext(installationRowId, workspaceId, "user_token"),
    SEED_USER_TOKEN,
  );
  const refreshToken = await sealCredential(
    keyring.keyring,
    githubTokenContext(installationRowId, workspaceId, "refresh_token"),
    "ghr_seeded_local_refresh_token",
  );

  const modelConnectionId = `mc_seed_${workspaceId.slice(4, 12)}`;
  const modelKey = await sealCredential(
    keyring.keyring,
    { connectionId: modelConnectionId, workspaceId, provider: "anthropic" },
    options.live?.modelKey ?? "seeded-local-model-key",
  );

  const githubStatements = options.live
    ? []
    : [
        `INSERT INTO github_installation (installation_row_id, workspace_id, github_installation_id, github_user_id, account_login, account_type, status, user_token_reference, refresh_token_reference, user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at)
     VALUES (${quote(installationRowId)}, ${quote(workspaceId)}, ${SEED_INSTALLATION_ID}, ${SEED_GITHUB_USER_ID}, ${quote(SEED_ACCOUNT_LOGIN)}, 'Organization', 'active', ${quote(userToken)}, ${quote(refreshToken)}, ${quote(farFuture)}, ${quote(farFuture)}, ${quote(now)}, ${quote(now)}, ${quote(now)})
     ON CONFLICT (workspace_id, github_installation_id) DO UPDATE SET status = 'active', user_token_reference = excluded.user_token_reference, refresh_token_reference = excluded.refresh_token_reference, user_token_expires_at = excluded.user_token_expires_at, refresh_token_expires_at = excluded.refresh_token_expires_at, last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
        ...SEED_REPOSITORIES.map(
          (repository) =>
            `INSERT INTO repository_connection (repository_connection_id, workspace_id, installation_row_id, github_repository_id, full_name, default_branch, status, created_at, updated_at)
         VALUES (${quote(`rc_seed_${repository.id}_${workspaceId.slice(4, 12)}`)}, ${quote(workspaceId)}, ${quote(installationRowId)}, ${repository.id}, ${quote(repository.fullName)}, ${quote(repository.defaultBranch)}, 'verified', ${quote(now)}, ${quote(now)})
         ON CONFLICT (workspace_id, github_repository_id) DO UPDATE SET installation_row_id = excluded.installation_row_id, status = 'verified', updated_at = excluded.updated_at`,
        ),
      ];

  const statements = [
    ...(await workspaceStatements(options.subject)),
    ...githubStatements,
    `INSERT INTO model_connection (connection_id, workspace_id, provider, auth_type, credential_reference, status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at)
     VALUES (${quote(modelConnectionId)}, ${quote(workspaceId)}, 'anthropic', 'api_key', ${quote(modelKey)}, 'active', 'local seed', NULL, ${quote(now)}, ${quote(now)}, ${quote(now)})
     ON CONFLICT (connection_id) DO UPDATE SET credential_reference = excluded.credential_reference, status = 'active', updated_at = excluded.updated_at`,
    ...(await modalConnectionStatements(options)),
  ];
  return statements;
}

/** The user, its Clerk identity, and its private workspace, each idempotent. */
export async function workspaceStatements(subject: string): Promise<string[]> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  const now = new Date().toISOString();
  return [
    `INSERT INTO user (id, status, created_at, updated_at) VALUES (${quote(userId)}, 'active', ${quote(now)}, ${quote(now)}) ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO external_identity (provider, subject, user_id, created_at) VALUES ('clerk', ${quote(subject)}, ${quote(userId)}, ${quote(now)}) ON CONFLICT (provider, subject) DO NOTHING`,
    `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (${quote(workspaceId)}, ${quote(userId)}, 'private', ${quote(now)}, ${quote(now)}) ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO workspace_member (workspace_id, user_id, role, created_at) VALUES (${quote(workspaceId)}, ${quote(userId)}, 'owner', ${quote(now)}) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
  ];
}

/**
 * One Modal connection for the subject's workspace, sealed as the connect
 * route seals it. Separate because, with a sandbox controller configured,
 * session creation refuses a workspace without one
 * (`modal_connection_required`), and some tests need only this row.
 */
export async function modalConnectionStatements(options: {
  subject: string;
  keyringSecret: string;
  modalPair: { tokenId: string; tokenSecret: string };
  modalWorkspaceName: string;
  existing?: ExistingIds;
}): Promise<string[]> {
  const keyring = await deriveKeyring(options.keyringSecret, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("ONCUE_BROKER_KEYRING in .dev.vars is not a usable keyring");
  }
  const workspaceId = await deriveWorkspaceId(options.subject);
  const now = new Date().toISOString();
  const modalConnectionId =
    options.existing?.modalConnectionId ?? `mdl_seed_${workspaceId.slice(4, 12)}`;
  const modalTokenId = await sealCredential(
    keyring.keyring,
    modalTokenContext(modalConnectionId, workspaceId, "token_id"),
    options.modalPair.tokenId,
  );
  const modalTokenSecret = await sealCredential(
    keyring.keyring,
    modalTokenContext(modalConnectionId, workspaceId, "token_secret"),
    options.modalPair.tokenSecret,
  );
  return [
    `INSERT INTO modal_connection (connection_id, workspace_id, token_id_reference, token_secret_reference, modal_workspace_name, environment_name, status, last_validated_at, created_at, updated_at)
     VALUES (${quote(modalConnectionId)}, ${quote(workspaceId)}, ${quote(modalTokenId)}, ${quote(modalTokenSecret)}, ${quote(options.modalWorkspaceName)}, NULL, 'active', ${quote(now)}, ${quote(now)}, ${quote(now)})
     ON CONFLICT (workspace_id) DO UPDATE SET token_id_reference = excluded.token_id_reference, token_secret_reference = excluded.token_secret_reference, modal_workspace_name = excluded.modal_workspace_name, status = 'active', last_validated_at = excluded.last_validated_at, updated_at = excluded.updated_at`,
  ];
}

/** The placeholder pair the doubles accept; `--modal-from-home` replaces it. */
export const DOUBLE_MODAL_PAIR = { tokenId: "ak-local-double", tokenSecret: "as-local-double" };

/**
 * `--real-github-repo owner/name [--subject <clerk subject>]`: only the real
 * App's installation and that repository, for the live composition on any
 * port slot (`real-github-seed.ts`). Nothing else is seeded or changed.
 */
async function seedRealGitHub(vars: Map<string, string>, repositoryFlag: string | undefined) {
  const repository = parseRepositoryFlag(repositoryFlag);
  const subjectFlag = process.argv.indexOf("--subject");
  const subject =
    (subjectFlag === -1 ? undefined : process.argv[subjectFlag + 1]) ??
    vars.get("ONCUE_DEV_SUBJECT") ??
    vars.get("ONCUE_LANE_SUBJECT");
  const keyringSecret = vars.get("ONCUE_BROKER_KEYRING");
  if (subject === undefined || keyringSecret === undefined) {
    throw new Error(
      "apps/web/.dev.vars has no dev subject or keyring; compose it with `pnpm dev:live` first, or pass --subject for `pnpm dev:real`",
    );
  }
  const app = realGitHubApp(readVarsFile(join(webRoot, ".dev.vars.real")), vars);
  const found = await lookUpRealRepository(
    { fetchImpl: fetch, now: () => Date.now(), ...app },
    repository,
  );
  const workspaceId = await deriveWorkspaceId(subject);
  const existing = (
    await queryLocal<{ repository_connection_id: string }>(
      `SELECT repository_connection_id FROM repository_connection WHERE workspace_id = '${workspaceId}' AND github_repository_id = ${found.repositoryId}`,
    )
  )[0];
  const { statements, validUntil } = await realGitHubStatements({
    subject,
    keyringSecret,
    repository: found,
    nowMs: Date.now(),
    repositoryConnectionId:
      existing?.repository_connection_id ?? `rc_${globalThis.crypto.randomUUID()}`,
  });
  const file = join(mkdtempSync(join(tmpdir(), "oncue-seed-")), "seed.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], {
    cwd: webRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log(
    `[seed-local] workspace for "${subject}" now holds ${found.fullName} (repository ${found.repositoryId}, default branch ${found.defaultBranch}) under the real App's installation ${found.installationId} on ${found.accountLogin}; the lookup token was ${found.revoked ? "revoked" : "NOT revoked (it lapses within the hour)"}`,
  );
  console.log(
    `[seed-local] sessions can mint installation tokens for it until about ${validUntil}; run this again after that, since no user token was stored`,
  );
}

/** A dotenv file as `.dev.vars` is read here, or empty when it does not exist. */
function readVarsFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) {
      entries.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const vars = devVars();
  const realFlag = process.argv.indexOf("--real-github-repo");
  if (realFlag !== -1) {
    await seedRealGitHub(vars, process.argv[realFlag + 1]);
    return;
  }
  const subject = vars.get("ONCUE_DEV_SUBJECT") ?? vars.get("ONCUE_LANE_SUBJECT");
  const keyringSecret = vars.get("ONCUE_BROKER_KEYRING");
  if (subject === undefined || keyringSecret === undefined) {
    throw new Error(
      "apps/web/.dev.vars has no lane subject or keyring; run `node apps/web/e2e/setup-local-auth.mjs` first",
    );
  }
  const fromHome = process.argv.includes("--modal-from-home");
  const keychainFlag = process.argv.indexOf("--model-key-from-keychain");
  const keychainService = keychainFlag === -1 ? null : (process.argv[keychainFlag + 1] ?? null);
  const live =
    keychainService === null ? undefined : { modelKey: keychainModelKey(keychainService) };
  const statements = await seedStatements({
    subject,
    keyringSecret,
    modalPair: fromHome ? modalPairFromHome() : DOUBLE_MODAL_PAIR,
    modalWorkspaceName: fromHome ? "your Modal workspace" : "oncue-local-double",
    existing: await existingIdsFor(subject),
    ...(live === undefined ? {} : { live }),
  });
  const file = join(mkdtempSync(join(tmpdir(), "oncue-seed-")), "seed.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], {
    cwd: webRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log(
    live === undefined
      ? `[seed-local] workspace for "${subject}" seeded: GitHub installation ${SEED_INSTALLATION_ID} with ${SEED_REPOSITORIES.length} repositories, one Anthropic connection, one Modal connection${fromHome ? " (real pair from ~/.modal.toml)" : ""}`
      : `[seed-local] workspace for "${subject}" seeded for the live composition: one Anthropic connection from the keychain, one Modal connection${fromHome ? " (real pair from ~/.modal.toml)" : ""}, no GitHub rows`,
  );
}

/** `security find-generic-password -w`: the value goes straight into the sealer. */
function keychainModelKey(service: string): string {
  const value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (value.length === 0) {
    throw new Error(`keychain item "${service}" is empty`);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
