// Archiving, restoring, and deleting a session (records 10 and 19) through
// the object's real seams: the real driver over a scripted controller, a
// hand-driven bridge, and the browser's socket.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ageStop,
  attachmentStates,
  createBody,
  eventCount,
  eventsOfType,
  eventTypes,
  finishRun,
  fireAlarm,
  followUpCommand,
  idleStopIssued,
  MODAL_CREDENTIAL,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  readyBridge,
  registerSessionWorlds,
  reportCheckpoint,
  runRowOf,
  runStartCommand,
  sessionGeneration,
  sessionOnRealDriver,
  settle,
  stopRow,
  storedAlarm,
  stubFor,
  TEST_PACING,
  waitFor,
} from "../test/session-world";
import { broadcastToClients } from "./object/commit";
import type { SessionHost } from "./object/host";
import { closeSockets, DELETED_CLOSE_CODE } from "./object/session-state";
import { readPolicy } from "./object/store-session";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD_SHA = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";

type World = Awaited<ReturnType<typeof sessionOnRealDriver>>;

const archive = (world: World, cancelOpenRun = false) =>
  runInDurableObject(world.stub, (instance) =>
    instance.archiveSession({
      requestedByUserId: "user_1",
      modalCredential: MODAL_CREDENTIAL,
      cancelOpenRun,
    }),
  );

const unarchive = (world: World) =>
  runInDurableObject(world.stub, (instance) => instance.unarchiveSession());

