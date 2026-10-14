// Drives the branch reads against the double's branch and repository routes,
// and a fetch that fails in each way the readers distinguish. This module
// never mints a token: the double is handed one it already issued.

import { describe, expect, it } from "vitest";
import type { GitHubDoubleRuleset } from "../test/github-double";
import { createGitHubDouble, type GitHubDouble } from "../test/github-double";
import {
  BRANCH_PAGE_LIMIT,
  BRANCH_RESULT_LIMIT,
  isWorkableBranchName,
  listBranches,
  RULESET_LIMIT,
  readBranch,
  readBranchRules,
  readDefaultBranch,
  readRulesetGuards,
  rulesetGuards,
} from "./branches";

const API_ORIGIN = "https://api.github.com";
const INSTALLATION_ID = 1001;
const USER_ID = 42;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const BASE_SHA = "sha-main-1";

function seededDouble(
  extraRefs: Readonly<Record<string, string>> = {},
  protectedBranches: readonly string[] = [],
): GitHubDouble {
  return createGitHubDouble({
    users: [{ id: USER_ID, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue",
        visibleToUserIds: [USER_ID],
      },
    ],
    repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
    refsByRepository: { [REPO.fullName]: { main: BASE_SHA, ...extraRefs } },
    protectedBranchesByRepository: { [REPO.fullName]: protectedBranches },
  });
}

