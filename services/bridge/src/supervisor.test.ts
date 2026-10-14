import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_ENV_KEY,
  BOOTSTRAP_FILE,
  BRIDGE_BUNDLE,
  BRIDGE_ENV_KEYS,
  BRIDGE_HOME,
  BRIDGE_OWNER,
  BRIDGE_UID,
  BRIDGE_USER_HOME,
  bridgeEnvironment,
  type CheckSpawnPlan,
  createSupervisor,
  DEFAULT_PATH,
  type DirectoryPlan,
  handle,
  INITIAL_STATE,
  type LineHandler,
  malformedResponse,
  nodeSupervisorIo,
  noteAgentExit,
  noteCheckEnded,
  type Owner,
  type ProcessExit,
  privilegedArgv,
  runSupervisor,
  type SpawnPlan,
  type SpawnProcess,
  type SupervisorIo,
  type SupervisorState,
  VERIFICATION_DIRECTORIES,
} from "./supervisor";
import {
  AGENT_UID,
  ALLOWED_BINARY,
  ALLOWED_CWD,
  ATTACHMENTS_ROOT,
  BASE_TREE_ROOT,
  CHECK_OUTPUT_DIR,
  type CheckExit,
  checkOutputPath,
  encodeRequest,
  MAX_LINE_BYTES,
  MAX_SECRETS,
  parseResponse,
  SANDBOX_CHECK_PATHS,
  SUPERVISOR_SOCKET,
  type SupervisorRequest,
} from "./supervisor-protocol";

interface Deferred {
  readonly promise: Promise<ProcessExit>;
  readonly resolve: (exit: ProcessExit) => void;
}

function deferred(): Deferred {
  let resolve: (exit: ProcessExit) => void = () => {};
  const promise = new Promise<ProcessExit>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Records every privileged call and lets the test decide when a process exits. */
class FakeIo implements SupervisorIo {
  readonly order: string[] = [];
  readonly spawns: SpawnPlan[] = [];
  readonly kills: { pid: number; signal: string }[] = [];
  readonly chowns: { path: string; uid: number; gid: number }[] = [];
  readonly credentials: { path: string; value: string; owner: Owner }[] = [];
  readonly listens: { path: string; owner: Owner }[] = [];
  readonly logs: string[] = [];
  readonly shutdownListeners: (() => void)[] = [];
  closedListeners = 0;
  onLine: LineHandler | null = null;
  spawnError: Error | null = null;
  killError: Error | null = null;
  chownError: Error | null = null;
  readonly checkSpawns: CheckSpawnPlan[] = [];
  readonly checkKills: { pid: number; signal: string }[] = [];
  readonly baseChowns: { path: string; fromUid: number; to: Owner }[] = [];
  readonly directories: DirectoryPlan[] = [];
  directoryError: Error | null = null;
  private readonly checkExits = new Map<
    number,
    { promise: Promise<CheckExit>; resolve: (exit: CheckExit) => void }
  >();
  /** True when a spawn happened while the probed environment still held the credential. */
  credentialSeenAtSpawn = false;
  private readonly exits = new Map<number, Deferred>();
  private nextPid = 100;

  constructor(private readonly probe: Record<string, string | undefined> = {}) {}

  spawn(plan: SpawnPlan): number {
    this.order.push("spawn");
    if (BOOTSTRAP_ENV_KEY in this.probe) {
      this.credentialSeenAtSpawn = true;
    }
    if (this.spawnError !== null) {
      throw this.spawnError;
    }
    const pid = this.nextPid;
    this.nextPid += 1;
    this.spawns.push({ ...plan, env: { ...plan.env } });
    this.exits.set(pid, deferred());
    return pid;
  }

  exit(pid: number, exit: ProcessExit): void {
    const entry = this.exits.get(pid);
    if (entry === undefined) {
      throw new Error(`the test exited pid ${pid}, which was never spawned`);
    }
    entry.resolve(exit);
  }

  chownRecursive(path: string, uid: number, gid: number): void {
    this.order.push("chown");
    if (this.chownError !== null) {
      throw this.chownError;
    }
    this.chowns.push({ path, uid, gid });
  }

  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.order.push("kill");
    if (this.killError !== null) {
      throw this.killError;
    }
    this.kills.push({ pid, signal });
  }

  wait(pid: number): Promise<ProcessExit> {
    const entry = this.exits.get(pid);
    return entry === undefined ? Promise.reject(new Error(`no process ${pid}`)) : entry.promise;
  }

  writeCredentialFile(path: string, value: string, owner: Owner): void {
    this.order.push("credential");
    this.credentials.push({ path, value, owner });
  }

  readonly secretWrites: { path: string; value: string; owner: Owner }[] = [];
  readonly secretClears: string[] = [];
  secretError: Error | null = null;

  writeSecretFile(path: string, value: string, owner: Owner): void {
    this.order.push("secret");
    if (this.secretError !== null) {
      throw this.secretError;
    }
    this.secretWrites.push({ path, value, owner });
  }

  clearSecretFiles(dir: string): void {
    this.order.push("clear_secrets");
    this.secretClears.push(dir);
  }

  spawnCheck(plan: CheckSpawnPlan): number {
    this.order.push("spawn_check");
    if (this.spawnError !== null) {
      throw this.spawnError;
    }
    const pid = this.nextPid;
    this.nextPid += 1;
    this.checkSpawns.push(plan);
    let resolve: (exit: CheckExit) => void = () => {};
    const promise = new Promise<CheckExit>((r) => {
      resolve = r;
    });
    this.checkExits.set(pid, { promise, resolve });
    return pid;
  }

  endCheck(pid: number, exit: CheckExit): void {
    this.checkExits.get(pid)?.resolve(exit);
  }

  waitCheck(pid: number): Promise<CheckExit> {
    return this.checkExits.get(pid)?.promise ?? Promise.reject(new Error(`no check ${pid}`));
  }

  killCheck(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    if (this.killError !== null) {
      throw this.killError;
    }
    this.checkKills.push({ pid, signal });
  }

  chownBaseTree(path: string, fromUid: number, to: Owner): void {
    if (this.chownError !== null) {
      throw this.chownError;
    }
    this.baseChowns.push({ path, fromUid, to });
  }

  makeDirectory(plan: DirectoryPlan): void {
    this.order.push("directory");
    if (this.directoryError !== null) {
      throw this.directoryError;
    }
    this.directories.push(plan);
  }

  listen(path: string, owner: Owner, onLine: LineHandler) {
    this.order.push("listen");
    this.listens.push({ path, owner });
    this.onLine = onLine;
    return Promise.resolve({
      close: () => {
        this.closedListeners += 1;
      },
    });
  }

  onShutdownSignal(listener: () => void): void {
    this.shutdownListeners.push(listener);
  }

  log(line: string): void {
    this.logs.push(line);
  }
}

