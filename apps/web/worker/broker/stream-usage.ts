/**
 * The provider's own token counts for one streamed model answer, read as its
 * bytes pass through the broker, so a log line can hold the bridge's figures
 * to the provider's (record 18).
 *
 * The bytes are passed on unchanged and in the order they arrive. Only the
 * provider's usage counters are read out of them, as integers: never text,
 * never a header, never anything the model wrote. A counter the model wrote
 * inside its own text is escaped in the stream's JSON, so it cannot match.
 */

/** The largest value each counter reached in the stream. */
export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Anthropic's Messages stream and OpenAI's Responses stream both name
 * `input_tokens` and `output_tokens`. Anthropic counts its cache apart from
 * `input_tokens`; OpenAI counts `cached_tokens` and `cache_write_tokens`
 * inside it. The log keeps each provider's own meaning.
 */
const USAGE_FIELDS: readonly (readonly [RegExp, keyof StreamUsage])[] = [
  [/"input_tokens"\s*:\s*(\d+)/g, "inputTokens"],
  [/"output_tokens"\s*:\s*(\d+)/g, "outputTokens"],
  [/"cache_read_input_tokens"\s*:\s*(\d+)/g, "cacheReadTokens"],
  [/"cached_tokens"\s*:\s*(\d+)/g, "cacheReadTokens"],
  [/"cache_creation_input_tokens"\s*:\s*(\d+)/g, "cacheWriteTokens"],
  [/"cache_write_tokens"\s*:\s*(\d+)/g, "cacheWriteTokens"],
];

/**
 * How much of the previous chunk is scanned again with the next, so a counter
 * split across two chunks is still read. Longer than the longest field name
 * plus a large integer.
 */
const CARRY_CHARS = 64;

/** Raises each counter found in `text` to the largest value seen so far. */
export function scanUsage(text: string, usage: StreamUsage): void {
  for (const [pattern, field] of USAGE_FIELDS) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value > (usage[field] ?? -1)) {
        usage[field] = value;
      }
    }
  }
}

/**
 * Returns `body` with the same bytes, calling `onEnd` once the last chunk has
 * passed. `onEnd` is not called when the reader cancels the stream.
 */
export function readUsage(
  body: ReadableStream<Uint8Array>,
  onEnd: (usage: StreamUsage) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const usage: StreamUsage = {};
  let carry = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        const text = carry + decoder.decode(chunk, { stream: true });
        scanUsage(text, usage);
        carry = text.slice(-CARRY_CHARS);
      },
      flush() {
        scanUsage(carry + decoder.decode(), usage);
        onEnd(usage);
      },
    }),
  );
}
