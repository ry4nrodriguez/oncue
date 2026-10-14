// The provider adapter boundary (record 15). An adapter speaks one provider's
// wire format and maps its errors onto the stable failure categories;
// `forward.ts` depends on adapters, never the reverse, so a provider quirk
// cannot leak into broker policy. `ProviderCategory` excludes `broker_failure`,
// which only the broker can judge, so an adapter cannot return it.

import type { ModelFailureCategory } from "@oncue/protocol";
import { anthropicAdapter } from "./anthropic";
import type { ModelSpec } from "./catalog";
import { openaiAdapter } from "./openai";

export const PROVIDER_IDS = ["anthropic", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderCategory = Exclude<ModelFailureCategory, "broker_failure">;

export interface ProviderValidateInput {
  readonly origin: string;
  readonly credential: string;
  readonly fetchImpl: typeof fetch;
}

export type ProviderValidateOutcome =
  | { readonly kind: "ok"; readonly accountHint: string }
  | { readonly kind: "failed"; readonly category: ProviderCategory };

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** The catalog's recommended row, which a fresh connection starts on. */
  readonly defaultModel: ModelSpec;
  /** Every model of this provider a session may run on, current and legacy (`catalog.ts`). */
  readonly models: readonly ModelSpec[];
  /** The REAL provider origin, e.g. "https://api.anthropic.com". */
  readonly origin: string;
  /** The provider's request path for a model turn: Anthropic's Messages API, OpenAI's Responses API. */
  readonly requestPath: string;
  /**
   * The provider's exact input-token counter, which the broker uses to split a
   * prompt (`prompt-counts.ts`); absent for a provider whose counter has not
   * been verified with a person's key.
   */
  readonly countPath?: string;
  /**
   * Agent request headers this provider needs upstream, beyond `content-type`,
   * copied before `applyCredential` so a credential header always wins.
   * Anthropic's `anthropic-beta` gates bodies OpenCode sends for beta features.
   */
  readonly forwardedRequestHeaders: readonly string[];
  applyCredential(headers: Headers, credential: string): void;
  validate(input: ProviderValidateInput): Promise<ProviderValidateOutcome>;
  classify(status: number, errorCode: string | null): ProviderCategory;
  errorCodeOf(body: unknown): string | null;
}

/** Total over `ProviderId`, which matches `model_connection.provider`'s CHECK, so no fallback arm. */
export const PROVIDER_ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

/**
 * Where an adapter's requests go. Locally, traffic may go to the provider
 * double so no test spends money; a hosted deploy never redirects, since an
 * override there would be a worse hole than the one the broker closes.
 * `envName` is a plain string because `env.ONCUE_ENV` is typed as the literal
 * `"local"` and comparing it inline narrows to `never`.
 */
export function resolveProviderOrigin(
  adapter: ProviderAdapter,
  envName: string,
  override: string | undefined,
): string {
  if (envName !== "local") {
    return adapter.origin;
  }
  // Blank means absent: the live configuration writes an empty value, and an
  // empty origin would make every fetch a relative URL that throws.
  if (override === undefined || override === "") {
    return adapter.origin;
  }
  return override;
}

/** The D1 boundary: `provider` comes back from the row as a plain string. */
export function parseProviderId(value: string): ProviderId | null {
  if ((PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId;
  }
  return null;
}

// Shared by both adapters: untrusted-JSON shape checks and the one fetch guard.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") {
    return false;
  }
  if (value === null) {
    return false;
  }
  return !Array.isArray(value);
}

export function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

/**
 * Record 06's `provider_account_hint`: the key's last four characters, the
 * form provider consoles show, so a user can match the row to their dashboard.
 * Four characters of a high-entropy key reveal nothing usable. Derived locally
 * because neither provider returns an account id from a cheap validation call.
 */
export function credentialHint(credential: string): string {
  const visible = credential.slice(-4);
  return `...${visible}`;
}

/**
 * The one catch for a rejected fetch in either adapter. A transport failure is
 * `temporary_service_failure`, since an adapter may not return `broker_failure`.
 */
export async function fetchOrNull(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
): Promise<Response | null> {
  return fetchImpl(url, { headers }).catch(() => null);
}
