import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import {
  MATRIX_CYCLE_MS,
  MATRIX_PATH,
  MATRIX_REST,
  MATRIX_STEP_MS,
  matrixOpacity,
} from "../src/features/home/status-matrix";
import { deriveWorkspaceId } from "../worker/auth/register";
import { SLOW_REPLY_MARKER } from "../worker/test/provider-double";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { analyseMatrix, headOf, type MatrixSample, thinSamples } from "./matrix-proof";
import { pointerOffSidebar } from "./pointer";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * The sidebar's session status marks, with four real sessions running on the
 * real Worker, session objects, bridge, and OpenCode:
 *
 * - The first uses the provider double's `propose_push` mode, so a card waits
 *   on the user.
 * - The second is watched to its end on its own screen, so its row stays unmarked.
 * - The third carries `SLOW_REPLY_MARKER`, so it is still working when the
 *   fourth, a quick one, has ended, whatever the machine's speed.
 *
 * Nothing reloads the page: `useSessionList` keeps the list fresh, and that is
 * under test. Runs in its own project because it reseeds the GitHub double and
 * switches the provider double's mode.
 */

const MEDIA = fileURLToPath(
  new URL("../test-results/screenshots/session-status-dots/", import.meta.url),
);

const EVIDENCE = fileURLToPath(
  new URL("../test-results/screenshots/session-status-dots/", import.meta.url),
);

/** A real sandbox start, a real OpenCode, and the slow reply's fifty seconds, with room to spare. */
const RUN_ENDS_MS = 150_000;

test.describe.configure({ mode: "serial" });

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;

/**
 * The dev subject's rows, written the way `pnpm dev` writes them
 * (`scripts/seed-local.ts`), because Playwright's own dev server is a bare
 * `vite` that seeds nothing. Idempotent: a workspace `pnpm dev` already
 * seeded keeps its ids.
 */
async function seedDevWorkspace(): Promise<void> {
  const keyringSecret = devVars().get("ONCUE_BROKER_KEYRING");
  if (keyringSecret === undefined) {
    throw new Error(
      "apps/web/.dev.vars has no keyring; run `node apps/web/e2e/setup-local-auth.mjs`",
    );
  }
  const statements = await seedStatements({
    subject: DEV_SUBJECT,
    keyringSecret,
    modalPair: DOUBLE_MODAL_PAIR,
    modalWorkspaceName: "oncue-local-double",
    existing: await existingIdsFor(DEV_SUBJECT, queryD1),
  });
  // Through the dev server's own D1 binding (`local-d1.ts`), never a second
  // process opening the file it holds.
  await queryD1Batch(statements);
  // This test's own sessions from earlier runs (titles start with
  // `LANE_TITLE`): a run cut short leaves one "working" forever. Other
  // sessions stay.
  const workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
  await cascadeDelete(
    [
      {
        table: "session_index",
        where: `workspace_id = '${workspaceId}' AND title LIKE '${LANE_TITLE}%'`,
      },
    ],
    queryD1Batch,
  );
}

/** Every session this test starts has a title beginning with this. */
const LANE_TITLE = "Status dots,";

test.beforeAll(async () => {
  const origin = await appOrigin();
  const github = await startGitHubDouble(undefined, origin);
  await github.setState(devGitHubSeed());
  const model = await startProviderDouble();
  provider = model;
  await model.setMode("ok");
  const controller = await startControllerDouble({ controlPlaneOrigin: origin });
  closers = [() => github.close(), () => model.close(), () => controller.close()];
  await seedDevWorkspace();
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  for (const close of closers) {
    await close();
  }
});

function rowOf(page: Page, title: string) {
  return page.getByTestId("sidebar").locator("a", { hasText: title });
}

type Dot = "working" | "needs_you" | "finished" | "idle";

