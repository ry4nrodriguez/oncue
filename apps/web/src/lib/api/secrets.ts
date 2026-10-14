/**
 * The browser's copy of the development-secrets contract (record 08). Names
 * come back, never values, so no type here has a value field. Results are
 * discriminated unions; nothing throws across the boundary.
 */

export type SecretStatus = "active" | "unreadable";

export interface SecretSummary {
  readonly secretId: string;
  readonly name: string;
  readonly status: SecretStatus;
  readonly updatedAt: string;
}

export type ListSecretsResult =
  | { readonly kind: "listed"; readonly secrets: readonly SecretSummary[] }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

/** Why the server refused a save, as it says it: `name_reserved`, `value_too_short`, and the rest. */
export type SaveSecretResult =
  | { readonly kind: "saved"; readonly secret: SecretSummary }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type DeleteSecretResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSummary(raw: unknown): SecretSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { secretId, name, status, updatedAt } = raw;
  if (
    typeof secretId !== "string" ||
    typeof name !== "string" ||
    (status !== "active" && status !== "unreadable") ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return { secretId, name, status, updatedAt };
}

function denied(status: number): boolean {
  return status === 401 || status === 403;
}

/** Pure. Never throws. */
export function parseListSecretsResponse(status: number, body: unknown): ListSecretsResult {
  if (denied(status)) {
    return { kind: "denied" };
  }
  const raw = status === 200 && isRecord(body) ? body.secrets : undefined;
  if (!Array.isArray(raw)) {
    return { kind: "unreachable" };
  }
  const secrets = raw.map(parseSummary);
  return secrets.some((secret) => secret === null)
    ? { kind: "unreachable" }
    : { kind: "listed", secrets: secrets as SecretSummary[] };
}

/** Pure. Never throws. */
export function parseSaveSecretResponse(status: number, body: unknown): SaveSecretResult {
  if (denied(status)) {
    return { kind: "denied" };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 400 && isRecord(body) && typeof body.reason === "string") {
    return { kind: "invalid", reason: body.reason };
  }
  const secret = status === 200 && isRecord(body) ? parseSummary(body.secret) : null;
  return secret === null ? { kind: "unreachable" } : { kind: "saved", secret };
}

/** Pure. Never throws. */
export function parseDeleteSecretResponse(status: number): DeleteSecretResult {
  if (denied(status)) {
    return { kind: "denied" };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  return status === 200 ? { kind: "deleted" } : { kind: "unreachable" };
}

function secretsPath(repositoryConnectionId: string, name?: string): string {
  const base = `/api/repositories/${encodeURIComponent(repositoryConnectionId)}/secrets`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function listSecrets(repositoryConnectionId: string): Promise<ListSecretsResult> {
  try {
    const response = await fetch(secretsPath(repositoryConnectionId));
    return parseListSecretsResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

/** The value travels in the body, never in the URL, and is not kept anywhere on this side once sent. */
export async function saveSecret(
  repositoryConnectionId: string,
  name: string,
  value: string,
): Promise<SaveSecretResult> {
  try {
    const response = await fetch(secretsPath(repositoryConnectionId, name), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return parseSaveSecretResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function deleteSecret(
  repositoryConnectionId: string,
  name: string,
): Promise<DeleteSecretResult> {
  try {
    const response = await fetch(secretsPath(repositoryConnectionId, name), { method: "DELETE" });
    return parseDeleteSecretResponse(response.status);
  } catch {
    return { kind: "unreachable" };
  }
}

export interface RequestedSecret {
  readonly name: string;
  readonly saved: boolean;
  readonly isNew: boolean;
}

/**
 * What a repository's project file asks for, read by the control plane at
 * `baseSha` (record 08). `invalid` is a file the reader refused, with the line
 * and reason to show; nothing is supplied from one.
 */
export type SecretRequests =
  | { readonly kind: "none"; readonly baseSha: string }
  | {
      readonly kind: "declared";
      readonly baseSha: string;
      readonly required: readonly RequestedSecret[];
      readonly optional: readonly RequestedSecret[];
    }
  | {
      readonly kind: "invalid";
      readonly baseSha: string;
      readonly line: number;
      readonly reason: string;
    }
  | { readonly kind: "denied" }
  /**
   * GitHub must be reconnected before anything can be read (the installation
   * needs verifying, is inactive, or is gone). Distinct from "unreadable"
   * because a retry cannot help.
   */
  | { readonly kind: "reconnect_github" }
  /** The file could not be read. Never treated as "asks for nothing". */
  | { readonly kind: "unreadable" }
  /** The branch the session would start from is no longer on GitHub. */
  | { readonly kind: "branch_missing" };

function parseRequested(raw: unknown): readonly RequestedSecret[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const entries: RequestedSecret[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.saved !== "boolean" ||
      typeof item.isNew !== "boolean"
    ) {
      return null;
    }
    entries.push({ name: item.name, saved: item.saved, isNew: item.isNew });
  }
  return entries;
}

/** Pure. Never throws. */
export function parseSecretRequestsResponse(status: number, body: unknown): SecretRequests {
  // Read before the status: a refused installation verification comes back as
  // 403, which would otherwise read as `denied`.
  if (isRecord(body) && body.error === "github_reverification_required") {
    return { kind: "reconnect_github" };
  }
  if (denied(status)) {
    return { kind: "denied" };
  }
  if (status === 409 && isRecord(body) && body.error === "branch_refused") {
    return { kind: "branch_missing" };
  }
  if (status !== 200 || !isRecord(body) || typeof body.baseSha !== "string") {
    return { kind: "unreadable" };
  }
  const baseSha = body.baseSha;
  if (body.state === "none") {
    return { kind: "none", baseSha };
  }
  if (body.state === "invalid") {
    return typeof body.line === "number" && typeof body.reason === "string"
      ? { kind: "invalid", baseSha, line: body.line, reason: body.reason }
      : { kind: "unreadable" };
  }
  const required = parseRequested(body.required);
  const optional = parseRequested(body.optional);
  return body.state === "declared" && required !== null && optional !== null
    ? { kind: "declared", baseSha, required, optional }
    : { kind: "unreadable" };
}

/** Read at the tip of `branch`, the branch the session would start from; null for the default branch. */
export async function getSecretRequests(
  repositoryConnectionId: string,
  branch: string | null = null,
): Promise<SecretRequests> {
  const query = branch === null ? "" : `?branch=${encodeURIComponent(branch)}`;
  try {
    const response = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryConnectionId)}/secret-requests${query}`,
    );
    return parseSecretRequestsResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreadable" };
  }
}
