// Session creation and a generation's provisioning, output relay, and failure.

import {
  buildEvent,
  DEFAULT_RUNTIME_ID,
  isTerminal,
  type ProtocolCommand,
  type ProtocolEvent,
  type RunState,
} from "@oncue/protocol";
import { log } from "../../log";
import type { ModalCredential } from "../../modal/client";
import type {
  DriverOutcome,
  SandboxCreateSpec,
  SandboxDriver,
  SandboxOutputLine,
  SandboxReference,
} from "../../sandbox/driver";
import type { FailureInjection } from "../../sandbox/fake-driver";
import { type SandboxProvider, selectSandboxDriver } from "../../sandbox/select";
import { chargedRunId } from "../dispatch";
import {
  type AttachmentFact,
  lifecycleSettings,
  PROVISION_CHECK_MS,
  PROVISION_GIVE_UP_MS,
} from "../lifecycle";
import {
  FINAL_STOP_GENERATIONS,
  LATE_STOP_MAX_ATTEMPTS,
  LATE_STOP_RETRY_MS,
  LATE_STOPS_PER_ALARM,
  LIVE_OR_STARTING_STATUS,
  MAX_PREPARE_FAILURES,
  MAX_PREPARE_POLLS,
  OUTPUT_DRAIN_POLLS,
  OUTPUT_POLL_BUDGET_MS,
  OUTPUT_POLL_INTERVAL_MS,
  PREPARE_WAIT_MS,
} from "./constants";
import { mintBootstrap } from "./credentials";
import type { SessionHost } from "./host";
import { commitHomeApprovalMode } from "./permission-gate";
import {
  bridgeConnected,
  deleteLateStop,
  generationEnded,
  readAttachment,
  readCreateDeadline,
  readDueLateStops,
  readFailedCreatedGenerations,
  readStopRow,
  writeCreateDeadline,
  writeLateStop,
} from "./store-lifecycle";
import { isTombstoned, readRunState, readSessionState } from "./store-session";
import type { CreateSessionBody, CreateSessionResult, GenerationStart, SessionRow } from "./types";

// Record 03: session, first run, and an outbox record commit in one `transactionSync`.
export async function createSession(
  host: SessionHost,
  body: CreateSessionBody,
): Promise<CreateSessionResult> {
  // The bootstrap is minted with admission, before anything commits, so no
  // await sits between the commit and the provisioning that counts itself
  // for an erase to wait on.
  const [admission, bootstrap] = await Promise.all([host.decideAdmissionNow(), mintBootstrap()]);
  // After the await, so a delete that landed meanwhile counts: a deleted
  // session is never made again, whatever the create says.
  if (isTombstoned(host.objectCtx.storage.sql)) {
    return { sessionId: body.sessionId, runId: body.mintedRunId, plan: "deleted" };
  }
  const existing = host.readSession();
  const isNew = existing === null;
  const session: SessionRow = isNew
    ? {
        id: body.sessionId,
        workspaceId: body.workspaceId,
        ownerUserId: body.ownerUserId,
        state: "active",
        title: body.title,
        currentRunId: null,
        sandboxGeneration: 0,
        lastRuntimeSequence: null,
      }
    : (existing as SessionRow);
  const command = {
    commandId: body.commandId,
    sessionId: body.sessionId,
    runId: null,
    issuedAt: body.issuedAt,
    issuedByUserId: body.ownerUserId,
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: body.instruction,
      model: body.model,
      continuesRunId: body.continuesRunId,
      ...(body.skipRequiredChecks === true ? { skipRequiredChecks: true } : {}),
    },
  } as unknown as ProtocolCommand;
  const plan = host.planAndCommit(
    session,
    command,
    admission,
    body.issuedAt,
    body.mintedRunId,
    isNew
      ? {
          taskId: body.taskId,
          repository: body.repository,
          runtimeId: body.runtime?.id ?? DEFAULT_RUNTIME_ID,
        }
      : null,
    null,
    // The Worker resolved this connection from the workspace's active ones.
    true,
  );
  if (plan.kind === "accept" && isNew) {
    host.pinDeclaration(session, body.secrets ?? null, body.issuedAt);
    if (body.approvalMode === "session") {
      // Home's choice for this session, committed before any ask can arrive.
      commitHomeApprovalMode(host, session, body);
    }
  }
  if (plan.kind === "accept") {
    host.pendingScriptName = body.scriptName;
    host.pendingTaskBranch = body.taskBranch;
    host.pendingBaseCommitSha = body.baseCommitSha;
    host.pendingFramePacingMs = body.framePacingMs;
    host.pendingRedactionSecrets = body.redactionSecrets;
    // Provisioning is not awaited: a real sandbox takes ten seconds or more, and
    // the timeline exists to show that stretch. The object stays active while it
    // has pending I/O, and every step is a committed event a viewer replays.
    host.objectCtx.waitUntil(
      provisionLogged(
        host,
        body.sessionId,
        host.provisionSandbox(
          // `planAndCommit` just made the minted run current; the row read above predates it.
          { ...session, currentRunId: body.mintedRunId },
          command,
          body.issuedAt,
          body.driverFailures,
          body.modalCredential,
          {
            reason: "initial",
            replaced: null,
            context: null,
            committed: () => undefined,
            bootstrap,
          },
        ),
      ),
    );
  }
  host.objectCtx.waitUntil(host.drainOutboxNow());
  return { sessionId: body.sessionId, runId: body.mintedRunId, plan: plan.kind };
}

