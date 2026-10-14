import { expect, type Page, test } from "@playwright/test";

/**
 * The timeline's action rows, driven by a real mouse and keyboard through
 * `/dev/session?fixture=actions`. These check layout, painting, and hit
 * testing, which jsdom cannot, and that a multi-event lifecycle renders as one
 * row.
 */

const CLONE = "Cloning acme/oncue";
const DENIED = "Install the vendor toolchain";

/** Tool rows sit folded inside activity groups (record 13), so open the group first. */
async function openGroupHolding(page: Page, text: string): Promise<void> {
  const group = page.getByTestId("row-activity").filter({ hasText: text }).first();
  await expect(group).toHaveAttribute("data-open", "false");
  await group.getByTestId("activity-trigger").click();
  await expect(group).toHaveAttribute("data-open", "true");
}

test("a tool row expands to the call that actually ran", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  await openGroupHolding(page, CLONE);
  const row = page.getByTestId("row-tool").filter({ hasText: CLONE });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("action-panel")).toHaveCount(0);

  // A real press at the control's hit point, so it fails if anything is
  // painted over the row.
  await row.getByRole("button").click();

  const panel = row.getByTestId("action-panel");
  await expect(panel).toBeVisible();
  // The event's own input and its own output, not a placeholder.
  await expect(panel).toContainText("acme/oncue");
  await expect(panel).toContainText("Resolving deltas: 100% (812/812)");
  await expect(panel).toContainText("Cloned at 9f2c1ab.");
  await expect(panel).toContainText("Exit code");
  // Nothing was lost, so the row must not claim anything was.
  await expect(panel).not.toContainText("no longer available");
});

/**
 * The real bridge sends no `tool.output`: the output arrives in
 * `tool.completed`'s result, whose summary repeats the title. The row must
 * show the output, not the summary.
 */
test("an expanded shell row shows what the command printed, not the command again", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=actions");

  await openGroupHolding(page, CLONE);
  const row = page.getByTestId("row-tool").filter({ hasText: "pnpm test" });
  await row.getByRole("button").click();

  const output = row.getByTestId("action-output");
  await expect(output).toBeVisible();
  await expect(output).toContainText("Tests  3 passed (3)");
  await expect(output).toContainText("src/app.test.ts (3 tests)");
  // Monospace, as terminal output is.
  expect(await output.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i);
  const panel = row.getByTestId("action-panel");
  await expect(panel).not.toContainText("Result");
  await expect(panel).not.toContainText("no longer available");
});

test("a denied call is legible without expanding, and names the denial", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  await openGroupHolding(page, DENIED);
  const row = page.getByTestId("row-tool").filter({ hasText: DENIED });
  await expect(row.getByTestId("action-failure")).toHaveText("Denied by policy");
  await expect(row.getByTestId("action-panel")).toHaveCount(0);

  await row.getByRole("button").click();
  await expect(row.getByTestId("action-panel")).toContainText(
    "The session policy does not allow piping a downloaded script into a shell.",
  );
});

test("each category brings its own mark, and Modal keeps its greens", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  // The second svg in a row's control is the mark; the first is the chevron.
  const markOf = (testId: string, text: string) =>
    page.getByTestId(testId).filter({ hasText: text }).locator("button svg").first();

  // Octicons use a 16 square, lucide a 24 square, and Modal's mark 404 x 211,
  // so the viewBox shows which mark was picked.
  await expect(markOf("row-tool", CLONE)).toHaveAttribute("viewBox", "0 0 16 16");
  await expect(markOf("row-tool", DENIED)).toHaveAttribute("viewBox", "0 0 24 24");

  const modal = markOf("row-sandbox", "sandbox");
  await expect(modal).toHaveAttribute("viewBox", "0 0 404 211");
  // It has to actually paint: a fixed-colour mark cannot fall back the way a
  // `currentColor` one can, so a zero-size box here means an invisible row.
  const box = await modal.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(4);
  expect(box?.height ?? 0).toBeGreaterThan(4);

  // Every gradient reference resolves inside its own instance.
  const wired = await modal.evaluate((node) => {
    const defined = new Set([...node.querySelectorAll("linearGradient")].map((g) => g.id));
    return [...node.querySelectorAll("path")]
      .map((path) => path.getAttribute("fill") ?? "")
      .filter((fill) => fill.startsWith("url("))
      .every((fill) => defined.has(fill.slice("url(#".length, -1)));
  });
  expect(wired).toBe(true);
});

test("one sandbox row whose label changes as the generation progresses", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  const row = page.getByTestId("row-sandbox");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Starting a sandbox");
  // The detail lives inside the expanded block, with the sequence of steps.
  await expect(row).not.toContainText("reusing the prepared repository environment");
  await row.getByRole("button").first().click();
  await expect(row.getByTestId("action-steps")).toContainText(
    "reusing the prepared repository environment",
  );
  await row.getByRole("button").first().click();

  const advance = page.getByTestId("advance-sandbox");
  for (const expected of [
    "Sandbox running",
    "Connected to opencode 1.0.0",
    "opencode 1.0.0 is ready",
  ]) {
    await advance.click();
    await expect(row).toContainText(expected);
    // The row is updated, never appended to.
    await expect(page.getByTestId("row-sandbox")).toHaveCount(1);
  }
  await expect(row).toHaveAttribute("data-state-kind", "running");
});

/**
 * During a replacement two sandbox rows are on screen. A retired generation
 * gets no `sandbox.stopped`, so `sandbox.replaced` must settle its row or two
 * live dots show.
 */
