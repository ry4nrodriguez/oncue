/**
 * The browser's copy of the model connections contract: a defensive parser
 * and a thin `fetch` wrapper returning discriminated unions.
 * `ModelFailureCategory` comes from `@oncue/protocol` so it cannot drift.
 */
import { MODEL_FAILURE_CATEGORIES, type ModelFailureCategory } from "@oncue/protocol";
import { type ModelCatalog, parseCatalog } from "./setup";

export type { ModelCatalog } from "./setup";

export type ModelProvider = "anthropic" | "openai";

export type ModelConnectionStatus =
  | "active"
  | "invalid"
  | "expired"
  | "revoked"
  | "attention_required";

// No `credential` field: the Worker never returns one.
export interface ModelConnectionRow {
  readonly connectionId: string;
  readonly provider: ModelProvider;
  readonly status: ModelConnectionStatus;
  readonly providerAccountHint: string | null;
  readonly lastValidatedAt: string | null;
  readonly createdAt: string;
  /** Active sessions still charging this key, from the list route; zero on create, replace, and revoke responses. */
  readonly activeSessions: number;
}

export type CreateConnectionInvalidReason = "provider" | "credential";

export type ListConnectionsResult =
  | {
      readonly kind: "listed";
      readonly connections: readonly ModelConnectionRow[];
      readonly catalog: ModelCatalog;
      /** The date the catalog's prices were read from the providers, ISO `YYYY-MM-DD`. */
      readonly pricesAsOf: string;
    }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type CreateConnectionResult =
  | { readonly kind: "created"; readonly connection: ModelConnectionRow }
  | { readonly kind: "invalid"; readonly reason: CreateConnectionInvalidReason }
  /** The provider already holds a key that is not revoked; replace that one instead. */
  | { readonly kind: "already_connected"; readonly connectionId: string }
  | { readonly kind: "validation_failed"; readonly category: ModelFailureCategory }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type ReplaceCredentialResult =
  | { readonly kind: "replaced"; readonly connection: ModelConnectionRow }
  | { readonly kind: "validation_failed"; readonly category: ModelFailureCategory }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type RevokeConnectionResult =
  | { readonly kind: "revoked"; readonly connection: ModelConnectionRow }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

/** What the provider said when asked about the stored key just now. */
export type KeyCheck = "accepted" | "rejected" | "unreachable";

