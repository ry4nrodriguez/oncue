// Changing a session's model from the session screen (record 15): the chip's
// model rows open between runs, a choice is confirmed before it counts, and
// the next message carries it as a `run.start` on the other model.

import type { RunId, RunView } from "@oncue/protocol";
import { makeCommittedEvent, TEST_IDS, testModelRecord } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelConnectionSummary, ModelSpecSummary } from "@/lib/api/setup";
import { outgoingMessage, SessionScreen, type SessionScreenProps } from "./SessionScreen";

/** Enough of a WebSocket to drive the screen's sends without a network. */
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

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  deliver(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    });
  }
}

beforeAll(() => {
  // The timeline and the split need ResizeObserver, which jsdom does not implement.
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  window.localStorage.clear();
  cleanup();
  FakeSocket.last = null;
});

function spec(modelId: string, name: string, overrides: Partial<ModelSpecSummary> = {}) {
  return {
    modelId,
    name,
    contextWindow: 200_000,
    effort: null,
    defaultEffort: null,
    price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    status: "current" as const,
    recommended: true,
    ...overrides,
  } satisfies ModelSpecSummary;
}

/** The key the testing run record names, with the model it names. */
const ANTHROPIC_KEY: ModelConnectionSummary = {
  modelConnectionId: testModelRecord().modelConnectionId,
  label: "anthropic …0a1b",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  models: [spec("claude-sonnet-4-5", "Claude Sonnet 4.5")],
};

const OPENAI_KEY: ModelConnectionSummary = {
  modelConnectionId: "conn_openai",
  label: "openai …9c3d",
  provider: "openai",
  modelId: "gpt-6-sol",
  models: [
    spec("gpt-6-sol", "GPT-6 Sol", {
      contextWindow: 100_000,
      effort: ["low", "medium", "high"],
      defaultEffort: "medium",
    }),
  ],
};

function renderSession(props: Partial<SessionScreenProps> = {}) {
  render(
    <SessionScreen
      sessionId="sess_1"
      createSocket={(url) => new FakeSocket(url) as unknown as WebSocket}
      modelConnections={[ANTHROPIC_KEY, OPENAI_KEY]}
      {...props}
    />,
  );
  FakeSocket.last?.open();
}

function deliver(...events: unknown[]) {
  events.forEach((event, index) => {
    FakeSocket.last?.deliver({ ...(event as object), sessionSequence: index + 1 });
  });
}

const QUEUED = makeCommittedEvent("run.queued");
const ENDED = makeCommittedEvent("run.verified");
const PAUSED = makeCommittedEvent("run.paused", {
  payload: {
    reason: "model_failure",
    modelFailure: {
      category: "authentication_failed",
      message: "The stored key was rejected.",
      retries: 0,
    },
  },
});

/** Opens the chip and picks the row for a model; the row is absent when the model is fixed. */
function pickModel(modelId: string) {
  // The panel stays open after a choice, so a second pick finds it open.
  if (screen.queryAllByTestId("model-row").length === 0) {
    fireEvent.click(screen.getByTestId("agent-chip"));
  }
  const row = screen
    .getAllByTestId("model-row")
    .find((candidate) => candidate.getAttribute("data-model") === modelId);
  if (row === undefined) {
    throw new Error(`no row for ${modelId}`);
  }
  fireEvent.click(row);
}

function sentCommands(): Array<Record<string, unknown>> {
  return (FakeSocket.last?.sent ?? []).map((raw) => JSON.parse(raw).command);
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("Send message"));
}

function makeRunView(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: TEST_IDS.runId as RunId,
    state: "verified",
    outcome: "verified",
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
    ...overrides,
  };
}

