import { makeCommittedEvent, makeEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  commitEvent,
  commitEvents,
  dropLive,
  emptyStore,
  liveEvent,
  resumeFrom,
} from "./event-store";

const started = makeCommittedEvent("message.started", {}, { sessionSequence: 1 });
const completed = makeCommittedEvent("message.completed", {}, { sessionSequence: 2 });

describe("event store", () => {
  it("applies committed events in sequence order", () => {
    const store = commitEvents(emptyStore(), [started, completed]);

    expect(resumeFrom(store)).toBe(2);
    expect(store.view.stream.awaiting).toBeNull();
  });

  it("buffers an event that arrives out of order until the gap fills", () => {
    const early = commitEvent(emptyStore(), completed);

    // Sequence 2 cannot be folded while 1 is missing, so nothing is applied.
    expect(resumeFrom(early)).toBe(0);
    expect(early.view.stream.awaiting).toBe(1);

    const filled = commitEvent(early, started);

    // Filling the gap drains the buffer, so both land in one step.
    expect(resumeFrom(filled)).toBe(2);
    expect(filled.view.stream.awaiting).toBeNull();
  });

  it("ignores a duplicate sequence", () => {
    const once = commitEvent(emptyStore(), started);
    const twice = commitEvent(once, started);

    expect(resumeFrom(twice)).toBe(1);
    // Nothing changed, so the store is the same object and React does not rerender.
    expect(twice).toBe(once);
  });

  it("ignores an event already below the applied sequence", () => {
    const store = commitEvents(emptyStore(), [started, completed]);
    const replayed = commitEvent(store, started);

    expect(replayed).toBe(store);
    expect(resumeFrom(replayed)).toBe(2);
  });

  it("holds live deltas outside committed history", () => {
    const store = commitEvent(emptyStore(), started);
    const streaming = liveEvent(store, makeEvent("message.delta"));

    expect(streaming.view.live.messages.size).toBe(1);
    // A delta is transient, so it never advances durable history.
    expect(resumeFrom(streaming)).toBe(1);
  });

  it("discards the transient buffer on replay", () => {
    const streaming = liveEvent(commitEvent(emptyStore(), started), makeEvent("message.delta"));
    const replayed = dropLive(streaming);

    expect(replayed.view.live.messages.size).toBe(0);
    expect(resumeFrom(replayed)).toBe(1);
  });

  it("returns the same store when there is nothing live to discard", () => {
    const store = commitEvent(emptyStore(), started);

    expect(dropLive(store)).toBe(store);
  });
});