const START: SupervisorRequest = {
  op: "start_agent",
  requestId: "start",
  argv: [ALLOWED_BINARY, "serve"],
  cwd: ALLOWED_CWD,
  env: { PATH: "/usr/bin" },
  uid: AGENT_UID,
};

const LIVE: SupervisorState = { ...INITIAL_STATE, agentPid: 100, agentExited: false };

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("handle: review comes first", () => {
  it("performs nothing for a request the review refused", async () => {
    const io = new FakeIo();
    const step = handle(INITIAL_STATE, { ...START, uid: 0 }, io);

    await expect(step.response).resolves.toEqual({
      requestId: "start",
      ok: false,
      refusal: { reason: "not_permitted", detail: "uid_not_allowed" },
    });
    expect(step.state).toBe(INITIAL_STATE);
    expect(io.order).toEqual([]);
  });
});

describe("handle: chown_workspace", () => {
  it("chowns the workspace, never a path from the request", async () => {
    const io = new FakeIo();
    const step = handle(
      INITIAL_STATE,
      { op: "chown_workspace", requestId: "c", uid: AGENT_UID },
      io,
    );

    await expect(step.response).resolves.toEqual({
      requestId: "c",
      ok: true,
      result: { op: "chown_workspace" },
    });
    expect(io.chowns).toEqual([{ path: ALLOWED_CWD, uid: AGENT_UID, gid: AGENT_UID }]);
  });

  it("reports an operating-system refusal as failed", async () => {
    const io = new FakeIo();
    io.chownError = new Error("EPERM: operation not permitted");
    const step = handle(
      INITIAL_STATE,
      { op: "chown_workspace", requestId: "c", uid: AGENT_UID },
      io,
    );

    await expect(step.response).resolves.toEqual({
      requestId: "c",
      ok: false,
      refusal: { reason: "failed", detail: "EPERM: operation not permitted" },
    });
  });
});

describe("handle: start_agent", () => {
  it("spawns exactly what was reviewed and tracks the pid", async () => {
    const io = new FakeIo();
    const step = handle(INITIAL_STATE, START, io);

    expect(step.state).toEqual({ ...INITIAL_STATE, agentPid: 100, agentExited: false });
    await expect(step.response).resolves.toEqual({
      requestId: "start",
      ok: true,
      result: { op: "start_agent", pid: 100 },
    });
    expect(io.spawns).toEqual([
      {
        argv: [ALLOWED_BINARY, "serve"],
        cwd: ALLOWED_CWD,
        env: { PATH: "/usr/bin" },
        uid: AGENT_UID,
      },
    ]);
  });

  it("refuses a second agent while one is live", async () => {
    const io = new FakeIo();
    const step = handle(LIVE, START, io);

    await expect(step.response).resolves.toEqual({
      requestId: "start",
      ok: false,
      refusal: { reason: "already_running" },
    });
    expect(io.spawns).toEqual([]);
  });

  it("allows a new agent once the previous one exited", () => {
    const io = new FakeIo();
    const step = handle({ ...INITIAL_STATE, agentPid: 7, agentExited: true }, START, io);

    expect(step.state).toEqual({ ...INITIAL_STATE, agentPid: 100, agentExited: false });
  });

  it("reports a spawn that failed and keeps the state", async () => {
    const io = new FakeIo();
    io.spawnError = new Error("could not start /opt/opencode/opencode");
    const step = handle(INITIAL_STATE, START, io);

    expect(step.state).toBe(INITIAL_STATE);
    await expect(step.response).resolves.toEqual({
      requestId: "start",
      ok: false,
      refusal: { reason: "failed", detail: "could not start /opt/opencode/opencode" },
    });
  });

  it("does not put an environment value in a failure detail", async () => {
    const io = new FakeIo();
    io.spawnError = new Error("spawn setpriv ENOENT");
    const request = { ...START, env: { OPENCODE_CONFIG_CONTENT: '{"secret":"value-xyz"}' } };
    const step = handle(INITIAL_STATE, request, io);

    expect(JSON.stringify(await step.response)).not.toContain("value-xyz");
  });
});

describe("handle: signal", () => {
  it("signals the live agent", async () => {
    const io = new FakeIo();
    const step = handle(LIVE, { op: "signal", requestId: "s", signal: "SIGTERM" }, io);

    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: true,
      result: { op: "signal" },
    });
    expect(io.kills).toEqual([{ pid: 100, signal: "SIGTERM" }]);
  });

  it.each([
    ["no agent was started", INITIAL_STATE],
    ["the agent already exited", { ...INITIAL_STATE, agentPid: 100, agentExited: true }],
  ])("answers no_such_agent when %s", async (_name, state) => {
    const io = new FakeIo();
    const step = handle(state, { op: "signal", requestId: "s", signal: "SIGKILL" }, io);

    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: false,
      refusal: { reason: "no_such_agent" },
    });
    expect(io.kills).toEqual([]);
  });

  it("reports a kill the operating system refused", async () => {
    const io = new FakeIo();
    io.killError = new Error("ESRCH");
    const step = handle(LIVE, { op: "signal", requestId: "s", signal: "SIGKILL" }, io);

    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: false,
      refusal: { reason: "failed", detail: "ESRCH" },
    });
  });
});

describe("handle: wait", () => {
  it("answers no_such_agent before any agent was started", async () => {
    const step = handle(INITIAL_STATE, { op: "wait", requestId: "w" }, new FakeIo());
    await expect(step.response).resolves.toEqual({
      requestId: "w",
      ok: false,
      refusal: { reason: "no_such_agent" },
    });
  });

  it("resolves with the exit when the agent exits, and changes no state on its own", async () => {
    const io = new FakeIo();
    const started = handle(INITIAL_STATE, START, io);
    const step = handle(started.state, { op: "wait", requestId: "w" }, io);
    expect(step.state).toBe(started.state);

    io.exit(100, { code: 0, signal: null });
    await expect(step.response).resolves.toEqual({
      requestId: "w",
      ok: true,
      result: { op: "wait", code: 0, signal: null },
    });
  });

  it("still answers for an agent that already exited", async () => {
    const io = new FakeIo();
    const started = handle(INITIAL_STATE, START, io);
    io.exit(100, { code: null, signal: "SIGKILL" });
    const step = handle(noteAgentExit(started.state, 100), { op: "wait", requestId: "w" }, io);

    await expect(step.response).resolves.toEqual({
      requestId: "w",
      ok: true,
      result: { op: "wait", code: null, signal: "SIGKILL" },
    });
  });

  it("reports a wait the io could not honour as failed", async () => {
    const io = new FakeIo();
    const step = handle(
      { ...INITIAL_STATE, agentPid: 999, agentExited: false },
      { op: "wait", requestId: "w" },
      io,
    );

    await expect(step.response).resolves.toEqual({
      requestId: "w",
      ok: false,
      refusal: { reason: "failed", detail: "no process 999" },
    });
  });
});

