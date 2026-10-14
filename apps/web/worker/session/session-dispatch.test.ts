// What the object owes the bridge, end to end: sessions run on the real driver
// over a scripted controller, the bridge is a hand-driven socket through the
// real upgrade path, and GitHub is `worker/test/github-double.ts`. Every
// `bridge.ack` is sent by the test itself.

import { env, runInDurableObject } from "cloudflare:test";
import type { ModelRecord } from "@oncue/protocol";
import { makeEvent, testModelRecord } from "@oncue/protocol/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeyring } from "../broker/envelope";
import { checkForForward } from "../broker/tokens";
import type { SessionObject } from "../index";
import { createGitHubDouble, type GitHubDouble, githubTestSettings } from "../test/github-double";
import { preparedImage, seedModalConnection, TEST_PACING } from "../test/session-world";
import { GIT_GRANT_TIMEOUT_MS, MAX_DISPATCH_ATTEMPTS } from "./dispatch";
import {
  BRIDGE_CREDENTIAL_HEADER,
  type CreateSessionBody,
  type CreateSessionRepository,
} from "./session-object";

// Provisioning, negotiating, and reconnecting exceed the default five seconds
// under coverage instrumentation.
vi.setConfig({ testTimeout: 30_000 });

const TIME = "2026-09-02T00:00:00.000Z";
/**
 * Read before any test touches the env, which Miniflare shares between
 * objects; every session below states the keyring it runs with.
 */
const REAL_KEYRING = env.ONCUE_BROKER_KEYRING as string;
const CONTROLLER_ORIGIN = "https://oncue--controller.modal.run";
const GITHUB_ORIGIN = "https://github.double";
const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const INSTALLATION_ID = 4001;
const REPOSITORY_ID = 501;

const REPOSITORY: CreateSessionRepository = {
  installationId: INSTALLATION_ID,
  repositoryId: REPOSITORY_ID,
  fullName: "acme/widgets",
  cloneUrl: `${GITHUB_ORIGIN}/acme/widgets.git`,
  taskBranch: "oncue/fix-it-1a2b",
  baseSha: BASE_SHA,
};

