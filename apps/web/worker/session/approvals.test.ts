import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  type ApprovalClaim,
  approvalTtlMs,
  cardFor,
  isCountedRefusal,
  judgeRequest,
  MAX_APPROVALS_PER_RUN,
  planSweep,
  type RequestContext,
  settleSavedCheck,
} from "./approvals";

const NOW = "2026-09-21T12:00:00.000Z";

function claim(overrides: Partial<ApprovalClaim> = {}): ApprovalClaim {
  return { category: "development_secret", resource: "STRIPE_TEST_KEY", ...overrides };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    runRunning: true,
    openApprovalExists: false,
    admittedThisRun: 0,
    declaredOptional: ["STRIPE_TEST_KEY", "SENTRY_DSN"],
    suppliedThisGeneration: [],
    deniedThisRun: [],
    ...overrides,
  };
}

describe("judging a sandbox's request", () => {
  it("passes a well-formed request for a declared optional secret on to the saved check", () => {
    expect(judgeRequest(context(), claim())).toEqual({
      kind: "candidate",
      name: "STRIPE_TEST_KEY",
    });
  });

  it.each(["external_connection", "network_expansion", "external_action"] as const)(
    "refuses the %s category, which this version does not offer",
    (category) => {
      expect(judgeRequest(context(), claim({ category }))).toEqual({
        kind: "refuse",
        reason: "not_offered",
      });
    },
  );

  it("refuses the `other` category, which names no action", () => {
    expect(judgeRequest(context(), claim({ category: "other" }))).toEqual({
      kind: "refuse",
      reason: "not_offered",
    });
  });

  it("refuses a name that is not well formed before it looks at anything else", () => {
    expect(
      judgeRequest(
        context({ declaredOptional: ["not a name"] }),
        claim({ resource: "not a name" }),
      ),
    ).toEqual({ kind: "refuse", reason: "malformed_name" });
  });

  it("refuses a request outside a running run", () => {
    expect(judgeRequest(context({ runRunning: false }), claim())).toEqual({
      kind: "refuse",
      reason: "run_not_running",
    });
  });

  it("refuses a second request while one is open, whatever the run's state says", () => {
    expect(judgeRequest(context({ openApprovalExists: true, runRunning: false }), claim())).toEqual(
      { kind: "refuse", reason: "approval_open" },
    );
    expect(judgeRequest(context({ openApprovalExists: true }), claim())).toEqual({
      kind: "refuse",
      reason: "approval_open",
    });
  });

  it("admits the fifth of a run and refuses the sixth", () => {
    expect(
      judgeRequest(context({ admittedThisRun: MAX_APPROVALS_PER_RUN - 1 }), claim()).kind,
    ).toBe("candidate");
    expect(judgeRequest(context({ admittedThisRun: MAX_APPROVALS_PER_RUN }), claim())).toEqual({
      kind: "refuse",
      reason: "too_many_requests",
    });
  });

  it("refuses a name the pinned declaration does not list as optional", () => {
    expect(judgeRequest(context(), claim({ resource: "DEPLOY_KEY" }))).toEqual({
      kind: "refuse",
      reason: "not_declared",
    });
  });

  it("refuses a name already supplied to this generation", () => {
    expect(judgeRequest(context({ suppliedThisGeneration: ["STRIPE_TEST_KEY"] }), claim())).toEqual(
      { kind: "refuse", reason: "already_supplied" },
    );
  });

  it("refuses a name already denied in this run", () => {
    expect(judgeRequest(context({ deniedThisRun: ["STRIPE_TEST_KEY"] }), claim())).toEqual({
      kind: "refuse",
      reason: "already_denied",
    });
  });

  it("refuses a candidate with no saved value", () => {
    expect(settleSavedCheck("STRIPE_TEST_KEY", false)).toEqual({
      kind: "refuse",
      reason: "not_saved",
    });
    expect(settleSavedCheck("STRIPE_TEST_KEY", true)).toEqual({
      kind: "admit",
      name: "STRIPE_TEST_KEY",
    });
  });

  it("counts the refusals only a hostile or broken bridge produces", () => {
    expect(isCountedRefusal("not_offered")).toBe(true);
    expect(isCountedRefusal("malformed_name")).toBe(true);
    expect(isCountedRefusal("run_not_running")).toBe(true);
    expect(isCountedRefusal("too_many_requests")).toBe(true);
    expect(isCountedRefusal("not_declared")).toBe(true);
    // Reaching it costs reads in D1, so it is bounded like the rest.
    expect(isCountedRefusal("not_saved")).toBe(true);
    // An honest model can ask twice.
    expect(isCountedRefusal("approval_open")).toBe(false);
    expect(isCountedRefusal("already_supplied")).toBe(false);
    expect(isCountedRefusal("already_denied")).toBe(false);
  });
});

