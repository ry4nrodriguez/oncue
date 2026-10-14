/**
 * A scripted stand-in for Anthropic's Messages API, used to drive a real Claude
 * Code binary with no model and no key (`record-claude-session.ts`). It shows how
 * Claude Code behaves around a model, not how a real model behaves.
 *
 * It refuses what the relay refuses, the same way: a method other than POST is
 * 405 and a path other than `/v1/messages` is 404. A request that offers no
 * tools (a title, a summary) gets a short text and takes no step. Each step is
 * a text answer, a tool call by the name Claude Code offered, or a stream that
 * never ends (for an interrupt).
 */

import { createServer, type Server } from "node:http";

export type MessagesStep =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "hang" };

export interface MessagesStubRequest {
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
  /** Null for a refused request, whose body is not read. */
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly status: number;
  readonly scripted: boolean;
}

export interface MessagesStub {
  readonly port: number;
  readonly requests: readonly MessagesStubRequest[];
  push(...steps: MessagesStep[]): void;
  close(): Promise<void>;
}

function event(type: string, body: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

function usage(output: number): Record<string, number> {
  return {
    input_tokens: 10,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function streamFor(step: MessagesStep, index: number, model: string): string {
  let out = event("message_start", {
    message: {
      id: `msg_stub_${index}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(1),
    },
  });
  let stopReason = "end_turn";
  if (step.kind === "call") {
    const args = JSON.stringify(step.args);
    out += event("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_stub_${index}`, name: step.name, input: {} },
    });
    out += event("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: args },
    });
    out += event("content_block_stop", { index: 0 });
    stopReason = "tool_use";
  } else {
    const text = step.kind === "text" ? step.text : "";
    out += event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const word of text.split(/(?<= )/)) {
      out += event("content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
    }
    out += event("content_block_stop", { index: 0 });
  }
  out += event("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  out += event("message_stop", {});
  return out;
}

function plainMessage(index: number, model: string, text: string): Record<string, unknown> {
  return {
    id: `msg_stub_${index}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(3),
  };
}

export async function startMessagesStub(): Promise<MessagesStub> {
  const steps: MessagesStep[] = [];
  const requests: MessagesStubRequest[] = [];
  let served = 0;
  const hanging: Array<() => void> = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "/";
    const query = url.indexOf("?");
    const path = query === -1 ? url : url.slice(0, query);
    const headerNames = Object.keys(request.headers).sort();
    const method = request.method ?? "GET";
    if (method !== "POST" || path !== "/v1/messages") {
      const status = method !== "POST" ? 405 : 404;
      requests.push({ method, path, headerNames, body: null, status, scripted: false });
      request.resume();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "relay_refused", message: "not served" } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      served += 1;
      const model = typeof body.model === "string" ? body.model : "stub";
      const offersTools = Array.isArray(body.tools) && body.tools.length > 0;
      const step: MessagesStep = offersTools
        ? (steps.shift() ?? { kind: "text", text: "Done." })
        : { kind: "text", text: "A short answer." };
      requests.push({ method, path, headerNames, body, status: 200, scripted: offersTools });
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(plainMessage(served, model, step.kind === "text" ? step.text : "")),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (step.kind === "hang") {
        response.write(
          event("message_start", {
            message: {
              id: `msg_stub_${served}`,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: usage(1),
            },
          }),
        );
        hanging.push(() => response.end());
        response.on("close", () => response.end());
        return;
      }
      response.end(streamFor(step, served, model));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    requests,
    push: (...more) => {
      steps.push(...more);
    },
    close: () => {
      for (const end of hanging.splice(0)) {
        end();
      }
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
