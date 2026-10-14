import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { slotPorts } from "../../../scripts/dev-ports.mjs";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { SLOW_REPLY_MARKER } from "../worker/test/provider-double";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { devVars, laneIdentity } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { expectRuntimeReady } from "./runtime-ready";
import {
  COLD_BUILD_MS,
  type RunningControllerDouble,
  startControllerDouble,
} from "./sandbox-controller-double";
import { openModalPanel } from "./session-details";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * Modal's timing, end to end against the real Worker, session object, bridge,
 * and OpenCode: a workspace whose image is still building, and a create whose
 * answer comes after the Worker stopped waiting. Both used to fail the
 * session while the sandbox kept running; now the first waits for the build
 * and the second adopts the sandbox the create started.
 *
 * The controller double imitates only Modal's timing (`cold_image`,
 * `slow_create`). Runs in its own project because its modes are the double's
 * one shared setting.
 */

const CONTROLLER_ORIGIN = `http://127.0.0.1:${slotPorts().controller}`;

let ORIGIN = DEFAULT_APP_ORIGIN;
let controller: RunningControllerDouble | null = null;
/** The `pnpm dev` subject's seeded model connection, served by the provider double. */
let modelConnectionId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  // The `pnpm dev` subject with Modal and a model key connected, so the real
  // bridge starts OpenCode against the provider double.
  await queryD1Batch(
    await seedStatements({
      subject: DEV_SUBJECT,
      keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(DEV_SUBJECT, queryD1),
    }),
  );
  modelConnectionId = `mc_seed_${(await deriveWorkspaceId(DEV_SUBJECT)).slice(4, 12)}`;
  controller = await startControllerDouble({ controlPlaneOrigin: ORIGIN });
});

test.afterEach(async () => {
  await controller?.setMode("ok");
});

test.afterAll(async () => {
  await controller?.close();
});

interface RecordedCall {
  readonly method: string;
  readonly path: string;
}

async function controllerCalls(): Promise<RecordedCall[]> {
  const answer = await fetch(`${CONTROLLER_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedCall[] }).calls;
}

function count(calls: readonly RecordedCall[], path: string): number {
  return calls.filter((call) => call.path === path).length;
}

/** Starts a session through the API and opens it, returning its sandbox row. */
async function startSession(page: Page, context: BrowserContext, text: string) {
  const cookie = laneIdentity(ORIGIN, DEV_SUBJECT).cookie;
  const commandId = `lane_timing_${randomUUID()}`;
  const created = await fetch(`${ORIGIN}/api/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      commandId,
      instruction: { messageId: commandId, text, attachments: [] },
      modelConnectionId,
    }),
  });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  await context.addCookies([
    { name: "__session", value: cookie.replace("__session=", ""), url: ORIGIN },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/sessions/${sessionId}`);
  return page.getByTestId("row-sandbox").first();
}

test("a workspace still building the image starts its session once the build finishes", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await fetch(`${CONTROLLER_ORIGIN}/__reset`, { method: "POST" });
  await controller?.setMode("cold_image");
  const startedAt = Date.now();

  const row = await startSession(page, context, "Say hello.");

  await expectRuntimeReady(row);
  // The build outlasted the 20 seconds a create was once given.
  expect(Date.now() - startedAt).toBeGreaterThan(COLD_BUILD_MS - 2_000);
  await openModalPanel(page);
  const output = page.getByTestId("panel-modal-output");
  await expect(output).toContainText("Building the sandbox image in your Modal workspace");
  await expect(output).toContainText("prepareImage answered in");
  const calls = await controllerCalls();
  expect(count(calls, "/v1/prepareImage")).toBeGreaterThanOrEqual(2);
  expect(count(calls, "/v1/create")).toBe(1);
});

test("a create answered after the deadline adopts the sandbox it started, and starts no second", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await fetch(`${CONTROLLER_ORIGIN}/__reset`, { method: "POST" });
  await controller?.setMode("slow_create");

  // A slow reply keeps the run going past the create's deadline, so the
  // local stack's 45-second idle stop cannot end the sandbox first.
  const row = await startSession(page, context, `Say hello again ${SLOW_REPLY_MARKER}.`);

  // The sandbox started at once, so its bridge connects and the runtime is
  // ready while the create is still unanswered.
  await expectRuntimeReady(row);
  await openModalPanel(page);
  // The create's answer never comes in time; after its deadline the object
  // finds the sandbox by name and adopts it.
  await expect(page.getByTestId("panel-modal-output")).toContainText(
    "the sandbox was found running and adopted",
    { timeout: 120_000 },
  );
  const calls = await controllerCalls();
  expect(count(calls, "/v1/create")).toBe(1);
  expect(count(calls, "/v1/getStatus")).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("panel-modal-phase")).toContainText("Running");
});