const remove = (world: World) =>
  runInDurableObject(world.stub, (instance) =>
    instance.deleteSession({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
  );

async function storedState(world: World): Promise<string> {
  return runInDurableObject(
    world.stub,
    (_instance, state) =>
      state.storage.sql.exec<{ state: string }>("SELECT state FROM session").one().state,
  );
}

async function indexState(sessionId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
    .bind(sessionId)
    .first<{ state: string }>();
  return row?.state ?? null;
}

async function waitForStop(world: World): Promise<void> {
  await waitFor(async () => (await eventTypes(world.stub)).includes("sandbox.stopped"), "the stop");
}

/** A session with no repository whose first run has ended and whose bridge is connected. */
async function quietWorld(sessionId: string) {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
  await finishRun(world, bridge);
  return { world, bridge };
}

/** A session with no repository and a run still executing. */
async function runningWorld(sessionId: string) {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

async function heldMessages(world: World): Promise<Array<{ released: string | null }>> {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<{ released: string | null }>(
      "SELECT released_at AS released FROM queued_message",
    ),
  ]);
}

/** The close a browser sees when it opens the session's socket now. */
async function upgradeCloseCode(world: World): Promise<number> {
  const response = await world.stub.fetch(
    new Request(`https://do/ws/sessions/${world.sessionId}/client?after=0`, {
      headers: { Upgrade: "websocket", "x-oncue-user-id": "user_1" },
    }),
  );
  const socket = response.webSocket as WebSocket;
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
  socket.accept();
  return closed;
}

/** The close a bridge sees when it dials generation 1 now, or the bare status when the upgrade is refused. */
async function bridgeDial(world: World, credential = "any"): Promise<number> {
  const response = await world.stub.fetch(
    new Request(`https://do/ws/bridge/${world.sessionId}/1`, {
      headers: { Upgrade: "websocket", "x-oncue-bridge-credential": credential },
    }),
  );
  if (response.status !== 101) {
    return response.status;
  }
  const socket = response.webSocket as WebSocket;
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
  socket.accept();
  return closed;
}

async function outboxCount(world: World): Promise<number> {
  return runInDurableObject(
    world.stub,
    (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n,
  );
}

describe("archiving a session", () => {
  it("checkpoints like an idle stop before the sandbox stops, and the session turns read-only", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_archive_checkpoint");
    const client = await openClient(world);

    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "stopping" });
    expect(await storedState(world)).toBe("archived");
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the checkpoint");
    expect(bridge.grants("push")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "idle" });

    reportCheckpoint(bridge, { checkpointId: "ckpt_archive", headSha: HEAD_SHA });
    await waitForStop(world);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
      checkpointId: "ckpt_archive",
      unsavedWorkWarning: null,
    });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);

    // Read-only: a new message is refused and nothing provisions.
    await client.send(runStartCommand("cmd_after_archive", "msg_after", "One more thing"));
    const rejected = (await eventsOfType(world.stub, "command.rejected")).at(-1);
    expect(rejected?.payload).toMatchObject({
      commandId: "cmd_after_archive",
      reason: "wrong_state",
      actualState: "archived",
    });
    expect(await sessionGeneration(world.stub)).toBe(1);
  });

  it("refuses while a run is open unless the user confirmed, then cancels the run before stopping", async () => {
    const { world, bridge } = await runningWorld("sess_archive_running");
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_held", "msg_held", "run_1", "running", "run_next"));
    expect(await heldMessages(world)).toEqual([{ released: null }]);

    expect(await archive(world)).toEqual({ kind: "run_open" });
    expect(await storedState(world)).toBe("active");
    expect(bridge.commands("run.cancel")).toEqual([]);

    expect((await archive(world, true)).kind).toBe("archived");
    expect(await storedState(world)).toBe("archived");
    await waitFor(
      () => bridge.commands("run.cancel").length === 1,
      "the cancel reaching the bridge",
    );
    expect((await eventsOfType(world.stub, "run.cancelled"))[0]).toMatchObject({
      runId: "run_1",
      payload: { by: { kind: "user", userId: "user_1" } },
    });
    await waitForStop(world);
    // No repository, so nothing to checkpoint; the stop is still the idle kind.
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "idle",
    });
    // The held message waits rather than starting a run on an archived session.
    await settle();
    expect(await heldMessages(world)).toEqual([{ released: null }]);
    expect(await eventsOfType(world.stub, "run.queued")).toHaveLength(1);
  });

  it("refuses a steer while archived, even on a run still open", async () => {
    const { world } = await runningWorld("sess_archive_steer");
    const client = await openClient(world);
    // Archived by hand with the run left open, which only a crash between the
    // two writes could leave behind.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'archived'");
    });

    await client.send(followUpCommand("cmd_steer", "msg_steer", "run_1", "running"));

    expect((await eventsOfType(world.stub, "command.rejected")).at(-1)?.payload).toMatchObject({
      commandId: "cmd_steer",
      reason: "wrong_state",
      actualState: "archived",
    });
  });

  it("is locked down by the foreign-push incident like an active session, and stays so once restored", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_archive_incident");
    const policy = () =>
      runInDurableObject(world.stub, (_instance, state) => {
        const stored = readPolicy(state.storage.sql).policy;
        return { push: stored.push, pullRequest: stored.pullRequest };
      });
    // Archived with its checkpoint still out: the stop waits on the bridge's push.
    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "stopping" });
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the checkpoint");
    expect((await policy()).push).not.toBe("never");

    const locked = await runInDurableObject(world.stub, (instance) =>
      instance.lockDownAfterForeignPush(),
    );

    expect(locked).toMatchObject({ kind: "locked_down", policyChanged: true });
    expect(await policy()).toEqual({ push: "never", pullRequest: "never" });
    // The lockdown's stop is the user's: it waits for no checkpoint.
    await waitForStop(world);
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "user_requested", step: "done" });
    expect(await storedState(world)).toBe("archived");
    await unarchive(world);
    expect(await policy()).toEqual({ push: "never", pullRequest: "never" });
  });

  it("restoring opens the session again, and the next message resumes it on a new sandbox", async () => {
    const { world } = await quietWorld("sess_archive_restore");
    await archive(world);
    await waitForStop(world);

    expect(await unarchive(world)).toEqual({ kind: "active" });
    expect(await storedState(world)).toBe("active");
    // A second restore is the same answer.
    expect(await unarchive(world)).toEqual({ kind: "active" });

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_resume", "msg_resume", "Pick it back up"));
    await waitFor(
      async () =>
        (await attachmentStates(world.stub)).some(
          (row) => row.generation === 2 && row.state === "attached",
        ),
      "generation 2",
    );
    expect(await sessionGeneration(world.stub)).toBe(2);
    expect((await eventsOfType(world.stub, "sandbox.provisioning")).at(-1)?.payload).toMatchObject({
      reason: "resume",
    });
  });

  it("archives a session with no sandbox running, and archiving again adds nothing", async () => {
    const { world } = await quietWorld("sess_archive_stopped");
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    const events = await eventCount(world.stub);

    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "not_running" });
    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "not_running" });
    expect(await eventCount(world.stub)).toBe(events);
  });

  it("leaves an idle stop already under way to finish as it began", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_archive_during_idle");
    await idleStopIssued(world, bridge);

    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "stopping" });
    expect(bridge.commands("checkpoint.create")).toHaveLength(1);
    expect(await stopRow(world.stub, 1)).toMatchObject({
      cause: "idle",
      step: "awaiting_checkpoint",
    });
  });

  it("stops a sandbox that is still starting without a checkpoint, since nothing is saved yet", async () => {
    const world = await sessionOnRealDriver("sess_archive_starting", { repository: REPOSITORY });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox_attachment SET state = 'ready' WHERE generation = 1");
    });

    expect(await archive(world, true)).toEqual({ kind: "archived", sandbox: "stopped" });
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "user_requested", step: "done" });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "user_requested",
      checkpointId: null,
    });
  });

  it("finds nothing to stop once a ceiling replacement has handed the sandbox over", async () => {
    const { world } = await quietWorld("sess_archive_after_ceiling");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'replaced' WHERE generation = 1",
      );
      state.storage.sql.exec(
        `INSERT INTO sandbox_stop (generation, cause, step, started_at_ms, due_at_ms, attempts)
         VALUES (1, 'lifetime_ceiling', 'done', ?, NULL, 0)`,
        Date.now(),
      );
    });

    expect(await archive(world)).toEqual({ kind: "archived", sandbox: "not_running" });
  });

  it("archives a session whose first run was refused, which has no run to cancel", async () => {
    const { world } = await quietWorld("sess_archive_no_run");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET current_run_id = NULL");
    });

    expect((await archive(world)).kind).toBe("archived");
    expect(await storedState(world)).toBe("archived");
    expect(await eventsOfType(world.stub, "run.cancelled")).toEqual([]);
  });

  it("answers no_session before a session exists and deleting once one is being deleted", async () => {
    const empty = { stub: stubFor("sess_archive_never") } as World;
    expect(await archive(empty)).toEqual({ kind: "no_session" });
    expect(await unarchive(empty)).toEqual({ kind: "no_session" });

    const { world } = await quietWorld("sess_archive_deleting");
    await remove(world);
    expect(await archive(world, true)).toEqual({ kind: "deleting" });
    expect(await unarchive(world)).toEqual({ kind: "deleting" });
    expect(await storedState(world)).toBe("deletion_pending");
  });
});

