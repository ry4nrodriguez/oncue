import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { QUESTION_ECHO_PREFIX, questionMarker } from "../worker/test/provider-double";
import { scan } from "./a11y-scan";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { openModalPanel, pinSessionDetails } from "./session-details";
import { DEV_SUBJECT, LANE_IDLE_ALARM_SECONDS } from "./setup-local-auth.mjs";

/**
 * The agent's questions, end to end: the real Worker, session object, bridge,
 * and OpenCode, with the provider double's `ask_question` mode making the
 * model call OpenCode's own question tool. The card above the composer is
 * answered every way a person can, and the timeline keeps what was said.
 * Runs in its own project because it reseeds the GitHub double and switches
 * the provider double's mode.
 */

const SHOTS = fileURLToPath(new URL("../test-results/screenshots/questions/", import.meta.url));

/** A real sandbox start and a real OpenCode, with room to spare. */
const ASKED_MS = 150_000;

const LANE_TITLE = "Questions,";

test.describe.configure({ mode: "serial" });

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;

/** The dev subject's rows, as `status-dots.spec.ts` writes them, and none of this lane's old sessions. */
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
}

test.beforeAll(async () => {
  const origin = await appOrigin();
  const github = await startGitHubDouble(undefined, origin);
  await github.setState(devGitHubSeed());
  const model = await startProviderDouble();
  provider = model;
  await model.setMode("ask_question");
  const controller = await startControllerDouble({ controlPlaneOrigin: origin });
  closers = [() => github.close(), () => model.close(), () => controller.close()];
  await seedDevWorkspace();
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  for (const close of closers) {
    await close();
  }
});

