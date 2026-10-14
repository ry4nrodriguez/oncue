/**
 * The bridge's wire protocol and connection state machine as pure functions,
 * with no file, environment, socket, or timer. Kept out of `main.ts` so the
 * Worker's tests can import the handshake and link functions through
 * `@oncue/bridge` and drive the real session object with them; `main.ts`
 * re-exports all of it.
 */

import {
  buildEvent,
  MODEL_SWITCH_CAPABILITY,
  NO_RUNTIME,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type ProtocolEventOf,
} from "@oncue/protocol";
import { type AckFrame, type FrameIdentity, parseSessionFrame, type SessionFrame } from "./frames";

export interface BridgeIdentity {
  readonly sessionId: string;
  readonly generation: number;
  /**
   * Generation-scoped, minted by the control plane, delivered as a file the
   * agent's Unix user cannot read. It authenticates this connection only, and
   * the object refuses it once a later generation exists.
   */
  readonly bootstrapCredential: string;
}

export interface BridgeConfig {
  readonly identity: BridgeIdentity;
  /** Origin only. The path is this module's to construct. */
  readonly controlPlaneOrigin: string;
  readonly protocolVersion: number;
  /** The commit `build.ts` stamped into the bundle; an unstamped build says so. */
  readonly bridgeVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly reconnectBaseDelayMs: number;
  /** No wait between attempts is longer than this, however long the outage. */
  readonly maxReconnectDelayMs: number;
  /**
   * How long one outage may last before the bridge gives up. An outage starts
   * when the last stable link ended (or the process started) and spans every
   * attempt and every short-lived link since.
   */
  readonly reconnectWindowMs: number;
  /** A link that negotiated and stayed up this long ends the outage before it. */
  readonly stableLinkMs: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 5_000;
/**
 * Long enough to ride out a Worker deploy, a Durable Object restart, or a
 * regional blip, and short enough that a sandbox whose control plane is gone
 * for good stops spending. The object's own idle stop ends a healthy session
 * long before a live bridge would need more.
 */
export const DEFAULT_RECONNECT_WINDOW_MS = 10 * 60_000;
export const DEFAULT_STABLE_LINK_MS = 30_000;
/**
 * Heartbeat ticks with nothing heard back, after the peer has once answered a
 * ping, before the link is treated as half-open and dropped: 30 to 45 seconds.
 */
export const LIVENESS_SILENT_TICKS = 2;
/** Heartbeat ticks after the welcome, with no pong yet, before saying so once. */
export const NO_PONG_NOTICE_TICKS = 4;
/** Heartbeat ticks an opened socket may wait for `bridge.welcome`. */
export const WELCOME_DEADLINE_TICKS = 2;
/** The object's close code for a superseded generation, before or after the handshake. */
export const STALE_GENERATION_CLOSE_CODE = 4000;
/** The object's close code for a credential it does not accept. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;
export const UNSTAMPED_BRIDGE_VERSION = "unstamped";

export function bridgeConfig(
  identity: BridgeIdentity,
  controlPlaneOrigin: string,
  overrides: Partial<Omit<BridgeConfig, "identity" | "controlPlaneOrigin">> = {},
): BridgeConfig {
  return {
    identity,
    controlPlaneOrigin,
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    bridgeVersion: overrides.bridgeVersion ?? UNSTAMPED_BRIDGE_VERSION,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    reconnectBaseDelayMs: overrides.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
    maxReconnectDelayMs: overrides.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    reconnectWindowMs: overrides.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS,
    stableLinkMs: overrides.stableLinkMs ?? DEFAULT_STABLE_LINK_MS,
  };
}

/**
 * The generation goes in the path and the credential in a header, never the
 * URL: a URL is the string most likely to be logged by a proxy, a client
 * library, or an error page.
 */
export function bridgeConnectUrl(config: BridgeConfig): string {
  const { sessionId, generation } = config.identity;
  return `${config.controlPlaneOrigin}/ws/bridge/${encodeURIComponent(sessionId)}/${generation}`;
}

export function bridgeConnectHeaders(config: BridgeConfig): Record<string, string> {
  return { authorization: `Bearer ${config.identity.bootstrapCredential}` };
}

export interface HelloFrame {
  readonly type: "bridge.hello";
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly sandboxGeneration: number;
}

export function helloFrame(config: BridgeConfig): HelloFrame {
  return {
    type: "bridge.hello",
    protocolVersion: config.protocolVersion,
    sessionId: config.identity.sessionId,
    sandboxGeneration: config.identity.generation,
  };
}

export interface HeartbeatFrame {
  readonly type: "bridge.heartbeat";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
}

export function heartbeatFrame(config: BridgeConfig): HeartbeatFrame {
  return {
    type: "bridge.heartbeat",
    sessionId: config.identity.sessionId,
    sandboxGeneration: config.identity.generation,
  };
}

/** What `runtime.connected` reports. `NO_RUNTIME` for both until `/global/health` has answered. */
export interface RuntimeIdentity {
  readonly runtimeName: string;
  readonly runtimeVersion: string;
}

const NO_RUNTIME_IDENTITY: RuntimeIdentity = {
  runtimeName: NO_RUNTIME,
  runtimeVersion: NO_RUNTIME,
};

/** What this bridge tells the session object it can do, on every `runtime.connected`. */
export const BRIDGE_CAPABILITIES: readonly string[] = [MODEL_SWITCH_CAPABILITY];

/**
 * The first event of every connection, sent once per accepted handshake and
 * never before `bridge.welcome`, so a refused bridge never claims to have
 * connected. `runtimeName` is `NO_RUNTIME` until `identity` names a real
 * runtime (a reconnect after it is up); `capabilities` are the bridge's own.
 *
 * `runtimeSequence` comes from the process-wide cursor, because the object
 * admits exactly the next sequence for the generation and a reconnect that
 * restarted at zero would be refused as a duplicate.
 */
export function runtimeConnectedEvent(
  config: BridgeConfig,
  runtimeSequence: number,
  eventId: string,
  occurredAt: string,
  identity: RuntimeIdentity = NO_RUNTIME_IDENTITY,
): ProtocolEventOf<"runtime.connected"> {
  return buildEvent("runtime.connected", {
    eventId,
    sessionId: config.identity.sessionId,
    runId: null,
    sandboxGeneration: config.identity.generation,
    runtimeSequence,
    occurredAt,
    payload: {
      bridgeVersion: config.bridgeVersion,
      runtimeName: identity.runtimeName,
      runtimeVersion: identity.runtimeVersion,
      protocolVersion: config.protocolVersion,
      capabilities: [...BRIDGE_CAPABILITIES],
    },
  });
}

export type RefusalReason =
  | "protocol_version"
  | "stale_generation"
  | "wrong_session"
  | "unauthorized"
  | "malformed_reply";

export type HandshakeReview =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly reason: RefusalReason };

