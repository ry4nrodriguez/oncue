// A session on the real driver, for tests that speak for the bridge. The
// controller is a scripted `globalThis.fetch`, GitHub is `github-double.ts`,
// and the bridge is a hand-driven socket through the real upgrade path. A
// world seals a real `modal_connection` row, since the alarm path opens it
// from D1. Every binding a test depends on is stated on the object's env,
// which tests share, so no leftover value decides a later test.

import { env, runInDurableObject } from "cloudflare:test";
import type { ArtifactRef, EventType } from "@oncue/protocol";
import {
  type EventOverrides,
  makeEvent,
  TEST_HEAD_SHA,
  TEST_SHA256,
  testModelRecord,
  testOutcomeCounts,
} from "@oncue/protocol/testing";
import { afterEach } from "vitest";
import { deriveKeyring, sealCredential } from "../broker/envelope";
import type { SessionObject } from "../index";
import type { ModalCredential } from "../modal/client";
import { modalTokenContext } from "../modal/envelope-context";
import type { ProvisionPacing } from "../session/object/constants";
import {
  BRIDGE_CREDENTIAL_HEADER,
  type CreateSessionBody,
  type CreateSessionRepository,
} from "../session/session-object";
import { createGitHubDouble, type GitHubDouble, githubTestSettings } from "./github-double";

export const WORLD_TIME = "2026-09-02T00:00:00.000Z";
export const CONTROLLER_ORIGIN = "https://oncue--controller.modal.run";
export const GITHUB_ORIGIN = "https://github.double";
export const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
export const INSTALLATION_ID = 4001;
export const REPOSITORY_ID = 501;
export const OWNER_USER_ID = "user_1";

/** The fixture's session starts with its branch already named. */
export const TASK_BRANCH = "oncue/fix-it-1a2b";

export const REPOSITORY: CreateSessionRepository = {
  installationId: INSTALLATION_ID,
  repositoryId: REPOSITORY_ID,
  fullName: "acme/widgets",
  cloneUrl: `${GITHUB_ORIGIN}/acme/widgets.git`,
  taskBranch: TASK_BRANCH,
  baseSha: BASE_SHA,
  baseBranch: "main",
};

export const MODAL_CREDENTIAL: ModalCredential = {
  tokenId: "ak-fake0001",
  tokenSecret: "as-fake0001",
  environmentName: null,
};

/** Read once, before any test touches an object's env. */
const REAL_KEYRING = env.ONCUE_BROKER_KEYRING as string;

export function stubFor(sessionId: string): DurableObjectStub<SessionObject> {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

export async function seedSessionIndex(sessionId: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, ?, NULL, 'creating', ?, ?)`,
  )
    .bind(sessionId, workspaceId, WORLD_TIME, WORLD_TIME)
    .run();
}

/** A sealed Modal row for the workspace, the way the settings screen writes one, so the alarm can open it. */
export async function seedModalConnection(workspaceId: string): Promise<void> {
  const keyring = await deriveKeyring(REAL_KEYRING, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("the test runner always configures a keyring");
  }
  const connectionId = `mdl_${workspaceId}`;
  const seal = (half: "token_id" | "token_secret", value: string) =>
    sealCredential(keyring.keyring, modalTokenContext(connectionId, workspaceId, half), value);
  const ownerId = `usr_owner_${workspaceId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT (id) DO NOTHING",
    ).bind(ownerId, WORLD_TIME, WORLD_TIME),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT (id) DO NOTHING",
    ).bind(workspaceId, ownerId, WORLD_TIME, WORLD_TIME),
    env.DB.prepare(
      `INSERT INTO modal_connection (
         connection_id, workspace_id, token_id_reference, token_secret_reference,
         modal_workspace_name, environment_name, status, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme-workspace', NULL, 'active', ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         token_id_reference = excluded.token_id_reference,
         token_secret_reference = excluded.token_secret_reference,
         status = 'active'`,
    ).bind(
      connectionId,
      workspaceId,
      await seal("token_id", MODAL_CREDENTIAL.tokenId),
      await seal("token_secret", MODAL_CREDENTIAL.tokenSecret),
      WORLD_TIME,
      WORLD_TIME,
      WORLD_TIME,
    ),
  ]);
}

