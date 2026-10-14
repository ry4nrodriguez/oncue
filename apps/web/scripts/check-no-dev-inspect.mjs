#!/usr/bin/env node
// `pnpm build` has a single entry point (index.html), so `src/dev/**` never
// enters the build graph; this walks the actual output and fails if the
// dev-only inspector route ever reaches what the hosted environment serves.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const NEEDLE = "dev/inspect";

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

let distExists = true;
try {
  statSync(distDir);
} catch {
  distExists = false;
}

if (!distExists) {
  console.error(`[check-no-dev-inspect] ${distDir} does not exist; run "pnpm build" first`);
  process.exit(1);
}

// latin1 never throws on decode, so a binary asset is scanned the same way
// as a text one instead of needing a per-file try/catch.
const hits = collectFiles(distDir).filter((file) => readFileSync(file, "latin1").includes(NEEDLE));

if (hits.length > 0) {
  console.error(`[check-no-dev-inspect] found "${NEEDLE}" in the hosted build output:`);
  for (const file of hits) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

console.log(`[check-no-dev-inspect] no "${NEEDLE}" in ${distDir}`);
