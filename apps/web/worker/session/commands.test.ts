import type { RunId } from "@oncue/protocol";
import { makeCommand, TEST_IDS, TEST_TIME, testSessionPolicy } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import type { CommandPlanInput, OpenApproval } from "./commands";
import { planCommand } from "./commands";

const OWNER = TEST_IDS.userId;

function baseInput(overrides: Partial<CommandPlanInput> = {}): CommandPlanInput {
  return {
    command: makeCommand("run.start"),
    alreadyProcessed: false,
    ownerUserId: OWNER,
    admission: { kind: "admit" },
    actualExpectation: { scope: "session", state: "active" },
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

describe("planCommand: idempotency", () => {
  it("returns already_processed for a retried command id, before any other check", () => {
    const input = baseInput({
      alreadyProcessed: true,
      ownerUserId: "someone_else",
    });
    expect(planCommand(input)).toEqual({
      kind: "already_processed",
      commandId: TEST_IDS.commandId,
    });
  });
});

describe("planCommand: admission (run.start only)", () => {
  it("rejects run.start as admission_closed when admission refuses", () => {
    const input = baseInput({ admission: { kind: "refuse", reason: "admission_stopped" } });
    const plan = planCommand(input);
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("admission_closed");
    expect(plan.event.type).toBe("command.rejected");
    expect(plan.event.payload).toMatchObject({
      reason: "admission_closed",
      commandType: "run.start",
    });
  });

  it("does not apply the admission check to a non-run.start command", () => {
    const input = baseInput({
      command: makeCommand("checkpoint.create"),
      admission: { kind: "refuse", reason: "admission_stopped" },
      actualExpectation: { scope: "session", state: "active" },
    });
    const plan = planCommand(input);
    expect(plan.kind).toBe("accept");
  });
});

describe("planCommand: ownership", () => {
  it("rejects a command from a user who does not own the session", () => {
    const input = baseInput({ ownerUserId: "someone_else" });
    const plan = planCommand(input);
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("not_owner");
  });
});

describe("planCommand: actual state", () => {
  it("rejects a command that is invalid for the session or run's real current state", () => {
    const input = baseInput({ actualExpectation: { scope: "session", state: "archived" } });
    const plan = planCommand(input);
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("wrong_state");
    expect(plan.event.payload).toMatchObject({
      reason: "wrong_state",
      expectedState: "active",
      actualState: "archived",
    });
  });

  it("accepts when the actual state matches what the command allows", () => {
    const plan = planCommand(baseInput());
    expect(plan.kind).toBe("accept");
  });
});

describe("planCommand: approval.resolve's own rules", () => {
  function approvalInput(
    payloadOverrides: Partial<{ decision: "approved" | "rejected" }>,
    openApproval: OpenApproval | null,
    currentGeneration = 1,
  ): CommandPlanInput {
    return baseInput({
      command: makeCommand("approval.resolve", { payload: payloadOverrides }),
      actualExpectation: { scope: "run", state: "waiting_for_approval" },
      openApproval,
      currentGeneration,
    });
  }

  it("rejects when no open approval matches the id", () => {
    const plan = planCommand(approvalInput({}, null));
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("unknown_approval");
  });

  it("rejects when the matching approval is not in the requested state", () => {
    const plan = planCommand(
      approvalInput({}, { approvalId: "apr_1", state: "approved", requestedGeneration: 1 }),
    );
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("unknown_approval");
  });

  it("rejects a decision against a generation the approval was not requested under", () => {
    const plan = planCommand(
      approvalInput({}, { approvalId: "apr_1", state: "requested", requestedGeneration: 1 }, 2),
    );
    expect(plan.kind).toBe("reject");
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("stale_generation");
  });

  it("accepts an approval decision, moving the run to running when approved", () => {
    const plan = planCommand(
      approvalInput(
        { decision: "approved" },
        { approvalId: "apr_1", state: "requested", requestedGeneration: 1 },
      ),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events).toHaveLength(2);
    expect(plan.events[1]?.type).toBe("approval.resolved");
    expect(plan.rows).toEqual([
      {
        kind: "update_approval",
        row: {
          approvalId: "apr_1",
          decision: "approved",
          decidedBy: "user_1",
          decidedCommandId: TEST_IDS.commandId,
          decidedForGeneration: 1,
          decidedAt: TEST_TIME,
        },
      },
      { kind: "update_run", row: { runId: TEST_IDS.runId, state: "running", outcome: null } },
    ]);
  });

  it("accepts a rejection decision, and the run goes on without the value", () => {
    const plan = planCommand(
      approvalInput(
        { decision: "rejected" },
        { approvalId: "apr_1", state: "requested", requestedGeneration: 1 },
      ),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.rows[1]).toEqual({
      kind: "update_run",
      row: { runId: TEST_IDS.runId, state: "running", outcome: null },
    });
  });

  it("records the verified issuer and the object's clock: the payload has no field for either", () => {
    const plan = planCommand(
      approvalInput({}, { approvalId: "apr_1", state: "requested", requestedGeneration: 1 }),
    );
    if (plan.kind !== "accept") throw new Error("expected accept");
    const resolved = plan.events.find((event) => event.type === "approval.resolved");
    expect(resolved?.payload).toMatchObject({ decidedBy: TEST_IDS.userId });
    expect(plan.rows[0]).toMatchObject({
      kind: "update_approval",
      row: { decidedBy: TEST_IDS.userId, decidedAt: baseInput().now },
    });
  });
});

describe("planCommand: approval.resolve for a harness permission ask (record 09)", () => {
  type Scope = "once" | "session" | "always";
  function input(
    decision: "approved" | "rejected",
    scope: Scope | undefined,
    category: NonNullable<OpenApproval["category"]> | null,
  ): CommandPlanInput {
    return baseInput({
      command: makeCommand("approval.resolve", {
        payload: { decision, ...(scope === undefined ? {} : { scope }) },
      }),
      actualExpectation: { scope: "run", state: "waiting_for_approval" },
      openApproval: { approvalId: "apr_1", state: "requested", requestedGeneration: 1, category },
    });
  }

  it.each([
    ["once", []],
    ["session", [{ kind: "save_session_rule", category: "outside_project" }]],
    ["always", []],
  ] as const)(
    "records %s on the event and saves a session rule only for session",
    (scope, extra) => {
      const plan = planCommand(input("approved", scope, "outside_project"));
      if (plan.kind !== "accept") throw new Error("expected accept");
      const resolved = plan.events.find((event) => event.type === "approval.resolved");
      expect(resolved?.payload).toMatchObject({ scope });
      expect(plan.rows.filter((row) => row.kind === "save_session_rule")).toEqual(extra);
    },
  );

  it("reads an absent scope as once", () => {
    const plan = planCommand(input("approved", undefined, "repeated_action"));
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
      scope: "once",
    });
  });

  it.each([
    ["a wider answer for a secret file", "approved", "session", "secret_file"],
    ["always for a secret file", "approved", "always", "secret_file"],
    ["a scope on a development secret", "approved", "session", null],
    ["a denial that claims a scope", "rejected", "always", "outside_project"],
  ] as const)("refuses %s", (_label, decision, scope, category) => {
    const plan = planCommand(input(decision, scope, category));
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.reason).toBe("unsupported");
  });

  it("keeps a secret's event in its old shape", () => {
    const plan = planCommand(input("approved", "once", null));
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(
      plan.events.find((event) => event.type === "approval.resolved")?.payload,
    ).not.toHaveProperty("scope");
  });
});

