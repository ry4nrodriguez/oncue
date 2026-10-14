// Validates, admits, and redacts one frame from the bridge (record 01). Pure;
// the caller supplies the clock and the next session sequence, and turns
// `commit` into SQL and `live` into a broadcast.

import type {
  Admission,
  CommittedEvent,
  ProtocolEvent,
  ProtocolEventOf,
  Redactor,
} from "@oncue/protocol";
import { admitEvent, type EphemeralEventType, parseEventJson, specOf } from "@oncue/protocol";

export interface IngestContext {
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly lastRuntimeSequence: number | null;
  readonly protocolVersion: number;
  readonly knownEventIds: Pick<ReadonlySet<string>, "has">;
  readonly redactor: Redactor;
  readonly nextSessionSequence: number;
  readonly committedAt: string;
}

export type IngestRejectReason =
  | { readonly kind: "parse_failure"; readonly parseReason: string; readonly detail: string }
  | Exclude<Admission, { readonly kind: "accept" }>;

export type IngestOutcome =
  | { readonly kind: "reject"; readonly reason: IngestRejectReason }
  | {
      readonly kind: "live";
      readonly event: ProtocolEventOf<EphemeralEventType>;
      readonly envelopeJson: string;
    }
  | { readonly kind: "commit"; readonly event: CommittedEvent; readonly envelopeJson: string };

/** The caller stores and rebroadcasts `envelopeJson` verbatim. */
export function ingestFrame(raw: string, ctx: IngestContext): IngestOutcome {
  const parsed = parseEventJson(raw, "sandbox");
  if (!parsed.ok) {
    return {
      kind: "reject",
      reason: { kind: "parse_failure", parseReason: parsed.reason, detail: parsed.detail },
    };
  }
  const event: ProtocolEvent = parsed.value;
  const admission = admitEvent(
    {
      eventId: event.eventId,
      sessionId: event.sessionId,
      sandboxGeneration: event.sandboxGeneration,
      runtimeSequence: event.runtimeSequence,
      protocolVersion: event.protocolVersion,
      payload: event.payload,
    },
    {
      sessionId: ctx.sessionId,
      sandboxGeneration: ctx.sandboxGeneration,
      lastRuntimeSequence: ctx.lastRuntimeSequence,
      protocolVersion: ctx.protocolVersion,
      knownEventIds: ctx.knownEventIds,
    },
  );
  if (admission.kind !== "accept") {
    return { kind: "reject", reason: admission };
  }
  const spec = specOf(event.type);
  if (spec.durability === "ephemeral") {
    const redacted = ctx.redactor.redact(event as ProtocolEventOf<EphemeralEventType>);
    return { kind: "live", event: redacted, envelopeJson: JSON.stringify(redacted) };
  }
  const committed: CommittedEvent = {
    ...event,
    sessionSequence: ctx.nextSessionSequence,
    committedAt: ctx.committedAt,
  } as CommittedEvent;
  const redactedCommitted = ctx.redactor.redact(committed);
  return {
    kind: "commit",
    event: redactedCommitted,
    envelopeJson: JSON.stringify(redactedCommitted),
  };
}
