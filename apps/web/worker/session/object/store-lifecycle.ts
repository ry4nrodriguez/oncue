// Synchronous SQL for a generation's attachment, stop, probe, and bridge
// credential rows.

import type { ProtocolEvent, ProtocolEventOf, SandboxState } from "@oncue/protocol";
import type { AttachmentFact, CheckpointFact, ProbeRow, StopCause, StopRow } from "../lifecycle";
import { applyDispatchRow } from "./store-session";
import { closeAgentRow } from "./subagent-gate";

// EXISTS, so each answers with exactly one row whether or not a row is on record.
export function bridgeConnected(sql: SqlStorage, generation: number): boolean {
  return (
    sql
      .exec<{ connected: number }>(
        "SELECT EXISTS(SELECT 1 FROM event WHERE event_type = 'runtime.connected' AND sandbox_generation = ?) AS connected",
        generation,
      )
      .one().connected === 1
  );
}

/** Records the `notAfter` the next create for `generation` carries. */
export function writeCreateDeadline(sql: SqlStorage, generation: number, notAfterMs: number): void {
  sql.exec(
    "INSERT INTO create_deadline (generation, not_after_ms) VALUES (?, ?) ON CONFLICT (generation) DO UPDATE SET not_after_ms = excluded.not_after_ms",
    generation,
    notAfterMs,
  );
}

/** The last create's `notAfter` for `generation`, or null when no create was sent. */
export function readCreateDeadline(sql: SqlStorage, generation: number): number | null {
  return (
    sql
      .exec<{ not_after_ms: number }>(
        "SELECT not_after_ms FROM create_deadline WHERE generation = ?",
        generation,
      )
      .toArray()[0]?.not_after_ms ?? null
  );
}

export interface LateStopRow {
  readonly generation: number;
  readonly provider: "fake" | "modal";
  readonly dueAtMs: number;
  readonly attempts: number;
}

export function writeLateStop(sql: SqlStorage, row: LateStopRow): void {
  sql.exec(
    `INSERT INTO late_stop (generation, provider, due_at_ms, attempts) VALUES (?, ?, ?, ?)
     ON CONFLICT (generation) DO UPDATE SET provider = excluded.provider,
       due_at_ms = excluded.due_at_ms, attempts = excluded.attempts`,
    row.generation,
    row.provider,
    row.dueAtMs,
    row.attempts,
  );
}

export function deleteLateStop(sql: SqlStorage, generation: number): void {
  sql.exec("DELETE FROM late_stop WHERE generation = ?", generation);
}

/** The earliest owed late stop, for the alarm. One row, through `idx_late_stop_due`. */
export function readLateStopDueMs(sql: SqlStorage): number | null {
  return (
    sql
      .exec<{ due_at_ms: number }>("SELECT due_at_ms FROM late_stop ORDER BY due_at_ms LIMIT 1")
      .toArray()[0]?.due_at_ms ?? null
  );
}

/** Late stops due by `nowMs`, at most `limit`, oldest first. */
export function readDueLateStops(sql: SqlStorage, nowMs: number, limit: number): LateStopRow[] {
  return sql
    .exec<{ generation: number; provider: string; due_at_ms: number; attempts: number }>(
      "SELECT generation, provider, due_at_ms, attempts FROM late_stop WHERE due_at_ms <= ? ORDER BY due_at_ms LIMIT ?",
      nowMs,
      limit,
    )
    .toArray()
    .map((row) => ({
      generation: row.generation,
      // Written only by `writeLateStop`, from the same union.
      provider: row.provider as LateStopRow["provider"],
      dueAtMs: row.due_at_ms,
      attempts: row.attempts,
    }));
}

/**
 * The newest generations that failed after a create was sent for them, which
 * are the ones a sandbox may outlive: their stops were attempts by name, and
 * nothing recorded whether the last one landed.
 */
export function readFailedCreatedGenerations(
  sql: SqlStorage,
  limit: number,
): Array<{ readonly generation: number; readonly provider: "fake" | "modal" }> {
  return sql
    .exec<{ generation: number; provider: string | null }>(
      `SELECT a.generation AS generation, a.provider AS provider
         FROM sandbox_attachment AS a
         JOIN create_deadline AS d ON d.generation = a.generation
        WHERE a.state = 'failed'
        ORDER BY a.generation DESC LIMIT ?`,
      limit,
    )
    .toArray()
    .map((row) => ({ generation: row.generation, provider: providerOf(row.provider) }));
}

