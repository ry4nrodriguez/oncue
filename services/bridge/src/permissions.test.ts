import { describe, expect, it } from "vitest";
import {
  boundResource,
  type ClassifiedAsk,
  DEADLINE_GRACE_MS,
  dropUnsent,
  INITIAL_PERMISSIONS,
  MAX_HELD_ASKS,
  onApprovalDeadline,
  onApprovalFrame,
  onAsk,
  onCallSettled,
  onRequestSettled,
  onRunEnded,
  ownsRef,
  type PermissionsState,
  pump,
  RESOURCE_MAX_CHARS,
  refusalWords,
} from "./permissions";

const OUTSIDE: ClassifiedAsk = {
  category: "outside_project",
  resource: "/etc/hosts",
  toolCategory: "file_read",
};

function refs() {
  let next = 0;
  return () => `ref-${++next}`;
}

const ACTIVE = { runActive: true, blocked: false };

function asked(state: PermissionsState, requestId: string, newRef: () => string, blocked = false) {
  return onAsk(
    state,
    { requestId, callId: `call-${requestId}`, ask: OUTSIDE },
    { ...ACTIVE, blocked, newRef },
  );
}

describe("onAsk", () => {
  it("forwards the first ask at once and never answers it itself", () => {
    const step = asked(INITIAL_PERMISSIONS, "per-1", refs());
    expect(step.effects).toEqual([
      { kind: "emit_ask", ref: "ref-1", ask: OUTSIDE, callId: "call-per-1" },
    ]);
    expect(step.state.held).toEqual([
      { requestId: "per-1", ref: "ref-1", callId: "call-per-1", ask: OUTSIDE, forwarded: true },
    ]);
  });

  it("names the subagent whose call it holds, when one asked", () => {
    const step = onAsk(
      INITIAL_PERMISSIONS,
      { requestId: "per-1", callId: "call-1", ask: OUTSIDE, agentId: "ses_child" },
      { ...ACTIVE, newRef: refs() },
    );
    expect(step.effects).toEqual([
      { kind: "emit_ask", ref: "ref-1", ask: OUTSIDE, callId: "call-1", agentId: "ses_child" },
    ]);
    expect(step.state.held[0]?.agentId).toBe("ses_child");
  });

  it("refuses an ask of its own in turn, once nothing waits ahead of it, settling those behind", () => {
    const newRef = refs();
    const first = asked(INITIAL_PERMISSIONS, "per-1", newRef);
    const refusing = onAsk(
      first.state,
      { requestId: "per-2", callId: "call-2", ask: OUTSIDE, refusal: "No room." },
      { ...ACTIVE, newRef },
    );
    // Held behind the card that is out, never forwarded.
    expect(refusing.effects).toEqual([]);
    const third = asked(refusing.state, "per-3", newRef);
    const answered = onApprovalFrame(
      third.state,
      { requestRef: "ref-1", outcome: "allowed", expiresAt: null },
      false,
    );
    expect(answered.effects).toEqual([
      { kind: "reply_permission", requestId: "per-1", reply: "once", message: null },
      { kind: "reply_permission", requestId: "per-2", reply: "reject", message: "No room." },
    ]);
    // The harness spread that reject to the ask behind it.
    expect(answered.state).toEqual(INITIAL_PERMISSIONS);
  });

  it("waits behind a secret card before refusing an ask of its own", () => {
    const held = onAsk(
      INITIAL_PERMISSIONS,
      { requestId: "per-1", callId: "call-1", ask: OUTSIDE, refusal: "No room." },
      { ...ACTIVE, newRef: refs(), blocked: true },
    );
    expect(held.effects).toEqual([]);
    expect(pump(held.state, false).effects).toEqual([
      { kind: "reply_permission", requestId: "per-1", reply: "reject", message: "No room." },
    ]);
  });

  it("queues a second ask behind the one out, so the object sees one at a time", () => {
    const newRef = refs();
    const first = asked(INITIAL_PERMISSIONS, "per-1", newRef);
    const second = asked(first.state, "per-2", newRef);
    expect(second.effects).toEqual([]);
    expect(second.state.held.map((held) => [held.requestId, held.forwarded])).toEqual([
      ["per-1", true],
      ["per-2", false],
    ]);
  });

  it("holds every ask back while a secret card is open", () => {
    const step = asked(INITIAL_PERMISSIONS, "per-1", refs(), true);
    expect(step.effects).toEqual([]);
    expect(step.state.held[0]?.forwarded).toBe(false);
    expect(pump(step.state, false).effects).toEqual([
      { kind: "emit_ask", ref: "ref-1", ask: OUTSIDE, callId: "call-per-1" },
    ]);
  });

  it("rejects an ask with no run, which nobody could answer", () => {
    const step = onAsk(
      INITIAL_PERMISSIONS,
      { requestId: "per-1", callId: null, ask: OUTSIDE },
      { runActive: false, blocked: false, newRef: refs() },
    );
    expect(step.effects).toEqual([
      {
        kind: "reply_permission",
        requestId: "per-1",
        reply: "reject",
        message: "No run is active.",
      },
    ]);
    expect(step.state).toBe(INITIAL_PERMISSIONS);
  });

  it("ignores a redelivered ask it already holds", () => {
    const newRef = refs();
    const first = asked(INITIAL_PERMISSIONS, "per-1", newRef);
    expect(asked(first.state, "per-1", newRef)).toEqual({ state: first.state, effects: [] });
  });

  it("refuses past the bound rather than queueing without end", () => {
    const newRef = refs();
    let state = INITIAL_PERMISSIONS;
    for (let index = 0; index < MAX_HELD_ASKS; index += 1) {
      state = asked(state, `per-${index}`, newRef).state;
    }
    const over = asked(state, "per-over", newRef);
    expect(over.state).toBe(state);
    expect(over.effects).toEqual([
      {
        kind: "reply_permission",
        requestId: "per-over",
        reply: "reject",
        message: "Too many requests are waiting for the user. Try again later.",
      },
    ]);
  });
});

