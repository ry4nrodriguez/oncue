import { mkdirSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { DEFAULT_APP_ORIGIN } from "./app-origin";
import { NEEDS_REAL_CLERK, REAL_CLERK } from "./clerk-mode";
import { laneIdentity } from "./lane-auth";

/**
 * Every screen before Home, in both themes and at phone width: sign-in through
 * `main.tsx` (Clerk's form when a publishable key is configured, the local
 * stand-in's when none is), the blocked notice from the real Worker, and each
 * setup step through `/dev/home`. Each holds record 13's visual language: one panel
 * with the Settings border, no fill or shadow, neutral buttons, the product
 * named once by the wordmark, and nothing wider than 375px.
 *
 * Screenshots go to the test's output folder, or `ONCUE_SHOTS_DIR`. Reduced
 * motion keeps the wordmark on one still frame.
 */

const THEMES = ["light", "dark"] as const;
const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 860 };
const TRANSPARENT = "rgba(0, 0, 0, 0)";

type Theme = (typeof THEMES)[number];

interface Screen {
  /** Also the screenshot's file name, with the theme and width appended. */
  readonly name: string;
  readonly open: (page: Page, context: BrowserContext, origin: string) => Promise<void>;
  /** Clerk's own buttons draw their edges with box-shadow; everything else must not. */
  readonly clerk?: boolean;
  /** Nobody is signed in on this screen, so it offers no way to sign out. */
  readonly signedOut?: boolean;
}

function shotPath(name: string): string {
  const dir = process.env.ONCUE_SHOTS_DIR;
  if (dir !== undefined && dir.length > 0) {
    mkdirSync(dir, { recursive: true });
    return `${dir}/${name}.png`;
  }
  return test.info().outputPath(`${name}.png`);
}

async function harness(page: Page, fixture: string, at: string, marker: string): Promise<void> {
  await page.goto(`/dev/home?fixture=${fixture}&at=${at}`);
  await expect(page.getByText(marker)).toBeVisible();
}

/** Sends the step's form empty, then moves off the button so its hover fill is not measured. */
async function submitEmpty(page: Page, button: string, alert: string): Promise<void> {
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByRole("alert")).toHaveText(alert);
  await page.mouse.move(0, 0);
}

const SCREENS: readonly Screen[] = [
  {
    name: "sign-in",
    clerk: REAL_CLERK,
    signedOut: true,
    open: async (page) => {
      await page.goto("/");
      await expect(page.getByTestId("sign-in-gate")).toBeVisible();
      if (REAL_CLERK) {
        // Clerk's component loads from Clerk's own origin; nothing is typed into it.
        await expect(page.locator(".cl-formButtonPrimary")).toBeVisible({ timeout: 20_000 });
      } else {
        await expect(
          page.getByRole("link", { name: "Continue as the local user" }),
        ).toHaveAttribute("href", "/dev/sign-in");
      }
    },
  },
  {
    name: "blocked",
    open: async (page, context, origin) => {
      // A subject the test allowlist does not name, signed as the tests sign
      // theirs, so the refusal is the real Worker's.
      await context.addCookies([
        {
          name: "__session",
          value: laneIdentity(origin, "user_not_allowlisted").cookie.replace("__session=", ""),
          url: origin,
        },
        { name: "oncue_dev_app", value: "1", url: origin },
      ]);
      await page.goto("/", { waitUntil: "commit" });
      await expect(page.getByTestId("blocked-screen")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("blocked-local-hint")).toContainText("user_not_allowlisted");
    },
  },
  {
    name: "step-1-github",
    open: (page) => harness(page, "connect-github", "/setup", "Step 1 of 3"),
  },
  {
    name: "step-1-github-stuck-cancelled",
    open: (page) => harness(page, "github-stuck-cancelled", "/setup", "wasn't completed"),
  },
  {
    name: "step-1-github-stuck-no-repositories",
    open: (page) =>
      harness(page, "github-stuck-no-repositories", "/setup", "No repositories were selected"),
  },
  {
    name: "step-1-github-stuck-admin-approval",
    open: (page) => harness(page, "github-stuck", "/setup", "Waiting on an organization admin"),
  },
  {
    name: "step-2-model-providers",
    open: (page) => harness(page, "needs-model", "/setup", "Step 2 of 3"),
  },
  {
    name: "step-2-model-providers-error",
    open: async (page) => {
      await harness(page, "needs-model", "/setup", "Step 2 of 3");
      await submitEmpty(page, "Save and continue", "Enter a key before saving.");
    },
  },
  {
    // Home's gate names Modal as the reason, which lands on step 3.
    name: "step-3-modal",
    open: (page) => harness(page, "connect-modal", "/", "Step 3 of 3"),
  },
  {
    name: "step-3-modal-error",
    open: async (page) => {
      await harness(page, "connect-modal", "/", "Step 3 of 3");
      await submitEmpty(page, "Test and connect", "Enter the token ID before connecting.");
    },
  },
];

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** The panel's border, fill, and shadow, and where it sits, as computed. */
async function panelStyle(page: Page) {
  return page.getByTestId("auth-panel").evaluate((panel) => {
    const style = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    return {
      border: `${style.borderTopWidth} ${style.borderTopStyle}`,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      top: box.top + window.scrollY,
    };
  });
}

