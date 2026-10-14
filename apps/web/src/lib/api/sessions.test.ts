import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveSession,
  BASE_MOVED_COPY,
  BRANCH_REFUSAL_COPY,
  createFailureCopy,
  createSession,
  deleteSession,
  fetchArtifact,
  fetchSessionFile,
  keepSandboxAlive,
  listSessions,
  parseArchiveSessionResponse,
  parseCreateSessionResponse,
  parseDeleteSessionResponse,
  parseKeepSandboxAliveResponse,
  parseListSessionsResponse,
  parseStopSandboxResponse,
  REFUSAL_COPY,
  sessionFileUrl,
  stopSandbox,
  unarchiveSession,
} from "./sessions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCreateSessionResponse", () => {
  it("treats 201 as created", () => {
    expect(
      parseCreateSessionResponse(201, { sessionId: "s1", runId: "r1", plan: "created" }),
    ).toEqual({
      kind: "created",
      sessionId: "s1",
    });
  });

  it("treats 200 (the idempotent retry) as created too", () => {
    expect(parseCreateSessionResponse(200, { sessionId: "s1", plan: "already_processed" })).toEqual(
      {
        kind: "created",
        sessionId: "s1",
      },
    );
  });

  it("treats a 200/201 body missing sessionId as unreachable", () => {
    expect(parseCreateSessionResponse(201, {})).toEqual({ kind: "unreachable" });
    expect(parseCreateSessionResponse(201, null)).toEqual({ kind: "unreachable" });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseCreateSessionResponse(401, { error: "unauthenticated" })).toEqual({
      kind: "denied",
    });
    expect(parseCreateSessionResponse(403, { error: "not_allowlisted" })).toEqual({
      kind: "denied",
    });
  });

  it("treats a 403 that refuses the request as invalid, never as signed out", () => {
    // The deployment's model allowlist does not include the chosen model.
    const refused = parseCreateSessionResponse(403, {
      error: "invalid_request",
      reason: "model_not_allowed",
      allowed: ["claude-sonnet-4-5-20250929"],
    });
    expect(refused).toEqual({ kind: "invalid", error: "model_not_allowed" });
    expect(createFailureCopy({ kind: "invalid", error: "model_not_allowed" })).toBe(
      "That model isn't enabled here. Pick another model and try again.",
    );
    // Another refused choice the browser has no sentence for gets the generic one.
    const other = parseCreateSessionResponse(403, {
      error: "invalid_request",
      reason: "runtime_not_allowed",
    });
    expect(other).toEqual({ kind: "invalid", error: "runtime_not_allowed" });
    expect(createFailureCopy({ kind: "invalid", error: "runtime_not_allowed" })).toContain(
      "Pick the repository and model again",
    );
    expect(parseCreateSessionResponse(403, { error: "invalid_request" })).toEqual({
      kind: "invalid",
      error: "invalid_request",
    });
    // A denial of the person keeps its own answer, whatever else the body holds.
    expect(
      parseCreateSessionResponse(403, { error: "not_allowlisted", reason: "model_not_allowed" }),
    ).toEqual({ kind: "denied" });
    expect(
      parseCreateSessionResponse(401, { error: "invalid_request", reason: "model_not_allowed" }),
    ).toEqual({ kind: "denied" });
    expect(parseCreateSessionResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("reads a refusal of the chosen model as its own result, whatever its status", () => {
    expect(
      parseCreateSessionResponse(409, {
        error: "model_key_rejected",
        provider: "openai",
        modelConnectionId: "mc_1",
      }),
    ).toEqual({ kind: "model_refused", reason: "key_rejected", provider: "openai" });
    // A provider this build does not know still reads as a rejected key.
    expect(
      parseCreateSessionResponse(409, { error: "model_key_rejected", provider: "cohere" }),
    ).toEqual({ kind: "model_refused", reason: "key_rejected", provider: null });
    // A key revoked or marked invalid since the composer's list was read.
    expect(
      parseCreateSessionResponse(409, { error: "invalid_request", reason: "not_active" }),
    ).toEqual({ kind: "model_refused", reason: "not_active", provider: null });
    // A connection the workspace no longer has reads the same to the person.
    expect(
      parseCreateSessionResponse(403, { error: "invalid_request", reason: "not_usable" }),
    ).toEqual({ kind: "model_refused", reason: "not_active", provider: null });
    // A key connected since: the composer named none, and the Worker will not guess.
    expect(
      parseCreateSessionResponse(400, { error: "invalid_request", reason: "connection_required" }),
    ).toEqual({ kind: "model_refused", reason: "connection_required", provider: null });
    // A hosted Worker starts no session on the scripted model.
    expect(parseCreateSessionResponse(409, { error: "model_connection_required" })).toEqual({
      kind: "model_refused",
      reason: "none_connected",
      provider: null,
    });
    // The same words under a status the Worker never sends them with mean nothing.
    expect(parseCreateSessionResponse(500, { error: "model_key_rejected" })).toEqual({
      kind: "unreachable",
    });
    expect(parseCreateSessionResponse(409, "model_key_rejected")).toEqual({
      kind: "invalid",
      error: null,
    });
  });

  it("treats 400 as invalid", () => {
    expect(
      parseCreateSessionResponse(400, { error: "invalid_request", reason: "command_id" }),
    ).toEqual({
      kind: "invalid",
      error: "invalid_request",
    });
    expect(parseCreateSessionResponse(409, { error: "modal_connection_required" })).toEqual({
      kind: "invalid",
      error: "modal_connection_required",
    });
    expect(parseCreateSessionResponse(400, null)).toEqual({ kind: "invalid", error: null });
  });

  it("reads a branch refusal and a moved branch as their own results", () => {
    expect(
      parseCreateSessionResponse(409, {
        error: "branch_refused",
        reason: "in_use",
        sessionId: "ses_holder",
      }),
    ).toEqual({ kind: "branch_refused", reason: "in_use", sessionId: "ses_holder" });
    expect(
      parseCreateSessionResponse(409, { error: "branch_refused", reason: "protected" }),
    ).toEqual({ kind: "branch_refused", reason: "protected", sessionId: null });
    // A reason this build does not know reads as an ordinary refusal.
    expect(parseCreateSessionResponse(409, { error: "branch_refused", reason: "new" })).toEqual({
      kind: "invalid",
      error: "branch_refused",
    });
    expect(
      parseCreateSessionResponse(409, { error: "base_moved", baseSha: "a".repeat(40) }),
    ).toEqual({ kind: "base_moved" });
    // GitHub would not say which rules apply: the Worker fails closed with a 502.
    expect(
      parseCreateSessionResponse(502, { error: "branch_refused", reason: "unconfirmed" }),
    ).toEqual({ kind: "branch_refused", reason: "unconfirmed", sessionId: null });
    expect(
      parseCreateSessionResponse(409, { error: "branch_refused", reason: "deleting" }),
    ).toEqual({
      kind: "branch_refused",
      reason: "deleting",
      sessionId: null,
    });
    expect(BRANCH_REFUSAL_COPY.deleting).toContain("being deleted");
    expect(
      parseCreateSessionResponse(409, { error: "invalid_request", reason: "command_reused" }),
    ).toEqual({ kind: "invalid", error: "command_reused" });
    expect(createFailureCopy({ kind: "invalid", error: "command_reused" })).toContain(
      "different repository or branch",
    );
  });

  it("maps a 503 admission-stopped body to the admission_stopped reason", () => {
    expect(parseCreateSessionResponse(503, { error: "admission stopped" })).toEqual({
      kind: "refused",
      reason: "admission_stopped",
      error: "admission stopped",
    });
  });

  it("maps any other 503 body to the generic admission_refused reason, keeping the Worker's code", () => {
    expect(
      parseCreateSessionResponse(503, { error: "admission refused: workspace_cap_reached" }),
    ).toEqual({
      kind: "refused",
      reason: "admission_refused",
      error: "admission refused: workspace_cap_reached",
    });
    expect(parseCreateSessionResponse(503, null)).toEqual({
      kind: "refused",
      reason: "admission_refused",
      error: null,
    });
  });

  // A hosted deployment with no usable sandbox controller refuses rather than run the fake.
  it("names a deployment with no usable controller in its own words", () => {
    expect(parseCreateSessionResponse(503, { error: "controller_unconfigured" })).toEqual({
      kind: "refused",
      reason: "admission_refused",
      error: "controller_unconfigured",
    });
    expect(
      createFailureCopy({
        kind: "refused",
        reason: "admission_refused",
        error: "controller_unconfigured",
      }),
    ).toBe(
      "This deployment has no working sandbox controller, so it can't start a session. Whoever runs it needs to set the controller's https origin and token.",
    );
  });

  it("reports a 502 as refused with the Worker's code, since the server was reached", () => {
    expect(
      parseCreateSessionResponse(502, { error: "task_branch_failed", reason: "github" }),
    ).toEqual({
      kind: "refused",
      reason: "admission_refused",
      error: "task_branch_failed",
    });
  });

  it("treats any other status as unreachable", () => {
    expect(parseCreateSessionResponse(504, { error: "boom" })).toEqual({ kind: "unreachable" });
    expect(parseCreateSessionResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

// What the composer says for each of the Worker's error codes on a refused create.
describe("createFailureCopy", () => {
  it("names the Worker's reason when it knows the code", () => {
    expect(
      createFailureCopy({
        kind: "refused",
        reason: "admission_refused",
        error: "modal_credential_unusable",
      }),
    ).toContain("Reconnect Modal");
    expect(createFailureCopy({ kind: "invalid", error: "modal_connection_required" })).toContain(
      "Connect your Modal account",
    );
    expect(
      createFailureCopy({ kind: "invalid", error: "github_reverification_required" }),
    ).toContain("Reconnect GitHub");
  });

  it("says why a branch was refused, and asks for a moved branch's card again in its own words", () => {
    expect(createFailureCopy({ kind: "branch_refused", reason: "default", sessionId: null })).toBe(
      BRANCH_REFUSAL_COPY.default,
    );
    expect(
      createFailureCopy({ kind: "branch_refused", reason: "in_use", sessionId: "ses_1" }),
    ).toContain("Another session");
    expect(createFailureCopy({ kind: "base_moved" })).toBe(BASE_MOVED_COPY);
    // The copy no longer talks about creating a task branch, which no create does.
    expect(BASE_MOVED_COPY).not.toContain("task branch");
  });

  it("falls back to the status's generic line for a code it does not know", () => {
    expect(createFailureCopy({ kind: "refused", reason: "admission_stopped", error: "x" })).toBe(
      REFUSAL_COPY.admission_stopped,
    );
    expect(createFailureCopy({ kind: "refused", reason: "admission_refused", error: null })).toBe(
      REFUSAL_COPY.admission_refused,
    );
    expect(createFailureCopy({ kind: "invalid", error: "something_new" })).toContain(
      "Pick the repository and model again",
    );
    expect(createFailureCopy({ kind: "invalid", error: null })).toContain("Pick the repository");
  });

  it("says which provider rejected the key, and what to do about a model that cannot be started on", () => {
    expect(
      createFailureCopy({ kind: "model_refused", reason: "key_rejected", provider: "openai" }),
    ).toBe("OpenAI rejected this key. Replace it in Settings or pick another model.");
    expect(
      createFailureCopy({ kind: "model_refused", reason: "key_rejected", provider: "anthropic" }),
    ).toBe("Anthropic rejected this key. Replace it in Settings or pick another model.");
    expect(
      createFailureCopy({ kind: "model_refused", reason: "key_rejected", provider: null }),
    ).toBe("The provider rejected this key. Replace it in Settings or pick another model.");
    expect(createFailureCopy({ kind: "model_refused", reason: "not_active", provider: null })).toBe(
      "That model's key was removed or is no longer accepted. Pick a model again, or add a key in Settings.",
    );
    expect(
      createFailureCopy({ kind: "model_refused", reason: "connection_required", provider: null }),
    ).toBe("Your model keys changed since this page loaded. Pick a model and send again.");
    expect(
      createFailureCopy({ kind: "model_refused", reason: "none_connected", provider: null }),
    ).toBe("Add a model key in Settings before starting a session.");
  });

  it("has a sentence for a signed-out and an unreachable submit", () => {
    expect(createFailureCopy({ kind: "denied" })).toContain("Sign in");
    expect(createFailureCopy({ kind: "unreachable" })).toContain("reach the server");
  });
});

describe("REFUSAL_COPY", () => {
  it("has a message for every refusal reason", () => {
    expect(REFUSAL_COPY.admission_stopped.length).toBeGreaterThan(0);
    expect(REFUSAL_COPY.admission_refused.length).toBeGreaterThan(0);
  });
});

describe("createSession", () => {
  it("POSTs the commandId/instruction shape and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createSession({ commandId: "cmd-1", text: "Fix the bug" });

    expect(result).toEqual({ kind: "created", sessionId: "s1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions");
    expect(JSON.parse(init.body as string)).toEqual({
      commandId: "cmd-1",
      instruction: { messageId: "cmd-1", text: "Fix the bug", attachments: [] },
    });
  });

  it("names the model and effort when the composer chose them, and nothing when it did not", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSession({
      commandId: "cmd-1",
      text: "Fix the bug",
      modelConnectionId: "mc_1",
      modelId: "claude-sonnet-5",
      effort: "low",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      modelConnectionId: "mc_1",
      modelId: "claude-sonnet-5",
      effort: "low",
    });

    // A model with no effort parameter names null; an unchosen effort names nothing.
    await createSession({ commandId: "cmd-2", text: "x", modelConnectionId: "mc_1", effort: null });
    const [, second] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(second.body as string)).toMatchObject({ effort: null });
    expect(Object.hasOwn(JSON.parse(second.body as string) as object, "modelId")).toBe(false);
  });

  it("names the harness only when the composer offered a choice of one", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSession({ commandId: "cmd-1", text: "x", runtime: "opencode" });
    await createSession({ commandId: "cmd-2", text: "x" });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies[0].runtime).toBe("opencode");
    expect(Object.hasOwn(bodies[1], "runtime")).toBe(false);
  });

  it("sends skipRequiredChecks only when the person asked to skip", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSession({ commandId: "cmd-1", text: "x", skipRequiredChecks: true });
    await createSession({ commandId: "cmd-2", text: "x", skipRequiredChecks: false });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies[0].skipRequiredChecks).toBe(true);
    expect(Object.hasOwn(bodies[1], "skipRequiredChecks")).toBe(false);
  });

  it("names the branch and the mode only when the composer chose them", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSession({
      commandId: "cmd-1",
      text: "x",
      branch: "feature/login",
      branchMode: "existing_branch",
    });
    await createSession({ commandId: "cmd-2", text: "x" });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies[0]).toMatchObject({ branch: "feature/login", branchMode: "existing_branch" });
    expect(Object.hasOwn(bodies[1], "branch")).toBe(false);
    expect(Object.hasOwn(bodies[1], "branchMode")).toBe(false);
  });

  it("returns unreachable when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(await createSession({ commandId: "cmd-1", text: "x" })).toEqual({ kind: "unreachable" });
  });

  it("returns unreachable when the body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 201 })),
    );

    expect(await createSession({ commandId: "cmd-1", text: "x" })).toEqual({ kind: "unreachable" });
  });
});

