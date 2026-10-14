import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SquareTerminal } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionRow, type ActionRowProps, OUTPUT_PREVIEW_LINES } from "./ActionRow";
import { formatDuration } from "./actions";

afterEach(cleanup);

// jsdom cannot show that the row expands under a real mouse or that the mark
// paints; `e2e/session-actions.spec.ts` covers that.
function renderRow(overrides: Partial<ActionRowProps> = {}) {
  const props: ActionRowProps = {
    mark: SquareTerminal,
    label: "Cloning acme/oncue",
    state: "completed",
    failure: null,
    steps: [],
    facts: [{ label: "Exit code", value: "0" }],
    input: { command: "git clone" },
    output: {
      title: "Output",
      lines: [{ tag: null, text: "Cloning into 'oncue'..." }],
      dropped: false,
    },
    testId: "row-tool",
    ...overrides,
  };
  render(<ActionRow {...props} />);
  return props;
}

describe("the action row", () => {
  it("hides its detail until the row is opened", () => {
    renderRow();
    const trigger = screen.getByRole("button");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("action-panel")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByTestId("action-panel");
    expect(panel.textContent).toContain("Exit code");
    expect(panel.textContent).toContain("Cloning into 'oncue'");
  });

  it("says output is missing rather than drawing an empty terminal", () => {
    renderRow({ output: { title: "Output", lines: [], dropped: true } });
    fireEvent.click(screen.getByRole("button"));

    const panel = screen.getByTestId("action-panel");
    // The call's own code block aside, nothing draws an output box.
    const boxes = [...panel.querySelectorAll("pre")].filter(
      (pre) => pre.closest("[data-code-block]") === null,
    );
    expect(boxes).toEqual([]);
    expect(panel.textContent).toContain("no longer available");
  });

  it("stays silent about output when the tail is whole", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByTestId("action-panel").textContent).not.toContain("no longer available");
  });

  it("omits the sections a row has nothing to put in", () => {
    renderRow({ facts: [], input: null, output: null });
    fireEvent.click(screen.getByRole("button"));

    const panel = screen.getByTestId("action-panel");
    expect(panel.querySelector("dl")).toBeNull();
    expect(panel.textContent).toBe("");
  });

  it("names the failure in the row's accessible name and beside the label", () => {
    renderRow({ state: "failed", failure: { summary: "Denied by policy", tone: "text-caution" } });

    expect(screen.getByTestId("action-failure").textContent).toBe("Denied by policy");
    expect(screen.getByRole("button", { name: /Denied by policy/ })).toBeTruthy();
  });

  // Every step, oldest first, with its offset; shown only in the opened block.
  it("lists the steps in order with their offsets, and only when opened", () => {
    renderRow({
      steps: [
        {
          label: "Starting a sandbox",
          detail: "reusing the base image",
          offset: "0s",
          state: "completed",
        },
        { label: "Sandbox running", detail: null, offset: "+2.4s", state: "completed" },
        {
          label: "Bridge connected, waiting for the agent runtime",
          detail: null,
          offset: "+5.1s",
          state: "running",
        },
      ],
    });
    expect(screen.queryByTestId("action-steps")).toBeNull();
    expect(screen.getByRole("button").textContent).not.toContain("+2.4s");

    fireEvent.click(screen.getByRole("button"));

    const items = screen.getByTestId("action-steps").querySelectorAll("li");
    expect([...items].map((item) => item.textContent)).toEqual([
      "Starting a sandbox · reusing the base image0s",
      "Sandbox running+2.4s",
      "Bridge connected, waiting for the agent runtime+5.1s",
    ]);
  });

  it("tags output lines with their stream where they have one", () => {
    renderRow({
      output: {
        title: "Sandbox output",
        lines: [
          { tag: null, text: "bridge starting" },
          { tag: "stderr", text: "could not reach the control plane" },
        ],
        dropped: false,
      },
    });
    fireEvent.click(screen.getByRole("button"));
    const output = screen.getByTestId("action-output");
    expect(output.textContent).toContain("bridge starting");
    expect(output.textContent).toContain("stderrcould not reach the control plane");
  });

  it("shows only the last lines of a long output until asked for all of them", () => {
    const lines = Array.from({ length: OUTPUT_PREVIEW_LINES + 5 }, (_, index) => ({
      tag: null,
      text: `line ${index + 1}`,
    }));
    renderRow({ output: { title: "Output", lines, dropped: false } });
    fireEvent.click(screen.getByRole("button"));

    const output = () => screen.getByTestId("action-output");
    expect(output().children).toHaveLength(OUTPUT_PREVIEW_LINES);
    expect(output().textContent).not.toContain("line 5line");
    expect(output().textContent).toContain(`line ${OUTPUT_PREVIEW_LINES + 5}`);
    const showAll = screen.getByTestId("action-output-show-all");
    expect(showAll.textContent).toBe(
      `Show all ${OUTPUT_PREVIEW_LINES + 5} lines (5 earlier lines hidden)`,
    );

    fireEvent.click(showAll);

    expect(output().children).toHaveLength(OUTPUT_PREVIEW_LINES + 5);
    expect(output().textContent).toContain("line 1line 2");
    expect(screen.queryByTestId("action-output-show-all")).toBeNull();
  });

  it("offers no control for an output that fits, and says one hidden line in the singular", () => {
    const fits = Array.from({ length: OUTPUT_PREVIEW_LINES }, (_, index) => ({
      tag: null,
      text: `line ${index}`,
    }));
    renderRow({ output: { title: "Output", lines: fits, dropped: false } });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("action-output-show-all")).toBeNull();
    cleanup();

    renderRow({
      output: {
        title: "Output",
        lines: [...fits, { tag: null, text: "one more" }],
        dropped: false,
      },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("action-output-show-all").textContent).toContain(
      "(1 earlier line hidden)",
    );
  });

  it("says how much the sandbox cut, in the singular and the plural, and nothing when it cut nothing", () => {
    renderRow({
      output: { title: "Output", lines: [{ tag: null, text: "a" }], dropped: false, cut: 1 },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("action-output-cut").textContent).toContain("last 1 character was");
    cleanup();

    renderRow({
      output: { title: "Output", lines: [{ tag: null, text: "a" }], dropped: false, cut: 4096 },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("action-output-cut").textContent).toContain(
      "last 4,096 characters were",
    );
    cleanup();

    renderRow({
      output: { title: "Output", lines: [{ tag: null, text: "a" }], dropped: false, cut: null },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("action-output-cut")).toBeNull();
  });

  // A CSS animation restarts when its element is replaced.
  it("keeps the same shimmering element across an update, so its sweep does not restart", () => {
    const base: ActionRowProps = {
      mark: SquareTerminal,
      label: "Starting a sandbox",
      state: "running",
      failure: null,
      steps: [],
      facts: [],
      input: null,
      output: null,
      testId: "row-tool",
    };
    const { rerender } = render(<ActionRow {...base} />);
    const before = screen.getByText("Starting a sandbox");
    expect(before.className).toContain("shimmer");

    rerender(<ActionRow {...base} label="Sandbox running" meta="2.4s" />);

    const after = screen.getByText("Sandbox running");
    expect(after).toBe(before);
    expect(after.className).toContain("shimmer");
  });

  it("marks the four states apart for the eye and for a test", () => {
    for (const state of ["requested", "running", "completed", "failed"] as const) {
      renderRow({ state });
      expect(screen.getByTestId("row-tool").getAttribute("data-state-kind")).toBe(state);
      cleanup();
    }
  });
});

describe("duration formatting", () => {
  it("answers 'is this slow' at all three scales", () => {
    expect(formatDuration(40)).toBe("40ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(64_213)).toBe("1m 4s");
  });
});
