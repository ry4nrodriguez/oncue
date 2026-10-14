// The sandbox lifecycle (record 11) through the object's real seams: real
// driver over a scripted controller, a hand-driven bridge, the GitHub double,
// and a sealed Modal credential the alarm opens itself. Time passes by aging
// the stored facts and firing the alarm.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ageEvents,
  ageProbe,
  ageStop,
  armAlarmNow,
  attachmentStates,
  BASE_SHA,
  connectBridge,
  dispatchRows,
  endedGenerationInD1,
  eventCount,
  eventsOfType,
  eventTypes,
  finishRun,
  fireAlarm,
  idleStopIssued,
  MODAL_CREDENTIAL,
  openClient,
  probeRow,
  quietRepositoryWorld,
  REAL_KEYRING_VALUE,
  REPOSITORY,
  REPOSITORY_ID,
  readyBridge,
  registerSessionWorlds,
  reportCheckpoint,
  runRowOf,
  sessionOnRealDriver,
  setObjectEnv,
  settle,
  stopRow,
  storedAlarm,
  stubFor,
  type TestBridge,
  waitFor,
} from "../test/session-world";
import { PROBE_DELAYS_MS, STEP_LEASE_MS } from "./lifecycle";
import { readRejectedKeyPause } from "./object/store-lifecycle";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD_SHA = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const MIN = 60_000;

const controllerRefusal = (message: string) =>
  Response.json({ kind: "error", category: "unknown", message, retryable: true }, { status: 503 });

type World = Awaited<ReturnType<typeof sessionOnRealDriver>>;

async function serverSocketsClosed(world: World) {
  await waitFor(
    async () =>
      runInDurableObject(world.stub, (_instance, state) =>
        state.getWebSockets("bridge").every((ws) => ws.readyState !== WebSocket.OPEN),
      ),
    "the server end to leave OPEN",
  );
}

async function waitForStop(world: World) {
  await waitFor(async () => (await eventTypes(world.stub)).includes("sandbox.stopped"), "the stop");
}

/**
 * Holds every GitHub call `matches` picks for `delayMs` before the double
 * answers it, and counts the calls it held. A timer rather than a gate:
 * workerd abandons a promise with no I/O behind it.
 */
function slowGitHub(
  world: World,
  matches: (url: string, method: string) => boolean,
  delayMs: number,
): { held(): number } {
  const github = world.github as { fetchImpl: typeof fetch };
  const answer = github.fetchImpl;
  let held = 0;
  github.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (matches(url, (init?.method ?? "GET").toUpperCase())) {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return answer(input, init);
  }) as typeof fetch;
  return { held: () => held };
}

function grantsOf(event: Record<string, unknown> | undefined) {
  return (
    (event as Record<string, unknown>).payload as { grants: { kind: string; outcome: string }[] }
  ).grants;
}

