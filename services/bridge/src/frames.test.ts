import { describe, expect, it } from "vitest";
import {
  type AckOutcome,
  type AckRef,
  buildAckFrame,
  buildApprovalFrame,
  buildCommandFrame,
  buildGrantFrame,
  buildPolicyFrame,
  buildQuestionFrame,
  type DeliverableCommand,
  type FrameIdentity,
  type GitGrantFrame,
  isDeliverable,
  type ModelGrantFrame,
  type PushGrantFrame,
  parseAckFrame,
  parseSessionFrame,
  type UploadGrantFrame,
} from "./frames";

const IDENTITY: FrameIdentity = { sessionId: "sess_1", generation: 3 };

function runStartCommand(overrides: Record<string, unknown> = {}): DeliverableCommand {
  return {
    commandId: "cmd_1",
    sessionId: "sess_1",
    runId: null,
    issuedAt: "2026-09-11T00:00:00.000Z",
    issuedByUserId: "usr_1",
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: { messageId: "msg_1", text: "do the thing", attachments: [] },
      model: {
        modelId: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        modelConnectionId: "mc_1",
        authenticationType: "api_key",
        contextWindow: null,
        effort: null,
      },
      continuesRunId: null,
    },
    ...overrides,
  } as unknown as DeliverableCommand;
}

function commandFrameRaw(
  command: Record<string, unknown> = runStartCommand() as unknown as Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "bridge.command",
    sessionId: "sess_1",
    sandboxGeneration: 3,
    command,
    ...overrides,
  };
}

const ENTRY_SPEC = {
  name: "Any",
  contextWindow: 1,
  maxOutput: 1,
  effortLevels: null,
  imageInput: false,
};

const MODEL_GRANT: Omit<ModelGrantFrame, "type" | "sessionId" | "sandboxGeneration"> = {
  kind: "model",
  grantId: "grant_1",
  expiresAt: "2026-09-11T00:10:00.000Z",
  token: "ot1.token",
  brokerOrigin: "https://broker.example",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  runtime: "opencode",
  effort: null,
  modelSpec: null,
  workspace: "none",
};

const GIT_GRANT: Omit<GitGrantFrame, "type" | "sessionId" | "sandboxGeneration"> = {
  kind: "git",
  grantId: "grant_2",
  expiresAt: "2026-09-11T00:10:00.000Z",
  token: "ghs_token",
  repository: {
    fullName: "acme/test-repo",
    cloneUrl: "https://github.com/acme/test-repo.git",
  },
  branch: "oncue/my-branch-a1b2",
  taskBranch: "oncue/my-branch-a1b2",
  baseSha: "0".repeat(40),
  headSha: "1".repeat(40),
  restore: null,
};

const PUSH_GRANT: Omit<PushGrantFrame, "type" | "sessionId" | "sandboxGeneration"> = {
  kind: "push",
  grantId: "grant_3",
  expiresAt: "2026-09-11T00:02:00.000Z",
  token: "ghs_write",
  repository: {
    fullName: "acme/test-repo",
    cloneUrl: "https://github.com/acme/test-repo.git",
  },
  ref: "refs/heads/oncue/my-branch-a1b2",
  parentSha: "1".repeat(40),
};

const UPLOAD_GRANT: Omit<UploadGrantFrame, "type" | "sessionId" | "sandboxGeneration"> = {
  kind: "upload",
  grantId: "grant_4",
  expiresAt: "2026-09-11T00:10:00.000Z",
  token: "up_token",
  artifactId: "art_1",
  url: "https://control.example/api/sessions/sess_1/artifacts/art_1",
  maxBytes: 1024,
};