/**
 * Every element in the panel filled with something other than the page's own
 * colour, or casting a shadow. On Clerk's form, box-shadow is how Clerk draws
 * a button's and a field's edge, so there only fills count.
 */
async function filledOrShadowed(page: Page, ignoreShadows: boolean): Promise<string[]> {
  return page.getByTestId("auth-panel").evaluate((panel, ignore) => {
    const canvas = getComputedStyle(document.body).backgroundColor;
    const found: string[] = [];
    for (const element of panel.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      const filled =
        style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== canvas;
      const shadowed = !ignore && style.boxShadow !== "none";
      // Clerk's GitHub logo is a mask over a fill in the text colour, and its
      // "or" divider is a hairline drawn as a 1px fill: a line, not a panel.
      const logo = element.className.toString().includes("cl-socialButtonsProviderIcon");
      const hairline = element.getBoundingClientRect().height <= 1;
      if ((filled || shadowed) && !logo && !hairline) {
        found.push(`${element.tagName.toLowerCase()} ${element.className}`.slice(0, 120));
      }
    }
    return found;
  }, ignoreShadows);
}

/**
 * Each social button's provider icon: the CSS image Clerk paints it with
 * (a mask or a background), whether that image has finished loading, and
 * whether the icon is drawn at all (size, opacity, visibility, no filter).
 */
async function providerIconsLoaded(page: Page) {
  return page.evaluate(async () => {
    const icons = [...document.querySelectorAll<HTMLElement>(".cl-socialButtonsProviderIcon")];
    return Promise.all(
      icons.map(async (icon) => {
        const style = getComputedStyle(icon);
        const painted = [style.maskImage, style.webkitMaskImage, style.backgroundImage].find(
          (value) => value?.startsWith("url("),
        );
        const url = painted?.match(/url\("?([^")]+)"?\)/)?.[1] ?? "";
        let loaded = false;
        if (url.length > 0) {
          const image = new Image();
          image.src = url;
          loaded = await image.decode().then(
            () => true,
            () => false,
          );
        }
        const box = icon.getBoundingClientRect();
        const shown =
          box.width > 0 &&
          box.height > 0 &&
          style.opacity === "1" &&
          style.visibility === "visible" &&
          style.filter === "none";
        const provider =
          [...icon.classList]
            .find((name) => name.startsWith("cl-socialButtonsProviderIcon__"))
            ?.replace("cl-socialButtonsProviderIcon__", "") ?? "";
        return { provider, url, loaded, shown };
      }),
    );
  });
}