describe("noteAgentExit", () => {
  it("marks the tracked agent exited and ignores any other pid", () => {
    expect(noteAgentExit(LIVE, 100)).toEqual({
      ...INITIAL_STATE,
      agentPid: 100,
      agentExited: true,
    });
    expect(noteAgentExit(LIVE, 101)).toBe(LIVE);
    expect(noteAgentExit(INITIAL_STATE, 100)).toBe(INITIAL_STATE);
  });
});

describe("malformedResponse", () => {
  it("correlates when it can and answers an empty id when it cannot", () => {
    expect(malformedResponse('{"op":"exec","requestId":"r1"}')).toEqual({
      requestId: "r1",
      ok: false,
      refusal: { reason: "malformed" },
    });
    expect(malformedResponse(null)).toEqual({
      requestId: "",
      ok: false,
      refusal: { reason: "malformed" },
    });
  });
});

describe("createSupervisor", () => {
  function replies(): { lines: string[]; reply: (line: string) => void } {
    const lines: string[] = [];
    return { lines, reply: (line) => lines.push(line) };
  }

  it("answers a line it cannot parse with malformed, and a discarded line with an empty id", async () => {
    const supervisor = createSupervisor(new FakeIo());
    const { lines, reply } = replies();

    supervisor.handleLine('{"op":"exec","requestId":"x"}', reply);
    supervisor.handleLine(null, reply);
    await settle();

    expect(lines.map((line) => parseResponse(line.trim()))).toEqual([
      { requestId: "x", ok: false, refusal: { reason: "malformed" } },
      { requestId: "", ok: false, refusal: { reason: "malformed" } },
    ]);
  });

  it("learns of the agent's exit on its own, so a later signal is no_such_agent", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    const { lines, reply } = replies();

    supervisor.handleLine(encodeRequest(START), reply);
    await settle();
    expect(supervisor.snapshot()).toEqual({ ...INITIAL_STATE, agentPid: 100, agentExited: false });

    io.exit(100, { code: 1, signal: null });
    await settle();
    expect(supervisor.snapshot()).toEqual({ ...INITIAL_STATE, agentPid: 100, agentExited: true });

    supervisor.handleLine(
      encodeRequest({ op: "signal", requestId: "s", signal: "SIGTERM" }),
      reply,
    );
    await settle();
    expect(parseResponse((lines[1] as string).trim())).toEqual({
      requestId: "s",
      ok: false,
      refusal: { reason: "no_such_agent" },
    });
    expect(io.kills).toEqual([]);
  });

  it("marks the agent exited even when the wait itself fails", async () => {
    const io = new (class extends FakeIo {
      override wait(): Promise<ProcessExit> {
        return Promise.reject(new Error("lost"));
      }
    })();
    const supervisor = createSupervisor(io);

    supervisor.handleLine(encodeRequest(START), () => {});
    await settle();

    expect(supervisor.snapshot()).toEqual({ ...INITIAL_STATE, agentPid: 100, agentExited: true });
  });

  it("lets a wait and a signal be in flight at once", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    const { lines, reply } = replies();

    supervisor.handleLine(encodeRequest(START), reply);
    supervisor.handleLine(encodeRequest({ op: "wait", requestId: "w" }), reply);
    supervisor.handleLine(
      encodeRequest({ op: "signal", requestId: "s", signal: "SIGKILL" }),
      reply,
    );
    await settle();
    expect(lines.map((line) => parseResponse(line.trim())?.requestId)).toEqual(["start", "s"]);

    io.exit(100, { code: null, signal: "SIGKILL" });
    await settle();
    expect(parseResponse((lines[2] as string).trim())).toEqual({
      requestId: "w",
      ok: true,
      result: { op: "wait", code: null, signal: "SIGKILL" },
    });
  });

  it("killAgent signals only a live agent and reports what it did", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    expect(supervisor.killAgent("SIGKILL")).toBeNull();

    supervisor.handleLine(encodeRequest(START), () => {});
    await settle();
    expect(supervisor.killAgent("SIGKILL")).toBe(100);
    expect(io.kills).toEqual([{ pid: 100, signal: "SIGKILL" }]);

    io.killError = new Error("ESRCH");
    expect(supervisor.killAgent("SIGTERM")).toBeNull();
  });
});

describe("bridgeEnvironment", () => {
  it("copies only the allowlisted keys and fixes HOME to the bridge user's", () => {
    expect(
      bridgeEnvironment({
        PATH: "/custom/bin",
        HOME: "/root",
        ONCUE_SESSION_ID: "sess_1",
        ONCUE_SANDBOX_GENERATION: "3",
        ONCUE_CONTROL_PLANE_ORIGIN: "https://oncue.example",
        ONCUE_BOOTSTRAP_FILE: BOOTSTRAP_FILE,
        [BOOTSTRAP_ENV_KEY]: "boot-secret",
        ONCUE_MODAL_TOKEN: "modal",
        ANTHROPIC_API_KEY: "key",
      }),
    ).toEqual({
      PATH: "/custom/bin",
      HOME: BRIDGE_USER_HOME,
      ONCUE_SESSION_ID: "sess_1",
      ONCUE_SANDBOX_GENERATION: "3",
      ONCUE_CONTROL_PLANE_ORIGIN: "https://oncue.example",
      ONCUE_BOOTSTRAP_FILE: BOOTSTRAP_FILE,
    });
  });

  it("supplies a PATH when the container gave none and skips absent keys", () => {
    expect(bridgeEnvironment({})).toEqual({ PATH: DEFAULT_PATH, HOME: BRIDGE_USER_HOME });
  });

  it("never lists the Modal Secret key", () => {
    expect(BRIDGE_ENV_KEYS).not.toContain(BOOTSTRAP_ENV_KEY);
  });
});