describe("planCommand: approval.mode (record 09)", () => {
  it.each([
    ["ask", "ask", true],
    ["session", "session", false],
    ["always", "ask", true],
  ] as const)("records %s and writes the session's half", (mode, sessionMode, clears) => {
    const plan = planCommand(
      baseInput({ command: makeCommand("approval.mode", { payload: { mode } }) }),
    );
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]).toMatchObject({
      type: "approval.mode_changed",
      runId: null,
      payload: { mode, decidedBy: OWNER, commandId: TEST_IDS.commandId },
    });
    // "Allow once" and "Always allow" undo the session's per-category answers.
    expect(plan.rows).toEqual([
      { kind: "write_session_mode", mode: sessionMode },
      ...(clears ? [{ kind: "clear_session_rules" }] : []),
    ]);
  });
});

describe("planCommand: run.start", () => {
  it("mints a run, inserting it as queued with trigger 'initial' when not continuing a prior run", () => {
    const plan = planCommand(baseInput({ command: makeCommand("run.start") }));
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events).toHaveLength(2);
    expect(plan.events[0]?.type).toBe("command.acknowledged");
    expect(plan.events[1]?.type).toBe("run.queued");
    expect(plan.rows).toEqual([
      {
        kind: "insert_run",
        row: {
          runId: "run_new",
          state: "queued",
          trigger: "initial",
          instructionMessageId: "msg_user_1",
          continuesRunId: null,
          sandboxGeneration: 1,
          createdByCommandId: TEST_IDS.commandId,
          queuedAt: TEST_TIME,
        },
      },
    ]);
  });

  it("uses trigger 'follow_up' when a client's command continues a prior run", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.start", { payload: { continuesRunId: "run_prior" } }),
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.rows).toHaveLength(1);
    const inserted = plan.rows[0];
    if (inserted === undefined || inserted.kind !== "insert_run")
      throw new Error("expected insert_run");
    expect(inserted.row.trigger).toBe("follow_up");
    expect(inserted.row.continuesRunId).toBe("run_prior");
  });
});

