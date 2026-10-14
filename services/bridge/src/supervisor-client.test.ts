import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CheckSpawnPlan,
  createSupervisor,
  nodeSupervisorIo,
  type Owner,
  type ProcessExit,
  type SpawnPlan,
  type SupervisorIo,
} from "./supervisor";
import {
  connectSupervisor,
  createSupervisorClient,
  outcomeOf,
  type SupervisorChannel,
} from "./supervisor-client";
import {
  AGENT_UID,
  ALLOWED_BINARY,
  ALLOWED_CWD,
  ATTACHMENTS_ROOT,
  BASE_TREE_ROOT,
  CHECK_OUTPUT_DIR,
  type CheckExit,
  encodeResponse,
  parseRequest,
  type SupervisorRequest,
  type SupervisorResponse,
} from "./supervisor-protocol";

/** The test is the supervisor: it reads what the client wrote and answers when it likes. */
class FakeChannel implements SupervisorChannel {
  readonly written: string[] = [];
  closed = false;
  private lineListener: ((line: string) => void) | null = null;
  private closeListener: (() => void) | null = null;

  write(line: string): void {
    this.written.push(line);
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  requests(): SupervisorRequest[] {
    return this.written.map((line) => {
      const request = parseRequest(line.trim());
      if (request === null) {
        throw new Error(`the client wrote a line the supervisor cannot parse: ${line}`);
      }
      return request;
    });
  }

  answer(response: SupervisorResponse): void {
    this.lineListener?.(encodeResponse(response).trim());
  }

  raw(line: string): void {
    this.lineListener?.(line);
  }

  drop(): void {
    this.closeListener?.();
  }
}

function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `req_${n}`;
  };
}

const START = {
  argv: [ALLOWED_BINARY, "serve"],
  cwd: ALLOWED_CWD,
  env: { PATH: "/usr/bin" },
  uid: AGENT_UID,
};

const CHECK = {
  checkRunId: "chk_1",
  command: "npm test",
  cwd: ALLOWED_CWD,
  env: { PATH: "/usr/bin" },
  uid: AGENT_UID,
  timeoutMs: 1000,
  outputPath: `${CHECK_OUTPUT_DIR}/chk_1.log`,
};

const CHECK_EXIT: CheckExit = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 30,
  outputBytes: 12,
  truncated: false,
};

describe("outcomeOf", () => {
  it.each<[string, SupervisorResponse, unknown]>([
    [
      "an accepted result",
      { requestId: "r", ok: true, result: { op: "signal" } },
      { kind: "ok", value: { op: "signal" } },
    ],
    [
      "a policy refusal",
      {
        requestId: "r",
        ok: false,
        refusal: { reason: "not_permitted", detail: "cwd_not_allowed" },
      },
      { kind: "refused", denial: "cwd_not_allowed" },
    ],
    [
      "no such agent",
      { requestId: "r", ok: false, refusal: { reason: "no_such_agent" } },
      { kind: "refused", denial: "no_such_agent" },
    ],
    [
      "already running",
      { requestId: "r", ok: false, refusal: { reason: "already_running" } },
      { kind: "refused", denial: "already_running" },
    ],
    [
      "no such check",
      { requestId: "r", ok: false, refusal: { reason: "no_such_check" } },
      { kind: "refused", denial: "no_such_check" },
    ],
    [
      "an operating-system failure",
      { requestId: "r", ok: false, refusal: { reason: "failed", detail: "EPERM" } },
      { kind: "failed", detail: "EPERM" },
    ],
    [
      "a request the supervisor could not read",
      { requestId: "r", ok: false, refusal: { reason: "malformed" } },
      { kind: "failed", detail: "supervisor could not parse the request" },
    ],
  ])("translates %s", (_name, response, outcome) => {
    expect(outcomeOf(response)).toEqual(outcome);
  });
});

