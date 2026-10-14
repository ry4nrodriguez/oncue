import { describe, expect, it } from "vitest";
import {
  cacheEphemeralRow,
  emptyInspectorState,
  type InspectorRow,
  parseWireFrame,
  readCachedEphemeralRows,
  readCachedSessionId,
  reduceInspector,
  rowFromEvent,
  slotKeyOf,
  statusLabel,
  visibleRows,
  writeCachedSessionId,
} from "./stream";

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

class ThrowingStorage implements Storage {
  readonly length = 0;

  clear(): void {
    throw new Error("boom");
  }

  getItem(): string | null {
    throw new Error("boom");
  }

  key(): string | null {
    throw new Error("boom");
  }

  removeItem(): void {
    throw new Error("boom");
  }

  setItem(): void {
    throw new Error("boom");
  }
}

function durableEvent(runtimeSequence: number, sessionSequence: number, type = "run.started") {
  return JSON.stringify({
    type,
    sandboxGeneration: 1,
    runtimeSequence,
    sessionSequence,
    sessionId: "s1",
  });
}

function ephemeralEvent(runtimeSequence: number, type = "message.delta") {
  return JSON.stringify({ type, sandboxGeneration: 1, runtimeSequence, sessionId: "s1" });
}

describe("slotKeyOf", () => {
  it("joins generation and runtime sequence with a colon", () => {
    expect(slotKeyOf(2, 5)).toBe("2:5");
    expect(slotKeyOf(0, 0)).toBe("0:0");
  });
});

describe("statusLabel", () => {
  it("has an exact label for every status", () => {
    const base = emptyInspectorState();
    expect(statusLabel({ ...base, status: "idle" })).toBe("Idle");
    expect(statusLabel({ ...base, status: "connecting" })).toBe("Connecting…");
    expect(statusLabel({ ...base, status: "replaying" })).toBe("Replaying…");
    expect(statusLabel({ ...base, status: "caught_up" })).toBe("Caught up");
    expect(statusLabel({ ...base, status: "closed" })).toBe("Closed");
  });

  it("includes the error message when present", () => {
    const base = emptyInspectorState();
    expect(statusLabel({ ...base, status: "error", errorMessage: "socket died" })).toBe(
      "Error: socket died",
    );
  });

  it("falls back to 'unknown' when an error status carries no message", () => {
    const base = emptyInspectorState();
    expect(statusLabel({ ...base, status: "error", errorMessage: null })).toBe("Error: unknown");
  });
});

