// Every read and write of a `development_secret` row (record 08). Whether a
// workspace may use a value is an authorization decision expressed in SQL:
// every statement names the workspace from a verified actor or the session's
// own row, so another workspace's ids read as absent.
//
// Only `openDevelopmentSecrets` and `openSecretsById` produce plaintext, and
// only the session object calls them, when sending values to a sandbox.
// `DevelopmentSecretSummary` has no field for a value, so no route returns one.

import { refuseSecretName, refuseSecretValue } from "@oncue/bridge";
import {
  type CredentialContext,
  type Keyring,
  openCredential,
  sealCredential,
} from "../broker/envelope";
import { atMostOne } from "../sql";

/** Migration 0008's `status` CHECK, in full. */
export const DEVELOPMENT_SECRET_STATUSES = ["active", "unreadable"] as const;
export type DevelopmentSecretStatus = (typeof DEVELOPMENT_SECRET_STATUSES)[number];

/** What a route may show. No envelope and no value. */
export interface DevelopmentSecretSummary {
  readonly secretId: string;
  readonly name: string;
  readonly status: DevelopmentSecretStatus;
  readonly updatedAt: string;
}

export interface SecretScope {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
}

/**
 * The envelope's additional data. The row's own id, the workspace, and the
 * name: a sealed value moved to another row, workspace, or name does not open.
 */
export function developmentSecretContext(
  secretId: string,
  workspaceId: string,
  name: string,
): CredentialContext {
  return { connectionId: secretId, workspaceId, provider: `development_secret:${name}` };
}

interface SummaryRow {
  readonly secret_id: string;
  readonly name: string;
  readonly status: string;
  readonly updated_at: string;
}

function summaryOf(row: SummaryRow): DevelopmentSecretSummary {
  return {
    secretId: row.secret_id,
    name: row.name,
    status: row.status as DevelopmentSecretStatus,
    updatedAt: row.updated_at,
  };
}

/** The repository connection a session's GitHub repository belongs to, in this workspace only. */
export async function repositoryConnectionIdFor(
  db: D1Database,
  workspaceId: string,
  githubRepositoryId: number,
): Promise<string | null> {
  const found = await atMostOne<{ repository_connection_id: string }>(
    db
      .prepare(
        "SELECT repository_connection_id FROM repository_connection WHERE workspace_id = ? AND github_repository_id = ?",
      )
      .bind(workspaceId, githubRepositoryId),
  );
  return found.kind === "found" ? found.row.repository_connection_id : null;
}

export async function listDevelopmentSecrets(
  db: D1Database,
  scope: SecretScope,
): Promise<readonly DevelopmentSecretSummary[]> {
  const rows = await db
    .prepare(
      "SELECT secret_id, name, status, updated_at FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? ORDER BY name",
    )
    .bind(scope.workspaceId, scope.repositoryConnectionId)
    .all<SummaryRow>();
  return rows.results.map(summaryOf);
}

export interface SaveSecretDeps {
  readonly keyring: Keyring<"credential">;
  readonly now: string;
  readonly newSecretId: () => string;
}

export type SaveSecretResult =
  | { readonly kind: "saved"; readonly secret: DevelopmentSecretSummary }
  | {
      readonly kind: "refused";
      readonly reason:
        | "unknown_repository"
        | `name_${NonNullable<ReturnType<typeof refuseSecretName>>}`
        | `value_${NonNullable<ReturnType<typeof refuseSecretValue>>}`;
    };

/**
 * Saves or replaces one value. A replacement is a new row under a new id, so
 * the old envelope cannot be opened under the new row's context, and the two
 * statements run as one batch so a name never has two rows or none.
 */