describe("createSupervisorClient", () => {
  it("sends each verb as the protocol's request and returns the typed value", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());

    const chown = client.chownWorkspace(AGENT_UID);
    const start = client.startAgent(START);
    const signal = client.signal("SIGTERM");
    const wait = client.wait();

    expect(channel.requests()).toEqual([
      { op: "chown_workspace", requestId: "req_1", uid: AGENT_UID },
      { op: "start_agent", requestId: "req_2", ...START },
      { op: "signal", requestId: "req_3", signal: "SIGTERM" },
      { op: "wait", requestId: "req_4" },
    ]);

    channel.answer({ requestId: "req_1", ok: true, result: { op: "chown_workspace" } });
    channel.answer({ requestId: "req_2", ok: true, result: { op: "start_agent", pid: 55 } });
    channel.answer({ requestId: "req_3", ok: true, result: { op: "signal" } });
    channel.answer({ requestId: "req_4", ok: true, result: { op: "wait", code: 0, signal: null } });

    await expect(chown).resolves.toEqual({ kind: "ok", value: undefined });
    await expect(start).resolves.toEqual({ kind: "ok", value: { pid: 55 } });
    await expect(signal).resolves.toEqual({ kind: "ok", value: undefined });
    await expect(wait).resolves.toEqual({ kind: "ok", value: { code: 0, signal: null } });
  });

  it("sends the check verbs and returns the check's exit without its op", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());

    const run = client.runCheck(CHECK);
    const signal = client.signalCheck("chk_1", "SIGTERM");
    const base = client.prepareBase(`${BASE_TREE_ROOT}/run_1`, AGENT_UID);

    expect(channel.requests()).toEqual([
      { op: "run_check", requestId: "req_1", ...CHECK },
      { op: "signal_check", requestId: "req_2", checkRunId: "chk_1", signal: "SIGTERM" },
      { op: "prepare_base", requestId: "req_3", dir: `${BASE_TREE_ROOT}/run_1`, uid: AGENT_UID },
    ]);

    channel.answer({ requestId: "req_2", ok: true, result: { op: "signal_check" } });
    channel.answer({ requestId: "req_3", ok: true, result: { op: "prepare_base" } });
    channel.answer({ requestId: "req_1", ok: true, result: { op: "run_check", ...CHECK_EXIT } });

    await expect(run).resolves.toEqual({ kind: "ok", value: CHECK_EXIT });
    await expect(signal).resolves.toEqual({ kind: "ok", value: undefined });
    await expect(base).resolves.toEqual({ kind: "ok", value: undefined });
  });

  it("sends prepare_attachments and hears its answer", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const handed = client.prepareAttachments(`${ATTACHMENTS_ROOT}/m1`, AGENT_UID);
    expect(channel.requests()).toEqual([
      {
        op: "prepare_attachments",
        requestId: "req_1",
        dir: `${ATTACHMENTS_ROOT}/m1`,
        uid: AGENT_UID,
      },
    ]);
    channel.answer({ requestId: "req_1", ok: true, result: { op: "prepare_attachments" } });
    await expect(handed).resolves.toEqual({ kind: "ok", value: undefined });
  });

  it("sends a secret by name and value, names its path, and hears a refusal without the value", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const FAKE_VALUE = "fake-database-url-0001";

    const written = client.writeSecret("DATABASE_URL", FAKE_VALUE);
    const refused = client.writeSecret("GITHUB_TOKEN", FAKE_VALUE);
    const cleared = client.clearSecrets();

    expect(channel.requests()).toEqual([
      { op: "write_secret", requestId: "req_1", name: "DATABASE_URL", value: FAKE_VALUE },
      { op: "write_secret", requestId: "req_2", name: "GITHUB_TOKEN", value: FAKE_VALUE },
      { op: "clear_secrets", requestId: "req_3" },
    ]);
    channel.answer({ requestId: "req_1", ok: true, result: { op: "write_secret" } });
    channel.answer({
      requestId: "req_2",
      ok: false,
      refusal: { reason: "not_permitted", detail: "secret_name_not_allowed" },
    });
    channel.answer({ requestId: "req_3", ok: true, result: { op: "clear_secrets" } });

    await expect(written).resolves.toEqual({ kind: "ok", value: undefined });
    const refusal = await refused;
    expect(refusal).toEqual({ kind: "refused", denial: "secret_name_not_allowed" });
    expect(JSON.stringify(refusal)).not.toContain(FAKE_VALUE);
    await expect(cleared).resolves.toEqual({ kind: "ok", value: undefined });
    expect(client.secretPath("DATABASE_URL")).toBe("/var/lib/oncue/secrets/DATABASE_URL");
  });

  it("treats a check verb answered with another op as a failure", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const run = client.runCheck(CHECK);
    const base = client.prepareBase(`${BASE_TREE_ROOT}/run_1`, AGENT_UID);

    channel.answer({ requestId: "req_1", ok: true, result: { op: "signal_check" } });
    channel.answer({
      requestId: "req_2",
      ok: false,
      refusal: { reason: "not_permitted", detail: "base_dir_not_allowed" },
    });

    await expect(run).resolves.toEqual({
      kind: "failed",
      detail: "supervisor answered with signal_check",
    });
    await expect(base).resolves.toEqual({ kind: "refused", denial: "base_dir_not_allowed" });
  });

  it("correlates by request id, so a signal can be answered while a wait is outstanding", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const wait = client.wait();
    const signal = client.signal("SIGKILL");

    channel.answer({ requestId: "req_2", ok: true, result: { op: "signal" } });
    await expect(signal).resolves.toEqual({ kind: "ok", value: undefined });

    channel.answer({
      requestId: "req_1",
      ok: true,
      result: { op: "wait", code: null, signal: "SIGKILL" },
    });
    await expect(wait).resolves.toEqual({ kind: "ok", value: { code: null, signal: "SIGKILL" } });
  });

  it("returns refusals and failures as outcomes", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const start = client.startAgent({ ...START, uid: 0 });
    const signal = client.signal("SIGTERM");

    channel.answer({
      requestId: "req_1",
      ok: false,
      refusal: { reason: "not_permitted", detail: "uid_not_allowed" },
    });
    channel.answer({
      requestId: "req_2",
      ok: false,
      refusal: { reason: "failed", detail: "ESRCH" },
    });

    await expect(start).resolves.toEqual({ kind: "refused", denial: "uid_not_allowed" });
    await expect(signal).resolves.toEqual({ kind: "failed", detail: "ESRCH" });
  });

  it("treats an answer of the wrong shape as a failure rather than a value", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const start = client.startAgent(START);
    const chown = client.chownWorkspace(AGENT_UID);

    channel.answer({ requestId: "req_1", ok: true, result: { op: "signal" } });
    channel.answer({ requestId: "req_2", ok: true, result: { op: "wait", code: 0, signal: null } });

    await expect(start).resolves.toEqual({
      kind: "failed",
      detail: "supervisor answered with signal",
    });
    await expect(chown).resolves.toEqual({
      kind: "failed",
      detail: "supervisor answered with wait",
    });
  });

  it("ignores lines it cannot parse and answers for requests it did not make", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const wait = client.wait();

    channel.raw("not json");
    channel.answer({ requestId: "someone_else", ok: true, result: { op: "signal" } });
    channel.answer({ requestId: "req_1", ok: true, result: { op: "wait", code: 1, signal: null } });

    await expect(wait).resolves.toEqual({ kind: "ok", value: { code: 1, signal: null } });
  });

  it("settles everything outstanding as unreachable when the socket closes, and stays that way", async () => {
    const channel = new FakeChannel();
    const client = createSupervisorClient(channel, ids());
    const wait = client.wait();
    const signal = client.signal("SIGTERM");

    channel.drop();
    await expect(wait).resolves.toEqual({ kind: "unreachable" });
    await expect(signal).resolves.toEqual({ kind: "unreachable" });

    await expect(client.chownWorkspace(AGENT_UID)).resolves.toEqual({ kind: "unreachable" });
    expect(channel.written).toHaveLength(2);
  });

  it("closes the channel it was given", () => {
    const channel = new FakeChannel();
    createSupervisorClient(channel, ids()).close();
    expect(channel.closed).toBe(true);
  });
});

