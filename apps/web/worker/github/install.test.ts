import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { encodeBase64Url } from "../base64url";
import { deriveKeyring, type Keyring, openCredential } from "../broker/envelope";
import {
  createGitHubDouble,
  type GitHubDouble,
  type GitHubDoubleSeed,
} from "../test/github-double";
import { githubTokenContext } from "./envelope-context";
import {
  buildInstallUrl,
  type CompleteInstallOutcome,
  completeInstall,
  type GitHubInstallDeps,
  INSTALLATION_REVERIFY_INTERVAL_MS,
  REPOSITORIES_MAX_PAGES,
  REPOSITORIES_PAGE_SIZE,
  USER_TOKEN_REFRESH_MARGIN_MS,
  verifyInstallation,
} from "./install";
import { checkInstallState, type InstallStateSubject, mintInstallState } from "./install-state";
import { deriveInstallationRowId, listRepositoryConnections } from "./store";

const T0 = Date.parse("2026-09-05T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const USER = "usr_gh_install";
const OTHER_USER = "usr_gh_install_other";
const WORKSPACE = "wsp_gh_install";
const OTHER_WORKSPACE = "wsp_gh_install_other";
const SUBJECT: InstallStateSubject = { workspaceId: WORKSPACE, userId: USER };
const OTHER_SUBJECT: InstallStateSubject = { workspaceId: OTHER_WORKSPACE, userId: OTHER_USER };

const INSTALLATION_ID = 1001;
const OTHER_INSTALLATION_ID = 2002;
const GITHUB_USER_ID = 42;
const OTHER_GITHUB_USER_ID = 43;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const OTHER_REPO = { id: 502, fullName: "acme/gadgets", defaultBranch: "develop" };
const HIDDEN_REPO = { id: 601, fullName: "other/secret", defaultBranch: "main" };

const API_ORIGIN = "https://api.github.double";
const WEB_ORIGIN = "https://github.double";
const OAUTH_PATH = "/login/oauth/access_token";
const REPOSITORIES_PATH = `/user/installations/${INSTALLATION_ID}/repositories`;

// The user (42) sees installation 1001 and its two repositories; 2002 belongs
// to someone else and is what a spoofed redirect names. Two OAuth codes let a
// test run the flow twice without resetting the double.
function baseSeed(): GitHubDoubleSeed {
  return {
    users: [
      { id: GITHUB_USER_ID, login: "octocat" },
      { id: OTHER_GITHUB_USER_ID, login: "monalisa" },
    ],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue",
        visibleToUserIds: [GITHUB_USER_ID],
      },
      {
        installationId: OTHER_INSTALLATION_ID,
        account: { login: "other", type: "User" },
        appSlug: "oncue",
        visibleToUserIds: [OTHER_GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [REPO, OTHER_REPO],
      [OTHER_INSTALLATION_ID]: [HIDDEN_REPO],
    },
    oauthCodes: { "good-code": GITHUB_USER_ID, "second-code": GITHUB_USER_ID },
  };
}

function randomKeyText(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function keyringOf<P extends "credential" | "token">(purpose: P): Promise<Keyring<P>> {
  const result = await deriveKeyring(`1:${randomKeyText()}`, purpose);
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

interface Clock {
  ms: number;
}

interface Harness {
  deps: GitHubInstallDeps;
  readonly double: GitHubDouble;
  readonly clock: Clock;
}

async function harness(
  fetchWrap: (inner: typeof fetch) => typeof fetch = (f) => f,
): Promise<Harness> {
  const double = createGitHubDouble(baseSeed());
  const clock: Clock = { ms: T0 };
  let counter = 0;
  const deps: GitHubInstallDeps = {
    db: env.DB,
    credentialKeyring: await keyringOf("credential"),
    tokenKeyring: await keyringOf("token"),
    fetchImpl: fetchWrap(double.fetchImpl),
    apiOrigin: API_ORIGIN,
    webOrigin: WEB_ORIGIN,
    clientId: "Iv1.fakeclient",
    clientSecret: "fake-client-secret",
    release: "test",
    environment: "local",
    now: () => new Date(clock.ms).toISOString(),
    nowMs: () => clock.ms,
    newId: () => {
      counter += 1;
      return `rc_new_${counter}`;
    },
  };
  return { deps, double, clock };
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

/** Replace what one `method path` answers; everything else still reaches the double. */
function intercept(
  method: string,
  path: string,
  reply: () => Promise<Response>,
): (inner: typeof fetch) => typeof fetch {
  return (inner) => (input, init) => {
    const requestMethod = (init?.method ?? "GET").toUpperCase();
    if (requestMethod === method && urlOf(input).pathname === path) {
      return reply();
    }
    return inner(input, init);
  };
}

const rejecting = () => Promise.reject(new Error("connection reset"));
const answering = (status: number, body: string) => () =>
  Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));

async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(USER, new Date(T0).toISOString(), new Date(T0).toISOString()),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, USER, new Date(T0).toISOString(), new Date(T0).toISOString()),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_USER, new Date(T0).toISOString(), new Date(T0).toISOString()),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_WORKSPACE, OTHER_USER, new Date(T0).toISOString(), new Date(T0).toISOString()),
  ]);
}