describe("buildCommandFrame / buildGrantFrame / buildAckFrame", () => {
  it("stamps the identity onto a command frame", () => {
    const command = runStartCommand();
    expect(buildCommandFrame(IDENTITY, command, "run_1")).toEqual({
      type: "bridge.command",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      command,
      runId: "run_1",
      context: null,
    });
  });

  it("carries a resume context on a command frame", () => {
    expect(buildCommandFrame(IDENTITY, runStartCommand(), "run_1", "resume summary").context).toBe(
      "resume summary",
    );
  });

  it("stamps the identity onto a model grant frame", () => {
    expect(buildGrantFrame(IDENTITY, MODEL_GRANT)).toEqual({
      ...MODEL_GRANT,
      type: "bridge.grant",
      sessionId: "sess_1",
      sandboxGeneration: 3,
    });
  });

  it("stamps the identity onto a git grant frame", () => {
    expect(buildGrantFrame(IDENTITY, GIT_GRANT)).toEqual({
      ...GIT_GRANT,
      type: "bridge.grant",
      sessionId: "sess_1",
      sandboxGeneration: 3,
    });
  });

  it("builds an accepted ack referencing a commandId", () => {
    const ref: AckRef = { commandId: "cmd_1" };
    const outcome: AckOutcome = { kind: "accepted" };
    expect(buildAckFrame(IDENTITY, ref, outcome)).toEqual({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref,
      outcome,
    });
  });

  it("builds a rejected ack referencing a grantId", () => {
    const ref: AckRef = { grantId: "grant_1" };
    const outcome: AckOutcome = { kind: "rejected", reason: "wrong_state" };
    expect(buildAckFrame(IDENTITY, ref, outcome)).toEqual({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref,
      outcome,
    });
  });
});

describe("parseSessionFrame: commands", () => {
  it("round-trips a command built by buildCommandFrame", () => {
    const command = runStartCommand();
    const frame = buildCommandFrame(IDENTITY, command, "run_1");
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "command", frame });
  });

  it("carries the structured skip on a run.start, and refuses one that is not a boolean", () => {
    const command = runStartCommand();
    const skipping = {
      ...command,
      payload: { ...command.payload, skipRequiredChecks: true },
    } as DeliverableCommand;
    const frame = buildCommandFrame(IDENTITY, skipping, "run_1");
    expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(frame)))).toEqual({
      kind: "command",
      frame,
    });
    expect(frame.command.payload).toMatchObject({ skipRequiredChecks: true });
    const raw = commandFrameRaw(
      { ...skipping, payload: { ...skipping.payload, skipRequiredChecks: "true" } },
      { runId: "run_1" },
    );
    expect(parseSessionFrame(IDENTITY, raw)).toMatchObject({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
    });
  });

  it("returns malformed when a run.start frame names no run", () => {
    const frame = buildCommandFrame(IDENTITY, runStartCommand(), null);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "run.start frame names no run",
    });
  });

  it("returns malformed when the frame names a different run than a run-scoped command", () => {
    const command = runStartCommand({
      type: "run.cancel",
      runId: "run_1",
      expected: { scope: "run", state: "running" },
      payload: { reason: null, checkpointFirst: false },
    });
    const frame = buildCommandFrame(IDENTITY, command, "run_2");
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame run id disagrees with the command's run",
    });
  });

  it("returns malformed when the frame's run id is neither a string nor null", () => {
    const raw = commandFrameRaw(runStartCommand() as unknown as Record<string, unknown>, {
      runId: 7,
    });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame run id is neither a string nor null",
    });
  });

  it.each(["run.follow_up", "run.cancel", "runtime.shutdown"] as const)(
    "accepts the deliverable type %s",
    (type) => {
      let payload: Record<string, unknown>;
      if (type === "run.follow_up") {
        payload = {
          messageId: "msg_2",
          text: "steer",
          attachments: [],
          delivery: "steer_current_run",
        };
      } else if (type === "run.cancel") {
        payload = { reason: null, checkpointFirst: false };
      } else {
        payload = { reason: "idle", graceMs: 5000 };
      }
      const command = runStartCommand({
        type,
        runId: type === "runtime.shutdown" ? null : "run_1",
        expected:
          type === "runtime.shutdown"
            ? { scope: "session", state: "active" }
            : { scope: "run", state: "running" },
        payload,
      });
      const frame = buildCommandFrame(IDENTITY, command, command.runId);
      expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "command", frame });
    },
  );

  it("returns malformed with the commandId when the session id does not match", () => {
    const command = runStartCommand();
    const raw = commandFrameRaw(command as unknown as Record<string, unknown>, {
      sessionId: "sess_other",
    });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame named another session or generation",
    });
  });

  it("returns malformed with the commandId when the generation does not match", () => {
    const command = runStartCommand();
    const raw = commandFrameRaw(command as unknown as Record<string, unknown>, {
      sandboxGeneration: 99,
    });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame named another session or generation",
    });
  });

  it("returns malformed with a null ref when the command has no commandId to name", () => {
    const raw = commandFrameRaw({ type: "run.start" }, { sessionId: "sess_other" });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: null,
      detail: "frame named another session or generation",
    });
  });

  it("returns malformed for a command type the bridge never receives (a fifth type)", () => {
    const command = runStartCommand({
      type: "context.add",
      runId: "run_1",
      expected: { scope: "run", state: "running" },
      payload: { items: [{ kind: "note", text: "hello" }] },
    });
    const raw = commandFrameRaw(command as unknown as Record<string, unknown>);
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "command type is not deliverable to the bridge: context.add",
    });
  });

  it("returns malformed for a command type the protocol package does not know", () => {
    const raw = commandFrameRaw({ ...runStartCommand(), type: "made.up" } as unknown as Record<
      string,
      unknown
    >);
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "unknown command type: made.up",
    });
  });

  it("returns malformed when the command envelope is missing a field", () => {
    const { issuedAt: _issuedAt, ...rest } = runStartCommand() as unknown as Record<
      string,
      unknown
    >;
    const raw = commandFrameRaw(rest);
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "command envelope is missing a required field",
    });
  });

  it("returns malformed when the command payload fails validation", () => {
    const command = runStartCommand({ payload: { instruction: { messageId: "msg_1" } } });
    const raw = commandFrameRaw(command as unknown as Record<string, unknown>);
    const result = parseSessionFrame(IDENTITY, raw);
    expect(result?.kind).toBe("malformed");
    expect(result && "ref" in result ? result.ref : null).toEqual({ commandId: "cmd_1" });
  });
});