describe("deleting a session", () => {
  it("closes the session to its sockets and stops its sandbox with no checkpoint, credentials revoked", async () => {
    const world = await sessionOnRealDriver("sess_delete_running", { repository: REPOSITORY });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_held", "msg_held", "run_1", "running", "run_next"));

    expect(await remove(world)).toEqual({ kind: "deleting", sandbox: "stopped" });

    expect(await storedState(world)).toBe("deletion_pending");
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({ reason: "user_requested" });
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      reason: "user_requested",
      checkpointId: null,
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
    ]);
    // The browser's socket is closed, a new one is refused, and the held
    // message never becomes a run.
    expect(
      await runInDurableObject(world.stub, (_instance, state) =>
        state.getWebSockets("client").every((ws) => ws.readyState !== WebSocket.OPEN),
      ),
    ).toBe(true);
    expect(await upgradeCloseCode(world)).toBe(DELETED_CLOSE_CODE);
    await settle();
    expect(await heldMessages(world)).toEqual([{ released: null }]);
    expect(await eventsOfType(world.stub, "run.queued")).toHaveLength(1);

    // A repeated delete finds nothing left to stop and commits nothing.
    const events = await eventCount(world.stub);
    expect(await remove(world)).toEqual({ kind: "deleting", sandbox: "not_running" });
    expect(await eventCount(world.stub)).toBe(events);
  });

  it("answers no_session for an object that never committed one", async () => {
    const empty = { stub: stubFor("sess_delete_never") } as World;
    expect(await remove(empty)).toEqual({ kind: "no_session" });
  });

  it("starts no sandbox for a resume that was on its way when the session was deleted", async () => {
    const { world } = await quietWorld("sess_delete_resuming");
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    // Holds the resume's credential read open, so the delete lands while it waits.
    await runInDurableObject(world.stub, (instance) => {
      const real = instance.openCredential.bind(instance);
      instance.openCredential = async (session) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return real(session);
      };
    });
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_resume", "msg_resume", "Again"));

    expect((await remove(world)).kind).toBe("deleting");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle();

    expect(await sessionGeneration(world.stub)).toBe(1);
    expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
  });

  it("keeps the stop owed when the provider refuses the terminate, and erases only once it ends", async () => {
    const world = await sessionOnRealDriver("sess_delete_refused", {
      controller: (operation) =>
        operation === "stop"
          ? Response.json(
              { kind: "error", category: "unknown", message: "restarting", retryable: true },
              { status: 503 },
            )
          : undefined,
    });
    await readyBridge(world, 1, { closeOnShutdown: true });

    expect(await remove(world)).toEqual({ kind: "deleting", sandbox: "failed" });
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
    expect(await erase()).toEqual({ kind: "stopping" });
    expect(await storedState(world)).toBe("deletion_pending");

    world.setController(null);
    await ageStop(world.stub, 1);
    expect(await erase()).toEqual({ kind: "erased" });
  });
});

