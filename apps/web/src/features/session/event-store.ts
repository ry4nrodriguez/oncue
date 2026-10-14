import {
  applyEvent,
  applyLiveEvent,
  type CommittedEvent,
  discardLive,
  type EphemeralEventType,
  emptyView,
  type ProtocolEventOf,
  type SessionView,
} from "@oncue/protocol";

/**
 * A thin binding around the protocol's fold (`view.ts`), which the Durable
 * Object shares, so ordering and deduplication rules live there, not here.
 */
export type SessionStore = {
  readonly view: SessionView;
};

export function emptyStore(): SessionStore {
  return { view: emptyView() };
}

/** Durable history. Ordering, deduplication and gap-filling belong to the fold. */
export function commitEvent(store: SessionStore, event: CommittedEvent): SessionStore {
  const view = applyEvent(store.view, event);
  return view === store.view ? store : { view };
}

export function commitEvents(store: SessionStore, events: Iterable<CommittedEvent>): SessionStore {
  let next = store;
  for (const event of events) {
    next = commitEvent(next, event);
  }
  return next;
}

/** Transient deltas. Never history, and discarded rather than reconciled. */
export function liveEvent(
  store: SessionStore,
  event: ProtocolEventOf<EphemeralEventType>,
): SessionStore {
  const view = applyLiveEvent(store.view, event);
  return view === store.view ? store : { view };
}

/** Called before replay; the replayed committed events carry everything durable. */
export function dropLive(store: SessionStore): SessionStore {
  const view = discardLive(store.view);
  return view === store.view ? store : { view };
}

/** The sequence to ask the server to replay from, or null when caught up. */
export function resumeFrom(store: SessionStore): number {
  return store.view.appliedThrough;
}
