import type { CommandType, ProtocolCommand, SessionView } from "@oncue/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  commitEvent,
  commitEvents,
  dropLive,
  emptyStore,
  liveEvent,
  resumeFrom,
  type SessionStore,
} from "./event-store";
import { backoffDelay, type ConnectionState, parseFrame, socketUrl } from "./transport";

/**
 * The fields a caller chooses for a command. The envelope fields are excluded;
 * the object takes `issuedByUserId` from the authenticated connection, never
 * the wire, so a caller cannot claim an identity.
 */
export type OutgoingCommand<T extends CommandType = CommandType> = Pick<
  Extract<ProtocolCommand, { readonly type: T }>,
  "commandId" | "runId" | "expected" | "payload"
> & { readonly type: T };

/** What became of a send: written to the socket, held for the next socket, or dropped. */
export type SendResult = "sent" | "queued" | "not_sent";

export type SendOptions = {
  /**
   * Hold the command while no socket is open and write it once one opens. Safe
   * because the object answers a repeated command id with its first answer.
   */
  readonly queue?: boolean;
  /** Called once the command is written to a socket, now or when a queued one is flushed. */
  readonly onSent?: () => void;
};

export type SessionConnection = {
  readonly view: SessionView;
  readonly connection: ConnectionState;
  /**
   * The control plane refused this session. "Not yours" and "does not exist"
   * look the same so session ids cannot be probed (record 05).
   */
  readonly denied: boolean;
  /**
   * Sends a command over the live socket. The result says whether it was
   * written, not whether it was admitted, which arrives later as
   * `command.acknowledged` or `command.rejected`. On `not_sent` the caller
   * keeps its idempotency id and retries.
   */
  readonly sendCommand: <T extends CommandType>(
    command: OutgoingCommand<T>,
    options?: SendOptions,
  ) => SendResult;
  /** Drops a queued command before it is written; false once it has left or was never queued. */
  readonly cancelQueued: (commandId: string) => boolean;
};

/** Close codes `worker/auth/authorize.ts` uses for a denied upgrade. */
const DENIAL_CLOSE_CODES = new Set([4401, 4403]);

/** A handshake that has not opened by now is abandoned and retried. */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long a socket must stay open before the backoff starts again from its
 * first step, so a server that accepts and then closes at once is not
 * reconnected to every half second.
 */
export const STABLE_AFTER_MS = 10_000;

/**
 * While the browser reports itself offline, a socket is still tried this
 * often, because `navigator.onLine` can be wrong (some VPNs and captive
 * networks) and the `online` event would then never come.
 */
export const OFFLINE_RETRY_MS = 8_000;

export type SocketFactory = (url: string) => WebSocket;

type Queued = { readonly command: OutgoingCommand; readonly onSent: (() => void) | undefined };

/**
 * Owns the socket and the store for one session. A reconnect resumes from the
 * last applied sequence and drops the transient buffer first, since the replay
 * carries everything durable. At most one socket is live: opening another
 * closes the last, and a socket that is no longer current is ignored.
 */