describe("a sandbox asked for when the delete arrives", () => {
  const OK = { bridgeUrl: "modal://oncue-sessions/sb-late" };

  /** A stopped session whose next message asks for generation 2, with `operation` held for that generation. */
  async function resumingWith(sessionId: string, operation: string) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { world } = await quietWorld(sessionId);
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    world.setController((called, body) =>
      called === operation && body.generation === 2
        ? held.then(() => Response.json({ kind: "ok", value: OK }))
        : undefined,
    );
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_resume_late", "msg_resume_late", "Again"));
    await waitFor(
      () =>
        world.controllerCalls.some(
          (call) => call.operation === operation && call.body.generation === 2,
        ),
      `generation 2's ${operation}`,
    );
    return { world, release };
  }

  for (const operation of ["create", "start", "getConnection"]) {
    it(`stops the sandbox a ${operation} answers after the delete, and attaches nothing`, async () => {
      const { world, release } = await resumingWith(`sess_late_${operation}`, operation);

      expect((await remove(world)).kind).toBe("deleting");
      // The delete's own stop found no sandbox to end; the object waits for the answer.
      const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
      expect(await erase()).toEqual({ kind: "stopping" });

      release();
      await waitFor(
        () =>
          world.controllerCalls.filter(
            (call) => call.operation === "stop" && call.body.generation === 2,
          ).length >= 2,
        "the second stop for generation 2",
      );
      await settle();
      expect(
        (await eventsOfType(world.stub, "sandbox.attached")).filter(
          (event) => event.sandboxGeneration === 2,
        ),
      ).toEqual([]);
      await waitFor(
        async () => (await erase()).kind === "erased",
        "the erase once nothing is being made",
      );
    });
  }

  it("still attaches nothing when the provider refuses to stop the late sandbox", async () => {
    const { world, release } = await resumingWith("sess_late_refused", "create");
    world.setController((called, body) => {
      if (called === "stop") {
        return Response.json(
          { kind: "error", category: "unknown", message: "restarting", retryable: true },
          { status: 503 },
        );
      }
      return called === "create" && body.generation === 2
        ? new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() =>
            Response.json({ kind: "ok", value: OK }),
          )
        : undefined;
    });

    await remove(world);
    release();
    await waitFor(
      () =>
        world.controllerCalls.filter(
          (call) => call.operation === "stop" && call.body.generation === 2,
        ).length >= 2,
      "the late sandbox's stop",
    );
    await settle();

    expect(
      (await eventsOfType(world.stub, "sandbox.attached")).filter(
        (event) => event.sandboxGeneration === 2,
      ),
    ).toEqual([]);
  });

  it("erases nothing while a resume, a provisioning, a recovery, a starting attachment, or a late stop is owed", async () => {
    const { world } = await quietWorld("sess_erase_waits");
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    await remove(world);
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());

    await runInDurableObject(world.stub, (instance) => {
      instance.resuming = new Promise<void>(() => {});
    });
    expect(await erase()).toEqual({ kind: "stopping" });
    // A provisioning or a stop sweep in this object's memory.
    await runInDurableObject(world.stub, (instance) => {
      instance.resuming = null;
      instance.provisioningsPending = 1;
    });
    expect(await erase()).toEqual({ kind: "stopping" });
    // A provisioning the alarm is recovering after a restart.
    await runInDurableObject(world.stub, (instance) => {
      instance.provisioningsPending = 0;
      instance.provisioningInFlight = 9;
    });
    expect(await erase()).toEqual({ kind: "stopping" });
    // After an eviction only the stored attachment says a sandbox is starting.
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "INSERT INTO sandbox_attachment (generation, provider, state, started_at) VALUES (9, 'modal', 'provisioning', ?)",
        new Date().toISOString(),
      );
    });
    expect(await erase()).toEqual({ kind: "stopping" });
    // A stop by name still owed for a create that may yet land.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM sandbox_attachment WHERE generation = 9");
      state.storage.sql.exec(
        "INSERT INTO late_stop (generation, provider, due_at_ms, attempts) VALUES (9, 'modal', ?, 0)",
        Date.now() + 60_000,
      );
    });
    expect(await erase()).toEqual({ kind: "stopping" });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM late_stop");
    });
    expect(await erase()).toEqual({ kind: "erased" });
  });

  it("a delete during the image build sends no create, and the erase then completes", async () => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let polls = 0;
    const world = await sessionOnRealDriver("sess_delete_during_prepare", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation !== "prepareImage") {
          return undefined;
        }
        polls += 1;
        // Built inside the object's fetch, once the test opens it.
        return opened.then(() =>
          Response.json({ kind: "ok", value: { state: "ready", imageReference: "im-ready" } }),
        );
      },
    });
    await waitFor(() => polls === 1, "the first poll");

    expect((await remove(world)).kind).toBe("deleting");
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
    expect(await erase()).toEqual({ kind: "stopping" });

    open();
    await waitFor(async () => (await erase()).kind === "erased", "the erase", 30_000);
    expect(world.controllerCalls.map((call) => call.operation)).not.toContain("create");
  });

  it("a delete during a create waits for the late stop by name before the erase", async () => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const world = await sessionOnRealDriver("sess_delete_late_stop", {
      awaitAttachment: false,
      // A create that may still land a minute after it is answered.
      pacing: { ...TEST_PACING, createNotAfterMs: 60_000 },
      controller: (operation) =>
        operation === "create"
          ? opened.then(() => Response.json({ kind: "ok", value: {} }))
          : undefined,
    });
    await waitFor(
      () => world.controllerCalls.some((call) => call.operation === "create"),
      "the create",
    );

    expect((await remove(world)).kind).toBe("deleting");
    open();
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
    await waitFor(
      async () =>
        runInDurableObject(
          world.stub,
          (instance, state) =>
            instance.provisioningsPending === 0 &&
            state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM late_stop").one().n ===
              1,
        ),
      "the sweep to finish with the late stop owed",
    );
    expect(await erase()).toEqual({ kind: "stopping" });
    const stops = () => world.controllerCalls.filter((call) => call.operation === "stop").length;
    const before = stops();

    // The late stop falls due: the alarm stops the sandbox by name, then the erase proceeds.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE late_stop SET due_at_ms = ?", Date.now() - 1);
    });
    await fireAlarm(world.stub);
    expect(stops()).toBeGreaterThan(before);
    expect(await erase()).toEqual({ kind: "erased" });
  });
});

