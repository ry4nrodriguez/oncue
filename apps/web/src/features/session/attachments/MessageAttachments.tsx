/**
 * A sent message's attachments on the timeline, served by the Worker to the
 * session's owner alone (`attachmentUrl`).
 */

import { type ArtifactRef, isImageContentType } from "@oncue/protocol";
import { FileText } from "lucide-react";
import { useState } from "react";
import { attachmentUrl } from "@/lib/api/attachments";
import { AttachmentViewer } from "./AttachmentViewer";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageAttachments({
  sessionId,
  attachments,
}: {
  readonly sessionId: string;
  readonly attachments: readonly ArtifactRef[];
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (attachments.length === 0) {
    return null;
  }
  const images = attachments.filter((ref) => isImageContentType(ref.contentType));
  const files = attachments.filter((ref) => !isImageContentType(ref.contentType));
  return (
    <div data-testid="message-attachments" className="flex flex-col items-end gap-1.5">
      {images.length === 0 ? null : (
        <ul className="flex flex-wrap justify-end gap-1.5" aria-label="Attached images">
          {images.map((ref, index) => (
            <li key={ref.artifactId}>
              <button
                type="button"
                aria-label={`View ${ref.label}`}
                data-testid="message-attachment-image"
                onClick={() => setViewing(index)}
                className="block size-20 overflow-hidden rounded-lg border border-border bg-strip transition-opacity hover:opacity-90"
              >
                <img
                  src={attachmentUrl(sessionId, ref.artifactId)}
                  alt={ref.label}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length === 0 ? null : (
        <ul className="flex flex-wrap justify-end gap-1.5" aria-label="Attached files">
          {files.map((ref) => (
            <li key={ref.artifactId}>
              <a
                href={attachmentUrl(sessionId, ref.artifactId)}
                download={ref.label}
                data-testid="message-attachment-file"
                aria-label={`Download ${ref.label}`}
                className="flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 transition-colors hover:bg-hover"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 truncate text-[12.5px] text-text">{ref.label}</span>
                <span className="shrink-0 text-[11.5px] text-faint">
                  {formatBytes(ref.byteSize)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <AttachmentViewer
        images={images.map((ref) => ({
          url: attachmentUrl(sessionId, ref.artifactId),
          name: ref.label,
        }))}
        index={viewing}
        onIndexChange={setViewing}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}