/**
 * Clears `provisioningInFlight` only when it still names `generation`: a stop
 * and a resend during a long build start the next generation's provisioning
 * while this one's last call is out, and that one's mark must survive this
 * one ending, or the alarm would take it for lost.
 */
function releaseProvisioningMark(host: SessionHost, generation: number): void {
  if (host.provisioningInFlight === generation) {
    host.provisioningInFlight = null;
  }
}

/**
 * Provisioning runs after the create request has been answered, so a fault in
 * it has no caller to reach. It is logged rather than left as an unhandled
 * rejection.
 */
async function provisionLogged(
  host: SessionHost,
  sessionId: string,
  provisioning: Promise<void>,
): Promise<void> {
  try {
    await provisioning;
  } catch {
    log({
      timestamp: new Date().toISOString(),
      severity: "error",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.provision",
      result: "threw",
      sessionId,
    });
  }
}

/**
 * Record 02's lifecycle as committed events, because the timeline is built
 * from events alone: `sandbox.provisioning` before the driver is asked,
 * `sandbox.attached` once the sandbox runs, and on failure `sandbox.stopped`
 * (`provisioning_failed`) plus `run.failed`, so the run never waits for a
 * bridge that will not connect.
 *
 * `getConnection` runs after `start` because `sandbox.attached` names the
 * provider's sandbox id, which `create`'s reference does not carry.
 */
export async function provisionSandbox(
  host: SessionHost,
  session: SessionRow & { readonly currentRunId: string },
  /** The `run.start` owed to this generation once its bridge is ready; null for a replacement with no run to carry. */
  runStart: ProtocolCommand | null,
  now: string,
  driverFailures: FailureInjection,
  // A parameter rather than a field, so the pair cannot survive into a
  // hibernation or a later generation.
  modalCredential: ModalCredential | null,
  start: GenerationStart,
): Promise<void> {
  // Counted on the first line, before any await, so an erase waits for the
  // whole of it: the commit below, the dispatch, the image, and the provider.
  host.provisioningsPending += 1;
  try {
    await provisionGeneration(host, session, runStart, now, driverFailures, modalCredential, start);
  } finally {
    host.provisioningsPending -= 1;
  }
}

async function provisionGeneration(
  host: SessionHost,
  session: SessionRow & { readonly currentRunId: string },
  runStart: ProtocolCommand | null,
  now: string,
  driverFailures: FailureInjection,
  modalCredential: ModalCredential | null,
  start: GenerationStart,
): Promise<void> {
  // An archived or deleted session (or an erased object, which has none)
  // gets no new generation; nothing is written for it.
  if (readSessionState(host.objectCtx.storage.sql) !== "active") {
    return;
  }
  const generation = session.sandboxGeneration + 1;
  // Chosen from the deployment's bindings: with no controller configured every
  // session runs on the fake. The attachment row records which driver ran.
  const selection = selectSandboxDriver(
    host.objectEnv,
    host.objectEnv.ONCUE_ENV,
    { failures: driverFailures, sink: host },
    // Bound: workerd throws "Illegal invocation" when `fetch` loses its `this`.
    fetch.bind(globalThis),
    modalCredential,
  );
  const current = { ...session, sandboxGeneration: generation };
  const startedAtMs = Date.now();
  // Kept only as a hash: this object's database cannot open a bridge socket,
  // and the Worker cannot derive it.
  const bootstrapCredential = start.bootstrap.credential;
  const credentialHash = start.bootstrap.sha256;
  const replaced =
    start.replaced === null
      ? []
      : [
          buildEvent("sandbox.replaced", {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            runId: null,
            sandboxGeneration: generation,
            runtimeSequence: null,
            occurredAt: now,
            payload: {
              previousGeneration: start.replaced.previousGeneration,
              reason: "lifetime_ceiling",
              restoredFrom: start.replaced.restoredFrom,
              explanation:
                "The sandbox reached its lifetime ceiling, so the session moved to a new one on purpose.",
            },
          }),
        ];
  host.commitControlEvents(
    current,
    [
      ...replaced,
      buildEvent("sandbox.provisioning", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: generation,
        runtimeSequence: null,
        occurredAt: now,
        payload: {
          provider: selection.provider,
          reason: start.reason,
          attempt: 1,
          cacheReuse: "base_image",
        },
      }),
    ],
    now,
    () => {
      host.objectCtx.storage.sql.exec(
        "UPDATE session SET sandbox_generation = ?, last_runtime_sequence = NULL, updated_at = ? WHERE id = ?",
        generation,
        now,
        session.id,
      );
      host.objectCtx.storage.sql.exec(
        "INSERT INTO sandbox_attachment (generation, provider, state, started_at) VALUES (?,?,?,?)",
        generation,
        selection.provider,
        "provisioning",
        now,
      );
      if (runStart !== null) {
        host.objectCtx.storage.sql.exec(
          // Never a run that already ended: a cancel that landed first keeps its outcome.
          "UPDATE run SET state = 'provisioning' WHERE id = ? AND outcome IS NULL",
          session.currentRunId,
        );
      }
      host.objectCtx.storage.sql.exec(
        "INSERT INTO bridge_credential (generation, credential_sha256, created_at) VALUES (?,?,?)",
        generation,
        credentialHash,
        now,
      );
      // A new sandbox has to clone again: the revocation belonged to the old generation.
      host.objectCtx.storage.sql.exec("UPDATE session_repository SET git_grant_revoked = 0");
    },
  );
  start.committed();
  // Recorded against this generation, after the bump above, so its bridge
  // finds the row when it connects.
  if (runStart !== null) {
    await host.dispatch({
      kind: "command_admitted",
      command: runStart,
      now,
      runId: chargedRunId(runStart, session.currentRunId),
      ...(start.context === null ? {} : { context: start.context }),
    });
  }

  const driver = selection.driver;
  const reference: SandboxReference = { sessionId: session.id, generation };
  // A stop or a delete during the dispatch: the provider is never asked.
  if (stoppedMeanwhile(host, generation)) {
    return;
  }
  const timings: string[] = [];
  // Marks this generation as driven from memory; an object that loses it to
  // a restart is found by the alarm (`recover_provisioning`).
  host.provisioningInFlight = generation;
  let attached: BringUp;
  try {
    attached = await bringUp(host, driver, reference, current, bootstrapCredential, timings);
  } finally {
    releaseProvisioningMark(host, generation);
  }
  if (attached.kind === "abandoned") {
    abandonGeneration(host, current, attached.createIssued);
    return;
  }
  if (attached.kind !== "ok") {
    host.failProvisioning(current, attached, startedAtMs, attached.createIssued);
    return;
  }
  attachGeneration(host, current, selection.provider, {
    startedAtMs,
    runningSinceMs: Date.now(),
    timings,
    providerSandboxId: attached.value,
  });
  await relaySandboxOutput(host, selection.provider, driver, reference, current);
}

