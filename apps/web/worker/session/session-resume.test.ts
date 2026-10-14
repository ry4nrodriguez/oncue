// A new generation for a session whose sandbox is gone: a `run.start`, a
// Continue, or the planned replacement provisions generation 2, whose bridge
// gets the durable head, any restore bundle, and the context summary.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { replaceCredential } from "../broker/connections";
import { deriveKeyring } from "../broker/envelope";
import { createProviderDouble } from "../test/provider-double";
import {
  ageEvents,
  ageProbe,
  ageStop,
  armAlarmNow,
  attachmentStates,
  BASE_SHA,
  type ControllerScript,
  connectBridge,
  dispatchRows,
  eventCount,
  eventsOfType,
  eventTypes,
  finishRun,
  fireAlarm,
  followUpCommand,
  idleStopIssued,
  MODAL_CREDENTIAL,
  openClient,
  probeRow,
  quietRepositoryWorld,
  REAL_KEYRING_VALUE,
  REPOSITORY,
  readyBridge,
  registerSessionWorlds,
  reportCheckpoint,
  runRowOf,
  runRows,
  runStartCommand,
  seedModalConnection,
  seedModelConnection,
  sessionGeneration,
  sessionOnRealDriver,
  setAttachmentExpiry,
  settle,
  stopRow,
  storedAlarm,
  stubFor,
  waitFor,
} from "../test/session-world";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD_SHA = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const MIN = 60_000;

type World = Awaited<ReturnType<typeof sessionOnRealDriver>>;

async function waitForGeneration(world: World, generation: number): Promise<void> {
  await waitFor(
    async () =>
      (await attachmentStates(world.stub)).some(
        (row) => row.generation === generation && row.state === "attached",
      ),
    `generation ${generation} to attach`,
  );
}

/** A repository session whose first generation stopped idle with a pushed checkpoint. */
async function stoppedIdle(sessionId: string): Promise<World> {
  const { world, bridge } = await quietRepositoryWorld(sessionId);
  await idleStopIssued(world, bridge);
  reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
  await waitFor(async () => (await eventTypes(world.stub)).includes("sandbox.stopped"), "the stop");
  return world;
}

/**
 * A run interrupted by a lost sandbox; its checkpoint makes it interrupted
 * rather than failed (record 01). No repository, so a Continue clones nothing.
 */
async function lostWhileRunning(sessionId: string): Promise<World> {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  bridge.send(
    bridge.event("repository.checkpointed", {
      runId: "run_1",
      payload: { checkpointId: "ckpt_periodic", headSha: HEAD_SHA, reason: "periodic" },
    }),
  );
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  bridge.close();
  await waitFor(async () => (await probeRow(world.stub, 1)) !== null, "the probe");
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
  expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "interrupted" });
  world.setController(null);
  return world;
}

/**
 * Holds the object's reads of `modal_connection` for `delayMs` each, counting
 * the reads held and the reads that returned. A timer rather than a gate:
 * workerd abandons a promise with no I/O behind it.
 */
async function holdModalConnectionRead(
  world: World,
  delayMs: number,
): Promise<{ held(): number; done(): number; restore(): Promise<void> }> {
  let held = 0;
  let done = 0;
  const real = env.DB;
  const bound = <T extends object>(target: T, value: unknown) =>
    typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  const holding = new Proxy(real, {
    get(target, property) {
      if (property !== "prepare") {
        return bound(target, Reflect.get(target, property));
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("FROM modal_connection")) {
          return statement;
        }
        return new Proxy(statement, {
          get(prepared, name) {
            if (name !== "bind") {
              return bound(prepared, Reflect.get(prepared, name));
            }
            return (...args: unknown[]) => {
              const statementWithArgs = prepared.bind(...args);
              return new Proxy(statementWithArgs, {
                get(ready, method) {
                  const value = Reflect.get(ready, method);
                  if (!["all", "first", "raw", "run"].includes(String(method))) {
                    return bound(ready, value);
                  }
                  return async (...callArgs: unknown[]) => {
                    held += 1;
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    try {
                      return await (value as (...a: unknown[]) => Promise<unknown>).apply(
                        ready,
                        callArgs,
                      );
                    } finally {
                      done += 1;
                    }
                  };
                },
              });
            };
          },
        });
      };
    },
  });
  const setDb = (db: D1Database) =>
    runInDurableObject(world.stub, (instance) => {
      (instance as unknown as { env: Env }).env.DB = db;
    });
  await setDb(holding);
  return {
    held: () => held,
    done: () => done,
    restore: () => setDb(real),
  };
}

/**
 * Holds the object's alarm back to reproduce a slow production alarm, leaving
 * a gap before the `replace` step for a click to land in. `release` restores
 * the object's own `rearm`.
 */
async function holdAlarms(world: World): Promise<{ release(): Promise<void> }> {
  await runInDurableObject(world.stub, async (instance, state) => {
    (instance as unknown as { rearm: () => Promise<void> }).rearm = async () => undefined;
    await state.storage.deleteAlarm();
  });
  return {
    release: () =>
      runInDurableObject(world.stub, async (instance) => {
        delete (instance as unknown as { rearm?: () => Promise<void> }).rearm;
        await (instance as unknown as { rearm: () => Promise<void> }).rearm();
      }),
  };
}

