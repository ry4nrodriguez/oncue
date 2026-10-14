import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  DOUBLE_MODAL_PAIR,
  existingIdsFor,
  SEED_ACCOUNT_LOGIN,
  SEED_GITHUB_LOGIN,
  SEED_GITHUB_USER_ID,
  SEED_INSTALLATION_ID,
  SEED_REPOSITORIES,
  SEED_USER_TOKEN,
  seedStatements,
} from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { scan } from "./a11y-scan";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { createSeedRepository } from "./github-bare-repo";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RecordedDoubleCall,
  type RunningDouble,
  startProviderDouble,
} from "./provider-double-server";
import { expectRuntimeReady } from "./runtime-ready";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT, LANE_IDLE_ALARM_SECONDS } from "./setup-local-auth.mjs";

/**
 * The composer's context gauge against the real Worker, session object,
 * bridge, and OpenCode, with the provider double reporting cache counts the
 * way Anthropic does (record 13). The gauge fills across turns, its popover's
 * numbers are the double's own report for the agent's latest call, and it
 * starts over when the next sandbox starts the conversation from a summary.
 *
 * Runs in its own project because it serves the controller double's port and
 * reads the provider double's call log, which another session would add to.
 * `ONCUE_SHOTS_DIR` also writes screenshots there.
 */

const SHOTS_DIR = process.env.ONCUE_SHOTS_DIR ?? "";

const LANE_TITLE = "Context meter,";

