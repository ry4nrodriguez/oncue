import { expect, type Page, test } from "@playwright/test";
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
import { deriveKeyring, sealCredential } from "../worker/broker/envelope";
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
import { committedEvents, sessionIdOf } from "./session-events";
import { DEV_SUBJECT, LANE_IDLE_ALARM_SECONDS } from "./setup-local-auth.mjs";

/**
 * Changing a session's model between runs (record 15), against the real
 * Worker, session object, bridge, relay, Model Broker, and OpenCode, with the
 * provider double standing in for Anthropic and OpenAI. The first run is on an
 * Anthropic model; the owner picks GPT-6 Sol in the composer's chip, confirms,
 * and the next message runs on it in the same sandbox and the same OpenCode
 * conversation. After the idle stop, a change back starts on a new sandbox.
 *
 * Runs in its own project because it reads the provider double's call log,
 * which another session would add to, and serves the controller double's port.
 */

const LANE_TITLE = "Model switch,";

let ORIGIN = DEFAULT_APP_ORIGIN;
let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
let openaiConnectionId = "";
let anthropicConnectionId = "";
/** Whether this lane added the OpenAI key, so it can leave the workspace as it found it. */
let addedOpenAI = false;

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

  const keyringSecret = devVars().get("ONCUE_BROKER_KEYRING") as string;
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
  const anthropic = await queryD1<{ connection_id: string }>(
    `SELECT connection_id FROM model_connection WHERE workspace_id = '${workspaceId}' AND provider = 'anthropic' AND status = 'active'`,
  );
  anthropicConnectionId = String(anthropic[0]?.connection_id ?? "");
  // A second provider's key beside the seed's Anthropic one, sealed as the
  // model-key screen seals it, so the change crosses providers.
  const existing = await queryD1<{ connection_id: string }>(
    `SELECT connection_id FROM model_connection WHERE workspace_id = '${workspaceId}' AND provider = 'openai' AND status != 'revoked'`,
  );
  openaiConnectionId = String(
    existing[0]?.connection_id ?? `mc_seed_openai_${workspaceId.slice(4, 12)}`,
  );
  addedOpenAI = existing.length === 0;
  const keyring = await deriveKeyring(keyringSecret, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("ONCUE_BROKER_KEYRING is not a usable keyring");
  }
  const sealed = await sealCredential(
    keyring.keyring,
    { connectionId: openaiConnectionId, workspaceId, provider: "openai" },
    "seeded-local-openai-key",
  );
  const now = new Date().toISOString();
  await queryD1(
    `INSERT INTO model_connection (connection_id, workspace_id, provider, auth_type, credential_reference, status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at)
     VALUES ('${openaiConnectionId}', '${workspaceId}', 'openai', 'api_key', '${sealed}', 'active', 'local seed', NULL, '${now}', '${now}', '${now}')
     ON CONFLICT (connection_id) DO UPDATE SET credential_reference = excluded.credential_reference, status = 'active', updated_at = excluded.updated_at`,
  );
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  if (addedOpenAI && openaiConnectionId !== "") {
    await queryD1(`DELETE FROM model_connection WHERE connection_id = '${openaiConnectionId}'`);
  }
  for (const close of closers) {
    await close();
  }
});

