import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveKeyring, type Keyring } from "../broker/envelope";
import {
  deleteDevelopmentSecret,
  developmentSecretIsSaved,
  listDevelopmentSecrets,
  openDevelopmentSecrets,
  openSecretsById,
  readLastDisclosedNames,
  repositoryConnectionIdFor,
  type SaveSecretDeps,
  type SecretScope,
  saveDevelopmentSecret,
  savedSecretNames,
  writeDisclosedNames,
} from "./store";

const NOW = "2026-09-21T00:00:00.000Z";
const LATER = "2026-09-21T01:00:00.000Z";
const WORKSPACE = "wsp_secrets";
const OTHER_WORKSPACE = "wsp_secrets_other";
const SCOPE: SecretScope = { workspaceId: WORKSPACE, repositoryConnectionId: "rpc_widgets" };
const SIBLING: SecretScope = { workspaceId: WORKSPACE, repositoryConnectionId: "rpc_gadgets" };
const OTHERS: SecretScope = { workspaceId: OTHER_WORKSPACE, repositoryConnectionId: "rpc_theirs" };

/** Obviously fake, and long enough for the redactor. */
const FAKE_VALUE = "fake-database-url-0001";
const FAKE_REPLACEMENT = "fake-database-url-0002";

function randomKeyText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function credentialKeyring(): Promise<Keyring<"credential">> {
  const result = await deriveKeyring(`1:${randomKeyText()}`, "credential");
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

function depsWith(keyring: Keyring<"credential">, now: string = NOW): SaveSecretDeps {
  let minted = 0;
  return {
    keyring,
    now,
    newSecretId: () => {
      minted += 1;
      return `dsc_${now.slice(11, 13)}_${minted}`;
    },
  };
}

async function seed(): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const [user, workspace, installation] of [
    ["usr_secrets", WORKSPACE, "ins_secrets"],
    ["usr_secrets_other", OTHER_WORKSPACE, "ins_secrets_other"],
  ] as const) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(user, NOW, NOW),
      env.DB.prepare(
        "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(workspace, user, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO github_installation (
           installation_row_id, workspace_id, github_installation_id, github_user_id,
           account_login, account_type, status, user_token_reference, refresh_token_reference,
           user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
         ) VALUES (?, ?, ?, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(installation, workspace, installation.length + 7000, NOW, NOW, NOW, NOW, NOW),
    );
  }
  for (const [connection, workspace, installation, repositoryId, status] of [
    ["rpc_widgets", WORKSPACE, "ins_secrets", 9001, "verified"],
    ["rpc_gadgets", WORKSPACE, "ins_secrets", 9002, "verified"],
    ["rpc_gone", WORKSPACE, "ins_secrets", 9003, "disconnected"],
    ["rpc_theirs", OTHER_WORKSPACE, "ins_secrets_other", 9001, "verified"],
  ] as const) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO repository_connection (
           repository_connection_id, workspace_id, installation_row_id, github_repository_id,
           full_name, default_branch, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'acme/widgets', 'main', ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(connection, workspace, installation, repositoryId, status, NOW, NOW),
    );
  }
  await env.DB.batch(statements);
}

async function storedRows(): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    "SELECT secret_id, workspace_id, repository_connection_id, name, value_reference, status FROM development_secret ORDER BY secret_id",
  ).all();
  return rows.results;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM repository_secret_disclosure").run();
  await env.DB.prepare("DELETE FROM development_secret").run();
  await seed();
});

