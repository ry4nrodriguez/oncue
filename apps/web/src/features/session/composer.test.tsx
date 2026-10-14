import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSpecSummary } from "@/lib/api/setup";
import { Composer } from "./Composer";

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value } });
}

/** One catalog row, as the Worker reports it, for the tests that need an effort control. */
const OPUS_5_5: ModelSpecSummary = {
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  effort: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
  price: { inputPerMTok: 4, outputPerMTok: 20 },
  status: "current",
  recommended: true,
};

describe("Composer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    // The web project runs with globals off, so Testing Library's automatic
    // cleanup is never registered and each render must be torn down by hand.
    cleanup();
    vi.restoreAllMocks();
  });

  it("reuses one idempotency id when an unanswered send is retried", async () => {
    const ids: string[] = [];
    // Nothing answers the first attempt; the control plane accepts the second.
    const onSubmit = vi
      .fn<(text: string, commandId: string) => Promise<boolean | "unanswered">>()
      .mockImplementation(async (_text, commandId) => {
        ids.push(commandId);
        return ids.length > 1 ? true : "unanswered";
      });

    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);
    type("cap the boot wait");

    const send = screen.getByLabelText<HTMLButtonElement>("Send message");
    fireEvent.click(send);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The button is disabled while a send is in flight, so the retry has to
    // wait for it to come back rather than being swallowed.
    await vi.waitFor(() => expect(send.disabled).toBe(false));

    fireEvent.click(send);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect(ids).toHaveLength(2);
    // Same message, so the retry must carry the id the first attempt used.
    expect(ids[0]).toBe(ids[1]);
  });

  it("issues a new id when a rejected send is retried, because the object answers a reused id with its first answer", async () => {
    const ids: string[] = [];
    const onSubmit = vi.fn(async (_text: string, commandId: string) => {
      ids.push(commandId);
      return ids.length > 1;
    });

    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);
    type("too late");

    const send = screen.getByLabelText<HTMLButtonElement>("Send message");
    fireEvent.click(send);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("too late");

    fireEvent.click(send);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("issues a new id for a genuinely new message", async () => {
    const ids: string[] = [];
    const onSubmit = vi.fn(async (_text: string, commandId: string) => {
      ids.push(commandId);
      return true;
    });

    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);

    type("first");
    fireEvent.click(screen.getByLabelText("Send message"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe(""),
    );

    type("second");
    fireEvent.click(screen.getByLabelText("Send message"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps the draft across a remount", () => {
    const first = render(<Composer sessionId="sess_1" />);
    type("half a thought");
    first.unmount();

    render(<Composer sessionId="sess_1" />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("half a thought");
  });

  it("keeps drafts separate per session", () => {
    const first = render(<Composer sessionId="sess_1" />);
    type("for session one");
    first.unmount();

    render(<Composer sessionId="sess_2" />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
  });

  it("clears the draft once the message is accepted", async () => {
    const onSubmit = vi.fn(async () => true);
    const first = render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);

    type("send me");
    fireEvent.click(screen.getByLabelText("Send message"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    first.unmount();

    render(<Composer sessionId="sess_1" />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
  });

  it("submits on Enter and on Cmd+Enter, and lets Shift+Enter break the line", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);

    type("keyboard only");
    const shifted = fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      shiftKey: true,
    });
    // Not prevented: the textarea inserts its newline.
    expect(shifted).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    type("again");
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it("will not send an empty or whitespace-only message", () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);

    type("   ");
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says whether the message steers the run, queues the next one, or starts it", () => {
    const { rerender } = render(<Composer sessionId="sess_1" intent="steer" />);
    type("now");
    // Said by the send button's tooltip, not by a label on the strip.
    const intentOf = () => screen.getByLabelText("Send message").getAttribute("title");
    expect(intentOf()).toBe("Steers this run");
    expect(screen.queryByText("Steers this run")).toBeNull();

    rerender(<Composer sessionId="sess_1" intent="run_next" />);
    expect(intentOf()).toBe("Runs next");

    rerender(<Composer sessionId="sess_1" intent="start_next" />);
    expect(intentOf()).toBe("Starts the next run");
  });

  it("starts a run by default, which is what a message with no run to follow does", () => {
    render(<Composer sessionId="sess_1" />);
    type("from the top");
    expect(screen.getByLabelText("Send message").getAttribute("title")).toBe("Starts the next run");
  });

  it("grows the field with its text up to six lines, then scrolls", () => {
    // jsdom lays nothing out, so the field's scroll height is played here.
    let wanted = 0;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => wanted,
    });
    try {
      render(<Composer sessionId="sess_1" />);
      const field = screen.getByLabelText<HTMLTextAreaElement>("Message");
      // With no height to report, the field keeps its rows.
      expect(field.style.height).toBe("");
      wanted = 96;
      type("four\nlines\nof\ntext");
      expect(field.style.height).toBe("96px");
      // A pasted essay stops at the ceiling and scrolls inside it.
      wanted = 600;
      type("a much longer paste");
      expect(field.style.height).toBe("144px");
      expect(field.className).toContain("overflow-y-auto");
    } finally {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (descriptor !== undefined) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
      }
    }
  });

  it("reports unsent input as the draft appears and clears", () => {
    const onUnsentChange = vi.fn();
    render(<Composer sessionId="s_unsent" onUnsentChange={onUnsentChange} />);

    // The badge needs this to show "offline with unsent input" (record 13).
    expect(onUnsentChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "steer it" } });
    expect(onUnsentChange).toHaveBeenLastCalledWith(true);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect(onUnsentChange).toHaveBeenLastCalledWith(false);
  });

  it("reports a draft restored from storage without the user typing", () => {
    window.localStorage.setItem("oncue.draft.s_restored", "also cap the total boot wait");
    const onUnsentChange = vi.fn();
    render(<Composer sessionId="s_restored" onUnsentChange={onUnsentChange} />);

    expect(onUnsentChange).toHaveBeenLastCalledWith(true);
  });

  it("carries the selected model connection to onSubmit", async () => {
    const onSubmit = vi.fn<
      (text: string, commandId: string, modelConnectionId: string | null) => Promise<boolean>
    >(async () => true);
    render(
      <Composer
        sessionId="sess_1"
        onSubmit={onSubmit}
        modelConnections={[{ id: "mc_1", label: "Anthropic" }]}
        selectedModelConnectionId="mc_1"
      />,
    );

    type("use this connection");
    fireEvent.click(screen.getByLabelText("Send message"));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2]).toBe("mc_1");
  });

  it("sends null for the model connection when none is selected", async () => {
    const onSubmit = vi.fn<
      (text: string, commandId: string, modelConnectionId: string | null) => Promise<boolean>
    >(async () => true);
    render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);

    type("no connection chosen");
    fireEvent.click(screen.getByLabelText("Send message"));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2]).toBeNull();
  });

  describe("Stop run", () => {
    it("is absent without a cancel handler even while a run is running", () => {
      render(<Composer sessionId="sess_1" intent="steer" showCancelRun />);
      expect(screen.queryByLabelText("Stop run")).toBeNull();
    });

    it("is hidden while no run is running or waiting", () => {
      const onCancelRun = vi.fn();
      render(<Composer sessionId="sess_1" intent="start_next" onCancelRun={onCancelRun} />);
      expect(screen.queryByLabelText("Stop run")).toBeNull();
    });

    it("cancels the run and describes what that does and does not stop", () => {
      const onCancelRun = vi.fn();
      render(
        <Composer sessionId="sess_1" intent="steer" onCancelRun={onCancelRun} showCancelRun />,
      );

      const stop = screen.getByLabelText("Stop run");
      fireEvent.click(stop);

      expect(onCancelRun).toHaveBeenCalledTimes(1);
      const description = document.getElementById(stop.getAttribute("aria-describedby") ?? "");
      expect(description?.textContent).toContain("keeps the sandbox running");
      expect(description?.textContent).toContain("Stop sandbox");
    });

    it("takes the send button's place while the box is empty, and yields to send once there is a message", () => {
      const onCancelRun = vi.fn();
      render(
        <Composer sessionId="sess_1" intent="steer" onCancelRun={onCancelRun} showCancelRun />,
      );
      expect(screen.getByLabelText("Stop run")).toBeTruthy();
      expect(screen.queryByLabelText("Send message")).toBeNull();

      type("steer it this way");
      expect(screen.queryByLabelText("Stop run")).toBeNull();
      expect(screen.getByLabelText("Send message")).toBeTruthy();
    });
  });

  describe("the bar", () => {
    it("holds the repository and the branch on the left and one agent chip on the right, with no fold", () => {
      render(
        <Composer
          sessionId="new"
          repositories={[{ repositoryConnectionId: "rc_1", fullName: "acme/api" }]}
          selectedRepositoryId="rc_1"
          branchPicker={<button type="button">Default branch</button>}
          modelConnections={[
            {
              id: "mc_1",
              label: "anthropic ...1",
              provider: "anthropic",
              modelId: "claude-opus-5-5",
              models: [OPUS_5_5],
            },
          ]}
          selectedModelConnectionId="mc_1"
        />,
      );
      const strip = screen.getByTestId("composer-strip");
      const controls = within(strip)
        .getAllByRole("button")
        .map((control) => control.getAttribute("aria-label") ?? control.textContent);
      expect(controls).toEqual([
        "Repository: acme/api. Choose a different one",
        "Default branch",
        "Model: Opus 5.5, medium effort",
      ]);
      // The strip sizes its own controls, so nothing folds away at any width.
      expect(strip.className).toContain("@container/strip");
      expect(screen.queryByText("Details")).toBeNull();
    });

    it("says nothing about the sandbox or the Modal account, which the side panel holds", () => {
      render(<Composer sessionId="sess_1" repositoryLabel="acme/api" />);
      expect(screen.getByTestId("composer-strip").textContent).not.toContain("Modal");
      expect(screen.queryByRole("button", { name: /^Modal/ })).toBeNull();
    });
  });

  describe("the row below the box", () => {
    it("holds the approvals picker at the left and what the caller passes at the right, or is absent", () => {
      render(<Composer sessionId="sess_1" />);
      expect(screen.queryByTestId("composer-below")).toBeNull();
      cleanup();

      // The picker alone: nothing is drawn across from it.
      render(<Composer sessionId="sess_1" approvalMode="ask" />);
      expect(screen.getByTestId("composer-below").children).toHaveLength(1);
      cleanup();

      // The caller's gauge alone still gets its place at the right.
      render(<Composer sessionId="sess_1" belowEnd={<span>12%</span>} />);
      const below = screen.getByTestId("composer-below");
      expect(below.children).toHaveLength(2);
      expect(below.lastElementChild?.textContent).toBe("12%");
    });
  });

  describe("Skip required checks", () => {
    /** Base UI activates menu items from the pointer sequence, not a bare click. */
    function pointerClick(element: Element) {
      fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
      fireEvent.mouseDown(element, { button: 0 });
      fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
      fireEvent.mouseUp(element, { button: 0 });
      fireEvent.click(element, { button: 0 });
    }

    async function turnOnSkip() {
      pointerClick(screen.getByRole("button", { name: "Add" }));
      const toggle = await screen.findByRole("menuitemcheckbox", { name: /Skip required checks/ });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      pointerClick(toggle);
      await vi.waitFor(() => expect(screen.getByTestId("composer-skip-chip")).toBeTruthy());
    }

    it("sends the skip with the next message only, then clears it", async () => {
      const onSubmit = vi.fn(
        async (_text: string, _id: string, _model: string | null, _options: unknown) => true,
      );
      render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);
      expect(screen.queryByTestId("composer-skip-chip")).toBeNull();

      await turnOnSkip();
      expect(screen.getByTestId("composer-skip-chip").textContent).toContain(
        "Skip required checks",
      );
      type("skip them");
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0]).toEqual([
        "skip them",
        expect.any(String),
        null,
        // No connection is selected, so no model and no effort go with it.
        { skipRequiredChecks: true, modelId: null, effort: null, attachments: [] },
      ]);
      await vi.waitFor(() => expect(screen.queryByTestId("composer-skip-chip")).toBeNull());

      type("and check this one");
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      expect(onSubmit.mock.calls[1]?.[3]).toEqual({
        skipRequiredChecks: false,
        modelId: null,
        effort: null,
        attachments: [],
      });
    });

    it("keeps the skip for a retry of a rejected message, and the chip removes it", async () => {
      const onSubmit = vi.fn(async () => false);
      render(<Composer sessionId="sess_1" onSubmit={onSubmit} />);
      await turnOnSkip();
      type("try");
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("composer-skip-chip")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Stop skipping required checks" }));
      expect(screen.queryByTestId("composer-skip-chip")).toBeNull();
    });

    it("closes the add menu once the skip is toggled, so the chip it produced is in view", async () => {
      render(<Composer sessionId="sess_1" />);
      await turnOnSkip();
      await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });

    it("shows the toggle as on in the menu while the skip is set", async () => {
      render(<Composer sessionId="sess_1" />);
      await turnOnSkip();
      pointerClick(screen.getByRole("button", { name: "Add" }));
      const toggle = await screen.findByRole("menuitemcheckbox", { name: /Skip required checks/ });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(toggle.textContent).toContain("On");
    });
  });
});

