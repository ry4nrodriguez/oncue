/**
 * The harness's own permission asks (record 09, "Agent permissions"): a read
 * outside the project, a secret file, a repeated action, or anything else its
 * gate holds. Pure state that `agent.ts` drives. The bridge decides nothing:
 * it forwards one ask at a time to the session object as `approval.requested`
 * and answers the harness `once` or `reject` from the object's frame. It never
 * answers `always`, because OnCue keeps the saved rules.
 *
 * The harness gate is cooperative, not a boundary: anything the agent runs can
 * answer it on loopback. What these answers protect is the agent's own choice
 * of what to touch; the sandbox's Unix users are the boundary (record 02).
 */

import type { PermissionCategory } from "@oncue/protocol";
import type { ApprovalOutcome } from "./frames";
import type { ToolCategory } from "./runtime";

/** What an adapter made of one ask, in OnCue's words. Never a command's text. */
export interface ClassifiedAsk {
  readonly category: PermissionCategory;
  /**
   * The tool, path, or paths the ask is about, whole. The interpreter cuts it
   * to `RESOURCE_MAX_CHARS` after redaction, so a secret straddling the cut
   * is still caught.
   */
  readonly resource: string;
  /** The kind of tool that asked, when the bridge knows it; the card's verb. */
  readonly toolCategory: ToolCategory | null;
}

/** The protocol's short text is 256 characters; a path past this is cut in the middle. */
export const RESOURCE_MAX_CHARS = 200;

/** Asks held at once. Past this an ask is refused at once rather than queued without bound. */
export const MAX_HELD_ASKS = 16;

/**
 * How long past a card's expiry the bridge waits before ending the held call
 * itself. The object's clock decides; this only covers a frame that never
 * comes, so it must not beat the object's own expiry or a late click.
 */
export const DEADLINE_GRACE_MS = 45_000;

export interface HeldAsk {
  /** The harness's own id for the request, which a reply names. */
  readonly requestId: string;
  /** The bridge's reference: what it sends as `approvalId`, and what `bridge.approval` echoes. */
  readonly ref: string;
  readonly callId: string | null;
  readonly ask: ClassifiedAsk;
  /** The subagent whose call is held (record 12); absent for the primary agent's. */
  readonly agentId?: string;
  /**
   * The bridge refuses this ask itself, with these words, once it reaches the
   * head: never forwarded. Where the harness spreads a reject to every other
   * pending ask, a refusal sent while others wait would refuse them too.
   */
  readonly refusal?: string;
  /** `approval.requested` has been sent; only the first held ask is ever forwarded. */
  readonly forwarded: boolean;
}

export interface PermissionsState {
  /** In arrival order. Only the head is ever forwarded, so the object sees one at a time. */
  readonly held: readonly HeldAsk[];
}

export const INITIAL_PERMISSIONS: PermissionsState = { held: [] };

export type PermissionsEffect =
  | {
      readonly kind: "emit_ask";
      readonly ref: string;
      readonly ask: ClassifiedAsk;
      readonly callId: string | null;
      readonly agentId?: string;
    }
  | {
      readonly kind: "reply_permission";
      readonly requestId: string;
      readonly reply: "once" | "reject";
      readonly message: string | null;
    }
  | { readonly kind: "approval_timer"; readonly ref: string; readonly atMs: number }
  | { readonly kind: "log"; readonly line: string };

export interface PermissionsStep {
  readonly state: PermissionsState;
  readonly effects: readonly PermissionsEffect[];
}

/** What the model is told when its call is not let through. It names what to do next. */
export function refusalWords(outcome: Exclude<ApprovalOutcome, "pending" | "allowed">): string {
  switch (outcome) {
    case "denied":
      return "The user denied this. Do not try to reach it another way. Continue without it, or ask the user.";
    case "expired":
      return "Nobody answered within ten minutes, so this was denied. Continue without it, or ask the user.";
    case "refused":
    case "unavailable":
      return "OnCue did not allow this request. Continue without it, or ask the user.";
  }
}

