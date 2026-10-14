/**
 * Every read and write of `github_installation`, `repository_connection`, and
 * `webhook_delivery`. The workspace scopes and delivery checks here are
 * authorization decisions, kept as SQL predicates in one fully covered module.
 *
 * Nothing returns a plaintext token: envelopes leave sealed and `install.ts`
 * opens them. Inserts that may meet an existing row are one
 * `INSERT ... ON CONFLICT` statement, never read-then-write, and status
 * setters return the changed row count so callers need no second read.
 */

import { type AtMostOne, atMostOne, exactlyOne } from "../sql";

/**
 * Migration 0004's `status` CHECK. `unauthorized` (record 07) is distinct
 * from `deleted`: the installation may still exist on GitHub, and only the
 * user's link to it has lapsed.
 */
export const INSTALLATION_STATUSES = ["active", "suspended", "deleted", "unauthorized"] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const ACCOUNT_TYPES = ["User", "Organization"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// `disconnected` is a status, not a delete: sessions that started on the
// repository keep a reference to it.
export const REPOSITORY_STATUSES = ["verified", "disconnected"] as const;
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

/** What a route may show. No envelope, no token, no expiry of a token it cannot see. */
export interface InstallationSummary {
  readonly installationRowId: string;
  readonly workspaceId: string;
  readonly githubInstallationId: number;
  readonly githubUserId: number;
  readonly accountLogin: string;
  readonly accountType: AccountType;
  readonly status: InstallationStatus;
  readonly lastVerifiedAt: string;
  readonly createdAt: string;
}

interface InstallationRow {
  readonly installation_row_id: string;
  readonly workspace_id: string;
  readonly github_installation_id: number;
  readonly github_user_id: number;
  readonly account_login: string;
  readonly account_type: string;
  readonly status: string;
  readonly last_verified_at: string;
  readonly created_at: string;
}

/**
 * The one place a `github_installation` row becomes a typed summary. The casts
 * are safe because `0004_github.sql` CHECK-constrains both columns to these
 * unions; widening either CHECK means widening the union. Values arriving from
 * GitHub are parsed in `install.ts` instead.
 */
function installationFromRow(row: InstallationRow): InstallationSummary {
  return {
    installationRowId: row.installation_row_id,
    workspaceId: row.workspace_id,
    githubInstallationId: row.github_installation_id,
    githubUserId: row.github_user_id,
    accountLogin: row.account_login,
    accountType: row.account_type as AccountType,
    status: row.status as InstallationStatus,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
  };
}

const INSTALLATION_COLUMNS =
  "installation_row_id, workspace_id, github_installation_id, github_user_id, account_login, account_type, status, last_verified_at, created_at";

const ID_NAMESPACE = "oncue-github-v1";

async function digestHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The installation row id is derived from the unique
 * `(workspace, installation)` pair, because the token envelopes bind the row
 * id and are sealed before the write. A random id would leave a re-run's
 * upsert holding tokens sealed under an id nothing recorded; a derived one
 * also keeps session references stable across reconnects.
 */
export async function deriveInstallationRowId(
  workspaceId: string,
  githubInstallationId: number,
): Promise<string> {
  return `ghi_${await digestHex(`${ID_NAMESPACE}:ghi:${workspaceId}:${githubInstallationId}`)}`;
}

/** Everything record 07 step 6 stores about an installation. Tokens arrive sealed. */
export interface InstallationWrite {
  readonly installationRowId: string;
  readonly workspaceId: string;
  readonly githubInstallationId: number;
  readonly githubUserId: number;
  readonly accountLogin: string;
  readonly accountType: AccountType;
  readonly sealedUserToken: string;
  readonly sealedRefreshToken: string;
  readonly userTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly now: string;
}

/**
 * Idempotent on `(workspace_id, github_installation_id)`. A re-run of the
 * connection flow refreshes tokens, login, and status on the existing row and
 * sets it `active`, since a re-run is the re-authorization record 07 asks for.
 */
export async function insertOrUpdateInstallation(
  db: D1Database,
  row: InstallationWrite,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference,
         refresh_token_reference, user_token_expires_at, refresh_token_expires_at,
         last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, github_installation_id) DO UPDATE SET
         github_user_id = excluded.github_user_id,
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         status = 'active',
         user_token_reference = excluded.user_token_reference,
         refresh_token_reference = excluded.refresh_token_reference,
         user_token_expires_at = excluded.user_token_expires_at,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      row.installationRowId,
      row.workspaceId,
      row.githubInstallationId,
      row.githubUserId,
      row.accountLogin,
      row.accountType,
      row.sealedUserToken,
      row.sealedRefreshToken,
      row.userTokenExpiresAt,
      row.refreshTokenExpiresAt,
      row.now,
      row.now,
      row.now,
    )
    .run();
}

