import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { scan } from "./a11y-scan";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * The browser app under failure, on the real Worker, session object, bridge,
 * and OpenCode against the doubles: a failed `/api/me` and its recovery, a
 * real socket dropped and redialled, a message sent while disconnected, a
 * double click on Allow, a paused run whose sandbox is still up, and a key the
 * provider rejects, from the pause to the run continuing on its replacement. The
 * socket runs through Playwright's WebSocket route, which proxies every frame
 * to the real server and lets the lane cut the connection or refuse redials.
 * Runs in its own project because it reseeds the GitHub double and switches
 * the provider double's mode.
 */

const SHOTS = fileURLToPath(new URL("../test-results/screenshots/resilience/", import.meta.url));

/** Every session this test starts has a title beginning with this. */
const LANE_TITLE = "Resilience,";

/** A real sandbox start and a real OpenCode, with room to spare. */
const RUN_ENDS_MS = 120_000;

test.describe.configure({ mode: "serial" });

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;

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
  // This lane's own sessions from earlier runs; other sessions stay.
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
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  for (const close of closers) {
    await close();
  }
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
}

async function startFromHome(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
}

test("a failed /api/me shows a plain error with Retry, recovers, and a failed refetch keeps the app", async ({
  page,
}) => {
  test.setTimeout(RUN_ENDS_MS);
  let failMe = true;
  let refusals = 0;
  await page.route("**/api/me", async (route) => {
    if (!failMe) {
      await route.continue();
      return;
    }
    refusals += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable" }),
    });
  });

  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  const failed = page.getByTestId("auth-failed");
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(failed).toContainText("OnCue couldn't reach the server.");
  await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}auth-failed.png`, fullPage: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const blocking = await scan(page, `auth failed, ${theme}`, theme);
    expect(blocking, blocking.join("\n")).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
  // It keeps trying on its own while the error is up.
  await expect.poll(() => refusals, { timeout: 10_000 }).toBeGreaterThan(1);

  failMe = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });

  // A session start refetches `/api/me`; failing that refetch must not take
  // the signed-in app off the screen.
  failMe = true;
  const before = refusals;
  await startFromHome(page, `${LANE_TITLE} identity blip ${Date.now().toString(36)}`);
  await expect.poll(() => refusals, { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId("session-header")).toBeVisible();
  await expect(page.getByTestId("auth-failed")).toHaveCount(0);
  await expect(page.getByTestId("auth-loading")).toHaveCount(0);
  failMe = false;
});

test("the session socket drops, redials as one socket with no duplicate rows, holds a message sent while down, and refuses what the object would", async ({
  page,
}) => {
  test.setTimeout(6 * RUN_ENDS_MS);
  const stamp = Date.now().toString(36);

  // Every socket the page opens, proxied to the real server. `refuse` closes a
  // redial at once, as a server that is unreachable would.
  const routes: WebSocketRoute[] = [];
  // Routes still open; a route can report its close more than once.
  const open = new Set<WebSocketRoute>();
  let refuse = false;
  const written: Record<string, unknown>[] = [];
  await page.routeWebSocket(/\/ws\/sessions\/[^/]+\/client/, (ws) => {
    if (refuse) {
      void ws.close({ code: 4000, reason: "lane: unreachable" });
      return;
    }
    const server = ws.connectToServer();
    routes.push(ws);
    open.add(ws);
    ws.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { type?: string; command?: Record<string, unknown> };
        if (frame.type === "command" && frame.command !== undefined) {
          written.push(frame.command);
        }
      }
      server.send(message);
    });
    ws.onClose(() => {
      open.delete(ws);
      void server.close();
    });
  });
  const commandsOfType = (type: string) => written.filter((command) => command.type === type);
  const messageText = (command: Record<string, unknown>) => {
    const payload = command.payload as {
      text?: string;
      instruction?: { text?: string };
    };
    return payload.text ?? payload.instruction?.text ?? null;
  };

  await signIn(page);
  await startFromHome(page, `${LANE_TITLE} reconnect ${stamp}`);
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes).toHaveCount(1, { timeout: RUN_ENDS_MS });
  const composer = page.getByRole("textbox", { name: "Message" });
  const rows = page.locator("[data-testid^='row-']");

  await test.step("a dropped socket redials once, and the replay adds no row", async () => {
    await expect(page.getByTestId("connection-badge")).toHaveCount(0);
    const before = await rows.count();
    const userRows = await page.getByTestId("row-message-user").count();
    const opened = routes.length;

    await routes.at(-1)?.close({ code: 4000, reason: "lane: drop" });

    await expect.poll(() => routes.length, { timeout: 15_000 }).toBe(opened + 1);
    await expect(page.getByTestId("connection-badge")).toHaveCount(0, { timeout: 15_000 });
    expect(open.size).toBe(1);
    expect(await rows.count()).toBe(before);
    expect(await page.getByTestId("row-message-user").count()).toBe(userRows);
  });

  await test.step("a message sent while disconnected says it waits, then arrives once", async () => {
    refuse = true;
    await routes.at(-1)?.close({ code: 4000, reason: "lane: drop" });
    await expect(page.getByTestId("connection-badge")).toBeVisible();
    const notice = page.getByTestId("composer-send-notice");
    await expect(notice).toHaveAttribute("data-kind", "disconnected");

    const text = `${LANE_TITLE} sent while away ${stamp}`;
    await composer.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(notice).toHaveAttribute("data-kind", "queued");
    await expect(notice).toContainText("Your message will send when OnCue reconnects.");
    await expect(composer).toHaveJSProperty("readOnly", true);
    await page.screenshot({ path: `${SHOTS}message-held-while-disconnected.png`, fullPage: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const blocking = await scan(page, `held message, ${theme}`, theme);
      expect(blocking, blocking.join("\n")).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    expect(written.filter((command) => messageText(command) === text)).toEqual([]);

    refuse = false;
    // The next redial, at most one backoff step (8 s) away, carries it.
    await expect(composer).toHaveValue("", { timeout: 20_000 });
    await expect(page.getByTestId("row-message-user").filter({ hasText: text })).toHaveCount(1);
    await expect(outcomes).toHaveCount(2, { timeout: RUN_ENDS_MS });
    expect(written.filter((command) => messageText(command) === text)).toHaveLength(1);
    expect(open.size).toBe(1);
  });

  await test.step("a paused run with its sandbox up offers no send, and says why", async () => {
    // The model is refused at once, so the bridge pauses the run while its
    // sandbox stays up (record 15).
    await provider?.setMode("model_unavailable");
    await composer.fill(`${LANE_TITLE} this one pauses ${stamp}`);
    await page.getByRole("button", { name: "Send message" }).click();
    // The note names the failure the run paused on, then why no message can go yet.
    const wait = page.getByTestId("composer-model-failure");
    await expect(wait).toBeVisible({ timeout: RUN_ENDS_MS });
    await provider?.setMode("ok");
    await expect(wait).toContainText("Model request failed: the model is unavailable right now.");
    await expect(wait).toContainText("sandbox is still running");
    await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();

    const followUps = commandsOfType("run.follow_up").length;
    await composer.fill("will this reach it?");
    await composer.press("Enter");
    await page.waitForTimeout(500);
    expect(commandsOfType("run.follow_up")).toHaveLength(followUps);
    await expect(composer).toHaveValue("will this reach it?");
    await page.screenshot({ path: `${SHOTS}paused-run-with-live-sandbox.png`, fullPage: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const blocking = await scan(page, `paused run, ${theme}`, theme);
      expect(blocking, blocking.join("\n")).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // What the note offers works: Stop run ends it, and the draft can go as
    // the next run.
    await page.getByRole("button", { name: "Stop run" }).click();
    await expect(outcomes.last()).toHaveAttribute("data-outcome", "cancelled", {
      timeout: 30_000,
    });
    await expect(wait).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "title",
      "Starts the next run",
    );
    expect(commandsOfType("run.cancel")).toHaveLength(1);
  });
  await test.step("a double click on Allow sends one policy command", async () => {
    await provider?.setMode("propose_push");
    await composer.fill("Push this and open a draft PR");
    await page.getByRole("button", { name: "Send message" }).click();
    const card = page.getByTestId("policy-card");
    await expect(card).toBeVisible({ timeout: RUN_ENDS_MS });
    await provider?.setMode("ok");
    await expect(outcomes).toHaveCount(4, { timeout: RUN_ENDS_MS });

    await card.getByRole("button", { name: "Allow" }).dblclick();

    await expect(page.getByTestId("row-policy-updated")).toHaveCount(1, { timeout: 30_000 });
    expect(commandsOfType("policy.set")).toHaveLength(1);
    await expect(card).toHaveCount(0);
  });
});

/** The dev workspace's one key, as the Worker lists it. */
async function seededKey(page: Page): Promise<{ connectionId: string; status: string }> {
  const response = await page.request.get("/api/model-connections");
  const body = (await response.json()) as {
    connections: { connectionId: string; provider: string; status: string }[];
  };
  const key = body.connections.find(
    (connection) => connection.provider === "anthropic" && connection.status !== "revoked",
  );
  if (key === undefined) {
    throw new Error("the dev workspace has no Anthropic key; the seed did not run");
  }
  return key;
}

/** Replaces the key through the Worker's own route, which validates it against the provider double. */
async function replaceKey(page: Page, connectionId: string): Promise<void> {
  const response = await page.request.put(`/api/model-connections/${connectionId}`, {
    data: { credential: "replaced-local-model-key" },
  });
  expect(response.status()).toBe(200);
}

test("a key the provider rejects is named in the session and on Home, and the run continues once it is replaced", async ({
  page,
}) => {
  test.setTimeout(5 * RUN_ENDS_MS);
  const stamp = Date.now().toString(36);
  const failure = "Model request failed: the provider rejected the model key.";
  await signIn(page);
  const key = await seededKey(page);

  try {
    // The first model request is refused, so the broker marks the key invalid
    // and the bridge pauses the run (record 15).
    await provider?.setMode("auth_failed");
    await startFromHome(page, `${LANE_TITLE} rejected key ${stamp}`);
    const sessionUrl = page.url();
    const note = page.getByTestId("composer-model-failure");
    const paused = page.locator("[data-testid='row-run'][data-transition='paused']");

    await test.step("the session names the rejected key where the person is looking", async () => {
      await expect(note).toContainText(failure, { timeout: RUN_ENDS_MS });
      // The connections came with the page, before the rejection; the screen
      // reads them again and only then says what to do about the key.
      await expect(note).toContainText(
        "Replace the key under Settings, Model providers, then come back here to continue the run.",
      );
      await expect(page.getByTestId("composer-wait")).toHaveCount(0);
      // The session details are unpinned, as every chat opens.
      await expect(page.getByTestId("context-rail")).toHaveCount(0);
      await expect(paused).toBeVisible();
      await expect(paused).toContainText(failure);
      for (const link of await page.getByRole("link", { name: "Open Model providers" }).all()) {
        await expect(link).toHaveAttribute("href", "/settings/model-providers");
      }
      await expect(page.getByRole("link", { name: "Open Model providers" })).toHaveCount(2);
      expect((await seededKey(page)).status).toBe("invalid");
      await page.screenshot({ path: `${SHOTS}rejected-key-session.png`, fullPage: true });
    });

    await test.step("Home names the key and the sessions on it, and its models say Key rejected", async () => {
      await page.goto("/");
      const banner = page.getByTestId("home-key-banner");
      await expect(banner).toContainText(
        /The Anthropic key was rejected\. \d+ active sessions? uses? it and can't continue until the key is replaced\./,
        { timeout: 30_000 },
      );
      await expect(banner.getByRole("link", { name: "Replace the key" })).toHaveAttribute(
        "href",
        "/settings/model-providers",
      );
      await page.getByTestId("agent-chip").click();
      const rejected = page.locator("[data-testid^='model-replace-']");
      await expect(rejected.first()).toContainText("Key rejected");
      await expect(rejected.first()).toContainText("Replace");
      // No model of the rejected key can be chosen.
      await expect(page.getByTestId("agent-panel").getByTestId("model-row")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}rejected-key-home.png`, fullPage: true });
      await page.keyboard.press("Escape");
    });

    await test.step("once the idle sandbox stops, the note is the same sentence and the composer takes no message", async () => {
      await page.goto(sessionUrl);
      await expect(note).toContainText(
        "Replace the key under Settings, Model providers, then come back here to continue the run.",
        { timeout: 30_000 },
      );
      // A message would need a new sandbox on a key that cannot start one.
      await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled({
        timeout: RUN_ENDS_MS,
      });
      await expect(note).toContainText(
        "Replace the key under Settings, Model providers, then come back here to continue the run.",
      );
      await expect(page.getByText("start a new session")).toHaveCount(0);
    });

    await test.step("replacing the key is read on return to the tab, and the run continues from here", async () => {
      await provider?.setMode("ok");
      await replaceKey(page, key.connectionId);
      // Coming back from Settings or another tab; nothing is reloaded.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(note).toContainText(
        "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.",
        { timeout: 30_000 },
      );

      const composer = page.getByRole("textbox", { name: "Message" });
      await expect(composer).toBeEnabled();
      await composer.fill("Continue from the last checkpoint.");
      const send = page.getByRole("button", { name: "Send message" });
      await expect(send).toHaveAttribute("title", "Continue");
      await send.click();
      // The same run, resumed on a new sandbox, reaches an outcome.
      await expect(page.locator("[data-testid='row-run'][data-outcome]")).toHaveCount(1, {
        timeout: RUN_ENDS_MS,
      });
      await expect(note).toHaveCount(0);
      // The history keeps why it paused, with nothing left to do about it.
      await expect(paused).toContainText(failure);
      await expect(paused.getByRole("link")).toHaveCount(0);
    });

    await test.step("Home's banner is gone with the problem", async () => {
      await page.goto("/");
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("home-key-banner")).toHaveCount(0);
    });
  } finally {
    // Later lanes start sessions on this key.
    await provider?.setMode("ok");
    if ((await seededKey(page)).status !== "active") {
      await replaceKey(page, key.connectionId);
    }
  }
});
