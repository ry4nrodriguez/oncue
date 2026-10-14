import { type ApprovalView, foldEvents, type SessionView } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineRow } from "@/features/session/Timeline";
import type { ApprovalSettingsResult } from "@/lib/api/approval-settings";
import { APPROVAL_MENU_HEADING, ApprovalModeMenu } from "./ApprovalModeMenu";
import {
  CATEGORY_LABEL,
  cardScopes,
  effectiveMode,
  harnessAsksPermission,
  MODE_CHOICES,
  modeChoice,
  openPermissionApproval,
  settledLine,
} from "./approval-modes";
import { PermissionCard, PermissionLine } from "./PermissionCard";
import { useApprovalSettings } from "./use-approval-settings";
import { useHomeApprovalMode } from "./use-home-approval-mode";
import { useSessionApprovals } from "./use-session-approvals";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

const EXPIRES_AT = "2026-10-04T12:10:00.000Z";
const started = makeCommittedEvent("run.started", { eventId: "evt_p_1" }, { sessionSequence: 1 });

function asked(
  category:
    | "outside_project"
    | "secret_file"
    | "repeated_action"
    | "other_request" = "outside_project",
  title = "Read /etc/hosts, outside the project",
) {
  return makeCommittedEvent(
    "approval.requested",
    {
      eventId: "evt_p_2",
      payload: {
        approvalId: "apr_p",
        title,
        intendedAction: "x",
        category,
        risk: "medium",
        resource: "/etc/hosts",
        requestedScope: CATEGORY_LABEL[category],
        expiresAt: EXPIRES_AT,
        toolCallId: null,
        toolCategory: "file_read",
      },
    },
    { sessionSequence: 2 },
  );
}

function resolved(
  decision: "approved" | "rejected",
  scope?: "once" | "session" | "always",
  automatic?: boolean,
) {
  return makeCommittedEvent(
    "approval.resolved",
    {
      eventId: "evt_p_3",
      payload: {
        approvalId: "apr_p",
        decision,
        ...(scope === undefined ? {} : { scope }),
        ...(automatic === undefined ? {} : { automatic }),
      },
    },
    { sessionSequence: 3 },
  );
}

const approvalOf = (view: SessionView) => view.approvals.get("apr_p" as never) as ApprovalView;

describe("modes", () => {
  it("are the owner's three, in order, with the owner's words", () => {
    expect(MODE_CHOICES.map((choice) => [choice.name, choice.description])).toEqual([
      ["Allow once", "Ask me each time the agent needs something outside the usual."],
      ["Allow for this session", "Don't ask again in this session."],
      ["Always allow", "Don't ask in any session. You can change this in Settings."],
    ]);
    expect(modeChoice("session").chip).toBe("This session");
  });

  it("show the workspace's always over the session's own choice, and ask when there is none", () => {
    expect(effectiveMode(null, "ask")).toBe("ask");
    expect(effectiveMode("session", "ask")).toBe("session");
    expect(effectiveMode("ask", "always")).toBe("always");
    expect(effectiveMode("always", "ask")).toBe("ask");
  });

  it("claim no mode while the workspace's default is not known", () => {
    expect(effectiveMode(null, null)).toBeNull();
    expect(effectiveMode("session", null)).toBeNull();
  });

  it("are shown only for a harness whose own gate asks", () => {
    expect(harnessAsksPermission(null)).toBe(true);
    expect(harnessAsksPermission("opencode")).toBe(true);
    expect(harnessAsksPermission("claude")).toBe(true);
    expect(harnessAsksPermission("codex")).toBe(false);
    expect(harnessAsksPermission("pi")).toBe(false);
  });

  it("offer only once or no for secret files", () => {
    expect(cardScopes("secret_file")).toEqual(["once"]);
    expect(cardScopes("repeated_action")).toEqual(["once", "session", "always"]);
  });
});

