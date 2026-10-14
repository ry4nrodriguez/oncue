import { connect as connectTcp, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildCommandFrame, buildGrantFrame, type DeliverableCommand } from "./frames";
import {
  type BridgeConfig,
  type BridgeIdentity,
  type BridgeIo,
  type BridgeLink,
  bridgeConfig,
  bridgeConnectHeaders,
  bridgeConnectUrl,
  classifyIncoming,
  createReconnectPolicy,
  type DevSupervisorEnv,
  type Draft,
  devSupervisorPlan,
  freeLoopbackPort,
  HANDSHAKE_TIMEOUT_MS,
  heartbeatFrame,
  helloFrame,
  isWorthRetrying,
  LIVENESS_SILENT_TICKS,
  NO_PONG_NOTICE_TICKS,
  nodeBridgeIo,
  type Outbound,
  planStartup,
  type RuntimeIdentity,
  reconnectDelayMs,
  resolveDevSupervisorPlan,
  reviewHandshakeReply,
  runBridge,
  runLink,
  runtimeConnectedEvent,
  type SequenceCursor,
  type SessionHandler,
  stampDraft,
  UNSTAMPED_BRIDGE_VERSION,
  WELCOME_DEADLINE_TICKS,
} from "./main";

const IDENTITY: BridgeIdentity = {
  sessionId: "sess_1",
  generation: 3,
  bootstrapCredential: "boot-sess_1-g3",
};

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ...bridgeConfig(IDENTITY, "wss://oncue.example", {
      heartbeatIntervalMs: 15_000,
      reconnectBaseDelayMs: 10,
      maxReconnectDelayMs: 40,
      // With the test clock, waits of 10, 20, and 40 ms bring an outage to
      // 70 ms, so the fourth ending in one outage is past the window.
      reconnectWindowMs: 70,
      stableLinkMs: 1_000,
    }),
    ...overrides,
  };
}

function welcome(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "bridge.welcome",
    protocolVersion: config().protocolVersion,
    sessionId: "sess_1",
    sandboxGeneration: 3,
    ...overrides,
  });
}

/** A link the test drives: whatever the bridge sends is recorded, and the test decides what arrives. */
class TestLink implements BridgeLink {
  readonly sent: string[] = [];
  closed = false;
  terminated = false;
  pings = 0;
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: ((code?: number) => void) | null = null;
  private pongListener: (() => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
  }

  ping(): void {
    this.pings += 1;
  }

  onPong(listener: () => void): void {
    this.pongListener = listener;
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: (code?: number) => void): void {
    this.closeListener = listener;
  }

  deliver(data: string): void {
    this.messageListener?.(data);
  }

  pong(): void {
    this.pongListener?.();
  }

  drop(code?: number): void {
    this.closeListener?.(code);
  }
}

/** A link with only the four required members, as the Worker's tests and the forged bridge build one. */
class BareLink implements BridgeLink {
  readonly sent: string[] = [];
  closed = false;
  private messageListener: ((data: string) => void) | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }
  onClose(): void {}
  deliver(data: string): void {
    this.messageListener?.(data);
  }
}

interface HeartbeatRequest {
  readonly intervalMs: number;
  readonly tick: () => void;
}

