// The double must tell the truth about GitHub's wire shapes, or a real bug in
// `worker/github/` could pass every test that uses it.

import { describe, expect, it } from "vitest";
import {
  createGitHubDouble,
  githubAppAuthorizationRevokedPayload,
  installationRepositoriesWebhookPayload,
  installationWebhookPayload,
  pushWebhookPayload,
  signWebhook,
} from "./github-double";

const INSTALLATION_ID = 1001;
const OTHER_INSTALLATION_ID = 2002;
const USER_ID = 42;
const OTHER_USER_ID = 43;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const OTHER_REPO = { id: 502, fullName: "acme/gadgets", defaultBranch: "main" };

function baseSeed() {
  return {
    users: [
      { id: USER_ID, login: "octocat" },
      { id: OTHER_USER_ID, login: "monalisa" },
    ],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" as const },
        appSlug: "oncue",
        visibleToUserIds: [USER_ID],
      },
      {
        installationId: OTHER_INSTALLATION_ID,
        account: { login: "other", type: "User" as const },
        appSlug: "oncue",
        visibleToUserIds: [OTHER_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [REPO, OTHER_REPO],
    },
    refsByRepository: {
      [REPO.fullName]: { main: "sha-main-1" },
    },
    oauthCodes: { "good-code": USER_ID },
  };
}

async function mintUserToken(fetchImpl: typeof fetch, code = "good-code"): Promise<string> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, grant_type: "authorization_code" }),
  });
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function mintInstallationToken(
  fetchImpl: typeof fetch,
  body: { repository_ids?: readonly number[]; permissions?: Record<string, string> } = {},
): Promise<{ status: number; token: string | undefined }> {
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: "Bearer fake-app-jwt" },
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json()) as { token?: string };
  return { status: response.status, token: parsed.token };
}

describe("createGitHubDouble installation tokens", () => {
  it("mints a token narrowed to the requested repositories and records the narrowing", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: "Bearer fake-app-jwt" },
        body: JSON.stringify({ repository_ids: [REPO.id], permissions: { contents: "write" } }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      repositories: readonly { full_name: string }[];
      permissions: Record<string, string>;
    };
    expect(body.token.startsWith("ghs_")).toBe(true);
    expect(body.repositories.map((repository) => repository.full_name)).toEqual([REPO.fullName]);
    expect(body.permissions).toEqual({ contents: "write" });

    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]?.tokenNarrowing).toEqual({
      repositoryIds: [REPO.id],
      permissions: { contents: "write" },
    });
    expect(double.calls[0]?.headerNames).toContain("authorization");
    expect(double.calls[0]?.hadAuthorization).toBe(true);
  });

  it("records an empty repository_ids list as such and mints a wide token, so a test can catch it", async () => {
    const double = createGitHubDouble(baseSeed());
    const { status, token } = await mintInstallationToken(double.fetchImpl, {});
    expect(status).toBe(201);
    expect(token).toBeDefined();
    expect(double.calls[0]?.tokenNarrowing).toEqual({ repositoryIds: [], permissions: {} });
  });

  it("refuses to mint without an Authorization header, and records nothing sensitive", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(response.status).toBe(401);
    expect(double.calls[0]?.hadAuthorization).toBe(false);
  });

  it("404s for an installation id nobody seeded", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl(
      "https://api.github.com/app/installations/999999/access_tokens",
      { method: "POST", headers: { authorization: "Bearer fake-app-jwt" }, body: "{}" },
    );
    expect(response.status).toBe(404);
  });

  it("setMode('token_mint_fails') forces GitHub's bad-credentials shape", async () => {
    const double = createGitHubDouble(baseSeed());
    double.setMode("token_mint_fails");
    const { status } = await mintInstallationToken(double.fetchImpl);
    expect(status).toBe(401);
  });
});

