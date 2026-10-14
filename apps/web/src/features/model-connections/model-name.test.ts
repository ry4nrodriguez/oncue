import { describe, expect, it } from "vitest";
import { displayModelName, shortModelName } from "./model-name";

describe("displayModelName", () => {
  it("keeps a Claude id's family and version and drops its release date", () => {
    expect(displayModelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(displayModelName("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(displayModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    // Any family, not a fixed list of them.
    expect(displayModelName("claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("names a single-number version without inventing a minor", () => {
    expect(displayModelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(displayModelName("claude-opus-4")).toBe("Opus 4");
  });

  it("upper-cases GPT ids", () => {
    expect(displayModelName("gpt-5")).toBe("GPT-5");
    expect(displayModelName("gpt-4o-mini")).toBe("GPT-4o-mini");
  });

  it("returns an id it does not recognise unchanged rather than guessing", () => {
    expect(displayModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
    expect(displayModelName("mistral-large")).toBe("mistral-large");
    expect(displayModelName("")).toBe("");
  });
});

describe("shortModelName", () => {
  it("drops the brand word in front of a Claude name and leaves the rest alone", () => {
    expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortModelName("Claude Sonnet 4.5")).toBe("Sonnet 4.5");
    expect(shortModelName("GPT-6 Sol")).toBe("GPT-6 Sol");
    expect(shortModelName("Claudette 1")).toBe("Claudette 1");
  });
});
