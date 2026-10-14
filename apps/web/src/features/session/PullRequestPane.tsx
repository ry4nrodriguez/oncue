/**
 * The side panel's Pull request tab. Until the first push names the branch
 * (record 07), the name is edited here, starting from `oncue/<slug>-<hex>`;
 * after that it is fixed. The pull request itself is only linked.
 */
import type { SessionView } from "@oncue/protocol";
import { GitBranch, GitPullRequest } from "lucide-react";
import { BranchNameField } from "@/features/policy/BranchNameField";
import { safeGitHubUrl } from "./ContextRail";

export interface BranchEditing {
  /** The branch once a push has named it, else null. */
  readonly named: string | null;
  /** The part after `oncue/` a first push would use: the typed edit, or the suggestion. */
  readonly slug: string;
  readonly onSlugChange: (slug: string) => void;
  /** The branch the session started from; null for the default branch or an older session. */
  readonly baseBranch?: string | null;
  /** The session works directly on an existing branch, so `named` is that branch from the start. */
  readonly existing?: boolean;
  /** `owner/name`, for the link to a pull request the session adopted rather than opened. */
  readonly repository?: string;
}

/**
 * GitHub's link to a pull request. One the session adopted arrives without a
 * URL, so it is built from the repository and number; `safeGitHubUrl` still
 * judges the result.
 */
export function pullRequestUrl(
  url: string | null,
  repository: string | undefined,
  number: number,
): string | null {
  if (url !== null) {
    return safeGitHubUrl(url);
  }
  return repository === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repository)
    ? null
    : safeGitHubUrl(`https://github.com/${repository}/pull/${number}`);
}

export function PullRequestPane({ view, branch }: { view: SessionView; branch: BranchEditing }) {
  const pullRequest = view.git.pullRequest;
  const url =
    pullRequest === null
      ? null
      : pullRequestUrl(pullRequest.url, branch.repository, pullRequest.number);
  return (
    <div className="space-y-6 px-4 pt-4 pb-4" data-testid="panel-pull-request">
      <section>
        <h3 className="flex items-center gap-2 font-medium text-[13px] text-text">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
          Branch
        </h3>
        {branch.named === null ? (
          <div className="mt-2 space-y-1.5">
            <BranchNameField value={branch.slug} onChange={branch.onSlugChange} />
            <p className="text-[12px] text-muted-foreground">
              Named when the session first pushes. Change it here before then.
            </p>
          </div>
        ) : (
          <p className="mt-2 font-mono text-[12px] text-text" data-testid="panel-branch-name">
            {branch.named}
          </p>
        )}
        <p className="mt-1.5 text-[12px] text-muted-foreground" data-testid="panel-branch-base">
          {branch.existing === true
            ? "An existing branch: the session pushes to it directly, and adopts its open pull request."
            : `Started from ${branch.baseBranch ?? "the default branch"}.`}
        </p>
      </section>

      <section>
        <h3 className="flex items-center gap-2 font-medium text-[13px] text-text">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
          Pull request
        </h3>
        {pullRequest === null ? (
          <p className="mt-2 text-[12px] text-muted-foreground">
            None yet. Allow the session to push and it opens a draft.
          </p>
        ) : url === null ? (
          <p className="mt-2 text-[13px] text-text">
            #{pullRequest.number} · {pullRequest.state}
          </p>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="pull-request-link"
            className="mt-2 inline-block text-[13px] text-text underline-offset-2 hover:underline"
          >
            #{pullRequest.number} · {pullRequest.state}
            {pullRequest.title === null ? "" : ` · ${pullRequest.title}`}
          </a>
        )}
        {pullRequest?.baseBranch == null ? null : (
          <p className="mt-1 text-[12px] text-muted-foreground" data-testid="pull-request-base">
            Into {pullRequest.baseBranch}
          </p>
        )}
      </section>
    </div>
  );
}
