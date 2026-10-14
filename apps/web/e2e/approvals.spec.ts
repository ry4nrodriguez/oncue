import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { scan } from "./a11y-scan";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { startProviderDouble } from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT, LANE_APPROVAL_TTL_SECONDS } from "./setup-local-auth.mjs";

/**
 * Agent permissions (record 09) on the real Worker, session objects, bridge,
 * and OpenCode, with the model scripted by the provider double: a task
 * carrying an `ASK_SCRIPTS` marker (`worker/test/provider-double.ts`) makes the
 * "model" read a file outside the project, read `.env`, or repeat a call, and
 * OpenCode's own gate asks. Nothing in a double knows an approval exists.
 *
 * Runs in its own project because it changes the dev workspace's approval
 * default, which every session of that workspace reads. Every lane starts
 * from the default: the settings are reset before each.
 */

const SHOTS = fileURLToPath(new URL("../test-results/screenshots/approvals/", import.meta.url));

/** A real sandbox start and a real OpenCode, with room to spare. */
const ASK_MS = 120_000;

const LANE_TITLE = "Approvals,";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

let closers: Array<() => Promise<void>> = [];
let workspaceId = "";

/** The dev subject's rows, as `pnpm dev` writes them, since Playwright's own server seeds nothing. */
async function seedDevWorkspace(): Promise<void> {
  const keyringSecret = devVars().get("ONCUE_BROKER_KEYRING");
  if (keyringSecret === undefined) {
    throw new Error(
      "apps/web/.dev.vars has no keyring; run `node apps/web/e2e/setup-local-auth.mjs`",
    );
  }
  await queryD1Batch(
    await seedStatements({
      subject: DEV_SUBJECT,
      keyringSecret,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(DEV_SUBJECT, queryD1),
    }),
  );
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
  await resetApprovals();
}

/** The default: ask, and nothing saved. */
async function resetApprovals(): Promise<void> {
  await queryD1Batch([
    `DELETE FROM workspace_approval_rule WHERE workspace_id = '${workspaceId}'`,
    `DELETE FROM workspace_approval_setting WHERE workspace_id = '${workspaceId}'`,
  ]);
}

test.beforeAll(async () => {
  const origin = await appOrigin();
  const github = await startGitHubDouble(undefined, origin);
  await github.setState(devGitHubSeed());
  const model = await startProviderDouble();
  await model.setMode("ok");
  const controller = await startControllerDouble({ controlPlaneOrigin: origin });
  closers = [() => github.close(), () => model.close(), () => controller.close()];
  await seedDevWorkspace();
});

test.beforeEach(async () => {
  await resetApprovals();
});

test.afterAll(async () => {
  await resetApprovals();
  for (const close of closers) {
    await close();
  }
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
}

async function goHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
}

/** Sends a task from Home and waits for the new session's screen. */
async function startFromHome(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(`${LANE_TITLE} ${text}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
}

/** Sends the next message in the open session. */
async function sendInSession(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function chooseMode(page: Page, name: string): Promise<void> {
  await page.getByTestId("approval-mode").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("How should agent actions be approved?")).toBeVisible();
  await menu.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
  await expect(menu).toBeHidden();
}

const card = (page: Page) => page.getByTestId("permission-card");
/** The card's answers, in order, without its collapse control. */
const answers = (page: Page) =>
  card(page).locator(
    '[data-testid^="permission-allow-"] [data-label], [data-testid="permission-deny"] [data-label]',
  );

/** The workspace's default as D1 holds it, which is what the object decides by. */
async function storedDefault(): Promise<string | null> {
  const rows = await queryD1<{ default_mode: string }>(
    `SELECT default_mode FROM workspace_approval_setting WHERE workspace_id = '${workspaceId}'`,
  );
  return rows[0]?.default_mode ?? null;
}
const lines = (page: Page) => page.getByTestId("row-permission");

async function runDone(page: Page): Promise<void> {
  await expect(page.getByText("No files changed, so no checks ran.").last()).toBeVisible({
    timeout: ASK_MS,
  });
}

/** The accessibility audit in the dark theme, back to light after. */
async function scanDark(page: Page, label: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await scan(page, label, "dark");
  await page.emulateMedia({ colorScheme: "light" });
}

/** One picture per theme and width: the page as a person sees it. */
async function shoot(page: Page, name: string, prepare?: () => Promise<void>): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const desktop = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const [width, height] of [
    [1280, 800],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await prepare?.();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}${name}-${theme}-${width}.png` });
      await page.keyboard.press("Escape");
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(desktop);
}