describe("planCommand: run.start that changes the model (record 15)", () => {
  const continues = makeCommand("run.start", { payload: { continuesRunId: "run_prior" } });

  it("records the run with trigger 'model_change' when the object found a change it allows", () => {
    const plan = planCommand(baseInput({ command: continues, modelChange: { kind: "changed" } }));
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.payload).toMatchObject({
      trigger: "model_change",
      continuesRunId: "run_prior",
    });
    expect(plan.rows[0]).toMatchObject({
      kind: "insert_run",
      row: { trigger: "model_change", continuesRunId: "run_prior" },
    });
  });

  it("keeps 'follow_up' when no change was found", () => {
    const plan = planCommand(baseInput({ command: continues, modelChange: null }));
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.rows[0]).toMatchObject({ kind: "insert_run", row: { trigger: "follow_up" } });
  });

  it("rejects the start with the decision's own reason and words when the change is refused", () => {
    const plan = planCommand(
      baseInput({
        command: continues,
        modelChange: {
          kind: "refused",
          reason: "unsupported",
          detail: "that model is not one this connection's provider offers",
        },
      }),
    );
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "unsupported",
      detail: "that model is not one this connection's provider offers",
    });
    if (plan.kind !== "reject") throw new Error("expected reject");
    expect(plan.event.payload).toMatchObject({ commandType: "run.start", reason: "unsupported" });
  });

  it("says the change is refused rather than that the connection is inactive, when both hold", () => {
    const plan = planCommand(
      baseInput({
        command: continues,
        modelConnectionActive: false,
        modelChange: {
          kind: "refused",
          reason: "wrong_state",
          detail:
            "that model connection is not active; add a working key under Settings, Model providers",
        },
      }),
    );
    expect(plan).toMatchObject({
      kind: "reject",
      detail:
        "that model connection is not active; add a working key under Settings, Model providers",
    });
  });

  it("still refuses a non-owner as not_owner and a closed admission as admission_closed first", () => {
    const refused = {
      kind: "refused" as const,
      reason: "wrong_state" as const,
      detail: "the model can be changed only between runs; stop this run first",
    };
    expect(
      planCommand(
        baseInput({ command: continues, ownerUserId: "someone_else", modelChange: refused }),
      ),
    ).toMatchObject({ kind: "reject", reason: "not_owner" });
    expect(
      planCommand(
        baseInput({
          command: continues,
          admission: { kind: "refuse", reason: "admission_stopped" },
          modelChange: refused,
        }),
      ),
    ).toMatchObject({ kind: "reject", reason: "admission_closed" });
  });
});

describe("planCommand: run.start released from the queue", () => {
  it("uses trigger 'queued_message' when the continuation says so", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.start", { payload: { continuesRunId: "run_prev" } }),
        trigger: "queued_message",
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.payload).toMatchObject({
      trigger: "queued_message",
      continuesRunId: "run_prev",
    });
    expect(plan.rows[0]).toMatchObject({
      kind: "insert_run",
      row: { trigger: "queued_message", continuesRunId: "run_prev" },
    });
  });
});

