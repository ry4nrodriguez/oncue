import type { CheckView, RunId, VerificationCheckState } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { checkDisplayState } from "./check-display";

function check(status: VerificationCheckState): CheckView {
  return {
    checkId: "chk_1" as CheckView["checkId"],
    runId: "run_1" as RunId,
    name: "test",
    category: null,
    classification: null,
    source: null,
    method: null,
    revision: null,
    baseRevision: null,
    status,
    attempts: [],
    latest: null,
  };
}

describe("checkDisplayState", () => {
  it("shows not_finished for a pending or running check once its run has ended", () => {
    expect(checkDisplayState(check("pending"), true)).toBe("not_finished");
    expect(checkDisplayState(check("running"), true)).toBe("not_finished");
  });

  it("keeps pending and running as they are while the run is still going", () => {
    expect(checkDisplayState(check("pending"), false)).toBe("pending");
    expect(checkDisplayState(check("running"), false)).toBe("running");
  });

  it("leaves a settled check's own status alone whether or not the run ended", () => {
    for (const status of ["passed", "failed", "skipped", "inconclusive"] as const) {
      expect(checkDisplayState(check(status), true)).toBe(status);
      expect(checkDisplayState(check(status), false)).toBe(status);
    }
  });
});
