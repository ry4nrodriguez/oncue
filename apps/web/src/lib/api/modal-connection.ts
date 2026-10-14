/**
 * The browser's copy of the `/api/modal-connection` contract: a defensive
 * parser and a thin `fetch` wrapper returning discriminated unions. The Worker
 * never returns the token, so `ModalConnectionRow` has no token fields. A
 * workspace has one Modal account, so there is no list and disconnect takes
 * no id.
 */

export type ModalConnectionStatus = "active" | "invalid";

export interface ModalConnectionRow {
  readonly connectionId: string;
  /** The Modal workspace name the credential test read back, not anything typed. */
  readonly workspaceName: string;
  /** `null` means the Modal workspace's default Environment. */
  readonly environmentName: string | null;
  readonly status: ModalConnectionStatus;
  readonly lastValidatedAt: string;
  readonly createdAt: string;
}

/** The Worker's four, and the same closed set `worker/modal/client.ts` names. */
export type ModalTestFailureReason =
  | "invalid_credentials"
  | "no_environment_access"
  | "unreachable"
  | "controller_unavailable";

export type SaveModalConnectionInvalidReason = "tokenId" | "tokenSecret";

export type ReadModalConnectionResult =
  /** `connection` is `null` for a workspace that has not connected Modal. */
  | { readonly kind: "read"; readonly connection: ModalConnectionRow | null }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type SaveModalConnectionResult =
  | { readonly kind: "saved"; readonly connection: ModalConnectionRow }
  | { readonly kind: "invalid"; readonly reason: SaveModalConnectionInvalidReason }
  | { readonly kind: "test_failed"; readonly reason: ModalTestFailureReason }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type DisconnectModalConnectionResult =
  | { readonly kind: "disconnected" }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStatus(value: unknown): value is ModalConnectionStatus {
  return value === "active" || value === "invalid";
}

function isReason(value: unknown): value is ModalTestFailureReason {
  return (
    value === "invalid_credentials" ||
    value === "no_environment_access" ||
    value === "unreachable" ||
    value === "controller_unavailable"
  );
}

function parseConnectionRow(raw: unknown): ModalConnectionRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { connectionId, workspaceName, environmentName, status, lastValidatedAt, createdAt } = raw;
  if (typeof connectionId !== "string") {
    return null;
  }
  if (typeof workspaceName !== "string") {
    return null;
  }
  if (environmentName !== null && typeof environmentName !== "string") {
    return null;
  }
  if (!isStatus(status)) {
    return null;
  }
  if (typeof lastValidatedAt !== "string") {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  return { connectionId, workspaceName, environmentName, status, lastValidatedAt, createdAt };
}

/** Pure. Never throws. */
export function parseReadModalConnectionResponse(
  status: number,
  body: unknown,
): ReadModalConnectionResult {
  if (status === 200) {
    const raw: unknown = isRecord(body) ? body.connection : undefined;
    if (raw === null) {
      return { kind: "read", connection: null };
    }
    const connection = parseConnectionRow(raw);
    if (connection === null) {
      return { kind: "unreachable" };
    }
    return { kind: "read", connection };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/**
 * A 400 names the field and a 422 or 503 the test's reason. An unknown reason
 * falls back to `tokenId` for a 400 and to `unreachable` (the only safe
 * advice) for a failed test.
 */
export function parseSaveModalConnectionResponse(
  status: number,
  body: unknown,
): SaveModalConnectionResult {
  if (status === 200) {
    const connection = parseConnectionRow(isRecord(body) ? body.connection : undefined);
    if (connection === null) {
      return { kind: "unreachable" };
    }
    return { kind: "saved", connection };
  }
  if (status === 400) {
    const reason: unknown = isRecord(body) ? body.reason : undefined;
    return { kind: "invalid", reason: reason === "tokenSecret" ? "tokenSecret" : "tokenId" };
  }
  if (status === 422 || status === 503) {
    const reason: unknown = isRecord(body) ? body.reason : undefined;
    return { kind: "test_failed", reason: isReason(reason) ? reason : "unreachable" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseDisconnectModalConnectionResponse(
  status: number,
): DisconnectModalConnectionResult {
  if (status === 200) {
    return { kind: "disconnected" };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function readModalConnection(): Promise<ReadModalConnectionResult> {
  try {
    const response = await fetch("/api/modal-connection");
    return parseReadModalConnectionResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function saveModalConnection(input: {
  tokenId: string;
  tokenSecret: string;
  environmentName: string | null;
}): Promise<SaveModalConnectionResult> {
  try {
    const response = await fetch("/api/modal-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return parseSaveModalConnectionResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function disconnectModalConnection(): Promise<DisconnectModalConnectionResult> {
  try {
    const response = await fetch("/api/modal-connection", { method: "DELETE" });
    return parseDisconnectModalConnectionResponse(response.status);
  } catch {
    return { kind: "unreachable" };
  }
}
