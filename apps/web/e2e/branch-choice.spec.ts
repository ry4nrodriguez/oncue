import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  DOUBLE_MODAL_PAIR,
  existingIdsFor,
  SEED_ACCOUNT_LOGIN,
  SEED_GITHUB_LOGIN,
  SEED_GITHUB_USER_ID,
  SEED_INSTALLATION_ID,
  SEED_REPOSITORIES,
  SEED_USER_TOKEN,
  seedStatements,
} from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import type { GitHubDoublePullRequest } from "../worker/test/github-double";
import { EDIT_FILE_CONTENT, EDIT_FILE_PATH } from "../worker/test/provider-double";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { createSeedRepository } from "./github-bare-repo";
import { GITHUB_DOUBLE_ORIGIN, startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { expectRuntimeReady } from "./runtime-ready";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { pinSessionDetails } from "./session-details";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * The branch a session works from (record 07), end to end against the real
 * Worker, session object, bridge, and OpenCode, with GitHub a double over
 * real bare repositories:
 *
 *   - a session that starts from a non-default branch runs to verified, pushes
 *     a new `oncue/` branch, and opens a draft whose base is that branch;
 *   - a session that works directly on an existing branch pushes to it and
 *     adopts the pull request a person already opened for it, keeping their words;
 *   - the picker refuses the default and a protected branch for working
 *     directly, and the Worker refuses a branch another session holds.
 *
 * Runs in its own project because it reseeds the GitHub double, switches the
 * provider double's mode, and serves the controller double's port.
 * `ONCUE_SHOTS=1` also writes screenshots.
 */

const SHOTS = process.env.ONCUE_SHOTS === "1";
const SHOTS_DIR = fileURLToPath(
  new URL("../test-results/screenshots/branch-choice/", import.meta.url),
);

/** Every session this lane starts has a title beginning with this. */
const LANE_TITLE = "Branch choice,";
const REPOSITORY = "acme/widgets";
const RELEASE = "release/1.4";
const RELEASE_FILE = "RELEASE.md";
const FEATURE = "feature/login";
const FEATURE_FILE = "src/login.js";
const GUARDED = "guarded/payments";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Someone Else",
  GIT_AUTHOR_EMAIL: "else@oncue.test",
  GIT_COMMITTER_NAME: "Someone Else",
  GIT_COMMITTER_EMAIL: "else@oncue.test",
};

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString("utf8")
    .trim();
}

/** A branch off `main` with one commit adding `file`, pushed as a person would. */
function addBranch(bareDir: string, branch: string, file: string, text: string): string {
  const work = mkdtempSync(join(tmpdir(), "oncue-lane-branch-"));
  git(["clone", "--quiet", bareDir, "."], work);
  git(["checkout", "--quiet", "-b", branch], work);
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), text);
  git(["add", file], work);
  git(["commit", "--quiet", "-m", `Add ${file}`], work);
  git(["push", "--quiet", "origin", branch], work);
  return git(["rev-parse", "HEAD"], work);
}

let ORIGIN = DEFAULT_APP_ORIGIN;
let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
let controller: RunningControllerDouble | null = null;
let widgetsBareDir = "";

function bareRefs(): string[] {
  return git(["for-each-ref", "--format=%(refname)", "refs/heads"], widgetsBareDir)
    .split("\n")
    .filter((line) => line.length > 0);
}

function bareFile(ref: string, path: string): string | null {
  try {
    return git(["show", `${ref}:${path}`], widgetsBareDir);
  } catch {
    return null;
  }
}

