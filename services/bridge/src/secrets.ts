/**
 * Development secrets and the approval that can release one, on the bridge's
 * side (records 04, 08, and 09). Pure state that `agent.ts` drives. It holds
 * names only: a value passes through a `write_secrets` effect to the
 * interpreter, which hands it to the supervisor and the redactor, and is never
 * part of this state, a log line, or an event.
 *
 * A run pauses on OpenCode's permission gate, set to `ask` for `secret_request`
 * (holding the tool server's own response instead fails after exactly 60
 * seconds). The gate is not a boundary: anything the agent runs can answer it
 * on loopback, but a value arrives only when the session object sends it after
 * the user's click, and the tool's answer is built from what was written.
 * OpenCode leaves an aborted call's request pending and answers a late reply
 * 200 without running the tool, so a held call is rejected whenever its run
 * ends, and a 200 is never read as "the call ran".
 */

import type { ApprovalOutcome } from "./frames";
import { DEADLINE_GRACE_MS } from "./permissions";
import { isSecretName } from "./secret-names";

export const SECRET_TOOL_NAME = "secret_request";

/** OpenCode names a tool-server tool `<server>_<tool>`, and that name is its permission key. */
export function secretPermissionKey(serverName: string): string {
  return `${serverName}_${SECRET_TOOL_NAME}`;
}

export interface WaitingRequest {
  /** OpenCode's own id for the permission request, which a reply names. */
  readonly requestId: string;
  readonly callId: string;
  /** The bridge's reference for this request: what it sends as `approvalId`, and what `bridge.approval` echoes. */
  readonly ref: string;
  /** Null until the held call's tool part shows its input. */
  readonly name: string | null;
  /**
   * `approval.requested` has been sent. A named request not yet sent waits for
   * a permission card that is out: the object shows one card at a time.
   */
  readonly asked: boolean;
}

export interface PendingWrite {
  readonly grantId: string;
  readonly names: readonly string[];
  readonly requestRef: string | null;
}

export interface SecretsState {
  /** Names the supervisor has written in this process. */
  readonly supplied: readonly string[];
  readonly waiting: WaitingRequest | null;
  readonly writes: readonly PendingWrite[];
}

export const INITIAL_SECRETS: SecretsState = { supplied: [], waiting: null, writes: [] };

export type SecretsEffect =
  | {
      readonly kind: "emit_request";
      readonly ref: string;
      readonly name: string;
      readonly callId: string;
    }
  | {
      readonly kind: "reply_permission";
      readonly requestId: string;
      readonly reply: "once" | "reject";
      readonly message: string | null;
    }
  /** The only place a value appears. The interpreter performs it and keeps nothing but the redactor's copy. */
  | {
      readonly kind: "write_secrets";
      readonly grantId: string;
      readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
  | { readonly kind: "approval_timer"; readonly ref: string; readonly atMs: number }
  | { readonly kind: "ack"; readonly grantId: string; readonly accepted: boolean }
  | { readonly kind: "clear_secrets" }
  | { readonly kind: "log"; readonly line: string };

export interface SecretsStep {
  readonly state: SecretsState;
  readonly effects: readonly SecretsEffect[];
}

function reject(requestId: string, message: string): SecretsEffect {
  return { kind: "reply_permission", requestId, reply: "reject", message };
}

const UNCHANGED = (state: SecretsState): SecretsStep => ({ state, effects: [] });

export interface AskedContext {
  readonly permissionKey: string;
  readonly runActive: boolean;
  readonly newRef: () => string;
}

/** OpenCode is holding a tool call. Nothing is sent yet: the permission event does not carry the call's input. */
export function onPermissionAsked(
  state: SecretsState,
  asked: { readonly requestId: string; readonly permission: string; readonly callId: string },
  ctx: AskedContext,
): SecretsStep {
  if (asked.permission !== ctx.permissionKey) {
    // Nothing else is set to `ask`, so this is a config OnCue did not write.
    return {
      state,
      effects: [reject(asked.requestId, "OnCue does not answer this kind of request.")],
    };
  }
  if (!ctx.runActive) {
    return { state, effects: [reject(asked.requestId, "No run is active.")] };
  }
  if (state.waiting !== null) {
    return {
      state,
      effects: [reject(asked.requestId, "Another secret request is waiting for the user.")],
    };
  }
  return {
    state: {
      ...state,
      waiting: {
        requestId: asked.requestId,
        callId: asked.callId,
        ref: ctx.newRef(),
        name: null,
        asked: false,
      },
    },
    effects: [],
  };
}

/**
 * The held call's tool part. It goes `running` with its full input while
 * OpenCode still holds it. `blocked` is a permission card out: the request is
 * kept, named, and sent by `pump` once that card is answered.
 */
export function onToolPart(
  state: SecretsState,
  part: {
    readonly callId: string;
    readonly status: string;
    readonly input: Readonly<Record<string, unknown>>;
  },
  blocked = false,
): SecretsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.callId !== part.callId) {
    return UNCHANGED(state);
  }
  if (part.status === "completed" || part.status === "error") {
    // The call ended some other way (an abort, a reply that was not ours).
    return { state: { ...state, waiting: null }, effects: [] };
  }
  if (part.status !== "running" || waiting.asked) {
    return UNCHANGED(state);
  }
  const name = part.input.name;
  if (typeof name !== "string" || !isSecretName(name)) {
    return {
      state: { ...state, waiting: null },
      effects: [
        reject(
          waiting.requestId,
          "That is not a secret's name. Names are capital letters, digits, and underscores.",
        ),
      ],
    };
  }
  if (state.supplied.includes(name)) {
    // Already written here: the tool only says where. No authority is involved.
    return {
      state: { ...state, waiting: null },
      effects: [
        { kind: "reply_permission", requestId: waiting.requestId, reply: "once", message: null },
      ],
    };
  }
  return pump({ ...state, waiting: { ...waiting, name } }, blocked);
}