/**
 * The active connection `testModelRecord()` names (`conn_1`), so a resume
 * finds it. The credential is a placeholder that nothing opens.
 */
export async function seedModelConnection(
  workspaceId: string,
  status: "active" | "invalid" = "active",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference, status, created_at, updated_at
     ) VALUES ('conn_1', ?, 'anthropic', 'api_key', 'sealed-placeholder', ?, ?, ?)
     ON CONFLICT (connection_id) DO UPDATE SET workspace_id = excluded.workspace_id, status = excluded.status`,
  )
    .bind(workspaceId, status, WORLD_TIME, WORLD_TIME)
    .run();
}

export function createBody(
  sessionId: string,
  overrides: Partial<CreateSessionBody> = {},
): CreateSessionBody {
  return {
    sessionId,
    workspaceId: "ws_1",
    taskId: null,
    ownerUserId: OWNER_USER_ID,
    title: "Fix the failing test",
    commandId: "cmd_create_1",
    issuedAt: WORLD_TIME,
    instruction: { messageId: "msg_1", text: "Fix the bug", attachments: [] },
    model: testModelRecord(),
    continuesRunId: null,
    mintedRunId: "run_1",
    scriptName: "seven-event",
    framePacingMs: null,
    taskBranch: null,
    baseCommitSha: null,
    repository: null,
    modalCredential: MODAL_CREDENTIAL,
    redactionSecrets: [],
    driverFailures: {},
    ...overrides,
  };
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets anything already in flight land, so a "nothing more arrives" assertion means something. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface ControllerCall {
  readonly operation: string;
  readonly body: Record<string, unknown>;
  readonly atMs: number;
}

/** Answers one controller call, or `undefined` to take the world's default answer. */
export type ControllerScript = (
  operation: string,
  body: Record<string, unknown>,
) => Response | Promise<Response> | undefined;

export interface WorldOptions {
  readonly workspaceId?: string;
  readonly repository?: CreateSessionRepository | null;
  readonly githubConfigured?: boolean;
  /** Whether the workspace has Modal connected in D1; the alarm path opens it from there. */
  readonly modalConnected?: boolean;
  readonly envOverrides?: Record<string, string>;
  readonly controller?: ControllerScript;
  readonly body?: Partial<CreateSessionBody>;
  readonly pacing?: ProvisionPacing;
  /** False for a test of a provisioning that may never attach; it waits for what it expects itself. */
  readonly awaitAttachment?: boolean;
}

/**
 * The provisioning pacing worlds run with: every wait a millisecond, and one
 * stop of a failed generation, so a test counts exactly the calls it caused.
 */
export const TEST_PACING: ProvisionPacing = {
  prepareBudgetMs: 60_000,
  minPreparePollMs: 1,
  createRetryDelaysMs: [1, 1],
  failedStopDelaysMs: [0],
  createNotAfterMs: 0,
  createLandingGraceMs: 0,
};

export interface SessionWorld {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly stub: DurableObjectStub<SessionObject>;
  readonly github: GitHubDouble;
  /** The bootstrap credential the driver was handed, per generation: the only place it is ever in the clear. */
  readonly credentials: Map<number, string>;
  readonly controllerCalls: ControllerCall[];
  setController(script: ControllerScript | null): void;
}

let restoreFetch: (() => void) | null = null;
const socketsToClose: WebSocket[] = [];
let connections = 0;

/** Registers the cleanup every world and socket below relies on. Call once at the top of a test file. */
export function registerSessionWorlds(): void {
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    for (const ws of socketsToClose.splice(0)) {
      ws.close();
    }
  });
}

/** The controller's answer to `prepareImage` for a workspace whose image is already built. */
export function preparedImage(): Response {
  return Response.json({ kind: "ok", value: { state: "ready", imageReference: "im-test" } });
}

function defaultAnswer(operation: string): Response {
  if (operation === "prepareImage") {
    return preparedImage();
  }
  if (operation === "getOutput") {
    return Response.json(
      { kind: "error", category: "not_found", message: "gone", retryable: false },
      { status: 404 },
    );
  }
  if (operation === "getStatus") {
    return Response.json({ kind: "ok", value: "active" });
  }
  return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } });
}

export function githubDouble(): GitHubDouble {
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
 * Creates a session on the real driver and waits for its attachment. The
 * controller answers every lifecycle call and refuses `getOutput`, which ends
 * the output relay at its first poll, unless the world's script says otherwise.
 */
export async function sessionOnRealDriver(
  sessionId: string,
  options: WorldOptions = {},
): Promise<SessionWorld> {
  const workspaceId = options.workspaceId ?? "ws_1";
  await seedSessionIndex(sessionId, workspaceId);
  // D1 rows outlive a test, so "not connected" is written rather than assumed.
  if (options.modalConnected === false) {
    await env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
  } else {
    await seedModalConnection(workspaceId);
    await seedModelConnection(workspaceId);
  }
  const stub = stubFor(sessionId);
  const github = githubDouble();
  const credentials = new Map<number, string>();
  const controllerCalls: ControllerCall[] = [];
  let script: ControllerScript | null = options.controller ?? null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GITHUB_ORIGIN)) {
      return github.fetchImpl(input as string, init);
    }
    const operation = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    controllerCalls.push({ operation, body, atMs: Date.now() });
    if (operation === "create") {
      credentials.set(Number(body.generation), String(body.bootstrapCredential));
    }
    return (await script?.(operation, body)) ?? defaultAnswer(operation);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = realFetch;
  };
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
      ONCUE_IDLE_ALARM_SECONDS: "",
      ONCUE_CEILING_SECONDS: "",
      ...options.envOverrides,
    });
    instance.provisionPacing = options.pacing ?? TEST_PACING;
    await instance.createSession(
      createBody(sessionId, {
        workspaceId,
        repository: options.repository ?? null,
        ...options.body,
      }),
    );
  });
  if (options.awaitAttachment !== false) {
    await waitFor(async () => (await eventTypes(stub)).includes("sandbox.attached"), "attachment");
    if (!credentials.has(1)) {
      throw new Error("the driver was never asked to create a sandbox");
    }
  }
  return {
    sessionId,
    workspaceId,
    stub,
    github,
    credentials,
    controllerCalls,
    setController(next) {
      script = next;
    },
  };
}

/** Changes a setting on the object's env mid-test; every value is stated, never inherited. */
export async function setObjectEnv(
  world: SessionWorld,
  overrides: Record<string, string>,
): Promise<void> {
  await runInDurableObject(world.stub, (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, overrides);
  });
}

export const REAL_KEYRING_VALUE = REAL_KEYRING;

export interface TestBridge {
  readonly generation: number;
  readonly client: WebSocket;
  /** Every frame the object sent, parsed, in arrival order. */
  readonly received: Array<Record<string, unknown>>;
  hello(): Promise<void>;
  send(frame: unknown): void;
  /** A sandbox-origin event for this generation, numbered with the next runtime sequence. */
  event<T extends EventType>(type: T, overrides?: EventOverrides<T>): Record<string, unknown>;
  ack(ref: { commandId: string } | { grantId: string }, outcome?: AckOutcome): void;
  frames(type: string): Array<Record<string, unknown>>;
  grants(kind: string): Array<Record<string, unknown>>;
  commands(type: string): Array<Record<string, unknown>>;
  close(): void;
}

export type AckOutcome = { kind: "accepted" } | { kind: "rejected"; reason: string };

export interface BridgeOptions {
  /** Defaults to the next sequence the object expects for the generation, so a reconnect continues where the last socket left off. */
  readonly sequenceStart?: number;
  /** A well-behaved bridge closes its end once it has shut the runtime down; false leaves it listening. */
  readonly closeOnShutdown?: boolean;
}

async function nextRuntimeSequence(stub: DurableObjectStub<SessionObject>): Promise<number> {
  const last = await runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ last: number | null }>("SELECT last_runtime_sequence AS last FROM session")
        .one().last,
  );
  return last === null ? 0 : last + 1;
}

export async function connectBridge(
  world: SessionWorld,
  generation = 1,
  options: BridgeOptions = {},
): Promise<TestBridge> {
  const credential = world.credentials.get(generation);
  if (credential === undefined) {
    throw new Error(`no bootstrap credential was minted for generation ${generation}`);
  }
  const response = await world.stub.fetch(
    new Request(`https://do/ws/bridge/${world.sessionId}/${generation}`, {
      headers: { Upgrade: "websocket", [BRIDGE_CREDENTIAL_HEADER]: credential },
    }),
  );
  if (response.status !== 101) {
    throw new Error(`the bridge upgrade answered ${response.status}`);
  }
  const client = response.webSocket;
  if (client === null || client === undefined) {
    throw new Error("expected a webSocket on the upgrade response");
  }
  const received: Array<Record<string, unknown>> = [];
  client.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    received.push(frame);
    const command = frame.command as { type?: string } | undefined;
    if (options.closeOnShutdown !== false && command?.type === "runtime.shutdown") {
      client.close();
    }
  });
  client.accept();
  socketsToClose.push(client);
  let sequence = options.sequenceStart ?? (await nextRuntimeSequence(world.stub));
  let eventCounter = 0;
  // Event ids are unique per socket, so a reconnecting bridge's frames are
  // not refused as duplicates of the first socket's.
  connections += 1;
  const eventPrefix = `evt_${world.sessionId}_g${generation}_c${connections}`;
  const frames = (type: string) => received.filter((frame) => frame.type === type);
  return {
    generation,
    client,
    received,
    async hello() {
      client.send(
        JSON.stringify({
          type: "bridge.hello",
          protocolVersion: 1,
          sessionId: world.sessionId,
          sandboxGeneration: generation,
        }),
      );
      await waitFor(
        () =>
          received.some(
            (frame) => frame.type === "bridge.welcome" && frame.sandboxGeneration === generation,
          ),
        "welcome",
      );
    },
    send(frame) {
      client.send(JSON.stringify(frame));
    },
    event<T extends EventType>(type: T, overrides: EventOverrides<T> = {} as EventOverrides<T>) {
      eventCounter += 1;
      const runtimeSequence = sequence;
      sequence += 1;
      return makeEvent(type, {
        eventId: `${eventPrefix}_${eventCounter}`,
        sessionId: world.sessionId,
        sandboxGeneration: generation,
        runtimeSequence,
        ...overrides,
      } as EventOverrides<T>) as unknown as Record<string, unknown>;
    },
    ack(ref, outcome = { kind: "accepted" }) {
      client.send(
        JSON.stringify({
          type: "bridge.ack",
          sessionId: world.sessionId,
          sandboxGeneration: generation,
          ref,
          outcome,
        }),
      );
    },
    frames,
    grants(kind) {
      return frames("bridge.grant").filter((frame) => frame.kind === kind);
    },
    commands(type) {
      return frames("bridge.command").filter(
        (frame) => (frame.command as { type: string }).type === type,
      );
    },
    close() {
      client.close();
    },
  };
}

