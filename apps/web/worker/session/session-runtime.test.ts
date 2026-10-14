// The session's harness on the object's side: written once at creation,
// recorded on every `run.queued`, named on every model grant, and re-judged on
// every `run.start` so an allowlist change reaches the next run.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  eventsOfType,
  finishRun,
  openClient,
  readyBridge,
  registerSessionWorlds,
  runStartCommand,
  sessionOnRealDriver,
  setObjectEnv,
  waitFor,
} from "../test/session-world";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

async function runtimeRow(world: { stub: DurableObjectStub }): Promise<unknown[]> {
  return runInDurableObject(world.stub, (_instance, state) =>
    state.storage.sql.exec("SELECT id, runtime_id FROM session_runtime").toArray(),
  );
}

describe("the session's harness", () => {
  it("is written at creation, recorded on the run, and named on the model grant", async () => {
    const world = await sessionOnRealDriver("sess_runtime_named", {
      body: { runtime: { id: "opencode", version: "1.18.30" } },
    });
    expect(await runtimeRow(world)).toEqual([{ id: 1, runtime_id: "opencode" }]);
    const [queued] = await eventsOfType(world.stub, "run.queued");
    expect(queued?.payload).toMatchObject({ runtime: { id: "opencode", version: "1.18.30" } });
    const bridge = await readyBridge(world);
    expect(bridge.grants("model")[0]).toMatchObject({ runtime: "opencode" });
  });

  it("is OpenCode for a session from a Worker that named none", async () => {
    const world = await sessionOnRealDriver("sess_runtime_default", {
      workspaceId: "ws_runtime_default",
    });
    expect(await runtimeRow(world)).toEqual([{ id: 1, runtime_id: "opencode" }]);
    const [queued] = await eventsOfType(world.stub, "run.queued");
    expect(queued?.payload).toMatchObject({ runtime: { id: "opencode" } });
  });

  it("is OpenCode for a session stored before the adapter boundary, which has no row", async () => {
    const world = await sessionOnRealDriver("sess_runtime_legacy", {
      workspaceId: "ws_runtime_legacy",
    });
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM session_runtime");
    });
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_runtime_legacy", "msg_runtime_legacy", "Again"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.queued")).length === 2,
      "the second run",
    );
    const queued = await eventsOfType(world.stub, "run.queued");
    expect(queued[1]?.payload).toMatchObject({ runtime: { id: "opencode", version: "1.18.30" } });
  });

  it("names OpenCode on the model grant of a session stored with no row", async () => {
    const world = await sessionOnRealDriver("sess_runtime_grant_legacy", {
      workspaceId: "ws_runtime_grant_legacy",
    });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM session_runtime");
    });
    const bridge = await readyBridge(world);
    expect(bridge.grants("model")[0]).toMatchObject({ runtime: "opencode" });
  });

  it("refuses the next run.start once the operator stops allowing it, and names why", async () => {
    const world = await sessionOnRealDriver("sess_runtime_disallowed", {
      workspaceId: "ws_runtime_disallowed",
    });
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    // Objects in one test isolate share one env object, so the value is put
    // back before any other world is created.
    await setObjectEnv(world, { ONCUE_RUNTIME_ALLOWLIST: "something-else" });
    try {
      const client = await openClient(world);
      await client.send(runStartCommand("cmd_runtime_no", "msg_runtime_no", "Again"));
      await waitFor(
        async () => (await eventsOfType(world.stub, "command.rejected")).length === 1,
        "the refusal",
      );
    } finally {
      await setObjectEnv(world, { ONCUE_RUNTIME_ALLOWLIST: "" });
    }
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      commandId: "cmd_runtime_no",
      reason: "unsupported",
      detail: "OpenCode is not enabled on this OnCue",
    });
    expect(await eventsOfType(world.stub, "run.queued")).toHaveLength(1);
  });

  it("refuses a run.start on a session whose stored harness the image no longer carries", async () => {
    const world = await sessionOnRealDriver("sess_runtime_retired", {
      workspaceId: "ws_runtime_retired",
    });
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session_runtime SET runtime_id = 'retired-harness'");
    });
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_runtime_gone", "msg_runtime_gone", "Again"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length === 1,
      "the refusal",
    );
    expect((await eventsOfType(world.stub, "command.rejected"))[0]?.payload).toMatchObject({
      reason: "unsupported",
      detail: "OnCue does not run that harness",
    });
  });
});
