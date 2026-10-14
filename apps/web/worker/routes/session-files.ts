/**
 * `GET /api/sessions/:sessionId/files?path=<path>[&download=1]`: one file of
 * the session's repository at its base commit, for files the session did not
 * change (record 13). Read from GitHub, so it works after the sandbox stops.
 *
 * The repository and commit come from the session's `session_index` row; the
 * browser names only a path, which is validated first. The route is
 * owner-authorized, re-verifies the installation, and reads under a narrowed
 * `contents: read` token that is revoked afterwards. Previews (at most 1 MiB)
 * are served as text, a sniffed raster image, or a download, always with
 * `nosniff` and a sandboxing CSP so repository content never runs on OnCue's
 * origin. `download=1` fetches up to 20 MiB. Cached copies answer only after
 * every check has passed for this caller.
 */

import { isUtf8Text, sniffAttachment } from "@oncue/protocol";
import { contentDisposition } from "../attachments/routes";
import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { AUTHORIZE_DENIAL_HTTP_STATUS, authorizeSessionRequest } from "../auth/authorize";
import { withInstallationToken } from "../github/app";
import {
  downloadFileAtCommit,
  encodeRepositoryPath,
  type FileAtCommit,
  type FileDownload,
  readFileAtCommit,
} from "../github/file-at-commit";
import { VERIFY_REFUSAL_STATUS, verifyInstallation } from "../github/install";
import { resolveRepository } from "../github/repositories";
import { log } from "../log";
import { mintFailureCategory } from "../secrets/disclosure";
import { atMostOne } from "../sql";
import { readGitHubConfig } from "./repositories";

const FILES_PATH = /^\/api\/sessions\/([^/]+)\/files$/;

/** The session id of a file route, or null. */
export function matchSessionFileRoute(pathname: string, method: string): string | null {
  if (method !== "GET") {
    return null;
  }
  const match = FILES_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

/** Longer than any path a repository listing holds in practice, and far short of a URL's limit. */
export const MAX_PATH_CHARS = 1024;

export type PathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "missing" | "too_long" | "not_a_repository_path" };

// A path as `git ls-tree` lists it: relative, `/`-separated, no empty, `.`, or
// `..` segment, nothing under `.git`, no backslash or control character.
export function checkRepositoryPath(raw: string | null): PathCheck {
  if (raw === null || raw.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (raw.length > MAX_PATH_CHARS) {
    return { ok: false, reason: "too_long" };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) {
    return { ok: false, reason: "not_a_repository_path" };
  }
  const segments = raw.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment === ".git",
    )
  ) {
    return { ok: false, reason: "not_a_repository_path" };
  }
  return { ok: true, path: raw };
}

export type FileKind = "text" | "image" | "binary";

// Classified by bytes, never by name. SVG is text, never an image, because it
// can carry script.
export function describeFile(
  bytes: Uint8Array,
  name: string,
): {
  readonly kind: FileKind;
  readonly contentType: string;
} {
  const sniffed = sniffAttachment(bytes, name);
  if (sniffed.ok && sniffed.kind === "image") {
    return { kind: "image", contentType: sniffed.contentType };
  }
  if (isUtf8Text(bytes)) {
    return { kind: "text", contentType: "text/plain; charset=utf-8" };
  }
  return { kind: "binary", contentType: "application/octet-stream" };
}

const SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cross-origin-resource-policy": "same-origin",
} as const;

/** The owner's browser may keep a file at a commit for an hour: it cannot change. */
const BROWSER_CACHE = "private, max-age=3600";
/** The Worker's cache keeps a day; a `private` response would not be stored at all. */
const WORKER_CACHE = "public, max-age=86400";
/** A host that is never fetched: the Cache API wants a URL for a key. */
const CACHE_ORIGIN = "https://session-files.oncue.invalid";

export const FILE_KIND_HEADER = "x-oncue-file-kind";

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function preview(bytes: Uint8Array, path: string, cacheControl: string): Response {
  const { kind, contentType } = describeFile(bytes, fileName(path));
  return new Response(bytes, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDisposition(
        kind === "binary" ? "attachment" : "inline",
        fileName(path),
      ),
      [FILE_KIND_HEADER]: kind,
      "cache-control": cacheControl,
    },
  });
}

function download(bytes: Uint8Array, path: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDisposition("attachment", fileName(path)),
      "cache-control": BROWSER_CACHE,
    },
  });
}

/** One line per read that did not answer: fixed words and the session, never a path or a name. */
function logFailure(env: Env, sessionId: string, result: string, errorCategory: string): void {
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "api.session_file.read",
    result,
    errorCategory,
    sessionId,
  });
}

/** The same code and status the create route answers with, so the browser says "Reconnect GitHub". */
function reconnectGitHub(status: number, reason: string): Response {
  return Response.json({ error: "github_reverification_required", reason }, { status });
}

