import { expect, test } from "@playwright/test";
import { scan } from "./a11y-scan";

/**
 * No serious axe violations (record 13) on Home, the session screen, and
 * settings. The product routes sit behind Clerk with no bypass, so these drive
 * the dev harnesses. Only `serious` and `critical` impacts fail.
 */

const SHOT = "/tmp/a11y-lane/pr11-a11y.png";

async function audit(
  page: import("@playwright/test").Page,
  url: string,
  ready: string,
  theme: "light" | "dark" = "light",
) {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(url);
  await page.locator(ready).first().waitFor({ state: "visible" });
  return scan(page, url, theme);
}

test("the session screen has no serious accessibility violations", async ({ page }) => {
  const blocking = await audit(page, "/dev/session", "[data-testid='session-header']");
  expect(blocking, blocking.join("\n")).toEqual([]);
});

test("the approval state has no serious accessibility violations", async ({ page }) => {
  const blocking = await audit(page, "/dev/session?fixture=approval", "[data-testid='needs-you']");
  expect(blocking, blocking.join("\n")).toEqual([]);
});

test("the not-found state has no serious accessibility violations", async ({ page }) => {
  const blocking = await audit(
    page,
    "/dev/session?fixture=not-found",
    "[data-testid='session-not-found']",
  );
  expect(blocking, blocking.join("\n")).toEqual([]);
});

// The composer's notes: a paused run's reason, and a send held while disconnected.
test("the composer's notes have no serious accessibility violations", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    const paused = await audit(
      page,
      "/dev/session?fixture=paused",
      "[data-testid='composer-model-failure']",
      theme,
    );
    expect(paused, `paused, ${theme}\n${paused.join("\n")}`).toEqual([]);

    // A rejected key: the note with its link, the timeline's pause row, and the rail.
    for (const fixture of ["key-rejected", "key-rejected-stopped"]) {
      const rejected = await audit(
        page,
        `/dev/session?fixture=${fixture}`,
        "[data-testid='composer-model-failure']",
        theme,
      );
      expect(rejected, `${fixture}, ${theme}\n${rejected.join("\n")}`).toEqual([]);
    }
    // The key replaced, as a chat opens: with the session details unpinned.
    // Pinned, they add a Continue button whose contrast is an open gap of its own.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/dev/session?fixture=key-replaced");
    await page.getByRole("button", { name: "Unpin session details" }).click();
    await page.getByTestId("composer-model-failure").waitFor({ state: "visible" });
    const replaced = await scan(page, "key replaced", theme);
    expect(replaced, `key-replaced, ${theme}\n${replaced.join("\n")}`).toEqual([]);

    await audit(
      page,
      "/dev/session?fixture=disconnected",
      "[data-testid='composer-send-notice']",
      theme,
    );
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("held");
    await message.press("Enter");
    await page.getByTestId("composer-withdraw").waitFor({ state: "visible" });
    const held = await scan(page, "held message", theme);
    expect(held, `held, ${theme}\n${held.join("\n")}`).toEqual([]);

    // The review tree's failed listing, with its Retry.
    await audit(page, "/dev/session?fixture=review-tree", "[data-testid='row-changes']", theme);
    await page.getByTestId("rail-changes").click();
    await page.getByRole("button", { name: "Show file tree" }).click();
    await page.getByTestId("tree-listing-failed").waitFor({ state: "visible" });
    const tree = await scan(page, "tree listing failed", theme);
    expect(tree, `tree, ${theme}\n${tree.join("\n")}`).toEqual([]);
  }
});

// Record 13 requires contrast in both themes, and the two palettes are independent.
test("the session screen has no serious accessibility violations in dark", async ({ page }) => {
  const blocking = await audit(page, "/dev/session", "[data-testid='session-header']", "dark");
  expect(blocking, blocking.join("\n")).toEqual([]);
});

// The expandable action rows, with their mark, state dot, and failure phrase.
test("the action rows have no serious accessibility violations", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    const blocking = await audit(
      page,
      "/dev/session?fixture=actions",
      "[data-testid='row-sandbox']",
      theme,
    );
    expect(blocking, `${theme}\n${blocking.join("\n")}`).toEqual([]);
  }
});

test("Home has no serious accessibility violations", async ({ page }) => {
  const blocking = await audit(page, "/dev/home", "[aria-label='Message']");
  expect(blocking, blocking.join("\n")).toEqual([]);
});

test("Home has no serious accessibility violations in dark", async ({ page }) => {
  const blocking = await audit(page, "/dev/home", "[aria-label='Message']", "dark");
  expect(blocking, blocking.join("\n")).toEqual([]);
});