export type LinkIdentityOutcome = "linked" | "linked_to_another_user";

/**
 * The `external_identity` row linking a verified GitHub user id to this OnCue
 * user. The `WHERE` on `DO UPDATE` makes `meta.changes` answer whether the
 * GitHub account is this user's (1) or already another user's (0), in one
 * statement.
 */
export async function linkGitHubIdentity(
  db: D1Database,
  userId: string,
  githubUserId: number,
  now: string,
): Promise<LinkIdentityOutcome> {
  const result = await db
    .prepare(
      `INSERT INTO external_identity (provider, subject, user_id, created_at)
       VALUES ('github', ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id
       WHERE external_identity.user_id = excluded.user_id`,
    )
    .bind(String(githubUserId), userId, now)
    .run();
  return result.meta.changes === 1 ? "linked" : "linked_to_another_user";
}

/** Every installation the workspace holds, whatever its status. The screen's list. */
export async function listInstallations(
  db: D1Database,
  workspaceId: string,
): Promise<readonly InstallationSummary[]> {
  const result = await db
    .prepare(
      `SELECT ${INSTALLATION_COLUMNS} FROM github_installation
       WHERE workspace_id = ? ORDER BY created_at DESC, installation_row_id`,
    )
    .bind(workspaceId)
    .all<InstallationRow>();
  return result.results.map(installationFromRow);
}

/**
 * A webhook names GitHub's installation id and no workspace, and one
 * installation can back rows in several workspaces (two members of one
 * organization), so this returns every row and the handler updates all.
 */
export async function listInstallationsByGitHubId(
  db: D1Database,
  githubInstallationId: number,
): Promise<readonly InstallationSummary[]> {
  const result = await db
    .prepare(
      `SELECT ${INSTALLATION_COLUMNS} FROM github_installation
       WHERE github_installation_id = ? ORDER BY installation_row_id`,
    )
    .bind(githubInstallationId)
    .all<InstallationRow>();
  return result.results.map(installationFromRow);
}

export type SealedInstallationTokens =
  | {
      readonly kind: "found";
      readonly installation: InstallationSummary;
      readonly sealedUserToken: string;
      readonly sealedRefreshToken: string;
      readonly userTokenExpiresAt: string;
      readonly refreshTokenExpiresAt: string;
    }
  | { readonly kind: "absent" };

interface SealedTokenRow extends InstallationRow {
  readonly user_token_reference: string;
  readonly refresh_token_reference: string;
  readonly user_token_expires_at: string;
  readonly refresh_token_expires_at: string;
}

/**
 * The only read that returns token envelopes, and they stay sealed. Scoped by
 * workspace in the SQL, so another workspace's row looks missing.
 */
export async function readSealedInstallationTokens(
  db: D1Database,
  workspaceId: string,
  installationRowId: string,
): Promise<SealedInstallationTokens> {
  const found = await atMostOne<SealedTokenRow>(
    db
      .prepare(
        `SELECT ${INSTALLATION_COLUMNS}, user_token_reference, refresh_token_reference,
                user_token_expires_at, refresh_token_expires_at
           FROM github_installation
          WHERE installation_row_id = ? AND workspace_id = ?`,
      )
      .bind(installationRowId, workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "absent" };
  }
  return {
    kind: "found",
    installation: installationFromRow(found.row),
    sealedUserToken: found.row.user_token_reference,
    sealedRefreshToken: found.row.refresh_token_reference,
    userTokenExpiresAt: found.row.user_token_expires_at,
    refreshTokenExpiresAt: found.row.refresh_token_expires_at,
  };
}