describe("outgoingMessage with a confirmed model change", () => {
  const next = {
    provider: "openai",
    modelId: "gpt-6-sol",
    modelConnectionId: "conn_openai",
    authenticationType: "api_key" as const,
    contextWindow: 100_000,
    effort: "medium" as const,
  };

  it("starts a run on the other model, continuing the ended run", () => {
    const command = outgoingMessage(
      makeRunView(),
      "carry on",
      "cmd_1",
      true,
      true,
      false,
      undefined,
      [],
      next,
    );
    expect(command).toMatchObject({
      type: "run.start",
      payload: { model: next, continuesRunId: TEST_IDS.runId, instruction: { text: "carry on" } },
    });
  });

  it("starts a run rather than continuing a paused or interrupted one, whose sandbox may still be up", () => {
    for (const state of ["paused", "interrupted"] as const) {
      const run = makeRunView({ state, outcome: null });
      expect(
        outgoingMessage(run, "carry on", "cmd_1", true, false, false, undefined, [], next),
      ).toMatchObject({ type: "run.start", payload: { model: next } });
    }
  });

  it("keeps a working run's model: the message steers it as before", () => {
    const run = makeRunView({ state: "running", outcome: null });
    expect(
      outgoingMessage(run, "look", "cmd_1", true, true, false, undefined, [], next),
    ).toMatchObject({ type: "run.follow_up" });
  });

  it("carries the message's attachments and its skip of the checks", () => {
    const ref = { artifactId: "art_1" } as never;
    const command = outgoingMessage(
      makeRunView(),
      "look",
      "cmd_1",
      true,
      true,
      true,
      undefined,
      [ref],
      next,
    );
    expect(command).toMatchObject({
      payload: { skipRequiredChecks: true, instruction: { attachments: [ref] } },
    });
  });
});

