// Synchronous SQL for the session, event, command, run, policy, and outbox rows.

import {
  advanceCursor,
  type CommittedEvent,
  PROTOCOL_VERSION,
  type ProtocolCommand,
  type ProtocolEventOf,
  type RunState,
  type SessionState,
} from "@oncue/protocol";
import type { ArtifactKind } from "../../artifacts/policy";
import {
  DEFAULT_SESSION_POLICY,
  type OpenProposal,
  type SessionPolicy,
} from "../../policy/git-policy";
import type { OpenApproval, OpenQuestionFact } from "../commands";
import { DISPATCH_COLUMN_KIND, type DispatchRowChange, type RunRowChange } from "../dispatch";
import type { OutboxRow, SessionSnapshot } from "../outbox";
import { isPermissionCategory } from "../permission-asks";
import type { StoredDescription } from "../pr-description";
import type { StoredEventRow } from "../replay";
import type { NewSessionRow, RunModel, SessionRow } from "./types";

export function readRunState(sql: SqlStorage, runId: string): RunState | null {
  const rows = [...sql.exec<{ state: string }>("SELECT state FROM run WHERE id = ?", runId)];
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return row.state as RunState;
}

export function readOpenApproval(sql: SqlStorage, approvalId: string): OpenApproval | null {
  const rows = [
    ...sql.exec<{
      id: string;
      state: string;
      requested_generation: number;
      category: string | null;
    }>(
      "SELECT a.id, a.state, a.requested_generation, p.category FROM approval a LEFT JOIN permission_request p ON p.approval_id = a.id WHERE a.id = ?",
      approvalId,
    ),
  ];
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    approvalId: row.id,
    state: row.state as OpenApproval["state"],
    requestedGeneration: row.requested_generation,
    category: row.category !== null && isPermissionCategory(row.category) ? row.category : null,
  };
}

/**
 * Whether an event id is stored in any generation: one lookup on the unique
 * `event_id` index. This runs per bridge frame, so it must never scan the log.
 */
export function eventIdKnown(sql: SqlStorage, eventId: string): boolean {
  return (
    sql
      .exec<{ known: number }>(
        "SELECT EXISTS(SELECT 1 FROM event WHERE event_id = ?) AS known",
        eventId,
      )
      .one().known === 1
  );
}

/** Whether a delete has reached this object (`session_tombstone`). */
export function isTombstoned(sql: SqlStorage): boolean {
  return (
    sql.exec<{ dead: number }>("SELECT EXISTS(SELECT 1 FROM session_tombstone) AS dead").one()
      .dead === 1
  );
}

export function writeTombstone(sql: SqlStorage, now: string): void {
  sql.exec("INSERT OR IGNORE INTO session_tombstone (id, deleted_at) VALUES (1, ?)", now);
}

/** The stored session state, or null before the session row is written. */
export function readSessionState(sql: SqlStorage): SessionState | null {
  const row = sql.exec<{ state: SessionState }>("SELECT state FROM session LIMIT 1").toArray()[0];
  return row === undefined ? null : row.state;
}

export function readNextSessionSequence(sql: SqlStorage): number {
  const rows = [...sql.exec<{ m: number | null }>("SELECT MAX(session_sequence) as m FROM event")];
  const row = rows[0];
  if (row === undefined || row.m === null) {
    return 1;
  }
  return row.m + 1;
}

export function commandAlreadyProcessed(sql: SqlStorage, commandId: string): boolean {
  const rows = [
    ...sql.exec<{ n: number }>("SELECT COUNT(*) as n FROM command WHERE id = ?", commandId),
  ];
  const row = rows[0];
  return row !== undefined && row.n > 0;
}

