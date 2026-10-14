import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { deriveInstallationRowId } from "../github/store";
import { createClerkDouble } from "../test/clerk-double";
import { createGitHubDouble, githubTestSettings } from "../test/github-double";
import {
  extractRemoveRepositoryId,
  extractRestoreRepositoryId,
  handleCreateInstallUrl,
  handleGitHubCallback,
  handleListRepositories,
  handleSetRepositoryRemoved,
} from "./repositories";

// Tests the route shell; `worker/github/install.test.ts` covers the flow
// itself. The global `fetch` is stubbed with the GitHub double, which the
// route reaches because it binds `fetch` per request.

const REPOSITORIES_URL = "https://oncue.example/api/repositories";
const INSTALL_URL_ROUTE = "https://oncue.example/api/github/install-url";
const CALLBACK = "https://oncue.example/api/github/callback";
const NOW = "2026-09-05T00:00:00.000Z";
const SUBJECT = "user_repos";

const GITHUB_SETTINGS = await githubTestSettings();

type Overrides = Partial<Record<string, string | undefined>>;

function envWith(overrides: Overrides = {}): Env {
  return { ...env, ...GITHUB_SETTINGS, ...overrides } as unknown as Env;
}

async function requestAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  url: string,
  method = "GET",
): Promise<Request> {
  const authed = await double.requestAs(SUBJECT, url);
  return new Request(url, {
    method,
    headers: new Headers({ cookie: authed.headers.get("cookie") ?? "" }),
  });
}

async function seedWorkspace(subject: string): Promise<string> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
  ]);
  return workspaceId;
}

async function insertInstallation(
  workspaceId: string,
  githubInstallationId = 4001,
): Promise<string> {
  const rowId = await deriveInstallationRowId(workspaceId, githubInstallationId);
  await env.DB.prepare(
    `INSERT INTO github_installation (
       installation_row_id, workspace_id, github_installation_id, github_user_id,
       account_login, account_type, status, user_token_reference, refresh_token_reference,
       user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
  )
    .bind(rowId, workspaceId, githubInstallationId, NOW, NOW, NOW, NOW, NOW)
    .run();
  return rowId;
}

async function insertRepository(
  workspaceId: string,
  rowId: string,
  connectionId: string,
  overrides: { status?: string; fullName?: string; githubRepositoryId?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repository_connection (
       repository_connection_id, workspace_id, installation_row_id, github_repository_id,
       full_name, default_branch, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?)`,
  )
    .bind(
      connectionId,
      workspaceId,
      rowId,
      overrides.githubRepositoryId ?? 501,
      overrides.fullName ?? "acme/widgets",
      overrides.status ?? "verified",
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM repository_connection"),
    env.DB.prepare("DELETE FROM github_installation"),
    env.DB.prepare("DELETE FROM external_identity WHERE provider = 'github'"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/repositories", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await handleListRepositories(
      new Request(REPOSITORIES_URL),
      envWith(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a caller who is not allowlisted", async () => {
    const double = await createClerkDouble();

    const response = await handleListRepositories(
      await requestAs(double, REPOSITORIES_URL),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "" }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(403);
  });

  it("lists the caller's repositories, verified and disconnected alike", async () => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace(SUBJECT);
    const rowId = await insertInstallation(workspaceId);
    await insertRepository(workspaceId, rowId, "rc_live");
    await insertRepository(workspaceId, rowId, "rc_gone", {
      status: "disconnected",
      fullName: "acme/legacy",
      githubRepositoryId: 502,
    });

    const response = await handleListRepositories(
      await requestAs(double, REPOSITORIES_URL),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repositories: { repositoryConnectionId: string; status: string }[];
    };
    expect(body.repositories.map((row) => [row.repositoryConnectionId, row.status]).sort()).toEqual(
      [
        ["rc_gone", "disconnected"],
        ["rc_live", "verified"],
      ],
    );
  });

  // The projection, not the row: internal ids must not be enumerable.
  it("shows exactly the six fields the browser parses and nothing else", async () => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace(SUBJECT);
    const rowId = await insertInstallation(workspaceId);
    await insertRepository(workspaceId, rowId, "rc_live");

    const response = await handleListRepositories(
      await requestAs(double, REPOSITORIES_URL),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      createAllowlistCache(),
    );

    const text = await response.text();
    const body = JSON.parse(text) as { repositories: Record<string, unknown>[] };
    expect(Object.keys(body.repositories[0] ?? {}).sort()).toEqual([
      "createdAt",
      "defaultBranch",
      "fullName",
      "removedAt",
      "repositoryConnectionId",
      "status",
    ]);
    expect(text.includes(rowId)).toBe(false);
    expect(text.includes("501")).toBe(false);
  });

  // A list reading "Verified" while every session start is refused for an
  // inactive installation would mislead the user.
  it.each(["suspended", "deleted", "unauthorized"])(
    "shows a repository as disconnected when its installation is %s",
    async (installationStatus) => {
      const double = await createClerkDouble();
      const workspaceId = await seedWorkspace(SUBJECT);
      const rowId = await insertInstallation(workspaceId);
      await insertRepository(workspaceId, rowId, "rc_live");
      await env.DB.prepare(
        "UPDATE github_installation SET status = ? WHERE installation_row_id = ?",
      )
        .bind(installationStatus, rowId)
        .run();

      const response = await handleListRepositories(
        await requestAs(double, REPOSITORIES_URL),
        envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
        createAllowlistCache(),
      );

      const body = (await response.json()) as { repositories: { status: string }[] };
      expect(body.repositories.map((row) => row.status)).toEqual(["disconnected"]);
    },
  );

  it("keeps a repository verified while its installation is active", async () => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace(SUBJECT);
    const rowId = await insertInstallation(workspaceId);
    await insertRepository(workspaceId, rowId, "rc_live");

    const response = await handleListRepositories(
      await requestAs(double, REPOSITORIES_URL),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      createAllowlistCache(),
    );

    const body = (await response.json()) as { repositories: { status: string }[] };
    expect(body.repositories.map((row) => row.status)).toEqual(["verified"]);
  });

  it("never lists another workspace's repository", async () => {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);
    const theirWorkspace = await seedWorkspace("user_someone_else");
    const theirRow = await insertInstallation(theirWorkspace, 7777);
    await insertRepository(theirWorkspace, theirRow, "rc_theirs");

    const response = await handleListRepositories(
      await requestAs(double, REPOSITORIES_URL),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      createAllowlistCache(),
    );

    expect(await response.json()).toEqual({ repositories: [] });
  });
});

