/**
 * Changing a session's model (record 15). The owner picks another model in
 * the composer's agent chip, a note under the composer says what it charges
 * and what it lacks, and the choice rides the message that starts the next
 * run. The
 * session object decides whether the change is allowed and builds the run's
 * record itself, so nothing here is trusted beyond which connection and model
 * were named.
 */
import type { EffortLevel, ModelRecord, RunView } from "@oncue/protocol";
import { PROVIDER_LABEL } from "@/features/model-connections/connection-status";
import { compactTokens } from "./context-meter";
import type { ModelRow } from "./ModelPicker";

/** The model the owner chose for the next run. */
export interface ModelSwitch {
  readonly connectionId: string;
  readonly modelId: string;
}

/**
 * Whether the session's model can be changed now: between runs, or on a run
 * that is paused or interrupted, which the change ends and continues as a new
 * run. A run that is working keeps its model.
 */
export function canSwitchModel(run: Pick<RunView, "state" | "outcome" | "model"> | null): boolean {
  if (run === null || run.model === null) {
    return false;
  }
  return run.outcome !== null || run.state === "paused" || run.state === "interrupted";
}

/** Whether a picked row is another model than the run's own, by connection and model. */
export function isAnotherModel(run: Pick<RunView, "model"> | null, choice: ModelSwitch): boolean {
  const model = run?.model ?? null;
  return (
    model === null ||
    model.modelConnectionId !== choice.connectionId ||
    model.modelId !== choice.modelId
  );
}

/** The row a choice names among the workspace's connections, or undefined once its key is gone. */
export function switchRowOf(
  rows: readonly ModelRow[],
  choice: ModelSwitch | null,
): ModelRow | undefined {
  return choice === null
    ? undefined
    : rows.find(
        (row) => row.connectionId === choice.connectionId && row.modelId === choice.modelId,
      );
}

/**
 * The record a `run.start` carries for the changed model. The object rebuilds
 * it from its own rows; the protocol's shape still needs every field. Null
 * for a row with no provider or catalog entry, which cannot be a change.
 */
export function switchRecord(
  row: ModelRow,
  effort: EffortLevel | null | undefined,
): ModelRecord | null {
  if (row.provider === undefined || row.spec === null) {
    return null;
  }
  const offered = row.spec.effort;
  const level =
    offered === null
      ? null
      : effort !== null && effort !== undefined && offered.includes(effort)
        ? effort
        : row.spec.defaultEffort;
  return {
    provider: row.provider,
    modelId: row.modelId,
    modelConnectionId: row.connectionId,
    authenticationType: "api_key",
    contextWindow: row.spec.contextWindow,
    effort: level,
  };
}

/** What the note under the composer says about a chosen model. */
export interface SwitchSummary {
  readonly modelName: string;
  /** Whose key the next run charges, in the connection's own words. */
  readonly charged: string;
  /** The effort the next run opens on, or null for a model with none. */
  readonly effort: EffortLevel | null;
  /** Warnings that the conversation does not fit the other model's window; usually empty. */
  readonly shortfalls: readonly string[];
  /** Set when the change ends a paused or interrupted run rather than following an ended one. */
  readonly endsRun: boolean;
}

/** Whose key a row charges: the provider, and the connection's own label where it says more. */
export function chargedTo(row: ModelRow): string {
  if (row.provider === undefined) {
    return row.label;
  }
  const key = `${PROVIDER_LABEL[row.provider]} key`;
  return row.label === row.provider ? key : `${key} (${row.label})`;
}

/** The share of a window past which a conversation is called close to it. */
export const NEAR_WINDOW = 0.8;

/**
 * The note's facts. The one warning is a conversation that does not fit the
 * other model's context window, or nearly fills it, since earlier turns are
 * then summarized or dropped. A window that is merely smaller, or an effort
 * level that does not carry over, is not said: the meter and the chip show both.
 */
export function switchSummary(input: {
  readonly row: ModelRow;
  readonly run: Pick<RunView, "state" | "outcome" | "model">;
  /** The conversation's size after its latest answer, or null when none was measured. */
  readonly usedTokens: number | null;
}): SwitchSummary {
  const { row, run, usedTokens } = input;
  const window = row.spec?.contextWindow ?? null;
  const shortfalls: string[] = [];
  if (window !== null && usedTokens !== null && usedTokens >= window) {
    shortfalls.push(
      `This conversation is about ${compactTokens(usedTokens)} tokens, more than ${row.name}'s ${compactTokens(window)} window. Earlier turns will be summarized or dropped.`,
    );
  } else if (window !== null && usedTokens !== null && usedTokens >= window * NEAR_WINDOW) {
    shortfalls.push(
      `This conversation is about ${compactTokens(usedTokens)} tokens, close to ${row.name}'s ${compactTokens(window)} window.`,
    );
  }
  const effort = switchRecord(row, run.model?.effort ?? null)?.effort ?? null;
  return {
    modelName: row.name,
    charged: chargedTo(row),
    effort,
    shortfalls,
    endsRun: run.outcome === null,
  };
}
