import { describe, expect, it } from "vitest";
import {
  cleanCommitMessage,
  commitMessageOrFallback,
  FALLBACK_COMMIT_SUBJECT,
} from "./commit-message";

describe("cleanCommitMessage", () => {
  it.each([
    [
      "an honest message",
      "Fix the redirect\n\nIt looped on 3 paths in chk_test.",
      "Fix the redirect\n\nIt looped on 3 paths in chk_test.",
    ],
    ["CRLF and lone CR", "Fix\r\n\r\nBody\rmore", "Fix\n\nBody\nmore"],
    ["a line separator", "Fix\u2028Body", "Fix\nBody"],
    ["a terminal escape sequence", "Fix \u001b[31mred\u001b[0m", "Fix [31mred[0m"],
    ["a bell and a NUL", "Fix\u0007 it\u0000", "Fix it"],
    ["a right-to-left override", "Fix txt\u202eexe.bat", "Fix txtexe.bat"],
    ["zero-width characters and isolates", "Fi\u200bx\u2066 it\u2069\ufeff", "Fix it"],
    ["tabs in the body", "Fix\n\n\tindented", "Fix\n\n\tindented"],
    [
      "a co-author the model invented",
      "Fix it\n\nBody.\n\nCo-authored-by: Octo Cat <octocat@github.com>",
      "Fix it\n\nBody.",
    ],
    [
      "every person trailer, in any case",
      "Fix\n\nSigned-off-by: A <a@x>\nreviewed-BY: B <b@x>\nAcked-by: C\nTested-by: D\nReported-by: E\nSuggested-by: F\nHelped-by: G\nCc: H <h@x>\n  Co-Authored-By : I",
      "Fix",
    ],
    [
      "a trailer that names no person",
      "Fix\n\nRefs: 12\nChange-Id: I123",
      "Fix\n\nRefs: 12\nChange-Id: I123",
    ],
    [
      "prose that mentions a sign-off",
      "Fix\n\nNo one signed-off-by accident.",
      "Fix\n\nNo one signed-off-by accident.",
    ],
    ["blank lines left by removal", "Fix\n\n\n\nBody\n\nCo-authored-by: x\n\n", "Fix\n\nBody"],
    ["trailing spaces", "Fix   \nBody  ", "Fix\nBody"],
  ])("%s", (_name, raw, expected) => {
    const cleaned = cleanCommitMessage(raw);
    expect(cleaned).toBe(expected);
    expect(cleanCommitMessage(cleaned)).toBe(cleaned);
  });

  it("falls back to a fixed subject when nothing is left", () => {
    expect(commitMessageOrFallback("Co-authored-by: x <x@y>")).toBe(FALLBACK_COMMIT_SUBJECT);
    expect(commitMessageOrFallback("\u202e\u200b")).toBe(FALLBACK_COMMIT_SUBJECT);
    expect(commitMessageOrFallback("Fix it")).toBe("Fix it");
  });
});
