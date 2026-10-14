/**
 * The developer-machine stand-in for the root supervisor. The dev host has no
 * root process and no second Unix user, so this implements `SupervisorClient`
 * in the bridge process: the agent and checks run as the current user, and the
 * hand-over verbs (`chownWorkspace`, `prepareBase`, `prepareAttachments`) are
 * recorded no-ops.
 *
 * It is not the isolation mechanism: the Unix-user boundary exists only in the
 * sandbox image, and only test C exercises it. `main.ts` selects this adapter
 * only when `ONCUE_DEV_SUPERVISOR=inprocess`, which no image sets. It reapplies
 * the real env-key and env-value checks, but not the uid check, with the dev
 * host's binary and workspace in place of the image's paths.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckProcess, startCheckProcess } from "./check-process";
import type {
  AgentExit,
  StartAgentRequest,
  SupervisorClient,
  SupervisorOutcome,
} from "./supervisor-client";
import {
  type AgentSignal,
  ALLOWED_SIGNALS,
  type CheckPaths,
  DEFAULT_SPAWN_RUNTIME,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_SECRETS,
  PATH_SEGMENT_PATTERN,
  reviewPrepareAttachments,
  reviewPrepareBase,
  reviewRequest,
  reviewRunCheck,
  reviewRuntimeArgv,
  reviewRuntimeEnv,
  spawnRuleFor,
} from "./supervisor-protocol";

export interface LocalSupervisorOptions {
  /** `ONCUE_DEV_OPENCODE_BIN`: the only argv[0] this adapter will spawn for OpenCode. */
  readonly binary: string;
  /**
   * The dev host's own install of each other harness, by runtime id, standing
   * in for the image's path in its `RUNTIME_SPAWN_RULES` row. A harness with
   * no entry here is refused, as one with no row is by the real supervisor.
   */
  readonly runtimeBinaries?: Readonly<Record<string, string>>;
  /**
   * The dev host's Node and runtime host, standing in for `NODE_BINARY` and
   * `RUNTIME_HOST_PATH`, for a harness that runs under the runtime host.
   */
  readonly runtimeHost?: { readonly node: string; readonly host: string };
  /** `ONCUE_DEV_WORKSPACE`: the only cwd this adapter will spawn into. */
  readonly workspaceDir: string;
  /** Plays `CHECK_OUTPUT_DIR`. */
  readonly checkOutputDir: string;
  /** Plays `BASE_TREE_ROOT`. */
  readonly baseTreeRoot: string;
  /**
   * Plays `SECRETS_DIR`, beside the workspace so a checkpoint cannot hold a
   * secret. With one Unix user this proves the path and modes, nothing about
   * who can read the file; only test C does that.
   */
  readonly secretsDir: string;
  /** Plays `ATTACHMENTS_ROOT`: beside the workspace, never inside it. */
  readonly attachmentsRoot: string;
}

export function localCheckPaths(options: LocalSupervisorOptions): CheckPaths {
  return {
    workspace: options.workspaceDir,
    baseTreeRoot: options.baseTreeRoot,
    checkOutputDir: options.checkOutputDir,
  };
}

export type LocalDenial =
  | "runtime_not_allowed"
  | "binary_not_allowed"
  | "cwd_not_allowed"
  | "env_key_not_allowed"
  | "env_value_too_long"
  | "signal_not_allowed";

export type LocalReview =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly denial: LocalDenial };

/**
 * `reviewRequest`'s `start_agent` review minus the uid check, with the binary
 * and cwd allowlists pointed at the dev host's paths. Exported so tests can
 * enumerate it without spawning anything.
 */
export function reviewLocalRequest(
  options: LocalSupervisorOptions,
  request: StartAgentRequest,
): LocalReview {
  const rule = spawnRuleFor(request.runtime);
  const id = request.runtime ?? DEFAULT_SPAWN_RUNTIME;
  const binary = id === DEFAULT_SPAWN_RUNTIME ? options.binary : options.runtimeBinaries?.[id];
  if (rule === null || binary === undefined) {
    return { kind: "refused", denial: "runtime_not_allowed" };
  }
  const argv = reviewRuntimeArgv(rule, request.argv, {
    binary,
    node: options.runtimeHost?.node ?? "",
    host: options.runtimeHost?.host ?? "",
  });
  if (argv !== null) {
    return { kind: "refused", denial: "binary_not_allowed" };
  }
  if (request.cwd !== options.workspaceDir) {
    return { kind: "refused", denial: "cwd_not_allowed" };
  }
  const env = reviewRuntimeEnv(rule, request.env);
  if (env === "env_key_not_allowed" || env === "env_value_too_long") {
    return { kind: "refused", denial: env };
  }
  return { kind: "allowed" };
}