describe("parseListSessionsResponse", () => {
  const ROW = {
    sessionId: "s1",
    title: "Fix the bug",
    state: "active",
    lastActivityAt: "2026-09-03T00:00:00.000Z",
    createdAt: "2026-09-02T00:00:00.000Z",
    repositoryFullName: "acme/widgets",
    taskBranch: "oncue/fix-the-bug-7f3a",
    waitingForUser: false,
    currentRunId: "run_1",
    currentRunState: "running" as const,
  };

  it("reads the branch a session started from and whether it works on it directly, and nothing from an older Worker", () => {
    expect(
      parseListSessionsResponse(200, {
        sessions: [
          {
            ...ROW,
            taskBranch: "feature/login",
            baseBranch: "feature/login",
            branchMode: "existing_branch",
          },
          { ...ROW, sessionId: "s2", baseBranch: "release/1.4", branchMode: "new_branch" },
          { ...ROW, sessionId: "s3", baseBranch: 7, branchMode: "sideways" },
        ],
      }),
    ).toEqual({
      kind: "listed",
      sessions: [
        {
          ...ROW,
          taskBranch: "feature/login",
          baseBranch: "feature/login",
          branchMode: "existing_branch",
        },
        { ...ROW, sessionId: "s2", baseBranch: "release/1.4" },
        { ...ROW, sessionId: "s3" },
      ],
    });
  });

  it("reads the session's harness when the row names one, and nothing when it does not", () => {
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, runtime: "codex" }] })).toEqual({
      kind: "listed",
      sessions: [{ ...ROW, runtime: "codex" }],
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, runtime: 7 }] })).toEqual({
      kind: "listed",
      sessions: [ROW],
    });
  });

  it("reads the current run, takes a row without it as none, and drops a state it does not know (0015)", () => {
    expect(parseListSessionsResponse(200, { sessions: [ROW] })).toEqual({
      kind: "listed",
      sessions: [ROW],
    });
    const { currentRunId: _id, currentRunState: _state, ...older } = ROW;
    expect(parseListSessionsResponse(200, { sessions: [older] })).toEqual({
      kind: "listed",
      sessions: [{ ...ROW, currentRunId: null, currentRunState: null }],
    });
    expect(
      parseListSessionsResponse(200, { sessions: [{ ...ROW, currentRunState: "rebooting" }] }),
    ).toEqual({ kind: "listed", sessions: [{ ...ROW, currentRunState: null }] });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, currentRunId: 7 }] })).toEqual({
      kind: "unreachable",
    });
  });

  it("reads waitingForUser, takes a row without it as not waiting, and rejects a non-boolean", () => {
    expect(
      parseListSessionsResponse(200, { sessions: [{ ...ROW, waitingForUser: true }] }),
    ).toEqual({ kind: "listed", sessions: [{ ...ROW, waitingForUser: true }] });
    const { waitingForUser: _dropped, ...older } = ROW;
    expect(parseListSessionsResponse(200, { sessions: [older] })).toEqual({
      kind: "listed",
      sessions: [ROW],
    });
    expect(
      parseListSessionsResponse(200, { sessions: [{ ...ROW, waitingForUser: "yes" }] }),
    ).toEqual({ kind: "unreachable" });
  });

  it("rejects a row whose repositoryFullName is neither a string nor null", () => {
    expect(
      parseListSessionsResponse(200, { sessions: [{ ...ROW, repositoryFullName: 7 }] }),
    ).toEqual({ kind: "unreachable" });
  });

  it("rejects a row whose taskBranch is neither a string nor null, and accepts null", () => {
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, taskBranch: 7 }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, taskBranch: null }] })).toEqual({
      kind: "listed",
      sessions: [{ ...ROW, taskBranch: null }],
    });
  });

  it("parses a row with no repository, which is every session created without one", () => {
    const withoutRepository = { ...ROW, repositoryFullName: null };

    expect(parseListSessionsResponse(200, { sessions: [withoutRepository] })).toEqual({
      kind: "listed",
      sessions: [withoutRepository],
    });
  });

  it("parses a 200 body with rows, including a null title and lastActivityAt", () => {
    const rowWithNulls = { ...ROW, title: null, lastActivityAt: null };
    expect(parseListSessionsResponse(200, { sessions: [ROW, rowWithNulls] })).toEqual({
      kind: "listed",
      sessions: [ROW, rowWithNulls],
    });
  });

  it("treats a missing sessions array as unreachable", () => {
    expect(parseListSessionsResponse(200, {})).toEqual({ kind: "unreachable" });
    expect(parseListSessionsResponse(200, null)).toEqual({ kind: "unreachable" });
  });

  it("treats a row that fails to parse as unreachable", () => {
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, state: "deleted" }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, sessionId: 1 }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, title: 1 }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, lastActivityAt: 1 }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: [{ ...ROW, createdAt: 1 }] })).toEqual({
      kind: "unreachable",
    });
    expect(parseListSessionsResponse(200, { sessions: ["oops"] })).toEqual({ kind: "unreachable" });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseListSessionsResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseListSessionsResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseListSessionsResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("listSessions", () => {
  it("GETs /api/sessions and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listSessions()).toEqual({ kind: "listed", sessions: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions");
  });

  it("names the branch and the mode only when the composer chose them", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "s1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSession({
      commandId: "cmd-1",
      text: "x",
      branch: "feature/login",
      branchMode: "existing_branch",
    });
    await createSession({ commandId: "cmd-2", text: "x" });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies[0]).toMatchObject({ branch: "feature/login", branchMode: "existing_branch" });
    expect(Object.hasOwn(bodies[1], "branch")).toBe(false);
    expect(Object.hasOwn(bodies[1], "branchMode")).toBe(false);
  });

  it("returns unreachable when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(await listSessions()).toEqual({ kind: "unreachable" });
  });
});

