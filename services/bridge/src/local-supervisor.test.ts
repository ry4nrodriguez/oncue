import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalSupervisor,
  ensureTmpDir,
  type LocalSupervisorOptions,
  reviewLocalRequest,
  type SpawnImpl,
} from "./local-supervisor";
import type { RunCheckRequest, StartAgentRequest } from "./supervisor-client";
import { AGENT_UID } from "./supervisor-protocol";

const OPTIONS: LocalSupervisorOptions = {
  binary: "/tmp/dev-opencode/opencode",
  workspaceDir: "/tmp/dev-workspace",
  checkOutputDir: "/tmp/dev-checks",
  baseTreeRoot: "/tmp/dev-base",
  secretsDir: "/tmp/dev-secrets",
  attachmentsRoot: "/tmp/dev-attachments",
};

/** Real directories and a real shell: the stand-in runs checks the way the dev host will. */
function checkHost(): {
  options: LocalSupervisorOptions;
  check: (overrides?: Partial<RunCheckRequest>) => RunCheckRequest;
} {
  const home = mkdtempSync(join(tmpdir(), "oncue-local-"));
  const options: LocalSupervisorOptions = {
    binary: "/nowhere/opencode",
    workspaceDir: home,
    checkOutputDir: join(home, "checks"),
    baseTreeRoot: join(home, "base"),
    secretsDir: join(home, "secrets"),
    attachmentsRoot: join(home, "attachments"),
  };
  return {
    options,
    check: (overrides = {}) => {
      const checkRunId = overrides.checkRunId ?? "chk_1";
      return {
        checkRunId,
        command: "echo local check",
        cwd: home,
        env: { PATH: "/usr/bin:/bin", CI: "1" },
        uid: AGENT_UID,
        timeoutMs: 10_000,
        outputPath: join(home, "checks", `${checkRunId}.log`),
        ...overrides,
      };
    },
  };
}

function request(overrides: Partial<StartAgentRequest> = {}): StartAgentRequest {
  return {
    argv: [OPTIONS.binary, "serve"],
    cwd: OPTIONS.workspaceDir,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/dev-home" },
    uid: 1001,
    ...overrides,
  };
}

