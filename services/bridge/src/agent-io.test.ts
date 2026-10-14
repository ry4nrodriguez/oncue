import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolEvent } from "@oncue/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentInput,
  type HealthOutcome,
  LOG_GRANT_WAIT_MS,
  type PromptOutcome,
} from "./agent";
import {
  type AgentAdapters,
  commitMissingText,
  createAgentHost,
  createCommitAnswers,
  HEALTH_PROBE_WATCHDOG_MS,
  OUTBOX_RING,
  RESTORE_PATCH_NAME,
  type RuntimeOverrides,
  runBridgeWith,
} from "./agent-io";
import {
  type ArtifactIo,
  type DownloadRequest,
  type DownloadResult,
  sha256Hex,
  type UploadRequest,
} from "./checkpoint";
import {
  type AckFrame,
  buildCommandFrame,
  buildGrantFrame,
  type DeliverableCommand,
  type ModelGrantFrame,
} from "./frames";
import type { GitProcessResult } from "./git";
import type { RuntimeEvent } from "./normalize";
import type { OpenCodeClient } from "./opencode";
import { OPENCODE_PORT } from "./opencode";
import { RESOURCE_MAX_CHARS } from "./permissions";
import {
  type BridgeConfig,
  type BridgeIo,
  type BridgeLink,
  bridgeConfig,
  type Outbound,
  type SequenceCursor,
} from "./protocol";
import type { QuestionReply } from "./questions";
import type { PromptTurn } from "./runtime";
import type {
  AgentExit,
  StartAgentRequest,
  SupervisorClient,
  SupervisorOutcome,
} from "./supervisor-client";
import type { CheckExit } from "./supervisor-protocol";

const IDENTITY = { sessionId: "sess_1", generation: 3 };
const TOKEN = "ot1.secret.token";
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5" };

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ...bridgeConfig({ ...IDENTITY, bootstrapCredential: "boot-cred" }, "wss://oncue.example", {
      reconnectBaseDelayMs: 1,
      // With the test clock below, attempts wait 1 and 2 ms and the third
      // ending is past the window.
      reconnectWindowMs: 3,
    }),
    ...overrides,
  };
}

class Deferred<T> {
  resolve!: (value: T) => void;
  readonly promise = new Promise<T>((resolve) => {
    this.resolve = resolve;
  });
}

class FakeSupervisor implements SupervisorClient {
  readonly chowns: number[] = [];
  readonly starts: StartAgentRequest[] = [];
  readonly signals: string[] = [];
  readonly exit = new Deferred<SupervisorOutcome<AgentExit>>();
  startOutcome: SupervisorOutcome<{ pid: number }> = { kind: "ok", value: { pid: 42 } };
  chownOutcome: SupervisorOutcome<void> = { kind: "ok", value: undefined };
  closed = false;

  async chownWorkspace(uid: number): Promise<SupervisorOutcome<void>> {
    this.chowns.push(uid);
    return this.chownOutcome;
  }
  async startAgent(request: StartAgentRequest): Promise<SupervisorOutcome<{ pid: number }>> {
    this.starts.push(request);
    return this.startOutcome;
  }
  async signal(signal: "SIGTERM" | "SIGKILL"): Promise<SupervisorOutcome<void>> {
    this.signals.push(signal);
    return { kind: "ok", value: undefined };
  }
  wait(): Promise<SupervisorOutcome<AgentExit>> {
    return this.exit.promise;
  }
  async runCheck(): Promise<SupervisorOutcome<CheckExit>> {
    return { kind: "unreachable" };
  }
  async signalCheck(): Promise<SupervisorOutcome<void>> {
    return { kind: "unreachable" };
  }
  async prepareBase(): Promise<SupervisorOutcome<void>> {
    return { kind: "unreachable" };
  }
  readonly attachmentDirs: string[] = [];
  attachmentsOutcome: SupervisorOutcome<void> = { kind: "ok", value: undefined };
  async prepareAttachments(dir: string): Promise<SupervisorOutcome<void>> {
    this.attachmentDirs.push(dir);
    return this.attachmentsOutcome;
  }
  /** Names only: a test that asserts on what was written never needs the value kept. */
  readonly secretNames: string[] = [];
  secretOutcome: SupervisorOutcome<void> = { kind: "ok", value: undefined };
  secretsCleared = 0;
  async writeSecret(name: string): Promise<SupervisorOutcome<void>> {
    this.secretNames.push(name);
    return this.secretOutcome;
  }
  async clearSecrets(): Promise<SupervisorOutcome<void>> {
    this.secretsCleared += 1;
    return { kind: "ok", value: undefined };
  }
  secretPath(name: string): string {
    return `/var/lib/oncue/secrets/${name}`;
  }
  close(): void {
    this.closed = true;
  }
}

class FakeOpenCode implements OpenCodeClient {
  readonly healths: number[] = [];
  readonly prompts: { port: number; sessionId: string | null; title: string; text: string }[] = [];
  readonly aborts: { port: number; sessionId: string }[] = [];
  readonly subscriptions: {
    port: number;
    deliver: (event: Parameters<Parameters<OpenCodeClient["subscribe"]>[1]>[0]) => void;
    end: () => void;
    /** What the stream awaits before each read: the bridge's backpressure. */
    room: (() => Promise<void>) | undefined;
  }[] = [];
  healthAnswer: HealthOutcome = { kind: "healthy", version: "1.18.30" };
  promptAnswer: PromptOutcome = { kind: "held", conversation: "ses_1" };

  async health(port: number): Promise<HealthOutcome> {
    this.healths.push(port);
    return this.healthAnswer;
  }
  /** The file parts each prompt carried, kept beside `prompts` so that array keeps its shape. */
  readonly promptFiles: unknown[][] = [];
  async prompt(port: number, turn: PromptTurn): Promise<PromptOutcome> {
    this.prompts.push({ port, sessionId: turn.conversation, title: turn.title, text: turn.text });
    this.promptFiles.push([...(turn.files ?? [])]);
    return this.promptAnswer;
  }
  async abort(port: number, sessionId: string): Promise<boolean> {
    this.aborts.push({ port, sessionId });
    return true;
  }
  readonly replies: { requestId: string; reply: string; message: string | null }[] = [];
  replyOk = true;
  async replyHeld(
    _port: number,
    requestId: string,
    reply: "once" | "reject",
    message: string | null,
  ): Promise<boolean> {
    this.replies.push({ requestId, reply, message });
    return this.replyOk;
  }
  readonly questionReplies: { requestId: string; reply: QuestionReply }[] = [];
  async replyQuestion(_port: number, requestId: string, reply: QuestionReply): Promise<boolean> {
    this.questionReplies.push({ requestId, reply });
    return this.replyOk;
  }
  /** What `GET /question` lists: questions OpenCode is still waiting on. */
  pending: RuntimeEvent[] = [];
  readonly pendingReads: number[] = [];
  async pendingQuestions(port: number): Promise<RuntimeEvent[]> {
    this.pendingReads.push(port);
    return this.pending;
  }
  subscribe(
    port: number,
    onEvent: Parameters<OpenCodeClient["subscribe"]>[1],
    _signal?: AbortSignal,
    _log?: (line: string) => void,
    room?: () => Promise<void>,
  ): Promise<void> {
    const ended = new Deferred<void>();
    this.subscriptions.push({ port, deliver: onEvent, end: () => ended.resolve(), room });
    // What a real stream sends first (opencode.ai/docs/server): the bridge
    // reports ready only once it has heard this.
    onEvent({ kind: "server_connected" });
    return ended.promise;
  }
}

class FakeRelay {
  readonly port = 5001;
  readonly tokens: { token: string; expiresAt: string; brokerOrigin: string }[] = [];
  setToken(token: string, expiresAt: string, brokerOrigin: string): void {
    this.tokens.push({ token, expiresAt, brokerOrigin });
  }
}

/** Waits this long are a card's deadline, at least the grace past an expiry. */
const APPROVAL_TIMER_FLOOR_MS = 5 * 60 * 1000;

class TestIo implements BridgeIo {
  readonly logs: string[] = [];
  readonly sleeps: number[] = [];
  private issued = 0;
  constructor(private readonly links: TestLink[] = []) {}
  connected = 0;
  async connect(): Promise<BridgeLink> {
    this.connected += 1;
    const next = this.links.shift();
    if (next === undefined) {
      throw new Error("no link");
    }
    setTimeout(
      () =>
        next.deliver(
          JSON.stringify({
            type: "bridge.welcome",
            protocolVersion: 1,
            sessionId: "sess_1",
            sandboxGeneration: 3,
          }),
        ),
      0,
    );
    return next;
  }
  /** Every link's heartbeat timer, newest last; a test fires one by calling it. */
  readonly ticks: (() => void)[] = [];
  startHeartbeat(_intervalMs: number, tick: () => void): () => void {
    this.ticks.push(tick);
    return () => {};
  }
  /** Watchdog waits are held until a test releases one and are counted apart from the probe chain's own sleeps; every other wait resolves at once. */
  readonly watchdogs: (() => void)[] = [];
  async sleep(ms: number): Promise<void> {
    if (ms === HEALTH_PROBE_WATCHDOG_MS) {
      await new Promise<void>((resolve) => this.watchdogs.push(resolve));
      return;
    }
    if (ms > APPROVAL_TIMER_FLOOR_MS) {
      // A card's backstop deadline never passes on its own here; a test that
      // wants it passes an expiry already gone.
      await new Promise<void>(() => {});
    }
    if (ms === LOG_GRANT_WAIT_MS) {
      // An upload's deadline never passes here, so a test's grant always finds the staged bytes.
      await new Promise<void>(() => {});
    }
    this.sleeps.push(ms);
    this.clock += ms;
  }
  /** Advances only by the waits above, so a reconnect window is crossed by sleeping through it. */
  clock = 0;
  nowMs(): number {
    return this.clock;
  }
  /** The top of the jitter range, so the reconnect waits are the capped exponential itself. */
  random(): number {
    return 1;
  }
  log(line: string): void {
    this.logs.push(line);
  }
  newEventId(): string {
    this.issued += 1;
    return `evt_${this.issued}`;
  }
  now(): string {
    return "2026-09-11T00:00:00.000Z";
  }
}

class TestLink implements BridgeLink {
  readonly sent: string[] = [];
  closed = false;
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  deliver(data: string): void {
    this.messageListener?.(data);
  }
  drop(): void {
    this.closeListener?.();
  }
}

class RecordingOutbound implements Outbound {
  readonly events: ProtocolEvent[] = [];
  readonly acks: AckFrame[] = [];
  sendEvent(event: ProtocolEvent): void {
    this.events.push(event);
  }
  sendAck(frame: AckFrame): void {
    this.acks.push(frame);
  }
}

/**
 * `startAt` is where the sequence cursor begins, as it does for a bridge that
 * reconnected partway through a generation. A ring that starts above the
 * sequence the object asks for is the state that cannot answer a replay.
 */
function harness(startAt = 0, overrides: RuntimeOverrides = {}, artifacts = fakeArtifacts()) {
  const supervisor = new FakeSupervisor();
  const opencode = new FakeOpenCode();
  const relay = new FakeRelay();
  const io = new TestIo();
  const cursor: SequenceCursor = { next: startAt };
  const adapters: AgentAdapters = {
    supervisor,
    runtime: opencode,
    tools: { port: 5002 },
    commits: { answer: () => undefined },
    git: {
      runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
      revoke: async () => ({ ok: true, status: 204 }),
      env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
      askpassPath: "/opt/oncue/askpass",
    },
    files: { readFile: () => null, exists: () => false },
    relay,
    artifacts,
  };
  const host = createAgentHost(config(), io, cursor, adapters, overrides);
  return { host, supervisor, opencode, relay, io, cursor };
}