/** Signs in, sends `text` from Home, and waits for the agent's question card. */
async function asked(page: Page, text: string): Promise<Locator> {
  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(`${LANE_TITLE} ${text} ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: ASKED_MS });
  return card;
}

/** The agent's last words, once the run has ended. */
async function agentReply(page: Page): Promise<string> {
  await expect(page.locator("[data-testid='row-run'][data-outcome]").last()).toBeVisible({
    timeout: ASKED_MS,
  });
  const reply = page.getByTestId("row-message-assistant").filter({ hasText: QUESTION_ECHO_PREFIX });
  await expect(reply.last()).toBeVisible({ timeout: 30_000 });
  return (await reply.last().textContent()) ?? "";
}

/** Presses Tab (or Shift+Tab) until one of `targets` has focus, as a keyboard user would. */
async function tabTo(page: Page, targets: Locator, key = "Tab"): Promise<void> {
  for (let press = 0; press < 200; press += 1) {
    if (await targets.evaluateAll((elements) => elements.includes(document.activeElement))) {
      return;
    }
    await page.keyboard.press(key);
  }
  throw new Error("the keyboard never reached the control");
}

async function questionRow(page: Page): Promise<Locator> {
  const row = page.getByTestId("row-question").last();
  await expect(row).toBeVisible();
  return row;
}

/** The card, and the page around it, in both themes and at desktop and phone widths. */
async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  // Away from the left edge, where the pointer would slide the sidebar in.
  await page.mouse.move(640, 30);
  // The floating session details would cover the card in a picture.
  const unpin = page.getByRole("button", { name: "Unpin session details" });
  if (await unpin.isVisible()) {
    await unpin.click();
  }
  const desktop = page.viewportSize();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.setViewportSize({ width: 1280, height: 860 });
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: `${SHOTS}${name}-${theme}-1280.png` });
    await page.screenshot({ path: `${SHOTS}${name}-${theme}-1280-page.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: `${SHOTS}${name}-${theme}-375.png` });
    await page.screenshot({ path: `${SHOTS}${name}-${theme}-375-page.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (desktop !== null) {
    await page.setViewportSize(desktop);
  }
}

test("a single choice is answered on the card, and the agent works with the answer", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const card = await asked(page, "pick a database");
  await expect(card.getByRole("heading")).toHaveText("Which database should the service use?");
  // The run waits on the user: the rail says so, and nothing is answered yet.
  await pinSessionDetails(page);
  await expect(page.getByTestId("needs-you")).toHaveText("The agent asked you a question");
  await expect(card.getByTestId("question-card-counter")).toHaveCount(0);
  await expect(card.getByTestId("question-option")).toHaveText([
    "PostgresRelational, already in the stack1",
    "SQLiteOne file, no server to run2",
    "DuckDBColumnar, good for analytics3",
  ]);
  await card.getByText("SQLite").click();
  await expect(card.getByRole("radio", { name: /SQLite/ })).toBeChecked();
  await shoot(page, card, "card-single");
  // The card passes the same audit as the rest of the app, in both themes.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(await scan(page, "question card", theme)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // Folded to one line and back, then submitted.
  await card.getByRole("button", { name: "Collapse" }).click();
  await expect(card).toHaveAttribute("data-collapsed", "true");
  await expect(card).toContainText("Asking: Database");
  await shoot(page, card, "card-collapsed");
  await card.getByRole("button", { name: "Expand" }).click();
  await card.getByRole("button", { name: /Submit/ }).click();
  await expect(card).toHaveCount(0);

  expect(await agentReply(page)).toContain("SQLite");
  const row = await questionRow(page);
  await expect(row).toContainText("Asked 1 question");
  await shoot(page, row, "timeline-row-folded");
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-answer")).toHaveText(["SQLite"]);
  await shoot(page, row, "timeline-row-expanded");
  expect(await scan(page, "question timeline row, open")).toEqual([]);
});

test("several choices and a typed answer reach the agent together", async ({ page }) => {
  test.setTimeout(360_000);
  const card = await asked(page, `ship it ${questionMarker("multi")}`);
  await expect(card.getByRole("heading")).toHaveText("Which platforms should it ship on?");
  await card.getByText("Web", { exact: true }).click();
  await card.getByText("Android", { exact: true }).click();
  await expect(card.getByRole("checkbox", { name: /Web/ })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: /Android/ })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: /iOS/ })).not.toBeChecked();
  await shoot(page, card, "card-multi");
  await card.getByPlaceholder("Type your own answer here").fill("Smart watches");
  await shoot(page, card, "card-other-typed");
  await card.getByRole("button", { name: /Submit/ }).click();
  await expect(card).toHaveCount(0);

  const reply = await agentReply(page);
  for (const word of ["Web", "Android", "Smart watches"]) {
    expect(reply).toContain(word);
  }
  const row = await questionRow(page);
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-answer")).toHaveText(["Web, Android, Smart watches"]);
});

test("four questions are answered from the keyboard alone, with a skip", async ({ page }) => {
  test.setTimeout(360_000);
  const card = await asked(page, `plan the app ${questionMarker("four")}`);
  await expect(card.getByTestId("question-card-counter")).toHaveText("1/4");
  await shoot(page, card, "card-four");
  // On a small phone the rows scroll inside the card, so its actions and the
  // composer stay on screen.
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(card.getByTestId("question-next")).toBeInViewport();
  await expect(card.getByRole("button", { name: "Collapse" })).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeInViewport();
  if (desktop !== null) {
    await page.setViewportSize(desktop);
  }

  // Into the card with Tab; the keys do the rest.
  await tabTo(page, card.getByRole("radio"));
  await page.keyboard.press("3");
  await expect(card.getByRole("radio", { name: "AI-powered assistant" })).toBeChecked();
  await page.keyboard.press("Control+Enter");
  await expect(card.getByTestId("question-card-counter")).toHaveText("2/4");
  // The next question's first row took the focus its predecessor's row had.
  await page.keyboard.press("1");
  await page.keyboard.press("3");
  await page.keyboard.press("Meta+Enter");
  await expect(card.getByTestId("question-card-counter")).toHaveText("3/4");
  // Escape folds the card and hands focus to Expand; Enter opens it where it was.
  await page.keyboard.press("Escape");
  await expect(card).toHaveAttribute("data-collapsed", "true");
  await expect(card.getByRole("button", { name: "Expand" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-card-counter")).toHaveText("3/4");
  await expect(card.getByRole("button", { name: "Collapse" })).toBeFocused();
  await tabTo(page, card.getByTestId("question-skip"));
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-card-counter")).toHaveText("4/4");
  // Backwards into a group with nothing chosen lands on its last radio; the
  // number picks whichever row it names.
  await tabTo(page, card.getByRole("radio"), "Shift+Tab");
  await page.keyboard.press("2");
  await page.keyboard.press("Control+Enter");
  await expect(card).toHaveCount(0);
  // The card closed under the keyboard; focus went on to the composer.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();

  const reply = await agentReply(page);
  for (const word of ["AI-powered assistant", "iOS", "Web", "Nothing yet"]) {
    expect(reply).toContain(word);
  }
  const row = await questionRow(page);
  await expect(row).toContainText("Asked 4 questions");
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-answer")).toHaveText([
    "AI-powered assistant",
    "iOS, Web",
    "Skipped",
    "Nothing yet",
  ]);
});

test("Skip on the only question answers it as skipped", async ({ page }) => {
  test.setTimeout(360_000);
  const card = await asked(page, "skip this one");
  await card.getByTestId("question-skip").click();
  await expect(card).toHaveCount(0);
  await agentReply(page);
  const row = await questionRow(page);
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-answer")).toHaveText(["Skipped"]);
});

test("the card's × dismisses the question, and the run goes on", async ({ page }) => {
  test.setTimeout(360_000);
  const card = await asked(page, "dismiss this one");
  await card.getByRole("button", { name: "Dismiss the questions" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("[data-testid='row-run'][data-outcome]").last()).toBeVisible({
    timeout: ASKED_MS,
  });
  const row = await questionRow(page);
  await expect(row).toContainText("Asked 1 question");
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-dismissal")).toHaveText("Dismissed");
});

test("a message sent while the card is open dismisses it and is delivered", async ({ page }) => {
  test.setTimeout(360_000);
  const card = await asked(page, "answer in my own words");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Use whatever is simplest.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("row-message-user").last()).toContainText(
    "Use whatever is simplest.",
  );
  const row = await questionRow(page);
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-dismissal")).toHaveText(
    "Dismissed: you sent a message instead",
  );
  // The agent got the message itself: the double repeats what it was told.
  await expect(
    page
      .getByTestId("row-message-assistant")
      .filter({ hasText: QUESTION_ECHO_PREFIX })
      .filter({ hasText: "Use whatever is simplest." }),
  ).not.toHaveCount(0, { timeout: ASKED_MS });
  await expect(page.locator("[data-testid='row-run'][data-outcome]").last()).toBeVisible({
    timeout: ASKED_MS,
  });
});

test("an answer after the sandbox stopped idle resumes the run with it", async ({ page }) => {
  test.setTimeout(600_000);
  const card = await asked(page, "wait for me");
  // A run waiting on its question is idle: the sandbox stops on the lane's
  // short timer, and the card stays open.
  // The sandbox's state is read in the side panel's Modal tab.
  await openModalPanel(page);
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Stopped after going idle", {
    timeout: (LANE_IDLE_ALARM_SECONDS + 120) * 1000,
  });
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(card).toBeVisible();
  await pinSessionDetails(page);
  await expect(page.getByTestId("needs-you")).toHaveText("The agent asked you a question");
  await card.getByText("DuckDB").click();
  await card.getByRole("button", { name: /Submit/ }).click();
  await expect(card).toHaveCount(0);
  // A new sandbox, and the answer as the resumed run's message.
  await openModalPanel(page);
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Running", { timeout: ASKED_MS });
  await page.getByRole("button", { name: "Close panel" }).click();
  const reply = await agentReply(page);
  expect(reply).toContain("Answers to your questions");
  expect(reply).toContain("DuckDB");
  const row = await questionRow(page);
  await row.getByTestId("question-row-trigger").click();
  await expect(row.getByTestId("question-row-answer")).toHaveText(["DuckDB"]);
});
