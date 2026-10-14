/**
 * Which ended run the user has seen per session, in localStorage per
 * workspace (see `docs/decisions.md`): the "not opened yet" half of the
 * sidebar's finished dot. Keyed by run id, so a later run marks the session
 * again without comparing clocks. The first list a browser sees counts as
 * seen, so old runs do not all light up at once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionListRow } from "@/lib/api/sessions";
import { endedRunId } from "./session-activity";

const PREFIX = "oncue.seen-runs.";

/** Enough for the list's own limit of 100 rows twice over; the oldest mark goes first. */
export const MAX_SEEN_RUNS = 200;

export type SeenRuns = ReadonlyMap<string, string>;

function key(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

/** `null` when this browser has never stored marks for the workspace, which is what seeding waits for. */
export function readSeenRuns(workspaceId: string | null): SeenRuns | null {
  if (workspaceId === null) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key(workspaceId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Map();
    }
    const seen = new Map<string, string>();
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        seen.set(entry[0], entry[1]);
      }
    }
    return seen;
  } catch {
    // Blocked storage or a hand-edited value: nothing seen, never an error.
    return new Map();
  }
}

export function writeSeenRuns(workspaceId: string, seen: SeenRuns): void {
  try {
    window.localStorage.setItem(key(workspaceId), JSON.stringify([...seen]));
  } catch {
    // Storage is a convenience here, never a source of truth.
  }
}

/** Every run already ended in the first list this browser sees, marked seen. */
export function seedSeenRuns(rows: readonly SessionListRow[]): SeenRuns {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const runId = endedRunId(row);
    if (runId !== null) {
      seen.set(row.sessionId, runId);
    }
  }
  return seen;
}

/**
 * The marks with this session's run recorded as seen. The same map comes
 * back when nothing changes, so a caller can skip the write and the render.
 */
export function withSeenRun(seen: SeenRuns, sessionId: string, runId: string): SeenRuns {
  if (seen.get(sessionId) === runId) {
    return seen;
  }
  const next = new Map(seen);
  // Deleted first so the fresh mark moves to the end, and the oldest is the one dropped.
  next.delete(sessionId);
  next.set(sessionId, runId);
  while (next.size > MAX_SEEN_RUNS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    next.delete(oldest);
  }
  return next;
}

const NONE: SeenRuns = new Map();

/**
 * The workspace's marks and a way to add one. `rows` is the loaded list, or
 * `null` until the first answer arrives: seeding waits for a real list, so an
 * empty placeholder never counts as "everything seen".
 */
export function useSeenRuns(
  workspaceId: string | null,
  rows: readonly SessionListRow[] | null,
): {
  readonly seen: SeenRuns;
  readonly markSeen: (sessionId: string, runId: string) => void;
} {
  const [stored, setStored] = useState<SeenRuns | null>(() => readSeenRuns(workspaceId));
  // Marks made before the first list arrived, folded into the seed.
  const early = useRef(new Map<string, string>());

  useEffect(() => {
    setStored(readSeenRuns(workspaceId));
    if (workspaceId === null) {
      return;
    }
    // Another tab of the same browser opening a session clears its dot here too.
    const onStorage = (event: StorageEvent) => {
      if (event.key === key(workspaceId)) {
        setStored(readSeenRuns(workspaceId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId === null || rows === null || stored !== null) {
      return;
    }
    let seeded = seedSeenRuns(rows);
    for (const [sessionId, runId] of early.current) {
      seeded = withSeenRun(seeded, sessionId, runId);
    }
    early.current.clear();
    writeSeenRuns(workspaceId, seeded);
    setStored(seeded);
  }, [workspaceId, rows, stored]);

  const markSeen = useCallback(
    (sessionId: string, runId: string) => {
      if (workspaceId === null) {
        return;
      }
      setStored((current) => {
        if (current === null) {
          // Before the first list: starting the store now would stop the
          // seed, and every other ended run would light up at once.
          early.current.set(sessionId, runId);
          return current;
        }
        const next = withSeenRun(current, sessionId, runId);
        if (next !== current) {
          writeSeenRuns(workspaceId, next);
        }
        return next;
      });
    },
    [workspaceId],
  );

  return { seen: stored ?? NONE, markSeen };
}
