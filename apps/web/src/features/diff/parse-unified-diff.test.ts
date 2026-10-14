import { describe, expect, it } from "vitest";
import { countDiffLines, diffRows, parseUnifiedDiff, unquotePath } from "./parse-unified-diff";

const MODIFIED = [
  "diff --git a/app/page.tsx b/app/page.tsx",
  "index 1111111..2222222 100644",
  "--- a/app/page.tsx",
  "+++ b/app/page.tsx",
  "@@ -3,4 +3,5 @@ export default function Page() {",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
  " }",
  "@@ -20,2 +21,2 @@",
  " one",
  "-two",
  "+deux",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads a modified file's hunks with old and new line numbers", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file?.path).toBe("app/page.tsx");
    expect(file?.status).toBe("modified");
    expect(file?.additions).toBe(3);
    expect(file?.deletions).toBe(2);
    expect(file?.hunks).toHaveLength(2);
    const first = file?.hunks[0];
    expect(first?.section).toBe("export default function Page() {");
    expect(
      first?.lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text]),
    ).toEqual([
      ["context", 3, 3, "  const a = 1;"],
      ["removed", 4, null, "  const b = 2;"],
      ["added", null, 4, "  const b = 3;"],
      ["added", null, 5, "  const c = 4;"],
      ["context", 5, 6, "  return a;"],
      ["context", 6, 7, "}"],
    ]);
  });

  it("collapses the unchanged lines before and between hunks into gap rows", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    const rows = diffRows(file as NonNullable<typeof file>);
    const gaps = rows.filter((row) => row.kind === "gap").map((row) => row.count);
    // Lines 1-2 before the first hunk; new lines 8-20 between the hunks.
    expect(gaps).toEqual([2, 13]);
    expect(rows[0]).toMatchObject({ kind: "gap", count: 2 });
    expect(rows.at(-1)).toMatchObject({ kind: "line" });
  });

  it("counts a pure deletion hunk's gap from the line before it", () => {
    const [file] = parseUnifiedDiff(
      [
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -5,2 +4,0 @@",
        "-gone",
        "-also gone",
        "@@ -9 +7 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    const gaps = diffRows(file as NonNullable<typeof file>)
      .filter((row) => row.kind === "gap")
      .map((row) => row.count);
    expect(gaps).toEqual([4, 2]);
    expect(file?.hunks[1]?.oldLines).toBe(1);
  });

  it("reads added, deleted, renamed, and binary files", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const a = 1;",
      "+export const b = 2;",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 90%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.map((file) => [file.path, file.status, file.binary])).toEqual([
      ["new.ts", "added", false],
      ["old.ts", "deleted", false],
      ["src/after.ts", "renamed", false],
      ["logo.png", "modified", true],
    ]);
    expect(files[0]?.hunks[0]?.lines[1]?.newNumber).toBe(2);
    expect(
      diffRows(files[0] as NonNullable<(typeof files)[0]>).every((row) => row.kind === "line"),
    ).toBe(true);
    expect(files[1]?.oldPath).toBe("old.ts");
    expect(files[1]?.newPath).toBeNull();
    expect(countDiffLines(files)).toBe(3);
  });

  it("never mistakes a removed line starting with dashes for a file header", () => {
    const patch = [
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,2 @@",
      "--- not a header",
      "+++ not a header either",
      " kept",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "removed",
      "added",
      "context",
    ]);
    expect(files[0]?.hunks[0]?.lines[0]?.text).toBe("-- not a header");
  });

  it("starts a new file at a second header pair when there are no git lines", () => {
    const patch = [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    expect(parseUnifiedDiff(patch).map((file) => file.path)).toEqual(["one.txt", "two.txt"]);
  });

  it("marks a line followed by no newline at end of file, and accepts CRLF and bare empty context", () => {
    const patch = [
      "--- a/a.txt\r",
      "+++ b/a.txt\r",
      "@@ -1,3 +1,3 @@\r",
      " first\r",
      "",
      "-last",
      "\\ No newline at end of file",
      "+last!",
      "\\ No newline at end of file",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => [line.kind, line.text, line.noNewlineAtEnd])).toEqual([
      ["context", "first", false],
      ["context", "", false],
      ["removed", "last", true],
      ["added", "last!", true],
    ]);
  });

  it("stops a hunk that is shorter than its header claims, and skips noise", () => {
    const patch = [
      "garbage before any file",
      "diff --git a/a.txt b/a.txt",
      "@@ -1,5 +1,5 @@",
      " one",
      "?? unexpected",
      "@@ -9 +9 @@",
      "-x",
      "+y",
      "\\ No newline at end of file",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]?.lines).toHaveLength(1);
    expect(file?.hunks[1]?.lines.at(-1)?.noNewlineAtEnd).toBe(true);
  });

  it("ignores a stray no-newline marker with nothing before it", () => {
    const [file] = parseUnifiedDiff(
      ["--- a/a", "+++ b/a", "@@ -1 +1 @@", "\\ No newline at end of file", "-a", "+b"].join("\n"),
    );
    expect(file?.hunks[0]?.lines).toHaveLength(2);
    const [other] = parseUnifiedDiff(["--- a/b", "+++ b/b", "@@ -0,0 +0,0 @@", "\\ x"].join("\n"));
    expect(other?.hunks[0]?.lines).toHaveLength(0);
  });

  it("reads quoted, spaced, and unusual git header paths", () => {
    const files = parseUnifiedDiff(
      [
        'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
        "diff --git a/with space.txt b/with space.txt",
        "diff --git a/one b/two/three",
        "diff --git a/lonely",
        "diff --git a/x b/y",
      ].join("\n"),
    );
    expect(files.map((file) => file.path)).toEqual([
      'café "x".txt',
      "with space.txt",
      "two/three",
      "lonely",
      "y",
    ]);
    expect(files[2]?.status).toBe("renamed");
  });

  it("drops a file whose paths are both /dev/null", () => {
    expect(parseUnifiedDiff("--- /dev/null\n+++ /dev/null\n")).toEqual([]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("unquotePath", () => {
  it("decodes C escapes and leaves plain paths alone", () => {
    expect(unquotePath("plain/path.ts")).toBe("plain/path.ts");
    expect(unquotePath('"tab\\there\\\\back\\q"')).toBe("tab\there\\backq");
    expect(unquotePath('"')).toBe('"');
  });
});
