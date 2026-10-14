// Checks on demand at the object's boundary (record 14): a run with no changes
// ends Done, a checks-only run is `checks_requested`, and a publish waits for
// some run's checks to cover its code, running them first if none does.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  eventsOfType,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  registerSessionWorlds,
  runRowOf,
  runStartCommand,
  type SessionWorld,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { CHECKS_BEFORE_PUBLISH_TEXT } from "./publish-cover";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

function allowPush(commandId: string) {
  return {
    type: "policy.set",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: {
      action: "set",
      policyVersion: 1,
      commit: "auto",
      push: "auto",
      pullRequest: "manual",
    },
  };
}

async function publishRuns(world: SessionWorld): Promise<string[]> {
  return runInDurableObject(world.stub, (_instance, state) =>
    [
      ...state.storage.sql.exec<{ run_id: string }>(
        "SELECT run_id FROM publish ORDER BY requested_at",
      ),
    ].map((row) => row.run_id),
  );
}

/** A change the user cancelled mid-run, so no run's checks cover the code. */
async function cancelledChange(world: SessionWorld, bridge: TestBridge): Promise<string> {
  const runId = await nextRun(world, bridge, "Rename the helper.");
  bridge.send(bridge.event("run.started", { runId }));
  await waitFor(async () => (await runRowOf(world.stub, runId)).state === "running", "the start");
  const client = await openClient(world);
  await client.send({
    type: "run.cancel",
    commandId: "cmd_cancel",
    runId,
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "running" },
    payload: { reason: null, checkpointFirst: false },
  });
  await waitFor(
    async () => (await runRowOf(world.stub, runId)).state === "cancelled",
    "the cancel",
  );
  return runId;
}

/** Starts the next run after `run_1` and returns the id the object minted for it. */
async function nextRun(
  world: SessionWorld,
  bridge: TestBridge,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const before = bridge.commands("run.start").length;
  const client = await openClient(world);
  const command = runStartCommand(`cmd_${before}`, `msg_${before}`, text);
  await client.send({
    ...command,
    payload: { ...command.payload, continuesRunId: "run_1", ...extra },
  });
  await waitFor(() => bridge.commands("run.start").length === before + 1, "the next run's start");
  return String((bridge.commands("run.start")[before] as { runId: string }).runId);
}

describe("a run that changed no files (record 14, Done)", () => {
  it("ends completed, and its row reads Done", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_done_row");
    const runId = await nextRun(world, bridge, "What does this repository do?");
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(bridge.event("run.completed", { runId }));
    await waitFor(async () => (await runRowOf(world.stub, runId)).state === "completed", "Done");
    expect(await runRowOf(world.stub, runId)).toMatchObject({ outcome: "completed" });
    expect(await eventsOfType(world.stub, "run.completed")).toHaveLength(1);
  });
});

describe("checks on request", () => {
  it("queues a checks-only run as checks_requested and hands the bridge the flag", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_checks_button");
    const runId = await nextRun(world, bridge, "Run the repository's checks.", {
      checksOnly: true,
    });
    const queued = (await eventsOfType(world.stub, "run.queued")).find(
      (event) => event.runId === runId,
    );
    expect(queued).toMatchObject({ payload: { trigger: "checks_requested" } });
    expect(bridge.commands("run.start").at(-1)).toMatchObject({
      runId,
      command: { payload: { checksOnly: true } },
    });
  });
});