describe("onApprovalFrame", () => {
  const newRef = refs();
  const one = asked(INITIAL_PERMISSIONS, "per-1", newRef).state;
  const two = asked(one, "per-2", newRef).state;

  it("arms the backstop timer past the card's expiry on pending, and answers nothing yet", () => {
    const step = onApprovalFrame(
      two,
      { requestRef: "ref-1", outcome: "pending", expiresAt: "2026-10-04T12:10:00.000Z" },
      false,
    );
    expect(step.state).toBe(two);
    // The grace lets the object's own expiry, or a late click, arrive first.
    expect(DEADLINE_GRACE_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEADLINE_GRACE_MS).toBeLessThanOrEqual(60_000);
    expect(step.effects).toEqual([
      {
        kind: "approval_timer",
        ref: "ref-1",
        atMs: Date.parse("2026-10-04T12:10:00.000Z") + DEADLINE_GRACE_MS,
      },
    ]);
  });

  it("forwards nothing after a reject the harness spreads, since it settled every other ask", () => {
    const step = onApprovalFrame(
      two,
      { requestRef: "ref-1", outcome: "denied", expiresAt: null },
      false,
      true,
    );
    expect(step.state).toEqual(INITIAL_PERMISSIONS);
    expect(step.effects).toEqual([
      {
        kind: "reply_permission",
        requestId: "per-1",
        reply: "reject",
        message: refusalWords("denied"),
      },
    ]);
  });

  it("still forwards the next ask after allowed where rejects spread", () => {
    const step = onApprovalFrame(
      two,
      { requestRef: "ref-1", outcome: "allowed", expiresAt: null },
      false,
      true,
    );
    expect(step.effects.map((effect) => effect.kind)).toEqual(["reply_permission", "emit_ask"]);
  });

  it("answers once on allowed, never always, and forwards the next ask", () => {
    const step = onApprovalFrame(
      two,
      { requestRef: "ref-1", outcome: "allowed", expiresAt: null },
      false,
    );
    expect(step.effects).toEqual([
      { kind: "reply_permission", requestId: "per-1", reply: "once", message: null },
      { kind: "emit_ask", ref: "ref-2", ask: OUTSIDE, callId: "call-per-2" },
    ]);
    expect(step.state.held).toHaveLength(1);
    expect(JSON.stringify(step.effects)).not.toContain("always");
  });

  it.each(["denied", "expired", "refused", "unavailable"] as const)(
    "rejects on %s with words that tell the agent what to do next",
    (outcome) => {
      const step = onApprovalFrame(one, { requestRef: "ref-1", outcome, expiresAt: null }, false);
      expect(step.effects).toEqual([
        {
          kind: "reply_permission",
          requestId: "per-1",
          reply: "reject",
          message: refusalWords(outcome),
        },
      ]);
      expect(step.state.held).toEqual([]);
    },
  );

  it("logs a frame for no held ask and changes nothing", () => {
    const step = onApprovalFrame(
      one,
      { requestRef: "ref-9", outcome: "allowed", expiresAt: null },
      false,
    );
    expect(step.state).toBe(one);
    expect(step.effects).toEqual([{ kind: "log", line: "an approval frame for no held ask" }]);
    expect(
      onApprovalFrame(
        INITIAL_PERMISSIONS,
        { requestRef: "ref-1", outcome: "allowed", expiresAt: null },
        false,
      ).effects,
    ).toEqual([{ kind: "log", line: "an approval frame for no held ask" }]);
  });

  it("does not answer an ask that was queued but never forwarded", () => {
    const held = asked(INITIAL_PERMISSIONS, "per-1", refs(), true).state;
    expect(ownsRef(held, "ref-1")).toBe(false);
    expect(ownsRef(INITIAL_PERMISSIONS, "ref-1")).toBe(false);
    expect(
      onApprovalFrame(held, { requestRef: "ref-1", outcome: "allowed", expiresAt: null }, false)
        .effects,
    ).toEqual([{ kind: "log", line: "an approval frame for no held ask" }]);
  });
});