/**
 * The object's allowance for `callId` to start a subagent, as an approval
 * mode or a card's answer leaves it: an approved `start_subagent` approval of
 * the run on the generation. Written straight to the table, for tests about
 * what follows the allowance rather than the ask itself.
 */
export async function allowSubagentStart(
  world: SessionWorld,
  runId: string,
  callId: string,
  generation = 1,
): Promise<void> {
  await runInDurableObject(world.stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO approval (id, run_id, state, title, intended_action, category, risk, resource, requested_scope, tool_call_id, requested_generation, requested_at, expires_at, decision)
         VALUES (?, ?, 'approved', 'Start the explore subagent', 'Start a subagent', 'start_subagent', 'low', 'explore subagent', 'Starting a subagent', ?, ?, ?, ?, 'approved')`,
      `apr_start_${callId}`,
      runId,
      callId,
      generation,
      WORLD_TIME,
      WORLD_TIME,
    );
  });
}

/** Brings a bridge to the point where commands flow: negotiated, granted, and `runtime.ready` committed. */
export async function readyBridge(
  world: SessionWorld,
  generation = 1,
  options: BridgeOptions = {},
): Promise<TestBridge> {
  const bridge = await connectBridge(world, generation, options);
  await bridge.hello();
  await waitFor(() => bridge.grants("model").length >= 1, "the model grant");
  bridge.send(bridge.event("runtime.ready"));
  await waitFor(() => bridge.commands("run.start").length >= 1, "the queued run.start");
  return bridge;
}

/** Plays the run to its end on this bridge, so the generation is quiet: started, one assistant message, completed. */
export async function finishRun(
  world: SessionWorld,
  bridge: TestBridge,
  runId = "run_1",
): Promise<void> {
  bridge.send(bridge.event("run.started", { runId }));
  bridge.send(
    bridge.event("message.completed", {
      runId,
      payload: {
        messageId: `msg_assistant_${runId}`,
        role: "assistant",
        parts: [
          { type: "reasoning_summary", text: "Comparing the two operands." },
          { type: "text", text: "I changed the assertion and the test passes." },
        ],
      },
    }),
  );
  bridge.send(bridge.event("run.completed_with_warnings", { runId }));
  await waitFor(
    async () => (await runRowOf(world.stub, runId)).state === "completed_with_warnings",
    "the run to end",
  );
}

export interface ClientSocket {
  /** Sends the command through the object's own handler and returns once it has been processed. */
  send(command: Record<string, unknown>): Promise<void>;
  /** Hands the object every command in the same tick, so their handlers interleave. */
  sendTogether(commands: readonly Record<string, unknown>[]): Promise<void>;
  /** Sends the command on the wire without waiting, the way a browser does. */
  push(command: Record<string, unknown>): void;
}

export async function openClient(
  world: SessionWorld,
  userId = OWNER_USER_ID,
): Promise<ClientSocket> {
  const response = await world.stub.fetch(
    new Request(`https://do/ws/sessions/${world.sessionId}/client?after=0`, {
      headers: { Upgrade: "websocket", "x-oncue-user-id": userId },
    }),
  );
  if (response.status !== 101) {
    throw new Error(`the client upgrade answered ${response.status}`);
  }
  const browserEnd = response.webSocket;
  if (browserEnd === null || browserEnd === undefined) {
    throw new Error("the upgrade carried no socket");
  }
  browserEnd.accept();
  socketsToClose.push(browserEnd);
  let serverEnd: WebSocket | undefined;
  await waitFor(async () => {
    serverEnd = await runInDurableObject(world.stub, (_instance, state) =>
      state.getWebSockets("client").at(-1),
    );
    return serverEnd !== undefined;
  }, "the client socket");
  return {
    async send(command) {
      await runInDurableObject(world.stub, (instance) =>
        instance.webSocketMessage(
          serverEnd as WebSocket,
          JSON.stringify({ type: "command", command }),
        ),
      );
    },
    async sendTogether(commands) {
      await runInDurableObject(world.stub, (instance) =>
        Promise.all(
          commands.map((command) =>
            instance.webSocketMessage(
              serverEnd as WebSocket,
              JSON.stringify({ type: "command", command }),
            ),
          ),
        ),
      );
    },
    push(command) {
      browserEnd.send(JSON.stringify({ type: "command", command }));
    },
  };
}

