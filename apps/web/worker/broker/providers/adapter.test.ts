import { describe, expect, it } from "vitest";
import { createProviderDouble, type DoubleMode } from "../../test/provider-double";
import {
  PROVIDER_ADAPTERS,
  PROVIDER_IDS,
  type ProviderCategory,
  type ProviderId,
  parseProviderId,
  resolveProviderOrigin,
} from "./adapter";

describe("parseProviderId", () => {
  it("parses every id in the closed union", () => {
    for (const id of PROVIDER_IDS) {
      expect(parseProviderId(id)).toBe(id);
    }
  });

  // Reachable if a migration widens the CHECK before this parser is updated.
  it("rejects a value outside the closed union", () => {
    expect(parseProviderId("cohere")).toBeNull();
  });
});

describe("PROVIDER_ADAPTERS", () => {
  it("indexes an adapter for every provider id, keyed by its own id", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_ADAPTERS[id].id).toBe(id);
    }
  });
});

describe("applyCredential", () => {
  it("anthropic sets x-api-key and the pinned anthropic-version", () => {
    const headers = new Headers();
    PROVIDER_ADAPTERS.anthropic.applyCredential(headers, "sk-ant-secret");
    expect(headers.get("x-api-key")).toBe("sk-ant-secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("openai sets a bearer authorization header", () => {
    const headers = new Headers();
    PROVIDER_ADAPTERS.openai.applyCredential(headers, "sk-openai-secret");
    expect(headers.get("authorization")).toBe("Bearer sk-openai-secret");
  });
});

describe("anthropic classify", () => {
  const cases: ReadonlyArray<[number, string | null, ProviderCategory]> = [
    [401, null, "authentication_failed"],
    [403, null, "authentication_failed"],
    [404, null, "model_unavailable"],
    [429, null, "rate_limited"],
    [413, null, "request_rejected"],
    [400, "invalid_request_error", "request_rejected"],
    [529, "overloaded_error", "temporary_service_failure"],
    [500, null, "temporary_service_failure"],
    // No signal in the records maps this status; the fallback path.
    [418, null, "request_rejected"],
  ];

  it.each(cases)("status %i (code %s) -> %s", (status, errorCode, expected) => {
    expect(PROVIDER_ADAPTERS.anthropic.classify(status, errorCode)).toBe(expected);
  });
});

describe("openai classify", () => {
  const cases: ReadonlyArray<[number, string | null, ProviderCategory]> = [
    [401, null, "authentication_failed"],
    [403, null, "authentication_failed"],
    [404, null, "model_unavailable"],
    [429, "rate_limit_error", "rate_limited"],
    [429, "insufficient_quota", "usage_limit_reached"],
    [400, "invalid_request_error", "request_rejected"],
    [503, null, "temporary_service_failure"],
    [418, null, "request_rejected"],
  ];

  it.each(cases)("status %i (code %s) -> %s", (status, errorCode, expected) => {
    expect(PROVIDER_ADAPTERS.openai.classify(status, errorCode)).toBe(expected);
  });
});

describe("anthropic errorCodeOf", () => {
  it("reads error.type from a well-formed envelope", () => {
    const body = { type: "error", error: { type: "rate_limit_error", message: "slow down" } };
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf(body)).toBe("rate_limit_error");
  });

  it("returns null for a non-object body", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf("not json")).toBeNull();
  });

  it("returns null for a null body", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf(null)).toBeNull();
  });

  it("returns null for an array body", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf([])).toBeNull();
  });

  it("returns null when error is missing", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf({})).toBeNull();
  });

  it("returns null when error is not an object", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf({ error: "oops" })).toBeNull();
  });

  it("returns null when error.type is not a string", () => {
    expect(PROVIDER_ADAPTERS.anthropic.errorCodeOf({ error: { type: 42 } })).toBeNull();
  });
});

describe("openai errorCodeOf", () => {
  it("prefers error.code over error.type", () => {
    const body = { error: { code: "insufficient_quota", type: "insufficient_quota" } };
    expect(PROVIDER_ADAPTERS.openai.errorCodeOf(body)).toBe("insufficient_quota");
  });

  it("falls back to error.type when code is absent", () => {
    const body = { error: { type: "rate_limit_error", code: null } };
    expect(PROVIDER_ADAPTERS.openai.errorCodeOf(body)).toBe("rate_limit_error");
  });

  it("returns null when neither code nor type is a string", () => {
    expect(PROVIDER_ADAPTERS.openai.errorCodeOf({ error: {} })).toBeNull();
  });

  it("returns null for a non-object body", () => {
    expect(PROVIDER_ADAPTERS.openai.errorCodeOf(42)).toBeNull();
  });

  it("returns null when error is not an object", () => {
    expect(PROVIDER_ADAPTERS.openai.errorCodeOf({ error: null })).toBeNull();
  });
});

