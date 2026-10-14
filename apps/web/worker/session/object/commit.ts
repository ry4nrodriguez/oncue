// The one write path: commands planned and committed with their outbox
// snapshot, control events, the broadcast, and the D1 projection drain.

import type { CommittedEvent, ProtocolCommand, ProtocolEvent, RunState } from "@oncue/protocol";
import { type AdmissionDecision, decideAdmission, readPlatformControl } from "../../admission";
import { acceptsEffort, findModel } from "../../broker/providers/catalog";
import { resolveRuntime } from "../../runtime/resolve";
import {
  type ActualExpectation,
  type CommandPlan,
  type ModelChangeOutcome,
  planCommand,
} from "../commands";
import { planCompute } from "../lifecycle";
import { drainOutbox, type OutboxRow, planOutboxRow } from "../outbox";
import type { SessionHost } from "./host";
import { clearSessionRules, saveSessionRule, writeSessionMode } from "./permission-gate";
import { readEndedGeneration } from "./store-lifecycle";
import {
  commandAlreadyProcessed,
  findRunModel,
  insertCommandRecord,
  insertEventRow,
  insertSessionRow,
  readCurrentRunForProjection,
  readNextSessionSequence,
  readOpenApproval,
  readOpenQuestionFact,
  readOutboxRows,
  readPolicyForCommand,
  readProviderSandboxId,
  readRunModel,
  readRunState,
  readRuntimeId,
  readSessionState,
  readWaitingForUser,
  writePolicy,
} from "./store-session";
import { agentRunning } from "./subagent-gate";
import type { NewSessionRow, SessionRow } from "./types";

function actualExpectationFor(
  host: SessionHost,
  command: ProtocolCommand,
  session: SessionRow,
): ActualExpectation {
  if (command.expected.scope === "session") {
    return { scope: "session", state: session.state };
  }
  const runState = readRunState(host.objectCtx.storage.sql, command.runId as string);
  const state: RunState = runState === null ? "created" : runState;
  return { scope: "run", state };
}

function commitControlEvent(host: SessionHost, event: ProtocolEvent, now: string): CommittedEvent {
  const sessionSequence = readNextSessionSequence(host.objectCtx.storage.sql);
  const committed: CommittedEvent = {
    ...event,
    sessionSequence,
    committedAt: now,
  } as CommittedEvent;
  insertEventRow(host.objectCtx.storage.sql, committed, JSON.stringify(committed));
  return committed;
}

