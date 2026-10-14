import { foldEvents, type SessionView } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Timeline } from "../Timeline";
import { AgentLaunchRow, RunningAgentsPill } from "./AgentLaunchRow";
import { AgentsPane, type AgentsPaneProps } from "./AgentsPane";
import {
  DONE_AGENT,
  FAILED_AGENT,
  LONG_PROMPT,
  RUNNING_AGENT,
  subagentFixtureEvents,
} from "./agent-fixture";
import {
  agentActivity,
  agentElapsedMs,
  agentEndedAt,
  agentTokens,
  agentToolCount,
  agentTypeWord,
  finishedAgents,
  formatTokens,
  formatToolUses,
  modelName,
  runningAgents,
  runningAgentsLabel,
} from "./agent-model";

afterEach(cleanup);

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const CONNECTIONS = [
  {
    modelConnectionId: "conn_1",
    label: "Anthropic",
    models: [
      {
        modelId: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        effort: null,
        defaultEffort: null,
        price: { inputPerMTok: 3, outputPerMTok: 15 },
        status: "current" as const,
        recommended: false,
      },
    ],
  },
];

function view(options: { runEnded?: boolean } = {}): SessionView {
  return foldEvents(subagentFixtureEvents(undefined, options));
}

function agentOf(current: SessionView, agentId: string) {
  const agent = current.agents.get(agentId as never);
  if (agent === undefined) {
    throw new Error(`no ${agentId}`);
  }
  return agent;
}

function pane(overrides: Partial<AgentsPaneProps> = {}) {
  const props: AgentsPaneProps = {
    view: view(),
    sessionId: "sess_1",
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onStopAgent: vi.fn(),
    cleared: new Set(),
    onClearFinished: vi.fn(),
    modelConnections: CONNECTIONS,
    ...overrides,
  };
  render(<AgentsPane {...props} />);
  return props;
}

/** The pane as the screen holds it: the selection is state above it. */
function StatefulPane(props: Partial<AgentsPaneProps> & { readonly start?: string | null }) {
  const { start = null, ...rest } = props;
  const [selected, setSelected] = useState<string | null>(start);
  return (
    <AgentsPane
      view={view()}
      sessionId="sess_1"
      cleared={new Set()}
      onClearFinished={() => undefined}
      modelConnections={CONNECTIONS}
      {...rest}
      selectedAgentId={selected}
      onSelectAgent={setSelected}
    />
  );
}

