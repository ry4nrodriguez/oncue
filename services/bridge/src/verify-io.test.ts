/**
 * Verification through the interpreter against a real Git repository and real
 * processes: a bare origin whose scripts pass, fail, and flake, cloned by the
 * bridge, checked by the dev host's supervisor stand-in (the same
 * `startCheckProcess` the root supervisor uses). Only OpenCode, the relay, and
 * R2 are fakes, and the test plays the object, granting every upload.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolEvent } from "@oncue/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInput } from "./agent";
import { LOG_GRANT_WAIT_MS } from "./agent";
import {
  checkEnvironment,
  composeLog,
  createAgentHost,
  EMPTY_LOG_TEXT,
  LOG_CUT_MARKER,
  MAX_LOG_BYTES,
  UNREADABLE_LOG_TEXT,
  workspaceFiles,
} from "./agent-io";
import { type ArtifactIo, sha256Hex, type UploadRequest } from "./checkpoint";
import {
  type AckFrame,
  buildCommandFrame,
  buildGrantFrame,
  type DeliverableCommand,
} from "./frames";
import { type GitIo, nodeRunGit } from "./git";
import { createLocalSupervisor, type LocalSupervisor } from "./local-supervisor";
import type { OpenCodeClient } from "./opencode";
import { type BridgeIo, bridgeConfig, type Outbound, type SequenceCursor } from "./protocol";
import type { SupervisorClient, SupervisorOutcome } from "./supervisor-client";
import { CANCEL_GRACE_MS } from "./verify";

const IDENTITY = { sessionId: "sess_1", generation: 3 };
const CONFIG = bridgeConfig({ ...IDENTITY, bootstrapCredential: "boot" }, "wss://oncue.example");
const BRANCH = "task-branch";

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface Scripts {
  readonly test?: string;
  readonly typecheck?: string;
  readonly lint?: string;
  /** Written to `.oncue/project.yaml` as-is, so a command runs with no package manager in between. */
  readonly projectYaml?: string;
}

/**
 * A bare origin with one commit on `task-branch`. Each script is a shell
 * script under `scripts/`, so a scenario changes what a check does by
 * editing a file, the way an agent would.
 */
function origin(root: string, scripts: Scripts) {
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "seed");
  git(["init", "--bare", "-q", bareDir], root);
  git(["init", "-q", workDir], root);
  git(["config", "user.email", "test@example.com"], workDir);
  git(["config", "user.name", "Test"], workDir);
  git(["checkout", "-q", "-b", BRANCH], workDir);
  mkdirSync(join(workDir, "scripts"));
  const packageScripts: Record<string, string> = {};
  const { projectYaml, ...commands } = scripts;
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(workDir, "scripts", `${name}.sh`), `${body}\n`);
    packageScripts[name] = `sh scripts/${name}.sh`;
  }
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "widgets", private: true, scripts: packageScripts }, null, 2),
  );
  if (projectYaml !== undefined) {
    mkdirSync(join(workDir, ".oncue"));
    writeFileSync(join(workDir, ".oncue", "project.yaml"), projectYaml);
  }
  git(["add", "."], workDir);
  git(["commit", "-q", "-m", "initial"], workDir);
  const baseSha = git(["rev-parse", "HEAD"], workDir).trim();
  git(["remote", "add", "origin", bareDir], workDir);
  git(["push", "-q", "origin", BRANCH], workDir);
  return { bareDir, baseSha };
}

const gitIo: GitIo = {
  runGit: nodeRunGit,
  revoke: async () => ({ ok: true, status: 204 }),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  askpassPath: "/bin/true",
};

/** OpenCode, faked: prompts are held, and the test delivers the idle signal. */
class FakeOpenCode implements OpenCodeClient {
  deliver: ((event: Parameters<Parameters<OpenCodeClient["subscribe"]>[1]>[0]) => void) | null =
    null;
  async health() {
    return { kind: "healthy" as const, version: "1.18.30" };
  }
  async prompt() {
    return { kind: "held" as const, conversation: "ses_1" };
  }
  async abort() {
    return true;
  }
  async replyHeld() {
    return true;
  }
  async replyQuestion() {
    return true;
  }
  subscribe(_port: number, onEvent: Parameters<OpenCodeClient["subscribe"]>[1]): Promise<void> {
    this.deliver = onEvent;
    onEvent({ kind: "server_connected" });
    return new Promise(() => {});
  }
}