describe("DELETE /api/repositories/:id and POST /api/repositories/:id/restore", () => {
  it("extracts the id from the two paths and nothing else", () => {
    expect(extractRemoveRepositoryId("/api/repositories/rc_1")).toBe("rc_1");
    expect(extractRemoveRepositoryId("/api/repositories")).toBeNull();
    expect(extractRemoveRepositoryId("/api/repositories/rc_1/restore")).toBeNull();
    expect(extractRestoreRepositoryId("/api/repositories/rc_1/restore")).toBe("rc_1");
    expect(extractRestoreRepositoryId("/api/repositories/rc_1")).toBeNull();
  });

  it("removes the caller's repository, lists it as removed, and restores it", async () => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace(SUBJECT);
    const rowId = await insertInstallation(workspaceId);
    await insertRepository(workspaceId, rowId, "rc_live");
    const settings = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT });

    const removed = await handleSetRepositoryRemoved(
      await requestAs(double, `${REPOSITORIES_URL}/rc_live`, "DELETE"),
      settings,
      "rc_live",
      true,
      createAllowlistCache(),
    );
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as { repository: { removedAt: string | null } };
    expect(typeof removedBody.repository.removedAt).toBe("string");

    const listed = (await (
      await handleListRepositories(
        await requestAs(double, REPOSITORIES_URL),
        settings,
        createAllowlistCache(),
      )
    ).json()) as { repositories: { removedAt: string | null; status: string }[] };
    expect(listed.repositories[0]?.removedAt).toBe(removedBody.repository.removedAt);
    // Removal is a preference, not a state: the row still reads verified.
    expect(listed.repositories[0]?.status).toBe("verified");

    const restored = await handleSetRepositoryRemoved(
      await requestAs(double, `${REPOSITORIES_URL}/rc_live/restore`, "POST"),
      settings,
      "rc_live",
      false,
      createAllowlistCache(),
    );
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { repository: { removedAt: null } }).repository.removedAt,
    ).toBe(null);
  });

  it("answers 404 for a repository that is not the caller's, and 401 unauthenticated", async () => {
    const double = await createClerkDouble();
    const other = await seedWorkspace("user_repos_other");
    const rowId = await insertInstallation(other, 4002);
    await insertRepository(other, rowId, "rc_theirs");
    await seedWorkspace(SUBJECT);

    const response = await handleSetRepositoryRemoved(
      await requestAs(double, `${REPOSITORIES_URL}/rc_theirs`, "DELETE"),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      "rc_theirs",
      true,
      createAllowlistCache(),
    );
    expect(response.status).toBe(404);
    const untouched = await env.DB.prepare(
      "SELECT removed_at FROM repository_connection WHERE repository_connection_id = 'rc_theirs'",
    ).first<{ removed_at: string | null }>();
    expect(untouched?.removed_at).toBeNull();

    const anonymous = await handleSetRepositoryRemoved(
      new Request(`${REPOSITORIES_URL}/rc_theirs`, { method: "DELETE" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      "rc_theirs",
      true,
      createAllowlistCache(),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("POST /api/github/install-url", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await handleCreateInstallUrl(
      new Request(INSTALL_URL_ROUTE, { method: "POST" }),
      envWith(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  // Every setting is required together: a missing client secret found at the
  // token exchange would already have sent the user to GitHub.
  it.each([
    "ONCUE_GITHUB_APP_SLUG",
    "ONCUE_GITHUB_APP_ID",
    "ONCUE_GITHUB_CLIENT_ID",
    "ONCUE_GITHUB_CLIENT_SECRET",
  ])("answers 503 when %s is missing", async (missing) => {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);

    const response = await handleCreateInstallUrl(
      await requestAs(double, INSTALL_URL_ROUTE, "POST"),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: SUBJECT,
        [missing]: undefined,
      }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "github_unconfigured" });
  });

  it("answers 503 when the keyring is unconfigured, so no state can be signed", async () => {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);

    const response = await handleCreateInstallUrl(
      await requestAs(double, INSTALL_URL_ROUTE, "POST"),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: SUBJECT,
        ONCUE_BROKER_KEYRING: undefined,
      }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
  });

  it("mints a URL carrying the App slug and a signed state", async () => {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);

    const response = await handleCreateInstallUrl(
      await requestAs(double, INSTALL_URL_ROUTE, "POST"),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(201);
    const { installUrl } = (await response.json()) as { installUrl: string };
    expect(installUrl).toContain("/apps/oncue-local/installations/new");
    expect(installUrl).toContain("state=ois1.");
  });

  // Fresh per click, which is why this is a route rather than a field on
  // `/api/me`: an unchanging value could be replayed.
  it("mints a different state on every call", async () => {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);
    const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT });
    const cache = createAllowlistCache();

    const read = async (): Promise<string> => {
      const response = await handleCreateInstallUrl(
        await requestAs(double, INSTALL_URL_ROUTE, "POST"),
        testEnv,
        cache,
      );
      return ((await response.json()) as { installUrl: string }).installUrl;
    };

    expect(await read()).not.toBe(await read());
  });
});

