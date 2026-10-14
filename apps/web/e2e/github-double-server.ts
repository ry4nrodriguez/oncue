/**
 * The GitHub double over real HTTP, reusing `worker/test/github-double.ts` so
 * the unit tests and these tests share the same fixtures. It serves both the
 * REST routes and `github.com`'s web paths on one origin, routed by path,
 * because `ONCUE_GITHUB_API_ORIGIN` redirects both.
 *
 * Four control endpoints exist only here, never in the Worker:
 *   POST /__state   seed installations, repositories, refs, and visibility
 *   GET  /__calls   what the double received, header names only
 *   POST /__mode    force a failure
 *   POST /__reset   clear recorded calls between tests
 * `/__calls` proves a test is talking to the double. It never returns a token,
 * so no credential lands in a test report.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { originsFor, slotPorts } from "../../../scripts/dev-ports.mjs";
import {
  createGitHubDouble,
  type GitHubDoubleMode,
  type GitHubDoubleSeed,
  type GitHubRecordedCall,
} from "../worker/test/github-double";
import { listenOrAttach, postJson } from "./double-port";
import {
  bareDirFromCloneUrl,
  createRefInBareRepo,
  listBranchHeads,
  readFileAtCommit,
  serveGitSmartHttp,
} from "./github-bare-repo";

/** The port slot's GitHub double (`scripts/dev-ports.mjs`). */
export const GITHUB_DOUBLE_PORT = slotPorts().github;
export const GITHUB_DOUBLE_ORIGIN = `http://127.0.0.1:${GITHUB_DOUBLE_PORT}`;

export interface RunningGitHubDouble {
  readonly server: Server;
  /** Resolves once the double holds the state, whether it runs in-process or was attached to over HTTP. */
  setState(seed: GitHubDoubleSeed): Promise<void>;
  setMode(mode: GitHubDoubleMode): Promise<void>;
  close(): Promise<void>;
}

/** Where the double's install page sends the browser back to: the slot's local Worker. */
export const DEFAULT_CALLBACK_ORIGIN = originsFor(slotPorts()).app;

const INSTALL_PAGE = /^\/apps\/[^/]+\/installations\/new(?:\?|$)/;
const GIT_CLONE_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      resolve(body.length > 0 ? JSON.parse(body) : {});
    });
  });
}

/** Node folds a repeated header into an array; the headers read here are never repeated, so joining is safe. */
function forwardableHeaders(headers: IncomingHttpHeaders): HeadersInit {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[name] = value;
    } else if (Array.isArray(value)) {
      result[name] = value.join(", ");
    }
  }
  return result;
}

