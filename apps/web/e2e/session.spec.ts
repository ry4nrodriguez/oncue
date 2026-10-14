import { expect, test } from "@playwright/test";

/**
 * The real session components. The app is behind Clerk with no bypass, so
 * these drive `/dev/session`, a dev-only entry that renders `SessionScreen`
 * against a scripted socket; `pnpm build` fails if it reaches `dist`.
 */

test("the session screen streams a run into the timeline", async ({ page }) => {
  await page.goto("/dev/session");

  await expect(page.getByTestId("session-header")).toBeVisible();
  // A full-weight message row and, per record 13, the tool rows folded into
  // an activity group: the group's trigger is in view, the rows behind it.
  await expect(page.getByTestId(/row-message/).first()).toBeVisible();
  await expect(page.getByTestId("row-activity").first()).toBeVisible();
  await expect(page.getByTestId("row-tool").first()).toBeAttached();
});

test("the connection badge reaches caught up without duplicating rows", async ({ page }) => {
  await page.goto("/dev/session");

  // A healthy connection is not announced: the badge appears, in words, only
  // while the connection is connecting, reconnecting, or offline.
  await expect(page.getByTestId("row-message-assistant")).toHaveCount(1);
  await expect(page.getByTestId("connection-badge")).toHaveCount(0);

  // The replay batch and the live broadcast carry overlapping sequences; the
  // fold must not render the same message twice.
  await expect(page.getByTestId("row-message-assistant")).toHaveCount(1);
});

test("the context rail answers what needs me", async ({ page }) => {
  await page.goto("/dev/session?fixture=approval");

  await expect(page.getByTestId("context-rail")).toBeVisible();
  await expect(page.getByTestId("needs-you")).toBeVisible();
});

test("the rail can be unpinned and pinned again", async ({ page }) => {
  await page.goto("/dev/session");

  await page.getByLabel("Unpin session details").click();
  await expect(page.getByTestId("context-rail")).toBeHidden();

  await page.getByLabel("Pin session details").click();
  await expect(page.getByTestId("context-rail")).toBeVisible();
});

test("a draft survives a reload", async ({ page }) => {
  await page.goto("/dev/session");

  await page.getByRole("textbox", { name: "Message" }).fill("also cap the total boot wait");
  await page.reload();

  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "also cap the total boot wait",
  );
});

test("the composer submits on Enter and breaks the line on Shift+Enter", async ({ page }) => {
  await page.goto("/dev/session");

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("steer this run");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("steer this run\n");

  await message.press("Enter");
  await expect(message).toHaveValue("");
});

test("a refused session shows not found and stops connecting", async ({ page }) => {
  await page.goto("/dev/session?fixture=not-found");

  await expect(page.getByTestId("session-not-found")).toBeVisible();
  await expect(page.getByTestId("connection-badge")).toBeHidden();
});

test("both themes resolve every token", async ({ page }) => {
  await page.goto("/dev/session");
  await expect(page.getByTestId("session-header")).toBeVisible();

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);

    // A token that failed to resolve leaves the canvas transparent.
    const background = await page
      .locator("body")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("the header's toggle opens the side panel on its list of views", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  await page.getByRole("button", { name: "Open side panel" }).click();
  const launcher = page.getByTestId("panel-launcher");
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole("button")).toHaveText([
    "Modal",
    "Review",
    "Pull request",
    "Terminal",
    "Agents",
    "Preview",
  ]);
  await expect(page.getByTestId("panel-tabs")).toHaveCount(0);

  // Choosing a view opens it as a tab; closing that tab returns to the list.
  await launcher.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByTestId("panel-tab-terminal")).toHaveAttribute("aria-current", "true");
  await expect(launcher).toHaveCount(0);
  await page.getByRole("button", { name: "Close Terminal tab" }).click();
  await expect(launcher).toBeVisible();

  await page.getByLabel("Close panel").click();
  await expect(page.getByTestId("session-panel")).toBeHidden();
});