function stubFor(sessionId: string): DurableObjectStub<SessionObject> {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

async function seedSessionIndex(sessionId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, 'ws_1', NULL, 'creating', ?, ?)`,
  )
    .bind(sessionId, TIME, TIME)
    .run();
}

function createBody(sessionId: string, overrides: Partial<CreateSessionBody>): CreateSessionBody {
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
    modalCredential: { tokenId: "ak-fake0001", tokenSecret: "as-fake0001", environmentName: null },
    redactionSecrets: [],
    driverFailures: {},
    ...overrides,
  };
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets anything already in flight land, so a "nothing more arrives" assertion means something. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface DispatchRowRecord extends Record<string, string | number | null> {
  intent_id: string;
  kind: string;
  state: string;
  attempts: number;
  settled_at: string | null;
}

async function dispatchRows(stub: DurableObjectStub<SessionObject>): Promise<DispatchRowRecord[]> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<DispatchRowRecord>(
      "SELECT intent_id, kind, state, attempts, settled_at FROM bridge_dispatch ORDER BY created_at ASC, rowid ASC",
    ),
  ]);
}

async function eventsOfType(
  stub: DurableObjectStub<SessionObject>,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = ? ORDER BY session_sequence ASC",
      type,
    ),
  ]);
  return rows.map((row) => JSON.parse(row.envelope_json) as Record<string, unknown>);
}

async function eventTypes(stub: DurableObjectStub<SessionObject>): Promise<string[]> {
  const rows = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ event_type: string }>(
      "SELECT event_type FROM event ORDER BY session_sequence ASC",
    ),
  ]);
  return rows.map((row) => row.event_type);
}

async function runRows(
  stub: DurableObjectStub<SessionObject>,
): Promise<Array<{ id: string; state: string; trigger: string; continues_run_id: string | null }>> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{
      id: string;
      state: string;
      trigger: string;
      continues_run_id: string | null;
    }>("SELECT id, state, trigger, continues_run_id FROM run ORDER BY queued_at ASC, rowid ASC"),
  ]);
}

interface RunRowRecord extends Record<string, string | null> {
  state: string;
  outcome: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** The cached run row the object answers `actualExpectationFor` from. */
async function runRowOf(
  stub: DurableObjectStub<SessionObject>,
  runId: string,
): Promise<RunRowRecord> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<RunRowRecord>(
        "SELECT state, outcome, started_at, ended_at FROM run WHERE id = ?",
        runId,
      )
      .one(),
  );
}

async function heldRows(
  stub: DurableObjectStub<SessionObject>,
): Promise<Array<{ message_id: string; released_run_id: string | null }>> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ message_id: string; released_run_id: string | null }>(
      "SELECT message_id, released_run_id FROM queued_message ORDER BY held_at ASC",
    ),
  ]);
}

async function setRunState(
  stub: DurableObjectStub<SessionObject>,
  runId: string,
  state: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, s) => {
    s.storage.sql.exec("UPDATE run SET state = ? WHERE id = ?", state, runId);
  });
}

interface ScriptedWorld {
  readonly stub: DurableObjectStub<SessionObject>;
  readonly credential: string;
  readonly github: GitHubDouble;
  /** Wall-clock times at which the controller was asked to stop the sandbox. */
  readonly stopCallsAt: number[];
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function githubDouble(): GitHubDouble {
  return createGitHubDouble({
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [42],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [{ id: REPOSITORY_ID, fullName: "acme/widgets", defaultBranch: "main" }],
    },
  });
}

/**
 * A session on the real driver. The controller refuses `getOutput`, ending the
 * output relay at its first poll. The bootstrap credential is read from the
 * driver's `create` spec, the only place it is ever in the clear.
 */
async function sessionOnRealDriver(
  sessionId: string,
  options: {
    readonly repository?: CreateSessionRepository | null;
    readonly githubConfigured?: boolean;
    readonly envOverrides?: Record<string, string>;
    /** The run's model record; the testing default names no catalog row. */
    readonly model?: ModelRecord;
    /** What the controller answers a stop with; ok by default. */
    readonly stopAnswer?: () => Response;
  } = {},
): Promise<ScriptedWorld> {
  await seedSessionIndex(sessionId);
  const stub = stubFor(sessionId);
  const github = githubDouble();
  const stopCallsAt: number[] = [];
  let credential: string | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GITHUB_ORIGIN)) {
      return github.fetchImpl(input as string, init);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/v1/create")) {
      credential = String(body.bootstrapCredential);
    }
    if (url.endsWith("/v1/prepareImage")) {
      return preparedImage();
    }
    if (url.endsWith("/v1/stop")) {
      stopCallsAt.push(Date.now());
      if (options.stopAnswer !== undefined) {
        return options.stopAnswer();
      }
    }
    if (url.endsWith("/v1/getOutput")) {
      return Response.json(
        { kind: "error", category: "not_found", message: "gone", retryable: false },
        { status: 404 },
      );
    }
    return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = realFetch;
  };
  // Stated either way, since the shared env could carry the previous test's value.
  const githubSettings =
    options.githubConfigured === false
      ? Object.fromEntries(Object.keys(await githubTestSettings()).map((key) => [key, ""]))
      : await githubTestSettings();
  await runInDurableObject(stub, async (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, {
      ONCUE_SANDBOX_CONTROLLER_ORIGIN: CONTROLLER_ORIGIN,
      ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
      ...githubSettings,
      ONCUE_GITHUB_API_ORIGIN: GITHUB_ORIGIN,
      ONCUE_BROKER_KEYRING: REAL_KEYRING,
      ...options.envOverrides,
    });
    instance.provisionPacing = TEST_PACING;
    await instance.createSession(
      createBody(sessionId, {
        repository: options.repository ?? null,
        ...(options.model === undefined ? {} : { model: options.model }),
      }),
    );
  });
  await waitFor(async () => (await eventTypes(stub)).includes("sandbox.attached"), "attachment");
  if (credential === null) {
    throw new Error("the driver was never asked to create a sandbox");
  }
  return { stub, credential, github, stopCallsAt };
}

interface TestBridge {
  readonly client: WebSocket;
  /** Every frame the object sent, parsed, in arrival order. */
  readonly received: Array<Record<string, unknown>>;
  hello(): Promise<void>;
  send(frame: unknown): void;
  /** The next unused sandbox-origin runtime sequence. */
  nextSequence(): number;
  close(): void;
}

const bridgesToClose: WebSocket[] = [];
afterEach(() => {
  for (const ws of bridgesToClose.splice(0)) {
    ws.close();
  }
});

async function connectBridge(
  world: ScriptedWorld,
  sessionId: string,
  sequenceStart = 0,
): Promise<TestBridge> {
  const response = await world.stub.fetch(
    new Request(`https://do/ws/bridge/${sessionId}/1`, {
      headers: { Upgrade: "websocket", [BRIDGE_CREDENTIAL_HEADER]: world.credential },
    }),
  );
  expect(response.status).toBe(101);
  const client = response.webSocket;
  if (client === null || client === undefined) {
    throw new Error("expected a webSocket on the upgrade response");
  }
  const received: Array<Record<string, unknown>> = [];
  client.addEventListener("message", (event: MessageEvent) => {
    received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  client.accept();
  bridgesToClose.push(client);
  let sequence = sequenceStart;
  return {
    client,
    received,
    async hello() {
      client.send(
        JSON.stringify({
          type: "bridge.hello",
          protocolVersion: 1,
          sessionId,
          sandboxGeneration: 1,
        }),
      );
      await waitFor(() => received.some((frame) => frame.type === "bridge.welcome"), "welcome");
    },
    send(frame) {
      client.send(JSON.stringify(frame));
    },
    nextSequence() {
      const next = sequence;
      sequence += 1;
      return next;
    },
    close() {
      client.close();
    },
  };
}

function framesOf(bridge: TestBridge, type: string): Array<Record<string, unknown>> {
  return bridge.received.filter((frame) => frame.type === type);
}

function ackFrame(
  sessionId: string,
  ref: { commandId: string } | { grantId: string },
  outcome: { kind: "accepted" } | { kind: "rejected"; reason: string },
): Record<string, unknown> {
  return { type: "bridge.ack", sessionId, sandboxGeneration: 1, ref, outcome };
}

/** Brings a bridge to the point where commands flow: negotiated, granted, and `runtime.ready` committed. */
async function readyBridge(world: ScriptedWorld, sessionId: string): Promise<TestBridge> {
  const bridge = await connectBridge(world, sessionId);
  await bridge.hello();
  await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
  bridge.send(
    makeEvent("runtime.ready", {
      eventId: `evt_ready_${sessionId}`,
      sessionId,
      runtimeSequence: bridge.nextSequence(),
    }),
  );
  await waitFor(() => framesOf(bridge, "bridge.command").length >= 1, "the queued run.start");
  return bridge;
}

const clientsToClose: WebSocket[] = [];
afterEach(() => {
  for (const ws of clientsToClose.splice(0)) {
    ws.close();
  }
});

/** Opens the owner's client socket and returns a sender that drives it the way the browser does. */
async function clientFor(
  stub: DurableObjectStub<SessionObject>,
  sessionId: string,
): Promise<(command: Record<string, unknown>) => Promise<void>> {
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
  clientsToClose.push(browserEnd);
  let serverEnd: WebSocket | undefined;
  await waitFor(async () => {
    serverEnd = await runInDurableObject(stub, (_instance, state) =>
      state.getWebSockets("client").at(-1),
    );
    return serverEnd !== undefined;
  }, "the client socket");
  return async (command) => {
    await runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        serverEnd as WebSocket,
        JSON.stringify({ type: "command", command }),
      ),
    );
  };
}

function followUp(
  commandId: string,
  messageId: string,
  delivery: "steer_current_run" | "run_next",
): Record<string, unknown> {
  return {
    type: "run.follow_up",
    commandId,
    runId: "run_1",
    issuedAt: TIME,
    expected: { scope: "run", state: "running" },
    payload: { messageId, text: `Message ${messageId}`, attachments: [], delivery },
  };
}