describe("the tombstone", () => {
  const create = (world: World, commandId = "cmd_create_1") =>
    runInDurableObject(world.stub, (instance) =>
      instance.createSession(createBody(world.sessionId, { commandId })),
    );

  it("a delete that lands while the create awaits admission makes the create write nothing", async () => {
    const world = { sessionId: "sess_tomb_during", stub: stubFor("sess_tomb_during") } as World;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runInDurableObject(world.stub, (instance) => {
      const real = instance.decideAdmissionNow.bind(instance);
      instance.decideAdmissionNow = async () => {
        await held;
        return real();
      };
    });
    const created = create(world);
    await settle();

    expect(await remove(world)).toEqual({ kind: "no_session" });
    release();

    expect((await created).plan).toBe("deleted");
    expect(await eventCount(world.stub)).toBe(0);
  });

  it("a delete during the first create's dispatch leaves nothing for the erase to miss", async () => {
    const world = { sessionId: "sess_tomb_dispatch", stub: stubFor("sess_tomb_dispatch") } as World;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    await runInDurableObject(world.stub, (instance) => {
      // The fake driver, stated rather than inherited from an earlier world's settings.
      Object.assign((instance as unknown as { env: Env }).env, {
        ONCUE_SANDBOX_CONTROLLER_ORIGIN: "",
        ONCUE_SANDBOX_CONTROLLER_TOKEN: "",
      });
      const real = instance.dispatch.bind(instance);
      instance.dispatch = async (input) => {
        if (input.kind === "command_admitted" && input.command.type === "run.start") {
          reached = true;
          await held;
        }
        return real(input);
      };
    });
    expect((await create(world)).plan).toBe("accept");
    await waitFor(() => reached, "the first run's dispatch");

    expect((await remove(world)).kind).toBe("deleting");
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
    // Still provisioning: the erase waits rather than erasing under it.
    expect(await erase()).toEqual({ kind: "stopping" });

    release();
    await waitFor(async () => (await erase()).kind === "erased", "the erase", 30_000);
    await settle();
    // Nothing was asked of the provider or written after the erase.
    expect(await eventCount(world.stub)).toBe(0);
    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
  });

  it("a delete that reaches the object before its create makes the create refuse", async () => {
    const world = { sessionId: "sess_tomb_first", stub: stubFor("sess_tomb_first") } as World;

    expect(await remove(world)).toEqual({ kind: "no_session" });
    expect((await create(world)).plan).toBe("deleted");

    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
    expect(await eventCount(world.stub)).toBe(0);
  });

  it("a create retried with the same command id after the erase makes nothing again", async () => {
    const { world } = await quietWorld("sess_tomb_retry");
    await remove(world);
    expect(await runInDurableObject(world.stub, (instance) => instance.eraseSession())).toEqual({
      kind: "erased",
    });
    const creates = world.controllerCalls.filter((call) => call.operation === "create").length;

    expect((await create(world)).plan).toBe("deleted");

    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
    expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(
      creates,
    );
  });

  it("refuses a bridge that dials back while the deletion's stop is still owed", async () => {
    const world = await sessionOnRealDriver("sess_tomb_bridge", {
      controller: (operation) =>
        operation === "stop"
          ? Response.json(
              { kind: "error", category: "unknown", message: "restarting", retryable: true },
              { status: 503 },
            )
          : undefined,
    });
    await readyBridge(world, 1, { closeOnShutdown: true });
    expect(await remove(world)).toEqual({ kind: "deleting", sandbox: "failed" });

    // The coded close ends the bridge at once; a bare 404 it would retry.
    expect(await bridgeDial(world)).toBe(4401);
  });

  it("ends a bridge that dials after the erase the same way, and answers 404 where no session ever was", async () => {
    const { world } = await quietWorld("sess_tomb_bridge_erased");
    await remove(world);
    expect(await runInDurableObject(world.stub, (instance) => instance.eraseSession())).toEqual({
      kind: "erased",
    });

    expect(await bridgeDial(world)).toBe(4401);
    const never = { sessionId: "sess_tomb_bridge_never", stub: stubFor("sess_tomb_bridge_never") };
    expect(await bridgeDial(never as World)).toBe(404);
  });
});

