/**
 * Cleans a commit message before it reaches `git commit-tree -m` (record 07).
 * The text is usually the model's, so control and format characters (bidi
 * overrides, zero-width characters, terminal escapes) are removed because they
 * can make a message read other than it is; newlines and tabs stay. Every
 * trailer that names a person (`Co-authored-by:`, `Signed-off-by:`, any
 * `...-by:`, `Cc:`) is removed too, because GitHub credits a co-author and the
 * others claim a sign-off nobody gave. Idempotent.
 */

/** What a checkpoint's commit is called when nothing else is left to call it. */
export const FALLBACK_COMMIT_SUBJECT = "Update from OnCue";

const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;
const PERSON_TRAILER = /^\s*(?:[A-Za-z][A-Za-z-]*-by|Cc)\s*:/i;

export function cleanCommitMessage(raw: string): string {
  return raw
    .replace(LINE_BREAKS, "\n")
    .replace(INVISIBLE, (character) => (character === "\n" || character === "\t" ? character : ""))
    .split("\n")
    .filter((line) => !PERSON_TRAILER.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A cleaned message, or the fallback subject when cleaning left nothing. */
export function commitMessageOrFallback(raw: string): string {
  const cleaned = cleanCommitMessage(raw);
  return cleaned === "" ? FALLBACK_COMMIT_SUBJECT : cleaned;
}