describe("parseSessionFrame: grants", () => {
  it("round-trips a model grant built by buildGrantFrame", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("reads a grant from an object before the adapter boundary: OpenCode's coordinates, no runtime", () => {
    const { runtime: _runtime, ...current } = buildGrantFrame(
      IDENTITY,
      MODEL_GRANT,
    ) as ModelGrantFrame;
    const legacy = { ...current, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } };
    expect(parseSessionFrame(IDENTITY, legacy)).toEqual({
      kind: "grant",
      frame: { ...current, runtime: "opencode" },
    });
  });

  it("prefers the new coordinates when a grant carries both, as a newer object sends them", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT) as ModelGrantFrame;
    const both = {
      ...frame,
      model: { ...frame.model, providerID: "openai", modelID: "gpt-6-sol" },
    };
    expect(parseSessionFrame(IDENTITY, both)).toEqual({ kind: "grant", frame });
  });

  it("passes an unknown runtime through for the reducer to refuse, and refuses a non-string", () => {
    const frame = buildGrantFrame(IDENTITY, { ...MODEL_GRANT, runtime: "cursor" });
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
    expect(parseSessionFrame(IDENTITY, { ...frame, runtime: 7 })).toMatchObject({
      kind: "malformed",
    });
  });

  it("round-trips a model grant that carries the run's effort and the model's facts", () => {
    const frame = buildGrantFrame(IDENTITY, {
      ...MODEL_GRANT,
      effort: "medium",
      modelSpec: {
        name: "Claude Opus 5.5",
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        imageInput: true,
      },
    });
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("round-trips a model grant that lists the models the session may change to", () => {
    const spec = {
      name: "GPT-6 Sol",
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      effortLevels: ["none" as const, "low" as const],
      imageInput: true,
    };
    const frame = buildGrantFrame(IDENTITY, {
      ...MODEL_GRANT,
      catalog: [{ provider: "openai", modelId: "gpt-6-sol", spec }],
    });
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("reads an empty list of other models as none, so the frame is what an older object sends", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    const parsed = parseSessionFrame(IDENTITY, { ...frame, catalog: [] });
    expect(parsed).toEqual({ kind: "grant", frame });
    expect(JSON.stringify(parsed)).not.toContain("catalog");
  });

  it.each([
    ["a list that is not a list", { catalog: "all" }],
    ["an entry that is not an object", { catalog: ["gpt-6-sol"] }],
    ["an entry with no provider", { catalog: [{ modelId: "m", spec: ENTRY_SPEC }] }],
    ["an entry with no model id", { catalog: [{ provider: "openai", spec: ENTRY_SPEC }] }],
    ["an entry with no spec", { catalog: [{ provider: "openai", modelId: "m" }] }],
    ["an entry with a null spec", { catalog: [{ provider: "openai", modelId: "m", spec: null }] }],
    [
      "an entry with a malformed spec",
      { catalog: [{ provider: "openai", modelId: "m", spec: { name: "x" } }] },
    ],
  ])("returns malformed for a model grant whose other models carry %s", (_label, bad) => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, { ...frame, ...bad })).toMatchObject({
      kind: "malformed",
      ref: { grantId: "grant_1" },
    });
  });

  it("reads a model grant from an object that names no effort or spec as carrying none", () => {
    const {
      effort: _effort,
      modelSpec: _spec,
      ...legacy
    } = buildGrantFrame(IDENTITY, MODEL_GRANT) as ModelGrantFrame;
    expect(parseSessionFrame(IDENTITY, legacy)).toEqual({
      kind: "grant",
      frame: { ...legacy, effort: null, modelSpec: null },
    });
  });

  it.each([
    ["an effort that is not a level", { effort: "very high" }],
    ["a spec that is not an object", { modelSpec: "opus" }],
    ["a spec missing its limits", { modelSpec: { name: "x", effortLevels: null } }],
    [
      "a spec with a level that is not one",
      { modelSpec: { name: "x", contextWindow: 1, maxOutput: 1, effortLevels: ["huge"] } },
    ],
  ])("returns malformed for a model grant with %s", (_label, bad) => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, { ...frame, ...bad })).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "grant is missing a required field for kind: model",
    });
  });

  it("round-trips a git grant built by buildGrantFrame", () => {
    const frame = buildGrantFrame(IDENTITY, GIT_GRANT);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("round-trips a git grant that carries a restore bundle", () => {
    const frame = buildGrantFrame(IDENTITY, {
      ...GIT_GRANT,
      restore: { artifactId: "art_9", url: "https://control.example/restore", token: "rt" },
    });
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("reads a git grant from an object that names no head or restore as cloning at the base", () => {
    const {
      headSha: _head,
      restore: _restore,
      ...legacy
    } = buildGrantFrame(IDENTITY, GIT_GRANT) as GitGrantFrame;
    expect(parseSessionFrame(IDENTITY, legacy)).toEqual({
      kind: "grant",
      frame: { ...legacy, headSha: GIT_GRANT.baseSha, restore: null },
    });
  });

  it("round-trips a push grant built by buildGrantFrame", () => {
    const frame = buildGrantFrame(IDENTITY, PUSH_GRANT);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("round-trips an upload grant built by buildGrantFrame", () => {
    const frame = buildGrantFrame(IDENTITY, UPLOAD_GRANT);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "grant", frame });
  });

  it("returns malformed with the grantId when the identity does not match", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, { ...frame, sessionId: "sess_other" })).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "frame named another session or generation",
    });
  });

  it("returns malformed with a null ref when there is no grantId to name", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    const { grantId: _grantId, ...rest } = frame;
    expect(parseSessionFrame(IDENTITY, { ...rest, sessionId: "sess_other" })).toEqual({
      kind: "malformed",
      ref: null,
      detail: "frame named another session or generation",
    });
  });

  it("returns malformed when expiresAt is missing", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    const { expiresAt: _expiresAt, ...rest } = frame;
    expect(parseSessionFrame(IDENTITY, rest)).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "grant envelope is missing a required field",
    });
  });

  it("returns malformed for a grant kind that is neither model nor git", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, { ...frame, kind: "ssh" })).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "grant is missing a required field for kind: ssh",
    });
  });

  it.each([
    ["token", { token: undefined }],
    ["brokerOrigin", { brokerOrigin: undefined }],
    ["model", { model: undefined }],
    ["workspace", { workspace: "elsewhere" }],
  ])("returns malformed when a model grant is missing %s", (_name, overrides) => {
    const frame = { ...buildGrantFrame(IDENTITY, MODEL_GRANT), ...overrides };
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "grant is missing a required field for kind: model",
    });
  });

  it.each([
    ["token", { token: undefined }],
    ["repository", { repository: undefined }],
    ["branch", { branch: undefined }],
    ["baseSha", { baseSha: undefined }],
    ["a string headSha", { headSha: 7 }],
    ["a well-formed restore", { restore: { artifactId: "art_9", url: "https://x" } }],
    ["an object restore", { restore: "art_9" }],
  ])("returns malformed when a git grant is missing %s", (_name, overrides) => {
    const frame = { ...buildGrantFrame(IDENTITY, GIT_GRANT), ...overrides };
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_2" },
      detail: "grant is missing a required field for kind: git",
    });
  });
});

