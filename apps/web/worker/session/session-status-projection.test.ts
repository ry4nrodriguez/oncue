// The sidebar's status dot reads `session_index.current_run_id` and
// `current_run_state`. These tests drive a real object and read D1 back, so
// the columns are checked from the rows the object actually writes.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  currentRunInD1,
  finishRun,
  fireAlarm,
  openClient,
  readyBridge,
  registerSessionWorlds,
  runStartCommand,
  sessionOnRealDriver,
  waitFor,
} from "../test/session-world";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const TERMINAL = new Set([
  "verified",
  "completed_with_warnings",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);

describe("the current run in session_index (migration 0015)", () => {
  it("follows the run from start to its outcome", async () => {
    const world = await sessionOnRealDriver("sess_status_run");
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).state === "provisioning",
      "the projection to say provisioning",
    );
    expect((await currentRunInD1(world.sessionId)).runId).toBe("run_1");

    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).state === "running",
      "the projection to say running",
    );

    await finishRun(world, bridge);
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).state === "completed_with_warnings",
      "the projection to carry the outcome",
    );
    expect((await currentRunInD1(world.sessionId)).runId).toBe("run_1");
  });

  it("names the next run once the user starts one, so the sidebar can tell two outcomes apart", async () => {
    const world = await sessionOnRealDriver("sess_status_next_run");
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).state === "completed_with_warnings",
      "the first outcome",
    );

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_next", "msg_next", "Now the other test"));
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).runId !== "run_1",
      "the projection to name the new run",
    );
    const projected = await currentRunInD1(world.sessionId);
    expect(projected.runId).not.toBeNull();
    expect(TERMINAL.has(projected.state ?? "")).toBe(false);
  });

  it("leaves both columns alone when a queued projection predates them", async () => {
    const world = await sessionOnRealDriver("sess_status_old_row");
    await waitFor(
      async () => (await currentRunInD1(world.sessionId)).runId === "run_1",
      "the first projection",
    );
    const before = await currentRunInD1(world.sessionId);

    // An older outbox row with no run fields at all.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, session_id, sequence, fact_type, schema_version, payload_json, created_at, attempts)
         VALUES ('outbox_old', ?, 1000000, 'session_index.snapshot', 1, ?, ?, 0)`,
        world.sessionId,
        JSON.stringify({
          state: "active",
          title: "Fix the failing test",
          lastActivityAt: "2026-09-03T00:00:00.000Z",
          sandboxProviderRef: null,
          sandboxGeneration: 1,
          endedSandboxGeneration: null,
          waitingForUser: false,
        }),
        "2026-09-03T00:00:00.000Z",
      );
    });
    await fireAlarm(world.stub);

    const applied = await runInDurableObject(
      world.stub,
      (_instance, state) =>
        state.storage.sql.exec("SELECT id FROM outbox WHERE id = 'outbox_old'").toArray().length,
    );
    expect(applied).toBe(0);
    expect(await currentRunInD1(world.sessionId)).toEqual(before);
  });
});
