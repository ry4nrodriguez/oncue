import { parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  type ActiveRun,
  type AgentEffect,
  type AgentInput,
  type AgentState,
  CHECKPOINT_REASONS,
  CHECKS_ONLY_WHAT_CHANGED,
  type CheckpointOutcome,
  type CheckpointReason,
  COMMIT_SUBJECT_CHARS,
  commitSubjectFor,
  DECIDED_RING_LIMIT,
  type DecidedRing,
  DONE_VERIFICATION_TEXT,
  decide,
  EMPTY_TREE_SHA,
  HEALTH_POLL_ATTEMPTS,
  HEALTH_POLL_INTERVAL_MS,
  initialAgentState,
  LOG_GRANT_WAIT_MS,
  MAX_ARTIFACT_BYTES,
  MAX_COMMITS_PER_RUN,
  NO_REPOSITORY_BRANCH,
  replayedAck,
  runStartedDraft,
  runtimeOf,
  type StepContext,
  type StepOutcome,
  step,
  UPLOADS_LIMIT,
} from "./agent";
import { type DiffBuild, type DiffReport, diffKey } from "./diff-report";
import {
  buildCommandFrame,
  buildGrantFrame,
  type CommandFrame,
  type DeliverableCommand,
  type GitGrantFrame,
  type GrantFrame,
  type ModelGrantFrame,
  type PushGrantFrame,
  type UploadGrantFrame,
} from "./frames";
import { emptyNormalizerState, type RuntimeEvent } from "./normalize";
import { OPENCODE_PORT, plannedRuntimeSpawn } from "./opencode";
import { bridgeConfig, type SequenceCursor, stampDraft } from "./protocol";
import type { ResolvedDefinition } from "./repo-config";
import { runtimePlan } from "./runtimes";
import { CANCEL_GRACE_MS, CHECK_TIMEOUT_MS, NO_CHECKS_WARNING } from "./verify";

const IDENTITY = { sessionId: "sess_1", generation: 3 };
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5" };
const BASE_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const HEAD_SHA = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const CREDENTIAL = "bootstrap-credential-9f8e7d";
const CONFIG = bridgeConfig(
  { ...IDENTITY, bootstrapCredential: CREDENTIAL },
  "wss://oncue.example",
);

function ctx(overrides: Partial<StepContext> = {}): StepContext {
  let issued = 0;
  return {
    nowMs: 50_000,
    nowIso: "2026-09-11T00:00:50.000Z",
    newId: () => `id_${++issued}`,
    relayPort: 5001,
    toolPort: 5002,
    ...overrides,
  };
}

/** Every emitted draft must survive the real parser as the object would run it. */
function run(state: AgentState, input: AgentInput, context = ctx()): StepOutcome {
  const result = step(state, input, context);
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `evt_${++issued}`, now: () => "2026-09-11T00:00:00.000Z" };
  for (const effect of result.effects) {
    if (effect.kind === "emit") {
      const parsed = parseEventJson(
        JSON.stringify(stampDraft(CONFIG, cursor, io, effect.draft)),
        "sandbox",
      );
      expect(parsed.ok, `${effect.draft.type}: ${parsed.ok ? "" : parsed.detail}`).toBe(true);
    }
    // Each token may ride exactly one effect kind, the one that carries it to
    // its holder or its request; nothing may carry the bootstrap credential.
    const text = JSON.stringify(effect);
    expect(text).not.toContain(CREDENTIAL);
    for (const [secret, carrier] of SECRET_CARRIERS) {
      if (effect.kind !== carrier) {
        expect(text, `${effect.kind} must not carry the ${carrier} secret`).not.toContain(secret);
      }
    }
  }
  const stateText = JSON.stringify(result.state);
  expect(stateText).not.toContain(CREDENTIAL);
  for (const [secret] of SECRET_CARRIERS) {
    expect(stateText).not.toContain(secret);
  }
  return result;
}

const kinds = (effects: readonly AgentEffect[]): string[] => effects.map((effect) => effect.kind);
const emitted = (effects: readonly AgentEffect[]): string[] =>
  effects.flatMap((effect) => (effect.kind === "emit" ? [effect.draft.type] : []));

const TOKEN = "ot1.secret.token.value";
const GIT_TOKEN = "ghs_secret_git_token";
const PUSH_TOKEN = "ghs_secret_push_token";
const UPLOAD_TOKEN = "up_secret_upload_token";
const RESTORE_TOKEN = "dl_secret_restore_token";
const SECRET_CARRIERS: readonly (readonly [string, AgentEffect["kind"]])[] = [
  [TOKEN, "set_model_token"],
  [GIT_TOKEN, "clone"],
  [RESTORE_TOKEN, "clone"],
  [PUSH_TOKEN, "hold_push_token"],
  [UPLOAD_TOKEN, "upload"],
];

function command(
  type: DeliverableCommand["type"],
  payload: Record<string, unknown>,
  overrides: Partial<{ commandId: string; runId: string | null; context: string | null }> = {},
): CommandFrame {
  const runId = overrides.runId === undefined ? "run_1" : overrides.runId;
  return buildCommandFrame(
    IDENTITY,
    {
      commandId: overrides.commandId ?? "cmd_1",
      sessionId: "sess_1",
      // What the protocol command carries: a `run.start` names no run of its own.
      runId: type === "run.start" ? null : runId,
      issuedAt: "2026-09-11T00:00:00.000Z",
      issuedByUserId: "usr_1",
      expected: { scope: "session", state: "active" },
      type,
      payload,
    } as unknown as DeliverableCommand,
    runId,
    overrides.context ?? null,
  );
}

function runStart(
  overrides: Partial<{
    commandId: string;
    runId: string;
    messageId: string;
    continuesRunId: string | null;
    text: string;
    context: string | null;
    checksOnly: boolean;
  }> = {},
): CommandFrame {
  return command(
    "run.start",
    {
      ...(overrides.checksOnly === undefined ? {} : { checksOnly: overrides.checksOnly }),
      instruction: {
        messageId: overrides.messageId ?? "msg_1",
        text: overrides.text ?? "Add a README section.",
        attachments: [],
      },
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        modelConnectionId: "conn_1",
        authenticationType: "api_key",
        contextWindow: 200_000,
        effort: null,
      },
      continuesRunId: overrides.continuesRunId ?? null,
    },
    {
      commandId: overrides.commandId ?? "cmd_start",
      runId: overrides.runId ?? "run_1",
      context: overrides.context ?? null,
    },
  );
}

function followUp(
  delivery: "steer_current_run" | "run_next",
  messageId = "msg_2",
  commandId = "cmd_follow",
): CommandFrame {
  return command(
    "run.follow_up",
    { messageId, text: "Also update the changelog.", attachments: [], delivery },
    { commandId },
  );
}

function cancel(commandId = "cmd_cancel"): CommandFrame {
  return command(
    "run.cancel",
    { reason: "user changed their mind", checkpointFirst: false },
    { commandId },
  );
}

function shutdown(commandId = "cmd_shutdown"): CommandFrame {
  return command("runtime.shutdown", { reason: "idle", graceMs: 1000 }, { commandId, runId: null });
}

function modelGrant(overrides: Partial<ModelGrantFrame> = {}): ModelGrantFrame {
  return buildGrantFrame(IDENTITY, {
    kind: "model",
    grantId: "grant_model",
    expiresAt: "2026-09-11T00:10:00.000Z",
    token: TOKEN,
    effort: null,
    modelSpec: null,
    brokerOrigin: "https://oncue.example",
    model: MODEL,
    runtime: "opencode",
    workspace: "none",
    ...overrides,
  }) as ModelGrantFrame;
}

function gitGrant(overrides: Partial<GitGrantFrame> = {}): GitGrantFrame {
  return buildGrantFrame(IDENTITY, {
    kind: "git",
    grantId: "grant_git",
    expiresAt: "2026-09-11T01:00:00.000Z",
    token: GIT_TOKEN,
    repository: {
      fullName: "acme/test-repo",
      cloneUrl: "https://github.com/acme/test-repo.git",
    },
    branch: "oncue/readme-1a2b",
    taskBranch: "oncue/readme-1a2b",
    baseSha: BASE_SHA,
    headSha: BASE_SHA,
    restore: null,
    ...overrides,
  }) as GitGrantFrame;
}

const PROJECT: ResolvedDefinition = {
  commands: {
    dev: { value: null, source: "platform_default" },
    test: { value: "pnpm test", source: "detected" },
    lint: { value: null, source: "platform_default" },
    typecheck: { value: null, source: "platform_default" },
    build: { value: null, source: "platform_default" },
  },
  preview: { value: null, source: "platform_default" },
};

const NO_CHECKS_PROJECT: ResolvedDefinition = {
  ...PROJECT,
  commands: { ...PROJECT.commands, test: { value: null, source: "platform_default" } },
};

const frame = (value: CommandFrame): AgentInput => ({
  kind: "frame",
  frame: { kind: "command", frame: value },
});
const grant = (value: GrantFrame): AgentInput => ({
  kind: "frame",
  frame: { kind: "grant", frame: value },
});
const event = (value: RuntimeEvent): AgentInput => ({ kind: "runtime_event", event: value });

const initial = () => initialAgentState("sess_1", 3);

/** Model held, no repository, OpenCode probed healthy: the state the object sends `run.start` into. */
function ready(): AgentState {
  let state = run(initial(), grant(modelGrant())).state;
  state = run(state, {
    kind: "runtime_started",
    result: { kind: "started", pid: 42, port: OPENCODE_PORT },
  }).state;
  state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
  state = run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
  return state;
}

/** A run OpenCode holds: prompt_async answered 204. */
function running(): AgentState {
  const started = run(ready(), frame(runStart())).state;
  return run(started, {
    kind: "prompt_settled",
    turnBase: null,
    runId: "run_1",
    result: { kind: "held", conversation: "ses_1" },
  }).state;
}

function activeRun(state: AgentState): ActiveRun {
  if (state.run.kind !== "active") {
    throw new Error("expected an active run");
  }
  return state.run;
}

function pushGrant(overrides: Partial<PushGrantFrame> = {}): PushGrantFrame {
  return buildGrantFrame(IDENTITY, {
    kind: "push",
    grantId: "grant_push",
    expiresAt: "2026-09-11T00:02:00.000Z",
    token: PUSH_TOKEN,
    repository: {
      fullName: "acme/test-repo",
      cloneUrl: "https://github.com/acme/test-repo.git",
    },
    ref: "refs/heads/oncue/readme-1a2b",
    parentSha: HEAD_SHA,
    ...overrides,
  }) as PushGrantFrame;
}

function uploadGrant(overrides: Partial<UploadGrantFrame> = {}): UploadGrantFrame {
  return buildGrantFrame(IDENTITY, {
    kind: "upload",
    grantId: "grant_upload",
    expiresAt: "2026-09-11T00:10:00.000Z",
    token: UPLOAD_TOKEN,
    artifactId: "art_1",
    url: "https://oncue.example/artifacts/art_1",
    maxBytes: 25 * 1024 * 1024,
    ...overrides,
  }) as UploadGrantFrame;
}

function checkpointCreate(
  reason: CheckpointReason = "idle",
  commandId = "cmd_checkpoint",
): CommandFrame {
  return command("checkpoint.create", { reason }, { commandId, runId: null });
}

/** The clone settled and the tree handed over, the model held: OpenCode is starting but not ready. */
function workspaceReady(): AgentState {
  let state = run(initial(), grant(gitGrant())).state;
  state = run(state, {
    kind: "clone_settled",
    grantId: "grant_git",
    result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
  }).state;
  state = run(state, { kind: "chown_settled", ok: true, detail: "ok" }).state;
  return run(state, grant(modelGrant({ workspace: "repository" }))).state;
}

/** `workspaceReady` plus OpenCode healthy and its stream connected. */
function repositoryReady(): AgentState {
  let state = run(workspaceReady(), {
    kind: "runtime_started",
    result: { kind: "started", pid: 42, port: OPENCODE_PORT },
  }).state;
  state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
  return run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
}

/** `repositoryReady` with a run OpenCode holds. */
function repositoryRunning(): AgentState {
  const started = run(repositoryReady(), frame(runStart())).state;
  return run(started, {
    kind: "prompt_settled",
    turnBase: null,
    runId: "run_1",
    result: { kind: "held", conversation: "ses_1" },
  }).state;
}

const END_SHA = "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b";

/** The run-end build settles with nothing to report beyond its snapshot, as a test that is about what follows needs it to. */
function measured(state: AgentState, context = ctx()): StepOutcome {
  return run(
    state,
    {
      kind: "diffs_built",
      runId: "run_1",
      purpose: "run_end",
      result: { kind: "built", headSha: END_SHA, status: null, turn: null, session: null },
    },
    context,
  );
}

function checkpointId(state: AgentState): string {
  if (state.checkpoint.kind === "idle") {
    throw new Error("expected a checkpoint in flight");
  }
  return state.checkpoint.checkpointId;
}

const settled = (state: AgentState, result: CheckpointOutcome): AgentInput => ({
  kind: "checkpoint_settled",
  diff: null,
  commit: null,
  checkpointId: checkpointId(state),
  result,
});

describe("initialAgentState", () => {
  it("starts with nothing held, nothing started, and an empty ring", () => {
    expect(initial()).toEqual({
      sessionId: "sess_1",
      generation: 3,
      runtime: { kind: "not_started" },
      workspace: { kind: "pending" },
      model: { kind: "none" },
      spawnedModels: null,
      run: { kind: "idle" },
      durableHead: null,
      pushGrant: null,
      checkpoint: { kind: "idle" },
      uploads: [],
      pendingStart: null,
      lastRun: null,
      decided: { entries: [], limit: DECIDED_RING_LIMIT },
      project: null,
      install: null,
      stopping: false,
      diffRebuild: { lastStartedAtMs: null, inFlight: false, wanted: false, timerArmed: false },
      lastTree: null,
      policy: null,
      unpublishedSubject: null,
      lastSessionDiff: null,
      secrets: { supplied: [], waiting: null, writes: [] },
      permissions: { held: [] },
      questions: { waiting: null },
      chainTip: null,
      commitInFlight: null,
      commitsThisRun: 0,
      resumeContext: null,
      described: null,
    });
  });
});

describe("connected and disconnected", () => {
  it("change nothing: the object sends grants next, and the shell parks emits itself", () => {
    expect(run(initial(), { kind: "connected" })).toEqual({ state: initial(), effects: [] });
    expect(run(ready(), { kind: "disconnected" })).toEqual({ state: ready(), effects: [] });
  });
});

describe("malformed frames", () => {
  it("rejects a run.start frame that names no run, as the parser would", () => {
    const result = run(ready(), frame({ ...runStart(), runId: null }));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start" },
        outcome: { kind: "rejected", reason: "malformed" },
      },
    ]);
    expect(result.state.run).toEqual(ready().run);
  });

  it("acks malformed when the frame carried an id to name", () => {
    const result = run(initial(), {
      kind: "frame",
      frame: { kind: "malformed", ref: { commandId: "cmd_x" }, detail: "bad" },
    });
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_x" },
        outcome: { kind: "rejected", reason: "malformed" },
      },
    ]);
    expect(result.state.decided.entries).toEqual([]);
  });

  it("logs when there is nothing to name", () => {
    const result = run(initial(), {
      kind: "frame",
      frame: { kind: "malformed", ref: null, detail: "bad" },
    });
    expect(kinds(result.effects)).toEqual(["log"]);
  });
});

