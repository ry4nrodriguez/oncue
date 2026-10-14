import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListBranchesResult } from "@/lib/api/branches";
import {
  type BranchChoice,
  BranchPicker,
  cachedListBranches,
  choiceLabel,
  DEFAULT_BRANCH_CHOICE,
  forgetBranchListings,
  LISTING_FRESH_MS,
  SEARCH_DEBOUNCE_MS,
  switchMode,
  workRefusal,
} from "./BranchPicker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LISTED: ListBranchesResult = {
  kind: "listed",
  defaultBranch: "main",
  branches: [
    { name: "main", protected: true, default: true },
    { name: "feature/login", protected: false, default: false },
    { name: "release/1.4", protected: true, default: false },
  ],
  truncated: false,
};

function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

/** The picker with its choice held as Home holds it. */
function Harness({
  load,
  initial = DEFAULT_BRANCH_CHOICE,
  onChange,
  repositoryConnectionId = "rc_1",
}: {
  load: (id: string, query: string) => Promise<ListBranchesResult>;
  initial?: BranchChoice;
  onChange?: (choice: BranchChoice) => void;
  repositoryConnectionId?: string | null;
}) {
  const [choice, setChoice] = useState(initial);
  return (
    <BranchPicker
      repositoryConnectionId={repositoryConnectionId}
      choice={choice}
      onChange={(next) => {
        setChoice(next);
        onChange?.(next);
      }}
      load={load}
    />
  );
}

async function open() {
  pointerClick(screen.getByTestId("branch-picker"));
  return await screen.findByTestId("branch-picker-panel");
}

describe("choiceLabel and workRefusal", () => {
  it("says where the session starts and whether it pushes there", () => {
    expect(choiceLabel(DEFAULT_BRANCH_CHOICE)).toBe("Default branch");
    expect(choiceLabel({ name: "release/1.4", mode: "new_branch" })).toBe("From release/1.4");
    expect(choiceLabel({ name: "feature/login", mode: "existing_branch" })).toBe(
      "On feature/login",
    );
    expect(choiceLabel({ name: null, mode: "existing_branch" })).toBe("Pick a branch to work on");
  });

  it("refuses the default and protected branches for working directly", () => {
    expect(workRefusal({ name: "main", protected: false, default: true })).toBe("Default branch");
    expect(workRefusal({ name: "r", protected: true, default: false })).toBe("Protected");
    expect(workRefusal({ name: "f", protected: false, default: false })).toBeNull();
  });
});

describe("switchMode", () => {
  it("drops a default or protected branch when switching to working directly, and keeps any other", () => {
    expect(
      switchMode({ name: "release/1.4", mode: "new_branch" }, "existing_branch", LISTED),
    ).toEqual({ name: null, mode: "existing_branch" });
    expect(
      switchMode({ name: "feature/login", mode: "new_branch" }, "existing_branch", LISTED),
    ).toEqual({ name: "feature/login", mode: "existing_branch" });
    // A name the listing does not show, or no listing yet, is kept for the Worker to judge.
    expect(
      switchMode({ name: "elsewhere", mode: "new_branch" }, "existing_branch", LISTED),
    ).toEqual({ name: "elsewhere", mode: "existing_branch" });
    expect(
      switchMode({ name: "release/1.4", mode: "new_branch" }, "existing_branch", null),
    ).toEqual({ name: "release/1.4", mode: "existing_branch" });
    expect(
      switchMode({ name: "release/1.4", mode: "existing_branch" }, "new_branch", LISTED),
    ).toEqual({ name: "release/1.4", mode: "new_branch" });
  });
});

describe("cachedListBranches", () => {
  it("reuses a listing for a minute per repository and search, and does not keep a failure", async () => {
    forgetBranchListings();
    const urls: string[] = [];
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (fail) {
          fail = false;
          return new Response("", { status: 502 });
        }
        return Response.json({ defaultBranch: "main", branches: [], truncated: false });
      }),
    );
    expect((await cachedListBranches("rc_1", "", 0)).kind).toBe("unreachable");
    expect((await cachedListBranches("rc_1", "", 1)).kind).toBe("listed");
    expect((await cachedListBranches("rc_1", " ", 2)).kind).toBe("listed");
    expect(urls).toHaveLength(2);
    await cachedListBranches("rc_1", "lo", 3);
    await cachedListBranches("rc_1", "", LISTING_FRESH_MS + 2);
    expect(urls).toHaveLength(4);
    forgetBranchListings();
    vi.unstubAllGlobals();
  });
});