class TestIo implements BridgeIo {
  readonly connects: { url: string; headers: Record<string, string> }[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly sleeps: number[] = [];
  readonly logs: string[] = [];
  cancelledHeartbeats = 0;

  constructor(private readonly links: (TestLink | Error)[]) {}

  async connect(url: string, headers: Record<string, string>): Promise<BridgeLink> {
    this.connects.push({ url, headers });
    const index = this.connects.length - 1;
    const next = this.links[index];
    if (next === undefined) {
      throw new Error("the bridge connected more times than the test provided links for");
    }
    if (next instanceof Error) {
      throw next;
    }
    // A task rather than a microtask: `runLink` attaches its listeners only
    // after this promise resolves, and a microtask would run first and be
    // delivered to nobody. A real socket has the same ordering for the same
    // reason.
    setTimeout(() => this.play(next, index), 0);
    return next;
  }

  /** What the control plane says on the `index`th connection. */
  play(link: TestLink, _index: number): void {
    link.deliver(welcome());
  }

  startHeartbeat(intervalMs: number, tick: () => void): () => void {
    this.heartbeats.push({ intervalMs, tick });
    return () => {
      this.cancelledHeartbeats += 1;
    };
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.clock += ms;
  }

  /** Moves only when the bridge sleeps or a test says time passed. */
  clock = 0;

  nowMs(): number {
    return this.clock;
  }

  /** The top of the jitter range, so a wait is the capped exponential itself. */
  jitter = 1;

  random(): number {
    return this.jitter;
  }

  log(line: string): void {
    this.logs.push(line);
  }

  private issued = 0;

  newEventId(): string {
    this.issued += 1;
    return `evt_test_${this.issued}`;
  }

  now(): string {
    return "2026-09-10T00:00:00.000Z";
  }
}

/** The frame `runLink` sends once the welcome is accepted, as the test io would stamp it. */
function connected(sequence: number, eventNumber: number): string {
  return JSON.stringify(
    runtimeConnectedEvent(
      config(),
      sequence,
      `evt_test_${eventNumber}`,
      "2026-09-10T00:00:00.000Z",
    ),
  );
}

describe("bridgeConnectUrl and bridgeConnectHeaders", () => {
  it("puts the generation in the path and the credential in a header", () => {
    expect(bridgeConnectUrl(config())).toBe("wss://oncue.example/ws/bridge/sess_1/3");
    expect(bridgeConnectHeaders(config())).toEqual({ authorization: "Bearer boot-sess_1-g3" });
  });

  it("keeps the credential out of the URL, which is the string most likely to be logged", () => {
    expect(bridgeConnectUrl(config())).not.toContain(IDENTITY.bootstrapCredential);
  });
});

describe("helloFrame and heartbeatFrame", () => {
  it("state the session and generation the connection claims to be", () => {
    expect(helloFrame(config())).toEqual({
      type: "bridge.hello",
      protocolVersion: 1,
      sessionId: "sess_1",
      sandboxGeneration: 3,
    });
    expect(heartbeatFrame(config())).toEqual({
      type: "bridge.heartbeat",
      sessionId: "sess_1",
      sandboxGeneration: 3,
    });
  });

  it("never carry the credential", () => {
    const frames = JSON.stringify([helloFrame(config()), heartbeatFrame(config())]);
    expect(frames).not.toContain(IDENTITY.bootstrapCredential);
  });
});

describe("reviewHandshakeReply", () => {
  it("accepts a welcome that matches", () => {
    expect(reviewHandshakeReply(config(), JSON.parse(welcome()))).toEqual({ kind: "accepted" });
  });

  it.each([
    ["a version the bridge does not speak", { protocolVersion: 2 }, "protocol_version"],
    ["a different session", { sessionId: "sess_other" }, "wrong_session"],
    ["a newer generation", { sandboxGeneration: 4 }, "stale_generation"],
    ["a frame that is not a welcome", { type: "bridge.goodbye" }, "malformed_reply"],
  ])("refuses %s", (_name, overrides, reason) => {
    expect(reviewHandshakeReply(config(), JSON.parse(welcome(overrides)))).toEqual({
      kind: "refused",
      reason,
    });
  });

  it.each([
    ["a non-object", 7],
    ["null", null],
  ])("refuses %s as malformed", (_name, raw) => {
    expect(reviewHandshakeReply(config(), raw)).toEqual({
      kind: "refused",
      reason: "malformed_reply",
    });
  });
});

describe("classifyIncoming", () => {
  it("reads a shutdown, which means the same thing at any point in the connection", () => {
    expect(classifyIncoming(JSON.stringify({ type: "runtime.shutdown" }))).toEqual({
      kind: "shutdown",
    });
  });

  it.each([
    ["a welcome", welcome(), JSON.parse(welcome())],
    ["an unrelated frame", JSON.stringify({ type: "message.delta" }), { type: "message.delta" }],
    ["a non-object", JSON.stringify(7), 7],
    ["text that is not JSON", "{", null],
  ])("hands %s on as a value", (_name, raw, value) => {
    expect(classifyIncoming(raw)).toEqual({ kind: "frame", value });
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially from the base and never past the cap", () => {
    const settings = config();
    expect([0, 1, 2, 3, 10, 60].map((attempt) => reconnectDelayMs(settings, attempt, 1))).toEqual([
      10, 20, 40, 40, 40, 40,
    ]);
  });

  it("jitters each wait between half the capped delay and all of it", () => {
    const settings = config();
    expect(reconnectDelayMs(settings, 2, 0)).toBe(20);
    expect(reconnectDelayMs(settings, 2, 0.5)).toBe(30);
    expect(reconnectDelayMs(settings, 2, 0.999)).toBe(40);
    // A random source outside [0, 1) cannot push a wait outside that range.
    expect(reconnectDelayMs(settings, 2, -3)).toBe(20);
    expect(reconnectDelayMs(settings, 2, 7)).toBe(40);
  });

  it("defaults to a few seconds at most, however long the outage", () => {
    const settings = bridgeConfig(IDENTITY, "wss://oncue.example");
    expect(reconnectDelayMs(settings, 0, 1)).toBe(500);
    expect(reconnectDelayMs(settings, 50, 1)).toBe(5_000);
    expect(settings.reconnectWindowMs).toBe(10 * 60_000);
  });
});

describe("createReconnectPolicy", () => {
  it("bounds one outage by wall-clock time, not by a count of attempts", () => {
    const policy = createReconnectPolicy(config(), 0, () => 1);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 0 })).toBe(10);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 10 })).toBe(20);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 30 })).toBe(40);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 69 })).toBe(40);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 70 })).toBeNull();
    expect(policy.attempts).toBe(5);
  });

  it("starts a new outage after a link that negotiated and stayed up long enough", () => {
    const policy = createReconnectPolicy(config(), 0, () => 1);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 60 })).toBe(10);
    // Up for the stable time: the budget and the backoff both start over.
    expect(policy.next({ linkedUpAtMs: 1_000, endedAtMs: 2_000 })).toBe(10);
    expect(policy.attempts).toBe(1);
    expect(policy.next({ linkedUpAtMs: null, endedAtMs: 2_060 })).toBe(20);
  });

  it("measures how long a link worked by when it was last heard, not when its silence was noticed", () => {
    const policy = createReconnectPolicy(config(), 0, () => 1);
    // Up for 2 s of answers, then half-open for a minute: not a stable link.
    expect(policy.next({ linkedUpAtMs: 0, lastHeardAtMs: 2_000, endedAtMs: 62_000 })).toBeNull();
    const steady = createReconnectPolicy(config(), 0, () => 1);
    expect(steady.next({ linkedUpAtMs: 0, lastHeardAtMs: 5_000, endedAtMs: 5_040 })).toBe(10);
    expect(steady.attempts).toBe(1);
  });

  it("does not let a link that dropped soon after its handshake reset the outage", () => {
    const policy = createReconnectPolicy(config(), 0, () => 1);
    expect(policy.next({ linkedUpAtMs: 0, endedAtMs: 5 })).toBe(10);
    expect(policy.next({ linkedUpAtMs: 20, endedAtMs: 40 })).toBe(20);
    expect(policy.next({ linkedUpAtMs: 50, endedAtMs: 70 })).toBeNull();
  });
});

