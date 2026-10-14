// Reads the optional `fake` hint off a create-session request body. A hosted
// client naming a fake script is a stale build or an attempt to steer a real
// run onto the scripted bridge, so it is refused with a 400 rather than
// silently dropped.

import type { BridgeScriptName } from "@oncue/bridge";
import type { ModelRecord } from "@oncue/protocol";

export interface FakeDriverRequest {
  readonly scriptName: BridgeScriptName;
  readonly framePacingMs: number | null;
}

/** The default with no hint, paced so a viewer sees the deltas. */
export const DEFAULT_FAKE_DRIVER: FakeDriverRequest = {
  scriptName: "seven-event",
  framePacingMs: 120,
};

/**
 * The model a workspace with no connection runs the scripted bridge under:
 * `run.start` requires a model record, and the fake driver ignores it.
 * `resolveModel` in `worker/broker/connections.ts` decides when it applies.
 */
export const FAKE_DRIVER_MODEL: ModelRecord = {
  provider: "oncue-fake",
  modelId: "fake-driver",
  modelConnectionId: "placeholder",
  authenticationType: "api_key",
  contextWindow: null,
  effort: null,
};

export type FakeDriverSelection =
  | { readonly kind: "default" }
  | { readonly kind: "scripted"; readonly request: FakeDriverRequest }
  | { readonly kind: "refused"; readonly reason: "not_local" | "malformed" };

// Hand-listed, since a type has no runtime form; the check below keeps it in
// step with `BridgeScriptName`.
const FAKE_SCRIPT_NAMES = [
  "seven-event",
  "long-stream",
  "stale-generation",
  "sequence-gap",
] as const;

type FakeScriptNamesMatchExpected = [
  Exclude<BridgeScriptName, (typeof FAKE_SCRIPT_NAMES)[number]> extends never ? true : never,
  Exclude<(typeof FAKE_SCRIPT_NAMES)[number], BridgeScriptName> extends never ? true : never,
];
export const FAKE_SCRIPT_NAMES_MATCH_EXPECTED: FakeScriptNamesMatchExpected = [true, true];

function isBridgeScriptName(value: unknown): value is BridgeScriptName {
  if (typeof value !== "string") {
    return false;
  }
  return (FAKE_SCRIPT_NAMES as readonly string[]).includes(value);
}

// One condition per `if` keeps 100 percent branch coverage reachable.
function isFramePacing(value: unknown): value is number | null {
  if (value === null) {
    return true;
  }
  if (typeof value !== "number") {
    return false;
  }
  if (!Number.isInteger(value)) {
    return false;
  }
  if (value < 0) {
    return false;
  }
  return value < 10_000;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") {
    return false;
  }
  if (value === null) {
    return false;
  }
  return !Array.isArray(value);
}

/**
 *   absent                      -> default
 *   present, env !== "local"    -> refused("not_local")   [400]
 *   present, malformed          -> refused("malformed")   [400]
 *   present, valid, env local   -> scripted
 *
 * The environment is checked first: a hosted client should never send this
 * key, so "not_local" is the more useful answer.
 */
export function selectFakeDriver(raw: unknown, envName: string): FakeDriverSelection {
  const fake = isPlainObject(raw) ? raw.fake : undefined;
  if (fake === undefined) {
    return { kind: "default" };
  }
  if (envName !== "local") {
    return { kind: "refused", reason: "not_local" };
  }
  if (!isPlainObject(fake)) {
    return { kind: "refused", reason: "malformed" };
  }
  const { scriptName, framePacingMs } = fake;
  if (!isBridgeScriptName(scriptName)) {
    return { kind: "refused", reason: "malformed" };
  }
  if (!isFramePacing(framePacingMs)) {
    return { kind: "refused", reason: "malformed" };
  }
  return { kind: "scripted", request: { scriptName, framePacingMs } };
}