describe("saveDevelopmentSecret", () => {
  it("seals the value, and neither the row nor the summary holds it", async () => {
    const keyring = await credentialKeyring();

    const result = await saveDevelopmentSecret(
      env.DB,
      depsWith(keyring),
      SCOPE,
      "DATABASE_URL",
      FAKE_VALUE,
    );

    expect(result).toEqual({
      kind: "saved",
      secret: { secretId: "dsc_00_1", name: "DATABASE_URL", status: "active", updatedAt: NOW },
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_VALUE);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.value_reference)).toMatch(/^oncue1\./);
    expect(JSON.stringify(rows)).not.toContain(FAKE_VALUE);
  });

  it("replaces a value under a new row, so one name never has two", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    await saveDevelopmentSecret(
      env.DB,
      depsWith(keyring, LATER),
      SCOPE,
      "DATABASE_URL",
      FAKE_REPLACEMENT,
    );

    const rows = await storedRows();
    expect(rows.map((row) => row.secret_id)).toEqual(["dsc_01_1"]);
    const opened = await openDevelopmentSecrets(env.DB, keyring, SCOPE, ["DATABASE_URL"]);
    expect(opened.opened).toEqual([
      { secretId: "dsc_01_1", name: "DATABASE_URL", value: FAKE_REPLACEMENT },
    ]);
    // The old row was superseded, not destroyed: a sandbox sent it still holds it.
    const superseded = await openSecretsById(env.DB, keyring, SCOPE.workspaceId, ["dsc_00_1"]);
    expect(superseded).toEqual([{ secretId: "dsc_00_1", name: "DATABASE_URL", value: FAKE_VALUE }]);
  });

  it.each([
    ["database_url", "name_malformed"],
    ["NODE_OPTIONS", "name_reserved"],
    ["GITHUB_TOKEN", "name_platform_credential"],
  ])("refuses the name %s and writes nothing", async (name, reason) => {
    const keyring = await credentialKeyring();
    expect(await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, name, FAKE_VALUE)).toEqual(
      { kind: "refused", reason },
    );
    expect(await storedRows()).toEqual([]);
  });

  it.each([
    ["short", "value_too_short"],
    ["fake-value\nSECOND=1", "value_control_character"],
  ])("refuses the value %j and writes nothing", async (value, reason) => {
    const keyring = await credentialKeyring();
    expect(
      await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", value),
    ).toEqual({ kind: "refused", reason });
    expect(await storedRows()).toEqual([]);
  });

  it.each([
    [
      "a repository connection of another workspace",
      { ...SCOPE, repositoryConnectionId: "rpc_theirs" },
    ],
    ["a disconnected repository", { ...SCOPE, repositoryConnectionId: "rpc_gone" }],
    ["a repository that does not exist", { ...SCOPE, repositoryConnectionId: "rpc_none" }],
  ])("refuses %s", async (_label, scope) => {
    const keyring = await credentialKeyring();
    expect(
      await saveDevelopmentSecret(env.DB, depsWith(keyring), scope, "DATABASE_URL", FAKE_VALUE),
    ).toEqual({ kind: "refused", reason: "unknown_repository" });
    expect(await storedRows()).toEqual([]);
  });
});

describe("reading without opening", () => {
  it("lists one repository's names in order, and nothing of a sibling's or another workspace's", async () => {
    const keyring = await credentialKeyring();
    const deps = depsWith(keyring);
    await saveDevelopmentSecret(env.DB, deps, SCOPE, "STRIPE_TEST_KEY", FAKE_VALUE);
    await saveDevelopmentSecret(env.DB, deps, SCOPE, "DATABASE_URL", FAKE_VALUE);
    await saveDevelopmentSecret(env.DB, deps, SIBLING, "SIBLING_ONLY", FAKE_VALUE);
    await saveDevelopmentSecret(env.DB, deps, OTHERS, "THEIRS_ONLY", FAKE_VALUE);

    const listed = await listDevelopmentSecrets(env.DB, SCOPE);

    expect(listed.map((secret) => secret.name)).toEqual(["DATABASE_URL", "STRIPE_TEST_KEY"]);
    expect(JSON.stringify(listed)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(listed)).not.toContain("oncue1.");
    // Another workspace asking with this workspace's connection id sees nothing.
    expect(
      await listDevelopmentSecrets(env.DB, {
        workspaceId: OTHER_WORKSPACE,
        repositoryConnectionId: SCOPE.repositoryConnectionId,
      }),
    ).toEqual([]);
  });

  it("says whether one name is saved, and only for an active value in this scope", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    expect(await developmentSecretIsSaved(env.DB, SCOPE, "DATABASE_URL")).toBe(true);
    expect(await developmentSecretIsSaved(env.DB, SCOPE, "OTHER_NAME")).toBe(false);
    expect(await developmentSecretIsSaved(env.DB, SIBLING, "DATABASE_URL")).toBe(false);
    expect(
      await developmentSecretIsSaved(
        env.DB,
        { ...SCOPE, workspaceId: OTHER_WORKSPACE },
        "DATABASE_URL",
      ),
    ).toBe(false);

    await env.DB.prepare("UPDATE development_secret SET status = 'unreadable'").run();
    expect(await developmentSecretIsSaved(env.DB, SCOPE, "DATABASE_URL")).toBe(false);
  });

  it("finds a session's repository connection by GitHub's id, within the workspace only", async () => {
    expect(await repositoryConnectionIdFor(env.DB, WORKSPACE, 9001)).toBe("rpc_widgets");
    expect(await repositoryConnectionIdFor(env.DB, OTHER_WORKSPACE, 9001)).toBe("rpc_theirs");
    expect(await repositoryConnectionIdFor(env.DB, OTHER_WORKSPACE, 9002)).toBeNull();
  });
});

