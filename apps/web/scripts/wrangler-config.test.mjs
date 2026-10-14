// @vitest-environment node
// Wrangler bundles esbuild, which refuses to load under jsdom's TextEncoder.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { BASE_CONFIG, buildHostedConfig, HOSTED_ENV, readBaseConfig } from "./hosted-config.mjs";

/**
 * These read both configs through Wrangler's own resolver, as a deploy does,
 * because a named environment inherits some keys and not others.
 */
const SWEEP_CRON = "*/5 * * * *";

const DEPLOYMENT = {
  d1DatabaseName: "example-db",
  d1DatabaseId: "11111111-2222-4333-8444-555555555555",
  r2BucketName: "example-artifacts",
  clerkPublishableKey: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  clerkJwtKey: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey,
};

function resolved(config, env) {
  return unstable_readConfig({ config, env }, { hideWarnings: true });
}

/** The generated config, written where Wrangler can read it as a deploy would. */
function hostedConfigFile() {
  const path = join(mkdtempSync(join(tmpdir(), "oncue-wrangler-")), "wrangler.hosted.json");
  writeFileSync(path, JSON.stringify(buildHostedConfig(readBaseConfig(), DEPLOYMENT)));
  return path;
}

describe("the tracked wrangler.jsonc", () => {
  const raw = readBaseConfig();

  it("describes the local environment and no deployment", () => {
    expect(raw.env).toBeUndefined();
    expect(raw.vars.ONCUE_ENV).toBe("local");
    expect(raw.d1_databases).toEqual([
      { binding: "DB", database_name: "oncue-local", database_id: "local-placeholder-db-id" },
    ]);
  });

  it("carries no Clerk application's key", () => {
    expect(raw.vars.CLERK_JWT_KEY).toBe("");
  });

  it("runs the stuck-session sweep every five minutes", () => {
    const config = resolved(BASE_CONFIG, undefined);
    expect(config.vars.ONCUE_ENV).toBe("local");
    expect(config.triggers.crons).toEqual([SWEEP_CRON]);
  });
});

describe("the generated hosted config", () => {
  const local = resolved(BASE_CONFIG, undefined);
  const hosted = resolved(hostedConfigFile(), HOSTED_ENV);

  it("resolves the hosted environment, not a fallback to the top level", () => {
    expect(hosted.name).toBe("oncue-web-hosted");
    expect(hosted.vars.ONCUE_ENV).toBe("hosted");
  });

  it("binds the deployment's own database, bucket, and Clerk key", () => {
    expect(hosted.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: DEPLOYMENT.d1DatabaseName,
        database_id: DEPLOYMENT.d1DatabaseId,
      },
    ]);
    expect(hosted.r2_buckets).toEqual([
      { binding: "ARTIFACTS", bucket_name: DEPLOYMENT.r2BucketName },
    ]);
    expect(hosted.vars.CLERK_JWT_KEY).toBe(DEPLOYMENT.clerkJwtKey);
  });

  it("uses the binding names the local config uses", () => {
    const names = (bindings) => bindings.map((entry) => entry.binding);
    expect(names(hosted.d1_databases)).toEqual(names(local.d1_databases));
    expect(names(hosted.r2_buckets)).toEqual(names(local.r2_buckets));
  });

  it("leaves the allowlist to a secret, which a var of the same name would overwrite", () => {
    expect(hosted.vars).not.toHaveProperty("ONCUE_USER_ALLOWLIST");
    expect(Object.keys(hosted.vars).sort()).toEqual([
      "CLERK_JWT_KEY",
      "ONCUE_ENV",
      "ONCUE_RELEASE",
    ]);
  });

  it("runs the same sweep, session object, and object migrations as local", () => {
    expect(hosted.triggers.crons).toEqual([SWEEP_CRON]);
    expect(hosted.durable_objects).toEqual(local.durable_objects);
    expect(hosted.migrations).toEqual(local.migrations);
  });

  it("inherits what the Worker is built from and how it is observed", () => {
    expect(hosted.compatibility_date).toBe(local.compatibility_date);
    expect(hosted.compatibility_flags).toEqual(local.compatibility_flags);
    expect(hosted.assets.not_found_handling).toBe("single-page-application");
    expect(hosted.assets.run_worker_first).toEqual(local.assets.run_worker_first);
    expect(hosted.observability).toEqual(local.observability);
  });

  it("leaves the top level local, so a build that forgets the environment is refused", () => {
    expect(resolved(hostedConfigFile(), undefined).vars.ONCUE_ENV).toBe("local");
  });

  it("refuses a tracked config that has grown an environment of its own", () => {
    expect(() => buildHostedConfig({ ...readBaseConfig(), env: {} }, DEPLOYMENT)).toThrow(
      "declares `env`",
    );
  });
});
