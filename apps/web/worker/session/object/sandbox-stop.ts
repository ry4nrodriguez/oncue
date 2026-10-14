// The one stop sequence `lifecycle.ts` plans: steps, leases, revocation, and
// terminate.

import type { ProtocolCommand } from "@oncue/protocol";
import type { ModalCredential } from "../../modal/client";
import type { SandboxDriver, SandboxReference } from "../../sandbox/driver";
import { chargedRunId, SHUTDOWN_GRACE_MS } from "../dispatch";
import {
  type AttachmentFact,
  beginStop,
  effectFor,
  type GrantRevocation,
  isLive,
  joinUserStop,
  leaseStep,
  onStopSignal,
  type StopEffect,
  type StopPlan,
  type StopRow,
  type StopSignal,
} from "../lifecycle";
import { SHUTDOWN_POLL_MS, SHUTDOWN_REASON } from "./constants";
import { newEventId } from "./credentials";
import type { SessionHost } from "./host";
import {
  applyLifecycleRunEvent,
  generationEnded,
  lastOutputCursor,
  readStopRow,
  writeStopRow,
} from "./store-lifecycle";
import { orphanedAgentEnds } from "./subagent-gate";
import type { DriverFailure, SessionRow, StopSandboxBody, StopSandboxResult } from "./types";

/**
 * The user's stop, through the one stop sequence `lifecycle.ts` plans: no
 * checkpoint (the confirmation says unsaved work is lost), revoke, terminate.
 * A stop already under way is joined and becomes the user's, abandoning any
 * checkpoint it waited on. A provider refusal is reported and the stop keeps
 * its place for the alarm to finish; a stop that must wait answers `stopping`.
 */
export function stopSandbox(host: SessionHost, body: StopSandboxBody): Promise<StopSandboxResult> {
  return stopGeneration(host, "user_requested", body.requestedByUserId, body.modalCredential);
}

/**
 * Starts or joins the current generation's stop and carries it as far as it
 * goes now. `user_requested` skips the checkpoint and takes over a stop under
 * way. `idle` is archiving's stop: it checkpoints first, and a stop already
 * under way is left to finish as it began.
 */
export async function stopGeneration(
  host: SessionHost,
  cause: "user_requested" | "idle",
  requestedByUserId: string,
  credential: ModalCredential | null | undefined,
): Promise<StopSandboxResult> {
  const session = host.readSession();
  if (session === null || session.sandboxGeneration === 0) {
    return { kind: "not_running" };
  }
  const generation = session.sandboxGeneration;
  if (generationEnded(host.objectCtx.storage.sql, generation)) {
    return { kind: "not_running" };
  }
  const view = host.lifecycleView(session, Date.now());
  const existing = view.stop;
  if (existing === null) {
    // A sandbox still starting has nothing to checkpoint yet.
    const planned = cause === "idle" && !isLive(view.attachment) ? "user_requested" : cause;
    host.applyStopPlan(session, beginStop(view, planned, requestedByUserId, newEventId));
  } else if (cause === "user_requested") {
    // A planned replacement still provisioning has no generation of its own yet,
    // so the stop row it came from is current and the user's stop cancels it
    // (`beginResume` checks before it commits).
    const joined = joinUserStop(
      view,
      existing,
      requestedByUserId,
      host.replacing === existing.generation,
      newEventId,
    );
    if (joined === null) {
      return { kind: "not_running" };
    }
    host.applyStopPlan(session, joined);
  } else if (existing.step === "done") {
    return { kind: "not_running" };
  }
  const failure = await host.advanceStop(credential);
  await host.rearm();
  if (failure !== null) {
    return { kind: "failed", category: failure.category, message: failure.message };
  }
  // Only a stop past its terminate has ended the sandbox; `advanceStop` also
  // returns when the stop has to wait.
  return (readStopRow(host.objectCtx.storage.sql, generation) as StopRow).step === "done"
    ? { kind: "stopped", generation }
    : { kind: "stopping", generation };
}

