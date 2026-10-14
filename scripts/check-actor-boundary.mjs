import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const searchRoot = join(repoRoot, "apps/web");
const authDirectory = join(repoRoot, "apps/web/worker/auth");
const guardedExport = "constructActor";

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "coverage" ||
      entry === ".wrangler"
    ) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const offenders = sourceFiles(searchRoot)
  .filter((path) => !path.startsWith(authDirectory))
  .filter((path) => readFileSync(path, "utf8").includes(guardedExport))
  .map((path) => relative(repoRoot, path));

if (offenders.length > 0) {
  console.error(
    `[check-actor-boundary] ${guardedExport} is reachable outside apps/web/worker/auth, so a caller could mint an Actor without authenticating:`,
  );
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  console.error(
    "An Actor may only be built by the module that verified the session. Take one as a parameter instead.",
  );
  process.exit(1);
}

console.log(`[check-actor-boundary] ${guardedExport} is confined to apps/web/worker/auth`);

// Record 08: nothing in the session lifecycle may snapshot a sandbox's
// filesystem while development secrets exist, because a snapshot would copy
// /var/lib/oncue/secrets into provider storage beyond OnCue's redaction,
// revocation, and deletion.
const snapshotCall = "createCheckpoint";
const sandboxDirectory = join(repoRoot, "apps/web/worker/sandbox");
const snapshotCallers = sourceFiles(join(repoRoot, "apps/web/worker"))
  .filter((path) => !path.startsWith(sandboxDirectory))
  .filter((path) => !/\.test\.tsx?$/.test(path) && !path.includes("/worker/test/"))
  .filter((path) => readFileSync(path, "utf8").includes(snapshotCall))
  .map((path) => relative(repoRoot, path));

if (snapshotCallers.length > 0) {
  console.error(
    `[check-actor-boundary] ${snapshotCall} is called outside apps/web/worker/sandbox, so a sandbox holding development secrets could be snapshotted with them inside:`,
  );
  for (const caller of snapshotCallers) {
    console.error(`  ${caller}`);
  }
  console.error(
    "Record 08: a filesystem snapshot must not capture /var/lib/oncue/secrets. Clear the secrets first, or exclude them, and update this guard with the decision.",
  );
  process.exit(1);
}

console.log(`[check-actor-boundary] ${snapshotCall} is not called by the session lifecycle`);
