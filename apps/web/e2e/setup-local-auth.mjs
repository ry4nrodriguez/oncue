#!/usr/bin/env node
/**
 * Configures the local dev server for the doubles and the e2e tests. The app
 * has no Clerk bypass, so this points the local Worker at a public key whose
 * private half lives only on this machine, and tests sign real tokens.
 *
 * It writes `apps/web/.dev.vars.lane` and composes `apps/web/.dev.vars` from it
 * (`scripts/dev-vars.mjs`); it never touches `apps/web/.dev.vars.real`. The
 * Clerk pair is regenerated each run; keys that seal or sign stored rows are
 * reused so those rows stay openable.
 *
 * The double origins it writes are the slot's (`scripts/dev-ports.mjs`), so
 * run it with the same `ONCUE_PORT_SLOT` as the dev server and the tests.
 *
 * Usage: ONCUE_PORT_SLOT=N node e2e/setup-local-auth.mjs [subject]
 * Then restart the dev server so it reads the new values.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { originsFor, slotPorts, slotPortsOrExit } from "../../../scripts/dev-ports.mjs";
import { composeDevVars, LANE_VARS, readVars, writeVars } from "../../../scripts/dev-vars.mjs";

export const LANE_SUBJECT = "user_lane";
/** A second allowlisted subject whose workspace `e2e/walkthrough.spec.ts` empties and walks through setup. */
export const WALKTHROUGH_SUBJECT = "user_walkthrough";
/**
 * The subject `pnpm dev` seeds and signs in. Not `user_lane`, whose workspace
 * several tests assume holds no model connection.
 */
export const DEV_SUBJECT = "user_dev";
/**
 * The broker tests' own subject. They leave a model connection behind, which
 * would make sessions naming no connection fail with `connection_required`.
 */
export const BROKER_SUBJECT = "user_broker";

/**
 * Where the Worker finds the three doubles on a slot: the same origins the
 * double servers listen on, from the same module.
 *
 * @param {import("../../../scripts/dev-ports.d.mts").SlotPorts} ports
 */
export function laneOriginVars(ports) {
  const origins = originsFor(ports);
  return {
    ONCUE_PROVIDER_DOUBLE_ORIGIN: origins.provider,
    ONCUE_GITHUB_API_ORIGIN: origins.github,
    ONCUE_SANDBOX_CONTROLLER_ORIGIN: origins.controller,
  };
}
/** Long enough that no other test's session stops mid-assertion, short enough for the walkthrough to wait out. */
export const LANE_IDLE_ALARM_SECONDS = 45;
/** An approval's ten minutes, shortened so a test can watch one expire. Local only, as above. */
export const LANE_APPROVAL_TTL_SECONDS = 60;

function pemLine(pem) {
  // The PEM is written in double quotes because a bare `\n` in a dotenv file
  // stays two characters. Quoted, the parser expands it, and the Worker gets
  // a key with real line breaks rather than one that fails to import and
  // reads as every request being unauthenticated.
  return `"${pem.replaceAll("\n", "\\n")}"`;
}

/**
 * Generates (or refreshes) `.dev.vars.lane` and returns its entries.
 *
 * The origin overrides keep every test off real services: without
 * ONCUE_PROVIDER_DOUBLE_ORIGIN, adding a key would validate it against the real
 * provider. ONCUE_GITHUB_API_ORIGIN and ONCUE_SANDBOX_CONTROLLER_ORIGIN point at
 * the GitHub and controller doubles; the GitHub App values are throwaway.
 * `pnpm controller` serves the real controller on the same port and token.
 */
export function writeLaneVars(subject = LANE_SUBJECT, ports = slotPorts()) {
  const existing = readVars(LANE_VARS);
  const origins = laneOriginVars(ports);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "jwk" },
  });
  const managed = new Map([
    ["CLERK_JWT_KEY", pemLine(publicKey)],
    ["ONCUE_USER_ALLOWLIST", `${subject},${WALKTHROUGH_SUBJECT},${DEV_SUBJECT},${BROKER_SUBJECT}`],
    ["ONCUE_LANE_SIGNING_JWK", JSON.stringify(privateKey)],
    ["ONCUE_LANE_SUBJECT", subject],
    ["ONCUE_PROVIDER_DOUBLE_ORIGIN", origins.ONCUE_PROVIDER_DOUBLE_ORIGIN],
    [
      "ONCUE_BROKER_KEYRING",
      existing.get("ONCUE_BROKER_KEYRING") ?? `1:${randomBytes(32).toString("base64url")}`,
    ],
    ["ONCUE_GITHUB_API_ORIGIN", origins.ONCUE_GITHUB_API_ORIGIN],
    ["ONCUE_GITHUB_APP_ID", "1"],
    ["ONCUE_GITHUB_APP_SLUG", "oncue-local"],
    ["ONCUE_GITHUB_CLIENT_ID", "Iv1.oncuelane000000"],
    [
      "ONCUE_GITHUB_CLIENT_SECRET",
      existing.get("ONCUE_GITHUB_CLIENT_SECRET") ?? randomBytes(20).toString("hex"),
    ],
    [
      "ONCUE_GITHUB_WEBHOOK_SECRET",
      existing.get("ONCUE_GITHUB_WEBHOOK_SECRET") ?? randomBytes(20).toString("hex"),
    ],
    // Double-quoted like CLERK_JWT_KEY. Reused if present so minted
    // installation tokens stay valid across runs.
    [
      "ONCUE_GITHUB_APP_PRIVATE_KEY",
      existing.get("ONCUE_GITHUB_APP_PRIVATE_KEY") ??
        pemLine(
          generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          }).privateKey,
        ),
    ],
    ["ONCUE_SANDBOX_CONTROLLER_ORIGIN", origins.ONCUE_SANDBOX_CONTROLLER_ORIGIN],
    // Record 11's idle stop, shortened so the walkthrough can watch a session
    // checkpoint, stop, and resume. A hosted Worker ignores it.
    ["ONCUE_IDLE_ALARM_SECONDS", String(LANE_IDLE_ALARM_SECONDS)],
    ["ONCUE_APPROVAL_TTL_SECONDS", String(LANE_APPROVAL_TTL_SECONDS)],
    [
      "ONCUE_SANDBOX_CONTROLLER_TOKEN",
      existing.get("ONCUE_SANDBOX_CONTROLLER_TOKEN") ?? randomBytes(24).toString("base64url"),
    ],
  ]);
  // Codex is offered only where `ONCUE_DEV_CODEX_BIN` names a binary, for the
  // Codex walkthrough. Otherwise OpenCode alone, with no harness control.
  if (process.env.ONCUE_DEV_CODEX_BIN !== undefined) {
    managed.set("ONCUE_RUNTIME_ALLOWLIST", "opencode,codex");
  }
  writeVars(LANE_VARS, managed);
  return managed;
}

// Imported by `scripts/dev.mjs` as a module; only a direct invocation writes.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const subject = process.argv[2] ?? LANE_SUBJECT;
  const ports = slotPortsOrExit("setup-local-auth");
  writeLaneVars(subject, ports);
  composeDevVars("lane");
  console.log(
    `[setup-local-auth] wrote a fresh local Clerk key pair for subject "${subject}" to apps/web/.dev.vars.lane and composed apps/web/.dev.vars from it for port slot ${ports.slot} (app on ${ports.app}); restart the dev server`,
  );
  console.log(
    "[setup-local-auth] this points local Clerk at a throwaway key pair, so signing in with a real Clerk account will not work until `pnpm dev:real` composes .dev.vars from apps/web/.dev.vars.real again.",
  );
}
