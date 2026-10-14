import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveInstallationRowId,
  disconnectRepositoriesByGitHubIds,
  type InstallationWrite,
  insertOrUpdateInstallation,
  linkGitHubIdentity,
  listInstallations,
  listInstallationsByGitHubId,
  listRepositoryConnections,
  readAuthorizedRepository,
  readSealedInstallationTokens,
  recordDelivery,
  replaceRepositoryConnections,
  setInstallationStatus,
  setInstallationStatusByRowId,
  setInstallationStatusForGitHubUser,
  touchInstallationVerified,
  updateInstallationTokens,
} from "./store";

const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T01:00:00.000Z";
const USER = "usr_gh_store";
const OTHER_USER = "usr_gh_store_other";
const WORKSPACE = "wsp_gh_store";
const OTHER_WORKSPACE = "wsp_gh_store_other";
const GITHUB_INSTALLATION = 501;
const GITHUB_USER = 9001;

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

// The write every installation test starts from. Sealed values are opaque
// strings: this module never opens one.
async function installationWrite(
  overrides: Partial<InstallationWrite> = {},
): Promise<InstallationWrite> {
  const workspaceId = overrides.workspaceId ?? WORKSPACE;
  const githubInstallationId = overrides.githubInstallationId ?? GITHUB_INSTALLATION;
  return {
    installationRowId: await deriveInstallationRowId(workspaceId, githubInstallationId),
    workspaceId,
    githubInstallationId,
    githubUserId: GITHUB_USER,
    accountLogin: "octocat",
    accountType: "User",
    sealedUserToken: "oncue1.1.usernonce.usercipher",
    sealedRefreshToken: "oncue1.1.refreshnonce.refreshcipher",
    userTokenExpiresAt: "2026-09-05T08:00:00.000Z",
    refreshTokenExpiresAt: "2027-03-05T00:00:00.000Z",
    now: NOW,
    ...overrides,
  };
}

async function insertInstallation(
  overrides: Partial<InstallationWrite> = {},
): Promise<InstallationWrite> {
  const write = await installationWrite(overrides);
  await insertOrUpdateInstallation(env.DB, write);
  return write;
}