/**
 * Commits `sandbox.attached` for a generation whose sandbox is running, and
 * the controller's timings. Callers ask `stoppedMeanwhile` with no await
 * before this, so nothing can end the generation in between. The sandbox's id
 * and expiry are stored whatever live state the row is in, because a bridge
 * is accepted while the row is `provisioning` and its `runtime.ready` may
 * have moved the row on already; the state itself moves only from
 * `provisioning`.
 */
function attachGeneration(
  host: SessionHost,
  session: SessionRow,
  provider: SandboxProvider,
  sandbox: {
    readonly startedAtMs: number;
    /** The earliest the sandbox can have started, which its lifetime counts from. */
    readonly runningSinceMs: number;
    readonly timings: readonly string[];
    readonly providerSandboxId: string;
  },
): void {
  const { startedAtMs, timings, providerSandboxId } = sandbox;
  const generation = session.sandboxGeneration;
  const attachedAt = new Date().toISOString();
  const expiresAt = new Date(
    sandbox.runningSinceMs + lifecycleSettings(host.objectEnv).lifetimeMs,
  ).toISOString();
  host.commitControlEvents(
    session,
    [
      buildEvent("sandbox.attached", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: generation,
        runtimeSequence: null,
        occurredAt: attachedAt,
        payload: {
          provider,
          providerSandboxId,
          startupMs: Date.now() - startedAtMs,
          expiresAt,
          cacheFallback: false,
        },
      }),
    ],
    attachedAt,
    () => {
      host.objectCtx.storage.sql.exec(
        `UPDATE sandbox_attachment
            SET provider_sandbox_id = ?, expires_at = ?,
                state = CASE state WHEN 'provisioning' THEN 'attached' ELSE state END
          WHERE generation = ? AND state NOT IN ('stopped', 'failed', 'replaced')`,
        providerSandboxId,
        expiresAt,
        generation,
      );
    },
  );
  // The control plane's notes about its provider calls go in the same output
  // stream as the sandbox's lines, so a reader sees one sequence.
  commitOutput(
    host,
    session,
    "controller",
    timings.map((text) => ({ at: attachedAt, text })),
  );
}

/** The run's failure when an object lost a provisioning and its sandbox is not running. */
export const PROVISIONING_LOST_MESSAGE =
  "The session restarted while its sandbox was starting, and no running sandbox was found. Send the message again to start a new one.";

/**
 * The alarm found the current generation with nothing in this object's memory
 * driving its provisioning: the object restarted mid-provisioning. A sandbox
 * found running by name is adopted, since its bridge holds the credential
 * whose hash is stored; otherwise the generation fails and the stop sweep
 * makes sure nothing it may have started keeps running. While the provider
 * cannot be asked, the next check asks again, until `PROVISION_GIVE_UP_MS`.
 *
 * The row may already be past `provisioning`: a create that landed before the
 * restart started a bridge, which the object accepted, and its
 * `runtime.ready` moved the row on with no sandbox id or expiry stored. That
 * sandbox ran, so nothing here fails or stops it. It is adopted the same way,
 * and when the provider will not name it the ceiling is stored alone.
 */
