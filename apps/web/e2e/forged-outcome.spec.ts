import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { deriveSessionId } from "../worker/routes/create-session-request";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { laneIdentity, laneNoModelConnectionStatement } from "./lane-auth";
import { laneModalConnectionStatements } from "./lane-modal";
import { queryD1 } from "./local-d1";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { pinSessionDetails } from "./session-details";

/**
 * A sandbox forges `run.verified` with no records, and the object refuses it.
 * The controller double starts `forged-bridge.ts` in place of the bridge bundle
 * for this one session, over the real bridge route; the Worker and the object
 * are not stood in for.
 *
 * Runs in its own project after the walkthrough, because both serve the
 * controller double's fixed port.
 */

// In /tmp like the walkthrough's, so a run never dirties the checkout.
const SCREENSHOT = "/tmp/forged-lane/pr11-forged.png";

let ORIGIN = DEFAULT_APP_ORIGIN;
let controller: RunningControllerDouble | null = null;

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  // A fresh database has no Modal connection, and session creation refuses a
  // workspace without one. The session names no model connection, which only
  // a workspace with no active one allows.
  await queryD1([...(await laneModalConnectionStatements()), laneNoModelConnectionStatement()]);
  controller = await startControllerDouble({ controlPlaneOrigin: ORIGIN });
});

test.afterAll(async () => {
  await controller?.close();
});

test("a forged run.verified with no records is refused and never shown as verified", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const cookie = laneIdentity(ORIGIN).cookie;
  const me = (await (await fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).json()) as {
    workspaceId: string;
  };
  const commandId = `lane_forged_${randomUUID()}`;
  // The session id is derived from the workspace and the command, so the
  // double can be told which session to forge before the Worker asks it for
  // a sandbox.
  const sessionId = await deriveSessionId(me.workspaceId, commandId);
  await controller?.forgeBridge(sessionId);

  const created = await fetch(`${ORIGIN}/api/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      commandId,
      instruction: { messageId: commandId, text: "Say hello and run the checks.", attachments: [] },
    }),
  });
  expect(created.status).toBe(201);
  expect(((await created.json()) as { sessionId: string }).sessionId).toBe(sessionId);

  await context.addCookies([
    { name: "__session", value: cookie.replace("__session=", ""), url: ORIGIN },
  ]);
  await page.goto(`${ORIGIN}/dev/home?at=/sessions/${sessionId}`);

  // The forged stream did reach the object: the run started and its message
  // streamed. Then its last frame, the bare `run.verified`, was refused and
  // the object committed the outcome the records support in its place.
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes).toHaveCount(1, { timeout: 60_000 });
  const outcome = outcomes.first();
  await expect(outcome).toHaveAttribute("data-outcome", "completed_with_warnings");
  await expect(outcome).toContainText("Completed with warnings");
  const warnings = outcome.getByTestId("outcome-warnings");
  await expect(warnings).toContainText(
    "The sandbox claimed the run was verified without finishing verification.",
  );
  await expect(warnings).toContainText(
    "No required check was recorded, so nothing proves the change works.",
  );
  await expect(page.getByTestId("row-message-assistant")).toHaveCount(1);

  // Nowhere on the screen does the run read as verified: no outcome row, no
  // rail line, no check.
  await expect(page.locator("[data-outcome='verified']")).toHaveCount(0);
  await pinSessionDetails(page);
  await expect(page.getByTestId("context-rail")).not.toContainText("Verified");
  await expect(page.getByTestId("row-check")).toHaveCount(0);

  mkdirSync(dirname(SCREENSHOT), { recursive: true });
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
});
