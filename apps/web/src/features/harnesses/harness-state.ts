/**
 * What the browser shows about each harness (the coding agent inside the
 * sandbox) the image installs, in catalog order: `ready` (enabled and a key
 * exists for a provider it drives), `needs_key` (enabled, no key), or
 * `unavailable` (not in the deployment's `ONCUE_RUNTIME_ALLOWLIST`; nothing the
 * user can do). A harness the image does not install is never listed, because
 * no deployment can run it.
 */
import { DEFAULT_RUNTIME_ID, RUNTIME_CATALOG, RUNTIME_IDS, type RuntimeId } from "@oncue/protocol";
import { PROVIDER_LABEL } from "@/features/model-connections/connection-status";
import type { ModelProvider } from "@/lib/api/setup";

/** Settings, Harnesses: where a harness's Connect goes. */
export const HARNESSES_PATH = "/settings/harnesses";

export type HarnessState = "ready" | "needs_key" | "unavailable";

export interface HarnessOption {
  readonly id: RuntimeId;
  readonly name: string;
  readonly providers: readonly ModelProvider[];
  readonly state: HarnessState;
}

function isProvider(value: string): value is ModelProvider {
  return value === "anthropic" || value === "openai";
}

/** The providers the workspace holds a key for, from its connections. */
export function connectedProvidersOf(
  connections: readonly { readonly provider?: ModelProvider | undefined }[],
): ReadonlySet<ModelProvider> {
  const providers = new Set<ModelProvider>();
  for (const connection of connections) {
    if (connection.provider !== undefined) {
      providers.add(connection.provider);
    }
  }
  return providers;
}

/** Every harness the image installs, with its state. `enabled` absent (an older Worker) means OpenCode alone. */
export function harnessOptions(
  enabled: readonly { readonly id: string }[] | undefined,
  connected: ReadonlySet<ModelProvider>,
): readonly HarnessOption[] {
  const on = new Set<string>(
    enabled === undefined ? [DEFAULT_RUNTIME_ID] : enabled.map((runtime) => runtime.id),
  );
  return RUNTIME_IDS.filter((id) => RUNTIME_CATALOG[id].inImage).map((id) => {
    const descriptor = RUNTIME_CATALOG[id];
    const providers = descriptor.providers.filter(isProvider);
    const state: HarnessState = !on.has(id)
      ? "unavailable"
      : providers.some((provider) => connected.has(provider))
        ? "ready"
        : "needs_key";
    return { id, name: descriptor.name, providers, state };
  });
}

/**
 * The harness a send names: the chosen one while it can run, else the first
 * that can, else the first listed. A fixed harness (a session's own) is
 * shown as it is, whatever its state now.
 */
export function selectedHarnessOf(
  options: readonly HarnessOption[],
  selectedId: string | null,
  fixed = false,
): HarnessOption | null {
  const chosen = options.find((option) => option.id === selectedId);
  if (chosen !== undefined && (fixed || chosen.state === "ready")) {
    return chosen;
  }
  return options.find((option) => option.state === "ready") ?? options[0] ?? null;
}

/** The first harness that can run a provider's models, for a model choice the current one cannot run. */
export function harnessForProvider(
  options: readonly HarnessOption[],
  provider: ModelProvider,
): HarnessOption | undefined {
  return options.find((option) => option.state === "ready" && option.providers.includes(provider));
}

function either(providers: readonly ModelProvider[], joiner: string): string {
  return providers.map((provider) => PROVIDER_LABEL[provider]).join(joiner);
}

/** "An" before a provider whose name starts with a vowel sound. */
function article(provider: ModelProvider): string {
  return PROVIDER_LABEL[provider].match(/^[AEIOU]/) === null ? "a" : "an";
}

/** One short line: which keys a harness works with. */
export function keysLine(providers: readonly ModelProvider[]): string {
  const first = providers[0];
  if (first === undefined) {
    return "Works with no provider OnCue connects";
  }
  return providers.length === 1
    ? `Works with ${article(first)} ${PROVIDER_LABEL[first]} key`
    : `Works with ${either(providers, " and ")} keys`;
}

/** What a harness without a key asks for. */
export function connectLine(providers: readonly ModelProvider[]): string {
  const first = providers[0];
  return first === undefined
    ? "Connect a key"
    : `Connect ${article(first)} ${either(providers, " or ")} key`;
}