describe("the idle stop", () => {
  it("announces, checkpoints through a push grant, revokes, and stops, in record 11's order", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_happy");
    const beforeStop = world.github.calls.length;

    const { push, checkpoint } = await idleStopIssued(world, bridge);

    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect(push).toMatchObject({
      kind: "push",
      sessionId: world.sessionId,
      sandboxGeneration: 1,
      repository: { fullName: "acme/widgets", cloneUrl: REPOSITORY.cloneUrl },
      ref: `refs/heads/${REPOSITORY.taskBranch}`,
      parentSha: BASE_SHA,
    });
    expect(String(push.token)).toMatch(/^ghs_/);
    const mint = world.github.calls
      .slice(beforeStop)
      .find((call) => call.path.includes("access_tokens"));
    expect(mint?.tokenNarrowing).toEqual({
      repositoryIds: [REPOSITORY_ID],
      permissions: { contents: "write" },
    });
    const pushAt = bridge.received.indexOf(push);
    const checkpointAt = bridge.received.indexOf(checkpoint);
    expect(pushAt).toBeGreaterThan(0);
    expect(pushAt).toBeLessThan(checkpointAt);
    expect(checkpoint).toMatchObject({
      command: { type: "checkpoint.create", payload: { reason: "idle" } },
      runId: null,
      context: null,
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({
      cause: "idle",
      step: "awaiting_checkpoint",
      checkpoint_json: null,
    });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "checkpointing", provider: "modal" },
    ]);
    const alarm = (await storedAlarm(world.stub)) as number;
    expect(alarm - Date.now()).toBeGreaterThan(80_000);
    expect(alarm - Date.now()).toBeLessThanOrEqual(90_000);
    const stored = await runInDurableObject(world.stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM bridge_dispatch",
      ),
    ]);
    expect(stored.some((row) => row.payload_json.includes(String(push.token)))).toBe(false);

    bridge.ack({ commandId: String((checkpoint.command as { commandId: string }).commandId) });
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
    await waitForStop(world);

    const types = await eventTypes(world.stub);
    const at = (type: string) => types.indexOf(type);
    expect(at("sandbox.checkpointed")).toBeLessThan(at("sandbox.credentials_revoked"));
    expect(at("sandbox.credentials_revoked")).toBeLessThan(at("sandbox.stopped"));
    expect(types.filter((type) => type === "sandbox.stopped")).toHaveLength(1);
    expect(grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0])).toEqual([
      { kind: "model", outcome: "revoked" },
      { kind: "git", outcome: "not_held" },
      { kind: "push", outcome: "revoked" },
      { kind: "upload", outcome: "not_held" },
    ]);
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({ reason: "idle" });
    // The stop closed the bridge itself, past its checkpoint: that close is
    // the stop's own doing, not a loss to record.
    expect(await eventsOfType(world.stub, "runtime.disconnected")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toEqual({
      outcome: "stopped",
      reason: "idle",
      checkpointId: "ckpt_idle",
      unsavedWorkWarning: null,
      diagnostics: [],
    });
    // The clone token at repository.status and the push token in the revoke
    // step: two revocations, both through GitHub, the second before
    // sandbox.credentials_revoked was committed.
    const revocations = world.github.calls.filter((call) => call.tokenRevoked === true);
    expect(revocations).toHaveLength(2);
    expect(revocations[1]?.atMs as number).toBeLessThanOrEqual(
      Date.parse(
        (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.occurredAt as string,
      ) + 1000,
    );
    expect(bridge.commands("runtime.shutdown")[0]).toMatchObject({
      command: { payload: { reason: "idle" } },
    });
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", due_at_ms: null });
    expect(JSON.parse((await stopRow(world.stub, 1))?.checkpoint_json as string)).toEqual({
      checkpointId: "ckpt_idle",
      kind: "branch_push",
      headSha: HEAD_SHA,
    });
    expect(await endedGenerationInD1(world.sessionId)).toBe(1);
    expect((await dispatchRows(world.stub)).filter((row) => row.state === "sent")).toEqual([]);
    expect(await storedAlarm(world.stub)).toBeNull();
  });

  it("stops at once, saying why, when the bridge reports that the checkpoint failed", async () => {
    // A failure report (here `git add` on an unreadable file) must end the
    // stop's wait at once.
    const { world, bridge } = await quietRepositoryWorld("sess_idle_ckpt_failed");
    const { checkpoint } = await idleStopIssued(world, bridge);
    bridge.ack({ commandId: String((checkpoint.command as { commandId: string }).commandId) });
    bridge.send(
      bridge.event("sandbox.checkpoint_failed", {
        payload: { checkpointId: "ckpt_idle", reason: "idle", failure: "add_failed" },
      }),
    );
    // No aging and no alarm past the deadline: the report alone moves the stop.
    await waitForStop(world);

    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/could not read a file in the work tree/),
    });
    expect(
      grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
    ).toContainEqual({ kind: "push", outcome: "revoked" });
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", checkpoint_json: null });
  });

  it("still stops, with the timeout warning, when the checkpoint never reports", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_timeout");
    await idleStopIssued(world, bridge);

    // The alarm fires early for another owner: the wait is not over and the
    // push token's own deadline has not come, so nothing moves.
    await fireAlarm(world.stub);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "awaiting_checkpoint" });

    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    await waitForStop(world);

    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/did not finish in time/),
    });
    expect(
      grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
    ).toContainEqual({ kind: "push", outcome: "revoked" });
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", checkpoint_json: null });
  });

  it("records a push token the bridge already revoked after its push as revoked, not failed", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_bridge_revoked");
    const { push, checkpoint } = await idleStopIssued(world, bridge);

    // What the real bridge does on every path that takes the grant: it revokes
    // the token itself once its push is done, before it reports.
    const bridgeRevoke = await world.github.fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${String(push.token)}` },
    });
    expect(bridgeRevoke.status).toBe(204);
    const callsBefore = world.github.calls.length;

    bridge.ack({ commandId: String((checkpoint.command as { commandId: string }).commandId) });
    reportCheckpoint(bridge, { checkpointId: "ckpt_bridge_revoked", headSha: HEAD_SHA });
    await waitForStop(world);

    expect(grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0])).toEqual([
      { kind: "model", outcome: "revoked" },
      { kind: "git", outcome: "not_held" },
      { kind: "push", outcome: "revoked" },
      { kind: "upload", outcome: "not_held" },
    ]);
    // The object still asked GitHub, and GitHub said the token was already gone.
    expect(
      world.github.calls
        .slice(callsBefore)
        .some((call) => call.path.includes("installation/token") && call.tokenRevoked === false),
    ).toBe(true);
  });

  it("still records a push revocation GitHub refuses as failed when the bridge never reported", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_push_revoke_refused");
    await idleStopIssued(world, bridge);
    world.github.setMode("revoke_fails");

    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    await waitForStop(world);

    expect(
      grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
    ).toContainEqual({ kind: "push", outcome: "failed" });
  });

  it("records a bridge that leaves during the checkpoint wait, then times the checkpoint out", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_left_waiting");
    await idleStopIssued(world, bridge);
    bridge.close();
    await waitFor(
      async () => (await eventsOfType(world.stub, "runtime.disconnected")).length >= 1,
      "the disconnect",
    );
    // A stop owns the generation: no probe is asked for beside it.
    expect(await probeRow(world.stub, 1)).toBeNull();
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "awaiting_checkpoint" });

    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);

    expect(bridge.commands("runtime.shutdown")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      unsavedWorkWarning: expect.stringMatching(/did not finish in time/),
    });
  });

  it("moves on with the no-checkpoint warning when the bridge rejects checkpoint.create", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_rejected");
    const { checkpoint } = await idleStopIssued(world, bridge);

    bridge.ack(
      { commandId: String((checkpoint.command as { commandId: string }).commandId) },
      { kind: "rejected", reason: "wrong_state" },
    );
    await waitForStop(world);

    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandType: "checkpoint.create",
      reason: "wrong_state",
    });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/no checkpoint was taken/),
    });
  });

  it("warns rather than stopping silently when the bridge is gone before the checkpoint", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_no_bridge");
    bridge.close();
    await serverSocketsClosed(world);
    expect(await probeRow(world.stub, 1)).toMatchObject({ attempts: 0 });

    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);

    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(bridge.commands("runtime.shutdown")).toEqual([]);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect((await eventTypes(world.stub)).slice(-3)).toEqual([
      "sandbox.idle",
      "sandbox.credentials_revoked",
      "sandbox.stopped",
    ]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/bridge was not connected/),
    });
    // The probe the socket close scheduled is owed by nothing once the
    // generation has stopped, and the next alarm clears it.
    expect(await storedAlarm(world.stub)).toBe((await probeRow(world.stub, 1))?.due_at_ms);
    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);
    expect(await probeRow(world.stub, 1)).toBeNull();
    expect(await storedAlarm(world.stub)).toBeNull();
  });

  it("keeps its step when the provider refuses to terminate, finishes on a later alarm, and revokes exactly once", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_terminate_refused", {
      controller: (operation) =>
        operation === "stop" ? controllerRefusal("the controller is restarting") : undefined,
    });
    await idleStopIssued(world, bridge);
    reportCheckpoint(bridge, { checkpointId: "ckpt_refused" });
    await waitFor(
      async () => (await stopRow(world.stub, 1))?.step === "terminate",
      "the terminate step",
    );
    await waitFor(async () => (await stopRow(world.stub, 1))?.attempts === 1, "the failed attempt");

    const row = await stopRow(world.stub, 1);
    expect(row?.due_at_ms as number).toBeGreaterThan(Date.now());
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "checkpointing", provider: "modal" },
    ]);
    expect(await storedAlarm(world.stub)).toBe(row?.due_at_ms);

    // Not yet due: the alarm does nothing.
    await fireAlarm(world.stub);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);

    world.setController(null);
    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);

    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(2);
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: "ckpt_refused",
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", attempts: 1 });
    // The bridge closed at the first shutdown, so the retry went straight to
    // the driver.
    expect(bridge.commands("runtime.shutdown")).toHaveLength(1);
  });

  it("an alarm whose terminate is refused stops there, and the next one finishes", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_alarm_refused", {
      controller: (operation) =>
        operation === "stop" ? controllerRefusal("the controller is restarting") : undefined,
    });
    bridge.close();
    await serverSocketsClosed(world);

    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);

    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "terminate", attempts: 1 });
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);

    world.setController(null);
    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    expect((await eventTypes(world.stub)).at(-1)).toBe("sandbox.stopped");
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
  });

  it("an alarm on an object with no session does nothing", async () => {
    await fireAlarm(stubFor("sess_alarm_nobody"));
    expect(await eventCount(stubFor("sess_alarm_nobody"))).toBe(0);
  });

  it("records the model grant as failed when D1 refuses to end the generation's broker access", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_projection_refused");
    bridge.close();
    await serverSocketsClosed(world);
    // D1 outlives the test, so the trigger is dropped again below.
    await env.DB.prepare(
      `CREATE TRIGGER refuse_ended BEFORE UPDATE OF ended_sandbox_generation ON session_index
       WHEN NEW.ended_sandbox_generation IS NOT OLD.ended_sandbox_generation
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    ).run();
    try {
      await ageEvents(world.stub, 30 * MIN);
      await fireAlarm(world.stub);

      expect(
        grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
      ).toContainEqual({ kind: "model", outcome: "failed" });
      expect(await endedGenerationInD1(world.sessionId)).toBeNull();
      expect((await eventTypes(world.stub)).at(-1)).toBe("sandbox.stopped");
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_ended").run();
    }
  });

  it("writes the generation's end to D1 again before every terminate attempt, so a refused first write cannot outlast the stop", async () => {
    const sessionId = "sess_idle_projection_retried";
    let stops = 0;
    let endedAtSecondAttempt: number | null = null;
    const { world, bridge } = await quietRepositoryWorld(sessionId, {
      controller: async (operation) => {
        if (operation !== "stop") {
          return undefined as unknown as Response;
        }
        stops += 1;
        if (stops === 1) {
          // D1 recovers while the provider refuses the first attempt.
          await env.DB.prepare("DROP TRIGGER refuse_ended").run();
          return controllerRefusal("the controller is restarting");
        }
        endedAtSecondAttempt = await endedGenerationInD1(sessionId);
        return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } });
      },
    });
    bridge.close();
    await serverSocketsClosed(world);
    // The outbox would write the same column on its own backoff; holding it
    // back shows the terminate step's own write is what ends model access.
    await env.DB.prepare(
      `CREATE TRIGGER hold_projection BEFORE UPDATE OF last_projected_sequence ON session_index
       WHEN NEW.last_projected_sequence IS NOT OLD.last_projected_sequence
       BEGIN SELECT RAISE(ABORT, 'held'); END`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER refuse_ended BEFORE UPDATE OF ended_sandbox_generation ON session_index
       WHEN NEW.ended_sandbox_generation IS NOT OLD.ended_sandbox_generation
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    ).run();
    try {
      await ageEvents(world.stub, 30 * MIN);
      await fireAlarm(world.stub);
      expect(
        grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
      ).toContainEqual({ kind: "model", outcome: "failed" });
      expect(await stopRow(world.stub, 1)).toMatchObject({ step: "terminate", attempts: 1 });

      await ageStop(world.stub, 1);
      await fireAlarm(world.stub);

      expect(stops).toBe(2);
      expect(endedAtSecondAttempt).toBe(1);
      expect((await eventTypes(world.stub)).at(-1)).toBe("sandbox.stopped");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS refuse_ended").run();
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_projection").run();
    }
  });

  it("does each step once when the alarm fires again, and late frames from the old bridge change nothing", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_twice");
    await idleStopIssued(world, bridge);
    reportCheckpoint(bridge, { checkpointId: "ckpt_once" });
    await waitForStop(world);
    const events = await eventCount(world.stub);
    const stops = world.controllerCalls.filter((call) => call.operation === "stop").length;

    await fireAlarm(world.stub);
    await fireAlarm(world.stub);

    expect(await eventCount(world.stub)).toBe(events);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(stops);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });

    // The sandbox's bridge process may still get a frame out after the stop.
    const late = await connectBridge(world, 1);
    await late.hello();
    late.send(late.event("sandbox.checkpointed", { payload: { checkpointId: "ckpt_late" } }));
    late.send(late.event("runtime.ready"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "runtime.ready")).length >= 2,
      "the late frames to commit",
    );
    await settle();
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(JSON.parse((await stopRow(world.stub, 1))?.checkpoint_json as string)).toMatchObject({
      checkpointId: "ckpt_once",
    });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
  });

  it("records a sandbox.checkpointed the bridge sends outside any stop and starts none", async () => {
    const world = await sessionOnRealDriver("sess_checkpoint_outside_stop", {
      repository: REPOSITORY,
    });
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("sandbox.checkpointed", { payload: { reason: "user" } }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "sandbox.checkpointed")).length >= 1,
      "the checkpoint",
    );
    await settle();
    expect(await stopRow(world.stub, 1)).toBeNull();
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toEqual([]);
  });

  it("a stop found at its checkpoint step after the bridge left moves on with the warning", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_evicted");
    bridge.close();
    await serverSocketsClosed(world);
    // The row `beginStop` writes, as an object evicted between that write and
    // its first step finds it on the next wake.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sandbox_stop (generation, cause, step, started_at_ms, due_at_ms, attempts) VALUES (1, 'idle', 'checkpoint', ?, NULL, 0)",
        Date.now(),
      );
    });

    await fireAlarm(world.stub);

    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/bridge was not connected/),
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
  });

  it("stops without a checkpoint when the session no longer admits checkpoint.create", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_deleting");
    // The state record 03's deletion writes once it begins; `checkpoint.create`
    // is not issuable in it, while `runtime.shutdown` always is.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'deletion_pending'");
    });

    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);
    await waitForStop(world);

    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandType: "checkpoint.create",
      reason: "wrong_state",
    });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      unsavedWorkWarning: expect.stringMatching(/bridge was not connected/),
    });
  });

  it.each([
    ["GitHub refuses to mint", { githubConfigured: true, mode: "token_mint_fails" as const }],
    ["the deployment has no GitHub App", { githubConfigured: false, mode: "ok" as const }],
  ])(
    "sends checkpoint.create without a push grant when %s, and records the bridge's local commit",
    async (_name, setup) => {
      const sessionId = `sess_idle_push_${setup.githubConfigured ? "mint" : "unconfigured"}`;
      let world: Awaited<ReturnType<typeof sessionOnRealDriver>>;
      let bridge: TestBridge;
      if (setup.githubConfigured) {
        ({ world, bridge } = await quietRepositoryWorld(sessionId));
        world.github.setMode(setup.mode);
      } else {
        // With no App the clone token cannot be minted either, and the run
        // fails at provisioning, so the generation is quiet on its own.
        world = await sessionOnRealDriver(sessionId, {
          repository: REPOSITORY,
          githubConfigured: false,
        });
        bridge = await readyBridge(world, 1, { closeOnShutdown: true });
        await waitFor(
          async () => (await runRowOf(world.stub, "run_1")).state === "failed",
          "the run to fail",
        );
      }

      const { checkpoint } = await idleStopIssued(world, bridge);
      expect(bridge.grants("push")).toEqual([]);
      expect(checkpoint).toMatchObject({ command: { type: "checkpoint.create" } });
      // The push grant row shares the clone grant's column kind; it is the
      // newer of the two, left pending with its attempt counted.
      const pushRow = (await dispatchRows(world.stub))
        .filter((row) => row.kind === "git_grant")
        .at(-1);
      expect(pushRow).toMatchObject({ state: "pending", attempts: 1 });

      reportCheckpoint(bridge, { checkpointId: "ckpt_local", kind: "local_commit", headSha: null });
      await waitForStop(world);
      expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
        checkpointId: "ckpt_local",
        unsavedWorkWarning: null,
      });
      expect(
        grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
      ).toContainEqual({ kind: "push", outcome: "not_held" });
    },
  );

  it("records a clone token GitHub would not revoke as failed", async () => {
    const world = await sessionOnRealDriver("sess_idle_revoke_fails", { repository: REPOSITORY });
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    bridge.close();
    await serverSocketsClosed(world);
    world.github.setMode("revoke_fails");

    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);

    expect(grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0])).toEqual([
      { kind: "model", outcome: "revoked" },
      { kind: "git", outcome: "failed" },
      { kind: "push", outcome: "not_held" },
      { kind: "upload", outcome: "not_held" },
    ]);
    expect(world.github.calls.some((call) => call.tokenRevoked === false)).toBe(true);
  });

  it("revokes a push token whose own deadline passes before the bridge reports", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_idle_push_deadline");
    await idleStopIssued(world, bridge);
    const revokedBefore = world.github.calls.filter((call) => call.tokenRevoked === true).length;
    await runInDurableObject(world.stub, async (instance) => {
      (instance as unknown as { pushGrantDeadlineMs: number | null }).pushGrantDeadlineMs =
        Date.now() - 1;
      await instance.alarm();
    });
    expect(world.github.calls.filter((call) => call.tokenRevoked === true)).toHaveLength(
      revokedBefore + 1,
    );
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "awaiting_checkpoint" });
  });
});

