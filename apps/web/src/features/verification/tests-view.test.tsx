import { foldEvents, type RunId } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN, reviewFixtureEvents, SECOND_RUN } from "@/features/diff/review-fixture";
import { TestsView } from "./TestsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTests(runId: string | null, sessionId: string | null = "sess_1") {
  const view = foldEvents(reviewFixtureEvents());
  return render(<TestsView view={view} sessionId={sessionId} runId={runId as RunId | null} />);
}

function check(checkId: string): HTMLElement {
  return screen
    .getAllByTestId("tests-check")
    .find((item) => item.getAttribute("data-check-id") === checkId) as HTMLElement;
}

/** Opens a check's row, which starts closed. */
function open(row: HTMLElement) {
  fireEvent.click(within(row).getByRole("button", { expanded: false }));
}

describe("TestsView", () => {
  it("sums the checks and the run's outcome in plain text, one line per check", () => {
    renderTests(FIRST_RUN);
    expect(screen.getAllByTestId("tests-check")).toHaveLength(3);
    const summary = screen.getByTestId("tests-summary");
    expect(summary.textContent).toContain("2 passed");
    expect(summary.textContent).toContain("1 failed");
    expect(summary.textContent).toContain("Verified");
    // Nothing green: passed and Verified are text; only a failure is coloured.
    expect(within(summary).getByText("2 passed").className).not.toContain("text-positive");
    expect(within(summary).getByText("Verified").className).not.toContain("text-positive");
    expect(within(summary).getByText("1 failed").className).toContain("text-danger");

    const test = check("chk_test_1");
    expect(test.getAttribute("data-state")).toBe("passed");
    // Required is the default and goes unsaid.
    expect(within(test).queryByTestId("check-classification")).toBeNull();
    expect(within(test).getByRole("button", { name: "test, passed" })).toBeTruthy();
    expect(within(test).getByText("passed").className).not.toContain("text-positive");
    expect(within(test).getByText("2 attempts")).toBeTruthy();
    // Closed: the attempts and output wait behind the chevron.
    expect(within(test).queryByRole("listitem")).toBeNull();

    open(test);
    expect(within(test).getAllByText("1.9s")).toHaveLength(2);
    const attempts = within(test).getAllByRole("listitem");
    expect(attempts.map((attempt) => attempt.textContent)).toEqual([
      "Attempt 1failed2.1sFull output",
      "Attempt 2passed1.9sFull output",
    ]);
    expect(
      within(test).getByRole("button", { name: "Full output for test, attempt 2" }),
    ).toBeTruthy();

    const lint = check("chk_lint_1");
    expect(within(lint).getByTestId("check-classification").textContent).toBe("recommended");
    expect(within(lint).getByText("failed").className).toContain("text-danger");
    open(lint);
    expect(within(lint).getByTestId("check-base-comparison").textContent).toBe(
      "Reproduced on base: it fails on the base revision too.",
    );
    // No base comparison line when none ran.
    const typecheck = check("chk_typecheck_1");
    open(typecheck);
    expect(within(typecheck).queryByTestId("check-base-comparison")).toBeNull();
  });

  it("shows the output summary as preformatted text, never markup", () => {
    renderTests(FIRST_RUN);
    const test = check("chk_test_1");
    open(test);
    const summary = within(test).getByTestId("check-summary");
    expect(summary.tagName).toBe("PRE");
    expect(summary.textContent).toContain("ok 1 - retry <script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    // An empty summary draws no box.
    const typecheck = check("chk_typecheck_1");
    open(typecheck);
    expect(within(typecheck).queryByTestId("check-summary")).toBeNull();
  });

  it("downloads the full output through the Worker", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response("log bytes", { status: 200 });
      }),
    );
    URL.createObjectURL = vi.fn(() => "blob:log");
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    renderTests(FIRST_RUN);
    const typecheck = check("chk_typecheck_1");
    open(typecheck);
    fireEvent.click(within(typecheck).getByRole("button", { name: "Full output for typecheck" }));
    await vi.waitFor(() => expect(clicked).toEqual(["typecheck.log"]));
    expect(calls).toEqual(["/api/sessions/sess_1/artifacts/art_tc_1"]);
  });

  it("says Artifact unavailable when the output is missing from storage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    renderTests(FIRST_RUN);
    const lint = check("chk_lint_1");
    open(lint);
    fireEvent.click(within(lint).getByRole("button", { name: "Full output for lint" }));
    expect((await within(lint).findByTestId("artifact-unavailable")).textContent).toBe(
      "Artifact unavailable",
    );
  });

  it("names a skip's reason and offers no output link without evidence", () => {
    renderTests(SECOND_RUN);
    const typecheck = check("chk_typecheck_2");
    // A skip is plain text too, not a warning colour.
    expect(within(typecheck).getByText("skipped").className).not.toContain("text-caution");
    open(typecheck);
    expect(within(typecheck).getByText("skipped (skipped at your request)")).toBeTruthy();
    expect(within(typecheck).queryByTestId("check-full-output")).toBeNull();
    const summary = screen.getByTestId("tests-summary");
    expect(summary.textContent).toContain("1 other");
    expect(summary.textContent).toContain("Completed with warnings");
  });

  it("says so when the run has no checks, or there is no run", () => {
    renderTests(null);
    expect(screen.getByText("No checks have run for this turn yet.")).toBeTruthy();
  });

  it("shows a running check, an inconclusive reason, and a check's classification when it is not required", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent(
        "verification.started",
        { payload: { checkId: "chk_run", name: "build", classification: "informational" } },
        { sessionSequence: 3 },
      ),
      makeCommittedEvent(
        "verification.started",
        { payload: { checkId: "chk_flaky", name: "test" } },
        { sessionSequence: 4 },
      ),
      makeCommittedEvent(
        "verification.result",
        {
          payload: {
            checkId: "chk_flaky",
            result: "inconclusive",
            inconclusiveReason: "flaky",
            baseComparison: "new_failure",
          },
        },
        { sessionSequence: 5 },
      ),
      makeCommittedEvent(
        "verification.started",
        { payload: { checkId: "chk_flaky", name: "test", attempt: 2 } },
        { sessionSequence: 6 },
      ),
    ]);
    render(<TestsView view={view} sessionId={null} runId={"run_1" as RunId} />);
    const build = check("chk_run");
    expect(within(build).getByTestId("check-classification").textContent).toBe("informational");
    expect(within(build).getByText("running")).toBeTruthy();
    const flaky = check("chk_flaky");
    open(flaky);
    const attempts = within(flaky).getAllByRole("listitem");
    expect(attempts[0]?.textContent).toContain("inconclusive (flaky: passed only on a retry)");
    expect(attempts[1]?.textContent).toBe("Attempt 2running");
  });

  it("shows not finished, counted under other, for a check its cancelled run left unfinished", () => {
    const cancelled = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
      makeCommittedEvent("run.cancelled", {}, { sessionSequence: 4 }),
    ]);
    render(<TestsView view={cancelled} sessionId={null} runId={"run_1" as RunId} />);
    const test = check("chk_1");
    expect(within(test).getByText("not finished")).toBeTruthy();
    expect(within(test).getByText("not finished").className).toContain("text-faint");
    expect(screen.getByTestId("tests-summary").textContent).toContain("1 other");
    cleanup();

    const active = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("run.started", {}, { sessionSequence: 2 }),
      makeCommittedEvent("verification.started", {}, { sessionSequence: 3 }),
    ]);
    render(<TestsView view={active} sessionId={null} runId={"run_1" as RunId} />);
    expect(within(check("chk_1")).getByText("running")).toBeTruthy();
  });
});