describe("anthropic validate", () => {
  it("returns ok with a credential hint on success", async () => {
    const double = createProviderDouble("anthropic", "ok");
    const result = await PROVIDER_ADAPTERS.anthropic.validate({
      origin: "https://double.example",
      credential: "sk-ant-abcd1234wxyz",
      fetchImpl: double.fetchImpl,
    });
    expect(result).toEqual({ kind: "ok", accountHint: "...wxyz" });
    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]?.url).toBe("https://double.example/v1/models");
    expect(double.calls[0]?.headers["x-api-key"]).toBe("sk-ant-abcd1234wxyz");
  });

  it("classifies a provider-shaped failure body", async () => {
    const double = createProviderDouble("anthropic", "auth_failed");
    const result = await PROVIDER_ADAPTERS.anthropic.validate({
      origin: "https://double.example",
      credential: "sk-ant-bad",
      fetchImpl: double.fetchImpl,
    });
    expect(result).toEqual({ kind: "failed", category: "authentication_failed" });
  });

  it("treats a rejected fetch as a temporary service failure", async () => {
    const throwingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const result = await PROVIDER_ADAPTERS.anthropic.validate({
      origin: "https://unreachable.example",
      credential: "sk-ant-x",
      fetchImpl: throwingFetch,
    });
    expect(result).toEqual({ kind: "failed", category: "temporary_service_failure" });
  });

  it("classifies a failure whose body is not valid JSON", async () => {
    const brokenBodyFetch: typeof fetch = async () => new Response("not json", { status: 500 });
    const result = await PROVIDER_ADAPTERS.anthropic.validate({
      origin: "https://double.example",
      credential: "sk-ant-x",
      fetchImpl: brokenBodyFetch,
    });
    expect(result).toEqual({ kind: "failed", category: "temporary_service_failure" });
  });
});

describe("openai validate", () => {
  it("returns ok with a credential hint on success", async () => {
    const double = createProviderDouble("openai", "ok");
    const result = await PROVIDER_ADAPTERS.openai.validate({
      origin: "https://double.example",
      credential: "sk-openai-abcd1234wxyz",
      fetchImpl: double.fetchImpl,
    });
    expect(result).toEqual({ kind: "ok", accountHint: "...wxyz" });
    expect(double.calls[0]?.url).toBe("https://double.example/v1/models");
    expect(double.calls[0]?.headers.authorization).toBe("Bearer sk-openai-abcd1234wxyz");
  });

  it("classifies a provider-shaped failure body", async () => {
    const double = createProviderDouble("openai", "usage_limit");
    const result = await PROVIDER_ADAPTERS.openai.validate({
      origin: "https://double.example",
      credential: "sk-openai-bad",
      fetchImpl: double.fetchImpl,
    });
    expect(result).toEqual({ kind: "failed", category: "usage_limit_reached" });
  });

  it("treats a rejected fetch as a temporary service failure", async () => {
    const throwingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const result = await PROVIDER_ADAPTERS.openai.validate({
      origin: "https://unreachable.example",
      credential: "sk-openai-x",
      fetchImpl: throwingFetch,
    });
    expect(result).toEqual({ kind: "failed", category: "temporary_service_failure" });
  });

  it("classifies a failure whose body is not valid JSON", async () => {
    const brokenBodyFetch: typeof fetch = async () => new Response("not json", { status: 500 });
    const result = await PROVIDER_ADAPTERS.openai.validate({
      origin: "https://double.example",
      credential: "sk-openai-x",
      fetchImpl: brokenBodyFetch,
    });
    expect(result).toEqual({ kind: "failed", category: "temporary_service_failure" });
  });
});

// Every `ProviderCategory` is reachable through a real fetch, a
// provider-shaped error body, `errorCodeOf`, and `classify`, not only by
// calling `classify` directly.
describe("every ProviderCategory is reachable through a real adapter+double round trip", () => {
  const table: ReadonlyArray<[ProviderId, DoubleMode, ProviderCategory]> = [
    ["anthropic", "rate_limited", "rate_limited"],
    ["anthropic", "auth_failed", "authentication_failed"],
    ["anthropic", "model_unavailable", "model_unavailable"],
    ["anthropic", "rejected", "request_rejected"],
    ["anthropic", "overloaded", "temporary_service_failure"],
    ["openai", "usage_limit", "usage_limit_reached"],
  ];

  it.each(table)("%s / %s -> %s", async (provider, mode, expected) => {
    const double = createProviderDouble(provider, mode);
    const result = await PROVIDER_ADAPTERS[provider].validate({
      origin: "https://double.example",
      credential: "secret",
      fetchImpl: double.fetchImpl,
    });
    expect(result).toEqual({ kind: "failed", category: expected });
  });
});