describe("parseStopSandboxResponse", () => {
  it("maps every answer the stop route gives", () => {
    expect(parseStopSandboxResponse(200, { sessionId: "s", generation: 2 })).toEqual({
      kind: "stopped",
      generation: 2,
    });
    expect(parseStopSandboxResponse(200, {})).toEqual({ kind: "unreachable" });
    expect(parseStopSandboxResponse(202, { sessionId: "s", generation: 2 })).toEqual({
      kind: "stopping",
      generation: 2,
    });
    expect(parseStopSandboxResponse(202, null)).toEqual({ kind: "unreachable" });
    expect(parseStopSandboxResponse(401, {})).toEqual({ kind: "denied" });
    expect(parseStopSandboxResponse(403, {})).toEqual({ kind: "denied" });
    expect(parseStopSandboxResponse(409, { error: "not_running" })).toEqual({
      kind: "not_running",
    });
    expect(
      parseStopSandboxResponse(502, { error: "stop_failed", message: "Modal said no." }),
    ).toEqual({ kind: "failed", message: "Modal said no." });
    expect(parseStopSandboxResponse(502, null)).toEqual({
      kind: "failed",
      message: "The sandbox could not be stopped.",
    });
    expect(parseStopSandboxResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("stopSandbox", () => {
  it("posts to the session's stop path and never throws", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(input);
        return new Response(JSON.stringify({ sessionId: "s 1", generation: 1 }), { status: 200 });
      }),
    );
    await expect(stopSandbox("s 1")).resolves.toEqual({ kind: "stopped", generation: 1 });
    expect(calls).toEqual(["/api/sessions/s%201/sandbox/stop"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(stopSandbox("s")).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("parseKeepSandboxAliveResponse", () => {
  it("reads each answer the keep-alive route gives", () => {
    const expiresAt = "2026-09-02T01:00:00.000Z";
    expect(parseKeepSandboxAliveResponse(200, { expiresAt })).toEqual({ kind: "kept", expiresAt });
    expect(parseKeepSandboxAliveResponse(200, { expiresAt: "soon" })).toEqual({
      kind: "unreachable",
    });
    expect(parseKeepSandboxAliveResponse(200, null)).toEqual({ kind: "unreachable" });
    expect(parseKeepSandboxAliveResponse(409, { error: "not_running" })).toEqual({
      kind: "not_running",
    });
    expect(parseKeepSandboxAliveResponse(401, {})).toEqual({ kind: "denied" });
    expect(parseKeepSandboxAliveResponse(403, {})).toEqual({ kind: "denied" });
    expect(parseKeepSandboxAliveResponse(500, {})).toEqual({ kind: "unreachable" });
  });
});

describe("keepSandboxAlive", () => {
  it("posts an empty JSON body to the session's keep-alive path and never throws", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ expiresAt: "2026-09-02T01:00:00.000Z" }), {
          status: 200,
        });
      }),
    );
    await expect(keepSandboxAlive("s 1")).resolves.toEqual({
      kind: "kept",
      expiresAt: "2026-09-02T01:00:00.000Z",
    });
    expect(calls).toEqual([
      {
        url: "/api/sessions/s%201/sandbox/keep-alive",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );
    await expect(keepSandboxAlive("s")).resolves.toEqual({ kind: "unreachable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(keepSandboxAlive("s")).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("fetchSessionFile", () => {
  function answering(status: number, body: BodyInit | null, headers: Record<string, string> = {}) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(body, { status, headers });
      }),
    );
    return calls;
  }

  it("asks for the path at the base commit, and for the whole file to download", async () => {
    const calls = answering(200, "hello\n", { "x-oncue-file-kind": "text" });
    expect(await fetchSessionFile("s 1", "src/a b.ts")).toEqual({ kind: "text", text: "hello\n" });
    expect(calls).toEqual(["/api/sessions/s%201/files?path=src%2Fa+b.ts"]);
    expect(sessionFileUrl("s", "x/y", true)).toBe("/api/sessions/s/files?path=x%2Fy&download=1");
  });

  it("reads each answer the Worker gives", async () => {
    answering(200, new Uint8Array([1]), { "x-oncue-file-kind": "image" });
    expect((await fetchSessionFile("s", "a.png")).kind).toBe("image");
    answering(200, new Uint8Array([0]), { "x-oncue-file-kind": "binary" });
    expect(await fetchSessionFile("s", "a.bin")).toEqual({ kind: "binary" });
    answering(413, JSON.stringify({ error: "too_large", size: 5 }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "too_large", size: 5 });
    answering(413, "not json");
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "too_large", size: null });
    answering(404, JSON.stringify({ error: "not_found" }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "not_found" });
    answering(404, JSON.stringify({ error: "no_repository" }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "unavailable" });
    answering(422, JSON.stringify({ error: "not_a_file" }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "not_a_file" });
    answering(409, JSON.stringify({ error: "github_reverification_required" }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "reconnect_github" });
    answering(502, JSON.stringify({ error: "github_failed" }));
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "unavailable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchSessionFile("s", "a")).toEqual({ kind: "unavailable" });
  });
});

