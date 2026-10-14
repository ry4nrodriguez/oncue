// The D1 projection outbox (record 03): each commit inserts an outbox row in
// the same transaction, and the object's alarm drains it. A row's existence is
// the pending flag. `apply` reports failure by resolving `false`, never by
// throwing, so the drain loop has no `try`.

import type { RunState, SessionState } from "@oncue/protocol";

export interface OutboxRow {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly factType: string;
  readonly schemaVersion: number;
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly attempts: number;
}

export interface SessionSnapshot {
  readonly state: SessionState;
  readonly title: string | null;
  readonly sandboxProviderRef: string | null;
  readonly sandboxGeneration: number;
  /** The newest generation whose credentials the object revoked; the broker refuses its tokens. */
  readonly endedSandboxGeneration: number | null;
  /** An approval or Git behavior card is open, for the sidebar's "Needs you". */
  readonly waitingForUser: boolean;
  /** The current run and its state, so the sidebar can show progress from D1 alone; null before the first run. */
  readonly currentRun: { readonly runId: string; readonly state: RunState } | null;
  /**
   * Set only on the commit that changes the session's model (record 15). The
   * projection then writes the current run's connection to the index row.
   * Absent on every other snapshot, which leaves the column as it is.
   */
  readonly modelConnectionChanged?: boolean;
}

const SCHEMA_VERSION = 1;

/**
 * Every commit queues exactly one full snapshot row (record 03), carrying the
 * commit's own session sequence.
 */
export function planOutboxRow(
  sessionId: string,
  snapshot: SessionSnapshot,
  sequence: number,
  outboxId: string,
  now: string,
): OutboxRow {
  return {
    id: outboxId,
    sessionId,
    sequence,
    factType: "session_index.snapshot",
    schemaVersion: SCHEMA_VERSION,
    payloadJson: JSON.stringify({
      state: snapshot.state,
      title: snapshot.title,
      lastActivityAt: now,
      sandboxProviderRef: snapshot.sandboxProviderRef,
      sandboxGeneration: snapshot.sandboxGeneration,
      endedSandboxGeneration: snapshot.endedSandboxGeneration,
      waitingForUser: snapshot.waitingForUser,
      currentRunId: snapshot.currentRun?.runId ?? null,
      currentRunState: snapshot.currentRun?.state ?? null,
      ...(snapshot.modelConnectionChanged === true ? { modelConnectionChanged: true } : {}),
    }),
    createdAt: now,
    attempts: 0,
  };
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const BACKOFF_MAX_EXPONENT = 9;

/** Exponential backoff capped at 5 minutes, so a D1 outage never turns the alarm into a hot loop. */
export function backoffMs(attempts: number): number {
  const exponent = Math.min(attempts, BACKOFF_MAX_EXPONENT);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

export interface DrainOutcome {
  readonly appliedRowIds: readonly string[];
  readonly remaining: readonly OutboxRow[];
  readonly nextAlarmDelayMs: number | null;
}

export async function drainOutbox(
  rows: readonly OutboxRow[],
  apply: (row: OutboxRow) => Promise<boolean>,
): Promise<DrainOutcome> {
  const appliedRowIds: string[] = [];
  const remaining: OutboxRow[] = [];
  for (const row of rows) {
    const applied = await apply(row);
    if (applied) {
      appliedRowIds.push(row.id);
    } else {
      remaining.push({ ...row, attempts: row.attempts + 1 });
    }
  }
  const highestAttempts = remaining.reduce((max, row) => Math.max(max, row.attempts), 0);
  const nextAlarmDelayMs = remaining.length > 0 ? backoffMs(highestAttempts) : null;
  return { appliedRowIds, remaining, nextAlarmDelayMs };
}