const ALL_FAILURE_MODES: readonly DoubleMode[] = [
  "rate_limited",
  "usage_limit",
  "auth_failed",
  "model_unavailable",
  "rejected",
  "overloaded",
];

describe("createProviderDouble covers every failure mode for both providers", () => {
  it.each(ALL_FAILURE_MODES)("anthropic mode %s fails validate", async (mode) => {
    const double = createProviderDouble("anthropic", mode);
    const result = await PROVIDER_ADAPTERS.anthropic.validate({
      origin: "https://double.example",
      credential: "sk-ant-x",
      fetchImpl: double.fetchImpl,
    });
    expect(result.kind).toBe("failed");
  });

  it.each(ALL_FAILURE_MODES)("openai mode %s fails validate", async (mode) => {
    const double = createProviderDouble("openai", mode);
    const result = await PROVIDER_ADAPTERS.openai.validate({
      origin: "https://double.example",
      credential: "sk-openai-x",
      fetchImpl: double.fetchImpl,
    });
    expect(result.kind).toBe("failed");
  });
});

describe("createProviderDouble streaming", () => {
  it("streams anthropic SSE frames ending in message_stop", async () => {
    const double = createProviderDouble("anthropic", "ok");
    double.setStreamPacing(2, 0);
    const response = await double.fetchImpl("https://double.example/v1/messages", {
      headers: new Headers({ "x-api-key": "k" }),
    });
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text.trim().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("streams openai Responses API events, from created to completed", async () => {
    const double = createProviderDouble("openai", "ok");
    double.setStreamPacing(2, 0);
    const response = await double.fetchImpl("https://double.example/v1/responses", {
      headers: new Headers({ authorization: "Bearer k" }),
    });
    const text = await response.text();
    expect(text).toContain("event: response.created\n");
    expect(text).toContain('"type":"response.output_text.delta"');
    // Two chunks: two delta events, each named on its event line and in its JSON.
    expect((text.match(/event: response\.output_text\.delta\n/g) ?? []).length).toBe(2);
    expect(text.trim().split("\n\n").at(-1)).toMatch(/^event: response\.completed\ndata: /);
    expect(text).not.toContain("[DONE]");
  });

  it("records the effort a request body names, in either provider's field", async () => {
    const double = createProviderDouble("openai", "ok");
    await double.fetchImpl("https://double.example/v1/responses", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer k" }),
      body: JSON.stringify({ model: "gpt-6-sol", reasoning: { effort: "low" }, input: [] }),
    });
    await double.fetchImpl("https://double.example/v1/responses", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer k" }),
      body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
    });
    expect(double.calls.map((call) => call.effort)).toEqual(["low", null]);
  });

  it("returns a plain JSON body for a non-messages path", async () => {
    const double = createProviderDouble("anthropic", "ok");
    const response = await double.fetchImpl("https://double.example/v1/models", {
      headers: new Headers(),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [] });
  });

  it("setMode switches a later call from ok to a failure shape", async () => {
    const double = createProviderDouble("anthropic", "ok");
    double.setMode("rejected");
    const response = await double.fetchImpl("https://double.example/v1/messages", {
      headers: new Headers(),
    });
    expect(response.status).toBe(400);
  });

  it("resolves a URL instance and a Request instance the same as a string", async () => {
    const double = createProviderDouble("openai");
    await double.fetchImpl(new URL("https://double.example/v1/models"));
    await double.fetchImpl(new Request("https://double.example/v1/models2"));
    expect(double.calls[0]?.url).toBe("https://double.example/v1/models");
    expect(double.calls[1]?.url).toBe("https://double.example/v1/models2");
  });

  it("records an empty header set when init is omitted", async () => {
    const double = createProviderDouble("openai");
    await double.fetchImpl("https://double.example/v1/models");
    expect(double.calls[0]?.headers).toEqual({});
  });
});

describe("resolveProviderOrigin", () => {
  const adapter = PROVIDER_ADAPTERS.anthropic;

  // An override honoured outside local would let a hosted deploy's provider
  // traffic be redirected.
  it("honours the override only when the environment is local", () => {
    expect(resolveProviderOrigin(adapter, "local", "https://provider.double")).toBe(
      "https://provider.double",
    );
    expect(resolveProviderOrigin(adapter, "local", undefined)).toBe(adapter.origin);
    expect(resolveProviderOrigin(adapter, "local", "")).toBe(adapter.origin);
    expect(resolveProviderOrigin(adapter, "hosted", "https://provider.double")).toBe(
      adapter.origin,
    );
    expect(resolveProviderOrigin(adapter, "preview", "https://provider.double")).toBe(
      adapter.origin,
    );
  });
});
