/**
 * Real local git repositories for the GitHub double to point `clone_url` at.
 * Each seeded repository gets one commit, and the double uses that commit's
 * real sha, never a hand-picked constant.
 *
 * Node-only: `worker/test/github-double.ts` must never import this, because it
 * also runs in the workerd pool, which has no `git` and no filesystem.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SeedRepository {
  /** The bare repository's directory, e.g. for `updateRef` below. */
  readonly bareDir: string;
  /** `file://<bareDir>`: what `GitHubDoubleRepository.cloneUrl` is set to. */
  readonly cloneUrl: string;
  /** The real sha of the one commit on `defaultBranch`. */
  readonly sha: string;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "OnCue Double",
  GIT_AUTHOR_EMAIL: "double@oncue.test",
  GIT_COMMITTER_NAME: "OnCue Double",
  GIT_COMMITTER_EMAIL: "double@oncue.test",
};

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString("utf8")
    .trim();
}

/**
 * A `package.json` whose `test` and `typecheck` scripts run with Node alone.
 * The bridge treats both as required checks (record 14), and with no lockfile
 * installs nothing, so a run can end `verified` without the network.
 */
export const SEED_FILES: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "widgets",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        test: "node --test test/widgets.test.js",
        typecheck: "node --check src/widgets.js",
      },
    },
    null,
    2,
  )}\n`,
  "src/widgets.js": "export function widgetCount(widgets) {\n  return widgets.length;\n}\n",
  "test/widgets.test.js": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { widgetCount } from "../src/widgets.js";',
    "",
    'test("counts widgets", () => {',
    '  assert.equal(widgetCount(["a", "b"]), 2);',
    "});",
    "",
  ].join("\n"),
};

/** One commit on `defaultBranch`, then cloned `--bare` so it can be served over `file://`. */
export function createSeedRepository(
  fullName: string,
  defaultBranch: string,
  /** Files this repository holds besides the seed's, such as an `.oncue/project.yaml`, or an image as its bytes. */
  extraFiles: Readonly<Record<string, string | Uint8Array>> = {},
): SeedRepository {
  const workDir = mkdtempSync(join(tmpdir(), "oncue-github-double-work-"));
  git(["init", "--quiet", `--initial-branch=${defaultBranch}`, "."], workDir);
  writeFileSync(join(workDir, "README.md"), `# ${fullName}\n`);
  for (const [path, contents] of Object.entries({ ...SEED_FILES, ...extraFiles })) {
    mkdirSync(join(workDir, path, ".."), { recursive: true });
    writeFileSync(join(workDir, path), contents);
  }
  git(["add", "--all"], workDir);
  git(["commit", "--quiet", "-m", "Initial commit"], workDir);
  const sha = git(["rev-parse", "HEAD"], workDir);

  const bareDir = `${mkdtempSync(join(tmpdir(), "oncue-github-double-bare-"))}.git`;
  git(["clone", "--quiet", "--bare", workDir, bareDir], workDir);

  return { bareDir, cloneUrl: `file://${bareDir}`, sha };
}

/** `bareDir` from a `file://` clone URL this module minted, for `updateRef`. */
export function bareDirFromCloneUrl(cloneUrl: string): string | null {
  return cloneUrl.startsWith("file://") ? cloneUrl.slice("file://".length) : null;
}

/**
 * Creates `refs/heads/<branch>` at `sha`, as `POST /repos/:owner/:repo/git/refs`
 * does, so a clone of `branch` finds it. `sha` is always already in this
 * repository, so `update-ref` never fetches.
 */
export function createRefInBareRepo(bareDir: string, branch: string, sha: string): void {
  git(["update-ref", `refs/heads/${branch}`, sha], bareDir);
}

/**
 * One path at one commit, byte for byte, so the double's contents route answers
 * from the tree a clone would get. Null when the path is absent; a symlink or
 * submodule is reported as such, never followed.
 */
export function readFileAtCommit(
  bareDir: string,
  sha: string,
  path: string,
): { readonly content: Uint8Array; readonly kind: "file" | "symlink" | "submodule" } | null {
  let entry: string;
  try {
    entry = git(["ls-tree", sha, "--", path], bareDir);
  } catch {
    return null;
  }
  const mode = entry.split(" ")[0];
  if (mode === undefined || mode === "") {
    return null;
  }
  if (mode === "160000") {
    return { content: new Uint8Array(), kind: "submodule" };
  }
  // Not `git()`, which decodes and trims: the bytes as the blob holds them.
  const content = execFileSync("git", ["cat-file", "blob", `${sha}:${path}`], {
    cwd: bareDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    content: new Uint8Array(content),
    kind: mode === "120000" ? "symlink" : "file",
  };
}

/**
 * Every branch and its commit, as a push left them. GitHub's pull-request API
 * answers from real refs, so the double's `/pulls` routes read these first.
 */
export function listBranchHeads(bareDir: string): ReadonlyMap<string, string> {
  const heads = new Map<string, string>();
  const listed = git(
    ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
    bareDir,
  );
  for (const line of listed.split("\n")) {
    const [branch, sha] = line.trim().split(" ");
    if (branch !== undefined && sha !== undefined && branch !== "") {
      heads.set(branch, sha);
    }
  }
  return heads;
}

/**
 * GitHub's clone endpoint at `<web origin>/<owner>/<name>.git`, served by
 * `git http-backend` over the bare repository. Credentials are not checked.
 * `REMOTE_USER` stands for the App installation, because `http-backend`
 * refuses an anonymous `git-receive-pack` and a real GitHub push is never
 * anonymous.
 */
export function serveGitSmartHttp(
  bareDir: string,
  subPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "http://double.invalid");
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "",
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROJECT_ROOT: bareDir,
      PATH_INFO: subPath,
      REQUEST_METHOD: request.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "oncue-installation",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  request.pipe(child.stdin);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("close", (code) => {
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    if (code !== 0 || split === -1) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(`git http-backend exited ${code}`);
      return;
    }
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of output.subarray(0, split).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "status") {
        status = Number.parseInt(value, 10) || 200;
      } else {
        headers[name] = value;
      }
    }
    response.writeHead(status, headers);
    response.end(output.subarray(split + 4));
  });
}
