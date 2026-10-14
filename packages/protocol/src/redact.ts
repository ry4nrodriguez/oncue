/**
 * Redaction enforced by the type system: `Redacted<T>` is a branded type only
 * `Redactor.redact` or `assumeRedacted` can produce, so a caller that forgets
 * to redact fails `tsc` instead of leaking at runtime.
 */

declare const REDACTED: unique symbol;

/** Produced only by `Redactor.redact` or `assumeRedacted`. */
export type Redacted<T> = T & { readonly [REDACTED]: true };

const PLACEHOLDER = "[REDACTED]";
const DEFAULT_MIN_LENGTH = 8;

export interface RedactorOptions {
  /**
   * Secrets shorter than this are dropped before matching, so a short value
   * cannot turn ordinary words into replacement markers.
   */
  readonly minLength?: number;
}

export interface Redactor {
  /**
   * Walks `value` recursively through plain objects and arrays and replaces
   * every occurrence of every known secret in every string leaf, including a
   * secret embedded inside a longer token. Never mutates `value`.
   */
  redact<T>(value: T): Redacted<T>;

  /**
   * How many supplied values are too short to ever be replaced, so a caller
   * sees when the redactor protects less than asked (it fails open). Never
   * expose the values themselves. Short secrets are rejected where the user
   * sets them, not here, so a run never ends over configuration.
   */
  readonly unprotectedCount: number;
}

export function createRedactor(values: readonly string[], options?: RedactorOptions): Redactor {
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH;
  const supplied = [...new Set(values.filter((value) => value.length > 0))];
  const secrets = supplied
    .filter((value) => value.length >= minLength)
    .sort((a, b) => b.length - a.length);

  return {
    redact<T>(value: T): Redacted<T> {
      return redactDeep(value, secrets) as Redacted<T>;
    },
    unprotectedCount: supplied.length - secrets.length,
  };
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = redactDeep(item, secrets);
    }
    return copy;
  }
  return value;
}

function redactString(input: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return input;
  let output = input;
  for (const secret of secrets) {
    if (output.includes(secret)) output = output.split(secret).join(PLACEHOLDER);
  }
  return output;
}

/**
 * The only escape hatch, for values that never touched a sandbox: test
 * fixtures and the fake-sandbox harness. The narrow reason type keeps every
 * bypass greppable.
 */
export function assumeRedacted<T>(value: T, reason: "test" | "fake_sandbox"): Redacted<T> {
  void reason;
  return value as Redacted<T>;
}