export async function recoverProvisioning(host: SessionHost, session: SessionRow): Promise<void> {
  const generation = session.sandboxGeneration;
  const attachment = readAttachment(host.objectCtx.storage.sql, generation) as AttachmentFact;
  const startedAtMs = attachment.startedAtMs as number;
  const current = { ...session, currentRunId: session.currentRunId as string };
  const starting = attachment.state === "provisioning";
  /** The recovery's ending without a sandbox: `null` when the generation ended under it. */
  const end = (failure: DriverError | null): void => {
    if (!starting) {
      storeCeiling(host, generation, startedAtMs);
    } else if (failure === null) {
      abandonRecovery(host, current);
    } else {
      host.failProvisioning(current, failure, startedAtMs, true);
    }
  };
  host.provisioningInFlight = generation;
  try {
    const lost: DriverError = {
      kind: "error",
      category: "unknown",
      message: PROVISIONING_LOST_MESSAGE,
      retryable: false,
    };
    const driver = host.driverForGeneration(attachment, await host.openCredential(session));
    if (stoppedMeanwhile(host, generation)) {
      end(null);
      return;
    }
    if (driver === null) {
      end(lost);
      return;
    }
    const reference: SandboxReference = { sessionId: session.id, generation };
    const status = await driver.getStatus(reference);
    if (stoppedMeanwhile(host, generation)) {
      end(null);
      return;
    }
    if (status.kind === "ok" && LIVE_OR_STARTING_STATUS.has(status.value)) {
      const connection = await driver.getConnection(reference);
      if (stoppedMeanwhile(host, generation)) {
        end(null);
        return;
      }
      if (connection.kind !== "ok") {
        end(connection);
        return;
      }
      attachGeneration(host, current, attachment.provider, {
        startedAtMs,
        // Nobody recorded when the lost create landed; no earlier than the
        // provisioning began, so the ceiling counted from there is never late.
        runningSinceMs: startedAtMs,
        timings: ["the session restarted while starting; found the sandbox running and adopted it"],
        providerSandboxId: connection.value.bridgeUrl,
      });
      // Not awaited: the relay runs for up to two minutes, and this is the
      // alarm, which late stops, expiries, and the rearm wait behind.
      host.objectCtx.waitUntil(
        provisionLogged(
          host,
          session.id,
          relaySandboxOutput(host, attachment.provider, driver, reference, current),
        ),
      );
      return;
    }
    const unanswered = status.kind === "error" && status.category !== "not_found";
    if (unanswered && Date.now() - startedAtMs < PROVISION_GIVE_UP_MS) {
      return;
    }
    // A create sent before the restart may still land until its deadline and
    // grace pass; finding nothing before then proves nothing.
    if (!unanswered && Date.now() < createLandingDeadline(host, generation)) {
      return;
    }
    end(unanswered ? status : lost);
  } finally {
    releaseProvisioningMark(host, generation);
  }
}

/**
 * The latest moment a generation's sandbox can have left, counted from when
 * its provisioning began, for a live row that never got one. It settles the
 * row, so the alarm's check is not owed again.
 *
 * A row found long after its provisioning may give a moment already past: the
 * provider ended that sandbox itself. Stored as it is, the alarm would replace
 * the sandbox on the spot, starting a new one for a session nobody may be
 * using, since the ceiling is weighed before the idle stop. So the replacement
 * is never due sooner than one check from now, and an idle stop that is due
 * comes first.
 */
function storeCeiling(host: SessionHost, generation: number, startedAtMs: number): void {
  const settings = lifecycleSettings(host.objectEnv);
  const expiresAtMs = Math.max(
    startedAtMs + settings.lifetimeMs,
    Date.now() + settings.ceilingMarginMs + PROVISION_CHECK_MS,
  );
  host.objectCtx.storage.sql.exec(
    "UPDATE sandbox_attachment SET expires_at = ? WHERE generation = ? AND expires_at IS NULL",
    new Date(expiresAtMs).toISOString(),
    generation,
  );
}

/**
 * A recovery whose generation ended under it. A stop that owns the ending
 * moves the row itself. With none (the session is no longer active), nothing
 * else would take the row out of `provisioning` and the alarm would check it
 * for ever, so it is marked failed here.
 */
function abandonRecovery(host: SessionHost, session: SessionRow): void {
  const sql = host.objectCtx.storage.sql;
  if (readStopRow(sql, session.sandboxGeneration) === null) {
    sql.exec(
      "UPDATE sandbox_attachment SET state = 'failed' WHERE generation = ? AND state = 'provisioning'",
      session.sandboxGeneration,
    );
  }
  abandonGeneration(host, session, true);
}

type DriverError = Extract<DriverOutcome<unknown>, { readonly kind: "error" }>;

/**
 * How bringing a generation up ended: attached, with the provider's sandbox
 * id; abandoned, because the generation ended while its image was prepared;
 * or failed, saying whether a create was ever sent, since only then can a
 * sandbox exist to stop.
 */
type BringUp =
  | { readonly kind: "ok"; readonly value: string }
  | Abandoned
  | (DriverError & { readonly createIssued: boolean });

/** The generation ended while a provider call was out; whether a create had been sent. */
type Abandoned = { readonly kind: "abandoned"; readonly createIssued: boolean };

/**
 * Whether the generation a provisioning is bringing up ended while a provider
 * call was out: a stop row for it, its attachment ended, or the session no
 * longer active on it (deleted, archived, or moved to another generation).
 * Every step of a provisioning asks after each provider answer, because the
 * object serves other requests while it waits. Three reads by key.
 */
