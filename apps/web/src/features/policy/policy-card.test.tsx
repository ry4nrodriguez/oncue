import { foldEvents, type SessionView } from "@oncue/protocol";
import { makeCommittedEvent, testSessionPolicy } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextRail } from "@/features/session/ContextRail";
import { PullRequestPane } from "@/features/session/PullRequestPane";
import { TimelineRow } from "@/features/session/Timeline";
import type { AnswerHandler, CommandOutcome } from "@/features/session/use-commands";
import type { PolicyAnswer } from "./PolicyCard";
import { behaviorSummary, changeLines, DEFAULT_POLICY, updateTitle } from "./policy-words";

afterEach(cleanup);

const stored = testSessionPolicy();
const pushing = testSessionPolicy({
  version: 2,
  push: "auto",
  pullRequest: "auto_after_verification",
});

const proposed = (sessionSequence: number, proposalId = "prop_1") =>
  makeCommittedEvent(
    "policy.proposed",
    {
      eventId: `evt_policy_${sessionSequence}`,
      payload: {
        proposalId,
        triggeringMessageId: null,
        from: stored,
        to: pushing,
        direction: "widening",
        rationale: "The user asked to push and open a draft PR.",
      },
    },
    { sessionSequence },
  );

const updated = (sessionSequence: number, confirmedBy: string, from = stored, to = pushing) =>
  makeCommittedEvent(
    "policy.updated",
    {
      eventId: `evt_policy_${sessionSequence}`,
      payload: {
        proposalId: confirmedBy === "user_confirmation" ? "prop_1" : null,
        from,
        to,
        confirmedBy: confirmedBy as "system",
        userId: null,
        effectiveAt: "2026-09-20T00:00:00.000Z",
      },
    },
    { sessionSequence },
  );

/** Each row on its own, as `change-card.test.tsx` does: the scrolling `Timeline` needs a ResizeObserver jsdom has none of. */
const ACCEPTED: CommandOutcome = { kind: "acknowledged" };

function timeline(
  view: SessionView,
  onPolicyAnswer: AnswerHandler<PolicyAnswer> = vi.fn<AnswerHandler<PolicyAnswer>>(() => ACCEPTED),
) {
  render(
    <div>
      {view.timeline.map((item) => (
        <TimelineRow key={item.sequence} view={view} item={item} onPolicyAnswer={onPolicyAnswer} />
      ))}
    </div>,
  );
  return onPolicyAnswer;
}

describe("policy words", () => {
  it("names every field that moves, from and to, and nothing that does not", () => {
    expect(changeLines(stored, pushing)).toEqual([
      { field: "push", label: "Push", from: "off", to: "after each run" },
      {
        field: "pullRequest",
        label: "Draft pull request",
        from: "off",
        to: "after each push",
      },
    ]);
    expect(changeLines(stored, { ...stored, commit: "manual", push: "never" })).toEqual([
      { field: "commit", label: "Commit", from: "on", to: "only when asked" },
      { field: "push", label: "Push", from: "off", to: "never, checkpoints included" },
    ]);
    expect(changeLines(stored, { ...stored, version: 9 })).toEqual([]);
  });

  it("summarises what the session does with its work", () => {
    expect(behaviorSummary(DEFAULT_POLICY)).toBe("Commits · Does not push");
    expect(behaviorSummary(pushing)).toBe("Commits · Pushes · Draft pull request");
    expect(behaviorSummary({ ...pushing, pullRequest: "manual" })).toBe("Commits · Pushes");
    expect(behaviorSummary({ ...stored, commit: "manual", push: "never" })).toBe(
      "Commits when asked · Never pushes",
    );
  });

  it("says who made a change", () => {
    expect(updateTitle("system")).toContain("outside this session's branch");
    expect(updateTitle("immediate_narrowing")).toContain("as you asked");
  });
});

