import { describe, expect, it } from "vitest";
import { planReplay, type StoredEventRow } from "./replay";

function row(sessionSequence: number, envelopeJson = `{"n":${sessionSequence}}`): StoredEventRow {
  return { sessionSequence, envelopeJson };
}

describe("planReplay: nothing to replay", () => {
  it("emits only a caught-up marker at the client's own sequence", () => {
    const frames = planReplay([], { maxEventsPerBatch: 10, maxBytesPerBatch: 1000 }, 42);
    expect(frames).toEqual([
      { kind: "caught_up", json: '{"type":"caught_up","through":42}', through: 42 },
    ]);
  });
});

describe("planReplay: a single batch", () => {
  it("concatenates every row's stored JSON verbatim and ends with caught-up at the last row", () => {
    const rows = [row(1, '{"a":1}'), row(2, '{"a":2}')];
    const frames = planReplay(rows, { maxEventsPerBatch: 10, maxBytesPerBatch: 1000 }, 0);
    expect(frames).toEqual([
      {
        kind: "batch",
        json: '{"type":"replay_batch","through":2,"events":[{"a":1},{"a":2}]}',
        through: 2,
      },
      { kind: "caught_up", json: '{"type":"caught_up","through":2}', through: 2 },
    ]);
  });
});

describe("planReplay: the count cap", () => {
  it("cuts a new batch once the count cap is reached", () => {
    const rows = [row(1), row(2), row(3)];
    const frames = planReplay(rows, { maxEventsPerBatch: 2, maxBytesPerBatch: 10_000 }, 0);
    expect(frames).toEqual([
      {
        kind: "batch",
        json: '{"type":"replay_batch","through":2,"events":[{"n":1},{"n":2}]}',
        through: 2,
      },
      { kind: "batch", json: '{"type":"replay_batch","through":3,"events":[{"n":3}]}', through: 3 },
      { kind: "caught_up", json: '{"type":"caught_up","through":3}', through: 3 },
    ]);
  });
});

describe("planReplay: the byte cap", () => {
  it("cuts a new batch once adding the next row would exceed the byte cap", () => {
    const rows = [row(1, '{"n":1}'), row(2, '{"n":2}'), row(3, '{"n":3}')];
    // Each row is 7 bytes; a cap of 10 admits only one row per batch.
    const frames = planReplay(rows, { maxEventsPerBatch: 100, maxBytesPerBatch: 10 }, 0);
    expect(frames).toEqual([
      { kind: "batch", json: '{"type":"replay_batch","through":1,"events":[{"n":1}]}', through: 1 },
      { kind: "batch", json: '{"type":"replay_batch","through":2,"events":[{"n":2}]}', through: 2 },
      { kind: "batch", json: '{"type":"replay_batch","through":3,"events":[{"n":3}]}', through: 3 },
      { kind: "caught_up", json: '{"type":"caught_up","through":3}', through: 3 },
    ]);
  });

  it("still admits one oversized row alone rather than looping forever", () => {
    const bigJson = `{"n":1,"pad":"${"x".repeat(20)}"}`;
    const rows = [row(1, bigJson), row(2, '{"n":2}')];
    const frames = planReplay(rows, { maxEventsPerBatch: 100, maxBytesPerBatch: 10 }, 0);
    expect(frames[0]).toEqual({
      kind: "batch",
      json: `{"type":"replay_batch","through":1,"events":[${bigJson}]}`,
      through: 1,
    });
    expect(frames).toHaveLength(3);
  });
});