describe("boot: grants, clone, chown, start, health", () => {
  it("a model grant with workspace none hands the token to the relay and starts OpenCode", () => {
    const result = run(initial(), grant(modelGrant()));

    expect(result.effects).toEqual([
      { kind: "ack", ref: { grantId: "grant_model" }, outcome: { kind: "accepted" } },
      {
        kind: "set_model_token",
        token: TOKEN,
        brokerOrigin: "https://oncue.example",
        expiresAt: "2026-09-11T00:10:00.000Z",
      },
      {
        kind: "start_runtime",
        port: OPENCODE_PORT,
        request: plannedRuntimeSpawn({
          port: OPENCODE_PORT,
          relayPort: 5001,
          toolPort: 5002,
          model: MODEL,
          modelSpec: null,
        }),
      },
    ]);
    expect(result.state).toMatchObject({
      workspace: { kind: "none" },
      model: { kind: "held", grantId: "grant_model", model: MODEL, modelSpec: null },
      runtime: { kind: "starting" },
    });
    expect(result.state.decided.entries).toEqual([
      { id: "grant_model", outcome: { kind: "accepted" } },
    ]);
  });

  it("a model grant with workspace repository waits for the clone before starting", () => {
    const result = run(initial(), grant(modelGrant({ workspace: "repository" })));
    expect(kinds(result.effects)).toEqual(["ack", "set_model_token"]);
    expect(result.state).toMatchObject({
      workspace: { kind: "pending" },
      runtime: { kind: "not_started" },
    });
  });

  it("a second model grant is a rotation: token replaced, OpenCode not restarted", () => {
    const state = ready();
    const result = run(
      state,
      grant(modelGrant({ grantId: "grant_model_2", token: "ot1.rotated" })),
    );
    expect(kinds(result.effects)).toEqual(["ack", "set_model_token"]);
    expect(result.state.model).toEqual({
      kind: "held",
      grantId: "grant_model_2",
      runtime: "opencode",
      model: MODEL,
      modelSpec: null,
    });
    expect(result.state.runtime).toEqual(state.runtime);
  });

  it("refuses a model grant naming a runtime this image does not carry, and holds nothing", () => {
    const result = run(initial(), grant(modelGrant({ runtime: "cursor" })));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_model" },
        outcome: { kind: "rejected", reason: "unsupported" },
      },
    ]);
    expect(result.state.model).toEqual({ kind: "none" });
  });

  it("refuses a rotation naming a different runtime: a session keeps its harness", () => {
    const state = run(initial(), grant(modelGrant())).state;
    const held = state.model as Extract<typeof state.model, { kind: "held" }>;
    // A different harness held first, written in by hand.
    const other = { ...held, runtime: "another" as typeof held.runtime };
    const result = run({ ...state, model: other }, grant(modelGrant({ grantId: "grant_model_2" })));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_model_2" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(result.state.model).toBe(other);
  });

  it("a git grant while the workspace is pending starts the clone and remembers the branch, never the token", () => {
    const result = run(initial(), grant(gitGrant()));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { grantId: "grant_git" }, outcome: { kind: "accepted" } },
      { kind: "clone", grant: gitGrant() },
    ]);
    expect(result.state.workspace).toEqual({
      kind: "cloning",
      grantId: "grant_git",
      branch: "oncue/readme-1a2b",
      taskBranch: "oncue/readme-1a2b",
      baseSha: BASE_SHA,
    });
    expect(JSON.stringify(result.state)).not.toContain("ghs_secret");
  });

  it("a git grant after the first is wrong_state: single use", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, grant(gitGrant({ grantId: "grant_git_2" })));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_git_2" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(result.state.workspace).toEqual(cloning.workspace);
  });

  it("a git grant for a session that said workspace none is wrong_state", () => {
    const none = run(initial(), grant(modelGrant())).state;
    expect(run(none, grant(gitGrant())).effects[0]).toEqual({
      kind: "ack",
      ref: { grantId: "grant_git" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });

  it("a push grant before the workspace is ready is wrong_state, and an upload grant for nothing declared too", () => {
    expect(run(initial(), grant(pushGrant())).effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_push" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(run(initial(), grant(uploadGrant())).effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_upload" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
  });

  it("a redelivered grant replays its ack and does nothing else", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, grant(gitGrant()));
    expect(result).toEqual({
      state: cloning,
      effects: [{ kind: "ack", ref: { grantId: "grant_git" }, outcome: { kind: "accepted" } }],
    });
  });

  it("clone settled: workspace ready with the clone's head, project recorded, chown requested", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
    });
    expect(result.effects).toEqual([
      { kind: "log", line: "environment definition: test = pnpm test (detected)" },
      { kind: "chown_workspace", uid: 1001 },
    ]);
    expect(result.state.workspace).toEqual({
      kind: "ready",
      branch: "oncue/readme-1a2b",
      taskBranch: "oncue/readme-1a2b",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
    expect(result.state.project).toBe(PROJECT);
  });

  it("clone failed: workspace failed and a boot failure reported as runtime.disconnected", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "failed", category: "auth", detail: "401" },
    });
    expect(result.state.workspace).toEqual({ kind: "failed", detail: "401" });
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "runtime.disconnected",
          runId: null,
          payload: {
            reason: "boot_failed",
            detail: "boot failed: clone (auth): 401",
            exitCode: null,
            diagnostics: [],
            expectReconnect: false,
          },
        },
      },
    ]);
  });

  it("a clone settling for another grant is logged and ignored", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, {
      kind: "clone_settled",
      grantId: "grant_other",
      result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
    });
    expect(kinds(result.effects)).toEqual(["log"]);
    expect(result.state).toEqual(cloning);
  });

  it("chown ok with the model held starts OpenCode; chown ok before the model grant waits", () => {
    let state = run(initial(), grant(gitGrant())).state;
    state = run(state, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
    }).state;
    const waiting = run(state, { kind: "chown_settled", ok: true, detail: "ok" });
    expect(waiting.effects).toEqual([]);
    expect(waiting.state.runtime).toEqual({ kind: "not_started" });

    const held = run(waiting.state, grant(modelGrant({ workspace: "repository" })));
    expect(kinds(held.effects)).toEqual(["ack", "set_model_token", "start_runtime"]);
    expect(held.state.runtime).toEqual({ kind: "starting" });
  });

  it.each(["opencode", "codex", "pi"] as const)(
    "the clone decides the boot the same way whatever the harness (%s)",
    (runtime) => {
      // The clone lands before any harness starts (record 07), so its outcome
      // cannot depend on which harness the session runs.
      const detail =
        "The commit this session started from (3f2a9c1e) is no longer on GitHub: the history of main was rewritten. Start a new session to continue from main as it is now.";
      const cloning = run(
        run(initial(), grant(gitGrant())).state,
        grant(modelGrant({ workspace: "repository", runtime })),
      ).state;
      const failed = run(cloning, {
        kind: "clone_settled",
        grantId: "grant_git",
        result: { kind: "failed", category: "commit_missing", detail },
      });
      expect(kinds(failed.effects)).not.toContain("start_runtime");
      expect(failed.effects).toContainEqual(
        expect.objectContaining({
          kind: "emit",
          draft: expect.objectContaining({
            type: "runtime.disconnected",
            payload: expect.objectContaining({ reason: "boot_failed", detail }),
          }),
        }),
      );

      let started = run(cloning, {
        kind: "clone_settled",
        grantId: "grant_git",
        result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
      }).state;
      const chowned = run(started, { kind: "chown_settled", ok: true, detail: "ok" });
      started = chowned.state;
      const start = chowned.effects.find((effect) => effect.kind === "start_runtime");
      expect(start).toMatchObject({ port: runtimePlan(runtime).defaultPort });
      expect(runtimeOf(started).id).toBe(runtime);
    },
  );

  it.each(["opencode", "codex", "pi", "claude"] as const)(
    "a dev host's picked port replaces the image's fixed port whatever the harness (%s)",
    (runtime) => {
      // Several bridges share a developer machine, so each one's harness
      // serves on the port its controller picked, never the image's.
      const picked = ctx({ runtimePort: 51_234 });
      const cloning = run(
        run(initial(), grant(gitGrant()), picked).state,
        grant(modelGrant({ workspace: "repository", runtime })),
        picked,
      ).state;
      const cloned = run(
        cloning,
        {
          kind: "clone_settled",
          grantId: "grant_git",
          result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
        },
        picked,
      ).state;
      const chowned = run(cloned, { kind: "chown_settled", ok: true, detail: "ok" }, picked);
      const start = chowned.effects.find((effect) => effect.kind === "start_runtime");
      expect(runtimePlan(runtime).defaultPort).not.toBe(51_234);
      expect(start).toMatchObject({ port: 51_234 });
      expect(JSON.stringify(start)).toContain("51234");
    },
  );

  it("chown failed is a boot failure", () => {
    let state = run(initial(), grant(gitGrant())).state;
    state = run(state, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
    }).state;
    const result = run(state, {
      kind: "chown_settled",
      ok: false,
      detail: "refused: uid_not_allowed",
    });
    expect(result.state.workspace).toEqual({ kind: "failed", detail: "refused: uid_not_allowed" });
    expect(emitted(result.effects)).toEqual(["runtime.disconnected"]);
  });

  it("chown settling with no clone is logged", () => {
    expect(
      kinds(run(initial(), { kind: "chown_settled", ok: true, detail: "ok" }).effects),
    ).toEqual(["log"]);
  });

  it("runtime started: probing, with an immediate health probe and the event subscription", () => {
    const starting = run(initial(), grant(modelGrant())).state;
    const result = run(
      starting,
      { kind: "runtime_started", result: { kind: "started", pid: 42, port: OPENCODE_PORT } },
      ctx({ nowMs: 1_000 }),
    );
    expect(result.effects).toEqual([{ kind: "probe_health", port: OPENCODE_PORT, afterMs: 0 }]);
    expect(result.state.runtime).toEqual({
      kind: "probing",
      attempts: 0,
      startedAtMs: 1_000,
      port: OPENCODE_PORT,
    });
  });

  it("runtime failed to start: exited and a boot failure", () => {
    const starting = run(initial(), grant(modelGrant())).state;
    const result = run(starting, {
      kind: "runtime_started",
      result: { kind: "failed", detail: "refused: binary_not_allowed" },
    });
    expect(result.state.runtime).toEqual({ kind: "exited", code: null });
    expect(emitted(result.effects)).toEqual(["runtime.disconnected"]);
  });

  it("runtime started while not starting is logged", () => {
    expect(
      kinds(
        run(initial(), { kind: "runtime_started", result: { kind: "started", pid: 1, port: 1 } })
          .effects,
      ),
    ).toEqual(["log"]);
  });

  it("health healthy: listening, and the event subscription opens; ready waits for the stream", () => {
    let state = run(initial(), grant(modelGrant())).state;
    state = run(
      state,
      { kind: "runtime_started", result: { kind: "started", pid: 42, port: OPENCODE_PORT } },
      ctx({ nowMs: 1_000 }),
    ).state;
    const healthy = run(
      state,
      { kind: "health", result: { kind: "healthy", version: "1.18.30" } },
      ctx({ nowMs: 1_500 }),
    );
    expect(healthy.effects).toEqual([
      { kind: "log", line: "opencode 1.18.30 answered health after 1 probes; listening" },
      { kind: "subscribe_events", port: OPENCODE_PORT },
    ]);
    expect(healthy.state.runtime).toEqual({
      kind: "listening",
      version: "1.18.30",
      port: OPENCODE_PORT,
      startedAtMs: 1_000,
    });
    const result = run(
      healthy.state,
      { kind: "runtime_event", event: { kind: "server_connected" } },
      ctx({ nowMs: 1_750 }),
    );
    expect(result.effects).toEqual([
      { kind: "log", line: "opencode event stream connected; runtime ready" },
      {
        kind: "emit",
        draft: {
          type: "runtime.ready",
          runId: null,
          payload: {
            runtimeName: "opencode",
            runtimeVersion: "1.18.30",
            healthChecks: [
              { name: "global_health", passed: true },
              { name: "event_stream", passed: true },
            ],
            startupMs: 750,
          },
        },
      },
    ]);
    expect(result.state.runtime).toEqual({
      kind: "ready",
      version: "1.18.30",
      port: OPENCODE_PORT,
    });
  });

  it("health not yet: another probe after the interval, counted", () => {
    let state = run(initial(), grant(modelGrant())).state;
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: OPENCODE_PORT },
    }).state;
    const result = run(state, { kind: "health", result: { kind: "not_yet", detail: "refused" } });
    expect(result.effects).toEqual([
      { kind: "log", line: "opencode health probe 1: refused" },
      { kind: "probe_health", port: OPENCODE_PORT, afterMs: HEALTH_POLL_INTERVAL_MS },
    ]);
    expect(result.state.runtime).toMatchObject({ kind: "probing", attempts: 1 });
    const second = run(result.state, {
      kind: "health",
      result: { kind: "not_yet", detail: "refused" },
    });
    expect(second.effects).toEqual([
      { kind: "probe_health", port: OPENCODE_PORT, afterMs: HEALTH_POLL_INTERVAL_MS },
    ]);
  });

  it("health never: past the attempt budget, SIGKILL and a boot failure", () => {
    let state = run(initial(), grant(modelGrant())).state;
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: OPENCODE_PORT },
    }).state;
    state = {
      ...state,
      runtime: {
        kind: "probing",
        attempts: HEALTH_POLL_ATTEMPTS - 1,
        startedAtMs: 0,
        port: OPENCODE_PORT,
      },
    };
    const result = run(state, { kind: "health", result: { kind: "not_yet", detail: "refused" } });
    expect(kinds(result.effects)).toEqual(["signal_runtime", "emit"]);
    expect(result.effects[0]).toEqual({ kind: "signal_runtime", signal: "SIGKILL" });
    expect(result.state.runtime).toEqual({ kind: "exited", code: null });
  });

  it("a health answer outside probing changes nothing", () => {
    expect(
      run(ready(), { kind: "health", result: { kind: "not_yet", detail: "refused" } }),
    ).toEqual({
      state: ready(),
      effects: [],
    });
  });
});

describe("a model grant naming another model (record 15)", () => {
  const OTHER = { provider: "openai", modelId: "gpt-6-sol" };
  const OTHER_SPEC = {
    name: "GPT-6 Sol",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    effortLevels: null,
    imageInput: false,
  };
  const CATALOG = [{ ...OTHER, spec: OTHER_SPEC }];

  /** OpenCode up, started from a grant that listed `OTHER` as a model the session may change to. */
  function readyWithCatalog(): AgentState {
    let state = run(initial(), grant(modelGrant({ catalog: CATALOG }))).state;
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: OPENCODE_PORT },
    }).state;
    state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
    return run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
  }

  /** A `run.start` whose record names `OTHER`, as the object sends after the change's grant. */
  function startOnOther(overrides: Parameters<typeof runStart>[0] = {}): CommandFrame {
    const start = runStart(overrides);
    return {
      ...start,
      command: {
        ...start.command,
        payload: {
          ...(start.command.payload as Record<string, unknown>),
          model: {
            provider: OTHER.provider,
            modelId: OTHER.modelId,
            modelConnectionId: "conn_2",
            authenticationType: "api_key",
            contextWindow: 1_050_000,
            effort: null,
          },
        },
      },
    } as CommandFrame;
  }

  const change = (overrides: Partial<ModelGrantFrame> = {}) =>
    grant(
      modelGrant({
        grantId: "grant_model_2",
        token: "ot1.changed",
        model: OTHER,
        modelSpec: OTHER_SPEC,
        ...overrides,
      }),
    );

  it("starts OpenCode configured for every model the grant lists and remembers which", () => {
    const result = run(initial(), grant(modelGrant({ catalog: CATALOG })));
    expect(result.effects.at(-1)).toEqual({
      kind: "start_runtime",
      port: OPENCODE_PORT,
      request: plannedRuntimeSpawn({
        port: OPENCODE_PORT,
        relayPort: 5001,
        toolPort: 5002,
        model: MODEL,
        modelSpec: null,
        catalog: CATALOG,
      }),
    });
    expect(result.state.spawnedModels).toEqual([MODEL, OTHER]);
  });

  it("a harness started from a grant that listed nothing can be prompted with its own model alone", () => {
    expect(ready().spawnedModels).toEqual([MODEL]);
  });

  it("between runs, a model the harness was configured for is taken: token replaced, harness kept, the next prompt names it", () => {
    const state = readyWithCatalog();
    const changed = run(state, change());
    expect(changed.effects).toEqual([
      { kind: "ack", ref: { grantId: "grant_model_2" }, outcome: { kind: "accepted" } },
      {
        kind: "set_model_token",
        token: "ot1.changed",
        brokerOrigin: "https://oncue.example",
        expiresAt: "2026-09-11T00:10:00.000Z",
      },
    ]);
    expect(changed.state.runtime).toEqual(state.runtime);
    expect(changed.state.model).toMatchObject({
      kind: "held",
      grantId: "grant_model_2",
      model: OTHER,
      modelSpec: OTHER_SPEC,
      // A later grant that lists nothing keeps what the harness was started with.
      catalog: CATALOG,
    });
    const started = run(changed.state, frame(startOnOther()));
    expect(started.effects.find((effect) => effect.kind === "prompt")).toMatchObject({
      model: OTHER,
      imageInput: false,
    });
  });

  it("refuses a model the running harness was not configured for, and keeps the model and token it has", () => {
    const state = ready();
    const result = run(state, change());
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_model_2" },
        outcome: { kind: "rejected", reason: "unsupported" },
      },
    ]);
    expect(result.state.model).toBe(state.model);
  });

  it("refuses a change while a run is working: nothing changes inside a run", () => {
    const state = run(readyWithCatalog(), frame(runStart())).state;
    const result = run(state, change());
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_model_2" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(result.state.model).toBe(state.model);
  });

  it("takes a change while a cancelled run winds down, and prompts the held start on the new model", () => {
    let state = run(readyWithCatalog(), frame(runStart())).state;
    state = run(state, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    }).state;
    state = run(state, frame(cancel())).state;
    expect(activeRun(state).phase).toBe("winding_down");
    const changed = run(state, change());
    expect(kinds(changed.effects)).toEqual(["ack", "set_model_token"]);
    const held = run(
      changed.state,
      frame(startOnOther({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_2" })),
    );
    expect(held.state.pendingStart).not.toBeNull();
    expect(held.state.model).toMatchObject({ model: OTHER });
  });

  it("refuses a run.start naming another model than the one granted, so no run is prompted under the wrong name", () => {
    // The grant for the changed model was refused; the start that followed it must not run on the old one.
    const state = ready();
    const refusedGrant = run(state, change()).state;
    const result = run(refusedGrant, frame(startOnOther()));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(result.state.run).toEqual({ kind: "idle" });
  });

  it("a checks-only start prompts no model, so the model it names is not compared", () => {
    const result = run(ready(), frame(startOnOther({ checksOnly: true })));
    expect(result.effects[0]).toMatchObject({ kind: "ack", outcome: { kind: "accepted" } });
  });

  it("before the harness starts, any model is taken and the harness starts on it", () => {
    const waiting = run(initial(), grant(modelGrant({ workspace: "repository" }))).state;
    expect(waiting.spawnedModels).toBeNull();
    const changed = run(waiting, change({ workspace: "repository" }));
    expect(kinds(changed.effects)).toEqual(["ack", "set_model_token"]);
    expect(changed.state.model).toMatchObject({ model: OTHER });
  });

  it("the same model again is a rotation whatever the run is doing", () => {
    const state = run(readyWithCatalog(), frame(runStart())).state;
    const result = run(
      state,
      grant(modelGrant({ grantId: "grant_model_3", token: "ot1.rotated" })),
    );
    expect(kinds(result.effects)).toEqual(["ack", "set_model_token"]);
  });

  it("a harness that keeps the model it started on refuses any other, whatever the grant listed", () => {
    let state = run(
      initial(),
      grant(
        modelGrant({ runtime: "codex", model: OTHER, catalog: [{ ...MODEL, spec: OTHER_SPEC }] }),
      ),
    ).state;
    expect(state.spawnedModels).toEqual([OTHER]);
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: 1 },
    }).state;
    const result = run(
      state,
      grant(modelGrant({ grantId: "grant_model_2", runtime: "codex", model: MODEL })),
    );
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_model_2" },
        outcome: { kind: "rejected", reason: "unsupported" },
      },
    ]);
  });
});

describe("run.start", () => {
  it("before the runtime is ready: no_runtime", () => {
    const starting = run(initial(), grant(modelGrant())).state;
    expect(run(starting, frame(runStart())).effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start" },
        outcome: { kind: "rejected", reason: "no_runtime" },
      },
    ]);
  });

  it("ready and idle: ack accepted, then a prompt into a fresh session; the run is prompting", () => {
    const result = run(ready(), frame(runStart()));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_start" }, outcome: { kind: "accepted" } },
      {
        kind: "prompt",
        runId: "run_1",
        conversation: null,
        text: "Add a README section.",
        model: MODEL,
        effort: null,
        turnBase: null,
        attachments: [],
        messageId: "msg_1",
        imageInput: false,
      },
    ]);
    expect(result.state.run).toEqual({
      kind: "active",
      runId: "run_1",
      commandId: "cmd_start",
      conversation: null,
      phase: "prompting",
      windDown: null,
      startedAtMs: 50_000,
      instructionText: "Add a README section.",
      contextWindow: 200_000,
      effort: null,
      promptedMessageIds: ["msg_1"],
      normalizer: emptyNormalizerState,
      lastAssistantText: null,
      toolsRun: 0,
      skipRequiredChecks: false,
      checksOnly: false,
      turnBaseSha: null,
      verification: null,
      subagents: { agents: [], allowed: [], resumes: [], started: 0 },
    });
  });

  it("a redelivered commandId replays the earlier ack and prompts nothing", () => {
    const started = run(ready(), frame(runStart())).state;
    const again = run(started, frame(runStart()));
    expect(again).toEqual({
      state: started,
      effects: [{ kind: "ack", ref: { commandId: "cmd_start" }, outcome: { kind: "accepted" } }],
    });
  });

  it("while a run is active: wrong_state", () => {
    const result = run(
      running(),
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_9" })),
    );
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start_2" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
  });

  it("while the previous run winds down after a cancel: accepted and held until idle", () => {
    const cancelled = run(running(), frame(cancel())).state;
    const held = run(
      cancelled,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_9" })),
    );
    expect(held.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_start_2" }, outcome: { kind: "accepted" } },
    ]);
    expect(held.state.pendingStart?.command.commandId).toBe("cmd_start_2");

    const third = run(
      held.state,
      frame(runStart({ commandId: "cmd_start_3", runId: "run_3", messageId: "msg_10" })),
    );
    expect(third.effects[0]).toEqual({
      kind: "ack",
      ref: { commandId: "cmd_start_3" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });

    const released = run(held.state, event({ kind: "session_idle" }));
    expect(released.effects).toEqual([
      {
        kind: "prompt",
        runId: "run_2",
        conversation: null,
        text: "Add a README section.",
        model: MODEL,
        effort: null,
        turnBase: null,
        attachments: [],
        messageId: "msg_9",
        imageInput: false,
      },
    ]);
    expect(released.state.pendingStart).toBeNull();
    expect(released.state.run).toMatchObject({
      kind: "active",
      runId: "run_2",
      phase: "prompting",
    });
  });

  it("with no model held: wrong_state", () => {
    const state: AgentState = { ...ready(), model: { kind: "none" } };
    expect(run(state, frame(runStart())).effects[0]).toEqual({
      kind: "ack",
      ref: { commandId: "cmd_start" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });

  it("a NEW commandId carrying a messageId the last run already prompted: duplicate", () => {
    const finished = run(running(), event({ kind: "session_idle" })).state;
    const result = run(
      finished,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_1" })),
    );
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start_2" },
        outcome: { kind: "rejected", reason: "duplicate" },
      },
    ]);
  });

  it("continuesRunId naming the last run reuses its OpenCode session", () => {
    const finished = run(running(), event({ kind: "session_idle" })).state;
    const result = run(
      finished,
      frame(
        runStart({
          commandId: "cmd_start_2",
          runId: "run_2",
          messageId: "msg_2",
          continuesRunId: "run_1",
        }),
      ),
    );
    expect(result.effects[1]).toEqual({
      kind: "prompt",
      runId: "run_2",
      conversation: "ses_1",
      text: "Add a README section.",
      model: MODEL,
      effort: null,
      turnBase: null,
      attachments: [],
      messageId: "msg_2",
      imageInput: false,
    });
  });

  it("continuesRunId naming some other run gets a fresh session", () => {
    const finished = run(running(), event({ kind: "session_idle" })).state;
    const result = run(
      finished,
      frame(
        runStart({
          commandId: "cmd_start_2",
          runId: "run_2",
          messageId: "msg_2",
          continuesRunId: "run_0",
        }),
      ),
    );
    expect(result.effects[1]).toMatchObject({ kind: "prompt", conversation: null });
  });
});