async function doubleCalls(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

/** The agent's own calls: they offer tools, which a title request does not. */
function agentPaths(calls: readonly RecordedDoubleCall[]): string[] {
  return calls.filter((call) => call.tools > 0 && call.counted === null).map((call) => call.path);
}

async function pickModel(page: Page, name: RegExp): Promise<void> {
  await page.getByTestId("agent-chip").click();
  await page.getByTestId("agent-panel").getByRole("button", { name }).click();
}

async function indexedConnection(sessionId: string): Promise<string> {
  const rows = await queryD1<{ model_connection_id: string | null }>(
    `SELECT model_connection_id FROM session_index WHERE session_id = '${sessionId}'`,
  );
  return String(rows[0]?.model_connection_id ?? "");
}

test("the owner changes model between runs: in the same sandbox, then on a new one after the idle stop", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await provider?.setMode("ok");
  await page.setViewportSize({ width: 1280, height: 860 });

  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  // The session starts on an Anthropic model, whatever the browser last chose.
  await pickModel(page, /Opus 5\.5/);
  await page.keyboard.press("Escape");
  const chip = page.getByTestId("agent-chip-model");
  await expect(chip).toHaveText("Opus 5.5");
  // The double's log has no reset and a long-lived stack's holds other lanes'
  // calls, so every count is taken from where this lane began.
  const atStart = (await doubleCalls()).length;
  await composer.fill(`${LANE_TITLE} say hello`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  const sessionId = sessionIdOf(page);

  const sandboxes = page.getByTestId("row-sandbox");
  await expectRuntimeReady(sandboxes.first());
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes.first()).toHaveAttribute("data-outcome", /.+/, { timeout: 150_000 });
  const beforeChange = await doubleCalls();
  const firstRun = agentPaths(beforeChange.slice(atStart));
  expect(firstRun).toContain("/v1/messages");
  expect(firstRun).not.toContain("/v1/responses");

  // The chip offers the workspace's other models once the run has ended.
  await pickModel(page, /GPT-6 Sol/);
  // No dialog: the note under the composer says what the next message does.
  await expect(page.getByText(/for the next run\?/)).toHaveCount(0);
  const nextModel = page.getByTestId("composer-next-model");
  await expect(nextModel).toContainText("Your next message starts a run on GPT-6 Sol");
  await expect(nextModel).toContainText("charged to your OpenAI key");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const found = await scan(page, "model switch note", theme);
    expect(found, found.join("\n")).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
  // Nothing has changed until the owner sends a message.
  expect(
    (await committedEvents(page, sessionId)).filter((e) => e.type === "run.queued"),
  ).toHaveLength(1);
  await expect(chip).toHaveText("GPT-6 Sol");

  await composer.fill("And once more, briefly.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(outcomes).toHaveCount(2, { timeout: 150_000 });
  await expect(page.getByTestId("composer-next-model")).toHaveCount(0);
  await expect(chip).toHaveText("GPT-6 Sol");

  // The second run ran on OpenAI's API, in the sandbox the first run used.
  await expect(sandboxes).toHaveCount(1);
  const afterChange = (await doubleCalls()).slice(beforeChange.length);
  expect(agentPaths(afterChange)).toContain("/v1/responses");
  expect(agentPaths(afterChange)).not.toContain("/v1/messages");

  // Each run keeps its own model record, and the second says why it differs.
  const queued = (await committedEvents(page, sessionId)).filter(
    (event) => event.type === "run.queued",
  );
  expect(queued).toHaveLength(2);
  expect(queued[0]?.payload).toMatchObject({
    trigger: "initial",
    model: { provider: "anthropic", modelId: "claude-opus-5-5" },
  });
  expect(queued[1]?.payload).toMatchObject({
    trigger: "model_change",
    continuesRunId: queued[0]?.runId,
    model: {
      provider: "openai",
      modelId: "gpt-6-sol",
      modelConnectionId: openaiConnectionId,
      contextWindow: 1_050_000,
    },
  });
  // Settings counts sessions per key from this column, which follows the latest run.
  await expect
    .poll(() => indexedConnection(sessionId), { timeout: 15_000 })
    .toBe(openaiConnectionId);

  // After the idle stop no sandbox is attached, so a change back starts on a
  // new one, whose harness starts on the changed model.
  await expect(sandboxes.first()).toContainText("Sandbox stopped after going idle", {
    timeout: (LANE_IDLE_ALARM_SECONDS + 120) * 1000,
  });
  const beforeBack = (await doubleCalls()).length;
  await pickModel(page, /Opus 5\.5/);
  await expect(chip).toHaveText("Opus 5.5");
  await composer.fill("Are you still there?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(sandboxes).toHaveCount(2, { timeout: 30_000 });
  await expectRuntimeReady(sandboxes.nth(1));
  await expect(outcomes).toHaveCount(3, { timeout: 150_000 });
  const afterBack = (await doubleCalls()).slice(beforeBack);
  expect(agentPaths(afterBack)).toContain("/v1/messages");
  expect(agentPaths(afterBack)).not.toContain("/v1/responses");
  const all = (await committedEvents(page, sessionId)).filter(
    (event) => event.type === "run.queued",
  );
  expect(all[2]?.payload).toMatchObject({
    trigger: "model_change",
    model: { provider: "anthropic", modelId: "claude-opus-5-5" },
  });
  await expect
    .poll(() => indexedConnection(sessionId), { timeout: 15_000 })
    .toBe(anthropicConnectionId);
});
