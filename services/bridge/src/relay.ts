/**
 * The Model Broker relay: the only route from the agent to a model provider
 * (record 06). The agent posts to a loopback origin, and the relay, running as
 * the bridge user, attaches a short-lived session-scoped broker token on the
 * way out; OpenCode never holds or sees the token.
 *
 * The boundary is a Unix user, not a sidecar network (record 02): the relay
 * binds 127.0.0.1, the agent runs as a different uid, and the token lives only
 * in the bridge process's memory, never in a file or an inherited environment.
 * Anything that escalates to the bridge user or root defeats it.
 *
 * `planRelayRequest` makes every decision (caller, path, headers, outbound
 * request) and the server does no filtering of its own, so there is no second
 * place a header could slip through.
 */

/**
 * The Worker's forward route (`BROKER_FORWARD_PATH` in
 * `apps/web/worker/routes/broker.ts`). Both sides import this one function so
 * the path cannot drift.
 */
export function brokerForwardPath(sessionId: string): string {
  return `/api/broker/sessions/${encodeURIComponent(sessionId)}/v1/messages`;
}

/** Loopback only. A relay reachable from off-box would be an open credential proxy. */
export const RELAY_HOST = "127.0.0.1";

/**
 * The paths the agent may post to, one per provider client: Anthropic's
 * client appends `/messages` to its base URL, OpenAI's Responses client
 * appends `/responses`. Both go to the broker's one forwarding endpoint,
 * which posts upstream on the provider's own path. Anything else is refused.
 */
export const RELAY_MESSAGES_PATH = "/v1/messages";
export const RELAY_RESPONSES_PATH = "/v1/responses";
export const RELAY_REQUEST_PATHS: readonly string[] = [RELAY_MESSAGES_PATH, RELAY_RESPONSES_PATH];

/**
 * Everything else is dropped, including any `authorization` the agent sent: a
 * header the relay has not considered is not forwarded. `anthropic-beta` gates
 * request bodies OpenCode sends for beta features and must reach the provider;
 * the Worker pins `anthropic-version` itself.
 */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

export interface RelayConfig {
  readonly brokerOrigin: string;
  readonly sessionId: string;
  readonly port: number;
}

export interface RelayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** As the server saw it. A request from anywhere but loopback is refused. */
  readonly remoteAddress: string;
}

export type RelayRefusal = "not_loopback" | "method_not_allowed" | "path_not_served" | "no_token";

export interface RelayForward {
  readonly kind: "forward";
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
}

export type RelayPlan =
  | RelayForward
  | { readonly kind: "refused"; readonly status: number; readonly reason: RelayRefusal };

const REFUSAL_STATUS: Readonly<Record<RelayRefusal, number>> = {
  not_loopback: 403,
  method_not_allowed: 405,
  path_not_served: 404,
  // No current session token. Retryable, and the agent's client already handles
  // a 503.
  no_token: 503,
};

function refused(reason: RelayRefusal): RelayPlan {
  return { kind: "refused", status: REFUSAL_STATUS[reason], reason };
}

function isLoopback(address: string): boolean {
  if (address === RELAY_HOST) {
    return true;
  }
  if (address === "::1") {
    return true;
  }
  // Node reports loopback over a dual-stack socket in the IPv4-mapped form;
  // refusing it would refuse every request on a host with IPv6 enabled.
  return address === `::ffff:${RELAY_HOST}`;
}

/**
 * `token` is passed in because the control plane mints and rotates it during a
 * session, and a request must use whichever one is current when it arrives.
 */
