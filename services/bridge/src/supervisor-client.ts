/**
 * The bridge's end of the supervisor's Unix socket: one method per verb. It
 * hides request correlation (a `wait` outlives other requests on the same
 * connection) and turns every refusal, and a missing socket, into a typed
 * outcome rather than a throw, because the caller is an effect interpreter
 * that must turn every ending into an input.
 */

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  type AgentSignal,
  type CheckExit,
  encodeRequest,
  LineSplitter,
  type PermissionDenial,
  parseResponse,
  type SupervisorRequest,
  type SupervisorResponse,
  type SupervisorResult,
  secretFilePath,
} from "./supervisor-protocol";

export type SupervisorOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "refused";
      readonly denial: PermissionDenial | "no_such_agent" | "already_running" | "no_such_check";
    }
  | { readonly kind: "failed"; readonly detail: string }
  /** The socket is not there, or closed mid-request. The supervisor died: fatal. */
  | { readonly kind: "unreachable" };

export type StartAgentRequest = Omit<
  Extract<SupervisorRequest, { op: "start_agent" }>,
  "op" | "requestId"
>;

export type RunCheckRequest = Omit<
  Extract<SupervisorRequest, { op: "run_check" }>,
  "op" | "requestId"
>;

export interface AgentExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SupervisorClient {
  chownWorkspace(uid: number): Promise<SupervisorOutcome<void>>;
  startAgent(request: StartAgentRequest): Promise<SupervisorOutcome<{ readonly pid: number }>>;
  signal(signal: AgentSignal): Promise<SupervisorOutcome<void>>;
  /** Resolves when the agent exits. */
  wait(): Promise<SupervisorOutcome<AgentExit>>;
  /** Resolves when the check has ended, however it ended. */
  runCheck(request: RunCheckRequest): Promise<SupervisorOutcome<CheckExit>>;
  signalCheck(checkRunId: string, signal: AgentSignal): Promise<SupervisorOutcome<void>>;
  prepareBase(dir: string, uid: number): Promise<SupervisorOutcome<void>>;
  /** Composer attachments: hands a directory the bridge wrote under `ATTACHMENTS_ROOT` to the agent. */
  prepareAttachments(dir: string, uid: number): Promise<SupervisorOutcome<void>>;
  /**
   * Hands one development secret to the supervisor, which writes it where only
   * the agent can read it. The value is written, logged, and echoed nowhere else.
   */
  writeSecret(name: string, value: string): Promise<SupervisorOutcome<void>>;
  clearSecrets(): Promise<SupervisorOutcome<void>>;
  /** Where the agent finds the secret named `name`: what the tool tells it. */
  secretPath(name: string): string;
  close(): void;
}

/** A response `parseResponse` accepted, translated. Pure; the socket code below only routes. */
export function outcomeOf(response: SupervisorResponse): SupervisorOutcome<SupervisorResult> {
  if (response.ok) {
    return { kind: "ok", value: response.result };
  }
  const refusal = response.refusal;
  switch (refusal.reason) {
    case "not_permitted":
      return { kind: "refused", denial: refusal.detail };
    case "no_such_agent":
    case "already_running":
    case "no_such_check":
      return { kind: "refused", denial: refusal.reason };
    case "failed":
      return { kind: "failed", detail: refusal.detail };
    case "malformed":
      // The supervisor could not read what this client wrote: a bug on this
      // side, reported as a failure rather than hidden as a refusal.
      return { kind: "failed", detail: "supervisor could not parse the request" };
  }
}

