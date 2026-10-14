// Record 02's "Prepare" and create on the real driver: an image still building
// in the workspace, a create whose answer is lost, and a failed generation
// whose sandbox must not be left running.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type ControllerScript,
  createBody,
  eventsOfType,
  fireAlarm,
  MODAL_CREDENTIAL,
  openClient,
  readyBridge,
  registerSessionWorlds,
  runRows,
  runStartCommand,
  type SessionWorld,
  seedSessionIndex,
  sessionOnRealDriver,
  settle,
  storedAlarm,
  stubFor,
  TEST_PACING,
  waitFor,
} from "../test/session-world";
import { DEFAULT_LIFECYCLE_SETTINGS, PROVISION_CHECK_MS, PROVISION_GIVE_UP_MS } from "./lifecycle";
import {
  LATE_STOP_MAX_ATTEMPTS,
  LATE_STOP_RETRY_MS,
  MAX_PREPARE_FAILURES,
  PREPARE_WAIT_MS,
  type ProvisionPacing,
} from "./object/constants";
import {
  IMAGE_BUILDING_NOTE,
  leftRunningNote,
  PROVISIONING_LOST_MESSAGE,
  sandboxName,
} from "./object/provisioning";

vi.setConfig({ testTimeout: 30_000 });
registerSessionWorlds();

function building(): Response {
  return Response.json({ kind: "ok", value: { state: "building" } });
}

function ready(imageReference: string): Response {
  return Response.json({ kind: "ok", value: { state: "ready", imageReference } });
}

function failure(category: string, retryable: boolean, status = 500): Response {
  return Response.json(
    { kind: "error", category, message: `${category} from the controller`, retryable },
    { status },
  );
}

function notFound(): Response {
  return failure("not_found", false, 404);
}

/** A script that answers each operation from its own queue, then falls through to the world's default. */
function queued(
  answers: Record<string, Array<() => Response | Promise<Response>>>,
): ControllerScript {
  return (operation) => {
    const next = answers[operation]?.shift();
    return next === undefined ? undefined : next();
  };
}

function operations(world: SessionWorld): string[] {
  return world.controllerCalls.map((call) => call.operation);
}

async function controllerLines(world: SessionWorld): Promise<string[]> {
  return (await eventsOfType(world.stub, "sandbox.output")).flatMap((event) => {
    const payload = event.payload as { stream: string; lines: { text: string }[] };
    return payload.stream === "controller" ? payload.lines.map((line) => line.text) : [];
  });
}

async function provisioningFailure(world: SessionWorld): Promise<Record<string, unknown>> {
  await waitFor(
    async () => (await eventsOfType(world.stub, "run.failed")).length === 1,
    "the run to fail",
  );
  return (await eventsOfType(world.stub, "run.failed"))[0]?.payload as Record<string, unknown>;
}

const SWEEP: ProvisionPacing = { ...TEST_PACING, failedStopDelaysMs: [0, 1, 1] };