export function stoppedMeanwhile(host: SessionHost, generation: number): boolean {
  const session = host.readSession();
  if (session === null || session.state !== "active" || session.sandboxGeneration !== generation) {
    return true;
  }
  const sql = host.objectCtx.storage.sql;
  return readStopRow(sql, generation) !== null || generationEnded(sql, generation);
}

/**
 * A provisioning whose generation ended under it writes nothing more: the stop
 * that ended it recorded the outcome. If a create was sent, the sandbox it may
 * have started is stopped by name, the same sweep a failure gets.
 */
function abandonGeneration(host: SessionHost, session: SessionRow, createIssued: boolean): void {
  if (createIssued) {
    sweepFrom(host, session, "abandoned");
  }
}

/**
 * Starts `sweepGeneration` for the session's current generation, reading what
 * it needs now, while the attachment row is certainly there: the sweep runs
 * after the provisioning mark is released, and its own awaits must not depend
 * on rows a later step (an erase, say) may remove.
 *
 * On Modal a late stop is owed first, whatever the sweep goes on to do: the
 * sweep lives in memory, so a controller that hangs through it, or an
 * eviction, would otherwise leave a sandbox running with nothing durable
 * owed. It is due when the last create can no longer land, or, when that has
 * already passed, one retry interval from now, after the sweep's own turn.
 */
function sweepFrom(host: SessionHost, session: SessionRow, why: "failed" | "abandoned"): void {
  const generation = session.sandboxGeneration;
  const sql = host.objectCtx.storage.sql;
  const attachment = readAttachment(sql, generation) as AttachmentFact;
  const landingMs = createLandingDeadline(host, generation);
  if (attachment.provider === "modal") {
    const nowMs = Date.now();
    writeLateStop(sql, {
      generation,
      provider: attachment.provider,
      dueAtMs: landingMs > nowMs ? landingMs : nowMs + LATE_STOP_RETRY_MS,
      attempts: 0,
    });
  }
  // Counted, so an erase waits for the sweep's last stop instead of ending
  // the object while a sandbox it has yet to stop may still be running.
  host.provisioningsPending += 1;
  host.objectCtx.waitUntil(
    sweepGeneration(
      host,
      session,
      { generation, provider: attachment.provider, landingMs },
      why,
    ).finally(() => {
      host.provisioningsPending -= 1;
    }),
  );
}

/**
 * Owes `generation` one more stop by name once its last create can no longer
 * land, when that is still ahead: a stop step's own terminate found nothing
 * while the create was in flight. Durable, so an eviction does not lose it;
 * the alarm runs it (`runLateStops`). One read by key.
 */
export function scheduleLateStop(
  host: SessionHost,
  generation: number,
  provider: "fake" | "modal",
): void {
  const landing = createLandingDeadline(host, generation);
  if (provider === "modal" && landing > Date.now()) {
    writeLateStop(host.objectCtx.storage.sql, {
      generation,
      provider,
      dueAtMs: landing,
      attempts: 0,
    });
  }
}

/**
 * The alarm's late stops: each due one is stopped by name. A refusal is
 * retried after `LATE_STOP_RETRY_MS`, up to `LATE_STOP_MAX_ATTEMPTS`, then
 * logged and named on the generation's output as possibly still running. At
 * most `LATE_STOPS_PER_ALARM` per wake.
 */
export async function runLateStops(host: SessionHost): Promise<void> {
  const session = host.readSession();
  if (session === null) {
    return;
  }
  const sql = host.objectCtx.storage.sql;
  for (const row of readDueLateStops(sql, Date.now(), LATE_STOPS_PER_ALARM)) {
    const stopped = await stopOnce(
      host,
      session,
      { state: "stopped", provider: row.provider, expiresAtMs: null },
      { sessionId: session.id, generation: row.generation },
    );
    if (stopped) {
      deleteLateStop(sql, row.generation);
      continue;
    }
    const attempts = row.attempts + 1;
    if (attempts < LATE_STOP_MAX_ATTEMPTS) {
      writeLateStop(sql, { ...row, attempts, dueAtMs: Date.now() + LATE_STOP_RETRY_MS });
      continue;
    }
    deleteLateStop(sql, row.generation);
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.provision",
      result: "late_sandbox_left_running",
      sandboxGeneration: String(row.generation),
      sessionId: session.id,
    });
    commitOutput(host, { ...session, sandboxGeneration: row.generation }, "controller", [
      {
        at: new Date().toISOString(),
        text: leftRunningNote(sandboxName(session.id, row.generation)),
      },
    ]);
  }
}

/**
 * An erase's last stop by name for each generation that failed after a create
 * was sent: the sweep and the late stop were the only attempts, and the row
 * that owed them is gone whether or not one landed. Stop converges, so a
 * sandbox already gone costs one answer. Returns whether every stop was
 * confirmed; the erase goes on either way, and a refusal is logged because
 * the timeline note that named the sandbox is erased with the session.
 */
export async function stopFailedGenerations(
  host: SessionHost,
  session: SessionRow,
): Promise<boolean> {
  let confirmed = true;
  const failed = readFailedCreatedGenerations(host.objectCtx.storage.sql, FINAL_STOP_GENERATIONS);
  for (const { generation, provider } of failed) {
    const stopped = await stopOnce(
      host,
      session,
      { state: "failed", provider, expiresAtMs: null },
      { sessionId: session.id, generation },
    );
    if (!stopped) {
      confirmed = false;
      log({
        timestamp: new Date().toISOString(),
        severity: "warn",
        service: "session-object",
        release: host.objectEnv.ONCUE_RELEASE,
        environment: host.objectEnv.ONCUE_ENV,
        operation: "session.deletion",
        result: "failed_sandbox_not_stopped",
        sandboxGeneration: String(generation),
        sessionId: session.id,
      });
    }
  }
  return confirmed;
}