/** A live `contents: read` token from the double itself, as `withInstallationToken` would mint. */
async function tokenFor(double: GitHubDouble): Promise<string> {
  const minted = await double.fetchImpl(
    `${API_ORIGIN}/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: "Bearer app-jwt" },
      body: JSON.stringify({ repository_ids: [REPO.id], permissions: { contents: "read" } }),
    },
  );
  return ((await minted.json()) as { token: string }).token;
}

function answering(respond: () => Promise<Response>): typeof fetch {
  return () => respond();
}

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, apiOrigin: API_ORIGIN });

describe("isWorkableBranchName", () => {
  it.each(["main", "release/1.4", "feature/login_v2", "a.b-c", "x".repeat(255)])(
    "accepts %s",
    (name) => {
      expect(isWorkableBranchName(name)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(256)],
    ["a space", "has space"],
    ["a character the bridge refuses", "fix#1"],
    ["a leading dash, which reads as an option", "-x"],
    ["a leading slash", "/x"],
    ["a trailing slash", "x/"],
    ["a trailing dot", "x."],
    ["a double dot", "a..b"],
    ["a double slash", "a//b"],
    ["a component starting with a dot", "a/.hidden"],
    ["a component ending in .lock", "a.lock/b"],
  ])("refuses %s", (_, name) => {
    expect(isWorkableBranchName(name)).toBe(false);
  });
});

describe("readBranch", () => {
  it("reads a branch's tip and protection, keeping a slash in its name as a path", async () => {
    const double = seededDouble({ "release/1.4": "sha-release" }, ["release/1.4"]);
    const outcome = await readBranch(
      deps(double.fetchImpl),
      { repositoryFullName: REPO.fullName, branch: "release/1.4" },
      await tokenFor(double),
    );
    expect(outcome).toEqual({ kind: "found", sha: "sha-release", protected: true });
    expect(double.calls.at(-1)?.path).toBe(`/repos/${REPO.fullName}/branches/release/1.4`);
  });

  it("refuses branch_missing on a 404", async () => {
    const double = seededDouble();
    expect(
      await readBranch(
        deps(double.fetchImpl),
        { repositoryFullName: REPO.fullName, branch: "nope" },
        await tokenFor(double),
      ),
    ).toEqual({ kind: "refused", reason: "branch_missing" });
  });

  // GitHub follows a renamed branch's old name to the new branch.
  it("reads an answer naming another branch as missing", async () => {
    const renamed = answering(
      async () =>
        new Response(JSON.stringify({ name: "trunk", commit: { sha: "s" }, protected: false }), {
          status: 200,
        }),
    );
    expect(
      await readBranch(deps(renamed), { repositoryFullName: REPO.fullName, branch: "main" }, "t"),
    ).toEqual({ kind: "refused", reason: "branch_missing" });
  });

  it("reports a fetch that rejects as unreachable, and another status as rejected", async () => {
    const input = { repositoryFullName: REPO.fullName, branch: "main" };
    expect(
      await readBranch(deps(answering(() => Promise.reject(new Error("reset")))), input, "t"),
    ).toEqual({ kind: "failed", category: "unreachable", status: null });
    expect(
      await readBranch(
        deps(answering(async () => new Response("{}", { status: 401 }))),
        input,
        "t",
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 401 });
  });

  it.each([
    ["text that is not JSON", "nope"],
    ["a JSON array", "[]"],
    ["no commit", '{"name":"main","protected":false}'],
    ["a commit that is not an object", '{"name":"main","commit":"x","protected":false}'],
    ["a commit with no sha", '{"name":"main","commit":{},"protected":false}'],
    ["no protection flag", '{"name":"main","commit":{"sha":"s"}}'],
    ["no name", '{"commit":{"sha":"s"},"protected":false}'],
  ])("reports a 200 carrying %s as malformed_response", async (_, body) => {
    expect(
      await readBranch(
        deps(answering(async () => new Response(body, { status: 200 }))),
        { repositoryFullName: REPO.fullName, branch: "main" },
        "t",
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });
});

describe("readDefaultBranch", () => {
  it("reads the default branch as GitHub holds it now", async () => {
    const double = seededDouble({ trunk: "sha-trunk" });
    double.setDefaultBranch(REPO.fullName, "trunk");
    expect(
      await readDefaultBranch(deps(double.fetchImpl), REPO.fullName, await tokenFor(double)),
    ).toEqual({ kind: "found", name: "trunk" });
  });

  it("refuses repository_missing on a 404, and reads a failure as GitHub's", async () => {
    const double = seededDouble();
    const token = await tokenFor(double);
    expect(await readDefaultBranch(deps(double.fetchImpl), "acme/gone", token)).toEqual({
      kind: "refused",
      reason: "repository_missing",
    });
    expect(
      await readDefaultBranch(
        deps(answering(async () => new Response("", { status: 502 }))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 502 });
  });

  it.each([
    ["a JSON array", "[]"],
    ["no default branch", '{"full_name":"acme/widgets"}'],
  ])("reports a 200 carrying %s as malformed_response", async (_, body) => {
    expect(
      await readDefaultBranch(
        deps(answering(async () => new Response(body, { status: 200 }))),
        REPO.fullName,
        "t",
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });

  it("refuses a token without contents access as GitHub does", async () => {
    const double = seededDouble();
    expect(await readDefaultBranch(deps(double.fetchImpl), REPO.fullName, "not-issued")).toEqual({
      kind: "failed",
      category: "rejected",
      status: 401,
    });
  });
});

describe("listBranches", () => {
  const input = (query: string) => ({ repositoryFullName: REPO.fullName, query });

  it("lists every workable branch with its protection, in GitHub's order", async () => {
    const double = seededDouble({ "release/1.4": "s1", "feature/login": "s2", "fix#1": "s3" }, [
      "release/1.4",
    ]);
    const listed = await listBranches(deps(double.fetchImpl), input(""), await tokenFor(double));
    expect(listed).toEqual({
      kind: "listed",
      branches: [
        { name: "feature/login", protected: false },
        { name: "main", protected: false },
        { name: "release/1.4", protected: true },
      ],
      truncated: false,
    });
    expect(double.calls.at(-1)?.path).toBe(`/repos/${REPO.fullName}/branches`);
  });

  it("keeps names containing the search, ignoring case", async () => {
    const double = seededDouble({ "Feature/Login": "s1", "feature/signup": "s2" });
    const listed = await listBranches(
      deps(double.fetchImpl),
      input("LOGIN"),
      await tokenFor(double),
    );
    expect(listed).toMatchObject({ branches: [{ name: "Feature/Login" }] });
  });

  it(`reads at most ${BRANCH_PAGE_LIMIT} pages, says the list is truncated, and looks an exact name up directly`, async () => {
    const refs: Record<string, string> = {};
    for (let index = 0; index < 350; index += 1) {
      refs[`b-${String(index).padStart(3, "0")}`] = `s${index}`;
    }
    refs["zz-late"] = "s-late";
    const double = seededDouble(refs, ["zz-late"]);
    const token = await tokenFor(double);

    const all = await listBranches(deps(double.fetchImpl), input(""), token);
    expect(all).toMatchObject({ kind: "listed", truncated: true });
    expect(all.kind === "listed" ? all.branches.length : 0).toBe(BRANCH_RESULT_LIMIT);
    const pages = double.calls.filter((call) => call.path.endsWith("/branches"));
    expect(pages).toHaveLength(BRANCH_PAGE_LIMIT);

    expect(await listBranches(deps(double.fetchImpl), input("zz-late"), token)).toEqual({
      kind: "listed",
      branches: [{ name: "zz-late", protected: true }],
      truncated: true,
    });
    // A partial name past the pages is not guessed at; an unknown exact name adds nothing.
    expect(await listBranches(deps(double.fetchImpl), input("zz-"), token)).toEqual({
      kind: "listed",
      branches: [],
      truncated: true,
    });
    expect(await listBranches(deps(double.fetchImpl), input("nope"), token)).toEqual({
      kind: "listed",
      branches: [],
      truncated: true,
    });
    // A search that is no branch name is never looked up.
    const before = double.calls.length;
    await listBranches(deps(double.fetchImpl), input("has space"), token);
    expect(double.calls.slice(before).every((call) => call.path.endsWith("/branches"))).toBe(true);
  });

  it("does not look up an exact name the pages already found", async () => {
    const refs: Record<string, string> = {};
    for (let index = 0; index < 320; index += 1) {
      refs[`b-${String(index).padStart(3, "0")}`] = `s${index}`;
    }
    const double = seededDouble(refs);
    const listed = await listBranches(
      deps(double.fetchImpl),
      input("b-001"),
      await tokenFor(double),
    );
    expect(listed).toMatchObject({ branches: [{ name: "b-001" }], truncated: true });
    expect(double.calls.filter((call) => call.path.includes("/branches/"))).toEqual([]);
  });

  it("reads a 404 on the list as a rejection, and a failure as GitHub's", async () => {
    const double = seededDouble();
    const token = await tokenFor(double);
    expect(
      await listBranches(
        deps(double.fetchImpl),
        { repositoryFullName: "acme/gone", query: "" },
        token,
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 404 });
    expect(
      await listBranches(
        deps(answering(() => Promise.reject(new Error("reset")))),
        input(""),
        token,
      ),
    ).toEqual({ kind: "failed", category: "unreachable", status: null });
  });

  it.each([
    ["an object instead of a list", "{}"],
    ["a list holding something that is not a branch", "[1]"],
  ])("reports a page carrying %s as malformed_response", async (_, body) => {
    expect(
      await listBranches(
        deps(answering(async () => new Response(body, { status: 200 }))),
        input(""),
        "t",
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });
});

const ruleset = (overrides: Partial<GitHubDoubleRuleset> = {}): GitHubDoubleRuleset => ({
  id: 1,
  name: "Guard",
  target: "branch",
  enforcement: "active",
  include: ["refs/heads/release/*"],
  exclude: [],
  rules: ["update"],
  ...overrides,
});

describe("readBranchRules", () => {
  const input = { repositoryFullName: REPO.fullName, branch: "release/1.4" };

  it.each([
    "update",
    "non_fast_forward",
    "deletion",
    "pull_request",
    "required_status_checks",
    "required_signatures",
    "merge_queue",
    "a_rule_github_adds_later",
  ])("reads a %s rule as guarding the branch", async (rule) => {
    const double = seededDouble({ "release/1.4": "s" });
    double.setRulesets(REPO.fullName, [ruleset({ rules: ["creation", rule] })]);
    expect(await readBranchRules(deps(double.fetchImpl), input, await tokenFor(double))).toEqual({
      kind: "read",
      guarded: true,
    });
    expect(double.calls.at(-1)?.path).toBe(`/repos/${REPO.fullName}/rules/branches/release/1.4`);
  });

  it("reads no rule, or only rules about creating or naming, as unguarded", async () => {
    const double = seededDouble({ "release/1.4": "s" });
    const token = await tokenFor(double);
    expect(await readBranchRules(deps(double.fetchImpl), input, token)).toEqual({
      kind: "read",
      guarded: false,
    });
    double.setRulesets(REPO.fullName, [
      ruleset({ rules: ["creation", "branch_name_pattern", "tag_name_pattern"] }),
    ]);
    expect(await readBranchRules(deps(double.fetchImpl), input, token)).toEqual({
      kind: "read",
      guarded: false,
    });
  });

  it("reads a 404 as a missing repository and any other failure as GitHub's", async () => {
    const double = seededDouble();
    const token = await tokenFor(double);
    expect(
      await readBranchRules(
        deps(double.fetchImpl),
        { repositoryFullName: "acme/gone", branch: "main" },
        token,
      ),
    ).toEqual({ kind: "refused", reason: "repository_missing" });
    expect(
      await readBranchRules(
        deps(answering(async () => new Response("", { status: 500 }))),
        input,
        "t",
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 500 });
  });

  it.each([
    ["an object instead of a list", "{}"],
    ["a rule with no type", '[{"ruleset_id":1}]'],
    ["something that is not a rule", "[7]"],
  ])("reports a 200 carrying %s as malformed_response", async (_, body) => {
    expect(
      await readBranchRules(
        deps(answering(async () => new Response(body, { status: 200 }))),
        input,
        "t",
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });
});

describe("readRulesetGuards and rulesetGuards", () => {
  it("keeps the active branch rulesets that guard pushes, with their ref conditions", async () => {
    const double = seededDouble();
    double.setRulesets(REPO.fullName, [
      ruleset({ id: 1 }),
      ruleset({ id: 2, rules: ["creation"] }),
      ruleset({ id: 3, enforcement: "evaluate" }),
      ruleset({ id: 4, target: "tag" }),
      ruleset({
        id: 5,
        include: ["~ALL"],
        exclude: ["refs/heads/feature/**"],
        source: "Organization",
      }),
    ]);
    expect(
      await readRulesetGuards(deps(double.fetchImpl), REPO.fullName, await tokenFor(double)),
    ).toEqual({
      kind: "read",
      guards: [
        { include: ["refs/heads/release/*"], exclude: [] },
        { include: ["~ALL"], exclude: ["refs/heads/feature/**"] },
      ],
    });
  });

  it(`reads more than ${RULESET_LIMIT} active rulesets, or one with no ref condition, as guarding everything`, async () => {
    const double = seededDouble();
    double.setRulesets(
      REPO.fullName,
      Array.from({ length: RULESET_LIMIT + 1 }, (_, index) => ruleset({ id: index + 1 })),
    );
    const token = await tokenFor(double);
    expect(await readRulesetGuards(deps(double.fetchImpl), REPO.fullName, token)).toEqual({
      kind: "read",
      guards: [{ include: ["~ALL"], exclude: [] }],
    });
    const bare: typeof fetch = async (url, init) =>
      String(url).endsWith("/rulesets/1?includes_parents=true")
        ? Response.json({ id: 1, rules: [{ type: "update" }] })
        : String(url).includes("/rulesets?")
          ? Response.json([{ id: 1, target: "branch", enforcement: "active" }])
          : double.fetchImpl(url, init);
    expect(await readRulesetGuards(deps(bare), REPO.fullName, token)).toEqual({
      kind: "read",
      guards: [{ include: ["~ALL"], exclude: [] }],
    });
    const oddPatterns: typeof fetch = async (url, init) =>
      String(url).endsWith("/rulesets/1?includes_parents=true")
        ? Response.json({
            id: 1,
            conditions: { ref_name: { include: "x", exclude: [1] } },
            rules: [{ type: "update" }],
          })
        : bare(url, init);
    expect(await readRulesetGuards(deps(oddPatterns), REPO.fullName, token)).toEqual({
      kind: "read",
      guards: [{ include: ["~ALL"], exclude: [] }],
    });
  });

  it("reads a failure listing or reading a ruleset as GitHub's", async () => {
    const double = seededDouble();
    double.setRulesets(REPO.fullName, [ruleset()]);
    const token = await tokenFor(double);
    const failingAt =
      (part: string, answer: () => Response): typeof fetch =>
      async (url, init) =>
        String(url).includes(part) ? answer() : double.fetchImpl(url, init);
    expect(await readRulesetGuards(deps(double.fetchImpl), "acme/gone", token)).toEqual({
      kind: "failed",
      category: "rejected",
      status: 404,
    });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets?", () => new Response("", { status: 500 }))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 500 });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets?", () => Response.json({}))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets?", () => Response.json([{}]))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets/1", () => new Response("", { status: 404 }))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 404 });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets/1", () => new Response("", { status: 502 }))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 502 });
    expect(
      await readRulesetGuards(
        deps(failingAt("/rulesets/1", () => Response.json({}))),
        REPO.fullName,
        token,
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });

  it("matches ref patterns as GitHub documents for rulesets", () => {
    const guard = (include: string[], exclude: string[] = []) => [{ include, exclude }];
    expect(rulesetGuards(guard(["refs/heads/release/*"]), "release/1.4", "main")).toBe(true);
    expect(rulesetGuards(guard(["refs/heads/release/*"]), "release/1.4/hotfix", "main")).toBe(
      false,
    );
    expect(rulesetGuards(guard(["refs/heads/release/**"]), "release/1.4/hotfix", "main")).toBe(
      true,
    );
    expect(rulesetGuards(guard(["refs/heads/v?"]), "v1", "main")).toBe(true);
    expect(rulesetGuards(guard(["refs/heads/v?"]), "v10", "main")).toBe(false);
    expect(rulesetGuards(guard(["refs/heads/a.b+c"]), "a.b+c", "main")).toBe(true);
    expect(rulesetGuards(guard(["refs/heads/a.b"]), "axb", "main")).toBe(false);
    expect(rulesetGuards(guard(["~DEFAULT_BRANCH"]), "main", "main")).toBe(true);
    expect(rulesetGuards(guard(["~DEFAULT_BRANCH"]), "dev", "main")).toBe(false);
    expect(rulesetGuards(guard(["~ALL"], ["refs/heads/feature/*"]), "feature/x", "main")).toBe(
      false,
    );
    expect(rulesetGuards(guard(["~ALL"], ["~DEFAULT_BRANCH"]), "dev", "main")).toBe(true);
    expect(rulesetGuards([], "anything", "main")).toBe(false);
  });
});

describe("a repository whose plan has no rulesets", () => {
  it("reads as no rule and no guard, as GitHub's upgrade answer means none can exist", async () => {
    const double = createGitHubDouble({
      installations: [
        {
          installationId: INSTALLATION_ID,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue",
          visibleToUserIds: [USER_ID],
        },
      ],
      repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
      refsByRepository: { [REPO.fullName]: { main: BASE_SHA } },
      rulesetsNotInPlan: [REPO.fullName],
    });
    const token = await tokenFor(double);
    expect(
      await readBranchRules(
        deps(double.fetchImpl),
        { repositoryFullName: REPO.fullName, branch: "main" },
        token,
      ),
    ).toEqual({ kind: "read", guarded: false });
    expect(await readRulesetGuards(deps(double.fetchImpl), REPO.fullName, token)).toEqual({
      kind: "read",
      guards: [],
    });
  });

  it("still fails closed on any other refusal", async () => {
    const forbidden = answering(async () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    );
    expect(
      await readBranchRules(
        deps(forbidden),
        { repositoryFullName: REPO.fullName, branch: "main" },
        "t",
      ),
    ).toEqual({ kind: "failed", category: "rejected", status: 403 });
    expect(await readRulesetGuards(deps(forbidden), REPO.fullName, "t")).toEqual({
      kind: "failed",
      category: "rejected",
      status: 403,
    });
    expect(
      await readBranchRules(
        deps(answering(() => Promise.reject(new Error("reset")))),
        { repositoryFullName: REPO.fullName, branch: "main" },
        "t",
      ),
    ).toEqual({ kind: "failed", category: "unreachable", status: null });
    expect(
      await readBranchRules(
        deps(answering(async () => new Response("nope", { status: 200 }))),
        { repositoryFullName: REPO.fullName, branch: "main" },
        "t",
      ),
    ).toEqual({ kind: "failed", category: "malformed_response", status: 200 });
  });
});

describe("branch names in GitHub paths", () => {
  it.each([
    ["release#1", "release%231"],
    ["what?now", "what%3Fnow"],
    ["100%", "100%25"],
    ["has space/inner", "has%20space/inner"],
  ])(
    "escapes %s as %s, keeping slashes, so another branch is never asked about",
    async (branch, escaped) => {
      const double = seededDouble({ [branch]: "sha-odd" });
      double.setRulesets(REPO.fullName, [ruleset({ include: ["~ALL"], rules: ["update"] })]);
      const token = await tokenFor(double);
      expect(
        await readBranch(
          deps(double.fetchImpl),
          { repositoryFullName: REPO.fullName, branch },
          token,
        ),
      ).toEqual({ kind: "found", sha: "sha-odd", protected: false });
      expect(
        await readBranchRules(
          deps(double.fetchImpl),
          { repositoryFullName: REPO.fullName, branch },
          token,
        ),
      ).toEqual({ kind: "read", guarded: true });
      const asked = double.calls.slice(-2).map((call) => call.path);
      expect(asked).toEqual([
        `/repos/${REPO.fullName}/branches/${escaped}`,
        `/repos/${REPO.fullName}/rules/branches/${escaped}`,
      ]);
    },
  );
});

describe("a full page of rules", () => {
  it("fails closed when every rule on a full page is neutral, since more may follow", async () => {
    const page = (count: number, type = "creation") =>
      answering(async () =>
        Response.json(
          Array.from({ length: count }, () => ({ type })),
          { status: 200 },
        ),
      );
    const input = { repositoryFullName: REPO.fullName, branch: "main" };
    expect(await readBranchRules(deps(page(100)), input, "t")).toEqual({
      kind: "failed",
      category: "malformed_response",
      status: 200,
    });
    expect(await readBranchRules(deps(page(99)), input, "t")).toEqual({
      kind: "read",
      guarded: false,
    });
    expect(await readBranchRules(deps(page(100, "update")), input, "t")).toEqual({
      kind: "read",
      guarded: true,
    });
  });

  it("reads a full page of rulesets as guarding everything", async () => {
    const listing = answering(async () =>
      Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          target: "tag",
          enforcement: "active",
        })),
      ),
    );
    expect(await readRulesetGuards(deps(listing), REPO.fullName, "t")).toEqual({
      kind: "read",
      guards: [{ include: ["~ALL"], exclude: [] }],
    });
  });

  it("matches the plan answer by its message alone", async () => {
    const answer = (body: unknown) => answering(async () => Response.json(body, { status: 403 }));
    const input = { repositoryFullName: REPO.fullName, branch: "main" };
    expect(
      await readBranchRules(
        deps(
          answer({
            message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          }),
        ),
        input,
        "t",
      ),
    ).toEqual({ kind: "read", guarded: false });
    // The sentence anywhere but the message, or not JSON at all, is a refusal.
    for (const body of [
      {
        message: "Forbidden",
        detail: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
      },
      ["Upgrade to GitHub Pro or make this repository public to enable this feature."],
      { documentation_url: "https://docs.github.com" },
    ]) {
      expect(await readBranchRules(deps(answer(body)), input, "t")).toEqual({
        kind: "failed",
        category: "rejected",
        status: 403,
      });
    }
    const raw = answering(
      async () =>
        new Response(
          "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          {
            status: 403,
          },
        ),
    );
    expect(await readBranchRules(deps(raw), input, "t")).toEqual({
      kind: "failed",
      category: "rejected",
      status: 403,
    });
  });
});
