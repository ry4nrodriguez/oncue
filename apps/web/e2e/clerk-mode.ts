import { configuredClerkKey } from "../vite-plugins/clerk-stand-in";

/**
 * Whether the dev server under test loads Clerk's real browser SDK. It does
 * only when a publishable key is configured (`apps/web/.env.local`); a fresh
 * clone has none and gets the stand-in. The few tests that inspect Clerk's own
 * form run only against the real SDK, since the stand-in has no such form.
 */
export const REAL_CLERK = configuredClerkKey() !== null;

export const NEEDS_REAL_CLERK =
  "needs Clerk's own browser SDK; set VITE_CLERK_PUBLISHABLE_KEY in apps/web/.env.local to run it";
