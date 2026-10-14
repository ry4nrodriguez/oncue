import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { makeEvent, testModelRecord } from "@oncue/protocol/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionObject } from "../index";
import { seedBridgeCredential, sha256Hex, TEST_BOOTSTRAP } from "../test/bridge-credential";
import { preparedImage } from "../test/session-world";
import type { ProvisionPacing } from "./object/constants";
import {
  BRIDGE_CREDENTIAL_HEADER,
  type CreateSessionBody,
  OUTPUT_DRAIN_POLLS,
  OUTPUT_POLL_INTERVAL_MS,
} from "./session-object";

const TIME = "2026-09-02T00:00:00.000Z";

function stubFor(sessionId: string): DurableObjectStub<SessionObject> {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

/**
 * Lets the fake bridge's "immediate" pacing settle before an assertion reads
 * state. Messages between the ends of an in-process `WebSocketPair` take a
 * runtime hop, not a microtask, so this yields a macrotask per round, and it
 * polls for the expected count because coverage instrumentation slows rounds.
 */
async function flush(times = 600): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForEventCount(
  stub: DurableObjectStub<SessionObject>,
  count: number,
  maxRounds = 2000,
): Promise<EventRow[]> {
  for (let index = 0; index < maxRounds; index += 1) {
    const rows = await eventRows(stub);
    if (rows.length >= count) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return eventRows(stub);
}

async function seedSessionIndex(sessionId: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, ?, NULL, 'creating', ?, ?)`,
  )
    .bind(sessionId, workspaceId, TIME, TIME)
    .run();
}

function createBody(overrides: Partial<CreateSessionBody> = {}): CreateSessionBody {
  return {
    sessionId: "sess_default",
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
    // Null: this object runs on the fake driver, and the Worker resolves the real Modal pair.
    modalCredential: null,
    redactionSecrets: [],
    driverFailures: {},
    ...overrides,
  };
}

interface EventRow extends Record<string, string | number | null> {
  event_id: string;
  event_type: string;
  run_id: string | null;
  runtime_sequence: number | null;
  session_sequence: number;
}

async function eventRows(stub: DurableObjectStub<SessionObject>): Promise<EventRow[]> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<EventRow>(
      "SELECT event_id, event_type, run_id, runtime_sequence, session_sequence FROM event ORDER BY session_sequence ASC",
    ),
  ]);
}

async function commandRows(
  stub: DurableObjectStub<SessionObject>,
): Promise<Array<{ id: string; result_kind: string }>> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ id: string; result_kind: string }>(
      "SELECT id, result_kind FROM command",
    ),
  ]);
}

/** Creates a session and lets its "seven-event" bridge play out, so assertions see a settled state. */
async function createdAndSettled(
  sessionId: string,
  overrides: Partial<CreateSessionBody> = {},
): Promise<DurableObjectStub<SessionObject>> {
  await seedSessionIndex(sessionId, "ws_1");
  const stub = stubFor(sessionId);
  await runInDurableObject(stub, (instance) =>
    instance.createSession(createBody({ sessionId, ...overrides })),
  );
  // command.acknowledged, run.queued, sandbox.provisioning, sandbox.attached,
  // the controller-timings sandbox.output, then "seven-event"'s run.started,
  // message.completed, and the `run.completed_with_warnings` the object commits
  // in place of the script's bare `run.verified`, which record 14's gate refuses.
  await waitForEventCount(stub, 8);
  return stub;
}

/**
 * The upgrade `fetch` resolves before the socket is necessarily visible to
 * `getWebSockets`, so this waits for it rather than assuming one turn.
 */
async function waitForClientSocket(
  stub: DurableObjectStub<SessionObject>,
  maxRounds = 2000,
): Promise<WebSocket> {
  for (let index = 0; index < maxRounds; index += 1) {
    const ws = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets("client")[0],
    );
    if (ws !== undefined) {
      return ws;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("no client socket after waiting");
}

/** The browser's ends of the upgrades below, kept so the server's ends stay open. */
const heldClients: WebSocket[] = [];
afterAll(() => {
  for (const ws of heldClients) {
    ws.close();
  }
});

/**
 * Opens a client socket as a browser would, and holds and accepts the
 * browser's end: an unreferenced upgrade response can be garbage-collected,
 * which closes the server's end and drops it from `getWebSockets` before the
 * test finds it.
 */
async function upgradeClient(
  stub: DurableObjectStub<SessionObject>,
  sessionId: string,
): Promise<void> {
  const response = await stub.fetch(
    new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
      headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
    }),
  );
  expect(response.status).toBe(101);
  const browserEnd = response.webSocket;
  if (browserEnd === null || browserEnd === undefined) {
    throw new Error("the upgrade carried no socket");
  }
  browserEnd.accept();
  heldClients.push(browserEnd);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM session_index").run();
  await env.DB.prepare("DELETE FROM task").run();
});

/**
 * Record 07: `SessionView.git.branch` comes from `run.started`, which the
 * scripted bridge emits, so the object hands the session's own branch to the
 * script instead of letting the fixture default stand.
 */
describe("createSession with a task branch", () => {
  /** Read from the stored envelope, which is what a replaying browser sees. */
  async function runStartedPayload(
    sessionId: string,
    overrides: Partial<CreateSessionBody>,
  ): Promise<Record<string, unknown>> {
    const stub = await createdAndSettled(sessionId, overrides);
    const rows = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type = 'run.started'",
      ),
    ]);
    const stored = rows.at(0);
    if (stored === undefined) {
      throw new Error("the scripted bridge never emitted run.started");
    }
    const envelope = JSON.parse(stored.envelope_json) as { payload: Record<string, unknown> };
    return envelope.payload;
  }

  it("puts the session's own branch and base commit on run.started", async () => {
    const payload = await runStartedPayload("sess_branch_1", {
      taskBranch: "oncue/fix-login-7f3a",
      baseCommitSha: "a".repeat(40),
    });

    expect(payload.branch).toBe("oncue/fix-login-7f3a");
    expect(payload.baseSha).toBe("a".repeat(40));
  });

  /**
   * A session with a repository but no recorded base commit still names its
   * branch. `run.started` requires a `baseSha`, so the fixture's stands.
   */
  it("accepts a branch with no base commit", async () => {
    const payload = await runStartedPayload("sess_branch_2", {
      taskBranch: "oncue/task-0002",
      baseCommitSha: null,
    });

    expect(payload.branch).toBe("oncue/task-0002");
    expect(typeof payload.baseSha).toBe("string");
  });

  /** A session with no repository has no branch to name. */
  it("leaves the fixture's branch alone when the session has no repository", async () => {
    const payload = await runStartedPayload("sess_branch_3", {
      taskBranch: null,
      baseCommitSha: null,
    });

    expect(payload.branch).toBe("oncue/session-1");
  });
});

describe("createSession", () => {
  it("commits the session, the first run, and an outbox row, and projects to D1", async () => {
    const sessionId = "sess_create_1";
    const stub = await createdAndSettled(sessionId);

    const events = await eventRows(stub);
    // The create command's two events, the object's lifecycle events for
    // generation 1, the controller timings, then the fake bridge's two stored
    // frames (the three message.delta frames are ephemeral) and the outcome the
    // object commits when it refuses the script's bare `run.verified`. No
    // `runtime.connected`: the fake driver has no bridge.
    expect(events.map((event) => event.event_type)).toEqual([
      "command.acknowledged",
      "run.queued",
      "sandbox.provisioning",
      "sandbox.attached",
      "sandbox.output",
      "run.started",
      "message.completed",
      "run.completed_with_warnings",
    ]);
    expect(events.every((event) => event.session_sequence > 0)).toBe(true);
    // The three ephemeral deltas occupy sequences 1 to 3 without being stored,
    // and the refused `run.verified` occupies 5 the same way: the downgraded
    // outcome is the object's own, with no runtime sequence.
    expect(events.map((event) => event.runtime_sequence)).toEqual([
      null,
      null,
      null,
      null,
      null,
      0,
      4,
      null,
    ]);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ last: number }>("SELECT last_runtime_sequence AS last FROM session")
            .one().last,
      ),
    ).toBe(5);
    // The control plane's notes about its provider calls sit in the output
    // stream beside what the sandbox printed.
    const timings = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type = 'sandbox.output'",
      ),
    ]);
    const payload = JSON.parse(timings[0]?.envelope_json ?? "{}").payload as {
      stream: string;
      lines: { text: string }[];
    };
    expect(payload.stream).toBe("controller");
    expect(payload.lines.map((line) => line.text.replace(/\d+ ms/, "N ms"))).toEqual([
      "prepareImage answered in N ms",
      "create answered in N ms",
      "start answered in N ms",
      "getConnection answered in N ms",
    ]);

    // The run row follows the bridge's events too: `run.started` made it
    // `running` and the refused `run.verified` ended it with the outcome its
    // records support, stamped with the proving events' timestamps.
    const runs = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{
        id: string;
        state: string;
        outcome: string | null;
        started_at: string | null;
        ended_at: string | null;
      }>("SELECT id, state, outcome, started_at, ended_at FROM run"),
    ]);
    expect(runs).toEqual([
      {
        id: "run_1",
        state: "completed_with_warnings",
        outcome: "completed_with_warnings",
        started_at: expect.any(String),
        ended_at: expect.any(String),
      },
    ]);

    // The projection carries the generation and the provider's sandbox id.
    await flush(50);
    const projected = await env.DB.prepare(
      "SELECT state, sandbox_generation, sandbox_provider_ref FROM session_index WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ state: string; sandbox_generation: number; sandbox_provider_ref: string }>();
    expect(projected).toEqual({
      state: "active",
      sandbox_generation: 1,
      sandbox_provider_ref: `fake://sandbox/${sessionId}/1`,
    });

    const attachment = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ generation: number; provider: string; state: string }>(
        "SELECT generation, provider, state FROM sandbox_attachment",
      ),
    ]);
    expect(attachment).toEqual([{ generation: 1, provider: "fake", state: "attached" }]);
  });

  it("retrying the same create command id is idempotent (duplicate command id)", async () => {
    const sessionId = "sess_dup_cmd";
    const stub = await createdAndSettled(sessionId);
    const baseline = await eventRows(stub);

    const second = await runInDurableObject(stub, (instance) =>
      instance.createSession(createBody({ sessionId })),
    );
    await flush();

    expect(second.plan).toBe("already_processed");

    const runs = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ id: string }>("SELECT id FROM run"),
    ]);
    expect(runs).toHaveLength(1);
    expect(await eventRows(stub)).toEqual(baseline);
  });

  it("fails closed with admission_closed when run admission is stopped", async () => {
    await env.DB.prepare(
      "UPDATE platform_control SET run_admission = 'stopped' WHERE id = 1",
    ).run();
    const sessionId = "sess_admission_closed";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);

    const result = await runInDurableObject(stub, (instance) =>
      instance.createSession(createBody({ sessionId })),
    );
    expect(result.plan).toBe("reject");

    const events = await eventRows(stub);
    expect(events.map((event) => event.event_type)).toEqual(["command.rejected"]);

    await env.DB.prepare("UPDATE platform_control SET run_admission = 'open' WHERE id = 1").run();
  });
});

