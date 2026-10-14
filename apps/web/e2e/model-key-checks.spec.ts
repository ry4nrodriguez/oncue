import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { scan } from "./a11y-scan";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RunningDouble,
  startProviderDouble,
} from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * A model key the provider no longer accepts, on the real Worker against the
 * provider double: Home refuses the session before anything is created, says
 * which provider rejected the key, and keeps the draft; Settings shows the key
 * invalid and Re-check brings it back once the provider accepts it again. Then
 * the keys are changed in Settings and a message is sent from Home without a
 * reload, which must use a key that exists.
 *
 * Runs in its own project because it switches the provider double's mode and
 * changes the dev workspace's model key.
 */

const SHOTS = fileURLToPath(
  new URL("../test-results/screenshots/model-key-checks/", import.meta.url),
);

/** Every session this lane starts has a title beginning with this. */
const LANE_TITLE = "Key checks,";

/** The key this lane connects. Its last four characters mark the rows it made. */
const LANE_KEY = "sk-ant-lane-kchk";
const LANE_HINT = "...kchk";

/** Older than the window in which a validated key is not asked about again. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

test.describe.configure({ mode: "serial" });

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
let workspaceId = "";
let seedConnectionId = "";

/** The dev workspace as `pnpm dev` seeds it: one working Anthropic key. */
async function seedWorkspace(): Promise<void> {
  const keyringSecret = devVars().get("ONCUE_BROKER_KEYRING");
  if (keyringSecret === undefined) {
    throw new Error(
      "apps/web/.dev.vars has no keyring; run `node apps/web/e2e/setup-local-auth.mjs`",
    );
  }
  await queryD1Batch(
    await seedStatements({
      subject: DEV_SUBJECT,
      keyringSecret,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(DEV_SUBJECT, queryD1),
    }),
  );
}

/** Removes the keys this lane connected, and nothing a developer added. */
async function removeLaneKeys(): Promise<void> {
  await queryD1(
    `DELETE FROM model_connection WHERE workspace_id = '${workspaceId}' AND provider_account_hint = '${LANE_HINT}'`,
  );
}

test.beforeAll(async () => {
  const origin = await appOrigin();
  const github = await startGitHubDouble(undefined, origin);
  await github.setState(devGitHubSeed());
  provider = await startProviderDouble();
  await provider.setMode("ok");
  const controller = await startControllerDouble({ controlPlaneOrigin: origin });
  closers = [
    () => github.close(),
    () => (provider as RunningDouble).close(),
    () => controller.close(),
  ];

  workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
  seedConnectionId = `mc_seed_${workspaceId.slice(4, 12)}`;
  // This lane's own sessions and keys from earlier runs; everything else stays.
  await cascadeDelete(
    [
      {
        table: "session_index",
        where: `workspace_id = '${workspaceId}' AND title LIKE '${LANE_TITLE}%'`,
      },
    ],
    queryD1Batch,
  );
  await removeLaneKeys();
  await seedWorkspace();
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  // The lanes after this one expect the seeded key, working.
  await removeLaneKeys();
  await seedWorkspace();
  for (const close of closers) {
    await close();
  }
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
}

/** Every answer to `POST /api/sessions` this page gets, with what was sent. */
function watchCreates(page: Page): { status: number; modelConnectionId: unknown }[] {
  const creates: { status: number; modelConnectionId: unknown }[] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() === "POST" && new URL(response.url()).pathname === "/api/sessions") {
      const sent = request.postDataJSON() as { modelConnectionId?: unknown };
      creates.push({ status: response.status(), modelConnectionId: sent.modelConnectionId });
    }
  });
  return creates;
}

async function connectionStatus(connectionId: string): Promise<string | undefined> {
  const rows = await queryD1<{ status: string }>(
    `SELECT status FROM model_connection WHERE connection_id = '${connectionId}'`,
  );
  return rows[0]?.status;
}

async function laneSessions(): Promise<number> {
  const rows = await queryD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM session_index WHERE workspace_id = '${workspaceId}' AND title LIKE '${LANE_TITLE}%'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function modelsChecks(): Promise<number> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  const { calls } = (await answer.json()) as { calls: { method: string; path: string }[] };
  return calls.filter((call) => call.method === "GET" && call.path === "/v1/models").length;
}