describe("deleteDevelopmentSecret", () => {
  it("removes the row and its sealed bytes, in this scope only", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    expect(
      await deleteDevelopmentSecret(
        env.DB,
        { ...SCOPE, workspaceId: OTHER_WORKSPACE },
        "DATABASE_URL",
      ),
    ).toBe(false);
    expect(await storedRows()).toHaveLength(1);

    expect(await deleteDevelopmentSecret(env.DB, SCOPE, "DATABASE_URL")).toBe(true);
    expect(await storedRows()).toEqual([]);
    expect(await deleteDevelopmentSecret(env.DB, SCOPE, "DATABASE_URL")).toBe(false);
  });
});

describe("openDevelopmentSecrets", () => {
  it("opens what was asked for and names what it could not supply", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    expect(
      await openDevelopmentSecrets(env.DB, keyring, SCOPE, ["DATABASE_URL", "NEVER_SAVED"]),
    ).toEqual({
      opened: [{ secretId: "dsc_00_1", name: "DATABASE_URL", value: FAKE_VALUE }],
      unavailable: ["NEVER_SAVED"],
    });
  });

  it("opens nothing for another workspace or a sibling repository", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    for (const scope of [SIBLING, { ...SCOPE, workspaceId: OTHER_WORKSPACE }]) {
      expect(await openDevelopmentSecrets(env.DB, keyring, scope, ["DATABASE_URL"])).toEqual({
        opened: [],
        unavailable: ["DATABASE_URL"],
      });
    }
  });

  it("does not open an envelope moved to another name, and marks the row unreadable", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);
    // Sealed bytes moved to another name: the additional data no longer matches.
    await env.DB.prepare("UPDATE development_secret SET name = 'STRIPE_TEST_KEY'").run();

    const result = await openDevelopmentSecrets(env.DB, keyring, SCOPE, ["STRIPE_TEST_KEY"]);

    expect(result).toEqual({ opened: [], unavailable: ["STRIPE_TEST_KEY"] });
    expect(JSON.stringify(result)).not.toContain(FAKE_VALUE);
    expect((await storedRows())[0]?.status).toBe("unreadable");
  });

  it("does not open an envelope moved to another row or sealed under another key", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);

    expect(
      await openDevelopmentSecrets(env.DB, await credentialKeyring(), SCOPE, ["DATABASE_URL"]),
    ).toEqual({ opened: [], unavailable: ["DATABASE_URL"] });

    await env.DB.prepare(
      "UPDATE development_secret SET secret_id = 'dsc_moved', status = 'active'",
    ).run();
    expect(await openDevelopmentSecrets(env.DB, keyring, SCOPE, ["DATABASE_URL"])).toEqual({
      opened: [],
      unavailable: ["DATABASE_URL"],
    });
  });
});

