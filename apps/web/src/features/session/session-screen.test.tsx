import type { RunId, RunView } from "@oncue/protocol";
import {
  makeCommittedEvent,
  TEST_IDS,
  testModelRecord,
  testSessionPolicy,
} from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KEY_GUIDANCE } from "./model-failure";
import {
  ANSWER_TIMEOUT_MS,
  CONTINUE_MESSAGE,
  checksRequest,
  outgoingMessage,
  RUN_CHECKS_MESSAGE,
  SessionScreen,
  type SessionScreenProps,
} from "./SessionScreen";

/** Enough of a WebSocket to drive `SessionScreen`'s sends without a network. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.all.push(this);
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

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  deliver(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    });
  }

  hangUp(code = 1006) {
    this.readyState = WebSocket.CLOSED;
    act(() => {
      this.onclose?.({ code } as CloseEvent);
    });
  }
}

afterEach(() => {
  // Every test uses the same session id, so a leftover draft would leak between tests.
  window.localStorage.clear();
  cleanup();
  FakeSocket.last = null;
  FakeSocket.all = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sentOn(socket: FakeSocket | undefined | null): Record<string, unknown>[] {
  return (socket?.sent ?? []).map((raw) => JSON.parse(raw).command);
}

function acknowledge(socket: FakeSocket | null, commandId: string, sessionSequence: number) {
  socket?.deliver(
    makeCommittedEvent(
      "command.acknowledged",
      { payload: { commandId, commandType: "run.follow_up", acceptedBy: "control_plane" } },
      { sessionSequence },
    ),
  );
}

function renderSession(props: Partial<SessionScreenProps> = {}) {
  return render(
    <SessionScreen
      sessionId="sess_1"
      createSocket={(url) => new FakeSocket(url) as unknown as WebSocket}
      railPinnedAtStart
      {...props}
    />,
  );
}

/** A run as the view would hold it after `run.queued`, for the pure builder's own cases. */
function makeRunView(): RunView {
  return {
    runId: TEST_IDS.runId as RunId,
    state: "queued",
    outcome: null,
    trigger: "initial",
    instructionMessageId: null,
    model: testModelRecord(),
    continuesRunId: null,
    queuedAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    branch: null,
    baseSha: null,
    resumedFrom: null,
    pause: null,
    interruption: null,
    ending: null,
    sandboxGeneration: 1,
  };
}

/** Base UI activates menu items from the pointer sequence, not a bare click. */
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

function lastSentCommand(): Record<string, unknown> {
  const raw = FakeSocket.last?.sent.at(-1);
  expect(raw).toBeDefined();
  const frame = JSON.parse(raw ?? "{}");
  expect(frame.type).toBe("command");
  return frame.command;
}