let ORIGIN = DEFAULT_APP_ORIGIN;
let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const seeded = SEED_REPOSITORIES.map((repository) => ({
    repository,
    seed: createSeedRepository(repository.fullName, "main", {}),
  }));
  const github = await startGitHubDouble(undefined, ORIGIN);
  await github.setState({
    users: [{ id: SEED_GITHUB_USER_ID, login: SEED_GITHUB_LOGIN }],
    installations: [
      {
        installationId: SEED_INSTALLATION_ID,
        account: { login: SEED_ACCOUNT_LOGIN, type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [SEED_GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [SEED_INSTALLATION_ID]: seeded.map(({ repository, seed }) => ({
        ...repository,
        cloneUrl: seed.cloneUrl,
      })),
    },
    refsByRepository: Object.fromEntries(
      seeded.map(({ repository, seed }) => [repository.fullName, { main: seed.sha }]),
    ),
    userTokens: { [SEED_USER_TOKEN]: SEED_GITHUB_USER_ID },
  });
  provider = await startProviderDouble();
  const controller: RunningControllerDouble = await startControllerDouble({
    controlPlaneOrigin: ORIGIN,
  });
  closers = [
    () => github.close(),
    () => (provider as RunningDouble).close(),
    () => controller.close(),
  ];

  await queryD1Batch(
    await seedStatements({
      subject: DEV_SUBJECT,
      keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(DEV_SUBJECT, queryD1),
    }),
  );
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
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  for (const close of closers) {
    await close();
  }
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === "") {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
}

async function doubleCalls(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

/** The agent's newest call: it offers tools, which a title request does not. */
async function latestAgentCall(): Promise<NonNullable<RecordedDoubleCall["usage"]>> {
  const calls = await doubleCalls();
  const usage = calls
    .filter((call) => call.tools > 0 && call.usage !== null && call.counted === null)
    .at(-1)?.usage;
  if (usage === undefined || usage === null) {
    throw new Error("the provider double recorded no agent call");
  }
  return usage;
}

/**
 * What the double's own counter answered for the broker's four counts of the
 * agent's latest prompt, told apart by what each body held: the bare message,
 * with the system prompt, with the harness's tools, and with OnCue's too.
 */
async function latestPromptCounts(): Promise<{
  readonly system: number;
  readonly tools: number;
  readonly oncueTools: number;
}> {
  const counts = (await doubleCalls()).flatMap((call) =>
    call.counted === null ? [] : [call.counted],
  );
  const last = (match: (count: (typeof counts)[number]) => boolean) => {
    const found = counts.filter(match).at(-1);
    if (found === undefined) {
      throw new Error("the provider double counted no such prompt");
    }
    return found.inputTokens;
  };
  const isOncue = (name: string) => name.startsWith("oncue_");
  const c0 = last((count) => !count.hasSystem && count.toolNames.length === 0);
  const c1 = last((count) => count.hasSystem && count.toolNames.length === 0);
  const c2 = last((count) => count.toolNames.length > 0 && !count.toolNames.some(isOncue));
  const c3 = last((count) => count.toolNames.some(isOncue));
  return { system: c1 - c0, tools: c2 - c1, oncueTools: c3 - c2 };
}

async function numberIn(scope: Locator, testId: string): Promise<number> {
  return Number(await scope.getByTestId(testId).getAttribute("data-value"));
}

/**
 * Opens the meter's popover, holds its size to the double's report and, when
 * `exact`, every part to the double's own counter, then closes it.
 */
async function expectMatchesDouble(page: Page, exact: boolean | "either"): Promise<number> {
  const usage = await latestAgentCall();
  const gauge = page.getByTestId("context-meter");
  await gauge.click();
  const popover = page.getByTestId("context-meter-popover");
  await expect(popover).toBeVisible();
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  await expect(popover.getByTestId("context-meter-used")).toHaveAttribute(
    "data-value",
    String(total),
  );
  // The double reports most of the context as cached, as Anthropic does.
  expect(usage.cacheRead + usage.cacheWrite).toBeGreaterThan(usage.input);
  await expect(popover).toContainText("at list prices");
  // A prompt this isolate has not counted yet is pending on its first answer.
  const pending = (await popover.getByTestId("context-meter-status").count()) > 0;
  if (exact === true || (exact === "either" && !pending)) {
    const counted = await latestPromptCounts();
    // The rows stay open across openings once expanded.
    const toggle = popover.getByTestId("context-meter-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") {
      await toggle.click();
    }
    const rows = popover.getByTestId("context-meter-rows");
    await expect(rows).toBeVisible();
    expect(await numberIn(rows, "context-meter-row-system")).toBe(counted.system);
    expect(await numberIn(rows, "context-meter-row-tools")).toBe(counted.tools);
    expect(await numberIn(rows, "context-meter-row-oncueTools")).toBe(counted.oncueTools);
    const conversation = await numberIn(rows, "context-meter-row-conversation");
    // Exact by subtraction: the parts sum to the provider's own total.
    expect(conversation).toBe(total - counted.system - counted.tools - counted.oncueTools);
    expect(conversation).toBeGreaterThan(0);
    await expect(popover.getByTestId("context-meter-status")).toHaveCount(0);
  } else {
    await expect(popover.getByTestId("context-meter-status")).toHaveText(
      "Breakdown appears after the next answer.",
    );
  }
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  return total;
}

test("the context gauge fills across turns with the provider's own counts, and starts over on a new sandbox", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await provider?.setMode("ok");
  await page.setViewportSize({ width: 1280, height: 860 });

  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  // Home has no conversation, so no gauge.
  await expect(page.getByTestId("context-meter")).toHaveCount(0);
  await composer.fill(`${LANE_TITLE} say hello`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });

  const gauge = page.getByTestId("context-meter");
  await expect(gauge).toBeVisible();
  const firstRow = page.getByTestId("row-sandbox").first();
  await expectRuntimeReady(firstRow);
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes.first()).toHaveAttribute("data-outcome", /.+/, { timeout: 150_000 });

  // It sits under the chat box's bottom-right corner, not inside the box.
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (box === null) {
      throw new Error("not laid out");
    }
    return box;
  };
  const chat = await boxOf(page.getByTestId("composer"));
  const meterBox = await boxOf(gauge);
  expect(meterBox.y).toBeGreaterThanOrEqual(chat.y + chat.height);
  expect(meterBox.x + meterBox.width).toBeLessThanOrEqual(chat.x + chat.width + 1);
  expect(meterBox.x + meterBox.width).toBeGreaterThan(chat.x + chat.width - 24);
  await expect(page.getByTestId("composer").getByTestId("context-meter")).toHaveCount(0);

  // Turn one: the meter has filled, and says by how much in its name.
  await expect(gauge).not.toHaveAttribute("data-percent", "0", { timeout: 15_000 });
  await expect(gauge).toHaveAccessibleName(/^Context: \d+% of (200k|1M) used$/);
  const first = await expectMatchesDouble(page, "either");

  // Keyboard: the meter is a button in the tab order, Enter opens it, and the
  // header's own button expands the parts.
  await gauge.focus();
  await page.keyboard.press("Enter");
  const opened = page.getByTestId("context-meter-popover");
  await expect(opened).toBeVisible();
  await opened.getByTestId("context-meter-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(opened.getByTestId("context-meter-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  // Turn two in the same sandbox: the conversation grew.
  await composer.fill("And once more, briefly.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(outcomes).toHaveCount(2, { timeout: 150_000 });
  await expect
    .poll(async () => Number(await page.getByTestId("context-meter").getAttribute("data-percent")))
    .toBeGreaterThan(0);
  // The same prompt, counted after the first answer: every part is exact now.
  const second = await expectMatchesDouble(page, true);
  expect(second).toBeGreaterThan(first);

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await gauge.click();
    const header = page.getByTestId("context-meter-toggle");
    if ((await header.getAttribute("aria-expanded")) === "true") {
      await header.click();
    }
    await shot(page, `collapsed-${theme}`);
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await shot(page, `expanded-${theme}`);
    const found = await scan(page, "context meter", theme);
    expect(found, found.join("\n")).toEqual([]);
    await page.keyboard.press("Escape");
  }
  await page.emulateMedia({ colorScheme: "light" });

  // At phone width the gauge stays on the strip and its popover on screen.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(gauge).toBeVisible();
  await gauge.click();
  const popover = page.getByTestId("context-meter-popover");
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  await expect(page.getByTestId("context-meter-rows")).toBeVisible();
  const expandedBox = await boxOf(popover);
  expect(expandedBox.x + expandedBox.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await shot(page, "expanded-mobile");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 860 });

  // Record 11's idle stop, then a resume on generation 2: the harness starts
  // a new conversation from the session's summary, so the gauge starts over.
  await expect(firstRow).toContainText("Sandbox stopped after going idle", {
    timeout: (LANE_IDLE_ALARM_SECONDS + 120) * 1000,
  });
  await composer.fill("Are you still there?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("row-sandbox")).toHaveCount(2, { timeout: 30_000 });
  await expectRuntimeReady(page.getByTestId("row-sandbox").nth(1));
  await expect(outcomes).toHaveCount(3, { timeout: 150_000 });
  await expect(gauge).not.toHaveAttribute("data-percent", "0", { timeout: 15_000 });
  await expectMatchesDouble(page, "either");
  await gauge.click();
  await expect(page.getByTestId("context-meter-note")).toContainText(
    "started this conversation over from a summary",
  );
  await shot(page, "after-resume");
  await page.keyboard.press("Escape");
});
