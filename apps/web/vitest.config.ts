import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * A throwaway two-version broker keyring, generated per run and never written
 * to disk; two versions so key rotation can be tested. It is not a
 * `wrangler.jsonc` var, because a var ships with the deployed Worker and could
 * stand in for a real secret a hosted deploy forgot to set.
 */
function testKeyring(): string {
  const key = () => randomBytes(32).toString("base64url");
  return `2:${key()},1:${key()}`;
}

const oneHundredPercentBranches = {
  branches: 100,
  functions: 100,
  lines: 100,
  statements: 100,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html"],
      include: ["worker/**/*.ts", "src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "src/main.tsx",
        // A canvas renderer: jsdom has no getContext, so no unit test can draw
        // it.
        "src/features/home/AsciiField.tsx",
        "worker/*.d.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "worker/auth/**": oneHundredPercentBranches,
        "worker/policy/**": oneHundredPercentBranches,
        "worker/session/**": oneHundredPercentBranches,
        "worker/broker/**": oneHundredPercentBranches,
        "worker/sandbox/**": oneHundredPercentBranches,
        // Seals and opens the user's Modal token pair, so a missed branch is an
        // untested credential path.
        "worker/modal/**": oneHundredPercentBranches,
        "worker/secrets/**": oneHundredPercentBranches,
        // The workspace's answers to the agent's permission asks: a missed branch
        // is an untested authorization path.
        "worker/approvals/**": oneHundredPercentBranches,
        "worker/deletion/**": oneHundredPercentBranches,
        // GitHub App private key, installation tokens, and webhook signature
        // verification: a missed branch is an untested credential path.
        "worker/github/**": oneHundredPercentBranches,
        // Mints and checks one-time upload and restore tokens: a missed branch
        // is an untested authorization path.
        "worker/artifacts/**": oneHundredPercentBranches,
        // Who may upload, claim, view, and fetch a person's files, and the
        // type they are served as.
        "worker/attachments/**": oneHundredPercentBranches,
        "../../packages/protocol/src/redact*": oneHundredPercentBranches,
      },
    },
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(
                  fileURLToPath(new URL("./migrations", import.meta.url)),
                ),
                ONCUE_BROKER_KEYRING: testKeyring(),
                // Miniflare loads `.dev.vars`, so a real GitHub App configured
                // there would let route tests pass for the wrong reason. Bindings
                // win over `.dev.vars`; a test that needs GitHub states it via
                // `githubTestSettings` in `worker/test/github-double.ts`.
                ONCUE_GITHUB_APP_SLUG: "",
                ONCUE_GITHUB_APP_ID: "",
                ONCUE_GITHUB_APP_PRIVATE_KEY: "",
                ONCUE_GITHUB_CLIENT_ID: "",
                ONCUE_GITHUB_CLIENT_SECRET: "",
                ONCUE_GITHUB_WEBHOOK_SECRET: "",
                ONCUE_GITHUB_API_ORIGIN: "",
                // The local test fixtures shorten approval expiry; tests expect
                // the real ten minutes.
                ONCUE_APPROVAL_TTL_SECONDS: "",
                // Blanked so `selectSandboxDriver` reads "unconfigured" and the
                // session tests use the fake driver instead of creating paid
                // Modal sandboxes from a `.dev.vars` controller.
                ONCUE_SANDBOX_CONTROLLER_ORIGIN: "",
                ONCUE_SANDBOX_CONTROLLER_TOKEN: "",
                // The harness allowlist: a test that needs a harness enabled
                // states it, and every other test sees OpenCode alone.
                ONCUE_RUNTIME_ALLOWLIST: "",
                // The live cost guard `pnpm dev:live` writes into `.dev.vars`.
                // Blank means no narrowing; the test for the guard states it.
                ONCUE_MODEL_ALLOWLIST: "",
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["worker/**/*.test.ts"],
          setupFiles: ["./worker/vitest-setup.ts"],
          // A session object keeps logging after its test returns. With console
          // interception on, a late `console.log` goes to a closed runner
          // channel and vitest hangs before its summary.
          disableConsoleIntercept: true,
        },
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        test: {
          name: "web",
          environment: "jsdom",
          // `scripts/**/*.test.mjs` runs the secret-pattern tests in
          // `pnpm check`. `e2e/**/*.test.ts` holds unit tests of the e2e
          // helpers; Playwright runs only `*.spec.ts`.
          include: [
            "src/**/*.test.{ts,tsx}",
            "vite-plugins/**/*.test.ts",
            "scripts/**/*.test.mjs",
            "e2e/**/*.test.ts",
          ],
          globals: false,
        },
      },
    ],
  },
});
