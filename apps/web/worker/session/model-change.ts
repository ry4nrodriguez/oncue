// Whether a `run.start` changes the session's model, and whether it may
// (record 15). A session's runs keep the model of the run before them unless
// the owner names another on the message that starts the next run. The browser
// sends a whole model record; nothing of a changed one is trusted but the
// connection and model it names, and the record the run stores is built here
// from the workspace's own connection row and the catalog. Pure: the caller
// reads the connection row and supplies the harness check.

import {
  type EffortLevel,
  isTerminal,
  MODEL_SWITCH_CAPABILITY,
  type ModelRecord,
  RUNTIME_CATALOG,
  type RunState,
  type RuntimeId,
} from "@oncue/protocol";
import { modelAllowed } from "../broker/model-guard";
import { acceptsEffort, findModel } from "../broker/providers/catalog";
import type { RuntimeResolution } from "../runtime/resolve";

/** The three facts that make a run's model: whose key, which provider, which model. */
export function sameModel(
  a: Pick<ModelRecord, "provider" | "modelId" | "modelConnectionId">,
  b: Pick<ModelRecord, "provider" | "modelId" | "modelConnectionId">,
): boolean {
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.modelConnectionId === b.modelConnectionId
  );
}

/** The named connection's row in the session's own workspace. */
export interface ConnectionFact {
  readonly provider: string;
  readonly authType: string;
  readonly status: string;
}

export interface ModelChangeInput {
  /** The record the `run.start` carries, as the browser built it. */
  readonly requested: ModelRecord;
  readonly continuesRunId: string | null;
  readonly checksOnly: boolean;
  /** The session's latest run and the record it was queued with; null before any run. */
  readonly latest: {
    readonly runId: string;
    readonly state: RunState;
    readonly model: ModelRecord;
  } | null;
  /** Null when no such connection belongs to the workspace. Read only when the model differs. */
  readonly connection: ConnectionFact | null;
  readonly envName: string;
  readonly modelAllowlist: string | undefined;
  /** `resolveRuntime` for the session's harness against the changed model. */
  readonly resolveRuntime: (provider: string, effort: EffortLevel | null) => RuntimeResolution;
}

export type ModelChangeDecision =
  /** The run continues on the latest run's model: nothing here applies. */
  | { readonly kind: "same" }
  | {
      readonly kind: "changed";
      /** The record the run stores, built from the connection row and the catalog. */
      readonly model: ModelRecord;
      /** A paused or interrupted run the change ends first, or null when the latest run has ended. */
      readonly supersedesRunId: string | null;
    }
  | {
      readonly kind: "refused";
      readonly reason: "wrong_state" | "unsupported";
      /** Fixed wording, never a provider's: only rows and the catalog were read. */
      readonly detail: string;
    };

function refused(
  reason: "wrong_state" | "unsupported",
  detail: string,
): Extract<ModelChangeDecision, { kind: "refused" }> {
  return { kind: "refused", reason, detail };
}

/**
 * ```
 * no run yet, or the same connection, provider, and model  -> same
 * a checks-only run                                        -> refused: it prompts no model
 * continues another run than the latest                    -> refused: the choice was made against an older run
 * the latest run is still working                          -> refused: the model changes only between runs
 * the latest run is paused or interrupted                  -> changed, and that run is ended first
 * the connection is absent or another workspace's          -> refused, as one answer
 * the connection is not active                             -> refused
 * the model is not the connection's provider's, or not in the catalog -> refused
 * the effort is not one the model offers                   -> refused
 * a local Worker pinned to other models                    -> refused
 * the session's harness cannot run it                      -> refused
 * otherwise                                                -> changed
 * ```
 */
export function decideModelChange(input: ModelChangeInput): ModelChangeDecision {
  const { requested, latest } = input;
  if (latest === null || sameModel(requested, latest.model)) {
    return { kind: "same" };
  }
  if (input.checksOnly) {
    return refused("unsupported", "a checks-only run prompts no model, so it cannot change it");
  }
  if (input.continuesRunId !== latest.runId) {
    return refused(
      "wrong_state",
      "the model can be changed only on a message that continues the session's latest run",
    );
  }
  const ended = isTerminal("run", latest.state);
  if (!ended && latest.state !== "paused" && latest.state !== "interrupted") {
    return refused(
      "wrong_state",
      "the model can be changed only between runs; stop this run first",
    );
  }
  const connection = input.connection;
  if (connection === null) {
    return refused("wrong_state", "that model connection is not available in this workspace");
  }
  if (connection.status !== "active") {
    return refused(
      "wrong_state",
      "that model connection is not active; add a working key under Settings, Model providers",
    );
  }
  const spec =
    connection.provider === requested.provider
      ? findModel(connection.provider, requested.modelId)
      : null;
  if (spec === null) {
    return refused("unsupported", "that model is not one this connection's provider offers");
  }
  // No effort named opens on the model's own default, as a new session does.
  const effort = requested.effort === undefined ? spec.defaultEffort : requested.effort;
  if (!acceptsEffort(spec, effort)) {
    return refused("unsupported", "that model does not offer that effort level");
  }
  if (!modelAllowed(input.envName, input.modelAllowlist, spec.modelId)) {
    return refused("unsupported", "this OnCue is pinned to other models");
  }
  const runtime = input.resolveRuntime(connection.provider, effort);
  if (runtime.kind === "refused") {
    return refused("unsupported", runtime.detail);
  }
  return {
    kind: "changed",
    model: {
      provider: connection.provider,
      modelId: spec.modelId,
      modelConnectionId: requested.modelConnectionId,
      authenticationType: connection.authType === "subscription" ? "subscription" : "api_key",
      contextWindow: spec.contextWindow,
      effort,
    },
    supersedesRunId: ended ? null : latest.runId,
  };
}

/**
 * Whether the sandbox now attached can take the changed model on its next
 * prompt. The harness must be one that takes a model per prompt, and the
 * bridge must have said it configures the harness for every model the grant
 * lists; an older bridge bundle says nothing and would prompt a harness that
 * was never configured for the model. Otherwise the change goes to a new
 * generation.
 */
export function canSwitchLive(
  runtime: RuntimeId,
  bridgeCapabilities: readonly string[] | null,
): boolean {
  return (
    RUNTIME_CATALOG[runtime].liveModelSwitch &&
    bridgeCapabilities?.includes(MODEL_SWITCH_CAPABILITY) === true
  );
}