describe("agent-model", () => {
  it("sorts the run's subagents into running and finished, newest first, less the cleared", () => {
    const current = view();
    expect(runningAgents(current).map((agent) => agent.agentId)).toEqual([RUNNING_AGENT]);
    expect(finishedAgents(current, new Set()).map((agent) => agent.agentId)).toEqual([
      FAILED_AGENT,
      DONE_AGENT,
    ]);
    expect(finishedAgents(current, new Set([FAILED_AGENT])).map((a) => a.agentId)).toEqual([
      DONE_AGENT,
    ]);
    // A subagent its ended run took with it is finished, not running.
    expect(runningAgents(view({ runEnded: true }))).toEqual([]);
  });

  it("measures a subagent that never reported its end up to its run's end, not to now", () => {
    // Started nine seconds in; its run was cancelled at twenty with no `agent.completed`.
    const ended = view({ runEnded: true });
    const lost = agentOf(ended, RUNNING_AGENT);
    expect(lost.endedAt).toBeNull();
    expect(agentEndedAt(ended, lost)).toBe("2026-10-04T12:00:20.000Z");
    const anHourLater = Date.parse("2026-10-04T13:00:20.000Z");
    expect(agentElapsedMs(ended, lost, anHourLater)).toBe(11_000);
    // Its own reported end wins over the run's.
    const done = agentOf(ended, DONE_AGENT);
    expect(agentEndedAt(ended, done)).toBe("2026-10-04T12:00:06.000Z");
    expect(agentElapsedMs(ended, done, anHourLater)).toBe(4_000);
    // While its run goes on, the clock is live.
    const current = view();
    const running = agentOf(current, RUNNING_AGENT);
    expect(agentEndedAt(current, running)).toBeNull();
    expect(agentElapsedMs(current, running, Date.parse("2026-10-04T12:00:30.000Z"))).toBe(21_000);
    expect(agentElapsedMs(current, running, 0)).toBe(0);
  });

  it("says what a subagent is doing, what it has spent, and how many calls it made", () => {
    const current = view();
    expect(agentActivity(current, agentOf(current, RUNNING_AGENT))).toBe("Running a command");
    expect(agentActivity(current, agentOf(current, DONE_AGENT))).toBe("Thinking");
    expect(agentTokens(current, agentOf(current, RUNNING_AGENT))).toBe(67_500);
    expect(agentTokens(current, agentOf(current, DONE_AGENT))).toBe(900);
    // While it runs, what its answers spent, cache included, never their context size.
    const running = agentOf(current, RUNNING_AGENT);
    const firstMessage = running.timeline.find((item) => item.kind === "message");
    if (firstMessage?.kind === "message") {
      const messages = new Map(current.messages);
      const message = messages.get(firstMessage.messageId as never);
      messages.set(firstMessage.messageId as never, {
        ...(message as NonNullable<typeof message>),
        usage: {
          usedTokens: 50_000,
          maxTokens: 200_000,
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 40_000,
          cacheWriteTokens: 100,
          reasoningTokens: 5,
          spent: {
            inputTokens: 30,
            outputTokens: 40,
            cachedInputTokens: 80_000,
            cacheWriteTokens: 200,
            reasoningTokens: 10,
          },
        },
      });
      const withSpent = { ...current, messages } as SessionView;
      const others =
        agentTokens(current, running) -
        (message?.usage?.inputTokens ?? 0) -
        (message?.usage?.outputTokens ?? 0);
      expect(agentTokens(withSpent, { ...running, usage: null })).toBe(others + 80_280);
    }
    // An end that reports nothing, as the session's own does for a lost sandbox, keeps what was seen.
    const seen = { ...running, usage: null };
    const ended = { ...running, usage: { tokens: 0, toolCalls: 0, durationMs: 21_000 } };
    expect(agentTokens(current, ended)).toBe(agentTokens(current, seen));
    expect(agentToolCount(current, ended)).toBe(agentToolCount(current, seen));
    expect(agentToolCount(current, seen)).toBeGreaterThan(0);
    expect(agentToolCount(current, { ...ended, usage: { ...ended.usage, toolCalls: 99 } })).toBe(
      99,
    );
    expect(formatTokens(67_500)).toBe("67.5k tokens");
    expect(formatTokens(250_000)).toBe("250k tokens");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(820)).toBe("820 tokens");
    expect(formatToolUses(1)).toBe("1 tool use");
    expect(formatToolUses(2)).toBe("2 tool uses");
    expect(runningAgentsLabel(1)).toBe("1 running agent");
    expect(runningAgentsLabel(3)).toBe("3 running agents");
    expect(agentTypeWord("explore")).toBe("Explore");
    expect(agentTypeWord("")).toBe("");
  });

  it("names the model from the workspace's catalog, else by its id", () => {
    const model = { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" };
    expect(modelName(model, CONNECTIONS)).toBe("Claude Sonnet 4.5");
    expect(modelName({ ...model, modelId: "other" }, CONNECTIONS)).toBe("other");
    expect(modelName(model, [{ modelConnectionId: "c", label: "x" }])).toBe(model.modelId);
    expect(modelName(null, CONNECTIONS)).toBeNull();
  });
});