export function runStartCommand(commandId: string, messageId: string, text: string) {
  return {
    type: "run.start",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: {
      instruction: { messageId, text, attachments: [] },
      model: testModelRecord(),
      continuesRunId: null,
    },
  };
}

export function followUpCommand(
  commandId: string,
  messageId: string,
  runId: string,
  runState: string,
  delivery: "steer_current_run" | "run_next" = "steer_current_run",
) {
  return {
    type: "run.follow_up",
    commandId,
    runId,
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: runState },
    payload: { messageId, text: `Message ${messageId}`, attachments: [], delivery },
  };
}

// Reads of the object's own tables.

export async function eventTypes(stub: DurableObjectStub<SessionObject>): Promise<string[]> {
  const rows = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ event_type: string }>(
      "SELECT event_type FROM event ORDER BY session_sequence ASC",
    ),
  ]);
  return rows.map((row) => row.event_type);
}

export async function eventsOfType(
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

export async function eventCount(stub: DurableObjectStub<SessionObject>): Promise<number> {
  return (await eventTypes(stub)).length;
}

export interface DispatchRowRecord extends Record<string, string | number | null> {
  intent_id: string;
  generation: number;
  kind: string;
  state: string;
  attempts: number;
}

export async function dispatchRows(
  stub: DurableObjectStub<SessionObject>,
): Promise<DispatchRowRecord[]> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<DispatchRowRecord>(
      "SELECT intent_id, generation, kind, state, attempts FROM bridge_dispatch ORDER BY created_at ASC, rowid ASC",
    ),
  ]);
}

