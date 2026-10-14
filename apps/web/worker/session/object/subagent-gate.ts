// Admits the bridge's `agent.started` and `agent.completed`, and a subagent's
// own messages and calls (record 12), against the `subagent`, `run`, and
// `approval` tables: keyed reads and one bounded read by run, never the event
// log (record 01, "Read cost"). A refusal is never stored and counts against
// the socket with the other refused claims; a frame for a run that already
// ended is dropped without counting.

import {
  buildEvent,
  type CommittedEvent,
  isTerminal,
  type ProtocolEvent,
  type ProtocolEventOf,
  type RunState,
} from "@oncue/protocol";
import { log } from "../../log";
import { MAX_PERMISSION_ASKS_PER_RUN } from "../permission-asks";
import { LIVE_RUN_STATES } from "../pr-description";
import {
  type AgentDecision,
  type AgentRow,
  type AgentRunStanding,
  agentRunsIn,
  decideAgentCompleted,
  decideAgentStarted,
  decideAgentTagged,
  MAX_AGENTS_PER_RUN,
} from "../subagents";
import { MAX_PROPOSAL_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { insertEventRow } from "./store-session";
import type { SessionRow } from "./types";

type AgentEvent = CommittedEvent & ProtocolEventOf<"agent.started" | "agent.completed">;

/** The stored message and call events a subagent's `agentId` may ride on. */
type AgentTaggedEvent = CommittedEvent &
  ProtocolEventOf<
    | "message.started"
    | "message.completed"
    | "tool.requested"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
  >;

export function isAgentEvent(event: CommittedEvent): event is AgentEvent {
  return event.type === "agent.started" || event.type === "agent.completed";
}

/** A subagent's own message or call: one that carries its `agentId`. */
export function isAgentTagged(event: CommittedEvent): event is AgentTaggedEvent {
  return (
    (event.type.startsWith("message.") || event.type.startsWith("tool.")) &&
    (event.payload as { readonly agentId?: string }).agentId !== undefined
  );
}

/** Where a frame's own run stands: one keyed read, whichever run is current now. */
function runStanding(sql: SqlStorage, session: SessionRow, runId: string): AgentRunStanding {
  const state = sql
    .exec<{ state: string }>("SELECT state FROM run WHERE id = ?", runId)
    .toArray()[0]?.state;
  if (state === undefined) {
    return "other";
  }
  if (isTerminal("run", state as RunState)) {
    return "ended";
  }
  return runId === session.currentRunId && LIVE_RUN_STATES.has(state) ? "live" : "other";
}

function readAgentRow(sql: SqlStorage, agentId: string): AgentRow | null {
  return (
    sql
      .exec<AgentRow & Record<string, SqlStorageValue>>(
        "SELECT run_id AS runId, sandbox_generation AS sandboxGeneration, status FROM subagent WHERE agent_id = ?",
        agentId,
      )
      .toArray()[0] ?? null
  );
}

export function admitAgentEvent(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: AgentEvent,
  envelopeJson: string,
): void {
  const sql = host.objectCtx.storage.sql;
  if (event.type === "agent.started") {
    const payload = (event as ProtocolEventOf<"agent.started">).payload;
    const decision = decideAgentStarted({
      run: runStanding(sql, session, event.runId),
      facts: () => {
        const row = sql
          .exec<{ known: number; allowed: number; asked: number }>(
            `SELECT EXISTS (SELECT 1 FROM subagent WHERE agent_id = ?1) AS known,
                    EXISTS (SELECT 1 FROM approval INDEXED BY idx_approval_tool_call
                             WHERE tool_call_id = ?2 AND run_id = ?3 AND requested_generation = ?4
                               AND category = 'start_subagent' AND state = 'approved') AS allowed,
                    COALESCE((SELECT asked FROM run_permission_count WHERE run_id = ?3), 0) AS asked`,
            payload.agentId,
            payload.parentToolCallId,
            event.runId,
            event.sandboxGeneration,
          )
          .one();
        // The run's subagents on the frame's own sandbox, as the bridge counts
        // them, and bounded by the refusal: never more rows than the limit.
        const calls = sql
          .exec<{ call: string }>(
            "SELECT parent_tool_call_id AS call FROM subagent WHERE run_id = ? AND sandbox_generation = ?",
            event.runId,
            event.sandboxGeneration,
          )
          .toArray();
        return {
          alreadyKnown: row.known === 1,
          startedThisRun: calls.length,
          // Past the run's cap on recorded asks a saved choice still allows a
          // start but leaves no row, so the object can no longer tell and does
          // not refuse.
          callAllowed: row.allowed === 1 || row.asked > MAX_PERMISSION_ASKS_PER_RUN,
          callTaken: calls.some((taken) => taken.call === payload.parentToolCallId),
        };
      },
    });
    if (!settle(host, ws, session, decision)) {
      return;
    }
    host.objectCtx.storage.transactionSync(() => {
      insertEventRow(sql, event, envelopeJson);
      sql.exec(
        `INSERT INTO subagent (agent_id, run_id, sandbox_generation, parent_tool_call_id, name, description, status, started_at)
           VALUES (?,?,?,?,?,?,'running',?)`,
        payload.agentId,
        event.runId,
        event.sandboxGeneration,
        payload.parentToolCallId,
        payload.name,
        payload.description,
        event.committedAt,
      );
    });
    host.broadcastToClients(envelopeJson);
    return;
  }
  const payload = (event as ProtocolEventOf<"agent.completed">).payload;
  const decision = decideAgentCompleted({
    row: readAgentRow(sql, payload.agentId),
    frame: event,
    run: () => runStanding(sql, session, event.runId),
  });
  if (!settle(host, ws, session, decision)) {
    return;
  }
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(sql, event, envelopeJson);
    closeAgentRow(sql, event as ProtocolEventOf<"agent.completed">, event.committedAt);
  });
  host.broadcastToClients(envelopeJson);
}