describe("GET /api/github/callback", () => {
  async function callback(query: string, overrides: Overrides = {}): Promise<Response> {
    const double = await createClerkDouble();
    await seedWorkspace(SUBJECT);
    return handleGitHubCallback(
      await requestAs(double, `${CALLBACK}${query}`),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: SUBJECT, ...overrides }),
      createAllowlistCache(),
    );
  }

  function reasonOf(response: Response): string | null {
    const location = response.headers.get("location") ?? "";
    return new URL(location, "https://oncue.example").searchParams.get("github");
  }

  it("refuses an unauthenticated caller rather than redirecting", async () => {
    const response = await handleGitHubCallback(
      new Request(`${CALLBACK}?code=c&state=s&installation_id=1`),
      envWith(),
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  // `setup_action=request`: an organization admin must approve, so there is no
  // code and nothing to link yet.
  it("reports pending approval for an organization install request", async () => {
    const response = await callback("?setup_action=request");

    expect(response.status).toBe(302);
    expect(reasonOf(response)).toBe("pending_approval");
  });

  it("reports cancelled when the user came back without a code", async () => {
    expect(reasonOf(await callback("?installation_id=4001"))).toBe("cancelled");
    expect(reasonOf(await callback("?code=c&installation_id=4001"))).toBe("cancelled");
  });

  // Not a positive integer, so not a redirect GitHub sent.
  it.each([
    ["absent", "?code=c&state=s"],
    ["not a number", "?code=c&state=s&installation_id=abc"],
    ["negative", "?code=c&state=s&installation_id=-1"],
    ["zero", "?code=c&state=s&installation_id=0"],
    ["fractional", "?code=c&state=s&installation_id=1.5"],
  ])("reports an invalid state when installation_id is %s", async (_name, query) => {
    expect(reasonOf(await callback(query))).toBe("state_invalid");
  });

  it("cannot complete when the deployment has no GitHub App", async () => {
    const response = await callback("?code=c&state=s&installation_id=4001", {
      ONCUE_GITHUB_CLIENT_SECRET: undefined,
    });

    expect(reasonOf(response)).toBe("exchange_failed");
  });

  // A state this control plane never signed. Both state refusals share one
  // reason so a stolen link's follower cannot learn it was genuine.
  it("reports an invalid state for a state this deployment did not sign", async () => {
    vi.stubGlobal("fetch", createGitHubDouble().fetchImpl);

    const response = await callback("?code=c&state=ois1.1.notreal.notreal&installation_id=4001", {
      ONCUE_GITHUB_API_ORIGIN: "https://github.double",
    });

    expect(reasonOf(response)).toBe("state_invalid");
  });

  it("never carries a token or a GitHub error body in the redirect", async () => {
    vi.stubGlobal("fetch", createGitHubDouble().fetchImpl);

    const response = await callback("?code=c&state=ois1.1.a.b&installation_id=4001", {
      ONCUE_GITHUB_API_ORIGIN: "https://github.double",
    });

    expect(await response.text()).toBe("");
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/repositories")).toBe(true);
    expect(/gh[supo]_/.test(location)).toBe(false);
  });
});