interface InstallationRow {
  readonly status: string;
  readonly github_user_id: number;
  readonly account_login: string;
  readonly account_type: string;
  readonly user_token_reference: string;
  readonly refresh_token_reference: string;
  readonly user_token_expires_at: string;
  readonly refresh_token_expires_at: string;
  readonly last_verified_at: string;
}

async function installationRow(workspaceId = WORKSPACE): Promise<InstallationRow | null> {
  return env.DB.prepare(
    `SELECT status, github_user_id, account_login, account_type, user_token_reference,
            refresh_token_reference, user_token_expires_at, refresh_token_expires_at, last_verified_at
       FROM github_installation WHERE workspace_id = ?`,
  )
    .bind(workspaceId)
    .first<InstallationRow>();
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

async function identityOwner(githubUserId: number): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT user_id FROM external_identity WHERE provider = 'github' AND subject = ?",
  )
    .bind(String(githubUserId))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function install(
  h: Harness,
  overrides: Partial<{ code: string; installationId: number; subject: InstallStateSubject }> = {},
): Promise<CompleteInstallOutcome> {
  const subject = overrides.subject ?? SUBJECT;
  const state = await mintInstallState(h.deps.tokenKeyring, subject, h.clock.ms);
  return completeInstall(h.deps, subject, {
    code: overrides.code ?? "good-code",
    state,
    installationId: overrides.installationId ?? INSTALLATION_ID,
  });
}

function rowIdOf(): Promise<string> {
  return deriveInstallationRowId(WORKSPACE, INSTALLATION_ID);
}

let logSpy: MockInstance<typeof console.log>;

