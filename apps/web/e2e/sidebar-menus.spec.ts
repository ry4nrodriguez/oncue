import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * The sidebar's theme and account menus close when the pointer leaves them
 * (record 13, `src/features/home/sidebar-menu.ts`). Driven through `/dev/home`
 * with a real mouse: leaving for 300 ms closes a menu, moving into it keeps
 * it, and a keyboard-opened menu stays until Escape. `ONCUE_SHOTS=1` also
 * writes screenshots.
 */

const SHOTS = process.env.ONCUE_SHOTS === "1";
const SHOTS_DIR = fileURLToPath(
  new URL("../test-results/screenshots/resume-base-menus-review-tree/", import.meta.url),
);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS_DIR}${name}.png` });
}

/** The unpinned sidebar slides in while the strip at the left edge is hovered (`settings.spec.ts`). */
async function revealSidebar(page: Page) {
  await page.goto("/dev/home");
  await page.mouse.move(2, 300);
  await expect.poll(() => sidebarLeft(page)).toBeGreaterThanOrEqual(0);
}

async function sidebarLeft(page: Page): Promise<number> {
  return (await page.getByTestId("sidebar").boundingBox())?.x ?? -1;
}

async function pinSidebar(page: Page) {
  await revealSidebar(page);
  await page.getByTestId("sidebar").getByRole("button", { name: "Pin sidebar open" }).click();
  await expect(
    page.getByTestId("sidebar").getByRole("button", { name: "Unpin sidebar" }),
  ).toBeVisible();
}

/** Far from the sidebar and from anything a menu could open over. */
async function moveAway(page: Page) {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width - 20, 40, { steps: 4 });
}

const menu = (page: Page) => page.getByRole("menu");

test("a menu opened by a click closes once the pointer has left it and its trigger", async ({
  page,
}) => {
  await pinSidebar(page);
  await page.getByTestId("theme-toggle").click();
  await expect(menu(page)).toBeVisible();
  await shot(page, "theme-menu-open-light");
  await moveAway(page);
  await expect(menu(page)).toBeHidden({ timeout: 2_000 });

  await page.locator("[aria-label^='Account:']").click();
  await expect(menu(page)).toBeVisible();
  await moveAway(page);
  await expect(menu(page)).toBeHidden({ timeout: 2_000 });
});

test("moving from the trigger into the menu keeps it open, and a choice still works", async ({
  page,
}) => {
  await pinSidebar(page);
  const trigger = page.getByTestId("theme-toggle");
  await trigger.click();
  const dark = menu(page).getByRole("menuitemradio", { name: "Dark" });
  await expect(dark).toBeVisible();
  // Diagonally, in steps, the way a hand moves: out of the trigger, across
  // the gap, into the menu. Then a wait well past the close delay.
  const box = (await dark.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(900);
  await expect(menu(page)).toBeVisible();
  await dark.click();
  await expect(menu(page)).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(trigger).toHaveAttribute("aria-label", "Theme: Dark");

  await trigger.click();
  await expect(menu(page)).toBeVisible();
  await shot(page, "theme-menu-open-dark");
  // Back to where the other tests expect it.
  await menu(page).getByRole("menuitemradio", { name: "System" }).click();
  await expect(trigger).toHaveAttribute("aria-label", "Theme: System");
});

test("re-entering within the grace period keeps the menu open", async ({ page }) => {
  await pinSidebar(page);
  const trigger = page.getByTestId("theme-toggle");
  await trigger.click();
  await expect(menu(page)).toBeVisible();
  const box = (await trigger.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // Out to the main area and straight back, well inside 300 ms.
  await page.mouse.move(box.x + 200, box.y - 200);
  await trigger.hover();
  await page.waitForTimeout(900);
  await expect(menu(page)).toBeVisible();
});

test("when the unpinned sidebar slides shut, its open menu goes with it", async ({ page }) => {
  await revealSidebar(page);
  await page.getByTestId("theme-toggle").click();
  await expect(menu(page)).toBeVisible();
  // The open menu holds the sidebar out while the pointer is in the menu,
  // which is outside the sidebar's own box.
  const item = menu(page).getByRole("menuitemradio", { name: "Light" });
  await item.hover();
  await page.waitForTimeout(600);
  expect(await sidebarLeft(page)).toBeGreaterThanOrEqual(0);
  await shot(page, "theme-menu-unpinned");

  await moveAway(page);
  await expect(menu(page)).toBeHidden({ timeout: 2_000 });
  await expect.poll(() => sidebarLeft(page)).toBeLessThan(0);
});

test("a menu opened from the keyboard stays open until Escape", async ({ page }) => {
  await pinSidebar(page);
  const trigger = page.getByTestId("theme-toggle");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await moveAway(page);
  await page.waitForTimeout(900);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("at phone width a tapped menu opens and a choice still works", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await pinSidebar(page);
  await page.locator("[aria-label^='Account:']").click();
  await expect(menu(page).getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await shot(page, "account-menu-mobile");
  await menu(page).getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});