describe("the user's stop", () => {
  it("skips the checkpoint, revokes, terminates, and commits sandbox.stopped then run.cancelled", async () => {
    const world = await sessionOnRealDriver("sess_user_stop", { repository: REPOSITORY });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );

    expect(result).toEqual({ kind: "stopped", generation: 1 });
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(bridge.grants("push")).toEqual([]);
    const types = await eventTypes(world.stub);
    // runtime.shutdown's own acknowledgement lands between the revocation and
    // the stop; the bridge's close during the terminate step records nothing.
    expect(types.slice(-3)).toEqual(["command.acknowledged", "sandbox.stopped", "run.cancelled"]);
    expect(types.indexOf("sandbox.credentials_revoked")).toBeLessThan(
      types.indexOf("sandbox.stopped"),
    );
    expect(await eventsOfType(world.stub, "runtime.disconnected")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload).toEqual({
      reason: "user_requested",
      grants: [
        { kind: "model", outcome: "revoked" },
        { kind: "git", outcome: "revoked" },
        { kind: "push", outcome: "not_held" },
        { kind: "upload", outcome: "not_held" },
      ],
    });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "user_requested",
      checkpointId: null,
      unsavedWorkWarning: null,
    });
    expect((await eventsOfType(world.stub, "run.cancelled"))[0]).toMatchObject({
      runId: "run_1",
      payload: { by: { kind: "user", userId: "user_1" } },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    expect(await endedGenerationInD1(world.sessionId)).toBe(1);
  });

  it("returns the driver's refusal, keeps the step, and a second stop after the backoff finishes it", async () => {
    const world = await sessionOnRealDriver("sess_user_stop_refused", {
      controller: (operation) =>
        operation === "stop" ? controllerRefusal("the controller is restarting") : undefined,
    });
    await readyBridge(world, 1, { closeOnShutdown: true });
    const stop = () =>
      runInDurableObject(world.stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
      );

    expect(await stop()).toEqual({
      kind: "failed",
      category: "unknown",
      message: "the controller is restarting",
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({
      cause: "user_requested",
      step: "terminate",
      attempts: 1,
    });
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);

    // A second click while the terminate waits out its backoff: the stop is
    // under way, not finished, and the provider is not asked again early.
    expect(await stop()).toEqual({ kind: "stopping", generation: 1 });
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);

    world.setController(null);
    await ageStop(world.stub, 1);
    expect(await stop()).toEqual({ kind: "stopped", generation: 1 });
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect((await eventTypes(world.stub)).slice(-2)).toEqual(["sandbox.stopped", "run.cancelled"]);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(2);
  });

  it("joins an idle stop's checkpoint wait, and every event still to come is the user's", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_user_stop_during_idle");
    await idleStopIssued(world, bridge);

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );

    expect(result).toEqual({ kind: "stopped", generation: 1 });
    // Committed before the user asked, so still the idle stop's.
    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({ reason: "user_requested" });
    expect(bridge.commands("runtime.shutdown")[0]).toMatchObject({
      command: { payload: { reason: "cancelled" } },
    });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "user_requested",
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(
        /Stopped at your request before the checkpoint finished/,
      ),
    });
    // The run had already completed, so it keeps its outcome: no run.cancelled
    // is committed for it, and its row is not rewritten.
    expect(await eventsOfType(world.stub, "run.cancelled")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "completed_with_warnings",
      outcome: "completed_with_warnings",
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "user_requested", step: "done" });
  });

  it("an idle checkpoint that lands after the user's stop finished changes nothing and repeats nothing", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_user_stop_beside_mint");
    // GitHub refuses the push token and takes three seconds to say so, so the
    // idle stop is still inside its checkpoint step when the user stops.
    world.github.setMode("token_mint_fails");
    const mint = slowGitHub(world, (url) => url.includes("/access_tokens"), 3_000);
    await ageEvents(world.stub, 30 * MIN);
    const alarm = fireAlarm(world.stub);
    await waitFor(() => mint.held() >= 1, "the push token's mint to be under way");
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "idle", step: "checkpoint" });

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    await alarm;

    // The idle stop's late `checkpoint_issued` found the stop past its
    // checkpoint and did not put it back at `awaiting_checkpoint`, so no later
    // alarm revokes and terminates a second time.
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "user_requested", step: "done" });
    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    expect(bridge.commands("checkpoint.create")).toEqual([]);
  });

  it.each([
    [
      "answers",
      () => Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } }),
    ],
    ["refuses", () => controllerRefusal("the controller is restarting")],
  ])(
    "a terminate the alarm finishes while the user's slower attempt still waits, then %s, is stopped once",
    async (name, slowAnswer) => {
      let stops = 0;
      const world = await sessionOnRealDriver(`sess_user_stop_slow_terminate_${name}`, {
        controller: (operation) => {
          if (operation !== "stop") {
            return undefined;
          }
          stops += 1;
          return stops === 1
            ? new Promise<Response>((resolve) => setTimeout(() => resolve(slowAnswer()), 3_000))
            : undefined;
        },
      });
      await readyBridge(world, 1, { closeOnShutdown: true });
      const stopping = runInDurableObject(world.stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
      );
      await waitFor(() => stops >= 1, "the user's terminate to reach the provider");

      // The user's attempt outlives its lease, and the alarm takes the step over.
      await ageStop(world.stub, 1);
      await fireAlarm(world.stub);
      expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });

      // The slow answer lands on a stop already past its terminate: neither a
      // second stop nor a backoff that would put the step back.
      expect(await stopping).toEqual({ kind: "stopped", generation: 1 });
      await settle();
      expect(stops).toBe(2);
      expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", attempts: 0 });
      expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
      expect(await eventsOfType(world.stub, "run.cancelled")).toHaveLength(1);
    },
  );

  it("revokes a push token whose mint returns after the user's stop took the credentials back, and never sends it", async () => {
    // The bridge stays listening past the shutdown, so a token sent after the
    // stop would reach it.
    const { world, bridge } = await quietRepositoryWorld(
      "sess_user_stop_late_push",
      {},
      { closeOnShutdown: false },
    );
    const mint = slowGitHub(world, (url) => url.includes("/access_tokens"), 5_000);
    const revokedBefore = world.github.calls.filter((call) => call.tokenRevoked === true).length;
    await ageEvents(world.stub, 30 * MIN);
    const alarm = fireAlarm(world.stub);
    await waitFor(() => mint.held() >= 1, "the push token's mint to be under way");

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    const revoked = (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0];
    // True when committed, and still true after: the generation never held it.
    expect(grantsOf(revoked)).toContainEqual({ kind: "push", outcome: "not_held" });
    await alarm;

    expect(bridge.grants("push")).toEqual([]);
    const revocations = world.github.calls.filter((call) => call.tokenRevoked === true);
    expect(revocations).toHaveLength(revokedBefore + 1);
    expect(revocations.at(-1)?.atMs as number).toBeGreaterThanOrEqual(
      Date.parse(revoked?.occurredAt as string),
    );
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
  });

  it("revokes a clone token whose mint returns after the user's stop took the credentials back, and never sends it", async () => {
    const world = await sessionOnRealDriver("sess_user_stop_late_clone", {
      repository: REPOSITORY,
    });
    const mint = slowGitHub(world, (url) => url.includes("/access_tokens"), 5_000);
    const bridge = await connectBridge(world, 1, { closeOnShutdown: false });
    await bridge.hello();
    await waitFor(() => mint.held() >= 1, "the clone token's mint to be under way");

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    expect(
      grantsOf((await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]),
    ).toContainEqual({ kind: "git", outcome: "not_held" });
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the late clone token's revocation",
      15_000,
    );
    await settle();

    expect(bridge.grants("git")).toEqual([]);
    expect(world.github.calls.filter((call) => call.tokenRevoked === true)).toHaveLength(1);
  });

  it("a clone token GitHub refuses after the user cancelled the run commits no run.failed, and the run keeps its cancel", async () => {
    const world = await sessionOnRealDriver("sess_cancel_before_clone_refusal", {
      repository: REPOSITORY,
    });
    world.github.setMode("token_mint_fails");
    const mint = slowGitHub(world, (url) => url.includes("/access_tokens"), 3_000);
    const bridge = await connectBridge(world, 1, { closeOnShutdown: false });
    await bridge.hello();
    await waitFor(() => mint.held() >= 1, "the clone token's mint to be under way");

    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel_before_refusal",
      runId: "run_1",
      issuedAt: "2026-09-02T00:00:00.000Z",
      expected: { scope: "run", state: "provisioning" },
      payload: { reason: null, checkpointFirst: false },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    await waitFor(
      () => world.github.calls.some((call) => call.path.includes("access_tokens")),
      "GitHub's refusal",
      15_000,
    );
    await settle();

    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "cancelled",
      outcome: "cancelled",
    });
  });

  it("a refusal from a terminate whose lease another attempt took over changes nothing, and the answer is stopping", async () => {
    let stops = 0;
    const world = await sessionOnRealDriver("sess_user_stop_stale_refusal", {
      controller: (operation) => {
        if (operation !== "stop") {
          return undefined;
        }
        stops += 1;
        // The user's attempt is refused after two seconds; the alarm's, which
        // took over the step, succeeds after five.
        return stops === 1
          ? new Promise<Response>((resolve) =>
              setTimeout(() => resolve(controllerRefusal("the controller is restarting")), 2_000),
            )
          : new Promise<Response>((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    Response.json({
                      kind: "ok",
                      value: { bridgeUrl: "modal://oncue-sessions/sb-1" },
                    }),
                  ),
                5_000,
              ),
            );
      },
    });
    await readyBridge(world, 1, { closeOnShutdown: true });
    const stopping = runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    await waitFor(() => stops >= 1, "the user's terminate to reach the provider");
    await ageStop(world.stub, 1);
    const alarm = fireAlarm(world.stub);
    await waitFor(() => stops >= 2, "the alarm's terminate to reach the provider");

    // The stale refusal neither backs the step off nor answers 502.
    expect(await stopping).toEqual({ kind: "stopping", generation: 1 });
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "terminate", attempts: 0 });
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);

    await alarm;
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done", attempts: 0 });
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
    expect(stops).toBe(2);
  });

  it("refuses to hand a Modal generation to the fake when its credential cannot be opened", async () => {
    const world = await sessionOnRealDriver("sess_user_stop_no_credential");
    await readyBridge(world, 1, { closeOnShutdown: true });
    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: null }),
    );
    expect(result).toMatchObject({ kind: "failed", category: "credentials" });
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toEqual([]);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "terminate", attempts: 1 });

    // The alarm opens the sealed row itself and finishes what the route could not.
    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
  });
});