describe("privilegedArgv", () => {
  it("wraps the command in setpriv with numeric ids and cleared groups, as the entrypoint did", () => {
    expect(privilegedArgv(1000, ["node", BRIDGE_BUNDLE])).toEqual([
      "setpriv",
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "node",
      BRIDGE_BUNDLE,
    ]);
  });
});

describe("runSupervisor", () => {
  function environment(): Record<string, string | undefined> {
    return {
      PATH: "/usr/bin",
      HOME: "/root",
      [BOOTSTRAP_ENV_KEY]: "boot-secret-value",
      ONCUE_SESSION_ID: "sess_1",
      ONCUE_SANDBOX_GENERATION: "3",
      ONCUE_CONTROL_PLANE_ORIGIN: "https://oncue.example",
      ONCUE_BOOTSTRAP_FILE: BOOTSTRAP_FILE,
      ONCUE_MODAL_TOKEN: "not-for-the-bridge",
    };
  }

  it("writes the credential, drops it, listens, then starts the bridge with a clean environment", async () => {
    const env = environment();
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();

    expect(io.order).toEqual([
      "credential",
      "directory",
      "directory",
      "directory",
      // The secrets directory exists before the bridge, and so before any agent.
      "directory",
      // Composer attachments: made before the bridge starts, like the others.
      "directory",
      "listen",
      "spawn",
    ]);
    expect(io.directories).toEqual(VERIFICATION_DIRECTORIES);
    expect(io.credentials).toEqual([
      { path: BOOTSTRAP_FILE, value: "boot-secret-value", owner: BRIDGE_OWNER },
    ]);
    expect(BOOTSTRAP_ENV_KEY in env).toBe(false);
    expect(io.credentialSeenAtSpawn).toBe(false);
    expect(io.listens).toEqual([{ path: SUPERVISOR_SOCKET, owner: BRIDGE_OWNER }]);
    expect(io.spawns).toEqual([
      {
        argv: ["node", BRIDGE_BUNDLE],
        cwd: BRIDGE_HOME,
        env: {
          PATH: "/usr/bin",
          HOME: BRIDGE_USER_HOME,
          ONCUE_SESSION_ID: "sess_1",
          ONCUE_SANDBOX_GENERATION: "3",
          ONCUE_CONTROL_PLANE_ORIGIN: "https://oncue.example",
          ONCUE_BOOTSTRAP_FILE: BOOTSTRAP_FILE,
        },
        uid: BRIDGE_UID,
      },
    ]);

    io.exit(100, { code: 0, signal: null });
    await expect(run).resolves.toBe(0);
    expect(io.closedListeners).toBe(1);
    expect(io.logs.join("\n")).not.toContain("boot-secret-value");
  });

  it("exits with the bridge's code and kills a live agent first", async () => {
    const env = environment();
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();

    io.onLine?.(encodeRequest(START), () => {});
    await settle();
    expect(io.spawns).toHaveLength(2);

    io.exit(100, { code: 3, signal: null });
    await settle();
    expect(io.kills).toEqual([{ pid: 101, signal: "SIGKILL" }]);

    io.exit(101, { code: null, signal: "SIGKILL" });
    await expect(run).resolves.toBe(3);
    expect(io.logs).toContain("supervisor: bridge exited with code 3");
  });

  it("does not kill an agent that already exited", async () => {
    const env = environment();
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();
    io.onLine?.(encodeRequest(START), () => {});
    await settle();
    io.exit(101, { code: 0, signal: null });
    await settle();

    io.exit(100, { code: 0, signal: null });
    await expect(run).resolves.toBe(0);
    expect(io.kills).toEqual([]);
  });

  it("treats a bridge killed by a signal as a failure", async () => {
    const env = environment();
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();

    io.exit(100, { code: null, signal: "SIGTERM" });
    await expect(run).resolves.toBe(1);
    expect(io.logs).toContain("supervisor: bridge exited on SIGTERM");
  });

  it("forwards the container's SIGTERM to the bridge", async () => {
    const env = environment();
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();

    expect(io.shutdownListeners).toHaveLength(1);
    io.shutdownListeners[0]?.();
    expect(io.kills).toEqual([{ pid: 100, signal: "SIGTERM" }]);

    io.killError = new Error("ESRCH");
    expect(() => io.shutdownListeners[0]?.()).not.toThrow();

    io.exit(100, { code: 0, signal: null });
    await run;
  });

  it("fails, and closes the socket, when the bridge cannot be started", async () => {
    const env = environment();
    const io = new FakeIo(env);
    io.spawnError = new Error("could not start node");

    await expect(runSupervisor(env, io)).resolves.toBe(1);
    expect(io.closedListeners).toBe(1);
    expect(io.logs).toContain("supervisor could not start the bridge: could not start node");
  });

  it("still writes the file and says so when the credential is absent", async () => {
    const env = environment();
    delete env[BOOTSTRAP_ENV_KEY];
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();

    expect(io.credentials).toEqual([{ path: BOOTSTRAP_FILE, value: "", owner: BRIDGE_OWNER }]);
    expect(io.logs).toContain("supervisor found no bootstrap credential in the environment");
    io.exit(100, { code: 0, signal: null });
    await run;
  });
});

const CHECK_EXIT: CheckExit = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 12,
  outputBytes: 40,
  truncated: false,
};

function runCheckRequest(
  overrides: Partial<Extract<SupervisorRequest, { op: "run_check" }>> = {},
): Extract<SupervisorRequest, { op: "run_check" }> {
  return {
    op: "run_check",
    requestId: "check",
    checkRunId: "chk_1",
    command: "npm test",
    cwd: ALLOWED_CWD,
    env: { PATH: "/usr/bin", CI: "1" },
    uid: AGENT_UID,
    timeoutMs: 60_000,
    outputPath: checkOutputPath("chk_1", SANDBOX_CHECK_PATHS),
    ...overrides,
  };
}

