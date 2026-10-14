import { describe, expect, it } from "vitest";
import { assumeRedacted, createRedactor, type Redacted } from "./redact";

describe("createRedactor", () => {
  it("replaces a known secret at any depth in a nested payload", () => {
    const redactor = createRedactor(["sk-live-abcdefgh"]);
    const input = {
      outer: {
        inner: {
          token: "auth: sk-live-abcdefgh",
        },
      },
    };
    const result = redactor.redact(input);
    expect(result.outer.inner.token).toBe("auth: [REDACTED]");
  });

  it("replaces secrets inside array elements, including nested objects in arrays", () => {
    const redactor = createRedactor(["ghp_00000000"]);
    const input = { items: ["a", "ghp_00000000", { nested: "x-ghp_00000000-y" }] };
    const result = redactor.redact(input);
    expect(result.items[0]).toBe("a");
    expect(result.items[1]).toBe("[REDACTED]");
    expect((result.items[2] as { nested: string }).nested).toBe("x-[REDACTED]-y");
  });

  it("replaces every repeated occurrence of a secret in one string", () => {
    const redactor = createRedactor(["repeatedsecret1"]);
    const input = {
      text: "repeatedsecret1 and again repeatedsecret1 and once more repeatedsecret1",
    };
    const result = redactor.redact(input);
    expect(result.text).toBe("[REDACTED] and again [REDACTED] and once more [REDACTED]");
    expect(result.text.includes("repeatedsecret1")).toBe(false);
  });

  it("replaces a secret embedded inside a longer token", () => {
    const redactor = createRedactor(["sk-abcdefg1"]);
    const input = { header: "Bearer sk-abcdefg1xyz789" };
    const result = redactor.redact(input);
    expect(result.header).toBe("Bearer [REDACTED]xyz789");
  });

  it("only replaces the secrets actually present in a given string", () => {
    const redactor = createRedactor(["presentsecret1", "absentsecret99"]);
    const input = { text: "value presentsecret1 only" };
    const result = redactor.redact(input);
    expect(result.text).toBe("value [REDACTED] only");
  });

  it("does not turn every string into a marker when the secret list is empty", () => {
    const redactor = createRedactor([]);
    const input = { text: "nothing secret here", n: 1 };
    const result = redactor.redact(input);
    expect(result.text).toBe("nothing secret here");
    expect(result.n).toBe(1);
  });

  it("drops secrets shorter than minLength so short values are not matched", () => {
    const redactor = createRedactor(["ab", "cd"], { minLength: 8 });
    const input = { text: "ab cd should stay untouched" };
    const result = redactor.redact(input);
    expect(result.text).toBe("ab cd should stay untouched");
  });

  it("accepts an explicit minLength override to include a shorter secret", () => {
    const redactor = createRedactor(["short12"], { minLength: 3 });
    const input = { text: "value=short12" };
    const result = redactor.redact(input);
    expect(result.text).toBe("value=[REDACTED]");
  });

  it("accepts an options object with no minLength and falls back to the default", () => {
    const redactor = createRedactor(["defaultlength1"], {});
    const input = { text: "defaultlength1" };
    const result = redactor.redact(input);
    expect(result.text).toBe("[REDACTED]");
  });

  it("ignores an empty-string secret so it cannot match every character", () => {
    const redactor = createRedactor(["", "realsecret123"]);
    const input = { text: "prefix realsecret123 suffix" };
    const result = redactor.redact(input);
    expect(result.text).toBe("prefix [REDACTED] suffix");
  });

  it("leaves non-string leaves (number, boolean, undefined, null) untouched", () => {
    const redactor = createRedactor(["longsecretvalue"]);
    const input = {
      n: 42,
      b: true,
      u: undefined as string | undefined,
      nil: null as string | null,
    };
    const result = redactor.redact(input);
    expect(result.n).toBe(42);
    expect(result.b).toBe(true);
    expect(result.u).toBeUndefined();
    expect(result.nil).toBeNull();
  });

  it("is idempotent: redacting an already-redacted value is a no-op", () => {
    const redactor = createRedactor(["idempotentsecret"]);
    const input = { text: "value idempotentsecret here", nested: { again: "idempotentsecret" } };
    const once = redactor.redact(input);
    const twice = redactor.redact(once);
    expect(twice).toEqual(once);
    expect(twice.text).toBe("value [REDACTED] here");
  });

  it("does not mutate the input value", () => {
    const redactor = createRedactor(["mutationsecret1"]);
    const input = { outer: { text: "mutationsecret1" }, list: ["mutationsecret1"] };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactor.redact(input);
    expect(input).toEqual(snapshot);
  });

  it("names the collateral-redaction risk: a secret that is a substring of an ordinary word", () => {
    const redactor = createRedactor(["lighthouse"]);
    const input = { text: "the lighthouses guided every ship" };
    const result = redactor.redact(input);
    expect(result.text).toBe("the [REDACTED]s guided every ship");
  });
});

describe("assumeRedacted", () => {
  it("returns the value unchanged, tagged as Redacted, for reason 'test'", () => {
    const value = { fixture: "value" };
    const result = assumeRedacted(value, "test");
    expect(result).toBe(value);
  });

  it("returns the value unchanged, tagged as Redacted, for reason 'fake_sandbox'", () => {
    const value = { fixture: "value" };
    const result = assumeRedacted(value, "fake_sandbox");
    expect(result).toBe(value);
  });
});

describe("Redacted<T> compile-time brand", () => {
  function requiresRedacted(value: Redacted<{ token: string }>): string {
    return value.token;
  }

  it("accepts a properly redacted value", () => {
    const redactor = createRedactor(["irrelevant-secret-value"]);
    const redacted = redactor.redact({ token: "abc" });
    expect(requiresRedacted(redacted)).toBe("abc");
  });

  it("rejects a plain, unredacted value where Redacted<T> is required", () => {
    // @ts-expect-error a plain value must not be assignable to Redacted<T>;
    // without the brand this directive would itself fail to compile.
    const rejected = requiresRedacted({ token: "abc" });
    expect(typeof rejected).toBe("string");
  });
});

describe("unprotectedCount", () => {
  it("is zero when every supplied value is long enough to match", () => {
    const redactor = createRedactor(["supersecretvalue", "anotherlongsecret"]);

    expect(redactor.unprotectedCount).toBe(0);
  });

  it("counts values too short to match, so a caller can see the control failing open", () => {
    const redactor = createRedactor(["supersecretvalue", "short", "tiny"]);

    expect(redactor.unprotectedCount).toBe(2);
  });

  it("does not count a duplicate twice", () => {
    const redactor = createRedactor(["short", "short"]);

    expect(redactor.unprotectedCount).toBe(1);
  });

  it("ignores empty values entirely rather than counting them as unprotected", () => {
    const redactor = createRedactor(["", "supersecretvalue"]);

    expect(redactor.unprotectedCount).toBe(0);
  });
});