describe("planCommand: run.follow_up", () => {
  it("delivers to the current run when steering", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.follow_up", { payload: { delivery: "steer_current_run" } }),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.type).toBe("message.queued");
    expect(plan.events[1]?.payload).toMatchObject({ deliveredToRunId: TEST_IDS.runId });
  });

  it("leaves deliveredToRunId null when queued for the next run", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.follow_up", { payload: { delivery: "run_next" } }),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.payload).toMatchObject({ deliveredToRunId: null });
  });
});

describe("planCommand: composer attachments", () => {
  const image = {
    artifactId: "att_1",
    kind: "file",
    contentType: "image/png",
    byteSize: 12,
    label: "screen.png",
  } as const;

  it("commits a follow-up's attachments on message.queued, and leaves the field off one with none", () => {
    const withAttachments = planCommand(
      baseInput({
        command: makeCommand("run.follow_up", {
          payload: { delivery: "steer_current_run", attachments: [image] },
        }),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    if (withAttachments.kind !== "accept") throw new Error("expected accept");
    expect(withAttachments.events[1]?.payload).toMatchObject({ attachments: [image] });

    const without = planCommand(
      baseInput({
        command: makeCommand("run.follow_up", { payload: { delivery: "steer_current_run" } }),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    if (without.kind !== "accept") throw new Error("expected accept");
    const queued = without.events[1] as { payload: object };
    expect("attachments" in queued.payload).toBe(false);
  });

  it("rejects a message whose attachments could not be claimed as unsupported, with the reason", () => {
    const plan = planCommand(
      baseInput({ attachmentRefusal: "an attachment is not available; upload it again" }),
    );
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "unsupported",
      detail: "an attachment is not available; upload it again",
    });
    // Ownership is judged first.
    expect(
      planCommand(baseInput({ ownerUserId: "someone_else", attachmentRefusal: "x" })),
    ).toMatchObject({ kind: "reject", reason: "not_owner" });
    expect(planCommand(baseInput({ attachmentRefusal: null })).kind).toBe("accept");
  });
});

describe("planCommand: run.pause and run.cancel", () => {
  it("run.pause emits run.paused and moves the run row to paused", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.pause"),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.type).toBe("run.paused");
    expect(plan.rows).toEqual([
      { kind: "update_run", row: { runId: TEST_IDS.runId, state: "paused", outcome: null } },
    ]);
  });

  it("run.cancel emits run.cancelled and moves the run row to cancelled", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.cancel"),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]?.type).toBe("run.cancelled");
    expect(plan.rows).toEqual([
      {
        kind: "update_run",
        row: { runId: TEST_IDS.runId, state: "cancelled", outcome: "cancelled" },
      },
    ]);
  });
});

describe("planCommand: acknowledge-only commands", () => {
  it("context.add acknowledges with no domain event and no rows", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("context.add"),
        actualExpectation: { scope: "run", state: "running" },
      }),
    );
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events).toHaveLength(1);
    expect(plan.rows).toEqual([]);
  });

  it("checkpoint.create acknowledges with no domain event and no rows", () => {
    const plan = planCommand(baseInput({ command: makeCommand("checkpoint.create") }));
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events).toHaveLength(1);
    expect(plan.rows).toEqual([]);
  });

  it("runtime.shutdown acknowledges with no domain event and no rows", () => {
    const plan = planCommand(baseInput({ command: makeCommand("runtime.shutdown") }));
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events).toHaveLength(1);
    expect(plan.rows).toEqual([]);
  });
});

