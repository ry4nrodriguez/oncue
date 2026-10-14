import { foldEvents, type RunId, type SessionView } from "@oncue/protocol";
import { makeCommittedEvent, testFileChange } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useImperativeHandle,
  useRef,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionScreen } from "@/features/session/SessionScreen";
import { ancestorFolders } from "./ChangedFileTree";
import { sizeWords } from "./FileContentView";
import { ReviewPanel } from "./ReviewPanel";
import {
  FIRST_RUN,
  largeReviewFixtureEvents,
  reviewFixtureEvents,
  SECOND_RUN,
  SESSION_TREE_ARTIFACT_ID,
} from "./review-fixture";
import {
  buildFileTree,
  changedFilesWords,
  diffBody,
  diffForScope,
  focusRunId,
  MAX_RENDERED_DIFF_LINES,
  pathsChangedInSession,
  type ReviewTarget,
  selectionShown,
  splitPath,
} from "./review-model";

/**
 * jsdom has no layout, so `use-stick-to-bottom` is replaced by a stand-in
 * exposing the context the screen reads; the tests give rows heights that
 * change when the panel opens.
 */
const stick = vi.hoisted(() => ({ atBottom: false, scrollToBottom: vi.fn() }));

vi.mock("use-stick-to-bottom", () => {
  type Context = {
    scrollRef: { current: HTMLElement | null };
    contentRef: { current: HTMLElement | null };
    readonly isAtBottom: boolean;
    scrollToBottom: (options?: unknown) => boolean;
    stopScroll: () => void;
    escapedFromLock: boolean;
    state: object;
  };
  const StickContext = createContext<Context | null>(null);
  function StickToBottom({
    children,
    contextRef,
    className,
  }: {
    children: ReactNode;
    contextRef?: Ref<Context>;
    className?: string;
  }) {
    const scrollRef = useRef<HTMLElement | null>(null);
    const contentRef = useRef<HTMLElement | null>(null);
    const context: Context = {
      scrollRef,
      contentRef,
      get isAtBottom() {
        return stick.atBottom;
      },
      scrollToBottom: (options) => stick.scrollToBottom(options),
      stopScroll: () => {},
      escapedFromLock: false,
      state: {},
    };
    useImperativeHandle(contextRef, () => context);
    return (
      <StickContext.Provider value={context}>
        <div role="log" className={className}>
          {children}
        </div>
      </StickContext.Provider>
    );
  }
  StickToBottom.Content = function Content({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) {
    const context = useContext(StickContext);
    return (
      <div ref={context?.scrollRef as Ref<HTMLDivElement>} data-testid="scroller">
        <div className={className}>{children}</div>
      </div>
    );
  };
  return {
    StickToBottom,
    useStickToBottomContext: () => useContext(StickContext),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stick.atBottom = false;
  stick.scrollToBottom.mockReset();
});

beforeEach(() => {
  // The vendored Base UI menu and the split measure elements.
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function fixtureView(options?: Parameters<typeof reviewFixtureEvents>[0]): SessionView {
  return foldEvents(reviewFixtureEvents(options));
}

function renderPanel(target: ReviewTarget, view = fixtureView()) {
  const onTargetChange = vi.fn();
  const utils = render(
    <ReviewPanel view={view} sessionId="sess_1" target={target} onTargetChange={onTargetChange} />,
  );
  return { ...utils, onTargetChange };
}

/** Base UI activates menu items from the pointer sequence, not a bare click. */
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

function diffPaths(): string[] {
  return screen
    .getAllByTestId("diff-file")
    .map((file) => file.getAttribute("data-diff-path") ?? "");
}

describe("ReviewPanel", () => {
  it("is a labelled region with Diff and Tests tabs, and no close of its own", () => {
    const { onTargetChange } = renderPanel({ tab: "review", scope: "turn", runId: null });
    expect(screen.getByRole("region", { name: "Review changes" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    // "Diff", not "Review": the side panel's own tab is called Review.
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Diff", "Tests"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
    expect(onTargetChange).toHaveBeenCalledWith({ tab: "tests", scope: "turn", runId: null });
    // The side panel owns closing.
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
  });

  it("shows the latest run's turn under Last turn, a named run's turn, and the session under All changes", async () => {
    const view = fixtureView();
    const { onTargetChange, unmount } = renderPanel(
      { tab: "review", scope: "turn", runId: null },
      view,
    );
    const scope = screen.getByRole("button", { name: "Scope: Last turn" });
    expect(scope.textContent).toBe("Last turn");
    expect(diffPaths()).toEqual(["README.md"]);
    expect(screen.getAllByText("+1").length).toBeGreaterThan(0);

    pointerClick(scope);
    const menu = await screen.findByRole("menu");
    const options = within(menu).getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual(["Last turn", "All changes"]);
    pointerClick(within(menu).getByRole("menuitemradio", { name: "All changes" }));
    await waitFor(() =>
      expect(onTargetChange).toHaveBeenCalledWith({ tab: "review", scope: "session", runId: null }),
    );
    unmount();

    renderPanel({ tab: "review", scope: "turn", runId: FIRST_RUN as RunId }, view);
    expect(diffPaths()).toEqual([
      "app/page.tsx",
      "lib/retry.ts",
      "lib/old.ts",
      "README.md",
      "package.json",
    ]);
    cleanup();

    renderPanel({ tab: "review", scope: "session", runId: FIRST_RUN as RunId }, view);
    expect(screen.getByRole("button", { name: "Scope: All changes" })).toBeTruthy();
    expect(diffPaths()).toHaveLength(5);
    expect(screen.getAllByText("+11").length).toBeGreaterThan(0);
  });

  it("draws hunks with line numbers and signs, and collapses unchanged runs into unmodified-lines rows", () => {
    renderPanel({ tab: "review", scope: "turn", runId: FIRST_RUN as RunId });
    const page = screen
      .getAllByTestId("diff-file")
      .find((file) => file.getAttribute("data-diff-path") === "app/page.tsx") as HTMLElement;
    const gaps = within(page)
      .getAllByTestId("diff-gap")
      .map((gap) => gap.textContent);
    // Lines 1-3 before the first hunk, and new lines 12-41 between the hunks.
    expect(gaps).toEqual(["3 unmodified lines", "30 unmodified lines"]);
    const added = within(page)
      .getAllByTestId("diff-line")
      .filter((line) => line.getAttribute("data-kind") === "added");
    expect(added[0]?.textContent).toBe("6+  const attempts = retry(budget);");
    expect(added[0]?.className).toContain("border-positive");
    const removed = within(page)
      .getAllByTestId("diff-line")
      .find((line) => line.getAttribute("data-kind") === "removed");
    expect(removed?.textContent).toBe("6-  const attempts = 1;");
    expect(removed?.className).toContain("border-danger");
    // A file header names the path with its directory dimmed, and its counts.
    const header = within(page).getByText("app/");
    expect(header.className).toContain("text-muted-foreground");
    // One unmodified line reads in the singular.
    const pkg = screen
      .getAllByTestId("diff-file")
      .find((file) => file.getAttribute("data-diff-path") === "package.json") as HTMLElement;
    expect(within(pkg).getByTestId("diff-gap").textContent).toBe("1 unmodified line");
  });

  it("filters the file tree and jumps the diff to the file picked", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPanel({ tab: "review", scope: "turn", runId: FIRST_RUN as RunId });
    const tree = screen.getByRole("tree", { name: "Changed files" });
    // Folders start closed, and each folder holding changes says how many.
    expect(
      within(tree)
        .getAllByTestId("tree-change-mark")
        .map((mark) => mark.textContent),
    ).toEqual(["M", "M"]);
    expect(
      within(tree)
        .getAllByTestId("tree-folder-mark")
        .map((mark) => mark.textContent),
    ).toEqual(["1", "2"]);
    expect(within(tree).getByText(", contains 2 changed files")).toBeTruthy();
    expect(within(tree).getByText(", contains 1 changed file")).toBeTruthy();
    fireEvent.click(within(tree).getByText("lib"));
    expect(
      within(tree)
        .getAllByTestId("tree-change-mark")
        .map((mark) => mark.textContent),
    ).toEqual(["D", "A", "M", "M"]);
    // The marker is also said in words.
    expect(within(tree).getAllByText(", deleted")).toHaveLength(1);
    fireEvent.click(within(tree).getByText("lib"));

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "RETRY" },
    });
    const items = within(screen.getByRole("tree")).getAllByRole("treeitem");
    expect(items.map((item) => item.getAttribute("data-tree-path"))).toEqual([
      "lib/",
      "lib/retry.ts",
    ]);
    fireEvent.click(within(screen.getByRole("tree")).getByText("retry.ts"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(target.getAttribute("data-diff-path")).toBe("lib/retry.ts");
    expect(document.activeElement).toBe(target);

    // A folder can still be closed while filtering, and opens again with it.
    const lib = within(screen.getByRole("tree")).getAllByRole("treeitem")[0] as HTMLElement;
    fireEvent.click(lib.firstElementChild as Element);
    expect(lib.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(lib.firstElementChild as Element);
    expect(lib.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "nothing-matches" },
    });
    expect(screen.getByText("No files match.")).toBeTruthy();

    // With the filter cleared, the folder the selected file sits in stays open.
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "" },
    });
    const cleared = within(screen.getByRole("tree")).getAllByRole("treeitem");
    expect(
      cleared
        .filter((item) => item.getAttribute("aria-expanded") === "true")
        .map((item) => item.getAttribute("data-tree-path")),
    ).toEqual(["lib/"]);
  });

  it("lands on the file a target names, and offers the folder only while the tree is away", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // A card names its own run: the file lives in the first turn's diff.
    renderPanel({
      tab: "review",
      scope: "turn",
      runId: FIRST_RUN as RunId,
      path: "lib/retry.ts",
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.contexts[0] as HTMLElement).getAttribute("data-diff-path")).toBe(
      "lib/retry.ts",
    );
    // jsdom lays nothing out, so the tree panel reports no size; the button
    // appears only once the panel says it is collapsed.
    expect(screen.getByTestId("review-tree")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the file tree" })).toBeTruthy();
  });

  it("moves through the tree with the keyboard and opens and closes folders", () => {
    renderPanel({ tab: "review", scope: "turn", runId: FIRST_RUN as RunId });
    const tree = screen.getByRole("tree");
    const items = () => within(tree).getAllByRole("treeitem");
    const first = items()[0] as HTMLElement;
    expect(first.getAttribute("data-tree-path")).toBe("app/");
    // Every folder starts closed.
    expect(
      items()
        .filter((item) => item.getAttribute("aria-expanded") !== null)
        .map((item) => item.getAttribute("aria-expanded")),
    ).toEqual(["false", "false"]);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("app/page.tsx");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("README.md");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "x" });

    expect(first.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(items().map((item) => item.getAttribute("data-tree-path"))).not.toContain(
      "app/page.tsx",
    );
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(first.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(first, { key: " " });
    expect(first.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(first.firstElementChild as Element);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first.firstElementChild as Element);

    // A key or click inside a nested file does not toggle its folder.
    const file = items().find((item) => item.getAttribute("data-tree-path") === "app/page.tsx");
    fireEvent.keyDown(file as Element, { key: "Enter" });
    fireEvent.click(file as Element);
    expect(first.getAttribute("aria-expanded")).toBe("true");
  });

  it("lists files with a download when the diff arrived as an artifact, and says when it is unavailable", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response("", { status: 404 });
      }),
    );
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionDiffAsArtifact: true }),
    );
    expect(screen.getByTestId("diff-too-large").textContent).toContain(
      "Diff too large to show here",
    );
    expect(screen.queryAllByTestId("diff-line")).toHaveLength(0);
    const list = screen.getByTestId("diff-file-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getByText("+2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download diff" }));
    expect((await screen.findByTestId("artifact-unavailable")).textContent).toBe(
      "Artifact unavailable",
    );
    expect(calls).toEqual(["/api/sessions/sess_1/artifacts/art_session_diff"]);
  });

  it("draws the whole repository from the tree listing, marks the changed files, and shows a file the session left alone", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith("/api/sessions/sess_1/files")) {
          return new Response("export const untouched = true;\n<b>not markup</b>\n", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8", "x-oncue-file-kind": "text" },
          });
        }
        return new Response(
          "README.md\napp/page.tsx\nlib/retry.ts\nlib/untouched.ts\npackage.json\n\n",
          {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }),
    );
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );
    const tree = screen.getByRole("tree", { name: "Changed files" });
    await waitFor(() => expect(within(tree).getAllByTestId("tree-folder-mark")).toHaveLength(2));
    expect(calls).toEqual([`/api/sessions/sess_1/artifacts/${SESSION_TREE_ARTIFACT_ID}`]);
    fireEvent.click(within(tree).getByText("lib"));
    await waitFor(() => expect(within(tree).queryByText("untouched.ts")).not.toBeNull());
    const items = within(tree).getAllByRole("treeitem");
    const paths = items.map((item) => item.getAttribute("data-tree-path"));
    // The deleted file is listed with its mark although the head has no such path.
    expect(paths).toContain("lib/old.ts");
    expect(paths).toContain("lib/untouched.ts");
    const untouched = items.find(
      (item) => item.getAttribute("data-tree-path") === "lib/untouched.ts",
    );
    expect(within(untouched as HTMLElement).queryByTestId("tree-change-mark")).toBeNull();
    expect(screen.getAllByTestId("tree-change-mark")).toHaveLength(4);
    expect(screen.queryByTestId("file-view")).toBeNull();

    fireEvent.click(untouched as HTMLElement);
    const view = await screen.findByTestId("file-view");
    expect(view.getAttribute("data-file-path")).toBe("lib/untouched.ts");
    await waitFor(() => expect(within(view).getAllByTestId("file-line")).toHaveLength(2));
    expect(within(view).getAllByTestId("file-line")[1]?.textContent).toBe("2<b>not markup</b>");
    expect(view.querySelector("b")).toBeNull();
    expect(calls.at(-1)).toBe("/api/sessions/sess_1/files?path=lib%2Funtouched.ts");
    // The diff gives way to the file, and comes back.
    expect(screen.queryAllByTestId("diff-file")).toHaveLength(0);
    fireEvent.click(within(view).getByRole("button", { name: "Back to the changes" }));
    expect(screen.queryByTestId("file-view")).toBeNull();
    expect(screen.getAllByTestId("diff-file").length).toBeGreaterThan(0);

    fireEvent.click(untouched as HTMLElement);
    await screen.findByTestId("file-view");
    fireEvent.click(
      items.find((item) => item.getAttribute("data-tree-path") === "README.md") as HTMLElement,
    );
    expect(screen.queryByTestId("file-view")).toBeNull();
    expect(screen.queryByTestId("review-unchanged-file")).toBeNull();
  });

  it.each([
    ["text", { "x-oncue-file-kind": "text" }, 200, "", /This file is empty/],
    ["binary", { "x-oncue-file-kind": "binary" }, 200, "\u0000", /Binary file, not shown/],
    ["too large", {}, 413, JSON.stringify({ error: "too_large", size: 2_400_000 }), /2\.4 MB/],
    ["not found", {}, 404, JSON.stringify({ error: "not_found" }), /not in the commit/],
    ["a link", {}, 422, JSON.stringify({ error: "not_a_file", type: "symlink" }), /a link/],
    [
      "a GitHub link to reconnect",
      {},
      409,
      JSON.stringify({ error: "github_reverification_required" }),
      /Reconnect GitHub/,
    ],
    ["a failure", {}, 502, JSON.stringify({ error: "github_failed" }), /couldn't read this file/],
  ])("says what it can about a %s file", async (_what, headers, status, body, words) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/sessions/sess_1/files")
          ? new Response(body, { status, headers })
          : new Response("README.md\nlib/untouched.ts\n", { status: 200 }),
      ),
    );
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );
    const tree = screen.getByRole("tree", { name: "Changed files" });
    await waitFor(() => expect(within(tree).getAllByTestId("tree-folder-mark")).toHaveLength(2));
    fireEvent.click(within(tree).getByText("lib"));
    fireEvent.click(await within(tree).findByText("untouched.ts"));
    const view = await screen.findByTestId("file-view");
    await waitFor(() => expect(view.textContent).toMatch(words));
    const download = within(view).queryByTestId("file-download");
    if (download !== null) {
      expect(download.getAttribute("href")).toBe(
        "/api/sessions/sess_1/files?path=lib%2Funtouched.ts&download=1",
      );
    }
  });

  it("draws an image from its bytes", async () => {
    const createObjectURL = vi.fn(() => "blob:oncue/1");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/sessions/sess_1/files")
          ? new Response(new Uint8Array([0x89, 0x50]), {
              status: 200,
              headers: { "x-oncue-file-kind": "image", "content-type": "image/png" },
            })
          : new Response("README.md\nlib/logo.png\n", { status: 200 }),
      ),
    );
    const { unmount } = renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );
    const tree = screen.getByRole("tree", { name: "Changed files" });
    await waitFor(() => expect(within(tree).getAllByTestId("tree-folder-mark")).toHaveLength(2));
    fireEvent.click(within(tree).getByText("lib"));
    fireEvent.click(await within(tree).findByText("logo.png"));
    const image = await screen.findByTestId("file-image");
    expect(image.getAttribute("src")).toBe("blob:oncue/1");
    expect(image.getAttribute("alt")).toBe("lib/logo.png");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:oncue/1");
  });

  it("says the tree listing failed, offers Retry, and draws the whole tree once Retry succeeds", async () => {
    const listing = new Response("README.md\nlib/retry.ts\nlib/untouched.ts\n", { status: 200 });
    const fetchMock = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(listing);
    vi.stubGlobal("fetch", fetchMock);
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );

    const failed = await screen.findByTestId("tree-listing-failed");
    expect(failed.textContent).toContain("Showing changed files only");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByTestId("tree-listing-failed")).toBeNull());
    const tree = screen.getByRole("tree", { name: "Changed files" });
    fireEvent.click(within(tree).getByText("lib"));
    await waitFor(() => expect(within(tree).queryByText("untouched.ts")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable listing body as a failure", async () => {
    const broken = new Response("x", { status: 200 });
    vi.spyOn(broken, "blob").mockResolvedValue({
      text: () => Promise.reject(new Error("unreadable")),
    } as unknown as Blob);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => broken),
    );
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );
    expect(await screen.findByTestId("tree-listing-failed")).toBeTruthy();
  });

  it("shows the changed files alone when the tree listing cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    renderPanel(
      { tab: "review", scope: "session", runId: null },
      fixtureView({ sessionTree: true }),
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("tree-listing-failed")).toBeTruthy();
    const tree = screen.getByRole("tree", { name: "Changed files" });
    for (const folder of ["app", "lib"]) {
      fireEvent.click(within(tree).getByText(folder));
    }
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .filter((item) => item.getAttribute("aria-expanded") === null),
    ).toHaveLength(5);
  });

  it("falls back to the file list past 3,000 lines, with no download to offer", () => {
    const lines = Array.from({ length: MAX_RENDERED_DIFF_LINES + 1 }, (_, i) => `+line ${i}`);
    const patch = [
      "--- /dev/null",
      "+++ b/big.txt",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines,
    ].join("\n");
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "diff.updated",
        {
          payload: {
            files: [testFileChange({ path: "big.txt", additions: lines.length, deletions: 0 })],
            body: { kind: "inline", patch },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    renderPanel({ tab: "review", scope: "turn", runId: null }, view);
    expect(screen.getByTestId("diff-too-large")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download diff" })).toBeNull();
    expect(screen.queryAllByTestId("diff-line")).toHaveLength(0);
  });

  it("falls back to the file list for a truncated inline patch", () => {
    const view = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent("diff.updated", { payload: { truncated: true } }, { sessionSequence: 2 }),
    ]);
    renderPanel({ tab: "review", scope: "turn", runId: null }, view);
    expect(screen.getByTestId("diff-too-large")).toBeTruthy();
  });

  it("keeps untrusted patch text as text", () => {
    renderPanel({ tab: "review", scope: "turn", runId: FIRST_RUN as RunId });
    expect(document.querySelector("img")).toBeNull();
    const line = screen
      .getAllByTestId("diff-line")
      .find((row) => row.textContent?.includes("onerror"));
    expect(line?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says when a scope has nothing, and when a file has no lines to show", () => {
    const empty = foldEvents([makeCommittedEvent("run.queued", {}, { sessionSequence: 1 })]);
    renderPanel({ tab: "review", scope: "session", runId: null }, empty);
    expect(screen.getByTestId("review-empty").textContent).toBe(
      "No changes recorded for this session yet.",
    );
    cleanup();
    renderPanel({ tab: "review", scope: "turn", runId: null }, empty);
    expect(screen.getByTestId("review-empty").textContent).toBe(
      "No changes recorded for this turn yet.",
    );
    cleanup();

    const binary = foldEvents([
      makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
      makeCommittedEvent(
        "diff.updated",
        {
          payload: {
            files: [testFileChange({ path: "logo.png" }), testFileChange({ path: "gone.txt" })],
            body: {
              kind: "inline",
              patch:
                "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
            },
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    renderPanel({ tab: "review", scope: "turn", runId: null }, binary);
    expect(screen.getByText("Binary file, not shown.")).toBeTruthy();
    expect(screen.getByText("No line changes to show.")).toBeTruthy();
  });

  it("shows the Tests view on the Tests tab", () => {
    renderPanel({ tab: "tests", scope: "turn", runId: SECOND_RUN as RunId });
    expect(screen.getByTestId("tests-view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Scope:/ })).toBeNull();
  });
});

describe("review model", () => {
  it("splits paths, builds a sorted tree, and picks the focused run", () => {
    expect(splitPath("a.ts")).toEqual({ directory: "", name: "a.ts" });
    expect(splitPath("x/y/z.ts")).toEqual({ directory: "x/y/", name: "z.ts" });
    const tree = buildFileTree([
      testFileChange({ path: "b/z.ts" }),
      testFileChange({ path: "b/a/y.ts" }),
      testFileChange({ path: "a.ts" }),
    ]);
    expect(tree.map((node) => node.path)).toEqual(["b/", "a.ts"]);
    const b = tree[0];
    expect(b?.kind === "folder" ? b.children.map((node) => node.path) : []).toEqual([
      "b/a/",
      "b/z.ts",
    ]);

    // With a listing, every path is drawn, a deleted file is kept, and the
    // filter applies to both.
    const whole = buildFileTree(
      [testFileChange({ path: "a.ts" }), testFileChange({ path: "gone.ts", status: "deleted" })],
      "",
      ["a.ts", "b/z.ts", "a.ts"],
    );
    expect(
      whole.map((node) => [
        node.path,
        node.kind === "file" ? (node.change?.status ?? null) : "dir",
      ]),
    ).toEqual([
      ["b/", "dir"],
      ["a.ts", "modified"],
      ["gone.ts", "deleted"],
    ]);
    expect(buildFileTree([], "z.ts", ["a.ts", "b/z.ts"]).map((node) => node.path)).toEqual(["b/"]);

    const view = fixtureView();
    expect(focusRunId(view, null)).toBe(SECOND_RUN);
    expect(focusRunId(foldEvents([]), null)).toBeNull();
    // A turn that reported no diff falls back to the last turn that did.
    expect(diffForScope(view, "turn", "run_none" as RunId)?.files).toHaveLength(1);
    expect(diffForScope(foldEvents([]), "turn", null)).toBeNull();
  });

  it("counts a folder's changed files at any depth", () => {
    const tree = buildFileTree(
      [testFileChange({ path: "a/b/c.ts" }), testFileChange({ path: "a/d.ts" })],
      "",
      ["a/b/c.ts", "a/d.ts", "a/e.ts", "f/g.ts"],
    );
    const counts = (nodes: typeof tree): [string, number][] =>
      nodes.flatMap((node) =>
        node.kind === "folder"
          ? [[node.path, node.changed] as [string, number], ...counts(node.children)]
          : [],
      );
    expect(counts(tree)).toEqual([
      ["a/", 2],
      ["a/b/", 1],
      ["f/", 0],
    ]);
    expect(changedFilesWords(1)).toBe("contains 1 changed file");
    expect(changedFilesWords(3)).toBe("contains 3 changed files");
    expect(ancestorFolders("a/b/c.ts")).toEqual(["a/", "a/b/"]);
    expect(ancestorFolders("c.ts")).toEqual([]);
  });

  it("shows the base commit's copy only of a file the session never changed", () => {
    const view = fixtureView();
    const changed = pathsChangedInSession(view);
    expect([...changed].sort()).toEqual([
      "README.md",
      "app/page.tsx",
      "lib/old.ts",
      "lib/retry.ts",
      "package.json",
    ]);
    const lastTurn = diffForScope(view, "turn", SECOND_RUN as RunId);
    if (lastTurn === null) {
      throw new Error("the fixture's second turn has a diff");
    }
    expect(selectionShown(changed, lastTurn, null, true)).toEqual({ kind: "in_diff" });
    expect(selectionShown(changed, lastTurn, "README.md", true)).toEqual({ kind: "in_diff" });
    expect(selectionShown(changed, lastTurn, "lib/untouched.ts", true)).toEqual({
      kind: "base_file",
      path: "lib/untouched.ts",
    });
    // The first turn changed it, so the base commit's copy is not what it is now.
    expect(selectionShown(changed, lastTurn, "app/page.tsx", true)).toEqual({
      kind: "note",
      path: "app/page.tsx",
      changedEarlier: true,
    });
    // With no session to read through, a file is only named.
    expect(selectionShown(changed, lastTurn, "lib/untouched.ts", false)).toEqual({
      kind: "note",
      path: "lib/untouched.ts",
      changedEarlier: false,
    });
    expect(pathsChangedInSession(foldEvents([])).size).toBe(0);
    expect(sizeWords(2_400_000)).toBe("2.4 MB");
    expect(sizeWords(340_000)).toBe("340 KB");
    expect(sizeWords(10)).toBe("1 KB");
  });

  it("focuses the last run with a diff when the view has no current run", () => {
    const view = { ...fixtureView(), run: null };
    expect(focusRunId(view, null)).toBe(SECOND_RUN);
  });
});

/**
 * Enough of a WebSocket to replay the fixture into the real screen, as
 * `session-screen.test.tsx` does.
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  deliver(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    });
  }
}

function renderScreen() {
  render(
    <SessionScreen
      sessionId="sess_1"
      createSocket={(url) => new FakeSocket(url) as unknown as WebSocket}
      railPinnedAtStart
    />,
  );
  const socket = FakeSocket.last as FakeSocket;
  act(() => {
    socket.onopen?.();
  });
  const events = reviewFixtureEvents();
  socket.deliver({ type: "replay_batch", through: events.length, events });
  socket.deliver({ type: "caught_up", through: events.length });
  return socket;
}

/**
 * Gives every timeline row a height, taller while the review panel is open
 * (the narrower timeline wraps more), and a scroller whose `scrollTop` holds.
 */
function layOut() {
  const scroller = screen.getByTestId("scroller");
  let scrollTop = 250;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === scroller) {
      return rect(0, 600);
    }
    const key = (this as HTMLElement).dataset?.timelineKey;
    if (key === undefined) {
      return rect(0, 0);
    }
    const rows = [...scroller.querySelectorAll("[data-timeline-key]")];
    const open = document.querySelector("[data-testid=review-panel]") !== null;
    const height = open ? 150 : 100;
    return rect(rows.indexOf(this) * height - scrollTop, height);
  });
  return { scroller, scrollTop: () => scrollTop };
}

describe("opening and closing the review panel", () => {
  it("keeps the first visible row where it was, sends nothing, and never remounts the timeline", () => {
    const socket = renderScreen();
    const { scrollTop } = layOut();
    const sentBefore = socket.sent.length;
    const anchorRow = screen.getByTestId("scroller").querySelectorAll("[data-timeline-key]")[2];

    fireEvent.click(screen.getByTestId("rail-changes"));
    expect(screen.getByRole("region", { name: "Review changes" })).toBeTruthy();
    // Row 2's top was 50px above the scroller's top; with taller rows it
    // stays 50px above after the scroll moves by the reflow.
    expect(scrollTop()).toBe(350);
    expect(screen.getByRole("button", { name: "Scope: All changes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("region", { name: "Review changes" })).toBeNull();
    expect(scrollTop()).toBe(250);

    expect(document.body.contains(anchorRow as Element)).toBe(true);
    expect(socket.sent.length).toBe(sentBefore);
  });

  it("keeps a reader at the bottom stuck to the bottom", () => {
    renderScreen();
    layOut();
    stick.atBottom = true;
    fireEvent.click(screen.getByTestId("rail-changes"));
    expect(stick.scrollToBottom).toHaveBeenCalledWith("instant");
  });

  it("opens on the change card's turn from Review, and on Tests from the rail's outcome", async () => {
    renderScreen();
    const cards = screen.getAllByTestId("row-changes");
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Scope: Last turn" })).toBeTruthy();
    expect(diffPaths()).toHaveLength(5);

    // The rail is hidden while the panel is open; its outcome line is back once it closes.
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByTestId("rail-outcome"));
    expect(screen.getByRole("tab", { name: "Tests" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tests-view").textContent).toContain("typecheck");

    // The header's toggle reopens the panel on its list of views, never on
    // a view the reader did not choose; choosing Review opens it as a tab,
    // and the panel's own + opens another beside it.
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open side panel" }));
    expect(screen.queryByRole("region", { name: "Review changes" })).toBeNull();
    expect(screen.queryByTestId("panel-tabs")).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("panel-launcher")).getByRole("button", { name: "Review" }),
    );
    expect(screen.getByRole("region", { name: "Review changes" })).toBeTruthy();
    expect(screen.queryByTestId("panel-launcher")).toBeNull();
    pointerClick(screen.getByRole("button", { name: "Open another tab" }));
    pointerClick(await screen.findByRole("menuitem", { name: "Modal" }));
    expect(await screen.findByTestId("panel-modal")).toBeTruthy();
    const panes = () =>
      within(screen.getByTestId("panel-tabs"))
        .getAllByRole("button", { name: /^(Review|Modal)$/ })
        .map((pane) => pane.textContent);
    expect(panes()).toEqual(["Review", "Modal"]);
    expect(screen.queryByRole("tab")).toBeNull();

    // Back to Review, and switching its inner tabs keeps the panel where it is.
    fireEvent.click(screen.getByTestId("panel-tab-review"));
    expect(panes()).toEqual(["Review", "Modal"]);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Diff", "Tests"]);
    fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
    expect(screen.getByTestId("tests-view")).toBeTruthy();
  });

  it("returns to the list of views when the last tab closes, and hides only on Close panel", () => {
    renderScreen();
    fireEvent.click(screen.getByTestId("rail-changes"));
    expect(screen.getByRole("region", { name: "Review changes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Review tab" }));
    expect(screen.queryByRole("region", { name: "Review changes" })).toBeNull();
    expect(screen.getByTestId("panel-launcher")).toBeTruthy();
    // The panel is still open, so the rail stays hidden.
    expect(screen.queryByTestId("context-rail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByTestId("session-panel")).toBeNull();
    expect(screen.getByTestId("context-rail")).toBeTruthy();
  });

  it("hides the rail while the side panel is open, and restores it after", () => {
    renderScreen();
    expect(screen.getByTestId("context-rail")).toBeTruthy();
    expect(screen.getByTestId("rail-outcome")).toBeTruthy();

    fireEvent.click(screen.getByTestId("rail-changes"));
    expect(screen.queryByTestId("context-rail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByTestId("context-rail")).toBeTruthy();
    expect(screen.getByTestId("rail-outcome")).toBeTruthy();

    // The list of views and any pane hide it, not only Review; closing the
    // last tab returns to the list, so only the panel's close brings it back.
    fireEvent.click(screen.getByRole("button", { name: "Open side panel" }));
    expect(screen.queryByTestId("context-rail")).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("panel-launcher")).getByRole("button", { name: "Modal" }),
    );
    expect(screen.queryByTestId("context-rail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Modal tab" }));
    expect(screen.queryByTestId("context-rail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    expect(screen.getByTestId("context-rail")).toBeTruthy();
  });

  it("does not move the scroll when nothing was captured", () => {
    renderScreen();
    // No layout stub: every rect is empty, so there is no row to anchor to.
    fireEvent.click(screen.getByTestId("rail-changes"));
    expect(stick.scrollToBottom).not.toHaveBeenCalled();
  });
});

describe("the perf test's large review fixture", () => {
  it("is exactly as many lines as the panel still draws, in both scopes", () => {
    const view = foldEvents(largeReviewFixtureEvents(MAX_RENDERED_DIFF_LINES));
    for (const scope of ["turn", "session"] as const) {
      const diff = diffForScope(view, scope, null);
      expect(diff?.files).toHaveLength(10);
      expect(diff?.additions).toBe(MAX_RENDERED_DIFF_LINES);
      expect(diff === null ? null : diffBody(diff).kind).toBe("lines");
    }
    const over = foldEvents(largeReviewFixtureEvents(MAX_RENDERED_DIFF_LINES + 1));
    const diff = diffForScope(over, "session", null);
    expect(diff === null ? null : diffBody(diff).kind).toBe("too_large");
  });
});
