/**
 * The sandbox controller double: Modal and the Python controller replaced by
 * one Node process that runs the real bridge bundle with the same environment
 * and credential file a Modal sandbox's entrypoint gives it.
 *
 * A double never covers for our own code: this emits no protocol event, so if
 * the bridge stops sending something, the timeline stops showing it. It lacks
 * the sandbox's Unix-user boundary, which is tested on the real image (test C,
 * `docs/history.md`).
 *
 * It answers `services/sandbox-controller/app.py`'s HTTP contract in the
 * envelopes `worker/sandbox/modal-driver.ts` reads: a missing controller token
 * or Modal header pair is a 401. The pair is checked only for presence and
 * never echoed or recorded.
 *
 * Two modes imitate Modal's timing, not any decision of ours: `cold_image`
 * is a workspace that has not built the current image, so `prepareImage`
 * answers `building` for `COLD_BUILD_MS`, holding each request as the real
 * controller does; `slow_create` starts the sandbox at once but answers the
 * create only after `SLOW_CREATE_MS`, past the Worker's deadline, as a create
 * whose answer is lost does.
 *
 * Control endpoints, never in the Worker:
 *   GET  /__calls   what arrived, as method and path, header names only
 *   POST /__mode    { mode: "ok" | "create_fails" | "start_fails" | "cold_image" | "slow_create" }
 *   POST /__reset   clear recorded calls, forget every sandbox, and forget the built image
 *   POST /__flaky   { sessionId } routes that session's bridge connection
 *                   through a TCP proxy this double owns, for the faults below
 *   POST /__drop    { sessionId } cuts every proxied connection of that session
 *   POST /__stall   { sessionId } stops carrying bytes on them without closing,
 *                   a half-open link; the next connection is carried normally
 *   GET  /__links?session=  the proxy's connection counts and the bridges' state
 *
 * The faults are the network's, never the bridge's: the bridge and the Worker
 * run unchanged on either side of the proxy.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as connectTcp, createServer as createTcpServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { slotPorts } from "../../../scripts/dev-ports.mjs";
import { listenOrAttach, postJson } from "./double-port";

/**
 * Where a real OpenCode 1.18.30 binary lives, for `services/bridge/src/local-supervisor.ts`
 * to spawn without a root supervisor or a second Unix user.
 * `ONCUE_OPENCODE_BIN` overrides the default `opencode.ai/install` path.
 */
export function resolveOpencodeBinary(): string {
  return process.env.ONCUE_OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
}

/** The port slot's controller (`scripts/dev-ports.mjs`), which `pnpm controller` also serves on. */
export const CONTROLLER_DOUBLE_PORT = slotPorts().controller;

/** The workspace name the connection test reports; the settings screen shows it back. */
export const DOUBLE_WORKSPACE_NAME = "oncue-local-double";

export type ControllerDoubleMode =
  | "ok"
  | "create_fails"
  | "start_fails"
  | "cold_image"
  | "slow_create";

/** How long a cold workspace's image takes to build: past the 20 seconds a create was once given. */
export const COLD_BUILD_MS = 25_000;

/** How long a slow create takes to answer: past the Worker's 60-second create deadline. */
export const SLOW_CREATE_MS = 65_000;

/** The real controller's cap on how long it holds a `prepareImage` request (`prepare.py`). */
const MAX_PREPARE_WAIT_MS = 25_000;

export interface ControllerRecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
}

