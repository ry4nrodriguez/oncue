// The approval gate (records 04 and 09): judging, admitting, refusing, and
// expiring a sandbox's request for a secret. The harness's own permission
// asks share its one-at-a-time guard and its expiry, and are judged in
// `permission-gate.ts`.

import { type ApprovalOutcome, buildApprovalFrame } from "@oncue/bridge";
import {
  buildEvent,
  type CommittedEvent,
  type PayloadOf,
  type ProtocolEventOf,
} from "@oncue/protocol";
import { log } from "../../log";
import { developmentSecretIsSaved, repositoryConnectionIdFor } from "../../secrets/store";
import {
  type ApprovalExpiry,
  approvalTtlMs,
  cardFor,
  isCountedRefusal,
  judgeClaim,
  judgeRequest,
  planSweep,
  type RequestRefusal,
  settleSavedCheck,
} from "../approvals";
import { MAX_APPROVAL_REFUSALS, MAX_SESSION_APPROVAL_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { admitPermissionAsk, isPermissionAsk } from "./permission-gate";
import { insertEventRow, readNextSessionSequence } from "./store-session";
import type { SessionRow } from "./types";

/**
 * The approval gate's reads, cheapest first, each by a key or the partial
 * index on open approvals, never the event log. The one read that leaves the
 * object (whether a value is saved) runs only for a request that passed the rest.
 */
async function judgeApproval(
  host: SessionHost,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"approval.requested">,
): Promise<
  | { readonly kind: "admit"; readonly name: string }
  | { readonly kind: "refuse"; readonly reason: RequestRefusal }
> {
  // Pure checks first, then two one-row reads that refuse common repeats.
  const claimed = judgeClaim(event.payload);
  if (claimed?.kind === "refuse") {
    return claimed;
  }
  const sql = host.objectCtx.storage.sql;
  const runId = session.currentRunId;
  const open = sql
    .exec<{ found: number }>(
      "SELECT EXISTS(SELECT 1 FROM approval WHERE state = 'requested') AS found",
    )
    .one();
  if (open.found === 1) {
    return { kind: "refuse", reason: "approval_open" };
  }
  const run = sql
    .exec<{ state: string | null }>("SELECT (SELECT state FROM run WHERE id = ?1) AS state", runId)
    .one();
  if (event.runId !== runId || run.state !== "running") {
    return { kind: "refuse", reason: "run_not_running" };
  }
  const counted = sql
    .exec<{ admitted: number }>("SELECT admitted FROM run_approval_count WHERE run_id = ?", runId)
    .toArray()[0];
  const pinned = sql
    .exec<{ name: string; kind: string; selected: number; supplied_generation: number | null }>(
      "SELECT name, kind, selected, supplied_generation FROM session_secret",
    )
    .toArray();
  const denied = sql
    .exec<{ secret_name: string }>(
      "SELECT r.secret_name FROM approval a JOIN approval_request r ON r.approval_id = a.id WHERE a.run_id = ? AND a.state = 'rejected'",
      runId,
    )
    .toArray();
  const judgement = judgeRequest(
    {
      runRunning: event.runId === runId && run.state === "running",
      openApprovalExists: open.found === 1,
      admittedThisRun: counted === undefined ? 0 : counted.admitted,
      declaredOptional: pinned.filter((row) => row.kind === "optional").map((row) => row.name),
      suppliedThisGeneration: pinned
        .filter((row) => row.supplied_generation === session.sandboxGeneration)
        .map((row) => row.name),
      deniedThisRun: denied.map((row) => row.secret_name),
    },
    event.payload,
  );
  if (judgement.kind === "refuse") {
    return judgement;
  }
  const repository = sql
    .exec<{ repository_id: number }>("SELECT repository_id FROM session_repository LIMIT 1")
    .toArray()[0];
  const connectionId =
    repository === undefined
      ? null
      : await repositoryConnectionIdFor(
          host.objectEnv.DB,
          session.workspaceId,
          repository.repository_id,
        );
  const saved =
    connectionId !== null &&
    (await developmentSecretIsSaved(
      host.objectEnv.DB,
      { workspaceId: session.workspaceId, repositoryConnectionId: connectionId },
      judgement.name,
    ));
  return settleSavedCheck(judgement.name, saved);
}

/**
 * Records 04 and 09. The sandbox is trusted for one fact: a tool call waits
 * for the named secret. The object mints the id, sets the expiry by its own
 * clock, and writes every field the card shows, so a click approves only what
 * the card said. The run row moves with the event in one transaction. A refused
 * request is never stored; either way the bridge learns its request's fate by
 * its own reference, so the waiting call ends.
 */
export async function admitApproval(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"approval.requested">,
): Promise<void> {
  const sandboxRef = event.payload.approvalId;
  // The judgement awaits D1, which opens the input gate: a burst would each
  // read "no approval open" and each be admitted. One judgement at a time; a
  // frame meanwhile gets the uncounted refusal an open approval gets.
  if (host.approvalJudging) {
    host.sendApprovalFrame(session, sandboxRef, "refused", null);
    refuseApproval(host, ws, session, "approval_open");
    return;
  }
  host.approvalJudging = true;
  try {
    await admitApprovalJudged(host, ws, session, event);
  } finally {
    host.approvalJudging = false;
  }
}

async function admitApprovalJudged(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"approval.requested">,
): Promise<void> {
  if (isPermissionAsk(event)) {
    await admitPermissionAsk(host, ws, session, event);
    return;
  }
  const sandboxRef = event.payload.approvalId;
  const judgement = await judgeApproval(host, session, event);
  if (judgement.kind === "refuse") {
    host.sendApprovalFrame(session, sandboxRef, "refused", null);
    refuseApproval(host, ws, session, judgement.reason);
    return;
  }
  const now = new Date().toISOString();
  const approvalId = crypto.randomUUID() as typeof event.payload.approvalId;
  const card = cardFor({
    name: judgement.name,
    generation: session.sandboxGeneration,
    now,
    ttlMs: approvalTtlMs(host.objectEnv),
  });
  const runId = session.currentRunId as string;
  // The judgement awaited D1, and the bridge's next frame can commit meanwhile
  // under the session sequence ingest gave this one, failing the UNIQUE index.
  // The sequence is taken now, after every await, inside the transaction.
  let recorded: CommittedEvent & ProtocolEventOf<"approval.requested"> = event;
  let admitted = false;
  host.objectCtx.storage.transactionSync(() => {
    // The run can have ended during the awaits; reread where nothing interleaves.
    const still = host.objectCtx.storage.sql
      .exec<{ running: number }>(
        "SELECT (SELECT state FROM run WHERE id = ?) = 'running' AND NOT EXISTS(SELECT 1 FROM approval WHERE state = 'requested') AS running",
        runId,
      )
      .one();
    if (still.running !== 1) {
      return;
    }
    admitted = true;
    recorded = {
      ...event,
      sessionSequence: readNextSessionSequence(host.objectCtx.storage.sql),
      committedAt: now,
      payload: { ...card, approvalId, toolCallId: event.payload.toolCallId },
    };
    insertEventRow(host.objectCtx.storage.sql, recorded, JSON.stringify(recorded));
    host.objectCtx.storage.sql.exec(
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
    host.objectCtx.storage.sql.exec(
      "INSERT INTO approval_request (approval_id, sandbox_ref, secret_name, delivered_generation) VALUES (?, ?, ?, NULL)",
      approvalId,
      sandboxRef,
      judgement.name,
    );
    host.objectCtx.storage.sql.exec(
      "INSERT INTO run_approval_count (run_id, admitted) VALUES (?,1) ON CONFLICT (run_id) DO UPDATE SET admitted = admitted + 1",
      runId,
    );
    host.objectCtx.storage.sql.exec(
      "UPDATE run SET state = 'waiting_for_approval' WHERE id = ? AND state = 'running'",
      runId,
    );
    host.enqueueOutboxSnapshot(session, now);
  });
  if (!admitted) {
    // Uncounted, like an open approval: the sandbox did nothing wrong.
    host.sendApprovalFrame(session, sandboxRef, "refused", null);
    return;
  }
  host.broadcastToClients(JSON.stringify(recorded));
  host.objectCtx.waitUntil(host.drainOutboxNow());
  host.sendApprovalFrame(session, sandboxRef, "pending", card.expiresAt);
  await host.rearm();
}

/** Counted per socket and per session; an honest repeat is neither counted nor logged. */
function refuseApproval(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  reason: RequestRefusal,
): void {
  if (!isCountedRefusal(reason)) {
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
    errorCategory: `approval_request_${reason}`,
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

export function sendApprovalFrame(
  host: SessionHost,
  session: SessionRow,
  sandboxRef: string,
  outcome: ApprovalOutcome,
  expiresAt: string | null,
): void {
  const bridge = host.currentBridge(session);
  if (bridge === null) {
    return;
  }
  bridge.ws.send(
    JSON.stringify(
      buildApprovalFrame(
        { sessionId: session.id, generation: session.sandboxGeneration },
        sandboxRef,
        outcome,
        expiresAt,
      ),
    ),
  );
}

/** Tells the bridge what became of the request behind an approval, when it asked under this generation. */
export function tellBridgeOfApproval(
  host: SessionHost,
  session: SessionRow,
  approvalId: string,
  outcome: ApprovalOutcome,
): void {
  const row = host.objectCtx.storage.sql
    .exec<{ sandbox_ref: string; requested_generation: number }>(
      "SELECT COALESCE(r.sandbox_ref, p.sandbox_ref) AS sandbox_ref, a.requested_generation FROM approval a LEFT JOIN approval_request r ON r.approval_id = a.id LEFT JOIN permission_request p ON p.approval_id = a.id WHERE a.id = ? AND COALESCE(r.sandbox_ref, p.sandbox_ref) IS NOT NULL",
      approvalId,
    )
    .toArray()[0];
  if (row !== undefined && row.requested_generation === session.sandboxGeneration) {
    host.sendApprovalFrame(session, row.sandbox_ref, outcome, null);
  }
}

/**
 * Silence is not approval, and an approval does not outlive its tool call.
 * One read from the partial index: past its deadline an approval expires and
 * the run goes on without the value; one whose generation ended, or whose run
 * stopped waiting, just ends. Each is a guarded update, so a click that won
 * the race is left alone. Called from the alarm, the stop and loss sequences'
 * revoke step, and anything that can end a wait, so an eviction loses nothing.
 */
export function sweepApprovals(host: SessionHost, endedGeneration: number | null = null): void {
  const session = host.readSession();
  if (session === null) {
    return;
  }
  const open = host.objectCtx.storage.sql
    .exec<{
      id: string;
      run_id: string;
      expires_at: string;
      requested_generation: number;
      run_state: string;
    }>(
      "SELECT a.id, a.run_id, a.expires_at, a.requested_generation, (SELECT state FROM run WHERE id = a.run_id) AS run_state FROM approval a WHERE a.state = 'requested' ORDER BY a.expires_at",
    )
    .toArray()
    .map((row) => ({
      approvalId: row.id,
      runId: row.run_id,
      expiresAtMs: Date.parse(row.expires_at),
      orphaned:
        row.requested_generation !== session.sandboxGeneration ||
        row.requested_generation === endedGeneration ||
        row.run_state !== "waiting_for_approval",
    }));
  closeApprovals(host, session, planSweep(open, Date.now()).expire);
}

/**
 * The sweep read these rows as open and nothing has awaited since, so each
 * update finds its row; the state guard stays in the SQL for any caller.
 */
function closeApprovals(
  host: SessionHost,
  session: SessionRow,
  expiries: readonly ApprovalExpiry[],
): void {
  for (const expiry of expiries) {
    const now = new Date().toISOString();
    host.objectCtx.storage.sql.exec(
      "UPDATE approval SET state = 'expired', expired_effect = ? WHERE id = ? AND state = 'requested'",
      expiry.effect,
      expiry.approvalId,
    );
    const expired = buildEvent("approval.expired", {
      eventId: crypto.randomUUID(),
      sessionId: session.id,
      runId: expiry.runId,
      sandboxGeneration: session.sandboxGeneration,
      runtimeSequence: null,
      occurredAt: now,
      payload: {
        approvalId: expiry.approvalId as PayloadOf<"approval.expired">["approvalId"],
        effect: expiry.effect,
      },
    });
    host.commitControlEvents(session, [expired], now, () => {
      if (expiry.effect === "tool_denied") {
        host.objectCtx.storage.sql.exec(
          "UPDATE run SET state = 'running' WHERE id = ? AND state = 'waiting_for_approval'",
          expiry.runId,
        );
      }
    });
    host.tellBridgeOfApproval(session, expiry.approvalId, "expired");
  }
}
