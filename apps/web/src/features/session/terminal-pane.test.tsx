import { applyLiveEvent, emptyView, foldEvents } from "@oncue/protocol";
import { makeCommittedEvent, makeEvent } from "@oncue/protocol/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commandLine, consoleEntries, TerminalPane } from "./TerminalPane";

afterEach(cleanup);

// The pane scrolls through use-stick-to-bottom, which needs ResizeObserver; jsdom has none.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const T0 = "2026-09-02T00:00:00.000Z";
const T1 = "2026-09-02T00:00:05.000Z";
const T2 = "2026-09-02T00:00:09.000Z";

/** A shell call that finished, a read that has not started, and a check that passed. */
function ranView() {
  return foldEvents([
    makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
    makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
    makeCommittedEvent(
      "tool.requested",
      {
        payload: {
          toolCallId: "tool_1",
          category: "shell",
          title: "Run the unit tests",
          input: { command: "pnpm test" },
        },
        occurredAt: T0,
      },
      { sessionSequence: 3 },
    ),
    makeCommittedEvent(
      "tool.started",
      { payload: { toolCallId: "tool_1" } },
      { sessionSequence: 4 },
    ),
    makeCommittedEvent(
      "tool.completed",
      { payload: { toolCallId: "tool_1", durationMs: 1700, exitCode: 0 } },
      { sessionSequence: 5 },
    ),
    makeCommittedEvent(
      "tool.requested",
      {
        payload: { toolCallId: "tool_2", category: "file_read", title: "Read src/app.ts" },
        occurredAt: T1,
      },
      { sessionSequence: 6 },
    ),
    makeCommittedEvent(
      "verification.started",
      { payload: { checkId: "chk_1", name: "typecheck" }, occurredAt: T2 },
      { sessionSequence: 7 },
    ),
    makeCommittedEvent(
      "verification.result",
      {
        payload: { checkId: "chk_1", result: "passed", summary: "no type errors", durationMs: 800 },
      },
      { sessionSequence: 8 },
    ),
  ]);
}

describe("consoleEntries and commandLine", () => {
  it("lists every call and every started check, oldest first", () => {
    const entries = consoleEntries(ranView());
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "tool", "check"]);
    expect(entries.map((entry) => entry.at)).toEqual([T0, T1, T2]);
  });

  it("leaves out a check that has not started", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 2 }),
    ]);
    const check = [...view.verification.checks.values()][0];
    expect(check).toBeDefined();
    const started = { ...(check as NonNullable<typeof check>), latest: null, attempts: [] };
    const unstarted = {
      ...view,
      verification: { ...view.verification, checks: new Map([[started.checkId, started]]) },
    };
    expect(consoleEntries(unstarted)).toEqual([]);
  });

  it("reads a shell call as its command and anything else as the runtime's title", () => {
    expect(
      commandLine({
        category: "shell",
        title: "Run the unit tests",
        input: { command: "pnpm test" },
      }),
    ).toBe("pnpm test");
    expect(
      commandLine({ category: "shell", title: "Run something", input: { command: "  " } }),
    ).toBe("Run something");
    expect(commandLine({ category: "shell", title: "Run something", input: { command: 42 } })).toBe(
      "Run something",
    );
    expect(
      commandLine({
        category: "file_read",
        title: "Read src/app.ts",
        input: { path: "src/app.ts" },
      }),
    ).toBe("Read src/app.ts");
  });
});