describe("parseWireFrame", () => {
  it("rejects malformed JSON", () => {
    expect(parseWireFrame("not json")).toEqual({ kind: "unparseable" });
  });

  it("rejects a JSON value that is not an object", () => {
    expect(parseWireFrame("42")).toEqual({ kind: "unparseable" });
    expect(parseWireFrame("null")).toEqual({ kind: "unparseable" });
    expect(parseWireFrame('"hello"')).toEqual({ kind: "unparseable" });
  });

  it("rejects an object with no recognizable shape", () => {
    expect(parseWireFrame(JSON.stringify({ hello: "world" }))).toEqual({ kind: "unparseable" });
  });

  it("parses a replay_batch frame, dropping events that do not look like an event", () => {
    const raw = JSON.stringify({
      type: "replay_batch",
      through: 4,
      events: [
        JSON.parse(durableEvent(0, 1)),
        "not an event",
        { type: "run.started" }, // missing sandboxGeneration
        JSON.parse(durableEvent(1, 2)),
      ],
    });
    const frame = parseWireFrame(raw);
    expect(frame.kind).toBe("replay_batch");
    if (frame.kind !== "replay_batch") {
      throw new Error("expected replay_batch");
    }
    expect(frame.through).toBe(4);
    expect(frame.events).toHaveLength(2);
  });

  it("treats a replay_batch with a non-array events field as carrying zero events", () => {
    const frame = parseWireFrame(JSON.stringify({ type: "replay_batch", through: 0, events: "x" }));
    expect(frame).toEqual({ kind: "replay_batch", through: 0, events: [] });
  });

  it("falls through to unparseable when replay_batch has no numeric through", () => {
    expect(parseWireFrame(JSON.stringify({ type: "replay_batch", events: [] }))).toEqual({
      kind: "unparseable",
    });
  });

  it("parses a caught_up frame", () => {
    expect(parseWireFrame(JSON.stringify({ type: "caught_up", through: 7 }))).toEqual({
      kind: "caught_up",
      through: 7,
    });
  });

  it("falls through to unparseable when caught_up has no numeric through", () => {
    expect(parseWireFrame(JSON.stringify({ type: "caught_up" }))).toEqual({ kind: "unparseable" });
  });

  it("parses a bare durable event", () => {
    const frame = parseWireFrame(durableEvent(0, 1, "runtime.connected"));
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") {
      throw new Error("expected event");
    }
    expect(frame.event).toMatchObject({
      type: "runtime.connected",
      sandboxGeneration: 1,
      runtimeSequence: 0,
      sessionSequence: 1,
    });
  });

  it("parses a bare ephemeral event (no sessionSequence)", () => {
    const frame = parseWireFrame(ephemeralEvent(2));
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") {
      throw new Error("expected event");
    }
    expect(frame.event.sessionSequence).toBeUndefined();
  });

  it("parses a control-origin event whose runtimeSequence is null", () => {
    const raw = JSON.stringify({
      type: "command.acknowledged",
      sandboxGeneration: 1,
      runtimeSequence: null,
      sessionSequence: 9,
    });
    expect(parseWireFrame(raw)).toEqual({
      kind: "event",
      event: {
        type: "command.acknowledged",
        sandboxGeneration: 1,
        runtimeSequence: null,
        sessionSequence: 9,
      },
    });
  });

  it("rejects an event-shaped object whose runtimeSequence is neither null nor a number", () => {
    const raw = JSON.stringify({ type: "x", sandboxGeneration: 1, runtimeSequence: "0" });
    expect(parseWireFrame(raw)).toEqual({ kind: "unparseable" });
  });

  it("rejects an object missing a string type", () => {
    const raw = JSON.stringify({ sandboxGeneration: 1, runtimeSequence: 0 });
    expect(parseWireFrame(raw)).toEqual({ kind: "unparseable" });
  });
});

describe("rowFromEvent", () => {
  it("returns null for a control-origin frame (no runtimeSequence)", () => {
    expect(
      rowFromEvent({ type: "command.acknowledged", sandboxGeneration: 1, runtimeSequence: null }),
    ).toBeNull();
  });

  it("marks a row durable when sessionSequence is present", () => {
    const row = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 1,
      runtimeSequence: 1,
      sessionSequence: 2,
    });
    expect(row).toEqual({
      slotKey: "1:1",
      sandboxGeneration: 1,
      runtimeSequence: 1,
      displayNumber: 2,
      sessionSequence: 2,
      eventType: "run.started",
      durability: "durable",
    });
  });

  it("marks a row ephemeral when sessionSequence is absent", () => {
    const row = rowFromEvent({ type: "message.delta", sandboxGeneration: 1, runtimeSequence: 2 });
    expect(row?.durability).toBe("ephemeral");
    expect(row?.sessionSequence).toBeNull();
    expect(row?.displayNumber).toBe(3);
  });
});

