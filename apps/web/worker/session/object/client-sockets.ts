// Client sockets: the upgrade with its replay, and each command a client sends.

import type { ProtocolCommand, ProtocolEventOf } from "@oncue/protocol";
import { claimAttachments } from "../../attachments/store";
import { safeJsonParse } from "../../json";
import { commandAttachments, withAttachments } from "../attachment-access";
import { chargedRunId } from "../dispatch";
import { planCompute } from "../lifecycle";
import type { ModelChangeDecision } from "../model-change";
import { answerResumes } from "../questions";
import { DEFAULT_REPLAY_LIMITS, planReplay } from "../replay";
import type { SessionHost } from "./host";
import {
  decideRunModel,
  moveChangedRunToNewSandbox,
  placeChangedRun,
  supersedeRun,
  withModel,
} from "./model-change";
import { readPermissionCategory, settlePermissionAnswer } from "./permission-gate";
import {
  commandAlreadyProcessed,
  isTombstoned,
  readEventsAfter,
  readPolicy,
  readRunModel,
  readRunState,
} from "./store-session";
import type { SessionRow } from "./types";
import { parseIncomingCommand } from "./wire";

export function handleClientUpgrade(host: SessionHost, url: URL, userId: string | null): Response {
  const session = host.readSession();
  // A deleted or deleting session is closed to every reader, whatever D1 says yet.
  if (
    userId === null ||
    session === null ||
    userId !== session.ownerUserId ||
    isTombstoned(host.objectCtx.storage.sql)
  ) {
    return refuseClientUpgrade();
  }
  const afterParam = url.searchParams.get("after");
  const parsedAfter = afterParam === null ? 0 : Number(afterParam);
  const after = Number.isNaN(parsedAfter) ? 0 : parsedAfter;
  const pair = new WebSocketPair();
  const server = pair[0];
  const client = pair[1];
  host.objectCtx.acceptWebSocket(server, ["client"]);
  server.serializeAttachment(userId);
  const rows = readEventsAfter(host.objectCtx.storage.sql, after);
  const frames = planReplay(rows, DEFAULT_REPLAY_LIMITS, after);
  for (const frame of frames) {
    server.send(frame.json);
  }
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Accept then close, as `routes/ws.ts` does: a bare non-101 reaches the
 * browser as an opaque 1006. Reachable only if the Worker's check let a
 * mismatched or missing identity, or a session being deleted, through.
 */
function refuseClientUpgrade(): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  const client = pair[1];
  server.accept();
  server.close(4403, "forbidden");
  return new Response(null, { status: 101, webSocket: client });
}

