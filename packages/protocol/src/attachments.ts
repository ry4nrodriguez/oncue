/**
 * What a person may attach to a message. The browser checks a file before
 * upload as a courtesy; the Worker checks the bytes again with the same
 * function, and that check is the boundary.
 *
 * The type comes from the bytes, never the name or declared content type:
 * four raster image formats and PDF by signature, and anything else must be
 * UTF-8 text without NUL, recorded as a plain text type. Nothing is ever
 * recorded as HTML, SVG, or script (`docs/decisions.md`).
 */

const MIB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
  /** One image. */
  imageBytes: 10 * MIB,
  /** One PDF or text file. */
  fileBytes: 5 * MIB,
  /** Attachments on one message. */
  perMessage: 10,
  /** Uploaded and not yet sent, per workspace. The sweep clears them after `unclaimedTtlMs`. */
  unclaimedPerWorkspace: 50,
  /** How long an upload no message claimed is kept. */
  unclaimedTtlMs: 24 * 60 * 60 * 1000,
  /** A display name's length, in UTF-16 code units. */
  nameChars: 128,
} as const;

/** The four raster formats an image attachment may be. No SVG: it is a document that can run script. */
export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** Every content type an attachment can be recorded under. */
export const ATTACHMENT_CONTENT_TYPES = [
  ...IMAGE_CONTENT_TYPES,
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

export type AttachmentKind = "image" | "file";

export function isImageContentType(contentType: string): contentType is ImageContentType {
  return (IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/** The text types a name's extension may pick. Any other text is `text/plain`. */
const TEXT_TYPE_BY_EXTENSION: Readonly<Record<string, AttachmentContentType>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/**
 * What the file picker offers: the image formats, PDF, and the text files a
 * coding task usually comes with. A hint to the picker only; the bytes decide.
 */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_CONTENT_TYPES,
  "application/pdf",
  "text/*",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".txt",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".ini",
  ".sql",
  ".diff",
  ".patch",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
].join(",");

export type AttachmentRefusal =
  | "empty"
  | "too_large"
  /** Not one of the four image formats, not a PDF, and not UTF-8 text. */
  | "unsupported_type";

export type SniffResult =
  | {
      readonly ok: true;
      readonly kind: AttachmentKind;
      readonly contentType: AttachmentContentType;
    }
  | { readonly ok: false; readonly reason: AttachmentRefusal };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[offset + index] === value);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

function imageTypeOf(bytes: Uint8Array): ImageContentType | null {
  if (startsWith(bytes, PNG)) {
    return "image/png";
  }
  if (startsWith(bytes, JPEG)) {
    return "image/jpeg";
  }
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) {
    return "image/gif";
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return "image/webp";
  }
  return null;
}

/** How many continuation bytes a UTF-8 lead byte announces, or -1 for a byte that cannot lead. */
function continuationCount(lead: number): number {
  if (lead < 0x80) {
    return 0;
  }
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 1;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 2;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 3;
  }
  return -1;
}

/**
 * Strict UTF-8 with no NUL byte, refusing overlong forms and surrogates as a
 * fatal decoder would. Written out because this package cannot assume
 * `TextDecoder` in every runtime it runs in.
 */
export function isUtf8Text(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] as number;
    if (lead === 0) {
      return false;
    }
    const count = continuationCount(lead);
    if (count < 0 || index + count >= bytes.length) {
      return false;
    }
    for (let offset = 1; offset <= count; offset += 1) {
      const next = bytes[index + offset] as number;
      if ((next & 0xc0) !== 0x80) {
        return false;
      }
    }
    const second = bytes[index + 1] as number;
    if (
      (lead === 0xe0 && second < 0xa0) ||
      (lead === 0xed && second > 0x9f) ||
      (lead === 0xf0 && second < 0x90) ||
      (lead === 0xf4 && second > 0x8f)
    ) {
      return false;
    }
    index += count + 1;
  }
  return true;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function limitFor(kind: AttachmentKind): number {
  return kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
}

/**
 * The attachment's kind and content type, from its bytes. `name` only picks
 * among the plain text types, so a file called `x.png` that is text is text,
 * and a PNG called `notes.txt` is an image.
 */
export function sniffAttachment(bytes: Uint8Array, name: string): SniffResult {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty" };
  }
  const image = imageTypeOf(bytes);
  const typed: { kind: AttachmentKind; contentType: AttachmentContentType } | null =
    image !== null
      ? { kind: "image", contentType: image }
      : startsWith(bytes, PDF)
        ? { kind: "file", contentType: "application/pdf" }
        : isUtf8Text(bytes)
          ? { kind: "file", contentType: TEXT_TYPE_BY_EXTENSION[extensionOf(name)] ?? "text/plain" }
          : null;
  if (typed === null) {
    return { ok: false, reason: "unsupported_type" };
  }
  if (bytes.length > limitFor(typed.kind)) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, ...typed };
}

/**
 * A name a person can read and nothing can misuse: the last path segment, no
 * control characters, at most `nameChars` long with its extension kept. It is
 * shown as text and offered as a download name, never used as a path.
 */
export function cleanAttachmentName(raw: string): string {
  const segment = raw.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
  const printable = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (printable.length === 0) {
    return "attachment";
  }
  if (printable.length <= ATTACHMENT_LIMITS.nameChars) {
    return printable;
  }
  const extension = extensionOf(printable);
  const suffix = extension.length > 0 && extension.length < 16 ? `.${extension}` : "";
  return `${printable.slice(0, ATTACHMENT_LIMITS.nameChars - suffix.length)}${suffix}`;
}

/** The words a refusal is shown in, on the composer's strip and in the Worker's answer. */
export const ATTACHMENT_REFUSAL_TEXT: Readonly<Record<AttachmentRefusal, string>> = {
  empty: "The file is empty.",
  too_large: `Images can be up to ${ATTACHMENT_LIMITS.imageBytes / MIB} MB and other files up to ${ATTACHMENT_LIMITS.fileBytes / MIB} MB.`,
  unsupported_type: "Only PNG, JPEG, GIF, and WebP images, PDFs, and text files can be attached.",
};
