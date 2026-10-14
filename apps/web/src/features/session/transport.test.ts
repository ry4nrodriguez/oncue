import { makeCommittedEvent, makeEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { backoffDelay, parseFrame, socketUrl } from "./transport";

describe("parseFrame", () => {
  it("reads a replay batch and keeps only events the protocol accepts", () => {
    const good = makeCommittedEvent("message.started", {}, { sessionSequence: 1 });
    const frame = parseFrame(
      JSON.stringify({ type: "replay_batch", through: 1, events: [good, { type: "nonsense" }] }),
    );

    expect(frame.kind).toBe("replay");
    if (frame.kind !== "replay") {
      return;
    }
    expect(frame.through).toBe(1);
    expect(frame.events).toHaveLength(1);
  });

  it("reads the caught-up marker", () => {
    const frame = parseFrame(JSON.stringify({ type: "caught_up", through: 12 }));

    expect(frame).toEqual({ kind: "caught_up", through: 12 });
  });

  it("treats a broadcast carrying a sequence as committed history", () => {
    const event = makeCommittedEvent("message.completed", {}, { sessionSequence: 4 });
    const frame = parseFrame(JSON.stringify(event));

    expect(frame.kind).toBe("committed");
  });

  it("treats a broadcast with no sequence as a transient delta", () => {
    const frame = parseFrame(JSON.stringify(makeEvent("message.delta")));

    expect(frame.kind).toBe("live");
  });

  it("drops a durable type that arrives with no sequence", () => {
    const frame = parseFrame(JSON.stringify(makeEvent("message.started")));

    expect(frame.kind).toBe("unknown");
  });

  it("drops malformed input rather than rendering it", () => {
    expect(parseFrame("not json").kind).toBe("unknown");
    expect(parseFrame("null").kind).toBe("unknown");
    expect(parseFrame(JSON.stringify({ type: "no.such.event" })).kind).toBe("unknown");
    expect(parseFrame(JSON.stringify([1, 2, 3])).kind).toBe("unknown");
  });
});

describe("reconnect", () => {
  it("backs off exponentially and then holds at a ceiling", () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(20)).toBe(8000);
  });

  it("asks to resume after the last applied sequence", () => {
    expect(socketUrl("sess_1", 42, "https://app.example")).toBe(
      "wss://app.example/ws/sessions/sess_1/client?after=42",
    );
  });
});
