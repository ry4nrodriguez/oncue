/**
 * One command that gives you a working app.
 *
 *   pnpm dev          doubles for GitHub, the model provider, and the sandbox
 *                     controller; a seeded, fully connected workspace; a
 *                     signed-in landing. Sessions run the REAL bridge bundle
 *                     in a local process. Costs nothing, needs no account.
 *   pnpm dev:fresh    the same doubles, but a brand-new subject with no rows,
 *                     so the three-step setup can be walked deliberately.
 *   pnpm dev:modal    the GitHub and provider doubles, the seeded workspace
 *                     holding your REAL Modal pair from ~/.modal.toml, and
 *                     NO controller double: run `pnpm controller` beside it
 *                     for real sandboxes.
 *   pnpm dev:real     no doubles, no seed: `.dev.vars` composed from
 *                     `.dev.vars.real`, real Clerk sign-in at /.
 *   pnpm dev:live     no doubles, no controller double, no seed: `.dev.vars`
 *                     composed from `.dev.vars.real` (real Clerk, real GitHub
 *                     App, real model provider), pointed at the LOCAL
 *                     sandbox controller on this slot instead of the hosted
 *                     one.
 *                     Run `pnpm controller` beside it. Every session creates
 *                     a real Modal sandbox and spends real credit.
 *
 * Every port comes from the slot `ONCUE_PORT_SLOT` names (`dev-ports.mjs`), so
 * several checkouts can each run a stack on their own slot.
 *
 * Order: `.dev.vars` first, because the dev server reads it once at start;
 * then migrations; then the doubles, because the seed's GitHub rows must match
 * theirs; then the seed; then vite.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_SUBJECT, writeLaneVars } from "../apps/web/e2e/setup-local-auth.mjs";
import { configuredClerkKey } from "./clerk-key.mjs";
import { originsFor, slotPortsOrExit } from "./dev-ports.mjs";
import { composeDevVars, repoRoot, webRoot } from "./dev-vars.mjs";

const mode = process.argv[2] ?? "doubles";
const localController = process.argv.includes("--local-controller");
if (!["doubles", "fresh", "modal", "real", "live"].includes(mode)) {
  console.error(`[dev] unknown mode "${mode}"; expected doubles, fresh, modal, real, or live`);
  process.exit(1);
}

const ports = slotPortsOrExit("dev");
const origins = originsFor(ports);
// Vite, the doubles, and the seed read the slot from the environment, so every
// child sees the one this script resolved.
process.env.ONCUE_PORT_SLOT = String(ports.slot);

const children = [];
function stopAll() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.status !== 0) {
    stopAll();
    process.exit(result.status ?? 1);
  }
}

// 1. Compose `.dev.vars`.
let subject = null;
if (mode === "real") {
  // Real Clerk sign-in needs Clerk's browser SDK, which needs a key. Without
  // one the dev server stands in for the SDK and could only offer the local
  // sign-in, which this mode's `.dev.vars` has no key to mint.
  if (configuredClerkKey() === null) {
    console.error(
      "[dev] `pnpm dev:real` signs in through your own Clerk application, and no publishable key is set. Put VITE_CLERK_PUBLISHABLE_KEY=pk_… in apps/web/.env.local.",
    );
    process.exit(1);
  }
  // `--local-controller`: real Clerk, GitHub App, and keys, but sandboxes
  // through the controller on this machine (`pnpm controller`) instead of the
  // hosted one. The token comes from `.dev.vars.lane`, as `pnpm controller`
  // reads it.
  const overrides = {};
  if (localController) {
    const lane = writeLaneVars();
    overrides.ONCUE_SANDBOX_CONTROLLER_ORIGIN = origins.controller;
    overrides.ONCUE_SANDBOX_CONTROLLER_TOKEN = lane.get("ONCUE_SANDBOX_CONTROLLER_TOKEN");
    // Blank, not omitted: see the `live` arm below.
    overrides.ONCUE_PROVIDER_DOUBLE_ORIGIN = "";
  }
  composeDevVars("real", overrides);
} else if (mode === "live") {
  // `.dev.vars.lane` keeps `ONCUE_SANDBOX_CONTROLLER_TOKEN` across runs, shared
  // with `pnpm controller`. `writeLaneVars` writes only `.dev.vars.lane`, and
  // this mode starts none of the doubles.
  const lane = writeLaneVars();
  // The local dev sign-in instead of a Clerk password, so whoever drives it
  // never types one. GitHub, the provider, and Modal stay real.
  subject = DEV_SUBJECT;
  composeDevVars("real", {
    CLERK_JWT_KEY: lane.get("CLERK_JWT_KEY"),
    ONCUE_LANE_SIGNING_JWK: lane.get("ONCUE_LANE_SIGNING_JWK"),
    ONCUE_USER_ALLOWLIST: lane.get("ONCUE_USER_ALLOWLIST"),
    ONCUE_DEV_SUBJECT: subject,
    ONCUE_SANDBOX_CONTROLLER_ORIGIN: origins.controller,
    // The cost guard: a live session spends real credit, so only Sonnet 4.5
    // may start one unless this list is widened. The doubles never set it.
    ONCUE_MODEL_ALLOWLIST: "claude-sonnet-4-5-20250929",
    ONCUE_SANDBOX_CONTROLLER_TOKEN: lane.get("ONCUE_SANDBOX_CONTROLLER_TOKEN"),
    // Blank, not omitted: a leftover double origin in `.dev.vars.real` would
    // silently redirect real model traffic. Empty resolves the same as
    // absent (`resolveProviderOrigin`, `worker/broker/providers/adapter.ts`),
    // so this guarantees the real provider is used.
    ONCUE_PROVIDER_DOUBLE_ORIGIN: "",
  });
} else {
  const lane = writeLaneVars();
  // Its own subject, leaving `user_lane` to the e2e tests: `/dev/sign-in` and
  // the seed both read `ONCUE_DEV_SUBJECT`.
  subject = DEV_SUBJECT;
  const overrides = { ONCUE_DEV_SUBJECT: subject };
  if (mode === "fresh") {
    // A subject nobody has signed in as before: an empty account every run,
    // with the old fresh workspaces left harmlessly behind in local D1.
    subject = `user_fresh_${Date.now().toString(36)}`;
    overrides.ONCUE_USER_ALLOWLIST = `${lane.get("ONCUE_USER_ALLOWLIST")},${subject}`;
    overrides.ONCUE_DEV_SUBJECT = subject;
  }
  composeDevVars("lane", overrides);
}
console.log(`[dev] composed apps/web/.dev.vars for mode "${mode}"`);

// 2. Migrations, then the bridge bundle the controller double spawns.
run("pnpm", [
  "--filter",
  "@oncue/web",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
]);
if (mode !== "real") {
  run("pnpm", ["--filter", "@oncue/bridge", "build"]);
}

// The controller double runs the real bridge, which spawns a real OpenCode
// (`local-supervisor.ts`), so say what to install instead of leaving the
// sandbox row stuck on "Starting environment".
if (mode === "doubles" || mode === "fresh") {
  const opencodeBinary =
    process.env.ONCUE_OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
  if (!existsSync(opencodeBinary)) {
    console.log(
      `[dev] no OpenCode binary at ${opencodeBinary}. Sessions will fail to start until one exists.`,
    );
    console.log(
      "[dev] install it with: curl -fsSL https://opencode.ai/install | VERSION=1.18.30 bash",
    );
    console.log("[dev] or set ONCUE_OPENCODE_BIN to point at an existing install.");
  }
}

// 3. Doubles.
if (mode !== "real" && mode !== "live") {
  const args = ["exec", "tsx", "e2e/dev-services.ts"];
  if (mode === "modal") {
    args.push("--no-controller-double");
  }
  const services = spawn("pnpm", args, { cwd: webRoot, stdio: "inherit" });
  children.push(services);
  await waitFor(`${origins.github}/__calls`, "the GitHub double");
}

// 4. Seed.
if (mode === "doubles" || mode === "modal") {
  const args = ["exec", "tsx", "scripts/seed-local.ts"];
  if (mode === "modal") {
    args.push("--modal-from-home");
  }
  run("pnpm", args, { cwd: webRoot });
}
if (mode === "live") {
  // Your real Modal pair and Anthropic key, sealed as the screens seal them;
  // GitHub connects through the real App's install.
  run(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/seed-local.ts",
      "--modal-from-home",
      "--model-key-from-keychain",
      process.env.ONCUE_LIVE_MODEL_KEY_SERVICE ?? "oncue-recording-anthropic-key",
    ],
    { cwd: webRoot },
  );
}

// 5. Vite.
const vite = spawn("pnpm", ["exec", "vite"], { cwd: webRoot, stdio: "inherit" });
children.push(vite);
vite.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});
await waitFor(`${origins.app}/api/health`, "the dev server");

console.log("");
if ((mode === "real" || mode === "live") && ports.slot !== 0) {
  // The real App sends the browser back to its registered callback URL, which
  // names slot 0's port, so the install flow cannot finish on this slot.
  console.log(
    `[dev] port slot ${ports.slot}: connecting GitHub through the real App returns to its registered callback (port 5173), so it works only on slot 0; seed the installation instead with \`ONCUE_PORT_SLOT=${ports.slot} pnpm --filter @oncue/web exec tsx scripts/seed-local.ts --real-github-repo <owner>/<name>\``,
  );
}
if (mode === "real") {
  console.log(`[dev] open ${origins.app} and sign in with your real Clerk account`);
  if (localController) {
    console.log(
      `[dev] run \`ONCUE_PORT_SLOT=${ports.slot} pnpm controller\` in another terminal now: the Worker expects the local controller on ${ports.controller}, and every session creates a REAL Modal sandbox`,
    );
  }
} else if (mode === "live") {
  console.log(
    `[dev] open ${origins.app}/dev/sign-in to land on Home signed in as ${subject}, then connect GitHub through the real App`,
  );
  console.log(
    `[dev] run \`ONCUE_PORT_SLOT=${ports.slot} pnpm controller\` in another terminal now: the Worker expects the local controller on ${ports.controller}`,
  );
  console.log(
    "[dev] every session created here creates a REAL Modal sandbox in your workspace and spends real credit",
  );
} else {
  console.log(`[dev] open ${origins.app}/dev/sign-in to land on Home signed in as ${subject}`);
  if (mode === "modal") {
    console.log(
      `[dev] then run \`ONCUE_PORT_SLOT=${ports.slot} pnpm controller\` in another terminal for real Modal sandboxes`,
    );
  }
}
console.log("");

async function waitFor(url, what) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const answer = await fetch(url);
      if (answer.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`[dev] ${what} did not come up at ${url}`);
  stopAll();
  process.exit(1);
}
