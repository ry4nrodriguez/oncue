// Every read and write of a `model_connection` row. `resolveModel` and the
// forward's liveness check are authorization decisions, so they live in this
// 100-percent-branch directory rather than in `worker/routes/`.
//
// Nothing here returns a plaintext credential: `readAuthorizedConnection` and
// `readStoredKey` return the sealed value, and only `forward.ts` and
// `key-check.ts` open it, each for one provider exchange.

import type { ModelRecord } from "@oncue/protocol";
import { atMostOne, exactlyOne } from "../sql";
import { type CredentialContext, type Keyring, sealCredential } from "./envelope";
import {
  PROVIDER_ADAPTERS,
  type ProviderAdapter,
  type ProviderCategory,
  type ProviderId,
} from "./providers/adapter";
import {
  acceptsEffort,
  type EffortLevel,
  findModel,
  isEffortLevel,
  type ModelSpec,
} from "./providers/catalog";

/** Record 06's status set. `expired` belongs to a subscription connection. */
export const CONNECTION_STATUSES = [
  "active",
  "invalid",
  "expired",
  "revoked",
  "attention_required",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What a route may show: no ciphertext, no key, no envelope. */
export interface ConnectionSummary {
  readonly connectionId: string;
  readonly provider: ProviderId;
  readonly status: ConnectionStatus;
  readonly providerAccountHint: string | null;
  readonly lastValidatedAt: string | null;
  readonly createdAt: string;
}

export interface ConnectionDeps {
  readonly db: D1Database;
  readonly keyring: Keyring<"credential">;
  readonly fetchImpl: typeof fetch;
  /** Where the adapter's requests go; the route decides, so this module knows no environment. */
  readonly originFor: (adapter: ProviderAdapter) => string;
  readonly now: () => string;
  readonly newId: () => string;
}

interface ConnectionRow {
  readonly connection_id: string;
  readonly provider: string;
  readonly auth_type: string;
  readonly status: string;
  readonly provider_account_hint: string | null;
  readonly last_validated_at: string | null;
  readonly created_at: string;
}

/**
 * The `provider` and `status` casts are sound because 0003's CHECKs allow
 * exactly these values (`migrations.test.ts` proves it); widening a CHECK means
 * widening the union. A provider from a request body is parsed, not cast.
 */
export function summaryFromRow(row: ConnectionRow): ConnectionSummary {
  return {
    connectionId: row.connection_id,
    provider: row.provider as ProviderId,
    status: row.status as ConnectionStatus,
    providerAccountHint: row.provider_account_hint,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
  };
}

const SUMMARY_COLUMNS =
  "connection_id, provider, auth_type, status, provider_account_hint, last_validated_at, created_at";

/** Every connection the workspace has, whatever its status. The screen's list. */
export async function listConnections(
  db: D1Database,
  workspaceId: string,
): Promise<readonly ConnectionSummary[]> {
  const result = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM model_connection
       WHERE workspace_id = ? ORDER BY created_at DESC`,
    )
    .bind(workspaceId)
    .all<ConnectionRow>();
  return result.results.map(summaryFromRow);
}

/** Only active rows: the browser names one of these on submit, and a revoked one would be refused. */
export async function listActiveConnectionSummaries(
  db: D1Database,
  workspaceId: string,
): Promise<
  readonly {
    readonly modelConnectionId: string;
    readonly label: string;
    readonly provider: ProviderId;
    readonly modelId: string;
    readonly models: readonly ModelSpec[];
  }[]
> {
  const all = await listConnections(db, workspaceId);
  return all
    .filter((connection) => connection.status === "active")
    .map((connection) => ({
      modelConnectionId: connection.connectionId,
      // No column holds a user-chosen name, so the label is derived.
      label:
        connection.providerAccountHint === null
          ? PROVIDER_ADAPTERS[connection.provider].id
          : `${PROVIDER_ADAPTERS[connection.provider].id} ${connection.providerAccountHint}`,
      provider: connection.provider,
      // The default model a run charges (see `resolveModel`), so the composer
      // names the model; the label is the account hint.
      modelId: PROVIDER_ADAPTERS[connection.provider].defaultModel.modelId,
      // Every model this key may run on; `modelId` is the one the picker opens on.
      models: PROVIDER_ADAPTERS[connection.provider].models,
    }));
}

export type CreateConnectionOutcome =
  | { readonly kind: "created"; readonly summary: ConnectionSummary }
  | { readonly kind: "rejected"; readonly category: ProviderCategory }
  /** The workspace already holds a key for this provider that is not revoked; replace it instead. */
  | { readonly kind: "already_connected"; readonly connectionId: string };

/**
 * One key per provider, so the picker lists each model once. A wrong or
 * expiring key is replaced in place, keeping its id and sessions; only a
 * revoked row leaves room for a new one.
 */
async function connectedConnectionId(
  db: D1Database,
  workspaceId: string,
  provider: ProviderId,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT connection_id FROM model_connection
       WHERE workspace_id = ? AND provider = ? AND status != 'revoked'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(workspaceId, provider)
    .first<{ readonly connection_id: string }>();
  return row === null ? null : row.connection_id;
}

/**
 * Active sessions per connection, from `session_index`. A session counts while
 * active, since its next message would need the key. Unused connections are
 * absent.
 */
export async function activeSessionsByConnection(
  db: D1Database,
  workspaceId: string,
): Promise<ReadonlyMap<string, number>> {
  const result = await db
    .prepare(
      `SELECT model_connection_id, COUNT(*) AS sessions FROM session_index
       WHERE workspace_id = ? AND state = 'active' AND model_connection_id IS NOT NULL
       GROUP BY model_connection_id`,
    )
    .bind(workspaceId)
    .all<{ readonly model_connection_id: string; readonly sessions: number }>();
  return new Map(result.results.map((row) => [row.model_connection_id, row.sessions]));
}

/**
 * Validates against the live provider before writing, so a known-bad key is
 * never stored and no transient "validating" status exists.
 */
export async function createConnection(
  deps: ConnectionDeps,
  workspaceId: string,
  provider: ProviderId,
  credential: string,
): Promise<CreateConnectionOutcome> {
  // Before validation, so a duplicate never costs a provider call.
  const existing = await connectedConnectionId(deps.db, workspaceId, provider);
  if (existing !== null) {
    return { kind: "already_connected", connectionId: existing };
  }
  const adapter = PROVIDER_ADAPTERS[provider];
  const validated = await adapter.validate({
    origin: deps.originFor(adapter),
    credential,
    fetchImpl: deps.fetchImpl,
  });
  if (validated.kind === "failed") {
    return { kind: "rejected", category: validated.category };
  }
  const connectionId = deps.newId();
  const now = deps.now();
  const context: CredentialContext = { connectionId, workspaceId, provider };
  const sealed = await sealCredential(deps.keyring, context, credential);
  await deps.db
    .prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference,
         status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'api_key', ?, 'active', ?, NULL, ?, ?, ?)`,
    )
    .bind(connectionId, workspaceId, provider, sealed, validated.accountHint, now, now, now)
    .run();
  return {
    kind: "created",
    summary: {
      connectionId,
      provider,
      status: "active",
      providerAccountHint: validated.accountHint,
      lastValidatedAt: now,
      createdAt: now,
    },
  };
}

