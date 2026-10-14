// The Model Broker's forwarding path (record 06). It validates the sandbox's
// scoped token, confirms the session may use the connection, opens the
// credential in memory for one upstream request, streams the answer back, and
// records non-secret metadata and one of record 15's failure categories.
//
// It never retries (the runtime retries, and stacked retries are worse), so
// the outcome says whether a retry is safe. It never picks another provider,
// model, or connection: record 15 forbids automatic fallback.
//
// A provider that refuses a request as unauthorized has not yet condemned the
// key: the broker asks the provider about the key itself first (`key-check.ts`)
// and marks the connection invalid only when that is refused too.
//
// The credential exists only between `openCredential` and `applyCredential`,
// and is never stored, returned, or logged; the tests scan every log line for
// the key's bytes.

import type { ModelFailureCategory } from "@oncue/protocol";
import { safeJsonParse } from "../json";
import type { LogFields } from "../log";
import { readAuthorizedConnection, recordKeyVerdict } from "./connections";
import { enforceEffort } from "./effort";
import { type Keyring, openCredential } from "./envelope";
import { checkKey } from "./key-check";
import {
  type CountScope,
  countPrompt,
  PROMPT_COUNT_CACHE,
  PROMPT_COUNTS_HEADER,
  type PromptCountCache,
  promptCountsHeader,
  promptKey,
  promptShapeOf,
  providerCounter,
} from "./prompt-counts";
import { PROVIDER_ADAPTERS, type ProviderAdapter } from "./providers/adapter";
import { readUsage } from "./stream-usage";
import { checkForForward } from "./tokens";

/**
 * One row per category of the protocol's closed union, so a new category fails
 * to compile. Retry safety is a column, not a condition. Only an invalid key
 * changes a stored row (`connectionStatusAfter`, record 06), because only it
 * says something durable about the credential, and only once a check of the
 * key itself agrees.
 */
export interface FailurePolicy {
  readonly retrySafe: boolean;
  readonly sandboxStatus: number;
  readonly connectionStatusAfter: "invalid" | null;
  readonly message: string;
}

export const FAILURE_POLICY: Readonly<Record<ModelFailureCategory, FailurePolicy>> = {
  temporary_service_failure: {
    retrySafe: true,
    sandboxStatus: 503,
    connectionStatusAfter: null,
    message: "The provider had a temporary problem.",
  },
  rate_limited: {
    retrySafe: true,
    sandboxStatus: 429,
    connectionStatusAfter: null,
    message: "The provider asked us to wait before trying again.",
  },
  usage_limit_reached: {
    retrySafe: false,
    sandboxStatus: 429,
    connectionStatusAfter: null,
    message: "This connection has reached a limit with the provider.",
  },
  authentication_failed: {
    retrySafe: false,
    sandboxStatus: 403,
    connectionStatusAfter: "invalid",
    message: "The provider rejected this connection's credential.",
  },
  model_unavailable: {
    retrySafe: false,
    sandboxStatus: 404,
    connectionStatusAfter: null,
    message: "The selected model is not available to this connection.",
  },
  request_rejected: {
    retrySafe: false,
    sandboxStatus: 400,
    connectionStatusAfter: null,
    message: "The provider rejected this request.",
  },
  broker_failure: {
    retrySafe: true,
    sandboxStatus: 502,
    connectionStatusAfter: null,
    message: "OnCue could not complete this request.",
  },
};

export interface ForwardDeps {
  readonly db: D1Database;
  readonly credentialKeyring: Keyring<"credential">;
  readonly tokenKeyring: Keyring<"token">;
  readonly fetchImpl: typeof fetch;
  /** The route decides, so this module knows no environment. */
  readonly originFor: (adapter: ProviderAdapter) => string;
  readonly now: () => number;
  readonly log: (fields: LogFields) => void;
  readonly release: string;
  readonly environment: string;
  readonly waitUntil: (work: Promise<unknown>) => void;
  /** What this isolate has counted of agents' prompts; tests pass their own. */
  readonly promptCounts?: PromptCountCache;
  /** How long the key check after an unauthorized answer may take; tests shorten it. */
  readonly keyCheckTimeoutMs?: number;
}

export interface ForwardInput {
  /** From the path; must match the token's. */
  readonly sessionId: string;
  readonly bearer: string | null;
  readonly body: ArrayBuffer;
  readonly contentType: string | null;
  /**
   * The agent's request headers. Only the adapter's `forwardedRequestHeaders`
   * are copied upstream; anything else, including an `authorization`, is never
   * read.
   */
  readonly passthroughHeaders?: Readonly<Record<string, string>>;
}

export type ForwardOutcome =
  | { readonly kind: "streamed"; readonly response: Response }
  | { readonly kind: "denied" }
  | {
      readonly kind: "failed";
      readonly category: ModelFailureCategory;
      readonly retrySafe: boolean;
      readonly status: number;
      readonly message: string;
      readonly retryAfter: string | null;
    };

