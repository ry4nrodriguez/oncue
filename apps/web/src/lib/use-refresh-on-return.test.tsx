import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRefreshOnReturn } from "./use-refresh-on-return";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Moves the clock past the gap that folds one return's two events into a read. */
function later(ms: number) {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + ms);
}

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

describe("useRefreshOnReturn", () => {
  it("reads at once when it becomes active, and not before", () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ active }) => useRefreshOnReturn(active, refresh), {
      initialProps: { active: false },
    });
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reads again on each return to the tab, once for the focus and visibility events together", () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshOnReturn(true, refresh));
    expect(refresh).toHaveBeenCalledTimes(1);

    later(5_000);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(2);

    later(10_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("reads a return that comes soon after a read once the gap ends, rather than dropping it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const refresh = vi.fn();
      const { unmount } = renderHook(() => useRefreshOnReturn(true, refresh));
      expect(refresh).toHaveBeenCalledTimes(1);

      // Back in the tab a moment after the first read: the fix made meanwhile must still be read.
      vi.advanceTimersByTime(300);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(700);
      expect(refresh).toHaveBeenCalledTimes(2);

      // A read still owed is dropped when the screen stops waiting.
      vi.advanceTimersByTime(300);
      window.dispatchEvent(new Event("focus"));
      unmount();
      vi.advanceTimersByTime(5_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a return that lands within moments of its own read, which began before the fix", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const refresh = vi.fn();
      renderHook(() => useRefreshOnReturn(true, refresh));
      expect(refresh).toHaveBeenCalledTimes(1);

      // The key is replaced and the person is back 40ms after the screen's
      // own read: one read is owed, for both events of that return.
      vi.advanceTimersByTime(40);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(960);
      expect(refresh).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(5_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads nothing when the tab is hidden rather than returned to", () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshOnReturn(true, refresh));
    later(5_000);
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops listening once it is no longer active, and when it unmounts", () => {
    const refresh = vi.fn();
    const { rerender, unmount } = renderHook(({ active }) => useRefreshOnReturn(active, refresh), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    later(5_000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
    later(20_000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reads again when what it waits on changes while it is still active", () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ since }) => useRefreshOnReturn(true, refresh, since), {
      initialProps: { since: "first pause" },
    });
    rerender({ since: "first pause" });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ since: "second pause" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing with no way to read", () => {
    expect(() => renderHook(() => useRefreshOnReturn(true, undefined))).not.toThrow();
  });
});