async function readRow<T>(sql: string, ...binds: (string | number)[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `rc_new_${counter}`;
}

beforeEach(async () => {
  await seedWorkspaces();
  // Children before parents: `repository_connection` references
  // `github_installation`, and D1 enforces the foreign key on delete.
  await env.DB.prepare("DELETE FROM repository_connection").run();
  await env.DB.prepare("DELETE FROM github_installation").run();
  await env.DB.prepare("DELETE FROM webhook_delivery").run();
  await env.DB.prepare("DELETE FROM external_identity WHERE provider = 'github'").run();
});

describe("deriveInstallationRowId", () => {
  it("is stable for the same workspace and installation, so a re-run seals under the same id", async () => {
    const first = await deriveInstallationRowId(WORKSPACE, GITHUB_INSTALLATION);
    const second = await deriveInstallationRowId(WORKSPACE, GITHUB_INSTALLATION);

    expect(first).toBe(second);
    expect(first.startsWith("ghi_")).toBe(true);
  });

  it("differs by workspace and by installation", async () => {
    const mine = await deriveInstallationRowId(WORKSPACE, GITHUB_INSTALLATION);

    expect(await deriveInstallationRowId(OTHER_WORKSPACE, GITHUB_INSTALLATION)).not.toBe(mine);
    expect(await deriveInstallationRowId(WORKSPACE, GITHUB_INSTALLATION + 1)).not.toBe(mine);
  });
});

describe("insertOrUpdateInstallation", () => {
  it("writes the row record 07 step 6 names, active and sealed", async () => {
    const write = await insertInstallation();

    const stored = await readRow<{
      status: string;
      account_login: string;
      account_type: string;
      github_user_id: number;
      user_token_reference: string;
      refresh_token_reference: string;
      last_verified_at: string;
      created_at: string;
    }>(
      `SELECT status, account_login, account_type, github_user_id, user_token_reference,
              refresh_token_reference, last_verified_at, created_at
         FROM github_installation WHERE installation_row_id = ?`,
      write.installationRowId,
    );

    expect(stored).toEqual({
      status: "active",
      account_login: "octocat",
      account_type: "User",
      github_user_id: GITHUB_USER,
      user_token_reference: "oncue1.1.usernonce.usercipher",
      refresh_token_reference: "oncue1.1.refreshnonce.refreshcipher",
      last_verified_at: NOW,
      created_at: NOW,
    });
  });

  // A re-run is the user re-authorizing: tokens refresh on the same row, the
  // original `created_at` stays, and a lapsed installation becomes active.
  it("refreshes the existing row on a second run rather than minting a second one", async () => {
    const first = await insertInstallation();
    await setInstallationStatusByRowId(env.DB, first.installationRowId, "unauthorized", NOW);

    await insertInstallation({
      accountLogin: "octocat-renamed",
      accountType: "Organization",
      sealedUserToken: "oncue1.1.usernonce.newusercipher",
      sealedRefreshToken: "oncue1.1.refreshnonce.newrefreshcipher",
      now: LATER,
    });

    const rows = await env.DB.prepare(
      `SELECT installation_row_id, status, account_login, account_type, user_token_reference,
              refresh_token_reference, last_verified_at, created_at, updated_at
         FROM github_installation WHERE workspace_id = ?`,
    )
      .bind(WORKSPACE)
      .all();
    expect(rows.results).toEqual([
      {
        installation_row_id: first.installationRowId,
        status: "active",
        account_login: "octocat-renamed",
        account_type: "Organization",
        user_token_reference: "oncue1.1.usernonce.newusercipher",
        refresh_token_reference: "oncue1.1.refreshnonce.newrefreshcipher",
        last_verified_at: LATER,
        created_at: NOW,
        updated_at: LATER,
      },
    ]);
  });

  it("lets two workspaces each hold their own link to the same GitHub installation", async () => {
    await insertInstallation();
    await insertInstallation({ workspaceId: OTHER_WORKSPACE });

    expect(await listInstallations(env.DB, WORKSPACE)).toHaveLength(1);
    expect(await listInstallations(env.DB, OTHER_WORKSPACE)).toHaveLength(1);
  });
});

describe("linkGitHubIdentity", () => {
  it("records the verified GitHub user id as an external identity of the OnCue user", async () => {
    expect(await linkGitHubIdentity(env.DB, USER, GITHUB_USER, NOW)).toBe("linked");

    expect(
      await readRow<{ user_id: string; created_at: string }>(
        "SELECT user_id, created_at FROM external_identity WHERE provider = 'github' AND subject = ?",
        String(GITHUB_USER),
      ),
    ).toEqual({ user_id: USER, created_at: NOW });
  });

  it("is a no-op the second time for the same user", async () => {
    await linkGitHubIdentity(env.DB, USER, GITHUB_USER, NOW);

    expect(await linkGitHubIdentity(env.DB, USER, GITHUB_USER, LATER)).toBe("linked");
    const count = await readRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_identity WHERE provider = 'github'",
    );
    expect(count?.n).toBe(1);
  });

  // The GitHub account is already someone else's identity: the row is left as
  // it was and the caller is told.
  it("refuses to move a GitHub identity that already belongs to another user", async () => {
    await linkGitHubIdentity(env.DB, USER, GITHUB_USER, NOW);

    expect(await linkGitHubIdentity(env.DB, OTHER_USER, GITHUB_USER, LATER)).toBe(
      "linked_to_another_user",
    );
    expect(
      await readRow<{ user_id: string }>(
        "SELECT user_id FROM external_identity WHERE provider = 'github' AND subject = ?",
        String(GITHUB_USER),
      ),
    ).toEqual({ user_id: USER });
  });
});

