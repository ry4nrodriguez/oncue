import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveWorkspaceId } from "../worker/auth/register";
import { appOrigin } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { devGitHubSeed } from "./dev-github-world";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1, queryD1Batch } from "./local-d1";
import { type RunningDouble, startProviderDouble } from "./provider-double-server";
import { startControllerDouble } from "./sandbox-controller-double";
import { committedEvents, type StoredEvent, sessionIdOf } from "./session-events";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * A key the provider rejects, end to end on the real Worker, session object,
 * bridge, and OpenCode against the doubles (records 11 and 15): the run
 * pauses, the sandbox checkpoints and stops at once instead of waiting out
 * the idle period, Continue is refused while the key is still the rejected
 * one, and once the key is replaced the same run continues on a new sandbox.
 *
 * The lane reads committed events and sends its commands on a client socket
 * of its own, because what it proves is the object's behaviour. The screen's
 * wording for these states is covered where the screen is.
 * Runs in its own project because it switches the provider double's mode and
 * marks the dev workspace's model connection invalid for a while.
 */

/** Every session this test starts has a title beginning with this. */
const LANE_TITLE = "Rejected key,";

/** A real sandbox start and a real OpenCode, with room to spare. */
const RUN_ENDS_MS = 120_000;

/**
 * `pnpm dev` stops an idle sandbox after 45 seconds. A stop that began this
 * soon after the sandbox's last activity did not wait for that.
 */
const AT_ONCE_MS = 20_000;

const REFUSAL =
  "this run's model connection is not active; add a working key under Settings, Model providers and start a new session";

let closers: Array<() => Promise<void>> = [];
let provider: RunningDouble | null = null;
/** The connection the lane's run uses, so a failed test can still leave it active. */
let connectionId: string | null = null;

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
});

test.afterAll(async () => {
  await provider?.setMode("ok");
  if (connectionId !== null) {
    // Other lanes share the dev workspace's connection.
    await queryD1(
      `UPDATE model_connection SET status = 'active' WHERE connection_id = '${connectionId}'`,
    );
  }
  for (const close of closers) {
    await close();
  }
});

/**
 * Sends one command on a client socket of the lane's own, as the browser's
 * composer does, and returns the object's receipt for it: the
 * `command.acknowledged` or `command.rejected` event naming the command.
 */
async function sendCommand(
  page: Page,
  sessionId: string,
  command: Record<string, unknown>,
): Promise<{ readonly type: string; readonly payload: Record<string, unknown> }> {
  const after = (await committedEvents(page, sessionId)).at(-1)?.sessionSequence ?? 0;
  return page.evaluate(
    ({ id, after: from, body }) =>
      new Promise<{ type: string; payload: Record<string, unknown> }>((resolve, reject) => {
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${scheme}//${window.location.host}/ws/sessions/${id}/client?after=${from}`,
        );
        const giveUp = setTimeout(() => {
          socket.close();
          reject(new Error("no receipt for the command within 20 seconds"));
        }, 20_000);
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "command",
              command: { ...body, sessionId: id, issuedAt: new Date().toISOString() },
            }),
          );
        };
        socket.onmessage = (message) => {
          const parsed = JSON.parse(String(message.data)) as {
            events?: unknown[];
          } & Record<string, unknown>;
          for (const item of Array.isArray(parsed.events) ? parsed.events : [parsed]) {
            const event = item as { type?: string; payload?: { commandId?: string } };
            if (
              (event.type === "command.acknowledged" || event.type === "command.rejected") &&
              event.payload?.commandId === body.commandId
            ) {
              clearTimeout(giveUp);
              socket.close();
              resolve({ type: event.type, payload: event.payload as Record<string, unknown> });
            }
          }
        };
        socket.onerror = () => {
          clearTimeout(giveUp);
          reject(new Error("the command socket failed"));
        };
      }),
    { id: sessionId, after, body: command },
  );
}

function continueCommand(runId: string, text: string): Record<string, unknown> {
  return {
    commandId: crypto.randomUUID(),
    runId,
    expected: { scope: "run", state: "paused" },
    type: "run.follow_up",
    payload: {
      messageId: crypto.randomUUID(),
      text,
      attachments: [],
      delivery: "steer_current_run",
    },
  };
}

async function eventsUntil(
  page: Page,
  sessionId: string,
  done: (events: readonly StoredEvent[]) => boolean,
  what: string,
  timeoutMs: number,
): Promise<StoredEvent[]> {
  let events: StoredEvent[] = [];
  await expect
    .poll(
      async () => {
        events = await committedEvents(page, sessionId);
        return done(events);
      },
      { timeout: timeoutMs, message: what, intervals: [1_000] },
    )
    .toBe(true);
  return events;
}