export type ReplaceCredentialOutcome =
  | { readonly kind: "replaced"; readonly summary: ConnectionSummary }
  | { readonly kind: "rejected"; readonly category: ProviderCategory }
  | { readonly kind: "not_found" };

/** One of the workspace's connections, or `null` for an absent id or another workspace's. */
export async function readConnection(
  db: D1Database,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSummary | null> {
  const found = await atMostOne<ConnectionRow>(
    db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM model_connection
         WHERE connection_id = ? AND workspace_id = ?`,
      )
      .bind(connectionId, workspaceId),
  );
  return found.kind === "absent" ? null : summaryFromRow(found.row);
}

/**
 * Keeps the connection id, so the new value seals under the same additional
 * data. Also clears `invalid` back to `active` (record 06).
 */
export async function replaceCredential(
  deps: ConnectionDeps,
  workspaceId: string,
  connectionId: string,
  credential: string,
): Promise<ReplaceCredentialOutcome> {
  const summary = await readConnection(deps.db, workspaceId, connectionId);
  if (summary === null) {
    return { kind: "not_found" };
  }
  const adapter = PROVIDER_ADAPTERS[summary.provider];
  const validated = await adapter.validate({
    origin: deps.originFor(adapter),
    credential,
    fetchImpl: deps.fetchImpl,
  });
  if (validated.kind === "failed") {
    return { kind: "rejected", category: validated.category };
  }
  const now = deps.now();
  const context: CredentialContext = { connectionId, workspaceId, provider: summary.provider };
  const sealed = await sealCredential(deps.keyring, context, credential);
  await deps.db
    .prepare(
      `UPDATE model_connection
       SET credential_reference = ?, status = 'active', provider_account_hint = ?,
           last_validated_at = ?, updated_at = ?
       WHERE connection_id = ? AND workspace_id = ?`,
    )
    .bind(sealed, validated.accountHint, now, now, connectionId, workspaceId)
    .run();
  return {
    kind: "replaced",
    summary: {
      ...summary,
      status: "active",
      providerAccountHint: validated.accountHint,
      lastValidatedAt: now,
    },
  };
}

export type RevokeOutcome =
  | { readonly kind: "revoked"; readonly summary: ConnectionSummary }
  | { readonly kind: "not_found" };

/**
 * Destroys the sealed bytes, so a withdrawn key is not recoverable by a later
 * keyring holder; the audit fields survive. `readAuthorizedConnection` reads
 * the status live, so forwarding stops on the next request.
 */
export async function revokeConnection(
  db: D1Database,
  workspaceId: string,
  connectionId: string,
  now: string,
): Promise<RevokeOutcome> {
  const result = await db
    .prepare(
      `UPDATE model_connection
       SET status = 'revoked', credential_reference = '', updated_at = ?
       WHERE connection_id = ? AND workspace_id = ? AND status != 'revoked'
       RETURNING ${SUMMARY_COLUMNS}`,
    )
    .bind(now, connectionId, workspaceId)
    .all<ConnectionRow>();
  const row = result.results.at(0);
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return { kind: "revoked", summary: summaryFromRow(row) };
}

/** What a check of a stored key reads: the sealed value, never a plaintext. */
export type StoredKey =
  | {
      readonly kind: "found";
      readonly provider: ProviderId;
      readonly status: ConnectionStatus;
      readonly sealed: string;
      readonly lastValidatedAt: string | null;
    }
  | { readonly kind: "absent" };

interface StoredKeyRow {
  readonly provider: string;
  readonly status: string;
  readonly credential_reference: string;
  readonly last_validated_at: string | null;
}

/** Absent covers another workspace's connection, so ids cannot be probed. */
export async function readStoredKey(
  db: D1Database,
  workspaceId: string,
  connectionId: string,
): Promise<StoredKey> {
  const found = await atMostOne<StoredKeyRow>(
    db
      .prepare(
        `SELECT provider, status, credential_reference, last_validated_at FROM model_connection
         WHERE connection_id = ? AND workspace_id = ?`,
      )
      .bind(connectionId, workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "absent" };
  }
  // Sound by the same CHECKs as in `summaryFromRow`.
  return {
    kind: "found",
    provider: found.row.provider as ProviderId,
    status: found.row.status as ConnectionStatus,
    sealed: found.row.credential_reference,
    lastValidatedAt: found.row.last_validated_at,
  };
}

/** The key a verdict is about: the sealed value that was opened and asked about. */
export interface CheckedKey {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly sealed: string;
}

/**
 * Writes what the provider said about a key. Each statement names the sealed
 * value that was checked, so a verdict on a key replaced or revoked meanwhile
 * changes nothing. Accepted returns `invalid` to `active` and moves
 * `last_validated_at`; rejected marks an `active` row `invalid`.
 */
export async function recordKeyVerdict(
  db: D1Database,
  key: CheckedKey,
  verdict: "accepted" | "rejected",
  now: string,
): Promise<void> {
  const statement =
    verdict === "accepted"
      ? `UPDATE model_connection
         SET status = 'active', last_validated_at = ?1, updated_at = ?1
         WHERE connection_id = ?2 AND workspace_id = ?3 AND credential_reference = ?4
           AND status IN ('active', 'invalid')`
      : `UPDATE model_connection
         SET status = 'invalid', updated_at = ?1
         WHERE connection_id = ?2 AND workspace_id = ?3 AND credential_reference = ?4
           AND status = 'active'`;
  await db.prepare(statement).bind(now, key.connectionId, key.workspaceId, key.sealed).run();
}

export type ResolveModelOutcome =
  | { readonly kind: "fake" }
  | { readonly kind: "resolved"; readonly model: ModelRecord }
  | {
      readonly kind: "refused";
      readonly reason:
        | "malformed"
        | "connection_required"
        | "not_usable"
        | "not_active"
        | "model_unavailable"
        | "effort_unsupported";
    };

interface ProviderAuthRow {
  readonly provider: string;
  readonly auth_type: string;
  readonly status: string;
}

/**
 * Turns the connection a create-session request names into the run's
 * `ModelRecord`.
 *
 *   names none, workspace has no active connection  -> fake
 *   names none, workspace has one or more           -> refused connection_required
 *   names a non-string or empty id                  -> refused malformed
 *   names one that is absent or another workspace's -> refused not_usable
 *   names one of the caller's that is not active    -> refused not_active
 *   names one of the caller's that is active        -> resolved
 *
 * The server never picks a connection (record 15 requires the user's explicit
 * choice), and a workspace with a connection never falls back to the fake
 * driver. Absent and another workspace's collapse into one reason so ids
 * cannot be probed; `not_active` is the caller's own row, so it is told.
 */
export async function resolveModel(
  db: D1Database,
  workspaceId: string,
  raw: unknown,
): Promise<ResolveModelOutcome> {
  const named =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).modelConnectionId
      : undefined;

  if (named === undefined) {
    // COUNT(*) always returns a row.
    const active = await exactlyOne<{ readonly count: number }>(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM model_connection WHERE workspace_id = ? AND status = 'active'",
        )
        .bind(workspaceId),
      "COUNT(*) returned no row",
    );
    if (active.count === 0) {
      return { kind: "fake" };
    }
    return { kind: "refused", reason: "connection_required" };
  }

  if (typeof named !== "string") {
    return { kind: "refused", reason: "malformed" };
  }
  if (named.length === 0) {
    return { kind: "refused", reason: "malformed" };
  }

  const found = await atMostOne<ProviderAuthRow>(
    db
      .prepare(
        "SELECT provider, auth_type, status FROM model_connection WHERE connection_id = ? AND workspace_id = ?",
      )
      .bind(named, workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "refused", reason: "not_usable" };
  }
  if (found.row.status !== "active") {
    return { kind: "refused", reason: "not_active" };
  }
  // Sound by 0003's CHECK, which matches `PROVIDER_ADAPTERS`' keys.
  const provider = found.row.provider as ProviderId;
  const adapter = PROVIDER_ADAPTERS[provider];

  // A model off the catalog or of the wrong shape is `model_unavailable`
  // (record 15); none named gets the recommended row.
  const wantedModel = (raw as Record<string, unknown>).modelId;
  const spec =
    wantedModel === undefined
      ? adapter.defaultModel
      : typeof wantedModel === "string"
        ? findModel(provider, wantedModel)
        : null;
  if (spec === null) {
    return { kind: "refused", reason: "model_unavailable" };
  }

  // Absent means the model's default; `null` or a level must be one the model
  // documents (`acceptsEffort`); anything else is malformed.
  const wantedEffort = (raw as Record<string, unknown>).effort;
  let effort: EffortLevel | null;
  if (wantedEffort === undefined) {
    effort = spec.defaultEffort;
  } else if (wantedEffort === null || isEffortLevel(wantedEffort)) {
    if (!acceptsEffort(spec, wantedEffort)) {
      return { kind: "refused", reason: "effort_unsupported" };
    }
    effort = wantedEffort;
  } else {
    return { kind: "refused", reason: "malformed" };
  }

  return {
    kind: "resolved",
    model: {
      provider,
      modelId: spec.modelId,
      modelConnectionId: named,
      authenticationType: found.row.auth_type === "subscription" ? "subscription" : "api_key",
      contextWindow: spec.contextWindow,
      effort,
    },
  };
}

export type ForwardAuthorization =
  | {
      readonly kind: "authorized";
      readonly provider: ProviderId;
      readonly sealed: string;
    }
  | { readonly kind: "denied" };

/** What a forward asserts, already proved by the token's signature. */
export interface ForwardClaimCheck {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly sandboxGeneration: number;
}

interface ForwardRow {
  readonly provider: string;
  readonly status: string;
  readonly credential_reference: string;
  readonly session_state: string;
  readonly sandbox_generation: number | null;
  readonly ended_sandbox_generation: number | null;
}

/**
 * The forward's one indexed read: the connection and session exist in the
 * caller's workspace, the session is active, the generation is current, and
 * the connection is not revoked. It returns the ciphertext in the same row.
 *
 * Every denial collapses to one answer, so a sandbox cannot enumerate
 * resources. A NULL `sandbox_generation` (not yet projected) is a mismatch. A
 * token for `ended_sandbox_generation` or older is refused (record 11), since
 * a stopped sandbox keeps its generation number until a resume replaces it.
 */
export async function readAuthorizedConnection(
  db: D1Database,
  claims: ForwardClaimCheck,
): Promise<ForwardAuthorization> {
  const found = await atMostOne<ForwardRow>(
    db
      .prepare(
        `SELECT mc.provider AS provider,
                mc.status AS status,
                mc.credential_reference AS credential_reference,
                si.state AS session_state,
                si.sandbox_generation AS sandbox_generation,
                si.ended_sandbox_generation AS ended_sandbox_generation
           FROM model_connection AS mc
           JOIN session_index AS si ON si.session_id = ?
          WHERE mc.connection_id = ?
            AND mc.workspace_id = ?
            AND si.workspace_id = ?`,
      )
      .bind(claims.sessionId, claims.connectionId, claims.workspaceId, claims.workspaceId),
  );
  if (found.kind === "absent") {
    return { kind: "denied" };
  }
  if (found.row.status !== "active") {
    return { kind: "denied" };
  }
  if (found.row.session_state !== "active") {
    return { kind: "denied" };
  }
  if (found.row.sandbox_generation !== claims.sandboxGeneration) {
    return { kind: "denied" };
  }
  const ended = found.row.ended_sandbox_generation;
  if (ended !== null && ended >= claims.sandboxGeneration) {
    return { kind: "denied" };
  }
  // Sound by the same CHECK as in `resolveModel`.
  return {
    kind: "authorized",
    provider: found.row.provider as ProviderId,
    sealed: found.row.credential_reference,
  };
}
