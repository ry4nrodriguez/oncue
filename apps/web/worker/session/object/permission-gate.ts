// The harness's own permission asks on the object's side (record 09, "Agent
// permissions"): judging one, answering it from the session's mode and rules
// and the workspace's, or opening a card; and saving what a card's answer or
// the menu below the composer chose for the session. The workspace's default
// is written by `/api/approval-settings`, which answers with what is in force. `permission-asks.ts` decides; this reads, writes,
// and tells the bridge.

import {
  type ApprovalScope,
  buildEvent,
  type CommittedEvent,
  type PayloadOf,
  type PermissionCategory,
  type ProtocolEventOf,
} from "@oncue/protocol";
import {
  NO_WORKSPACE_APPROVALS,
  readWorkspaceApprovals,
  saveWorkspaceRule,
  type WorkspaceApprovals,
} from "../../approvals/store";
import { log } from "../../log";
import { approvalTtlMs } from "../approvals";
import {
  decidedCategory,
  decideFromSession,
  decidePermission,
  isCountedPermissionRefusal,
  isPermissionCategory,
  judgePermissionAsk,
  judgePermissionClaim,
  type PermissionDecision,
  type PermissionRefusal,
  pastTheCap,
  permissionCardFor,
  type SessionApprovals,
  type SessionMode,
} from "../permission-asks";
import { MAX_APPROVAL_REFUSALS, MAX_SESSION_APPROVAL_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { insertEventRow, readNextSessionSequence } from "./store-session";
import type { SessionRow } from "./types";

type RequestedEvent = CommittedEvent & ProtocolEventOf<"approval.requested">;

/** Whether a sandbox's `approval.requested` is one of the harness's own asks rather than a secret. */
export function isPermissionAsk(event: RequestedEvent): boolean {
  return isPermissionCategory(event.payload.category);
}

/** The session's own mode and rules: two keyed reads, at most one row per category. */
export function readSessionApprovals(sql: SqlStorage): SessionApprovals {
  const mode = sql
    .exec<{ mode: string }>("SELECT mode FROM session_approval_mode WHERE id = 1")
    .toArray()[0]?.mode;
  const rules = sql
    .exec<{ category: string }>("SELECT category FROM session_approval_rule LIMIT 8")
    .toArray()
    .map((row) => row.category)
    .filter(isPermissionCategory);
  return { mode: mode === "session" ? "session" : "ask", rules };
}

export function writeSessionMode(sql: SqlStorage, mode: SessionMode): void {
  sql.exec(
    "INSERT INTO session_approval_mode (id, mode) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET mode = excluded.mode",
    mode,
  );
}

/** "Allow once" or "Always allow" in the menu: the session's per-category answers go. */
export function clearSessionRules(sql: SqlStorage): void {
  sql.exec("DELETE FROM session_approval_rule");
}

export function saveSessionRule(sql: SqlStorage, category: PermissionCategory, now: string): void {
  sql.exec(
    "INSERT INTO session_approval_rule (category, created_at) VALUES (?, ?) ON CONFLICT (category) DO NOTHING",
    category,
    now,
  );
}

/** The category of a permission approval, or null for a secret's. One keyed read. */
export function readPermissionCategory(
  sql: SqlStorage,
  approvalId: string,
): PermissionCategory | null {
  const category = sql
    .exec<{ category: string }>(
      "SELECT category FROM permission_request WHERE approval_id = ?",
      approvalId,
    )
    .toArray()[0]?.category;
  return category !== undefined && isPermissionCategory(category) ? category : null;
}

/**
 * The reads, cheapest first, each by a key or the partial index on open
 * approvals, never the event log. D1 is asked only when the session's own
 * rows do not already answer.
 */
async function judge(
  host: SessionHost,
  session: SessionRow,
  event: RequestedEvent,
): Promise<
  | { readonly kind: "refuse"; readonly reason: PermissionRefusal }
  | {
      readonly kind: "decide";
      readonly category: PermissionCategory;
      /** Null when the session's rows answered, so D1 was not read. */
      readonly workspace: WorkspaceApprovals | null;
    }
> {
  const claimed = judgePermissionClaim(event.payload);
  if (claimed !== null) {
    return { kind: "refuse", reason: claimed };
  }
  const sql = host.objectCtx.storage.sql;
  const runId = session.currentRunId;
  const row = sql
    .exec<{ open: number; state: string | null }>(
      `SELECT EXISTS(SELECT 1 FROM approval WHERE state = 'requested') AS open,
              (SELECT state FROM run WHERE id = ?1) AS state`,
      runId,
    )
    .one();
  const refused = judgePermissionAsk({
    openApprovalExists: row.open === 1,
    runRunning: event.runId === runId && row.state === "running",
  });
  if (refused !== null) {
    return { kind: "refuse", reason: refused };
  }
  // A secret file asks whatever the sandbox called it.
  const category = decidedCategory(
    event.payload.category as PermissionCategory,
    event.payload.resource,
  );
  if (decideFromSession(category, readSessionApprovals(sql)) !== null) {
    return { kind: "decide", category, workspace: null };
  }
  // A failed read asks the user rather than allowing: silence is never approval.
  const workspace = await readWorkspaceApprovals(host.objectEnv.DB, session.workspaceId).catch(
    () => NO_WORKSPACE_APPROVALS,
  );
  return { kind: "decide", category, workspace };
}

/**
 * The decision from the session's rows as they are now, inside the commit's
 * transaction, so a mode chosen while D1 was read is the one applied. When
 * the session's rows answered before and D1 was not read, they still answer
 * unless the mode changed in between, which then asks.
 */
function decideNow(
  sql: SqlStorage,
  category: PermissionCategory,
  workspace: WorkspaceApprovals | null,
): PermissionDecision {
  const session = readSessionApprovals(sql);
  if (workspace !== null) {
    return decidePermission(category, session, workspace);
  }
  return decideFromSession(category, session) ?? { kind: "ask" };
}

interface Settled {
  readonly outcome: "moved_on" | "recorded" | "answer_unrecorded" | "refuse";
  readonly decision: PermissionDecision;
}

/**
 * Records 04 and 09. The sandbox is trusted for the category, the resource,
 * and the kind of tool. The object mints the id, writes the card in its own
 * words, and either answers at once from a saved choice (the request and its
 * automatic resolution commit together, and the run keeps running) or opens
 * the card and moves the run to `waiting_for_approval`. Either way the bridge
 * learns its request's fate by its own reference. Past the run's cap a saved
 * choice answers without a record, and an ask needing a card is refused.
 */
export async function admitPermissionAsk(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: RequestedEvent,
): Promise<void> {
  const sandboxRef = event.payload.approvalId;
  const judged = await judge(host, session, event);
  if (judged.kind === "refuse") {
    host.sendApprovalFrame(session, sandboxRef, "refused", null);
    refusePermission(host, ws, session, judged.reason);
    return;
  }
  const now = new Date().toISOString();
  const runId = session.currentRunId as string;
  const category = judged.category;
  const approvalId = crypto.randomUUID() as typeof event.payload.approvalId;
  const subagent = askingSubagent(host.objectCtx.storage.sql, runId, event.payload.agentId);
  const card = permissionCardFor({
    category,
    resource: event.payload.resource,
    toolKind: event.payload.toolCategory ?? null,
    now,
    ttlMs: approvalTtlMs(host.objectEnv),
    subagent: subagent?.name,
  });
  const committed: CommittedEvent[] = [];
  const settled = host.objectCtx.storage.transactionSync((): Settled => {
    const sql = host.objectCtx.storage.sql;
    // The D1 read awaited; reread where nothing interleaves.
    const still = sql
      .exec<{ running: number; asked: number | null }>(
        `SELECT (SELECT state FROM run WHERE id = ?1) = 'running' AND NOT EXISTS(SELECT 1 FROM approval WHERE state = 'requested') AS running,
                (SELECT asked FROM run_permission_count WHERE run_id = ?1) AS asked`,
        runId,
      )
      .one();
    if (still.running !== 1) {
      return { outcome: "moved_on", decision: { kind: "ask" } };
    }
    const decision = decideNow(sql, category, judged.workspace);
    const handling = pastTheCap(decision, still.asked ?? 0);
    sql.exec(
      "INSERT INTO run_permission_count (run_id, asked) VALUES (?, 1) ON CONFLICT (run_id) DO UPDATE SET asked = asked + 1",
      runId,
    );
    if (handling !== "record") {
      return { outcome: handling, decision };
    }
    const requested: CommittedEvent = {
      ...event,
      sessionSequence: readNextSessionSequence(sql),
      committedAt: now,
      payload: {
        ...card,
        approvalId,
        toolCallId: event.payload.toolCallId,
        ...(event.payload.toolCategory === undefined
          ? {}
          : { toolCategory: event.payload.toolCategory }),
        ...(subagent === null ? {} : { agentId: subagent.agentId }),
      },
    } as CommittedEvent;
    insertEventRow(sql, requested, JSON.stringify(requested));
    committed.push(requested);
    sql.exec(
      "INSERT INTO approval (id, run_id, state, title, intended_action, category, risk, resource, requested_scope, tool_call_id, requested_generation, requested_at, expires_at) VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      approvalId,
      runId,
      card.title,
      card.intendedAction,
      card.category,
      card.risk,
      card.resource,
      card.requestedScope,
      event.payload.toolCallId,
      session.sandboxGeneration,
      now,
      card.expiresAt,
    );
    sql.exec(
      "INSERT INTO permission_request (approval_id, sandbox_ref, category) VALUES (?, ?, ?)",
      approvalId,
      sandboxRef,
      category,
    );
    if (decision.kind === "allow") {
      const resolved = automaticResolution(session, runId, approvalId, decision.scope, now);
      const stamped: CommittedEvent = {
        ...resolved,
        sessionSequence: readNextSessionSequence(sql),
        committedAt: now,
      } as CommittedEvent;
      insertEventRow(sql, stamped, JSON.stringify(stamped));
      committed.push(stamped);
      sql.exec(
        "UPDATE approval SET state = 'approved', decision = 'approved', decided_by = ?, decided_command_id = ?, decided_for_generation = ?, decided_at = ? WHERE id = ?",
        session.ownerUserId,
        resolved.payload.commandId,
        session.sandboxGeneration,
        now,
        approvalId,
      );
      return { outcome: "recorded", decision };
    }
    sql.exec(
      "UPDATE run SET state = 'waiting_for_approval' WHERE id = ? AND state = 'running'",
      runId,
    );
    host.enqueueOutboxSnapshot(session, now);
    return { outcome: "recorded", decision };
  });
  switch (settled.outcome) {
    case "moved_on":
      // The run moved on during the read: uncounted, the sandbox did nothing wrong.
      host.sendApprovalFrame(session, sandboxRef, "refused", null);
      return;
    case "answer_unrecorded":
      host.sendApprovalFrame(session, sandboxRef, "allowed", null);
      return;
    case "refuse":
      host.sendApprovalFrame(session, sandboxRef, "refused", null);
      refusePermission(host, ws, session, "too_many_requests");
      return;
    case "recorded":
      break;
  }
  for (const stored of committed) {
    host.broadcastToClients(JSON.stringify(stored));
  }
  if (settled.decision.kind === "allow") {
    host.sendApprovalFrame(session, sandboxRef, "allowed", null);
    return;
  }
  host.objectCtx.waitUntil(host.drainOutboxNow());
  host.sendApprovalFrame(session, sandboxRef, "pending", card.expiresAt);
  await host.rearm();
}

/**
 * The subagent an ask names, when the run's `subagent` table holds it as
 * running: one keyed read, made only for an ask that names one. A name the
 * object does not hold running is not shown, so the card never names a
 * subagent the timeline does not.
 */
function askingSubagent(
  sql: SqlStorage,
  runId: string,
  agentId: string | undefined,
): { readonly agentId: string; readonly name: string } | null {
  if (agentId === undefined) {
    return null;
  }
  const row = sql
    .exec<{ name: string }>(
      "SELECT name FROM subagent WHERE agent_id = ? AND run_id = ? AND status = 'running'",
      agentId,
      runId,
    )
    .toArray()[0];
  return row === undefined ? null : { agentId, name: row.name };
}

/** A saved choice answered. The owner chose it, so the owner is who decided; no client command exists, so the id is minted. */
function automaticResolution(
  session: SessionRow,
  runId: string,
  approvalId: string,
  scope: Exclude<ApprovalScope, "once">,
  now: string,
) {
  return buildEvent("approval.resolved", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      approvalId: approvalId as PayloadOf<"approval.resolved">["approvalId"],
      decision: "approved",
      decidedBy: session.ownerUserId as PayloadOf<"approval.resolved">["decidedBy"],
      commandId: crypto.randomUUID() as PayloadOf<"approval.resolved">["commandId"],
      decidedForGeneration: session.sandboxGeneration,
      scope,
      automatic: true,
    },
  } as never) as ProtocolEventOf<"approval.resolved">;
}

