import {
  type CommittedEvent,
  foldEvents,
  type RunId,
  type RunOutcome,
  type TimelineItem,
} from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN, reviewFixtureEvents, SECOND_RUN } from "@/features/diff/review-fixture";
import { STATUS_LABELS } from "@/features/session/status";
import { TimelineRow } from "@/features/session/Timeline";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { FAILURE_STAGE_WORDS, OUTCOME_TONE, RunOutcomeRow, requiredEvidenceLine } from "./outcomes";

afterEach(cleanup);

function runItem(runId: string, transition: string): TimelineItem {
  return { sequence: 99, kind: "run", runId, transition } as unknown as TimelineItem;
}

/** A run that started and then ended with `type`, with the payload overrides given. */
function endedView(
  type: "run.failed" | "run.blocked" | "run.cancelled" | "run.completed",
  payload: Record<string, unknown> = {},
) {
  const events: CommittedEvent[] = [
    makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
    makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
    makeCommittedEvent(type, { payload } as never, { sessionSequence: 3 }) as CommittedEvent,
  ];
  return foldEvents(events);
}

describe("outcome renderers", () => {
  it("renders verified with its label, tone, and the required checks it passed", () => {
    const view = foldEvents(reviewFixtureEvents());
    render(<TimelineRow view={view} item={runItem(FIRST_RUN, "verified")} />);
    const row = screen.getByTestId("row-run");
    expect(row.getAttribute("data-outcome")).toBe("verified");
    const label = screen.getByText("Verified");
    // Plain text, and no icon: only a bad ending is coloured.
    expect(label.className).not.toContain(TONE_TEXT_CLASS.positive);
    expect(label.className).toContain("text-text");
    expect(row.querySelector("svg")).toBeNull();
    // The recommended lint check is not in the line; only required checks are.
    expect(screen.getByTestId("outcome-evidence").textContent).toBe(
      "· test passed, typecheck passed",
    );
    expect(row.textContent).not.toContain("Run verified");
  });

  it("lists the warnings for completed_with_warnings and names the skipped check", () => {
    const view = foldEvents(reviewFixtureEvents());
    render(<TimelineRow view={view} item={runItem(SECOND_RUN, "completed_with_warnings")} />);
    expect(screen.getByText("Completed with warnings").className).toContain(
      TONE_TEXT_CLASS.caution,
    );
    expect(screen.getByTestId("outcome-warnings").textContent).toContain(
      "typecheck was skipped at your request. Run it before merging.",
    );
    expect(screen.getByTestId("outcome-evidence").textContent).toBe(
      "· test passed, typecheck skipped",
    );
  });

  it("names the stage a failed run failed at", () => {
    const view = endedView("run.failed", {
      stage: "verification",
      error: { category: "check_failed", message: "test failed on a new failure" },
    });
    render(<TimelineRow view={view} item={runItem("run_1", "failed")} />);
    expect(screen.getByText("Failed").className).toContain(TONE_TEXT_CLASS.danger);
    expect(screen.getByTestId("outcome-failure-stage").textContent).toBe(
      "Failed during verification: test failed on a new failure",
    );
    expect(screen.queryByTestId("outcome-evidence")).toBeNull();
  });

  it("says what a blocked run waits on, for each kind", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "question", question: "Which branch?" }, "Waiting on: Which branch?"],
      [{ kind: "decision", question: "Keep the API?" }, "Waiting on: Keep the API?"],
      [
        { kind: "access", resource: "the staging database" },
        "Waiting on access: the staging database",
      ],
      [
        {
          kind: "model_failure",
          failure: {
            category: "rate_limited",
            message: "Slow down.",
            retries: 2,
          },
        },
        "Waiting on the model: Slow down.",
      ],
    ];
    for (const [blockedOn, text] of cases) {
      const view = endedView("run.blocked", { blockedOn });
      render(<TimelineRow view={view} item={runItem("run_1", "blocked")} />);
      expect(screen.getByTestId("outcome-blocked-on").textContent).toBe(text);
      cleanup();
    }
  });

  it("renders Done in plain text and says no files changed, so no checks ran (record 14)", () => {
    const view = endedView("run.completed");
    render(<TimelineRow view={view} item={runItem("run_1", "completed")} />);
    expect(screen.getByText("Done").className).toContain("text-text");
    expect(screen.getByTestId("outcome-no-changes").textContent).toBe(
      "No files changed, so no checks ran.",
    );
    expect(screen.queryByTestId("outcome-evidence")).toBeNull();
  });

  it("renders cancelled in a neutral tone with nothing beneath", () => {
    const view = endedView("run.cancelled");
    render(<TimelineRow view={view} item={runItem("run_1", "cancelled")} />);
    expect(screen.getByText("Cancelled").className).toContain("text-text");
    expect(screen.getByTestId("row-run").textContent).toBe("Cancelled");
  });

  it("shows not finished, not running, in the evidence line for a check its cancelled run left unfinished", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
      makeCommittedEvent("run.cancelled", {}, { sessionSequence: 4 }),
    ]);
    render(<TimelineRow view={view} item={runItem("run_1", "cancelled")} />);
    expect(screen.getByTestId("outcome-evidence").textContent).toBe("· unit tests not finished");
    cleanup();

    const active = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
    ]);
    expect(requiredEvidenceLine(active, "run_1" as RunId)).toBe("unit tests running");
  });

  it("keeps every other run transition as it was", () => {
    render(<TimelineRow view={foldEvents([])} item={runItem("run_1", "started")} />);
    expect(screen.getByTestId("row-run").textContent).toBe("Run started");
  });

  it("has a label and a tone for all six outcomes, and words for every failure stage", () => {
    const outcomes: RunOutcome[] = [
      "verified",
      "completed_with_warnings",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ];
    for (const outcome of outcomes) {
      expect(STATUS_LABELS[outcome].length).toBeGreaterThan(0);
      expect(TONE_TEXT_CLASS[OUTCOME_TONE[outcome]]).toBeTruthy();
    }
    expect(Object.keys(FAILURE_STAGE_WORDS)).toHaveLength(6);
  });

  it("opens the Tests view on the run from its evidence line", () => {
    const view = foldEvents(reviewFixtureEvents());
    const onReview = vi.fn();
    render(<TimelineRow view={view} item={runItem(FIRST_RUN, "verified")} onReview={onReview} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open the checks for this run: test passed, typecheck passed",
      }),
    );
    expect(onReview).toHaveBeenCalledWith({ tab: "tests", scope: "turn", runId: FIRST_RUN });
  });

  it("renders the label alone when the view has no ending for the run", () => {
    render(<RunOutcomeRow view={foldEvents([])} runId={"run_9" as RunId} outcome="failed" />);
    expect(screen.getByTestId("row-run").textContent).toBe("Failed");
  });

  it("builds no evidence line for a run without required checks", () => {
    expect(requiredEvidenceLine(foldEvents([]), "run_1" as RunId)).toBeNull();
  });
});