function fakeArtifacts(): ArtifactIo {
  return {
    upload: async () => ({ ok: true, status: 201 }),
    download: async () => ({ kind: "failed", status: 404 }),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function modelGrant(overrides: Partial<ModelGrantFrame> = {}): AgentInput {
  return {
    kind: "frame",
    frame: {
      kind: "grant",
      frame: buildGrantFrame(IDENTITY, {
        kind: "model",
        grantId: "grant_model",
        expiresAt: "2026-09-11T00:10:00.000Z",
        token: TOKEN,
        effort: null,
        modelSpec: null,
        brokerOrigin: "https://oncue.example",
        model: MODEL,
        runtime: "opencode",
        workspace: "none",
        ...overrides,
      }),
    },
  };
}

function command(
  type: DeliverableCommand["type"],
  payload: Record<string, unknown>,
  commandId: string,
  runId: string | null = "run_1",
): AgentInput {
  return {
    kind: "frame",
    frame: {
      kind: "command",
      frame: buildCommandFrame(
        IDENTITY,
        {
          commandId,
          sessionId: "sess_1",
          runId: type === "run.start" ? null : runId,
          issuedAt: "2026-09-11T00:00:00.000Z",
          issuedByUserId: "usr_1",
          expected: { scope: "session", state: "active" },
          type,
          payload,
        } as unknown as DeliverableCommand,
        runId,
      ),
    },
  };
}

const runStart = () =>
  command(
    "run.start",
    {
      instruction: { messageId: "msg_1", text: "Do it", attachments: [] },
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        modelConnectionId: "c",
        authenticationType: "api_key",
        contextWindow: null,
        effort: null,
      },
      continuesRunId: null,
    },
    "cmd_start",
  );

/** Boot the host through the fakes until OpenCode is ready. */
async function booted(startAt = 0, overrides: RuntimeOverrides = {}) {
  const h = harness(startAt, overrides);
  const outbound = new RecordingOutbound();
  h.host.handler.onLinkUp(outbound);
  h.host.offer(modelGrant());
  await tick();
  await tick();
  return { ...h, outbound };
}

describe("createAgentHost: boot through the adapters", () => {
  it("hands the token to the relay only, starts the agent through the supervisor, probes health, subscribes, and reports ready", async () => {
    const h = await booted();

    expect(h.relay.tokens).toEqual([
      {
        token: TOKEN,
        expiresAt: "2026-09-11T00:10:00.000Z",
        brokerOrigin: "https://oncue.example",
      },
    ]);
    expect(h.supervisor.starts).toHaveLength(1);
    expect(h.supervisor.starts[0]?.argv[0]).toBe("/opt/opencode/opencode");
    expect(h.opencode.healths).toEqual([OPENCODE_PORT]);
    expect(h.opencode.subscriptions.map((s) => s.port)).toEqual([OPENCODE_PORT]);
    expect(h.io.sleeps).toEqual([0]);
    expect(h.outbound.acks).toEqual([
      {
        type: "bridge.ack",
        sessionId: "sess_1",
        sandboxGeneration: 3,
        ref: { grantId: "grant_model" },
        outcome: { kind: "accepted" },
      },
    ]);
    expect(h.outbound.events.map((event) => event.type)).toEqual(["runtime.ready"]);
    expect(h.outbound.events[0]).toMatchObject({
      runtimeSequence: 0,
      payload: { runtimeName: "opencode", runtimeVersion: "1.18.30" },
    });
    expect(h.host.identity()).toEqual({ runtimeName: "opencode", runtimeVersion: "1.18.30" });
    expect(h.host.snapshot().runtime).toEqual({
      kind: "ready",
      version: "1.18.30",
      port: OPENCODE_PORT,
    });
    expect(JSON.stringify(h.host.snapshot())).not.toContain(TOKEN);
    expect(h.io.logs.join("\n")).not.toContain(TOKEN);
  });

  it("reports NO_RUNTIME until health answered", () => {
    const h = harness();
    expect(h.host.identity()).toEqual({ runtimeName: "none", runtimeVersion: "none" });
  });

  it("a health probe that is not yet answered sleeps the interval and probes again", async () => {
    const h = harness();
    h.opencode.healthAnswer = { kind: "not_yet", detail: "refused" };
    h.host.handler.onLinkUp(new RecordingOutbound());
    h.host.offer(modelGrant());
    await tick();
    await tick();
    await tick();
    expect(h.io.sleeps.slice(0, 3)).toEqual([0, 250, 250]);
    expect(h.opencode.healths.length).toBeGreaterThan(1);
  });

  it("a health probe that never settles is rescued by the watchdog and the chain continues", async () => {
    const h = harness();
    h.opencode.health = () => new Promise<never>(() => {});
    h.host.handler.onLinkUp(new RecordingOutbound());
    h.host.offer(modelGrant());
    await tick();
    await tick();
    expect(h.io.watchdogs).toHaveLength(1);
    h.io.watchdogs[0]?.();
    await tick();
    await tick();
    expect(h.io.logs.some((line) => line.includes("probe watchdog"))).toBe(true);
    expect(h.io.watchdogs.length).toBeGreaterThan(1);
  });
  it("a refused start reaches the reducer as a failed runtime_started", async () => {
    const h = harness();
    h.supervisor.startOutcome = { kind: "refused", denial: "binary_not_allowed" };
    const outbound = new RecordingOutbound();
    h.host.handler.onLinkUp(outbound);
    h.host.offer(modelGrant());
    await tick();
    expect(h.host.snapshot().runtime).toEqual({ kind: "exited", code: null });
    expect(outbound.events[0]).toMatchObject({
      type: "runtime.disconnected",
      payload: { detail: "boot failed: start: refused: binary_not_allowed" },
    });
  });

  it("chown is asked of the supervisor and its answer fed back", async () => {
    const h = harness();
    h.supervisor.chownOutcome = { kind: "failed", detail: "EPERM" };
    const inputs: AgentInput[] = [];
    const original = h.host.offer;
    // Drive the effect directly: the reducer emits chown_workspace only after a clone.
    h.host.handler.onLinkUp(new RecordingOutbound());
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "git",
          grantId: "g",
          expiresAt: "2026-09-11T01:00:00.000Z",
          token: "ghs_x",
          repository: { fullName: "a/b", cloneUrl: "https://x" },
          branch: "b",
          taskBranch: "b",
          baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
          headSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
          restore: null,
        }),
      },
    });
    await tick();
    // The placeholder clone rejects; the interpreter turns that into a failed clone_settled, never a throw.
    expect(h.host.snapshot().workspace.kind).toBe("failed");
    expect(inputs).toEqual([]);
    expect(original).toBe(h.host.offer);
  });
});

describe("createAgentHost: a run", () => {
  it("prompts OpenCode on the runtime's port, feeds the 204 back, and emits run.started", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    expect(h.opencode.prompts).toEqual([
      { port: OPENCODE_PORT, sessionId: null, title: "OnCue run run_1", text: "Do it" },
    ]);
    expect(h.outbound.acks.at(-1)).toMatchObject({
      ref: { commandId: "cmd_start" },
      outcome: { kind: "accepted" },
    });
    expect(h.outbound.events.map((event) => event.type)).toEqual(["runtime.ready", "run.started"]);
    expect(h.host.snapshot().run).toMatchObject({
      kind: "active",
      phase: "running",
      conversation: "ses_1",
    });
  });

  it("delivers subscribed OpenCode events to the reducer, stamping every draft in sequence", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.opencode.subscriptions[0]?.deliver({
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "Hi",
    });
    h.opencode.subscriptions[0]?.deliver({ kind: "session_idle" });
    // The script never completed the message; the normalizer closes it at
    // idle so the timeline holds no message.started without its end.
    expect(h.outbound.events.map((event) => [event.type, event.runtimeSequence])).toEqual([
      ["runtime.ready", 0],
      ["run.started", 1],
      ["message.started", 2],
      ["message.delta", 3],
      ["message.completed", 4],
      ["run.completed", 5],
    ]);
    expect(h.host.snapshot().run).toEqual({ kind: "idle" });
  });

  it("re-subscribes after the stream ends while the runtime is up", async () => {
    const h = await booted();
    h.opencode.subscriptions[0]?.end();
    await tick();
    await tick();
    expect(h.opencode.subscriptions).toHaveLength(2);
    expect(h.io.sleeps).toContain(500);
  });

  it("cancel aborts the session, and a model failure from the relay pauses the run", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.host.offer({
      kind: "model_failure",
      failure: { category: "authentication_failed", message: "revoked" },
    });
    await tick();
    expect(h.opencode.aborts).toEqual([{ port: OPENCODE_PORT, sessionId: "ses_1" }]);
    expect(h.outbound.events.at(-1)).toMatchObject({
      type: "run.paused",
      payload: { reason: "model_failure" },
    });
  });

  it("the agent's exit reaches the reducer through wait", async () => {
    const h = await booted();
    h.supervisor.exit.resolve({ kind: "ok", value: { code: 1, signal: null } });
    await tick();
    expect(h.host.snapshot().runtime).toEqual({ kind: "exited", code: 1 });
    expect(h.outbound.events.at(-1)).toMatchObject({
      type: "runtime.disconnected",
      payload: { reason: "runtime_crashed", exitCode: 1 },
    });
    expect(h.host.identity()).toEqual({ runtimeName: "none", runtimeVersion: "none" });
  });

  it("runtime.shutdown signals SIGTERM and closes the link once the agent has exited", async () => {
    const h = await booted();
    let closed = 0;
    h.host.installLinkCloser(() => {
      closed += 1;
    });
    h.host.offer(command("runtime.shutdown", { reason: "idle", graceMs: 1000 }, "cmd_stop", null));
    await tick();
    expect(h.supervisor.signals).toEqual(["SIGTERM"]);
    expect(closed).toBe(0);
    h.supervisor.exit.resolve({ kind: "ok", value: { code: 0, signal: "SIGTERM" } });
    await tick();
    expect(closed).toBe(1);
  });

  it("shutdown() aborts the subscription and SIGTERMs a live runtime", async () => {
    const h = await booted();
    await h.host.shutdown();
    expect(h.supervisor.signals).toEqual(["SIGTERM"]);
  });
});

