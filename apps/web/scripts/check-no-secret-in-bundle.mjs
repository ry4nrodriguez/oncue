import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSecretIn } from "./secret-patterns.mjs";

/**
 * The shapes come from `secret-patterns.mjs`, shared with
 * `check-staged-secrets.mjs`, which scans staged files; this scans build
 * output.
 */
const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

function filesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

/**
 * The Cloudflare Vite plugin copies `.dev.vars`, which holds the broker
 * keyring, beside the built Worker. Only `dist/client` is published as
 * assets; this asserts the file never lands there.
 */
const servedDirectory = fileURLToPath(new URL("../dist/client", import.meta.url));
const servedDevVars = filesUnder(servedDirectory).filter((path) => path.endsWith(".dev.vars"));
if (servedDevVars.length > 0) {
  console.error("[check-no-secret-in-bundle] .dev.vars reached the PUBLICLY SERVED assets:");
  for (const path of servedDevVars) {
    console.error(`  ${path}`);
  }
  process.exit(1);
}

/**
 * `.dev.vars` is skipped by the value scan only. It is gitignored, outside the
 * published assets (checked above), and not uploaded by `wrangler deploy`, and
 * a developer's real key in it is not a leak.
 */
function isLocalDevVars(path) {
  return path.endsWith(".dev.vars");
}

let scanned = 0;
const leaking = [];
for (const path of filesUnder(distDirectory)) {
  if (isLocalDevVars(path)) {
    continue;
  }
  scanned += 1;
  const found = findSecretIn(readFileSync(path, "utf8"));
  if (found !== null) {
    leaking.push({ path, found });
  }
}

if (leaking.length > 0) {
  console.error("[check-no-secret-in-bundle] a secret shape reached the build output:");
  for (const { path, found } of leaking) {
    console.error(`  ${path}: ${found}`);
  }
  process.exit(1);
}

console.log(
  `[check-no-secret-in-bundle] no secret key value in ${scanned} built files, and no .dev.vars among the served assets`,
);
