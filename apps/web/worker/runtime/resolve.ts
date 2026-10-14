// Which harness a session runs, checked at session creation and on every
// `run.start`: the sandbox image installs it (`inImage` in `RUNTIME_CATALOG`),
// `ONCUE_RUNTIME_ALLOWLIST` permits it, it can drive the connection's provider
// through the broker, and it can send the run's effort. A harness the image
// does not install is refused even when the allowlist names it. An
// incompatible pair is refused, never replaced.
//
// `ONCUE_RUNTIME_ALLOWLIST` is comma-separated runtime ids and, unlike
// `ONCUE_MODEL_ALLOWLIST`, applies in every environment. Unset or blank, it
// allows OpenCode alone.

import {
  DEFAULT_RUNTIME_ID,
  type EffortLevel,
  isRuntimeId,
  RUNTIME_CATALOG,
  RUNTIME_IDS,
  type RuntimeId,
  type RuntimeRecord,
  runtimeDescriptor,
} from "@oncue/protocol";

/** The fake driver's provider: no harness drives it, and no check applies to it. */
export const FAKE_PROVIDER = "oncue-fake";

/** The runtimes the allowlist permits and the image carries, in catalog order. */
export function allowedRuntimes(allowlist: string | undefined): readonly RuntimeId[] {
  const named = new Set(
    (allowlist ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  if (named.size === 0) {
    return [DEFAULT_RUNTIME_ID];
  }
  return RUNTIME_IDS.filter((id) => named.has(id) && RUNTIME_CATALOG[id].inImage);
}

export type RuntimeRefusalReason =
  | "unknown_runtime"
  | "not_in_image"
  | "not_allowed"
  | "provider_not_supported"
  | "effort_not_supported";

export type RuntimeResolution =
  | { readonly kind: "resolved"; readonly runtime: RuntimeRecord }
  | {
      readonly kind: "refused";
      readonly reason: RuntimeRefusalReason;
      /** Plain words for the person, naming the harness by its plain name. */
      readonly detail: string;
    };

export interface ResolveRuntimeInput {
  /** What the request named; `undefined` means the default. Anything else is checked, never trusted. */
  readonly requested: unknown;
  readonly allowlist: string | undefined;
  /** The run's provider, from the model record the Worker built. */
  readonly provider: string;
  readonly effort: EffortLevel | null;
}

export function resolveRuntime(input: ResolveRuntimeInput): RuntimeResolution {
  const requested = input.requested === undefined ? DEFAULT_RUNTIME_ID : input.requested;
  if (!isRuntimeId(requested)) {
    return {
      kind: "refused",
      reason: "unknown_runtime",
      detail: "OnCue does not run that harness",
    };
  }
  const descriptor = runtimeDescriptor(requested);
  if (!descriptor.inImage) {
    return {
      kind: "refused",
      reason: "not_in_image",
      detail: `${descriptor.name} is not installed in the sandbox image, so OnCue cannot run it`,
    };
  }
  if (!allowedRuntimes(input.allowlist).includes(requested)) {
    return {
      kind: "refused",
      reason: "not_allowed",
      detail: `${descriptor.name} is not enabled on this OnCue`,
    };
  }
  if (input.provider !== FAKE_PROVIDER && !descriptor.providers.includes(input.provider)) {
    return {
      kind: "refused",
      reason: "provider_not_supported",
      detail: `${descriptor.name} cannot run this model's provider`,
    };
  }
  if (input.effort !== null && !descriptor.effortLevels.includes(input.effort)) {
    return {
      kind: "refused",
      reason: "effort_not_supported",
      detail: `${descriptor.name} cannot run this model at that effort level`,
    };
  }
  return { kind: "resolved", runtime: { id: requested, version: descriptor.pinnedVersion } };
}

/** What the composer needs to offer a harness: never a credential, never a path. */
export interface RuntimeSummary {
  readonly id: RuntimeId;
  readonly name: string;
  readonly providers: readonly string[];
  readonly images: boolean;
  readonly holdsToolCalls: boolean;
}

export function runtimeSummaries(allowlist: string | undefined): readonly RuntimeSummary[] {
  return allowedRuntimes(allowlist).map((id) => {
    const { name, providers, images, holdsToolCalls } = RUNTIME_CATALOG[id];
    return { id, name, providers, images, holdsToolCalls };
  });
}
