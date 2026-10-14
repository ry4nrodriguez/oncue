// The per-frame hot path for bridge frames: admission, the gates' dispatch,
// the commit, and what a committed frame means.

import { parseAckFrame } from "@oncue/bridge";
import {
  type CommittedEvent,
  createRedactor,
  PROTOCOL_VERSION,
  type ProtocolEventOf,
} from "@oncue/protocol";
import { log } from "../../log";
import { isRunTerminalEvent, planRunRow, planRuntimeLoss } from "../dispatch";
import { type IngestContext, type IngestRejectReason, ingestFrame } from "../ingest";
import { MAX_REPLAY_ASKS } from "./constants";
import type { SessionHost } from "./host";
import {
  isPublishCommit,
  markTaskBranchPushed,
  publishIsOpen,
  readRepositoryBase,
  settlePublish,
} from "./store-git";
import { clearProbe } from "./store-lifecycle";
import {
  advanceRuntimeCursor,
  applyRunRow,
  eventIdKnown,
  insertEventRow,
  readNextSessionSequence,
  readPolicy,
  readRunState,
  recordVerification,
} from "./store-session";
import { admitAgentEvent, admitAgentTagged, isAgentEvent, isAgentTagged } from "./subagent-gate";
import type { BridgeAttachment, SessionRow } from "./types";
import { type BridgeControlFrame, parseBridgeControlFrame } from "./wire";

export async function handleBridgeFrame(
  host: SessionHost,
  ws: WebSocket,
  raw: string,
): Promise<void> {
  const session = host.readSession();
  if (session === null) {
    return;
  }
  const generation = session.sandboxGeneration;
  const control = parseBridgeControlFrame(raw);
  if (control !== null) {
    await handleBridgeControlFrame(host, ws, session, generation, control);
    return;
  }
  // A receipt for something this object sent; `ingestFrame` would reject it.
  const ack = parseAckFrame({ sessionId: session.id, generation }, raw);
  if (ack !== null) {
    await host.dispatch({
      kind: "ack",
      frame: ack,
      now: new Date().toISOString(),
      eventId: crypto.randomUUID(),
    });
    return;
  }
  const redactorReady = host.ensureRedactor(session);
  if (redactorReady !== true && !(await redactorReady)) {
    // Nothing from a sandbox that holds a secret is stored unredacted.
    ws.close(1011, "redactor_unavailable");
    return;
  }
  const context: IngestContext = {
    sessionId: session.id,
    sandboxGeneration: generation,
    lastRuntimeSequence: session.lastRuntimeSequence,
    protocolVersion: PROTOCOL_VERSION,
    knownEventIds: { has: (eventId) => eventIdKnown(host.objectCtx.storage.sql, eventId) },
    redactor: createRedactor(host.pendingRedactionSecrets),
    nextSessionSequence: readNextSessionSequence(host.objectCtx.storage.sql),
    committedAt: new Date().toISOString(),
  };
  const outcome = ingestFrame(raw, context);
  if (outcome.kind === "reject") {
    handleIngestRejection(host, ws, session, generation, outcome.reason);
    return;
  }
  // The bridge is in step again, so the next gap starts its own count.
  host.replayAsks.delete(ws);
  // Ephemeral frames occupy a sequence slot too (`IngestContext.lastRuntimeSequence`),
  // so the cursor advances whether or not the frame is stored; otherwise every
  // `message.delta` after the first would look like a gap.
  advanceRuntimeCursor(host.objectCtx.storage.sql, session, outcome.event.runtimeSequence);
  if (outcome.kind === "live") {
    host.broadcastToClients(outcome.envelopeJson);
    return;
  }
  // Record 14's gate. The frame already took its sequence slot, so a refused
  // claim is never asked for again; it is just never stored.
  if (outcome.event.type === "run.verified") {
    const judgement = host.judgeVerified(session, outcome.event);
    if (judgement.kind === "refuse") {
      await host.refuseVerified(
        ws,
        session,
        outcome.event as CommittedEvent & ProtocolEventOf<"run.verified">,
        judgement.reasons,
      );
      return;
    }
  }
  if (
    (outcome.event.type === "git.push.completed" || outcome.event.type === "git.push.failed") &&
    !publishIsOpen(
      host.objectCtx.storage.sql,
      (outcome.event as ProtocolEventOf<"git.push.completed" | "git.push.failed">).payload.pushId,
    ) &&
    !host.isSecretWithholding(session, outcome.event)
  ) {
    // A push is the server's decision: a report for a push it never asked for,
    // or already heard about, is never stored.
    host.refuseProposal(ws, session, "unrequested_push");
    return;
  }
  if (outcome.event.type === "approval.requested") {
    await host.admitApproval(
      ws,
      session,
      outcome.event as CommittedEvent & ProtocolEventOf<"approval.requested">,
    );
    return;
  }
  if (outcome.event.type === "question.asked") {
    host.admitQuestion(
      ws,
      session,
      outcome.event as CommittedEvent & ProtocolEventOf<"question.asked">,
    );
    return;
  }
  if (outcome.event.type === "pull_request.described") {
    host.admitDescription(
      ws,
      session,
      outcome.event as CommittedEvent & ProtocolEventOf<"pull_request.described">,
      outcome.envelopeJson,
    );
    return;
  }
  if (
    outcome.event.type === "git.committed" &&
    !isPublishCommit(host.objectCtx.storage.sql, outcome.event)
  ) {
    host.admitCommit(
      ws,
      session,
      outcome.event as CommittedEvent & ProtocolEventOf<"git.committed">,
      outcome.envelopeJson,
    );
    return;
  }
  if (isAgentEvent(outcome.event)) {
    admitAgentEvent(host, ws, session, outcome.event, outcome.envelopeJson);
    return;
  }
  if (outcome.event.type === "policy.proposed") {
    await host.admitProposal(
      ws,
      session,
      outcome.event as CommittedEvent & ProtocolEventOf<"policy.proposed">,
    );
    return;
  }
  // A subagent's own message or call is stored only for a subagent the object
  // admitted; any other would sit off the timeline under a subagent nobody saw start.
  if (isAgentTagged(outcome.event) && !admitAgentTagged(host, ws, session, outcome.event)) {
    return;
  }
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(host.objectCtx.storage.sql, outcome.event, outcome.envelopeJson);
    // The run row moves with the event in the same transaction, so the dispatch
    // below and later commands read the state the timeline shows.
    applyRunRow(
      host.objectCtx.storage.sql,
      planRunRow(outcome.event, session.currentRunId),
      outcome.event.occurredAt,
    );
    recordVerification(host.objectCtx.storage.sql, outcome.event);
    host.enqueueOutboxSnapshot(session, new Date().toISOString());
  });
  host.broadcastToClients(outcome.envelopeJson);
  host.objectCtx.waitUntil(host.drainOutboxNow());
  if (outcome.event.type.startsWith("run.")) {
    // A run that ended or paused while it waited takes its approval with it,
    // and its question too: the bridge's pause aborted the harness's call.
    host.sweepApprovals();
    host.sweepQuestions(outcome.event.type === "run.paused" ? "bridge_paused" : null);
  }
  await host.reactToCommittedFrame(outcome.event);
}

