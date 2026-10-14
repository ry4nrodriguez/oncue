import { describe, expect, it } from "vitest";
import type {
  SandboxCreateSpec,
  SandboxDriver,
  SandboxOperation,
  SandboxReference,
} from "./driver";
import type { BridgeSocketSink, FailureInjection } from "./fake-driver";
import { createFakeSandboxDriver } from "./fake-driver";

class RecordingSink implements BridgeSocketSink {
  readonly opened: SandboxReference[] = [];

  openBridgeSocket(reference: SandboxReference): void {
    this.opened.push(reference);
  }
}

class ThrowingSink implements BridgeSocketSink {
  openBridgeSocket(): void {
    throw new Error("socket refused");
  }
}

function makeSpec(overrides: Partial<SandboxCreateSpec> = {}): SandboxCreateSpec {
  return {
    sessionId: "sess_1",
    generation: 1,
    imageReference: "image:base",
    resourceClass: "standard",
    regionPreference: null,
    expirationPolicy: "idle_20m",
    bootstrapCredential: "bootstrap_1",
    ...overrides,
  };
}

function makeDriver(failures: FailureInjection = {}, sink: BridgeSocketSink = new RecordingSink()) {
  return createFakeSandboxDriver({ failures, sink });
}

describe("createFakeSandboxDriver: prepareImage", () => {
  it("has no image to build, so it is always ready", async () => {
    await expect(makeDriver().prepareImage(0)).resolves.toEqual({
      kind: "ok",
      value: { state: "ready", imageReference: "fake" },
    });
  });
});

describe("createFakeSandboxDriver: create", () => {
  it("creates a sandbox in the requested state", async () => {
    const driver = makeDriver();
    const outcome = await driver.create(makeSpec());

    expect(outcome).toEqual({
      kind: "ok",
      value: { sessionId: "sess_1", generation: 1 },
    });
  });

  it("is idempotent on (sessionId, generation): a second create returns the same reference", async () => {
    const driver = makeDriver();
    const first = await driver.create(makeSpec());
    const second = await driver.create(makeSpec());

    expect(first).toEqual(second);
  });

  it("treats a different generation as a different sandbox", async () => {
    const driver = makeDriver();
    await driver.create(makeSpec({ generation: 1 }));
    const outcome = await driver.create(makeSpec({ generation: 2 }));

    expect(outcome).toEqual({ kind: "ok", value: { sessionId: "sess_1", generation: 2 } });
  });
});

describe("createFakeSandboxDriver: lifecycle on an existing sandbox", () => {
  async function created(): Promise<{
    driver: SandboxDriver;
    reference: SandboxReference;
    sink: RecordingSink;
  }> {
    const sink = new RecordingSink();
    const driver = makeDriver({}, sink);
    const outcome = await driver.create(makeSpec());
    if (outcome.kind !== "ok") {
      throw new Error("setup: create failed");
    }
    return { driver, reference: outcome.value, sink };
  }

  it("start opens the bridge socket and reports active", async () => {
    const { driver, reference, sink } = await created();

    const outcome = await driver.start(reference);

    expect(outcome).toEqual({ kind: "ok", value: reference });
    expect(sink.opened).toEqual([reference]);

    const status = await driver.getStatus(reference);
    expect(status).toEqual({ kind: "ok", value: "active" });
  });

  it("stop reports stopped", async () => {
    const { driver, reference } = await created();
    await driver.start(reference);

    const outcome = await driver.stop(reference);

    expect(outcome).toEqual({ kind: "ok", value: reference });
    expect(await driver.getStatus(reference)).toEqual({ kind: "ok", value: "stopped" });
  });

  it("destroy removes the sandbox so a later getStatus reports not_found", async () => {
    const { driver, reference } = await created();

    const outcome = await driver.destroy(reference);
    expect(outcome).toEqual({ kind: "ok", value: reference });

    const status = await driver.getStatus(reference);
    expect(status).toEqual({
      kind: "error",
      category: "not_found",
      message: `no sandbox for session ${reference.sessionId} generation ${reference.generation}`,
      retryable: false,
    });
  });

  it("execute returns an execution reference for the sandbox", async () => {
    const { driver, reference } = await created();

    const outcome = await driver.execute(reference, {
      commandLine: "pnpm test",
      timeoutMs: 60_000,
    });

    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" && outcome.value.reference).toEqual(reference);
  });

  it("getConnection returns bridge connection details", async () => {
    const { driver, reference } = await created();

    const outcome = await driver.getConnection(reference);

    expect(outcome).toEqual({
      kind: "ok",
      value: {
        reference,
        bridgeUrl: `fake://sandbox/${reference.sessionId}/${reference.generation}`,
      },
    });
  });

  it("createCheckpoint returns a checkpoint reference", async () => {
    const { driver, reference } = await created();

    const outcome = await driver.createCheckpoint(reference);

    expect(outcome).toEqual({
      kind: "ok",
      value: { reference, checkpointId: `ckpt_${reference.sessionId}_${reference.generation}` },
    });
  });

  /** The fake prints nothing and says so; it never invents a bridge's words. */
  it("getOutput answers no lines, echoing the cursor it was given or minting one", async () => {
    const { driver, reference } = await created();

    await expect(driver.getOutput(reference, "2026-09-10T00:00:00.000Z")).resolves.toEqual({
      kind: "ok",
      value: { lines: [], next: "2026-09-10T00:00:00.000Z" },
    });
    const fresh = await driver.getOutput(reference, null);
    expect(fresh.kind === "ok" && fresh.value.lines).toEqual([]);
    expect(fresh.kind === "ok" && typeof fresh.value.next).toBe("string");
  });
});