export function insertSessionRow(
  sql: SqlStorage,
  session: SessionRow,
  newSession: NewSessionRow,
  now: string,
): void {
  sql.exec(
    `INSERT INTO session (id, workspace_id, task_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence, protocol_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    session.id,
    session.workspaceId,
    newSession.taskId,
    session.ownerUserId,
    session.state,
    session.title,
    null,
    session.sandboxGeneration,
    session.lastRuntimeSequence,
    PROTOCOL_VERSION,
    now,
    now,
  );
  sql.exec("INSERT INTO session_runtime (id, runtime_id) VALUES (1,?)", newSession.runtimeId);
  const repository = newSession.repository;
  if (repository !== null) {
    sql.exec(
      `INSERT INTO session_repository (session_id, installation_id, repository_id, full_name, clone_url, task_branch, base_sha, git_grant_revoked)
         VALUES (?,?,?,?,?,?,?,0)`,
      session.id,
      repository.installationId,
      repository.repositoryId,
      repository.fullName,
      repository.cloneUrl,
      repository.taskBranch,
      repository.baseSha,
    );
    if (repository.baseBranch !== undefined) {
      sql.exec(
        "INSERT INTO session_branch (id, base_branch, requested_name) VALUES (1,?,NULL)",
        repository.baseBranch,
      );
    }
    if (repository.existingBranch === true) {
      sql.exec("INSERT INTO session_existing_branch (id) VALUES (1)");
    }
    if (repository.baseBranch !== undefined && repository.appOrigin !== undefined) {
      sql.exec(
        "INSERT INTO pull_request (id, base_branch, app_origin) VALUES (1,?,?)",
        repository.baseBranch,
        repository.appOrigin,
      );
    }
  }
}

export function insertEventRow(sql: SqlStorage, event: CommittedEvent, envelopeJson: string): void {
  sql.exec(
    `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    event.sessionSequence,
    event.eventId,
    event.type,
    event.runId,
    event.sandboxGeneration,
    event.runtimeSequence,
    event.occurredAt,
    event.committedAt,
    envelopeJson,
  );
}

