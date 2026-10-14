/**
 * A stand-in for `@clerk/react` in the unit suite, so rendering the shell
 * needs no publishable key or network. `setStubUser` sets who is signed in;
 * the default is nobody, as on a real page's first frames.
 */

import type { ReactNode } from "react";

export interface StubUser {
  readonly fullName?: string | null;
  readonly username?: string | null;
  readonly imageUrl?: string | null;
  readonly primaryEmailAddress?: { emailAddress: string } | null;
  readonly externalAccounts?: readonly { provider: string }[];
}

let stubUser: StubUser | null = null;
let stubLoaded = true;

export function setStubUser(user: StubUser | null, loaded = true): void {
  stubUser = user;
  stubLoaded = loaded;
}

export function resetStubUser(): void {
  stubUser = null;
  stubLoaded = true;
}

/**
 * Spread into a `vi.mock` factory. Only the exports the app calls are here,
 * so a missing one fails loudly rather than a full mirror going stale.
 */
export function clerkModule() {
  return {
    useUser: () => ({ isLoaded: stubLoaded, isSignedIn: stubUser !== null, user: stubUser }),
    useAuth: () => ({ isLoaded: stubLoaded, isSignedIn: stubUser !== null }),
    SignOutButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
    ClerkProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
}