describe("TerminalPane", () => {
  it("says nothing has run before anything has", () => {
    render(<TerminalPane view={emptyView()} sessionId="sess_1" />);
    expect(screen.getByTestId("console-empty").textContent).toContain("Nothing has run yet");
  });

  it("draws each call as a command line with how it ended, and each check with its result", () => {
    render(<TerminalPane view={ranView()} sessionId="sess_1" />);
    const entries = screen.getAllByTestId("console-entry");
    expect(entries).toHaveLength(3);

    const [shell, read, check] = entries as [HTMLElement, HTMLElement, HTMLElement];
    expect(shell.getAttribute("data-kind")).toBe("tool");
    expect(shell.getAttribute("data-state")).toBe("completed");
    expect(shell.textContent).toContain("pnpm test");
    expect(shell.textContent).toContain("exit 0");
    expect(shell.textContent).toMatch(/1\.7s|1700/);

    // Requested but never started: waiting, not running.
    expect(read.getAttribute("data-state")).toBe("requested");
    expect(read.textContent).toContain("Read src/app.ts");
    expect(read.textContent).toContain("waiting");

    expect(check.getAttribute("data-kind")).toBe("check");
    expect(check.getAttribute("data-state")).toBe("passed");
    expect(check.textContent).toContain("typecheck");
    expect(check.textContent).toContain("passed");
    expect(check.textContent).toContain("no type errors");
    // No `$`: a check is not something the agent typed.
    expect(check.textContent?.startsWith("$")).toBe(false);
  });

  it("streams a running call's output with a live cursor, and settles it once the call ends", () => {
    let view = foldEvents([
      makeCommittedEvent(
        "tool.requested",
        { payload: { toolCallId: "tool_1", category: "shell", input: { command: "pnpm build" } } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.started",
        { payload: { toolCallId: "tool_1" } },
        { sessionSequence: 2 },
      ),
    ]);
    view = applyLiveEvent(
      view,
      makeEvent("tool.output", { payload: { toolCallId: "tool_1", text: "compiling 12 files\n" } }),
    );
    const { rerender } = render(<TerminalPane view={view} sessionId="sess_1" />);
    const entry = screen.getByTestId("console-entry");
    expect(entry.getAttribute("data-state")).toBe("running");
    expect(entry.textContent).toContain("running");
    expect(screen.getByTestId("console-output").textContent).toContain("compiling 12 files");
    expect(screen.getByTestId("console-cursor")).toBeTruthy();

    const ended = foldEvents([
      makeCommittedEvent(
        "tool.requested",
        { payload: { toolCallId: "tool_1", category: "shell", input: { command: "pnpm build" } } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.started",
        { payload: { toolCallId: "tool_1" } },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent(
        "tool.failed",
        { payload: { toolCallId: "tool_1", category: "timeout" } },
        { sessionSequence: 3 },
      ),
    ]);
    rerender(<TerminalPane view={ended} sessionId="sess_1" />);
    expect(screen.getByTestId("console-entry").getAttribute("data-state")).toBe("failed");
    expect(screen.getByTestId("console-entry").textContent).toContain("Timed out");
    expect(screen.queryByTestId("console-cursor")).toBeNull();
  });

  // The bridge puts a call's output in its result, not in `tool.output`.
  it("prints a settled call's output from its result, and claims no loss when it has it", () => {
    const view = foldEvents([
      makeCommittedEvent(
        "tool.requested",
        { payload: { toolCallId: "tool_1", category: "shell", input: { command: "pnpm test" } } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "tool.started",
        { payload: { toolCallId: "tool_1" } },
        { sessionSequence: 2 },
      ),
      makeCommittedEvent(
        "tool.completed",
        {
          payload: {
            toolCallId: "tool_1",
            result: { kind: "inline", summary: "pnpm test", value: { output: "12 passed\n" } },
          },
        },
        { sessionSequence: 3 },
      ),
    ]);
    // A tail this client lost to a reconnect, which the result makes whole.
    const tool = view.tools.get("tool_1" as never);
    const lossy =
      tool === undefined
        ? view
        : {
            ...view,
            tools: new Map(view.tools).set(tool.toolCallId, { ...tool, outputDropped: true }),
          };
    render(<TerminalPane view={lossy} sessionId="sess_1" />);
    expect(screen.getByTestId("console-output").textContent).toContain("12 passed");
    expect(screen.getByTestId("console-entry").textContent).not.toContain("no longer available");
  });
});