function reject(requestId: string, message: string): PermissionsEffect {
  return { kind: "reply_permission", requestId, reply: "reject", message };
}

/**
 * Forwards the first held ask when none is out and nothing else holds the
 * user's attention. `blocked` is a secret card waiting: the object shows one
 * card at a time.
 */
export function pump(state: PermissionsState, blocked: boolean): PermissionsStep {
  const head = state.held[0];
  if (head === undefined || head.forwarded || blocked) {
    return { state, effects: [] };
  }
  if (head.refusal !== undefined) {
    // Only a harness that spreads a reject queues a refusal, so the asks
    // behind it are settled by the same reject.
    return { state: INITIAL_PERMISSIONS, effects: [reject(head.requestId, head.refusal)] };
  }
  return {
    state: { held: [{ ...head, forwarded: true }, ...state.held.slice(1)] },
    effects: [
      {
        kind: "emit_ask",
        ref: head.ref,
        ask: head.ask,
        callId: head.callId,
        ...(head.agentId === undefined ? {} : { agentId: head.agentId }),
      },
    ],
  };
}

export interface AskContext {
  readonly runActive: boolean;
  readonly newRef: () => string;
  readonly blocked: boolean;
  /** The harness rejects every other pending ask of the session along with one it is told to reject. */
  readonly cascade?: boolean;
}

/** The asks the harness has settled after a reject: only one already forwarded stays, for its frame. */
export function dropUnsent(state: PermissionsState): PermissionsState {
  const head = state.held[0];
  return { held: head?.forwarded === true ? [head] : [] };
}

/** The harness is holding a call. It is forwarded now, or queued behind the one already out. */
export function onAsk(
  state: PermissionsState,
  asked: {
    readonly requestId: string;
    readonly callId: string | null;
    readonly ask: ClassifiedAsk;
    readonly agentId?: string;
    /** Refused by the bridge, in turn (`HeldAsk.refusal`); never forwarded. */
    readonly refusal?: string;
  },
  ctx: AskContext,
): PermissionsStep {
  if (!ctx.runActive) {
    return { state, effects: [reject(asked.requestId, "No run is active.")] };
  }
  if (state.held.some((held) => held.requestId === asked.requestId)) {
    // A redelivered event for a request already held.
    return { state, effects: [] };
  }
  if (state.held.length >= MAX_HELD_ASKS) {
    return {
      state: ctx.cascade === true ? dropUnsent(state) : state,
      effects: [
        reject(asked.requestId, "Too many requests are waiting for the user. Try again later."),
      ],
    };
  }
  const queued: PermissionsState = {
    held: [
      ...state.held,
      {
        requestId: asked.requestId,
        ref: ctx.newRef(),
        callId: asked.callId,
        ask: asked.ask,
        ...(asked.agentId === undefined ? {} : { agentId: asked.agentId }),
        ...(asked.refusal === undefined ? {} : { refusal: asked.refusal }),
        forwarded: false,
      },
    ],
  };
  return pump(queued, ctx.blocked);
}

/** Whether this frame answers the ask this module has out. */
export function ownsRef(state: PermissionsState, ref: string): boolean {
  const head = state.held[0];
  return head?.forwarded === true && head.ref === ref;
}

/**
 * What the session object decided. The next held ask goes out once this one
 * is answered, unless the answer was a reject the harness spreads to every
 * other ask (`cascade`): those are settled already and are not forwarded.
 */
