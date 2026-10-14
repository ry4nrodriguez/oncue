import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { DOUBLE_MODAL_PAIR, existingIdsFor, seedStatements } from "../scripts/seed-local";
import { deriveSessionId } from "../worker/routes/create-session-request";
import { SLOW_REPLY_CHUNKS, SLOW_REPLY_MARKER } from "../worker/test/provider-double";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { devVars } from "./lane-auth";
import { queryD1 } from "./local-d1";
import { startProviderDouble } from "./provider-double-server";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * A long session over a bad network (record 04, "Failure behavior"). The
 * controller double carries this session's bridge connection through a TCP
 * proxy it owns and cuts it, again and again, while the agent streams a slow
 * reply, then leaves one connection open but silent. The bridge, the Worker,
 * and the session object run unchanged on either side; only the network
 * fails. The session must keep its sandbox, reconnect every time, and commit
 * every timeline row.
 *
 * Runs in its own project because it serves the controller double's port and
 * seeds the `pnpm dev` subject.
 */

/** More than the eight attempts that once ended a bridge for the rest of its life. */
const DROPS = 10;

let ORIGIN = DEFAULT_APP_ORIGIN;
let controller: RunningControllerDouble | null = null;
const closers: Array<() => Promise<void>> = [];

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const provider = await startProviderDouble();
  closers.push(() => provider.close());
  controller = await startControllerDouble({ controlPlaneOrigin: ORIGIN });
  const started = controller;
  closers.push(() => started.close());
  // Through the dev server's own D1 (`local-d1.ts`), never a second process
  // opening the file it holds.
  await queryD1(
    await seedStatements({
      subject: DEV_SUBJECT,
      keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(DEV_SUBJECT, queryD1),
    }),
  );
});

test.afterAll(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

/** Every committed event of the session, as a fresh client socket's replay delivers it. */
async function committedEvents(
  page: Page,
  sessionId: string,
): Promise<{ type: string; sandboxGeneration: number; runtimeSequence: number | null }[]> {
  const frames = await page.evaluate(
    (id) =>
      new Promise<string[]>((resolve, reject) => {
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${scheme}//${window.location.host}/ws/sessions/${id}/client?after=0`,
        );
        const received: string[] = [];
        let quiet: ReturnType<typeof setTimeout> | null = null;
        // A live stream never goes quiet; the replay comes first, so a few
        // seconds hold all of it either way.
        setTimeout(() => {
          socket.close();
          resolve(received);
        }, 4_000);
        socket.onmessage = (event) => {
          received.push(String(event.data));
          if (quiet !== null) clearTimeout(quiet);
          quiet = setTimeout(() => {
            socket.close();
            resolve(received);
          }, 1_500);
        };
        socket.onerror = () => reject(new Error("the replay socket failed"));
      }),
    sessionId,
  );
  const events: { type: string; sandboxGeneration: number; runtimeSequence: number | null }[] = [];
  for (const frame of frames) {
    const parsed = JSON.parse(frame) as {
      type?: string;
      sessionSequence?: number;
      events?: unknown[];
    };
    // A replay batch or a single event, whichever the socket sent.
    const batch = Array.isArray(parsed.events) ? parsed.events : [parsed];
    for (const item of batch) {
      const event = item as {
        type?: unknown;
        sessionSequence?: unknown;
        sandboxGeneration?: unknown;
        runtimeSequence?: unknown;
      };
      if (typeof event.type === "string" && typeof event.sessionSequence === "number") {
        events.push({
          type: event.type,
          sandboxGeneration: Number(event.sandboxGeneration),
          runtimeSequence: typeof event.runtimeSequence === "number" ? event.runtimeSequence : null,
        });
      }
    }
  }
  return events;
}