function onlyTicker(io: TestIo): () => void {
  const heartbeat = io.heartbeats[0];
  if (heartbeat === undefined || io.heartbeats.length !== 1) {
    throw new Error("expected exactly one heartbeat timer");
  }
  return heartbeat.tick;
}

describe("runLink: heartbeat cadence", () => {
  it("runs one timer at the configured interval and sends heartbeats only after the welcome", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    expect(io.heartbeats).toEqual([{ intervalMs: 15_000, tick: expect.any(Function) }]);
    const tick = onlyTicker(io);
    // Before the welcome a tick only counts toward the welcome's deadline.
    tick();
    expect(link.sent).toEqual([JSON.stringify(helloFrame(config()))]);

    link.deliver(welcome());
    tick();
    tick();
    expect(link.sent.slice(1)).toEqual([
      connected(0, 1),
      JSON.stringify(heartbeatFrame(config())),
      JSON.stringify(heartbeatFrame(config())),
    ]);
    expect(link.pings).toBe(2);

    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
    expect(io.cancelledHeartbeats).toBe(1);
  });

  it("sends hello before anything else", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.drop();
    await outcome;

    expect(link.sent[0]).toBe(JSON.stringify(helloFrame(config())));
  });

  it("ignores session traffic once the handshake is done rather than re-reviewing it", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(welcome());
    link.deliver(JSON.stringify({ type: "message.delta" }));
    expect(io.heartbeats).toHaveLength(1);
    expect(link.sent).toHaveLength(2);

    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });

  it("refuses a first frame that is not a welcome, rather than staying connected", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(JSON.stringify({ type: "message.delta" }));

    await expect(outcome).resolves.toEqual({ kind: "refused", reason: "malformed_reply" });
    expect(link.closed).toBe(true);
  });

  it("answers runtime.shutdown by closing", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(welcome());
    link.deliver(JSON.stringify({ type: "runtime.shutdown" }));

    await expect(outcome).resolves.toEqual({ kind: "shutdown" });
    expect(link.closed).toBe(true);
  });

  it("settles once: a close after a shutdown does not change the outcome", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(JSON.stringify({ type: "runtime.shutdown" }));
    link.drop();

    await expect(outcome).resolves.toEqual({ kind: "shutdown" });
  });
});

describe("runLink: liveness", () => {
  it("drops a link whose peer answered pings and then went silent, without waiting for a closing handshake", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    link.deliver(welcome());
    tick();
    link.pong();
    for (let silent = 0; silent < LIVENESS_SILENT_TICKS; silent += 1) {
      tick();
    }
    expect(link.terminated).toBe(false);
    tick();

    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
    expect(link.terminated).toBe(true);
    expect(io.cancelledHeartbeats).toBe(1);
    expect(io.logs).toContain(
      "bridge dropped a link that stopped answering: no answer to the last pings",
    );
  });

  it("counts any frame from the object as an answer, as well as a pong", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    link.deliver(welcome());
    link.pong();
    for (let round = 0; round < 5; round += 1) {
      tick();
      tick();
      link.deliver(JSON.stringify({ type: "replay_from", runtimeSequence: 0 }));
    }
    expect(link.terminated).toBe(false);
    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });

  it("says once per link when no ping has been answered, so the edge's behaviour can be read", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    link.deliver(welcome());
    for (let silent = 0; silent < NO_PONG_NOTICE_TICKS * 3; silent += 1) {
      tick();
    }
    expect(
      io.logs.filter((line) => line.includes("no ping has been answered on this link")),
    ).toHaveLength(1);
    link.drop();
    await outcome;
  });

  it("stays quiet about pings on a link whose pings are answered", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    link.deliver(welcome());
    for (let round = 0; round < NO_PONG_NOTICE_TICKS * 2; round += 1) {
      tick();
      link.pong();
    }
    expect(io.logs.some((line) => line.includes("no ping has been answered"))).toBe(false);
    link.drop();
    await outcome;
  });

  it("never times out a peer that has not once answered a ping, so a transport without them behaves as before", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    link.deliver(welcome());
    for (let silent = 0; silent < 20; silent += 1) {
      tick();
    }
    expect(link.terminated).toBe(false);
    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });

  it("drops an opened socket that is never welcomed", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    for (let waited = 1; waited < WELCOME_DEADLINE_TICKS; waited += 1) {
      tick();
    }
    expect(link.terminated).toBe(false);
    tick();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
    expect(link.terminated).toBe(true);
    // A tick that fires after the link settled does nothing.
    tick();
    expect(link.sent).toEqual([JSON.stringify(helloFrame(config()))]);
  });

  it("closes a link that cannot be terminated, and works over a link with no ping at all", async () => {
    const link = new BareLink();
    const io = new TestIo([]);
    const outcome = runLink(config(), io, link);
    const tick = onlyTicker(io);
    tick();
    tick();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
    expect(link.closed).toBe(true);

    const second = new BareLink();
    const io2 = new TestIo([]);
    const linked = runLink(config(), io2, second);
    second.deliver(welcome());
    onlyTicker(io2)();
    expect(second.sent.at(-1)).toBe(JSON.stringify(heartbeatFrame(config())));
    second.deliver(JSON.stringify({ type: "runtime.shutdown" }));
    await expect(linked).resolves.toEqual({ kind: "shutdown" });
  });
});

