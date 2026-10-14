/**
 * The root supervisor (`dist/supervisor.mjs`), which `tini` starts and the only
 * process that runs as root after the entrypoint (record 02). In order, it
 * moves `ONCUE_BRIDGE_BOOTSTRAP` from its environment into
 * `/opt/oncue/bootstrap` (0400, the bridge's uid), makes its directories under
 * `/var/lib/oncue`, binds the bridge-only socket, starts the bridge with an
 * allowlisted environment, serves the socket until the bridge exits, then kills
 * the agent and any check and exits with the bridge's code.
 *
 * It never reads the credential back, holds a model or Git token, opens a
 * network socket, or forwards its own environment; every decision is
 * `reviewRequest`'s. The uid drop uses `setpriv --clear-groups` with numeric
 * ids, so no name lookup can fail open, because Node's `uid`/`gid` options
 * keep root's supplementary groups.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  fchmodSync,
  fchownSync,
  constants as fsConstants,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CheckProcess, startCheckProcess } from "./check-process";
import {
  AGENT_UID,
  type AgentSignal,
  ALLOWED_CWD,
  ATTACHMENTS_ROOT,
  BASE_TREE_ROOT,
  CHECK_OUTPUT_DIR,
  type CheckExit,
  encodeResponse,
  LineSplitter,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_SECRETS,
  parseRequest,
  type Refusal,
  requestIdOf,
  reviewRequest,
  SECRETS_DIR,
  SUPERVISOR_SOCKET,
  type SupervisorRequest,
  type SupervisorResponse,
  type SupervisorResult,
  secretFilePath,
  VERIFICATION_ROOT,
} from "./supervisor-protocol";

// Mirrors `services/sandbox-controller/images.py`, whose `tests/test_images.py`
// pins the same values; a change on either side is a change on both.
export const BRIDGE_HOME = "/opt/oncue";
export const BRIDGE_BUNDLE = `${BRIDGE_HOME}/bridge.mjs`;
export const BOOTSTRAP_FILE = `${BRIDGE_HOME}/bootstrap`;
export const BRIDGE_UID = 1000;
export const BRIDGE_USER_HOME = "/home/oncue-bridge";
export const BOOTSTRAP_ENV_KEY = "ONCUE_BRIDGE_BOOTSTRAP";
export const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** What the bridge child receives. Exported so a test proves the Modal Secret key is not in it. */
export const BRIDGE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "ONCUE_SESSION_ID",
  "ONCUE_SANDBOX_GENERATION",
  "ONCUE_CONTROL_PLANE_ORIGIN",
  "ONCUE_BOOTSTRAP_FILE",
];

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SpawnPlan {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly uid: number;
}

export interface SocketListener {
  close(): void;
}

/** Who a file the supervisor creates belongs to. The bridge's are `BRIDGE_OWNER`. */
export interface Owner {
  readonly uid: number;
  readonly gid: number;
}

export const BRIDGE_OWNER: Owner = { uid: BRIDGE_UID, gid: BRIDGE_UID };

export type LineHandler = (line: string | null, reply: (line: string) => void) => void;

/** A reviewed `run_check`, as the io starts it: the shell wrapping is the supervisor's, not the caller's. */
export interface CheckSpawnPlan {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly timeoutMs: number;
  readonly outputPath: string;
  readonly outputOwner: Owner;
}

/** A directory the supervisor makes at start: path, owner, and mode, applied in that order. */
export interface DirectoryPlan {
  readonly path: string;
  readonly owner: Owner;
  readonly mode: number;
}

const ROOT_OWNER: Owner = { uid: 0, gid: 0 };
/** A secret file's owner: root, with the agent's group, mode 0440. The agent reads it and cannot change or remove it. */
const SECRET_OWNER: Owner = { uid: 0, gid: AGENT_UID };

/**
 * The verification directories, parent first. The bridge's group may create a
 * base checkout and read a log; the agent may only traverse to a checkout it
 * was handed by name.
 */
