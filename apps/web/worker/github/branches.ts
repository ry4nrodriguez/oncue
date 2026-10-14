/**
 * A repository's branches as GitHub reports them (record 07): the branch a
 * session starts from, the branch a session may work on directly, and the list
 * the composer picks from. Every read runs under a token the caller minted
 * and revokes, narrowed to the one repository with `contents: read`.
 *
 * A session records the exact commit it starts from rather than a branch name
 * that may move; a caller that expects a commit passes it, and a mismatch
 * creates nothing. No branch is created here: a new task branch is created by
 * the first push, under the push grant's token.
 */

import { isPlainObject, readStringField } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";
import { type GitHubAppDeps, githubFetch, githubHeaders, type UpstreamFailure } from "./app";

/** The longest branch name OnCue works with: git's own limit is the filesystem's, 255 bytes. */
export const BRANCH_NAME_LIMIT = 255;

/**
 * Whether OnCue can clone and push this branch. The bridge refuses a push to
 * any ref outside `refs/heads/[A-Za-z0-9._/-]+` (`REF_PATTERN` in
 * `services/bridge/src/git.ts`), so a branch with another character is not
 * offered rather than accepted and left unable to push. The rest are git's own
 * ref-format rules, and a leading `-` would read as an option.
 */
export function isWorkableBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= BRANCH_NAME_LIMIT &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("//") &&
    name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

type ReadDeps = Pick<GitHubAppDeps, "fetchImpl" | "apiOrigin">;

function upstreamFailure(status: number | null): UpstreamFailure {
  return status === null
    ? { kind: "failed", category: "unreachable", status: null }
    : { kind: "failed", category: "rejected", status };
}

function malformed(status: number): UpstreamFailure {
  return { kind: "failed", category: "malformed_response", status };
}

async function readJson(
  deps: ReadDeps,
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown; readonly link: string | null }
  | { readonly kind: "not_found" }
  | UpstreamFailure
> {
  const upstream = await githubFetch(deps.fetchImpl, `${deps.apiOrigin}${path}`, {
    method: "GET",
    headers: githubHeaders(token),
    ...(signal === undefined ? {} : { signal }),
  });
  if (upstream === null) {
    return upstreamFailure(null);
  }
  if (upstream.status === 404) {
    return { kind: "not_found" };
  }
  if (upstream.status !== 200) {
    return upstreamFailure(upstream.status);
  }
  const parsed = safeJsonParse(await upstream.text());
  if (!parsed.ok) {
    return malformed(upstream.status);
  }
  return { kind: "ok", value: parsed.value, link: upstream.headers.get("link") };
}

/**
 * GitHub's answer when rulesets are not part of the repository's plan (a
 * private repository on a free account): 403 with this sentence. No ruleset
 * can exist there, so none applies; any other 403 is a refusal and fails
 * closed. Both rules endpoints answer it; record 07 has the observation.
 */
const RULESETS_NOT_IN_PLAN = /^upgrade to github .* to enable this feature\.?$/i;

/** The `message` field of GitHub's JSON error body, or "" for anything else. */
function messageOf(text: string): string {
  const parsed = safeJsonParse(text);
  return parsed.ok && isPlainObject(parsed.value)
    ? (readStringField(parsed.value, "message") ?? "")
    : "";
}

/** `readJson` for the ruleset endpoints, which also answer that the plan has no rulesets. */
async function readRulesJson(
  deps: ReadDeps,
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof readJson>> | { readonly kind: "not_in_plan" }> {
  const upstream = await githubFetch(deps.fetchImpl, `${deps.apiOrigin}${path}`, {
    method: "GET",
    headers: githubHeaders(token),
    ...(signal === undefined ? {} : { signal }),
  });
  if (upstream === null) {
    return upstreamFailure(null);
  }
  if (upstream.status === 404) {
    return { kind: "not_found" };
  }
  const text = await upstream.text();
  if (upstream.status === 403 && RULESETS_NOT_IN_PLAN.test(messageOf(text))) {
    return { kind: "not_in_plan" };
  }
  if (upstream.status !== 200) {
    return upstreamFailure(upstream.status);
  }
  const parsed = safeJsonParse(text);
  return parsed.ok
    ? { kind: "ok", value: parsed.value, link: upstream.headers.get("link") }
    : malformed(upstream.status);
}

/** One branch as `GET /repos/{owner}/{repo}/branches[/{branch}]` describes it. */
function branchIn(value: unknown): { name: string; sha: string; protected: boolean } | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const name = readStringField(value, "name");
  const commit = value.commit;
  const sha = isPlainObject(commit) ? readStringField(commit, "sha") : null;
  if (name === null || sha === null || typeof value.protected !== "boolean") {
    return null;
  }
  return { name, sha, protected: value.protected };
}