test("the picker on Home shows the next session's mode, opens by keyboard, and changes it", async ({
  page,
}) => {
  await signIn(page);
  const picker = page.getByTestId("approval-mode");
  await expect(picker).toHaveAttribute("data-mode", "ask");
  await expect(picker).toHaveAccessibleName(/^Approvals: Allow once/);
  await expect(page.getByTestId("approval-mode-chip")).toHaveText("Allow once");

  // Keyboard: focus, open, move with the arrows, choose with Enter.
  await picker.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitemradio", { name: /^Allow once/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await scan(page, "approval menu");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: /^Allow for this session/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(picker).toHaveAttribute("data-mode", "session");
  await expect(picker).toBeFocused();

  for (const [mode, name] of [
    ["ask", "Allow once"],
    ["session", "Allow for this session"],
    ["always", "Always allow"],
  ] as const) {
    await chooseMode(page, name);
    await expect(picker).toHaveAttribute("data-mode", mode);
    await shoot(page, `picker-menu-${mode}`, async () => {
      await picker.click();
      await expect(page.getByRole("menu")).toBeVisible();
    });
    await shoot(page, `picker-chip-${mode}`);
  }
  await expect(page.getByTestId("approval-mode-chip")).toHaveText("Always allow");
  await scanDark(page, "approval chip");
  // Always is the workspace's: a reload still shows it.
  await page.reload();
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "always");
  await chooseMode(page, "Allow once");
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "ask");
  await page.reload();
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "ask");
});

test("a read outside the project asks, Allow once lets it through, and the next read asks again", async ({
  page,
}) => {
  await signIn(page);
  await startFromHome(page, "read twice [double: read outside twice]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await expect(page.getByTestId("permission-title")).toHaveText(
    "Read /etc/hosts, outside the project",
  );
  await expect(card(page)).toContainText("Files outside the project");
  await expect(card(page)).toContainText("Denied if not answered by");
  await expect(answers(page)).toHaveText([
    "Allow once",
    "Allow for this session",
    "Always allow",
    "Deny",
  ]);
  await scan(page, "permission card");
  await scanDark(page, "permission card");
  await shoot(page, "card-outside-project");

  await card(page).getByTestId("permission-allow-once").click();
  await expect(page.getByTestId("permission-title")).toHaveText(
    "Read /etc/shells, outside the project",
    { timeout: ASK_MS },
  );
  await card(page).getByTestId("permission-deny").click();
  await runDone(page);
  await expect(lines(page)).toHaveText([
    "Allowed once: read /etc/hosts, outside the project",
    "Denied: read /etc/shells, outside the project",
  ]);
  await shoot(page, "timeline-lines");
});

test("Allow for this session stops asking within the session, and the picker says so", async ({
  page,
}) => {
  await signIn(page);
  await startFromHome(page, "session rule [double: read outside twice]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await card(page).getByTestId("permission-allow-session").click();
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "session");
  await runDone(page);
  await expect(card(page)).toHaveCount(0);
  await expect(lines(page)).toHaveText([
    "Allowed for this session: read /etc/hosts, outside the project",
    "Allowed for this session: read /etc/shells, outside the project",
  ]);

  // The menu in a session: choosing "Allow for this session" applies to every
  // category but secret files from the next ask.
  await chooseMode(page, "Allow for this session");
  await expect(page.getByTestId("approval-mode-chip")).toHaveText("This session");
  await sendInSession(page, "again [double: repeat]");
  await runDone(page);
  await expect(lines(page).last()).toHaveText(
    "Allowed for this session: repeat bash a third time in a row",
  );
});

test("Home's Allow for this session starts the session allowing", async ({ page }) => {
  await signIn(page);
  await chooseMode(page, "Allow for this session");
  await startFromHome(page, "from home [double: read outside]");
  await runDone(page);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "session");
  await expect(lines(page)).toHaveText([
    "Allowed for this session: read /etc/hosts, outside the project",
  ]);
});