describe("the timeline", () => {
  it("draws each call that started a subagent as one row of its own, and nothing of the subagent's work", () => {
    const onOpenAgent = vi.fn();
    const onOpenAgents = vi.fn();
    render(<Timeline view={view()} onOpenAgent={onOpenAgent} onOpenAgents={onOpenAgents} />);
    const rows = screen.getAllByTestId("row-agent");
    // The running row's word is in the row for reduced motion alone; the stylesheet hides it otherwise.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Read the deployment notes",
      "Check the flaky testFailed",
      "Review recent pull requestsRunning",
    ]);
    expect(within(rows[2] as HTMLElement).getByTestId("row-agent-status").className).toContain(
      "hidden motion-reduce:inline",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("row-agent-status").className).not.toContain(
      "hidden",
    );
    // The subagents' own words and calls stay in the side panel.
    expect(screen.queryByText("Deploys run through")).toBeNull();
    expect(screen.queryByText("gh pr list --state all")).toBeNull();
    // The row's name says what the shimmer shows, and nothing once it rests.
    fireEvent.click(
      screen.getByRole("button", { name: "Open subagent: Review recent pull requests, Running" }),
    );
    expect(onOpenAgent).toHaveBeenCalledWith(RUNNING_AGENT);
    expect(screen.getByRole("button", { name: "Open subagent: Check the flaky test, Failed" }));
    expect(screen.getByRole("button", { name: "Open subagent: Read the deployment notes" }));
    fireEvent.click(screen.getByRole("button", { name: "1 running agent" }));
    expect(onOpenAgents).toHaveBeenCalled();
  });

  it("puts the pill on the line that says what the agent is doing now, else on its own", () => {
    // Nothing of the primary agent's is under way: the pill has its own line.
    render(<Timeline view={view()} onOpenAgents={() => undefined} />);
    expect(
      within(screen.getByTestId("running-agents")).getByTestId("running-agents-pill"),
    ).toBeTruthy();
    expect(screen.queryByTestId("activity-line")).toBeNull();
    cleanup();

    // The primary agent runs a command while its subagent works: one line holds both.
    const working = foldEvents(subagentFixtureEvents(undefined, { primaryWorking: true }));
    const onOpenAgents = vi.fn();
    render(<Timeline view={working} onOpenAgents={onOpenAgents} />);
    const line = within(screen.getByTestId("activity-line"));
    expect(line.getByTestId("activity-trigger").textContent).toContain("pnpm test");
    expect(screen.getAllByTestId("running-agents-pill")).toHaveLength(1);
    expect(screen.queryByTestId("running-agents")).toBeNull();
    // The pill is its own control beside the line, not part of the line's button.
    expect(
      line.getByTestId("activity-trigger").contains(line.getByTestId("running-agents-pill")),
    ).toBe(false);
    fireEvent.click(line.getByRole("button", { name: "1 running agent" }));
    expect(onOpenAgents).toHaveBeenCalled();
    // Opening the Agents view from the pill does not open the group it stands beside.
    expect(screen.getAllByTestId("row-activity").at(-1)?.getAttribute("data-open")).toBe("false");
  });

  it("draws a start that never became a subagent as the failed call it is", () => {
    // A refused start: the call fails with no `agent.started` behind it.
    const events = subagentFixtureEvents();
    const refusedEvents = [
      ...events,
      makeCommittedEvent(
        "tool.requested",
        {
          eventId: "evt_refused_request",
          payload: {
            toolCallId: "call_refused",
            category: "other",
            title: "Pick up the earlier review",
            runtimeName: "task",
            input: { description: "Pick up the earlier review", subagent_type: "general" },
            inputComplete: true,
          },
        },
        { sessionSequence: events.length + 1 },
      ),
      makeCommittedEvent(
        "tool.failed",
        {
          eventId: "evt_refused_failed",
          payload: {
            toolCallId: "call_refused",
            errorText: "A subagent cannot be resumed.",
            category: "runtime_error",
          },
        },
        { sessionSequence: events.length + 2 },
      ),
    ];
    render(<Timeline view={foldEvents(refusedEvents)} onOpenAgent={() => undefined} />);
    // No row to open and nothing more counted as running: an ordinary failed
    // call in a group of the primary agent's work.
    expect(screen.getAllByTestId("row-agent")).toHaveLength(3);
    expect(screen.getByTestId("running-agents-pill").textContent).toBe("1 running agent");
    const group = screen.getAllByTestId("row-activity").at(-1) as HTMLElement;
    const call = within(group).getByTestId("row-tool");
    expect(call.textContent).toContain("Pick up the earlier review");
    expect(call.getAttribute("data-state-kind")).toBe("failed");
    cleanup();

    // Once the run has ended, the group says so in its summary.
    const ended = foldEvents([
      ...refusedEvents,
      makeCommittedEvent("run.cancelled", {}, { sessionSequence: refusedEvents.length + 1 }),
    ]);
    render(<Timeline view={ended} />);
    expect(screen.getAllByTestId("activity-trigger").at(-1)?.textContent).toContain("(1 failed)");
    expect(screen.getAllByTestId("row-agent")).toHaveLength(3);
  });

  it("shows no pill once nothing runs, and a row that does not open on a read-only surface", () => {
    const ended = view({ runEnded: true });
    render(<Timeline view={ended} />);
    expect(screen.queryByTestId("running-agents-pill")).toBeNull();
    const stopped = screen.getAllByTestId("row-agent").at(-1);
    expect(stopped?.tagName).toBe("DIV");
    expect(stopped?.getAttribute("data-status")).toBe("cancelled");
    expect(stopped?.textContent).toContain("Stopped");
  });

  it("the pill and the row read without a handler too", () => {
    render(<RunningAgentsPill count={2} label="2 running agents" />);
    expect(screen.getByTestId("running-agents-pill").tagName).toBe("SPAN");
    cleanup();
    const { container } = render(<RunningAgentsPill count={0} label="none" />);
    expect(container.textContent).toBe("");
    cleanup();
    const current = view();
    render(<AgentLaunchRow view={current} agent={agentOf(current, DONE_AGENT)} />);
    expect(screen.getByTestId("row-agent").getAttribute("data-status")).toBe("completed");
  });
});

