/**
 * The sidebar's `GET /api/sessions` list, read from D1 (never by waking a
 * session object) as little as the status dots allow: on mount, identity
 * revalidation, route change, focus, and visibility; when the open session's
 * run changes; and every `WORKING_POLL_MS` only while the tab is visible and
 * some run is working. Requests never overlap; one asked for mid-flight runs
 * once afterwards.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { listSessions, type SessionListRow } from "@/lib/api/sessions";
import { isWorking } from "./session-activity";

export const WORKING_POLL_MS = 4000;

/** How long to wait before the next read: `null` means no polling, because nothing is working. */
export function pollDelayFor(rows: readonly SessionListRow[] | null): number | null {
  if (rows === null) {
    return null;
  }
  return rows.some(isWorking) ? WORKING_POLL_MS : null;
}

function tabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * `key` changes when the list must be read from scratch (another workspace);
 * `trigger` changes when the list on screen should be read again (a
 * navigation, an identity revision). `rows` is `null` until the first answer
 * for this key.
 */
export function useSessionList(
  key: string,
  trigger: string,
): {
  readonly rows: readonly SessionListRow[] | null;
  readonly refresh: (delayMs?: number) => void;
} {
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly rows: readonly SessionListRow[];
  } | null>(null);
  // Bumped after every attempt, answered or not, so the poll re-arms even
  // when a read failed and the rows did not change.
  const [attempts, setAttempts] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const inFlight = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(() => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const askedFor = keyRef.current;
    void listSessions().then((result) => {
      inFlight.current = false;
      if (!mounted.current) {
        return;
      }
      // Discard an answer for a key that has since changed.
      if (result.kind === "listed" && askedFor === keyRef.current) {
        setLoaded({ key: askedFor, rows: result.sessions });
      }
      setAttempts((count) => count + 1);
      if (again.current) {
        again.current = false;
        load();
      }
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key and the trigger are triggers, not inputs.
  useEffect(() => {
    load();
  }, [key, trigger, load]);

  useEffect(() => {
    const onVisible = () => {
      if (tabVisible()) {
        load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  const rows = loaded?.key === key ? loaded.rows : null;
  const delay = pollDelayFor(rows);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempts` re-arms the timer after every read.
  useEffect(() => {
    if (delay === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      // A hidden tab reads nothing; becoming visible again reads at once.
      if (tabVisible()) {
        load();
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [delay, attempts, load]);

  const pending = useRef<number | null>(null);
  const refresh = useCallback(
    (delayMs = 0) => {
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
      }
      pending.current = window.setTimeout(() => {
        pending.current = null;
        load();
      }, delayMs);
    },
    [load],
  );
  useEffect(
    () => () => {
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
      }
    },
    [],
  );

  return { rows, refresh };
}

/** What archiving answered, as the menu needs it. */
export type ArchiveOutcome =
  | { readonly kind: "done" }
  /** A run is open; the user is asked before it is cancelled. */
  | { readonly kind: "run_open" }
  | { readonly kind: "error"; readonly message: string };

/**
 * What a session's screen and its sidebar menu ask of the shell: the list is
 * read again soon after a run changes, and a run that ended on screen is
 * marked seen; archiving, restoring, and deleting update the list at once.
 */
export interface SessionListActions {
  readonly runChanged: (sessionId: string, run: { runId: string; ended: boolean } | null) => void;
  readonly archive: (sessionId: string, cancelOpenRun: boolean) => Promise<ArchiveOutcome>;
  /** Resolves to null once restored, or the sentence to show. */
  readonly unarchive: (sessionId: string) => Promise<string | null>;
  /** Resolves to null once the session is closed and queued for erasure, or the sentence to show. */
  readonly remove: (sessionId: string) => Promise<string | null>;
}

const NO_SHELL = "This screen can't change sessions.";

const NO_ACTIONS: SessionListActions = {
  runChanged: () => {},
  archive: async () => ({ kind: "error", message: NO_SHELL }),
  unarchive: async () => NO_SHELL,
  remove: async () => NO_SHELL,
};

export const SessionListContext = createContext<SessionListActions>(NO_ACTIONS);

export function useSessionListActions(): SessionListActions {
  return useContext(SessionListContext);
}

/**
 * The list as the shell shows it: sessions deleted here are gone at once, and
 * an archive or restore made here shows before the next read confirms it.
 * Each override lapses once the server's rows agree.
 */
export function applyLocalChanges(
  rows: readonly SessionListRow[],
  removed: ReadonlySet<string>,
  states: ReadonlyMap<string, SessionListRow["state"]>,
): readonly SessionListRow[] {
  if (removed.size === 0 && states.size === 0) {
    return rows;
  }
  return rows
    .filter((row) => !removed.has(row.sessionId))
    .map((row) => {
      const state = states.get(row.sessionId);
      return state === undefined || state === row.state ? row : { ...row, state };
    });
}

/** The overrides still needed once the server's rows arrive: any the server already agrees with lapse. */
export function settleLocalChanges(
  rows: readonly SessionListRow[],
  removed: ReadonlySet<string>,
  states: ReadonlyMap<string, SessionListRow["state"]>,
): {
  readonly removed: ReadonlySet<string>;
  readonly states: ReadonlyMap<string, SessionListRow["state"]>;
} {
  const listed = new Map(rows.map((row) => [row.sessionId, row.state]));
  const stillRemoved = new Set([...removed].filter((sessionId) => listed.has(sessionId)));
  const stillStated = new Map(
    [...states].filter(([sessionId, state]) => listed.get(sessionId) !== state),
  );
  return {
    removed: stillRemoved.size === removed.size ? removed : stillRemoved,
    states: stillStated.size === states.size ? states : stillStated,
  };
}