/** The four columns a token refresh replaces. Both envelopes arrive sealed. */
export interface SealedTokenWrite {
  readonly sealedUserToken: string;
  readonly sealedRefreshToken: string;
  readonly userTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

// GitHub rotates the refresh token on every exchange, so both envelopes are
// replaced together.
export async function updateInstallationTokens(
  db: D1Database,
  installationRowId: string,
  tokens: SealedTokenWrite,
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE github_installation
          SET user_token_reference = ?, refresh_token_reference = ?,
              user_token_expires_at = ?, refresh_token_expires_at = ?, updated_at = ?
        WHERE installation_row_id = ?`,
    )
    .bind(
      tokens.sealedUserToken,
      tokens.sealedRefreshToken,
      tokens.userTokenExpiresAt,
      tokens.refreshTokenExpiresAt,
      now,
      installationRowId,
    )
    .run();
  return result.meta.changes;
}

/**
 * The `installation` webhook's `suspended` and `deleted` transitions, applied
 * to every workspace's link to that installation. Returns the row count.
 */
export async function setInstallationStatus(
  db: D1Database,
  githubInstallationId: number,
  status: InstallationStatus,
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE github_installation SET status = ?, updated_at = ? WHERE github_installation_id = ?",
    )
    .bind(status, now, githubInstallationId)
    .run();
  return result.meta.changes;
}

/**
 * Marks one row `unauthorized` after a failed refresh or check (record 07). By
 * row id, because only this user's link failed; other workspaces' links hold
 * their own tokens.
 */
export async function setInstallationStatusByRowId(
  db: D1Database,
  installationRowId: string,
  status: InstallationStatus,
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE github_installation SET status = ?, updated_at = ? WHERE installation_row_id = ?",
    )
    .bind(status, now, installationRowId)
    .run();
  return result.meta.changes;
}

/**
 * The `github_app_authorization` `revoked` action (record 07): disables every
 * row that user's token vouched for, in every workspace, matched on the
 * verified `github_user_id`.
 */
export async function setInstallationStatusForGitHubUser(
  db: D1Database,
  githubUserId: number,
  status: InstallationStatus,
  now: string,
): Promise<number> {
  const result = await db
    .prepare("UPDATE github_installation SET status = ?, updated_at = ? WHERE github_user_id = ?")
    .bind(status, now, githubUserId)
    .run();
  return result.meta.changes;
}

/** Record 07 step 7's eight-hour clock, reset after a successful verification. */
export async function touchInstallationVerified(
  db: D1Database,
  installationRowId: string,
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE github_installation SET last_verified_at = ?, updated_at = ? WHERE installation_row_id = ?",
    )
    .bind(now, now, installationRowId)
    .run();
  return result.meta.changes;
}

export interface RepositoryConnectionSummary {
  readonly repositoryConnectionId: string;
  readonly installationRowId: string;
  readonly githubRepositoryId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly status: RepositoryStatus;
  /**
   * The backing installation's status. A `verified` repository under an
   * inactive installation is refused by `resolveRepository`, so the caller
   * needs both facts to show an honest status.
   */
  readonly installationStatus: InstallationStatus;
  /** When the workspace removed it from OnCue (`0013_repository_removed.sql`); `null` ordinarily. */
  readonly removedAt: string | null;
  readonly createdAt: string;
}

interface RepositoryRow {
  readonly repository_connection_id: string;
  readonly installation_row_id: string;
  readonly github_repository_id: number;
  readonly full_name: string;
  readonly default_branch: string;
  readonly status: string;
  readonly removed_at: string | null;
  readonly installation_status: string;
  readonly created_at: string;
}

/** Same CHECK-constraint guarantee as `installationFromRow`, for `repository_connection.status`. */
function repositoryFromRow(row: RepositoryRow): RepositoryConnectionSummary {
  return {
    repositoryConnectionId: row.repository_connection_id,
    installationRowId: row.installation_row_id,
    githubRepositoryId: row.github_repository_id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    status: row.status as RepositoryStatus,
    installationStatus: row.installation_status as InstallationStatus,
    removedAt: row.removed_at,
    createdAt: row.created_at,
  };
}

const REPOSITORY_COLUMNS =
  "rc.repository_connection_id, rc.installation_row_id, rc.github_repository_id, rc.full_name, rc.default_branch, rc.status, rc.removed_at, rc.created_at";

/** One entry of the authenticated repository list record 07 step 5 returns. */
export interface RepositoryInput {
  readonly githubRepositoryId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
}

export interface ReplaceRepositoriesInput {
  readonly workspaceId: string;
  readonly installationRowId: string;
  readonly repositories: readonly RepositoryInput[];
  readonly newId: () => string;
  readonly now: string;
}

/**
 * Record 07's repository write: every repository in the authenticated list
 * becomes `verified`, and every previously linked one now absent becomes
 * `disconnected`. One `db.batch()`, which D1 rolls back as a unit, so the
 * workspace is never half-linked. A conflicting row keeps its
 * `repository_connection_id` (sessions may hold it) and moves to this
 * installation.
 */
export async function replaceRepositoryConnections(
  db: D1Database,
  input: ReplaceRepositoriesInput,
): Promise<void> {
  // Mark every row absent first and let the upserts restore the present ones: a
  // `NOT IN` list would bind one parameter per repository, and D1 caps a
  // statement at a hundred.
  const disconnectAbsent = db
    .prepare(
      `UPDATE repository_connection
          SET status = 'disconnected', updated_at = ?
        WHERE workspace_id = ? AND installation_row_id = ? AND status != 'disconnected'`,
    )
    .bind(input.now, input.workspaceId, input.installationRowId);
  const upserts = input.repositories.map((repository) =>
    db
      .prepare(
        `INSERT INTO repository_connection (
           repository_connection_id, workspace_id, installation_row_id, github_repository_id,
           full_name, default_branch, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)
         ON CONFLICT (workspace_id, github_repository_id) DO UPDATE SET
           installation_row_id = excluded.installation_row_id,
           full_name = excluded.full_name,
           default_branch = excluded.default_branch,
           status = 'verified',
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.newId(),
        input.workspaceId,
        input.installationRowId,
        repository.githubRepositoryId,
        repository.fullName,
        repository.defaultBranch,
        input.now,
        input.now,
      ),
  );
  await db.batch([disconnectAbsent, ...upserts]);
}

