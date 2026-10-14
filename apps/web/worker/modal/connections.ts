// Every read and write of a `modal_connection` row. Whether a workspace may use
// a credential is an authorization decision expressed in SQL, so it lives in
// this 100-percent-branch directory rather than in `worker/routes/`.
//
// Only `openModalCredential` produces plaintext; `ModalConnectionSummary` has
// no field for a token. A save tests the credential with the controller before
// writing, so a credential that does not work is never stored and the Modal
// workspace name shown back is one the credential produced.

import { type Keyring, openCredential, sealCredential } from "../broker/envelope";
import { atMostOne, exactlyOne } from "../sql";
import type { ModalCredential, ModalCredentialTester, ModalTestFailureReason } from "./client";
import { modalTokenContext } from "./envelope-context";

/** Migration 0005's `status` CHECK. `invalid` marks a credential that stopped working after it was saved. */
export const MODAL_CONNECTION_STATUSES = ["active", "invalid"] as const;
export type ModalConnectionStatus = (typeof MODAL_CONNECTION_STATUSES)[number];

/** What a route may show: no envelope, no token half, no ciphertext. */
export interface ModalConnectionSummary {
  readonly connectionId: string;
  readonly workspaceName: string;
  readonly environmentName: string | null;
  readonly status: ModalConnectionStatus;
  readonly lastValidatedAt: string;
  readonly createdAt: string;
}

export interface ModalConnectionDeps {
  readonly db: D1Database;
  readonly keyring: Keyring<"credential">;
  readonly test: ModalCredentialTester;
  readonly now: () => string;
  readonly newId: () => string;
}

interface SummaryRow {
  readonly connection_id: string;
  readonly modal_workspace_name: string;
  readonly environment_name: string | null;
  readonly status: string;
  readonly last_validated_at: string;
  readonly created_at: string;
}

const SUMMARY_COLUMNS =
  "connection_id, modal_workspace_name, environment_name, status, last_validated_at, created_at";

// The `status` cast is sound because 0005's CHECK allows exactly these values
// (`migrations.test.ts` proves it). Widening the CHECK means widening the union.
function summaryFromRow(row: SummaryRow): ModalConnectionSummary {
  return {
    connectionId: row.connection_id,
    workspaceName: row.modal_workspace_name,
    environmentName: row.environment_name,
    status: row.status as ModalConnectionStatus,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
  };
}

