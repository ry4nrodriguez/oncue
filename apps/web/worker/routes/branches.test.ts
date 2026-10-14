import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { BRANCH_PAGE_LIMIT } from "../github/branches";
import { createClerkDouble } from "../test/clerk-double";
import { createGitHubDouble, type GitHubDouble, githubTestSettings } from "../test/github-double";
import {
  BRANCH_QUERY_LIMIT,
  extractBranchesRepositoryId,
  handleListBranches,
  orderBranches,
} from "./branches";

const ORIGIN = "https://oncue.example";
const NOW = "2026-10-04T00:00:00.000Z";
const OWNER = "user_branches_owner";
const STRANGER = "user_branches_stranger";
const INSTALLATION_ID = 8801;
const REPOSITORY_ID = 9901;

async function seedRepository(
  subject: string,
  connectionId: string,
  options: { readonly installationStatus?: string; readonly lastVerifiedAt?: string } = {},
): Promise<void> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  const installation = `ins_${connectionId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference, refresh_token_reference,
         user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 42, 'acme', 'Organization', ?, 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
    ).bind(
      installation,
      workspaceId,
      INSTALLATION_ID,
      options.installationStatus ?? "active",
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
      // Recent, so `verifyInstallation` takes its fast path unless a case says otherwise.
      options.lastVerifiedAt ?? new Date().toISOString(),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme/widgets', 'main', 'verified', ?, ?)`,
    ).bind(connectionId, workspaceId, installation, REPOSITORY_ID, NOW, NOW),
  ]);
}

function github(refs: Readonly<Record<string, string>>, protectedBranches: string[] = []) {
  const double = createGitHubDouble({
    users: [{ id: 42, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [42],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [{ id: REPOSITORY_ID, fullName: "acme/widgets", defaultBranch: "main" }],
    },
    refsByRepository: { "acme/widgets": refs },
    protectedBranchesByRepository: { "acme/widgets": protectedBranches },
  });
  vi.stubGlobal("fetch", double.fetchImpl);
  return double;
}

async function list(
  query: string | null,
  options: {
    readonly connectionId?: string;
    readonly subject?: string | null;
    readonly allowlist?: string;
    readonly overrides?: Record<string, string | undefined>;
  } = {},
) {
  const clerk = await createClerkDouble();
  const connectionId = options.connectionId ?? "rc_branches";
  const path = `/api/repositories/${connectionId}/branches${query === null ? "" : `?q=${encodeURIComponent(query)}`}`;
  const headers = new Headers();
  const subject = options.subject === undefined ? OWNER : options.subject;
  if (subject !== null) {
    const authed = await clerk.requestAs(subject, `${ORIGIN}${path}`);
    headers.set("cookie", authed.headers.get("cookie") ?? "");
  }
  const response = await handleListBranches(
    new Request(`${ORIGIN}${path}`, { headers }),
    {
      ...env,
      ...(await githubTestSettings()),
      ONCUE_GITHUB_API_ORIGIN: "https://github.double",
      CLERK_JWT_KEY: clerk.jwtKey,
      ONCUE_USER_ALLOWLIST: options.allowlist ?? `${OWNER},${STRANGER}`,
      ...options.overrides,
    } as unknown as Env,
    connectionId,
    createAllowlistCache(),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM repository_connection"),
    env.DB.prepare("DELETE FROM github_installation"),
  ]);
  await seedRepository(OWNER, "rc_branches");
  await seedRepository(STRANGER, "rc_theirs");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractBranchesRepositoryId", () => {
  it("matches the branches path and nothing else", () => {
    expect(extractBranchesRepositoryId("/api/repositories/rc_1/branches")).toBe("rc_1");
    expect(extractBranchesRepositoryId("/api/repositories/rc_1/branches/main")).toBeNull();
    expect(extractBranchesRepositoryId("/api/repositories/rc_1")).toBeNull();
    expect(extractBranchesRepositoryId("/api/repositories/%E0%A4%A/branches")).toBeNull();
  });
});

describe("orderBranches", () => {
  it("puts the default branch first, even when the pages read did not reach it", () => {
    expect(orderBranches("main", "", [{ name: "a", protected: false }])).toEqual([
      { name: "main", protected: false, default: true },
      { name: "a", protected: false, default: false },
    ]);
    expect(
      orderBranches("main", "", [
        { name: "a", protected: false },
        { name: "main", protected: true },
      ]),
    ).toEqual([
      { name: "main", protected: true, default: true },
      { name: "a", protected: false, default: false },
    ]);
  });

  it("leaves the default branch out of a search it does not match", () => {
    expect(orderBranches("main", "LOG", [{ name: "login", protected: false }])).toEqual([
      { name: "login", protected: false, default: false },
    ]);
    expect(orderBranches("Main", "mai", [])).toEqual([
      { name: "Main", protected: false, default: true },
    ]);
  });
});