export function onApprovalFrame(
  state: PermissionsState,
  frame: {
    readonly requestRef: string;
    readonly outcome: ApprovalOutcome;
    readonly expiresAt: string | null;
  },
  blocked: boolean,
  cascade = false,
): PermissionsStep {
  const head = state.held[0];
  if (head === undefined || !head.forwarded || head.ref !== frame.requestRef) {
    return { state, effects: [{ kind: "log", line: "an approval frame for no held ask" }] };
  }
  if (frame.outcome === "pending") {
    // The object's clock decides; this timer only ends the held call on time
    // when the socket is down and no frame can say so.
    return {
      state,
      effects: [
        {
          kind: "approval_timer",
          ref: head.ref,
          atMs: Date.parse(frame.expiresAt as string) + DEADLINE_GRACE_MS,
        },
      ],
    };
  }
  if (frame.outcome === "allowed") {
    const next = pump({ held: state.held.slice(1) }, blocked);
    return {
      state: next.state,
      effects: [
        { kind: "reply_permission", requestId: head.requestId, reply: "once", message: null },
        ...next.effects,
      ],
    };
  }
  return afterReject(state, reject(head.requestId, refusalWords(frame.outcome)), blocked, cascade);
}

function afterReject(
  state: PermissionsState,
  answer: PermissionsEffect,
  blocked: boolean,
  cascade: boolean,
): PermissionsStep {
  if (cascade) {
    return { state: INITIAL_PERMISSIONS, effects: [answer] };
  }
  const next = pump({ held: state.held.slice(1) }, blocked);
  return { state: next.state, effects: [answer, ...next.effects] };
}

/**
 * The card's expiry and the grace after it passed with no frame to say so
 * (the socket was down, or an answer was lost): the call is denied, as the
 * object will have done.
 */
export function onApprovalDeadline(
  state: PermissionsState,
  ref: string,
  blocked: boolean,
  cascade = false,
): PermissionsStep {
  const head = state.held[0];
  if (head === undefined || !head.forwarded || head.ref !== ref) {
    return { state, effects: [] };
  }
  return afterReject(state, reject(head.requestId, refusalWords("expired")), blocked, cascade);
}

/**
 * The harness says a request was answered (OpenCode's `permission.replied`),
 * by the bridge, by a reject it spread, or by something inside the sandbox.
 * One not yet forwarded is dropped; the one out stays until its frame, so
 * the object still sees one at a time, and its late reply finds nothing.
 */
export function onRequestSettled(
  state: PermissionsState,
  requestId: string,
  blocked: boolean,
): PermissionsStep {
  const index = state.held.findIndex((held) => held.requestId === requestId);
  if (index === -1 || (state.held[index] as HeldAsk).forwarded) {
    return { state, effects: [] };
  }
  return pump({ held: state.held.filter((_, at) => at !== index) }, blocked);
}

/**
 * A held call ended some other way (an abort, or a reply from inside the
 * sandbox). It is forgotten; the object's card, if any, expires on its clock.
 */
export function onCallSettled(
  state: PermissionsState,
  callId: string,
  blocked: boolean,
): PermissionsStep {
  const index = state.held.findIndex((held) => held.callId === callId);
  if (index === -1) {
    return { state, effects: [] };
  }
  const removed = state.held[index] as HeldAsk;
  // A forwarded ask stays the head until its frame arrives, so the object
  // still sees one at a time, but it no longer follows a call; one never sent
  // is simply dropped.
  if (removed.forwarded) {
    return {
      state: {
        held: state.held.map((held, at) => (at === index ? { ...held, callId: null } : held)),
      },
      effects: [],
    };
  }
  return pump({ held: state.held.filter((_, at) => at !== index) }, blocked);
}

/** A run that ends takes every held call with it: the harness does not clear an aborted call's request itself. */
export function onRunEnded(state: PermissionsState): PermissionsStep {
  if (state.held.length === 0) {
    return { state, effects: [] };
  }
  return {
    state: INITIAL_PERMISSIONS,
    effects: state.held.map((held) =>
      reject(held.requestId, "The run ended before this was answered."),
    ),
  };
}

/** Cuts a resource to fit the card, keeping both ends, which carry the most meaning. Run after redaction. */
export function boundResource(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= RESOURCE_MAX_CHARS) {
    return flat;
  }
  const keep = Math.floor((RESOURCE_MAX_CHARS - 1) / 2);
  return `${flat.slice(0, keep)}…${flat.slice(flat.length - keep)}`;
}
