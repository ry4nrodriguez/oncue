import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { scan } from "./a11y-scan";
import { pointerOffSidebar } from "./pointer";

/**
 * The composer's bar: the repository and the branch on the left, one agent
 * chip on the right. Its controls shorten by the bar's own width, which only a
 * browser can lay out, so this drives `/dev/home` and `/dev/session` at a
 * desktop, a tablet, and two phone widths, in both themes.
 * `ONCUE_COMPOSER_BAR_MEDIA=1` also writes screenshots under
 * `apps/web/test-results/screenshots/composer-bar/`.
 */

const MEDIA = fileURLToPath(new URL("../test-results/screenshots/composer-bar/", import.meta.url));
const CAPTURE = process.env.ONCUE_COMPOSER_BAR_MEDIA === "1";

async function shot(page: Page, name: string): Promise<void> {
  if (!CAPTURE) {
    return;
  }
  mkdirSync(MEDIA, { recursive: true });
  await page.screenshot({ path: `${MEDIA}${name}.png`, animations: "disabled", caret: "hide" });
}

const WIDTHS = [1280, 768, 375, 320] as const;
const THEMES = ["light", "dark"] as const;
/** Home has the branch control; a session's repository and branch are fixed, so it has two. */
const SURFACES = [
  { name: "home", path: "/dev/home", controls: 3 },
  { name: "session", path: "/dev/session", controls: 2 },
] as const;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** What the browser laid out: the bar, each of its controls, and anything wider than its box. */
async function measure(page: Page) {
  return await page.getByTestId("composer-strip").evaluate((strip) => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const row = strip.firstElementChild as HTMLElement;
    const [left, chip] = Array.from(row.children) as HTMLElement[];
    const controls = [...Array.from(left?.children ?? []), chip].filter(
      (control): control is HTMLElement => control instanceof HTMLElement,
    );
    const composer = strip.closest("[data-testid='composer']") as HTMLElement;
    const below = document.querySelector<HTMLElement>("[data-testid='composer-below']");
    const model = strip.querySelector<HTMLElement>("[data-testid='agent-chip-model']");
    return {
      page: { scroll: document.documentElement.scrollWidth, client: window.innerWidth },
      strip: { ...box(strip), scroll: strip.scrollWidth, client: strip.clientWidth },
      row: { scroll: row.scrollWidth, client: row.clientWidth },
      composer: { ...box(composer), scroll: composer.scrollWidth, client: composer.clientWidth },
      controls: controls.map(box),
      below: below === null ? null : { scroll: below.scrollWidth, client: below.clientWidth },
      model:
        model === null
          ? null
          : { text: model.textContent, scroll: model.scrollWidth, client: model.clientWidth },
    };
  });
}