describe("parseSessionFrame: push and upload grants", () => {
  it.each([
    ["token", { token: undefined }],
    ["repository", { repository: { fullName: "a/b" } }],
    ["ref", { ref: undefined }],
    ["parentSha", { parentSha: 1 }],
  ])("returns malformed when a push grant is missing %s", (_name, overrides) => {
    const frame = { ...buildGrantFrame(IDENTITY, PUSH_GRANT), ...overrides };
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_3" },
      detail: "grant is missing a required field for kind: push",
    });
  });

  it.each([
    ["token", { token: undefined }],
    ["artifactId", { artifactId: undefined }],
    ["url", { url: undefined }],
    ["a numeric maxBytes", { maxBytes: "1024" }],
    ["an integer maxBytes", { maxBytes: 1.5 }],
    ["a positive maxBytes", { maxBytes: 0 }],
  ])("returns malformed when an upload grant is missing %s", (_name, overrides) => {
    const frame = { ...buildGrantFrame(IDENTITY, UPLOAD_GRANT), ...overrides };
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_4" },
      detail: "grant is missing a required field for kind: upload",
    });
  });

  it("returns malformed for a grant whose kind is not a string", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(parseSessionFrame(IDENTITY, { ...frame, kind: 4 })).toEqual({
      kind: "malformed",
      ref: { grantId: "grant_1" },
      detail: "grant is missing a required field for kind: 4",
    });
  });
});

