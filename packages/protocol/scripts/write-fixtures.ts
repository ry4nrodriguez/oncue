import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventType } from "../src/catalog";
import type { ProtocolEvent, ProtocolEventOf } from "../src/events";
import {
  createStream,
  type EventStream,
  makeEvent,
  type StreamEmitOverrides,
  testArtifactRef,
  toJsonLine,
} from "../src/testing";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

// Reserved for a recording of a real OpenCode run; never generated here.
const RECORDED = "opencode-session-recorded.jsonl";

const SESSION = "sess_fixture";

type Scenario = {
  readonly name: string;
  readonly build: () => readonly string[];
};

type Emit = <T extends EventType>(
  type: T,
  overrides?: StreamEmitOverrides<T>,
) => ProtocolEventOf<T>;

function scenario(name: string, body: (emit: Emit, stream: EventStream) => void): Scenario {
  return {
    name,
    build: () => {
      const lines: string[] = [];
      const stream = createStream({ sessionId: SESSION, runId: "run_1" });
      const emit: Emit = (type, overrides) => {
        const event = stream.emit(type, overrides);
        lines.push(toJsonLine(event));
        return event;
      };
      body(emit, stream);
      return lines;
    },
  };
}

function withCraftedLines(
  name: string,
  body: (emit: Emit, craft: (line: string) => void, stream: EventStream) => void,
): Scenario {
  return {
    name,
    build: () => {
      const lines: string[] = [];
      const stream = createStream({ sessionId: SESSION, runId: "run_1" });
      const emit: Emit = (type, overrides) => {
        const event = stream.emit(type, overrides);
        lines.push(toJsonLine(event));
        return event;
      };
      body(emit, (line) => lines.push(line), stream);
      return lines;
    },
  };
}

function mutated(event: ProtocolEvent, patch: Record<string, unknown>): string {
  return toJsonLine({ ...event, ...patch });
}

function startRun(emit: Emit): void {
  emit("sandbox.provisioning");
  emit("run.queued");
  emit("sandbox.attached");
  emit("runtime.connected");
  emit("runtime.ready");
  emit("run.started");
}