describe("preparing the image before a create", () => {
  it("waits out a cold build, says so once, and creates from the prepared image", async () => {
    const world = await sessionOnRealDriver("sess_prov_cold", {
      controller: queued({ prepareImage: [building, building, () => ready("im-cold")] }),
    });

    expect(operations(world).slice(0, 4)).toEqual([
      "prepareImage",
      "prepareImage",
      "prepareImage",
      "create",
    ]);
    expect(world.controllerCalls[0]?.body).toEqual({ waitMs: PREPARE_WAIT_MS });
    const create = world.controllerCalls[3]?.body as Record<string, unknown>;
    expect(create.imageReference).toBe("im-cold");
    // The deadline travels with the create, so the controller starts nothing
    // after it, and the object records it for the stop sweep.
    expect(await createDeadline(world)).toBe(Date.parse(String(create.notAfter)));
    const lines = await controllerLines(world);
    expect(lines.filter((line) => line === IMAGE_BUILDING_NOTE)).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("prepareImage answered in"))).toBe(true);
  });

  it("asks again after a retryable failure", async () => {
    const world = await sessionOnRealDriver("sess_prov_prepare_retry", {
      controller: queued({ prepareImage: [() => failure("capacity", true, 503)] }),
    });

    expect(operations(world).slice(0, 3)).toEqual(["prepareImage", "prepareImage", "create"]);
    // A failure is not a build, so nothing claims one is under way.
    expect(await controllerLines(world)).not.toContain(IMAGE_BUILDING_NOTE);
  });

  it("fails after a few failed polls in a row, rather than polling a dead controller for the whole budget", async () => {
    const world = await sessionOnRealDriver("sess_prov_prepare_unanswered", {
      awaitAttachment: false,
      controller: (operation) =>
        operation === "prepareImage"
          ? Promise.reject(new Error("the request timed out"))
          : undefined,
    });

    const failed = await provisioningFailure(world);
    expect(failed).toMatchObject({ stage: "provisioning", error: { category: "unknown" } });
    const message = String((failed.error as { message: string }).message);
    expect(message).toContain(`${MAX_PREPARE_FAILURES} tries in a row failed`);
    expect(message).toContain("The sandbox controller did not answer.");
    await settle();
    expect(operations(world)).toEqual(Array(MAX_PREPARE_FAILURES).fill("prepareImage"));
  });

  it("counts only failures in a row, so a build that is under way keeps its whole budget", async () => {
    const failing = () => failure("unknown", true);
    const almost = Array(MAX_PREPARE_FAILURES - 1).fill(failing);
    const world = await sessionOnRealDriver("sess_prov_prepare_interleaved", {
      controller: queued({
        prepareImage: [...almost, building, ...almost, () => ready("im-after-failures")],
      }),
    });

    const create = world.controllerCalls.find((call) => call.operation === "create");
    expect(create?.body.imageReference).toBe("im-after-failures");
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
  });

  it("fails at once on a failure no retry can clear, and creates and stops nothing", async () => {
    const world = await sessionOnRealDriver("sess_prov_prepare_refused", {
      awaitAttachment: false,
      controller: queued({ prepareImage: [() => failure("image_preparation", false)] }),
    });

    expect(await provisioningFailure(world)).toMatchObject({
      stage: "provisioning",
      error: { category: "image_preparation" },
    });
    await settle();
    expect(operations(world)).toEqual(["prepareImage"]);
  });

  it("gives up when the budget runs out, keeps the last failure's reason, and creates nothing", async () => {
    const world = await sessionOnRealDriver("sess_prov_prepare_budget_failing", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, prepareBudgetMs: 60, minPreparePollMs: 20 },
      controller: () => failure("unknown", true),
    });

    expect(await provisioningFailure(world)).toMatchObject({
      error: { category: "unknown", message: "unknown from the controller" },
    });
    await settle();
    expect(operations(world).every((operation) => operation === "prepareImage")).toBe(true);
  });

  it("gives up on a build that outlasts the budget, saying the build continues", async () => {
    const world = await sessionOnRealDriver("sess_prov_prepare_budget", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, prepareBudgetMs: 60, minPreparePollMs: 20 },
      controller: (operation) => (operation === "prepareImage" ? building() : undefined),
    });

    const failed = await provisioningFailure(world);
    expect(failed).toMatchObject({ error: { category: "image_preparation" } });
    expect(String((failed.error as { message: string }).message)).toContain("The build continues");
    await settle();
    expect(operations(world).every((operation) => operation === "prepareImage")).toBe(true);
  });

  it("abandons the generation without creating when it ends during the build", async () => {
    let polls = 0;
    const world = await sessionOnRealDriver("sess_prov_prepare_abandoned", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, minPreparePollMs: 150 },
      controller: (operation) => {
        if (operation !== "prepareImage") {
          return undefined;
        }
        polls += 1;
        return building();
      },
    });
    await waitFor(() => polls >= 1, "the first poll");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'stopped' WHERE generation = 1",
      );
    });
    await waitFor(() => polls >= 2, "the poll after the stop");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(polls).toBe(2);
    expect(operations(world)).not.toContain("create");
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
  });
});

describe("a create whose answer does not come", () => {
  it("adopts the sandbox the lost create started, and creates nothing more", async () => {
    const world = await sessionOnRealDriver("sess_prov_adopt", {
      controller: queued({
        create: [() => Promise.reject(new Error("the request timed out"))],
        getStatus: [() => Response.json({ kind: "ok", value: "active" })],
      }),
    });

    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(1);
    expect(await controllerLines(world)).toContain(
      "create did not succeed, but the sandbox was found running and adopted",
    );
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ state: "provisioning" })]);
  });

  it("creates again, for the same generation, when the lost create left nothing", async () => {
    const world = await sessionOnRealDriver("sess_prov_retry", {
      controller: queued({
        create: [() => failure("unknown", true)],
        getStatus: [notFound],
      }),
    });

    const creates = world.controllerCalls.filter((call) => call.operation === "create");
    expect(creates.map((call) => call.body.generation)).toEqual([1, 1]);
    expect(
      (await controllerLines(world)).some((line) =>
        line.startsWith("create attempt 2 answered in"),
      ),
    ).toBe(true);
  });

  it("fails without retrying when the sandbox started and already exited", async () => {
    const world = await sessionOnRealDriver("sess_prov_exited", {
      awaitAttachment: false,
      controller: queued({
        create: [() => failure("unknown", true)],
        getStatus: [() => Response.json({ kind: "ok", value: "failed" })],
      }),
    });

    expect(await provisioningFailure(world)).toMatchObject({
      error: { message: "The sandbox started and exited before the session could attach to it." },
    });
    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(1);
  });

  it("does not retry a failure no retry can clear", async () => {
    const world = await sessionOnRealDriver("sess_prov_create_refused", {
      awaitAttachment: false,
      controller: queued({ create: [() => failure("configuration", false, 400)] }),
    });

    await provisioningFailure(world);
    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(1);
    expect(operations(world)).not.toContain("getStatus");
  });
});