export type BranchRead =
  | {
      readonly kind: "found";
      readonly sha: string;
      /** GitHub's word: a branch protection rule or ruleset applies to it. */
      readonly protected: boolean;
    }
  | { readonly kind: "refused"; readonly reason: "branch_missing" }
  | UpstreamFailure;

/**
 * `GET /repos/{owner}/{repo}/branches/{branch}`: the tip and whether the
 * branch is protected. GitHub answers a renamed branch's old name with the
 * new branch, so an answer naming another branch reads as missing. The name
 * is sent as it is, because GitHub reads a slash in it (`release/1.4`) as a
 * path separator; `isWorkableBranchName` has already ruled out anything that
 * would need escaping.
 */
export async function readBranch(
  deps: ReadDeps,
  input: { readonly repositoryFullName: string; readonly branch: string },
  token: string,
  signal?: AbortSignal,
): Promise<BranchRead> {
  const read = await readJson(
    deps,
    `/repos/${input.repositoryFullName}/branches/${branchPath(input.branch)}`,
    token,
    signal,
  );
  if (read.kind === "not_found") {
    return { kind: "refused", reason: "branch_missing" };
  }
  if (read.kind === "failed") {
    return read;
  }
  const branch = branchIn(read.value);
  if (branch === null) {
    return malformed(200);
  }
  if (branch.name !== input.branch) {
    return { kind: "refused", reason: "branch_missing" };
  }
  return { kind: "found", sha: branch.sha, protected: branch.protected };
}

export type DefaultBranchRead =
  | { readonly kind: "found"; readonly name: string }
  | { readonly kind: "refused"; readonly reason: "repository_missing" }
  | UpstreamFailure;

/**
 * `GET /repos/{owner}/{repo}`: the default branch as GitHub holds it now. The
 * install flow caches it, but an owner can change it at any time, and a
 * session working directly on a branch must never be working on the default.
 */
export async function readDefaultBranch(
  deps: ReadDeps,
  repositoryFullName: string,
  token: string,
  signal?: AbortSignal,
): Promise<DefaultBranchRead> {
  const read = await readJson(deps, `/repos/${repositoryFullName}`, token, signal);
  if (read.kind === "not_found") {
    return { kind: "refused", reason: "repository_missing" };
  }
  if (read.kind === "failed") {
    return read;
  }
  const name = isPlainObject(read.value) ? readStringField(read.value, "default_branch") : null;
  return name === null ? malformed(200) : { kind: "found", name };
}

/**
 * A branch name as a URL path: each `/`-separated part escaped, the slashes
 * kept, because GitHub reads them as path separators. A `#`, `?`, `%`, or space
 * would otherwise end or change the path and ask about another branch.
 */
export function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * Ruleset rule types that cannot refuse or gate a push of commits to a branch
 * that already exists: they govern creating a branch or tag, or a name. Every
 * other type, known or not (`update`, `non_fast_forward`, `deletion`,
 * `pull_request`, `required_status_checks`, `required_signatures`,
 * `merge_queue`, commit-message and file rules, and any GitHub adds later),
 * counts as guarding the branch, so a session never works on it directly.
 */
export const PUSH_NEUTRAL_RULES: ReadonlySet<string> = new Set([
  "creation",
  "branch_name_pattern",
  "tag_name_pattern",
]);

/** Whether a rule type guards pushes: anything not known to be neutral. */
export function guardsPushes(type: string): boolean {
  return !PUSH_NEUTRAL_RULES.has(type);
}

/** Rules read per branch. A full page might hide more, so it fails closed. */
export const RULES_PAGE_SIZE = 100;

export type BranchRulesRead =
  | { readonly kind: "read"; readonly guarded: boolean }
  | { readonly kind: "refused"; readonly reason: "repository_missing" }
  | UpstreamFailure;