/**
 * `runtime.shutdown`, committed like a client command (acknowledged as
 * `control_plane`, then by the bridge), followed by a wait bounded by the
 * command's grace. A bridge still open after it is stopped by the driver.
 */
async function requestShutdown(
  host: SessionHost,
  session: SessionRow,
  reason: "idle" | "replaced" | "cancelled",
): Promise<void> {
  const now = new Date().toISOString();
  const command = {
    commandId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    issuedAt: now,
    issuedByUserId: session.ownerUserId,
    expected: { scope: "session", state: session.state },
    type: "runtime.shutdown",
    payload: { reason, graceMs: SHUTDOWN_GRACE_MS },
  } as ProtocolCommand;
  const mintedRunId = crypto.randomUUID();
  host.planAndCommit(session, command, { kind: "admit" }, now, mintedRunId, null, null, true);
  await host.dispatch({
    kind: "command_admitted",
    command,
    now,
    runId: chargedRunId(command, mintedRunId),
  });
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline && host.currentBridge(session) !== null) {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
  }
}

/** A stop step's row, attachment move, events, and the run rows those events prove, in one transaction. */
export function applyStopPlan(host: SessionHost, session: SessionRow, plan: StopPlan): void {
  const now = new Date().toISOString();
  const events = [
    ...plan.events,
    ...orphanedAgentEnds(host.objectCtx.storage.sql, plan.events, now),
  ];
  host.commitControlEvents(session, events, now, () => {
    writeStopRow(host.objectCtx.storage.sql, plan.row);
    if (plan.attachmentState !== null) {
      host.moveAttachment(plan.row.generation, plan.attachmentState);
    }
    for (const event of events) {
      applyLifecycleRunEvent(host.objectCtx.storage.sql, event, now);
    }
  });
  // The user's stop cancels the run, and its question with it. The planned
  // replacement interrupts the run to restart it on a new sandbox, where the
  // harness's call that asked no longer exists, so its question ends too.
  const replaced = plan.events.some(
    (event) => event.type === "run.interrupted" && event.payload.reason === "sandbox_replaced",
  );
  host.sweepQuestions(replaced ? "sandbox_replaced" : null);
}

/**
 * Applies a step's signal only while the stop still holds the lease the
 * effect ran under. During the effect's await another caller can move the
 * stop past that step or take it over after the lease ran out; a late signal
 * would then roll the stop back or overwrite the newer lease, so it changes
 * nothing. The lease is the step, attempt count, and due time together.
 * Returns the row the signal was applied to, or null.
 */
function applyStopSignal(host: SessionHost, leased: StopRow, signal: StopSignal): StopRow | null {
  const session = host.readSession() as SessionRow;
  const view = host.lifecycleView(session, Date.now());
  const stored = view.stop;
  if (
    stored === null ||
    stored.generation !== leased.generation ||
    stored.step !== leased.step ||
    stored.attempts !== leased.attempts ||
    stored.dueAtMs !== leased.dueAtMs
  ) {
    return null;
  }
  host.applyStopPlan(session, onStopSignal(view, stored, signal, newEventId));
  return stored;
}

/** A report the stop was waiting on: apply it, then carry the stop forward without waiting for the alarm. */
export async function signalStop(host: SessionHost, signal: StopSignal): Promise<void> {
  const session = host.readSession() as SessionRow;
  const view = host.lifecycleView(session, Date.now());
  const row = view.stop;
  if (row === null) {
    return;
  }
  const plan = onStopSignal(view, row, signal, newEventId);
  if (plan.row === row) {
    return;
  }
  host.applyStopPlan(session, plan);
  await host.advanceStop(undefined);
  await host.rearm();
}

/**
 * Carries the current generation's stop forward one step at a time until it
 * finishes or must wait. `credential` is the pair the stop route opened;
 * `undefined` means open it here only if a step needs the provider. Returns
 * the driver's refusal when a terminate was refused.
 */
