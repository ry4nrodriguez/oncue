import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { testModelRecord } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import type { SessionObject } from "../index";
import type { CreateSessionBody } from "../session/session-object";
import { seedBridgeCredential } from "../test/bridge-credential";
import { extractBridgeRoute, handleBridgeWebSocketUpgrade } from "./ws-bridge";

const TIME = "2026-09-08T00:00:00.000Z";

function stubFor(sessionId: string): DurableObjectStub<SessionObject> {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

async function seedSessionIndex(sessionId: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, ?, NULL, 'creating', ?, ?)`,
  )
    .bind(sessionId, workspaceId, TIME, TIME)
    .run();
}

function createBody(
  sessionId: string,
  overrides: Partial<CreateSessionBody> = {},
): CreateSessionBody {
  return {
    sessionId,
    workspaceId: "ws_1",
    taskId: null,
    ownerUserId: "user_1",
    title: "Fix the failing test",
    commandId: "cmd_create_1",
    issuedAt: TIME,
    instruction: { messageId: "msg_1", text: "Fix the bug", attachments: [] },
    model: testModelRecord(),
    continuesRunId: null,
    mintedRunId: "run_1",
    scriptName: "seven-event",
    framePacingMs: null,
    taskBranch: null,
    baseCommitSha: null,
    repository: null,
    modalCredential: null,
    redactionSecrets: [],
    driverFailures: {},
    ...overrides,
  };
}

// Creates a session on the fake driver (generation 1), then replaces its
// random bootstrap hash with a known fixture's so this file can present the
// credential.
async function createdSession(sessionId: string): Promise<{
  stub: DurableObjectStub<SessionObject>;
  credential: string;
}> {
  await seedSessionIndex(sessionId, "ws_1");
  const stub = stubFor(sessionId);
  await runInDurableObject(stub, (instance) => instance.createSession(createBody(sessionId)));
  const credential = await seedBridgeCredential(stub, 1);
  return { stub, credential };
}

/** Whether a session's object has ever been woken: the cost a refusal at the route avoids. */
async function objectExists(sessionId: string): Promise<boolean> {
  const wanted = env.SESSION.idFromName(sessionId);
  return (await listDurableObjectIds(env.SESSION)).some((id) => id.equals(wanted));
}

/** The coded close the object answers a refused upgrade with; the route itself never answers a bare status for one. */
async function closeOf(response: Response): Promise<{ code: number; reason: string }> {
  expect(response.status).toBe(101);
  const client = response.webSocket;
  if (client === null || client === undefined) {
    throw new Error("expected a webSocket on the upgrade response");
  }
  return new Promise((resolve) => {
    client.addEventListener("close", (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason });
    });
    client.accept();
  });
}

describe("extractBridgeRoute", () => {
  it("parses a well-formed bridge path", () => {
    expect(extractBridgeRoute("/ws/bridge/sess_1/3")).toEqual({
      sessionId: "sess_1",
      generation: 3,
    });
  });

  it.each([
    ["a missing generation segment", "/ws/bridge/sess_1"],
    ["an empty session id", "/ws/bridge//3"],
    ["a non-numeric generation", "/ws/bridge/sess_1/abc"],
    ["a negative generation", "/ws/bridge/sess_1/-1"],
    ["a decimal generation", "/ws/bridge/sess_1/1.5"],
    ["an unrelated path", "/ws/sessions/sess_1/client"],
  ])("returns null for %s", (_name, pathname) => {
    expect(extractBridgeRoute(pathname)).toBeNull();
  });
});

describe("handleBridgeWebSocketUpgrade", () => {
  it("refuses a malformed path with 400", async () => {
    const response = await handleBridgeWebSocketUpgrade(
      new Request("https://worker/ws/bridge/sess_1/not-a-number", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it("refuses an id nobody created with the object's own 404, and wakes no object to say it", async () => {
    const sessionId = "sess_bridge_never_created";

    for (const headers of [
      { Upgrade: "websocket" },
      { Upgrade: "websocket", authorization: "Bearer anything-at-all" },
    ]) {
      const response = await handleBridgeWebSocketUpgrade(
        new Request(`https://worker/ws/bridge/${sessionId}/1`, { headers }),
        env,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("session not found");
    }
    expect(await objectExists(sessionId)).toBe(false);
  });

  it("still reaches a deleted session's object, which is what ends its bridge at once", async () => {
    const sessionId = "sess_bridge_deleted";
    // What a finished deletion leaves: a tombstoned object, a receipt, and no index row.
    await runInDurableObject(stubFor(sessionId), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO session_tombstone (id, deleted_at) VALUES (1, ?)",
        TIME,
      );
    });
    await env.DB.prepare(
      `INSERT INTO deletion_request
         (id, session_id, workspace_id, requested_by_user_id, requested_at, completed_at, outcome)
       VALUES ('del_bridge_deleted', ?, 'ws_1', 'user_1', ?, ?, 'deleted')`,
    )
      .bind(sessionId, TIME, TIME)
      .run();

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", authorization: "Bearer its-old-credential" },
      }),
      env,
    );

    // Not a bare 404, which the bridge would retry for its whole outage window.
    expect(await closeOf(response)).toEqual({ code: 4401, reason: "unauthorized" });
  });

  // The route cannot check the credential; it must forward exactly what was
  // presented, so a missing bearer reaches the object as no header.
  it("forwards a missing credential as no header, and the object closes with 4401", async () => {
    const sessionId = "sess_bridge_no_cred";
    const { stub } = await createdSession(sessionId);

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(await closeOf(response)).toEqual({ code: 4401, reason: "unauthorized" });
    const bridgeCount = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets("bridge").length,
    );
    // The fake driver's own in-process bridge from `createdSession` is the
    // only one there is: the refused socket was never accepted as a bridge.
    expect(bridgeCount).toBe(1);
  });

  it("forwards a wrong credential, and the object closes with 4401", async () => {
    const sessionId = "sess_bridge_wrong_cred";
    await createdSession(sessionId);

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", authorization: "Bearer not-the-right-credential" },
      }),
      env,
    );

    expect(await closeOf(response)).toEqual({ code: 4401, reason: "unauthorized" });
  });

  it("a credential minted for a different generation is refused, even though it is well-formed", async () => {
    const sessionId = "sess_bridge_wrong_gen_cred";
    const { stub } = await createdSession(sessionId);
    // Valid for generation 2, presented on generation 1's path: the hash on
    // record for generation 1 is a different credential's.
    const other = await seedBridgeCredential(stub, 2, "a-credential-for-generation-two");

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", authorization: `Bearer ${other}` },
      }),
      env,
    );

    expect(await closeOf(response)).toEqual({ code: 4401, reason: "unauthorized" });
  });

  it("forwards a correct credential to the object, which accepts a socket tagged with the generation", async () => {
    const sessionId = "sess_bridge_forwarded";
    const { stub, credential } = await createdSession(sessionId);

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", authorization: `Bearer ${credential}` },
      }),
      env,
    );

    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    client.accept();

    const tags = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("bridge");
      // Index 1: index 0 is the fake driver's own in-process socket from
      // `createdSession`; this upgrade opened a second, real one.
      const ws = sockets[1];
      if (ws === undefined) throw new Error("no forwarded bridge socket");
      return state.getTags(ws);
    });
    expect(tags).toEqual(expect.arrayContaining(["bridge", "gen:1"]));
  });

  it("an authorization header without the Bearer prefix is forwarded as no credential", async () => {
    const sessionId = "sess_bridge_bad_prefix";
    const { credential } = await createdSession(sessionId);

    const response = await handleBridgeWebSocketUpgrade(
      new Request(`https://worker/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", authorization: `Basic ${credential}` },
      }),
      env,
    );

    expect(await closeOf(response)).toEqual({ code: 4401, reason: "unauthorized" });
  });
});