/** A fake child process: no real process, just the three events the adapter listens for. */
class FakeChild extends EventEmitter {
  pid = 4242;
  killed: string[] = [];
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fakeSpawn(children: FakeChild[]): SpawnImpl {
  let index = 0;
  return () => {
    const child = children[index];
    index += 1;
    if (child === undefined) {
      throw new Error("fakeSpawn called more times than children were prepared");
    }
    return child as unknown as ReturnType<SpawnImpl>;
  };
}

describe("reviewLocalRequest", () => {
  it("allows a request matching the dev binary, cwd, and an allowlisted env", () => {
    expect(reviewLocalRequest(OPTIONS, request())).toEqual({ kind: "allowed" });
  });

  it("refuses a binary that is not the dev binary, never the sandbox's own /opt path", () => {
    expect(
      reviewLocalRequest(OPTIONS, request({ argv: ["/opt/opencode/opencode", "serve"] })),
    ).toEqual({
      kind: "refused",
      denial: "binary_not_allowed",
    });
  });

  it("reviews against the row the start's runtime names, and refuses a runtime with none", () => {
    expect(reviewLocalRequest(OPTIONS, request({ runtime: "opencode" }))).toEqual({
      kind: "allowed",
    });
    expect(reviewLocalRequest(OPTIONS, request({ runtime: "cursor" }))).toEqual({
      kind: "refused",
      denial: "runtime_not_allowed",
    });
    // A runtime with a row but no dev install is refused the same way.
    expect(
      reviewLocalRequest(
        { ...OPTIONS, runtimeBinaries: {} },
        request({ runtime: "not-installed" }),
      ),
    ).toEqual({ kind: "refused", denial: "runtime_not_allowed" });
  });

  it("refuses a cwd that is not the dev workspace", () => {
    expect(reviewLocalRequest(OPTIONS, request({ cwd: "/workspace" }))).toEqual({
      kind: "refused",
      denial: "cwd_not_allowed",
    });
  });

  it("refuses an env key outside ALLOWED_ENV_KEYS, the same table the sandbox uses", () => {
    expect(reviewLocalRequest(OPTIONS, request({ env: { ANTHROPIC_API_KEY: "sk-x" } }))).toEqual({
      kind: "refused",
      denial: "env_key_not_allowed",
    });
  });

  it("refuses an env value over the byte limit", () => {
    expect(
      reviewLocalRequest(OPTIONS, request({ env: { PATH: "x".repeat(64 * 1024 + 1) } })),
    ).toEqual({ kind: "refused", denial: "env_value_too_long" });
  });

  it("does not check uid: the dev host has no second Unix user to switch to", () => {
    expect(reviewLocalRequest(OPTIONS, request({ uid: 0 }))).toEqual({ kind: "allowed" });
  });
});

describe("createLocalSupervisor", () => {
  it("chownWorkspace is a recorded no-op", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    const outcome = await supervisor.chownWorkspace(1001);
    expect(outcome).toEqual({ kind: "ok", value: undefined });
    expect(supervisor.chownCalls).toEqual([1001]);
  });

  it("startAgent spawns argv as the current user (no uid option passed to spawn) and resolves the pid on the spawn event", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const pending = supervisor.startAgent(request());
    child.emit("spawn");
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "ok", value: { pid: 4242 } });
    expect(supervisor.startCalls).toEqual([request()]);
  });

  it("refuses a request reviewLocalRequest denies, without spawning anything", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    const outcome = await supervisor.startAgent(request({ cwd: "/somewhere/else" }));
    expect(outcome).toEqual({ kind: "refused", denial: "cwd_not_allowed" });
  });

  it("refuses a second start_agent while one is running", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const first = supervisor.startAgent(request());
    child.emit("spawn");
    await first;
    const second = await supervisor.startAgent(request());
    expect(second).toEqual({ kind: "refused", denial: "already_running" });
  });

  it("reports a spawn error (e.g. ENOENT because the binary is missing) as failed, not started", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const pending = supervisor.startAgent(request());
    child.emit("error", new Error("spawn ENOENT"));
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "failed", detail: "spawn ENOENT" });
  });

  it("signal uses process.kill through the child and refuses a signal outside the allowlist", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const pending = supervisor.startAgent(request());
    child.emit("spawn");
    await pending;

    expect(await supervisor.signal("SIGTERM")).toEqual({ kind: "ok", value: undefined });
    expect(child.killed).toEqual(["SIGTERM"]);
    // @ts-expect-error -- exercising the runtime refusal for a disallowed signal
    expect(await supervisor.signal("SIGKILL9")).toEqual({
      kind: "refused",
      denial: "signal_not_allowed",
    });
  });

  it("signal refuses no_such_agent when nothing has been started", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    expect(await supervisor.signal("SIGTERM")).toEqual({
      kind: "refused",
      denial: "no_such_agent",
    });
  });

  it("wait resolves once the child exits", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const started = supervisor.startAgent(request());
    child.emit("spawn");
    await started;

    const waiting = supervisor.wait();
    child.emit("exit", 0, null);
    expect(await waiting).toEqual({ kind: "ok", value: { code: 0, signal: null } });
  });

  it("wait refuses no_such_agent before anything has ever started", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    expect(await supervisor.wait()).toEqual({ kind: "refused", denial: "no_such_agent" });
  });

  it("close SIGKILLs a still-running child", async () => {
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));
    const started = supervisor.startAgent(request());
    child.emit("spawn");
    await started;

    supervisor.close();
    expect(child.killed).toEqual(["SIGKILL"]);
  });

  it("runCheck runs the command through the shell and writes its log where the review says", async () => {
    const { options, check } = checkHost();
    const supervisor = createLocalSupervisor(options, spawn);

    const outcome = await supervisor.runCheck(check({ command: "echo local check; exit 2" }));

    expect(outcome).toMatchObject({ kind: "ok", value: { exitCode: 2, timedOut: false } });
    expect(readFileSync(check().outputPath, "utf8")).toBe("local check\n");
  });

  it("runCheck applies the sandbox's review with the dev host's paths", async () => {
    const { options, check } = checkHost();
    const supervisor = createLocalSupervisor(options, spawn);

    await expect(supervisor.runCheck(check({ cwd: "/workspace" }))).resolves.toEqual({
      kind: "refused",
      denial: "cwd_not_allowed",
    });
    await expect(
      supervisor.runCheck(check({ outputPath: join(options.workspaceDir, "chk_1.log") })),
    ).resolves.toEqual({ kind: "refused", denial: "output_path_not_allowed" });
    await expect(supervisor.runCheck(check({ env: { GITHUB_TOKEN: "t" } }))).resolves.toEqual({
      kind: "refused",
      denial: "env_key_not_allowed",
    });
  });

  it("runs one check at a time, signals it by id, and reports a check that cannot start", async () => {
    const { options, check } = checkHost();
    const supervisor = createLocalSupervisor(options, spawn);

    const first = supervisor.runCheck(check({ command: "sleep 30" }));
    await expect(supervisor.runCheck(check({ checkRunId: "chk_2" }))).resolves.toEqual({
      kind: "refused",
      denial: "already_running",
    });
    await expect(supervisor.signalCheck("chk_2", "SIGTERM")).resolves.toEqual({
      kind: "refused",
      denial: "no_such_check",
    });
    await expect(supervisor.signalCheck("a/b", "SIGTERM")).resolves.toEqual({
      kind: "refused",
      denial: "check_id_not_allowed",
    });
    // @ts-expect-error -- exercising the runtime refusal for a disallowed signal
    await expect(supervisor.signalCheck("chk_1", "SIGSTOP")).resolves.toEqual({
      kind: "refused",
      denial: "signal_not_allowed",
    });
    await expect(supervisor.signalCheck("chk_1", "SIGTERM")).resolves.toEqual({
      kind: "ok",
      value: undefined,
    });
    await expect(first).resolves.toMatchObject({ kind: "ok", value: { signal: "SIGTERM" } });
    await expect(supervisor.signalCheck("chk_1", "SIGTERM")).resolves.toEqual({
      kind: "refused",
      denial: "no_such_check",
    });

    const again = await supervisor.runCheck(check({ checkRunId: "chk_1" }));
    expect(again).toMatchObject({ kind: "failed" });
  });

  it("close kills a running check", async () => {
    const { options, check } = checkHost();
    const supervisor = createLocalSupervisor(options, spawn);
    const running = supervisor.runCheck(check({ command: "sleep 30" }));
    supervisor.close();
    await expect(running).resolves.toMatchObject({ kind: "ok", value: { signal: "SIGKILL" } });
    expect(() => supervisor.close()).not.toThrow();
  });

  it("prepareBase is a reviewed, recorded no-op", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    await expect(supervisor.prepareBase("/tmp/dev-base/run_1", AGENT_UID)).resolves.toEqual({
      kind: "ok",
      value: undefined,
    });
    await expect(supervisor.prepareBase("/tmp/dev-workspace", AGENT_UID)).resolves.toEqual({
      kind: "refused",
      denial: "base_dir_not_allowed",
    });
    expect(supervisor.prepareBaseCalls).toEqual(["/tmp/dev-base/run_1"]);
  });

  it("prepareAttachments is a reviewed, recorded no-op", async () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    await expect(
      supervisor.prepareAttachments("/tmp/dev-attachments/m1", AGENT_UID),
    ).resolves.toEqual({ kind: "ok", value: undefined });
    await expect(supervisor.prepareAttachments("/tmp/dev-base/m1", AGENT_UID)).resolves.toEqual({
      kind: "refused",
      denial: "attachment_dir_not_allowed",
    });
    expect(supervisor.prepareAttachmentsCalls).toEqual(["/tmp/dev-attachments/m1"]);
  });

  it("close on an idle supervisor does nothing", () => {
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));
    expect(() => supervisor.close()).not.toThrow();
  });
});