/** When a create sent for `generation` can no longer land, or 0 when none was sent. */
function createLandingDeadline(host: SessionHost, generation: number): number {
  const notAfterMs = readCreateDeadline(host.objectCtx.storage.sql, generation);
  return notAfterMs === null ? 0 : notAfterMs + host.provisionPacing.createLandingGraceMs;
}

/** Shown once while a workspace builds the image, so a long start is explained. */
export const IMAGE_BUILDING_NOTE =
  "Building the sandbox image in your Modal workspace. The first session after an OnCue update can take several minutes.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record 02's prepare, create, start, and connection lookup for one
 * generation. Each provider call's time goes into `timings`.
 */
async function bringUp(
  host: SessionHost,
  driver: SandboxDriver,
  reference: SandboxReference,
  session: SessionRow,
  bootstrapCredential: string,
  timings: string[],
): Promise<BringUp> {
  const prepared = await prepareImage(host, driver, reference, session, timings);
  if (prepared.kind === "abandoned") {
    return { kind: "abandoned", createIssued: false };
  }
  if (prepared.kind !== "ok") {
    return { ...prepared, createIssued: false };
  }
  const created = await createOrAdopt(
    host,
    driver,
    {
      sessionId: reference.sessionId,
      generation: reference.generation,
      imageReference: prepared.value,
      resourceClass: "standard",
      regionPreference: null,
      expirationPolicy: "idle_20m",
      bootstrapCredential,
    },
    timings,
  );
  if (created.kind === "abandoned") {
    return { kind: "abandoned", createIssued: true };
  }
  if (created.kind !== "ok") {
    return { ...created, createIssued: true };
  }
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const began = Date.now();
    const outcome = await run();
    timings.push(`${name} answered in ${Date.now() - began} ms`);
    return outcome;
  };
  const started = await timed("start", () => driver.start(reference));
  if (stoppedMeanwhile(host, reference.generation)) {
    return { kind: "abandoned", createIssued: true };
  }
  if (started.kind !== "ok") {
    return { ...started, createIssued: true };
  }
  const connection = await timed("getConnection", () => driver.getConnection(reference));
  if (stoppedMeanwhile(host, reference.generation)) {
    return { kind: "abandoned", createIssued: true };
  }
  if (connection.kind !== "ok") {
    return { ...connection, createIssued: true };
  }
  return { kind: "ok", value: connection.value.bridgeUrl };
}

/**
 * Polls `prepareImage` until the image is ready in the workspace, bounded by
 * the pacing's budget and by `MAX_PREPARE_POLLS`. A `building` answer may
 * repeat for the whole budget, since a cold build takes minutes; a retryable
 * failure may repeat only `MAX_PREPARE_FAILURES` times in a row, since a
 * controller that keeps failing or not answering is not building anything.
 * After each answer it asks `stoppedMeanwhile` (three reads by key), so a
 * stop during a long build abandons it before anything is created.
 */
async function prepareImage(
  host: SessionHost,
  driver: SandboxDriver,
  reference: SandboxReference,
  session: SessionRow,
  timings: string[],
): Promise<DriverOutcome<string> | { readonly kind: "abandoned" }> {
  const pacing = host.provisionPacing;
  const began = Date.now();
  let announced = false;
  let lastError: DriverError | null = null;
  let failuresInARow = 0;
  for (
    let poll = 0;
    poll < MAX_PREPARE_POLLS && Date.now() - began < pacing.prepareBudgetMs;
    poll += 1
  ) {
    const pollBegan = Date.now();
    const answer = await driver.prepareImage(PREPARE_WAIT_MS);
    // Before acting on any answer, `ready` included: a stop during a long
    // build must not be followed by a create.
    if (stoppedMeanwhile(host, reference.generation)) {
      return { kind: "abandoned" };
    }
    if (answer.kind === "ok" && answer.value.state === "ready") {
      timings.push(`prepareImage answered in ${Date.now() - began} ms`);
      return { kind: "ok", value: answer.value.imageReference };
    }
    if (answer.kind !== "ok") {
      if (!answer.retryable) {
        return answer;
      }
      lastError = answer;
      failuresInARow += 1;
      if (failuresInARow >= MAX_PREPARE_FAILURES) {
        return {
          ...answer,
          message: `The sandbox image could not be prepared: ${MAX_PREPARE_FAILURES} tries in a row failed, the last with "${answer.message}" Send the message again to try once more.`,
        };
      }
    } else {
      lastError = null;
      failuresInARow = 0;
      if (!announced) {
        announced = true;
        commitOutput(host, session, "controller", [
          { at: new Date().toISOString(), text: IMAGE_BUILDING_NOTE },
        ]);
      }
    }
    const spent = Date.now() - pollBegan;
    if (spent < pacing.minPreparePollMs) {
      await sleep(pacing.minPreparePollMs - spent);
    }
  }
  return (
    lastError ?? {
      kind: "error",
      category: "image_preparation",
      message: `The sandbox image was still building in your Modal workspace after ${Math.round(
        pacing.prepareBudgetMs / 60_000,
      )} minutes. The build continues; send the message again to wait for it.`,
      retryable: true,
    }
  );
}

