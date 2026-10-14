import { makeCommittedEvent, makeEvent } from "@oncue/protocol/testing";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingCommand } from "./use-session";
import { CONNECT_TIMEOUT_MS, OFFLINE_RETRY_MS, STABLE_AFTER_MS, useSession } from "./use-session";

/** Enough of a WebSocket to drive the hook without a network. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  // Starts CONNECTING like a real socket, so tests that never call `open()`
  // prove `sendCommand` refuses an unopened socket.
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.all.push(this);
  }

  open() {
    this.readyState = WebSocket.OPEN;
    act(() => {
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  deliver(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    });
  }

  hangUp(code: number) {
    this.readyState = WebSocket.CLOSED;
    act(() => {
      this.onclose?.({ code } as CloseEvent);
    });
  }

  fail() {
    act(() => {
      this.onerror?.();
    });
  }
}

function Probe({
  sessionId,
  onReady,
}: {
  sessionId: string;
  onReady?: (session: ReturnType<typeof useSession>) => void;
}) {
  const session = useSession(sessionId, {
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    origin: "https://app.test",
  });
  onReady?.(session);
  const { view, connection, denied } = session;
  return (
    <div>
      <span data-testid="connection">{connection}</span>
      <span data-testid="applied">{view.appliedThrough}</span>
      <span data-testid="denied">{String(denied)}</span>
      <span data-testid="live">{view.live.messages.size}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  FakeSocket.last = null;
  FakeSocket.all = [];
  vi.useRealTimers();
  setOnline(true);
});

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
}

/** Sockets the hook has not closed. */
function liveSockets() {
  return FakeSocket.all.filter((socket) => !socket.closed);
}