/** The agent's own verbs answered as if OpenCode were up; every check verb is the real stand-in's. */
function supervisorFor(local: LocalSupervisor): SupervisorClient {
  const ok: SupervisorOutcome<void> = { kind: "ok", value: undefined };
  return {
    chownWorkspace: async () => ok,
    startAgent: async () => ({ kind: "ok", value: { pid: 42 } }),
    signal: async () => ok,
    wait: () => new Promise(() => {}),
    runCheck: (request) => local.runCheck(request),
    signalCheck: (checkRunId, signal) => local.signalCheck(checkRunId, signal),
    prepareBase: (dir, uid) => local.prepareBase(dir, uid),
    prepareAttachments: (dir, uid) => local.prepareAttachments(dir, uid),
    writeSecret: (name, value) => local.writeSecret(name, value),
    clearSecrets: () => local.clearSecrets(),
    secretPath: (name) => local.secretPath(name),
    close: () => local.close(),
  };
}

class Io implements BridgeIo {
  readonly logs: string[] = [];
  private issued = 0;
  /** Waits of these lengths pass at once, so a test can reach a deadline or an escalation. */
  constructor(private readonly released: readonly number[] = []) {}
  async connect(): Promise<never> {
    throw new Error("not used");
  }
  startHeartbeat() {
    return () => {};
  }
  /** Short waits pass; the long ones (an upload grant's deadline, a cancel's escalation) are held. */
  sleep(ms: number): Promise<void> {
    if (this.released.includes(ms)) {
      return Promise.resolve();
    }
    return ms >= 1_000 ? new Promise(() => {}) : new Promise((resolve) => setTimeout(resolve, ms));
  }
  log(line: string) {
    this.logs.push(line);
  }
  newEventId = (): string => {
    this.issued += 1;
    return `id_${this.issued}`;
  };
  now() {
    return "2026-09-16T00:00:00.000Z";
  }
}

class Recorder implements Outbound {
  readonly events: ProtocolEvent[] = [];
  readonly acks: AckFrame[] = [];
  sendEvent(event: ProtocolEvent) {
    this.events.push(event);
  }
  sendAck(frame: AckFrame) {
    this.acks.push(frame);
  }
}

class Artifacts implements ArtifactIo {
  readonly uploads: UploadRequest[] = [];
  async upload(request: UploadRequest) {
    this.uploads.push(request);
    return { ok: true, status: 201 };
  }
  async download() {
    return { kind: "failed" as const, status: 404 };
  }
}

