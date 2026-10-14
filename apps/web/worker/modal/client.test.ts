import { describe, expect, it } from "vitest";
import {
  createModalCredentialTester,
  DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
  type ModalControllerAccess,
  type ModalCredential,
  parseControllerTestResponse,
} from "./client";

const ACCESS: ModalControllerAccess = {
  origin: "https://oncue--controller.modal.run",
  controllerToken: "controller-token-value",
};

const CREDENTIAL: ModalCredential = {
  tokenId: "ak-fake0001",
  tokenSecret: "as-fake0001",
  environmentName: null,
};

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Answer = Response | Error;

/** Records requests without printing them: two headers are halves of a credential. */
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
    calls.push({
      url,
      method: String(init.method),
      headers,
      body: init.body === undefined || init.body === null ? "" : String(init.body),
    });
    const next = answers[calls.length - 1];
    if (next === undefined) {
      throw new Error("the tester called the controller more times than the test scripted");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function testerOver(answers: Answer[]) {
  const double = controllerDouble(answers);
  return {
    test: createModalCredentialTester({
      access: ACCESS,
      fetchImpl: double.fetchImpl,
      timeoutMs: DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
    }),
    calls: double.calls,
  };
}

function ok(value: unknown): Response {
  return new Response(JSON.stringify({ kind: "ok", value }), { status: 200 });
}

function failed(reason: string): Response {
  return new Response(JSON.stringify({ kind: "failed", reason }), { status: 200 });
}

describe("parseControllerTestResponse", () => {
  it("reads a successful test", () => {
    expect(
      parseControllerTestResponse(200, {
        kind: "ok",
        value: { workspaceName: "acme-workspace", environments: ["main", "staging"] },
      }),
    ).toEqual({ kind: "ok", workspaceName: "acme-workspace", environments: ["main", "staging"] });
  });

  it("accepts an empty environment list on a success, because the controller decides that", () => {
    // The controller decides that "no environments" is a failure; the client
    // does not keep a second copy of the rule.
    expect(
      parseControllerTestResponse(200, {
        kind: "ok",
        value: { workspaceName: "acme-workspace", environments: [] },
      }),
    ).toEqual({ kind: "ok", workspaceName: "acme-workspace", environments: [] });
  });

  it.each(["invalid_credentials", "no_environment_access", "unreachable"] as const)(
    "reads the named failure %s",
    (reason) => {
      expect(parseControllerTestResponse(200, { kind: "failed", reason })).toEqual({
        kind: "failed",
        reason,
      });
    },
  );

  // A newer controller must not widen the closed set.
  it("flattens a reason this build does not know to unreachable", () => {
    expect(parseControllerTestResponse(200, { kind: "failed", reason: "quota_exceeded" })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    expect(parseControllerTestResponse(200, { kind: "failed" })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });

  it("answers a 401 from the status alone, blaming OnCue rather than the paste", () => {
    expect(
      parseControllerTestResponse(401, { kind: "failed", reason: "invalid_credentials" }),
    ).toEqual({ kind: "failed", reason: "controller_unavailable" });
  });

  it.each([500, 502, 404])("treats a %s as unreachable", (status) => {
    expect(parseControllerTestResponse(status, { kind: "ok", value: {} })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });

  it.each([
    ["a body that is not an object", undefined],
    ["a null body", null],
    ["an envelope with no kind", {}],
    ["a kind this build does not know", { kind: "pending" }],
    ["a success with no value", { kind: "ok" }],
    ["a success with no workspace name", { kind: "ok", value: { environments: [] } }],
    [
      "a success with an empty workspace name",
      { kind: "ok", value: { workspaceName: "", environments: [] } },
    ],
    [
      "a success whose workspace name is not a string",
      { kind: "ok", value: { workspaceName: 7, environments: [] } },
    ],
    ["a success with no environment list", { kind: "ok", value: { workspaceName: "acme" } }],
    [
      "a success whose environment list holds a non-string",
      { kind: "ok", value: { workspaceName: "acme", environments: ["main", 3] } },
    ],
  ])("refuses %s", (_name, body) => {
    expect(parseControllerTestResponse(200, body)).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });
});

describe("createModalCredentialTester: the request the controller receives", () => {
  it("sends both halves as headers, and neither in the URL or the body", async () => {
    const { test, calls } = testerOver([ok({ workspaceName: "acme", environments: ["main"] })]);

    await test(CREDENTIAL);

    const call = calls[0];
    if (call === undefined) {
      throw new Error("expected one controller call");
    }
    expect(call.url).toBe("https://oncue--controller.modal.run/v1/connection/test");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer controller-token-value");
    expect(call.headers["x-oncue-modal-token-id"]).toBe("ak-fake0001");
    expect(call.headers["x-oncue-modal-token-secret"]).toBe("as-fake0001");
    // No body: a proxy that logs bodies must not see the credential.
    expect(call.body).toBe("");
    for (const secret of [ACCESS.controllerToken, CREDENTIAL.tokenId, CREDENTIAL.tokenSecret]) {
      expect(call.url).not.toContain(secret);
      expect(call.body).not.toContain(secret);
    }
  });

  it("omits the environment header when the workspace default is wanted", async () => {
    const { test, calls } = testerOver([ok({ workspaceName: "acme", environments: ["main"] })]);

    await test(CREDENTIAL);

    expect(calls[0]?.headers["x-oncue-modal-environment"]).toBeUndefined();
  });

  it("sends the environment header when one is named", async () => {
    const { test, calls } = testerOver([ok({ workspaceName: "acme", environments: ["staging"] })]);

    await test({ ...CREDENTIAL, environmentName: "staging" });

    expect(calls[0]?.headers["x-oncue-modal-environment"]).toBe("staging");
  });

  // A paste with a line break: `new Headers` throws before any request, so this
  // is the user's paste to fix, not an unreachable controller.
  it("reports a credential the platform will not carry as invalid, without calling out", async () => {
    const { test, calls } = testerOver([]);

    await expect(test({ ...CREDENTIAL, tokenSecret: "as-fake\n0001" })).resolves.toEqual({
      kind: "failed",
      reason: "invalid_credentials",
    });
    expect(calls).toEqual([]);
  });
});

describe("createModalCredentialTester: what comes back", () => {
  it("carries the workspace name and the environments through", async () => {
    const { test } = testerOver([ok({ workspaceName: "acme-workspace", environments: ["main"] })]);

    await expect(test(CREDENTIAL)).resolves.toEqual({
      kind: "ok",
      workspaceName: "acme-workspace",
      environments: ["main"],
    });
  });

  it("carries a named failure through", async () => {
    const { test } = testerOver([failed("no_environment_access")]);

    await expect(test(CREDENTIAL)).resolves.toEqual({
      kind: "failed",
      reason: "no_environment_access",
    });
  });

  it("reports a body that is not JSON as unreachable", async () => {
    const { test } = testerOver([new Response("<html>502 Bad Gateway</html>", { status: 200 })]);

    await expect(test(CREDENTIAL)).resolves.toEqual({ kind: "failed", reason: "unreachable" });
  });

  it("reports a controller that did not answer without echoing the request", async () => {
    // The thrown error is dropped: it can carry the credential headers.
    const { test } = testerOver([
      new Error(`connect ECONNREFUSED x-oncue-modal-token-secret: ${CREDENTIAL.tokenSecret}`),
    ]);

    const outcome = await test(CREDENTIAL);

    expect(outcome).toEqual({ kind: "failed", reason: "controller_unavailable" });
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL.tokenSecret);
  });
});