describe("the confirmation card", () => {
  it("sends one answer for a double click, on either button", async () => {
    const onAnswer = timeline(foldEvents([proposed(1)]));
    const card = screen.getByTestId("policy-card");

    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
    await act(async () => {});

    expect(onAnswer).toHaveBeenCalledTimes(1);
    // Accepted: both stay off until the view moves past the proposal.
    expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Allow" }).disabled).toBe(
      true,
    );
  });

  it("frees the buttons and says why when an answer is refused or does not leave", async () => {
    const onAnswer = timeline(
      foldEvents([proposed(1)]),
      vi
        .fn<AnswerHandler<PolicyAnswer>>()
        .mockResolvedValueOnce({
          kind: "rejected",
          reason: "wrong_state",
          detail: "the proposal is no longer open",
        })
        .mockReturnValueOnce({ kind: "not_sent" }),
    );
    const card = screen.getByTestId("policy-card");

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    });
    expect(within(card).getByTestId("policy-problem").textContent).toBe(
      "Not accepted: the proposal is no longer open.",
    );
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
    });
    expect(within(card).getByTestId("policy-problem").textContent).toContain("Not sent");
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("asks the exact change in one line and allows it with the proposal and the version it was drawn from", () => {
    const onAnswer = timeline(foldEvents([proposed(1)]));
    const card = screen.getByTestId("policy-card");
    // One line naming every field that moves with its new value (records 09 and 13).
    expect(
      within(card).getByText("Allow pushes after each run and a draft PR after each push?"),
    ).toBeTruthy();
    expect(within(card).queryAllByTestId("policy-change-line")).toEqual([]);
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Decline", "Allow"]);

    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      action: "confirm",
      proposalId: "prop_1",
      policyVersion: 1,
    });
  });

  it("sends the chosen branch name with Allow while the session has none, and asks for none itself", () => {
    const answers = (branch: { taskBranch: string | null; suggested: string }) => {
      const onAnswer = vi.fn<AnswerHandler<PolicyAnswer>>(() => ACCEPTED);
      const view = foldEvents([proposed(1)]);
      render(
        <div>
          {view.timeline.map((item) => (
            <TimelineRow
              key={item.sequence}
              view={view}
              item={item}
              onPolicyAnswer={onAnswer}
              branch={branch}
            />
          ))}
        </div>,
      );
      expect(screen.queryByTestId("branch-name-input")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      cleanup();
      return onAnswer.mock.calls[0]?.[0];
    };
    // The name comes from the Pull request tab (or the suggestion), never from the banner.
    expect(answers({ taskBranch: null, suggested: "oncue/add-health-endpoint-7f3a" })).toEqual({
      action: "confirm",
      proposalId: "prop_1",
      policyVersion: 1,
      branchName: "oncue/add-health-endpoint-7f3a",
    });
    expect(
      answers({ taskBranch: "oncue/fix-it-1a2b", suggested: "oncue/whatever-0000" }),
    ).not.toHaveProperty("branchName");
    // A name git would refuse is not sent; the object names the branch itself then.
    expect(answers({ taskBranch: null, suggested: "oncue/" })).not.toHaveProperty("branchName");
  });

  it("the rail's push control sends the chosen name when the session has none, and nothing once it has one", () => {
    const onSetPolicy = vi.fn();
    const view = foldEvents([]);
    render(
      <ContextRail
        view={view}
        taskBranch={null}
        suggestedBranch="oncue/add-health-endpoint-7f3a"
        onSetPolicy={onSetPolicy}
      />,
    );
    expect(screen.queryByTestId("rail-branch-form")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-policy-switch"));
    expect(onSetPolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ push: "auto", branchName: "oncue/add-health-endpoint-7f3a" }),
    );
    cleanup();

    // With a branch already, the click sets the policy at once, naming nothing.
    const onSetPolicyNamed = vi.fn();
    render(
      <ContextRail view={view} taskBranch="oncue/fix-it-1a2b" onSetPolicy={onSetPolicyNamed} />,
    );
    fireEvent.click(screen.getByTestId("rail-policy-switch"));
    expect(onSetPolicyNamed).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ branchName: expect.anything() }),
    );
  });

  it("declines by proposal id", () => {
    const onAnswer = timeline(foldEvents([proposed(1)]));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ action: "decline", proposalId: "prop_1" });
  });

  it("draws the version from the policy in force, not the default, once one exists", () => {
    const onAnswer = timeline(
      foldEvents([updated(1, "product_control", stored, { ...stored, version: 2 }), proposed(2)]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ policyVersion: 2 }));
  });

  it("has no buttons where no command can be sent", () => {
    render(
      <div>
        {foldEvents([proposed(1)]).timeline.map((item) => (
          <TimelineRow key={item.sequence} view={foldEvents([proposed(1)])} item={item} />
        ))}
      </div>,
    );
    expect(screen.getByTestId("policy-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("becomes a plain line once confirmed, and the update says who confirmed it", () => {
    timeline(foldEvents([proposed(1), updated(2, "user_confirmation")]));
    expect(screen.queryByTestId("policy-card")).toBeNull();
    expect(screen.getByTestId("row-policy-proposed")).toBeTruthy();
    const row = screen.getByTestId("row-policy-updated");
    expect(within(row).getByText("You confirmed a Git behavior change")).toBeTruthy();
    expect(within(row).getAllByTestId("policy-change-line")).toHaveLength(2);
  });

  it("only the newest proposal is a card; the one it replaced is a line", () => {
    timeline(foldEvents([proposed(1, "prop_old"), proposed(2, "prop_1")]));
    expect(screen.getAllByTestId("policy-card")).toHaveLength(1);
    expect(screen.getAllByTestId("row-policy-proposed")).toHaveLength(1);
  });

  it("shows a decline, and the incident rule's lock-down in its own words", () => {
    timeline(
      foldEvents([
        proposed(1),
        makeCommittedEvent(
          "policy.declined",
          {
            eventId: "evt_policy_declined",
            payload: {
              proposalId: "prop_1",
              userId: "user_1",
              declinedAt: "2026-09-20T00:00:00.000Z",
            },
          },
          { sessionSequence: 2 },
        ),
        updated(3, "system", stored, {
          ...stored,
          version: 2,
          push: "never",
          pullRequest: "never",
        }),
      ]),
    );
    expect(screen.queryByTestId("policy-card")).toBeNull();
    expect(screen.getByTestId("row-policy-declined")).toBeTruthy();
    expect(
      screen.getByText("OnCue turned pushing off after a push outside this session's branch"),
    ).toBeTruthy();
  });
});

