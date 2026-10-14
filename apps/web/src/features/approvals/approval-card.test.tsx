import { foldEvents, type SessionView } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextRail } from "@/features/session/ContextRail";
import { TimelineRow } from "@/features/session/Timeline";
import type { AnswerHandler, CommandOutcome } from "@/features/session/use-commands";
import type { ApprovalAnswer } from "./ApprovalCard";

afterEach(cleanup);

const EXPIRES_AT = "2026-09-21T12:10:00.000Z";

const started = makeCommittedEvent("run.started", { eventId: "evt_a_1" }, { sessionSequence: 1 });

const requested = (sessionSequence = 2, approvalId = "apr_1") =>
  makeCommittedEvent(
    "approval.requested",
    {
      eventId: `evt_a_${sessionSequence}`,
      payload: {
        approvalId,
        title: "Supply STRIPE_TEST_KEY",
        intendedAction:
          "Give this session the saved development secret STRIPE_TEST_KEY. The repository's code can read it, and the model provider may see it.",
        category: "development_secret",
        risk: "medium",
        resource: "STRIPE_TEST_KEY",
        requestedScope: "This session's sandbox (generation 1), until it stops",
        expiresAt: EXPIRES_AT,
        toolCallId: null,
      },
    },
    { sessionSequence },
  );

const resolved = (decision: "approved" | "rejected") =>
  makeCommittedEvent(
    "approval.resolved",
    { eventId: "evt_a_3", payload: { approvalId: "apr_1", decision } },
    { sessionSequence: 3 },
  );

const expired = (effect: "tool_denied" | "run_paused") =>
  makeCommittedEvent(
    "approval.expired",
    { eventId: "evt_a_3", payload: { approvalId: "apr_1", effect } },
    { sessionSequence: 3 },
  );

const ACCEPTED: CommandOutcome = { kind: "acknowledged" };

function timeline(
  view: SessionView,
  onApprovalAnswer: AnswerHandler<ApprovalAnswer> = vi.fn<AnswerHandler<ApprovalAnswer>>(
    () => ACCEPTED,
  ),
) {
  render(
    <div>
      {view.timeline.map((item) => (
        <TimelineRow
          key={item.sequence}
          view={view}
          item={item}
          onApprovalAnswer={onApprovalAnswer}
        />
      ))}
    </div>,
  );
  return onApprovalAnswer;
}