function applyPlanRows(
  host: SessionHost,
  session: SessionRow,
  plan: Extract<CommandPlan, { kind: "accept" }>,
  now: string,
): void {
  for (const row of plan.rows) {
    if (row.kind === "insert_run") {
      host.objectCtx.storage.sql.exec(
        `INSERT INTO run (id, session_id, state, outcome, trigger, instruction_message_id, continues_run_id, sandbox_generation, created_by_command_id, queued_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        row.row.runId,
        session.id,
        row.row.state,
        null,
        row.row.trigger,
        row.row.instructionMessageId,
        row.row.continuesRunId,
        row.row.sandboxGeneration,
        row.row.createdByCommandId,
        row.row.queuedAt,
      );
      host.objectCtx.storage.sql.exec(
        "UPDATE session SET current_run_id = ?, updated_at = ? WHERE id = ?",
        row.row.runId,
        now,
        session.id,
      );
    } else if (row.kind === "update_run") {
      host.objectCtx.storage.sql.exec(
        "UPDATE run SET state = ?, outcome = ? WHERE id = ?",
        row.row.state,
        row.row.outcome,
        row.row.runId,
      );
    } else if (row.kind === "write_policy") {
      writePolicy(host.objectCtx.storage.sql, row.policy, null);
    } else if (row.kind === "save_session_rule") {
      saveSessionRule(host.objectCtx.storage.sql, row.category, now);
    } else if (row.kind === "write_session_mode") {
      writeSessionMode(host.objectCtx.storage.sql, row.mode);
    } else if (row.kind === "clear_session_rules") {
      clearSessionRules(host.objectCtx.storage.sql);
    } else if (row.kind === "settle_question") {
      host.objectCtx.storage.sql.exec(
        "UPDATE question SET state = ?, answers_json = ?, settled_at = ? WHERE id = ? AND state = 'open'",
        row.state,
        row.answersJson,
        row.at,
        row.questionId,
      );
    } else {
      host.objectCtx.storage.sql.exec(
        `UPDATE approval SET state = ?, decision = ?, decided_by = ?, decided_command_id = ?, decided_for_generation = ?, decided_at = ?
           WHERE id = ? AND state = 'requested'`,
        row.row.decision,
        row.row.decision,
        row.row.decidedBy,
        row.row.decidedCommandId,
        row.row.decidedForGeneration,
        row.row.decidedAt,
        row.row.approvalId,
      );
    }
  }
}

export function enqueueOutboxSnapshot(
  host: SessionHost,
  session: SessionRow,
  now: string,
  /** True on the commit that changes the session's model, so the index row follows it. */
  modelConnectionChanged = false,
): void {
  const outboxId = crypto.randomUUID();
  const sequence = readNextSessionSequence(host.objectCtx.storage.sql) - 1;
  const row = planOutboxRow(
    session.id,
    {
      state: session.state,
      title: session.title,
      sandboxProviderRef: readProviderSandboxId(
        host.objectCtx.storage.sql,
        session.sandboxGeneration,
      ),
      sandboxGeneration: session.sandboxGeneration,
      endedSandboxGeneration: readEndedGeneration(host.objectCtx.storage.sql),
      waitingForUser: readWaitingForUser(host.objectCtx.storage.sql),
      currentRun: readCurrentRunForProjection(host.objectCtx.storage.sql),
      ...(modelConnectionChanged ? { modelConnectionChanged: true } : {}),
    },
    sequence,
    outboxId,
    now,
  );
  host.objectCtx.storage.sql.exec(
    `INSERT INTO outbox (id, session_id, sequence, fact_type, schema_version, payload_json, created_at, attempts)
       VALUES (?,?,?,?,?,?,?,?)`,
    row.id,
    row.sessionId,
    row.sequence,
    row.factType,
    row.schemaVersion,
    row.payloadJson,
    row.createdAt,
    row.attempts,
  );
}

export function planAndCommit(
  host: SessionHost,
  session: SessionRow,
  command: ProtocolCommand,
  admission: AdmissionDecision,
  now: string,
  mintedRunId: string,
  newSessionRow: NewSessionRow | null,
  trigger: "queued_message" | null,
  /** `resumeConnectionActive`'s answer; true for every command that starts no generation. */
  modelConnectionActive: boolean,
  /** Why the message's attachments could not be claimed, or null (`claimCommandAttachments`). */
  attachmentRefusal: string | null = null,
  /** `decideModelChange`'s answer for a `run.start` naming another model, or null. */
  modelChange: ModelChangeOutcome | null = null,
): CommandPlan {
  // Read again: the caller's row predates its awaits, and an archive or a
  // delete in between must close the session to this command.
  const storedState = readSessionState(host.objectCtx.storage.sql);
  if (storedState === null && newSessionRow === null) {
    // The session was erased during the caller's await. Nothing is planned or
    // written, and the caller is told the command needs nothing more.
    return { kind: "already_processed", commandId: command.commandId };
  }
  const current: SessionRow = { ...session, state: storedState ?? session.state };
  const openApproval =
    command.type === "approval.resolve"
      ? readOpenApproval(host.objectCtx.storage.sql, command.payload.approvalId)
      : null;
  const plan = planCommand({
    command,
    alreadyProcessed: commandAlreadyProcessed(host.objectCtx.storage.sql, command.commandId),
    ownerUserId: session.ownerUserId,
    admission,
    actualExpectation: actualExpectationFor(host, command, current),
    sessionState: current.state,
    currentGeneration: session.sandboxGeneration,
    computeAttached:
      (command.type === "run.follow_up" || command.type === "question.resolve") &&
      planCompute(host.lifecycleView(session, Date.now())).kind !== "provision",
    modelConnectionActive,
    effortAccepted: effortAccepted(host, command),
    modelChange,
    // Checked on every run.start, so an allowlist change reaches the next run
    // and never one already running.
    runtime:
      command.type === "run.start"
        ? resolveRuntime({
            requested:
              newSessionRow?.runtimeId ?? readRuntimeId(host.objectCtx.storage.sql) ?? undefined,
            allowlist: (host.objectEnv as { readonly ONCUE_RUNTIME_ALLOWLIST?: string | undefined })
              .ONCUE_RUNTIME_ALLOWLIST,
            provider: command.payload.model.provider,
            effort: command.payload.model.effort ?? null,
          })
        : null,
    attachmentRefusal,
    openApproval,
    openQuestion:
      command.type === "question.resolve" ||
      command.type === "run.follow_up" ||
      command.type === "run.pause"
        ? readOpenQuestionFact(host.objectCtx.storage.sql)
        : null,
    // Read only for the one command that needs it.
    policy: command.type === "policy.set" ? readPolicyForCommand(host.objectCtx.storage.sql) : null,
    ...(command.type === "agent.stop"
      ? {
          agentRunning: agentRunning(
            host.objectCtx.storage.sql,
            command.runId,
            session.sandboxGeneration,
            command.payload.agentId,
          ),
        }
      : {}),
    firstEventId: crypto.randomUUID(),
    domainEventId: crypto.randomUUID(),
    mintedRunId,
    now,
    // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes`.
    ...(trigger === null ? {} : { trigger }),
  });
  if (plan.kind === "already_processed") {
    return plan;
  }
  const committed: CommittedEvent[] = [];
  host.objectCtx.storage.transactionSync(() => {
    if (newSessionRow !== null) {
      insertSessionRow(host.objectCtx.storage.sql, session, newSessionRow, now);
    }
    if (plan.kind === "reject") {
      committed.push(commitControlEvent(host, plan.event, now));
      insertCommandRecord(
        host.objectCtx.storage.sql,
        command,
        "rejected",
        JSON.stringify(plan.event),
        now,
      );
    } else {
      for (const event of plan.events) {
        committed.push(commitControlEvent(host, event, now));
      }
      applyPlanRows(host, session, plan, now);
      insertCommandRecord(
        host.objectCtx.storage.sql,
        command,
        "acknowledged",
        JSON.stringify(plan.events[0]),
        now,
      );
      if (command.type === "run.start" && command.payload.skipRequiredChecks === true) {
        host.objectCtx.storage.sql.exec(
          "INSERT OR IGNORE INTO check_skip_request (message_id) VALUES (?)",
          command.payload.instruction.messageId,
        );
      }
      if (command.type === "run.follow_up" && command.payload.delivery === "steer_current_run") {
        host.objectCtx.storage.sql.exec(
          "INSERT OR IGNORE INTO run_message (message_id, run_id) VALUES (?,?)",
          command.payload.messageId,
          command.runId,
        );
      }
    }
    host.enqueueOutboxSnapshot(
      session,
      now,
      plan.kind === "accept" && modelChange?.kind === "changed",
    );
  });
  for (const event of committed) {
    host.broadcastToClients(JSON.stringify(event));
  }
  return plan;
}

/**
 * The object's own control-origin events, outside a command. Same write path
 * as `planAndCommit`: events, the outbox snapshot, and `rows` (the cached
 * state the events prove) in one `transactionSync`, then the broadcast.
 */
export function commitControlEvents(
  host: SessionHost,
  session: SessionRow,
  events: readonly ProtocolEvent[],
  now: string,
  rows: () => void,
): readonly CommittedEvent[] {
  if (host.erased) {
    // The caller's row predates the erase: the session it names is gone, and
    // its events, rows, and snapshot (which carries the title) must not come
    // back into the emptied object. Asked of memory, so no commit pays a read.
    return [];
  }
  const committed: CommittedEvent[] = [];
  host.objectCtx.storage.transactionSync(() => {
    for (const event of events) {
      committed.push(commitControlEvent(host, event, now));
    }
    rows();
    host.enqueueOutboxSnapshot(session, now);
  });
  for (const event of committed) {
    host.broadcastToClients(JSON.stringify(event));
  }
  host.objectCtx.waitUntil(host.drainOutboxNow());
  return committed;
}

export async function decideAdmissionNow(host: SessionHost): Promise<AdmissionDecision> {
  const control = await readPlatformControl(host.objectEnv.DB);
  return decideAdmission(control, {
    workspaceActiveSandboxCount: 0,
    platformActiveSandboxCount: 0,
  });
}

export function broadcastToClients(host: SessionHost, text: string): void {
  for (const ws of host.objectCtx.getWebSockets("client")) {
    // A socket this object closed (a session being deleted) stays listed until
    // the browser answers the close, and a send to it throws.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  }
}

/**
 * Whether a follow-up's effort is one the run's model documents
 * (`acceptsEffort`). None named is fine; a model the catalog does not know
 * (the fake driver's) offers no levels.
 */
function effortAccepted(host: SessionHost, command: ProtocolCommand): boolean {
  if (command.type !== "run.follow_up" || command.payload.effort === undefined) {
    return true;
  }
  const model = findRunModel(host.objectCtx.storage.sql, command.runId as string);
  if (model === null) {
    return false;
  }
  const spec = findModel(model.provider, model.modelId);
  return spec !== null && acceptsEffort(spec, command.payload.effort);
}

export async function drainOutboxNow(host: SessionHost): Promise<void> {
  const rows = readOutboxRows(host.objectCtx.storage.sql);
  const outcome = await drainOutbox(rows, (row) => applyProjectionToD1(host, row));
  host.objectCtx.storage.transactionSync(() => {
    for (const id of outcome.appliedRowIds) {
      host.objectCtx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", id);
    }
    for (const row of outcome.remaining) {
      host.objectCtx.storage.sql.exec(
        "UPDATE outbox SET attempts = ?, last_attempt_at = ? WHERE id = ?",
        row.attempts,
        new Date().toISOString(),
        row.id,
      );
    }
  });
  host.outboxDueAtMs =
    outcome.nextAlarmDelayMs === null ? null : Date.now() + outcome.nextAlarmDelayMs;
  await host.rearm();
}

/**
 * A projection moves `state` only out of `creating`. Archiving, restoring,
 * and deleting are written by their routes once the object has agreed, so a
 * snapshot taken before one of them can never undo it, and a
 * `deletion_pending` row never comes back.
 */
function applyProjectionToD1(host: SessionHost, row: OutboxRow): Promise<boolean> {
  const snapshot = JSON.parse(row.payloadJson) as {
    /** Set on the commit that changed the session's model; absent on every other row. */
    modelConnectionChanged?: boolean;
    state: string;
    title: string | null;
    lastActivityAt: string;
    sandboxProviderRef: string | null;
    sandboxGeneration: number;
    endedSandboxGeneration?: number | null;
    /** Absent on older rows, which read as not waiting. */
    waitingForUser?: boolean;
    /** Absent on rows written before migration 0015, which leave the columns as they are. */
    currentRunId?: string | null;
    currentRunState?: string | null;
  };
  const ended = snapshot.endedSandboxGeneration ?? null;
  const projection = host.objectEnv.DB.prepare(
    `UPDATE session_index
       SET state = CASE WHEN state = 'creating' THEN ? ELSE state END,
           title = ?, last_activity_at = ?, sandbox_provider_ref = ?, sandbox_generation = ?,
           ended_sandbox_generation = CASE WHEN ? IS NULL THEN ended_sandbox_generation
                                           ELSE MAX(COALESCE(ended_sandbox_generation, 0), ?) END,
           waiting_for_user = ?,
           current_run_id = COALESCE(?, current_run_id),
           current_run_state = COALESCE(?, current_run_state),
           last_projected_sequence = ?, updated_at = ?
       WHERE session_id = ? AND last_projected_sequence < ?`,
  ).bind(
    snapshot.state,
    snapshot.title,
    snapshot.lastActivityAt,
    snapshot.sandboxProviderRef,
    snapshot.sandboxGeneration,
    ended,
    ended,
    snapshot.waitingForUser === true ? 1 : 0,
    snapshot.currentRunId ?? null,
    snapshot.currentRunState ?? null,
    row.sequence,
    snapshot.lastActivityAt,
    row.sessionId,
    row.sequence,
  );
  // The connection the session's latest run charges, which Settings counts
  // sessions by (record 06). Read now rather than carried on the row, and
  // written whatever the row's sequence: a snapshot is skipped once a later
  // one has landed, and this fact must not be lost with it or go backwards.
  const connectionId =
    snapshot.modelConnectionChanged === true ? latestModelConnection(host) : null;
  const written =
    connectionId === null
      ? projection.run()
      : host.objectEnv.DB.batch([
          projection,
          host.objectEnv.DB.prepare(
            "UPDATE session_index SET model_connection_id = ? WHERE session_id = ?",
          ).bind(connectionId, row.sessionId),
        ]);
  return written.then(
    () => true,
    () => false,
  );
}

/** The model connection of the session's current run, or null when the session is gone. */
function latestModelConnection(host: SessionHost): string | null {
  const runId = host.readSession()?.currentRunId;
  return typeof runId === "string"
    ? readRunModel(host.objectCtx.storage.sql, runId).modelConnectionId
    : null;
}
