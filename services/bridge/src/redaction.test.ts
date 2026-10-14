import { describe, expect, it } from "vitest";
import {
  createSecretRedactor,
  REDACTION_PLACEHOLDER,
  SHORT_REDACTION_PLACEHOLDER,
} from "./redaction";

/** Obviously fake. */
const FAKE = "fake-secret-value-0001";
const OTHER = "fake-other-value-0002";

function redactorWith(...values: string[]) {
  const redactor = createSecretRedactor(64);
  for (const value of values) {
    redactor.add(value);
  }
  return redactor;
}

describe("createSecretRedactor", () => {
  it("changes nothing while it knows no value", () => {
    const redactor = createSecretRedactor(64);
    expect(redactor.text(`echo ${FAKE}`)).toBe(`echo ${FAKE}`);
    expect(redactor.stream("k", FAKE)).toEqual([FAKE]);
    const bytes = Buffer.from(FAKE);
    expect(redactor.bytes(bytes)).toBe(bytes);
  });

  it("replaces every occurrence in text, inside a longer token too, longest value first", () => {
    const redactor = redactorWith(FAKE, `${FAKE}-suffix`);
    expect(redactor.text(`a=${FAKE} b=x${FAKE}-suffixy ${FAKE}`)).toBe(
      `a=${REDACTION_PLACEHOLDER} b=x${REDACTION_PLACEHOLDER}y ${REDACTION_PLACEHOLDER}`,
    );
  });

  it("ignores an empty value, and a repeat", () => {
    const redactor = redactorWith("", FAKE, FAKE);
    expect(redactor.text("plain")).toBe("plain");
    expect(redactor.text(FAKE)).toBe(REDACTION_PLACEHOLDER);
  });

  it("walks objects and arrays without changing the input, and leaves other leaves alone", () => {
    const redactor = redactorWith(FAKE);
    const input = { a: [`x ${FAKE}`, 7, null], b: { c: FAKE, d: true } };
    expect(redactor.deep(input)).toEqual({
      a: [`x ${REDACTION_PLACEHOLDER}`, 7, null],
      b: { c: REDACTION_PLACEHOLDER, d: true },
    });
    expect(input.b.c).toBe(FAKE);
  });

  it("replaces a value in bytes, and leaves bytes that are not text intact around it", () => {
    const redactor = redactorWith(FAKE);
    const binary = Buffer.from([0xff, 0xfe, 0x00]);
    const out = redactor.bytes(
      Buffer.concat([binary, Buffer.from(FAKE), binary, Buffer.from(FAKE)]),
    );
    expect(out.includes(FAKE)).toBe(false);
    expect(out).toEqual(
      Buffer.concat([
        binary,
        Buffer.from(REDACTION_PLACEHOLDER),
        binary,
        Buffer.from(REDACTION_PLACEHOLDER),
      ]),
    );
    const clean = Buffer.from("nothing here");
    expect(redactor.bytes(clean)).toBe(clean);
  });
});

describe("a stream that splits a value across chunks", () => {
  it("holds back a tail that could be the start of a value, and never sends the value", () => {
    const redactor = redactorWith(FAKE);
    const sent = [
      ...redactor.stream("m1", `the key is ${FAKE.slice(0, 9)}`),
      ...redactor.stream("m1", `${FAKE.slice(9)} and more`),
    ];
    expect(sent.join("")).toBe(`the key is ${REDACTION_PLACEHOLDER} and more`);
    expect(sent.join("")).not.toContain(FAKE);
    // Not even the half that arrived first.
    expect(sent.join("")).not.toContain(FAKE.slice(0, 9));
  });

  it("splits a value one character at a time and still never sends it", () => {
    const redactor = redactorWith(FAKE, OTHER);
    const sent: string[] = [];
    for (const character of `a ${FAKE} b ${OTHER} c`) {
      sent.push(...redactor.stream("m1", character));
    }
    expect(sent.join("")).toBe(`a ${REDACTION_PLACEHOLDER} b ${REDACTION_PLACEHOLDER} c`);
  });

  it("lets a held tail go once the next chunk shows it was not a value", () => {
    const redactor = redactorWith(FAKE);
    expect(redactor.stream("m1", "it is fake-")).toEqual(["it is "]);
    expect(redactor.stream("m1", "news")).toEqual(["fake-news"]);
  });

  it("sends nothing for a chunk that is all held back", () => {
    const redactor = redactorWith(FAKE);
    expect(redactor.stream("m1", "fake")).toEqual([]);
  });

  it("keeps each stream's tail apart, and forgets a stream that ended", () => {
    const redactor = redactorWith(FAKE);
    expect(redactor.stream("m1", "fake-")).toEqual([]);
    expect(redactor.stream("m2", "old fake")).toEqual(["old "]);
    redactor.endStreams("m1");
    expect(redactor.stream("m1", "news")).toEqual(["news"]);
    expect(redactor.stream("m2", "-news")).toEqual(["fake-news"]);
  });

  it("never sends a chunk longer than the limit, however much was held back", () => {
    const redactor = createSecretRedactor(16);
    redactor.add(FAKE);
    expect(redactor.stream("m1", FAKE.slice(0, 12))).toEqual([]);
    const sent = redactor.stream("m1", "x".repeat(16));
    expect(sent.join("")).toBe(`${FAKE.slice(0, 12)}${"x".repeat(16)}`);
    expect(sent.every((chunk) => chunk.length <= 16)).toBe(true);
  });

  it("never makes text longer: a value shorter than the marker gets a shorter one", () => {
    const redactor = redactorWith("fakefake");
    expect(redactor.text("a fakefake b")).toBe(`a ${SHORT_REDACTION_PLACEHOLDER} b`);
    expect(SHORT_REDACTION_PLACEHOLDER.length).toBeLessThanOrEqual("fakefake".length);
    expect(redactor.bytes(Buffer.from("fakefake")).toString()).toBe(SHORT_REDACTION_PLACEHOLDER);
  });
});

describe("secretPathsIn", () => {
  const patch = [
    "diff --git a/src/clean.ts b/src/clean.ts",
    "--- a/src/clean.ts",
    "+++ b/src/clean.ts",
    "+const a = 1;",
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.env",
    `+KEY=${FAKE}`,
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    `+see ${OTHER}`,
    "",
  ].join("\n");

  it("names the files whose changes hold a value, and only those", () => {
    expect(redactorWith(FAKE, OTHER).secretPathsIn(patch)).toEqual([".env", "notes.md"]);
    expect(redactorWith(FAKE).secretPathsIn(patch)).toEqual([".env"]);
  });

  it("finds nothing in clean changes, or while it knows no value", () => {
    expect(redactorWith("fake-unrelated-value").secretPathsIn(patch)).toEqual([]);
    expect(createSecretRedactor(64).secretPathsIn(patch)).toEqual([]);
  });

  it("still reports a match in text it cannot attribute to a file", () => {
    expect(redactorWith(FAKE).secretPathsIn(`garbage ${FAKE}`)).toEqual(["(unknown file)"]);
  });

  it("says whether it holds any value", () => {
    expect(createSecretRedactor(64).holdsValues()).toBe(false);
    expect(redactorWith(FAKE).holdsValues()).toBe(true);
  });
});