test("a rejected key stops the sandbox at once, and the run continues on a new one after the key is replaced", async ({
  page,
}) => {
  test.setTimeout(6 * RUN_ENDS_MS);
  const stamp = Date.now().toString(36);

  await page.goto(`/dev/sign-in?as=${DEV_SUBJECT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(`${LANE_TITLE} first ${stamp}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  const sessionId = sessionIdOf(page);
  // The first run ends on a working key, so the sandbox is up and has work in it.
  await expect(page.locator("[data-testid='row-run'][data-outcome]")).toHaveCount(1, {
    timeout: RUN_ENDS_MS,
  });

  let pausedRunId = "";
  let stoppedAt = 0;

  await test.step("the provider rejects the key: the run pauses and the sandbox checkpoints and stops at once", async () => {
    await provider?.setMode("auth_failed");
    await composer.fill(`${LANE_TITLE} this one is refused ${stamp}`);
    await page.getByRole("button", { name: "Send message" }).click();

    const events = await eventsUntil(
      page,
      sessionId,
      (all) => all.some((event) => event.type === "sandbox.stopped"),
      "the sandbox to stop",
      RUN_ENDS_MS,
    );
    const pause = events.find((event) => event.type === "run.paused");
    expect(pause?.payload).toMatchObject({
      reason: "model_failure",
      modelFailure: { category: "authentication_failed", retries: 0 },
    });
    pausedRunId = pause?.runId ?? "";
    expect(pausedRunId).not.toBe("");

    const after = events.filter(
      (event) => event.sessionSequence > (pause as StoredEvent).sessionSequence,
    );
    const first = (type: string): StoredEvent => {
      const found = after.find((event) => event.type === type);
      if (found === undefined) {
        throw new Error(`no ${type} after the pause`);
      }
      return found;
    };
    const idle = first("sandbox.idle");
    const checkpointed = first("sandbox.checkpointed");
    const revoked = first("sandbox.credentials_revoked");
    const stopped = first("sandbox.stopped");
    expect(idle.sessionSequence).toBeLessThan(checkpointed.sessionSequence);
    expect(checkpointed.sessionSequence).toBeLessThan(revoked.sessionSequence);
    expect(revoked.sessionSequence).toBeLessThan(stopped.sessionSequence);

    // At once: the stop began seconds after the last activity, not the idle
    // period after it.
    const idleFacts = idle.payload as { idleSince: string; stopAt: string };
    expect(Date.parse(idleFacts.stopAt) - Date.parse(idleFacts.idleSince)).toBeLessThan(AT_ONCE_MS);
    expect(checkpointed.payload).toMatchObject({ reason: "idle" });
    expect(stopped.payload).toMatchObject({
      outcome: "stopped",
      reason: "idle",
      checkpointId: checkpointed.payload.checkpointId,
      unsavedWorkWarning: null,
    });
    stoppedAt = stopped.sessionSequence;
    // The run is paused, not ended: nothing cancelled or failed it.
    const ends = new Set(["run.cancelled", "run.failed", "run.interrupted"]);
    expect(after.filter((event) => event.runId === pausedRunId && ends.has(event.type))).toEqual(
      [],
    );

    const queued = events.find(
      (event) => event.type === "run.queued" && event.runId === pausedRunId,
    );
    const model = queued?.payload.model as { modelConnectionId: string } | undefined;
    connectionId = model?.modelConnectionId ?? null;
    expect(connectionId).not.toBeNull();
    // The broker's own record of the rejection, which the next step's refusal reads.
    const rows = await queryD1<{ status: string }>(
      `SELECT status FROM model_connection WHERE connection_id = '${connectionId}'`,
    );
    expect(rows).toEqual([{ status: "invalid" }]);
  });

  await test.step("Continue is refused while the key is still the rejected one, and starts no sandbox", async () => {
    const receipt = await sendCommand(
      page,
      sessionId,
      continueCommand(pausedRunId, `${LANE_TITLE} too early ${stamp}`),
    );
    expect(receipt.type).toBe("command.rejected");
    expect(receipt.payload).toMatchObject({ reason: "wrong_state", detail: REFUSAL });
    const events = await committedEvents(page, sessionId);
    expect(
      events.filter(
        (event) => event.sessionSequence > stoppedAt && event.type === "sandbox.provisioning",
      ),
    ).toEqual([]);
  });

  await test.step("replacing the key keeps the connection and makes it active again", async () => {
    await provider?.setMode("ok");
    const response = await page.request.put(`/api/model-connections/${connectionId}`, {
      data: { credential: "sk-ant-lane-replaced" },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      connection: { connectionId, status: "active" },
    });
  });

  await test.step("Continue now resumes the paused run on a new sandbox, from the checkpoint", async () => {
    const receipt = await sendCommand(
      page,
      sessionId,
      continueCommand(pausedRunId, `${LANE_TITLE} carry on ${stamp}`),
    );
    expect(receipt.type).toBe("command.acknowledged");

    const outcomes = new Set(["run.verified", "run.completed_with_warnings", "run.completed"]);
    const events = await eventsUntil(
      page,
      sessionId,
      (all) =>
        all.some(
          (event) =>
            event.sessionSequence > stoppedAt &&
            event.runId === pausedRunId &&
            outcomes.has(event.type),
        ),
      "the resumed run to end",
      2 * RUN_ENDS_MS,
    );
    const later = events.filter((event) => event.sessionSequence > stoppedAt);
    const provisioning = later.filter((event) => event.type === "sandbox.provisioning");
    expect(provisioning.map((event) => event.payload)).toEqual([
      expect.objectContaining({ reason: "resume" }),
    ]);
    // The same run, started again on the new sandbox: no second run was queued.
    expect(later.filter((event) => event.type === "run.queued")).toEqual([]);
    const started = later.find((event) => event.type === "run.started");
    expect(started?.runId).toBe(pausedRunId);
    expect(later.filter((event) => event.type === "run.paused")).toEqual([]);
  });
});
