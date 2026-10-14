import { describe, expect, it } from "vitest";
import {
  downloadFileAtCommit,
  encodeRepositoryPath,
  MAX_DOWNLOAD_BYTES,
  MAX_PREVIEW_BYTES,
  readFileAtCommit,
} from "./file-at-commit";

const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const TOKEN = "ghs_file_read_token";

/** A fetch that records what it was asked and answers `answer`. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), headers: new Headers(init?.headers) });
    return answer();
  }) as typeof fetch;
  return { deps: { fetchImpl, apiOrigin: "https://github.double" }, asked };
}

const rejecting = {
  deps: {
    fetchImpl: (async () => {
      throw new TypeError("network down");
    }) as typeof fetch,
    apiOrigin: "https://github.double",
  },
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fileJson(bytes: Uint8Array, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    type: "file",
    size: bytes.byteLength,
    encoding: "base64",
    content: `${(base64(bytes).match(/.{1,60}/g) ?? []).join("\n")}\n`,
    ...overrides,
  });
}

describe("encodeRepositoryPath", () => {
  it("escapes each segment and keeps the slashes", () => {
    expect(encodeRepositoryPath("docs/a b/c#d?.md")).toBe("docs/a%20b/c%23d%3F.md");
  });
});

describe("readFileAtCommit", () => {
  const read = (deps: Parameters<typeof readFileAtCommit>[0], path = "src/app.ts") =>
    readFileAtCommit(deps, TOKEN, "acme/widgets", SHA, path);

  it("reads the file at the commit under the bearer, with the path escaped", async () => {
    const bytes = new TextEncoder().encode("export const answer = 42;\n");
    const { deps, asked } = fakeFetch(() => fileJson(bytes));
    expect(await read(deps, "src/my file.ts")).toEqual({ kind: "file", bytes });
    expect(asked[0]?.url).toBe(
      `https://github.double/repos/acme/widgets/contents/src/my%20file.ts?ref=${SHA}`,
    );
    expect(asked[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("is unreachable when the fetch rejects", async () => {
    expect(await read(rejecting.deps)).toEqual({ kind: "failed", category: "unreachable" });
  });

  it("is not_found on 404 and rejected on any other status", async () => {
    expect(await read(fakeFetch(() => new Response("", { status: 404 })).deps)).toEqual({
      kind: "not_found",
    });
    expect(await read(fakeFetch(() => new Response("", { status: 403 })).deps)).toEqual({
      kind: "failed",
      category: "rejected",
    });
  });

  it("is a directory for GitHub's array answer", async () => {
    expect(await read(fakeFetch(() => Response.json([])).deps)).toEqual({
      kind: "not_a_file",
      type: "directory",
    });
  });

  it.each([
    ["symlink", "symlink"],
    ["submodule", "submodule"],
    ["dir", "other"],
  ])("is not a file for type %s, and nothing is followed", async (type, expected) => {
    expect(await read(fakeFetch(() => Response.json({ type, size: 0 })).deps)).toEqual({
      kind: "not_a_file",
      type: expected,
    });
  });

  it.each([
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["JSON that is not an object", () => Response.json("text")],
    ["a missing size", () => Response.json({ type: "file", encoding: "base64", content: "" })],
    ["a fractional size", () => fileJson(new Uint8Array([1]), { size: 1.5 })],
    ["a negative size", () => fileJson(new Uint8Array([1]), { size: -1 })],
    ["no base64 encoding", () => fileJson(new Uint8Array([1]), { encoding: "none" })],
    ["content that is not a string", () => fileJson(new Uint8Array([1]), { content: 7 })],
    ["content that is not base64", () => fileJson(new Uint8Array([1]), { content: "!!!" })],
    ["a size the bytes disagree with", () => fileJson(new Uint8Array([1, 2]), { size: 3 })],
  ])("is malformed for %s", async (_what, answer) => {
    expect(await read(fakeFetch(answer).deps)).toEqual({ kind: "failed", category: "malformed" });
  });

  it("is too_large past 1 MiB, from the size alone", async () => {
    const { deps } = fakeFetch(() =>
      Response.json({ type: "file", size: MAX_PREVIEW_BYTES + 1, encoding: "none", content: "" }),
    );
    expect(await read(deps)).toEqual({ kind: "too_large", size: MAX_PREVIEW_BYTES + 1 });
  });

  it("reads an empty file and a binary one as their bytes", async () => {
    expect(await read(fakeFetch(() => fileJson(new Uint8Array())).deps)).toEqual({
      kind: "file",
      bytes: new Uint8Array(),
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
    expect(await read(fakeFetch(() => fileJson(png)).deps)).toEqual({ kind: "file", bytes: png });
  });
});

describe("downloadFileAtCommit", () => {
  const fetchFile = (deps: Parameters<typeof downloadFileAtCommit>[0]) =>
    downloadFileAtCommit(deps, TOKEN, "acme/widgets", SHA, "assets/big.bin");

  it("asks for the raw bytes and reads them whole", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { deps, asked } = fakeFetch(
      () => new Response(bytes, { headers: { "content-length": "3" } }),
    );
    expect(await fetchFile(deps)).toEqual({ kind: "file", bytes });
    expect(asked[0]?.headers.get("accept")).toBe("application/vnd.github.raw");
    expect(asked[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("reads a body that declares no length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9]));
        controller.close();
      },
    });
    const { deps } = fakeFetch(() => new Response(stream));
    expect(await fetchFile(deps)).toEqual({ kind: "file", bytes: new Uint8Array([9]) });
  });

  it("is unreachable, not_found, or rejected as the contents read is", async () => {
    expect(await fetchFile(rejecting.deps)).toEqual({ kind: "failed", category: "unreachable" });
    expect(await fetchFile(fakeFetch(() => new Response("", { status: 404 })).deps)).toEqual({
      kind: "not_found",
    });
    expect(await fetchFile(fakeFetch(() => new Response("", { status: 502 })).deps)).toEqual({
      kind: "failed",
      category: "rejected",
    });
  });

  it("refuses past 20 MiB from the declared length, without reading the body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { deps } = fakeFetch(
      () => new Response(stream, { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } }),
    );
    expect(await fetchFile(deps)).toEqual({ kind: "too_large" });
    expect(cancelled).toBe(true);
  });

  it("refuses a declared length past the limit even with no body to cancel", async () => {
    const { deps } = fakeFetch(() => {
      const response = new Response(null, { status: 200 });
      response.headers.set("content-length", String(MAX_DOWNLOAD_BYTES + 1));
      return response;
    });
    expect(await fetchFile(deps)).toEqual({ kind: "too_large" });
  });

  it("refuses a body past the limit that declared less", async () => {
    const { deps } = fakeFetch(() => new Response(new Uint8Array(MAX_DOWNLOAD_BYTES + 1)));
    expect(await fetchFile(deps)).toEqual({ kind: "too_large" });
  });
});
