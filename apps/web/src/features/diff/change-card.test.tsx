import type { DiffView } from "@oncue/protocol";
import { foldEvents, type RunId, type TimelineItem } from "@oncue/protocol";
import { makeCommittedEvent, testFileChange } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineRow } from "@/features/session/Timeline";
import { ChangeCard, VISIBLE_FILES } from "./ChangeCard";
import { FIRST_RUN, FIRST_TURN_FILES, reviewFixtureEvents } from "./review-fixture";

afterEach(cleanup);

function firstTurnDiff(): DiffView {
  const view = foldEvents(reviewFixtureEvents());
  return view.git.turnDiffs.get(FIRST_RUN as RunId) as DiffView;
}

describe("ChangeCard", () => {
  it("says how many files the turn edited with its totals, and shows three rows", () => {
    render(<ChangeCard runId={FIRST_RUN as RunId} diff={firstTurnDiff()} />);
    const card = screen.getByTestId("row-changes");
    expect(within(card).getByText("Edited 5 files")).toBeTruthy();
    expect(within(card).getByText("+10")).toBeTruthy();
    expect(within(card).getByText("-5")).toBeTruthy();
    const rows = screen.getAllByTestId("change-card-file");
    expect(rows).toHaveLength(VISIBLE_FILES);
    // The directory is dimmed, and the name follows it at normal weight.
    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain("app/page.tsx");
    expect(within(first).getByText("app/").className).toContain("text-muted-foreground");
    expect(within(first).getByText("page.tsx").className).toContain("text-text");
    expect(within(first).getByText("+4").className).toContain("text-positive");
    expect(within(first).getByText("-2").className).toContain("text-danger");
    // Both counts show on every row, zeros included.
    expect(within(rows[1] as HTMLElement).getByText("+4").className).toContain("text-positive");
    expect(within(rows[1] as HTMLElement).getByText("-0").className).toContain("text-danger");
    expect(within(rows[2] as HTMLElement).getByText("+0")).toBeTruthy();
    // No undo, commit, or push control.
    expect(screen.queryByRole("button", { name: /undo|commit|push/i })).toBeNull();
  });

  it("expands the rest behind Show N more files, and collapses back", () => {
    render(<ChangeCard runId={FIRST_RUN as RunId} diff={firstTurnDiff()} />);
    const more = screen.getByRole("button", { name: "Show 2 more files" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getAllByTestId("change-card-file")).toHaveLength(FIRST_TURN_FILES.length);
    const fewer = screen.getByRole("button", { name: "Show fewer files" });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fewer);
    expect(screen.getAllByTestId("change-card-file")).toHaveLength(VISIBLE_FILES);
  });

  it("offers no expander at three files or fewer, and says 1 file and 1 more file", () => {
    const base = firstTurnDiff();
    const { unmount } = render(
      <ChangeCard runId={FIRST_RUN as RunId} diff={{ ...base, files: base.files.slice(0, 1) }} />,
    );
    expect(screen.getByText("Edited 1 file")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more file/ })).toBeNull();
    unmount();

    render(
      <ChangeCard runId={FIRST_RUN as RunId} diff={{ ...base, files: base.files.slice(0, 4) }} />,
    );
    expect(screen.getByRole("button", { name: "Show 1 more file" })).toBeTruthy();
    cleanup();

    // A turn that changed nothing draws no card at all.
    render(<ChangeCard runId={FIRST_RUN as RunId} diff={{ ...base, files: [] }} />);
    expect(screen.queryByTestId("row-changes")).toBeNull();
  });

  it("opens the review panel scoped to its own run from Review", () => {
    const onReview = vi.fn();
    const view = foldEvents(reviewFixtureEvents());
    const item = view.timeline.find(
      (entry): entry is Extract<TimelineItem, { kind: "changes" }> =>
        entry.kind === "changes" && entry.runId === FIRST_RUN,
    ) as TimelineItem;
    render(<TimelineRow view={view} item={item} onReview={onReview} />);
    const review = screen.getByRole("button", { name: "Review" });
    expect(review.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledWith({ tab: "review", scope: "turn", runId: FIRST_RUN });
  });

  it("has no Review button when nothing can open the panel", () => {
    render(<ChangeCard runId={FIRST_RUN as RunId} diff={firstTurnDiff()} />);
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    // And its file rows are plain rows, not buttons.
    expect(screen.queryByRole("button", { name: /^Review app/ })).toBeNull();
  });

  it("opens the review on the file a row names", () => {
    const onReview = vi.fn();
    const view = foldEvents(reviewFixtureEvents());
    const item = view.timeline.find(
      (entry): entry is Extract<TimelineItem, { kind: "changes" }> =>
        entry.kind === "changes" && entry.runId === FIRST_RUN,
    ) as TimelineItem;
    render(<TimelineRow view={view} item={item} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Review app/page.tsx" }));
    expect(onReview).toHaveBeenCalledWith({
      tab: "review",
      scope: "turn",
      runId: FIRST_RUN,
      path: "app/page.tsx",
    });
  });

  it("renders a path's text as text, never as markup", () => {
    const base = firstTurnDiff();
    const hostile = testFileChange({ path: "<img src=x onerror=alert(1)>/a.ts" });
    render(<ChangeCard runId={FIRST_RUN as RunId} diff={{ ...base, files: [hostile] }} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>/")).toBeTruthy();
  });

  it("draws nothing for a changes item whose run reported no diff", () => {
    const view = foldEvents([makeCommittedEvent("run.queued", {}, { sessionSequence: 1 })]);
    const { container } = render(
      <TimelineRow
        view={view}
        item={{ sequence: 2, kind: "changes", runId: "run_x" } as unknown as TimelineItem}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
