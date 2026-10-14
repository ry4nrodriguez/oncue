import { expect, test } from "@playwright/test";

/**
 * Settings and the account row, driven through `/dev/home` because the product
 * routes sit behind Clerk. Nobody is signed in there, so the profile shows its
 * fallbacks, which every page shows for its first frames.
 */

const SIDEBAR_RAIL = "[aria-label='Pin sidebar open'], [aria-label='Unpin sidebar']";

/**
 * Opens the collapsed sidebar by hovering the strip at the left edge. Clicking
 * a pin button is unreliable: there are two, and once the panel slides in the
 * wordmark covers the `AppShell` one and intercepts the click.
 */
async function openSidebar(page: import("@playwright/test").Page) {
  await page.goto("/dev/home");
  await page.mouse.move(2, 300);
  await expect
    .poll(async () => (await page.getByRole("img", { name: "OnCue" }).boundingBox())?.x ?? -1)
    .toBeGreaterThanOrEqual(0);
}

test("the sidebar shows the wordmark, not the word", async ({ page }) => {
  await openSidebar(page);

  // An SVG of the same bitmap the home screen burns, so it is found by its
  // accessible name rather than by a text node.
  const mark = page.getByRole("img", { name: "OnCue" });
  await expect(mark).toBeVisible();

  const box = await mark.boundingBox();
  // Small enough to sit in a header rather than being the home screen's size.
  expect(box?.height ?? 0).toBeLessThan(32);
});

test("the account row opens a menu with settings and log out", async ({ page }) => {
  await openSidebar(page);

  await page.locator("[aria-label^='Account:']").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
});

test("settings is reachable from the account row", async ({ page }) => {
  await openSidebar(page);

  await page.locator("[aria-label^='Account:']").click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});

test("settings offers profile, repositories, model providers, harnesses, agent permissions, and Modal", async ({
  page,
}) => {
  await page.goto("/dev/home?at=/settings/profile");

  const nav = page.getByRole("navigation", { name: "Settings sections" });
  // Back, then the sections and nothing else, so adding a section fails here
  // until the test is updated deliberately.
  await expect(nav.getByRole("link")).toHaveCount(7);
  await expect(nav.getByRole("link", { name: "Back" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Profile" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Repositories" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Model providers" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Harnesses" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Agent permissions" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Modal" })).toBeVisible();
});

test("settings replaces the shell, so there is only one rail", async ({ page }) => {
  await page.goto("/dev/home?at=/settings/profile");

  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  // The session sidebar and its collapse control belong to the app, not here.
  await expect(page.getByRole("link", { name: "New session" })).toHaveCount(0);
  await expect(page.locator(SIDEBAR_RAIL)).toHaveCount(0);
});

test("back leaves settings for the app", async ({ page }) => {
  await page.goto("/dev/home?at=/settings/profile");

  await page.getByRole("link", { name: "Back" }).click();

  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("repositories lives inside settings now", async ({ page }) => {
  await page.goto("/dev/home?at=/settings/repositories");

  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
});