/** Counted per socket and per generation, with the secret gate's counters and limits. */
function refusePermission(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  reason: PermissionRefusal,
): void {
  if (!isCountedPermissionRefusal(reason)) {
    return;
  }
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.ingest",
    result: "refused",
    errorCategory: `permission_ask_${reason}`,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  const sessionRefused = host.objectCtx.storage.sql
    .exec<{ refused: number }>(
      "INSERT INTO approval_refusal_count (generation, refused) VALUES (?, 1) ON CONFLICT (generation) DO UPDATE SET refused = refused + 1 RETURNING refused",
      session.sandboxGeneration,
    )
    .one().refused;
  const refused = (host.approvalRefusals.get(ws) ?? 0) + 1;
  host.approvalRefusals.set(ws, refused);
  if (refused > MAX_APPROVAL_REFUSALS || sessionRefused > MAX_SESSION_APPROVAL_REFUSALS) {
    ws.close(4001, "approval request refused");
  }
}

/**
 * After a card's answer committed: the bridge is told, and an "Always allow"
 * is saved for the workspace. A failed save is logged and leaves this answer
 * standing; the next ask of the category shows a card again.
 */
export async function settlePermissionAnswer(
  host: SessionHost,
  session: SessionRow,
  answer: {
    readonly approvalId: string;
    readonly category: PermissionCategory;
    readonly decision: "approved" | "rejected";
    readonly scope: ApprovalScope;
  },
  now: string,
): Promise<void> {
  host.tellBridgeOfApproval(
    session,
    answer.approvalId,
    answer.decision === "approved" ? "allowed" : "denied",
  );
  if (answer.decision !== "approved" || answer.scope !== "always") {
    return;
  }
  await saveWorkspaceRule(host.objectEnv.DB, session.workspaceId, answer.category, now).catch(
    () => {
      logSaveFailure(host, session, "permission_rule_not_saved");
    },
  );
}

/**
 * Home's "Allow for this session", chosen before the session existed. It is
 * the owner's choice made with the create request, so the owner and that
 * request's command id are recorded.
 */
export function commitHomeApprovalMode(
  host: SessionHost,
  session: SessionRow,
  body: { readonly commandId: string; readonly issuedAt: string },
): void {
  const changed = buildEvent("approval.mode_changed", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: body.issuedAt,
    payload: {
      mode: "session",
      decidedBy: session.ownerUserId as PayloadOf<"approval.mode_changed">["decidedBy"],
      commandId: body.commandId as PayloadOf<"approval.mode_changed">["commandId"],
    },
  } as never);
  host.commitControlEvents(session, [changed], body.issuedAt, () => {
    writeSessionMode(host.objectCtx.storage.sql, "session");
  });
}

function logSaveFailure(host: SessionHost, session: SessionRow, category: string): void {
  log({
    timestamp: new Date().toISOString(),
    severity: "error",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.approvals",
    result: "failed",
    errorCategory: category,
    sessionId: session.id,
  });
}
