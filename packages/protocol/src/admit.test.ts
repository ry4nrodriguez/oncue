import { describe, expect, it } from "vitest";
import { admitEvent, advanceCursor, type InboundEnvelope, type SessionExpectations } from "./admit";

const baseExpectations: SessionExpectations = {
  sessionId: "sess_1",
  sandboxGeneration: 3,
  lastRuntimeSequence: 41,
  protocolVersion: 1,
  knownEventIds: new Set(["evt_40", "evt_41"]),
};

function sandboxEvent(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    eventId: "evt_42",
    sessionId: "sess_1",
    sandboxGeneration: 3,
    runtimeSequence: 42,
    protocolVersion: 1,
    payload: {},
    ...overrides,
  };
}

describe("admitEvent: accept path", () => {
  it("accepts the next event in sequence for the current generation", () => {
    expect(admitEvent(sandboxEvent(), baseExpectations)).toEqual({ kind: "accept" });
  });

  it("accepts a control-origin event, which carries no runtime sequence", () => {
    const event = sandboxEvent({ eventId: "evt_ctrl_1", runtimeSequence: null });
    expect(admitEvent(event, baseExpectations)).toEqual({ kind: "accept" });
  });

  it("accepts the first sandbox event of a generation with no prior sequence", () => {
    const expectations: SessionExpectations = {
      ...baseExpectations,
      lastRuntimeSequence: null,
    };
    const event = sandboxEvent({ eventId: "evt_first", runtimeSequence: 0 });
    expect(admitEvent(event, expectations)).toEqual({ kind: "accept" });
  });
});

describe("admitEvent: each rejection reason", () => {
  it("wrong_session: sessionId does not match", () => {
    const event = sandboxEvent({ sessionId: "sess_other" });
    expect(admitEvent(event, baseExpectations)).toEqual({
      kind: "wrong_session",
      expected: "sess_1",
    });
  });

  it("unsupported_version: protocolVersion does not match", () => {
    const event = sandboxEvent({ protocolVersion: 2 });
    expect(admitEvent(event, baseExpectations)).toEqual({
      kind: "unsupported_version",
      expected: 1,
    });
  });

  it("stale_generation: an older generation than the session currently accepts", () => {
    const event = sandboxEvent({ sandboxGeneration: 2 });
    expect(admitEvent(event, baseExpectations)).toEqual({
      kind: "stale_generation",
      current: 3,
    });
  });

  it("stale_generation: a newer generation the session has not attached", () => {
    const event = sandboxEvent({ sandboxGeneration: 4 });
    expect(admitEvent(event, baseExpectations)).toEqual({
      kind: "stale_generation",
      current: 3,
    });
  });

  it("duplicate_event: an eventId already committed", () => {
    const event = sandboxEvent({ eventId: "evt_41" });
    expect(admitEvent(event, baseExpectations)).toEqual({ kind: "duplicate_event" });
  });

  it("accepts a second event carrying a commandId an earlier event already carried", () => {
    const queued = sandboxEvent({ eventId: "evt_50", payload: { commandId: "cmd_1" } });
    const acknowledged = sandboxEvent({ eventId: "evt_51", payload: { commandId: "cmd_1" } });

    expect(admitEvent(queued, baseExpectations)).toEqual({ kind: "accept" });
    expect(admitEvent(acknowledged, baseExpectations)).toEqual({ kind: "accept" });
  });

  it("sequence_gap: runtimeSequence jumps ahead of the cursor", () => {
    const event = sandboxEvent({ runtimeSequence: 45 });
    expect(admitEvent(event, baseExpectations)).toEqual({
      kind: "sequence_gap",
      expected: 42,
      received: 45,
    });
  });
});

describe("gap and duplicate stay distinguishable, both from stale generation", () => {
  it("a gap is not reported as a duplicate", () => {
    const gap = admitEvent(sandboxEvent({ runtimeSequence: 50 }), baseExpectations);
    expect(gap.kind).toBe("sequence_gap");
    expect(gap.kind).not.toBe("duplicate_event");
  });

  it("an unseen eventId at an already-passed sequence slot is a duplicate, not a gap", () => {
    const event = sandboxEvent({ eventId: "evt_never_seen", runtimeSequence: 10 });
    expect(admitEvent(event, baseExpectations)).toEqual({ kind: "duplicate_event" });
  });

  it("a stale generation is reported as such even when the sequence would otherwise gap", () => {
    const event = sandboxEvent({ sandboxGeneration: 1, runtimeSequence: 999 });
    const result = admitEvent(event, baseExpectations);
    expect(result.kind).toBe("stale_generation");
  });

  it("a stale generation is reported as such even when the eventId would otherwise be new", () => {
    const event = sandboxEvent({ sandboxGeneration: 1, eventId: "evt_brand_new" });
    const result = admitEvent(event, baseExpectations);
    expect(result.kind).toBe("stale_generation");
  });
});

describe("out-of-order arrival, held for replay, then filled and replayed", () => {
  it("holds a gap and later admits the same event once the cursor catches up", () => {
    const known = new Set(["evt_40", "evt_41"]);
    let expectations: SessionExpectations = { ...baseExpectations, knownEventIds: known };

    const outOfOrder = sandboxEvent({ eventId: "evt_44", runtimeSequence: 44 });
    const held = admitEvent(outOfOrder, expectations);
    expect(held).toEqual({ kind: "sequence_gap", expected: 42, received: 44 });

    const missing42 = sandboxEvent({ eventId: "evt_42", runtimeSequence: 42 });
    expect(admitEvent(missing42, expectations)).toEqual({ kind: "accept" });
    expectations = {
      ...expectations,
      lastRuntimeSequence: advanceCursor(expectations, missing42).lastRuntimeSequence,
      knownEventIds: known.add("evt_42"),
    };

    const missing43 = sandboxEvent({ eventId: "evt_43", runtimeSequence: 43 });
    expect(admitEvent(missing43, expectations)).toEqual({ kind: "accept" });
    expectations = {
      ...expectations,
      lastRuntimeSequence: advanceCursor(expectations, missing43).lastRuntimeSequence,
      knownEventIds: known.add("evt_43"),
    };

    expect(admitEvent(outOfOrder, expectations)).toEqual({ kind: "accept" });
    expectations = {
      ...expectations,
      lastRuntimeSequence: advanceCursor(expectations, outOfOrder).lastRuntimeSequence,
      knownEventIds: known.add("evt_44"),
    };

    const replay = sandboxEvent({ eventId: "evt_44", runtimeSequence: 44 });
    expect(admitEvent(replay, expectations)).toEqual({ kind: "duplicate_event" });
  });
});

describe("advanceCursor", () => {
  it("advances past a sandbox-origin event", () => {
    expect(advanceCursor({ lastRuntimeSequence: 41 }, { runtimeSequence: 42 })).toEqual({
      lastRuntimeSequence: 42,
    });
  });

  it("leaves the cursor untouched for a control-origin event", () => {
    expect(advanceCursor({ lastRuntimeSequence: 41 }, { runtimeSequence: null })).toEqual({
      lastRuntimeSequence: 41,
    });
  });
});