describe("the card's fields", () => {
  it("are the object's words, built from the name, the generation, and its own clock", () => {
    const card = cardFor({
      name: "STRIPE_TEST_KEY",
      generation: 3,
      now: NOW,
      ttlMs: APPROVAL_TTL_MS,
    });
    expect(card).toEqual({
      title: "Supply STRIPE_TEST_KEY",
      intendedAction:
        "Give this session the saved development secret STRIPE_TEST_KEY. The repository's code can read it, and the model provider may see it.",
      category: "development_secret",
      risk: "medium",
      resource: "STRIPE_TEST_KEY",
      requestedScope: "This session's sandbox (generation 3), until it stops",
      expiresAt: new Date(Date.parse(NOW) + APPROVAL_TTL_MS).toISOString(),
    });
  });

  it("expire ten minutes after the request, and only a local environment may shorten that", () => {
    expect(APPROVAL_TTL_MS).toBe(10 * 60 * 1000);
    expect(approvalTtlMs({ ONCUE_ENV: "hosted" })).toBe(APPROVAL_TTL_MS);
    expect(approvalTtlMs({ ONCUE_ENV: "hosted", ONCUE_APPROVAL_TTL_SECONDS: "5" })).toBe(
      APPROVAL_TTL_MS,
    );
    expect(approvalTtlMs({ ONCUE_ENV: "local" })).toBe(APPROVAL_TTL_MS);
    expect(approvalTtlMs({ ONCUE_ENV: "local", ONCUE_APPROVAL_TTL_SECONDS: "5" })).toBe(5_000);
    for (const bad of ["0", "-3", "1.5", "soon", ""]) {
      expect(approvalTtlMs({ ONCUE_ENV: "local", ONCUE_APPROVAL_TTL_SECONDS: bad })).toBe(
        APPROVAL_TTL_MS,
      );
    }
    const card = cardFor({ name: "A", generation: 1, now: NOW, ttlMs: 5_000 });
    expect(card.expiresAt).toBe("2026-09-21T12:00:05.000Z");
  });
});

describe("the sweep", () => {
  const nowMs = Date.parse(NOW);
  const open = [
    { runId: "run_1", approvalId: "apr_due", expiresAtMs: nowMs - 1, orphaned: false },
    { runId: "run_1", approvalId: "apr_now", expiresAtMs: nowMs, orphaned: false },
    { runId: "run_1", approvalId: "apr_later", expiresAtMs: nowMs + 60_000, orphaned: false },
  ];

  it("expires what is due with `tool_denied` and names the next deadline", () => {
    expect(planSweep(open, nowMs)).toEqual({
      expire: [
        { runId: "run_1", approvalId: "apr_due", effect: "tool_denied" },
        { runId: "run_1", approvalId: "apr_now", effect: "tool_denied" },
      ],
    });
  });

  it("waits for the soonest deadline, whatever order the rows come in", () => {
    const rows = [
      { runId: "run_1", approvalId: "apr_b", expiresAtMs: nowMs + 60_000, orphaned: false },
      { runId: "run_1", approvalId: "apr_c", expiresAtMs: nowMs + 120_000, orphaned: false },
      { runId: "run_1", approvalId: "apr_a", expiresAtMs: nowMs + 30_000, orphaned: false },
    ];
    expect(planSweep(rows, nowMs)).toEqual({ expire: [] });
  });

  it("has no deadline when nothing is open: silence costs nothing", () => {
    expect(planSweep([], nowMs)).toEqual({ expire: [] });
  });

  it("ends an approval whose tool call is gone without resuming the run, due or not", () => {
    expect(
      planSweep(
        [
          { runId: "run_1", approvalId: "apr_orphan", expiresAtMs: nowMs + 60_000, orphaned: true },
          { runId: "run_1", approvalId: "apr_orphan_due", expiresAtMs: nowMs - 1, orphaned: true },
        ],
        nowMs,
      ),
    ).toEqual({
      expire: [
        { runId: "run_1", approvalId: "apr_orphan", effect: "run_paused" },
        { runId: "run_1", approvalId: "apr_orphan_due", effect: "run_paused" },
      ],
    });
  });
});