export async function saveDevelopmentSecret(
  db: D1Database,
  deps: SaveSecretDeps,
  scope: SecretScope,
  name: string,
  value: string,
): Promise<SaveSecretResult> {
  const nameRefusal = refuseSecretName(name);
  if (nameRefusal !== null) {
    return { kind: "refused", reason: `name_${nameRefusal}` };
  }
  const valueRefusal = refuseSecretValue(value);
  if (valueRefusal !== null) {
    return { kind: "refused", reason: `value_${valueRefusal}` };
  }
  const repository = await atMostOne(
    db
      .prepare(
        "SELECT 1 AS found FROM repository_connection WHERE repository_connection_id = ? AND workspace_id = ? AND status = 'verified'",
      )
      .bind(scope.repositoryConnectionId, scope.workspaceId),
  );
  if (repository.kind === "absent") {
    return { kind: "refused", reason: "unknown_repository" };
  }
  const secretId = deps.newSecretId();
  const sealed = await sealCredential(
    deps.keyring,
    developmentSecretContext(secretId, scope.workspaceId, name),
    value,
  );
  await db.batch([
    // Keep the old row as superseded: a sandbox may still hold it, and the
    // object redacts by the row it sent.
    db
      .prepare(
        `INSERT OR REPLACE INTO development_secret_superseded
           (secret_id, workspace_id, repository_connection_id, name, value_reference, status, created_at, updated_at, superseded_at)
         SELECT secret_id, workspace_id, repository_connection_id, name, value_reference, status, created_at, updated_at, ?
           FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND name = ?`,
      )
      .bind(deps.now, scope.workspaceId, scope.repositoryConnectionId, name),
    db
      .prepare(
        "DELETE FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND name = ?",
      )
      .bind(scope.workspaceId, scope.repositoryConnectionId, name),
    db
      .prepare(
        `INSERT INTO development_secret (
           secret_id, workspace_id, repository_connection_id, name, value_reference,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        secretId,
        scope.workspaceId,
        scope.repositoryConnectionId,
        name,
        sealed,
        deps.now,
        deps.now,
      ),
  ]);
  return {
    kind: "saved",
    secret: { secretId, name, status: "active", updatedAt: deps.now },
  };
}

/** True when a row was removed. The sealed bytes go with it. */
export async function deleteDevelopmentSecret(
  db: D1Database,
  scope: SecretScope,
  name: string,
): Promise<boolean> {
  const live = await db
    .prepare(
      "DELETE FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND name = ?",
    )
    .bind(scope.workspaceId, scope.repositoryConnectionId, name)
    .run();
  // Its superseded rows go with it: a deletion destroys every sealed copy. A
  // repeat deletion clears any this one did not reach.
  await db
    .prepare(
      "DELETE FROM development_secret_superseded WHERE workspace_id = ? AND repository_connection_id = ? AND name = ?",
    )
    .bind(scope.workspaceId, scope.repositoryConnectionId, name)
    .run();
  return live.meta.changes > 0;
}

/** Whether one name has a usable value, by the unique index. Opens nothing. */
export async function developmentSecretIsSaved(
  db: D1Database,
  scope: SecretScope,
  name: string,
): Promise<boolean> {
  const found = await atMostOne(
    db
      .prepare(
        "SELECT 1 AS found FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND name = ? AND status = 'active'",
      )
      .bind(scope.workspaceId, scope.repositoryConnectionId, name),
  );
  return found.kind === "found";
}

export interface OpenedSecret {
  readonly secretId: string;
  readonly name: string;
  readonly value: string;
}

export interface OpenedSecrets {
  readonly opened: readonly OpenedSecret[];
  /** Asked for and not supplied: no active row, or an envelope that would not open. Names only. */
  readonly unavailable: readonly string[];
}

/**
 * Produces plaintext; the caller sends it to the sandbox and keeps it nowhere.
 * A value that does not open is marked `unreadable`, so Settings asks for it
 * again (record 08).
 */
export async function openDevelopmentSecrets(
  db: D1Database,
  keyring: Keyring<"credential">,
  scope: SecretScope,
  names: readonly string[],
): Promise<OpenedSecrets> {
  const opened: OpenedSecret[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    const found = await atMostOne<{ secret_id: string; value_reference: string }>(
      db
        .prepare(
          "SELECT secret_id, value_reference FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND name = ? AND status = 'active'",
        )
        .bind(scope.workspaceId, scope.repositoryConnectionId, name),
    );
    if (found.kind === "absent") {
      unavailable.push(name);
      continue;
    }
    const result = await openCredential(
      keyring,
      developmentSecretContext(found.row.secret_id, scope.workspaceId, name),
      found.row.value_reference,
    );
    if (result.kind !== "ok") {
      await db
        .prepare(
          "UPDATE development_secret SET status = 'unreadable' WHERE secret_id = ? AND workspace_id = ?",
        )
        .bind(found.row.secret_id, scope.workspaceId)
        .run();
      unavailable.push(name);
      continue;
    }
    opened.push({ secretId: found.row.secret_id, name, value: result.plaintext });
  }
  return { opened, unavailable };
}

/**
 * Produces plaintext for the rows a generation was sent, live or superseded,
 * since the sandbox holds what it was sent. A deleted or unopenable row is
 * skipped.
 */
export async function openSecretsById(
  db: D1Database,
  keyring: Keyring<"credential">,
  workspaceId: string,
  secretIds: readonly string[],
): Promise<readonly OpenedSecret[]> {
  if (secretIds.length === 0) {
    return [];
  }
  const marks = secretIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT secret_id, name, value_reference FROM development_secret WHERE workspace_id = ?1 AND secret_id IN (${marks})
       UNION ALL
       SELECT secret_id, name, value_reference FROM development_secret_superseded WHERE workspace_id = ?1 AND secret_id IN (${marks})`,
    )
    .bind(workspaceId, ...secretIds, ...secretIds)
    .all<{ secret_id: string; name: string; value_reference: string }>();
  const opened = await Promise.all(
    rows.results.map(async (row) => {
      const result = await openCredential(
        keyring,
        developmentSecretContext(row.secret_id, workspaceId, row.name),
        row.value_reference,
      );
      return result.kind === "ok"
        ? { secretId: row.secret_id, name: row.name, value: result.plaintext }
        : null;
    }),
  );
  return opened.filter((secret): secret is OpenedSecret => secret !== null);
}

/** The active names saved for a repository, for the disclosure card and the launch check. Opens nothing. */
export async function savedSecretNames(
  db: D1Database,
  scope: SecretScope,
): Promise<readonly string[]> {
  const rows = await db
    .prepare(
      "SELECT name FROM development_secret WHERE workspace_id = ? AND repository_connection_id = ? AND status = 'active' ORDER BY name",
    )
    .bind(scope.workspaceId, scope.repositoryConnectionId)
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

/** The names the workspace last launched this repository with, or null before its first launch. */
export async function readLastDisclosedNames(
  db: D1Database,
  scope: SecretScope,
): Promise<readonly string[] | null> {
  const found = await atMostOne<{ names_json: string }>(
    db
      .prepare(
        "SELECT names_json FROM repository_secret_disclosure WHERE repository_connection_id = ? AND workspace_id = ?",
      )
      .bind(scope.repositoryConnectionId, scope.workspaceId),
  );
  return found.kind === "found" ? (JSON.parse(found.row.names_json) as string[]) : null;
}

/**
 * The insert, not only the update, requires the repository to belong to the
 * workspace, or another workspace could plant a row the owner cannot overwrite.
 */
export async function writeDisclosedNames(
  db: D1Database,
  scope: SecretScope,
  names: readonly string[],
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO repository_secret_disclosure (repository_connection_id, workspace_id, names_json, disclosed_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (
         SELECT 1 FROM repository_connection WHERE repository_connection_id = ?1 AND workspace_id = ?2
       )
       ON CONFLICT (repository_connection_id) DO UPDATE SET names_json = excluded.names_json, disclosed_at = excluded.disclosed_at`,
    )
    .bind(scope.repositoryConnectionId, scope.workspaceId, JSON.stringify(names), now)
    .run();
}