describe("handle: run_check", () => {
  it("starts the reviewed command with a bridge-owned output file and answers when it ends", async () => {
    const io = new FakeIo();
    const step = handle(INITIAL_STATE, runCheckRequest(), io);

    expect(step.state).toEqual({ ...INITIAL_STATE, check: { checkRunId: "chk_1", pid: 100 } });
    expect(io.checkSpawns).toEqual([
      {
        command: "npm test",
        cwd: ALLOWED_CWD,
        env: { PATH: "/usr/bin", CI: "1" },
        uid: AGENT_UID,
        timeoutMs: 60_000,
        outputPath: `${CHECK_OUTPUT_DIR}/chk_1.log`,
        outputOwner: BRIDGE_OWNER,
      },
    ]);
    io.endCheck(100, CHECK_EXIT);
    await expect(step.response).resolves.toEqual({
      requestId: "check",
      ok: true,
      result: { op: "run_check", ...CHECK_EXIT },
    });
  });

  it("performs nothing for a refused check", async () => {
    const io = new FakeIo();
    const step = handle(INITIAL_STATE, runCheckRequest({ uid: BRIDGE_UID }), io);

    await expect(step.response).resolves.toEqual({
      requestId: "check",
      ok: false,
      refusal: { reason: "not_permitted", detail: "uid_not_allowed" },
    });
    expect(io.order).toEqual([]);
  });

  it("refuses a second check while one runs", async () => {
    const io = new FakeIo();
    const running: SupervisorState = { ...INITIAL_STATE, check: { checkRunId: "chk_0", pid: 9 } };
    const step = handle(running, runCheckRequest(), io);

    expect(step.state).toBe(running);
    await expect(step.response).resolves.toEqual({
      requestId: "check",
      ok: false,
      refusal: { reason: "already_running" },
    });
    expect(io.checkSpawns).toEqual([]);
  });

  it("reports a check that could not start, and one whose wait failed", async () => {
    const io = new FakeIo();
    io.spawnError = new Error("EEXIST: output file exists");
    const failed = handle(INITIAL_STATE, runCheckRequest(), io);
    expect(failed.state).toBe(INITIAL_STATE);
    await expect(failed.response).resolves.toEqual({
      requestId: "check",
      ok: false,
      refusal: { reason: "failed", detail: "EEXIST: output file exists" },
    });

    const lost = new (class extends FakeIo {
      override waitCheck(): Promise<CheckExit> {
        return Promise.reject(new Error("lost"));
      }
    })();
    await expect(handle(INITIAL_STATE, runCheckRequest(), lost).response).resolves.toEqual({
      requestId: "check",
      ok: false,
      refusal: { reason: "failed", detail: "lost" },
    });
  });
});

describe("handle: signal_check", () => {
  const running: SupervisorState = { ...INITIAL_STATE, check: { checkRunId: "chk_1", pid: 31 } };

  it("signals the running check's group", async () => {
    const io = new FakeIo();
    const step = handle(
      running,
      { op: "signal_check", requestId: "s", checkRunId: "chk_1", signal: "SIGTERM" },
      io,
    );
    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: true,
      result: { op: "signal_check" },
    });
    expect(io.checkKills).toEqual([{ pid: 31, signal: "SIGTERM" }]);
  });

  it.each([
    ["no check runs", INITIAL_STATE, "chk_1"],
    ["another check runs", running, "chk_2"],
  ])("answers no_such_check when %s", async (_name, state, checkRunId) => {
    const io = new FakeIo();
    const step = handle(
      state,
      { op: "signal_check", requestId: "s", checkRunId, signal: "SIGKILL" },
      io,
    );
    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: false,
      refusal: { reason: "no_such_check" },
    });
    expect(io.checkKills).toEqual([]);
  });

  it("reports a kill the operating system refused", async () => {
    const io = new FakeIo();
    io.killError = new Error("ESRCH");
    const step = handle(
      running,
      { op: "signal_check", requestId: "s", checkRunId: "chk_1", signal: "SIGKILL" },
      io,
    );
    await expect(step.response).resolves.toEqual({
      requestId: "s",
      ok: false,
      refusal: { reason: "failed", detail: "ESRCH" },
    });
  });
});

describe("handle: prepare_base", () => {
  const request: SupervisorRequest = {
    op: "prepare_base",
    requestId: "b",
    dir: `${BASE_TREE_ROOT}/run_1`,
    uid: AGENT_UID,
  };

  it("hands only what the bridge made to the agent", async () => {
    const io = new FakeIo();
    await expect(handle(INITIAL_STATE, request, io).response).resolves.toEqual({
      requestId: "b",
      ok: true,
      result: { op: "prepare_base" },
    });
    expect(io.baseChowns).toEqual([
      {
        path: `${BASE_TREE_ROOT}/run_1`,
        fromUid: BRIDGE_UID,
        to: { uid: AGENT_UID, gid: AGENT_UID },
      },
    ]);
  });

  it("reports a tree it could not hand over", async () => {
    const io = new FakeIo();
    io.chownError = new Error("the base tree is not a directory the bridge made");
    await expect(handle(INITIAL_STATE, request, io).response).resolves.toEqual({
      requestId: "b",
      ok: false,
      refusal: { reason: "failed", detail: "the base tree is not a directory the bridge made" },
    });
  });
});

describe("handle: prepare_attachments (composer attachments)", () => {
  const request: SupervisorRequest = {
    op: "prepare_attachments",
    requestId: "a",
    dir: `${ATTACHMENTS_ROOT}/mmsg_1-x`,
    uid: AGENT_UID,
  };

  it("hands the directory the bridge wrote to the agent with the base checkout's chown", async () => {
    const io = new FakeIo();
    await expect(handle(INITIAL_STATE, request, io).response).resolves.toEqual({
      requestId: "a",
      ok: true,
      result: { op: "prepare_attachments" },
    });
    expect(io.baseChowns).toEqual([
      {
        path: `${ATTACHMENTS_ROOT}/mmsg_1-x`,
        fromUid: BRIDGE_UID,
        to: { uid: AGENT_UID, gid: AGENT_UID },
      },
    ]);
  });

  it("reports a directory it could not hand over", async () => {
    const io = new FakeIo();
    io.chownError = new Error("the base tree is not a directory the bridge made");
    await expect(handle(INITIAL_STATE, request, io).response).resolves.toMatchObject({
      ok: false,
      refusal: { reason: "failed" },
    });
  });

  it("refuses a directory outside the attachments root before touching anything", async () => {
    const io = new FakeIo();
    await expect(
      handle(INITIAL_STATE, { ...request, dir: "/workspace" }, io).response,
    ).resolves.toEqual({
      requestId: "a",
      ok: false,
      refusal: { reason: "not_permitted", detail: "attachment_dir_not_allowed" },
    });
    expect(io.baseChowns).toEqual([]);
  });
});

