// The session's own state (record 10): archiving and restoring it, closing it
// for deletion, and erasing its storage once the deletion job has removed
// everything that points into it (record 19).
//
// The Worker's routes call these first and write `session_index.state`
// themselves once the object agrees; a projection never moves that column
// out of anything but `creating` (`applyProjectionToD1`).

import { isTerminal, type ProtocolCommand, type SessionState } from "@oncue/protocol";
import { chargedRunId } from "../dispatch";
import SCHEMA_SQL from "../schema.sql?raw";
import type { SessionHost } from "./host";
import { isTombstoned, readRunState, writeTombstone } from "./store-session";
import type {
  ArchiveSessionBody,
  ArchiveSessionResult,
  DeleteSessionBody,
  DeleteSessionResult,
  EraseSessionResult,
  SessionRow,
  UnarchiveSessionResult,
} from "./types";

/** The close code a deleted session's browser sockets get; the client treats it as a denial and stops reconnecting. */
export const DELETED_CLOSE_CODE = 4403;

/**
 * Closes the object's sockets, the browser's or every one. A socket already
 * closing stays listed until its peer answers, and is left to finish.
 */
export function closeSockets(host: SessionHost, tag?: "client"): void {
  for (const ws of host.objectCtx.getWebSockets(tag)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(DELETED_CLOSE_CODE, "session deleted");
    }
  }
}

function writeState(host: SessionHost, session: SessionRow, state: SessionState): SessionRow {
  host.objectCtx.storage.sql.exec(
    "UPDATE session SET state = ?, updated_at = ? WHERE id = ?",
    state,
    new Date().toISOString(),
    session.id,
  );
  return { ...session, state };
}

/** The current run when it has not reached an outcome. A session whose first run was refused has none. */
function openRunId(host: SessionHost, session: SessionRow): string | null {
  const state =
    session.currentRunId === null
      ? null
      : readRunState(host.objectCtx.storage.sql, session.currentRunId);
  return state !== null && !isTerminal("run", state) ? session.currentRunId : null;
}

/**
 * A cancel the object makes for the owner, admitted like the user's own: the
 * bridge is told, and the run ends `cancelled`. Archiving ends an open run
 * this way, and a model change ends the paused or interrupted run it replaces
 * (record 15). No held message is released: an archived session starts no
 * run, and a model change starts its own.
 */
export async function cancelRun(
  host: SessionHost,
  session: SessionRow,
  runId: string,
  reason = "The session was archived.",
): Promise<void> {
  const now = new Date().toISOString();
  const command = {
    commandId: crypto.randomUUID(),
    sessionId: session.id,
    runId,
    issuedAt: now,
    issuedByUserId: session.ownerUserId,
    expected: { scope: "run", state: readRunState(host.objectCtx.storage.sql, runId) },
    type: "run.cancel",
    payload: { reason, checkpointFirst: false },
  } as unknown as ProtocolCommand;
  const mintedRunId = crypto.randomUUID();
  host.planAndCommit(session, command, { kind: "admit" }, now, mintedRunId, null, null, true);
  await host.dispatch({
    kind: "command_admitted",
    command,
    now,
    runId: chargedRunId(command, mintedRunId),
  });
  host.sweepApprovals();
  // The run's open question ends with it, as after the user's own cancel. A
  // session whose sandbox already stopped has no stop left to sweep it.
  host.sweepQuestions();
}

/**
 * Archive: the session becomes read-only, an open run is cancelled (only
 * when the caller confirmed it), and the sandbox stops the way an idle one
 * does, checkpointing first so unpushed work is kept. Repeating it is safe.
 */
export async function archiveSession(
  host: SessionHost,
  body: ArchiveSessionBody,
): Promise<ArchiveSessionResult> {
  const stored = host.readSession();
  if (stored === null) {
    return { kind: "no_session" };
  }
  if (stored.state === "deletion_pending") {
    return { kind: "deleting" };
  }
  const runId = openRunId(host, stored);
  if (runId !== null && !body.cancelOpenRun) {
    return { kind: "run_open" };
  }
  const session = stored.state === "archived" ? stored : writeState(host, stored, "archived");
  if (runId !== null) {
    await cancelRun(host, session, runId);
  }
  const stop = await host.stopGeneration("idle", body.requestedByUserId, body.modalCredential);
  return { kind: "archived", sandbox: stop.kind };
}

/** Restore: the session is open again; the next message resumes it on a new sandbox. */
export function unarchiveSession(host: SessionHost): UnarchiveSessionResult {
  const session = host.readSession();
  if (session === null) {
    return { kind: "no_session" };
  }
  if (session.state === "deletion_pending") {
    return { kind: "deleting" };
  }
  if (session.state === "archived") {
    writeState(host, session, "active");
  }
  return { kind: "active" };
}

