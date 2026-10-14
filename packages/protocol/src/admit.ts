/**
 * Event admission (record 04): delivery is at-least-once, so safety comes
 * from unique ids, monotonic sequences, gap detection with replay, and
 * sandbox-generation checks. `parseEvent` has already checked shape; this
 * decides only ordering and fencing, as one pure function shared by the
 * session object and the fixture checker. A gap is held for replay, never
 * skipped, because the session object never fabricates missing outcomes.
 */

export type InboundEnvelope = {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly runtimeSequence: number | null;
  readonly protocolVersion: number;
  readonly payload: unknown;
};

/** What the session currently accepts, already read by the caller. */
export interface SessionExpectations {
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  /** Highest runtimeSequence already committed for `sandboxGeneration`; null before the first sandbox-origin event of that generation. */
  readonly lastRuntimeSequence: number | null;
  readonly protocolVersion: number;
  /** Only `has` is asked, so a store can answer for one id rather than handing over every id it holds. */
  readonly knownEventIds: Pick<ReadonlySet<string>, "has">;
}

export type Admission =
  | { readonly kind: "accept" }
  | { readonly kind: "wrong_session"; readonly expected: string }
  | { readonly kind: "unsupported_version"; readonly expected: number }
  /** Any generation other than the current one. The session object also closes such connections (record 01). */
  | { readonly kind: "stale_generation"; readonly current: number }
  | { readonly kind: "duplicate_event" }
  | { readonly kind: "sequence_gap"; readonly expected: number; readonly received: number };

/**
 * The admission decision. Checks run in order (identity and version,
 * generation, duplication, then sequence gap) so a stale or duplicate event
 * is never also reported as a gap. Command idempotency lives in
 * `admitCommand`, because an acknowledgement and its completion event
 * legitimately share one command id.
 */
export function admitEvent(event: InboundEnvelope, expectations: SessionExpectations): Admission {
  if (event.sessionId !== expectations.sessionId) {
    return { kind: "wrong_session", expected: expectations.sessionId };
  }
  if (event.protocolVersion !== expectations.protocolVersion) {
    return { kind: "unsupported_version", expected: expectations.protocolVersion };
  }
  if (event.sandboxGeneration !== expectations.sandboxGeneration) {
    return { kind: "stale_generation", current: expectations.sandboxGeneration };
  }
  if (expectations.knownEventIds.has(event.eventId)) {
    return { kind: "duplicate_event" };
  }
  if (event.runtimeSequence !== null) {
    const expected =
      expectations.lastRuntimeSequence === null ? 0 : expectations.lastRuntimeSequence + 1;
    if (event.runtimeSequence > expected) {
      return { kind: "sequence_gap", expected, received: event.runtimeSequence };
    }
    if (event.runtimeSequence < expected) {
      // Under monotonic per-generation sequencing, an unknown eventId at a
      // passed slot cannot be legitimate, so it is treated as a resend.
      return { kind: "duplicate_event" };
    }
  }
  return { kind: "accept" };
}

/**
 * The cursor after accepting one event, so the session object can persist it
 * with the event in one transaction.
 */
export function advanceCursor(
  cursor: Pick<SessionExpectations, "lastRuntimeSequence">,
  accepted: Pick<InboundEnvelope, "runtimeSequence">,
): Pick<SessionExpectations, "lastRuntimeSequence"> {
  if (accepted.runtimeSequence === null) {
    return cursor;
  }
  return { lastRuntimeSequence: accepted.runtimeSequence };
}