test("a replaced generation settles instead of pulsing beside its replacement", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=actions");

  const advance = page.getByTestId("advance-sandbox");
  const rows = page.getByTestId("row-sandbox");
  for (let step = 0; step < 4; step += 1) {
    await advance.click();
  }

  await expect(rows).toHaveCount(2);
  const retired = rows.nth(0);
  const replacement = rows.nth(1);

  // Nothing else will mention generation 1 again, so its row must settle here.
  await expect(retired).toContainText("Sandbox replaced at its lifetime ceiling");
  await expect(retired).toHaveAttribute("data-state-kind", "completed");

  await expect(replacement).toContainText("Replacing the sandbox at its lifetime ceiling");
  await expect(replacement).toHaveAttribute("data-state-kind", "requested");
  // Modal's mark, carried from the replaced generation, so the row does not
  // show the local driver's glyph until `sandbox.provisioning` arrives.
  await expect(replacement.locator("button svg").first()).toHaveAttribute("viewBox", "0 0 404 211");

  // The replacement continues in its own row; the retired one is not revived.
  await advance.click();
  await expect(advance).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(replacement).toContainText("Sandbox stopped at your request");
  await expect(replacement).toHaveAttribute("data-state-kind", "completed");
  await expect(retired).toContainText("Sandbox replaced at its lifetime ceiling");
});

test("an action row is operable from the keyboard", async ({ page }) => {
  await page.goto("/dev/session?fixture=actions");

  // The row's own trigger; the expanded row adds the output fold's button after it.
  const trigger = page.getByTestId("row-sandbox").getByRole("button").first();
  await trigger.focus();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("row-sandbox").getByTestId("action-panel")).toBeVisible();

  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

/**
 * The shimmer, sampled about every frame for longer than one cycle: a seamless
 * loop's unwrapped phase is one straight line. An update to the row must keep
 * the same element, because a replaced element restarts its sweep.
 */
test("the shimmer sweeps left to right in one seamless loop, and an update does not restart it", async ({
  page,
}) => {
  await page.goto("/dev/session?fixture=actions");
  const label = page.getByTestId("row-sandbox").locator(".shimmer").first();
  await expect(label).toContainText("Starting a sandbox");

  const run = await label.evaluate(async (element) => {
    const style = getComputedStyle(element);
    const width = element.getBoundingClientRect().width;
    const tile = Number.parseFloat(style.backgroundSize) / 100;
    const samples: { t: number; x: number }[] = [];
    const start = performance.now();
    while (performance.now() - start < 2600) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push({
        t: Math.round(performance.now() - start),
        x: Number.parseFloat(getComputedStyle(element).backgroundPositionX),
      });
    }
    return { width, tile, duration: style.animationDuration, samples };
  });

  // Phase of the highlight within its tile, 0..1: the tile's left edge sits
  // at (1 - tile) * x% of the width, and one tile is `tile` widths.
  const phase = (x: number) => {
    const turns = ((1 - run.tile) * (x / 100)) / run.tile;
    return turns - Math.floor(turns);
  };
  const xs = run.samples.map((sample) => sample.x);
  const unwrapped: number[] = [phase(xs[0] as number)];
  let wrapAt = -1;
  for (let index = 1; index < xs.length; index += 1) {
    let step = phase(xs[index] as number) - phase(xs[index - 1] as number);
    if (step < -0.5) {
      step += 1;
    }
    if ((xs[index] as number) > (xs[index - 1] as number) && wrapAt === -1) {
      wrapAt = index;
    }
    unwrapped.push((unwrapped[index - 1] as number) + step);
  }
  const times = run.samples.map((sample) => sample.t);
  const span = (times.at(-1) as number) - (times[0] as number);
  const slope = ((unwrapped.at(-1) as number) - (unwrapped[0] as number)) / span;
  const deviation = Math.max(
    ...unwrapped.map((value, index) =>
      Math.abs(
        value -
          (unwrapped[0] as number) -
          slope * ((times[index] as number) - (times[0] as number)),
      ),
    ),
  );
  console.log(
    `shimmer: width ${run.width.toFixed(1)}px, tile ${run.tile}x, duration ${run.duration}, ${xs.length} samples over ${span}ms, ${(slope * 1000).toFixed(4)} tiles/s, max deviation ${deviation.toFixed(4)} tile; around the loop: ${JSON.stringify(run.samples.slice(Math.max(0, wrapAt - 3), wrapAt + 3))}`,
  );

  expect(wrapAt, "the sampling crossed a loop boundary").toBeGreaterThan(0);
  // One tile every two seconds, left to right (the phase rises), in a straight line.
  expect(slope * 1000).toBeGreaterThan(0.45);
  expect(slope * 1000).toBeLessThan(0.55);
  expect(deviation).toBeLessThan(0.02);

  // An update to the row keeps the element and its running animation.
  const startTime = await label.evaluate((element) => {
    element.setAttribute("data-shimmer-probe", "kept");
    return element.getAnimations()[0]?.startTime ?? null;
  });
  expect(startTime).not.toBeNull();
  await page.getByTestId("advance-sandbox").click();
  const probed = page.locator("[data-shimmer-probe=kept]");
  await expect(probed).toContainText("Sandbox running");
  expect(await probed.evaluate((element) => element.classList.contains("shimmer"))).toBe(true);
  expect(await probed.evaluate((element) => element.getAnimations()[0]?.startTime ?? null)).toBe(
    startTime,
  );
});