export interface RunRowRecord extends Record<string, string | number | null> {
  id: string;
  state: string;
  outcome: string | null;
  sandbox_generation: number;
}

export async function runRowOf(
  stub: DurableObjectStub<SessionObject>,
  runId: string,
): Promise<RunRowRecord> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<RunRowRecord>(
        "SELECT id, state, outcome, sandbox_generation FROM run WHERE id = ?",
        runId,
      )
      .one(),
  );
}

export async function runRows(stub: DurableObjectStub<SessionObject>): Promise<RunRowRecord[]> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<RunRowRecord>(
      "SELECT id, state, outcome, sandbox_generation FROM run ORDER BY queued_at ASC, rowid ASC",
    ),
  ]);
}

export async function attachmentStates(
  stub: DurableObjectStub<SessionObject>,
): Promise<Array<{ generation: number; state: string; provider: string }>> {
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ generation: number; state: string; provider: string }>(
      "SELECT generation, state, provider FROM sandbox_attachment ORDER BY generation ASC",
    ),
  ]);
}

export interface StopRowRecord extends Record<string, string | number | null> {
  generation: number;
  cause: string;
  step: string;
  due_at_ms: number | null;
  attempts: number;
  checkpoint_json: string | null;
  warning: string | null;
  interrupted_run_id: string | null;
}