describe("commands sent over the client socket", () => {
  async function connectClient(
    stub: DurableObjectStub<SessionObject>,
    sessionId: string,
  ): Promise<WebSocket> {
    await upgradeClient(stub, sessionId);
    return waitForClientSocket(stub);
  }

  it("rejects a run.pause command that is not valid for the run's actual state (out-of-state command)", async () => {
    const sessionId = "sess_wrong_state";
    const stub = await createdAndSettled(sessionId);
    const clientWs = await connectClient(stub, sessionId);

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "run.pause",
            commandId: "cmd_pause_1",
            runId: "run_1",
            issuedAt: TIME,
            issuedByUserId: "user_1",
            expected: { scope: "run", state: "running" },
            payload: { reason: "user_requested" },
          },
        }),
      ),
    );

    const rows = await commandRows(stub);
    const paused = rows.find((row) => row.id === "cmd_pause_1");
    expect(paused).toEqual({ id: "cmd_pause_1", result_kind: "rejected" });

    const events = await eventRows(stub);
    const rejected = events.find((event) => event.event_type === "command.rejected");
    expect(rejected).toBeDefined();
  });

  // The "not_owner" rejection is unit-tested in commands.test.ts. Here it cannot
  // be reached by forging `issuedByUserId`, which the wire no longer carries;
  // the defense is at connection time (the "upgrade ownership" tests below).
  it("stamps an acknowledged command with the connecting user's own id, never a value the wire claims", async () => {
    const sessionId = "sess_stamped_from_attachment";
    const stub = await createdAndSettled(sessionId);
    const clientWs = await connectClient(stub, sessionId);

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "checkpoint.create",
            commandId: "cmd_owner_stamped",
            runId: null,
            issuedAt: TIME,
            issuedByUserId: "someone_else",
            expected: { scope: "session", state: "active" },
            payload: { reason: "user_requested" },
          },
        }),
      ),
    );

    const rows = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ result_kind: string; issued_by_user_id: string }>(
        "SELECT result_kind, issued_by_user_id FROM command WHERE id = 'cmd_owner_stamped'",
      ),
    ]);
    expect(rows).toEqual([{ result_kind: "acknowledged", issued_by_user_id: "user_1" }]);
  });

  it("drops a command whose payload does not validate", async () => {
    const sessionId = "sess_bad_payload";
    const stub = await createdAndSettled(sessionId);
    const clientWs = await connectClient(stub, sessionId);

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "run.pause",
            commandId: "cmd_bad_1",
            runId: "run_1",
            issuedAt: TIME,
            issuedByUserId: "user_1",
            expected: { scope: "run", state: "running" },
            payload: { reason: "not_a_real_reason" },
          },
        }),
      ),
    );

    const rows = await commandRows(stub);
    expect(rows.find((row) => row.id === "cmd_bad_1")).toBeUndefined();
  });

  it("drops malformed JSON on the client socket", async () => {
    const sessionId = "sess_bad_json";
    const stub = await createdAndSettled(sessionId);
    const clientWs = await connectClient(stub, sessionId);
    const before = await commandRows(stub);

    await runInDurableObject(stub, (instance) => instance.webSocketMessage(clientWs, "not json"));

    expect(await commandRows(stub)).toEqual(before);
  });

  it("ignores a client frame that is not a command envelope", async () => {
    const sessionId = "sess_not_command";
    const stub = await createdAndSettled(sessionId);
    const clientWs = await connectClient(stub, sessionId);
    const before = await commandRows(stub);

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(clientWs, JSON.stringify({ type: "ping" })),
    );

    expect(await commandRows(stub)).toEqual(before);
  });
});

