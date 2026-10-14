/**
 * The one list of secret shapes this repository refuses to commit or ship,
 * shared by the pre-commit hook (every staged file) and the bundle scanner
 * (build output only).
 *
 * A pattern matches a secret's value, never its name: the Clerk SDK's own
 * error strings name `CLERK_SECRET_KEY`. Each pattern is anchored on something
 * a real secret has and a mention of one does not, because minified bundles
 * and this repository's source both name these shapes.
 */

/**
 * A PEM private-key header followed by at least 40 base64 characters. Source
 * must be able to name the header (`worker/github/app.ts` slices keys with
 * it), and a real key's body always follows while a marker constant is
 * followed by a quote or interpolation. The separator also accepts an escaped
 * `\\n`, the form `.dev.vars` holds, which is why this is a regex over the
 * whole text rather than a line-based `grep`. Requiring PRIVATE keeps Clerk's
 * public key, which the hosted Worker's config carries, from matching.
 */
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{40,}/;

export const SECRET_PATTERNS = [
  { name: "PEM private key", pattern: PEM_PRIVATE_KEY_BLOCK },
  // Clerk.
  { name: "Clerk secret key", pattern: /\b(sk_test_|sk_live_)[A-Za-z0-9]{8,}/ },
  // Anthropic: sk-ant-api03-..., and the shorter sk-ant- forms.
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  // OpenAI's project and service-account keys, plus the legacy fixed-length
  // form, which is exactly 48 alphanumerics after the prefix.
  { name: "OpenAI project key", pattern: /\bsk-(proj|svcacct)-[A-Za-z0-9_-]{16,}/ },
  { name: "OpenAI legacy key", pattern: /\bsk-[A-Za-z0-9]{48}\b/ },
  // GitHub installation (ghs_), user-to-server (ghu_), OAuth (gho_), and
  // personal-access (ghp_) tokens.
  { name: "GitHub token", pattern: /\b(ghs|ghu|gho|ghp)_[A-Za-z0-9]{16,}/ },
];

/**
 * A scanner's source contains the shapes it scans for, so it would match
 * itself. Only files whose job is to name these shapes belong here;
 * `secret-patterns.test.mjs` proves every pattern still catches a real secret.
 */
export const SELF_EXEMPT_PATHS = new Set([
  ".husky/pre-commit",
  "apps/web/scripts/secret-patterns.mjs",
  "apps/web/scripts/secret-patterns.test.mjs",
  "apps/web/scripts/check-staged-secrets.mjs",
  "apps/web/scripts/check-no-secret-in-bundle.mjs",
]);

/** The name of the first shape found, or `null`. Never the matched text: that would print the secret. */
export function findSecretIn(text) {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}