describe("prompt_settled", () => {
  it("held: the run is running and run.started is emitted for a repo-less session", () => {
    const started = run(ready(), frame(runStart())).state;
    const result = run(started, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    });
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.started",
          runId: "run_1",
          payload: { baseSha: EMPTY_TREE_SHA, branch: NO_REPOSITORY_BRANCH, resumedFrom: null },
        },
      },
    ]);
    expect(result.state.run).toMatchObject({
      kind: "active",
      phase: "running",
      conversation: "ses_1",
    });
  });

  it("held with a repository: run.started names the branch and base, then repository.status", () => {
    let state = run(initial(), grant(gitGrant())).state;
    state = run(state, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "cloned", headSha: HEAD_SHA, project: PROJECT, install: null },
    }).state;
    state = run(state, { kind: "chown_settled", ok: true, detail: "ok" }).state;
    state = run(state, grant(modelGrant({ workspace: "repository" }))).state;
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: OPENCODE_PORT },
    }).state;
    state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
    state = run(state, { kind: "runtime_event", event: { kind: "server_connected" } }).state;
    state = run(state, frame(runStart())).state;
    const result = run(state, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    });
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.started",
          runId: "run_1",
          payload: { baseSha: BASE_SHA, branch: "oncue/readme-1a2b", resumedFrom: null },
        },
      },
      {
        kind: "emit",
        draft: {
          type: "repository.status",
          runId: "run_1",
          payload: {
            branch: "oncue/readme-1a2b",
            headSha: HEAD_SHA,
            baseSha: BASE_SHA,
            ahead: 0,
            behind: 0,
            dirty: false,
            changedFileCount: 0,
            untrackedFileCount: 0,
            additions: 0,
            deletions: 0,
          },
        },
      },
    ]);
  });

  it("refused: run.failed at stage execution and the run is idle", () => {
    const started = run(ready(), frame(runStart())).state;
    const result = run(started, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "refused", detail: "opencode answered 500" },
    });
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.failed",
          runId: "run_1",
          payload: {
            stage: "execution",
            error: { category: "runtime_error", message: "opencode answered 500" },
            summary: null,
            evidence: [],
            branch: null,
            pullRequestNumber: null,
            usage: null,
            durationMs: 0,
          },
        },
      },
    ]);
    expect(result.state.run).toEqual({ kind: "idle" });
    expect(result.state.lastRun).toBeNull();
  });

  it("held after a cancel arrived first: the session is aborted and no run.started goes out", () => {
    const started = run(ready(), frame(runStart())).state;
    const cancelled = run(started, frame(cancel()));
    expect(cancelled.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_cancel" }, outcome: { kind: "accepted" } },
    ]);
    const result = run(cancelled.state, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    });
    expect(result.effects).toEqual([{ kind: "abort", runId: "run_1", conversation: "ses_1" }]);
    expect(result.state.run).toMatchObject({ phase: "winding_down", conversation: "ses_1" });
  });

  it("refused after a cancel: the run is simply idle, since the object committed run.cancelled", () => {
    const started = run(ready(), frame(runStart())).state;
    const cancelled = run(started, frame(cancel())).state;
    const result = run(cancelled, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "refused", detail: "x" },
    });
    expect(result.effects).toEqual([]);
    expect(result.state.run).toEqual({ kind: "idle" });
  });

  it("for a run that is not active: logged", () => {
    expect(
      kinds(
        run(ready(), {
          kind: "prompt_settled",
          turnBase: null,
          runId: "run_9",
          result: { kind: "held", conversation: "s" },
        }).effects,
      ),
    ).toEqual(["log"]);
  });

  it("a steer's prompt settling while running changes nothing; a refused one is logged", () => {
    const state = running();
    expect(
      run(state, {
        kind: "prompt_settled",
        turnBase: null,
        runId: "run_1",
        result: { kind: "held", conversation: "ses_1" },
      }),
    ).toEqual({ state, effects: [] });
    expect(
      kinds(
        run(state, {
          kind: "prompt_settled",
          turnBase: null,
          runId: "run_1",
          result: { kind: "refused", detail: "busy" },
        }).effects,
      ),
    ).toEqual(["log"]);
  });
});

describe("composer attachments reach the prompt", () => {
  const FETCH = {
    artifactId: "att_1",
    name: "screen.png",
    contentType: "image/png",
    byteSize: 120,
    url: "https://oncue.example/api/sessions/sess_1/attachments/att_1/content",
    token: "one-time",
  };

  it("a run.start's attachments and the model's image support ride on its prompt", () => {
    const base = ready();
    const model = base.model as Extract<AgentState["model"], { kind: "held" }>;
    const state: AgentState = {
      ...base,
      model: {
        ...model,
        modelSpec: {
          name: "Claude Opus 5.5",
          contextWindow: 1_000_000,
          maxOutput: 128_000,
          effortLevels: null,
          imageInput: true,
        },
      },
    };
    const result = run(state, frame({ ...runStart(), attachments: [FETCH] }));
    expect(result.effects[1]).toMatchObject({
      kind: "prompt",
      attachments: [FETCH],
      messageId: "msg_1",
      imageInput: true,
    });
  });

  it("a steer's attachments ride on its prompt", () => {
    const result = run(
      running(),
      frame({ ...followUp("steer_current_run"), attachments: [FETCH] }),
    );
    expect(result.effects[1]).toMatchObject({
      kind: "prompt",
      attachments: [FETCH],
      messageId: "msg_2",
      imageInput: false,
    });
  });
});

describe("run.follow_up", () => {
  it("steer while running: accepted and prompted into the same session, no event", () => {
    const result = run(running(), frame(followUp("steer_current_run")));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_follow" }, outcome: { kind: "accepted" } },
      {
        kind: "prompt",
        runId: "run_1",
        conversation: "ses_1",
        text: "Also update the changelog.",
        model: MODEL,
        effort: null,
        turnBase: null,
        attachments: [],
        messageId: "msg_2",
        imageInput: false,
      },
    ]);
    expect(activeRun(result.state).promptedMessageIds).toEqual(["msg_1", "msg_2"]);
  });

  it("steer with a messageId already prompted: duplicate", () => {
    const once = run(running(), frame(followUp("steer_current_run"))).state;
    const result = run(once, frame(followUp("steer_current_run", "msg_2", "cmd_follow_2")));
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_follow_2" },
        outcome: { kind: "rejected", reason: "duplicate" },
      },
    ]);
  });

  it("steer with no running run: wrong_state", () => {
    expect(run(ready(), frame(followUp("steer_current_run"))).effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_follow" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    const prompting = run(ready(), frame(runStart())).state;
    expect(run(prompting, frame(followUp("steer_current_run"))).effects[0]).toMatchObject({
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });

  it("run_next: accepted and nothing else; the object holds it", () => {
    expect(run(ready(), frame(followUp("run_next")))).toMatchObject({
      effects: [{ kind: "ack", ref: { commandId: "cmd_follow" }, outcome: { kind: "accepted" } }],
    });
    expect(run(running(), frame(followUp("run_next"))).effects).toHaveLength(1);
  });

  it("before the runtime is ready: no_runtime", () => {
    expect(run(initial(), frame(followUp("run_next"))).effects[0]).toMatchObject({
      outcome: { kind: "rejected", reason: "no_runtime" },
    });
  });
});

describe("run.cancel", () => {
  it("while running: accepted, winding down, abort; no run.cancelled event", () => {
    const result = run(running(), frame(cancel()));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_cancel" }, outcome: { kind: "accepted" } },
      { kind: "abort", runId: "run_1", conversation: "ses_1" },
    ]);
    expect(result.state.run).toMatchObject({
      phase: "winding_down",
      windDown: "cancelled_by_object",
    });
  });

  it("already winding down: accepted, idempotent", () => {
    const winding = run(running(), frame(cancel())).state;
    const result = run(winding, frame(cancel("cmd_cancel_2")));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_cancel_2" }, outcome: { kind: "accepted" } },
    ]);
    expect(result.state.run).toEqual(winding.run);
  });

  it("with no run: wrong_state", () => {
    expect(run(ready(), frame(cancel())).effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_cancel" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
  });

  it("then abort_settled changes nothing: the idle that follows ends the run", () => {
    const winding = run(running(), frame(cancel())).state;
    expect(
      run(winding, { kind: "abort_settled", runId: "run_1", conversation: "ses_1", ok: true }),
    ).toEqual({
      state: winding,
      effects: [],
    });
  });

  it("the abort's own error is suppressed and the idle ends the run without a terminal event", () => {
    const winding = run(running(), frame(cancel())).state;
    const errored = run(
      winding,
      event({
        kind: "session_error",
        name: "MessageAbortedError",
        message: "aborted",
        status: null,
      }),
    );
    expect(errored.effects).toEqual([]);
    const idle = run(errored.state, event({ kind: "session_idle" }));
    expect(idle.effects).toEqual([]);
    expect(idle.state.run).toEqual({ kind: "idle" });
    expect(idle.state.lastRun).toEqual({
      runId: "run_1",
      conversation: "ses_1",
      promptedMessageIds: ["msg_1"],
      commitSubject: "Add a README section.",
      verification: "none",
    });
  });

  it("an unexpected error while winding down is logged, not reported", () => {
    const winding = run(running(), frame(cancel())).state;
    expect(
      kinds(
        run(
          winding,
          event({ kind: "session_error", name: "UnknownError", message: "x", status: null }),
        ).effects,
      ),
    ).toEqual(["log"]);
  });

  it("tool parts still settle while winding down, so the timeline closes them", () => {
    const withTool = run(
      running(),
      event({
        kind: "tool_part",
        messageId: "m1",
        part: {
          callId: "t1",
          tool: "bash",
          status: "running",
          title: "sleep",
          input: {},
          output: null,
          error: null,
          exitCode: null,
          startedAtMs: 1,
          endedAtMs: null,
        },
      }),
    ).state;
    const winding = run(withTool, frame(cancel())).state;
    const settled = run(
      winding,
      event({
        kind: "tool_part",
        messageId: "m1",
        part: {
          callId: "t1",
          tool: "bash",
          status: "error",
          title: "sleep",
          input: {},
          output: null,
          error: "Tool execution aborted",
          exitCode: null,
          startedAtMs: 1,
          endedAtMs: 2,
        },
      }),
    );
    expect(emitted(settled.effects)).toEqual(["tool.failed"]);
    expect(activeRun(settled.state).toolsRun).toBe(1);
  });
});

describe("runtime.shutdown", () => {
  it("with OpenCode up and a run active: ack, abort, SIGTERM; the run winds down with no run event of its own; the exit closes the link", () => {
    const result = run(running(), frame(shutdown()));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_shutdown" }, outcome: { kind: "accepted" } },
      { kind: "abort", runId: "run_1", conversation: "ses_1" },
      { kind: "signal_runtime", signal: "SIGTERM" },
    ]);
    expect(result.state.stopping).toBe(true);
    expect(result.state.run).toMatchObject({
      phase: "winding_down",
      windDown: "cancelled_by_object",
    });

    const exited = run(result.state, { kind: "runtime_exited", code: 0, signal: null });
    expect(kinds(exited.effects)).toEqual(["emit", "close_link"]);
    expect(exited.effects[0]).toMatchObject({
      draft: {
        type: "runtime.disconnected",
        payload: { reason: "shutdown_requested", exitCode: 0 },
      },
    });
    expect(exited.state.run).toEqual({ kind: "idle" });
  });

  it("after a shutdown was accepted, run commands are no_runtime: the generation raced the shutdown", () => {
    const stopping = run(running(), frame(shutdown())).state;
    const result = run(
      stopping,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_9" })),
    );
    expect(result.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_start_2" },
        outcome: { kind: "rejected", reason: "no_runtime" },
      },
    ]);
    expect(result.state.pendingStart).toBeNull();
  });

  it("after a cancel already wound the run down: no second abort", () => {
    const winding = run(running(), frame(cancel())).state;
    const result = run(winding, frame(shutdown()));
    expect(kinds(result.effects)).toEqual(["ack", "signal_runtime"]);
    expect(result.state.run).toEqual(winding.run);
  });

  it("a pending start held before the shutdown is dropped by it", () => {
    const winding = run(running(), frame(cancel())).state;
    const held = run(
      winding,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_9" })),
    ).state;
    expect(held.pendingStart).not.toBeNull();
    expect(run(held, frame(shutdown())).state.pendingStart).toBeNull();
  });

  it("with no runtime: ack and close the link now", () => {
    expect(run(initial(), frame(shutdown())).effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_shutdown" }, outcome: { kind: "accepted" } },
      { kind: "close_link" },
    ]);
  });

  it("is never no_runtime and is replayed on redelivery", () => {
    const stopped = run(initial(), frame(shutdown())).state;
    expect(run(stopped, frame(shutdown()))).toEqual({
      state: stopped,
      effects: [{ kind: "ack", ref: { commandId: "cmd_shutdown" }, outcome: { kind: "accepted" } }],
    });
  });

  it("a start that fails while stopping still closes the link", () => {
    const starting = run(initial(), grant(modelGrant())).state;
    const stopping = run(starting, frame(shutdown())).state;
    expect(
      kinds(
        run(stopping, { kind: "runtime_started", result: { kind: "failed", detail: "x" } }).effects,
      ),
    ).toEqual(["emit", "close_link"]);
  });
});

describe("push grants", () => {
  it("with the workspace ready: accepted, coordinates kept, the token handed to the holder and nowhere else", () => {
    const result = run(workspaceReady(), grant(pushGrant()));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { grantId: "grant_push" }, outcome: { kind: "accepted" } },
      {
        kind: "hold_push_token",
        grantId: "grant_push",
        token: PUSH_TOKEN,
        cloneUrl: "https://github.com/acme/test-repo.git",
        ref: "refs/heads/oncue/readme-1a2b",
      },
    ]);
    expect(result.state.pushGrant).toEqual({
      grantId: "grant_push",
      ref: "refs/heads/oncue/readme-1a2b",
      repository: {
        fullName: "acme/test-repo",
        cloneUrl: "https://github.com/acme/test-repo.git",
      },
    });
    expect(result.state.durableHead).toBe(HEAD_SHA);
  });

  it("a second push grant replaces the first: rotation", () => {
    const held = run(workspaceReady(), grant(pushGrant())).state;
    const result = run(held, grant(pushGrant({ grantId: "grant_push_2", token: "ghs_rotated" })));
    expect(kinds(result.effects)).toEqual(["ack", "hold_push_token"]);
    expect(result.state.pushGrant?.grantId).toBe("grant_push_2");
  });

  it("while the clone is still running: wrong_state", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    expect(run(cloning, grant(pushGrant())).effects[0]).toEqual({
      kind: "ack",
      ref: { grantId: "grant_push" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });
});

describe("checkpoint.create", () => {
  it("with the workspace ready and the runtime not yet ready: accepted, the checkpoint effect names the durable head and the held grant", () => {
    const held = run(workspaceReady(), grant(pushGrant())).state;
    expect(held.runtime.kind).toBe("starting");
    const result = run(held, frame(checkpointCreate("idle")));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_checkpoint" }, outcome: { kind: "accepted" } },
      {
        kind: "checkpoint",
        checkpointId: "id_1",
        reason: "idle",
        message: null,
        durableHeadSha: HEAD_SHA,
        parentSha: HEAD_SHA,
        sessionBranch: "oncue/readme-1a2b",
        cloneBranch: "oncue/readme-1a2b",
        pushGrantId: "grant_push",
        sessionBaseSha: null,
      },
    ]);
    expect(result.state.checkpoint).toEqual({
      kind: "running",
      commandId: "cmd_checkpoint",
      checkpointId: "id_1",
      reason: "idle",
      runId: null,
      startedAtMs: 50_000,
      publish: null,
      pushedBranch: "oncue/readme-1a2b",
    });
    expect(result.state.pushGrant).toBeNull();
  });

  it("with no push grant held: the effect names no grant", () => {
    const result = run(repositoryReady(), frame(checkpointCreate("user_requested")));
    expect(result.effects[1]).toMatchObject({ kind: "checkpoint", pushGrantId: null });
  });

  it("with a run active: the run winds down as on shutdown, with an abort and no run event", () => {
    const result = run(repositoryRunning(), frame(checkpointCreate("lifetime_ceiling")));
    expect(kinds(result.effects)).toEqual(["ack", "abort", "checkpoint"]);
    expect(result.state.run).toMatchObject({
      phase: "winding_down",
      windDown: "cancelled_by_object",
    });
    expect(result.state.checkpoint).toMatchObject({ kind: "running", runId: "run_1" });
  });

  it("with a run already winding down: no second abort", () => {
    const winding = run(repositoryRunning(), frame(cancel())).state;
    const result = run(winding, frame(checkpointCreate()));
    expect(kinds(result.effects)).toEqual(["ack", "checkpoint"]);
  });

  it("with a run a rejected key has just paused: accepted, charged to that run, with no second abort and no run event", () => {
    // The object stops the sandbox as soon as it stores this pause, so its
    // checkpoint arrives while the paused turn is still winding down.
    const paused = run(repositoryRunning(), {
      kind: "model_failure",
      failure: { category: "authentication_failed", message: "bad key" },
    }).state;
    const result = run(paused, frame(checkpointCreate("idle")));
    expect(kinds(result.effects)).toEqual(["ack", "checkpoint"]);
    expect(result.effects[0]).toEqual({
      kind: "ack",
      ref: { commandId: "cmd_checkpoint" },
      outcome: { kind: "accepted" },
    });
    expect(result.state.run).toMatchObject({
      phase: "winding_down",
      windDown: "paused_model_failure",
    });
    expect(result.state.checkpoint).toMatchObject({
      kind: "running",
      reason: "idle",
      runId: "run_1",
    });
  });

  it("before the workspace is ready, with no repository, or on a failed clone: wrong_state", () => {
    for (const state of [
      initial(),
      ready(),
      run(initial(), grant(gitGrant())).state,
      run(run(initial(), grant(gitGrant())).state, {
        kind: "clone_settled",
        grantId: "grant_git",
        result: { kind: "failed", category: "restore", detail: "apply_failed" },
      }).state,
    ]) {
      expect(run(state, frame(checkpointCreate())).effects).toEqual([
        {
          kind: "ack",
          ref: { commandId: "cmd_checkpoint" },
          outcome: { kind: "rejected", reason: "wrong_state" },
        },
      ]);
    }
  });

  it("while a checkpoint is running or uploading: wrong_state, and the first is unchanged", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate())).state;
    const second = run(running, frame(checkpointCreate("idle", "cmd_checkpoint_2")));
    expect(second.effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_checkpoint_2" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
    expect(second.state.checkpoint).toEqual(running.checkpoint);
    const uploading = run(
      running,
      settled(running, {
        kind: "bundled",
        headSha: "e".repeat(40),
        byteSize: 12,
        push: "no_grant",
      }),
    ).state;
    expect(uploading.checkpoint.kind).toBe("uploading");
    expect(run(uploading, frame(checkpointCreate("idle", "cmd_checkpoint_3"))).effects[0]).toEqual({
      kind: "ack",
      ref: { commandId: "cmd_checkpoint_3" },
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
  });

  it("is replayed on redelivery without a second checkpoint", () => {
    const running = run(repositoryReady(), frame(checkpointCreate())).state;
    expect(run(running, frame(checkpointCreate()))).toEqual({
      state: running,
      effects: [
        { kind: "ack", ref: { commandId: "cmd_checkpoint" }, outcome: { kind: "accepted" } },
      ],
    });
  });
});