export function startGitHubDouble(
  port: number = GITHUB_DOUBLE_PORT,
  callbackOrigin: string = DEFAULT_CALLBACK_ORIGIN,
): Promise<RunningGitHubDouble> {
  const double = createGitHubDouble();
  // `fullName` -> the bare repository's directory, so a created ref lands in
  // the repository the bridge clones. Indexed from every seed's `cloneUrl`s.
  let bareDirByFullName = new Map<string, string>();

  function indexCloneUrls(seed: GitHubDoubleSeed): void {
    const next = new Map<string, string>();
    for (const repositories of Object.values(seed.repositoriesByInstallation ?? {})) {
      for (const repository of repositories) {
        const bareDir =
          repository.cloneUrl === undefined ? null : bareDirFromCloneUrl(repository.cloneUrl);
        if (bareDir !== null) {
          next.set(repository.fullName, bareDir);
        }
      }
    }
    bareDirByFullName = next;
  }

  const server = createServer((request, response) => {
    const path = request.url ?? "/";

    // `git clone <web origin>/<owner>/<name>.git`, the URL the Worker builds
    // for real GitHub and the double alike.
    const clone = GIT_CLONE_PATH.exec(new URL(path, GITHUB_DOUBLE_ORIGIN).pathname);
    if (clone !== null) {
      const bareDir = bareDirByFullName.get(`${clone[1]}/${clone[2]}`);
      if (bareDir === undefined) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("no such repository");
        return;
      }
      serveGitSmartHttp(bareDir, clone[3] ?? "/", request, response);
      return;
    }

    // GitHub's install page, as a redirect. The Worker's `state` travels back
    // untouched so the real callback verifies it.
    if (INSTALL_PAGE.test(path) && request.method === "GET") {
      const state = new URL(path, GITHUB_DOUBLE_ORIGIN).searchParams.get("state") ?? "";
      const granted = double.install();
      if (granted === null) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("the double has no user who can install; seed one with /__state");
        return;
      }
      const location = new URL("/api/github/callback", callbackOrigin);
      location.searchParams.set("code", granted.code);
      location.searchParams.set("state", state);
      location.searchParams.set("installation_id", String(granted.installationId));
      response.writeHead(302, { location: location.toString() });
      response.end();
      return;
    }

    if (path === "/__calls" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ calls: double.calls }));
      return;
    }

    // The pull request GitHub would now hold, for tests to read.
    if (path === "/__pulls" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pullRequests: double.pullRequests }));
      return;
    }

    if (path === "/__state" && request.method === "POST") {
      void readJsonBody(request).then((body) => {
        const seed = body as GitHubDoubleSeed;
        double.setState(seed);
        indexCloneUrls(seed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (path === "/__mode" && request.method === "POST") {
      void readJsonBody(request).then((body) => {
        const mode = (body as { mode: GitHubDoubleMode }).mode;
        double.setMode(mode);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ mode }));
      });
      return;
    }

    if (path === "/__reset" && request.method === "POST") {
      // `double.calls` is typed read-only; `/__reset` is the one place allowed
      // to clear it.
      (double.calls as GitHubRecordedCall[]).length = 0;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    const createRefMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(path);

    // Pull requests and branches are judged against real refs, so before a
    // `/pulls`, `/branches`, or ref read the double learns what the bare
    // repository holds after the bridge's push or a test's own commit,
    // including a branch deleted since.
    const refsMatch = /^\/repos\/([^/]+\/[^/]+)\/(?:pulls|branches|git\/ref)(?:[/?]|$)/.exec(path);
    const refsBareDir =
      refsMatch === null ? undefined : bareDirByFullName.get(refsMatch[1] as string);
    if (refsMatch !== null && refsBareDir !== undefined) {
      const fullName = refsMatch[1] as string;
      const heads = listBranchHeads(refsBareDir);
      for (const known of double.branchNames(fullName)) {
        if (!heads.has(known)) {
          double.deleteRef(fullName, known);
        }
      }
      for (const [branch, sha] of heads) {
        double.setRef(fullName, branch, sha);
      }
    }

    // A contents read answers from the bare repository at the commit asked for.
    const contentsMatch = /^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)\?ref=([0-9a-f]+)/.exec(
      request.url ?? "",
    );
    const contentsBareDir =
      contentsMatch === null ? undefined : bareDirByFullName.get(contentsMatch[1] as string);
    if (contentsMatch !== null && contentsBareDir !== undefined) {
      const [, fullName, filePath, ref] = contentsMatch as unknown as [
        string,
        string,
        string,
        string,
      ];
      const file = readFileAtCommit(contentsBareDir, ref, decodeURIComponent(filePath));
      double.setFile(fullName, decodeURIComponent(filePath), file === null ? null : file.content, {
        ref,
        kind: file === null ? "file" : file.kind,
      });
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      void double
        .fetchImpl(`${GITHUB_DOUBLE_ORIGIN}${path}`, {
          method: request.method ?? "GET",
          headers: forwardableHeaders(request.headers),
          body: requestBody,
        })
        .then(async (answer) => {
          // `handleCreateRef` only updates the in-memory map; write the ref into
          // the bare repository too, so a later `git clone -b <branch>` finds it.
          if (
            request.method === "POST" &&
            answer.status === 201 &&
            createRefMatch !== null &&
            requestBody !== undefined
          ) {
            const fullName = `${createRefMatch[1]}/${createRefMatch[2]}`;
            const bareDir = bareDirByFullName.get(fullName);
            if (bareDir !== undefined) {
              try {
                const parsed = JSON.parse(requestBody.toString("utf8")) as {
                  ref?: string;
                  sha?: string;
                };
                const refPrefix = "refs/heads/";
                const ref = parsed.ref ?? "";
                const branch = ref.startsWith(refPrefix) ? ref.slice(refPrefix.length) : ref;
                if (branch.length > 0 && typeof parsed.sha === "string") {
                  createRefInBareRepo(bareDir, branch, parsed.sha);
                }
              } catch {
                // Malformed JSON never reaches here: `handleCreateRef` would
                // have already answered something other than 201 for it.
              }
            }
          }
          const headers: Record<string, string> = {};
          answer.headers.forEach((value, name) => {
            headers[name] = value;
          });
          response.writeHead(answer.status, headers);
          response.end(Buffer.from(await answer.arrayBuffer()));
        });
    });
  });

  const origin = `http://127.0.0.1:${port}`;
  return listenOrAttach(server, port, origin).then((outcome) => {
    if (outcome === "attached") {
      // Someone else (usually `pnpm dev`) is already serving this double.
      // Drive it over its own control endpoints, and leave it running.
      return {
        server,
        setState(seed) {
          return postJson(origin, "/__state", seed);
        },
        setMode(mode) {
          return postJson(origin, "/__mode", { mode });
        },
        close: () => Promise.resolve(),
      };
    }
    return {
      server,
      async setState(seed) {
        double.setState(seed);
        indexCloneUrls(seed);
      },
      async setMode(mode) {
        double.setMode(mode);
      },
      close() {
        return new Promise((done) => {
          server.close(() => done());
        });
      },
    };
  });
}