describe("createFakeSandboxDriver: not_found on an unknown reference", () => {
  const reference: SandboxReference = { sessionId: "sess_missing", generation: 1 };

  const cases: ReadonlyArray<{
    readonly operation: string;
    readonly run: (driver: SandboxDriver) => Promise<{ kind: string }>;
  }> = [
    { operation: "start", run: (driver) => driver.start(reference) },
    { operation: "getStatus", run: (driver) => driver.getStatus(reference) },
    {
      operation: "execute",
      run: (driver) => driver.execute(reference, { commandLine: "x", timeoutMs: 1 }),
    },
    { operation: "getConnection", run: (driver) => driver.getConnection(reference) },
    { operation: "createCheckpoint", run: (driver) => driver.createCheckpoint(reference) },
    { operation: "getOutput", run: (driver) => driver.getOutput(reference, null) },
  ];

  for (const testCase of cases) {
    it(`${testCase.operation} fails with not_found`, async () => {
      const driver = makeDriver();
      const outcome = await testCase.run(driver);
      expect(outcome).toEqual({
        kind: "error",
        category: "not_found",
        message: `no sandbox for session ${reference.sessionId} generation ${reference.generation}`,
        retryable: false,
      });
    });
  }

  // Like the real controller: the object builds a driver per call, so a user
  // stop always reaches an instance that never saw the create.
  it("stop and destroy succeed on an unknown reference", async () => {
    const driver = makeDriver();
    await expect(driver.stop(reference)).resolves.toEqual({ kind: "ok", value: reference });
    await expect(driver.destroy(reference)).resolves.toEqual({ kind: "ok", value: reference });
  });
});

describe("createFakeSandboxDriver: failure injection", () => {
  const failure = { category: "capacity", message: "no capacity", retryable: true } as const;
  const reference: SandboxReference = { sessionId: "sess_1", generation: 1 };

  const operations: readonly SandboxOperation[] = [
    "prepareImage",
    "create",
    "start",
    "stop",
    "destroy",
    "getStatus",
    "execute",
    "getConnection",
    "createCheckpoint",
    "getOutput",
  ];

  for (const operation of operations) {
    it(`can fail at ${operation}`, async () => {
      const driver = makeDriver({ [operation]: failure });

      const outcome = await (operation === "create"
        ? driver.create(makeSpec())
        : operation === "execute"
          ? driver.execute(reference, { commandLine: "x", timeoutMs: 1 })
          : (driver[operation] as (reference: SandboxReference) => Promise<{ kind: string }>)(
              reference,
            ));

      expect(outcome).toEqual({
        kind: "error",
        category: "capacity",
        message: "no capacity",
        retryable: true,
      });
    });
  }
});

describe("createFakeSandboxDriver: an error the injection table did not produce", () => {
  it("falls back to the unknown category instead of losing the failure", async () => {
    const driver = makeDriver({}, new ThrowingSink());
    const outcome = await driver.create(makeSpec());
    if (outcome.kind !== "ok") {
      throw new Error("setup: create failed");
    }

    const started = await driver.start(outcome.value);

    expect(started).toEqual({
      kind: "error",
      category: "unknown",
      message: "Error: socket refused",
      retryable: false,
    });
  });
});
