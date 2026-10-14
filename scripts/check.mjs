import { spawnSync } from "node:child_process";

const steps = [
  { name: "biome", command: "pnpm", args: ["exec", "biome", "ci", "."] },
  { name: "tsc", command: "pnpm", args: ["run", "typecheck"] },
  { name: "vitest", command: "pnpm", args: ["run", "test"] },
  // Before the controller: its Modal image copies the gitignored
  // `services/bridge/dist/bridge.mjs`, and a controller deployed without it
  // starts cleanly but cannot create a sandbox. `pnpm deploy:hosted` runs
  // `pnpm check`, so this enforces the order.
  {
    name: "bridge-bundle",
    command: "pnpm",
    args: ["--filter", "@oncue/bridge", "build"],
  },
  // The controller is Python, outside `pnpm -r test`. `--frozen` makes a
  // stale `uv.lock` fail instead of upgrading. A missing `uv` fails the step
  // rather than skipping the only tests of the provider side's credential
  // handling and network policy.
  {
    name: "controller",
    command: "uv",
    args: ["run", "--frozen", "pytest", "-q"],
    cwd: "services/sandbox-controller",
  },
  { name: "actor-boundary", command: "node", args: ["scripts/check-actor-boundary.mjs"] },
  { name: "records", command: "pnpm", args: ["run", "check-records"] },
  { name: "fixtures", command: "pnpm", args: ["run", "check-fixtures"] },
];

const root = new URL("..", import.meta.url).pathname;

for (const step of steps) {
  console.log(`\n[check] running ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    cwd: step.cwd === undefined ? root : new URL(`../${step.cwd}/`, import.meta.url).pathname,
  });
  if (result.error?.code === "ENOENT") {
    console.error(`[check] ${step.name} needs \`${step.command}\`, which is not on PATH`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[check] ${step.name} failed`);
    process.exit(result.status ?? 1);
  }
  console.log(`[check] ${step.name} passed`);
}

console.log(
  "\n[check] biome, tsc, vitest, bridge-bundle, controller, actor-boundary, records, and fixtures all passed",
);
