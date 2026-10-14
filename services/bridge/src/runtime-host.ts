/**
 * The runtime host (record 02). The supervisor starts the agent with inherited
 * stdio, so the bridge can never read its pipes; a harness that talks over
 * stdin and stdout (Codex's app-server, Pi's RPC mode) runs under this program
 * instead, which the supervisor starts as the agent user and which serves the
 * child's stdin and stdout on one loopback TCP port.
 *
 * It holds no credential, so it sits on the agent's side of the Unix-user
 * boundary, as OpenCode's own server does. It serves one client at a time and,
 * while nobody is attached, keeps the child's output up to a bound and then
 * stops reading it until a client attaches. It exits with the child and forwards SIGTERM and SIGINT to it; a
 * SIGKILL closes the child's stdin, which the stdio harnesses treat as end of
 * input.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Server, Socket } from "node:net";

/** While nobody is attached, the child's output is kept up to this many bytes, then the child waits. */
export const DETACHED_BUFFER_BYTES = 1024 * 1024;
/** After a forwarded SIGTERM, how long before the child is killed outright. */
export const CHILD_STOP_GRACE_MS = 5_000;

export interface RuntimeHostArgs {
  readonly port: number;
  readonly command: string;
  readonly args: readonly string[];
}

/** `--port N -- <binary> [args...]`, exactly; anything else is `null`. */
export function parseRuntimeHostArgs(argv: readonly string[]): RuntimeHostArgs | null {
  const [flag, portText, separator, command, ...args] = argv;
  if (flag !== "--port" || separator !== "--" || command === undefined || command.length === 0) {
    return null;
  }
  if (portText === undefined || !/^[1-9][0-9]{0,4}$/.test(portText)) {
    return null;
  }
  const port = Number(portText);
  return port > 65_535 ? null : { port, command, args };
}

/**
 * The child's output while nobody is attached, kept whole and in order. Past
 * `limit` bytes it reports `full`, and the host stops reading the child, whose
 * writes then wait on the pipe: nothing is dropped, because a lost line can be
 * a JSON-RPC reply a turn waits on forever.
 */
export class DetachedBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number = DETACHED_BUFFER_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  get full(): boolean {
    return this.bytes >= this.limit;
  }

  /** Everything kept, in order; the buffer is empty after. */
  take(): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    return all;
  }
}

export interface RuntimeHostDeps {
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly createServer: (onConnection: (socket: Socket) => void) => Server;
  readonly log: (line: string) => void;
  readonly setTimer: (run: () => void, ms: number) => void;
}

export interface RuntimeHost {
  /** Resolves with the exit code the host should exit with: the child's, or 128 plus its signal's number. */
  readonly exited: Promise<number>;
  /** Forwards a signal to the child, and kills it after the grace if it was a SIGTERM that did not end it. */
  signal(signal: "SIGTERM" | "SIGINT"): void;
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export function startRuntimeHost(args: RuntimeHostArgs, deps: RuntimeHostDeps): RuntimeHost {
  const child = deps.spawn(args.command, args.args, { stdio: ["pipe", "pipe", "inherit"] });
  const detached = new DetachedBuffer();
  let client: Socket | null = null;
  let childExited = false;

  const server = deps.createServer((socket) => {
    if (client !== null || childExited) {
      socket.destroy();
      return;
    }
    client = socket;
    const held = detached.take();
    if (held.length > 0) {
      socket.write(held);
    }
    // Reading resumes once there is someone to hand the output to.
    child.stdout?.resume();
    socket.on("data", (data: Buffer) => {
      child.stdin?.write(data);
    });
    const detach = (): void => {
      if (client === socket) {
        client = null;
      }
    };
    socket.on("close", detach);
    socket.on("error", detach);
  });
  server.listen(args.port, "127.0.0.1");

  child.stdout?.on("data", (data: Buffer) => {
    if (client !== null) {
      client.write(data);
      return;
    }
    detached.push(data);
    if (detached.full) {
      deps.log("runtime host: output held for the bridge is full; waiting for it to attach");
      child.stdout?.pause();
    }
  });
  // A child that stops reading its stdin must not take the host down with EPIPE.
  child.stdin?.on("error", () => {});

  const exited = new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (childExited) {
        return;
      }
      childExited = true;
      server.close();
      client?.end();
      resolve(code);
    };
    child.once("exit", (code, signal) => {
      finish(code ?? 128 + (signal === null ? 0 : (SIGNAL_NUMBERS[signal] ?? 0)));
    });
    child.once("error", (error: Error) => {
      deps.log(`runtime host: could not start ${args.command}: ${error.message}`);
      finish(127);
    });
  });

  return {
    exited,
    signal(signal) {
      if (childExited) {
        return;
      }
      child.kill(signal);
      if (signal === "SIGTERM") {
        deps.setTimer(() => {
          if (!childExited) {
            child.kill("SIGKILL");
          }
        }, CHILD_STOP_GRACE_MS);
      }
    },
  };
}