export async function stopRow(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
): Promise<StopRowRecord | null> {
  const rows = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<StopRowRecord>(
      "SELECT generation, cause, step, due_at_ms, attempts, checkpoint_json, warning, interrupted_run_id FROM sandbox_stop WHERE generation = ?",
      generation,
    ),
  ]);
  return rows[0] ?? null;
}

export async function probeRow(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
): Promise<{ generation: number; due_at_ms: number; attempts: number } | null> {
  const rows = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ generation: number; due_at_ms: number; attempts: number }>(
      "SELECT generation, due_at_ms, attempts FROM sandbox_probe WHERE generation = ?",
      generation,
    ),
  ]);
  return rows[0] ?? null;
}

export async function sessionGeneration(stub: DurableObjectStub<SessionObject>): Promise<number> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ sandbox_generation: number }>("SELECT sandbox_generation FROM session")
        .one().sandbox_generation,
  );
}

/** The sidebar's "Needs you" fact as D1 holds it, once the outbox has drained. */
export async function waitingForUserInD1(sessionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT waiting_for_user AS waiting FROM session_index WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<{ waiting: number }>();
  return row?.waiting === 1;
}

/** The current run and its state as D1 holds them, for the sidebar's status dot. */
export async function currentRunInD1(
  sessionId: string,
): Promise<{ runId: string | null; state: string | null }> {
  const row = await env.DB.prepare(
    "SELECT current_run_id AS run_id, current_run_state AS state FROM session_index WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<{ run_id: string | null; state: string | null }>();
  return { runId: row?.run_id ?? null, state: row?.state ?? null };
}

export async function endedGenerationInD1(sessionId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT ended_sandbox_generation AS ended FROM session_index WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<{ ended: number | null }>();
  return row?.ended ?? null;
}

// Time passes by aging the facts the planner reads, never by sleeping.

export async function ageEvents(
  stub: DurableObjectStub<SessionObject>,
  byMs: number,
): Promise<void> {
  const at = new Date(Date.now() - byMs).toISOString();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE event SET committed_at = ?", at);
  });
}