async function callObject<T>(world: World, operation: string, body: unknown): Promise<T> {
  const response = await world.stub.fetch(`https://do/internal/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

function commandOf(frame: Record<string, unknown>) {
  return frame.command as {
    commandId: string;
    type: string;
    payload: { instruction: { messageId: string; text: string } };
  };
}

describe("the resume replay", () => {
  it("gives the resumed run every earlier turn with its tools, changed files, checks, plan, and policy", async () => {
    const world = await sessionOnRealDriver("sess_resume_replay", { repository: REPOSITORY });
    const bridge = await readyBridge(world);
    for (const kind of ["git", "model"]) {
      bridge.ack({ grantId: String((bridge.grants(kind)[0] as Record<string, unknown>).grantId) });
    }
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(
      bridge.event("plan.created", {
        runId: "run_1",
        payload: {
          steps: [
            { stepId: "s1", title: "Find the bug", status: "complete" },
            { stepId: "s2", title: "Fix it", status: "active" },
          ],
        },
      }),
    );
    bridge.send(
      bridge.event("tool.requested", {
        runId: "run_1",
        payload: {
          toolCallId: "call_edit",
          category: "file_write",
          title: "src/sum.ts",
          runtimeName: "edit",
          input: { filePath: "src/sum.ts" },
        },
      }),
    );
    bridge.send(
      bridge.event("tool.completed", { runId: "run_1", payload: { toolCallId: "call_edit" } }),
    );
    bridge.send(
      bridge.event("diff.updated", {
        runId: "run_1",
        payload: {
          scope: "turn",
          files: [{ path: "src/sum.ts", status: "modified", additions: 1, deletions: 1 }],
        },
      }),
    );
    await finishRun(world, bridge);
    await idleStopIssued(world, bridge);
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_replay_2", "msg_replay_2", "Now add a test"));
    await waitForGeneration(world, 2);
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the grants");
    next.send(next.event("runtime.ready"));
    await waitFor(() => next.commands("run.start").length >= 1, "the run.start");
    const context = String((next.commands("run.start")[0] as Record<string, unknown>).context);

    expect(context).toContain("Turn 1, ended with warnings:");
    expect(context).toContain("> Fix the bug");
    expect(context).toContain("> src/sum.ts (file_write, completed): src/sum.ts");
    expect(context).toContain("Files this turn changed, quoted:\n> src/sum.ts");
    expect(context).toContain("> I changed the assertion and the test passes.");
    expect(context).toContain("> complete: Find the bug\n> active: Fix it");
    expect(context).toContain("The session's Git policy now: commits auto, pushes manual");
    // The resumed run's own prompt is not replayed to it.
    expect(context).not.toContain("Now add a test");
  });
});

describe("resuming a session", () => {
  it("a run.start with no live sandbox provisions generation 2 at the pushed checkpoint with the durable context", async () => {
    const world = await stoppedIdle("sess_resume_start");
    const client = await openClient(world);

    await client.send(runStartCommand("cmd_start_2", "msg_2", "Now the other bug"));
    await waitForGeneration(world, 2);

    expect(await sessionGeneration(world.stub)).toBe(2);
    const provisioning = await eventsOfType(world.stub, "sandbox.provisioning");
    expect(provisioning).toHaveLength(2);
    expect(provisioning[1]).toMatchObject({
      sandboxGeneration: 2,
      payload: { provider: "modal", reason: "resume" },
    });
    expect(await eventsOfType(world.stub, "sandbox.replaced")).toEqual([]);
    const queued = await eventsOfType(world.stub, "run.queued");
    const runId = String(queued[1]?.runId);
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "provisioning" });

    const bridge = await connectBridge(world, 2);
    await bridge.hello();
    await waitFor(() => bridge.grants("model").length >= 1, "the grants");
    expect(bridge.grants("git")[0]).toMatchObject({
      sandboxGeneration: 2,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      restore: null,
    });
    bridge.send(bridge.event("runtime.ready"));
    await waitFor(() => bridge.commands("run.start").length >= 1, "the run.start");
    const start = bridge.commands("run.start")[0] as Record<string, unknown>;
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_start_2",
      payload: { instruction: { messageId: "msg_2", text: "Now the other bug" } },
    });
    expect(start.runId).toBe(runId);
    const context = String(start.context);
    expect(context).toContain("This session's sandbox was stopped and a new one has started.");
    expect(context).toContain(`branch ${REPOSITORY.taskBranch} at ${HEAD_SHA.slice(0, 12)}`);
    expect(context).toContain("> Fix the bug");
    expect(context).toContain("> I changed the assertion and the test passes.");
    expect(context).not.toContain("Now the other bug");
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "ready" });

    // A probe left behind for the generation that ended is owed by nothing.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sandbox_probe (generation, due_at_ms, attempts) VALUES (1, ?, 0)",
        Date.now() - 1,
      );
    });
    const events = await eventCount(world.stub);
    await fireAlarm(world.stub);
    expect(await probeRow(world.stub, 1)).toMatchObject({ attempts: 0 });
    expect(await eventCount(world.stub)).toBe(events);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
      { generation: 2, state: "active", provider: "modal" },
    ]);
  });

  it("a resume after an idle checkpoint that pushed nothing clones the base branch, keeping the name for the first real push", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_resume_unpushed_name", {
      repository: { ...REPOSITORY, taskBranch: null },
    });
    await idleStopIssued(world, bridge);
    // The tree was unchanged: the bridge reports the checkpoint at the base
    // commit and pushes nothing, so the name minted for the grant has no ref.
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: BASE_SHA });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_2", "msg_2", "Now the other bug"));
    await waitForGeneration(world, 2);
    const again = await connectBridge(world, 2);
    await again.hello();
    await waitFor(() => again.grants("git").length >= 1, "the git grant");
    const grant = again.grants("git")[0] as { branch: string; taskBranch: string | null };
    expect(grant.branch).toBe("main");
    expect(grant.taskBranch).toMatch(/^oncue\//);
  });

  it("a patch bundle checkpoint is restored on the next generation through a one-time token", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_resume_bundle");
    await idleStopIssued(world, bridge);
    bridge.send(
      bridge.event("artifact.uploading", {
        runId: "run_1",
        payload: {
          artifactId: "art_patch",
          kind: "patch",
          contentType: "text/x-patch",
          declaredBytes: 512,
          producer: "checkpoint",
        },
      }),
    );
    await waitFor(() => bridge.grants("upload").length >= 1, "the upload grant");
    const upload = bridge.grants("upload")[0] as Record<string, unknown>;
    expect(upload).toMatchObject({
      artifactId: "art_patch",
      url: `https://do/api/sessions/${world.sessionId}/artifacts/art_patch`,
      maxBytes: 512,
    });
    expect(
      await callObject(world, "artifacts/authorize", {
        artifactId: "art_patch",
        token: upload.token,
        purpose: "upload",
      }),
    ).toEqual({
      kind: "authorized",
      objectKey: `workspaces/ws_1/sessions/${world.sessionId}/runs/run_1/art_patch`,
      contentType: "text/x-patch",
      declaredBytes: 512,
    });
    const completed = await callObject<{ kind: string; index: Record<string, unknown> }>(
      world,
      "artifacts/complete",
      { artifactId: "art_patch", byteSize: 512, sha256: "ab".repeat(32) },
    );
    expect(completed).toMatchObject({
      kind: "created",
      index: { classification: "essential_evidence", expiresAt: null, producer: "checkpoint" },
    });
    expect((await eventsOfType(world.stub, "artifact.created"))[0]?.payload).toMatchObject({
      artifact: { artifactId: "art_patch", kind: "patch", label: "Checkpoint patch bundle" },
      classification: "essential_evidence",
    });

    reportCheckpoint(bridge, {
      checkpointId: "ckpt_bundle",
      kind: "patch_bundle",
      headSha: null,
      bundle: {
        artifactId: "art_patch",
        kind: "patch",
        contentType: "text/x-patch",
        byteSize: 512,
        label: "Checkpoint patch bundle",
      },
    });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      checkpointId: "ckpt_bundle",
    });

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_2", "msg_2", "Carry on"));
    await waitForGeneration(world, 2);
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the grants");
    const git = next.grants("git")[0] as Record<string, unknown>;
    expect(git).toMatchObject({
      headSha: BASE_SHA,
      restore: {
        artifactId: "art_patch",
        url: `https://do/api/sessions/${world.sessionId}/artifacts/art_patch/restore`,
      },
    });
    const restore = git.restore as { token: string };
    expect(restore.token).not.toBe(upload.token);
    const authorize = (purpose: "upload" | "restore") =>
      callObject(world, "artifacts/authorize", {
        artifactId: "art_patch",
        token: restore.token,
        purpose,
      });
    expect(await authorize("upload")).toEqual({ kind: "refused" });
    expect(await authorize("restore")).toMatchObject({ kind: "authorized" });
    expect(await authorize("restore")).toEqual({ kind: "refused" });

    next.send(next.event("runtime.ready"));
    await waitFor(() => next.commands("run.start").length >= 1, "the run.start");
    expect(String(next.commands("run.start")[0]?.context)).toContain(
      "has been restored as a commit on top of that branch",
    );
  });

  it("a Continue on an interrupted run with no sandbox resumes that run on generation 2", async () => {
    const world = await lostWhileRunning("sess_continue");
    const client = await openClient(world);

    const cont = followUpCommand("cmd_cont", "msg_cont", "run_1", "interrupted");
    await client.send({ ...cont, payload: { ...cont.payload, skipRequiredChecks: true } });
    await waitForGeneration(world, 2);

    expect((await eventsOfType(world.stub, "message.queued"))[0]?.payload).toMatchObject({
      messageId: "msg_cont",
      delivery: "steer_current_run",
    });
    expect((await eventsOfType(world.stub, "sandbox.provisioning"))[1]).toMatchObject({
      sandboxGeneration: 2,
      payload: { reason: "resume" },
    });
    expect(await runRows(world.stub)).toEqual([
      expect.objectContaining({ id: "run_1", state: "provisioning" }),
    ]);

    const bridge = await readyBridge(world, 2);
    const start = bridge.commands("run.start")[0] as Record<string, unknown>;
    expect(start.runId).toBe("run_1");
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_cont",
      type: "run.start",
      payload: {
        instruction: { messageId: "msg_cont", text: "Message msg_cont" },
        skipRequiredChecks: true,
      },
    });
    const context = String(start.context);
    expect(context).toContain("> Fix the bug");
    expect(context).toContain(
      `The sandbox was lost. Work since the checkpoint at ${HEAD_SHA.slice(0, 7)} was not kept.`,
    );
    // The Continue's own message is the prompt, so the context does not quote it again.
    expect(context).not.toContain("Message msg_cont");
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "ready" });
  });

  it("refuses a Continue or a run.start on a model connection that is not active, and starts no sandbox while it is not active", async () => {
    const world = await lostWhileRunning("sess_continue_broken_key");
    const client = await openClient(world);
    const refusal =
      "this run's model connection is not active; add a working key under Settings, Model providers and start a new session";

    try {
      // The broker marked the key invalid.
      await seedModelConnection(world.workspaceId, "invalid");
      await client.send(followUpCommand("cmd_cont_invalid", "msg_cont_1", "run_1", "interrupted"));
      // The user deleted the connection.
      await env.DB.prepare("DELETE FROM model_connection WHERE connection_id = 'conn_1'").run();
      await client.send(runStartCommand("cmd_start_deleted", "msg_start_1", "Start over"));

      expect(
        (await eventsOfType(world.stub, "command.rejected")).map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({
          commandId: "cmd_cont_invalid",
          reason: "wrong_state",
          detail: refusal,
        }),
        expect.objectContaining({
          commandId: "cmd_start_deleted",
          reason: "wrong_state",
          detail: refusal,
        }),
      ]);
      expect(await eventsOfType(world.stub, "message.queued")).toEqual([]);
      expect(await eventsOfType(world.stub, "run.queued")).toHaveLength(1);
      expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
      expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "interrupted" });
    } finally {
      await seedModelConnection(world.workspaceId);
    }

    // Active again (as a replaced key would be): the same Continue now resumes the run.
    await client.send(followUpCommand("cmd_cont_active", "msg_cont_2", "run_1", "interrupted"));
    await waitForGeneration(world, 2);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "provisioning" });
  });

  it("a Continue while a sandbox is live is rejected wrong_state", async () => {
    const world = await lostWhileRunning("sess_continue_live");
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_2", "msg_2", "Start over"));
    await waitFor(async () => (await sessionGeneration(world.stub)) === 2, "generation 2");

    await client.send(followUpCommand("cmd_cont", "msg_cont", "run_1", "interrupted"));

    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandId: "cmd_cont",
      reason: "wrong_state",
      actualState: "interrupted",
      detail: expect.stringMatching(/continued only once its sandbox has stopped/),
    });
    expect(await eventsOfType(world.stub, "message.queued")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "interrupted" });
  });

  it("two Continue clicks at once make exactly one new generation and one run", async () => {
    const world = await lostWhileRunning("sess_continue_twice");
    const client = await openClient(world);

    await client.sendTogether([
      followUpCommand("cmd_cont_1", "msg_cont_1", "run_1", "interrupted"),
      followUpCommand("cmd_cont_2", "msg_cont_2", "run_1", "interrupted"),
    ]);
    await waitForGeneration(world, 2);
    await settle();

    expect(await sessionGeneration(world.stub)).toBe(2);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(2);
    expect(await attachmentStates(world.stub)).toHaveLength(2);
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ id: "run_1" })]);
    const bridge = await readyBridge(world, 2);
    await settle();
    // The first click resumed the run; the second joined that generation
    // rather than starting another run.start.
    expect(bridge.commands("run.start")).toHaveLength(1);
    expect(bridge.commands("run.start")[0]?.runId).toBe("run_1");
  });

  it("a rejected key stops the sandbox at once; Continue is refused until the key is replaced, then resumes the paused run on a new generation from the checkpoint", async () => {
    const world = await sessionOnRealDriver("sess_continue_rejected_key", {
      repository: REPOSITORY,
    });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    for (const kind of ["git", "model"]) {
      bridge.ack({ grantId: String((bridge.grants(kind)[0] as Record<string, unknown>).grantId) });
    }
    bridge.send(bridge.event("repository.status", { runId: "run_1" }));
    await waitFor(
      () => world.github.calls.some((call) => call.tokenRevoked === true),
      "the clone token's revocation",
    );
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(
      bridge.event("message.completed", {
        runId: "run_1",
        payload: {
          messageId: "msg_before_rejection",
          role: "assistant",
          parts: [{ type: "text", text: "I have started on the fix." }],
        },
      }),
    );
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    const beforePause = await eventCount(world.stub);
    const refusal =
      "this run's model connection is not active; add a working key under Settings, Model providers and start a new session";
    const client = await openClient(world);

    try {
      // The provider rejects the key: the broker marks the connection invalid
      // and the bridge pauses the run, saying why.
      await seedModelConnection(world.workspaceId, "invalid");
      bridge.send(
        bridge.event("run.paused", {
          runId: "run_1",
          payload: {
            reason: "model_failure",
            detail: "Model request failed: authentication_failed",
            modelFailure: {
              category: "authentication_failed",
              message: "The stored key was rejected.",
              retries: 0,
            },
            checkpointId: null,
          },
        }),
      );

      // No idle period and no alarm fired by hand: the pause starts the stop.
      await waitFor(
        () => bridge.commands("checkpoint.create").length >= 1,
        "the checkpoint command",
      );
      // The sandbox is still stopping, so the run cannot be continued yet.
      await client.send(followUpCommand("cmd_cont_stopping", "msg_cont_0", "run_1", "paused"));
      reportCheckpoint(bridge, { checkpointId: "ckpt_rejected", headSha: HEAD_SHA });
      await waitFor(
        async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
        "the stop",
      );
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });

      // Stopped, but the key is still the rejected one.
      await client.send(followUpCommand("cmd_cont_invalid", "msg_cont_1", "run_1", "paused"));
      expect(
        (await eventsOfType(world.stub, "command.rejected")).map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({
          commandId: "cmd_cont_stopping",
          reason: "wrong_state",
          actualState: "paused",
          detail: "a paused run is continued only once its sandbox has stopped",
        }),
        expect.objectContaining({
          commandId: "cmd_cont_invalid",
          reason: "wrong_state",
          actualState: "paused",
          detail: refusal,
        }),
      ]);
      expect(await sessionGeneration(world.stub)).toBe(1);
      expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
      expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });

      // The user replaces the key under Settings, Model providers: the same
      // connection, active again.
      const keyring = await deriveKeyring(REAL_KEYRING_VALUE, "credential");
      if (keyring.kind !== "ok") {
        throw new Error("the test runner always configures a keyring");
      }
      const replaced = await replaceCredential(
        {
          db: env.DB,
          keyring: keyring.keyring,
          fetchImpl: createProviderDouble("anthropic").fetchImpl,
          originFor: () => "https://provider.double",
          now: () => new Date().toISOString(),
          newId: () => "unused",
        },
        world.workspaceId,
        "conn_1",
        "sk-ant-fake0002",
      );
      expect(replaced).toMatchObject({
        kind: "replaced",
        summary: { connectionId: "conn_1", status: "active" },
      });

      await client.send(followUpCommand("cmd_cont", "msg_cont_2", "run_1", "paused"));
      await waitForGeneration(world, 2);
    } finally {
      // D1 rows outlive a test, and other tests name this connection.
      await seedModelConnection(world.workspaceId);
    }

    expect(await eventsOfType(world.stub, "command.rejected")).toHaveLength(2);
    expect((await eventsOfType(world.stub, "sandbox.provisioning"))[1]).toMatchObject({
      sandboxGeneration: 2,
      payload: { provider: "modal", reason: "resume" },
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "provisioning" });

    // The new sandbox starts from the checkpoint the stop pushed.
    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the grants");
    expect(next.grants("git")[0]).toMatchObject({
      sandboxGeneration: 2,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      restore: null,
    });
    next.send(next.event("runtime.ready"));
    await waitFor(() => next.commands("run.start").length >= 1, "the run.start");
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(start.runId).toBe("run_1");
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_cont",
      payload: { instruction: { text: "Message msg_cont_2" } },
    });
    const context = String(start.context);
    expect(context).toContain("This session's sandbox was stopped and a new one has started.");
    expect(context).toContain(`branch ${REPOSITORY.taskBranch} at ${HEAD_SHA.slice(0, 12)}`);
    expect(context).toContain("> Fix the bug");
    expect(context).toContain("> I have started on the fix.");
    next.send(next.event("run.started", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "running",
      "the resumed run",
    );
    expect(await runRows(world.stub)).toEqual([expect.objectContaining({ id: "run_1" })]);

    // What a browser replaying the session sees, from the pause to the resumed
    // run, in order. The relayed output and the commands' own receipts are left
    // out; a real bridge also reports `runtime.connected` before `runtime.ready`.
    const quiet = new Set(["sandbox.output", "command.acknowledged", "message.queued"]);
    const seen = (await eventTypes(world.stub))
      .slice(beforePause)
      .filter((type) => !quiet.has(type));
    expect(seen).toEqual([
      "run.paused",
      "sandbox.idle",
      "command.rejected",
      "repository.checkpointed",
      "sandbox.checkpointed",
      "sandbox.credentials_revoked",
      "sandbox.stopped",
      "command.rejected",
      "sandbox.provisioning",
      "sandbox.attached",
      "runtime.ready",
      "run.started",
    ]);
  });

  it("a rejected-key pause whose connection is still active lets Continue through at once, and each further stop waits for the user", async () => {
    // What a key check that could not finish leaves: the run paused as
    // `authentication_failed`, the connection's row untouched.
    const world = await sessionOnRealDriver("sess_continue_key_unsettled");
    const rejected = (bridge: Awaited<ReturnType<typeof readyBridge>>) =>
      bridge.event("run.paused", {
        runId: "run_1",
        payload: {
          reason: "model_failure",
          detail: "Model request failed: authentication_failed",
          modelFailure: {
            category: "authentication_failed",
            message: "The stored key was rejected.",
            retries: 0,
          },
          checkpointId: null,
        },
      });
    const stops = async () => (await eventsOfType(world.stub, "sandbox.stopped")).length;
    const first = await readyBridge(world, 1, { closeOnShutdown: true });
    first.send(first.event("run.started", { runId: "run_1" }));
    first.send(rejected(first));
    await waitFor(async () => (await stops()) === 1, "the first stop");

    const client = await openClient(world);
    await client.send(followUpCommand("cmd_cont_1", "msg_cont_1", "run_1", "paused"));
    await waitForGeneration(world, 2);
    expect(await eventsOfType(world.stub, "command.rejected")).toEqual([]);

    // The next model call settles it: the key is rejected again, on the new sandbox.
    const second = await readyBridge(world, 2, { closeOnShutdown: true });
    second.send(second.event("run.started", { runId: "run_1" }));
    second.send(rejected(second));
    await waitFor(async () => (await stops()) === 2, "the second stop");

    // Nothing starts a third sandbox but another Continue from the user.
    await settle();
    await fireAlarm(world.stub);
    await fireAlarm(world.stub);
    await settle();
    expect(await sessionGeneration(world.stub)).toBe(2);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(2);
    expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(2);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused", outcome: null });
    expect(await storedAlarm(world.stub)).toBeNull();
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "stopped", provider: "modal" },
      { generation: 2, state: "stopped", provider: "modal" },
    ]);
  });

  it("a Continue on a run paused on a usage limit resumes it once the sandbox has idled out", async () => {
    const world = await sessionOnRealDriver("sess_continue_model_failure");
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(
      bridge.event("run.paused", {
        runId: "run_1",
        payload: {
          reason: "model_failure",
          modelFailure: {
            category: "usage_limit_reached",
            message: "The account's allowance is used up.",
            retries: 0,
          },
        },
      }),
    );
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "paused",
      "the pause",
    );
    await settle();
    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);

    // A paused run does not hold the idle stop off, and only a rejected key hurries it.
    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the idle stop",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "paused" });

    // The allowance is topped up, and the user presses Continue.
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_cont", "msg_cont", "run_1", "paused"));
    await waitForGeneration(world, 2);

    expect(await eventsOfType(world.stub, "command.rejected")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "provisioning" });
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(start.runId).toBe("run_1");
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_cont",
      payload: { instruction: { text: "Message msg_cont" } },
    });
    expect(Object.hasOwn(commandOf(start).payload, "skipRequiredChecks")).toBe(false);
  });

  it("a run.start admitted during a stop is provisioned when the stop finishes", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_resume_during_stop");
    await idleStopIssued(world, bridge);
    const client = await openClient(world);

    await client.send(runStartCommand("cmd_start_2", "msg_2", "Now the other bug"));
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
    const runId = String((await eventsOfType(world.stub, "run.queued"))[1]?.runId);
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "queued" });

    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
    await waitForGeneration(world, 2);

    expect((await eventsOfType(world.stub, "sandbox.provisioning"))[1]).toMatchObject({
      sandboxGeneration: 2,
      payload: { reason: "resume" },
    });
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "provisioning" });
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_start_2",
      payload: { instruction: { messageId: "msg_2", text: "Now the other bug" } },
    });
    expect(start.runId).toBe(runId);
    expect(String(start.context)).toContain("> Fix the bug");
  });

  it("a run.start rebuilt from its run.queued keeps the user's request to skip the required checks", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_resume_keeps_skip");
    await idleStopIssued(world, bridge);
    const client = await openClient(world);

    const start = runStartCommand("cmd_start_skip", "msg_skip", "Ship it without the tests");
    await client.send({ ...start, payload: { ...start.payload, skipRequiredChecks: true } });
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
    await waitForGeneration(world, 2);

    const next = await readyBridge(world, 2);
    const rebuilt = next.commands("run.start")[0] as Record<string, unknown>;
    expect(commandOf(rebuilt)).toMatchObject({
      commandId: "cmd_start_skip",
      payload: { instruction: { messageId: "msg_skip" }, skipRequiredChecks: true },
    });
  });

  it("a run.start rebuilt from a run.queued stored before the effort level existed runs at null effort", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_resume_old_model");
    // Older sessions stored their model record this way.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE event SET envelope_json = json_remove(envelope_json, '$.payload.model.effort') WHERE event_type = 'run.queued'",
      );
    });
    await idleStopIssued(world, bridge);
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_old", "msg_old", "Carry on"));
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: HEAD_SHA });
    await waitForGeneration(world, 2);

    const next = await readyBridge(world, 2);
    const rebuilt = next.commands("run.start")[0] as Record<string, unknown>;
    expect(commandOf(rebuilt)).toMatchObject({
      payload: { model: { modelId: "claude-sonnet-4-5", effort: null } },
    });
    expect(next.grants("model")[0]).toMatchObject({ kind: "model", effort: null });
  });

  it("a resume whose clone failed at boot fails its run and remembers nothing that blocks the next message", async () => {
    // A failed boot (for example after the base branch moved, record 07) must
    // not be held against the session: the next message makes a fresh
    // generation whose bridge gets the same commit.
    const world = await stoppedIdle("sess_resume_after_boot_failure");
    const client = await openClient(world);
    const detail =
      "The commit this session started from (8beef270) is no longer on GitHub: the history of main was rewritten. Start a new session to continue from main as it is now.";

    await client.send(runStartCommand("cmd_start_2", "msg_2", "Carry on"));
    await waitForGeneration(world, 2);
    const failing = await connectBridge(world, 2);
    await failing.hello();
    await waitFor(() => failing.grants("git").length >= 1, "the git grant");
    failing.send(
      failing.event("runtime.disconnected", {
        payload: { reason: "boot_failed", detail, expectReconnect: false },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "the failed run",
    );
    const failedRunId = String((await eventsOfType(world.stub, "run.queued"))[1]?.runId);
    expect((await eventsOfType(world.stub, "run.failed"))[0]).toMatchObject({
      runId: failedRunId,
      payload: { stage: "provisioning", error: { message: detail } },
    });
    failing.close();

    await client.send(runStartCommand("cmd_start_3", "msg_3", "Try again"));
    await waitForGeneration(world, 3);
    const retry = await connectBridge(world, 3);
    await retry.hello();
    await waitFor(() => retry.grants("git").length >= 1, "the retry's git grant");
    expect(retry.grants("git")[0]).toMatchObject({
      sandboxGeneration: 3,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
    const retryRunId = String((await eventsOfType(world.stub, "run.queued"))[2]?.runId);
    expect(retryRunId).not.toBe(failedRunId);
    expect(await runRowOf(world.stub, retryRunId)).toMatchObject({ state: "provisioning" });
  });

  it("two run.starts at once make exactly one new generation", async () => {
    const world = await stoppedIdle("sess_resume_twice");
    const client = await openClient(world);

    await client.sendTogether([
      runStartCommand("cmd_start_2", "msg_2", "First"),
      runStartCommand("cmd_start_3", "msg_3", "Second"),
    ]);
    await waitForGeneration(world, 2);
    await settle();

    expect(await sessionGeneration(world.stub)).toBe(2);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(2);
    expect(await attachmentStates(world.stub)).toHaveLength(2);
    expect(await eventsOfType(world.stub, "run.queued")).toHaveLength(3);
    const rows = (await dispatchRows(world.stub)).filter((row) => row.generation === 2);
    expect(rows.map((row) => row.intent_id).sort()).toEqual(["cmd_start_2", "cmd_start_3"]);
    expect(rows.every((row) => row.state === "pending")).toBe(true);
  });

  it("a sandbox that fails to start after the user cancelled its run records the failure but not a second ending for the run", async () => {
    const world = await stoppedIdle("sess_resume_cancel_before_failure");
    let creates = 0;
    world.setController((operation) => {
      // The create never landed, so a lookup by name finds nothing to adopt.
      if (operation === "getStatus") {
        return Response.json(
          { kind: "error", category: "not_found", message: "gone", retryable: false },
          { status: 404 },
        );
      }
      if (operation !== "create") {
        return undefined;
      }
      creates += 1;
      return new Promise<Response>((resolve) =>
        setTimeout(
          () =>
            resolve(
              Response.json(
                { kind: "error", category: "unknown", message: "no capacity", retryable: true },
                { status: 503 },
              ),
            ),
          3_000,
        ),
      );
    });
    const client = await openClient(world);

    await client.send(runStartCommand("cmd_start_doomed", "msg_doomed", "Try again"));
    await waitFor(() => creates >= 1, "the new sandbox to be asked for");
    const runId = String((await eventsOfType(world.stub, "run.queued")).at(-1)?.runId);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel_doomed",
      runId,
      issuedAt: "2026-09-02T00:00:00.000Z",
      expected: { scope: "run", state: "provisioning" },
      payload: { reason: null, checkpointFirst: false },
    });
    await waitFor(
      async () =>
        (await eventsOfType(world.stub, "sandbox.stopped")).some(
          (event) => (event.payload as { reason: string }).reason === "provisioning_failed",
        ),
      "the provisioning failure",
      15_000,
    );

    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
    expect(await runRowOf(world.stub, runId)).toMatchObject({
      state: "cancelled",
      outcome: "cancelled",
    });
  });

  it("fails the resumed run when the workspace's Modal connection cannot be opened", async () => {
    const world = await stoppedIdle("sess_resume_no_credential");
    await env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
      .bind(world.workspaceId)
      .run();
    const client = await openClient(world);

    await client.send(runStartCommand("cmd_start_2", "msg_2", "Now the other bug"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.failed")).length >= 1,
      "run.failed",
    );

    const runId = String((await eventsOfType(world.stub, "run.queued"))[1]?.runId);
    expect((await eventsOfType(world.stub, "run.failed"))[0]).toMatchObject({
      runId,
      payload: { stage: "provisioning", error: { category: "modal_connection_unavailable" } },
    });
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "failed" });
    expect(await sessionGeneration(world.stub)).toBe(1);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
  });

  it("a git grant row from an older object names the base as head and restores nothing", async () => {
    const world = await sessionOnRealDriver("sess_resume_old_row", { repository: REPOSITORY });
    const bridge = await connectBridge(world);
    await bridge.hello();
    await waitFor(() => bridge.grants("git").length >= 1, "the git grant");
    bridge.close();
    await runInDurableObject(world.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ intent_id: string; payload_json: string }>(
          "SELECT intent_id, payload_json FROM bridge_dispatch WHERE kind = 'git_grant'",
        )
        .one();
      const {
        headSha: _head,
        restoreArtifactId: _restore,
        ...rest
      } = JSON.parse(row.payload_json) as Record<string, unknown>;
      state.storage.sql.exec(
        "UPDATE bridge_dispatch SET payload_json = ? WHERE intent_id = ?",
        JSON.stringify(rest),
        row.intent_id,
      );
    });

    const again = await connectBridge(world);
    await again.hello();
    await waitFor(() => again.grants("git").length >= 1, "the re-sent git grant");
    expect(again.grants("git")[0]).toMatchObject({
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
      restore: null,
    });
  });
});