/**
 * `GET /repos/{owner}/{repo}/rules/branches/{branch}`: every active ruleset
 * rule that applies to the branch, from the repository and its organization.
 * The `protected` flag on the branch API answers for classic protection, and a
 * ruleset whose bypass list names the App would otherwise go unseen. Read with
 * the installation's metadata access, which every token carries. A
 * repository whose plan has no rulesets has none to apply.
 */
export async function readBranchRules(
  deps: ReadDeps,
  input: { readonly repositoryFullName: string; readonly branch: string },
  token: string,
  signal?: AbortSignal,
): Promise<BranchRulesRead> {
  const read = await readRulesJson(
    deps,
    `/repos/${input.repositoryFullName}/rules/branches/${branchPath(input.branch)}?per_page=${RULES_PAGE_SIZE}`,
    token,
    signal,
  );
  if (read.kind === "not_in_plan") {
    return { kind: "read", guarded: false };
  }
  if (read.kind === "not_found") {
    return { kind: "refused", reason: "repository_missing" };
  }
  if (read.kind === "failed") {
    return read;
  }
  if (!Array.isArray(read.value)) {
    return malformed(200);
  }
  const types = read.value.map((rule) =>
    isPlainObject(rule) ? readStringField(rule, "type") : null,
  );
  if (types.some((type) => type === null)) {
    return malformed(200);
  }
  if (types.some((type) => guardsPushes(type as string))) {
    return { kind: "read", guarded: true };
  }
  // Every rule on this page is neutral, but a full page may not be all of them.
  return types.length >= RULES_PAGE_SIZE
    ? { kind: "failed", category: "malformed_response", status: 200 }
    : { kind: "read", guarded: false };
}