describe("runLink: a handler that keeps an outbox", () => {
  it("lets onWelcome send runtime.connected, in its own order, before onLinkUp", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const cursor: SequenceCursor = { next: 5 };
    const calls: string[] = [];
    const outcome = runLink(config(), io, link, cursor, {
      onWelcome(outbound, connected) {
        calls.push("welcome");
        // What the handler held from before goes first.
        outbound.sendAck({ type: "held" } as never);
        outbound.sendEvent(connected());
      },
      onLinkUp: () => calls.push("up"),
      onLinkDown: () => calls.push("down"),
      onFrame: () => undefined,
    });
    link.deliver(welcome());
    expect(calls).toEqual(["welcome", "up"]);
    expect(link.sent.slice(1)).toEqual([JSON.stringify({ type: "held" }), connected(5, 1)]);
    expect(cursor.next).toBe(6);
    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });
});

describe("runLink: the object's close codes", () => {
  it.each([
    ["before the handshake", false],
    ["after the handshake", true],
  ])("reads 4000 as a stale generation %s", async (_when, welcomed) => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    if (welcomed) {
      link.deliver(welcome());
    }
    link.drop(4000);
    await expect(outcome).resolves.toEqual({ kind: "refused", reason: "stale_generation" });
  });

  it("reads 4401 as a credential the object will never accept", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    link.drop(4401);
    await expect(outcome).resolves.toEqual({ kind: "refused", reason: "unauthorized" });
  });

  it.each([1000, 1006, 1011, 4001])("reads %i as a drop worth reconnecting after", async (code) => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const outcome = runLink(config(), io, link);
    link.deliver(welcome());
    link.drop(code);
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });
});

describe("runLink: runtime.connected", () => {
  it("sends runtime.connected immediately after the welcome is accepted, and nothing before it", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    expect(link.sent).toEqual([JSON.stringify(helloFrame(config()))]);

    link.deliver(welcome());
    expect(link.sent).toEqual([JSON.stringify(helloFrame(config())), connected(0, 1)]);

    link.drop();
    await expect(outcome).resolves.toEqual({ kind: "disconnected" });
  });

  it("never sends runtime.connected when the welcome is refused", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(welcome({ sandboxGeneration: 4 }));

    await expect(outcome).resolves.toEqual({ kind: "refused", reason: "stale_generation" });
    expect(link.sent).toEqual([JSON.stringify(helloFrame(config()))]);
  });

  it("is a well-formed sandbox-origin event that names no runtime and the bridge's own capabilities", () => {
    const event = runtimeConnectedEvent(config(), 4, "evt_x", "2026-09-10T00:00:00.000Z");

    expect(event).toMatchObject({
      type: "runtime.connected",
      sessionId: "sess_1",
      runId: null,
      sandboxGeneration: 3,
      runtimeSequence: 4,
      payload: {
        bridgeVersion: UNSTAMPED_BRIDGE_VERSION,
        runtimeName: "none",
        runtimeVersion: "none",
        protocolVersion: 1,
        // The session object changes model in a live sandbox only for a bridge that says this.
        capabilities: ["model_switch"],
      },
    });
    // The whole point of not sending `runtime.ready`: nothing here claims a
    // health check ran.
    expect(JSON.stringify(event)).not.toContain("healthChecks");
  });

  it("reports the stamped bridge version when the config carries one", () => {
    const stamped = { ...config(), bridgeVersion: "abc1234" };
    expect(
      runtimeConnectedEvent(stamped, 0, "evt_x", "2026-09-10T00:00:00.000Z").payload,
    ).toMatchObject({
      bridgeVersion: "abc1234",
    });
  });
});

describe("runBridge: version mismatch", () => {
  it("refuses and stops, rather than reconnecting into the same refusal", async () => {
    const link = new TestLink();
    const io = new (class extends TestIo {
      override play(target: TestLink): void {
        target.deliver(welcome({ protocolVersion: 99 }));
      }
    })([link]);

    const exit = await runBridge(config(), io);

    expect(exit).toEqual({ kind: "refused", reason: "protocol_version" });
    expect(io.connects).toHaveLength(1);
    expect(io.sleeps).toEqual([]);
    expect(link.closed).toBe(true);
  });

  it("stops on a stale generation too: record 11 makes `replaced` terminal", async () => {
    const io = new (class extends TestIo {
      override play(target: TestLink): void {
        target.deliver(welcome({ sandboxGeneration: 4 }));
      }
    })([new TestLink()]);

    await expect(runBridge(config(), io)).resolves.toEqual({
      kind: "refused",
      reason: "stale_generation",
    });
  });

  it.each([
    [4000, "stale_generation"],
    [4401, "unauthorized"],
  ] as const)(
    "stops at once when the object closes with %i, rather than retrying for the whole window",
    async (code, reason) => {
      const io = new (class extends TestIo {
        override play(target: TestLink): void {
          target.drop(code);
        }
      })([new TestLink()]);

      await expect(runBridge(config(), io)).resolves.toEqual({ kind: "refused", reason });
      expect(io.connects).toHaveLength(1);
      expect(io.sleeps).toEqual([]);
    },
  );

  it("retries a malformed reply, which may be one bad frame rather than a standing refusal", async () => {
    const links = [new TestLink(), new TestLink(), new TestLink(), new TestLink()];
    const io = new (class extends TestIo {
      override play(target: TestLink): void {
        target.deliver(JSON.stringify({ type: "bridge.goodbye" }));
      }
    })(links);

    await expect(runBridge(config(), io)).resolves.toEqual({ kind: "exhausted", attempts: 4 });
  });
});

