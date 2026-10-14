// `policy.proposed` at the object's boundary (records 07 and 09): narrowing
// applies at once, widening waits for the user, a refused one is never stored,
// and a socket that keeps proposing is cut off.

import { runInDurableObject } from "cloudflare:test";
import { testSessionPolicy } from "@oncue/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import { MAX_PROPOSALS_PER_RUN } from "../policy/git-policy";
import {
  eventsOfType,
  followUpCommand,
  idleStopIssued,
  openClient,
  quietRepositoryWorld,
  readyBridge,
  registerSessionWorlds,
  runRowOf,
  type SessionWorld,
  sessionOnRealDriver,
  settle,
  stubFor,
  type TestBridge,
  WORLD_TIME,
  waitFor,
  waitingForUserInD1,
} from "../test/session-world";
import { MAX_PROPOSAL_REFUSALS } from "./session-object";

function policySet(commandId: string, payload: Record<string, unknown>) {
  return {
    type: "policy.set",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload,
  };
}

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

async function runningWorld(
  sessionId: string,
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

async function policyRow(world: SessionWorld) {
  return runInDurableObject(
    world.stub,
    (_instance, state) =>
      state.storage.sql
        .exec<Record<string, string | number | null>>(
          "SELECT policy_json, open_proposal_id, open_base_version, open_to_json FROM session_policy",
        )
        .toArray()[0] ?? null,
  );
}

const pushing = testSessionPolicy({ push: "auto", pullRequest: "auto_after_verification" });

/** The ids the object minted for the stored proposals, oldest first. The sandbox's own are never kept. */
async function mintedIds(world: SessionWorld): Promise<string[]> {
  return (await eventsOfType(world.stub, "policy.proposed")).map(
    (event) => (event.payload as { proposalId: string }).proposalId,
  );
}

function proposal(
  bridge: TestBridge,
  proposalId: string,
  to: ReturnType<typeof testSessionPolicy>,
  overrides: Record<string, unknown> = {},
) {
  return bridge.event("policy.proposed", {
    payload: {
      proposalId,
      triggeringMessageId: "msg_1",
      from: testSessionPolicy(),
      to,
      direction: "narrowing",
      rationale: "The user asked.",
      ...overrides,
    },
  });
}

describe("a policy.proposed frame", () => {
  it('that widens marks the session "Needs you" in the sidebar until it is answered', async () => {
    const { world, bridge } = await runningWorld("sess_policy_needs_you");
    expect(await waitingForUserInD1(world.sessionId)).toBe(false);
    bridge.send(proposal(bridge, "prop_widen", pushing));
    await waitFor(async () => (await mintedIds(world)).length === 1, "the held proposal");
    await waitFor(() => waitingForUserInD1(world.sessionId), "the projection to say waiting");
    const client = await openClient(world);
    await client.send(
      policySet("cmd_decline_card", { action: "decline", proposalId: (await mintedIds(world))[0] }),
    );
    await settle();
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to clear",
    );
  });

  it("that widens is held with the direction the object computed, and changes nothing", async () => {
    const { world, bridge } = await runningWorld("sess_policy_hold");
    bridge.send(proposal(bridge, "prop_widen", pushing));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.proposed")).length === 1,
      "the stored proposal",
    );
    await settle();

    const [stored] = await eventsOfType(world.stub, "policy.proposed");
    expect(stored).toMatchObject({
      payload: {
        from: testSessionPolicy(),
        to: { ...pushing, version: 2 },
        direction: "widening",
      },
    });
    expect(await eventsOfType(world.stub, "policy.updated")).toEqual([]);
    // The bridge was told the default when its runtime came up, and nothing since.
    expect(bridge.frames("bridge.policy")).toEqual([
      {
        type: "bridge.policy",
        sessionId: "sess_policy_hold",
        sandboxGeneration: 1,
        policy: testSessionPolicy(),
      },
    ]);
    expect(await policyRow(world)).toMatchObject({
      policy_json: JSON.stringify(testSessionPolicy()),
      open_proposal_id: (await mintedIds(world))[0],
      open_base_version: 1,
    });
    expect((await mintedIds(world))[0]).not.toBe("prop_widen");
  });

  it("that narrows is in force at once, and drops an open proposal", async () => {
    const { world, bridge } = await runningWorld("sess_policy_narrow");
    bridge.send(proposal(bridge, "prop_widen", pushing));
    bridge.send(proposal(bridge, "prop_never", testSessionPolicy({ push: "never" })));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the update",
    );

    const [updated] = await eventsOfType(world.stub, "policy.updated");
    expect(updated).toMatchObject({
      runId: null,
      payload: {
        proposalId: (await mintedIds(world))[1],
        confirmedBy: "immediate_narrowing",
        userId: null,
        from: testSessionPolicy(),
        to: testSessionPolicy({ push: "never", version: 2 }),
      },
    });
    await waitFor(() => bridge.frames("bridge.policy").length === 2, "the bridge to be told");
    expect(bridge.frames("bridge.policy")[1]).toMatchObject({
      policy: testSessionPolicy({ push: "never", version: 2 }),
    });
    expect(await policyRow(world)).toEqual({
      policy_json: JSON.stringify(testSessionPolicy({ push: "never", version: 2 })),
      open_proposal_id: null,
      open_base_version: null,
      open_to_json: null,
    });

    // The next proposal is judged against the row that update wrote.
    const never = testSessionPolicy({ push: "never", version: 2 });
    bridge.send(
      proposal(bridge, "prop_no_commit", { ...never, commit: "manual" }, { from: never }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 2,
      "the second update",
    );
    expect(await policyRow(world)).toMatchObject({
      policy_json: JSON.stringify({ ...never, commit: "manual", version: 3 }),
    });
  });

  it("may cite a steer the user sent into the run", async () => {
    const { world, bridge } = await runningWorld("sess_policy_steer");
    const client = await openClient(world);
    await client.send(followUpCommand("cmd_steer", "msg_steer", "run_1", "running"));
    bridge.send(
      proposal(bridge, "prop_steer", testSessionPolicy({ push: "never" }), {
        triggeringMessageId: "msg_steer",
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the update",
    );
  });

  it.each([
    ["a message nobody sent", { triggeringMessageId: "msg_forged" }],
    ["no message at all", { triggeringMessageId: null }],
    ["a stale version", { from: testSessionPolicy({ version: 9 }) }],
  ])("citing %s is never stored", async (_name, overrides) => {
    const { world, bridge } = await runningWorld(`sess_policy_refuse_${_name.length}`);
    bridge.send(proposal(bridge, "prop_bad", pushing, overrides));
    bridge.send(bridge.event("message.completed", { runId: "run_1" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the frame after it",
    );

    expect(await eventsOfType(world.stub, "policy.proposed")).toEqual([]);
    expect(await policyRow(world)).toBeNull();
    // The refused frame consumed its sequence slot: nothing is replayed.
    expect(bridge.frames("replay_from")).toEqual([]);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("is refused when no run is running", async () => {
    const world = await sessionOnRealDriver("sess_policy_idle");
    const bridge = await readyBridge(world);
    bridge.send(proposal(bridge, "prop_idle", pushing));
    await settle();
    expect(await eventsOfType(world.stub, "policy.proposed")).toEqual([]);
  });

  it("gets an id the object minted, so a forged frame reusing an id cannot swap what a shown card confirms", async () => {
    const { world, bridge } = await runningWorld("sess_policy_same_id");
    const client = await openClient(world);
    // The card the user sees: push only.
    bridge.send(proposal(bridge, "prop_same", testSessionPolicy({ push: "auto" })));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.proposed")).length === 1,
      "the first proposal",
    );
    const [first] = await eventsOfType(world.stub, "policy.proposed");
    const shownId = ((first as { payload: unknown }).payload as { proposalId: string }).proposalId;
    expect(shownId).not.toBe("prop_same");

    // A forged second frame with the SAME id and a wider change.
    bridge.send(proposal(bridge, "prop_same", pushing));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.proposed")).length === 2,
      "the second proposal",
    );
    const ids = (await eventsOfType(world.stub, "policy.proposed")).map(
      (event) => (event.payload as { proposalId: string }).proposalId,
    );
    expect(new Set(ids).size).toBe(2);

    // The click on the card that was shown confirms nothing: it was replaced.
    await client.send(
      policySet("cmd_old_card", { action: "confirm", proposalId: shownId, policyVersion: 1 }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length === 1,
      "the refusal",
    );
    expect(await eventsOfType(world.stub, "policy.updated")).toEqual([]);
    expect(await policyRow(world)).toMatchObject({ open_proposal_id: ids[1] });
  });

  it("is admitted at most five times a run", async () => {
    const { world, bridge } = await runningWorld("sess_policy_count");
    for (let index = 0; index <= MAX_PROPOSALS_PER_RUN; index += 1) {
      bridge.send(proposal(bridge, `prop_${index}`, pushing));
    }
    await settle();
    await waitFor(
      async () =>
        (await eventsOfType(world.stub, "policy.proposed")).length === MAX_PROPOSALS_PER_RUN,
      "five stored",
    );
    expect(await policyRow(world)).toMatchObject({ open_proposal_id: (await mintedIds(world))[4] });
  });

  it("does not count proposing what is already so towards closing the socket", async () => {
    const { world, bridge } = await runningWorld("sess_policy_no_change");
    for (let index = 0; index < MAX_PROPOSAL_REFUSALS + 3; index += 1) {
      bridge.send(proposal(bridge, `prop_same_${index}`, testSessionPolicy()));
    }
    bridge.send(bridge.event("message.completed", { runId: "run_1" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the frame after them",
    );
    expect(await eventsOfType(world.stub, "policy.proposed")).toEqual([]);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a socket that has a fourth proposal refused", async () => {
    const { world, bridge } = await runningWorld("sess_policy_bound");
    for (let index = 0; index <= MAX_PROPOSAL_REFUSALS; index += 1) {
      bridge.send(proposal(bridge, `prop_${index}`, pushing, { triggeringMessageId: "msg_x" }));
    }
    await waitFor(() => bridge.client.readyState === WebSocket.CLOSED, "the closed socket");
    expect(await eventsOfType(world.stub, "policy.proposed")).toEqual([]);
  });
});

describe("the user's policy.set", () => {
  it("confirms the held proposal with one click, and tells the bridge", async () => {
    const { world, bridge } = await runningWorld("sess_policy_confirm");
    bridge.send(proposal(bridge, "prop_widen", pushing));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.proposed")).length === 1,
      "the held proposal",
    );
    const client = await openClient(world);
    const [held] = await mintedIds(world);
    await client.send(
      policySet("cmd_confirm", { action: "confirm", proposalId: held, policyVersion: 1 }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the update",
    );

    const [updated] = await eventsOfType(world.stub, "policy.updated");
    expect(updated).toMatchObject({
      payload: {
        proposalId: held,
        confirmedBy: "user_confirmation",
        to: { ...pushing, version: 2 },
      },
    });
    expect(await policyRow(world)).toEqual({
      policy_json: JSON.stringify({ ...pushing, version: 2 }),
      open_proposal_id: null,
      open_base_version: null,
      open_to_json: null,
    });
    await waitFor(() => bridge.frames("bridge.policy").length === 2, "the bridge to be told");
    expect(bridge.frames("bridge.policy")[1]).toMatchObject({
      policy: { ...pushing, version: 2 },
    });
    // The command itself never reaches the bridge.
    expect(bridge.commands("policy.set")).toEqual([]);

    // The same click again is the same command id: nothing more happens.
    await client.send(
      policySet("cmd_confirm", { action: "confirm", proposalId: held, policyVersion: 1 }),
    );
    // A second card's click on the closed proposal is refused.
    await client.send(
      policySet("cmd_again", { action: "confirm", proposalId: held, policyVersion: 2 }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "command.rejected")).length === 1,
      "the refusal",
    );
    expect(await eventsOfType(world.stub, "policy.updated")).toHaveLength(1);
  });

  it("declines, and a product control works with no sandbox attached", async () => {
    const { world, bridge } = await runningWorld("sess_policy_decline");
    bridge.send(proposal(bridge, "prop_widen", pushing));
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.proposed")).length === 1,
      "the held proposal",
    );
    const client = await openClient(world);
    await client.send(
      policySet("cmd_decline", { action: "decline", proposalId: (await mintedIds(world))[0] }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.declined")).length === 1,
      "the decline",
    );
    expect(await eventsOfType(world.stub, "policy.updated")).toEqual([]);
    expect(await policyRow(world)).toMatchObject({
      policy_json: JSON.stringify(testSessionPolicy()),
      open_proposal_id: null,
    });

    bridge.close();
    await settle();
    await client.send(
      policySet("cmd_set", {
        action: "set",
        policyVersion: 1,
        commit: "auto",
        push: "never",
        pullRequest: "never",
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the control's update",
    );
    expect((await eventsOfType(world.stub, "policy.updated"))[0]).toMatchObject({
      payload: { confirmedBy: "product_control", proposalId: null },
    });
  });
});

describe("the checkpoint under the policy", () => {
  it("is sent with no push grant once the user has said never", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_policy_never");
    const client = await openClient(world);
    await client.send(
      policySet("cmd_never", {
        action: "set",
        policyVersion: 1,
        commit: "auto",
        push: "never",
        pullRequest: "never",
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
      "the control's update",
    );
    const mintsBefore = world.github.calls.filter((call) => call.tokenNarrowing).length;

    const { push, checkpoint } = await idleStopIssued(world, bridge);

    expect(checkpoint).toMatchObject({ command: { payload: { reason: "idle" } } });
    expect(push).toBeUndefined();
    expect(world.github.calls.filter((call) => call.tokenNarrowing)).toHaveLength(mintsBefore);
  });
});

describe("the incident rule's lock-down", () => {
  const incident = async (stub: SessionWorld["stub"]) =>
    (await stub.fetch("https://session/internal/incident", { method: "POST" })).json();

  it("turns every remote action off as system, and stops the live sandbox with no checkpoint", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_policy_incident");
    const mintsBefore = world.github.calls.filter((call) => call.tokenNarrowing).length;

    expect(await incident(world.stub)).toMatchObject({ kind: "locked_down", policyChanged: true });

    const [updated] = await eventsOfType(world.stub, "policy.updated");
    expect(updated).toMatchObject({
      payload: {
        proposalId: null,
        confirmedBy: "system",
        userId: null,
        to: testSessionPolicy({ push: "never", pullRequest: "never", version: 2 }),
      },
    });
    await waitFor(
      async () => (await eventsOfType(world.stub, "sandbox.stopped")).length === 1,
      "the sandbox to stop",
    );
    // The user's stop path: no checkpoint is asked for, so no push token is minted.
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(world.github.calls.filter((call) => call.tokenNarrowing)).toHaveLength(mintsBefore);

    // A second delivery for the same repository finds nothing left to take away.
    expect(await incident(world.stub)).toEqual({
      kind: "locked_down",
      policyChanged: false,
      stop: "not_running",
    });
    expect(await eventsOfType(world.stub, "policy.updated")).toHaveLength(1);
  });

  it("answers no_session for an object that never held one", async () => {
    expect(await incident(stubFor("sess_policy_incident_none"))).toEqual({
      kind: "no_session",
      policyChanged: false,
      stop: null,
    });
  });
});