describe("a failed generation's sandbox", () => {
  it("is stopped by name after every attempt fails, more than once, though no id was ever learned", async () => {
    const world = await sessionOnRealDriver("sess_prov_sweep", {
      awaitAttachment: false,
      pacing: SWEEP,
      controller: (operation) => {
        if (operation === "create") {
          return failure("unknown", true);
        }
        return operation === "getStatus" ? notFound() : undefined;
      },
    });

    await provisioningFailure(world);
    await waitFor(
      () => operations(world).filter((operation) => operation === "stop").length === 3,
      "three stops",
    );
    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(3);
    const stop = world.controllerCalls.find((call) => call.operation === "stop");
    expect(stop?.body).toEqual({ sessionId: "sess_prov_sweep", generation: 1 });
    await settle();
    expect(await controllerLines(world)).not.toContain(
      leftRunningNote(sandboxName("sess_prov_sweep", 1)),
    );
    // A stop got through once no create could land, so nothing more is owed.
    expect(await lateStopRows(world)).toEqual([]);
  });

  /** A world whose create is refused and whose stops the controller never completes. */
  function unstoppable(sessionId: string): Promise<SessionWorld> {
    return sessionOnRealDriver(sessionId, {
      awaitAttachment: false,
      pacing: SWEEP,
      controller: (operation) => {
        if (operation === "create") {
          return failure("configuration", false, 400);
        }
        return operation === "stop" ? failure("unknown", true) : undefined;
      },
    });
  }

  const stops = (world: SessionWorld) =>
    operations(world).filter((operation) => operation === "stop").length;

  /** Makes generation 1's late stop due now, as the passing of time would. */
  function lateStopDue(world: SessionWorld, attempts: number): Promise<void> {
    return runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE late_stop SET due_at_ms = ?, attempts = ? WHERE generation = 1",
        Date.now() - 1,
        attempts,
      );
    });
  }

  it("stays owed, durably, when the controller answered none of the sweep's stops", async () => {
    const began = Date.now();
    const world = await unstoppable("sess_prov_stop_owed");

    await provisioningFailure(world);
    // Owed from the moment the generation failed, not from the sweep's end:
    // an eviction mid-sweep must find it.
    const owed = await lateStopRows(world);
    expect(owed).toEqual([expect.objectContaining({ generation: 1, attempts: 0 })]);
    expect(owed[0]?.due_at_ms as number).toBeGreaterThanOrEqual(began + LATE_STOP_RETRY_MS);
    await waitFor(() => stops(world) === 3, "the sweep's three stops");
    await settle();

    expect(await lateStopRows(world)).toEqual(owed);
    // The sweep itself claims nothing: the late stops may yet succeed.
    expect(await controllerLines(world)).not.toContain(
      leftRunningNote(sandboxName("sess_prov_stop_owed", 1)),
    );

    world.setController((operation) =>
      operation === "create" ? failure("configuration", false, 400) : undefined,
    );
    await lateStopDue(world, 0);
    await fireAlarm(world.stub);

    expect(stops(world)).toBe(4);
    expect(await lateStopRows(world)).toEqual([]);
    expect(await controllerLines(world)).not.toContain(
      leftRunningNote(sandboxName("sess_prov_stop_owed", 1)),
    );
  });

  it("is named on the timeline once, and only when the late stops give up", async () => {
    const world = await unstoppable("sess_prov_left_running");
    const note = leftRunningNote(sandboxName("sess_prov_left_running", 1));

    await provisioningFailure(world);
    await waitFor(() => stops(world) === 3, "the sweep's three stops");
    await settle();
    await lateStopDue(world, 0);
    await fireAlarm(world.stub);
    expect(await lateStopRows(world)).toEqual([
      expect.objectContaining({ generation: 1, attempts: 1 }),
    ]);
    expect(await controllerLines(world)).not.toContain(note);

    await lateStopDue(world, LATE_STOP_MAX_ATTEMPTS - 1);
    await fireAlarm(world.stub);
    await fireAlarm(world.stub);

    expect(await lateStopRows(world)).toEqual([]);
    expect((await controllerLines(world)).filter((line) => line === note)).toHaveLength(1);
    expect(note).toContain("s-sess_prov_left_running-g1");
  });

  it("owes the same stop after a recovery gives up on a controller that never answered", async () => {
    const world = await sessionOnRealDriver("sess_prov_recover_stop_owed", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        return operation === "getStatus" || operation === "stop"
          ? failure("unknown", true)
          : undefined;
      },
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - PROVISION_GIVE_UP_MS - 1_000).toISOString(),
      );
    });

    await fireAlarm(world.stub);

    await provisioningFailure(world);
    expect(await lateStopRows(world)).toEqual([
      expect.objectContaining({ generation: 1, attempts: 0 }),
    ]);
  });
});

describe("sandbox names", () => {
  it("match the controller's, truncating the session id and keeping the generation", () => {
    expect(sandboxName("sess_1", 2)).toBe("s-sess_1-g2");
    const long = sandboxName("x".repeat(80), 12);
    expect(long).toHaveLength(64);
    expect(long.endsWith("-g12")).toBe(true);
  });
});