describe("SessionScreen", () => {
  beforeAll(() => {
    // `Timeline` composes use-stick-to-bottom, which needs ResizeObserver;
    // jsdom does not implement it (see `ai-elements.test.tsx`).
    if (!("ResizeObserver" in globalThis)) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  it("shows an archived session read-only, with Unarchive where the composer was", () => {
    renderSession({ archived: true, title: "Fix the bug" });
    FakeSocket.last?.open();

    expect(screen.getByTestId("archived-notice").textContent).toContain(
      "This session is archived.",
    );
    expect(screen.getByTestId("unarchive-session")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Options for Fix the bug" })).toBeTruthy();
  });

  /** A run waiting on the user three ways: the agent's own ask, a Git proposal, and a pause on a live sandbox. */
  function deliverDecisions() {
    const socket = FakeSocket.last as FakeSocket;
    socket.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    socket.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
    socket.deliver(makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }));
    socket.deliver(
      makeCommittedEvent(
        "approval.requested",
        {
          payload: {
            approvalId: "apr_p",
            title: "Read /etc/hosts, outside the project",
            intendedAction: "x",
            category: "outside_project",
            risk: "medium",
            resource: "/etc/hosts",
            requestedScope: "Outside the project",
            expiresAt: "2099-01-01T00:00:00.000Z",
            toolCallId: null,
            toolCategory: "file_read",
          },
        },
        { sessionSequence: 4 },
      ),
    );
    socket.deliver(
      makeCommittedEvent(
        "policy.proposed",
        {
          payload: {
            proposalId: "prop_1",
            triggeringMessageId: null,
            from: testSessionPolicy(),
            to: testSessionPolicy({ version: 2, push: "auto" }),
            direction: "widening",
            rationale: "The user asked to push.",
          },
        },
        { sessionSequence: 5 },
      ),
    );
    socket.deliver(makeCommittedEvent("run.paused", {}, { sessionSequence: 6 }));
  }

  it("offers the permission card, the Git question, the approvals picker, and the wait note on an open session", () => {
    renderSession({ runtime: "opencode" });
    FakeSocket.last?.open();
    deliverDecisions();

    expect(screen.getByTestId("permission-card")).toBeTruthy();
    expect(screen.getByTestId("policy-card")).toBeTruthy();
    expect(screen.getByTestId("approval-mode")).toBeTruthy();
    expect(screen.getByTestId("composer-wait")).toBeTruthy();
  });

  it("offers none of them on an archived session, which only reads", () => {
    renderSession({ archived: true, runtime: "opencode" });
    FakeSocket.last?.open();
    deliverDecisions();

    expect(screen.getByTestId("archived-notice")).toBeTruthy();
    expect(screen.queryByTestId("permission-card")).toBeNull();
    expect(screen.queryByTestId("policy-card")).toBeNull();
    expect(screen.queryByTestId("approval-mode")).toBeNull();
    expect(screen.queryByTestId("composer-wait")).toBeNull();
  });

  it("leaves nothing of the composer on an archived session, and no sandbox dot once its sandbox has stopped", () => {
    renderSession({ archived: true, runtime: "opencode" });
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    socket.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    socket.deliver(makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 2 }));
    socket.deliver(makeCommittedEvent("sandbox.attached", {}, { sessionSequence: 3 }));
    // The archive's stop is still checkpointing: the sandbox runs, and the dot says so.
    expect(screen.getByTestId("panel-sandbox-dot").getAttribute("data-phase")).toBe("running");

    socket.deliver(makeCommittedEvent("sandbox.stopped", {}, { sessionSequence: 4 }));

    expect(screen.queryByTestId("panel-sandbox-dot")).toBeNull();
    expect(screen.getByRole("button", { name: "Open side panel" })).toBeTruthy();
    for (const id of [
      "composer-dock",
      "composer",
      "composer-strip",
      "composer-below",
      "composer-stop",
      "agent-chip",
      "approval-mode",
    ]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows no question card on an archived session, and announces none", () => {
    renderSession({ archived: true });
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
    FakeSocket.last?.deliver(makeCommittedEvent("question.asked", {}, { sessionSequence: 3 }));

    expect(screen.queryByTestId("question-card")).toBeNull();
    expect(screen.getByTestId("question-announcement").textContent).toBe("");
  });

  it("offers the composer and the session's options on an open session", () => {
    renderSession();
    FakeSocket.last?.open();

    expect(screen.queryByTestId("archived-notice")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Options for Untitled session" })).toBeTruthy();
  });

  it("opens a chat with the session details unpinned, and shows them once pinned", () => {
    renderSession({ railPinnedAtStart: false });
    FakeSocket.last?.open();

    expect(screen.queryByTestId("context-rail")).toBeNull();
    fireEvent.click(screen.getByLabelText("Pin session details"));
    expect(screen.getByTestId("context-rail")).toBeTruthy();
    expect(screen.queryByLabelText("Pin session details")).toBeNull();
  });

  it("asks the agent's question above the composer, sends the answer, and waits for it", () => {
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
    FakeSocket.last?.deliver(makeCommittedEvent("question.asked", {}, { sessionSequence: 3 }));

    expect(screen.getByTestId("question-card")).toBeTruthy();
    // A polite live region, present before the card, says a question arrived.
    expect(screen.getByTestId("question-announcement").getAttribute("role")).toBe("status");
    expect(screen.getByTestId("question-announcement").textContent).toMatch(
      /^The agent asked you /,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(screen.getByTestId("question-next"));
    const command = lastSentCommand();
    expect(command).toMatchObject({
      type: "question.resolve",
      runId: TEST_IDS.runId,
      expected: { scope: "run", state: "running" },
      payload: { action: "answer", questionId: "qst_1", answers: [["Postgres"]] },
    });
    expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(true);

    // A refusal gives the card back, and says why under the composer.
    FakeSocket.last?.deliver(
      makeCommittedEvent(
        "command.rejected",
        {
          payload: {
            commandId: command.commandId as string,
            commandType: "question.resolve",
            reason: "wrong_state",
            detail: "no open question matches this id",
          },
        },
        { sessionSequence: 4 },
      ),
    );
    expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("composer-rejection").textContent).toContain(
      "no open question matches this id",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss the questions" }));
    expect(lastSentCommand()).toMatchObject({
      type: "question.resolve",
      payload: { action: "dismiss", questionId: "qst_1" },
    });
    // The card closes with focus in it; focus goes on to the composer.
    screen.getByRole("radio", { name: /Postgres/ }).focus();
    FakeSocket.last?.deliver(makeCommittedEvent("question.dismissed", {}, { sessionSequence: 5 }));
    expect(screen.queryByTestId("question-card")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
    expect(screen.getByTestId("question-announcement").textContent).toBe("");
  });

  it("waits only for its own question's answer, and gives the card back when none comes", () => {
    vi.useFakeTimers();
    try {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("question.asked", {}, { sessionSequence: 2 }));
      fireEvent.click(screen.getByTestId("question-skip"));
      expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
      });
      expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(false);

      // Answered, then a second question: its card is not waiting on the first answer.
      fireEvent.click(screen.getByTestId("question-skip"));
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "question.answered",
          { payload: { answers: [[]] } },
          { sessionSequence: 3 },
        ),
      );
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "question.asked",
          { payload: { questionId: "qst_2" } },
          { sessionSequence: 4 },
        ),
      );
      expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no answer while the socket is down", () => {
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    FakeSocket.last?.deliver(makeCommittedEvent("question.asked", {}, { sessionSequence: 2 }));
    const socket = FakeSocket.last as FakeSocket;
    socket.readyState = WebSocket.CLOSED;
    const before = socket.sent.length;
    fireEvent.click(screen.getByTestId("question-skip"));
    expect(socket.sent.length).toBe(before);
    expect((screen.getByTestId("question-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides Stop run before any run has queued", () => {
    renderSession();
    FakeSocket.last?.open();

    expect(screen.queryByLabelText("Stop run")).toBeNull();
  });

  it("refuses to send a follow-up before any run exists", async () => {
    renderSession();
    FakeSocket.last?.open();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "too early" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    // Nothing to follow up on yet, so the send is refused and the draft stays.
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("too early"),
    );
    expect(FakeSocket.last?.sent).toEqual([]);
  });

  it("sends a run.follow_up over the client socket once a run exists", async () => {
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "add a test" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
    const command = lastSentCommand();
    expect(command.type).toBe("run.follow_up");
    expect(command.runId).toBe(TEST_IDS.runId);
    expect(command.sessionId).toBe("sess_1");
    // No `issuedByUserId` on the wire -- the Worker reads it off the
    // authenticated connection, never off a client-supplied field.
    expect(command).not.toHaveProperty("issuedByUserId");
    const payload = command.payload as Record<string, unknown>;
    expect(payload.text).toBe("add a test");
    expect(["steer_current_run", "run_next"]).toContain(payload.delivery);
  });

  describe("what a message becomes, read off the run view", () => {
    function typeAndSend(text: string) {
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
      fireEvent.click(screen.getByLabelText("Send message"));
    }

    it("steers a running run with a run.follow_up", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));

      typeAndSend("steer it");
      expect(screen.getByLabelText("Send message").getAttribute("title")).toBe("Steers this run");

      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const command = lastSentCommand();
      expect(command.type).toBe("run.follow_up");
      expect(command.expected).toEqual({ scope: "run", state: "running" });
      expect((command.payload as Record<string, unknown>).delivery).toBe("steer_current_run");
    });

    it("offers no send to a paused run whose sandbox is still live, which the object would refuse, and says why", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }),
      );
      FakeSocket.last?.deliver(makeCommittedEvent("run.paused", {}, { sessionSequence: 4 }));

      const message = screen.getByLabelText<HTMLTextAreaElement>("Message");
      fireEvent.change(message, { target: { value: "after this" } });
      // The way forward is Stop run, which takes the send button's place.
      expect(screen.queryByLabelText("Send message")).toBeNull();
      expect(screen.getByLabelText("Stop run")).toBeTruthy();
      fireEvent.keyDown(message, { key: "Enter" });

      const note = screen.getByTestId("composer-wait");
      expect(note.textContent).toContain("sandbox is still running");
      expect(message.getAttribute("aria-describedby")).toBe(note.id);
      await act(async () => {});
      expect(FakeSocket.last?.sent).toEqual([]);
      expect(message.value).toBe("after this");
    });

    it("waits for OnCue to resume a run it is moving to a new sandbox", () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "run.interrupted",
          { payload: { reason: "sandbox_replaced" } },
          { sessionSequence: 3 },
        ),
      );

      expect(screen.getByTestId("composer-wait").textContent).toContain("new sandbox");
    });

    it("starts the next run with a run.start once the run has ended, on the model that ran it", async () => {
      // The run's own connection is active; without it the next run.start is refused.
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent("run.completed_with_warnings", {}, { sessionSequence: 3 }),
      );

      typeAndSend("now do the tests");
      expect(screen.getByLabelText("Send message").getAttribute("title")).toBe(
        "Starts the next run",
      );

      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const command = lastSentCommand();
      expect(command.type).toBe("run.start");
      expect(command.runId).toBeNull();
      expect(command.expected).toEqual({ scope: "session", state: "active" });
      expect(command.payload).toEqual({
        instruction: { messageId: command.commandId, text: "now do the tests", attachments: [] },
        model: testModelRecord(),
        continuesRunId: TEST_IDS.runId,
      });
    });

    it("builds a checks-only run.start on the ended run's model, continuing it (record 14)", () => {
      const ended = {
        ...makeRunView(),
        state: "completed" as const,
        outcome: "completed" as const,
        ending: {} as RunView["ending"],
      };
      const command = checksRequest(ended, "cmd_checks");
      expect(command).toMatchObject({
        type: "run.start",
        commandId: "cmd_checks",
        runId: null,
        expected: { scope: "session", state: "active" },
        payload: {
          instruction: { messageId: "cmd_checks", text: RUN_CHECKS_MESSAGE, attachments: [] },
          model: testModelRecord(),
          continuesRunId: TEST_IDS.runId,
          checksOnly: true,
        },
      });
      // Nothing to check while a run is under way, with no run, or on a model that cannot be used.
      expect(checksRequest({ ...makeRunView(), state: "running" as const }, "cmd_x")).toBeNull();
      expect(checksRequest(null, "cmd_x")).toBeNull();
      expect(checksRequest(ended, "cmd_x", false)).toBeNull();
    });

    it("carries skipRequiredChecks on run.start and run.follow_up only when asked", () => {
      const run = { ...makeRunView(), state: "running" as const };
      const steer = outgoingMessage(run, "go", "cmd_a", true, true, true);
      expect((steer as { payload: Record<string, unknown> }).payload.skipRequiredChecks).toBe(true);
      const plain = outgoingMessage(run, "go", "cmd_b", true, true);
      expect(Object.hasOwn((plain as { payload: object }).payload, "skipRequiredChecks")).toBe(
        false,
      );

      const ended = {
        ...makeRunView(),
        state: "completed_with_warnings" as const,
        outcome: "completed_with_warnings" as const,
        ending: {} as RunView["ending"],
      };
      const start = outgoingMessage(ended, "next", "cmd_c", false, true, true);
      expect(start?.type).toBe("run.start");
      expect((start as { payload: Record<string, unknown> }).payload.skipRequiredChecks).toBe(true);
    });

    it("carries the composer's attachments on a steer and on a fresh start", () => {
      const ref = {
        artifactId: "att_1",
        kind: "file",
        contentType: "image/png",
        byteSize: 12,
        label: "a.png",
      } as never;
      const running = { ...makeRunView(), state: "running" as const };
      const steer = outgoingMessage(running, "look", "cmd_a", true, true, false, undefined, [ref]);
      expect(steer).toMatchObject({ type: "run.follow_up", payload: { attachments: [ref] } });
      const ended = {
        ...makeRunView(),
        state: "completed_with_warnings" as const,
        outcome: "completed_with_warnings" as const,
        ending: {} as RunView["ending"],
      };
      const start = outgoingMessage(ended, "look", "cmd_b", false, true, false, undefined, [ref]);
      expect(start).toMatchObject({
        type: "run.start",
        payload: { instruction: { attachments: [ref] } },
      });
    });

    it("carries the next run's effort on a queued follow-up and a fresh start, never on a steer", () => {
      const running = { ...makeRunView(), state: "running" as const };
      const steer = outgoingMessage(running, "go", "cmd_a", true, true, false, "low");
      expect(Object.hasOwn((steer as { payload: object }).payload, "effort")).toBe(false);

      // Queued for the next run: `run.follow_up` with run_next carries it.
      const queuedRun = { ...makeRunView(), state: "provisioning" as const };
      const queued = outgoingMessage(queuedRun, "later", "cmd_b", true, true, false, "low");
      expect(queued).toMatchObject({
        type: "run.follow_up",
        payload: { delivery: "run_next", effort: "low" },
      });
      // Nothing named: the next run keeps the record's.
      const kept = outgoingMessage(queuedRun, "later", "cmd_c", true, true);
      // A paused run with its sandbox up takes no message at all.
      const paused = { ...makeRunView(), state: "paused" as const };
      expect(outgoingMessage(paused, "later", "cmd_e", true, true)).toBeNull();
      expect(Object.hasOwn((kept as { payload: object }).payload, "effort")).toBe(false);

      const ended = {
        ...makeRunView(),
        state: "completed_with_warnings" as const,
        outcome: "completed_with_warnings" as const,
        ending: {} as RunView["ending"],
      };
      const start = outgoingMessage(ended, "next", "cmd_d", false, true, false, "max");
      expect(start).toMatchObject({
        type: "run.start",
        payload: { model: { ...testModelRecord(), effort: "max" } },
      });
    });

    it("sends the composer's skip with the message, from the add menu's toggle", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));

      pointerClick(screen.getByRole("button", { name: "Add" }));
      pointerClick(await screen.findByRole("menuitemcheckbox", { name: /Skip required checks/ }));
      await vi.waitFor(() => expect(screen.getByTestId("composer-skip-chip")).toBeTruthy());

      typeAndSend("skip them");
      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const command = lastSentCommand();
      expect(command.type).toBe("run.follow_up");
      expect((command.payload as Record<string, unknown>).skipRequiredChecks).toBe(true);
    });

    it("refuses to start a run with no model to charge it to", () => {
      // Unreachable through the socket, but the builder must still handle it.
      const ended: RunView = {
        ...makeRunView(),
        state: "verified",
        outcome: "verified",
        model: null,
        ending: { outcome: "verified", ...makeCommittedEvent("run.verified").payload },
      };
      expect(outgoingMessage(ended, "text", "cmd_1", false)).toBeNull();
      expect(outgoingMessage(null, "text", "cmd_1", false)).toBeNull();
    });
  });

  describe("the object's answer", () => {
    it("shows a rejection under the composer and keeps the draft for the retry", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "too late" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const commandId = lastSentCommand().commandId as string;
      expect(screen.queryByTestId("composer-rejection")).toBeNull();

      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.rejected",
          {
            payload: {
              commandId,
              commandType: "run.follow_up",
              reason: "wrong_state",
              expectedState: "running",
              actualState: "completed_with_warnings",
              detail: "run.follow_up is not valid while run is completed_with_warnings",
            },
          },
          { sessionSequence: 3 },
        ),
      );

      const line = await screen.findByTestId("composer-rejection");
      expect(line.textContent).toBe(
        "The message was not accepted: wrong_state (run.follow_up is not valid while run is completed_with_warnings)",
      );
      // The draft stays, and the send button comes back for the retry.
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("too late");
      await vi.waitFor(() =>
        expect(screen.getByLabelText<HTMLButtonElement>("Send message").disabled).toBe(false),
      );

      // The retry is a new command: the object would answer the old id with
      // the rejection it already gave.
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(2));
      expect(lastSentCommand().commandId).not.toBe(commandId);
    });

    it("clears the draft once the object acknowledges the command", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "accepted" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const commandId = lastSentCommand().commandId as string;
      // Not cleared on the socket accepting the frame: the object has not
      // answered yet.
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("accepted");

      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.acknowledged",
          { payload: { commandId, commandType: "run.follow_up", acceptedBy: "control_plane" } },
          { sessionSequence: 3 },
        ),
      );

      await vi.waitFor(() =>
        expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe(""),
      );
      expect(screen.queryByTestId("composer-rejection")).toBeNull();
    });
  });

  describe("sending while the connection is down", () => {
    function startRun() {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
    }

    it("says so under the composer while reconnecting, and keeps the box usable", () => {
      startRun();
      FakeSocket.last?.hangUp();

      const note = screen.getByTestId("composer-send-notice");
      expect(note.getAttribute("data-kind")).toBe("disconnected");
      expect(note.textContent).toContain("Reconnecting");
      const message = screen.getByLabelText<HTMLTextAreaElement>("Message");
      expect(message.disabled).toBe(false);
      expect(message.getAttribute("aria-describedby")).toBe(note.id);
    });

    it("holds a message sent while disconnected, shows it is waiting, and delivers it once on reconnect", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      startRun();
      const first = FakeSocket.last;
      first?.hangUp();

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "while away" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await act(async () => {});

      const note = screen.getByTestId("composer-send-notice");
      expect(note.getAttribute("data-kind")).toBe("queued");
      expect(note.textContent).toContain("will send when OnCue reconnects");
      // The box holds what is being sent.
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").readOnly).toBe(true);
      expect(first?.sent).toEqual([]);

      act(() => {
        vi.advanceTimersByTime(500);
      });
      const second = FakeSocket.last;
      expect(second).not.toBe(first);
      second?.open();
      const sent = sentOn(second);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.type).toBe("run.follow_up");
      second?.deliver({ type: "caught_up", through: 2 });
      // Sent, so no longer waiting on the connection; the answer is next.
      expect(screen.queryByTestId("composer-send-notice")).toBeNull();

      acknowledge(second, sent[0]?.commandId as string, 3);
      await act(async () => {});
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
    });

    it("lets a held message be withdrawn before it leaves, keeping the draft", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      startRun();
      FakeSocket.last?.hangUp();
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "never mind" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await act(async () => {});

      fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
      await act(async () => {});

      act(() => {
        vi.advanceTimersByTime(500);
      });
      FakeSocket.last?.open();
      expect(sentOn(FakeSocket.last)).toEqual([]);
      const message = screen.getByLabelText<HTMLTextAreaElement>("Message");
      expect(message.value).toBe("never mind");
      expect(message.readOnly).toBe(false);
    });

    it("says when a sent message was not confirmed in time, and a resend under the same id settles at once if it did arrive", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      startRun();
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello?" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await act(async () => {});
      const commandId = sentOn(FakeSocket.last)[0]?.commandId as string;

      await act(async () => {
        vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
      });
      const note = screen.getByTestId("composer-send-notice");
      expect(note.getAttribute("data-kind")).toBe("unanswered");
      expect(note.textContent).toContain("didn't confirm");
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("hello?");

      // The answer arrives late; the retry reuses the id and needs no new frame.
      acknowledge(FakeSocket.last, commandId, 3);
      fireEvent.click(screen.getByLabelText("Send message"));
      await act(async () => {});

      expect(FakeSocket.last?.sent).toHaveLength(1);
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
      expect(screen.queryByTestId("composer-send-notice")).toBeNull();
    });

    it("says a message sent before any run has replayed was not sent", async () => {
      renderSession();
      FakeSocket.last?.open();
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "too early" } });
      fireEvent.click(screen.getByLabelText("Send message"));

      const note = await screen.findByTestId("composer-send-notice");
      expect(note.getAttribute("data-kind")).toBe("not_ready");
      expect(note.textContent).toContain("still loading");
    });

    it("clears the answer timer when the screen goes away", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      startRun();
      const set = vi.spyOn(window, "setTimeout");
      const clear = vi.spyOn(window, "clearTimeout");
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "bye" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await act(async () => {});
      const index = set.mock.calls.findIndex((call) => call[1] === ANSWER_TIMEOUT_MS);
      const timer = set.mock.results[index]?.value;
      expect(timer).toBeDefined();

      cleanup();

      expect(clear).toHaveBeenCalledWith(timer);
    });
  });

  describe("one command per press", () => {
    it("sends one cancel for a double click on Stop run, and says when it could not leave", async () => {
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));

      const stop = screen.getByLabelText("Stop run");
      fireEvent.click(stop);
      fireEvent.click(stop);
      await act(async () => {});
      const cancels = sentOn(FakeSocket.last).filter((command) => command.type === "run.cancel");
      expect(cancels).toHaveLength(1);
      // Off until the object answers the first.
      expect((screen.getByLabelText("Stop run") as HTMLButtonElement).disabled).toBe(true);
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.acknowledged",
          {
            payload: {
              commandId: cancels[0]?.commandId as string,
              commandType: "run.cancel",
              acceptedBy: "control_plane",
            },
          },
          { sessionSequence: 2 },
        ),
      );
      await act(async () => {});

      FakeSocket.last?.hangUp();
      // Stop run is not held for a later socket: a late cancel would surprise.
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Stop run"));
      });
      await vi.waitFor(() =>
        expect(screen.getByTestId("composer-send-notice").textContent).toContain(
          "Stop run: Not sent",
        ),
      );
    });

    it("sends one checks run for a double click on Run checks, and says when one could not leave", async () => {
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.verified", {}, { sessionSequence: 3 }));

      const button = screen.getByTestId("rail-run-checks");
      fireEvent.click(button);
      fireEvent.click(button);
      await act(async () => {});
      expect(sentOn(FakeSocket.last)).toHaveLength(1);
      expect((button as HTMLButtonElement).disabled).toBe(true);

      const commandId = sentOn(FakeSocket.last)[0]?.commandId as string;
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.rejected",
          {
            payload: {
              commandId,
              commandType: "run.start",
              reason: "admission_closed",
              expectedState: null,
              actualState: null,
              detail: "the workspace is at its limit",
            },
          },
          { sessionSequence: 4 },
        ),
      );
      await vi.waitFor(() =>
        expect(screen.getByTestId("rail-run-checks-problem").textContent).toBe(
          "Not accepted: the workspace is at its limit.",
        ),
      );
      // Once, beside the button, not again under the composer.
      expect(screen.queryByTestId("composer-rejection")).toBeNull();
      expect((screen.getByTestId("rail-run-checks") as HTMLButtonElement).disabled).toBe(false);

      FakeSocket.last?.hangUp();
      await act(async () => {
        fireEvent.click(screen.getByTestId("rail-run-checks"));
      });
      expect(screen.getByTestId("rail-run-checks-problem").textContent).toContain("Not sent");
    });
  });

  describe("retrying a command that got no answer", () => {
    it("sends Run checks again under the same command id, so the object runs the checks once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.verified", {}, { sessionSequence: 3 }));

      await act(async () => {
        fireEvent.click(screen.getByTestId("rail-run-checks"));
      });
      await act(async () => {
        vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
      });
      expect(screen.getByTestId("rail-run-checks-problem").textContent).toContain("didn't answer");
      await act(async () => {
        fireEvent.click(screen.getByTestId("rail-run-checks"));
      });

      const [firstTry, secondTry] = sentOn(FakeSocket.last);
      expect(secondTry?.type).toBe("run.start");
      expect(secondTry?.commandId).toBe(firstTry?.commandId);
    });

    it("sends Stop run again under the same id after no answer, and a new id once answered", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      renderSession();
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Stop run"));
      });
      await act(async () => {
        vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Stop run"));
      });
      const [firstTry, secondTry] = sentOn(FakeSocket.last);
      expect(secondTry?.commandId).toBe(firstTry?.commandId);

      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.acknowledged",
          {
            payload: {
              commandId: firstTry?.commandId as string,
              commandType: "run.cancel",
              acceptedBy: "control_plane",
            },
          },
          { sessionSequence: 2 },
        ),
      );
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Stop run"));
      });
      expect(sentOn(FakeSocket.last)[2]?.commandId).not.toBe(firstTry?.commandId);
    });
  });

  it("shows Stop run once a run exists and sends run.cancel without touching the sandbox", async () => {
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));

    const stop = await screen.findByLabelText("Stop run");
    fireEvent.click(stop);

    await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
    const command = lastSentCommand();
    expect(command.type).toBe("run.cancel");
    expect(command.runId).toBe(TEST_IDS.runId);
    expect(command.payload).toEqual({ reason: null, checkpointFirst: false });
  });

  describe("continuing a run whose sandbox is gone", () => {
    it("sends the rail's Continue as a steer on the interrupted run, down the composer's path", async () => {
      // The run's own connection is active, which a Continue needs.
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "sandbox.stopped",
          { payload: { outcome: "failed", reason: "disappeared", checkpointId: null } },
          { sessionSequence: 3 },
        ),
      );
      FakeSocket.last?.deliver(makeCommittedEvent("run.interrupted", {}, { sessionSequence: 4 }));

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft" } });
      // The send button's tooltip and the rail's button both say Continue.
      expect(screen.getByLabelText("Send message").getAttribute("title")).toBe("Continue");
      expect(screen.getAllByText("Continue")).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const command = lastSentCommand();
      expect(command.type).toBe("run.follow_up");
      expect(command.runId).toBe(TEST_IDS.runId);
      expect(command.expected).toEqual({ scope: "run", state: "interrupted" });
      expect(command.payload).toMatchObject({
        text: CONTINUE_MESSAGE,
        delivery: "steer_current_run",
      });
      // The draft is the user's own and is not what Continue sent.
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("draft");
    });

    function interruptedWithoutSandbox() {
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "sandbox.stopped",
          { payload: { outcome: "failed", reason: "disappeared", checkpointId: null } },
          { sessionSequence: 3 },
        ),
      );
      FakeSocket.last?.deliver(makeCommittedEvent("run.interrupted", {}, { sessionSequence: 4 }));
    }

    it("never holds Continue through a disconnect, since it starts a billed sandbox", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      interruptedWithoutSandbox();
      const first = FakeSocket.last;
      first?.hangUp();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      });

      expect(screen.getByTestId("rail-continue-problem").textContent).toContain("Not continued");
      expect(screen.getByTestId("composer-send-notice").textContent).toContain("Not sent");
      act(() => {
        vi.advanceTimersByTime(500);
      });
      FakeSocket.last?.open();
      expect(FakeSocket.last).not.toBe(first);
      expect(FakeSocket.last?.sent).toEqual([]);
    });

    it("retries an unanswered Continue under the same command id, and a refused one under a new id", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      interruptedWithoutSandbox();
      const continueButton = () => screen.getByRole("button", { name: "Continue" });

      await act(async () => {
        fireEvent.click(continueButton());
      });
      await act(async () => {
        vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
      });
      expect(screen.getByTestId("rail-continue-problem").textContent).toContain("didn't answer");
      await act(async () => {
        fireEvent.click(continueButton());
      });
      const [firstTry, secondTry] = sentOn(FakeSocket.last);
      expect(secondTry?.commandId).toBe(firstTry?.commandId);

      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "command.rejected",
          {
            payload: {
              commandId: firstTry?.commandId as string,
              commandType: "run.follow_up",
              reason: "wrong_state",
              expectedState: "interrupted",
              actualState: "cancelled",
              detail: "the run already ended",
            },
          },
          { sessionSequence: 5 },
        ),
      );
      await act(async () => {});
      await act(async () => {
        fireEvent.click(continueButton());
      });
      expect(sentOn(FakeSocket.last)[2]?.commandId).not.toBe(firstTry?.commandId);
    });

    it("sends a composer message as a Continue on a paused run whose sandbox stopped at idle", async () => {
      // The run's own connection is active, which a Continue needs.
      renderSession({
        modelConnections: [
          { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
        ],
      });
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
      FakeSocket.last?.deliver(makeCommittedEvent("run.started", {}, { sessionSequence: 2 }));
      FakeSocket.last?.deliver(
        makeCommittedEvent(
          "run.paused",
          { payload: { reason: "idle_stop" } },
          { sessionSequence: 3 },
        ),
      );
      FakeSocket.last?.deliver(makeCommittedEvent("sandbox.stopped", {}, { sessionSequence: 4 }));

      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "pick it up" } });
      fireEvent.click(screen.getByLabelText("Send message"));

      await vi.waitFor(() => expect(FakeSocket.last?.sent).toHaveLength(1));
      const command = lastSentCommand();
      expect(command.type).toBe("run.follow_up");
      expect(command.expected).toEqual({ scope: "run", state: "paused" });
      expect(command.payload).toMatchObject({ text: "pick it up", delivery: "steer_current_run" });
    });
  });

  it("keeps the sandbox alive through the keep-alive route from the Modal panel", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: "not_running" }), { status: 409 });
      }),
    );
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(
      makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 1 }),
    );
    FakeSocket.last?.deliver(makeCommittedEvent("sandbox.attached", {}, { sessionSequence: 2 }));

    // The sandbox is reached from the side panel's list of views.
    // The header's toggle carries the sandbox's state, which the composer no longer shows.
    fireEvent.click(screen.getByRole("button", { name: "Open side panel. Sandbox running" }));
    fireEvent.click(screen.getByTestId("panel-open-modal"));
    fireEvent.click(screen.getByRole("button", { name: "Keep running for an hour" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The sandbox is not running.");
    // The approvals picker reads the workspace's approval settings on its own.
    expect(calls.filter((call) => call.url !== "/api/approval-settings")).toEqual([
      {
        url: "/api/sessions/sess_1/sandbox/keep-alive",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      },
    ]);
  });

  it("names the run's own model connection in the composer, else the first, else none", () => {
    const modelConnections = [
      { modelConnectionId: "conn_other", label: "Other key" },
      { modelConnectionId: testModelRecord().modelConnectionId, label: "Work key" },
    ];
    renderSession({ modelConnections });
    FakeSocket.last?.open();
    // A session's runs keep their model, so the label offers no other choice.
    expect(screen.getByLabelText("Model: Other key")).toBeTruthy();

    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    expect(screen.getByLabelText("Model: Work key")).toBeTruthy();
    cleanup();

    renderSession();
    expect(screen.getAllByLabelText("No model connected").length).toBeGreaterThan(0);
  });

  it("says the model is unavailable when the run's connection is not active, rather than naming another", () => {
    renderSession({ modelConnections: [{ modelConnectionId: "conn_other", label: "Other key" }] });
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));

    const picker = screen.getByLabelText("Model: unavailable");
    expect(picker.textContent).toContain("Model unavailable");
    expect(screen.queryByText("Other key")).toBeNull();
  });

  describe("a run paused on a rejected key", () => {
    const REJECTED = "Model request failed: the provider rejected the model key.";
    const runConnectionId = testModelRecord().modelConnectionId;
    const paused = [
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
    ];
    const stillInvalid: Partial<SessionScreenProps> = {
      modelConnections: [{ modelConnectionId: "conn_other", label: "Other key" }],
      inactiveModelConnections: [
        {
          modelConnectionId: runConnectionId,
          provider: "anthropic",
          status: "invalid",
          activeSessions: 1,
        },
      ],
    };

    function deliver(events: readonly unknown[]) {
      FakeSocket.last?.open();
      for (const event of events) {
        FakeSocket.last?.deliver(event);
      }
    }

    it("says to replace the key, then continue, once its sandbox has stopped and the key is still invalid", () => {
      renderSession(stillInvalid);
      deliver(paused);

      expect(screen.queryByTestId("rail-continue")).toBeNull();
      // No send the object would refuse: the composer is disabled and says why.
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
      const note = screen.getByTestId("composer-model-failure");
      expect(note.textContent).toBe(
        `${REJECTED} Replace the key under Settings, Model providers, then come back here to continue the run.`,
      );
      // The rail says the same words, and neither sends the work to a new session.
      expect(screen.getByTestId("needs-you").textContent).toBe(
        `${note.textContent}Open Model providers`,
      );
      // The disabled box names the note as its description, and both the rail
      // and the note link to where the key is replaced.
      expect(screen.getByLabelText("Message").getAttribute("aria-describedby")).toBe(note.id);
      expect(
        screen.getAllByTestId("model-connections-link").map((link) => link.getAttribute("href")),
      ).toEqual([
        "/settings/model-providers",
        "/settings/model-providers",
        "/settings/model-providers",
      ]);
      // The generic notes give way to the one that names the failure.
      expect(screen.queryByTestId("composer-wait")).toBeNull();
      expect(screen.queryByTestId("composer-model-unavailable")).toBeNull();
    });

    it("names the rejected key while the sandbox is still running, in place of the generic wait", () => {
      renderSession(stillInvalid);
      deliver([
        paused[0],
        makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 2 }),
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
          { sessionSequence: 3 },
        ),
      ]);

      expect(screen.getByTestId("composer-model-failure").textContent).toBe(
        `${REJECTED} Replace the key under Settings, Model providers, then come back here to continue the run.`,
      );
      expect(screen.queryByTestId("composer-wait")).toBeNull();
      // The run can still be stopped, and nothing is offered that the object would refuse.
      expect(screen.getByLabelText("Stop run")).toBeTruthy();
      expect(screen.queryByLabelText("Send message")).toBeNull();
      expect(screen.queryByTestId("rail-continue")).toBeNull();
    });

    it("offers Continue once the key is active and the sandbox has stopped", () => {
      renderSession({
        modelConnections: [{ modelConnectionId: runConnectionId, label: "Work key" }],
      });
      deliver(paused);

      expect(screen.getByTestId("rail-continue")).toBeTruthy();
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
      expect(screen.getByTestId("composer-model-failure").textContent).toBe(
        `${REJECTED} The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.`,
      );
      // The provider may still reject the key, so the rail, the note, and the timeline's row keep the link.
      expect(screen.getAllByTestId("model-connections-link")).toHaveLength(3);
    });

    it("sends the work to a new session only when the connection was revoked or deleted", () => {
      renderSession({
        modelConnections: [{ modelConnectionId: "conn_other", label: "Other key" }],
      });
      deliver(paused);

      expect(screen.queryByTestId("rail-continue")).toBeNull();
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
      expect(screen.getByTestId("composer-model-failure").textContent).toBe(
        `${REJECTED} The key this run used has since been removed. Add a working key under Settings, Model providers, then start a new session to continue the work.`,
      );
    });

    it("names the failure on the timeline, outside any folded group, with the link to Model providers", () => {
      renderSession(stillInvalid);
      deliver(paused);

      const row = document.querySelector<HTMLElement>(
        '[data-testid="row-run"][data-transition="paused"]',
      );
      expect(row?.textContent).toBe(`Paused${REJECTED}Open Model providers`);
      expect(row?.closest('[data-testid="activity-rows"]')).toBeNull();
    });

    it("reads the connections again at the pause, and says nothing about the key until they arrive", () => {
      const refresh = vi.fn();
      // The page's connections predate the pause: they still list the key as active.
      const stale: Partial<SessionScreenProps> = {
        modelConnections: [{ modelConnectionId: runConnectionId, label: "Work key" }],
        onRefreshConnections: refresh,
        connectionsRevision: 1,
      };
      const createSocket = (url: string) => new FakeSocket(url) as unknown as WebSocket;
      const view = render(
        <SessionScreen
          sessionId="sess_1"
          createSocket={createSocket}
          railPinnedAtStart
          {...stale}
        />,
      );
      expect(refresh).not.toHaveBeenCalled();
      deliver(paused);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("composer-model-failure").textContent).toBe(REJECTED);

      // The read made since the pause says the key was rejected.
      view.rerender(
        <SessionScreen
          sessionId="sess_1"
          createSocket={createSocket}
          railPinnedAtStart
          {...stale}
          {...stillInvalid}
          connectionsRevision={2}
        />,
      );
      expect(screen.getByTestId("composer-model-failure").textContent).toBe(
        `${REJECTED} Replace the key under Settings, Model providers, then come back here to continue the run.`,
      );

      // While the key waits to be replaced, coming back to the tab reads again.
      // A return fires `focus` and `visibilitychange` together; the pair is one read.
      const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      later.mockRestore();
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("stops reading the connections on return once the key is active again", () => {
      const refresh = vi.fn();
      renderSession({
        modelConnections: [{ modelConnectionId: runConnectionId, label: "Work key" }],
        onRefreshConnections: refresh,
        connectionsRevision: 2,
      });
      // No pause on a model failure and an active key: nothing to wait on.
      FakeSocket.last?.open();
      FakeSocket.last?.deliver(paused[0]);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  it("offers no Continue for an interrupted run whose connection is not active, and says what works instead", () => {
    renderSession({ modelConnections: [{ modelConnectionId: "conn_other", label: "Other key" }] });
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    FakeSocket.last?.deliver(makeCommittedEvent("run.interrupted", {}, { sessionSequence: 2 }));

    expect(screen.queryByTestId("rail-continue")).toBeNull();
    expect(screen.getByTestId("needs-you").textContent).toBe(
      `${KEY_GUIDANCE.gone}Open Model providers`,
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId("composer-model-unavailable").textContent).toBe(KEY_GUIDANCE.gone);
  });

  it("disables the composer with the same guidance for an ended run whose connection is not active, and only with no live sandbox", () => {
    renderSession({ modelConnections: [{ modelConnectionId: "conn_other", label: "Other key" }] });
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    FakeSocket.last?.deliver(makeCommittedEvent("run.verified", {}, { sessionSequence: 2 }));

    // The next message would be a run.start on this run's model, which the object refuses.
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId("composer-model-unavailable").textContent).toBe(KEY_GUIDANCE.gone);
    expect(screen.getByTestId("needs-you").textContent).toBe(
      `${KEY_GUIDANCE.gone}Open Model providers`,
    );

    // A live sandbox takes a run.start without a new generation, so nothing is withheld.
    FakeSocket.last?.deliver(
      makeCommittedEvent("sandbox.provisioning", {}, { sessionSequence: 3 }),
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId("composer-model-unavailable")).toBeNull();
  });

  it("hides Stop run again once the run reaches a terminal outcome", () => {
    renderSession();
    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    expect(screen.getByLabelText("Stop run")).toBeTruthy();

    FakeSocket.last?.deliver(makeCommittedEvent("run.cancelled", {}, { sessionSequence: 2 }));

    expect(screen.queryByLabelText("Stop run")).toBeNull();
  });

  it("tells the sidebar when the current run changes, and when it has ended", () => {
    const onRunChange = vi.fn();
    renderSession({ onRunChange });
    expect(onRunChange).toHaveBeenLastCalledWith(null);

    FakeSocket.last?.open();
    FakeSocket.last?.deliver(makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }));
    expect(onRunChange).toHaveBeenLastCalledWith({ runId: TEST_IDS.runId, ended: false });

    const calls = onRunChange.mock.calls.length;
    FakeSocket.last?.deliver(makeCommittedEvent("run.cancelled", {}, { sessionSequence: 2 }));
    expect(onRunChange).toHaveBeenLastCalledWith({ runId: TEST_IDS.runId, ended: true });
    expect(onRunChange.mock.calls.length).toBe(calls + 1);
  });
});
