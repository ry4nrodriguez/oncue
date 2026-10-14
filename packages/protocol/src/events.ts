import {
  type DurableEventType,
  EVENT_CATALOG,
  type EventCatalog,
  type EventType,
  type EventTypeIn,
  isEventType,
  type OriginOf,
  type ScopeOf,
} from "./catalog";
import type { EventFamily, EventOrigin } from "./define";
import {
  type CommitStamp,
  committedEnvelopeSchema,
  type Envelope,
  envelopeSchema,
  PROTOCOL_VERSION,
} from "./envelope";
import {
  type InferInput,
  type InferOutput,
  LIMITS,
  type ParseFailure,
  type ParseResult,
  safeParse,
  toFailure,
} from "./schema";

export type PayloadOf<T extends EventType> = InferOutput<EventCatalog[T]["payload"]>;
export type PayloadInputOf<T extends EventType> = InferInput<EventCatalog[T]["payload"]>;

export type ProtocolEventOf<T extends EventType> = T extends EventType
  ? Envelope<ScopeOf<T>, OriginOf<T>> & { readonly type: T; readonly payload: PayloadOf<T> }
  : never;
export type ProtocolEvent = ProtocolEventOf<EventType>;

export type CommittedEventOf<T extends DurableEventType> = ProtocolEventOf<T> & CommitStamp;
export type CommittedEvent = CommittedEventOf<DurableEventType>;

export type EventIn<F extends EventFamily> = ProtocolEventOf<EventTypeIn<F>>;

export function assertNever(value: never, context = "unhandled event type"): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

export function isEvent<T extends EventType>(
  event: ProtocolEvent,
  type: T,
): event is ProtocolEventOf<T> {
  return event.type === type;
}

// Which connection the bytes arrived on. A sandbox frame carrying a
// control-origin type is rejected here, which is how record 04's "the sandbox
// cannot approve its own protected actions" becomes a parse rule.
export type ParseSource = "sandbox" | "control" | "storage";

function originAllows(origin: EventOrigin, source: ParseSource): boolean {
  return source === "storage" || origin === "either" || origin === source;
}

type Checked = {
  readonly ok: true;
  readonly type: EventType;
  readonly payload: unknown;
};

function checkEnvelope(
  envelope: {
    readonly type: string;
    readonly runId: unknown;
    readonly runtimeSequence: unknown;
    readonly protocolVersion: number;
    readonly payload: unknown;
  },
  source: ParseSource,
): Checked | ParseFailure {
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return toFailure("unsupported_version", `protocolVersion: expected ${PROTOCOL_VERSION}`);
  }
  if (!isEventType(envelope.type)) {
    return toFailure("unknown_type", "type: not in catalog");
  }
  const spec = EVENT_CATALOG[envelope.type];
  if (!originAllows(spec.origin, source)) {
    return toFailure("wrong_origin", `type: ${envelope.type} is not emitted by ${source}`);
  }
  if (spec.scope === "run" && envelope.runId === null) {
    return toFailure("missing_run_id", `runId: required for ${envelope.type}`);
  }
  if (spec.scope === "session" && envelope.runId !== null) {
    return toFailure("unexpected_run_id", `runId: must be null for ${envelope.type}`);
  }
  const fromSandbox =
    spec.origin === "sandbox" || (spec.origin === "either" && source === "sandbox");
  const fromControl =
    spec.origin === "control" || (spec.origin === "either" && source === "control");
  if (fromSandbox && envelope.runtimeSequence === null) {
    return toFailure("missing_runtime_sequence", `runtimeSequence: required for ${envelope.type}`);
  }
  if (fromControl && envelope.runtimeSequence !== null) {
    return toFailure(
      "unexpected_runtime_sequence",
      `runtimeSequence: must be null for ${envelope.type}`,
    );
  }
  const payload = safeParse(spec.payload, envelope.payload);
  if (!payload.success) {
    return toFailure("payload", payload.issues, "payload");
  }
  return { ok: true, type: envelope.type, payload: payload.output };
}

export function parseEvent(input: unknown, source: ParseSource): ParseResult<ProtocolEvent> {
  const envelope = safeParse(envelopeSchema, input);
  if (!envelope.success) {
    return toFailure("envelope", envelope.issues);
  }
  const checked = checkEnvelope(envelope.output, source);
  if (!checked.ok) {
    return checked;
  }
  const { payload: _discarded, ...fields } = envelope.output;
  return {
    ok: true,
    value: { ...fields, type: checked.type, payload: checked.payload } as ProtocolEvent,
  };
}

export function parseEventJson(raw: string, source: ParseSource): ParseResult<ProtocolEvent> {
  if (raw.length > LIMITS.eventBytes) {
    return toFailure("too_large", `event: exceeds ${LIMITS.eventBytes} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return toFailure("malformed_json", "event: not valid JSON");
  }
  return parseEvent(decoded, source);
}

// Committed rows come from our own Durable Object, but the browser still
// parses: a stale client or a protocol upgrade mid-session must not fold a
// shape it cannot read. Ephemeral types never carry a session sequence.
export function parseCommittedEvent(input: unknown): ParseResult<CommittedEvent> {
  const envelope = safeParse(committedEnvelopeSchema, input);
  if (!envelope.success) {
    return toFailure("envelope", envelope.issues);
  }
  const checked = checkEnvelope(envelope.output, "storage");
  if (!checked.ok) {
    return checked;
  }
  if (EVENT_CATALOG[checked.type].durability === "ephemeral") {
    return toFailure("ephemeral", `type: ${checked.type} is never committed`);
  }
  const { payload: _discarded, ...fields } = envelope.output;
  return {
    ok: true,
    value: { ...fields, type: checked.type, payload: checked.payload } as CommittedEvent,
  };
}

export type BuildInput<T extends EventType> = {
  readonly eventId: string;
  readonly sessionId: string;
  readonly runId: ScopeOf<T> extends "run" ? string : null;
  readonly sandboxGeneration: number;
  readonly runtimeSequence: OriginOf<T> extends "sandbox"
    ? number
    : OriginOf<T> extends "control"
      ? null
      : number | null;
  readonly occurredAt: string;
  readonly payload: PayloadInputOf<T>;
};

// The one constructor. It runs the same parser the receiving side runs, so a
// bad payload fails in the emitting process with a named field rather than
// arriving at the Durable Object as an anonymous rejection.
export function buildEvent<T extends EventType>(type: T, input: BuildInput<T>): ProtocolEventOf<T> {
  const result = parseEvent({ ...input, type, protocolVersion: PROTOCOL_VERSION }, "storage");
  if (!result.ok) {
    throw new Error(`buildEvent(${type}) rejected: ${result.reason} ${result.detail}`);
  }
  return result.value as ProtocolEventOf<T>;
}