/** Clerk-specific checks: neutral buttons, no card, no heading, logos loaded. */
async function expectClerkThemed(page: Page): Promise<void> {
  const primary = page.locator(".cl-formButtonPrimary");
  const background = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background(".cl-formButtonPrimary")).toBe(TRANSPARENT);
  expect(await background(".cl-socialButtonsBlockButton")).toBe(TRANSPARENT);
  expect(await background(".cl-cardBox")).toBe(TRANSPARENT);
  // Clerk's white sheen over a solid button reads as a grey fill in dark.
  expect(
    await primary.evaluate((element) => getComputedStyle(element, "::after").backgroundImage),
  ).toBe("none");
  expect(
    await page.locator(".cl-cardBox").evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe("none");
  // The wordmark names OnCue; Clerk's heading would say it again.
  await expect(page.locator(".cl-headerTitle")).toBeHidden();
  await expect(page.getByText("Development mode")).toHaveCount(0);
  // Clerk paints the logos as CSS images from its own CDN, so wait until both
  // have loaded; a capture taken earlier shows empty slots.
  expect(await providerIconsLoaded(page)).toEqual([
    { provider: "github", url: expect.stringContaining("github.svg"), loaded: true, shown: true },
    { provider: "google", url: expect.stringContaining("google.svg"), loaded: true, shown: true },
  ]);
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const screen of SCREENS) {
  for (const theme of THEMES) {
    test(`${screen.name} (${theme}): one bordered panel, one wordmark, no fill, fits a phone`, async ({
      page,
      context,
      baseURL,
    }) => {
      const origin = baseURL ?? DEFAULT_APP_ORIGIN;
      await page.emulateMedia({ colorScheme: theme as Theme, reducedMotion: "reduce" });
      for (const [label, viewport] of [
        ["", DESKTOP],
        ["-mobile", PHONE],
      ] as const) {
        await page.setViewportSize(viewport);
        await screen.open(page, context, origin);

        // The theme reaches every screen, the gate's included.
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

        // One panel with the Settings sections' border: 1px in the border
        // token, on the page's own background, no shadow, and its top on the
        // page rather than pushed above it by a tall step.
        const panel = await panelStyle(page);
        expect(panel.border).toBe("1px solid");
        expect(panel.background).toBe(TRANSPARENT);
        expect(panel.shadow).toBe("none");
        expect(panel.top).toBeGreaterThanOrEqual(0);
        const borderToken = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.color = "var(--border)";
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
        expect(panel.borderColor).toBe(borderToken);

        // The product is named once, by the animated wordmark heading the panel.
        const marks = page.getByRole("img", { name: "OnCue" });
        await expect(marks).toHaveCount(1);
        await expect(
          page.getByTestId("auth-panel").getByRole("img", { name: "OnCue" }),
        ).toBeVisible();

        // Polled: an error screen's button was just clicked, and its hover
        // fill fades out over a short transition after the pointer leaves.
        await expect.poll(() => filledOrShadowed(page, screen.clerk === true)).toEqual([]);
        if (screen.clerk === true) {
          await expectClerkThemed(page);
        } else {
          if (screen.signedOut !== true) {
            await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
          }
          // Every action in the panel is neutral (the blocked notice has none).
          const actions = page.locator("[data-testid='auth-panel'] :is(button, a[href])");
          await expect
            .poll(async () =>
              (
                await actions.evaluateAll((elements) =>
                  elements.map((element) => getComputedStyle(element).backgroundColor),
                )
              ).filter((color) => color !== TRANSPARENT),
            )
            .toEqual([]);
        }
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

        await twoFrames(page);
        await page.screenshot({
          path: shotPath(`${screen.name}${label}-${theme}`),
          fullPage: true,
        });
      }
    });
  }
}

/** The wordmark's canvas, as an image, to compare two moments. */
async function wordmarkPixels(page: Page): Promise<string> {
  return page
    .getByTestId("fire-wordmark")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
}