describe("BranchPicker", () => {
  it("shows nothing without a repository", () => {
    render(<Harness load={vi.fn()} repositoryConnectionId={null} />);
    expect(screen.queryByTestId("branch-picker")).toBeNull();
  });

  it("lists the branches when opened, the default branch marked as the start", async () => {
    const load = vi.fn(async () => LISTED);
    render(<Harness load={load} />);
    expect(load).not.toHaveBeenCalled();
    const panel = await open();
    await waitFor(() => expect(within(panel).getAllByTestId("branch-option")).toHaveLength(3));
    expect(load).toHaveBeenCalledWith("rc_1", "");
    const main = within(panel)
      .getAllByTestId("branch-option")
      .find((row) => row.getAttribute("data-branch") === "main");
    expect(main?.getAttribute("aria-pressed")).toBe("true");
  });

  it("starts from a chosen branch, which a protected branch may be", async () => {
    const onChange = vi.fn();
    render(<Harness load={async () => LISTED} onChange={onChange} />);
    const panel = await open();
    const release = await waitFor(() =>
      within(panel)
        .getAllByTestId("branch-option")
        .find((row) => row.getAttribute("data-branch") === "release/1.4"),
    );
    expect(release).toBeDefined();
    expect((release as HTMLButtonElement).getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(release as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({ name: "release/1.4", mode: "new_branch" });
    expect(screen.getByTestId("branch-picker-label").textContent).toBe("From release/1.4");
  });

  it("names the default branch by its absence", async () => {
    const onChange = vi.fn();
    render(
      <Harness
        load={async () => LISTED}
        initial={{ name: "release/1.4", mode: "new_branch" }}
        onChange={onChange}
      />,
    );
    const panel = await open();
    const main = await waitFor(() =>
      within(panel)
        .getAllByTestId("branch-option")
        .find((row) => row.getAttribute("data-branch") === "main"),
    );
    fireEvent.click(main as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({ name: null, mode: "new_branch" });
  });

  it("working directly, refuses the default and protected branches and takes another", async () => {
    const onChange = vi.fn();
    render(<Harness load={async () => LISTED} onChange={onChange} />);
    const panel = await open();
    fireEvent.click(within(panel).getByTestId("branch-mode-existing_branch"));
    expect(onChange).toHaveBeenLastCalledWith({ name: null, mode: "existing_branch" });
    expect(panel.textContent).toContain("pushes to this branch");
    const rows = await waitFor(() => within(panel).getAllByTestId("branch-option"));
    const byName = (name: string) =>
      rows.find((row) => row.getAttribute("data-branch") === name) as HTMLButtonElement;
    expect(byName("main").getAttribute("aria-disabled")).toBe("true");
    expect(byName("main").textContent).toContain("Default branch");
    // Nothing is chosen yet: the default is not where this session works.
    expect(byName("main").getAttribute("aria-pressed")).toBe("false");
    expect(byName("release/1.4").getAttribute("aria-disabled")).toBe("true");
    // A refused row stays reachable, and choosing it changes nothing.
    fireEvent.click(byName("release/1.4"));
    expect(onChange).toHaveBeenLastCalledWith({ name: null, mode: "existing_branch" });
    expect(byName("release/1.4").textContent).toContain("Protected");
    fireEvent.click(byName("feature/login"));
    expect(onChange).toHaveBeenLastCalledWith({ name: "feature/login", mode: "existing_branch" });
    expect(screen.getByTestId("branch-picker-label").textContent).toBe("On feature/login");
  });

  it("asks again after typing pauses, and only the latest answer is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = new Map<string, (result: ListBranchesResult) => void>();
    const load = vi.fn(
      (_id: string, query: string) =>
        new Promise<ListBranchesResult>((resolve) => answers.set(query, resolve)),
    );
    render(<Harness load={load} />);
    const panel = await open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const search = within(panel).getByTestId("branch-search");
    fireEvent.change(search, { target: { value: "log" } });
    fireEvent.change(search, { target: { value: "login" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1);
    });
    expect(load.mock.calls.map(([, query]) => query)).toEqual(["", "login"]);
    await act(async () => {
      answers.get("login")?.({ ...LISTED, branches: [LISTED.branches[1] as never] });
      answers.get("")?.(LISTED);
    });
    await waitFor(() => expect(within(panel).getAllByTestId("branch-option")).toHaveLength(1));
  });

  it.each([
    [
      { kind: "listed", defaultBranch: "main", branches: [], truncated: false },
      "No branch matches.",
    ],
    [{ kind: "reconnect_github" }, "Reconnect GitHub"],
    [{ kind: "unreachable" }, "couldn't list the branches"],
  ] as const)("says what it can when the list is %j", async (result, words) => {
    render(<Harness load={async () => result as ListBranchesResult} />);
    const panel = await open();
    await waitFor(() => expect(panel.textContent).toContain(words));
  });

  it("says a long list was cut short", async () => {
    render(<Harness load={async () => ({ ...LISTED, truncated: true })} />);
    const panel = await open();
    await waitFor(() => expect(panel.textContent).toContain("Type a name to find another"));
  });
});
