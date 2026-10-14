// Proves the bridge and the session object agree on wire shape: the bridge's
// own functions from `services/bridge/src/protocol.ts` build every frame and grade
// every reply, against the real object through `handleBridgeWebSocketUpgrade`.
// The bridge's own state machine is covered in `main.test.ts`.

import { env, runInDurableObject } from "cloudflare:test";
import {
  type BridgeIdentity,
  type BridgeIo,
  type BridgeLink,
  bridgeConfig,
  bridgeConnectHeaders,
  bridgeConnectUrl,
  heartbeatFrame,
  helloFrame,
  reviewHandshakeReply,
  runLink,
} from "@oncue/bridge";
import { describe, expect, it } from "vitest";
import type { SessionObject } from "../index";
import { seedBridgeCredential } from "../test/bridge-credential";
import { handleBridgeWebSocketUpgrade } from "./ws-bridge";

const TIME = "2026-09-08T00:00:00.000Z";

function stubFor(sessionId: string): DurableObjectStub<SessionObject> {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

// A session row at `generation`, and the bootstrap credential the object will
// accept for `credentialGeneration` (the same unless a test wants a superseded
// generation's real credential).
async function seedSession(
  sessionId: string,
  generation: number,
  credentialGeneration = generation,
): Promise<string> {
  // The index row every real session has before its object exists; the route
  // refuses an id it has never recorded.
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, 'ws_1', NULL, 'active', ?, ?)`,
  )
    .bind(sessionId, TIME, TIME)
    .run();
  const stub = stubFor(sessionId);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
       VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, ?, NULL, 1, ?, ?)`,
      sessionId,
      generation,
      TIME,
      TIME,
    );
  });
  return seedBridgeCredential(stub, credentialGeneration);
}

// Bounded by the clock rather than a turn count: under coverage the handshake
// can take more timer turns than a fixed count allows.
async function waitForMessages(messages: readonly string[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (messages.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the real bridge's wire protocol against the real session object", () => {
  it("negotiates the handshake with `main.ts`'s own frames, and stays open through a heartbeat", async () => {
    const sessionId = "sess_wire_handshake";
    const generation = 1;
    const bootstrapCredential = await seedSession(sessionId, generation);

    const identity: BridgeIdentity = { sessionId, generation, bootstrapCredential };
    const config = bridgeConfig(identity, "https://worker");
    const url = new URL(bridgeConnectUrl(config));

    const response = await handleBridgeWebSocketUpgrade(
      new Request(url, { headers: { ...bridgeConnectHeaders(config), Upgrade: "websocket" } }),
      env,
    );
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const messages: string[] = [];
    let closed = false;
    client.addEventListener("message", (event: MessageEvent) => {
      messages.push(String(event.data));
    });
    client.addEventListener("close", () => {
      closed = true;
    });
    client.accept();

    // The bridge's own hello, exactly as `runLink` sends it.
    client.send(JSON.stringify(helloFrame(config)));
    await waitForMessages(messages, 1);
    expect(messages).toHaveLength(1);

    // Graded by the bridge's own review function, so a drifted welcome frame
    // fails here rather than in a hand-written assertion.
    const review = reviewHandshakeReply(config, JSON.parse(messages[0] as string));
    expect(review).toEqual({ kind: "accepted" });

    // The bridge's own heartbeat. Nothing in its protocol waits for a reply
    // to it, so the only observable contract is that the connection survives.
    client.send(JSON.stringify(heartbeatFrame(config)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);
    expect(closed).toBe(false);
  });

  it("a stale generation's real credential is refused with a close `reviewHandshakeReply` itself would call 'stale_generation'", async () => {
    const sessionId = "sess_wire_stale";
    // The session moved on to generation 2; this bridge holds generation 1's
    // real credential.
    const bootstrapCredential = await seedSession(sessionId, 2, 1);

    const identity: BridgeIdentity = { sessionId, generation: 1, bootstrapCredential };
    const config = bridgeConfig(identity, "https://worker");
    const url = new URL(bridgeConnectUrl(config));

    const response = await handleBridgeWebSocketUpgrade(
      new Request(url, { headers: { ...bridgeConnectHeaders(config), Upgrade: "websocket" } }),
      env,
    );
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.addEventListener("close", (event: CloseEvent) => {
        resolve({ code: event.code, reason: event.reason });
      });
      client.accept();
    });
    const result = await closed;
    expect(result.reason).toContain("stale generation");
  });
});

// Drives `runLink`, the loop the bundle runs, over the real upgrade path and
// asserts `runtime.connected` lands in the object's event table. Only the
// WebSocket transport is a stand-in.
describe("the real bridge loop against the real session object", () => {
  function linkOver(client: WebSocket): BridgeLink {
    return {
      send: (text) => client.send(text),
      close: () => client.close(),
      onMessage: (listener) =>
        client.addEventListener("message", (event: MessageEvent) => listener(String(event.data))),
      onClose: (listener) => client.addEventListener("close", () => listener()),
    };
  }

  async function committedTypes(sessionId: string): Promise<string[]> {
    return runInDurableObject(stubFor(sessionId), (_instance, state) => [
      ...state.storage.sql.exec<{ event_type: string }>(
        "SELECT event_type FROM event ORDER BY session_sequence",
      ),
    ]).then((rows) => rows.map((row) => row.event_type));
  }

  it("runLink's own runtime.connected is admitted and committed, and no runtime.ready follows", async () => {
    const sessionId = "sess_wire_connected";
    const bootstrapCredential = await seedSession(sessionId, 1);
    const identity: BridgeIdentity = { sessionId, generation: 1, bootstrapCredential };
    const config = bridgeConfig(identity, "https://worker", { bridgeVersion: "test-build" });

    const response = await handleBridgeWebSocketUpgrade(
      new Request(new URL(bridgeConnectUrl(config)), {
        headers: { ...bridgeConnectHeaders(config), Upgrade: "websocket" },
      }),
      env,
    );
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const received: string[] = [];
    client.addEventListener("message", (event: MessageEvent) => {
      received.push(String(event.data));
    });
    client.accept();

    const io: BridgeIo = {
      connect: () => Promise.reject(new Error("runLink is handed its link directly")),
      startHeartbeat: () => () => undefined,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      newEventId: () => "evt_wire_connected_1",
      now: () => TIME,
    };
    const outcome = runLink(config, io, linkOver(client));

    // Wait for the welcome first, then give the connected frame a few turns
    // before reading: reading in a tight loop starves the socket, since the object
    // handles calls and frames one at a time.
    await waitForMessages(received, 1);
    let types: string[] = [];
    for (let round = 0; round < 40 && !types.includes("runtime.connected"); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      types = await committedTypes(sessionId);
    }
    expect(types).toEqual(["runtime.connected"]);
    expect(types).not.toContain("runtime.ready");

    const stored = await runInDurableObject(stubFor(sessionId), (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string; runtime_sequence: number }>(
        "SELECT envelope_json, runtime_sequence FROM event",
      ),
    ]);
    expect(stored[0]?.runtime_sequence).toBe(0);
    expect(JSON.parse(stored[0]?.envelope_json ?? "{}")).toMatchObject({
      sandboxGeneration: 1,
      // The bridge's own capabilities; the object changes model in a live
      // sandbox only for a bridge that names this one (record 15).
      payload: { bridgeVersion: "test-build", runtimeName: "none", capabilities: ["model_switch"] },
    });

    // The link is still open. Closing an in-process pair is the transport's job,
    // so the outcome is not awaited.
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    client.close();
  });
});
