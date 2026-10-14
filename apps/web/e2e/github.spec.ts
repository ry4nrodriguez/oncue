import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { signWebhook } from "../worker/test/github-double";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import {
  GITHUB_DOUBLE_ORIGIN,
  type RunningGitHubDouble,
  startGitHubDouble,
} from "./github-double-server";
import { laneIdentity, laneNoModelConnectionStatement } from "./lane-auth";
import { laneModalConnectionStatements } from "./lane-modal";
import { queryD1, queryD1Batch } from "./local-d1";
import { pinSessionDetails } from "./session-details";

/**
 * GitHub connection against the real Worker over HTTP, authenticated like
 * `broker.spec.ts` with a real RS256 Clerk token, so there is no test bypass.
 * `ONCUE_GITHUB_API_ORIGIN` points the Worker at `e2e/github-double-server.ts`,
 * and the first test proves it before anything is sent.
 */

let ORIGIN = DEFAULT_APP_ORIGIN;
const SHOTS = "/tmp/pr07-lanes";

const INSTALLATION_ID = 4001;
const OTHER_INSTALLATION_ID = 8002;
const REPO_ID = 501;
const SECOND_REPO_ID = 502;
const GITHUB_USER_ID = 42;
const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";

let double: RunningGitHubDouble | undefined;

const WEBHOOK_SECRET = devVar("ONCUE_GITHUB_WEBHOOK_SECRET");

/**
 * Read from the `.dev.vars` the Worker reads, so webhooks are signed with the
 * secret the Worker verifies against.
 */
function devVar(name: string): string {
  const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0 && line.slice(0, separator) === name) {
      return line.slice(separator + 1);
    }
  }
  throw new Error(
    `${name} is not in apps/web/.dev.vars; run \`node apps/web/e2e/setup-local-auth.mjs\` and restart the dev server`,
  );
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: laneIdentity(ORIGIN).cookie, ...extra };
}

/** One retry after a short pause when a request is dropped, bounded so a dead server still fails the test. */
async function settledFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return fetch(url, init);
  }
}

/**
 * The Worker's own log lines, from the Cloudflare Vite plugin's local
 * observability store. An absent row alone cannot tell a refusal from a broken
 * flow; the log line names why nothing was linked.
 */
async function workerLogLines(contains: string): Promise<string[]> {
  const answer = await settledFetch(
    `${ORIGIN}/cdn-cgi/local/explorer/api/local/observability/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT message FROM logs WHERE message LIKE '%${contains}%' LIMIT 20`,
      }),
    },
  );
  const parsed = (await answer.json()) as { result?: { rows?: string[][] } };
  // The store keeps each line JSON-escaped, so unescape once to get the line
  // the Worker wrote.
  return (parsed.result?.rows ?? []).map((row) => (row.at(0) ?? "").replaceAll('\\"', '"'));
}

/**
 * How many lines in the Worker's local log store contain `contains`. Counted,
 * not listed: `workerLogLines` reads at most 20, and the store keeps earlier
 * runs' lines.
 */
async function workerLogCount(contains: string): Promise<number> {
  const answer = await settledFetch(
    `${ORIGIN}/cdn-cgi/local/explorer/api/local/observability/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT COUNT(*) FROM logs WHERE message LIKE '%${contains}%'`,
      }),
    },
  );
  const parsed = (await answer.json()) as { result?: { rows?: (string | number)[][] } };
  return Number(parsed.result?.rows?.at(0)?.at(0) ?? 0);
}

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly hadAuthorization: boolean;
  readonly atMs: number;
  readonly tokenNarrowing?: { repositoryIds: number[]; permissions: Record<string, string> };
  readonly tokenRevoked?: boolean;
}

