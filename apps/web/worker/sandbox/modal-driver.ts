// The `SandboxDriver` for real Modal sandboxes: HTTPS from the Worker to
// `services/sandbox-controller/`, which speaks Modal's SDK (record 02). The
// controller answers with the same ok/error envelope, so nothing Modal-shaped
// reaches the session object.
//
// Two credentials travel, in headers only, never in a URL or body: the bearer
// proves the caller is OnCue's control plane, and the `x-oncue-modal-*` pair is
// the workspace's own Modal token, resolved per session. The tests scan every
// request for those bytes.
//
// A call that times out or cannot connect is `unknown` and retryable; the
// controller keeps no state, so `getStatus` reconciles. `create`, `start`,
// `stop`, and `destroy` return the caller's own `(sessionId, generation)`
// reference, since there is no provider id to learn.
//
// Each call has its own deadline. A create carries its deadline as
// `notAfter`, so the controller starts no sandbox once this driver has stopped
// waiting for one. An image build never happens inside a create: the object
// prepares the image first, in polls the controller bounds.

import { SANDBOX_STATES, type SandboxState } from "@oncue/protocol";
import { safeJsonParse } from "../json";
import type { ModalCredential } from "../modal/client";
import {
  attempt,
  type DriverFailureCategory,
  type DriverOutcome,
  type ImagePreparation,
  type SandboxCheckpointRef,
  type SandboxCommand,
  type SandboxConnection,
  type SandboxCreateSpec,
  type SandboxDriver,
  type SandboxExecutionRef,
  type SandboxOperation,
  type SandboxOutput,
  type SandboxOutputLine,
  type SandboxReference,
} from "./driver";
import type { ControllerSettings } from "./origin";

export const DEFAULT_CONTROLLER_TIMEOUT_MS = 20_000;

/**
 * A create from a prepared image is a scheduling decision and a container
 * start, usually seconds. It still gets longer than the other operations,
 * because a create abandoned early is the one that can leave a sandbox behind.
 */
export const CREATE_TIMEOUT_MS = 60_000;

/**
 * How long before the driver stops waiting the controller must have started
 * the sandbox. The margin covers a `Sandbox.create` already sent at that
 * moment, so the controller's own check, made when it returns, falls inside
 * the driver's wait.
 */
export const CREATE_NOT_AFTER_MARGIN_MS = 20_000;

/** How much longer than its requested wait a `prepareImage` call may take. */
export const PREPARE_MARGIN_MS = 15_000;

export interface ModalSandboxDriverOptions {
  readonly settings: ControllerSettings;
  /** The workspace's own Modal token pair, resolved from D1 for this session. */
  readonly credential: ModalCredential;
  readonly fetchImpl: typeof fetch;
  /** For every operation without its own deadline. */
  readonly timeoutMs: number;
  readonly createTimeoutMs?: number;
  /** For `notAfter`; tests pin it. */
  readonly now?: () => number;
}

class ControllerFailure extends Error {
  readonly category: DriverFailureCategory;
  readonly retryable: boolean;

  constructor(category: DriverFailureCategory, message: string, retryable: boolean) {
    super(message);
    this.category = category;
    this.retryable = retryable;
  }
}

function toDriverOutcome(error: unknown): DriverOutcome<never> {
  if (error instanceof ControllerFailure) {
    return {
      kind: "error",
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    };
  }
  // Handles anything thrown outside the fetch itself, in practice a credential
  // that is not a valid header value, so no exception reaches the object.
  return {
    kind: "error",
    category: "configuration",
    message: "The sandbox driver could not build a request the controller would accept.",
    retryable: false,
  };
}

function malformed(): never {
  throw new ControllerFailure(
    "unknown",
    "The sandbox controller answered with something this driver cannot read.",
    false,
  );
}