describe("createAgentHost: composer attachments", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fetchFor = (artifactId: string, name: string, contentType: string, byteSize: number) => ({
    artifactId,
    name,
    contentType,
    byteSize,
    url: `https://oncue.example/api/sessions/sess_1/attachments/${artifactId}/content`,
    token: `tok_${artifactId}`,
  });

  it("fetches each attachment with its token, places it, hands it to the agent, then prompts with the image and the list", async () => {
    const root = mkdtempSync(join(tmpdir(), "oncue-attach-"));
    roots.push(root);
    const downloads: string[] = [];
    const h = harness(
      0,
      { attachmentsRoot: root },
      {
        upload: async () => ({ ok: true, status: 201 }),
        download: async (request) => {
          downloads.push(request.token);
          return request.url.includes("att_1")
            ? { kind: "ok", bytes: PNG }
            : { kind: "ok", bytes: Buffer.from("# notes\n") };
        },
      },
    );
    const outbound = new RecordingOutbound();
    h.host.handler.onLinkUp(outbound);
    h.host.offer(
      modelGrant({
        modelSpec: {
          name: "Claude Opus 5.5",
          contextWindow: 1_000_000,
          maxOutput: 128_000,
          effortLevels: null,
          imageInput: true,
        },
      }),
    );
    await tick();
    await tick();
    const start = runStart() as Extract<AgentInput, { kind: "frame" }>;
    const inner = start.frame as Extract<typeof start.frame, { kind: "command" }>;
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "command",
        frame: {
          ...inner.frame,
          attachments: [
            fetchFor("att_1", "screen.png", "image/png", PNG.byteLength),
            fetchFor("att_2", "notes.md", "text/markdown", 8),
          ],
        },
      },
    });
    // Real directories and files: wait for the prompt rather than count ticks.
    await vi.waitFor(() => expect(h.opencode.prompts).toHaveLength(1));

    expect(downloads).toEqual(["tok_att_1", "tok_att_2"]);
    expect(h.supervisor.attachmentDirs).toHaveLength(1);
    const dir = h.supervisor.attachmentDirs[0] as string;
    expect(dir.startsWith(`${root}/mmsg_1-`)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["1-screen.png", "2-notes.md"]);
    expect(h.opencode.promptFiles).toEqual([
      [
        {
          type: "file",
          mime: "image/png",
          url: `file://${dir}/1-screen.png`,
          filename: "screen.png",
        },
      ],
    ]);
    const text = h.opencode.prompts[0]?.text ?? "";
    expect(text.startsWith("Do it\n\nThe user attached these files.")).toBe(true);
    expect(text).toContain(`${dir}/2-notes.md (text/markdown, 8 B)`);
    // The committed run keeps the person's own words.
    expect(h.host.snapshot().run).toMatchObject({ kind: "active" });
    expect(h.io.logs.join("\n")).not.toContain("tok_att_");
  });

  it("prompts with no attachment note and no files for a message without any", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    expect(h.opencode.promptFiles).toEqual([[]]);
    expect(h.supervisor.attachmentDirs).toEqual([]);
  });
});

describe("createAgentHost: the outbox ring", () => {
  it("parks durable events while the link is down, drops ephemeral ones, and flushes on link up in order", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.host.handler.onLinkDown();
    h.opencode.subscriptions[0]?.deliver({
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: "Hi",
    });
    h.opencode.subscriptions[0]?.deliver({ kind: "session_idle" });
    expect(h.outbound.events.map((event) => event.type)).toEqual(["runtime.ready", "run.started"]);

    const next = new RecordingOutbound();
    h.host.handler.onLinkUp(next);
    // The ephemeral message.delta was dropped while the link was down before
    // it took a sequence slot, so the object sees no gap; the
    // message.completed the normalizer synthesised at idle is durable and
    // flushes with the rest, and the link's own runtime.connected follows them.
    expect(next.events.map((event) => [event.type, event.runtimeSequence])).toEqual([
      ["message.started", 2],
      ["message.completed", 3],
      ["run.completed", 4],
    ]);
  });

  it("drops an ack while the link is down: the object redelivers and gets the replay", async () => {
    const h = await booted();
    h.host.handler.onLinkDown();
    h.host.offer(runStart());
    await tick();
    const next = new RecordingOutbound();
    h.host.handler.onLinkUp(next);
    expect(next.acks).toEqual([]);
    h.host.offer(runStart());
    expect(next.acks).toEqual([
      {
        type: "bridge.ack",
        sessionId: "sess_1",
        sandboxGeneration: 3,
        ref: { commandId: "cmd_start" },
        outcome: { kind: "accepted" },
      },
    ]);
  });

  it("replayFrom re-sends every durable event from that sequence, and logs when the ring cannot reach back", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.host.replayFrom(1);
    expect(h.outbound.events.map((event) => [event.type, event.runtimeSequence])).toEqual([
      ["runtime.ready", 0],
      ["run.started", 1],
      ["run.started", 1],
    ]);
    expect(h.io.logs.some((line) => line.includes("cannot replay"))).toBe(false);
  });

  /** A durable `message.started` per call, each in a new message. */
  function startMessages(h: Awaited<ReturnType<typeof booted>>, count: number, from = 0): void {
    for (let index = from; index < from + count; index += 1) {
      h.opencode.subscriptions[0]?.deliver({
        kind: "text_delta",
        messageId: `m${index}`,
        partId: `p${index}`,
        text: "x",
      });
    }
  }

  function durableSequences(events: readonly ProtocolEvent[]): number[] {
    return events
      .filter((event) => event.type !== "message.delta")
      .map((event) => event.runtimeSequence as number);
  }

  it("never evicts a durable event that was not sent, however long the link is down", async () => {
    const ring = 16;
    const h = await booted(0, { outboxRing: ring });
    h.host.offer(runStart());
    await tick();
    h.host.handler.onLinkDown();
    startMessages(h, ring * 4);

    const next = new RecordingOutbound();
    h.host.handler.onLinkUp(next);
    const flushed = next.events.filter((event) => event.type === "message.started");
    expect(flushed).toHaveLength(ring * 4);
    // Every durable event since the drop arrives, in order, with no hole.
    const sequences = durableSequences(next.events);
    expect(sequences[0]).toBe(2);
    expect(
      sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)),
    ).toBe(true);
  });

  it("keeps the newest sent events, streamed ones too, for replay once they pass the ring", async () => {
    const ring = 16;
    const h = await booted(0, { outboxRing: ring });
    h.host.offer(runStart());
    await tick();
    // The link has proven itself, so the ring may evict.
    h.io.clock += 60_000;
    startMessages(h, ring * 2);
    // Every slot sent, deltas included, since one lost on a half-open link
    // must be sent again for the object to get past it.
    const newest = h.outbound.events.slice(-ring).map((event) => event.runtimeSequence);
    expect(OUTBOX_RING).toBe(4096);

    h.host.replayFrom(1);
    expect(h.io.logs.some((line) => line.includes("cannot replay from 1"))).toBe(true);

    const before = h.outbound.events.length;
    h.host.replayFrom(newest[0] as number);
    expect(h.outbound.events.slice(before).map((event) => event.runtimeSequence)).toEqual(newest);
    expect(h.outbound.events.slice(before).some((event) => event.type === "message.delta")).toBe(
      true,
    );
  });

  /** A link the test drives by hand: welcome, then up, as `runLink` calls them. */
  function welcomeLink(h: Awaited<ReturnType<typeof booted>>): RecordingOutbound {
    const next = new RecordingOutbound();
    let sequence = h.cursor.next;
    h.host.handler.onWelcome?.(next, () => {
      sequence = h.cursor.next;
      h.cursor.next += 1;
      return { type: "runtime.connected", runtimeSequence: sequence } as unknown as ProtocolEvent;
    });
    h.host.handler.onLinkUp(next);
    return next;
  }

  it("half-open loss, then a backlog past the ring, then reconnect: the lost frames can still be replayed", async () => {
    const ring = 8;
    const h = await booted(0, { outboxRing: ring });
    h.host.offer(runStart());
    await tick();
    h.io.clock += 60_000;
    // Handed to a socket that had already gone half-open: never received.
    const before = h.outbound.events.length;
    startMessages(h, 3);
    const lost = h.outbound.events[before]?.runtimeSequence as number;
    h.host.handler.onLinkDown();
    startMessages(h, ring * 5, 3);

    const next = welcomeLink(h);
    // The flush and the link's own runtime.connected went out, and nothing
    // the old link may have lost was evicted for them.
    h.host.replayFrom(lost);
    expect(h.io.logs.some((line) => line.includes("cannot replay"))).toBe(false);
    expect(next.events.filter((event) => event.runtimeSequence === lost)).toHaveLength(1);

    // The same holds when the new link dies mid-flush and a third one comes.
    h.host.handler.onLinkDown();
    startMessages(h, 2, 100);
    const third = welcomeLink(h);
    h.host.replayFrom(lost);
    expect(third.events.some((event) => event.runtimeSequence === lost)).toBe(true);

    // Once a link has stayed up long enough, the ring is held to its size again.
    h.io.clock += 60_000;
    startMessages(h, 1, 200);
    h.host.replayFrom(lost + 1);
    expect(h.io.logs.some((line) => line.includes(`cannot replay from ${lost + 1}`))).toBe(true);
  });

  it("answers a repeated replay_from on one link once, and again on the next link", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.host.replayFrom(1);
    const once = h.outbound.events.length;
    h.host.replayFrom(1);
    expect(h.outbound.events.length).toBe(once);
    const next = welcomeLink(h);
    h.host.replayFrom(1);
    expect(next.events.some((event) => event.type === "run.started")).toBe(true);
  });

  it("sends a reconnect's runtime.connected after the events stamped while down, and keeps it for replay", async () => {
    const link = new TestLink();
    const second = new TestLink();
    const io = new TestIo([link, second]);
    const cursor: SequenceCursor = { next: 0 };
    const opencode = new FakeOpenCode();
    const host = hostOver(io, cursor, opencode);
    const exit = runBridgeWith(config(), io, host, cursor);
    await tick();
    await tick();
    host.offer(modelGrant());
    await tick();
    await tick();
    host.offer(runStart());
    await tick();
    io.clock += 60_000;
    // A link that worked the whole time: the object was heard from just now.
    link.deliver(JSON.stringify({ type: "bridge.noop" }));
    link.drop();
    opencode.subscriptions[0]?.deliver({
      kind: "text_delta",
      messageId: "m",
      partId: "p",
      text: "x",
    });
    opencode.subscriptions[0]?.deliver({ kind: "session_idle" });
    await tick();
    await tick();
    const sent = second.sent
      .map((text) => JSON.parse(text) as { type: string; runtimeSequence?: number })
      .filter((frame) => typeof frame.runtimeSequence === "number");
    const sequences = sent.map((frame) => frame.runtimeSequence as number);
    // In sequence order, with no slot skipped: the object admits only the next.
    expect(sequences).toEqual(sequences.map((_, index) => (sequences[0] as number) + index));
    expect(sent.at(-1)?.type).toBe("runtime.connected");

    const connectedAt = sequences.at(-1) as number;
    const before = second.sent.length;
    second.deliver(JSON.stringify({ type: "replay_from", runtimeSequence: connectedAt }));
    expect(second.sent.slice(before).map((text) => JSON.parse(text).type)).toEqual([
      "runtime.connected",
    ]);
    second.deliver(JSON.stringify({ type: "runtime.shutdown" }));
    await expect(exit).resolves.toEqual({ kind: "shutdown" });
  });

  it("pauses the harness's event stream past the unsent byte bound and resumes it once a link drains the outbox", async () => {
    const h = await booted(0, { outboxUnsentMaxBytes: 4_000 });
    h.host.offer(runStart());
    await tick();
    const room = h.opencode.subscriptions[0]?.room;
    if (room === undefined) {
      throw new Error("the bridge handed the stream no backpressure");
    }
    await room();
    h.host.handler.onLinkDown();
    startMessages(h, 40);

    let resumed = false;
    const waiting = room().then(() => {
      resumed = true;
    });
    // A second read waits on the same bound, and the pause is said once.
    const second = room();
    await tick();
    expect(resumed).toBe(false);
    expect(
      h.io.logs.filter((line) => line.includes("paused the opencode event stream")),
    ).toHaveLength(1);

    const next = new RecordingOutbound();
    h.host.handler.onLinkUp(next);
    await waiting;
    await second;
    expect(resumed).toBe(true);
    expect(next.events.filter((event) => event.type === "message.started")).toHaveLength(40);
    await room();
  });

  it("releases a paused stream at shutdown, so the subscription can end", async () => {
    const h = await booted(0, { outboxUnsentMaxBytes: 1_000 });
    h.host.offer(runStart());
    await tick();
    h.host.handler.onLinkDown();
    startMessages(h, 20);
    const room = h.opencode.subscriptions[0]?.room as () => Promise<void>;
    let released = false;
    const waiting = room().then(() => {
      released = true;
    });
    await tick();
    expect(released).toBe(false);
    await h.host.shutdown();
    await waiting;
    expect(released).toBe(true);
    // A stopped host never pauses a stream again.
    await room();
  });

  it("replayFrom sends nothing when the ring cannot reach back to the sequence asked for", async () => {
    // The ring starts at 5, so the frame the object is missing is gone.
    // Sending what it holds would be refused and asked for again, an unbounded
    // exchange that exhausts the object's Durable Object reads.
    const h = await booted(5);
    h.host.offer(runStart());
    await tick();
    const sentBefore = h.outbound.events.length;

    h.host.replayFrom(1);

    expect(h.outbound.events.length).toBe(sentBefore);
    expect(h.io.logs.some((line) => line.includes("cannot replay from 1"))).toBe(true);
  });
});