describe("GET /api/repositories/:id/branches", () => {
  it("lists the branches with the default first and protection marked, under a read token it revokes", async () => {
    const double = github({ main: "s0", "feature/login": "s1", "release/1.4": "s2" }, ["main"]);
    expect(await list(null)).toEqual({
      status: 200,
      body: {
        defaultBranch: "main",
        branches: [
          { name: "main", protected: true, default: true },
          { name: "feature/login", protected: false, default: false },
          { name: "release/1.4", protected: false, default: false },
        ],
        truncated: false,
      },
    });
    const mints = double.calls.filter((call) => call.tokenNarrowing !== undefined);
    expect(mints.map((call) => call.tokenNarrowing)).toEqual([
      { repositoryIds: [REPOSITORY_ID], permissions: { contents: "read" } },
    ]);
    expect(double.calls.at(-1)).toMatchObject({ tokenRevoked: true });
  });

  it("marks a branch an active ruleset guards as protected, which the branch API does not", async () => {
    const double = github({ main: "s0", "feature/login": "s1", "release/1.4": "s2" });
    double.setRulesets("acme/widgets", [
      {
        id: 9,
        name: "Releases",
        target: "branch",
        enforcement: "active",
        include: ["refs/heads/release/**", "~DEFAULT_BRANCH"],
        exclude: [],
        rules: ["non_fast_forward"],
        source: "Organization",
      },
    ]);
    const listed = await list(null);
    expect(listed.body.branches).toEqual([
      { name: "main", protected: true, default: true },
      { name: "feature/login", protected: false, default: false },
      { name: "release/1.4", protected: true, default: false },
    ]);
  });

  it("offers no list when GitHub will not describe the rulesets", async () => {
    const healthy = github({ main: "s" });
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/rulesets")
        ? new Response("", { status: 500 })
        : healthy.fetchImpl(input, init)) as typeof fetch);
    expect(await list(null)).toEqual({ status: 502, body: { error: "github_unreachable" } });
  });

  it("narrows to a search, and says when GitHub holds more than one listing reads", async () => {
    const refs: Record<string, string> = { main: "s" };
    for (let index = 0; index < 100 * BRANCH_PAGE_LIMIT + 5; index += 1) {
      refs[`topic-${index}`] = `s${index}`;
    }
    github(refs);
    const searched = await list("  topic-12  ");
    expect(searched.status).toBe(200);
    expect(searched.body.truncated).toBe(true);
    expect(
      (searched.body.branches as { name: string }[]).every((branch) =>
        branch.name.includes("topic-12"),
      ),
    ).toBe(true);
  });

  it("answers 401 signed out and 403 off the allowlist, before GitHub is asked", async () => {
    const double = github({ main: "s" });
    expect((await list(null, { subject: null })).status).toBe(401);
    expect((await list(null, { allowlist: STRANGER })).status).toBe(403);
    expect(double.calls).toEqual([]);
  });

  it("answers 404 for another workspace's repository, as for one that does not exist", async () => {
    github({ main: "s" });
    expect(await list(null, { connectionId: "rc_theirs" })).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect((await list(null, { connectionId: "rc_none" })).status).toBe(404);
  });

  it("refuses a search longer than any branch name", async () => {
    github({ main: "s" });
    expect(await list("x".repeat(BRANCH_QUERY_LIMIT + 1))).toEqual({
      status: 400,
      body: { error: "invalid_request", reason: "query" },
    });
  });

  it("says reconnect GitHub for an installation that is not active, or that GitHub no longer shows", async () => {
    await env.DB.prepare(
      "UPDATE github_installation SET status = 'suspended' WHERE installation_row_id = 'ins_rc_branches'",
    ).run();
    github({ main: "s" });
    expect(await list(null)).toEqual({
      status: 409,
      body: { error: "github_reverification_required", reason: "not_connected" },
    });

    await env.DB.prepare(
      "UPDATE github_installation SET status = 'active', last_verified_at = ? WHERE installation_row_id = 'ins_rc_branches'",
    )
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    // A stale verification asks GitHub, and this user can no longer see it.
    const double: GitHubDouble = github({ main: "s" });
    double.setState({});
    const refused = await list(null);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("github_reverification_required");
  });

  it("answers 503 with no GitHub App, and 502 when GitHub cannot list", async () => {
    github({ main: "s" });
    expect(await list(null, { overrides: { ONCUE_GITHUB_APP_PRIVATE_KEY: undefined } })).toEqual({
      status: 503,
      body: { error: "github_unconfigured" },
    });

    const failing = github({ main: "s" });
    failing.setMode("token_mint_fails");
    expect(await list(null)).toEqual({ status: 502, body: { error: "github_unreachable" } });

    const healthy = github({ main: "s" });
    const answering500: typeof fetch = async (input, init) =>
      String(input).includes("/branches")
        ? new Response("", { status: 500 })
        : healthy.fetchImpl(input, init);
    vi.stubGlobal("fetch", answering500);
    expect(await list(null)).toEqual({ status: 502, body: { error: "github_unreachable" } });
  });
});