export const VERIFICATION_DIRECTORIES: readonly DirectoryPlan[] = [
  { path: VERIFICATION_ROOT, owner: ROOT_OWNER, mode: 0o755 },
  { path: CHECK_OUTPUT_DIR, owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o750 },
  { path: BASE_TREE_ROOT, owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o771 },
  // The agent's group lists and reads its secrets; only root writes here, so
  // nothing the agent plants can redirect a write, and the bridge (in neither
  // group) cannot traverse it.
  { path: SECRETS_DIR, owner: SECRET_OWNER, mode: 0o750 },
  // Composer attachments: the bridge makes one directory per message here,
  // and the agent may only traverse to one it was named.
  { path: ATTACHMENTS_ROOT, owner: { uid: 0, gid: BRIDGE_UID }, mode: 0o771 },
];

export interface SupervisorIo {
  /** Starts `plan.argv` as `plan.uid`/`plan.uid` with exactly `plan.env`. Throws when the start itself fails. */
  spawn(plan: SpawnPlan): number;
  chownRecursive(path: string, uid: number, gid: number): void;
  /** Throws when the process is not there to signal. */
  kill(pid: number, signal: AgentSignal): void;
  /** Resolves when the process exits, and again at once for one that already has. */
  wait(pid: number): Promise<ProcessExit>;
  writeCredentialFile(path: string, value: string, owner: Owner): void;
  /**
   * Replaces `path` with a new regular file holding `value`, mode 0440. It
   * never opens what is already there: anything at the path is unlinked, and
   * the file is created with `O_EXCL | O_NOFOLLOW`, so a link planted at the
   * path is removed rather than written through. Throws when it cannot.
   */
  writeSecretFile(path: string, value: string, owner: Owner): void;
  /** Removes every entry of `dir`, leaving the directory. A directory that is not there is nothing to clear. */
  clearSecretFiles(dir: string): void;
  /** Starts a check as `plan.uid` in its own process group, output to a new file. Throws when it cannot. */
  spawnCheck(plan: CheckSpawnPlan): number;
  /** Resolves when the check has ended and its output is flushed. */
  waitCheck(pid: number): Promise<CheckExit>;
  /** Signals the check's whole process group. Throws when it is gone. */
  killCheck(pid: number, signal: AgentSignal): void;
  /**
   * Chowns what the bridge wrote under `path` to `to`, skipping anything not
   * owned by `fromUid`, every symlink's target, and any file with a second
   * hard link. Throws when `path` is not a directory `fromUid` owns.
   */
  chownBaseTree(path: string, fromUid: number, to: Owner): void;
  /** Creates the directory if absent; throws when the path is not a real directory. */
  makeDirectory(plan: DirectoryPlan): void;
  /** `onLine` gets `null` for a line the splitter had to discard. */
  listen(path: string, owner: Owner, onLine: LineHandler): Promise<SocketListener>;
  onShutdownSignal(listener: () => void): void;
  log(line: string): void;
}

/**
 * The bridge's environment, built from an allowlist rather than by removing
 * the credential from a copy: a copy would carry every other Modal Secret
 * the container was given, and there is no list of those to subtract.
 */
