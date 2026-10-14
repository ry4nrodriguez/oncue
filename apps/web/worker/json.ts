// Parses untrusted text without throwing, so `worker/session/` and
// `worker/sandbox/` can stay free of `try`/`catch`.

export type JsonParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export function safeJsonParse<T = unknown>(text: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}
