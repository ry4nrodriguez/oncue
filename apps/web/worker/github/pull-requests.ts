/**
 * The draft pull request (records 07 and 14), opened and updated from the
 * control plane under a narrowed, revoked installation token; no pull-request
 * token reaches a sandbox.
 *
 * The body's verification section sits between two fixed HTML comment markers
 * and is replaced in place, keeping whatever a person wrote outside them.
 * Check names, warnings, and the agent's title and description are untrusted
 * and cleaned by `agent-text.ts`. This module never merges, marks ready,
 * closes, or deletes a branch.
 */

import { isPlainObject } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";
import { codeSpanText, defuseMarkdown, defuseTitle, plainMarkdownLine } from "./agent-text";
import {
  type GitHubAppDeps,
  githubFetch,
  githubHeaders,
  type RevokeVerdict,
  withInstallationToken,
} from "./app";

export const VERIFICATION_START = "<!-- oncue:verification:start -->";
export const VERIFICATION_END = "<!-- oncue:verification:end -->";

/** Record 07: `pull_requests: write` to open and update, `contents: read` so GitHub can compare the branches. */
export const PULL_REQUEST_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  pull_requests: "write",
  contents: "read",
};

export type CheckResultLabel = "passed" | "failed" | "skipped" | "inconclusive";

/** One check's newest attempt, from the object's `verification_check` rows. */
export interface SectionCheck {
  /** The check's name as the sandbox reported it. Untrusted text: `checkLine` cleans it. */
  readonly name: string;
  readonly classification: "required" | "recommended" | "informational";
  /** Null when the attempt was started and never reported. */
  readonly result: CheckResultLabel | null;
  readonly attempts: number;
}

export interface VerificationSectionInput {
  readonly outcome: "verified" | "completed_with_warnings";
  readonly checks: readonly SectionCheck[];
  /** The run's warnings, already worded for a person. */
  readonly warnings: readonly string[];
  readonly sessionUrl: string;
  readonly headSha: string;
}

const RESULT_WORDS: Readonly<Record<CheckResultLabel, string>> = {
  passed: "passed",
  failed: "FAILED",
  skipped: "SKIPPED",
  inconclusive: "inconclusive",
};

const MAX_CHECK_NAME_CHARS = 80;
const MAX_WARNING_CHARS = 300;

// A check's name sits inside a code span, so only what could close the span,
// spell a marker, or hide text is removed.
function cleanName(name: string): string {
  const cleaned = codeSpanText(name, MAX_CHECK_NAME_CHARS);
  return cleaned === "" ? "unnamed check" : cleaned;
}

function checkLine(check: SectionCheck): string {
  const result = check.result === null ? "did not report" : RESULT_WORDS[check.result];
  const attempts = check.attempts > 1 ? ` (${check.attempts} attempts)` : "";
  return `- \`${cleanName(check.name)}\`: ${result}${attempts}`;
}

function checkGroup(
  title: string,
  checks: readonly SectionCheck[],
  classification: SectionCheck["classification"],
): string[] {
  const group = checks.filter((check) => check.classification === classification);
  return group.length === 0 ? [] : ["", `**${title}**`, ...group.map(checkLine)];
}

/** Record 14's section: required checks, recommended checks, anything skipped or failed said plainly, and the way back to the session. */
export function verificationSection(input: VerificationSectionInput): string {
  const headline =
    input.outcome === "verified"
      ? "Every required check passed."
      : "This change is NOT fully verified. Read the warnings below.";
  const lines = [
    VERIFICATION_START,
    "## Verification",
    "",
    `${headline} Checked at \`${input.headSha.slice(0, 12)}\` by OnCue.`,
    ...checkGroup("Required checks", input.checks, "required"),
    ...checkGroup("Recommended checks", input.checks, "recommended"),
    ...checkGroup("Setup", input.checks, "informational"),
  ];
  if (input.checks.length === 0) {
    lines.push("", "No checks ran for this change.");
  }
  const warnings = input.warnings
    .map((warning) => plainMarkdownLine(warning, MAX_WARNING_CHARS))
    .filter((warning) => warning !== "");
  if (warnings.length > 0) {
    lines.push("", "**Warnings**", ...warnings.map((warning) => `- ${warning}`));
  }
  lines.push("", `[Open the OnCue session](${input.sessionUrl})`, VERIFICATION_END);
  return lines.join("\n");
}

/**
 * The text above the section: the agent's Markdown description or the
 * session's title. Untrusted, so `defuseMarkdown` removes comment markers and
 * puts mentions, references, GitHub links, and raw HTML in code.
 */
export function cleanDescription(markdown: string): string {
  return defuseMarkdown(markdown);
}

/** A title from outside the control plane: one line, no marker of ours, and no mention, reference, or GitHub link that acts. */
export function cleanTitle(title: string): string {
  return defuseTitle(title);
}

