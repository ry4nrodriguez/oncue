import { branchName } from "../branch-name";
import { defineFamily } from "../define";
import {
  approvalId,
  boolean,
  boundedList,
  check,
  counter,
  fileChange,
  maxLength,
  nullable,
  picklist,
  pipe,
  pushId,
  sha,
  shortText,
  strictObject,
  string,
  summaryText,
  timestamp,
  untrustedText,
} from "../schema";

// A reference into the session's policy history, not a copy, so a later
// policy change does not rewrite what an old event claims.
export const policyDecisionRef = strictObject({
  policyVersion: counter,
  rule: picklist([
    "auto_commit",
    "auto_push",
    "auto_pull_request",
    "user_instruction",
    "explicit_approval",
  ]),
  approvalId: nullable(approvalId),
});

/** GitHub's own title limit is 256; one line, not blank. */
export const PULL_REQUEST_TITLE_MAX_CHARS = 200;
/** Well under GitHub's 65,536, leaving room for OnCue's footer and verification section. */
export const PULL_REQUEST_BODY_MAX_CHARS = 16 * 1024;

export const pullRequestTitle = pipe(
  string(),
  maxLength(PULL_REQUEST_TITLE_MAX_CHARS),
  check(
    (value) => value.trim() !== "" && !/[\r\n]/.test(value),
    "a pull request title is one line that is not blank",
  ),
);
export const pullRequestBody = pipe(
  string(),
  maxLength(PULL_REQUEST_BODY_MAX_CHARS),
  check((value) => value.trim() !== "", "a pull request body is not blank"),
);

export const pullRequestState = picklist(["draft", "open", "closed", "merged"]);

export const GIT_EVENTS = defineFamily("git", {
  "git.committed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      commitSha: sha,
      parentSha: nullable(sha),
      branch: shortText,
      message: summaryText,
      authorType: picklist(["agent", "user", "system"]),
      authorName: shortText,
      committedAt: timestamp,
      files: boundedList(fileChange),
      additions: counter,
      deletions: counter,
      // Record 07: "verification state at the time of commit".
      verificationState: picklist(["none", "partial", "passing", "failing"]),
      policy: policyDecisionRef,
    }),
  },
  "git.push.requested": {
    scope: "run",
    origin: "control",
    durability: "durable",
    // `headSha` is null when the object asks before the commit exists: the
    // bridge builds the commit (record 07), and the object learns its sha
    // from `git.committed` and `git.push.completed`.
    payload: strictObject({
      pushId,
      branch: shortText,
      headSha: nullable(sha),
      commitCount: counter,
      policy: policyDecisionRef,
    }),
  },
  "git.push.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      pushId,
      branch: shortText,
      headSha: sha,
      remoteSha: sha,
    }),
  },
  // Record 07 requires the workflow-file case to be reported specifically and
  // treats a push to any other ref as a session-terminating incident.
  "git.push.failed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      pushId,
      branch: shortText,
      headSha: sha,
      category: picklist([
        "workflow_file_rejected",
        "wrong_ref",
        "protected_branch",
        "non_fast_forward",
        "authentication",
        "repository_access_removed",
        "network",
        // Nothing was published, push or bundle, because the changes hold a
        // supplied development secret or could not be checked for one.
        "secret_in_changes",
        "unknown",
      ]),
      message: summaryText,
      retryable: boolean(),
    }),
  },
  // The object kept a push the person asked for from reaching GitHub: the
  // existing branch the session works on is no longer one it may push to
  // (record 07), or GitHub could not confirm that it is. Nothing was pushed;
  // the checkpoint keeps the work as a recovery patch.
  "git.push.withheld": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      pushId,
      branch: shortText,
      reason: picklist(["missing", "protected", "default", "unconfirmed"]),
      message: summaryText,
    }),
  },
  // The agent's proposed pull request title, body, and branch name, from its
  // `pull_request_describe` tool (record 07). Text only, never authority: it
  // opens and pushes nothing. The object keeps the latest value of each
  // field; the control plane cleans title and body before GitHub renders them.
  "pull_request.described": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      title: nullable(pullRequestTitle),
      body: nullable(pullRequestBody),
      branchName: nullable(branchName),
    }),
  },
  "pull_request.created": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      number: counter,
      url: shortText,
      title: shortText,
      draft: boolean(),
      baseBranch: shortText,
      headBranch: shortText,
      headSha: sha,
      verificationSectionVersion: counter,
    }),
  },
  "pull_request.updated": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      number: counter,
      headSha: sha,
      verificationSectionVersion: counter,
      changed: boundedList(picklist(["title", "body", "verification_section", "head"])),
    }),
  },
  // Session-scoped: a reviewer can merge or close while no run exists.
  "pull_request.state_changed": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      number: counter,
      from: pullRequestState,
      to: pullRequestState,
      actor: untrustedText,
      mergedSha: nullable(sha),
      changedAt: timestamp,
    }),
  },
});
