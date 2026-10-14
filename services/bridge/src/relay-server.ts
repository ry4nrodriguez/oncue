/**
 * The HTTP server around `relay.ts`, which keeps every decision; this file is
 * the socket, the fetch, the pipe, and a timer.
 *
 * The broker token lives ten minutes inside a run that can last hours, so it is
 * refreshed at half its remaining life with the old token as bearer. A refused
 * refresh does not clear the holder, since the current token may still have
 * minutes left; past `refreshableUntil` the relay's 503 is the honest answer.
 * Every non-2xx upstream answer is classified and reported through `onFailure`,
 * and the agent's client sees the broker's own status and body.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RelayFailure } from "./agent";
import {
  classifyUpstreamFailure,
  createRelayTokenHolder,
  PROMPT_COUNTS_HEADER,
  type PromptCountsReading,
  planRelayRequest,
  planRelayResponseHeaders,
  RELAY_HOST,
  RELAY_MESSAGES_PATH,
  type RelayRequest,
  readPromptCounts,
} from "./relay";

export interface RelayCoreOptions {
  readonly sessionId: string;
  readonly fetchImpl: typeof fetch;
  /** Injected timer so refresh cadence is asserted, not waited for (mirrors `BridgeIo.startHeartbeat`). */
  readonly schedule: (afterMs: number, run: () => void) => () => void;
  readonly nowMs: () => number;
  /** Every model failure the relay observes. The reducer decides what it means for the run. */
  readonly onFailure: (failure: RelayFailure) => void;
  /** What the broker said about each successful call's prompt. */
  readonly onPromptCounts?: (reading: PromptCountsReading) => void;
  readonly log: (line: string) => void;
  /** The per-request deadlines' timer; `setTimeout` when not given. Kept apart from the refresh timer. */
  readonly requestTimer?: (afterMs: number, run: () => void) => () => void;
}

export interface RelayAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | string | null;
}

export interface RelayCore {
  /** Replaces the held token and restarts the refresh timer from `expiresAt`. Called by the `set_model_token` effect. */
  setToken(token: string, expiresAt: string, brokerOrigin: string): void;
  /**
   * One request in, one answer out. `port` is what `planRelayRequest`'s config
   * names; the bind is the shell's. `clientGone` aborts when the agent's client
   * disconnects, which aborts the upstream request with it.
   */
  handle(
    request: RelayRequest,
    body: ReadableStream<Uint8Array> | null,
    port: number,
    clientGone?: AbortSignal,
  ): Promise<RelayAnswer>;
  /** Stops the refresh timer. */
  close(): void;
}

export interface RelayServer {
  /** Bound on 127.0.0.1, never 0.0.0.0, and the bind address is not an option. Ephemeral port; OpenCode is told this. */
  readonly port: number;
  setToken(token: string, expiresAt: string, brokerOrigin: string): void;
  close(): Promise<void>;
}

export const REFRESH_PATH = "/api/broker/token/refresh";
/** A token with less life than this is not worth a refresh round trip. */
export const MIN_REFRESH_LEAD_MS = 2_000;
/** Bytes of an upstream error body kept for the failure message. */
const FAILURE_BODY_CAP = 512;
/**
 * How long the broker may take to answer with headers. A streamed answer's
 * headers come once the provider accepted the request, so this is generous.
 */
export const RELAY_HEADERS_TIMEOUT_MS = 5 * 60_000;
/** How long a streamed answer may go without a byte before it is cut. Providers send keep-alive events far more often. */
export const RELAY_IDLE_TIMEOUT_MS = 5 * 60_000;
/** One refresh round trip. */
export const RELAY_REFRESH_TIMEOUT_MS = 30_000;
/** Not sent to anyone: the client that would read it is gone. */
const CLIENT_GONE_STATUS = 499;

function defaultRequestTimer(afterMs: number, run: () => void): () => void {
  const handle = setTimeout(run, afterMs);
  handle.unref?.();
  return () => clearTimeout(handle);
}

/**
 * The upstream body, passed through chunk by chunk with an idle deadline; a
 * cancel from the reader (the client went away) or the deadline aborts the
 * upstream request, so the provider stops generating what nobody will read.
 */