describe("the agent's TMPDIR", () => {
  it("does nothing when a request names no TMPDIR", () => {
    expect(() => ensureTmpDir({ PATH: "/usr/bin" })).not.toThrow();
  });

  it("creates the TMPDIR a start_agent names, owner-only, before spawning", async () => {
    const base = mkdtempSync(join(tmpdir(), "oncue-local-tmp-"));
    const tmp = join(base, "home", ".tmp");
    const child = new FakeChild();
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([child]));

    const pending = supervisor.startAgent(
      request({ env: { PATH: "/usr/bin:/bin", HOME: join(base, "home"), TMPDIR: tmp } }),
    );
    child.emit("spawn");

    await expect(pending).resolves.toEqual({ kind: "ok", value: { pid: 4242 } });
    expect(statSync(tmp).isDirectory()).toBe(true);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
  });

  it("reports a TMPDIR it cannot create as failed, and spawns nothing", async () => {
    const base = mkdtempSync(join(tmpdir(), "oncue-local-tmp-"));
    const blocker = join(base, "file");
    writeFileSync(blocker, "not a directory");
    const supervisor = createLocalSupervisor(OPTIONS, fakeSpawn([]));

    const outcome = await supervisor.startAgent(
      request({ env: { PATH: "/usr/bin:/bin", TMPDIR: join(blocker, ".tmp") } }),
    );

    expect(outcome.kind).toBe("failed");
    expect(supervisor.startCalls).toEqual([]);
  });

  it("creates a check's TMPDIR, and the check can write there", async () => {
    const { options, check } = checkHost();
    const tmp = join(options.workspaceDir, "agent-home", ".tmp");
    const supervisor = createLocalSupervisor(options, spawn);

    const outcome = await supervisor.runCheck(
      check({
        command: 'touch "$TMPDIR/probe" && echo "$TMPDIR"',
        env: { PATH: "/usr/bin:/bin", TMPDIR: tmp, CI: "1" },
      }),
    );

    expect(outcome).toMatchObject({ kind: "ok", value: { exitCode: 0, timedOut: false } });
    expect(readFileSync(check().outputPath, "utf8")).toBe(`${tmp}\n`);
    expect(existsSync(join(tmp, "probe"))).toBe(true);
  });

  it("reports a check whose TMPDIR cannot be created as failed", async () => {
    const { options, check } = checkHost();
    const blocker = join(options.workspaceDir, "file");
    writeFileSync(blocker, "not a directory");
    const supervisor = createLocalSupervisor(options, spawn);

    const outcome = await supervisor.runCheck(
      check({ env: { PATH: "/usr/bin:/bin", TMPDIR: join(blocker, ".tmp"), CI: "1" } }),
    );

    expect(outcome.kind).toBe("failed");
  });
});

