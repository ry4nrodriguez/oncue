// Resuming on a new generation and the durable context summary its first
// prompt carries.

import type { DeliverableCommand } from "@oncue/bridge";
import {
  isTerminal,
  type ProtocolCommand,
  type ProtocolEvent,
  type ProtocolEventOf,
  parseCommandPayload,
  type RunState,
} from "@oncue/protocol";
import { readControllerConfig } from "../../sandbox/origin";
import { cloneBranch } from "../branch-naming";
import { planCompute, type StopEffect, type StopRow } from "../lifecycle";
import { composeResumeContext, resumeBudgetChars } from "../resume-context";
import { foldReplay, REPLAY_READS, RESUME_PROMPT_TEXT, type ReplayRow } from "../resume-replay";
import { mintBootstrap } from "./credentials";
import type { SessionHost } from "./host";
import { pushedTaskBranch, readBaseBranch, readLastCheckpoint } from "./store-git";
import { readStopRow } from "./store-lifecycle";
import { readPolicy, readRunModel, readRunState } from "./store-session";
import type { SessionRow } from "./types";

/**
 * Whether an admitted command that needs compute went to a new generation.
 * A `run.start` with no sandbox resumes the session; a Continue on a paused or
 * interrupted run resumes that run. Either waits out a stop under way, whose
 * last step picks the work up, and joins a resume still committing its generation.
 */
export async function resumeFor(
  host: SessionHost,
  command: ProtocolCommand,
  mintedRunId: string,
): Promise<boolean> {
  const isContinue =
    command.type === "run.follow_up" && command.payload.delivery === "steer_current_run";
  if (command.type !== "run.start" && !isContinue) {
    return false;
  }
  if (host.resuming !== null) {
    await host.resuming;
  }
  const session = host.readSession() as SessionRow;
  const runId = isContinue ? (command.runId as string) : mintedRunId;
  const runState = readRunState(host.objectCtx.storage.sql, runId);
  if (isContinue && runState !== "paused" && runState !== "interrupted") {
    return false;
  }
  const decision = planCompute(host.lifecycleView(session, Date.now()));
  if (decision.kind === "attached") {
    return false;
  }
  if (decision.kind === "provision") {
    const start = isContinue
      ? startFromMessage(
          host,
          session,
          runId,
          command as Extract<ProtocolCommand, { type: "run.follow_up" }>,
        )
      : (command as DeliverableCommand);
    beginResume(host, session, runId, start, null);
  }
  return true;
}

/**
 * Resumes a paused or interrupted run on a new generation with OnCue's own
 * message, as Continue does with the user's: the answers to a question given
 * after its sandbox stopped. False when the run is not stopped or a sandbox is
 * live or starting.
 */
export async function resumeRunWith(
  host: SessionHost,
  runId: string,
  message: {
    readonly commandId: string;
    readonly issuedAt: string;
    readonly issuedByUserId: string;
    readonly text: string;
  },
): Promise<boolean> {
  if (host.resuming !== null) {
    await host.resuming;
  }
  const session = host.readSession() as SessionRow;
  const runState = readRunState(host.objectCtx.storage.sql, runId);
  if (
    (runState !== "paused" && runState !== "interrupted") ||
    planCompute(host.lifecycleView(session, Date.now())).kind !== "provision"
  ) {
    return false;
  }
  // OnCue's own message, checked against the same schema as the user's: one
  // that broke a bound would be refused by the bridge after the sandbox started.
  const payload = parseCommandPayload("run.start", {
    instruction: { messageId: crypto.randomUUID(), text: message.text, attachments: [] },
    model: readRunModel(host.objectCtx.storage.sql, runId),
    continuesRunId: null,
  });
  if (!payload.ok) {
    return false;
  }
  const start: DeliverableCommand = {
    commandId: message.commandId as DeliverableCommand["commandId"],
    sessionId: session.id as DeliverableCommand["sessionId"],
    runId: null,
    issuedAt: message.issuedAt,
    issuedByUserId: message.issuedByUserId as DeliverableCommand["issuedByUserId"],
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: payload.value,
  };
  beginResume(host, session, runId, start, null);
  return true;
}

/** The `run.start` a fresh OpenCode needs to continue a run: the follow-up's own message, on the run's own model. */
function startFromMessage(
  host: SessionHost,
  session: SessionRow,
  runId: string,
  command: Extract<ProtocolCommand, { type: "run.follow_up" }>,
): DeliverableCommand {
  return {
    commandId: command.commandId,
    sessionId: session.id,
    runId: null,
    issuedAt: command.issuedAt,
    issuedByUserId: command.issuedByUserId,
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: {
        messageId: command.payload.messageId,
        text: command.payload.text,
        attachments: command.payload.attachments,
      },
      model: readRunModel(host.objectCtx.storage.sql, runId),
      continuesRunId: null,
      ...(command.payload.skipRequiredChecks === undefined
        ? {}
        : { skipRequiredChecks: command.payload.skipRequiredChecks }),
    },
  } as unknown as DeliverableCommand;
}

