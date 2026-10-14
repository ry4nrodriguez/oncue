import { emptyView, foldEvents } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keptAliveUntil,
  PANEL_TABS,
  type PanelTab,
  SessionPanel,
  sandboxStateLabel,
} from "./SessionPanel";
import { currentSandboxAction, formatClockTime } from "./sandbox-time";

afterEach(cleanup);

const T0 = "2026-09-02T00:00:00.000Z";
const T1 = "2026-09-02T00:00:02.400Z";

function runningEvents() {
  return [
    makeCommittedEvent(
      "sandbox.provisioning",
      { payload: { provider: "modal" }, occurredAt: T0 },
      { sessionSequence: 1 },
    ),
    makeCommittedEvent(
      "sandbox.attached",
      { payload: { provider: "modal", providerSandboxId: "sb-panel" }, occurredAt: T1 },
      { sessionSequence: 2 },
    ),
    makeCommittedEvent(
      "sandbox.output",
      {
        payload: {
          stream: "controller",
          lines: [{ at: T1, text: "create answered in 400 ms" }],
        },
      },
      { sessionSequence: 3 },
    ),
    makeCommittedEvent(
      "sandbox.output",
      {
        payload: { stream: "stderr", lines: [{ at: T1, text: "bridge retrying" }] },
      },
      { sessionSequence: 4 },
    ),
  ];
}

function runningSandbox() {
  return currentSandboxAction(foldEvents(runningEvents()));
}

/** The props every render shares: one Modal tab open, nothing else wired. */
const PANEL = {
  sessionId: "sess_1",
  open: ["modal"] as readonly PanelTab[],
  active: "modal" as PanelTab,
  reviewTarget: { tab: "review", scope: "session", runId: null } as const,
  onSelectTab: () => {},
  onCloseTab: () => {},
  onReviewTargetChange: () => {},
};

/** Base UI activates menu items from the pointer sequence, not a bare click. */
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

