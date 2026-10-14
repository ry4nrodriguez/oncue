import type { ProtocolEvent } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  type AttachmentFact,
  beginStop,
  ceilingDeadline,
  DEFAULT_LIFECYCLE_SETTINGS,
  earliest,
  effectFor,
  grantDeliverable,
  idleDeadline,
  isLive,
  joinUserStop,
  type LifecycleView,
  leaseStep,
  lifecycleDeadline,
  lifecycleSettings,
  onStopSignal,
  PROBE_DELAYS_MS,
  PROVISION_CHECK_MS,
  planAlarm,
  planCompute,
  planKeepAlive,
  planLoss,
  planProbeAnswer,
  planSocketClosed,
  provisioningCheckDeadline,
  provisioningUnsettled,
  QUESTION_IDLE_DETAIL,
  runIsActive,
  STEP_LEASE_MS,
  type StopEffect,
  type StopRow,
  type StopSignal,
  sandboxPath,
  terminateBackoffMs,
} from "./lifecycle";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const MIN = 60_000;
const SHA = "a".repeat(40);

function ids(): () => string {
  let next = 0;
  return () => `evt_${++next}`;
}

const LIVE: AttachmentFact = {
  state: "active",
  provider: "modal",
  expiresAtMs: NOW + 24 * 60 * MIN,
};

function view(overrides: Partial<LifecycleView> = {}): LifecycleView {
  return {
    nowMs: NOW,
    sessionId: "sess_1",
    generation: 1,
    attachment: LIVE,
    currentRunId: "run_1",
    runState: "completed_with_warnings",
    interruptedRunState: null,
    lastActivityMs: NOW - 30 * MIN,
    keepAliveUntilMs: null,
    bridgeConnected: true,
    hasRepository: true,
    lastCheckpoint: null,
    stop: null,
    probe: null,
    provisioning: null,
    settings: DEFAULT_LIFECYCLE_SETTINGS,
    ...overrides,
  };
}

function row(overrides: Partial<StopRow> = {}): StopRow {
  return {
    generation: 1,
    cause: "idle",
    step: "checkpoint",
    startedAtMs: NOW,
    dueAtMs: null,
    attempts: 0,
    checkpoint: null,
    warning: null,
    requestedByUserId: null,
    interruptedRunId: null,
    ...overrides,
  };
}

const types = (events: readonly ProtocolEvent[]) => events.map((event) => event.type);

describe("lifecycleSettings", () => {
  it("ignores the local timing overrides outside the local environment", () => {
    expect(
      lifecycleSettings({
        ONCUE_ENV: "hosted",
        ONCUE_IDLE_ALARM_SECONDS: "60",
        ONCUE_CEILING_SECONDS: "300",
      }),
    ).toEqual(DEFAULT_LIFECYCLE_SETTINGS);
  });

  it("uses the defaults locally when the settings are absent or not positive whole seconds", () => {
    expect(lifecycleSettings({ ONCUE_ENV: "local" })).toEqual(DEFAULT_LIFECYCLE_SETTINGS);
    expect(
      lifecycleSettings({
        ONCUE_ENV: "local",
        ONCUE_IDLE_ALARM_SECONDS: "1.5",
        ONCUE_CEILING_SECONDS: "0",
      }),
    ).toEqual(DEFAULT_LIFECYCLE_SETTINGS);
  });

  it("shrinks the ceiling margin with a short local lifetime", () => {
    expect(
      lifecycleSettings({
        ONCUE_ENV: "local",
        ONCUE_IDLE_ALARM_SECONDS: "60",
        ONCUE_CEILING_SECONDS: "300",
      }),
    ).toEqual({
      ...DEFAULT_LIFECYCLE_SETTINGS,
      idleMs: 60_000,
      lifetimeMs: 300_000,
      ceilingMarginMs: 60_000,
    });
  });
});

describe("facts", () => {
  it("names which attachments are live and which runs are active", () => {
    expect(isLive(null)).toBe(false);
    expect(isLive({ ...LIVE, state: "provisioning" })).toBe(false);
    expect(isLive({ ...LIVE, state: "checkpointing" })).toBe(true);
    expect(runIsActive(null)).toBe(false);
    expect(runIsActive("waiting_for_approval")).toBe(true);
    expect(runIsActive("paused")).toBe(false);
  });

  it("picks the earliest deadline and ignores the owners with none", () => {
    expect(earliest([])).toBeNull();
    expect(earliest([null, null])).toBeNull();
    expect(earliest([30, null, 10, 20])).toBe(10);
  });
});

describe("idleDeadline", () => {
  it("is twenty minutes after the last activity", () => {
    expect(idleDeadline(view())).toBe(NOW - 30 * MIN + 20 * MIN);
  });

  it("waits out a keep-alive that ends later", () => {
    expect(idleDeadline(view({ keepAliveUntilMs: NOW + 40 * MIN }))).toBe(NOW + 40 * MIN);
  });

  it.each([
    ["no live attachment", { attachment: { ...LIVE, state: "stopped" as const } }],
    ["a stop already under way", { stop: row() }],
    ["a run still executing", { runState: "running" as const }],
    ["no activity recorded", { lastActivityMs: null }],
  ])("is none with %s", (_name, overrides) => {
    expect(idleDeadline(view(overrides))).toBeNull();
  });

  it("counts a running run that only waits on the user's answer as idle", () => {
    expect(idleDeadline(view({ runState: "running", questionOpen: true }))).toBe(
      NOW - 30 * MIN + 20 * MIN,
    );
    // An approval or a queued run still holds the stop off, question or not.
    expect(idleDeadline(view({ runState: "waiting_for_approval", questionOpen: true }))).toBeNull();
    expect(idleDeadline(view({ runState: "queued", questionOpen: true }))).toBeNull();
  });

  it("is the last activity itself for a run paused on a rejected key, with no idle period to wait out", () => {
    const paused = view({ runState: "paused", rejectedKeyPause: true, lastActivityMs: NOW - 5 });
    expect(idleDeadline(paused)).toBe(NOW - 5);
  });

  it("still waits out a keep-alive the user asked for before the key was rejected", () => {
    const kept = view({
      runState: "paused",
      rejectedKeyPause: true,
      lastActivityMs: NOW - 5,
      keepAliveUntilMs: NOW + 40 * MIN,
    });
    expect(idleDeadline(kept)).toBe(NOW + 40 * MIN);
    // One that already ran out holds nothing.
    expect(idleDeadline({ ...kept, keepAliveUntilMs: NOW - MIN })).toBe(NOW - 5);
  });

  it.each([
    ["a run paused for any other reason", { runState: "paused" as const }],
    [
      "a run paused for another reason, said outright",
      { runState: "paused" as const, rejectedKeyPause: false },
    ],
    [
      "a rejected-key pause the run has since left behind",
      { runState: "completed_with_warnings" as const, rejectedKeyPause: true },
    ],
  ])("keeps the idle period for %s", (_name, overrides) => {
    expect(idleDeadline(view({ lastActivityMs: NOW - 5, ...overrides }))).toBe(NOW - 5 + 20 * MIN);
  });

  it.each([
    ["no live attachment", { attachment: { ...LIVE, state: "stopped" as const } }],
    ["a stop already under way", { stop: row() }],
    ["no activity recorded", { lastActivityMs: null }],
    // A run the harness went on with is working again, whatever the pause said.
    ["a run that is running again", { runState: "running" as const }],
  ])("is none for a rejected key with %s", (_name, overrides) => {
    expect(
      idleDeadline(view({ runState: "paused", rejectedKeyPause: true, ...overrides })),
    ).toBeNull();
  });
});