describe("the session's model chip", () => {
  it("offers no other model while a run is working", () => {
    renderSession();
    deliver(QUEUED, makeCommittedEvent("run.started"));
    fireEvent.click(screen.getByTestId("agent-chip"));
    expect(screen.queryAllByTestId("model-row")).toEqual([]);
  });

  it("offers no other model on an archived session", () => {
    renderSession({ archived: true });
    deliver(QUEUED, ENDED);
    expect(screen.queryByTestId("agent-chip")).toBeNull();
  });

  it("says under the composer what the chosen model will do, with no dialog, and sends nothing", () => {
    renderSession();
    deliver(QUEUED, ENDED);
    pickModel("gpt-6-sol");

    expect(screen.queryByText(/for the next run\?/)).toBeNull();
    const note = screen.getByTestId("composer-next-model");
    // The model, the effort it opens on, and whose key is charged.
    expect(note.textContent).toContain(
      "Your next message starts a run on GPT-6 Sol at medium effort, charged to your OpenAI key (openai …9c3d).",
    );
    // A smaller window that still fits is not a warning; the meter shows it.
    expect(within(note).queryByTestId("composer-next-model-shortfall")).toBeNull();
    // An ended run is not ended again.
    expect(within(note).queryByTestId("composer-next-model-ends-run")).toBeNull();
    expect(sentCommands()).toEqual([]);
  });

  it("sends the next message as a run on the chosen model, charged to its key", async () => {
    renderSession();
    deliver(QUEUED, ENDED);
    pickModel("gpt-6-sol");

    expect(screen.getByTestId("agent-chip-model").textContent).toBe("GPT-6 Sol");
    expect(screen.getByTestId("agent-chip-effort").textContent).toBe("medium");

    typeAndSend("carry on");
    await vi.waitFor(() => expect(sentCommands()).toHaveLength(1));
    expect(sentCommands()[0]).toMatchObject({
      type: "run.start",
      expected: { scope: "session", state: "active" },
      payload: {
        instruction: { text: "carry on" },
        continuesRunId: TEST_IDS.runId,
        model: {
          provider: "openai",
          modelId: "gpt-6-sol",
          modelConnectionId: "conn_openai",
          effort: "medium",
        },
      },
    });
  });

  it("goes back to the run's model from the note, or by picking it again", async () => {
    renderSession();
    deliver(QUEUED, ENDED);
    pickModel("gpt-6-sol");
    pickModel("claude-sonnet-4-5");
    expect(screen.queryByTestId("composer-next-model")).toBeNull();
    expect(screen.getByTestId("agent-chip-model").textContent).toBe("Sonnet 4.5");

    pickModel("gpt-6-sol");
    fireEvent.click(screen.getByTestId("composer-next-model-undo"));
    expect(screen.queryByTestId("composer-next-model")).toBeNull();
    expect(screen.getByTestId("agent-chip-model").textContent).toBe("Sonnet 4.5");

    typeAndSend("carry on");
    await vi.waitFor(() => expect(sentCommands()).toHaveLength(1));
    expect(sentCommands()[0]).toMatchObject({
      type: "run.start",
      payload: { model: { modelId: testModelRecord().modelId } },
    });
  });

  it("picking the run's own model changes nothing", () => {
    renderSession();
    deliver(QUEUED, ENDED);
    pickModel("claude-sonnet-4-5");
    expect(screen.queryByTestId("composer-next-model")).toBeNull();
  });

  it("drops the choice once another run has started, so it never moves a later run", () => {
    renderSession();
    deliver(QUEUED, ENDED);
    pickModel("gpt-6-sol");
    expect(screen.getByTestId("composer-next-model")).toBeTruthy();

    FakeSocket.last?.deliver({
      ...makeCommittedEvent("run.queued", { runId: "run_2" as RunId, eventId: "evt_q2" as never }),
      sessionSequence: 3,
    });
    expect(screen.queryByTestId("composer-next-model")).toBeNull();
    expect(screen.getByTestId("agent-chip-model").textContent).toBe("Sonnet 4.5");
  });

  it("lets a run paused on a refused key continue on another model, which the composer otherwise could not", async () => {
    // Only the OpenAI key is active: the run's own was refused.
    renderSession({ modelConnections: [OPENAI_KEY] });
    deliver(QUEUED, PAUSED);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId("composer-model-failure")).toBeTruthy();
    // The chip opens although the box takes no message, and the note says so.
    expect((screen.getByTestId("agent-chip") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("composer-model-switch-hint").textContent).toContain(
      "choose another model to continue on",
    );

    pickModel("gpt-6-sol");
    // A paused run keeps its model, so the note says it ends.
    expect(screen.getByTestId("composer-next-model-ends-run").textContent).toContain(
      "it ends when you send, and a new run continues its conversation",
    );

    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId("composer-model-failure")).toBeNull();
    expect(screen.queryByTestId("composer-model-switch-hint")).toBeNull();
    typeAndSend("carry on");
    await vi.waitFor(() => expect(sentCommands()).toHaveLength(1));
    expect(sentCommands()[0]).toMatchObject({
      type: "run.start",
      payload: { continuesRunId: TEST_IDS.runId, model: { modelConnectionId: "conn_openai" } },
    });
  });

  it("does not point at the model menu when no other key could run a model", () => {
    // The run's key was refused and the workspace has no other.
    renderSession({ modelConnections: [] });
    deliver(QUEUED, PAUSED);
    expect(screen.getByTestId("composer-model-failure")).toBeTruthy();
    expect(screen.queryByTestId("composer-model-switch-hint")).toBeNull();
  });

  it("offers a send on a paused run whose sandbox is still up once another model is chosen", async () => {
    renderSession();
    deliver(
      QUEUED,
      makeCommittedEvent("sandbox.provisioning"),
      makeCommittedEvent("run.started"),
      PAUSED,
    );
    expect(screen.getByTestId("composer-model-failure")).toBeTruthy();

    pickModel("gpt-6-sol");
    expect(screen.queryByTestId("composer-model-failure")).toBeNull();
    typeAndSend("carry on");
    await vi.waitFor(() => expect(sentCommands()).toHaveLength(1));
    expect(sentCommands()[0]).toMatchObject({ type: "run.start" });
  });
});