export async function advanceStop(
  host: SessionHost,
  credential: ModalCredential | null | undefined,
): Promise<DriverFailure | null> {
  // Counted from the first line: the steps after a terminate still write, and
  // an erase must not run between the generation's end and those writes.
  host.stopsAdvancing += 1;
  try {
    return await carryStop(host, credential);
  } finally {
    host.stopsAdvancing -= 1;
  }
}

async function carryStop(
  host: SessionHost,
  credential: ModalCredential | null | undefined,
): Promise<DriverFailure | null> {
  let pair = credential;
  const credentialFor = async (session: SessionRow): Promise<ModalCredential | null> => {
    if (pair === undefined) {
      pair = await host.openCredential(session);
    }
    return pair;
  };
  for (;;) {
    const session = host.readSession() as SessionRow;
    const view = host.lifecycleView(session, Date.now());
    const row = view.stop;
    // No row: the alarm finished this stop meanwhile, and the replacement moved
    // the session to a generation with no stop.
    if (row === null || row.step === "done" || (row.dueAtMs !== null && row.dueAtMs > view.nowMs)) {
      return null;
    }
    const effect = effectFor(row);
    if (effect === null) {
      host.applyStopPlan(
        session,
        onStopSignal(view, row, { kind: "checkpoint_timed_out" }, newEventId),
      );
      continue;
    }
    // Lease the step and arm the alarm for the lease's end before the effect
    // runs: a throw or an eviction leaves the step due when the lease ends (no
    // spinning alarm, nothing lost), and a concurrent caller waits instead of
    // running the same effect.
    const leased = leaseStep(row, view.nowMs);
    writeStopRow(host.objectCtx.storage.sql, leased);
    await host.rearm();
    if (effect.kind === "terminate") {
      const outcome = await terminateGeneration(
        host,
        session,
        view.attachment as AttachmentFact,
        row,
        await credentialFor(session),
      );
      if (outcome.kind === "error") {
        // A refusal for a terminate another caller finished or took over is not
        // this stop's to report.
        if (applyStopSignal(host, leased, { kind: "terminate_failed" }) !== null) {
          return outcome;
        }
        continue;
      }
      const terminated = applyStopSignal(host, leased, { kind: "terminated" });
      if (terminated !== null) {
        await afterTerminate(host, session, terminated, outcome.driver);
      }
      continue;
    }
    applyStopSignal(host, leased, await performStopEffect(host, session, row, effect));
  }
}

async function performStopEffect(
  host: SessionHost,
  session: SessionRow,
  row: StopRow,
  effect: Exclude<StopEffect, { readonly kind: "terminate" }>,
): Promise<StopSignal> {
  switch (effect.kind) {
    case "issue_checkpoint":
      return host.issueCheckpoint(session, effect.reason);
    case "revoke_credentials":
      return {
        kind: "revoked",
        grants: await host.revokeGenerationCredentials(session, row.generation),
      };
    case "provision_replacement":
      host.provisionReplacement(session, effect);
      return { kind: "replaced" };
  }
}

/** Record 11, before the attachment is marked stopped: every credential this generation held, and what became of each. */
export async function revokeGenerationCredentials(
  host: SessionHost,
  session: SessionRow,
  generation: number,
): Promise<GrantRevocation[]> {
  // No decision outlives the generation whose tool call it was for.
  host.sweepApprovals(generation);
  const model = await endModelAccess(host, session, generation);
  const git = await host.revokeTokens("git");
  const push = await host.revokeTokens("push");
  const upload = host.revokeArtifactTokens(session, generation);
  return [
    { kind: "model", outcome: model },
    { kind: "git", outcome: git },
    { kind: "push", outcome: push },
    { kind: "upload", outcome: upload },
  ];
}