/**
 * What a committed sandbox event means for what the bridge is owed:
 * `runtime.ready` releases queued commands, `repository.status` ends the git
 * token's job, a run's terminal releases the next held message, and a bridge
 * giving up (`expectReconnect` false) ends the run per `planRuntimeLoss`.
 */
export async function reactToCommittedFrame(
  host: SessionHost,
  event: CommittedEvent,
): Promise<void> {
  // The commit above may have moved the cursor; every reaction reads fresh.
  const session = host.readSession() as SessionRow;
  const now = new Date().toISOString();
  if (event.type === "runtime.ready") {
    host.moveAttachment(session.sandboxGeneration, "active");
    host.sendPolicyToBridge(session, readPolicy(host.objectCtx.storage.sql).policy);
    // Ahead of the queued commands on the same socket, so the secret files are
    // requested before the run's first prompt.
    await host.requestLaunchSecrets(now);
    await host.dispatch({ kind: "runtime_ready", now });
    return;
  }
  if (event.type === "repository.checkpointed") {
    const payload = (event as ProtocolEventOf<"repository.checkpointed">).payload;
    host.markPushGrantsSpent();
    host.objectCtx.storage.sql.exec(
      "INSERT OR IGNORE INTO checkpoint (id, run_id, kind, head_sha, reason, created_at) VALUES (?,?,?,?,?,?)",
      payload.checkpointId,
      event.runId,
      payload.kind,
      payload.headSha,
      payload.reason,
      now,
    );
    if (
      payload.kind === "branch_push" &&
      payload.headSha !== null &&
      payload.headSha !== readRepositoryBase(host.objectCtx.storage.sql)?.baseSha
    ) {
      markTaskBranchPushed(host.objectCtx.storage.sql);
    }
    await host.finishPublish(session, payload.kind);
    return;
  }
  if (event.type === "git.push.completed" || event.type === "git.push.failed") {
    const payload = (event as ProtocolEventOf<"git.push.completed" | "git.push.failed">).payload;
    settlePublish(
      host.objectCtx.storage.sql,
      payload.pushId,
      event.type === "git.push.completed" ? "pushed" : "failed",
      payload.headSha,
    );
    return;
  }
  if (event.type === "sandbox.checkpointed") {
    const payload = (event as ProtocolEventOf<"sandbox.checkpointed">).payload;
    await host.signalStop({
      kind: "checkpointed",
      checkpoint: {
        checkpointId: payload.checkpointId,
        kind: payload.kind,
        headSha: payload.headSha,
      },
    });
    return;
  }
  if (event.type === "sandbox.checkpoint_failed") {
    // The bridge could not take the checkpoint, so nothing was pushed or bundled,
    // and it revoked any push grant it held. A waiting publish fails now and a
    // stop moves on with the reason instead of waiting out its deadline; a late
    // or unprompted report changes nothing.
    host.markPushGrantsSpent();
    await host.finishPublish(session, "local_commit");
    await host.signalStop({
      kind: "checkpoint_failed",
      failure: (event as ProtocolEventOf<"sandbox.checkpoint_failed">).payload.failure,
    });
    return;
  }
  if (event.type === "artifact.uploading") {
    await host.authorizeUpload(
      session,
      event as CommittedEvent & ProtocolEventOf<"artifact.uploading">,
    );
    return;
  }
  if (event.type === "repository.status") {
    host.gitGrantDeadlineMs = null;
    await host.dispatch({ kind: "repository_status" });
    return;
  }
  if (event.type === "runtime.disconnected") {
    const payload = (event as ProtocolEventOf<"runtime.disconnected">).payload;
    if (!payload.expectReconnect) {
      await handleRuntimeLoss(host, session, payload.reason, payload.detail);
    }
    return;
  }
  const runId = session.currentRunId;
  if (runId !== null && isRunTerminalEvent(event.type) && event.runId === runId) {
    await host.dispatch({
      kind: "run_terminal",
      runId,
      now,
      mintedRunId: crypto.randomUUID(),
      mintedCommandId: crypto.randomUUID(),
      mintedGrantId: crypto.randomUUID(),
    });
    // After the dispatch: a held message it released is a new run, whose end
    // publishes the work instead.
    await host.maybePublish();
  }
}

