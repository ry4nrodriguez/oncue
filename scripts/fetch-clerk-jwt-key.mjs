import { createPublicKey } from "node:crypto";
import {
  clerkFrontendApi,
  readDeploymentFile,
  writeDeploymentFile,
} from "../apps/web/scripts/deployment.mjs";
import { configuredClerkKey } from "./clerk-key.mjs";

/**
 * Fetches the public key the Worker verifies Clerk sessions with
 * (`CLERK_JWT_KEY`). The Clerk application's host is encoded in its
 * publishable key and its JWKS is public, so this needs no credential.
 *
 *   pnpm clerk:jwt-key           prints the PEM, for `.dev.vars.real`
 *   pnpm clerk:jwt-key --write   saves it as "clerkJwtKey" in
 *                                apps/web/deployment.json
 *
 * The publishable key is read from `apps/web/deployment.json` when that file
 * has one, and otherwise from where the dev server finds it
 * (`./clerk-key.mjs`). Run it again only if Clerk rotates the key.
 */

const write = process.argv.includes("--write");

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The deployment file as written, or null when there is none yet. */
function deploymentFile() {
  try {
    return readDeploymentFile();
  } catch (error) {
    if (write) {
      fail(error.message);
    }
    return null;
  }
}

function publishableKeyFromEnvFiles() {
  const key = configuredClerkKey();
  return key === null ? null : { key, source: "your environment or apps/web/.env.local" };
}

const deployment = deploymentFile();
const fromDeployment =
  typeof deployment?.clerkPublishableKey === "string" && deployment.clerkPublishableKey !== ""
    ? { key: deployment.clerkPublishableKey, source: "apps/web/deployment.json" }
    : null;
if (write && fromDeployment === null) {
  fail('apps/web/deployment.json has no "clerkPublishableKey" yet; fill it in first.');
}
const publishable = fromDeployment ?? publishableKeyFromEnvFiles();
if (publishable === null) {
  fail("no Clerk publishable key found in apps/web/deployment.json or apps/web/.env.local");
}

let host;
try {
  host = clerkFrontendApi(publishable.key);
} catch (error) {
  fail(`${publishable.source}: ${error.message}`);
}

const response = await fetch(`https://${host}/.well-known/jwks.json`);
if (!response.ok) {
  fail(`failed to fetch JWKS from ${host}: ${response.status} ${response.statusText}`);
}

const jwks = await response.json();
const [jwk] = jwks.keys ?? [];
if (jwk === undefined) {
  fail(`JWKS response from ${host} contained no keys`);
}

const pem = createPublicKey({ key: jwk, format: "jwk" })
  .export({ type: "spki", format: "pem" })
  .toString();

// The source goes to stderr, so stdout stays the PEM alone.
console.error(`[clerk:jwt-key] ${host}, from the publishable key in ${publishable.source}`);
if (write) {
  writeDeploymentFile({ ...deployment, clerkJwtKey: pem });
  console.error('[clerk:jwt-key] saved as "clerkJwtKey" in apps/web/deployment.json');
} else {
  console.log(pem);
}