export function planRelayRequest(
  config: RelayConfig,
  token: string | null,
  request: RelayRequest,
): RelayPlan {
  if (!isLoopback(request.remoteAddress)) {
    return refused("not_loopback");
  }
  if (request.method !== "POST") {
    return refused("method_not_allowed");
  }
  if (!RELAY_REQUEST_PATHS.includes(request.path)) {
    return refused("path_not_served");
  }
  if (token === null) {
    return refused("no_token");
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  // Set last and unconditionally, so an agent-supplied `authorization` cannot
  // survive even if it reached the allowlist.
  headers.authorization = `Bearer ${token}`;

  return {
    kind: "forward",
    url: `${config.brokerOrigin}${brokerForwardPath(config.sessionId)}`,
    method: "POST",
    headers,
  };
}

/**
 * Record 06's `FAILURE_POLICY` categories. Kept in sync with `@oncue/protocol`'s
 * `ModelFailureCategory` by hand, because this module does not depend on the
 * protocol package.
 */
export type RelayFailure =
  | "temporary_service_failure"
  | "rate_limited"
  | "usage_limit_reached"
  | "authentication_failed"
  | "model_unavailable"
  | "request_rejected"
  | "broker_failure";

const RELAY_FAILURES: ReadonlySet<string> = new Set<RelayFailure>([
  "temporary_service_failure",
  "rate_limited",
  "usage_limit_reached",
  "authentication_failed",
  "model_unavailable",
  "request_rejected",
  "broker_failure",
]);

function categoryFromBody(body: string): RelayFailure | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const category = (parsed as Record<string, unknown>).category;
    if (typeof category === "string" && RELAY_FAILURES.has(category)) {
      return category as RelayFailure;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Upstream status to record 06's `FAILURE_POLICY` category; `null` for success.
 * The broker's own body wins when it names a category; the status covers a
 * response that never reached the broker (an edge error, a timeout).
 */
export function classifyUpstreamFailure(status: number, body: string): RelayFailure | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  const fromBody = categoryFromBody(body);
  if (fromBody !== null) {
    return fromBody;
  }
  if (status === 403) {
    return "authentication_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 503) {
    return "temporary_service_failure";
  }
  if (status >= 500) {
    return "broker_failure";
  }
  return "request_rejected";
}

/**
 * Response headers the agent may see. Restated from the broker's passthrough
 * list so a header the broker adds later is not automatically exposed.
 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after", "request-id", "x-request-id"];

/**
 * The Model Broker's exact counts for the agent's prompt
 * (`apps/web/worker/broker/prompt-counts.ts`). The agent never sees the
 * header; the bridge reads it for the next `message.completed`.
 */
export const PROMPT_COUNTS_HEADER = "x-oncue-prompt-tokens";

/** The broker's counts of a prompt's parts besides the conversation (`apps/web/worker/broker/prompt-counts.ts`). */
export interface PromptCounts {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly oncueToolsTokens: number;
}

/**
 * What the broker said about one agent call's prompt, keyed by a prefix of the
 * prompt's hash so the bridge can tie counts to the call they belong to.
 */
export type PromptCountsReading =
  | { readonly kind: "counts"; readonly key: string; readonly counts: PromptCounts }
  | {
      readonly kind: "status";
      readonly key: string;
      readonly status: "pending" | "unavailable";
    }
  /** A successful call with no usable header: not the agent's turn, or a provider not counted. */
  | { readonly kind: "none" };

const PROMPT_COUNT_FIELDS = ["systemTokens", "toolsTokens", "oncueToolsTokens"] as const;
const PROMPT_KEY = /^[0-9a-f]{16}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads the header strictly: a key with three non-negative integers, or a key
 * with a status, and nothing else. Anything else is no breakdown.
 */
export function readPromptCounts(value: string | undefined): PromptCountsReading {
  const none = { kind: "none" } as const;
  if (value === undefined) {
    return none;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return none;
  }
  const record = parsed as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "string" || !PROMPT_KEY.test(key)) {
    return none;
  }
  const keys = Object.keys(record);
  if (keys.length === 2 && (record.status === "pending" || record.status === "unavailable")) {
    return { kind: "status", key, status: record.status };
  }
  const countsOk =
    keys.length === PROMPT_COUNT_FIELDS.length + 1 &&
    PROMPT_COUNT_FIELDS.every((field) => isCount(record[field]));
  if (!countsOk) {
    return none;
  }
  return {
    kind: "counts",
    key,
    counts: {
      systemTokens: record.systemTokens as number,
      toolsTokens: record.toolsTokens as number,
      oncueToolsTokens: record.oncueToolsTokens as number,
    },
  };
}

export function planRelayResponseHeaders(
  upstream: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream[name];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * The token holder, a closure rather than a config field so nothing that
 * serialises the config (a log line, an error report) can reach the value.
 */
export interface RelayTokenHolder {
  current(): string | null;
  replace(token: string | null): void;
}

export function createRelayTokenHolder(): RelayTokenHolder {
  let token: string | null = null;
  return {
    current: () => token,
    replace: (next: string | null) => {
      token = next;
    },
  };
}
