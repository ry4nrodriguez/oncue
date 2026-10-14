// Every runtime adapter the bridge carries, by id; the only list of harnesses.

import {
  isRuntimeId as isProtocolRuntimeId,
  DEFAULT_RUNTIME_ID as PROTOCOL_DEFAULT,
} from "@oncue/protocol";
import { CLAUDE_RUNTIME } from "./claude";
import { CODEX_RUNTIME } from "./codex";
import { OPENCODE_RUNTIME } from "./opencode";
import { PI_RUNTIME } from "./pi";
import type { RuntimeId, RuntimePlan } from "./runtime";

export const RUNTIMES: { readonly [Id in RuntimeId]: RuntimePlan & { readonly id: Id } } = {
  opencode: { ...OPENCODE_RUNTIME, id: "opencode" },
  codex: { ...CODEX_RUNTIME, id: "codex" },
  pi: { ...PI_RUNTIME, id: "pi" },
  claude: { ...CLAUDE_RUNTIME, id: "claude" },
};

/** The runtime a session runs when its grant names none. */
export const DEFAULT_RUNTIME_ID: RuntimeId = PROTOCOL_DEFAULT;

/**
 * A harness the bridge has an adapter for: in the shared catalog, with an
 * adapter here. Not every one is in the image; the Worker refuses one whose
 * catalog entry is not `inImage` before a grant can name it.
 */
export function isRuntimeId(value: unknown): value is RuntimeId {
  return isProtocolRuntimeId(value) && Object.hasOwn(RUNTIMES, value);
}

export function runtimePlan(id: RuntimeId): RuntimePlan {
  return RUNTIMES[id];
}