describe("the names a launch reads", () => {
  it("lists the active saved names of one repository in one workspace", async () => {
    const keyring = await credentialKeyring();
    const deps = depsWith(keyring);
    await saveDevelopmentSecret(env.DB, deps, SCOPE, "STRIPE_TEST_KEY", FAKE_VALUE);
    await saveDevelopmentSecret(env.DB, deps, SCOPE, "DATABASE_URL", FAKE_VALUE);
    await saveDevelopmentSecret(env.DB, deps, SIBLING, "SIBLING_ONLY", FAKE_VALUE);
    await env.DB.prepare(
      "UPDATE development_secret SET status = 'unreadable' WHERE name = 'STRIPE_TEST_KEY'",
    ).run();

    expect(await savedSecretNames(env.DB, SCOPE)).toEqual(["DATABASE_URL"]);
    expect(await savedSecretNames(env.DB, { ...SCOPE, workspaceId: OTHER_WORKSPACE })).toEqual([]);
  });

  it("lets no other workspace plant the first row for a repository", async () => {
    const intruder = { ...SCOPE, workspaceId: OTHER_WORKSPACE };
    await writeDisclosedNames(env.DB, intruder, ["EVIL_NAME"], NOW);
    expect(await readLastDisclosedNames(env.DB, intruder)).toBeNull();

    await writeDisclosedNames(env.DB, SCOPE, ["DATABASE_URL"], LATER);
    expect(await readLastDisclosedNames(env.DB, SCOPE)).toEqual(["DATABASE_URL"]);
  });

  it("remembers the last disclosed names per repository, and only for its own workspace", async () => {
    expect(await readLastDisclosedNames(env.DB, SCOPE)).toBeNull();

    await writeDisclosedNames(env.DB, SCOPE, ["DATABASE_URL"], NOW);
    await writeDisclosedNames(env.DB, SCOPE, ["DATABASE_URL", "REDIS_URL"], LATER);

    expect(await readLastDisclosedNames(env.DB, SCOPE)).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(await readLastDisclosedNames(env.DB, SIBLING)).toBeNull();
    // Another workspace naming this repository's connection neither reads nor overwrites it.
    const intruder = { ...SCOPE, workspaceId: OTHER_WORKSPACE };
    expect(await readLastDisclosedNames(env.DB, intruder)).toBeNull();
    await writeDisclosedNames(env.DB, intruder, ["EVIL_NAME"], LATER);
    expect(await readLastDisclosedNames(env.DB, SCOPE)).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });
});

describe("openSecretsById", () => {
  it("opens nothing for no ids, skips a row sealed under another key, and finds a superseded row", async () => {
    const keyring = await credentialKeyring();
    const other = await credentialKeyring();
    expect(await openSecretsById(env.DB, keyring, SCOPE.workspaceId, [])).toEqual([]);
    await saveDevelopmentSecret(env.DB, depsWith(other), SCOPE, "DATABASE_URL", FAKE_VALUE);
    await saveDevelopmentSecret(
      env.DB,
      depsWith(keyring, LATER),
      SCOPE,
      "DATABASE_URL",
      FAKE_REPLACEMENT,
    );
    // dsc_00_1 is superseded and sealed under `other`; dsc_01_1 is live under `keyring`.
    expect(
      await openSecretsById(env.DB, keyring, SCOPE.workspaceId, ["dsc_00_1", "dsc_01_1"]),
    ).toEqual([{ secretId: "dsc_01_1", name: "DATABASE_URL", value: FAKE_REPLACEMENT }]);
    expect(await openSecretsById(env.DB, other, SCOPE.workspaceId, ["dsc_00_1"])).toEqual([
      { secretId: "dsc_00_1", name: "DATABASE_URL", value: FAKE_VALUE },
    ]);
  });

  it("is destroyed with the name: a deletion removes the superseded rows too, and an unknown name deletes nothing", async () => {
    const keyring = await credentialKeyring();
    await saveDevelopmentSecret(env.DB, depsWith(keyring), SCOPE, "DATABASE_URL", FAKE_VALUE);
    await saveDevelopmentSecret(
      env.DB,
      depsWith(keyring, LATER),
      SCOPE,
      "DATABASE_URL",
      FAKE_REPLACEMENT,
    );
    expect(await deleteDevelopmentSecret(env.DB, SCOPE, "DATABASE_URL")).toBe(true);
    expect(
      await openSecretsById(env.DB, keyring, SCOPE.workspaceId, ["dsc_00_1", "dsc_01_1"]),
    ).toEqual([]);
    expect(await deleteDevelopmentSecret(env.DB, SCOPE, "DATABASE_URL")).toBe(false);
  });
});
