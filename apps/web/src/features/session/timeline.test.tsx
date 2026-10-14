import {
  applyLiveEvent,
  emptyView,
  foldEvents,
  type ModelFailureCategory,
  type RunId,
  type SessionView,
  type TimelineItem,
  type ToolView,
} from "@oncue/protocol";
import {
  makeCommittedEvent,
  makeEvent,
  testArtifactRef,
  testModelRecord,
} from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewFixtureEvents } from "@/features/diff/review-fixture";
import { describeActivity } from "./ActivityGroup";
import { artifactFileName, NON_FAST_FORWARD_HINT, Timeline, TimelineRow } from "./Timeline";

afterEach(cleanup);

// `Timeline` composes use-stick-to-bottom, which needs ResizeObserver; jsdom has none.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function renderRow(view: SessionView, item: TimelineItem) {
  render(<TimelineRow view={view} item={item} />);
}

// A real fold, so the message and tool renderers are exercised against the
// shapes the protocol actually produces rather than hand-built stand-ins.
function foldedView() {
  return foldEvents([
    makeCommittedEvent("message.started", {}, { sessionSequence: 1 }),
    makeCommittedEvent("message.completed", {}, { sessionSequence: 2 }),
    makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
    // `tool.started` is what makes the row read "running" -- a call whose
    // arguments are complete but which has not started yet is still
    // "waiting to start", never "running".
    makeCommittedEvent("tool.started", {}, { sessionSequence: 4 }),
  ]);
}

