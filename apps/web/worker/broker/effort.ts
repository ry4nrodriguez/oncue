// Every request for a run reaches the provider at the run's recorded effort.
// The broker sets the provider's own field (Anthropic's `output_config.effort`,
// OpenAI's `reasoning.effort`): no effort named gets the recorded one written
// in, the recorded one passes untouched, and a different one is refused. With
// no recorded effort, a body that sets one is refused. Injecting it means the
// run does not depend on whether the runtime's client passes it through.

import type { EffortLevel } from "@oncue/protocol";
import type { ProviderId } from "./providers/adapter";
import { isPlainObject } from "./providers/adapter";

export type EffortEnforcement =
  | { readonly kind: "forward"; readonly body: ArrayBuffer }
  | { readonly kind: "denied" };

/** Each provider's effort field: an object key, then a key within it. */
const EFFORT_FIELD: Readonly<Record<ProviderId, readonly [container: string, key: string]>> = {
  anthropic: ["output_config", "effort"],
  openai: ["reasoning", "effort"],
};

/** `raw` is returned as-is when nothing changes, so the body is forwarded byte for byte. */
export function enforceEffort(
  raw: ArrayBuffer,
  parsed: Record<string, unknown>,
  provider: ProviderId,
  recorded: EffortLevel | null,
): EffortEnforcement {
  const [containerKey, key] = EFFORT_FIELD[provider];
  const container = parsed[containerKey];
  const named = isPlainObject(container) ? container[key] : undefined;

  if (named !== undefined) {
    // The body speaks: it must say what the run recorded.
    return named === recorded ? { kind: "forward", body: raw } : { kind: "denied" };
  }
  if (recorded === null) {
    return { kind: "forward", body: raw };
  }
  const rewritten = {
    ...parsed,
    [containerKey]: { ...(isPlainObject(container) ? container : {}), [key]: recorded },
  };
  return {
    kind: "forward",
    body: new TextEncoder().encode(JSON.stringify(rewritten)).buffer as ArrayBuffer,
  };
}