/** `GET /api/modal-connection`'s whole answer. */
export async function readModalConnection(
  db: D1Database,
  workspaceId: string,
): Promise<ModalConnectionSummary | null> {
  const found = await atMostOne<SummaryRow>(
    db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM modal_connection WHERE workspace_id = ?`)
      .bind(workspaceId),
  );
  if (found.kind === "absent") {
    return null;
  }
  return summaryFromRow(found.row);
}

/** Only an active row counts: a credential that stopped working cannot start a session. */
export async function hasActiveModalConnection(
  db: D1Database,
  workspaceId: string,
): Promise<boolean> {
  const summary = await readModalConnection(db, workspaceId);
  if (summary === null) {
    return false;
  }
  return summary.status === "active";
}

export type SaveModalConnectionOutcome =
  | { readonly kind: "saved"; readonly summary: ModalConnectionSummary }
  | { readonly kind: "rejected"; readonly reason: ModalTestFailureReason };

/**
 * Test, then write. One upsert on `workspace_id`, so two concurrent saves do
 * not collide on the UNIQUE. A reconnect keeps the row's `connection_id`,
 * which the envelope binds, so no old ciphertext stays openable.
 */
export async function saveModalConnection(
  deps: ModalConnectionDeps,
  workspaceId: string,
  credential: ModalCredential,
): Promise<SaveModalConnectionOutcome> {
  const tested = await deps.test(credential);
  if (tested.kind === "failed") {
    return { kind: "rejected", reason: tested.reason };
  }

  const existing = await atMostOne<{ readonly connection_id: string }>(
    deps.db
      .prepare("SELECT connection_id FROM modal_connection WHERE workspace_id = ?")
      .bind(workspaceId),
  );
  const connectionId = existing.kind === "absent" ? deps.newId() : existing.row.connection_id;
  const now = deps.now();

  const sealedTokenId = await sealCredential(
    deps.keyring,
    modalTokenContext(connectionId, workspaceId, "token_id"),
    credential.tokenId,
  );
  const sealedTokenSecret = await sealCredential(
    deps.keyring,
    modalTokenContext(connectionId, workspaceId, "token_secret"),
    credential.tokenSecret,
  );

  // An upsert with RETURNING always yields the row, so there is no absent arm.
  const row = await exactlyOne<SummaryRow>(
    deps.db
      .prepare(
        `INSERT INTO modal_connection (
         connection_id, workspace_id, token_id_reference, token_secret_reference,
         modal_workspace_name, environment_name, status, last_validated_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         token_id_reference = excluded.token_id_reference,
         token_secret_reference = excluded.token_secret_reference,
         modal_workspace_name = excluded.modal_workspace_name,
         environment_name = excluded.environment_name,
         status = 'active',
         last_validated_at = excluded.last_validated_at,
         updated_at = excluded.updated_at
       RETURNING ${SUMMARY_COLUMNS}`,
      )
      .bind(
        connectionId,
        workspaceId,
        sealedTokenId,
        sealedTokenSecret,
        tested.workspaceName,
        credential.environmentName,
        now,
        now,
        now,
      ),
    "the modal_connection upsert returned no row",
  );
  return { kind: "saved", summary: summaryFromRow(row) };
}

export type DisconnectModalConnectionOutcome =
  | { readonly kind: "disconnected" }
  | { readonly kind: "not_found" };

/**
 * Deletes rather than revoking: unlike `model_connection`, nothing references
 * this row, and deleting frees the UNIQUE on `workspace_id`.
 */
export async function disconnectModalConnection(
  db: D1Database,
  workspaceId: string,
): Promise<DisconnectModalConnectionOutcome> {
  const result = await db
    .prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
    .bind(workspaceId)
    .run();
  if (result.meta.changes === 0) {
    return { kind: "not_found" };
  }
  return { kind: "disconnected" };
}

export type OpenModalCredentialOutcome =
  | { readonly kind: "opened"; readonly credential: ModalCredential }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable" };

interface CredentialRow {
  readonly connection_id: string;
  readonly token_id_reference: string;
  readonly token_secret_reference: string;
  readonly environment_name: string | null;
  readonly status: string;
}

/**
 * The only function here that produces a plaintext credential. Its callers,
 * `prepareModalCredential` in `worker/routes/sessions.ts` (session create and
 * stop) and the session object (cleanup, stop steps, the alarm's probe, and a
 * resume), pass it to the driver and never store it.
 *
 * `absent` means the workspace has not connected Modal; `unusable` means the
 * envelope will not open (a rotated keyring or a moved ciphertext) and is a
 * fault, not a reason to run on the fake driver. Neither returns a pair.
 */
export async function openModalCredential(
  db: D1Database,
  keyring: Keyring<"credential">,
  workspaceId: string,
): Promise<OpenModalCredentialOutcome> {
  const found = await atMostOne<CredentialRow>(
    db
      .prepare(
        `SELECT connection_id, token_id_reference, token_secret_reference,
                environment_name, status
           FROM modal_connection WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "absent" };
  }
  if (found.row.status !== "active") {
    return { kind: "absent" };
  }

  const connectionId = found.row.connection_id;
  const tokenId = await openCredential(
    keyring,
    modalTokenContext(connectionId, workspaceId, "token_id"),
    found.row.token_id_reference,
  );
  if (tokenId.kind !== "ok") {
    return { kind: "unusable" };
  }
  const tokenSecret = await openCredential(
    keyring,
    modalTokenContext(connectionId, workspaceId, "token_secret"),
    found.row.token_secret_reference,
  );
  if (tokenSecret.kind !== "ok") {
    return { kind: "unusable" };
  }
  return {
    kind: "opened",
    credential: {
      tokenId: tokenId.plaintext,
      tokenSecret: tokenSecret.plaintext,
      environmentName: found.row.environment_name,
    },
  };
}
