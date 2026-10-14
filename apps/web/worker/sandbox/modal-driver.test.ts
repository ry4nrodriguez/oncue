import { describe, expect, it } from "vitest";
import type { ModalCredential } from "../modal/client";
import type { SandboxCreateSpec, SandboxReference } from "./driver";
import {
  CREATE_NOT_AFTER_MARGIN_MS,
  CREATE_TIMEOUT_MS,
  createModalSandboxDriver,
  DEFAULT_CONTROLLER_TIMEOUT_MS,
} from "./modal-driver";
import type { ControllerSettings } from "./origin";

/** OnCue's own settings. No Modal authority lives in them. */
const SETTINGS: ControllerSettings = {
  origin: "https://oncue--controller.modal.run",
  controllerToken: "controller-token-value",
};

/** The workspace's own pair, per session rather than per deploy. */
const CREDENTIAL: ModalCredential = {
  tokenId: "ak-modal-token-id",
  tokenSecret: "as-modal-token-secret",
  environmentName: null,
};

const REFERENCE: SandboxReference = { sessionId: "sess_1", generation: 3 };

const SPEC: SandboxCreateSpec = {
  sessionId: "sess_1",
  generation: 3,
  imageReference: "oncue-base:1",
  resourceClass: "standard",
  regionPreference: null,
  expirationPolicy: "idle_20m",
  bootstrapCredential: "boot_sess_1_3",
};

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Answer = Response | Error;

