import { describe, expect, it } from "vitest";
import { readUsage, type StreamUsage, scanUsage } from "./stream-usage";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("scanUsage", () => {
  it("reads Anthropic's counters, cache apart from input, keeping the largest of each", () => {
    const usage: StreamUsage = {};
    scanUsage(
      '{"usage":{"input_tokens":2,"cache_creation_input_tokens":457,"cache_read_input_tokens":9402,"output_tokens":1}}',
      usage,
    );
    scanUsage('{"usage":{"output_tokens":253}}', usage);
    expect(usage).toEqual({
      inputTokens: 2,
      outputTokens: 253,
      cacheReadTokens: 9_402,
      cacheWriteTokens: 457,
    });
  });

  it("reads OpenAI's counters, cache inside input", () => {
    const usage: StreamUsage = {};
    scanUsage(
      '{"usage":{"input_tokens":12000,"input_tokens_details":{"cached_tokens":9000,"cache_write_tokens":2500},"output_tokens":400}}',
      usage,
    );
    expect(usage).toEqual({
      inputTokens: 12_000,
      outputTokens: 400,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 2_500,
    });
  });

  it("ignores a counter the model wrote in its own text, and one too large to be exact", () => {
    const usage: StreamUsage = {};
    scanUsage('{"delta":{"text":"set \\"input_tokens\\": 999 here"}}', usage);
    scanUsage('{"output_tokens":99999999999999999999}', usage);
    expect(usage).toEqual({});
  });
});

describe("readUsage", () => {
  it("passes the bytes on unchanged, reads a counter split across chunks, and reports at the end", async () => {
    const seen: StreamUsage[] = [];
    const body = readUsage(
      streamOf(['data: {"usage":{"input_tok', 'ens":42,"output_tokens":7}}\n\n']),
      (usage) => seen.push(usage),
    );
    expect(await new Response(body).text()).toBe(
      'data: {"usage":{"input_tokens":42,"output_tokens":7}}\n\n',
    );
    expect(seen).toEqual([{ inputTokens: 42, outputTokens: 7 }]);
  });
});
