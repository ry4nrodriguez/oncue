import { describe, expect, it } from "vitest";
import { coverFor, evidenceRunFor, type RunForCover } from "./publish-cover";

const run = (id: string, outcome: string | null, trigger = "follow_up"): RunForCover => ({
  id,
  outcome,
  trigger,
});

describe("coverFor (record 14, checks before publishing)", () => {
  it("covers a publish with the asking run's own checks when it changed files", () => {
    expect(coverFor([run("run_2", "verified"), run("run_1", "verified")])).toEqual({
      kind: "covered",
      runId: "run_2",
      outcome: "verified",
    });
    expect(coverFor([run("run_1", "completed_with_warnings", "initial")])).toEqual({
      kind: "covered",
      runId: "run_1",
      outcome: "completed_with_warnings",
    });
  });

  it("looks past Done runs, which changed nothing, to the run whose checks describe the code", () => {
    expect(
      coverFor([run("run_3", "completed"), run("run_2", "completed"), run("run_1", "verified")]),
    ).toEqual({ kind: "covered", runId: "run_1", outcome: "verified" });
  });

  it("asks for checks when a cancelled change is the newest code", () => {
    expect(
      coverFor([run("run_3", "completed"), run("run_2", "cancelled"), run("run_1", "verified")]),
    ).toEqual({
      kind: "unchecked",
    });
  });

  it("does not ask again when the checks themselves were cancelled", () => {
    expect(
      coverFor([run("run_3", "cancelled", "checks_requested"), run("run_2", "cancelled")]),
    ).toEqual({ kind: "held" });
  });

  it("holds, and asks for no more checks, when a checks-only run claims it changed nothing", () => {
    expect(
      coverFor([run("run_3", "completed", "checks_requested"), run("run_2", "cancelled")]),
    ).toEqual({ kind: "held" });
  });

  it("asks for checks when no run ever changed code", () => {
    expect(coverFor([run("run_2", "completed"), run("run_1", "completed", "initial")])).toEqual({
      kind: "unchecked",
    });
    expect(coverFor([])).toEqual({ kind: "unchecked" });
  });

  it("holds a publish behind a failed, blocked, or still-open run, as before", () => {
    expect(coverFor([run("run_1", "failed")])).toEqual({ kind: "held" });
    expect(coverFor([run("run_2", "completed"), run("run_1", "blocked")])).toEqual({
      kind: "held",
    });
    expect(coverFor([run("run_1", null)])).toEqual({ kind: "held" });
  });
});

describe("evidenceRunFor", () => {
  it("names the covering run, else the publishing run", () => {
    expect(evidenceRunFor([run("run_2", "completed"), run("run_1", "verified")], "run_2")).toBe(
      "run_1",
    );
    expect(evidenceRunFor([run("run_2", "cancelled")], "run_2")).toBe("run_2");
  });
});