describe("a provisioning that throws", () => {
  it("is logged, since the create request it ran after has already been answered", async () => {
    const sessionId = "sess_prov_throws";
    await seedSessionIndex(sessionId, "ws_1");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      await runInDurableObject(stubFor(sessionId), async (instance) => {
        instance.provisionSandbox = () => Promise.reject(new Error("a bug in the object"));
        await instance.createSession(createBody(sessionId));
      });
      await waitFor(() => logged.some((line) => line.includes('"result":"threw"')), "the log line");
    } finally {
      spy.mockRestore();
    }
    const line = JSON.parse(logged.find((entry) => entry.includes('"result":"threw"')) as string);
    expect(line).toMatchObject({ operation: "session.provision", sessionId, severity: "error" });
    expect(JSON.stringify(line)).not.toContain("a bug in the object");
  });
});

describe("a provisioning the object lost to a restart", () => {
  /**
   * A world whose image never finishes preparing, so the generation stays
   * `provisioning`; then the object's memory forgets it, as a restart would,
   * and the generation is old enough for the alarm's check.
   */
  async function lostProvisioning(
    sessionId: string,
    ageMs: number,
    script: ControllerScript,
  ): Promise<SessionWorld> {
    const world = await sessionOnRealDriver(sessionId, {
      awaitAttachment: false,
      controller: (operation, body) =>
        operation === "prepareImage"
          ? new Promise<Response>(() => undefined)
          : script(operation, body),
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - ageMs).toISOString(),
      );
    });
    return world;
  }

  it("adopts a sandbox found running, since its bridge holds the stored credential", async () => {
    const world = await lostProvisioning("sess_prov_recover_adopt", 2 * PROVISION_CHECK_MS, (op) =>
      op === "getStatus" ? Response.json({ kind: "ok", value: "active" }) : undefined,
    );

    await fireAlarm(world.stub);

    expect(await eventsOfType(world.stub, "sandbox.attached")).toHaveLength(1);
    expect((await controllerLines(world)).join("\n")).toContain(
      "found the sandbox running and adopted it",
    );
    expect(operations(world)).not.toContain("create");
  });

  it("fails the generation, and stops whatever it started, when no sandbox runs", async () => {
    const world = await lostProvisioning("sess_prov_recover_gone", 2 * PROVISION_CHECK_MS, (op) =>
      op === "getStatus" ? notFound() : undefined,
    );

    await fireAlarm(world.stub);

    expect(await provisioningFailure(world)).toMatchObject({
      stage: "provisioning",
      error: { message: PROVISIONING_LOST_MESSAGE },
    });
    await waitFor(() => operations(world).includes("stop"), "the stop");
  });

  it("asks again later while the provider cannot answer, then gives up", async () => {
    const world = await lostProvisioning(
      "sess_prov_recover_unanswered",
      2 * PROVISION_CHECK_MS,
      (op) => (op === "getStatus" ? failure("unknown", true) : undefined),
    );

    await fireAlarm(world.stub);
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);

    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - PROVISION_GIVE_UP_MS - 1_000).toISOString(),
      );
    });
    await fireAlarm(world.stub);

    expect(await provisioningFailure(world)).toMatchObject({
      error: { message: "unknown from the controller" },
    });
  });

  it("fails when the sandbox runs but will not name itself", async () => {
    const world = await lostProvisioning(
      "sess_prov_recover_no_connection",
      2 * PROVISION_CHECK_MS,
      (op) => {
        if (op === "getStatus") {
          return Response.json({ kind: "ok", value: "active" });
        }
        return op === "getConnection" ? notFound() : undefined;
      },
    );

    await fireAlarm(world.stub);

    expect(await provisioningFailure(world)).toMatchObject({ error: { category: "not_found" } });
  });

  it("fails without asking when the workspace's Modal pair cannot be opened", async () => {
    const world = await lostProvisioning(
      "sess_prov_recover_no_pair",
      2 * PROVISION_CHECK_MS,
      () => undefined,
    );
    await env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
      .bind(world.workspaceId)
      .run();

    await fireAlarm(world.stub);

    expect(await provisioningFailure(world)).toMatchObject({
      error: { message: PROVISIONING_LOST_MESSAGE },
    });
    expect(operations(world)).not.toContain("getStatus");
  });

  it("does not hold the alarm while the adopted sandbox's output is relayed", async () => {
    const world = await lostProvisioning("sess_prov_recover_relay", 2 * PROVISION_CHECK_MS, (op) =>
      op === "getOutput" ? new Promise<Response>(() => undefined) : undefined,
    );

    const fired = await Promise.race([
      fireAlarm(world.stub).then(() => "returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("held"), 5_000)),
    ]);

    expect(fired).toBe("returned");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toHaveLength(1);
    expect(operations(world)).toContain("getOutput");
  });

  it("marks the generation failed, and stops what it started, when the session is no longer active and no stop owns it", async () => {
    const world = await lostProvisioning(
      "sess_prov_recover_inactive",
      2 * PROVISION_CHECK_MS,
      () => undefined,
    );
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'deletion_pending'");
    });

    await fireAlarm(world.stub);

    expect((await attachmentRow(world)).state).toBe("failed");
    await waitFor(() => operations(world).includes("stop"), "the stop by name");
    expect(operations(world)).not.toContain("getStatus");
    // Nothing is left for the check to come back to.
    await settle();
    const calls = world.controllerCalls.length;
    await fireAlarm(world.stub);
    expect(world.controllerCalls).toHaveLength(calls);
  });

  it("leaves a provisioning its memory still drives alone, and arms the next check", async () => {
    const world = await lostProvisioning(
      "sess_prov_recover_driven",
      2 * PROVISION_CHECK_MS,
      () => undefined,
    );
    await runInDurableObject(world.stub, (instance) => {
      instance.provisioningInFlight = 1;
    });

    await fireAlarm(world.stub);

    expect(operations(world)).not.toContain("getStatus");
    const alarm = await storedAlarm(world.stub);
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThan(Date.now());
  });
});

