import { describe, expect, it } from "vitest";
import type { BridgeMessageEvent, BridgeSocket } from "./fake-bridge";
import { attachFakeBridge } from "./fake-bridge";
import { loadBridgeScript } from "./scripts";

class FakeSocket implements BridgeSocket {
  peer: FakeSocket | null = null;
  readonly received: string[] = [];
  private listeners: Array<(event: BridgeMessageEvent) => void> = [];

  send(data: string): void {
    if (this.peer !== null) {
      this.peer.dispatch(data);
    }
  }

  dispatch(data: string): void {
    this.received.push(data);
    for (const listener of this.listeners) {
      listener({ data });
    }
  }

  addEventListener(_type: "message", listener: (event: BridgeMessageEvent) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "message", listener: (event: BridgeMessageEvent) => void): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

function makeSocketPair(): [FakeSocket, FakeSocket] {
  const bridgeSide = new FakeSocket();
  const clientSide = new FakeSocket();
  bridgeSide.peer = clientSide;
  clientSide.peer = bridgeSide;
  return [bridgeSide, clientSide];
}

async function flushMicrotasks(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("attachFakeBridge", () => {
  it("plays every frame over the socket, in order, under immediate pacing", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });

    await flushMicrotasks(script.frames.length + 2);

    const receivedTypes = clientSide.received.map((raw) => JSON.parse(raw).type);
    expect(receivedTypes).toEqual(script.frames.map((frame) => frame.type));

    bridge.stop();
  });

  it("answers replay_from by resending from the first frame at or after the requested sequence", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });
    await flushMicrotasks(script.frames.length + 2);
    clientSide.received.length = 0;

    clientSide.send(JSON.stringify({ type: "replay_from", runtimeSequence: 4 }));
    await flushMicrotasks(script.frames.length + 2);

    const replayedSequences = clientSide.received.map((raw) => JSON.parse(raw).runtimeSequence);
    expect(replayedSequences).toEqual([4, 5]);

    bridge.stop();
  });

  it("requesting a sequence past the end resends nothing", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });
    await flushMicrotasks(script.frames.length + 2);
    clientSide.received.length = 0;

    clientSide.send(JSON.stringify({ type: "replay_from", runtimeSequence: 100 }));
    await flushMicrotasks(5);

    expect(clientSide.received).toEqual([]);

    bridge.stop();
  });

  it("stop() halts further playback", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });

    await flushMicrotasks(1);
    const countAfterOneFrame = clientSide.received.length;
    bridge.stop();
    await flushMicrotasks(script.frames.length + 5);

    expect(clientSide.received.length).toBe(countAfterOneFrame);
  });

  it("ignores a message that is not valid JSON", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });
    await flushMicrotasks(script.frames.length + 2);
    clientSide.received.length = 0;

    expect(() => clientSide.send("not json")).not.toThrow();
    await flushMicrotasks(5);

    expect(clientSide.received).toEqual([]);

    bridge.stop();
  });

  it("ignores a message that is not a replay_from request", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "immediate" });
    await flushMicrotasks(script.frames.length + 2);
    clientSide.received.length = 0;

    clientSide.send(JSON.stringify({ type: "something_else" }));
    await flushMicrotasks(5);

    expect(clientSide.received).toEqual([]);

    bridge.stop();
  });

  it("supports paced playback for the browser inspector", async () => {
    const [bridgeSide, clientSide] = makeSocketPair();
    const script = loadBridgeScript("seven-event");
    const bridge = attachFakeBridge(bridgeSide, script, { kind: "paced", frameIntervalMs: 1 });

    await new Promise((resolve) => setTimeout(resolve, 20 * script.frames.length));

    const receivedTypes = clientSide.received.map((raw) => JSON.parse(raw).type);
    expect(receivedTypes).toEqual(script.frames.map((frame) => frame.type));

    bridge.stop();
  });
});
