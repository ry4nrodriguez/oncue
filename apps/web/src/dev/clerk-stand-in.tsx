/**
 * Stands in for `@clerk/react` on a dev server that has no Clerk publishable
 * key, so a fresh clone runs with no Clerk application at all
 * (`vite-plugins/clerk-stand-in.ts` makes the swap). It replaces Clerk's
 * browser SDK and nothing of OnCue's: the gate, the screens, and the Worker's
 * session check are the real ones, and `/dev/sign-in` still mints the cookie
 * the Worker verifies.
 *
 * Only the exports the app imports are here, so a new one fails loudly
 * instead of a full mirror going stale. Dev only;
 * `scripts/check-no-dev-harness.mjs` fails the build if this enters it.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { NEUTRAL_BUTTON_BLOCK } from "@/components/ui/button-classes";

export const LOCAL_SIGN_IN_PATH = "/dev/sign-in";
export const LOCAL_SIGN_OUT_PATH = "/dev/sign-out";

export function ClerkProvider({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}

/** Nobody is signed in to Clerk here; the app harness tells the gate who is. */
export function useAuth() {
  return { isLoaded: true, isSignedIn: false };
}

/** No profile, so the app shows the fallbacks it shows before Clerk has one. */
export function useUser() {
  return { isLoaded: true, isSignedIn: false, user: null };
}

/** Where Clerk's form would be: the one way in on a server with no Clerk. */
export function SignIn() {
  return (
    <div className="flex flex-col items-center gap-4 text-center" data-testid="local-sign-in">
      <p className="text-[13px] text-muted-foreground leading-5">
        This local server has no Clerk application, so it signs you in itself.
      </p>
      <a className={NEUTRAL_BUTTON_BLOCK} href={LOCAL_SIGN_IN_PATH}>
        Continue as the local user
      </a>
    </div>
  );
}

/** A seam for the unit test: jsdom does not let `window.location` be replaced. */
export const navigation = {
  go(path: string): void {
    window.location.assign(path);
  },
};

/** Wraps its one child, as Clerk's does, and ends the local session on click. */
export function SignOutButton({ children }: { readonly children?: ReactNode }) {
  if (!isValidElement(children)) {
    return <>{children}</>;
  }
  return cloneElement(children as ReactElement<{ onClick?: () => void }>, {
    onClick: () => navigation.go(LOCAL_SIGN_OUT_PATH),
  });
}
