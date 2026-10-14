/**
 * The one place that calls `POST /api/github/install-url` and navigates to
 * the result. The URL is minted fresh per click (a signed `state` with a
 * ten-minute expiry), so no caller may reuse one.
 */
import { useCallback, useState } from "react";
import { requestGitHubInstallUrl } from "@/lib/api/repositories";
import { navigateTo } from "@/lib/navigate";

export type GitHubInstallState = "idle" | "pending" | "unconfigured" | "failed";

export interface GitHubInstall {
  readonly state: GitHubInstallState;
  readonly start: () => void;
}

export function useGitHubInstall(): GitHubInstall {
  const [state, setState] = useState<GitHubInstallState>("idle");

  const start = useCallback(() => {
    setState("pending");
    void requestGitHubInstallUrl().then((result) => {
      if (result.kind === "minted") {
        // Stay "pending" while the browser leaves for GitHub, so the button stays disabled.
        navigateTo(result.installUrl);
        return;
      }
      setState(result.kind === "unconfigured" ? "unconfigured" : "failed");
    });
  }, []);

  return { state, start };
}