describe("checks before publishing", () => {
  it("publishes after a Done run on the checks of the run before it, with no checks run again", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_after_done");
    const runId = await nextRun(world, bridge, "Push this and open a draft PR");
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(bridge.event("run.completed", { runId }));
    await waitFor(async () => (await runRowOf(world.stub, runId)).state === "completed", "Done");

    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish");

    expect(await publishRuns(world)).toEqual([runId]);
    expect(bridge.commands("run.start")).toHaveLength(2);
  });

  it("runs the checks first when the newest change was cancelled, then publishes on them", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_unchecked");
    const cancelledRun = await nextRun(world, bridge, "Rename the helper.");
    bridge.send(bridge.event("run.started", { runId: cancelledRun }));
    await waitFor(
      async () => (await runRowOf(world.stub, cancelledRun)).state === "running",
      "the run to start",
    );
    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel",
      runId: cancelledRun,
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "running" },
      payload: { reason: null, checkpointFirst: false },
    });
    await waitFor(
      async () => (await runRowOf(world.stub, cancelledRun)).state === "cancelled",
      "the cancel",
    );

    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.commands("run.start").length === 3, "the checks before the push");
    const checks = bridge.commands("run.start")[2] as { runId: string };
    expect(checks).toMatchObject({
      command: {
        payload: {
          checksOnly: true,
          continuesRunId: cancelledRun,
          instruction: { text: CHECKS_BEFORE_PUBLISH_TEXT },
        },
      },
    });
    expect(bridge.commands("checkpoint.create")).toEqual([]);

    bridge.send(bridge.event("run.started", { runId: checks.runId }));
    bridge.send(bridge.event("run.completed_with_warnings", { runId: checks.runId }));
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish");
    expect(await publishRuns(world)).toEqual([checks.runId]);
  });

  it("does not believe a checks run that a sandbox ends Done: the push holds and no second checks run starts", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_forged_done");
    await cancelledChange(world, bridge);
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.commands("run.start").length === 3, "the checks before the push");
    const checks = bridge.commands("run.start")[2] as { runId: string };

    bridge.send(bridge.event("run.started", { runId: checks.runId }));
    bridge.send(bridge.event("run.completed", { runId: checks.runId }));
    await waitFor(
      async () => (await runRowOf(world.stub, checks.runId)).state === "completed",
      "the claimed Done",
    );
    // A second client command settles after the object's reaction to the
    // run's end, so a checks run it wrongly started would already be here.
    await client.send(allowPush("cmd_allow_again"));
    expect(bridge.commands("run.start")).toHaveLength(3);
    expect(bridge.commands("checkpoint.create")).toEqual([]);
  });

  it("names the branch for the work, not for the checks run that covered it", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_checks_branch", {
      repository: { ...REPOSITORY, taskBranch: null },
    });
    await cancelledChange(world, bridge);
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.commands("run.start").length === 3, "the checks before the push");
    const checks = bridge.commands("run.start")[2] as { runId: string };
    bridge.send(bridge.event("run.started", { runId: checks.runId }));
    bridge.send(
      bridge.event("run.completed_with_warnings", {
        runId: checks.runId,
        payload: {
          summary: {
            whatChanged: "Ran the repository's checks on the current code.",
            why: `Requested: ${CHECKS_BEFORE_PUBLISH_TEXT}`,
            verificationPerformed: "pnpm test passed.",
            limitations: [],
            nextStep: null,
          },
        },
      } as never),
    );
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish");
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    const branch = (requested as { payload: { branch: string } }).payload.branch;
    expect(branch).toMatch(/^oncue\/fixed-the-failing-unit-test/);
    expect(branch).not.toContain("ran-the-repository");
  });

  it("holds the push behind a failed run, and starts no checks", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_after_failed");
    const runId = await nextRun(world, bridge, "Rename the helper.");
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(bridge.event("run.failed", { runId }));
    await waitFor(
      async () => (await runRowOf(world.stub, runId)).state === "failed",
      "the failure",
    );

    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the policy",
    );
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(bridge.commands("run.start")).toHaveLength(2);
  });

  it("starts no checks while the operator has stopped new runs (record 22)", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_admission_stopped");
    const cancelled = await nextRun(world, bridge, "Rename the helper.");
    bridge.send(bridge.event("run.started", { runId: cancelled }));
    await waitFor(
      async () => (await runRowOf(world.stub, cancelled)).state === "running",
      "the run to start",
    );
    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel",
      runId: cancelled,
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "running" },
      payload: { reason: null, checkpointFirst: false },
    });
    await env.DB.prepare(
      "UPDATE platform_control SET run_admission = 'stopped' WHERE id = 1",
    ).run();
    try {
      await client.send(allowPush("cmd_allow"));
      await waitFor(
        async () => (await eventsOfType(world.stub, "command.rejected")).length >= 1,
        "the refused checks run",
      );
      expect(bridge.commands("run.start")).toHaveLength(2);
      expect(bridge.commands("checkpoint.create")).toEqual([]);
    } finally {
      await env.DB.prepare("UPDATE platform_control SET run_admission = 'open' WHERE id = 1").run();
    }
  });
});
