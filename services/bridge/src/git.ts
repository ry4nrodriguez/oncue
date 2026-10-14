/**
 * The bridge's own Git, run as the bridge user so the token never reaches the
 * agent's shell (record 07): clone the task branch with a single-use token,
 * snapshot and measure the work tree, and push one checkpoint to one ref.
 *
 * The token never goes in argv (visible in `/proc/<pid>/cmdline`), the clone
 * URL (kept in `.git/config`), or the environment (inherited by every child).
 * It is written to a pipe the child inherits as fd 3, which `GIT_ASKPASS`
 * reads; `GitProcessRunner`'s signature keeps it out of argv and env.
 *
 * `pushExact` is the only push: no force, no `+` refspec, no remote name, and
 * `remote.origin.pushurl` is `/dev/null` so a push from inside the tree fails.
 * Once the tree belongs to the agent's uid, checkpoint commands use a private
 * index, objects, and git dir under the bridge's scratch directory, reading
 * the tree's objects through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so the
 * agent's `.git` is never read for config or hooks and never written. Every
 * exported function returns a typed outcome and never throws, because the
 * caller is an effect interpreter that must turn every ending into an input.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitMessageOrFallback } from "./commit-message";

/** Where `images.py`'s entrypoint installs the askpass script, root-owned and 0555. */
export const DEFAULT_ASKPASS_PATH = "/opt/oncue/askpass";

/** GitHub's installation-token revocation endpoint; the token itself is the bearer. */
export const GITHUB_REVOKE_TOKEN_URL = "https://api.github.com/installation/token";

/**
 * Wall-clock bounds on the bridge's network Git, each enforced by killing the
 * command's process group (`nodeRunGit`). A clone of a large repository on a
 * slow day takes minutes; a hung one would otherwise hold the session in
 * provisioning forever.
 */
export const CLONE_TIMEOUT_MS = 10 * 60_000;
/** The one fetch by commit id that follows a clone whose tip moved. */
export const FETCH_TIMEOUT_MS = 2 * 60_000;
export const PUSH_TIMEOUT_MS = 5 * 60_000;
/** One `patchBetween`: the time it may take and the patch text it may read. */
export const PATCH_TIMEOUT_MS = 2 * 60_000;
/** Past this a patch is not read whole, and `patchBetween` fails rather than return part of one. */
export const PATCH_MAX_BYTES = 64 * 1024 * 1024;
/** The token revocation request; a hung one must not hold a checkpoint or a clone. */
export const REVOKE_TIMEOUT_MS = 15_000;

export type Taken<T> = { readonly kind: "taken"; readonly value: T };
export type Spent = { readonly kind: "spent" };

/**
 * A value that can be read exactly once, so a bug that calls `clone` twice
 * cannot resurrect the token the object already refuses to grant twice.
 */
export interface SingleUse<T> {
  take(): Taken<T> | Spent;
}

export function singleUse<T>(value: T): SingleUse<T> {
  let spent = false;
  return {
    take(): Taken<T> | Spent {
      if (spent) {
        return { kind: "spent" };
      }
      spent = true;
      return { kind: "taken", value };
    },
  };
}

export interface GitProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when `timeoutMs` passed and the process was killed. */
  readonly timedOut?: boolean;
  /** Set when stdout reached `maxStdoutBytes`: `stdout` holds that much and the process was killed. */
  readonly stdoutTruncated?: boolean;
}

export interface RunGitOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Past this many milliseconds the process is killed and the result says `timedOut`. */
  readonly timeoutMs?: number;
  /** Past this many bytes of stdout the process is killed and the result says `stdoutTruncated`. */
  readonly maxStdoutBytes?: number;
}

/**
 * Spawns `argv` in `cwd` with exactly `env`. `secretLines`, when not `null`,
 * are written one per line to a pipe the child inherits as fd 3, then closed;
 * it is the only parameter that can carry a token.
 */
export type GitProcessRunner = (
  argv: readonly string[],
  options: RunGitOptions,
  secretLines: readonly string[] | null,
) => Promise<GitProcessResult>;

export interface RevokeResult {
  readonly ok: boolean;
  readonly status: number | null;
}

/** `DELETE https://api.github.com/installation/token`, bearer `token`. Never rejects. */
export type RevokeInstallationToken = (token: string) => Promise<RevokeResult>;

export interface GitIo {
  readonly runGit: GitProcessRunner;
  readonly revoke: RevokeInstallationToken;
  /** `{ PATH, HOME }` from the bridge process's own environment. Never a credential. */
  readonly env: { readonly PATH: string; readonly HOME: string };
  /** Injectable so a test can point `GIT_ASKPASS` at a fixture script. */
  readonly askpassPath: string;
}

/**
 * SIGKILL to the child's whole process group, so a time bound or the stdout
 * cap reaches every process the command started. Killing only the child is not
 * enough: a grandchild (dash keeps even a single `sh -c` command as a child;
 * git keeps `git-remote-https`) holds the pipes, and `close` waits for it.
 * Falls back to the child alone when the group is already gone.
 */
export function killProcessGroup(child: {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
}): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is gone already; the child's own exit is on its way.
    }
  }
  child.kill("SIGKILL");
}