export function useSession(
  sessionId: string | null,
  options: { createSocket?: SocketFactory; origin?: string } = {},
): SessionConnection {
  const [store, setStore] = useState<SessionStore>(emptyStore);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [denied, setDenied] = useState(false);
  const storeRef = useRef(store);
  storeRef.current = store;
  // `sendCommand` runs outside the effect's closure, so it reads the socket from a ref.
  const socketRef = useRef<WebSocket | null>(null);
  // Commands waiting for the next open socket, in the order they were sent.
  const outbox = useRef(new Map<string, Queued>());

  // A ref, so an inline factory does not reopen the socket on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const write = useCallback(
    (socket: WebSocket, command: OutgoingCommand) => {
      socket.send(
        JSON.stringify({
          type: "command",
          command: {
            commandId: command.commandId,
            sessionId,
            runId: command.runId,
            issuedAt: new Date().toISOString(),
            expected: command.expected,
            type: command.type,
            payload: command.payload,
          },
        }),
      );
    },
    [sessionId],
  );

  useEffect(() => {
    if (sessionId === null) {
      return;
    }

    let attempt = 0;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let connectTimer: number | undefined;
    let stableTimer: number | undefined;
    let closed = false;
    const queued = outbox.current;
    queued.clear();
    setDenied(false);

    const base = optionsRef.current.origin ?? window.location.origin;

    function offline() {
      return typeof navigator !== "undefined" && navigator.onLine === false;
    }

    /** Detaches the current socket so nothing it does later reaches this hook, and closes it. */
    function retire() {
      window.clearTimeout(connectTimer);
      window.clearTimeout(stableTimer);
      const old = socket;
      socket = null;
      if (socketRef.current === old) {
        socketRef.current = null;
      }
      if (old !== null) {
        old.onopen = null;
        old.onmessage = null;
        old.onclose = null;
        old.onerror = null;
        old.close();
      }
    }

    /** The current socket failed or was abandoned: back off and try again. */
    function scheduleRetry() {
      retire();
      attempt += 1;
      setConnection(offline() ? "offline" : "reconnecting");
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(open, backoffDelay(attempt));
    }

    /** `tryOffline` opens a socket even while the browser says it is offline. */
    function open(tryOffline = false) {
      if (closed) {
        return;
      }
      retire();
      window.clearTimeout(retryTimer);
      if (offline() && !tryOffline) {
        setConnection("offline");
        retryTimer = window.setTimeout(() => open(true), OFFLINE_RETRY_MS);
        return;
      }

      // Replayed history supersedes anything buffered from the old stream.
      setStore((current) => dropLive(current));
      setConnection(offline() ? "offline" : attempt === 0 ? "connecting" : "reconnecting");

      const url = socketUrl(sessionId ?? "", resumeFrom(storeRef.current), base);
      const create = optionsRef.current.createSocket;
      const next = create ? create(url) : new WebSocket(url);
      socket = next;
      socketRef.current = next;

      connectTimer = window.setTimeout(() => {
        if (socket === next) {
          scheduleRetry();
        }
      }, CONNECT_TIMEOUT_MS);

      next.onopen = () => {
        if (socket !== next) {
          return;
        }
        window.clearTimeout(connectTimer);
        stableTimer = window.setTimeout(() => {
          attempt = 0;
        }, STABLE_AFTER_MS);
        // Held commands go first, in order, before anything sent from now on.
        const pending = [...queued.values()];
        queued.clear();
        for (const entry of pending) {
          write(next, entry.command);
          entry.onSent?.();
        }
      };

      next.onmessage = (event: MessageEvent) => {
        if (socket !== next || typeof event.data !== "string") {
          return;
        }
        const frame = parseFrame(event.data);
        switch (frame.kind) {
          case "replay":
            setStore((current) => commitEvents(current, frame.events));
            return;
          case "caught_up":
            setConnection("caught_up");
            return;
          case "committed":
            setStore((current) => commitEvent(current, frame.event));
            setConnection("live");
            return;
          case "live":
            setStore((current) => liveEvent(current, frame.event));
            setConnection("live");
            return;
          case "unknown":
            return;
        }
      };

      next.onclose = (event: CloseEvent) => {
        if (closed || socket !== next) {
          return;
        }
        // A refusal is final; retrying would loop forever.
        if (DENIAL_CLOSE_CODES.has(event.code)) {
          retire();
          setDenied(true);
          return;
        }
        scheduleRetry();
      };

      next.onerror = () => {
        if (socket === next) {
          scheduleRetry();
        }
      };
    }

    open();

    const onOnline = () => {
      attempt = 0;
      // A socket that is still open stays; anything else is replaced now
      // rather than at the end of its backoff.
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        return;
      }
      open();
    };
    const onOffline = () => setConnection("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      retire();
      queued.clear();
    };
  }, [sessionId, write]);

  const sendCommand = useCallback(
    <T extends CommandType>(command: OutgoingCommand<T>, options: SendOptions = {}): SendResult => {
      if (sessionId === null) {
        return "not_sent";
      }
      const socket = socketRef.current;
      // A socket mid-handshake or closing would silently drop the send.
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        write(socket, command as OutgoingCommand);
        options.onSent?.();
        return "sent";
      }
      if (options.queue === true) {
        outbox.current.set(command.commandId, {
          command: command as OutgoingCommand,
          onSent: options.onSent,
        });
        return "queued";
      }
      return "not_sent";
    },
    [sessionId, write],
  );

  const cancelQueued = useCallback(
    (commandId: string): boolean => outbox.current.delete(commandId),
    [],
  );

  return { view: store.view, connection, denied, sendCommand, cancelQueued };
}