describe("development secrets", () => {
  const FAKE_VALUE = "fake-database-url-0001";

  it("writes one file per name beside the workspace, never inside it, readable by its owner only", async () => {
    const { options } = checkHost();
    const local = createLocalSupervisor({
      ...options,
      workspaceDir: join(options.workspaceDir, "workspace"),
    });

    expect(await local.writeSecret("DATABASE_URL", FAKE_VALUE)).toEqual({
      kind: "ok",
      value: undefined,
    });

    const path = local.secretPath("DATABASE_URL");
    expect(path).toBe(join(options.secretsDir, "DATABASE_URL"));
    expect(path.startsWith(join(options.workspaceDir, "workspace"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(FAKE_VALUE);
    expect(statSync(path).mode & 0o777).toBe(0o400);

    expect((await local.writeSecret("DATABASE_URL", "fake-database-url-0002")).kind).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe("fake-database-url-0002");
  });

  it("applies the real supervisor's review, so what root would refuse is refused here too", async () => {
    const { options } = checkHost();
    const local = createLocalSupervisor(options);
    expect(await local.writeSecret("GITHUB_TOKEN", FAKE_VALUE)).toEqual({
      kind: "refused",
      denial: "secret_name_not_allowed",
    });
    expect(await local.writeSecret("../escape", FAKE_VALUE)).toEqual({
      kind: "refused",
      denial: "secret_name_not_allowed",
    });
    expect(await local.writeSecret("A_NAME", "short")).toEqual({
      kind: "refused",
      denial: "secret_value_not_allowed",
    });
    expect(existsSync(options.secretsDir)).toBe(false);
  });

  it("refuses a twenty-first name and reports a write the filesystem refuses, without the value", async () => {
    const { options } = checkHost();
    const local = createLocalSupervisor(options);
    for (let index = 0; index < 20; index += 1) {
      expect((await local.writeSecret(`NAME_${index}`, FAKE_VALUE)).kind).toBe("ok");
    }
    expect(await local.writeSecret("ONE_TOO_MANY", FAKE_VALUE)).toEqual({
      kind: "refused",
      denial: "too_many_secrets",
    });

    writeFileSync(join(options.workspaceDir, "not-a-directory"), "x");
    const blocked = createLocalSupervisor({
      ...options,
      secretsDir: join(options.workspaceDir, "not-a-directory", "secrets"),
    });
    const outcome = await blocked.writeSecret("DATABASE_URL", FAKE_VALUE);
    expect(outcome.kind).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain(FAKE_VALUE);
  });

  it("gives a later check the value in its environment, and none after the secrets are cleared", async () => {
    const { options, check } = checkHost();
    const local = createLocalSupervisor(options);
    await local.writeSecret("DATABASE_URL", FAKE_VALUE);

    const first = check({
      checkRunId: "chk_env",
      command: 'test "$DATABASE_URL" = "fake-database-url-0001"',
    });
    expect(await local.runCheck(first)).toMatchObject({ kind: "ok", value: { exitCode: 0 } });

    expect(await local.clearSecrets()).toEqual({ kind: "ok", value: undefined });
    expect(existsSync(options.secretsDir)).toBe(false);
    const second = check({ checkRunId: "chk_cleared", command: 'test -z "$DATABASE_URL"' });
    expect(await local.runCheck(second)).toMatchObject({ kind: "ok", value: { exitCode: 0 } });
  });
});