async function handleRuntimeLoss(
  host: SessionHost,
  session: SessionRow,
  category: string,
  detail: string,
): Promise<void> {
  const runId = session.currentRunId as string;
  switch (planRuntimeLoss(readRunState(host.objectCtx.storage.sql, runId))) {
    case "fail_provisioning":
      host.failProvisioning(
        { ...session, currentRunId: runId },
        { kind: "error", category: "unknown", message: detail, retryable: false },
        Date.now(),
      );
      return;
    case "fail_execution":
      host.failRun(session, runId, "execution", category, detail);
      return;
    case "nothing":
      return;
  }
}

/**
 * `hello` gets `welcome` with this object's `PROTOCOL_VERSION` and the
 * accepted generation; the bridge checks both, so a mismatched bridge refuses
 * itself rather than having every frame rejected. The socket is then marked
 * negotiated, making it the current bridge, and everything the generation is
 * owed is (re)sent: the grants, and the commands once the runtime is ready.
 * `heartbeat` needs no reply.
 */
async function handleBridgeControlFrame(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  generation: number,
  control: BridgeControlFrame,
): Promise<void> {
  if (control.kind === "heartbeat") {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "bridge.welcome",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.id,
      sandboxGeneration: generation,
    }),
  );
  // A socket this object accepted always has an attachment; one a test
  // accepted raw does not, and is never sent anything.
  const attachment = ws.deserializeAttachment() as BridgeAttachment | null;
  if (attachment !== null) {
    const negotiated: BridgeAttachment = { ...attachment, negotiated: true };
    ws.serializeAttachment(negotiated);
  }
  clearProbe(host.objectCtx.storage.sql, generation);
  await host.dispatch({
    kind: "bridge_connected",
    now: new Date().toISOString(),
    mintedGrantIds: [crypto.randomUUID(), crypto.randomUUID()],
    newEventId: () => crypto.randomUUID(),
  });
  host.resendQuestionDecision(session);
}

function handleIngestRejection(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  generation: number,
  reason: IngestRejectReason,
): void {
  if (reason.kind === "stale_generation") {
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.ingest",
      result: "rejected",
      errorCategory: reason.kind,
      sandboxGeneration: String(generation),
      sessionId: session.id,
    });
    ws.close(4000, "stale generation");
    return;
  }
  if (reason.kind === "sequence_gap") {
    // A bridge whose ring lost the missing frame answers with the frames it has,
    // which start at the gap again, so an unbounded ask loops forever and once
    // exhausted the account's Durable Object reads. The sandbox is untrusted, so
    // the bound lives here, not only in the bridge.
    const asked = (host.replayAsks.get(ws) ?? 0) + 1;
    if (asked > MAX_REPLAY_ASKS) {
      log({
        timestamp: new Date().toISOString(),
        severity: "warn",
        service: "session-object",
        release: host.objectEnv.ONCUE_RELEASE,
        environment: host.objectEnv.ONCUE_ENV,
        operation: "session.ingest",
        result: "refused",
        errorCategory: "replay_unavailable",
        sandboxGeneration: String(generation),
        sessionId: session.id,
      });
      ws.close(4001, "replay unavailable");
      return;
    }
    host.replayAsks.set(ws, asked);
    ws.send(JSON.stringify({ type: "replay_from", runtimeSequence: reason.expected }));
    return;
  }
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.ingest",
    result: "rejected",
    errorCategory: reason.kind,
    sandboxGeneration: String(generation),
    sessionId: session.id,
  });
}