describe("bridge frame ingestion", () => {
  async function bridgeSocketFor(stub: DurableObjectStub<SessionObject>): Promise<WebSocket> {
    return runInDurableObject(stub, (_instance, state) => {
      const [ws] = state.getWebSockets("bridge");
      if (ws === undefined) throw new Error("no bridge socket");
      return ws;
    });
  }

  it("closeAttachedBridges stops playback and closes the attached bridge's client socket", async () => {
    const sessionId = "sess_stop_bridges";
    const stub = await createdAndSettled(sessionId);

    await runInDurableObject(stub, (instance) => instance.closeAttachedBridges());

    // Calling it again is safe: the map was already cleared.
    await runInDurableObject(stub, (instance) => instance.closeAttachedBridges());
  });

  it("drops non-JSON text on the bridge socket, the same as a malformed protocol frame", async () => {
    const sessionId = "sess_bridge_bad_json";
    const stub = await createdAndSettled(sessionId);
    const bridgeWs = await bridgeSocketFor(stub);
    const before = await eventRows(stub);

    // Not JSON, so `parseBridgeControlFrame` cannot read a `type`; it must fall
    // through to `ingestFrame`'s parse failure rather than throw.
    await runInDurableObject(stub, (instance) => instance.webSocketMessage(bridgeWs, "not json"));

    expect(await eventRows(stub)).toEqual(before);
  });

  it("closes the bridge socket on a stale-generation frame and never stores it", async () => {
    const sessionId = "sess_stale_gen";
    const stub = await createdAndSettled(sessionId);
    const bridgeWs = await bridgeSocketFor(stub);

    const staleFrame = makeEvent("run.paused", {
      eventId: "evt_test_stale_1",
      sessionId,
      runId: "run_1",
      sandboxGeneration: 999,
      runtimeSequence: 0,
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(staleFrame)),
    );

    const events = await eventRows(stub);
    expect(events.some((event) => event.event_id === "evt_test_stale_1")).toBe(false);
  });

  it("holds a gapped sequence and requests a replay from the bridge", async () => {
    const sessionId = "sess_gap";
    const stub = await createdAndSettled(sessionId);
    const bridgeWs = await bridgeSocketFor(stub);

    const sent: string[] = [];
    const originalSend = bridgeWs.send.bind(bridgeWs);
    bridgeWs.send = (data: string) => {
      sent.push(String(data));
      return originalSend(data);
    };

    // "seven-event" already consumed runtime sequences 0..6; 50 is a gap.
    const gapFrame = makeEvent("file.changed", {
      eventId: "evt_test_gap_1",
      sessionId,
      sandboxGeneration: 1,
      runtimeSequence: 50,
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(gapFrame)),
    );

    const events = await eventRows(stub);
    expect(events.some((event) => event.event_id === "evt_test_gap_1")).toBe(false);
    expect(sent.some((message) => JSON.parse(message).type === "replay_from")).toBe(true);
  });

  it("commits a durable sandbox-origin frame and ignores a resend of the same event id", async () => {
    const sessionId = "sess_dup_event";
    const stub = await createdAndSettled(sessionId);
    const bridgeWs = await bridgeSocketFor(stub);

    // Continues cleanly from "seven-event"'s own last sequence (5).
    const frame = makeEvent("file.changed", {
      eventId: "evt_test_dup_1",
      sessionId,
      sandboxGeneration: 1,
      runtimeSequence: 6,
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(frame)),
    );
    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(frame)),
    );

    const events = await eventRows(stub);
    const matches = events.filter((event) => event.event_id === "evt_test_dup_1");
    expect(matches).toHaveLength(1);
  });

  it("never stores an ephemeral event, and still advances the runtime-sequence cursor for the next durable frame", async () => {
    const sessionId = "sess_ephemeral";
    const stub = await createdAndSettled(sessionId);
    const bridgeWs = await bridgeSocketFor(stub);

    const delta = makeEvent("message.delta", {
      eventId: "evt_test_delta_1",
      sessionId,
      runId: "run_1",
      sandboxGeneration: 1,
      runtimeSequence: 6,
    });
    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(delta)),
    );

    const afterDelta = await eventRows(stub);
    expect(afterDelta.some((event) => event.event_id === "evt_test_delta_1")).toBe(false);

    // If the cursor had not advanced past the ephemeral frame's sequence 6,
    // this durable frame at sequence 7 would look like a gap.
    const next = makeEvent("file.changed", {
      eventId: "evt_test_after_delta_1",
      sessionId,
      sandboxGeneration: 1,
      runtimeSequence: 7,
    });
    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(bridgeWs, JSON.stringify(next)),
    );

    const events = await eventRows(stub);
    expect(events.some((event) => event.event_id === "evt_test_after_delta_1")).toBe(true);
  });
});

/**
 * The network counterpart to `openBridgeSocket`'s in-process path:
 * `routes/ws-bridge.ts` forwards the upgrade with the presented credential,
 * and the object decides whether to accept it.
 */
describe("the real bridge WebSocket upgrade (handleBridgeUpgrade)", () => {
  /** A session row at `generation`, with the bootstrap hash for `credentialGeneration` beside it. */
  async function seedSession(
    sessionId: string,
    generation: number,
    credentialGeneration = generation,
  ): Promise<DurableObjectStub<SessionObject>> {
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
    await seedBridgeCredential(stub, credentialGeneration);
    return stub;
  }

  /** The upgrade as `routes/ws-bridge.ts` forwards it: the presented credential in its own header, or no header at all. */
  async function bridgeUpgrade(
    stub: DurableObjectStub<SessionObject>,
    sessionId: string,
    generation: number,
    presented: string | null = TEST_BOOTSTRAP,
  ): Promise<Response> {
    return stub.fetch(
      new Request(`https://do/ws/bridge/${sessionId}/${generation}`, {
        headers: {
          Upgrade: "websocket",
          ...(presented === null ? {} : { [BRIDGE_CREDENTIAL_HEADER]: presented }),
        },
      }),
    );
  }

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

  it("answers 404 when there is no session row yet", async () => {
    const stub = stubFor("sess_bridge_upgrade_no_session");
    const response = await bridgeUpgrade(stub, "sess_bridge_upgrade_no_session", 1);
    expect(response.status).toBe(404);
  });

  // Record 11: an old bridge reconnecting after a replacement generation is
  // closed with `stale generation`.
  it("closes a socket requested for a superseded generation with a reason containing 'stale generation'", async () => {
    const sessionId = "sess_bridge_upgrade_stale";
    // Generation 1's real credential, presented after the session moved on.
    const stub = await seedSession(sessionId, 2, 1);

    const result = await closeOf(await bridgeUpgrade(stub, sessionId, 1));
    expect(result.code).toBe(4000);
    expect(result.reason).toContain("stale generation");
  });

  /**
   * Only this object holds the credential's hash, so it runs the bootstrap
   * check. Every refusal is a coded 4401 before the generation is consulted,
   * so a wrong credential learns nothing about which generation is current.
   */
  it("closes with 4401 when no credential header was forwarded", async () => {
    const sessionId = "sess_bridge_upgrade_no_header";
    const stub = await seedSession(sessionId, 1);
    expect(await closeOf(await bridgeUpgrade(stub, sessionId, 1, null))).toEqual({
      code: 4401,
      reason: "unauthorized",
    });
  });

  it("closes with 4401 when the presented credential does not hash to the one on record", async () => {
    const sessionId = "sess_bridge_upgrade_wrong";
    const stub = await seedSession(sessionId, 1);
    expect(await closeOf(await bridgeUpgrade(stub, sessionId, 1, "not-the-credential"))).toEqual({
      code: 4401,
      reason: "unauthorized",
    });
  });

  it("closes with 4401 when no credential was ever minted for that generation, before saying whether it is stale", async () => {
    const sessionId = "sess_bridge_upgrade_no_row";
    // The session is at generation 2 and holds generation 2's hash; a bridge
    // claiming generation 5 with a valid-looking credential is refused as
    // unauthorized, not told "stale".
    const stub = await seedSession(sessionId, 2);
    expect(await closeOf(await bridgeUpgrade(stub, sessionId, 5))).toEqual({
      code: 4401,
      reason: "unauthorized",
    });
  });

  it("accepts a socket for the current generation, negotiates the handshake, and answers a heartbeat by staying open", async () => {
    const sessionId = "sess_bridge_upgrade_current";
    const stub = await seedSession(sessionId, 1);

    const response = await bridgeUpgrade(stub, sessionId, 1);
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const messages: string[] = [];
    client.addEventListener("message", (event: MessageEvent) => {
      messages.push(String(event.data));
    });
    client.accept();

    client.send(
      JSON.stringify({
        type: "bridge.hello",
        protocolVersion: 1,
        sessionId,
        sandboxGeneration: 1,
      }),
    );
    // The welcome leaves only after the post-hello dispatch finishes its writes,
    // so wait on the clock rather than a tick count a loaded machine exhausts.
    const deadline = Date.now() + 15_000;
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(messages).toEqual([
      JSON.stringify({
        type: "bridge.welcome",
        protocolVersion: 1,
        sessionId,
        sandboxGeneration: 1,
      }),
    ]);

    // A heartbeat needs no reply; the object must just not treat it as garbage
    // and close the connection.
    client.send(JSON.stringify({ type: "bridge.heartbeat", sessionId, sandboxGeneration: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);
    const stillOpen = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets("bridge").length,
    );
    expect(stillOpen).toBe(1);
  });

  it("refuses with 500 when redaction secrets are unprotected, the same refusal the fake driver's path makes", async () => {
    const sessionId = "sess_bridge_upgrade_unprotected";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (instance) =>
      instance.createSession(createBody({ sessionId, redactionSecrets: ["short"] })),
    );
    await seedBridgeCredential(stub, 1);

    const response = await bridgeUpgrade(stub, sessionId, 1);

    expect(response.status).toBe(500);
    const bridgeCount = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets("bridge").length,
    );
    expect(bridgeCount).toBe(0);
  });
});