/** Records requests without printing them: two headers are credentials. */
function controllerDouble(answers: Answer[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, headers, body: String(init.body) });
    const next = answers[calls.length - 1];
    if (next === undefined) {
      throw new Error("the driver called the controller more times than the test scripted");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function ok(value: unknown): Response {
  return new Response(JSON.stringify({ kind: "ok", value }), { status: 200 });
}

function failed(
  status: number,
  body: Record<string, unknown> = {
    kind: "error",
    category: "capacity",
    message: "Modal has no capacity for this sandbox right now.",
    retryable: true,
  },
): Response {
  return new Response(JSON.stringify(body), { status });
}

const NOW_MS = Date.parse("2026-10-01T00:00:00.000Z");

function driverOver(
  answers: Answer[],
  credential: ModalCredential = CREDENTIAL,
  createTimeoutMs?: number,
) {
  const double = controllerDouble(answers);
  return {
    driver: createModalSandboxDriver({
      settings: SETTINGS,
      credential,
      fetchImpl: double.fetchImpl,
      timeoutMs: DEFAULT_CONTROLLER_TIMEOUT_MS,
      now: () => NOW_MS,
      ...(createTimeoutMs === undefined ? {} : { createTimeoutMs }),
    }),
    calls: double.calls,
  };
}

describe("createModalSandboxDriver: the request the controller receives", () => {
  it("sends both credentials as headers, and neither in the URL or the body", async () => {
    const { driver, calls } = driverOver([ok({})]);

    await driver.create(SPEC);

    const call = calls[0];
    if (call === undefined) {
      throw new Error("expected one controller call");
    }
    expect(call.url).toBe("https://oncue--controller.modal.run/v1/create");
    expect(call.headers.authorization).toBe("Bearer controller-token-value");
    expect(call.headers["x-oncue-modal-token-id"]).toBe("ak-modal-token-id");
    expect(call.headers["x-oncue-modal-token-secret"]).toBe("as-modal-token-secret");
    for (const secret of [SETTINGS.controllerToken, CREDENTIAL.tokenId, CREDENTIAL.tokenSecret]) {
      expect(call.url).not.toContain(secret);
      expect(call.body).not.toContain(secret);
    }
  });

  it("omits the environment header when the workspace default is wanted", async () => {
    const { driver, calls } = driverOver([ok({})]);

    await driver.start(REFERENCE);

    expect(calls[0]?.headers["x-oncue-modal-environment"]).toBeUndefined();
  });

  it("sends the environment header when the workspace named one", async () => {
    const { driver, calls } = driverOver([ok({})], { ...CREDENTIAL, environmentName: "staging" });

    await driver.start(REFERENCE);

    expect(calls[0]?.headers["x-oncue-modal-environment"]).toBe("staging");
  });

  it("posts the reference alone for the operations that take one", async () => {
    const { driver, calls } = driverOver([ok({}), ok({}), ok("active")]);

    await driver.stop(REFERENCE);
    await driver.destroy(REFERENCE);
    await driver.getStatus(REFERENCE);

    expect(calls.map((call) => call.url)).toEqual([
      "https://oncue--controller.modal.run/v1/stop",
      "https://oncue--controller.modal.run/v1/destroy",
      "https://oncue--controller.modal.run/v1/getStatus",
    ]);
    for (const call of calls) {
      expect(JSON.parse(call.body)).toEqual({ sessionId: "sess_1", generation: 3 });
    }
  });
});

describe("createModalSandboxDriver: the eight operations", () => {
  it("returns the caller's own reference from the lifecycle operations", async () => {
    const { driver } = driverOver([ok({}), ok({}), ok({}), ok({})]);

    for (const outcome of [
      await driver.create(SPEC),
      await driver.start(REFERENCE),
      await driver.stop(REFERENCE),
      await driver.destroy(REFERENCE),
    ]) {
      expect(outcome).toEqual({ kind: "ok", value: REFERENCE });
    }
  });

  it("reads a status the protocol knows", async () => {
    const { driver } = driverOver([ok("stopped")]);

    await expect(driver.getStatus(REFERENCE)).resolves.toEqual({ kind: "ok", value: "stopped" });
  });

  it("returns an execution handle", async () => {
    const { driver, calls } = driverOver([ok({ executionId: "sb-1-abcdef" })]);

    await expect(
      driver.execute(REFERENCE, { commandLine: "pnpm test", timeoutMs: 5000 }),
    ).resolves.toEqual({ kind: "ok", value: { reference: REFERENCE, executionId: "sb-1-abcdef" } });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      reference: { sessionId: "sess_1", generation: 3 },
      command: { commandLine: "pnpm test", timeoutMs: 5000 },
    });
  });

  it("returns the controller's address for the sandbox and no credential", async () => {
    // The controller returns and holds no credential; the object kept only the
    // bootstrap credential's hash.
    const { driver } = driverOver([ok({ bridgeUrl: "modal://oncue-sessions/sb-1" })]);

    await expect(driver.getConnection(REFERENCE)).resolves.toEqual({
      kind: "ok",
      value: {
        reference: REFERENCE,
        bridgeUrl: "modal://oncue-sessions/sb-1",
      },
    });
  });

  it("returns a checkpoint handle", async () => {
    const { driver } = driverOver([ok({ checkpointId: "im-snapshot" })]);

    await expect(driver.createCheckpoint(REFERENCE)).resolves.toEqual({
      kind: "ok",
      value: { reference: REFERENCE, checkpointId: "im-snapshot" },
    });
  });

  it("relays the sandbox's output lines and the cursor, sending the reference and cursor it was given", async () => {
    const lines = [
      { stream: "stdout", at: "2026-09-10T00:00:01.000Z", text: "bridge starting" },
      {
        stream: "stderr",
        at: "2026-09-10T00:00:02.000Z",
        text: "bridge could not reach the control plane",
      },
    ];
    const { driver, calls } = driverOver([ok({ lines, next: "2026-09-10T00:00:02.000001Z" })]);

    await expect(driver.getOutput(REFERENCE, "2026-09-10T00:00:00.000Z")).resolves.toEqual({
      kind: "ok",
      value: { lines, next: "2026-09-10T00:00:02.000001Z" },
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      reference: REFERENCE,
      since: "2026-09-10T00:00:00.000Z",
    });
  });
});

