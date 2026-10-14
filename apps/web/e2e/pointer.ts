import type { Page } from "@playwright/test";

/**
 * Moves the pointer to the screen's bottom-right corner, clear of the sidebar.
 * The unpinned sidebar slides in while the pointer is over the screen's left
 * edge, and headless Chromium on Linux starts a page with its pointer in the
 * top-left corner. A lane whose first click lands where the open sidebar would
 * be calls this once the page has loaded.
 */
export async function pointerOffSidebar(page: Page): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width - 1, size.height - 1);
}
