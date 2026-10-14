import { SignOutButton } from "@clerk/react";
import { NEUTRAL_BUTTON_BLOCK } from "@/components/ui/button-classes";
import { AuthFrame, FRAME_LINK } from "./AuthFrame";
import { ME_FAILED_MESSAGE } from "./gate";

export interface MeFailedScreenProps {
  /** A request is in flight, automatic or from Retry. */
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

/**
 * Shown when `/api/me` has not answered usably and nothing was on screen yet.
 * The gate keeps retrying on its own; Retry asks now. Sign out is offered
 * because an expired sign-in also lands here.
 */
export function MeFailedScreen({ retrying, onRetry }: MeFailedScreenProps) {
  return (
    <AuthFrame
      testId="auth-failed"
      footer={
        <SignOutButton>
          <button type="button" className={FRAME_LINK}>
            Sign out
          </button>
        </SignOutButton>
      }
    >
      <div role="alert">
        <p className="text-center text-[15px] text-text" data-testid="auth-failed-message">
          {ME_FAILED_MESSAGE}
        </p>
        <p className="mt-2 text-center text-[13px] text-muted-foreground">
          Check your connection. OnCue keeps trying on its own.
        </p>
      </div>
      <button
        type="button"
        className={`${NEUTRAL_BUTTON_BLOCK} mt-5`}
        // Never disabled: an automatic retry must not take focus off the
        // button, and a press while one is out starts a fresh request.
        aria-busy={retrying}
        onClick={onRetry}
        data-testid="auth-retry"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </AuthFrame>
  );
}
