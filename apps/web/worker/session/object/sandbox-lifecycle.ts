// Record 11's lifecycle facts, the alarm's lifecycle and probe steps, a lost
// generation, and the one alarm's rearm.

import { buildEvent, type ProtocolEvent, type SandboxState } from "@oncue/protocol";
import { log } from "../../log";
import type { ModalCredential } from "../../modal/client";
import { openModalCredential } from "../../modal/connections";
import { cachedCredentialKeyring } from "../../routes/credential-keyring";
import type { SandboxDriver } from "../../sandbox/driver";
import { selectSandboxDriver } from "../../sandbox/select";
import {
  type AttachmentFact,
  beginStop,
  earliest,
  type LifecycleView,
  lifecycleDeadline,
  lifecycleSettings,
  type ProbeAnswer,
  planAlarm,
  planKeepAlive,
  planLoss,
  planProbeAnswer,
  provisioningUnsettled,
  sandboxPath,
} from "../lifecycle";
import { LIVE_OR_STARTING_STATUS } from "./constants";
import { newEventId } from "./credentials";
import type { SessionHost } from "./host";
import { readLastCheckpoint, readRepositoryBase } from "./store-git";
import {
  applyLifecycleRunEvent,
  clearProbe,
  readAttachment,
  readKeepAliveUntilMs,
  readLastActivityMs,
  readLateStopDueMs,
  readProbe,
  readRejectedKeyPause,
  readStopRow,
  writeProbe,
} from "./store-lifecycle";
import { readApprovalDeadlineMs, readQuestionOpen, readRunState } from "./store-session";
import { orphanedAgentEnds } from "./subagent-gate";
import type { KeepAliveResult, SessionRow } from "./types";

/** Every fact `lifecycle.ts` decides from, read fresh for the current generation. */
export function lifecycleView(
  host: SessionHost,
  session: SessionRow,
  nowMs: number,
): LifecycleView {
  const generation = session.sandboxGeneration;
  const stop = readStopRow(host.objectCtx.storage.sql, generation);
  const attachment = readAttachment(host.objectCtx.storage.sql, generation);
  const runId = session.currentRunId;
  const runState = runId === null ? null : readRunState(host.objectCtx.storage.sql, runId);
  return {
    nowMs,
    sessionId: session.id,
    generation,
    attachment,
    currentRunId: runId,
    runState,
    interruptedRunState:
      stop === null || stop.interruptedRunId === null
        ? null
        : readRunState(host.objectCtx.storage.sql, stop.interruptedRunId),
    lastActivityMs: readLastActivityMs(host.objectCtx.storage.sql, generation),
    questionOpen: readQuestionOpen(host.objectCtx.storage.sql, runId, generation),
    // Read only for a paused run, so a working run's rearms never pay for it.
    rejectedKeyPause:
      runId !== null &&
      runState === "paused" &&
      readRejectedKeyPause(host.objectCtx.storage.sql, runId, generation),
    keepAliveUntilMs: readKeepAliveUntilMs(host.objectCtx.storage.sql, generation),
    bridgeConnected: host.currentBridge(session) !== null,
    hasRepository: readRepositoryBase(host.objectCtx.storage.sql) !== null,
    lastCheckpoint: readLastCheckpoint(host.objectCtx.storage.sql),
    stop,
    probe: readProbe(host.objectCtx.storage.sql, generation),
    provisioning: provisioningUnsettled(attachment)
      ? {
          startedAtMs: attachment.startedAtMs as number,
          inMemory: host.provisioningInFlight === generation,
        }
      : null,
    settings: lifecycleSettings(host.objectEnv),
  };
}

/**
 * The attachment row moves only along an edge record 11 allows. A forbidden
 * move is logged and skipped, so the row never says what the log could not.
 */