/** The real process runner: `node:child_process.spawn` with fd 3 opened for the token. */
export const nodeRunGit: GitProcessRunner = (argv, options, secretLines) =>
  new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ code: null, stdout: "", stderr: "empty argv" });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // Its own process group, so `killProcessGroup` reaches what it starts.
      detached: true,
      // No stdin, captured stdout and stderr, and fd 3 as the pipe
      // `GIT_ASKPASS` reads the token from.
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let stderr = "";
    const maxStdoutBytes = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) {
        return;
      }
      const room = maxStdoutBytes - stdoutBytes;
      if (chunk.byteLength >= room) {
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes += room;
        stdoutTruncated = true;
        killProcessGroup(child);
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, options.timeoutMs);
    const settle = (code: number | null, fallbackStderr: string) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderr.length > 0 ? stderr : fallbackStderr,
        ...(timedOut ? { timedOut } : {}),
        ...(stdoutTruncated ? { stdoutTruncated } : {}),
      });
    };
    child.once("error", (error) => {
      settle(null, String(error));
    });
    child.once("close", (code) => {
      settle(code, "");
    });
    const fd3 = child.stdio[3];
    if (fd3 !== null && fd3 !== undefined && "on" in fd3) {
      // A clone that never asks for a credential (a local path, a public
      // remote) exits without reading the pipe, which then errors on write;
      // that is not a failure of the clone.
      fd3.on("error", () => {});
    }
    if (secretLines !== null && fd3 !== null && fd3 !== undefined && "write" in fd3) {
      for (const line of secretLines) {
        fd3.write(`${line}\n`);
      }
      if ("end" in fd3) {
        fd3.end();
      }
    } else if (fd3 !== null && fd3 !== undefined && "end" in fd3) {
      fd3.end();
    }
  });