function command(
  type: DeliverableCommand["type"],
  payload: Record<string, unknown>,
  commandId: string,
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
          runId: type === "run.start" ? null : "run_1",
          issuedAt: "2026-09-16T00:00:00.000Z",
          issuedByUserId: "usr_1",
          expected: { scope: "session", state: "active" },
          type,
          payload,
        } as unknown as DeliverableCommand,
        "run_1",
      ),
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("verification through the interpreter, against real git and real checks", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function world(
    scripts: Scripts,
    options: { readonly released?: readonly number[]; readonly grantUploads?: boolean } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "oncue-verify-"));
    roots.push(root);
    const { bareDir, baseSha } = origin(root, scripts);
    const workspaceDir = join(root, "home", "workspace");
    mkdirSync(join(root, "home"));
    const checkOutputDir = join(root, "home", "checks");
    const baseTreeRoot = join(root, "home", "base");
    const local = createLocalSupervisor({
      binary: "/nowhere/opencode",
      workspaceDir,
      checkOutputDir,
      baseTreeRoot,
      secretsDir: join(root, "home", "secrets"),
      attachmentsRoot: join(root, "home", "attachments"),
    });
    const opencode = new FakeOpenCode();
    const artifacts = new Artifacts();
    const outbound = new Recorder();
    const io = new Io(options.released);
    const cursor: SequenceCursor = { next: 0 };
    const host = createAgentHost(
      CONFIG,
      io,
      cursor,
      {
        supervisor: supervisorFor(local),
        runtime: opencode,
        git: gitIo,
        files: workspaceFiles(workspaceDir),
        relay: { port: 5001, setToken: () => {} },
        tools: { port: 5002 },
        commits: { answer: () => undefined },
        artifacts,
      },
      {
        workspaceDir,
        runtimeHome: join(root, "home"),
        checkpointDir: join(root, "home", "checkpoint"),
        checkOutputDir,
        baseTreeRoot,
        checkPath: process.env.PATH ?? "/usr/bin:/bin",
      },
    );
    host.handler.onLinkUp(outbound);

    async function until(condition: () => boolean, what: string, limit = 3_000): Promise<void> {
      for (let attempt = 0; attempt < limit && !condition(); attempt += 1) {
        grantDeclaredUploads();
        await tick();
      }
      expect(condition(), what).toBe(true);
    }

    const granted = new Set<string>();
    function grantDeclaredUploads(): void {
      if (options.grantUploads === false) {
        return;
      }
      for (const event of outbound.events) {
        if (event.type !== "artifact.uploading") {
          continue;
        }
        const { artifactId, declaredBytes } = event.payload as {
          artifactId: string;
          declaredBytes: number;
        };
        if (granted.has(artifactId)) {
          continue;
        }
        granted.add(artifactId);
        host.offer({
          kind: "frame",
          frame: {
            kind: "grant",
            frame: buildGrantFrame(IDENTITY, {
              kind: "upload",
              grantId: `grant_${artifactId}`,
              expiresAt: "2026-09-16T00:10:00.000Z",
              token: "up_token",
              artifactId,
              url: `https://oncue.example/artifacts/${artifactId}`,
              maxBytes: Math.max(declaredBytes, 25 * 1024 * 1024),
            }),
          },
        });
      }
    }

    host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "git",
          grantId: "grant_git",
          expiresAt: "2026-09-16T01:00:00.000Z",
          token: "ghs_clone",
          repository: { fullName: "acme/widgets", cloneUrl: bareDir },
          branch: BRANCH,
          taskBranch: BRANCH,
          baseSha,
          headSha: baseSha,
          restore: null,
        }),
      },
    });
    await until(() => host.snapshot().workspace.kind !== "cloning", "the clone settles");
    expect(host.snapshot().workspace.kind).toBe("ready");
    host.offer({
      kind: "frame",
      frame: {
        kind: "grant",
        frame: buildGrantFrame(IDENTITY, {
          kind: "model",
          grantId: "grant_model",
          expiresAt: "2026-09-16T00:10:00.000Z",
          token: "ot1.model",
          brokerOrigin: "https://oncue.example",
          model: { provider: "anthropic", modelId: "claude-sonnet-5" },
          runtime: "opencode",
          effort: null,
          modelSpec: null,
          workspace: "repository",
        }),
      },
    });
    await until(() => host.snapshot().runtime.kind === "ready", "OpenCode is ready");

    // A run that changed no files ends Done without checks (record 14), so a
    // scenario about verification makes the change an agent's run would.
    async function runToIdle(
      options: { skipRequiredChecks?: boolean } = {},
      work: () => Promise<void> | void = () => {
        writeFileSync(join(workspaceDir, "agent-change.txt"), "the agent's change\n");
      },
    ) {
      host.offer(
        command(
          "run.start",
          {
            instruction: { messageId: "msg_1", text: "Change the widgets.", attachments: [] },
            model: {
              provider: "anthropic",
              modelId: "claude-sonnet-5",
              modelConnectionId: "conn_1",
              authenticationType: "api_key",
              contextWindow: null,
              effort: null,
            },
            continuesRunId: null,
            ...options,
          },
          "cmd_start",
        ),
      );
      await until(() => host.snapshot().run.kind === "active", "the run starts");
      await until(
        () =>
          host.snapshot().run.kind === "active" &&
          (host.snapshot().run as { phase: string }).phase === "running",
        "OpenCode holds the prompt",
      );
      await work();
      opencode.deliver?.({ kind: "session_idle" });
    }

    const payloads = (type: ProtocolEvent["type"]) =>
      outbound.events
        .filter((event) => event.type === type)
        .map((event) => event.payload as Record<string, unknown>);
    const terminal = () =>
      outbound.events.find((event) =>
        ["run.verified", "run.failed", "run.completed_with_warnings"].includes(event.type),
      );

    /** The uploads that are check logs: every upload but the diff's tree listing. */
    const logUploads = () => {
      const trees = new Set(
        outbound.events
          .filter((event) => event.type === "artifact.uploading")
          .map((event) => event.payload as { artifactId: string; kind: string })
          .filter((payload) => payload.kind === "file")
          .map((payload) => payload.artifactId),
      );
      return artifacts.uploads.filter(
        (upload) => ![...trees].some((id) => upload.url.endsWith(`/${id}`)),
      );
    };

    return {
      root,
      baseSha,
      opencode,
      workspaceDir,
      baseTreeRoot,
      checkOutputDir,
      host,
      outbound,
      artifacts,
      logUploads,
      local,
      io,
      until,
      runToIdle,
      payloads,
      terminal,
    };
  }

  it("runs passing and failing scripts as checks, uploads each log, and ends verified when every required one passed", async () => {
    const w = await world({
      test: 'echo "3 passing"',
      typecheck: 'echo "no type errors"',
      lint: 'echo "lint: 2 problems" 1>&2; exit 1',
    });
    await w.runToIdle();
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(w.terminal()?.type).toBe("run.verified");
    expect(w.outbound.events.map((event) => event.type)).toEqual([
      "runtime.ready",
      "run.started",
      "repository.status",
      "repository.status",
      "artifact.uploading",
      // The turn's diff, then the session's: the run changed a file.
      "diff.updated",
      "diff.updated",
      ...["test", "typecheck", "lint"].flatMap(() => [
        "verification.started",
        "artifact.uploading",
        "verification.result",
      ]),
      "verification.completed",
      "run.verified",
    ]);
    const results = w.payloads("verification.result");
    expect(results.map((result) => [result.result, result.exitCode])).toEqual([
      ["passed", 0],
      ["passed", 0],
      ["failed", 1],
    ]);
    expect(results[0]?.summary).toContain("3 passing");
    expect(results[2]?.summary).toContain("lint: 2 problems");

    // Each result names the uploaded log's bytes and checksum. The diff's tree
    // listing shares the logs' content type and is told apart by its artifact id.
    const logUploads = w.logUploads();
    expect(w.artifacts.uploads).toHaveLength(4);
    expect(logUploads).toHaveLength(3);
    const evidence = results[0]?.evidence as { artifactId: string; byteSize: number }[];
    const firstEvidence = evidence[0];
    const firstUpload = logUploads[0];
    const bytes = Buffer.from(firstUpload?.bytes ?? []);
    expect(firstUpload?.url).toContain(firstEvidence?.artifactId);
    expect(bytes.byteLength).toBe(firstEvidence?.byteSize);
    expect(firstUpload?.sha256).toBe(sha256Hex(bytes));
    expect(firstUpload?.contentType).toBe("text/plain; charset=utf-8");
    expect(bytes.toString("utf8")).toContain("3 passing");
    expect(readdirSync(w.checkOutputDir)).toHaveLength(3);
    expect(w.payloads("run.verified")[0]).toMatchObject({
      summary: { verificationPerformed: "test passed; typecheck passed; lint failed" },
    });
    expect(w.host.snapshot().run).toEqual({ kind: "idle" });
  });

  it("a required check the change broke, which passes on the base checkout, ends failed at verification", async () => {
    const w = await world({
      test: "echo ok",
      typecheck: 'if [ -f broken ]; then echo "error TS2322" ; exit 2; fi; echo clean',
    });
    await w.runToIdle({}, () => {
      writeFileSync(join(w.workspaceDir, "broken"), "the agent's change\n");
    });
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(w.terminal()?.type).toBe("run.failed");
    expect(w.payloads("run.failed")[0]).toMatchObject({
      stage: "verification",
      error: {
        message: "Required check typecheck fails on this change and passes on the base revision",
      },
    });
    expect(w.payloads("verification.result")[1]).toMatchObject({
      result: "failed",
      exitCode: 2,
      baseComparison: "new_failure",
    });
    // The base checkout holds the base revision's tree, not the agent's change, and was handed over.
    const [baseDir] = readdirSync(w.baseTreeRoot);
    expect(existsSync(join(w.baseTreeRoot, baseDir as string, "package.json"))).toBe(true);
    expect(existsSync(join(w.baseTreeRoot, baseDir as string, "broken"))).toBe(false);
    expect(w.local.prepareBaseCalls).toEqual([join(w.baseTreeRoot, baseDir as string)]);
    // The work tree's own Git state was not touched by the base checkout.
    expect(git(["status", "--porcelain"], w.workspaceDir)).toBe("?? broken\n");
  });

  it("a required check that fails on the base checkout too ends with warnings: reproduced on base", async () => {
    const w = await world({ test: 'echo "1 failing"; exit 1', typecheck: "echo clean" });
    await w.runToIdle();
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(w.terminal()?.type).toBe("run.completed_with_warnings");
    const results = w.payloads("verification.result");
    expect(results.map((result) => [result.attempt, result.result, result.baseComparison])).toEqual(
      [
        [1, "failed", "not_compared"],
        [2, "failed", "reproduced_on_base"],
        [1, "passed", "not_compared"],
      ],
    );
    expect(w.payloads("verification.completed")[0]).toMatchObject({
      proposedOutcome: "completed_with_warnings",
      baselineComparisonAvailable: true,
    });
  });

  it("a test that fails and then passes is inconclusive (flaky), with both attempts and both logs kept", async () => {
    const w = await world({
      test: 'if [ -f "$HOME/flaked" ]; then echo "passed on retry"; exit 0; fi; touch "$HOME/flaked"; echo "timing out"; exit 1',
    });
    await w.runToIdle();
    await w.until(() => w.terminal() !== undefined, "the run ends");

    const results = w.payloads("verification.result");
    expect(
      results.map((result) => [result.attempt, result.result, result.inconclusiveReason]),
    ).toEqual([
      [1, "failed", null],
      [2, "inconclusive", "flaky"],
    ]);
    expect(results[0]?.summary).toContain("timing out");
    expect(results[1]?.summary).toContain("passed on retry");
    // Both attempts' logs, beside the tree listing every diff carries.
    expect(w.logUploads()).toHaveLength(2);
    expect(w.terminal()?.type).toBe("run.completed_with_warnings");
  });

  it("measures the run with the bridge's own Git before verifying, and verifies the snapshot it measured", async () => {
    const w = await world({ test: 'grep -q widget notes.txt && echo "found"' });
    await w.runToIdle({}, async () => {
      writeFileSync(join(w.workspaceDir, "notes.txt"), "a widget\n");
      w.opencode.deliver?.({ kind: "session_diff", files: [] });
      await w.until(() => w.payloads("diff.updated").length === 1, "the mid-run rebuild");
    });
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(w.outbound.events.map((event) => event.type)).toEqual([
      "runtime.ready",
      "run.started",
      "repository.status",
      "artifact.uploading",
      "diff.updated",
      "repository.status",
      "diff.updated",
      "diff.updated",
      "verification.started",
      "artifact.uploading",
      "verification.result",
      "verification.completed",
      "run.verified",
    ]);
    const [atStart, atEnd] = w.payloads("repository.status");
    expect(atStart).toMatchObject({
      baseSha: w.baseSha,
      ahead: 0,
      changedFileCount: 0,
      dirty: false,
    });
    expect(atEnd).toMatchObject({
      baseSha: w.baseSha,
      ahead: 1,
      dirty: true,
      changedFileCount: 1,
      untrackedFileCount: 1,
      additions: 1,
      deletions: 0,
    });
    const [midRun, turn, session] = w.payloads("diff.updated");
    expect(midRun).toMatchObject({
      scope: "session",
      files: [{ path: "notes.txt", status: "added" }],
    });
    expect(session).toMatchObject({
      scope: "session",
      baseSha: w.baseSha,
      headSha: atEnd?.headSha,
      files: [{ path: "notes.txt", status: "added", additions: 1, deletions: 0 }],
    });
    expect(turn).toMatchObject({
      scope: "turn",
      baseSha: atStart?.headSha,
      headSha: atEnd?.headSha,
      files: [{ path: "notes.txt", status: "added", additions: 1, deletions: 0 }],
      body: { kind: "inline" },
      truncated: false,
    });
    expect(turn?.body).toMatchObject({ patch: expect.stringContaining("+a widget") });
    expect(w.payloads("verification.started")[0]?.revision).toBe(atEnd?.headSha);
    expect(git(["status", "--porcelain"], w.workspaceDir)).toBe("?? notes.txt\n");
  });

  it("a cancel mid-check stops the check's process group and keeps the record already sent", async () => {
    const w = await world({ test: "echo started; sleep 30 & wait" });
    await w.runToIdle();
    await w.until(
      () => existsSync(w.checkOutputDir) && readdirSync(w.checkOutputDir).length === 1,
      "the check is running",
    );
    const started = Date.now();
    w.host.offer(command("run.cancel", { reason: "stop", checkpointFirst: false }, "cmd_cancel"));
    await w.until(() => w.host.snapshot().run.kind === "idle", "the cancelled run settles");

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(w.outbound.events.map((event) => event.type)).toEqual([
      "runtime.ready",
      "run.started",
      "repository.status",
      "repository.status",
      "artifact.uploading",
      // The turn's diff, then the session's: the run changed a file.
      "diff.updated",
      "diff.updated",
      "verification.started",
    ]);
    expect(w.terminal()).toBeUndefined();
  });

  it("the user's skip records required checks as skipped without running them", async () => {
    const w = await world({ test: "exit 1", lint: "echo fine" });
    await w.runToIdle({ skipRequiredChecks: true });
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(
      w.payloads("verification.result").map((result) => [result.result, result.skipReason]),
    ).toEqual([
      ["skipped", "user_requested"],
      ["passed", null],
    ]);
    expect(readdirSync(w.checkOutputDir)).toHaveLength(1);
    expect(w.terminal()?.type).toBe("run.completed_with_warnings");
  });

  it("a log whose upload grant never comes is dropped at the deadline and its result carries no evidence", async () => {
    const w = await world(
      { test: "echo ok" },
      { released: [LOG_GRANT_WAIT_MS], grantUploads: false },
    );
    await w.runToIdle();
    await w.until(() => w.terminal() !== undefined, "the run ends");

    expect(w.payloads("artifact.uploading").filter((a) => a.kind === "log")).toHaveLength(1);
    expect(w.payloads("verification.result")[0]).toMatchObject({ result: "passed", evidence: [] });
    expect(w.artifacts.uploads).toEqual([]);
    expect(w.io.logs.some((line) => line.includes("no upload grant for artifact"))).toBe(true);
    expect(w.host.snapshot().uploads).toEqual([]);
  });

  it("a check that ignores SIGTERM on a cancel is killed after the grace period", async () => {
    const w = await world(
      { projectYaml: "commands:\n  test: \"trap '' TERM; echo stubborn; sleep 30\"\n" },
      { released: [CANCEL_GRACE_MS] },
    );
    await w.runToIdle();
    await w.until(
      () => existsSync(w.checkOutputDir) && readdirSync(w.checkOutputDir).length === 1,
      "the check is running",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    w.host.offer(command("run.cancel", { reason: "stop", checkpointFirst: false }, "cmd_cancel"));
    await w.until(() => w.host.snapshot().run.kind === "idle", "the cancelled run settles");
    expect(w.terminal()).toBeUndefined();
  });

  it("a supervisor that cannot run the check records it as could_not_run with no log", async () => {
    const w = await world({ test: "echo ok" });
    const original = w.local.runCheck;
    (w.local as { runCheck: LocalSupervisor["runCheck"] }).runCheck = async () => ({
      kind: "unreachable",
    });
    await w.runToIdle();
    await w.until(() => w.terminal() !== undefined, "the run ends");
    (w.local as { runCheck: LocalSupervisor["runCheck"] }).runCheck = original;

    expect(w.payloads("verification.result")[0]).toMatchObject({
      result: "skipped",
      skipReason: "could_not_run",
      summary: "Could not run: supervisor unreachable",
      evidence: [],
    });
    expect(w.artifacts.uploads).toEqual([]);
  });
});

