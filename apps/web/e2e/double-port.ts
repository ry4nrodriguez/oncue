/**
 * Listen on a double's fixed port, or attach to the double already there.
 * Ports are fixed because `.dev.vars` points the Worker at one origin, and both
 * `pnpm dev` and a test may start the same double. On `EADDRINUSE` the caller
 * gets a handle whose control calls go over HTTP and whose `close` does
 * nothing. The port must answer `GET /__calls`, so an unrelated process there
 * is an error.
 */

import type { Server } from "node:http";

export type ListenOutcome = "listening" | "attached";

export function listenOrAttach(
  server: Server,
  port: number,
  origin: string,
): Promise<ListenOutcome> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      void fetch(`${origin}/__calls`)
        .then((answer) => {
          if (!answer.ok) {
            throw new Error(`${origin} is in use by something that is not a double`);
          }
          resolve("attached");
        })
        .catch((cause: unknown) => {
          reject(
            new Error(`port ${port} is in use and does not answer as a double: ${String(cause)}`),
          );
        });
    });
    server.listen(port, "127.0.0.1", () => resolve("listening"));
  });
}

export async function postJson(origin: string, path: string, body: unknown): Promise<void> {
  const answer = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!answer.ok) {
    throw new Error(`${path} on ${origin} answered ${answer.status}`);
  }
}
