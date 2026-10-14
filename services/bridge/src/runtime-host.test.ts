import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_STOP_GRACE_MS,
  DetachedBuffer,
  parseRuntimeHostArgs,
  type RuntimeHostDeps,
  startRuntimeHost,
} from "./runtime-host";

describe("parseRuntimeHostArgs", () => {
  it("takes exactly --port N -- binary [args]", () => {
    expect(parseRuntimeHostArgs(["--port", "4100", "--", "/opt/x/x", "app-server"])).toEqual({
      port: 4100,
      command: "/opt/x/x",
      args: ["app-server"],
    });
  });

  it.each([
    [[]],
    [["--port", "4100", "/opt/x/x"]],
    [["--port", "0", "--", "/opt/x/x"]],
    [["--port", "65536", "--", "/opt/x/x"]],
    [["--port", "4100x", "--", "/opt/x/x"]],
    [["--port", "4100", "--", ""]],
    [["--port", "4100", "--"]],
    [["--listen", "4100", "--", "/opt/x/x"]],
  ])("refuses %j", (argv) => {
    expect(parseRuntimeHostArgs(argv)).toBeNull();
  });
});

describe("DetachedBuffer", () => {
  it("keeps whole lines in order, and a partial line until it ends", () => {
    const buffer = new DetachedBuffer(100);
    buffer.push(Buffer.from('{"a":1}\n{"b"'));
    buffer.push(Buffer.from(':2}\n{"c"'));
    expect(buffer.take().toString()).toBe('{"a":1}\n{"b":2}\n{"c"');
    expect(buffer.take().length).toBe(0);
  });

  it("keeps everything past the bound, and says it is full so the host stops reading", () => {
    const buffer = new DetachedBuffer(10);
    buffer.push(Buffer.from("12345\n"));
    expect(buffer.full).toBe(false);
    buffer.push(Buffer.from("67890\nabc\n"));
    expect(buffer.full).toBe(true);
    expect(buffer.take().toString()).toBe("12345\n67890\nabc\n");
    expect(buffer.full).toBe(false);
  });
});

/** A child with real streams and an exit the test controls. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kills: string[] = [];
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

function fakeDeps(child: FakeChild) {
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  let onConnection: ((socket: Socket) => void) | null = null;
  const server = new EventEmitter() as unknown as Server & { closed: boolean; port: number | null };
  Object.assign(server, {
    closed: false,
    port: null,
    listen(port: number) {
      server.port = port;
      return server;
    },
    close() {
      server.closed = true;
      return server;
    },
  });
  const deps: RuntimeHostDeps = {
    spawn: () => child as unknown as ChildProcess,
    createServer: (handler) => {
      onConnection = handler;
      return server;
    },
    log: (line) => logs.push(line),
    setTimer: (run) => {
      timers.push(run);
    },
  };
  const attach = (): {
    socket: Socket;
    written: string[];
    destroyed: () => boolean;
    ended: () => boolean;
  } => {
    const written: string[] = [];
    let destroyed = false;
    let ended = false;
    const socket = new EventEmitter() as unknown as Socket;
    Object.assign(socket, {
      write(data: Buffer) {
        written.push(data.toString());
        return true;
      },
      destroy() {
        destroyed = true;
      },
      end() {
        ended = true;
      },
    });
    onConnection?.(socket);
    return { socket, written, destroyed: () => destroyed, ended: () => ended };
  };
  return { deps, logs, timers, server, attach };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("startRuntimeHost", () => {
  it("relays the attached client's bytes to the child and the child's output back", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    expect(world.server.port).toBe(4100);
    const client = world.attach();
    const received: string[] = [];
    child.stdin.on("data", (data: Buffer) => received.push(data.toString()));
    client.socket.emit("data", Buffer.from('{"method":"initialize"}\n'));
    child.stdout.write('{"result":{}}\n');
    await flush();
    expect(received).toEqual(['{"method":"initialize"}\n']);
    expect(client.written).toEqual(['{"result":{}}\n']);
  });

  it("serves one client at a time, and keeps output for the next while nobody is attached", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    const first = world.attach();
    const second = world.attach();
    expect(second.destroyed()).toBe(true);
    first.socket.emit("close");
    child.stdout.write("kept 1\nkept 2\n");
    await flush();
    const third = world.attach();
    expect(third.written).toEqual(["kept 1\nkept 2\n"]);
    third.socket.emit("error", new Error("reset"));
    world.attach();
  });

  it("stops reading the child once the held output is full, loses no line, and reads again when a client attaches", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    const big = `${"x".repeat(1024 * 1024)}\n`;
    child.stdout.write(big);
    await flush();
    expect(child.stdout.isPaused()).toBe(true);
    expect(world.logs).toEqual([
      "runtime host: output held for the bridge is full; waiting for it to attach",
    ]);
    // The reply a turn waits on, written while nobody reads, is not lost.
    child.stdout.write('{"id":7,"result":{}}\n');
    await flush();
    const client = world.attach();
    await flush();
    expect(child.stdout.isPaused()).toBe(false);
    expect(client.written.join("")).toBe(`${big}{"id":7,"result":{}}\n`);
  });

  it("exits with the child's code, closes the port, and ends the client", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    const client = world.attach();
    child.emit("exit", 3, null);
    child.emit("exit", 4, null);
    await expect(host.exited).resolves.toBe(3);
    expect(world.server.closed).toBe(true);
    expect(client.ended()).toBe(true);
    // Once the child is gone nobody can attach, and a signal goes nowhere.
    expect(world.attach().destroyed()).toBe(true);
    host.signal("SIGTERM");
    expect(child.kills).toEqual([]);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGKILL", 137],
    ["SIGHUP", 128],
  ])("exits 128 plus the signal's number when the child dies of %s", async (signal, code) => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    child.emit("exit", null, signal);
    await expect(host.exited).resolves.toBe(code);
  });

  it("exits 128 when the child reports neither a code nor a signal", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    child.emit("exit", null, null);
    await expect(host.exited).resolves.toBe(128);
  });

  it("exits 127 and says so when the child cannot be started", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    child.emit("error", new Error("ENOENT"));
    await expect(host.exited).resolves.toBe(127);
    expect(world.logs).toEqual(["runtime host: could not start /opt/x/x: ENOENT"]);
  });

  it("forwards SIGTERM, and kills the child after the grace if it is still there", () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    host.signal("SIGINT");
    host.signal("SIGTERM");
    expect(child.kills).toEqual(["SIGINT", "SIGTERM"]);
    expect(world.timers).toHaveLength(1);
    world.timers[0]?.();
    expect(child.kills).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(CHILD_STOP_GRACE_MS).toBe(5_000);
  });

  it("does not kill a child that ended within the grace", () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    const host = startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    host.signal("SIGTERM");
    child.emit("exit", 0, null);
    world.timers[0]?.();
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("survives a child that stops reading its stdin", async () => {
    const child = new FakeChild();
    const world = fakeDeps(child);
    startRuntimeHost({ port: 4100, command: "/opt/x/x", args: [] }, world.deps);
    child.stdin.emit("error", new Error("EPIPE"));
    await flush();
  });
});

/**
 * The real entry point, as the image runs it: `runtime-host-main.ts` under
 * Node, a real child (a line echo), and a real loopback socket.
 */
