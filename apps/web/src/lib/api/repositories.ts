/**
 * The browser's copy of the repositories and GitHub-install contract: a
 * defensive parser and a thin `fetch` wrapper per route, returning
 * discriminated unions.
 */

export type RepositoryStatus = "verified" | "disconnected";

export interface RepositoryRow {
  readonly repositoryConnectionId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly status: RepositoryStatus;
  /** When the workspace removed it from OnCue under Settings; `null` ordinarily. */
  readonly removedAt: string | null;
  readonly createdAt: string;
}

export type UpdateRepositoryResult =
  | { readonly kind: "updated"; readonly repository: RepositoryRow }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

export type ListRepositoriesResult =
  | { readonly kind: "listed"; readonly repositories: readonly RepositoryRow[] }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

// "unconfigured" (503, no GitHub App configured) and "unreachable" (network
// failure or unknown shape) need different sentences on screen.
export type InstallUrlResult =
  | { readonly kind: "minted"; readonly installUrl: string }
  | { readonly kind: "denied" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRepositoryStatus(value: unknown): value is RepositoryStatus {
  return value === "verified" || value === "disconnected";
}

function parseRepositoryRow(raw: unknown): RepositoryRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { repositoryConnectionId, fullName, defaultBranch, status, createdAt } = raw;
  if (typeof repositoryConnectionId !== "string") {
    return null;
  }
  if (typeof fullName !== "string") {
    return null;
  }
  if (typeof defaultBranch !== "string") {
    return null;
  }
  if (!isRepositoryStatus(status)) {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  const removedAt = typeof raw.removedAt === "string" ? raw.removedAt : null;
  return { repositoryConnectionId, fullName, defaultBranch, status, removedAt, createdAt };
}

function parseRepositoryRows(raw: unknown): readonly RepositoryRow[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const rows: RepositoryRow[] = [];
  for (const item of raw) {
    const row = parseRepositoryRow(item);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

/** Pure. Never throws. */
export function parseListRepositoriesResponse(
  status: number,
  body: unknown,
): ListRepositoriesResult {
  if (status === 200) {
    const repositories = parseRepositoryRows(isRecord(body) ? body.repositories : undefined);
    if (repositories === null) {
      return { kind: "unreachable" };
    }
    return { kind: "listed", repositories };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Pure. Never throws. */
export function parseInstallUrlResponse(status: number, body: unknown): InstallUrlResult {
  if (status === 201) {
    const installUrl: unknown = isRecord(body) ? body.installUrl : undefined;
    if (typeof installUrl !== "string") {
      return { kind: "unreachable" };
    }
    return { kind: "minted", installUrl };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 503) {
    return { kind: "unconfigured" };
  }
  return { kind: "unreachable" };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** Pure. Never throws. Shared by remove and restore, which answer the same shape. */
export function parseUpdateRepositoryResponse(
  status: number,
  body: unknown,
): UpdateRepositoryResult {
  if (status === 200) {
    const repository = parseRepositoryRow(isRecord(body) ? body.repository : undefined);
    if (repository === null) {
      return { kind: "unreachable" };
    }
    return { kind: "updated", repository };
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  return { kind: "unreachable" };
}

/** Removes the repository from OnCue. The GitHub App's access is untouched. */
export async function removeRepository(
  repositoryConnectionId: string,
): Promise<UpdateRepositoryResult> {
  try {
    const response = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryConnectionId)}`,
      {
        method: "DELETE",
      },
    );
    return parseUpdateRepositoryResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function restoreRepository(
  repositoryConnectionId: string,
): Promise<UpdateRepositoryResult> {
  try {
    const response = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryConnectionId)}/restore`,
      { method: "POST" },
    );
    return parseUpdateRepositoryResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function listRepositories(): Promise<ListRepositoriesResult> {
  try {
    const response = await fetch("/api/repositories");
    return parseListRepositoriesResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function requestGitHubInstallUrl(): Promise<InstallUrlResult> {
  try {
    const response = await fetch("/api/github/install-url", { method: "POST" });
    return parseInstallUrlResponse(response.status, await readJson(response));
  } catch {
    return { kind: "unreachable" };
  }
}
