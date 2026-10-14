import {
  type CommittedEvent,
  type EphemeralEventType,
  isEventType,
  type ProtocolEventOf,
  parseCommittedEvent,
  parseEvent,
  specOf,
} from "@oncue/protocol";

/**
 * The frames the Durable Object broadcasts (`worker/session/replay.ts`): a
 * replay batch, a caught-up marker, or a bare event, committed when it
 * carries a session sequence.
 */
export type Frame =
  | {
      readonly kind: "replay";
      readonly through: number;
      readonly events: readonly CommittedEvent[];
    }
  | { readonly kind: "caught_up"; readonly through: number }
  | { readonly kind: "committed"; readonly event: CommittedEvent }
  | { readonly kind: "live"; readonly event: ProtocolEventOf<EphemeralEventType> }
  | { readonly kind: "unknown" };

/** The five states record 13 requires the interface to distinguish. */
export const CONNECTION_STATES = [
  "connecting",
  "live",
  "reconnecting",
  "caught_up",
  "offline",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

function committedFrom(input: unknown): CommittedEvent | null {
  const parsed = parseCommittedEvent(input);
  return parsed.ok ? parsed.value : null;
}

/** Frames are untrusted: every event goes through the protocol parser, and failures are dropped. */
export function parseFrame(raw: string): Frame {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof data !== "object" || data === null) {
    return { kind: "unknown" };
  }

  const record = data as Record<string, unknown>;

  if (record.type === "replay_batch") {
    const through = typeof record.through === "number" ? record.through : 0;
    const list = Array.isArray(record.events) ? record.events : [];
    const events: CommittedEvent[] = [];
    for (const entry of list) {
      const committed = committedFrom(entry);
      if (committed !== null) {
        events.push(committed);
      }
    }
    return { kind: "replay", through, events };
  }

  if (record.type === "caught_up") {
    return { kind: "caught_up", through: typeof record.through === "number" ? record.through : 0 };
  }

  if (typeof record.type !== "string" || !isEventType(record.type)) {
    return { kind: "unknown" };
  }

  // A committed broadcast carries the sequence the Durable Object assigned;
  // an ephemeral one never does.
  if (typeof record.sessionSequence === "number") {
    const committed = committedFrom(data);
    return committed === null ? { kind: "unknown" } : { kind: "committed", event: committed };
  }

  // A durable type without a sequence is malformed and dropped.
  const spec = specOf(record.type);
  if (spec.durability !== "ephemeral") {
    return { kind: "unknown" };
  }
  const parsed = parseEvent(data, spec.origin);
  return parsed.ok
    ? { kind: "live", event: parsed.value as ProtocolEventOf<EphemeralEventType> }
    : { kind: "unknown" };
}

/** Reconnect backoff, capped so a long outage does not stop trying. */
export function backoffDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 8000);
}

export function socketUrl(sessionId: string, after: number, origin: string): string {
  const base = origin.replace(/^http/, "ws");
  return `${base}/ws/sessions/${encodeURIComponent(sessionId)}/client?after=${after}`;
}