for (const surface of SURFACES) {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      test(`the bar is one row that fits its box on ${surface.name} at ${width} px (${theme})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto(surface.path);
        await page.getByTestId("agent-chip").waitFor({ state: "visible" });

        const bar = await measure(page);
        // Nothing scrolls sideways: not the page, the composer, the bar, or the row below it.
        expect(bar.page.scroll).toBeLessThanOrEqual(bar.page.client);
        expect(bar.composer.scroll).toBeLessThanOrEqual(bar.composer.client);
        expect(bar.strip.scroll).toBeLessThanOrEqual(bar.strip.client);
        expect(bar.row.scroll).toBeLessThanOrEqual(bar.row.client);
        expect(bar.below?.scroll ?? 0).toBeLessThanOrEqual(bar.below?.client ?? 0);
        expect(bar.composer.right).toBeLessThanOrEqual(width);

        // Every control is inside the bar, on one row, and none covers the next.
        expect(bar.controls).toHaveLength(surface.controls);
        const rowTop = Math.min(...bar.controls.map((control) => control.top));
        for (const [index, control] of bar.controls.entries()) {
          expect(control.left).toBeGreaterThanOrEqual(bar.strip.left - 0.5);
          expect(control.right).toBeLessThanOrEqual(bar.strip.right + 0.5);
          expect(control.right - control.left).toBeGreaterThan(24);
          // A wrapped control would start a whole row lower.
          expect(control.top - rowTop).toBeLessThan(8);
          const next = bar.controls[index + 1];
          if (next !== undefined) {
            expect(control.right).toBeLessThanOrEqual(next.left + 0.5);
          }
        }
        expect(bar.strip.bottom - bar.strip.top).toBeLessThan(56);

        // The model's name is whole at every width; the effort is what gives way.
        expect(bar.model?.text).toBe(surface.name === "home" ? "Opus 5.5" : "Sonnet 4.5");
        expect(bar.model?.scroll ?? 0).toBeLessThanOrEqual(bar.model?.client ?? 0);
        if (surface.name === "home") {
          const narrow = width <= 375;
          await expect(page.getByTestId("agent-chip-effort")).toBeVisible({ visible: !narrow });
          // The repository drops its owner before anything truncates.
          const repository = page.getByRole("button", { name: /^Repository: acme\/oncue/ });
          await expect(repository.getByText("acme/", { exact: true })).toBeVisible({
            visible: width >= 768,
          });
          await expect(repository).toContainText(width >= 768 ? "acme/oncue" : "oncue");
          await expect(page.getByTestId("branch-picker")).toBeVisible();
        } else {
          await expect(page.getByTitle("acme/oncue")).toContainText("oncue");
        }
        await shot(page, `${surface.name}-${width}-${theme}`);
      });
    }
  }
}

for (const width of [1280, 375] as const) {
  for (const theme of THEMES) {
    test(`the agent chip opens one panel that stays on screen at ${width} px (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/dev/home");
      const chip = page.getByTestId("agent-chip");
      await expect(chip).toHaveAccessibleName("Model: Opus 5.5, medium effort");
      await chip.click();

      const panel = page.getByRole("dialog", { name: "Harness, model, and effort" });
      await expect(panel).toBeVisible();
      // Top to bottom: what runs, which model, how hard it thinks.
      await expect(panel.getByRole("group")).toHaveCount(3);
      await expect(panel.getByRole("group").nth(0)).toHaveAccessibleName("Run with");
      await expect(panel.getByRole("group").nth(1)).toHaveAccessibleName("Model");
      await expect(panel.getByRole("group").nth(2)).toHaveAccessibleName("Effort: medium");

      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(800);

      // On a screen this short the model list gives up height, so the effort stays in view.
      await expect(panel.getByRole("button", { name: "max", exact: true })).toBeInViewport({
        ratio: 1,
      });
      await expect(panel.getByTestId("harness-row-opencode")).toBeInViewport({ ratio: 1 });

      const findings = await scan(page, "agent panel, open", theme);
      expect(findings, findings.join("\n")).toEqual([]);
      await shot(page, `agent-panel-${width}-${theme}`);
    });
  }
}

/** Home's composer sits mid-screen and a session's at the bottom, so each is tried at every size. */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
  { width: 320, height: 568 },
] as const;