/** The ref names a ruleset applies to, as its `conditions.ref_name` gives them. */
export interface RulesetGuard {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Rulesets read per listing; a repository with more is read as guarding every branch. */
export const RULESET_LIMIT = 10;

export type RulesetGuards =
  | { readonly kind: "read"; readonly guards: readonly RulesetGuard[] }
  | UpstreamFailure;

function stringsIn(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/**
 * The active branch rulesets that hold a push-guarding rule, for marking a
 * listing without one call per branch: `GET /repos/{owner}/{repo}/rulesets`,
 * then each active branch ruleset by id. A ruleset with no ref condition, or
 * more rulesets than `RULESET_LIMIT`, reads as guarding everything. The
 * create route and the push grant ask GitHub per branch instead.
 */
export async function readRulesetGuards(
  deps: ReadDeps,
  repositoryFullName: string,
  token: string,
): Promise<RulesetGuards> {
  const listed = await readRulesJson(
    deps,
    `/repos/${repositoryFullName}/rulesets?includes_parents=true&per_page=${RULES_PAGE_SIZE}`,
    token,
  );
  if (listed.kind === "not_in_plan") {
    return { kind: "read", guards: [] };
  }
  if (listed.kind === "not_found") {
    return upstreamFailure(404);
  }
  if (listed.kind === "failed") {
    return listed;
  }
  if (!Array.isArray(listed.value)) {
    return malformed(200);
  }
  const ids: number[] = [];
  for (const entry of listed.value) {
    if (!isPlainObject(entry) || typeof entry.id !== "number") {
      return malformed(200);
    }
    if (entry.target === "branch" && entry.enforcement === "active") {
      ids.push(entry.id);
    }
  }
  // More than the limit, or a full page that may hide more, reads as guarding all.
  if (ids.length > RULESET_LIMIT || listed.value.length >= RULES_PAGE_SIZE) {
    return { kind: "read", guards: [{ include: ["~ALL"], exclude: [] }] };
  }
  const guards: RulesetGuard[] = [];
  for (const id of ids) {
    const read = await readJson(
      deps,
      `/repos/${repositoryFullName}/rulesets/${id}?includes_parents=true`,
      token,
    );
    if (read.kind === "not_found") {
      return upstreamFailure(404);
    }
    if (read.kind === "failed") {
      return read;
    }
    if (!isPlainObject(read.value) || !Array.isArray(read.value.rules)) {
      return malformed(200);
    }
    const guarding = read.value.rules.some(
      (rule) => !isPlainObject(rule) || guardsPushes(String(rule.type)),
    );
    if (!guarding) {
      continue;
    }
    const conditions = isPlainObject(read.value.conditions) ? read.value.conditions : null;
    const refName =
      conditions !== null && isPlainObject(conditions.ref_name) ? conditions.ref_name : null;
    const include = refName === null ? ["~ALL"] : stringsIn(refName.include);
    const exclude = refName === null ? [] : (stringsIn(refName.exclude) ?? []);
    guards.push({ include: include ?? ["~ALL"], exclude });
  }
  return { kind: "read", guards };
}

/**
 * A ruleset ref pattern as a regular expression: fnmatch with `*` and `?`
 * inside one path component and `**` across them, as GitHub documents for
 * rulesets.
 */
function refPattern(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function refMatches(pattern: string, ref: string, defaultRef: string): boolean {
  if (pattern === "~ALL") {
    return true;
  }
  if (pattern === "~DEFAULT_BRANCH") {
    return ref === defaultRef;
  }
  return refPattern(pattern).test(ref);
}

/** Whether a ruleset guard covers the branch: included by a pattern and excluded by none. */
export function rulesetGuards(
  guards: readonly RulesetGuard[],
  branch: string,
  defaultBranch: string,
): boolean {
  const ref = `refs/heads/${branch}`;
  const defaultRef = `refs/heads/${defaultBranch}`;
  return guards.some(
    (guard) =>
      guard.include.some((pattern) => refMatches(pattern, ref, defaultRef)) &&
      !guard.exclude.some((pattern) => refMatches(pattern, ref, defaultRef)),
  );
}

/** Branches read per GitHub page, the most GitHub serves. */
export const BRANCH_PAGE_SIZE = 100;
/** Pages read per listing, so one composer search costs at most this many calls. */
export const BRANCH_PAGE_LIMIT = 3;
/** Branches one listing returns. */
export const BRANCH_RESULT_LIMIT = 50;

export interface ListedBranch {
  readonly name: string;
  readonly protected: boolean;
}

export type BranchList =
  | {
      readonly kind: "listed";
      /** In GitHub's order, which is by name, filtered by the search. */
      readonly branches: readonly ListedBranch[];
      /**
       * More branches exist than were read or returned. A search narrows the
       * list, and an exact name is looked up directly.
       */
      readonly truncated: boolean;
    }
  | UpstreamFailure;

/**
 * Up to `BRANCH_PAGE_LIMIT` pages of `GET /repos/{owner}/{repo}/branches`,
 * keeping names that contain `query` (case-insensitive) and that OnCue can
 * work with. A query naming a branch exactly that the pages did not reach is
 * read by name, so a repository with thousands of branches still finds it.
 * GitHub's list carries no dates, so the order is GitHub's own.
 */
export async function listBranches(
  deps: ReadDeps,
  input: { readonly repositoryFullName: string; readonly query: string },
  token: string,
): Promise<BranchList> {
  const needle = input.query.toLowerCase();
  const found: ListedBranch[] = [];
  let morePages = false;
  for (let page = 1; page <= BRANCH_PAGE_LIMIT; page += 1) {
    const read = await readJson(
      deps,
      `/repos/${input.repositoryFullName}/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`,
      token,
    );
    if (read.kind === "not_found") {
      return upstreamFailure(404);
    }
    if (read.kind === "failed") {
      return read;
    }
    if (!Array.isArray(read.value)) {
      return malformed(200);
    }
    for (const entry of read.value) {
      const branch = branchIn(entry);
      if (branch === null) {
        return malformed(200);
      }
      if (isWorkableBranchName(branch.name) && branch.name.toLowerCase().includes(needle)) {
        found.push({ name: branch.name, protected: branch.protected });
      }
    }
    // GitHub's `Link` header names a next page while one exists.
    morePages = read.link?.includes('rel="next"') === true;
    if (!morePages) {
      break;
    }
  }
  if (
    morePages &&
    isWorkableBranchName(input.query) &&
    !found.some((branch) => branch.name === input.query)
  ) {
    const exact = await readBranch(
      deps,
      { repositoryFullName: input.repositoryFullName, branch: input.query },
      token,
    );
    if (exact.kind === "found") {
      found.unshift({ name: input.query, protected: exact.protected });
    }
  }
  return {
    kind: "listed",
    branches: found.slice(0, BRANCH_RESULT_LIMIT),
    truncated: morePages || found.length > BRANCH_RESULT_LIMIT,
  };
}