describe("ApprovalModeMenu", () => {
  it("names the mode in force in plain words, with an accessible name and no icon", () => {
    const { rerender } = render(<ApprovalModeMenu mode="ask" />);
    const picker = screen.getByRole("button", { name: /^Approvals: Allow once/ });
    expect(picker.getAttribute("title")).toBe("Approvals: Allow once");
    expect(screen.getByTestId("approval-mode-chip").textContent).toBe("Allow once");
    rerender(<ApprovalModeMenu mode="always" />);
    expect(screen.getByTestId("approval-mode-chip").textContent).toBe("Always allow");
  });

  it("asks its question and checks the current mode", async () => {
    render(<ApprovalModeMenu mode="session" onChange={vi.fn()} />);
    pointerClick(screen.getByTestId("approval-mode"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(APPROVAL_MENU_HEADING)).toBeTruthy();
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(within(menu).getByRole("group", { name: APPROVAL_MENU_HEADING })).toBeTruthy();
  });

  it("reports a new choice and not the current one", async () => {
    const onChange = vi.fn();
    render(<ApprovalModeMenu mode="ask" onChange={onChange} />);
    pointerClick(screen.getByTestId("approval-mode"));
    const menu = await screen.findByRole("menu");
    pointerClick(within(menu).getByTestId("approval-mode-ask"));
    pointerClick(screen.getByTestId("approval-mode"));
    pointerClick(within(await screen.findByRole("menu")).getByTestId("approval-mode-always"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("always"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("says only Approvals, and checks no row, when the mode is not known", async () => {
    const onChange = vi.fn();
    render(<ApprovalModeMenu mode={null} onChange={onChange} />);
    const picker = screen.getByTestId("approval-mode");
    expect(picker.getAttribute("data-mode")).toBe("unknown");
    expect(picker.getAttribute("title")).toBe("Approvals");
    expect(picker.getAttribute("aria-label")).toMatch(/^Approvals: not known/);
    expect(screen.getByTestId("approval-mode-chip").textContent).toBe("Approvals");
    pointerClick(picker);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((row) => row.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false"]);
    pointerClick(within(menu).getByTestId("approval-mode-ask"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("ask"));
  });

  it("cannot be opened while disabled", () => {
    render(<ApprovalModeMenu mode="ask" disabled />);
    pointerClick(screen.getByTestId("approval-mode"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("PermissionCard", () => {
  const ACCEPTED = { kind: "acknowledged" } as const;

  it("says what the agent wants, its category, and when silence denies it", () => {
    const view = foldEvents([started, asked()]);
    render(<PermissionCard approval={approvalOf(view)} onAnswer={vi.fn(() => ACCEPTED)} />);
    const card = screen.getByTestId("permission-card");
    expect(within(card).getByTestId("permission-title").textContent).toBe(
      "Read /etc/hosts, outside the project",
    );
    expect(card.textContent).toContain("Files outside the project");
    expect(card.textContent).toContain("Denied if not answered by");
    expect(
      within(card)
        .getAllByRole("button")
        .filter((button) => /^permission-(allow|deny)/.test(button.dataset.testid ?? ""))
        .map((button) => button.querySelector("[data-label]")?.textContent),
    ).toEqual(["Allow once", "Allow for this session", "Always allow", "Deny"]);
  });

  it("sends the decision and how far it reaches, and stays off once accepted", async () => {
    const onAnswer = vi.fn(async () => ACCEPTED);
    render(
      <PermissionCard approval={approvalOf(foldEvents([started, asked()]))} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByTestId("permission-allow-session"));
    expect(onAnswer).toHaveBeenCalledWith({
      approvalId: "apr_p",
      decision: "approved",
      scope: "session",
    });
    await waitFor(() =>
      expect((screen.getByTestId("permission-deny") as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(screen.getByTestId("permission-deny"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("answers with its number keys, each row saying what it does, and ignores a held modifier", () => {
    const onAnswer = vi.fn(async () => ACCEPTED);
    render(
      <PermissionCard approval={approvalOf(foldEvents([started, asked()]))} onAnswer={onAnswer} />,
    );
    expect(
      screen
        .getByRole("button", { name: "Allow for this session" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("2");
    expect(screen.getByText("Don't ask again in any session.")).toBeTruthy();
    const card = screen.getByTestId("permission-card");
    fireEvent.keyDown(card, { key: "2", metaKey: true });
    fireEvent.keyDown(card, { key: "9" });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "4" });
    expect(onAnswer).toHaveBeenCalledWith({ approvalId: "apr_p", decision: "rejected" });
  });

  it.each([
    [
      { kind: "rejected", reason: "wrong_state", detail: "the approval expired" } as const,
      "Not accepted: the approval expired.",
    ],
    [{ kind: "unanswered" } as const, "OnCue didn't answer in time. Try again."],
    [{ kind: "not_sent" } as const, "Not sent: OnCue is reconnecting. Try again in a moment."],
  ])("gives the buttons back and says why when the answer is %j", async (outcome, words) => {
    const onAnswer = vi.fn(async () => outcome);
    render(
      <PermissionCard approval={approvalOf(foldEvents([started, asked()]))} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByTestId("permission-deny"));
    expect(onAnswer).toHaveBeenNthCalledWith(1, { approvalId: "apr_p", decision: "rejected" });
    expect(await screen.findByTestId("permission-problem")).toHaveProperty("textContent", words);
    expect((screen.getByTestId("permission-deny") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("permission-allow-once"));
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("starts fresh for a new ask, since the screen keys it by the approval", async () => {
    const view = foldEvents([started, asked()]);
    const onAnswer = vi.fn(async () => ACCEPTED);
    const { rerender } = render(
      <PermissionCard key="apr_p" approval={approvalOf(view)} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByTestId("permission-allow-once"));
    await waitFor(() =>
      expect((screen.getByTestId("permission-deny") as HTMLButtonElement).disabled).toBe(true),
    );
    const next = { ...approvalOf(view), approvalId: "apr_next" as ApprovalView["approvalId"] };
    rerender(<PermissionCard key="apr_next" approval={next} onAnswer={onAnswer} />);
    expect((screen.getByTestId("permission-deny") as HTMLButtonElement).disabled).toBe(false);
  });

  it("folds to its one line and opens again", () => {
    render(<PermissionCard approval={approvalOf(foldEvents([started, asked()]))} />);
    fireEvent.click(screen.getByTestId("permission-card-collapse"));
    expect(screen.getByTestId("permission-card").dataset.collapsed).toBe("true");
    expect(screen.getByTestId("permission-title").textContent).toBe(
      "Read /etc/hosts, outside the project",
    );
    fireEvent.click(screen.getByTestId("permission-card-expand"));
    expect(screen.getByTestId("permission-card").dataset.collapsed).toBe("false");
  });

  it("offers a secret file only Allow once or Deny", () => {
    const view = foldEvents([started, asked("secret_file", "Read .env, a secret file")]);
    render(<PermissionCard approval={approvalOf(view)} onAnswer={vi.fn(() => ACCEPTED)} />);
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => /^permission-(allow|deny)/.test(button.dataset.testid ?? ""))
        .map((button) => button.querySelector("[data-label]")?.textContent),
    ).toEqual(["Allow once", "Deny"]);
  });

  it("shows no answers in a read-only surface and nothing for a secret's approval", () => {
    const view = foldEvents([started, asked()]);
    render(<PermissionCard approval={approvalOf(view)} />);
    expect(screen.queryByTestId("permission-deny")).toBeNull();
    cleanup();
    const secret = { ...approvalOf(view), category: "development_secret" as const };
    const { container } = render(<PermissionCard approval={secret} />);
    expect(container.textContent).toBe("");
  });
});

describe("the timeline", () => {
  it.each([
    [resolved("approved", "once"), "Allowed once: read /etc/hosts, outside the project"],
    [
      resolved("approved", "session", true),
      "Allowed for this session: read /etc/hosts, outside the project",
    ],
    [resolved("approved", "always"), "Always allowed: read /etc/hosts, outside the project"],
    [resolved("approved"), "Allowed once: read /etc/hosts, outside the project"],
    [resolved("rejected"), "Denied: read /etc/hosts, outside the project"],
  ])("folds a settled ask into one line", (event, line) => {
    const view = foldEvents([started, asked(), event]);
    render(
      <div>
        {view.timeline.map((item) => (
          <TimelineRow key={item.sequence} view={view} item={item} />
        ))}
      </div>,
    );
    expect(screen.getAllByTestId("row-permission").map((row) => row.textContent)).toEqual([line]);
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("says when silence denied it or the sandbox ended it", () => {
    const expired = (effect: "tool_denied" | "run_paused") =>
      makeCommittedEvent(
        "approval.expired",
        { eventId: "evt_p_4", payload: { approvalId: "apr_p", effect } },
        { sessionSequence: 3 },
      );
    expect(settledLine(approvalOf(foldEvents([started, asked(), expired("tool_denied")])))).toBe(
      "Denied, no answer in time: read /etc/hosts, outside the project",
    );
    expect(settledLine(approvalOf(foldEvents([started, asked(), expired("run_paused")])))).toBe(
      "Ended with the sandbox: read /etc/hosts, outside the project",
    );
  });

  it("shows nothing while the ask waits, since the card is above the composer", () => {
    const view = foldEvents([started, asked()]);
    const { container } = render(<PermissionLine approval={approvalOf(view)} />);
    expect(container.textContent).toBe("");
    expect(openPermissionApproval(view)?.approvalId).toBe("apr_p");
    expect(openPermissionApproval(foldEvents([started, asked(), resolved("rejected")]))).toBeNull();
  });
});

const READ_ASK: ApprovalSettingsResult = {
  kind: "read",
  settings: { defaultMode: "ask", rules: [] },
};
const READ_ALWAYS: ApprovalSettingsResult = {
  kind: "read",
  settings: { defaultMode: "always", rules: [] },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useApprovalSettings", () => {
  it("reads again when the window regains focus, so a change elsewhere shows", async () => {
    const read = vi.fn(async () => READ_ASK);
    const { result } = renderHook(() => useApprovalSettings(read));
    await waitFor(() => expect(result.current.defaultMode).toBe("ask"));
    read.mockResolvedValue(READ_ALWAYS);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.defaultMode).toBe("always"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("knows no default while loading or when the read fails", async () => {
    const read = vi.fn(async (): Promise<ApprovalSettingsResult> => ({ kind: "unreachable" }));
    const { result } = renderHook(() => useApprovalSettings(read));
    expect(result.current.status).toBe("loading");
    expect(result.current.defaultMode).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.defaultMode).toBeNull();
  });

  it("sends saves one at a time, and the latest choice is what stays", async () => {
    const first = deferred<ApprovalSettingsResult>();
    const calls: string[] = [];
    const save = vi.fn((mode: "ask" | "always") => {
      calls.push(mode);
      return calls.length === 1
        ? first.promise
        : Promise.resolve(mode === "always" ? READ_ALWAYS : READ_ASK);
    });
    const { result } = renderHook(() => useApprovalSettings(async () => READ_ASK, save));
    await waitFor(() => expect(result.current.status).toBe("read"));
    act(() => result.current.save("always"));
    act(() => result.current.save("ask"));
    act(() => result.current.save("always"));
    // Shown at once, while the saves go out.
    expect(result.current.defaultMode).toBe("always");
    expect(calls).toEqual(["always"]);
    await act(async () => {
      first.resolve(READ_ALWAYS);
    });
    await waitFor(() => expect(calls).toEqual(["always", "always"]));
    await waitFor(() => expect(result.current.defaultMode).toBe("always"));
  });

  it("drops a read that started before a save, so the mount's read cannot undo a choice", async () => {
    const slow = deferred<ApprovalSettingsResult>();
    const read = vi.fn(() => slow.promise);
    const save = vi.fn(async () => READ_ALWAYS);
    const { result } = renderHook(() => useApprovalSettings(read, save));
    act(() => result.current.save("always"));
    await waitFor(() => expect(result.current.status).toBe("read"));
    await act(async () => {
      slow.resolve(READ_ASK);
    });
    expect(result.current.defaultMode).toBe("always");
  });

  it("asks the server what is in force when a save fails", async () => {
    const read = vi.fn(async () => READ_ASK);
    const save = vi.fn(async (): Promise<ApprovalSettingsResult> => ({ kind: "unreachable" }));
    const { result } = renderHook(() => useApprovalSettings(read, save));
    await waitFor(() => expect(result.current.status).toBe("read"));
    act(() => result.current.save("always"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.defaultMode).toBe("ask"));
  });

  it("does nothing after the screen is gone", async () => {
    const pending = deferred<ApprovalSettingsResult>();
    const { result, unmount } = renderHook(() =>
      useApprovalSettings(
        async () => READ_ASK,
        () => pending.promise,
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("read"));
    act(() => result.current.save("always"));
    unmount();
    await act(async () => {
      pending.resolve(READ_ALWAYS);
    });
    expect(result.current.defaultMode).toBe("always");
  });
});

describe("useHomeApprovalMode", () => {
  it("shows the workspace's always, and resets it to ask when another mode is chosen", async () => {
    const save = vi.fn(async (mode: "ask" | "always") =>
      mode === "always" ? READ_ALWAYS : READ_ASK,
    );
    const read = vi.fn(async () => READ_ALWAYS);
    const { result } = renderHook(() => useHomeApprovalMode(read, save));
    await waitFor(() => expect(result.current.mode).toBe("always"));
    expect(result.current.createMode).toBeUndefined();
    act(() => result.current.change("session"));
    await waitFor(() => expect(result.current.mode).toBe("session"));
    expect(save).toHaveBeenCalledWith("ask");
    expect(result.current.createMode).toBe("session");
  });

  it("saves always, and holds a session choice for the create request", async () => {
    const save = vi.fn(async (mode: "ask" | "always") =>
      mode === "always" ? READ_ALWAYS : READ_ASK,
    );
    const read = vi.fn(async () => READ_ASK);
    const { result } = renderHook(() => useHomeApprovalMode(read, save));
    await waitFor(() => expect(result.current.mode).toBe("ask"));
    act(() => result.current.change("session"));
    expect(result.current.createMode).toBe("session");
    act(() => result.current.change("always"));
    await waitFor(() => expect(result.current.mode).toBe("always"));
    expect(save).toHaveBeenLastCalledWith("always");
  });

  it("claims no mode when the settings cannot be read", async () => {
    const read = vi.fn(async (): Promise<ApprovalSettingsResult> => ({ kind: "unreachable" }));
    const { result } = renderHook(() => useHomeApprovalMode(read));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await waitFor(() => expect(result.current.mode).toBeNull());
    expect(result.current.createMode).toBeUndefined();
  });
});

describe("useSessionApprovals", () => {
  const ACCEPTED = { kind: "acknowledged" } as const;

  function issuing() {
    const sent: unknown[] = [];
    const issueAction = vi.fn(async (_action: string, build: (commandId: string) => unknown) => {
      sent.push(build("cmd_1"));
      return ACCEPTED;
    });
    return { sent, issueAction };
  }

  it("sends the menu's choice as approval.mode, saves the workspace's half, and answers a card", async () => {
    const { sent, issueAction } = issuing();
    const save = vi.fn(async () => READ_ALWAYS);
    const view = foldEvents([started, asked()]);
    const { result } = renderHook(() =>
      useSessionApprovals(view, view.run, issueAction as never, async () => READ_ASK, save),
    );
    await waitFor(() => expect(result.current.mode).toBe("ask"));
    expect(result.current.open?.approvalId).toBe("apr_p");
    act(() => result.current.changeMode("always"));
    await waitFor(() => expect(result.current.mode).toBe("always"));
    expect(save).toHaveBeenCalledWith("always");
    expect(sent[0]).toMatchObject({
      type: "approval.mode",
      runId: null,
      expected: { scope: "session", state: "active" },
      payload: { mode: "always" },
    });
    expect(
      await result.current.answer({ approvalId: "apr_p", decision: "approved", scope: "once" }),
    ).toEqual(ACCEPTED);
    expect(sent[1]).toMatchObject({
      type: "approval.resolve",
      expected: { scope: "run", state: "waiting_for_approval" },
      payload: { approvalId: "apr_p", decision: "approved", scope: "once" },
    });
    await result.current.answer({ approvalId: "apr_p", decision: "rejected" });
    expect(sent[2]).toMatchObject({ payload: { approvalId: "apr_p", decision: "rejected" } });
    expect(issueAction.mock.calls.map((call) => call[0])).toEqual([
      "approval-mode:always",
      "permission:apr_p:approved:once",
      "permission:apr_p:rejected:",
    ]);
  });

  it("saves ask for any other choice, and answers nothing without a run", async () => {
    const { issueAction } = issuing();
    const save = vi.fn(async () => READ_ASK);
    const { result } = renderHook(() =>
      useSessionApprovals(foldEvents([]), null, issueAction as never, async () => READ_ASK, save),
    );
    act(() => result.current.changeMode("session"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("ask"));
    expect(await result.current.answer({ approvalId: "apr_p", decision: "rejected" })).toEqual({
      kind: "not_sent",
    });
  });

  it("sets the matching mode after a card's wider allow is accepted", async () => {
    const { sent, issueAction } = issuing();
    const save = vi.fn(async () => READ_ALWAYS);
    const view = foldEvents([started, asked()]);
    const { result } = renderHook(() =>
      useSessionApprovals(view, view.run, issueAction as never, async () => READ_ASK, save),
    );
    await waitFor(() => expect(result.current.mode).toBe("ask"));

    await act(() =>
      result.current.answer({ approvalId: "apr_p", decision: "approved", scope: "session" }),
    );
    expect(sent[0]).toMatchObject({ payload: { decision: "approved", scope: "session" } });
    expect(sent[1]).toMatchObject({ type: "approval.mode", payload: { mode: "session" } });

    await act(() =>
      result.current.answer({ approvalId: "apr_p", decision: "approved", scope: "always" }),
    );
    expect(sent[2]).toMatchObject({ payload: { decision: "approved", scope: "always" } });
    expect(sent[3]).toMatchObject({ type: "approval.mode", payload: { mode: "always" } });
    await waitFor(() => expect(save).toHaveBeenLastCalledWith("always"));
  });

  it("changes no mode when the wider allow was not accepted", async () => {
    const sent: unknown[] = [];
    const issueAction = vi.fn(async (_action: string, build: (commandId: string) => unknown) => {
      sent.push(build("cmd_1"));
      return { kind: "unanswered" } as const;
    });
    const view = foldEvents([started, asked()]);
    const { result } = renderHook(() =>
      useSessionApprovals(view, view.run, issueAction as never, async () => READ_ASK),
    );
    await act(() =>
      result.current.answer({ approvalId: "apr_p", decision: "approved", scope: "session" }),
    );
    expect(sent).toHaveLength(1);
  });

  it("says not sent when the screen could not build the answer", async () => {
    const issueAction = vi.fn(async () => null);
    const view = foldEvents([started, asked()]);
    const { result } = renderHook(() =>
      useSessionApprovals(view, view.run, issueAction, async () => READ_ASK),
    );
    expect(await result.current.answer({ approvalId: "apr_p", decision: "rejected" })).toEqual({
      kind: "not_sent",
    });
  });
});
