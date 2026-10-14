/**
 * Record 13's first-run setup: GitHub (mandatory), a model key (skippable),
 * and Modal (mandatory, since no session runs without sandbox compute).
 * `SetupRoute` navigates home before this ever receives "home", so that
 * branch is only defensive.
 */

import { SignOutButton } from "@clerk/react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { GitHubMark } from "@/components/brand/icons";
import { NEUTRAL_BUTTON_BLOCK } from "@/components/ui/button-classes";
import { AuthFrame, FRAME_LINK } from "@/features/auth/AuthFrame";
import { GitHubInstallButton } from "@/features/repositories/GitHubInstallButton";
import type { GitHubStuckReason } from "@/lib/api/setup";
import type { SetupScreen as SetupScreenState } from "./setup-step";

// Someone who signed in with GitHub must not read "connect GitHub" as a bug, so the copy says they are different grants.
export const CONNECT_GITHUB_LEAD =
  "Repository access is separate from signing in. You pick the repositories on GitHub.";

function Step({
  step,
  title,
  lead,
  icon,
  children,
}: {
  step: string;
  title: string;
  lead?: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AuthFrame
      footer={
        <SignOutButton>
          <button type="button" className={FRAME_LINK}>
            Sign out
          </button>
        </SignOutButton>
      }
    >
      <p className="text-center text-[12px] text-faint">{step}</p>
      {icon}
      <h1 className="mt-2 text-center font-semibold text-[17px] text-text tracking-tight">
        {title}
      </h1>
      {lead !== undefined ? (
        <p className="mt-1.5 text-center text-[13px] text-muted-foreground leading-5">{lead}</p>
      ) : null}
      <div className="mt-6">{children}</div>
    </AuthFrame>
  );
}

function ConnectGitHubCard({ installUrl }: { installUrl: string | null }) {
  return (
    <Step
      step="Step 1 of 3"
      title="Give OnCue access to your repositories"
      lead={CONNECT_GITHUB_LEAD}
    >
      {installUrl !== null ? (
        // `/api/me` does not currently carry an `installUrl` (it is minted per
        // click with a fresh signed `state`); this branch is kept for one that does.
        <a href={installUrl} className={NEUTRAL_BUTTON_BLOCK}>
          <GitHubMark className="size-[17px]" />
          Install the OnCue GitHub App
        </a>
      ) : (
        <GitHubInstallButton className={NEUTRAL_BUTTON_BLOCK} />
      )}
    </Step>
  );
}

export const STUCK_COPY: Record<
  GitHubStuckReason,
  { title: string; body: string; action: string; external: boolean }
> = {
  cancelled: {
    title: "The installation wasn't completed",
    action: "Try again",
    external: false,
    body: "You came back from GitHub before installing. Nothing on your account changed.",
  },
  no_repositories: {
    title: "No repositories were selected",
    action: "Choose repositories on GitHub",
    external: true,
    body: "The app can't see any repositories yet. Pick at least one on GitHub.",
  },
  pending_approval: {
    title: "Waiting on an organization admin",
    action: "Recheck",
    external: false,
    // Record 13: the person cannot resolve this themselves, and the copy says so.
    body: "An organization owner has to approve the app. You can't approve it yourself.",
  },
};

function GitHubStuckCard({ reason, onRetry }: { reason: GitHubStuckReason; onRetry: () => void }) {
  const copy = STUCK_COPY[reason];
  return (
    <Step
      step="Step 1 of 3"
      title={copy.title}
      lead={copy.body}
      icon={<TriangleAlert className="mx-auto mt-4 size-5 text-caution" aria-hidden="true" />}
    >
      <button type="button" onClick={onRetry} className={NEUTRAL_BUTTON_BLOCK}>
        {copy.external ? <ExternalLink className="size-[16px]" aria-hidden="true" /> : null}
        {copy.action}
      </button>
    </Step>
  );
}

function AddModelCard({ onSkip, children }: { onSkip: () => void; children?: ReactNode }) {
  return (
    <Step
      step="Step 2 of 3"
      title="Add a model key"
      lead="OnCue runs on your own provider key. You can add another later."
    >
      {children}
      <button
        type="button"
        onClick={onSkip}
        className="mt-2 w-full rounded-lg px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:text-text"
      >
        Skip for now
      </button>
    </Step>
  );
}

// Step 3, with no skip. Its copy rules live in `modal-connection-copy.ts`.
function ConnectModalCard({ children }: { children?: ReactNode }) {
  return (
    <Step
      step="Step 3 of 3"
      title="Connect your Modal account"
      lead="Sessions run in sandboxes on your own Modal account."
    >
      {children}
    </Step>
  );
}

export interface SetupScreenProps {
  readonly screen: SetupScreenState;
  readonly onRetry: () => void;
  readonly onSkip: () => void;
  readonly children?: ReactNode;
}

export function SetupScreen({ screen, onRetry, onSkip, children }: SetupScreenProps) {
  if (screen.kind === "connect_github") {
    return <ConnectGitHubCard installUrl={screen.installUrl} />;
  }
  if (screen.kind === "github_stuck") {
    return <GitHubStuckCard reason={screen.reason} onRetry={onRetry} />;
  }
  if (screen.kind === "add_model") {
    return <AddModelCard onSkip={onSkip}>{children}</AddModelCard>;
  }
  if (screen.kind === "connect_modal") {
    return <ConnectModalCard>{children}</ConnectModalCard>;
  }
  return null;
}
