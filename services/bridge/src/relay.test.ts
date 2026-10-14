import { describe, expect, it } from "vitest";
import {
  createRelayTokenHolder,
  planRelayRequest,
  planRelayResponseHeaders,
  RELAY_HOST,
  RELAY_MESSAGES_PATH,
  RELAY_REQUEST_PATHS,
  RELAY_RESPONSES_PATH,
  type RelayConfig,
  type RelayRequest,
  readPromptCounts,
} from "./relay";

const CONFIG: RelayConfig = {
  brokerOrigin: "https://oncue.example",
  sessionId: "sess_1",
  port: 8787,
};

const TOKEN = "mbt_session_token_value";

function request(overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    method: "POST",
    path: RELAY_MESSAGES_PATH,
    headers: { "content-type": "application/json" },
    remoteAddress: RELAY_HOST,
    ...overrides,
  };
}

describe("the relay's request paths", () => {
  it("serves both providers' paths and nothing else", () => {
    // Anthropic's client appends /messages, OpenAI's Responses client /responses.
    for (const path of [RELAY_MESSAGES_PATH, RELAY_RESPONSES_PATH]) {
      expect(RELAY_REQUEST_PATHS).toContain(path);
      expect(planRelayRequest(CONFIG, TOKEN, request({ path })).kind).toBe("forward");
    }
    expect(
      planRelayRequest(CONFIG, TOKEN, request({ path: "/v1/chat/completions" })),
    ).toMatchObject({
      kind: "refused",
      reason: "path_not_served",
    });
  });
});