const HEAD_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const CHECKPOINT_SHA = "c".repeat(40);
const PUSH_TOKEN = "ghs_push-token-secret";
const UPLOAD_TOKEN = "up_upload-token-secret";
const RESTORE_TOKEN = "dl_restore-token-secret";
const PATCH = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
const BRANCH = "oncue/readme-1a2b";

interface GitCall {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly secretLines: readonly string[] | null;
}

/** The git subcommand: the first argv entry after `git` that is neither a `-c` pair nor a flag. */
function subcommand(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index - 1] === "-c" || argv[index]?.startsWith("-")) {
      continue;
    }
    return argv[index] ?? "";
  }
  return "";
}

/** Real-shaped answers for every git call the boot and a checkpoint make, keyed by subcommand. */
class RecordingGit {
  readonly calls: GitCall[] = [];
  readonly revoked: string[] = [];
  readonly script: Record<string, GitProcessResult> = {
    clone: { code: 0, stdout: "", stderr: "" },
    config: { code: 0, stdout: "", stderr: "" },
    "rev-parse": { code: 0, stdout: `${HEAD_SHA}\n`, stderr: "" },
    "read-tree": { code: 0, stdout: "", stderr: "" },
    add: { code: 0, stdout: "", stderr: "" },
    "write-tree": { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" },
    "commit-tree": { code: 0, stdout: `${CHECKPOINT_SHA}\n`, stderr: "" },
    push: { code: 0, stdout: "", stderr: "" },
    diff: { code: 0, stdout: PATCH, stderr: "" },
    apply: { code: 0, stdout: "", stderr: "" },
    commit: { code: 0, stdout: "", stderr: "" },
  };
  /** Answers taken one at a time, ahead of `script`, for a subcommand that must answer differently each time. */
  readonly queue: Record<string, GitProcessResult[]> = {};
  readonly io = {
    runGit: async (
      argv: readonly string[],
      options: { readonly env: Readonly<Record<string, string>> },
      secretLines: readonly string[] | null,
    ): Promise<GitProcessResult> => {
      this.calls.push({ argv, env: options.env, secretLines });
      const sub = subcommand(argv);
      const queued = this.queue[sub]?.shift();
      if (queued !== undefined) {
        return queued;
      }
      return this.script[sub] ?? { code: 1, stdout: "", stderr: `unscripted: ${sub}` };
    },
    revoke: async (token: string) => {
      this.revoked.push(token);
      return { ok: true, status: 204 };
    },
    env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
    askpassPath: "/opt/oncue/askpass",
  };
  subs(): string[] {
    return this.calls.map((call) => subcommand(call.argv));
  }
}

class RecordingArtifacts implements ArtifactIo {
  readonly uploads: UploadRequest[] = [];
  readonly downloads: DownloadRequest[] = [];
  uploadStatus = 201;
  downloadAnswer: DownloadResult = { kind: "ok", bytes: Buffer.from(PATCH, "utf8") };
  async upload(request: UploadRequest) {
    this.uploads.push(request);
    return { ok: this.uploadStatus === 201, status: this.uploadStatus };
  }
  async download(request: DownloadRequest) {
    this.downloads.push(request);
    return this.downloadAnswer;
  }
}

function gitGrant(
  restore: { artifactId: string; url: string; token: string } | null = null,
  clone: { branch?: string; taskBranch?: string | null; headSha?: string } = {},
) {
  return {
    kind: "frame" as const,
    frame: {
      kind: "grant" as const,
      frame: buildGrantFrame(IDENTITY, {
        kind: "git",
        grantId: "grant_git",
        expiresAt: "2026-09-11T01:00:00.000Z",
        token: "ghs_clone",
        repository: { fullName: "a/b", cloneUrl: "https://github.example/a/b.git" },
        branch: clone.branch ?? BRANCH,
        taskBranch: clone.taskBranch === undefined ? BRANCH : clone.taskBranch,
        baseSha: HEAD_SHA,
        headSha: clone.headSha ?? HEAD_SHA,
        restore,
      }),
    },
  };
}

function pushGrant(grantId = "grant_push", token = PUSH_TOKEN, ref = `refs/heads/${BRANCH}`) {
  return {
    kind: "frame" as const,
    frame: {
      kind: "grant" as const,
      frame: buildGrantFrame(IDENTITY, {
        kind: "push",
        grantId,
        expiresAt: "2026-09-11T00:02:00.000Z",
        token,
        repository: { fullName: "a/b", cloneUrl: "https://github.example/a/b.git" },
        ref,
        parentSha: HEAD_SHA,
      }),
    },
  };
}

function uploadGrant(artifactId: string, maxBytes = 1024 * 1024) {
  return {
    kind: "frame" as const,
    frame: {
      kind: "grant" as const,
      frame: buildGrantFrame(IDENTITY, {
        kind: "upload",
        grantId: `grant_upload_${artifactId}`,
        expiresAt: "2026-09-11T00:10:00.000Z",
        token: UPLOAD_TOKEN,
        artifactId,
        url: `https://oncue.example/artifacts/${artifactId}`,
        maxBytes,
      }),
    },
  };
}

const checkpointCreate = (reason = "idle") =>
  command("checkpoint.create", { reason }, `cmd_ckpt_${reason}`, null);

describe("createAgentHost: checkpoints, uploads, and restore", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A host over a recording git and artifact store, its scratch dir in a temp
   * directory that does not exist yet. `scratchUnmakeable` points it under a
   * plain file, which `mkdir -p` cannot create through.
   */
  function checkpointHarness(scratchUnmakeable = false) {
    const root = mkdtempSync(join(tmpdir(), "oncue-agent-io-"));
    dirsToClean.push(root);
    const scratch = join(root, "checkpoint");
    if (scratchUnmakeable) {
      writeFileSync(join(root, "blocker"), "");
    }
    const git = new RecordingGit();
    const artifacts = new RecordingArtifacts();
    const supervisor = new FakeSupervisor();
    const opencode = new FakeOpenCode();
    const io = new TestIo();
    const outbound = new RecordingOutbound();
    const host = createAgentHost(
      config(),
      io,
      { next: 0 },
      {
        supervisor,
        runtime: opencode,
        git: git.io,
        files: { readFile: () => null, exists: () => false },
        relay: new FakeRelay(),
        tools: { port: 5002 },
        commits: { answer: () => undefined },
        artifacts,
      },
      {
        workspaceDir: join(root, "workspace"),
        checkpointDir: scratchUnmakeable ? join(root, "blocker", "checkpoint") : scratch,
      },
    );
    host.handler.onLinkUp(outbound);
    return { host, git, artifacts, supervisor, opencode, io, outbound, root, scratch };
  }

  type Harness = ReturnType<typeof checkpointHarness>;

  /** Git grant through clone and chown, then the model grant; the fakes take OpenCode to ready. */
  async function withWorkspace(h: Harness) {
    h.host.offer(gitGrant());
    await workspaceSettled(h);
    h.host.offer(modelGrant({ workspace: "repository" }));
    await until(() => h.host.snapshot().runtime.kind === "ready");
    expect(h.host.snapshot().workspace.kind).toBe("ready");
    expect(h.host.snapshot().durableHead).toBe(HEAD_SHA);
    expect(h.host.snapshot().runtime.kind).toBe("ready");
  }

  /** `withWorkspace`, a run OpenCode holds, and a checkpoint with no push grant: the bundle is declared. */
  async function withDeclaredBundle(h: Harness): Promise<string> {
    await withWorkspace(h);
    h.host.offer(runStart());
    await tick();
    h.host.offer(checkpointCreate("lifetime_ceiling"));
    await checkpointSettled(h);
    return declaredArtifactId(h);
  }

  function declaredArtifactId(h: Harness): string {
    const declared = h.outbound.events.find((event) => event.type === "artifact.uploading");
    if (declared === undefined) {
      throw new Error("no artifact.uploading was emitted");
    }
    return (declared.payload as { artifactId: string }).artifactId;
  }

  const checkpointEvents = (h: Harness) =>
    h.outbound.events.filter((event) => event.type !== "runtime.ready");

  /** The effects here touch the filesystem, so a fixed number of ticks is not enough under load. */
  async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
      await tick();
    }
    expect(condition()).toBe(true);
  }
  const checkpointSettled = (h: Harness) =>
    until(() => h.host.snapshot().checkpoint.kind !== "running");
  const checkpointIdle = (h: Harness) => until(() => h.host.snapshot().checkpoint.kind === "idle");
  const workspaceSettled = (h: Harness) =>
    until(() => ["ready", "failed"].includes(h.host.snapshot().workspace.kind));

  it("holds the push token, pushes the checkpoint to the granted ref with the token on fd 3 only, and reports the push", async () => {
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer(pushGrant());
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);

    expect(existsSync(join(h.scratch, "objects"))).toBe(true);
    const push = h.git.calls.find((call) => subcommand(call.argv) === "push");
    expect(push?.argv.at(-1)).toBe(`${CHECKPOINT_SHA}:refs/heads/${BRANCH}`);
    expect(push?.secretLines).toEqual([PUSH_TOKEN]);
    expect(push?.env.GIT_OBJECT_DIRECTORY).toBe(join(h.scratch, "objects"));
    expect(push?.env.GIT_DIR).toBe(join(h.scratch, "git"));
    expect(existsSync(join(h.scratch, "git", "HEAD"))).toBe(true);
    for (const call of h.git.calls) {
      expect(call.argv.join(" ")).not.toContain(PUSH_TOKEN);
      expect(Object.values(call.env).join(" ")).not.toContain(PUSH_TOKEN);
    }
    expect(h.git.revoked).toContain(PUSH_TOKEN);
    expect(checkpointEvents(h).map((event) => event.type)).toEqual(["sandbox.checkpointed"]);
    expect(checkpointEvents(h)[0]).toMatchObject({
      payload: { kind: "branch_push", headSha: CHECKPOINT_SHA, reason: "idle" },
    });
    expect(h.host.snapshot().durableHead).toBe(CHECKPOINT_SHA);
    expect(h.host.snapshot().checkpoint).toEqual({ kind: "idle" });
    expect(JSON.stringify(h.host.snapshot())).not.toContain(PUSH_TOKEN);
    expect(h.io.logs.join("\n")).not.toContain(PUSH_TOKEN);
  });

  it("publishes nothing, push or bundle, when the changes hold a supplied secret, and says which file", async () => {
    /** Obviously fake. */
    const fake = "fake-secret-value-0001";
    const h = checkpointHarness();
    h.git.script.diff = {
      code: 0,
      stdout: `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n+KEY=${fake}\n`,
      stderr: "",
    };
    await withWorkspace(h);
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "secret",
          grantId: "grant_secret",
          expiresAt: "2026-09-21T00:10:00.000Z",
          secrets: [{ name: "DATABASE_URL", value: fake }],
          requestRef: null,
        }),
      },
    });
    await tick();
    h.host.offer(runStart());
    await tick();
    h.host.offer(pushGrant());
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);

    expect(h.git.subs()).not.toContain("push");
    expect(h.git.revoked).toContain(PUSH_TOKEN);
    expect(h.artifacts.uploads).toEqual([]);
    const types = h.outbound.events.map((event) => event.type);
    expect(types).not.toContain("artifact.uploading");
    const failed = h.outbound.events.find((event) => event.type === "git.push.failed");
    expect(failed).toMatchObject({
      payload: { category: "secret_in_changes", message: expect.stringContaining(".env") },
    });
    expect(h.outbound.events.at(-1)).toMatchObject({
      type: "sandbox.checkpointed",
      payload: { kind: "local_commit", bundle: null },
    });
    expect(JSON.stringify(h.outbound.events)).not.toContain(fake);
    expect(h.io.logs.join("\n")).not.toContain(fake);
  });

  it("checkpoints a session with no secrets exactly as before: no scan ahead of the push", async () => {
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer(pushGrant());
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);
    expect(h.git.subs().filter((sub) => sub === "push")).toHaveLength(1);
    const pushAt = h.git.subs().indexOf("push");
    expect(h.git.subs().slice(0, pushAt)).not.toContain("diff");
  });

  it("a rotated-out push grant's token is revoked when the next one arrives, and the next one pushes", async () => {
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer(pushGrant("grant_push_1", "ghs_first"));
    h.host.offer(pushGrant("grant_push_2", "ghs_second"));
    await until(() => h.git.revoked.includes("ghs_first"));
    expect(h.git.revoked.filter((token) => token !== "ghs_clone")).toEqual(["ghs_first"]);
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);
    const push = h.git.calls.find((call) => subcommand(call.argv) === "push");
    expect(push?.secretLines).toEqual(["ghs_second"]);
  });

  it("with no push grant and no run ever: no push, and the bundle is reported as a local commit", async () => {
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer(checkpointCreate("lifetime_ceiling"));
    await checkpointIdle(h);
    expect(h.git.subs()).not.toContain("push");
    expect(h.io.logs.some((line) => line.includes("no run to charge"))).toBe(true);
    expect(checkpointEvents(h).map((event) => event.type)).toEqual(["sandbox.checkpointed"]);
    expect(checkpointEvents(h)[0]).toMatchObject({
      payload: { kind: "local_commit", headSha: CHECKPOINT_SHA, bundle: null },
    });
  });

  it("with a run to charge: artifact.uploading goes out, the PUT carries the patch and its sha256, and the events name the bundle", async () => {
    const h = checkpointHarness();
    const artifactId = await withDeclaredBundle(h);
    expect(h.outbound.events.find((event) => event.type === "artifact.uploading")).toMatchObject({
      runId: "run_1",
      payload: { kind: "patch", contentType: "text/x-diff", declaredBytes: PATCH.length },
    });

    h.host.offer(uploadGrant(artifactId));
    await checkpointIdle(h);
    expect(h.artifacts.uploads).toEqual([
      {
        url: `https://oncue.example/artifacts/${artifactId}`,
        token: UPLOAD_TOKEN,
        bytes: Buffer.from(PATCH, "utf8"),
        contentType: "text/x-diff",
        sha256: sha256Hex(Buffer.from(PATCH, "utf8")),
      },
    ]);
    expect(h.outbound.events.slice(-2).map((event) => event.type)).toEqual([
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    expect(h.outbound.events.at(-1)).toMatchObject({
      payload: {
        kind: "patch_bundle",
        reason: "lifetime_ceiling",
        bundle: { artifactId, kind: "patch", byteSize: PATCH.length },
      },
    });
    expect(h.host.snapshot().durableHead).toBe(HEAD_SHA);
    expect(JSON.stringify(h.host.snapshot())).not.toContain(UPLOAD_TOKEN);
    expect(h.io.logs.join("\n")).not.toContain(UPLOAD_TOKEN);
  });

  it("refuses an upload locally when the staged bytes exceed the grant's ceiling, and a failed PUT is a local commit", async () => {
    for (const [maxBytes, status] of [
      [8, 201],
      [1024, 403],
    ] as const) {
      const h = checkpointHarness();
      const artifactId = await withDeclaredBundle(h);
      h.artifacts.uploadStatus = status;
      h.host.offer(uploadGrant(artifactId, maxBytes));
      await checkpointIdle(h);
      expect(h.artifacts.uploads).toHaveLength(maxBytes === 8 ? 0 : 1);
      expect(h.outbound.events.at(-1)).toMatchObject({
        type: "sandbox.checkpointed",
        payload: { kind: "local_commit", bundle: null },
      });
      expect(h.host.snapshot().uploads).toEqual([]);
    }
  });

  it("a second upload grant for an artifact already sent is wrong_state and sends nothing", async () => {
    const h = checkpointHarness();
    const artifactId = await withDeclaredBundle(h);
    h.host.offer(uploadGrant(artifactId));
    await checkpointIdle(h);
    const again = uploadGrant(artifactId);
    h.host.offer({
      ...again,
      frame: { kind: "grant", frame: { ...again.frame.frame, grantId: "grant_upload_again" } },
    });
    await tick();
    expect(h.artifacts.uploads).toHaveLength(1);
    expect(h.outbound.acks.at(-1)).toMatchObject({
      ref: { grantId: "grant_upload_again" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });

  it("stages a cut tool output as utf-8 and uploads it as text on its grant", async () => {
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer(runStart());
    await tick();
    const big = "é".repeat(40 * 1024);
    h.opencode.subscriptions[0]?.deliver({
      kind: "tool_part",
      messageId: "m1",
      part: {
        callId: "t1",
        tool: "bash",
        status: "completed",
        title: "cat",
        input: {},
        output: big,
        error: null,
        exitCode: 0,
        startedAtMs: 1,
        endedAtMs: 2,
      },
    });
    const artifactId = declaredArtifactId(h);
    expect(h.outbound.events.find((event) => event.type === "artifact.uploading")).toMatchObject({
      payload: { kind: "tool_output", declaredBytes: 80 * 1024, producer: "tool" },
    });
    h.host.offer(uploadGrant(artifactId));
    await until(() => h.host.snapshot().uploads.length === 0);
    expect(h.artifacts.uploads).toHaveLength(1);
    expect(h.artifacts.uploads[0]).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      sha256: sha256Hex(Buffer.from(big, "utf8")),
    });
    expect(h.artifacts.uploads[0]?.bytes.byteLength).toBe(80 * 1024);
    expect(h.host.snapshot().uploads).toEqual([]);
    expect(JSON.stringify(h.host.snapshot())).not.toContain(big.slice(0, 64));
  });

  it("redacts the BYTES of an uploaded artifact, not only what the timeline previews, and checksums what it sends", async () => {
    /** Obviously fake. */
    const fake = "fake-secret-value-0001";
    const h = checkpointHarness();
    await withWorkspace(h);
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "secret",
          grantId: "grant_secret",
          expiresAt: "2026-09-21T00:10:00.000Z",
          secrets: [{ name: "DATABASE_URL", value: fake }],
          requestRef: null,
        }),
      },
    });
    await tick();
    h.host.offer(runStart());
    await tick();
    // The value sits past the part of the output the timeline shows inline.
    const output = `${"x".repeat(70 * 1024)}\nDATABASE_URL=${fake}\n`;
    h.opencode.subscriptions[0]?.deliver({
      kind: "tool_part",
      messageId: "m1",
      part: {
        callId: "t1",
        tool: "bash",
        status: "completed",
        title: "env",
        input: {},
        output,
        error: null,
        exitCode: 0,
        startedAtMs: 1,
        endedAtMs: 2,
      },
    });
    const artifactId = declaredArtifactId(h);
    h.host.offer(uploadGrant(artifactId));
    await until(() => h.artifacts.uploads.length === 1);
    const sent = Buffer.from(h.artifacts.uploads[0]?.bytes ?? []);
    expect(sent.includes(fake)).toBe(false);
    expect(sent.includes("DATABASE_URL=[REDACTED]")).toBe(true);
    expect(h.artifacts.uploads[0]?.sha256).toBe(sha256Hex(sent));
    expect(JSON.stringify(h.outbound.events)).not.toContain(fake);
  });

  it("a run's checkpoint sends the session's diff before the checkpointed events, and a patch too large to travel inline uploads as a diff artifact", async () => {
    const h = checkpointHarness();
    const big = "+a generated line\n".repeat(4_000);
    h.git.script.diff = { code: 0, stdout: big, stderr: "" };
    await withWorkspace(h);
    h.host.offer(runStart());
    await until(() => h.outbound.events.some((event) => event.type === "run.started"));
    h.host.offer(pushGrant());
    h.host.offer(checkpointCreate("lifetime_ceiling"));
    await checkpointIdle(h);

    expect(checkpointEvents(h).map((event) => event.type)).toEqual([
      "run.started",
      "repository.status",
      "artifact.uploading",
      "diff.updated",
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    const artifactId = declaredArtifactId(h);
    expect(h.outbound.events.find((event) => event.type === "artifact.uploading")).toMatchObject({
      runId: "run_1",
      payload: {
        kind: "diff",
        contentType: "text/x-diff",
        declaredBytes: big.length,
        producer: "agent",
      },
    });
    expect(h.outbound.events.find((event) => event.type === "diff.updated")).toMatchObject({
      payload: {
        scope: "session",
        baseSha: HEAD_SHA,
        headSha: CHECKPOINT_SHA,
        body: { kind: "artifact", artifact: { artifactId, kind: "diff", byteSize: big.length } },
        truncated: true,
      },
    });
    h.host.offer(uploadGrant(artifactId));
    await until(() => h.artifacts.uploads.length === 1);
    expect(h.artifacts.uploads[0]).toMatchObject({
      contentType: "text/x-diff",
      sha256: sha256Hex(Buffer.from(big, "utf8")),
    });
    expect(JSON.stringify(h.host.snapshot())).not.toContain(big.slice(0, 64));
  });

  it("a scratch directory that cannot be made fails the checkpoint without a throw", async () => {
    const h = checkpointHarness(true);
    await withWorkspace(h);
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);
    expect(h.io.logs.some((line) => line.includes("scratch_unavailable"))).toBe(true);
    expect(h.git.subs()).not.toContain("read-tree");
  });

  it("revokes a push grant it took when the scratch directory cannot be made", async () => {
    // The grant leaves `heldPush` before the scratch check, so this path must
    // revoke the token rather than drop it alive.
    const h = checkpointHarness(true);
    await withWorkspace(h);
    h.host.offer(pushGrant());
    h.host.offer(checkpointCreate("idle"));
    await checkpointIdle(h);
    expect(h.io.logs.some((line) => line.includes("scratch_unavailable"))).toBe(true);
    expect(h.git.revoked).toContain(PUSH_TOKEN);
  });

  it("a git grant with a restore bundle downloads it with the bearer, applies and commits it before the hand-over, and removes the file", async () => {
    const h = checkpointHarness();
    h.host.offer(
      gitGrant({
        artifactId: "art_r",
        url: "https://oncue.example/artifacts/art_r",
        token: RESTORE_TOKEN,
      }),
    );
    await workspaceSettled(h);
    expect(h.artifacts.downloads).toEqual([
      { url: "https://oncue.example/artifacts/art_r", token: RESTORE_TOKEN },
    ]);
    const subs = h.git.subs();
    expect(subs.indexOf("apply")).toBeGreaterThan(subs.indexOf("clone"));
    expect(subs.indexOf("commit")).toBeGreaterThan(subs.indexOf("apply"));
    const apply = h.git.calls.find((call) => subcommand(call.argv) === "apply");
    expect(apply?.argv).toContain(join(h.scratch, RESTORE_PATCH_NAME));
    expect(apply?.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(readdirSync(h.scratch)).not.toContain(RESTORE_PATCH_NAME);
    // The chown happens after the restore, so the bridge still owned the tree while writing it.
    expect(h.supervisor.chowns).toEqual([1001]);
    expect(h.host.snapshot().workspace).toMatchObject({ kind: "ready", headSha: HEAD_SHA });
    expect(h.host.snapshot().durableHead).toBe(HEAD_SHA);
    expect(JSON.stringify(h.host.snapshot())).not.toContain(RESTORE_TOKEN);
    expect(h.io.logs.join("\n")).not.toContain(RESTORE_TOKEN);
  });

  it.each([
    ["download refused", { kind: "failed", status: 403 } as const, "download_failed (403)"],
    ["apply failed", null, "apply_failed"],
  ])(
    "a restore whose %s is a boot failure in the restore category",
    async (_what, download, detail) => {
      const h = checkpointHarness();
      if (download !== null) {
        h.artifacts.downloadAnswer = download;
      } else {
        h.git.script.apply = { code: 1, stdout: "", stderr: "error: patch failed" };
      }
      h.host.offer(gitGrant({ artifactId: "art_r", url: "https://x", token: RESTORE_TOKEN }));
      await workspaceSettled(h);
      expect(h.host.snapshot().workspace).toEqual({ kind: "failed", detail });
      expect(h.supervisor.chowns).toEqual([]);
      expect(h.outbound.events[0]).toMatchObject({
        type: "runtime.disconnected",
        payload: { detail: `boot failed: clone (restore): ${detail}` },
      });
      expect(readdirSync(h.scratch)).not.toContain(RESTORE_PATCH_NAME);
    },
  );

  describe("a branch that moved on GitHub while the session was idle (record 07)", () => {
    const TIP = "d".repeat(40);
    const ok = { code: 0, stdout: "", stderr: "" };
    const refused = { code: 1, stdout: "", stderr: "" };
    const restoreBundle = { artifactId: "art_r", url: "https://x", token: RESTORE_TOKEN };

    /** A clone whose tip is `TIP`, not the grant's commit. */
    function movedHarness(options: { present: boolean; descends?: boolean }) {
      const h = checkpointHarness();
      h.git.queue["rev-parse"] = [{ code: 0, stdout: `${TIP}\n`, stderr: "" }];
      h.git.script["cat-file"] = options.present ? ok : refused;
      h.git.script.fetch = ok;
      h.git.script["merge-base"] = options.descends === true ? ok : refused;
      h.git.script.reset = ok;
      return h;
    }

    it("the base branch moved: the tree lands on the session's base, the saved edits apply there, and the workspace is ready", async () => {
      const h = movedHarness({ present: true });
      h.host.offer(gitGrant(restoreBundle, { branch: "main", taskBranch: null }));
      await workspaceSettled(h);
      const subs = h.git.subs();
      expect(subs.indexOf("reset")).toBeGreaterThan(subs.indexOf("clone"));
      expect(subs.indexOf("apply")).toBeGreaterThan(subs.indexOf("reset"));
      expect(subs).not.toContain("merge-base");
      const reset = h.git.calls.find((call) => subcommand(call.argv) === "reset");
      expect(reset?.argv.at(-1)).toBe(HEAD_SHA);
      expect(h.supervisor.chowns).toEqual([1001]);
      expect(h.host.snapshot().workspace).toMatchObject({ kind: "ready", headSha: HEAD_SHA });
      expect(h.host.snapshot().durableHead).toBe(HEAD_SHA);
      expect(h.io.logs.some((line) => line.includes("landed base_moved"))).toBe(true);
    });

    it("the task branch moved ahead and the saved edits apply on the newer tip: the tree keeps the newer commits", async () => {
      const h = movedHarness({ present: true, descends: true });
      h.host.offer(gitGrant(restoreBundle));
      await workspaceSettled(h);
      expect(h.git.subs()).not.toContain("reset");
      expect(h.host.snapshot().workspace).toMatchObject({ kind: "ready", headSha: TIP });
      expect(h.host.snapshot().durableHead).toBe(TIP);
    });

    it("the task branch moved ahead and the saved edits do not apply on the newer tip: the tree moves back to the session's own push and the edits apply there", async () => {
      const h = movedHarness({ present: true, descends: true });
      h.git.queue.apply = [{ code: 1, stdout: "", stderr: "error: patch failed" }];
      h.host.offer(gitGrant(restoreBundle));
      await workspaceSettled(h);
      const subs = h.git.subs();
      expect(subs.filter((sub) => sub === "apply")).toHaveLength(2);
      const firstApply = subs.indexOf("apply");
      expect(subs.indexOf("reset", firstApply)).toBeGreaterThan(firstApply);
      expect(subs.lastIndexOf("apply")).toBeGreaterThan(subs.indexOf("reset", firstApply));
      expect(h.host.snapshot().workspace).toMatchObject({ kind: "ready", headSha: HEAD_SHA });
      expect(h.host.snapshot().durableHead).toBe(HEAD_SHA);
      expect(h.io.logs.some((line) => line.includes("on the session's own push"))).toBe(true);
      expect(readdirSync(h.scratch)).not.toContain(RESTORE_PATCH_NAME);
    });

    it("edits that apply on neither commit are the restore failure as before", async () => {
      const h = movedHarness({ present: true, descends: true });
      h.git.script.apply = { code: 1, stdout: "", stderr: "error: patch failed" };
      h.host.offer(gitGrant(restoreBundle));
      await workspaceSettled(h);
      expect(h.host.snapshot().workspace).toEqual({ kind: "failed", detail: "apply_failed" });
      expect(h.supervisor.chowns).toEqual([]);
    });

    it("a commit GitHub no longer has fails the boot with a sentence for the person and no prefix", async () => {
      const h = movedHarness({ present: false });
      h.host.offer(gitGrant(null, { branch: "main", taskBranch: null }));
      await workspaceSettled(h);
      const detail = commitMissingText(HEAD_SHA, { branch: "main", ownBranch: false });
      expect(detail).toBe(
        "The commit this session started from (3f2a9c1e) is no longer on GitHub: the history of main was rewritten. Start a new session to continue from main as it is now.",
      );
      expect(h.git.subs().filter((sub) => sub === "fetch")).toHaveLength(1);
      expect(h.supervisor.chowns).toEqual([]);
      expect(h.git.revoked).toEqual(["ghs_clone"]);
      expect(h.outbound.events[0]).toMatchObject({
        type: "runtime.disconnected",
        payload: { reason: "boot_failed", detail, expectReconnect: false },
      });
    });

    it("a task branch deleted on GitHub fails the boot with a sentence naming it", async () => {
      const h = checkpointHarness();
      h.git.script.clone = {
        code: 128,
        stdout: "",
        stderr: `fatal: Remote branch ${BRANCH} not found in upstream origin`,
      };
      h.host.offer(gitGrant());
      await workspaceSettled(h);
      expect(h.outbound.events[0]).toMatchObject({
        type: "runtime.disconnected",
        payload: {
          detail: `The branch ${BRANCH} is no longer on GitHub, so this session cannot resume. Restore the branch on GitHub (a closed pull request offers Restore branch) and send your message again.`,
        },
      });
    });

    it("a clone killed at its time bound fails the boot with a sentence saying so, not a network blip", async () => {
      const h = checkpointHarness();
      h.git.script.clone = { code: null, stdout: "", stderr: "", timedOut: true };
      h.host.offer(gitGrant());
      await workspaceSettled(h);
      expect(h.outbound.events[0]).toMatchObject({
        type: "runtime.disconnected",
        payload: {
          detail: `Cloning ${BRANCH} did not finish within 10 minutes, so this session could not start. The repository may be too large to clone in that time.`,
        },
      });
    });

    it("names the session's own pushed commit when it is the task branch that was rewritten", () => {
      expect(commitMissingText(HEAD_SHA, { branch: BRANCH, ownBranch: true })).toBe(
        `The last commit this session pushed (3f2a9c1e) is no longer on GitHub: the history of ${BRANCH} was rewritten. Start a new session to continue from ${BRANCH} as it is now.`,
      );
    });
  });
});

