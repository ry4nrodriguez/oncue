/**
 * The additional-data context a GitHub token is sealed under. GitHub tokens
 * reuse the model-credential envelope and keyring (record 07); separation
 * comes from the additional data, `installation_row_id | workspace_id |
 * github_<kind>`, so a GitHub token presented as a model credential, or a user
 * token presented as a refresh token, fails the AEAD tag.
 *
 * The strings sit in a `Record` over the closed union, so a new kind is a
 * compile error here.
 */

import type { CredentialContext } from "../broker/envelope";

export type GitHubTokenKind = "user_token" | "refresh_token";

const PROVIDER: Readonly<Record<GitHubTokenKind, string>> = {
  user_token: "github_user_token",
  refresh_token: "github_refresh_token",
};

// OnCue's own installation row id, not GitHub's installation id, which can be
// spoofed on a redirect: the envelope must bind to an id this control plane
// minted.
export function githubTokenContext(
  installationRowId: string,
  workspaceId: string,
  kind: GitHubTokenKind,
): CredentialContext {
  return {
    connectionId: installationRowId,
    workspaceId,
    provider: PROVIDER[kind],
  };
}