/**
 * Creates the generation's sandbox, retrying a retryable failure after each
 * of the pacing's delays. A failure may hide a create that landed although its
 * answer did not, so before each retry the sandbox is looked up by its name:
 * running, it is adopted; exited, the generation fails. The controller refuses
 * a second sandbox for a generation, so a retry never starts one.
 */
async function createOrAdopt(
  host: SessionHost,
  driver: SandboxDriver,
  spec: SandboxCreateSpec,
  timings: string[],
): Promise<DriverOutcome<SandboxReference> | { readonly kind: "abandoned" }> {
  const reference: SandboxReference = { sessionId: spec.sessionId, generation: spec.generation };
  const pacing = host.provisionPacing;
  const delays = pacing.createRetryDelaysMs;
  for (let attempt = 0; ; attempt += 1) {
    const began = Date.now();
    // Recorded before the create is sent, so a restart mid-call still knows
    // how long the sandbox may take to appear.
    const notAfterMs = began + pacing.createNotAfterMs;
    writeCreateDeadline(host.objectCtx.storage.sql, spec.generation, notAfterMs);
    const created = await driver.create({ ...spec, notAfter: new Date(notAfterMs).toISOString() });
    timings.push(
      `${attempt === 0 ? "create" : `create attempt ${attempt + 1}`} answered in ${Date.now() - began} ms`,
    );
    if (stoppedMeanwhile(host, spec.generation)) {
      return { kind: "abandoned" };
    }
    if (created.kind === "ok" || !created.retryable) {
      return created;
    }
    const status = await driver.getStatus(reference);
    if (stoppedMeanwhile(host, spec.generation)) {
      return { kind: "abandoned" };
    }
    if (status.kind === "ok") {
      if (LIVE_OR_STARTING_STATUS.has(status.value)) {
        timings.push("create did not succeed, but the sandbox was found running and adopted");
        return { kind: "ok", value: reference };
      }
      return {
        kind: "error",
        category: "unknown",
        message: "The sandbox started and exited before the session could attach to it.",
        retryable: false,
      };
    }
    const delay = delays[attempt];
    if (delay === undefined) {
      return created;
    }
    await sleep(delay);
    if (stoppedMeanwhile(host, spec.generation)) {
      return { kind: "abandoned" };
    }
  }
}

/**
 * Relays what the sandbox prints until its bridge connects, the only way to
 * learn why a bridge has not. Stops on the first of: the generation ending, a
 * driver error, the poll budget, or `OUTPUT_DRAIN_POLLS` polls after
 * `runtime.connected`. The driver's credential lives exactly as long as this loop.
 */
async function relaySandboxOutput(
  host: SessionHost,
  provider: SandboxProvider,
  driver: SandboxDriver,
  reference: SandboxReference,
  session: SessionRow,
): Promise<void> {
  // The fake has no entrypoint and its output is empty by construction;
  // polling it would wait two minutes for nothing.
  if (provider !== "modal") {
    return;
  }
  const deadline = Date.now() + OUTPUT_POLL_BUDGET_MS;
  let cursor: string | null = null;
  let drainLeft: number | null = null;
  while (Date.now() < deadline) {
    const fetched = await driver.getOutput(reference, cursor);
    if (fetched.kind !== "ok") {
      return;
    }
    cursor = fetched.value.next;
    host.commitOutputLines(session, fetched.value.lines);
    if (generationEnded(host.objectCtx.storage.sql, reference.generation)) {
      return;
    }
    if (drainLeft === null && bridgeConnected(host.objectCtx.storage.sql, reference.generation)) {
      drainLeft = OUTPUT_DRAIN_POLLS;
    }
    if (drainLeft !== null) {
      if (drainLeft === 0) {
        return;
      }
      drainLeft -= 1;
    }
    await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS));
  }
}

/** One `sandbox.output` event per stream present in the batch, in arrival order. */
export function commitOutputLines(
  host: SessionHost,
  session: SessionRow,
  lines: readonly SandboxOutputLine[],
): void {
  for (const stream of ["stdout", "stderr", "system"] as const) {
    const own = lines.filter((line) => line.stream === stream);
    if (own.length > 0) {
      commitOutput(
        host,
        session,
        stream,
        own.map((line) => ({ at: line.at, text: line.text })),
      );
    }
  }
}

function commitOutput(
  host: SessionHost,
  session: SessionRow,
  stream: "stdout" | "stderr" | "system" | "controller",
  lines: readonly { readonly at: string; readonly text: string }[],
): void {
  // Callers pass only non-empty batches; `lastOutputCursor` relies on it.
  const now = new Date().toISOString();
  host.commitControlEvents(
    session,
    [
      buildEvent("sandbox.output", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: { stream, lines: [...lines] },
      }),
    ],
    now,
    () => undefined,
  );
}

/**
 * Record 02: a permanent failure leaves the session readable and names its
 * category, the driver's translation of the provider's error. The run ends at
 * stage `provisioning`, the only state a queued run can reach before `failed`.
 */
