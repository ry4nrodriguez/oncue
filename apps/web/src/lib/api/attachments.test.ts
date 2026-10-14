import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentUrl,
  discardAttachment,
  FILE_NAME_HEADER,
  parseUploaded,
  uploadAttachment,
  uploadFailureText,
} from "./attachments";

const REF = {
  artifactId: "att_1",
  kind: "file",
  contentType: "image/png",
  byteSize: 12,
  label: "a.png",
};

/** Just enough of XMLHttpRequest to drive one upload. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: unknown = null;
  status = 0;
  responseText = "";
  aborted = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadAttachment", () => {
  it("posts the raw file with its name, reports progress, and returns the Worker's record", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const file = new Blob(["x"]);
    const done = uploadAttachment({
      file,
      name: "screen shot.png",
      onProgress: (value) => progress.push(value),
    });
    const xhr = FakeXhr.last as FakeXhr;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/attachments");
    expect(xhr.headers[FILE_NAME_HEADER]).toBe("screen%20shot.png");
    expect(xhr.sent).toBe(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 } as ProgressEvent);
    xhr.answer(201, { attachment: REF });
    await expect(done).resolves.toEqual({ kind: "uploaded", ref: REF });
    expect(progress).toEqual([0.5]);
  });

  it("turns a refusal, a dropped connection, and a stop into words", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const refused = uploadAttachment({ file: new Blob(["x"]), name: "a", onProgress: () => {} });
    (FakeXhr.last as FakeXhr).answer(415, { error: "unsupported_type" });
    await expect(refused).resolves.toEqual({
      kind: "failed",
      message: "Only PNG, JPEG, GIF, and WebP images, PDFs, and text files can be attached.",
    });

    const garbled = uploadAttachment({ file: new Blob(["x"]), name: "a", onProgress: () => {} });
    (FakeXhr.last as FakeXhr).answer(201, "not json");
    await expect(garbled).resolves.toEqual({
      kind: "failed",
      message: "The file could not be attached.",
    });

    const dropped = uploadAttachment({ file: new Blob(["x"]), name: "a", onProgress: () => {} });
    (FakeXhr.last as FakeXhr).onerror?.();
    await expect(dropped).resolves.toEqual({
      kind: "failed",
      message: "The upload did not reach OnCue.",
    });

    const controller = new AbortController();
    const stopped = uploadAttachment({
      file: new Blob(["x"]),
      name: "a",
      onProgress: () => {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(stopped).resolves.toEqual({ kind: "failed", message: "The upload was stopped." });
  });
});

describe("parseUploaded and uploadFailureText", () => {
  it("accepts only a well-formed record", () => {
    expect(parseUploaded({ attachment: REF })).toEqual(REF);
    expect(parseUploaded({ attachment: { ...REF, kind: "image" } })).toBeNull();
    expect(parseUploaded({})).toBeNull();
    expect(parseUploaded(null)).toBeNull();
  });

  it("names the Worker's refusals, and falls back to a plain sentence", () => {
    expect(uploadFailureText(429, { error: "too_many_pending" })).toMatch(/Too many files/);
    expect(uploadFailureText(401, { error: "unauthenticated" })).toMatch(/Sign in again/);
    expect(uploadFailureText(413, { error: "too_large" })).toBe(
      "Images can be up to 10 MB and other files up to 5 MB.",
    );
    expect(uploadFailureText(500, { error: "something_else" })).toBe(
      "The file could not be attached.",
    );
    expect(uploadFailureText(0, null)).toBe("The upload did not reach OnCue.");
  });
});

describe("discardAttachment and attachmentUrl", () => {
  it("asks the Worker to forget an unsent upload, and never throws", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await discardAttachment("att/1");
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/att%2F1", { method: "DELETE" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(discardAttachment("att_1")).resolves.toBeUndefined();
  });

  it("builds the owner's address for a sent attachment", () => {
    expect(attachmentUrl("sess 1", "att_1")).toBe("/api/sessions/sess%201/attachments/att_1");
  });
});
