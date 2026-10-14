/**
 * The sandbox bridge's entry point and control connection (record 02). The
 * bridge dials the session object outbound, so the sandbox has no listening
 * surface and record 09's egress policy can be a domain allowlist; the cost is
 * that reconnection is the bridge's job.
 *
 * Every decision lives in pure functions in `./protocol`, so `main.test.ts`
 * drives the same code a sandbox runs without a socket or clock, and the
 * Worker can import it without this file's Node-only I/O.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { agentIo, type RuntimeOverrides } from "./agent-io";
import { createLocalSupervisor } from "./local-supervisor";
import {
  type BridgeConfig,
  type BridgeIo,
  type BridgeLink,
  bridgeConfig,
  UNSTAMPED_BRIDGE_VERSION,
} from "./protocol";
import type { SupervisorClient } from "./supervisor-client";

export * from "./protocol";

/** Where `images.py`'s entrypoint leaves the credential, readable by this uid only. */
export const DEFAULT_BOOTSTRAP_FILE = "/opt/oncue/bootstrap";

export interface BridgeEnvironment {
  readonly ONCUE_SESSION_ID?: string | undefined;
  readonly ONCUE_SANDBOX_GENERATION?: string | undefined;
  readonly ONCUE_CONTROL_PLANE_ORIGIN?: string | undefined;
  readonly ONCUE_BOOTSTRAP_FILE?: string | undefined;
}

/**
 * The commit this bundle was built from, a literal stamped by `build.ts`.
 * Undefined from source and under tests, where the bridge reports itself as
 * unstamped.
 */
declare const __ONCUE_BRIDGE_VERSION__: string | undefined;

export function bridgeVersion(): string {
  return typeof __ONCUE_BRIDGE_VERSION__ === "string"
    ? __ONCUE_BRIDGE_VERSION__
    : UNSTAMPED_BRIDGE_VERSION;
}

export type StartupPlan =
  | { readonly kind: "ready"; readonly config: BridgeConfig }
  | { readonly kind: "misconfigured"; readonly missing: readonly string[] };

/**
 * Reads the session's identity from the environment and the credential from a
 * file. The credential is never an environment variable, because every child
 * process inherits the environment and the agent is a child process.
 */
export function planStartup(
  env: BridgeEnvironment,
  readCredential: (path: string) => string,
  version: string = UNSTAMPED_BRIDGE_VERSION,
): StartupPlan {
  const missing: string[] = [];
  const sessionId = env.ONCUE_SESSION_ID;
  if (sessionId === undefined) {
    missing.push("ONCUE_SESSION_ID");
  }
  const generation = env.ONCUE_SANDBOX_GENERATION;
  if (generation === undefined) {
    missing.push("ONCUE_SANDBOX_GENERATION");
  }
  const origin = env.ONCUE_CONTROL_PLANE_ORIGIN;
  if (origin === undefined) {
    missing.push("ONCUE_CONTROL_PLANE_ORIGIN");
  }
  if (sessionId === undefined || generation === undefined || origin === undefined) {
    return { kind: "misconfigured", missing };
  }
  const credential = readCredential(env.ONCUE_BOOTSTRAP_FILE ?? DEFAULT_BOOTSTRAP_FILE);
  if (credential.length === 0) {
    return { kind: "misconfigured", missing: ["bootstrap credential"] };
  }
  return {
    kind: "ready",
    config: bridgeConfig(
      { sessionId, generation: Number(generation), bootstrapCredential: credential },
      origin,
      { bridgeVersion: version },
    ),
  };
}

/** How long the WebSocket upgrade may take before the attempt counts as a dropped one. */
export const HANDSHAKE_TIMEOUT_MS = 20_000;