describe("SessionPanel", () => {
  it("shows the open tabs, offers the rest behind +, and closes one tab or all of them", async () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        open={["modal", "terminal"]}
        active="terminal"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onClose={onClose}
        sandbox={undefined}
      />,
    );
    // Each open pane is a pill that carries its own close, shown on hover.
    const tabs = within(screen.getByTestId("panel-tabs")).getAllByRole("button", {
      name: /^(Modal|Terminal)$/,
    });
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Modal", "Terminal"]);
    expect(tabs[1]?.getAttribute("aria-current")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Close Modal tab" })).toBeTruthy();
    // The Terminal is what ran; nothing has yet.
    expect(screen.getByTestId("panel-terminal").textContent).toContain("Nothing has run yet");

    fireEvent.click(screen.getByRole("button", { name: "Modal" }));
    expect(onSelectTab).toHaveBeenCalledWith("modal");

    pointerClick(screen.getByRole("button", { name: "Open another tab" }));
    const offered = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(offered).toEqual(["Review", "Pull request", "Agents", "Preview"]);
    pointerClick(screen.getByRole("menuitem", { name: "Preview" }));
    expect(onSelectTab).toHaveBeenCalledWith("preview");

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
    expect(onCloseTab).toHaveBeenCalledWith("terminal");
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists every view before any tab is open, and opens the chosen one as a tab", () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        open={[]}
        active={null}
        onSelectTab={onSelectTab}
        onClose={onClose}
        sandbox={undefined}
      />,
    );
    // No tab bar and no +: the list is the whole panel until a view is chosen.
    expect(screen.queryByTestId("panel-tabs")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open another tab" })).toBeNull();
    const launcher = within(screen.getByRole("navigation", { name: "Views" }));
    expect(launcher.getAllByRole("button").map((button) => button.textContent)).toEqual(
      PANEL_TABS.map((entry) => entry.label),
    );

    fireEvent.click(launcher.getByRole("button", { name: "Terminal" }));
    expect(onSelectTab).toHaveBeenCalledWith("terminal");
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers no + once every tab is open, and says the preview is not built yet", () => {
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        open={PANEL_TABS.map((entry) => entry.tab)}
        active="preview"
        onClose={() => {}}
        sandbox={undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open another tab" })).toBeNull();
    expect(screen.getByTestId("panel-preview").textContent).toContain(
      "Previews are not available yet.",
    );
  });

  it("shows the Modal pane's empty state before any sandbox", () => {
    render(<SessionPanel view={emptyView()} {...PANEL} onClose={() => {}} sandbox={undefined} />);
    expect(screen.getByTestId("panel-modal").textContent).toContain(
      "No sandbox has been asked for",
    );
  });

  it("shows the sandbox's state, id, sequence, and output on the Modal tab", () => {
    render(
      <SessionPanel view={emptyView()} {...PANEL} onClose={() => {}} sandbox={runningSandbox()} />,
    );
    expect(screen.getByTestId("panel-modal-phase").textContent).toBe("Running");
    expect(screen.getByTestId("panel-modal-duration").textContent).toMatch(/\d/);
    expect(screen.getByText("sb-panel")).toBeTruthy();
    const steps = [...screen.getByTestId("panel-modal-steps").querySelectorAll("li")].map(
      (item) => item.textContent,
    );
    expect(steps).toEqual([
      "Starting a sandbox · reusing the base image0s",
      "Sandbox running · sb-panel+2.4s",
    ]);
    const output = screen.getByTestId("panel-modal-output").textContent;
    expect(output).toContain("controllercreate answered in 400 ms");
    expect(output).toContain("stderrbridge retrying");
  });

  it("offers to stop only a running sandbox, and only through a dialog that says what happens", async () => {
    const onStopSandbox = vi.fn(async () => ({ ok: true }) as const);
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        onClose={() => {}}
        sandbox={runningSandbox()}
        onStopSandbox={onStopSandbox}
      />,
    );
    expect(screen.queryByTestId("stop-sandbox-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("stop-sandbox"));

    const dialog = await screen.findByTestId("stop-sandbox-dialog");
    expect(dialog.textContent).toContain("cancels the current run");
    expect(dialog.textContent).toContain("branch stay");
    expect(onStopSandbox).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("stop-sandbox-confirm"));
    await waitFor(() => expect(onStopSandbox).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("stop-sandbox-dialog")).toBeNull());
  });

  it("closes the dialog on a stop accepted but not finished, and says so in neutral words", async () => {
    const onStopSandbox = vi.fn(
      async () => ({ ok: true, notice: "Stopping the sandbox…" }) as const,
    );
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        onClose={() => {}}
        sandbox={runningSandbox()}
        onStopSandbox={onStopSandbox}
      />,
    );
    expect(screen.queryByTestId("stop-sandbox-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("stop-sandbox"));
    fireEvent.click(await screen.findByTestId("stop-sandbox-confirm"));

    await waitFor(() => expect(screen.queryByTestId("stop-sandbox-dialog")).toBeNull());
    const notice = screen.getByTestId("stop-sandbox-notice");
    expect(notice.textContent).toBe("Stopping the sandbox…");
    expect(notice.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the dialog open and says why when the stop is refused", async () => {
    const onStopSandbox = vi.fn(
      async () => ({ ok: false, message: "Modal did not answer." }) as const,
    );
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        onClose={() => {}}
        sandbox={runningSandbox()}
        onStopSandbox={onStopSandbox}
      />,
    );
    fireEvent.click(screen.getByTestId("stop-sandbox"));
    fireEvent.click(await screen.findByTestId("stop-sandbox-confirm"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Modal did not answer.");
    expect(screen.getByTestId("stop-sandbox-dialog")).toBeTruthy();
  });

  it("has no stop button once the sandbox has ended, or with nothing to stop with", () => {
    const stopped = currentSandboxAction(
      foldEvents([
        makeCommittedEvent(
          "sandbox.stopped",
          { payload: { outcome: "stopped", reason: "user_requested", checkpointId: null } },
          { sessionSequence: 1 },
        ),
      ]),
    );
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        onClose={() => {}}
        sandbox={stopped}
        onStopSandbox={async () => ({ ok: true })}
      />,
    );
    expect(screen.queryByTestId("stop-sandbox")).toBeNull();
    expect(screen.getByTestId("panel-modal-phase").textContent).toBe("Stopped");
    expect(screen.getByText("Nothing printed yet.")).toBeTruthy();
    cleanup();

    render(
      <SessionPanel view={emptyView()} {...PANEL} onClose={() => {}} sandbox={runningSandbox()} />,
    );
    expect(screen.queryByTestId("stop-sandbox")).toBeNull();
  });
});

describe("the sandbox's state on the Modal tab", () => {
  function stoppedView(outcome: "stopped" | "failed", reason: "idle" | "disappeared" | "policy") {
    return foldEvents([
      makeCommittedEvent(
        "sandbox.attached",
        { payload: { provider: "modal" }, occurredAt: T0 },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "sandbox.stopped",
        { payload: { outcome, reason, checkpointId: null }, occurredAt: T1 },
        { sessionSequence: 2 },
      ),
    ]);
  }

  function keepAliveUntil(expiresAt: string | null) {
    return makeCommittedEvent("sandbox.keepalive.updated", { payload: { expiresAt } }).payload;
  }

  it("says a sandbox stopped at idle, or lost, and the phase alone for any other stop", () => {
    const idle = stoppedView("stopped", "idle");
    const lost = stoppedView("failed", "disappeared");
    const policy = stoppedView("stopped", "policy");
    expect(sandboxStateLabel("none")).toBe("Not started");
    expect(sandboxStateLabel("stopped", idle.sandbox)).toBe("Stopped after going idle");
    expect(sandboxStateLabel("failed", lost.sandbox)).toBe("Lost");
    expect(sandboxStateLabel("stopped", policy.sandbox)).toBe("Stopped");
    // Going idle is said of a stop, never of a failure.
    expect(sandboxStateLabel("failed", idle.sandbox)).toBe("Failed");
    // A stop reason says nothing about a sandbox that is running.
    expect(sandboxStateLabel("running", idle.sandbox)).toBe("Running");

    render(
      <SessionPanel
        view={idle}
        {...PANEL}
        onClose={() => {}}
        sandbox={currentSandboxAction(idle)}
      />,
    );
    expect(screen.getByTestId("panel-modal-phase").textContent).toBe("Stopped after going idle");
    // How long it ran stays beside the reason it stopped.
    expect(screen.getByTestId("panel-modal-duration").textContent).toBe("2.4s");
    cleanup();

    render(
      <SessionPanel
        view={lost}
        {...PANEL}
        onClose={() => {}}
        sandbox={currentSandboxAction(lost)}
      />,
    );
    expect(screen.getByTestId("panel-modal-phase").textContent).toBe("Lost");
  });

  it("says until when a keep-alive holds a running sandbox, and only while it does", () => {
    const now = Date.parse(T1) + 65_000;
    const later = new Date(now + 30 * 60_000).toISOString();
    const held = { stop: null, keepAlive: keepAliveUntil(later) };
    expect(keptAliveUntil("running", held, now)).toBe(later);
    expect(
      keptAliveUntil("running", { stop: null, keepAlive: keepAliveUntil(T0) }, now),
    ).toBeNull();
    expect(
      keptAliveUntil("running", { stop: null, keepAlive: keepAliveUntil(null) }, now),
    ).toBeNull();
    expect(keptAliveUntil("running", undefined, now)).toBeNull();
    // A keep-alive outlived by its sandbox holds nothing.
    expect(keptAliveUntil("stopped", held, now)).toBeNull();
  });

  it("shows the keep-alive's end on the Modal tab while it holds", () => {
    // The tab reads the real clock, so the deadline is an hour from now.
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const view = foldEvents([
      ...runningEvents(),
      makeCommittedEvent(
        "sandbox.keepalive.updated",
        { payload: { expiresAt: until } },
        { sessionSequence: 5 },
      ),
    ]);
    render(
      <SessionPanel
        view={view}
        {...PANEL}
        onClose={() => {}}
        sandbox={currentSandboxAction(view)}
      />,
    );
    expect(screen.getByTestId("panel-modal-kept-alive").textContent).toBe(formatClockTime(until));
    cleanup();

    render(
      <SessionPanel view={emptyView()} {...PANEL} onClose={() => {}} sandbox={runningSandbox()} />,
    );
    expect(screen.queryByTestId("panel-modal-kept-alive")).toBeNull();
  });

  it("formats a deadline as the viewer's local hours and minutes", () => {
    expect(formatClockTime(new Date(2026, 8, 2, 7, 5).toISOString())).toBe("07:05");
    expect(formatClockTime(new Date(2026, 8, 2, 23, 40).toISOString())).toBe("23:40");
  });
});

describe("Keep running for an hour", () => {
  function renderPanel(
    onKeepAlive?: () => Promise<{ ok: true; expiresAt: string } | { ok: false; message: string }>,
    sandbox = runningSandbox(),
  ) {
    render(
      <SessionPanel
        view={emptyView()}
        {...PANEL}
        onClose={() => {}}
        sandbox={sandbox}
        {...(onKeepAlive ? { onKeepAlive } : {})}
      />,
    );
  }

  it("keeps a running sandbox alive without a dialog and says until when", async () => {
    const expiresAt = "2026-09-02T01:05:00.000Z";
    let answer: (value: { ok: true; expiresAt: string }) => void = () => {};
    const onKeepAlive = vi.fn(
      () =>
        new Promise<{ ok: true; expiresAt: string }>((resolve) => {
          answer = resolve;
        }),
    );
    renderPanel(onKeepAlive);

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Keep running for an hour",
    });
    fireEvent.click(button);
    expect(onKeepAlive).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    answer({ ok: true, expiresAt });
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(`Kept alive until ${formatClockTime(expiresAt)}`);
    expect(button.disabled).toBe(false);
  });

  it("says so inline when the sandbox is not running", async () => {
    renderPanel(async () => ({ ok: false, message: "The sandbox is not running." }));
    fireEvent.click(screen.getByRole("button", { name: "Keep running for an hour" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The sandbox is not running.");
  });

  it("never lets a request that throws surface as an error", async () => {
    renderPanel(async () => {
      throw new Error("offline");
    });
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Keep running for an hour",
    });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "OnCue couldn't reach the server. Try again.",
    );
    expect(button.disabled).toBe(false);
  });

  it("is offered only while the sandbox runs, and only with something to call", () => {
    const starting = currentSandboxAction(
      foldEvents([
        makeCommittedEvent(
          "sandbox.provisioning",
          { payload: { provider: "modal" } },
          { sessionSequence: 1 },
        ),
      ]),
    );
    renderPanel(async () => ({ ok: true, expiresAt: T1 }), starting);
    expect(screen.queryByRole("button", { name: "Keep running for an hour" })).toBeNull();
    cleanup();

    renderPanel(undefined);
    expect(screen.queryByRole("button", { name: "Keep running for an hour" })).toBeNull();
  });
});