/** Never a credential, never a set-cookie. */
const PASSED_THROUGH_HEADERS = ["content-type", "retry-after", "request-id", "x-request-id"];

function passThrough(
  upstream: Response,
  body: ReadableStream<Uint8Array> | null,
  promptCounts: string | null,
): Response {
  const headers = new Headers();
  if (promptCounts !== null) {
    headers.set(PROMPT_COUNTS_HEADER, promptCounts);
  }
  for (const name of PASSED_THROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return new Response(body, { status: upstream.status, headers });
}

/** `null` when the body is not a JSON object. */
function parseBody(body: ArrayBuffer): Record<string, unknown> | null {
  const parsed = safeJsonParse(new TextDecoder().decode(body));
  if (!parsed.ok) {
    return null;
  }
  const raw = parsed.value;
  if (typeof raw !== "object") {
    return null;
  }
  if (raw === null) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function modelIn(parsed: Record<string, unknown> | null): string | null {
  if (parsed === null) {
    return null;
  }
  const model = parsed.model;
  if (typeof model !== "string") {
    return null;
  }
  return model;
}

export async function forwardModelRequest(
  deps: ForwardDeps,
  input: ForwardInput,
): Promise<ForwardOutcome> {
  const started = deps.now();

  if (input.bearer === null) {
    return { kind: "denied" };
  }
  const checked = await checkForForward(deps.tokenKeyring, input.bearer, started);
  if (checked.kind === "rejected") {
    return { kind: "denied" };
  }
  const claims = checked.claims;

  // No I/O: the session is a signed claim, so a token cannot be used on
  // another session's path.
  if (claims.sessionId !== input.sessionId) {
    return { kind: "denied" };
  }

  const authorized = await readAuthorizedConnection(deps.db, claims);
  if (authorized.kind === "denied") {
    return { kind: "denied" };
  }

  // The token's model scope is enforced too (record 06): a body that does not
  // ask for the token's model is denied like a wrong session.
  const parsedBody = parseBody(input.body);
  if (modelIn(parsedBody) !== claims.modelId) {
    return { kind: "denied" };
  }
  // The body reaches the provider at the run's effort (`effort.ts`) or not at
  // all. `parsedBody` is an object here.
  const enforced = enforceEffort(
    input.body,
    parsedBody as Record<string, unknown>,
    authorized.provider,
    claims.effort,
  );
  if (enforced.kind === "denied") {
    return { kind: "denied" };
  }

  const adapter = PROVIDER_ADAPTERS[authorized.provider];
  const opened = await openCredential(
    deps.credentialKeyring,
    {
      connectionId: claims.connectionId,
      workspaceId: claims.workspaceId,
      provider: authorized.provider,
    },
    authorized.sealed,
  );
  if (opened.kind !== "ok") {
    return failure(deps, claims, adapter, "broker_failure", null, started);
  }

  const headers = new Headers();
  if (input.contentType !== null) {
    headers.set("content-type", input.contentType);
  }
  // Before `applyCredential`, so the adapter's own headers (for example
  // `anthropic-version`) always win.
  const passthroughHeaders = input.passthroughHeaders ?? {};
  for (const name of adapter.forwardedRequestHeaders) {
    const value = passthroughHeaders[name];
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  adapter.applyCredential(headers, opened.plaintext);

  let upstream: Response;
  try {
    upstream = await deps.fetchImpl(`${deps.originFor(adapter)}${adapter.requestPath}`, {
      method: "POST",
      headers,
      body: enforced.body,
    });
  } catch {
    return failure(deps, claims, adapter, "temporary_service_failure", null, started);
  }

  if (upstream.ok) {
    deps.log({
      timestamp: new Date(deps.now()).toISOString(),
      severity: "info",
      service: "model-broker",
      release: deps.release,
      environment: deps.environment,
      operation: "broker.forward",
      result: "ok",
      provider: adapter.id,
      sessionId: claims.sessionId,
      sandboxGeneration: String(claims.sandboxGeneration),
      durationMs: deps.now() - started,
    });
    // One more line once the answer has passed: the provider's own token
    // counts, so the bridge's figures can be checked against them. Numbers only.
    const body =
      upstream.body === null
        ? null
        : readUsage(upstream.body, (usage) => {
            deps.log({
              timestamp: new Date(deps.now()).toISOString(),
              severity: "info",
              service: "model-broker",
              release: deps.release,
              environment: deps.environment,
              operation: "broker.forward.usage",
              result: "ended",
              provider: adapter.id,
              sessionId: claims.sessionId,
              sandboxGeneration: String(claims.sandboxGeneration),
              ...usage,
            });
          });
    // `parsedBody` is an object here: its model matched the token's.
    const counts = await promptCountsFor(
      deps,
      adapter,
      parsedBody as Record<string, unknown>,
      opened.plaintext,
      { sessionId: claims.sessionId, connectionId: claims.connectionId },
      passthroughHeaders,
    );
    return { kind: "streamed", response: passThrough(upstream, body, counts) };
  }

  const errorBody = safeJsonParse(await upstream.text());
  const errorCode = errorBody.ok ? adapter.errorCodeOf(errorBody.value) : null;
  const category = adapter.classify(upstream.status, errorCode);
  const retryAfter = upstream.headers.get("retry-after");
  if (FAILURE_POLICY[category].connectionStatusAfter === null) {
    return failure(deps, claims, adapter, category, retryAfter, started);
  }

  // Unauthorized for this request is not yet a verdict on the key: a key the
  // provider still accepts may simply not reach this model or endpoint. The
  // check cannot throw and is bounded, and the row is written outside the
  // response path, so nothing here can turn a clean refusal into a 502.
  const checkStarted = deps.now();
  const verdict = await checkKey(
    {
      fetchImpl: deps.fetchImpl,
      originFor: deps.originFor,
      ...(deps.keyCheckTimeoutMs === undefined ? {} : { timeoutMs: deps.keyCheckTimeoutMs }),
    },
    adapter,
    opened.plaintext,
  );
  deps.log({
    timestamp: new Date(deps.now()).toISOString(),
    severity: "info",
    service: "model-broker",
    release: deps.release,
    environment: deps.environment,
    operation: "broker.forward.key_check",
    result: verdict,
    provider: adapter.id,
    sessionId: claims.sessionId,
    sandboxGeneration: String(claims.sandboxGeneration),
    durationMs: deps.now() - checkStarted,
  });
  if (verdict !== "inconclusive") {
    deps.waitUntil(
      recordKeyVerdict(
        deps.db,
        {
          workspaceId: claims.workspaceId,
          connectionId: claims.connectionId,
          sealed: authorized.sealed,
        },
        verdict,
        new Date(deps.now()).toISOString(),
      ),
    );
  }
  // The key works, so only this run stops: the model or endpoint is what the
  // key could not use. An inconclusive check reports what the provider said
  // and leaves the connection alone.
  return failure(
    deps,
    claims,
    adapter,
    verdict === "accepted" ? "model_unavailable" : category,
    retryAfter,
    started,
  );
}

/**
 * The header value for an agent's call: the prompt's key with its counts when
 * this isolate has them, or with a status, after starting a count off the
 * request's path when the budgets allow. `null` (no header) for a provider
 * with no verified counter or a call that is not the agent's. Never throws and
 * never waits on the provider: a body too deep to read is just not counted.
 */
async function promptCountsFor(
  deps: ForwardDeps,
  adapter: ProviderAdapter,
  body: Record<string, unknown>,
  credential: string,
  scope: CountScope,
  passthroughHeaders: Readonly<Record<string, string>>,
): Promise<string | null> {
  const countPath = adapter.countPath;
  if (countPath === undefined) {
    return null;
  }
  try {
    const shape = promptShapeOf(body);
    if (shape === null) {
      return null;
    }
    const cache = deps.promptCounts ?? PROMPT_COUNT_CACHE;
    const key = await promptKey(shape);
    const decision = cache.decide(key, scope, deps.now());
    if (decision.kind === "status" && decision.start) {
      const headers = new Headers({ "content-type": "application/json" });
      // The same beta flags as the forward, so the counter reads the prompt the same way.
      for (const name of adapter.forwardedRequestHeaders) {
        const value = passthroughHeaders[name];
        if (value !== undefined) {
          headers.set(name, value);
        }
      }
      adapter.applyCredential(headers, credential);
      const count = providerCounter({
        fetchImpl: deps.fetchImpl,
        url: `${deps.originFor(adapter)}${countPath}`,
        headers,
      });
      deps.waitUntil(cache.fill(key, scope, deps.now, () => countPrompt(shape, count)));
    }
    return promptCountsHeader(key, decision);
  } catch {
    return null;
  }
}

function failure(
  deps: ForwardDeps,
  claims: { sessionId: string; sandboxGeneration: number },
  adapter: ProviderAdapter,
  category: ModelFailureCategory,
  retryAfter: string | null,
  started: number,
): ForwardOutcome {
  const policy = FAILURE_POLICY[category];
  deps.log({
    timestamp: new Date(deps.now()).toISOString(),
    severity: "warn",
    service: "model-broker",
    release: deps.release,
    environment: deps.environment,
    operation: "broker.forward",
    result: "failed",
    provider: adapter.id,
    errorCategory: category,
    sessionId: claims.sessionId,
    sandboxGeneration: String(claims.sandboxGeneration),
    durationMs: deps.now() - started,
  });
  return {
    kind: "failed",
    category,
    retrySafe: policy.retrySafe,
    status: policy.sandboxStatus,
    message: policy.message,
    retryAfter,
  };
}
