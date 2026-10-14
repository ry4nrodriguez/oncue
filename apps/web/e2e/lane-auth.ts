/**
 * Mints the Clerk-shaped session cookie the tests present to the real Worker.
 * The private key comes from `.dev.vars` (written by `e2e/setup-local-auth.mjs`),
 * so `verifyClerkSession` runs unmodified against a real RS256 signature.
 */

import { createSign, type JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface LaneIdentity {
  readonly subject: string;
  readonly cookie: string;
}

export const SETUP_HINT =
  "run `node apps/web/e2e/setup-local-auth.mjs` first, then let the dev server restart so it reads the new values";

/**
 * A missing file answers with the setup instruction rather than an ENOENT
 * stack. It does not skip: a test that quietly does not run looks like a pass.
 */
export function devVars(): Map<string, string> {
  const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  const entries = new Map<string, string>();
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `the broker lanes need apps/web/.dev.vars and it does not exist; ${SETUP_HINT}`,
    );
  }
  for (const line of contents.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      entries.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return entries;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** `azp` must match the origin the Worker sees, or `clerk.ts` rejects the token. */
export function laneIdentity(origin: string, as?: string): LaneIdentity {
  const vars = devVars();
  const jwk = vars.get("ONCUE_LANE_SIGNING_JWK");
  const subject = as ?? vars.get("ONCUE_LANE_SUBJECT");
  if (jwk === undefined || subject === undefined) {
    throw new Error(`no lane signing key in apps/web/.dev.vars; ${SETUP_HINT}`);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      sub: subject,
      sid: `sess_${subject}`,
      azp: origin,
      iat: issuedAt,
      nbf: issuedAt - 5,
      exp: issuedAt + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer
    .sign({ key: JSON.parse(jwk) as JsonWebKey, format: "jwk", type: "pkcs8" })
    .toString("base64url");

  return { subject, cookie: `__session=${header}.${payload}.${signature}` };
}

/**
 * The cookie `/dev/sign-in` sets, so a browser and a test posting to the API
 * are the same identity. `pnpm dev:fresh` sets `ONCUE_DEV_SUBJECT` to a subject
 * with no rows.
 */
export function devSignInCookie(origin: string, as?: string): LaneIdentity {
  return laneIdentity(origin, as ?? devVars().get("ONCUE_DEV_SUBJECT"));
}

/**
 * Revokes every active model connection the test subject holds, as the revoke
 * route does. Tests that create sessions naming no connection need this,
 * since `resolveModel` allows that only with no active connection, and an
 * interrupted run can leave one behind. No parallel test creates a connection
 * for this subject, so this does not race.
 */
export function laneNoModelConnectionStatement(): string {
  const subject = devVars().get("ONCUE_LANE_SUBJECT");
  if (subject === undefined) {
    throw new Error(`no lane subject in apps/web/.dev.vars; ${SETUP_HINT}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(subject)) {
    throw new Error("the lane subject must be a plain identifier");
  }
  return (
    "UPDATE model_connection SET status = 'revoked', credential_reference = '', " +
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
    "WHERE status = 'active' AND workspace_id IN (SELECT w.id FROM workspace w " +
    "JOIN external_identity e ON e.user_id = w.owner_user_id " +
    `WHERE e.subject = '${subject}')`
  );
}