async function attachmentRow(
  world: SessionWorld,
): Promise<{ state: string; provider_sandbox_id: string | null; expires_at: string | null }> {
  return runInDurableObject(world.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ state: string; provider_sandbox_id: string | null; expires_at: string | null }>(
        "SELECT state, provider_sandbox_id, expires_at FROM sandbox_attachment WHERE generation = 1",
      )
      .one(),
  );
}

describe("a sandbox whose bridge is ready before the session attaches to it", () => {
  /**
   * A create's answer was lost and the sandbox it started ran on: its bridge
   * connects and reports ready, which moves the row past `provisioning`,
   * while the provisioning is still looking the sandbox up.
   */
  async function readyBeforeAttach(sessionId: string): Promise<SessionWorld> {
    const world = await sessionOnRealDriver(sessionId, {
      awaitAttachment: false,
      controller: (operation) =>
        operation === "getConnection" ? new Promise<Response>(() => undefined) : undefined,
    });
    await waitFor(() => operations(world).includes("getConnection"), "the connection lookup");
    await readyBridge(world);
    expect(await attachmentRow(world)).toEqual({
      state: "active",
      provider_sandbox_id: null,
      expires_at: null,
    });
    return world;
  }

  /** The object restarts: nothing in memory drives the provisioning, and a check interval has passed. */
  async function restartLater(world: SessionWorld): Promise<number> {
    const startedAtMs = Date.now() - 2 * PROVISION_CHECK_MS;
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(startedAtMs).toISOString(),
      );
    });
    return startedAtMs;
  }

  it("stores the sandbox's id and expiry at attach, and leaves the state the bridge moved it to", async () => {
    // Held by a timer the object's own fetch started, so the answer is built
    // and read in the object's context.
    let released = false;
    const named = async (): Promise<Response> => {
      while (!released) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-late" } });
    };
    const world = await sessionOnRealDriver("sess_prov_ready_first", {
      awaitAttachment: false,
      controller: (operation) => (operation === "getConnection" ? named() : undefined),
    });
    await waitFor(() => operations(world).includes("getConnection"), "the connection lookup");
    await readyBridge(world);
    expect((await attachmentRow(world)).state).toBe("active");

    released = true;
    await waitFor(
      async () => (await eventsOfType(world.stub, "sandbox.attached")).length === 1,
      "the attachment",
    );

    const attached = (await eventsOfType(world.stub, "sandbox.attached"))[0]?.payload as {
      expiresAt: string;
    };
    expect(await attachmentRow(world)).toEqual({
      state: "active",
      provider_sandbox_id: "modal://oncue-sessions/sb-late",
      expires_at: attached.expiresAt,
    });
  });

  it("is adopted by the alarm after a restart, with a ceiling counted from when its provisioning began", async () => {
    const world = await readyBeforeAttach("sess_prov_ready_recovered");
    const startedAtMs = await restartLater(world);
    world.setController(null);

    await fireAlarm(world.stub);

    expect(await eventsOfType(world.stub, "sandbox.attached")).toHaveLength(1);
    expect(await attachmentRow(world)).toEqual({
      state: "active",
      provider_sandbox_id: "modal://oncue-sessions/sb-1",
      expires_at: new Date(startedAtMs + DEFAULT_LIFECYCLE_SETTINGS.lifetimeMs).toISOString(),
    });
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
  });

  it("gets its ceiling, and is neither failed nor stopped, when the provider will not name it", async () => {
    const world = await readyBeforeAttach("sess_prov_ready_unnamed");
    const startedAtMs = await restartLater(world);
    world.setController((operation) => (operation === "getStatus" ? notFound() : undefined));

    await fireAlarm(world.stub);
    await settle();

    expect(await attachmentRow(world)).toEqual({
      state: "active",
      provider_sandbox_id: null,
      expires_at: new Date(startedAtMs + DEFAULT_LIFECYCLE_SETTINGS.lifetimeMs).toISOString(),
    });
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
    expect(operations(world)).not.toContain("stop");
    // Settled: the next alarm has no check to make.
    const asked = operations(world).filter((operation) => operation === "getStatus").length;
    await fireAlarm(world.stub);
    expect(operations(world).filter((operation) => operation === "getStatus")).toHaveLength(asked);
  });

  it("is not replaced on the spot when it is found after its ceiling would have passed", async () => {
    const world = await readyBeforeAttach("sess_prov_ready_stale");
    const lifetimeMs = DEFAULT_LIFECYCLE_SETTINGS.lifetimeMs;
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * lifetimeMs).toISOString(),
      );
    });
    world.setController((operation) => (operation === "getStatus" ? notFound() : undefined));
    const before = Date.now();

    await fireAlarm(world.stub);
    await fireAlarm(world.stub);
    await settle();

    // The replacement is due no sooner than a check from now, so an idle stop
    // that is due comes first and nothing starts a sandbox nobody asked for.
    const expiresAtMs = Date.parse((await attachmentRow(world)).expires_at as string);
    expect(expiresAtMs - DEFAULT_LIFECYCLE_SETTINGS.ceilingMarginMs).toBeGreaterThanOrEqual(
      before + PROVISION_CHECK_MS,
    );
    expect(await eventsOfType(world.stub, "sandbox.replaced")).toEqual([]);
    expect(await eventsOfType(world.stub, "sandbox.credentials_revoked")).toEqual([]);
    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(1);
  });
});

