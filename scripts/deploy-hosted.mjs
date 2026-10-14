/**
 * Deploys the hosted Worker.
 *
 * It refuses unless `ONCUE_ENV=hosted`, like every `:hosted` script. It also
 * reads the config the build actually produced and refuses unless that says
 * "hosted": the provider and GitHub origin resolvers honour test-double
 * overrides only in "local", so a Worker that inherited the local vars could
 * be pointed at a fake GitHub or model provider. Checking the built file
 * catches a wrong environment block, a skipped build, and a stale `dist`.
 *
 * The deployment's own database, bucket, and Clerk application come from the
 * gitignored `apps/web/deployment.json`. This joins them with the tracked
 * `wrangler.jsonc` into `apps/web/wrangler.hosted.json` and builds from that.
 *
 * With `@cloudflare/vite-plugin` the environment is chosen at build time with
 * `CLOUDFLARE_ENV`, and the build emits a config flattened to that
 * environment, so its top-level `vars` are what the deployed Worker reads.
 * `wrangler deploy` then takes no `--env`.
 *
 * Order: the deployment file, checks, build, verify the artifact
 * (environment, database binding, and the three bundle guards), then deploy,
 * because the deploy is the one step a file edit cannot undo.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HOSTED_CONFIG,
  HOSTED_ENV,
  writeHostedConfig,
} from "../apps/web/scripts/hosted-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = `${repoRoot}apps/web`;
const builtConfigPath = `${webRoot}/dist/oncue_web/wrangler.json`;

if (process.env.ONCUE_ENV !== "hosted") {
  console.error("refusing: ONCUE_ENV is not hosted");
  process.exit(1);
}

/**
 * Before the checks, so a missing or half-filled deployment file is refused
 * in a second instead of after the whole suite.
 */
let deployment;
try {
  deployment = writeHostedConfig();
} catch (error) {
  console.error(`refusing: ${error.message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n[deploy-hosted] ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
}

function commitSha() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
}

const release = commitSha();
console.log(`[deploy-hosted] release ${release}`);

run("pnpm", ["check"]);
// `CLOUDFLARE_ENV`, not `--env`: the plugin selects the environment here and
// emits a config flattened to it. Vite inlines the client's Clerk key at
// build time, and the deployment file is its one source, so the client and
// the Worker's `CLERK_JWT_KEY` always name the same Clerk application.
run("pnpm", ["--filter", "@oncue/web", "exec", "vite", "build"], {
  env: {
    ...process.env,
    CLOUDFLARE_ENV: HOSTED_ENV,
    ONCUE_WRANGLER_CONFIG: HOSTED_CONFIG,
    VITE_CLERK_PUBLISHABLE_KEY: deployment.clerkPublishableKey,
  },
});

/**
 * The build flattened the config, so these top-level `vars` are what the
 * deployed Worker reads.
 */
const built = JSON.parse(readFileSync(builtConfigPath, "utf8"));
if (built.vars?.ONCUE_ENV !== "hosted") {
  console.error(
    `refusing: the built Worker declares ONCUE_ENV=${JSON.stringify(built.vars?.ONCUE_ENV)}, not "hosted".`,
  );
  console.error(
    'The provider and GitHub origin overrides are ignored only when the environment is not "local", so deploying this would put a Worker on the public internet that can be redirected to a test double.',
  );
  console.error(
    "The build did not read apps/web/wrangler.hosted.json with CLOUDFLARE_ENV=hosted; check that apps/web/vite.config.ts still honours ONCUE_WRANGLER_CONFIG.",
  );
  process.exit(1);
}

// The exact id, not merely a real-looking one: a stale `dist` from another
// deployment file would otherwise ship a Worker bound to someone else's data.
const builtDatabaseIds = (built.d1_databases ?? []).map((database) => database.database_id);
if (builtDatabaseIds.length !== 1 || builtDatabaseIds[0] !== deployment.d1DatabaseId) {
  console.error(
    `refusing: the built Worker binds database ${JSON.stringify(builtDatabaseIds)}, not the "d1DatabaseId" in apps/web/deployment.json.`,
  );
  process.exit(1);
}

// The bundle guards `pnpm build` ends in: no dev inspector route, no dev
// harness, no secret or `.dev.vars` among the served files. This script calls
// `vite build` directly to choose the environment, so it runs them itself.
for (const guard of [
  "check-no-dev-inspect.mjs",
  "check-no-dev-harness.mjs",
  "check-no-secret-in-bundle.mjs",
]) {
  run("node", [`scripts/${guard}`], { cwd: webRoot });
}

// No `--env`: the config is already flattened to hosted, and wrangler
// validates that what it is deploying matches what was built.
run("pnpm", [
  "--filter",
  "@oncue/web",
  "exec",
  "wrangler",
  "deploy",
  "--var",
  `ONCUE_RELEASE:${release}`,
]);

console.log(`\n[deploy-hosted] deployed release=${release}`);
console.log(
  "[deploy-hosted] this deployed the Worker only. Database migrations and the sandbox controller are separate steps (docs/self-hosting/operations.md), and nothing here tests the deployment end to end.",
);
console.log(
  "[deploy-hosted] confirm the deployed Worker with: curl https://<your-worker-url>/api/health — it must report env=hosted",
);
