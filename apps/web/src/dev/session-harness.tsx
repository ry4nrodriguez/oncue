/**
 * Renders the real session screen against a scripted socket so Playwright
 * tests can drive it without Clerk. Events come from `@oncue/protocol`'s
 * builders, so a schema change breaks this harness instead of passing a stale
 * shape. Dev only: served by `vite-plugins/dev-harness.ts`, never built.
 */
import {
  makeCommittedEvent,
  makeEvent,
  testModelRecord,
  testSessionPolicy,
} from "@oncue/protocol/testing";
import { type MutableRefObject, StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { largeReviewFixtureEvents, reviewFixtureEvents } from "../features/diff/review-fixture";
import { subagentFixtureEvents } from "../features/session/agents/agent-fixture";
import { SessionScreen } from "../features/session/SessionScreen";
import type { ModelCatalog } from "../lib/api/setup";
import { ThemeProvider } from "../lib/theme";
import "../styles/globals.css";

type Fixture =
  | "working"
  | "paused"
  | "key-rejected"
  | "key-rejected-stopped"
  | "key-replaced"
  | "disconnected"
  | "approval"
  | "large-log"
  | "not-found"
  | "perf-500"
  | "actions"
  | "review"
  | "review-tree"
  | "review-large"
  | "review-3000"
  | "policy"
  | "agents"
  | "agents-working";

/** The perf test measures first paint against 500 committed events. */
const PERF_COMMITTED_COUNT = 500;
/** ...then counts dropped frames while this many transient deltas stream. */
export const PERF_DELTA_COUNT = 200;
/** The review panel perf test measures a 3,000-line diff. */
const REVIEW_PERF_LINES = 3_000;

/**
 * The fixture behind `e2e/session-actions.spec.ts`. The sandbox lifecycle is
 * advanced by a button, not a timer, because the test checks that the row
 * updates in place and a timer would race its first assertion.
 */
function actionsFixture() {
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return sequence;
  };
  const clone = "tool_clone";
  const denied = "tool_denied";
  const tests = "tool_tests";

  const frames: unknown[] = [
    { type: "replay_batch", through: 0, events: [] },
    makeCommittedEvent("run.queued", {}, { sessionSequence: next() }),
    makeCommittedEvent("run.started", {}, { sessionSequence: next() }),
    makeCommittedEvent(
      "sandbox.provisioning",
      {
        eventId: "evt_prov",
        payload: {
          provider: "modal",
          reason: "initial",
          attempt: 1,
          cacheReuse: "repository_environment",
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.requested",
      {
        eventId: "evt_clone",
        payload: {
          toolCallId: clone,
          category: "git_remote",
          title: "Cloning acme/oncue",
          runtimeName: "git",
          input: { repository: "acme/oncue", depth: 1 },
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.started",
      { eventId: "evt_clone_start", payload: { toolCallId: clone } },
      { sessionSequence: next() },
    ),
    // Ephemeral, so it must arrive before the call settles: a completed call ignores late output.
    makeEvent("tool.output", {
      eventId: "evt_clone_out0",
      payload: { toolCallId: clone, chunkIndex: 0, text: "Cloning into 'oncue'...\n" },
    }),
    makeEvent("tool.output", {
      eventId: "evt_clone_out1",
      payload: { toolCallId: clone, chunkIndex: 1, text: "Resolving deltas: 100% (812/812)\n" },
    }),
    makeCommittedEvent(
      "tool.completed",
      {
        eventId: "evt_clone_done",
        payload: {
          toolCallId: clone,
          durationMs: 4200,
          exitCode: 0,
          result: { kind: "inline", summary: "Cloned at 9f2c1ab.", value: { commits: 812 } },
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.requested",
      {
        eventId: "evt_denied",
        payload: {
          toolCallId: denied,
          category: "shell",
          title: "Install the vendor toolchain",
          runtimeName: "bash",
          input: { command: "curl -sL https://example.test/install.sh | sh" },
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.failed",
      {
        eventId: "evt_denied_failed",
        payload: {
          toolCallId: denied,
          durationMs: 40,
          exitCode: null,
          errorText: "The session policy does not allow piping a downloaded script into a shell.",
          category: "denied_by_policy",
          evidence: [],
        },
      },
      { sessionSequence: next() },
    ),
    // Shaped as the real bridge reports a shell call: no `tool.output`, the
    // printed text only in `result.value.output`.
    makeCommittedEvent(
      "tool.requested",
      {
        eventId: "evt_tests",
        payload: {
          toolCallId: tests,
          category: "shell",
          title: "pnpm test",
          runtimeName: "bash",
          input: { command: "pnpm test" },
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.started",
      { eventId: "evt_tests_start", payload: { toolCallId: tests } },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "tool.completed",
      {
        eventId: "evt_tests_done",
        payload: {
          toolCallId: tests,
          durationMs: 2300,
          exitCode: 0,
          result: {
            kind: "inline",
            summary: "pnpm test",
            value: {
              output:
                " ✓ src/app.test.ts (3 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n",
            },
          },
        },
      },
      { sessionSequence: next() },
    ),
    // Startup output already on record when the screen opens; the lifecycle stages follow.
    makeCommittedEvent(
      "sandbox.output",
      {
        eventId: "evt_out_controller",
        payload: {
          stream: "controller",
          lines: [
            { at: "2026-09-02T10:00:01.000Z", text: "create answered in 412 ms" },
            { at: "2026-09-02T10:00:01.000Z", text: "start answered in 308 ms" },
          ],
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "sandbox.output",
      {
        eventId: "evt_out_stdout",
        payload: {
          stream: "stdout",
          lines: [{ at: "2026-09-02T10:00:02.000Z", text: "bridge dialing the control plane" }],
        },
      },
      { sessionSequence: next() },
    ),
    { type: "caught_up", through: sequence },
  ];

  const stages: unknown[] = [
    makeCommittedEvent(
      "sandbox.attached",
      {
        eventId: "evt_attached",
        payload: { provider: "modal", providerSandboxId: "sb-oncue-1", startupMs: 2400 },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent("runtime.connected", { eventId: "evt_conn" }, { sessionSequence: next() }),
    makeCommittedEvent("runtime.ready", { eventId: "evt_ready" }, { sessionSequence: next() }),
    // Generation 1 is replaced while RUNNING (record 04 allows it), so
    // `sandbox.replaced` is the only event that can settle the row.
    makeCommittedEvent(
      "sandbox.replaced",
      {
        eventId: "evt_replaced",
        sandboxGeneration: 2,
        payload: {
          previousGeneration: 1,
          reason: "lifetime_ceiling",
          restoredFrom: "ckpt_1",
          explanation: "The sandbox reached its 24 hour ceiling.",
        },
      },
      { sessionSequence: next() },
    ),
    makeCommittedEvent(
      "sandbox.stopped",
      {
        eventId: "evt_stopped",
        sandboxGeneration: 2,
        payload: {
          outcome: "stopped",
          reason: "user_requested",
          checkpointId: "ckpt_1",
          unsavedWorkWarning: null,
          diagnostics: [],
        },
      },
      { sessionSequence: next() },
    ),
  ];

  return { frames, stages };
}

function scriptFor(fixture: Fixture) {
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return sequence;
  };

  if (fixture === "perf-500") {
    // Distinct ids per event, or the fold would collapse 500 events into one row.
    const events = Array.from({ length: PERF_COMMITTED_COUNT }, (_, index) =>
      index % 2 === 0
        ? makeCommittedEvent(
            "message.completed",
            { eventId: `evt_m${index}`, payload: { messageId: `msg_${index}` } },
            { sessionSequence: next() },
          )
        : makeCommittedEvent(
            "tool.completed",
            { eventId: `evt_t${index}`, payload: { toolCallId: `tool_${index}` } },
            { sessionSequence: next() },
          ),
    );
    return [
      { type: "replay_batch", through: sequence, events },
      { type: "caught_up", through: sequence },
    ];
  }

  if (fixture === "actions") {
    return actionsFixture().frames;
  }

  if (fixture === "agents" || fixture === "agents-working") {
    // Three subagents: one running a command, one that reported, one that failed.
    // Started half a minute ago, so the running one shows a live duration.
    // `agents-working` adds a command of the primary agent's own, still running.
    const events = subagentFixtureEvents(new Date(Date.now() - 30_000).toISOString(), {
      primaryWorking: fixture === "agents-working",
    });
    return [
      { type: "replay_batch", through: events.length, events },
      { type: "caught_up", through: events.length },
    ];
  }

  if (fixture === "review-3000") {
    // A turn diff of exactly as many lines as the panel draws, for the perf test.
    const events = largeReviewFixtureEvents(REVIEW_PERF_LINES);
    return [
      { type: "replay_batch", through: events.length, events },
      { type: "caught_up", through: events.length },
    ];
  }

  if (fixture === "policy") {
    // Policy rows without a sandbox: an applied restriction, the draft pull
    // request, and a pending proposal. Used by the accessibility test.
    const pushing = testSessionPolicy({
      version: 2,
      push: "auto",
      pullRequest: "auto_after_verification",
    });
    const stopped = testSessionPolicy({ version: 3, push: "never", pullRequest: "never" });
    const events = [
      makeCommittedEvent("run.queued", {}, { sessionSequence: next() }),
      makeCommittedEvent("run.started", {}, { sessionSequence: next() }),
      makeCommittedEvent("message.completed", {}, { sessionSequence: next() }),
      makeCommittedEvent(
        "policy.updated",
        {
          eventId: "evt_policy_confirmed",
          payload: {
            proposalId: "prop_confirmed",
            from: testSessionPolicy(),
            to: pushing,
            confirmedBy: "user_confirmation",
            userId: "user_1",
            effectiveAt: "2026-09-20T00:00:00.000Z",
          },
        },
        { sessionSequence: next() },
      ),
      makeCommittedEvent("pull_request.created", {}, { sessionSequence: next() }),
      makeCommittedEvent(
        "policy.updated",
        {
          eventId: "evt_policy_narrowed",
          payload: {
            proposalId: "prop_narrowed",
            from: pushing,
            to: stopped,
            confirmedBy: "immediate_narrowing",
            userId: null,
            effectiveAt: "2026-09-20T00:01:00.000Z",
          },
        },
        { sessionSequence: next() },
      ),
      makeCommittedEvent(
        "policy.proposed",
        {
          eventId: "evt_policy_pending",
          payload: {
            proposalId: "prop_pending",
            triggeringMessageId: null,
            from: stopped,
            to: { ...pushing, version: 4 },
            direction: "widening",
            rationale: "The user asked to push this and open a draft pull request.",
          },
        },
        { sessionSequence: next() },
      ),
    ];
    return [
      { type: "replay_batch", through: events.length, events },
      { type: "caught_up", through: events.length },
    ];
  }

  if (fixture === "review" || fixture === "review-large" || fixture === "review-tree") {
    // Two turns that changed files and ran checks, for looking at the change
    // cards, the review panel, and the Tests view without a sandbox.
    // `review-tree` names a repository listing the harness cannot serve, so
    // the tree says the listing failed.
    const events = reviewFixtureEvents({
      sessionDiffAsArtifact: fixture === "review-large",
      sessionTree: fixture === "review-tree",
    });
    return [
      { type: "replay_batch", through: events.length, events },
      { type: "caught_up", through: events.length },
    ];
  }

  const base: unknown[] = [
    { type: "replay_batch", through: 0, events: [] },
    makeCommittedEvent("run.queued", {}, { sessionSequence: next() }),
    makeCommittedEvent("run.started", {}, { sessionSequence: next() }),
    makeCommittedEvent("message.started", {}, { sessionSequence: next() }),
    makeCommittedEvent(
      "message.completed",
      { payload: { usage: HARNESS_USAGE } },
      { sessionSequence: next() },
    ),
    makeCommittedEvent("tool.requested", {}, { sessionSequence: next() }),
    makeCommittedEvent("tool.completed", {}, { sessionSequence: next() }),
    { type: "caught_up", through: sequence },
  ];

  if (fixture === "approval") {
    // Approval rows without a sandbox: one denied request and one pending.
    const asked = (approvalId: string, name: string) =>
      makeCommittedEvent(
        "approval.requested",
        {
          eventId: `evt_${approvalId}_asked`,
          payload: {
            approvalId,
            title: `Supply ${name}`,
            intendedAction: `Give this session the saved development secret ${name}. The repository's code can read it, and the model provider may see it.`,
            category: "development_secret",
            risk: "medium",
            resource: name,
            requestedScope: "This session's sandbox (generation 1), until it stops",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            toolCallId: null,
          },
        },
        { sessionSequence: next() },
      );
    base.splice(
      -1,
      0,
      asked("apr_denied", "SENTRY_DSN"),
      makeCommittedEvent(
        "approval.resolved",
        {
          eventId: "evt_apr_denied_resolved",
          payload: { approvalId: "apr_denied", decision: "rejected" },
        },
        { sessionSequence: next() },
      ),
      asked("apr_open", "STRIPE_TEST_KEY"),
    );
    base[base.length - 1] = { type: "caught_up", through: sequence };
  }

  if (fixture === "paused") {
    // A run paused on a model failure while its sandbox is still up: the
    // composer offers no send (the object would refuse one) and says why.
    base.splice(
      -1,
      0,
      makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: next() }),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: {
              category: "model_unavailable",
              message: "The model is not available.",
              retries: 0,
            },
          },
        },
        { sessionSequence: next() },
      ),
    );
    base[base.length - 1] = { type: "caught_up", through: sequence };
  }

  if (isKeyFixture(fixture)) {
    // A run paused because the provider rejected its key (record 15), in the
    // three states the screen must read correctly: the sandbox still up, the
    // sandbox stopped with the key still invalid, and stopped with the key
    // replaced. The harness passes the key's state to match (`keyRejected`).
    base.splice(
      -1,
      0,
      ...(fixture === "key-rejected"
        ? [makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: next() })]
        : []),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            detail: "Model request failed: authentication_failed",
            modelFailure: {
              category: "authentication_failed",
              // As the bridge writes it; the screen shows the category's words instead.
              message: "broker answered 403: The provider rejected this connection's credential.",
              retries: 0,
            },
            checkpointId: null,
          },
        },
        { sessionSequence: next() },
      ),
    );
    base[base.length - 1] = { type: "caught_up", through: sequence };
  }

  if (fixture === "large-log") {
    base.splice(-1, 0, makeCommittedEvent("artifact.created", {}, { sessionSequence: next() }));
    base[base.length - 1] = { type: "caught_up", through: sequence };
  }

  return base;
}

/**
 * One transient delta per animation frame, so the perf test's dropped-frame
 * count measures render cost rather than this loop's pacing. The test waits
 * on `data-perf-streaming="done"`.
 */
function streamDeltas(socket: WebSocket & { onmessage: ((event: MessageEvent) => void) | null }) {
  let sent = 0;
  document.body.dataset.perfStreaming = "running";
  const pump = () => {
    if (sent >= PERF_DELTA_COUNT) {
      document.body.dataset.perfStreaming = "done";
      return;
    }
    sent += 1;
    socket.onmessage?.({ data: JSON.stringify(makeEvent("message.delta")) } as MessageEvent);
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
}

type Push = (frame: unknown) => void;

declare global {
  interface Window {
    /** Every command frame the screen wrote, for the e2e lanes to count. */
    __oncueSent?: unknown[];
  }
}

/**
 * A socket that replays a fixture instead of talking to the control plane. It
 * opens like a real one and records what is written to it; nothing answers.
 * `disconnected` replays once and then drops every socket, so the screen
 * stays reconnecting.
 */
function scriptedSocket(fixture: Fixture, pushRef: MutableRefObject<Push | null>) {
  let replayed = false;
  return (url: string): WebSocket => {
    const socket = {
      url,
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        window.__oncueSent = [...(window.__oncueSent ?? []), JSON.parse(data)];
      },
      close() {
        socket.readyState = WebSocket.CLOSED;
      },
    } as unknown as WebSocket & {
      readyState: number;
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
    };

    pushRef.current = (frame) => {
      socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
    };

    queueMicrotask(() => {
      // A socket the screen already replaced (StrictMode runs effects twice)
      // has its handlers detached; it neither replays nor counts.
      if (socket.onopen === null && socket.onclose === null) {
        return;
      }
      if (fixture === "not-found") {
        socket.readyState = WebSocket.OPEN;
        socket.onopen?.();
        socket.readyState = WebSocket.CLOSED;
        socket.onclose?.({ code: 4403 } as CloseEvent);
        return;
      }
      if (fixture === "disconnected" && replayed) {
        socket.readyState = WebSocket.CLOSED;
        socket.onclose?.({ code: 1006 } as CloseEvent);
        return;
      }
      socket.readyState = WebSocket.OPEN;
      socket.onopen?.();
      replayed = true;
      for (const frame of scriptFor(fixture)) {
        socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
      if (fixture === "working") {
        // A transient delta after catch-up, so streaming is visible.
        socket.onmessage?.({ data: JSON.stringify(makeEvent("message.delta")) } as MessageEvent);
      }
      if (fixture === "perf-500") {
        streamDeltas(socket);
      }
      if (fixture === "disconnected") {
        socket.readyState = WebSocket.CLOSED;
        socket.onclose?.({ code: 1006 } as CloseEvent);
      }
    });

    return socket;
  };
}

type KeyFixture = "key-rejected" | "key-rejected-stopped" | "key-replaced";

function isKeyFixture(fixture: Fixture): fixture is KeyFixture {
  return (
    fixture === "key-rejected" || fixture === "key-rejected-stopped" || fixture === "key-replaced"
  );
}

/** A third of the window, most of it read from the prompt cache, as a real answer reports it. */
const HARNESS_USAGE = {
  usedTokens: 66_412,
  maxTokens: 200_000,
  inputTokens: 6,
  outputTokens: 812,
  cachedInputTokens: 61_204,
  cacheWriteTokens: 4_390,
  reasoningTokens: 0,
  prompt: { systemTokens: 9_402, toolsTokens: 14_210, oncueToolsTokens: 1_874 },
  compactsAtTokens: 168_000,
};

/** The fixture run's model with its list prices, so the gauge's popover shows an estimate. */
const HARNESS_CATALOG: ModelCatalog = {
  anthropic: [
    {
      modelId: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200_000,
      effort: null,
      defaultEffort: null,
      price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
      status: "legacy",
      recommended: false,
    },
  ],
  openai: [],
};

/** The fixture run's own connection and harness, so the composer names them as a session does. */
const HARNESS_CONNECTIONS = [
  {
    modelConnectionId: testModelRecord().modelConnectionId,
    label: "anthropic ...0a1b",
    provider: "anthropic",
    modelId: testModelRecord().modelId,
    models: HARNESS_CATALOG.anthropic,
  },
] as const;
/** The run's key as the workspace holds it after the provider rejected it. */
const HARNESS_REJECTED_KEY = [
  {
    modelConnectionId: testModelRecord().modelConnectionId,
    provider: "anthropic",
    status: "invalid",
    activeSessions: 1,
  },
] as const;

const HARNESS_RUNTIMES = [
  {
    id: "opencode",
    name: "OpenCode",
    providers: ["anthropic", "openai"],
    images: true,
    holdsToolCalls: true,
  },
] as const;

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const fixture = (params.get("fixture") ?? "working") as Fixture;
  const pushRef = useRef<Push | null>(null);
  const createSocket = useMemo(() => scriptedSocket(fixture, pushRef), [fixture]);
  const stages = useMemo(() => (fixture === "actions" ? actionsFixture().stages : []), [fixture]);
  const [stage, setStage] = useState(0);
  const nextStage = stages[stage];
  const keyRejected = fixture === "key-rejected" || fixture === "key-rejected-stopped";

  // SessionNotFound links home, so even the harness needs a router context.
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          {
            path: "/",
            element: (
              <div className="flex h-screen w-full flex-col bg-canvas text-text">
                {nextStage === undefined ? null : (
                  <div className="shrink-0 border-border-soft border-b px-6 py-2">
                    <button
                      type="button"
                      data-testid="advance-sandbox"
                      className="rounded-md border border-border px-2 py-1 text-[12px] text-text"
                      onClick={() => {
                        pushRef.current?.(nextStage);
                        setStage((current) => current + 1);
                      }}
                    >
                      Advance the sandbox lifecycle
                    </button>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <SessionScreen
                    sessionId="sess_harness"
                    createSocket={createSocket}
                    catalog={HARNESS_CATALOG}
                    // A rejected key leaves the active list until it is replaced.
                    modelConnections={keyRejected ? [] : HARNESS_CONNECTIONS}
                    inactiveModelConnections={keyRejected ? HARNESS_REJECTED_KEY : undefined}
                    runtimes={HARNESS_RUNTIMES}
                    // The fixtures show the session details, which the lanes read.
                    railPinnedAtStart
                    // The composer's own send path, held while disconnected, is
                    // what the `disconnected` fixture is for.
                    {...(fixture === "disconnected" ? {} : { onSubmit: () => true })}
                    // No control plane here; the test drives the dialog's own path.
                    onStopSandbox={async () => ({ ok: true })}
                    onKeepSandboxAlive={async () => ({
                      ok: true,
                      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
                    })}
                  />
                </div>
              </div>
            ),
          },
        ],
        { initialEntries: ["/"] },
      ),
    [createSocket, nextStage, fixture, keyRejected],
  );

  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