describe("fetchArtifact", () => {
  it("returns the bytes on a 200 and unavailable for anything else, never throwing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response("artifact bytes", { status: 200 });
      }),
    );
    const fetched = await fetchArtifact("s 1", "art/1");
    expect(fetched.kind).toBe("fetched");
    expect(fetched.kind === "fetched" ? await fetched.blob.text() : null).toBe("artifact bytes");
    expect(calls).toEqual(["/api/sessions/s%201/artifacts/art%2F1"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "artifact_unavailable" }), { status: 404 }),
      ),
    );
    await expect(fetchArtifact("s", "a")).resolves.toEqual({ kind: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchArtifact("s", "a")).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("parseDeleteSessionResponse", () => {
  it("maps each answer and never throws", () => {
    expect(parseDeleteSessionResponse(202)).toEqual({ kind: "deleted" });
    expect(parseDeleteSessionResponse(200)).toEqual({ kind: "deleted" });
    expect(parseDeleteSessionResponse(401)).toEqual({ kind: "denied" });
    expect(parseDeleteSessionResponse(403)).toEqual({ kind: "denied" });
    expect(parseDeleteSessionResponse(502)).toEqual({ kind: "failed" });
    expect(parseDeleteSessionResponse(500)).toEqual({ kind: "unreachable" });
  });
});

describe("deleteSession", () => {
  it("sends DELETE to the session's path and never throws", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ url: input, method: init?.method });
        return new Response(null, { status: 202 });
      }),
    );
    await expect(deleteSession("s 1")).resolves.toEqual({ kind: "deleted" });
    expect(calls).toEqual([{ url: "/api/sessions/s%201", method: "DELETE" }]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(deleteSession("s")).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("parseArchiveSessionResponse", () => {
  it("maps each answer and never throws", () => {
    expect(parseArchiveSessionResponse(200, { state: "archived" })).toEqual({
      kind: "changed",
      state: "archived",
    });
    expect(parseArchiveSessionResponse(200, { state: "active" })).toEqual({
      kind: "changed",
      state: "active",
    });
    expect(parseArchiveSessionResponse(200, { state: "deleted" })).toEqual({ kind: "unreachable" });
    expect(parseArchiveSessionResponse(200, null)).toEqual({ kind: "unreachable" });
    expect(parseArchiveSessionResponse(409, { error: "run_open" })).toEqual({ kind: "run_open" });
    expect(parseArchiveSessionResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseArchiveSessionResponse(403, null)).toEqual({ kind: "denied" });
    expect(parseArchiveSessionResponse(502, null)).toEqual({ kind: "failed" });
    expect(parseArchiveSessionResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("archiveSession and unarchiveSession", () => {
  it("post to their paths with the confirmation, and never throw", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ url: input, body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ state: input.endsWith("/archive") ? "archived" : "active" }),
          {
            status: 200,
          },
        );
      }),
    );
    await expect(archiveSession("s 1", true)).resolves.toEqual({
      kind: "changed",
      state: "archived",
    });
    await expect(unarchiveSession("s 1")).resolves.toEqual({ kind: "changed", state: "active" });
    expect(calls).toEqual([
      { url: "/api/sessions/s%201/archive", body: { cancelOpenRun: true } },
      { url: "/api/sessions/s%201/unarchive", body: {} },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );
    await expect(archiveSession("s", false)).resolves.toEqual({ kind: "failed" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(unarchiveSession("s")).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("a create whose session was deleted first", () => {
  it("keeps the draft and says why", () => {
    const result = parseCreateSessionResponse(410, { error: "session_deleted" });
    expect(result).toEqual({ kind: "invalid", error: "session_deleted" });
    expect(createFailureCopy(result as Exclude<typeof result, { kind: "created" }>)).toContain(
      "was deleted",
    );
  });
});
