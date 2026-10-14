/**
 * The control that starts a GitHub installation, shared by the Repositories
 * screen and the setup card. Each caller supplies its chrome via `className`.
 */
import { GitHubMark } from "@/components/brand/icons";
import { useGitHubInstall } from "./use-github-install";

export interface GitHubInstallButtonProps {
  readonly className: string;
  readonly idleLabel?: string;
}

const UNCONFIGURED_MESSAGE = "GitHub is not configured for this deployment.";
const FAILED_MESSAGE = "OnCue couldn't start the GitHub installation. Try again in a moment.";

export function GitHubInstallButton({
  className,
  idleLabel = "Install the OnCue GitHub App",
}: GitHubInstallButtonProps) {
  const install = useGitHubInstall();

  return (
    <div>
      <button
        type="button"
        onClick={install.start}
        disabled={install.state === "pending"}
        className={className}
      >
        <GitHubMark className="size-[17px]" />
        {install.state === "pending" ? "Opening GitHub…" : idleLabel}
      </button>
      {install.state === "unconfigured" ? (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {UNCONFIGURED_MESSAGE}
        </p>
      ) : null}
      {install.state === "failed" ? (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {FAILED_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}