/** The channel the client rides on; `openSocket` below is the Node one and the test supplies a fake. */
export interface SupervisorChannel {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type OpenChannel = (socketPath: string) => Promise<SupervisorChannel>;

const UNREACHABLE: SupervisorOutcome<never> = { kind: "unreachable" };

function unreachableClient(): SupervisorClient {
  return {
    chownWorkspace: async () => UNREACHABLE,
    startAgent: async () => UNREACHABLE,
    signal: async () => UNREACHABLE,
    wait: async () => UNREACHABLE,
    runCheck: async () => UNREACHABLE,
    signalCheck: async () => UNREACHABLE,
    prepareBase: async () => UNREACHABLE,
    prepareAttachments: async () => UNREACHABLE,
    writeSecret: async () => UNREACHABLE,
    clearSecrets: async () => UNREACHABLE,
    secretPath: secretFilePath,
    close() {},
  };
}

/** A request without its id: `Omit` over the union, member by member. */
type RequestBody = SupervisorRequest extends infer R
  ? R extends SupervisorRequest
    ? Omit<R, "requestId">
    : never
  : never;

function wrongOp(op: SupervisorResult["op"]): SupervisorOutcome<never> {
  return { kind: "failed", detail: `supervisor answered with ${op}` };
}

function expecting<T>(
  outcome: SupervisorOutcome<SupervisorResult>,
  pick: (result: SupervisorResult) => T | undefined,
): SupervisorOutcome<T> {
  if (outcome.kind !== "ok") {
    return outcome;
  }
  const value = pick(outcome.value);
  return value === undefined ? wrongOp(outcome.value.op) : { kind: "ok", value };
}

function expectingOp(
  outcome: SupervisorOutcome<SupervisorResult>,
  op: SupervisorResult["op"],
): SupervisorOutcome<void> {
  if (outcome.kind !== "ok") {
    return outcome;
  }
  return outcome.value.op === op ? { kind: "ok", value: undefined } : wrongOp(outcome.value.op);
}

export function createSupervisorClient(
  channel: SupervisorChannel,
  newRequestId: () => string = randomUUID,
): SupervisorClient {
  const pending = new Map<string, (outcome: SupervisorOutcome<SupervisorResult>) => void>();
  let closed = false;

  channel.onLine((line) => {
    const response = parseResponse(line);
    if (response === null) {
      return;
    }
    const settle = pending.get(response.requestId);
    if (settle === undefined) {
      return;
    }
    pending.delete(response.requestId);
    settle(outcomeOf(response));
  });
  channel.onClose(() => {
    closed = true;
    for (const settle of pending.values()) {
      settle(UNREACHABLE);
    }
    pending.clear();
  });

  function send(
    body: RequestBody,
    timeoutMs: number | null = null,
  ): Promise<SupervisorOutcome<SupervisorResult>> {
    if (closed) {
      return Promise.resolve(UNREACHABLE);
    }
    const requestId = newRequestId();
    const request: SupervisorRequest = { ...body, requestId };
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      if (timeoutMs !== null) {
        // A request the bridge waits on (a run's first prompt waits for its
        // secret files) is bounded, so a supervisor that never answers costs a
        // failed write rather than the run.
        setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ kind: "failed", detail: "timed_out" });
          }
        }, timeoutMs).unref?.();
      }
      channel.write(encodeRequest(request));
    });
  }

  return {
    async chownWorkspace(uid) {
      return expectingOp(await send({ op: "chown_workspace", uid }), "chown_workspace");
    },
    async startAgent(request) {
      return expecting(await send({ op: "start_agent", ...request }), (result) =>
        result.op === "start_agent" ? { pid: result.pid } : undefined,
      );
    },
    async signal(signal) {
      return expectingOp(await send({ op: "signal", signal }), "signal");
    },
    async wait() {
      return expecting(await send({ op: "wait" }), (result) =>
        result.op === "wait" ? { code: result.code, signal: result.signal } : undefined,
      );
    },
    async runCheck(request) {
      return expecting(await send({ op: "run_check", ...request }), (result) => {
        if (result.op !== "run_check") {
          return undefined;
        }
        const { op: _op, ...exit } = result;
        return exit;
      });
    },
    async signalCheck(checkRunId, signal) {
      return expectingOp(await send({ op: "signal_check", checkRunId, signal }), "signal_check");
    },
    async prepareBase(dir, uid) {
      return expectingOp(await send({ op: "prepare_base", dir, uid }), "prepare_base");
    },
    async prepareAttachments(dir, uid) {
      return expectingOp(
        await send({ op: "prepare_attachments", dir, uid }),
        "prepare_attachments",
      );
    },
    async writeSecret(name, value) {
      return expectingOp(
        await send({ op: "write_secret", name, value }, WRITE_SECRET_TIMEOUT_MS),
        "write_secret",
      );
    },
    async clearSecrets() {
      return expectingOp(await send({ op: "clear_secrets" }), "clear_secrets");
    },
    secretPath: secretFilePath,
    close() {
      channel.close();
    },
  };
}

function openSocket(socketPath: string): Promise<SupervisorChannel> {
  return new Promise<SupervisorChannel>((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.on("error", () => {});
      const splitter = new LineSplitter();
      resolve({
        write: (line) => {
          socket.write(line);
        },
        onLine: (listener) => {
          socket.on("data", (chunk: string) => {
            for (const line of splitter.push(chunk)) {
              if (line !== null) {
                listener(line);
              }
            }
          });
        },
        onClose: (listener) => socket.once("close", listener),
        close: () => socket.end(),
      });
    });
  });
}

/** How long a write of one secret may take before it counts as failed; it is a local file write. */
export const WRITE_SECRET_TIMEOUT_MS = 30_000;

/** Never rejects: a missing or refusing socket yields a client whose every call is `unreachable`. */
export async function connectSupervisor(
  socketPath: string,
  open: OpenChannel = openSocket,
): Promise<SupervisorClient> {
  try {
    return createSupervisorClient(await open(socketPath));
  } catch {
    return unreachableClient();
  }
}