// The agent chip's panel: the harness and model rows and the effort slider drawn as text, audited open.
test("the agent chip's panel has no serious accessibility violations", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await audit(page, "/dev/home", "[data-testid='agent-chip']", theme);
    await page.getByTestId("agent-chip").click();
    await page.getByTestId("model-row").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "max", exact: true }).waitFor({ state: "visible" });
    const panel = await scan(page, "agent panel, open", theme);
    expect(panel, panel.join("\n")).toEqual([]);
    await page.keyboard.press("Escape");
  }
});

// The Model providers page. The harness identity is stubbed, so the Worker may
// answer 401 and the page shows its denied line; the audit covers either.
test("the model providers page has no serious accessibility violations", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    const blocking = await audit(
      page,
      "/dev/home?at=/settings/model-providers",
      "h1:has-text('Model providers')",
      theme,
    );
    expect(blocking, blocking.join("\n")).toEqual([]);
  }
});

test("the setup steps have no serious accessibility violations", async ({ page }) => {
  for (const fixture of [
    "connect-github",
    "github-stuck",
    "github-stuck-cancelled",
    "github-stuck-no-repositories",
    "needs-model",
  ]) {
    const blocking = await audit(page, `/dev/home?fixture=${fixture}&at=/setup`, "h1");
    expect(blocking, `${fixture}\n${blocking.join("\n")}`).toEqual([]);
  }
  // Step 3: Home's gate sends a workspace without Modal straight to it.
  for (const theme of ["light", "dark"] as const) {
    const blocking = await audit(
      page,
      "/dev/home?fixture=connect-modal&at=/",
      "h1:has-text('Connect your Modal account')",
      theme,
    );
    expect(blocking, `connect-modal ${theme}\n${blocking.join("\n")}`).toEqual([]);
  }
});

// The change card, and the review panel on its Review and Tests tabs.
test("the change card and the review panel have no serious accessibility violations", async ({
  page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    const card = await audit(
      page,
      "/dev/session?fixture=review",
      "[data-testid='row-changes']",
      theme,
    );
    expect(card, `change card, ${theme}\n${card.join("\n")}`).toEqual([]);

    await page.getByTestId("rail-changes").click();
    const panel = page.getByTestId("review-panel");
    await panel.getByTestId("review-diff-scroll").waitFor({ state: "visible" });
    const review = await scan(page, "review panel, Review tab", theme);
    expect(review, `review tab, ${theme}\n${review.join("\n")}`).toEqual([]);

    await panel.getByRole("tab", { name: "Tests" }).click();
    await panel.getByTestId("tests-check").first().waitFor({ state: "visible" });
    const tests = await scan(page, "review panel, Tests tab", theme);
    expect(tests, `tests tab, ${theme}\n${tests.join("\n")}`).toEqual([]);
    if (theme === "light") {
      await page.screenshot({ path: SHOT, fullPage: true });
    }
  }
});

// The policy confirmation card, the settled policy lines, and the side panel's
// Pull request tab.
test("the policy card has no serious accessibility violations", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    const card = await audit(
      page,
      "/dev/session?fixture=policy",
      "[data-testid='policy-card']",
      theme,
    );
    expect(card, `policy card, ${theme}\n${card.join("\n")}`).toEqual([]);
    // The card's controls are real buttons a keyboard reaches, named by what they do.
    await expect(page.getByTestId("policy-card").getByRole("button")).toHaveText([
      "Decline",
      "Allow",
    ]);
    await expect(page.getByTestId("row-policy-updated")).toHaveCount(2);

    // The pull request has no pane of its own; the rail names it.
    if (theme === "light") {
      await page.screenshot({ path: "/tmp/a11y-lane/pr12-a11y.png", fullPage: true });
    }
  }
});

// Home with a rejected key: the banner, and the picker's rows that say so.
test("Home's rejected-key banner and picker rows have no serious accessibility violations", async ({
  page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    const banner = await audit(
      page,
      "/dev/home?fixture=key-rejected",
      "[data-testid='home-key-banner']",
      theme,
    );
    expect(banner, `banner, ${theme}\n${banner.join("\n")}`).toEqual([]);

    await page.getByTestId("agent-chip").click();
    await page.locator("[data-testid^='model-replace-']").first().waitFor({ state: "visible" });
    const picker = await scan(page, "rejected key in the picker", theme);
    expect(picker, `picker, ${theme}\n${picker.join("\n")}`).toEqual([]);
  }
});