async function pullRequestsOnGitHub(): Promise<GitHubDoublePullRequest[]> {
  const answer = await fetch(`${GITHUB_DOUBLE_ORIGIN}/__pulls`);
  return ((await answer.json()) as { pullRequests: GitHubDoublePullRequest[] }).pullRequests;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}${name}.png` });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const seeded = SEED_REPOSITORIES.map((repository) => ({
    repository,
    seed: createSeedRepository(repository.fullName, "main"),
  }));
  const widgets = seeded.find(({ repository }) => repository.fullName === REPOSITORY);
  if (widgets === undefined) {
    throw new Error(`${REPOSITORY} is not a seeded repository`);
  }
  widgetsBareDir = widgets.seed.bareDir;
  addBranch(widgetsBareDir, RELEASE, RELEASE_FILE, "# Release 1.4\n");
  addBranch(widgetsBareDir, GUARDED, "src/payments.js", "export const payments = [];\n");
  const featureSha = addBranch(
    widgetsBareDir,
    FEATURE,
    FEATURE_FILE,
    "export function login() {\n  return true;\n}\n",
  );
  const github = await startGitHubDouble(undefined, ORIGIN);
  await github.setState({
    users: [{ id: SEED_GITHUB_USER_ID, login: SEED_GITHUB_LOGIN }],
    installations: [
      {
        installationId: SEED_INSTALLATION_ID,
        account: { login: SEED_ACCOUNT_LOGIN, type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [SEED_GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [SEED_INSTALLATION_ID]: seeded.map(({ repository, seed }) => ({
        ...repository,
        cloneUrl: seed.cloneUrl,
      })),
    },
    // The double reads every other branch from the bare repository itself.
    refsByRepository: Object.fromEntries(
      seeded.map(({ repository, seed }) => [repository.fullName, { main: seed.sha }]),
    ),
    protectedBranchesByRepository: { [REPOSITORY]: [RELEASE] },
    rulesetsByRepository: {
      [REPOSITORY]: [
        {
          id: 1,
          name: "Guarded branches",
          target: "branch",
          enforcement: "active",
          include: ["refs/heads/guarded/**"],
          exclude: [],
          rules: ["update"],
          source: "Organization",
        },
      ],
    },
    // A person already opened a pull request for the feature branch.
    pullRequests: [
      {
        number: 1,
        fullName: REPOSITORY,
        title: "Login, by hand",
        head: FEATURE,
        base: "main",
        headSha: featureSha,
        draft: false,
        state: "open",
        body: "My notes on the login flow.",
      },
    ],
    userTokens: { [SEED_USER_TOKEN]: SEED_GITHUB_USER_ID },
  });
  provider = await startProviderDouble();
  await provider.setMode("edit_file");
  controller = await startControllerDouble({ controlPlaneOrigin: ORIGIN });
  closers = [
    () => github.close(),
    () => (provider as RunningDouble).close(),
    () => (controller as RunningControllerDouble).close(),
  ];

  const statements = await seedStatements({
    subject: DEV_SUBJECT,
    keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
    modalPair: DOUBLE_MODAL_PAIR,
    modalWorkspaceName: "oncue-local-double",
    existing: await existingIdsFor(DEV_SUBJECT, queryD1),
  });
  await queryD1Batch(statements);
  const workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
  // Earlier runs' sessions, and any session still holding the feature branch.
  await cascadeDelete(
    [
      {
        table: "session_index",
        where: `workspace_id = '${workspaceId}' AND (title LIKE '${LANE_TITLE}%' OR task_branch = '${FEATURE}')`,
      },
    ],
    queryD1Batch,
  );
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  for (const close of closers) {
    await close();
  }
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") {
    const text = await page
      .evaluate(() => document.body.innerText)
      .catch((error: unknown) => `(no page text: ${String(error)})`);
    console.log(`page text at failure:\n${text}`);
  }
});

/** Home, signed in as the seeded subject, on the lane's repository. */
async function home(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 15_000 });
  const picker = page.getByRole("button", { name: /^Repository: / });
  if (!(await picker.getAttribute("aria-label"))?.includes(REPOSITORY)) {
    await picker.click();
    await page.getByRole("menuitemradio", { name: REPOSITORY }).click();
  }
  await expect(picker).toHaveAttribute("aria-label", new RegExp(REPOSITORY));
}

function option(page: Page, name: string) {
  return page.locator(`[data-testid='branch-option'][data-branch='${name}']`);
}

async function send(page: Page, text: string): Promise<string> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  return /\/sessions\/([^/]+)$/.exec(page.url())?.[1] as string;
}

/** The run ends verified on the pushed code's checks; then the rail's control allows pushing. */
async function runVerifiedThenPush(page: Page): Promise<void> {
  await expectRuntimeReady(page.getByTestId("row-sandbox").first());
  const outcome = page.locator("[data-testid='row-run'][data-outcome]").first();
  await expect(outcome).toHaveAttribute("data-outcome", "verified", { timeout: 150_000 });
  await expect(page.getByTestId("rail-git-behavior")).toHaveText("Commits · Does not push");
  await page.getByTestId("rail-policy-switch").click();
  await expect(page.getByTestId("row-push").last()).toContainText("completed", {
    timeout: 60_000,
  });
}

test.setTimeout(420_000);

test("a session started from a non-default branch runs, pushes a new task branch, and opens its draft against that branch", async ({
  page,
}) => {
  await home(page);
  await page.getByTestId("branch-picker").click();
  // Starting from a protected branch is allowed: nothing pushes to it.
  await expect(option(page, RELEASE)).toHaveAttribute("aria-disabled", "false", {
    timeout: 15_000,
  });
  await expect(option(page, RELEASE).getByLabel("Protected")).toBeVisible();
  await option(page, RELEASE).click();
  await expect(page.getByTestId("branch-picker-label")).toHaveText(`From ${RELEASE}`);
  await shot(page, "start-from-release");
  const sessionId = await send(page, `${LANE_TITLE} start from the release branch`);
  await pinSessionDetails(page);

  await expect(page.getByTestId("rail-branch-mode")).toHaveText(`From ${RELEASE}`);
  await runVerifiedThenPush(page);
  // The clone was of the chosen branch: its file is in the work tree.
  expect(await controller?.readWorkspaceFile(sessionId, 1, RELEASE_FILE)).toContain("Release 1.4");

  await expect(page.getByTestId("row-pull-request")).toContainText("created", {
    timeout: 30_000,
  });
  const opened = (await pullRequestsOnGitHub()).find((pull) => pull.head.startsWith("oncue/"));
  expect(opened).toMatchObject({ draft: true, base: RELEASE });
  const head = (opened as GitHubDoublePullRequest).head;
  // The new task branch carries the release branch's history and the run's work.
  expect(bareFile(`refs/heads/${head}`, RELEASE_FILE)).toContain("Release 1.4");
  expect(bareFile(`refs/heads/${head}`, EDIT_FILE_PATH)).toBe(EDIT_FILE_CONTENT);
  // Nothing was pushed to the branch it started from.
  expect(bareFile(`refs/heads/${RELEASE}`, EDIT_FILE_PATH)).toBeNull();

  await page.getByTestId("rail-pull-request-open").click();
  await expect(page.getByTestId("panel-branch-name")).toHaveText(head);
  await expect(page.getByTestId("panel-branch-base")).toHaveText(`Started from ${RELEASE}.`);
  await expect(page.getByTestId("pull-request-base")).toHaveText(`Into ${RELEASE}`);
  await shot(page, "start-from-release-pull-request");
});

test("a session working directly on an existing branch pushes there and adopts the person's pull request", async ({
  page,
}) => {
  const taskBranchesBefore = bareRefs().filter((ref) => ref.startsWith("refs/heads/oncue/"));
  await home(page);
  await page.getByTestId("branch-picker").click();
  await page.getByText("Work on it directly").click();
  // The picker's refusals: the default branch and a protected one are not offered.
  await expect(option(page, "main")).toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
  await expect(option(page, "main")).toContainText("Default branch");
  await expect(option(page, RELEASE)).toHaveAttribute("aria-disabled", "true");
  await expect(option(page, RELEASE)).toContainText("Protected");
  // A branch only an organization ruleset guards, which the branch API does not call protected.
  await expect(option(page, GUARDED)).toHaveAttribute("aria-disabled", "true");
  await expect(option(page, GUARDED)).toContainText("Protected");
  // Refused rows stay reachable by keyboard, with their reason in their name.
  await option(page, GUARDED).focus();
  await expect(option(page, GUARDED)).toBeFocused();
  await shot(page, "work-on-refusals");
  await option(page, FEATURE).click();
  await expect(page.getByTestId("branch-picker-label")).toHaveText(`On ${FEATURE}`);
  const sessionId = await send(page, `${LANE_TITLE} work on the login branch`);
  await pinSessionDetails(page);

  await expect(page.getByTestId("rail-branch")).toContainText(FEATURE);
  await expect(page.getByTestId("rail-branch-mode")).toHaveText(
    "Existing branch, pushed to directly",
  );
  await runVerifiedThenPush(page);
  expect(await controller?.readWorkspaceFile(sessionId, 1, FEATURE_FILE)).toContain("login");

  // The push went to the chosen branch, on top of the person's commit, and no
  // task branch was made.
  expect(bareFile(`refs/heads/${FEATURE}`, EDIT_FILE_PATH)).toBe(EDIT_FILE_CONTENT);
  expect(bareFile(`refs/heads/${FEATURE}`, FEATURE_FILE)).toContain("login");
  expect(bareRefs().filter((ref) => ref.startsWith("refs/heads/oncue/"))).toEqual(
    taskBranchesBefore,
  );

  // The person's pull request was adopted: their title and words kept, the
  // verification section added, no second pull request opened.
  await expect(page.getByTestId("row-pull-request")).toContainText("#1 updated", {
    timeout: 30_000,
  });
  const forFeature = (await pullRequestsOnGitHub()).filter((pull) => pull.head === FEATURE);
  expect(forFeature).toHaveLength(1);
  expect(forFeature[0]).toMatchObject({ number: 1, title: "Login, by hand", base: "main" });
  expect(forFeature[0]?.body).toContain("My notes on the login flow.");
  expect(forFeature[0]?.body).toContain("<!-- oncue:verification:start -->");
  await expect(page.getByTestId("rail-pull-request")).toContainText("#1 · open");

  await page.getByTestId("rail-pull-request-open").click();
  await expect(page.getByTestId("panel-branch-name")).toHaveText(FEATURE);
  await expect(page.getByTestId("panel-branch-base")).toContainText("pushes to it directly");
  await expect(page.getByTestId("pull-request-link")).toHaveAttribute(
    "href",
    `https://github.com/${REPOSITORY}/pull/1`,
  );
  await shot(page, "work-on-adopted-pull-request");
});

test("a branch another session holds is refused, and nothing is created", async ({ page }) => {
  await home(page);
  await page.getByTestId("branch-picker").click();
  await page.getByText("Work on it directly").click();
  await option(page, FEATURE).click();
  await page.getByRole("textbox", { name: "Message" }).fill(`${LANE_TITLE} a second writer`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("home-notice")).toContainText(
    "Another session is already working on that branch",
    { timeout: 15_000 },
  );
  // The holder is this person's own session, linked from the notice.
  await expect(page.getByTestId("home-notice-session")).toHaveAttribute("href", /\/sessions\//);
  await expect(page).not.toHaveURL(/\/sessions\//);
  const workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
  const rows = await queryD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM session_index WHERE workspace_id = '${workspaceId}' AND title = '${LANE_TITLE} a second writer'`,
  );
  expect(Number(rows[0]?.count)).toBe(0);
  await shot(page, "work-on-held-branch");
});
