import { describe, expect, it } from "vitest";
import type { InactiveModelConnection } from "@/lib/api/setup";
import { INACTIVE_KEY_WORDS, inactiveKeyBanner } from "./inactive-keys";

function key(overrides: Partial<InactiveModelConnection> = {}): InactiveModelConnection {
  return {
    modelConnectionId: "mc_bad",
    provider: "openai",
    status: "invalid",
    activeSessions: 0,
    ...overrides,
  };
}

describe("inactiveKeyBanner", () => {
  it("names the provider and what happened to its key", () => {
    expect(inactiveKeyBanner(key())).toBe(
      "The OpenAI key was rejected. No active session uses it.",
    );
    expect(inactiveKeyBanner(key({ provider: "anthropic", status: "expired" }))).toBe(
      "The Anthropic key has expired. No active session uses it.",
    );
    expect(inactiveKeyBanner(key({ status: "attention_required" }))).toBe(
      "The OpenAI key needs attention. No active session uses it.",
    );
  });

  it("counts the active sessions on it, one or many", () => {
    expect(inactiveKeyBanner(key({ activeSessions: 1 }))).toBe(
      "The OpenAI key was rejected. 1 active session uses it and can't continue until the key is replaced.",
    );
    expect(inactiveKeyBanner(key({ activeSessions: 4 }))).toBe(
      "The OpenAI key was rejected. 4 active sessions use it and can't continue until the key is replaced.",
    );
  });
});

describe("INACTIVE_KEY_WORDS", () => {
  it("says a rejected key was rejected", () => {
    expect(INACTIVE_KEY_WORDS).toEqual({
      invalid: "Key rejected",
      expired: "Key expired",
      attention_required: "Key needs attention",
    });
  });
});