describe("the approval card", () => {
  it("names the exact action, target, scope, and expiry, in the control plane's words", () => {
    timeline(foldEvents([started, requested()]));

    const card = screen.getByTestId("approval-card");
    expect(within(card).getByText("Supply STRIPE_TEST_KEY")).toBeTruthy();
    expect(within(card).getByText(/the model provider may see it/)).toBeTruthy();
    expect(within(card).getByTestId("approval-target").textContent).toBe("STRIPE_TEST_KEY");
    expect(within(card).getByTestId("approval-scope").textContent).toBe(
      "This session's sandbox (generation 1), until it stops",
    );
    expect(within(card).getByTestId("approval-expiry").getAttribute("datetime")).toBe(EXPIRES_AT);
    expect(within(card).getByText(/Nothing is supplied unless you approve/)).toBeTruthy();
  });

  it("sends a denial as rejected, and only once", () => {
    const onAnswer = timeline(foldEvents([started, requested()]));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ approvalId: "apr_1", decision: "rejected" });
  });

  it("lets a click that could not leave be repeated, and says it did not leave", async () => {
    const onAnswer = timeline(
      foldEvents([started, requested()]),
      vi.fn<AnswerHandler<ApprovalAnswer>>(() => ({ kind: "not_sent" })),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });
    expect(screen.getByTestId("approval-problem").textContent).toContain("Not sent");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("frees the buttons and says why when the session refuses the decision", async () => {
    timeline(
      foldEvents([started, requested()]),
      vi.fn<AnswerHandler<ApprovalAnswer>>(async () => ({
        kind: "rejected",
        reason: "wrong_state",
        detail: "the approval has expired",
      })),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });

    expect(screen.getByTestId("approval-problem").textContent).toBe(
      "Not accepted: the approval has expired.",
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Deny" }).disabled).toBe(false);
  });

  it("keeps both buttons off while the decision is out", async () => {
    let answer: (outcome: CommandOutcome) => void = () => {};
    const onAnswer = timeline(
      foldEvents([started, requested()]),
      vi.fn<AnswerHandler<ApprovalAnswer>>(
        () =>
          new Promise<CommandOutcome>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // A second press in the same frame, before the disabled state has drawn.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await act(async () => {});
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Deny" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await act(async () => {
      answer({ kind: "unanswered" });
    });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("approval-problem").textContent).toContain("didn't answer");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Deny" }).disabled).toBe(false);
  });

  it("sends the approval's id and the decision, and nothing else, on one click", () => {
    const onAnswer = timeline(foldEvents([started, requested()]));

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // One click is the decision: a second, on either button, sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ approvalId: "apr_1", decision: "approved" });
  });

  it("ties each button to the card's title for a screen reader", () => {
    timeline(foldEvents([started, requested()]));
    const title = screen.getByText("Supply STRIPE_TEST_KEY");
    for (const name of ["Approve", "Deny"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-describedby")).toBe(title.id);
    }
  });

  it("has no buttons on a read-only surface", () => {
    const view = foldEvents([started, requested()]);
    render(
      <div>
        {view.timeline.map((item) => (
          <TimelineRow key={item.sequence} view={view} item={item} />
        ))}
      </div>,
    );
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("renders the payload's strings as text, never as markup", () => {
    const hostile = makeCommittedEvent(
      "approval.requested",
      {
        eventId: "evt_a_2",
        payload: { approvalId: "apr_1", title: "<img src=x onerror=alert(1)>", toolCallId: null },
      },
      { sessionSequence: 2 },
    );
    timeline(foldEvents([started, hostile]));
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("an approval that is over", () => {
  it.each([
    [[resolved("approved")], "row-approval-approved", "You approved STRIPE_TEST_KEY"],
    [[resolved("rejected")], "row-approval-denied", "You denied STRIPE_TEST_KEY"],
    [[expired("tool_denied")], "row-approval-expired", "The request for STRIPE_TEST_KEY expired"],
    [
      [expired("run_paused")],
      "row-approval-expired",
      "The request for STRIPE_TEST_KEY ended with the sandbox",
    ],
  ] as const)("is a plain line with no buttons", (after, testId, title) => {
    timeline(foldEvents([started, requested(), ...after]));

    expect(screen.queryByTestId("approval-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(screen.getByTestId(testId)).getByText(title)).toBeTruthy();
    // The request itself stays in the log, as what was asked.
    expect(screen.getByTestId("row-approval-asked")).toBeTruthy();
  });

  it("says nothing was supplied after a denial or an expiry", () => {
    timeline(foldEvents([started, requested(), resolved("rejected")]));
    expect(screen.getByText("The run continued without it.")).toBeTruthy();
  });
});

describe("the rail's notice", () => {
  it("takes the reader to the open card", () => {
    const view = foldEvents([started, requested()]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(
      <div>
        <ContextRail view={view} />
        {view.timeline.map((item) => (
          <TimelineRow key={item.sequence} view={view} item={item} />
        ))}
      </div>,
    );

    fireEvent.click(screen.getByTestId("needs-you-approval"));

    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId("approval-card"));
  });

  it("does nothing when the card is not on the page", () => {
    const view = foldEvents([started, requested()]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<ContextRail view={view} />);
    fireEvent.click(screen.getByTestId("needs-you-approval"));
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe("what a launch disclosed", () => {
  const disclosed = (payload: Record<string, unknown>) =>
    makeCommittedEvent(
      "secrets.disclosed",
      { eventId: "evt_disclosed", payload },
      { sessionSequence: 1 },
    );

  it("names what was supplied and what was withheld, and never a value", () => {
    timeline(
      foldEvents([
        disclosed({
          supplied: ["DATABASE_URL"],
          withheld: ["STRIPE_TEST_KEY"],
          missing: [],
          invalid: false,
        }),
      ]),
    );
    const row = screen.getByTestId("row-secrets-disclosed");
    expect(within(row).getByText("Starting with DATABASE_URL")).toBeTruthy();
    expect(within(row).getByText(/Not supplied: STRIPE_TEST_KEY/)).toBeTruthy();
    expect(within(row).queryByText(/Started without/)).toBeNull();
  });

  it("says plainly when the session started without a required secret", () => {
    timeline(
      foldEvents([
        disclosed({ supplied: [], withheld: [], missing: ["DATABASE_URL"], invalid: false }),
      ]),
    );
    const row = screen.getByTestId("row-secrets-disclosed");
    expect(within(row).getByText("Started without DATABASE_URL")).toBeTruthy();
    expect(within(row).getByText(/cannot end verified/)).toBeTruthy();
  });

  it("says no secrets were selected when every name was left out", () => {
    timeline(
      foldEvents([
        disclosed({ supplied: [], withheld: ["STRIPE_TEST_KEY"], missing: [], invalid: false }),
      ]),
    );
    expect(screen.getByText("Starting with no secrets")).toBeTruthy();
  });

  it("says the project file could not be read, and why that matters", () => {
    timeline(foldEvents([disclosed({ supplied: [], withheld: [], missing: [], invalid: true })]));
    const row = screen.getByTestId("row-secrets-disclosed");
    expect(within(row).getByText(/could not be read/)).toBeTruthy();
    expect(within(row).getByText(/cannot end verified/)).toBeTruthy();
  });
});

describe("approved and supplied are different facts", () => {
  const supplied = (payload: Record<string, unknown>, sessionSequence = 9) =>
    makeCommittedEvent(
      "secrets.supplied",
      { eventId: `evt_supplied_${sessionSequence}`, payload },
      { sessionSequence },
    );

  it("says an approved secret is not delivered until the sandbox answers", () => {
    timeline(foldEvents([started, requested(), resolved("approved")]));
    const row = screen.getByTestId("row-approval-approved");
    expect(within(row).getByText("Approved, not delivered yet.")).toBeTruthy();
    expect(within(row).queryByText(/Supplied/)).toBeNull();
  });

  it("says supplied once the sandbox wrote it", () => {
    timeline(
      foldEvents([
        started,
        requested(),
        resolved("approved"),
        supplied({ names: ["STRIPE_TEST_KEY"], approvalId: "apr_1", delivered: true }, 4),
      ]),
    );
    const row = screen.getByTestId("row-approval-approved");
    expect(within(row).getByText("Supplied to this sandbox.")).toBeTruthy();
  });

  it("says approved, not delivered, when the value never got there", () => {
    timeline(
      foldEvents([
        started,
        requested(),
        resolved("approved"),
        supplied({ names: ["STRIPE_TEST_KEY"], approvalId: "apr_1", delivered: false }, 4),
      ]),
    );
    const row = screen.getByTestId("row-approval-approved");
    expect(within(row).getByText(/Approved, not delivered\./)).toBeTruthy();
    expect(within(row).getByText(/Save it again/)).toBeTruthy();
  });

  it("gives a launch's delivery its own row, either way", () => {
    timeline(
      foldEvents([
        supplied({ names: ["DATABASE_URL"], approvalId: null, delivered: true }, 1),
        supplied({ names: ["REDIS_URL"], approvalId: null, delivered: false }, 2),
      ]),
    );
    expect(screen.getByText("Supplied DATABASE_URL")).toBeTruthy();
    const failed = screen.getByTestId("row-secrets-not-supplied");
    expect(within(failed).getByText("Could not supply REDIS_URL")).toBeTruthy();
    expect(within(failed).getByText(/cannot end verified/)).toBeTruthy();
  });
});
