/**
 * Drives `createGitHubDouble` end to end: the App JWT is signed with a real
 * key and the token is minted, narrowed, used, and revoked through the routes
 * the production code calls.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { GitHubAppDeps } from "../github/app";
import { createGitHubDouble, type GitHubDouble } from "../test/github-double";
import { mintFailureCategory, readRepositoryDeclaration } from "./disclosure";

const INSTALLATION_ID = 9001;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const MAIN_SHA = "a".repeat(40);
const OLDER_SHA = "b".repeat(40);
const REPOSITORY = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO.id,
  fullName: REPO.fullName,
  branch: REPO.defaultBranch,
};
const FILE = "secrets:\n  required:\n    - DATABASE_URL\n  optional:\n    - STRIPE_TEST_KEY\n";

let privateKeyPem = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of der) {
    binary += String.fromCharCode(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
});

function seeded(refs: Readonly<Record<string, string>> = { main: MAIN_SHA }): GitHubDouble {
  return createGitHubDouble({
    users: [{ id: 42, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue",
        visibleToUserIds: [42],
      },
    ],
    repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
    refsByRepository: { [REPO.fullName]: refs },
  });
}

function depsFor(double: GitHubDouble): GitHubAppDeps {
  return {
    fetchImpl: double.fetchImpl,
    apiOrigin: "https://api.github.test",
    appId: "12345",
    privateKeyPem,
    now: () => Date.parse("2026-09-21T00:00:00.000Z"),
  };
}

describe("readRepositoryDeclaration", () => {
  it("reads the default branch's head and the file at that commit, under a read-only token it revokes", async () => {
    const double = seeded();
    double.setFile(REPO.fullName, ".oncue/project.yaml", FILE);

    expect(await readRepositoryDeclaration(depsFor(double), REPOSITORY, null)).toEqual({
      kind: "read",
      baseSha: MAIN_SHA,
      tipSha: MAIN_SHA,
      protected: false,
      defaultBranch: null,
      declaration: {
        kind: "declared",
        secrets: { required: ["DATABASE_URL"], optional: ["STRIPE_TEST_KEY"] },
      },
    });

    const minted = double.calls.find((call) => call.tokenNarrowing !== undefined);
    expect(minted?.tokenNarrowing).toEqual({
      repositoryIds: [REPO.id],
      permissions: { contents: "read" },
    });
    expect(double.calls.at(-1)).toMatchObject({ tokenRevoked: true });
  });

  it("reads at the commit it is given, not at the branch's head", async () => {
    const double = seeded();
    double.setFile(REPO.fullName, ".oncue/project.yaml", FILE, { ref: OLDER_SHA });
    double.setFile(
      REPO.fullName,
      ".oncue/project.yaml",
      "secrets:\n  required:\n    - SOMETHING_NEWER\n",
      { ref: MAIN_SHA },
    );

    const read = await readRepositoryDeclaration(depsFor(double), REPOSITORY, OLDER_SHA);

    expect(read).toMatchObject({
      kind: "read",
      baseSha: OLDER_SHA,
      // The tip is still read, so a launch can tell the card's commit from a moved base.
      tipSha: MAIN_SHA,
      declaration: { secrets: { required: ["DATABASE_URL"] } },
    });
    // The file was read at the given commit: the double holds it only at
    // OLDER_SHA.
  });

  it("reports a repository with no project file as declaring nothing", async () => {
    expect(await readRepositoryDeclaration(depsFor(seeded()), REPOSITORY, null)).toEqual({
      kind: "read",
      baseSha: MAIN_SHA,
      tipSha: MAIN_SHA,
      protected: false,
      defaultBranch: null,
      declaration: { kind: "none" },
    });
  });

  it("reads at the tip of the branch it is given, and says whether GitHub protects it", async () => {
    const double = createGitHubDouble({
      installations: [
        {
          installationId: INSTALLATION_ID,
          account: { login: "acme", type: "Organization" },
          appSlug: "oncue",
          visibleToUserIds: [42],
        },
      ],
      repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
      refsByRepository: { [REPO.fullName]: { main: MAIN_SHA, "release/1.4": OLDER_SHA } },
      protectedBranchesByRepository: { [REPO.fullName]: ["release/1.4"] },
    });
    expect(
      await readRepositoryDeclaration(
        depsFor(double),
        { ...REPOSITORY, branch: "release/1.4" },
        null,
      ),
    ).toMatchObject({ kind: "read", baseSha: OLDER_SHA, tipSha: OLDER_SHA, protected: true });
    expect(double.calls.map((call) => call.path)).toContain(
      `/repos/${REPO.fullName}/branches/release/1.4`,
    );
  });

  it("reads the default branch as GitHub holds it now when asked, under the same token", async () => {
    const double = seeded({ main: MAIN_SHA, trunk: OLDER_SHA });
    double.setDefaultBranch(REPO.fullName, "trunk");
    const read = await readRepositoryDeclaration(
      depsFor(double),
      { ...REPOSITORY, readDefaultBranch: true },
      null,
    );
    expect(read).toMatchObject({ kind: "read", defaultBranch: "trunk" });
    expect(double.calls.filter((call) => call.tokenNarrowing !== undefined)).toHaveLength(1);
  });

  it("reads a ruleset that guards pushes as protection when asked about the default branch", async () => {
    const double = seeded({ main: MAIN_SHA, "feature/x": OLDER_SHA });
    double.setRulesets(REPO.fullName, [
      {
        id: 1,
        name: "Features",
        target: "branch",
        enforcement: "active",
        include: ["refs/heads/feature/*"],
        exclude: [],
        rules: ["pull_request"],
      },
    ]);
    expect(
      await readRepositoryDeclaration(
        depsFor(double),
        { ...REPOSITORY, branch: "feature/x", readDefaultBranch: true },
        null,
      ),
    ).toMatchObject({ kind: "read", protected: true, defaultBranch: "main" });
    // Starting from it reads no rules: nothing pushes there.
    expect(
      await readRepositoryDeclaration(
        depsFor(double),
        { ...REPOSITORY, branch: "feature/x" },
        null,
      ),
    ).toMatchObject({ kind: "read", protected: false });
  });

  it("fails closed when the branch's rules cannot be read", async () => {
    const double = seeded();
    const failing =
      (answer: () => Response): typeof fetch =>
      async (input, init) =>
        String(input).includes("/rules/branches/") ? answer() : double.fetchImpl(input, init);
    const asked = { ...REPOSITORY, readDefaultBranch: true };
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: failing(() => new Response("", { status: 500 })) },
        asked,
        null,
      ),
    ).toEqual({
      kind: "failed",
      reason: "branch_rules_unreadable",
      errorCategory: "rules_read_rejected",
    });
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: failing(() => new Response("", { status: 404 })) },
        asked,
        null,
      ),
    ).toEqual({
      kind: "failed",
      reason: "branch_rules_unreadable",
      errorCategory: "rules_read_repository_missing",
    });
    expect(double.calls.at(-1)).toMatchObject({ tokenRevoked: true });
  });

  it("fails as GitHub's failure when the default branch cannot be read, and still revokes", async () => {
    const double = seeded();
    const failing =
      (answer: () => Promise<Response>): typeof fetch =>
      async (input, init) =>
        new URL(String(input)).pathname === `/repos/${REPO.fullName}`
          ? answer()
          : double.fetchImpl(input, init);
    const asked = { ...REPOSITORY, readDefaultBranch: true };
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: failing(async () => new Response("", { status: 500 })) },
        asked,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "repository_read_rejected_500" });
    expect(double.calls.at(-1)).toMatchObject({ tokenRevoked: true });
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: failing(async () => new Response("", { status: 404 })) },
        asked,
        null,
      ),
    ).toEqual({
      kind: "failed",
      reason: "github",
      errorCategory: "repository_read_repository_missing",
    });
  });

  it("does not follow a symlink at the project file's path", async () => {
    const double = seeded();
    double.setFile(REPO.fullName, ".oncue/project.yaml", "../secrets.yaml", { kind: "symlink" });
    expect(await readRepositoryDeclaration(depsFor(double), REPOSITORY, null)).toMatchObject({
      declaration: { kind: "unreadable", category: "not_a_file" },
    });
  });

  it("fails when the default branch is gone, and still revokes the token", async () => {
    const double = seeded({ other: MAIN_SHA });
    expect(await readRepositoryDeclaration(depsFor(double), REPOSITORY, null)).toEqual({
      kind: "failed",
      reason: "base_branch_missing",
      errorCategory: "branch_missing",
    });
    expect(double.calls.at(-1)).toMatchObject({ tokenRevoked: true });
  });

  it("fails as GitHub's failure when the branch read fails, with the category and status", async () => {
    const double = seeded();
    const failingRefs: typeof fetch = async (input, init) =>
      String(input).includes("/branches/")
        ? new Response("", { status: 500 })
        : double.fetchImpl(input, init);
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: failingRefs },
        REPOSITORY,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "branch_read_rejected_500" });

    const unreachableRefs: typeof fetch = async (input, init) => {
      if (String(input).includes("/branches/")) {
        throw new TypeError("network down");
      }
      return double.fetchImpl(input, init);
    };
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(double), fetchImpl: unreachableRefs },
        REPOSITORY,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "branch_read_unreachable" });
  });

  // A 404 on the mint means the installation is gone; only reconnecting fixes it.
  it("reads a mint GitHub answers 404 as the installation being gone", async () => {
    expect(
      await readRepositoryDeclaration(
        depsFor(seeded()),
        { ...REPOSITORY, installationId: 7777 },
        null,
      ),
    ).toEqual({
      kind: "failed",
      reason: "installation_missing",
      errorCategory: "mint_rejected_404",
    });
  });

  it("reads every other mint failure as GitHub's failure, named", async () => {
    const answering =
      (status: number): typeof fetch =>
      async () =>
        new Response("", { status });
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(seeded()), fetchImpl: answering(401) },
        REPOSITORY,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "mint_rejected_401" });

    const unreachable: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    expect(
      await readRepositoryDeclaration(
        { ...depsFor(seeded()), fetchImpl: unreachable },
        REPOSITORY,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "mint_unreachable" });

    expect(
      await readRepositoryDeclaration(
        { ...depsFor(seeded()), privateKeyPem: "not a key" },
        REPOSITORY,
        null,
      ),
    ).toEqual({ kind: "failed", reason: "github", errorCategory: "mint_private_key_malformed" });
  });
});

describe("mintFailureCategory", () => {
  it.each([
    [{ kind: "refused", reason: "empty_repository_list" } as const, "mint_empty_repository_list"],
    [{ kind: "failed", category: "unreachable", status: null } as const, "mint_unreachable"],
    [{ kind: "failed", category: "rejected", status: 404 } as const, "mint_rejected_404"],
    [
      { kind: "failed", category: "malformed_response", status: 201 } as const,
      "mint_malformed_response_201",
    ],
  ])("names %o as %s", (failure, expected) => {
    expect(mintFailureCategory(failure)).toBe(expected);
  });
});
