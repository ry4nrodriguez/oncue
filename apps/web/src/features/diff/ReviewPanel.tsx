/**
 * The Review pane: a Diff tab and a Tests tab. It only changes local screen
 * state and never sends a command.
 */
import type { RunId, SessionView } from "@oncue/protocol";
import { ChevronDown, FolderTree } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useArtifactDownload } from "@/features/session/artifact-download";
import { TestsView } from "@/features/verification/TestsView";
import { fetchArtifact } from "@/lib/api/sessions";
import { cn } from "@/lib/utils";
import { ChangeCounts, DimmedPath } from "./ChangeCard";
import { ChangedFileTree } from "./ChangedFileTree";
import { DiffFileView } from "./DiffFileView";
import { FileContentView } from "./FileContentView";
import {
  diffBody,
  diffForScope,
  focusRunId,
  pathsChangedInSession,
  type ReviewScope,
  type ReviewTab,
  type ReviewTarget,
  SCOPE_LABELS,
  selectionShown,
} from "./review-model";

// "Diff", not "Review": the outer tab is Review, and a screen reader cannot tell
// apart two nested tabs of the same name.
const TABS: readonly { readonly tab: ReviewTab; readonly label: string }[] = [
  { tab: "review", label: "Diff" },
  { tab: "tests", label: "Tests" },
];

function TooLarge({
  sessionId,
  artifact,
}: {
  sessionId: string | null;
  artifact: { artifactId: string; label: string } | null;
}) {
  const { busy, unavailable, download } = useArtifactDownload(
    sessionId,
    artifact?.artifactId ?? "",
    artifact?.label ?? null,
  );
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b bg-surface px-3 py-2 text-[12px] text-muted-foreground"
      data-testid="diff-too-large"
    >
      <span>Diff too large to show here</span>
      {artifact === null ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="text-text underline underline-offset-2 hover:text-accent-text disabled:opacity-60"
        >
          Download diff
        </button>
      )}
      {unavailable ? (
        <span role="status" data-testid="artifact-unavailable" className="text-danger">
          Artifact unavailable
        </span>
      ) : null}
    </div>
  );
}

