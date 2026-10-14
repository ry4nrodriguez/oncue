import { describe, expect, it } from "vitest";
import { attempt } from "./driver";

describe("attempt", () => {
  it("returns an ok outcome when run resolves", async () => {
    const outcome = await attempt(
      async () => 42,
      () => {
        throw new Error("onError must not run on the success path");
      },
    );

    expect(outcome).toEqual({ kind: "ok", value: 42 });
  });

  it("hands a thrown error to onError instead of letting it escape", async () => {
    const thrown = new Error("boom");

    const outcome = await attempt(
      async () => {
        throw thrown;
      },
      (error) => ({
        kind: "error",
        category: "unknown",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }),
    );

    expect(outcome).toEqual({
      kind: "error",
      category: "unknown",
      message: "boom",
      retryable: false,
    });
  });
});