describe("connectSupervisor", () => {
  it("never rejects: an opener that fails yields a client whose every call is unreachable", async () => {
    const client = await connectSupervisor("/nowhere/supervisor.sock", () =>
      Promise.reject(new Error("ENOENT")),
    );

    await expect(client.chownWorkspace(AGENT_UID)).resolves.toEqual({ kind: "unreachable" });
    await expect(client.startAgent(START)).resolves.toEqual({ kind: "unreachable" });
    await expect(client.signal("SIGKILL")).resolves.toEqual({ kind: "unreachable" });
    await expect(client.wait()).resolves.toEqual({ kind: "unreachable" });
    await expect(client.runCheck(CHECK)).resolves.toEqual({ kind: "unreachable" });
    await expect(client.signalCheck("chk_1", "SIGKILL")).resolves.toEqual({ kind: "unreachable" });
    await expect(client.prepareBase(`${BASE_TREE_ROOT}/r`, AGENT_UID)).resolves.toEqual({
      kind: "unreachable",
    });
    await expect(client.prepareAttachments(`${ATTACHMENTS_ROOT}/r`, AGENT_UID)).resolves.toEqual({
      kind: "unreachable",
    });
    await expect(client.writeSecret("A_NAME", "fake-value-0001")).resolves.toEqual({
      kind: "unreachable",
    });
    await expect(client.clearSecrets()).resolves.toEqual({ kind: "unreachable" });
    expect(client.secretPath("A_NAME")).toBe("/var/lib/oncue/secrets/A_NAME");
    expect(() => client.close()).not.toThrow();
  });

  it("answers unreachable for a real path with no socket behind it", async () => {
    const client = await connectSupervisor(
      join(mkdtempSync(join(tmpdir(), "oncue-sup-")), "none.sock"),
    );
    await expect(client.wait()).resolves.toEqual({ kind: "unreachable" });
  });
});

