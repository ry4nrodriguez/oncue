/**
 * A scripted stand-in for OpenAI's Responses API, used to drive a real Codex
 * binary with no model and no key (`record-codex-session.ts`,
 * `src/codex-local.test.ts`). It shows how Codex behaves around a model, not
 * how a real model behaves. Each step is a text answer, a function call by the
 * name Codex offered, or a stream that never ends (for an interrupt).
 */

import { createServer, type Server } from "node:http";

export type StubStep =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "hang" };

export interface StubRequest {
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ResponsesStub {
  readonly port: number;
  readonly requests: readonly StubRequest[];
  /** The steps still to be served, in order; a request past the end gets a plain text answer. */
  push(...steps: StubStep[]): void;
  close(): Promise<void>;
}

function frame(type: string, body: Record<string, unknown>, sequence: { n: number }): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence.n++, ...body })}\n\n`;
}

function streamFor(step: StubStep, index: number): string {
  const sequence = { n: 0 };
  const base = {
    id: `resp_stub_${index}`,
    object: "response",
    created_at: 1_790_000_000,
    model: "stub",
    usage: null,
  };
  let out = frame(
    "response.created",
    { response: { ...base, status: "in_progress", output: [] } },
    sequence,
  );
  let item: Record<string, unknown>;
  if (step.kind === "call") {
    const args = JSON.stringify(step.args);
    item = {
      type: "function_call",
      id: `fc_stub_${index}`,
      call_id: `call_stub_${index}`,
      name: step.name,
      arguments: args,
      status: "completed",
    };
    out += frame(
      "response.output_item.added",
      { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      sequence,
    );
    out += frame(
      "response.function_call_arguments.delta",
      { item_id: item.id, output_index: 0, delta: args },
      sequence,
    );
    out += frame(
      "response.function_call_arguments.done",
      { item_id: item.id, output_index: 0, arguments: args },
      sequence,
    );
  } else {
    const text = step.kind === "text" ? step.text : "";
    item = {
      type: "message",
      id: `msg_stub_${index}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    out += frame(
      "response.output_item.added",
      { output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      sequence,
    );
    out += frame(
      "response.content_part.added",
      {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      sequence,
    );
    for (const word of text.split(/(?<= )/)) {
      out += frame(
        "response.output_text.delta",
        { item_id: item.id, output_index: 0, content_index: 0, delta: word, logprobs: [] },
        sequence,
      );
    }
    out += frame(
      "response.output_text.done",
      { item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] },
      sequence,
    );
    out += frame(
      "response.content_part.done",
      {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      },
      sequence,
    );
  }
  out += frame("response.output_item.done", { output_index: 0, item }, sequence);
  out += frame(
    "response.completed",
    {
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 15,
        },
      },
    },
    sequence,
  );
  return out;
}

export async function startResponsesStub(): Promise<ResponsesStub> {
  const steps: StubStep[] = [];
  const requests: StubRequest[] = [];
  let served = 0;
  const hanging: Array<() => void> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({
        path: request.url ?? "/",
        headerNames: Object.keys(request.headers).sort(),
        body,
      });
      const step = steps.shift() ?? { kind: "text", text: "Done." };
      served += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (step.kind === "hang") {
        // Opens the stream and says nothing more, until the client goes away.
        response.write(
          frame(
            "response.created",
            {
              response: {
                id: `resp_stub_${served}`,
                object: "response",
                status: "in_progress",
                output: [],
              },
            },
            { n: 0 },
          ),
        );
        hanging.push(() => response.end());
        response.on("close", () => response.end());
        return;
      }
      response.end(streamFor(step, served));
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
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