/** The attachment's provider as the drivers know it; a row from before the column was written is the fake's. */
function providerOf(stored: string | null): "fake" | "modal" {
  return stored === "modal" ? "modal" : "fake";
}

export function generationEnded(sql: SqlStorage, generation: number): boolean {
  return (
    sql
      .exec<{ ended: number }>(
        "SELECT EXISTS(SELECT 1 FROM sandbox_attachment WHERE generation = ? AND state IN ('stopped', 'failed')) AS ended",
        generation,
      )
      .one().ended === 1
  );
}

/** One millisecond past the last relayed line, so a final fetch repeats nothing. */
export function lastOutputCursor(sql: SqlStorage, generation: number): string | null {
  const rows = [
    ...sql.exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'sandbox.output' AND sandbox_generation = ? ORDER BY session_sequence DESC LIMIT 1",
      generation,
    ),
  ];
  const raw = rows[0]?.envelope_json;
  if (raw === undefined) {
    return null;
  }
  const event = JSON.parse(raw) as { payload: { lines: { at: string }[] } };
  // Never empty: `commitOutput` only gets non-empty batches.
  const lastLine = event.payload.lines.at(-1) as { at: string };
  return new Date(Date.parse(lastLine.at) + 1).toISOString();
}

export function readBridgeCredentialHash(sql: SqlStorage, generation: number): string | null {
  const rows = [
    ...sql.exec<{ credential_sha256: string }>(
      "SELECT credential_sha256 FROM bridge_credential WHERE generation = ?",
      generation,
    ),
  ];
  return rows[0]?.credential_sha256 ?? null;
}

export function readAttachment(sql: SqlStorage, generation: number): AttachmentFact | null {
  const row = sql
    .exec<{
      state: string;
      provider: string | null;
      expires_at: string | null;
      // Written with the row by `provisionSandbox`, never left empty.
      started_at: string;
    }>(
      "SELECT state, provider, expires_at, started_at FROM sandbox_attachment WHERE generation = ?",
      generation,
    )
    .toArray()[0];
  if (row === undefined) {
    return null;
  }
  return {
    state: row.state as SandboxState,
    provider: providerOf(row.provider),
    expiresAtMs: row.expires_at === null ? null : Date.parse(row.expires_at),
    startedAtMs: Date.parse(row.started_at),
  };
}

/**
 * Record 11's activity: the newest committed event of the generation, not
 * counting lifecycle bookkeeping. This runs on every rearm, so it walks the
 * generation index newest-first and stops at the first match, costing only
 * the rows since the last activity.
 */
export function readLastActivityMs(sql: SqlStorage, generation: number): number | null {
  const at = sql
    .exec<{ at: string | null }>(
      `SELECT (SELECT committed_at FROM event
                 WHERE sandbox_generation = ?
                   AND event_type NOT IN ('sandbox.output', 'sandbox.idle', 'sandbox.keepalive.updated', 'sandbox.credentials_revoked', 'runtime.disconnected')
                 ORDER BY session_sequence DESC LIMIT 1) AS at`,
      generation,
    )
    .one().at;
  return at === null ? null : Date.parse(at);
}

export function readKeepAliveUntilMs(sql: SqlStorage, generation: number): number | null {
  const raw = sql
    .exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'sandbox.keepalive.updated' AND sandbox_generation = ? ORDER BY session_sequence DESC LIMIT 1",
      generation,
    )
    .toArray()[0]?.envelope_json;
  if (raw === undefined) {
    return null;
  }
  // `keepAlive` only ever commits one with an expiry.
  const expiresAt = (JSON.parse(raw) as ProtocolEventOf<"sandbox.keepalive.updated">).payload
    .expiresAt as string;
  return Date.parse(expiresAt);
}

/**
 * Whether the generation's newest pause is this run's and is the bridge's
 * report that the provider rejected the run's key. The lifecycle reads it on
 * each rearm while the run is paused, so it is one row from the end of the
 * type and generation index.
 */
export function readRejectedKeyPause(sql: SqlStorage, runId: string, generation: number): boolean {
  const row = sql
    .exec<{ run_id: string | null; envelope_json: string }>(
      "SELECT run_id, envelope_json FROM event WHERE event_type = 'run.paused' AND sandbox_generation = ? ORDER BY session_sequence DESC LIMIT 1",
      generation,
    )
    .toArray()[0];
  if (row === undefined || row.run_id !== runId) {
    return false;
  }
  const payload = (JSON.parse(row.envelope_json) as ProtocolEventOf<"run.paused">).payload;
  return (
    payload.reason === "model_failure" && payload.modelFailure?.category === "authentication_failed"
  );
}

