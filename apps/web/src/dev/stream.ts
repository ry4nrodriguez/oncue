/**
 * The dev inspector's pure reducer; `inspect.tsx` only wires DOM events and a
 * WebSocket to it. It consumes the frames `worker/session/replay.ts` and the
 * session object send: `replay_batch`, `caught_up`, and bare live events.
 *
 * Rows are keyed by `sandboxGeneration:runtimeSequence` so a re-delivered
 * frame overwrites its own slot. Only sandbox-origin frames (non-null
 * `runtimeSequence`) get a row.
 */

export type SlotKey = `${number}:${number}`;

export function slotKeyOf(sandboxGeneration: number, runtimeSequence: number): SlotKey {
  return `${sandboxGeneration}:${runtimeSequence}`;
}

export type RowDurability = "durable" | "ephemeral" | "not_replayed";

export interface InspectorRow {
  readonly slotKey: SlotKey;
  readonly sandboxGeneration: number;
  readonly runtimeSequence: number;
  readonly displayNumber: number;
  readonly sessionSequence: number | null;
  readonly eventType: string;
  readonly durability: RowDurability;
}

export interface DisplayRow extends InspectorRow {
  readonly synthesized: boolean;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "replaying"
  | "caught_up"
  | "closed"
  | "error";

export interface InspectorState {
  readonly sessionId: string | null;
  readonly status: ConnectionStatus;
  readonly errorMessage: string | null;
  readonly rows: ReadonlyMap<SlotKey, InspectorRow>;
}

export function emptyInspectorState(): InspectorState {
  return { sessionId: null, status: "idle", errorMessage: null, rows: new Map() };
}

export function statusLabel(state: InspectorState): string {
  switch (state.status) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting…";
    case "replaying":
      return "Replaying…";
    case "caught_up":
      return "Caught up";
    case "closed":
      return "Closed";
    case "error":
      return `Error: ${state.errorMessage ?? "unknown"}`;
  }
}

// Wire frame parsing is structural, not strict: this dev-only view reads our
// own Worker's committed JSON and is not a trust boundary.

export interface RawEventLike {
  readonly type: string;
  readonly sandboxGeneration: number;
  readonly runtimeSequence: number | null;
  readonly sessionSequence?: number;
}

export type WireFrame =
  | {
      readonly kind: "replay_batch";
      readonly through: number;
      readonly events: readonly RawEventLike[];
    }
  | { readonly kind: "caught_up"; readonly through: number }
  | { readonly kind: "event"; readonly event: RawEventLike }
  | { readonly kind: "unparseable" };

// Not a type predicate: `RawEventLike` has no index signature, so TypeScript
// rejects the guard. Callers cast once this returns true.
function looksLikeEvent(value: Record<string, unknown>): boolean {
  const runtimeSequence = value.runtimeSequence;
  return (
    typeof value.type === "string" &&
    typeof value.sandboxGeneration === "number" &&
    (runtimeSequence === null || typeof runtimeSequence === "number")
  );
}

function toRawEvents(value: unknown): readonly RawEventLike[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: RawEventLike[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      looksLikeEvent(entry as Record<string, unknown>)
    ) {
      events.push(entry as unknown as RawEventLike);
    }
  }
  return events;
}

export function parseWireFrame(raw: string): WireFrame {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { kind: "unparseable" };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { kind: "unparseable" };
  }
  const value = decoded as Record<string, unknown>;
  if (value.type === "replay_batch" && typeof value.through === "number") {
    return { kind: "replay_batch", through: value.through, events: toRawEvents(value.events) };
  }
  if (value.type === "caught_up" && typeof value.through === "number") {
    return { kind: "caught_up", through: value.through };
  }
  if (looksLikeEvent(value)) {
    return { kind: "event", event: value as unknown as RawEventLike };
  }
  return { kind: "unparseable" };
}

export function rowFromEvent(event: RawEventLike): InspectorRow | null {
  if (event.runtimeSequence === null) {
    return null;
  }
  const sessionSequence = typeof event.sessionSequence === "number" ? event.sessionSequence : null;
  return {
    slotKey: slotKeyOf(event.sandboxGeneration, event.runtimeSequence),
    sandboxGeneration: event.sandboxGeneration,
    runtimeSequence: event.runtimeSequence,
    displayNumber: event.runtimeSequence + 1,
    sessionSequence,
    eventType: event.type,
    durability: sessionSequence === null ? "ephemeral" : "durable",
  };
}

function withRows(state: InspectorState, updates: readonly InspectorRow[]): InspectorState {
  if (updates.length === 0) {
    return state;
  }
  // One map copy per dispatch, so a large replay costs one pass rather than
  // one state update per event.
  const rows = new Map(state.rows);
  for (const row of updates) {
    rows.set(row.slotKey, row);
  }
  return { ...state, rows };
}

export type InspectorAction =
  | { readonly kind: "session_started"; readonly sessionId: string }
  | { readonly kind: "hydrated"; readonly rows: readonly InspectorRow[] }
  | { readonly kind: "frame"; readonly frame: WireFrame }
  | { readonly kind: "socket_closed" }
  | { readonly kind: "socket_error"; readonly message: string };