/** Sends a named request held back while another card was out. */
export function pump(state: SecretsState, blocked: boolean): SecretsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.name === null || waiting.asked || blocked) {
    return UNCHANGED(state);
  }
  return {
    state: { ...state, waiting: { ...waiting, asked: true } },
    effects: [
      { kind: "emit_request", ref: waiting.ref, name: waiting.name, callId: waiting.callId },
    ],
  };
}

/** Whether a named request is waiting to be sent, which takes the next turn for a card. */
export function hasUnsentRequest(state: SecretsState): boolean {
  return state.waiting !== null && state.waiting.name !== null && !state.waiting.asked;
}

/**
 * The harness settled a request (OpenCode's `permission.replied`, or a reject
 * it spread to every pending ask). One never sent is forgotten; one whose card
 * is out stays for its answer, and that late reply finds nothing to release.
 * `except` settles every request but the one it names: a reject the harness spread.
 */
export function onRequestSettled(
  state: SecretsState,
  settled: { readonly requestId: string } | { readonly except: string },
): SecretsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.asked) {
    return UNCHANGED(state);
  }
  const matches =
    "requestId" in settled
      ? waiting.requestId === settled.requestId
      : waiting.requestId !== settled.except;
  return matches ? { state: { ...state, waiting: null }, effects: [] } : UNCHANGED(state);
}

const OUTCOME_WORDS: Readonly<Record<Exclude<ApprovalOutcome, "pending" | "allowed">, string>> = {
  refused:
    "OnCue does not offer that here: the project does not declare it as an optional secret, no value is saved for it, or it was already answered.",
  denied: "The user denied this request. Continue without the secret.",
  expired: "Nobody answered before the request expired. Continue without the secret.",
  unavailable:
    "The user approved, but the saved value could not be read. Continue without it and ask the user to save it again.",
};

/** What the session object says became of the request. */
export function onApprovalFrame(
  state: SecretsState,
  frame: {
    readonly requestRef: string;
    readonly outcome: ApprovalOutcome;
    readonly expiresAt: string | null;
  },
): SecretsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.ref !== frame.requestRef) {
    return { state, effects: [{ kind: "log", line: "an approval frame for no waiting request" }] };
  }
  if (frame.outcome === "pending") {
    // The object's clock decides; this timer only ends the held call on time
    // when the socket is down and no frame can say so.
    return {
      state,
      effects: [
        {
          kind: "approval_timer",
          ref: waiting.ref,
          atMs: Date.parse(frame.expiresAt as string) + DEADLINE_GRACE_MS,
        },
      ],
    };
  }
  // `allowed` is never sent for a secret; if it were, it releases nothing.
  const words = OUTCOME_WORDS[frame.outcome === "allowed" ? "refused" : frame.outcome];
  return {
    state: { ...state, waiting: null },
    effects: [reject(waiting.requestId, words)],
  };
}

