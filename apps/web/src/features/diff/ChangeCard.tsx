/**
 * The card at the end of a turn that changed files: "Edited N files", one row
 * per file, and a Review button. Built on AI Elements' Commit. It has no undo
 * control, since the bridge has no revert command.
 */
import type { DiffView, FileChange, RunId } from "@oncue/protocol";
import { ChevronDown, FileDiff } from "lucide-react";
import { useId, useState } from "react";
import {
  Commit,
  CommitContent,
  CommitFile,
  CommitFileChanges,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
} from "@/components/ai-elements/commit";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { filesWord, splitPath } from "./review-model";

/** The card shows this many files before "Show N more files". */
export const VISIBLE_FILES = 3;

/** A path with its directory dimmed, as the card and the panel both show it. */
export function DimmedPath({ path, className }: { path: string; className?: string }) {
  const { directory, name } = splitPath(path);
  return (
    <span className={cn("min-w-0 truncate", className)} title={path}>
      {directory.length === 0 ? null : <span className="text-muted-foreground">{directory}</span>}
      <span className="text-text">{name}</span>
    </span>
  );
}

/** `+N` in green and `-N` in red; the sign carries the meaning without the colour. */
export function ChangeCounts({
  additions,
  deletions,
  hideZero = false,
  className,
}: {
  additions: number;
  deletions: number;
  hideZero?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 font-mono tabular-nums", className)}>
      {hideZero && additions === 0 ? null : <span className="text-positive">+{additions}</span>}
      {hideZero && deletions === 0 ? null : <span className="text-danger">-{deletions}</span>}
    </span>
  );
}

function FileRow({
  file,
  onOpen,
}: {
  file: FileChange;
  onOpen?: ((path: string) => void) | undefined;
}) {
  const body = (
    <>
      <CommitFileInfo>
        <CommitFilePath className="font-sans text-[13px]">
          <DimmedPath path={file.path} />
        </CommitFilePath>
      </CommitFileInfo>
      <CommitFileChanges className="gap-1.5 text-[12px]">
        {/* Both counts on every row, zeros included, unlike the vendored parts. */}
        <ChangeCounts additions={file.additions} deletions={file.deletions} />
      </CommitFileChanges>
    </>
  );
  // A button only when it can open the diff, so nothing looks clickable that is not.
  return onOpen === undefined ? (
    <CommitFile className="rounded-none px-3 py-1.5 text-[13px]" data-testid="change-card-file">
      {body}
    </CommitFile>
  ) : (
    // A real button styled like the vendored row, since `CommitFile` renders a div.
    <button
      type="button"
      aria-label={`Review ${file.path}`}
      onClick={() => onOpen(file.path)}
      data-testid="change-card-file"
      className="flex w-full items-center justify-between gap-3 rounded-none px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
    >
      {body}
    </button>
  );
}

export function ChangeCard({
  runId,
  diff,
  onReview,
}: {
  runId: RunId;
  diff: DiffView;
  /** Opens the review on this run; with a `path`, on that file of it. */
  onReview?: ((runId: RunId, path?: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const visible = diff.files.slice(0, VISIBLE_FILES);
  const rest = diff.files.slice(VISIBLE_FILES);
  const openFile = onReview === undefined ? undefined : (path: string) => onReview(runId, path);

  // A turn that changed nothing has no card.
  if (diff.files.length === 0) {
    return null;
  }

  return (
    <Commit
      open={expanded}
      onOpenChange={setExpanded}
      data-testid="row-changes"
      className="my-2 overflow-hidden rounded-xl border-border bg-surface"
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground"
          aria-hidden="true"
        >
          <FileDiff className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="truncate font-medium text-[13px] text-text">
            Edited {filesWord(diff.files.length)}
          </p>
          <ChangeCounts
            additions={diff.additions}
            deletions={diff.deletions}
            className="text-[12px]"
          />
        </div>
        {onReview === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            aria-describedby={titleId}
            onClick={() => onReview(runId)}
            className="h-7 rounded-md border-border px-2.5 text-[12px] text-text"
          >
            Review
          </Button>
        )}
      </div>
      <div className="border-border border-t py-1">
        <CommitFiles className="space-y-0">
          {visible.map((file) => (
            <FileRow key={file.path} file={file} onOpen={openFile} />
          ))}
        </CommitFiles>
        {rest.length === 0 ? null : (
          <>
            <CommitContent className="border-t-0 p-0">
              <CommitFiles className="space-y-0">
                {rest.map((file) => (
                  <FileRow key={file.path} file={file} onOpen={openFile} />
                ))}
              </CommitFiles>
            </CommitContent>
            <CollapsibleTrigger
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-text"
              data-testid="change-card-more"
            >
              {expanded
                ? "Show fewer files"
                : `Show ${rest.length} more ${rest.length === 1 ? "file" : "files"}`}
              <ChevronDown
                className={cn("size-3.5 transition-transform", expanded ? "rotate-180" : "")}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          </>
        )}
      </div>
    </Commit>
  );
}
