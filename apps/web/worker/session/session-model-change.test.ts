// Changing a session's model (record 15), through the object: the owner's
// `run.start` names another model, the object checks it against its own rows,
// and the changed run starts in the sandbox attached when its harness can take
// the model, or on a new generation when it cannot or none is attached. The
// bridge is a hand-driven socket and the controller a scripted fetch.

import { env, runInDurableObject } from "cloudflare:test";
import type { ModelRecord } from "@oncue/protocol";
import { describe, expect, it, vi } from "vitest";
import { deriveKeyring } from "../broker/envelope";
import { checkForForward } from "../broker/tokens";
import {
  attachmentStates,
  connectBridge,
  dispatchRows,
  eventsOfType,
  eventTypes,
  finishRun,
  idleStopIssued,
  MODAL_CREDENTIAL,
  OWNER_USER_ID,
  openClient,
  REPOSITORY,
  readyBridge,
  registerSessionWorlds,
  reportCheckpoint,
  runRowOf,
  runRows,
  type SessionWorld,
  sessionOnRealDriver,
  setObjectEnv,
  settle,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import type { SessionHost } from "./object/host";
import { decideRunModel } from "./object/model-change";
import type { SessionRow } from "./object/types";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

/** The session's first model: a catalog row on the workspace's Anthropic key (`conn_1`). */
const SONNET: ModelRecord = {
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  modelConnectionId: "conn_1",
  authenticationType: "api_key",
  contextWindow: 1_000_000,
  effort: "high",
};

/** What a browser sends for the change; the object believes only the two ids. */
const SOL_AS_SENT = {
  provider: "openai",
  modelId: "gpt-6-sol",
  modelConnectionId: "conn_openai",
  authenticationType: "subscription",
  contextWindow: 7,
  effort: "low",
};

const SOL_AS_STORED: ModelRecord = {
  provider: "openai",
  modelId: "gpt-6-sol",
  modelConnectionId: "conn_openai",
  authenticationType: "api_key",
  contextWindow: 1_050_000,
  effort: "low",
};

async function seedConnection(
  connectionId: string,
  workspaceId: string,
  provider: "anthropic" | "openai",
  status: "active" | "invalid" = "active",
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT (id) DO NOTHING",
    ).bind(`usr_owner_${workspaceId}`, WORLD_TIME, WORLD_TIME),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT (id) DO NOTHING",
    ).bind(workspaceId, `usr_owner_${workspaceId}`, WORLD_TIME, WORLD_TIME),
    env.DB.prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'api_key', 'sealed-placeholder', ?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET workspace_id = excluded.workspace_id, status = excluded.status`,
    ).bind(connectionId, workspaceId, provider, status, WORLD_TIME, WORLD_TIME),
  ]);
}

interface Options {
  /** What the bridge says it can do; the real bridge names `model_switch`. */
  readonly capabilities?: readonly string[];
  readonly repository?: boolean;
  readonly openaiKey?: "active" | "invalid";
}

/** A session on Sonnet whose bridge is up, with an OpenAI key beside the Anthropic one. */
async function sessionOnSonnet(
  sessionId: string,
  options: Options = {},
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId, {
    body: { model: SONNET },
    repository: options.repository === true ? REPOSITORY : null,
    // Stated, since tests share the env and one below pins the model.
    envOverrides: { ONCUE_ENV: "local", ONCUE_MODEL_ALLOWLIST: "", ONCUE_RUNTIME_ALLOWLIST: "" },
  });
  await seedConnection("conn_openai", world.workspaceId, "openai", options.openaiKey ?? "active");
  const bridge = await connectBridge(world);
  await bridge.hello();
  bridge.send(
    bridge.event("runtime.connected", {
      payload: { capabilities: [...(options.capabilities ?? ["model_switch"])] },
    }),
  );
  await waitFor(() => bridge.grants("model").length >= 1, "the model grant");
  bridge.send(bridge.event("runtime.ready"));
  await waitFor(() => bridge.commands("run.start").length >= 1, "the queued run.start");
  return { world, bridge };
}

function changeCommand(
  commandId: string,
  overrides: {
    readonly model?: Record<string, unknown>;
    readonly continuesRunId?: string | null;
    readonly checksOnly?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    type: "run.start",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: {
      instruction: { messageId: `msg_${commandId}`, text: "Carry on.", attachments: [] },
      model: overrides.model ?? SOL_AS_SENT,
      continuesRunId: overrides.continuesRunId === undefined ? "run_1" : overrides.continuesRunId,
      ...(overrides.checksOnly === true ? { checksOnly: true } : {}),
    },
  };
}

async function queuedRuns(world: SessionWorld): Promise<Array<Record<string, unknown>>> {
  return (await eventsOfType(world.stub, "run.queued")).map(
    (event) => event.payload as Record<string, unknown>,
  );
}

async function rejections(world: SessionWorld): Promise<Array<Record<string, unknown>>> {
  return (await eventsOfType(world.stub, "command.rejected")).map(
    (event) => event.payload as Record<string, unknown>,
  );
}

async function indexedConnection(sessionId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT model_connection_id AS id FROM session_index WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<{ id: string | null }>();
  return row?.id ?? null;
}

describe("a model change in the sandbox now attached", () => {
  it("lists every catalog model on the generation's first grant, so the harness starts ready for a change", async () => {
    const { bridge } = await sessionOnSonnet("sess_change_catalog");
    const catalog = (bridge.grants("model")[0] as { catalog: Array<Record<string, unknown>> })
      .catalog;
    expect(catalog.map((entry) => `${entry.provider}/${entry.modelId}`)).toEqual(
      expect.arrayContaining(["anthropic/claude-sonnet-5", "openai/gpt-6-sol"]),
    );
    expect(catalog.find((entry) => entry.modelId === "gpt-6-sol")).toMatchObject({
      spec: { name: "GPT-6 Sol", contextWindow: 1_050_000, imageInput: true },
    });
    // The catalog's facts, and nothing that opens a key.
    expect(JSON.stringify(catalog)).not.toMatch(/token|credential|sealed/);
  });

  it("starts the next run on the other model: a grant for it first, then the start, with the object's own record", async () => {
    const sessionId = "sess_change_live";
    const { world, bridge } = await sessionOnSonnet(sessionId);
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitFor(() => bridge.commands("run.start").length >= 2, "the changed run's start");

    const queued = await queuedRuns(world);
    expect(queued).toHaveLength(2);
    // Earlier runs keep their model records.
    expect(queued[0]).toMatchObject({ trigger: "initial", model: SONNET });
    expect(queued[1]).toMatchObject({
      trigger: "model_change",
      continuesRunId: "run_1",
      // Built from the connection row and the catalog, not from what was sent.
      model: SOL_AS_STORED,
    });

    const grants = bridge.grants("model");
    expect(grants).toHaveLength(2);
    expect(grants[1]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-6-sol" },
      effort: "low",
      modelSpec: { name: "GPT-6 Sol" },
    });
    const start = bridge.commands("run.start")[1] as Record<string, unknown>;
    expect(start).toMatchObject({ command: { payload: { model: SOL_AS_STORED } } });
    // The grant goes first on the socket, so the bridge holds the model when the start arrives.
    expect(bridge.received.indexOf(grants[1] as Record<string, unknown>)).toBeLessThan(
      bridge.received.indexOf(start),
    );
    // The token is for the other key and the other model, in this session and generation.
    const keyring = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "token");
    if (keyring.kind !== "ok") throw new Error("test keyring did not derive");
    const token = String((grants[1] as Record<string, unknown>).token);
    expect(await checkForForward(keyring.keyring, token, Date.now())).toMatchObject({
      kind: "valid",
      claims: {
        sessionId,
        sandboxGeneration: 1,
        workspaceId: world.workspaceId,
        connectionId: "conn_openai",
        modelId: "gpt-6-sol",
        effort: "low",
      },
    });
    // The sandbox is kept.
    expect(await eventTypes(world.stub)).not.toContain("sandbox.stopped");
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toEqual([]);
    // Settings counts sessions per key from the index row, which follows the latest run.
    await waitFor(
      async () => (await indexedConnection(sessionId)) === "conn_openai",
      "the index row to name the other key",
    );
  });

  it("changes to another model on the same key, and back, each a run of its own", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_same_key");
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(
      changeCommand("cmd_opus", {
        model: { ...SONNET, modelId: "claude-opus-5-5", effort: "medium" },
      }),
    );
    await waitFor(() => bridge.commands("run.start").length >= 2, "the run on Opus");
    const second = (await runRows(world.stub))[1]?.id as string;
    await finishRun(world, bridge, second);

    await client.send(changeCommand("cmd_back", { model: SONNET, continuesRunId: second }));
    await waitFor(() => bridge.commands("run.start").length >= 3, "the run back on Sonnet");
    expect((await queuedRuns(world)).map((run) => (run.model as ModelRecord).modelId)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]);
    expect(
      bridge.grants("model").map((grant) => (grant.model as { modelId: string }).modelId),
    ).toEqual(["claude-sonnet-5", "claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("a start on the same model at another effort is a follow-up, with a grant at that effort", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_effort_only");
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_effort", { model: { ...SONNET, effort: "low" } }));
    await waitFor(() => bridge.commands("run.start").length >= 2, "the next run");
    expect((await queuedRuns(world))[1]).toMatchObject({ trigger: "follow_up" });
    expect(bridge.grants("model")[1]).toMatchObject({
      model: { modelId: "claude-sonnet-5" },
      effort: "low",
    });
  });

  it("fails the changed run when the bridge refuses the grant, and the run it replaced keeps its record", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_grant_refused");
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitFor(() => bridge.grants("model").length >= 2, "the grant for the other model");
    bridge.ack(
      { grantId: String((bridge.grants("model")[1] as Record<string, unknown>).grantId) },
      { kind: "rejected", reason: "unsupported" },
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "run.failed",
    );
    const second = (await runRows(world.stub))[1];
    expect(second).toMatchObject({ state: "failed" });
    expect((await eventsOfType(world.stub, "run.failed"))[0]).toMatchObject({
      runId: second?.id,
      payload: { stage: "provisioning", error: { category: "model_grant_rejected" } },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "completed_with_warnings" });
  });
});

describe("a model change in the sandbox now attached: what the object reads", () => {
  it("treats a session stored before harnesses were recorded as OpenCode", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_no_runtime_row");
    await finishRun(world, bridge);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM session_runtime");
    });
    const client = await openClient(world);
    await client.send(changeCommand("cmd_change"));
    await waitFor(() => bridge.commands("run.start").length >= 2, "the changed run's start");
    expect(bridge.grants("model")[1]).toMatchObject({ model: { modelId: "gpt-6-sol" } });
    expect(await eventTypes(world.stub)).not.toContain("sandbox.stopped");
  });

  it("before the generation's first grant, sends nothing extra: the bridge's hello grants the changed model", async () => {
    // The first run was stopped before any bridge connected, so no harness has started.
    const world = await sessionOnRealDriver("sess_change_before_grant", {
      body: { model: SONNET },
      envOverrides: { ONCUE_ENV: "local", ONCUE_MODEL_ALLOWLIST: "", ONCUE_RUNTIME_ALLOWLIST: "" },
    });
    await seedConnection("conn_openai", world.workspaceId, "openai");
    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel",
      runId: "run_1",
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: (await runRowOf(world.stub, "run_1")).state },
      payload: { reason: null, checkpointFirst: false },
    });
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "cancelled",
      "the cancel",
    );

    await client.send(changeCommand("cmd_change"));
    await waitFor(async () => (await queuedRuns(world)).length >= 2, "the changed run");
    expect(await eventTypes(world.stub)).not.toContain("sandbox.stopped");

    const bridge = await connectBridge(world);
    await bridge.hello();
    await waitFor(() => bridge.grants("model").length >= 1, "the model grant");
    await settle();
    expect(bridge.grants("model")).toHaveLength(1);
    expect(bridge.grants("model")[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-6-sol" },
    });
  });

  it("is `same` for a session with no run yet, and reads no connection", async () => {
    const sessionId = "sess_change_no_run";
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const decision = await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
         VALUES (?, 'ws_1', NULL, ?, 'active', NULL, NULL, 0, NULL, 1, ?, ?)`,
        sessionId,
        OWNER_USER_ID,
        WORLD_TIME,
        WORLD_TIME,
      );
      const host = instance as unknown as SessionHost;
      return decideRunModel(
        host,
        host.readSession() as SessionRow,
        changeCommand("cmd_first") as unknown as Parameters<typeof decideRunModel>[2],
      );
    });
    expect(decision).toEqual({ kind: "same" });
  });

  it("projects a marked snapshot as an ordinary one when the session it named is gone", async () => {
    const sessionId = "sess_change_projection_orphan";
    await env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, task_id, state, model_connection_id, created_at, updated_at)
       VALUES (?, 'ws_1', NULL, 'active', 'conn_1', ?, ?)`,
    )
      .bind(sessionId, WORLD_TIME, WORLD_TIME)
      .run();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, session_id, sequence, fact_type, schema_version, payload_json, created_at, attempts)
         VALUES ('outbox_orphan', ?, 5, 'session_index.snapshot', 1, ?, ?, 0)`,
        sessionId,
        JSON.stringify({
          state: "active",
          title: "Orphan",
          lastActivityAt: WORLD_TIME,
          sandboxProviderRef: null,
          sandboxGeneration: 0,
          endedSandboxGeneration: null,
          waitingForUser: false,
          currentRunId: null,
          currentRunState: null,
          modelConnectionChanged: true,
        }),
        WORLD_TIME,
      );
      await (instance as unknown as SessionHost).drainOutboxNow();
    });
    const row = await env.DB.prepare(
      "SELECT title, model_connection_id AS id FROM session_index WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ title: string; id: string }>();
    // The snapshot landed, and the connection was left as it was.
    expect(row).toEqual({ title: "Orphan", id: "conn_1" });
  });
});

