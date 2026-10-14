/**
 * Turns `GET /api/sessions` rows into record 13's sidebar groups with status
 * dots. The dot's inputs are projected into `session_index`, so D1 answers
 * without opening a session object.
 */
import type { SessionListRow } from "@/lib/api/sessions";
import type { SessionSummary, SidebarGroups } from "./Sidebar";
import type { SeenRuns } from "./seen-runs";
import { activityOf, runOpen, type SessionActivity } from "./session-activity";

function summaryOf(row: SessionListRow, pinned: boolean, activity: SessionActivity) {
  return {
    sessionId: row.sessionId,
    title: row.title ?? "Untitled session",
    activity,
    pinned,
    archived: row.state === "archived",
    runOpen: runOpen(row),
  } satisfies SessionSummary;
}

const NO_PINS: ReadonlySet<string> = new Set();
const NO_SEEN: SeenRuns = new Map();

export interface GroupOptions {
  readonly pins?: ReadonlySet<string>;
  /** The run each session was last seen ending (`seen-runs.ts`). */
  readonly seen?: SeenRuns;
  /** The session on screen, which never shows a "not opened yet" dot. */
  readonly openSessionId?: string | null;
}

function activityTime(row: SessionListRow): number {
  const at = Date.parse(row.lastActivityAt ?? row.createdAt);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Three groups: `pinned`, `active` (every other open session), and
 * `archived`, each newest activity first so a session that needs attention
 * rises to the top. Sorted here too so the order holds whatever order rows
 * arrive in. A session appears in one group only; archiving takes it out of
 * Pinned, and restoring puts it back.
 */
export function groupSessions(
  rows: readonly SessionListRow[],
  { pins = NO_PINS, seen = NO_SEEN, openSessionId = null }: GroupOptions = {},
): SidebarGroups {
  const pinned: SessionSummary[] = [];
  const active: SessionSummary[] = [];
  const archived: SessionSummary[] = [];
  const newestFirst = [...rows].sort((a, b) => activityTime(b) - activityTime(a));
  for (const row of newestFirst) {
    const isPinned = pins.has(row.sessionId);
    const activity = activityOf(row, seen.get(row.sessionId), row.sessionId === openSessionId);
    const summary = summaryOf(row, isPinned, activity);
    (summary.archived ? archived : isPinned ? pinned : active).push(summary);
  }
  return { pinned, active, archived };
}