export async function ageStop(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE sandbox_stop SET due_at_ms = ? WHERE generation = ?",
      Date.now() - 1,
      generation,
    );
  });
}

export async function ageProbe(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE sandbox_probe SET due_at_ms = ? WHERE generation = ?",
      Date.now() - 1,
      generation,
    );
  });
}

export async function setAttachmentExpiry(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
  expiresAtMs: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE sandbox_attachment SET expires_at = ? WHERE generation = ?",
      new Date(expiresAtMs).toISOString(),
      generation,
    );
  });
}

export async function fireAlarm(stub: DurableObjectStub<SessionObject>): Promise<void> {
  await runInDurableObject(stub, (instance) => instance.alarm());
}

/**
 * Lets the runtime deliver the alarm itself rather than calling `alarm()`
 * directly. The runtime never overlaps two alarm deliveries, so a stop this
 * alarm drives is not raced by the one `rearm` arms for a runnable step.
 */
export async function armAlarmNow(stub: DurableObjectStub<SessionObject>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
}

export async function storedAlarm(stub: DurableObjectStub<SessionObject>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** Brings a repository session to a quiet, checkpointable state: bridge ready, run ended, git token already revoked by `repository.status`. */
export async function quietRepositoryWorld(
  sessionId: string,
  options: WorldOptions = {},
  bridgeOptions: BridgeOptions = { closeOnShutdown: true },
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY, ...options });
  const bridge = await readyBridge(world, 1, bridgeOptions);
  const git = bridge.grants("git")[0] as Record<string, unknown>;
  const model = bridge.grants("model")[0] as Record<string, unknown>;
  bridge.ack({ grantId: String(git.grantId) });
  bridge.ack({ grantId: String(model.grantId) });
  bridge.send(bridge.event("repository.status", { runId: "run_1" }));
  await waitFor(
    () => world.github.calls.some((call) => call.tokenRevoked === true),
    "the clone token's revocation",
  );
  await finishRun(world, bridge);
  return { world, bridge };
}

/** Drives an idle stop to the point where the object waits for the bridge's checkpoint report. */
export async function idleStopIssued(
  world: SessionWorld,
  bridge: TestBridge,
): Promise<{ push: Record<string, unknown>; checkpoint: Record<string, unknown> }> {
  await ageEvents(world.stub, 30 * 60_000);
  await fireAlarm(world.stub);
  await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");
  return {
    push: bridge.grants("push")[0] as Record<string, unknown>,
    checkpoint: bridge.commands("checkpoint.create")[0] as Record<string, unknown>,
  };
}