describe("runtime-host-main against a real child", () => {
  const started: ChildProcess[] = [];
  afterEach(() => {
    for (const process of started.splice(0)) {
      process.kill("SIGKILL");
    }
  });

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  async function connectWhenListening(port: number): Promise<Socket> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connect(port, "127.0.0.1", () => resolve(socket));
          socket.once("error", reject);
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("the runtime host never listened");
  }

  it("relays a line both ways and exits with the child's code when the child ends", async () => {
    const port = await freePort();
    const main = fileURLToPath(new URL("./runtime-host-main.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    // The harness: echoes each line upper-cased, and exits 7 on "bye".
    const echo = [
      "process.stdin.setEncoding('utf8');",
      "let rest = '';",
      "process.stdin.on('data', (d) => { rest += d; let i;",
      " while ((i = rest.indexOf('\\n')) !== -1) { const line = rest.slice(0, i); rest = rest.slice(i + 1);",
      " if (line === 'bye') process.exit(7); process.stdout.write(line.toUpperCase() + '\\n'); } });",
    ].join("");
    const host = spawn(tsx, [main, "--port", String(port), "--", process.execPath, "-e", echo], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    started.push(host);
    const exited = new Promise<number | null>((resolve) =>
      host.once("exit", (code) => resolve(code)),
    );

    const socket = await connectWhenListening(port);
    const answer = new Promise<string>((resolve) =>
      socket.once("data", (data: Buffer) => resolve(data.toString())),
    );
    socket.write("hello harness\n");
    expect(await answer).toBe("HELLO HARNESS\n");
    socket.write("bye\n");
    expect(await exited).toBe(7);
  }, 30_000);

  it("refuses arguments it does not understand", async () => {
    const main = fileURLToPath(new URL("./runtime-host-main.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const host = spawn(tsx, [main, "--port", "nope"], { stdio: "ignore" });
    started.push(host);
    const code = await new Promise<number | null>((resolve) =>
      host.once("exit", (exitCode) => resolve(exitCode)),
    );
    expect(code).toBe(64);
  }, 30_000);
});
