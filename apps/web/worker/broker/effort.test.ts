import { describe, expect, it } from "vitest";
import { enforceEffort } from "./effort";

function bytes(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

function decode(body: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder().decode(body));
}

describe("effort enforcement at the broker", () => {
  it("writes the recorded effort into a body that names none, in the provider's own field", () => {
    const anthropic = enforceEffort(
      bytes({ model: "claude-opus-5-5", messages: [] }),
      { model: "claude-opus-5-5", messages: [] },
      "anthropic",
      "medium",
    );
    expect(anthropic.kind).toBe("forward");
    if (anthropic.kind === "forward") {
      expect(decode(anthropic.body)).toEqual({
        model: "claude-opus-5-5",
        messages: [],
        output_config: { effort: "medium" },
      });
    }
    const openai = enforceEffort(
      bytes({ model: "gpt-6-sol", input: [] }),
      { model: "gpt-6-sol", input: [] },
      "openai",
      "low",
    );
    if (openai.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(decode(openai.body)).toEqual({
      model: "gpt-6-sol",
      input: [],
      reasoning: { effort: "low" },
    });
  });

  it("keeps the rest of an existing container when it writes the level in", () => {
    const parsed = { model: "gpt-6-sol", reasoning: { summary: "auto" } };
    const outcome = enforceEffort(bytes(parsed), parsed, "openai", "high");
    if (outcome.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(decode(outcome.body)).toEqual({
      model: "gpt-6-sol",
      reasoning: { summary: "auto", effort: "high" },
    });
  });

  it("forwards a body that already names the recorded effort byte for byte", () => {
    const raw = bytes({ model: "claude-opus-5-5", output_config: { effort: "medium" } });
    const outcome = enforceEffort(
      raw,
      { model: "claude-opus-5-5", output_config: { effort: "medium" } },
      "anthropic",
      "medium",
    );
    expect(outcome).toEqual({ kind: "forward", body: raw });
  });

  it("refuses a body that names a different effort than the run recorded", () => {
    expect(
      enforceEffort(
        bytes({}),
        { model: "claude-opus-5-5", output_config: { effort: "max" } },
        "anthropic",
        "medium",
      ),
    ).toEqual({ kind: "denied" });
    expect(
      enforceEffort(
        bytes({}),
        { model: "gpt-6-sol", reasoning: { effort: "xhigh" } },
        "openai",
        "low",
      ),
    ).toEqual({ kind: "denied" });
  });

  it("leaves a run with no recorded effort alone, and refuses a body that sets one anyway", () => {
    const raw = bytes({ model: "claude-haiku-4-5-20251001", messages: [] });
    expect(
      enforceEffort(raw, { model: "claude-haiku-4-5-20251001", messages: [] }, "anthropic", null),
    ).toEqual({ kind: "forward", body: raw });
    expect(
      enforceEffort(
        raw,
        { model: "claude-haiku-4-5-20251001", output_config: { effort: "low" } },
        "anthropic",
        null,
      ),
    ).toEqual({ kind: "denied" });
  });

  it("treats a container that is not an object as naming nothing", () => {
    const parsed = { model: "gpt-6-sol", reasoning: "high" };
    const outcome = enforceEffort(bytes(parsed), parsed, "openai", "medium");
    if (outcome.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(decode(outcome.body)).toEqual({ model: "gpt-6-sol", reasoning: { effort: "medium" } });
  });
});