describe("runBridge: reconnection", () => {
  it("reconnects with the same generation every time", async () => {
    const first = new TestLink();
    const second = new TestLink();
    const io = new (class extends TestIo {
      override play(target: TestLink, index: number): void {
        // The first link drops after the welcome; the second is told to shut
        // down, so the loop ends rather than running to exhaustion.
        target.deliver(welcome());
        if (index === 0) {
          target.drop();
          return;
        }
        target.deliver(JSON.stringify({ type: "runtime.shutdown" }));
      }
    })([first, second]);

    const exit = await runBridge(config(), io);

    expect(exit).toEqual({ kind: "shutdown" });
    expect(io.connects.map((connect) => connect.url)).toEqual([
      "wss://oncue.example/ws/bridge/sess_1/3",
      "wss://oncue.example/ws/bridge/sess_1/3",
    ]);
    expect(io.sleeps).toEqual([10]);
    // The second connection's connected event takes the NEXT sequence rather
    // than restarting at zero: the Durable Object admits exactly the next slot
    // for the generation, and a restart would be refused as a duplicate.
    expect(first.sent[1]).toBe(connected(0, 1));
    expect(second.sent[1]).toBe(connected(1, 2));
  });

  it("treats a connect that never opened the same as one that dropped, and logs no detail", async () => {
    const io = new TestIo([
      new Error("ECONNREFUSED wss://oncue.example authorization: Bearer boot-sess_1-g3"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);

    const exit = await runBridge(config(), io);

    expect(exit).toEqual({ kind: "exhausted", attempts: 4 });
    expect(io.logs.join("\n")).not.toContain(IDENTITY.bootstrapCredential);
  });
});

describe("runBridge: many separate outages", () => {
  it("survives far more than eight drops over a session when each link was stable", async () => {
    const drops = 30;
    const links = Array.from({ length: drops + 1 }, () => new TestLink());
    const io = new (class extends TestIo {
      override play(target: TestLink, index: number): void {
        target.deliver(welcome());
        if (index === drops) {
          target.deliver(JSON.stringify({ type: "runtime.shutdown" }));
          return;
        }
        // Up long enough to count as stable, then dropped: a Worker deploy.
        this.clock += 1_000;
        target.pong();
        target.drop(1006);
      }
    })(links);

    await expect(runBridge(config(), io)).resolves.toEqual({ kind: "shutdown" });
    expect(io.connects).toHaveLength(drops + 1);
    // Every outage starts its backoff over.
    expect(io.sleeps).toEqual(Array.from({ length: drops }, () => 10));
  });

  it("gives up on one outage once it outlasts the window, however the attempts end", async () => {
    const io = new (class extends TestIo {
      override play(target: TestLink, index: number): void {
        // Welcomed and dropped at once: not stable, so the outage goes on.
        target.deliver(welcome());
        if (index % 2 === 0) {
          target.drop(4001);
        } else {
          target.drop();
        }
      }
    })(Array.from({ length: 4 }, () => new TestLink()));

    await expect(runBridge(config(), io)).resolves.toEqual({ kind: "exhausted", attempts: 4 });
    expect(io.sleeps).toEqual([10, 20, 40]);
  });

  it("spreads the waits with jitter", async () => {
    const io = new TestIo([
      new Error("down"),
      new Error("down"),
      new Error("down"),
      new Error("down"),
    ]);
    io.jitter = 0;
    await expect(runBridge(config({ reconnectWindowMs: 35 }), io)).resolves.toEqual({
      kind: "exhausted",
      attempts: 4,
    });
    expect(io.sleeps).toEqual([5, 10, 20]);
  });
});

describe("isWorthRetrying", () => {
  it.each([
    ["protocol_version", false],
    ["stale_generation", false],
    ["wrong_session", false],
    ["unauthorized", false],
    ["malformed_reply", true],
  ] as const)("%s -> %s", (reason, expected) => {
    expect(isWorthRetrying(reason)).toBe(expected);
  });
});

describe("planStartup", () => {
  const environment = {
    ONCUE_SESSION_ID: "sess_1",
    ONCUE_SANDBOX_GENERATION: "3",
    ONCUE_CONTROL_PLANE_ORIGIN: "wss://oncue.example",
    ONCUE_BOOTSTRAP_FILE: "/opt/oncue/bootstrap",
  };

  it("reads the identity from the environment and the credential from a file", () => {
    const plan = planStartup(environment, () => "boot-sess_1-g3");

    expect(plan).toEqual({
      kind: "ready",
      config: expect.objectContaining({ identity: IDENTITY }),
    });
  });

  it("falls back to the path the image's entrypoint writes", () => {
    const paths: string[] = [];
    planStartup({ ...environment, ONCUE_BOOTSTRAP_FILE: undefined }, (path) => {
      paths.push(path);
      return "boot-sess_1-g3";
    });

    expect(paths).toEqual(["/opt/oncue/bootstrap"]);
  });

  it.each(["ONCUE_SESSION_ID", "ONCUE_SANDBOX_GENERATION", "ONCUE_CONTROL_PLANE_ORIGIN"] as const)(
    "refuses to start without %s",
    (key) => {
      const plan = planStartup({ ...environment, [key]: undefined }, () => "boot");

      expect(plan).toEqual({ kind: "misconfigured", missing: [key] });
    },
  );

  it("refuses to start with an empty credential file", () => {
    expect(planStartup(environment, () => "")).toEqual({
      kind: "misconfigured",
      missing: ["bootstrap credential"],
    });
  });
});

class RecordingHandler implements SessionHandler {
  linkUps = 0;
  linkDowns = 0;
  outbound: Outbound | null = null;
  readonly frames: Array<Parameters<SessionHandler["onFrame"]>[0]> = [];

  onLinkUp(outbound: Outbound): void {
    this.linkUps += 1;
    this.outbound = outbound;
  }

  onLinkDown(): void {
    this.linkDowns += 1;
  }

  onFrame(frame: Parameters<SessionHandler["onFrame"]>[0]): void {
    this.frames.push(frame);
  }
}

const FRAME_IDENTITY = { sessionId: "sess_1", generation: 3 };

/** Ids are branded strings; a plain object literal needs a cast at this one boundary. */
function shutdownCommand(): DeliverableCommand {
  return {
    commandId: "cmd_1",
    sessionId: "sess_1",
    runId: null,
    issuedAt: "2026-09-11T00:00:00.000Z",
    issuedByUserId: "usr_1",
    expected: { scope: "session", state: "active" },
    type: "runtime.shutdown",
    payload: { reason: "idle", graceMs: 1000 },
  } as unknown as DeliverableCommand;
}

describe("runLink: SessionHandler", () => {
  it("calls onLinkUp with an Outbound only after runtime.connected is sent", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    expect(handler.linkUps).toBe(0);

    link.deliver(welcome());
    expect(handler.linkUps).toBe(1);
    expect(handler.outbound).not.toBeNull();

    link.drop();
    await outcome;
  });

  it("calls onLinkDown when the link drops after being linked up", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());
    link.drop();

    await outcome;
    expect(handler.linkDowns).toBe(1);
  });

  it("never calls onLinkDown when the link never made it past the handshake", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(JSON.stringify({ type: "message.delta" }));

    await outcome;
    expect(handler.linkDowns).toBe(0);
  });

  it("calls onLinkDown once on the legacy runtime.shutdown path", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());
    link.deliver(JSON.stringify({ type: "runtime.shutdown" }));

    await outcome;
    expect(handler.linkDowns).toBe(1);
  });

  it("hands a parsed bridge.command to onFrame after the handshake", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());

    const command = buildCommandFrame(FRAME_IDENTITY, shutdownCommand(), null);
    link.deliver(JSON.stringify(command));

    expect(handler.frames).toEqual([{ kind: "command", frame: command }]);

    link.drop();
    await outcome;
  });

  it("hands a parsed bridge.grant to onFrame after the handshake", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());

    const grant = buildGrantFrame(FRAME_IDENTITY, {
      kind: "model",
      grantId: "grant_1",
      expiresAt: "2026-09-11T00:10:00.000Z",
      token: "ot1.token",
      brokerOrigin: "https://broker.example",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      runtime: "opencode",
      effort: null,
      modelSpec: null,
      workspace: "none",
    });
    link.deliver(JSON.stringify(grant));

    expect(handler.frames).toEqual([{ kind: "grant", frame: grant }]);

    link.drop();
    await outcome;
  });

  it("hands a malformed frame to onFrame when it names another generation", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());

    const command = buildCommandFrame(
      { sessionId: "sess_1", generation: 99 },
      shutdownCommand(),
      null,
    );
    link.deliver(JSON.stringify(command));

    expect(handler.frames).toEqual([
      {
        kind: "malformed",
        ref: { commandId: "cmd_1" },
        detail: "frame named another session or generation",
      },
    ]);

    link.drop();
    await outcome;
  });

  it("does not call onFrame for post-handshake traffic that is not a session frame", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const handler = new RecordingHandler();

    const outcome = runLink(config(), io, link, { next: 0 }, handler);
    link.deliver(welcome());
    link.deliver(JSON.stringify({ type: "message.delta" }));

    expect(handler.frames).toEqual([]);

    link.drop();
    await outcome;
  });

  it("uses the identity thunk to name the runtime in runtime.connected", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const identity: RuntimeIdentity = { runtimeName: "opencode", runtimeVersion: "1.18.30" };

    const outcome = runLink(config(), io, link, { next: 0 }, undefined, () => identity);
    link.deliver(welcome());

    const sent = link.sent[1];
    expect(sent).toBeDefined();
    expect(JSON.parse(sent as string).payload).toMatchObject({
      runtimeName: "opencode",
      runtimeVersion: "1.18.30",
    });

    link.drop();
    await outcome;
  });

  it("defaults to NO_RUNTIME when no identity thunk is given", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);

    const outcome = runLink(config(), io, link);
    link.deliver(welcome());

    const sent = link.sent[1];
    expect(sent).toBeDefined();
    expect(JSON.parse(sent as string).payload).toMatchObject({
      runtimeName: "none",
      runtimeVersion: "none",
    });

    link.drop();
    await outcome;
  });
});