describe("planCommand: Continue on a paused or interrupted run", () => {
  function steer(state: "paused" | "interrupted", delivery: "steer_current_run" | "run_next") {
    return baseInput({
      command: makeCommand("run.follow_up", {
        runId: TEST_IDS.runId as RunId,
        expected: { scope: "run", state },
        payload: { messageId: "msg_continue", text: "Continue", attachments: [], delivery },
      }),
      actualExpectation: { scope: "run", state },
    });
  }

  it("accepts a steer once the sandbox has stopped, which resumes the run", () => {
    const plan = planCommand({
      ...steer("interrupted", "steer_current_run"),
      computeAttached: false,
    });
    expect(plan.kind).toBe("accept");
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]).toMatchObject({
      type: "message.queued",
      payload: { delivery: "steer_current_run", deliveredToRunId: TEST_IDS.runId },
    });
  });

  it("refuses a steer while a sandbox is still live or starting", () => {
    const plan = planCommand(steer("paused", "steer_current_run"));
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "wrong_state",
      detail: "a paused run is continued only once its sandbox has stopped",
    });
  });

  it("refuses a Continue on a model connection that is not active, in fixed words, before anything is committed", () => {
    const plan = planCommand({
      ...steer("paused", "steer_current_run"),
      computeAttached: false,
      modelConnectionActive: false,
    });
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "wrong_state",
      detail:
        "this run's model connection is not active; add a working key under Settings, Model providers and start a new session",
    });
  });

  it("refuses a follow-up naming an effort its run's model does not offer, before anything is committed", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.follow_up", {
          payload: { delivery: "run_next", effort: "none" },
        }),
        actualExpectation: { scope: "run", state: "running" },
        effortAccepted: false,
      }),
    );
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "wrong_state",
      detail: "this run's model does not offer that effort level",
    });
  });

  it("refuses a message held for a next run that would never come", () => {
    const plan = planCommand({ ...steer("interrupted", "run_next"), computeAttached: false });
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "wrong_state",
      detail: "a interrupted run is continued with a steer, not held for a next run",
    });
  });
});

describe("planCommand: policy.set", () => {
  const stored = testSessionPolicy();
  const held = testSessionPolicy({ version: 2, push: "auto" });
  const open = { proposalId: "prop_1", baseVersion: 1, to: held };

  function policySet(payload: Record<string, unknown>, policy = { stored, open }) {
    return planCommand(
      baseInput({
        // `makeCommand` merges into the default confirm payload; the other
        // actions are set whole.
        command: { ...makeCommand("policy.set"), payload } as CommandPlanInput["command"],
        policy: policy as CommandPlanInput["policy"],
      }),
    );
  }

  it("confirm applies the exact held policy as the user's confirmation", () => {
    const plan = policySet({ action: "confirm", proposalId: "prop_1", policyVersion: 1 });
    expect(plan).toMatchObject({
      kind: "accept",
      rows: [{ kind: "write_policy", policy: held }],
    });
    expect(plan.kind === "accept" && plan.events[1]).toMatchObject({
      type: "policy.updated",
      runId: null,
      payload: {
        proposalId: "prop_1",
        from: stored,
        to: held,
        confirmedBy: "user_confirmation",
        userId: OWNER,
      },
    });
  });

  it("decline changes nothing and closes the proposal", () => {
    const plan = policySet({ action: "decline", proposalId: "prop_1" });
    expect(plan).toMatchObject({
      kind: "accept",
      rows: [{ kind: "write_policy", policy: stored }],
    });
    expect(plan.kind === "accept" && plan.events[1]).toMatchObject({
      type: "policy.declined",
      payload: { proposalId: "prop_1", userId: OWNER },
    });
  });

  it("set writes the policy directly as a product control, widening included", () => {
    const plan = policySet({
      action: "set",
      policyVersion: 1,
      commit: "auto",
      push: "auto",
      pullRequest: "auto_after_verification",
    });
    expect(plan.kind === "accept" && plan.events[1]).toMatchObject({
      type: "policy.updated",
      payload: {
        proposalId: null,
        confirmedBy: "product_control",
        to: { version: 2, push: "auto", pullRequest: "auto_after_verification" },
      },
    });
  });

  it.each([
    [
      "a superseded card",
      { action: "confirm", proposalId: "prop_0", policyVersion: 1 },
      "that policy change was replaced by a newer one",
    ],
    [
      "a declined card that is not the open one",
      { action: "decline", proposalId: "prop_0" },
      "that policy change was replaced by a newer one",
    ],
    [
      "a version that moved",
      { action: "confirm", proposalId: "prop_1", policyVersion: 0 },
      "the session's policy changed after this was shown; review it again",
    ],
    [
      "a control that changes nothing",
      { action: "set", policyVersion: 1, commit: "auto", push: "manual", pullRequest: "manual" },
      "the policy already says that",
    ],
  ])("refuses %s", (_name, payload, detail) => {
    expect(policySet(payload)).toMatchObject({ kind: "reject", reason: "wrong_state", detail });
  });

  it("refuses a confirm with nothing open", () => {
    expect(
      policySet(
        { action: "confirm", proposalId: "prop_1", policyVersion: 1 },
        { stored, open: null as never },
      ),
    ).toMatchObject({
      kind: "reject",
      detail: "no policy change is waiting for confirmation",
    });
  });

  it("is refused from a user who does not own the session, before the policy is read", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("policy.set", { issuedByUserId: "user_other" } as never),
        policy: { stored, open },
      }),
    );
    expect(plan).toMatchObject({ kind: "reject", reason: "not_owner" });
  });
});

