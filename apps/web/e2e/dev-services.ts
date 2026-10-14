/**
 * The doubles `pnpm dev` runs beside the dev server, on the port slot's ports
 * (`scripts/dev-ports.mjs`; 5198, 5199, and 5197 on slot 0): GitHub, the
 * provider, and, unless `--no-controller-double`, the sandbox controller.
 * They are the same servers the Playwright tests start.
 * The GitHub double is seeded with the world `scripts/seed-local.ts` wrote
 * into D1 (see `dev-github-world.ts`). Started by `scripts/dev.mjs`.
 */

import { originsFor, slotPorts } from "../../../scripts/dev-ports.mjs";
import { devGitHubSeed } from "./dev-github-world";
import { GITHUB_DOUBLE_ORIGIN, startGitHubDouble } from "./github-double-server";
import { PROVIDER_DOUBLE_ORIGIN, startProviderDouble } from "./provider-double-server";
import { CONTROLLER_DOUBLE_PORT, startControllerDouble } from "./sandbox-controller-double";

const controlPlaneOrigin = process.env.ONCUE_DEV_ORIGIN ?? originsFor(slotPorts()).app;
const withControllerDouble = !process.argv.includes("--no-controller-double");

const github = await startGitHubDouble();
await github.setState(devGitHubSeed());
console.log(`[dev-services] GitHub double on ${GITHUB_DOUBLE_ORIGIN}`);

await startProviderDouble();
console.log(`[dev-services] provider double on ${PROVIDER_DOUBLE_ORIGIN}`);

if (withControllerDouble) {
  await startControllerDouble({ controlPlaneOrigin });
  console.log(
    `[dev-services] sandbox controller double on http://127.0.0.1:${CONTROLLER_DOUBLE_PORT}, bridges dial ${controlPlaneOrigin}`,
  );
} else {
  console.log(
    `[dev-services] no controller double: expecting \`pnpm controller\` on ${CONTROLLER_DOUBLE_PORT}`,
  );
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