describe("losing a sandbox", () => {
  async function lostBridge(
    sessionId: string,
    options: { ready?: boolean; repository?: boolean } = {},
  ) {
    const world = await sessionOnRealDriver(sessionId, {
      repository: options.repository === true ? REPOSITORY : null,
    });
    const bridge =
      options.ready === false
        ? await (async () => {
            const connected = await connectBridge(world);
            await connected.hello();
            return connected;
          })()
        : await readyBridge(world);
    return { world, bridge };
  }

  async function closeAndWaitForProbe(
    world: Awaited<ReturnType<typeof sessionOnRealDriver>>,
    bridge: TestBridge,
  ) {
    const before = Date.now();
    bridge.close();
    await waitFor(async () => (await probeRow(world.stub, 1)) !== null, "the probe");
    const probe = await probeRow(world.stub, 1);
    expect(probe?.attempts).toBe(0);
    expect(probe?.due_at_ms as number).toBeGreaterThanOrEqual(before + PROBE_DELAYS_MS[0]);
    expect(await storedAlarm(world.stub)).toBe(probe?.due_at_ms);
    expect((await eventTypes(world.stub)).at(-1)).toBe("runtime.disconnected");
  }

  it("interrupts a running run at its last checkpoint when the provider says not_found", async () => {
    const { world, bridge } = await lostBridge("sess_lost_running");
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(
      bridge.event("repository.checkpointed", {
        runId: "run_1",
        payload: { checkpointId: "ckpt_periodic", headSha: HEAD_SHA, reason: "periodic" },
      }),
    );
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    await closeAndWaitForProbe(world, bridge);
    world.setController((operation) =>
      operation === "getStatus"
        ? Response.json(
            { kind: "error", category: "not_found", message: "no such sandbox", retryable: false },
            { status: 404 },
          )
        : undefined,
    );

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect(world.controllerCalls.filter((call) => call.operation === "getStatus")).toHaveLength(1);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toEqual([]);
    expect((await eventTypes(world.stub)).slice(-3)).toEqual([
      "sandbox.stopped",
      "run.interrupted",
      "sandbox.credentials_revoked",
    ]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      outcome: "failed",
      reason: "disappeared",
      checkpointId: "ckpt_periodic",
      unsavedWorkWarning: `The sandbox was lost. Work since the checkpoint at ${HEAD_SHA.slice(0, 7)} was not kept.`,
    });
    expect((await eventsOfType(world.stub, "run.interrupted"))[0]).toMatchObject({
      runId: "run_1",
      payload: { reason: "sandbox_lost", resumableFrom: "ckpt_periodic" },
    });
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({
      reason: "disappeared",
      grants: expect.arrayContaining([{ kind: "model", outcome: "revoked" }]),
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "interrupted",
      outcome: null,
    });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "failed", provider: "modal" },
    ]);
    expect(await probeRow(world.stub, 1)).toBeNull();
    expect(await endedGenerationInD1(world.sessionId)).toBe(1);
    expect(await dispatchRows(world.stub)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ state: "sent" })]),
    );
  });

  it("fails a run that never started when the provider reports the sandbox stopped", async () => {
    const { world, bridge } = await lostBridge("sess_lost_provisioning", { ready: false });
    await closeAndWaitForProbe(world, bridge);
    world.setController((operation) =>
      operation === "getStatus" ? Response.json({ kind: "ok", value: "stopped" }) : undefined,
    );

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect((await eventTypes(world.stub)).slice(-3)).toEqual([
      "sandbox.stopped",
      "sandbox.credentials_revoked",
      "run.failed",
    ]);
    expect((await eventsOfType(world.stub, "run.failed"))[0]?.payload).toMatchObject({
      stage: "provisioning",
      error: {
        category: "sandbox_lost",
        message: expect.stringMatching(/before any checkpoint was saved/),
      },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "failed",
      outcome: "failed",
    });
  });

  it("leaves a run that already ended alone when its sandbox is lost", async () => {
    const { world, bridge } = await lostBridge("sess_lost_ended");
    await finishRun(world, bridge);
    await closeAndWaitForProbe(world, bridge);
    world.setController((operation) =>
      operation === "getStatus" ? Response.json({ kind: "ok", value: "stopped" }) : undefined,
    );

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect((await eventTypes(world.stub)).slice(-2)).toEqual([
      "sandbox.stopped",
      "sandbox.credentials_revoked",
    ]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "completed_with_warnings" });
  });

  it("asks once more after a live answer and leaves the sandbox alone after an unknown one", async () => {
    const { world, bridge } = await lostBridge("sess_lost_live");
    await closeAndWaitForProbe(world, bridge);
    const events = await eventCount(world.stub);

    await ageProbe(world.stub, 1);
    const firstAt = Date.now();
    await fireAlarm(world.stub);
    const retry = await probeRow(world.stub, 1);
    expect(retry?.attempts).toBe(1);
    expect(retry?.due_at_ms as number).toBeGreaterThanOrEqual(firstAt + PROBE_DELAYS_MS[1]);
    expect(await storedAlarm(world.stub)).toBe(retry?.due_at_ms);

    world.setController((operation) =>
      operation === "getStatus" ? controllerRefusal("the controller did not answer") : undefined,
    );
    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect(await probeRow(world.stub, 1)).toBeNull();
    expect(world.controllerCalls.filter((call) => call.operation === "getStatus")).toHaveLength(2);
    expect(await eventCount(world.stub)).toBe(events);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "active", provider: "modal" },
    ]);
  });

  it.each([
    ["the workspace has no Modal connection", { modalConnected: false }],
    ["the keyring is not configured", { envOverrides: { ONCUE_BROKER_KEYRING: "" } }],
  ])("answers unknown, without asking the provider, when %s", async (_name, options) => {
    const world = await sessionOnRealDriver(`sess_lost_${Object.keys(options)[0]}`, options);
    const bridge = await connectBridge(world);
    await bridge.hello();
    await closeAndWaitForProbe(world, bridge);

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect(await probeRow(world.stub, 1)).toMatchObject({ attempts: 1 });
    expect(world.controllerCalls.filter((call) => call.operation === "getStatus")).toEqual([]);
    await setObjectEnv(world, { ONCUE_BROKER_KEYRING: REAL_KEYRING_VALUE });
  });

  it("a reconnecting bridge clears the probe", async () => {
    const { world, bridge } = await lostBridge("sess_lost_reconnect");
    await closeAndWaitForProbe(world, bridge);

    const again = await connectBridge(world, 1);
    await again.hello();

    expect(await probeRow(world.stub, 1)).toBeNull();
    await ageEvents(world.stub, 0);
    await fireAlarm(world.stub);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
  });

  it("fails a running run that never checkpointed, at execution, when the provider says not_found", async () => {
    const { world, bridge } = await lostBridge("sess_lost_running_no_checkpoint");
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    await closeAndWaitForProbe(world, bridge);
    world.setController((operation) =>
      operation === "getStatus"
        ? Response.json(
            { kind: "error", category: "not_found", message: "no such sandbox", retryable: false },
            { status: 404 },
          )
        : undefined,
    );

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    // Record 01: `failed` with no checkpoint known is `failed`, because
    // nothing could resume the run's position.
    expect((await eventTypes(world.stub)).slice(-3)).toEqual([
      "sandbox.stopped",
      "sandbox.credentials_revoked",
      "run.failed",
    ]);
    expect(await eventsOfType(world.stub, "run.interrupted")).toEqual([]);
    expect((await eventsOfType(world.stub, "run.failed"))[0]).toMatchObject({
      runId: "run_1",
      payload: {
        stage: "execution",
        error: {
          category: "sandbox_lost",
          message: expect.stringMatching(/before any checkpoint was saved/),
        },
      },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({
      state: "failed",
      outcome: "failed",
    });
    expect(await probeRow(world.stub, 1)).toBeNull();
  });

  it("commits no loss until the credentials are revoked, and none for a generation the user's stop took over meanwhile", async () => {
    const { world, bridge } = await lostBridge("sess_lost_beside_user_stop", { repository: true });
    await closeAndWaitForProbe(world, bridge);
    world.setController((operation) =>
      operation === "getStatus"
        ? Response.json(
            { kind: "error", category: "not_found", message: "no such sandbox", retryable: false },
            { status: 404 },
          )
        : undefined,
    );
    // The clone token is still held, so the loss's revocation goes to GitHub,
    // which takes three seconds to answer.
    const revoke = slowGitHub(
      world,
      (url, method) => method === "DELETE" && url.endsWith("/installation/token"),
      3_000,
    );
    const events = await eventCount(world.stub);

    // The runtime delivers the alarm itself, so no second one races it: calling
    // `alarm()` directly would let the one its own `rearm` arms run beside it.
    await ageProbe(world.stub, 1);
    await armAlarmNow(world.stub);
    await waitFor(() => revoke.held() >= 1, "the loss's revocation to reach GitHub");

    // An object evicted now would find the probe still owed and ask again.
    expect(await eventCount(world.stub)).toBe(events);
    expect(await probeRow(world.stub, 1)).not.toBeNull();
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "active", provider: "modal" },
    ]);

    const result = await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    expect(result).toEqual({ kind: "stopped", generation: 1 });
    await waitFor(
      () => world.github.calls.some((call) => call.method === "DELETE"),
      "the loss's revocation to return",
    );
    await settle();

    expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      outcome: "stopped",
      reason: "user_requested",
    });
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    // The probe the loss left behind is owed by nothing now; the next alarm clears it.
    await armAlarmNow(world.stub);
    await waitFor(async () => (await probeRow(world.stub, 1)) === null, "the probe to clear");
  });

  it("does not schedule a probe for a generation the object stopped itself, and leases each step while it runs", async () => {
    const world = await sessionOnRealDriver("sess_lost_after_stop");
    const bridge = await readyBridge(world, 1, { closeOnShutdown: false });
    const stopping = world.stub.fetch("https://do/internal/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    });
    // The bridge keeps listening, so the terminate step waits out the
    // shutdown grace; the row is leased for the length of the step.
    await waitFor(() => bridge.commands("runtime.shutdown").length >= 1, "the shutdown");
    const leased = await stopRow(world.stub, 1);
    expect(leased).toMatchObject({ step: "terminate", attempts: 0 });
    expect(leased?.due_at_ms as number).toBeGreaterThan(Date.now());
    expect(leased?.due_at_ms as number).toBeLessThanOrEqual(Date.now() + STEP_LEASE_MS);
    // Armed for the end of the lease before the effect ran, so an object
    // evicted mid-step still wakes to finish the stop, well before the ceiling.
    expect(await storedAlarm(world.stub)).toBe(leased?.due_at_ms);
    expect(await (await stopping).json()).toEqual({ kind: "stopped", generation: 1 });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    const events = await eventCount(world.stub);
    bridge.close();
    await serverSocketsClosed(world);
    await settle();
    expect(await probeRow(world.stub, 1)).toBeNull();
    expect(await eventCount(world.stub)).toBe(events);
  });
});

