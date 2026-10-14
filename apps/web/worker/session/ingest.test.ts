import { createRedactor } from "@oncue/protocol";
import { makeEvent, TEST_IDS, TEST_TIME } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { type IngestContext, ingestFrame } from "./ingest";

function baseContext(overrides: Partial<IngestContext> = {}): IngestContext {
  return {
    sessionId: TEST_IDS.sessionId,
    sandboxGeneration: 1,
    lastRuntimeSequence: null,
    protocolVersion: 1,
    knownEventIds: new Set(),
    redactor: createRedactor([]),
    nextSessionSequence: 1,
    committedAt: TEST_TIME,
    ...overrides,
  };
}

describe("ingestFrame: parse failures", () => {
  it("rejects malformed JSON", () => {
    const outcome = ingestFrame("not json", baseContext());
    expect(outcome).toEqual({
      kind: "reject",
      reason: {
        kind: "parse_failure",
        parseReason: "malformed_json",
        detail: "event: not valid JSON",
      },
    });
  });

  it("rejects an envelope that fails schema validation", () => {
    const outcome = ingestFrame(JSON.stringify({ not: "an envelope" }), baseContext());
    expect(outcome.kind).toBe("reject");
    if (outcome.kind === "reject") {
      expect(outcome.reason.kind).toBe("parse_failure");
    }
  });
});

describe("ingestFrame: admission rejections", () => {
  it("rejects a wrong session id", () => {
    const event = makeEvent("runtime.connected", { runtimeSequence: 0 });
    const outcome = ingestFrame(JSON.stringify(event), baseContext({ sessionId: "sess_other" }));
    expect(outcome).toEqual({
      kind: "reject",
      reason: { kind: "wrong_session", expected: "sess_other" },
    });
  });

  it("rejects an unsupported protocol version", () => {
    const event = makeEvent("runtime.connected", { runtimeSequence: 0 });
    const outcome = ingestFrame(JSON.stringify(event), baseContext({ protocolVersion: 2 }));
    expect(outcome).toEqual({
      kind: "reject",
      reason: { kind: "unsupported_version", expected: 2 },
    });
  });

  it("rejects a stale sandbox generation", () => {
    const event = makeEvent("runtime.connected", { runtimeSequence: 0, sandboxGeneration: 1 });
    const outcome = ingestFrame(JSON.stringify(event), baseContext({ sandboxGeneration: 2 }));
    expect(outcome).toEqual({
      kind: "reject",
      reason: { kind: "stale_generation", current: 2 },
    });
  });

  it("rejects a duplicate event id", () => {
    const event = makeEvent("runtime.connected", { runtimeSequence: 0 });
    const outcome = ingestFrame(
      JSON.stringify(event),
      baseContext({ knownEventIds: new Set([event.eventId]) }),
    );
    expect(outcome).toEqual({ kind: "reject", reason: { kind: "duplicate_event" } });
  });

  it("holds a gapped sequence for replay", () => {
    const event = makeEvent("runtime.connected", { runtimeSequence: 3 });
    const outcome = ingestFrame(JSON.stringify(event), baseContext({ lastRuntimeSequence: 0 }));
    expect(outcome).toEqual({
      kind: "reject",
      reason: { kind: "sequence_gap", expected: 1, received: 3 },
    });
  });
});

describe("ingestFrame: durable commit", () => {
  it("stamps a session sequence and committedAt, and redacts the stored envelope", () => {
    const event = makeEvent("run.started", { runtimeSequence: 0 });
    const secret = "sh_super_secret_value";
    const withSecret = makeEvent("run.started", {
      runtimeSequence: 0,
      payload: { branch: secret },
    });
    const outcome = ingestFrame(
      JSON.stringify(withSecret),
      baseContext({ redactor: createRedactor([secret]), nextSessionSequence: 7 }),
    );
    expect(outcome.kind).toBe("commit");
    if (outcome.kind !== "commit") throw new Error("expected commit");
    expect(outcome.event.sessionSequence).toBe(7);
    expect(outcome.event.committedAt).toBe(TEST_TIME);
    expect(outcome.event.type).toBe(event.type);
    expect(outcome.envelopeJson).not.toContain(secret);
    expect(JSON.parse(outcome.envelopeJson)).toEqual(outcome.event);
  });
});

describe("ingestFrame: ephemeral live events", () => {
  it("never assigns a session sequence", () => {
    const event = makeEvent("message.delta", { runtimeSequence: 0 });
    const outcome = ingestFrame(JSON.stringify(event), baseContext());
    expect(outcome.kind).toBe("live");
    if (outcome.kind !== "live") throw new Error("expected live");
    expect(outcome.event).not.toHaveProperty("sessionSequence");
    expect(JSON.parse(outcome.envelopeJson)).toEqual(outcome.event);
  });
});
