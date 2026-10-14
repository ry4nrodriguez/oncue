/**
 * What a repository's project file asks for, fetched when the repository is
 * chosen: the Worker's read takes four GitHub round trips, about a second.
 * The Worker re-reads at create and refuses a stale "asks for nothing", so a
 * cached answer can delay the card but never skip it.
 */
import { getSecretRequests, type SecretRequests } from "@/lib/api/secrets";

/** How long an answer is kept before Home asks again, so a tab left open does not hold an old one. */
const FRESH_FOR_MS = 5 * 60 * 1000;

/** Keyed by repository, then branch (`""` for the default branch). */
const held = new Map<
  string,
  Map<string, { readonly at: number; readonly requests: Promise<SecretRequests> }>
>();

/**
 * Start reading, or return a fresh read already in hand, at the tip of
 * `branch` (null for the default branch). An answer a retry may change
 * (unreadable, reconnect GitHub, a branch that is gone) is not kept.
 */
export function prefetchSecretRequests(
  repositoryConnectionId: string,
  branch: string | null = null,
  now: number = Date.now(),
): Promise<SecretRequests> {
  const byBranch = held.get(repositoryConnectionId) ?? new Map();
  held.set(repositoryConnectionId, byBranch);
  const key = branch ?? "";
  const kept = byBranch.get(key);
  if (kept !== undefined && now - kept.at < FRESH_FOR_MS) {
    return kept.requests;
  }
  const requests = getSecretRequests(repositoryConnectionId, branch).then((answer) => {
    if (
      answer.kind === "unreadable" ||
      answer.kind === "reconnect_github" ||
      answer.kind === "branch_missing"
    ) {
      byBranch.delete(key);
    }
    return answer;
  });
  byBranch.set(key, { at: now, requests });
  return requests;
}

/** Forget what was read for a repository, every branch of it, so the next ask goes to the Worker again. */
export function forgetSecretRequests(repositoryConnectionId?: string): void {
  if (repositoryConnectionId === undefined) {
    held.clear();
  } else {
    held.delete(repositoryConnectionId);
  }
}
