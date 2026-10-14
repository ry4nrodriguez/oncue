/**
 * Finds the Clerk publishable key the dev server would use.
 *
 * Nothing in the repository carries one. Whoever wants real Clerk sign-in
 * locally puts their own in `apps/web/.env.local`; without one the dev server
 * stands in for Clerk's browser SDK (`apps/web/vite-plugins/clerk-stand-in.ts`).
 * The dev server, `pnpm dev:real`, and the end-to-end tests all ask here, so
 * they agree on which of the two is running.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../apps/web", import.meta.url));

/** The env files Vite's dev server reads, most specific first. */
const ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

function keyInFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/^VITE_CLERK_PUBLISHABLE_KEY=(.*)$/m);
  const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
  return value.length > 0 ? value : null;
}

/**
 * The key, or null when there is none: the process environment first, then
 * the env files, in Vite's order. Read directly, not through Vite's
 * `loadEnv`, which folds in this process's own environment whatever is asked
 * of it.
 *
 * @param {string} [root] the directory holding the env files
 * @param {Record<string, string | undefined>} [environment]
 * @returns {string | null}
 */
export function configuredClerkKey(root = WEB_ROOT, environment = process.env) {
  const fromProcess = environment.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return fromProcess;
  }
  for (const name of ENV_FILES) {
    const key = keyInFile(join(root, name));
    if (key !== null) {
      return key;
    }
  }
  return null;
}