describe("parseSessionFrame: command context", () => {
  it("round-trips a command frame carrying a context", () => {
    const frame = buildCommandFrame(IDENTITY, runStartCommand(), "run_1", "summary");
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "command", frame });
  });

  it("reads an absent context as none", () => {
    const raw = commandFrameRaw(undefined, { runId: "run_1" });
    const parsed = parseSessionFrame(IDENTITY, raw);
    expect(parsed?.kind === "command" ? parsed.frame.context : "not a command").toBeNull();
  });

  it("returns malformed when the context is neither a string nor null", () => {
    const raw = commandFrameRaw(undefined, { runId: "run_1", context: 3 });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame context is neither a string nor null",
    });
  });
});

describe("parseSessionFrame: command attachments", () => {
  const FETCH = {
    artifactId: "att_1",
    name: "screen.png",
    contentType: "image/png",
    byteSize: 120,
    url: "https://oncue.example/api/sessions/sess_1/attachments/att_1/content",
    token: "one-time",
  };

  it("round-trips a command frame carrying attachment fetches", () => {
    const frame = buildCommandFrame(IDENTITY, runStartCommand(), "run_1", null, [FETCH]);
    expect(frame.attachments).toEqual([FETCH]);
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({ kind: "command", frame });
  });

  it("leaves the field off a frame with none, so an older bridge reads the frame it always did", () => {
    const frame = buildCommandFrame(IDENTITY, runStartCommand(), "run_1");
    expect("attachments" in frame).toBe(false);
    const parsed = parseSessionFrame(IDENTITY, { ...frame, attachments: [] });
    expect(parsed?.kind === "command" && "attachments" in parsed.frame).toBe(false);
    const nulled = parseSessionFrame(IDENTITY, { ...frame, attachments: null });
    expect(nulled?.kind).toBe("command");
  });

  it.each([
    ["not a list", "att_1"],
    ["a list with a fetch missing its token", [{ ...FETCH, token: undefined }]],
    ["a list with a fetch that is not an object", [7]],
    ["more fetches than a message may carry", Array.from({ length: 11 }, () => FETCH)],
  ])("returns malformed for attachments that are %s", (_label, attachments) => {
    const raw = commandFrameRaw(undefined, { runId: "run_1", attachments });
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({
      kind: "malformed",
      ref: { commandId: "cmd_1" },
      detail: "frame attachments are not a list of fetches",
    });
  });
});

