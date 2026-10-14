/**
 * One verification check as a process, shared by the root supervisor and the
 * dev host's stand-in so the two cannot drift. The check runs in its own
 * process group, so a timeout or cancel reaches everything it started. Its
 * output goes through pipes this process copies into the file, not a
 * descriptor handed down, so a background process the check leaves behind
 * cannot rewrite the finished log.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { closeSync, constants, fchownSync, openSync, writeSync } from "node:fs";
import type { CheckExit } from "./supervisor-protocol";

export type CheckSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CheckProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputPath: string;
  /** Who the output file belongs to. Null leaves it with this process's own user. */
  readonly outputOwner: { readonly uid: number; readonly gid: number } | null;
  readonly maxOutputBytes: number;
}

export interface CheckProcess {
  readonly pid: number;
  readonly exit: Promise<CheckExit>;
  /** Signals the whole group. Throws when the group is already gone. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

/** After the check's own process exits, how long its pipes may stay open before they are cut. */
export const PIPE_DRAIN_MS = 2_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/**
 * Creates the output file (never an existing one, never through a symlink),
 * starts the check, and resolves once it has ended and its output is flushed.
 * Throws when the file cannot be created or the process cannot start.
 */
export function startCheckProcess(
  spawnImpl: CheckSpawn,
  options: CheckProcessOptions,
  now: () => number = Date.now,
): CheckProcess {
  const fd = openSync(
    options.outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let child: ChildProcess;
  try {
    if (options.outputOwner !== null) {
      fchownSync(fd, options.outputOwner.uid, options.outputOwner.gid);
    }
    child = spawnImpl(options.command, options.args, {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const pid = child.pid;
  if (pid === undefined) {
    child.once("error", () => {});
    closeSync(fd);
    throw new Error("could not start the check");
  }
  const startedAt = now();
  let written = 0;
  let truncated = false;
  let timedOut = false;
  let open = true;

  const copy = (chunk: Buffer): void => {
    if (!open) {
      return;
    }
    const room = options.maxOutputBytes - written;
    if (chunk.byteLength > room) {
      truncated = true;
    }
    const kept = chunk.byteLength > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
    if (kept.byteLength > 0) {
      writeSync(fd, kept);
      written += kept.byteLength;
    }
  };
  child.stdout?.on("data", copy);
  child.stderr?.on("data", copy);

  const exit = new Promise<CheckExit>((resolve) => {
    let code: number | null = null;
    let signal: string | null = null;
    let drain: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killGroup(pid, "SIGKILL");
      } catch {
        // Already gone: the exit below is on its way.
      }
    }, options.timeoutMs);

    const finish = (): void => {
      if (!open) {
        return;
      }
      open = false;
      clearTimeout(timer);
      if (drain !== null) {
        clearTimeout(drain);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      closeSync(fd);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        durationMs: Math.max(0, now() - startedAt),
        outputBytes: written,
        truncated,
      });
    };

    child.once("exit", (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      code = exitCode;
      signal = exitSignal;
      clearTimeout(timer);
      // Whatever the check left running in its group goes with it, which is
      // also what lets its pipes close.
      try {
        killGroup(pid, "SIGKILL");
      } catch {
        // The group is already empty.
      }
      drain = setTimeout(finish, PIPE_DRAIN_MS);
    });
    child.once("close", finish);
    child.once("error", finish);
  });

  return {
    pid,
    exit,
    kill(signal) {
      killGroup(pid, signal);
    },
  };
}
