import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { createGitHubDouble, githubTestSettings } from "../test/github-double";
import { handleSecretsRequest, matchSecretsRoute } from "./secrets";

const ORIGIN = "https://oncue.example";
const NOW = "2026-09-21T00:00:00.000Z";
const TOKENS_EXPIRE = "2099-01-01T00:00:00.000Z";
const OWNER = "user_secrets_owner";
const STRANGER = "user_secrets_stranger";

/** Obviously fake, and long enough for the redactor. */
const FAKE_VALUE = "fake-stripe-test-key-0001";

type Double = Awaited<ReturnType<typeof createClerkDouble>>;

function envFor(double: Double, subjects: string): Env {
  return { ...env, CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subjects } as unknown as Env;
}

async function requestAs(
  double: Double,
  subject: string | null,
  path: string,
  init: { method?: string; body?: unknown; rawBody?: string } = {},
): Promise<Request> {
  const headers = new Headers();
  if (subject !== null) {
    const authed = await double.requestAs(subject, `${ORIGIN}${path}`);
    headers.set("cookie", authed.headers.get("cookie") ?? "");
  }
  const body = init.rawBody ?? (init.body === undefined ? null : JSON.stringify(init.body));
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body });
}

async function seedRepository(subject: string, connectionId: string): Promise<string> {
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
       ) VALUES (?, ?, ?, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      installation,
      workspaceId,
      connectionId.length * 31 + 8000,
      // Fresh tokens and a recent verification, so `verifyInstallation` takes its
      // fast path; tests that need a refusal change the row.
      TOKENS_EXPIRE,
      TOKENS_EXPIRE,
      new Date().toISOString(),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme/widgets', 'main', 'verified', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(connectionId, workspaceId, installation, connectionId.length * 17 + 9100, NOW, NOW),
  ]);
  return workspaceId;
}

async function call(double: Double, request: Request, subjects = `${OWNER},${STRANGER}`) {
  const route = matchSecretsRoute(new URL(request.url).pathname, request.method);
  if (route === null) {
    throw new Error("the path did not match a secrets route");
  }
  return handleSecretsRequest(route, request, envFor(double, subjects), createAllowlistCache());
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM development_secret").run();
  await seedRepository(OWNER, "rpc_routes_mine");
  await seedRepository(STRANGER, "rpc_routes_theirs");
});

describe("matching", () => {
  it("matches the list, the save, and the delete, and nothing else", () => {
    expect(matchSecretsRoute("/api/repositories/rpc_1/secrets", "GET")).toEqual({
      kind: "list",
      repositoryConnectionId: "rpc_1",
    });
    expect(matchSecretsRoute("/api/repositories/rpc_1/secret-requests", "GET")).toEqual({
      kind: "requests",
      repositoryConnectionId: "rpc_1",
    });
    expect(matchSecretsRoute("/api/repositories/rpc_1/secret-requests", "PUT")).toBeNull();
    expect(matchSecretsRoute("/api/repositories/rpc_1/secrets/DATABASE_URL", "PUT")).toEqual({
      kind: "save",
      repositoryConnectionId: "rpc_1",
      name: "DATABASE_URL",
    });
    expect(matchSecretsRoute("/api/repositories/rpc_1/secrets/DATABASE_URL", "DELETE")).toEqual({
      kind: "delete",
      repositoryConnectionId: "rpc_1",
      name: "DATABASE_URL",
    });
    for (const [path, method] of [
      ["/api/repositories/rpc_1/secrets", "POST"],
      ["/api/repositories/rpc_1/secrets/DATABASE_URL", "GET"],
      ["/api/repositories/rpc_1/secrets/A/B", "PUT"],
      ["/api/repositories//secrets", "GET"],
      ["/api/repositories/rpc_1", "GET"],
      ["/api/repositories/%E0%A4%A/secrets", "GET"],
      ["/api/repositories/rpc_1/secrets/%E0%A4%A", "PUT"],
      ["/api/repositories/%E0%A4%A/secrets/NAME", "PUT"],
      ["/api/sessions", "PUT"],
      ["/api/sessions", "GET"],
    ] as const) {
      expect(matchSecretsRoute(path, method), `${method} ${path}`).toBeNull();
    }
  });
});

describe("authorization", () => {
  it("answers 401 with no session and 403 off the allowlist, before anything is read", async () => {
    const double = await createClerkDouble();
    const path = "/api/repositories/rpc_routes_mine/secrets";
    expect((await call(double, await requestAs(double, null, path))).status).toBe(401);
    expect((await call(double, await requestAs(double, OWNER, path), STRANGER)).status).toBe(403);
  });
});