describe("the planned replacement before the ceiling", () => {
  async function nearCeiling(
    sessionId: string,
    options: {
      readonly running: boolean;
      /** With `running` false: leave the run `ready`, handed to the bridge and never started. */
      readonly neverStarted?: boolean;
      readonly controller?: ControllerScript;
    },
  ) {
    const world = await sessionOnRealDriver(sessionId, {
      repository: REPOSITORY,
      ...(options.controller === undefined ? {} : { controller: options.controller }),
    });
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
    if (options.running) {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "running",
        "running",
      );
      // The user's newest request is a steer, which the replacement's
      // context quotes in place of the run's first instruction.
      const client = await openClient(world);
      await client.send(
        followUpCommand("cmd_steer_ceiling", "msg_steer_ceiling", "run_1", "running"),
      );
      await waitFor(() => bridge.commands("run.follow_up").length >= 1, "the steer");
    } else if (options.neverStarted !== true) {
      await finishRun(world, bridge);
    }
    await setAttachmentExpiry(world.stub, 1, Date.now() + 29 * MIN);
    await fireAlarm(world.stub);
    await waitFor(() => bridge.commands("checkpoint.create").length >= 1, "the checkpoint command");
    return { world, bridge };
  }

  it("checkpoints, revokes, terminates, interrupts the running run, and provisions generation 2 with a run.start owed", async () => {
    const { world, bridge } = await nearCeiling("sess_ceiling_running", { running: true });

    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
    expect(bridge.grants("push")[0]).toMatchObject({ ref: `refs/heads/${REPOSITORY.taskBranch}` });
    expect(bridge.commands("checkpoint.create")[0]).toMatchObject({
      command: { payload: { reason: "lifetime_ceiling" } },
    });
    expect(await stopRow(world.stub, 1)).toMatchObject({
      cause: "lifetime_ceiling",
      step: "awaiting_checkpoint",
      interrupted_run_id: "run_1",
    });

    reportCheckpoint(bridge, {
      checkpointId: "ckpt_ceiling",
      headSha: HEAD_SHA,
      reason: "lifetime_ceiling",
    });
    await waitForGeneration(world, 2);

    const types = await eventTypes(world.stub);
    const at = (type: string) => types.indexOf(type);
    expect(at("sandbox.credentials_revoked")).toBeLessThan(at("run.interrupted"));
    expect(at("run.interrupted")).toBeLessThan(at("sandbox.replaced"));
    expect(at("sandbox.replaced")).toBeLessThan(types.lastIndexOf("sandbox.provisioning"));
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({ reason: "lifetime_ceiling" });
    expect(bridge.commands("runtime.shutdown")[0]).toMatchObject({
      command: { payload: { reason: "replaced" } },
    });
    expect((await eventsOfType(world.stub, "run.interrupted"))[0]).toMatchObject({
      runId: "run_1",
      sandboxGeneration: 1,
      payload: { reason: "sandbox_replaced", resumableFrom: "ckpt_ceiling" },
    });
    expect((await eventsOfType(world.stub, "sandbox.replaced"))[0]).toMatchObject({
      sandboxGeneration: 2,
      payload: { previousGeneration: 1, reason: "lifetime_ceiling", restoredFrom: "ckpt_ceiling" },
    });
    expect((await eventsOfType(world.stub, "sandbox.provisioning"))[1]?.payload).toMatchObject({
      reason: "replacement",
    });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "replaced", provider: "modal" },
      { generation: 2, state: "attached", provider: "modal" },
    ]);
    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "provisioning" });

    const next = await readyBridge(world, 2);
    expect(next.grants("git")[0]).toMatchObject({ headSha: HEAD_SHA, restore: null });
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(start.runId).toBe("run_1");
    expect(commandOf(start).payload.instruction.text).toBe(
      "Continue the work in progress from the checkpoint.",
    );
    const context = String(start.context);
    expect(context).toContain("reached its lifetime limit and was replaced");
    // The replay names the run's first instruction and the steer after it,
    // since the prompt is OnCue's own "continue", not either of them.
    expect(context).toContain("Turn 1, ended interrupted:");
    expect(context.indexOf("> Fix the bug")).toBeGreaterThan(0);
    expect(context.indexOf("> Message msg_steer_ceiling")).toBeGreaterThan(
      context.indexOf("> Fix the bug"),
    );
    expect(context).not.toContain("> Continue the work in progress");
    expect(await storedAlarm(world.stub)).not.toBeNull();
  });

  it("with no run to carry, the replacement provisions with nothing owed", async () => {
    const { world, bridge } = await nearCeiling("sess_ceiling_quiet", { running: false });
    expect(await stopRow(world.stub, 1)).toMatchObject({ interrupted_run_id: null });

    reportCheckpoint(bridge, { checkpointId: "ckpt_quiet", reason: "lifetime_ceiling" });
    await waitForGeneration(world, 2);

    expect(await eventsOfType(world.stub, "run.interrupted")).toEqual([]);
    expect((await eventsOfType(world.stub, "sandbox.replaced"))[0]?.payload).toMatchObject({
      restoredFrom: "ckpt_quiet",
    });
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "completed_with_warnings" });
    expect((await dispatchRows(world.stub)).filter((row) => row.generation === 2)).toEqual([]);

    const next = await connectBridge(world, 2);
    await next.hello();
    await waitFor(() => next.grants("model").length >= 1, "the grants");
    next.send(next.event("runtime.ready"));
    await settle();
    expect(next.frames("bridge.command")).toEqual([]);
  });

  it("carries a run the old sandbox was handed but never started, with its own instruction under a fresh command id", async () => {
    const { world, bridge } = await nearCeiling("sess_ceiling_never_started", {
      running: false,
      neverStarted: true,
    });
    // The bridge accepted the run.start and OpenCode never began it, so the
    // old generation's row for that command id stays behind.
    const firstCommandId = commandOf(
      bridge.commands("run.start")[0] as Record<string, unknown>,
    ).commandId;
    bridge.ack({ commandId: firstCommandId });
    await waitFor(
      async () =>
        (await dispatchRows(world.stub)).some(
          (row) => row.intent_id === firstCommandId && row.state === "accepted",
        ),
      "the run.start's acceptance",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "ready" });
    expect(await stopRow(world.stub, 1)).toMatchObject({ interrupted_run_id: null });

    reportCheckpoint(bridge, { checkpointId: "ckpt_never", reason: "lifetime_ceiling" });
    await waitForGeneration(world, 2);

    // Never executing, so never interrupted; carried rather than left `ready`.
    expect(await eventsOfType(world.stub, "run.interrupted")).toEqual([]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "provisioning" });
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(start.runId).toBe("run_1");
    expect(commandOf(start).payload.instruction.text).toBe("Fix the bug");
    expect(commandOf(start).commandId).not.toBe(firstCommandId);
    // Its own instruction is the prompt, and the session has no other to quote.
    const context = String(start.context);
    expect(context).toContain("reached its lifetime limit and was replaced");
    expect(context).not.toContain("> Fix the bug");
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "ready" });
  });

  /** Slows the stop's last output fetch to two seconds once `slow` is set; a timer, since workerd abandons a promise with no I/O. */
  function slowOutput(): { readonly controller: ControllerScript; begin(): void } {
    let slow = false;
    return {
      begin() {
        slow = true;
      },
      controller: (operation) =>
        operation === "getOutput" && slow
          ? new Promise<Response>((resolve) => {
              setTimeout(
                () =>
                  resolve(
                    Response.json(
                      { kind: "error", category: "not_found", message: "gone", retryable: false },
                      { status: 404 },
                    ),
                  ),
                2_000,
              );
            })
          : undefined,
    };
  }

  it("carries a run.start that arrived while the replacement was under way instead of the interrupted run", async () => {
    const output = slowOutput();
    const { world, bridge } = await nearCeiling("sess_ceiling_race", {
      running: true,
      controller: output.controller,
    });
    const client = await openClient(world);

    // The checkpoint times out and the runtime's own alarm drives the stop
    // through, so nothing races it to the replace step; the run.start lands
    // while that alarm is still fetching the old sandbox's output.
    output.begin();
    await ageStop(world.stub, 1);
    await armAlarmNow(world.stub);
    await waitFor(
      async () => (await stopRow(world.stub, 1))?.step === "replace",
      "the replace step",
    );
    client.push(runStartCommand("cmd_start_2", "msg_2", "Something new"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.queued")).length >= 2,
      "the new run",
    );
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
    expect(bridge.commands("run.start")).toHaveLength(1);
    await waitForGeneration(world, 2);

    const runId = String((await eventsOfType(world.stub, "run.queued"))[1]?.runId);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "interrupted" });
    expect(await runRowOf(world.stub, runId)).toMatchObject({ state: "provisioning" });
    expect(
      (await dispatchRows(world.stub)).filter((row) => row.generation === 1),
    ).not.toContainEqual(expect.objectContaining({ intent_id: "cmd_start_2" }));
    const next = await readyBridge(world, 2);
    const start = next.commands("run.start")[0] as Record<string, unknown>;
    expect(commandOf(start)).toMatchObject({
      commandId: "cmd_start_2",
      payload: { instruction: { text: "Something new" } },
    });
    expect(start.runId).toBe(runId);
    // The carried run's own instruction is its prompt; the context quotes the
    // user's request before it rather than repeating this one.
    const context = String(start.context);
    expect(context).not.toContain("Something new");
    expect(context).toContain("> Message msg_steer_ceiling");
  });

  it("a user's stop while the old sandbox is being wound down cancels the replacement, and the runs end as the user's", async () => {
    const output = slowOutput();
    const { world, bridge } = await nearCeiling("sess_ceiling_user_stop_at_replace", {
      running: true,
      controller: output.controller,
    });

    // The report drives the stop through its terminate and into the slow
    // last fetch of the old sandbox's output, with the row at `replace`.
    const alarms = await holdAlarms(world);
    output.begin();
    reportCheckpoint(bridge, {
      checkpointId: "ckpt_cancel",
      headSha: HEAD_SHA,
      reason: "lifetime_ceiling",
    });
    await waitFor(
      async () => (await stopRow(world.stub, 1))?.step === "replace",
      "the replace step",
    );
    const stop = () =>
      runInDurableObject(world.stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
      );

    // The old sandbox is already terminated and nothing will start in its place.
    expect(await sessionGeneration(world.stub)).toBe(1);
    expect(await stop()).toEqual({ kind: "stopped", generation: 1 });
    // The report's own loop returns from the slow fetch and finds the stop done.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await settle();
    // The alarm path, released, provisions nothing either.
    await alarms.release();
    await fireAlarm(world.stub);
    await settle();

    expect(await sessionGeneration(world.stub)).toBe(1);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "sandbox.replaced")).toEqual([]);
    expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
    expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
      outcome: "stopped",
      reason: "user_requested",
      checkpointId: "ckpt_cancel",
    });
    expect(await eventsOfType(world.stub, "run.cancelled")).toEqual([
      expect.objectContaining({
        runId: "run_1",
        payload: expect.objectContaining({ by: { kind: "user", userId: "user_1" } }),
      }),
    ]);
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    expect(await stopRow(world.stub, 1)).toMatchObject({ cause: "user_requested", step: "done" });
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "replaced", provider: "modal" },
    ]);
    // Nothing is left to stop.
    expect(await stop()).toEqual({ kind: "not_running" });
  });

  it("a user's stop while the replacement is still committing its generation cancels it before any sandbox is made", async () => {
    const { world, bridge } = await nearCeiling("sess_ceiling_user_stop_committing", {
      running: true,
    });
    const alarms = await holdAlarms(world);
    // Every Modal connection read is held three seconds. The terminate step's
    // reads finish before the stop is done, so one still in flight after that
    // is the replacement's.
    const read = await holdModalConnectionRead(world, 3_000);
    try {
      reportCheckpoint(bridge, { checkpointId: "ckpt_commit", reason: "lifetime_ceiling" });
      await waitFor(
        async () => (await stopRow(world.stub, 1))?.step === "done" && read.held() > read.done(),
        "the replacement to open the Modal connection",
        15_000,
      );
      expect(await stopRow(world.stub, 1)).toMatchObject({
        step: "done",
        cause: "lifetime_ceiling",
      });
      expect(await sessionGeneration(world.stub)).toBe(1);
      const stop = () =>
        runInDurableObject(world.stub, (instance) =>
          instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
        );

      expect(await stop()).toEqual({ kind: "stopped", generation: 1 });
      // A second click while the resume is still waiting: the replacement is
      // already cancelled, so there is nothing more to stop.
      expect(await stop()).toEqual({ kind: "not_running" });
      await waitFor(() => read.done() >= read.held(), "the held read to return", 15_000);
      await settle();
      await alarms.release();
      await fireAlarm(world.stub);
      await settle();

      expect(await sessionGeneration(world.stub)).toBe(1);
      expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
      expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
      expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
      expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
      expect((await eventsOfType(world.stub, "sandbox.stopped"))[0]?.payload).toMatchObject({
        reason: "user_requested",
        checkpointId: "ckpt_commit",
      });
    } finally {
      await read.restore();
      await alarms.release();
    }
  });

  it("a stop the alarm finishes beside the bridge's report ends that report's loop quietly", async () => {
    const output = slowOutput();
    const { world, bridge } = await nearCeiling("sess_ceiling_beside_alarm", {
      running: true,
      controller: output.controller,
    });

    // The bridge's report drives the stop into `afterTerminate`, whose slow
    // fetch the alarm armed for the replace step runs beside; when the fetch
    // returns, the session is already on generation 2 with no stop of its own.
    output.begin();
    reportCheckpoint(bridge, { checkpointId: "ckpt_beside", reason: "lifetime_ceiling" });
    await waitForGeneration(world, 2);
    await waitFor(
      async () =>
        world.controllerCalls.filter((call) => call.operation === "getOutput").length >= 3,
      "the slow fetch to return",
      15_000,
    );
    await settle();

    expect(await stopRow(world.stub, 1)).toMatchObject({ step: "done" });
    expect(await stopRow(world.stub, 2)).toBeNull();
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(2);
    expect(await sessionGeneration(world.stub)).toBe(2);
  });

  it("a stop during an ordinary resume after a failed replacement cancels nothing, and a run cancelled in that wait is not started", async () => {
    let disconnect = false;
    const { world, bridge } = await nearCeiling("sess_ceiling_then_ordinary_resume", {
      running: false,
      controller: (operation) => {
        if (operation === "getOutput" && disconnect) {
          return env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
            .bind(world.workspaceId)
            .run()
            .then(() =>
              Response.json(
                { kind: "error", category: "not_found", message: "gone", retryable: false },
                { status: 404 },
              ),
            );
        }
        return undefined;
      },
    });
    // The replacement cannot open the Modal connection and returns early,
    // leaving generation 1 replaced with its stop done.
    disconnect = true;
    reportCheckpoint(bridge, {
      checkpointId: "ckpt_failed_replacement",
      reason: "lifetime_ceiling",
    });
    await waitFor(
      async () => (await stopRow(world.stub, 1))?.step === "done",
      "the stop to finish",
    );
    await settle();
    disconnect = false;
    expect(await sessionGeneration(world.stub)).toBe(1);

    // The user reconnects Modal and sends a task: an ordinary resume, whose
    // credential read is held.
    await seedModalConnection(world.workspaceId);
    const client = await openClient(world);
    const read = await holdModalConnectionRead(world, 3_000);
    try {
      await client.send(runStartCommand("cmd_start_after", "msg_after", "Carry on"));
      await waitFor(() => read.held() >= 1, "the resume to open the Modal connection");
      const runId = String((await eventsOfType(world.stub, "run.queued")).at(-1)?.runId);

      // Not a replacement: nothing is running, and the stop cancels nothing.
      expect(
        await runInDurableObject(world.stub, (instance) =>
          instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
        ),
      ).toEqual({ kind: "not_running" });
      expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
      expect(await eventsOfType(world.stub, "run.cancelled")).toEqual([]);

      // The user cancels the new run while the resume still waits.
      await client.send({
        type: "run.cancel",
        commandId: "cmd_cancel_after",
        runId,
        issuedAt: "2026-09-02T00:00:00.000Z",
        expected: { scope: "run", state: "queued" },
        payload: { reason: null, checkpointFirst: false },
      });
      expect(await runRowOf(world.stub, runId)).toMatchObject({
        state: "cancelled",
        outcome: "cancelled",
      });
      await waitFor(() => read.done() >= 1, "the held read to return", 15_000);
      await settle();

      // The resume found its run ended and started nothing.
      expect(await sessionGeneration(world.stub)).toBe(1);
      expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
      expect(world.controllerCalls.filter((call) => call.operation === "create")).toHaveLength(1);
      expect(await runRowOf(world.stub, runId)).toMatchObject({
        state: "cancelled",
        outcome: "cancelled",
      });
    } finally {
      await read.restore();
    }
  });

  it("provisions nothing when the replacement cannot open the workspace's Modal connection", async () => {
    let disconnect = false;
    const { world, bridge } = await nearCeiling("sess_ceiling_no_credential", {
      running: false,
      controller: (operation) => {
        if (operation === "getOutput" && disconnect) {
          return env.DB.prepare("DELETE FROM modal_connection WHERE workspace_id = ?")
            .bind(world.workspaceId)
            .run()
            .then(() =>
              Response.json(
                { kind: "error", category: "not_found", message: "gone", retryable: false },
                { status: 404 },
              ),
            );
        }
        return undefined;
      },
    });

    disconnect = true;
    reportCheckpoint(bridge, { checkpointId: "ckpt_disc", reason: "lifetime_ceiling" });
    await waitFor(
      async () => (await stopRow(world.stub, 1))?.step === "done",
      "the stop to finish",
    );
    await settle();

    expect(await sessionGeneration(world.stub)).toBe(1);
    expect(await eventsOfType(world.stub, "sandbox.provisioning")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "run.failed")).toEqual([]);
    expect(await attachmentStates(world.stub)).toEqual([
      { generation: 1, state: "replaced", provider: "modal" },
    ]);
  });
});

