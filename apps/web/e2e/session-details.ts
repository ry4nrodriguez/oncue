import { expect, type Page } from "@playwright/test";

/**
 * A chat opens with the session details unpinned, so a lane that reads or
 * clicks them pins them first. It waits until either the details or the
 * header's pin is on screen, since a re-render can briefly show neither, and
 * is a no-op when they are already pinned.
 */
export async function pinSessionDetails(page: Page): Promise<void> {
  // Exact, since "Unpin session details" contains the same words.
  const pin = page.getByRole("button", { name: "Pin session details", exact: true });
  const rail = page.getByTestId("context-rail");
  await expect(pin.or(rail).first()).toBeVisible({ timeout: 15_000 });
  if (await pin.isVisible()) {
    await pin.click();
  }
  await expect(rail).toBeVisible();
}

/**
 * Brings the side panel's Modal tab to the front, where the sandbox's state
 * and its actions live: from the tab if it is open, else from the panel's list
 * of views or its "+", opening the panel first when it is closed.
 */
export async function openModalPanel(page: Page): Promise<void> {
  const pane = page.getByTestId("panel-modal");
  if (await pane.isVisible()) {
    return;
  }
  const panel = page.getByTestId("session-panel");
  if (!(await panel.isVisible())) {
    // By its test id: its name also says the sandbox's state while one is up.
    await page.getByTestId("panel-toggle").click();
    await expect(panel).toBeVisible();
  }
  const tab = page.getByTestId("panel-tab-modal");
  const launch = page.getByTestId("panel-open-modal");
  if (await tab.isVisible()) {
    await tab.click();
  } else if (await launch.isVisible()) {
    await launch.click();
  } else {
    await page.getByRole("button", { name: "Open another tab" }).click();
    await page.getByRole("menuitem", { name: "Modal" }).click();
  }
  await expect(pane).toBeVisible();
}
