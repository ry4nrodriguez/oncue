// Cuts a client's missed history into bounded batches, then a caught-up
// marker (record 01). Each batch has a byte cap as well as a count cap, since
// 200 events at 256 KB would exceed the 32 MiB WebSocket message ceiling.
// Batches concatenate the stored `envelopeJson` so replay matches what was
// committed. Rows arrive in ascending `sessionSequence` order.

export interface StoredEventRow {
  readonly sessionSequence: number;
  readonly envelopeJson: string;
}

export interface ReplayLimits {
  readonly maxEventsPerBatch: number;
  readonly maxBytesPerBatch: number;
}

export const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
  maxEventsPerBatch: 200,
  maxBytesPerBatch: 512 * 1024,
};

export type ReplayFrame =
  | { readonly kind: "batch"; readonly json: string; readonly through: number }
  | { readonly kind: "caught_up"; readonly json: string; readonly through: number };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function batchFrame(rows: readonly StoredEventRow[]): ReplayFrame {
  const last = rows[rows.length - 1] as StoredEventRow;
  const events = rows.map((row) => row.envelopeJson).join(",");
  return {
    kind: "batch",
    json: `{"type":"replay_batch","through":${last.sessionSequence},"events":[${events}]}`,
    through: last.sessionSequence,
  };
}

function caughtUpFrame(through: number): ReplayFrame {
  return { kind: "caught_up", json: `{"type":"caught_up","through":${through}}`, through };
}

/** `afterSequence` is the caught-up marker's `through` when there is nothing to replay. */
export function planReplay(
  rows: readonly StoredEventRow[],
  limits: ReplayLimits,
  afterSequence: number,
): readonly ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  let pending: StoredEventRow[] = [];
  let pendingBytes = 0;

  for (const row of rows) {
    const rowBytes = byteLength(row.envelopeJson);
    const overCount = pending.length >= limits.maxEventsPerBatch;
    const overBytes = pending.length > 0 && pendingBytes + rowBytes > limits.maxBytesPerBatch;
    if (overCount || overBytes) {
      frames.push(batchFrame(pending));
      pending = [];
      pendingBytes = 0;
    }
    pending.push(row);
    pendingBytes += rowBytes;
  }
  if (pending.length > 0) {
    frames.push(batchFrame(pending));
  }
  const through =
    rows.length > 0 ? (rows[rows.length - 1] as StoredEventRow).sessionSequence : afterSequence;
  frames.push(caughtUpFrame(through));
  return frames;
}
