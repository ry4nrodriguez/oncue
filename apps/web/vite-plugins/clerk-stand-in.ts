/**
 * Lets the dev server run with no Clerk application.
 *
 * Clerk's browser SDK needs a publishable key and loads its script from that
 * Clerk application's own host, so a fresh clone could not start without
 * someone's Clerk account. When no key is configured, this resolves
 * `@clerk/react` to `src/dev/clerk-stand-in.tsx` instead. `/dev/sign-in` still
 * mints the session cookie and the Worker still verifies it, so only Clerk's
 * SDK is replaced.
 *
 * Put your own key in `apps/web/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY=…`)
 * and the real SDK is used. `apply: "serve"` keeps the stand-in out of every
 * build, and `scripts/check-no-dev-harness.mjs` fails a build that holds it.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configuredClerkKey } from "../../../scripts/clerk-key.mjs";

export { configuredClerkKey };

const STAND_IN = fileURLToPath(new URL("../src/dev/clerk-stand-in.tsx", import.meta.url));

/**
 * Shaped like a publishable key, so the entry points' "is a key set" check
 * passes; the stand-in never reads it.
 */
export const STAND_IN_PUBLISHABLE_KEY = "pk_test_local-stand-in";

export function clerkStandInPlugin(publishableKey: string | null = configuredClerkKey()): Plugin {
  return {
    name: "oncue-clerk-stand-in",
    apply: "serve",
    config() {
      if (publishableKey !== null) {
        return {};
      }
      return {
        resolve: {
          // The bare package only: a deep import would mean the app started
          // using part of the SDK the stand-in does not cover.
          alias: [{ find: /^@clerk\/react$/, replacement: STAND_IN }],
        },
        define: {
          "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(STAND_IN_PUBLISHABLE_KEY),
        },
      };
    },
    configureServer(server) {
      if (publishableKey === null) {
        server.config.logger.info(
          "[oncue] no Clerk publishable key: standing in for Clerk's browser SDK (set VITE_CLERK_PUBLISHABLE_KEY in apps/web/.env.local to use your own Clerk application)",
        );
      }
    },
  };
}
