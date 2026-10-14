/**
 * A session's task branch name and how one is judged. Record 07 names branches
 * `oncue/<slug>-<4 hex>`, chosen at the first push, so a session that never
 * pushes leaves no branch. Shared because the browser suggests the name, the
 * Worker validates and records it, and the bridge refuses a push to any other
 * ref.
 */
import { check, pipe, string } from "valibot";

export const BRANCH_PREFIX = "oncue/";
export const SLUG_MAX_LENGTH = 32;
export const FALLBACK_SLUG = "task";
export const BRANCH_NAME_MAX_LENGTH = 96;

/**
 * Lowercase ASCII letters and digits joined by single hyphens, trimmed at both
 * ends, at most `SLUG_MAX_LENGTH` long. The trailing trim runs twice because
 * the length cut can land on a hyphen. Leading filler ("please", "can you")
 * is dropped.
 */
export function deriveBranchSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(
      /^(?:(?:hello|hi|hey|great|ok|okay|please|can you|could you|i want you to|i would like you to)[\s,.!]+)+/,
      "",
    )
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  if (slug.length === 0) {
    return FALLBACK_SLUG;
  }
  return slug;
}

/**
 * `oncue/` (the prefix the push webhook's incident rule recognises) followed
 * by a ref git-check-ref-format accepts, short enough for a pull request
 * title.
 */
export function isBranchName(name: string): boolean {
  return (
    name.startsWith(BRANCH_PREFIX) &&
    name.length > BRANCH_PREFIX.length &&
    name.length <= BRANCH_NAME_MAX_LENGTH &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    name.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"))
  );
}

export const branchName = pipe(
  string(),
  check(isBranchName, "a branch name is oncue/ followed by a ref-safe slug"),
);
