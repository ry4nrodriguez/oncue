/**
 * The branches the composer's branch picker offers (record 07), from
 * `GET /api/repositories/:id/branches`. The list is a convenience: the Worker
 * reads the chosen branch from GitHub again when the session is created and
 * refuses it there, so nothing here decides what a session may push to.
 */

export interface BranchSummary {
  readonly name: string;
  /** GitHub's word: a protection rule or ruleset covers it, so a session never pushes to it. */
  readonly protected: boolean;
  readonly default: boolean;
}

export type ListBranchesResult =
  | {
      readonly kind: "listed";
      readonly defaultBranch: string;
      readonly branches: readonly BranchSummary[];
      /** More branches exist than one listing reads; a search narrows them. */
      readonly truncated: boolean;
    }
  | { readonly kind: "reconnect_github" }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBranch(raw: unknown): BranchSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { name, protected: isProtected, default: isDefault } = raw;
  if (
    typeof name !== "string" ||
    typeof isProtected !== "boolean" ||
    typeof isDefault !== "boolean"
  ) {
    return null;
  }
  return { name, protected: isProtected, default: isDefault };
}

/** Pure. Never throws. */
export function parseListBranchesResponse(status: number, body: unknown): ListBranchesResult {
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status === 409 && isRecord(body) && body.error === "github_reverification_required") {
    return { kind: "reconnect_github" };
  }
  if (status !== 200 || !isRecord(body)) {
    return { kind: "unreachable" };
  }
  const { defaultBranch, branches, truncated } = body;
  if (typeof defaultBranch !== "string" || !Array.isArray(branches)) {
    return { kind: "unreachable" };
  }
  const parsed = branches.map(parseBranch);
  if (parsed.some((branch) => branch === null)) {
    return { kind: "unreachable" };
  }
  return {
    kind: "listed",
    defaultBranch,
    branches: parsed as BranchSummary[],
    truncated: truncated === true,
  };
}

export async function listBranches(
  repositoryConnectionId: string,
  query: string,
): Promise<ListBranchesResult> {
  const search = query.trim().length === 0 ? "" : `?q=${encodeURIComponent(query.trim())}`;
  try {
    const response = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryConnectionId)}/branches${search}`,
    );
    const body: unknown = await response.json().catch(() => null);
    return parseListBranchesResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}
