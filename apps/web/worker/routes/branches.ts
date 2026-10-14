/**
 * `GET /api/repositories/:connectionId/branches?q=`: the branches the
 * composer's branch picker offers (record 07). Read from GitHub under a
 * `contents: read` token narrowed to the one repository and revoked
 * afterwards, after the installation is verified as the create route does.
 * The list is a convenience: the create route reads the chosen branch from
 * GitHub again and refuses it there, so nothing here is a security boundary.
 *
 * The default branch comes first, then the rest in GitHub's order. GitHub's
 * branch list carries no dates, and ordering by recency would cost a call per
 * branch, so a search narrows a long list instead.
 */

import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { withInstallationToken } from "../github/app";
import {
  type BranchList,
  type ListedBranch,
  listBranches,
  readRulesetGuards,
  rulesetGuards,
} from "../github/branches";
import { VERIFY_REFUSAL_STATUS, verifyInstallation } from "../github/install";
import { resolveRepository } from "../github/repositories";
import { log } from "../log";
import { readGitHubConfig } from "./repositories";

const BRANCHES_PATH = /^\/api\/repositories\/([^/]+)\/branches$/;

/** The longest search kept; a branch name is at most 255 bytes. */
export const BRANCH_QUERY_LIMIT = 255;

/** For `GET /api/repositories/:id/branches`. A malformed escape is no route. */
export function extractBranchesRepositoryId(pathname: string): string | null {
  const raw = BRANCHES_PATH.exec(pathname)?.[1];
  if (raw === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export interface BranchListing {
  readonly defaultBranch: string;
  readonly branches: readonly (ListedBranch & { readonly default: boolean })[];
  readonly truncated: boolean;
}

/**
 * The default branch first, whether or not the pages read reached it, when it
 * matches the search; the rest after it in the order read.
 */
export function orderBranches(
  defaultBranch: string,
  query: string,
  listed: readonly ListedBranch[],
): BranchListing["branches"] {
  const rest = listed
    .filter((branch) => branch.name !== defaultBranch)
    .map((branch) => ({ ...branch, default: false }));
  const listedDefault = listed.find((branch) => branch.name === defaultBranch);
  const matchesDefault =
    listedDefault !== undefined || defaultBranch.toLowerCase().includes(query.toLowerCase());
  return matchesDefault
    ? [
        { name: defaultBranch, protected: listedDefault?.protected ?? false, default: true },
        ...rest,
      ]
    : rest;
}

export async function handleListBranches(
  request: Request,
  env: Env,
  repositoryConnectionId: string,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: outcome.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  const workspaceId = actorWorkspaceId(outcome.actor);
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (query.length > BRANCH_QUERY_LIMIT) {
    return Response.json({ error: "invalid_request", reason: "query" }, { status: 400 });
  }
  const resolved = await resolveRepository(env.DB, workspaceId, { repositoryConnectionId });
  if (resolved.kind === "refused" && resolved.reason === "not_connected") {
    return Response.json(
      { error: "github_reverification_required", reason: resolved.reason },
      { status: 409 },
    );
  }
  if (resolved.kind !== "resolved") {
    // Absent and another workspace's look the same, as on every repository route.
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }
  const repository = resolved.repository;
  const verified = await verifyInstallation(config.deps, workspaceId, repository.installationRowId);
  if (verified.kind === "refused") {
    return Response.json(
      { error: "github_reverification_required", reason: verified.reason },
      { status: VERIFY_REFUSAL_STATUS[verified.reason] },
    );
  }
  const ran = await withInstallationToken(
    config.appDeps,
    {
      installationId: repository.githubInstallationId,
      repositoryIds: [repository.githubRepositoryId],
      permissions: { contents: "read" },
    },
    async (token): Promise<BranchList> => {
      const list = await listBranches(
        config.appDeps,
        { repositoryFullName: repository.fullName, query },
        token,
      );
      if (list.kind !== "listed") {
        return list;
      }
      // The branch API's `protected` answers for classic protection only; a
      // ruleset guarding pushes marks the branch too. A listing GitHub would not
      // describe the rulesets of is not offered at all.
      const rulesets = await readRulesetGuards(config.appDeps, repository.fullName, token);
      if (rulesets.kind !== "read") {
        return rulesets;
      }
      return {
        ...list,
        branches: list.branches.map((branch) => ({
          name: branch.name,
          protected:
            branch.protected ||
            rulesetGuards(rulesets.guards, branch.name, repository.defaultBranch),
        })),
      };
    },
  );
  const listed = ran.kind === "ran" ? ran.result : null;
  if (listed === null || listed.kind !== "listed") {
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "web-worker",
      release: env.ONCUE_RELEASE,
      environment: env.ONCUE_ENV,
      operation: "api.branches.list",
      result: listed === null ? "mint_failed" : `github_${listed.category}`,
    });
    return Response.json({ error: "github_unreachable" }, { status: 502 });
  }
  // The cached default branch: the install flow records it, and the create route
  // reads the live one before it refuses anything.
  const defaultBranch = repository.defaultBranch;
  const listing: BranchListing = {
    defaultBranch,
    branches: orderBranches(defaultBranch, query, listed.branches),
    truncated: listed.truncated,
  };
  return Response.json(listing, { status: 200 });
}
