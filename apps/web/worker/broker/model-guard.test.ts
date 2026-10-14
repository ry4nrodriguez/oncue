import { describe, expect, it } from "vitest";
import { allowedModels, modelAllowed } from "./model-guard";

describe("the model cost guard", () => {
  it("narrows nothing on a hosted Worker, whatever the binding says", () => {
    expect(allowedModels("hosted", "claude-sonnet-4-5-20250929")).toBeNull();
    expect(modelAllowed("hosted", "claude-sonnet-4-5-20250929", "gpt-6-astra")).toBe(true);
  });

  it("narrows nothing locally while the binding is unset or blank", () => {
    expect(allowedModels("local", undefined)).toBeNull();
    expect(allowedModels("local", "")).toBeNull();
    expect(allowedModels("local", " , ,")).toBeNull();
    expect(modelAllowed("local", undefined, "gpt-6-astra")).toBe(true);
  });

  it("allows exactly the listed ids locally, trimmed, and refuses the rest", () => {
    const list = " claude-sonnet-4-5-20250929 ,gpt-6-luna ";
    expect([...(allowedModels("local", list) ?? [])]).toEqual([
      "claude-sonnet-4-5-20250929",
      "gpt-6-luna",
    ]);
    expect(modelAllowed("local", list, "gpt-6-luna")).toBe(true);
    expect(modelAllowed("local", list, "claude-opus-5-5")).toBe(false);
  });
});