export function moveAttachment(host: SessionHost, generation: number, to: SandboxState): void {
  const current = readAttachment(host.objectCtx.storage.sql, generation) as AttachmentFact;
  if (sandboxPath(current.state, to) === null) {
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.attachment",
      result: "refused",
      errorCategory: `${current.state}_to_${to}`,
      sandboxGeneration: String(generation),
    });
    return;
  }
  host.objectCtx.storage.sql.exec(
    "UPDATE sandbox_attachment SET state = ? WHERE generation = ?",
    to,
    generation,
  );
}

/**
 * The driver for an existing generation. A Modal generation is never handed
 * to the fake when its credential cannot be opened: the fake would answer
 * every call while the real sandbox kept running.
 */
export function driverForGeneration(
  host: SessionHost,
  attachment: AttachmentFact,
  credential: ModalCredential | null,
): SandboxDriver | null {
  if (attachment.provider === "modal" && credential === null) {
    return null;
  }
  return selectSandboxDriver(
    host.objectEnv,
    host.objectEnv.ONCUE_ENV,
    { failures: {}, sink: host },
    fetch.bind(globalThis),
    credential,
  ).driver;
}

/**
 * The workspace's Modal pair for one lifecycle step. An alarm has no request
 * carrying it, so the object opens it here and passes it to the driver,
 * never storing it in a field or anywhere else.
 */
export async function openCredential(
  host: SessionHost,
  session: SessionRow,
): Promise<ModalCredential | null> {
  const keyring = await cachedCredentialKeyring(host.objectEnv.ONCUE_BROKER_KEYRING);
  if (keyring.kind !== "ok") {
    return null;
  }
  const opened = await openModalCredential(host.objectEnv.DB, keyring.keyring, session.workspaceId);
  return opened.kind === "opened" ? opened.credential : null;
}

export async function runLifecycle(host: SessionHost): Promise<void> {
  for (;;) {
    const session = host.readSession();
    if (session === null || session.sandboxGeneration === 0) {
      return;
    }
    const view = host.lifecycleView(session, Date.now());
    const action = planAlarm(view);
    switch (action.kind) {
      case "none":
        return;
      case "clear_probe":
        clearProbe(host.objectCtx.storage.sql, session.sandboxGeneration);
        break;
      case "recover_provisioning":
        await host.recoverProvisioning(session);
        return;
      case "probe":
        await probeSandbox(host, session, view.attachment as AttachmentFact);
        break;
      case "begin_stop":
        host.applyStopPlan(session, beginStop(view, action.cause, null, newEventId));
        break;
      case "advance_stop":
        if ((await host.advanceStop(undefined)) !== null) {
          return;
        }
        break;
    }
  }
}

async function probeSandbox(
  host: SessionHost,
  session: SessionRow,
  attachment: AttachmentFact,
): Promise<void> {
  const answer = await askProvider(host, session, attachment, await host.openCredential(session));
  const plan = planProbeAnswer(host.lifecycleView(session, Date.now()), answer);
  switch (plan.kind) {
    case "clear":
      clearProbe(host.objectCtx.storage.sql, session.sandboxGeneration);
      return;
    case "retry":
      writeProbe(host.objectCtx.storage.sql, plan.probe);
      return;
    case "lost":
      await loseGeneration(host, session.sandboxGeneration);
      return;
  }
}

async function askProvider(
  host: SessionHost,
  session: SessionRow,
  attachment: AttachmentFact,
  credential: ModalCredential | null,
): Promise<ProbeAnswer> {
  const driver = host.driverForGeneration(attachment, credential);
  if (driver === null) {
    return "unknown";
  }
  const status = await driver.getStatus({
    sessionId: session.id,
    generation: session.sandboxGeneration,
  });
  if (status.kind === "ok") {
    return LIVE_OR_STARTING_STATUS.has(status.value) ? "live" : "gone";
  }
  return status.category === "not_found" ? "gone" : "unknown";
}