function watchedBody(
  upstream: ReadableStream<Uint8Array>,
  abort: (why: "idle" | "cancelled") => void,
  timer: (afterMs: number, run: () => void) => () => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let cancelIdle: (() => void) | null = null;
  const arm = (): void => {
    cancelIdle?.();
    cancelIdle = timer(RELAY_IDLE_TIMEOUT_MS, () => abort("idle"));
  };
  return new ReadableStream<Uint8Array>({
    start() {
      arm();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cancelIdle?.();
          controller.close();
          return;
        }
        arm();
        controller.enqueue(value);
      } catch (error) {
        cancelIdle?.();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelIdle?.();
      abort("cancelled");
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** Half the remaining life, or null when the token is too close to expiry to bother. */
export function refreshDelayMs(expiresAtMs: number, nowMs: number): number | null {
  const remaining = expiresAtMs - nowMs;
  return remaining <= MIN_REFRESH_LEAD_MS ? null : Math.floor(remaining / 2);
}

export function plannedRefreshRequest(
  brokerOrigin: string,
  token: string,
): {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
} {
  return {
    url: `${brokerOrigin}${REFRESH_PATH}`,
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  };
}

function errorBody(message: string): string {
  // Anthropic's own error envelope, so OpenCode's client parses it and retries
  // a 503 the way it retries the provider's.
  return JSON.stringify({ type: "error", error: { type: "api_error", message } });
}

function lowercased(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function messageOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const message = (parsed as Record<string, unknown>).message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

export function createRelayCore(options: RelayCoreOptions): RelayCore {
  const holder = createRelayTokenHolder();
  let brokerOrigin: string | null = null;
  let expiresAtMs = 0;
  let cancelTimer: (() => void) | null = null;
  let closed = false;

  function scheduleRefresh(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (closed) {
      return;
    }
    const delay = refreshDelayMs(expiresAtMs, options.nowMs());
    if (delay === null) {
      options.log("relay token has too little life left to refresh; waiting for a new grant");
      return;
    }
    cancelTimer = options.schedule(delay, () => {
      cancelTimer = null;
      void refresh();
    });
  }

  async function refresh(): Promise<void> {
    const current = holder.current();
    if (current === null || brokerOrigin === null) {
      return;
    }
    const planned = plannedRefreshRequest(brokerOrigin, current);
    let status: number | null = null;
    try {
      const response = await options.fetchImpl(planned.url, {
        method: planned.method,
        headers: planned.headers,
        signal: AbortSignal.timeout(RELAY_REFRESH_TIMEOUT_MS),
      });
      status = response.status;
      if (response.ok) {
        const body: unknown = await response.json();
        const record =
          typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        if (typeof record.token === "string" && typeof record.expiresAt === "string") {
          setToken(record.token, record.expiresAt, brokerOrigin);
          options.log("relay token refreshed");
          return;
        }
      }
    } catch {
      status = null;
    }
    options.log(
      `relay token refresh refused (${status === null ? "unreachable" : String(status)}); keeping the current token`,
    );
    scheduleRefresh();
  }

  function setToken(token: string, expiresAt: string, origin: string): void {
    holder.replace(token);
    brokerOrigin = origin;
    const parsed = Date.parse(expiresAt);
    expiresAtMs = Number.isNaN(parsed) ? options.nowMs() : parsed;
    scheduleRefresh();
  }

  const requestTimer = options.requestTimer ?? defaultRequestTimer;

  async function handle(
    request: RelayRequest,
    body: ReadableStream<Uint8Array> | null,
    port: number,
    clientGone?: AbortSignal,
  ): Promise<RelayAnswer> {
    const plan = planRelayRequest(
      { brokerOrigin: brokerOrigin ?? "", sessionId: options.sessionId, port },
      brokerOrigin === null ? null : holder.current(),
      request,
    );
    if (plan.kind === "refused") {
      return {
        status: plan.status,
        headers: { "content-type": "application/json" },
        body: errorBody(`relay refused the request: ${plan.reason}`),
      };
    }
    if (clientGone?.aborted === true) {
      // The agent cancelled before the request left: nothing to ask the broker.
      return { status: CLIENT_GONE_STATUS, headers: {}, body: null };
    }
    const upstream = new AbortController();
    let ended: "client_gone" | "headers_timeout" | "idle" | null = null;
    const end = (why: "client_gone" | "headers_timeout" | "idle"): void => {
      ended ??= why;
      upstream.abort();
    };
    const onClientGone = (): void => end("client_gone");
    clientGone?.addEventListener("abort", onClientGone, { once: true });
    const cancelHeadersDeadline = requestTimer(RELAY_HEADERS_TIMEOUT_MS, () =>
      end("headers_timeout"),
    );
    let response: Response;
    try {
      response = await options.fetchImpl(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body,
        signal: upstream.signal,
        // Node's fetch streams a request body only when told the exchange is half-duplex.
        ...(body === null ? {} : { duplex: "half" }),
      } as RequestInit);
    } catch (error) {
      cancelHeadersDeadline();
      clientGone?.removeEventListener("abort", onClientGone);
      if (ended === "client_gone") {
        // The agent cancelled; nothing failed, and nobody reads an answer.
        options.log("relay stopped a request its client abandoned");
        return { status: CLIENT_GONE_STATUS, headers: {}, body: null };
      }
      options.log(
        ended === "headers_timeout"
          ? "relay gave up on a broker that did not answer in time"
          : `relay could not reach the broker: ${error instanceof Error ? error.message : "fetch threw"}`,
      );
      options.onFailure({
        category: "broker_failure",
        message:
          ended === "headers_timeout"
            ? "the broker did not answer in time"
            : "the broker was unreachable",
      });
      return {
        status: ended === "headers_timeout" ? 504 : 502,
        headers: { "content-type": "application/json" },
        body: errorBody(
          ended === "headers_timeout"
            ? "relay gave up waiting for the broker"
            : "relay could not reach the broker",
        ),
      };
    }
    cancelHeadersDeadline();
    const upstreamHeaders = lowercased(response.headers);
    const headers = planRelayResponseHeaders(upstreamHeaders);
    const category = classifyUpstreamFailure(response.status, "");
    // Every successful call says something, even with no header, so a call
    // without counts never inherits the last call's.
    if (category === null) {
      options.onPromptCounts?.(readPromptCounts(upstreamHeaders[PROMPT_COUNTS_HEADER]));
    }
    options.log(
      `relay forwarded ${plan.method} ${RELAY_MESSAGES_PATH}: broker answered ${response.status}`,
    );
    if (category === null) {
      if (response.body === null) {
        clientGone?.removeEventListener("abort", onClientGone);
        return { status: response.status, headers, body: null };
      }
      return {
        status: response.status,
        headers,
        body: watchedBody(
          response.body,
          (why) => {
            if (why === "idle") {
              options.log("relay cut a model stream that went silent");
            }
            end(why === "idle" ? "idle" : "client_gone");
          },
          requestTimer,
        ),
      };
    }
    // A refusal's body is read whole, so it gets the same silence bound as a
    // stream: a broker that sends headers and then nothing must not hold the
    // agent's request forever.
    const cancelBodyDeadline = requestTimer(RELAY_IDLE_TIMEOUT_MS, () => end("idle"));
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    cancelBodyDeadline();
    clientGone?.removeEventListener("abort", onClientGone);
    const classified = classifyUpstreamFailure(response.status, text) ?? category;
    const detail = messageOf(text) ?? text.slice(0, FAILURE_BODY_CAP);
    options.onFailure({
      category: classified,
      message: `broker answered ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
    });
    return { status: response.status, headers, body: text };
  }

  return {
    setToken,
    handle,
    close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      holder.replace(null);
    },
  };
}

function toRelayRequest(req: IncomingMessage): RelayRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") {
      headers[name.toLowerCase()] = first;
    }
  }
  const url = req.url ?? "/";
  const query = url.indexOf("?");
  return {
    method: req.method ?? "GET",
    path: query === -1 ? url : url.slice(0, query),
    headers,
    remoteAddress: req.socket.remoteAddress ?? "",
  };
}

async function writeAnswer(
  res: ServerResponse,
  answer: RelayAnswer,
  clientGone: AbortSignal,
): Promise<void> {
  if (clientGone.aborted) {
    if (answer.body !== null && typeof answer.body !== "string") {
      await answer.body.cancel().catch(() => {});
    }
    res.destroy();
    return;
  }
  res.writeHead(answer.status, answer.headers);
  if (answer.body === null) {
    res.end();
    return;
  }
  if (typeof answer.body === "string") {
    res.end(answer.body);
    return;
  }
  const reader = answer.body.getReader();
  const stop = (): void => {
    void reader.cancel().catch(() => {});
  };
  clientGone.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientGone.aborted) {
        break;
      }
      res.write(value);
    }
  } finally {
    clientGone.removeEventListener("abort", stop);
    res.end();
  }
}

export interface RelayServerOptions extends Omit<RelayCoreOptions, "schedule" | "nowMs"> {
  readonly schedule?: RelayCoreOptions["schedule"];
  readonly nowMs?: RelayCoreOptions["nowMs"];
}

function nodeSchedule(afterMs: number, run: () => void): () => void {
  const handle = setTimeout(run, afterMs);
  return () => clearTimeout(handle);
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const core = createRelayCore({
    ...options,
    schedule: options.schedule ?? nodeSchedule,
    nowMs: options.nowMs ?? Date.now,
  });
  let port = 0;
  const server = createServer((req, res) => {
    const request = toRelayRequest(req);
    const body =
      request.method === "POST"
        ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>)
        : null;
    // The response closing before it finished means the agent's client went
    // away (a cancelled turn): the model stream behind it is stopped too.
    const clientGone = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) {
        clientGone.abort();
      }
    });
    void core
      .handle(request, body, port, clientGone.signal)
      .then((answer) => writeAnswer(res, answer, clientGone.signal))
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, RELAY_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("relay bound to no port"));
        return;
      }
      port = address.port;
      resolve({
        port,
        setToken: core.setToken,
        close: () =>
          new Promise<void>((done) => {
            core.close();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