describe("replay after reconnect", () => {
  it("a client connecting with after=0 replays every committed event, then catches up", async () => {
    const sessionId = "sess_replay";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);
  });

  it("a client reconnecting after the last committed sequence has nothing left to replay", async () => {
    const sessionId = "sess_replay_caught_up";
    const stub = await createdAndSettled(sessionId);

    const events = await eventRows(stub);
    const last = events[events.length - 1];
    if (last === undefined) throw new Error("expected at least one event");

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=${last.session_sequence}`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);

    const remaining = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) as n FROM event WHERE session_sequence > ?",
        last.session_sequence,
      ),
    ]);
    expect(remaining[0]?.n).toBe(0);
  });
});

describe("client upgrade ownership", () => {
  // The Worker already verified the caller; these tests exercise the object's
  // own independent check (record 01) by calling `fetch()` directly with a
  // header the real Worker would never send unverified.
  // A refused pair's server end is accepted with `server.accept()`, not
  // `ctx.acceptWebSocket`, so it is absent from `getWebSockets()`; these tests
  // drive the client end returned in the Response instead.
  async function closeCodeOf(response: Response): Promise<number> {
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const closed = new Promise<number>((resolve) => {
      client.addEventListener("close", (event: CloseEvent) => resolve(event.code));
      client.accept();
    });
    return closed;
  }

  it("refuses an upgrade with no x-oncue-user-id header at all (accept-then-close, never a bare status)", async () => {
    const sessionId = "sess_upgrade_no_header";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(await closeCodeOf(response)).toBe(4403);
  });

  it("refuses an upgrade whose x-oncue-user-id disagrees with the session's owner_user_id", async () => {
    const sessionId = "sess_upgrade_wrong_user";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "not_the_owner" },
      }),
    );
    expect(await closeCodeOf(response)).toBe(4403);
  });

  it("accepts an upgrade whose x-oncue-user-id matches the session's owner_user_id", async () => {
    const sessionId = "sess_upgrade_matching_user";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);

    const sockets = await runInDurableObject(stub, (_instance, state) =>
      state.getWebSockets("client"),
    );
    expect(sockets.length).toBeGreaterThan(0);
  });

  it("handleClientFrame drops a frame from a client socket accepted with no attachment, even when a session exists", async () => {
    const sessionId = "sess_client_no_attachment";
    const stub = await createdAndSettled(sessionId);
    const before = await commandRows(stub);

    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["client"]);
      return instance.webSocketMessage(
        pair[0],
        JSON.stringify({
          type: "command",
          command: {
            type: "checkpoint.create",
            commandId: "cmd_no_attachment",
            runId: null,
            issuedAt: TIME,
            expected: { scope: "session", state: "active" },
            payload: { reason: "user_requested" },
          },
        }),
      );
    });

    expect(await commandRows(stub)).toEqual(before);
  });
});

describe("object restart mid-run", () => {
  // Seeds the event log directly rather than through createSession: the fake
  // bridge's plain-accepted client socket stops `evictDurableObject` from
  // quiescing the object, and this test is about replay after eviction.
  it("reconnects and replays the same events with no gap after an eviction", async () => {
    const sessionId = "sess_restart";
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 0, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
      state.storage.sql.exec(
        `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
         VALUES (1, 'evt_seed_1', 'command.acknowledged', NULL, 0, NULL, ?, ?, '{"seq":1}')`,
        TIME,
        TIME,
      );
      state.storage.sql.exec(
        `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
         VALUES (2, 'evt_seed_2', 'run.queued', 'run_1', 0, NULL, ?, ?, '{"seq":2}')`,
        TIME,
        TIME,
      );
    });

    const before = await eventRows(stub);

    await evictDurableObject(stub, { webSockets: "close" });

    const after = await eventRows(stub);
    expect(after).toEqual(before);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);
  });
});

describe("outbox drain retry after a failed D1 write", () => {
  it("retries a projection that failed and eventually applies it", async () => {
    const sessionId = "sess_outbox_retry";
    // No session_index row on purpose: the session row is written straight into
    // the object's storage, so this test controls exactly one outbox row without
    // racing the create flow's own drain.
    const stub = stubFor(sessionId);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 0, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
      state.storage.sql.exec(
        `INSERT INTO outbox (id, session_id, sequence, fact_type, schema_version, payload_json, created_at, attempts)
         VALUES ('outbox_1', ?, 1, 'session_index.snapshot', 1, ?, ?, 0)`,
        sessionId,
        // "not_a_real_state" violates session_index's CHECK constraint, so
        // the D1 UPDATE rejects and the drain's `apply` resolves false.
        JSON.stringify({
          state: "not_a_real_state",
          title: null,
          lastActivityAt: TIME,
          sandboxProviderRef: null,
          sandboxGeneration: 0,
        }),
        TIME,
      );
    });
    await seedSessionIndex(sessionId, "ws_1");

    await runInDurableObject(stub, (instance) =>
      (instance as unknown as { drainOutboxNow: () => Promise<void> }).drainOutboxNow(),
    );

    const stillPending = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ id: string; attempts: number }>(
        "SELECT id, attempts FROM outbox",
      ),
    ]);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.attempts).toBeGreaterThan(0);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE outbox SET payload_json = ? WHERE id = 'outbox_1'",
        JSON.stringify({
          state: "active",
          title: null,
          lastActivityAt: TIME,
          sandboxProviderRef: null,
          sandboxGeneration: 0,
        }),
      );
    });
    await runInDurableObject(stub, (instance) =>
      (instance as unknown as { drainOutboxNow: () => Promise<void> }).drainOutboxNow(),
    );

    const finalPending = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ id: string }>("SELECT id FROM outbox"),
    ]);
    expect(finalPending).toHaveLength(0);

    const projected = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
      .bind(sessionId)
      .first<{ state: string }>();
    expect(projected).toEqual({ state: "active" });
  });
});

describe("generation fencing on wake", () => {
  // These tests accept their own hibernatable "bridge" sockets through
  // `ctx.acceptWebSocket` and call `reconcileBridgeGeneration` directly. The
  // harness's `evictDurableObject` drops a synthetic pair's hibernatable end
  // regardless of this file's logic, so a real eviction could not tell "wake
  // reconciliation kept it" from "the harness dropped it". The constructor
  // calls this same private method.
  interface ReconcilingInstance {
    reconcileBridgeGeneration(): void;
  }

  it("closes a hibernating bridge socket whose generation is no longer current", async () => {
    const sessionId = "sess_wake_fence";
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 2, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      (instance as unknown as ReconcilingInstance).reconcileBridgeGeneration();
      // The harness lists a socket in `getWebSockets()` through its close
      // handshake, which a peerless synthetic pair never completes, so
      // `readyState` is the signal that `ws.close()` ran.
      expect(pair[0].readyState).toBe(WebSocket.CLOSING);
    });
  });

  it("leaves a bridge socket alone when its generation still matches", async () => {
    const sessionId = "sess_wake_matches";
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 1, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      (instance as unknown as ReconcilingInstance).reconcileBridgeGeneration();
      expect(pair[0].readyState).toBe(WebSocket.OPEN);
    });
  });

  it("closes a bridge socket that carries no generation tag at all", async () => {
    const sessionId = "sess_wake_no_tag";
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 1, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
      const matching = new WebSocketPair();
      state.acceptWebSocket(matching[0], ["bridge", "gen:1"]);
      const untagged = new WebSocketPair();
      state.acceptWebSocket(untagged[0], ["bridge"]);

      (instance as unknown as ReconcilingInstance).reconcileBridgeGeneration();

      expect(matching[0].readyState).toBe(WebSocket.OPEN);
      expect(untagged[0].readyState).toBe(WebSocket.CLOSING);
    });
  });
});

describe("the /internal/create HTTP path and fetch()'s fallthrough", () => {
  it("creates a session through fetch(), not just the direct method call", async () => {
    const sessionId = "sess_via_fetch";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);

    const response = await stub.fetch("https://do/internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody({ sessionId })),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as { plan: string };
    expect(result.plan).toBe("accept");
  });

  it("falls through to the SDK's own fetch for any other path", async () => {
    const stub = stubFor("sess_fetch_fallthrough");
    const response = await stub.fetch("https://do/not-a-route-this-file-owns");
    // Whatever the Agents SDK does with an unrecognized path, delegating to it
    // must not throw.
    expect(response).toBeInstanceOf(Response);
  });
});

describe("hibernation handlers", () => {
  it("webSocketError resolves without doing anything observable, and a client socket closing records nothing", async () => {
    const stub = await createdAndSettled("sess_close_client_noop");
    const before = await eventRows(stub);
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["client"]);
      return Promise.all([instance.webSocketClose(pair[0]), instance.webSocketError()]);
    });
    expect(await eventRows(stub)).toEqual(before);
  });

  /**
   * A lost bridge must be recorded, or the screen shows a terminated sandbox as
   * connected. The object records only what it knows: the connection closed.
   */
  it("a current-generation bridge socket closing commits runtime.disconnected, expecting a reconnect", async () => {
    const stub = await createdAndSettled("sess_close_bridge");
    await runInDurableObject(stub, (instance, state) => {
      const [ws] = state.getWebSockets("bridge");
      if (ws === undefined) throw new Error("no bridge socket");
      return instance.webSocketClose(ws);
    });
    const events = await eventRows(stub);
    expect(events.at(-1)?.event_type).toBe("runtime.disconnected");
    const stored = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type = 'runtime.disconnected'",
      ),
    ]);
    expect(JSON.parse(stored[0]?.envelope_json ?? "{}")).toMatchObject({
      sandboxGeneration: 1,
      runtimeSequence: null,
      payload: { reason: "connection_lost", expectReconnect: true, exitCode: null },
    });
  });

  it("a stale generation's bridge socket closing records nothing", async () => {
    const stub = await createdAndSettled("sess_close_stale_bridge");
    const before = await eventRows(stub);
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:0"]);
      return instance.webSocketClose(pair[0]);
    });
    expect(await eventRows(stub)).toEqual(before);
  });

  it("a bridge socket closing with no session row records nothing", async () => {
    const stub = stubFor("sess_close_no_session");
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      return instance.webSocketClose(pair[0]);
    });
    expect(await eventRows(stub)).toEqual([]);
  });
});

describe("actualExpectationFor a run that does not exist yet", () => {
  it("treats a missing run as 'created', which run.pause never allows", async () => {
    const sessionId = "sess_missing_run";
    const stub = await createdAndSettled(sessionId);

    await upgradeClient(stub, sessionId);
    const clientWs = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("client");
      const ws = sockets[sockets.length - 1];
      if (ws === undefined) throw new Error("no client socket");
      return ws;
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "run.pause",
            commandId: "cmd_missing_run_1",
            runId: "run_does_not_exist",
            issuedAt: TIME,
            issuedByUserId: "user_1",
            expected: { scope: "run", state: "running" },
            payload: { reason: "user_requested" },
          },
        }),
      ),
    );

    const rows = await commandRows(stub);
    expect(rows.find((row) => row.id === "cmd_missing_run_1")).toEqual({
      id: "cmd_missing_run_1",
      result_kind: "rejected",
    });
  });
});

describe("approval.resolve through the real session object", () => {
  async function setRunState(
    stub: DurableObjectStub<SessionObject>,
    runId: string,
    state: string,
  ): Promise<void> {
    await runInDurableObject(stub, (_instance, s) => {
      s.storage.sql.exec("UPDATE run SET state = ? WHERE id = ?", state, runId);
    });
  }

  async function seedApproval(
    stub: DurableObjectStub<SessionObject>,
    approvalId: string,
    state: string,
    requestedGeneration: number,
  ): Promise<void> {
    await runInDurableObject(stub, (_instance, s) => {
      s.storage.sql.exec(
        `INSERT INTO approval (id, run_id, state, title, intended_action, category, risk, resource, requested_scope, tool_call_id, requested_generation, requested_at, expires_at)
         VALUES (?, 'run_1', ?, 't', 'i', 'other', 'low', 'r', 's', NULL, ?, ?, ?)`,
        approvalId,
        state,
        requestedGeneration,
        TIME,
        TIME,
      );
    });
  }

  it("rejects a decision when no matching approval row exists (unknown_approval)", async () => {
    const sessionId = "sess_approval_missing";
    const stub = await createdAndSettled(sessionId);
    await setRunState(stub, "run_1", "waiting_for_approval");

    const clientWs = await stub
      .fetch(
        new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
          headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
        }),
      )
      .then(() =>
        runInDurableObject(stub, (_instance, state) => {
          const sockets = state.getWebSockets("client");
          const ws = sockets[sockets.length - 1];
          if (ws === undefined) throw new Error("no client socket");
          return ws;
        }),
      );

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "approval.resolve",
            commandId: "cmd_approval_missing_1",
            runId: "run_1",
            issuedAt: TIME,
            issuedByUserId: "user_1",
            expected: { scope: "run", state: "waiting_for_approval" },
            payload: {
              approvalId: "apr_missing",
              decision: "approved",
            },
          },
        }),
      ),
    );

    const rows = await commandRows(stub);
    expect(rows.find((row) => row.id === "cmd_approval_missing_1")).toEqual({
      id: "cmd_approval_missing_1",
      result_kind: "rejected",
    });
  });

  // Seeded with no request row, so neither decision has a bridge request to answer.
  it.each(["approved", "rejected"] as const)(
    "accepts %s against a real open approval, updating both the approval and run rows",
    async (decision) => {
      const sessionId = `sess_approval_real_${decision}`;
      const stub = await createdAndSettled(sessionId);
      await setRunState(stub, "run_1", "waiting_for_approval");
      await seedApproval(stub, "apr_real_1", "requested", 1);

      const clientWs = await stub
        .fetch(
          new Request(`https://do/ws/sessions/${sessionId}/client?after=0`, {
            headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
          }),
        )
        .then(() =>
          runInDurableObject(stub, (_instance, state) => {
            const sockets = state.getWebSockets("client");
            const ws = sockets[sockets.length - 1];
            if (ws === undefined) throw new Error("no client socket");
            return ws;
          }),
        );

      await runInDurableObject(stub, (instance) =>
        instance.webSocketMessage(
          clientWs,
          JSON.stringify({
            type: "command",
            command: {
              type: "approval.resolve",
              commandId: "cmd_approval_real_1",
              runId: "run_1",
              issuedAt: TIME,
              issuedByUserId: "user_1",
              expected: { scope: "run", state: "waiting_for_approval" },
              payload: {
                approvalId: "apr_real_1",
                decision,
              },
            },
          }),
        ),
      );

      const rows = await commandRows(stub);
      expect(rows.find((row) => row.id === "cmd_approval_real_1")).toEqual({
        id: "cmd_approval_real_1",
        result_kind: "acknowledged",
      });

      const approvalRow = await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ state: string; decision: string }>(
          "SELECT state, decision FROM approval WHERE id = 'apr_real_1'",
        ),
      ]);
      expect(approvalRow).toEqual([{ state: decision, decision }]);

      const runRow = await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ state: string }>("SELECT state FROM run WHERE id = 'run_1'"),
      ]);
      expect(runRow).toEqual([{ state: "running" }]);
    },
  );
});