describe("reduceInspector", () => {
  it("resets state and starts connecting on session_started", () => {
    const withRows = reduceInspector(emptyInspectorState(), {
      kind: "frame",
      frame: { kind: "event", event: { type: "x", sandboxGeneration: 1, runtimeSequence: 0 } },
    });
    const next = reduceInspector(withRows, { kind: "session_started", sessionId: "s2" });
    expect(next.sessionId).toBe("s2");
    expect(next.status).toBe("connecting");
    expect(next.rows.size).toBe(0);
  });

  it("applies hydrated rows without changing status", () => {
    const row: InspectorRow = {
      slotKey: "1:2",
      sandboxGeneration: 1,
      runtimeSequence: 2,
      displayNumber: 3,
      sessionSequence: null,
      eventType: "message.delta",
      durability: "ephemeral",
    };
    const next = reduceInspector(emptyInspectorState(), { kind: "hydrated", rows: [row] });
    expect(next.status).toBe("idle");
    expect(next.rows.get("1:2")).toEqual(row);
  });

  it("is a no-op when hydrated with zero rows", () => {
    const state = emptyInspectorState();
    expect(reduceInspector(state, { kind: "hydrated", rows: [] })).toBe(state);
  });

  it("marks the socket closed", () => {
    expect(reduceInspector(emptyInspectorState(), { kind: "socket_closed" }).status).toBe("closed");
  });

  it("records a socket error", () => {
    const next = reduceInspector(emptyInspectorState(), {
      kind: "socket_error",
      message: "boom",
    });
    expect(next.status).toBe("error");
    expect(next.errorMessage).toBe("boom");
  });

  it("ignores an unparseable frame", () => {
    const state = emptyInspectorState();
    expect(reduceInspector(state, { kind: "frame", frame: { kind: "unparseable" } })).toBe(state);
  });

  it("applies a replay_batch frame's rows in one pass and moves to replaying", () => {
    const next = reduceInspector(emptyInspectorState(), {
      kind: "frame",
      frame: {
        kind: "replay_batch",
        through: 2,
        events: [
          {
            type: "runtime.connected",
            sandboxGeneration: 1,
            runtimeSequence: 0,
            sessionSequence: 1,
          },
          { type: "run.started", sandboxGeneration: 1, runtimeSequence: 1, sessionSequence: 2 },
          // control-origin: filtered out of the row table
          { type: "command.acknowledged", sandboxGeneration: 1, runtimeSequence: null },
        ],
      },
    });
    expect(next.status).toBe("replaying");
    expect(next.rows.size).toBe(2);
  });

  it("moves to caught_up on the caught_up marker", () => {
    const next = reduceInspector(emptyInspectorState(), {
      kind: "frame",
      frame: { kind: "caught_up", through: 0 },
    });
    expect(next.status).toBe("caught_up");
  });

  it("adds one row for a live sandbox-origin event", () => {
    const next = reduceInspector(emptyInspectorState(), {
      kind: "frame",
      frame: {
        kind: "event",
        event: { type: "message.delta", sandboxGeneration: 1, runtimeSequence: 2 },
      },
    });
    expect(next.rows.get("1:2")?.eventType).toBe("message.delta");
  });

  it("ignores a live control-origin event", () => {
    const state = emptyInspectorState();
    const next = reduceInspector(state, {
      kind: "frame",
      frame: {
        kind: "event",
        event: { type: "command.acknowledged", sandboxGeneration: 1, runtimeSequence: null },
      },
    });
    expect(next).toBe(state);
  });

  it("overwrites a slot on re-delivery instead of duplicating it", () => {
    const action: import("./stream").InspectorAction = {
      kind: "frame",
      frame: {
        kind: "event",
        event: {
          type: "run.started",
          sandboxGeneration: 1,
          runtimeSequence: 1,
          sessionSequence: 2,
        },
      },
    };
    const once = reduceInspector(emptyInspectorState(), action);
    const twice = reduceInspector(once, action);
    expect(twice.rows.size).toBe(1);
  });
});

describe("visibleRows", () => {
  it("returns nothing for an empty state", () => {
    expect(visibleRows(emptyInspectorState())).toEqual([]);
  });

  it("returns a single row untouched when there is nothing to fill", () => {
    const row = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 0,
      runtimeSequence: 3,
      sessionSequence: 1,
    }) as InspectorRow;
    const state = reduceInspector(emptyInspectorState(), { kind: "hydrated", rows: [row] });
    expect(visibleRows(state)).toEqual([{ ...row, synthesized: false }]);
  });

  it("fills the gap between two known slots in the same generation", () => {
    const first = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 1,
      runtimeSequence: 1,
      sessionSequence: 2,
    }) as InspectorRow;
    const last = rowFromEvent({
      type: "message.completed",
      sandboxGeneration: 1,
      runtimeSequence: 5,
      sessionSequence: 3,
    }) as InspectorRow;
    const state = reduceInspector(emptyInspectorState(), { kind: "hydrated", rows: [first, last] });
    const rows = visibleRows(state);
    expect(rows.map((row) => row.runtimeSequence)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.synthesized)).toEqual([false, true, true, true, false]);
    expect(rows[1]?.durability).toBe("not_replayed");
    expect(rows[1]?.eventType).toBe("ephemeral — not replayed");
  });

  it("renders the full seven-event acceptance shape from replayed durable rows alone", () => {
    const durableRuntimeSequences = [0, 1, 5, 6];
    const rows = durableRuntimeSequences.map(
      (runtimeSequence) =>
        rowFromEvent({
          type: "run.started",
          sandboxGeneration: 1,
          runtimeSequence,
          sessionSequence: runtimeSequence + 1,
        }) as InspectorRow,
    );
    const state = reduceInspector(emptyInspectorState(), { kind: "hydrated", rows });
    const visible = visibleRows(state);
    expect(visible).toHaveLength(7);
    expect(visible.map((row) => row.displayNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders generations ascending and restarts numbering per generation", () => {
    const genZero = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 0,
      runtimeSequence: 0,
      sessionSequence: 1,
    }) as InspectorRow;
    const genOne = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 1,
      runtimeSequence: 0,
      sessionSequence: 2,
    }) as InspectorRow;
    const state = reduceInspector(emptyInspectorState(), {
      kind: "hydrated",
      rows: [genOne, genZero],
    });
    const rows = visibleRows(state);
    expect(rows.map((row) => row.sandboxGeneration)).toEqual([0, 1]);
  });
});

