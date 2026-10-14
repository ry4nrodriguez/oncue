// Asks a provider whether a key still works, with the adapter's free
// validation call, and reduces the answer to a verdict. Session creation asks
// before a sandbox is requested, the forwarding path asks before it marks a
// connection invalid, and Settings asks on demand.
//
// A check never throws and never outlasts its timeout, so a caller can put it
// in a response path. Only a provider's rejection of the key itself is
// `rejected`; a slow, limited, or unreachable provider is `inconclusive` and
// says nothing about the key. The plaintext lives between `openCredential` and
// the adapter's request, and is never returned, stored, or logged.

import { type ConnectionDeps, readStoredKey, recordKeyVerdict } from "./connections";
import { openCredential } from "./envelope";
import {
  PROVIDER_ADAPTERS,
  type ProviderAdapter,
  type ProviderValidateOutcome,
} from "./providers/adapter";

/** Long enough for a healthy provider's models list, short enough to wait for in a request. */
export const KEY_CHECK_TIMEOUT_MS = 3_000;

/**
 * How long a successful validation stands in for a new one at session
 * creation, so a burst of sessions costs one provider call.
 */
export const KEY_CHECK_FRESH_MS = 10 * 60 * 1000;

export type KeyVerdict = "accepted" | "rejected" | "inconclusive";

export interface KeyCheckTransport {
  readonly fetchImpl: typeof fetch;
  readonly originFor: (adapter: ProviderAdapter) => string;
  /** Tests shorten it; everything else waits `KEY_CHECK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

function verdictOf(outcome: ProviderValidateOutcome): KeyVerdict {
  if (outcome.kind === "ok") {
    return "accepted";
  }
  return outcome.category === "authentication_failed" ? "rejected" : "inconclusive";
}

/**
 * One bounded validation of a key the caller already holds in memory. The
 * timeout aborts the request and answers `inconclusive` whether or not the
 * provider honours the abort.
 */
export async function checkKey(
  transport: KeyCheckTransport,
  adapter: ProviderAdapter,
  credential: string,
): Promise<KeyVerdict> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<KeyVerdict>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve("inconclusive");
    }, transport.timeoutMs ?? KEY_CHECK_TIMEOUT_MS);
  });
  const asked = adapter
    .validate({
      origin: transport.originFor(adapter),
      credential,
      fetchImpl: (input, init) => transport.fetchImpl(input, { ...init, signal: abort.signal }),
    })
    .then(verdictOf, (): KeyVerdict => "inconclusive");
  try {
    return await Promise.race([asked, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export type StoredKeyCheck =
  | { readonly kind: KeyVerdict }
  /** Validated recently enough that the provider was not asked. */
  | { readonly kind: "fresh" }
  /** No such connection in this workspace. */
  | { readonly kind: "absent" }
  /** Revoked: the sealed value was destroyed, so there is nothing to check. */
  | { readonly kind: "no_key" }
  /** The sealed value will not open, which is OnCue's failure and says nothing about the key. */
  | { readonly kind: "unusable" };

export interface StoredKeyCheckOptions {
  /** Skip the provider when an active key was validated within this long. Absent always asks. */
  readonly freshForMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Checks the key a connection stores and records the verdict: accepted returns
 * the connection to `active` and moves `last_validated_at`, rejected marks it
 * `invalid`, and anything else leaves the row as it was.
 */
export async function checkStoredKey(
  deps: Pick<ConnectionDeps, "db" | "keyring" | "fetchImpl" | "originFor" | "now">,
  target: { readonly workspaceId: string; readonly connectionId: string },
  options: StoredKeyCheckOptions = {},
): Promise<StoredKeyCheck> {
  const stored = await readStoredKey(deps.db, target.workspaceId, target.connectionId);
  if (stored.kind === "absent") {
    return { kind: "absent" };
  }
  if (stored.status === "revoked") {
    return { kind: "no_key" };
  }
  const now = deps.now();
  if (
    options.freshForMs !== undefined &&
    stored.status === "active" &&
    stored.lastValidatedAt !== null &&
    Date.parse(now) - Date.parse(stored.lastValidatedAt) < options.freshForMs
  ) {
    return { kind: "fresh" };
  }
  const opened = await openCredential(
    deps.keyring,
    { ...target, provider: stored.provider },
    stored.sealed,
  );
  if (opened.kind !== "ok") {
    return { kind: "unusable" };
  }
  const verdict = await checkKey(
    {
      fetchImpl: deps.fetchImpl,
      originFor: deps.originFor,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    PROVIDER_ADAPTERS[stored.provider],
    opened.plaintext,
  );
  if (verdict !== "inconclusive") {
    await recordKeyVerdict(deps.db, { ...target, sealed: stored.sealed }, verdict, now);
  }
  return { kind: verdict };
}