/**
 * Whether a subagent's own message or call may be stored: one keyed read of
 * the subagent it names, and the run's row only when that does not support it.
 */
export function admitAgentTagged(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: AgentTaggedEvent,
): boolean {
  const sql = host.objectCtx.storage.sql;
  const decision = decideAgentTagged({
    row: readAgentRow(sql, event.payload.agentId as string),
    frame: event,
    run: () => runStanding(sql, session, event.runId),
  });
  return settle(host, ws, session, decision);
}

/** A stored `agent.completed`, from the bridge or the object, closes its subagent's row once. */
export function closeAgentRow(
  sql: SqlStorage,
  event: ProtocolEventOf<"agent.completed">,
  at: string,
): void {
  sql.exec(
    "UPDATE subagent SET status = ?, completed_at = ?, result_summary = ? WHERE agent_id = ? AND status = 'running'",
    event.payload.status,
    at,
    event.payload.resultSummary,
    event.payload.agentId,
  );
}

/**
 * Whether a subagent of this run is running on this sandbox, so a stop for any
 * other is refused before it reaches the bridge. One keyed read.
 */
export function agentRunning(
  sql: SqlStorage,
  runId: string | null,
  generation: number,
  agentId: string,
): boolean {
  return agentRunsIn(readAgentRow(sql, agentId), { runId, sandboxGeneration: generation });
}

/**
 * The ends the object owes the subagents an interruption orphaned. The sandbox
 * that ran them is gone, so nothing else will report them, and a run continued
 * on a new sandbox would otherwise show them running. Read by the run's index,
 * at most the run's bound a time; the caller commits these with the
 * `run.interrupted` that orphaned them.
 */
export function orphanedAgentEnds(
  sql: SqlStorage,
  events: readonly ProtocolEvent[],
  now: string,
): ProtocolEvent[] {
  const ends: ProtocolEvent[] = [];
  for (const event of events) {
    if (event.type !== "run.interrupted") {
      continue;
    }
    const running = sql
      .exec<{ agent_id: string; started_at: string }>(
        "SELECT agent_id, started_at FROM subagent WHERE run_id = ? AND status = 'running' LIMIT ?",
        event.runId,
        MAX_AGENTS_PER_RUN,
      )
      .toArray();
    for (const row of running) {
      ends.push(
        buildEvent("agent.completed", {
          eventId: crypto.randomUUID(),
          sessionId: event.sessionId,
          runId: event.runId,
          sandboxGeneration: event.sandboxGeneration,
          runtimeSequence: null,
          occurredAt: now,
          payload: {
            agentId: row.agent_id,
            status: "cancelled",
            // Only the sandbox counted its tokens and calls, and it is gone.
            usage: {
              tokens: 0,
              toolCalls: 0,
              durationMs: Math.max(0, Date.parse(now) - Date.parse(row.started_at)),
            },
            resultSummary: null,
          },
        } as never),
      );
    }
  }
  return ends;
}

/** True for an admitted frame. A dropped one is logged; a refused one also counts against the socket. */
function settle(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  decision: AgentDecision,
): boolean {
  if (decision.kind === "admit") {
    return true;
  }
  log({
    timestamp: new Date().toISOString(),
    severity: decision.kind === "drop" ? "info" : "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.ingest",
    result: decision.kind === "drop" ? "dropped" : "refused",
    errorCategory: decision.kind === "drop" ? "agent_run_ended" : decision.reason,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  if (decision.kind === "drop") {
    return false;
  }
  const refused = (host.proposalRefusals.get(ws) ?? 0) + 1;
  host.proposalRefusals.set(ws, refused);
  if (refused > MAX_PROPOSAL_REFUSALS) {
    ws.close(4001, "agent refused");
  }
  return false;
}