export interface RunningControllerDouble {
  readonly server: Server;
  /** Resolves once the double holds the mode, whether in-process or attached to over HTTP. */
  setMode(mode: ControllerDoubleMode): Promise<void>;
  /** What a generation's work tree holds at `path`, or null; for checking a resume restored the work. */
  readWorkspaceFile(sessionId: string, generation: number, path: string): Promise<string | null>;
  /**
   * Every file under a generation's home as path and text, so a test can check
   * a supplied secret is in its one file and nowhere else. Local sandboxes only;
   * test C covers Modal.
   */
  readHomeFiles(sessionId: string, generation: number): Promise<Record<string, string>>;
  /**
   * Starts `forged-bridge.ts` instead of the real bridge for every generation
   * of this session. Every other session keeps the real bundle.
   */
  forgeBridge(sessionId: string): Promise<void>;
  /** Routes this session's bridge connection through the double's proxy; call before its sandbox is created. */
  flakyLink(sessionId: string): Promise<void>;
  /** Cuts the session's proxied connections, as a network drop would; resolves with how many it cut. */
  dropLinks(sessionId: string): Promise<number>;
  /** Stops carrying bytes on the session's proxied connections without closing them. */
  stallLinks(sessionId: string): Promise<number>;
  /** The proxy's connection counts for the session, and whether each of its bridges still runs. */
  links(sessionId: string): Promise<LinkReport>;
  close(): Promise<void>;
}

const BRIDGE_BUNDLE = fileURLToPath(
  new URL("../../../services/bridge/dist/bridge.mjs", import.meta.url),
);
/** The lying bridge, started instead of the bundle for a session a test names. */
const FORGED_BRIDGE = fileURLToPath(new URL("./forged-bridge.ts", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface LinkReport {
  /** Connections the proxy carries now. */
  readonly open: number;
  /** Connections the proxy has accepted for the session. */
  readonly total: number;
  /** Each generation's bridge: running, or the code it exited with. */
  readonly bridges: readonly { readonly generation: number; readonly exitCode: number | null }[];
  /** Bridge output lines saying a replay could not be answered. */
  readonly replayGaps: number;
}

/** One session's proxy between its bridge and the Worker. */
interface FlakyProxy {
  readonly server: import("node:net").Server;
  readonly port: number;
  /** WebSocket connections only: the bridge's other calls share the origin, and the faults are the control link's. */
  readonly pairs: Set<{ readonly client: Socket; readonly upstream: Socket }>;
  total: number;
}

interface OutputLine {
  readonly stream: "stdout" | "stderr";
  readonly at: string;
  readonly text: string;
}

interface LocalSandbox {
  /** Plays the sandbox's `/workspace`, so a test can read what a generation's clone holds. */
  readonly workspaceDir: string;
  readonly name: string;
  readonly process: ChildProcess;
  /** What the bridge printed, stamped as it arrived: the double's `logs.fetch`. */
  readonly output: OutputLine[];
  exitCode: number | null;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      resolve(body.length > 0 ? JSON.parse(body) : {});
    });
  });
}

function envelope(status: number, body: unknown): { status: number; body: unknown } {
  return { status, body };
}

function errorEnvelope(
  status: number,
  category: string,
  message: string,
  retryable: boolean,
): { status: number; body: unknown } {
  return envelope(status, { kind: "error", category, message, retryable });
}

/** `services/sandbox-controller/sandboxes.py`'s `sandbox_name`, so a log line reads the same. */
/**
 * Every regular file under `root` as relative path and utf-8 text, skipping
 * `.git` and OpenCode's state, which hold neither the work nor a secret.
 */
function textFilesUnder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (
        entry === ".git" ||
        entry === "node_modules" ||
        entry === ".local" ||
        entry === ".cache"
      ) {
        continue;
      }
      const path = join(directory, entry);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        files[relative(root, path)] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

function sandboxName(sessionId: string, generation: number): string {
  const suffix = `-g${generation}`;
  return `s-${sessionId}`.slice(0, 64 - suffix.length) + suffix;
}

/** The bridge bundle is gitignored build output, so a test run on its own builds it here. */
function ensureBridgeBundle(): void {
  if (existsSync(BRIDGE_BUNDLE)) {
    return;
  }
  execFileSync("pnpm", ["--filter", "@oncue/bridge", "build"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: "inherit",
  });
}

export interface ControllerDoubleOptions {
  /** Where the spawned bridge dials: the local Worker's origin. */
  readonly controlPlaneOrigin: string;
  readonly port?: number;
  /** Where the spawned bridge's stdout goes. Defaults to this process's. */
  readonly bridgeStdio?: "inherit" | "ignore";
}