describe("createGitHubDouble installation token revocation", () => {
  it("revokes a minted token: 204, and records the boolean plus a timestamp, never the token", async () => {
    const double = createGitHubDouble(baseSeed());
    const { token } = await mintInstallationToken(double.fetchImpl, { repository_ids: [REPO.id] });
    expect(token).toBeDefined();

    const revoke = await double.fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(204);

    const revocationCall = double.calls.at(-1);
    expect(revocationCall?.tokenRevoked).toBe(true);
    expect(typeof revocationCall?.atMs).toBe("number");
    expect(JSON.stringify(double.calls)).not.toContain(token);
  });

  it("401s revoking an unknown token", async () => {
    const double = createGitHubDouble(baseSeed());
    const revoke = await double.fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: "Bearer ghs_never_issued" },
    });
    expect(revoke.status).toBe(401);
    expect(double.calls[0]?.tokenRevoked).toBe(false);
  });

  it("setMode('revoke_fails') forces a revocation failure even for a real token", async () => {
    const double = createGitHubDouble(baseSeed());
    const { token } = await mintInstallationToken(double.fetchImpl, { repository_ids: [REPO.id] });
    double.setMode("revoke_fails");
    const revoke = await double.fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(401);
  });

  it("401s revoking with no Authorization header", async () => {
    const double = createGitHubDouble(baseSeed());
    const revoke = await double.fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
    });
    expect(revoke.status).toBe(401);
  });
});

describe("createGitHubDouble OAuth code exchange", () => {
  it("exchanges a valid code for a user token pair", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "good-code" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.access_token).toMatch(/^ghu_/);
    expect(body.refresh_token).toMatch(/^ghr_/);
    expect(body.token_type).toBe("bearer");
  });

  it("answers an unknown code with GitHub's 200-status error body", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ code: "never-issued" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("bad_verification_code");
  });

  it("refuses to reuse a code once it has been exchanged", async () => {
    const double = createGitHubDouble(baseSeed());
    await mintUserToken(double.fetchImpl);
    const second = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ code: "good-code" }),
    });
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("bad_verification_code");
  });

  it("also accepts form-encoded bodies", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=good-code&grant_type=authorization_code",
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.access_token).toMatch(/^ghu_/);
  });

  it("refreshes a valid refresh token for a new pair", async () => {
    const double = createGitHubDouble(baseSeed());
    const first = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ code: "good-code" }),
    });
    const { refresh_token: refreshToken } = (await first.json()) as { refresh_token: string };

    const refreshed = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(body.access_token).toMatch(/^ghu_/);
  });

  it("answers an unknown refresh token with GitHub's error shape", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "ghr_never_issued" }),
    });
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("bad_refresh_token");
  });
});

