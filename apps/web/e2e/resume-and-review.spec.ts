import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { createSeedRepository } from "./github-bare-repo";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { expectRuntimeReady } from "./runtime-ready";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { pinSessionDetails } from "./session-details";
import { DEV_SUBJECT, LANE_IDLE_ALARM_SECONDS } from "./setup-local-auth.mjs";

/**
 * Two things done with an idle session, end to end against the real Worker,
 * session object, bridge, and OpenCode (docs/decisions.md).
 *
 * The review panel's tree (record 13): folders start closed, a folder with
 * changes says how many, and an unchanged file opens at the base commit.
 *
 * Resuming after the base branch moved (record 07): the idle checkpoint's push
 * is refused, so the work is saved as a patch bundle, then `main` moves on. The
 * next generation must land on the session's own base commit with the edits.
 *
 * Runs in its own project because it reseeds the GitHub double, switches the
 * provider double's mode, and serves the controller double's fixed port.
 * `ONCUE_SHOTS=1` also writes screenshots.
 */

const SHOTS = process.env.ONCUE_SHOTS === "1";
const SHOTS_DIR = fileURLToPath(
  new URL("../test-results/screenshots/resume-base-menus-review-tree/", import.meta.url),
);

/** Every session this test starts has a title beginning with this. */
const LANE_TITLE = "Resume and review,";

/** Files the seeded repositories hold that no run touches: the tree lists them, and one is opened. */
const UNTOUCHED_GUIDE = "docs/guide.md";
const GUIDE_TEXT = "# Guide\n\nCount widgets with widgetCount.\n";
const UNTOUCHED_CONSTANTS = "src/constants.js";
const CONSTANTS_TEXT = "export const MAX_WIDGETS = 100;\n";

/** The file `demo` mode adds, which the patch bundle must bring back. */
const DEMO_ADDED = "src/retry.js";
/** What moves `main` on while the session is stopped. */
const LATER_FILE = "later.txt";

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

/**
 * A hook that refuses every push to an `oncue/` branch and lets `main`
 * through, so the idle checkpoint's push fails the way a protected or
 * unreachable branch fails and the work is kept as a patch bundle.
 */
const REFUSE_TASK_BRANCHES = [
  "#!/bin/sh",
  "while read old new ref; do",
  '  case "$ref" in',
  '    refs/heads/oncue/*) echo "this lane refuses pushes to task branches" >&2; exit 1 ;;',
  "  esac",
  "done",
  "exit 0",
  "",
].join("\n");

/** One commit on `main`, pushed from a clone of the bare repository: the base branch moving on. */
function moveMainForward(bareDir: string): string {
  const work = mkdtempSync(join(tmpdir(), "oncue-lane-move-main-"));
  git(["clone", "--quiet", bareDir, "."], work);
  writeFileSync(join(work, LATER_FILE), "someone else's work on main\n");
  git(["add", LATER_FILE], work);
  git(["commit", "--quiet", "-m", "Someone else's change on main"], work);
  git(["push", "--quiet", "origin", "main"], work);
  return git(["rev-parse", "HEAD"], work);
}