describe("onApprovalDeadline", () => {
  it("denies the held call when the card's time passed with no frame, then forwards the next", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    const step = onApprovalDeadline(two, "ref-1", false);
    expect(step.effects).toEqual([
      {
        kind: "reply_permission",
        requestId: "per-1",
        reply: "reject",
        message: refusalWords("expired"),
      },
      { kind: "emit_ask", ref: "ref-2", ask: OUTSIDE, callId: "call-per-2" },
    ]);
  });

  it("forwards nothing after its reject where rejects spread", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    const step = onApprovalDeadline(two, "ref-1", false, true);
    expect(step.state).toEqual(INITIAL_PERMISSIONS);
    expect(step.effects).toHaveLength(1);
  });

  it("ignores a deadline for anything but the ask out", () => {
    const one = asked(INITIAL_PERMISSIONS, "per-1", refs()).state;
    expect(onApprovalDeadline(one, "ref-2", false)).toEqual({ state: one, effects: [] });
    expect(onApprovalDeadline(INITIAL_PERMISSIONS, "ref-1", false).effects).toEqual([]);
  });
});

describe("onCallSettled", () => {
  it("drops a queued ask whose call ended some other way", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    const step = onCallSettled(two, "call-per-2", false);
    expect(step.state.held.map((held) => held.requestId)).toEqual(["per-1"]);
    expect(step.effects).toEqual([]);
  });

  it("keeps a forwarded ask as the head until its frame, but no longer follows its call", () => {
    const one = asked(INITIAL_PERMISSIONS, "per-1", refs()).state;
    const step = onCallSettled(one, "call-per-1", false);
    expect(step.state.held).toEqual([{ ...one.held[0], callId: null }]);
    expect(onCallSettled(step.state, "call-per-1", false).state).toBe(step.state);
  });

  it("leaves the queued asks behind a forwarded head as they are", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    const step = onCallSettled(two, "call-per-1", false);
    expect(step.state.held[1]).toBe(two.held[1]);
    expect(step.effects).toEqual([]);
  });

  it("forwards the next once a queued head is dropped", () => {
    const newRef = refs();
    const blocked = asked(
      asked(INITIAL_PERMISSIONS, "per-1", newRef, true).state,
      "per-2",
      newRef,
      true,
    ).state;
    const step = onCallSettled(blocked, "call-per-1", false);
    expect(step.effects).toEqual([
      { kind: "emit_ask", ref: "ref-2", ask: OUTSIDE, callId: "call-per-2" },
    ]);
  });
});

