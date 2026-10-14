import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readModelStepSkipped, writeModelStepSkipped } from "./setup-skip";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the remembered model-step skip", () => {
  it("is not skipped until somebody skips it", () => {
    expect(readModelStepSkipped()).toBe(false);
    writeModelStepSkipped();
    expect(readModelStepSkipped()).toBe(true);
  });

  // Blocked storage must never throw, and must not read as "skipped" when nothing was written.
  it("treats unusable storage as not skipped rather than as a failure", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });

    expect(() => writeModelStepSkipped()).not.toThrow();
    expect(readModelStepSkipped()).toBe(false);
  });
});