function isFailureCategory(value: unknown): value is DriverFailureCategory {
  const categories: readonly string[] = [
    "capacity",
    "configuration",
    "image_preparation",
    "credentials",
    "repository_setup",
    "not_found",
    "conflict",
    "unknown",
  ];
  if (typeof value !== "string") {
    return false;
  }
  return categories.includes(value);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object") {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | null {
  const raw = field(value, key);
  if (typeof raw !== "string") {
    return null;
  }
  return raw;
}

function readSandboxState(value: unknown): SandboxState | null {
  if (typeof value !== "string") {
    return null;
  }
  const states: readonly string[] = SANDBOX_STATES;
  if (!states.includes(value)) {
    return null;
  }
  return value as SandboxState;
}

function readPreparation(value: unknown): ImagePreparation | null {
  const state = field(value, "state");
  if (state === "building") {
    return { state };
  }
  const imageReference = stringField(value, "imageReference");
  if (state === "ready" && imageReference !== null) {
    return { state, imageReference };
  }
  return null;
}

function readOutputLine(value: unknown): SandboxOutputLine | null {
  const stream = field(value, "stream");
  const at = stringField(value, "at");
  const text = stringField(value, "text");
  if (stream !== "stdout" && stream !== "stderr" && stream !== "system") {
    return null;
  }
  if (at === null || text === null) {
    return null;
  }
  return { stream, at, text };
}

/** `null` if any element is not a line. */
function readOutput(value: unknown): SandboxOutput | null {
  const raw = field(value, "lines");
  const next = stringField(value, "next");
  if (!Array.isArray(raw) || next === null) {
    return null;
  }
  const lines: SandboxOutputLine[] = [];
  for (const item of raw) {
    const line = readOutputLine(item);
    if (line === null) {
      return null;
    }
    lines.push(line);
  }
  return { lines, next };
}

/**
 * An unrecognised category becomes `unknown`, so a newer controller cannot
 * widen `driver.ts`'s union. An explicit boolean `retryable` is believed either
 * way, because only the controller saw the provider error; the status is the
 * fallback only when it is absent or not a boolean. Preferring `status >= 500`
 * over an explicit `false` would retry faults no retry can clear.
 */
function failureFromEnvelope(body: unknown, status: number): ControllerFailure {
  const category = field(body, "category");
  const message = stringField(body, "message");
  const retryable = field(body, "retryable");
  return new ControllerFailure(
    isFailureCategory(category) ? category : "unknown",
    message ?? "The sandbox controller reported a failure.",
    typeof retryable === "boolean" ? retryable : status >= 500,
  );
}