/**
 * Holds a controller answer until the test opens it. The answer is built only
 * then, inside the object's own fetch, since a Response made in the test's
 * context cannot be read from the object's.
 */
function gate(answer: () => Response): {
  readonly wait: Promise<Response>;
  readonly open: () => void;
} {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: opened.then(answer), open };
}

async function createDeadline(world: SessionWorld): Promise<number | null> {
  return runInDurableObject(
    world.stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ not_after_ms: number }>(
          "SELECT not_after_ms FROM create_deadline WHERE generation = 1",
        )
        .toArray()[0]?.not_after_ms ?? null,
  );
}

async function stopByUser(world: SessionWorld): Promise<unknown> {
  return runInDurableObject(world.stub, (instance) =>
    instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
  );
}

describe("a generation that ends while its provisioning waits on the provider", () => {
  it("creates nothing when the user stops it during the build and the next poll says ready", async () => {
    const held = gate(() => ready("im-during-stop"));
    let polls = 0;
    const world = await sessionOnRealDriver("sess_prov_stop_then_ready", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation !== "prepareImage") {
          return undefined;
        }
        polls += 1;
        return polls === 1 ? held.wait : ready("im-after-stop");
      },
    });
    await waitFor(() => polls === 1, "the first poll");

    await stopByUser(world);
    held.open();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(operations(world)).not.toContain("create");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
  });

  it("stops the sandbox a create started when the user stopped the generation during the create", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: {} }));
    const world = await sessionOnRealDriver("sess_prov_stop_during_create", {
      awaitAttachment: false,
      controller: (operation) => (operation === "create" ? held.wait : undefined),
    });
    await waitFor(() => operations(world).includes("create"), "the create");
    const stopsBefore = operations(world).filter((operation) => operation === "stop").length;

    await stopByUser(world);
    held.open();
    await waitFor(
      () => operations(world).filter((operation) => operation === "stop").length > stopsBefore,
      "the stop by name",
    );

    expect(operations(world)).not.toContain("start");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("stops the sandbox when the generation ends while a lost create is looked up", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: "active" }));
    const world = await sessionOnRealDriver("sess_prov_stop_during_lookup", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "create") {
          return failure("unknown", true);
        }
        return operation === "getStatus" ? held.wait : undefined;
      },
    });
    await waitFor(() => operations(world).includes("getStatus"), "the lookup");

    await stopByUser(world);
    held.open();
    await waitFor(
      () => operations(world).lastIndexOf("stop") > operations(world).indexOf("getStatus"),
      "the stop by name",
    );

    expect(operations(world).filter((operation) => operation === "create")).toHaveLength(1);
    expect(operations(world)).not.toContain("start");
  });

  it("stops the sandbox when the generation ends between start and the connection lookup", async () => {
    const held = gate(() =>
      Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } }),
    );
    const world = await sessionOnRealDriver("sess_prov_stop_during_connection", {
      awaitAttachment: false,
      controller: (operation) => (operation === "getConnection" ? held.wait : undefined),
    });
    await waitFor(() => operations(world).includes("getConnection"), "the lookup");

    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'stopped' WHERE generation = 1",
      );
    });
    held.open();
    await waitFor(() => operations(world).includes("stop"), "the stop by name");

    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("stops the sandbox when the generation ends between create and start", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: {} }));
    const world = await sessionOnRealDriver("sess_prov_stop_during_start", {
      awaitAttachment: false,
      controller: (operation) => (operation === "start" ? held.wait : undefined),
    });
    await waitFor(() => operations(world).includes("start"), "the start");

    await stopByUser(world);
    held.open();
    await waitFor(
      () => operations(world).lastIndexOf("stop") > operations(world).indexOf("start"),
      "the stop by name",
    );

    expect(operations(world)).not.toContain("getConnection");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("creates nothing when the session is being deleted during the build", async () => {
    const held = gate(() => ready("im-ready"));
    const world = await sessionOnRealDriver("sess_prov_deleted", {
      awaitAttachment: false,
      controller: (operation) => (operation === "prepareImage" ? held.wait : undefined),
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");

    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET state = 'deletion_pending'");
    });
    held.open();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(operations(world)).not.toContain("create");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("does not adopt in a recovery when the generation ended during the status lookup", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: "active" }));
    const world = await sessionOnRealDriver("sess_prov_recover_stopped", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        return operation === "getStatus" ? held.wait : undefined;
      },
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    const alarm = fireAlarm(world.stub);
    await waitFor(() => operations(world).includes("getStatus"), "the lookup");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'stopped' WHERE generation = 1",
      );
    });
    held.open();
    await alarm;
    await waitFor(() => operations(world).includes("stop"), "the stop by name");

    expect(operations(world)).not.toContain("getConnection");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("leaves the row to a stop that began during a recovery's status lookup", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: "active" }));
    const world = await sessionOnRealDriver("sess_prov_recover_stop_owns", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        return operation === "getStatus" ? held.wait : undefined;
      },
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    const alarm = fireAlarm(world.stub);
    await waitFor(() => operations(world).includes("getStatus"), "the lookup");
    // A stop under way, waiting on its own step: it moves the row when it ends.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sandbox_stop (generation, cause, step, started_at_ms, due_at_ms, attempts) VALUES (1, 'user_requested', 'terminate', ?, ?, 0)",
        Date.now(),
        Date.now() + 3_600_000,
      );
    });
    held.open();
    await alarm;
    await waitFor(() => operations(world).includes("stop"), "the stop by name");

    expect((await attachmentRow(world)).state).toBe("provisioning");
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("does not attach in a recovery when the generation ended during the connection lookup", async () => {
    const held = gate(() =>
      Response.json({ kind: "ok", value: { bridgeUrl: "modal://oncue-sessions/sb-1" } }),
    );
    const world = await sessionOnRealDriver("sess_prov_recover_stopped_late", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        if (operation === "getStatus") {
          return Response.json({ kind: "ok", value: "active" });
        }
        return operation === "getConnection" ? held.wait : undefined;
      },
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    const alarm = fireAlarm(world.stub);
    await waitFor(() => operations(world).includes("getConnection"), "the lookup");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'stopped' WHERE generation = 1",
      );
    });
    held.open();
    await alarm;
    await waitFor(() => operations(world).includes("stop"), "the stop by name");

    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
    const state = await runInDurableObject(
      world.stub,
      (_instance, storage) =>
        storage.storage.sql
          .exec<{ state: string }>("SELECT state FROM sandbox_attachment WHERE generation = 1")
          .one().state,
    );
    expect(state).toBe("stopped");
  });
});