/** Every row carries exactly one status slot; this waits for it to say `dot`. */
async function expectDot(page: Page, title: string, dot: Dot, timeout = 15_000): Promise<void> {
  const mark = rowOf(page, title).getByTestId("session-status-dot");
  await expect(mark).toHaveCount(1, { timeout });
  await expect(mark).toHaveAttribute("data-activity", dot, { timeout });
}

function markOf(page: Page, title: string) {
  return rowOf(page, title).getByTestId("session-status-dot");
}

function computed(page: Page, title: string, property: string): Promise<string> {
  return markOf(page, title).evaluate(
    (node, name) => getComputedStyle(node).getPropertyValue(name),
    property,
  );
}

/**
 * Back to Home, waiting for Home itself. The session screen has a "Message"
 * box of its own, which stays in the page for a moment after the click, and
 * text typed into it is gone when Home replaces it.
 */
async function goHome(page: Page): Promise<void> {
  await page.getByTestId("sidebar").getByRole("link", { name: "New session" }).click();
  await expect(
    page.getByTestId("home-screen").getByRole("textbox", { name: "Message" }),
  ).toBeVisible();
}

/** Sends a task from Home and returns the new session's id once the app is on its screen. */
async function startFromHome(page: Page, text: string): Promise<string> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").at(-1) as string;
}