/** A link with the socket's liveness surface: pings counted, a pong the test sends, and a terminate. */
class LiveLink extends TestLink {
  pings = 0;
  terminated = false;
  private pongListener: (() => void) | null = null;
  ping(): void {
    this.pings += 1;
  }
  onPong(listener: () => void): void {
    this.pongListener = listener;
  }
  pong(): void {
    this.pongListener?.();
  }
  terminate(): void {
    this.terminated = true;
  }
  private codeListener: ((code?: number) => void) | null = null;
  override onClose(listener: (code?: number) => void): void {
    this.codeListener = listener;
    super.onClose(listener);
  }
  closeWith(code: number): void {
    this.codeListener?.(code);
  }
}

function hostOver(io: TestIo, cursor: SequenceCursor, opencode = new FakeOpenCode()) {
  return createAgentHost(config(), io, cursor, {
    supervisor: new FakeSupervisor(),
    runtime: opencode,
    git: {
      runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
      revoke: async () => ({ ok: true, status: 204 }),
      env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
      askpassPath: "/opt/oncue/askpass",
    },
    artifacts: fakeArtifacts(),
    files: { readFile: () => null, exists: () => false },
    relay: new FakeRelay(),
    tools: { port: 5002 },
    commits: { answer: () => undefined },
  });
}