type SessionRepositoryRow = {
  readonly repository_connection_id: string | null;
  readonly base_commit_sha: string | null;
};

/** The Worker's cache, or null where the runtime has none. */
export type FileCache = Pick<Cache, "match" | "put"> | null;

function defaultCache(): FileCache {
  return typeof caches === "undefined" ? null : caches.default;
}

export async function handleSessionFile(
  request: Request,
  env: Env,
  sessionId: string,
  allowlistCache: AllowlistCache,
  cache: FileCache = defaultCache(),
): Promise<Response> {
  const outcome = await authorizeSessionRequest(env, request, sessionId, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: AUTHORIZE_DENIAL_HTTP_STATUS[outcome.reason] },
    );
  }
  const url = new URL(request.url);
  const checked = checkRepositoryPath(url.searchParams.get("path"));
  if (!checked.ok) {
    return Response.json({ error: "invalid_path", reason: checked.reason }, { status: 400 });
  }
  const path = checked.path;
  const wantsDownload = url.searchParams.get("download") === "1";

  const row = await atMostOne<SessionRepositoryRow>(
    env.DB.prepare(
      "SELECT repository_connection_id, base_commit_sha FROM session_index WHERE session_id = ?",
    ).bind(sessionId),
  );
  const repositoryConnectionId = row.kind === "found" ? row.row.repository_connection_id : null;
  const baseSha = row.kind === "found" ? row.row.base_commit_sha : null;
  if (repositoryConnectionId === null || baseSha === null) {
    return Response.json({ error: "no_repository" }, { status: 404 });
  }

  const workspaceId = actorWorkspaceId(outcome.actor);
  const resolved = await resolveRepository(env.DB, workspaceId, { repositoryConnectionId });
  if (resolved.kind === "refused" && resolved.reason === "not_connected") {
    logFailure(env, sessionId, "reverification_required", "repository_not_connected");
    return reconnectGitHub(409, resolved.reason);
  }
  if (resolved.kind !== "resolved") {
    return Response.json({ error: "no_repository" }, { status: 404 });
  }
  const repository = resolved.repository;

  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }
  const verified = await verifyInstallation(config.deps, workspaceId, repository.installationRowId);
  if (verified.kind === "refused") {
    logFailure(env, sessionId, "reverification_required", `installation_${verified.reason}`);
    return reconnectGitHub(VERIFY_REFUSAL_STATUS[verified.reason], verified.reason);
  }

  // Every check has passed for this caller; only now may a cached copy answer.
  const cacheKey = `${CACHE_ORIGIN}/${repository.githubRepositoryId}/${baseSha}/${encodeRepositoryPath(path)}`;
  if (!wantsDownload && cache !== null) {
    const hit = await cache.match(cacheKey);
    if (hit !== undefined) {
      return preview(new Uint8Array(await hit.arrayBuffer()), path, BROWSER_CACHE);
    }
  }

  const deps = { fetchImpl: config.appDeps.fetchImpl, apiOrigin: config.appDeps.apiOrigin };
  const ran = await withInstallationToken<FileAtCommit | FileDownload>(
    config.appDeps,
    {
      installationId: repository.githubInstallationId,
      repositoryIds: [repository.githubRepositoryId],
      permissions: { contents: "read" },
    },
    (token) =>
      wantsDownload
        ? downloadFileAtCommit(deps, token, repository.fullName, baseSha, path)
        : readFileAtCommit(deps, token, repository.fullName, baseSha, path),
  );
  if (ran.kind === "not_minted") {
    const category = mintFailureCategory(ran.failure);
    const missing =
      ran.failure.kind === "failed" &&
      ran.failure.category === "rejected" &&
      ran.failure.status === 404;
    if (missing) {
      logFailure(env, sessionId, "reverification_required", category);
      return reconnectGitHub(VERIFY_REFUSAL_STATUS.reverification_required, "installation_missing");
    }
    logFailure(env, sessionId, "unreadable", category);
    return Response.json({ error: "github_failed" }, { status: 502 });
  }

  const read = ran.result;
  switch (read.kind) {
    case "file": {
      if (wantsDownload) {
        return download(read.bytes, path);
      }
      if (cache !== null) {
        await cache.put(cacheKey, preview(read.bytes, path, WORKER_CACHE));
      }
      return preview(read.bytes, path, BROWSER_CACHE);
    }
    case "too_large":
      return Response.json(
        "size" in read
          ? { error: "too_large", size: read.size }
          : { error: "too_large_to_download" },
        { status: 413 },
      );
    case "not_found":
      return Response.json({ error: "not_found" }, { status: 404 });
    case "not_a_file":
      return Response.json({ error: "not_a_file", type: read.type }, { status: 422 });
    case "failed":
      logFailure(env, sessionId, "unreadable", `file_${read.category}`);
      return Response.json({ error: "github_failed" }, { status: 502 });
  }
}
