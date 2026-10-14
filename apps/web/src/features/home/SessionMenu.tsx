/**
 * A session's options (records 10 and 19): archive or restore, and delete.
 * The sidebar row and the session screen share it, so both say the same
 * thing. Deleting always asks first and says plainly what is erased and what
 * stays on GitHub; archiving asks only when a run is still open, because it
 * cancels that run.
 */

import { Archive, ArchiveRestore, Ellipsis, Trash2 } from "lucide-react";
import { useState } from "react";
import { DANGER_ACTION, NEUTRAL_BUTTON, ROW_ACTION } from "@/components/ui/button-classes";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import { useSessionListActions } from "./session-list";
import { useSidebarMenu } from "./sidebar-menu";

export const DELETE_COPY =
  "This erases the conversation, diffs, logs, attachments, and artifacts stored in OnCue, and stops its sandbox. It can't be undone. The GitHub branch and any pull request stay on GitHub.";

export const ARCHIVE_RUN_OPEN_COPY =
  "A run is still working. Archiving cancels it, saves the sandbox's work with a checkpoint, and stops the sandbox. The session moves to Archived, where you can read it and restore it.";

const MENU_ITEM = "flex items-center gap-2 px-2.5 py-1.5 text-[13px] data-[highlighted]:bg-hover";

type Open = null | "delete" | "archive";

export function SessionMenu({
  sessionId,
  title,
  archived,
  runOpen,
  triggerClassName,
}: {
  sessionId: string;
  title: string;
  archived: boolean;
  /** The list's view of the current run; the server has the last word (`run_open`). */
  runOpen: boolean;
  triggerClassName?: string | undefined;
}) {
  const actions = useSessionListActions();
  const menu = useSidebarMenu();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(next: Open, message: string | null = null) {
    setError(message);
    setOpen(next);
  }

  /** Escape and the backdrop do nothing while a request is in flight, so its answer has somewhere to land. */
  function settle(next: Open) {
    if (!busy) {
      show(next);
    }
  }

  async function archive(cancelOpenRun: boolean) {
    setBusy(true);
    const outcome = await actions.archive(sessionId, cancelOpenRun);
    setBusy(false);
    if (outcome.kind === "done") {
      setOpen(null);
    } else {
      show("archive", outcome.kind === "error" ? outcome.message : null);
    }
  }

  async function unarchive() {
    const message = await actions.unarchive(sessionId);
    if (message !== null) {
      show("archive", message);
    }
  }

  async function remove() {
    setBusy(true);
    const message = await actions.remove(sessionId);
    setBusy(false);
    if (message === null) {
      setOpen(null);
    } else {
      setError(message);
    }
  }

  function chooseArchive() {
    if (archived) {
      void unarchive();
    } else if (runOpen) {
      show("archive");
    } else {
      void archive(false);
    }
  }

  return (
    <>
      <DropdownMenu {...menu.rootProps}>
        <DropdownMenuTrigger
          {...menu.triggerProps}
          aria-label={`Options for ${title}`}
          data-testid="session-menu"
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover-strong hover:text-text",
            triggerClassName,
          )}
        >
          <Ellipsis className="size-[15px]" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          {...menu.contentProps}
          align="end"
          className="w-[180px] border-border bg-popover p-1.5 shadow-xl"
        >
          <DropdownMenuItem className={MENU_ITEM} onClick={chooseArchive}>
            {archived ? (
              <ArchiveRestore className="size-[15px] text-muted-foreground" aria-hidden="true" />
            ) : (
              <Archive className="size-[15px] text-muted-foreground" aria-hidden="true" />
            )}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem className={cn(MENU_ITEM, "text-danger")} onClick={() => show("delete")}>
            <Trash2 className="size-[15px]" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open === "delete"} onOpenChange={(next) => settle(next ? "delete" : null)}>
        <DialogContent className="max-w-md" data-testid="delete-session-dialog">
          <DialogHeader>
            <DialogTitle className="font-semibold text-[15px] text-text">
              Delete “{title}”?
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground leading-6">
              {DELETE_COPY}
            </DialogDescription>
          </DialogHeader>
          {error === null ? null : (
            <p className={cn("mt-3 text-[12px]", TONE_TEXT_CLASS.danger)} role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <DialogClose className={ROW_ACTION}>Keep it</DialogClose>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              data-testid="delete-session-confirm"
              className={cn(DANGER_ACTION, "px-3 py-1.5 text-[12px]")}
            >
              {busy ? "Deleting…" : "Delete session"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "archive"} onOpenChange={(next) => settle(next ? "archive" : null)}>
        <DialogContent className="max-w-md" data-testid="archive-session-dialog">
          <DialogHeader>
            <DialogTitle className="font-semibold text-[15px] text-text">
              {error === null
                ? "Archive while a run is working?"
                : archived
                  ? "Couldn't restore this session"
                  : "Couldn't archive this session"}
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground leading-6">
              {error ?? ARCHIVE_RUN_OPEN_COPY}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <DialogClose className={ROW_ACTION}>
              {error === null ? "Keep working" : "Close"}
            </DialogClose>
            {error === null ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void archive(true)}
                data-testid="archive-session-confirm"
                className={cn(NEUTRAL_BUTTON, "px-3 py-1.5 text-[12px]")}
              >
                {busy ? "Archiving…" : "Cancel the run and archive"}
              </button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