export function readStopRow(sql: SqlStorage, generation: number): StopRow | null {
  const row = sql
    .exec<{
      generation: number;
      cause: string;
      step: string;
      started_at_ms: number;
      due_at_ms: number | null;
      attempts: number;
      checkpoint_json: string | null;
      warning: string | null;
      requested_by_user_id: string | null;
      interrupted_run_id: string | null;
    }>("SELECT * FROM sandbox_stop WHERE generation = ?", generation)
    .toArray()[0];
  if (row === undefined) {
    return null;
  }
  return {
    generation: row.generation,
    cause: row.cause as StopCause,
    step: row.step as StopRow["step"],
    startedAtMs: row.started_at_ms,
    dueAtMs: row.due_at_ms,
    attempts: row.attempts,
    checkpoint:
      row.checkpoint_json === null ? null : (JSON.parse(row.checkpoint_json) as CheckpointFact),
    warning: row.warning,
    requestedByUserId: row.requested_by_user_id,
    interruptedRunId: row.interrupted_run_id,
  };
}

export function writeStopRow(sql: SqlStorage, row: StopRow): void {
  sql.exec(
    `INSERT OR REPLACE INTO sandbox_stop
         (generation, cause, step, started_at_ms, due_at_ms, attempts, checkpoint_json, warning, requested_by_user_id, interrupted_run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    row.generation,
    row.cause,
    row.step,
    row.startedAtMs,
    row.dueAtMs,
    row.attempts,
    row.checkpoint === null ? null : JSON.stringify(row.checkpoint),
    row.warning,
    row.requestedByUserId,
    row.interruptedRunId,
  );
}

export function readProbe(sql: SqlStorage, generation: number): ProbeRow | null {
  const row = sql
    .exec<{ generation: number; due_at_ms: number; attempts: number }>(
      "SELECT generation, due_at_ms, attempts FROM sandbox_probe WHERE generation = ?",
      generation,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : { generation: row.generation, dueAtMs: row.due_at_ms, attempts: row.attempts };
}

export function writeProbe(sql: SqlStorage, probe: ProbeRow): void {
  sql.exec(
    "INSERT OR REPLACE INTO sandbox_probe (generation, due_at_ms, attempts) VALUES (?,?,?)",
    probe.generation,
    probe.dueAtMs,
    probe.attempts,
  );
}

export function clearProbe(sql: SqlStorage, generation: number): void {
  sql.exec("DELETE FROM sandbox_probe WHERE generation = ?", generation);
}

/** The newest generation whose credentials are being or were revoked, or that ended on its own. */
export function readEndedGeneration(sql: SqlStorage): number | null {
  return sql
    .exec<{ ended: number | null }>(
      `SELECT MAX(generation) AS ended FROM (
           SELECT generation FROM sandbox_stop WHERE step IN ('revoke', 'terminate', 'replace', 'done')
           UNION ALL
           SELECT generation FROM sandbox_attachment WHERE state IN ('stopped', 'failed', 'replaced')
         )`,
    )
    .one().ended;
}

export function applyLifecycleRunEvent(sql: SqlStorage, event: ProtocolEvent, now: string): void {
  if (event.type === "run.cancelled") {
    sql.exec(
      "UPDATE run SET state = 'cancelled', outcome = 'cancelled', ended_at = ? WHERE id = ? AND outcome IS NULL",
      now,
      event.runId,
    );
  }
  if (event.type === "run.paused") {
    // The idle stop pauses a run that was only waiting on a question.
    sql.exec("UPDATE run SET state = 'paused' WHERE id = ? AND state = 'running'", event.runId);
  }
  if (event.type === "run.interrupted") {
    sql.exec("UPDATE run SET state = 'interrupted' WHERE id = ? AND outcome IS NULL", event.runId);
  }
  if (event.type === "run.failed") {
    applyDispatchRow(sql, { kind: "fail_run", runId: event.runId as string }, now);
  }
  if (event.type === "agent.completed") {
    // The object's own end for a subagent an interruption orphaned.
    closeAgentRow(sql, event, now);
  }
}
