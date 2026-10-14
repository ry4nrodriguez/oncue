import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListRow } from "@/lib/api/sessions";
import {
  MAX_SEEN_RUNS,
  readSeenRuns,
  seedSeenRuns,
  useSeenRuns,
  withSeenRun,
  writeSeenRuns,
} from "./seen-runs";

function row(sessionId: string, overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    sessionId,
    title: null,
    state: "active",
    lastActivityAt: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    repositoryFullName: null,
    taskBranch: null,
    waitingForUser: false,
    currentRunId: `run_${sessionId}`,
    currentRunState: "verified",
    ...overrides,
  };
}

const STORE_KEY = "oncue.seen-runs.ws_1";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("reading and writing the marks", () => {
  it("round-trips through localStorage, per workspace", () => {
    writeSeenRuns("ws_1", new Map([["s1", "run_1"]]));
    expect(readSeenRuns("ws_1")).toEqual(new Map([["s1", "run_1"]]));
    expect(readSeenRuns("ws_2")).toBeNull();
  });

  it("says null for no workspace and for a workspace never stored", () => {
    expect(readSeenRuns(null)).toBeNull();
    expect(readSeenRuns("ws_1")).toBeNull();
  });

  it("reads a hand-edited or unreadable value as nothing seen, never as an error", () => {
    window.localStorage.setItem(STORE_KEY, "{not json");
    expect(readSeenRuns("ws_1")).toEqual(new Map());
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ s1: "run_1" }));
    expect(readSeenRuns("ws_1")).toEqual(new Map());
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify([["s1", "run_1"], ["s2"], [3, "run_3"], "s4", ["s5", 5]]),
    );
    expect(readSeenRuns("ws_1")).toEqual(new Map([["s1", "run_1"]]));
  });

  it("survives blocked storage on both sides", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSeenRuns("ws_1")).toEqual(new Map());
    expect(() => writeSeenRuns("ws_1", new Map([["s1", "r"]]))).not.toThrow();
  });
});

describe("seedSeenRuns", () => {
  it("marks every run that already ended, and nothing still working or never projected", () => {
    const seeded = seedSeenRuns([
      row("ended"),
      row("working", { currentRunState: "running" }),
      row("old", { currentRunId: null, currentRunState: null }),
    ]);
    expect(seeded).toEqual(new Map([["ended", "run_ended"]]));
  });
});

describe("withSeenRun", () => {
  it("returns the same map when the mark is already there", () => {
    const seen = new Map([["s1", "run_1"]]);
    expect(withSeenRun(seen, "s1", "run_1")).toBe(seen);
  });

  it("replaces a session's older mark and keeps the map bounded, dropping the oldest", () => {
    let seen: ReadonlyMap<string, string> = new Map();
    for (let index = 0; index < MAX_SEEN_RUNS; index += 1) {
      seen = withSeenRun(seen, `s${index}`, "run_a");
    }
    seen = withSeenRun(seen, "s0", "run_b");
    expect(seen.size).toBe(MAX_SEEN_RUNS);
    seen = withSeenRun(seen, "new", "run_c");
    expect(seen.size).toBe(MAX_SEEN_RUNS);
    // s1 was the oldest once s0 moved to the end.
    expect(seen.has("s1")).toBe(false);
    expect(seen.get("s0")).toBe("run_b");
    expect(seen.get("new")).toBe("run_c");
  });
});

describe("useSeenRuns", () => {
  it("counts the first list this browser sees as seen, and stores it", () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: readonly SessionListRow[] | null }) => useSeenRuns("ws_1", rows),
      { initialProps: { rows: null as readonly SessionListRow[] | null } },
    );
    expect(result.current.seen).toEqual(new Map());
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();

    rerender({ rows: [row("a"), row("b", { currentRunState: "running" })] });
    expect(result.current.seen).toEqual(new Map([["a", "run_a"]]));
    expect(readSeenRuns("ws_1")).toEqual(new Map([["a", "run_a"]]));

    // A later list does not re-seed: a run that ends afterwards stays unseen.
    rerender({ rows: [row("a"), row("b")] });
    expect(result.current.seen.has("b")).toBe(false);
  });

  it("keeps a mark made before the first list, and seeds around it", () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: readonly SessionListRow[] | null }) => useSeenRuns("ws_1", rows),
      { initialProps: { rows: null as readonly SessionListRow[] | null } },
    );
    act(() => result.current.markSeen("open", "run_new"));
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();

    rerender({ rows: [row("a"), row("open", { currentRunState: "running" })] });
    expect(result.current.seen).toEqual(
      new Map([
        ["a", "run_a"],
        ["open", "run_new"],
      ]),
    );
  });

  it("marks a run seen and writes it through", () => {
    writeSeenRuns("ws_1", new Map());
    const { result } = renderHook(() => useSeenRuns("ws_1", [row("a")]));
    expect(result.current.seen.has("a")).toBe(false);
    act(() => result.current.markSeen("a", "run_a"));
    expect(result.current.seen.get("a")).toBe("run_a");
    expect(readSeenRuns("ws_1")?.get("a")).toBe("run_a");
    // The same mark again changes nothing.
    const before = result.current.seen;
    act(() => result.current.markSeen("a", "run_a"));
    expect(result.current.seen).toBe(before);
  });

  it("does nothing without a workspace", () => {
    const { result } = renderHook(() => useSeenRuns(null, [row("a")]));
    act(() => result.current.markSeen("a", "run_a"));
    expect(result.current.seen).toEqual(new Map());
    expect(window.localStorage.length).toBe(0);
  });

  it("follows a mark another tab of this browser wrote", () => {
    writeSeenRuns("ws_1", new Map());
    const { result } = renderHook(() => useSeenRuns("ws_1", [row("a")]));
    writeSeenRuns("ws_1", new Map([["a", "run_a"]]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "oncue.seen-runs.other" }));
    });
    expect(result.current.seen.has("a")).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORE_KEY }));
    });
    expect(result.current.seen.get("a")).toBe("run_a");
  });
});
