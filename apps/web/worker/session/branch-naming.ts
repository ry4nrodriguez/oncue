// Pure branch-naming rules (record 07). A session has no task branch until its
// first push, which names it from the user's typed name, else the agent's,
// else a slug of the latest summary or title plus a four-hex suffix.
import { BRANCH_PREFIX, deriveBranchSlug, isBranchName } from "@oncue/protocol";

/** The task branch a git grant carries. Older dispatch rows lack `taskBranch`; their `branch` is the task branch. */
export function grantTaskBranch(need: {
  readonly branch: string;
  readonly taskBranch?: string | null;
}): string | null {
  return need.taskBranch === undefined ? need.branch : need.taskBranch;
}

/** The branch the sandbox clones: the task branch once named, the base branch before. */
export function cloneBranch(taskBranch: string | null, baseBranch: string): string {
  return taskBranch ?? baseBranch;
}

/**
 * The session's base branch. Older objects have no `session_branch` row, but
 * their task branch was named at creation, so nothing clones by this "".
 */
export function baseBranchOf(row: { readonly base_branch: string } | undefined): string {
  return row?.base_branch ?? "";
}

/** The first non-blank line of an ended run's `whatChanged`, without heading or list marks. */
export function summaryFirstLine(
  row: { readonly envelope_json: string } | undefined,
): string | null {
  if (row === undefined) {
    return null;
  }
  const { whatChanged } = (
    JSON.parse(row.envelope_json) as { payload: { summary: { whatChanged: string } } }
  ).payload.summary;
  return (
    whatChanged
      .split("\n")
      .map((candidate) => candidate.replace(/^[#*\s>-]+/, "").trim())
      .find((candidate) => candidate.length > 0) ?? null
  );
}

/**
 * The name the first push gives the branch. A valid typed or agent name is
 * used unsuffixed; the caller suffixes one another session already holds.
 */
export function chooseBranchName(
  requested: { readonly requested_name: string | null } | undefined,
  described: string | null,
  summaryLine: string | null,
  title: string | null,
  suffix: string,
): string {
  for (const name of [requested?.requested_name, described]) {
    if (name !== undefined && name !== null && isBranchName(name)) {
      return name;
    }
  }
  return `${BRANCH_PREFIX}${deriveBranchSlug(summaryLine ?? title ?? "")}-${suffix}`;
}