describe("useSession", () => {
  it("opens a socket resuming from the last applied sequence", () => {
    render(<Probe sessionId="sess_1" />);

    expect(FakeSocket.last?.url).toBe("wss://app.test/ws/sessions/sess_1/client?after=0");
    expect(screen.getByTestId("connection").textContent).toBe("connecting");
  });

  it("applies a replay batch and then reports caught up", () => {
    render(<Probe sessionId="sess_1" />);
    const socket = FakeSocket.last;

    socket?.deliver({
      type: "replay_batch",
      through: 1,
      events: [makeCommittedEvent("message.started", {}, { sessionSequence: 1 })],
    });
    socket?.deliver({ type: "caught_up", through: 1 });

    expect(screen.getByTestId("applied").textContent).toBe("1");
    expect(screen.getByTestId("connection").textContent).toBe("caught_up");
  });

  it("goes live on a committed broadcast", () => {
    render(<Probe sessionId="sess_1" />);

    FakeSocket.last?.deliver(makeCommittedEvent("message.started", {}, { sessionSequence: 1 }));

    expect(screen.getByTestId("connection").textContent).toBe("live");
    expect(screen.getByTestId("applied").textContent).toBe("1");
  });

  it("buffers a transient delta without advancing history", () => {
    render(<Probe sessionId="sess_1" />);
    const socket = FakeSocket.last;

    socket?.deliver(makeCommittedEvent("message.started", {}, { sessionSequence: 1 }));
    socket?.deliver(makeEvent("message.delta"));

    expect(screen.getByTestId("live").textContent).toBe("1");
    expect(screen.getByTestId("applied").textContent).toBe("1");
  });

  it("reconnects after an unexpected close", () => {
    render(<Probe sessionId="sess_1" />);

    FakeSocket.last?.hangUp(1006);

    expect(screen.getByTestId("connection").textContent).toBe("reconnecting");
    expect(screen.getByTestId("denied").textContent).toBe("false");
  });

  it("stops retrying when the control plane refuses the session", () => {
    render(<Probe sessionId="sess_1" />);

    FakeSocket.last?.hangUp(4403);

    expect(screen.getByTestId("denied").textContent).toBe("true");
  });

  it("treats an unauthenticated close as a refusal too", () => {
    render(<Probe sessionId="sess_1" />);

    FakeSocket.last?.hangUp(4401);

    expect(screen.getByTestId("denied").textContent).toBe("true");
  });

  it("ignores frames it cannot parse", () => {
    render(<Probe sessionId="sess_1" />);
    const socket = FakeSocket.last;

    act(() => {
      socket?.onmessage?.({ data: "not json" } as MessageEvent);
    });

    expect(screen.getByTestId("applied").textContent).toBe("0");
  });

  it("closes the socket when the session is unmounted", () => {
    const view = render(<Probe sessionId="sess_1" />);
    const socket = FakeSocket.last;

    view.unmount();

    expect(socket?.closed).toBe(true);
  });

  describe("sendCommand", () => {
    function outgoingCancel(): OutgoingCommand<"run.cancel"> {
      return {
        type: "run.cancel",
        commandId: "cmd_1",
        runId: "run_1",
        expected: { scope: "run", state: "running" },
        payload: { reason: null, checkpointFirst: false },
      } as unknown as OutgoingCommand<"run.cancel">;
    }

    it("refuses to send while the socket is not open", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);

      const accepted = session?.sendCommand(outgoingCancel());

      expect(accepted).toBe("not_sent");
      expect(FakeSocket.last?.sent).toEqual([]);
    });

    it("wraps the command in the client-socket envelope once the socket is open", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      FakeSocket.last?.open();

      const onSent = vi.fn();
      const accepted = session?.sendCommand(outgoingCancel(), { onSent });

      expect(accepted).toBe("sent");
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(FakeSocket.last?.sent).toHaveLength(1);
      const frame = JSON.parse(FakeSocket.last?.sent[0] ?? "{}");
      expect(frame).toMatchObject({
        type: "command",
        command: {
          type: "run.cancel",
          commandId: "cmd_1",
          sessionId: "sess_1",
          runId: "run_1",
          expected: { scope: "run", state: "running" },
          payload: { reason: null, checkpointFirst: false },
        },
      });
      // No `issuedByUserId` on the wire: the session object reads it off the
      // authenticated connection, never trusts a client-supplied identity.
      expect(frame.command.issuedByUserId).toBeUndefined();
      expect(typeof frame.command.issuedAt).toBe("string");
    });

    it("refuses once the socket has closed", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      FakeSocket.last?.open();
      FakeSocket.last?.hangUp(1006);

      expect(session?.sendCommand(outgoingCancel())).toBe("not_sent");
    });

    it("holds a queued command until a socket opens, then writes held commands first, in order", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      const first = vi.fn();
      const second = vi.fn();

      expect(
        session?.sendCommand(withId(outgoingCancel(), "cmd_a"), { queue: true, onSent: first }),
      ).toBe("queued");
      expect(
        session?.sendCommand(withId(outgoingCancel(), "cmd_b"), { queue: true, onSent: second }),
      ).toBe("queued");
      expect(FakeSocket.last?.sent).toEqual([]);
      expect(first).not.toHaveBeenCalled();

      FakeSocket.last?.open();

      const ids = FakeSocket.last?.sent.map((frame) => JSON.parse(frame).command.commandId);
      expect(ids).toEqual(["cmd_a", "cmd_b"]);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      // Flushed once: a later socket does not send them again.
      FakeSocket.last?.hangUp(1006);
      expect(FakeSocket.all[0]?.sent).toHaveLength(2);
    });

    it("carries a queued command across a reconnect", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      FakeSocket.last?.open();
      FakeSocket.last?.hangUp(1006);

      expect(session?.sendCommand(outgoingCancel(), { queue: true })).toBe("queued");
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(FakeSocket.all).toHaveLength(2);
      FakeSocket.last?.open();

      expect(FakeSocket.all[0]?.sent).toEqual([]);
      expect(FakeSocket.all[1]?.sent).toHaveLength(1);
    });

    it("drops a queued command that is cancelled before a socket opens", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      session?.sendCommand(outgoingCancel(), { queue: true });

      expect(session?.cancelQueued("cmd_1")).toBe(true);
      expect(session?.cancelQueued("cmd_1")).toBe(false);
      FakeSocket.last?.open();

      expect(FakeSocket.last?.sent).toEqual([]);
    });

    it("cannot cancel a command once it has been written", () => {
      let session: ReturnType<typeof useSession> | undefined;
      render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      FakeSocket.last?.open();
      session?.sendCommand(outgoingCancel(), { queue: true });

      expect(session?.cancelQueued("cmd_1")).toBe(false);
      expect(FakeSocket.last?.sent).toHaveLength(1);
    });

    it("forgets queued commands when the session unmounts", () => {
      let session: ReturnType<typeof useSession> | undefined;
      const view = render(<Probe sessionId="sess_1" onReady={(s) => (session = s)} />);
      session?.sendCommand(outgoingCancel(), { queue: true });
      view.unmount();

      expect(session?.cancelQueued("cmd_1")).toBe(false);
    });
  });

  describe("one live socket", () => {
    it("replaces a socket still connecting when the browser comes back online", () => {
      render(<Probe sessionId="sess_1" />);
      const first = FakeSocket.last;

      act(() => {
        window.dispatchEvent(new Event("online"));
      });

      expect(first?.closed).toBe(true);
      expect(FakeSocket.all).toHaveLength(2);
      expect(liveSockets()).toEqual([FakeSocket.last]);
    });

    it("keeps an open socket when the browser reports online again", () => {
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.open();

      act(() => {
        window.dispatchEvent(new Event("online"));
      });

      expect(FakeSocket.all).toHaveLength(1);
      expect(FakeSocket.last?.closed).toBe(false);
    });

    it("cuts a pending backoff short when the browser comes back online", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.hangUp(1006);
      expect(FakeSocket.all).toHaveLength(1);

      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect(FakeSocket.all).toHaveLength(2);
      FakeSocket.last?.open();

      // The cancelled retry never fires a third socket.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(FakeSocket.all).toHaveLength(2);
      expect(liveSockets()).toHaveLength(1);
    });

    it("ignores everything a replaced socket does afterwards", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      const stale = FakeSocket.last as FakeSocket;
      const staleClose = stale.onclose;
      const staleMessage = stale.onmessage;
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      const current = FakeSocket.last as FakeSocket;
      current.open();
      current.deliver({ type: "caught_up", through: 0 });

      // The stale socket's own close and frames, even through handlers captured earlier.
      act(() => {
        staleClose?.call(stale as unknown as WebSocket, { code: 1006 } as CloseEvent);
        staleMessage?.call(
          stale as unknown as WebSocket,
          {
            data: JSON.stringify(makeCommittedEvent("message.started", {}, { sessionSequence: 1 })),
          } as MessageEvent,
        );
        vi.advanceTimersByTime(10_000);
      });

      expect(FakeSocket.all).toHaveLength(2);
      expect(screen.getByTestId("connection").textContent).toBe("caught_up");
      expect(screen.getByTestId("applied").textContent).toBe("0");
    });

    it("backs off when a server accepts and then closes at once, instead of retrying every half second", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      const delays: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        FakeSocket.last?.open();
        FakeSocket.last?.hangUp(1011);
        const before = FakeSocket.all.length;
        let waited = 0;
        while (FakeSocket.all.length === before) {
          act(() => {
            vi.advanceTimersByTime(100);
          });
          waited += 100;
        }
        delays.push(waited);
      }

      expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
      expect(liveSockets()).toHaveLength(1);
    });

    it("starts the backoff over once a socket has stayed open a while", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.hangUp(1006);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      FakeSocket.last?.hangUp(1006);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      FakeSocket.last?.open();
      act(() => {
        vi.advanceTimersByTime(STABLE_AFTER_MS);
      });
      FakeSocket.last?.hangUp(1006);
      const before = FakeSocket.all.length;

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(FakeSocket.all.length).toBe(before + 1);
    });

    it("abandons a handshake that never opens and tries again", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      const hung = FakeSocket.last as FakeSocket;

      act(() => {
        vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
      });
      expect(hung.closed).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(hung.closed).toBe(true);
      expect(screen.getByTestId("connection").textContent).toBe("reconnecting");

      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(FakeSocket.all).toHaveLength(2);
      expect(liveSockets()).toEqual([FakeSocket.last]);
    });

    it("does not time out a socket that opened", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.open();

      act(() => {
        vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 3);
      });

      expect(FakeSocket.all).toHaveLength(1);
      expect(FakeSocket.last?.closed).toBe(false);
    });

    it("retries after a socket error without opening two sockets", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      const failed = FakeSocket.last as FakeSocket;
      failed.fail();
      // A browser follows an error with a close; the detached socket's is ignored.
      failed.hangUp(1006);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(failed.closed).toBe(true);
      expect(FakeSocket.all).toHaveLength(2);
      FakeSocket.last?.open();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(FakeSocket.all).toHaveLength(2);
      expect(liveSockets()).toEqual([FakeSocket.last]);
    });

    it("waits offline without a socket and connects when the browser is back online", () => {
      setOnline(false);
      render(<Probe sessionId="sess_1" />);

      expect(FakeSocket.all).toHaveLength(0);
      expect(screen.getByTestId("connection").textContent).toBe("offline");

      setOnline(true);
      act(() => {
        window.dispatchEvent(new Event("online"));
      });

      expect(FakeSocket.all).toHaveLength(1);
      expect(screen.getByTestId("connection").textContent).toBe("connecting");
    });

    it("still tries a socket while the browser wrongly reports offline, and recovers on it", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      setOnline(false);
      render(<Probe sessionId="sess_1" />);
      expect(FakeSocket.all).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(OFFLINE_RETRY_MS - 1);
      });
      expect(FakeSocket.all).toHaveLength(0);
      act(() => {
        vi.advanceTimersByTime(1);
      });

      // No `online` event ever came, yet the network works.
      expect(FakeSocket.all).toHaveLength(1);
      expect(screen.getByTestId("connection").textContent).toBe("offline");
      FakeSocket.last?.open();
      FakeSocket.last?.deliver({ type: "caught_up", through: 0 });
      expect(screen.getByTestId("connection").textContent).toBe("caught_up");
    });

    it("keeps trying on the slow offline cadence when the offline attempt fails", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      setOnline(false);
      render(<Probe sessionId="sess_1" />);
      act(() => {
        vi.advanceTimersByTime(OFFLINE_RETRY_MS);
      });
      expect(FakeSocket.all).toHaveLength(1);

      FakeSocket.last?.hangUp(1006);
      expect(screen.getByTestId("connection").textContent).toBe("offline");
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      // One attempt per backoff step plus the offline wait, never a tight loop.
      expect(FakeSocket.all.length).toBeGreaterThan(1);
      expect(FakeSocket.all.length).toBeLessThanOrEqual(1 + Math.ceil(60_000 / OFFLINE_RETRY_MS));
      expect(liveSockets().length).toBeLessThanOrEqual(1);
    });

    it("reads offline when the browser goes offline, and offline on a close while offline", () => {
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.open();

      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(screen.getByTestId("connection").textContent).toBe("offline");

      setOnline(false);
      FakeSocket.last?.hangUp(1006);
      expect(screen.getByTestId("connection").textContent).toBe("offline");
    });

    it("schedules nothing and closes the socket after unmount", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const view = render(<Probe sessionId="sess_1" />);
      const socket = FakeSocket.last as FakeSocket;
      const onclose = socket.onclose;
      view.unmount();
      act(() => {
        onclose?.call(socket as unknown as WebSocket, { code: 1006 } as CloseEvent);
        vi.advanceTimersByTime(60_000);
      });

      expect(socket.closed).toBe(true);
      expect(FakeSocket.all).toHaveLength(1);
    });

    it("stops after a refusal and opens nothing more", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<Probe sessionId="sess_1" />);
      FakeSocket.last?.open();
      FakeSocket.last?.hangUp(4403);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(FakeSocket.all).toHaveLength(1);
      expect(screen.getByTestId("denied").textContent).toBe("true");
    });
  });
});

function withId(
  command: OutgoingCommand<"run.cancel">,
  commandId: string,
): OutgoingCommand<"run.cancel"> {
  return { ...command, commandId } as OutgoingCommand<"run.cancel">;
}