describe("sessionStorage cache", () => {
  it("returns null when nothing is cached", () => {
    expect(readCachedSessionId(new MemoryStorage())).toBeNull();
  });

  it("round-trips the current session id", () => {
    const storage = new MemoryStorage();
    writeCachedSessionId(storage, "s1");
    expect(readCachedSessionId(storage)).toBe("s1");
  });

  it("swallows a throwing storage on read and write", () => {
    const storage = new ThrowingStorage();
    expect(() => writeCachedSessionId(storage, "s1")).not.toThrow();
    expect(readCachedSessionId(storage)).toBeNull();
  });

  it("does not cache a durable row", () => {
    const storage = new MemoryStorage();
    const row = rowFromEvent({
      type: "run.started",
      sandboxGeneration: 1,
      runtimeSequence: 0,
      sessionSequence: 1,
    }) as InspectorRow;
    cacheEphemeralRow(storage, "s1", row);
    expect(storage.length).toBe(0);
  });

  it("caches an ephemeral row and reads it back after a reload", () => {
    const storage = new MemoryStorage();
    const row = rowFromEvent({
      type: "message.delta",
      sandboxGeneration: 1,
      runtimeSequence: 2,
    }) as InspectorRow;
    cacheEphemeralRow(storage, "s1", row);
    const rows = readCachedEphemeralRows(storage, "s1");
    expect(rows).toEqual([
      {
        slotKey: "1:2",
        sandboxGeneration: 1,
        runtimeSequence: 2,
        displayNumber: 3,
        sessionSequence: null,
        eventType: "message.delta",
        durability: "ephemeral",
      },
    ]);
  });

  it("does not duplicate the index entry when the same slot is cached twice", () => {
    const storage = new MemoryStorage();
    const row = rowFromEvent({
      type: "message.delta",
      sandboxGeneration: 1,
      runtimeSequence: 2,
    }) as InspectorRow;
    cacheEphemeralRow(storage, "s1", row);
    cacheEphemeralRow(storage, "s1", row);
    expect(readCachedEphemeralRows(storage, "s1")).toHaveLength(1);
  });

  it("returns an empty list when no index has been written for the session", () => {
    expect(readCachedEphemeralRows(new MemoryStorage(), "unknown-session")).toEqual([]);
  });

  it("skips an index entry whose row was evicted", () => {
    const storage = new MemoryStorage();
    storage.setItem("oncue:dev:inspect:s1:index", JSON.stringify(["1:2"]));
    expect(readCachedEphemeralRows(storage, "s1")).toEqual([]);
  });

  it("swallows a throwing storage on cache write and read", () => {
    const storage = new ThrowingStorage();
    const row = rowFromEvent({
      type: "message.delta",
      sandboxGeneration: 1,
      runtimeSequence: 2,
    }) as InspectorRow;
    expect(() => cacheEphemeralRow(storage, "s1", row)).not.toThrow();
    expect(readCachedEphemeralRows(storage, "s1")).toEqual([]);
  });
});
