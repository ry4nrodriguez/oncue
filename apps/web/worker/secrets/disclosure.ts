// Reads a repository's declaration under one `contents: read` token for that
// repository, revoked in a `finally` (record 07). The commit travels with the
// declaration, so a launch whose base has moved is refused rather than started
// on a file the user never saw.

import { type GitHubAppDeps, type MintFailure, withInstallationToken } from "../github/app";
import { readBranch, readBranchRules, readDefaultBranch } from "../github/branches";
import { type DeclarationRead, readDeclaredSecrets } from "./declaration";

export const DECLARATION_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  contents: "read",
};

export interface DeclarationRepository {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly fullName: string;
  /** The branch the session starts from: the default branch, or the one the user chose. */
  readonly branch: string;
  /**
   * Also read the repository's default branch as GitHub holds it now and the
   * ruleset rules on the branch, under the same token, so a launch onto an
   * existing branch can refuse the default or a guarded branch (record 07).
   */
  readonly readDefaultBranch?: boolean;
}

export type RepositoryDeclaration =
  | {
      readonly kind: "read";
      /** The commit the declaration was read at: the card's, or the branch's tip. */
      readonly baseSha: string;
      /** The branch's tip now, so a launch can tell a card drawn before the branch moved. */
      readonly tipSha: string;
      /**
       * GitHub's word that the branch is protected: classic protection, or,
       * when the default branch was asked for, a ruleset rule that guards pushes.
       */
      readonly protected: boolean;
      /** The default branch as GitHub holds it now, or null when it was not asked for. */
      readonly defaultBranch: string | null;
      readonly declaration: DeclarationRead;
    }
  | {
      readonly kind: "failed";
      readonly reason: DeclarationFailure;
      /** What went wrong, for the log line: fixed words and a status, never a token or a body. */
      readonly errorCategory: string;
    };

/**
 * `installation_missing` is a 404 on the token mint: the installation is gone,
 * so only reconnecting GitHub helps. `base_branch_missing` is the branch the
 * session would start from, whichever it is.
 */
export type DeclarationFailure =
  | "github"
  | "base_branch_missing"
  | "installation_missing"
  /** The branch's ruleset rules could not be read, so it is not worked on directly. */
  | "branch_rules_unreadable";

function readFailure(
  prefix: string,
  failure: { readonly category: string; readonly status: number | null },
): RepositoryDeclaration {
  return {
    kind: "failed",
    reason: "github",
    errorCategory:
      failure.status === null
        ? `${prefix}_${failure.category}`
        : `${prefix}_${failure.category}_${failure.status}`,
  };
}

/** The mint's failure as log words: `mint_rejected_404`, `mint_unreachable`, `mint_private_key_malformed`. */
export function mintFailureCategory(failure: MintFailure): string {
  if (failure.kind === "refused") {
    return `mint_${failure.reason}`;
  }
  return failure.status === null
    ? `mint_${failure.category}`
    : `mint_${failure.category}_${failure.status}`;
}

function notMinted(failure: MintFailure): RepositoryDeclaration {
  const missing =
    failure.kind === "failed" && failure.category === "rejected" && failure.status === 404;
  return {
    kind: "failed",
    reason: missing ? "installation_missing" : "github",
    errorCategory: mintFailureCategory(failure),
  };
}

export async function readRepositoryDeclaration(
  deps: GitHubAppDeps,
  repository: DeclarationRepository,
  /** The commit to read at, or null to read at the branch's head. */
  atSha: string | null,
): Promise<RepositoryDeclaration> {
  const ran = await withInstallationToken<RepositoryDeclaration>(
    deps,
    {
      installationId: repository.installationId,
      repositoryIds: [repository.repositoryId],
      permissions: DECLARATION_PERMISSIONS,
    },
    async (token) => {
      // Always read the tip: it is the read point with no card, and it detects a
      // moved branch with one.
      const branch = await readBranch(
        deps,
        { repositoryFullName: repository.fullName, branch: repository.branch },
        token,
      );
      if (branch.kind === "refused") {
        return { kind: "failed", reason: "base_branch_missing", errorCategory: branch.reason };
      }
      if (branch.kind === "failed") {
        return readFailure("branch_read", branch);
      }
      let defaultBranch: string | null = null;
      if (repository.readDefaultBranch === true) {
        const repo = await readDefaultBranch(deps, repository.fullName, token);
        if (repo.kind !== "found") {
          return readFailure(
            "repository_read",
            repo.kind === "failed" ? repo : { category: repo.reason, status: null },
          );
        }
        defaultBranch = repo.name;
      }
      let guarded = false;
      if (repository.readDefaultBranch === true) {
        const rules = await readBranchRules(
          deps,
          { repositoryFullName: repository.fullName, branch: repository.branch },
          token,
        );
        if (rules.kind !== "read") {
          return {
            kind: "failed",
            reason: "branch_rules_unreadable",
            errorCategory:
              rules.kind === "refused"
                ? `rules_read_${rules.reason}`
                : `rules_read_${rules.category}`,
          };
        }
        guarded = rules.guarded;
      }
      const baseSha = atSha ?? branch.sha;
      return {
        kind: "read",
        baseSha,
        tipSha: branch.sha,
        protected: branch.protected || guarded,
        defaultBranch,
        declaration: await readDeclaredSecrets(deps, token, repository.fullName, baseSha),
      };
    },
  );
  return ran.kind === "ran" ? ran.result : notMinted(ran.failure);
}