/**
 * Record 19's steps 3 and 4: the session refuses new work from here on, its
 * browser sockets close, and its sandbox stops through the user's stop, with
 * no checkpoint (the content is being erased; pushed work stays on GitHub)
 * and its credentials revoked. Repeating it carries an unfinished stop on.
 * The tombstone goes first, even with no session yet, so a create that
 * arrives later, or a retried one, makes nothing.
 */
export async function deleteSession(
  host: SessionHost,
  body: DeleteSessionBody,
): Promise<DeleteSessionResult> {
  writeTombstone(host.objectCtx.storage.sql, new Date().toISOString());
  const session = host.readSession();
  if (session === null) {
    return { kind: "no_session" };
  }
  if (session.state !== "deletion_pending") {
    writeState(host, session, "deletion_pending");
  }
  closeSockets(host, "client");
  const stop = await host.stopGeneration(
    "user_requested",
    body.requestedByUserId,
    body.modalCredential,
  );
  return { kind: "deleting", sandbox: stop.kind };
}

/**
 * Whether a sandbox may still come into being or still be owed a stop, or a
 * stop is still writing: a resume committing its generation; a provisioning,
 * or the stop sweep after a failed or abandoned one, in this object's memory
 * (`provisioningsPending`); a provisioning the alarm is recovering
 * (`provisioningInFlight`); a stop being carried forward, which commits the
 * sandbox's last output after its generation is marked ended
 * (`stopsAdvancing`); an attachment still starting; or a late stop by name
 * not yet run (`late_stop`, owed until a create in flight can no longer
 * land). Erasing then would drop the only thing that would stop that sandbox,
 * or let a write land in the emptied object.
 */
function sandboxWorkUnderWay(host: SessionHost): boolean {
  return (
    host.resuming !== null ||
    host.provisioningsPending > 0 ||
    host.provisioningInFlight !== null ||
    host.stopsAdvancing > 0 ||
    host.objectCtx.storage.sql
      .exec<{ owed: number }>(
        `SELECT EXISTS(SELECT 1 FROM sandbox_attachment WHERE state IN ('requested', 'provisioning'))
            OR EXISTS(SELECT 1 FROM late_stop) AS owed`,
      )
      .one().owed === 1
  );
}

/**
 * The object's own storage, last: only a deleting session whose sandbox has
 * stopped, and with none still being made, is erased. A generation that
 * failed after a create was sent is stopped by name once more first, since
 * nothing else will try again once the object is empty. The schema is laid
 * down again empty with the tombstone, so a later wake (the job's rerun, a
 * stale socket, a late create) reads "no session" and makes nothing, and no
 * `late_stop` row is left for the alarm to find without a session.
 */
export async function eraseSession(host: SessionHost): Promise<EraseSessionResult> {
  const session = host.readSession();
  if (session === null) {
    writeTombstone(host.objectCtx.storage.sql, new Date().toISOString());
    return { kind: "erased" };
  }
  if (session.state !== "deletion_pending") {
    return { kind: "not_deleting" };
  }
  if (sandboxWorkUnderWay(host)) {
    return { kind: "stopping" };
  }
  // The object opens its own Modal pair here; the job has none to pass.
  const stop = await host.stopGeneration("user_requested", session.ownerUserId, undefined);
  if (stop.kind === "stopping" || stop.kind === "failed") {
    return { kind: "stopping" };
  }
  await host.stopFailedGenerations(session);
  // Asked again after the awaits above: the alarm or another request may have
  // started a stop or owed a late one meanwhile, and the erase below must not
  // run under it.
  if (sandboxWorkUnderWay(host)) {
    return { kind: "stopping" };
  }
  closeSockets(host);
  host.attachedBridges.clear();
  host.volatileGitTokens.clear();
  host.bridgeSpentPushGrants.clear();
  host.gitGrantDeadlineMs = null;
  host.pushGrantDeadlineMs = null;
  host.outboxDueAtMs = null;
  host.secretGrantDeadlineMs = null;
  host.secretGrantDeadlineLoaded = false;
  host.pendingRedactionSecrets = [];
  host.redactorGeneration = null;
  await host.objectCtx.storage.deleteAlarm();
  await host.objectCtx.storage.deleteAll();
  host.erased = true;
  host.objectCtx.storage.sql.exec(SCHEMA_SQL);
  writeTombstone(host.objectCtx.storage.sql, new Date().toISOString());
  return { kind: "erased" };
}

/**
 * Whether a delete has reached this object, read without changing anything.
 * The deletion job asks before touching a session whose index row is gone.
 */
export function deletionMarked(host: SessionHost): { readonly marked: boolean } {
  return { marked: isTombstoned(host.objectCtx.storage.sql) };
}

/**
 * Whether this object ever committed a session, for the `creating` sweep. A
 * session found here has a projection still owed, so the drain is retried now.
 */
export function sessionExists(host: SessionHost): { readonly exists: boolean } {
  if (host.readSession() === null) {
    return { exists: false };
  }
  host.objectCtx.waitUntil(host.drainOutboxNow());
  return { exists: true };
}
