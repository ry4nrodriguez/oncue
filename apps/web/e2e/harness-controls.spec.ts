import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { scan } from "./a11y-scan";

/**
 * The harness and model choices inside the composer's agent chip, and
 * Settings, Harnesses, driven through `/dev/home`. Its `ready` world enables
 * OpenCode and Codex with only an Anthropic key, so the harness list shows
 * ready and needs-a-key states, and nothing of a harness the image does not
 * install. `ONCUE_HARNESS_MEDIA=1` also
 * writes screenshots under `apps/web/test-results/screenshots/`.
 */

const MEDIA = fileURLToPath(
  new URL("../test-results/screenshots/harness-adapters/", import.meta.url),
);
const CAPTURE = process.env.ONCUE_HARNESS_MEDIA === "1";

async function shot(page: Page, name: string): Promise<void> {
  if (!CAPTURE) {
    return;
  }
  mkdirSync(MEDIA, { recursive: true });
  await page.screenshot({ path: `${MEDIA}${name}.png`, animations: "disabled", caret: "hide" });
}

async function openHome(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto("/dev/home");
  await page.getByTestId("agent-chip").waitFor({ state: "visible" });
}

for (const theme of ["light", "dark"] as const) {
  test(`the agent chip names the model closed and lists every harness and model open (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHome(page, theme);
    const chip = page.getByTestId("agent-chip");
    // Closed: the model under its provider's mark, the effort beside it, and a chevron.
    await expect(chip).toHaveText("Opus 5.5medium");
    await expect(chip).toHaveAccessibleName("Model: Opus 5.5, medium effort");
    await expect(chip.locator("svg").first()).toBeVisible();
    await expect(chip.locator("svg.lucide-chevron-down")).toBeVisible();
    await shot(page, `composer-${theme}`);

    await chip.click();
    const panel = page.getByTestId("agent-panel");
    const harnesses = panel.getByRole("group", { name: "Run with" });
    const opencode = harnesses.getByTestId("harness-row-opencode");
    await expect(opencode).toHaveAttribute("aria-pressed", "true");
    // OpenCode's mark for this theme is drawn and the other variant is not.
    await expect(opencode.locator(`svg.oncue-mark-${theme}`)).toBeVisible();
    await expect(
      opencode.locator(`svg.oncue-mark-${theme === "light" ? "dark" : "light"}`),
    ).toBeHidden();
    const codex = harnesses.getByRole("link", { name: "Codex: connect a key" });
    await expect(codex).toHaveAttribute("href", "/settings/harnesses");
    await expect(codex.getByText("Connect")).toBeVisible();
    // A harness the image does not install is never offered.
    for (const id of ["pi", "claude"]) {
      await expect(harnesses.getByTestId(`harness-row-${id}`)).toHaveCount(0);
    }
    await expect(harnesses.getByText("Anthropic, OpenAI")).toHaveCount(0);

    const models = panel.getByRole("group", { name: "Model" });
    await expect(models.getByRole("button", { pressed: true })).toContainText("Opus 5.5");
    // Two Anthropic keys in this world, and each model listed once, by name alone.
    await expect(models.getByTestId("model-row")).toHaveText(["Opus 5.5", "Sonnet 5", "Haiku 4.5"]);
    await expect(models.getByText(/anthropic \.\.\./)).toHaveCount(0);
    const luna = models.getByTestId("model-connect-gpt-6-luna");
    await expect(luna).toHaveAttribute("href", "/settings/model-providers");
    await expect(luna.getByText("Connect")).toBeVisible();
    const findings = await scan(page, "agent panel, open", theme);
    expect(findings, findings.join("\n")).toEqual([]);
    await shot(page, `agent-panel-${theme}`);
  });
}

test("the harness Connect goes to Settings, Harnesses, whose Connect goes to Model providers", async ({
  page,
}) => {
  await openHome(page, "light");
  await page.getByTestId("agent-chip").click();
  await page.getByRole("link", { name: "Codex: connect a key" }).click();
  await expect(page.getByRole("heading", { name: "Harnesses" })).toBeVisible();
  const codex = page.getByTestId("harness-codex");
  await expect(codex.getByText("Connect an OpenAI key")).toBeVisible();
  await codex.getByRole("link", { name: "Connect an OpenAI key for Codex" }).click();
  await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`Settings, Harnesses lists every harness the image installs in its state (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/dev/home?at=/settings/harnesses");
    const list = page.getByRole("list", { name: "Harnesses" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("harness-opencode").getByText("Ready")).toBeVisible();
    await expect(
      page.getByTestId("harness-opencode").getByText("Works with Anthropic and OpenAI keys"),
    ).toBeVisible();
    await expect(
      page.getByTestId("harness-codex").getByRole("link", { name: /Codex/ }),
    ).toBeVisible();
    // Pi and Claude Code have adapters but are not in the image, so Settings shows neither.
    await expect(page.getByTestId("harness-pi")).toHaveCount(0);
    await expect(page.getByTestId("harness-claude")).toHaveCount(0);
    await expect(list.getByText("Claude Code")).toHaveCount(0);
    const findings = await scan(page, "harnesses page", theme);
    expect(findings, findings.join("\n")).toEqual([]);
    await shot(page, `harnesses-${theme}`);
  });
}

test("the controls fit a 375-pixel screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/dev/home");
  // Nothing folds away on a narrow screen: the chip is in the bar, with the model's name.
  const chip = page.getByTestId("agent-chip");
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("agent-chip-model")).toBeVisible();
  await expect(page.getByTestId("agent-chip-model")).toHaveText("Opus 5.5");
  await expect(page.getByTestId("agent-chip-effort")).toBeHidden();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await shot(page, "composer-375");
  await chip.click();
  await expect(page.getByRole("link", { name: "Codex: connect a key" })).toBeVisible();
  // The model list scrolls inside the panel on a short screen.
  const sol = page.getByTestId("model-connect-gpt-6-sol");
  await sol.scrollIntoViewIfNeeded();
  await expect(sol).toBeInViewport();
  await shot(page, "agent-panel-375");
});