async function endModelAccess(
  host: SessionHost,
  session: SessionRow,
  generation: number,
): Promise<GrantRevocation["outcome"]> {
  const projected = await projectEndedGeneration(host, session.id, generation);
  const held =
    host.objectCtx.storage.sql
      .exec<{ held: number }>(
        "SELECT EXISTS(SELECT 1 FROM bridge_dispatch WHERE generation = ? AND kind = 'model_grant') AS held",
        generation,
      )
      .one().held === 1;
  if (!held) {
    return "not_held";
  }
  return projected ? "revoked" : "failed";
}

/**
 * `session_index.ended_sandbox_generation`: the broker refuses a model token
 * at or below it, for forwards and renewals. Written straight to D1 because an
 * outbox snapshot with no new event would be skipped by the ordering guard.
 * The column only grows, so rewriting it is always safe.
 */
function projectEndedGeneration(
  host: SessionHost,
  sessionId: string,
  generation: number,
): Promise<boolean> {
  return host.objectEnv.DB.prepare(
    `UPDATE session_index
       SET ended_sandbox_generation = MAX(COALESCE(ended_sandbox_generation, 0), ?)
       WHERE session_id = ?`,
  )
    .bind(generation, sessionId)
    .run()
    .then(
      () => true,
      () => false,
    );
}

async function terminateGeneration(
  host: SessionHost,
  session: SessionRow,
  attachment: AttachmentFact,
  row: StopRow,
  credential: ModalCredential | null,
): Promise<{ readonly kind: "ok"; readonly driver: SandboxDriver } | DriverFailure> {
  // Record 11 again, before every attempt: if D1 refused the generation's end
  // at the revoke step, the broker would keep renewing its model token while a
  // refused terminate leaves the sandbox running. The outbox retry is too slow.
  await projectEndedGeneration(host, session.id, row.generation);
  if (host.currentBridge(session) !== null) {
    await requestShutdown(host, session, SHUTDOWN_REASON[row.cause]);
  }
  const driver = host.driverForGeneration(attachment, credential);
  if (driver === null) {
    return {
      kind: "error",
      category: "credentials",
      message:
        "The workspace's Modal connection could not be opened, so the sandbox could not be stopped yet.",
      retryable: true,
    };
  }
  const stopped = await driver.stop({ sessionId: session.id, generation: row.generation });
  // A stop during a create finds nothing while the create is still in
  // flight; once it can no longer land, the alarm stops the name again.
  host.scheduleLateStop(row.generation, attachment.provider);
  return stopped.kind === "ok" ? { kind: "ok", driver } : stopped;
}

async function afterTerminate(
  host: SessionHost,
  session: SessionRow,
  row: StopRow,
  driver: SandboxDriver,
): Promise<void> {
  // Anything declared after the revoke step and still waiting for an upload
  // never will be.
  host.revokeArtifactTokens(session, row.generation);
  host.closeAttachedBridges();
  // The generation is over, so what it was owed is abandoned; the user's stop
  // ended the run, so a message held for "next" is released now. An archived
  // or deleting session starts no new run, so its held messages stay held.
  await host.dispatch({ kind: "generation_ended" });
  if (row.cause === "user_requested" && (host.readSession() as SessionRow).state === "active") {
    await host.dispatch({
      kind: "run_terminal",
      runId: session.currentRunId as string,
      now: new Date().toISOString(),
      mintedRunId: crypto.randomUUID(),
      mintedCommandId: crypto.randomUUID(),
      mintedGrantId: crypto.randomUUID(),
    });
  }
  const reference: SandboxReference = { sessionId: session.id, generation: row.generation };
  const last = await driver.getOutput(
    reference,
    lastOutputCursor(host.objectCtx.storage.sql, row.generation),
  );
  if (last.kind === "ok") {
    host.commitOutputLines(session, last.value.lines);
  }
  if (row.cause !== "lifetime_ceiling") {
    await host.resumeIfOwed();
  }
}
