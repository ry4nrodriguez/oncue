/**
 * `apps/web/deployment.json` names the resources one deployment owns: its D1
 * database, its R2 bucket, and its Clerk application. It is gitignored, so
 * whoever deploys fills in their own and never edits a tracked file.
 * `deployment.example.json` is the tracked template.
 *
 * Every value in it is public by construction (resource names, a database
 * id, Clerk's publishable key and JWKS public key). Secrets are set with
 * `pnpm wrangler:hosted secret put` and never belong here, which is why an
 * unknown field is refused instead of ignored.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEPLOYMENT_FILE = fileURLToPath(new URL("../deployment.json", import.meta.url));
export const DEPLOYMENT_EXAMPLE_FILE = fileURLToPath(
  new URL("../deployment.example.json", import.meta.url),
);

export const DEPLOYMENT_FIELDS = [
  "d1DatabaseName",
  "d1DatabaseId",
  "r2BucketName",
  "clerkPublishableKey",
  "clerkJwtKey",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISHABLE_KEY = /^pk_(test|live)_(.+)$/;
const PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/;

/**
 * Reads the file as written, without judging its values, so
 * `pnpm clerk:jwt-key --write` can fill in a file that is not complete yet.
 *
 * @param {string} [path]
 * @returns {Record<string, unknown>}
 */
export function readDeploymentFile(path = DEPLOYMENT_FILE) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      "apps/web/deployment.json does not exist. Copy apps/web/deployment.example.json to it and fill in your own values.",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`apps/web/deployment.json is not valid JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("apps/web/deployment.json must hold one JSON object.");
  }
  return value;
}

/** @param {Record<string, unknown>} value */
export function writeDeploymentFile(value, path = DEPLOYMENT_FILE) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Checks a deployment description and returns it typed. Every problem is
 * reported at once, so a first deploy is not a loop of one refusal at a time.
 *
 * @param {Record<string, unknown>} value
 * @returns {{ d1DatabaseName: string, d1DatabaseId: string, r2BucketName: string, clerkPublishableKey: string, clerkJwtKey: string }}
 */
export function parseDeployment(value) {
  const problems = [];
  for (const key of Object.keys(value)) {
    if (!DEPLOYMENT_FIELDS.includes(key)) {
      problems.push(`unknown field "${key}"`);
    }
  }
  const field = (name) => {
    const entry = value[name];
    return typeof entry === "string" ? entry.trim() : "";
  };
  for (const name of ["d1DatabaseName", "r2BucketName"]) {
    if (field(name) === "") {
      problems.push(`"${name}" is empty`);
    }
  }
  if (!UUID.test(field("d1DatabaseId"))) {
    problems.push('"d1DatabaseId" is not the id `wrangler d1 create` printed');
  }
  if (!PUBLISHABLE_KEY.test(field("clerkPublishableKey"))) {
    problems.push('"clerkPublishableKey" is not a Clerk publishable key (pk_test_… or pk_live_…)');
  }
  // Not trimmed: the PEM's line breaks are part of the key the Worker imports.
  const jwtKey = typeof value.clerkJwtKey === "string" ? value.clerkJwtKey : "";
  if (!PUBLIC_KEY_PEM.test(jwtKey)) {
    problems.push(
      '"clerkJwtKey" is not a PEM public key; run `pnpm clerk:jwt-key --write` to fetch it',
    );
  }
  if (problems.length > 0) {
    throw new Error(`apps/web/deployment.json: ${problems.join("; ")}.`);
  }
  return {
    d1DatabaseName: field("d1DatabaseName"),
    d1DatabaseId: field("d1DatabaseId"),
    r2BucketName: field("r2BucketName"),
    clerkPublishableKey: field("clerkPublishableKey"),
    clerkJwtKey: jwtKey,
  };
}

/** @param {string} [path] */
export function readDeployment(path = DEPLOYMENT_FILE) {
  return parseDeployment(readDeploymentFile(path));
}

/**
 * The host that serves a Clerk application's JWKS. A publishable key is that
 * host, base64-encoded with a trailing `$`, behind the instance-type prefix.
 *
 * @param {string} publishableKey
 * @returns {string}
 */
export function clerkFrontendApi(publishableKey) {
  const match = PUBLISHABLE_KEY.exec(publishableKey.trim());
  if (match === null) {
    throw new Error("not a Clerk publishable key (pk_test_… or pk_live_…)");
  }
  const decoded = Buffer.from(match[2], "base64").toString("utf8");
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
  if (!/^[a-z0-9.-]+\.[a-z]+$/i.test(host)) {
    throw new Error("the publishable key does not decode to a host name");
  }
  return host;
}