for (const surface of SURFACES) {
  for (const viewport of VIEWPORTS) {
    test(`the agent panel stays attached to its chip on ${surface.name} at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(surface.path);
      // At 320 px the open sidebar would cover the chip.
      await pointerOffSidebar(page);
      const chip = page.getByTestId("agent-chip");
      await chip.click();
      const panel = page.getByTestId("agent-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("model-picker")).toBeVisible();

      const chipBox = await chip.boundingBox();
      const box = await panel.boundingBox();
      if (chipBox === null || box === null) {
        throw new Error("the chip or its panel has no box");
      }
      // Directly below the chip or directly above it, by the panel's own offset, never beside it.
      const below = Math.abs(box.y - (chipBox.y + chipBox.height));
      const above = Math.abs(chipBox.y - (box.y + box.height));
      expect(Math.min(below, above)).toBeLessThanOrEqual(12);
      // Over the chip's own columns, its end on the chip's end unless the screen's edge moves it.
      expect(box.x).toBeLessThan(chipBox.x + chipBox.width);
      expect(box.x + box.width).toBeGreaterThan(chipBox.x);
      if (viewport.width >= 768) {
        expect(Math.abs(box.x + box.width - (chipBox.x + chipBox.width))).toBeLessThanOrEqual(2);
      }
      // On screen, and capped to the room on its side rather than scrolling as a whole.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      const fits = await panel.evaluate((element) => element.scrollHeight <= element.clientHeight);
      expect(fits, "the panel scrolls as a whole instead of its model list").toBe(true);
      // What runs (where there is a choice of it), the model list's heading, and the
      // effort stay in view; the list scrolls between them.
      if ((await panel.getByTestId("runtime-picker").count()) > 0) {
        await expect(panel.getByTestId("runtime-picker")).toBeInViewport({ ratio: 1 });
      }
      await expect(panel.getByTestId("effort-picker")).toBeInViewport({ ratio: 1 });
      await expect(panel.getByText("Model", { exact: true })).toBeInViewport({ ratio: 1 });
      await shot(page, `attached-${surface.name}-${viewport.width}x${viewport.height}`);
    });
  }
}

test("the agent panel is driven from the keyboard, and Escape returns to the chip", async ({
  page,
}) => {
  await page.goto("/dev/home");
  const chip = page.getByTestId("agent-chip");
  await chip.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toBeVisible();

  // Focus enters the panel at its first row; the arrows walk the rows after it.
  await expect(panel.getByTestId("harness-row-opencode")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByTestId("harness-row-codex")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(panel.getByTestId("harness-row-opencode")).toBeFocused();

  // Enter on a model's row chooses it and closes the panel, with focus back on the chip.
  const haiku = panel.getByRole("button", { name: /Haiku 4\.5/ });
  await haiku.focus();
  await page.keyboard.press("Enter");
  await expect(chip).toContainText("Haiku 4.5");
  await expect(panel).toBeHidden();
  await expect(chip).toBeFocused();

  // Reopened, it shows the choice, and Escape closes it too.
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: /Haiku 4\.5/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(chip).toBeFocused();
});

test("a session's agent panel names its harness and model and offers no other", async ({
  page,
}) => {
  await page.goto("/dev/session");
  const chip = page.getByTestId("agent-chip");
  await expect(chip).toHaveAccessibleName("Model: Sonnet 4.5");
  await chip.click();
  const panel = page.getByTestId("agent-panel");
  // One harness is offered here, so there is no choice of harness to show and the panel stays short.
  await expect(panel).toHaveAccessibleName("Model and effort");
  await expect(panel.getByTestId("runtime-picker")).toHaveCount(0);
  await expect(panel.getByTestId("model-picker")).toContainText("Sonnet 4.5");
  await expect(panel.getByTestId("model-picker")).toContainText("Fixed for this session");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("link")).toHaveCount(0);
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const findings = await scan(page, "agent panel in a session, open", theme);
    expect(findings, findings.join("\n")).toEqual([]);
  }
  await shot(page, "agent-panel-session");
});

/** The models of `/dev/home?fixture=both-providers`, with the levels the catalog gives each. */
const EFFORT_BY_MODEL = [
  { model: "Opus 5.5", levels: ["low", "medium", "high", "xhigh", "max"] },
  { model: "GPT-6 Sol", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { model: "GPT-6 Luna", levels: ["none", "low", "medium", "high"] },
  { model: "Haiku 4.5", levels: null },
] as const;

for (const width of [1280, 320] as const) {
  test(`the effort is one row of the model's own levels, or a line saying it has none, at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/dev/home?fixture=both-providers");
    // At 320 px the open sidebar would cover the chip.
    await pointerOffSidebar(page);
    const chip = page.getByTestId("agent-chip");
    await chip.click();
    const panel = page.getByTestId("agent-panel");
    for (const { model, levels } of EFFORT_BY_MODEL) {
      await panel.getByTestId("model-row").filter({ hasText: model }).click();
      await expect(page.getByTestId("agent-chip-model")).toHaveText(model);
      // Picking a model closes the panel; its effort is read on reopening.
      await expect(panel).toBeHidden();
      await chip.click();
      const section = panel.getByTestId("effort-picker");
      if (levels === null) {
        // No row, and the chip is the model's name alone.
        await expect(section).toHaveText(`Effort${model} has no effort setting.`);
        await expect(section.getByRole("button")).toHaveCount(0);
        await expect(chip).toHaveAccessibleName(`Model: ${model}`);
        await expect(page.getByTestId("agent-chip-effort")).toHaveCount(0);
        await shot(page, `effort-none-${width}`);
        continue;
      }
      const buttons = section.getByRole("button");
      await expect(buttons).toHaveText([...levels]);
      await expect(section.getByRole("button", { pressed: true })).toHaveCount(1);
      // One row inside the panel: no button wraps, clips its word, or leaves the row.
      const row = await panel.getByTestId("effort-levels").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scroll: element.scrollWidth,
          client: element.clientWidth,
          buttons: Array.from(element.children).map((child) => {
            const box = child.getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              top: box.top,
              height: box.height,
              scroll: child.scrollWidth,
              client: child.clientWidth,
            };
          }),
        };
      });
      expect(row.scroll).toBeLessThanOrEqual(row.client);
      const top = row.buttons[0]?.top ?? 0;
      for (const [index, button] of row.buttons.entries()) {
        expect(button.top).toBe(top);
        expect(button.height).toBeLessThan(32);
        expect(button.scroll).toBeLessThanOrEqual(button.client);
        expect(button.left).toBeGreaterThanOrEqual(row.left);
        expect(button.right).toBeLessThanOrEqual(row.right + 0.5);
        expect(button.left).toBeGreaterThanOrEqual((row.buttons[index - 1]?.right ?? 0) - 0.5);
      }
      const box = await panel.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);

      // A press on another level moves the pressed state and the chip's name.
      const other = levels.at(-1) as string;
      await section.getByRole("button", { name: other, exact: true }).click();
      await expect(section.getByRole("button", { pressed: true })).toHaveText(other);
      await expect(chip).toHaveAccessibleName(`Model: ${model}, ${other} effort`);
      // Before the themes are switched for the scans, so no colour is caught mid-change.
      await shot(page, `effort-${levels.length}-levels-${width}`);
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const findings = await scan(page, `effort row for ${model} at ${width}`, theme);
        expect(findings, findings.join("\n")).toEqual([]);
      }
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      // The theme's own colour transitions finish before the next model's shot.
      await expect(section.getByRole("button", { pressed: true })).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
    }
  });
}

