import type { CommandId, SessionView } from "@oncue/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRunCommand } from "./command-builders";
import {
  ANSWER_TIMEOUT_MS,
  type CommandOutcome,
  outcomeProblem,
  useCommandAction,
  useCommands,
} from "./use-commands";
import type { SendResult } from "./use-session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Answers = SessionView["commands"];
type Hooks = ReturnType<typeof useCommands>;

function answered(commandId: string, state: "acknowledged" | "rejected"): Answers {
  return new Map([
    [
      commandId as CommandId,
      {
        commandId: commandId as CommandId,
        commandType: "run.cancel",
        state,
        acceptedBy: state === "acknowledged" ? "control_plane" : null,
        rejection:
          state === "rejected"
            ? {
                reason: "wrong_state",
                expectedState: "running",
                actualState: "cancelled",
                detail: "the run already ended",
              }
            : null,
        at: "2026-10-04T00:00:00.000Z",
      },
    ],
  ]) as unknown as Answers;
}

const RUN = { runId: "run_1" as never, state: "running" as const };

function Probe({
  commands,
  send,
  cancel = () => false,
  onReady,
}: {
  commands: Answers;
  send: (options: { onSent?: () => void; queue?: boolean }) => SendResult;
  cancel?: (commandId: string) => boolean;
  onReady: (hooks: Hooks) => void;
}) {
  const hooks = useCommands(commands, (_command, options = {}) => send(options), cancel);
  onReady(hooks);
  return null;
}

describe("outcomeProblem", () => {
  it("has words for every failure and none for success or a withdrawal", () => {
    expect(outcomeProblem({ kind: "acknowledged" })).toBeNull();
    expect(outcomeProblem({ kind: "withdrawn" })).toBeNull();
    expect(outcomeProblem({ kind: "rejected", reason: "wrong_state", detail: "too late" })).toBe(
      "Not accepted: too late.",
    );
    expect(outcomeProblem({ kind: "unanswered" })).toContain("didn't answer");
    expect(outcomeProblem({ kind: "not_sent" })).toContain("Not sent");
  });
});

describe("useCommands", () => {
  it("settles on the object's answer, rejection detail included", async () => {
    let hooks: Hooks | undefined;
    const send = (options: { onSent?: () => void }) => {
      options.onSent?.();
      return "sent" as const;
    };
    const view = render(<Probe commands={new Map()} send={send} onReady={(h) => (hooks = h)} />);
    const issued = hooks?.issue(cancelRunCommand(RUN, "cmd_1"));
    expect(issued?.sent).toBe("sent");

    view.rerender(
      <Probe commands={answered("cmd_1", "rejected")} send={send} onReady={(h) => (hooks = h)} />,
    );

    await expect(issued?.outcome).resolves.toEqual({
      kind: "rejected",
      reason: "wrong_state",
      detail: "the run already ended",
    });
  });

  it("answers at once, without sending, for an id the object already answered", async () => {
    let hooks: Hooks | undefined;
    const send = vi.fn(() => "sent" as const);
    render(
      <Probe
        commands={answered("cmd_1", "acknowledged")}
        send={send}
        onReady={(h) => (hooks = h)}
      />,
    );

    const issued = hooks?.issue(cancelRunCommand(RUN, "cmd_1"));

    expect(issued?.sent).toBe("answered");
    await expect(issued?.outcome).resolves.toEqual({ kind: "acknowledged" });
    expect(send).not.toHaveBeenCalled();
  });

  it("is not_sent when no socket took it and it was not to be held", async () => {
    let hooks: Hooks | undefined;
    render(<Probe commands={new Map()} send={() => "not_sent"} onReady={(h) => (hooks = h)} />);

    await expect(hooks?.issue(cancelRunCommand(RUN, "cmd_1")).outcome).resolves.toEqual({
      kind: "not_sent",
    });
  });

  it("starts the answer clock only once a held command leaves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let hooks: Hooks | undefined;
    let flush: (() => void) | undefined;
    render(
      <Probe
        commands={new Map()}
        send={(options) => {
          flush = options.onSent;
          return "queued";
        }}
        onReady={(h) => (hooks = h)}
      />,
    );
    let outcome: CommandOutcome | null = null;
    act(() => {
      void hooks?.issue(cancelRunCommand(RUN, "cmd_1"), { queue: true }).outcome.then((value) => {
        outcome = value;
      });
    });
    expect(hooks?.queued.has("cmd_1")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS * 2);
    });
    expect(outcome).toBeNull();

    act(() => {
      flush?.();
    });
    expect(hooks?.queued.has("cmd_1")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
    });
    expect(outcome).toEqual({ kind: "unanswered" });
  });

  it("withdraws a held command, and refuses once it has left", async () => {
    let hooks: Hooks | undefined;
    const cancel = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    render(
      <Probe
        commands={new Map()}
        send={() => "queued"}
        cancel={cancel}
        onReady={(h) => (hooks = h)}
      />,
    );
    let issued: ReturnType<Hooks["issue"]> | undefined;
    act(() => {
      issued = hooks?.issue(cancelRunCommand(RUN, "cmd_1"), { queue: true });
    });

    let withdrew: boolean | undefined;
    act(() => {
      withdrew = hooks?.withdraw("cmd_1");
    });
    expect(withdrew).toBe(true);
    await expect(issued?.outcome).resolves.toEqual({ kind: "withdrawn" });
    expect(hooks?.withdraw("cmd_1")).toBe(false);
  });

  it("gives an earlier wait under the same id up when the id is sent again", async () => {
    let hooks: Hooks | undefined;
    render(<Probe commands={new Map()} send={() => "sent"} onReady={(h) => (hooks = h)} />);
    const first = hooks?.issue(cancelRunCommand(RUN, "cmd_1"));
    hooks?.issue(cancelRunCommand(RUN, "cmd_1"));

    await expect(first?.outcome).resolves.toEqual({ kind: "unanswered" });
  });
});