interface WelcomeShape {
  readonly type: unknown;
  readonly protocolVersion: unknown;
  readonly sessionId: unknown;
  readonly sandboxGeneration: unknown;
}

function asObject(value: unknown): WelcomeShape | null {
  if (typeof value !== "object") {
    return null;
  }
  if (value === null) {
    return null;
  }
  return value as WelcomeShape;
}

/**
 * The bridge checks the version too: an image can outlive several control-plane
 * releases, and a mismatched bridge should stop and say why rather than send
 * events the object rejects one at a time.
 */
export function reviewHandshakeReply(config: BridgeConfig, raw: unknown): HandshakeReview {
  const reply = asObject(raw);
  if (reply === null) {
    return { kind: "refused", reason: "malformed_reply" };
  }
  if (reply.type !== "bridge.welcome") {
    return { kind: "refused", reason: "malformed_reply" };
  }
  if (reply.protocolVersion !== config.protocolVersion) {
    return { kind: "refused", reason: "protocol_version" };
  }
  if (reply.sessionId !== config.identity.sessionId) {
    return { kind: "refused", reason: "wrong_session" };
  }
  if (reply.sandboxGeneration !== config.identity.generation) {
    // A replacement generation started while this one was reconnecting;
    // `replaced` is terminal (record 11).
    return { kind: "refused", reason: "stale_generation" };
  }
  return { kind: "accepted" };
}

export type Incoming =
  | { readonly kind: "shutdown" }
  | { readonly kind: "frame"; readonly value: unknown };

/**
 * Only `runtime.shutdown` is read here, since it means the same thing at every
 * point in the connection; everything else is handed on as a value. Non-JSON
 * text becomes a `null` frame, which the handshake review refuses, so a
 * control plane answering with garbage cannot keep an un-negotiated bridge
 * connected.
 */