let ORIGIN = DEFAULT_APP_ORIGIN;
let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
let controller: RunningControllerDouble | null = null;
const bareDirs: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const seeded = SEED_REPOSITORIES.map((repository) => {
    const seed = createSeedRepository(repository.fullName, "main", {
      [UNTOUCHED_GUIDE]: GUIDE_TEXT,
      [UNTOUCHED_CONSTANTS]: CONSTANTS_TEXT,
    });
    const hook = join(seed.bareDir, "hooks", "pre-receive");
    writeFileSync(hook, REFUSE_TASK_BRANCHES);
    chmodSync(hook, 0o755);
    bareDirs.push(seed.bareDir);
    return { repository, seed };
  });
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
    refsByRepository: Object.fromEntries(
      seeded.map(({ repository, seed }) => [repository.fullName, { main: seed.sha }]),
    ),
    userTokens: { [SEED_USER_TOKEN]: SEED_GITHUB_USER_ID },
  });
  provider = await startProviderDouble();
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
  await cascadeDelete(
    [
      {
        table: "session_index",
        where: `workspace_id = '${workspaceId}' AND title LIKE '${LANE_TITLE}%'`,
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

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}${name}.png` });
}

function treeItem(page: Page, path: string) {
  return page.getByRole("tree", { name: "Changed files" }).locator(`[data-tree-path='${path}']`);
}

test("the review tree starts closed, marks the folders with changes, and opens a file the session left alone; then the session resumes after main moved on", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await provider?.setMode("demo");
  // Wide enough for the diff and the tree side by side.
  await page.setViewportSize({ width: 1600, height: 900 });

  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(`${LANE_TITLE} add a retry budget`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  const sessionId = /\/sessions\/([^/]+)$/.exec(page.url())?.[1] as string;

  const firstRow = page.getByTestId("row-sandbox").first();
  await expectRuntimeReady(firstRow);
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes.first()).toHaveAttribute("data-outcome", /.+/, { timeout: 150_000 });
  await expect(page.getByTestId("row-changes").first()).toBeVisible();

  // The review panel on every change in the session.
  await pinSessionDetails(page);
  await page.getByTestId("rail-changes").click();
  const review = page.getByTestId("review-panel");
  await expect(review).toBeVisible();
  // The tree sits beside the diff; a narrow panel starts with it put away.
  const showTree = review.getByTestId("review-show-tree");
  if (await showTree.isVisible()) {
    await showTree.click();
  }
  const tree = review.getByRole("tree", { name: "Changed files" });
  // The listing the bridge uploaded beside the diff holds the untouched files.
  await expect(treeItem(page, "docs/")).toBeVisible({ timeout: 30_000 });
  // Every folder starts closed.
  const folders = tree.locator("[aria-expanded]");
  await expect(folders.first()).toBeVisible();
  expect(
    new Set(
      await folders.evaluateAll((items) => items.map((item) => item.getAttribute("aria-expanded"))),
    ),
  ).toEqual(new Set(["false"]));
  // A folder holding changes says how many, in a mark and in words; one with
  // none says nothing.
  await expect(treeItem(page, "src/").getByTestId("tree-folder-mark")).toHaveText("2");
  await expect(treeItem(page, "src/")).toContainText("contains 2 changed files");
  await expect(treeItem(page, "test/").getByTestId("tree-folder-mark")).toHaveText("1");
  await expect(treeItem(page, "docs/").getByTestId("tree-folder-mark")).toHaveCount(0);
  await shot(page, "review-tree-closed-light");

  // Open a folder and a file the session never changed: the Worker reads it
  // from the GitHub double at the session's base commit.
  await treeItem(page, "docs/").locator(":scope > div").first().click();
  await expect(treeItem(page, "docs/")).toHaveAttribute("aria-expanded", "true");
  const fileRead = page.waitForResponse((response) =>
    response.url().includes(`/api/sessions/${sessionId}/files?path=`),
  );
  await treeItem(page, UNTOUCHED_GUIDE).click();
  expect((await fileRead).status()).toBe(200);
  const view = review.getByTestId("file-view");
  await expect(view).toHaveAttribute("data-file-path", UNTOUCHED_GUIDE);
  await expect(view.getByTestId("file-line")).toHaveCount(3);
  await expect(view.getByTestId("file-line").first()).toContainText("# Guide");
  await shot(page, "file-view-light");

  // Inside a folder with changes, an untouched file opens the same way.
  await treeItem(page, "src/").locator(":scope > div").first().click();
  await treeItem(page, UNTOUCHED_CONSTANTS).click();
  await expect(view).toHaveAttribute("data-file-path", UNTOUCHED_CONSTANTS);
  await expect(view.getByTestId("file-line").first()).toContainText("MAX_WIDGETS = 100");
  // A changed file goes back to its diff.
  await treeItem(page, DEMO_ADDED).click();
  await expect(review.getByTestId("file-view")).toHaveCount(0);

  if (SHOTS) {
    await page.emulateMedia({ colorScheme: "dark" });
    await treeItem(page, UNTOUCHED_GUIDE).click();
    await expect(view.getByTestId("file-line").first()).toContainText("# Guide");
    await shot(page, "file-view-dark");
    await page.setViewportSize({ width: 375, height: 812 });
    await shot(page, "file-view-mobile");
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
  }
  if ((await page.getByLabel("Close panel").count()) > 0) {
    await page.getByLabel("Close panel").click();
  }

  // Record 11's idle stop. The push the checkpoint tries is refused by the
  // repository, so the work is saved as a patch bundle and no task branch
  // exists anywhere: the next generation clones `main`.
  await expect(firstRow).toContainText("Sandbox stopped after going idle", {
    timeout: (LANE_IDLE_ALARM_SECONDS + 120) * 1000,
  });
  for (const bareDir of bareDirs) {
    const heads = git(["for-each-ref", "--format=%(refname)", "refs/heads"], bareDir);
    expect(heads).not.toContain("refs/heads/oncue/");
  }

  // `main` moves on while the session is stopped.
  for (const bareDir of bareDirs) {
    moveMainForward(bareDir);
  }

  // The next message resumes on generation 2. The clone's tip is the new
  // `main`; the bridge lands the tree on the session's own base commit and
  // restores the saved edits on top.
  await provider?.setMode("ok");
  await composer.fill("Is the retry budget still there?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("row-sandbox")).toHaveCount(2, { timeout: 30_000 });
  const resumedRow = page.getByTestId("row-sandbox").nth(1);
  await expectRuntimeReady(resumedRow);
  expect(await controller?.readWorkspaceFile(sessionId, 2, DEMO_ADDED)).toContain(
    "withRetryBudget",
  );
  expect(await controller?.readWorkspaceFile(sessionId, 2, LATER_FILE)).toBeNull();
  await expect(outcomes).toHaveCount(2, { timeout: 150_000 });
  await expect(outcomes.nth(1)).not.toHaveAttribute("data-outcome", "failed");
  await expect(page.getByText("HEAD is")).toHaveCount(0);
  await shot(page, "resumed-after-main-moved");
});