test("a session keeps its sandbox through more than eight dropped links and a half-open one, with every timeline row", async ({
  page,
}) => {
  test.setTimeout(480_000);
  const double = controller as RunningControllerDouble;

  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const me = (await (await page.request.get(`${ORIGIN}/api/me`)).json()) as {
    workspaceId: string;
  };
  // The seeded Anthropic key, pointed at the provider double; a session
  // names its connection, since the server never picks one.
  const listed = (await (await page.request.get(`${ORIGIN}/api/model-connections`)).json()) as {
    connections: { connectionId: string; provider: string; status: string }[];
  };
  const connection = listed.connections.find(
    (row) => row.provider === "anthropic" && row.status === "active",
  );
  expect(connection, "the seed holds an active Anthropic connection").toBeDefined();
  const commandId = `lane_drops_${randomUUID()}`;
  // The session id is derived from the workspace and the command, so the
  // double can route its bridge through the proxy before the sandbox exists.
  const sessionId = await deriveSessionId(me.workspaceId, commandId);
  await double.flakyLink(sessionId);

  const created = await page.request.post(`${ORIGIN}/api/sessions`, {
    data: {
      commandId,
      modelConnectionId: connection?.connectionId,
      instruction: {
        messageId: commandId,
        // The provider double answers this slowly, so the drops land mid-stream.
        text: `Tell me a long story ${SLOW_REPLY_MARKER}`,
        attachments: [],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto(`${ORIGIN}/dev/home?at=/sessions/${sessionId}`);

  // The reply is streaming over the first link.
  await expect(page.getByText(/chunk-2 /).first()).toBeVisible({ timeout: 90_000 });
  expect((await double.links(sessionId)).open).toBe(1);

  const connections = async (): Promise<number> =>
    (await committedEvents(page, sessionId)).filter((event) => event.type === "runtime.connected")
      .length;
  for (let drop = 0; drop < DROPS; drop += 1) {
    const before = await connections();
    expect(await double.dropLinks(sessionId)).toBe(1);
    // Dropped only once the new link was welcomed and committed its
    // runtime.connected, so every drop cuts a working link.
    await expect.poll(connections, { timeout: 30_000 }).toBeGreaterThan(before);
    expect((await double.links(sessionId)).open).toBe(1);
  }

  // The whole reply, committed: nothing the bridge made while it had no link
  // is missing.
  const lastChunk = `chunk-${SLOW_REPLY_CHUNKS - 1}`;
  const assistant = page.getByTestId("row-message-assistant");
  await expect(assistant.filter({ hasText: lastChunk })).toHaveCount(1, { timeout: 120_000 });
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  await expect(outcomes).toHaveCount(1, { timeout: 60_000 });

  // A second slow run on the same sandbox. Partway through, its link stays
  // open and carries nothing. The bridge's pings were answered on it before,
  // so after two silent heartbeats it drops the link itself and dials again,
  // and what it sent into the dead link is replayed.
  const field = page.getByRole("textbox", { name: "Message" });
  await field.fill(`And one more ${SLOW_REPLY_MARKER}`);
  await page.getByLabel("Send message").click();
  // Streaming again: the second reply's text is on screen beside the first.
  await expect(page.getByText(/chunk-2 /)).toHaveCount(2, { timeout: 60_000 });
  // This link has been up since the last drop, long enough for its pings to
  // have been answered, and the run keeps the sandbox from going idle.
  const beforeStall = (await double.links(sessionId)).total;
  expect(await double.stallLinks(sessionId)).toBe(1);
  await expect
    .poll(async () => (await double.links(sessionId)).total, { timeout: 90_000 })
    .toBeGreaterThan(beforeStall);
  await expect(assistant.filter({ hasText: lastChunk })).toHaveCount(2, { timeout: 150_000 });
  await expect(outcomes).toHaveCount(2, { timeout: 60_000 });

  const links = await double.links(sessionId);
  // One sandbox the whole time, still running, and never unable to answer a replay.
  expect(links.bridges).toEqual([{ generation: 1, exitCode: null }]);
  expect(links.replayGaps).toBe(0);
  expect(links.total).toBeGreaterThanOrEqual(DROPS + 2);

  const events = await committedEvents(page, sessionId);
  const types = events.map((event) => event.type);
  expect(types.filter((type) => type === "runtime.connected").length).toBeGreaterThanOrEqual(
    DROPS + 2,
  );
  expect(types.filter((type) => type === "message.completed")).toHaveLength(2);
  expect(types.filter((type) => type === "run.completed")).toHaveLength(2);
  expect(types).not.toContain("sandbox.stopped");
  expect(new Set(events.map((event) => event.sandboxGeneration).filter(Boolean))).toEqual(
    new Set([1]),
  );
  // The sandbox's committed events are in strictly increasing runtime order:
  // the object admits only the next slot, so nothing was skipped past.
  const sequences = events
    .filter((event) => event.runtimeSequence !== null)
    .map((event) => event.runtimeSequence as number);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
});
