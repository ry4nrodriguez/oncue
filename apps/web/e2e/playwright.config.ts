import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { originsFor, slotPorts } from "../../../scripts/dev-ports.mjs";

// The dev server, and every double a lane starts, use the slot's ports
// (`scripts/dev-ports.mjs`); `pnpm dev` below inherits `ONCUE_PORT_SLOT`.
const APP_ORIGIN = originsFor(slotPorts()).app;

// A project's own `testIgnore` REPLACES the top-level one rather than adding
// to it, so the perf exclusion has to be repeated on every project that could
// otherwise pick the perf test up.
const PERF_IGNORE = process.env.ONCUE_PERF === "1" ? [] : ["**/perf.spec.ts"];

export default defineConfig({
  testDir: ".",
  // The `*.test.ts` files here are Vitest unit tests of the helpers and run in
  // `pnpm check`.
  testMatch: "**/*.spec.ts",
  // The perf test measures wall-clock paint time, which parallel workers
  // distort, so `pnpm test:perf` sets this flag and runs it alone.
  testIgnore: PERF_IGNORE,
  timeout: 30_000,
  fullyParallel: true,
  ...(process.env.CI ? {} : { workers: 2 }),
  // Fails the run when the server on this slot's port belongs to another checkout:
  // `reuseExistingServer` would otherwise test its code.
  globalSetup: "./same-checkout.ts",
  reporter: "list",
  use: {
    baseURL: APP_ORIGIN,
    trace: "on-first-retry",
    // A failed test keeps the screen it failed on, which the accessibility
    // snapshot cannot always show.
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: APP_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  },
  // The walkthrough runs alone, after everything else: it needs all three
  // doubles on the slot's ports and empties its subject's workspace. A project
  // dependency serialises one file without giving up parallelism elsewhere.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        ...PERF_IGNORE,
        "**/walkthrough.spec.ts",
        "**/forged-outcome.spec.ts",
        "**/attachments.spec.ts",
        "**/walkthrough-codex.spec.ts",
        "**/status-dots.spec.ts",
        "**/resume-and-review.spec.ts",
        "**/approvals.spec.ts",
        "**/questions.spec.ts",
        "**/resilience.spec.ts",
        "**/bridge-drops.spec.ts",
        "**/context-meter.spec.ts",
        "**/subagents.spec.ts",
        "**/branch-choice.spec.ts",
        "**/controller-timing.spec.ts",
        "**/model-switch.spec.ts",
        "**/delete-archive.spec.ts",
        "**/model-key-checks.spec.ts",
        "**/rejected-key.spec.ts",
      ],
    },
    {
      name: "walkthrough",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/walkthrough.spec.ts"],
      dependencies: ["chromium"],
    },
    // The forged-outcome test serves the controller double's fixed port too,
    // so it runs after the walkthrough.
    {
      name: "forged",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/forged-outcome.spec.ts"],
      dependencies: ["walkthrough"],
    },
    // Composer attachments need all three doubles and the GitHub double's state,
    // so it runs alone. `--no-deps` runs it by itself.
    {
      name: "attachments",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/attachments.spec.ts"],
      dependencies: ["forged"],
    },
    // Status dots reseed the GitHub double with the `pnpm dev` subject's world
    // and switch the provider double's mode, so it runs alone. Run it by itself
    // with `--project=status-dots --no-deps`.
    {
      name: "status-dots",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/status-dots.spec.ts"],
      dependencies: ["attachments"],
    },
    // Resume after the base branch moved, and the review tree's file view. It
    // reseeds the GitHub double, switches the provider double's mode, and
    // serves the controller double's port, so it runs alone. Run it by itself
    // with `--project=resume-review --no-deps`.
    {
      name: "resume-review",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/resume-and-review.spec.ts"],
      dependencies: ["status-dots"],
    },
    // The browser under failure: a failed `/api/me`, a dropped socket, a
    // message sent while down, a double click on Allow, a paused run. It
    // reseeds the GitHub double and switches the provider double's mode, so
    // it runs alone. Run it by itself with `--project=resilience --no-deps`.
    {
      name: "resilience",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/resilience.spec.ts"],
      dependencies: ["resume-review"],
    },
    // The Codex walkthrough needs all three doubles and a real `codex` binary,
    // so it runs alone and skips itself without `ONCUE_DEV_CODEX_BIN`.
    {
      name: "codex",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/walkthrough-codex.spec.ts"],
      dependencies: ["resilience"],
    },
    // The agent's questions switch the provider double's mode and reseed the
    // GitHub double, so they run alone. Run them by themselves with
    // `--project=questions --no-deps`.
    {
      name: "questions",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/questions.spec.ts"],
      dependencies: ["codex"],
    },
    // Agent permissions change the dev workspace's approval default, which
    // every session of that workspace reads, so they run alone. Run them by
    // themselves with `--project=approvals --no-deps`.
    {
      name: "approvals",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/approvals.spec.ts"],
      dependencies: ["questions"],
    },
    // Drops and stalls one session's bridge link through the controller
    // double's proxy, so it serves that port and runs alone. Run it by itself
    // with `--project=bridge-drops --no-deps`.
    {
      name: "bridge-drops",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/bridge-drops.spec.ts"],
      dependencies: ["approvals"],
    },
    // The context gauge reads the provider double's call log, which another
    // session would add to, and serves the controller double's port, so it
    // runs alone. Run it by itself with `--project=context-meter --no-deps`.
    {
      name: "context-meter",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/context-meter.spec.ts"],
      dependencies: ["bridge-drops"],
    },
    // Subagents switch the provider double to its `subagents` mode and serve
    // the controller double's port, so they run alone. Run them by themselves
    // with `--project=subagents --no-deps`.
    {
      name: "subagents",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/subagents.spec.ts"],
      dependencies: ["context-meter"],
    },
    // Starting from a chosen branch and working directly on an existing one.
    // It reseeds the GitHub double, switches the provider double's mode, and
    // serves the controller double's port, so it runs alone: after the chain
    // above has finished, since a project with no dependency starts beside
    // `chromium` and its successors would then share the doubles with the
    // walkthrough. Run it by itself with `--project=branch-choice --no-deps`.
    {
      name: "branch-choice",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/branch-choice.spec.ts"],
      dependencies: ["subagents"],
    },
    // Modal's timing: an image still building and a create answered late. It
    // switches the controller double's one shared mode, so it runs alone. Run
    // it by itself with `--project=controller-timing --no-deps`.
    {
      name: "controller-timing",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/controller-timing.spec.ts"],
      dependencies: ["branch-choice"],
    },
    // Changing a session's model reads the provider double's call log, which
    // another session would add to, and serves the controller double's port,
    // so it runs alone. Run it by itself with `--project=model-switch --no-deps`.
    {
      name: "model-switch",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/model-switch.spec.ts"],
      dependencies: ["controller-timing"],
    },
    // Deleting and archiving stop sandboxes through the controller double and
    // read the local R2, so they run alone. Run them by themselves with
    // `--project=delete-archive --no-deps`.
    {
      name: "delete-archive",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/delete-archive.spec.ts"],
      dependencies: ["model-switch"],
    },
    // A rejected model key switches the provider double's mode and revokes and
    // reconnects the dev workspace's key, so it runs alone. Run it by itself
    // with `--project=model-key-checks --no-deps`.
    {
      name: "model-key-checks",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/model-key-checks.spec.ts"],
      dependencies: ["delete-archive"],
    },
    // A rejected key switches the provider double's mode and marks the dev
    // workspace's model connection invalid until it replaces the key, which
    // every session of that workspace reads, so it runs alone, last. Run it by
    // itself with `--project=rejected-key --no-deps`.
    {
      name: "rejected-key",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/rejected-key.spec.ts"],
      dependencies: ["model-key-checks"],
    },
  ],
});