describe("what the object owes the bridge: grants, commands, and receipts", () => {
  it("sends a catalog model's grant with the run's effort and the model's facts for the runtime", async () => {
    const sessionId = "sess_dispatch_catalog";
    const world = await sessionOnRealDriver(sessionId, {
      model: { ...testModelRecord(), modelId: "claude-opus-5-5", effort: "medium" },
    });
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
    expect(framesOf(bridge, "bridge.grant")[0]).toMatchObject({
      kind: "model",
      // Both coordinate sets, so an older sandbox image still parses the
      // grant, and the session's harness beside them.
      model: {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        providerID: "anthropic",
        modelID: "claude-opus-5-5",
      },
      runtime: "opencode",
      effort: "medium",
      modelSpec: {
        name: "Claude Opus 5.5",
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  it("holds run.start pending, sends the model grant at hello, the command at runtime.ready, and records the bridge's receipt", async () => {
    const sessionId = "sess_dispatch_basic";
    const world = await sessionOnRealDriver(sessionId);

    // No bridge yet: the run's own run.start waits as a pending row.
    expect(await dispatchRows(world.stub)).toEqual([
      {
        intent_id: "cmd_create_1",
        kind: "command",
        state: "pending",
        attempts: 0,
        settled_at: null,
      },
    ]);

    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
    await settle();
    expect(bridge.received.map((frame) => frame.type)).toEqual(["bridge.welcome", "bridge.grant"]);
    const grant = framesOf(bridge, "bridge.grant")[0] as Record<string, unknown>;
    expect(grant).toMatchObject({
      kind: "model",
      sessionId,
      sandboxGeneration: 1,
      workspace: "none",
      brokerOrigin: "https://do",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      // The run's record names no effort, and this id is no catalog row, so
      // the grant carries nothing for the runtime to declare.
      effort: null,
      modelSpec: null,
    });
    expect(typeof grant.expiresAt).toBe("string");
    // The token is a real broker token scoped to this session, generation,
    // connection, and model: what `forward.ts` will check.
    const keyring = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "token");
    if (keyring.kind !== "ok") throw new Error("test keyring did not derive");
    const checked = await checkForForward(keyring.keyring, String(grant.token), Date.now());
    expect(checked).toMatchObject({
      kind: "valid",
      claims: {
        sessionId,
        sandboxGeneration: 1,
        connectionId: "conn_1",
        workspaceId: "ws_1",
        modelId: "claude-sonnet-4-5",
      },
    });
    expect(await dispatchRows(world.stub)).toEqual([
      {
        intent_id: "cmd_create_1",
        kind: "command",
        state: "pending",
        attempts: 0,
        settled_at: null,
      },
      {
        intent_id: grant.grantId,
        kind: "model_grant",
        state: "sent",
        attempts: 1,
        settled_at: null,
      },
    ]);
    // The minted token is nowhere in the object's own storage.
    const stored = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM bridge_dispatch",
      ),
    ]);
    expect(stored.some((row) => row.payload_json.includes(String(grant.token)))).toBe(false);

    // runtime.ready flushes the pending command.
    bridge.send(
      makeEvent("runtime.ready", {
        eventId: "evt_ready_basic",
        sessionId,
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 1, "the run.start command");
    expect(framesOf(bridge, "bridge.command")[0]).toMatchObject({
      sessionId,
      sandboxGeneration: 1,
      command: { type: "run.start", commandId: "cmd_create_1", issuedByUserId: "user_1" },
      // The run the object queued: the bridge's run events will name it, so
      // the object's run row moves for them.
      runId: (await eventsOfType(world.stub, "run.queued"))[0]?.runId,
    });
    expect((await dispatchRows(world.stub))[0]).toMatchObject({ state: "sent", attempts: 1 });

    // The bridge's receipt is a second acknowledgement on the timeline.
    bridge.send(ackFrame(sessionId, { commandId: "cmd_create_1" }, { kind: "accepted" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.acknowledged")).length >= 2,
      "the bridge's acknowledgement",
    );
    const acknowledged = await eventsOfType(world.stub, "command.acknowledged");
    expect(
      acknowledged.map((event) => (event.payload as { acceptedBy: string }).acceptedBy),
    ).toEqual(["control_plane", "bridge"]);
    expect((await dispatchRows(world.stub))[0]).toMatchObject({ state: "accepted" });
    expect((await dispatchRows(world.stub))[0]?.settled_at).not.toBeNull();

    // A redelivered ack, an ack for the grant, and an ack for nothing: no new event.
    bridge.send(ackFrame(sessionId, { commandId: "cmd_create_1" }, { kind: "accepted" }));
    bridge.send(ackFrame(sessionId, { grantId: String(grant.grantId) }, { kind: "accepted" }));
    bridge.send(ackFrame(sessionId, { grantId: "grant_nobody_minted" }, { kind: "accepted" }));
    await waitFor(
      async () => (await dispatchRows(world.stub))[1]?.state === "accepted",
      "the grant's receipt",
    );
    await settle();
    expect(await eventsOfType(world.stub, "command.acknowledged")).toHaveLength(2);
  });

  it("sends the git grant first, narrowed to the one repository with contents: read, and revokes it when repository.status lands", async () => {
    const sessionId = "sess_dispatch_git";
    const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });

    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 2, "both grants");
    const [git, model] = framesOf(bridge, "bridge.grant");
    expect(git).toMatchObject({
      kind: "git",
      repository: { fullName: "acme/widgets", cloneUrl: REPOSITORY.cloneUrl },
      branch: REPOSITORY.taskBranch,
      baseSha: BASE_SHA,
    });
    expect(String(git?.token)).toMatch(/^ghs_/);
    expect(model).toMatchObject({ kind: "model", workspace: "repository" });
    const mint = world.github.calls.find((call) => call.path.includes("access_tokens"));
    expect(mint?.tokenNarrowing).toEqual({
      repositoryIds: [REPOSITORY_ID],
      permissions: { contents: "read" },
    });
    // The revoke deadline is on the alarm.
    const alarm = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(Math.abs((alarm as number) - (Date.now() + GIT_GRANT_TIMEOUT_MS))).toBeLessThan(5_000);
    // The token is nowhere in the object's own storage.
    const stored = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM bridge_dispatch",
      ),
    ]);
    expect(stored.some((row) => row.payload_json.includes(String(git?.token)))).toBe(false);

    bridge.send(ackFrame(sessionId, { grantId: String(git?.grantId) }, { kind: "accepted" }));
    bridge.send(
      makeEvent("repository.status", {
        eventId: "evt_repo_status_1",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the revocation",
    );
    const revoked = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ git_grant_revoked: number }>(
        "SELECT git_grant_revoked FROM session_repository",
      ),
    ]);
    expect(revoked).toEqual([{ git_grant_revoked: 1 }]);
    const alarmAfter = await runInDurableObject(
      world.stub,
      (instance) =>
        (instance as unknown as { gitGrantDeadlineMs: number | null }).gitGrantDeadlineMs,
    );
    expect(alarmAfter).toBeNull();

    // A reconnect re-sends the model grant (still unacknowledged) and never
    // the git grant again: it was accepted, and the clone is done.
    bridge.close();
    const again = await connectBridge(world, sessionId, 1);
    await again.hello();
    await waitFor(() => framesOf(again, "bridge.grant").length >= 1, "the re-sent model grant");
    await settle();
    expect(framesOf(again, "bridge.grant").map((frame) => frame.kind)).toEqual(["model"]);
    expect(await dispatchRows(world.stub)).toEqual([
      expect.objectContaining({ kind: "command", state: "pending" }),
      expect.objectContaining({ kind: "git_grant", state: "accepted", attempts: 1 }),
      expect.objectContaining({ kind: "model_grant", state: "sent", attempts: 2 }),
    ]);
  });

  it("gives up on rows the bridge never acknowledges after MAX_DISPATCH_ATTEMPTS sends", async () => {
    const sessionId = "sess_dispatch_give_up";
    const world = await sessionOnRealDriver(sessionId);
    let bridge = await readyBridge(world, sessionId);
    expect(await dispatchRows(world.stub)).toEqual([
      expect.objectContaining({ kind: "command", state: "sent", attempts: 1 }),
      expect.objectContaining({ kind: "model_grant", state: "sent", attempts: 1 }),
    ]);

    for (let attempt = 2; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      bridge.close();
      bridge = await connectBridge(world, sessionId, 1);
      await bridge.hello();
      await waitFor(
        () =>
          framesOf(bridge, "bridge.grant").length >= 1 &&
          framesOf(bridge, "bridge.command").length >= 1,
        `redelivery ${attempt}`,
      );
      expect(await dispatchRows(world.stub)).toEqual([
        expect.objectContaining({ kind: "command", state: "sent", attempts: attempt }),
        expect.objectContaining({ kind: "model_grant", state: "sent", attempts: attempt }),
      ]);
    }

    bridge.close();
    bridge = await connectBridge(world, sessionId, 1);
    await bridge.hello();
    await waitFor(
      async () => (await dispatchRows(world.stub)).every((row) => row.state === "rejected"),
      "the rows to be given up on",
    );
    await settle();
    expect(bridge.received.map((frame) => frame.type)).toEqual(["bridge.welcome"]);
    const rejected = await eventsOfType(world.stub, "command.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({
      commandId: "cmd_create_1",
      commandType: "run.start",
      reason: "unsupported",
      detail: "bridge never acknowledged",
    });
  });

  it("sends a later run.start at once, and never plans a row for a command the bridge does not act on", async () => {
    const sessionId = "sess_dispatch_later_start";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    const send = await clientFor(world.stub, sessionId);

    await send({
      type: "checkpoint.create",
      commandId: "cmd_checkpoint",
      runId: null,
      issuedAt: TIME,
      expected: { scope: "session", state: "active" },
      payload: { reason: "user_requested" },
    });
    await send({
      type: "run.start",
      commandId: "cmd_second_start",
      runId: null,
      issuedAt: TIME,
      expected: { scope: "session", state: "active" },
      payload: {
        instruction: { messageId: "msg_2", text: "Now the other bug", attachments: [] },
        model: testModelRecord(),
        continuesRunId: null,
      },
    });

    await waitFor(() => framesOf(bridge, "bridge.command").length >= 2, "the second run.start");
    expect(framesOf(bridge, "bridge.command")[1]).toMatchObject({
      command: { type: "run.start", commandId: "cmd_second_start" },
    });
    const rows = await dispatchRows(world.stub);
    expect(rows.map((row) => row.intent_id)).not.toContain("cmd_checkpoint");
    expect(rows.find((row) => row.intent_id === "cmd_second_start")).toMatchObject({
      state: "sent",
      attempts: 1,
    });
  });

  it.each([
    ["wrong_state", "wrong_state"],
    ["duplicate", "duplicate"],
    ["no_runtime", "wrong_state"],
    ["unsupported", "unsupported"],
    ["malformed", "unsupported"],
  ])(
    "turns a %s rejection from the bridge into command.rejected { %s }",
    async (reason, mapped) => {
      const sessionId = `sess_dispatch_reject_${reason}`;
      const world = await sessionOnRealDriver(sessionId);
      const bridge = await readyBridge(world, sessionId);

      bridge.send(ackFrame(sessionId, { commandId: "cmd_create_1" }, { kind: "rejected", reason }));
      await waitFor(
        async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
        "the rejection",
      );
      expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
        commandId: "cmd_create_1",
        commandType: "run.start",
        reason: mapped,
        detail: `the bridge rejected the command: ${reason}`,
      });
      expect((await dispatchRows(world.stub))[0]).toMatchObject({ state: "rejected" });
    },
  );

  it("fails the run at provisioning when the bridge rejects the model grant", async () => {
    const sessionId = "sess_dispatch_grant_rejected";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
    const grant = framesOf(bridge, "bridge.grant")[0] as Record<string, unknown>;

    bridge.send(
      ackFrame(
        sessionId,
        { grantId: String(grant.grantId) },
        { kind: "rejected", reason: "wrong_state" },
      ),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "run.failed",
    );
    expect((await eventsOfType(world.stub, "run.failed"))[0]).toMatchObject({
      runId: "run_1",
      payload: { stage: "provisioning", error: { category: "model_grant_rejected" } },
    });
    expect(await runRows(world.stub)).toEqual([
      expect.objectContaining({ id: "run_1", state: "failed" }),
    ]);
    expect((await dispatchRows(world.stub))[1]).toMatchObject({
      kind: "model_grant",
      state: "rejected",
    });
  });
});