export function startControllerDouble(
  options: ControllerDoubleOptions,
): Promise<RunningControllerDouble> {
  const port = options.port ?? CONTROLLER_DOUBLE_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const calls: ControllerRecordedCall[] = [];
  const sandboxes = new Map<string, LocalSandbox>();
  let mode: ControllerDoubleMode = "ok";
  const forgedSessions = new Set<string>();
  // When the cold workspace's build finishes, once one has started; Modal
  // keeps a built image, so it stays built until a reset.
  let imageReadyAt: number | null = null;
  const proxies = new Map<string, FlakyProxy>();

  /** A loopback TCP proxy to the Worker, so a test can cut or stall a bridge's link from outside it. */
  function startProxy(): Promise<FlakyProxy> {
    const target = new URL(options.controlPlaneOrigin);
    const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    // URL keeps an IPv6 literal's brackets, and net.connect cannot resolve them.
    const targetHost = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const pairs: FlakyProxy["pairs"] = new Set();
    let proxy: FlakyProxy | null = null;
    const server = createTcpServer((client) => {
      const upstream = connectTcp(targetPort, targetHost);
      const pair = { client, upstream };
      // The Worker names the origin the bridge dialled as the broker's and
      // the artifacts', so model and upload requests come through here too;
      // only the WebSocket upgrade is the control link the faults act on.
      client.once("data", (first: Buffer) => {
        if (/^upgrade:\s*websocket/im.test(first.toString("latin1"))) {
          pairs.add(pair);
          if (proxy !== null) {
            proxy.total += 1;
          }
        }
      });
      const end = (): void => {
        pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", end);
      upstream.on("error", (error) => {
        // Without this a proxy that cannot reach the Worker looks like a bridge that never connects.
        console.error(
          `[controller-double] proxy to ${targetHost}:${targetPort} failed: ${error.message}`,
        );
        end();
      });
      client.on("close", end);
      upstream.on("close", end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        proxy = { server, port, pairs, total: 0 };
        resolve(proxy);
      });
    });
  }

  function linkReport(sessionId: string): LinkReport {
    const proxy = proxies.get(sessionId);
    const bridges = [...sandboxes.values()]
      .filter((sandbox) => sandbox.name.startsWith(`s-${sessionId}`.slice(0, 40)))
      .map((sandbox) => ({
        generation: Number(/-g(\d+)$/.exec(sandbox.name)?.[1] ?? "0"),
        exitCode: sandbox.exitCode,
        replayGaps: sandbox.output.filter((line) => line.text.includes("cannot replay")).length,
      }));
    return {
      open: proxy?.pairs.size ?? 0,
      total: proxy?.total ?? 0,
      bridges: bridges.map(({ generation, exitCode }) => ({ generation, exitCode })),
      replayGaps: bridges.reduce((sum, bridge) => sum + bridge.replayGaps, 0),
    };
  }

  // Several bridges share this host, from this stack and any other slot's,
  // each with its own harness (OpenCode, Codex, Pi, or Claude Code), so the
  // image's fixed per-harness ports would make them answer each other's
  // health checks.
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createTcpServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
      });
    });
  }

  // The bridges must not outlive this process, or a signal to `pnpm dev`
  // would leave every bridge and OpenCode running.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => {
      for (const sandbox of sandboxes.values()) {
        terminate(sandbox);
      }
      process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
    });
  }

  function terminate(sandbox: LocalSandbox): void {
    if (sandbox.exitCode === null) {
      sandbox.process.kill("SIGTERM");
    }
  }

  // The lying bridge gets exactly what the real one gets. It runs no
  // OpenCode, so it needs no binary or port.
  function startForgedBridge(spec: {
    sessionId: string;
    generation: number;
    bootstrapCredential: string;
  }): LocalSandbox {
    const name = sandboxName(spec.sessionId, spec.generation);
    const home = mkdtempSync(join(tmpdir(), "oncue-sandbox-forged-"));
    const bootstrapFile = join(home, "bootstrap");
    writeFileSync(bootstrapFile, spec.bootstrapCredential, { mode: 0o400 });
    const child = spawn(process.execPath, ["--import", "tsx", FORGED_BRIDGE], {
      cwd: WEB_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        ONCUE_SESSION_ID: spec.sessionId,
        ONCUE_SANDBOX_GENERATION: String(spec.generation),
        ONCUE_CONTROL_PLANE_ORIGIN: options.controlPlaneOrigin,
        ONCUE_BOOTSTRAP_FILE: bootstrapFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return track({ name, process: child, output: [], exitCode: null, workspaceDir: home });
  }

  /** Keeps a started sandbox's output the way Modal keeps an entrypoint's logs. */
  function track(sandbox: LocalSandbox): LocalSandbox {
    const capture = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const at = new Date().toISOString();
      for (const text of String(chunk).split("\n")) {
        if (text.length > 0) {
          sandbox.output.push({ stream, at, text });
        }
      }
      if ((options.bridgeStdio ?? "inherit") === "inherit") {
        process.stdout.write(chunk);
      }
    };
    sandbox.process.stdout?.on("data", capture("stdout"));
    sandbox.process.stderr?.on("data", capture("stderr"));
    sandbox.process.on("exit", (code) => {
      sandbox.exitCode = code ?? 1;
    });
    sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  }

  type CreateOutcome =
    | { readonly kind: "ok"; readonly sandbox: LocalSandbox }
    | { readonly kind: "missing_binary"; readonly path: string };

  async function create(spec: {
    sessionId: string;
    generation: number;
    bootstrapCredential: string;
  }): Promise<CreateOutcome> {
    if (forgedSessions.has(spec.sessionId)) {
      return { kind: "ok", sandbox: startForgedBridge(spec) };
    }
    ensureBridgeBundle();
    const opencodeBinary = resolveOpencodeBinary();
    if (!existsSync(opencodeBinary)) {
      // Fail loudly without OpenCode rather than spawn a bridge that never
      // reaches `runtime.ready`.
      return { kind: "missing_binary", path: opencodeBinary };
    }
    const name = sandboxName(spec.sessionId, spec.generation);
    const home = mkdtempSync(join(tmpdir(), "oncue-sandbox-"));
    // The credential reaches the bridge as a file, never an environment
    // variable, for the reason `images.py`'s entrypoint gives.
    const bootstrapFile = join(home, "bootstrap");
    writeFileSync(bootstrapFile, spec.bootstrapCredential, { mode: 0o400 });
    // Plays the sandbox's `/workspace` and `/opt/opencode/opencode`, run as
    // the current user. `ONCUE_DEV_WORKSPACE` sits one level inside `home`,
    // the layout `devSupervisorPlan` in `main.ts` assumes.
    const workspaceDir = join(home, "workspace");
    // The image creates `/workspace` (`AGENT_WORKDIR` in `images.py`), so a
    // session with no repository to clone still has one to start in.
    mkdirSync(workspaceDir);
    const runtimePort = await freePort();
    const proxy = proxies.get(spec.sessionId);
    const child = spawn(process.execPath, [BRIDGE_BUNDLE], {
      env: {
        PATH: process.env.PATH ?? "",
        ONCUE_SESSION_ID: spec.sessionId,
        ONCUE_SANDBOX_GENERATION: String(spec.generation),
        ONCUE_CONTROL_PLANE_ORIGIN:
          proxy === undefined ? options.controlPlaneOrigin : `http://127.0.0.1:${proxy.port}`,
        ONCUE_BOOTSTRAP_FILE: bootstrapFile,
        ONCUE_DEV_SUPERVISOR: "inprocess",
        ONCUE_DEV_OPENCODE_BIN: opencodeBinary,
        ONCUE_DEV_WORKSPACE: workspaceDir,
        ONCUE_DEV_RUNTIME_PORT: String(runtimePort),
        // A Codex session runs this machine's `codex`, when one is named.
        ...(process.env.ONCUE_DEV_CODEX_BIN === undefined
          ? {}
          : { ONCUE_DEV_CODEX_BIN: process.env.ONCUE_DEV_CODEX_BIN }),
      },
      // Piped, so the double can serve the bridge's output the way Modal
      // serves an entrypoint's logs; echoed to this process when asked.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sandbox = track({
      name,
      process: child,
      output: [],
      exitCode: null,
      workspaceDir,
    });
    return { kind: "ok", sandbox };
  }

  async function handle(
    method: string,
    path: string,
    headers: IncomingMessage["headers"],
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const authorization = headers.authorization;
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ") ||
      typeof headers["x-oncue-modal-token-id"] !== "string" ||
      typeof headers["x-oncue-modal-token-secret"] !== "string"
    ) {
      return errorEnvelope(401, "credentials", "This request is not authenticated.", false);
    }
    const raw = (body ?? {}) as {
      sessionId?: string;
      generation?: number;
      reference?: { sessionId?: string; generation?: number };
    };
    // `execute` and `getOutput` nest the reference; every other operation is
    // the reference itself.
    const reference = raw.reference ?? raw;
    const found =
      typeof reference.sessionId === "string" && typeof reference.generation === "number"
        ? sandboxes.get(sandboxName(reference.sessionId, reference.generation))
        : undefined;
    switch (`${method} ${path}`) {
      case "POST /v1/connection/test":
        return envelope(200, {
          kind: "ok",
          value: { workspaceName: DOUBLE_WORKSPACE_NAME, environments: ["main"] },
        });
      case "POST /v1/prepareImage": {
        if (mode !== "cold_image") {
          return envelope(200, {
            kind: "ok",
            value: { state: "ready", imageReference: "im-local-double", imageVersion: "double" },
          });
        }
        imageReadyAt ??= Date.now() + COLD_BUILD_MS;
        const waitMs = Math.min(
          Math.max(0, Number((body as { waitMs?: number }).waitMs ?? 0)),
          MAX_PREPARE_WAIT_MS,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(waitMs, Math.max(0, imageReadyAt - Date.now()))),
        );
        return envelope(200, {
          kind: "ok",
          value:
            Date.now() >= imageReadyAt
              ? { state: "ready", imageReference: "im-local-double", imageVersion: "double" }
              : { state: "building", imageVersion: "double" },
        });
      }
      case "POST /v1/create": {
        if (mode === "create_fails") {
          return errorEnvelope(
            503,
            "capacity",
            "Modal has no capacity for this sandbox right now.",
            true,
          );
        }
        const spec = body as { sessionId: string; generation: number; bootstrapCredential: string };
        // Idempotent on (sessionId, generation), like `sandboxes.py`: a retry
        // of a create whose answer was lost finds the running process, and a
        // generation whose sandbox already exited is never started twice.
        const existing = sandboxes.get(sandboxName(spec.sessionId, spec.generation));
        if (existing !== undefined && existing.exitCode !== null) {
          return errorEnvelope(
            409,
            "conflict",
            "This generation's sandbox already ran and exited; a new generation is needed.",
            false,
          );
        }
        if (existing === undefined) {
          const outcome = await create(spec);
          if (outcome.kind === "missing_binary") {
            return errorEnvelope(
              503,
              "capacity",
              `no OpenCode binary at ${outcome.path}; install it (curl -fsSL https://opencode.ai/install | VERSION=1.18.30 bash) or set ONCUE_OPENCODE_BIN`,
              false,
            );
          }
        }
        if (mode === "slow_create") {
          await new Promise((resolve) => setTimeout(resolve, SLOW_CREATE_MS));
        }
        return envelope(200, {
          kind: "ok",
          value: { sessionId: spec.sessionId, generation: spec.generation },
        });
      }
      case "POST /v1/start":
        if (mode === "start_fails" || found === undefined || found.exitCode !== null) {
          return errorEnvelope(
            404,
            "not_found",
            "Modal has no sandbox for this session and generation.",
            false,
          );
        }
        return envelope(200, { kind: "ok", value: reference });
      case "POST /v1/stop":
      case "POST /v1/destroy":
        if (found !== undefined) {
          terminate(found);
        }
        return envelope(200, { kind: "ok", value: reference });
      case "POST /v1/getStatus":
        if (found === undefined) {
          return errorEnvelope(
            404,
            "not_found",
            "Modal has no sandbox for this session and generation.",
            false,
          );
        }
        return envelope(200, {
          kind: "ok",
          value: found.exitCode === null ? "active" : found.exitCode === 0 ? "stopped" : "failed",
        });
      case "POST /v1/getConnection":
        if (found === undefined || found.exitCode !== null) {
          return errorEnvelope(
            404,
            "not_found",
            "Modal has no sandbox for this session and generation.",
            false,
          );
        }
        // The shape `sandboxes.py`'s `connection_url` produces, with the local
        // process id where Modal's sandbox object id would be.
        return envelope(200, {
          kind: "ok",
          value: { bridgeUrl: `local://oncue-sessions/pid-${found.process.pid ?? 0}` },
        });
      case "POST /v1/getOutput": {
        if (found === undefined) {
          return errorEnvelope(
            404,
            "not_found",
            "Modal has no sandbox for this session and generation.",
            false,
          );
        }
        const since = (body as { since?: string | null }).since ?? null;
        const lines = found.output.filter((line) => since === null || line.at > since);
        const last = lines.at(-1);
        // As the real controller answers: an empty poll leaves the cursor
        // where it was, so a line that lands late is still found.
        const next =
          last === undefined
            ? (since ?? new Date(0).toISOString())
            : new Date(Date.parse(last.at) + 1).toISOString();
        return envelope(200, { kind: "ok", value: { lines, next } });
      }
      case "POST /v1/execute":
        return found === undefined
          ? errorEnvelope(
              404,
              "not_found",
              "Modal has no sandbox for this session and generation.",
              false,
            )
          : envelope(200, { kind: "ok", value: { executionId: `${found.name}-exec` } });
      case "POST /v1/createCheckpoint":
        return found === undefined
          ? errorEnvelope(
              404,
              "not_found",
              "Modal has no sandbox for this session and generation.",
              false,
            )
          : envelope(200, { kind: "ok", value: { checkpointId: `${found.name}-ckpt` } });
      default:
        return errorEnvelope(404, "not_found", "no such operation", false);
    }
  }

  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    const method = request.method ?? "GET";

    if (path === "/__calls" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ calls }));
      return;
    }
    if (path === "/__mode" && method === "POST") {
      void readJsonBody(request).then((body) => {
        mode = (body as { mode: ControllerDoubleMode }).mode;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ mode }));
      });
      return;
    }
    if (path === "/__forge" && method === "POST") {
      void readJsonBody(request).then((body) => {
        const sessionId = (body as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string") {
          forgedSessions.add(sessionId);
        }
        response.writeHead(typeof sessionId === "string" ? 200 : 400, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ forged: typeof sessionId === "string" }));
      });
      return;
    }
    if ((path === "/__flaky" || path === "/__drop" || path === "/__stall") && method === "POST") {
      void readJsonBody(request).then(async (body) => {
        const sessionId = (body as { sessionId?: unknown }).sessionId;
        if (typeof sessionId !== "string") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "sessionId" }));
          return;
        }
        let affected = 0;
        if (path === "/__flaky") {
          if (!proxies.has(sessionId)) {
            proxies.set(sessionId, await startProxy());
          }
        } else {
          for (const pair of [...(proxies.get(sessionId)?.pairs ?? [])]) {
            affected += 1;
            if (path === "/__drop") {
              pair.client.destroy();
              pair.upstream.destroy();
            } else {
              // Nothing more crosses in either direction, and nothing closes:
              // what a dead NAT entry or a vanished peer looks like.
              pair.client.unpipe(pair.upstream);
              pair.upstream.unpipe(pair.client);
              pair.client.pause();
              pair.upstream.pause();
            }
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ affected }));
      });
      return;
    }
    if (path.startsWith("/__links?") && method === "GET") {
      const sessionId = new URL(path, origin).searchParams.get("session") ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(linkReport(sessionId)));
      return;
    }
    if (path.startsWith("/__workspace?") && method === "GET") {
      const query = new URL(path, origin).searchParams;
      const found = sandboxes.get(
        sandboxName(query.get("session") ?? "", Number(query.get("generation"))),
      );
      const file = found === undefined ? null : join(found.workspaceDir, query.get("path") ?? "");
      if (file === null || !existsSync(file)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ found: false }));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(readFileSync(file));
      return;
    }
    if (path.startsWith("/__home?") && method === "GET") {
      const query = new URL(path, origin).searchParams;
      const found = sandboxes.get(
        sandboxName(query.get("session") ?? "", Number(query.get("generation"))),
      );
      if (found === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ found: false }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(textFilesUnder(dirname(found.workspaceDir))));
      return;
    }
    if (path === "/__reset" && method === "POST") {
      calls.length = 0;
      for (const sandbox of sandboxes.values()) {
        terminate(sandbox);
      }
      sandboxes.clear();
      forgedSessions.clear();
      for (const proxy of proxies.values()) {
        for (const pair of proxy.pairs) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        proxy.server.close();
      }
      proxies.clear();
      mode = "ok";
      imageReadyAt = null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    // Header NAMES only: two of the values are halves of a Modal credential.
    calls.push({ method, path, headerNames: Object.keys(request.headers) });
    void readJsonBody(request)
      .then((body) => handle(method, path, request.headers, body))
      .then((answer) => {
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      });
  });

  const readHomeFiles = (sessionId: string, generation: number) =>
    fetch(
      `${origin}/__home?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
    ).then((answer) => (answer.ok ? answer.json() : {}) as Promise<Record<string, string>>);
  const readWorkspaceFile = (sessionId: string, generation: number, path: string) =>
    fetch(
      `${origin}/__workspace?session=${encodeURIComponent(sessionId)}&generation=${generation}&path=${encodeURIComponent(path)}`,
    ).then((answer) => (answer.ok ? answer.text() : null));

  // Over HTTP whether this process serves the double or attached to one, so
  // a lane drives the same faults either way.
  const fault = async (path: "/__drop" | "/__stall", sessionId: string): Promise<number> => {
    const answer = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    return ((await answer.json()) as { affected: number }).affected;
  };
  const faults = {
    flakyLink: (sessionId: string) => postJson(origin, "/__flaky", { sessionId }),
    dropLinks: (sessionId: string) => fault("/__drop", sessionId),
    stallLinks: (sessionId: string) => fault("/__stall", sessionId),
    links: async (sessionId: string): Promise<LinkReport> =>
      (await (
        await fetch(`${origin}/__links?session=${encodeURIComponent(sessionId)}`)
      ).json()) as LinkReport,
  };

  return listenOrAttach(server, port, origin).then((outcome) => {
    if (outcome === "attached") {
      return {
        server,
        readWorkspaceFile,
        readHomeFiles,
        ...faults,
        forgeBridge(sessionId) {
          return postJson(origin, "/__forge", { sessionId });
        },
        setMode(next) {
          return postJson(origin, "/__mode", { mode: next });
        },
        close: () => Promise.resolve(),
      };
    }
    return {
      server,
      readWorkspaceFile,
      readHomeFiles,
      ...faults,
      async forgeBridge(sessionId) {
        forgedSessions.add(sessionId);
      },
      async setMode(next) {
        mode = next;
      },
      close() {
        for (const sandbox of sandboxes.values()) {
          terminate(sandbox);
        }
        for (const proxy of proxies.values()) {
          proxy.server.close();
        }
        return new Promise((done) => {
          server.close(() => done());
        });
      },
    };
  });
}