export function nodeBridgeIo(): BridgeIo {
  return {
    connect(url, headers) {
      return new Promise<BridgeLink>((resolve, reject) => {
        const socket = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
        socket.once("open", () => {
          // An error after the open is followed by `close`, which ends the
          // link; without a listener it would end the process instead.
          socket.on("error", () => {});
          resolve({
            send: (text) => socket.send(text),
            close: () => socket.close(),
            terminate: () => socket.terminate(),
            ping: () => socket.ping(),
            onPong: (listener) => socket.on("pong", () => listener()),
            onMessage: (listener) => socket.on("message", (data) => listener(String(data))),
            onClose: (listener) => socket.once("close", (code: number) => listener(code)),
          });
        });
        socket.once("error", reject);
      });
    },
    startHeartbeat(intervalMs, tick) {
      const handle = setInterval(tick, intervalMs);
      return () => clearInterval(handle);
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    log(line) {
      process.stdout.write(`${line}\n`);
    },
    newEventId() {
      return randomUUID();
    },
    now() {
      return new Date().toISOString();
    },
    nowMs() {
      return Date.now();
    },
    random() {
      return Math.random();
    },
  };
}

export interface DevSupervisorEnv {
  readonly ONCUE_DEV_SUPERVISOR?: string | undefined;
  readonly ONCUE_DEV_OPENCODE_BIN?: string | undefined;
  readonly ONCUE_DEV_WORKSPACE?: string | undefined;
  /**
   * Optional: the port the harness serves on, whichever harness the session
   * runs. Several bridges share the dev host, from one stack or several, so
   * the image's fixed per-harness ports would collide; the controller double
   * picks a free one, and `resolveDevSupervisorPlan` picks one when unset.
   */
  readonly ONCUE_DEV_RUNTIME_PORT?: string | undefined;
  /** Optional: a `codex` binary on this machine, for a session whose harness is Codex. */
  readonly ONCUE_DEV_CODEX_BIN?: string | undefined;
  /** Optional: a `pi` command on this machine, for a session whose harness is Pi. */
  readonly ONCUE_DEV_PI_BIN?: string | undefined;
  /** Optional: a `claude` binary on this machine, for a session whose harness is Claude Code. */
  readonly ONCUE_DEV_CLAUDE_BIN?: string | undefined;
  readonly PATH?: string | undefined;
}

export interface DevSupervisorPlan {
  readonly overrides: RuntimeOverrides;
  readonly connect: () => Promise<SupervisorClient>;
}

/**
 * The developer-machine escape hatch from the root supervisor. No sandbox image
 * sets `ONCUE_DEV_SUPERVISOR`, so every sandbox uses the Unix-socket client.
 * `pnpm dev`'s controller double sets it to `"inprocess"` with a local
 * `opencode` binary and a directory that plays `/workspace`, so
 * `local-supervisor.ts` runs the harness as the current user with no second
 * Unix user and no root process.
 */
export function devSupervisorPlan(env: DevSupervisorEnv): DevSupervisorPlan | null {
  if (env.ONCUE_DEV_SUPERVISOR !== "inprocess") {
    return null;
  }
  const binary = env.ONCUE_DEV_OPENCODE_BIN;
  const workspaceDir = env.ONCUE_DEV_WORKSPACE;
  if (binary === undefined || workspaceDir === undefined) {
    throw new Error(
      "ONCUE_DEV_SUPERVISOR=inprocess needs ONCUE_DEV_OPENCODE_BIN and ONCUE_DEV_WORKSPACE set",
    );
  }
  const port =
    env.ONCUE_DEV_RUNTIME_PORT === undefined ? undefined : Number(env.ONCUE_DEV_RUNTIME_PORT);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error("ONCUE_DEV_RUNTIME_PORT must be a TCP port");
  }
  const checkOutputDir = join(dirname(workspaceDir), "checks");
  const baseTreeRoot = join(dirname(workspaceDir), "base");
  const secretsDir = join(dirname(workspaceDir), "secrets");
  const attachmentsRoot = join(dirname(workspaceDir), "attachments");
  // Codex, Pi, and Claude Code run under the runtime host: this machine's
  // Node and the host bundle beside this one (`dist/runtime-host.mjs`), and
  // Pi with OnCue's extension from the same build (`dist/pi-extension.mjs`).
  const codex = env.ONCUE_DEV_CODEX_BIN;
  const pi = env.ONCUE_DEV_PI_BIN;
  const claude = env.ONCUE_DEV_CLAUDE_BIN;
  const bundleDir = dirname(fileURLToPath(import.meta.url));
  const runtimeBinaries = {
    ...(codex === undefined ? {} : { codex }),
    ...(pi === undefined ? {} : { pi }),
    ...(claude === undefined ? {} : { claude }),
  };
  const hosted =
    Object.keys(runtimeBinaries).length === 0
      ? {}
      : {
          runtimeBinaries,
          runtimeHost: { node: process.execPath, host: join(bundleDir, "runtime-host.mjs") },
        };
  const extension =
    pi === undefined ? {} : { runtimeExtension: join(bundleDir, "pi-extension.mjs") };
  return {
    overrides: {
      workspaceDir,
      ...(port === undefined ? {} : { runtimePort: port }),
      runtimeBinary: binary,
      ...hosted,
      ...extension,
      // One level above /workspace, as on the image, so OpenCode's XDG dirs
      // land beside the clone rather than inside it.
      runtimeHome: dirname(workspaceDir),
      secretsDir,
      // A checkpoint's private index and objects, beside the clone and never
      // inside it, as `/opt/oncue/checkpoint` is on the image.
      checkpointDir: join(dirname(workspaceDir), "checkpoint"),
      // `/var/lib/oncue/checks` and `/var/lib/oncue/base` on the image.
      checkOutputDir,
      baseTreeRoot,
      // `/var/lib/oncue/attachments` on the image.
      attachmentsRoot,
      // A check runs `npm` or `pnpm` wherever this machine keeps them.
      ...(env.PATH === undefined ? {} : { checkPath: env.PATH }),
    },
    connect: () =>
      Promise.resolve(
        createLocalSupervisor({
          binary,
          workspaceDir,
          checkOutputDir,
          baseTreeRoot,
          secretsDir,
          attachmentsRoot,
          ...hosted,
        }),
      ),
  };
}

