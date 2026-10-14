import { describe, expect, it } from "vitest";
import {
  decideCommit,
  decideDescription,
  LIVE_RUN_STATES,
  MAX_COMMITS_PER_RUN,
  MAX_DESCRIPTIONS_PER_RUN,
  mergeDescription,
  pullRequestText,
  type StoredDescription,
} from "./pr-description";

describe("decideDescription", () => {
  it("admits one while its run runs, under the bound", () => {
    expect(decideDescription({ runRunning: true, admittedThisRun: 0 })).toEqual({ kind: "admit" });
    expect(
      decideDescription({ runRunning: true, admittedThisRun: MAX_DESCRIPTIONS_PER_RUN - 1 }),
    ).toEqual({ kind: "admit" });
  });

  it("refuses one outside a running run, and one past the bound", () => {
    expect(decideDescription({ runRunning: false, admittedThisRun: 0 })).toEqual({
      kind: "refuse",
      reason: "description_run_not_running",
    });
    expect(
      decideDescription({ runRunning: true, admittedThisRun: MAX_DESCRIPTIONS_PER_RUN }),
    ).toEqual({ kind: "refuse", reason: "too_many_descriptions" });
  });
});

describe("decideCommit", () => {
  it("admits one while its run is live, under its own bound, and refuses otherwise", () => {
    expect(decideCommit({ runRunning: true, admittedThisRun: 0 })).toEqual({ kind: "admit" });
    expect(decideCommit({ runRunning: true, admittedThisRun: MAX_COMMITS_PER_RUN - 1 })).toEqual({
      kind: "admit",
    });
    expect(decideCommit({ runRunning: false, admittedThisRun: 0 })).toEqual({
      kind: "refuse",
      reason: "commit_run_not_running",
    });
    expect(decideCommit({ runRunning: true, admittedThisRun: MAX_COMMITS_PER_RUN })).toEqual({
      kind: "refuse",
      reason: "too_many_commits",
    });
  });

  it("counts a run as live while it runs, waits on an approval, or is paused, and not once it ended", () => {
    expect([...LIVE_RUN_STATES].sort()).toEqual(["paused", "running", "waiting_for_approval"]);
    for (const ended of ["verified", "completed_with_warnings", "failed", "cancelled", "blocked"]) {
      expect(LIVE_RUN_STATES.has(ended)).toBe(false);
    }
  });
});

describe("mergeDescription", () => {
  it("starts at version 1 with nothing applied", () => {
    expect(mergeDescription(null, { title: "T", body: null, branchName: null })).toEqual({
      title: "T",
      body: null,
      branchName: null,
      version: 1,
      appliedVersion: 0,
    });
  });

  it("keeps a field the new description leaves null, and what GitHub last took", () => {
    const stored: StoredDescription = {
      title: "T",
      body: "B",
      branchName: "oncue/x",
      version: 3,
      appliedVersion: 2,
    };
    expect(mergeDescription(stored, { title: null, body: "B2", branchName: null })).toEqual({
      title: "T",
      body: "B2",
      branchName: "oncue/x",
      version: 4,
      appliedVersion: 2,
    });
  });
});

describe("pullRequestText", () => {
  const described = (overrides: Partial<StoredDescription> = {}): StoredDescription => ({
    title: "Agent title",
    body: "Agent body",
    branchName: null,
    version: 1,
    appliedVersion: 0,
    ...overrides,
  });

  it("falls back to the session's title, then the branch, when the agent said nothing", () => {
    expect(pullRequestText(null, "Fix it", "oncue/x")).toEqual({
      title: "Fix it",
      summary: "Fix it",
      rewrite: null,
    });
    expect(pullRequestText(null, null, "oncue/x")).toMatchObject({
      title: "OnCue: oncue/x",
      summary: "OnCue: oncue/x",
    });
  });

  it("uses the agent's words, and asks for a rewrite only when they are new", () => {
    expect(pullRequestText(described(), "Fix it", "oncue/x")).toEqual({
      title: "Agent title",
      summary: "Agent body",
      rewrite: { title: "Agent title", summary: "Agent body" },
    });
    expect(pullRequestText(described({ appliedVersion: 1 }), "Fix it", "oncue/x").rewrite).toBe(
      null,
    );
  });

  it("mixes the agent's field with the fallback, and asks no rewrite for a branch name alone", () => {
    expect(pullRequestText(described({ title: null }), "Fix it", "oncue/x")).toMatchObject({
      title: "Fix it",
      summary: "Agent body",
    });
    expect(
      pullRequestText(described({ title: null, body: null, branchName: "oncue/y" }), "Fix it", "b")
        .rewrite,
    ).toBeNull();
  });
});