function footer(sessionUrl: string): string {
  return `Opened as a draft by OnCue from [this session](${sessionUrl}). It is never merged or marked ready by OnCue.`;
}

/** A new pull request's body: what was done, where it was done, and the section. */
export function pullRequestBody(summary: string, sessionUrl: string, section: string): string {
  return [cleanDescription(summary), "", footer(sessionUrl), "", section].join("\n");
}

/**
 * The body with a new description above the section and the section replaced.
 * If a person removed the markers, only the section is appended and their
 * text is not overwritten.
 */
export function withDescription(
  body: string,
  summary: string,
  sessionUrl: string,
  section: string,
): string {
  const start = body.indexOf(VERIFICATION_START);
  if (start === -1 || body.lastIndexOf(VERIFICATION_END) < start) {
    return withSection(body, section);
  }
  return withSection(
    `${cleanDescription(summary)}\n\n${footer(sessionUrl)}\n\n${body.slice(start)}`,
    section,
  );
}

/**
 * The body with its verification section replaced, or appended when a person
 * removed or reordered the markers. Replacement runs through the last end
 * marker, so text pasted between two end markers goes with the section.
 */
export function withSection(body: string, section: string): string {
  const start = body.indexOf(VERIFICATION_START);
  // The LAST end marker: whatever sits between the first start and it is
  // replaced whole, so an end marker planted inside cannot strand a stale tail.
  const end = body.lastIndexOf(VERIFICATION_END);
  if (start === -1 || end === -1 || end < start) {
    return body.trim() === "" ? section : `${body.trimEnd()}\n\n${section}`;
  }
  return `${body.slice(0, start)}${section}${body.slice(end + VERIFICATION_END.length)}`;
}

export interface PullRequestInput {
  readonly installationId: number;
  readonly repositoryId: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly summary: string;
  /**
   * For a pull request that already exists: a title and description the
   * agent gave since the pull request last took one, or null to leave both
   * as they are and replace only the section.
   */
  readonly rewrite: { readonly title: string; readonly summary: string } | null;
  readonly sessionUrl: string;
  readonly section: string;
  /** The pull request this session already owns, or null to open one. */
  readonly existingNumber: number | null;
  /**
   * The head is an existing branch the user chose to work on, whose open pull
   * request is a person's. Before opening anything, the open pull requests for
   * the head are listed: one is adopted keeping its title, description, and
   * base, and only the verification section is written; several open nothing,
   * since which one the person meant cannot be told; none opens a draft.
   */
  readonly adoptOpenPullRequest?: boolean;
}

export type PullRequestFailure =
  /** The branch has nothing ahead of its base: there is no change to review. */
  | { readonly kind: "no_commits" }
  /** More than one open pull request has the head: none is adopted and none opened. */
  | { readonly kind: "ambiguous" }
  /** The App lacks `pull_requests: write`, or the installation has not accepted it. */
  | { readonly kind: "permission_missing" }
  | { readonly kind: "failed"; readonly status: number | null };

export type PullRequestResult =
  | {
      readonly kind: "created" | "updated";
      readonly number: number;
      readonly url: string;
      readonly headSha: string;
      readonly draft: boolean;
      /** An update that wrote `rewrite`'s title and description. False for a creation. */
      readonly rewritten: boolean;
    }
  | PullRequestFailure;

export type PullRequestOutcome = PullRequestResult & {
  /** Null when no token was minted, so there was nothing to revoke. */
  readonly revocation: RevokeVerdict | null;
};

interface PullRequestFacts {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly draft: boolean;
  readonly body: string;
}

function factsIn(value: unknown): PullRequestFacts | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const head = value.head;
  const headSha = isPlainObject(head) ? head.sha : undefined;
  if (
    typeof value.number !== "number" ||
    typeof value.html_url !== "string" ||
    typeof headSha !== "string"
  ) {
    return null;
  }
  return {
    number: value.number,
    url: value.html_url,
    headSha,
    draft: value.draft === true,
    body: typeof value.body === "string" ? value.body : "",
  };
}

interface Answer {
  readonly status: number | null;
  readonly json: unknown;
  readonly text: string;
}

async function call(
  deps: GitHubAppDeps,
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: Readonly<Record<string, unknown>> | null,
): Promise<Answer> {
  const headers = githubHeaders(token);
  const init: RequestInit = { method, headers };
  if (body !== null) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const response = await githubFetch(deps.fetchImpl, `${deps.apiOrigin}${path}`, init);
  if (response === null) {
    return { status: null, json: null, text: "" };
  }
  const text = await response.text();
  const parsed = safeJsonParse(text);
  return { status: response.status, json: parsed.ok ? parsed.value : null, text };
}