describe("parseSessionFrame: whether the model reads images", () => {
  const SPEC = { name: "x", contextWindow: 1, maxOutput: 1, effortLevels: null };

  it("reads a spec from an object older than attachments as a model that reads no images", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    const parsed = parseSessionFrame(IDENTITY, { ...frame, modelSpec: SPEC });
    expect(parsed).toMatchObject({ kind: "grant", frame: { modelSpec: { imageInput: false } } });
  });

  it("returns malformed for an image flag that is not a boolean", () => {
    const frame = buildGrantFrame(IDENTITY, MODEL_GRANT);
    expect(
      parseSessionFrame(IDENTITY, { ...frame, modelSpec: { ...SPEC, imageInput: "yes" } }),
    ).toMatchObject({ kind: "malformed" });
  });
});

describe("parseSessionFrame: not a session frame", () => {
  it.each([
    ["a non-object", 7],
    ["null", null],
    ["a bridge.welcome frame", { type: "bridge.welcome" }],
    ["a frame with no type", {}],
  ])("returns null for %s", (_name, raw) => {
    expect(parseSessionFrame(IDENTITY, raw)).toBeNull();
  });
});

describe("parseAckFrame", () => {
  it("round-trips an accepted ack for a commandId", () => {
    const built = buildAckFrame(IDENTITY, { commandId: "cmd_1" }, { kind: "accepted" });
    expect(parseAckFrame(IDENTITY, JSON.stringify(built))).toEqual(built);
  });

  it("round-trips a rejected ack for a grantId", () => {
    const built = buildAckFrame(
      IDENTITY,
      { grantId: "grant_1" },
      { kind: "rejected", reason: "duplicate" },
    );
    expect(parseAckFrame(IDENTITY, JSON.stringify(built))).toEqual(built);
  });

  it.each(["wrong_state", "duplicate", "no_runtime", "unsupported", "malformed"] as const)(
    "accepts the rejection reason %s",
    (reason) => {
      const built = buildAckFrame(IDENTITY, { commandId: "cmd_1" }, { kind: "rejected", reason });
      expect(parseAckFrame(IDENTITY, JSON.stringify(built))?.outcome).toEqual({
        kind: "rejected",
        reason,
      });
    },
  );

  it("returns null for text that is not JSON", () => {
    expect(parseAckFrame(IDENTITY, "{")).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(parseAckFrame(IDENTITY, "7")).toBeNull();
  });

  it("returns null for a frame that is not a bridge.ack", () => {
    expect(parseAckFrame(IDENTITY, JSON.stringify({ type: "bridge.heartbeat" }))).toBeNull();
  });

  it("returns null when the identity does not match", () => {
    const built = buildAckFrame(IDENTITY, { commandId: "cmd_1" }, { kind: "accepted" });
    expect(
      parseAckFrame({ sessionId: "sess_other", generation: 3 }, JSON.stringify(built)),
    ).toBeNull();
  });

  it("returns null when the ref names neither a commandId nor a grantId", () => {
    const raw = JSON.stringify({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref: {},
      outcome: { kind: "accepted" },
    });
    expect(parseAckFrame(IDENTITY, raw)).toBeNull();
  });

  it("returns null when the outcome is not an object", () => {
    const raw = JSON.stringify({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref: { commandId: "cmd_1" },
      outcome: "accepted",
    });
    expect(parseAckFrame(IDENTITY, raw)).toBeNull();
  });

  it("returns null for an outcome kind that is neither accepted nor a known rejection", () => {
    const raw = JSON.stringify({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref: { commandId: "cmd_1" },
      outcome: { kind: "rejected", reason: "made_up" },
    });
    expect(parseAckFrame(IDENTITY, raw)).toBeNull();
  });

  it("returns null for an outcome with an unrecognised kind", () => {
    const raw = JSON.stringify({
      type: "bridge.ack",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      ref: { commandId: "cmd_1" },
      outcome: { kind: "pending" },
    });
    expect(parseAckFrame(IDENTITY, raw)).toBeNull();
  });
});