describe("planRelayRequest", () => {
  it("forwards to the broker with the session token attached", () => {
    expect(planRelayRequest(CONFIG, TOKEN, request())).toEqual({
      kind: "forward",
      url: "https://oncue.example/api/broker/sessions/sess_1/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
    });
  });

  it("replaces an authorization header the agent supplied rather than forwarding it", () => {
    const plan = planRelayRequest(
      CONFIG,
      TOKEN,
      request({
        headers: { "content-type": "application/json", authorization: "Bearer sk-agents-own-key" },
      }),
    );

    expect(plan).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` } });
  });

  it("drops every header it was not asked to forward", () => {
    const plan = planRelayRequest(
      CONFIG,
      TOKEN,
      request({
        headers: {
          "content-type": "application/json",
          cookie: "session=1",
          "x-forwarded-for": "8.8.8.8",
        },
      }),
    );

    expect(plan).toEqual({
      kind: "forward",
      url: "https://oncue.example/api/broker/sessions/sess_1/v1/messages",
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
  });

  it.each([
    ["::1", true],
    [`::ffff:${RELAY_HOST}`, true],
    ["10.0.0.4", false],
    ["8.8.8.8", false],
  ])("accepts %s as loopback: %s", (remoteAddress, allowed) => {
    const plan = planRelayRequest(CONFIG, TOKEN, request({ remoteAddress }));

    expect(plan.kind).toBe(allowed ? "forward" : "refused");
  });

  it.each([
    ["a method it does not serve", request({ method: "GET" }), "method_not_allowed", 405],
    ["a path it does not serve", request({ path: "/token" }), "path_not_served", 404],
    ["a caller off the box", request({ remoteAddress: "10.0.0.4" }), "not_loopback", 403],
  ])("refuses %s", (_name, sent, reason, status) => {
    expect(planRelayRequest(CONFIG, TOKEN, sent)).toEqual({ kind: "refused", reason, status });
  });

  it("refuses with a retryable status when there is no session token yet", () => {
    expect(planRelayRequest(CONFIG, null, request())).toEqual({
      kind: "refused",
      reason: "no_token",
      status: 503,
    });
  });

  it("never puts the token anywhere the agent reads it back", () => {
    const plan = planRelayRequest(CONFIG, TOKEN, request());
    if (plan.kind !== "forward") {
      throw new Error("expected a forward");
    }

    // The token is in the OUTBOUND headers and nowhere else: not the URL, not
    // a refusal, and not any response the relay produces.
    expect(plan.url).not.toContain(TOKEN);
    expect(
      JSON.stringify(planRelayRequest(CONFIG, TOKEN, request({ path: "/token" }))),
    ).not.toContain(TOKEN);
    expect(
      JSON.stringify(planRelayResponseHeaders({ "content-type": "text/plain" })),
    ).not.toContain(TOKEN);
  });
});

describe("planRelayResponseHeaders", () => {
  it("passes back only the headers the agent's client needs", () => {
    expect(
      planRelayResponseHeaders({
        "content-type": "text/event-stream",
        "retry-after": "3",
        "set-cookie": "broker=1",
        "x-internal-connection-id": "conn_1",
      }),
    ).toEqual({ "content-type": "text/event-stream", "retry-after": "3" });
  });
});

describe("createRelayTokenHolder", () => {
  it("starts empty, so a relay that is up before the control plane refuses rather than guesses", () => {
    expect(createRelayTokenHolder().current()).toBeNull();
  });

  it("hands out whichever token is current when a request arrives", () => {
    const holder = createRelayTokenHolder();
    holder.replace("first");
    expect(holder.current()).toBe("first");

    holder.replace("second");
    expect(planRelayRequest(CONFIG, holder.current(), request())).toMatchObject({
      headers: { authorization: "Bearer second" },
    });

    holder.replace(null);
    expect(planRelayRequest(CONFIG, holder.current(), request())).toMatchObject({
      reason: "no_token",
    });
  });

  it("keeps the token out of anything that stringifies the holder", () => {
    const holder = createRelayTokenHolder();
    holder.replace(TOKEN);

    expect(JSON.stringify(holder)).not.toContain(TOKEN);
  });
});

describe("readPromptCounts", () => {
  const COUNTS = { systemTokens: 9_400, toolsTokens: 14_000, oncueToolsTokens: 1_900 };
  const KEY = "0123456789abcdef";
  it("reads a key with three non-negative integers, or a key with a status", () => {
    expect(readPromptCounts(JSON.stringify({ key: KEY, ...COUNTS }))).toEqual({
      kind: "counts",
      key: KEY,
      counts: COUNTS,
    });
    expect(readPromptCounts(JSON.stringify({ key: KEY, status: "pending" }))).toEqual({
      kind: "status",
      key: KEY,
      status: "pending",
    });
    expect(readPromptCounts(JSON.stringify({ key: KEY, status: "unavailable" }))).toEqual({
      kind: "status",
      key: KEY,
      status: "unavailable",
    });
    expect(readPromptCounts(undefined)).toEqual({ kind: "none" });
  });

  it.each([
    ["not json", "{"],
    ["an array", "[1,2,3]"],
    ["null", "null"],
    ["no key", JSON.stringify(COUNTS)],
    ["a key that is not a hash prefix", JSON.stringify({ key: "nope", ...COUNTS })],
    ["a missing field", JSON.stringify({ key: KEY, systemTokens: 1, toolsTokens: 2 })],
    ["an extra field", JSON.stringify({ key: KEY, ...COUNTS, text: "x" })],
    ["a negative count", JSON.stringify({ key: KEY, ...COUNTS, toolsTokens: -1 })],
    ["a fraction", JSON.stringify({ key: KEY, ...COUNTS, toolsTokens: 1.5 })],
    ["a string count", JSON.stringify({ key: KEY, ...COUNTS, toolsTokens: "5" })],
    ["an unknown status", JSON.stringify({ key: KEY, status: "maybe" })],
    ["a status beside counts", JSON.stringify({ key: KEY, status: "pending", ...COUNTS })],
  ])("takes %s as no breakdown", (_name, value) => {
    expect(readPromptCounts(value)).toEqual({ kind: "none" });
  });
});
