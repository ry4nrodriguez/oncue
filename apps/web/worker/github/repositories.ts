/**
 * The two reads that turn GitHub rows into authorization answers: what the
 * setup screen lists, and whether a create-session request may name a
 * repository.
 */

import type { GitHubFact } from "../setup/derive";
import {
  type AuthorizedRepository,
  listInstallations,
  listRepositoryConnections,
  readAuthorizedRepository,
} from "./store";

/**
 * The seam `worker/setup/read.ts` names for `github`:
 *
 *   no installation row                   -> none
 *   no ACTIVE installation                -> none
 *   active, zero verified repositories    -> installed, []
 *   active, one or more verified          -> installed, xs
 *
 * A lapsed installation reads as none because the user's next step is the
 * same connection flow. Only `verified` repositories under an `active`
 * installation are listed, since anything else would be refused by
 * `resolveRepository`. `cancelled` and `pending_approval` come from the
 * redirect's query parameter, not from any row, so they never appear here.
 */
export async function readGitHubFact(db: D1Database, workspaceId: string): Promise<GitHubFact> {
  const installations = await listInstallations(db, workspaceId);
  const activeRowIds = new Set(
    installations
      .filter((installation) => installation.status === "active")
      .map((installation) => installation.installationRowId),
  );
  if (activeRowIds.size === 0) {
    return { kind: "none" };
  }
  const repositories = await listRepositoryConnections(db, workspaceId);
  return {
    kind: "installed",
    repositories: repositories
      .filter(
        (repository) =>
          repository.status === "verified" &&
          repository.removedAt === null &&
          activeRowIds.has(repository.installationRowId),
      )
      .map((repository) => ({
        repositoryConnectionId: repository.repositoryConnectionId,
        fullName: repository.fullName,
      })),
  };
}

export type ResolveRepositoryOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly repository: AuthorizedRepository }
  | { readonly kind: "refused"; readonly reason: "malformed" | "not_usable" | "not_connected" };

/**
 * The twin of `resolveModel` for the repository a create-session request
 * names:
 *
 *   names none                                      -> none
 *   names a non-string or empty id                  -> refused malformed
 *   names one that is absent or another workspace's -> refused not_usable
 *   names one of the caller's that is disconnected,
 *     removed under Settings, or whose installation
 *     is not active                                 -> refused not_connected
 *   names one of the caller's that is verified      -> resolved
 *
 * Naming no repository is a legitimate session, and the server never picks
 * one for the user. Absent and another workspace's collapse into `not_usable`
 * (the scope is in the SQL) so ids cannot be probed across workspaces.
 */
export async function resolveRepository(
  db: D1Database,
  workspaceId: string,
  raw: unknown,
): Promise<ResolveRepositoryOutcome> {
  const named =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).repositoryConnectionId
      : undefined;

  if (named === undefined) {
    return { kind: "none" };
  }
  if (typeof named !== "string") {
    return { kind: "refused", reason: "malformed" };
  }
  if (named.length === 0) {
    return { kind: "refused", reason: "malformed" };
  }

  const found = await readAuthorizedRepository(db, workspaceId, named);
  if (found.kind === "absent") {
    return { kind: "refused", reason: "not_usable" };
  }
  if (found.row.status !== "verified") {
    return { kind: "refused", reason: "not_connected" };
  }
  // Removed under Settings: the caller's own row, so "reconnect this one", which
  // Restore does.
  if (found.row.removedAt !== null) {
    return { kind: "refused", reason: "not_connected" };
  }
  if (found.row.installationStatus !== "active") {
    return { kind: "refused", reason: "not_connected" };
  }
  return { kind: "resolved", repository: found.row };
}