async function doubleCalls(): Promise<RecordedCall[]> {
  const answer = await fetch(`${GITHUB_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedCall[] }).calls;
}

async function resetDouble(): Promise<void> {
  await fetch(`${GITHUB_DOUBLE_ORIGIN}/__reset`, { method: "POST" });
  await fetch(`${GITHUB_DOUBLE_ORIGIN}/__mode`, {
    method: "POST",
    body: JSON.stringify({ mode: "ok" }),
  });
}

/**
 * The double's world: one installation the test's GitHub user can see, one it
 * cannot (the spoof target), two repositories, and a `main` ref.
 */
async function seedDouble(): Promise<void> {
  await fetch(`${GITHUB_DOUBLE_ORIGIN}/__state`, {
    method: "POST",
    body: JSON.stringify({
      users: [{ id: GITHUB_USER_ID, login: "octocat" }],
      installations: [
        {
          installationId: INSTALLATION_ID,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue-local",
          visibleToUserIds: [GITHUB_USER_ID],
        },
        {
          installationId: OTHER_INSTALLATION_ID,
          account: { login: "someone-else", type: "User" },
          appSlug: "oncue-local",
          // Not visible to the test's user (record 07).
          visibleToUserIds: [],
        },
      ],
      repositoriesByInstallation: {
        [INSTALLATION_ID]: [
          { id: REPO_ID, fullName: "acme/widgets", defaultBranch: "main" },
          { id: SECOND_REPO_ID, fullName: "acme/legacy", defaultBranch: "main" },
        ],
      },
      refsByRepository: { "acme/widgets": { main: BASE_SHA }, "acme/legacy": { main: BASE_SHA } },
      oauthCodes: { "lane-code": GITHUB_USER_ID, "lane-code-2": GITHUB_USER_ID },
    }),
  });
}

/**
 * Clears every GitHub row and every row that references one, reading the
 * tables from the schema (`e2e/cascade-delete.ts`). Only sessions that point at
 * a repository connection go, because `broker.spec.ts` shares this D1 and
 * inserts its own session rows.
 */
async function clearGitHubRows(): Promise<void> {
  await cascadeDelete(
    [{ table: "github_installation" }, { table: "webhook_delivery" }],
    queryD1Batch,
  );
  await queryD1("DELETE FROM external_identity WHERE provider = 'github'");
}

/**
 * Completes the install flow through the real callback route, with the state
 * from the real `POST /api/github/install-url`, so the rows are genuine.
 */
async function completeInstall(
  code = "lane-code",
  installationId = INSTALLATION_ID,
): Promise<number> {
  const minted = await settledFetch(`${ORIGIN}/api/github/install-url`, {
    method: "POST",
    headers: authed(),
  });
  const { installUrl } = (await minted.json()) as { installUrl: string };
  const state = new URL(installUrl).searchParams.get("state") ?? "";

  const callback = await settledFetch(
    `${ORIGIN}/api/github/callback?code=${code}&state=${encodeURIComponent(state)}&installation_id=${installationId}`,
    { headers: authed(), redirect: "manual" },
  );
  return callback.status;
}

async function repositories(): Promise<{ fullName: string; status: string }[]> {
  const answer = await settledFetch(`${ORIGIN}/api/repositories`, { headers: authed() });
  return ((await answer.json()) as { repositories: { fullName: string; status: string }[] })
    .repositories;
}

async function postWebhook(
  eventName: string,
  payload: unknown,
  options: { deliveryId?: string; signature?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(payload);
  const response = await settledFetch(`${ORIGIN}/api/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventName,
      "x-github-delivery": options.deliveryId ?? `lane-${crypto.randomUUID()}`,
      "x-hub-signature-256": options.signature ?? (await signWebhook(WEBHOOK_SECRET, body)),
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function createSession(body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await settledFetch(`${ORIGIN}/api/sessions`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function newCommandId(): string {
  return `lane_${crypto.randomUUID()}`;
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  ORIGIN = await appOrigin();
  double = await startGitHubDouble();
  // Some tests create sessions, which need a Modal connection. They name no
  // model connection, which only a workspace with no active one allows.
  await queryD1([...(await laneModalConnectionStatements()), laneNoModelConnectionStatement()]);
});

test.afterAll(async () => {
  // Optional: `beforeAll` can fail before assigning it, and an unguarded close
  // would hide the real error behind a teardown one.
  await double?.close();
});

test.describe.configure({ mode: "serial" });

/**
 * Runs before every other test and prevents rather than detects: a
 * misconfigured origin would reach real GitHub before any assertion ran.
 */
test("guard: the Worker points at the GitHub double, checked BEFORE anything is sent", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();

  const status = await completeInstall();
  expect(status, "the install callback did not redirect").toBe(302);

  const calls = await doubleCalls();
  expect(
    calls.length,
    "the Worker reached NO double, so ONCUE_GITHUB_API_ORIGIN is not in effect. Run `node apps/web/e2e/setup-local-auth.mjs` and restart the dev server before running any GitHub lane.",
  ).toBeGreaterThan(0);
  expect(calls.some((call) => call.path === "/login/oauth/access_token")).toBe(true);
});

test("a session with no repository still works", async ({ page, context }) => {
  await clearGitHubRows();

  const created = await createSession({
    commandId: newCommandId(),
    instruction: { messageId: "m1", text: "no repository here", attachments: [] },
  });

  expect(created.status).toBe(201);
  expect(created.body.sessionId).toBeDefined();
  const rows = await queryD1<{
    task_branch: string | null;
    repository_connection_id: string | null;
  }>(
    `SELECT task_branch, repository_connection_id FROM session_index WHERE session_id = '${String(created.body.sessionId)}'`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.task_branch).toBeNull();
  expect(rows[0]?.repository_connection_id).toBeNull();

  // A session with no repository says so on the rail.
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/sessions/${String(created.body.sessionId)}`);
  // The composer strip names the repository; the rail holds the branch.
  await pinSessionDetails(page);
  const rail = page.getByTestId("context-rail");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No repository", { exact: true })).toBeVisible();
  // The branch is named at the first push, so a session with no repository
  // has no branch and no pull request to show.
  await expect(rail.getByTestId("rail-branch")).toHaveText("Branch named at the first push");
  await expect(rail.getByTestId("rail-pull-request-open")).toHaveText("No pull request yet");
  await page.screenshot({ path: `${SHOTS}/pr07-session-unchanged.png`, fullPage: true });
});

test("the install flow links only the repositories the double says this user can see", async ({
  page,
  context,
}) => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();

  expect(await completeInstall()).toBe(302);

  const linked = await repositories();
  expect(linked.map((row) => row.fullName).sort()).toEqual(["acme/legacy", "acme/widgets"]);
  expect(linked.every((row) => row.status === "verified")).toBe(true);

  // Scoped by `url`, not a hard-coded domain: ORIGIN may be 127.0.0.1, where
  // a cookie pinned to "localhost" is not sent.
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/repositories`);

  await expect(page.getByText("You don't have access to view repositories.")).toHaveCount(0);
  await expect(page.getByText("acme/widgets")).toBeVisible({ timeout: 15_000 });
  // A reachable repository carries no badge; only a lost one says so.
  await expect(page.getByText("Disconnected", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/pr07-install.png`, fullPage: true });
});

/**
 * Record 07: the redirect names an installation that exists but is not in the
 * user's `GET /user/installations` list, the spoof GitHub documents.
 */
test("a spoofed installation_id links nothing and says so in the log", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();

  const status = await completeInstall("lane-code", OTHER_INSTALLATION_ID);

  expect(status).toBe(302);
  expect(await repositories()).toEqual([]);
  expect(
    (await queryD1<{ count: number }>("SELECT COUNT(*) AS count FROM github_installation")).at(0)
      ?.count,
  ).toBe(0);

  // This line distinguishes "the spoof was caught" from "the flow did nothing".
  const lines = await workerLogLines("installation not visible to user");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.at(0)).toContain('"operation":"github.install"');
  expect(lines.at(0)).toContain('"severity":"warn"');
  // Nothing about the installation, the user, or a token rides along.
  expect(/gh[supo]_/.test(lines.at(0) ?? "")).toBe(false);
});

test("a webhook with a bad signature is refused and changes nothing", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  const before = await repositories();

  const answer = await postWebhook(
    "installation",
    {
      action: "deleted",
      installation: { id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } },
      sender: { id: GITHUB_USER_ID, login: "octocat" },
    },
    { signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
  );

  expect(answer.status).toBe(401);
  expect(await repositories()).toEqual(before);
  expect(
    (await queryD1<{ count: number }>("SELECT COUNT(*) AS count FROM webhook_delivery")).at(0)
      ?.count,
  ).toBe(0);
});

test("the same delivery id twice is acknowledged and not applied twice", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  const deliveryId = `lane-replay-${crypto.randomUUID()}`;

  const suspend = await postWebhook(
    "installation",
    {
      action: "suspend",
      installation: { id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } },
      sender: { id: GITHUB_USER_ID, login: "octocat" },
    },
    { deliveryId },
  );
  expect(suspend.status).toBe(202);
  const afterSuspend = (
    await queryD1<{ status: string }>("SELECT status FROM github_installation")
  ).at(0)?.status;
  expect(afterSuspend).toBe("suspended");

  // A DIFFERENT payload under the same delivery id. Without the ledger this
  // would delete the installation.
  const replay = await postWebhook(
    "installation",
    {
      action: "deleted",
      installation: { id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } },
      sender: { id: GITHUB_USER_ID, login: "octocat" },
    },
    { deliveryId },
  );

  expect(replay.status).toBe(202);
  expect((replay.body as { outcome: string }).outcome).toBe("replayed");
  expect(
    (await queryD1<{ status: string }>("SELECT status FROM github_installation")).at(0)?.status,
  ).toBe("suspended");
});

test("removing one repository disconnects only that one", async ({ page, context }) => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  expect((await repositories()).length).toBe(2);

  const answer = await postWebhook("installation_repositories", {
    action: "removed",
    installation: { id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } },
    repositories_removed: [{ id: SECOND_REPO_ID, full_name: "acme/legacy" }],
    sender: { id: GITHUB_USER_ID, login: "octocat" },
  });
  expect(answer.status).toBe(202);

  const after = await repositories();
  const byName = new Map(after.map((row) => [row.fullName, row.status]));
  expect(byName.get("acme/legacy")).toBe("disconnected");
  expect(byName.get("acme/widgets")).toBe("verified");

  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/repositories`);
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The other repository stays reachable, and so carries no word at all.
  await expect(page.getByText("Disconnected", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("repository-row")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/pr07-repo-removed.png`, fullPage: true });
});

/** The double records what it was asked for, so narrowing and revocation are observed. */
test("creating a session mints one narrowed token, creates the branch, and revokes", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  const connected = (
    await queryD1<{ repository_connection_id: string; full_name: string }>(
      "SELECT repository_connection_id, full_name FROM repository_connection WHERE full_name = 'acme/widgets'",
    )
  ).at(0);
  expect(connected).toBeDefined();

  await resetDouble();
  const created = await createSession({
    commandId: newCommandId(),
    instruction: { messageId: "m1", text: "fix login", attachments: [] },
    repositoryConnectionId: connected?.repository_connection_id,
  });

  expect(created.status).toBe(201);
  const row = (
    await queryD1<{ task_branch: string; base_commit_sha: string }>(
      `SELECT task_branch, base_commit_sha FROM session_index WHERE session_id = '${String(created.body.sessionId)}'`,
    )
  ).at(0);
  // Record 07: no branch is created at the start; it is named at the first
  // push, so a session that never pushes leaves none behind.
  expect(row?.task_branch).toBeNull();
  expect(row?.base_commit_sha).toBe(BASE_SHA);

  const calls = await doubleCalls();
  // One mint, as narrow as its job and revoked when done: `contents: read`
  // for the launch check's read of the project file.
  const mints = calls.filter((call) => call.path.includes("access_tokens"));
  expect(mints.map((call) => call.tokenNarrowing)).toEqual([
    { repositoryIds: [REPO_ID], permissions: { contents: "read" } },
  ]);
  const refCreate = calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/git/refs"),
  );
  expect(refCreate).toHaveLength(0);

  const revokes = calls.filter((call) => call.path === "/installation/token");
  expect(revokes.map((call) => call.tokenRevoked)).toEqual([true]);
  const [readMint] = mints;
  const [readRevoke] = revokes;
  // Revocation must happen within five seconds; the double records wall-clock time.
  expect((readRevoke?.atMs ?? 0) - (readMint?.atMs ?? 0)).toBeLessThan(5000);
});

/**
 * Record 07: the stored user token is expired in D1 directly to reach the
 * refresh path, and the refresh token with it so the refresh fails.
 */
test("an expired link refuses the session start and asks to reconnect", async ({
  page,
  context,
}) => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  const connected = (
    await queryD1<{ repository_connection_id: string }>(
      "SELECT repository_connection_id FROM repository_connection WHERE full_name = 'acme/widgets'",
    )
  ).at(0);

  const past = "2020-01-01T00:00:00.000Z";
  await queryD1(
    `UPDATE github_installation SET user_token_expires_at = '${past}', refresh_token_expires_at = '${past}', last_verified_at = '${past}'`,
  );

  const refused = await createSession({
    commandId: newCommandId(),
    instruction: { messageId: "m1", text: "fix login", attachments: [] },
    repositoryConnectionId: connected?.repository_connection_id,
  });

  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("github_reverification_required");
  expect(
    (await queryD1<{ status: string }>("SELECT status FROM github_installation")).at(0)?.status,
  ).toBe("unauthorized");
  // No session on this repository. Counted by connection because other
  // tests' sessions share the table.
  expect(
    (
      await queryD1<{ count: number }>(
        `SELECT COUNT(*) AS count FROM session_index WHERE repository_connection_id = '${String(connected?.repository_connection_id)}'`,
      )
    ).at(0)?.count,
  ).toBe(0);

  // Record 07: no silent fallback to installation-only proof, and the line
  // says which check failed.
  const lines = await workerLogLines("reverification required");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.at(0)).toContain('"operation":"github.verify"');

  // The screen asks to reconnect: the installation is `unauthorized`, so
  // `readGitHubFact` answers `none` and the setup gate is back at step one.
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/repositories`);
  // Every repository reads Disconnected but still lists, so the user sees what
  // to reconnect.
  await expect(page.getByText("Disconnected", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Disconnected", { exact: true })).toHaveCount(
    await page.getByTestId("repository-row").count(),
  );
  await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/pr07-reverify.png`, fullPage: true });
});

/**
 * No part of the App private key, and no minted token, appears in D1, the
 * served client bundle, or an API response.
 */
test("the App private key and every token are absent from D1 and the client bundle", async () => {
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();

  const pemBody = devVar("ONCUE_GITHUB_APP_PRIVATE_KEY")
    .replaceAll('"', "")
    .replaceAll("\\n", "\n")
    .split("\n")
    .filter((line) => !line.startsWith("-----"))
    .join("");
  expect(pemBody.length).toBeGreaterThan(100);

  const wholeInstallation = JSON.stringify(
    await queryD1<Record<string, unknown>>("SELECT * FROM github_installation"),
  );
  expect(wholeInstallation.includes(pemBody.slice(0, 64))).toBe(false);
  expect(wholeInstallation.includes("PRIVATE KEY")).toBe(false);
  // A versioned envelope, so rotation prepends a key rather than rewriting rows.
  expect(wholeInstallation).toMatch(/oncue1\.\d+\.[\w-]+\.[\w-]+/);
  expect(/gh[supo]_/.test(wholeInstallation)).toBe(false);

  const apiText = await (
    await settledFetch(`${ORIGIN}/api/repositories`, { headers: authed() })
  ).text();
  expect(/gh[supo]_/.test(apiText)).toBe(false);
  expect(apiText.includes("PRIVATE KEY")).toBe(false);
});

/**
 * Record 07's incident rule. The same push webhook is sent as a person, which
 * changes nothing, and as the App's own bot, which locks the repository's
 * session down and logs an alert. The ref is `main`, no session's branch.
 */
test("the App's own push outside a session branch locks the session down and alerts; a person's does nothing", async ({
  page,
  context,
}) => {
  // No controller double runs here, so the session's start waits out the
  // Worker's 20 second controller timeout. Only the session and its policy
  // are needed.
  test.setTimeout(90_000);
  await seedDouble();
  await resetDouble();
  await clearGitHubRows();
  await completeInstall();
  const connected = (
    await queryD1<{ repository_connection_id: string }>(
      "SELECT repository_connection_id FROM repository_connection WHERE full_name = 'acme/widgets'",
    )
  ).at(0);
  const created = await createSession({
    commandId: newCommandId(),
    instruction: { messageId: "m1", text: "fix login", attachments: [] },
    repositoryConnectionId: connected?.repository_connection_id,
  });
  expect([200, 201]).toContain(created.status);
  const sessionId = String(created.body.sessionId);

  const push = (sender: Record<string, unknown>) => ({
    ref: "refs/heads/main",
    before: "a1b2c3",
    after: "d4e5f6",
    repository: { id: REPO_ID, full_name: "acme/widgets", default_branch: "main" },
    pusher: { name: String(sender.login) },
    sender,
  });

  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);

  // The Worker's local log store outlives a run, so alerts are counted, not
  // expected to be absent.
  const alertsBefore = await workerLogCount("github.incident.foreign_push");

  // A person pushing to main is their own work.
  const byPerson = await postWebhook("push", push({ id: 42, login: "octocat", type: "User" }));
  expect(byPerson).toEqual({ status: 202, body: { outcome: "audited" } });
  await page.goto(`${ORIGIN}/dev/home?at=/sessions/${sessionId}`);
  await pinSessionDetails(page);
  await expect(page.getByTestId("rail-git-behavior")).toHaveText("Commits · Does not push", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("row-policy-updated")).toHaveCount(0);
  expect(await workerLogCount("github.incident.foreign_push")).toBe(alertsBefore);

  // The same push by the App's own bot is the incident.
  const byTheApp = await postWebhook(
    "push",
    push({ id: 9_000_001, login: "oncue-local[bot]", type: "Bot" }),
  );
  expect(byTheApp).toEqual({ status: 202, body: { outcome: "audited" } });
  const lockedDown = page.getByTestId("row-policy-updated");
  await expect(lockedDown).toContainText(
    "OnCue turned pushing off after a push outside this session's branch",
    { timeout: 15_000 },
  );
  await expect(lockedDown).toContainText("never, checkpoints included");
  await pinSessionDetails(page);
  await expect(page.getByTestId("rail-git-behavior")).toHaveText("Commits · Never pushes");

  expect(await workerLogCount("github.incident.foreign_push")).toBeGreaterThan(alertsBefore);
  const alerts = await workerLogLines("github.incident.foreign_push");
  // The store keeps other runs' lines in no promised order, so the count
  // covers this run's alert and the properties are asserted on every line.
  expect(alerts.some((alert) => alert.includes("locked down 1 of 1 sessions"))).toBe(true);
  for (const alert of alerts) {
    expect(alert).toContain('"severity":"error"');
    // The alert names no ref, commit, or person: the payload is the pusher's text.
    for (const payloadText of ["refs/heads/main", "a1b2c3", "d4e5f6", "oncue-local[bot]"]) {
      expect(alert.includes(payloadText)).toBe(false);
    }
  }
  await page.screenshot({ path: `${SHOTS}/pr12-incident.png`, fullPage: true });
});