describe("a create that may land after the Worker gave up", () => {
  it("is stopped once more by the alarm after its deadline and grace, after the sweep's own stops", async () => {
    const world = await sessionOnRealDriver("sess_prov_late_landing", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, createNotAfterMs: 300, createLandingGraceMs: 300 },
      controller: (operation) =>
        operation === "create" ? failure("configuration", false, 400) : undefined,
    });

    await provisioningFailure(world);
    const deadline = (await createDeadline(world)) as number;
    await waitFor(() => operations(world).includes("stop"), "the sweep's stop");
    await settle();
    // The sweep's stop succeeded, but while the create could still land, so
    // it did not pay the late stop.
    expect(await lateStopRows(world)).toEqual([
      { generation: 1, due_at_ms: deadline + 300, attempts: 0 },
    ]);
    // The alarm is armed for it.
    expect(await storedAlarm(world.stub)).toBeLessThanOrEqual(deadline + 300);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline + 300 - Date.now())));

    // The runtime may deliver the armed alarm itself; either way one runs.
    await fireAlarm(world.stub);

    expect(await lateStopRows(world)).toEqual([]);
    expect(stopsAfter(world, deadline + 300)).toBeGreaterThanOrEqual(1);
  });

  it("is stopped by the alarm after a user's stop that came while the create was out", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: {} }));
    const world = await sessionOnRealDriver("sess_prov_user_stop_late_landing", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, createNotAfterMs: 300, createLandingGraceMs: 300 },
      controller: (operation) => (operation === "create" ? held.wait : undefined),
    });
    await waitFor(() => operations(world).includes("create"), "the create");
    const deadline = (await createDeadline(world)) as number;

    // The object loses the provisioning (a restart); the user's stop finds
    // nothing, and only then does the create land.
    await runInDurableObject(world.stub, (instance) => {
      instance.provisioningInFlight = null;
    });
    await stopByUser(world);
    expect(await lateStopRows(world)).toEqual([
      { generation: 1, due_at_ms: deadline + 300, attempts: 0 },
    ]);
    held.open();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline + 300 - Date.now())));

    await fireAlarm(world.stub);

    expect(await lateStopRows(world)).toEqual([]);
    expect(stopsAfter(world, deadline + 300)).toBeGreaterThanOrEqual(1);
  });

  it("tries a refused late stop again later, then names the sandbox as possibly running", async () => {
    const world = await sessionOnRealDriver("sess_prov_late_refused", {
      controller: (operation) => (operation === "stop" ? failure("unknown", true) : undefined),
    });
    const insert = (attempts: number) =>
      runInDurableObject(world.stub, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO late_stop (generation, provider, due_at_ms, attempts) VALUES (7, 'modal', ?, ?) ON CONFLICT (generation) DO UPDATE SET due_at_ms = excluded.due_at_ms, attempts = excluded.attempts",
          Date.now() - 1,
          attempts,
        );
      });

    await insert(0);
    await fireAlarm(world.stub);
    const retried = await lateStopRows(world);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ generation: 7, attempts: 1 });
    expect(retried[0]?.due_at_ms as number).toBeGreaterThan(Date.now());

    await insert(LATE_STOP_MAX_ATTEMPTS - 1);
    await fireAlarm(world.stub);
    expect(await lateStopRows(world)).toEqual([]);
    expect(await controllerLines(world)).toContain(
      leftRunningNote(sandboxName("sess_prov_late_refused", 7)),
    );
  });

  it("has nothing to do for an object with no session", async () => {
    await runInDurableObject(stubFor("sess_prov_late_empty"), (instance) =>
      instance.runLateStops(),
    );
  });

  it("is not declared lost by a recovery until it can no longer land", async () => {
    const world = await sessionOnRealDriver("sess_prov_recover_landing", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        return operation === "getStatus" ? notFound() : undefined;
      },
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    const setDeadline = (notAfterMs: number) =>
      runInDurableObject(world.stub, (instance, state) => {
        instance.provisioningInFlight = null;
        state.storage.sql.exec(
          "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
          new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
        );
        state.storage.sql.exec(
          "INSERT INTO create_deadline (generation, not_after_ms) VALUES (1, ?) ON CONFLICT (generation) DO UPDATE SET not_after_ms = excluded.not_after_ms",
          notAfterMs,
        );
      });

    await setDeadline(Date.now() + 60_000);
    await fireAlarm(world.stub);
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);

    await setDeadline(Date.now() - 1_000);
    await fireAlarm(world.stub);
    expect(await provisioningFailure(world)).toMatchObject({
      error: { message: PROVISIONING_LOST_MESSAGE },
    });
  });
});

