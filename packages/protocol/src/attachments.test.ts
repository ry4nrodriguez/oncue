import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_REFUSAL_TEXT,
  cleanAttachmentName,
  isImageContentType,
  isUtf8Text,
  limitFor,
  sniffAttachment,
} from "./attachments";
import { parseCommandPayload } from "./commands";

/** UTF-8 by hand: this package's tests, like its source, assume no Node and no DOM. */
function utf8(value: string): number[] {
  const out: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const GIF87 = [...utf8("GIF87a"), 1, 0];
const GIF89 = [...utf8("GIF89a"), 1, 0];
const WEBP = [...utf8("RIFF"), 8, 0, 0, 0, ...utf8("WEBPVP8 ")];
const PDF = [...utf8("%PDF-1.7\n")];

function bytes(values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

function text(value: string): Uint8Array {
  return new Uint8Array(utf8(value));
}

describe("sniffAttachment", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif87a", GIF87, "image/gif"],
    ["gif89a", GIF89, "image/gif"],
    ["webp", WEBP, "image/webp"],
  ])("recognises a %s by its signature, whatever it is called", (_name, signature, type) => {
    expect(sniffAttachment(bytes(signature), "notes.txt")).toEqual({
      ok: true,
      kind: "image",
      contentType: type,
    });
  });

  it("recognises a PDF by its signature", () => {
    expect(sniffAttachment(bytes(PDF), "spec.txt")).toEqual({
      ok: true,
      kind: "file",
      contentType: "application/pdf",
    });
  });

  it("records text under a text type its extension picks, and plain text otherwise", () => {
    const body = text("# Title\n");
    expect(sniffAttachment(body, "README.md")).toMatchObject({ contentType: "text/markdown" });
    expect(sniffAttachment(body, "notes.MARKDOWN")).toMatchObject({
      contentType: "text/markdown",
    });
    expect(sniffAttachment(body, "rows.csv")).toMatchObject({ contentType: "text/csv" });
    expect(sniffAttachment(body, "data.json")).toMatchObject({ contentType: "application/json" });
    expect(sniffAttachment(body, "main.ts")).toMatchObject({
      kind: "file",
      contentType: "text/plain",
    });
    expect(sniffAttachment(body, "Makefile")).toMatchObject({ contentType: "text/plain" });
    expect(sniffAttachment(body, ".env")).toMatchObject({ contentType: "text/plain" });
  });

  it("never records markup as anything but plain text", () => {
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffAttachment(svg, "picture.svg")).toMatchObject({
      kind: "file",
      contentType: "text/plain",
    });
    expect(sniffAttachment(text("<html></html>"), "page.html")).toMatchObject({
      contentType: "text/plain",
    });
  });

  it("refuses an empty file", () => {
    expect(sniffAttachment(new Uint8Array(0), "a.txt")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses binary that is none of the accepted types", () => {
    expect(sniffAttachment(bytes([0x7f, 0x45, 0x4c, 0x46, 0, 1]), "tool")).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
    expect(
      sniffAttachment(bytes([...utf8("RIFF"), 0, 0, 0, 0, ...utf8("WAVE")]), "a.webp"),
    ).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
  });

  it("holds an image to the image limit and every other file to the file limit", () => {
    const bigImage = new Uint8Array(ATTACHMENT_LIMITS.imageBytes + 1);
    bigImage.set(PNG);
    expect(sniffAttachment(bigImage, "a.png")).toEqual({ ok: false, reason: "too_large" });
    const atImageLimit = new Uint8Array(ATTACHMENT_LIMITS.imageBytes);
    atImageLimit.set(PNG);
    expect(sniffAttachment(atImageLimit, "a.png")).toMatchObject({ ok: true });
    const bigText = new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1).fill(0x61);
    expect(sniffAttachment(bigText, "a.txt")).toEqual({ ok: false, reason: "too_large" });
    expect(limitFor("image")).toBe(ATTACHMENT_LIMITS.imageBytes);
    expect(limitFor("file")).toBe(ATTACHMENT_LIMITS.fileBytes);
  });
});

describe("isUtf8Text", () => {
  it("accepts ASCII and every width of UTF-8", () => {
    expect(isUtf8Text(text("plain"))).toBe(true);
    expect(isUtf8Text(text("café ✓ 𝄞"))).toBe(true);
  });

  it.each([
    ["a NUL byte", [0x61, 0x00, 0x62]],
    ["a lone continuation byte", [0x80]],
    ["an overlong two-byte lead", [0xc0, 0x80]],
    ["a truncated sequence", [0xe2, 0x82]],
    ["a bad continuation", [0xe2, 0x28, 0xa1]],
    ["an overlong three-byte form", [0xe0, 0x80, 0x80]],
    ["a surrogate", [0xed, 0xa0, 0x80]],
    ["an overlong four-byte form", [0xf0, 0x80, 0x80, 0x80]],
    ["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["a byte that cannot lead", [0xff]],
  ])("refuses %s", (_name, values) => {
    expect(isUtf8Text(bytes(values))).toBe(false);
  });
});

describe("cleanAttachmentName", () => {
  it("keeps the last path segment and drops control characters", () => {
    expect(cleanAttachmentName("C:\\Users\\me\\shot.png")).toBe("shot.png");
    expect(cleanAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(cleanAttachmentName("a\u0000b\nc.txt")).toBe("abc.txt");
  });

  it("names a file with nothing printable 'attachment'", () => {
    expect(cleanAttachmentName("   ")).toBe("attachment");
    expect(cleanAttachmentName("dir/")).toBe("attachment");
  });

  it("shortens a long name and keeps a short extension", () => {
    const long = `${"x".repeat(300)}.png`;
    const cleaned = cleanAttachmentName(long);
    expect(cleaned).toHaveLength(ATTACHMENT_LIMITS.nameChars);
    expect(cleaned.endsWith(".png")).toBe(true);
    const noExtension = "y".repeat(300);
    expect(cleanAttachmentName(noExtension)).toBe("y".repeat(ATTACHMENT_LIMITS.nameChars));
    const longExtension = `a.${"z".repeat(200)}`;
    expect(cleanAttachmentName(longExtension)).toHaveLength(ATTACHMENT_LIMITS.nameChars);
  });
});

describe("isImageContentType", () => {
  it("is true for the four raster formats only", () => {
    expect(isImageContentType("image/webp")).toBe(true);
    expect(isImageContentType("image/svg+xml")).toBe(false);
    expect(isImageContentType("text/plain")).toBe(false);
  });
});

describe("the refusal text", () => {
  it("names the limits", () => {
    expect(ATTACHMENT_REFUSAL_TEXT.too_large).toBe(
      "Images can be up to 10 MB and other files up to 5 MB.",
    );
  });
});

describe("a message's attachment count", () => {
  const ref = (index: number) => ({
    artifactId: `att_${index}`,
    kind: "file",
    contentType: "image/png",
    byteSize: 10,
    label: "a.png",
  });

  it("allows the per-message limit and refuses one more", () => {
    const payload = (count: number) => ({
      messageId: "msg_1",
      text: "look",
      attachments: Array.from({ length: count }, (_value, index) => ref(index)),
      delivery: "steer_current_run",
    });
    expect(parseCommandPayload("run.follow_up", payload(ATTACHMENT_LIMITS.perMessage)).ok).toBe(
      true,
    );
    expect(parseCommandPayload("run.follow_up", payload(ATTACHMENT_LIMITS.perMessage + 1)).ok).toBe(
      false,
    );
  });
});