describe("onRequestSettled (the harness says a request was answered)", () => {
  it("drops a queued ask, so it is never shown, and forwards the next", () => {
    const newRef = refs();
    const blocked = asked(
      asked(INITIAL_PERMISSIONS, "per-1", newRef, true).state,
      "per-2",
      newRef,
      true,
    ).state;
    const step = onRequestSettled(blocked, "per-1", false);
    expect(step.state.held.map((held) => [held.requestId, held.forwarded])).toEqual([
      ["per-2", true],
    ]);
    expect(step.effects).toEqual([
      { kind: "emit_ask", ref: "ref-2", ask: OUTSIDE, callId: "call-per-2" },
    ]);
  });

  it("keeps the ask out until its frame, and ignores a request it does not hold", () => {
    const one = asked(INITIAL_PERMISSIONS, "per-1", refs()).state;
    expect(onRequestSettled(one, "per-1", false)).toEqual({ state: one, effects: [] });
    expect(onRequestSettled(one, "per-9", false)).toEqual({ state: one, effects: [] });
  });
});

describe("dropUnsent and a spreading overflow", () => {
  it("keeps only a forwarded head", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    expect(dropUnsent(two).held.map((held) => held.requestId)).toEqual(["per-1"]);
    const queued = asked(INITIAL_PERMISSIONS, "per-1", refs(), true).state;
    expect(dropUnsent(queued)).toEqual(INITIAL_PERMISSIONS);
    expect(dropUnsent(INITIAL_PERMISSIONS)).toEqual(INITIAL_PERMISSIONS);
  });

  it("forgets the queued asks when an overflow reject spreads to them", () => {
    const newRef = refs();
    let state = INITIAL_PERMISSIONS;
    for (let index = 0; index < MAX_HELD_ASKS; index += 1) {
      state = asked(state, `per-${index}`, newRef).state;
    }
    const over = onAsk(
      state,
      { requestId: "per-over", callId: null, ask: OUTSIDE },
      { runActive: true, blocked: false, newRef, cascade: true },
    );
    expect(over.state.held.map((held) => held.requestId)).toEqual(["per-0"]);
    expect(over.effects).toHaveLength(1);
  });
});

describe("onRunEnded", () => {
  it("rejects every held call, out or queued, since the harness does not clear them itself", () => {
    const newRef = refs();
    const two = asked(asked(INITIAL_PERMISSIONS, "per-1", newRef).state, "per-2", newRef).state;
    const step = onRunEnded(two);
    expect(step.state).toEqual(INITIAL_PERMISSIONS);
    expect(
      step.effects.map((effect) => effect.kind === "reply_permission" && effect.requestId),
    ).toEqual(["per-1", "per-2"]);
  });

  it("does nothing with nothing held", () => {
    expect(onRunEnded(INITIAL_PERMISSIONS)).toEqual({ state: INITIAL_PERMISSIONS, effects: [] });
  });
});

describe("boundResource", () => {
  it("keeps a short path as it is, on one line", () => {
    expect(boundResource("  /etc/hosts\n")).toBe("/etc/hosts");
  });

  it("cuts a long one in the middle, keeping both ends", () => {
    const long = `/${"a".repeat(300)}/end.txt`;
    const cut = boundResource(long);
    expect(cut.length).toBeLessThanOrEqual(RESOURCE_MAX_CHARS);
    expect(cut.startsWith("/aaa")).toBe(true);
    expect(cut.endsWith("end.txt")).toBe(true);
    expect(cut).toContain("…");
  });
});
