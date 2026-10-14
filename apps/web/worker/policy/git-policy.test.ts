import { describe, expect, it } from "vitest";
import {
  allowsCheckpointPush,
  allowsPullRequest,
  allowsPush,
  changedFields,
  DEFAULT_SESSION_POLICY,
  decideConfirmation,
  decideControl,
  decideProposal,
  directionOf,
  lockedDown,
  MAX_PROPOSALS_PER_RUN,
  type OpenProposal,
  type ProposalContext,
  type SessionPolicy,
} from "./git-policy";

const stored: SessionPolicy = DEFAULT_SESSION_POLICY;
const pushing: SessionPolicy = {
  ...stored,
  push: "auto",
  pullRequest: "auto_after_verification",
};

function context(overrides: Partial<ProposalContext> = {}): ProposalContext {
  return { stored, runRunning: true, messageIsUsers: true, admittedThisRun: 0, ...overrides };
}

describe("the default policy", () => {
  it("commits, and neither pushes nor opens a pull request", () => {
    expect(stored).toMatchObject({ commit: "auto", push: "manual", pullRequest: "manual" });
    expect(allowsPush(stored)).toBe(false);
    expect(allowsPullRequest(stored)).toBe(false);
  });

  it("still lets the object push its own checkpoint, until push is never", () => {
    expect(allowsCheckpointPush(stored)).toBe(true);
    expect(allowsCheckpointPush({ ...stored, push: "never" })).toBe(false);
  });

  it("opens a pull request only when it may also push", () => {
    expect(allowsPush(pushing)).toBe(true);
    expect(allowsPullRequest(pushing)).toBe(true);
    expect(allowsPullRequest({ ...pushing, push: "manual" })).toBe(false);
    expect(allowsPullRequest({ ...pushing, pullRequest: "manual" })).toBe(false);
  });
});

describe("directionOf", () => {
  it("is null when no Git field changed", () => {
    expect(directionOf(stored, { ...stored, version: 9 })).toBeNull();
  });

  it("names widening, narrowing, and mixed from the fields themselves", () => {
    expect(directionOf(stored, pushing)).toBe("widening");
    expect(directionOf(pushing, stored)).toBe("narrowing");
    expect(directionOf(stored, { ...stored, commit: "manual", push: "auto" })).toBe("mixed");
  });

  it("lists each changed field with the side it moved to", () => {
    expect(changedFields(stored, { ...stored, commit: "manual", push: "auto" })).toEqual([
      { field: "commit", from: "auto", to: "manual", widens: false },
      { field: "push", from: "manual", to: "auto", widens: true },
    ]);
  });
});

describe("decideProposal", () => {
  it("holds a permissive change and never applies it", () => {
    expect(decideProposal(context(), { from: stored, to: pushing })).toEqual({
      kind: "hold",
      direction: "widening",
      to: { ...pushing, version: 2 },
    });
  });

  it("applies a restrictive change at once", () => {
    const to = { ...stored, push: "never" as const };
    expect(decideProposal(context(), { from: stored, to })).toEqual({
      kind: "apply_now",
      to: { ...to, version: 2 },
    });
  });

  it("holds a mixed change whole", () => {
    const to = { ...stored, commit: "manual" as const, push: "auto" as const };
    expect(decideProposal(context(), { from: stored, to })).toMatchObject({
      kind: "hold",
      direction: "mixed",
    });
  });

  it("ignores a from the sandbox wrote to make a widening look like a narrowing", () => {
    const forgedFrom = { ...pushing, version: stored.version };
    expect(decideProposal(context(), { from: forgedFrom, to: pushing })).toMatchObject({
      kind: "hold",
      direction: "widening",
    });
  });

  it.each([
    ["run_not_running", context({ runRunning: false }), stored, pushing],
    ["unknown_message", context({ messageIsUsers: false }), stored, pushing],
    ["too_many_proposals", context({ admittedThisRun: MAX_PROPOSALS_PER_RUN }), stored, pushing],
    ["stale_version", context(), { ...stored, version: 7 }, pushing],
    ["outside_this_step", context(), stored, { ...pushing, planApproval: "wait_for_user" }],
    ["outside_this_step", context(), stored, { ...pushing, fileEdits: "blocked" }],
    ["no_change", context(), stored, stored],
  ] as const)("refuses with %s", (reason, given, from, to) => {
    expect(decideProposal(given, { from, to })).toEqual({ kind: "refuse", reason });
  });
});

describe("decideConfirmation", () => {
  const open: OpenProposal = {
    proposalId: "proposal-1",
    baseVersion: 1,
    to: { ...pushing, version: 2 },
  };
  const click = { proposalId: "proposal-1", policyVersion: 1, accept: true };

  it("applies the exact held policy", () => {
    expect(decideConfirmation(stored, open, click)).toEqual({ kind: "apply", to: open.to });
  });

  it("declines without changing anything", () => {
    expect(decideConfirmation(stored, open, { ...click, accept: false })).toEqual({
      kind: "decline",
    });
  });

  it("refuses a click with nothing open", () => {
    expect(decideConfirmation(stored, null, click)).toEqual({
      kind: "refuse",
      reason: "no_open_proposal",
    });
  });

  it("refuses a click on a superseded card", () => {
    expect(decideConfirmation(stored, open, { ...click, proposalId: "proposal-0" })).toEqual({
      kind: "refuse",
      reason: "superseded",
    });
  });

  it("refuses when the card's version or the policy moved", () => {
    expect(decideConfirmation(stored, open, { ...click, policyVersion: 0 })).toEqual({
      kind: "refuse",
      reason: "stale_version",
    });
    expect(
      decideConfirmation({ ...stored, version: 2 }, open, { ...click, policyVersion: 2 }),
    ).toEqual({
      kind: "refuse",
      reason: "stale_version",
    });
  });
});

describe("decideControl", () => {
  const change = { commit: "auto", push: "auto", pullRequest: "manual" } as const;

  it("writes the policy directly, widening included", () => {
    expect(decideControl(stored, change, 1)).toEqual({
      kind: "apply",
      to: { ...stored, ...change, version: 2 },
    });
  });

  it("refuses a stale version and a change that changes nothing", () => {
    expect(decideControl(stored, change, 4)).toEqual({ kind: "refuse", reason: "stale_version" });
    expect(decideControl(stored, stored, 1)).toEqual({ kind: "refuse", reason: "no_change" });
  });
});

describe("lockedDown", () => {
  it("turns every remote action off, one version on", () => {
    expect(lockedDown(pushing)).toEqual({
      ...pushing,
      push: "never",
      pullRequest: "never",
      version: 2,
    });
    expect(lockedDown({ ...stored, push: "never" })).toMatchObject({ pullRequest: "never" });
  });

  it("is null when there is nothing left to turn off", () => {
    expect(lockedDown({ ...stored, push: "never", pullRequest: "never" })).toBeNull();
  });
});
