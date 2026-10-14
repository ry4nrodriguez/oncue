import {
  BRANCH_PREFIX,
  deriveBranchSlug,
  type PullRequestDescription,
  type SessionView,
} from "@oncue/protocol";
import { messageMarkdown } from "./timeline-turns";

/**
 * The branch name a first push would use (record 07): the agent's own from
 * `pull_request_describe`, else a slug of its latest words plus four hex
 * characters so two sessions' branches differ.
 */
export function suggestBranch(
  description: PullRequestDescription | null,
  messages: SessionView["messages"],
  hexSuffix: string,
): string {
  const described = description?.branchName ?? null;
  if (described !== null) {
    return described;
  }
  let latest = "";
  for (const message of messages.values()) {
    // A subagent's words are its report to the agent, not the agent's own.
    if (message.role === "assistant" && !message.streaming && message.agentId === undefined) {
      const text = messageMarkdown(message);
      if (text.length > 0) {
        latest = text;
      }
    }
  }
  const line =
    latest
      .split("\n")
      .map((candidate) => candidate.replace(/^[#*\s>-]+/, "").trim())
      .find((candidate) => candidate.length > 0) ?? "";
  return `${BRANCH_PREFIX}${deriveBranchSlug(line)}-${hexSuffix}`;
}