test("the side panel's Modal tab says what the sandbox is doing, and its stop asks before it acts", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=actions");

  // The sandbox's state lives in the side panel alone; the composer says nothing of it.
  // The button that opens the panel carries a dot and says the state while a sandbox is up.
  await expect(page.getByTestId("composer-strip")).not.toContainText("Modal");
  const toggle = page.getByTestId("panel-toggle");
  const dot = page.getByTestId("panel-sandbox-dot");
  await expect(toggle).toHaveAccessibleName("Open side panel. Sandbox starting");
  await expect(toggle).toHaveAttribute("title", "Open side panel. Sandbox starting");
  await expect(dot).toHaveAttribute("data-phase", "starting");
  const starting = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);
  await toggle.click();
  await page.getByTestId("panel-open-modal").click();
  const panel = page.getByTestId("session-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("panel-tab-modal")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Starting");
  await page.getByTestId("advance-sandbox").click();
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Running");
  await expect(toggle).toHaveAccessibleName("Close side panel. Sandbox running");
  await expect(dot).toHaveAttribute("data-phase", "running");
  // Caution while it starts, positive once it runs.
  expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    starting,
  );
  // What the controller and the sandbox printed while it started, verbatim.
  await expect(page.getByTestId("panel-modal-output")).toContainText("create answered in 412 ms");
  await expect(page.getByTestId("panel-modal-output")).toContainText("bridge dialing");

  // Another pane opens from the panel's own +, and the Terminal is what ran
  // in the sandbox: the fixture's clone is its first line.
  await page.getByRole("button", { name: "Open another tab" }).click();
  await page.getByRole("menuitem", { name: "Terminal" }).click();
  await expect(page.getByTestId("panel-tab-terminal")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("panel-terminal")).toContainText("acme/oncue");

  await page.getByTestId("panel-tab-modal").click();
  await page.getByTestId("stop-sandbox").click();
  const dialog = page.getByTestId("stop-sandbox-dialog");
  await expect(dialog).toContainText("cancels the current run");
  await page.getByRole("button", { name: "Keep running" }).click();
  await expect(dialog).toBeHidden();

  await page.getByLabel("Close panel").click();
  await expect(panel).toBeHidden();
});

test("a double click on Allow writes one policy command", async ({ page }) => {
  await page.goto("/dev/session?fixture=policy");
  const card = page.getByTestId("policy-card");
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Allow" }).dblclick();

  // Nothing answers in the harness, so both buttons stay off while it is out.
  await expect(card.getByRole("button", { name: "Allow" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Decline" })).toBeDisabled();
  const sent = await page.evaluate(() => window.__oncueSent ?? []);
  expect(
    sent.filter((frame) => (frame as { command: { type: string } }).command.type === "policy.set"),
  ).toHaveLength(1);
});

test("while the socket is down the composer says so, holds a sent message, and can withdraw it", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=disconnected");
  const notice = page.getByTestId("composer-send-notice");
  await expect(notice).toHaveAttribute("data-kind", "disconnected");
  await expect(page.getByTestId("connection-badge")).toBeVisible();

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("held until the connection is back");
  await message.press("Enter");
  await expect(notice).toHaveAttribute("data-kind", "queued");
  await expect(message).toHaveJSProperty("readOnly", true);

  await page.getByRole("button", { name: "Don't send" }).click();
  await expect(message).toHaveJSProperty("readOnly", false);
  await expect(message).toHaveValue("held until the connection is back");
  await expect(notice).toHaveAttribute("data-kind", "disconnected");
  expect(await page.evaluate(() => window.__oncueSent ?? [])).toEqual([]);
});

test("a paused run whose sandbox is up offers Stop run, not Send, and says why", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=paused");
  // The note names the model failure the run paused on, then why no message can go yet.
  const note = page.getByTestId("composer-model-failure");
  await expect(note).toContainText("Model request failed: the model is unavailable right now.");
  await expect(note).toContainText("sandbox is still running");
  await expect(page.getByTestId("composer-wait")).toHaveCount(0);
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("will this reach it?");
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();
  expect(await page.evaluate(() => window.__oncueSent ?? [])).toEqual([]);
});

test("the review tree says when the repository listing failed, and Retry asks again", async ({
  page,
}) => {
  let listings = 0;
  await page.route("**/api/sessions/*/artifacts/**", async (route) => {
    listings += 1;
    await route.fulfill({ status: 503, body: "" });
  });
  await page.goto("/dev/session?fixture=review-tree");
  await page.getByTestId("rail-changes").click();
  await page.getByRole("button", { name: "Show file tree" }).click();
  const failed = page.getByTestId("tree-listing-failed");
  await expect(failed).toContainText("Showing changed files only");
  await expect(page.getByRole("tree", { name: "Changed files" })).toBeVisible();
  const before = listings;

  await failed.getByRole("button", { name: "Retry" }).click();

  await expect.poll(() => listings).toBeGreaterThan(before);
  await expect(failed).toBeVisible();
});
