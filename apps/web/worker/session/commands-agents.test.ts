import { makeCommand, TEST_IDS, TEST_TIME } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { type CommandPlanInput, planCommand } from "./commands";

function input(overrides: Partial<CommandPlanInput> = {}): CommandPlanInput {
  return {
    command: makeCommand("agent.stop", { payload: { agentId: "ses_child" } }),
    alreadyProcessed: false,
    ownerUserId: TEST_IDS.userId,
    admission: { kind: "admit" },
    actualExpectation: { scope: "run", state: "running" },
    sessionState: "active",
    currentGeneration: 1,
    computeAttached: true,
    modelConnectionActive: true,
    effortAccepted: true,
    openApproval: null,
    policy: null,
    firstEventId: "evt_ack",
    domainEventId: "evt_domain",
    mintedRunId: "run_new",
    now: TEST_TIME,
    ...overrides,
  };
}

describe("planCommand: agent.stop", () => {
  it("only acknowledges a stop for a running subagent of the run; the bridge carries it out", () => {
    const plan = planCommand(input({ agentRunning: true }));
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events.map((event) => event.type)).toEqual(["command.acknowledged"]);
    expect(plan.rows).toEqual([]);
  });

  it("refuses a stop for a subagent that is not running, or when nobody looked", () => {
    for (const agentRunning of [false, undefined]) {
      const plan = planCommand(agentRunning === undefined ? input() : input({ agentRunning }));
      expect(plan.kind).toBe("reject");
      if (plan.kind !== "reject") throw new Error("expected reject");
      expect(plan.reason).toBe("wrong_state");
      expect(plan.detail).toBe("that subagent is not running in this run");
    }
  });

  it("refuses a stop once the run is no longer running", () => {
    const plan = planCommand(
      input({ agentRunning: true, actualExpectation: { scope: "run", state: "completed" } }),
    );
    expect(plan.kind).toBe("reject");
  });
});
