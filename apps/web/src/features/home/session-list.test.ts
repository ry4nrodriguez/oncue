import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListSessionsResult, SessionListRow } from "@/lib/api/sessions";
import {
  applyLocalChanges,
  pollDelayFor,
  settleLocalChanges,
  useSessionList,
  useSessionListActions,
  WORKING_POLL_MS,
} from "./session-list";

const listSessions = vi.fn<() => Promise<ListSessionsResult>>();

vi.mock("@/lib/api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sessions")>()),
  listSessions: () => listSessions(),
}));

function row(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    sessionId: "s1",
    title: null,
    state: "active",
    lastActivityAt: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    repositoryFullName: null,
    taskBranch: null,
    waitingForUser: false,
    currentRunId: "run_1",
    currentRunState: "verified",
    ...overrides,
  };
}

const WORKING = row({ currentRunState: "running" });
const ENDED = row({ currentRunState: "verified" });

function listed(...sessions: SessionListRow[]): ListSessionsResult {
  return { kind: "listed", sessions };
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  listSessions.mockReset();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("pollDelayFor", () => {
  it("polls only while some session is working", () => {
    expect(pollDelayFor(null)).toBeNull();
    expect(pollDelayFor([])).toBeNull();
    expect(pollDelayFor([ENDED, row({ currentRunState: "paused" })])).toBeNull();
    expect(pollDelayFor([ENDED, WORKING])).toBe(WORKING_POLL_MS);
  });
});

describe("useSessionList", () => {
  it("reads once on mount and has no rows until the answer arrives", async () => {
    listSessions.mockResolvedValue(listed(ENDED));
    const { result } = renderHook(() => useSessionList("ws#1", "/"));
    expect(result.current.rows).toBeNull();
    await flush();
    expect(result.current.rows).toEqual([ENDED]);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("polls while a run works and stops once none does", async () => {
    listSessions.mockResolvedValue(listed(WORKING));
    const { result } = renderHook(() => useSessionList("ws#1", "/"));
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);

    await flush(WORKING_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(2);

    listSessions.mockResolvedValue(listed(ENDED));
    await flush(WORKING_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(result.current.rows).toEqual([ENDED]);

    await flush(WORKING_POLL_MS * 5);
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after a failed read while the last list still showed work", async () => {
    listSessions.mockResolvedValueOnce(listed(WORKING));
    listSessions.mockResolvedValueOnce({ kind: "unreachable" });
    listSessions.mockResolvedValue(listed(WORKING));
    renderHook(() => useSessionList("ws#1", "/"));
    await flush();
    await flush(WORKING_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(2);
    await flush(WORKING_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it("reads nothing while the tab is hidden, and reads at once when it is shown", async () => {
    listSessions.mockResolvedValue(listed(WORKING));
    renderHook(() => useSessionList("ws#1", "/"));
    await flush();
    visibility = "hidden";
    await flush(WORKING_POLL_MS * 3);
    expect(listSessions).toHaveBeenCalledTimes(1);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("reads again on a route change and when the window regains focus", async () => {
    listSessions.mockResolvedValue(listed(ENDED));
    const { rerender } = renderHook(({ path }) => useSessionList("ws#1", path), {
      initialProps: { path: "/" },
    });
    await flush();
    rerender({ path: "/sessions/s1" });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it("runs a read asked for mid-flight once, after the one in flight", async () => {
    let answer: (value: ListSessionsResult) => void = () => {};
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    listSessions.mockResolvedValue(listed(ENDED));
    const { result } = renderHook(() => useSessionList("ws#1", "/"));
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(listed(WORKING));
    });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(result.current.rows).toEqual([ENDED]);
  });

  it("drops an answer that arrives after the workspace changed", async () => {
    let answer: (value: ListSessionsResult) => void = () => {};
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    listSessions.mockResolvedValue(listed(ENDED));
    const { result, rerender } = renderHook(({ key }) => useSessionList(key, "/"), {
      initialProps: { key: "ws_a#1" },
    });
    await flush();
    rerender({ key: "ws_b#1" });
    await act(async () => {
      answer(listed(WORKING));
    });
    await flush();
    // The stale answer never showed; the new key's own read did.
    expect(result.current.rows).toEqual([ENDED]);
  });

  it("reads after the delay a refresh asks for, once however often it is asked", async () => {
    listSessions.mockResolvedValue(listed(ENDED));
    const { result } = renderHook(() => useSessionList("ws#1", "/"));
    await flush();
    act(() => {
      result.current.refresh(1000);
      result.current.refresh(1000);
    });
    await flush(999);
    expect(listSessions).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer that lands after unmount", async () => {
    let answer: (value: ListSessionsResult) => void = () => {};
    listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useSessionList("ws#1", "/"));
    act(() => result.current.refresh(500));
    unmount();
    await act(async () => {
      answer(listed(WORKING));
    });
    await flush(WORKING_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

describe("local changes before the next read", () => {
  const rows = [row({ sessionId: "a" }), row({ sessionId: "b" }), row({ sessionId: "c" })];

  it("hides a session deleted here and shows an archive or restore made here", () => {
    const shown = applyLocalChanges(
      rows,
      new Set(["b"]),
      new Map([
        ["c", "archived"],
        ["a", "active"],
      ]),
    );
    expect(shown.map((r) => [r.sessionId, r.state])).toEqual([
      ["a", "active"],
      ["c", "archived"],
    ]);
    // The row that already said so is the same object.
    expect(shown[0]).toBe(rows[0]);
  });

  it("returns the rows themselves when nothing changed here", () => {
    expect(applyLocalChanges(rows, new Set(), new Map())).toBe(rows);
  });

  it("lets each override lapse once the server agrees, keeping the ones it does not yet", () => {
    const removed = new Set(["b", "gone"]);
    const states = new Map<string, SessionListRow["state"]>([
      ["a", "active"],
      ["c", "archived"],
    ]);
    const settled = settleLocalChanges(rows, removed, states);
    expect([...settled.removed]).toEqual(["b"]);
    expect([...settled.states]).toEqual([["c", "archived"]]);

    const unchanged = settleLocalChanges(rows, new Set(["b"]), new Map([["c", "archived"]]));
    expect(unchanged.removed).toEqual(new Set(["b"]));
    const same = new Set(["b"]);
    const sameStates = new Map<string, SessionListRow["state"]>([["c", "archived"]]);
    const kept = settleLocalChanges(rows, same, sameStates);
    expect(kept.removed).toBe(same);
    expect(kept.states).toBe(sameStates);
  });

  it("refuses every change outside a shell that can make one", async () => {
    const { result } = renderHook(() => useSessionListActions());
    expect(await result.current.archive("a", false)).toEqual({
      kind: "error",
      message: "This screen can't change sessions.",
    });
    expect(await result.current.unarchive("a")).toBe("This screen can't change sessions.");
    expect(await result.current.remove("a")).toBe("This screen can't change sessions.");
    result.current.runChanged("a", null);
  });
});