describe("saving, listing, and deleting", () => {
  it("saves a value once and never returns it, in any response", async () => {
    const double = await createClerkDouble();
    const base = "/api/repositories/rpc_routes_mine/secrets";

    const saved = await call(
      double,
      await requestAs(double, OWNER, `${base}/STRIPE_TEST_KEY`, {
        method: "PUT",
        body: { value: FAKE_VALUE },
      }),
    );
    const savedText = await saved.text();
    expect(saved.status).toBe(200);
    expect(JSON.parse(savedText)).toMatchObject({
      secret: { name: "STRIPE_TEST_KEY", status: "active" },
    });

    const listed = await call(double, await requestAs(double, OWNER, base));
    const listedText = await listed.text();
    expect(JSON.parse(listedText).secrets).toMatchObject([{ name: "STRIPE_TEST_KEY" }]);

    const removed = await call(
      double,
      await requestAs(double, OWNER, `${base}/STRIPE_TEST_KEY`, { method: "DELETE" }),
    );
    const removedText = await removed.text();
    expect(removed.status).toBe(200);

    for (const text of [savedText, listedText, removedText]) {
      expect(text).not.toContain(FAKE_VALUE);
      expect(text).not.toContain("oncue1.");
    }
    expect(
      JSON.parse(await (await call(double, await requestAs(double, OWNER, base))).text()).secrets,
    ).toEqual([]);
  });

  it("answers 404 for a delete that removed nothing", async () => {
    const double = await createClerkDouble();
    const response = await call(
      double,
      await requestAs(double, OWNER, "/api/repositories/rpc_routes_mine/secrets/NEVER_SAVED", {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("refuses another workspace's repository as if it did not exist, for every verb", async () => {
    const double = await createClerkDouble();
    const theirs = "/api/repositories/rpc_routes_theirs/secrets";
    await call(
      double,
      await requestAs(double, STRANGER, `${theirs}/STRIPE_TEST_KEY`, {
        method: "PUT",
        body: { value: FAKE_VALUE },
      }),
    );

    const listed = await call(double, await requestAs(double, OWNER, theirs));
    expect(JSON.parse(await listed.text()).secrets).toEqual([]);
    const saved = await call(
      double,
      await requestAs(double, OWNER, `${theirs}/STRIPE_TEST_KEY`, {
        method: "PUT",
        body: { value: "fake-overwrite-attempt" },
      }),
    );
    expect(saved.status).toBe(404);
    const removed = await call(
      double,
      await requestAs(double, OWNER, `${theirs}/STRIPE_TEST_KEY`, { method: "DELETE" }),
    );
    expect(removed.status).toBe(404);
    // The stranger's value is untouched.
    const rows = await env.DB.prepare("SELECT name FROM development_secret").all();
    expect(rows.results).toEqual([{ name: "STRIPE_TEST_KEY" }]);
  });

  it.each([
    ["a malformed name", "lowercase", { value: FAKE_VALUE }, "name_malformed"],
    ["a reserved name", "NODE_OPTIONS", { value: FAKE_VALUE }, "name_reserved"],
    ["a platform credential", "GITHUB_TOKEN", { value: FAKE_VALUE }, "name_platform_credential"],
    ["a short value", "DATABASE_URL", { value: "short" }, "value_too_short"],
    [
      "a value with a newline",
      "DATABASE_URL",
      { value: "fake-value\nX=1" },
      "value_control_character",
    ],
    ["a missing value", "DATABASE_URL", {}, "value_missing"],
    ["a value that is not a string", "DATABASE_URL", { value: 12345678 }, "value_missing"],
  ])("refuses %s with 400 and echoes nothing it was sent", async (_label, name, body, reason) => {
    const double = await createClerkDouble();
    const response = await call(
      double,
      await requestAs(double, OWNER, `/api/repositories/rpc_routes_mine/secrets/${name}`, {
        method: "PUT",
        body,
      }),
    );
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "invalid_request", reason });
    expect(text).not.toContain("fake-value");
  });

  it("refuses a body that is not JSON", async () => {
    const double = await createClerkDouble();
    const response = await call(
      double,
      await requestAs(double, OWNER, "/api/repositories/rpc_routes_mine/secrets/DATABASE_URL", {
        method: "PUT",
        rawBody: "value=fake-not-json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("answers 503 when the keyring cannot be read, and stores nothing", async () => {
    const double = await createClerkDouble();
    const request = await requestAs(
      double,
      OWNER,
      "/api/repositories/rpc_routes_mine/secrets/DATABASE_URL",
      { method: "PUT", body: { value: FAKE_VALUE } },
    );
    const route = matchSecretsRoute(new URL(request.url).pathname, "PUT");
    const response = await handleSecretsRequest(
      route as NonNullable<typeof route>,
      request,
      { ...envFor(double, OWNER), ONCUE_BROKER_KEYRING: "not a keyring" } as unknown as Env,
      createAllowlistCache(),
    );
    expect(response.status).toBe(503);
    expect((await env.DB.prepare("SELECT 1 FROM development_secret").all()).results).toEqual([]);
  });
});

describe("what a repository asks for", () => {
  const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  const PATH = "/api/repositories/rpc_routes_mine/secret-requests";
  const RELEASE_SHA = "6".repeat(40);
  const FILE = "secrets:\n  required:\n    - DATABASE_URL\n  optional:\n    - STRIPE_TEST_KEY\n";

  /** The seeded repository row's GitHub ids, as `seedRepository` derives them. */
  const connectionId = "rpc_routes_mine";
  const installationId = connectionId.length * 31 + 8000;
  const repositoryId = connectionId.length * 17 + 9100;

  function github(file: string | null = FILE) {
    const double = createGitHubDouble({
      users: [{ id: 42, login: "octocat" }],
      installations: [
        {
          installationId,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue-local",
          visibleToUserIds: [42],
        },
      ],
      repositoriesByInstallation: {
        [installationId]: [{ id: repositoryId, fullName: "acme/widgets", defaultBranch: "main" }],
      },
      refsByRepository: { "acme/widgets": { main: BASE_SHA, "release/1.4": RELEASE_SHA } },
    });
    if (file !== null) {
      double.setFile("acme/widgets", ".oncue/project.yaml", file);
    }
    vi.stubGlobal("fetch", double.fetchImpl);
    return double;
  }

  async function ask(overrides: Record<string, string | undefined> = {}, path = PATH) {
    const clerk = await createClerkDouble();
    const request = await requestAs(clerk, OWNER, path);
    const route = matchSecretsRoute(new URL(request.url).pathname, "GET");
    const response = await handleSecretsRequest(
      route as NonNullable<typeof route>,
      request,
      {
        ...envFor(clerk, OWNER),
        ...(await githubTestSettings()),
        ONCUE_GITHUB_API_ORIGIN: "https://github.double",
        ...overrides,
      } as unknown as Env,
      createAllowlistCache(),
    );
    return { status: response.status, body: JSON.parse(await response.text()) };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups the names as the card shows them, pinned to the commit they were read at", async () => {
    github();
    const workspaceId = await deriveWorkspaceId(OWNER);
    await env.DB.prepare(
      `INSERT INTO development_secret (
         secret_id, workspace_id, repository_connection_id, name, value_reference, status, created_at, updated_at
       ) VALUES ('dsc_req', ?, 'rpc_routes_mine', 'DATABASE_URL', 'oncue1.1.n.v', 'active', ?, ?)`,
    )
      .bind(workspaceId, NOW, NOW)
      .run();

    expect(await ask()).toEqual({
      status: 200,
      body: {
        baseSha: BASE_SHA,
        state: "declared",
        required: [{ name: "DATABASE_URL", saved: true, isNew: false }],
        optional: [{ name: "STRIPE_TEST_KEY", saved: false, isNew: false }],
      },
    });
  });

  it("reads the card at the tip of the branch the session would start from", async () => {
    const double = github(null);
    double.setFile("acme/widgets", ".oncue/project.yaml", FILE, { ref: RELEASE_SHA });
    expect(await ask({}, `${PATH}?branch=release/1.4`)).toMatchObject({
      status: 200,
      body: { baseSha: RELEASE_SHA, state: "declared" },
    });
  });

  it("says a chosen branch is gone rather than unreadable, and refuses a name it cannot work with", async () => {
    github();
    expect(await ask({}, `${PATH}?branch=gone`)).toEqual({
      status: 409,
      body: { error: "branch_refused", reason: "missing" },
    });
    expect(await ask({}, `${PATH}?branch=${encodeURIComponent("has space")}`)).toEqual({
      status: 400,
      body: { error: "invalid_request", reason: "branch" },
    });
  });

  it("says when the repository asks for nothing", async () => {
    github(null);
    expect(await ask()).toEqual({ status: 200, body: { baseSha: BASE_SHA, state: "none" } });
  });

  it("shows a file the reader refuses with its line and reason", async () => {
    github("secrets:\n  required:\n    - GITHUB_TOKEN\n");
    expect(await ask()).toEqual({
      status: 200,
      body: {
        baseSha: BASE_SHA,
        state: "invalid",
        line: 3,
        reason: '"GITHUB_TOKEN" is a platform credential',
      },
    });
  });

  it("answers 502 when the file cannot be read, never an empty declaration", async () => {
    const double = github(null);
    double.setFile("acme/widgets", ".oncue/project.yaml", "elsewhere", { kind: "symlink" });
    expect(await ask()).toEqual({
      status: 502,
      body: { error: "unreadable", reason: "not_a_file" },
    });
  });

  it("answers 502 when GitHub cannot be reached for the branch", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    expect(await ask()).toEqual({ status: 502, body: { error: "unreadable", reason: "github" } });
  });

  it("answers 404 for another workspace's repository and 503 with no GitHub App configured", async () => {
    github();
    expect((await ask({}, "/api/repositories/rpc_routes_theirs/secret-requests")).status).toBe(404);
    expect((await ask({ ONCUE_GITHUB_APP_PRIVATE_KEY: undefined })).status).toBe(503);
  });

  // An installation the App no longer has: the mint gets 404, which must read
  // as "reconnect GitHub" rather than "couldn't read what this repository asks
  // for".
  describe("a GitHub connection that has to be reconnected", () => {
    // D1 is shared across this file's tests and the seed does not overwrite, so
    // each case restores the row.
    afterEach(async () => {
      await env.DB.prepare(
        `UPDATE github_installation
            SET status = 'active', github_installation_id = ?, last_verified_at = ?
          WHERE installation_row_id = 'ins_rpc_routes_mine'`,
      )
        .bind(installationId, new Date().toISOString())
        .run();
    });

    function logLines(spy: { mock: { calls: unknown[][] } }) {
      return spy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes("api.secret_requests.read"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    it("says reconnect GitHub when the installation is gone, and logs the mint's refusal", async () => {
      // The App's installation id in the row is one GitHub no longer has.
      const double = github();
      await env.DB.prepare(
        "UPDATE github_installation SET github_installation_id = 424242 WHERE installation_row_id = 'ins_rpc_routes_mine'",
      ).run();
      const spy = vi.spyOn(console, "log");

      expect(await ask()).toEqual({
        status: 409,
        body: { error: "github_reverification_required", reason: "installation_missing" },
      });
      const lines = logLines(spy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        severity: "warn",
        result: "reverification_required",
        errorCategory: "mint_rejected_404",
      });
      // Nothing about the repository or the request is in the line.
      expect(JSON.stringify(lines[0])).not.toContain("acme/widgets");
      expect(double.calls.some((call) => call.tokenRevoked === true)).toBe(false);
      spy.mockRestore();
    });

    it("refuses before minting when the installation needs verifying again", async () => {
      // Verified long ago, with a user token that cannot be opened: the
      // verification refuses and marks the row, and no token is minted.
      const double = github();
      await env.DB.prepare(
        "UPDATE github_installation SET last_verified_at = ? WHERE installation_row_id = 'ins_rpc_routes_mine'",
      )
        .bind(NOW)
        .run();
      const spy = vi.spyOn(console, "log");

      expect(await ask()).toEqual({
        status: 409,
        body: { error: "github_reverification_required", reason: "reverification_required" },
      });
      expect(logLines(spy)).toEqual([
        expect.objectContaining({
          result: "reverification_required",
          errorCategory: "installation_reverification_required",
        }),
      ]);
      expect(double.calls.filter((call) => call.path.includes("/access_tokens"))).toEqual([]);
      spy.mockRestore();
    });

    it("says reconnect GitHub for a repository whose installation is no longer active", async () => {
      github();
      await env.DB.prepare(
        "UPDATE github_installation SET status = 'deleted' WHERE installation_row_id = 'ins_rpc_routes_mine'",
      ).run();
      const spy = vi.spyOn(console, "log");

      expect(await ask()).toEqual({
        status: 409,
        body: { error: "github_reverification_required", reason: "not_connected" },
      });
      expect(logLines(spy)).toEqual([
        expect.objectContaining({ errorCategory: "repository_not_connected" }),
      ]);
      spy.mockRestore();
    });

    it("logs a read GitHub could not answer, with the category and no more", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
      const spy = vi.spyOn(console, "log");

      expect((await ask()).status).toBe(502);
      expect(logLines(spy)).toEqual([
        expect.objectContaining({ result: "unreadable", errorCategory: "mint_rejected_500" }),
      ]);
      spy.mockRestore();
    });

    it("logs a project file it could not read", async () => {
      const double = github(null);
      double.setFile("acme/widgets", ".oncue/project.yaml", "elsewhere", { kind: "symlink" });
      const spy = vi.spyOn(console, "log");

      expect((await ask()).status).toBe(502);
      expect(logLines(spy)).toEqual([
        expect.objectContaining({
          result: "unreadable",
          errorCategory: "declaration_not_a_file",
        }),
      ]);
      spy.mockRestore();
    });
  });
});
