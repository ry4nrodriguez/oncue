/**
 * The GitHub double's seed matching what `scripts/seed-local.ts` wrote into D1
 * for the `pnpm dev` subject, each repository a real local bare repository. A
 * test that signs in as the dev subject after others reseeded the double
 * reseeds it with this.
 */

import {
  SEED_ACCOUNT_LOGIN,
  SEED_GITHUB_LOGIN,
  SEED_GITHUB_USER_ID,
  SEED_INSTALLATION_ID,
  SEED_REPOSITORIES,
  SEED_USER_TOKEN,
} from "../scripts/seed-local";
import type { GitHubDoubleSeed } from "../worker/test/github-double";
import { createSeedRepository } from "./github-bare-repo";

/**
 * One seeded repository asks for development secrets, so the disclosure card
 * and a mid-run approval can be seen on `pnpm dev`. Home does not start on it.
 */
const DECLARES_SECRETS = "acme/legacy";
const PROJECT_FILE = [
  "version: 1",
  "secrets:",
  "  required:",
  "    - DATABASE_URL",
  "  optional:",
  "    - STRIPE_TEST_KEY",
  "",
].join("\n");

export function devGitHubSeed(): GitHubDoubleSeed {
  // A real bare repository, so a session's git grant clones something that
  // exists. The sha comes from the real commit (see `github-bare-repo.ts`).
  const seededRepositories = SEED_REPOSITORIES.map((repository) => ({
    repository,
    seed: createSeedRepository(
      repository.fullName,
      "main",
      repository.fullName === DECLARES_SECRETS ? { ".oncue/project.yaml": PROJECT_FILE } : {},
    ),
  }));
  return {
    users: [{ id: SEED_GITHUB_USER_ID, login: SEED_GITHUB_LOGIN }],
    installations: [
      {
        installationId: SEED_INSTALLATION_ID,
        account: { login: SEED_ACCOUNT_LOGIN, type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [SEED_GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [SEED_INSTALLATION_ID]: seededRepositories.map(({ repository, seed }) => ({
        ...repository,
        cloneUrl: seed.cloneUrl,
      })),
    },
    refsByRepository: Object.fromEntries(
      seededRepositories.map(({ repository, seed }) => [repository.fullName, { main: seed.sha }]),
    ),
    // The real App's callback points at the hosted Worker, so a local install
    // completes against the double's install page.
    userTokens: { [SEED_USER_TOKEN]: SEED_GITHUB_USER_ID },
  };
}