describe("the Agents view", () => {
  it("lists running subagents with their type, model, spend, activity, and a stop", () => {
    const props = pane();
    const running = within(screen.getByTestId("agents-running"));
    const row = running.getByTestId("agent-running-row");
    expect(row.textContent).toContain("Review recent pull requests");
    // Its type and duration, then its facts, each line's parts set apart by a dot.
    expect(row.textContent).toMatch(/General·\d/);
    expect(row.textContent).toContain(
      "Claude Sonnet 4.5·67.5k tokens·1 tool use·Running a command",
    );
    expect(running.getByTestId("agent-activity").textContent).toBe("Running a command");
    fireEvent.click(
      running.getByRole("button", { name: "Stop subagent: Review recent pull requests" }),
    );
    expect(props.onStopAgent).toHaveBeenCalledWith(RUNNING_AGENT);
    fireEvent.click(running.getByRole("button", { name: "View transcript" }));
    expect(props.onSelectAgent).toHaveBeenCalledWith(RUNNING_AGENT);
  });

  it("reads Stopping while a stop is out, says why one failed, and hides the stop when nothing can stop", () => {
    pane({ stopping: new Set([RUNNING_AGENT]) });
    expect(screen.getByTestId("agent-activity").textContent).toBe("Stopping");
    expect(
      (screen.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    pane({
      stopProblems: new Map([
        [RUNNING_AGENT, "Not sent: OnCue is reconnecting. Try again in a moment."],
      ]),
    });
    expect(screen.getByTestId("agent-activity").textContent).toBe("Running a command");
    expect(screen.getByTestId("agent-stop-problem").textContent).toBe(
      "Stop subagent: Not sent: OnCue is reconnecting. Try again in a moment.",
    );
    expect(
      (screen.getByRole("button", { name: /Stop subagent/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
    pane({ onStopAgent: undefined });
    expect(screen.queryByRole("button", { name: /Stop subagent/ })).toBeNull();
  });

  it("lists finished subagents with their status, folds them, and clears them", () => {
    const props = pane();
    const finished = within(screen.getByTestId("agents-finished"));
    expect(finished.getByTestId("agents-finished-toggle").textContent).toContain("Finished 2");
    expect(finished.getAllByTestId("agent-finished-row").map((row) => row.textContent)).toEqual([
      "Check the flaky testGeneralFailed",
      "Read the deployment notesExploreCompleted",
    ]);
    fireEvent.click(finished.getByRole("button", { name: "Clear finished subagents" }));
    expect(props.onClearFinished).toHaveBeenCalledWith([FAILED_AGENT, DONE_AGENT]);
    fireEvent.click(finished.getAllByTestId("agent-finished-row")[1] as HTMLElement);
    expect(props.onSelectAgent).toHaveBeenCalledWith(DONE_AGENT);
    fireEvent.click(finished.getByTestId("agents-finished-toggle"));
    expect(screen.queryAllByTestId("agent-finished-row")).toHaveLength(0);
  });

  it("says when there is nothing to show", () => {
    pane({
      cleared: new Set([DONE_AGENT, FAILED_AGENT, RUNNING_AGENT]),
      view: view({ runEnded: true }),
    });
    expect(screen.getByTestId("agents-empty").textContent).toContain("No subagents yet");
  });

  it("opens one subagent: its model, its prompt folded, its steps, and back", () => {
    const props = pane({ selectedAgentId: RUNNING_AGENT });
    expect(screen.getByTestId("agent-detail-title").textContent).toBe(
      "Review recent pull requests",
    );
    expect(screen.getByTestId("agent-detail-meta").textContent).toMatch(
      /^Model Claude Sonnet 4\.5·General·Running \S+/,
    );
    const prompt = screen.getByTestId("agent-prompt");
    expect(prompt.querySelector("[data-expanded]")?.getAttribute("data-expanded")).toBe("false");
    const toggle = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(prompt.textContent).toContain("Keep the report under about 1,200 words.");
    // Its steps fold like the main timeline's, and the running call is the live headline.
    const steps = within(screen.getByTestId("agent-steps"));
    expect(steps.getByText("Fetching the list first.")).toBeTruthy();
    expect(steps.getByTestId("row-activity").textContent).toContain("gh pr list --state all");
    expect(screen.queryByTestId("agent-result")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
    expect(props.onSelectAgent).toHaveBeenCalledWith(null);
    expect(LONG_PROMPT.length).toBeGreaterThan(480);
  });

  it("shows what a finished subagent reported, or why it reported nothing", () => {
    pane({ selectedAgentId: DONE_AGENT });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByTestId("agent-result").textContent).toContain("What it reported");
    expect(screen.getByTestId("agent-result").textContent).toContain("migrations go first");
    cleanup();
    // A report that only repeats its last words, which the steps show, is not said twice.
    const current = view();
    const done = agentOf(current, DONE_AGENT);
    const repeating = {
      ...current,
      agents: new Map(current.agents).set(DONE_AGENT as never, {
        ...done,
        resultSummary: "Deploys run through `pnpm deploy:hosted`.",
      }),
    };
    pane({ view: repeating, selectedAgentId: DONE_AGENT });
    expect(screen.queryByTestId("agent-result")).toBeNull();
    cleanup();
    pane({ selectedAgentId: FAILED_AGENT });
    expect(screen.getByTestId("agent-result").textContent).toContain("Failed");
    expect(screen.queryByTestId("agent-steps-waiting")).toBeNull();
    cleanup();
    const ended = view({ runEnded: true });
    pane({ view: ended, selectedAgentId: RUNNING_AGENT });
    expect(screen.getByTestId("agent-result").textContent).toContain(
      "It was stopped before it reported back.",
    );
  });

  it("shows how long a subagent ran when its run ended without its report", () => {
    pane({ view: view({ runEnded: true }), selectedAgentId: RUNNING_AGENT });
    // Nine seconds in to the run's end at twenty, however much later it is read.
    expect(screen.getByTestId("agent-detail-meta").textContent).toBe(
      "Model Claude Sonnet 4.5·General·Stopped 11s",
    );
    expect(screen.getByTestId("agent-detail-elapsed").textContent).toBe("11s");
  });

  it("moves focus to the detail's heading when it opens, and back to the row it came from", () => {
    render(<StatefulPane />);
    const transcript = screen.getByRole("button", { name: "View transcript" });
    transcript.focus();
    fireEvent.click(transcript);
    expect(document.activeElement).toBe(screen.getByTestId("agent-detail-title"));
    fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View transcript" }));

    // A finished row is its own way in, and the way back lands on it.
    const finished = screen.getAllByTestId("agent-finished-row")[1] as HTMLElement;
    fireEvent.click(finished);
    expect(screen.getByTestId("agent-detail-title").textContent).toBe("Read the deployment notes");
    expect(document.activeElement).toBe(screen.getByTestId("agent-detail-title"));
    fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
    expect(document.activeElement).toBe(screen.getAllByTestId("agent-finished-row")[1]);
    expect(document.activeElement?.textContent).toContain("Read the deployment notes");
  });

  it("keeps focus in the pane when the row it came from is no longer listed", () => {
    // Opened from the timeline after the reader cleared it from the finished list.
    render(<StatefulPane start={DONE_AGENT} cleared={new Set([DONE_AGENT])} />);
    expect(document.activeElement).toBe(screen.getByTestId("agent-detail-title"));
    fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
    expect(document.activeElement).toBe(screen.getByTestId("panel-agents"));
  });

  it("does not move focus when the list is shown without coming back from a detail", () => {
    const { rerender } = render(<button type="button">Elsewhere</button>);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    // The pill or the launcher opens the list while focus is on another control.
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StatefulPane />
      </>,
    );
    expect(screen.getByTestId("agents-running")).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("starts each subagent's detail fresh: an opened prompt does not carry over", () => {
    // Two subagents with prompts long enough to fold.
    const current = view();
    const both = {
      ...current,
      agents: new Map(current.agents).set(DONE_AGENT as never, {
        ...agentOf(current, DONE_AGENT),
        prompt: LONG_PROMPT,
      }),
    } as SessionView;
    const props = {
      view: both,
      sessionId: "sess_1",
      onSelectAgent: () => undefined,
      cleared: new Set<string>(),
      onClearFinished: () => undefined,
      modelConnections: CONNECTIONS,
    };
    const { rerender } = render(<AgentsPane {...props} selectedAgentId={RUNNING_AGENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    // The timeline's row for another subagent swaps the detail in place.
    rerender(<AgentsPane {...props} selectedAgentId={DONE_AGENT} />);
    expect(screen.getByTestId("agent-detail-title").textContent).toBe("Read the deployment notes");
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(screen.getByTestId("agent-detail-title"));
  });

  it("falls back to the list for a subagent it does not know, and says when one is starting", () => {
    pane({ selectedAgentId: "ses_unknown" });
    expect(screen.getByTestId("agents-running")).toBeTruthy();
    cleanup();
    const current = view();
    const empty = {
      ...current,
      agents: new Map([
        [
          "ses_new" as never,
          {
            ...agentOf(current, RUNNING_AGENT),
            agentId: "ses_new" as never,
            timeline: [],
            prompt: "",
          },
        ],
      ]),
    };
    pane({ view: empty, selectedAgentId: "ses_new" });
    expect(screen.getByTestId("agent-steps-waiting").textContent).toBe("Starting");
    expect(screen.queryByTestId("agent-prompt")).toBeNull();
  });
});
