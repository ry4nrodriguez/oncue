/**
 * The provider double over real HTTP, so tests drive the broker end to end
 * without a real provider. It reuses `worker/test/provider-double.ts`, so the
 * unit tests and these tests share the same fixtures.
 *
 * Two control endpoints exist only here, never in the Worker:
 *   POST /__mode   { mode }  switches which answer the next call gets
 *   GET  /__calls            what the double actually received
 *
 * `/__calls` proves a test is talking to the double; otherwise a misconfigured
 * origin could send a real key to a real provider and still pass.
 */

import { createServer, type Server } from "node:http";
import { slotPorts } from "../../../scripts/dev-ports.mjs";
import {
  createProviderDouble,
  type DoubleCount,
  type DoubleMode,
  type DoubleUsage,
  effortIn,
  imageBlocksIn,
  type ProviderDouble,
  type ProviderId,
} from "../worker/test/provider-double";
import { listenOrAttach, postJson } from "./double-port";

/** The port slot's provider double (`scripts/dev-ports.mjs`). */
export const PROVIDER_DOUBLE_PORT = slotPorts().provider;
export const PROVIDER_DOUBLE_ORIGIN = `http://127.0.0.1:${PROVIDER_DOUBLE_PORT}`;

/** One request the double received, as `GET /__calls` reports it. */
export interface RecordedDoubleCall {
  readonly method: string;
  readonly path: string;
  readonly headerNames: string[];
  /** The effort the body named in the provider's own field, or `null`. */
  readonly effort: string | null;
  /** How many image blocks the body carried (composer attachments); a count, never the bytes. */
  readonly images: number;
  /** How many tools the body offered: the agent's own calls offer them, a title request none. */
  readonly tools: number;
  /** The tokens the double's answer reported, each kind counted once. */
  readonly usage: DoubleUsage | null;
  /** For a `count_tokens` call, what it counted and answered. */
  readonly counted: DoubleCount | null;
}

/** How many tools a request body offers, or 0 when it is not JSON. */
function toolsIn(body: Buffer | undefined): number {
  try {
    const parsed = JSON.parse(body?.toString("utf8") ?? "") as { tools?: unknown };
    return Array.isArray(parsed.tools) ? parsed.tools.length : 0;
  } catch {
    return 0;
  }
}

export interface RunningDouble {
  readonly server: Server;
  /** Resolves once the double holds the mode, whether in-process or attached to over HTTP. */
  setMode(mode: DoubleMode): Promise<void>;
  close(): Promise<void>;
}

/** One double per provider, chosen by the request path. */
function providerFor(path: string): ProviderId {
  // OpenAI's Responses API (`/v1/responses`) is what the runtime's client
  // calls; Chat Completions stays recognised for the broker's own tests.
  return path.includes("/responses") ||
    path.includes("chat/completions") ||
    path.includes("/models?")
    ? "openai"
    : "anthropic";
}

export function startProviderDouble(port: number = PROVIDER_DOUBLE_PORT): Promise<RunningDouble> {
  const doubles: Record<ProviderId, ProviderDouble> = {
    anthropic: createProviderDouble("anthropic"),
    openai: createProviderDouble("openai"),
  };
  const received: RecordedDoubleCall[] = [];

  const server = createServer((request, response) => {
    const path = request.url ?? "/";

    if (path === "/__calls") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ calls: received }));
      return;
    }

    if (path === "/__mode" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const mode = (JSON.parse(body) as { mode: DoubleMode }).mode;
        doubles.anthropic.setMode(mode);
        doubles.openai.setMode(mode);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ mode }));
      });
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      // Header names only: the credential arrives in one of these, and
      // recording values would put a key in the test report. The effort is a
      // level name, not a secret.
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const provider = providerFor(path);
      // The double records the call before its first await, so the newest
      // record is this one's.
      const answering = doubles[provider].fetchImpl(`${PROVIDER_DOUBLE_ORIGIN}${path}`, {
        method: request.method ?? "GET",
        body,
      });
      received.push({
        method: request.method ?? "GET",
        path,
        headerNames: Object.keys(request.headers),
        effort: effortIn(body),
        images: imageBlocksIn(body),
        tools: toolsIn(body),
        usage: doubles[provider].calls.at(-1)?.usage ?? null,
        counted: doubles[provider].calls.at(-1)?.counted ?? null,
      });
      void answering.then(async (answer) => {
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
      return {
        server,
        setMode(mode) {
          return postJson(origin, "/__mode", { mode });
        },
        close: () => Promise.resolve(),
      };
    }
    return {
      server,
      async setMode(mode) {
        doubles.anthropic.setMode(mode);
        doubles.openai.setMode(mode);
      },
      close() {
        return new Promise((done) => {
          server.close(() => done());
        });
      },
    };
  });
}
