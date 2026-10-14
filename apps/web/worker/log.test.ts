import { describe, expect, it } from "vitest";
import { type LogFields, log } from "./log";

const validFields: LogFields = {
  timestamp: "2026-09-01T00:00:00.000Z",
  severity: "info",
  service: "web-worker",
  release: "abc1234",
  environment: "local",
  region: "wnam",
  requestId: "req_1",
  traceId: "trace_1",
  sessionId: "session_1",
  runId: "run_1",
  sandboxGeneration: "gen_1",
  deliveryId: "delivery_1",
  operation: "api.health",
  result: "ok",
  durationMs: 12,
  retryCount: 0,
  errorCategory: "none",
  provider: "anthropic",
  inputTokens: 2,
  outputTokens: 253,
  cacheReadTokens: 9_402,
  cacheWriteTokens: 457,
};

describe("log", () => {
  it("accepts a call carrying only allowlisted fields", () => {
    expect(() => log(validFields)).not.toThrow();
  });

  it("throws at runtime when a call carries a forbidden top-level key", () => {
    const withUserId = { ...validFields, userId: "user_123" } as unknown as LogFields;

    expect(() => log(withUserId)).toThrow("log field not allowed: userId");
  });

  // A credential must never reach a log line.
  it("still throws on a credential-shaped key next to the allowed provider field", () => {
    const withKey = { ...validFields, apiKey: "sk-ant-not-real" } as unknown as LogFields;

    expect(() => log(withKey)).toThrow("log field not allowed: apiKey");
  });
});