describe("model and effort", () => {
  afterEach(() => {
    cleanup();
  });
  const CONNECTION = {
    id: "mc_1",
    label: "anthropic ...1",
    provider: "anthropic" as const,
    modelId: "claude-opus-5-5",
    models: [OPUS_5_5],
  };

  it("opens the effort on the selected model's default and hands the model and effort to submit", async () => {
    const onSubmit = vi.fn(async (..._args: unknown[]) => true);
    render(
      <Composer
        sessionId="new"
        modelConnections={[CONNECTION]}
        selectedModelConnectionId="mc_1"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByTestId("agent-chip-effort").textContent).toBe("medium");
    type("go");
    fireEvent.click(screen.getByLabelText("Send message"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[3]).toEqual({
      skipRequiredChecks: false,
      modelId: "claude-opus-5-5",
      effort: "medium",
      attachments: [],
    });
  });

  it("carries a changed effort on the next submit", async () => {
    const onSubmit = vi.fn(async (..._args: unknown[]) => true);
    render(
      <Composer
        sessionId="new"
        modelConnections={[CONNECTION]}
        selectedModelConnectionId="mc_1"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-chip"));
    fireEvent.click(await screen.findByRole("button", { name: "low" }));
    await vi.waitFor(() => expect(screen.getByTestId("agent-chip-effort").textContent).toBe("low"));
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe(
      "Model: Opus 5.5, low effort",
    );
    type("cheaply");
    fireEvent.click(screen.getByLabelText("Send message"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[3]).toMatchObject({ effort: "low" });
  });

  it("opens on the effort a session passes, the last run's", () => {
    render(
      <Composer
        sessionId="sess_1"
        modelConnections={[CONNECTION]}
        selectedModelConnectionId="mc_1"
        effort="xhigh"
      />,
    );
    expect(screen.getByTestId("agent-chip-effort").textContent).toBe("xhigh");
  });

  it("names no effort for a model with no effort parameter, or a connection with no catalog", async () => {
    const haiku: ModelSpecSummary = {
      ...OPUS_5_5,
      modelId: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      effort: null,
      defaultEffort: null,
      recommended: true,
    };
    const { rerender } = render(
      <Composer
        sessionId="new"
        modelConnections={[{ ...CONNECTION, modelId: haiku.modelId, models: [haiku] }]}
        selectedModelConnectionId="mc_1"
      />,
    );
    expect(screen.queryByTestId("agent-chip-effort")).toBeNull();
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe("Model: Haiku 4.5");
    rerender(
      <Composer
        sessionId="new"
        modelConnections={[{ id: "mc_1", label: "anthropic ...1" }]}
        selectedModelConnectionId="mc_1"
        // A session's last effort is not shown without the levels it is one of.
        effort="high"
      />,
    );
    expect(screen.queryByTestId("agent-chip-effort")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-chip"));
    await screen.findByTestId("agent-panel");
    expect(screen.getByTestId("effort-picker").textContent).toContain("has no effort setting");
    expect(screen.queryByTestId("effort-levels")).toBeNull();
  });
});