/**
 * The provider agrees the sandbox is gone. Credentials are revoked first; the
 * loss commits after, in one transaction with the revocation's event, the
 * attachment's failure, the run's fate (`planLoss`), and the probe's removal.
 * An eviction during revocation leaves the probe owed, so the next alarm asks
 * and revokes again rather than recording a loss with no revocation. The loss
 * is planned from what is stored afterwards, since a user's stop may have
 * taken over meanwhile.
 */
async function loseGeneration(host: SessionHost, generation: number): Promise<void> {
  const grants = await host.revokeGenerationCredentials(
    host.readSession() as SessionRow,
    generation,
  );
  const session = host.readSession() as SessionRow;
  const plan = planLoss(host.lifecycleView(session, Date.now()), generation, newEventId);
  if (plan === null) {
    return;
  }
  const now = new Date().toISOString();
  const events: ProtocolEvent[] = [
    ...plan.events,
    buildEvent("sandbox.credentials_revoked", {
      eventId: crypto.randomUUID(),
      sessionId: session.id,
      runId: null,
      sandboxGeneration: generation,
      runtimeSequence: null,
      occurredAt: now,
      payload: { reason: "disappeared", grants },
    }),
  ];
  if (plan.runAction === "fail_provisioning" || plan.runAction === "fail_execution") {
    events.push(
      host.runFailedEvent(
        session,
        session.currentRunId as string,
        plan.runAction === "fail_execution" ? "execution" : "provisioning",
        "sandbox_lost",
        plan.warning,
        now,
      ),
    );
  }
  events.push(...orphanedAgentEnds(host.objectCtx.storage.sql, plan.events, now));
  host.commitControlEvents(session, events, now, () => {
    clearProbe(host.objectCtx.storage.sql, generation);
    host.moveAttachment(generation, "failed");
    for (const event of events) {
      applyLifecycleRunEvent(host.objectCtx.storage.sql, event, now);
    }
  });
  // The same sweep, for anything declared while the revocation ran.
  host.revokeArtifactTokens(session, generation);
  host.closeAttachedBridges();
  await host.dispatch({ kind: "generation_ended" });
}

/** Arms the one alarm at the earliest moment any of its owners is owed, or clears it when none is. */
export async function rearm(host: SessionHost): Promise<void> {
  const session = host.readSession();
  const lifecycle =
    session === null || session.sandboxGeneration === 0
      ? null
      : lifecycleDeadline(host.lifecycleView(session, Date.now()));
  const next = earliest([
    host.outboxDueAtMs,
    host.gitGrantDeadlineMs,
    host.pushGrantDeadlineMs,
    host.readSecretGrantDeadlineMs(),
    lifecycle,
    readApprovalDeadlineMs(host.objectCtx.storage.sql),
    readLateStopDueMs(host.objectCtx.storage.sql),
  ]);
  const existing = await host.objectCtx.storage.getAlarm();
  if (next === null) {
    if (existing !== null) {
      await host.objectCtx.storage.deleteAlarm();
    }
    return;
  }
  if (existing !== next) {
    await host.objectCtx.storage.setAlarm(next);
  }
}

/**
 * Record 11's keep-alive, bounded by `planKeepAlive`, committed so the idle
 * deadline reads it back. Not named `keepAlive`: that would override the
 * Agents SDK's own method.
 */
export async function extendKeepAlive(host: SessionHost): Promise<KeepAliveResult> {
  const session = host.readSession();
  if (session === null) {
    return { kind: "not_running" };
  }
  const view = host.lifecycleView(session, Date.now());
  const plan = planKeepAlive(view);
  if (plan.kind === "refused") {
    return { kind: "not_running" };
  }
  const now = new Date(view.nowMs).toISOString();
  const expiresAt = new Date(plan.expiresAtMs).toISOString();
  host.commitControlEvents(
    session,
    [
      buildEvent("sandbox.keepalive.updated", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: { expiresAt, requestedBy: "user", minutes: plan.minutes },
      }),
    ],
    now,
    () => undefined,
  );
  await host.rearm();
  return { kind: "extended", expiresAt };
}