describe("useCommandAction", () => {
  function Button({
    subject,
    send,
  }: {
    subject: string;
    send: () => Promise<CommandOutcome> | CommandOutcome;
  }) {
    const action = useCommandAction(subject);
    return (
      <div>
        <button type="button" disabled={action.busy} onClick={() => void action.run(send)}>
          go
        </button>
        <p data-testid="problem">{action.problem ?? ""}</p>
      </div>
    );
  }

  it("stays off after an accepted command until its subject moves on, and drops an old problem", async () => {
    const send = vi
      .fn<() => CommandOutcome>()
      .mockReturnValueOnce({ kind: "not_sent" })
      .mockReturnValue({ kind: "acknowledged" });
    const view = render(<Button subject="a" send={send} />);
    const button = view.getByRole("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    expect(view.getByTestId("problem").textContent).toContain("Not sent");
    view.rerender(<Button subject="b" send={send} />);
    expect(view.getByTestId("problem").textContent).toBe("");

    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(true);
    view.rerender(<Button subject="c" send={send} />);
    expect(button.disabled).toBe(false);
  });

  it("frees the button when the send returns nothing to wait on", async () => {
    function Bare() {
      const action = useCommandAction();
      return (
        <button type="button" disabled={action.busy} onClick={() => void action.run(() => null)}>
          go
        </button>
      );
    }
    const view = render(<Bare />);
    const button = view.getByRole("button") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(false);
  });

  it("sets nothing once the button is gone", async () => {
    let finish: (outcome: CommandOutcome) => void = () => {};
    const view = render(
      <Button
        subject="a"
        send={() =>
          new Promise<CommandOutcome>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await act(async () => {
      (view.getByRole("button") as HTMLButtonElement).click();
    });
    view.unmount();
    await act(async () => {
      finish({ kind: "not_sent" });
    });
  });
});

describe("issueAction", () => {
  function Actions({
    commands,
    send,
    onReady,
  }: {
    commands: Answers;
    send: () => SendResult;
    onReady: (hooks: Hooks) => void;
  }) {
    const hooks = useCommands(
      commands,
      (_command, options = {}) => {
        const result = send();
        if (result === "sent") {
          options.onSent?.();
        }
        return result;
      },
      () => false,
    );
    onReady(hooks);
    return null;
  }

  it("keeps an action's id through no answer and mints a new one after any answer or a send that did not leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let hooks: Hooks | undefined;
    const ids: string[] = [];
    const send = vi.fn<() => SendResult>(() => "sent");
    const view = render(<Actions commands={new Map()} send={send} onReady={(h) => (hooks = h)} />);
    const press = () => {
      let outcome: Promise<CommandOutcome | null> | undefined;
      act(() => {
        outcome = hooks?.issueAction("cancel:run_1", (commandId) => {
          ids.push(commandId);
          return cancelRunCommand(RUN, commandId);
        });
      });
      return outcome;
    };

    const first = press();
    await act(async () => {
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
    });
    await expect(first).resolves.toEqual({ kind: "unanswered" });
    const second = press();
    expect(ids[1]).toBe(ids[0]);

    view.rerender(
      <Actions
        commands={answered(ids[0] as string, "acknowledged")}
        send={send}
        onReady={(h) => (hooks = h)}
      />,
    );
    await expect(second).resolves.toEqual({ kind: "acknowledged" });
    void press();
    expect(ids[2]).not.toBe(ids[0]);

    send.mockReturnValue("not_sent");
    view.rerender(<Actions commands={new Map()} send={send} onReady={(h) => (hooks = h)} />);
    await act(async () => {
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
    });
    const lost = press();
    await expect(lost).resolves.toEqual({ kind: "not_sent" });
    void press();
    expect(ids[4]).not.toBe(ids[3]);
  });

  it("sends nothing and keeps no id when there is nothing to build", async () => {
    let hooks: Hooks | undefined;
    const send = vi.fn<() => SendResult>(() => "sent");
    render(<Actions commands={new Map()} send={send} onReady={(h) => (hooks = h)} />);
    const built: string[] = [];

    await expect(
      hooks?.issueAction("checks:run_1", (commandId) => {
        built.push(commandId);
        return null;
      }),
    ).resolves.toBeNull();
    await hooks?.issueAction("checks:run_1", (commandId) => {
      built.push(commandId);
      return null;
    });

    expect(send).not.toHaveBeenCalled();
    expect(built[1]).not.toBe(built[0]);
  });
});