describe("a model change the object refuses", () => {
  async function refusedWith(
    sessionId: string,
    command: Record<string, unknown>,
    options: Options = {},
    before: (world: SessionWorld, bridge: TestBridge) => Promise<void> = finishRun,
  ): Promise<Record<string, unknown>> {
    const { world, bridge } = await sessionOnSonnet(sessionId, options);
    await before(world, bridge);
    const client = await openClient(world);
    await client.send(command);
    await waitFor(async () => (await rejections(world)).length >= 1, "the refusal");
    await settle();
    // Nothing was started, granted, or stopped for it.
    expect(await queuedRuns(world)).toHaveLength(1);
    expect(bridge.grants("model")).toHaveLength(1);
    expect(bridge.commands("run.start")).toHaveLength(1);
    expect(await eventTypes(world.stub)).not.toContain("sandbox.stopped");
    expect(await indexedConnection(sessionId)).not.toBe("conn_openai");
    return (await rejections(world))[0] as Record<string, unknown>;
  }

  it("refuses another workspace's connection in the words it uses for one that does not exist", async () => {
    await seedConnection("conn_foreign", "ws_other", "openai");
    const foreign = await refusedWith(
      "sess_change_foreign",
      changeCommand("cmd_foreign", {
        model: { ...SOL_AS_SENT, modelConnectionId: "conn_foreign" },
      }),
    );
    const absent = await refusedWith(
      "sess_change_absent",
      changeCommand("cmd_absent", { model: { ...SOL_AS_SENT, modelConnectionId: "conn_none" } }),
    );
    expect(foreign).toMatchObject({
      commandId: "cmd_foreign",
      commandType: "run.start",
      reason: "wrong_state",
      detail: "that model connection is not available in this workspace",
    });
    expect(absent.detail).toBe(foreign.detail);
  });

  it("refuses a connection whose key is not active", async () => {
    expect(
      await refusedWith("sess_change_inactive", changeCommand("cmd_inactive"), {
        openaiKey: "invalid",
      }),
    ).toMatchObject({
      reason: "wrong_state",
      detail:
        "that model connection is not active; add a working key under Settings, Model providers",
    });
  });

  it("refuses a model the catalog does not hold, and one named under the wrong provider", async () => {
    expect(
      await refusedWith(
        "sess_change_unknown_model",
        changeCommand("cmd_unknown", { model: { ...SOL_AS_SENT, modelId: "gpt-not-real" } }),
      ),
    ).toMatchObject({ reason: "unsupported" });
    expect(
      await refusedWith(
        "sess_change_wrong_provider",
        changeCommand("cmd_wrong_provider", { model: { ...SOL_AS_SENT, provider: "anthropic" } }),
      ),
    ).toMatchObject({
      reason: "unsupported",
      detail: "that model is not one this connection's provider offers",
    });
  });

  it("refuses while the run is still working: the model changes only between runs", async () => {
    expect(
      await refusedWith(
        "sess_change_running",
        changeCommand("cmd_running"),
        {},
        async (world, bridge) => {
          bridge.send(bridge.event("run.started", { runId: "run_1" }));
          await waitFor(
            async () => (await runRowOf(world.stub, "run_1")).state === "running",
            "the run to be running",
          );
        },
      ),
    ).toMatchObject({
      reason: "wrong_state",
      detail: "the model can be changed only between runs; stop this run first",
    });
  });

  it("refuses a change that continues an older run, or none, so a stale tab cannot move the model", async () => {
    expect(
      await refusedWith(
        "sess_change_stale",
        changeCommand("cmd_stale", { continuesRunId: "run_0" }),
      ),
    ).toMatchObject({ reason: "wrong_state" });
    expect(
      await refusedWith("sess_change_fresh", changeCommand("cmd_fresh", { continuesRunId: null })),
    ).toMatchObject({
      reason: "wrong_state",
      detail: "the model can be changed only on a message that continues the session's latest run",
    });
  });

  it("refuses a checks-only run that names another model", async () => {
    expect(
      await refusedWith(
        "sess_change_checks_only",
        changeCommand("cmd_checks", { checksOnly: true }),
      ),
    ).toMatchObject({ reason: "unsupported" });
  });

  it("holds a local Worker's cost guard on a change as it does on a new session", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_cost_guard");
    await finishRun(world, bridge);
    await setObjectEnv(world, {
      ONCUE_ENV: "local",
      ONCUE_MODEL_ALLOWLIST: "claude-sonnet-5",
    });
    const client = await openClient(world);
    await client.send(changeCommand("cmd_guarded"));
    await waitFor(async () => (await rejections(world)).length >= 1, "the refusal");
    expect((await rejections(world))[0]).toMatchObject({
      reason: "unsupported",
      detail: "this OnCue is pinned to other models",
    });
    expect(await queuedRuns(world)).toHaveLength(1);
  });
});