/** The real revoke call. A thrown fetch error becomes `{ ok: false, status: null }`, never a rejection. */
export const fetchRevoke = (fetchImpl: typeof fetch = fetch): RevokeInstallationToken => {
  return async (token: string): Promise<RevokeResult> => {
    try {
      const response = await fetchImpl(GITHUB_REVOKE_TOKEN_URL, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      return { ok: response.status === 204, status: response.status };
    } catch {
      return { ok: false, status: null };
    }
  };
};

export function nodeGitIo(overrides: Partial<Pick<GitIo, "env" | "askpassPath">> = {}): GitIo {
  return {
    runGit: nodeRunGit,
    revoke: fetchRevoke(),
    env: overrides.env ?? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    askpassPath: overrides.askpassPath ?? DEFAULT_ASKPASS_PATH,
  };
}

export interface CloneGrant {
  readonly token: string;
  readonly cloneUrl: string;
  readonly branch: string;
  /**
   * The commit the work tree must land on: the session's base commit before
   * any push, the last checkpoint it pushed after one. The branch's tip may
   * have moved past it on GitHub; see `clone`.
   */
  readonly baseSha: string;
  /**
   * True when `branch` is the session's own task branch, whose newer commits
   * were pushed by a person and are kept. False for the base branch, whose
   * newer commits are not the session's to take.
   */
  readonly ownBranch?: boolean;
}

export type CloneFailureReason =
  | "authentication_failed"
  | "not_found"
  /** The repository answered, but the branch is not on it: deleted on GitHub. */
  | "branch_missing"
  | "network"
  /** Killed at `CLONE_TIMEOUT_MS`: most likely a repository too large to clone in that time, not a blip. */
  | "timed_out"
  | "unknown";

/** A full commit id, SHA-1 or SHA-256. Anything else never reaches `git`'s argv as a revision. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Where a clone left the work tree relative to the branch's tip (record 07):
 * `at_tip`; `base_moved` (the tree stays at the session's own base commit);
 * `branch_ahead` (someone pushed on the task branch, and the tree takes their
 * tip so the next push is still a fast-forward); or `branch_rewritten` (a
 * force-push dropped the session's last push; the tree stays at that push, and
 * GitHub refuses the next push as a non-fast-forward, overwriting nothing).
 */
export type CloneLanding = "at_tip" | "base_moved" | "branch_ahead" | "branch_rewritten";

/**
 * What git and the server said, as lowercase lines with every quoted string
 * replaced by `''`. Git quotes the URL, the target path, and the ref it names,
 * so a repository called `network-tools` or a branch called `fix-403` cannot
 * look like a cause.
 */
function diagnosticLines(stderr: string): readonly string[] {
  return stderr
    .toLowerCase()
    .split("\n")
    .map((line) => line.replace(/'[^'\n]*'/g, "''").trim())
    .filter((line) => line.length > 0);
}

/** The HTTP status git reports for a smart-HTTP refusal, from its own fixed wording. */
function httpStatusOf(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = /the requested url returned error: (\d{3})/.exec(line);
    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
  }
  return null;
}

const AUTH_PHRASES = [
  "authentication failed",
  "could not read username",
  "could not read password",
  "invalid username or password",
  "invalid credentials",
] as const;

/** What a dropped or unreachable connection looks like, in git's and curl's words. */
const NETWORK_PHRASES = [
  "could not resolve host",
  "could not connect",
  "couldn't connect",
  "failed to connect",
  "connection timed out",
  "operation timed out",
  "connection reset",
  "connection refused",
  "early eof",
  "the remote end hung up",
  "rpc failed",
  "ssl_read",
  "gnutls",
  "tls connection",
] as const;

function anyLineHas(lines: readonly string[], phrases: readonly string[]): boolean {
  return lines.some((line) => phrases.some((phrase) => line.includes(phrase)));
}

/**
 * Classified into a small enum and never returned whole: a 401 or 404 body can
 * echo the request URL, and a repository's error text is not for session
 * events. Read from stderr only, with quoted strings removed, and from git's
 * fixed phrases and the HTTP status it reports, never a bare number.
 */
export function classifyCloneFailure(stderr: string, timedOut = false): CloneFailureReason {
  if (timedOut) {
    return "timed_out";
  }
  const lines = diagnosticLines(stderr);
  const status = httpStatusOf(lines);
  if (status === 401 || status === 403 || anyLineHas(lines, AUTH_PHRASES)) {
    return "authentication_failed";
  }
  // The repository answered and the branch is gone: `fatal: Remote branch
  // <name> not found in upstream origin`. Checked before the generic "not
  // found", which means the repository itself.
  if (lines.some((line) => /^(fatal: |warning: )?(could not find )?remote branch /.test(line))) {
    return "branch_missing";
  }
  if (
    status === 404 ||
    lines.some(
      (line) =>
        /^fatal: repository '' not found/.test(line) ||
        line === "remote: not found" ||
        line.includes("repository not found") ||
        line.includes("does not appear to be a git repository"),
    )
  ) {
    return "not_found";
  }
  if ((status !== null && status >= 500) || anyLineHas(lines, NETWORK_PHRASES)) {
    return "network";
  }
  return "unknown";
}

export type CloneOutcome =
  /** The grant had already been taken once; nothing was run. */
  | { readonly kind: "grant_spent" }
  | {
      readonly kind: "clone_failed";
      readonly reason: CloneFailureReason;
      readonly tokenRevoked: boolean;
    }
  | { readonly kind: "verify_failed"; readonly detail: string }
  /**
   * The branch's tip is not the expected commit, and the expected commit is
   * neither in the branch's history nor fetchable from GitHub by its id: the
   * history was rewritten and the commit is gone.
   */
  | {
      readonly kind: "commit_missing";
      readonly expected: string;
      readonly branchTip: string;
      readonly tokenRevoked: boolean;
    }
  | {
      readonly kind: "cloned";
      readonly headSha: string;
      readonly tokenRevoked: boolean;
      readonly landing: CloneLanding;
      /** `branch_ahead` only: the session's last push, where the tree goes back to when a saved patch does not apply on the newer tip. */
      readonly fallbackSha: string | null;
    };

/**
 * The clone's argv. The empty `credential.helper` keeps any ambient helper from
 * caching the token. Exported so a test can assert the token is in none of it.
 */
export function cloneArgv(
  grant: Pick<CloneGrant, "branch" | "cloneUrl">,
  target: string,
): readonly string[] {
  return [
    "git",
    "-c",
    "credential.helper=",
    "clone",
    "--branch",
    grant.branch,
    "--single-branch",
    grant.cloneUrl,
    target,
  ];
}

/**
 * `PATH`, `HOME`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`, and
 * `GIT_CONFIG_NOSYSTEM=1`, nothing else: no inherited `GIT_*` variable or
 * ambient helper, and a prompt that would hang is refused.
 */
export function gitEnv(io: Pick<GitIo, "env" | "askpassPath">): Readonly<Record<string, string>> {
  return {
    PATH: io.env.PATH,
    HOME: io.env.HOME,
    GIT_ASKPASS: io.askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * `git reset --hard <sha>` with hooks off, in a tree the bridge still owns,
 * only before the hand-over on a fresh clone or restore, so nothing is
 * discarded. False for anything that is not a full commit id, without running git.
 */
export async function checkoutCommit(workTree: string, sha: string, io: GitIo): Promise<boolean> {
  if (!COMMIT_ID.test(sha)) {
    return false;
  }
  const result = await io.runGit(
    ["git", "-c", "core.hooksPath=/dev/null", "reset", "-q", "--hard", sha],
    { cwd: workTree, env: gitEnv(io) },
    null,
  );
  return result.code === 0;
}

/**
 * Clones the grant's branch into `target`, lands the work tree on the grant's
 * commit, sets `remote.origin.pushurl` to `/dev/null`, and revokes the token.
 * Only the clone and at most one fetch get the token, and only on fd 3.
 *
 * The branch's tip may differ from the grant's commit (the base moved, or a
 * person pushed). The expected commit is then looked for in the clone, then
 * fetched by id once (GitHub serves unreachable commits for a while after a
 * force-push); if still missing the result is `commit_missing`, otherwise
 * `CloneLanding` says where the tree landed. All of this runs before
 * `chown_workspace` hands the tree to the agent.
 */
export async function clone(
  grant: SingleUse<CloneGrant>,
  target: string,
  io: GitIo,
): Promise<CloneOutcome> {
  const taken = grant.take();
  if (taken.kind === "spent") {
    return { kind: "grant_spent" };
  }
  const { value } = taken;
  const env = gitEnv(io);
  if (!COMMIT_ID.test(value.baseSha)) {
    // Never a revision git would read as an option or a ref name.
    await io.revoke(value.token);
    return { kind: "verify_failed", detail: "the grant's commit is not a commit id" };
  }

  const cloneResult = await io.runGit(
    cloneArgv(value, target),
    { cwd: ".", env, timeoutMs: CLONE_TIMEOUT_MS },
    [value.token],
  );
  if (cloneResult.code !== 0) {
    // Every path that took the token revokes it, a failed clone included:
    // it is single use, and nothing else will spend it.
    const revoke = await io.revoke(value.token);
    return {
      kind: "clone_failed",
      reason: classifyCloneFailure(cloneResult.stderr, cloneResult.timedOut === true),
      tokenRevoked: revoke.ok,
    };
  }
  const inTree = (
    args: readonly string[],
    secretLines: readonly string[] | null = null,
    timeoutMs?: number,
  ) =>
    io.runGit(
      ["git", ...args],
      { cwd: target, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      secretLines,
    );

  const revParse = await inTree(["rev-parse", "HEAD"]);
  const tipSha = revParse.stdout.trim();
  if (revParse.code !== 0 || tipSha.length === 0) {
    await io.revoke(value.token);
    return { kind: "verify_failed", detail: "git rev-parse HEAD did not produce a commit" };
  }

  const expected = value.baseSha;
  const hasExpected = async () =>
    (await inTree(["cat-file", "-e", `${expected}^{commit}`])).code === 0;

  let landing: CloneLanding = "at_tip";
  let headSha = tipSha;
  let fallbackSha: string | null = null;
  if (tipSha !== expected) {
    let present = await hasExpected();
    if (!present) {
      // The clone's own `origin`, which never held the token; the token goes on
      // fd 3 as for the clone.
      await inTree(
        ["-c", "credential.helper=", "fetch", "--no-tags", "-q", "origin", expected],
        [value.token],
        FETCH_TIMEOUT_MS,
      );
      present = await hasExpected();
    }
    if (!present) {
      const revoke = await io.revoke(value.token);
      return { kind: "commit_missing", expected, branchTip: tipSha, tokenRevoked: revoke.ok };
    }
    const descends =
      value.ownBranch === true &&
      (await inTree(["merge-base", "--is-ancestor", expected, tipSha])).code === 0;
    if (descends) {
      // Someone pushed on top of the session's own branch: keep their commits.
      landing = "branch_ahead";
      fallbackSha = expected;
    } else {
      landing = value.ownBranch === true ? "branch_rewritten" : "base_moved";
      if (!(await checkoutCommit(target, expected, io))) {
        await io.revoke(value.token);
        return { kind: "verify_failed", detail: "could not check out the expected commit" };
      }
      headSha = expected;
    }
  }

  // The clone URL never carried the token, but a `git push` from inside the
  // tree must still fail locally.
  await inTree(["config", "remote.origin.pushurl", "/dev/null"]);

  const revoke = await io.revoke(value.token);
  return { kind: "cloned", headSha, tokenRevoked: revoke.ok, landing, fallbackSha };
}

/** Author and committer of every checkpoint and restore commit. Not a real mailbox, by design. */
export const CHECKPOINT_AUTHOR = { name: "OnCue", email: "checkpoint@oncue.invalid" } as const;
/** The commit message `applyRestore` writes on top of the clone. */
export const RESTORE_COMMIT_MESSAGE = "Restore the OnCue checkpoint bundle";

/**
 * The bridge's own git dir for checkpoint commands, under `scratchDir`. Git
 * reads config, hooks, and info files from `GIT_DIR`, so one inside the agent's
 * tree would run whatever the agent put there as the bridge.
 */
export function checkpointGitDir(scratchDir: string): string {
  return join(scratchDir, "git");
}

/**
 * Lays out `scratchDir` for the checkpoint commands. A lock an interrupted
 * checkpoint left on the private index is removed, since `read-tree` rebuilds
 * that index every time and a stale lock would fail every later checkpoint; the
 * diffs keep their own index and lock. False, never a throw, when it cannot.
 */
export async function prepareCheckpointScratch(
  scratchDir: string,
  staleLock = "index.lock",
): Promise<boolean> {
  try {
    await rm(join(scratchDir, staleLock), { force: true });
    await mkdir(join(scratchDir, "objects"), { recursive: true });
    await mkdir(join(checkpointGitDir(scratchDir), "refs"), { recursive: true });
    await writeFile(join(checkpointGitDir(scratchDir), "HEAD"), "ref: refs/heads/checkpoint\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * `gitEnv` plus the redirection that keeps a checkpoint out of the tree's
 * `.git`: git's own directory is `checkpointGitDir`, the index and new objects
 * go under `scratchDir`, and the tree's objects are read through the
 * alternates variable, which reads objects and nothing else. Global config is
 * off, and the author and committer are fixed here.
 */
export function checkpointEnv(
  io: Pick<GitIo, "env" | "askpassPath">,
  workTree: string,
  scratchDir: string,
): Readonly<Record<string, string>> {
  return {
    ...gitEnv(io),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_DIR: checkpointGitDir(scratchDir),
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: join(scratchDir, "index"),
    GIT_OBJECT_DIRECTORY: join(scratchDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(workTree, ".git", "objects"),
    GIT_AUTHOR_NAME: CHECKPOINT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: CHECKPOINT_AUTHOR.email,
    GIT_COMMITTER_NAME: CHECKPOINT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: CHECKPOINT_AUTHOR.email,
  };
}

/**
 * Hooks, a filesystem monitor, and a `HOME` attributes file turned off
 * explicitly: a second lock behind the bridge's `GIT_DIR` and disabled config.
 */
export const CHECKPOINT_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
];

/**
 * Checkpoint git argv. `safe.directory` is needed because the tree belongs to
 * another uid by the time a checkpoint runs.
 */
export function checkpointArgv(workTree: string, ...args: readonly string[]): readonly string[] {
  return ["git", "-c", `safe.directory=${workTree}`, ...CHECKPOINT_CONFIG, ...args];
}

export type SnapshotFailure =
  | "read_tree_failed"
  | "add_failed"
  | "write_tree_failed"
  | "parent_unreadable"
  | "commit_failed"
  | "timed_out";

export type SnapshotOutcome =
  /** The working tree is exactly the parent's tree; `sha` is the parent. */
  | { readonly kind: "unchanged"; readonly sha: string }
  | { readonly kind: "committed"; readonly sha: string }
  /** A fixed category, never git's own text: a path the agent chose could be in it. */
  | { readonly kind: "failed"; readonly detail: SnapshotFailure };

export interface SnapshotOptions {
  /** The private index's file name under `scratchDir`. A checkpoint uses `index`; the diffs keep their own. */
  readonly indexFile?: string;
  /**
   * Reuse the index the last snapshot on this same parent left, so unchanged
   * files are not hashed again. Only when that index was built on `parentSha`.
   */
  readonly reuseIndex?: boolean;
  /** A wall-clock bound over the whole snapshot. */
  readonly timeoutMs?: number;
}

/**
 * Commits the working tree parented on `parentSha`, using only the scratch
 * index and objects. The parent's tree is read into the index first so
 * `add -A` stages exactly what differs, deletions included and
 * tracked-but-ignored paths kept. The tree's `HEAD`, index, and refs are
 * untouched.
 */
export async function snapshot(
  workTree: string,
  scratchDir: string,
  parentSha: string,
  message: string,
  io: GitIo,
  options: SnapshotOptions = {},
): Promise<SnapshotOutcome> {
  const env = {
    ...checkpointEnv(io, workTree, scratchDir),
    GIT_INDEX_FILE: join(scratchDir, options.indexFile ?? "index"),
  };
  const deadline = deadlineOf(options.timeoutMs);
  const run = (...args: readonly string[]) =>
    io.runGit(
      checkpointArgv(workTree, ...args),
      { cwd: workTree, env, ...deadline.remaining() },
      null,
    );
  const failed = (result: GitProcessResult, detail: SnapshotFailure): SnapshotOutcome => ({
    kind: "failed",
    detail: result.timedOut === true || deadline.passed() ? "timed_out" : detail,
  });

  if (options.reuseIndex !== true) {
    const read = await run("read-tree", parentSha);
    if (read.code !== 0) {
      return failed(read, "read_tree_failed");
    }
  }
  const added = await run("add", "-A");
  if (added.code !== 0) {
    return failed(added, "add_failed");
  }
  const written = await run("write-tree");
  const tree = written.stdout.trim();
  if (written.code !== 0 || tree.length === 0) {
    return failed(written, "write_tree_failed");
  }
  const parentTree = await run("rev-parse", `${parentSha}^{tree}`);
  if (parentTree.code !== 0 || parentTree.stdout.trim().length === 0) {
    return failed(parentTree, "parent_unreadable");
  }
  if (parentTree.stdout.trim() === tree) {
    return { kind: "unchanged", sha: parentSha };
  }
  // Every message is cleaned here too, whoever wrote it: the last place
  // before Git, so no path can skip it (`commit-message.ts`).
  const committed = await run(
    "commit-tree",
    tree,
    "-p",
    parentSha,
    "-m",
    commitMessageOrFallback(message),
  );
  const sha = committed.stdout.trim();
  if (committed.code !== 0 || sha.length === 0) {
    return failed(committed, "commit_failed");
  }
  return { kind: "committed", sha };
}

export interface PushGrant {
  readonly token: string;
  readonly cloneUrl: string;
  /** What the object granted. `pushExact` refuses anything but `refs/heads/<session branch>`. */
  readonly ref: string;
}

/** A branch ref and nothing else: no `+`, no tag, no wildcard, no shell-ish character. */
export const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

/**
 * True only for exactly `refs/heads/<sessionBranch>` when git would accept that
 * ref; the equality and shape checks each miss something alone. Before the
 * first push names the branch, only the shape is checked, but the branch the
 * sandbox cloned (the base branch) is always refused, whatever the grant says.
 */
export function isExactSessionRef(
  ref: string,
  sessionBranch: string | null,
  cloneBranch: string | null = null,
): boolean {
  if (sessionBranch === null && cloneBranch !== null && ref === `refs/heads/${cloneBranch}`) {
    return false;
  }
  const expected = sessionBranch ?? ref.slice("refs/heads/".length);
  return (
    ref === `refs/heads/${expected}` &&
    REF_PATTERN.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith(".lock") &&
    !ref.endsWith("/")
  );
}

export type PushFailureReason =
  | "workflow_file_rejected"
  | "authentication_failed"
  | "rejected"
  | "network"
  | "unknown";

/** The fields of one `git push --porcelain` ref line: flag, `from:to`, and the summary with its reason. */
const PORCELAIN_REF_LINE = /^([ +\-*=!])\t[^\t]*\t(.*)$/;

/**
 * Like `classifyCloneFailure`: a category, never the text. `--porcelain`'s
 * stdout is read first and only for the summary of a refused ref (`!`), never
 * its `from:to` field, which holds the commit id and the branch name; stderr
 * is read with quoted strings removed. A commit id or a branch name that
 * happens to hold `403` or `network` changes nothing.
 */
export function classifyPushFailure(
  output: { readonly stdout: string; readonly stderr: string },
  timedOut = false,
): PushFailureReason {
  if (timedOut) {
    return "network";
  }
  const refused = output.stdout
    .split("\n")
    .map((line) => PORCELAIN_REF_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[1] === "!")
    .map((match) => (match[2] ?? "").toLowerCase());
  const lines = diagnosticLines(output.stderr);
  // The App has no `workflows` permission, so GitHub refuses a push touching
  // `.github/workflows` (record 07). Checked first, because GitHub words it as
  // a generic remote rejection and the run must report a blocked change.
  if (
    [...refused, ...lines].some(
      (text) => text.includes("refusing to allow") && text.includes("workflow"),
    )
  ) {
    return "workflow_file_rejected";
  }
  // A ref git itself refused: the remote answered, so this is never an
  // authentication or network failure.
  if (refused.some((summary) => summary.startsWith("[rejected]"))) {
    return "rejected";
  }
  const status = httpStatusOf(lines);
  if (
    status === 401 ||
    status === 403 ||
    anyLineHas(lines, AUTH_PHRASES) ||
    lines.some((line) => /^remote: permission to \S+ denied/.test(line))
  ) {
    return "authentication_failed";
  }
  if (
    refused.some((summary) => summary.startsWith("[remote rejected]")) ||
    anyLineHas(lines, [
      "non-fast-forward",
      "protected branch",
      "pre-receive hook declined",
      "[rejected]",
      "[remote rejected]",
      "updates were rejected",
    ])
  ) {
    return "rejected";
  }
  if (
    (status !== null && status >= 500) ||
    anyLineHas(lines, [...NETWORK_PHRASES, "could not read from remote repository"])
  ) {
    return "network";
  }
  return "unknown";
}

export type PushOutcome =
  | { readonly kind: "grant_spent" }
  /** Decided from the ref alone; no process was started and the token went nowhere. */
  | { readonly kind: "refused"; readonly reason: "ref_mismatch"; readonly tokenRevoked: boolean }
  | { readonly kind: "pushed"; readonly tokenRevoked: boolean }
  | {
      readonly kind: "push_failed";
      readonly reason: PushFailureReason;
      readonly tokenRevoked: boolean;
    };

/**
 * The push argv: the clone URL, never a remote name, and a plain refspec, never
 * `+`. Run under `checkpointEnv`, so no `pushInsteadOf` the agent wrote can
 * send the token elsewhere. Exported so a test can assert the token is in none
 * of it.
 */
export function pushArgv(
  workTree: string,
  cloneUrl: string,
  sha: string,
  ref: string,
): readonly string[] {
  return [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    `safe.directory=${workTree}`,
    ...CHECKPOINT_CONFIG,
    "push",
    "--porcelain",
    cloneUrl,
    `${sha}:${ref}`,
  ];
}

/**
 * Pushes `sha` to the grant's ref, which must be exactly the session branch,
 * with the token on fd 3 as in `clone`. The token is revoked on every path
 * that took it, refusal included, so a checkpoint never leaves one alive.
 */
export async function pushExact(
  grant: SingleUse<PushGrant>,
  sha: string,
  sessionBranch: string | null,
  workTree: string,
  scratchDir: string,
  io: GitIo,
  /** The branch the sandbox cloned; a grant naming it is refused while the session has no branch. */
  cloneBranch: string | null = null,
): Promise<PushOutcome> {
  const taken = grant.take();
  if (taken.kind === "spent") {
    return { kind: "grant_spent" };
  }
  const { value } = taken;
  if (!isExactSessionRef(value.ref, sessionBranch, cloneBranch)) {
    const revoke = await io.revoke(value.token);
    return { kind: "refused", reason: "ref_mismatch", tokenRevoked: revoke.ok };
  }
  const env = checkpointEnv(io, workTree, scratchDir);
  const result = await io.runGit(
    pushArgv(workTree, value.cloneUrl, sha, value.ref),
    { cwd: workTree, env, timeoutMs: PUSH_TIMEOUT_MS },
    [value.token],
  );
  const revoke = await io.revoke(value.token);
  if (result.code !== 0) {
    return {
      kind: "push_failed",
      reason: classifyPushFailure(result, result.timedOut === true),
      tokenRevoked: revoke.ok,
    };
  }
  return { kind: "pushed", tokenRevoked: revoke.ok };
}

export type PatchOutcome =
  | { readonly kind: "ok"; readonly patch: string }
  | { readonly kind: "failed" };

/**
 * The binary patch from `parentSha` to `sha` over the scratch objects, which
 * `applyRestore` replays on a fresh clone. No external diff or textconv runs.
 * A patch is useful only whole, so one that runs past `PATCH_TIMEOUT_MS` or
 * `PATCH_MAX_BYTES` is a failure, not a cut.
 */
export async function patchBetween(
  parentSha: string,
  sha: string,
  workTree: string,
  scratchDir: string,
  io: GitIo,
): Promise<PatchOutcome> {
  const env = checkpointEnv(io, workTree, scratchDir);
  const result = await io.runGit(
    checkpointArgv(workTree, "diff", "--no-ext-diff", "--no-textconv", "--binary", parentSha, sha),
    { cwd: workTree, env, timeoutMs: PATCH_TIMEOUT_MS, maxStdoutBytes: PATCH_MAX_BYTES },
    null,
  );
  if (result.code !== 0 || result.timedOut === true || result.stdoutTruncated === true) {
    return { kind: "failed" };
  }
  return { kind: "ok", patch: result.stdout };
}

/** How long one diff or status may take in all, and how much patch text it reads. */
export interface DiffBounds {
  readonly timeoutMs: number;
  readonly maxPatchBytes: number;
}

export const DIFF_BOUNDS: DiffBounds = { timeoutMs: 60_000, maxPatchBytes: 5 * 1024 * 1024 };

/** Past this a file listing is cut, and the entries it did hold are kept. */
export const MAX_LISTING_BYTES = 16 * 1024 * 1024;

interface Deadline {
  /** `{ timeoutMs }` for the next command, or nothing when unbounded. */
  remaining(): { readonly timeoutMs?: number };
  passed(): boolean;
}

function deadlineOf(timeoutMs: number | undefined): Deadline {
  if (timeoutMs === undefined) {
    return { remaining: () => ({}), passed: () => false };
  }
  const endsAt = Date.now() + timeoutMs;
  return {
    remaining: () => ({ timeoutMs: Math.max(1, endsAt - Date.now()) }),
    passed: () => Date.now() >= endsAt,
  };
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChangeEntry {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly previousPath?: string;
  /** Zero for a binary file, whose lines git does not count. */
  readonly additions: number;
  readonly deletions: number;
}

type ListedChange = Omit<FileChangeEntry, "additions" | "deletions">;

/**
 * Parses `git diff --name-status -z`. A copy is reported as added and a type
 * change as modified. A record cut short at the end of the output is dropped.
 */
export function parseNameStatusZ(output: string): readonly ListedChange[] {
  const tokens = output.split("\0");
  const entries: ListedChange[] = [];
  let index = 0;
  while (index < tokens.length - 1) {
    const letter = (tokens[index] ?? "").charAt(0);
    const width = letter === "R" || letter === "C" ? 3 : 2;
    if (letter === "" || index + width > tokens.length - 1) {
      break;
    }
    const first = tokens[index + 1] ?? "";
    const second = tokens[index + 2] ?? "";
    if (letter === "R") {
      entries.push({ path: second, status: "renamed", previousPath: first });
    } else if (letter === "C") {
      entries.push({ path: second, status: "added" });
    } else {
      entries.push({
        path: first,
        status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
      });
    }
    index += width;
  }
  return entries;
}

/**
 * Parses `git diff --numstat -z`, keyed by the new path. A binary file's `-`
 * counts as zero, and a record cut short at the end is dropped.
 */
export function parseNumstatZ(
  output: string,
): ReadonlyMap<string, { readonly additions: number; readonly deletions: number }> {
  const tokens = output.split("\0");
  const counts = new Map<string, { additions: number; deletions: number }>();
  const count = (raw: string | undefined) => {
    const value = raw === undefined || raw === "-" ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  let index = 0;
  while (index < tokens.length - 1) {
    const parts = (tokens[index] ?? "").split("\t");
    if (parts.length < 3) {
      break;
    }
    const inline = parts.slice(2).join("\t");
    const width = inline.length > 0 ? 1 : 3;
    if (index + width > tokens.length - 1) {
      break;
    }
    const path = inline.length > 0 ? inline : (tokens[index + 2] ?? "");
    counts.set(path, { additions: count(parts[0]), deletions: count(parts[1]) });
    index += width;
  }
  return counts;
}

function totalsOf(
  counts: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
) {
  let additions = 0;
  let deletions = 0;
  for (const entry of counts.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { additions, deletions };
}

export type DiffFailure = "timed_out" | "listing_failed" | "counts_failed" | "patch_failed";

export type DiffOutcome =
  | {
      readonly kind: "ok";
      readonly baseSha: string;
      readonly headSha: string;
      /** Every changed file git listed, in its order; cut only when the listing itself was. */
      readonly files: readonly FileChangeEntry[];
      /** Over every counted file. */
      readonly additions: number;
      readonly deletions: number;
      readonly patch: string;
      /** The patch reached `maxPatchBytes` or a listing reached `MAX_LISTING_BYTES`, and what is here is the start of it. */
      readonly truncated: boolean;
    }
  /** A fixed category, never git's own text: a path the agent chose could be in it. */
  | { readonly kind: "failed"; readonly detail: DiffFailure };

/** No external diff program, no textconv filter, no color, and renames found. */
const DIFF_FLAGS: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

export const MAX_TREE_PATHS = 20_000;
const MAX_TREE_BYTES = 4 * 1024 * 1024;

/**
 * Every path in the tree at `sha`, for the review's file tree, read through the
 * bridge's own git dir so the agent's tree is never touched. Null when git could
 * not list it; the diff still goes without a tree.
 */
export async function listTreePaths(
  sha: string,
  workTree: string,
  scratchDir: string,
  io: GitIo,
  timeoutMs?: number,
): Promise<readonly string[] | null> {
  const env = checkpointEnv(io, workTree, scratchDir);
  const deadline = deadlineOf(timeoutMs);
  const result = await io.runGit(
    checkpointArgv(
      workTree,
      "-c",
      "core.quotePath=false",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      sha,
    ),
    { cwd: workTree, env, maxStdoutBytes: MAX_TREE_BYTES, ...deadline.remaining() },
    null,
  );
  if (result.code !== 0 || result.timedOut === true) {
    return null;
  }
  return result.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .slice(0, MAX_TREE_PATHS);
}

/**
 * Each changed file with its status and line counts, and the unified patch,
 * between two commits. Runs in the scratch environment, so no config, hook,
 * attribute driver, or index of the agent's takes part. Past the time bound it
 * fails `timed_out`; past the patch size it keeps what it read and says
 * `truncated`.
 */
export async function diffBetween(
  baseSha: string,
  headSha: string,
  workTree: string,
  scratchDir: string,
  io: GitIo,
  bounds: DiffBounds = DIFF_BOUNDS,
): Promise<DiffOutcome> {
  const env = checkpointEnv(io, workTree, scratchDir);
  const deadline = deadlineOf(bounds.timeoutMs);
  const run = (maxStdoutBytes: number, ...args: readonly string[]) =>
    io.runGit(
      checkpointArgv(workTree, "-c", "core.quotePath=false", "diff", ...DIFF_FLAGS, ...args),
      { cwd: workTree, env, maxStdoutBytes, ...deadline.remaining() },
      null,
    );
  const failed = (result: GitProcessResult, detail: DiffFailure): DiffOutcome => ({
    kind: "failed",
    detail: result.timedOut === true || deadline.passed() ? "timed_out" : detail,
  });
  const settled = (result: GitProcessResult) =>
    result.code === 0 || (result.stdoutTruncated === true && result.timedOut !== true);

  const listing = await run(MAX_LISTING_BYTES, "--name-status", "-z", baseSha, headSha);
  if (!settled(listing)) {
    return failed(listing, "listing_failed");
  }
  const numstat = await run(MAX_LISTING_BYTES, "--numstat", "-z", baseSha, headSha);
  if (!settled(numstat)) {
    return failed(numstat, "counts_failed");
  }
  const patch = await run(bounds.maxPatchBytes, baseSha, headSha);
  if (!settled(patch)) {
    return failed(patch, "patch_failed");
  }

  const counts = parseNumstatZ(numstat.stdout);
  const files = parseNameStatusZ(listing.stdout).map(
    (entry): FileChangeEntry => ({
      ...entry,
      additions: counts.get(entry.path)?.additions ?? 0,
      deletions: counts.get(entry.path)?.deletions ?? 0,
    }),
  );
  return {
    kind: "ok",
    baseSha,
    headSha,
    files,
    ...totalsOf(counts),
    patch: patch.stdout,
    truncated:
      patch.stdoutTruncated === true ||
      listing.stdoutTruncated === true ||
      numstat.stdoutTruncated === true,
  };
}

export interface StatusRefs {
  readonly branch: string;
  /** The session's recorded base. */
  readonly baseSha: string;
  /** The last durable head, which the snapshot was parented on. */
  readonly parentSha: string;
  /** The snapshot of the working tree, or `parentSha` when nothing differed. */
  readonly headSha: string;
}

/** `repository.status`'s payload. */
export interface RepositoryStatusPayload {
  readonly branch: string;
  readonly headSha: string;
  readonly baseSha: string;
  /** Commits from the base to the snapshot. */
  readonly ahead: number;
  /** The bridge never fetches after the clone, so nothing is known to be behind. */
  readonly behind: number;
  /** The working tree differs from the last durable head. */
  readonly dirty: boolean;
  readonly changedFileCount: number;
  /** Paths the working tree has that the last durable head does not. */
  readonly untrackedFileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export type StatusFailure = "timed_out" | "count_failed" | "tree_failed" | "diff_failed";

export type StatusOutcome =
  | { readonly kind: "ok"; readonly status: RepositoryStatusPayload }
  | { readonly kind: "failed"; readonly detail: StatusFailure };

/**
 * `repository.status` for a snapshot, against the recorded base and the last
 * durable head. Runs in the scratch environment, reads commits only.
 */
export async function status(
  workTree: string,
  scratchDir: string,
  refs: StatusRefs,
  io: GitIo,
  timeoutMs: number = DIFF_BOUNDS.timeoutMs,
): Promise<StatusOutcome> {
  const env = checkpointEnv(io, workTree, scratchDir);
  const deadline = deadlineOf(timeoutMs);
  const run = (...args: readonly string[]) =>
    io.runGit(
      checkpointArgv(workTree, ...args),
      { cwd: workTree, env, maxStdoutBytes: MAX_LISTING_BYTES, ...deadline.remaining() },
      null,
    );
  const failed = (result: GitProcessResult, detail: StatusFailure): StatusOutcome => ({
    kind: "failed",
    detail: result.timedOut === true || deadline.passed() ? "timed_out" : detail,
  });

  const counted = await run("rev-list", "--count", `${refs.baseSha}..${refs.headSha}`);
  const ahead = Number.parseInt(counted.stdout.trim(), 10);
  if (counted.code !== 0 || !Number.isFinite(ahead)) {
    return failed(counted, "count_failed");
  }
  const trees = await run("rev-parse", `${refs.parentSha}^{tree}`, `${refs.headSha}^{tree}`);
  const [parentTree, headTree] = trees.stdout.trim().split("\n");
  if (trees.code !== 0 || parentTree === undefined || headTree === undefined) {
    return failed(trees, "tree_failed");
  }
  const numstat = await run("diff", ...DIFF_FLAGS, "--numstat", "-z", refs.baseSha, refs.headSha);
  if (numstat.code !== 0) {
    return failed(numstat, "diff_failed");
  }
  const added = await run(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
    "--diff-filter=A",
    refs.parentSha,
    refs.headSha,
  );
  if (added.code !== 0) {
    return failed(added, "diff_failed");
  }
  const counts = parseNumstatZ(numstat.stdout);
  return {
    kind: "ok",
    status: {
      branch: refs.branch,
      headSha: refs.headSha,
      baseSha: refs.baseSha,
      ahead,
      behind: 0,
      dirty: parentTree !== headTree,
      changedFileCount: counts.size,
      untrackedFileCount: added.stdout.split("\0").filter((path) => path.length > 0).length,
      ...totalsOf(counts),
    },
  };
}

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly headSha: string }
  | { readonly kind: "failed"; readonly detail: "apply_failed" | "commit_failed" | "no_head" };

/**
 * Applies a patch bundle to the fresh clone and commits it as the tree's owner:
 * the one git write into the work tree, before `chown_workspace` hands it over.
 * The restored commit is local; the durable head stays the clone's.
 */
export async function applyRestore(
  workTree: string,
  patchPath: string,
  io: GitIo,
): Promise<RestoreOutcome> {
  const env = gitEnv(io);
  const run = (argv: readonly string[]) => io.runGit(argv, { cwd: workTree, env }, null);

  const applied = await run(checkpointArgv(workTree, "apply", "--index", patchPath));
  if (applied.code !== 0) {
    return { kind: "failed", detail: "apply_failed" };
  }
  const committed = await run(
    checkpointArgv(
      workTree,
      "-c",
      `user.name=${CHECKPOINT_AUTHOR.name}`,
      "-c",
      `user.email=${CHECKPOINT_AUTHOR.email}`,
      "commit",
      "-q",
      "-m",
      RESTORE_COMMIT_MESSAGE,
    ),
  );
  if (committed.code !== 0) {
    return { kind: "failed", detail: "commit_failed" };
  }
  const head = await run(checkpointArgv(workTree, "rev-parse", "HEAD"));
  const headSha = head.stdout.trim();
  if (head.code !== 0 || headSha.length === 0) {
    return { kind: "failed", detail: "no_head" };
  }
  return { kind: "restored", headSha };
}

export type BaseCheckoutOutcome =
  | { readonly kind: "checked_out" }
  | { readonly kind: "failed"; readonly detail: "read_tree_failed" | "checkout_failed" };

/**
 * Writes the tree of `sha` into a directory the bridge just made, for the base
 * comparison. Runs in the scratch environment with its own index, so none of
 * the agent's index, config, hooks, or attributes take part.
 */
export async function checkoutBase(
  workTree: string,
  scratchDir: string,
  targetDir: string,
  sha: string,
  io: GitIo,
): Promise<BaseCheckoutOutcome> {
  const env = {
    ...checkpointEnv(io, workTree, scratchDir),
    GIT_WORK_TREE: targetDir,
    GIT_INDEX_FILE: join(scratchDir, "base-index"),
  };
  const run = (...args: readonly string[]) =>
    io.runGit(
      ["git", "-c", `safe.directory=${targetDir}`, ...CHECKPOINT_CONFIG, ...args],
      { cwd: targetDir, env },
      null,
    );
  if ((await run("read-tree", sha)).code !== 0) {
    return { kind: "failed", detail: "read_tree_failed" };
  }
  if ((await run("checkout-index", "--all", "--force")).code !== 0) {
    return { kind: "failed", detail: "checkout_failed" };
  }
  return { kind: "checked_out" };
}