describe("listInstallations", () => {
  it("returns the workspace's installations newest first, whatever their status", async () => {
    const older = await insertInstallation({ githubInstallationId: 1, now: NOW });
    const newer = await insertInstallation({ githubInstallationId: 2, now: LATER });
    await setInstallationStatus(env.DB, 1, "suspended", LATER);
    await insertInstallation({ workspaceId: OTHER_WORKSPACE, githubInstallationId: 3 });

    const rows = await listInstallations(env.DB, WORKSPACE);

    expect(rows.map((row) => row.installationRowId)).toEqual([
      newer.installationRowId,
      older.installationRowId,
    ]);
    expect(rows.map((row) => row.status)).toEqual(["active", "suspended"]);
  });

  it("maps every summary column and never the sealed values", async () => {
    const write = await insertInstallation();

    const rows = await listInstallations(env.DB, WORKSPACE);

    expect(rows).toEqual([
      {
        installationRowId: write.installationRowId,
        workspaceId: WORKSPACE,
        githubInstallationId: GITHUB_INSTALLATION,
        githubUserId: GITHUB_USER,
        accountLogin: "octocat",
        accountType: "User",
        status: "active",
        lastVerifiedAt: NOW,
        createdAt: NOW,
      },
    ]);
    expect(JSON.stringify(rows).includes("cipher")).toBe(false);
  });
});

describe("listInstallationsByGitHubId", () => {
  it("returns every workspace's link to the installation a webhook names", async () => {
    await insertInstallation();
    await insertInstallation({ workspaceId: OTHER_WORKSPACE });
    await insertInstallation({ githubInstallationId: 777 });

    const rows = await listInstallationsByGitHubId(env.DB, GITHUB_INSTALLATION);

    expect(rows.map((row) => row.workspaceId).sort()).toEqual([WORKSPACE, OTHER_WORKSPACE]);
  });

  it("returns nothing for an installation nobody linked", async () => {
    expect(await listInstallationsByGitHubId(env.DB, 404)).toEqual([]);
  });
});

describe("readSealedInstallationTokens", () => {
  it("returns the sealed envelopes and their expiries beside the summary", async () => {
    const write = await insertInstallation();

    expect(await readSealedInstallationTokens(env.DB, WORKSPACE, write.installationRowId)).toEqual({
      kind: "found",
      installation: {
        installationRowId: write.installationRowId,
        workspaceId: WORKSPACE,
        githubInstallationId: GITHUB_INSTALLATION,
        githubUserId: GITHUB_USER,
        accountLogin: "octocat",
        accountType: "User",
        status: "active",
        lastVerifiedAt: NOW,
        createdAt: NOW,
      },
      sealedUserToken: "oncue1.1.usernonce.usercipher",
      sealedRefreshToken: "oncue1.1.refreshnonce.refreshcipher",
      userTokenExpiresAt: "2026-09-05T08:00:00.000Z",
      refreshTokenExpiresAt: "2027-03-05T00:00:00.000Z",
    });
  });

  it("answers absent for a row that does not exist", async () => {
    expect(await readSealedInstallationTokens(env.DB, WORKSPACE, "ghi_ghost")).toEqual({
      kind: "absent",
    });
  });

  /** Indistinguishable from "does not exist", so another workspace's envelopes cannot be reached. */
  it("answers absent for another workspace's row", async () => {
    const theirs = await insertInstallation({ workspaceId: OTHER_WORKSPACE });

    expect(await readSealedInstallationTokens(env.DB, WORKSPACE, theirs.installationRowId)).toEqual(
      { kind: "absent" },
    );
  });
});

describe("updateInstallationTokens", () => {
  const fresh = {
    sealedUserToken: "oncue1.1.n2.user2",
    sealedRefreshToken: "oncue1.1.n2.refresh2",
    userTokenExpiresAt: "2026-09-05T16:00:00.000Z",
    refreshTokenExpiresAt: "2027-03-05T08:00:00.000Z",
  };

  it("replaces both envelopes and both expiries together", async () => {
    const write = await insertInstallation();

    expect(await updateInstallationTokens(env.DB, write.installationRowId, fresh, LATER)).toBe(1);

    const read = await readSealedInstallationTokens(env.DB, WORKSPACE, write.installationRowId);
    if (read.kind !== "found") {
      throw new Error("expected the row");
    }
    expect(read.sealedUserToken).toBe(fresh.sealedUserToken);
    expect(read.sealedRefreshToken).toBe(fresh.sealedRefreshToken);
    expect(read.userTokenExpiresAt).toBe(fresh.userTokenExpiresAt);
    expect(read.refreshTokenExpiresAt).toBe(fresh.refreshTokenExpiresAt);
  });

  it("reports zero when the row does not exist", async () => {
    expect(await updateInstallationTokens(env.DB, "ghi_ghost", fresh, LATER)).toBe(0);
  });
});