describe("planCommand: question.resolve", () => {
  const OPEN = { questionId: "qst_1", runId: TEST_IDS.runId, questionCount: 2 };

  function questionInput(
    payload: Record<string, unknown>,
    overrides: Partial<CommandPlanInput> = {},
  ): CommandPlanInput {
    return baseInput({
      command: { ...makeCommand("question.resolve"), payload } as never,
      actualExpectation: { scope: "run", state: "running" },
      openQuestion: OPEN,
      computeAttached: true,
      ...overrides,
    });
  }

  it("answers the open question as the user on the socket, settling its row", () => {
    const plan = planCommand(
      questionInput({ action: "answer", questionId: "qst_1", answers: [["Postgres"], []] }),
    );
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events.map((event) => event.type)).toEqual([
      "command.acknowledged",
      "question.answered",
    ]);
    expect(plan.events[1]).toMatchObject({
      runId: TEST_IDS.runId,
      payload: {
        questionId: "qst_1",
        answers: [["Postgres"], []],
        decidedBy: OWNER,
        commandId: TEST_IDS.commandId,
      },
    });
    expect(plan.rows).toEqual([
      {
        kind: "settle_question",
        questionId: "qst_1",
        state: "answered",
        answersJson: JSON.stringify([["Postgres"], []]),
        at: TEST_TIME,
      },
    ]);
  });

  it("dismisses the open question for the user", () => {
    const plan = planCommand(questionInput({ action: "dismiss", questionId: "qst_1" }));
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events[1]).toMatchObject({
      type: "question.dismissed",
      payload: { questionId: "qst_1", reason: "user", decidedBy: OWNER },
    });
    expect(plan.rows).toMatchObject([{ state: "dismissed", answersJson: null }]);
  });

  it.each([
    ["no question is open", { openQuestion: null }],
    ["the input names none", { openQuestion: undefined }],
    ["the id is another question's", { openQuestion: { ...OPEN, questionId: "qst_2" } }],
    ["the question is another run's", { openQuestion: { ...OPEN, runId: "run_other" } }],
  ])("refuses when %s", (_label, overrides) => {
    const input = questionInput({ action: "dismiss", questionId: "qst_1" });
    const plan = planCommand({ ...input, ...overrides } as CommandPlanInput);
    expect(plan).toMatchObject({
      kind: "reject",
      reason: "wrong_state",
      detail: "no open question matches this id",
    });
  });

  it("refuses more answers than questions", () => {
    const plan = planCommand(
      questionInput({ action: "answer", questionId: "qst_1", answers: [["a"], ["b"], ["c"]] }),
    );
    expect(plan).toMatchObject({ kind: "reject", detail: "there are more answers than questions" });
  });

  it("refuses an answer to a stopped run while a sandbox is live, but not a dismissal", () => {
    for (const state of ["paused", "interrupted"] as const) {
      const answer = planCommand(
        questionInput(
          { action: "answer", questionId: "qst_1", answers: [["a"]] },
          { actualExpectation: { scope: "run", state } },
        ),
      );
      expect(answer).toMatchObject({
        kind: "reject",
        reason: "wrong_state",
        detail: "the sandbox is still stopping; the answer can resume the run once it has stopped",
      });
      const dismissal = planCommand(
        questionInput(
          { action: "dismiss", questionId: "qst_1" },
          { actualExpectation: { scope: "run", state } },
        ),
      );
      expect(dismissal.kind).toBe("accept");
      const resumes = planCommand(
        questionInput(
          { action: "answer", questionId: "qst_1", answers: [["a"]] },
          { actualExpectation: { scope: "run", state }, computeAttached: false },
        ),
      );
      expect(resumes.kind).toBe("accept");
    }
  });
});