/** The lines of a tree listing artifact: one path each, blank lines dropped. */
export function parseTreeListing(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

/**
 * Every repository path at the diff's head, from the bridge's listing (record
 * 13). Empty while loading or on failure, when the tree shows changed files
 * only; `failed` says so and `retry` asks again.
 */
function useRepositoryPaths(
  sessionId: string | null,
  artifactId: string | null,
): { readonly paths: readonly string[]; readonly failed: boolean; readonly retry: () => void } {
  const [listing, setListing] = useState<
    | { readonly id: string; readonly paths: readonly string[] }
    | { readonly id: string; readonly failed: true }
    | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry's trigger
  useEffect(() => {
    if (sessionId === null || artifactId === null) {
      return;
    }
    let cancelled = false;
    const fail = () => {
      if (!cancelled) {
        setListing({ id: artifactId, failed: true });
      }
    };
    fetchArtifact(sessionId, artifactId).then(async (result) => {
      if (cancelled) {
        return;
      }
      if (result.kind !== "fetched") {
        fail();
        return;
      }
      try {
        const listed = parseTreeListing(await result.blob.text());
        if (!cancelled) {
          setListing({ id: artifactId, paths: listed });
        }
      } catch {
        fail();
      }
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [sessionId, artifactId, attempt]);
  const retry = useCallback(() => {
    setListing(null);
    setAttempt((current) => current + 1);
  }, []);
  const current = listing !== null && listing.id === artifactId ? listing : null;
  return {
    paths: current !== null && "paths" in current ? current.paths : EMPTY_PATHS,
    failed: current !== null && "failed" in current,
    retry,
  };
}

const EMPTY_PATHS: readonly string[] = [];

function ReviewBody({
  view,
  sessionId,
  scope,
  runId,
  focusPath,
  treeRef,
  onTreeHiddenChange,
}: {
  view: SessionView;
  sessionId: string | null;
  scope: ReviewScope;
  runId: RunId | null;
  /** The file to land on, when a change card named one. */
  focusPath: string | null;
  /** The tree's panel, so the header's folder button can bring it back. */
  treeRef: React.RefObject<PanelImperativeHandle | null>;
  onTreeHiddenChange: (hidden: boolean) => void;
}) {
  const diff = diffForScope(view, scope, runId);
  const body = useMemo(() => (diff === null ? null : diffBody(diff)), [diff]);
  const sections = useRef(new Map<string, HTMLElement>());
  const [selected, setSelected] = useState<string | null>(null);
  const listing = useRepositoryPaths(sessionId, diff?.tree?.artifactId ?? null);
  const changedInSession = useMemo(() => pathsChangedInSession(view), [view]);

  const jump = useCallback((path: string) => {
    setSelected(path);
    const section = sections.current.get(path);
    section?.scrollIntoView?.({ block: "start" });
    section?.focus({ preventScroll: true });
  }, []);

  // Scrolls from the section's ref callback because the resizable panel mounts
  // its children a tick late. `landed` limits it to once per target, since the
  // landing's own state update re-runs the ref callbacks.
  const landed = useRef<string | null>(null);
  const lastFocus = useRef<string | null>(focusPath);
  if (lastFocus.current !== focusPath) {
    lastFocus.current = focusPath;
    landed.current = null;
  }
  const register = useCallback(
    (path: string, element: HTMLElement | null) => {
      if (element === null) {
        sections.current.delete(path);
        return;
      }
      sections.current.set(path, element);
      if (focusPath === path && landed.current !== path) {
        landed.current = path;
        jump(path);
      }
    },
    [focusPath, jump],
  );

  if (diff === null || body === null) {
    return (
      <p className="p-4 text-[13px] text-muted-foreground" data-testid="review-empty">
        {scope === "session"
          ? "No changes recorded for this session yet."
          : "No changes recorded for this turn yet."}
      </p>
    );
  }

  const shown = selectionShown(changedInSession, diff, selected, sessionId !== null);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="review-diff" minSize="240px" className="flex min-w-0 flex-col">
        <div
          className="scroll-pill min-h-0 min-w-0 flex-1 overflow-y-auto"
          data-testid="review-diff-scroll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take focus so the diff scrolls from the keyboard (WCAG 2.1.1, axe's scrollable-region-focusable)
          tabIndex={0}
        >
          {shown.kind !== "note" ? null : (
            <p
              className="border-border-soft border-b px-4 py-2 text-[12px] text-muted-foreground"
              data-testid="review-unchanged-file"
            >
              <span className="font-mono text-text">{shown.path}</span>{" "}
              {shown.changedEarlier
                ? "is unchanged in this turn. All changes shows it."
                : "is unchanged in this session."}
            </p>
          )}
          {shown.kind === "base_file" && sessionId !== null ? (
            <FileContentView
              sessionId={sessionId}
              path={shown.path}
              onBack={() => setSelected(null)}
            />
          ) : body.kind === "too_large" ? (
            <>
              <TooLarge sessionId={sessionId} artifact={body.artifact} />
              <ul data-testid="diff-file-list">
                {diff.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-center justify-between gap-3 border-border-soft border-b px-3 py-1.5 text-[12px]"
                  >
                    <DimmedPath path={file.path} className="font-mono" />
                    <ChangeCounts additions={file.additions} deletions={file.deletions} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            diff.files.map((file) => (
              <DiffFileView
                key={file.path}
                change={file}
                parsed={body.files.get(file.path)}
                ref={(element) => register(file.path, element)}
              />
            ))
          )}
        </div>
      </ResizablePanel>
      {/* Dragging fully right collapses the tree; the header's folder button restores it. */}
      <ResizableHandle
        aria-label="Resize the file tree"
        className="w-px bg-border transition-colors after:w-2 hover:bg-hover-strong data-[resize-handle-active]:bg-hover-strong"
      />
      <ResizablePanel
        id="review-tree"
        panelRef={treeRef}
        collapsible
        collapsedSize="0px"
        minSize="150px"
        maxSize="60%"
        defaultSize="220px"
        // The collapsed flag lags an expand by a frame and the size is zero
        // without layout, so hidden requires both.
        onResize={(size) =>
          onTreeHiddenChange(size.inPixels === 0 && (treeRef.current?.isCollapsed() ?? false))
        }
        className="flex min-w-0 flex-col"
      >
        {listing.failed ? (
          <div
            role="status"
            data-testid="tree-listing-failed"
            className="flex flex-wrap items-center gap-x-2 border-border-soft border-b px-3 py-2 text-[12px] text-muted-foreground"
          >
            <span>Couldn't load the full file list. Showing changed files only.</span>
            <button
              type="button"
              onClick={listing.retry}
              className="text-text underline underline-offset-2 hover:text-accent-text"
            >
              Retry
            </button>
          </div>
        ) : null}
        <ChangedFileTree
          files={diff.files}
          allPaths={listing.paths}
          selectedPath={selected}
          onSelect={jump}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function ReviewPanel({
  view,
  sessionId,
  target,
  onTargetChange,
}: {
  view: SessionView;
  sessionId: string | null;
  target: ReviewTarget;
  onTargetChange: (target: ReviewTarget) => void;
}) {
  const baseId = useId();
  const treeRef = useRef<PanelImperativeHandle | null>(null);
  const [treeHidden, setTreeHidden] = useState(false);
  const diff = diffForScope(view, target.scope, target.runId);
  const panelId = `${baseId}-${target.tab}`;

  return (
    <section
      aria-label="Review changes"
      data-testid="review-panel"
      className="flex h-full min-w-0 flex-col bg-panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              id={`${baseId}-tab-${entry.tab}`}
              aria-selected={entry.tab === target.tab}
              aria-controls={entry.tab === target.tab ? panelId : undefined}
              onClick={() => onTargetChange({ ...target, tab: entry.tab })}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors",
                entry.tab === target.tab
                  ? "bg-hover text-text"
                  : "text-muted-foreground hover:bg-hover hover:text-text",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {target.tab === "review" ? (
          // Same row as the tabs, so the header is one line.
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
            {diff === null ? null : (
              <ChangeCounts
                additions={diff.additions}
                deletions={diff.deletions}
                className="text-[12px]"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Scope: ${SCOPE_LABELS[target.scope]}`}
                data-testid="review-scope"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-[12px] text-text transition-colors hover:bg-hover"
              >
                {SCOPE_LABELS[target.scope]}
                <ChevronDown className="size-3.5 text-faint" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[160px] border-border bg-popover p-1"
              >
                <DropdownMenuRadioGroup
                  value={target.scope}
                  onValueChange={(value) =>
                    onTargetChange({ ...target, scope: value as ReviewScope })
                  }
                >
                  {(["turn", "session"] as const).map((scope) => (
                    <DropdownMenuRadioItem
                      key={scope}
                      value={scope}
                      className="text-[13px] data-[highlighted]:bg-hover"
                    >
                      {SCOPE_LABELS[scope]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {treeHidden ? (
              <button
                type="button"
                aria-label="Show file tree"
                data-testid="review-show-tree"
                onClick={() => treeRef.current?.expand()}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
              >
                <FolderTree className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${baseId}-tab-${target.tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {target.tab === "tests" ? (
          <TestsView view={view} sessionId={sessionId} runId={focusRunId(view, target.runId)} />
        ) : (
          <ReviewBody
            view={view}
            sessionId={sessionId}
            scope={target.scope}
            runId={target.runId}
            focusPath={target.path ?? null}
            treeRef={treeRef}
            onTreeHiddenChange={setTreeHidden}
          />
        )}
      </div>
    </section>
  );
}