describe("checkpoint_settled", () => {
  const NEW_HEAD = "e".repeat(40);

  it("pushed: the durable head moves, repository.checkpointed then sandbox.checkpointed as branch_push, idle", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    const result = run(running, settled(running, { kind: "pushed", headSha: NEW_HEAD }));
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "repository.checkpointed",
          runId: "run_1",
          payload: {
            checkpointId: "id_1",
            kind: "branch_push",
            headSha: NEW_HEAD,
            bundle: null,
            reason: "idle_shutdown",
          },
        },
      },
      {
        kind: "emit",
        draft: {
          type: "sandbox.checkpointed",
          runId: null,
          payload: {
            checkpointId: "id_1",
            kind: "branch_push",
            headSha: NEW_HEAD,
            bundle: null,
            reason: "idle",
            durationMs: 0,
          },
        },
      },
    ]);
    expect(result.state.durableHead).toBe(NEW_HEAD);
    expect(result.state.checkpoint).toEqual({ kind: "idle" });
  });

  it("the next checkpoint is parented on the pushed head", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    const idle = run(running, settled(running, { kind: "pushed", headSha: NEW_HEAD })).state;
    const next = run(idle, frame(checkpointCreate("idle", "cmd_checkpoint_2")));
    expect(next.effects[1]).toMatchObject({ kind: "checkpoint", parentSha: NEW_HEAD });
  });

  it("unchanged: branch_push naming the parent, the durable head unmoved", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("pause"))).state;
    const result = run(running, settled(running, { kind: "unchanged", headSha: HEAD_SHA }));
    expect(emitted(result.effects)).toEqual(["repository.checkpointed", "sandbox.checkpointed"]);
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { kind: "branch_push", headSha: HEAD_SHA, reason: "pause" } },
    });
    expect(result.state.durableHead).toBe(HEAD_SHA);
  });

  it("a stop's checkpoint withheld for a secret leaves a durable warning on the run, naming the file", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("cancel"))).state;
    const result = run(
      running,
      settled(running, {
        kind: "committed_only",
        headSha: NEW_HEAD,
        push: "secret_in_changes",
        secretPaths: [".env"],
      }),
    );
    expect(emitted(result.effects)).toEqual([
      "git.push.failed",
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    expect(result.effects[0]).toMatchObject({
      draft: {
        runId: "run_1",
        payload: {
          category: "secret_in_changes",
          headSha: NEW_HEAD,
          message: expect.stringContaining(".env"),
          retryable: false,
        },
      },
    });
  });

  it("committed_only: both events as local_commit with no bundle", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("cancel"))).state;
    const result = run(
      running,
      settled(running, { kind: "committed_only", headSha: NEW_HEAD, push: "no_grant" }),
    );
    expect(
      result.effects.map((effect) => (effect.kind === "emit" ? effect.draft.payload : effect)),
    ).toEqual([
      expect.objectContaining({
        kind: "local_commit",
        headSha: NEW_HEAD,
        bundle: null,
        reason: "user_requested",
      }),
      expect.objectContaining({
        kind: "local_commit",
        headSha: NEW_HEAD,
        bundle: null,
        reason: "cancel",
      }),
    ]);
    expect(result.state.durableHead).toBe(HEAD_SHA);
  });

  it("bundled with a run to charge: artifact.uploading on that run, the checkpoint uploading, the patch staged by id", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    const result = run(
      running,
      settled(running, { kind: "bundled", headSha: NEW_HEAD, byteSize: 512, push: "no_grant" }),
    );
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "artifact.uploading",
          runId: "run_1",
          payload: {
            artifactId: "id_1",
            kind: "patch",
            contentType: "text/x-diff",
            declaredBytes: 512,
            producer: "checkpoint",
          },
        },
      },
      {
        kind: "stage_upload",
        artifactId: "id_1",
        source: { kind: "checkpoint", checkpointId: "id_1" },
      },
    ]);
    expect(result.state.checkpoint).toEqual({
      kind: "uploading",
      checkpointId: "id_1",
      reason: "idle",
      runId: "run_1",
      startedAtMs: 50_000,
      headSha: NEW_HEAD,
      artifactId: "id_1",
      byteSize: 512,
    });
    expect(result.state.uploads).toEqual([{ artifactId: "id_1", purpose: "checkpoint" }]);
  });

  it("bundled after a run finished charges the last run", () => {
    let state = measured(run(repositoryRunning(), event({ kind: "session_idle" })).state).state;
    state = run(state, {
      kind: "check_settled",
      runId: "run_1",
      checkRunId: "id_2",
      outcome: { kind: "could_not_run", detail: "supervisor unreachable" },
    }).state;
    expect(state.run).toEqual({ kind: "idle" });
    state = run(state, frame(checkpointCreate("idle"))).state;
    const result = run(
      state,
      settled(state, { kind: "bundled", headSha: NEW_HEAD, byteSize: 5, push: "no_grant" }),
    );
    expect(result.effects[0]).toMatchObject({
      draft: { type: "artifact.uploading", runId: "run_1" },
    });
  });

  it("bundled with no run ever: reported as a local commit on the sandbox alone, nothing staged", () => {
    const running = run(workspaceReady(), frame(checkpointCreate("idle"))).state;
    const result = run(
      running,
      settled(running, { kind: "bundled", headSha: NEW_HEAD, byteSize: 5, push: "no_grant" }),
    );
    expect(kinds(result.effects)).toEqual(["log", "emit"]);
    expect(result.effects[1]).toMatchObject({
      draft: { type: "sandbox.checkpointed", payload: { kind: "local_commit", headSha: NEW_HEAD } },
    });
    expect(result.state.checkpoint).toEqual({ kind: "idle" });
    expect(result.state.uploads).toEqual([]);
  });

  it("pushed with no run ever: sandbox.checkpointed alone", () => {
    const running = run(workspaceReady(), frame(checkpointCreate("idle"))).state;
    const result = run(running, settled(running, { kind: "pushed", headSha: NEW_HEAD }));
    expect(emitted(result.effects)).toEqual(["sandbox.checkpointed"]);
    expect(result.state.durableHead).toBe(NEW_HEAD);
  });

  it("failed: logged, idle, and said durably so the stop need not wait out its deadline", () => {
    // A file only the agent can read makes `git add` fail; the failure must
    // be reported rather than leaving the object waiting.
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    const result = run(running, settled(running, { kind: "failed", detail: "add_failed" }));
    expect(kinds(result.effects)).toEqual(["log", "emit"]);
    expect(emitted(result.effects)).toEqual(["sandbox.checkpoint_failed"]);
    const payload = result.effects.flatMap((effect) =>
      effect.kind === "emit" ? [effect.draft.payload] : [],
    )[0];
    expect(payload).toMatchObject({ reason: "idle", failure: "add_failed" });
    expect(result.state.checkpoint).toEqual({ kind: "idle" });
  });

  it("for a checkpoint that is not running: logged", () => {
    const result = run(repositoryReady(), {
      kind: "checkpoint_settled",
      diff: null,
      commit: null,
      checkpointId: "ckpt_stale",
      result: { kind: "pushed", headSha: NEW_HEAD },
    });
    expect(kinds(result.effects)).toEqual(["log"]);
    expect(result.state).toEqual(repositoryReady());
  });

  it.each(
    Object.entries(CHECKPOINT_REASONS) as [
      CheckpointReason,
      (typeof CHECKPOINT_REASONS)[CheckpointReason],
    ][],
  )("reason %s maps to the repository and sandbox reasons %j", (reason, expected) => {
    const running = run(repositoryRunning(), frame(checkpointCreate(reason))).state;
    const result = run(running, settled(running, { kind: "pushed", headSha: NEW_HEAD }));
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { reason: expected.repository } },
    });
    expect(result.effects[1]).toMatchObject({ draft: { payload: { reason: expected.sandbox } } });
  });

  it("the reason table is exactly the spec's five rows", () => {
    expect(CHECKPOINT_REASONS).toEqual({
      idle: { repository: "idle_shutdown", sandbox: "idle" },
      lifetime_ceiling: { repository: "pre_replacement", sandbox: "lifetime_ceiling" },
      user_requested: { repository: "user_requested", sandbox: "user" },
      pause: { repository: "pause", sandbox: "pause" },
      cancel: { repository: "user_requested", sandbox: "cancel" },
    });
  });
});

describe("upload grants and upload_settled", () => {
  const NEW_HEAD = "e".repeat(40);

  function uploading(): AgentState {
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    return run(
      running,
      settled(running, { kind: "bundled", headSha: NEW_HEAD, byteSize: 512, push: "no_grant" }),
    ).state;
  }

  it("an upload grant for the declared artifact: accepted, the upload effect carries the token and nothing else does", () => {
    const result = run(uploading(), grant(uploadGrant({ artifactId: "id_1" })));
    expect(result.effects).toEqual([
      { kind: "ack", ref: { grantId: "grant_upload" }, outcome: { kind: "accepted" } },
      {
        kind: "upload",
        artifactId: "id_1",
        url: "https://oncue.example/artifacts/art_1",
        token: UPLOAD_TOKEN,
        maxBytes: 25 * 1024 * 1024,
      },
    ]);
  });

  it("an upload grant for an artifact never declared: wrong_state", () => {
    expect(run(uploading(), grant(uploadGrant({ artifactId: "art_other" }))).effects).toEqual([
      {
        kind: "ack",
        ref: { grantId: "grant_upload" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
  });

  it("settled ok: patch_bundle with the artifact ref on both events, idle, the upload forgotten", () => {
    const result = run(uploading(), { kind: "upload_settled", artifactId: "id_1", ok: true });
    const bundle = {
      artifactId: "id_1",
      kind: "patch",
      contentType: "text/x-diff",
      byteSize: 512,
      label: "Checkpoint patch bundle",
    };
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "repository.checkpointed",
          runId: "run_1",
          payload: {
            checkpointId: "id_1",
            kind: "patch_bundle",
            headSha: NEW_HEAD,
            bundle,
            reason: "idle_shutdown",
          },
        },
      },
      {
        kind: "emit",
        draft: {
          type: "sandbox.checkpointed",
          runId: null,
          payload: {
            checkpointId: "id_1",
            kind: "patch_bundle",
            headSha: NEW_HEAD,
            bundle,
            reason: "idle",
            durationMs: 0,
          },
        },
      },
    ]);
    expect(result.state.checkpoint).toEqual({ kind: "idle" });
    expect(result.state.uploads).toEqual([]);
    expect(result.state.durableHead).toBe(HEAD_SHA);
  });

  it("settled failed: local_commit with no bundle, idle, the upload forgotten", () => {
    const result = run(uploading(), { kind: "upload_settled", artifactId: "id_1", ok: false });
    expect(emitted(result.effects)).toEqual(["repository.checkpointed", "sandbox.checkpointed"]);
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { kind: "local_commit", headSha: NEW_HEAD, bundle: null } },
    });
    expect(result.state.checkpoint).toEqual({ kind: "idle" });
    expect(result.state.uploads).toEqual([]);
  });

  it("settled for an artifact never declared: logged", () => {
    const result = run(uploading(), { kind: "upload_settled", artifactId: "art_x", ok: true });
    expect(kinds(result.effects)).toEqual(["log"]);
    expect(result.state).toEqual(uploading());
  });
});

describe("large tool output", () => {
  const big = "x".repeat(64 * 1024);

  function completedTool(output: string, callId = "t1"): RuntimeEvent {
    return {
      kind: "tool_part",
      messageId: "m1",
      part: {
        callId,
        tool: "bash",
        status: "completed",
        title: "cat log",
        input: {},
        output,
        error: null,
        exitCode: 0,
        startedAtMs: 1,
        endedAtMs: 2,
      },
    };
  }

  it("a completed output the inline limit cut is declared as a tool_output artifact and staged", () => {
    const result = run(running(), event(completedTool(big)));
    expect(emitted(result.effects)).toEqual([
      "message.started",
      "tool.requested",
      "tool.started",
      "tool.completed",
      "artifact.uploading",
    ]);
    expect(result.effects.at(-2)).toEqual({
      kind: "emit",
      draft: {
        type: "artifact.uploading",
        runId: "run_1",
        payload: {
          artifactId: "id_1",
          kind: "tool_output",
          contentType: "text/plain; charset=utf-8",
          declaredBytes: big.length,
          producer: "tool",
        },
      },
    });
    expect(result.effects.at(-1)).toEqual({
      kind: "stage_upload",
      artifactId: "id_1",
      source: { kind: "text", text: big },
    });
    expect(result.state.uploads).toEqual([{ artifactId: "id_1", purpose: "tool_output" }]);
    expect(JSON.stringify(result.state)).not.toContain(big.slice(0, 1024));
    expect(activeRun(result.state).toolsRun).toBe(1);
  });

  it("declares the utf-8 byte length, not the character count", () => {
    const wide = "é".repeat(40 * 1024);
    const result = run(running(), event(completedTool(wide)));
    expect(result.effects.at(-2)).toMatchObject({
      draft: { payload: { declaredBytes: 80 * 1024 } },
    });
  });

  it("an output that fits inline declares nothing", () => {
    const result = run(running(), event(completedTool("small")));
    expect(emitted(result.effects)).toEqual([
      "message.started",
      "tool.requested",
      "tool.started",
      "tool.completed",
    ]);
    expect(result.state.uploads).toEqual([]);
  });

  it("an output over the artifact ceiling keeps only its inline cut, with a log line", () => {
    const result = run(running(), event(completedTool("y".repeat(MAX_ARTIFACT_BYTES + 1))));
    expect(emitted(result.effects)).toEqual([
      "message.started",
      "tool.requested",
      "tool.started",
      "tool.completed",
    ]);
    expect(kinds(result.effects).at(-1)).toBe("log");
    expect(result.state.uploads).toEqual([]);
  });

  it("past the pending-upload bound, an output is not offered", () => {
    let state = running();
    for (let index = 0; index < UPLOADS_LIMIT; index += 1) {
      state = run(state, event(completedTool(big, `t${index}`))).state;
    }
    expect(state.uploads).toHaveLength(UPLOADS_LIMIT);
    const result = run(state, event(completedTool(big, "t_last")));
    expect(emitted(result.effects)).not.toContain("artifact.uploading");
    expect(result.state.uploads).toHaveLength(UPLOADS_LIMIT);
  });

  it("an upload grant for the staged tool output is accepted and its settle forgets it without a checkpoint event", () => {
    const staged = run(running(), event(completedTool(big))).state;
    const granted = run(staged, grant(uploadGrant({ artifactId: "id_1" })));
    expect(kinds(granted.effects)).toEqual(["ack", "upload"]);
    const done = run(granted.state, { kind: "upload_settled", artifactId: "id_1", ok: true });
    expect(done.effects).toEqual([]);
    expect(done.state.uploads).toEqual([]);
  });
});

describe("resume context on run.start", () => {
  it("is prepended to the prompt and kept out of the instruction text", () => {
    const result = run(ready(), frame(runStart({ context: "Earlier: the README was drafted." })));
    expect(result.effects[1]).toMatchObject({
      kind: "prompt",
      text: "Earlier: the README was drafted.\n\nAdd a README section.",
    });
    expect(activeRun(result.state).instructionText).toBe("Add a README section.");
  });

  it("null leaves the prompt as the instruction alone", () => {
    const result = run(ready(), frame(runStart()));
    expect(result.effects[1]).toMatchObject({ kind: "prompt", text: "Add a README section." });
  });

  it("on a checks-only start is kept for the next prompted run, and only that one", () => {
    const checks = run(
      ready(),
      frame(
        runStart({
          checksOnly: true,
          text: "Run the repository's checks.",
          context: "Earlier: the README was drafted.",
        }),
      ),
    );
    expect(kinds(checks.effects)).not.toContain("prompt");
    expect(checks.state.resumeContext).toBe("Earlier: the README was drafted.");

    const next = run(
      checks.state,
      frame(
        runStart({
          text: "Now fix the typo.",
          runId: "run_2",
          commandId: "cmd_run_2",
          messageId: "msg_run_2",
          continuesRunId: "run_1",
        }),
      ),
    );
    expect(next.effects).toContainEqual(
      expect.objectContaining({
        kind: "prompt",
        conversation: null,
        text: "Earlier: the README was drafted.\n\nNow fix the typo.",
      }),
    );
    expect(next.state.resumeContext).toBeNull();
    expect(activeRun(next.state).instructionText).toBe("Now fix the typo.");
  });

  it("a later resume's own context replaces one a checks-only start left", () => {
    const checks = run(
      ready(),
      frame(runStart({ checksOnly: true, text: "Run the repository's checks.", context: "Old." })),
    ).state;
    const next = run(
      checks,
      frame(
        runStart({
          runId: "run_2",
          commandId: "cmd_run_2",
          messageId: "msg_run_2",
          context: "New.",
        }),
      ),
    );
    expect(next.effects).toContainEqual(
      expect.objectContaining({ kind: "prompt", text: "New.\n\nAdd a README section." }),
    );
  });
});

describe("restore failures and the durable head", () => {
  it("a clone that failed at restore is a boot failure naming the category", () => {
    const cloning = run(initial(), grant(gitGrant())).state;
    const result = run(cloning, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "failed", category: "restore", detail: "apply_failed" },
    });
    expect(result.state.workspace).toEqual({ kind: "failed", detail: "apply_failed" });
    expect(result.state.durableHead).toBeNull();
    expect(result.effects[0]).toMatchObject({
      draft: {
        type: "runtime.disconnected",
        payload: { detail: "boot failed: clone (restore): apply_failed" },
      },
    });
  });

  it("a git grant carrying a restore bundle goes to the clone effect whole, and the token stays out of state", () => {
    const restore = { artifactId: "art_r", url: "https://oncue.example/r", token: RESTORE_TOKEN };
    const result = run(initial(), grant(gitGrant({ restore })));
    expect(result.effects[1]).toMatchObject({ kind: "clone", grant: { restore } });
  });
});

describe("runtime.shutdown while a checkpoint settles", () => {
  it("with no runtime: the link stays open until the checkpoint settles, then closes", () => {
    const running = run(workspaceReady(), frame(checkpointCreate("idle"))).state;
    const stopping = run({ ...running, runtime: { kind: "exited", code: 0 } }, frame(shutdown()));
    expect(stopping.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_shutdown" }, outcome: { kind: "accepted" } },
    ]);
    expect(stopping.state.stopping).toBe(true);
    const done = run(
      stopping.state,
      settled(stopping.state, { kind: "pushed", headSha: "e".repeat(40) }),
    );
    expect(kinds(done.effects)).toEqual(["emit", "close_link"]);
  });

  it("with the runtime up: the exit waits for the checkpoint, and the checkpoint waits for the exit", () => {
    const running = run(repositoryRunning(), frame(checkpointCreate("idle"))).state;
    const stopping = run(running, frame(shutdown()));
    expect(kinds(stopping.effects)).toEqual(["ack", "signal_runtime"]);
    const exited = run(stopping.state, { kind: "runtime_exited", code: 0, signal: null });
    expect(kinds(exited.effects)).toEqual(["emit"]);
    const done = run(exited.state, settled(exited.state, { kind: "unchanged", headSha: HEAD_SHA }));
    expect(kinds(done.effects)).toEqual(["emit", "emit", "close_link"]);

    const uploadingFirst = run(
      stopping.state,
      settled(stopping.state, {
        kind: "bundled",
        headSha: "e".repeat(40),
        byteSize: 3,
        push: "no_grant",
      }),
    ).state;
    const exitedWhileUploading = run(uploadingFirst, {
      kind: "runtime_exited",
      code: 0,
      signal: null,
    });
    expect(kinds(exitedWhileUploading.effects)).toEqual(["emit"]);
    const artifactId =
      uploadingFirst.checkpoint.kind === "uploading" ? uploadingFirst.checkpoint.artifactId : "";
    const uploaded = run(exitedWhileUploading.state, {
      kind: "upload_settled",
      artifactId,
      ok: false,
    });
    expect(kinds(uploaded.effects)).toEqual(["emit", "emit", "close_link"]);
  });

  it("a checkpoint failing while stopping still closes the link", () => {
    const running = run(workspaceReady(), frame(checkpointCreate("idle"))).state;
    const stopping = run(
      { ...running, runtime: { kind: "exited", code: 0 } },
      frame(shutdown()),
    ).state;
    const done = run(stopping, settled(stopping, { kind: "failed", detail: "add_failed" }));
    expect(kinds(done.effects)).toEqual(["log", "emit", "close_link"]);
    expect(emitted(done.effects)).toEqual(["sandbox.checkpoint_failed"]);
  });
});