function refusal(answer: Answer): PullRequestFailure {
  const text = answer.text.toLowerCase();
  if (answer.status === 422 && text.includes("no commits between")) {
    return { kind: "no_commits" };
  }
  if (answer.status === 403 && text.includes("not accessible by integration")) {
    return { kind: "permission_missing" };
  }
  return { kind: "failed", status: answer.status };
}

async function update(
  deps: GitHubAppDeps,
  token: string,
  input: PullRequestInput,
  number: number,
): Promise<PullRequestResult> {
  const path = `/repos/${input.fullName}/pulls/${number}`;
  const current = await call(deps, token, "GET", path, null);
  const facts = current.status === 200 ? factsIn(current.json) : null;
  if (facts === null) {
    return refusal(current);
  }
  const rewrite = input.rewrite;
  const patched = await call(
    deps,
    token,
    "PATCH",
    path,
    rewrite === null
      ? { body: withSection(facts.body, input.section) }
      : {
          title: cleanTitle(rewrite.title),
          body: withDescription(facts.body, rewrite.summary, input.sessionUrl, input.section),
        },
  );
  const after = patched.status === 200 ? factsIn(patched.json) : null;
  if (after === null) {
    return refusal(patched);
  }
  return {
    kind: "updated",
    number: after.number,
    url: after.url,
    headSha: after.headSha,
    draft: after.draft,
    rewritten: rewrite !== null,
  };
}

/** The open pull requests GitHub has for this head, filtered to one base when given; null when GitHub would not say. */
async function openFor(
  deps: GitHubAppDeps,
  token: string,
  input: PullRequestInput,
  base: string | null,
): Promise<readonly number[] | null> {
  const owner = input.fullName.split("/", 1)[0] as string;
  const query = `head=${encodeURIComponent(`${owner}:${input.headBranch}`)}&state=open${
    base === null ? "" : `&base=${encodeURIComponent(base)}`
  }&per_page=100`;
  const listed = await call(deps, token, "GET", `/repos/${input.fullName}/pulls?${query}`, null);
  if (listed.status !== 200 || !Array.isArray(listed.json)) {
    return null;
  }
  const numbers: number[] = [];
  for (const entry of listed.json) {
    const facts = factsIn(entry);
    if (facts === null) {
      return null;
    }
    numbers.push(facts.number);
  }
  return numbers;
}

async function work(
  deps: GitHubAppDeps,
  token: string,
  input: PullRequestInput,
): Promise<PullRequestResult> {
  if (input.existingNumber !== null) {
    return update(deps, token, input, input.existingNumber);
  }
  if (input.adoptOpenPullRequest === true) {
    // Listed first: GitHub refuses only a second pull request with the same head
    // and base, so a person's into another base would not stop a POST.
    const open = await openFor(deps, token, input, null);
    if (open === null) {
      return { kind: "failed", status: null };
    }
    if (open.length > 1) {
      return { kind: "ambiguous" };
    }
    if (open.length === 1) {
      return update(deps, token, { ...input, rewrite: null }, open[0] as number);
    }
  }
  const created = await call(deps, token, "POST", `/repos/${input.fullName}/pulls`, {
    title: cleanTitle(input.title),
    head: input.headBranch,
    base: input.baseBranch,
    body: pullRequestBody(input.summary, input.sessionUrl, input.section),
    draft: true,
  });
  const facts = created.status === 201 ? factsIn(created.json) : null;
  if (facts !== null) {
    return {
      kind: "created",
      number: facts.number,
      url: facts.url,
      headSha: facts.headSha,
      draft: facts.draft,
      rewritten: false,
    };
  }
  if (created.status === 422 && created.text.toLowerCase().includes("already exists")) {
    // The session's own branch already has one into this base: adopt it.
    const number = (await openFor(deps, token, input, input.baseBranch))?.[0];
    if (number !== undefined) {
      return update(deps, token, input, number);
    }
  }
  return refusal(created);
}

export async function openOrUpdateDraft(
  deps: GitHubAppDeps,
  input: PullRequestInput,
): Promise<PullRequestOutcome> {
  const ran = await withInstallationToken(
    deps,
    {
      installationId: input.installationId,
      repositoryIds: [input.repositoryId],
      permissions: PULL_REQUEST_PERMISSIONS,
    },
    (token) => work(deps, token, input),
  );
  if (ran.kind === "ran") {
    return { ...ran.result, revocation: ran.revocation };
  }
  // GitHub answers 422 when the token asks for a permission the App does not
  // hold, as with a fresh App whose installation has not accepted pull requests.
  const failure = ran.failure;
  if (failure.kind === "failed" && failure.status === 422) {
    return { kind: "permission_missing", revocation: null };
  }
  return {
    kind: "failed",
    status: failure.kind === "failed" ? failure.status : null,
    revocation: null,
  };
}