/** The bridge's two checkpoint reports, as the real bridge sends them, with the ids and shas given. */
export function reportCheckpoint(
  bridge: TestBridge,
  options: {
    readonly checkpointId?: string;
    readonly kind?: "branch_push" | "local_commit" | "patch_bundle";
    readonly headSha?: string | null;
    readonly bundle?: Record<string, unknown> | null;
    readonly reason?: "idle" | "lifetime_ceiling";
    readonly runId?: string;
  } = {},
): void {
  const checkpointId = options.checkpointId ?? "ckpt_1";
  const kind = options.kind ?? "branch_push";
  const headSha =
    options.headSha === undefined ? "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807" : options.headSha;
  const bundle = (options.bundle ?? null) as ArtifactRef | null;
  const reason = options.reason ?? "idle";
  bridge.send(
    bridge.event("repository.checkpointed", {
      runId: options.runId ?? "run_1",
      payload: {
        checkpointId,
        kind,
        headSha,
        bundle,
        reason: reason === "idle" ? "idle_shutdown" : "pre_replacement",
      },
    }),
  );
  bridge.send(
    bridge.event("sandbox.checkpointed", {
      payload: { checkpointId, kind, headSha, bundle, reason, durationMs: 1200 },
    }),
  );
}

export interface CheckRecordOptions {
  readonly runId?: string;
  readonly checkId?: string;
  readonly attempt?: number;
  readonly classification?: "required" | "recommended" | "informational";
  readonly revision?: string;
  readonly result?: "passed" | "failed" | "skipped" | "inconclusive";
  readonly skipReason?: "user_requested" | null;
  /** The log artifact the result cites. `committed` completes its upload; `declared` leaves it uploading; null cites nothing. */
  readonly evidence?: "committed" | "declared" | null;
}

/**
 * One check's records, as the real bridge sends them: `verification.started`,
 * the log's `artifact.uploading` (completed through the object's own upload
 * path unless told otherwise), then `verification.result` citing it.
 */
export async function recordCheck(
  world: SessionWorld,
  bridge: TestBridge,
  options: CheckRecordOptions = {},
): Promise<void> {
  const runId = options.runId ?? "run_1";
  const checkId = options.checkId ?? "chk_test";
  const attempt = options.attempt ?? 1;
  const evidence = options.evidence === undefined ? "committed" : options.evidence;
  const artifactId = `art_${checkId}_${attempt}`;
  bridge.send(
    bridge.event("verification.started", {
      runId,
      payload: {
        checkId,
        attempt,
        classification: options.classification ?? "required",
        revision: options.revision ?? TEST_HEAD_SHA,
      },
    }),
  );
  const refs: ArtifactRef[] = [];
  if (evidence !== null) {
    bridge.send(
      bridge.event("artifact.uploading", {
        runId,
        payload: {
          artifactId,
          kind: "log",
          contentType: "text/plain",
          declaredBytes: 1024,
          producer: "verification",
        },
      }),
    );
    await waitFor(
      () => bridge.grants("upload").some((grant) => grant.artifactId === artifactId),
      `the upload grant for ${artifactId}`,
    );
    if (evidence === "committed") {
      await runInDurableObject(world.stub, (instance) =>
        instance.completeArtifact({ artifactId, byteSize: 1024, sha256: TEST_SHA256 }),
      );
    }
    refs.push({
      artifactId,
      kind: "log",
      contentType: "text/plain",
      byteSize: 1024,
      label: "Log",
    } as ArtifactRef);
  }
  const result = options.result ?? "passed";
  bridge.send(
    bridge.event("verification.result", {
      runId,
      payload: {
        checkId,
        attempt,
        result,
        skipReason: options.skipReason ?? null,
        exitCode: result === "passed" ? 0 : 1,
        evidence: refs,
      },
    }),
  );
}

/** The bridge's rollup, `verification.completed`, with the counts it claims. */
export function completeVerification(
  bridge: TestBridge,
  options: {
    readonly runId?: string;
    readonly requiredTotal?: number;
    readonly userSkipped?: readonly string[];
  } = {},
): void {
  const userSkipped = options.userSkipped ?? [];
  bridge.send(
    bridge.event("verification.completed", {
      runId: options.runId ?? "run_1",
      payload: {
        proposedOutcome: userSkipped.length === 0 ? "verified" : "completed_with_warnings",
        required: testOutcomeCounts({
          total: options.requiredTotal ?? 1,
          passed: options.requiredTotal ?? 1,
        }),
        userSkipped: [...userSkipped],
      },
    }),
  );
}