describe("runBridgeWith: resilience over a long session", () => {
  it("drops a half-open link through the socket's own terminate and reconnects", async () => {
    const first = new LiveLink();
    const second = new LiveLink();
    const io = new TestIo([first, second]);
    const cursor: SequenceCursor = { next: 0 };
    const exit = runBridgeWith(config(), io, hostOver(io, cursor), cursor);
    await tick();
    await tick();
    const ticker = io.ticks.at(-1) as () => void;
    ticker();
    expect(first.pings).toBe(1);
    first.pong();
    ticker();
    ticker();
    expect(first.terminated).toBe(false);
    ticker();
    expect(first.terminated).toBe(true);

    await tick();
    await tick();
    expect(io.sleeps).toContain(1);
    expect(second.sent.map((text) => JSON.parse(text).type)).toEqual([
      "bridge.hello",
      "runtime.connected",
    ]);
    second.deliver(JSON.stringify({ type: "runtime.shutdown" }));
    await expect(exit).resolves.toEqual({ kind: "shutdown" });
  });

  it("ends on the object's stale-generation close instead of retrying for the whole window", async () => {
    const link = new LiveLink();
    const io = new TestIo([link, new LiveLink()]);
    const cursor: SequenceCursor = { next: 0 };
    const exit = runBridgeWith(config(), io, hostOver(io, cursor), cursor);
    await tick();
    await tick();
    link.closeWith(4000);
    await expect(exit).resolves.toEqual({ kind: "refused", reason: "stale_generation" });
    expect(io.connected).toBe(1);
  });

  it("ends on a refused welcome rather than reading its own close of the link as a drop", async () => {
    const link = new LiveLink();
    const io = new (class extends TestIo {
      override async connect(): Promise<BridgeLink> {
        this.connected += 1;
        setTimeout(
          () =>
            link.deliver(
              JSON.stringify({
                type: "bridge.welcome",
                protocolVersion: 99,
                sessionId: "sess_1",
                sandboxGeneration: 3,
              }),
            ),
          0,
        );
        return link;
      }
    })();
    const cursor: SequenceCursor = { next: 0 };
    await expect(runBridgeWith(config(), io, hostOver(io, cursor), cursor)).resolves.toEqual({
      kind: "refused",
      reason: "protocol_version",
    });
    expect(io.connected).toBe(1);
    expect(link.closed).toBe(true);
  });

  it("survives many separate drops and delivers every durable event, with no hole in the sequence", async () => {
    const drops = 12;
    const links = Array.from({ length: drops + 1 }, () => new TestLink());
    const io = new TestIo([...links]);
    const cursor: SequenceCursor = { next: 0 };
    const opencode = new FakeOpenCode();
    const host = hostOver(io, cursor, opencode);
    const exit = runBridgeWith(config(), io, host, cursor);
    await tick();
    await tick();
    host.offer(modelGrant());
    await tick();
    await tick();
    host.offer(runStart());
    await tick();

    for (let drop = 0; drop < drops; drop += 1) {
      const deliver = opencode.subscriptions[0]?.deliver;
      // Some events go out on the live link, some while it is down.
      deliver?.({ kind: "text_delta", messageId: `up${drop}`, partId: "p", text: "x" });
      io.clock += 60_000;
      // Heard from until the drop, so each link counts as stable.
      links[drop]?.deliver(JSON.stringify({ type: "bridge.noop" }));
      links[drop]?.drop();
      deliver?.({ kind: "text_delta", messageId: `down${drop}`, partId: "p", text: "x" });
      await tick();
      await tick();
    }
    const last = links[drops] as TestLink;
    last.deliver(JSON.stringify({ type: "runtime.shutdown" }));
    await expect(exit).resolves.toEqual({ kind: "shutdown" });

    const delivered = new Set<number>();
    let started = 0;
    for (const link of links) {
      for (const text of link.sent) {
        const frame = JSON.parse(text) as { type: string; runtimeSequence?: number };
        if (typeof frame.runtimeSequence === "number" && frame.type !== "message.delta") {
          delivered.add(frame.runtimeSequence);
        }
        if (frame.type === "message.started") {
          started += 1;
        }
      }
    }
    expect(started).toBe(drops * 2);
    // Every slot the cursor handed out reached the object, except the
    // streamed deltas sent on a live link, which are ephemeral by design; the
    // ones made while the link was down took no slot at all.
    const deltas = drops;
    expect(delivered.size).toBe(cursor.next - deltas);
    expect(io.connected).toBe(drops + 1);
  });
});