/** A loopback port nothing holds right now, released for the harness to bind. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
    });
  });
}

/**
 * `devSupervisorPlan` with the harness port always settled on the dev host:
 * the one `ONCUE_DEV_RUNTIME_PORT` names, or a free one picked here. A bridge
 * started without it would otherwise fall back to the image's fixed port for
 * its harness, which another bridge on this machine may already hold.
 */
export async function resolveDevSupervisorPlan(
  env: DevSupervisorEnv,
  pickPort: () => Promise<number> = freeLoopbackPort,
): Promise<DevSupervisorPlan | null> {
  if (env.ONCUE_DEV_SUPERVISOR !== "inprocess" || env.ONCUE_DEV_RUNTIME_PORT !== undefined) {
    return devSupervisorPlan(env);
  }
  return devSupervisorPlan({ ...env, ONCUE_DEV_RUNTIME_PORT: String(await pickPort()) });
}

export async function main(): Promise<number> {
  const io = nodeBridgeIo();
  const plan = planStartup(
    process.env,
    (path) => readFileSync(path, "utf8").trim(),
    bridgeVersion(),
  );
  if (plan.kind === "misconfigured") {
    io.log(`bridge cannot start, missing: ${plan.missing.join(", ")}`);
    return 78;
  }
  const dev = await resolveDevSupervisorPlan(process.env);
  // The supervisor socket, the relay server, the OpenCode client, and the
  // reducer; built once for the process, outliving every reconnect.
  const bridge =
    dev === null
      ? await agentIo(plan.config, io)
      : await agentIo(plan.config, io, dev.overrides, dev.connect);
  const exit = await bridge.run();
  await bridge.shutdown();
  io.log(`bridge finished: ${exit.kind}`);
  // Only a shutdown the control plane asked for exits 0; `sandboxes.state_of`
  // reads the exit code to tell an ended generation from a failed one.
  return exit.kind === "shutdown" ? 0 : 1;
}

// Bundled, this file IS the image's entrypoint. Under the test runner it is an
// imported module and argv[1] is vitest, so nothing starts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
