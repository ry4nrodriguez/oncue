import { SignOutButton } from "@clerk/react";
import { AuthFrame, FRAME_LINK } from "./AuthFrame";
import { BLOCKED_MESSAGE, blockedLocalHint } from "./gate";

export interface BlockedScreenProps {
  readonly clerkSubject: string | null;
}

/**
 * Thin: `./gate.ts`'s `blockedLocalHint` decides whether and what to show.
 * Sign out is offered because a person signed in with the wrong account has
 * no other way off this screen.
 */
export function BlockedScreen({ clerkSubject }: BlockedScreenProps) {
  const hint = blockedLocalHint(clerkSubject);
  return (
    <AuthFrame
      testId="blocked-screen"
      footer={
        <SignOutButton>
          <button type="button" className={FRAME_LINK}>
            Sign out
          </button>
        </SignOutButton>
      }
    >
      <p className="text-center text-[15px] text-text" data-testid="blocked-message">
        {BLOCKED_MESSAGE}
      </p>
      {hint !== null ? (
        <p
          className="mt-3 break-words text-center text-[12px] text-muted-foreground leading-5"
          data-testid="blocked-local-hint"
        >
          {hint}
        </p>
      ) : null}
    </AuthFrame>
  );
}
