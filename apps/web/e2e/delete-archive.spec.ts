import { execFileSync } from "node:child_process";
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
import { listR2Keys, r2ObjectExists } from "./local-r2";
import { pointerOffSidebar } from "./pointer";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { expectRuntimeReady } from "./runtime-ready";
import {
  CONTROLLER_DOUBLE_PORT,
  type RunningControllerDouble,
  startControllerDouble,
} from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * Deleting and archiving a session end to end, against the real Worker,
 * session object, bridge, and OpenCode (records 10 and 19).
 *
 * Delete: a session with an attachment and the artifacts its run uploaded is
 * deleted from its screen. Afterwards no D1 row and no R2 object under its keys
 * remain, its sandbox has stopped, it is gone from the list, and the receipt
 * says it finished.
 *
 * Archive: a session is archived from its sidebar row. Its sandbox stops the
 * idle way, checkpointing first (the task branch reaches the repository), the
 * screen turns read-only, and Unarchive then lets a message resume it on a new
 * sandbox.
 *
 * Runs in its own project because it reseeds the GitHub double, switches the
 * provider double's mode, and serves the controller double's fixed port.
 */

const LANE_TITLE = "Delete and archive,";

let ORIGIN = DEFAULT_APP_ORIGIN;
let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
const bareDirs: string[] = [];
let workspaceId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const seeded = SEED_REPOSITORIES.map((repository) => {
    const seed = createSeedRepository(repository.fullName, "main");
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
  const controller: RunningControllerDouble = await startControllerDouble({
    controlPlaneOrigin: ORIGIN,
  });
  closers = [
    () => github.close(),
    () => (provider as RunningDouble).close(),
    () => controller.close(),
  ];

  const statements = await seedStatements({
    subject: DEV_SUBJECT,
    keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
    modalPair: DOUBLE_MODAL_PAIR,
    modalWorkspaceName: "oncue-local-double",
    existing: await existingIdsFor(DEV_SUBJECT, queryD1),
  });
  await queryD1Batch(statements);
  workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
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

/** What the controller double says about one generation's sandbox, asked the way the Worker asks. */
async function sandboxStatus(sessionId: string, generation: number): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${CONTROLLER_DOUBLE_PORT}/v1/getStatus`, {
    method: "POST",
    headers: {
      authorization: "Bearer lane",
      "x-oncue-modal-token-id": "lane",
      "x-oncue-modal-token-secret": "lane",
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId, generation }),
  });
  const body = (await answer.json()) as { kind: string; value?: string; category?: string };
  return body.kind === "ok" ? String(body.value) : String(body.category);
}

async function countRows(table: string, sessionId: string): Promise<number> {
  const rows = await queryD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = '${sessionId}'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 15_000 });
}

/** Sends the composer's first message from Home and returns the new session's id. */
async function startSession(page: Page, text: string): Promise<string> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  return /\/sessions\/([^/]+)$/.exec(page.url())?.[1] as string;
}

async function pinSidebar(page: Page): Promise<void> {
  // The open sidebar's wordmark would cover the shell's pin button.
  await pointerOffSidebar(page);
  const pin = page.getByRole("button", { name: "Pin sidebar open" }).first();
  if (await pin.isVisible()) {
    await pin.click();
  }
}

test("deleting a session with an attachment and artifacts leaves no row and no object of its own, and stops its sandbox", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await provider?.setMode("demo");

  await signIn(page);
  await page.getByTestId("composer-file-input").setInputFiles([
    {
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\n\nKeep the retry budget small.\n"),
    },
  ]);
  await expect(
    page.getByTestId("composer-attachments").locator("[data-status='ready']"),
  ).toHaveCount(1);
  const sessionId = await startSession(page, `${LANE_TITLE} delete me after a retry budget`);

  await expectRuntimeReady(page.getByTestId("row-sandbox").first());
  await expect(page.locator("[data-testid='row-run'][data-outcome]").first()).toHaveAttribute(
    "data-outcome",
    /.+/,
    { timeout: 150_000 },
  );
  await expect(page.getByTestId("row-changes").first()).toBeVisible();

  // What the session stored before the delete: an attachment and the run's artifacts.
  const sessionPrefix = `workspaces/${workspaceId}/sessions/${sessionId}/`;
  const attachments = await queryD1<{ object_key: string }>(
    `SELECT object_key FROM message_attachment WHERE session_id = '${sessionId}'`,
  );
  expect(attachments).toHaveLength(1);
  const attachmentKey = attachments[0]?.object_key as string;
  expect(await r2ObjectExists(attachmentKey)).toBe(true);
  await expect
    .poll(() => countRows("artifact_index", sessionId), { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect((await listR2Keys(sessionPrefix)).length).toBeGreaterThan(0);
  expect(await sandboxStatus(sessionId, 1)).toBe("active");

  // Delete from the session screen.
  await page
    .getByTestId("session-header")
    .getByRole("button", { name: /^Options for/ })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByTestId("delete-session-dialog");
  await expect(dialog).toContainText("conversation, diffs, logs, attachments, and artifacts");
  await expect(dialog).toContainText("The GitHub branch and any pull request stay on GitHub.");
  await page.getByTestId("delete-session-confirm").click();

  // Home at once, and the session is gone from the list.
  await page.waitForURL(`${ORIGIN}/`, { timeout: 15_000 });
  await pinSidebar(page);
  await expect(page.getByTestId("sidebar").locator(`a[href='/sessions/${sessionId}']`)).toHaveCount(
    0,
  );

  // The job finishes: one receipt, and nothing of the session's own left. The
  // erase waits for the late stop by name the stop owes until the create's
  // deadline passes (about 70 s after it was sent), and the scheduled handler
  // finishes the request after that; the dev server runs it on request.
  await expect
    .poll(
      async () => {
        await fetch(`${ORIGIN}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`);
        return (
          await queryD1<{ completed_at: string | null }>(
            `SELECT completed_at FROM deletion_request WHERE session_id = '${sessionId}'`,
          )
        ).map((row) => row.completed_at !== null);
      },
      { timeout: 150_000, intervals: [5_000] },
    )
    .toEqual([true]);
  for (const table of ["session_index", "artifact_index", "message_attachment"]) {
    expect(await countRows(table, sessionId), table).toBe(0);
  }
  expect(await listR2Keys(sessionPrefix)).toEqual([]);
  expect(await r2ObjectExists(attachmentKey)).toBe(false);
  expect(await sandboxStatus(sessionId, 1)).not.toBe("active");

  // The session reads as missing now, to its owner too.
  const reopened = await page.request.get(
    `${ORIGIN}/api/sessions/${sessionId}/files?path=README.md`,
  );
  expect(reopened.status()).toBe(403);
});

test("archiving checkpoints and stops the sandbox, reads only, and unarchiving resumes on a new sandbox", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await provider?.setMode("demo");
  await signIn(page);
  const sessionId = await startSession(page, `${LANE_TITLE} archive me after a retry budget`);
  const firstRow = page.getByTestId("row-sandbox").first();
  await expectRuntimeReady(firstRow);
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes.first()).toHaveAttribute("data-outcome", /.+/, { timeout: 150_000 });

  // Archive from the sidebar row's menu: no run is open, so it happens at once.
  await pinSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar.locator(`a[href='/sessions/${sessionId}']`).locator("..");
  // The list learns the run ended on its next read; until then the menu would ask first.
  await expect(row.getByTestId("session-status-dot")).toHaveAttribute(
    "data-activity",
    /idle|finished/,
    { timeout: 30_000 },
  );
  await row.hover();
  await row.getByRole("button", { name: /^Options for/ }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();

  // Read-only, and under Archived (closed until opened).
  await expect(page.getByTestId("archived-notice")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  const archivedGroup = sidebar.getByRole("button", { name: "Archived" });
  await expect(archivedGroup).toHaveAttribute("aria-expanded", "false");
  await archivedGroup.click();
  await expect(sidebar.locator(`a[href='/sessions/${sessionId}']`)).toBeVisible();
  await expect
    .poll(async () =>
      (
        await queryD1<{ state: string }>(
          `SELECT state FROM session_index WHERE session_id = '${sessionId}'`,
        )
      ).map((r) => r.state),
    )
    .toEqual(["archived"]);

  // The idle kind of stop: the checkpoint pushed the task branch, then the sandbox stopped.
  await expect(firstRow).toContainText("Sandbox stopped after going idle", { timeout: 120_000 });
  const pushed = bareDirs.some((bareDir) =>
    execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: bareDir })
      .toString("utf8")
      .includes("refs/heads/oncue/"),
  );
  expect(pushed).toBe(true);
  expect(await sandboxStatus(sessionId, 1)).not.toBe("active");
  // Nothing of the composer is left on the read-only screen, and the header's
  // sandbox dot is gone with the sandbox.
  for (const id of ["composer-strip", "agent-chip", "composer-below", "panel-sandbox-dot"]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }

  // Unarchive, then a message resumes the session on generation 2.
  await provider?.setMode("ok");
  await page.getByTestId("unarchive-session").click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Is the retry budget still there?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("row-sandbox")).toHaveCount(2, { timeout: 30_000 });
  await expectRuntimeReady(page.getByTestId("row-sandbox").nth(1));
  await expect(outcomes).toHaveCount(2, { timeout: 150_000 });
  await expect(outcomes.nth(1)).not.toHaveAttribute("data-outcome", "failed");
});
