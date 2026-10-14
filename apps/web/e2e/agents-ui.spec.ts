import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { scan } from "./a11y-scan";

/**
 * The subagent rows, the running-agents pill, and the side panel's Agents
 * view (record 13), driven by a real mouse through `/dev/session?fixture=agents`:
 * three subagents, one running a command, one that reported, one that failed.
 * Checks layout and hit testing jsdom cannot, where focus goes, accessibility
 * in both themes, and that nothing scrolls sideways or is cut off at phone
 * width.
 *
 * `ONCUE_AGENT_SHOTS=<dir>` also keeps a picture of each state at 1280 and
 * 375 pixels, light and dark.
 */

const SHOTS = process.env.ONCUE_AGENT_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function open(
  page: Page,
  theme: "light" | "dark",
  width: number,
  fixture: "agents" | "agents-working" = "agents",
): Promise<void> {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 860 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/dev/session?fixture=${fixture}`);
  await expect(page.getByTestId("row-agent")).toHaveCount(3);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** The page never scrolls sideways (record 13's phone width). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Nothing in the side panel's scroller, or in the parts named, runs past its
 * own right edge. The page's width cannot show this: the panel clips what
 * overflows it, so a line cut mid-word leaves the document as wide as before.
 */
async function expectWhole(page: Page, scroller: string, parts: readonly string[]): Promise<void> {
  const panel = await page.getByTestId("session-panel").boundingBox();
  const viewport = page.viewportSize();
  if (panel === null || viewport === null) {
    throw new Error("the side panel is not laid out");
  }
  const edge = Math.min(panel.x + panel.width, viewport.width);
  for (const id of [scroller, ...parts]) {
    const part = page.getByTestId(id);
    const box = await part.boundingBox();
    expect(box, id).not.toBeNull();
    expect(box?.x ?? 0, `${id} starts inside the panel`).toBeGreaterThanOrEqual(panel.x - 0.5);
    expect((box?.x ?? 0) + (box?.width ?? 0), `${id} ends inside the panel`).toBeLessThanOrEqual(
      edge + 0.5,
    );
    const hidden = await part.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(hidden, `${id} hides nothing to its side`).toBeLessThanOrEqual(0);
  }
}

/** The open detail: its meta line with the status word, and its prompt. */
async function expectDetailWhole(page: Page): Promise<void> {
  await expectWhole(page, "agent-detail-scroll", ["agent-detail-meta", "agent-prompt"]);
  // The words of the meta line each end inside it, the status and its duration among them.
  const meta = page.getByTestId("agent-detail-meta");
  const line = await meta.boundingBox();
  for (const fact of await meta.locator(":scope > span").all()) {
    const box = await fact.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (line?.x ?? 0) + (line?.width ?? 0) + 0.5,
    );
  }
  await expect(meta).toContainText(/Running \d/);
  // The prompt's own box clips, so what it holds is measured too.
  const clipped = await page
    .getByTestId("agent-prompt")
    .locator("[data-expanded]")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(clipped, "the prompt hides nothing to its side").toBeLessThanOrEqual(0);
}

test("a subagent's row opens its detail, and the pill opens the list", async ({ page }) => {
  await open(page, "light", 1280);
  const pill = page.getByTestId("running-agents-pill");
  await expect(pill).toHaveText("1 running agent");
  // While it moves, the running row shows its description alone.
  const runningRow = page.getByTestId("row-agent").last();
  await expect(runningRow).toContainText("Review recent pull requests");
  await expect(runningRow.getByTestId("row-agent-status")).toBeHidden();

  // The row says it is running in words, for a reader the shimmer does not reach.
  await page
    .getByRole("button", {
      name: "Open subagent: Review recent pull requests, Running",
      exact: true,
    })
    .click();
  const panel = page.getByTestId("session-panel");
  await expect(panel.getByTestId("agent-detail-title")).toHaveText("Review recent pull requests");
  await expect(panel.getByRole("button", { name: "Show more" })).toBeVisible();
  await panel.getByRole("button", { name: "Show more" }).click();
  await expect(panel.getByTestId("agent-prompt")).toContainText(
    "Keep the report under about 1,200 words.",
  );
  await panel.getByRole("button", { name: "Back to agents" }).click();
  await expect(panel.getByTestId("agent-running-row")).toHaveCount(1);
  await expect(panel.getByTestId("agent-running-row")).toContainText(/General·\d/);
  await panel.getByLabel("Close panel").click();

  await pill.click();
  await expect(page.getByTestId("panel-tab-agents")).toHaveAttribute("aria-current", "true");
  await expect(panel.getByTestId("agents-running")).toBeVisible();
  await expect(panel.getByTestId("agent-finished-row")).toHaveCount(2);
});

test("with motion turned down, a running subagent's row says so in a word", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "light", 1280);
  // Nothing shimmers, so the word is what tells running from completed.
  const rows = page.getByTestId("row-agent");
  await expect(rows.last().getByTestId("row-agent-status")).toBeVisible();
  await expect(rows.last().getByTestId("row-agent-status")).toHaveText("Running");
  await expect(rows.first().getByTestId("row-agent-status")).toHaveCount(0);
  expect(await scan(page, "agents timeline, reduced motion", "light")).toEqual([]);
  await shoot(page, "timeline-reduced-motion-1280-light");
});

test("focus follows the reader into a subagent's detail and back to its row", async ({ page }) => {
  await open(page, "light", 1280);
  await page.getByTestId("running-agents-pill").click();
  const panel = page.getByTestId("session-panel");

  // By keyboard, as a screen reader's user would: each control that opens or
  // closes the detail removes itself, and focus must not fall to the page.
  await panel.getByTestId("agent-view-transcript").focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("agent-detail-title")).toBeFocused();
  await panel.getByRole("button", { name: "Back to agents" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("agent-view-transcript")).toBeFocused();

  const finished = panel.getByTestId("agent-finished-row").filter({ hasText: "Check the flaky" });
  await finished.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("agent-detail-title")).toHaveText("Check the flaky test");
  await expect(panel.getByTestId("agent-detail-title")).toBeFocused();
  // The heading is a place to read from, and the keyboard goes on from it.
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByRole("button", { name: "Back to agents" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(finished).toBeFocused();
});

test("the launcher opens the Agents list after its tab was closed on a subagent", async ({
  page,
}) => {
  await open(page, "light", 1280);
  const panel = page.getByTestId("session-panel");
  await page.getByTestId("row-agent").filter({ hasText: "Review recent pull requests" }).click();
  await expect(panel.getByTestId("agent-detail-title")).toHaveText("Review recent pull requests");

  // Closing the only tab shows the list of views; Agents from there is its list.
  await panel.getByRole("button", { name: "Close Agents tab" }).click();
  await panel.getByTestId("panel-open-agents").click();
  await expect(panel.getByTestId("agents-running")).toBeVisible();
  await expect(panel.getByTestId("agent-detail")).toHaveCount(0);

  // A subagent's own row still lands on that subagent.
  await page.getByTestId("row-agent").filter({ hasText: "Read the deployment notes" }).click();
  await expect(panel.getByTestId("agent-detail-title")).toHaveText("Read the deployment notes");
});

test("the pill stands beside the line that says what the agent is doing now", async ({ page }) => {
  await open(page, "light", 1280, "agents-working");
  const line = page.getByTestId("activity-line");
  const trigger = line.getByTestId("activity-trigger");
  const pill = line.getByTestId("running-agents-pill");
  await expect(trigger).toContainText("pnpm test");
  await expect(pill).toHaveText("1 running agent");
  await expect(page.getByTestId("running-agents-pill")).toHaveCount(1);
  const words = await trigger.boundingBox();
  const beside = await pill.boundingBox();
  if (words === null || beside === null) {
    throw new Error("the live line is not laid out");
  }
  // One line: the pill's middle is within the line's height, and it starts
  // right after the line's words, not at the far edge of the timeline.
  const middle = beside.y + beside.height / 2;
  expect(middle).toBeGreaterThan(words.y);
  expect(middle).toBeLessThan(words.y + words.height);
  expect(beside.x).toBeGreaterThanOrEqual(words.x + words.width);
  expect(beside.x - (words.x + words.width)).toBeLessThanOrEqual(16);
  expect(await scan(page, "agents working timeline, light", "light")).toEqual([]);
  await shoot(page, "timeline-working-1280-light");

  // Each is its own control: the pill opens the Agents view, the line its group.
  await pill.click();
  await expect(page.getByTestId("agents-running")).toBeVisible();
  await expect(page.getByTestId("row-activity").last()).toHaveAttribute("data-open", "false");
  await trigger.click();
  await expect(page.getByTestId("row-activity").last()).toHaveAttribute("data-open", "true");
  await expect(pill).toBeVisible();

  // At phone width the line's words give way and the pill stays whole.
  await open(page, "light", 375, "agents-working");
  await expectNoSidewaysScroll(page);
  await expect(page.getByTestId("activity-line").getByTestId("running-agents-pill")).toBeVisible();
  const narrow = await page.getByTestId("running-agents-pill").boundingBox();
  expect((narrow?.x ?? 0) + (narrow?.width ?? 0)).toBeLessThanOrEqual(375);
  await shoot(page, "timeline-working-375-light");
});

for (const theme of ["light", "dark"] as const) {
  test(`the Agents view has no serious accessibility violations in ${theme}`, async ({ page }) => {
    await open(page, theme, 1280);
    expect(await scan(page, `agents timeline, ${theme}`, theme)).toEqual([]);
    await page.getByTestId("running-agents-pill").click();
    await expect(page.getByTestId("agents-running")).toBeVisible();
    expect(await scan(page, `agents list, ${theme}`, theme)).toEqual([]);
    await page.getByTestId("agent-view-transcript").click();
    await page.getByRole("button", { name: "Show more" }).click();
    expect(await scan(page, `agent detail, ${theme}`, theme)).toEqual([]);
  });
}

for (const width of [1280, 375] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`the subagent states at ${width} pixels in ${theme}`, async ({ page }) => {
      await open(page, theme, width);
      await expectNoSidewaysScroll(page);
      await shoot(page, `timeline-${width}-${theme}`);

      await page.getByTestId("running-agents-pill").click();
      await expect(page.getByTestId("agents-running")).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectWhole(page, "agents-list", ["agent-running-row"]);
      await shoot(page, `agents-list-${width}-${theme}`);

      await page.getByTestId("agent-view-transcript").click();
      await expect(page.getByTestId("agent-detail")).toBeVisible();
      await expectDetailWhole(page);
      await shoot(page, `agent-detail-${width}-${theme}`);
      await page.getByRole("button", { name: "Show more" }).click();
      await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectDetailWhole(page);
      await shoot(page, `agent-detail-expanded-${width}-${theme}`);

      // The steps, opened, below the prompt.
      await page.getByRole("button", { name: "Show less" }).click();
      await page.getByTestId("agent-steps").getByTestId("activity-trigger").first().click();
      await shoot(page, `agent-steps-${width}-${theme}`);

      await page.getByRole("button", { name: "Back to agents" }).click();
      await page.getByTestId("agent-finished-row").first().click();
      await expect(page.getByTestId("agent-result")).toBeVisible();
      await shoot(page, `agent-finished-detail-${width}-${theme}`);
    });
  }
}