describe("OpenCode events during a run", () => {
  it("with no active run: logged", () => {
    expect(kinds(run(ready(), event({ kind: "session_idle" })).effects)).toEqual(["log"]);
  });

  it("drafts are emitted in order with the run id, and the normalizer state advances", () => {
    const result = run(
      running(),
      event({ kind: "text_delta", messageId: "m1", partId: "p1", text: "Hi" }),
    );
    expect(emitted(result.effects)).toEqual(["message.started", "message.delta"]);
    expect(result.effects[0]).toMatchObject({ draft: { runId: "run_1" } });
    expect(activeRun(result.state).normalizer.messages.has("m1")).toBe(true);
  });

  it("assistant text is remembered for the completion summary", () => {
    const withText = run(
      running(),
      event({ kind: "text_delta", messageId: "m1", partId: "p1", text: "Added the section." }),
    ).state;
    const done = run(
      withText,
      event({
        kind: "message_completed",
        messageId: "m1",
        finish: "stop",
        usage: null,
        error: null,
      }),
    );
    expect(activeRun(done.state).lastAssistantText).toBe("Added the section.");
  });

  it("idle while running with no repository: run.completed (Done), no checks, then idle (record 14)", () => {
    const withText = run(
      running(),
      event({ kind: "text_delta", messageId: "m1", partId: "p1", text: "Added the section." }),
    ).state;
    const done = run(
      withText,
      event({
        kind: "message_completed",
        messageId: "m1",
        finish: "stop",
        usage: null,
        error: null,
      }),
    ).state;
    const result = run(done, event({ kind: "session_idle" }), ctx({ nowMs: 62_500 }));
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.completed",
          runId: "run_1",
          payload: {
            summary: {
              whatChanged: "Added the section.",
              why: "Requested: Add a README section.",
              verificationPerformed: DONE_VERIFICATION_TEXT,
              limitations: [],
              nextStep: null,
            },
            evidence: [],
            branch: null,
            pullRequestNumber: null,
            usage: null,
            durationMs: 12_500,
          },
        },
      },
    ]);
    expect(result.state.run).toEqual({ kind: "idle" });
    expect(result.state.lastRun).toEqual({
      runId: "run_1",
      conversation: "ses_1",
      promptedMessageIds: ["msg_1"],
      commitSubject: "Add a README section.",
      verification: "none",
    });
  });

  it("idle while prompting is ignored with a log line", () => {
    const prompting = run(ready(), frame(runStart())).state;
    const result = run(prompting, event({ kind: "session_idle" }));
    expect(kinds(result.effects)).toEqual(["log"]);
    expect(result.state.run).toEqual(prompting.run);
  });

  it("error while running: run.failed at stage execution with the error's name", () => {
    const result = run(
      running(),
      event({
        kind: "session_error",
        name: "ContextOverflowError",
        message: "too long",
        status: null,
      }),
    );
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.failed",
          runId: "run_1",
          payload: {
            stage: "execution",
            error: { category: "ContextOverflowError", message: "too long" },
            summary: null,
            evidence: [],
            branch: null,
            pullRequestNumber: null,
            usage: null,
            durationMs: 0,
          },
        },
      },
    ]);
    expect(result.state.run).toEqual({ kind: "idle" });
  });

  it("a ProviderAuthError from OpenCode pauses the run for a model failure and aborts", () => {
    const result = run(
      running(),
      event({ kind: "session_error", name: "ProviderAuthError", message: "bad key", status: null }),
    );
    expect(result.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "run.paused",
          runId: "run_1",
          payload: {
            reason: "model_failure",
            detail: "Model request failed: authentication_failed",
            modelFailure: { category: "authentication_failed", message: "bad key", retries: 0 },
            checkpointId: null,
          },
        },
      },
      { kind: "abort", runId: "run_1", conversation: "ses_1" },
    ]);
    expect(result.state.run).toMatchObject({
      phase: "winding_down",
      windDown: "paused_model_failure",
    });
    const idle = run(result.state, event({ kind: "session_idle" }));
    expect(idle.effects).toEqual([]);
    expect(idle.state.run).toEqual({ kind: "idle" });
  });

  it("a model failure signal while already winding down emits nothing more", () => {
    const winding = run(running(), frame(cancel())).state;
    expect(
      run(
        winding,
        event({ kind: "session_error", name: "ProviderAuthError", message: "x", status: null }),
      ).effects,
    ).toEqual([]);
  });
});

describe("model_failure from the relay", () => {
  it.each(["authentication_failed", "usage_limit_reached", "model_unavailable"] as const)(
    "%s while running pauses the run",
    (category) => {
      const result = run(running(), {
        kind: "model_failure",
        failure: { category, message: "refused" },
      });
      expect(emitted(result.effects)).toEqual(["run.paused"]);
      expect(result.effects[0]).toMatchObject({
        draft: { payload: { modelFailure: { category } } },
      });
      expect(result.effects[1]).toEqual({
        kind: "abort",
        runId: "run_1",
        conversation: "ses_1",
      });
    },
  );

  it.each([
    "temporary_service_failure",
    "rate_limited",
    "request_rejected",
    "broker_failure",
  ] as const)("%s is logged: OpenCode retries it", (category) => {
    const state = running();
    const result = run(state, { kind: "model_failure", failure: { category, message: "later" } });
    expect(kinds(result.effects)).toEqual(["log"]);
    expect(result.state).toEqual(state);
  });

  it("with no running run: logged", () => {
    expect(
      kinds(
        run(ready(), {
          kind: "model_failure",
          failure: { category: "authentication_failed", message: "x" },
        }).effects,
      ),
    ).toEqual(["log"]);
  });
});

describe("prompt_counts from the relay", () => {
  const counts = { systemTokens: 9_000, toolsTokens: 14_000, oncueToolsTokens: 1_900 };
  const reading = { kind: "counts", key: "0123456789abcdef", counts } as const;
  it("while running: held for the next answer, with nothing emitted", () => {
    const result = run(running(), { kind: "prompt_counts", reading });
    expect(result.effects).toEqual([]);
    expect(result.state.run.kind === "active" && result.state.run.normalizer.promptCounts).toEqual({
      kind: "counts",
      counts,
    });
  });

  it("with no running run: dropped quietly", () => {
    const state = ready();
    const result = run(state, { kind: "prompt_counts", reading });
    expect(result.effects).toEqual([]);
    expect(result.state).toEqual(state);
  });
});

describe("runtime_exited", () => {
  it("with a run running: runtime.disconnected (crashed) and run.failed; the run is idle", () => {
    const result = run(running(), { kind: "runtime_exited", code: 137, signal: "SIGKILL" });
    expect(emitted(result.effects)).toEqual(["runtime.disconnected", "run.failed"]);
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { reason: "runtime_crashed", exitCode: 137, expectReconnect: false } },
    });
    expect(result.effects[1]).toMatchObject({
      draft: { payload: { error: { category: "runtime_exited" } } },
    });
    expect(result.state.runtime).toEqual({ kind: "exited", code: 137 });
    expect(result.state.run).toEqual({ kind: "idle" });
  });

  it("with a clean exit and no run: runtime_exited and nothing else", () => {
    const result = run(ready(), { kind: "runtime_exited", code: 0, signal: null });
    expect(emitted(result.effects)).toEqual(["runtime.disconnected"]);
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { reason: "runtime_exited", exitCode: 0 } },
    });
  });

  it("while winding down: no run.failed, since the object already has the cancel", () => {
    const winding = run(running(), frame(cancel())).state;
    const result = run(winding, { kind: "runtime_exited", code: 1, signal: null });
    expect(emitted(result.effects)).toEqual(["runtime.disconnected"]);
    expect(result.state.run).toEqual({ kind: "idle" });
  });

  it("afterwards every run command is no_runtime", () => {
    const exited = run(ready(), { kind: "runtime_exited", code: 0, signal: null }).state;
    expect(run(exited, frame(runStart())).effects[0]).toMatchObject({
      outcome: { kind: "rejected", reason: "no_runtime" },
    });
  });

  it("drops a pending start: there is nothing left to prompt it into", () => {
    const winding = run(running(), frame(cancel())).state;
    const held = run(
      winding,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_9" })),
    ).state;
    expect(
      run(held, { kind: "runtime_exited", code: 1, signal: null }).state.pendingStart,
    ).toBeNull();
  });
});

describe("the decided ring", () => {
  it("replays the outcome an id received and forgets the oldest past its limit", () => {
    let ring: DecidedRing = { entries: [], limit: 2 };
    ring = decide(ring, "a", { kind: "accepted" });
    ring = decide(ring, "b", { kind: "rejected", reason: "wrong_state" });
    expect(replayedAck(ring, "a")).toEqual({ kind: "accepted" });
    ring = decide(ring, "c", { kind: "accepted" });
    expect(replayedAck(ring, "a")).toBeNull();
    expect(replayedAck(ring, "b")).toEqual({ kind: "rejected", reason: "wrong_state" });
    expect(replayedAck(ring, "c")).toEqual({ kind: "accepted" });
  });

  it("replays a rejection too: the same command gets the same answer", () => {
    const rejected = run(ready(), frame(cancel())).state;
    expect(run(rejected, frame(cancel())).effects).toEqual([
      {
        kind: "ack",
        ref: { commandId: "cmd_cancel" },
        outcome: { kind: "rejected", reason: "wrong_state" },
      },
    ]);
  });
});

describe("drafts", () => {
  it("runStartedDraft uses the empty tree and the placeholder branch for a repo-less session", () => {
    expect(runStartedDraft("run_1", { kind: "none" })).toEqual({
      type: "run.started",
      runId: "run_1",
      payload: { baseSha: EMPTY_TREE_SHA, branch: NO_REPOSITORY_BRANCH, resumedFrom: null },
    });
  });

  it("a repository that resolves no checks ends the same way, naming its branch, and says there was no final message", () => {
    let state = run(initial(), grant(gitGrant())).state;
    state = run(state, {
      kind: "clone_settled",
      grantId: "grant_git",
      result: { kind: "cloned", headSha: HEAD_SHA, project: NO_CHECKS_PROJECT, install: null },
    }).state;
    state = run(state, { kind: "chown_settled", ok: true, detail: "ok" }).state;
    state = run(state, grant(modelGrant({ workspace: "repository" }))).state;
    state = run(state, {
      kind: "runtime_started",
      result: { kind: "started", pid: 42, port: OPENCODE_PORT },
    }).state;
    state = run(state, { kind: "health", result: { kind: "healthy", version: "1.18.30" } }).state;
    state = run(state, event({ kind: "server_connected" })).state;
    state = run(state, frame(runStart())).state;
    state = run(state, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    }).state;

    const idle = run(state, event({ kind: "session_idle" }), ctx({ nowMs: 51_000 }));
    expect(kinds(idle.effects)).toEqual(["build_diffs"]);
    const result = measured(idle.state, ctx({ nowMs: 51_000 }));
    expect(emitted(result.effects)).toEqual(["run.completed_with_warnings"]);
    const draft = result.effects[0];
    expect(draft?.kind === "emit" && draft.draft.payload).toMatchObject({
      summary: { whatChanged: "The agent finished without a final message." },
      warnings: [NO_CHECKS_WARNING],
      branch: "oncue/readme-1a2b",
      durationMs: 1_000,
    });
    expect(result.state.run).toEqual({ kind: "idle" });
  });
});

describe("verification", () => {
  /** `repositoryRunning` has `pnpm test` resolved; idle enters verification with check id id_1 and run id id_2. */
  function verifying(context = ctx()): StepOutcome {
    return measured(
      run(repositoryRunning(), event({ kind: "session_idle" }), context).state,
      context,
    );
  }

  function runCheckOf(outcome: StepOutcome): Extract<AgentEffect, { kind: "run_check" }> {
    const effect = outcome.effects.find((entry) => entry.kind === "run_check");
    if (effect?.kind !== "run_check") {
      throw new Error(`no run_check among ${kinds(outcome.effects).join(", ")}`);
    }
    return effect;
  }

  const passed = {
    kind: "exited" as const,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 900,
    logBytes: 64,
    tail: "1 passing\n",
  };

  it("an idle signal while running enters verification instead of ending the run", () => {
    const result = verifying();

    expect(emitted(result.effects)).toEqual(["verification.started"]);
    expect(runCheckOf(result)).toEqual({
      kind: "run_check",
      runId: "run_1",
      checkRunId: "id_2",
      command: "pnpm test",
      where: { kind: "workspace" },
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const active = activeRun(result.state);
    expect(active.phase).toBe("verifying");
    expect(active.verification?.revision).toBe(END_SHA);
    expect(active.verification?.baseRevision).toBe(BASE_SHA);
    expect(result.state.lastRun).toBeNull();
    expect(emitted(result.effects)).not.toContain("run.completed_with_warnings");
  });

  it("a passing check's log is declared, uploaded under a grant, and the run ends verified", () => {
    const context = ctx();
    const started = verifying(context).state;
    const settled = run(
      started,
      { kind: "check_settled", runId: "run_1", checkRunId: "id_2", outcome: passed },
      context,
    );
    expect(emitted(settled.effects)).toEqual(["artifact.uploading"]);
    expect(settled.effects.slice(1)).toEqual([
      {
        kind: "stage_upload",
        artifactId: "id_3",
        source: { kind: "check_log", checkRunId: "id_2" },
      },
      { kind: "upload_deadline", artifactId: "id_3", afterMs: LOG_GRANT_WAIT_MS },
    ]);
    expect(settled.state.uploads).toEqual([{ artifactId: "id_3", purpose: "verification_log" }]);

    const granted = run(settled.state, grant(uploadGrant({ artifactId: "id_3" })), context);
    expect(kinds(granted.effects)).toEqual(["ack", "upload"]);

    const uploaded = run(
      granted.state,
      { kind: "upload_settled", artifactId: "id_3", ok: true },
      context,
    );
    expect(emitted(uploaded.effects)).toEqual([
      "verification.result",
      "verification.completed",
      "run.verified",
    ]);
    expect(uploaded.state.run).toEqual({ kind: "idle" });
    expect(uploaded.state.uploads).toEqual([]);
    expect(uploaded.state.lastRun).toEqual({
      runId: "run_1",
      conversation: "ses_1",
      promptedMessageIds: ["msg_1"],
      commitSubject: "Add a README section.",
      verification: "passing",
    });
  });

  it("OpenCode's own idle, error, or model failure while verifying changes nothing", () => {
    const started = verifying().state;
    expect(run(started, event({ kind: "session_idle" })).state).toEqual(started);
    expect(
      run(
        started,
        event({ kind: "session_error", name: "UnknownError", message: "late", status: null }),
      ).state.run,
    ).toEqual(started.run);
  });

  it("a steer is refused while verifying, and a late prompt answer changes nothing", () => {
    const started = verifying().state;
    expect(run(started, frame(followUp("steer_current_run"))).effects[0]).toMatchObject({
      outcome: { kind: "rejected", reason: "wrong_state" },
    });
    const late = run(started, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    });
    expect(late).toEqual({ state: started, effects: [] });
  });

  it("a cancel mid-check signals the check, keeps the records already sent, and ends the run with no event of its own", () => {
    const started = verifying().state;
    const cancelled = run(started, frame(cancel()));
    expect(cancelled.effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_cancel" }, outcome: { kind: "accepted" } },
      { kind: "signal_check", checkRunId: "id_2", escalateAfterMs: CANCEL_GRACE_MS },
    ]);
    expect(activeRun(cancelled.state).phase).toBe("winding_down");

    expect(run(cancelled.state, frame(cancel("cmd_cancel_2"))).effects).toEqual([
      { kind: "ack", ref: { commandId: "cmd_cancel_2" }, outcome: { kind: "accepted" } },
    ]);
    expect(run(cancelled.state, event({ kind: "session_idle" })).state.run).toEqual(
      cancelled.state.run,
    );

    const ended = run(cancelled.state, {
      kind: "check_settled",
      runId: "run_1",
      checkRunId: "id_2",
      outcome: { ...passed, exitCode: null, signal: "SIGTERM" },
    });
    expect(ended.effects).toEqual([]);
    expect(ended.state.run).toEqual({ kind: "idle" });
  });

  it("a run.start held while a cancelled verification settles is prompted once it has", () => {
    const cancelled = run(verifying().state, frame(cancel())).state;
    const held = run(
      cancelled,
      frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_2" })),
    ).state;
    expect(held.pendingStart?.runId).toBe("run_2");
    const released = run(held, {
      kind: "check_settled",
      runId: "run_1",
      checkRunId: "id_2",
      outcome: passed,
    });
    expect(kinds(released.effects)).toEqual(["prompt"]);
    expect(activeRun(released.state).runId).toBe("run_2");
  });

  it("a checkpoint or a shutdown while verifying winds the run down the same way", () => {
    const started = verifying().state;
    const checkpointed = run(started, frame(checkpointCreate("idle")));
    expect(kinds(checkpointed.effects)).toEqual(["ack", "signal_check", "checkpoint"]);

    const stopping = run(started, frame(shutdown()));
    expect(kinds(stopping.effects)).toEqual(["ack", "signal_check", "signal_runtime"]);
    expect(activeRun(stopping.state).phase).toBe("winding_down");
  });

  it("the runtime exiting mid-verification does not fail the run: the checks do not need it", () => {
    const started = verifying().state;
    const exited = run(started, { kind: "runtime_exited", code: 1, signal: null });
    expect(emitted(exited.effects)).toEqual(["runtime.disconnected"]);
    expect(activeRun(exited.state).phase).toBe("verifying");
  });

  it("the user's structured skip, on the start or a steer, skips required checks", () => {
    const skipping = run(
      repositoryReady(),
      frame(
        command(
          "run.start",
          {
            instruction: { messageId: "msg_1", text: "Skip tests.", attachments: [] },
            model: {
              provider: "anthropic",
              modelId: "claude-sonnet-5",
              modelConnectionId: "conn_1",
              authenticationType: "api_key",
              contextWindow: 200_000,
              effort: null,
            },
            continuesRunId: null,
            skipRequiredChecks: true,
          },
          { commandId: "cmd_start" },
        ),
      ),
    ).state;
    expect(activeRun(skipping).skipRequiredChecks).toBe(true);

    const steered = run(
      repositoryRunning(),
      frame(
        command(
          "run.follow_up",
          {
            messageId: "msg_2",
            text: "Skip the tests.",
            attachments: [],
            delivery: "steer_current_run",
            skipRequiredChecks: true,
          },
          { commandId: "cmd_follow" },
        ),
      ),
    ).state;
    expect(activeRun(steered).skipRequiredChecks).toBe(true);
    const idle = measured(run(steered, event({ kind: "session_idle" })).state);
    expect(emitted(idle.effects)).toEqual([
      "verification.started",
      "verification.result",
      "verification.completed",
      "run.completed_with_warnings",
    ]);
    expect(idle.state.run).toEqual({ kind: "idle" });
  });

  it("a base comparison's preparation and a settle for another run are routed or logged", () => {
    const context = ctx();
    const started = verifying(context).state;
    const failed = run(
      started,
      {
        kind: "check_settled",
        runId: "run_1",
        checkRunId: "id_2",
        outcome: { ...passed, exitCode: 1 },
      },
      context,
    ).state;
    // A test failure retries first.
    const second = run(failed, { kind: "upload_settled", artifactId: "id_3", ok: true }, context);
    const retry = runCheckOf(second);
    expect(retry.checkRunId).toBe("id_4");
    const failedAgain = run(
      second.state,
      {
        kind: "check_settled",
        runId: "run_1",
        checkRunId: retry.checkRunId,
        outcome: { ...passed, exitCode: 1 },
      },
      context,
    );
    expect(failedAgain.effects).toEqual([
      { kind: "prepare_base", runId: "run_1", dir: "id_5", baseSha: BASE_SHA },
    ]);
    const prepared = run(
      failedAgain.state,
      { kind: "base_prepared", runId: "run_1", dir: "id_5", ok: true },
      context,
    );
    expect(runCheckOf(prepared).where).toEqual({ kind: "base", dir: "id_5" });

    expect(
      run(prepared.state, { kind: "base_prepared", runId: "run_9", dir: "id_5", ok: true }).effects,
    ).toEqual([
      { kind: "log", line: "verification base_prepared for a run that is not verifying" },
    ]);
    expect(
      run(ready(), {
        kind: "check_settled",
        runId: "run_1",
        checkRunId: "x",
        outcome: passed,
      }).effects,
    ).toEqual([
      { kind: "log", line: "verification check_settled for a run that is not verifying" },
    ]);
  });

  it("an upload that settles for a log verification is not waiting on is only forgotten", () => {
    const started = verifying().state;
    const settled = run(started, {
      kind: "check_settled",
      runId: "run_1",
      checkRunId: "id_2",
      outcome: passed,
    }).state;
    const withTool: AgentState = {
      ...settled,
      uploads: [...settled.uploads, { artifactId: "art_tool", purpose: "tool_output" }],
    };
    const forgotten = run(withTool, { kind: "upload_settled", artifactId: "art_tool", ok: true });
    expect(forgotten.effects).toEqual([]);
    expect(forgotten.state.uploads).toEqual(settled.uploads);
  });
});