describe("runBridgeWith", () => {
  function frameFor(host: ReturnType<typeof harness>["host"]): ReturnType<typeof harness>["host"] {
    return host;
  }

  it("runs the link with the host's handler and identity, and a close_link ends the loop as shutdown", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const cursor: SequenceCursor = { next: 0 };
    const supervisor = new FakeSupervisor();
    const opencode = new FakeOpenCode();
    const host = frameFor(
      createAgentHost(config(), io, cursor, {
        supervisor,
        runtime: opencode,
        git: {
          runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
          revoke: async () => ({ ok: true, status: 204 }),
          env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
          askpassPath: "/opt/oncue/askpass",
        },
        artifacts: fakeArtifacts(),
        files: { readFile: () => null, exists: () => false },
        relay: new FakeRelay(),
        tools: { port: 5002 },
        commits: { answer: () => undefined },
      }),
    );

    const exit = runBridgeWith(config(), io, host, cursor);
    await tick();
    await tick();
    expect(JSON.parse(link.sent[1] ?? "{}")).toMatchObject({
      type: "runtime.connected",
      payload: { runtimeName: "none" },
    });

    link.deliver(
      JSON.stringify(
        buildCommandFrame(
          IDENTITY,
          {
            commandId: "cmd_stop",
            sessionId: "sess_1",
            runId: null,
            issuedAt: "2026-09-11T00:00:00.000Z",
            issuedByUserId: "u",
            expected: { scope: "session", state: "active" },
            type: "runtime.shutdown",
            payload: { reason: "idle", graceMs: 1 },
          } as unknown as DeliverableCommand,
          null,
        ),
      ),
    );
    await tick();

    expect(link.sent.map((text) => JSON.parse(text).type)).toEqual([
      "bridge.hello",
      "runtime.connected",
      "bridge.ack",
    ]);
    expect(link.closed).toBe(true);
    await expect(exit).resolves.toEqual({ kind: "shutdown" });
  });

  it("hands a replay_from frame to the host and re-sends from the ring", async () => {
    const link = new TestLink();
    const io = new TestIo([link]);
    const cursor: SequenceCursor = { next: 0 };
    const opencode = new FakeOpenCode();
    const host = createAgentHost(config(), io, cursor, {
      supervisor: new FakeSupervisor(),
      runtime: opencode,
      git: {
        runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
        revoke: async () => ({ ok: true, status: 204 }),
        env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
        askpassPath: "/opt/oncue/askpass",
      },
      artifacts: fakeArtifacts(),
      files: { readFile: () => null, exists: () => false },
      relay: new FakeRelay(),
      tools: { port: 5002 },
      commits: { answer: () => undefined },
    });
    const exit = runBridgeWith(config(), io, host, cursor);
    await tick();
    await tick();
    host.offer(modelGrant());
    await tick();
    await tick();
    expect(link.sent.map((text) => JSON.parse(text).type)).toEqual([
      "bridge.hello",
      "runtime.connected",
      "bridge.ack",
      "runtime.ready",
    ]);

    link.deliver(JSON.stringify({ type: "replay_from", runtimeSequence: 1 }));
    expect(link.sent.map((text) => JSON.parse(text).type)).toEqual([
      "bridge.hello",
      "runtime.connected",
      "bridge.ack",
      "runtime.ready",
      "runtime.ready",
    ]);

    link.drop();
    await expect(exit).resolves.toEqual({ kind: "exhausted", attempts: 3 });
  });

  it("logs no credential when the connect fails", async () => {
    const io = new TestIo([]);
    const host = createAgentHost(
      config(),
      io,
      { next: 0 },
      {
        supervisor: new FakeSupervisor(),
        runtime: new FakeOpenCode(),
        git: {
          runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
          revoke: async () => ({ ok: true, status: 204 }),
          env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
          askpassPath: "/opt/oncue/askpass",
        },
        artifacts: fakeArtifacts(),
        files: { readFile: () => null, exists: () => false },
        relay: new FakeRelay(),
        tools: { port: 5002 },
        commits: { answer: () => undefined },
      },
    );
    await expect(runBridgeWith(config(), io, host, { next: 0 })).resolves.toEqual({
      kind: "exhausted",
      attempts: 3,
    });
    expect(io.logs.join("\n")).not.toContain("boot-cred");
  });
});

describe("createAgentHost: the harness's own asks (record 09)", () => {
  it("forwards a permission ask and answers the harness once from the object's frame", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.opencode.subscriptions[0]?.deliver({
      kind: "permission_asked",
      requestId: "per_9",
      permission: "external_directory",
      callId: null,
      patterns: ["/etc/*"],
      metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
    });
    await tick();
    const request = h.outbound.events.find((event) => event.type === "approval.requested");
    expect(request).toMatchObject({
      runId: "run_1",
      payload: { category: "outside_project", resource: "/etc/hosts", toolCallId: null },
    });
    expect(h.opencode.replies).toEqual([]);
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "approval",
        requestRef: (request as { payload: { approvalId: string } }).payload.approvalId,
        outcome: "allowed",
        expiresAt: null,
      },
    });
    await tick();
    expect(h.opencode.replies).toEqual([{ requestId: "per_9", reply: "once", message: null }]);
  });
});

