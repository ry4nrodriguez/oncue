// The session screen's subagent wiring: a subagent row and the pill open the
// Agents view, a stop sends `agent.stop` for that subagent's run and reads
// "Stopping" until its end arrives, and clearing hides finished subagents for
// this screen.

import { makeCommittedEvent } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_STILL_RUNNING, AGENT_STOP_WAIT_MS, SessionScreen } from "../SessionScreen";
import { ANSWER_TIMEOUT_MS } from "../use-commands";
import { RUNNING_AGENT, subagentFixtureEvents } from "./agent-fixture";

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  open() {
    this.readyState = WebSocket.OPEN;
    act(() => {
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  deliver(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    });
  }
}

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  cleanup();
  FakeSocket.last = null;
});

const OPEN_RUNNING = "Open subagent: Review recent pull requests, Running";

function renderWithAgents(archived = false) {
  render(
    <SessionScreen
      sessionId="sess_1"
      createSocket={(url) => new FakeSocket(url) as unknown as WebSocket}
      archived={archived}
    />,
  );
  FakeSocket.last?.open();
  for (const event of subagentFixtureEvents()) {
    FakeSocket.last?.deliver(event);
  }
}

// The whole screen renders per test, which is slow on a loaded machine.
describe("subagents on the session screen", { timeout: 30_000 }, () => {
  it("opens a subagent's detail from its row, and back to the list", () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: OPEN_RUNNING }));
    const panel = within(screen.getByTestId("session-panel"));
    expect(panel.getByTestId("panel-tab-agents").getAttribute("aria-current")).toBe("true");
    expect(panel.getByTestId("agent-detail-title").textContent).toBe("Review recent pull requests");
    // Focus follows the reader into the detail, then back to that subagent's row.
    expect(document.activeElement).toBe(panel.getByTestId("agent-detail-title"));
    fireEvent.click(panel.getByRole("button", { name: "Back to agents" }));
    expect(panel.getByTestId("agents-running")).toBeTruthy();
    expect(document.activeElement).toBe(panel.getByRole("button", { name: "View transcript" }));
  });

  it("reopens the Agents view on its list after its tab was closed on a subagent", () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: OPEN_RUNNING }));
    const panel = within(screen.getByTestId("session-panel"));
    expect(panel.getByTestId("agent-detail")).toBeTruthy();
    // Closing the only tab goes back to the list of views.
    fireEvent.click(panel.getByRole("button", { name: "Close Agents tab" }));
    fireEvent.click(panel.getByTestId("panel-open-agents"));
    expect(panel.queryByTestId("agent-detail")).toBeNull();
    expect(panel.getByTestId("agents-running")).toBeTruthy();
    // A subagent's own row still lands on that subagent.
    fireEvent.click(
      screen.getByRole("button", { name: "Open subagent: Check the flaky test, Failed" }),
    );
    expect(panel.getByTestId("agent-detail-title").textContent).toBe("Check the flaky test");
  });

  it("keeps the subagent it was on while its tab stays open, and drops it when reopened by name", () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: OPEN_RUNNING }));
    const panel = within(screen.getByTestId("session-panel"));
    // Another tab in front, then back: the detail is still there.
    fireEvent.click(panel.getByRole("button", { name: "Open another tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Modal" }));
    expect(panel.queryByTestId("panel-agents")).toBeNull();
    fireEvent.click(panel.getByTestId("panel-tab-agents"));
    expect(panel.getByTestId("agent-detail-title").textContent).toBe("Review recent pull requests");
    // Closed beside another tab and opened again from the menu: the list.
    fireEvent.click(panel.getByRole("button", { name: "Close Agents tab" }));
    fireEvent.click(panel.getByRole("button", { name: "Open another tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Agents" }));
    expect(panel.queryByTestId("agent-detail")).toBeNull();
    expect(panel.getByTestId("agents-running")).toBeTruthy();
  });

  it("offers no stop on an archived session, whose Agents view only reads", () => {
    renderWithAgents(true);
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    expect(panel.getByTestId("agents-running")).toBeTruthy();
    expect(panel.queryByRole("button", { name: /Stop subagent/ })).toBeNull();
  });

  it("the pill opens the list, and a stop sends agent.stop for the subagent's run", () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    fireEvent.click(
      panel.getByRole("button", { name: "Stop subagent: Review recent pull requests" }),
    );
    const frame = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
    expect(frame.command).toMatchObject({
      type: "agent.stop",
      runId: "run_1",
      expected: { scope: "run", state: "running" },
      payload: { agentId: RUNNING_AGENT },
    });
    // Stopping from the press; a second press sends nothing.
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    const stop = panel.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    expect(FakeSocket.last?.sent).toHaveLength(1);
  });

  it("a refused stop frees the button and says why on the subagent's row", async () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    fireEvent.click(
      panel.getByRole("button", { name: "Stop subagent: Review recent pull requests" }),
    );
    const frame = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "command.rejected",
        {
          payload: {
            commandId: frame.command.commandId as string,
            commandType: "agent.stop",
            reason: "wrong_state",
            detail: "that subagent is not running in this run",
          },
        },
        { sessionSequence: subagentFixtureEvents().length + 1 },
      ),
    );
    await vi.waitFor(() =>
      expect(panel.getByTestId("agent-stop-problem").textContent).toBe(
        "Stop subagent: Not accepted: that subagent is not running in this run.",
      ),
    );
    expect(panel.getByTestId("agent-activity").textContent).not.toBe("Stopping");
    expect(
      (panel.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("still reads Stopping after leaving the list and coming back, until the subagent's end arrives", async () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    fireEvent.click(
      panel.getByRole("button", { name: "Stop subagent: Review recent pull requests" }),
    );
    const frame = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
    const sequence = subagentFixtureEvents().length;
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "command.acknowledged",
        { payload: { commandId: frame.command.commandId as string, commandType: "agent.stop" } },
        { sessionSequence: sequence + 1 },
      ),
    );
    // Into its transcript and back: the list is a new one, and the stop is still out.
    fireEvent.click(panel.getByRole("button", { name: "View transcript" }));
    expect(panel.queryByTestId("agent-running-row")).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Back to agents" }));
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    const stop = panel.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(panel.queryByTestId("agent-stop-problem")).toBeNull();
    fireEvent.click(stop);
    expect(FakeSocket.last?.sent).toHaveLength(1);
    // Another tab in front and back again, the same.
    fireEvent.click(panel.getByRole("button", { name: "Open another tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Modal" }));
    fireEvent.click(panel.getByTestId("panel-tab-agents"));
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");

    // Its end moves it to Finished, as Stopped.
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "agent.completed",
        {
          payload: {
            agentId: RUNNING_AGENT,
            status: "cancelled",
            usage: { tokens: 67_500, toolCalls: 1, durationMs: 12_000 },
            resultSummary: null,
          },
        },
        { sessionSequence: sequence + 2 },
      ),
    );
    await vi.waitFor(() => expect(panel.queryByTestId("agent-running-row")).toBeNull());
    expect(panel.getAllByTestId("agent-finished-row")[0]?.textContent).toContain(
      "Review recent pull requests",
    );
    expect(panel.getAllByTestId("agent-finished-row")[0]?.textContent).toContain("Stopped");
  });

  it("a stop nothing answered frees the button and says so, and the retry is the same command", async () => {
    vi.useFakeTimers();
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    fireEvent.click(
      panel.getByRole("button", { name: "Stop subagent: Review recent pull requests" }),
    );
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    // Away from the list while the answer is awaited, so the list that says why is a new one.
    fireEvent.click(panel.getByRole("button", { name: "View transcript" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    });
    fireEvent.click(panel.getByRole("button", { name: "Back to agents" }));
    expect(panel.getByTestId("agent-activity").textContent).not.toBe("Stopping");
    expect(panel.getByTestId("agent-stop-problem").textContent).toBe(
      "Stop subagent: OnCue didn't answer in time. Try again.",
    );
    const stop = panel.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    // The second press is the first command again, so the object stops it at most once.
    fireEvent.click(stop);
    const sent = (FakeSocket.last?.sent ?? []).map((frame) => JSON.parse(frame).command.commandId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    expect(panel.queryByTestId("agent-stop-problem")).toBeNull();
  });

  /** Presses Stop on the running subagent and delivers the object's acceptance. */
  async function stopAndAcknowledge(sequence: number) {
    const panel = within(screen.getByTestId("session-panel"));
    fireEvent.click(panel.getByRole("button", { name: /Stop subagent/ }));
    const frame = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "command.acknowledged",
        { payload: { commandId: frame.command.commandId as string, commandType: "agent.stop" } },
        { sessionSequence: sequence },
      ),
    );
    // The acceptance reaches the stop's own wait a microtask later.
    await act(async () => {});
    return frame.command.commandId as string;
  }

  it("gives the stop back when an accepted one has not ended the subagent in time, for a second stop", async () => {
    vi.useFakeTimers();
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    const sequence = subagentFixtureEvents().length;
    const first = await stopAndAcknowledge(sequence + 1);
    const stop = () => panel.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement;

    // Accepted, and still stopping right up to the end of the wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_STOP_WAIT_MS - 1);
    });
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    expect(stop().disabled).toBe(true);
    expect(panel.queryByTestId("agent-stop-problem")).toBeNull();

    // Nothing ended it: the button is back, and the row says why.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(panel.getByTestId("agent-activity").textContent).toBe("Running a command");
    expect(stop().disabled).toBe(false);
    expect(panel.getByTestId("agent-stop-problem").textContent).toBe(
      `Stop subagent: ${AGENT_STILL_RUNNING}`,
    );

    // The second press is a new stop, which the bridge acts on again.
    const second = await stopAndAcknowledge(sequence + 2);
    expect(FakeSocket.last?.sent).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}").command).toMatchObject({
      type: "agent.stop",
      payload: { agentId: RUNNING_AGENT },
    });
    expect(panel.getByTestId("agent-activity").textContent).toBe("Stopping");
    expect(stop().disabled).toBe(true);
    expect(panel.queryByTestId("agent-stop-problem")).toBeNull();
  });

  it("says nothing more once the subagent's end arrives inside the wait", async () => {
    vi.useFakeTimers();
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    const sequence = subagentFixtureEvents().length;
    await stopAndAcknowledge(sequence + 1);
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "agent.completed",
        {
          payload: {
            agentId: RUNNING_AGENT,
            status: "cancelled",
            usage: { tokens: 67_500, toolCalls: 1, durationMs: 12_000 },
            resultSummary: null,
          },
        },
        { sessionSequence: sequence + 2 },
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_STOP_WAIT_MS * 2);
    });
    expect(panel.queryByTestId("agent-running-row")).toBeNull();
    expect(panel.queryByTestId("agent-stop-problem")).toBeNull();
    expect(panel.getAllByTestId("agent-finished-row")[0]?.textContent).toContain("Stopped");
  });

  it("clears finished subagents from the list, and keeps the running one", () => {
    renderWithAgents();
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    const panel = within(screen.getByTestId("session-panel"));
    expect(panel.getAllByTestId("agent-finished-row")).toHaveLength(2);
    fireEvent.click(panel.getByRole("button", { name: "Clear finished subagents" }));
    expect(panel.queryAllByTestId("agent-finished-row")).toHaveLength(0);
    expect(panel.getByTestId("agent-running-row")).toBeTruthy();
  });
});
