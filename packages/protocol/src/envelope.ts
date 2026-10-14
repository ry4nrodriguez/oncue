import type { EventOrigin, EventScope } from "./define";
import {
  counter,
  type EventId,
  eventId,
  type InferOutput,
  nullable,
  number,
  type RunId,
  runId,
  type SessionId,
  sessionId,
  strictObject,
  string,
  type Timestamp,
  timestamp,
  unknown,
} from "./schema";

// Bumped only for a breaking change. Record 04: additions use new event types.
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// Record 04 leaves runId's presence on non-run events unstated. It is derived
// from the catalog: a run-scoped type carries a RunId, a session-scoped type
// carries null. runtimeSequence likewise follows origin, because only the
// bridge assigns one.
export type RunIdFor<S extends EventScope> = S extends "run" ? RunId : null;
export type RuntimeSequenceFor<O extends EventOrigin> = O extends "sandbox"
  ? number
  : O extends "control"
    ? null
    : number | null;

export type Envelope<S extends EventScope, O extends EventOrigin> = {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly runId: RunIdFor<S>;
  readonly sandboxGeneration: number;
  readonly runtimeSequence: RuntimeSequenceFor<O>;
  readonly occurredAt: Timestamp;
  readonly protocolVersion: ProtocolVersion;
};

export const ENVELOPE_FIELDS = [
  "eventId",
  "sessionId",
  "runId",
  "sandboxGeneration",
  "runtimeSequence",
  "type",
  "occurredAt",
  "protocolVersion",
  "payload",
] as const;

export const envelopeSchema = strictObject({
  eventId,
  sessionId,
  runId: nullable(runId),
  sandboxGeneration: counter,
  runtimeSequence: nullable(counter),
  type: string(),
  occurredAt: timestamp,
  protocolVersion: number(),
  payload: unknown(),
});
export type WireEnvelope = InferOutput<typeof envelopeSchema>;

type EnvelopeFieldsMatchSchema = [
  Exclude<(typeof ENVELOPE_FIELDS)[number], keyof WireEnvelope> extends never ? true : never,
  Exclude<keyof WireEnvelope, (typeof ENVELOPE_FIELDS)[number]> extends never ? true : never,
];
export const ENVELOPE_FIELDS_MATCH_SCHEMA: EnvelopeFieldsMatchSchema = [true, true];

// Added by the Durable Object after validation. Clients order by
// sessionSequence; runtimeSequence explains sandbox ordering only.
export type CommitStamp = {
  readonly sessionSequence: number;
  readonly committedAt: Timestamp;
};

export const commitStampSchema = strictObject({
  sessionSequence: counter,
  committedAt: timestamp,
});

export const committedEnvelopeSchema = strictObject({
  ...envelopeSchema.entries,
  ...commitStampSchema.entries,
});
