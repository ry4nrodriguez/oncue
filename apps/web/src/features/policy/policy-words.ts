/**
 * The session's Git policy in a person's words. The confirmation card names
 * "the exact change" (records 07 and 09), so every field that moves is one
 * line saying what it was and what it becomes, and nothing is summarised.
 */

import type { SessionView } from "@oncue/protocol";

export type SessionPolicy = NonNullable<SessionView["policy"]["current"]>;

/** What a session does before anyone has changed anything: `git-policy.ts`'s default, as the view has no policy event to read it from yet. */
export const DEFAULT_POLICY: SessionPolicy = {
  version: 1,
  commit: "auto",
  push: "manual",
  pullRequest: "manual",
  planApproval: "proceed",
  fileEdits: "allowed",
};

const FIELD_LABELS = {
  commit: "Commit",
  push: "Push",
  pullRequest: "Draft pull request",
} as const;

type GitField = keyof typeof FIELD_LABELS;
const GIT_FIELDS: readonly GitField[] = ["commit", "push", "pullRequest"];

const VALUE_WORDS: Readonly<Record<GitField, Readonly<Record<string, string>>>> = {
  commit: { auto: "on", manual: "only when asked" },
  push: { auto: "after each run", manual: "off", never: "never, checkpoints included" },
  pullRequest: { auto_after_verification: "after each push", manual: "off", never: "never" },
};

export interface PolicyChangeLine {
  readonly field: GitField;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** One line per Git field that differs, in a fixed order. */
export function changeLines(from: SessionPolicy, to: SessionPolicy): readonly PolicyChangeLine[] {
  return GIT_FIELDS.filter((field) => from[field] !== to[field]).map((field) => ({
    field,
    label: FIELD_LABELS[field],
    from: VALUE_WORDS[field][from[field]] as string,
    to: VALUE_WORDS[field][to[field]] as string,
  }));
}

/** How a widening reads as something the session is allowed to do, per field. */
const ALLOW_PHRASE: Readonly<Record<GitField, (to: string) => string>> = {
  commit: (to) => `commits ${to}`,
  push: (to) => `pushes ${to}`,
  pullRequest: (to) => `a draft PR ${to}`,
};

/**
 * The banner's one line, e.g. "Allow pushes after each run and a draft PR
 * after each push on acme/widgets?", naming every field that moves so it is
 * still the exact change (record 09).
 */
export function allowSentence(
  from: SessionPolicy,
  to: SessionPolicy,
  repository: string | null,
): string {
  const parts = changeLines(from, to).map((line) => ALLOW_PHRASE[line.field](line.to));
  const what =
    parts.length <= 1
      ? (parts[0] ?? "change what it may do")
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Allow ${what}${repository === null ? "" : ` on ${repository}`}?`;
}

/** The rail's one line: what the session does with its work right now. */
export function behaviorSummary(policy: SessionPolicy): string {
  const commit = policy.commit === "auto" ? "Commits" : "Commits when asked";
  if (policy.push === "never") {
    return `${commit} · Never pushes`;
  }
  if (policy.push === "manual") {
    return `${commit} · Does not push`;
  }
  return policy.pullRequest === "auto_after_verification"
    ? `${commit} · Pushes · Draft pull request`
    : `${commit} · Pushes`;
}

const CONFIRMED_BY: Readonly<Record<string, string>> = {
  user_confirmation: "You confirmed a Git behavior change",
  immediate_narrowing: "Git behavior was restricted, as you asked",
  product_control: "You changed the Git behavior",
  system: "OnCue turned pushing off after a push outside this session's branch",
};

export function updateTitle(confirmedBy: string): string {
  return CONFIRMED_BY[confirmedBy] as string;
}
