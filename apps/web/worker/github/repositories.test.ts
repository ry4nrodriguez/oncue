import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readGitHubFact, resolveRepository } from "./repositories";
import {
  deriveInstallationRowId,
  disconnectRepositoriesByGitHubIds,
  type InstallationStatus,
  type InstallationWrite,
  insertOrUpdateInstallation,
  listRepositoryConnections,
  type RepositoryInput,
  replaceRepositoryConnections,
  setInstallationStatusByRowId,
  setRepositoryRemoved,
} from "./store";

const NOW = "2026-09-05T00:00:00.000Z";
const USER = "usr_gh_repos";
const OTHER_USER = "usr_gh_repos_other";
const WORKSPACE = "wsp_gh_repos";
const OTHER_WORKSPACE = "wsp_gh_repos_other";
const INSTALLATION = 7001;
const SECOND_INSTALLATION = 7002;

const WIDGETS: RepositoryInput = {
  githubRepositoryId: 1,
  fullName: "acme/widgets",
  defaultBranch: "main",
};
const GADGETS: RepositoryInput = {
  githubRepositoryId: 2,
  fullName: "acme/gadgets",
  defaultBranch: "main",
};

async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_WORKSPACE, OTHER_USER, NOW, NOW),
  ]);
}

// Opaque sealed strings: nothing here opens an envelope.
async function installation(
  workspaceId: string,
  githubInstallationId: number,
  status: InstallationStatus = "active",
): Promise<string> {
  const installationRowId = await deriveInstallationRowId(workspaceId, githubInstallationId);
  const write: InstallationWrite = {
    installationRowId,
    workspaceId,
    githubInstallationId,
    githubUserId: 42,
    accountLogin: "octocat",
    accountType: "User",
    sealedUserToken: "oncue1.1.usernonce.usercipher",
    sealedRefreshToken: "oncue1.1.refreshnonce.refreshcipher",
    userTokenExpiresAt: "2026-09-05T08:00:00.000Z",
    refreshTokenExpiresAt: "2027-03-05T00:00:00.000Z",
    now: NOW,
  };
  await insertOrUpdateInstallation(env.DB, write);
  if (status !== "active") {
    await setInstallationStatusByRowId(env.DB, installationRowId, status, NOW);
  }
  return installationRowId;
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `rc_repos_${counter}`;
}

async function link(
  workspaceId: string,
  installationRowId: string,
  repositories: readonly RepositoryInput[],
): Promise<void> {
  await replaceRepositoryConnections(env.DB, {
    workspaceId,
    installationRowId,
    repositories,
    newId,
    now: NOW,
  });
}

async function connectionIdOf(workspaceId: string, fullName: string): Promise<string> {
  const rows = await listRepositoryConnections(env.DB, workspaceId);
  const row = rows.find((candidate) => candidate.fullName === fullName);
  if (row === undefined) {
    throw new Error(`no connection for ${fullName}`);
  }
  return row.repositoryConnectionId;
}

beforeEach(async () => {
  await seedWorkspaces();
  await env.DB.prepare("DELETE FROM repository_connection").run();
  await env.DB.prepare("DELETE FROM github_installation").run();
});

describe("readGitHubFact", () => {
  it("is none when the workspace holds no installation", async () => {
    expect(await readGitHubFact(env.DB, WORKSPACE)).toEqual({ kind: "none" });
  });

  it("is none when every installation has lapsed, because the user must re-authorize", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION, "unauthorized");
    await link(WORKSPACE, rowId, [WIDGETS]);
    await installation(WORKSPACE, SECOND_INSTALLATION, "suspended");

    expect(await readGitHubFact(env.DB, WORKSPACE)).toEqual({ kind: "none" });
  });

  it("is installed with no repositories when the active installation grants none", async () => {
    await installation(WORKSPACE, INSTALLATION);

    expect(await readGitHubFact(env.DB, WORKSPACE)).toEqual({
      kind: "installed",
      repositories: [],
    });
  });

  it("lists verified repositories under an active installation, by name", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS, GADGETS]);

    expect(await readGitHubFact(env.DB, WORKSPACE)).toEqual({
      kind: "installed",
      repositories: [
        {
          repositoryConnectionId: await connectionIdOf(WORKSPACE, GADGETS.fullName),
          fullName: GADGETS.fullName,
        },
        {
          repositoryConnectionId: await connectionIdOf(WORKSPACE, WIDGETS.fullName),
          fullName: WIDGETS.fullName,
        },
      ],
    });
  });

  it("omits a disconnected repository, which resolveRepository would only refuse", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS, GADGETS]);
    await disconnectRepositoriesByGitHubIds(env.DB, rowId, [GADGETS.githubRepositoryId], NOW);

    const fact = await readGitHubFact(env.DB, WORKSPACE);

    expect(fact.kind === "installed" && fact.repositories.map((r) => r.fullName)).toEqual([
      WIDGETS.fullName,
    ]);
  });

  it("omits a verified repository whose own installation has lapsed while another is active", async () => {
    const active = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, active, [WIDGETS]);
    const lapsed = await installation(WORKSPACE, SECOND_INSTALLATION, "unauthorized");
    await link(WORKSPACE, lapsed, [GADGETS]);

    const fact = await readGitHubFact(env.DB, WORKSPACE);

    expect(fact.kind === "installed" && fact.repositories.map((r) => r.fullName)).toEqual([
      WIDGETS.fullName,
    ]);
  });

  it("never reads another workspace's rows", async () => {
    const rowId = await installation(OTHER_WORKSPACE, INSTALLATION);
    await link(OTHER_WORKSPACE, rowId, [WIDGETS]);

    expect(await readGitHubFact(env.DB, WORKSPACE)).toEqual({ kind: "none" });
  });
});