describe("an erase and work still in flight", () => {
  const erase = (world: World) =>
    runInDurableObject(world.stub, (instance) => instance.eraseSession());
  const outputAnswer = () =>
    Response.json({
      kind: "ok",
      value: {
        lines: [{ stream: "stdout", at: new Date().toISOString(), text: "the last line" }],
        next: new Date().toISOString(),
      },
    });

  it("waits for a stop still fetching the sandbox's last output, so nothing lands in the emptied object", async () => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let hold = false;
    const world = await sessionOnRealDriver("sess_erase_after_terminate", {
      controller: (operation) =>
        hold && operation === "getOutput" ? opened.then(outputAnswer) : undefined,
    });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    await finishRun(world, bridge);
    hold = true;
    const outputCalls = () =>
      world.controllerCalls.filter((call) => call.operation === "getOutput").length;
    const before = outputCalls();

    // The delete's stop has terminated the sandbox and marked the generation
    // ended; its fetch of the last output is still out.
    const removing = remove(world);
    await waitFor(() => outputCalls() > before, "the last output's fetch");
    expect((await attachmentStates(world.stub)).map((row) => row.state)).toEqual(["stopped"]);

    expect(await erase(world)).toEqual({ kind: "stopping" });
    expect(await storedState(world)).toBe("deletion_pending");

    open();
    expect(await removing).toEqual({ kind: "deleting", sandbox: "stopped" });
    expect(await erase(world)).toEqual({ kind: "erased" });
    await settle();
    expect(await eventCount(world.stub)).toBe(0);
    expect(await outboxCount(world)).toBe(0);
  });

  it("answers stopping when a stop begins while the erase's own provider calls are out", async () => {
    const { world } = await quietWorld("sess_erase_second_check");
    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );
    await remove(world);
    await runInDurableObject(world.stub, (instance) => {
      const real = instance.stopFailedGenerations.bind(instance);
      instance.stopFailedGenerations = async (session) => {
        // Another request's stop starts during the erase's await.
        instance.stopsAdvancing += 1;
        return real(session);
      };
    });

    expect(await erase(world)).toEqual({ kind: "stopping" });
    expect(await storedState(world)).toBe("deletion_pending");

    await runInDurableObject(world.stub, (instance) => {
      instance.stopsAdvancing = 0;
      instance.stopFailedGenerations = async () => true;
    });
    expect(await erase(world)).toEqual({ kind: "erased" });
  });

  it("writes nothing for a caller whose session row predates the erase", async () => {
    const { world } = await quietWorld("sess_erase_stale_commit");
    const stale = await runInDurableObject(world.stub, (instance) => instance.readSession());
    if (stale === null) throw new Error("expected a session");
    await remove(world);
    expect(await erase(world)).toEqual({ kind: "erased" });

    const plan = await runInDurableObject(world.stub, (instance) => {
      // What a stop's last step does when it resumes.
      instance.commitOutputLines(stale, [
        { stream: "stdout", at: new Date().toISOString(), text: "late" },
      ]);
      let wrote = false;
      const committed = instance.commitControlEvents(stale, [], new Date().toISOString(), () => {
        wrote = true;
      });
      const command = runStartCommand("cmd_after_erase", "msg_after_erase", "Too late");
      return {
        committed: committed.length,
        wrote,
        plan: instance.planAndCommit(
          stale,
          { ...command, issuedByUserId: stale.ownerUserId } as never,
          { kind: "admit" },
          new Date().toISOString(),
          "run_after_erase",
          null,
          null,
          true,
        ),
      };
    });

    expect(plan).toEqual({
      committed: 0,
      wrote: false,
      plan: { kind: "already_processed", commandId: "cmd_after_erase" },
    });
    expect(await eventCount(world.stub)).toBe(0);
    expect(await outboxCount(world)).toBe(0);
    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
  });
});

