/**
 * Composer attachments inside the sandbox (docs/decisions.md). The bridge
 * fetches each file with its one-time token into a new 0700 directory under
 * `ATTACHMENTS_ROOT` (files 0600), then has the supervisor hand the directory
 * to the agent user, after which only the agent can read it. Images go to the
 * runtime as file parts when the model reads images; every attachment is also
 * listed by path in the prompt, and one that could not be fetched is named as
 * missing rather than dropped.
 */

import { pathToFileURL } from "node:url";
import { isImageContentType } from "@oncue/protocol";
import type { AttachmentFetch } from "./frames";

export interface PlacedAttachment {
  readonly fetch: AttachmentFetch;
  /** Where the agent reads it; null when it could not be fetched or written. */
  readonly path: string | null;
}

/** A file part OpenCode 1.18.30 accepts in `prompt_async`: a `file://` URL it reads as the agent. */
export interface PromptFilePart {
  readonly type: "file";
  readonly mime: string;
  readonly url: string;
  readonly filename: string;
}

/**
 * One path segment `isAttachmentDir` accepts (`PATH_SEGMENT_PATTERN`): the
 * message id's safe characters and a random suffix, so two sends never share
 * a directory.
 */
export function attachmentDirName(messageId: string, suffix: string): string {
  const base = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `m${base}-${suffix.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 128);
}

/**
 * A file name the bridge chooses, from the person's: numbered so two
 * attachments called the same never collide, and limited to characters no
 * shell or path treats specially. Never starts with a dot.
 */
export function attachmentFileName(index: number, name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return `${index + 1}-${cleaned.length === 0 ? "attachment" : cleaned}`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentPrompt {
  /** Appended to the prompt text after the person's own words. Empty with no attachments. */
  readonly note: string;
  readonly files: readonly PromptFilePart[];
}

/**
 * What OpenCode is told about the message's attachments. Pure. The note is
 * never part of the committed message: the timeline shows the person's words
 * and the thumbnails, and this is the agent's view of the same files.
 */
export function attachmentPrompt(
  placed: readonly PlacedAttachment[],
  imageInput: boolean,
): AttachmentPrompt {
  if (placed.length === 0) {
    return { note: "", files: [] };
  }
  const files: PromptFilePart[] = [];
  const lines: string[] = [];
  let unseenImage = false;
  for (const { fetch, path } of placed) {
    if (path === null) {
      lines.push(`- ${fetch.name}: could not be delivered to the sandbox.`);
      continue;
    }
    const facts = `${fetch.contentType}, ${sizeText(fetch.byteSize)}`;
    if (isImageContentType(fetch.contentType) && imageInput) {
      files.push({
        type: "file",
        mime: fetch.contentType,
        url: pathToFileURL(path).href,
        filename: fetch.name,
      });
      lines.push(`- ${path} (${facts}), "${fetch.name}", included above as an image.`);
    } else if (isImageContentType(fetch.contentType)) {
      unseenImage = true;
      lines.push(`- ${path} (${facts}), "${fetch.name}", an image.`);
    } else {
      lines.push(`- ${path} (${facts}), "${fetch.name}".`);
    }
  }
  const header =
    "The user attached these files. They are read-only and outside the repository; read them with your tools when they help.";
  const footer = unseenImage
    ? "\nThis model cannot view images. If an image matters to the task, tell the user you could not see it."
    : "";
  return { note: `\n\n${header}\n${lines.join("\n")}${footer}`, files };
}

export interface PlaceDeps {
  readonly root: string;
  readonly dirName: string;
  readonly download: (request: {
    readonly url: string;
    readonly token: string;
  }) => Promise<{ readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "failed" }>;
  readonly makeDir: (path: string) => Promise<void>;
  /** Creates a new file, mode 0600, failing if anything is already at the path. */
  readonly writeNew: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly handOver: (dir: string) => Promise<boolean>;
  readonly log: (line: string) => void;
}

/**
 * Fetches and places every attachment. Never throws: a fetch, a write, or the
 * handover that fails leaves that attachment (or all of them) unplaced, and
 * the prompt names what is missing. A size different from what the control
 * plane recorded is refused, so the file the agent reads is the one the person
 * uploaded.
 */
export async function placeAttachments(
  fetches: readonly AttachmentFetch[],
  deps: PlaceDeps,
): Promise<PlacedAttachment[]> {
  if (fetches.length === 0) {
    return [];
  }
  const dir = `${deps.root}/${deps.dirName}`;
  try {
    await deps.makeDir(dir);
  } catch {
    deps.log("bridge: could not make the attachments directory");
    return fetches.map((fetch) => ({ fetch, path: null }));
  }
  const placed: PlacedAttachment[] = [];
  for (const [index, fetch] of fetches.entries()) {
    const got = await deps.download({ url: fetch.url, token: fetch.token });
    if (got.kind !== "ok" || got.bytes.byteLength !== fetch.byteSize) {
      deps.log(`bridge: attachment ${index + 1} could not be fetched`);
      placed.push({ fetch, path: null });
      continue;
    }
    const path = `${dir}/${attachmentFileName(index, fetch.name)}`;
    try {
      await deps.writeNew(path, got.bytes);
      placed.push({ fetch, path });
    } catch {
      deps.log(`bridge: attachment ${index + 1} could not be written`);
      placed.push({ fetch, path: null });
    }
  }
  if (!(await deps.handOver(dir))) {
    deps.log("bridge: could not hand the attachments to the agent");
    return fetches.map((fetch) => ({ fetch, path: null }));
  }
  return placed;
}