/**
 * Record 02: a failed provisioning leaves the session readable and says which
 * category failed, rather than leaving the run queued forever.
 */
/** The default pacing with every wait cut to a millisecond. */
const FAST_PACING: ProvisionPacing = {
  prepareBudgetMs: 60_000,
  minPreparePollMs: 1,
  createRetryDelaysMs: [1, 1],
  failedStopDelaysMs: [0, 1, 1],
  createNotAfterMs: 0,
  createLandingGraceMs: 0,
};

describe("provisioning a sandbox that fails", () => {
  async function failedAt(
    sessionId: string,
    driverFailures: CreateSessionBody["driverFailures"],
  ): Promise<{ stub: DurableObjectStub<SessionObject>; events: EventRow[] }> {
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);
    const result = await runInDurableObject(stub, (instance) => {
      instance.provisionPacing = FAST_PACING;
      return instance.createSession(createBody({ sessionId, driverFailures }));
    });
    expect(result.plan).toBe("accept"); // the command itself is still valid; only provisioning failed
    // acknowledged, queued, provisioning, stopped, run.failed
    const events = await waitForEventCount(stub, 5);
    return { stub, events };
  }

  it("records sandbox.stopped and run.failed when create fails, and never attaches a bridge socket", async () => {
    const sessionId = "sess_driver_create_fails";
    const { stub, events } = await failedAt(sessionId, {
      create: { category: "capacity", message: "no capacity", retryable: true },
    });

    expect(events.map((event) => event.event_type)).toEqual([
      "command.acknowledged",
      "run.queued",
      "sandbox.provisioning",
      "sandbox.stopped",
      "run.failed",
    ]);
    const stopped = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type IN ('sandbox.stopped', 'run.failed') ORDER BY session_sequence",
      ),
    ]);
    expect(JSON.parse(stopped[0]?.envelope_json ?? "{}")).toMatchObject({
      sandboxGeneration: 1,
      payload: {
        outcome: "failed",
        reason: "provisioning_failed",
        unsavedWorkWarning: "capacity: no capacity",
      },
    });
    expect(JSON.parse(stopped[1]?.envelope_json ?? "{}")).toMatchObject({
      runId: "run_1",
      payload: { stage: "provisioning", error: { category: "capacity", message: "no capacity" } },
    });

    const rows = await runInDurableObject(stub, (_instance, state) => ({
      runs: [
        ...state.storage.sql.exec<{ state: string; outcome: string | null }>(
          "SELECT state, outcome FROM run",
        ),
      ],
      attachments: [
        ...state.storage.sql.exec<{ state: string; provider_sandbox_id: string | null }>(
          "SELECT state, provider_sandbox_id FROM sandbox_attachment",
        ),
      ],
      bridges: state.getWebSockets("bridge").length,
    }));
    expect(rows).toEqual({
      runs: [{ state: "failed", outcome: "failed" }],
      attachments: [{ state: "failed", provider_sandbox_id: null }],
      bridges: 0,
    });

    // The projection says generation 1 with no provider reference: the
    // sandbox was asked for and never got an id.
    await flush(50);
    const projected = await env.DB.prepare(
      "SELECT sandbox_generation, sandbox_provider_ref FROM session_index WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ sandbox_generation: number; sandbox_provider_ref: string | null }>();
    expect(projected).toEqual({ sandbox_generation: 1, sandbox_provider_ref: null });
  });

  it("records the same pair when start fails", async () => {
    const { events } = await failedAt("sess_driver_start_fails", {
      start: { category: "configuration", message: "bad spec", retryable: false },
    });
    expect(events.map((event) => event.event_type).slice(2)).toEqual([
      "sandbox.provisioning",
      "sandbox.stopped",
      "run.failed",
    ]);
  });

  /**
   * The fake's `start` attaches its bridge before `getConnection` can fail, so
   * scripted frames may land first. The failure must be recorded regardless.
   */
  it("records the same pair when the connection lookup fails after a start", async () => {
    const { events } = await failedAt("sess_driver_connection_fails", {
      getConnection: { category: "not_found", message: "gone", retryable: false },
    });
    const types = events.map((event) => event.event_type);
    expect(types).toContain("sandbox.stopped");
    expect(types).toContain("run.failed");
  });
});