const scenarios: readonly Scenario[] = [
  scenario("good-stream", (emit) => {
    startRun(emit);
    emit("status.updated");
    emit("message.started");
    emit("message.delta");
    emit("message.completed");
    emit("plan.created");
    emit("tool.requested");
    emit("tool.started");
    emit("tool.output");
    emit("tool.completed");
    emit("file.changed");
    emit("repository.status");
    emit("diff.updated");
    emit("plan.updated");
    emit("git.committed");
    emit("verification.started");
    emit("verification.result");
    emit("verification.completed");
    emit("plan.completed");
    emit("status.updated", {
      payload: { stepId: "step_2", phase: "finishing", label: "Finishing", status: "complete" },
    });
    emit("git.push.requested");
    emit("git.push.completed");
    emit("pull_request.created");
    emit("message.started", { payload: { messageId: "msg_2" } });
    emit("message.completed", {
      payload: {
        messageId: "msg_2",
        parts: [
          { type: "text", text: "Done. The test passes and the change is on the task branch." },
        ],
      },
    });
    emit("run.verified", { payload: { pullRequestNumber: 42 } });
    emit("sandbox.idle");
    emit("sandbox.checkpointed");
    emit("runtime.disconnected");
    emit("sandbox.stopped");
  }),

  scenario("large-log-artifact", (emit) => {
    startRun(emit);
    const toolCallId = "tool_build";
    const artifact = testArtifactRef({
      artifactId: "art_build_log",
      byteSize: 5 * 1024 * 1024,
      label: "pnpm build output",
    });
    emit("tool.requested", {
      payload: { toolCallId, title: "Run the full build", input: { command: "pnpm build" } },
    });
    emit("tool.started", { payload: { toolCallId } });
    const line = "[build] compiling module ................................................ done\n";
    for (let chunkIndex = 0; chunkIndex < 4; chunkIndex += 1) {
      emit("tool.output", {
        payload: {
          toolCallId,
          chunkIndex,
          text: line.repeat(40),
          droppedBytes: chunkIndex === 3 ? 4 * 1024 * 1024 : 0,
        },
      });
    }
    emit("artifact.uploading", {
      payload: { artifactId: artifact.artifactId, declaredBytes: artifact.byteSize },
    });
    emit("artifact.created", { payload: { artifact } });
    emit("tool.completed", {
      payload: {
        toolCallId,
        durationMs: 90000,
        result: {
          kind: "artifact",
          summary: "Build succeeded. The full 5 MB log is stored as an artifact.",
          artifact,
          truncated: true,
        },
      },
    });
    emit("run.verified");
  }),

  scenario("approval-flow", (emit) => {
    startRun(emit);
    const toolCallId = "tool_push";
    emit("tool.requested", {
      payload: {
        toolCallId,
        category: "git_remote",
        title: "Push to the task branch",
        runtimeName: "git",
        input: { command: "git push origin oncue/session-1" },
        approvalId: "apr_1",
      },
    });
    emit("approval.requested", { payload: { toolCallId } });
    emit("approval.resolved");
    emit("tool.started", { payload: { toolCallId } });
    emit("tool.completed", {
      payload: { toolCallId, result: { kind: "none", summary: "Pushed 1 commit." } },
    });
    emit("git.push.completed");
    emit("run.verified");
  }),

  // The agent asks through its harness's question tool; the user answers on
  // the card and the held call completes with the answer.
  scenario("question-flow", (emit) => {
    startRun(emit);
    const toolCallId = "call_question_1";
    emit("tool.requested", {
      payload: {
        toolCallId,
        category: "other",
        title: "Asking the user",
        runtimeName: "question",
        input: {},
      },
    });
    emit("question.asked", { payload: { toolCallId } });
    emit("question.answered");
    emit("tool.completed", {
      payload: { toolCallId, result: { kind: "none", summary: "The user answered." } },
    });
    emit("run.completed");
  }),

  // Silence is not approval: nobody answers, the control plane expires the
  // approval with `tool_denied`, the tool call fails, and the run goes on
  // without the value.
  scenario("approval-expired", (emit) => {
    startRun(emit);
    // What the launch disclosed: one required name supplied, one optional withheld.
    emit("secrets.disclosed");
    // The bridge answered the grant that carried the launch's selection.
    emit("secrets.supplied");
    const toolCallId = "tool_secret";
    emit("tool.requested", {
      payload: {
        toolCallId,
        category: "other",
        title: "Ask for STRIPE_TEST_KEY",
        runtimeName: "oncue_secret_request",
        input: { name: "STRIPE_TEST_KEY" },
        approvalId: "apr_1",
      },
    });
    emit("approval.requested", {
      payload: {
        toolCallId,
        title: "Supply STRIPE_TEST_KEY",
        intendedAction:
          "Give this session the saved development secret STRIPE_TEST_KEY. The repository's code can read it, and the model provider may see it.",
        category: "development_secret",
        risk: "medium",
        resource: "STRIPE_TEST_KEY",
        requestedScope: "This session's sandbox (generation 1), until it stops",
      },
    });
    emit("approval.expired", { payload: { effect: "tool_denied" } });
    emit("tool.failed", { payload: { toolCallId } });
    emit("run.verified");
  }),

  // Record 09's agent permissions: the user chose "Allow for this session" in
  // the menu, so a read outside the project is answered at once by that
  // choice; a secret file still asks, and the user allows it once.
  scenario("permission-flow", (emit) => {
    startRun(emit);
    emit("approval.mode_changed", { payload: { mode: "session", commandId: "cmd_mode" } });
    const outside = "tool_read_hosts";
    emit("tool.requested", {
      payload: {
        toolCallId: outside,
        category: "file_read",
        title: "read",
        runtimeName: "read",
        input: { filePath: "/etc/hosts" },
        approvalId: null,
      },
    });
    emit("approval.requested", {
      payload: {
        approvalId: "apr_outside",
        toolCallId: outside,
        title: "Read /etc/hosts, outside the project",
        intendedAction: "The agent wants to use a path outside the repository's work tree.",
        category: "outside_project",
        risk: "medium",
        resource: "/etc/hosts",
        requestedScope: "Files outside the project",
        toolCategory: "file_read",
      },
    });
    emit("approval.resolved", {
      payload: { approvalId: "apr_outside", scope: "session", automatic: true },
    });
    emit("tool.started", { payload: { toolCallId: outside } });
    emit("tool.completed", {
      payload: { toolCallId: outside, result: { kind: "none", summary: "Read 12 lines." } },
    });
    const env = "tool_read_env";
    emit("tool.requested", {
      payload: {
        toolCallId: env,
        category: "file_read",
        title: "read",
        runtimeName: "read",
        input: { filePath: ".env" },
        approvalId: null,
      },
    });
    emit("approval.requested", {
      payload: {
        approvalId: "apr_env",
        toolCallId: env,
        title: "Read .env, a secret file",
        intendedAction:
          "The agent wants to read a file that usually holds secrets. Secret files always ask, whatever the approval mode.",
        category: "secret_file",
        risk: "high",
        resource: ".env",
        requestedScope: "Secret files",
        toolCategory: "file_read",
      },
    });
    emit("approval.resolved", {
      payload: { approvalId: "apr_env", scope: "once", commandId: "cmd_env" },
    });
    emit("tool.started", { payload: { toolCallId: env } });
    emit("tool.completed", {
      payload: { toolCallId: env, result: { kind: "none", summary: "Read 3 lines." } },
    });
    emit("run.completed");
  }),

  scenario("resume-after-replacement", (emit, stream) => {
    startRun(emit);
    emit("message.started");
    emit("message.completed");
    emit("file.changed");
    emit("sandbox.idle");
    emit("sandbox.checkpointed");
    emit("runtime.disconnected");
    emit("sandbox.stopped");
    emit("run.paused", {
      runtimeSequence: null,
      payload: { reason: "idle_stop", detail: "The sandbox stopped after the idle checkpoint." },
    });
    stream.replaceSandbox();
    emit("sandbox.provisioning", {
      payload: { reason: "resume", cacheReuse: "repository_environment" },
    });
    emit("sandbox.replaced");
    emit("sandbox.attached", { payload: { providerSandboxId: "sb_2" } });
    emit("runtime.connected");
    emit("runtime.ready");
    emit("run.started", { payload: { resumedFrom: "ckpt_1" } });
    emit("message.started", { payload: { messageId: "msg_2" } });
    emit("message.completed", { payload: { messageId: "msg_2" } });
    emit("run.verified");
  }),

  // The object refused the bridge's `run.verified` (never stored, so absent
  // here) and committed the outcome the records support in its place.
  scenario("verified-refused", (emit) => {
    startRun(emit);
    emit("message.started");
    emit("message.completed");
    emit("file.changed");
    emit("diff.updated", { payload: { scope: "turn" } });
    emit("diff.updated", { payload: { scope: "session" } });
    emit("run.completed_with_warnings", {
      runtimeSequence: null,
      payload: {
        warnings: [
          {
            text: "The required check chk_1 has no passing record.",
            recommendedAction: "Run the check before relying on this change.",
          },
        ],
      },
    });
    emit("sandbox.idle");
  }),

  // Record 12: the primary agent starts two subagents side by side. Their
  // messages and calls carry their `agentId`; one finishes and one is stopped.
  scenario("subagents", (emit) => {
    startRun(emit);
    const parent = { category: "other", runtimeName: "task", inputComplete: true } as const;
    for (const [call, description] of [
      ["call_task_1", "Find the retry budget"],
      ["call_task_2", "Read the deployment notes"],
    ] as const) {
      emit("tool.requested", {
        payload: {
          ...parent,
          toolCallId: call,
          title: description,
          input: { description, prompt: `${description} and report back.` },
        },
      });
      emit("tool.started", { payload: { toolCallId: call } });
    }
    emit("agent.started", {
      payload: { agentId: "ses_child_1", parentToolCallId: "call_task_1" },
    });
    emit("agent.started", {
      payload: {
        agentId: "ses_child_2",
        parentToolCallId: "call_task_2",
        name: "general",
        description: "Read the deployment notes",
      },
    });
    emit("message.started", {
      payload: { messageId: "msg_child_1", role: "assistant", agentId: "ses_child_1" },
    });
    emit("tool.requested", {
      payload: {
        toolCallId: "call_child_grep",
        category: "search",
        title: "retry budget",
        runtimeName: "grep",
        input: { pattern: "retryBudget" },
        agentId: "ses_child_1",
      },
    });
    emit("tool.started", { payload: { toolCallId: "call_child_grep", agentId: "ses_child_1" } });
    emit("tool.output", { payload: { toolCallId: "call_child_grep", agentId: "ses_child_1" } });
    emit("tool.completed", { payload: { toolCallId: "call_child_grep", agentId: "ses_child_1" } });
    emit("message.delta", { payload: { messageId: "msg_child_1", agentId: "ses_child_1" } });
    emit("message.completed", {
      payload: {
        messageId: "msg_child_1",
        parts: [{ type: "text", text: "It is defined in src/retry.ts." }],
        agentId: "ses_child_1",
      },
    });
    emit("agent.completed", { payload: { agentId: "ses_child_1" } });
    emit("tool.completed", { payload: { toolCallId: "call_task_1" } });
    emit("agent.completed", {
      payload: {
        agentId: "ses_child_2",
        status: "cancelled",
        usage: { tokens: 0, toolCalls: 0, durationMs: 2100 },
        resultSummary: "Stopped by the user.",
      },
    });
    emit("tool.failed", {
      payload: {
        toolCallId: "call_task_2",
        errorText: "Task cancelled",
        category: "runtime_error",
      },
    });
    emit("run.completed");
  }),

  withCraftedLines("stale-generation", (emit, craft, stream) => {
    startRun(emit);
    craft(
      toJsonLine(
        makeEvent("runtime.heartbeat", {
          eventId: "evt_stale",
          sessionId: stream.sessionId,
          sandboxGeneration: 0,
          runtimeSequence: 7,
        }),
      ),
    );
    emit("message.started");
    emit("message.completed");
  }),

  scenario("sequence-gap", (emit, stream) => {
    startRun(emit);
    emit("message.started", { runtimeSequence: stream.nextRuntimeSequence + 2 });
    emit("message.completed");
  }),

  withCraftedLines("duplicate-event", (emit, craft, stream) => {
    startRun(emit);
    const started = emit("message.started");
    const completed = emit("message.completed");
    craft(toJsonLine(started));
    craft(toJsonLine(completed));
    craft(
      toJsonLine(
        makeEvent("message.started", {
          eventId: "evt_replayed_slot",
          sessionId: stream.sessionId,
          runtimeSequence: started.runtimeSequence,
        }),
      ),
    );
    emit("file.changed");
  }),

  withCraftedLines("wrong-session", (emit, craft, stream) => {
    startRun(emit);
    craft(
      toJsonLine(
        makeEvent("message.started", {
          eventId: "evt_other_session",
          sessionId: "sess_other",
          runtimeSequence: stream.nextRuntimeSequence,
        }),
      ),
    );
    emit("message.started");
  }),

  withCraftedLines("unknown-type", (emit, craft) => {
    startRun(emit);
    craft(mutated(emit("message.started"), { eventId: "evt_unknown", type: "run.exploded" }));
  }),

  withCraftedLines("payload", (emit, craft) => {
    startRun(emit);
    // Accepted first: usage with every optional count, so the checker parses the cache split and `spent`.
    emit("message.started", { payload: { messageId: "msg_split" } });
    emit("message.completed", {
      payload: {
        messageId: "msg_split",
        usage: {
          usedTokens: 10_114,
          maxTokens: 200_000,
          inputTokens: 2,
          outputTokens: 253,
          cachedInputTokens: 9_402,
          cacheWriteTokens: 457,
          reasoningTokens: 0,
          spent: {
            inputTokens: 4,
            outputTokens: 322,
            cachedInputTokens: 9_402,
            cacheWriteTokens: 9_859,
            reasoningTokens: 18,
          },
        },
      },
    });
    const completed = makeEvent("message.completed", {
      eventId: "evt_bad_payload",
      sessionId: SESSION,
      runtimeSequence: 5,
    });
    craft(mutated(completed, { payload: { ...completed.payload, stopReason: "banana" } }));
  }),

  withCraftedLines("wrong-origin", (emit, craft) => {
    startRun(emit);
    craft(
      mutated(
        makeEvent("approval.resolved", { eventId: "evt_self_approval", sessionId: SESSION }),
        {
          runtimeSequence: 3,
        },
      ),
    );
  }),

  withCraftedLines("unsupported-version", (emit, craft) => {
    startRun(emit);
    craft(mutated(emit("message.started"), { eventId: "evt_v2", protocolVersion: 2 }));
  }),
];

mkdirSync(FIXTURES, { recursive: true });
const written = new Set<string>();
for (const { name, build } of scenarios) {
  const file = `${name}.jsonl`;
  const lines = build();
  writeFileSync(`${FIXTURES}${file}`, `${lines.join("\n")}\n`);
  written.add(file);
  console.log(`fixtures/${file}: ${lines.length} lines`);
}
for (const file of readdirSync(FIXTURES)) {
  if (file.endsWith(".jsonl") && !written.has(file) && file !== RECORDED) {
    unlinkSync(`${FIXTURES}${file}`);
    console.log(`fixtures/${file}: removed, no longer generated`);
  }
}
console.log(`${written.size} fixtures written`);