describe("ceilingDeadline", () => {
  it("is the margin before the attachment expires, even during a keep-alive", () => {
    expect(ceilingDeadline(view({ keepAliveUntilMs: NOW + 60 * MIN }))).toBe(
      NOW + 24 * 60 * MIN - 30 * MIN,
    );
  });

  it.each([
    ["no live attachment", { attachment: null }],
    ["a stop already under way", { stop: row() }],
    ["no recorded expiry", { attachment: { ...LIVE, expiresAtMs: null } }],
  ])("is none with %s", (_name, overrides) => {
    expect(ceilingDeadline(view(overrides))).toBeNull();
  });
});

describe("lifecycleDeadline: the one next moment this module owes the alarm", () => {
  it("is the idle deadline for a quiet live sandbox", () => {
    expect(lifecycleDeadline(view())).toBe(NOW - 10 * MIN);
  });

  it("is now for a runnable stop step and its due time for a waiting one", () => {
    expect(lifecycleDeadline(view({ stop: row({ step: "revoke" }) }))).toBe(NOW);
    expect(
      lifecycleDeadline(view({ stop: row({ step: "awaiting_checkpoint", dueAtMs: NOW + 5 }) })),
    ).toBe(NOW + 5);
  });

  it("owes nothing for a finished stop and counts a probe", () => {
    const finished = view({
      attachment: { ...LIVE, state: "stopped" },
      stop: row({ step: "done" }),
    });
    expect(lifecycleDeadline(finished)).toBeNull();
    expect(
      lifecycleDeadline({ ...finished, probe: { generation: 1, dueAtMs: NOW + 7, attempts: 0 } }),
    ).toBe(NOW + 7);
  });
});

describe("a generation still provisioning", () => {
  const provisioning = (startedAtMs: number, inMemory: boolean) => ({ startedAtMs, inMemory });

  it("is checked at each whole interval after it began, the same moment on every rearm between", () => {
    const began = NOW - 100_000;
    const deadline = provisioningCheckDeadline(view({ provisioning: provisioning(began, true) }));
    expect(deadline).toBe(began + 2 * PROVISION_CHECK_MS);
    expect(
      provisioningCheckDeadline(
        view({ nowMs: NOW + 50_000, provisioning: provisioning(began, true) }),
      ),
    ).toBe(deadline);
    // A clock behind the start still looks one interval ahead.
    expect(provisioningCheckDeadline(view({ provisioning: provisioning(NOW + 5_000, true) }))).toBe(
      NOW + 5_000 + PROVISION_CHECK_MS,
    );
  });

  it("is not checked when nothing provisions, or a stop owns the generation", () => {
    expect(provisioningCheckDeadline(view())).toBeNull();
    expect(
      provisioningCheckDeadline(
        view({ provisioning: provisioning(NOW, false), stop: row({ step: "revoke" }) }),
      ),
    ).toBeNull();
  });

  it("feeds the lifecycle deadline", () => {
    const finished = view({ attachment: null, lastActivityMs: null });
    expect(lifecycleDeadline({ ...finished, provisioning: provisioning(NOW, true) })).toBe(
      NOW + PROVISION_CHECK_MS,
    );
  });

  it("is recovered once an interval has passed with nothing in memory driving it", () => {
    const quiet = { attachment: null, lastActivityMs: null };
    expect(
      planAlarm(view({ ...quiet, provisioning: provisioning(NOW - PROVISION_CHECK_MS, false) })),
    ).toEqual({ kind: "recover_provisioning" });
    expect(
      planAlarm(view({ ...quiet, provisioning: provisioning(NOW - PROVISION_CHECK_MS, true) })),
    ).toEqual({ kind: "none" });
    expect(planAlarm(view({ ...quiet, provisioning: provisioning(NOW - 1_000, false) }))).toEqual({
      kind: "none",
    });
  });
});

describe("a provisioning that has not settled", () => {
  it("is a row still provisioning, or a live one with no expiry stored", () => {
    expect(provisioningUnsettled({ ...LIVE, state: "provisioning", expiresAtMs: null })).toBe(true);
    // A bridge reported ready before the session attached, and the attach never came.
    expect(provisioningUnsettled({ ...LIVE, expiresAtMs: null })).toBe(true);
    expect(provisioningUnsettled({ ...LIVE, state: "idle", expiresAtMs: null })).toBe(true);
  });

  it("is not a row with its expiry, an ended one, or none at all", () => {
    expect(provisioningUnsettled(LIVE)).toBe(false);
    expect(provisioningUnsettled({ ...LIVE, state: "failed", expiresAtMs: null })).toBe(false);
    expect(provisioningUnsettled({ ...LIVE, state: "stopped", expiresAtMs: null })).toBe(false);
    expect(provisioningUnsettled(null)).toBe(false);
  });

  it("is recovered before the ceiling or the idle stop is considered", () => {
    const lost = view({
      attachment: { ...LIVE, expiresAtMs: null },
      provisioning: { startedAtMs: NOW - PROVISION_CHECK_MS, inMemory: false },
    });
    expect(idleDeadline(lost)).not.toBeNull();
    expect(planAlarm(lost)).toEqual({ kind: "recover_provisioning" });
  });
});

