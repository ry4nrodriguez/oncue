import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RecordedDoubleCall,
  type RunningDouble,
  startProviderDouble,
} from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { committedEvents, type StoredEvent, sessionIdOf } from "./session-events";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * Subagents end to end (record 12): the real Worker, session object, bridge,
 * and OpenCode, with the provider double scripted (`subagents` mode,
 * `worker/test/subagent-script.ts`) so the model starts subagents through
 * OpenCode's own `task` tool. The task's "[agents:...]" names what each
 * subagent does. Each lane checks the timeline's subagent rows, the
 * running-agents pill, and the side panel's Agents view, then keeps a picture.
 * A start is an agent permission ask (record 09): the first lane answers its
 * card under Allow once, and the rest start their sessions with Allow for this
 * session, so no card shows.
 *
 * Runs in its own project: it switches the provider double's mode, serves the
 * controller double's port, and resets the dev workspace's approval default.
 */

const SHOTS = fileURLToPath(new URL("../test-results/screenshots/subagents/", import.meta.url));
/** A real OpenCode start, the subagents' own turns, and the run's checks, with room to spare. */
const RUN_ENDS_MS = 240_000;
const LANE_TITLE = "Subagents,";

test.describe.configure({ mode: "serial" });

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;

async function seedDevWorkspace(): Promise<void> {
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
  // The default, asking, with nothing saved, so a start's card is the object's choice.
  await queryD1Batch([
    `DELETE FROM workspace_approval_rule WHERE workspace_id = '${workspaceId}'`,
    `DELETE FROM workspace_approval_setting WHERE workspace_id = '${workspaceId}'`,
  ]);
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const origin = await appOrigin();
  const github = await startGitHubDouble(undefined, origin);
  await github.setState(devGitHubSeed());
  const model = await startProviderDouble();
  provider = model;
  await model.setMode("subagents");
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

async function providerCalls(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

/**
 * Starts a session from Home. "session" chooses Allow for this session in
 * Home's picker first, so the session starts its subagents without a card.
 */
async function startSession(
  page: Page,
  text: string,
  mode: "ask" | "session" = "session",
): Promise<void> {
  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  if (mode === "session") {
    await page.getByTestId("approval-mode").click();
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitemradio", { name: /^Allow for this session/ }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "session");
  }
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
}

function agentRow(page: Page, description: string) {
  return page.getByTestId("row-agent").filter({ hasText: description });
}

/** The run's outcome row, once the run has ended. */
async function expectRunEnded(page: Page): Promise<void> {
  await expect(page.locator("[data-testid='row-run'][data-outcome]").first()).toBeVisible({
    timeout: RUN_ENDS_MS,
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  // Away from the left edge, which reveals the sidebar, and from every row.
  await page.mouse.move(640, 8);
  await page.screenshot({ path: `${SHOTS}${name}.png` });
}

const permissionCard = (page: Page) => page.getByTestId("permission-card");

/** The subagents of one run that the session object stored as ended, cancelled. */
function cancelledAgents(events: readonly StoredEvent[], runId: string | null): string[] {
  return events
    .filter(
      (event) =>
        event.type === "agent.completed" &&
        event.runId === runId &&
        event.payload.status === "cancelled",
    )
    .map((event) => String(event.payload.agentId))
    .sort();
}

test("under Allow once, a start shows its card, and Allow once starts it", async ({ page }) => {
  test.setTimeout(RUN_ENDS_MS + 120_000);
  await startSession(page, `${LANE_TITLE} ask first [agents:ok] ${Date.now()}`, "ask");
  await expect(page.getByTestId("approval-mode")).toHaveAttribute("data-mode", "ask");
  await expect(permissionCard(page)).toBeVisible({ timeout: RUN_ENDS_MS });
  await expect(page.getByTestId("permission-title")).toHaveText(
    "Start the general subagent: Subagent 1 (ok)",
  );
  await expect(permissionCard(page)).toContainText("Starting a subagent");
  // Nothing starts before the answer.
  await expect(agentRow(page, "Subagent 1 (ok)")).toHaveCount(0);
  await shoot(page, "lane-ask-card");

  await permissionCard(page).getByTestId("permission-allow-once").click();
  const row = agentRow(page, "Subagent 1 (ok)");
  await expect(row).toBeVisible({ timeout: RUN_ENDS_MS });
  await expectRunEnded(page);
  await expect(row).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("row-permission")).toHaveText([
    "Allowed once: start the general subagent: Subagent 1 (ok)",
  ]);
});

test("one subagent: its row, its detail, and its report, through the relay", async ({ page }) => {
  test.setTimeout(RUN_ENDS_MS + 120_000);
  const callsBefore = (await providerCalls()).length;
  await startSession(page, `${LANE_TITLE} find the README [agents:ok] ${Date.now()}`);

  const row = agentRow(page, "Subagent 1 (ok)");
  await expect(row).toBeVisible({ timeout: RUN_ENDS_MS });
  await expectRunEnded(page);
  await expect(row).toHaveAttribute("data-status", "completed");
  // Allow for this session started it with no card, and the timeline says so.
  await expect(permissionCard(page)).toHaveCount(0);
  await expect(page.getByTestId("row-permission")).toHaveText([
    "Allowed for this session: start the general subagent: Subagent 1 (ok)",
  ]);
  // Its own words and its call are not the primary agent's: they stay off the
  // timeline. The primary agent's only call is the start, drawn as the row
  // above, so a tool row here, folded or not, would be the subagent's own.
  await expect(page.getByText("Subagent 1 looked and found the README.")).toHaveCount(0);
  await expect(page.getByTestId("row-tool")).toHaveCount(0);
  await expect(page.getByTestId("running-agents-pill")).toHaveCount(0);

  await row.click();
  const panel = page.getByTestId("session-panel");
  await expect(panel.getByTestId("agent-detail-title")).toHaveText("Subagent 1 (ok)");
  await expect(panel.getByTestId("agent-detail-meta")).toContainText("Model");
  await expect(panel.getByTestId("agent-detail-meta")).toContainText("Completed");
  await expect(panel.getByTestId("agent-prompt")).toContainText("Look at the work tree");
  await expect(panel.getByTestId("agent-steps").getByTestId("row-activity")).toContainText(
    "Ran 1 command",
  );
  // That command is the page's one tool row, and it is in the subagent's steps.
  await expect(panel.getByTestId("agent-steps").getByTestId("row-tool")).toHaveCount(1);
  await expect(page.getByTestId("row-tool")).toHaveCount(1);
  // Its report is its last words, shown once, beneath its steps.
  await expect(panel.getByTestId("agent-steps")).toContainText(
    "Subagent 1 looked and found the README.",
  );
  await expect(panel.getByTestId("agent-result")).toHaveCount(0);
  await shoot(page, "lane-one-detail");

  await panel.getByRole("button", { name: "Back to agents" }).click();
  await expect(panel.getByTestId("agent-finished-row")).toHaveText(/Subagent 1 \(ok\).*Completed/);

  // The subagent's own model calls went through the relay and the broker to
  // the provider like the primary agent's: its two turns are among the calls.
  const calls = (await providerCalls()).slice(callsBefore);
  expect(calls.filter((call) => call.path === "/v1/messages").length).toBeGreaterThanOrEqual(4);
});

test("two side by side: one reports, one fails, and the run goes on", async ({ page }) => {
  test.setTimeout(RUN_ENDS_MS + 120_000);
  await startSession(page, `${LANE_TITLE} two at once [agents:ok,fail] ${Date.now()}`);
  await expect(agentRow(page, "Subagent 1 (ok)")).toBeVisible({ timeout: RUN_ENDS_MS });
  await expect(agentRow(page, "Subagent 2 (fail)")).toBeVisible();
  await expectRunEnded(page);
  await expect(agentRow(page, "Subagent 2 (fail)")).toHaveAttribute("data-status", "failed");
  await expect(agentRow(page, "Subagent 1 (ok)")).toHaveAttribute("data-status", "completed");
  // The primary agent heard back from both and answered.
  await expect(
    page.getByTestId("row-message-assistant").filter({ hasText: "The subagents reported back." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open side panel" }).click();
  await page.getByTestId("panel-open-agents").click();
  const finished = page.getByTestId("agents-finished");
  await expect(finished.getByTestId("agent-finished-row")).toHaveCount(2);
  await expect(finished).toContainText("Failed");
  await expect(finished).toContainText("Completed");
  await shoot(page, "lane-two-finished");
});

test("the limit, one stopped from the panel, then the whole run stopped", async ({ page }) => {
  test.setTimeout(RUN_ENDS_MS + 180_000);
  await startSession(
    page,
    `${LANE_TITLE} five slow ones [agents:slow,slow,slow,slow,slow] ${Date.now()}`,
  );

  // Four run; the fifth start is refused at the bridge with a reason the model
  // reads, before any approval, so the timeline records four starts.
  const pill = page.getByTestId("running-agents-pill");
  await expect(pill).toHaveText("4 running agents", { timeout: RUN_ENDS_MS });
  await expect(page.getByTestId("row-agent")).toHaveCount(4);
  await expect(page.getByTestId("row-permission")).toHaveCount(4);
  await shoot(page, "lane-limit-timeline");

  await pill.click();
  const panel = page.getByTestId("session-panel");
  const running = panel.getByTestId("agent-running-row");
  await expect(running).toHaveCount(4);
  await expect(running.first()).toContainText("Running a command", { timeout: 60_000 });
  await shoot(page, "lane-limit-running");

  // Stop one: it alone moves to Finished, as Stopped, and the rest run on.
  await running.first().getByTestId("agent-stop").click();
  await expect(running).toHaveCount(3, { timeout: 60_000 });
  await expect(pill).toHaveText("3 running agents");
  await expect(panel.getByTestId("agent-finished-row")).toHaveCount(1);
  await expect(panel.getByTestId("agent-finished-row")).toContainText("Stopped");
  await shoot(page, "lane-stopped-one");

  // Stop the run: the screen reads every subagent of an ended run as stopped.
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(pill).toHaveCount(0, { timeout: 60_000 });
  await expect(running).toHaveCount(0);
  await expect(panel.getByTestId("agent-finished-row")).toHaveCount(4, { timeout: 60_000 });
  for (const row of await panel.getByTestId("agent-finished-row").all()) {
    await expect(row).toContainText("Stopped");
  }
  await expect(page.getByTestId("row-agent")).toHaveCount(4);
  await shoot(page, "lane-run-stopped");

  // The screen would say that with nothing aborted, so the session's stored
  // events are asked: every subagent the run was waiting on ended, cancelled,
  // the one stopped from the panel and the three the run took with it.
  const sessionId = sessionIdOf(page);
  const started = (await committedEvents(page, sessionId)).filter(
    (event) => event.type === "agent.started",
  );
  expect(started).toHaveLength(4);
  const runId = started[0]?.runId ?? null;
  expect(runId).not.toBeNull();
  expect(started.every((event) => event.runId === runId)).toBe(true);
  await expect
    .poll(async () => cancelledAgents(await committedEvents(page, sessionId), runId), {
      timeout: 60_000,
      intervals: [1_000],
    })
    .toEqual(started.map((event) => String(event.payload.agentId)).sort());

  // Clearing the finished list leaves the empty state.
  await panel.getByRole("button", { name: "Clear finished subagents" }).click();
  await expect(panel.getByTestId("agents-empty")).toBeVisible();
});