describe("a run paused on a rejected key", () => {
  type FailureCategory = "authentication_failed" | "usage_limit_reached" | "model_unavailable";

  /** The bridge's own pause for a model failure, as `runPausedDraft` builds it. */
  function pauseFor(bridge: TestBridge, category: FailureCategory) {
    return bridge.event("run.paused", {
      runId: "run_1",
      payload: {
        reason: "model_failure",
        detail: `Model request failed: ${category}`,
        modelFailure: { category, message: "The provider refused the request.", retries: 0 },
        checkpointId: null,
      },
    });
  }

  /** A repository session whose run is working: the clone token is spent and the run has started. */
  async function workingRepositoryWorld(sessionId: string) {
    const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    const git = bridge.grants("git")[0] as Record<string, unknown>;
    const model = bridge.grants("model")[0] as Record<string, unknown>;
    bridge.ack({ grantId: String(git.grantId) });
    bridge.ack({ grantId: String(model.grantId) });
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the clone token's revocation",
    );
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    return { world, bridge };
  }

  async function paused(world: World) {
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "paused",
      "the pause",
    );
  }

  /**
   * What an eviction leaves the next wake: the bridge's socket closed, and
   * nothing the object kept only in memory (the tokens it minted, the grant
   * deadlines, the outbox retry). Storage and the alarm are untouched.
   */
  async function evict(world: World, bridge: TestBridge) {
    bridge.close();
    await serverSocketsClosed(world);
    await settle();
    await runInDurableObject(world.stub, (instance) => {
      instance.volatileGitTokens.clear();
      instance.bridgeSpentPushGrants.clear();
      instance.gitGrantDeadlineMs = null;
      instance.pushGrantDeadlineMs = null;
      instance.outboxDueAtMs = null;
      instance.secretGrantDeadlineMs = null;
      instance.secretGrantDeadlineLoaded = false;
      instance.pendingRedactionSecrets = [];
      instance.redactorGeneration = null;
    });
  }

  it("checkpoints and stops the sandbox at once, with no idle period, and leaves the run paused", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key");
    const pausedAt = Date.now();

    // Nothing ages the log and nothing fires the alarm: the pause alone is enough.
    bridge.send(pauseFor(bridge, "authentication_failed"));
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");

    expect(bridge.commands("checkpoint.create")[0]).toMatchObject({
      command: { payload: { reason: "idle" } },
      runId: null,
    });
    expect(bridge.grants("push")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({
      cause: "idle",
      step: "awaiting_checkpoint",
      interrupted_run_id: null,
    });
    const idle = (await eventsOfType(world.stub, "sandbox.idle"))[0]?.payload as {
      idleSince: string;
      stopAt: string;
      keepAliveUntil: string | null;
    };
    expect(idle.keepAliveUntil).toBeNull();
    // Idle since the pause, not since twenty minutes before the stop.
    expect(Date.parse(idle.stopAt) - Date.parse(idle.idleSince)).toBeLessThan(MIN);
    expect(Date.parse(idle.stopAt) - pausedAt).toBeLessThan(MIN);

    reportCheckpoint(bridge, { checkpointId: "ckpt_rejected", headSha: HEAD_SHA });
    await waitForStop(world);

    const types = await eventTypes(world.stub);
    const at = (type: string) => types.indexOf(type);
    expect(at("run.paused")).toBeLessThan(at("sandbox.idle"));
    expect(at("sandbox.idle")).toBeLessThan(at("sandbox.checkpointed"));
    expect(at("sandbox.checkpointed")).toBeLessThan(at("sandbox.credentials_revoked"));
    expect(at("sandbox.credentials_revoked")).toBeLessThan(at("sandbox.stopped"));
    expect((await eventsOfType(world.stub, "sandbox.stopped")).map((e) => e.payload)).toEqual([
      {
        outcome: "stopped",
        reason: "idle",
        checkpointId: "ckpt_rejected",
        unsavedWorkWarning: null,
        diagnostics: [],
      },
    ]);
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({ reason: "idle" });
    // The run is neither cancelled nor paused a second time: Continue still has it.
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused", outcome: null });
    expect(await eventsOfType(world.stub, "run.paused")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "run.cancelled")).toEqual([]);
    expect(await eventsOfType(world.stub, "run.interrupted")).toEqual([]);
    expect(bridge.commands("runtime.shutdown")[0]).toMatchObject({
      command: { payload: { reason: "idle" } },
    });
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    expect(await endedGenerationInD1(world.sessionId)).toBe(1);
    expect(await storedAlarm(world.stub)).toBeNull();
  });

  it("does each step once however often the alarm fires", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key_twice");
    bridge.send(pauseFor(bridge, "authentication_failed"));
    await paused(world);

    // Fired by hand on top of the alarm the pause armed, before and during the stop.
    await Promise.all([fireAlarm(world.stub), fireAlarm(world.stub)]);
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");
    await fireAlarm(world.stub);
    await fireAlarm(world.stub);
    await settle();

    expect(bridge.commands("checkpoint.create")).toHaveLength(1);
    expect(bridge.grants("push")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "awaiting_checkpoint" });

    reportCheckpoint(bridge, { checkpointId: "ckpt_once", headSha: HEAD_SHA });
    await waitForStop(world);
    const events = await eventCount(world.stub);
    await fireAlarm(world.stub);
    await fireAlarm(world.stub);

    expect(await eventCount(world.stub)).toBe(events);
    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toHaveLength(1);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
  });

  it("an object evicted while the stop waits for its checkpoint finishes the stop from what it stored", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key_evicted");
    bridge.send(pauseFor(bridge, "authentication_failed"));
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");
    const waiting = await stopRow(world.stub, 1);
    expect(waiting).toMatchObject({ cause: "idle", step: "awaiting_checkpoint" });

    await evict(world, bridge);

    // The stop and the alarm for its deadline are what the next wake starts from.
    expect(await stopRow(world.stub, 1)).toEqual(waiting);
    expect(await storedAlarm(world.stub)).toBe(waiting?.due_at_ms);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
    // An alarm before the deadline finds the stop waiting and starts no second one.
    await fireAlarm(world.stub);
    expect(await stopRow(world.stub, 1)).toEqual(waiting);

    // The bridge dials back in and reports the checkpoint it was asked for.
    const back = await connectBridge(world, 1, { closeOnShutdown: true });
    await back.hello();
    reportCheckpoint(back, { checkpointId: "ckpt_after_eviction", headSha: HEAD_SHA });
    await waitForStop(world);

    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect((await eventsOfType(world.stub, "sandbox.stopped")).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        reason: "idle",
        checkpointId: "ckpt_after_eviction",
        unsavedWorkWarning: null,
      }),
    ]);
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
  });

  it("an object evicted mid-stop whose bridge never returns still stops, saying the checkpoint did not finish", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key_evicted_alone");
    bridge.send(pauseFor(bridge, "authentication_failed"));
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");

    await evict(world, bridge);
    await ageStop(world.stub, 1);
    await fireAlarm(world.stub);
    await waitForStop(world);

    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: null,
      unsavedWorkWarning: expect.stringMatching(/did not finish in time/),
    });
    expect(world.controllerCalls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
  });

  it("stops a session with no repository at once too, with nothing to checkpoint", async () => {
    const world = await sessionOnRealDriver("sess_rejected_key_no_repo");
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    bridge.send(bridge.event("run.started", { runId: "run_1" }));

    bridge.send(pauseFor(bridge, "authentication_failed"));
    await waitForStop(world);

    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toEqual({
      outcome: "stopped",
      reason: "idle",
      checkpointId: null,
      unsavedWorkWarning: null,
      diagnostics: [],
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
  });

  it("waits out a keep-alive the user asked for, then stops when it ends", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key_kept");
    const kept = (await (
      await world.stub.fetch("https://do/internal/keep-alive", { method: "POST" })
    ).json()) as { kind: string; expiresAt: string };
    expect(kept.kind).toBe("extended");

    bridge.send(pauseFor(bridge, "authentication_failed"));
    await paused(world);
    await settle();
    await fireAlarm(world.stub);

    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
    expect(await stopRow(world.stub, 1)).toBeNull();
    expect(await storedAlarm(world.stub)).toBe(Date.parse(kept.expiresAt));

    // The hour passes.
    const ended = new Date(Date.now() - 1_000).toISOString();
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE event SET envelope_json = json_set(envelope_json, '$.payload.expiresAt', ?) WHERE event_type = 'sandbox.keepalive.updated'",
        ended,
      );
    });
    await fireAlarm(world.stub);
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");

    expect((await eventsOfType(world.stub, "sandbox.idle"))[0]?.payload).toMatchObject({
      keepAliveUntil: ended,
    });
    reportCheckpoint(bridge, { checkpointId: "ckpt_kept", headSha: HEAD_SHA });
    await waitForStop(world);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
  });

  it.each(["usage_limit_reached", "model_unavailable"] as const)(
    "leaves the idle period alone for a run paused on %s",
    async (category) => {
      const { world, bridge } = await workingRepositoryWorld(`sess_paused_${category}`);

      bridge.send(pauseFor(bridge, category));
      await paused(world);
      await settle();
      await fireAlarm(world.stub);

      expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
      expect(await stopRow(world.stub, 1)).toBeNull();
      expect(bridge.commands("checkpoint.create")).toEqual([]);
      const alarm = (await storedAlarm(world.stub)) as number;
      expect(alarm - Date.now()).toBeGreaterThan(19 * MIN);
      expect(alarm - Date.now()).toBeLessThanOrEqual(20 * MIN);

      // Twenty minutes later it stops as any idle sandbox does.
      await ageEvents(world.stub, 30 * MIN);
      await fireAlarm(world.stub);
      await waitFor(
        () => bridge.commands("checkpoint.create").length >= 1,
        "the checkpoint command",
      );
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });
    },
  );

  it("goes by the current run's own pause: a rejected key reported under another run's id stops nothing early", async () => {
    const { world, bridge } = await workingRepositoryWorld("sess_rejected_key_other_run");
    bridge.send(pauseFor(bridge, "usage_limit_reached"));
    await paused(world);

    // Stored as the generation's newest pause, but it is not this run's.
    bridge.send({ ...pauseFor(bridge, "authentication_failed"), runId: "run_other" });
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.paused")).length === 2,
      "the second pause",
    );
    await settle();
    await fireAlarm(world.stub);

    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
    expect(await stopRow(world.stub, 1)).toBeNull();
    const read = (runId: string, generation: number) =>
      runInDurableObject(world.stub, (_instance, state) =>
        readRejectedKeyPause(state.storage.sql, runId, generation),
      );
    expect(await read("run_1", 1)).toBe(false);
    expect(await read("run_other", 1)).toBe(true);
    // A generation with no pause on record has no rejected key to act on.
    expect(await read("run_1", 2)).toBe(false);
  });
});