/** Every repository connection the workspace has, whatever its status. The screen's list. */
export async function listRepositoryConnections(
  db: D1Database,
  workspaceId: string,
): Promise<readonly RepositoryConnectionSummary[]> {
  // Joined rather than read twice, so the two statuses cannot disagree. The
  // NOT NULL foreign key makes the inner join safe.
  const result = await db
    .prepare(
      `SELECT ${REPOSITORY_COLUMNS}, gi.status AS installation_status
         FROM repository_connection AS rc
         JOIN github_installation AS gi
           ON gi.installation_row_id = rc.installation_row_id
        WHERE rc.workspace_id = ?
        ORDER BY rc.full_name, rc.repository_connection_id`,
    )
    .bind(workspaceId)
    .all<RepositoryRow>();
  return result.results.map(repositoryFromRow);
}

/**
 * The `installation_repositories` `removed` case: disables only the named
 * repositories (record 07). Scoped to one installation row, since another
 * workspace may link the same repository through its own installation.
 */
export async function disconnectRepositoriesByGitHubIds(
  db: D1Database,
  installationRowId: string,
  githubRepositoryIds: readonly number[],
  now: string,
): Promise<number> {
  const placeholders = githubRepositoryIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `UPDATE repository_connection
          SET status = 'disconnected', updated_at = ?
        WHERE installation_row_id = ? AND status != 'disconnected'
          AND github_repository_id IN (${placeholders})`,
    )
    .bind(now, installationRowId, ...githubRepositoryIds)
    .run();
  return result.meta.changes;
}

/** What session creation needs to know about a repository. */
export interface AuthorizedRepository {
  readonly repositoryConnectionId: string;
  readonly installationRowId: string;
  readonly githubInstallationId: number;
  readonly githubRepositoryId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly status: RepositoryStatus;
  readonly installationStatus: InstallationStatus;
  readonly removedAt: string | null;
}