describe("planCommand: a follow-up while a question waits", () => {
  it("dismisses the question before the message, as the user's own answer", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.follow_up"),
        actualExpectation: { scope: "run", state: "running" },
        openQuestion: { questionId: "qst_1", runId: TEST_IDS.runId, questionCount: 1 },
      }),
    );
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events.map((event) => event.type)).toEqual([
      "command.acknowledged",
      "question.dismissed",
      "message.queued",
    ]);
    expect(plan.events[1]).toMatchObject({
      eventId: "evt_domain-question",
      payload: { reason: "message_sent", decidedBy: OWNER, commandId: TEST_IDS.commandId },
    });
    expect(plan.events[2]?.eventId).toBe("evt_domain");
    expect(plan.rows).toMatchObject([{ kind: "settle_question", state: "dismissed" }]);
  });

  it("leaves another run's question alone, and plans as before with none", () => {
    for (const openQuestion of [
      { questionId: "qst_1", runId: "run_other", questionCount: 1 },
      null,
    ]) {
      const plan = planCommand(
        baseInput({
          command: makeCommand("run.follow_up"),
          actualExpectation: { scope: "run", state: "running" },
          openQuestion,
        }),
      );
      if (plan.kind !== "accept") throw new Error("expected accept");
      expect(plan.events.map((event) => event.type)).toEqual([
        "command.acknowledged",
        "message.queued",
      ]);
      expect(plan.rows).toEqual([]);
    }
  });
});

describe("planCommand: a pause while a question waits", () => {
  it("dismisses the question as the user's pause, then pauses the run", () => {
    const plan = planCommand(
      baseInput({
        command: makeCommand("run.pause"),
        actualExpectation: { scope: "run", state: "running" },
        openQuestion: { questionId: "qst_1", runId: TEST_IDS.runId, questionCount: 1 },
      }),
    );
    if (plan.kind !== "accept") throw new Error("expected accept");
    expect(plan.events.map((event) => event.type)).toEqual([
      "command.acknowledged",
      "question.dismissed",
      "run.paused",
    ]);
    expect(plan.events[1]).toMatchObject({
      eventId: "evt_domain-question",
      payload: { reason: "run_paused", decidedBy: OWNER, commandId: TEST_IDS.commandId },
    });
    expect(plan.rows).toMatchObject([
      { kind: "settle_question", state: "dismissed" },
      { kind: "update_run", row: { state: "paused" } },
    ]);
  });

  it("leaves another run's question alone, and pauses as before with none", () => {
    for (const openQuestion of [
      { questionId: "qst_1", runId: "run_other", questionCount: 1 },
      null,
    ]) {
      const plan = planCommand(
        baseInput({
          command: makeCommand("run.pause"),
          actualExpectation: { scope: "run", state: "running" },
          openQuestion,
        }),
      );
      if (plan.kind !== "accept") throw new Error("expected accept");
      expect(plan.events.map((event) => event.type)).toEqual([
        "command.acknowledged",
        "run.paused",
      ]);
      expect(plan.rows).toEqual([
        { kind: "update_run", row: { runId: TEST_IDS.runId, state: "paused", outcome: null } },
      ]);
    }
  });
});

describe("planCommand: a session that is archived or being deleted", () => {
  const running = { scope: "run", state: "running" } as const;

  it.each(["run.follow_up", "approval.resolve", "question.resolve", "context.add"] as const)(
    "refuses %s, which would give a run more to do",
    (type) => {
      for (const sessionState of ["archived", "deletion_pending"] as const) {
        const plan = planCommand(
          baseInput({ command: makeCommand(type), actualExpectation: running, sessionState }),
        );
        expect(plan).toMatchObject({
          kind: "reject",
          reason: "wrong_state",
          detail: `${type} is not valid while the session is ${sessionState}`,
        });
      }
    },
  );

  it("still takes a cancel and a subagent's stop, which only end work", () => {
    const cancel = planCommand(
      baseInput({
        command: makeCommand("run.cancel"),
        actualExpectation: running,
        sessionState: "archived",
      }),
    );
    const stop = planCommand(
      baseInput({
        command: makeCommand("agent.stop", { payload: { agentId: "ses_child" } }),
        actualExpectation: running,
        sessionState: "archived",
        agentRunning: true,
      }),
    );
    expect([cancel.kind, stop.kind]).toEqual(["accept", "accept"]);
  });
});
