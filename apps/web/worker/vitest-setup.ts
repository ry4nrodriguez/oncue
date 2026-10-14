// Applies the D1 migrations that `vitest.config.ts` reads into the test-only
// `TEST_MIGRATIONS` binding. That binding is not in the generated `Env`, hence
// the cast.

import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