describe("createModalSandboxDriver: preparing the image and creating from it", () => {
  it("asks for the image with the wait it was given and reads a ready answer", async () => {
    const { driver, calls } = driverOver([ok({ state: "ready", imageReference: "im-1" })]);

    const prepared = await driver.prepareImage(20_000);

    expect(prepared).toEqual({ kind: "ok", value: { state: "ready", imageReference: "im-1" } });
    expect(calls[0]?.url).toBe("https://oncue--controller.modal.run/v1/prepareImage");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ waitMs: 20_000 });
  });

  it("reads a building answer", async () => {
    const { driver } = driverOver([ok({ state: "building", imageVersion: "v1" })]);

    await expect(driver.prepareImage(0)).resolves.toEqual({
      kind: "ok",
      value: { state: "building" },
    });
  });

  it.each([
    ["a ready answer with no image", ok({ state: "ready" })],
    ["a state it does not know", ok({ state: "baking" })],
    ["no value", ok(null)],
  ])("refuses %s", async (_name, answer) => {
    const { driver } = driverOver([answer]);

    await expect(driver.prepareImage(0)).resolves.toMatchObject({
      kind: "error",
      category: "unknown",
    });
  });

  it("sends a deadline that ends before its own wait does, so the controller gives up first", async () => {
    const { driver, calls } = driverOver([ok({})], CREDENTIAL, 45_000);

    await driver.create(SPEC);

    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      ...SPEC,
      notAfter: new Date(NOW_MS + 45_000 - CREATE_NOT_AFTER_MARGIN_MS).toISOString(),
    });
  });

  it("gives a create the longer default deadline", async () => {
    const { driver, calls } = driverOver([ok({})]);

    await driver.create(SPEC);

    expect(JSON.parse(calls[0]?.body ?? "{}").notAfter).toBe(
      new Date(NOW_MS + CREATE_TIMEOUT_MS - CREATE_NOT_AFTER_MARGIN_MS).toISOString(),
    );
  });

  it("sends the deadline the caller recorded, when it gives one", async () => {
    const { driver, calls } = driverOver([ok({})]);
    const notAfter = "2026-10-01T00:00:30.000Z";

    await driver.create({ ...SPEC, notAfter });

    expect(JSON.parse(calls[0]?.body ?? "{}").notAfter).toBe(notAfter);
  });

  it("uses the clock when none is given", async () => {
    const double = controllerDouble([ok({})]);
    const driver = createModalSandboxDriver({
      settings: SETTINGS,
      credential: CREDENTIAL,
      fetchImpl: double.fetchImpl,
      timeoutMs: DEFAULT_CONTROLLER_TIMEOUT_MS,
    });

    await driver.create(SPEC);

    expect(Date.parse(JSON.parse(double.calls[0]?.body ?? "{}").notAfter)).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe("createModalSandboxDriver: a controller that does not answer", () => {
  it("reports a timeout as retryable and unknown, because the sandbox may exist", async () => {
    const { driver } = driverOver([new DOMException("The operation was aborted", "TimeoutError")]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "unknown",
      message: "The sandbox controller did not answer.",
      retryable: true,
    });
  });

  it("says nothing about the failure, because a fetch error can carry the request headers", async () => {
    const { driver } = driverOver([
      new Error(`connect ECONNREFUSED authorization: Bearer ${SETTINGS.controllerToken}`),
    ]);

    const outcome = await driver.start(REFERENCE);

    expect(JSON.stringify(outcome)).not.toContain(SETTINGS.controllerToken);
  });

  it("reconciles through getStatus after a lost response", async () => {
    // The create's answer never arrived, so `getStatus` finds out (record 02).
    const { driver, calls } = driverOver([new Error("socket hang up"), ok("active")]);

    const created = await driver.create(SPEC);
    const status = await driver.getStatus(REFERENCE);

    expect(created).toMatchObject({ kind: "error", retryable: true });
    expect(status).toEqual({ kind: "ok", value: "active" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://oncue--controller.modal.run/v1/create",
      "https://oncue--controller.modal.run/v1/getStatus",
    ]);
  });
});

describe("createModalSandboxDriver: a controller that refuses", () => {
  it("reports a 401 as a credential failure without reading the body", async () => {
    const { driver } = driverOver([
      new Response("<html>an edge proxy wrote this</html>", { status: 401 }),
    ]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "credentials",
      message: "The sandbox controller rejected this deployment's credential.",
      retryable: false,
    });
  });

  it("passes a categorised failure through unchanged", async () => {
    const { driver } = driverOver([failed(503)]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "capacity",
      message: "Modal has no capacity for this sandbox right now.",
      retryable: true,
    });
  });

  it("does not let a controller a release ahead widen the category union", async () => {
    const { driver } = driverOver([
      failed(500, { kind: "error", category: "quota_exceeded", message: "new", retryable: false }),
    ]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({
      category: "unknown",
      message: "new",
    });
  });

  it("does not trust a category that is not even a string", async () => {
    const { driver } = driverOver([failed(500, { kind: "error", category: 7, retryable: false })]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({ category: "unknown" });
  });

  it("supplies a message when the envelope has none", async () => {
    const { driver } = driverOver([failed(409, { kind: "error", category: "conflict" })]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "conflict",
      message: "The sandbox controller reported a failure.",
      retryable: false,
    });
  });

  it("treats a server-side status as retryable when the envelope does not say", async () => {
    const { driver } = driverOver([failed(500, { kind: "error", category: "unknown" })]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({ retryable: true });
  });

  it("believes an explicit `retryable: false` even on a server-side status", async () => {
    // `errors.py` answers these with 500 and `retryable: false`: a broken image
    // will not build on retry, so the flag wins over the status.
    const { driver } = driverOver([
      failed(500, {
        kind: "error",
        category: "image_preparation",
        message: "The sandbox image did not build.",
        retryable: false,
      }),
    ]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "image_preparation",
      message: "The sandbox image did not build.",
      retryable: false,
    });
  });

  it("believes an explicit `retryable: true` on a client-side status", async () => {
    const { driver } = driverOver([
      failed(409, { kind: "error", category: "conflict", message: "raced", retryable: true }),
    ]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({ retryable: true });
  });

  it("falls back to the status when `retryable` is present but not a boolean", async () => {
    // A non-boolean flag is unreadable, so only the status is left.
    const { driver } = driverOver([
      failed(500, { kind: "error", category: "unknown", retryable: "yes" }),
    ]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({ retryable: true });
  });
});

describe("createModalSandboxDriver: a credential the platform will not carry", () => {
  it("reports a configuration failure rather than letting the exception escape", async () => {
    // A token pasted with a newline: `new Headers` throws before any request,
    // so this must not read as a controller that did not answer.
    const { driver, calls } = driverOver([ok({})], {
      ...CREDENTIAL,
      tokenSecret: "as-modal\ntoken-secret",
    });

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "configuration",
      message: "The sandbox driver could not build a request the controller would accept.",
      retryable: false,
    });
    expect(calls).toEqual([]);
  });
});

