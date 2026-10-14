/**
 * The browser's side of composer attachments (docs/decisions.md). Uploads use
 * `XMLHttpRequest` rather than `fetch` because it reports upload progress. The
 * file is the raw body with its name percent-encoded in a header; the Worker
 * decides its type from the bytes.
 */

import { type ArtifactRef, ATTACHMENT_REFUSAL_TEXT } from "@oncue/protocol";

/** The Worker's header for the file's name (`FILE_NAME_HEADER` in worker/attachments/routes.ts). */
export const FILE_NAME_HEADER = "x-oncue-file-name";

export type UploadResult =
  | { readonly kind: "uploaded"; readonly ref: ArtifactRef }
  | { readonly kind: "failed"; readonly message: string };

export interface UploadRequest {
  readonly file: Blob;
  readonly name: string;
  /** From 0 to 1, as the bytes leave the browser. */
  readonly onProgress: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

export type Uploader = (request: UploadRequest) => Promise<UploadResult>;
export type Discarder = (attachmentId: string) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  ...ATTACHMENT_REFUSAL_TEXT,
  too_many_pending: "Too many files are waiting to be sent. Send or remove some first.",
  unauthenticated: "Your sign-in has expired. Sign in again to attach files.",
  attachment_storage_unavailable: "File storage is not available right now.",
};

/** A refusal in words a person can act on. Pure. */
export function uploadFailureText(status: number, body: unknown): string {
  const error = isRecord(body) && typeof body.error === "string" ? body.error : null;
  if (error !== null && FAILURE_TEXT[error] !== undefined) {
    return FAILURE_TEXT[error] as string;
  }
  return status === 0 ? "The upload did not reach OnCue." : "The file could not be attached.";
}

/** The Worker's 201 body, checked. Pure. */
export function parseUploaded(body: unknown): ArtifactRef | null {
  const attachment = isRecord(body) ? body.attachment : null;
  if (
    !isRecord(attachment) ||
    typeof attachment.artifactId !== "string" ||
    attachment.kind !== "file" ||
    typeof attachment.contentType !== "string" ||
    typeof attachment.byteSize !== "number" ||
    typeof attachment.label !== "string"
  ) {
    return null;
  }
  return attachment as unknown as ArtifactRef;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const uploadAttachment: Uploader = (request) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments");
    xhr.setRequestHeader(FILE_NAME_HEADER, encodeURIComponent(request.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        request.onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      const ref = xhr.status === 201 ? parseUploaded(body) : null;
      resolve(
        ref === null
          ? { kind: "failed", message: uploadFailureText(xhr.status, body) }
          : { kind: "uploaded", ref },
      );
    };
    xhr.onerror = () => resolve({ kind: "failed", message: uploadFailureText(0, null) });
    xhr.onabort = () => resolve({ kind: "failed", message: "The upload was stopped." });
    request.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(request.file);
  });

/** Best effort: an upload nobody sends is swept after a day anyway. */
export const discardAttachment: Discarder = async (attachmentId) => {
  try {
    await fetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
  } catch {
    // The sweep removes it.
  }
};

/** Where a sent attachment is shown from: inline for an image, a download for anything else. */
export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