interface AuthorizedRepositoryRow {
  readonly repository_connection_id: string;
  readonly installation_row_id: string;
  readonly github_installation_id: number;
  readonly github_repository_id: number;
  readonly full_name: string;
  readonly default_branch: string;
  readonly repository_status: string;
  readonly installation_status: string;
  readonly removed_at: string | null;
}

/**
 * The session-creation read behind `resolveRepository`. Scoped by workspace in
 * the SQL on both tables, so another workspace's id looks missing and ids
 * cannot be probed. It returns the installation's status beside the
 * repository's, in one indexed read.
 */
export async function readAuthorizedRepository(
  db: D1Database,
  workspaceId: string,
  repositoryConnectionId: string,
): Promise<AtMostOne<AuthorizedRepository>> {
  const found = await atMostOne<AuthorizedRepositoryRow>(
    db
      .prepare(
        `SELECT rc.repository_connection_id AS repository_connection_id,
                rc.installation_row_id AS installation_row_id,
                gi.github_installation_id AS github_installation_id,
                rc.github_repository_id AS github_repository_id,
                rc.full_name AS full_name,
                rc.default_branch AS default_branch,
                rc.status AS repository_status,
                gi.status AS installation_status,
                rc.removed_at AS removed_at
           FROM repository_connection AS rc
           JOIN github_installation AS gi ON gi.installation_row_id = rc.installation_row_id
          WHERE rc.repository_connection_id = ?
            AND rc.workspace_id = ?
            AND gi.workspace_id = ?`,
      )
      .bind(repositoryConnectionId, workspaceId, workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "absent" };
  }
  return {
    kind: "found",
    row: {
      repositoryConnectionId: found.row.repository_connection_id,
      installationRowId: found.row.installation_row_id,
      githubInstallationId: found.row.github_installation_id,
      githubRepositoryId: found.row.github_repository_id,
      fullName: found.row.full_name,
      defaultBranch: found.row.default_branch,
      status: found.row.repository_status as RepositoryStatus,
      installationStatus: found.row.installation_status as InstallationStatus,
      removedAt: found.row.removed_at,
    },
  };
}

/**
 * Remove and Restore. Removal hides the repository and refuses new sessions on
 * it; existing sessions keep their reference, and the App's access on GitHub
 * is untouched. Another workspace's id is "not found".
 */
export async function setRepositoryRemoved(
  db: D1Database,
  workspaceId: string,
  repositoryConnectionId: string,
  removedAt: string | null,
  now: string,
): Promise<RepositoryConnectionSummary | null> {
  const result = await db
    .prepare(
      `UPDATE repository_connection
          SET removed_at = ?, updated_at = ?
        WHERE repository_connection_id = ? AND workspace_id = ?`,
    )
    .bind(removedAt, now, repositoryConnectionId, workspaceId)
    .run();
  if (result.meta.changes === 0) {
    return null;
  }
  // The row the update touched must exist; `exactlyOne` says so.
  const row = await exactlyOne<RepositoryRow>(
    db
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS}, gi.status AS installation_status
           FROM repository_connection AS rc
           JOIN github_installation AS gi ON gi.installation_row_id = rc.installation_row_id
          WHERE rc.repository_connection_id = ? AND rc.workspace_id = ?`,
      )
      .bind(repositoryConnectionId, workspaceId),
    "repository vanished after its update",
  );
  return repositoryFromRow(row);
}

export type DeliveryOutcome = "first" | "replay";

/**
 * The webhook delivery ledger. A redelivery carries the same
 * `X-GitHub-Delivery` id, so the primary key makes it a no-op. One
 * `INSERT ... ON CONFLICT DO NOTHING` read through `meta.changes`: a read then
 * insert would let two concurrent redeliveries both apply.
 */
export async function recordDelivery(
  db: D1Database,
  deliveryId: string,
  eventName: string,
  now: string,
): Promise<DeliveryOutcome> {
  const result = await db
    .prepare(
      `INSERT INTO webhook_delivery (delivery_id, event_name, received_at)
       VALUES (?, ?, ?) ON CONFLICT (delivery_id) DO NOTHING`,
    )
    .bind(deliveryId, eventName, now)
    .run();
  return result.meta.changes === 1 ? "first" : "replay";
}
