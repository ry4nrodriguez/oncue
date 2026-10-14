/**
 * GitHub's two origins: the REST API on `api.github.com`, and the install page
 * and OAuth exchange on `github.com`. The local override points both at the
 * GitHub double and is never honored on a hosted deploy, where redirecting
 * GitHub traffic would defeat the credential boundary.
 */

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";

/**
 * `envName` is a plain `string` because `env.ONCUE_ENV` is typed as the
 * literal `"local"`, which would make the other branch unreachable to tests.
 * One override serves both origins: the double serves both path spaces on one
 * origin, and a hosted deploy never reaches this arm.
 */
export function resolveGitHubOrigin(
  real: string,
  envName: string,
  override: string | undefined,
): string {
  if (envName !== "local") {
    return real;
  }
  // Empty counts as absent: tests blank inherited `.dev.vars` values with "",
  // and returning "" would give every request an empty origin.
  if (override === undefined || override.trim().length === 0) {
    return real;
  }
  return override;
}
