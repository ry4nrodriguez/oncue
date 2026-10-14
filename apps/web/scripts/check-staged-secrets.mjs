/**
 * The staged-file half of the secret check, called by `.husky/pre-commit`.
 * It reads the staged list from git so a filename with a space stays one
 * path. The shapes come from `secret-patterns.mjs`, shared with the bundle
 * scan. Only the shape's name is printed, never the matched text.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { findSecretIn, SELF_EXEMPT_PATHS } from "./secret-patterns.mjs";

function stagedFiles() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"],
    {
      encoding: "utf8",
    },
  );
  return output.split("\0").filter((path) => path.length > 0);
}

/**
 * A staged path may be deleted from the working tree or be a submodule;
 * either is skipped, since there is nothing to scan.
 */
function readIfFile(path) {
  try {
    if (!statSync(path).isFile()) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const blocked = [];
let scanned = 0;
for (const path of stagedFiles()) {
  if (SELF_EXEMPT_PATHS.has(path)) {
    continue;
  }
  const text = readIfFile(path);
  if (text === null) {
    continue;
  }
  scanned += 1;
  const found = findSecretIn(text);
  if (found !== null) {
    blocked.push({ path, found });
  }
}

if (blocked.length > 0) {
  console.error("[check-staged-secrets] a secret shape is staged:");
  for (const { path, found } of blocked) {
    console.error(`  ${path}: ${found}`);
  }
  console.error("commit blocked: remove the secret before committing");
  process.exit(1);
}

console.log(`[check-staged-secrets] no secret shape in ${scanned} staged files`);