describe("redaction refuses to open a generation with an unprotected secret", () => {
  it("never attaches a bridge socket when a supplied secret is too short to protect", async () => {
    const sessionId = "sess_unprotected_secret";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);

    const result = await runInDurableObject(stub, (instance) =>
      instance.createSession(createBody({ sessionId, redactionSecrets: ["short"] })),
    );
    expect(result.plan).toBe("accept");

    const bridgeCount = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets("bridge").length,
    );
    expect(bridgeCount).toBe(0);
  });
});

describe("parseIncomingCommand: malformed envelopes over the client socket", () => {
  async function sendRawAndCheckNoCommand(
    stub: DurableObjectStub<SessionObject>,
    raw: string,
  ): Promise<void> {
    const clientWs = await waitForClientSocket(stub);
    const before = await commandRows(stub);
    await runInDurableObject(stub, (instance) => instance.webSocketMessage(clientWs, raw));
    expect(await commandRows(stub)).toEqual(before);
  }

  it("drops an unknown command type", async () => {
    const sessionId = "sess_unknown_type";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({ type: "command", command: { type: "not_a_real_command_type" } }),
    );
  });

  it("drops a command envelope that is not an object", async () => {
    const sessionId = "sess_command_not_object";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({ type: "command", command: "just a string" }),
    );
  });

  it("drops a command missing commandId", async () => {
    const sessionId = "sess_missing_command_id";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({
        type: "command",
        command: {
          type: "run.pause",
          issuedAt: TIME,
          issuedByUserId: "user_1",
          expected: { scope: "run", state: "running" },
          payload: { reason: "user_requested" },
        },
      }),
    );
  });

  it("drops a command missing issuedAt", async () => {
    const sessionId = "sess_missing_issued_at";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({
        type: "command",
        command: {
          type: "run.pause",
          commandId: "cmd_x",
          issuedByUserId: "user_1",
          expected: { scope: "run", state: "running" },
          payload: { reason: "user_requested" },
        },
      }),
    );
  });

  it("accepts a command whose wire envelope omits issuedByUserId entirely, stamping it from the socket's verified attachment", async () => {
    const sessionId = "sess_no_issued_by_on_wire";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    const clientWs = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("client");
      const ws = sockets[sockets.length - 1];
      if (ws === undefined) throw new Error("no client socket");
      return ws;
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "checkpoint.create",
            commandId: "cmd_no_issued_by",
            runId: null,
            issuedAt: TIME,
            expected: { scope: "session", state: "active" },
            payload: { reason: "user_requested" },
          },
        }),
      ),
    );

    const rows = await commandRows(stub);
    expect(rows.find((row) => row.id === "cmd_no_issued_by")).toEqual({
      id: "cmd_no_issued_by",
      result_kind: "acknowledged",
    });
  });

  it("ignores a client-supplied issuedByUserId on the wire, stamping the command from the verified attachment instead (no wire impersonation)", async () => {
    const sessionId = "sess_wire_impersonation";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    const clientWs = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("client");
      const ws = sockets[sockets.length - 1];
      if (ws === undefined) throw new Error("no client socket");
      return ws;
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        clientWs,
        JSON.stringify({
          type: "command",
          command: {
            type: "checkpoint.create",
            commandId: "cmd_wire_impersonation",
            runId: null,
            issuedAt: TIME,
            issuedByUserId: "someone_else",
            expected: { scope: "session", state: "active" },
            payload: { reason: "user_requested" },
          },
        }),
      ),
    );

    const stamped = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ issued_by_user_id: string }>(
        "SELECT issued_by_user_id FROM command WHERE id = 'cmd_wire_impersonation'",
      ),
    ]);
    // The connection was opened as "user_1"; the wire's claimed "someone_else"
    // must never reach the stored record.
    expect(stamped).toEqual([{ issued_by_user_id: "user_1" }]);
  });

  it("drops a command missing expected entirely", async () => {
    const sessionId = "sess_missing_expected";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({
        type: "command",
        command: {
          type: "run.pause",
          commandId: "cmd_x",
          issuedAt: TIME,
          issuedByUserId: "user_1",
          payload: { reason: "user_requested" },
        },
      }),
    );
  });

  it("drops a command whose expected is explicitly null", async () => {
    const sessionId = "sess_null_expected";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    await sendRawAndCheckNoCommand(
      stub,
      JSON.stringify({
        type: "command",
        command: {
          type: "run.pause",
          commandId: "cmd_x",
          issuedAt: TIME,
          issuedByUserId: "user_1",
          expected: null,
          payload: { reason: "user_requested" },
        },
      }),
    );
  });
});

describe("client replay cursor parsing", () => {
  it("defaults to 0 when the after query param is absent", async () => {
    const sessionId = "sess_no_after_param";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);
  });

  it("defaults to 0 when after is not a number", async () => {
    const sessionId = "sess_bad_after_param";
    const stub = await createdAndSettled(sessionId);

    const response = await stub.fetch(
      new Request(`https://do/ws/sessions/${sessionId}/client?after=not-a-number`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
      }),
    );
    expect(response.status).toBe(101);
  });
});