export function createModalSandboxDriver(options: ModalSandboxDriverOptions): SandboxDriver {
  const { settings, credential } = options;

  function headers(): Headers {
    const sent = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${settings.controllerToken}`,
      "x-oncue-modal-token-id": credential.tokenId,
      "x-oncue-modal-token-secret": credential.tokenSecret,
    });
    if (credential.environmentName !== null) {
      sent.set("x-oncue-modal-environment", credential.environmentName);
    }
    return sent;
  }

  async function call(
    operation: SandboxOperation,
    body: unknown,
    timeoutMs: number = options.timeoutMs,
  ): Promise<unknown> {
    // Built before the try: a credential a header cannot carry is a
    // configuration fault, not a retryable network problem.
    const sent = headers();
    let response: Response;
    try {
      response = await options.fetchImpl(`${settings.origin}/v1/${operation}`, {
        method: "POST",
        headers: sent,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // A timeout and a refused connection are the same answer; `getStatus`
      // finds out. The thrown error is not reported: it can carry the request
      // headers, two of which are credentials.
      throw new ControllerFailure("unknown", "The sandbox controller did not answer.", true);
    }

    const parsed = safeJsonParse(await response.text());
    if (response.status === 401) {
      // A controller that rejects this deployment's token is a configuration
      // fault whatever the body says.
      throw new ControllerFailure(
        "credentials",
        "The sandbox controller rejected this deployment's credential.",
        false,
      );
    }
    if (!parsed.ok) {
      throw new ControllerFailure(
        "unknown",
        "The sandbox controller answered with something this driver cannot read.",
        response.status >= 500,
      );
    }
    const kind = field(parsed.value, "kind");
    if (kind === "error") {
      throw failureFromEnvelope(parsed.value, response.status);
    }
    if (kind !== "ok") {
      malformed();
    }
    return field(parsed.value, "value");
  }

  function referenceBody(reference: SandboxReference): SandboxReference {
    return { sessionId: reference.sessionId, generation: reference.generation };
  }

  async function lifecycle(
    operation: SandboxOperation,
    reference: SandboxReference,
  ): Promise<DriverOutcome<SandboxReference>> {
    return attempt(async () => {
      await call(operation, referenceBody(reference));
      return reference;
    }, toDriverOutcome);
  }

  const createTimeoutMs = options.createTimeoutMs ?? CREATE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async prepareImage(waitMs: number): Promise<DriverOutcome<ImagePreparation>> {
      return attempt(async () => {
        const value = await call("prepareImage", { waitMs }, waitMs + PREPARE_MARGIN_MS);
        const preparation = readPreparation(value);
        if (preparation === null) {
          malformed();
        }
        return preparation;
      }, toDriverOutcome);
    },

    async create(spec: SandboxCreateSpec): Promise<DriverOutcome<SandboxReference>> {
      return attempt(async () => {
        const notAfter =
          spec.notAfter ??
          new Date(now() + createTimeoutMs - CREATE_NOT_AFTER_MARGIN_MS).toISOString();
        await call("create", { ...spec, notAfter }, createTimeoutMs);
        return { sessionId: spec.sessionId, generation: spec.generation };
      }, toDriverOutcome);
    },

    async start(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return lifecycle("start", reference);
    },

    async stop(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return lifecycle("stop", reference);
    },

    async destroy(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return lifecycle("destroy", reference);
    },

    async getStatus(reference: SandboxReference): Promise<DriverOutcome<SandboxState>> {
      return attempt(async () => {
        const value = await call("getStatus", referenceBody(reference));
        const state = readSandboxState(value);
        if (state === null) {
          malformed();
        }
        return state;
      }, toDriverOutcome);
    },

    async execute(
      reference: SandboxReference,
      command: SandboxCommand,
    ): Promise<DriverOutcome<SandboxExecutionRef>> {
      return attempt(async () => {
        const value = await call("execute", {
          reference: referenceBody(reference),
          command: { commandLine: command.commandLine, timeoutMs: command.timeoutMs },
        });
        const executionId = stringField(value, "executionId");
        if (executionId === null) {
          malformed();
        }
        return { reference, executionId };
      }, toDriverOutcome);
    },

    async getConnection(reference: SandboxReference): Promise<DriverOutcome<SandboxConnection>> {
      return attempt(async () => {
        const value = await call("getConnection", referenceBody(reference));
        const bridgeUrl = stringField(value, "bridgeUrl");
        if (bridgeUrl === null) {
          malformed();
        }
        // The controller returns and holds no credential; the object kept only
        // the bootstrap credential's hash.
        return { reference, bridgeUrl };
      }, toDriverOutcome);
    },

    async createCheckpoint(
      reference: SandboxReference,
    ): Promise<DriverOutcome<SandboxCheckpointRef>> {
      return attempt(async () => {
        const value = await call("createCheckpoint", referenceBody(reference));
        const checkpointId = stringField(value, "checkpointId");
        if (checkpointId === null) {
          malformed();
        }
        return { reference, checkpointId };
      }, toDriverOutcome);
    },

    async getOutput(
      reference: SandboxReference,
      since: string | null,
    ): Promise<DriverOutcome<SandboxOutput>> {
      return attempt(async () => {
        const value = await call("getOutput", { reference: referenceBody(reference), since });
        const output = readOutput(value);
        if (output === null) {
          malformed();
        }
        return output;
      }, toDriverOutcome);
    },
  };
}