export function classifyIncoming(raw: string): Incoming {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "frame", value: null };
  }
  if (asObject(parsed)?.type === "runtime.shutdown") {
    return { kind: "shutdown" };
  }
  return { kind: "frame", value: parsed };
}

/**
 * A refusal the control plane will give again on the next attempt is not worth
 * another attempt. A dropped connection is.
 */
export function isWorthRetrying(reason: RefusalReason): boolean {
  return reason === "malformed_reply";
}

/**
 * Exponential from the base, capped at `maxReconnectDelayMs`, with equal
 * jitter: at least half the capped delay, plus a random share of the rest.
 * Every sandbox dials its own Durable Object, but a Worker deploy drops them
 * all at once, and the jitter keeps them from returning in step.
 */
export function reconnectDelayMs(config: BridgeConfig, attempt: number, unit: number): number {
  const ceiling = Math.min(
    config.maxReconnectDelayMs,
    config.reconnectBaseDelayMs * 2 ** Math.min(attempt, 30),
  );
  const share = Math.min(1, Math.max(0, unit));
  return Math.round(ceiling / 2 + (share * ceiling) / 2);
}

/** What the loop knows about a link once it ended. */
export interface LinkEnded {
  /** When the handshake was accepted; null for a link that never got that far. */
  readonly linkedUpAtMs: number | null;
  /**
   * When the peer was last heard from (a frame or a pong). A link that went
   * half-open was working only until then, not until its silence was noticed.
   * Defaults to `endedAtMs`.
   */
  readonly lastHeardAtMs?: number | null;
  readonly endedAtMs: number;
}

/**
 * The reconnect budget, per outage rather than per process. A link that
 * negotiated and stayed up `stableLinkMs` closes the outage before it, so a
 * sandbox survives any number of separate drops over its life; one outage
 * (attempts and short-lived links alike) is bounded by wall-clock time.
 */
export interface ReconnectPolicy {
  /** The wait before the next attempt, or null when this outage has outlasted the window. */
  next(ended: LinkEnded): number | null;
  /** Attempts made in the current outage. */
  readonly attempts: number;
}

export function createReconnectPolicy(
  config: BridgeConfig,
  startedAtMs: number,
  random: () => number,
): ReconnectPolicy {
  let outageStartedAtMs = startedAtMs;
  let attempts = 0;
  return {
    next({ linkedUpAtMs, lastHeardAtMs, endedAtMs }) {
      const workedUntil = lastHeardAtMs ?? endedAtMs;
      if (linkedUpAtMs !== null && workedUntil - linkedUpAtMs >= config.stableLinkMs) {
        outageStartedAtMs = workedUntil;
        attempts = 0;
      }
      attempts += 1;
      if (endedAtMs - outageStartedAtMs >= config.reconnectWindowMs) {
        return null;
      }
      return reconnectDelayMs(config, attempts - 1, random());
    },
    get attempts() {
      return attempts;
    },
  };
}