describe("run diffs", () => {
  const TURN_SHA = "1111111111111111111111111111111111111111";
  const NEW_HEAD = "e".repeat(40);
  const BRANCH = "oncue/readme-1a2b";
  const REFS = { branch: BRANCH, baseSha: BASE_SHA, parentSha: HEAD_SHA };

  function report(overrides: Partial<DiffReport> = {}): DiffReport {
    return {
      baseSha: BASE_SHA,
      headSha: END_SHA,
      files: [{ path: "README.md", status: "modified", additions: 2, deletions: 0 }],
      additions: 2,
      deletions: 0,
      patch: { kind: "inline", text: "diff --git a/README.md b/README.md\n+testing\n" },
      digest: "aa".repeat(32),
      truncated: false,
      // No listing in the fixture: the diff goes without a tree.
      paths: [],
      treeDigest: "",
      ...overrides,
    };
  }

  const held = (digest: string, cut = "diff --git a/big b/big\n+cut"): Partial<DiffReport> => ({
    patch: { kind: "held", byteSize: 900_000, cut },
    digest,
    truncated: true,
  });

  const STATUS = {
    branch: BRANCH,
    headSha: END_SHA,
    baseSha: BASE_SHA,
    ahead: 1,
    behind: 0,
    dirty: true,
    changedFileCount: 1,
    untrackedFileCount: 0,
    additions: 2,
    deletions: 0,
  };

  function built(
    overrides: Partial<Extract<DiffBuild, { kind: "built" }>> = {},
  ): Extract<DiffBuild, { kind: "built" }> {
    return {
      kind: "built",
      headSha: END_SHA,
      status: STATUS,
      turn: report({ baseSha: TURN_SHA }),
      session: report(),
      ...overrides,
    };
  }

  function runEnd(result: DiffBuild, runId = "run_1"): AgentInput {
    return { kind: "diffs_built", runId, purpose: "run_end", result };
  }

  function midRun(result: DiffBuild, runId = "run_1"): AgentInput {
    return { kind: "diffs_built", runId, purpose: "mid_run", result };
  }

  function drafted(outcome: StepOutcome, type: string): Record<string, unknown>[] {
    return outcome.effects.flatMap((effect) =>
      effect.kind === "emit" && effect.draft.type === type
        ? [effect.draft.payload as unknown as Record<string, unknown>]
        : [],
    );
  }

  function diffing(): AgentState {
    return run(repositoryRunning(), event({ kind: "session_idle" })).state;
  }

  describe("at run start", () => {
    it("the first prompt in a repository asks for the turn's snapshot against the durable head", () => {
      const result = run(repositoryReady(), frame(runStart()));
      expect(result.effects[1]).toMatchObject({ kind: "prompt", turnBase: REFS });
    });

    it("run.started is followed by repository.status with the snapshot's counts, and the snapshot is the turn's base", () => {
      const started = run(repositoryReady(), frame(runStart())).state;
      const measuredStatus = { ...STATUS, headSha: TURN_SHA, ahead: 0 };
      const result = run(started, {
        kind: "prompt_settled",
        runId: "run_1",
        result: { kind: "held", conversation: "ses_1" },
        turnBase: { sha: TURN_SHA, status: measuredStatus },
      });
      expect(emitted(result.effects)).toEqual(["run.started", "repository.status"]);
      expect(drafted(result, "repository.status")).toEqual([measuredStatus]);
      expect(activeRun(result.state).turnBaseSha).toBe(TURN_SHA);
    });

    it("a snapshot without a status still sends the clone's head with zero counts, which ends the object's Git grant", () => {
      const started = run(repositoryReady(), frame(runStart())).state;
      const result = run(started, {
        kind: "prompt_settled",
        runId: "run_1",
        result: { kind: "held", conversation: "ses_1" },
        turnBase: { sha: TURN_SHA, status: null },
      });
      expect(drafted(result, "repository.status")).toEqual([
        expect.objectContaining({ headSha: HEAD_SHA, changedFileCount: 0 }),
      ]);
      expect(activeRun(result.state).turnBaseSha).toBe(TURN_SHA);
    });
  });

  describe("at run end", () => {
    it("idle measures the tree before verifying: phase diffing, one build, nothing emitted", () => {
      const started = run(repositoryReady(), frame(runStart())).state;
      const holding = run(started, {
        kind: "prompt_settled",
        runId: "run_1",
        result: { kind: "held", conversation: "ses_1" },
        turnBase: { sha: TURN_SHA, status: null },
      }).state;
      const result = run(holding, event({ kind: "session_idle" }));
      expect(result.effects).toEqual([
        {
          kind: "build_diffs",
          runId: "run_1",
          purpose: "run_end",
          refs: REFS,
          turnBaseSha: TURN_SHA,
        },
      ]);
      expect(activeRun(result.state).phase).toBe("diffing");
    });

    it("emits repository.status, the turn's diff, then the session's, and verifies the snapshot they measured", () => {
      const result = run(diffing(), runEnd(built()));
      expect(emitted(result.effects)).toEqual([
        "repository.status",
        "diff.updated",
        "diff.updated",
        "verification.started",
      ]);
      expect(drafted(result, "repository.status")).toEqual([STATUS]);
      expect(drafted(result, "diff.updated")).toEqual([
        expect.objectContaining({ scope: "turn", baseSha: TURN_SHA, headSha: END_SHA }),
        expect.objectContaining({
          scope: "session",
          baseSha: BASE_SHA,
          headSha: END_SHA,
          body: { kind: "inline", patch: "diff --git a/README.md b/README.md\n+testing\n" },
          truncated: false,
        }),
      ]);
      expect(drafted(result, "verification.started")[0]).toMatchObject({ revision: END_SHA });
      expect(activeRun(result.state).verification?.revision).toBe(END_SHA);
      expect(result.state.lastSessionDiff).toBe(diffKey(report()));
    });

    it("a turn that changed no files ends Done with no checks; its status and the session's diff still go (record 14)", () => {
      const result = run(
        diffing(),
        runEnd(built({ turn: report({ files: [], additions: 0, deletions: 0 }) })),
      );
      expect(emitted(result.effects)).toEqual([
        "repository.status",
        "diff.updated",
        "run.completed",
      ]);
      expect(drafted(result, "diff.updated")[0]).toMatchObject({ scope: "session" });
      expect(drafted(result, "run.completed")[0]).toMatchObject({
        summary: { verificationPerformed: DONE_VERIFICATION_TEXT, limitations: [] },
      });
      expect(result.state.run).toEqual({ kind: "idle" });
    });

    it("a turn with changed files verifies, as every change does", () => {
      const result = run(diffing(), runEnd(built()));
      expect(emitted(result.effects)).toContain("verification.started");
      expect(emitted(result.effects)).not.toContain("run.completed");
    });

    it("what Git could not measure is left out, and a failed snapshot verifies the clone's head", () => {
      const partial = run(diffing(), runEnd(built({ status: null, turn: null, session: null })));
      expect(emitted(partial.effects)).toEqual(["verification.started"]);

      const failed = run(diffing(), runEnd({ kind: "failed", detail: "timed_out" }));
      expect(failed.effects[0]).toEqual({
        kind: "log",
        line: "run-end snapshot failed: timed_out",
      });
      expect(activeRun(failed.state).verification?.revision).toBe(HEAD_SHA);
    });

    it("a patch too large to travel inline is declared as a diff artifact the event names, and staged by its digest", () => {
      const context = ctx();
      const result = run(
        diffing(),
        runEnd(
          built({
            turn: report({ baseSha: TURN_SHA, ...held("11".repeat(32)) }),
            session: report(held("22".repeat(32))),
          }),
        ),
        context,
      );
      expect(emitted(result.effects)).toEqual([
        "repository.status",
        "artifact.uploading",
        "diff.updated",
        "artifact.uploading",
        "diff.updated",
        "verification.started",
      ]);
      expect(drafted(result, "artifact.uploading")).toEqual([
        {
          artifactId: "id_1",
          kind: "diff",
          contentType: "text/x-diff",
          declaredBytes: 900_000,
          producer: "agent",
        },
        expect.objectContaining({ artifactId: "id_2" }),
      ]);
      expect(drafted(result, "diff.updated")).toEqual([
        expect.objectContaining({
          scope: "turn",
          body: {
            kind: "artifact",
            artifact: {
              artifactId: "id_1",
              kind: "diff",
              contentType: "text/x-diff",
              byteSize: 900_000,
              label: "Changes in this turn",
            },
          },
          truncated: true,
        }),
        expect.objectContaining({
          scope: "session",
          body: expect.objectContaining({
            artifact: expect.objectContaining({
              artifactId: "id_2",
              label: "All changes in this session",
            }),
          }),
          truncated: true,
        }),
      ]);
      expect(result.effects.filter((effect) => effect.kind !== "emit").slice(0, 4)).toEqual([
        {
          kind: "stage_upload",
          artifactId: "id_1",
          source: { kind: "diff", digest: "11".repeat(32) },
        },
        { kind: "upload_deadline", artifactId: "id_1", afterMs: LOG_GRANT_WAIT_MS },
        {
          kind: "stage_upload",
          artifactId: "id_2",
          source: { kind: "diff", digest: "22".repeat(32) },
        },
        { kind: "upload_deadline", artifactId: "id_2", afterMs: LOG_GRANT_WAIT_MS },
      ]);
      expect(result.state.uploads).toEqual([
        { artifactId: "id_1", purpose: "diff" },
        { artifactId: "id_2", purpose: "diff" },
      ]);

      const granted = run(result.state, grant(uploadGrant({ artifactId: "id_1" })), context);
      expect(kinds(granted.effects)).toEqual(["ack", "upload"]);
      const forgotten = run(granted.state, {
        kind: "upload_settled",
        artifactId: "id_1",
        ok: true,
      });
      expect(forgotten.effects).toEqual([]);
      expect(forgotten.state.uploads).toEqual([{ artifactId: "id_2", purpose: "diff" }]);
    });

    it("the same held patch for the turn and the session is uploaded once and named by both", () => {
      const same = "33".repeat(32);
      const result = run(
        diffing(),
        runEnd(
          built({
            turn: report({ baseSha: TURN_SHA, ...held(same) }),
            session: report(held(same)),
          }),
        ),
      );
      expect(emitted(result.effects).filter((type) => type === "artifact.uploading")).toHaveLength(
        1,
      );
      const bodies = drafted(result, "diff.updated").map((payload) => payload.body);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(kinds(result.effects).filter((kind) => kind === "stage_upload")).toHaveLength(1);
    });

    it("a listing becomes one tree artifact both diffs name, uploaded once per digest and declared again after a failed upload", () => {
      const context = ctx();
      const listed = { paths: ["README.md", "src/index.ts"], treeDigest: "t1" };
      const result = run(
        diffing(),
        runEnd(built({ turn: report({ baseSha: TURN_SHA, ...listed }), session: report(listed) })),
        context,
      );
      expect(emitted(result.effects)).toEqual([
        "repository.status",
        "artifact.uploading",
        "diff.updated",
        "diff.updated",
        "verification.started",
      ]);
      expect(drafted(result, "artifact.uploading")).toEqual([
        {
          artifactId: "id_1",
          kind: "file",
          contentType: "text/plain; charset=utf-8",
          declaredBytes: 22,
          producer: "agent",
        },
      ]);
      const tree = {
        artifactId: "id_1",
        kind: "file",
        contentType: "text/plain; charset=utf-8",
        byteSize: 22,
        label: "tree.txt",
      };
      expect(drafted(result, "diff.updated").map((payload) => payload.tree)).toEqual([tree, tree]);
      expect(result.effects.filter((effect) => effect.kind === "stage_upload")).toEqual([
        {
          kind: "stage_upload",
          artifactId: "id_1",
          source: { kind: "text", text: "README.md\nsrc/index.ts" },
        },
      ]);
      expect(result.state.uploads).toEqual([{ artifactId: "id_1", purpose: "tree" }]);
      expect(result.state.lastTree).toEqual({ digest: "t1", artifact: tree });

      // The next measurement of the same tree names the artifact again and uploads nothing.
      const again = run(
        { ...result.state, run: diffing().run },
        runEnd(built({ turn: null, session: report(listed) })),
        context,
      );
      expect(emitted(again.effects)).not.toContain("artifact.uploading");
      expect(drafted(again, "diff.updated")[0]?.tree).toEqual(tree);

      // An upload that never landed is forgotten: the same tree is declared afresh.
      const lost = run(result.state, { kind: "upload_settled", artifactId: "id_1", ok: false });
      expect(lost.state.lastTree).toBeNull();
      const fresh = run(
        { ...lost.state, run: diffing().run },
        runEnd(built({ turn: null, session: report(listed) })),
        context,
      );
      expect(emitted(fresh.effects)).toContain("artifact.uploading");
      expect(drafted(fresh, "diff.updated")[0]?.tree).toMatchObject({
        artifactId: expect.not.stringMatching(/^id_1$/),
        label: "tree.txt",
      });

      // No listing, no tree.
      const bare = run(diffing(), runEnd(built()), ctx());
      expect(drafted(bare, "diff.updated").map((payload) => payload.tree)).toEqual([null, null]);
    });

    it("with no room for another upload, the inline cut travels and says truncated", () => {
      const full: AgentState = {
        ...diffing(),
        uploads: Array.from({ length: UPLOADS_LIMIT }, (_, index) => ({
          artifactId: `art_${index}`,
          purpose: "tool_output" as const,
        })),
      };
      const result = run(
        full,
        runEnd(built({ turn: null, session: report(held("44".repeat(32), "+cut")) })),
      );
      expect(emitted(result.effects)).toEqual([
        "repository.status",
        "diff.updated",
        "verification.started",
      ]);
      expect(drafted(result, "diff.updated")[0]).toMatchObject({
        body: { kind: "inline", patch: "+cut" },
        truncated: true,
      });
      expect(kinds(result.effects)).not.toContain("stage_upload");
    });

    it("OpenCode's idle, error, or model failure while measuring changes nothing, and a steer is refused", () => {
      const state = diffing();
      expect(run(state, event({ kind: "session_idle" })).state).toEqual(state);
      expect(
        run(
          state,
          event({ kind: "session_error", name: "UnknownError", message: "late", status: null }),
        ).state,
      ).toEqual(state);
      expect(run(state, frame(followUp("steer_current_run"))).effects[0]).toMatchObject({
        outcome: { kind: "rejected", reason: "wrong_state" },
      });
      expect(
        run(state, {
          kind: "prompt_settled",
          runId: "run_1",
          result: { kind: "held", conversation: "ses_1" },
          turnBase: null,
        }),
      ).toEqual({ state, effects: [] });
    });

    it("the runtime exiting while measuring does not fail the run", () => {
      const exited = run(diffing(), { kind: "runtime_exited", code: 1, signal: null });
      expect(emitted(exited.effects)).toEqual(["runtime.disconnected"]);
      expect(activeRun(exited.state).phase).toBe("diffing");
    });

    it("a cancel while measuring aborts nothing; the build still reports, then the run ends with no event of its own and a held start goes next", () => {
      const cancelled = run(diffing(), frame(cancel()));
      expect(cancelled.effects).toEqual([
        { kind: "ack", ref: { commandId: "cmd_cancel" }, outcome: { kind: "accepted" } },
      ]);
      const held = run(
        cancelled.state,
        frame(runStart({ commandId: "cmd_start_2", runId: "run_2", messageId: "msg_2" })),
      ).state;
      const ended = run(held, runEnd(built()));
      expect(emitted(ended.effects)).toEqual(["repository.status", "diff.updated", "diff.updated"]);
      expect(kinds(ended.effects).at(-1)).toBe("prompt");
      expect(activeRun(ended.state).runId).toBe("run_2");
      expect(ended.state.lastRun?.runId).toBe("run_1");
    });

    it("a checkpoint or a shutdown while measuring winds the run down without an abort", () => {
      expect(kinds(run(diffing(), frame(checkpointCreate("idle"))).effects)).toEqual([
        "ack",
        "checkpoint",
      ]);
      expect(kinds(run(diffing(), frame(shutdown())).effects)).toEqual(["ack", "signal_runtime"]);
    });

    it("a build for another run, or for a run no longer measuring, is only logged", () => {
      const logged = {
        kind: "log",
        line: "run-end diffs settled for a run that is not measuring them",
      };
      expect(run(diffing(), runEnd(built(), "run_9")).effects).toEqual([logged]);
      expect(run(repositoryRunning(), runEnd(built())).effects).toEqual([logged]);
      expect(run(repositoryReady(), runEnd(built())).effects).toEqual([logged]);
    });

    it("a session with no repository ends Done at once, with nothing to measure or check", () => {
      const result = run(running(), event({ kind: "session_idle" }));
      expect(kinds(result.effects)).not.toContain("build_diffs");
      expect(emitted(result.effects)).toEqual(["run.completed"]);
    });
  });

  describe("at a checkpoint", () => {
    it("the effect asks for the session's diff when a run can carry it, and not before any run", () => {
      expect(run(repositoryRunning(), frame(checkpointCreate("idle"))).effects).toContainEqual(
        expect.objectContaining({ kind: "checkpoint", sessionBaseSha: BASE_SHA }),
      );
      expect(run(workspaceReady(), frame(checkpointCreate("idle"))).effects).toContainEqual(
        expect.objectContaining({ kind: "checkpoint", sessionBaseSha: null }),
      );
    });

    it("the session's diff goes out before the checkpointed events, and not again when nothing changed", () => {
      const checkpointing = run(
        repositoryRunning(),
        frame(checkpointCreate("lifetime_ceiling")),
      ).state;
      const session = report({ headSha: NEW_HEAD });
      const result = run(checkpointing, {
        kind: "checkpoint_settled",
        checkpointId: checkpointId(checkpointing),
        result: { kind: "pushed", headSha: NEW_HEAD },
        diff: session,
        commit: null,
      });
      expect(emitted(result.effects)).toEqual([
        "diff.updated",
        "repository.checkpointed",
        "sandbox.checkpointed",
      ]);
      expect(drafted(result, "diff.updated")[0]).toMatchObject({
        scope: "session",
        headSha: NEW_HEAD,
      });
      expect(result.state.lastSessionDiff).toBe(diffKey(session));

      const again = run(result.state, frame(checkpointCreate("idle", "cmd_checkpoint_2"))).state;
      const repeated = run(again, {
        kind: "checkpoint_settled",
        checkpointId: checkpointId(again),
        result: { kind: "unchanged", headSha: NEW_HEAD },
        diff: { ...session, headSha: END_SHA },
        commit: null,
      });
      expect(emitted(repeated.effects)).toEqual([
        "repository.checkpointed",
        "sandbox.checkpointed",
      ]);
    });

    it("a large checkpoint diff is declared as an artifact alongside the bundle", () => {
      const checkpointing = run(repositoryRunning(), frame(checkpointCreate("pause"))).state;
      const result = run(checkpointing, {
        kind: "checkpoint_settled",
        checkpointId: checkpointId(checkpointing),
        result: { kind: "bundled", headSha: NEW_HEAD, byteSize: 70_000, push: "no_grant" },
        diff: report(held("55".repeat(32))),
        commit: null,
      });
      expect(emitted(result.effects)).toEqual([
        "artifact.uploading",
        "diff.updated",
        "artifact.uploading",
      ]);
      expect(result.state.uploads.map((upload) => upload.purpose)).toEqual(["diff", "checkpoint"]);
    });
  });

  describe("mid-run rebuilds", () => {
    const changed = event({ kind: "session_diff", files: [] });

    it("OpenCode's diff report starts one rebuild, and the rebuild's session diff goes out", () => {
      const first = run(repositoryRunning(), changed, ctx({ nowMs: 100_000 }));
      expect(first.effects).toEqual([
        { kind: "build_diffs", runId: "run_1", purpose: "mid_run", refs: REFS, turnBaseSha: null },
      ]);
      expect(first.state.diffRebuild).toEqual({
        lastStartedAtMs: 100_000,
        inFlight: true,
        wanted: false,
        timerArmed: false,
      });
      const settled = run(
        first.state,
        midRun(built({ status: null, turn: null })),
        ctx({ nowMs: 101_000 }),
      );
      expect(emitted(settled.effects)).toEqual(["diff.updated"]);
      expect(drafted(settled, "diff.updated")[0]).toMatchObject({ scope: "session" });
      expect(settled.state.diffRebuild.inFlight).toBe(false);
      expect(settled.state.lastSessionDiff).toBe(diffKey(report()));
    });

    it("coalesces: reports while one is in flight wait for it, then for the rest of 15 seconds, then one rebuild", () => {
      const first = run(repositoryRunning(), changed, ctx({ nowMs: 100_000 })).state;
      const second = run(first, changed, ctx({ nowMs: 102_000 }));
      expect(second.effects).toEqual([]);
      const third = run(second.state, changed, ctx({ nowMs: 103_000 }));
      expect(third.effects).toEqual([]);
      expect(third.state.diffRebuild.wanted).toBe(true);

      const settled = run(
        third.state,
        midRun(built({ status: null, turn: null })),
        ctx({ nowMs: 104_000 }),
      );
      expect(kinds(settled.effects)).toEqual(["emit", "diff_rebuild_timer"]);
      expect(settled.effects[1]).toEqual({ kind: "diff_rebuild_timer", afterMs: 11_000 });
      expect(settled.state.diffRebuild).toEqual({
        lastStartedAtMs: 100_000,
        inFlight: false,
        wanted: false,
        timerArmed: true,
      });

      const waiting = run(settled.state, changed, ctx({ nowMs: 110_000 }));
      expect(waiting.effects).toEqual([]);

      const due = run(waiting.state, { kind: "diff_rebuild_due" }, ctx({ nowMs: 115_000 }));
      expect(kinds(due.effects)).toEqual(["build_diffs"]);
      expect(due.state.diffRebuild).toMatchObject({
        lastStartedAtMs: 115_000,
        inFlight: true,
        timerArmed: false,
      });
    });

    it("a report after the interval has passed rebuilds at once, and one inside it arms the timer", () => {
      const first = run(repositoryRunning(), changed, ctx({ nowMs: 100_000 })).state;
      const idle = run(
        first,
        midRun(built({ status: null, turn: null })),
        ctx({ nowMs: 101_000 }),
      ).state;
      const soon = run(idle, changed, ctx({ nowMs: 105_000 }));
      expect(soon.effects).toEqual([{ kind: "diff_rebuild_timer", afterMs: 10_000 }]);
      const later = run(idle, changed, ctx({ nowMs: 115_000 }));
      expect(kinds(later.effects)).toEqual(["build_diffs"]);
    });

    it("a rebuild that measured nothing new sends nothing", () => {
      const first = run(repositoryRunning(), changed, ctx({ nowMs: 100_000 })).state;
      const once = run(
        first,
        midRun(built({ status: null, turn: null })),
        ctx({ nowMs: 101_000 }),
      ).state;
      const again = run(once, changed, ctx({ nowMs: 120_000 })).state;
      const same = run(
        again,
        midRun(
          built({
            status: null,
            turn: null,
            headSha: TURN_SHA,
            session: report({ headSha: TURN_SHA }),
          }),
        ),
        ctx({ nowMs: 121_000 }),
      );
      expect(same.effects).toEqual([]);
    });

    it("no rebuild without a running run in a repository; a timer or a result that arrives after is dropped", () => {
      expect(run(running(), changed).effects).toEqual([]);
      const prompting = run(repositoryReady(), frame(runStart())).state;
      expect(run(prompting, changed).effects).toEqual([]);
      expect(run(diffing(), changed).effects).toEqual([]);

      const armed: AgentState = {
        ...diffing(),
        diffRebuild: { lastStartedAtMs: 1, inFlight: false, wanted: true, timerArmed: true },
      };
      const due = run(armed, { kind: "diff_rebuild_due" });
      expect(due.effects).toEqual([]);
      expect(due.state.diffRebuild).toEqual({
        lastStartedAtMs: 1,
        inFlight: false,
        wanted: false,
        timerArmed: false,
      });

      const after = run(repositoryReady(), midRun(built({ status: null, turn: null })));
      expect(after.effects).toEqual([]);
      const failed = run(repositoryRunning(), midRun({ kind: "failed", detail: "add_failed" }));
      expect(failed.effects).toEqual([
        { kind: "log", line: "mid-run snapshot failed: add_failed" },
      ]);
    });

    it("a rebuild that settles while the run is measuring its end still sends its diff first", () => {
      const inFlight = run(repositoryRunning(), changed, ctx({ nowMs: 100_000 })).state;
      const ending = run(inFlight, event({ kind: "session_idle" })).state;
      const settled = run(ending, midRun(built({ status: null, turn: null })));
      expect(emitted(settled.effects)).toEqual(["diff.updated"]);
      expect(activeRun(settled.state).phase).toBe("diffing");
    });
  });
});