describe("createSupervisor: checks", () => {
  it("forgets a check once it has answered, so the next one may start", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    const lines: string[] = [];

    supervisor.handleLine(encodeRequest(runCheckRequest()), (line) => lines.push(line));
    supervisor.handleLine(encodeRequest(runCheckRequest({ requestId: "again" })), (line) =>
      lines.push(line),
    );
    await settle();
    expect(supervisor.snapshot().check).toEqual({ checkRunId: "chk_1", pid: 100 });
    expect(parseResponse((lines[0] as string).trim())).toEqual({
      requestId: "again",
      ok: false,
      refusal: { reason: "already_running" },
    });

    io.endCheck(100, CHECK_EXIT);
    await settle();
    expect(supervisor.snapshot().check).toBeNull();
    expect(parseResponse((lines[1] as string).trim())?.requestId).toBe("check");
  });

  it("killCheck signals only a running check", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    expect(supervisor.killCheck("SIGKILL")).toBeNull();

    supervisor.handleLine(encodeRequest(runCheckRequest()), () => {});
    await settle();
    expect(supervisor.killCheck("SIGKILL")).toBe(100);
    expect(io.checkKills).toEqual([{ pid: 100, signal: "SIGKILL" }]);

    io.killError = new Error("ESRCH");
    expect(supervisor.killCheck("SIGKILL")).toBeNull();
  });

  it("noteCheckEnded ignores a check it is not tracking", () => {
    const running: SupervisorState = { ...INITIAL_STATE, check: { checkRunId: "chk_1", pid: 5 } };
    expect(noteCheckEnded(running, "chk_2")).toBe(running);
    expect(noteCheckEnded(running, "chk_1")).toEqual(INITIAL_STATE);
  });
});

describe("runSupervisor: verification directories", () => {
  it("makes them root-owned, the bridge's group reading logs and creating base checkouts", () => {
    expect(VERIFICATION_DIRECTORIES).toEqual([
      { path: "/var/lib/oncue", owner: { uid: 0, gid: 0 }, mode: 0o755 },
      { path: CHECK_OUTPUT_DIR, owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o750 },
      { path: BASE_TREE_ROOT, owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o771 },
      // The agent's group reads its secrets; nobody but root writes here.
      { path: "/var/lib/oncue/secrets", owner: { uid: 0, gid: AGENT_UID }, mode: 0o750 },
      // Composer attachments: made by the bridge, reached by the agent only by name.
      { path: "/var/lib/oncue/attachments", owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o771 },
    ]);
  });

  it("logs a directory it could not make and still starts the bridge", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const io = new FakeIo(env);
    io.directoryError = new Error("EROFS");
    const run = runSupervisor(env, io);
    await settle();

    expect(io.logs).toContain("supervisor could not prepare /var/lib/oncue: EROFS");
    expect(io.spawns).toHaveLength(1);
    io.exit(100, { code: 0, signal: null });
    await run;
  });

  it("kills a running check when the bridge exits", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const io = new FakeIo(env);
    const run = runSupervisor(env, io);
    await settle();
    io.onLine?.(encodeRequest(runCheckRequest()), () => {});
    await settle();

    io.exit(100, { code: 0, signal: null });
    await expect(run).resolves.toBe(0);
    expect(io.checkKills).toEqual([{ pid: 101, signal: "SIGKILL" }]);
  });
});

// No uid change happens here: `spawnProcess` is injected so the test
// asserts the setpriv request rather than performing it.

class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  killResult = true;
  constructor(readonly pid: number | undefined) {
    super();
  }
  kill(signal?: string): boolean {
    this.signals.push(signal ?? "");
    return this.killResult;
  }
}

describe("nodeSupervisorIo: processes", () => {
  function spawner(child: FakeChild) {
    const calls: Parameters<SpawnProcess>[] = [];
    const spawnProcess: SpawnProcess = (command, args, options) => {
      calls.push([command, args, options]);
      return child as unknown as ReturnType<SpawnProcess>;
    };
    return { calls, io: nodeSupervisorIo(spawnProcess) };
  }

  it("asks setpriv for the uid drop and hands the child exactly the reviewed environment", () => {
    const child = new FakeChild(4242);
    const { calls, io } = spawner(child);

    const pid = io.spawn({
      argv: [ALLOWED_BINARY, "serve"],
      cwd: ALLOWED_CWD,
      env: { PATH: "/usr/bin" },
      uid: AGENT_UID,
    });

    expect(pid).toBe(4242);
    expect(calls).toEqual([
      [
        "setpriv",
        ["--reuid=1001", "--regid=1001", "--clear-groups", ALLOWED_BINARY, "serve"],
        { cwd: ALLOWED_CWD, env: { PATH: "/usr/bin" }, stdio: "inherit" },
      ],
    ]);
  });

  it("throws when the child never got a pid, without naming anything but the binary", () => {
    const { io } = spawner(new FakeChild(undefined));
    expect(() =>
      io.spawn({ argv: [ALLOWED_BINARY], cwd: ALLOWED_CWD, env: { HOME: "/h" }, uid: AGENT_UID }),
    ).toThrow("could not start /opt/opencode/opencode");
  });

  it("signals through the child handle and refuses a pid it does not own", () => {
    const child = new FakeChild(7);
    const { io } = spawner(child);
    io.spawn({ argv: [ALLOWED_BINARY], cwd: ALLOWED_CWD, env: {}, uid: AGENT_UID });

    io.kill(7, "SIGTERM");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(() => io.kill(8, "SIGTERM")).toThrow("no process 8 to signal");

    child.killResult = false;
    expect(() => io.kill(7, "SIGKILL")).toThrow("no process 7 to signal");
  });

  it("resolves a wait on exit, again afterwards, and rejects for an unknown pid", async () => {
    const child = new FakeChild(9);
    const { io } = spawner(child);
    io.spawn({ argv: [ALLOWED_BINARY], cwd: ALLOWED_CWD, env: {}, uid: AGENT_UID });

    const first = io.wait(9);
    child.emit("exit", 2, null);
    await expect(first).resolves.toEqual({ code: 2, signal: null });
    await expect(io.wait(9)).resolves.toEqual({ code: 2, signal: null });
    await expect(io.wait(10)).rejects.toThrow("no process 10 to wait for");
  });

  it("resolves a wait when the child errors instead of exiting", async () => {
    const child = new FakeChild(11);
    const { io } = spawner(child);
    io.spawn({ argv: [ALLOWED_BINARY], cwd: ALLOWED_CWD, env: {}, uid: AGENT_UID });

    child.emit("error", new Error("spawn failed late"));
    await expect(io.wait(11)).resolves.toEqual({ code: null, signal: null });
  });
});

