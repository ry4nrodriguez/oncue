import { describe, expect, it } from "vitest";
import { backoffMs, drainOutbox, type OutboxRow, planOutboxRow } from "./outbox";

describe("planOutboxRow", () => {
  it("builds a compact snapshot row keyed by the commit's own session sequence", () => {
    const row = planOutboxRow(
      "sess_1",
      {
        state: "active",
        title: "Fix the bug",
        sandboxProviderRef: "modal:box_1",
        sandboxGeneration: 2,
        endedSandboxGeneration: 1,
        waitingForUser: true,
        currentRun: { runId: "run_3", state: "running" },
      },
      7,
      "outbox_1",
      "2026-09-02T00:00:00.000Z",
    );
    expect(row).toEqual({
      id: "outbox_1",
      sessionId: "sess_1",
      sequence: 7,
      factType: "session_index.snapshot",
      schemaVersion: 1,
      payloadJson: JSON.stringify({
        state: "active",
        title: "Fix the bug",
        lastActivityAt: "2026-09-02T00:00:00.000Z",
        sandboxProviderRef: "modal:box_1",
        sandboxGeneration: 2,
        endedSandboxGeneration: 1,
        waitingForUser: true,
        currentRunId: "run_3",
        currentRunState: "running",
      }),
      createdAt: "2026-09-02T00:00:00.000Z",
      attempts: 0,
    });
  });

  it("projects no run as nulls rather than leaving the fields out", () => {
    const row = planOutboxRow(
      "sess_1",
      {
        state: "active",
        title: null,
        sandboxProviderRef: null,
        sandboxGeneration: 0,
        endedSandboxGeneration: null,
        waitingForUser: false,
        currentRun: null,
      },
      1,
      "outbox_2",
      "2026-09-02T00:00:00.000Z",
    );
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      currentRunId: null,
      currentRunState: null,
    });
  });
});

describe("planOutboxRow: a model change", () => {
  const snapshot = {
    state: "active" as const,
    title: null,
    sandboxProviderRef: null,
    sandboxGeneration: 1,
    endedSandboxGeneration: null,
    waitingForUser: false,
    currentRun: { runId: "run_2", state: "queued" as const },
  };

  it("marks the snapshot of the commit that changed the model, so the index row follows it", () => {
    const row = planOutboxRow(
      "sess_1",
      { ...snapshot, modelConnectionChanged: true },
      3,
      "outbox_3",
      "2026-09-02T00:00:00.000Z",
    );
    expect(JSON.parse(row.payloadJson)).toMatchObject({ modelConnectionChanged: true });
  });

  it("leaves the mark out of every other snapshot, which reads as before", () => {
    for (const unmarked of [snapshot, { ...snapshot, modelConnectionChanged: false }]) {
      const row = planOutboxRow("sess_1", unmarked, 3, "outbox_3", "2026-09-02T00:00:00.000Z");
      expect(row.payloadJson).not.toContain("modelConnectionChanged");
    }
  });
});

describe("backoffMs", () => {
  it("doubles per attempt", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
  });

  it("caps at five minutes once the exponent saturates", () => {
    expect(backoffMs(9)).toBe(5 * 60 * 1000);
    expect(backoffMs(100)).toBe(5 * 60 * 1000);
  });
});

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "outbox_1",
    sessionId: "sess_1",
    sequence: 1,
    factType: "session_index.snapshot",
    schemaVersion: 1,
    payloadJson: "{}",
    createdAt: "2026-09-02T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

describe("drainOutbox", () => {
  it("returns no remaining rows and no alarm when the queue is empty", async () => {
    const outcome = await drainOutbox([], async () => true);
    expect(outcome).toEqual({ appliedRowIds: [], remaining: [], nextAlarmDelayMs: null });
  });

  it("applies every row that succeeds", async () => {
    const outcome = await drainOutbox([row({ id: "a" }), row({ id: "b" })], async () => true);
    expect(outcome).toEqual({ appliedRowIds: ["a", "b"], remaining: [], nextAlarmDelayMs: null });
  });

  it("keeps a failed row pending with an incremented attempt count and schedules a backoff alarm", async () => {
    const outcome = await drainOutbox([row({ id: "a", attempts: 0 })], async () => false);
    expect(outcome.appliedRowIds).toEqual([]);
    expect(outcome.remaining).toEqual([row({ id: "a", attempts: 1 })]);
    expect(outcome.nextAlarmDelayMs).toBe(backoffMs(1));
  });

  it("applies a previously-failed row on a later drain (retry after a failed D1 write)", async () => {
    const first = await drainOutbox([row({ id: "a" })], async () => false);
    const pending = first.remaining;
    const second = await drainOutbox(pending, async () => true);
    expect(second).toEqual({ appliedRowIds: ["a"], remaining: [], nextAlarmDelayMs: null });
  });
});