async function scanBothThemes(page: Page, label: string, within?: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const blocking = await scan(page, `${label}, ${theme}`, theme, within);
    expect(blocking, blocking.join("\n")).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a key the provider rejects refuses the session on Home, keeps the draft, and Re-check restores it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const text = `${LANE_TITLE} rejected key ${stamp}`;
  // Validated long ago, so the Worker asks the provider before creating anything.
  await queryD1(
    `UPDATE model_connection SET last_validated_at = '${LONG_AGO}' WHERE connection_id = '${seedConnectionId}'`,
  );
  const creates = watchCreates(page);
  await signIn(page);
  const composer = page.getByRole("textbox", { name: "Message" });

  await test.step("Home refuses the create and says which provider rejected the key", async () => {
    await provider?.setMode("auth_failed");
    const checksBefore = await modelsChecks();
    await composer.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();

    const notice = page.getByTestId("home-notice");
    await expect(notice).toContainText(
      "Anthropic rejected this key. Replace it in Settings or pick another model.",
    );
    await expect(notice.getByRole("link", { name: "Open Model providers" })).toBeVisible();
    // The draft is still there, and nothing was made.
    await expect(composer).toHaveValue(text);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(creates).toEqual([{ status: 409, modelConnectionId: seedConnectionId }]);
    expect(await laneSessions()).toBe(0);
    // The provider was asked about the key, once, and the connection is marked.
    expect(await modelsChecks()).toBe(checksBefore + 1);
    expect(await connectionStatus(seedConnectionId)).toBe("invalid");
    await page.screenshot({ path: `${SHOTS}home-key-rejected.png`, fullPage: true });
    await scanBothThemes(page, "home, key rejected");
  });

  await test.step("Settings shows the key invalid, and Re-check changes nothing while the provider still rejects it", async () => {
    await page
      .getByTestId("home-notice")
      .getByRole("link", { name: "Open Model providers" })
      .click();
    const card = page.getByTestId("provider-card-anthropic");
    await expect(card.getByText("Invalid", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Re-check the Anthropic key" }).click();
    await expect(page.getByTestId("recheck-result-anthropic")).toHaveText(
      "Anthropic rejected this key. Replace it to keep using these models.",
    );
    await expect(card.getByText("Invalid", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}settings-key-rejected.png`, fullPage: true });
    // The connected provider's card: the greyed catalog of a provider with no
    // key is not this lane's.
    await scanBothThemes(page, "settings, key rejected", "[data-testid='provider-card-anthropic']");
  });

  await test.step("Re-check says so, and changes nothing, when the provider cannot answer", async () => {
    await provider?.setMode("overloaded");
    const card = page.getByTestId("provider-card-anthropic");
    await card.getByRole("button", { name: "Re-check the Anthropic key" }).click();
    await expect(page.getByTestId("recheck-result-anthropic")).toHaveText(
      "OnCue couldn't reach Anthropic, so nothing changed. Try again in a moment.",
    );
    expect(await connectionStatus(seedConnectionId)).toBe("invalid");
  });

  await test.step("Re-check returns the key to Active once the provider accepts it", async () => {
    await provider?.setMode("ok");
    const card = page.getByTestId("provider-card-anthropic");
    await card.getByRole("button", { name: "Re-check the Anthropic key" }).click();
    await expect(page.getByTestId("recheck-result-anthropic")).toHaveText(
      "Anthropic accepted this key.",
    );
    await expect(card.getByText("Active", { exact: true })).toBeVisible();
    expect(await connectionStatus(seedConnectionId)).toBe("active");
    await page.screenshot({ path: `${SHOTS}settings-key-accepted.png`, fullPage: true });
  });

  await test.step("back on Home, without a reload, the same message starts a session", async () => {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Back" })
      .click();
    const again = page.getByRole("textbox", { name: "Message" });
    await again.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
    expect(creates.at(-1)).toEqual({ status: 201, modelConnectionId: seedConnectionId });
  });
});

test("after a key is revoked and another connected in Settings, Home sends the new key without a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await provider?.setMode("ok");
  const creates = watchCreates(page);
  await signIn(page);
  // Survives client-side navigation and is lost on a reload.
  await page.evaluate(() => {
    (window as unknown as { laneLoadedOnce?: boolean }).laneLoadedOnce = true;
  });

  await test.step("revoke the key and connect another, through the app's own links", async () => {
    await page.mouse.move(2, 300);
    await page.locator("[aria-label^='Account:']").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Model providers" })
      .click();
    const card = page.getByTestId("provider-card-anthropic");

    await card.getByRole("button", { name: "Revoke the Anthropic key", exact: true }).click();
    await page.getByTestId("revoke-dialog").getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByTestId("provider-status-anthropic")).toHaveText("Not connected");

    await card.getByRole("button", { name: "Connect Anthropic" }).click();
    await card.getByLabel("API key").fill(LANE_KEY);
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByTestId("provider-status-anthropic")).toContainText(LANE_HINT);
    await expect(card.getByText("Active", { exact: true })).toBeVisible();
  });

  const connected = await queryD1<{ connection_id: string }>(
    `SELECT connection_id FROM model_connection WHERE workspace_id = '${workspaceId}' AND status = 'active'`,
  );
  expect(connected).toHaveLength(1);
  const newConnectionId = connected[0]?.connection_id;
  expect(newConnectionId).not.toBe(seedConnectionId);

  await test.step("Home, reached without a reload, sends the key that exists", async () => {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Back" })
      .click();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`${LANE_TITLE} new key ${Date.now()}`);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });

    expect(creates).toEqual([{ status: 201, modelConnectionId: newConnectionId }]);
    expect(
      await page.evaluate(
        () => (window as unknown as { laneLoadedOnce?: boolean }).laneLoadedOnce === true,
      ),
    ).toBe(true);
  });
});