describe("a generation that failed after its create was sent", () => {
  const erase = (world: World) =>
    runInDurableObject(world.stub, (instance) => instance.eraseSession());
  const stops = (world: World) =>
    world.controllerCalls.filter((call) => call.operation === "stop").length;

  /** A session whose only generation failed with a create sent, its sweep and late stop finished. */
  async function failedWorld(sessionId: string, refuseStop: () => boolean) {
    const world = await sessionOnRealDriver(sessionId, {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "create") {
          return Response.json(
            { kind: "error", category: "unknown", message: "no", retryable: true },
            { status: 503 },
          );
        }
        if (operation === "getStatus") {
          return Response.json(
            { kind: "error", category: "not_found", message: "gone", retryable: false },
            { status: 404 },
          );
        }
        if (operation === "stop" && refuseStop()) {
          return Response.json(
            { kind: "error", category: "unknown", message: "restarting", retryable: true },
            { status: 503 },
          );
        }
        return undefined;
      },
    });
    await waitFor(
      async () => (await attachmentStates(world.stub)).some((row) => row.state === "failed"),
      "the failed generation",
      30_000,
    );
    await waitFor(
      async () => runInDurableObject(world.stub, (instance) => instance.provisioningsPending === 0),
      "the sweep",
      30_000,
    );
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM late_stop");
    });
    return world;
  }

  it("is stopped by name once more before the erase", async () => {
    const world = await failedWorld("sess_erase_final_stop", () => false);
    expect((await remove(world)).kind).toBe("deleting");
    const before = stops(world);

    expect(await erase(world)).toEqual({ kind: "erased" });

    const sent = world.controllerCalls.filter((call) => call.operation === "stop").slice(before);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.body)).toContain(world.sessionId);
  });

  it("is erased all the same when that last stop is refused, and the refusal is logged", async () => {
    let refuse = false;
    const world = await failedWorld("sess_erase_final_stop_refused", () => refuse);
    expect((await remove(world)).kind).toBe("deleting");
    refuse = true;
    const logged = vi.spyOn(console, "log");
    try {
      expect(
        await runInDurableObject(world.stub, async (instance) => {
          const session = instance.readSession();
          if (session === null) throw new Error("expected a session");
          return instance.stopFailedGenerations(session);
        }),
      ).toBe(false);
      expect(await erase(world)).toEqual({ kind: "erased" });
      expect(
        logged.mock.calls.some((call) => String(call[0]).includes("failed_sandbox_not_stopped")),
      ).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("asks the provider nothing for a session with no failed generation", async () => {
    const { world } = await quietWorld("sess_erase_no_final_stop");
    await remove(world);
    const before = stops(world);

    expect(await erase(world)).toEqual({ kind: "erased" });
    expect(stops(world)).toBe(before);
  });
});

describe("the deletion job's object steps", () => {
  it("erases everything the object stored, once, and only for a session being deleted", async () => {
    const { world, bridge } = await quietWorld("sess_erase");
    const erase = () => runInDurableObject(world.stub, (instance) => instance.eraseSession());
    expect(await erase()).toEqual({ kind: "not_deleting" });
    expect(await eventCount(world.stub)).toBeGreaterThan(0);

    await remove(world);
    expect(await erase()).toEqual({ kind: "erased" });

    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
    expect(await eventCount(world.stub)).toBe(0);
    expect(await storedAlarm(world.stub)).toBeNull();
    expect(bridge.client.readyState).not.toBe(WebSocket.OPEN);
    expect(await erase()).toEqual({ kind: "erased" });
    expect(await runInDurableObject(world.stub, (instance) => instance.sessionExists())).toEqual({
      exists: false,
    });
  });

  it("reports whether a session was ever committed, for the creating sweep", async () => {
    const { world } = await quietWorld("sess_exists");
    expect(await runInDurableObject(world.stub, (instance) => instance.sessionExists())).toEqual({
      exists: true,
    });
    const empty = stubFor("sess_exists_never");
    expect(await runInDurableObject(empty, (instance) => instance.sessionExists())).toEqual({
      exists: false,
    });
  });

  it("answers each internal route over fetch", async () => {
    const { world } = await quietWorld("sess_internal_routes");
    const call = async (path: string, body: unknown = {}) =>
      (
        await world.stub.fetch(`https://do/internal/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();

    expect(await call("exists")).toEqual({ exists: true });
    // No pair crosses here, so the object opens its own to stop the sandbox.
    expect(await call("archive", { requestedByUserId: "user_1", cancelOpenRun: false })).toEqual({
      kind: "archived",
      sandbox: "stopped",
    });
    expect(await call("unarchive")).toEqual({ kind: "active" });
    expect(await call("deletion/marked")).toEqual({ marked: false });
    expect(await call("delete", { requestedByUserId: "user_1" })).toEqual({
      kind: "deleting",
      sandbox: "not_running",
    });
    expect(await call("deletion/marked")).toEqual({ marked: true });
    expect(await call("deletion/erase")).toEqual({ kind: "erased" });
    // The tombstone outlives the erase.
    expect(await call("deletion/marked")).toEqual({ marked: true });
  });
});

describe("broadcasting to browser sockets", () => {
  it("sends only to open sockets: one the object closed is still listed until the browser answers", () => {
    const sent: string[] = [];
    const socket = (readyState: number, name: string) =>
      ({
        readyState,
        send: (text: string) => sent.push(`${name}:${text}`),
      }) as unknown as WebSocket;
    const host = {
      objectCtx: {
        getWebSockets: () => [
          socket(WebSocket.OPEN, "open"),
          socket(WebSocket.CLOSING, "closing"),
          socket(WebSocket.CLOSED, "closed"),
        ],
      },
    } as unknown as SessionHost;

    broadcastToClients(host, "frame");

    expect(sent).toEqual(["open:frame"]);
  });
});

describe("closing the object's sockets", () => {
  it("closes the open ones and leaves one already closing to finish", () => {
    const closed: string[] = [];
    const socket = (readyState: number, name: string) =>
      ({
        readyState,
        close: (code: number) => closed.push(`${name}:${code}`),
      }) as unknown as WebSocket;
    const asked: Array<string | undefined> = [];
    const host = {
      objectCtx: {
        getWebSockets: (tag?: string) => {
          asked.push(tag);
          return [socket(WebSocket.OPEN, "open"), socket(WebSocket.CLOSING, "closing")];
        },
      },
    } as unknown as SessionHost;

    closeSockets(host, "client");
    closeSockets(host);

    expect(closed).toEqual([`open:${DELETED_CLOSE_CODE}`, `open:${DELETED_CLOSE_CODE}`]);
    expect(asked).toEqual(["client", undefined]);
  });
});

describe("the index row", () => {
  it("is never moved out of deletion_pending or archived by a later projection", async () => {
    const { world, bridge } = await runningWorld("sess_projection_guard");
    await waitFor(async () => (await indexState(world.sessionId)) === "active", "the projection");

    for (const state of ["archived", "deletion_pending"]) {
      await env.DB.prepare("UPDATE session_index SET state = ? WHERE session_id = ?")
        .bind(state, world.sessionId)
        .run();
      const before = await env.DB.prepare(
        "SELECT last_projected_sequence AS s FROM session_index WHERE session_id = ?",
      )
        .bind(world.sessionId)
        .first<{ s: number }>();
      bridge.send(
        bridge.event("status.updated", {
          runId: "run_1",
          payload: {
            stepId: `step_${state}`,
            phase: "implementing",
            label: "Working",
            status: "active",
          },
        }),
      );
      await waitFor(async () => {
        const after = await env.DB.prepare(
          "SELECT last_projected_sequence AS s FROM session_index WHERE session_id = ?",
        )
          .bind(world.sessionId)
          .first<{ s: number }>();
        return (after?.s ?? 0) > (before?.s ?? 0);
      }, "the next projection");
      expect(await indexState(world.sessionId)).toBe(state);
    }
  });
});