describe("setInstallationStatus", () => {
  it("applies the webhook's transition to every workspace's link and says how many", async () => {
    await insertInstallation();
    await insertInstallation({ workspaceId: OTHER_WORKSPACE });
    await insertInstallation({ githubInstallationId: 777 });

    expect(await setInstallationStatus(env.DB, GITHUB_INSTALLATION, "suspended", LATER)).toBe(2);

    const statuses = await env.DB.prepare(
      "SELECT github_installation_id, status FROM github_installation ORDER BY github_installation_id, workspace_id",
    ).all<{ github_installation_id: number; status: string }>();
    expect(statuses.results).toEqual([
      { github_installation_id: GITHUB_INSTALLATION, status: "suspended" },
      { github_installation_id: GITHUB_INSTALLATION, status: "suspended" },
      { github_installation_id: 777, status: "active" },
    ]);
  });

  it("reports zero when no workspace holds the installation", async () => {
    expect(await setInstallationStatus(env.DB, 404, "deleted", LATER)).toBe(0);
  });
});

describe("setInstallationStatusByRowId", () => {
  it("marks one user's link unauthorized and leaves another workspace's link alone", async () => {
    const mine = await insertInstallation();
    await insertInstallation({ workspaceId: OTHER_WORKSPACE });

    expect(
      await setInstallationStatusByRowId(env.DB, mine.installationRowId, "unauthorized", LATER),
    ).toBe(1);

    expect((await listInstallations(env.DB, WORKSPACE)).map((row) => row.status)).toEqual([
      "unauthorized",
    ]);
    expect((await listInstallations(env.DB, OTHER_WORKSPACE)).map((row) => row.status)).toEqual([
      "active",
    ]);
  });

  it("reports zero when the row does not exist", async () => {
    expect(await setInstallationStatusByRowId(env.DB, "ghi_ghost", "unauthorized", LATER)).toBe(0);
  });
});

describe("setInstallationStatusForGitHubUser", () => {
  it("disables every installation the revoking user's token vouched for, across workspaces", async () => {
    await insertInstallation();
    await insertInstallation({ githubInstallationId: 502 });
    await insertInstallation({ workspaceId: OTHER_WORKSPACE, githubInstallationId: 503 });
    await insertInstallation({
      workspaceId: OTHER_WORKSPACE,
      githubInstallationId: 504,
      githubUserId: 9002,
    });

    expect(
      await setInstallationStatusForGitHubUser(env.DB, GITHUB_USER, "unauthorized", LATER),
    ).toBe(3);

    const untouched = await readRow<{ status: string }>(
      "SELECT status FROM github_installation WHERE github_installation_id = 504",
    );
    expect(untouched?.status).toBe("active");
  });

  it("reports zero for a GitHub user nobody linked", async () => {
    expect(await setInstallationStatusForGitHubUser(env.DB, 404, "unauthorized", LATER)).toBe(0);
  });
});

describe("touchInstallationVerified", () => {
  it("resets the eight-hour clock", async () => {
    const write = await insertInstallation();

    expect(await touchInstallationVerified(env.DB, write.installationRowId, LATER)).toBe(1);

    const stored = await readRow<{ last_verified_at: string; updated_at: string }>(
      "SELECT last_verified_at, updated_at FROM github_installation WHERE installation_row_id = ?",
      write.installationRowId,
    );
    expect(stored).toEqual({ last_verified_at: LATER, updated_at: LATER });
  });

  it("reports zero when the row does not exist", async () => {
    expect(await touchInstallationVerified(env.DB, "ghi_ghost", LATER)).toBe(0);
  });
});