test("a secret file still asks under Always allow, offers only Allow once or Deny, and Deny reaches the agent", async ({
  page,
}) => {
  await signIn(page);
  await chooseMode(page, "Always allow");
  // Always allow is in force before the task goes: the picker and the row the object reads.
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "always");
  await expect.poll(storedDefault).toBe("always");
  await startFromHome(page, "env [double: read env]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await expect(card(page).locator('[data-category="secret_file"]').first()).toBeVisible();
  await expect(page.getByTestId("permission-title")).toHaveText(/^Read \S*\.env, a secret file$/);
  await expect(answers(page)).toHaveText(["Allow once", "Deny"]);
  await shoot(page, "card-secret-file");
  await card(page).getByTestId("permission-deny").click();
  await runDone(page);
  await expect(lines(page)).toHaveText([/^Denied: read \S*\.env, a secret file$/]);
  // The read failed with the denial, and the run went on to answer.
  await expect(page.getByText("Read 1 file (1 failed)", { exact: true })).toBeVisible();
});

test("Always allow on a card carries to a new session and shows in Settings; Allow once there restores asking", async ({
  page,
}) => {
  await signIn(page);
  await startFromHome(page, "shell [double: cat outside]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await expect(page.getByTestId("permission-title")).toHaveText(
    "Run a command on /etc, outside the project",
  );
  await card(page).getByTestId("permission-allow-always").click();
  // The card's choice becomes the mode, so the picker says what is in force.
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "always");
  await runDone(page);
  await expect(lines(page)).toHaveText([
    "Always allowed: run a command on /etc, outside the project",
  ]);

  await goHome(page);
  await startFromHome(page, "carried [double: read outside]");
  await runDone(page);
  await expect(card(page)).toHaveCount(0);
  await expect(lines(page)).toHaveText(["Always allowed: read /etc/hosts, outside the project"]);

  // Settings shows the default the card set, and changes it back.
  await page.goto("/settings/agent-permissions");
  await expect(page.getByTestId("approval-default-always")).toHaveAttribute("data-checked", "true");
  await scan(page, "agent permissions settings");
  await scanDark(page, "agent permissions settings");
  await shoot(page, "settings-agent-permissions");
  await page.getByTestId("approval-default-ask").click();
  await expect(page.getByTestId("approval-default-ask")).toHaveAttribute("data-checked", "true");

  // Back to asking: Home's picker says so, and the next ask shows a card.
  await goHome(page);
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "ask");
  await startFromHome(page, "asks again [double: read outside]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await card(page).getByTestId("permission-deny").click();
  await runDone(page);
});

test("a repeated call asks as a repeated action", async ({ page }) => {
  await signIn(page);
  await startFromHome(page, "repeat [double: repeat]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await expect(page.getByTestId("permission-title")).toHaveText(
    "Repeat bash a third time in a row",
  );
  await expect(card(page)).toContainText("Repeated action");
  await expect(card(page)).not.toContainText("echo again");
  await shoot(page, "card-repeated-action");
  await card(page).getByTestId("permission-allow-once").click();
  await runDone(page);
  await expect(lines(page)).toHaveText(["Allowed once: repeat bash a third time in a row"]);
});

test("denying a repeated call ends the run as the agent stopping, not a failure", async ({
  page,
}) => {
  await signIn(page);
  await startFromHome(page, "repeat denied [double: repeat]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await card(page).getByTestId("permission-deny").click();
  await runDone(page);
  await expect(lines(page)).toHaveText(["Denied: repeat bash a third time in a row"]);
  await expect(page.getByText(/Failed while running/)).toHaveCount(0);
});

test("a card nobody answers expires and denies", async ({ page }) => {
  test.setTimeout(ASK_MS + (LANE_APPROVAL_TTL_SECONDS + 120) * 1000);
  await signIn(page);
  await startFromHome(page, "nobody answers [double: read outside]");
  await expect(card(page)).toBeVisible({ timeout: ASK_MS });
  await expect(card(page)).toHaveCount(0, { timeout: (LANE_APPROVAL_TTL_SECONDS + 90) * 1000 });
  await runDone(page);
  await expect(lines(page)).toHaveText([
    "Denied, no answer in time: read /etc/hosts, outside the project",
  ]);
});
