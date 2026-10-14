// Record 02's SandboxDriver boundary: the operations the platform needs from a
// sandbox provider, with no knowledge of Modal or HTTP. `fake-driver.ts` and
// `modal-driver.ts` implement it and `select.ts` chooses one.
//
// Every failure is a `DriverOutcome` value with a stable category and a
// retryable flag (record 02). `attempt` is the only `try`/`catch` under
// `worker/sandbox/`.

import type { SandboxState } from "@oncue/protocol";

/** A sandbox is identified by (sessionId, generation), so operations are idempotent; no caller invents a provider id. */
export interface SandboxReference {
  readonly sessionId: string;
  readonly generation: number;
}

/** Record 02, "Prepare". */
export interface SandboxCreateSpec {
  readonly sessionId: string;
  readonly generation: number;
  readonly imageReference: string;
  readonly resourceClass: string;
  readonly regionPreference: string | null;
  readonly expirationPolicy: string;
  /** Random per generation, minted by the session object; only its hash is stored. */
  readonly bootstrapCredential: string;
  /**
   * ISO-8601: the latest moment the provider may start this sandbox. The
   * object records it, so its stop sweep can outwait a create still in flight.
   */
  readonly notAfter?: string;
}

export interface SandboxCommand {
  readonly commandLine: string;
  readonly timeoutMs: number;
}

export interface SandboxExecutionRef {
  readonly reference: SandboxReference;
  readonly executionId: string;
}

/**
 * Bridge connection details, not a live socket (record 02). No credential: the
 * bootstrap credential is handed to `create` once and kept nowhere the driver
 * can read it back.
 */
export interface SandboxConnection {
  readonly reference: SandboxReference;
  readonly bridgeUrl: string;
}

export interface SandboxCheckpointRef {
  readonly reference: SandboxReference;
  readonly checkpointId: string;
}

/** One line the sandbox's entrypoint printed, as the provider recorded it. */
export interface SandboxOutputLine {
  readonly stream: "stdout" | "stderr" | "system";
  readonly at: string;
  readonly text: string;
}

/**
 * Output since a cursor, and the next cursor. Before the bridge's first frame,
 * the entrypoint's output is the only thing that can say why it did not
 * connect. Untrusted text: relayed, never acted on.
 */
export interface SandboxOutput {
  readonly lines: readonly SandboxOutputLine[];
  readonly next: string;
}

/**
 * Record 02's "Prepare": the base image, built in the workspace that will run
 * the sandbox. `ready` names the image `create` should start from; `building`
 * means a build is under way and the caller asks again.
 */
export type ImagePreparation =
  | { readonly state: "ready"; readonly imageReference: string }
  | { readonly state: "building" };

/** Stable categories, not provider-shaped errors (record 02). */
export type DriverFailureCategory =
  | "capacity"
  | "configuration"
  | "image_preparation"
  | "credentials"
  | "repository_setup"
  | "not_found"
  | "conflict"
  | "unknown";

export type DriverOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "error";
      readonly category: DriverFailureCategory;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface SandboxDriver {
  /** Idempotent; waits at most `waitMs` for a build already under way. */
  prepareImage(waitMs: number): Promise<DriverOutcome<ImagePreparation>>;
  create(spec: SandboxCreateSpec): Promise<DriverOutcome<SandboxReference>>;
  start(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>>;
  stop(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>>;
  destroy(reference: SandboxReference): Promise<DriverOutcome<SandboxReference>>;
  getStatus(reference: SandboxReference): Promise<DriverOutcome<SandboxState>>;
  execute(
    reference: SandboxReference,
    command: SandboxCommand,
  ): Promise<DriverOutcome<SandboxExecutionRef>>;
  getConnection(reference: SandboxReference): Promise<DriverOutcome<SandboxConnection>>;
  createCheckpoint(reference: SandboxReference): Promise<DriverOutcome<SandboxCheckpointRef>>;
  getOutput(
    reference: SandboxReference,
    since: string | null,
  ): Promise<DriverOutcome<SandboxOutput>>;
}

/** Derived, so a new `SandboxDriver` method is automatically a new operation. */
export type SandboxOperation = keyof SandboxDriver;

/** The one translation point from a thrown error to a `DriverOutcome`. */
export async function attempt<T>(
  run: () => Promise<T>,
  onError: (error: unknown) => DriverOutcome<T>,
): Promise<DriverOutcome<T>> {
  try {
    return { kind: "ok", value: await run() };
  } catch (error) {
    return onError(error);
  }
}
