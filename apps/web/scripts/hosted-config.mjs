/**
 * Generates the Wrangler config a hosted deploy uses.
 *
 * The tracked `wrangler.jsonc` describes the local environment only. A
 * deployment's own database, bucket, and Clerk key come from the gitignored
 * `deployment.json` (`./deployment.mjs`), and this joins the two into
 * `wrangler.hosted.json`: the tracked config plus an `env.hosted` block.
 *
 * Wrangler does not inherit `vars`, `d1_databases`, `r2_buckets`,
 * `durable_objects`, or `migrations` into a named environment, so the block
 * restates them. The Durable Object bindings, their migrations, and the cron
 * triggers are copied from the tracked config, so local and hosted cannot
 * drift apart.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { readDeployment } from "./deployment.mjs";

export const BASE_CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
export const HOSTED_CONFIG = fileURLToPath(new URL("../wrangler.hosted.json", import.meta.url));
/** Wrangler appends this to the Worker's name, so it is deployed as `oncue-web-hosted`. */
export const HOSTED_ENV = "hosted";

/** The tracked config as written, before Wrangler resolves an environment. */
export function readBaseConfig(path = BASE_CONFIG) {
  return experimental_readRawConfig({ config: path }).rawConfig;
}

/**
 * @param {Record<string, any>} base the tracked `wrangler.jsonc`
 * @param {ReturnType<typeof import("./deployment.mjs").parseDeployment>} deployment
 */
export function buildHostedConfig(base, deployment) {
  if (base.env !== undefined) {
    throw new Error(
      "apps/web/wrangler.jsonc declares `env`. It describes the local environment only; a deployment's values belong in apps/web/deployment.json.",
    );
  }
  return {
    ...base,
    env: {
      [HOSTED_ENV]: {
        vars: {
          ONCUE_ENV: "hosted",
          // Overwritten per deploy with the commit, so a log line names the
          // revision that produced it.
          ONCUE_RELEASE: "unset",
          CLERK_JWT_KEY: deployment.clerkJwtKey,
          // `ONCUE_USER_ALLOWLIST` is absent, not empty: it is a secret, so
          // widening access leaves a trail outside git, and a var of the same
          // name would overwrite the secret on every deploy.
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: deployment.d1DatabaseName,
            database_id: deployment.d1DatabaseId,
          },
        ],
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: deployment.r2BucketName }],
        durable_objects: base.durable_objects,
        migrations: base.migrations,
        triggers: base.triggers,
      },
    },
  };
}

/**
 * Writes `wrangler.hosted.json` from the tracked config and this checkout's
 * `deployment.json`, and returns the deployment it read.
 */
export function writeHostedConfig() {
  const deployment = readDeployment();
  const config = buildHostedConfig(readBaseConfig(), deployment);
  writeFileSync(HOSTED_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  return deployment;
}