test("the wordmark burns and moves, and holds still under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/dev/home?fixture=connect-github&at=/setup");
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  const first = await wordmarkPixels(page);
  await expect.poll(() => wordmarkPixels(page), { timeout: 5_000 }).not.toBe(first);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await twoFrames(page);
  const still = await wordmarkPixels(page);
  await page.waitForTimeout(700);
  expect(await wordmarkPixels(page)).toBe(still);
});

/**
 * The loading screen, held on screen by delaying (never answering) Clerk's
 * browser script until the checks and screenshots are done.
 */
async function expectLoadingScreen(page: Page, theme: Theme): Promise<void> {
  const loading = page.getByTestId("auth-loading");
  await expect(loading).toBeVisible({ timeout: 15_000 });
  await expect(loading).toHaveAttribute("role", "status");
  await expect(loading.getByRole("img", { name: "OnCue" })).toBeVisible();
  await expect(page.getByRole("img", { name: "OnCue" })).toHaveCount(1);
  await expect(loading.getByText("Loading", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  // Centred: the wordmark's middle within a few pixels of the window's.
  const box = await loading.getByRole("img", { name: "OnCue" }).boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThan(4);
  // Nothing drawn around it, and nothing wider than the window.
  const drawn = await loading.evaluate(
    (main) =>
      [main, ...main.querySelectorAll("*")].filter((element) => {
        const style = getComputedStyle(element);
        return style.borderTopWidth !== "0px" || style.boxShadow !== "none";
      }).length,
  );
  expect(drawn).toBe(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

/** A gate a routed request waits on, so a screen can be held while it is checked. */
function holdUntilReleased(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

for (const theme of THEMES) {
  test(`loading (${theme}): the wordmark and a quiet label while Clerk loads`, async ({ page }) => {
    test.skip(!REAL_CLERK, NEEDS_REAL_CLERK);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const gate = holdUntilReleased();
    await page.route("**/clerk.browser.js*", async (route) => {
      await gate.held;
      // A request the page navigated away from is already gone.
      await route.continue().catch(() => {});
    });
    for (const [label, viewport] of [
      ["", DESKTOP],
      ["-mobile", PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "commit" });
      await expectLoadingScreen(page, theme);
      await twoFrames(page);
      await page.screenshot({ path: shotPath(`loading${label}-${theme}`), fullPage: true });
    }
    // Once Clerk arrives, the same page moves on to sign-in.
    gate.release();
    await expect(page.getByTestId("sign-in-gate")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  });
}

test("loading while a signed-in person's identity is checked: the same screen", async ({
  page,
  context,
  baseURL,
}) => {
  const origin = baseURL ?? DEFAULT_APP_ORIGIN;
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(origin).cookie.replace("__session=", ""),
      url: origin,
    },
    { name: "oncue_dev_app", value: "1", url: origin },
  ]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const gate = holdUntilReleased();
  // The real Worker answers `/api/me`; the test only holds the answer back.
  await page.route("**/api/me", async (route) => {
    await gate.held;
    // A request the page navigated away from is already gone.
    await route.continue().catch(() => {});
  });
  await page.goto("/", { waitUntil: "commit" });
  await expectLoadingScreen(page, "dark");
  gate.release();
  await expect(page.getByTestId("auth-loading")).toHaveCount(0, { timeout: 15_000 });
});

test("before any script runs, the page is already the theme's canvas colour", async ({ page }) => {
  // No app code at all: only index.html's own head.
  await page.route("**/src/main.tsx*", (route) => route.abort());
  for (const [scheme, stored, expected] of [
    ["dark", null, "dark"],
    ["light", null, "light"],
    ["light", "dark", "dark"],
    ["dark", "light", "light"],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.evaluate((value) => {
      if (value === null) {
        window.localStorage.removeItem("oncue.theme");
      } else {
        window.localStorage.setItem("oncue.theme", value);
      }
    }, stored);
    await page.reload();
    const painted = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.documentElement).backgroundColor,
    }));
    expect(painted).toEqual({
      theme: expected,
      background: expected === "dark" ? "rgb(21, 21, 21)" : "rgb(255, 255, 255)",
    });
  }
});
