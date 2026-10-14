/**
 * One file of a repository at one commit, read by the control plane for the
 * review panel's unchanged files (record 13), under a `contents: read` token
 * narrowed to the repository and revoked afterwards. No sandbox is needed.
 * The bytes are untrusted: size is checked before decoding and nothing
 * interprets them.
 */

import { decodeBase64Url } from "../base64url";
import { githubFetch, githubHeaders } from "./app";

/** GitHub's contents API inlines a file up to 1 MiB; past that it sends no content. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

/** A download is read whole before the token is revoked, so it is held to this. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface FileReadDeps {
  readonly fetchImpl: typeof fetch;
  readonly apiOrigin: string;
}

export type FileAtCommit =
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large"; readonly size: number }
  | { readonly kind: "not_found" }
  /** A directory, a symbolic link, or a submodule: nothing to show, and never followed. */
  | { readonly kind: "not_a_file"; readonly type: "directory" | "symlink" | "submodule" | "other" }
  | { readonly kind: "failed"; readonly category: "unreachable" | "rejected" | "malformed" };

/** `a/b c/d.ts` as a URL path, each segment escaped, the slashes kept. */
export function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function contentsUrl(deps: FileReadDeps, fullName: string, sha: string, path: string): string {
  return `${deps.apiOrigin}/repos/${fullName}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(sha)}`;
}

/** GitHub's standard base64, broken into lines, as bytes; null when it is not base64. */
function decodeContent(content: string): Uint8Array | null {
  return decodeBase64Url(
    content.replace(/\s+/g, "").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  );
}

const NOT_A_FILE_TYPES: Readonly<Record<string, "symlink" | "submodule">> = {
  symlink: "symlink",
  submodule: "submodule",
};

/**
 * `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`. `sha` is a recorded
 * commit, never a ref name, so the answer cannot move.
 */
export async function readFileAtCommit(
  deps: FileReadDeps,
  token: string,
  fullName: string,
  sha: string,
  path: string,
): Promise<FileAtCommit> {
  const upstream = await githubFetch(deps.fetchImpl, contentsUrl(deps, fullName, sha, path), {
    method: "GET",
    headers: githubHeaders(token),
  });
  if (upstream === null) {
    return { kind: "failed", category: "unreachable" };
  }
  if (upstream.status === 404) {
    return { kind: "not_found" };
  }
  if (upstream.status !== 200) {
    return { kind: "failed", category: "rejected" };
  }
  const body: unknown = await upstream.json().catch(() => null);
  if (Array.isArray(body)) {
    return { kind: "not_a_file", type: "directory" };
  }
  if (typeof body !== "object" || body === null) {
    return { kind: "failed", category: "malformed" };
  }
  const entry = body as Record<string, unknown>;
  if (entry.type !== "file") {
    return {
      kind: "not_a_file",
      type: NOT_A_FILE_TYPES[String(entry.type)] ?? "other",
    };
  }
  if (typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size < 0) {
    return { kind: "failed", category: "malformed" };
  }
  if (entry.size > MAX_PREVIEW_BYTES) {
    return { kind: "too_large", size: entry.size };
  }
  // Past 1 MiB GitHub answers `encoding: "none"` and an empty `content`; the
  // size check above has already turned that into `too_large`.
  if (entry.encoding !== "base64" || typeof entry.content !== "string") {
    return { kind: "failed", category: "malformed" };
  }
  const bytes = decodeContent(entry.content);
  // The size field is GitHub's word; the bytes are what is served.
  if (bytes === null || bytes.byteLength !== entry.size) {
    return { kind: "failed", category: "malformed" };
  }
  return { kind: "file", bytes };
}

export type FileDownload =
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" }
  | { readonly kind: "not_found" }
  | { readonly kind: "failed"; readonly category: "unreachable" | "rejected" };

/**
 * The same file as raw bytes, for downloading one too large to preview. Read
 * whole and bounded by `MAX_DOWNLOAD_BYTES` so the caller can revoke the token
 * once this returns.
 */
export async function downloadFileAtCommit(
  deps: FileReadDeps,
  token: string,
  fullName: string,
  sha: string,
  path: string,
): Promise<FileDownload> {
  const headers = githubHeaders(token);
  headers.set("accept", "application/vnd.github.raw");
  const upstream = await githubFetch(deps.fetchImpl, contentsUrl(deps, fullName, sha, path), {
    method: "GET",
    headers,
  });
  if (upstream === null) {
    return { kind: "failed", category: "unreachable" };
  }
  if (upstream.status === 404) {
    return { kind: "not_found" };
  }
  if (upstream.status !== 200) {
    return { kind: "failed", category: "rejected" };
  }
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    await upstream.body?.cancel();
    return { kind: "too_large" };
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return { kind: "too_large" };
  }
  return { kind: "file", bytes };
}