describe("isDeliverable", () => {
  it("is true for the five deliverable command types", () => {
    for (const type of [
      "run.start",
      "run.follow_up",
      "run.cancel",
      "checkpoint.create",
      "runtime.shutdown",
    ] as const) {
      expect(isDeliverable(runStartCommand({ type }))).toBe(true);
    }
  });

  it("is false for a command type the object never forwards", () => {
    expect(isDeliverable(runStartCommand({ type: "context.add" }))).toBe(false);
  });
});

describe("bridge.policy", () => {
  const policy = {
    version: 2,
    commit: "auto",
    push: "never",
    pullRequest: "manual",
    planApproval: "proceed",
    fileEdits: "allowed",
  } as const;

  it("round-trips through the builder and the parser", () => {
    const built = buildPolicyFrame(IDENTITY, policy);
    expect(built).toEqual({
      type: "bridge.policy",
      sessionId: "sess_1",
      sandboxGeneration: 3,
      policy,
    });
    expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(built)))).toEqual({
      kind: "policy",
      policy,
    });
  });

  it("drops extra fields from the policy it hands on", () => {
    const raw = { ...buildPolicyFrame(IDENTITY, policy), policy: { ...policy, extra: "x" } };
    expect(parseSessionFrame(IDENTITY, raw)).toEqual({ kind: "policy", policy });
  });

  it.each([
    ["another session", { sessionId: "sess_2" }],
    ["another generation", { sandboxGeneration: 9 }],
    ["no policy", { policy: null }],
    ["a version that is not an integer", { policy: { ...policy, version: "2" } }],
    ["a value outside a field's list", { policy: { ...policy, push: "force" } }],
  ])("is malformed with no ref for %s", (_name, change) => {
    expect(
      parseSessionFrame(IDENTITY, { ...buildPolicyFrame(IDENTITY, policy), ...change }),
    ).toEqual({
      kind: "malformed",
      ref: null,
      detail: expect.any(String),
    });
  });
});

describe("the approval frame", () => {
  it("echoes the bridge's own reference and carries an expiry only while pending", () => {
    expect(buildApprovalFrame(IDENTITY, "req_1", "pending", "2026-09-21T12:10:00.000Z")).toEqual({
      type: "bridge.approval",
      sessionId: IDENTITY.sessionId,
      sandboxGeneration: IDENTITY.generation,
      requestRef: "req_1",
      outcome: "pending",
      expiresAt: "2026-09-21T12:10:00.000Z",
    });
    expect(
      buildApprovalFrame(IDENTITY, "req_1", "unavailable", "2026-09-21T12:10:00.000Z"),
    ).toEqual({
      type: "bridge.approval",
      sessionId: IDENTITY.sessionId,
      sandboxGeneration: IDENTITY.generation,
      requestRef: "req_1",
      outcome: "unavailable",
      expiresAt: null,
    });
    expect(buildApprovalFrame(IDENTITY, "req_1", "refused").expiresAt).toBeNull();
  });
});

describe("the secret grant", () => {
  const SECRET_GRANT = {
    kind: "secret",
    grantId: "grant_5",
    expiresAt: "2026-09-21T00:10:00.000Z",
    secrets: [{ name: "DATABASE_URL", value: "fake-database-url-0001" }],
    requestRef: null,
  } as const;

  it("round-trips through the builder and the parser, for a launch and for an approval", () => {
    const launch = buildGrantFrame(IDENTITY, SECRET_GRANT);
    expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(launch)))).toEqual({
      kind: "grant",
      frame: launch,
    });
    const approved = buildGrantFrame(IDENTITY, { ...SECRET_GRANT, requestRef: "req_1" });
    expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(approved)))).toEqual({
      kind: "grant",
      frame: approved,
    });
  });

  it.each([
    ["no list", { secrets: undefined }],
    ["an empty list", { secrets: [] }],
    ["more than twenty", { secrets: Array(21).fill(SECRET_GRANT.secrets[0]) }],
    ["an entry that is not an object", { secrets: ["DATABASE_URL"] }],
    ["a name that is not text", { secrets: [{ name: 7, value: "fake-value-0001" }] }],
    ["a value that is not text", { secrets: [{ name: "A_NAME", value: 7 }] }],
    ["a name root would refuse", { secrets: [{ name: "GITHUB_TOKEN", value: "fake-value-0001" }] }],
    ["a value root would refuse", { secrets: [{ name: "A_NAME", value: "short" }] }],
    ["a reference that is not text", { requestRef: 7 }],
    ["no reference at all", { requestRef: undefined }],
  ])("is malformed with %s, and the refusal never carries a value", (_label, overrides) => {
    const raw = { ...buildGrantFrame(IDENTITY, SECRET_GRANT), ...overrides };
    const parsed = parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(raw)));
    expect(parsed).toMatchObject({ kind: "malformed", ref: { grantId: "grant_5" } });
    expect(JSON.stringify(parsed)).not.toContain("fake-");
  });
});