describe("createGitHubDouble user and installation visibility", () => {
  it("GET /user returns the verified user for the presented token", async () => {
    const double = createGitHubDouble(baseSeed());
    const token = await mintUserToken(double.fetchImpl);
    const response = await double.fetchImpl("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: USER_ID, login: "octocat" });
  });

  it("401s GET /user for an unknown or missing token", async () => {
    const double = createGitHubDouble(baseSeed());
    const withoutAuth = await double.fetchImpl("https://api.github.com/user");
    expect(withoutAuth.status).toBe(401);
    const withBadToken = await double.fetchImpl("https://api.github.com/user", {
      headers: { authorization: "Bearer ghu_never_issued" },
    });
    expect(withBadToken.status).toBe(401);
  });

  it("hides an installation from a user it is not visible to", async () => {
    const double = createGitHubDouble(baseSeed());
    const token = await mintUserToken(double.fetchImpl);
    const response = await double.fetchImpl("https://api.github.com/user/installations", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as {
      total_count: number;
      installations: readonly { id: number }[];
    };
    expect(body.total_count).toBe(1);
    expect(body.installations.map((installation) => installation.id)).toEqual([INSTALLATION_ID]);
    expect(
      body.installations.some((installation) => installation.id === OTHER_INSTALLATION_ID),
    ).toBe(false);
  });

  it("401s GET /user/installations without a token", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://api.github.com/user/installations");
    expect(response.status).toBe(401);
  });

  it("lists repositories for an installation visible to the caller", async () => {
    const double = createGitHubDouble(baseSeed());
    const token = await mintUserToken(double.fetchImpl);
    const response = await double.fetchImpl(
      `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repositories: readonly { full_name: string }[] };
    expect(body.repositories.map((repository) => repository.full_name)).toEqual([
      REPO.fullName,
      OTHER_REPO.fullName,
    ]);
  });

  it("404s repositories for an installation not visible to the caller (spoofed installation_id)", async () => {
    const double = createGitHubDouble(baseSeed());
    const token = await mintUserToken(double.fetchImpl);
    const response = await double.fetchImpl(
      `https://api.github.com/user/installations/${OTHER_INSTALLATION_ID}/repositories`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(404);
  });
});

describe("createGitHubDouble refs", () => {
  it("returns the base commit for an existing branch", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl(
      `https://api.github.com/repos/${REPO.fullName}/git/ref/heads/main`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ref: "refs/heads/main",
      object: { sha: "sha-main-1", type: "commit" },
    });
  });

  it("404s a branch that was never seeded", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl(
      `https://api.github.com/repos/${REPO.fullName}/git/ref/heads/does-not-exist`,
    );
    expect(response.status).toBe(404);
  });

  it("creates a ref once, and 422s a second create of the same ref", async () => {
    const double = createGitHubDouble(baseSeed());
    const create = await double.fetchImpl(
      `https://api.github.com/repos/${REPO.fullName}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/oncue/fix-login-7f3a", sha: "sha-main-1" }),
      },
    );
    expect(create.status).toBe(201);
    expect(await create.json()).toEqual({
      ref: "refs/heads/oncue/fix-login-7f3a",
      object: { sha: "sha-main-1", type: "commit" },
    });

    const collide = await double.fetchImpl(
      `https://api.github.com/repos/${REPO.fullName}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/oncue/fix-login-7f3a", sha: "sha-main-1" }),
      },
    );
    expect(collide.status).toBe(422);
    expect(await collide.json()).toEqual({ message: "Reference already exists" });
  });

  it("setMode('ref_exists') forces the collision on the very first attempt", async () => {
    const double = createGitHubDouble(baseSeed());
    double.setMode("ref_exists");
    const response = await double.fetchImpl(
      `https://api.github.com/repos/${REPO.fullName}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/oncue/brand-new-abcd", sha: "sha-main-1" }),
      },
    );
    expect(response.status).toBe(422);
  });
});

describe("createGitHubDouble branches and repositories", () => {
  const get = (double: ReturnType<typeof createGitHubDouble>, path: string, token: string) =>
    double.fetchImpl(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it("answers a branch with its tip and protection, as GitHub does", async () => {
    const double = createGitHubDouble({
      ...baseSeed(),
      refsByRepository: { [REPO.fullName]: { main: "sha-main-1", "release/1.4": "sha-r" } },
      protectedBranchesByRepository: { [REPO.fullName]: ["main"] },
    });
    const { token } = await mintInstallationToken(double.fetchImpl, {
      repository_ids: [REPO.id],
      permissions: { contents: "read" },
    });
    const branch = await get(
      double,
      `/repos/${REPO.fullName}/branches/release/1.4`,
      token as string,
    );
    expect(await branch.json()).toMatchObject({
      name: "release/1.4",
      commit: { sha: "sha-r" },
      protected: false,
    });
    double.setProtected(REPO.fullName, "release/1.4", true);
    expect(
      await (
        await get(double, `/repos/${REPO.fullName}/branches/release/1.4`, token as string)
      ).json(),
    ).toMatchObject({ protected: true });
    double.setProtected(REPO.fullName, "release/1.4", false);
    double.deleteRef(REPO.fullName, "release/1.4");
    expect(double.branchNames(REPO.fullName)).toEqual(["main"]);
    expect(
      (await get(double, `/repos/${REPO.fullName}/branches/release/1.4`, token as string)).status,
    ).toBe(404);
  });

  it("lists branches by name in pages, naming the next page in a Link header", async () => {
    const refs: Record<string, string> = {};
    for (const name of ["c", "a", "b"]) {
      refs[name] = `sha-${name}`;
    }
    const double = createGitHubDouble({
      ...baseSeed(),
      refsByRepository: { [REPO.fullName]: refs },
    });
    const { token } = await mintInstallationToken(double.fetchImpl, {
      repository_ids: [REPO.id],
      permissions: { contents: "read" },
    });
    const first = await get(
      double,
      `/repos/${REPO.fullName}/branches?per_page=2&page=1`,
      token as string,
    );
    expect(((await first.json()) as { name: string }[]).map((branch) => branch.name)).toEqual([
      "a",
      "b",
    ]);
    expect(first.headers.get("link")).toContain('rel="next"');
    const last = await get(
      double,
      `/repos/${REPO.fullName}/branches?per_page=2&page=2`,
      token as string,
    );
    expect(((await last.json()) as { name: string }[]).map((branch) => branch.name)).toEqual(["c"]);
    expect(last.headers.get("link")).toBeNull();
  });

  it("answers the repository with its default branch as it is now", async () => {
    const double = createGitHubDouble(baseSeed());
    const { token } = await mintInstallationToken(double.fetchImpl, {
      repository_ids: [REPO.id],
      permissions: { contents: "read" },
    });
    double.setDefaultBranch(REPO.fullName, "trunk");
    expect(
      await (await get(double, `/repos/${REPO.fullName}`, token as string)).json(),
    ).toMatchObject({
      default_branch: "trunk",
    });
  });

  it("refuses a dead token, hides a repository outside the token, and refuses a token without contents", async () => {
    const double = createGitHubDouble(baseSeed());
    expect((await get(double, `/repos/${REPO.fullName}`, "not-issued")).status).toBe(401);
    const narrowed = await mintInstallationToken(double.fetchImpl, {
      repository_ids: [OTHER_REPO.id],
      permissions: { contents: "read" },
    });
    expect(
      (await get(double, `/repos/${REPO.fullName}/branches`, narrowed.token as string)).status,
    ).toBe(404);
    const withoutContents = await mintInstallationToken(double.fetchImpl, {
      repository_ids: [REPO.id],
      permissions: { pull_requests: "write" },
    });
    expect(
      (await get(double, `/repos/${REPO.fullName}`, withoutContents.token as string)).status,
    ).toBe(403);
  });
});

describe("createGitHubDouble unknown routes and setState", () => {
  it("404s a route this double does not implement", async () => {
    const double = createGitHubDouble(baseSeed());
    const response = await double.fetchImpl("https://api.github.com/not-a-real-route");
    expect(response.status).toBe(404);
  });

  it("setState replaces the fixtures entirely", async () => {
    const double = createGitHubDouble(baseSeed());
    double.setState({
      users: [{ id: 7, login: "newuser" }],
      installations: [],
    });
    const response = await double.fetchImpl(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
      { method: "POST", headers: { authorization: "Bearer fake-app-jwt" }, body: "{}" },
    );
    expect(response.status).toBe(404);
  });
});

describe("signWebhook", () => {
  it("produces a sha256=<hex> header that verifies against the same secret and body", async () => {
    const secret = "webhook-secret";
    const body = JSON.stringify({ hello: "world" });
    const header = await signWebhook(secret, body);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const [, hex] = header.split("=");
    const bytes = new Uint8Array(
      (hex ?? "").match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
    );
    const verified = await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
    expect(verified).toBe(true);
  });

  it("produces a different signature for a different body", async () => {
    const secret = "webhook-secret";
    const a = await signWebhook(secret, "{}");
    const b = await signWebhook(secret, '{"changed":true}');
    expect(a).not.toBe(b);
  });
});

describe("webhook payload fixtures", () => {
  it("shapes github_app_authorization revoked", () => {
    const payload = githubAppAuthorizationRevokedPayload(USER_ID, "octocat");
    expect(payload).toEqual({ action: "revoked", sender: { id: USER_ID, login: "octocat" } });
  });

  it("shapes installation events for created, deleted, suspend, and unsuspend", () => {
    const account = { login: "acme", type: "Organization" as const };
    const sender = { id: USER_ID, login: "octocat" };
    for (const action of ["created", "deleted", "suspend", "unsuspend"] as const) {
      const payload = installationWebhookPayload(action, INSTALLATION_ID, account, sender);
      expect(payload.action).toBe(action);
      expect(payload.installation).toEqual({ id: INSTALLATION_ID, account });
      expect(payload.sender).toEqual(sender);
    }
  });

  it("shapes installation_repositories with only the matching array populated", () => {
    const sender = { id: USER_ID, login: "octocat" };
    const repos = [{ id: REPO.id, full_name: REPO.fullName }];

    const added = installationRepositoriesWebhookPayload("added", INSTALLATION_ID, repos, sender);
    expect(added.repositories_added).toEqual(repos);
    expect(added.repositories_removed).toEqual([]);

    const removed = installationRepositoriesWebhookPayload(
      "removed",
      INSTALLATION_ID,
      repos,
      sender,
    );
    expect(removed.repositories_removed).toEqual(repos);
    expect(removed.repositories_added).toEqual([]);
  });

  it("shapes a push payload", () => {
    const sender = { id: USER_ID, login: "octocat" };
    const payload = pushWebhookPayload(
      { id: REPO.id, full_name: REPO.fullName, default_branch: REPO.defaultBranch },
      "refs/heads/oncue/fix-login-7f3a",
      "before-sha",
      "after-sha",
      sender,
    );
    expect(payload).toEqual({
      ref: "refs/heads/oncue/fix-login-7f3a",
      before: "before-sha",
      after: "after-sha",
      repository: { id: REPO.id, full_name: REPO.fullName, default_branch: REPO.defaultBranch },
      pusher: { name: "octocat" },
      sender,
    });
  });
});

// The browser half of the install flow, so a local install completes against
// the double.
describe("createGitHubDouble install page", () => {
  it("mints a single-use code for the first user and names the installation they can see", async () => {
    const double = createGitHubDouble({
      users: [{ id: 42, login: "octocat" }],
      installations: [
        {
          installationId: 9,
          account: { login: "hidden", type: "User" },
          appSlug: "oncue-local",
          visibleToUserIds: [],
        },
        {
          installationId: 4001,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue-local",
          visibleToUserIds: [42],
        },
      ],
    });

    const granted = double.install();
    expect(granted?.installationId).toBe(4001);

    // The code the page minted exchanges exactly like a seeded one, once.
    const exchange = () =>
      double.fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          code: granted?.code ?? "",
        }),
      });
    const first = (await (await exchange()).json()) as { access_token?: string };
    expect(typeof first.access_token).toBe("string");
    const second = (await (await exchange()).json()) as { error?: string };
    expect(second.error).toBe("bad_verification_code");
  });

  it("answers null when nobody is seeded, or when the seeded user can see no installation", () => {
    expect(createGitHubDouble().install()).toBeNull();
    expect(
      createGitHubDouble({
        users: [{ id: 1, login: "nobody" }],
        installations: [
          {
            installationId: 2,
            account: { login: "x", type: "User" },
            appSlug: "oncue-local",
            visibleToUserIds: [],
          },
        ],
      }).install(),
    ).toBeNull();
  });
});
