/**
 * What a session says when its model stops it (record 15): the failure in
 * plain words and the way forward for the state the key and the sandbox are
 * in. The rail, the note under the composer, and the timeline's pause row all
 * read these, so they cannot disagree.
 */
import type { PayloadOf, RunView } from "@oncue/protocol";
import { MODEL_FAILURE_WORDS } from "./status";

export type ModelFailure = NonNullable<PayloadOf<"run.paused">["modelFailure"]>;

/**
 * Where a run's model connection stands. `replaceable` is a key that stopped
 * working: replacing it keeps the connection, so the run can continue.
 * `gone` is a connection that was revoked or deleted, which nothing brings
 * back, so the work moves to a new session.
 */
export type RunConnectionState = "active" | "replaceable" | "gone";

type ConnectionRef = { readonly modelConnectionId: string };

/** A run with no model record (the first frames of a session) reads as active: nothing is known to be wrong. */
export function runConnectionStateOf(
  connectionId: string | null,
  active: readonly ConnectionRef[],
  inactive: readonly ConnectionRef[],
): RunConnectionState {
  if (connectionId === null) {
    return "active";
  }
  const named = (connection: ConnectionRef) => connection.modelConnectionId === connectionId;
  return active.some(named) ? "active" : inactive.some(named) ? "replaceable" : "gone";
}

/**
 * The failure a run is stopped on, or null. Only while it is paused: a run
 * keeps its last pause after it resumes, and that pause is then history.
 */
export function pausedModelFailureOf(
  run: Pick<RunView, "state" | "pause"> | null,
): ModelFailure | null {
  if (run === null || run.state !== "paused" || run.pause?.reason !== "model_failure") {
    return null;
  }
  return run.pause.modelFailure ?? null;
}

/**
 * What stopped the run, as the category's plain words. The payload's own
 * `message` is the bridge's diagnostic ("broker answered 403: ...") and stays
 * in the event; it is not a sentence for the person reading the session.
 */
export function modelFailureSentence(failure: ModelFailure): string {
  return `Model request failed: ${MODEL_FAILURE_WORDS[failure.category]}.`;
}

/**
 * What to do about a key that is not active, when no model failure is on
 * screen to lead with: an ended run whose next message needs the key, or a
 * run stopped for another reason.
 */
export const KEY_GUIDANCE: Record<Exclude<RunConnectionState, "active">, string> = {
  replaceable:
    "The model key for this session has stopped working. Replace it under Settings, Model providers, then come back here to continue.",
  gone: "The model key for this session was removed. Add a working key under Settings, Model providers, then start a new session to continue the work.",
};

/**
 * One sentence whether or not the sandbox is still up: a rejected key's
 * sandbox may stop seconds after the pause, and the note must not change
 * under the reader for it. Back here with a working key, the note for an
 * active key says whether the run can continue yet.
 */
const REPLACE_THEN_CONTINUE =
  "Replace the key under Settings, Model providers, then come back here to continue the run.";
const KEY_REMOVED =
  "The key this run used has since been removed. Add a working key under Settings, Model providers, then start a new session to continue the work.";
const KEY_LISTED_ACTIVE =
  "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it.";
const CONTINUE_NOW = "Send a message to continue the run from its last checkpoint.";
const CONTINUE_LATER =
  "A message can't reach the run while its sandbox is still running. Stop the run to send a new message from here, or wait: once the sandbox stops, the run can continue from its last checkpoint.";

export interface ModelFailureNote {
  /** What stopped the run. */
  readonly failure: string;
  /** What the person can do now, or null while the key's state is not known. */
  readonly next: string | null;
  /** Whether the way forward is in Settings, Model providers. */
  readonly linksToKeys: boolean;
}

/**
 * The note for a run paused on a model failure. `connection` is null until
 * the key's state has been read after the pause; the note then names the
 * failure and promises nothing about a key it has not seen.
 */
export function modelFailureNote(input: {
  readonly failure: ModelFailure;
  readonly sandboxLive: boolean;
  readonly connection: RunConnectionState | null;
}): ModelFailureNote {
  const { failure, sandboxLive, connection } = input;
  const sentence = modelFailureSentence(failure);
  const rejected = failure.category === "authentication_failed";
  switch (connection) {
    case null:
      return { failure: sentence, next: null, linksToKeys: rejected };
    case "gone":
      return { failure: sentence, next: KEY_REMOVED, linksToKeys: true };
    case "replaceable":
      return { failure: sentence, next: REPLACE_THEN_CONTINUE, linksToKeys: true };
    case "active": {
      const forward = sandboxLive ? CONTINUE_LATER : CONTINUE_NOW;
      return {
        failure: sentence,
        // An active key after a rejection was either replaced since or never
        // marked, and nothing here tells which, so the note claims neither.
        next: rejected ? `${KEY_LISTED_ACTIVE} ${forward}` : forward,
        linksToKeys: rejected,
      };
    }
  }
}

/** The note as one line of text. */
export function modelFailureNoteText(note: ModelFailureNote): string {
  return note.next === null ? note.failure : `${note.failure} ${note.next}`;
}
