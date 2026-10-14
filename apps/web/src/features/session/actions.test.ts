import { describe, expect, it } from "vitest";
import { resultOutput } from "./actions";

// `resultOutput` reads sandbox JSON, so any shape the bridge does not write
// must read as "no output" rather than throw.
describe("resultOutput", () => {
  const inline = (value: unknown) =>
    ({ kind: "inline", summary: "pnpm test", value }) as Parameters<typeof resultOutput>[0];

  it.each([
    ["no result", null],
    ["an artifact result", { kind: "artifact", summary: "s", artifact: {}, truncated: false }],
    ["a none result", { kind: "none", summary: "s" }],
    ["an incomplete result", { kind: "incomplete", summary: "s", reason: "r" }],
    ["a null value", inline(null)],
    ["a string value", inline("printed")],
    ["an array value", inline(["printed"])],
    ["a value with no output", inline({ passed: 1 })],
    ["a value whose output is not text", inline({ output: 42 })],
  ])("reads %s as no output", (_name, result) => {
    expect(resultOutput(result as Parameters<typeof resultOutput>[0])).toBeNull();
  });

  it("reads the bridge's own shape as the printed text with nothing cut", () => {
    expect(resultOutput(inline({ output: "3 passed\n" }))).toEqual({
      text: "3 passed\n",
      droppedChars: 0,
    });
  });

  it("keeps an empty output as text, so a call that printed nothing is not a call that lost it", () => {
    expect(resultOutput(inline({ output: "" }))).toEqual({ text: "", droppedChars: 0 });
  });

  it("reads the bridge's truncation count", () => {
    expect(resultOutput(inline({ output: "start", truncated: true, droppedChars: 1234 }))).toEqual({
      text: "start",
      droppedChars: 1234,
    });
  });

  it.each([
    ["negative", -5],
    ["zero", 0],
    ["not a number", "12"],
    ["not finite", Number.POSITIVE_INFINITY],
    ["not a count", Number.NaN],
  ])("reads a %s droppedChars as nothing cut", (_name, droppedChars) => {
    expect(resultOutput(inline({ output: "x", droppedChars }))?.droppedChars).toBe(0);
  });

  it("rounds a fractional droppedChars down", () => {
    expect(resultOutput(inline({ output: "x", droppedChars: 2.7 }))?.droppedChars).toBe(2);
  });
});
