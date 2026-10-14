import { useEffect } from "react";

/** Reads are at least this far apart, so a burst of returns is not a burst of requests. */
const MIN_GAP_MS = 1000;

/** A return to the tab fires both `focus` and `visibilitychange`; within this they are one return. */
const SAME_RETURN_MS = 100;

/**
 * While `active`, calls `refresh` at once and again each time the person
 * comes back to the tab. For a screen waiting on something that is fixed
 * elsewhere, such as a key replaced in Settings or another tab: the fix is
 * read on return rather than on a reload. A change of `since` while active
 * reads again, for a new thing to wait on arriving before the last was fixed.
 */
export function useRefreshOnReturn(
  active: boolean,
  refresh: (() => unknown) | undefined,
  since?: unknown,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `since` is a trigger, not an input.
  useEffect(() => {
    if (!active || refresh === undefined) {
      return;
    }
    let last = 0;
    let lastReturn = Number.NEGATIVE_INFINITY;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      const since = Date.now() - last;
      if (since < MIN_GAP_MS) {
        // A return soon after a read is read when the gap ends, not dropped:
        // what is waited on may have been fixed since that read was made.
        pending ??= setTimeout(() => {
          pending = null;
          read();
        }, MIN_GAP_MS - since);
        return;
      }
      last = Date.now();
      refresh();
    };
    const onReturn = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      // Folded against the return before it, never against a read: a return
      // that lands a moment after this screen's own read is still a return,
      // and the fix it comes back from was made after that read began.
      const now = Date.now();
      if (now - lastReturn < SAME_RETURN_MS) {
        return;
      }
      lastReturn = now;
      read();
    };
    read();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      if (pending !== null) {
        clearTimeout(pending);
      }
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [active, refresh, since]);
}