describe("composeLog and checkEnvironment", () => {
  it("never uploads an empty log, and says when the output could not be read", () => {
    expect(composeLog(Buffer.alloc(0), false).toString("utf8")).toBe(EMPTY_LOG_TEXT);
    expect(composeLog(null, false).toString("utf8")).toBe(UNREADABLE_LOG_TEXT);
    expect(composeLog(Buffer.from("ok\n"), false).toString("utf8")).toBe("ok\n");
  });

  it("cuts a log the supervisor truncated, or one past the limit, to exactly the limit with a marker", () => {
    const cut = composeLog(Buffer.alloc(MAX_LOG_BYTES, 0x61), true);
    expect(cut.byteLength).toBe(MAX_LOG_BYTES);
    expect(cut.subarray(cut.byteLength - Buffer.byteLength(LOG_CUT_MARKER)).toString("utf8")).toBe(
      LOG_CUT_MARKER,
    );
    expect(composeLog(Buffer.alloc(MAX_LOG_BYTES + 5, 0x61), false).byteLength).toBe(MAX_LOG_BYTES);
    expect(composeLog(Buffer.from("partial"), true).toString("utf8")).toBe(
      `partial${LOG_CUT_MARKER}`,
    );
  });

  it("gives a check the agent's home, CI, and nothing that could carry a credential", () => {
    const env = checkEnvironment("/home/oncue-agent", "/usr/bin");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/oncue-agent",
      LANG: "C.UTF-8",
      TMPDIR: "/home/oncue-agent/.tmp",
      XDG_DATA_HOME: "/home/oncue-agent/.local/share",
      XDG_CONFIG_HOME: "/home/oncue-agent/.config",
      XDG_STATE_HOME: "/home/oncue-agent/.local/state",
      XDG_CACHE_HOME: "/home/oncue-agent/.cache",
      CI: "1",
    });
  });
});