describe("keep-alive", () => {
  const keepAlive = (world: World) =>
    callObject<{ kind: string; expiresAt?: string }>(world, "keep-alive", {});

  it("extends by an hour, arms the idle alarm at the new expiry, and is bounded by the ceiling", async () => {
    const world = await sessionOnRealDriver("sess_keep_alive");
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);

    const before = Date.now();
    const first = await keepAlive(world);
    expect(first.kind).toBe("extended");
    const expiresAt = Date.parse(first.expiresAt as string);
    expect(expiresAt - before).toBeGreaterThanOrEqual(60 * MIN);
    expect(expiresAt - before).toBeLessThan(60 * MIN + 5_000);
    expect((await eventsOfType(world.stub, "sandbox.keepalive.updated"))[0]?.payload).toEqual({
      expiresAt: first.expiresAt,
      requestedBy: "user",
      minutes: 60,
    });
    expect(await storedAlarm(world.stub)).toBe(expiresAt);

    await setAttachmentExpiry(world.stub, 1, Date.now() + 40 * MIN);
    const bounded = await keepAlive(world);
    const boundedAt = Date.parse(bounded.expiresAt as string);
    expect(boundedAt - Date.now()).toBeLessThanOrEqual(10 * MIN);
    expect(boundedAt - Date.now()).toBeGreaterThan(9 * MIN);
    expect((await eventsOfType(world.stub, "sandbox.keepalive.updated"))[1]?.payload).toMatchObject(
      { minutes: 10 },
    );

    // Quiet past the idle deadline but inside the keep-alive: no stop begins.
    await ageEvents(world.stub, 30 * MIN);
    await fireAlarm(world.stub);
    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
    expect(await stopRow(world.stub, 1)).toBeNull();
  });

  it("is not_running without a session, without a live sandbox, and during a stop", async () => {
    const fresh = stubFor("sess_keep_alive_nobody");
    const response = await fresh.fetch("https://do/internal/keep-alive", { method: "POST" });
    expect(await response.json()).toEqual({ kind: "not_running" });

    const { world, bridge } = await quietRepositoryWorld("sess_keep_alive_stopping");
    await idleStopIssued(world, bridge);
    expect(await keepAlive(world)).toEqual({ kind: "not_running" });
    reportCheckpoint(bridge, { checkpointId: "ckpt_ka" });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    expect(await keepAlive(world)).toEqual({ kind: "not_running" });
    expect(await eventsOfType(world.stub, "sandbox.keepalive.updated")).toEqual([]);
  });
});