/**
 * A run's own `run.start`, rebuilt from its `run.queued`, for a generation
 * that did not exist when the run was admitted or ended before it started.
 * Commands are delivered once per id and the old generation's row stays, so
 * the start goes under a fresh command id with the same instruction.
 */
function queuedStartFor(host: SessionHost, session: SessionRow, runId: string): DeliverableCommand {
  const event = JSON.parse(
    host.objectCtx.storage.sql
      .exec<{ envelope_json: string }>(
        "SELECT envelope_json FROM event WHERE event_type = 'run.queued' AND run_id = ?",
        runId,
      )
      .one().envelope_json,
  ) as ProtocolEventOf<"run.queued">;
  const delivered =
    host.objectCtx.storage.sql
      .exec<{ delivered: number }>(
        "SELECT EXISTS(SELECT 1 FROM bridge_dispatch WHERE intent_id = ?) AS delivered",
        event.payload.commandId,
      )
      .one().delivered === 1;
  const skipRequiredChecks =
    host.objectCtx.storage.sql
      .exec<{ skip: number }>(
        "SELECT EXISTS(SELECT 1 FROM check_skip_request WHERE message_id = ?) AS skip",
        event.payload.instruction.messageId,
      )
      .one().skip === 1;
  return {
    commandId: delivered ? crypto.randomUUID() : event.payload.commandId,
    sessionId: session.id,
    runId: null,
    issuedAt: event.occurredAt,
    issuedByUserId: session.ownerUserId,
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: event.payload.instruction,
      model: event.payload.model,
      continuesRunId: event.payload.continuesRunId,
      ...(skipRequiredChecks ? { skipRequiredChecks: true } : {}),
    },
  } as unknown as DeliverableCommand;
}

/**
 * Starts a new generation. `committed` releases a second resume once
 * `sandbox.provisioning` commits, so it joins instead of making another. The
 * Modal pair is opened for this provisioning alone; if a deployment with a
 * controller cannot open it, the resume is refused rather than run on the fake.
 */
function beginResume(
  host: SessionHost,
  session: SessionRow,
  runId: string,
  start: DeliverableCommand | null,
  replaced: { readonly previousGeneration: number; readonly restoredFrom: string | null } | null,
): void {
  // Assigned by the executor, which runs before the next line.
  let release: () => void;
  const joined = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.resuming = joined;
  const replacing = replaced === null ? null : replaced.previousGeneration;
  host.replacing = replacing;
  const reason = replaced === null ? "resume" : "replacement";
  const work = async (): Promise<void> => {
    const bootstrap = await mintBootstrap();
    const credential = await host.openCredential(session);
    // Checked after the last await before `sandbox.provisioning` commits (the
    // bootstrap hash is made first and `provisionSandbox` awaits nothing before
    // its commit). A user's stop during the credential read cancelled a
    // replacement and ended its runs; a run that ended any other way is not
    // started either.
    const replacementCancelled =
      replaced !== null &&
      (readStopRow(host.objectCtx.storage.sql, replaced.previousGeneration) as StopRow).cause ===
        "user_requested";
    // Archiving or deleting the session meanwhile is `provisionSandbox`'s to
    // catch, before it commits anything.
    if (
      replacementCancelled ||
      (start !== null &&
        isTerminal("run", readRunState(host.objectCtx.storage.sql, runId) as RunState))
    ) {
      return;
    }
    if (
      credential === null &&
      readControllerConfig(host.objectEnv, host.objectEnv.ONCUE_ENV).kind === "configured"
    ) {
      if (start !== null) {
        host.failRun(
          session,
          runId,
          "provisioning",
          "modal_connection_unavailable",
          "The workspace's Modal connection could not be opened, so the session could not start a new sandbox.",
        );
      }
      return;
    }
    await host.provisionSandbox(
      { ...session, currentRunId: runId },
      start,
      new Date().toISOString(),
      {},
      credential,
      {
        reason,
        replaced,
        context: start === null ? null : host.composeContext(session, reason, start),
        committed: release,
        bootstrap,
      },
    );
  };
  host.objectCtx.waitUntil(
    work().finally(() => {
      release();
      if (host.resuming === joined) {
        host.resuming = null;
        host.replacing = null;
      }
    }),
  );
}

/** The stop's last step: a `run.start` admitted while the stop was under way is owed a new generation now. */
export async function resumeIfOwed(host: SessionHost): Promise<void> {
  const session = host.readSession() as SessionRow;
  const runId = session.currentRunId as string;
  if (
    session.state !== "active" ||
    readRunState(host.objectCtx.storage.sql, runId) !== "queued" ||
    planCompute(host.lifecycleView(session, Date.now())).kind !== "provision"
  ) {
    return;
  }
  beginResume(host, session, runId, queuedStartFor(host, session, runId), null);
}

/**
 * The ceiling's last step, read fresh. A `run.start` admitted during the stop
 * waited for this step, and its run is carried in place of the interrupted
 * one, which stays interrupted with its checkpoint. So is a run the old
 * generation was given but never started, which would otherwise sit `ready`
 * on a sandbox that no longer exists.
 */