describe("stampDraft", () => {
  function draft(): Draft<"message.started"> {
    return {
      type: "message.started",
      runId: "run_1",
      payload: { messageId: "msg_1", role: "assistant" },
    } as unknown as Draft<"message.started">;
  }

  it("stamps a draft into a full protocol event and advances the cursor", () => {
    const cursor: SequenceCursor = { next: 5 };
    let issued = 0;
    const io = {
      newEventId: () => `evt_${++issued}`,
      now: () => "2026-09-11T00:00:00.000Z",
    };

    const event = stampDraft(config(), cursor, io, draft());

    expect(event).toMatchObject({
      type: "message.started",
      sessionId: "sess_1",
      runId: "run_1",
      sandboxGeneration: 3,
      runtimeSequence: 5,
      occurredAt: "2026-09-11T00:00:00.000Z",
      eventId: "evt_1",
      payload: { messageId: "msg_1", role: "assistant" },
    });
    expect(cursor.next).toBe(6);
  });

  it("advances the cursor on every call, including ephemeral drafts, so a run of them is not seen as a gap", () => {
    const cursor: SequenceCursor = { next: 0 };
    const io = { newEventId: () => "evt_x", now: () => "2026-09-11T00:00:00.000Z" };
    const deltaDraft = {
      type: "message.delta",
      runId: "run_1",
      payload: { messageId: "msg_1", partIndex: 0, part: { type: "text", text: "hi" } },
    } as unknown as Draft<"message.delta">;

    stampDraft(config(), cursor, io, deltaDraft);
    stampDraft(config(), cursor, io, deltaDraft);

    expect(cursor.next).toBe(2);
  });

  it("shares the same cursor runLink uses for runtime.connected", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const cursor: SequenceCursor = { next: 0 };

    const outcome = runLink(config(), io, link, cursor);
    link.deliver(welcome());
    expect(cursor.next).toBe(1);

    const event = stampDraft(config(), cursor, io, draft());
    expect(event.runtimeSequence).toBe(1);
    expect(cursor.next).toBe(2);

    link.drop();
    await outcome;
  });
});