function loggedLines(): Record<string, unknown>[] {
  return logSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

beforeEach(async () => {
  await seedWorkspaces();
  await env.DB.prepare("DELETE FROM repository_connection").run();
  await env.DB.prepare("DELETE FROM github_installation").run();
  await env.DB.prepare("DELETE FROM external_identity WHERE provider = 'github'").run();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completeInstall", () => {
  it("links the installation, the identity, and the visible repositories, in record 07's order", async () => {
    const h = await harness();

    const outcome = await install(h);

    expect(outcome).toEqual({
      kind: "installed",
      installationRowId: await rowIdOf(),
      githubInstallationId: INSTALLATION_ID,
      githubUserId: GITHUB_USER_ID,
      accountLogin: "acme",
      repositories: [
        { githubRepositoryId: REPO.id, fullName: REPO.fullName, defaultBranch: REPO.defaultBranch },
        {
          githubRepositoryId: OTHER_REPO.id,
          fullName: OTHER_REPO.fullName,
          defaultBranch: OTHER_REPO.defaultBranch,
        },
      ],
    });
    expect(h.double.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${OAUTH_PATH}`,
      "GET /user",
      "GET /user/installations",
      `GET ${REPOSITORIES_PATH}`,
    ]);
    expect(h.double.calls.slice(1).every((call) => call.hadAuthorization)).toBe(true);

    const row = await installationRow();
    expect(row?.status).toBe("active");
    expect(row?.github_user_id).toBe(GITHUB_USER_ID);
    expect(row?.account_login).toBe("acme");
    expect(row?.account_type).toBe("Organization");
    expect(row?.user_token_expires_at).toBe(new Date(T0 + 28800 * 1000).toISOString());
    expect(row?.refresh_token_expires_at).toBe(new Date(T0 + 15897600 * 1000).toISOString());
    expect(row?.last_verified_at).toBe(new Date(T0).toISOString());
    expect(await identityOwner(GITHUB_USER_ID)).toBe(USER);
    const repositories = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(repositories.map((r) => [r.fullName, r.status])).toEqual([
      [OTHER_REPO.fullName, "verified"],
      [REPO.fullName, "verified"],
    ]);
  });

  it("stores both tokens as oncue1 envelopes that open only under their own context, never as text", async () => {
    const h = await harness();
    await install(h);

    const row = await installationRow();
    expect(row?.user_token_reference.startsWith("oncue1.")).toBe(true);
    expect(row?.refresh_token_reference.startsWith("oncue1.")).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/gh[ur]_/);

    const rowId = await rowIdOf();
    const user = await openCredential(
      h.deps.credentialKeyring,
      githubTokenContext(rowId, WORKSPACE, "user_token"),
      row?.user_token_reference ?? "",
    );
    const refresh = await openCredential(
      h.deps.credentialKeyring,
      githubTokenContext(rowId, WORKSPACE, "refresh_token"),
      row?.refresh_token_reference ?? "",
    );
    expect(user.kind === "ok" && user.plaintext.startsWith("ghu_")).toBe(true);
    expect(refresh.kind === "ok" && refresh.plaintext.startsWith("ghr_")).toBe(true);
  });

  it("returns no plaintext token from any function", async () => {
    const h = await harness();

    const installed = await install(h);
    h.clock.ms = T0 + 9 * HOUR;
    const verified = await verifyInstallation(h.deps, WORKSPACE, await rowIdOf());
    const url = await buildInstallUrl(h.deps, SUBJECT, "oncue");

    expect(JSON.stringify({ installed, verified, url })).not.toMatch(/gh[ur]_/);
    expect(JSON.stringify(h.double.calls)).not.toMatch(/gh[ur]_/);
  });

  it("refuses a state it did not mint, before any request is made", async () => {
    const h = await harness();

    const outcome = await completeInstall(h.deps, SUBJECT, {
      code: "good-code",
      state: "ois1.1.notreally.signed",
      installationId: INSTALLATION_ID,
    });

    expect(outcome).toEqual({ kind: "refused", reason: "state_rejected" });
    expect(h.double.calls).toHaveLength(0);
    expect(await countRows("github_installation")).toBe(0);
  });

  it("refuses a state signed for another workspace, so a minted state cannot be replayed into someone else's", async () => {
    const h = await harness();
    const state = await mintInstallState(h.deps.tokenKeyring, OTHER_SUBJECT, h.clock.ms);

    const outcome = await completeInstall(h.deps, SUBJECT, {
      code: "good-code",
      state,
      installationId: INSTALLATION_ID,
    });

    expect(outcome).toEqual({ kind: "refused", reason: "state_not_callers" });
    expect(h.double.calls).toHaveLength(0);
    expect(await countRows("github_installation")).toBe(0);
  });

  it("refuses a code GitHub rejects with its 200-status error body, and writes nothing", async () => {
    const h = await harness();

    const outcome = await install(h, { code: "never-issued" });

    expect(outcome).toEqual({ kind: "refused", reason: "code_rejected" });
    expect(h.double.calls.map((call) => call.path)).toEqual([OAUTH_PATH]);
    expect(await countRows("github_installation")).toBe(0);
    expect(await identityOwner(GITHUB_USER_ID)).toBeNull();
  });

  it("refuses a reused code the same way", async () => {
    const h = await harness();
    await install(h);

    const outcome = await install(h);

    expect(outcome).toEqual({ kind: "refused", reason: "code_rejected" });
  });

  it("links nothing for a spoofed installation_id, and logs the line the end-to-end test greps for", async () => {
    const h = await harness();

    const outcome = await install(h, { installationId: OTHER_INSTALLATION_ID });

    expect(outcome).toEqual({ kind: "refused", reason: "installation_not_visible" });
    expect(h.double.calls.map((call) => call.path)).toEqual([
      OAUTH_PATH,
      "/user",
      "/user/installations",
    ]);
    expect(await countRows("github_installation")).toBe(0);
    expect(await countRows("repository_connection")).toBe(0);
    expect(await identityOwner(GITHUB_USER_ID)).toBeNull();
    expect(loggedLines()).toEqual([
      {
        timestamp: new Date(T0).toISOString(),
        severity: "warn",
        service: "web-worker",
        release: "test",
        environment: "local",
        operation: "github.install",
        result: "installation not visible to user",
      },
    ]);
  });

  it("does not link a repository the user cannot see through the installation", async () => {
    const h = await harness();

    await install(h);

    const names = (await listRepositoryConnections(env.DB, WORKSPACE)).map((r) => r.fullName);
    expect(names).not.toContain(HIDDEN_REPO.fullName);
    expect(names).toHaveLength(2);
  });

  it("refuses when the GitHub account is already another OnCue user's identity, and writes no installation", async () => {
    const h = await harness();
    await env.DB.prepare(
      `INSERT INTO external_identity (provider, subject, user_id, created_at)
       VALUES ('github', ?, ?, ?)`,
    )
      .bind(String(GITHUB_USER_ID), OTHER_USER, new Date(T0).toISOString())
      .run();

    const outcome = await install(h);

    expect(outcome).toEqual({ kind: "refused", reason: "identity_linked_to_another_user" });
    expect(await identityOwner(GITHUB_USER_ID)).toBe(OTHER_USER);
    expect(await countRows("github_installation")).toBe(0);
    expect(await countRows("repository_connection")).toBe(0);
  });

  it("re-running the flow refreshes the one row and disconnects repositories no longer authorized", async () => {
    const h = await harness();
    await install(h);
    h.double.setState({
      ...baseSeed(),
      repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
    });
    await env.DB.prepare("UPDATE github_installation SET status = 'unauthorized'").run();

    const outcome = await install(h, { code: "second-code" });

    expect(outcome.kind).toBe("installed");
    expect(await countRows("github_installation")).toBe(1);
    expect((await installationRow())?.status).toBe("active");
    const repositories = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(repositories.map((r) => [r.fullName, r.status])).toEqual([
      [OTHER_REPO.fullName, "disconnected"],
      [REPO.fullName, "verified"],
    ]);
  });

  it("reads only the installation the redirect named, tolerating unreadable neighbours in the list", async () => {
    const h = await harness(
      intercept(
        "GET",
        "/user/installations",
        answering(
          200,
          JSON.stringify({
            installations: [
              "not an object",
              { id: 9, account: null },
              { id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } },
            ],
          }),
        ),
      ),
    );

    const outcome = await install(h);

    expect(outcome.kind).toBe("installed");
  });

  describe("a listing longer than one page", () => {
    const pageOf = (start: number, count: number) => ({
      total_count: 0,
      repositories: Array.from({ length: count }, (_, index) => ({
        id: start + index,
        full_name: `acme/repo-${start + index}`,
        default_branch: "main",
      })),
    });
    /** Answers the repositories path per page; other paths reach the double. */
    const paged =
      (answers: Record<number, () => Promise<Response>>) =>
      (inner: typeof fetch): typeof fetch =>
      (input, init) => {
        const url = urlOf(input);
        if (url.pathname === REPOSITORIES_PATH) {
          const page = Number(url.searchParams.get("page") ?? "1");
          const answer = answers[page];
          if (answer !== undefined) {
            return answer();
          }
        }
        return inner(input, init);
      };
    const json = (body: unknown) => answering(200, JSON.stringify(body));

    it("reads every page until one comes back short", async () => {
      const h = await harness(
        paged({
          1: json(pageOf(1, REPOSITORIES_PAGE_SIZE)),
          2: json(pageOf(1 + REPOSITORIES_PAGE_SIZE, 1)),
        }),
      );
      expect((await install(h)).kind).toBe("installed");
      expect(await countRows("repository_connection")).toBe(REPOSITORIES_PAGE_SIZE + 1);
      expect(h.double.calls.filter((call) => call.path === REPOSITORIES_PATH)).toHaveLength(0);
    });

    it("a later page that is unreachable fails the whole listing", async () => {
      const h = await harness(paged({ 1: json(pageOf(1, REPOSITORIES_PAGE_SIZE)), 2: rejecting }));
      expect(await install(h)).toEqual({ kind: "failed", category: "unreachable", status: null });
      expect(await countRows("repository_connection")).toBe(0);
    });

    it("a later page that is malformed fails the whole listing", async () => {
      const h = await harness(
        paged({ 1: json(pageOf(1, REPOSITORIES_PAGE_SIZE)), 2: json({ repositories: "none" }) }),
      );
      expect(await install(h)).toEqual({
        kind: "failed",
        category: "malformed_response",
        status: 200,
      });
    });

    it("stops at the page cap rather than looping on a listing that never comes back short", async () => {
      let pages = 0;
      const h = await harness((inner) => (input, init) => {
        const url = urlOf(input);
        if (url.pathname === REPOSITORIES_PATH) {
          pages += 1;
          return json(pageOf(pages * REPOSITORIES_PAGE_SIZE, REPOSITORIES_PAGE_SIZE))();
        }
        return inner(input, init);
      });
      expect((await install(h)).kind).toBe("installed");
      expect(pages).toBe(REPOSITORIES_MAX_PAGES);
      expect(await countRows("repository_connection")).toBe(
        REPOSITORIES_MAX_PAGES * REPOSITORIES_PAGE_SIZE,
      );
    });
  });

  describe("upstream failures", () => {
    const steps: readonly [string, string][] = [
      ["POST", OAUTH_PATH],
      ["GET", "/user"],
      ["GET", "/user/installations"],
      ["GET", REPOSITORIES_PATH],
    ];

    for (const [method, path] of steps) {
      it(`${method} ${path}: unreachable`, async () => {
        const h = await harness(intercept(method, path, rejecting));
        expect(await install(h)).toEqual({ kind: "failed", category: "unreachable", status: null });
        expect(await countRows("github_installation")).toBe(0);
      });

      it(`${method} ${path}: non-200`, async () => {
        const h = await harness(intercept(method, path, answering(503, "{}")));
        expect(await install(h)).toEqual({ kind: "failed", category: "rejected", status: 503 });
      });

      it(`${method} ${path}: not JSON`, async () => {
        const h = await harness(intercept(method, path, answering(200, "<html>")));
        expect(await install(h)).toEqual({
          kind: "failed",
          category: "malformed_response",
          status: 200,
        });
      });
    }

    const malformedBodies: readonly [string, string, unknown][] = [
      ["POST", OAUTH_PATH, []],
      ["POST", OAUTH_PATH, {}],
      ["POST", OAUTH_PATH, { access_token: "ghu_x" }],
      ["POST", OAUTH_PATH, { access_token: "ghu_x", refresh_token: "ghr_x" }],
      ["POST", OAUTH_PATH, { access_token: "ghu_x", refresh_token: "ghr_x", expires_in: 1 }],
      ["GET", "/user", []],
      ["GET", "/user", { login: "octocat" }],
      ["GET", "/user", { id: GITHUB_USER_ID }],
      ["GET", "/user/installations", []],
      ["GET", "/user/installations", { installations: "none" }],
      ["GET", "/user/installations", { installations: [{ id: INSTALLATION_ID }] }],
      [
        "GET",
        "/user/installations",
        { installations: [{ id: INSTALLATION_ID, account: { type: "User" } }] },
      ],
      [
        "GET",
        "/user/installations",
        { installations: [{ id: INSTALLATION_ID, account: { login: "acme" } }] },
      ],
      [
        "GET",
        "/user/installations",
        { installations: [{ id: INSTALLATION_ID, account: { login: "acme", type: "Bot" } }] },
      ],
      ["GET", REPOSITORIES_PATH, []],
      ["GET", REPOSITORIES_PATH, { repositories: "none" }],
      ["GET", REPOSITORIES_PATH, { repositories: ["not an object"] }],
      ["GET", REPOSITORIES_PATH, { repositories: [{ full_name: "a/b", default_branch: "main" }] }],
      ["GET", REPOSITORIES_PATH, { repositories: [{ id: 1, default_branch: "main" }] }],
      ["GET", REPOSITORIES_PATH, { repositories: [{ id: 1, full_name: "a/b" }] }],
    ];

    for (const [method, path, body] of malformedBodies) {
      it(`${method} ${path}: shape ${JSON.stringify(body)} is a malformed response`, async () => {
        const h = await harness(intercept(method, path, answering(200, JSON.stringify(body))));
        expect(await install(h)).toEqual({
          kind: "failed",
          category: "malformed_response",
          status: 200,
        });
        expect(await countRows("github_installation")).toBe(0);
      });
    }
  });
});

describe("verifyInstallation", () => {
  async function installed(): Promise<Harness & { readonly rowId: string }> {
    const h = await harness();
    const outcome = await install(h);
    if (outcome.kind !== "installed") {
      throw new Error(`expected installed, got ${outcome.kind}`);
    }
    return { ...h, rowId: outcome.installationRowId };
  }

  function callsSince(h: Harness, from: number): string[] {
    return h.double.calls.slice(from).map((call) => `${call.method} ${call.path}`);
  }

  async function backdateVerification(): Promise<void> {
    await env.DB.prepare("UPDATE github_installation SET last_verified_at = ?")
      .bind(new Date(T0 - 9 * HOUR).toISOString())
      .run();
  }

  it("refuses an installation this workspace does not hold, making no request", async () => {
    const h = await installed();

    const outcome = await verifyInstallation(h.deps, OTHER_WORKSPACE, h.rowId);

    expect(outcome).toEqual({ kind: "refused", reason: "not_found" });
    expect(callsSince(h, 4)).toEqual([]);
  });

  it("refuses a row that is not active without rewriting the reason it already records", async () => {
    const h = await installed();
    await env.DB.prepare("UPDATE github_installation SET status = 'suspended'").run();

    const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

    expect(outcome).toEqual({ kind: "refused", reason: "reverification_required" });
    expect((await installationRow())?.status).toBe("suspended");
    expect(callsSince(h, 4)).toEqual([]);
  });

  it("answers from the row inside the eight-hour window, with no network call", async () => {
    const h = await installed();
    h.clock.ms = T0 + HOUR;

    const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

    expect(outcome.kind).toBe("verified");
    expect(outcome.kind === "verified" && outcome.installation.lastVerifiedAt).toBe(
      new Date(T0).toISOString(),
    );
    expect(callsSince(h, 4)).toEqual([]);
    expect(INSTALLATION_REVERIFY_INTERVAL_MS).toBe(8 * HOUR);
  });

  it("past the window with a fresh token, confirms through /user/installations without a refresh", async () => {
    const h = await installed();
    const before = await installationRow();
    await backdateVerification();
    h.clock.ms = T0 + HOUR;

    const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

    expect(outcome.kind).toBe("verified");
    expect(callsSince(h, 4)).toEqual(["GET /user/installations"]);
    const after = await installationRow();
    expect(after?.last_verified_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(after?.user_token_reference).toBe(before?.user_token_reference);
    expect(outcome.kind === "verified" && outcome.installation.lastVerifiedAt).toBe(
      new Date(T0 + HOUR).toISOString(),
    );
  });

  it("past the window with an expired token, refreshes the pair and then confirms", async () => {
    const h = await installed();
    const before = await installationRow();
    h.clock.ms = T0 + 9 * HOUR;

    const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

    expect(outcome.kind).toBe("verified");
    expect(callsSince(h, 4)).toEqual([`POST ${OAUTH_PATH}`, "GET /user/installations"]);
    const after = await installationRow();
    expect(after?.status).toBe("active");
    expect(after?.user_token_reference).not.toBe(before?.user_token_reference);
    expect(after?.refresh_token_reference).not.toBe(before?.refresh_token_reference);
    expect(after?.user_token_expires_at).toBe(new Date(T0 + 9 * HOUR + 28800 * 1000).toISOString());
    expect(after?.last_verified_at).toBe(new Date(T0 + 9 * HOUR).toISOString());
    expect(after?.user_token_reference.startsWith("oncue1.")).toBe(true);

    const opened = await openCredential(
      h.deps.credentialKeyring,
      githubTokenContext(h.rowId, WORKSPACE, "user_token"),
      after?.user_token_reference ?? "",
    );
    expect(opened.kind === "ok" && opened.plaintext.startsWith("ghu_")).toBe(true);
  });

  it("inside the window but near token expiry, refreshes rather than handing out a token about to die", async () => {
    const h = await installed();
    h.clock.ms = T0 + 8 * HOUR - USER_TOKEN_REFRESH_MARGIN_MS + 1;

    const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

    expect(outcome.kind).toBe("verified");
    expect(callsSince(h, 4)).toEqual([`POST ${OAUTH_PATH}`, "GET /user/installations"]);
  });

  describe("every failure sets the row unauthorized and refuses (record 07 step 8)", () => {
    async function expectDisabled(
      h: Harness & { readonly rowId: string },
      errorCategory: string,
    ): Promise<void> {
      const outcome = await verifyInstallation(h.deps, WORKSPACE, h.rowId);

      expect(outcome).toEqual({ kind: "refused", reason: "reverification_required" });
      expect((await installationRow())?.status).toBe("unauthorized");
      expect(loggedLines()).toEqual([
        {
          timestamp: new Date(h.clock.ms).toISOString(),
          severity: "warn",
          service: "web-worker",
          release: "test",
          environment: "local",
          operation: "github.verify",
          result: "reverification required",
          errorCategory,
        },
      ]);
    }

    it("the refresh token GitHub no longer honours", async () => {
      const h = await installed();
      h.double.setState(baseSeed());
      h.clock.ms = T0 + 9 * HOUR;

      await expectDisabled(h, "refresh_rejected");
      expect(callsSince(h, 4)).toEqual([`POST ${OAUTH_PATH}`]);
    });

    it("the refresh token's own expiry has passed, without asking GitHub", async () => {
      const h = await installed();
      await env.DB.prepare("UPDATE github_installation SET refresh_token_expires_at = ?")
        .bind(new Date(T0 + HOUR).toISOString())
        .run();
      h.clock.ms = T0 + 9 * HOUR;

      await expectDisabled(h, "refresh_token_expired");
      expect(callsSince(h, 4)).toEqual([]);
    });

    it("the token endpoint is unreachable during a refresh", async () => {
      const h = await installed();
      h.deps = {
        ...h.deps,
        fetchImpl: intercept("POST", OAUTH_PATH, rejecting)(h.double.fetchImpl),
      };
      h.clock.ms = T0 + 9 * HOUR;

      await expectDisabled(h, "unreachable");
    });

    it("the sealed refresh token does not open under its context", async () => {
      const h = await installed();
      await env.DB.prepare(
        "UPDATE github_installation SET refresh_token_reference = user_token_reference",
      ).run();
      h.clock.ms = T0 + 9 * HOUR;

      await expectDisabled(h, "envelope_tampered");
      expect(callsSince(h, 4)).toEqual([]);
    });

    it("the sealed user token does not open under its context", async () => {
      const h = await installed();
      await env.DB.prepare(
        "UPDATE github_installation SET user_token_reference = refresh_token_reference",
      ).run();
      await backdateVerification();
      h.clock.ms = T0 + HOUR;

      await expectDisabled(h, "envelope_tampered");
      expect(callsSince(h, 4)).toEqual([]);
    });

    it("GitHub is unreachable for the installations check", async () => {
      const h = await installed();
      h.deps = {
        ...h.deps,
        fetchImpl: intercept("GET", "/user/installations", rejecting)(h.double.fetchImpl),
      };
      await backdateVerification();
      h.clock.ms = T0 + HOUR;

      await expectDisabled(h, "unreachable");
    });

    it("the installations list is not a shape this module reads", async () => {
      const h = await installed();
      h.deps = {
        ...h.deps,
        fetchImpl: intercept(
          "GET",
          "/user/installations",
          answering(200, "[]"),
        )(h.double.fetchImpl),
      };
      await backdateVerification();
      h.clock.ms = T0 + HOUR;

      await expectDisabled(h, "malformed_response");
    });

    it("the user no longer sees the installation", async () => {
      const h = await installed();
      h.deps = {
        ...h.deps,
        fetchImpl: intercept(
          "GET",
          "/user/installations",
          answering(200, JSON.stringify({ total_count: 0, installations: [] })),
        )(h.double.fetchImpl),
      };
      await backdateVerification();
      h.clock.ms = T0 + HOUR;

      await expectDisabled(h, "installation_not_visible");
    });

    it("reconnecting afterwards sets the row active again", async () => {
      const h = await installed();
      h.double.setState(baseSeed());
      h.clock.ms = T0 + 9 * HOUR;
      await verifyInstallation(h.deps, WORKSPACE, h.rowId);
      expect((await installationRow())?.status).toBe("unauthorized");

      const outcome = await install(h, { code: "second-code" });

      expect(outcome.kind).toBe("installed");
      expect((await installationRow())?.status).toBe("active");
      expect((await verifyInstallation(h.deps, WORKSPACE, h.rowId)).kind).toBe("verified");
    });
  });
});

describe("buildInstallUrl", () => {
  it("points at the App's install page with a state that verifies for the subject", async () => {
    const h = await harness();

    const url = await buildInstallUrl(h.deps, SUBJECT, "oncue");

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${WEB_ORIGIN}/apps/oncue/installations/new`);
    const state = parsed.searchParams.get("state") ?? "";
    const check = await checkInstallState(h.deps.tokenKeyring, state, h.clock.ms);
    expect(check.kind === "valid" && check.claims.workspaceId).toBe(WORKSPACE);
    expect(check.kind === "valid" && check.claims.userId).toBe(USER);
  });

  it("mints a fresh state per call", async () => {
    const h = await harness();

    const first = await buildInstallUrl(h.deps, SUBJECT, "oncue");
    const second = await buildInstallUrl(h.deps, SUBJECT, "oncue");

    expect(first).not.toBe(second);
  });
});
