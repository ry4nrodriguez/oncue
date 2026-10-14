/**
 * Redacts the session's exact secret values from everything that leaves the
 * sandbox through the bridge: event payloads, streamed chunks, log lines, and
 * artifact bytes (record 08). A transformed value (base64, reversed) is not
 * found; redaction is a safety net, not a boundary.
 *
 * A streamed value can straddle two chunks, so each stream holds back the
 * longest tail that could start a value until the next chunk decides it. A tail
 * still held when the stream ends is dropped: the durable event that ends a
 * message or tool call carries the whole text, redacted whole.
 */

/** The marker `@oncue/protocol`'s redactor writes too, so the two layers read alike for any value of its length or more. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";
/**
 * For a value shorter than the marker, so a replacement never makes text longer
 * and a payload within its schema's limit stays within it.
 */
export const SHORT_REDACTION_PLACEHOLDER = "[hidden]";

function markerFor(value: string): string {
  return value.length >= REDACTION_PLACEHOLDER.length
    ? REDACTION_PLACEHOLDER
    : SHORT_REDACTION_PLACEHOLDER;
}

export interface SecretRedactor {
  /** Learns a value. Held in this process's memory only. */
  add(value: string): void;
  text(input: string): string;
  /** Every string leaf of plain objects and arrays. Never mutates. */
  deep<T>(value: T): T;
  /** The same buffer when nothing matched. */
  bytes(input: Buffer): Buffer;
  /** The chunks safe to send now for one stream, each within the chunk limit. */
  stream(key: string, text: string): string[];
  /** Forgets every stream whose key starts with `prefix`. */
  endStreams(prefix: string): void;
  holdsValues(): boolean;
  /** The files of a git patch whose changes hold a value. A binary file's patch is encoded, so a value inside one is not found. */
  secretPathsIn(patch: string): string[];
}

const UNKNOWN_FILE = "(unknown file)";

function replaceAll(input: string, values: readonly string[]): string {
  let output = input;
  for (const value of values) {
    if (output.includes(value)) {
      output = output.split(value).join(markerFor(value));
    }
  }
  return output;
}

/** The length of the longest tail of `text` that is a proper start of some value. */
function heldLength(text: string, values: readonly string[]): number {
  let longest = 0;
  for (const value of values) {
    const most = Math.min(value.length - 1, text.length);
    for (let length = most; length > longest; length -= 1) {
      if (text.endsWith(value.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function deepWith(value: unknown, values: readonly string[]): unknown {
  if (typeof value === "string") {
    return replaceAll(value, values);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepWith(item, values));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepWith(item, values)]),
    );
  }
  return value;
}

export function createSecretRedactor(chunkLimit: number): SecretRedactor {
  /** Longest first, so a value that contains another is replaced whole. */
  let values: string[] = [];
  const tails = new Map<string, string>();

  return {
    add(value) {
      if (value.length > 0 && !values.includes(value)) {
        values = [...values, value].sort((a, b) => b.length - a.length);
      }
    },
    text(input) {
      return replaceAll(input, values);
    },
    deep<T>(value: T): T {
      return deepWith(value, values) as T;
    },
    bytes(input) {
      let output = input;
      for (const value of values) {
        const needle = Buffer.from(value, "utf8");
        const pieces: Buffer[] = [];
        let from = 0;
        let at = output.indexOf(needle, from);
        while (at !== -1) {
          pieces.push(output.subarray(from, at), Buffer.from(markerFor(value), "utf8"));
          from = at + needle.length;
          at = output.indexOf(needle, from);
        }
        if (pieces.length > 0) {
          output = Buffer.concat([...pieces, output.subarray(from)]);
        }
      }
      return output;
    },
    stream(key, text) {
      const pending = replaceAll(`${tails.get(key) ?? ""}${text}`, values);
      const held = heldLength(pending, values);
      const ready = pending.slice(0, pending.length - held);
      if (held > 0) {
        tails.set(key, pending.slice(pending.length - held));
      } else {
        tails.delete(key);
      }
      const chunks: string[] = [];
      for (let from = 0; from < ready.length; from += chunkLimit) {
        chunks.push(ready.slice(from, from + chunkLimit));
      }
      return chunks;
    },
    holdsValues() {
      return values.length > 0;
    },
    secretPathsIn(patch) {
      const paths: string[] = [];
      // Each section starts at its own `diff --git` line, which names the file.
      for (const section of patch.split(/^(?=diff --git )/m)) {
        if (replaceAll(section, values) === section) {
          continue;
        }
        const named = /^diff --git a\/.* b\/(.*)$/m.exec(section);
        paths.push(named?.[1] ?? UNKNOWN_FILE);
      }
      return paths;
    },
    endStreams(prefix) {
      for (const key of [...tails.keys()]) {
        if (key.startsWith(prefix)) {
          tails.delete(key);
        }
      }
    },
  };
}