describe("createModalSandboxDriver: an answer this driver cannot read", () => {
  it("refuses a body that is not JSON, retryable on a server-side status", async () => {
    const { driver } = driverOver([new Response("<html>502 Bad Gateway</html>", { status: 502 })]);

    await expect(driver.create(SPEC)).resolves.toEqual({
      kind: "error",
      category: "unknown",
      message: "The sandbox controller answered with something this driver cannot read.",
      retryable: true,
    });
  });

  it("refuses a body that is not JSON on a 200, without retrying it", async () => {
    const { driver } = driverOver([new Response("not json", { status: 200 })]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({ retryable: false });
  });

  it("refuses an envelope that is neither ok nor error", async () => {
    const { driver } = driverOver([new Response(JSON.stringify({ kind: "maybe" }))]);

    await expect(driver.create(SPEC)).resolves.toMatchObject({
      category: "unknown",
      message: "The sandbox controller answered with something this driver cannot read.",
    });
  });

  it.each([
    ["a state the protocol does not have", ok("banana")],
    ["a state that is not a string", ok(7)],
    ["no value at all", new Response(JSON.stringify({ kind: "ok" }))],
  ])("refuses %s from getStatus", async (_name, answer) => {
    const { driver } = driverOver([answer]);

    await expect(driver.getStatus(REFERENCE)).resolves.toMatchObject({ category: "unknown" });
  });

  it.each([
    ["a value that is not an object", ok("sb-1")],
    ["a null value", ok(null)],
    ["an object with the wrong field", ok({ id: "sb-1" })],
    ["a field of the wrong type", ok({ executionId: 7 })],
  ])("refuses %s from execute", async (_name, answer) => {
    const { driver } = driverOver([answer]);

    await expect(
      driver.execute(REFERENCE, { commandLine: "true", timeoutMs: 1000 }),
    ).resolves.toMatchObject({ category: "unknown" });
  });

  it("refuses a connection with no bridge URL", async () => {
    const { driver } = driverOver([ok({})]);

    await expect(driver.getConnection(REFERENCE)).resolves.toMatchObject({ category: "unknown" });
  });

  it("refuses a checkpoint with no id", async () => {
    const { driver } = driverOver([ok({})]);

    await expect(driver.createCheckpoint(REFERENCE)).resolves.toMatchObject({
      category: "unknown",
    });
  });

  it.each([
    ["no lines list", { next: "x" }],
    ["no cursor", { lines: [] }],
    [
      "a line with an unknown stream",
      { lines: [{ stream: "build", at: "t", text: "x" }], next: "x" },
    ],
    ["a line with no timestamp", { lines: [{ stream: "stdout", text: "x" }], next: "x" }],
    ["a line with no text", { lines: [{ stream: "stdout", at: "t" }], next: "x" }],
  ])("refuses output with %s", async (_name, value) => {
    const { driver } = driverOver([ok(value)]);

    await expect(driver.getOutput(REFERENCE, null)).resolves.toMatchObject({
      category: "unknown",
    });
  });
});