export type RecheckConnectionResult =
  /** `connection` is the row after the check: accepted is active, rejected invalid, unreachable unchanged. */
  | { readonly kind: "checked"; readonly check: KeyCheck; readonly connection: ModelConnectionRow }
  /** The connection was revoked, so it holds no key to check. */
  | { readonly kind: "revoked" }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  /** OnCue could not open the stored key; nothing was asked of the provider. */
  | { readonly kind: "failed" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelProvider(value: unknown): value is ModelProvider {
  return value === "anthropic" || value === "openai";
}

function isModelConnectionStatus(value: unknown): value is ModelConnectionStatus {
  return (
    value === "active" ||
    value === "invalid" ||
    value === "expired" ||
    value === "revoked" ||
    value === "attention_required"
  );
}

function isModelFailureCategory(value: unknown): value is ModelFailureCategory {
  return (
    typeof value === "string" && (MODEL_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

function parseConnectionRow(raw: unknown): ModelConnectionRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { connectionId, provider, status, providerAccountHint, lastValidatedAt, createdAt } = raw;
  if (typeof connectionId !== "string") {
    return null;
  }
  if (!isModelProvider(provider)) {
    return null;
  }
  if (!isModelConnectionStatus(status)) {
    return null;
  }
  if (providerAccountHint !== null && typeof providerAccountHint !== "string") {
    return null;
  }
  if (lastValidatedAt !== null && typeof lastValidatedAt !== "string") {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  const activeSessions =
    typeof raw.activeSessions === "number" && Number.isInteger(raw.activeSessions)
      ? raw.activeSessions
      : 0;
  return {
    connectionId,
    provider,
    status,
    providerAccountHint,
    lastValidatedAt,
    createdAt,
    activeSessions,
  };
}

function parseConnectionRows(raw: unknown): readonly ModelConnectionRow[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const rows: ModelConnectionRow[] = [];
  for (const item of raw) {
    const row = parseConnectionRow(item);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

function invalidReasonFrom(body: unknown): CreateConnectionInvalidReason {
  const reason: unknown = isRecord(body) ? body.reason : undefined;
  return reason === "credential" ? "credential" : "provider";
}

/** `null` means the 422 body did not carry a category this build recognizes. */
function categoryFrom(body: unknown): ModelFailureCategory | null {
  const category: unknown = isRecord(body) ? body.category : undefined;
  return isModelFailureCategory(category) ? category : null;
}

/** Pure. Never throws. */
export function parseListConnectionsResponse(status: number, body: unknown): ListConnectionsResult {
  if (status === 200) {
    const connections = parseConnectionRows(isRecord(body) ? body.connections : undefined);
    const catalog = parseCatalog(isRecord(body) ? body.catalog : undefined);
    const pricesAsOf = isRecord(body) ? body.pricesAsOf : undefined;
    if (connections === null || catalog === null || typeof pricesAsOf !== "string") {
      return { kind: "unreachable" };
    }
    return { kind: "listed", connections, catalog, pricesAsOf };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseCreateConnectionResponse(
  status: number,
  body: unknown,
): CreateConnectionResult {
  if (status === 201) {
    const connection = parseConnectionRow(isRecord(body) ? body.connection : undefined);
    if (connection === null) {
      return { kind: "unreachable" };
    }
    return { kind: "created", connection };
  }
  if (status === 400) {
    return { kind: "invalid", reason: invalidReasonFrom(body) };
  }
  if (status === 409) {
    const connectionId = isRecord(body) ? body.connectionId : undefined;
    return {
      kind: "already_connected",
      connectionId: typeof connectionId === "string" ? connectionId : "",
    };
  }
  if (status === 422) {
    const category = categoryFrom(body);
    if (category === null) {
      return { kind: "unreachable" };
    }
    return { kind: "validation_failed", category };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseReplaceCredentialResponse(
  status: number,
  body: unknown,
): ReplaceCredentialResult {
  if (status === 200) {
    const connection = parseConnectionRow(isRecord(body) ? body.connection : undefined);
    if (connection === null) {
      return { kind: "unreachable" };
    }
    return { kind: "replaced", connection };
  }
  if (status === 422) {
    const category = categoryFrom(body);
    if (category === null) {
      return { kind: "unreachable" };
    }
    return { kind: "validation_failed", category };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseRevokeConnectionResponse(
  status: number,
  body: unknown,
): RevokeConnectionResult {
  if (status === 200) {
    const connection = parseConnectionRow(isRecord(body) ? body.connection : undefined);
    if (connection === null) {
      return { kind: "unreachable" };
    }
    return { kind: "revoked", connection };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseRecheckConnectionResponse(
  status: number,
  body: unknown,
): RecheckConnectionResult {
  if (status === 200) {
    const connection = parseConnectionRow(isRecord(body) ? body.connection : undefined);
    const check: unknown = isRecord(body) ? body.check : undefined;
    if (
      connection === null ||
      (check !== "accepted" && check !== "rejected" && check !== "unreachable")
    ) {
      return { kind: "unreachable" };
    }
    return { kind: "checked", check, connection };
  }
  if (status === 409) {
    return { kind: "revoked" };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 503) {
    return { kind: "failed" };
  }
  return { kind: "unreachable" };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function listModelConnections(): Promise<ListConnectionsResult> {
  try {
    const response = await fetch("/api/model-connections");
    return parseListConnectionsResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function createModelConnection(input: {
  provider: ModelProvider;
  credential: string;
}): Promise<CreateConnectionResult> {
  try {
    const response = await fetch("/api/model-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: input.provider, credential: input.credential }),
    });
    return parseCreateConnectionResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

/** The Model providers page's Replace: a new key under the same connection id, so every session on it continues. */
export async function replaceModelConnectionCredential(
  connectionId: string,
  credential: string,
): Promise<ReplaceCredentialResult> {
  try {
    const response = await fetch(`/api/model-connections/${encodeURIComponent(connectionId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    return parseReplaceCredentialResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function revokeModelConnection(connectionId: string): Promise<RevokeConnectionResult> {
  try {
    const response = await fetch(
      `/api/model-connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST" },
    );
    return parseRevokeConnectionResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

/** The Model providers page's Re-check: asks the provider about the stored key now. */
export async function recheckModelConnection(
  connectionId: string,
): Promise<RecheckConnectionResult> {
  try {
    const response = await fetch(
      `/api/model-connections/${encodeURIComponent(connectionId)}/recheck`,
      { method: "POST" },
    );
    return parseRecheckConnectionResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}
