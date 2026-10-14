// A session working directly on an existing branch (record 07): before each
// push grant is minted, first sent or redelivered, GitHub is asked again
// whether the branch may still be pushed to.

import { type GitHubAppDeps, withInstallationToken } from "../../github/app";
import { readBranch, readBranchRules, readDefaultBranch } from "../../github/branches";
import { log } from "../../log";
import type { SessionHost } from "./host";
import type { SessionRow } from "./types";

/** The row a session working on an existing branch has, or null for every other session. */
export function readExistingBranch(
  sql: SqlStorage,
): { readonly pullRequestAdopted: boolean } | null {
  const row = sql
    .exec<{ pull_request_adopted: number }>(
      "SELECT pull_request_adopted FROM session_existing_branch WHERE id = 1",
    )
    .toArray()[0];
  return row === undefined ? null : { pullRequestAdopted: row.pull_request_adopted === 1 };
}

/** The session adopted a pull request a person opened: its words stay theirs. */
export function markPullRequestAdopted(sql: SqlStorage): void {
  sql.exec("UPDATE session_existing_branch SET pull_request_adopted = 1 WHERE id = 1");
}

/**
 * Why a push grant was withheld: the branch was deleted, a protection rule
 * now covers it, it became the default branch, or GitHub could not say.
 */
export type ExistingBranchVerdict =
  | "pushable"
  | "missing"
  | "protected"
  | "default"
  | "unconfirmed";

/**
 * How long the whole confirmation may take, mint to last read. It runs in a
 * stop's checkpoint step, whose lease is 30 seconds, and ahead of a publish's
 * grant, whose report must land within two minutes, so a slow GitHub reads as
 * "unconfirmed" and the work becomes a patch bundle rather than holding either.
 */
export const CONFIRM_BUDGET_MS = 10_000;

/**
 * Asks GitHub, under a `contents: read` token narrowed to the repository and
 * revoked afterwards, whether the session's branch is still one it may push
 * to: it exists, neither classic protection nor a ruleset rule guards it, and
 * it is not the default branch. Anything short of a clear yes within
 * `CONFIRM_BUDGET_MS` withholds the grant, and the checkpoint keeps the work
 * as a patch bundle instead. GitHub's protection would refuse some of these
 * pushes on its own, but a rule can exempt the App, and the default branch may
 * have none, so the object does not rely on it.
 */
export async function confirmExistingBranch(
  host: SessionHost,
  session: SessionRow,
  deps: GitHubAppDeps,
  target: {
    readonly installationId: number;
    readonly repositoryId: number;
    readonly fullName: string;
    readonly branch: string;
  },
): Promise<ExistingBranchVerdict> {
  // The reads are cut off at the deadline; the mint and the revocation are
  // not, so a token minted late is still revoked, and the race below answers
  // on time either way.
  const signal = AbortSignal.timeout(CONFIRM_BUDGET_MS);
  const confirmed = withInstallationToken(
    deps,
    {
      installationId: target.installationId,
      repositoryIds: [target.repositoryId],
      permissions: { contents: "read" },
    },
    async (token): Promise<ExistingBranchVerdict> => {
      const input = { repositoryFullName: target.fullName, branch: target.branch };
      const read = await readBranch(deps, input, token, signal);
      if (read.kind !== "found") {
        return read.kind === "refused" ? "missing" : "unconfirmed";
      }
      if (read.protected) {
        return "protected";
      }
      const rules = await readBranchRules(deps, input, token, signal);
      if (rules.kind !== "read") {
        return "unconfirmed";
      }
      if (rules.guarded) {
        return "protected";
      }
      const repo = await readDefaultBranch(deps, target.fullName, token, signal);
      if (repo.kind !== "found") {
        return "unconfirmed";
      }
      return repo.name === target.branch ? "default" : "pushable";
    },
  ).then((ran) => (ran.kind === "ran" ? ran.result : ("unconfirmed" as const)));
  const deadline = new Promise<"unconfirmed">((resolve) => {
    signal.addEventListener("abort", () => resolve("unconfirmed"), { once: true });
  });
  const verdict = await Promise.race([confirmed, deadline]);
  if (verdict !== "pushable") {
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.existing_branch_push",
      result: `withheld_${verdict}`,
      sessionId: session.id,
    });
  }
  return verdict;
}

/** What the timeline says when a publish was withheld, by reason. */
export const WITHHELD_MESSAGE: Readonly<
  Record<Exclude<ExistingBranchVerdict, "pushable">, string>
> = {
  missing:
    "OnCue did not push: the branch is no longer on GitHub. Your work is saved as a recovery patch.",
  protected:
    "OnCue did not push: a branch protection rule or ruleset now guards this branch. Your work is saved as a recovery patch.",
  default:
    "OnCue did not push: this branch is now the repository's default branch. Your work is saved as a recovery patch.",
  unconfirmed:
    "OnCue did not push: GitHub could not confirm the branch may still be pushed to. Your work is saved as a recovery patch; the next push asks again.",
};