export function failProvisioning(
  host: SessionHost,
  session: SessionRow & { readonly currentRunId: string },
  failure: Extract<DriverOutcome<unknown>, { readonly kind: "error" }>,
  startedAtMs: number,
  /**
   * Whether a create was ever sent for this generation. Only then can a
   * sandbox exist, whether or not its id was ever learned: a create whose
   * answer was lost leaves a running sandbox with no id recorded.
   */
  createIssued = true,
): void {
  const failedAt = new Date().toISOString();
  // The fake's `start` attaches its bridge before a later step can fail; a
  // generation that failed to provision keeps no bridge.
  host.closeAttachedBridges();
  log({
    timestamp: failedAt,
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.provision",
    result: "failed",
    errorCategory: failure.category,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  const events: ProtocolEvent[] = [
    buildEvent("sandbox.stopped", {
      eventId: crypto.randomUUID(),
      sessionId: session.id,
      runId: null,
      sandboxGeneration: session.sandboxGeneration,
      runtimeSequence: null,
      occurredAt: failedAt,
      payload: {
        outcome: "failed",
        reason: "provisioning_failed",
        checkpointId: null,
        unsavedWorkWarning: `${failure.category}: ${failure.message}`,
        diagnostics: [],
      },
    }),
  ];
  // A run the user cancelled meanwhile keeps that outcome: the failure is the
  // sandbox's, not a second ending for the run.
  if (
    !isTerminal("run", readRunState(host.objectCtx.storage.sql, session.currentRunId) as RunState)
  ) {
    events.push(
      buildEvent("run.failed", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: session.currentRunId,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: failedAt,
        payload: {
          stage: "provisioning",
          error: { category: failure.category, message: failure.message },
          summary: null,
          evidence: [],
          branch: null,
          pullRequestNumber: null,
          usage: null,
          durationMs: Date.now() - startedAtMs,
        },
      }),
    );
  }
  host.commitControlEvents(session, events, failedAt, () => {
    host.objectCtx.storage.sql.exec(
      "UPDATE sandbox_attachment SET state = 'failed' WHERE generation = ?",
      session.sandboxGeneration,
    );
    host.objectCtx.storage.sql.exec(
      "UPDATE run SET state = 'failed', outcome = 'failed', ended_at = ? WHERE id = ? AND outcome IS NULL",
      failedAt,
      session.currentRunId,
    );
  });
  if (createIssued) {
    sweepFrom(host, session, "failed");
  }
}

/** The line a failed generation's sandbox output ends with when its sandbox could not be stopped. */
export function leftRunningNote(sandboxName: string): string {
  return `OnCue could not stop this generation's sandbox. It may still be running and billing your Modal account: stop ${sandboxName} in the oncue-sessions app from Modal's dashboard.`;
}

/** `services/sandbox-controller/sandboxes.py`'s `sandbox_name`, so the note names what Modal shows. */
export function sandboxName(sessionId: string, generation: number): string {
  const suffix = `-g${generation}`;
  return `s-${sessionId}`.slice(0, 64 - suffix.length) + suffix;
}

/**
 * A failed or abandoned generation may hold a running sandbox that bills the
 * workspace, found by its name whether or not its id was ever recorded, so it
 * is stopped. Stop converges ("absent is success"), and on Modal it is
 * repeated after each of the pacing's delays, each counted from the stop
 * before it, because a create whose answer was lost can land after an earlier
 * stop found nothing. A stop that succeeds once the last create can no longer
 * land pays the late stop `sweepFrom` owed; until one does, that late stop
 * stays owed, and it alone says a sandbox may have been left running. No stop
 * row: a generation that never became the session's sandbox has nothing to
 * checkpoint or revoke. It takes the generation and provider as arguments and
 * reads no row of its own, and it commits nothing.
 */
async function sweepGeneration(
  host: SessionHost,
  session: SessionRow,
  target: {
    readonly generation: number;
    readonly provider: "fake" | "modal";
    readonly landingMs: number;
  },
  why: "failed" | "abandoned",
): Promise<void> {
  const { generation, provider, landingMs } = target;
  const attachment: AttachmentFact = { state: "failed", provider, expiresAtMs: null };
  const delays = provider === "modal" ? host.provisionPacing.failedStopDelaysMs : [0];
  const reference = { sessionId: session.id, generation };
  let stopped = false;
  for (const delay of delays) {
    if (delay > 0) {
      await sleep(delay);
    }
    const sentAtMs = Date.now();
    stopped = await stopOnce(host, session, attachment, reference);
    if (stopped && sentAtMs >= landingMs) {
      deleteLateStop(host.objectCtx.storage.sql, generation);
    }
  }
  log({
    timestamp: new Date().toISOString(),
    severity: stopped ? "info" : "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.provision",
    result: stopped ? `${why}_sandbox_stopped` : `${why}_sandbox_not_stopped`,
    sandboxGeneration: String(generation),
    sessionId: session.id,
  });
}

async function stopOnce(
  host: SessionHost,
  session: SessionRow,
  attachment: AttachmentFact,
  reference: SandboxReference,
): Promise<boolean> {
  try {
    const driver = host.driverForGeneration(attachment, await host.openCredential(session));
    return driver !== null && (await driver.stop(reference)).kind === "ok";
  } catch {
    // The credential read or the driver threw: the sandbox may still be
    // running, which is what the caller reports.
    return false;
  }
}
