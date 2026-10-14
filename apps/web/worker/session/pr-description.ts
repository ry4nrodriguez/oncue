// The agent's title, body, and branch name for its pull request (record 07).
// A description is text, not authority: it only names what the policy already
// allows. It is still bounded per run, because every admitted frame is a stored row.
import type { PayloadOf } from "@oncue/protocol";

export const MAX_DESCRIPTIONS_PER_RUN = 10;
/** Looser than the bridge's own limit of 30 (record 07), so an honest bridge never meets it. */
export const MAX_COMMITS_PER_RUN = 50;

export type DescriptionRefusal = "description_run_not_running" | "too_many_descriptions";
export type CommitRefusal = "commit_run_not_running" | "too_many_commits";

/** OpenCode runs tools in parallel, so a call can land while another waits on an approval. */
export const LIVE_RUN_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting_for_approval",
  "paused",
]);

export function decideDescription(context: {
  /** The frame names the session's current run, and that run is live (`LIVE_RUN_STATES`). */
  readonly runRunning: boolean;
  readonly admittedThisRun: number;
}): { readonly kind: "admit" } | { readonly kind: "refuse"; readonly reason: DescriptionRefusal } {
  if (!context.runRunning) {
    return { kind: "refuse", reason: "description_run_not_running" };
  }
  if (context.admittedThisRun >= MAX_DESCRIPTIONS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_descriptions" };
  }
  return { kind: "admit" };
}

/** The same judgement for the agent's `git.committed` events, against their own bound. */
export function decideCommit(context: {
  readonly runRunning: boolean;
  readonly admittedThisRun: number;
}): { readonly kind: "admit" } | { readonly kind: "refuse"; readonly reason: CommitRefusal } {
  if (!context.runRunning) {
    return { kind: "refuse", reason: "commit_run_not_running" };
  }
  if (context.admittedThisRun >= MAX_COMMITS_PER_RUN) {
    return { kind: "refuse", reason: "too_many_commits" };
  }
  return { kind: "admit" };
}

/** The object's one row: the latest value of each field, and which version GitHub last got. */
export interface StoredDescription {
  readonly title: string | null;
  readonly body: string | null;
  readonly branchName: string | null;
  /** One more for each admitted description. */
  readonly version: number;
  /** The version whose title and body the pull request last took; 0 before any. */
  readonly appliedVersion: number;
}

/** A field the new description leaves null keeps the stored value. */
export function mergeDescription(
  stored: StoredDescription | null,
  payload: PayloadOf<"pull_request.described">,
): StoredDescription {
  return {
    title: payload.title ?? stored?.title ?? null,
    body: payload.body ?? stored?.body ?? null,
    branchName: payload.branchName ?? stored?.branchName ?? null,
    version: (stored?.version ?? 0) + 1,
    appliedVersion: stored?.appliedVersion ?? 0,
  };
}

export interface PullRequestText {
  readonly title: string;
  /** What goes above OnCue's footer and verification section. */
  readonly summary: string;
  /** Non-null when the pull request has not yet taken the agent's latest description. */
  readonly rewrite: { readonly title: string; readonly summary: string } | null;
}

/** The agent's words, else the session's title, else the branch. */
export function pullRequestText(
  description: StoredDescription | null,
  sessionTitle: string | null,
  branch: string,
): PullRequestText {
  const fallback = sessionTitle ?? `OnCue: ${branch}`;
  const title = description?.title ?? fallback;
  const summary = description?.body ?? title;
  const unapplied =
    description !== null &&
    description.version > description.appliedVersion &&
    (description.title !== null || description.body !== null);
  return { title, summary, rewrite: unapplied ? { title, summary } : null };
}
