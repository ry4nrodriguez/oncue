// The Git policy (records 07 and 09): proposals, the agent's description and
// commits, and every change to the policy in force.

import { buildPolicyFrame } from "@oncue/bridge";
import {
  buildEvent,
  type CommittedEvent,
  type PayloadOf,
  type ProtocolEventOf,
} from "@oncue/protocol";
import { log } from "../../log";
import {
  decideProposal,
  type ProposalDecision,
  type ProposalRefusal,
  type SessionPolicy,
} from "../../policy/git-policy";
import {
  type CommitRefusal,
  type DescriptionRefusal,
  decideCommit,
  decideDescription,
  LIVE_RUN_STATES,
  mergeDescription,
} from "../pr-description";
import { MAX_PROPOSAL_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { insertEventRow, readDescription, readPolicy, writePolicy } from "./store-session";
import type { SessionRow } from "./types";

/** The proposal gate's reads: the policy row, the run row, one message row, and one count, each by key. */
function judgeProposal(
  host: SessionHost,
  stored: SessionPolicy,
  runId: string | null,
  event: CommittedEvent & ProtocolEventOf<"policy.proposed">,
): ProposalDecision {
  const sql = host.objectCtx.storage.sql;
  // One row always: a null or unknown run id reads as a run in no state.
  const run = sql
    .exec<{ state: string | null; instruction_message_id: string | null }>(
      "SELECT (SELECT state FROM run WHERE id = ?1) AS state, (SELECT instruction_message_id FROM run WHERE id = ?1) AS instruction_message_id",
      runId,
    )
    .one();
  const messageId = event.payload.triggeringMessageId;
  const messageIsUsers =
    messageId !== null &&
    (run.instruction_message_id === messageId ||
      sql
        .exec<{ found: number }>(
          "SELECT EXISTS(SELECT 1 FROM run_message WHERE message_id = ? AND run_id = ?) AS found",
          messageId,
          runId,
        )
        .one().found === 1);
  const counted = sql
    .exec<{ admitted: number }>("SELECT admitted FROM run_proposal_count WHERE run_id = ?", runId)
    .toArray()[0];
  return decideProposal(
    {
      stored,
      runRunning: run.state === "running",
      messageIsUsers,
      admittedThisRun: counted === undefined ? 0 : counted.admitted,
    },
    event.payload,
  );
}

/**
 * Records 07 and 09. A proposal is the sandbox's word, so it is stored with
 * `from`, `to`, and `direction` as the object computed them, under an id the
 * object minted. A narrowing applies before this returns; a widening or mixed
 * one becomes the single open proposal and waits for the user's click. A
 * refused one is never stored.
 */
export async function admitProposal(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"policy.proposed">,
): Promise<void> {
  const { policy: stored } = readPolicy(host.objectCtx.storage.sql);
  // `policy.proposed` names no run: it is judged against the session's current one.
  const decision = judgeProposal(host, stored, session.currentRunId, event);
  if (decision.kind === "refuse") {
    host.refuseProposal(ws, session, decision.reason);
    return;
  }
  // A card's Confirm names a proposal by id; a sandbox-chosen id could be
  // reused to swap what a shown card confirms, so the object mints it.
  const proposalId = crypto.randomUUID() as typeof event.payload.proposalId;
  const recorded = {
    ...event,
    payload: {
      ...event.payload,
      proposalId,
      from: stored,
      to: decision.to,
      direction: decision.kind === "hold" ? decision.direction : ("narrowing" as const),
    },
  };
  const now = new Date().toISOString();
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(host.objectCtx.storage.sql, recorded, JSON.stringify(recorded));
    host.objectCtx.storage.sql.exec(
      "INSERT INTO run_proposal_count (run_id, admitted) VALUES (?,1) ON CONFLICT (run_id) DO UPDATE SET admitted = admitted + 1",
      session.currentRunId,
    );
    if (decision.kind === "hold") {
      writePolicy(host.objectCtx.storage.sql, stored, {
        proposalId,
        baseVersion: stored.version,
        to: decision.to,
      });
    }
    host.enqueueOutboxSnapshot(session, now);
  });
  host.broadcastToClients(JSON.stringify(recorded));
  host.objectCtx.waitUntil(host.drainOutboxNow());
  if (decision.kind === "apply_now") {
    host.commitPolicyUpdate(session, stored, decision.to, {
      proposalId,
      confirmedBy: "immediate_narrowing",
      userId: null,
    });
  }
}

/**
 * Record 07. The agent's words for its pull request and branch: text, not
 * authority, so nothing asks the user. Each admitted frame is a stored row,
 * so it must name the running current run, and at most
 * `MAX_DESCRIPTIONS_PER_RUN` are admitted per run. Two keyed reads; a refusal
 * is never stored and counts against the socket.
 */
