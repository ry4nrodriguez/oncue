import { emptyView, foldEvents } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewFixtureEvents } from "@/features/diff/review-fixture";
import type { SubmitResult } from "./Composer";
import { ConnectionBadge } from "./ConnectionBadge";
import { ContextRail } from "./ContextRail";
import { PullRequestPane, pullRequestUrl } from "./PullRequestPane";
import { panelToggleLabel, SessionHeader } from "./SessionHeader";
import { keepAliveOutcome, stopSandboxOutcome } from "./SessionScreen";
import { CONNECTION_LABELS } from "./status";
import { CONNECTION_STATES } from "./transport";

afterEach(cleanup);

describe("ConnectionBadge", () => {
  it("names every connection state record 13 requires", () => {
    for (const state of CONNECTION_STATES) {
      const view = render(<ConnectionBadge state={state} />);
      expect(screen.getByTestId("connection-badge").dataset.state).toBe(state);
      expect(screen.getByText(CONNECTION_LABELS[state])).toBeTruthy();
      view.unmount();
    }
  });

  it("distinguishes offline with an unsent message", () => {
    render(<ConnectionBadge state="offline" hasUnsentInput />);

    expect(screen.getByText("Offline · unsent message")).toBeTruthy();
  });
});

describe("ContextRail", () => {
  it("shows the latest run's outcome with its required checks, and opens the Tests view from it", () => {
    const view = foldEvents(reviewFixtureEvents());
    const onOpenTests = vi.fn();
    render(<ContextRail view={view} onOpenTests={onOpenTests} />);
    const outcome = screen.getByTestId("rail-outcome");
    // The fixture's latest run skipped typecheck at the user's request.
    expect(outcome.textContent).toBe("Completed with warnings · test passed, typecheck skipped");
    expect(outcome.tagName).toBe("BUTTON");
    fireEvent.click(outcome);
    expect(onOpenTests).toHaveBeenCalledTimes(1);
    cleanup();

    const verified = foldEvents(reviewFixtureEvents().slice(0, 17));
    render(<ContextRail view={verified} />);
    const row = screen.getByTestId("rail-outcome");
    expect(row.textContent).toBe("Verified · test passed, typecheck passed");
    expect(row.tagName).toBe("DIV");
  });

  it("shows no outcome before the latest run ends, and the label alone without checks", () => {
    const running = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
    ]);
    render(<ContextRail view={running} />);
    expect(screen.queryByTestId("rail-outcome")).toBeNull();
    cleanup();

    const failed = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("run.failed", {}, { sessionSequence: 3 }),
    ]);
    render(<ContextRail view={failed} />);
    expect(screen.getByTestId("rail-outcome").textContent).toBe("Failed");
  });

  it("offers Run checks under an ended run's outcome, and only when the screen can send it (record 14)", () => {
    const done = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("run.completed", {}, { sessionSequence: 3 }),
    ]);
    const onRunChecks = vi.fn();
    render(<ContextRail view={done} onRunChecks={onRunChecks} />);
    expect(screen.getByTestId("rail-outcome").textContent).toBe("Done");
    fireEvent.click(screen.getByTestId("rail-run-checks"));
    expect(onRunChecks).toHaveBeenCalledTimes(1);
    cleanup();

    render(<ContextRail view={done} />);
    expect(screen.queryByTestId("rail-run-checks")).toBeNull();
    cleanup();

    const running = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
    ]);
    render(<ContextRail view={running} onRunChecks={onRunChecks} />);
    expect(screen.queryByTestId("rail-run-checks")).toBeNull();
  });

  // Where the work runs, the repository, and the model belong to the composer strip.
  it("shows the work's facts and nothing the composer strip already says", () => {
    render(<ContextRail view={emptyView()} />);

    expect(screen.getByTestId("context-rail")).toBeTruthy();
    expect(screen.getByTestId("rail-changes").textContent).toBe("No changes yet");
    expect(screen.getByTestId("rail-branch").textContent).toBe("Branch named at the first push");
    expect(screen.getByTestId("rail-pull-request").textContent).toBe("No pull request yet");
    expect(screen.getByTestId("rail-git-behavior")).toBeTruthy();
    expect(screen.queryByText("acme/oncue")).toBeNull();
    expect(screen.queryByTestId("rail-modal")).toBeNull();
    expect(screen.queryByText(/No model selected|claude-/)).toBeNull();
    expect(screen.queryByLabelText(/session details$/)).toBeNull();
  });

  it("says which branch the session started from, or that it works on an existing one", () => {
    render(<ContextRail view={emptyView()} baseBranch="release/1.4" />);
    expect(screen.getByTestId("rail-branch-mode").textContent).toBe("From release/1.4");
    cleanup();

    render(<ContextRail view={emptyView()} taskBranch="feature/login" existingBranch />);
    expect(screen.getByTestId("rail-branch").textContent).toContain("feature/login");
    expect(screen.getByTestId("rail-branch-mode").textContent).toBe(
      "Existing branch, pushed to directly",
    );
  });

  it("sums the session's changes and opens the review on them", () => {
    const onOpenChanges = vi.fn();
    render(<ContextRail view={foldEvents(reviewFixtureEvents())} onOpenChanges={onOpenChanges} />);
    const changes = screen.getByRole("button", { name: "Review all changes" });
    // "+10-5· 5 files": the gap before the dot is a margin, not a character.
    expect(changes.textContent).toMatch(/^\+\d+-\d+· \d+ files$/);
    fireEvent.click(changes);
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
    cleanup();

    // Without a diff there is nothing to open, so the row is not a control.
    render(<ContextRail view={emptyView()} onOpenChanges={onOpenChanges} />);
    expect(screen.queryByRole("button", { name: "Review all changes" })).toBeNull();
  });

  it("names the pull request by number and state once there is one", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "pull_request.created",
        { payload: { number: 12 } },
        { sessionSequence: 1 },
      ),
    ]);
    render(<ContextRail view={view} />);
    // The state is whatever the fold recorded for the event; the row does not invent one.
    expect(screen.getByTestId("rail-pull-request").textContent).toBe(
      `#12 · ${view.git.pullRequest?.state}`,
    );
  });

  // The session row names the branch until the timeline knows it.
  it("names the task branch from the session row until run.started names it", () => {
    render(<ContextRail view={emptyView()} taskBranch="oncue/fix-it-7f3a" />);
    expect(screen.getByText("oncue/fix-it-7f3a")).toBeTruthy();
    expect(screen.queryByText("Branch named at the first push")).toBeNull();
    cleanup();

    render(<ContextRail view={emptyView()} taskBranch={null} />);
    expect(screen.getByText("Branch named at the first push")).toBeTruthy();
    cleanup();

    // A commit on the base branch names nothing; the push does.
    const committed = foldEvents([
      makeCommittedEvent("git.committed", { payload: { branch: "main" } }, { sessionSequence: 1 }),
    ]);
    render(<ContextRail view={committed} taskBranch={null} />);
    expect(screen.getByText("Branch named at the first push")).toBeTruthy();
    cleanup();
    const pushed = foldEvents([
      makeCommittedEvent(
        "git.push.requested",
        { payload: { branch: "oncue/from-the-push-1234" } },
        { sessionSequence: 1 },
      ),
    ]);
    render(<ContextRail view={pushed} taskBranch="oncue/fix-it-7f3a" />);
    expect(screen.getByText("oncue/from-the-push-1234")).toBeTruthy();
  });

  it("can be unpinned", () => {
    const onUnpin = vi.fn();
    render(<ContextRail view={emptyView()} onUnpin={onUnpin} />);

    fireEvent.click(screen.getByLabelText("Unpin session details"));

    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it("points at the open question's card, ahead of Continue for a run its idle stop paused", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("question.asked", {}, { sessionSequence: 3 }),
      makeCommittedEvent(
        "run.paused",
        { runtimeSequence: null, payload: { reason: "idle_stop" } },
        { sessionSequence: 4 },
      ),
    ]);
    const card = document.createElement("section");
    card.dataset.testid = "question-card";
    card.scrollIntoView = vi.fn();
    document.body.append(card);

    render(<ContextRail view={view} onContinue={vi.fn()} />);

    expect(screen.queryByTestId("rail-continue")).toBeNull();
    fireEvent.click(screen.getByTestId("needs-you-question"));
    expect(screen.getByTestId("needs-you").textContent).toBe("The agent asked you a question");
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(card);
    card.remove();
  });

  it("surfaces a waiting approval as the needs-you item", () => {
    const view = foldEvents([makeCommittedEvent("approval.requested", {}, { sessionSequence: 1 })]);

    render(<ContextRail view={view} />);

    expect(screen.getByTestId("needs-you")).toBeTruthy();
  });

  /**
   * A `model_failure` pause names the category in plain words (record 15), and
   * `authentication_failed` also points at settings.
   */
  it("names a model failure in plain words, without a retry or switch control", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: {
              category: "rate_limited",
              message: "Too many requests this minute.",
              retries: 2,
            },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);

    render(<ContextRail view={view} />);

    const needsYou = screen.getByTestId("needs-you");
    expect(needsYou.textContent).toBe(
      "Model request failed: the provider is rate-limiting this key. Send a message to continue the run from its last checkpoint.",
    );
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch/i })).toBeNull();
  });

  it("still names a model failure once its sandbox is gone, and offers Continue beneath it", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: {
              category: "authentication_failed",
              message: "The stored key was rejected.",
              retries: 0,
            },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    const onContinue = vi.fn();

    render(<ContextRail view={view} onContinue={onContinue} />);

    // The key is active, replaced since or never marked: the rail says what
    // Settings shows, keeps the link there, and offers Continue.
    expect(screen.getByTestId("needs-you").textContent).toBe(
      "Model request failed: the provider rejected the model key. The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.Open Model providersContinue",
    );
    expect(screen.getByTestId("model-connections-link").getAttribute("href")).toBe(
      "/settings/model-providers",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("stops naming a model failure once the run has resumed from it", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: {
              category: "authentication_failed",
              message: "The stored key was rejected.",
              retries: 0,
            },
          },
        },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 4 }),
    ]);

    render(<ContextRail view={view} />);

    expect(screen.queryByTestId("needs-you")).toBeNull();
  });

  it("points at Model providers, with a link there, when the model failure is an authentication failure", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "run.paused",
        {
          payload: {
            reason: "model_failure",
            modelFailure: {
              category: "authentication_failed",
              message: "The stored key was rejected.",
              retries: 0,
            },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);

    render(<ContextRail view={view} runConnection="replaceable" onContinue={vi.fn()} />);

    // A rejected key is replaced in place, so the run continues afterwards: no new session.
    expect(screen.getByTestId("needs-you").textContent).toBe(
      "Model request failed: the provider rejected the model key. Replace the key under Settings, Model providers, then come back here to continue the run.Open Model providers",
    );
    expect(screen.getByTestId("model-connections-link").getAttribute("href")).toBe(
      "/settings/model-providers",
    );
    expect(screen.queryByTestId("rail-continue")).toBeNull();
    cleanup();

    // Only a revoked or deleted connection sends the work to a new session.
    render(<ContextRail view={view} runConnection="gone" onContinue={vi.fn()} />);
    expect(screen.getByTestId("needs-you").textContent).toBe(
      "Model request failed: the provider rejected the model key. The key this run used has since been removed. Add a working key under Settings, Model providers, then start a new session to continue the work.Open Model providers",
    );
    cleanup();

    // Before the key's state has been read, the rail names the failure and promises nothing.
    render(<ContextRail view={view} keyStateKnown={false} />);
    expect(screen.getByTestId("needs-you").textContent).toBe(
      "Model request failed: the provider rejected the model key.Open Model providers",
    );
  });

  it("still asks the generic question when a run is waiting for input without a model failure", () => {
    // With a live sandbox: a paused run whose sandbox is gone offers Continue
    // instead, which the Continue cases below cover.
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 2 }),
      makeCommittedEvent(
        "run.paused",
        { payload: { reason: "no_progress" } },
        { sessionSequence: 3 },
      ),
    ]);

    render(<ContextRail view={view} />);

    expect(screen.getByTestId("needs-you").textContent).toBe("The agent asked you a question");
  });

  describe("Continue", () => {
    function lostView(unsavedWorkWarning: string | null) {
      return foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "sandbox.stopped",
          {
            payload: {
              outcome: "failed",
              reason: "disappeared",
              checkpointId: null,
              unsavedWorkWarning,
            },
          },
          { sessionSequence: 3 },
        ),
        makeCommittedEvent(
          "run.interrupted",
          { payload: { reason: "sandbox_lost" } },
          { sessionSequence: 4 },
        ),
      ]);
    }

    it("offers to continue a run whose sandbox was lost, with the warning as plain text", async () => {
      const warning = '<img src="x" onerror="alert(1)"> 3 files were not saved';
      let finish: (result: SubmitResult) => void = () => {};
      const onContinue = vi.fn(
        () =>
          new Promise<SubmitResult>((resolve) => {
            finish = resolve;
          }),
      );
      const view = lostView(warning);
      render(<ContextRail view={view} onContinue={onContinue} />);

      const needsYou = screen.getByTestId("needs-you");
      expect(needsYou.textContent).toContain(
        "Work stopped when the sandbox was lost. Continue from the last checkpoint.",
      );
      expect(screen.getByTestId("unsaved-work-warning").textContent).toBe(warning);
      expect(needsYou.querySelector("img")).toBeNull();

      const button = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
      fireEvent.click(button);
      expect(onContinue).toHaveBeenCalledTimes(1);
      // One click is one command: the button waits for the send to settle.
      expect(button.disabled).toBe(true);
      finish(true);
      await vi.waitFor(() => expect(button.disabled).toBe(false));
      expect(screen.queryByTestId("rail-continue-problem")).toBeNull();
    });

    it("says when a Continue was not answered or not accepted, and lets it be pressed again", async () => {
      const onContinue = vi
        .fn<() => Promise<SubmitResult>>()
        .mockResolvedValueOnce("unanswered")
        .mockResolvedValueOnce(false);
      render(<ContextRail view={lostView(null)} onContinue={onContinue} />);
      const button = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });

      fireEvent.click(button);
      await vi.waitFor(() =>
        expect(screen.getByTestId("rail-continue-problem").textContent).toContain("didn't answer"),
      );
      fireEvent.click(button);
      await vi.waitFor(() =>
        expect(screen.getByTestId("rail-continue-problem").textContent).toContain("Not continued"),
      );
      expect(onContinue).toHaveBeenCalledTimes(2);
    });

    it("says the sandbox stopped for a paused run whose sandbox stopped at idle", () => {
      const view = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "run.paused",
          { payload: { reason: "idle_stop" } },
          { sessionSequence: 3 },
        ),
        makeCommittedEvent(
          "sandbox.stopped",
          { payload: { outcome: "stopped", reason: "idle" } },
          { sessionSequence: 4 },
        ),
      ]);
      render(<ContextRail view={view} onContinue={() => true} />);

      expect(screen.getByTestId("needs-you").textContent).toBe(
        "The sandbox stopped. Continue from the last checkpoint.Continue",
      );
      expect(screen.queryByTestId("unsaved-work-warning")).toBeNull();
    });

    it("shows the line without a button when there is nothing to send with", () => {
      render(<ContextRail view={lostView(null)} />);
      expect(screen.getByTestId("needs-you").textContent).toContain("Work stopped when");
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });

    it("offers nothing while a sandbox is still live, or while the object replaces it", () => {
      const lost = lostView(null);
      render(
        <ContextRail
          view={{ ...lost, sandbox: { ...lost.sandbox, state: "active" } }}
          onContinue={() => true}
        />,
      );
      expect(screen.queryByTestId("needs-you")).toBeNull();
      cleanup();

      const replaced = foldEvents([
        makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
        makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
        makeCommittedEvent(
          "run.interrupted",
          { payload: { reason: "sandbox_replaced" } },
          { sessionSequence: 3 },
        ),
        makeCommittedEvent(
          "sandbox.stopped",
          { payload: { outcome: "stopped", reason: "lifetime_ceiling" } },
          { sessionSequence: 4 },
        ),
      ]);
      render(<ContextRail view={replaced} onContinue={() => true} />);
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });
  });
});