export function insertCommandRecord(
  sql: SqlStorage,
  command: ProtocolCommand,
  resultKind: "acknowledged" | "rejected",
  resultJson: string,
  now: string,
): void {
  sql.exec(
    `INSERT INTO command (id, session_id, run_id, command_type, issued_at, issued_by_user_id, result_kind, result_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    command.commandId,
    command.sessionId,
    command.runId,
    command.type,
    command.issuedAt,
    command.issuedByUserId,
    resultKind,
    resultJson,
    now,
  );
}

/** The provider's sandbox id for `session_index.sandbox_provider_ref`, or null before the sandbox is attached. */
export function readProviderSandboxId(sql: SqlStorage, generation: number): string | null {
  const rows = [
    ...sql.exec<{ provider_sandbox_id: string | null }>(
      "SELECT provider_sandbox_id FROM sandbox_attachment WHERE generation = ?",
      generation,
    ),
  ];
  return rows[0]?.provider_sandbox_id ?? null;
}

/**
 * Whether a card is waiting on the user: an open approval or question (partial
 * indexes) or an open proposal (one-row policy table). Three keyed reads per
 * commit, never a scan.
 */
export function readWaitingForUser(sql: SqlStorage): boolean {
  const row = sql
    .exec<{ waiting: number }>(
      `SELECT (EXISTS(SELECT 1 FROM approval WHERE state = 'requested')
                 OR EXISTS(SELECT 1 FROM session_policy WHERE open_proposal_id IS NOT NULL)
                 OR EXISTS(SELECT 1 FROM question WHERE state = 'open')) AS waiting`,
    )
    .one();
  return row.waiting === 1;
}

/**
 * Whether the current run's harness waits on the user's answer in this
 * generation: one read of the partial index, for each rearm. A question asked
 * by another run or an earlier sandbox has no harness waiting here, so it
 * neither makes a working run idle nor holds it.
 */
export function readQuestionOpen(
  sql: SqlStorage,
  runId: string | null,
  generation: number,
): boolean {
  if (runId === null) {
    return false;
  }
  // Filtered by the partial index alone, which holds at most the one open question.
  const row = sql
    .exec<{ run_id: string; requested_generation: number }>(
      "SELECT run_id, requested_generation FROM question WHERE state = 'open' LIMIT 1",
    )
    .toArray()[0];
  return row !== undefined && row.run_id === runId && row.requested_generation === generation;
}

/** The open question as the command planner needs it: one read from the partial index. */
export function readOpenQuestionFact(sql: SqlStorage): OpenQuestionFact | null {
  const row = sql
    .exec<{ id: string; run_id: string; questions_json: string }>(
      "SELECT id, run_id, questions_json FROM question WHERE state = 'open' LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) {
    return null;
  }
  return {
    questionId: row.id,
    runId: row.run_id,
    questionCount: (JSON.parse(row.questions_json) as unknown[]).length,
  };
}

/**
 * The current run and its cached state, for the sidebar's status dot. Read
 * from the rows because the caller's `SessionRow` can predate a run this
 * transaction inserted. The current run is always the newest row
 * (`applyPlanRows` inserts and makes it current together), so this is one row
 * read from the end of the rowid order, never a scan.
 */
export function readCurrentRunForProjection(sql: SqlStorage): SessionSnapshot["currentRun"] {
  const row = sql
    .exec<{ id: string; state: string }>("SELECT id, state FROM run ORDER BY rowid DESC LIMIT 1")
    .toArray()[0];
  return row === undefined ? null : { runId: row.id, state: row.state as RunState };
}

export function readEventsAfter(sql: SqlStorage, after: number): readonly StoredEventRow[] {
  const rows = [
    ...sql.exec<{ session_sequence: number; envelope_json: string }>(
      "SELECT session_sequence, envelope_json FROM event WHERE session_sequence > ? ORDER BY session_sequence ASC",
      after,
    ),
  ];
  return rows.map((row) => ({
    sessionSequence: row.session_sequence,
    envelopeJson: row.envelope_json,
  }));
}

/**
 * The gate's own tables, written beside the events that prove them. A
 * `verification.result` for an attempt no `verification.started` opened
 * updates nothing, so the claim fails on it.
 */
export function recordVerification(sql: SqlStorage, event: CommittedEvent): void {
  if (event.type === "verification.started") {
    const payload = (event as ProtocolEventOf<"verification.started">).payload;
    sql.exec(
      `INSERT OR REPLACE INTO verification_check (run_id, check_id, attempt, sandbox_generation, classification, revision, result, evidence_artifact_id)
         VALUES (?,?,?,?,?,?,NULL,NULL)`,
      event.runId,
      payload.checkId,
      payload.attempt,
      event.sandboxGeneration,
      payload.classification,
      payload.revision,
    );
    sql.exec(
      "INSERT OR REPLACE INTO verification_check_name (run_id, check_id, name) VALUES (?,?,?)",
      event.runId,
      payload.checkId,
      payload.name,
    );
    return;
  }
  if (event.type === "verification.result") {
    const payload = (event as ProtocolEventOf<"verification.result">).payload;
    sql.exec(
      "UPDATE verification_check SET result = ?, evidence_artifact_id = ? WHERE run_id = ? AND check_id = ? AND attempt = ?",
      payload.result,
      payload.evidence.find((ref) => ref.kind === "log")?.artifactId ?? null,
      event.runId,
      payload.checkId,
      payload.attempt,
    );
    return;
  }
  if (event.type === "verification.completed") {
    const payload = (event as ProtocolEventOf<"verification.completed">).payload;
    sql.exec(
      "INSERT OR REPLACE INTO run_verification (run_id, required_total, user_skipped_count, sandbox_generation) VALUES (?,?,?,?)",
      event.runId,
      payload.required.total,
      payload.userSkipped.length,
      event.sandboxGeneration,
    );
  }
}

/**
 * The session's harness id, or null for a session created before harnesses
 * (which ran OpenCode). Read when planning a run.start or a model grant, never per frame.
 */
export function readRuntimeId(sql: SqlStorage): string | null {
  return (
    sql
      .exec<{ runtime_id: string }>("SELECT runtime_id FROM session_runtime WHERE id = 1")
      .toArray()[0]?.runtime_id ?? null
  );
}

/** The policy in force and the proposal awaiting a click: one row by key, the default when there is none. */
export function readPolicy(sql: SqlStorage): {
  readonly policy: SessionPolicy;
  readonly open: OpenProposal | null;
} {
  const row = sql
    .exec<{
      policy_json: string;
      open_proposal_id: string | null;
      open_base_version: number | null;
      open_to_json: string | null;
    }>(
      "SELECT policy_json, open_proposal_id, open_base_version, open_to_json FROM session_policy WHERE id = 1",
    )
    .toArray()[0];
  if (row === undefined) {
    return { policy: DEFAULT_SESSION_POLICY, open: null };
  }
  return {
    policy: JSON.parse(row.policy_json) as SessionPolicy,
    open:
      row.open_proposal_id === null
        ? null
        : {
            proposalId: row.open_proposal_id,
            baseVersion: row.open_base_version as number,
            to: JSON.parse(row.open_to_json as string) as SessionPolicy,
          },
  };
}

export function readPolicyForCommand(sql: SqlStorage): {
  readonly stored: SessionPolicy;
  readonly open: OpenProposal | null;
} {
  const { policy, open } = readPolicy(sql);
  return { stored: policy, open };
}

export function writePolicy(
  sql: SqlStorage,
  policy: SessionPolicy,
  open: OpenProposal | null,
): void {
  sql.exec(
    "INSERT OR REPLACE INTO session_policy (id, policy_json, open_proposal_id, open_base_version, open_to_json) VALUES (1,?,?,?,?)",
    JSON.stringify(policy),
    open === null ? null : open.proposalId,
    open === null ? null : open.baseVersion,
    open === null ? null : JSON.stringify(open.to),
  );
}

export function readDescription(sql: SqlStorage): StoredDescription | null {
  const row = sql
    .exec<{
      title: string | null;
      body: string | null;
      branch_name: string | null;
      version: number;
      applied_version: number;
    }>(
      "SELECT title, body, branch_name, version, applied_version FROM pull_request_description WHERE id = 1",
    )
    .toArray()[0];
  return row === undefined
    ? null
    : {
        title: row.title,
        body: row.body,
        branchName: row.branch_name,
        version: row.version,
        appliedVersion: row.applied_version,
      };
}

/** The earliest open approval's expiry, one row from the partial index. Stored, so hibernation cannot lose it. */
export function readApprovalDeadlineMs(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ expires_at: string }>(
      "SELECT expires_at FROM approval WHERE state = 'requested' ORDER BY expires_at LIMIT 1",
    )
    .toArray()[0];
  return row === undefined ? null : Date.parse(row.expires_at);
}

/**
 * `planRunRow`'s answer as SQL. `ready` is guarded by the row itself
 * (`provisioning` only, its one edge in `RUN_TRANSITIONS`) rather than a read.
 * The others move only a row with no outcome, so a run the object already
 * ended stays ended when the bridge's late event arrives. A resumed run keeps
 * its `started_at`.
 */
export function applyRunRow(
  sql: SqlStorage,
  change: (RunRowChange & { readonly runId: string }) | null,
  at: string,
): void {
  if (change === null) {
    return;
  }
  switch (change.kind) {
    case "ready":
      sql.exec(
        "UPDATE run SET state = 'ready' WHERE id = ? AND state = 'provisioning'",
        change.runId,
      );
      return;
    case "started":
      sql.exec(
        "UPDATE run SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND outcome IS NULL",
        at,
        change.runId,
      );
      return;
    case "paused":
      sql.exec("UPDATE run SET state = 'paused' WHERE id = ? AND outcome IS NULL", change.runId);
      return;
    case "ended":
      sql.exec(
        "UPDATE run SET state = ?, outcome = ?, ended_at = ? WHERE id = ? AND outcome IS NULL",
        change.outcome,
        change.outcome,
        at,
        change.runId,
      );
      return;
  }
}

/** A run row is only inserted with its `run.queued`, so the event is always there. */
export function readRunModel(sql: SqlStorage, runId: string): RunModel {
  return findRunModel(sql, runId) as RunModel;
}

/**
 * The model a run was queued with, or null for a run id this object never
 * queued. A record stored before effort levels existed has no `effort` and
 * reads as `null`, so older sessions resume on the record they had.
 */
export function findRunModel(sql: SqlStorage, runId: string): RunModel | null {
  const row = sql
    .exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'run.queued' AND run_id = ?",
      runId,
    )
    .toArray()[0];
  if (row === undefined) {
    return null;
  }
  const { model } = (JSON.parse(row.envelope_json) as ProtocolEventOf<"run.queued">).payload;
  return { ...model, effort: model.effort ?? null };
}

export function applyDispatchRow(sql: SqlStorage, change: DispatchRowChange, now: string): void {
  switch (change.kind) {
    case "insert_dispatch":
      sql.exec(
        `INSERT INTO bridge_dispatch (intent_id, generation, kind, state, payload_json, attempts, created_at, settled_at)
           VALUES (?,?,?,?,?,?,?,NULL)`,
        change.row.intentId,
        change.row.generation,
        DISPATCH_COLUMN_KIND[change.row.kind.kind],
        change.row.state,
        JSON.stringify(change.row.kind),
        change.row.attempts,
        change.row.createdAt,
      );
      return;
    case "mark_dispatch":
      sql.exec(
        `UPDATE bridge_dispatch
           SET state = ?, attempts = attempts + ?,
               settled_at = CASE WHEN ? IN ('accepted', 'rejected') THEN ? ELSE settled_at END
           WHERE intent_id = ?`,
        change.state,
        change.bumpAttempts ? 1 : 0,
        change.state,
        now,
        change.intentId,
      );
      return;
    case "delete_open_for_generation":
      sql.exec(
        "DELETE FROM bridge_dispatch WHERE generation = ? AND state IN ('pending', 'sent')",
        change.generation,
      );
      return;
    case "hold_message":
      sql.exec(
        `INSERT INTO queued_message (message_id, command_id, issued_by_user_id, text, attachments_json, held_at, released_at, released_run_id)
           VALUES (?,?,?,?,?,?,NULL,NULL)`,
        change.row.messageId,
        change.row.commandId,
        change.row.issuedByUserId,
        change.row.text,
        JSON.stringify(change.row.attachments),
        change.row.heldAt,
      );
      if (change.row.skipRequiredChecks) {
        sql.exec(
          "INSERT OR IGNORE INTO check_skip_request (message_id) VALUES (?)",
          change.row.messageId,
        );
      }
      if (change.row.effort !== undefined) {
        sql.exec(
          "INSERT OR REPLACE INTO queued_message_effort (message_id, effort) VALUES (?, ?)",
          change.row.messageId,
          change.row.effort,
        );
      }
      return;
    case "release_message":
      sql.exec(
        "UPDATE queued_message SET released_at = ?, released_run_id = ? WHERE message_id = ?",
        now,
        change.runId,
        change.messageId,
      );
      return;
    case "mark_git_grant_revoked":
      sql.exec("UPDATE session_repository SET git_grant_revoked = 1");
      return;
    case "fail_run":
      sql.exec(
        "UPDATE run SET state = 'failed', outcome = 'failed', ended_at = ? WHERE id = ? AND outcome IS NULL",
        now,
        change.runId,
      );
      return;
  }
}

export function advanceRuntimeCursor(
  sql: SqlStorage,
  session: SessionRow,
  runtimeSequence: number | null,
): void {
  // Only admitted sandbox frames reach here, each with exactly the next
  // `runtimeSequence`, so `advanceCursor`'s "unchanged" arm cannot fire and
  // needs no guard.
  const next = advanceCursor(
    { lastRuntimeSequence: session.lastRuntimeSequence },
    { runtimeSequence },
  );
  sql.exec(
    "UPDATE session SET last_runtime_sequence = ? WHERE id = ?",
    next.lastRuntimeSequence,
    session.id,
  );
}

export function readOutboxRows(sql: SqlStorage): readonly OutboxRow[] {
  const rows = [
    ...sql.exec<{
      id: string;
      session_id: string;
      sequence: number;
      fact_type: string;
      schema_version: number;
      payload_json: string;
      created_at: string;
      attempts: number;
    }>(
      "SELECT id, session_id, sequence, fact_type, schema_version, payload_json, created_at, attempts FROM outbox ORDER BY sequence ASC",
    ),
  ];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    factType: row.fact_type,
    schemaVersion: row.schema_version,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    attempts: row.attempts,
  }));
}

export function readArtifactRow(
  sql: SqlStorage,
  artifactId: string,
): {
  readonly runId: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly byteSize: number;
  readonly state: string;
  readonly objectKey: string;
} | null {
  const row = sql
    .exec<{
      run_id: string;
      kind: string;
      content_type: string;
      byte_size: number;
      state: string;
      object_key: string;
    }>(
      "SELECT run_id, kind, content_type, byte_size, state, object_key FROM artifact WHERE id = ?",
      artifactId,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : {
        runId: row.run_id,
        kind: row.kind as ArtifactKind,
        contentType: row.content_type,
        byteSize: row.byte_size,
        state: row.state,
        objectKey: row.object_key,
      };
}