describe("the policy_propose tool", () => {
  const policy = {
    version: 4,
    commit: "auto",
    push: "manual",
    pullRequest: "manual",
    planApproval: "proceed",
    fileEdits: "allowed",
  } as const;
  const policyFrame: AgentInput = { kind: "frame", frame: { kind: "policy", policy } };
  const call: AgentInput = {
    kind: "policy_tool_called",
    call: { push: "auto", pullRequest: "auto_after_verification", rationale: "The user asked." },
  };

  it("holds the policy the object sends", () => {
    expect(initial().policy).toBeNull();
    expect(run(initial(), policyFrame).state.policy).toEqual(policy);
  });

  it("becomes policy.proposed against that policy, citing the last message prompted", () => {
    const informed = run(running(), policyFrame).state;
    const steered = run(informed, frame(followUp("steer_current_run"))).state;
    const proposed = run(steered, call);
    expect(proposed.state).toBe(steered);
    expect(proposed.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "policy.proposed",
          runId: null,
          payload: {
            proposalId: "id_1",
            triggeringMessageId: "msg_2",
            from: policy,
            to: { ...policy, push: "auto", pullRequest: "auto_after_verification" },
            direction: "mixed",
            rationale: "The user asked.",
          },
        },
      },
    ]);
    expect(activeRun(steered).promptedMessageIds.length).toBe(2);
  });

  it("keeps a field the call left out, commit included", () => {
    const informed = run(running(), policyFrame).state;
    const proposed = run(informed, {
      kind: "policy_tool_called",
      call: { commit: "manual", rationale: "Hold commits." },
    });
    expect(proposed.effects).toMatchObject([
      { draft: { payload: { to: { ...policy, commit: "manual" } } } },
    ]);
  });

  it("is dropped with no run, and with no policy yet", () => {
    expect(kinds(run(run(ready(), policyFrame).state, call).effects)).toEqual(["log"]);
    expect(kinds(run(running(), call).effects)).toEqual(["log"]);
  });
});

describe("the pull_request_describe tool (record 07)", () => {
  const call: AgentInput = {
    kind: "describe_tool_called",
    call: { branchName: "oncue/fix-login", title: "Fix the login redirect", body: null },
  };

  it("becomes pull_request.described charged to the active run, and is kept as the latest value of each field", () => {
    const before = running();
    const described = run(before, call);
    expect(described.state).toEqual({
      ...before,
      described: { branchName: "oncue/fix-login", title: "Fix the login redirect", body: null },
    });
    const again = run(described.state, {
      kind: "describe_tool_called",
      call: { branchName: null, title: null, body: "Why." },
    });
    expect(again.state.described).toEqual({
      branchName: "oncue/fix-login",
      title: "Fix the login redirect",
      body: "Why.",
    });
    expect(described.effects).toEqual([
      {
        kind: "emit",
        draft: {
          type: "pull_request.described",
          runId: activeRun(before).runId,
          payload: { branchName: "oncue/fix-login", title: "Fix the login redirect", body: null },
        },
      },
    ]);
  });

  it("is dropped with no active run", () => {
    expect(kinds(run(ready(), call).effects)).toEqual(["log"]);
  });
});

describe("a publish: the user's push through the checkpoint path", () => {
  const PUBLISHED = "c".repeat(40);
  const commit: DiffReport = {
    baseSha: HEAD_SHA,
    headSha: PUBLISHED,
    files: [{ path: "README.md", status: "modified", additions: 2, deletions: 0 }],
    additions: 2,
    deletions: 0,
    paths: [],
    treeDigest: "",
    patch: { kind: "inline", text: "diff" },
    digest: "bb".repeat(32),
    truncated: false,
  };

  /** A finished, verified run, the policy known, and the push grant the object sent for the publish. */
  function readyToPublish(): AgentState {
    const finished: AgentState = {
      ...repositoryReady(),
      policy: {
        version: 2,
        commit: "auto",
        push: "auto",
        pullRequest: "auto_after_verification",
        planApproval: "proceed",
        fileEdits: "allowed",
      },
      lastRun: {
        runId: "run_1",
        conversation: "ses_1",
        promptedMessageIds: ["msg_1"],
        commitSubject: "Add a README section.",
        verification: "passing",
      },
    };
    return run(finished, grant(pushGrant())).state;
  }

  function publishing(): AgentState {
    return run(readyToPublish(), frame(checkpointCreate("user_requested"))).state;
  }

  const settle = (
    state: AgentState,
    result: CheckpointOutcome,
    measuredCommit: DiffReport | null = commit,
  ) =>
    run(state, {
      kind: "checkpoint_settled",
      checkpointId: checkpointId(state),
      result,
      diff: null,
      commit: measuredCommit,
    });

  it("names its commit after the run and carries the grant's id as the push's id", () => {
    const result = run(readyToPublish(), frame(checkpointCreate("user_requested")));
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "checkpoint",
        reason: "user_requested",
        message: "Add a README section.",
        pushGrantId: "grant_push",
      }),
    );
    expect(result.state.checkpoint).toMatchObject({
      publish: {
        pushId: "grant_push",
        message: "Add a README section.",
        verification: "passing",
        parentSha: HEAD_SHA,
        branch: "oncue/readme-1a2b",
        policyVersion: 2,
      },
    });
  });

  // The subject can be the agent's pull request title, so it is cleaned like
  // every commit message, and the event says what Git gets.
  it("cleans the subject it names the commit after", () => {
    const base = readyToPublish();
    const hostile: AgentState = {
      ...base,
      lastRun: {
        ...(base.lastRun as NonNullable<AgentState["lastRun"]>),
        commitSubject: `Add${String.fromCharCode(0x202e)} a README`,
      },
    };
    const result = run(hostile, frame(checkpointCreate("user_requested")));
    expect(result.state.checkpoint).toMatchObject({ publish: { message: "Add a README" } });
  });

  it("is an ordinary checkpoint without a grant, without a finished run, or for another reason", () => {
    const noGrant = run(
      { ...readyToPublish(), pushGrant: null },
      frame(checkpointCreate("user_requested")),
    );
    expect(noGrant.state.checkpoint).toMatchObject({ publish: null });
    const noRun = run(
      { ...readyToPublish(), lastRun: null },
      frame(checkpointCreate("user_requested")),
    );
    expect(noRun.state.checkpoint).toMatchObject({ publish: null });
    const idle = run(readyToPublish(), frame(checkpointCreate("idle")));
    expect(idle.state.checkpoint).toMatchObject({ publish: null });
    expect(idle.effects).toContainEqual(expect.objectContaining({ message: null }));
  });

  it("assumes version 1 when the object has not sent the policy", () => {
    const result = run(
      { ...readyToPublish(), policy: null },
      frame(checkpointCreate("user_requested")),
    );
    expect(result.state.checkpoint).toMatchObject({ publish: { policyVersion: 1 } });
  });

  it("names the commit and the push by the grant's ref when the workspace had no branch yet", () => {
    const ready = readyToPublish();
    const workspace = ready.workspace as Extract<AgentState["workspace"], { kind: "ready" }>;
    const unnamed: AgentState = {
      ...ready,
      workspace: { ...workspace, branch: "main", taskBranch: null },
    };
    const started = run(unnamed, frame(checkpointCreate("user_requested")));
    expect(started.state.checkpoint).toMatchObject({ publish: { branch: "oncue/readme-1a2b" } });
    const result = settle(started.state, { kind: "pushed", headSha: PUBLISHED });
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { branch: "oncue/readme-1a2b" } },
    });
    expect(result.effects[1]).toMatchObject({
      draft: { payload: { branch: "oncue/readme-1a2b" } },
    });
    expect(result.state.workspace).toMatchObject({ taskBranch: "oncue/readme-1a2b" });
  });

  it("pushed: git.committed, reported as the user's commit, and git.push.completed come before the checkpoint's own report", () => {
    const result = settle(publishing(), { kind: "pushed", headSha: PUBLISHED });
    expect(emitted(result.effects)).toEqual([
      "git.committed",
      "git.push.completed",
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    expect(result.effects[0]).toMatchObject({
      draft: {
        runId: "run_1",
        payload: {
          commitSha: PUBLISHED,
          parentSha: HEAD_SHA,
          branch: "oncue/readme-1a2b",
          message: "Add a README section.",
          // The push the user's policy directed made this commit, not the agent.
          authorType: "user",
          authorName: "OnCue",
          files: commit.files,
          additions: 2,
          deletions: 0,
          verificationState: "passing",
          policy: { policyVersion: 2, rule: "auto_push", approvalId: null },
        },
      },
    });
    expect(result.effects[1]).toMatchObject({
      draft: {
        runId: "run_1",
        payload: {
          pushId: "grant_push",
          branch: "oncue/readme-1a2b",
          headSha: PUBLISHED,
          remoteSha: PUBLISHED,
        },
      },
    });
    expect(result.state.durableHead).toBe(PUBLISHED);
  });

  it("pushed with a commit that could not be measured: the commit is reported with no files", () => {
    const result = run(publishing(), {
      kind: "checkpoint_settled",
      checkpointId: checkpointId(publishing()),
      result: { kind: "pushed", headSha: PUBLISHED },
      diff: null,
      commit: null,
    });
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { files: [], additions: 0, deletions: 0 } },
    });
  });

  it.each([
    ["workflow_file_rejected", "workflow_file_rejected", false],
    ["ref_mismatch", "wrong_ref", false],
    ["rejected", "non_fast_forward", false],
    ["authentication_failed", "authentication", false],
    ["network", "network", true],
    ["no_grant", "unknown", false],
    ["grant_spent", "unknown", false],
    ["unknown", "unknown", false],
  ] as const)(
    "a commit that was not pushed for %s is git.push.failed as %s",
    (push, category, retryable) => {
      const result = settle(publishing(), { kind: "committed_only", headSha: PUBLISHED, push });
      expect(emitted(result.effects)).toEqual([
        "git.push.failed",
        "repository.checkpointed",
        "sandbox.checkpointed",
      ]);
      expect(result.effects[0]).toMatchObject({
        draft: { payload: { pushId: "grant_push", headSha: PUBLISHED, category, retryable } },
      });
    },
  );

  it("a publish withheld for a secret says which files, and is not retryable", () => {
    const result = settle(publishing(), {
      kind: "committed_only",
      headSha: PUBLISHED,
      push: "secret_in_changes",
      secretPaths: [".env", "notes.md"],
    });
    expect(emitted(result.effects)).toEqual([
      "git.push.failed",
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    expect(result.effects[0]).toMatchObject({
      draft: {
        payload: {
          pushId: "grant_push",
          category: "secret_in_changes",
          retryable: false,
          message: expect.stringContaining(".env, notes.md"),
        },
      },
    });
  });

  it("a publish withheld because the changes could not be checked says so", () => {
    const result = settle(publishing(), {
      kind: "committed_only",
      headSha: PUBLISHED,
      push: "secret_scan_failed",
    });
    expect(result.effects[0]).toMatchObject({
      draft: {
        payload: {
          category: "secret_in_changes",
          message: expect.stringContaining("could not be checked"),
        },
      },
    });
  });

  it("bundled reports the failed push before the bundle is declared", () => {
    const result = settle(publishing(), {
      kind: "bundled",
      headSha: PUBLISHED,
      byteSize: 10,
      push: "workflow_file_rejected",
    });
    expect(emitted(result.effects).slice(0, 2)).toEqual(["git.push.failed", "artifact.uploading"]);
    expect(result.effects[0]).toMatchObject({
      draft: { payload: { message: expect.stringContaining(".github/workflows") } },
    });
  });

  it("an unchanged tree and a failed snapshot report no commit and no push", () => {
    expect(emitted(settle(publishing(), { kind: "unchanged", headSha: HEAD_SHA }).effects)).toEqual(
      ["repository.checkpointed", "sandbox.checkpointed"],
    );
    // A failed snapshot made no commit, so there is no `git.*` to report; the
    // object settles the waiting publish on the checkpoint's own failure.
    expect(emitted(settle(publishing(), { kind: "failed", detail: "unknown" }).effects)).toEqual([
      "sandbox.checkpoint_failed",
    ]);
  });

  it("parents its snapshot on the agent's last commit and reports no final commit when the chain was pushed as it stood", () => {
    const TIP = "a".repeat(40);
    const started = run(
      { ...readyToPublish(), chainTip: TIP },
      frame(checkpointCreate("user_requested")),
    );
    expect(started.effects).toContainEqual(
      expect.objectContaining({ kind: "checkpoint", durableHeadSha: HEAD_SHA, parentSha: TIP }),
    );
    expect(started.state.checkpoint).toMatchObject({ publish: { parentSha: TIP } });
    // The tree was unchanged since the agent's commit: the head IS the tip.
    const pushedAsIs = settle(started.state, { kind: "pushed", headSha: TIP }, null);
    expect(emitted(pushedAsIs.effects)).toEqual([
      "git.push.completed",
      "repository.checkpointed",
      "sandbox.checkpointed",
    ]);
    expect(pushedAsIs.state.durableHead).toBe(TIP);
    expect(pushedAsIs.state.chainTip).toBeNull();
    // Work after the agent's last commit: one more commit on top, reported.
    const more = settle(started.state, { kind: "pushed", headSha: PUBLISHED });
    expect(emitted(more.effects)[0]).toBe("git.committed");
    expect(more.effects[0]).toMatchObject({ draft: { payload: { parentSha: TIP } } });
    expect(more.state.chainTip).toBeNull();
  });

  it("names the final commit after the title the agent gave, when it gave one", () => {
    const described: AgentState = {
      ...running(),
      described: { branchName: null, title: "Document the test command", body: null },
    };
    const ended = run(described, event({ kind: "session_idle" }));
    expect(ended.state.lastRun?.commitSubject).toBe("Document the test command");
  });
});

/**
 * A repository whose definition declares no checks, so a run that changed
 * files ends at once (with the no-checks warning) and a test about what the
 * run leaves behind needs no check to settle.
 */
function uncheckedRepository(): AgentState {
  return { ...repositoryReady(), project: null };
}

const TURN_BASE = "1111111111111111111111111111111111111111";
const CHANGED_FILE = { path: "README.md", status: "modified" as const, additions: 1, deletions: 0 };

/** One run in a repository, from its start to the run-end build, with the turn measured as changing files or not. */
function endedInRepository(
  state: AgentState,
  text: string,
  runId: string,
  changed: boolean,
): StepOutcome {
  const started = run(
    state,
    frame(runStart({ text, runId, commandId: `cmd_${runId}`, messageId: `msg_${runId}` })),
  ).state;
  const held = run(started, {
    kind: "prompt_settled",
    turnBase: { sha: TURN_BASE, status: null },
    runId,
    result: { kind: "held", conversation: "ses_1" },
  }).state;
  const idle = run(held, event({ kind: "session_idle" })).state;
  const turn = {
    baseSha: TURN_BASE,
    headSha: END_SHA,
    files: changed ? [CHANGED_FILE] : [],
    additions: changed ? 1 : 0,
    deletions: 0,
    patch: {
      kind: "inline" as const,
      text: changed ? "diff --git a/README.md b/README.md\n+x\n" : "",
    },
    digest: "bb".repeat(32),
    truncated: false,
    paths: [],
    treeDigest: "",
  };
  return run(idle, {
    kind: "diffs_built",
    runId,
    purpose: "run_end",
    result: { kind: "built", headSha: END_SHA, status: null, turn, session: null },
  });
}

describe("what a publish's commit is named after", () => {
  const ended = (state: AgentState, text: string, runId: string, changed: boolean) =>
    endedInRepository(state, text, runId, changed).state;

  it("is the first instruction whose work is unpushed, not the run that asked for the push", () => {
    const worked = ended(uncheckedRepository(), "Add a README section.", "run_1", true);
    const asked = ended(worked, "Push this and open a draft PR", "run_2", false);
    expect(asked.unpublishedSubject).toBe("Add a README section.");
    expect(asked.lastRun).toMatchObject({ runId: "run_2", commitSubject: "Add a README section." });
  });

  it("starts over once a push has carried the work", () => {
    const pushed: AgentState = {
      ...ended(uncheckedRepository(), "Add a README section.", "run_1", true),
      unpublishedSubject: null,
    };
    expect(ended(pushed, "Fix the typo.", "run_2", true).lastRun).toMatchObject({
      commitSubject: "Fix the typo.",
    });
  });

  it("a Done run renames nothing and keeps how the last change's checks ended (record 14)", () => {
    const worked: AgentState = {
      ...ended(uncheckedRepository(), "Add a README section.", "run_1", true),
      unpublishedSubject: null,
    };
    const checked: AgentState = {
      ...worked,
      lastRun: worked.lastRun === null ? null : { ...worked.lastRun, verification: "passing" },
    };
    const done = endedInRepository(checked, "What does this repository do?", "run_2", false);
    expect(emitted(done.effects)).toContain("run.completed");
    expect(done.state.unpublishedSubject).toBeNull();
    expect(done.state.lastRun).toMatchObject({
      runId: "run_2",
      conversation: "ses_1",
      commitSubject: "Add a README section.",
      verification: "passing",
    });
  });
});

