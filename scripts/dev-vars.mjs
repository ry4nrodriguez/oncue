/**
 * `apps/web/.dev.vars` is generated on every run from one of two sources that
 * no generator writes to, so test fixtures never overwrite a developer's real
 * values:
 *
 *   `.dev.vars.real`   the developer's real values: Clerk public key,
 *                      allowlist, GitHub App, hosted controller.
 *                      Hand-written, never touched by any script.
 *   `.dev.vars.lane`   the test fixtures `setup-local-auth.mjs` generates,
 *                      reusing the secrets it finds so saved rows stay
 *                      openable across runs.
 *
 * `composeDevVars` picks one, stamps `ONCUE_RELEASE` from HEAD, applies the
 * caller's overrides, and writes `.dev.vars`. All three are gitignored.
 * `wrangler types` reads `.dev.vars`, so the generated `Env` depends on which
 * mode was composed last.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const webRoot = `${repoRoot}apps/web/`;
export const DEV_VARS = `${webRoot}.dev.vars`;
export const REAL_VARS = `${webRoot}.dev.vars.real`;
export const LANE_VARS = `${webRoot}.dev.vars.lane`;

/** Parses a dotenv-shaped file into a Map, keeping values verbatim (quotes and all). */
export function readVars(path) {
  const entries = new Map();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) {
      entries.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return entries;
}

export function writeVars(path, entries) {
  const lines = [...entries.entries()].map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
}

export function headRelease() {
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return sha.status === 0 ? sha.stdout.trim() : "unknown";
}

/**
 * Composes `.dev.vars` from one source file plus overrides.
 *
 * @param {"lane" | "real"} mode which source file to read
 * @param {Record<string, string>} overrides values that win over the source
 * @returns {Map<string, string>} what was written
 */
export function composeDevVars(mode, overrides = {}) {
  const sourcePath = mode === "real" ? REAL_VARS : LANE_VARS;
  const source = readVars(sourcePath);
  if (source.size === 0) {
    const hint =
      mode === "real"
        ? `${REAL_VARS} does not exist. Put your real Clerk, GitHub, and controller values there; no script ever writes to it.`
        : `${LANE_VARS} does not exist. Run \`node apps/web/e2e/setup-local-auth.mjs\` to generate it.`;
    throw new Error(`[dev-vars] ${hint}`);
  }
  const composed = new Map([["ONCUE_RELEASE", headRelease()], ...source]);
  for (const [key, value] of Object.entries(overrides)) {
    composed.set(key, value);
  }
  writeVars(DEV_VARS, composed);
  return composed;
}