describe("the approval frame, parsed", () => {
  it.each(["pending", "refused", "unavailable", "denied", "expired"] as const)(
    "reads a %s outcome",
    (outcome) => {
      const built = buildApprovalFrame(
        IDENTITY,
        "req_1",
        outcome,
        outcome === "pending" ? "2026-09-21T12:10:00.000Z" : null,
      );
      expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(built)))).toEqual({
        kind: "approval",
        requestRef: "req_1",
        outcome,
        expiresAt: built.expiresAt,
      });
    },
  );

  it.each([
    ["another generation", { sandboxGeneration: 9 }],
    ["an outcome it does not know", { outcome: "granted" }],
    ["no reference", { requestRef: "" }],
    ["a pending card with no expiry", { outcome: "pending", expiresAt: null }],
    ["an expiry that is not a time", { outcome: "pending", expiresAt: "soon" }],
  ])("is malformed for %s", (_label, overrides) => {
    const raw = { ...buildApprovalFrame(IDENTITY, "req_1", "denied"), ...overrides };
    expect(parseSessionFrame(IDENTITY, raw)).toMatchObject({ kind: "malformed", ref: null });
  });
});

describe("the question frame", () => {
  it("round-trips an answer, and carries answers only on answered", () => {
    const answered = buildQuestionFrame(IDENTITY, "ref_1", "answered", [["Postgres"], []]);
    expect(answered).toEqual({
      type: "bridge.question",
      sessionId: IDENTITY.sessionId,
      sandboxGeneration: IDENTITY.generation,
      requestRef: "ref_1",
      outcome: "answered",
      answers: [["Postgres"], []],
    });
    expect(parseSessionFrame(IDENTITY, JSON.parse(JSON.stringify(answered)))).toEqual({
      kind: "question",
      requestRef: "ref_1",
      outcome: "answered",
      answers: [["Postgres"], []],
    });
    expect(buildQuestionFrame(IDENTITY, "ref_1", "answered").answers).toEqual([]);
    const dismissed = buildQuestionFrame(IDENTITY, "ref_1", "dismissed", [["ignored"]]);
    expect(dismissed.answers).toBeNull();
    expect(parseSessionFrame(IDENTITY, { ...dismissed, answers: [["sneaked"]] })).toEqual({
      kind: "question",
      requestRef: "ref_1",
      outcome: "dismissed",
      answers: null,
    });
    expect(parseSessionFrame(IDENTITY, buildQuestionFrame(IDENTITY, "ref_1", "refused"))).toEqual({
      kind: "question",
      requestRef: "ref_1",
      outcome: "refused",
      answers: null,
    });
  });

  it.each([
    [{ sandboxGeneration: 99 }, "another session or generation"],
    [{ requestRef: "" }, "no request reference"],
    [{ outcome: "approved" }, "unknown outcome"],
    [{ answers: "Postgres" }, "unreadable answers"],
    [{ answers: [["a"], ["b"], ["c"], ["d"], ["e"]] }, "unreadable answers"],
    [{ answers: [["1", "2", "3", "4", "5", "6", "7", "8"]] }, "unreadable answers"],
    [{ answers: [[3]] }, "unreadable answers"],
    [{ answers: ["not a list"] }, "unreadable answers"],
    [{ answers: [["x".repeat(5000)]] }, "unreadable answers"],
  ])("drops a frame with %j", (change, detail) => {
    const frame = { ...buildQuestionFrame(IDENTITY, "ref_1", "answered", [["a"]]), ...change };
    expect(parseSessionFrame(IDENTITY, frame)).toEqual({
      kind: "malformed",
      ref: null,
      detail: expect.stringContaining(detail),
    });
  });
});