/** The process half faked; the socket half real. */
class FakeProcesses implements SupervisorIo {
  readonly spawns: SpawnPlan[] = [];
  readonly kills: { pid: number; signal: string }[] = [];
  readonly chowns: string[] = [];
  private resolveExit: ((exit: ProcessExit) => void) | null = null;
  private readonly exit = new Promise<ProcessExit>((resolve) => {
    this.resolveExit = resolve;
  });

  spawn(plan: SpawnPlan): number {
    this.spawns.push(plan);
    return 500;
  }
  chownRecursive(path: string): void {
    this.chowns.push(path);
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push({ pid, signal });
  }
  wait(): Promise<ProcessExit> {
    return this.exit;
  }
  exited(exit: ProcessExit): void {
    this.resolveExit?.(exit);
  }
  writeCredentialFile(): void {}
  writeSecretFile(): void {}
  clearSecretFiles(): void {}
  readonly checks: CheckSpawnPlan[] = [];
  spawnCheck(plan: CheckSpawnPlan): number {
    this.checks.push(plan);
    return 600;
  }
  waitCheck(): Promise<CheckExit> {
    return Promise.resolve(CHECK_EXIT);
  }
  killCheck(): void {}
  chownBaseTree(): void {}
  makeDirectory(): void {}
  listen = nodeSupervisorIo().listen;
  onShutdownSignal(): void {}
  log(): void {}
}

const SELF: Owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

describe("connectSupervisor against the real socket", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) {
      close();
    }
  });

  it("drives the supervisor through its four verbs", async () => {
    const processes = new FakeProcesses();
    const supervisor = createSupervisor(processes);
    // `os.tmpdir()` because a socket path has to fit in `sun_path`.
    const path = join(mkdtempSync(join(tmpdir(), "oncue-sup-")), "supervisor.sock");
    const listener = await processes.listen(path, SELF, supervisor.handleLine);
    closers.push(() => listener.close());

    const client = await connectSupervisor(path);
    closers.push(() => client.close());

    await expect(client.chownWorkspace(AGENT_UID)).resolves.toEqual({
      kind: "ok",
      value: undefined,
    });
    expect(processes.chowns).toEqual([ALLOWED_CWD]);

    await expect(client.startAgent(START)).resolves.toEqual({ kind: "ok", value: { pid: 500 } });
    await expect(client.startAgent(START)).resolves.toEqual({
      kind: "refused",
      denial: "already_running",
    });
    expect(processes.spawns).toEqual([START]);

    const wait = client.wait();
    await expect(client.signal("SIGTERM")).resolves.toEqual({ kind: "ok", value: undefined });
    expect(processes.kills).toEqual([{ pid: 500, signal: "SIGTERM" }]);

    processes.exited({ code: 0, signal: null });
    await expect(wait).resolves.toEqual({ kind: "ok", value: { code: 0, signal: null } });

    await expect(client.runCheck(CHECK)).resolves.toEqual({ kind: "ok", value: CHECK_EXIT });
    expect(processes.checks).toHaveLength(1);
    await expect(client.signalCheck("chk_1", "SIGTERM")).resolves.toEqual({
      kind: "refused",
      denial: "no_such_check",
    });
    await expect(client.runCheck({ ...CHECK, cwd: "/opt/oncue" })).resolves.toEqual({
      kind: "refused",
      denial: "cwd_not_allowed",
    });
  });

  it("reports the supervisor going away as unreachable", async () => {
    const processes = new FakeProcesses();
    const path = join(mkdtempSync(join(tmpdir(), "oncue-sup-")), "supervisor.sock");
    const listener = await processes.listen(path, SELF, () => {});

    const client = await connectSupervisor(path);
    const wait = client.wait();
    listener.close();

    await expect(wait).resolves.toEqual({ kind: "unreachable" });
  });
});