export function bridgeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = { PATH: env.PATH ?? DEFAULT_PATH, HOME: BRIDGE_USER_HOME };
  for (const key of BRIDGE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && !(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

export function privilegedArgv(uid: number, argv: readonly string[]): string[] {
  return ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", ...argv];
}

export interface RunningCheck {
  readonly checkRunId: string;
  readonly pid: number;
}

export interface SupervisorState {
  readonly agentPid: number | null;
  readonly agentExited: boolean;
  /** At most one check at a time. Cleared when its `run_check` answers. */
  readonly check: RunningCheck | null;
  /**
   * The secrets written so far, in root's memory, so a check started later gets
   * them in its environment. Never logged or returned; forgotten at `clear_secrets`.
   */
  readonly secrets: Readonly<Record<string, string>>;
}

export const INITIAL_STATE: SupervisorState = {
  agentPid: null,
  agentExited: false,
  check: null,
  secrets: {},
};

export interface HandleStep {
  readonly state: SupervisorState;
  readonly response: Promise<SupervisorResponse>;
}

function agentLive(state: SupervisorState): state is SupervisorState & { agentPid: number } {
  return state.agentPid !== null && !state.agentExited;
}

function accepted(requestId: string, result: SupervisorResult): Promise<SupervisorResponse> {
  return Promise.resolve({ requestId, ok: true, result });
}

function refused(requestId: string, refusal: Refusal): Promise<SupervisorResponse> {
  return Promise.resolve({ requestId, ok: false, refusal });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): Refusal {
  return { reason: "failed", detail: describeError(error) };
}

/**
 * Reviewed, then performed: the only caller of `SupervisorIo`'s privileged
 * methods, and its first statement is `reviewRequest`. The state transition is
 * synchronous and only the response may be deferred, so two requests in flight
 * cannot interleave the state. `chown_workspace` always targets `ALLOWED_CWD`.
 */
export function handle(
  state: SupervisorState,
  request: SupervisorRequest,
  io: SupervisorIo,
): HandleStep {
  const review = reviewRequest(request);
  if (review.kind === "refused") {
    return {
      state,
      response: refused(request.requestId, { reason: "not_permitted", detail: review.denial }),
    };
  }
  const allowed = review.request;
  switch (allowed.op) {
    case "chown_workspace":
      try {
        io.chownRecursive(ALLOWED_CWD, allowed.uid, allowed.uid);
        return { state, response: accepted(allowed.requestId, { op: "chown_workspace" }) };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    case "start_agent": {
      if (agentLive(state)) {
        return { state, response: refused(allowed.requestId, { reason: "already_running" }) };
      }
      try {
        const pid = io.spawn({
          argv: allowed.argv,
          cwd: allowed.cwd,
          env: allowed.env,
          uid: allowed.uid,
        });
        return {
          state: { ...state, agentPid: pid, agentExited: false },
          response: accepted(allowed.requestId, { op: "start_agent", pid }),
        };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    }
    case "signal":
      if (!agentLive(state)) {
        return { state, response: refused(allowed.requestId, { reason: "no_such_agent" }) };
      }
      try {
        io.kill(state.agentPid, allowed.signal);
        return { state, response: accepted(allowed.requestId, { op: "signal" }) };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    case "wait": {
      // An agent that already exited still answers: the caller may have asked
      // after the fact, and the io remembers the exit for that.
      const pid = state.agentPid;
      if (pid === null) {
        return { state, response: refused(allowed.requestId, { reason: "no_such_agent" }) };
      }
      return {
        state,
        response: io.wait(pid).then(
          (exit): SupervisorResponse => ({
            requestId: allowed.requestId,
            ok: true,
            result: { op: "wait", code: exit.code, signal: exit.signal },
          }),
          (error): SupervisorResponse => ({
            requestId: allowed.requestId,
            ok: false,
            refusal: failure(error),
          }),
        ),
      };
    }
    case "run_check": {
      if (state.check !== null) {
        return { state, response: refused(allowed.requestId, { reason: "already_running" }) };
      }
      let pid: number;
      try {
        pid = io.spawnCheck({
          command: allowed.command,
          cwd: allowed.cwd,
          // The reviewed environment wins. The two cannot overlap: every name
          // the allowlist holds is one `refuseSecretName` reserves.
          env: { ...state.secrets, ...allowed.env },
          uid: allowed.uid,
          timeoutMs: allowed.timeoutMs,
          outputPath: allowed.outputPath,
          outputOwner: BRIDGE_OWNER,
        });
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
      return {
        state: { ...state, check: { checkRunId: allowed.checkRunId, pid } },
        response: io.waitCheck(pid).then(
          (exit): SupervisorResponse => ({
            requestId: allowed.requestId,
            ok: true,
            result: { op: "run_check", ...exit },
          }),
          (error): SupervisorResponse => ({
            requestId: allowed.requestId,
            ok: false,
            refusal: failure(error),
          }),
        ),
      };
    }
    case "signal_check":
      if (state.check === null || state.check.checkRunId !== allowed.checkRunId) {
        return { state, response: refused(allowed.requestId, { reason: "no_such_check" }) };
      }
      try {
        io.killCheck(state.check.pid, allowed.signal);
        return { state, response: accepted(allowed.requestId, { op: "signal_check" }) };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    case "prepare_base":
      try {
        io.chownBaseTree(allowed.dir, BRIDGE_UID, { uid: allowed.uid, gid: allowed.uid });
        return { state, response: accepted(allowed.requestId, { op: "prepare_base" }) };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    // The same chown as a base checkout, for the same reasons: it follows no
    // link and takes nothing the bridge did not make.
    case "prepare_attachments":
      try {
        io.chownBaseTree(allowed.dir, BRIDGE_UID, { uid: allowed.uid, gid: allowed.uid });
        return { state, response: accepted(allowed.requestId, { op: "prepare_attachments" }) };
      } catch (error) {
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
    case "write_secret": {
      const known = allowed.name in state.secrets;
      if (!known && Object.keys(state.secrets).length >= MAX_SECRETS) {
        return {
          state,
          response: refused(allowed.requestId, {
            reason: "not_permitted",
            detail: "too_many_secrets",
          }),
        };
      }
      try {
        io.writeSecretFile(secretFilePath(allowed.name), allowed.value, SECRET_OWNER);
      } catch (error) {
        // An operating-system error names a path, never the value.
        return { state, response: refused(allowed.requestId, failure(error)) };
      }
      return {
        state: { ...state, secrets: { ...state.secrets, [allowed.name]: allowed.value } },
        response: accepted(allowed.requestId, { op: "write_secret" }),
      };
    }
    case "clear_secrets":
      try {
        io.clearSecretFiles(SECRETS_DIR);
      } catch (error) {
        return {
          state: { ...state, secrets: {} },
          response: refused(allowed.requestId, failure(error)),
        };
      }
      return {
        state: { ...state, secrets: {} },
        response: accepted(allowed.requestId, { op: "clear_secrets" }),
      };
  }
}

export function noteAgentExit(state: SupervisorState, pid: number): SupervisorState {
  return state.agentPid === pid ? { ...state, agentExited: true } : state;
}

export function noteCheckEnded(state: SupervisorState, checkRunId: string): SupervisorState {
  return state.check?.checkRunId === checkRunId ? { ...state, check: null } : state;
}

export function malformedResponse(line: string | null): SupervisorResponse {
  return {
    requestId: line === null ? "" : requestIdOf(line),
    ok: false,
    refusal: { reason: "malformed" },
  };
}

export interface Supervisor {
  readonly handleLine: LineHandler;
  /** Sends `signal` to the agent if one is live; a no-op otherwise. Returns its pid when it sent. */
  killAgent(signal: AgentSignal): number | null;
  /** Sends `signal` to a running check's group if there is one. Returns its pid when it sent. */
  killCheck(signal: AgentSignal): number | null;
  snapshot(): SupervisorState;
}

/** One state, one writer: every line and every exit goes through here. */
export function createSupervisor(io: SupervisorIo): Supervisor {
  let state = INITIAL_STATE;
  return {
    handleLine(line, reply) {
      const request = line === null ? null : parseRequest(line);
      if (request === null) {
        reply(encodeResponse(malformedResponse(line)));
        return;
      }
      const previous = state;
      const step = handle(state, request, io);
      state = step.state;
      const pid = state.agentPid;
      if (pid !== null && pid !== previous.agentPid) {
        void io.wait(pid).then(
          () => {
            state = noteAgentExit(state, pid);
          },
          () => {
            state = noteAgentExit(state, pid);
          },
        );
      }
      void step.response.then((response) => {
        const started = step.state.check;
        if (started !== null && started !== previous.check) {
          state = noteCheckEnded(state, started.checkRunId);
        }
        reply(encodeResponse(response));
      });
    },
    killAgent(signal) {
      if (!agentLive(state)) {
        return null;
      }
      try {
        io.kill(state.agentPid, signal);
      } catch {
        return null;
      }
      return state.agentPid;
    },
    killCheck(signal) {
      if (state.check === null) {
        return null;
      }
      try {
        io.killCheck(state.check.pid, signal);
      } catch {
        return null;
      }
      return state.check.pid;
    },
    snapshot() {
      return state;
    },
  };
}

function describeExit(exit: ProcessExit): string {
  return exit.signal === null ? `with code ${exit.code}` : `on ${exit.signal}`;
}

/**
 * The whole life of the process. The credential is deleted from `env` before
 * anything is spawned, and `bridgeEnvironment` is computed after the delete,
 * so no ordering mistake here can hand the value on.
 */
export async function runSupervisor(
  env: Record<string, string | undefined>,
  io: SupervisorIo,
): Promise<number> {
  const credential = env[BOOTSTRAP_ENV_KEY] ?? "";
  io.writeCredentialFile(BOOTSTRAP_FILE, credential, BRIDGE_OWNER);
  delete env[BOOTSTRAP_ENV_KEY];
  if (credential.length === 0) {
    io.log("supervisor found no bootstrap credential in the environment");
  }
  const bridgeEnv = bridgeEnvironment(env);

  for (const directory of VERIFICATION_DIRECTORIES) {
    try {
      io.makeDirectory(directory);
    } catch (error) {
      // Verification cannot run without it, and a run then ends with its
      // checks recorded as unable to run; the session itself still starts.
      io.log(`supervisor could not prepare ${directory.path}: ${describeError(error)}`);
      break;
    }
  }

  const supervisor = createSupervisor(io);
  const listener = await io.listen(SUPERVISOR_SOCKET, BRIDGE_OWNER, supervisor.handleLine);
  io.log(`supervisor listening on ${SUPERVISOR_SOCKET}`);

  let bridgePid: number;
  try {
    bridgePid = io.spawn({
      argv: ["node", BRIDGE_BUNDLE],
      cwd: BRIDGE_HOME,
      env: bridgeEnv,
      uid: BRIDGE_UID,
    });
  } catch (error) {
    io.log(`supervisor could not start the bridge: ${describeError(error)}`);
    listener.close();
    return 1;
  }
  io.onShutdownSignal(() => {
    try {
      io.kill(bridgePid, "SIGTERM");
    } catch {
      // Already gone; the wait below is about to resolve.
    }
  });

  const exit = await io.wait(bridgePid);
  io.log(`supervisor: bridge exited ${describeExit(exit)}`);
  const agentPid = supervisor.killAgent("SIGKILL");
  supervisor.killCheck("SIGKILL");
  if (agentPid !== null) {
    await io.wait(agentPid);
  }
  // The secrets never outlive the bridge: a graceful shutdown already cleared
  // them, a crash or a signal did not.
  try {
    io.clearSecretFiles(SECRETS_DIR);
  } catch (error) {
    io.log(
      `supervisor: could not clear the secrets: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  listener.close();
  return exit.code ?? 1;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

function chownTree(path: string, uid: number, gid: number): void {
  // `lchown` and no symlink following: the tree was cloned from a repository
  // the agent chose, and a link in it may point outside `/workspace`.
  lchownSync(path, uid, gid);
  if (lstatSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) {
      chownTree(join(path, entry), uid, gid);
    }
  }
}

/** Chowns only what `fromUid` made, so a link or hard link planted in the tree cannot redirect it. */
function chownOwnedTree(path: string, fromUid: number, to: Owner): void {
  const stat = lstatSync(path);
  if (stat.uid !== fromUid) {
    return;
  }
  if (!stat.isDirectory() && stat.nlink > 1) {
    return;
  }
  lchownSync(path, to.uid, to.gid);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      chownOwnedTree(join(path, entry), fromUid, to);
    }
  }
}

export function nodeSupervisorIo(spawnProcess: SpawnProcess = nodeSpawn): SupervisorIo {
  const exits = new Map<number, Promise<ProcessExit>>();
  const children = new Map<number, ChildProcess>();
  const checks = new Map<number, CheckProcess>();
  return {
    spawn(plan) {
      const [command, ...args] = privilegedArgv(plan.uid, plan.argv);
      const child = spawnProcess(command as string, args, {
        cwd: plan.cwd,
        env: { ...plan.env },
        stdio: "inherit",
      });
      const pid = child.pid;
      if (pid === undefined) {
        child.once("error", () => {});
        throw new Error(`could not start ${plan.argv[0]}`);
      }
      children.set(pid, child);
      exits.set(
        pid,
        new Promise<ProcessExit>((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", () => resolve({ code: null, signal: null }));
        }),
      );
      return pid;
    },
    chownRecursive(path, uid, gid) {
      chownTree(path, uid, gid);
    },
    kill(pid, signal) {
      const child = children.get(pid);
      if (child === undefined || !child.kill(signal)) {
        throw new Error(`no process ${pid} to signal`);
      }
    },
    wait(pid) {
      return exits.get(pid) ?? Promise.reject(new Error(`no process ${pid} to wait for`));
    },
    writeCredentialFile(path, value, owner) {
      writeFileSync(path, value, { mode: 0o400 });
      chownSync(path, owner.uid, owner.gid);
      chmodSync(path, 0o400);
    },
    writeSecretFile(path, value, owner) {
      // Whatever is at the path goes first, unopened: `rm` unlinks a symlink
      // rather than following it, and the create below refuses anything that
      // appears in between. Only root can write the real directory at all.
      rmSync(path, { force: true });
      const fd = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o440,
      );
      try {
        fchownSync(fd, owner.uid, owner.gid);
        fchmodSync(fd, 0o440);
        writeSync(fd, value);
      } finally {
        closeSync(fd);
      }
    },
    clearSecretFiles(dir) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        rmSync(join(dir, entry), { force: true, recursive: true });
      }
    },
    spawnCheck(plan) {
      const [command, ...args] = privilegedArgv(plan.uid, ["/bin/sh", "-c", plan.command]);
      const check = startCheckProcess(spawnProcess, {
        command: command as string,
        args,
        cwd: plan.cwd,
        env: plan.env,
        timeoutMs: plan.timeoutMs,
        outputPath: plan.outputPath,
        outputOwner: plan.outputOwner,
        maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
      });
      checks.set(check.pid, check);
      void check.exit.then(() => checks.delete(check.pid));
      return check.pid;
    },
    waitCheck(pid) {
      return checks.get(pid)?.exit ?? Promise.reject(new Error(`no check ${pid} to wait for`));
    },
    killCheck(pid, signal) {
      const check = checks.get(pid);
      if (check === undefined) {
        throw new Error(`no check ${pid} to signal`);
      }
      check.kill(signal);
    },
    chownBaseTree(path, fromUid, to) {
      const top = lstatSync(path);
      if (!top.isDirectory() || top.uid !== fromUid) {
        throw new Error("the base tree is not a directory the bridge made");
      }
      chownOwnedTree(path, fromUid, to);
    },
    makeDirectory(plan) {
      try {
        mkdirSync(plan.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      if (!lstatSync(plan.path).isDirectory()) {
        throw new Error(`${plan.path} is not a directory`);
      }
      chownSync(plan.path, plan.owner.uid, plan.owner.gid);
      chmodSync(plan.path, plan.mode);
    },
    listen(path, owner, onLine) {
      return new Promise<SocketListener>((resolve, reject) => {
        const open = new Set<Socket>();
        const server = createServer((socket) => {
          open.add(socket);
          socket.setEncoding("utf8");
          const splitter = new LineSplitter();
          const reply = (line: string): void => {
            if (!socket.destroyed) {
              socket.write(line);
            }
          };
          socket.on("data", (chunk: string) => {
            for (const line of splitter.push(chunk)) {
              onLine(line, reply);
            }
          });
          socket.on("error", () => {});
          socket.once("close", () => open.delete(socket));
        });
        server.once("error", reject);
        server.listen(path, () => {
          try {
            chownSync(path, owner.uid, owner.gid);
            chmodSync(path, 0o600);
          } catch (error) {
            server.close();
            reject(error);
            return;
          }
          resolve({
            close() {
              for (const socket of open) {
                socket.destroy();
              }
              server.close();
            },
          });
        });
      });
    },
    onShutdownSignal(listener) {
      process.once("SIGTERM", listener);
    },
    log(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}

export async function main(): Promise<number> {
  // Children inherit this. The bootstrap file and the socket get explicit
  // modes, and 022 is what lets the bridge read a tree the agent wrote.
  process.umask(0o022);
  return runSupervisor(process.env, nodeSupervisorIo());
}

// Bundled, this file IS what `tini` runs. Under the test runner it is an
// imported module and argv[1] is vitest, so nothing starts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