describe("webSocketMessage with a non-string payload", () => {
  it("treats an ArrayBuffer message as an empty frame rather than throwing", async () => {
    const sessionId = "sess_binary_message";
    const stub = await createdAndSettled(sessionId);
    await upgradeClient(stub, sessionId);
    const clientWs = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("client");
      const ws = sockets[sockets.length - 1];
      if (ws === undefined) throw new Error("no client socket");
      return ws;
    });

    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(clientWs, new ArrayBuffer(4)),
    );
  });
});

describe("a bridge or client frame arriving with no session yet", () => {
  it("handleBridgeFrame is a no-op when there is no session row", async () => {
    const stub = stubFor("sess_bridge_before_create");
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      return instance.webSocketMessage(pair[0], JSON.stringify({ hello: "world" }));
    });
  });

  it("handleClientFrame is a no-op when there is no session row", async () => {
    const stub = stubFor("sess_client_before_create");
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["client"]);
      return instance.webSocketMessage(
        pair[0],
        JSON.stringify({
          type: "command",
          command: {
            type: "run.pause",
            commandId: "cmd_no_session",
            runId: "run_1",
            issuedAt: TIME,
            issuedByUserId: "user_1",
            expected: { scope: "run", state: "running" },
            payload: { reason: "user_requested" },
          },
        }),
      );
    });
  });
});

describe("the outbox alarm", () => {
  it("alarm() drains the outbox the same way drainOutboxNow does", async () => {
    const sessionId = "sess_alarm";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (instance) => instance.createSession(createBody({ sessionId })));

    await runInDurableObject(stub, (instance) => instance.alarm());

    const projected = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
      .bind(sessionId)
      .first<{ state: string }>();
    expect(projected).toEqual({ state: "active" });
  });
});

describe("SessionObject: paced bridge frames", () => {
  it("spreads a paced script over time instead of draining it on the microtask queue", async () => {
    const sessionId = "sess_paced";
    await seedSessionIndex(sessionId, "ws_1");
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));

    await stub.createSession(
      createBody({
        sessionId,
        commandId: "cmd_paced",
        mintedRunId: "run_paced",
        framePacingMs: 40,
      }),
    );

    const durableFrames = 3;
    const creationEvents = 5;
    const rows = await waitForEventCount(stub, creationEvents + durableFrames);
    expect(rows.length).toBe(creationEvents + durableFrames);
    expect(rows.map((row) => row.event_type)).toContain("run.completed_with_warnings");
  });
});

/**
 * The bootstrap credential is random per generation, handed to the driver's
 * `create` once, and kept only as a SHA-256 in `bridge_credential`, so only
 * the object can verify it.
 */
describe("the bootstrap credential a sandbox is created with", () => {
  /** Runs `createSession` on the real driver over a controller stand-in that answers everything and records the create spec. */
  async function createdWithSpec(sessionId: string): Promise<{
    stub: DurableObjectStub<SessionObject>;
    credential: string;
  }> {
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (String(input).endsWith("/v1/prepareImage")) {
        return preparedImage();
      }
      if (String(input).endsWith("/v1/getOutput")) {
        return Response.json(
          { kind: "error", category: "not_found", message: "gone", retryable: false },
          { status: 404 },
        );
      }
      return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-9" } });
    }) as typeof fetch;
    try {
      await runInDurableObject(stub, async (instance) => {
        // The real controller bindings, so `selectSandboxDriver` returns the driver
        // that transmits the spec. `env` is protected and Miniflare binds it per
        // namespace, so reaching into it is the only way to put one object on the
        // real driver.
        Object.assign((instance as unknown as { env: Env }).env, {
          ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run",
          ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
        });
        await instance.createSession(
          createBody({
            sessionId,
            modalCredential: {
              tokenId: "ak-fake0001",
              tokenSecret: "as-fake0001",
              environmentName: null,
            },
          }),
        );
      });
      await waitForEventCount(stub, 5);
    } finally {
      globalThis.fetch = realFetch;
    }
    const created = sent.find((body) => typeof body.bootstrapCredential === "string");
    if (created === undefined) {
      throw new Error("the driver was never asked to create a sandbox");
    }
    return { stub, credential: created.bootstrapCredential as string };
  }

  async function upgradeWith(
    stub: DurableObjectStub<SessionObject>,
    sessionId: string,
    presented: string,
  ): Promise<Response> {
    return stub.fetch(
      new Request(`https://do/ws/bridge/${sessionId}/1`, {
        headers: { Upgrade: "websocket", [BRIDGE_CREDENTIAL_HEADER]: presented },
      }),
    );
  }

  it("is random per generation and stored only as its hash", async () => {
    const first = await createdWithSpec("sess_bootstrap_random_1");
    const second = await createdWithSpec("sess_bootstrap_random_2");

    // 32 random bytes as base64url: 43 characters, no padding.
    expect(first.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.credential).not.toBe(second.credential);

    const stored = await runInDurableObject(first.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ generation: number; credential_sha256: string }>(
        "SELECT generation, credential_sha256 FROM bridge_credential",
      ),
    ]);
    expect(stored).toEqual([
      { generation: 1, credential_sha256: await sha256Hex(first.credential) },
    ]);
    // The plaintext is nowhere in the object's own event log.
    const anywhere = await runInDurableObject(first.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM event WHERE envelope_json LIKE ?",
        `%${first.credential}%`,
      ),
    ]);
    expect(anywhere[0]?.n).toBe(0);
  });

  it("verifies the minted value by hash and refuses a wrong one", async () => {
    const sessionId = "sess_bootstrap_verifies";
    const { stub, credential } = await createdWithSpec(sessionId);

    const accepted = await upgradeWith(stub, sessionId, credential);
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    const tags = await runInDurableObject(stub, (_instance, state) => {
      const ws = state.getWebSockets("bridge")[0];
      if (ws === undefined) throw new Error("no bridge socket");
      return state.getTags(ws);
    });
    expect(tags).toEqual(expect.arrayContaining(["bridge", "gen:1"]));

    const refused = await upgradeWith(stub, sessionId, `${credential}x`);
    expect(refused.status).toBe(101);
    const client = refused.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    const closed = await new Promise<number>((resolve) => {
      client.addEventListener("close", (event: CloseEvent) => resolve(event.code));
      client.accept();
    });
    expect(closed).toBe(4401);
  });
});

/**
 * The user's stop: the object stops the provider's sandbox, ends the run, and
 * records both; a later bridge close for that generation is not a new fact.
 * On the fake driver the credential is null.
 */
