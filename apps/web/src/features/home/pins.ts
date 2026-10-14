/**
 * Pinned sessions, a reading preference kept in localStorage per workspace.
 * They do not follow the user to another browser.
 */
import { useCallback, useEffect, useState } from "react";

const PREFIX = "oncue.pins.";
const EMPTY: ReadonlySet<string> = new Set();

function key(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

export function readPins(workspaceId: string | null): ReadonlySet<string> {
  if (workspaceId === null) {
    return EMPTY;
  }
  try {
    const raw = window.localStorage.getItem(key(workspaceId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    // Blocked storage or a hand-edited value: no pins, never an error.
    return EMPTY;
  }
}

export function writePins(workspaceId: string, pins: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key(workspaceId), JSON.stringify([...pins]));
  } catch {
    // Storage is a convenience here, never a source of truth.
  }
}

/** The workspace's pins, and a toggle that stores the change. */
export function usePins(workspaceId: string | null): {
  readonly pinned: ReadonlySet<string>;
  readonly toggle: (sessionId: string) => void;
} {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => readPins(workspaceId));
  useEffect(() => {
    setPinned(readPins(workspaceId));
  }, [workspaceId]);
  const toggle = useCallback(
    (sessionId: string) => {
      if (workspaceId === null) {
        return;
      }
      setPinned((current) => {
        const next = new Set(current);
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        writePins(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );
  return { pinned, toggle };
}