export function provisionReplacement(
  host: SessionHost,
  session: SessionRow,
  effect: Extract<StopEffect, { readonly kind: "provision_replacement" }>,
): void {
  const current = host.readSession() as SessionRow;
  const runId = current.currentRunId as string;
  const runState = readRunState(host.objectCtx.storage.sql, runId);
  if (runState === "queued" || runState === "provisioning" || runState === "ready") {
    beginResume(host, current, runId, queuedStartFor(host, current, runId), {
      previousGeneration: effect.previousGeneration,
      restoredFrom: effect.restoredFrom,
    });
    return;
  }
  const start =
    effect.resumeRunId === null
      ? null
      : ({
          commandId: crypto.randomUUID(),
          sessionId: session.id,
          runId: null,
          issuedAt: new Date().toISOString(),
          issuedByUserId: session.ownerUserId,
          expected: { scope: "session", state: "active" },
          type: "run.start",
          payload: {
            instruction: {
              messageId: crypto.randomUUID(),
              text: RESUME_PROMPT_TEXT,
              attachments: [],
            },
            model: readRunModel(host.objectCtx.storage.sql, effect.resumeRunId),
            continuesRunId: null,
          },
        } as unknown as DeliverableCommand);
  beginResume(host, session, runId, start, {
    previousGeneration: effect.previousGeneration,
    restoredFrom: effect.restoredFrom,
  });
}

const REPLAY_READ = `SELECT session_sequence, run_id, envelope_json FROM event WHERE event_type = ?
  ORDER BY sandbox_generation DESC, session_sequence DESC LIMIT ?`;

/**
 * The same read over the primary agent's rows alone. The filter repeats the
 * index's own, and the index is named so the read fails rather than scans if
 * the two ever disagree.
 */
const PRIMARY_REPLAY_READ = `SELECT session_sequence, run_id, envelope_json FROM event INDEXED BY idx_event_primary_type
  WHERE event_type = ?
    AND CASE WHEN json_valid(envelope_json) THEN json_extract(envelope_json, '$.payload.agentId') END IS NULL
  ORDER BY sandbox_generation DESC, session_sequence DESC LIMIT ?`;

/**
 * Record 11's durable context summary for a resumed run's first prompt: a
 * replay of committed events (`resume-replay.ts`), read once per resume with
 * a bound per event type. The start's own instruction is left out so the agent
 * does not get it twice; a replacement's "continue" prompt is never quoted.
 */
export function composeContext(
  host: SessionHost,
  session: SessionRow,
  reason: "resume" | "replacement",
  start: DeliverableCommand,
): string {
  const latest = (sql: string, ...params: (string | number)[]): string | undefined =>
    host.objectCtx.storage.sql.exec<{ envelope_json: string }>(sql, ...params).toArray()[0]
      ?.envelope_json;
  const repository = host.objectCtx.storage.sql
    .exec<{ full_name: string; task_branch: string | null }>(
      "SELECT full_name, task_branch FROM session_repository LIMIT 1",
    )
    .toArray()[0];
  const stopped = latest(
    "SELECT envelope_json FROM event WHERE event_type = 'sandbox.stopped' AND sandbox_generation = ? ORDER BY session_sequence DESC LIMIT 1",
    session.sandboxGeneration,
  );
  // The prompt's own instruction is left out: the agent receives it as the prompt.
  const startCommand = start as unknown as Extract<ProtocolCommand, { type: "run.start" }>;
  const rows: ReplayRow[] = [];
  for (const read of REPLAY_READS) {
    // One type per read, in the index's own order, so the bound stops the read
    // rather than a sort after it.
    for (const row of host.objectCtx.storage.sql
      .exec<{ session_sequence: number; run_id: string | null; envelope_json: string }>(
        read.primaryOnly === true ? PRIMARY_REPLAY_READ : REPLAY_READ,
        read.type,
        read.limit,
      )
      .toArray()) {
      rows.push({
        sequence: row.session_sequence,
        runId: row.run_id,
        event: JSON.parse(row.envelope_json) as ProtocolEvent,
      });
    }
  }
  const replay = foldReplay({
    rows,
    promptMessageId: startCommand.payload.instruction.messageId,
  });
  return composeResumeContext({
    reason,
    repository:
      repository === undefined
        ? null
        : {
            fullName: repository.full_name,
            branch: cloneBranch(
              pushedTaskBranch(host.objectCtx.storage.sql, repository.task_branch),
              readBaseBranch(host.objectCtx.storage.sql),
            ),
          },
    checkpoint: readLastCheckpoint(host.objectCtx.storage.sql),
    lostWork:
      stopped === undefined
        ? null
        : (JSON.parse(stopped) as ProtocolEventOf<"sandbox.stopped">).payload.unsavedWorkWarning,
    turns: replay.turns,
    unreadEarlierTurns: replay.unreadEarlierTurns,
    plan: replay.plan,
    policy: readPolicy(host.objectCtx.storage.sql).policy,
    budgetChars: resumeBudgetChars(startCommand.payload.model.contextWindow),
  });
}