function isAllowedSignal(signal: string): signal is AgentSignal {
  return (ALLOWED_SIGNALS as readonly string[]).includes(signal);
}

/** Narrowed to the one overload this file uses, so a fake spawn in a unit test needs no real process. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// `chownCalls` and `startCalls` exist only so tests can assert the no-op and
// the review ran.
export interface LocalSupervisor extends SupervisorClient {
  readonly chownCalls: readonly number[];
  readonly startCalls: readonly StartAgentRequest[];
  readonly prepareBaseCalls: readonly string[];
  readonly prepareAttachmentsCalls: readonly string[];
}

/**
 * The image creates the agent's `TMPDIR` at build; on the dev host the home is
 * fresh per session, so the directory is made here before anything writes to it.
 */
export function ensureTmpDir(env: Readonly<Record<string, string>>): void {
  // `CODEX_HOME` too: Codex refuses to start when it does not exist, and the
  // image creates it for the agent the way it creates the temporary directory.
  for (const dir of [env.TMPDIR, env.CODEX_HOME]) {
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

export function createLocalSupervisor(
  options: LocalSupervisorOptions,
  spawnImpl: SpawnImpl = spawn,
): LocalSupervisor {
  let child: ChildProcess | null = null;
  let waiters: ((exit: AgentExit) => void)[] = [];
  let lastExit: AgentExit | null = null;
  const chownCalls: number[] = [];
  const startCalls: StartAgentRequest[] = [];
  const prepareBaseCalls: string[] = [];
  const prepareAttachmentsCalls: string[] = [];
  const paths = localCheckPaths(options);
  let check: { readonly checkRunId: string; readonly process: CheckProcess } | null = null;
  /** As the real supervisor keeps them: for the environment of checks started later. */
  let secrets: Record<string, string> = {};
  const secretPath = (name: string): string => join(options.secretsDir, name);

  function settle(exit: AgentExit): void {
    child = null;
    lastExit = exit;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
      resolve(exit);
    }
  }

  return {
    chownCalls,
    startCalls,
    prepareBaseCalls,
    prepareAttachmentsCalls,

    async chownWorkspace(uid) {
      // Recorded no-op: one Unix user already owns the tree. Recording it lets a
      // test confirm the reducer's chown step ran.
      chownCalls.push(uid);
      return { kind: "ok", value: undefined };
    },

    async startAgent(request) {
      if (child !== null) {
        return { kind: "refused", denial: "already_running" };
      }
      const review = reviewLocalRequest(options, request);
      if (review.kind === "refused") {
        return { kind: "refused", denial: review.denial };
      }
      // `reviewLocalRequest` already checked `argv[0]`; the guard is for
      // `noUncheckedIndexedAccess`.
      const command = request.argv[0];
      if (command === undefined) {
        return { kind: "failed", detail: "start_agent with empty argv" };
      }
      try {
        ensureTmpDir(request.env);
      } catch (error) {
        return {
          kind: "failed",
          detail: error instanceof Error ? error.message : "could not create TMPDIR",
        };
      }
      startCalls.push(request);
      lastExit = null;
      return new Promise<SupervisorOutcome<{ readonly pid: number }>>((resolve) => {
        let settled = false;
        const proc = spawnImpl(command, request.argv.slice(1), {
          cwd: request.cwd,
          env: { ...request.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        proc.once("spawn", () => {
          if (settled) {
            return;
          }
          settled = true;
          child = proc;
          neverOutliveBridge(proc);
          resolve({ kind: "ok", value: { pid: proc.pid ?? -1 } });
        });
        proc.once("error", (error: Error) => {
          settle({ code: null, signal: null });
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            kind: "failed",
            detail: error instanceof Error ? error.message : "spawn failed",
          });
        });
        proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          settle({ code, signal });
        });
      });
    },

    async signal(signal) {
      if (!isAllowedSignal(signal)) {
        return { kind: "refused", denial: "signal_not_allowed" };
      }
      if (child === null) {
        return { kind: "refused", denial: "no_such_agent" };
      }
      child.kill(signal);
      return { kind: "ok", value: undefined };
    },

    async wait() {
      if (child !== null) {
        return new Promise<SupervisorOutcome<AgentExit>>((resolve) => {
          waiters.push((exit) => resolve({ kind: "ok", value: exit }));
        });
      }
      if (lastExit !== null) {
        const exit = lastExit;
        return { kind: "ok", value: exit };
      }
      return { kind: "refused", denial: "no_such_agent" };
    },

    async runCheck(request) {
      const denial = reviewRunCheck({ op: "run_check", requestId: "local", ...request }, paths);
      if (denial !== null) {
        return { kind: "refused", denial };
      }
      if (check !== null) {
        return { kind: "refused", denial: "already_running" };
      }
      let started: CheckProcess;
      try {
        mkdirSync(paths.checkOutputDir, { recursive: true });
        ensureTmpDir(request.env);
        started = startCheckProcess(spawnImpl, {
          command: "/bin/sh",
          args: ["-c", request.command],
          cwd: request.cwd,
          env: { ...secrets, ...request.env },
          timeoutMs: request.timeoutMs,
          outputPath: request.outputPath,
          outputOwner: null,
          maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
        });
      } catch (error) {
        return { kind: "failed", detail: error instanceof Error ? error.message : "spawn failed" };
      }
      const running = { checkRunId: request.checkRunId, process: started };
      check = running;
      const exit = await started.exit;
      if (check === running) {
        check = null;
      }
      return { kind: "ok", value: exit };
    },

    async writeSecret(name, value) {
      // The real review, so a name or value root would refuse is refused here too.
      const review = reviewRequest({ op: "write_secret", requestId: "local", name, value });
      if (review.kind === "refused") {
        return { kind: "refused", denial: review.denial };
      }
      if (!(name in secrets) && Object.keys(secrets).length >= MAX_SECRETS) {
        return { kind: "refused", denial: "too_many_secrets" };
      }
      try {
        mkdirSync(options.secretsDir, { recursive: true, mode: 0o700 });
        rmSync(secretPath(name), { force: true });
        writeFileSync(secretPath(name), value, { mode: 0o400, flag: "wx" });
      } catch (error) {
        return { kind: "failed", detail: error instanceof Error ? error.message : "write failed" };
      }
      secrets = { ...secrets, [name]: value };
      return { kind: "ok", value: undefined };
    },

    async clearSecrets() {
      secrets = {};
      rmSync(options.secretsDir, { recursive: true, force: true });
      return { kind: "ok", value: undefined };
    },

    secretPath,

    async signalCheck(checkRunId, signal) {
      if (!PATH_SEGMENT_PATTERN.test(checkRunId)) {
        return { kind: "refused", denial: "check_id_not_allowed" };
      }
      if (!isAllowedSignal(signal)) {
        return { kind: "refused", denial: "signal_not_allowed" };
      }
      if (check === null || check.checkRunId !== checkRunId) {
        return { kind: "refused", denial: "no_such_check" };
      }
      try {
        check.process.kill(signal);
      } catch (error) {
        return { kind: "failed", detail: error instanceof Error ? error.message : "kill failed" };
      }
      return { kind: "ok", value: undefined };
    },

    async prepareBase(dir, uid) {
      const denial = reviewPrepareBase({ op: "prepare_base", requestId: "local", dir, uid }, paths);
      if (denial !== null) {
        return { kind: "refused", denial };
      }
      // Recorded no-op, as `chownWorkspace` is: one user already owns the tree.
      prepareBaseCalls.push(dir);
      return { kind: "ok", value: undefined };
    },

    async prepareAttachments(dir, uid) {
      const denial = reviewPrepareAttachments(
        { op: "prepare_attachments", requestId: "local", dir, uid },
        options.attachmentsRoot,
      );
      if (denial !== null) {
        return { kind: "refused", denial };
      }
      // Recorded no-op for the same reason: there is no second user to hand to.
      prepareAttachmentsCalls.push(dir);
      return { kind: "ok", value: undefined };
    },

    close() {
      if (child !== null) {
        child.kill("SIGKILL");
      }
      if (check !== null) {
        try {
          check.process.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/**
 * On the dev host nothing kills a stray harness, which would keep its port and
 * answer the next bridge's health check, so it goes down with the bridge.
 */
function neverOutliveBridge(proc: ChildProcess): void {
  const kill = (): void => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  };
  process.once("exit", kill);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => {
      kill();
      process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
    });
  }
}