describe("timeline renderers", () => {
  it("renders a message at full weight", () => {
    const view = foldedView();
    const item = view.timeline.find((entry) => entry.kind === "message");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }

    renderRow(view, item);

    expect(screen.getByTestId(/row-message/)).toBeTruthy();
  });

  it("renders a tool call as an expandable row naming its own state", () => {
    const view = foldedView();
    const item = view.timeline.find((entry) => entry.kind === "tool");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }

    renderRow(view, item);

    expect(screen.getByTestId("row-tool")).toBeTruthy();
    // A button with an accessible name and expanded state; the real click is
    // covered by `e2e/session-actions.spec.ts`.
    const trigger = screen.getByRole("button", {
      name: /Run the unit tests, running/,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("distinguishes a policy denial from a timeout without expanding", () => {
    const denied = foldEvents([
      makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "tool.failed",
        { payload: { category: "denied_by_policy" } },
        { sessionSequence: 2 },
      ),
    ]);
    const timedOut = foldEvents([
      makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "tool.failed",
        { payload: { category: "timeout" } },
        { sessionSequence: 2 },
      ),
    ]);

    const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };
    renderRow(denied, item);
    expect(screen.getByTestId("action-failure").textContent).toBe("Denied by policy");
    cleanup();

    renderRow(timedOut, item);
    expect(screen.getByTestId("action-failure").textContent).toBe("Timed out");
  });

  // A declined call has no `tool.failed`, so the row reads the approval.
  it("says a declined call was declined rather than showing a bare red dot", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "approval.requested",
        { payload: { approvalId: "apr_1", toolCallId: "tool_1" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.requested",
        { payload: { approvalId: "apr_1" } },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent(
        "approval.resolved",
        { payload: { approvalId: "apr_1", decision: "rejected" } },
        { sessionSequence: 3 },
      ),
    ]);
    const item: TimelineItem = { sequence: 2, kind: "tool", toolCallId: "tool_1" as never };

    renderRow(view, item);

    expect(screen.getByTestId("action-failure").textContent).toBe("You declined this");
    expect(screen.getByRole("button", { name: /You declined this/ })).toBeTruthy();
  });

  it("says an expired approval expired rather than failed", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "approval.requested",
        { payload: { approvalId: "apr_1", toolCallId: "tool_1" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.requested",
        { payload: { approvalId: "apr_1" } },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent(
        "approval.expired",
        { payload: { approvalId: "apr_1" } },
        { sessionSequence: 3 },
      ),
    ]);
    const item: TimelineItem = { sequence: 2, kind: "tool", toolCallId: "tool_1" as never };

    renderRow(view, item);

    expect(screen.getByTestId("action-failure").textContent).toBe("Approval expired");
  });

  // A call that printed nothing has not lost its output.
  it("draws no output section for a call that printed nothing", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "tool.requested",
        { payload: { category: "file_write" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent("tool.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("tool.completed", {}, { sessionSequence: 3 }),
    ]);
    const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };

    renderRow(view, item);
    fireEvent.click(screen.getByRole("button"));

    const panel = screen.getByTestId("action-panel");
    expect(panel.textContent).not.toContain("no longer available");
    expect(panel.textContent).not.toContain("Output");
  });

  // The shimmer restarts if its element is replaced. Streamed events re-render
  // the whole timeline, so the running call's group and row must keep their
  // elements through them.
  it("keeps the running call's shimmering headline element through streamed events", () => {
    const events = [
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
      makeCommittedEvent("tool.started", {}, { sessionSequence: 4 }),
    ];
    const view = foldEvents(events);
    const { rerender } = render(<Timeline view={view} sessionId="sess_1" />);
    const headline = () =>
      screen.getByTestId("activity-trigger").querySelector(".shimmer") as HTMLElement;
    const before = headline();
    expect(before).not.toBeNull();

    const streamed = applyLiveEvent(
      applyLiveEvent(view, makeEvent("tool.output", { payload: { text: "compiling\n" } })),
      makeEvent("tool.output", { payload: { chunkIndex: 1, text: "linking\n" } }),
    );
    rerender(<Timeline view={streamed} sessionId="sess_1" />);
    expect(headline()).toBe(before);
  });

  /**
   * The bridge sends a call's output in `tool.completed`'s `result.value.output`,
   * and the result's summary is the call's own title.
   */
  describe("a settled call's output", () => {
    const TITLE = "cat /var/lib/oncue/secrets/STRIPE_TEST_KEY";
    function bridgeShaped(value: Record<string, unknown>, extra: unknown[] = []) {
      return foldEvents([
        makeCommittedEvent("tool.requested", { payload: { title: TITLE } }, { sessionSequence: 1 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 2 }),
        ...(extra as never[]),
        makeCommittedEvent(
          "tool.completed",
          { payload: { result: { kind: "inline", summary: TITLE, value } } },
          { sessionSequence: 3 },
        ),
      ]);
    }
    const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };

    it("shows what the command printed, not the command again", () => {
      renderRow(bridgeShaped({ output: "[REDACTED]\nline two\n" }), item);
      fireEvent.click(screen.getByRole("button"));

      const output = screen.getByTestId("action-output");
      expect(output.textContent).toContain("[REDACTED]");
      expect(output.textContent).toContain("line two");
      const panel = screen.getByTestId("action-panel");
      // The title is the row's label; it is not repeated as a "Result".
      expect(panel.textContent).not.toContain("Result");
      expect(within(panel).queryByText(TITLE)).toBeNull();
      expect(panel.textContent).not.toContain("no longer available");
    });

    it("prefers the durable result over a tail, and does not claim the tail's loss", () => {
      // A reconnect mid-call marks the tail dropped; the result that lands
      // afterwards carries the whole of it, so nothing is missing any more.
      const view = foldEvents([
        makeCommittedEvent("tool.requested", { payload: { title: TITLE } }, { sessionSequence: 1 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 2 }),
      ]);
      const withTail = applyLiveEvent(
        view,
        makeEvent("tool.output", { payload: { chunkIndex: 3, text: "late chunk\n" } }),
      );
      const settled = foldEvents(
        [
          makeCommittedEvent(
            "tool.completed",
            {
              payload: {
                result: { kind: "inline", summary: TITLE, value: { output: "whole output\n" } },
              },
            },
            { sessionSequence: 3 },
          ),
        ],
        withTail,
      );
      renderRow(settled, item);
      fireEvent.click(screen.getByRole("button"));

      const output = screen.getByTestId("action-output");
      expect(output.textContent).toContain("whole output");
      expect(output.textContent).not.toContain("late chunk");
      expect(screen.getByTestId("action-panel").textContent).not.toContain("no longer available");
    });

    it("says how much the sandbox cut when the output was too long to keep", () => {
      renderRow(
        bridgeShaped({ output: "start of it", truncated: true, droppedChars: 20480 }),
        item,
      );
      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByTestId("action-output").textContent).toContain("start of it");
      expect(screen.getByTestId("action-output-cut").textContent).toContain("20,480 characters");
    });

    it("draws no output section when the command printed nothing", () => {
      renderRow(bridgeShaped({ output: "" }), item);
      fireEvent.click(screen.getByRole("button"));

      expect(screen.queryByTestId("action-output")).toBeNull();
      expect(screen.getByTestId("action-panel").textContent).not.toContain("Output");
    });

    it("keeps a summary that says something the label does not, when there is no output", () => {
      // The protocol's default result: "1 test passed." with counts, no output.
      renderRow(
        foldEvents([
          makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 }),
          makeCommittedEvent("tool.completed", {}, { sessionSequence: 2 }),
        ]),
        item,
      );
      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByTestId("action-panel").textContent).toContain("Result");
      expect(screen.getByTestId("action-panel").textContent).toContain("1 test passed.");
    });

    it("drops a summary that only repeats the label", () => {
      renderRow(bridgeShaped({ commits: 812 }), item);
      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByTestId("action-panel").textContent).not.toContain("Result");
    });
  });

  it("renders a sandbox generation as the same row, labelled from event data", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "sandbox.provisioning",
        { payload: { provider: "modal", reason: "replacement", attempt: 2 } },
        { sessionSequence: 1 },
      ),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "sandbox");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }

    renderRow(view, item);

    expect(screen.getByTestId("row-sandbox")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Starting a replacement sandbox, running/ }),
    ).toBeTruthy();
  });

  it("carries the sandbox's own duration and prose into the panel", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal", startupMs: 2400 } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.stopped",
        {
          payload: {
            outcome: "failed",
            reason: "failure",
            checkpointId: null,
            unsavedWorkWarning: "Uncommitted edits were lost.",
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "sandbox");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }

    renderRow(view, item);
    fireEvent.click(screen.getByRole("button"));

    const panel = screen.getByTestId("action-panel");
    // The sequence, both steps, with the second's offset from the first.
    const steps = [...screen.getByTestId("action-steps").querySelectorAll("li")].map(
      (item) => item.textContent,
    );
    expect(steps).toEqual([
      "Sandbox running · sb_10s",
      "Sandbox stopped after a failure · no checkpoint saved+0s",
    ]);
    // How long it ran, frozen: the fixture's two events share one instant.
    expect(panel.textContent).toContain("Ran for");
    expect(panel.textContent).toContain("Uncommitted edits were lost.");
    expect(panel.textContent).toContain("sb_1");
    // No provider fact, no generation fact: the mark says Modal already, and a
    // number a reader cannot act on is noise.
    expect(panel.textContent).not.toContain("Provider");
    expect(panel.textContent).not.toContain("Generation");
    expect(screen.getByTestId("row-sandbox").getAttribute("data-state-kind")).toBe("failed");
  });

  it("shows what the sandbox printed under the row, tagged by stream", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal", providerSandboxId: "sb_1" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.output",
        {
          payload: {
            stream: "stderr",
            lines: [
              { at: "2026-09-02T00:00:01.000Z", text: "bridge could not reach the control plane" },
            ],
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "sandbox");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }
    renderRow(view, item);
    fireEvent.click(screen.getByRole("button"));

    const output = screen.getByTestId("action-output");
    expect(output.textContent).toContain("stderrbridge could not reach the control plane");
    // Output never moves the row: still running, still labelled by the last
    // lifecycle event.
    expect(screen.getByTestId("row-sandbox").getAttribute("data-state-kind")).toBe("running");
  });

  // The sandbox row's label names the event, not the outcome, so failure needs words beside it.
  it("says a failed sandbox failed without needing the row expanded", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "sandbox.stopped",
        { payload: { outcome: "failed", reason: "idle", checkpointId: null } },
        { sessionSequence: 1 },
      ),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "sandbox");
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }

    renderRow(view, item);

    expect(screen.getByTestId("action-failure").textContent).toBe("The sandbox failed");
    expect(screen.getByRole("button", { name: /The sandbox failed/ })).toBeTruthy();
  });

  it("says a lost runtime was lost, and stays quiet on a row that did not fail", () => {
    const lost = foldEvents([
      makeCommittedEvent(
        "runtime.disconnected",
        { payload: { reason: "connection_lost", expectReconnect: false } },
        { sessionSequence: 1 },
      ),
    ]);
    const item: TimelineItem = { sequence: 1, kind: "sandbox", generation: 1 };

    renderRow(lost, item);
    expect(screen.getByTestId("action-failure").textContent).toBe("Lost the agent runtime");
    cleanup();

    const running = foldEvents([
      makeCommittedEvent(
        "sandbox.provisioning",
        { payload: { provider: "modal" } },
        { sessionSequence: 1 },
      ),
    ]);
    renderRow(running, item);
    expect(screen.queryByTestId("action-failure")).toBeNull();
  });

  // For a sandbox, running is the steady state; start-up is the transition.
  it("shimmers the sandbox row from the request until the runtime is ready, not once it runs", () => {
    const item: TimelineItem = { sequence: 1, kind: "sandbox", generation: 1 };
    const starting = foldEvents([
      makeCommittedEvent(
        "sandbox.provisioning",
        { payload: { provider: "modal" } },
        { sessionSequence: 1 },
      ),
    ]);
    renderRow(starting, item);
    expect(screen.getByTestId("row-sandbox").querySelector(".shimmer")).toBeTruthy();
    cleanup();

    const running = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal", providerSandboxId: "sb_1" } },
        { sessionSequence: 1 },
      ),
    ]);
    // The container is up but OpenCode has not answered: still in transition.
    renderRow(running, item);
    expect(screen.getByTestId("row-sandbox").getAttribute("data-state-kind")).toBe("running");
    expect(screen.getByTestId("row-sandbox").querySelector(".shimmer")).toBeTruthy();
    cleanup();

    const ready = foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal", providerSandboxId: "sb_1" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent("runtime.ready", {}, { sessionSequence: 2 }),
    ]);
    renderRow(ready, item);
    const row = screen.getByTestId("row-sandbox");
    expect(row.getAttribute("data-state-kind")).toBe("running");
    expect(row.querySelector(".shimmer")).toBeNull();
  });

  it("describes a settled group by what its calls did", () => {
    const tool = (id: string, category: string, failed = false) =>
      ({
        toolCallId: id,
        category,
        failure: failed ? { category: "timeout", message: "x" } : null,
      }) as unknown as ToolView;
    expect(describeActivity([], 1)).toBe("1 action");
    expect(describeActivity([tool("a", "shell")], 2)).toBe("Ran 1 command");
    expect(
      describeActivity(
        [
          tool("a", "file_read"),
          tool("b", "shell", true),
          tool("c", "file_read"),
          tool("d", "file_write"),
          tool("e", "git_local"),
        ],
        6,
      ),
    ).toBe("Read 2 files, ran 2 commands, edited 1 file (1 failed)");
  });

  it("renders a progress step", () => {
    renderRow(emptyView(), { sequence: 1, kind: "progress", stepId: "clone" } as TimelineItem);
    expect(screen.getByTestId("row-progress")).toBeTruthy();
  });

  it("renders a plan change", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "plan",
      planId: "plan_1",
      change: "created",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-plan")).toBeTruthy();
  });

  it("renders nothing for an approval the view does not hold", () => {
    // The card and its settled lines are covered in `approval-card.test.tsx`.
    renderRow(emptyView(), {
      sequence: 1,
      kind: "approval",
      approvalId: "apr_1",
      change: "requested",
    } as unknown as TimelineItem);
    expect(document.body.textContent).toBe("");
  });

  it("renders a verification check", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "check",
      checkId: "chk_1",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-check")).toBeTruthy();
  });

  it("reads a check as name, state, and time, with a colour only for a failure", () => {
    const view = foldEvents(reviewFixtureEvents());
    const expected: [string, string, boolean][] = [
      ["chk_test_1", "passed", false],
      ["chk_lint_1", "failed", true],
      ["chk_typecheck_2", "skipped", false],
    ];
    for (const [checkId, word, coloured] of expected) {
      renderRow(view, { sequence: 1, kind: "check", checkId } as unknown as TimelineItem);
      const row = screen.getByTestId("row-check");
      expect(row.getAttribute("data-state")).toBe(word);
      const state = screen.getByText(word);
      expect(state.className.includes("text-danger")).toBe(coloured);
      expect(state.className).not.toContain("text-positive");
      // No status icon: the words carry it. The only svg is a chevron, and
      // only where there is output to open.
      for (const svg of row.querySelectorAll("svg")) {
        expect(svg.getAttribute("class")).toContain("lucide-chevron-down");
      }
      cleanup();
    }

    // The output opens under the row.
    renderRow(view, {
      sequence: 1,
      kind: "check",
      checkId: "chk_test_1",
    } as unknown as TimelineItem);
    expect(screen.queryByTestId("check-summary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "test, passed" }));
    expect(screen.getByTestId("check-summary").textContent).toContain("ok 1");
    cleanup();

    const inconclusive = foldEvents([
      makeCommittedEvent("verification.started", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "verification.result",
        { payload: { result: "inconclusive", inconclusiveReason: "timeout" } },
        { sessionSequence: 2 },
      ),
    ]);
    renderRow(inconclusive, { sequence: 1, kind: "check", checkId: "chk_1" } as TimelineItem);
    expect(screen.getByText("inconclusive").className).not.toContain("text-caution");
    cleanup();

    // A row drawn before its check has folded reads as running, by its id.
    renderRow(emptyView(), { sequence: 1, kind: "check", checkId: "chk_x" } as TimelineItem);
    expect(screen.getByTestId("row-check").textContent).toBe("chk_x·running");
  });

  it("shows not finished, not running, for a check its cancelled run never got a result for", () => {
    const cancelled = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
      makeCommittedEvent("run.cancelled", {}, { sessionSequence: 4 }),
    ]);
    renderRow(cancelled, {
      sequence: 1,
      kind: "check",
      checkId: "chk_1",
    } as unknown as TimelineItem);
    const row = screen.getByTestId("row-check");
    expect(row.getAttribute("data-state")).toBe("not_finished");
    expect(row.textContent).toBe("unit tests·not finished");
    cleanup();

    const active = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
    ]);
    renderRow(active, { sequence: 1, kind: "check", checkId: "chk_1" } as unknown as TimelineItem);
    expect(screen.getByTestId("row-check").getAttribute("data-state")).toBe("running");
  });

  it("puts a check's log behind a Full output link instead of its own artifact rows", async () => {
    const view = foldEvents(reviewFixtureEvents());
    render(<Timeline view={view} sessionId="sess_1" />);
    // Both runs have ended, so their work is folded; open the folds to reach
    // the links inside them by role.
    for (const trigger of screen.getAllByTestId("activity-trigger")) {
      fireEvent.click(trigger);
    }
    // The fixture uploads four check logs; none gets a row of its own.
    expect(screen.queryAllByTestId("row-artifact")).toHaveLength(0);
    const rows = screen.getAllByTestId("row-check");
    expect(rows).toHaveLength(5);
    const lint = rows.find((row) => row.textContent?.startsWith("lint")) as HTMLElement;
    // A check with no uploaded evidence has no link.
    const skipped = rows.find((row) => row.getAttribute("data-state") === "skipped");
    expect(skipped?.textContent).not.toContain("Full output");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    // The link sits behind the row's chevron, with the output.
    fireEvent.click(within(lint).getByRole("button", { name: "lint, failed" }));
    fireEvent.click(within(lint).getByRole("button", { name: "Full output for lint" }));
    expect((await within(lint).findByTestId("artifact-unavailable")).textContent).toBe(
      "Artifact unavailable",
    );
    vi.unstubAllGlobals();
    cleanup();

    // A verification log drawn as a row on its own still draws nothing.
    const item = view.timeline.find((entry) => entry.kind === "artifact") as TimelineItem;
    const { container } = render(<TimelineRow view={view} item={item} />);
    expect(container.textContent).toBe("");
  });

  it("keeps rows for artifacts other producers uploaded", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "artifact.created",
        { payload: { producer: "tool" } },
        { sessionSequence: 1 },
      ),
    ]);
    render(<Timeline view={view} sessionId="sess_1" />);
    expect(screen.getAllByTestId("row-artifact")).toHaveLength(1);
  });

  it("renders a verification summary", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "verification",
      runId: "run_1",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-verification").textContent).toBe("Checks finished");
  });

  it("states a verification summary's counts, never its proposed outcome", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "verification.completed",
        {
          payload: {
            proposedOutcome: "verified",
            required: { total: 2, passed: 1, failed: 1, skipped: 0, inconclusive: 0 },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "verification") as TimelineItem;
    renderRow(view, item);
    const text = screen.getByTestId("row-verification").textContent ?? "";
    expect(text).toBe("Checks finished · 1 of 2 required passed");
    expect(text).not.toContain("verified");
  });

  it("renders a turn's changes from its diff as a change card", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("diff.updated", {}, { sessionSequence: 2 }),
    ]);
    const item = view.timeline.find((entry) => entry.kind === "changes") as TimelineItem;
    renderRow(view, item);
    expect(screen.getByTestId("row-changes").textContent).toContain("Edited 1 file");
  });

  it("renders a commit with a short sha", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "commit",
      sha: "abcdef1234567890",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-commit")).toBeTruthy();
    expect(screen.getByText(/abcdef1/)).toBeTruthy();
  });

  it("renders a push", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "push",
      pushId: "push_1",
      change: "completed",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-push")).toBeTruthy();
  });

  it("names the withheld files when a push fails for a secret in the changes", () => {
    // The failure message names the files; "Push failed" alone would hide them.
    const message =
      "OnCue published nothing because the changes contain a development secret supplied to this session. Found in: leaked-key.txt.";
    const view = foldEvents([
      makeCommittedEvent("git.push.requested", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "git.push.failed",
        { payload: { category: "secret_in_changes", message } },
        { sessionSequence: 2 },
      ),
    ]);
    const failed = view.timeline.filter((entry) => entry.kind === "push").at(-1) as TimelineItem;
    renderRow(view, failed);
    const row = screen.getByTestId("row-push");
    expect(row.textContent).toContain("Push failed");
    expect(row.textContent).toContain("Found in: leaked-key.txt");
  });

  it("says why a push the branch moved past was refused, and that nothing was overwritten", () => {
    const view = foldEvents([
      makeCommittedEvent("git.push.requested", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "git.push.failed",
        { payload: { category: "non_fast_forward", message: "GitHub rejected the push." } },
        { sessionSequence: 2 },
      ),
    ]);
    const failed = view.timeline.filter((entry) => entry.kind === "push").at(-1) as TimelineItem;
    renderRow(view, failed);
    const row = screen.getByTestId("row-push");
    expect(row.textContent).toContain("GitHub rejected the push.");
    expect(row.textContent).toContain(NON_FAST_FORWARD_HINT);
  });

  it("keeps a completed push to one line", () => {
    const view = foldEvents([
      makeCommittedEvent("git.push.requested", {}, { sessionSequence: 1 }),
      makeCommittedEvent("git.push.completed", {}, { sessionSequence: 2 }),
    ]);
    const done = view.timeline.filter((entry) => entry.kind === "push").at(-1) as TimelineItem;
    renderRow(view, done);
    expect(screen.getByTestId("row-push").textContent).toBe("Push completed");
  });

  it("renders a pull request", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "pull_request",
      number: 128,
      change: "opened",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-pull-request")).toBeTruthy();
    expect(screen.getByText(/#128/)).toBeTruthy();
  });

  it("summarises an artifact rather than inlining it", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "artifact",
      artifactId: "art_1",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-artifact")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  describe("artifact download", () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });

    function artifactView(label: string) {
      const view = foldEvents([
        makeCommittedEvent("artifact.uploading", {}, { sessionSequence: 1 }),
        makeCommittedEvent(
          "artifact.created",
          { payload: { artifact: testArtifactRef({ label }) } },
          { sessionSequence: 2 },
        ),
      ]);
      const item = view.timeline.find((entry) => entry.kind === "artifact");
      if (item === undefined) {
        throw new Error("the fold made no artifact row");
      }
      return { view, item };
    }

    function stubFetch(answer: () => Promise<Response>) {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          calls.push(input);
          return answer();
        }),
      );
      return calls;
    }

    it("fetches the artifact through the Worker and downloads it named by its label", async () => {
      const calls = stubFetch(async () => new Response("log body", { status: 200 }));
      const createObjectURL = vi.fn((_blob: Blob) => "blob:artifact");
      const revokeObjectURL = vi.fn();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      const clicked: { href: string; download: string }[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push({ href: this.href, download: this.download });
      });
      const { view, item } = artifactView("reports/final.log");
      render(<TimelineRow view={view} item={item} sessionId="sess 1" />);

      fireEvent.click(screen.getByRole("button", { name: "Download" }));

      await waitFor(() =>
        expect(clicked).toEqual([{ href: "blob:artifact", download: "reports_final.log" }]),
      );
      expect(calls).toEqual(["/api/sessions/sess%201/artifacts/art_1"]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact"));
      expect(screen.queryByTestId("artifact-unavailable")).toBeNull();
      expect(document.querySelector("a[download]")).toBeNull();
    });

    it("says the artifact is unavailable when the Worker answers 404", async () => {
      stubFetch(
        async () =>
          new Response(JSON.stringify({ error: "artifact_unavailable" }), { status: 404 }),
      );
      const createObjectURL = vi.fn(() => "blob:never");
      URL.createObjectURL = createObjectURL;
      const { view, item } = artifactView("test.log");
      render(<TimelineRow view={view} item={item} sessionId="sess_1" />);

      fireEvent.click(screen.getByRole("button", { name: "Download" }));

      expect((await screen.findByTestId("artifact-unavailable")).textContent).toBe(
        "Artifact unavailable",
      );
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it("says the artifact is unavailable when the fetch throws or the save fails", async () => {
      stubFetch(async () => {
        throw new Error("offline");
      });
      const { view, item } = artifactView("test.log");
      render(<TimelineRow view={view} item={item} sessionId="sess_1" />);
      const button = screen.getByRole<HTMLButtonElement>("button", { name: "Download" });
      fireEvent.click(button);
      expect(await screen.findByTestId("artifact-unavailable")).toBeTruthy();
      expect(button.disabled).toBe(false);
      cleanup();

      stubFetch(async () => new Response("bytes", { status: 200 }));
      URL.createObjectURL = () => {
        throw new Error("no object URLs here");
      };
      render(<TimelineRow view={view} item={item} sessionId="sess_1" />);
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      expect(await screen.findByTestId("artifact-unavailable")).toBeTruthy();
    });

    it("asks for nothing without a session to ask about", async () => {
      const calls = stubFetch(async () => new Response("bytes", { status: 200 }));
      renderRow(emptyView(), {
        sequence: 1,
        kind: "artifact",
        artifactId: "art_1",
      } as unknown as TimelineItem);
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      expect(await screen.findByTestId("artifact-unavailable")).toBeTruthy();
      expect(calls).toEqual([]);
    });

    it("names the file by the label without a directory, or by the id without a label", () => {
      expect(artifactFileName("a\\b/c.txt", "art_1")).toBe("a_b_c.txt");
      expect(artifactFileName("  ", "art_1")).toBe("art_1");
      expect(artifactFileName(null, "art_1")).toBe("art_1");
    });
  });

  it("renders a review item", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "review",
      reviewItemId: "rev_1",
      change: "opened",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-review")).toBeTruthy();
  });

  it("renders a run transition", () => {
    renderRow(emptyView(), {
      sequence: 1,
      kind: "run",
      runId: "run_1",
      transition: "started",
    } as unknown as TimelineItem);
    expect(screen.getByTestId("row-run")).toBeTruthy();
  });

  describe("a pause on a model failure", () => {
    const failed = (category: ModelFailureCategory, message: string, sessionSequence: number) =>
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: { category, message, retries: 0 },
          },
        },
        { sessionSequence },
      );
    const pausedRows = () => [
      ...document.querySelectorAll<HTMLElement>(
        "[data-testid='row-run'][data-transition='paused']",
      ),
    ];

    it("stands on the timeline with its reason, outside the folded work before it", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
        // The bridge's diagnostic, which stays out of the row.
        failed("authentication_failed", "broker answered 403: The provider rejected it.", 4),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);

      const [row] = pausedRows();
      expect(row?.textContent).toBe(
        "PausedModel request failed: the provider rejected the model key.Open Model providers",
      );
      expect(row?.getAttribute("data-category")).toBe("authentication_failed");
      // Not folded: the reader sees it without opening anything.
      expect(row?.closest("[data-testid='activity-rows']")).toBeNull();
      expect(
        within(row as HTMLElement)
          .getByRole("link")
          .getAttribute("href"),
      ).toBe("/settings/model-providers");
      // The work before it is settled, not shown as still happening.
      expect(document.querySelector("[data-testid='activity-trigger'] .shimmer")).toBeNull();
    });

    it("links to Model providers only for a rejected key", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("usage_limit_reached", "This connection has reached a limit with the provider.", 2),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);

      expect(pausedRows()[0]?.textContent).toBe(
        "PausedModel request failed: this key has reached its usage limit.",
      );
    });

    it("follows the screen's word on whether Settings is the way forward", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("authentication_failed", "Rejected.", 2),
      ]);
      // The key was replaced since: nothing is left to do in Settings.
      render(<Timeline view={view} sessionId="sess_1" pauseLinksToKeys={false} />);
      expect(within(pausedRows()[0] as HTMLElement).queryByRole("link")).toBeNull();
      cleanup();

      // The connection is gone, whatever the failure was.
      const limit = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("usage_limit_reached", "Limit.", 2),
      ]);
      render(<Timeline view={limit} sessionId="sess_1" pauseLinksToKeys />);
      expect(within(pausedRows()[0] as HTMLElement).getByRole("link")).toBeTruthy();
    });

    it("keeps an earlier pause's reason and offers its link only on the pause the run is stopped on", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("authentication_failed", "First.", 2),
        makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 4 }),
        failed("authentication_failed", "Second.", 5),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);

      const rows = pausedRows();
      expect(rows.map((row) => row.textContent)).toEqual([
        "PausedModel request failed: the provider rejected the model key.",
        "PausedModel request failed: the provider rejected the model key.Open Model providers",
      ]);
    });

    it("offers no link once the run has resumed or ended", () => {
      const resumed = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("authentication_failed", "Rejected.", 2),
        makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 4 }),
      ]);
      render(<Timeline view={resumed} sessionId="sess_1" />);
      expect(pausedRows()[0]?.textContent).toBe(
        "PausedModel request failed: the provider rejected the model key.",
      );
      cleanup();

      const cancelled = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        failed("authentication_failed", "Rejected.", 2),
        makeCommittedEvent("run.cancelled", {}, { sessionSequence: 3 }),
      ]);
      render(<Timeline view={cancelled} sessionId="sess_1" />);
      expect(within(pausedRows()[0] as HTMLElement).queryByRole("link")).toBeNull();
    });

    it("leaves any other pause a quiet row inside its group", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "run.paused",
          { payload: { reason: "user_requested" } },
          { sessionSequence: 3 },
        ),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);

      expect(pausedRows()).toHaveLength(0);
      const quiet = screen
        .getAllByTestId("row-run")
        .find((row) => row.textContent === "Run paused");
      expect(quiet?.closest("[data-testid='activity-rows']")).not.toBeNull();
    });
  });

  describe("turns", () => {
    const inside = (element: Element) => element.closest("[data-testid='row-activity']") !== null;

    it("marks the turn where the owner changed the model, from the model before to the one after", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent(
          "run.queued",
          {
            runId: "run_2" as RunId,
            eventId: "evt_q2" as never,
            payload: {
              commandId: "cmd_2" as never,
              instruction: {
                messageId: "msg_user_2" as never,
                text: "Carry on.",
                attachments: [],
              },
              model: { ...testModelRecord(), provider: "openai", modelId: "gpt-6-sol" },
              trigger: "model_change",
              continuesRunId: "run_1" as RunId,
            },
          },
          { sessionSequence: 2 },
        ),
      ]);
      const listed = (modelId: string, name: string) => ({
        modelId,
        name,
        contextWindow: 200_000,
        effort: null,
        defaultEffort: null,
        price: { inputPerMTok: 1, outputPerMTok: 1 },
        status: "current" as const,
        recommended: false,
      });
      const catalog = { anthropic: [], openai: [listed("gpt-6-sol", "GPT-6 Sol")] };
      render(<Timeline view={view} sessionId="sess_1" catalog={catalog} />);
      const rows = screen.getAllByTestId("row-model-change");
      // One row, for the changed run only, standing on the timeline rather than in a group.
      expect(rows).toHaveLength(1);
      // The catalog's name where it lists the model, the id read plainly where it does not.
      expect(rows[0]?.textContent).toBe("Model changed from Sonnet 4.5 to GPT-6 Sol");
      expect(inside(rows[0] as Element)).toBe(false);
    });

    it("folds a turn's work into groups in the order it happened, checks apart, and ends the turn on the change card", () => {
      const view = foldEvents(reviewFixtureEvents());
      render(<Timeline view={view} sessionId="sess_1" />);

      // The work is in a work group; the checks in a checks group; the
      // outcome stands beneath, behind no headline.
      const inChecks = (element: Element) => element.closest("[data-testid='row-checks']") !== null;
      for (const row of screen.getAllByTestId("row-check")) {
        expect(inChecks(row)).toBe(true);
      }
      const outcomes = document.querySelectorAll("[data-testid='row-run'][data-outcome]");
      expect(outcomes.length).toBeGreaterThan(0);
      for (const row of outcomes) {
        expect(inside(row)).toBe(false);
        expect(inChecks(row)).toBe(false);
      }
      // The answer and the edited files are not folded.
      for (const testId of ["row-message-assistant", "row-changes"]) {
        for (const row of screen.getAllByTestId(testId)) {
          expect(inside(row)).toBe(false);
          expect(inChecks(row)).toBe(false);
        }
      }
      // Every group starts closed, with its rows mounted.
      for (const fold of [
        ...screen.getAllByTestId("row-activity"),
        ...screen.getAllByTestId("row-checks"),
      ]) {
        expect(fold.getAttribute("data-open")).toBe("false");
      }
      expect(screen.getAllByTestId("row-check")).toHaveLength(5);

      // Within each turn, the change card is the last thing shown, and the
      // copy control sits under it.
      const top = [...document.querySelectorAll("[data-timeline-key]")].filter(
        (node) => node.parentElement?.closest("[data-timeline-key]") === null,
      );
      const kinds = top.map((node) => node.getAttribute("data-timeline-key")?.split("-")[0]);
      const userTurns: number[] = [];
      for (const [index, kind] of kinds.entries()) {
        if (kind === "message" && isUserMessage(top[index])) {
          userTurns.push(index);
        }
      }
      expect(userTurns.length).toBeGreaterThan(0);
      for (const [turn, start] of userTurns.entries()) {
        const end = userTurns[turn + 1] ?? kinds.length;
        // A turn the agent answered in words ends on its copy control. Before
        // it: the change card, then the checks group that ran on that change,
        // then the run's outcome row on its own, in the order they happened.
        const body = kinds.slice(start, kinds[end - 1] === "copy" ? end - 1 : end);
        expect(body.at(-1)).toBe("run");
        expect(body.at(-2)).toBe("activity");
        expect(body.at(-3)).toBe("changes");
        const lastGroup = top[start + body.length - 2];
        expect(lastGroup?.querySelector("[data-testid='row-checks']")).not.toBeNull();
      }

      function isUserMessage(node: Element | undefined): boolean {
        return node?.querySelector("[data-testid='row-message-user']") !== null;
      }
    });

    it("puts the calls after an answer in a group of their own, beneath that answer", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "tool.requested",
          { payload: { toolCallId: "tc_1" } },
          { sessionSequence: 3 },
        ),
        makeCommittedEvent(
          "tool.started",
          { payload: { toolCallId: "tc_1" } },
          { sessionSequence: 4 },
        ),
        makeCommittedEvent(
          "tool.completed",
          { payload: { toolCallId: "tc_1" } },
          { sessionSequence: 5 },
        ),
        makeCommittedEvent(
          "message.started",
          { payload: { messageId: "msg_a" } },
          { sessionSequence: 6 },
        ),
        makeCommittedEvent(
          "message.completed",
          { payload: { messageId: "msg_a", parts: [{ type: "text", text: "Looking further." }] } },
          { sessionSequence: 7 },
        ),
        makeCommittedEvent(
          "tool.requested",
          { payload: { toolCallId: "tc_2" } },
          { sessionSequence: 8 },
        ),
        makeCommittedEvent(
          "tool.started",
          { payload: { toolCallId: "tc_2" } },
          { sessionSequence: 9 },
        ),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);

      const top = [...document.querySelectorAll("[data-timeline-key]")]
        .filter((node) => node.parentElement?.closest("[data-timeline-key]") === null)
        .map((node) => node.getAttribute("data-timeline-key")?.split("-")[0]);
      // The run's own instruction leads as the user's message; then the work,
      // the answer, and the work after it, in that order.
      expect(top).toEqual(["message", "activity", "message", "activity"]);
      const groups = screen.getAllByTestId("row-activity");
      expect(groups).toHaveLength(2);
      // The first group has settled behind the answer: a count, no motion.
      // "Run started" and one shell call: what the call did, with the span it took.
      expect(within(groups[0] as HTMLElement).getByTestId("activity-trigger").textContent).toMatch(
        /^Ran 1 command/,
      );
      expect(groups[0]?.querySelector(".shimmer")).toBeNull();
      // The second is the live edge: the call happening now, shimmering.
      const liveTrigger = within(groups[1] as HTMLElement).getByTestId("activity-trigger");
      expect(liveTrigger.querySelector(".shimmer")).toBeTruthy();
      expect(liveTrigger.textContent).toContain("1 action");
      expect(liveTrigger.textContent).toContain(view.tools.get("tc_2" as never)?.title ?? "");
    });

    it("lets a wordless message between calls pass without cutting the group", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "tool.requested",
          { payload: { toolCallId: "tc_1" } },
          { sessionSequence: 3 },
        ),
        makeCommittedEvent(
          "tool.completed",
          { payload: { toolCallId: "tc_1" } },
          { sessionSequence: 4 },
        ),
        makeCommittedEvent(
          "message.started",
          { payload: { messageId: "msg_e" } },
          { sessionSequence: 5 },
        ),
        makeCommittedEvent(
          "message.completed",
          { payload: { messageId: "msg_e", parts: [] } },
          { sessionSequence: 6 },
        ),
        makeCommittedEvent(
          "tool.requested",
          { payload: { toolCallId: "tc_2" } },
          { sessionSequence: 7 },
        ),
        makeCommittedEvent(
          "tool.completed",
          { payload: { toolCallId: "tc_2" } },
          { sessionSequence: 8 },
        ),
      ]);
      render(<Timeline view={view} sessionId="sess_1" />);
      expect(screen.getAllByTestId("row-activity")).toHaveLength(1);
      expect(screen.queryByTestId("row-message-assistant")).toBeNull();
      expect(screen.getByTestId("activity-trigger").textContent).toContain("3 actions");
    });

    it("draws nothing for a message that has started with no words yet, and draws it once words arrive", () => {
      const started = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
        makeCommittedEvent("message.started", {}, { sessionSequence: 4 }),
      ]);
      const { rerender } = render(<Timeline view={started} sessionId="sess_1" />);
      expect(screen.queryByTestId("row-message-assistant")).toBeNull();
      expect(screen.queryByTestId("streaming-placeholder")).toBeNull();

      const streaming = applyLiveEvent(
        started,
        makeEvent("message.delta", { payload: { part: { type: "text", text: "Found it." } } }),
      );
      rerender(<Timeline view={streaming} sessionId="sess_1" />);
      expect(screen.getByTestId("row-message-assistant").textContent).toContain("Found it.");
    });

    it("starts closed even while live, and the reader's choice stands", () => {
      const working = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 4 }),
      ]);
      const ended = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 3 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 4 }),
        makeCommittedEvent("tool.completed", {}, { sessionSequence: 5 }),
        makeCommittedEvent("run.verified", {}, { sessionSequence: 6 }),
      ]);

      const { rerender } = render(<Timeline view={working} sessionId="sess_1" />);
      const fold = screen.getByTestId("row-activity");
      expect(fold.getAttribute("data-open")).toBe("false");
      // Live: the tool's own title, in motion.
      expect(screen.getByTestId("activity-trigger").querySelector(".shimmer")).toBeTruthy();
      expect(screen.getByTestId("activity-trigger").textContent).toContain(
        working.tools.values().next().value?.title ?? "",
      );

      rerender(<Timeline view={ended} sessionId="sess_1" />);
      expect(fold.getAttribute("data-open")).toBe("false");
      expect(screen.getByTestId("activity-trigger").textContent).toMatch(/^Ran \d+ command/);
      expect(screen.getByTestId("activity-trigger").querySelector(".shimmer")).toBeNull();
      // Folded, not gone.
      expect(screen.getByTestId("row-tool")).toBeTruthy();

      // The reader opens it; a later change of state does not close it.
      fireEvent.click(screen.getByTestId("activity-trigger"));
      expect(fold.getAttribute("data-open")).toBe("true");
      rerender(<Timeline view={working} sessionId="sess_1" />);
      rerender(<Timeline view={ended} sessionId="sess_1" />);
      expect(fold.getAttribute("data-open")).toBe("true");
    });
  });

  describe("copy response", () => {
    it("ends each answered turn with a copy control that copies the answer as markdown", async () => {
      const writeText = vi.fn(async (_text: string) => {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const view = foldEvents(reviewFixtureEvents());
      render(<Timeline view={view} sessionId="sess_1" />);
      const buttons = screen.getAllByTestId("copy-response");
      // One turn was answered in words; the other's answer is its change
      // card alone, and a control that copies nothing is not offered.
      expect(buttons).toHaveLength(1);
      const top = [...document.querySelectorAll("[data-timeline-key]")].filter(
        (node) => node.parentElement?.closest("[data-timeline-key]") === null,
      );
      const kinds = top.map((node) => node.getAttribute("data-timeline-key")?.split("-")[0]);
      for (const [index, kind] of kinds.entries()) {
        if (kind === "copy") {
          // Under the checks group, which follows the change card.
          expect(kinds[index - 1]).toBe("run");
          expect(kinds[index - 2]).toBe("activity");
          expect(kinds[index - 3]).toBe("changes");
        }
      }

      fireEvent.click(buttons[0] as HTMLElement);
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied.length).toBeGreaterThan(0);
      expect(copied).not.toContain("<");
      await waitFor(() => expect(buttons[0]?.getAttribute("data-copied")).toBe("true"));
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Copied");
      vi.unstubAllGlobals();
    });

    it("falls back to the copy command where the async clipboard is denied", async () => {
      const writeText = vi.fn(async (_text: string) => {
        throw new DOMException("Write permission denied.", "NotAllowedError");
      });
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const execCommand = vi.fn((command: string) => command === "copy");
      document.execCommand = execCommand;
      render(<Timeline view={foldEvents(reviewFixtureEvents())} sessionId="sess_1" />);
      const button = screen.getByTestId("copy-response");
      fireEvent.click(button);
      await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
      await waitFor(() => expect(button.getAttribute("data-copied")).toBe("true"));
      // The holder the command copied from does not outlive the click.
      expect(document.querySelector("textarea[readonly]")).toBeNull();

      // When the command is refused too, the button keeps its word.
      execCommand.mockReturnValue(false);
      await waitFor(() => expect(button.getAttribute("data-copied")).toBe("false"), {
        timeout: 3000,
      });
      fireEvent.click(button);
      await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(2));
      expect(button.getAttribute("data-copied")).toBe("false");
      vi.unstubAllGlobals();
    });

    it("offers no copy while the turn is still being answered", () => {
      const working = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent("message.started", {}, { sessionSequence: 3 }),
      ]);
      render(<Timeline view={working} sessionId="sess_1" />);
      expect(screen.queryByTestId("copy-response")).toBeNull();
    });
  });

  describe("streaming messages", () => {
    it("shows a waiting line when a message has started but the buffer is still empty", () => {
      const view = foldEvents([makeCommittedEvent("message.started", {}, { sessionSequence: 1 })]);
      const item = view.timeline.find((entry) => entry.kind === "message");
      expect(item).toBeDefined();
      if (item === undefined) {
        return;
      }

      renderRow(view, item);

      const row = screen.getByTestId("row-message-assistant");
      expect(row.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByTestId("streaming-placeholder").textContent).toBe(
        "Partial text is not replayed; waiting for the message to finish",
      );
    });

    it("renders the live buffer through the markdown component while streaming, with a live mark", () => {
      let view = foldEvents([makeCommittedEvent("message.started", {}, { sessionSequence: 1 })]);
      view = applyLiveEvent(
        view,
        makeEvent("message.delta", { payload: { part: { type: "text", text: "building" } } }),
      );
      const item = view.timeline.find((entry) => entry.kind === "message");
      expect(item).toBeDefined();
      if (item === undefined) {
        return;
      }

      renderRow(view, item);

      const row = screen.getByTestId("row-message-assistant");
      expect(row.getAttribute("aria-busy")).toBe("true");
      expect(row.textContent).toContain("building");
      expect(screen.getByTestId("streaming-mark")).toBeTruthy();
      expect(screen.queryByTestId("streaming-placeholder")).toBeNull();
    });

    it("drops reasoning-summary deltas from the live buffer", () => {
      let view = foldEvents([makeCommittedEvent("message.started", {}, { sessionSequence: 1 })]);
      view = applyLiveEvent(
        view,
        makeEvent("message.delta", {
          payload: { part: { type: "reasoning_summary", text: "thinking about it" } },
        }),
      );
      const item = view.timeline.find((entry) => entry.kind === "message");
      expect(item).toBeDefined();
      if (item === undefined) {
        return;
      }

      renderRow(view, item);

      expect(screen.getByTestId("streaming-placeholder")).toBeTruthy();
      expect(screen.queryByText("thinking about it")).toBeNull();
    });

    it("replaces the buffer with the committed parts once the message completes", () => {
      const view = foldEvents([
        makeCommittedEvent("message.started", {}, { sessionSequence: 1 }),
        makeCommittedEvent(
          "message.completed",
          { payload: { parts: [{ type: "text", text: "done talking" }] } },
          { sessionSequence: 2 },
        ),
      ]);
      const item = view.timeline.find((entry) => entry.kind === "message");
      expect(item).toBeDefined();
      if (item === undefined) {
        return;
      }

      renderRow(view, item);

      const row = screen.getByTestId("row-message-assistant");
      expect(row.getAttribute("aria-busy")).toBeNull();
      expect(row.textContent).toContain("done talking");
      expect(screen.queryByTestId("streaming-mark")).toBeNull();
    });

    it("renders a code part through CodeBlock alongside the surrounding text", async () => {
      const view = foldEvents([
        makeCommittedEvent("message.started", {}, { sessionSequence: 1 }),
        makeCommittedEvent(
          "message.completed",
          {
            payload: {
              parts: [
                { type: "text", text: "here it is" },
                { type: "code", code: "const x = 1;", language: "typescript" },
              ],
            },
          },
          { sessionSequence: 2 },
        ),
      ]);
      const item = view.timeline.find((entry) => entry.kind === "message");
      expect(item).toBeDefined();
      if (item === undefined) {
        return;
      }

      renderRow(view, item);

      const row = screen.getByTestId("row-message-assistant");
      expect(row.textContent).toContain("here it is");
      // shiki highlights asynchronously, so the first paint has no code text.
      await waitFor(() => expect(row.textContent).toContain("const x = 1;"));
    });
  });

  describe("tool row states", () => {
    it("reads a call whose arguments are complete but which has not started as waiting to start", () => {
      const view = foldEvents([makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 })]);
      const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };

      renderRow(view, item);

      expect(screen.getByRole("button", { name: /waiting to start/ })).toBeTruthy();
    });

    it("moves the row to running only once tool.started lands", () => {
      const view = foldEvents([
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 2 }),
      ]);
      const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };

      renderRow(view, item);

      expect(screen.getByRole("button", { name: /, running/ })).toBeTruthy();
    });

    it("shows a live output tail, marked as live, while the call is still running", () => {
      let view = foldEvents([
        makeCommittedEvent("tool.requested", {}, { sessionSequence: 1 }),
        makeCommittedEvent("tool.started", {}, { sessionSequence: 2 }),
      ]);
      view = applyLiveEvent(
        view,
        makeEvent("tool.output", {
          payload: { toolCallId: "tool_1", text: "still compiling" },
        }),
      );
      const item: TimelineItem = { sequence: 1, kind: "tool", toolCallId: "tool_1" as never };

      renderRow(view, item);
      fireEvent.click(screen.getByRole("button"));

      const output = screen.getByTestId("action-output");
      expect(output.textContent).toContain("live");
      expect(output.textContent).toContain("still compiling");
    });
  });
});