describe("devSupervisorPlan", () => {
  it("is null when ONCUE_DEV_SUPERVISOR is unset, which is every sandbox boot", () => {
    const env: DevSupervisorEnv = {};
    expect(devSupervisorPlan(env)).toBeNull();
  });

  it("is null for any value other than the literal 'inprocess'", () => {
    const env: DevSupervisorEnv = {
      ONCUE_DEV_SUPERVISOR: "socket",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/ws",
    };
    expect(devSupervisorPlan(env)).toBeNull();
  });

  it("throws when inprocess is asked for without both dev paths", () => {
    expect(() => devSupervisorPlan({ ONCUE_DEV_SUPERVISOR: "inprocess" })).toThrow(
      /ONCUE_DEV_OPENCODE_BIN/,
    );
    expect(() =>
      devSupervisorPlan({
        ONCUE_DEV_SUPERVISOR: "inprocess",
        ONCUE_DEV_OPENCODE_BIN: "/tmp/opencode",
      }),
    ).toThrow(/ONCUE_DEV_WORKSPACE/);
  });

  it("adds Codex under the runtime host when ONCUE_DEV_CODEX_BIN names one", () => {
    const plan = devSupervisorPlan({
      ONCUE_DEV_SUPERVISOR: "inprocess",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
      ONCUE_DEV_CODEX_BIN: "/tmp/sandbox-home/bin/codex",
    });
    expect(plan?.overrides.runtimeBinaries).toEqual({ codex: "/tmp/sandbox-home/bin/codex" });
    expect(plan?.overrides.runtimeHost?.node).toBe(process.execPath);
    expect(plan?.overrides.runtimeHost?.host).toMatch(/runtime-host\.mjs$/);
    expect(plan?.overrides.runtimeExtension).toBeUndefined();
  });

  it("adds Pi under the runtime host, with OnCue's extension from the same build, when ONCUE_DEV_PI_BIN names one", () => {
    const plan = devSupervisorPlan({
      ONCUE_DEV_SUPERVISOR: "inprocess",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
      ONCUE_DEV_PI_BIN: "/tmp/sandbox-home/bin/pi",
    });
    expect(plan?.overrides.runtimeBinaries).toEqual({ pi: "/tmp/sandbox-home/bin/pi" });
    expect(plan?.overrides.runtimeHost?.host).toMatch(/runtime-host\.mjs$/);
    expect(plan?.overrides.runtimeExtension).toMatch(/pi-extension\.mjs$/);
  });

  it("adds Claude Code under the runtime host when ONCUE_DEV_CLAUDE_BIN names one", () => {
    const plan = devSupervisorPlan({
      ONCUE_DEV_SUPERVISOR: "inprocess",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
      ONCUE_DEV_CLAUDE_BIN: "/tmp/sandbox-home/bin/claude",
    });
    expect(plan?.overrides.runtimeBinaries).toEqual({ claude: "/tmp/sandbox-home/bin/claude" });
    expect(plan?.overrides.runtimeHost?.host).toMatch(/runtime-host\.mjs$/);
    expect(plan?.overrides.runtimeExtension).toBeUndefined();
  });

  it("derives the runtime overrides and a connector from the two dev paths", async () => {
    const plan = devSupervisorPlan({
      ONCUE_DEV_SUPERVISOR: "inprocess",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
    });
    expect(plan).not.toBeNull();
    expect(plan?.overrides).toEqual({
      attachmentsRoot: "/tmp/sandbox-home/attachments",
      workspaceDir: "/tmp/sandbox-home/workspace",
      runtimeBinary: "/tmp/sandbox-home/bin/opencode",
      runtimeHome: "/tmp/sandbox-home",
      secretsDir: "/tmp/sandbox-home/secrets",
      checkpointDir: "/tmp/sandbox-home/checkpoint",
      checkOutputDir: "/tmp/sandbox-home/checks",
      baseTreeRoot: "/tmp/sandbox-home/base",
    });
    const supervisor = await plan?.connect();
    expect(supervisor?.close).toBeTypeOf("function");
    supervisor?.close();
  });

  it("carries ONCUE_DEV_RUNTIME_PORT as the harness port, and refuses one that is not a TCP port", () => {
    const base = {
      ONCUE_DEV_SUPERVISOR: "inprocess",
      ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
      ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
    };
    expect(
      devSupervisorPlan({ ...base, ONCUE_DEV_RUNTIME_PORT: "51234" })?.overrides.runtimePort,
    ).toBe(51_234);
    for (const bad of ["0", "65536", "4096.5", "port"]) {
      expect(() => devSupervisorPlan({ ...base, ONCUE_DEV_RUNTIME_PORT: bad })).toThrow(
        /ONCUE_DEV_RUNTIME_PORT must be a TCP port/,
      );
    }
  });
});

