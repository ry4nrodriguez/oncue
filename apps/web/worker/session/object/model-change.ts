// The session object's side of a model change (record 15): the reads
// `decideModelChange` needs, the paused run a change ends, and whether the
// changed run can start in the sandbox now attached.

import {
  DEFAULT_RUNTIME_ID,
  isRuntimeId,
  type ModelRecord,
  type ProtocolCommand,
  type ProtocolEventOf,
  type RunState,
} from "@oncue/protocol";
import { resolveRuntime } from "../../runtime/resolve";
import { isLive } from "../lifecycle";
import {
  type ConnectionFact,
  canSwitchLive,
  decideModelChange,
  type ModelChangeDecision,
  sameModel,
} from "../model-change";
import type { SessionHost } from "./host";
import { cancelRun } from "./session-state";
import { readRunModel, readRunState, readRuntimeId } from "./store-session";
import type { SessionRow } from "./types";

type RunStart = Extract<ProtocolCommand, { type: "run.start" }>;

/** The reason on the cancel command that ends a run a model change replaces. */
const MODEL_CHANGE_CANCEL_REASON = "The model was changed, so a new run continues this one.";

/**
 * Whether a `run.start` keeps the session's model, changes it, or is refused.
 * A start on the latest run's model reads nothing more; only a changed one
 * reads the named connection, in the session's own workspace.
 */
export async function decideRunModel(
  host: SessionHost,
  session: SessionRow,
  command: RunStart,
): Promise<ModelChangeDecision> {
  const sql = host.objectCtx.storage.sql;
  const runId = session.currentRunId;
  if (runId === null) {
    return { kind: "same" };
  }
  const model = readRunModel(sql, runId);
  if (sameModel(command.payload.model, model)) {
    return { kind: "same" };
  }
  const row = await host.objectEnv.DB.prepare(
    "SELECT provider, auth_type, status FROM model_connection WHERE connection_id = ? AND workspace_id = ?",
  )
    .bind(command.payload.model.modelConnectionId, session.workspaceId)
    .first<{ provider: string; auth_type: string; status: string }>();
  const connection: ConnectionFact | null =
    row === null ? null : { provider: row.provider, authType: row.auth_type, status: row.status };
  const env = host.objectEnv as {
    readonly ONCUE_ENV: string;
    readonly ONCUE_MODEL_ALLOWLIST?: string | undefined;
    readonly ONCUE_RUNTIME_ALLOWLIST?: string | undefined;
  };
  return decideModelChange({
    requested: command.payload.model,
    continuesRunId: command.payload.continuesRunId,
    checksOnly: command.payload.checksOnly === true,
    latest: { runId, state: readRunState(sql, runId) as RunState, model },
    connection,
    envName: env.ONCUE_ENV,
    modelAllowlist: env.ONCUE_MODEL_ALLOWLIST,
    resolveRuntime: (provider, effort) =>
      resolveRuntime({
        requested: readRuntimeId(sql) ?? undefined,
        allowlist: env.ONCUE_RUNTIME_ALLOWLIST,
        provider,
        effort,
      }),
  });
}

/** The command with the record the object built in place of the browser's. */
export function withModel(command: RunStart, model: ModelRecord): RunStart {
  return { ...command, payload: { ...command.payload, model } };
}

/**
 * Ends the paused or interrupted run a model change replaces, as the owner's
 * cancel. A run records one model, so the work continues as a new run rather
 * than by changing this one.
 */
export function supersedeRun(host: SessionHost, session: SessionRow, runId: string): Promise<void> {
  return cancelRun(host, session, runId, MODEL_CHANGE_CANCEL_REASON);
}

/** What the bridge of a generation said it can do on its newest `runtime.connected`, or null before any. */
function readBridgeCapabilities(sql: SqlStorage, generation: number): readonly string[] | null {
  const row = sql
    .exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'runtime.connected' AND sandbox_generation = ? ORDER BY session_sequence DESC LIMIT 1",
      generation,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : (JSON.parse(row.envelope_json) as ProtocolEventOf<"runtime.connected">).payload.capabilities;
}

/** Where a run on a changed model starts. */
export type ChangedRunPlace =
  /** Through the usual path: the attached sandbox takes it, or none is attached and one is started. */
  | "dispatch"
  /** A stop is under way; its last step starts the queued run on a new generation. */
  | "after_stop"
  /** The attached harness cannot take the model, so the sandbox is stopped and replaced. */
  | "new_sandbox";

/**
 * Where a run on a changed model starts. With no live sandbox the start
 * resumes on a new generation anyway. During a stop nothing more is sent to
 * the sandbox that is ending. Before the generation's first model grant the
 * harness has not started, and that grant will name the changed model.
 * Otherwise the harness is up on the old model, and the run stays only if the
 * harness can take the new one on its next prompt.
 */
export function placeChangedRun(host: SessionHost, session: SessionRow): ChangedRunPlace {
  const view = host.lifecycleView(session, Date.now());
  if (!isLive(view.attachment)) {
    return "dispatch";
  }
  if (view.stop !== null) {
    return "after_stop";
  }
  const granted = host
    .readDispatchState(session)
    .rows.some((row) => row.kind.kind === "model_grant");
  if (!granted) {
    return "dispatch";
  }
  const runtime = readRuntimeId(host.objectCtx.storage.sql);
  return canSwitchLive(
    isRuntimeId(runtime) ? runtime : DEFAULT_RUNTIME_ID,
    readBridgeCapabilities(host.objectCtx.storage.sql, session.sandboxGeneration),
  )
    ? "dispatch"
    : "new_sandbox";
}

/**
 * Moves a changed run to a new sandbox: the attached one checkpoints and
 * stops as an idle one does, so unpushed work is kept, and the stop's last
 * step starts the queued run on a new generation, whose harness starts on the
 * changed model.
 */
export async function moveChangedRunToNewSandbox(
  host: SessionHost,
  session: SessionRow,
): Promise<void> {
  await host.stopGeneration("idle", session.ownerUserId, await host.openCredential(session));
}