describe("replaceRepositoryConnections", () => {
  const hello = { githubRepositoryId: 801, fullName: "octocat/hello-world", defaultBranch: "main" };
  const spoon = {
    githubRepositoryId: 802,
    fullName: "octocat/spoon-knife",
    defaultBranch: "trunk",
  };
  const linguist = { githubRepositoryId: 803, fullName: "octocat/linguist", defaultBranch: "main" };

  it("links every repository in the authenticated list as verified", async () => {
    const write = await insertInstallation();

    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      repositories: [hello, spoon],
      newId,
      now: NOW,
    });

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows.map((row) => [row.fullName, row.defaultBranch, row.status])).toEqual([
      ["octocat/hello-world", "main", "verified"],
      ["octocat/spoon-knife", "trunk", "verified"],
    ]);
    expect(rows.every((row) => row.installationRowId === write.installationRowId)).toBe(true);
  });

  // A re-run: a repository still listed keeps its id, one now absent becomes
  // disconnected, a new one is added, all in one batch.
  it("keeps present rows by id, disconnects absent ones, and adds new ones", async () => {
    const write = await insertInstallation();
    const base = {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      newId,
      now: NOW,
    };
    await replaceRepositoryConnections(env.DB, { ...base, repositories: [hello, spoon] });
    const before = await listRepositoryConnections(env.DB, WORKSPACE);
    const helloId = before.find((row) => row.githubRepositoryId === 801)?.repositoryConnectionId;

    await replaceRepositoryConnections(env.DB, {
      ...base,
      repositories: [{ ...hello, defaultBranch: "develop" }, linguist],
      now: LATER,
    });

    const after = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(after.map((row) => [row.fullName, row.defaultBranch, row.status])).toEqual([
      ["octocat/hello-world", "develop", "verified"],
      ["octocat/linguist", "main", "verified"],
      ["octocat/spoon-knife", "trunk", "disconnected"],
    ]);
    expect(after.find((row) => row.githubRepositoryId === 801)?.repositoryConnectionId).toBe(
      helloId,
    );
  });

  it("brings a disconnected repository back to verified when it reappears", async () => {
    const write = await insertInstallation();
    const base = {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      newId,
      now: NOW,
    };
    await replaceRepositoryConnections(env.DB, { ...base, repositories: [hello] });
    await replaceRepositoryConnections(env.DB, { ...base, repositories: [] });
    expect((await listRepositoryConnections(env.DB, WORKSPACE)).map((row) => row.status)).toEqual([
      "disconnected",
    ]);

    await replaceRepositoryConnections(env.DB, { ...base, repositories: [hello] });

    expect((await listRepositoryConnections(env.DB, WORKSPACE)).map((row) => row.status)).toEqual([
      "verified",
    ]);
  });

  it("disconnects everything when the authorized list is empty", async () => {
    const write = await insertInstallation();
    const base = {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      newId,
      now: NOW,
    };
    await replaceRepositoryConnections(env.DB, { ...base, repositories: [hello, spoon] });

    await replaceRepositoryConnections(env.DB, { ...base, repositories: [], now: LATER });

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows.map((row) => row.status)).toEqual(["disconnected", "disconnected"]);
  });

  it("moves a repository to the installation that now grants access to it", async () => {
    const old = await insertInstallation({ githubInstallationId: 1 });
    const fresh = await insertInstallation({ githubInstallationId: 2 });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: old.installationRowId,
      repositories: [hello],
      newId,
      now: NOW,
    });

    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: fresh.installationRowId,
      repositories: [hello],
      newId,
      now: LATER,
    });

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => [row.installationRowId, row.status])).toEqual([
      [fresh.installationRowId, "verified"],
    ]);
  });

  it("leaves another installation's rows in the same workspace untouched", async () => {
    const one = await insertInstallation({ githubInstallationId: 1 });
    const two = await insertInstallation({ githubInstallationId: 2 });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: one.installationRowId,
      repositories: [hello],
      newId,
      now: NOW,
    });

    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: two.installationRowId,
      repositories: [spoon],
      newId,
      now: NOW,
    });

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows.map((row) => [row.fullName, row.status])).toEqual([
      ["octocat/hello-world", "verified"],
      ["octocat/spoon-knife", "verified"],
    ]);
  });

  it("leaves another workspace's rows untouched", async () => {
    const mine = await insertInstallation();
    const theirs = await insertInstallation({ workspaceId: OTHER_WORKSPACE });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: OTHER_WORKSPACE,
      installationRowId: theirs.installationRowId,
      repositories: [hello],
      newId,
      now: NOW,
    });

    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: mine.installationRowId,
      repositories: [spoon],
      newId,
      now: LATER,
    });

    expect(
      (await listRepositoryConnections(env.DB, OTHER_WORKSPACE)).map((row) => row.status),
    ).toEqual(["verified"]);
  });
});

