import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { RelayFailure } from "./agent";
import type { PromptCountsReading } from "./normalize";
import { PROMPT_COUNTS_HEADER, RELAY_HOST, RELAY_MESSAGES_PATH, type RelayRequest } from "./relay";
import {
  createRelayCore,
  MIN_REFRESH_LEAD_MS,
  plannedRefreshRequest,
  REFRESH_PATH,
  RELAY_HEADERS_TIMEOUT_MS,
  RELAY_IDLE_TIMEOUT_MS,
  type RelayAnswer,
  refreshDelayMs,
  startRelayServer,
} from "./relay-server";

const TOKEN = "ot1.first.token";
const BROKER = "https://oncue.example";
const NOW = Date.parse("2026-09-11T00:00:00.000Z");

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

interface Timer {
  readonly afterMs: number;
  readonly run: () => void;
  cancelled: boolean;
}

function harness(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const timers: Timer[] = [];
  const failures: RelayFailure[] = [];
  const counts: PromptCountsReading[] = [];
  const logs: string[] = [];
  const deadlines: Timer[] = [];
  let now = NOW;
  const core = createRelayCore({
    requestTimer: (afterMs, run) => {
      const timer: Timer = {
        afterMs,
        run: () => {
          timer.cancelled = true;
          run();
        },
        cancelled: false,
      };
      deadlines.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    sessionId: "sess_1",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
    schedule: (afterMs, run) => {
      const timer: Timer = {
        afterMs,
        // A fired timer is spent, as a real one would be.
        run: () => {
          timer.cancelled = true;
          run();
        },
        cancelled: false,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    nowMs: () => now,
    onFailure: (failure) => failures.push(failure),
    onPromptCounts: (reading) => counts.push(reading),
    log: (line) => logs.push(line),
  });
  return {
    core,
    calls,
    timers,
    deadlines,
    failures,
    counts,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    live: () => timers.filter((timer) => !timer.cancelled),
  };
}

function request(overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    method: "POST",
    path: RELAY_MESSAGES_PATH,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "x",
      "x-api-key": "oncue-relay",
    },
    remoteAddress: RELAY_HOST,
    ...overrides,
  };
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

async function text(answer: RelayAnswer): Promise<string> {
  if (answer.body === null) {
    return "";
  }
  if (typeof answer.body === "string") {
    return answer.body;
  }
  return new Response(answer.body).text();
}

describe("refreshDelayMs and plannedRefreshRequest", () => {
  it("refreshes at half the remaining life, or not at all when little is left", () => {
    expect(refreshDelayMs(NOW + 600_000, NOW)).toBe(300_000);
    expect(refreshDelayMs(NOW + MIN_REFRESH_LEAD_MS, NOW)).toBeNull();
    expect(refreshDelayMs(NOW - 1, NOW)).toBeNull();
  });

  it("uses the old token as the bearer against the broker's refresh route", () => {
    expect(plannedRefreshRequest(BROKER, TOKEN)).toEqual({
      url: `${BROKER}${REFRESH_PATH}`,
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  });
});

describe("createRelayCore: refusals", () => {
  it("answers no_token 503 before any grant arrived, without touching the broker", async () => {
    const h = harness(() => new Response(""));
    const answer = await h.core.handle(request(), null, 5001);
    expect(answer.status).toBe(503);
    expect(JSON.parse(await text(answer))).toEqual({
      type: "error",
      error: { type: "api_error", message: "relay refused the request: no_token" },
    });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["not loopback", { remoteAddress: "10.0.0.5" }, 403],
    ["wrong method", { method: "GET" }, 405],
    ["wrong path", { path: "/v1/complete" }, 404],
  ])("refuses %s", async (_name, overrides, status) => {
    const h = harness(() => new Response(""));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    expect((await h.core.handle(request(overrides), null, 5001)).status).toBe(status);
    expect(h.calls).toEqual([]);
  });
});

describe("createRelayCore: forwarding", () => {
  it("forwards to the broker's route with the bearer and the allowlisted headers, streaming the answer back", async () => {
    const h = harness(
      () =>
        new Response("data: {}\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "r1",
            "set-cookie": "no",
          },
        }),
    );
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });

    const answer = await h.core.handle(request(), body, 5001);

    expect(h.calls[0]?.url).toBe(`${BROKER}/api/broker/sessions/sess_1/v1/messages`);
    expect(h.calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "x",
        authorization: `Bearer ${TOKEN}`,
      },
      duplex: "half",
    });
    expect(headersOf(h.calls[0])["x-api-key"]).toBeUndefined();
    expect(answer.status).toBe(200);
    expect(answer.headers).toEqual({ "content-type": "text/event-stream", "x-request-id": "r1" });
    expect(await text(answer)).toBe("data: {}\n\n");
    expect(h.failures).toEqual([]);
  });

  it("classifies a broker refusal, reports it, and hands the agent the broker's own status and body", async () => {
    const h = harness(
      () =>
        new Response(
          JSON.stringify({ category: "authentication_failed", message: "key revoked" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);

    const answer = await h.core.handle(request(), null, 5001);

    expect(answer.status).toBe(403);
    expect(await text(answer)).toContain("key revoked");
    expect(h.failures).toEqual([
      { category: "authentication_failed", message: "broker answered 403: key revoked" },
    ]);
  });

  it("falls back to the status when the body names no category", async () => {
    const h = harness(() => new Response("upstream busy", { status: 429 }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    await h.core.handle(request(), null, 5001);
    expect(h.failures).toEqual([
      { category: "rate_limited", message: "broker answered 429: upstream busy" },
    ]);
  });

  it("reports an unreachable broker as broker_failure and answers 502", async () => {
    const h = harness(() => Promise.reject(new Error("ENOTFOUND")));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 5001);
    expect(answer.status).toBe(502);
    expect(h.failures).toEqual([
      { category: "broker_failure", message: "the broker was unreachable" },
    ]);
  });

  it("never puts the token in a log line", async () => {
    const h = harness(() => new Response("", { status: 500 }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    await h.core.handle(request(), null, 5001);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });
});

/** A streamed answer that sends `first`, then nothing, and errors when the request's signal aborts. */
function endlessAnswer(init: RequestInit | undefined, first = "data: {}\n\n"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
      init?.signal?.addEventListener("abort", () =>
        controller.error(new DOMException("aborted", "AbortError")),
      );
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A fetch that answers only when its signal aborts, with the abort. */
function neverAnswers(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
}

describe("createRelayCore: deadlines and cancellation", () => {
  it("gives up on a broker that sends no headers in time, and says so", async () => {
    const h = harness((call) => neverAnswers(call.init));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answering = h.core.handle(request(), null, 5001);
    await Promise.resolve();
    const deadline = h.deadlines.find((timer) => !timer.cancelled);
    expect(deadline?.afterMs).toBe(RELAY_HEADERS_TIMEOUT_MS);
    deadline?.run();
    const answer = await answering;
    expect(answer.status).toBe(504);
    expect(h.calls[0]?.init?.signal?.aborted).toBe(true);
    expect(h.failures).toEqual([
      { category: "broker_failure", message: "the broker did not answer in time" },
    ]);
  });

  it("cuts a streamed answer that goes silent past the idle bound", async () => {
    const h = harness((call) => endlessAnswer(call.init));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 5001);
    // The headers' deadline is spent once the answer arrived.
    expect(h.deadlines[0]?.cancelled).toBe(true);
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: {}\n\n");
    const idle = h.deadlines.filter((timer) => !timer.cancelled);
    expect(idle.map((timer) => timer.afterMs)).toEqual([RELAY_IDLE_TIMEOUT_MS]);
    idle[0]?.run();
    await expect(reader.read()).rejects.toThrow();
    expect(h.calls[0]?.init?.signal?.aborted).toBe(true);
    expect(h.logs).toContain("relay cut a model stream that went silent");
  });

  it("re-arms the idle bound on every chunk and clears it at the end", async () => {
    const h = harness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              controller.enqueue(new TextEncoder().encode("b"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 5001);
    expect(await text(answer)).toBe("ab");
    expect(h.deadlines.every((timer) => timer.cancelled)).toBe(true);
    expect(h.calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it("aborts the upstream request when the agent's client goes away mid-stream, so the model stops", async () => {
    const h = harness((call) => endlessAnswer(call.init));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const clientGone = new AbortController();
    const answer = await h.core.handle(request(), null, 5001, clientGone.signal);
    expect(h.calls[0]?.init?.signal?.aborted).toBe(false);
    clientGone.abort();
    expect(h.calls[0]?.init?.signal?.aborted).toBe(true);
    await expect(text(answer)).rejects.toThrow();
    expect(h.failures).toEqual([]);
  });

  it("aborts the upstream request when the reader cancels the stream", async () => {
    const h = harness((call) => endlessAnswer(call.init));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 5001);
    await (answer.body as ReadableStream<Uint8Array>).cancel();
    expect(h.calls[0]?.init?.signal?.aborted).toBe(true);
    expect(h.deadlines.every((timer) => timer.cancelled)).toBe(true);
  });

  it.each([
    ["before the request", true],
    ["while waiting for headers", false],
  ])("answers quietly, reporting no failure, when the client left %s", async (_when, early) => {
    const h = harness((call) => neverAnswers(call.init));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const clientGone = new AbortController();
    if (early) {
      clientGone.abort();
    }
    const answering = h.core.handle(request(), null, 5001, clientGone.signal);
    clientGone.abort();
    const answer = await answering;
    expect(answer.status).toBe(499);
    expect(answer.body).toBeNull();
    expect(h.failures).toEqual([]);
    // A client gone before the request left never reaches the broker at all.
    expect(h.calls).toHaveLength(early ? 0 : 1);
  });

  it("bounds the read of a refusal's body, and reports the refusal with what arrived", async () => {
    const h = harness(
      (call) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              call.init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 529 },
        ),
    );
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answering = h.core.handle(request(), null, 5001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = h.deadlines.filter((timer) => !timer.cancelled);
    expect(body.map((timer) => timer.afterMs)).toEqual([RELAY_IDLE_TIMEOUT_MS]);
    body[0]?.run();
    const answer = await answering;
    expect(answer.status).toBe(529);
    expect(h.calls[0]?.init?.signal?.aborted).toBe(true);
    expect(h.failures).toHaveLength(1);
  });

  it("passes an answer with no body through without a watch", async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 5001, new AbortController().signal);
    expect(answer).toMatchObject({ status: 204, body: null });
  });

  it("bounds the refresh round trip", async () => {
    const h = harness(() => new Response("{}", { status: 500 }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    h.live()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls[0]?.url).toBe(`${BROKER}${REFRESH_PATH}`);
    expect(h.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createRelayCore: refresh", () => {
  it("schedules the refresh at half the remaining life and replaces the token on 2xx, rescheduling from the new expiry", async () => {
    const h = harness(() =>
      Response.json({
        token: "ot1.second.token",
        expiresAt: new Date(NOW + 300_000 + 600_000).toISOString(),
      }),
    );
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    expect(h.live().map((timer) => timer.afterMs)).toEqual([300_000]);

    h.advance(300_000);
    h.live()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.calls[0]).toMatchObject({
      url: `${BROKER}${REFRESH_PATH}`,
      init: { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
    });
    expect(h.live().map((timer) => timer.afterMs)).toEqual([300_000]);
    expect(h.logs).toContain("relay token refreshed");

    await h.core.handle(request(), null, 5001);
    expect(headersOf(h.calls[1]).authorization).toBe("Bearer ot1.second.token");
  });

  it("keeps the current token when the refresh is refused, and tries again at half of what remains", async () => {
    const h = harness(() => new Response("", { status: 403 }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    h.advance(300_000);
    h.live()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.logs).toContain("relay token refresh refused (403); keeping the current token");
    expect(h.live().map((timer) => timer.afterMs)).toEqual([150_000]);
    await h.core.handle(request(), null, 5001);
    expect(headersOf(h.calls[1]).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps the token when the broker is unreachable", async () => {
    const h = harness(() => Promise.reject(new Error("x")));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    h.live()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.logs).toContain(
      "relay token refresh refused (unreachable); keeping the current token",
    );
  });

  it("does not schedule a refresh for a token with too little life left, and says so", () => {
    const h = harness(() => new Response(""));
    h.core.setToken(TOKEN, new Date(NOW + 1_000).toISOString(), BROKER);
    expect(h.live()).toEqual([]);
    expect(h.logs).toEqual([
      "relay token has too little life left to refresh; waiting for a new grant",
    ]);
  });

  it("a new grant cancels the pending refresh and restarts from its own expiry", () => {
    const h = harness(() => new Response(""));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    h.core.setToken("ot1.rotated", new Date(NOW + 1_200_000).toISOString(), BROKER);
    expect(h.timers.map((timer) => [timer.afterMs, timer.cancelled])).toEqual([
      [300_000, true],
      [600_000, false],
    ]);
  });

  it("close cancels the timer and drops the token", async () => {
    const h = harness(() => new Response(""));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    h.core.close();
    expect(h.live()).toEqual([]);
    expect((await h.core.handle(request(), null, 5001)).status).toBe(503);
  });
});

describe("startRelayServer", () => {
  it("binds loopback on an ephemeral port and relays a POST through the injected fetch", async () => {
    const calls: Call[] = [];
    const failures: RelayFailure[] = [];
    const server = await startRelayServer({
      sessionId: "sess_1",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const body =
          init?.body instanceof ReadableStream ? await new Response(init.body).text() : "";
        calls.push({ url: String(input), init });
        return new Response(`echo:${body}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as typeof fetch,
      onFailure: (failure) => failures.push(failure),
      log: () => {},
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      server.setToken(TOKEN, new Date(Date.now() + 600_000).toISOString(), BROKER);

      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: RELAY_HOST,
            port: server.port,
            method: "POST",
            path: RELAY_MESSAGES_PATH,
            headers: { "content-type": "application/json" },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end('{"model":"x"}');
      });

      expect(answer).toEqual({ status: 200, body: 'echo:{"model":"x"}' });
      expect(calls[0]?.url).toBe(`${BROKER}/api/broker/sessions/sess_1/v1/messages`);
      expect(failures).toEqual([]);

      const refused = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: RELAY_HOST, port: server.port, method: "GET", path: RELAY_MESSAGES_PATH },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(refused).toBe(405);
    } finally {
      await server.close();
    }
  });
});

describe("createRelayCore: the broker's prompt counts", () => {
  const COUNTS = { systemTokens: 9_400, toolsTokens: 14_000, oncueToolsTokens: 1_900 };
  const KEY = "0123456789abcdef";
  async function forwardWith(headers: Record<string, string>, status = 200) {
    const h = harness(() => new Response("{}", { status, headers }));
    h.core.setToken(TOKEN, new Date(NOW + 600_000).toISOString(), BROKER);
    const answer = await h.core.handle(request(), null, 4096);
    return { h, answer };
  }

  it("hands the keyed counts to the bridge and never to the agent", async () => {
    const { h, answer } = await forwardWith({
      [PROMPT_COUNTS_HEADER]: JSON.stringify({ key: KEY, ...COUNTS }),
    });
    expect(h.counts).toEqual([{ kind: "counts", key: KEY, counts: COUNTS }]);
    expect(Object.keys(answer.headers)).not.toContain(PROMPT_COUNTS_HEADER);
  });

  it("passes a status on, and says none for a successful call with no header", async () => {
    const pending = await forwardWith({
      [PROMPT_COUNTS_HEADER]: JSON.stringify({ key: KEY, status: "pending" }),
    });
    expect(pending.h.counts).toEqual([{ kind: "status", key: KEY, status: "pending" }]);
    expect((await forwardWith({})).h.counts).toEqual([{ kind: "none" }]);
  });

  it("ignores counts on a refused answer", async () => {
    const { h } = await forwardWith(
      { [PROMPT_COUNTS_HEADER]: JSON.stringify({ key: KEY, ...COUNTS }) },
      429,
    );
    expect(h.counts).toEqual([]);
    expect(h.failures).toHaveLength(1);
  });
});

describe("startRelayServer: a cancelled turn", () => {
  it("aborts the model stream upstream when the agent's client disconnects", async () => {
    let upstreamAborted: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      upstreamAborted = resolve;
    });
    const server = await startRelayServer({
      sessionId: "sess_1",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => upstreamAborted());
        return endlessAnswer(init);
      }) as typeof fetch,
      onFailure: () => {},
      log: () => {},
    });
    try {
      server.setToken(TOKEN, new Date(Date.now() + 600_000).toISOString(), BROKER);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: RELAY_HOST,
            port: server.port,
            method: "POST",
            path: RELAY_MESSAGES_PATH,
            headers: { "content-type": "application/json" },
          },
          (res) => {
            res.once("data", () => {
              // The agent cancels its turn: its client drops the connection.
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.on("close", () => {});
        req.end("{}");
        setTimeout(() => reject(new Error("no first chunk")), 5_000);
      });
      await aborted;
    } finally {
      await server.close();
    }
  });

  it("drops an answer whose client left before it arrived", async () => {
    let answer: (response: Response) => void = () => {};
    let fetched: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    let bodyCancelled = false;
    const server = await startRelayServer({
      sessionId: "sess_1",
      fetchImpl: (() =>
        new Promise<Response>((resolve) => {
          answer = resolve;
          fetched();
        })) as typeof fetch,
      onFailure: () => {},
      log: () => {},
    });
    try {
      server.setToken(TOKEN, new Date(Date.now() + 600_000).toISOString(), BROKER);
      const req = httpRequest({
        host: RELAY_HOST,
        port: server.port,
        method: "POST",
        path: RELAY_MESSAGES_PATH,
        headers: { "content-type": "application/json" },
      });
      req.on("error", () => {});
      req.end("{}");
      await asked;
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The broker answers only after the client is gone.
      answer(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 200 },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bodyCancelled).toBe(true);
    } finally {
      await server.close();
    }
  });
});