async function lateStopRows(
  world: SessionWorld,
): Promise<{ generation: number; due_at_ms: number; attempts: number }[]> {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<{ generation: number; due_at_ms: number; attempts: number }>(
      "SELECT generation, due_at_ms, attempts FROM late_stop ORDER BY generation",
    ),
  ]);
}

describe("the provisioning mark", () => {
  it("survives an older generation's provisioning ending after a stop and a resend started the next", async () => {
    const held = gate(() => Response.json({ kind: "ok", value: { state: "building" } }));
    let polls = 0;
    const world = await sessionOnRealDriver("sess_prov_mark_kept", {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation !== "prepareImage") {
          return undefined;
        }
        polls += 1;
        // Generation 1's poll is held; generation 2's builds for good.
        return polls === 1 ? held.wait : new Promise<Response>(() => undefined);
      },
    });
    await waitFor(() => polls === 1, "generation 1's poll");
    await stopByUser(world);
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_mark_resend", "msg_mark_resend", "Try again"));
    await waitFor(() => polls === 2, "generation 2's poll");
    expect(await runInDurableObject(world.stub, (instance) => instance.provisioningInFlight)).toBe(
      2,
    );

    held.open();
    await settle();

    expect(await runInDurableObject(world.stub, (instance) => instance.provisioningInFlight)).toBe(
      2,
    );
    // So the alarm, an interval later, does not take generation 2 for lost.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 2",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    await fireAlarm(world.stub);
    expect(operations(world)).not.toContain("getStatus");
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
  });
});

describe("a stop in the gaps between provider calls", () => {
  it("sends no further create when the generation ends while a retry waits", async () => {
    let creates = 0;
    const world = await sessionOnRealDriver("sess_prov_stop_during_retry_wait", {
      awaitAttachment: false,
      pacing: { ...TEST_PACING, createRetryDelaysMs: [300, 300] },
      controller: (operation) => {
        if (operation === "create") {
          creates += 1;
          return failure("unknown", true);
        }
        return operation === "getStatus" ? notFound() : undefined;
      },
    });
    await waitFor(() => operations(world).includes("getStatus"), "the lookup");

    await stopByUser(world);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(creates).toBe(1);
    expect(await eventsOfType(world.stub, "sandbox.attached")).toEqual([]);
  });

  it("fails nothing in a recovery when the generation ends while the Modal pair is opened", async () => {
    const opened = gate(() => new Response());
    const world = await sessionOnRealDriver("sess_prov_recover_stop_during_open", {
      awaitAttachment: false,
      controller: (operation) =>
        operation === "prepareImage" ? new Promise<Response>(() => undefined) : undefined,
    });
    await waitFor(() => operations(world).includes("prepareImage"), "the first poll");
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      const open = instance.openCredential.bind(instance);
      instance.openCredential = async (session) => {
        await opened.wait;
        return open(session);
      };
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    const alarm = fireAlarm(world.stub);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET state = 'stopped' WHERE generation = 1",
      );
    });
    opened.open();
    await alarm;

    expect(operations(world)).not.toContain("getStatus");
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
  });
});

function stopsAfter(world: SessionWorld, atMs: number): number {
  return world.controllerCalls.filter((call) => call.operation === "stop" && call.atMs >= atMs)
    .length;
}