export function admitDescription(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"pull_request.described">,
  envelopeJson: string,
): void {
  const sql = host.objectCtx.storage.sql;
  const runId = session.currentRunId;
  const run = sql
    .exec<{ state: string | null }>("SELECT (SELECT state FROM run WHERE id = ?1) AS state", runId)
    .one();
  const counted = sql
    .exec<{ admitted: number }>(
      "SELECT admitted FROM run_description_count WHERE run_id = ?",
      runId,
    )
    .toArray()[0];
  const decision = decideDescription({
    runRunning: event.runId === runId && LIVE_RUN_STATES.has(String(run.state)),
    admittedThisRun: counted === undefined ? 0 : counted.admitted,
  });
  if (decision.kind === "refuse") {
    host.refuseProposal(ws, session, decision.reason);
    return;
  }
  const merged = mergeDescription(readDescription(host.objectCtx.storage.sql), event.payload);
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(host.objectCtx.storage.sql, event, envelopeJson);
    sql.exec(
      "INSERT INTO run_description_count (run_id, admitted) VALUES (?,1) ON CONFLICT (run_id) DO UPDATE SET admitted = admitted + 1",
      runId,
    );
    sql.exec(
      "INSERT OR REPLACE INTO pull_request_description (id, title, body, branch_name, version, applied_version) VALUES (1,?,?,?,?,?)",
      merged.title,
      merged.body,
      merged.branchName,
      merged.version,
      merged.appliedVersion,
    );
  });
  host.broadcastToClients(envelopeJson);
}

/**
 * Record 07. The agent's `git_commit` report: text and a tree, no authority,
 * nothing pushed. Stored only while the named run is live and at most
 * `MAX_COMMITS_PER_RUN` per run, on two keyed reads; a refusal is never stored
 * and counts against the socket.
 */
export function admitCommit(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"git.committed">,
  envelopeJson: string,
): void {
  const sql = host.objectCtx.storage.sql;
  const runId = session.currentRunId;
  const run = sql
    .exec<{ state: string | null }>("SELECT (SELECT state FROM run WHERE id = ?1) AS state", runId)
    .one();
  const counted = sql
    .exec<{ admitted: number }>("SELECT admitted FROM run_commit_count WHERE run_id = ?", runId)
    .toArray()[0];
  const decision = decideCommit({
    runRunning: event.runId === runId && LIVE_RUN_STATES.has(String(run.state)),
    admittedThisRun: counted === undefined ? 0 : counted.admitted,
  });
  if (decision.kind === "refuse") {
    host.refuseProposal(ws, session, decision.reason);
    return;
  }
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(host.objectCtx.storage.sql, event, envelopeJson);
    sql.exec(
      "INSERT INTO run_commit_count (run_id, admitted) VALUES (?,1) ON CONFLICT (run_id) DO UPDATE SET admitted = admitted + 1",
      runId,
    );
  });
  host.broadcastToClients(envelopeJson);
}

/** The one place the policy in force changes. Any open proposal is dropped: it was made against the old version. */
export function commitPolicyUpdate(
  host: SessionHost,
  session: SessionRow,
  from: SessionPolicy,
  to: SessionPolicy,
  by: Pick<PayloadOf<"policy.updated">, "proposalId" | "confirmedBy" | "userId">,
): void {
  const now = new Date().toISOString();
  const updated = buildEvent("policy.updated", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: { ...by, from, to, effectiveAt: now },
  });
  host.commitControlEvents(session, [updated], now, () => {
    writePolicy(host.objectCtx.storage.sql, to, null);
  });
  host.sendPolicyToBridge(session, to);
}

/**
 * Tells the bridge the policy in force, so its next proposal names the right
 * version. Sent at runtime ready and on every change, never in answer to a
 * frame and never acknowledged, so it cannot loop. A bridge that misses one is
 * refused for a stale version.
 */
export function sendPolicyToBridge(
  host: SessionHost,
  session: SessionRow,
  policy: SessionPolicy,
): void {
  const bridge = host.currentBridge(session);
  if (bridge === null) {
    return;
  }
  bridge.ws.send(
    JSON.stringify(
      buildPolicyFrame({ sessionId: session.id, generation: session.sandboxGeneration }, policy),
    ),
  );
}

/**
 * Refused `policy.proposed` and `git.push.*` frames share one count per
 * socket: both claim authority. A refused `pull_request.described` counts too,
 * so the sandbox cannot repeat it into the log without bound.
 */
export function refuseProposal(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  reason: ProposalRefusal | DescriptionRefusal | CommitRefusal | "unrequested_push",
): void {
  if (reason === "no_change") {
    // Proposing what is already so wastes a call but claims nothing, and a long
    // session can do it honestly. Uncounted, so unlogged too, or the sandbox
    // could fill the log.
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
    errorCategory:
      reason === "unrequested_push" ||
      reason === "description_run_not_running" ||
      reason === "too_many_descriptions" ||
      reason === "commit_run_not_running" ||
      reason === "too_many_commits"
        ? reason
        : `policy_proposal_${reason}`,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  const refused = (host.proposalRefusals.get(ws) ?? 0) + 1;
  host.proposalRefusals.set(ws, refused);
  if (refused > MAX_PROPOSAL_REFUSALS) {
    ws.close(4001, "proposal refused");
  }
}