/**
 * `os.tmpdir()` rather than the session scratchpad: a Unix socket path must
 * fit in `sun_path` (104 bytes on macOS) and the scratchpad's path does not.
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oncue-sup-"));
}

/** This process's own ids: the only owner a test running without root can chown to. */
const SELF: Owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

describe("nodeSupervisorIo: files", () => {
  it("writes the credential file readable by its owner only", () => {
    const path = join(tempDir(), "bootstrap");
    nodeSupervisorIo().writeCredentialFile(path, "boot-value", SELF);

    expect(readFileSync(path, "utf8")).toBe("boot-value");
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  it("runs a check behind setpriv as the agent, writes its log, and forgets it once it ends", async () => {
    const dir = tempDir();
    const calls: string[][] = [];
    // setpriv needs root; the real child is the command setpriv would exec.
    const io = nodeSupervisorIo((command, args, options) => {
      calls.push([command, ...args]);
      return nodeSpawn(args[3] as string, args.slice(4), options);
    });
    const outputPath = join(dir, "chk_1.log");
    const pid = io.spawnCheck({
      command: "echo checked; exit 4",
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      uid: AGENT_UID,
      timeoutMs: 10_000,
      outputPath,
      outputOwner: SELF,
    });

    expect(calls).toEqual([
      [
        "setpriv",
        "--reuid=1001",
        "--regid=1001",
        "--clear-groups",
        "/bin/sh",
        "-c",
        "echo checked; exit 4",
      ],
    ]);
    await expect(io.waitCheck(pid)).resolves.toMatchObject({ exitCode: 4, timedOut: false });
    expect(readFileSync(outputPath, "utf8")).toBe("checked\n");
    await settle();
    await expect(io.waitCheck(pid)).rejects.toThrow(`no check ${pid} to wait for`);
    expect(() => io.killCheck(pid, "SIGTERM")).toThrow(`no check ${pid} to signal`);
  });

  it("signals a running check's group", async () => {
    const dir = tempDir();
    const io = nodeSupervisorIo((_command, args, options) =>
      nodeSpawn(args[3] as string, args.slice(4), options),
    );
    const pid = io.spawnCheck({
      command: "sleep 30",
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      uid: AGENT_UID,
      timeoutMs: 10_000,
      outputPath: join(dir, "chk_2.log"),
      outputOwner: SELF,
    });
    io.killCheck(pid, "SIGKILL");
    await expect(io.waitCheck(pid)).resolves.toMatchObject({ signal: "SIGKILL" });
  });

  it("hands over a base tree only when the bridge made it, and skips hard links", () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.js"), "x");
    writeFileSync(join(root, "linked"), "y");
    linkSync(join(root, "linked"), join(root, "src", "second-name"));
    symlinkSync("/etc/passwd", join(root, "src", "planted"));
    const io = nodeSupervisorIo();

    expect(() => io.chownBaseTree(root, SELF.uid, SELF)).not.toThrow();
    expect(() => io.chownBaseTree(root, SELF.uid + 1, SELF)).toThrow(
      "the base tree is not a directory the bridge made",
    );
    expect(() => io.chownBaseTree(join(root, "linked"), SELF.uid, SELF)).toThrow(
      "the base tree is not a directory the bridge made",
    );
  });

  it("makes a directory with its mode, accepts one that exists, and refuses a symlink", () => {
    const root = tempDir();
    const io = nodeSupervisorIo();
    const plan = { path: join(root, "checks"), owner: SELF, mode: 0o750 };

    io.makeDirectory(plan);
    io.makeDirectory(plan);
    expect(statSync(plan.path).mode & 0o777).toBe(0o750);

    symlinkSync(root, join(root, "link"));
    expect(() => io.makeDirectory({ ...plan, path: join(root, "link") })).toThrow(
      "is not a directory",
    );
    expect(() => io.makeDirectory({ ...plan, path: join(root, "missing", "deeper") })).toThrow();
  });

  it("chowns a tree without following the links in it", () => {
    const root = tempDir();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file"), "x");
    symlinkSync("/nowhere/that/exists", join(root, "nested", "dangling"));

    expect(() => nodeSupervisorIo().chownRecursive(root, SELF.uid, SELF.gid)).not.toThrow();
    expect(lstatSync(join(root, "nested", "dangling")).isSymbolicLink()).toBe(true);
  });
});

describe("nodeSupervisorIo: the socket", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) {
      close();
    }
  });

  async function serve(onLine: LineHandler): Promise<string> {
    const path = join(tempDir(), "supervisor.sock");
    const listener = await nodeSupervisorIo().listen(path, SELF, onLine);
    closers.push(() => listener.close());
    return path;
  }

  function talk(path: string, lines: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const received: string[] = [];
      const socket = connect(path, () => {
        socket.write(lines.join(""));
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received.push(...chunk.split("\n").filter((line) => line.length > 0));
        if (received.length >= lines.length) {
          socket.end();
        }
      });
      socket.once("close", () => resolve(received));
      socket.once("error", reject);
    });
  }

  it("is owner-only and answers each line on the connection it came from", async () => {
    const path = await serve((line, reply) => reply(`echo:${line}\n`));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(talk(path, ["one\n", "two\n"])).resolves.toEqual(["echo:one", "echo:two"]);
  });

  it("hands a discarded line on as null", async () => {
    const seen: (string | null)[] = [];
    const path = await serve((line, reply) => {
      seen.push(line);
      reply("ack\n");
    });

    await talk(path, [`${"x".repeat(MAX_LINE_BYTES + 1)}\n`]);
    expect(seen).toEqual([null]);
  });

  it("serves the real supervisor end to end, with the process operations faked", async () => {
    const io = new FakeIo();
    const supervisor = createSupervisor(io);
    const path = await serve(supervisor.handleLine);

    const answers = await talk(path, [
      encodeRequest({ op: "chown_workspace", requestId: "c", uid: AGENT_UID }),
      encodeRequest(START),
      encodeRequest({ op: "signal", requestId: "s", signal: "SIGSTOP" }),
    ]);

    expect(answers.map((line) => parseResponse(line))).toEqual([
      { requestId: "c", ok: true, result: { op: "chown_workspace" } },
      { requestId: "start", ok: true, result: { op: "start_agent", pid: 100 } },
      {
        requestId: "s",
        ok: false,
        refusal: { reason: "not_permitted", detail: "signal_not_allowed" },
      },
    ]);
    expect(io.chowns).toEqual([{ path: ALLOWED_CWD, uid: AGENT_UID, gid: AGENT_UID }]);
  });

  it("rejects a path it cannot bind", async () => {
    await expect(
      nodeSupervisorIo().listen(join(tempDir(), "missing", "supervisor.sock"), SELF, () => {}),
    ).rejects.toThrow();
  });

  it.skipIf(SELF.uid === 0)(
    "rejects a socket it cannot hand to its owner, and releases the path",
    async () => {
      const path = join(tempDir(), "supervisor.sock");
      await expect(nodeSupervisorIo().listen(path, { uid: 0, gid: 0 }, () => {})).rejects.toThrow();
      const again = await nodeSupervisorIo().listen(path, SELF, () => {});
      again.close();
    },
  );
});