describe("SessionHeader", () => {
  // The sidebar's highlighted row says which session this is.
  it("shows no title, and the connection only in words while it is degraded", () => {
    const healthy = render(<SessionHeader connection="live" railPinned onPinRail={() => {}} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("session-status")).toBeNull();
    expect(screen.queryByTestId("connection-badge")).toBeNull();
    healthy.unmount();

    const caughtUp = render(
      <SessionHeader connection="caught_up" railPinned onPinRail={() => {}} />,
    );
    expect(screen.queryByTestId("connection-badge")).toBeNull();
    caughtUp.unmount();

    for (const state of ["connecting", "reconnecting", "offline"] as const) {
      const view = render(<SessionHeader connection={state} railPinned onPinRail={() => {}} />);
      expect(screen.getByTestId("connection-badge").textContent).toBe(CONNECTION_LABELS[state]);
      view.unmount();
    }

    render(<SessionHeader connection="offline" hasUnsentInput railPinned onPinRail={() => {}} />);
    expect(screen.getByTestId("connection-badge").textContent).toBe("Offline · unsent message");
  });

  // One control for the panel, mirroring the sidebar's toggle on the left edge.
  it("offers one toggle for the side panel that says whether it is open", () => {
    const onTogglePanel = vi.fn();
    const closed = render(
      <SessionHeader
        connection="live"
        railPinned
        onPinRail={() => {}}
        onTogglePanel={onTogglePanel}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Open side panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onTogglePanel).toHaveBeenCalledTimes(1);
    for (const label of ["View preview", "View pull request", "Open terminal", "Review changes"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    closed.unmount();

    render(<SessionHeader connection="live" railPinned onPinRail={() => {}} panelOpen />);
    expect(
      screen.getByRole("button", { name: "Close side panel" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("carries a dot on the side-panel toggle while the sandbox is coming up or up, and says its state", () => {
    const cases = [
      ["starting", "bg-caution", "Open side panel. Sandbox starting"],
      ["running", "bg-positive", "Open side panel. Sandbox running"],
    ] as const;
    for (const [phase, tone, label] of cases) {
      const onTogglePanel = vi.fn();
      const view = render(
        <SessionHeader
          connection="live"
          railPinned
          onPinRail={() => {}}
          sandboxPhase={phase}
          onTogglePanel={onTogglePanel}
        />,
      );
      const toggle = screen.getByRole("button", { name: label });
      expect(toggle.getAttribute("title")).toBe(label);
      const dot = screen.getByTestId("panel-sandbox-dot");
      expect(toggle.contains(dot)).toBe(true);
      expect(dot.getAttribute("data-phase")).toBe(phase);
      expect(dot.className).toContain(tone);
      // Only a sandbox that is still starting pulses.
      expect(dot.className.includes("animate-pulse")).toBe(phase === "starting");
      // The dot is for the eye; the name carries the state, and a press still toggles the panel.
      expect(dot.getAttribute("aria-hidden")).toBe("true");
      fireEvent.click(toggle);
      expect(onTogglePanel).toHaveBeenCalledTimes(1);
      view.unmount();
    }
    expect(panelToggleLabel(true, "running")).toBe("Close side panel. Sandbox running");
  });

  it("has no dot before a sandbox, or once it has stopped or failed", () => {
    for (const phase of ["none", "stopped", "failed"] as const) {
      const view = render(
        <SessionHeader connection="live" railPinned onPinRail={() => {}} sandboxPhase={phase} />,
      );
      expect(screen.queryByTestId("panel-sandbox-dot")).toBeNull();
      const toggle = screen.getByRole("button", { name: "Open side panel" });
      expect(toggle.getAttribute("title")).toBe("Open side panel");
      view.unmount();
    }
    expect(panelToggleLabel(false, "none")).toBe("Open side panel");
    expect(panelToggleLabel(true, "stopped")).toBe("Close side panel");
    expect(panelToggleLabel(false, "failed")).toBe("Open side panel");
  });

  it("offers to re-pin the rail only when it is hidden", () => {
    const onPinRail = vi.fn();
    const view = render(<SessionHeader connection="live" railPinned onPinRail={onPinRail} />);
    expect(screen.queryByLabelText("Pin session details")).toBeNull();
    view.unmount();

    render(<SessionHeader connection="live" railPinned={false} onPinRail={onPinRail} />);
    fireEvent.click(screen.getByLabelText("Pin session details"));

    expect(onPinRail).toHaveBeenCalledTimes(1);
  });
});

describe("stopSandboxOutcome", () => {
  it("turns each answer from the stop route into what the dialog says", async () => {
    const answers: [number, unknown, { ok: boolean; message?: string; notice?: string }][] = [
      [200, { generation: 1 }, { ok: true }],
      [202, { generation: 1 }, { ok: true, notice: "Stopping the sandbox…" }],
      [
        409,
        { error: "not_running" },
        { ok: false, message: "There is no running sandbox to stop." },
      ],
      [401, {}, { ok: false, message: "You're signed out. Sign in again to stop the sandbox." }],
      [502, { message: "Modal timed out." }, { ok: false, message: "Modal timed out." }],
      [500, {}, { ok: false, message: "OnCue couldn't reach the server. Try again." }],
    ];
    for (const [status, body, expected] of answers) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      );
      await expect(stopSandboxOutcome("sess")).resolves.toEqual(expected);
    }
    vi.unstubAllGlobals();
  });
});

describe("keepAliveOutcome", () => {
  it("turns each answer from the keep-alive route into what the panel says", async () => {
    const expiresAt = "2026-09-02T01:00:00.000Z";
    const answers: [number, unknown, unknown][] = [
      [200, { expiresAt }, { ok: true, expiresAt }],
      [409, { error: "not_running" }, { ok: false, message: "The sandbox is not running." }],
      [
        403,
        {},
        { ok: false, message: "You're signed out. Sign in again to keep the sandbox running." },
      ],
      [500, {}, { ok: false, message: "OnCue couldn't reach the server. Try again." }],
    ];
    for (const [status, body, expected] of answers) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      );
      await expect(keepAliveOutcome("sess")).resolves.toEqual(expected);
    }
    vi.unstubAllGlobals();
  });
});

describe("PullRequestPane", () => {
  const editing = { named: null, slug: "fix-it-1a2b", onSlugChange: () => undefined };

  it("says the branch a new task branch starts from, or the default branch for an older session", () => {
    render(
      <PullRequestPane view={emptyView()} branch={{ ...editing, baseBranch: "release/1.4" }} />,
    );
    expect(screen.getByTestId("panel-branch-base").textContent).toBe("Started from release/1.4.");
    cleanup();
    render(<PullRequestPane view={emptyView()} branch={editing} />);
    expect(screen.getByTestId("panel-branch-base").textContent).toBe(
      "Started from the default branch.",
    );
  });

  it("names an existing branch the session pushes to, with no name to edit", () => {
    render(
      <PullRequestPane
        view={emptyView()}
        branch={{ ...editing, named: "feature/login", existing: true }}
      />,
    );
    expect(screen.getByTestId("panel-branch-name").textContent).toBe("feature/login");
    expect(screen.getByTestId("panel-branch-base").textContent).toContain("pushes to it directly");
  });

  it("links an adopted pull request, which arrives without a URL, and says its base when known", () => {
    const adopted = foldEvents([
      makeCommittedEvent(
        "pull_request.updated",
        { payload: { number: 7 } },
        { sessionSequence: 1 },
      ),
    ]);
    render(<PullRequestPane view={adopted} branch={{ ...editing, repository: "acme/widgets" }} />);
    expect(screen.getByTestId("pull-request-link").getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
    expect(screen.queryByTestId("pull-request-base")).toBeNull();
    cleanup();

    const opened = foldEvents([
      makeCommittedEvent(
        "pull_request.created",
        { payload: { number: 3, baseBranch: "release/1.4" } },
        { sessionSequence: 1 },
      ),
    ]);
    render(<PullRequestPane view={opened} branch={editing} />);
    expect(screen.getByTestId("pull-request-base").textContent).toBe("Into release/1.4");
  });

  it("builds a link only from a repository name that looks like one", () => {
    expect(pullRequestUrl(null, undefined, 1)).toBeNull();
    expect(pullRequestUrl(null, "evil.com/x/../y", 1)).toBeNull();
    expect(pullRequestUrl(null, "acme/widgets", 2)).toBe("https://github.com/acme/widgets/pull/2");
    expect(pullRequestUrl("https://github.com/acme/widgets/pull/3", "x/y", 3)).toBe(
      "https://github.com/acme/widgets/pull/3",
    );
  });
});
