/**
 * Plain-language sentences for each `?github=` reason the install callback
 * (`worker/routes/repositories.ts`) appends on a refusal, and the "Connect
 * GitHub" explanation shared by the setup card and the Repositories screen.
 */

export type GitHubCallbackReason =
  | "cancelled"
  | "pending_approval"
  | "not_visible"
  | "exchange_failed"
  | "state_invalid";

function isGitHubCallbackReason(value: string): value is GitHubCallbackReason {
  return (
    value === "cancelled" ||
    value === "pending_approval" ||
    value === "not_visible" ||
    value === "exchange_failed" ||
    value === "state_invalid"
  );
}

export const GITHUB_CALLBACK_MESSAGE: Record<GitHubCallbackReason, string> = {
  cancelled: "You came back from GitHub without installing the app. Nothing was connected.",
  pending_approval:
    "You installed the app on an organization that requires admin approval. An owner has to approve it before OnCue can see the repositories.",
  not_visible:
    "GitHub didn't show OnCue that installation. Make sure you're signed in as the right GitHub account, then try again.",
  exchange_failed: "OnCue couldn't complete the connection with GitHub. Try again in a moment.",
  state_invalid: "This installation link expired or was already used. Start the connection again.",
};

/** `null` when there is no `?github=` reason, or it isn't one this build recognizes. */
export function githubCallbackMessage(reason: string | null): string | null {
  if (reason === null || !isGitHubCallbackReason(reason)) {
    return null;
  }
  return GITHUB_CALLBACK_MESSAGE[reason];
}

export const CONNECT_GITHUB_POINTS = [
  {
    term: "You choose the repositories",
    detail:
      "Selection happens on GitHub, not here. OnCue can only see what you grant, and you can change it at any time.",
  },
  {
    // Record 13's copy requirement: a user who signed in with GitHub must not read this as a bug.
    term: "Separate from signing in",
    detail:
      "Signing in proved who you are. This grants access to code, which is a separate permission even if you signed in with GitHub.",
  },
] as const;