describe("the rail's pull request row", () => {
  const created = (url: string) =>
    makeCommittedEvent(
      "pull_request.created",
      {
        payload: {
          number: 7,
          url,
          title: "Add a README section",
          draft: true,
          baseBranch: "main",
          headBranch: "oncue/readme-1a2b",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          verificationSectionVersion: 1,
        },
      },
      { sessionSequence: 1 },
    );

  it("the rail names the pull request and opens the tab; the tab links to GitHub over https, and only over https", () => {
    const onOpenPullRequest = vi.fn();
    const view = foldEvents([created("https://github.com/acme/widgets/pull/7")]);
    render(<ContextRail view={view} onOpenPullRequest={onOpenPullRequest} />);
    expect(screen.getByTestId("rail-pull-request").textContent).toBe("#7 · draft");
    fireEvent.click(screen.getByTestId("rail-pull-request-open"));
    expect(onOpenPullRequest).toHaveBeenCalledOnce();
    cleanup();

    const branch = { named: "oncue/fix-it-7f3a", slug: "fix-it-7f3a", onSlugChange: vi.fn() };
    render(<PullRequestPane view={view} branch={branch} />);
    const link = screen.getByTestId("pull-request-link");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/7");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    expect(screen.getByTestId("panel-branch-name").textContent).toBe("oncue/fix-it-7f3a");
    cleanup();

    // A payload that carries anything but https is named, never followed.
    for (const url of ["javascript:alert(1)", "http://github.com/acme/widgets/pull/7", "nope"]) {
      render(<PullRequestPane view={foldEvents([created(url)])} branch={branch} />);
      expect(screen.queryByTestId("pull-request-link")).toBeNull();
      expect(screen.getByTestId("panel-pull-request").textContent).toContain("#7 · draft");
      cleanup();
    }
  });

  it("the tab names the branch until a push has, from the suggestion, and sends what is typed", () => {
    const onSlugChange = vi.fn();
    render(
      <PullRequestPane
        view={foldEvents([])}
        branch={{ named: null, slug: "add-health-endpoint-7f3a", onSlugChange }}
      />,
    );
    const input = screen.getByTestId("branch-name-input") as HTMLInputElement;
    expect(input.value).toBe("add-health-endpoint-7f3a");
    fireEvent.change(input, { target: { value: "health-endpoint" } });
    expect(onSlugChange).toHaveBeenCalledWith("health-endpoint");
    expect(screen.getByTestId("panel-pull-request").textContent).toContain("None yet");
  });
});

describe("the rail's Git behavior", () => {
  it("reads the default before any policy event, and the switch turns publishing on from that version", () => {
    const onSetPolicy = vi.fn();
    // With a branch already named, the switch acts at once; without one it asks for the name first.
    render(
      <ContextRail
        view={foldEvents([])}
        taskBranch="oncue/fix-it-7f3a"
        onSetPolicy={onSetPolicy}
      />,
    );
    expect(screen.getByTestId("rail-git-behavior").textContent).toBe("Commits · Does not push");
    const control = screen.getByTestId("rail-policy-switch");
    expect(control.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(control);
    expect(onSetPolicy).toHaveBeenCalledExactlyOnceWith({
      policyVersion: 1,
      commit: "auto",
      push: "auto",
      pullRequest: "auto_after_verification",
    });
  });

  it("turns it off again, and has no switch where no command can be sent", () => {
    const onSetPolicy = vi.fn();
    const view = foldEvents([updated(1, "user_confirmation")]);
    const { unmount } = render(<ContextRail view={view} onSetPolicy={onSetPolicy} />);
    expect(screen.getByTestId("rail-git-behavior").textContent).toBe(
      "Commits · Pushes · Draft pull request",
    );
    fireEvent.click(screen.getByText("Stop pushing"));
    expect(onSetPolicy).toHaveBeenCalledWith({
      policyVersion: 2,
      commit: "auto",
      push: "manual",
      pullRequest: "manual",
    });
    unmount();
    render(<ContextRail view={view} />);
    expect(screen.queryByTestId("rail-policy-switch")).toBeNull();
  });
});