describe("resolveRepository", () => {
  it("is none when the body names no repository", async () => {
    expect(await resolveRepository(env.DB, WORKSPACE, undefined)).toEqual({ kind: "none" });
    expect(await resolveRepository(env.DB, WORKSPACE, null)).toEqual({ kind: "none" });
    expect(await resolveRepository(env.DB, WORKSPACE, "text")).toEqual({ kind: "none" });
    expect(await resolveRepository(env.DB, WORKSPACE, [])).toEqual({ kind: "none" });
    expect(await resolveRepository(env.DB, WORKSPACE, {})).toEqual({ kind: "none" });
    expect(await resolveRepository(env.DB, WORKSPACE, { modelConnectionId: "mc_1" })).toEqual({
      kind: "none",
    });
  });

  it("refuses a non-string or empty id as malformed", async () => {
    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: 7 })).toEqual({
      kind: "refused",
      reason: "malformed",
    });
    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: null })).toEqual({
      kind: "refused",
      reason: "malformed",
    });
    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: "" })).toEqual({
      kind: "refused",
      reason: "malformed",
    });
  });

  it("refuses an id that does not exist as not_usable", async () => {
    expect(
      await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: "rc_missing" }),
    ).toEqual({ kind: "refused", reason: "not_usable" });
  });

  it("refuses another workspace's id with the same not_usable, so ids cannot be probed", async () => {
    const rowId = await installation(OTHER_WORKSPACE, INSTALLATION);
    await link(OTHER_WORKSPACE, rowId, [WIDGETS]);
    const theirs = await connectionIdOf(OTHER_WORKSPACE, WIDGETS.fullName);

    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: theirs })).toEqual({
      kind: "refused",
      reason: "not_usable",
    });
  });

  it("refuses the caller's own disconnected repository as not_connected", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS]);
    await disconnectRepositoriesByGitHubIds(env.DB, rowId, [WIDGETS.githubRepositoryId], NOW);
    const mine = await connectionIdOf(WORKSPACE, WIDGETS.fullName);

    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: mine })).toEqual({
      kind: "refused",
      reason: "not_connected",
    });
  });

  it("refuses a verified repository whose installation is not active as not_connected", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS]);
    await setInstallationStatusByRowId(env.DB, rowId, "unauthorized", NOW);
    const mine = await connectionIdOf(WORKSPACE, WIDGETS.fullName);

    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: mine })).toEqual({
      kind: "refused",
      reason: "not_connected",
    });
  });

  it("resolves a verified repository under an active installation to the row session creation needs", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS]);
    const mine = await connectionIdOf(WORKSPACE, WIDGETS.fullName);

    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: mine })).toEqual({
      kind: "resolved",
      repository: {
        repositoryConnectionId: mine,
        installationRowId: rowId,
        githubInstallationId: INSTALLATION,
        githubRepositoryId: WIDGETS.githubRepositoryId,
        fullName: WIDGETS.fullName,
        defaultBranch: WIDGETS.defaultBranch,
        status: "verified",
        installationStatus: "active",
        removedAt: null,
      },
    });
  });

  it("refuses a repository removed under Settings as not_connected, and lists it nowhere the composer reads", async () => {
    const rowId = await installation(WORKSPACE, INSTALLATION);
    await link(WORKSPACE, rowId, [WIDGETS, GADGETS]);
    const mine = await connectionIdOf(WORKSPACE, WIDGETS.fullName);

    const removed = await setRepositoryRemoved(env.DB, WORKSPACE, mine, NOW, NOW);
    expect(removed?.removedAt).toBe(NOW);
    expect(await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: mine })).toEqual({
      kind: "refused",
      reason: "not_connected",
    });
    const fact = await readGitHubFact(env.DB, WORKSPACE);
    expect(fact.kind === "installed" ? fact.repositories.map((r) => r.fullName) : []).toEqual([
      GADGETS.fullName,
    ]);
    // Removal survives the connection flow's re-sync, which rewrites status.
    await link(WORKSPACE, rowId, [WIDGETS, GADGETS]);
    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows.find((row) => row.repositoryConnectionId === mine)?.removedAt).toBe(NOW);

    // Another workspace's id is not found; restore clears it.
    expect(await setRepositoryRemoved(env.DB, OTHER_WORKSPACE, mine, null, NOW)).toBeNull();
    const restored = await setRepositoryRemoved(env.DB, WORKSPACE, mine, null, NOW);
    expect(restored?.removedAt).toBeNull();
    expect(
      (await resolveRepository(env.DB, WORKSPACE, { repositoryConnectionId: mine })).kind,
    ).toBe("resolved");
  });
});
