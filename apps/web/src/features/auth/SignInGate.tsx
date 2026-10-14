import { SignIn } from "@clerk/react";
import { AuthFrame } from "./AuthFrame";
import { LoadingLabel } from "./LoadingScreen";

/**
 * Clerk's `<SignIn/>` in OnCue's panel, styled by `CLERK_APPEARANCE`.
 * `withSignUp` keeps sign-up in the same themed component instead of Clerk's
 * hosted page; the allowlist still decides who gets past the gate.
 */
export function SignInGate() {
  return (
    <AuthFrame testId="sign-in-gate">
      <SignIn withSignUp fallback={<LoadingLabel className="py-2" />} />
    </AuthFrame>
  );
}