describe("checks on request (record 14)", () => {
  const CHECKS_TEXT = "Run the repository's checks.";

  it("starts without prompting OpenCode, and goes straight to the run-end build with no turn base", () => {
    const result = run(repositoryReady(), frame(runStart({ checksOnly: true, text: CHECKS_TEXT })));
    expect(kinds(result.effects)).not.toContain("prompt");
    expect(emitted(result.effects)).toEqual(["run.started"]);
    expect(result.effects).toContainEqual(
      expect.objectContaining({ kind: "build_diffs", purpose: "run_end", turnBaseSha: null }),
    );
    expect(activeRun(result.state)).toMatchObject({
      checksOnly: true,
      phase: "diffing",
      conversation: null,
    });
  });

  it("verifies even when nothing changed since the last check", () => {
    const started = run(
      repositoryReady(),
      frame(runStart({ checksOnly: true, text: CHECKS_TEXT })),
    ).state;
    const unchanged = {
      baseSha: TURN_BASE,
      headSha: END_SHA,
      files: [],
      additions: 0,
      deletions: 0,
      patch: { kind: "inline" as const, text: "" },
      digest: "cc".repeat(32),
      truncated: false,
      paths: [],
      treeDigest: "",
    };
    const result = run(started, {
      kind: "diffs_built",
      runId: "run_1",
      purpose: "run_end",
      result: { kind: "built", headSha: END_SHA, status: null, turn: unchanged, session: null },
    });
    expect(emitted(result.effects)).toContain("verification.started");
    expect(emitted(result.effects)).not.toContain("run.completed");
  });

  it("with no repository says no checks were declared rather than ending Done", () => {
    const result = run(ready(), frame(runStart({ checksOnly: true, text: CHECKS_TEXT })));
    expect(emitted(result.effects)).toEqual(["run.started", "run.completed_with_warnings"]);
  });

  it("says it ran the checks and asked the agent nothing, not that the agent was silent", () => {
    const result = run(ready(), frame(runStart({ checksOnly: true, text: CHECKS_TEXT })));
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "emit",
        draft: expect.objectContaining({
          type: "run.completed_with_warnings",
          payload: expect.objectContaining({
            summary: expect.objectContaining({ whatChanged: CHECKS_ONLY_WHAT_CHANGED }),
          }),
        }),
      }),
    );
  });

  it("keeps the agent's conversation: the next message continues from the checks run", () => {
    const worked = endedInRepository(
      uncheckedRepository(),
      "Add a README section.",
      "run_1",
      true,
    ).state;
    const checks = run(
      worked,
      frame(
        runStart({
          checksOnly: true,
          text: CHECKS_TEXT,
          runId: "run_2",
          commandId: "cmd_run_2",
          messageId: "msg_run_2",
          continuesRunId: "run_1",
        }),
      ),
    ).state;
    const finished = run(checks, {
      kind: "diffs_built",
      runId: "run_2",
      purpose: "run_end",
      result: { kind: "built", headSha: END_SHA, status: null, turn: null, session: null },
    }).state;
    expect(finished.run).toEqual({ kind: "idle" });
    expect(finished.unpublishedSubject).toBe("Add a README section.");
    expect(finished.lastRun).toMatchObject({
      runId: "run_2",
      conversation: "ses_1",
      commitSubject: "Add a README section.",
      promptedMessageIds: ["msg_run_1", "msg_run_2"],
    });
    const next = run(
      finished,
      frame(
        runStart({
          text: "Now fix the typo.",
          runId: "run_3",
          commandId: "cmd_run_3",
          messageId: "msg_run_3",
          continuesRunId: "run_2",
        }),
      ),
    );
    expect(next.effects).toContainEqual(
      expect.objectContaining({ kind: "prompt", conversation: "ses_1" }),
    );
  });
});

describe("commitSubjectFor", () => {
  it("is the instruction's first line, trimmed and cut to a subject's length", () => {
    expect(commitSubjectFor("  Fix the login bug  \n\nIt fails on Safari.")).toBe(
      "Fix the login bug",
    );
    expect(commitSubjectFor("x".repeat(200))).toHaveLength(COMMIT_SUBJECT_CHARS);
    expect(commitSubjectFor(`${"y".repeat(71)} z tail`)).toBe("y".repeat(71));
  });

  it("falls back when the instruction has no words on its first line", () => {
    expect(commitSubjectFor("   ")).toBe("Update from OnCue");
  });
});

describe("a held secret call, as OpenCode 1.18.30 really sends it", () => {
  // The three frames OpenCode emits, in order, for a held tool-server call:
  // the part pending with no input, the permission, then the part running
  // with its input.
  const part = (status: "pending" | "running", input: Record<string, unknown>) => ({
    kind: "runtime_event" as const,
    event: {
      kind: "tool_part" as const,
      messageId: "msg_1",
      part: {
        callId: "toolu_double_secret",
        tool: "oncue_secret_request",
        status,
        title: null,
        input,
        output: null,
        error: null,
        exitCode: null,
        startedAtMs: status === "running" ? 1 : null,
        endedAtMs: null,
      },
    },
  });

  it("sends approval.requested once the running part shows the name", () => {
    const running = repositoryRunning();
    const pending = run(running, part("pending", {}));
    const asked = run(pending.state, {
      kind: "runtime_event",
      event: {
        kind: "permission_asked",
        requestId: "per_1",
        permission: "oncue_secret_request",
        callId: "toolu_double_secret",
      },
    });
    expect(asked.state.secrets.waiting).toMatchObject({ callId: "toolu_double_secret" });
    const shown = run(asked.state, part("running", { name: "STRIPE_TEST_KEY" }));
    expect(emitted(shown.effects)).toContain("approval.requested");
    expect(shown.state.secrets.waiting).toMatchObject({ name: "STRIPE_TEST_KEY", asked: true });
  });
});

describe("a launch grant's files come before the run's first prompt", () => {
  const launchGrant = () =>
    grant(
      buildGrantFrame(IDENTITY, {
        kind: "secret",
        grantId: "grant_launch",
        expiresAt: "2026-09-21T00:10:00.000Z",
        secrets: [{ name: "DATABASE_URL", value: "fake-database-url-0001" }],
        requestRef: null,
      }),
    );

  it("holds run.start while the supervisor is writing, and prompts once it has answered", () => {
    const granted = run(ready(), launchGrant());
    expect(granted.effects.map((effect) => effect.kind)).toContain("write_secrets");
    expect(granted.state.secrets.writes).toHaveLength(1);

    const started = run(granted.state, frame(runStart()));
    expect(started.effects.map((effect) => effect.kind)).not.toContain("prompt");
    expect(started.effects.map((effect) => effect.kind)).toContain("ack");
    expect(started.state.pendingStart).not.toBeNull();
    expect(started.state.run.kind).toBe("idle");

    const written = run(started.state, {
      kind: "secrets_written",
      grantId: "grant_launch",
      failedNames: [],
    });
    expect(written.effects.map((effect) => effect.kind)).toContain("prompt");
    expect(written.state.pendingStart).toBeNull();
    expect(written.state.run.kind).toBe("active");
    expect(JSON.stringify(written)).not.toContain("fake-database-url-0001");
  });

  it("says a held start failed when the runtime exits before it was prompted", () => {
    const granted = run(ready(), launchGrant());
    const held = run(granted.state, frame(runStart()));
    expect(held.state.pendingStart).not.toBeNull();
    const exited = run(held.state, { kind: "runtime_exited", code: 1, signal: null });
    expect(emitted(exited.effects)).toContain("run.failed");
    expect(exited.state.pendingStart).toBeNull();
  });

  it("prompts at once when nothing is being written", () => {
    const started = run(ready(), frame(runStart()));
    expect(started.effects.map((effect) => effect.kind)).toContain("prompt");
  });
});

describe("the git_commit tool (record 07, Commits)", () => {
  const TIP = "a".repeat(40);
  const NEXT = "b".repeat(40);
  const call = (requestId = "req_1"): AgentInput => ({
    kind: "commit_tool_called",
    requestId,
    call: { message: "Fix the redirect\n\nIt looped." },
  });
  const measured: DiffReport = {
    baseSha: HEAD_SHA,
    headSha: TIP,
    files: [{ path: "src/redirect.ts", status: "modified", additions: 3, deletions: 1 }],
    additions: 3,
    deletions: 1,
    paths: [],
    treeDigest: "",
    patch: { kind: "inline", text: "diff" },
    digest: "cc".repeat(32),
    truncated: false,
  };

  const autoCommit = {
    version: 1,
    commit: "auto",
    push: "manual",
    pullRequest: "manual",
    planApproval: "proceed",
    fileEdits: "allowed",
  } as const;
  const policyFrame = (commit: "auto" | "manual", version = 1): AgentInput => ({
    kind: "frame",
    frame: { kind: "policy", policy: { ...autoCommit, commit, version } },
  });

  /** A run on a repository, prompted and held by OpenCode, under the object's default policy. */
  function runningOnRepository(): AgentState {
    const started = run(run(repositoryReady(), policyFrame("auto")).state, frame(runStart())).state;
    return run(started, {
      kind: "prompt_settled",
      turnBase: null,
      runId: "run_1",
      result: { kind: "held", conversation: "ses_1" },
    }).state;
  }

  // Narrowing applies at once, so the tool reads the latest policy on every
  // call, and a policy that never arrived is not permission (records 07, 09).
  describe("the session's commit policy", () => {
    it("refuses and commits nothing when the user asked not to commit", () => {
      const result = run(run(runningOnRepository(), policyFrame("manual", 2)).state, call());
      expect(result.effects).toEqual([
        expect.objectContaining({ kind: "commit_answer", requestId: "req_1", isError: true }),
      ]);
      const text = (result.effects[0] as { text: string }).text;
      expect(text).toContain("the user asked not to commit until they say so");
      expect(text).toContain("nothing is lost");
      expect(result.state.commitInFlight).toBeNull();
      // A refusal does not use up the run's allowance.
      expect(result.state.commitsThisRun).toBe(0);
    });

    it("refuses when no policy has reached the sandbox", () => {
      const noPolicy = { ...runningOnRepository(), policy: null };
      const result = run(noPolicy, call());
      expect(result.effects).toEqual([
        expect.objectContaining({ kind: "commit_answer", isError: true }),
      ]);
      expect((result.effects[0] as { text: string }).text).toContain("has not reached the sandbox");
      expect(result.state.commitInFlight).toBeNull();
    });

    it("stops mid-run the moment the user narrows, and commits again once they allow it", () => {
      const first = run(runningOnRepository(), call("req_1"));
      expect(first.effects[0]).toMatchObject({ kind: "commit_work" });
      const settled = run(first.state, {
        kind: "commit_settled",
        requestId: "req_1",
        result: { kind: "committed", sha: TIP, parentSha: HEAD_SHA, commit: null },
      }).state;

      const narrowed = run(settled, policyFrame("manual", 2)).state;
      const refused = run(narrowed, call("req_2"));
      expect(refused.effects[0]).toMatchObject({ kind: "commit_answer", isError: true });

      const widened = run(narrowed, policyFrame("auto", 3)).state;
      const allowed = run(widened, call("req_3"));
      expect(allowed.effects[0]).toMatchObject({ kind: "commit_work", parentSha: TIP });
    });
  });

  it("asks for a snapshot parented on the durable head, one call at a time, and answers refusals to the model", () => {
    const asked = run(runningOnRepository(), call());
    expect(asked.effects).toEqual([
      {
        kind: "commit_work",
        requestId: "req_1",
        runId: "run_1",
        message: "Fix the redirect\n\nIt looped.",
        parentSha: HEAD_SHA,
      },
    ]);
    expect(asked.state).toMatchObject({
      commitInFlight: { requestId: "req_1", message: "Fix the redirect\n\nIt looped." },
      commitsThisRun: 1,
    });
    const second = run(asked.state, call("req_2"));
    expect(second.effects).toEqual([
      expect.objectContaining({ kind: "commit_answer", requestId: "req_2", isError: true }),
    ]);
    expect((second.effects[0] as { text: string }).text).toContain("still being made");
  });

  it.each([
    ["no active run", repositoryReady(), "no run is active"],
    [
      "a checkpoint in flight",
      {
        ...runningOnRepository(),
        checkpoint: {
          kind: "running",
          commandId: "c",
          checkpointId: "k",
          reason: "idle",
          runId: "run_1",
          startedAtMs: 0,
          publish: null,
          pushedBranch: null,
        },
      },
      "checkpoint is in progress",
    ],
    [
      "the run's bound reached",
      { ...runningOnRepository(), commitsThisRun: MAX_COMMITS_PER_RUN },
      "the most a run may",
    ],
  ] as const)("refuses with %s", (_name, state, why) => {
    const result = run(state as AgentState, call());
    expect(result.effects).toEqual([
      expect.objectContaining({ kind: "commit_answer", requestId: "req_1", isError: true }),
    ]);
    expect((result.effects[0] as { text: string }).text).toContain(why);
    expect(result.state.commitInFlight).toBeNull();
  });

  it("a commit becomes the chain's tip and is reported as the agent's, with its message and measured files", () => {
    const asked = run(runningOnRepository(), call()).state;
    const settled = run(asked, {
      kind: "commit_settled",
      requestId: "req_1",
      result: { kind: "committed", sha: TIP, parentSha: HEAD_SHA, commit: measured },
    });
    expect(settled.state.chainTip).toBe(TIP);
    expect(settled.state.commitInFlight).toBeNull();
    expect(emitted(settled.effects)).toEqual(["git.committed"]);
    expect(settled.effects[0]).toMatchObject({
      draft: {
        runId: "run_1",
        payload: {
          commitSha: TIP,
          parentSha: HEAD_SHA,
          branch: "oncue/readme-1a2b",
          message: "Fix the redirect\n\nIt looped.",
          authorType: "agent",
          files: measured.files,
          additions: 3,
          deletions: 1,
          verificationState: "none",
          policy: { policyVersion: 1, rule: "auto_commit", approvalId: null },
        },
      },
    });
    // The next commit is parented on the tip, and a checkpoint is too.
    const next = run(settled.state, call("req_2"));
    expect(next.effects[0]).toMatchObject({ kind: "commit_work", parentSha: TIP });
    const chained = run(next.state, {
      kind: "commit_settled",
      requestId: "req_2",
      result: { kind: "committed", sha: NEXT, parentSha: TIP, commit: null },
    });
    expect(chained.state.chainTip).toBe(NEXT);
    expect(chained.effects[0]).toMatchObject({ draft: { payload: { files: [], parentSha: TIP } } });
  });

  it("an unchanged tree or a failed snapshot changes nothing but the slot, and a stale settle is ignored", () => {
    const asked = run(runningOnRepository(), call()).state;
    const unchanged = run(asked, {
      kind: "commit_settled",
      requestId: "req_1",
      result: { kind: "unchanged", sha: HEAD_SHA },
    });
    expect(unchanged.state.chainTip).toBeNull();
    expect(unchanged.state.commitInFlight).toBeNull();
    expect(kinds(unchanged.effects)).toEqual(["log"]);
    const failed = run(asked, {
      kind: "commit_settled",
      requestId: "req_1",
      result: { kind: "failed", detail: "add_failed" },
    });
    expect(failed.state.chainTip).toBeNull();
    expect(kinds(failed.effects)).toEqual(["log"]);
    const stale = run(asked, {
      kind: "commit_settled",
      requestId: "req_other",
      result: { kind: "unchanged", sha: HEAD_SHA },
    });
    expect(stale.state).toBe(asked);
  });

  it("keeps a commit that settles after its run ended as the chain's tip, without an event", () => {
    const asked = run(runningOnRepository(), call()).state;
    const ended = { ...asked, run: { kind: "idle" } as const };
    const settled = run(ended, {
      kind: "commit_settled",
      requestId: "req_1",
      result: { kind: "committed", sha: TIP, parentSha: HEAD_SHA, commit: null },
    });
    expect(settled.state.chainTip).toBe(TIP);
    expect(kinds(settled.effects)).toEqual(["log"]);
  });

  it("a new run starts its count over", () => {
    const counted = { ...runningOnRepository(), commitsThisRun: 7 };
    const wound = { ...counted, run: { kind: "idle" } as const };
    const next = run(wound, frame(runStart({ commandId: "cmd_2", messageId: "msg_2" })));
    expect(next.state.commitsThisRun).toBe(0);
  });
});

describe("a question the harness waits on (record 12)", () => {
  const QUESTION = {
    id: "q1",
    header: "Database",
    text: "Which database?",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "SQLite", description: "One file" },
    ],
    multiple: false,
    allowOther: true,
  };
  const asked: AgentInput = {
    kind: "runtime_event",
    event: {
      kind: "question_asked",
      requestId: "que_1",
      callId: "call_q",
      questions: [QUESTION],
      askedCount: 1,
    },
  };
  const questionFrame = (
    outcome: "answered" | "dismissed" | "refused",
    answers: string[][] | null = null,
  ): AgentInput => ({
    kind: "frame",
    frame: { kind: "question", requestRef: "id_1", outcome, answers },
  });

  it("sends question.asked under its own reference and waits", () => {
    const step = run(repositoryRunning(), asked);
    expect(emitted(step.effects)).toEqual(["question.asked"]);
    const draft = step.effects.find((effect) => effect.kind === "emit");
    expect(draft).toMatchObject({
      draft: {
        runId: "run_1",
        payload: { questionId: "id_1", toolCallId: "call_q", questions: [QUESTION] },
      },
    });
    expect(step.state.questions.waiting).toMatchObject({ requestId: "que_1", ref: "id_1" });
  });

  it("answers the harness on the object's answer, and dismisses on its dismissal", () => {
    const waiting = run(repositoryRunning(), asked).state;
    const answered = run(waiting, questionFrame("answered", [["SQLite"]]));
    expect(answered.effects).toEqual([
      {
        kind: "reply_question",
        requestId: "que_1",
        reply: { kind: "answer", answers: [["SQLite"]] },
      },
    ]);
    expect(answered.state.questions.waiting).toBeNull();
    expect(run(waiting, questionFrame("dismissed")).effects).toEqual([
      {
        kind: "reply_question",
        requestId: "que_1",
        reply: { kind: "dismiss", reason: "dismissed" },
      },
    ]);
  });

  it("dismisses a question asked with no running run", () => {
    const step = run(ready(), asked);
    expect(kinds(step.effects)).toEqual(["reply_question", "log"]);
    expect(emitted(step.effects)).toEqual([]);
  });

  it("forgets a question the harness settled itself", () => {
    const waiting = run(repositoryRunning(), asked).state;
    const settledByHarness = run(waiting, {
      kind: "runtime_event",
      event: { kind: "question_settled", requestId: "que_1" },
    });
    expect(settledByHarness.state.questions.waiting).toBeNull();
    expect(kinds(settledByHarness.effects)).toEqual(["log"]);
  });

  it("dismisses the waiting question when the run ends", () => {
    const waiting = run(repositoryRunning(), asked).state;
    const cancelled = run(waiting, frame(cancel()));
    expect(cancelled.state.questions.waiting).not.toBeNull();
    const ended = run(cancelled.state, {
      kind: "runtime_event",
      event: { kind: "session_idle" },
    });
    expect(ended.effects).toContainEqual({
      kind: "reply_question",
      requestId: "que_1",
      reply: { kind: "dismiss", reason: "run_ended" },
    });
    expect(ended.state.questions.waiting).toBeNull();
  });

  it("dismisses the waiting question on shutdown", () => {
    const waiting = run(repositoryRunning(), asked).state;
    const stopped = run(waiting, frame(shutdown()));
    expect(stopped.effects).toContainEqual({
      kind: "reply_question",
      requestId: "que_1",
      reply: { kind: "dismiss", reason: "run_ended" },
    });
    expect(stopped.state.questions.waiting).toBeNull();
  });
});