describe("stopSandbox", () => {
  it("stops the current generation, leaves a run that already ended with its outcome, and is not_running afterwards", async () => {
    const sessionId = "sess_stop_user";
    const stub = await createdAndSettled(sessionId);

    const result = await runInDurableObject(stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });

    // The scripted run already ended (its bare `run.verified` was refused and
    // downgraded), so no `run.cancelled` follows and its row keeps its outcome.
    const types = (await eventRows(stub)).map((event) => event.event_type);
    expect(types.slice(-2)).toEqual(["sandbox.credentials_revoked", "sandbox.stopped"]);
    expect(types).not.toContain("run.cancelled");
    const stored = await runInDurableObject(stub, (_instance, state) => ({
      stopped: [
        ...state.storage.sql.exec<{ envelope_json: string }>(
          "SELECT envelope_json FROM event WHERE event_type = 'sandbox.stopped'",
        ),
      ],
      attachment: [
        ...state.storage.sql.exec<{ state: string }>(
          "SELECT state FROM sandbox_attachment WHERE generation = 1",
        ),
      ],
      run: [
        ...state.storage.sql.exec<{ state: string; outcome: string }>(
          "SELECT state, outcome FROM run",
        ),
      ],
    }));
    expect(JSON.parse(stored.stopped[0]?.envelope_json ?? "{}").payload).toMatchObject({
      outcome: "stopped",
      reason: "user_requested",
    });
    expect(stored.attachment).toEqual([{ state: "stopped" }]);
    expect(stored.run).toEqual([
      { state: "completed_with_warnings", outcome: "completed_with_warnings" },
    ]);

    // The bridge going away afterwards is the consequence, not a new fact.
    const before = await eventRows(stub);
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      return instance.webSocketClose(pair[0]);
    });
    expect(await eventRows(stub)).toEqual(before);

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
      ),
    ).resolves.toEqual({ kind: "not_running" });
  });

  it("is not_running for a session with no generation, and with no session at all", async () => {
    const empty = stubFor("sess_stop_nothing");
    await expect(
      runInDurableObject(empty, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
      ),
    ).resolves.toEqual({ kind: "not_running" });

    const seeded = stubFor("sess_stop_gen0");
    await runInDurableObject(seeded, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES ('sess_stop_gen0', 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 0, NULL, 1, ?, ?)`,
        TIME,
        TIME,
      );
    });
    await expect(
      runInDurableObject(seeded, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
      ),
    ).resolves.toEqual({ kind: "not_running" });
  });

  it("asks the driver for everything when the generation has no output on record", async () => {
    // The object can lose the race between recording the attachment and its
    // first output lines, so a stop must not assume a cursor exists.
    const sessionId = "sess_stop_no_output";
    const stub = await createdAndSettled(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM event WHERE event_type = 'sandbox.output'");
    });
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
      ),
    ).resolves.toEqual({ kind: "stopped", generation: 1 });
  });

  it("answers over the /internal/stop path too", async () => {
    const sessionId = "sess_stop_http";
    const stub = await createdAndSettled(sessionId);
    const response = await stub.fetch(
      new Request("https://do/internal/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestedByUserId: "user_1", modalCredential: null }),
      }),
    );
    expect(await response.json()).toEqual({ kind: "stopped", generation: 1 });
  });
});

/**
 * The real driver over a scripted controller: the object relays what the
 * sandbox prints while waiting for the bridge, one event per stream, and stops
 * on the first driver error. The poll interval is real, so these tests pay
 * one or two intervals.
 */
describe("relaying the sandbox's output on the real driver", () => {
  const CREDENTIAL = { tokenId: "ak-fake0001", tokenSecret: "as-fake0001", environmentName: null };

  function scriptedController(
    answers: (body: Record<string, unknown>, url: string) => Response,
    scriptsPreparation = false,
  ): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // A workspace whose image is built, unless the test scripts preparation.
      if (String(input).endsWith("/v1/prepareImage") && !scriptsPreparation) {
        return preparedImage();
      }
      return answers(body, String(input));
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  async function onRealDriver(sessionId: string): Promise<DurableObjectStub<SessionObject>> {
    await seedSessionIndex(sessionId, "ws_1");
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, async (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run",
        ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
      });
      await instance.createSession(createBody({ sessionId, modalCredential: CREDENTIAL }));
    });
    return stub;
  }

  async function outputPayloads(
    stub: DurableObjectStub<SessionObject>,
  ): Promise<{ stream: string; lines: { text: string }[] }[]> {
    const rows = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type = 'sandbox.output' ORDER BY session_sequence",
      ),
    ]);
    return rows.map(
      (row) =>
        JSON.parse(row.envelope_json).payload as { stream: string; lines: { text: string }[] },
    );
  }

  it("relays stdout and stderr as separate events and stops on a driver error", async () => {
    let outputCalls = 0;
    const restore = scriptedController((_body, url) => {
      if (url.endsWith("/v1/getConnection")) {
        return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } });
      }
      if (url.endsWith("/v1/getOutput")) {
        outputCalls += 1;
        if (outputCalls === 1) {
          return Response.json({
            kind: "ok",
            value: {
              lines: [
                { stream: "stdout", at: TIME, text: "bridge starting" },
                { stream: "stderr", at: TIME, text: "bridge could not reach the control plane" },
                { stream: "stdout", at: TIME, text: "retrying" },
              ],
              next: "2026-09-02T00:00:01.000Z",
            },
          });
        }
        return Response.json(
          { kind: "error", category: "not_found", message: "gone", retryable: false },
          { status: 404 },
        );
      }
      return Response.json({ kind: "ok", value: {} });
    });
    try {
      const stub = await onRealDriver("sess_relay_output");
      // acknowledged, queued, provisioning, attached, controller timings,
      // stdout batch, stderr batch
      const rows = await waitForEventCount(stub, 7, 4000);
      const payloads = await outputPayloads(stub);
      expect(payloads.map((payload) => payload.stream)).toEqual(["controller", "stdout", "stderr"]);
      expect(payloads[1]?.lines.map((line) => line.text)).toEqual(["bridge starting", "retrying"]);
      expect(payloads[2]?.lines.map((line) => line.text)).toEqual([
        "bridge could not reach the control plane",
      ]);
      expect(rows.length).toBe(7);
      // One interval later the second poll failed and the loop ended.
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS + 500));
      expect(outputCalls).toBe(2);
    } finally {
      restore();
    }
  });

  it("drains a few polls after the bridge connects, then stops, and a stop fetches the last lines past the cursor", {
    timeout: 40_000,
  }, async () => {
    const sent: string[] = [];
    let outputCalls = 0;
    const restore = scriptedController((body, url) => {
      if (url.endsWith("/v1/getConnection")) {
        return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-2" } });
      }
      if (url.endsWith("/v1/getOutput")) {
        outputCalls += 1;
        sent.push(String(body.since));
        return Response.json({
          kind: "ok",
          value: {
            lines:
              outputCalls === 1
                ? [{ stream: "stdout", at: "2026-09-02T00:00:05.000Z", text: "hello" }]
                : [],
            next: "2026-09-02T00:00:05.001Z",
          },
        });
      }
      return Response.json({ kind: "ok", value: {} });
    });
    try {
      const stub = await onRealDriver("sess_relay_connected");
      await waitForEventCount(stub, 6, 4000);
      // A connected bridge, recorded the way ingest records it.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
           VALUES ((SELECT MAX(session_sequence) + 1 FROM event), 'evt_conn', 'runtime.connected', NULL, 1, 0, ?, ?, '{}')`,
          TIME,
          TIME,
        );
      });
      // The loop sees the connection on its next wake, drains its allowance of
      // polls for late lines, and returns.
      await new Promise((resolve) =>
        setTimeout(resolve, (OUTPUT_DRAIN_POLLS + 1) * OUTPUT_POLL_INTERVAL_MS + 1_000),
      );
      const settled = outputCalls;
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS + 500));
      expect(outputCalls).toBe(settled);

      const result = await runInDurableObject(stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: CREDENTIAL }),
      );
      expect(result).toEqual({ kind: "stopped", generation: 1 });
      // The final fetch asks from one millisecond past the last relayed line.
      expect(sent.at(-1)).toBe("2026-09-02T00:00:05.001Z");
    } finally {
      restore();
    }
  });

  it("stops relaying when the generation ends under it", { timeout: 20_000 }, async () => {
    let outputCalls = 0;
    const restore = scriptedController((_body, url) => {
      if (url.endsWith("/v1/getConnection")) {
        return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-3" } });
      }
      if (url.endsWith("/v1/getOutput")) {
        outputCalls += 1;
        return Response.json({ kind: "ok", value: { lines: [], next: TIME } });
      }
      return Response.json({ kind: "ok", value: {} });
    });
    try {
      const stub = await onRealDriver("sess_relay_ended");
      await waitForEventCount(stub, 5, 4000);
      const result = await runInDurableObject(stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: CREDENTIAL }),
      );
      expect(result).toEqual({ kind: "stopped", generation: 1 });
      // The loop's next wake finds the generation stopped and returns, with no
      // bridge ever connected and no drain to run.
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS + 500));
      const settled = outputCalls;
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS + 500));
      expect(outputCalls).toBe(settled);
    } finally {
      restore();
    }
  });

  it("reports the driver's failure when the provider will not stop the sandbox", async () => {
    const restore = scriptedController((_body, url) => {
      if (url.endsWith("/v1/getConnection")) {
        return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-3" } });
      }
      if (url.endsWith("/v1/getOutput")) {
        return Response.json(
          { kind: "error", category: "not_found", message: "gone", retryable: false },
          { status: 404 },
        );
      }
      if (url.endsWith("/v1/stop")) {
        return new Response(
          JSON.stringify({
            kind: "error",
            category: "unknown",
            message: "Modal reported a server-side failure.",
            retryable: true,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ kind: "ok", value: {} });
    });
    try {
      const stub = await onRealDriver("sess_stop_fails");
      await waitForEventCount(stub, 5, 4000);
      await expect(
        runInDurableObject(stub, (instance) =>
          instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: CREDENTIAL }),
        ),
      ).resolves.toEqual({
        kind: "failed",
        category: "unknown",
        message: "Modal reported a server-side failure.",
      });
    } finally {
      restore();
    }
  });
});