describe("what the object owes the bridge: follow-ups, cancels, and the next run", () => {
  it("steers a follow-up now, holds one for the next run, and releases it as a continuation when the run ends", async () => {
    const sessionId = "sess_dispatch_follow_ups";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);

    await send(followUp("cmd_steer", "msg_steer", "steer_current_run"));
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 2, "the steering follow-up");
    expect(framesOf(bridge, "bridge.command")[1]).toMatchObject({
      command: { type: "run.follow_up", commandId: "cmd_steer" },
    });

    // The skip-checks flag is held with the message, since its `run.start` is
    // built later.
    const next = followUp("cmd_next", "msg_next", "run_next");
    await send({ ...next, payload: { ...(next.payload as object), skipRequiredChecks: true } });
    await settle();
    expect(framesOf(bridge, "bridge.command")).toHaveLength(2);
    expect(await heldRows(world.stub)).toEqual([{ message_id: "msg_next", released_run_id: null }]);
    expect((await dispatchRows(world.stub)).map((row) => row.intent_id)).not.toContain("cmd_next");

    // The run's terminal event releases the held message as a new run that
    // continues this one, on the same model, and the bridge gets it at once.
    bridge.send(
      makeEvent("run.completed_with_warnings", {
        eventId: "evt_completed_1",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 3, "the continuation");
    const continuation = framesOf(bridge, "bridge.command")[2] as {
      command: { type: string; issuedByUserId: string; payload: Record<string, unknown> };
      runId: string | null;
    };
    expect(continuation.command).toMatchObject({
      type: "run.start",
      issuedByUserId: "user_1",
      payload: {
        instruction: { messageId: "msg_next", text: "Message msg_next" },
        model: testModelRecord(),
        continuesRunId: "run_1",
        skipRequiredChecks: true,
      },
    });
    const queued = await eventsOfType(world.stub, "run.queued");
    expect(queued).toHaveLength(2);
    expect(queued[1]?.payload).toMatchObject({
      trigger: "queued_message",
      continuesRunId: "run_1",
    });
    expect(continuation.runId).toBe(queued[1]?.runId);
    const runs = await runRows(world.stub);
    expect(runs).toHaveLength(2);
    const nextRunId = runs[1]?.id as string;
    expect(runs[1]).toMatchObject({
      state: "queued",
      trigger: "queued_message",
      continues_run_id: "run_1",
    });
    expect(await heldRows(world.stub)).toEqual([
      { message_id: "msg_next", released_run_id: nextRunId },
    ]);

    // A terminal event for a run that is no longer current releases nothing,
    // and neither does one for the current run with nothing held.
    bridge.send(
      makeEvent("run.blocked", {
        eventId: "evt_blocked_old",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    bridge.send(
      makeEvent("run.blocked", {
        eventId: "evt_blocked_next",
        sessionId,
        runId: nextRunId,
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.blocked")).length >= 2,
      "both terminals",
    );
    await settle();
    expect(await runRows(world.stub)).toHaveLength(2);
    // The row follows the same rule: the finished run's row keeps the outcome
    // it ended with, and only the current run's row moved to `blocked`.
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "completed_with_warnings",
      outcome: "completed_with_warnings",
    });
    expect(await runRowOf(world.stub, nextRunId)).toMatchObject({
      state: "blocked",
      outcome: "blocked",
      ended_at: TIME,
    });
  });

  it("releases a held message at the effort it named, with a fresh grant and token minted for it, and refuses an effort the model does not offer", async () => {
    const sessionId = "sess_dispatch_effort";
    const world = await sessionOnRealDriver(sessionId, {
      model: { ...testModelRecord(), modelId: "claude-opus-5-5", effort: "medium" },
    });
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);
    expect(framesOf(bridge, "bridge.grant")[0]).toMatchObject({ kind: "model", effort: "medium" });

    // `none` is OpenAI's word; Opus 5.5 documents low to max. Refused before
    // anything is held.
    const wrong = followUp("cmd_wrong", "msg_wrong", "run_next");
    await send({ ...wrong, payload: { ...(wrong.payload as object), effort: "none" } });
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
      "the refusal",
    );
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandId: "cmd_wrong",
      reason: "wrong_state",
    });
    expect(await heldRows(world.stub)).toEqual([]);

    const next = followUp("cmd_low", "msg_low", "run_next");
    await send({ ...next, payload: { ...(next.payload as object), effort: "low" } });
    await settle();
    expect(await heldRows(world.stub)).toEqual([{ message_id: "msg_low", released_run_id: null }]);

    bridge.send(
      makeEvent("run.completed_with_warnings", {
        eventId: "evt_completed_effort",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 2, "the second grant");
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 2, "the continuation");
    // The next run runs at low: its record says so, and so does the fresh
    // model grant, whose token the broker will write `low` from.
    expect(framesOf(bridge, "bridge.command").at(-1)).toMatchObject({
      command: {
        type: "run.start",
        payload: { model: { modelId: "claude-opus-5-5", effort: "low" } },
      },
    });
    const regrant = framesOf(bridge, "bridge.grant")[1] as Record<string, unknown>;
    expect(regrant).toMatchObject({ kind: "model", effort: "low" });
    const keyring = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "token");
    if (keyring.kind !== "ok") throw new Error("test keyring did not derive");
    expect(await checkForForward(keyring.keyring, String(regrant.token), Date.now())).toMatchObject(
      {
        kind: "valid",
        claims: { modelId: "claude-opus-5-5", effort: "low" },
      },
    );
  });

  it("refuses a follow-up naming any effort when the run's model is no catalog row", async () => {
    // The testing record's model is not in the catalog (the fake driver's
    // is not either), so it offers no levels at all.
    const sessionId = "sess_dispatch_effort_unknown";
    const world = await sessionOnRealDriver(sessionId);
    await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);
    const next = followUp("cmd_unknown", "msg_unknown", "run_next");
    await send({ ...next, payload: { ...(next.payload as object), effort: "low" } });
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
      "the refusal",
    );
    expect(await heldRows(world.stub)).toEqual([]);
  });

  it("refuses an effort follow-up naming a run this object never queued, and keeps the socket", async () => {
    const sessionId = "sess_dispatch_effort_no_run";
    const world = await sessionOnRealDriver(sessionId, {
      model: { ...testModelRecord(), modelId: "claude-opus-5-5", effort: "medium" },
    });
    await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);
    const next = followUp("cmd_no_run", "msg_no_run", "run_next");
    await send({
      ...next,
      runId: "run_nobody",
      payload: { ...(next.payload as object), effort: "low" },
    });
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
      "the refusal",
    );
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandId: "cmd_no_run",
    });
    expect(await heldRows(world.stub)).toEqual([]);
  });

  it("a terminal event for a session with no run yet releases nothing, and a bare verified is downgraded", async () => {
    const sessionId = "sess_dispatch_no_run_terminal";
    const stub = stubFor(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, 'user_1', 'active', NULL, NULL, 1, NULL, 1, ?, ?)`,
        sessionId,
        TIME,
        TIME,
      );
    });
    await runInDurableObject(stub, (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      return instance.webSocketMessage(
        pair[0],
        JSON.stringify(
          makeEvent("run.verified", { eventId: "evt_orphan_terminal", sessionId, runId: "run_x" }),
        ),
      );
    });
    // Record 14's gate: no records back the claim, so the object stores the
    // outcome they support and never the claim itself.
    expect(await eventTypes(stub)).toEqual(["run.completed_with_warnings"]);
    expect(await runRows(stub)).toEqual([]);
  });

  it("a continuation into a session that is no longer active is rejected rather than run", async () => {
    const sessionId = "sess_dispatch_archived_continuation";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);
    await send(followUp("cmd_next", "msg_next", "run_next"));
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'archived'");
    });

    bridge.send(
      makeEvent("run.verified", {
        eventId: "evt_verified_archived",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
      "the continuation's rejection",
    );
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandType: "run.start",
      reason: "wrong_state",
    });
    expect(await runRows(world.stub)).toHaveLength(1);
    expect(framesOf(bridge, "bridge.command")).toHaveLength(1);
  });

  it("a cancel from the client is delivered, keeps the sandbox, and commits run.cancelled exactly once", async () => {
    const sessionId = "sess_dispatch_cancel";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);

    await send({
      type: "run.cancel",
      commandId: "cmd_cancel",
      runId: "run_1",
      issuedAt: TIME,
      expected: { scope: "run", state: "running" },
      payload: { reason: null, checkpointFirst: false },
    });
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 2, "the cancel");
    expect(framesOf(bridge, "bridge.command")[1]).toMatchObject({
      command: { type: "run.cancel", commandId: "cmd_cancel" },
    });
    expect(await eventsOfType(world.stub, "run.cancelled")).toHaveLength(1);
    expect(world.stopCallsAt).toEqual([]);
    const attachment = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ state: string }>("SELECT state FROM sandbox_attachment"),
    ]);
    // `runtime.ready` moved the attachment along record 11's edge to active;
    // a cancel leaves it there.
    expect(attachment).toEqual([{ state: "active" }]);
    expect(await runRows(world.stub)).toEqual([
      expect.objectContaining({ id: "run_1", state: "cancelled" }),
    ]);

    // The bridge's own late terminal for the cancelled run is committed as
    // an event and moves nothing: the row keeps the outcome the object gave it.
    bridge.send(
      makeEvent("run.failed", {
        eventId: "evt_late_failed",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
        payload: {
          stage: "execution",
          error: { category: "unknown", message: "opencode exited with code null" },
          summary: null,
          evidence: [],
          branch: null,
          pullRequestNumber: null,
          usage: null,
          durationMs: 1,
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "the late run.failed",
    );
    expect(await runRows(world.stub)).toEqual([
      expect.objectContaining({ id: "run_1", state: "cancelled" }),
    ]);
  });
});

describe("what the object owes the bridge: stopping", () => {
  it("a stop with a listening bridge sends runtime.shutdown before the driver's stop, and a held message is released by the cancel", async () => {
    const sessionId = "sess_dispatch_stop_shutdown";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");
    const send = await clientFor(world.stub, sessionId);
    await send(followUp("cmd_next", "msg_next", "run_next"));

    const shutdownAt: number[] = [];
    bridge.client.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as { command?: { type?: string } };
      if (frame.command?.type === "runtime.shutdown" && shutdownAt.length === 0) {
        shutdownAt.push(Date.now());
        // A well-behaved bridge closes its end once it has shut the runtime down.
        bridge.close();
      }
    });

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({
        requestedByUserId: "user_1",
        modalCredential: {
          tokenId: "ak-fake0001",
          tokenSecret: "as-fake0001",
          environmentName: null,
        },
      }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    expect(shutdownAt).toHaveLength(1);
    expect(world.stopCallsAt).toHaveLength(1);
    expect(shutdownAt[0] as number).toBeLessThanOrEqual(world.stopCallsAt[0] as number);
    expect(framesOf(bridge, "bridge.command").at(-1)).toMatchObject({
      command: { type: "runtime.shutdown", payload: { reason: "cancelled" } },
    });

    const types = await eventTypes(world.stub);
    expect(types).toContain("sandbox.stopped");
    expect(types.filter((type) => type === "run.cancelled")).toHaveLength(1);

    // The generation's open rows are gone; the held message survived the
    // generation and was released by the run's own terminal event.
    expect((await dispatchRows(world.stub)).filter((row) => row.state === "sent")).toEqual([]);
    const held = await heldRows(world.stub);
    expect(held).toHaveLength(1);
    expect(held[0]?.released_run_id).not.toBeNull();
    expect((await eventsOfType(world.stub, "run.queued"))[1]?.payload).toMatchObject({
      trigger: "queued_message",
      continuesRunId: "run_1",
    });
  });

  it("a stop with no listening bridge goes straight to the driver", async () => {
    const sessionId = "sess_dispatch_stop_plain";
    const world = await sessionOnRealDriver(sessionId);
    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({
        requestedByUserId: "user_1",
        modalCredential: {
          tokenId: "ak-fake0001",
          tokenSecret: "as-fake0001",
          environmentName: null,
        },
      }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    expect(world.stopCallsAt).toHaveLength(1);
    expect((await eventTypes(world.stub)).slice(-2)).toEqual(["sandbox.stopped", "run.cancelled"]);
    expect(await dispatchRows(world.stub)).toEqual([]);
  });
});

describe("what the object owes the bridge: a bridge that gives up", () => {
  function disconnected(sessionId: string, bridge: TestBridge, expectReconnect: boolean) {
    return makeEvent("runtime.disconnected", {
      eventId: `evt_disc_${sessionId}_${String(expectReconnect)}`,
      sessionId,
      runtimeSequence: bridge.nextSequence(),
      payload: { reason: "runtime_crashed", detail: "OpenCode exited 137.", expectReconnect },
    });
  }

  it("fails a run that never started at provisioning, through the lifecycle path", async () => {
    const sessionId = "sess_dispatch_loss_provisioning";
    // The workspace's Modal pair, which the stop below is opened with.
    await seedModalConnection("ws_1");
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();

    bridge.send(disconnected(sessionId, bridge, false));
    await waitFor(async () => (await eventTypes(world.stub)).includes("run.failed"), "run.failed");
    const types = await eventTypes(world.stub);
    expect(types.slice(-3)).toEqual(["runtime.disconnected", "sandbox.stopped", "run.failed"]);
    expect((await eventsOfType(world.stub, "run.failed"))[0]?.payload).toMatchObject({
      stage: "provisioning",
      error: { category: "unknown", message: "OpenCode exited 137." },
    });
    // The sandbox came up before the bridge gave up, so it is still running
    // on the provider: the object stops it rather than leaving it to bill.
    await waitFor(() => world.stopCallsAt.length === 1, "the failed generation's sandbox stopped");
  });

  it("records the failure the same when the controller refuses to stop the failed generation's sandbox", async () => {
    const sessionId = "sess_dispatch_loss_stop_refused";
    await seedModalConnection("ws_1");
    const world = await sessionOnRealDriver(sessionId, {
      stopAnswer: () =>
        Response.json(
          { kind: "error", category: "unknown", message: "no", retryable: false },
          { status: 500 },
        ),
    });
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();

    bridge.send(disconnected(sessionId, bridge, false));
    await waitFor(async () => (await eventTypes(world.stub)).includes("run.failed"), "run.failed");
    await waitFor(() => world.stopCallsAt.length === 1, "the stop attempt");
    await settle();
    expect(world.stopCallsAt).toHaveLength(1);
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("cannot stop the failed generation's sandbox without the workspace's Modal pair, and says so instead of throwing", async () => {
    const sessionId = "sess_dispatch_loss_no_pair";
    await env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = 'ws_1'").run();
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();

    bridge.send(disconnected(sessionId, bridge, false));
    await waitFor(async () => (await eventTypes(world.stub)).includes("run.failed"), "run.failed");
    await settle();
    expect(world.stopCallsAt).toEqual([]);
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("records the failure the same when opening the Modal pair itself throws, and the socket survives it", async () => {
    const sessionId = "sess_dispatch_loss_credential_throws";
    await seedModalConnection("ws_1");
    const world = await sessionOnRealDriver(sessionId);
    await runInDurableObject(world.stub, (instance) => {
      const holder = instance as unknown as { env: { DB: D1Database } };
      const real = holder.env.DB;
      holder.env = {
        ...holder.env,
        DB: new Proxy(real, {
          get(target, property) {
            if (property !== "prepare") {
              return Reflect.get(target, property);
            }
            return (sql: string) =>
              sql.includes("FROM modal_connection")
                ? { bind: () => ({ first: () => Promise.reject(new Error("database gone")) }) }
                : target.prepare(sql);
          },
        }),
      };
    });
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();

    bridge.send(disconnected(sessionId, bridge, false));
    await waitFor(async () => (await eventTypes(world.stub)).includes("run.failed"), "run.failed");
    await settle();
    expect(world.stopCallsAt).toEqual([]);
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("fails a running run at execution, leaves a finished run alone, and ignores a loss the bridge will recover from", async () => {
    const sessionId = "sess_dispatch_loss_execution";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    await setRunState(world.stub, "run_1", "running");

    bridge.send(disconnected(sessionId, bridge, true));
    await waitFor(
      async () => (await eventsOfType(world.stub, "runtime.disconnected")).length >= 1,
      "the first disconnect",
    );
    await settle();
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);

    bridge.send(disconnected(sessionId, bridge, false));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "run.failed",
    );
    expect((await eventsOfType(world.stub, "run.failed"))[0]?.payload).toMatchObject({
      stage: "execution",
      error: { category: "runtime_crashed", message: "OpenCode exited 137." },
    });
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "failed" })]);

    // Already over: nothing more to record.
    bridge.send({
      ...disconnected(sessionId, bridge, false),
      eventId: "evt_disc_after_terminal",
    });
    await waitFor(
      async () => (await eventsOfType(world.stub, "runtime.disconnected")).length >= 3,
      "the third disconnect",
    );
    await settle();
    expect(await eventsOfType(world.stub, "run.failed")).toHaveLength(1);
  });
});

describe("what the object owes the bridge: minting that fails", () => {
  it("leaves the model grant pending when the keyring is missing, and sends it once one exists", async () => {
    const sessionId = "sess_dispatch_no_keyring";
    const world = await sessionOnRealDriver(sessionId, {
      envOverrides: { ONCUE_BROKER_KEYRING: "" },
    });
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(
      async () => (await dispatchRows(world.stub)).some((row) => row.kind === "model_grant"),
      "the grant row",
    );
    await settle();
    expect(bridge.received.map((frame) => frame.type)).toEqual(["bridge.welcome"]);
    expect((await dispatchRows(world.stub))[1]).toMatchObject({
      kind: "model_grant",
      state: "pending",
      attempts: 1,
    });

    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        ONCUE_BROKER_KEYRING: REAL_KEYRING,
      });
    });
    bridge.close();
    const again = await connectBridge(world, sessionId);
    await again.hello();
    await waitFor(() => framesOf(again, "bridge.grant").length >= 1, "the grant");
    expect((await dispatchRows(world.stub))[1]).toMatchObject({ state: "sent", attempts: 2 });
  });

  it.each([
    ["GitHub refuses to mint", { githubConfigured: true, mode: "token_mint_fails" as const }],
    ["the deployment has no GitHub App", { githubConfigured: false, mode: "ok" as const }],
  ])(
    "fails the run at provisioning when %s, and still sends the model grant",
    async (_name, setup) => {
      const sessionId = `sess_dispatch_git_fails_${setup.githubConfigured ? "mint" : "unconfigured"}`;
      const world = await sessionOnRealDriver(sessionId, {
        repository: REPOSITORY,
        githubConfigured: setup.githubConfigured,
      });
      world.github.setMode(setup.mode);
      const bridge = await connectBridge(world, sessionId);
      await bridge.hello();

      await waitFor(
        async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
        "run.failed",
      );
      expect((await eventsOfType(world.stub, "run.failed"))[0]?.payload).toMatchObject({
        stage: "provisioning",
        error: { category: "git_grant_not_minted" },
      });
      await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
      expect(framesOf(bridge, "bridge.grant").map((frame) => frame.kind)).toEqual(["model"]);
      expect(await dispatchRows(world.stub)).toEqual([
        expect.objectContaining({ kind: "command", state: "pending" }),
        expect.objectContaining({ kind: "git_grant", state: "pending", attempts: 1 }),
        expect.objectContaining({ kind: "model_grant", state: "sent", attempts: 1 }),
      ]);
      expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "failed" })]);
    },
  );
});

describe("what the object owes the bridge: the git-grant deadline", () => {
  interface Deadlined {
    gitGrantDeadlineMs: number | null;
    alarm(): Promise<void>;
  }

  async function grantedWorld(sessionId: string): Promise<ScriptedWorld> {
    const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 2, "both grants");
    return world;
  }

  it("revokes the token when the deadline passes without repository.status", async () => {
    const world = await grantedWorld("sess_dispatch_deadline_passed");
    await runInDurableObject(world.stub, async (instance) => {
      (instance as unknown as Deadlined).gitGrantDeadlineMs = Date.now() - 1;
      await (instance as unknown as Deadlined).alarm();
    });
    expect(world.github.calls.some((call) => call.tokenRevoked === true)).toBe(true);
    const revoked = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ git_grant_revoked: number }>(
        "SELECT git_grant_revoked FROM session_repository",
      ),
    ]);
    expect(revoked).toEqual([{ git_grant_revoked: 1 }]);
  });

  it("an alarm that fires before the deadline puts the deadline back and revokes nothing", async () => {
    const world = await grantedWorld("sess_dispatch_deadline_early");
    const deadline = await runInDurableObject(world.stub, async (instance) => {
      await (instance as unknown as Deadlined).alarm();
      return (instance as unknown as Deadlined).gitGrantDeadlineMs;
    });
    expect(world.github.calls.some((call) => call.tokenRevoked === true)).toBe(false);
    const alarm = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBe(deadline);
  });

  /**
   * The object arms the earliest owed deadline. A stray alarm nothing owes is
   * replaced, since nothing would ever clear it.
   */
  it("arms the earliest deadline an owner is owed and replaces an alarm no owner asked for", async () => {
    const sessionId = "sess_dispatch_deadline_sooner";
    const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });
    const unowed = Date.now() + 60_000;
    await runInDurableObject(world.stub, (_instance, state) => state.storage.setAlarm(unowed));
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 2, "both grants");
    const sentAt = Date.now();
    const alarm = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBe(unowed);
    expect(alarm).toBeGreaterThan(sentAt + GIT_GRANT_TIMEOUT_MS - 30_000);
    expect(alarm).toBeLessThanOrEqual(sentAt + GIT_GRANT_TIMEOUT_MS);
  });

  it("a passed deadline with no token held calls GitHub for nothing", async () => {
    const world = await sessionOnRealDriver("sess_dispatch_deadline_empty");
    await runInDurableObject(world.stub, async (instance) => {
      (instance as unknown as Deadlined).gitGrantDeadlineMs = 1;
      await (instance as unknown as Deadlined).alarm();
    });
    expect(world.github.calls).toEqual([]);
  });
});

describe("what the object owes the bridge: which socket is current", () => {
  it("welcomes a socket accepted without an attachment but never sends it a frame", async () => {
    const sessionId = "sess_dispatch_raw_socket";
    const world = await sessionOnRealDriver(sessionId);
    const received: string[] = [];
    await runInDurableObject(world.stub, async (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[0], ["bridge", "gen:1"]);
      pair[1].accept();
      pair[1].addEventListener("message", (event: MessageEvent) => {
        received.push(String(event.data));
      });
      await instance.webSocketMessage(
        pair[0],
        JSON.stringify({
          type: "bridge.hello",
          protocolVersion: 1,
          sessionId,
          sandboxGeneration: 1,
        }),
      );
    });
    await waitFor(() => received.length >= 1, "the welcome");
    await settle();
    expect(received.map((text) => (JSON.parse(text) as { type: string }).type)).toEqual([
      "bridge.welcome",
    ]);
    // The grant was planned and counted; it left on no socket, and the next
    // real bridge is owed it.
    expect((await dispatchRows(world.stub))[1]).toMatchObject({
      kind: "model_grant",
      state: "sent",
      attempts: 1,
    });
  });

  it("a negotiated socket for a superseded generation is not current", async () => {
    const sessionId = "sess_dispatch_old_generation";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");

    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET sandbox_generation = 2");
    });
    bridge.send({ type: "bridge.hello", protocolVersion: 1, sessionId, sandboxGeneration: 2 });
    await waitFor(() => framesOf(bridge, "bridge.welcome").length >= 2, "the second welcome");
    await settle();
    expect(framesOf(bridge, "bridge.grant")).toHaveLength(1);
    const rows = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ generation: number; kind: string; state: string }>(
        "SELECT generation, kind, state FROM bridge_dispatch WHERE generation = 2",
      ),
    ]);
    expect(rows).toEqual([{ generation: 2, kind: "model_grant", state: "sent" }]);
  });

  it("a negotiated socket that has closed is not current, so a command waits", async () => {
    const sessionId = "sess_dispatch_closed_socket";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await connectBridge(world, sessionId);
    await bridge.hello();
    await waitFor(() => framesOf(bridge, "bridge.grant").length >= 1, "the model grant");
    bridge.close();
    await waitFor(
      async () =>
        await runInDurableObject(world.stub, (_instance, state) =>
          state.getWebSockets("bridge").every((ws) => ws.readyState !== WebSocket.OPEN),
        ),
      "the server end to leave OPEN",
    );

    const send = await clientFor(world.stub, sessionId);
    await send({
      type: "runtime.shutdown",
      commandId: "cmd_shutdown_nobody",
      runId: null,
      issuedAt: TIME,
      expected: { scope: "session", state: "active" },
      payload: { reason: "idle", graceMs: 1000 },
    });
    expect(
      (await dispatchRows(world.stub)).find((row) => row.intent_id === "cmd_shutdown_nobody"),
    ).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(framesOf(bridge, "bridge.command")).toEqual([]);
  });
});

describe("the run row follows the bridge's own events", () => {
  it("moves ready, running, paused, running again, and ended, so a client's follow-up sees the true state", async () => {
    const sessionId = "sess_run_row_follows";
    const world = await sessionOnRealDriver(sessionId);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "provisioning",
      started_at: null,
    });

    // `runtime.ready` carries no run id and takes the one edge out of
    // `provisioning` that is not a failure.
    const bridge = await readyBridge(world, sessionId);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "ready", outcome: null });

    const startedAt = "2026-09-11T10:00:00.000Z";
    bridge.send(
      makeEvent("run.started", {
        eventId: "evt_started_1",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
        occurredAt: startedAt,
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "running",
      "the row to reach running",
    );
    expect(await runRowOf(world.stub, "run_1")).toEqual({
      state: "running",
      outcome: null,
      started_at: startedAt,
      ended_at: null,
    });

    // The bridge's `run.started` moved the row, so the follow-up is accepted
    // rather than rejected as wrong_state.
    const send = await clientFor(world.stub, sessionId);
    await send(followUp("cmd_steer_true_state", "msg_steer_true_state", "steer_current_run"));
    await waitFor(() => framesOf(bridge, "bridge.command").length >= 2, "the steering follow-up");
    expect(
      (await eventsOfType(world.stub, "command.acknowledged")).map((event) => event.payload),
    ).toContainEqual(
      expect.objectContaining({ commandId: "cmd_steer_true_state", commandType: "run.follow_up" }),
    );
    expect(await eventsOfType(world.stub, "command.rejected")).toEqual([]);

    bridge.send(
      makeEvent("run.paused", {
        eventId: "evt_paused_1",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "paused",
      "the row to reach paused",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "paused",
      outcome: null,
      started_at: startedAt,
    });

    // A resumed run keeps the `started_at` of its first start, as the view does.
    bridge.send(
      makeEvent("run.started", {
        eventId: "evt_started_2",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
        occurredAt: "2026-09-11T10:05:00.000Z",
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "running",
      "the row to reach running again",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ started_at: startedAt });

    const endedAt = "2026-09-11T10:10:00.000Z";
    bridge.send(
      makeEvent("run.completed_with_warnings", {
        eventId: "evt_completed_row",
        sessionId,
        runId: "run_1",
        runtimeSequence: bridge.nextSequence(),
        occurredAt: endedAt,
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
      "the row to end",
    );
    expect(await runRowOf(world.stub, "run_1")).toEqual({
      state: "completed_with_warnings",
      outcome: "completed_with_warnings",
      started_at: startedAt,
      ended_at: endedAt,
    });

    // A follow-up after the end is refused for the true reason, with the true state.
    await send(followUp("cmd_steer_after_end", "msg_steer_after_end", "steer_current_run"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
      "the rejection",
    );
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandId: "cmd_steer_after_end",
      reason: "wrong_state",
      actualState: "completed_with_warnings",
    });
  });

  it.each(["blocked", "failed"] as const)(
    "ends the row with outcome %s when the bridge sends that terminal",
    async (outcome) => {
      const sessionId = `sess_run_row_${outcome}`;
      const world = await sessionOnRealDriver(sessionId);
      const bridge = await readyBridge(world, sessionId);
      bridge.send(
        makeEvent(`run.${outcome}`, {
          eventId: `evt_${outcome}_row`,
          sessionId,
          runId: "run_1",
          runtimeSequence: bridge.nextSequence(),
        }),
      );
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === outcome,
        `the row to reach ${outcome}`,
      );
      expect(await runRowOf(world.stub, "run_1")).toEqual({
        state: outcome,
        outcome,
        started_at: null,
        ended_at: TIME,
      });
    },
  );

  it("leaves the row alone for an event naming a run that is not current", async () => {
    const sessionId = "sess_run_row_not_current";
    const world = await sessionOnRealDriver(sessionId);
    const bridge = await readyBridge(world, sessionId);
    bridge.send(
      makeEvent("run.started", {
        eventId: "evt_started_other",
        sessionId,
        runId: "run_someone_else",
        runtimeSequence: bridge.nextSequence(),
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.started")).length >= 1,
      "the stray run.started to commit",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "ready", started_at: null });
  });
});