describe("resolveDevSupervisorPlan", () => {
  const inprocess = {
    ONCUE_DEV_SUPERVISOR: "inprocess",
    ONCUE_DEV_OPENCODE_BIN: "/tmp/sandbox-home/bin/opencode",
    ONCUE_DEV_WORKSPACE: "/tmp/sandbox-home/workspace",
  };

  it("picks nothing in a sandbox, where the harness keeps the image's fixed port", async () => {
    let picked = 0;
    const plan = await resolveDevSupervisorPlan({}, async () => {
      picked += 1;
      return 51_234;
    });
    expect(plan).toBeNull();
    expect(picked).toBe(0);
  });

  it("picks a port of its own on the dev host when none was given, for every harness", async () => {
    const plan = await resolveDevSupervisorPlan(
      { ...inprocess, ONCUE_DEV_CODEX_BIN: "/tmp/sandbox-home/bin/codex" },
      async () => 51_234,
    );
    expect(plan?.overrides.runtimePort).toBe(51_234);
    expect(plan?.overrides.runtimeBinaries).toEqual({ codex: "/tmp/sandbox-home/bin/codex" });
  });

  it("keeps the port the controller double picked", async () => {
    let picked = 0;
    const plan = await resolveDevSupervisorPlan(
      { ...inprocess, ONCUE_DEV_RUNTIME_PORT: "40001" },
      async () => {
        picked += 1;
        return 51_234;
      },
    );
    expect(plan?.overrides.runtimePort).toBe(40_001);
    expect(picked).toBe(0);
  });

  it("picks from the real loopback by default: a port nothing holds, different each bridge", async () => {
    const first = await freeLoopbackPort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(first, "127.0.0.1", resolve));
    try {
      const second = await freeLoopbackPort();
      expect(second).not.toBe(first);
      expect(second).toBeGreaterThan(0);
      const plan = await resolveDevSupervisorPlan(inprocess);
      expect(plan?.overrides.runtimePort).toBeGreaterThan(0);
      expect(plan?.overrides.runtimePort).not.toBe(first);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("nodeBridgeIo over a real WebSocket", () => {
  async function serve(): Promise<{ server: WebSocketServer; url: string }> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { server, url: `ws://127.0.0.1:${port}/ws/bridge/sess_1/3` };
  }

  it("answers a ping with a pong, passes the close code through, and terminates at once", async () => {
    const { server, url } = await serve();
    try {
      const sockets: import("ws").WebSocket[] = [];
      server.on("connection", (socket) => sockets.push(socket));
      const io = nodeBridgeIo();
      const link = await io.connect(url, { authorization: "Bearer x" });
      const pong = new Promise<void>((resolve) => link.onPong?.(resolve));
      link.ping?.();
      await pong;

      const code = new Promise<number | undefined>((resolve) => link.onClose(resolve));
      sockets[0]?.close(4000, "stale generation");
      await expect(code).resolves.toBe(4000);

      const second = await io.connect(url, {});
      const closed = new Promise<number | undefined>((resolve) => second.onClose(resolve));
      second.terminate?.();
      await expect(closed).resolves.toBe(1006);
      expect(typeof io.nowMs?.()).toBe("number");
      const unit = io.random?.() ?? -1;
      expect(unit >= 0 && unit < 1).toBe(true);
      expect(HANDSHAKE_TIMEOUT_MS).toBe(20_000);
    } finally {
      server.close();
    }
  });

  it("rejects a connect that never opens", async () => {
    const { server, url } = await serve();
    server.close();
    await expect(nodeBridgeIo().connect(url, {})).rejects.toBeDefined();
  });
});

describe("runLink over a real socket that goes half-open", () => {
  it("drops the link after its pings stop being answered, without waiting for a close", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const serverAddress = server.address();
    const serverPort =
      typeof serverAddress === "object" && serverAddress !== null ? serverAddress.port : 0;
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { type: string };
        if (frame.type === "bridge.hello") {
          socket.send(welcome());
        }
      });
    });
    // A proxy that can stop carrying bytes without closing anything.
    const pairs: { client: Socket; upstream: Socket }[] = [];
    const proxy = createServer((client) => {
      const upstream = connectTcp(serverPort, "127.0.0.1");
      client.pipe(upstream);
      upstream.pipe(client);
      pairs.push({ client, upstream });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyAddress = proxy.address();
    const proxyPort =
      typeof proxyAddress === "object" && proxyAddress !== null ? proxyAddress.port : 0;
    try {
      const io = nodeBridgeIo();
      const settings = config({ heartbeatIntervalMs: 50 });
      const link = await io.connect(`ws://127.0.0.1:${proxyPort}/ws/bridge/sess_1/3`, {});
      const pongs: number[] = [];
      link.onPong?.(() => pongs.push(Date.now()));
      const logs: string[] = [];
      const outcome = runLink(settings, { ...io, log: (line) => logs.push(line) }, link);
      // Answered pings first, then silence.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pongs.length).toBeGreaterThan(0);
      for (const pair of pairs) {
        pair.client.unpipe(pair.upstream);
        pair.upstream.unpipe(pair.client);
        pair.client.pause();
        pair.upstream.pause();
      }
      await expect(outcome).resolves.toEqual({ kind: "disconnected" });
      expect(logs).toContain(
        "bridge dropped a link that stopped answering: no answer to the last pings",
      );
    } finally {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      proxy.close();
      server.close();
    }
  });
});
