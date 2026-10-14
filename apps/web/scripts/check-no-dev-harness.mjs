#!/usr/bin/env node
// The dev harnesses (`/dev/session`, `/dev/home`, the app harness) and the
// stand-in for Clerk's browser SDK render app UI with no Clerk gate, which is
// safe only because they never ship. This walks the build output and fails if
// one does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const NEEDLES = [
  "dev/mockups",
  "dev/session-harness",
  "dev/home-harness",
  "dev/app-harness",
  "dev/sign-in",
  "dev/sign-out",
  "dev/clerk-stand-in",
  "local-stand-in",
  "dev/checkout",
  "src/mockups/",
];

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

try {
  statSync(distDir);
} catch {
  console.error("check-no-dev-harness: dist/ not found; run pnpm build first");
  process.exit(1);
}

const offenders = [];
for (const file of collectFiles(distDir)) {
  const text = readFileSync(file, "utf8");
  for (const needle of NEEDLES) {
    if (text.includes(needle)) {
      offenders.push(`${file}: ${needle}`);
    }
  }
}

if (offenders.length > 0) {
  console.error("check-no-dev-harness: dev-only code reached the build output:");
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log("check-no-dev-harness: no dev harness in dist");