describe("createAgentHost: development secrets and the held tool call", () => {
  const FAKE_VALUE = "fake-stripe-test-key-0001";

  function secretGrant(
    requestRef: string | null,
    grantId = "grant_secret",
    value = FAKE_VALUE,
  ): AgentInput {
    return {
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "secret",
          grantId,
          expiresAt: "2026-09-21T00:10:00.000Z",
          secrets: [{ name: "STRIPE_TEST_KEY", value }],
          requestRef,
        }),
      },
    };
  }

  it("redacts a permission card's resource before cutting it, so no part of a value survives the cut", async () => {
    const multiLine = "multi-line-secret-one\nmulti-line-secret-two";
    const h = await booted();
    h.host.offer(secretGrant(null, "grant_one"));
    await tick();
    h.host.offer(secretGrant(null, "grant_two", multiLine));
    await tick();
    h.host.offer(runStart());
    await tick();
    // The supplied value starts at character 95, so a cut at 99 before
    // redaction would have kept its first characters.
    const straddling = `/tmp/${"a".repeat(90)}${FAKE_VALUE}/${"b".repeat(150)}`;
    h.opencode.subscriptions[0]?.deliver({
      kind: "permission_asked",
      requestId: "per_cut",
      permission: "external_directory",
      callId: null,
      patterns: [],
      metadata: { directories: [straddling, `/srv/${multiLine}`] },
    });
    await tick();
    const request = h.outbound.events.find((event) => event.type === "approval.requested") as
      | { payload: { resource: string } }
      | undefined;
    const resource = request?.payload.resource ?? "";
    expect(resource.length).toBeGreaterThan(0);
    expect(resource.length).toBeLessThanOrEqual(RESOURCE_MAX_CHARS);
    expect(resource).not.toContain(FAKE_VALUE.slice(0, 4));
    expect(resource).not.toContain("multi-line-secret");
    expect(resource).not.toContain("\n");
  });

  async function waitingOnApproval() {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    const events = h.opencode.subscriptions[0];
    events?.deliver({
      kind: "permission_asked",
      requestId: "per_1",
      permission: "oncue_secret_request",
      callId: "call_1",
    });
    events?.deliver({
      kind: "tool_part",
      messageId: "m1",
      part: {
        callId: "call_1",
        tool: "oncue_secret_request",
        status: "running",
        title: null,
        input: { name: "STRIPE_TEST_KEY" },
        output: null,
        error: null,
        exitCode: null,
        startedAtMs: null,
        endedAtMs: null,
      },
    });
    await tick();
    const request = h.outbound.events.find((event) => event.type === "approval.requested");
    if (request === undefined) {
      throw new Error("the bridge sent no approval.requested");
    }
    return { ...h, ref: (request.payload as { approvalId: string }).approvalId };
  }

  it("asks the control plane for the name the held call wants, and tells OpenCode nothing yet", async () => {
    const h = await waitingOnApproval();

    const request = h.outbound.events.find((event) => event.type === "approval.requested");
    expect(request).toMatchObject({
      runId: "run_1",
      payload: {
        category: "development_secret",
        resource: "STRIPE_TEST_KEY",
        toolCallId: "call_1",
      },
    });
    expect(h.opencode.replies).toEqual([]);
    expect(h.host.snapshot().secrets.waiting).toMatchObject({ requestId: "per_1", asked: true });
  });

  it("writes an approved value through the supervisor, acknowledges once it is written, then lets the call run", async () => {
    const h = await waitingOnApproval();

    h.host.offer(secretGrant(h.ref));
    await tick();

    expect(h.supervisor.secretNames).toEqual(["STRIPE_TEST_KEY"]);
    expect(h.outbound.acks.at(-1)).toMatchObject({
      ref: { grantId: "grant_secret" },
      outcome: { kind: "accepted" },
    });
    expect(h.opencode.replies).toEqual([{ requestId: "per_1", reply: "once", message: null }]);
    expect(h.host.snapshot().secrets).toMatchObject({
      supplied: ["STRIPE_TEST_KEY"],
      waiting: null,
    });
  });

  it("keeps the value out of its state, its logs, and everything it sends", async () => {
    const h = await waitingOnApproval();
    h.host.offer(secretGrant(h.ref));
    await tick();

    for (const surface of [h.host.snapshot(), h.io.logs, h.outbound.events, h.outbound.acks]) {
      expect(JSON.stringify(surface)).not.toContain(FAKE_VALUE);
    }
  });

  it("rejects the grant and the held call when the supervisor refuses, and logs the name, never the value", async () => {
    const h = await waitingOnApproval();
    h.supervisor.secretOutcome = { kind: "refused", denial: "secret_name_not_allowed" };

    h.host.offer(secretGrant(h.ref));
    await tick();

    expect(h.outbound.acks.at(-1)).toMatchObject({ outcome: { kind: "rejected" } });
    expect(h.opencode.replies).toMatchObject([{ requestId: "per_1", reply: "reject" }]);
    expect(h.io.logs.some((line) => line.includes("could not supply STRIPE_TEST_KEY"))).toBe(true);
    expect(JSON.stringify(h.io.logs)).not.toContain(FAKE_VALUE);
    expect(h.host.snapshot().secrets.supplied).toEqual([]);
  });

  it("rejects the held call with the user's answer when the control plane says denied", async () => {
    const h = await waitingOnApproval();
    h.host.offer({
      kind: "frame",
      frame: { kind: "approval", requestRef: h.ref, outcome: "denied", expiresAt: null },
    });
    await tick();

    expect(h.opencode.replies).toMatchObject([{ requestId: "per_1", reply: "reject" }]);
    expect(h.supervisor.secretNames).toEqual([]);
  });

  it("rejects the held call at the card's expiry on its own clock, with no frame saying so", async () => {
    const h = await waitingOnApproval();
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "approval",
        requestRef: h.ref,
        outcome: "pending",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });
    await tick();
    await tick();

    expect(h.opencode.replies).toMatchObject([{ requestId: "per_1", reply: "reject" }]);
  });

  it("rejects a held call when its run is cancelled, because OpenCode leaves the request behind", async () => {
    const h = await waitingOnApproval();
    h.host.offer(
      command("run.cancel", { reason: null, checkpointFirst: false }, "cmd_cancel", "run_1"),
    );
    await tick();
    h.opencode.subscriptions[0]?.deliver({ kind: "session_idle" });
    await tick();

    expect(h.opencode.replies).toMatchObject([{ requestId: "per_1", reply: "reject" }]);
    expect(h.host.snapshot().secrets.waiting).toBeNull();
  });

  it("says so, and releases nothing, when OpenCode does not take the answer", async () => {
    const h = await waitingOnApproval();
    h.opencode.replyOk = false;
    h.host.offer({
      kind: "frame",
      frame: { kind: "approval", requestRef: h.ref, outcome: "expired", expiresAt: null },
    });
    await tick();
    expect(h.io.logs.some((line) => line.includes("could not answer a held tool call"))).toBe(true);
  });

  async function supplied() {
    const h = await booted();
    h.host.offer(secretGrant(null, "grant_launch"));
    await tick();
    h.host.offer(runStart());
    await tick();
    const events = h.opencode.subscriptions[0];
    if (events === undefined) {
      throw new Error("no subscription");
    }
    return { ...h, events };
  }

  it("never streams a supplied value, however the model's text was cut, and leaves no gap in the sequence", async () => {
    const h = await supplied();
    const before = h.outbound.events.length;
    h.events.deliver({
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: `the key is ${FAKE_VALUE.slice(0, 7)}`,
    });
    h.events.deliver({
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: FAKE_VALUE.slice(7, 12),
    });
    h.events.deliver({
      kind: "text_delta",
      messageId: "m1",
      partId: "p1",
      text: `${FAKE_VALUE.slice(12)} so there`,
    });
    h.events.deliver({ kind: "session_idle" });
    await tick();

    const sent = h.outbound.events.slice(before);
    const streamed = sent
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { part: { text: string } }).part.text)
      .join("");
    expect(streamed).toBe("the key is [REDACTED] so there");
    expect(JSON.stringify(h.outbound.events)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(h.outbound.events)).not.toContain(FAKE_VALUE.slice(0, 7));
    // A chunk that was wholly held back took no sequence number.
    const sequences = h.outbound.events.map((event) => event.runtimeSequence as number);
    expect(sequences).toEqual(sequences.map((_, index) => index));
    // The durable message carries the whole text, redacted whole.
    const completed = sent.find((event) => event.type === "message.completed");
    expect(JSON.stringify(completed?.payload)).toContain("the key is [REDACTED] so there");
  });

  it("redacts a supplied value from a durable event and from a log line", async () => {
    const h = await supplied();
    h.events.deliver({
      kind: "tool_part",
      messageId: "m1",
      part: {
        callId: "call_echo",
        tool: "bash",
        status: "completed",
        title: `echo ${FAKE_VALUE}`,
        input: { command: `echo ${FAKE_VALUE}` },
        output: `${FAKE_VALUE}\n`,
        error: null,
        exitCode: 0,
        startedAtMs: 1,
        endedAtMs: 2,
      },
    });
    await tick();
    h.events.deliver({
      kind: "unknown",
      wireKind: `weird ${FAKE_VALUE}`,
      raw: `note ${FAKE_VALUE}`,
    });
    await tick();

    const tools = h.outbound.events.filter((event) => event.type.startsWith("tool."));
    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).toContain("[REDACTED]");
    // The timeline's tool row shows this field, so it must arrive redacted.
    const completed = tools.find((event) => event.type === "tool.completed");
    expect(completed?.payload).toMatchObject({ result: { value: { output: "[REDACTED]\n" } } });
    expect(JSON.stringify(h.outbound.events)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(h.io.logs)).not.toContain(FAKE_VALUE);
  });

  it("supplies a launch grant with no call waiting, and clears the secrets at shutdown", async () => {
    const h = await booted();
    h.host.offer(secretGrant(null, "grant_launch"));
    await tick();
    expect(h.outbound.acks.at(-1)).toMatchObject({
      ref: { grantId: "grant_launch" },
      outcome: { kind: "accepted" },
    });
    expect(h.opencode.replies).toEqual([]);

    h.host.offer(command("runtime.shutdown", { reason: "idle", graceMs: 1000 }, "cmd_down", null));
    await tick();
    expect(h.supervisor.secretsCleared).toBe(1);
  });
});

describe("createCommitAnswers (record 07, Commits)", () => {
  it("answers a waiting call once, drops a second answer, and answers a call nobody settles by its deadline", async () => {
    vi.useFakeTimers();
    try {
      const answers = createCommitAnswers();
      const first = answers.wait("req_1", 1_000);
      answers.answer("req_1", "Committed abcdef12.", false);
      answers.answer("req_1", "again", true);
      await expect(first).resolves.toEqual({ text: "Committed abcdef12.", isError: false });

      const late = answers.wait("req_2", 1_000);
      vi.advanceTimersByTime(1_000);
      await expect(late).resolves.toEqual({
        text: "Not committed: the commit did not finish in time.",
        isError: true,
      });
      // Answering after the deadline is a no-op, not a throw.
      answers.answer("req_2", "too late", false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createAgentHost: a question the harness waits on", () => {
  function questionAsked(requestId: string, text: string, label = "Postgres"): RuntimeEvent {
    return {
      kind: "question_asked",
      requestId,
      callId: "call_q",
      questions: [
        {
          id: "q1",
          header: "Database",
          text,
          options: [{ label, description: "" }],
          multiple: false,
          allowOther: true,
        },
      ],
      askedCount: 1,
    };
  }

  async function asking() {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    h.opencode.subscriptions[0]?.deliver(
      questionAsked("que_1", "Which database? Use sk-test-not-a-secret"),
    );
    await tick();
    const asked = h.outbound.events.find((event) => event.type === "question.asked");
    if (asked === undefined) {
      throw new Error("the bridge sent no question.asked");
    }
    return { ...h, ref: (asked.payload as { questionId: string }).questionId };
  }

  it("sends the question and answers OpenCode with the user's answers", async () => {
    const h = await asking();
    expect(h.opencode.questionReplies).toEqual([]);
    h.host.offer({
      kind: "frame",
      frame: { kind: "question", requestRef: h.ref, outcome: "answered", answers: [["Postgres"]] },
    });
    await tick();
    expect(h.opencode.questionReplies).toEqual([
      { requestId: "que_1", reply: { kind: "answer", answers: [["Postgres"]] } },
    ]);
  });

  it("logs a reply OpenCode did not take", async () => {
    const h = await asking();
    h.opencode.replyOk = false;
    h.host.offer({
      kind: "frame",
      frame: { kind: "question", requestRef: h.ref, outcome: "dismissed", answers: null },
    });
    await tick();
    expect(h.opencode.questionReplies).toEqual([
      { requestId: "que_1", reply: { kind: "dismiss", reason: "dismissed" } },
    ]);
    expect(h.io.logs.some((line) => line.includes("could not dismiss a waiting question"))).toBe(
      true,
    );
  });

  it("offers a question asked while the event stream was down once it reconnects", async () => {
    const h = await booted();
    h.host.offer(runStart());
    await tick();
    expect(h.opencode.pendingReads).toEqual([OPENCODE_PORT]);
    // The stream drops; OpenCode's question tool asks during the gap.
    h.opencode.pending = [questionAsked("que_gap", "Which database?")];
    h.opencode.subscriptions[0]?.end();
    await tick();
    await tick();
    await tick();
    expect(h.opencode.subscriptions).toHaveLength(2);
    expect(h.opencode.pendingReads).toEqual([OPENCODE_PORT, OPENCODE_PORT]);
    const asked = h.outbound.events.filter((event) => event.type === "question.asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject({
      questions: [{ text: "Which database?" }],
    });
    expect(h.host.snapshot().questions.waiting).toMatchObject({ requestId: "que_gap" });
    expect(h.opencode.questionReplies).toEqual([]);
  });

  it("neither re-sends nor dismisses the waiting question when a reconnect lists it again", async () => {
    const h = await asking();
    h.opencode.pending = [questionAsked("que_1", "Which database? Use sk-test-not-a-secret")];
    h.opencode.subscriptions[0]?.end();
    await tick();
    await tick();
    await tick();
    expect(h.opencode.subscriptions).toHaveLength(2);
    expect(h.outbound.events.filter((event) => event.type === "question.asked")).toHaveLength(1);
    expect(h.opencode.questionReplies).toEqual([]);
    expect(h.host.snapshot().questions.waiting).toMatchObject({ requestId: "que_1", ref: h.ref });
  });

  it("redacts a supplied secret from the question before it leaves the sandbox", async () => {
    /** Obviously fake. */
    const fake = "fake-question-secret-0001";
    const h = await booted();
    h.host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "secret",
          grantId: "grant_secret",
          expiresAt: "2026-09-21T00:10:00.000Z",
          secrets: [{ name: "DATABASE_URL", value: fake }],
          requestRef: null,
        }),
      },
    });
    await tick();
    h.host.offer(runStart());
    await tick();
    h.opencode.subscriptions[0]?.deliver(
      questionAsked("que_secret", `Should I use ${fake} for the database?`, `Use ${fake}`),
    );
    await tick();
    const asked = h.outbound.events.find((event) => event.type === "question.asked");
    expect(asked).toBeDefined();
    expect(JSON.stringify(asked?.payload)).not.toContain(fake);
    expect(asked?.payload).toMatchObject({
      questions: [
        {
          text: "Should I use [REDACTED] for the database?",
          options: [{ label: "Use [REDACTED]" }],
        },
      ],
    });
  });
});