export async function handleClientFrame(
  host: SessionHost,
  ws: WebSocket,
  raw: string,
): Promise<void> {
  const parsed = safeJsonParse<{ type?: unknown; command?: unknown }>(raw);
  if (!parsed.ok) {
    return;
  }
  if (parsed.value.type !== "command") {
    return;
  }
  const session = host.readSession();
  if (session === null) {
    return;
  }
  const issuedByUserId = ws.deserializeAttachment() as unknown;
  if (typeof issuedByUserId !== "string") {
    return;
  }
  const incoming = parseIncomingCommand(parsed.value.command, session.id, issuedByUserId);
  if (incoming === null) {
    return;
  }
  const now = new Date().toISOString();
  const claim = await claimCommandAttachments(host, session, incoming, now);
  // A `run.start` naming another model than the session's latest run is a
  // model change (record 15): the object checks it and stores its own record
  // of the model, never the browser's.
  const modelChange: ModelChangeDecision =
    claim.command.type === "run.start"
      ? await decideRunModel(host, session, claim.command)
      : { kind: "same" };
  const command =
    claim.command.type === "run.start" && modelChange.kind === "changed"
      ? withModel(claim.command, modelChange.model)
      : claim.command;
  const mintedRunId = crypto.randomUUID();
  // The composer starts the next run over this socket, so a run.start is
  // admitted as `createSession` admits the first; other commands act on an
  // already admitted session.
  const admission =
    command.type === "run.start" ? await host.decideAdmissionNow() : { kind: "admit" as const };
  if (
    modelChange.kind === "changed" &&
    modelChange.supersedesRunId !== null &&
    // Only a start nothing else refuses ends the run it replaces, and never
    // a resend of a start already answered.
    !commandAlreadyProcessed(host.objectCtx.storage.sql, command.commandId) &&
    admission.kind === "admit" &&
    claim.refusal === null &&
    command.issuedByUserId === session.ownerUserId &&
    host.readSession()?.state === "active"
  ) {
    await supersedeRun(host, session, modelChange.supersedesRunId);
  }
  const plan = host.planAndCommit(
    session,
    command,
    admission,
    now,
    mintedRunId,
    null,
    null,
    await resumeConnectionActive(host, session, command),
    claim.refusal,
    modelChange.kind === "same" ? null : modelChange,
  );
  if (plan.kind !== "accept") {
    return;
  }
  // Drain now, as every other commit path does; otherwise a decision on a card
  // could sit unprojected while the session is quiet and "Needs you" would stay.
  host.objectCtx.waitUntil(host.drainOutboxNow());
  if (command.type === "policy.set") {
    // The name the card asked for, kept until the first push names the branch.
    if (command.payload.action !== "decline" && typeof command.payload.branchName === "string") {
      host.objectCtx.storage.sql.exec(
        "UPDATE session_branch SET requested_name = ? WHERE id = 1",
        command.payload.branchName,
      );
    }
    // Handled entirely here: the bridge is told the policy, not the command.
    host.sendPolicyToBridge(session, readPolicy(host.objectCtx.storage.sql).policy);
    // The click that allows a push publishes the run it was asked about.
    await host.maybePublish();
    return;
  }
  if (command.type === "approval.mode") {
    // The session's half committed with the event. The browser saves the
    // workspace's half through `/api/approval-settings`, whose answer is what
    // is in force, so the menu never shows a mode that is not.
    return;
  }
  if (command.type === "question.resolve") {
    // Handled here: the bridge is told, or a stopped run resumes with the answers.
    await host.deliverQuestionDecision(command.payload.questionId, command.commandId, now);
    await host.rearm();
    return;
  }
  // A message sent while a question waited dismissed it; the waiting harness
  // hears so before the message reaches it.
  const dismissed = plan.events.find((event) => event.type === "question.dismissed");
  if (dismissed !== undefined) {
    await host.deliverQuestionDecision(
      (dismissed as ProtocolEventOf<"question.dismissed">).payload.questionId,
      command.commandId,
      now,
    );
  }
  if (command.type === "approval.resolve") {
    // Handled here too. For a secret, a denial is a word to the bridge and an
    // approval never is: the bridge learns of it only as a grant carrying the
    // value. A harness permission ask is answered by word either way, since
    // the harness's gate is cooperative (record 09). Read again because the
    // row above predates this handler's awaits.
    const current = host.readSession() as SessionRow;
    const category = readPermissionCategory(host.objectCtx.storage.sql, command.payload.approvalId);
    if (category !== null) {
      await settlePermissionAnswer(
        host,
        current,
        {
          approvalId: command.payload.approvalId,
          category,
          decision: command.payload.decision,
          scope: command.payload.scope ?? "once",
        },
        now,
      );
      await host.rearm();
      return;
    }
    if (command.payload.decision === "approved") {
      await host.requestApprovedSecret(current, command.payload.approvalId, now);
    } else {
      host.tellBridgeOfApproval(current, command.payload.approvalId, "denied");
    }
    await host.rearm();
    return;
  }
  if (modelChange.kind === "changed") {
    const current = host.readSession() as SessionRow;
    const place = placeChangedRun(host, current);
    if (place === "new_sandbox") {
      // The harness in this sandbox cannot take the model.
      await moveChangedRunToNewSandbox(host, current);
    }
    if (place !== "dispatch") {
      // The run waits for the stop, whose last step starts it on a new generation.
      return;
    }
  }
  if (await host.resumeFor(command, mintedRunId)) {
    return;
  }
  await host.dispatch({
    kind: "command_admitted",
    command,
    now,
    runId: chargedRunId(command, mintedRunId),
    // For the model grant a run on another model or effort than the
    // generation's needs before its start.
    ...(command.type === "run.start" ? { mintedGrantId: crypto.randomUUID() } : {}),
  });
  // The object's `run.cancelled` is the run's terminal event, and the bridge is
  // told to cancel before the next held message is released.
  if (command.type === "run.cancel") {
    host.sweepApprovals();
    host.sweepQuestions();
    await host.dispatch({
      kind: "run_terminal",
      // Run-scoped by the catalog: a cancel always names its run.
      runId: command.runId as string,
      now,
      mintedRunId: crypto.randomUUID(),
      mintedCommandId: crypto.randomUUID(),
      mintedGrantId: crypto.randomUUID(),
    });
  }
}

/**
 * Whether a command that would start a new generation names a model
 * connection that is still active. Resuming on a broken key would spend a
 * sandbox's idle window of the user's Modal credit on a run the broker
 * refuses, so a `run.start` with no sandbox, or a Continue or a question's
 * answer that would resume a stopped run with none, is refused up front.
 * Other commands answer true without reading D1.
 */
async function resumeConnectionActive(
  host: SessionHost,
  session: SessionRow,
  command: ProtocolCommand,
): Promise<boolean> {
  const resumesRun =
    ((command.type === "run.follow_up" && command.payload.delivery === "steer_current_run") ||
      (command.type === "question.resolve" && command.payload.action === "answer")) &&
    answerResumes(readRunState(host.objectCtx.storage.sql, command.runId as string));
  if (
    (command.type !== "run.start" && !resumesRun) ||
    planCompute(host.lifecycleView(session, Date.now())).kind === "attached"
  ) {
    return true;
  }
  const connectionId =
    command.type === "run.start"
      ? command.payload.model.modelConnectionId
      : readRunModel(host.objectCtx.storage.sql, command.runId as string).modelConnectionId;
  const row = await host.objectEnv.DB.prepare(
    "SELECT status FROM model_connection WHERE connection_id = ? AND workspace_id = ?",
  )
    .bind(connectionId, session.workspaceId)
    .first<{ status: string }>();
  return row !== null && row.status === "active";
}

/**
 * Claims the message's uploads for this session in D1 and puts them in the
 * command in the control plane's words, before planning. A non-owner claims
 * nothing (refused as `not_owner` anyway), and a command with no attachment
 * reads no D1. A refusal goes to the planner as `command.rejected`.
 */
async function claimCommandAttachments(
  host: SessionHost,
  session: SessionRow,
  command: ProtocolCommand,
  now: string,
): Promise<{ readonly command: ProtocolCommand; readonly refusal: string | null }> {
  const named = commandAttachments(command);
  if (named.length === 0 || command.issuedByUserId !== session.ownerUserId) {
    return { command, refusal: null };
  }
  const claimed = await claimAttachments(host.objectEnv.DB, {
    workspaceId: session.workspaceId,
    sessionId: session.id,
    attachmentIds: named.map((ref) => ref.artifactId),
    now,
  });
  return claimed.kind === "claimed"
    ? { command: withAttachments(command, claimed.refs), refusal: null }
    : { command, refusal: claimed.detail };
}