/** Anthropic's Clay, the one colour the Claude mark is drawn in. */
const CLAY = "rgb(217, 119, 87)";

for (const theme of THEMES) {
  test(`the Claude mark keeps its own colour on the chip and in the panel (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/dev/home");
    const colourOf = async (mark: ReturnType<typeof page.locator>) =>
      await mark.evaluate((element) => getComputedStyle(element).color);
    const chip = page.getByTestId("agent-chip");
    expect(await colourOf(chip.locator("svg").first())).toBe(CLAY);

    await chip.click();
    const panel = page.getByTestId("agent-panel");
    for (const row of await panel.getByTestId("model-row").all()) {
      expect(await colourOf(row.locator("svg").first())).toBe(CLAY);
    }
    // OpenAI's mark takes the text colour, not Claude's.
    const openai = panel.getByTestId("model-connect-gpt-6-sol").locator("svg").first();
    expect(await colourOf(openai)).not.toBe(CLAY);
  });
}

test("Home shows the context gauge at 0% before a chat starts, with nothing to open", async ({
  page,
}) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/dev/home");
    const gauge = page.getByRole("img", { name: "Context: 0% used" });
    await expect(gauge).toBeVisible();
    await expect(gauge).toHaveText("0%");
    // An empty ring: the track alone.
    await expect(gauge.locator("circle")).toHaveCount(1);
    // At the right end of the approvals row, under the box's corner.
    const below = await page.getByTestId("composer-below").boundingBox();
    const box = await gauge.boundingBox();
    const approvals = await page.getByTestId("composer-below").getByRole("button").boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (below?.x ?? 0) + (below?.width ?? 0) + 0.5,
    );
    expect(box?.x ?? 0).toBeGreaterThan((approvals?.x ?? 0) + (approvals?.width ?? 0));
    expect(Math.abs((box?.y ?? 0) - (approvals?.y ?? 0))).toBeLessThan(8);
    await gauge.click();
    await expect(page.getByTestId("context-meter-popover")).toHaveCount(0);
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const findings = await scan(page, `Home's context gauge at ${width}`, theme);
      expect(findings, findings.join("\n")).toEqual([]);
      if (width === 1280 || width === 375) {
        await shot(page, `home-gauge-${width}-${theme}`);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
});

test("the side-panel button carries the sandbox's dot in a session, and Home has none", async ({
  page,
}) => {
  await page.goto("/dev/home");
  await page.getByTestId("agent-chip").waitFor({ state: "visible" });
  await expect(page.getByTestId("panel-sandbox-dot")).toHaveCount(0);

  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/dev/session?fixture=actions");
    const toggle = page.getByTestId("panel-toggle");
    const dot = page.getByTestId("panel-sandbox-dot");
    await expect(dot).toHaveAttribute("data-phase", "starting");
    await page.getByTestId("advance-sandbox").click();
    await expect(dot).toHaveAttribute("data-phase", "running");
    await expect(toggle).toHaveAccessibleName("Open side panel. Sandbox running");
    // The dot sits inside the button's own corner.
    const button = await toggle.boundingBox();
    const mark = await dot.boundingBox();
    expect(mark?.x ?? 0).toBeGreaterThanOrEqual(button?.x ?? 0);
    expect((mark?.x ?? 0) + (mark?.width ?? 0)).toBeLessThanOrEqual(
      (button?.x ?? 0) + (button?.width ?? 0),
    );
    const findings = await scan(page, "session header with the sandbox's dot", theme);
    expect(findings, findings.join("\n")).toEqual([]);
    await shot(page, `session-sandbox-dot-${theme}`);
  }
});

test("the composer says nothing about the sandbox, on Home or in a session", async ({ page }) => {
  for (const path of ["/dev/home", "/dev/session?fixture=actions"]) {
    await page.goto(path);
    await page.getByTestId("agent-chip").waitFor({ state: "visible" });
    await expect(page.getByTestId("composer-strip")).not.toContainText("Modal");
    await expect(
      page.getByTestId("composer-strip").getByRole("button", { name: /Modal/ }),
    ).toHaveCount(0);
  }
});