/** The sidebar alone, light and dark, then the whole screen at phone width with the sidebar slid over it. */
async function shootSidebar(page: Page): Promise<void> {
  mkdirSync(MEDIA, { recursive: true });
  // Nothing hovered, so no row wears a hover fill in the picture.
  await page.mouse.move(900, 700);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.screenshot({ path: `${MEDIA}sidebar-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await sidebar.screenshot({ path: `${MEDIA}sidebar-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // At phone width a pinned sidebar would squeeze the canvas beside it; the
  // sidebar opens over it from the edge instead, which is how a phone sees it.
  const desktop = page.viewportSize();
  await page.getByRole("button", { name: "Unpin sidebar" }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.mouse.move(4, 400);
  await expect(sidebar).toBeInViewport();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${MEDIA}sidebar-mobile.png` });
  if (desktop !== null) {
    await page.setViewportSize(desktop);
  }
  await page.mouse.move(900, 700);
  await page.getByRole("button", { name: "Pin sidebar open" }).first().click();
}

/** Long enough for the trail to go round five times from any starting phase. */
const SAMPLE_MS = 5 * MATRIX_CYCLE_MS;

function movingDots(page: Page, title: string) {
  return markOf(page, title).locator("circle.status-matrix-dot");
}

/** The outer dots' computed opacities right now, in path order. */
function dotOpacities(page: Page, title: string): Promise<number[]> {
  return movingDots(page, title).evaluateAll((dots) =>
    dots.map((dot) => Number(getComputedStyle(dot).opacity)),
  );
}

/**
 * Samples the working mark's dots on every animation frame for `SAMPLE_MS`,
 * judges them with `analyseMatrix`, and keeps the verdict and a sample every
 * step as evidence.
 */
async function proveMatrix(page: Page, title: string, theme: "light" | "dark"): Promise<void> {
  await expectDot(page, title, "working", 1_000);
  await expect(movingDots(page, title)).toHaveCount(MATRIX_PATH.length);
  const samples = await markOf(page, title).evaluate(
    (node, duration) =>
      new Promise<{ t: number; opacities: number[] }[]>((resolve) => {
        const dots = [...node.querySelectorAll("circle.status-matrix-dot")];
        const out: { t: number; opacities: number[] }[] = [];
        const start = performance.now();
        const tick = () => {
          const t = performance.now() - start;
          out.push({ t, opacities: dots.map((dot) => Number(getComputedStyle(dot).opacity)) });
          if (t < duration) {
            requestAnimationFrame(tick);
          } else {
            resolve(out);
          }
        };
        requestAnimationFrame(tick);
      }),
    SAMPLE_MS,
  );
  const verdict = analyseMatrix(samples satisfies MatrixSample[]);
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    `${EVIDENCE}matrix-${theme}.json`,
    `${JSON.stringify(
      {
        theme,
        capturedAt: new Date().toISOString(),
        stepMs: MATRIX_STEP_MS,
        cycleMs: MATRIX_CYCLE_MS,
        sampledForMs: SAMPLE_MS,
        colour: await computed(page, title, "color"),
        verdict,
        everyStep: thinSamples(samples, MATRIX_STEP_MS),
      },
      null,
      2,
    )}\n`,
  );
  expect(verdict.reasons, `the working mark did not animate in ${theme}`).toEqual([]);
}

/**
 * Pictures of one cycle: the mark's animations are paused and stepped, so each
 * frame is the moment it is labelled with. Writes an eight-frame filmstrip and,
 * when `ffmpeg` is present, an animated GIF of the sidebar.
 */
async function pictureOneCycle(page: Page, title: string, theme: "light" | "dark") {
  await expectDot(page, title, "working", 1_000);
  await page.mouse.move(900, 700);
  const mark = markOf(page, title);
  const setTime = (t: number | null) =>
    mark.evaluate((node, at) => {
      const animations = node.getAnimations({ subtree: true });
      if (animations.length === 0) {
        throw new Error("the working mark has no running animation");
      }
      for (const animation of animations) {
        if (at === null) {
          // Back to the page clock, as `syncToTimeline` in `Sidebar.tsx` keeps it.
          animation.startTime = 0;
        } else {
          animation.pause();
          animation.currentTime = at;
        }
      }
    }, t);

  const frames: { t: number; row: string; mark: string }[] = [];
  for (let index = 0; index < MATRIX_PATH.length; index += 1) {
    // Mid-step: on a step's edge the browser may show either neighbour.
    const t = (index + 0.5) * MATRIX_STEP_MS;
    await setTime(t);
    // A paused frame is exactly the frame the design calls for at that moment.
    expect(await dotOpacities(page, title)).toEqual(
      MATRIX_PATH.map((_, dot) => matrixOpacity(dot, t)),
    );
    frames.push({
      t,
      row: (await rowOf(page, title).screenshot()).toString("base64"),
      mark: (await mark.locator("svg").screenshot()).toString("base64"),
    });
  }

  const box = await page.getByTestId("sidebar").boundingBox();
  const gifFrames = mkdtempSync(join(tmpdir(), "oncue-status-dots-gif-"));
  const gifFrameMs = MATRIX_STEP_MS / 3;
  if (box !== null) {
    for (let index = 0; index < MATRIX_CYCLE_MS / gifFrameMs; index += 1) {
      await setTime((index + 0.5) * gifFrameMs);
      await page.screenshot({
        path: join(gifFrames, `f${String(index).padStart(2, "0")}.png`),
        clip: { x: box.x, y: box.y + 88, width: box.width, height: 300 },
      });
    }
  }
  await setTime(null);

  const dark = theme === "dark";
  const cells = frames
    .map(
      (frame) => `<figure>
        <img src="data:image/png;base64,${frame.row}" alt="">
        <img class="mark" src="data:image/png;base64,${frame.mark}" alt="">
        <figcaption>t = ${(frame.t / 1000).toFixed(2)} s</figcaption>
      </figure>`,
    )
    .join("");
  const sheet = await page.context().newPage();
  await sheet.setViewportSize({ width: 1200, height: 300 });
  await sheet.setContent(`<!doctype html><html><body style="margin:0;padding:16px 20px;
      background:${dark ? "#111111" : "#ffffff"};color:${dark ? "#ededec" : "#171717"};
      font:13px system-ui,sans-serif">
    <style>
      h1 { font-size: 15px; font-weight: 600; margin: 0 0 12px }
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px }
      figure { margin: 0; border: 1px solid ${dark ? "#2c2c2a" : "#e5e5e5"}; border-radius: 8px; padding: 8px }
      img { width: 100%; image-rendering: pixelated; display: block }
      img.mark { width: 80px; height: 80px; margin: 8px auto 4px }
      figcaption { text-align: center; font-variant-numeric: tabular-nums }
    </style>
    <h1>Working mark, ${theme} theme: one ${MATRIX_CYCLE_MS / 1000} s cycle, a frame every ${MATRIX_STEP_MS} ms (the row as drawn, and its mark enlarged)</h1>
    <div class="grid">${cells}</div>
  </body></html>`);
  mkdirSync(MEDIA, { recursive: true });
  await sheet.screenshot({ path: `${MEDIA}matrix-filmstrip-${theme}.png`, fullPage: true });
  await sheet.close();

  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (ffmpeg.status !== 0) {
    console.log(`status-dots: ffmpeg is not on this machine, so no ${theme} GIF was made`);
    return;
  }
  const made = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(1000 / gifFrameMs),
      "-i",
      join(gifFrames, "f%02d.png"),
      "-vf",
      "scale=iw*2:-1:flags=neighbor,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop",
      "0",
      `${MEDIA}matrix-sidebar-${theme}.gif`,
    ],
    { stdio: "inherit" },
  );
  expect(made.status, "ffmpeg could not make the GIF").toBe(0);
}

test("sessions at once: a dot matrix for working, yellow for needs you, blue for finished, nothing otherwise, and opening clears finished", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const stamp = Date.now().toString(36);
  const asking = `${LANE_TITLE} push this and open a draft PR ${stamp}`;
  const slow = `${LANE_TITLE} the slow one ${SLOW_REPLY_MARKER} ${stamp}`;
  const quick = `${LANE_TITLE} the quick one ${stamp}`;
  const seen = `${LANE_TITLE} watched to the end ${stamp}`;

  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  // The open sidebar's wordmark would cover the shell's pin button.
  await pointerOffSidebar(page);
  await page.getByRole("button", { name: "Pin sidebar open" }).first().click();

  // A session that ends up waiting on the user: its model asks to widen the
  // Git behavior, which only the user can confirm, so a card stays open.
  await provider?.setMode("propose_push");
  await startFromHome(page, asking);
  await goHome(page);
  await expectDot(page, asking, "needs_you", RUN_ENDS_MS);
  // Two groups only, and here only one: every session sits under Active.
  await expect(
    page.getByTestId("sidebar").getByRole("button", { name: /^(Pinned|Needs you|Active|Recent)$/ }),
  ).toHaveText(["Active"]);
  await provider?.setMode("ok");

  // A session the user watches end on its own screen: it never shows the
  // finished mark there, and its row stays unmarked once they leave.
  await startFromHome(page, seen);
  await expectDot(page, seen, "idle", RUN_ENDS_MS);
  await goHome(page);
  await expectDot(page, seen, "idle");

  // The slow session: working from the moment it exists, on its own screen.
  const slowId = await startFromHome(page, slow);
  await expectDot(page, slow, "working");

  // Back to Home and another session while the slow one still works.
  await goHome(page);
  await expectDot(page, slow, "working");
  const quickId = await startFromHome(page, quick);
  expect(quickId).not.toBe(slowId);
  await goHome(page);
  await expectDot(page, slow, "working");
  await expectDot(page, quick, "working");

  // The working mark animates: sampled every frame for five cycles in each
  // theme, and two working rows show the same frame at the same moment.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await proveMatrix(page, slow, theme);
  }
  if ((await markOf(page, quick).getAttribute("data-activity")) === "working") {
    const bothNow = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "[data-testid='session-status-dot'][data-activity='working']",
          ),
        ]
          .slice(0, 2)
          .map((mark) =>
            [...mark.querySelectorAll("circle.status-matrix-dot")].map((dot) =>
              Number(getComputedStyle(dot).opacity),
            ),
          ),
      );
    // Read again when a read lands on the instant of a step: marks out of
    // step would never agree, however often they are read.
    await expect
      .poll(
        async () => {
          const [first, second] = await bothNow();
          return (
            first !== undefined &&
            headOf(first) !== null &&
            JSON.stringify(first) === JSON.stringify(second)
          );
        },
        { timeout: 2_000 },
      )
      .toBe(true);
  }
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await pictureOneCycle(page, slow, theme);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // The quick one ends while the slow one still works, and the sidebar says
  // so on Home without a reload: one matrix moving, one solid dot.
  await expectDot(page, quick, "finished", RUN_ENDS_MS);
  await expectDot(page, slow, "working", 1_000);
  await expectDot(page, asking, "needs_you", 1_000);
  await expect(rowOf(page, quick).getByRole("img", { name: /, not opened yet$/ })).toBeVisible();
  await expectDot(page, seen, "idle", 1_000);

  // Blue for finished and yellow for needs you, each deepened in light so it
  // clears 3:1 on white. An unmarked row draws nothing, in a slot the same
  // size as every mark so the titles line up.
  expect(await computed(page, quick, "background-color")).toBe("rgb(47, 111, 237)");
  expect(await computed(page, asking, "background-color")).toBe("rgb(181, 138, 0)");
  expect(await computed(page, seen, "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await computed(page, seen, "border-top-width")).toBe("0px");
  await expect(markOf(page, seen).locator("*")).toHaveCount(0);
  const size = await computed(page, quick, "width");
  for (const title of [asking, slow, seen]) {
    expect(await computed(page, title, "width")).toBe(size);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await computed(page, quick, "background-color")).toBe("rgb(91, 157, 255)");
  expect(await computed(page, asking, "background-color")).toBe("rgb(242, 194, 48)");
  expect(await computed(page, seen, "background-color")).toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Working is the grey matrix; a reader who asked for less motion gets its
  // first frame, still.
  if ((await markOf(page, slow).getAttribute("data-activity")) === "working") {
    const firstDot = movingDots(page, slow).first();
    const animationName = () => firstDot.evaluate((dot) => getComputedStyle(dot).animationName);
    expect(await computed(page, slow, "color")).toBe("rgb(118, 118, 118)");
    expect(await computed(page, slow, "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await animationName()).toBe("status-matrix");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await animationName()).toBe("none");
    expect(await dotOpacities(page, slow)).toEqual(
      MATRIX_PATH.map((_, dot) => matrixOpacity(dot, 0)),
    );
    // The centre never moves.
    expect(
      await markOf(page, slow)
        .locator("circle:not(.status-matrix-dot)")
        .evaluate((dot) => Number(getComputedStyle(dot).opacity)),
    ).toBe(MATRIX_REST);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  await shootSidebar(page);

  // The slow one ends too, while the user is looking at Home.
  await expectDot(page, slow, "finished", RUN_ENDS_MS);

  // Opening the slow one clears its dot, and it stays clear after leaving.
  await rowOf(page, slow).click();
  await page.waitForURL(new RegExp(`/sessions/${slowId}$`));
  await expectDot(page, slow, "idle");
  await expectDot(page, quick, "finished");
  await goHome(page);
  await expectDot(page, slow, "idle");
  await expectDot(page, quick, "finished");

  // Seen is remembered in this browser, not only in memory.
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await pointerOffSidebar(page);
  await page.getByRole("button", { name: "Pin sidebar open" }).first().click();
  await expectDot(page, slow, "idle");
  await expectDot(page, quick, "finished");

  // And the second one clears the same way.
  await rowOf(page, quick).click();
  await page.waitForURL(new RegExp(`/sessions/${quickId}$`));
  await expectDot(page, quick, "idle");
  await goHome(page);
  await expectDot(page, quick, "idle");
  await expectDot(page, slow, "idle");
});