describe("planAlarm", () => {
  it("advances a due stop and waits on one that is not due, owning the generation meanwhile", () => {
    expect(planAlarm(view({ stop: row({ step: "terminate" }) }))).toEqual({
      kind: "advance_stop",
    });
    expect(
      planAlarm(
        view({
          stop: row({ step: "awaiting_checkpoint", dueAtMs: NOW + 1 }),
          probe: { generation: 1, dueAtMs: NOW, attempts: 0 },
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("probes a quiet Modal sandbox whose bridge is gone", () => {
    const probe = { generation: 1, dueAtMs: NOW, attempts: 0 };
    expect(planAlarm(view({ probe, bridgeConnected: false }))).toEqual({ kind: "probe" });
  });

  it.each([
    ["an older generation", { probe: { generation: 0, dueAtMs: NOW, attempts: 0 } }],
    ["a sandbox no longer live", { attachment: { ...LIVE, state: "failed" as const } }],
    ["the fake driver", { attachment: { ...LIVE, provider: "fake" as const } }],
    ["a reconnected bridge", { bridgeConnected: true }],
  ])("clears a due probe owed by %s", (_name, overrides) => {
    expect(
      planAlarm(
        view({
          probe: { generation: 1, dueAtMs: NOW, attempts: 0 },
          bridgeConnected: false,
          ...overrides,
        }),
      ),
    ).toEqual({ kind: "clear_probe" });
  });

  it("lets a probe that is not yet due wait while other deadlines are checked", () => {
    expect(
      planAlarm(
        view({
          probe: { generation: 1, dueAtMs: NOW + 1, attempts: 0 },
          lastActivityMs: NOW,
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("replaces at the ceiling before it considers idleness", () => {
    expect(planAlarm(view({ attachment: { ...LIVE, expiresAtMs: NOW + 30 * MIN } }))).toEqual({
      kind: "begin_stop",
      cause: "lifetime_ceiling",
    });
  });

  it("stops an idle sandbox at its deadline and not before", () => {
    expect(planAlarm(view())).toEqual({ kind: "begin_stop", cause: "idle" });
    expect(planAlarm(view({ lastActivityMs: NOW - 19 * MIN }))).toEqual({ kind: "none" });
  });

  it("stops the sandbox of a run paused on a rejected key at once, as an idle stop", () => {
    const paused = view({ runState: "paused", rejectedKeyPause: true, lastActivityMs: NOW });
    expect(lifecycleDeadline(paused)).toBe(NOW);
    expect(planAlarm(paused)).toEqual({ kind: "begin_stop", cause: "idle" });
    // Any other pause waits out the idle period.
    expect(planAlarm({ ...paused, rejectedKeyPause: false })).toEqual({ kind: "none" });
  });

  it("holds a rejected-key stop for a keep-alive, and never past the ceiling", () => {
    const kept = view({
      runState: "paused",
      rejectedKeyPause: true,
      lastActivityMs: NOW,
      keepAliveUntilMs: NOW + 40 * MIN,
    });
    expect(planAlarm(kept)).toEqual({ kind: "none" });
    expect(lifecycleDeadline(kept)).toBe(NOW + 40 * MIN);
    expect(planAlarm({ ...kept, nowMs: NOW + 40 * MIN })).toEqual({
      kind: "begin_stop",
      cause: "idle",
    });
    expect(planAlarm({ ...kept, attachment: { ...LIVE, expiresAtMs: NOW + 30 * MIN } })).toEqual({
      kind: "begin_stop",
      cause: "lifetime_ceiling",
    });
  });

  it("starts a rejected-key stop once: a second alarm finds the stop and only carries it on", () => {
    const paused = view({ runState: "paused", rejectedKeyPause: true, lastActivityMs: NOW });
    const begun = beginStop(paused, "idle", null, ids());
    const stopping: LifecycleView = {
      ...paused,
      attachment: { ...LIVE, state: "idle" },
      stop: begun.row,
    };
    expect(idleDeadline(stopping)).toBeNull();
    expect(planAlarm(stopping)).toEqual({ kind: "advance_stop" });
    expect(planAlarm({ ...stopping, stop: leaseStep(begun.row, NOW) })).toEqual({ kind: "none" });
  });
});

describe("beginStop", () => {
  it("announces an idle stop and starts with the checkpoint", () => {
    const plan = beginStop(view({ keepAliveUntilMs: NOW - MIN }), "idle", null, ids());
    expect(plan.row).toMatchObject({ step: "checkpoint", cause: "idle", warning: null });
    expect(plan.attachmentState).toBe("idle");
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      type: "sandbox.idle",
      runId: null,
      sandboxGeneration: 1,
      payload: {
        idleSince: new Date(NOW - 30 * MIN).toISOString(),
        stopAt: new Date(NOW).toISOString(),
        keepAliveUntil: new Date(NOW - MIN).toISOString(),
      },
    });
  });

  it("pauses a run that waited on a question, keeping the question for the answer to resume it", () => {
    const plan = beginStop(view({ runState: "running", questionOpen: true }), "idle", null, ids());
    expect(plan.events.map((event) => event.type)).toEqual(["sandbox.idle", "run.paused"]);
    expect(plan.events[1]).toMatchObject({
      runId: "run_1",
      runtimeSequence: null,
      payload: { reason: "idle_stop", detail: QUESTION_IDLE_DETAIL, checkpointId: null },
    });
    expect(
      beginStop(
        view({ runState: "running", questionOpen: true, currentRunId: null }),
        "idle",
        null,
        ids(),
      ).events.map((event) => event.type),
    ).toEqual(["sandbox.idle"]);
  });

  it("stops a run paused on a rejected key the idle way: announced, checkpointed, and the run left paused", () => {
    const paused = view({ runState: "paused", rejectedKeyPause: true, lastActivityMs: NOW - 5 });
    const plan = beginStop(paused, "idle", null, ids());
    expect(plan.row).toMatchObject({ step: "checkpoint", cause: "idle", interruptedRunId: null });
    expect(plan.attachmentState).toBe("idle");
    // No second pause and no cancel: the bridge's own pause already says why.
    expect(types(plan.events)).toEqual(["sandbox.idle"]);
    expect(plan.events[0]).toMatchObject({
      payload: {
        idleSince: new Date(NOW - 5).toISOString(),
        stopAt: new Date(NOW).toISOString(),
        keepAliveUntil: null,
      },
    });
  });

  it("uses now as idle-since when no activity was ever recorded", () => {
    const plan = beginStop(view({ lastActivityMs: null }), "idle", null, ids());
    expect(plan.events[0]).toMatchObject({
      payload: { idleSince: new Date(NOW).toISOString(), keepAliveUntil: null },
    });
  });

  it("warns rather than stopping silently when there is work to save and no bridge to save it", () => {
    const plan = beginStop(view({ bridgeConnected: false }), "idle", null, ids());
    expect(plan.row.step).toBe("revoke");
    expect(plan.row.warning).toMatch(/no checkpoint was taken/);
  });

  it("has nothing to save for a session with no repository", () => {
    const plan = beginStop(view({ hasRepository: false }), "idle", null, ids());
    expect(plan.row).toMatchObject({ step: "revoke", warning: null });
  });

  it("skips the checkpoint for the user's stop, which ends work at once", () => {
    const plan = beginStop(view({ runState: "running" }), "user_requested", "usr_1", ids());
    expect(plan).toEqual({
      row: expect.objectContaining({
        step: "revoke",
        requestedByUserId: "usr_1",
        interruptedRunId: null,
      }),
      events: [],
      attachmentState: null,
    });
  });

  it("remembers the executing run a ceiling replacement must resume, and only an executing one", () => {
    expect(
      beginStop(view({ runState: "waiting_for_approval" }), "lifetime_ceiling", null, ids()).row,
    ).toMatchObject({ step: "checkpoint", interruptedRunId: "run_1", cause: "lifetime_ceiling" });
    expect(
      beginStop(view({ runState: "ready" }), "lifetime_ceiling", null, ids()).row,
    ).toMatchObject({ interruptedRunId: null });
  });
});

describe("effectFor", () => {
  it.each([
    [row({ step: "checkpoint" }), { kind: "issue_checkpoint", reason: "idle" }],
    [
      row({ step: "checkpoint", cause: "lifetime_ceiling" }),
      { kind: "issue_checkpoint", reason: "lifetime_ceiling" },
    ],
    [row({ step: "revoke" }), { kind: "revoke_credentials" }],
    [row({ step: "terminate" }), { kind: "terminate" }],
    [
      row({ step: "replace", interruptedRunId: "run_1" }),
      {
        kind: "provision_replacement",
        previousGeneration: 1,
        restoredFrom: null,
        resumeRunId: "run_1",
      },
    ],
    [
      row({
        step: "replace",
        checkpoint: { checkpointId: "ckpt_1", kind: "branch_push", headSha: SHA },
      }),
      {
        kind: "provision_replacement",
        previousGeneration: 1,
        restoredFrom: "ckpt_1",
        resumeRunId: null,
      },
    ],
    [row({ step: "awaiting_checkpoint" }), null],
    [row({ step: "done" }), null],
  ])("%o owes %o", (stopRow, effect) => {
    expect(effectFor(stopRow)).toEqual(effect);
  });
});

describe("onStopSignal", () => {
  const checkpoint = { checkpointId: "ckpt_1", kind: "branch_push" as const, headSha: SHA };

  it("waits for the report once the checkpoint is issued", () => {
    expect(onStopSignal(view(), row(), { kind: "checkpoint_issued" }, ids())).toEqual({
      row: row({ step: "awaiting_checkpoint", dueAtMs: NOW + 90_000 }),
      events: [],
      attachmentState: "checkpointing",
    });
  });

  it("moves on with a warning when the bridge cannot be told, or refuses once told", () => {
    for (const step of ["checkpoint", "awaiting_checkpoint"] as const) {
      expect(
        onStopSignal(view(), row({ step, dueAtMs: NOW }), { kind: "checkpoint_unavailable" }, ids())
          .row,
      ).toMatchObject({
        step: "revoke",
        dueAtMs: null,
        warning: expect.stringMatching(/no checkpoint/),
      });
    }
  });

  it("records a checkpoint reported from either checkpoint step", () => {
    for (const step of ["checkpoint", "awaiting_checkpoint"] as const) {
      expect(
        onStopSignal(
          view(),
          row({ step, dueAtMs: NOW }),
          { kind: "checkpointed", checkpoint },
          ids(),
        ).row,
      ).toMatchObject({ step: "revoke", dueAtMs: null, checkpoint });
    }
  });

  it("warns and moves on when the checkpoint never reports", () => {
    expect(
      onStopSignal(
        view(),
        row({ step: "awaiting_checkpoint" }),
        { kind: "checkpoint_timed_out" },
        ids(),
      ).row,
    ).toMatchObject({ step: "revoke", warning: expect.stringMatching(/did not finish in time/) });
  });

  it("moves on at once, saying why, when the bridge reports the checkpoint failed", () => {
    // A failure report must end the wait at once rather than time out.
    for (const step of ["checkpoint", "awaiting_checkpoint"] as const) {
      const plan = onStopSignal(
        view(),
        row({ step, dueAtMs: NOW }),
        { kind: "checkpoint_failed", failure: "add_failed" },
        ids(),
      );
      expect(plan.row).toMatchObject({
        step: "revoke",
        dueAtMs: null,
        checkpoint: null,
        warning: expect.stringMatching(/could not read a file in the work tree/),
      });
      expect(plan.row.warning).not.toMatch(/did not finish in time/);
    }
  });

  it("commits the revocation as an event before it terminates", () => {
    const plan = onStopSignal(
      view(),
      row({ step: "revoke", cause: "lifetime_ceiling" }),
      { kind: "revoked", grants: [{ kind: "push", outcome: "revoked" }] },
      ids(),
    );
    expect(plan.row.step).toBe("terminate");
    expect(plan.events[0]).toMatchObject({
      type: "sandbox.credentials_revoked",
      payload: { reason: "lifetime_ceiling", grants: [{ kind: "push", outcome: "revoked" }] },
    });
  });

  it("stops an idle sandbox with its checkpoint and any warning", () => {
    const plan = onStopSignal(
      view(),
      row({ step: "terminate", checkpoint, warning: "careful" }),
      { kind: "terminated" },
      ids(),
    );
    expect(plan.row.step).toBe("done");
    expect(plan.attachmentState).toBe("stopped");
    expect(plan.events).toEqual([
      expect.objectContaining({
        type: "sandbox.stopped",
        payload: {
          outcome: "stopped",
          reason: "idle",
          checkpointId: "ckpt_1",
          unsavedWorkWarning: "careful",
          diagnostics: [],
        },
      }),
    ]);
  });

  it("cancels the current run on the user's stop, and has no run to cancel without one or once it ended", () => {
    const stopping = row({
      step: "terminate",
      cause: "user_requested",
      requestedByUserId: "usr_1",
    });
    // A run that already reached its outcome keeps it.
    expect(types(onStopSignal(view(), stopping, { kind: "terminated" }, ids()).events)).toEqual([
      "sandbox.stopped",
    ]);
    const withRun = onStopSignal(
      view({ runState: "running" }),
      stopping,
      { kind: "terminated" },
      ids(),
    );
    expect(types(withRun.events)).toEqual(["sandbox.stopped", "run.cancelled"]);
    expect(withRun.events[1]).toMatchObject({
      runId: "run_1",
      payload: { by: { kind: "user", userId: "usr_1" } },
    });
    const withoutRun = onStopSignal(
      view({ currentRunId: null }),
      stopping,
      { kind: "terminated" },
      ids(),
    );
    expect(types(withoutRun.events)).toEqual(["sandbox.stopped"]);
  });

  it("replaces at the ceiling, interrupting the executing run with where it resumes", () => {
    const plan = onStopSignal(
      view(),
      row({ step: "terminate", cause: "lifetime_ceiling", interruptedRunId: "run_1", checkpoint }),
      { kind: "terminated" },
      ids(),
    );
    expect(plan.row.step).toBe("replace");
    expect(plan.attachmentState).toBe("replaced");
    expect(plan.events).toEqual([
      expect.objectContaining({
        type: "run.interrupted",
        runId: "run_1",
        payload: expect.objectContaining({ reason: "sandbox_replaced", resumableFrom: "ckpt_1" }),
      }),
    ]);
    expect(
      onStopSignal(
        view(),
        row({ step: "terminate", cause: "lifetime_ceiling" }),
        { kind: "terminated" },
        ids(),
      ).events,
    ).toEqual([]);
  });

  it("retries a failed terminate with a capped backoff", () => {
    const plan = onStopSignal(
      view(),
      row({ step: "terminate", attempts: 2 }),
      { kind: "terminate_failed" },
      ids(),
    );
    expect(plan.row).toMatchObject({ step: "terminate", attempts: 3, dueAtMs: NOW + 20_000 });
    expect(terminateBackoffMs(20)).toBe(5 * MIN);
  });

  it("finishes once the replacement is provisioned", () => {
    expect(
      onStopSignal(view(), row({ step: "replace" }), { kind: "replaced" }, ids()).row.step,
    ).toBe("done");
  });

  it.each([
    ["checkpoint_issued", "revoke"],
    ["checkpoint_unavailable", "revoke"],
    ["checkpointed", "terminate"],
    ["checkpoint_timed_out", "checkpoint"],
    ["checkpoint_failed", "revoke"],
    ["revoked", "terminate"],
    ["terminated", "revoke"],
    ["terminate_failed", "done"],
    ["replaced", "terminate"],
  ] as const)("ignores a late or duplicate %s during %s", (kind, step) => {
    const signal = (
      kind === "checkpointed"
        ? { kind, checkpoint }
        : kind === "checkpoint_failed"
          ? { kind, failure: "add_failed" }
          : kind === "revoked"
            ? { kind, grants: [] }
            : { kind }
    ) as StopSignal;
    const current = row({ step });
    expect(onStopSignal(view(), current, signal, ids())).toEqual({
      row: current,
      events: [],
      attachmentState: null,
    });
  });
});

/**
 * Stands in for the object's alarm loop with injected effect results; it
 * converges when it reaches `done` however many times a step failed first.
 */
function runStop(
  initial: LifecycleView,
  perform: (effect: StopEffect, attempt: number) => StopSignal | "silent",
): { readonly events: ProtocolEvent[]; readonly final: StopRow; readonly alarms: number } {
  let current = initial;
  const events: ProtocolEvent[] = [];
  const newEventId = ids();
  const attempts = new Map<string, number>();
  let alarms = 0;
  const apply = (plan: { row: StopRow; events: readonly ProtocolEvent[] }) => {
    events.push(...plan.events);
    current = { ...current, stop: plan.row };
  };
  const action = planAlarm(current);
  if (action.kind !== "begin_stop") {
    throw new Error(`expected a stop to begin, got ${action.kind}`);
  }
  apply(beginStop(current, action.cause, null, newEventId));
  while (alarms < 50) {
    const stop = current.stop as StopRow;
    if (stop.step === "done") {
      break;
    }
    const deadline = lifecycleDeadline(current) as number;
    current = { ...current, nowMs: Math.max(current.nowMs, deadline) };
    alarms += 1;
    if (planAlarm(current).kind !== "advance_stop") {
      continue;
    }
    if (stop.step === "awaiting_checkpoint") {
      apply(onStopSignal(current, stop, { kind: "checkpoint_timed_out" }, newEventId));
      continue;
    }
    const effect = effectFor(stop) as StopEffect;
    const attempt = (attempts.get(effect.kind) ?? 0) + 1;
    attempts.set(effect.kind, attempt);
    const signal = perform(effect, attempt);
    if (signal === "silent") {
      if (effect.kind === "issue_checkpoint") {
        apply(onStopSignal(current, stop, { kind: "checkpoint_issued" }, newEventId));
      }
      continue;
    }
    if (signal.kind === "checkpointed") {
      apply(onStopSignal(current, stop, { kind: "checkpoint_issued" }, newEventId));
    }
    apply(onStopSignal(current, current.stop as StopRow, signal, newEventId));
  }
  return { events, final: current.stop as StopRow, alarms };
}

describe("an idle stop converges whichever step fails", () => {
  const checkpoint = { checkpointId: "ckpt_9", kind: "branch_push" as const, headSha: SHA };
  const happy = (effect: StopEffect): StopSignal => {
    switch (effect.kind) {
      case "issue_checkpoint":
        return { kind: "checkpointed", checkpoint };
      case "revoke_credentials":
        return { kind: "revoked", grants: [{ kind: "push", outcome: "revoked" }] };
      case "terminate":
        return { kind: "terminated" };
      case "provision_replacement":
        return { kind: "replaced" };
    }
  };

  it("runs the eight steps in order when nothing fails", () => {
    const { events, final } = runStop(view(), happy);
    expect(types(events)).toEqual([
      "sandbox.idle",
      "sandbox.credentials_revoked",
      "sandbox.stopped",
    ]);
    expect(final).toMatchObject({ step: "done", checkpoint, warning: null });
  });

  it("still stops, with a warning, when the checkpoint never reports", () => {
    const { events, final } = runStop(view(), (effect) =>
      effect.kind === "issue_checkpoint" ? "silent" : happy(effect),
    );
    expect(final).toMatchObject({ step: "done", checkpoint: null });
    expect(events.at(-1)).toMatchObject({
      type: "sandbox.stopped",
      payload: { unsavedWorkWarning: expect.stringMatching(/did not finish in time/) },
    });
  });

  it("still stops when the bridge cannot be told to checkpoint", () => {
    const { final } = runStop(view(), (effect) =>
      effect.kind === "issue_checkpoint" ? { kind: "checkpoint_unavailable" } : happy(effect),
    );
    expect(final).toMatchObject({ step: "done", warning: expect.stringMatching(/no checkpoint/) });
  });

  it("revokes once and terminates after the provider refused twice", () => {
    const { events, final, alarms } = runStop(view(), (effect, attempt) =>
      effect.kind === "terminate" && attempt < 3 ? { kind: "terminate_failed" } : happy(effect),
    );
    expect(types(events).filter((type) => type === "sandbox.credentials_revoked")).toHaveLength(1);
    expect(final).toMatchObject({ step: "done", attempts: 2 });
    expect(alarms).toBeGreaterThan(3);
  });

  it("stops a run paused on a rejected key through the same steps and leaves the run paused", () => {
    const paused = view({ runState: "paused", rejectedKeyPause: true, lastActivityMs: NOW });
    const { events, final } = runStop(paused, happy);
    expect(types(events)).toEqual([
      "sandbox.idle",
      "sandbox.credentials_revoked",
      "sandbox.stopped",
    ]);
    expect(events.at(-1)).toMatchObject({
      payload: { outcome: "stopped", reason: "idle", checkpointId: "ckpt_9" },
    });
    expect(final).toMatchObject({ step: "done", cause: "idle", checkpoint, warning: null });
    const after: LifecycleView = {
      ...paused,
      attachment: { ...LIVE, state: "stopped" },
      stop: final,
    };
    expect(planAlarm(after)).toEqual({ kind: "none" });
    expect(lifecycleDeadline(after)).toBeNull();
    // Continue needs a new sandbox, and the stopped one no longer stands in its way.
    expect(planCompute(after)).toEqual({ kind: "provision" });
  });

  it("does each step once when the alarm fires again after the stop finished", () => {
    const { final } = runStop(view(), happy);
    const after = view({ attachment: { ...LIVE, state: "stopped" }, stop: final });
    expect(planAlarm(after)).toEqual({ kind: "none" });
    expect(lifecycleDeadline(after)).toBeNull();
  });

  it("replaces at the ceiling and resumes the executing run", () => {
    const { events, final } = runStop(
      view({ runState: "running", attachment: { ...LIVE, expiresAtMs: NOW } }),
      happy,
    );
    expect(types(events)).toEqual(["sandbox.credentials_revoked", "run.interrupted"]);
    expect(final).toMatchObject({ step: "done", interruptedRunId: "run_1", checkpoint });
  });
});

describe("leaseStep", () => {
  it("holds a runnable step so a throw is retried after the lease, not at once", () => {
    const leased = leaseStep(row({ step: "revoke" }), NOW);
    expect(leased).toEqual(row({ step: "revoke", dueAtMs: NOW + STEP_LEASE_MS }));
    const held = view({ stop: leased });
    expect(planAlarm(held)).toEqual({ kind: "none" });
    expect(lifecycleDeadline(held)).toBe(NOW + STEP_LEASE_MS);
    expect(planAlarm({ ...held, nowMs: NOW + STEP_LEASE_MS })).toEqual({ kind: "advance_stop" });
  });

  it("is overwritten by the plan the effect's signal produces", () => {
    const leased = leaseStep(row({ step: "revoke" }), NOW);
    const plan = onStopSignal(view(), leased, { kind: "revoked", grants: [] }, ids());
    expect(plan.row).toMatchObject({ step: "terminate", dueAtMs: null });
  });
});

describe("planSocketClosed", () => {
  it("schedules the first probe for a live Modal sandbox", () => {
    expect(planSocketClosed(view())).toEqual({
      generation: 1,
      dueAtMs: NOW + PROBE_DELAYS_MS[0],
      attempts: 0,
    });
  });

  it.each([
    ["a sandbox that is not live", { attachment: { ...LIVE, state: "stopped" as const } }],
    ["the fake driver", { attachment: { ...LIVE, provider: "fake" as const } }],
    ["a stop already under way", { stop: row() }],
  ])("asks nothing for %s", (_name, overrides) => {
    expect(planSocketClosed(view(overrides))).toBeNull();
  });
});

describe("planProbeAnswer: the socket close and getStatus agree before anything is lost", () => {
  const probing = (overrides: Partial<LifecycleView> = {}) =>
    view({
      runState: "running",
      bridgeConnected: false,
      probe: { generation: 1, dueAtMs: NOW, attempts: 0 },
      ...overrides,
    });

  it.each([
    ["no probe", { probe: null }],
    ["an answer for an older generation", { probe: { generation: 0, dueAtMs: NOW, attempts: 0 } }],
    ["a bridge that already reconnected", { bridgeConnected: true }],
    ["a sandbox no longer live", { attachment: { ...LIVE, state: "stopped" as const } }],
    ["a stop under way", { stop: row() }],
  ])("changes nothing for %s", (_name, overrides) => {
    expect(planProbeAnswer(probing(overrides), "gone")).toEqual({ kind: "clear" });
  });

  it("treats a live or unknown answer as a reconnect, asked once more and then left alone", () => {
    expect(planProbeAnswer(probing(), "live")).toEqual({
      kind: "retry",
      probe: { generation: 1, dueAtMs: NOW + PROBE_DELAYS_MS[1], attempts: 1 },
    });
    expect(
      planProbeAnswer(probing({ probe: { generation: 1, dueAtMs: NOW, attempts: 1 } }), "unknown"),
    ).toEqual({ kind: "clear" });
  });

  it("calls a gone answer a loss, which planLoss plans once the credentials are revoked", () => {
    expect(planProbeAnswer(probing(), "gone")).toEqual({ kind: "lost" });
  });
});

describe("planLoss: record 01's losing-a-sandbox table", () => {
  const losing = (overrides: Partial<LifecycleView> = {}) =>
    view({ runState: "running", bridgeConnected: false, ...overrides });
  const checkpoint = { checkpointId: "ckpt_1", kind: "branch_push" as const, headSha: SHA };

  it("interrupts an executing run at its checkpoint and says what was lost since it", () => {
    for (const runState of ["running", "waiting_for_approval"] as const) {
      const plan = planLoss(losing({ runState, lastCheckpoint: checkpoint }), 1, ids());
      expect(plan).toMatchObject({
        runAction: "interrupt",
        warning: "The sandbox was lost. Work since the checkpoint at aaaaaaa was not kept.",
      });
      expect(types(plan?.events ?? [])).toEqual(["sandbox.stopped", "run.interrupted"]);
      expect(plan?.events[0]).toMatchObject({
        payload: { outcome: "failed", reason: "disappeared", checkpointId: "ckpt_1" },
      });
      expect(plan?.events[1]).toMatchObject({
        runId: "run_1",
        payload: { reason: "sandbox_lost", resumableFrom: "ckpt_1" },
      });
    }
  });

  it("fails an executing run at execution when no checkpoint is known, because nothing can resume it", () => {
    for (const runState of ["running", "waiting_for_approval"] as const) {
      const plan = planLoss(losing({ runState }), 1, ids());
      expect(plan).toMatchObject({ runAction: "fail_execution" });
      expect(types(plan?.events ?? [])).toEqual(["sandbox.stopped"]);
      expect(plan?.events[0]).toMatchObject({ payload: { checkpointId: null } });
    }
  });

  it("says nothing was kept when there was never a checkpoint with a head", () => {
    for (const lastCheckpoint of [
      null,
      { checkpointId: "ckpt_1", kind: "local_commit" as const, headSha: null },
    ]) {
      expect(planLoss(losing({ lastCheckpoint }), 1, ids())).toMatchObject({
        warning: expect.stringMatching(/before any checkpoint/),
      });
    }
  });

  it("fails a run that never started work at provisioning and leaves an ended run alone", () => {
    expect(planLoss(losing({ runState: "provisioning" }), 1, ids())).toMatchObject({
      runAction: "fail_provisioning",
    });
    expect(planLoss(losing({ runState: "cancelled" }), 1, ids())).toMatchObject({
      runAction: "none",
    });
  });

  it.each([
    ["a session that moved to another generation", { generation: 2 }],
    ["a loss already committed", { attachment: { ...LIVE, state: "failed" as const } }],
    ["a stop that took the generation over", { stop: row({ cause: "user_requested" }) }],
  ])("plans nothing for %s", (_name, overrides) => {
    expect(planLoss(losing(overrides), 1, ids())).toBeNull();
  });
});

describe("joinUserStop", () => {
  const checkpoint = { checkpointId: "ckpt_1", kind: "branch_push" as const, headSha: SHA };

  it("abandons a checkpoint still being taken and makes the stop the user's", () => {
    for (const step of ["checkpoint", "awaiting_checkpoint"] as const) {
      expect(
        joinUserStop(view(), row({ step, dueAtMs: NOW + STEP_LEASE_MS }), "usr_1", false, ids()),
      ).toEqual({
        row: row({
          step: "revoke",
          dueAtMs: null,
          cause: "user_requested",
          requestedByUserId: "usr_1",
          warning: expect.stringMatching(/Stopped at your request before the checkpoint finished/),
        }),
        events: [],
        attachmentState: null,
      });
    }
  });

  it("keeps a later step's place and lease, and the events still to come are the user's", () => {
    const leased = row({
      step: "terminate",
      dueAtMs: NOW + STEP_LEASE_MS,
      attempts: 2,
      cause: "lifetime_ceiling",
      interruptedRunId: "run_1",
      checkpoint,
    });
    const joined = joinUserStop(view(), leased, "usr_1", false, ids());
    expect(joined).toEqual({
      row: { ...leased, cause: "user_requested", requestedByUserId: "usr_1" },
      events: [],
      attachmentState: null,
    });
    const plan = onStopSignal(
      view({ runState: "running" }),
      (joined as { row: StopRow }).row,
      { kind: "terminated" },
      ids(),
    );
    expect(plan.row.step).toBe("done");
    expect(plan.attachmentState).toBe("stopped");
    expect(types(plan.events)).toEqual(["sandbox.stopped", "run.cancelled"]);
    expect(plan.events[0]).toMatchObject({
      payload: { reason: "user_requested", checkpointId: "ckpt_1" },
    });
  });

  it("cancels a replacement not yet provisioned: done, stopped at the user's request, and both runs cancelled", () => {
    const replacing = row({
      step: "replace",
      cause: "lifetime_ceiling",
      interruptedRunId: "run_1",
      checkpoint,
      warning: "careful",
    });
    for (const [stop, pending] of [
      [replacing, false],
      [{ ...replacing, step: "done" as const }, true],
    ] as const) {
      const plan = joinUserStop(
        view({ currentRunId: "run_2", runState: "queued", interruptedRunState: "interrupted" }),
        stop,
        "usr_1",
        pending,
        ids(),
      );
      expect(plan?.row).toEqual({
        ...replacing,
        step: "done",
        dueAtMs: null,
        cause: "user_requested",
        requestedByUserId: "usr_1",
      });
      expect(plan?.attachmentState).toBeNull();
      expect(types(plan?.events ?? [])).toEqual([
        "sandbox.stopped",
        "run.cancelled",
        "run.cancelled",
      ]);
      expect(plan?.events[0]).toMatchObject({
        payload: {
          outcome: "stopped",
          reason: "user_requested",
          checkpointId: "ckpt_1",
          unsavedWorkWarning: "careful",
        },
      });
      expect(plan?.events.slice(1).map((event) => event.runId)).toEqual(["run_1", "run_2"]);
      expect(plan?.events[1]).toMatchObject({ payload: { by: { kind: "user", userId: "usr_1" } } });
    }
    // The run it would have resumed is the current run: cancelled once.
    const same = joinUserStop(
      view({ runState: "interrupted", interruptedRunState: "interrupted" }),
      row({ step: "replace", interruptedRunId: "run_1" }),
      "usr_1",
      false,
      ids(),
    );
    expect(types(same?.events ?? [])).toEqual(["sandbox.stopped", "run.cancelled"]);
    // Runs the user already cancelled, or that ended, keep their outcome.
    const ended = joinUserStop(
      view({
        currentRunId: "run_2",
        runState: "completed_with_warnings",
        interruptedRunState: "cancelled",
      }),
      replacing,
      "usr_1",
      false,
      ids(),
    );
    expect(types(ended?.events ?? [])).toEqual(["sandbox.stopped"]);
    // No checkpoint, and no run at all.
    const bare = joinUserStop(
      view({ currentRunId: null }),
      row({ step: "replace" }),
      "usr_1",
      false,
      ids(),
    );
    expect(types(bare?.events ?? [])).toEqual(["sandbox.stopped"]);
    expect(bare?.events[0]).toMatchObject({ payload: { checkpointId: null } });
  });

  it("has nothing to stop once the stop is done and no replacement is still provisioning", () => {
    expect(
      joinUserStop(view(), row({ step: "done", cause: "lifetime_ceiling" }), "usr_1", false, ids()),
    ).toBeNull();
    expect(
      joinUserStop(view(), row({ step: "done", cause: "idle" }), "usr_1", true, ids()),
    ).toBeNull();
  });
});

describe("grantDeliverable", () => {
  it("lets a live or starting generation with no stop, or a stop still at its checkpoint, be handed a credential", () => {
    for (const state of ["provisioning", "attached", "active", "checkpointing"] as const) {
      expect(grantDeliverable({ ...LIVE, state }, null)).toBe(true);
    }
    expect(grantDeliverable(LIVE, row({ step: "checkpoint" }))).toBe(true);
    expect(grantDeliverable(LIVE, row({ step: "awaiting_checkpoint" }))).toBe(true);
  });

  it("refuses once a stop is taking credentials back, or the generation has ended", () => {
    for (const step of ["revoke", "terminate", "replace", "done"] as const) {
      expect(grantDeliverable(LIVE, row({ step }))).toBe(false);
    }
    for (const state of ["stopped", "failed", "replaced"] as const) {
      expect(grantDeliverable({ ...LIVE, state }, null)).toBe(false);
    }
    expect(grantDeliverable(null, null)).toBe(false);
  });
});

describe("planKeepAlive", () => {
  it("extends by an hour, bounded by the planned replacement", () => {
    expect(planKeepAlive(view())).toEqual({
      kind: "extended",
      expiresAtMs: NOW + 60 * MIN,
      minutes: 60,
    });
    expect(planKeepAlive(view({ attachment: { ...LIVE, expiresAtMs: NOW + 50 * MIN } }))).toEqual({
      kind: "extended",
      expiresAtMs: NOW + 20 * MIN,
      minutes: 20,
    });
    expect(planKeepAlive(view({ attachment: { ...LIVE, expiresAtMs: null } }))).toMatchObject({
      expiresAtMs: NOW + 60 * MIN,
    });
    expect(planKeepAlive(view({ attachment: { ...LIVE, expiresAtMs: NOW } }))).toMatchObject({
      minutes: 0,
    });
  });

  it("refuses without a live sandbox or during a stop", () => {
    expect(planKeepAlive(view({ attachment: null }))).toEqual({ kind: "refused" });
    expect(planKeepAlive(view({ stop: row() }))).toEqual({ kind: "refused" });
  });
});

describe("planCompute: two resumes at once make one generation", () => {
  it("joins a generation that is live or still starting", () => {
    expect(planCompute(view())).toEqual({ kind: "attached" });
    expect(planCompute(view({ attachment: { ...LIVE, state: "provisioning" } }))).toEqual({
      kind: "attached",
    });
  });

  it("waits for a stop that has not finished, then provisions", () => {
    const stopped = { ...LIVE, state: "idle" as const };
    expect(
      planCompute(view({ attachment: { ...stopped, state: "stopped" }, stop: row() })),
    ).toEqual({ kind: "wait_for_stop" });
    expect(
      planCompute(
        view({ attachment: { ...stopped, state: "stopped" }, stop: row({ step: "done" }) }),
      ),
    ).toEqual({ kind: "provision" });
    expect(planCompute(view({ attachment: null }))).toEqual({ kind: "provision" });
  });
});

describe("sandboxPath", () => {
  it("walks record 11's machine through the states a stop skipped past", () => {
    expect(sandboxPath("active", "active")).toEqual([]);
    expect(sandboxPath("attached", "active")).toEqual(["active"]);
    expect(sandboxPath("idle", "stopped")).toEqual(["checkpointing", "stopped"]);
    expect(sandboxPath("attached", "checkpointing")).toEqual(["active", "idle", "checkpointing"]);
  });

  it("has no path out of a finished sandbox", () => {
    expect(sandboxPath("stopped", "active")).toBeNull();
  });
});