export interface BridgeLink {
  send(text: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  /** `code` is the WebSocket close code when the transport reports one. */
  onClose(listener: (code?: number) => void): void;
  /**
   * Drops the socket at once without the closing handshake, which a half-open
   * peer never answers. A link without it is closed instead.
   */
  terminate?(): void;
  /** A protocol-level ping; Cloudflare's runtime answers it without waking the object. */
  ping?(): void;
  onPong?(listener: () => void): void;
}

export interface BridgeIo {
  connect(url: string, headers: Record<string, string>): Promise<BridgeLink>;
  /** Returns the cancel function. Injected so cadence is asserted, not waited for. */
  startHeartbeat(intervalMs: number, tick: () => void): () => void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** A fresh event id. Injected so this module never touches a runtime's crypto. */
  newEventId(): string;
  /** The current time as an ISO timestamp. Injected for the same reason. */
  now(): string;
  /** A millisecond clock for the reconnect window. `Date.now` when not given. */
  nowMs?(): number;
  /** A number in [0, 1) for the reconnect jitter. `Math.random` when not given. */
  random?(): number;
}

export function clockOf(io: Pick<BridgeIo, "nowMs">): () => number {
  return () => io.nowMs?.() ?? Date.now();
}

export function randomOf(io: Pick<BridgeIo, "random">): () => number {
  return () => io.random?.() ?? Math.random();
}

/**
 * The runtime-sequence counter, one per process and shared by every link, so a
 * reconnect continues the count rather than restarting it.
 */
export interface SequenceCursor {
  next: number;
}

/**
 * An event minus everything the shell stamps; only `stampDraft` turns one into
 * a `ProtocolEvent`. Generic over the type so a payload for another event type
 * does not compile.
 */
export type Draft<T extends ProtocolEvent["type"] = ProtocolEvent["type"]> =
  T extends ProtocolEvent["type"]
    ? {
        readonly type: T;
        readonly runId: ProtocolEventOf<T>["runId"];
        readonly payload: ProtocolEventOf<T>["payload"];
      }
    : never;

/**
 * The one place a draft becomes a `ProtocolEvent`, advancing the same cursor
 * `runLink` uses for `runtime.connected`. Ephemeral drafts take a sequence slot
 * too, because the object's cursor advances on them, so a run of
 * `message.delta` frames must not look like a gap.
 */
export function stampDraft(
  config: BridgeConfig,
  cursor: SequenceCursor,
  io: Pick<BridgeIo, "newEventId" | "now">,
  draft: Draft,
): ProtocolEvent {
  const runtimeSequence = cursor.next;
  cursor.next += 1;
  // `BuildInput<T>` is not exported by `@oncue/protocol`, so its per-type
  // conditional cannot be re-derived here; `Draft` already forces `runId` and
  // `payload` to agree with `draft.type`.
  return buildEvent(draft.type, {
    eventId: io.newEventId(),
    sessionId: config.identity.sessionId,
    runId: draft.runId,
    sandboxGeneration: config.identity.generation,
    runtimeSequence,
    occurredAt: io.now(),
    payload: draft.payload,
  } as never) as ProtocolEvent;
}

export type LinkOutcome =
  | { readonly kind: "shutdown" }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | { readonly kind: "disconnected" };

/** What the runtime gets to do with a live link. Events are already stamped; acks are already built. */
export interface Outbound {
  sendEvent(event: ProtocolEvent): void;
  sendAck(frame: AckFrame): void;
}

/**
 * The connection machine's only knowledge of the runtime. `onLinkUp` is called
 * after `runtime.connected` is sent, so the reducer's first `emit` on a
 * reconnect takes the next sequence slot. The default handler discards frames.
 */
export interface SessionHandler {
  /**
   * For a handler that keeps an outbox: called once the welcome is accepted
   * and before `onLinkUp`, to send what it stamped while no link was up and
   * then the `runtime.connected` that `connected()` stamps, in sequence order.
   * The object admits only the next sequence, so a `runtime.connected` sent
   * ahead of older events would be refused as a gap. Without it, `runLink`
   * sends `runtime.connected` itself.
   */
  onWelcome?(outbound: Outbound, connected: () => ProtocolEvent): void;
  onLinkUp(outbound: Outbound): void;
  onLinkDown(): void;
  onFrame(frame: SessionFrame): void;
}

const NOOP_SESSION_HANDLER: SessionHandler = {
  onLinkUp() {},
  onLinkDown() {},
  onFrame() {},
};

function defaultRuntimeIdentity(): RuntimeIdentity {
  return NO_RUNTIME_IDENTITY;
}

export type BridgeExit =
  | { readonly kind: "shutdown" }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | { readonly kind: "exhausted"; readonly attempts: number };

/**
 * One connection, from hello to close. Resolves rather than throws: a link
 * ending is the normal case, and the loop above decides what it means.
 *
 * The heartbeat timer starts with the link and also keeps it honest. An
 * opened socket gets `WELCOME_DEADLINE_TICKS` to be welcomed. After that each
 * tick sends `bridge.heartbeat` and a protocol ping, and once the peer has
 * answered a ping, `LIVENESS_SILENT_TICKS` ticks with nothing heard at all
 * mean the link is half-open: it is dropped, and the loop reconnects. A peer
 * that never answers pings is never timed out, so a transport without them
 * behaves as before.
 */
export function runLink(
  config: BridgeConfig,
  io: BridgeIo,
  link: BridgeLink,
  cursor: SequenceCursor = { next: 0 },
  handler: SessionHandler = NOOP_SESSION_HANDLER,
  identity: () => RuntimeIdentity = defaultRuntimeIdentity,
): Promise<LinkOutcome> {
  return new Promise<LinkOutcome>((resolve) => {
    let settled = false;
    let stopTicker: (() => void) | null = null;
    let linkedUp = false;
    let negotiated = false;
    let answersPings = false;
    let silentTicks = 0;
    let ticksBeforeWelcome = 0;
    let ticksSinceWelcome = 0;
    const frameIdentity: FrameIdentity = {
      sessionId: config.identity.sessionId,
      generation: config.identity.generation,
    };

    function finish(outcome: LinkOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      if (stopTicker !== null) {
        stopTicker();
      }
      if (linkedUp) {
        handler.onLinkDown();
      }
      resolve(outcome);
    }

    function drop(why: string): void {
      io.log(`bridge dropped a link that stopped answering: ${why}`);
      finish({ kind: "disconnected" });
      if (link.terminate === undefined) {
        link.close();
      } else {
        link.terminate();
      }
    }

    link.onPong?.(() => {
      answersPings = true;
      silentTicks = 0;
    });

    link.onMessage((data) => {
      silentTicks = 0;
      const incoming = classifyIncoming(data);
      if (incoming.kind === "shutdown") {
        // Acknowledged by closing: the control plane owns the checkpoint and
        // artifacts, and the bridge stops producing work (record 02). Settled
        // first, because a link's `close` may report its own close at once.
        finish({ kind: "shutdown" });
        link.close();
        return;
      }
      if (negotiated) {
        // Identity is checked in `parseSessionFrame`, so a frame naming
        // another session or generation never reaches `onFrame`.
        const frame = parseSessionFrame(frameIdentity, incoming.value);
        if (frame !== null) {
          handler.onFrame(frame);
        }
        return;
      }
      const review = reviewHandshakeReply(config, incoming.value);
      if (review.kind === "refused") {
        io.log(`bridge refused the connection: ${review.reason}`);
        finish({ kind: "refused", reason: review.reason });
        link.close();
        return;
      }
      negotiated = true;
      io.log("bridge connected to the control plane");
      // Only after the handshake is accepted, so an unaccepted bridge never
      // sends a second frame. The connected event goes before anything new;
      // the heartbeat only says it is still true.
      const connected = (): ProtocolEvent => {
        const sequence = cursor.next;
        cursor.next += 1;
        return runtimeConnectedEvent(config, sequence, io.newEventId(), io.now(), identity());
      };
      const outbound: Outbound = {
        sendEvent: (event) => link.send(JSON.stringify(event)),
        sendAck: (frame) => link.send(JSON.stringify(frame)),
      };
      if (handler.onWelcome === undefined) {
        link.send(JSON.stringify(connected()));
      } else {
        handler.onWelcome(outbound, connected);
      }
      linkedUp = true;
      handler.onLinkUp(outbound);
    });

    link.onClose((code) => {
      // The object closes a superseded generation and a refused credential
      // with their own codes, before or after the handshake; both would be
      // given again on every attempt, so neither is worth one.
      if (code === STALE_GENERATION_CLOSE_CODE) {
        io.log("bridge refused the connection: stale_generation");
        finish({ kind: "refused", reason: "stale_generation" });
        return;
      }
      if (code === UNAUTHORIZED_CLOSE_CODE) {
        io.log("bridge refused the connection: unauthorized");
        finish({ kind: "refused", reason: "unauthorized" });
        return;
      }
      finish({ kind: "disconnected" });
    });

    stopTicker = io.startHeartbeat(config.heartbeatIntervalMs, () => {
      if (settled) {
        return;
      }
      if (!negotiated) {
        ticksBeforeWelcome += 1;
        if (ticksBeforeWelcome >= WELCOME_DEADLINE_TICKS) {
          drop("no welcome");
        }
        return;
      }
      if (answersPings && silentTicks >= LIVENESS_SILENT_TICKS) {
        drop("no answer to the last pings");
        return;
      }
      ticksSinceWelcome += 1;
      if (!answersPings && link.ping !== undefined && ticksSinceWelcome === NO_PONG_NOTICE_TICKS) {
        // Once per link, so whether the edge answers pings can be read from
        // the sandbox's output: without an answer the link is never timed out.
        io.log(
          "bridge: no ping has been answered on this link; a half-open link will not be noticed",
        );
      }
      silentTicks += 1;
      link.send(JSON.stringify(heartbeatFrame(config)));
      link.ping?.();
    });

    link.send(JSON.stringify(helloFrame(config)));
  });
}

/**
 * `link` with the moment the peer was last heard from recorded: any frame,
 * or a pong. The reconnect policy measures how long a link worked by it.
 */
export function heardLink(
  link: BridgeLink,
  nowMs: () => number,
): { readonly link: BridgeLink; lastHeardAtMs(): number | null } {
  let lastHeardAtMs: number | null = null;
  const heard = (): void => {
    lastHeardAtMs = nowMs();
  };
  return {
    link: {
      ...link,
      send: (text) => link.send(text),
      close: () => link.close(),
      onClose: (listener) => link.onClose(listener),
      ...(link.terminate === undefined ? {} : { terminate: () => link.terminate?.() }),
      ...(link.ping === undefined ? {} : { ping: () => link.ping?.() }),
      ...(link.onPong === undefined
        ? {}
        : {
            onPong: (listener: () => void) =>
              link.onPong?.(() => {
                heard();
                listener();
              }),
          }),
      onMessage: (listener) =>
        link.onMessage((data) => {
          heard();
          listener(data);
        }),
    },
    lastHeardAtMs: () => lastHeardAtMs,
  };
}

/**
 * `handler` with the moment of its `onLinkUp` recorded, which is what the
 * reconnect policy needs to tell a stable link from a short-lived one.
 */
export function timedHandler(
  handler: SessionHandler,
  nowMs: () => number,
): { readonly handler: SessionHandler; linkedUpAtMs(): number | null; reset(): void } {
  let linkedUpAtMs: number | null = null;
  return {
    handler: {
      ...(handler.onWelcome === undefined
        ? {}
        : {
            onWelcome: (outbound: Outbound, connected: () => ProtocolEvent) =>
              handler.onWelcome?.(outbound, connected),
          }),
      onLinkUp(outbound) {
        linkedUpAtMs = nowMs();
        handler.onLinkUp(outbound);
      },
      onLinkDown: () => handler.onLinkDown(),
      onFrame: (frame) => handler.onFrame(frame),
    },
    linkedUpAtMs: () => linkedUpAtMs,
    reset() {
      linkedUpAtMs = null;
    },
  };
}

/**
 * Connect, negotiate, heartbeat, reconnect, stop. The session and generation
 * are fixed for the life of the process, so a bridge cannot promote itself and
 * the object's stale-generation refusal can be trusted.
 */
export async function runBridge(config: BridgeConfig, io: BridgeIo): Promise<BridgeExit> {
  const url = bridgeConnectUrl(config);
  const headers = bridgeConnectHeaders(config);
  const cursor: SequenceCursor = { next: 0 };
  const nowMs = clockOf(io);
  const policy = createReconnectPolicy(config, nowMs(), randomOf(io));
  const timed = timedHandler(NOOP_SESSION_HANDLER, nowMs);

  // The sandbox's stdout reaches the timeline while the bridge starts. Never
  // log the URL or headers: one holds the bootstrap credential.
  io.log(
    `bridge ${config.bridgeVersion} starting for sandbox generation ${config.identity.generation}`,
  );
  for (;;) {
    io.log(`bridge connecting to the control plane, attempt ${policy.attempts + 1}`);
    timed.reset();
    let lastHeardAtMs: () => number | null = () => null;
    const outcome = await attemptLink(config, io, url, headers, cursor, timed.handler, (link) => {
      const heard = heardLink(link, nowMs);
      lastHeardAtMs = heard.lastHeardAtMs;
      return heard.link;
    });
    if (outcome.kind === "shutdown") {
      return { kind: "shutdown" };
    }
    if (outcome.kind === "refused" && !isWorthRetrying(outcome.reason)) {
      return { kind: "refused", reason: outcome.reason };
    }
    const delay = policy.next({
      linkedUpAtMs: timed.linkedUpAtMs(),
      lastHeardAtMs: lastHeardAtMs(),
      endedAtMs: nowMs(),
    });
    if (delay === null) {
      return { kind: "exhausted", attempts: policy.attempts };
    }
    await io.sleep(delay);
  }
}

async function attemptLink(
  config: BridgeConfig,
  io: BridgeIo,
  url: string,
  headers: Record<string, string>,
  cursor: SequenceCursor,
  handler: SessionHandler,
  wrap: (link: BridgeLink) => BridgeLink,
): Promise<LinkOutcome> {
  try {
    const link = wrap(await io.connect(url, headers));
    return await runLink(config, io, link, cursor, handler);
  } catch {
    // A connect that never opened is treated as one that dropped. The error is
    // not logged: it can carry the request headers, including the bootstrap
    // credential.
    io.log("bridge could not reach the control plane");
    return { kind: "disconnected" };
  }
}
