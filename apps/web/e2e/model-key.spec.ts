import { expect, type Page, test } from "@playwright/test";

/**
 * A model key the provider rejected, as the session and Home say it (record
 * 15), driven through the dev harnesses in a real browser: the note under the
 * composer, the timeline's pause row, Home's banner, and the picker's rows.
 * `resilience.spec.ts` rejects a key on the real Worker and bridge.
 */

const REJECTED = "Model request failed: the provider rejected the model key.";
const MODEL_PROVIDERS = "/settings/model-providers";

const pauseRow = (page: Page) => page.locator("[data-testid='row-run'][data-transition='paused']");

/** Nothing on the page is wider than the window. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a run paused on a rejected key says so under the composer and on the timeline, without the session details", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=key-rejected");
  // A chat opens with the session details unpinned, so nothing may depend on them.
  await page.getByRole("button", { name: "Unpin session details" }).click();
  await expect(page.getByTestId("context-rail")).toHaveCount(0);

  const note = page.getByTestId("composer-model-failure");
  await expect(note).toHaveText(
    `${REJECTED} Replace the key under Settings, Model providers, then come back here to continue the run.`,
  );
  // The generic "paused or interrupted" note gives way to the one that names the failure.
  await expect(page.getByTestId("composer-wait")).toHaveCount(0);
  await expect(page.getByText("start a new session")).toHaveCount(0);

  // The row stands on the timeline, in view with no group opened.
  const row = pauseRow(page);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Paused");
  await expect(row.getByTestId("pause-reason")).toHaveText(REJECTED);
  await expect(row.locator("xpath=ancestor::*[@data-testid='activity-rows']")).toHaveCount(0);

  // Both link to where the key is replaced.
  const links = page.getByRole("link", { name: "Open Model providers" });
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", MODEL_PROVIDERS);
  }

  // Nothing is offered that the object would refuse, and the run can still be stopped.
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("will this reach it?");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();
  await expect(message).toHaveAttribute("aria-describedby", (await note.getAttribute("id")) ?? "");
});

test("once the sandbox has stopped, a still-rejected key says to replace it and then continue", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=key-rejected-stopped");

  await expect(page.getByTestId("composer-model-failure")).toHaveText(
    `${REJECTED} Replace the key under Settings, Model providers, then come back here to continue the run.`,
  );
  // A message would need a new sandbox on a key that cannot start one.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await expect(page.getByTestId("rail-continue")).toHaveCount(0);
  // The session details say the same words as the note.
  await expect(page.getByTestId("needs-you")).toContainText(
    "Replace the key under Settings, Model providers, then come back here to continue the run.",
  );
  await expect(page.getByText("start a new session")).toHaveCount(0);
  await expect(pauseRow(page).getByRole("link", { name: "Open Model providers" })).toBeVisible();
});

test("once the key is active again, the run can continue and Settings is still one link away", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=key-replaced");

  await expect(page.getByTestId("composer-model-failure")).toHaveText(
    `${REJECTED} The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.`,
  );
  // Replaced since, or never marked by the refusal: the note claims neither, and the link stays.
  await expect(page.getByText("has since been replaced")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Model providers" }).first()).toHaveAttribute(
    "href",
    MODEL_PROVIDERS,
  );
  // The history keeps why it paused.
  await expect(pauseRow(page).getByTestId("pause-reason")).toHaveText(REJECTED);

  const message = page.getByRole("textbox", { name: "Message" });
  await expect(message).toBeEnabled();
  await message.fill("pick it up");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "title",
    "Continue",
  );
  await expect(page.getByTestId("rail-continue")).toBeVisible();
});

test("the rejected-key note and row fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  for (const fixture of ["key-rejected", "key-rejected-stopped", "key-replaced"]) {
    await page.goto(`/dev/session?fixture=${fixture}`);
    await expect(page.getByTestId("composer-model-failure")).toBeVisible();
    await expectNoSidewaysScroll(page);
  }
});

test("Home names a rejected key and the sessions on it, with a link to Model providers", async ({
  page,
}) => {
  await page.goto("/dev/home?fixture=key-rejected");

  const banner = page.getByTestId("home-key-banner");
  await expect(banner).toHaveText(
    "The OpenAI key was rejected. 2 active sessions use it and can't continue until the key is replaced. Replace the key",
  );
  // A key to replace is not a setup step to finish.
  await expect(page.getByTestId("home-guidance")).toHaveCount(0);
  // The composer still starts sessions on the key that works.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.getByTestId("agent-chip")).toContainText("Opus 5.5");

  await banner.getByRole("link", { name: "Replace the key" }).click();
  await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
});

test("the picker lists a rejected key's models greyed with Key rejected and Replace, and they cannot be chosen", async ({
  page,
}) => {
  await page.goto("/dev/home?fixture=key-rejected");
  await page.getByTestId("agent-chip").click();
  const panel = page.getByTestId("agent-panel");

  const rejected = panel.getByRole("link", {
    name: "GPT-6 Sol: key rejected, replace the OpenAI key",
  });
  await expect(rejected).toHaveText("GPT-6 SolKey rejectedReplace");
  await expect(rejected).toHaveAttribute("href", MODEL_PROVIDERS);
  await expect(panel.locator("[data-testid^='model-replace-']")).toHaveCount(2);
  // A rejected key is replaced, not connected.
  await expect(panel.getByTestId("model-picker").getByText("Connect")).toHaveCount(0);
  // The models of the key that works are still choices.
  await expect(panel.getByTestId("model-row")).toHaveCount(3);
  await panel.getByRole("button", { name: "Sonnet 5" }).click();
  await expect(page.getByTestId("agent-chip")).toContainText("Sonnet 5");

  // Picking a model closed the panel. Reopened, following a rejected row goes
  // to where the key is replaced and chooses nothing.
  await expect(panel).toBeHidden();
  await page.getByTestId("agent-chip").click();
  await rejected.click();
  await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
});

test("the key banner fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto("/dev/home?fixture=key-rejected");
  await expect(page.getByTestId("home-key-banner")).toBeVisible();
  await expectNoSidewaysScroll(page);
});