/**
 * A run paused on a model failure. A usage limit leaves the sandbox up, so a
 * change can happen in it; a rejected key stops the sandbox at once (record 11).
 */
async function pausedOnModelFailure(
  sessionId: string,
  options: Options = {},
  category: "usage_limit_reached" | "authentication_failed" = "usage_limit_reached",
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const made = await sessionOnSonnet(sessionId, options);
  made.bridge.send(made.bridge.event("run.started", { runId: "run_1" }));
  made.bridge.send(
    made.bridge.event("run.paused", {
      runId: "run_1",
      payload: {
        reason: "model_failure",
        detail: "The provider refused the request.",
        modelFailure: { category, message: "The provider refused the request.", retries: 0 },
        checkpointId: null,
      },
    }),
  );
  await waitFor(
    async () => (await runRowOf(made.world.stub, "run_1")).state === "paused",
    "the pause",
  );
  return made;
}

describe("a model change on a paused run", () => {
  it("ends the paused run as cancelled and continues it as a new run on the other model", async () => {
    const { world, bridge } = await pausedOnModelFailure("sess_change_paused");
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitFor(() => bridge.commands("run.start").length >= 2, "the changed run's start");

    // A run keeps its model, so the paused one ends and the work continues as a new run.
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    // The owner's own cancel, as if they had stopped the run before choosing.
    expect((await eventsOfType(world.stub, "run.cancelled"))[0]).toMatchObject({
      runId: "run_1",
      payload: { by: { kind: "user", userId: OWNER_USER_ID } },
    });
    expect((await eventsOfType(world.stub, "run.cancelled")).length).toBe(1);
    expect((await queuedRuns(world))[1]).toMatchObject({
      trigger: "model_change",
      continuesRunId: "run_1",
      model: SOL_AS_STORED,
    });
    // The bridge hears the cancel, then the grant, then the start.
    const order = ["run.cancel", "grant", "run.start"].map((what) =>
      bridge.received.indexOf(
        (what === "grant" ? bridge.grants("model")[1] : bridge.commands(what).at(-1)) as Record<
          string,
          unknown
        >,
      ),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("leaves the paused run paused when the change is refused", async () => {
    const { world, bridge } = await pausedOnModelFailure("sess_change_paused_refused", {
      openaiKey: "invalid",
    });
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitFor(async () => (await rejections(world)).length >= 1, "the refusal");
    await settle();
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
    expect(await eventTypes(world.stub)).not.toContain("run.cancelled");
    expect(bridge.commands("run.cancel")).toEqual([]);
  });

  it("does not end the paused run for a resend of a start the object already refused", async () => {
    const { world, bridge } = await pausedOnModelFailure("sess_change_paused_resend", {
      openaiKey: "invalid",
    });
    const client = await openClient(world);
    await client.send(changeCommand("cmd_change"));
    await waitFor(async () => (await rejections(world)).length >= 1, "the refusal");

    // The key works again, and the same command id arrives a second time. A
    // command id is answered once, so nothing may be ended for it either.
    await seedConnection("conn_openai", world.workspaceId, "openai", "active");
    await client.send(changeCommand("cmd_change"));
    await settle();
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
    expect(await eventTypes(world.stub)).not.toContain("run.cancelled");
    expect(await queuedRuns(world)).toHaveLength(1);
    expect(bridge.commands("run.cancel")).toEqual([]);

    // Under a new id the change goes through.
    await client.send(changeCommand("cmd_change_again"));
    await waitFor(() => bridge.commands("run.start").length >= 2, "the changed run's start");
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
  });

  it("leaves the paused run paused when admission is closed to the new run", async () => {
    const { world, bridge } = await pausedOnModelFailure("sess_change_paused_admission");
    await env.DB.prepare("UPDATE platform_control SET run_admission = 'stopped'").run();
    try {
      const client = await openClient(world);
      await client.send(changeCommand("cmd_change"));
      await waitFor(async () => (await rejections(world)).length >= 1, "the refusal");
      expect((await rejections(world))[0]).toMatchObject({ reason: "admission_closed" });
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
      expect(bridge.commands("run.cancel")).toEqual([]);
    } finally {
      await env.DB.prepare("UPDATE platform_control SET run_admission = 'open'").run();
    }
  });
});

describe("a model change that needs a new sandbox", () => {
  async function waitForGeneration(world: SessionWorld, generation: number): Promise<void> {
    await waitFor(
      async () =>
        (await attachmentStates(world.stub)).some(
          (row) => row.generation === generation && row.state === "attached",
        ),
      `generation ${generation} to attach`,
    );
  }

  it("moves the run to a new generation when the attached bridge does not say it can change model", async () => {
    // An older bridge bundle: its harness was started for one model and would
    // be prompted with another it was never configured for.
    const sessionId = "sess_change_old_bridge";
    const { world, bridge } = await sessionOnSonnet(sessionId, { capabilities: [] });
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitForGeneration(world, 2);

    // The old sandbox stopped as an idle one does, and got neither the grant nor the start.
    expect(await eventTypes(world.stub)).toEqual(
      expect.arrayContaining(["sandbox.idle", "sandbox.stopped"]),
    );
    expect(bridge.grants("model")).toHaveLength(1);
    expect(bridge.commands("run.start")).toHaveLength(1);
    const second = (await runRows(world.stub))[1];
    expect(second?.state).not.toBe("cancelled");
    expect((await queuedRuns(world))[1]).toMatchObject({
      trigger: "model_change",
      model: SOL_AS_STORED,
    });

    // The new generation's harness starts on the other model, with the conversation as context.
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the new generation's grant");
    expect(next.grants("model")).toHaveLength(1);
    expect(next.grants("model")[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-6-sol" },
      effort: "low",
    });
    next.send(next.event("runtime.ready"));
    await waitFor(() => next.commands("run.start").length >= 1, "the changed run's start");
    const start = next.commands("run.start")[0] as { runId: string; context: string | null };
    expect(start.runId).toBe(second?.id);
    expect(start.context).toContain("I changed the assertion and the test passes.");
    await waitFor(
      async () => (await indexedConnection(sessionId)) === "conn_openai",
      "the index row to name the other key",
    );
  });

  it("moves the run when the bridge never said what it can do", async () => {
    // No `runtime.connected` was committed for the generation at all.
    const world = await sessionOnRealDriver("sess_change_silent_bridge", {
      body: { model: SONNET },
      envOverrides: { ONCUE_ENV: "local", ONCUE_MODEL_ALLOWLIST: "", ONCUE_RUNTIME_ALLOWLIST: "" },
    });
    await seedConnection("conn_openai", world.workspaceId, "openai");
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitForGeneration(world, 2);
    expect(bridge.grants("model")).toHaveLength(1);
    expect(bridge.commands("run.start")).toHaveLength(1);
  });

  it("waits out a stop already under way, whose last step starts the changed run", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_during_stop", {
      repository: true,
    });
    bridge.ack({ grantId: String((bridge.grants("git")[0] as Record<string, unknown>).grantId) });
    bridge.ack({ grantId: String((bridge.grants("model")[0] as Record<string, unknown>).grantId) });
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the clone token's revocation",
    );
    await finishRun(world, bridge);
    // The idle stop has begun and waits on the bridge's checkpoint.
    await idleStopIssued(world, bridge);
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitFor(async () => (await queuedRuns(world)).length >= 2, "the changed run");
    await settle();
    // Nothing goes to the sandbox that is stopping, although its harness could change model.
    expect(bridge.grants("model")).toHaveLength(1);
    expect(bridge.commands("run.start")).toHaveLength(1);

    reportCheckpoint(bridge, { checkpointId: "ckpt_stop" });
    await waitForGeneration(world, 2);
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the new generation's grant");
    expect(next.grants("model")[0]).toMatchObject({ model: { modelId: "gpt-6-sol" } });
  });

  it("after a rejected key, whose sandbox stops at once, starts the changed run on a new generation", async () => {
    const { world, bridge } = await pausedOnModelFailure(
      "sess_change_after_rejected_key",
      {},
      "authentication_failed",
    );
    const client = await openClient(world);

    // Not awaited: the rejected key's stop may still be under way.
    client.push(changeCommand("cmd_change"));
    await waitFor(async () => (await queuedRuns(world)).length >= 2, "the changed run");
    await waitForGeneration(world, 2);

    // The paused run ended, and nothing more went to the sandbox that was stopping.
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    expect(bridge.commands("run.start")).toHaveLength(1);
    expect((await queuedRuns(world))[1]).toMatchObject({
      trigger: "model_change",
      continuesRunId: "run_1",
    });
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the new generation's grant");
    expect(next.grants("model")[0]).toMatchObject({ model: { modelId: "gpt-6-sol" } });
  });

  it("checkpoints a repository's work before the old sandbox stops", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_old_bridge_repo", {
      capabilities: [],
      repository: true,
    });
    bridge.ack({ grantId: String((bridge.grants("git")[0] as Record<string, unknown>).grantId) });
    bridge.ack({ grantId: String((bridge.grants("model")[0] as Record<string, unknown>).grantId) });
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the clone token's revocation",
    );
    await finishRun(world, bridge);
    const client = await openClient(world);

    // Not awaited: the stop waits on the bridge's checkpoint.
    client.push(changeCommand("cmd_change"));
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint");
    expect(await eventTypes(world.stub)).not.toContain("sandbox.stopped");
    reportCheckpoint(bridge, { checkpointId: "ckpt_change" });
    await waitForGeneration(world, 2);
    expect(await eventTypes(world.stub)).toEqual(
      expect.arrayContaining(["sandbox.checkpointed", "sandbox.stopped"]),
    );
  });

  it("starts on a new generation when no sandbox is attached, whose first grant names the other model", async () => {
    const { world, bridge } = await sessionOnSonnet("sess_change_stopped");
    await finishRun(world, bridge);
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: OWNER_USER_ID, modalCredential: MODAL_CREDENTIAL }),
    );
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    const client = await openClient(world);

    await client.send(changeCommand("cmd_change"));
    await waitForGeneration(world, 2);
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the new generation's grant");
    expect(next.grants("model")[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-6-sol" },
    });
    expect((await queuedRuns(world))[1]).toMatchObject({ trigger: "model_change" });
    expect((await dispatchRows(world.stub)).filter((row) => row.generation === 2)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "model_grant" })]),
    );
  });
});