describe("handle: write_secret and clear_secrets", () => {
  const FAKE_VALUE = "fake-database-url-0001";
  const write = (name = "DATABASE_URL", value = FAKE_VALUE): SupervisorRequest => ({
    op: "write_secret",
    requestId: "sec",
    name,
    value,
  });

  it("writes the one file for that name, for root and the agent's group only, and answers without the value", async () => {
    const io = new FakeIo();
    const step = handle(INITIAL_STATE, write(), io);

    expect(io.secretWrites).toEqual([
      {
        path: "/var/lib/oncue/secrets/DATABASE_URL",
        value: FAKE_VALUE,
        owner: { uid: 0, gid: AGENT_UID },
      },
    ]);
    const response = await step.response;
    expect(response).toEqual({ requestId: "sec", ok: true, result: { op: "write_secret" } });
    expect(JSON.stringify(response)).not.toContain(FAKE_VALUE);
  });

  it("performs nothing for a name or value the review refuses", async () => {
    const io = new FakeIo();
    for (const request of [write("../evil"), write("GITHUB_TOKEN"), write("A_NAME", "short")]) {
      const step = handle(INITIAL_STATE, request, io);
      expect(step.state).toBe(INITIAL_STATE);
      expect((await step.response).ok).toBe(false);
    }
    expect(io.order).toEqual([]);
  });

  it("gives later checks the value in their environment, and only later ones", async () => {
    const io = new FakeIo();
    const before = handle(INITIAL_STATE, runCheckRequest(), io);
    io.endCheck(100, CHECK_EXIT);
    await before.response;
    const written = handle(noteCheckEnded(before.state, "chk_1"), write(), io);
    handle(written.state, runCheckRequest(), io);

    expect(io.checkSpawns[0]?.env).toEqual({ PATH: "/usr/bin", CI: "1" });
    expect(io.checkSpawns[1]?.env).toEqual({
      DATABASE_URL: FAKE_VALUE,
      PATH: "/usr/bin",
      CI: "1",
    });
  });

  it("replaces a name's value and refuses a twenty-first name", async () => {
    const io = new FakeIo();
    let state = INITIAL_STATE;
    for (let index = 0; index < MAX_SECRETS; index += 1) {
      state = handle(state, write(`NAME_${index}`), io).state;
    }
    const replaced = handle(state, write("NAME_0", "fake-replacement-0002"), io);
    expect((await replaced.response).ok).toBe(true);

    const overflow = handle(replaced.state, write("ONE_TOO_MANY"), io);
    await expect(overflow.response).resolves.toEqual({
      requestId: "sec",
      ok: false,
      refusal: { reason: "not_permitted", detail: "too_many_secrets" },
    });
    expect(io.secretWrites).toHaveLength(MAX_SECRETS + 1);
  });

  it("reports a failed write without the value, and remembers nothing", async () => {
    const io = new FakeIo();
    io.secretError = new Error(
      "EACCES: permission denied, open '/var/lib/oncue/secrets/DATABASE_URL'",
    );
    const step = handle(INITIAL_STATE, write(), io);

    const response = await step.response;
    expect(response).toMatchObject({ ok: false, refusal: { reason: "failed" } });
    expect(JSON.stringify(response)).not.toContain(FAKE_VALUE);
    expect(step.state).toBe(INITIAL_STATE);
  });

  it("clears every file and forgets every value, so a later check gets none", async () => {
    const io = new FakeIo();
    const written = handle(INITIAL_STATE, write(), io);
    const cleared = handle(written.state, { op: "clear_secrets", requestId: "clr" }, io);

    await expect(cleared.response).resolves.toEqual({
      requestId: "clr",
      ok: true,
      result: { op: "clear_secrets" },
    });
    expect(io.secretClears).toEqual(["/var/lib/oncue/secrets"]);
    handle(cleared.state, runCheckRequest(), io);
    expect(io.checkSpawns[0]?.env).toEqual({ PATH: "/usr/bin", CI: "1" });
  });

  it("prepares the secrets directory for root and the agent's group, where neither the agent nor the bridge can write", () => {
    expect(VERIFICATION_DIRECTORIES.find((plan) => plan.path === "/var/lib/oncue/secrets")).toEqual(
      {
        path: "/var/lib/oncue/secrets",
        owner: { uid: 0, gid: AGENT_UID },
        mode: 0o750,
      },
    );
  });
});

describe("nodeSupervisorIo: secret files", () => {
  it("creates the file itself, readable by owner and group and writable by nobody, and replaces it", () => {
    const dir = tempDir();
    const path = join(dir, "DATABASE_URL");
    const io = nodeSupervisorIo();

    io.writeSecretFile(path, "fake-database-url-0001", SELF);
    expect(readFileSync(path, "utf8")).toBe("fake-database-url-0001");
    expect(statSync(path).mode & 0o777).toBe(0o440);

    io.writeSecretFile(path, "fake-database-url-0002", SELF);
    expect(readFileSync(path, "utf8")).toBe("fake-database-url-0002");
  });

  it("never writes through a symlink planted where the secret goes", () => {
    const dir = tempDir();
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    const path = join(dir, "DATABASE_URL");
    symlinkSync(victim, path);

    nodeSupervisorIo().writeSecretFile(path, "fake-database-url-0001", SELF);

    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("fake-database-url-0001");
  });

  it("removes every file in the directory and leaves the directory", () => {
    const dir = tempDir();
    const io = nodeSupervisorIo();
    io.writeSecretFile(join(dir, "A_NAME"), "fake-value-0001", SELF);
    io.writeSecretFile(join(dir, "B_NAME"), "fake-value-0002", SELF);

    io.clearSecretFiles(dir);

    expect(readdirSync(dir)).toEqual([]);
    // A directory that is not there is nothing to clear, not an error.
    expect(() => io.clearSecretFiles(join(dir, "absent"))).not.toThrow();
  });
});
