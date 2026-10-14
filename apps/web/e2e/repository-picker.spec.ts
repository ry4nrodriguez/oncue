import { expect, test } from "@playwright/test";

/**
 * The composer's repository picker, driven by a real mouse through `/dev/home`.
 * A menu painted beneath the page lets the background win the hit test, so a
 * click on a row closes the menu instead. jsdom has no layout and cannot see
 * which element is on top; only a browser can.
 */

const TRIGGER = "button:has-text('acme/')";
const ROWS = "[role='menuitemradio']";

test("a mouse click on a row actually changes the selected repository", async ({ page }) => {
  await page.goto("/dev/home");

  const trigger = page.locator(TRIGGER).first();
  await expect(trigger).toBeVisible();
  const before = (await trigger.textContent())?.trim();

  await trigger.click();

  // `click()` is a real press at the element's hit point, so it fails if
  // something is painted over the row.
  const target = page.locator(ROWS).filter({ hasText: "acme/billing" });
  await expect(target).toBeVisible();
  await target.click();

  await expect(trigger).toContainText("acme/billing");
  expect((await trigger.textContent())?.trim()).not.toBe(before);
});

test("the menu is the topmost element at its own rows", async ({ page }) => {
  await page.goto("/dev/home");
  await page.locator(TRIGGER).first().click();

  const row = page.locator(ROWS).nth(3);
  await expect(row).toBeVisible();

  // Ask the browser what is actually on top at the row's centre.
  const onTop = await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit?.closest("[role='menuitemradio']") === element;
  });

  expect(onTop, "the page background is painted over the menu rows").toBe(true);
});

test("the list scrolls rather than growing past the viewport", async ({ page }) => {
  await page.goto("/dev/home");
  await page.locator(TRIGGER).first().click();

  const row = page.locator(ROWS).first();
  await expect(row).toBeVisible();

  // Walk up to the first ancestor the browser actually scrolls, rather than a
  // selector tied to the current markup.
  const { scrollHeight, clientHeight, fitsOnScreen } = await row.evaluate((element) => {
    let node: HTMLElement | null = element as HTMLElement;
    while (node !== null) {
      const overflowY = getComputedStyle(node).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > 0) {
        break;
      }
      node = node.parentElement;
    }
    if (node === null) {
      return { scrollHeight: 0, clientHeight: 0, fitsOnScreen: false };
    }
    return {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      fitsOnScreen: node.getBoundingClientRect().bottom <= window.innerHeight,
    };
  });

  expect(scrollHeight, "the fixture should overflow the capped height").toBeGreaterThan(
    clientHeight,
  );
  expect(fitsOnScreen, "the menu runs past the bottom of the viewport").toBe(true);
});

/**
 * The composer's other controls are checked the same way: the panel is topmost
 * at its rows, and a real press changes the trigger. The agent chip holds the
 * harness, the model, and the effort in one panel.
 */
const ADD_TRIGGER = "button[aria-label='Add']";
const AGENT_CHIP = "[data-testid='agent-chip']";
const MODEL_ROWS = "[data-testid='model-row']";

test("the add menu is clickable rather than painted under the page", async ({ page }) => {
  await page.goto("/dev/home");
  await page.locator(ADD_TRIGGER).click();

  const row = page.getByRole("menuitem", { name: /Add photos and files/ });
  await expect(row).toBeVisible();

  const onTop = await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit?.closest("[role='menuitem']") === element;
  });
  expect(onTop, "the page is painted over the add menu").toBe(true);
});

test("a mouse click changes the model", async ({ page }) => {
  await page.goto("/dev/home");
  const chip = page.locator(AGENT_CHIP);
  // The recommended catalog row, until something else is chosen.
  await expect(chip).toContainText("Opus 5.5");

  await chip.click();
  // Two connections on one provider, and each model listed once.
  await page.locator(MODEL_ROWS).filter({ hasText: "Haiku 4.5" }).click();

  await expect(chip).toContainText("Haiku 4.5");
  await expect(chip).toHaveAccessibleName(/^Model: Haiku 4\.5/);
});

test("the agent panel is the topmost element at its own rows", async ({ page }) => {
  await page.goto("/dev/home");
  await page.locator(AGENT_CHIP).click();

  const row = page.locator(MODEL_ROWS).nth(1);
  await expect(row).toBeVisible();
  const onTop = await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit?.closest("[data-testid='model-row']") === element;
  });
  expect(onTop, "the page is painted over the agent panel's rows").toBe(true);
});

test("a mouse click changes the effort level", async ({ page }) => {
  await page.goto("/dev/home");
  const chip = page.locator(AGENT_CHIP);
  await expect(chip).toContainText("medium");

  await chip.click();
  await page.getByRole("button", { name: "low", exact: true }).click();

  await expect(chip).toContainText("low");
  await expect(chip).toHaveAccessibleName("Model: Opus 5.5, low effort");
});

test("every composer menu opens below its trigger", async ({ page }) => {
  // Tall enough that the agent panel, the longest of them, has room below Home's composer.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/dev/home");

  for (const [trigger, row] of [
    [ADD_TRIGGER, "[role='menuitem']"],
    [TRIGGER, "[role='menuitemradio']"],
  ] as const) {
    await page.locator(trigger).first().click();
    const triggerBox = await page.locator(trigger).first().boundingBox();
    const rowBox = await page.locator(row).first().boundingBox();
    expect(rowBox?.y ?? 0, `${trigger} opened upward`).toBeGreaterThan(triggerBox?.y ?? 0);
    await page.keyboard.press("Escape");
  }

  await page.locator(AGENT_CHIP).click();
  const chipBox = await page.locator(AGENT_CHIP).boundingBox();
  const panelBox = await page.getByTestId("agent-panel").boundingBox();
  expect(panelBox?.y ?? 0, "the agent panel opened upward").toBeGreaterThan(chipBox?.y ?? 0);
});

test("the add menu says plugins are still to come, without offering them", async ({ page }) => {
  await page.goto("/dev/home");
  await page.locator(ADD_TRIGGER).click();

  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Plugins and skills coming soon");
  // A line about the menu, not a row in it, so it must not be reachable.
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: /coming soon/ })).toHaveCount(0);
});

test("the add panel spans the composer and covers the strip", async ({ page }) => {
  await page.goto("/dev/home");

  const strip = page.getByTestId("composer-strip");
  const stripBox = await strip.boundingBox();
  const composer = page.getByRole("textbox", { name: "Message" }).locator("xpath=../..");
  const composerBox = await composer.boundingBox();

  await page.locator(ADD_TRIGGER).click();
  const panelBox = await page.getByRole("menu").boundingBox();

  expect(panelBox).not.toBeNull();
  expect(composerBox).not.toBeNull();

  // Same width and left edge as the composer, rather than the width of the
  // button that opened it.
  expect(Math.abs((panelBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThan(2);
  expect(Math.abs((panelBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThan(2);

  // Its top edge lands on the strip, so the repository and the agent chip are
  // covered rather than pushed further down the page.
  expect(panelBox?.y ?? 0).toBeLessThanOrEqual((stripBox?.y ?? 0) + 2);
});