export function reduceInspector(state: InspectorState, action: InspectorAction): InspectorState {
  switch (action.kind) {
    case "session_started":
      return { ...emptyInspectorState(), sessionId: action.sessionId, status: "connecting" };
    case "hydrated":
      return withRows(state, action.rows);
    case "socket_closed":
      return { ...state, status: "closed" };
    case "socket_error":
      return { ...state, status: "error", errorMessage: action.message };
    case "frame": {
      const frame = action.frame;
      switch (frame.kind) {
        case "unparseable":
          return state;
        case "replay_batch": {
          const updates: InspectorRow[] = [];
          for (const event of frame.events) {
            const row = rowFromEvent(event);
            if (row !== null) {
              updates.push(row);
            }
          }
          return withRows({ ...state, status: "replaying" }, updates);
        }
        case "caught_up":
          return { ...state, status: "caught_up" };
        case "event": {
          const row = rowFromEvent(frame.event);
          return row === null ? state : withRows(state, [row]);
        }
      }
    }
  }
}

// A slot never replayed (an ephemeral frame this tab never saw) still gets a
// numbered "not replayed" row. Gaps are filled only between two known slots
// of the same generation, never below the lowest one seen.

const NOT_REPLAYED_LABEL = "ephemeral — not replayed";

function placeholderRow(sandboxGeneration: number, runtimeSequence: number): DisplayRow {
  return {
    slotKey: slotKeyOf(sandboxGeneration, runtimeSequence),
    sandboxGeneration,
    runtimeSequence,
    displayNumber: runtimeSequence + 1,
    sessionSequence: null,
    eventType: NOT_REPLAYED_LABEL,
    durability: "not_replayed",
    synthesized: true,
  };
}

export function visibleRows(state: InspectorState): readonly DisplayRow[] {
  const byGeneration = new Map<number, InspectorRow[]>();
  for (const row of state.rows.values()) {
    const list = byGeneration.get(row.sandboxGeneration);
    if (list === undefined) {
      byGeneration.set(row.sandboxGeneration, [row]);
    } else {
      list.push(row);
    }
  }
  const generations = [...byGeneration.keys()].sort((a, b) => a - b);
  const result: DisplayRow[] = [];
  for (const generation of generations) {
    const rows = (byGeneration.get(generation) as InspectorRow[])
      .slice()
      .sort((a, b) => a.runtimeSequence - b.runtimeSequence);
    // Null until the first row of this generation, so nothing is filled below it.
    let expected: number | null = null;
    for (const row of rows) {
      if (expected !== null) {
        while (expected < row.runtimeSequence) {
          result.push(placeholderRow(generation, expected));
          expected += 1;
        }
      }
      result.push({ ...row, synthesized: false });
      expected = row.runtimeSequence + 1;
    }
  }
  return result;
}

// Per-tab sessionStorage cache for ephemeral rows. Every access is wrapped in
// try/catch because sessionStorage throws in some privacy modes.

const CACHE_PREFIX = "oncue:dev:inspect";
const CURRENT_SESSION_KEY = `${CACHE_PREFIX}:current-session`;

function indexKey(sessionId: string): string {
  return `${CACHE_PREFIX}:${sessionId}:index`;
}

function rowKey(sessionId: string, slotKey: SlotKey): string {
  return `${CACHE_PREFIX}:${sessionId}:${slotKey}`;
}

export function readCachedSessionId(storage: Storage): string | null {
  try {
    return storage.getItem(CURRENT_SESSION_KEY);
  } catch {
    return null;
  }
}

export function writeCachedSessionId(storage: Storage, sessionId: string): void {
  try {
    storage.setItem(CURRENT_SESSION_KEY, sessionId);
  } catch {
    // A lost write only means a reload cannot find the session to resume.
  }
}

export function cacheEphemeralRow(storage: Storage, sessionId: string, row: InspectorRow): void {
  if (row.durability !== "ephemeral") {
    return;
  }
  try {
    const raw = storage.getItem(indexKey(sessionId));
    const known: string[] = raw === null ? [] : (JSON.parse(raw) as string[]);
    if (!known.includes(row.slotKey)) {
      known.push(row.slotKey);
      storage.setItem(indexKey(sessionId), JSON.stringify(known));
    }
    storage.setItem(rowKey(sessionId, row.slotKey), JSON.stringify({ eventType: row.eventType }));
  } catch {
    // A lost write only affects a future reload, which shows the gap-fill placeholder.
  }
}

export function readCachedEphemeralRows(
  storage: Storage,
  sessionId: string,
): readonly InspectorRow[] {
  try {
    const raw = storage.getItem(indexKey(sessionId));
    if (raw === null) {
      return [];
    }
    const known = JSON.parse(raw) as SlotKey[];
    const rows: InspectorRow[] = [];
    for (const slotKey of known) {
      const entryRaw = storage.getItem(rowKey(sessionId, slotKey));
      if (entryRaw === null) {
        continue;
      }
      const entry = JSON.parse(entryRaw) as { eventType: string };
      const [generationPart, sequencePart] = slotKey.split(":");
      const sandboxGeneration = Number(generationPart);
      const runtimeSequence = Number(sequencePart);
      rows.push({
        slotKey,
        sandboxGeneration,
        runtimeSequence,
        displayNumber: runtimeSequence + 1,
        sessionSequence: null,
        eventType: entry.eventType,
        durability: "ephemeral",
      });
    }
    return rows;
  } catch {
    return [];
  }
}
