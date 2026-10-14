/**
 * The larger view of a message's images, one at a time. Built on the dialog
 * primitive so focus moves in, stays trapped, and returns to the thumbnail.
 */

import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface ViewerImage {
  readonly url: string;
  readonly name: string;
}

export interface AttachmentViewerProps {
  readonly images: readonly ViewerImage[];
  /** The image shown, or null when the viewer is closed. */
  readonly index: number | null;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}

const ROUND_BUTTON =
  "flex size-9 items-center justify-center rounded-full bg-background/90 text-text shadow-sm ring-1 ring-border transition-colors hover:bg-hover disabled:opacity-40";

export function AttachmentViewer({ images, index, onIndexChange, onClose }: AttachmentViewerProps) {
  const open = index !== null && images[index] !== undefined;
  const current = open ? (images[index] as ViewerImage) : null;
  const many = images.length > 1;
  const at = index ?? 0;
  const previous = () => onIndexChange((at - 1 + images.length) % images.length);
  const next = () => onIndexChange((at + 1) % images.length);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!many) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      previous();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        data-testid="attachment-viewer"
        onKeyDown={onKeyDown}
        className="flex max-h-[92vh] w-[min(92vw,1100px)] max-w-none flex-col gap-3 p-3 sm:p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="truncate font-medium text-[14px]">{current?.name}</DialogTitle>
            <DialogDescription className="text-[12px]">
              {many ? `Image ${at + 1} of ${images.length}` : "Image"}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {current === null ? null : (
              <a
                href={current.url}
                download={current.name}
                aria-label={`Download ${current.name}`}
                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-text transition-colors hover:bg-hover"
              >
                <Download className="size-3.5" aria-hidden="true" />
                Download
              </a>
            )}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        {/* A fixed stage, so the viewer is the same size whichever image it shows. */}
        <div className="relative flex h-[min(70vh,760px)] items-center justify-center overflow-hidden rounded-md bg-strip">
          {current === null ? null : (
            <img
              src={current.url}
              alt={current.name}
              data-testid="attachment-viewer-image"
              className="max-h-full max-w-full object-contain"
            />
          )}
          {many ? (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={previous}
                className={`${ROUND_BUTTON} absolute left-2`}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={next}
                className={`${ROUND_BUTTON} absolute right-2`}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
