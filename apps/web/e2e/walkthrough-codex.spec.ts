/**
 * The Codex walkthrough: pick Codex and an OpenAI model on Home, send a task,
 * and watch it run on a real Codex binary with the real bridge, relay, and
 * Model Broker against the provider double's Responses API.
 *
 * Runs only where `ONCUE_DEV_CODEX_BIN` names a `codex` binary, set for the
 * whole run so the fixtures allow Codex and the controller double passes it on:
 *
 *   ONCUE_DEV_CODEX_BIN=/path/to/codex node apps/web/e2e/setup-local-auth.mjs
 *   ONCUE_DEV_CODEX_BIN=/path/to/codex pnpm test:e2e -- --project codex
 */

import { expect, test } from "@playwright/test";
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
import { EDIT_FILE_PATH } from "../worker/test/provider-double";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { createSeedRepository } from "./github-bare-repo";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1 } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RecordedDoubleCall,
  startProviderDouble,
} from "./provider-double-server";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

const CODEX_BIN = process.env.ONCUE_DEV_CODEX_BIN;
test.skip(CODEX_BIN === undefined, "needs ONCUE_DEV_CODEX_BIN: a codex binary on this machine");

let ORIGIN = DEFAULT_APP_ORIGIN;
const closers: Array<() => Promise<void>> = [];
let provider: Awaited<ReturnType<typeof startProviderDouble>> | null = null;

async function providerCalls(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const github = await startGitHubDouble();
  closers.push(() => github.close());
  const seeded = SEED_REPOSITORIES.map((repository) => ({
    repository,
    seed: createSeedRepository(repository.fullName, "main"),
  }));
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
  closers.push(async () => provider?.close());
  const controller: RunningControllerDouble = await startControllerDouble({
    controlPlaneOrigin: ORIGIN,
  });
  closers.push(() => controller.close());

  const keyringSecret = devVars().get("ONCUE_BROKER_KEYRING") as string;
  const statements = await seedStatements({
    subject: DEV_SUBJECT,
    keyringSecret,
    modalPair: DOUBLE_MODAL_PAIR,
    modalWorkspaceName: "oncue-local-double",
    existing: await existingIdsFor(DEV_SUBJECT, queryD1),
  });
  // Codex drives OpenAI models only, so the workspace gets an OpenAI key
  // beside the seed's Anthropic one, sealed as the model-key screen seals it.
  const workspaceId = await deriveWorkspaceId(DEV_SUBJECT);
  const connectionId = `mc_seed_openai_${workspaceId.slice(4, 12)}`;
  const keyring = await deriveKeyring(keyringSecret, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("ONCUE_BROKER_KEYRING is not a usable keyring");
  }
  const sealed = await sealCredential(
    keyring.keyring,
    { connectionId, workspaceId, provider: "openai" },
    "seeded-local-openai-key",
  );
  const now = new Date().toISOString();
  statements.push(
    `INSERT INTO model_connection (connection_id, workspace_id, provider, auth_type, credential_reference, status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at)
     VALUES ('${connectionId}', '${workspaceId}', 'openai', 'api_key', '${sealed}', 'active', 'local seed', NULL, '${now}', '${now}', '${now}')
     ON CONFLICT (connection_id) DO UPDATE SET credential_reference = excluded.credential_reference, status = 'active', updated_at = excluded.updated_at`,
  );
  await queryD1(statements);
});

test.afterAll(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

test("pick Codex and an OpenAI model on Home, send a task, and watch Codex edit, verify, and end", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await provider?.setMode("edit_file");
  const before = (await providerCalls()).length;

  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  const field = page.getByRole("textbox", { name: "Message" });
  await expect(field).toBeVisible();

  // The agent chip's panel lists the harnesses this deployment offers; the test fixtures enable two.
  const chip = page.getByTestId("agent-chip");
  await expect(chip).toBeVisible();
  await chip.click();
  const panel = page.getByTestId("agent-panel");
  const codex = panel.getByTestId("harness-row-codex");
  await codex.click();
  await expect(codex).toHaveAttribute("aria-pressed", "true");

  // Codex runs OpenAI's models only, so choosing it moved the model to one it
  // can run. The panel still lists every model; picking GPT-6 Sol keeps Codex.
  await expect(chip).toHaveAccessibleName(/^Model: GPT-6 /);
  await panel.getByRole("button", { name: /GPT-6 Sol/ }).click();
  // Picking a model closes the panel; reopened, Codex is still the harness.
  await expect(panel).toBeHidden();
  await chip.click();
  await expect(codex).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await field.fill(`Write ${EDIT_FILE_PATH}.`);
  await page.getByLabel("Send message").click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });

  // Codex itself answered the runtime host's handshake and named its version.
  await expect(page.getByText(/codex \S+ is ready/)).toBeAttached({ timeout: 120_000 });
  // The model's answer after its tool call, streamed through Codex.
  await expect(
    page.getByTestId("row-message-assistant").filter({ hasText: "chunk-0 chunk-1 chunk-2" }),
  ).toBeVisible({ timeout: 120_000 });
  // The change the model's shell call made, measured by the bridge's own Git.
  const card = page.getByTestId("row-changes").first();
  await expect(card).toContainText("Edited 1 file", { timeout: 120_000 });
  await expect(card.getByTestId("change-card-file")).toContainText(EDIT_FILE_PATH);
  // The run ended verified: the bridge ran the seeded repository's checks and
  // the object accepted the outcome against their records.
  const outcome = page.locator("[data-testid='row-run'][data-outcome]").first();
  await expect(outcome).toHaveAttribute("data-outcome", "verified", { timeout: 120_000 });

  // Every model request went through the relay and the broker to the
  // Responses API, at the run's effort.
  const calls = (await providerCalls()).slice(before);
  const responses = calls.filter((call) => call.path === "/v1/responses");
  expect(responses.length).toBeGreaterThanOrEqual(2);
  expect(calls.some((call) => call.path === "/v1/messages")).toBe(false);
  expect(new Set(responses.map((call) => call.effort))).toEqual(new Set(["medium"]));
});
