/**
 * Runs a Wrangler command against the hosted deployment:
 *
 *   ONCUE_ENV=hosted pnpm wrangler:hosted d1 migrations apply DB --remote
 *   ONCUE_ENV=hosted pnpm wrangler:hosted secret put ONCUE_USER_ALLOWLIST
 *
 * The hosted environment exists only in the generated
 * `apps/web/wrangler.hosted.json`, so a bare `wrangler --env hosted` finds
 * nothing. This regenerates that file from `apps/web/deployment.json` first,
 * so the command always addresses the resources the file names today.
 *
 * It refuses unless `ONCUE_ENV=hosted`, like every `:hosted` script.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOSTED_CONFIG,
  HOSTED_ENV,
  writeHostedConfig,
} from "../apps/web/scripts/hosted-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

if (process.env.ONCUE_ENV !== "hosted") {
  console.error("refusing: ONCUE_ENV is not hosted");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: ONCUE_ENV=hosted pnpm wrangler:hosted <wrangler command and arguments>");
  process.exit(1);
}
// This script owns both, so a second `--env` or `--config` could only point
// the command somewhere other than this deployment.
if (args.some((arg) => /^(--env|-e|--config|-c)(=|$)/.test(arg))) {
  console.error("refusing: --env and --config are set by this script; leave them out");
  process.exit(1);
}
// `pnpm deploy:hosted` deploys: it runs the checks and verifies the build.
if (args[0] === "deploy") {
  console.error(
    "refusing: deploy with `ONCUE_ENV=hosted pnpm deploy:hosted`, which verifies the build first",
  );
  process.exit(1);
}

try {
  writeHostedConfig();
} catch (error) {
  console.error(`refusing: ${error.message}`);
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@oncue/web",
    "exec",
    "wrangler",
    ...args,
    "--env",
    HOSTED_ENV,
    "--config",
    HOSTED_CONFIG,
  ],
  { stdio: "inherit", cwd: repoRoot },
);
process.exit(result.status ?? 1);
