/**
 * The composer's attachments above the message box, each with remove, upload
 * progress, and any failure. Images open in the viewer from their local copy.
 */

import { AlertCircle, FileText, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { AttachmentViewer } from "./AttachmentViewer";
import type { ComposerAttachment } from "./use-attachments";

export interface AttachmentStripProps {
  readonly items: readonly ComposerAttachment[];
  readonly notice: string | null;
  readonly onRemove: (localId: string) => void;
  readonly disabled?: boolean;
}

function Progress({ item }: { readonly item: ComposerAttachment }) {
  if (item.status !== "uploading") {
    return null;
  }
  const percent = Math.round(item.progress * 100);
  return (
    <span
      role="progressbar"
      aria-label={`Uploading ${item.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-black/25"
    >
      <span
        className="block h-full bg-accent transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

function RemoveButton({
  item,
  onRemove,
  disabled,
}: {
  readonly item: ComposerAttachment;
  readonly onRemove: (localId: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${item.name}`}
      disabled={disabled}
      onClick={() => onRemove(item.localId)}
      className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-text disabled:opacity-60"
    >
      <X className="size-3" aria-hidden="true" />
    </button>
  );
}

export function AttachmentStrip({
  items,
  notice,
  onRemove,
  disabled = false,
}: AttachmentStripProps) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (items.length === 0 && notice === null) {
    return null;
  }
  const images = items.filter((item) => item.previewUrl !== null);
  return (
    <div data-testid="composer-attachments" className="pb-2">
      <ul className="flex flex-wrap gap-2" aria-label="Attachments">
        {items.map((item) => {
          const failed = item.status === "failed";
          const imageIndex = images.findIndex((image) => image.localId === item.localId);
          return (
            <li
              key={item.localId}
              data-testid="composer-attachment"
              data-status={item.status}
              className="relative"
              title={failed ? (item.error ?? undefined) : item.name}
            >
              {item.previewUrl !== null ? (
                <button
                  type="button"
                  aria-label={`View ${item.name}`}
                  onClick={() => setViewing(imageIndex)}
                  className={cn(
                    "block size-14 overflow-hidden rounded-lg border bg-strip",
                    failed ? "border-danger" : "border-border",
                  )}
                >
                  <img src={item.previewUrl} alt="" className="size-full object-cover" />
                </button>
              ) : (
                <span
                  className={cn(
                    "flex h-14 max-w-[220px] items-center gap-2 rounded-lg border bg-surface px-2.5",
                    failed ? "border-danger" : "border-border",
                  )}
                >
                  {failed ? (
                    <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden="true" />
                  ) : (
                    <FileText
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 truncate text-[12.5px] text-text">{item.name}</span>
                </span>
              )}
              <Progress item={item} />
              <RemoveButton item={item} onRemove={onRemove} disabled={disabled} />
            </li>
          );
        })}
      </ul>
      {items.map((item) =>
        item.status === "failed" ? (
          <p
            key={item.localId}
            role="alert"
            data-testid="composer-attachment-error"
            className="mt-1.5 text-[12.5px] text-danger"
          >
            {`${item.name}: ${item.error ?? "could not be attached."}`}
          </p>
        ) : null,
      )}
      {notice === null ? null : (
        <p
          role="status"
          data-testid="composer-attachments-notice"
          className="mt-1.5 text-[12.5px] text-danger"
        >
          {notice}
        </p>
      )}
      <AttachmentViewer
        images={images.map((image) => ({ url: image.previewUrl as string, name: image.name }))}
        index={viewing}
        onIndexChange={setViewing}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}