describe("listRepositoryConnections", () => {
  it("maps every column, in full-name order, scoped to the workspace", async () => {
    const mine = await insertInstallation();
    const theirs = await insertInstallation({ workspaceId: OTHER_WORKSPACE });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: OTHER_WORKSPACE,
      installationRowId: theirs.installationRowId,
      repositories: [{ githubRepositoryId: 900, fullName: "a/first", defaultBranch: "main" }],
      newId,
      now: NOW,
    });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: mine.installationRowId,
      repositories: [
        { githubRepositoryId: 802, fullName: "octocat/spoon-knife", defaultBranch: "trunk" },
        { githubRepositoryId: 801, fullName: "octocat/hello-world", defaultBranch: "main" },
      ],
      newId,
      now: NOW,
    });

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);

    expect(rows.map((row) => row.fullName)).toEqual(["octocat/hello-world", "octocat/spoon-knife"]);
    expect(rows.map((row) => row.githubRepositoryId)).toEqual([801, 802]);
    expect(rows.map((row) => row.defaultBranch)).toEqual(["main", "trunk"]);
    expect(rows.every((row) => row.installationRowId === mine.installationRowId)).toBe(true);
    expect(rows.every((row) => row.status === "verified")).toBe(true);
    expect(rows.every((row) => row.createdAt === NOW)).toBe(true);
    expect(rows.every((row) => row.repositoryConnectionId.startsWith("rc_new_"))).toBe(true);
  });

  it("returns nothing for a workspace with no repositories", async () => {
    expect(await listRepositoryConnections(env.DB, WORKSPACE)).toEqual([]);
  });
});

describe("disconnectRepositoriesByGitHubIds", () => {
  const hello = { githubRepositoryId: 801, fullName: "octocat/hello-world", defaultBranch: "main" };
  const spoon = { githubRepositoryId: 802, fullName: "octocat/spoon-knife", defaultBranch: "main" };

  it("disconnects the named repositories and leaves the rest of the installation's alone", async () => {
    const write = await insertInstallation();
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      repositories: [hello, spoon],
      newId,
      now: NOW,
    });

    expect(
      await disconnectRepositoriesByGitHubIds(env.DB, write.installationRowId, [801, 999], LATER),
    ).toBe(1);

    const rows = await listRepositoryConnections(env.DB, WORKSPACE);
    expect(rows.map((row) => [row.githubRepositoryId, row.status])).toEqual([
      [801, "disconnected"],
      [802, "verified"],
    ]);
  });

  // Another workspace's link to the same repository is a different row under a
  // different grant, untouched by this removal.
  it("leaves the same repository linked through another installation untouched", async () => {
    const mine = await insertInstallation();
    const theirs = await insertInstallation({ workspaceId: OTHER_WORKSPACE });
    for (const [workspaceId, installationRowId] of [
      [WORKSPACE, mine.installationRowId],
      [OTHER_WORKSPACE, theirs.installationRowId],
    ] as const) {
      await replaceRepositoryConnections(env.DB, {
        workspaceId,
        installationRowId,
        repositories: [hello],
        newId,
        now: NOW,
      });
    }

    expect(
      await disconnectRepositoriesByGitHubIds(env.DB, mine.installationRowId, [801], LATER),
    ).toBe(1);

    expect(
      (await listRepositoryConnections(env.DB, OTHER_WORKSPACE)).map((row) => row.status),
    ).toEqual(["verified"]);
  });

  it("reports zero when nothing matched, including an already disconnected row", async () => {
    const write = await insertInstallation();
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WORKSPACE,
      installationRowId: write.installationRowId,
      repositories: [hello],
      newId,
      now: NOW,
    });
    await disconnectRepositoriesByGitHubIds(env.DB, write.installationRowId, [801], LATER);

    expect(
      await disconnectRepositoriesByGitHubIds(env.DB, write.installationRowId, [801], LATER),
    ).toBe(0);
    expect(
      await disconnectRepositoriesByGitHubIds(env.DB, write.installationRowId, [], LATER),
    ).toBe(0);
  });
});

