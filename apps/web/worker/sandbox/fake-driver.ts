// An in-memory `SandboxDriver` for tests and local sessions without Modal
// (record 02). Failures are injected through one table keyed by
// `SandboxOperation`. `create` is idempotent on (sessionId, generation).

import type { SandboxState } from "@oncue/protocol";
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
  type SandboxReference,
} from "./driver";

export type SandboxFailure = {
  readonly category: DriverFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
};

export type FailureInjection = Partial<Record<SandboxOperation, SandboxFailure>>;

/** Receives the bridge connection at `start`, where the bridge reports health to the session object (record 02). */
export interface BridgeSocketSink {
  openBridgeSocket(reference: SandboxReference): void;
}

export interface FakeSandboxDriverOptions {
  readonly failures: FailureInjection;
  readonly sink: BridgeSocketSink;
}

class FakeDriverFailure extends Error {
  readonly category: DriverFailureCategory;
  readonly retryable: boolean;

  constructor(failure: SandboxFailure) {
    super(failure.message);
    this.category = failure.category;
    this.retryable = failure.retryable;
  }
}

function toDriverOutcome(error: unknown): DriverOutcome<never> {
  if (error instanceof FakeDriverFailure) {
    return {
      kind: "error",
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    kind: "error",
    category: "unknown",
    message: String(error),
    retryable: false,
  };
}

function notFound(reference: SandboxReference): never {
  throw new FakeDriverFailure({
    category: "not_found",
    message: `no sandbox for session ${reference.sessionId} generation ${reference.generation}`,
    retryable: false,
  });
}

interface SandboxRecord {
  readonly reference: SandboxReference;
  status: SandboxState;
}

export function createFakeSandboxDriver(options: FakeSandboxDriverOptions): SandboxDriver {
  let records: readonly SandboxRecord[] = [];

  function find(reference: SandboxReference): SandboxRecord | undefined {
    return records.find(
      (record) =>
        record.reference.sessionId === reference.sessionId &&
        record.reference.generation === reference.generation,
    );
  }

  function injectedFailure(operation: SandboxOperation): SandboxFailure | undefined {
    return options.failures[operation];
  }

  function throwIfInjected(operation: SandboxOperation): void {
    const failure = injectedFailure(operation);
    if (failure !== undefined) {
      throw new FakeDriverFailure(failure);
    }
  }

  return {
    // The fake has no image to build.
    async prepareImage(): Promise<DriverOutcome<ImagePreparation>> {
      return attempt(async () => {
        throwIfInjected("prepareImage");
        return { state: "ready", imageReference: "fake" };
      }, toDriverOutcome);
    },

    async create(spec: SandboxCreateSpec): Promise<DriverOutcome<SandboxReference>> {
      return attempt(async () => {
        throwIfInjected("create");
        const reference: SandboxReference = {
          sessionId: spec.sessionId,
          generation: spec.generation,
        };
        const existing = find(reference);
        if (existing !== undefined) {
          return existing.reference;
        }
        records = [...records, { reference, status: "requested" }];
        return reference;
      }, toDriverOutcome);
    },

    async start(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return attempt(async () => {
        throwIfInjected("start");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        existing.status = "active";
        options.sink.openBridgeSocket(reference);
        return existing.reference;
      }, toDriverOutcome);
    },

    // Stop and destroy converge ("absent is success"), like the real
    // controller: the object builds a driver per call, so a user stop always
    // reaches an instance that never saw the create.
    async stop(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return attempt(async () => {
        throwIfInjected("stop");
        const existing = find(reference);
        if (existing !== undefined) {
          existing.status = "stopped";
        }
        return reference;
      }, toDriverOutcome);
    },

    async destroy(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>> {
      return attempt(async () => {
        throwIfInjected("destroy");
        records = records.filter(
          (record) =>
            record.reference.sessionId !== reference.sessionId ||
            record.reference.generation !== reference.generation,
        );
        return reference;
      }, toDriverOutcome);
    },

    async getStatus(reference: SandboxReference): Promise<DriverOutcome<SandboxState>> {
      return attempt(async () => {
        throwIfInjected("getStatus");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        return existing.status;
      }, toDriverOutcome);
    },

    async execute(
      reference: SandboxReference,
      command: SandboxCommand,
    ): Promise<DriverOutcome<SandboxExecutionRef>> {
      return attempt(async () => {
        throwIfInjected("execute");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        return {
          reference: existing.reference,
          executionId: `exec_${existing.reference.sessionId}_${existing.reference.generation}_${command.commandLine.length}`,
        };
      }, toDriverOutcome);
    },

    async getConnection(reference: SandboxReference): Promise<DriverOutcome<SandboxConnection>> {
      return attempt(async () => {
        throwIfInjected("getConnection");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        return {
          reference: existing.reference,
          bridgeUrl: `fake://sandbox/${existing.reference.sessionId}/${existing.reference.generation}`,
        };
      }, toDriverOutcome);
    },

    async createCheckpoint(
      reference: SandboxReference,
    ): Promise<DriverOutcome<SandboxCheckpointRef>> {
      return attempt(async () => {
        throwIfInjected("createCheckpoint");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        return {
          reference: existing.reference,
          checkpointId: `ckpt_${existing.reference.sessionId}_${existing.reference.generation}`,
        };
      }, toDriverOutcome);
    },

    // The fake prints nothing rather than inventing lines: a double must never
    // cover for a bridge that had nothing to say.
    async getOutput(
      reference: SandboxReference,
      since: string | null,
    ): Promise<DriverOutcome<SandboxOutput>> {
      return attempt(async () => {
        throwIfInjected("getOutput");
        const existing = find(reference);
        if (existing === undefined) {
          notFound(reference);
        }
        return { lines: [], next: since ?? new Date().toISOString() };
      }, toDriverOutcome);
    },
  };
}