export function onApprovalDeadline(state: SecretsState, ref: string): SecretsStep {
  const waiting = state.waiting;
  if (waiting === null || waiting.ref !== ref) {
    return UNCHANGED(state);
  }
  return {
    state: { ...state, waiting: null },
    effects: [reject(waiting.requestId, OUTCOME_WORDS.expired)],
  };
}

export function onSecretGrant(
  state: SecretsState,
  grant: {
    readonly grantId: string;
    readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly requestRef: string | null;
  },
): SecretsStep {
  return {
    state: {
      ...state,
      writes: [
        ...state.writes,
        {
          grantId: grant.grantId,
          names: grant.secrets.map((secret) => secret.name),
          requestRef: grant.requestRef,
        },
      ],
    },
    effects: [{ kind: "write_secrets", grantId: grant.grantId, secrets: grant.secrets }],
  };
}

/**
 * The supervisor answered. The grant is acknowledged only now, so the object's
 * "supplied" means the file is there, and a held call is released only after
 * the value it waited for is in place.
 */
export function onSecretsWritten(
  state: SecretsState,
  grantId: string,
  failedNames: readonly string[],
): SecretsStep {
  const write = state.writes.find((candidate) => candidate.grantId === grantId);
  if (write === undefined) {
    return { state, effects: [{ kind: "log", line: "secrets written for a grant nobody sent" }] };
  }
  const written = write.names.filter((name) => !failedNames.includes(name));
  const supplied = [...state.supplied, ...written.filter((name) => !state.supplied.includes(name))];
  const accepted = failedNames.length === 0;
  const effects: SecretsEffect[] = [{ kind: "ack", grantId, accepted }];
  const waiting = state.waiting;
  const releases = waiting !== null && waiting.ref === write.requestRef;
  if (releases) {
    effects.push(
      accepted
        ? { kind: "reply_permission", requestId: waiting.requestId, reply: "once", message: null }
        : reject(waiting.requestId, "The secret could not be put in place. Continue without it."),
    );
  }
  return {
    state: {
      supplied,
      waiting: releases ? null : waiting,
      writes: state.writes.filter((candidate) => candidate.grantId !== grantId),
    },
    effects,
  };
}

/** A run that ends takes its held call with it: OpenCode does not clear an aborted call's request itself. */
export function onRunEnded(state: SecretsState): SecretsStep {
  if (state.waiting === null) {
    return UNCHANGED(state);
  }
  return {
    state: { ...state, waiting: null },
    effects: [reject(state.waiting.requestId, "The run ended before this was answered.")],
  };
}

/** The secrets go with the runtime. Nothing is asked of the supervisor when nothing was ever sent. */
export function onShutdown(state: SecretsState): SecretsStep {
  const ended = onRunEnded(state);
  const held = state.supplied.length > 0 || state.writes.length > 0;
  return {
    state: INITIAL_SECRETS,
    effects: held ? [...ended.effects, { kind: "clear_secrets" }] : ended.effects,
  };
}

/**
 * What the tool tells the model once its call runs. Built from what was
 * written, never from who let the call through, so answering the permission
 * request by hand gets the agent nothing.
 */
export function secretToolAnswer(
  state: SecretsState,
  name: string,
  pathOf: (name: string) => string,
): { readonly text: string; readonly isError: boolean } {
  if (!state.supplied.includes(name)) {
    return {
      isError: true,
      text: "That secret has not been supplied to this session. Continue without it, and tell the user what could not be done.",
    };
  }
  return {
    isError: false,
    text: `${name} is available. Read it from the file ${pathOf(name)}, and do not print it or write it into the repository. The repository's checks also receive it as the environment variable ${name}.`,
  };
}