describe("readAuthorizedRepository", () => {
  const hello = { githubRepositoryId: 801, fullName: "octocat/hello-world", defaultBranch: "main" };

  async function linkHello(workspaceId: string): Promise<{
    installationRowId: string;
    repositoryConnectionId: string;
  }> {
    const write = await insertInstallation({ workspaceId });
    await replaceRepositoryConnections(env.DB, {
      workspaceId,
      installationRowId: write.installationRowId,
      repositories: [hello],
      newId,
      now: NOW,
    });
    const rows = await listRepositoryConnections(env.DB, workspaceId);
    const row = rows.find((candidate) => candidate.githubRepositoryId === 801);
    if (row === undefined) {
      throw new Error("expected the linked repository");
    }
    return {
      installationRowId: write.installationRowId,
      repositoryConnectionId: row.repositoryConnectionId,
    };
  }

  it("returns the repository with both statuses for the owning workspace", async () => {
    const linked = await linkHello(WORKSPACE);

    expect(
      await readAuthorizedRepository(env.DB, WORKSPACE, linked.repositoryConnectionId),
    ).toEqual({
      kind: "found",
      row: {
        repositoryConnectionId: linked.repositoryConnectionId,
        installationRowId: linked.installationRowId,
        githubInstallationId: GITHUB_INSTALLATION,
        githubRepositoryId: 801,
        fullName: "octocat/hello-world",
        defaultBranch: "main",
        status: "verified",
        installationStatus: "active",
        removedAt: null,
      },
    });
  });

  it("carries a disconnected repository and a lapsed installation through as facts", async () => {
    const linked = await linkHello(WORKSPACE);
    await disconnectRepositoriesByGitHubIds(env.DB, linked.installationRowId, [801], LATER);
    await setInstallationStatus(env.DB, GITHUB_INSTALLATION, "deleted", LATER);

    const found = await readAuthorizedRepository(env.DB, WORKSPACE, linked.repositoryConnectionId);
    if (found.kind !== "found") {
      throw new Error("expected the row");
    }

    expect(found.row.status).toBe("disconnected");
    expect(found.row.installationStatus).toBe("deleted");
  });

  it("answers absent for an id that does not exist", async () => {
    expect(await readAuthorizedRepository(env.DB, WORKSPACE, "rc_ghost")).toEqual({
      kind: "absent",
    });
  });

  /** Indistinguishable from "does not exist", so repository connection ids cannot be probed. */
  it("answers absent for another workspace's repository", async () => {
    const theirs = await linkHello(OTHER_WORKSPACE);

    expect(
      await readAuthorizedRepository(env.DB, WORKSPACE, theirs.repositoryConnectionId),
    ).toEqual({ kind: "absent" });
  });
});

describe("recordDelivery", () => {
  it("records a delivery the first time it is seen", async () => {
    expect(await recordDelivery(env.DB, "dlv_1", "installation", NOW)).toBe("first");

    expect(
      await readRow<{ event_name: string; received_at: string }>(
        "SELECT event_name, received_at FROM webhook_delivery WHERE delivery_id = 'dlv_1'",
      ),
    ).toEqual({ event_name: "installation", received_at: NOW });
  });

  /** The at-least-once arm: the row from the first attempt stands, and the caller is told not to apply. */
  it("reports a replay for a delivery id it already holds, leaving the first record in place", async () => {
    await recordDelivery(env.DB, "dlv_1", "installation", NOW);

    expect(await recordDelivery(env.DB, "dlv_1", "installation", LATER)).toBe("replay");

    expect(
      await readRow<{ received_at: string }>(
        "SELECT received_at FROM webhook_delivery WHERE delivery_id = 'dlv_1'",
      ),
    ).toEqual({ received_at: NOW });
  });

  it("treats a different delivery id for the same event as a first delivery", async () => {
    await recordDelivery(env.DB, "dlv_1", "push", NOW);

    expect(await recordDelivery(env.DB, "dlv_2", "push", NOW)).toBe("first");
  });
});
