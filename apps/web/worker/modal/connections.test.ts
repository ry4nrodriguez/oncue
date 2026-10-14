import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveKeyring, type Keyring, sealCredential } from "../broker/envelope";
import type { ModalCredential, ModalCredentialTester, ModalTestFailureReason } from "./client";
import {
  disconnectModalConnection,
  hasActiveModalConnection,
  type ModalConnectionDeps,
  openModalCredential,
  readModalConnection,
  saveModalConnection,
} from "./connections";
import { modalTokenContext } from "./envelope-context";

const NOW = "2026-09-08T00:00:00.000Z";
const WORKSPACE = "wsp_modal";
const OTHER_WORKSPACE = "wsp_modal_other";

/** Short and obviously fake, so no secret scanner has to decide about it. */
const CREDENTIAL: ModalCredential = {
  tokenId: "ak-fake0001",
  tokenSecret: "as-fake0001",
  environmentName: null,
};

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

/** Answers the way the controller would, and records what it was handed. */
function tester(
  answer:
    | { kind: "ok"; workspaceName: string }
    | { kind: "failed"; reason: ModalTestFailureReason },
): { test: ModalCredentialTester; seen: ModalCredential[] } {
  const seen: ModalCredential[] = [];
  const test: ModalCredentialTester = async (credential) => {
    seen.push(credential);
    if (answer.kind === "failed") {
      return { kind: "failed", reason: answer.reason };
    }
    return { kind: "ok", workspaceName: answer.workspaceName, environments: ["main"] };
  };
  return { test, seen };
}

/** Each call has its own counter, so `idPrefix` keeps fixture ids from colliding. */
function depsWith(
  keyring: Keyring<"credential">,
  test: ModalCredentialTester,
  now: string = NOW,
  idPrefix = "mdl_new",
): ModalConnectionDeps {
  let counter = 0;
  return {
    db: env.DB,
    keyring,
    test,
    now: () => now,
    newId: () => {
      counter += 1;
      return `${idPrefix}_${counter}`;
    },
  };
}

async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_modal', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_modal_other', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_modal', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_modal_other', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_WORKSPACE, NOW, NOW),
  ]);
}

/** A row written directly, so a read can be tested without a save first. */
async function insertRow(options: {
  connectionId?: string;
  workspaceId?: string;
  status?: string;
  environmentName?: string | null;
  tokenIdReference?: string;
  tokenSecretReference?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO modal_connection (
       connection_id, workspace_id, token_id_reference, token_secret_reference,
       modal_workspace_name, environment_name, status, last_validated_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'acme-workspace', ?, ?, ?, ?, ?)`,
  )
    .bind(
      options.connectionId ?? "mdl_seeded",
      options.workspaceId ?? WORKSPACE,
      options.tokenIdReference ?? "oncue1.1.n.i",
      options.tokenSecretReference ?? "oncue1.1.n.s",
      options.environmentName ?? null,
      options.status ?? "active",
      NOW,
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await seedWorkspaces();
  await env.DB.prepare("DELETE FROM modal_connection").run();
});

describe("readModalConnection", () => {
  it("is null for a workspace that has not connected Modal", async () => {
    expect(await readModalConnection(env.DB, WORKSPACE)).toBeNull();
  });

  it("returns the summary, and nothing that could be a credential", async () => {
    await insertRow({ connectionId: "mdl_1", environmentName: "staging" });

    const summary = await readModalConnection(env.DB, WORKSPACE);

    expect(summary).toEqual({
      connectionId: "mdl_1",
      workspaceName: "acme-workspace",
      environmentName: "staging",
      status: "active",
      lastValidatedAt: NOW,
      createdAt: NOW,
    });
    // Envelopes start with `oncue1.`; checking the serialized summary also
    // catches fields added later.
    expect(JSON.stringify(summary)).not.toContain("oncue1.");
  });

  it("never reports another workspace's connection", async () => {
    await insertRow({ workspaceId: OTHER_WORKSPACE });

    expect(await readModalConnection(env.DB, WORKSPACE)).toBeNull();
  });
});

describe("hasActiveModalConnection", () => {
  it("is false with no row at all", async () => {
    expect(await hasActiveModalConnection(env.DB, WORKSPACE)).toBe(false);
  });

  it("is true for an active row", async () => {
    await insertRow({});

    expect(await hasActiveModalConnection(env.DB, WORKSPACE)).toBe(true);
  });

  // A credential that stopped working must not satisfy record 13's Modal step.
  it("is false for a row whose credential has stopped working", async () => {
    await insertRow({ status: "invalid" });

    expect(await hasActiveModalConnection(env.DB, WORKSPACE)).toBe(false);
  });
});

describe("saveModalConnection", () => {
  it("tests the credential before it writes anything", async () => {
    const { test, seen } = tester({ kind: "failed", reason: "invalid_credentials" });

    const outcome = await saveModalConnection(
      depsWith(await credentialKeyring(), test),
      WORKSPACE,
      CREDENTIAL,
    );

    expect(outcome).toEqual({ kind: "rejected", reason: "invalid_credentials" });
    expect(seen).toEqual([CREDENTIAL]);
    // A credential that does not work is never stored.
    expect(await readModalConnection(env.DB, WORKSPACE)).toBeNull();
  });

  it.each([
    "invalid_credentials",
    "no_environment_access",
    "unreachable",
    "controller_unavailable",
  ] as const)("passes the %s verdict back unchanged", async (reason) => {
    const { test } = tester({ kind: "failed", reason });

    await expect(
      saveModalConnection(depsWith(await credentialKeyring(), test), WORKSPACE, CREDENTIAL),
    ).resolves.toEqual({ kind: "rejected", reason });
  });

  it("stores the workspace name the test read back, not anything the caller sent", async () => {
    const { test } = tester({ kind: "ok", workspaceName: "acme-workspace" });

    const outcome = await saveModalConnection(
      depsWith(await credentialKeyring(), test),
      WORKSPACE,
      { ...CREDENTIAL, environmentName: "staging" },
    );

    expect(outcome).toEqual({
      kind: "saved",
      summary: {
        connectionId: "mdl_new_1",
        workspaceName: "acme-workspace",
        environmentName: "staging",
        status: "active",
        lastValidatedAt: NOW,
        createdAt: NOW,
      },
    });
  });

  it("seals both halves under their own contexts, and stores neither in the clear", async () => {
    const keyring = await credentialKeyring();
    const { test } = tester({ kind: "ok", workspaceName: "acme-workspace" });

    await saveModalConnection(depsWith(keyring, test), WORKSPACE, CREDENTIAL);

    const row = await env.DB.prepare(
      "SELECT token_id_reference, token_secret_reference FROM modal_connection WHERE workspace_id = ?",
    )
      .bind(WORKSPACE)
      .first<{ token_id_reference: string; token_secret_reference: string }>();
    if (row === null) {
      throw new Error("expected a stored row");
    }
    expect(row.token_id_reference).not.toContain(CREDENTIAL.tokenId);
    expect(row.token_secret_reference).not.toContain(CREDENTIAL.tokenSecret);
    // Each half is sealed under its own context, so they are not interchangeable.
    expect(row.token_id_reference).not.toBe(row.token_secret_reference);

    const opened = await openModalCredential(env.DB, keyring, WORKSPACE);
    expect(opened).toEqual({ kind: "opened", credential: CREDENTIAL });
  });

  // A reconnect keeps the connection id the envelope binds, so no old
  // ciphertext stays openable beside the new one.
  it("replaces an existing connection in place, keeping its id", async () => {
    const keyring = await credentialKeyring();
    const first = tester({ kind: "ok", workspaceName: "old-workspace" });
    await saveModalConnection(depsWith(keyring, first.test), WORKSPACE, CREDENTIAL);

    const second = tester({ kind: "ok", workspaceName: "new-workspace" });
    const outcome = await saveModalConnection(
      depsWith(keyring, second.test, "2026-09-09T00:00:00.000Z"),
      WORKSPACE,
      { tokenId: "ak-fake0002", tokenSecret: "as-fake0002", environmentName: "staging" },
    );

    expect(outcome).toEqual({
      kind: "saved",
      summary: {
        connectionId: "mdl_new_1",
        workspaceName: "new-workspace",
        environmentName: "staging",
        status: "active",
        lastValidatedAt: "2026-09-09T00:00:00.000Z",
        createdAt: NOW,
      },
    });
    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({
      kind: "opened",
      credential: {
        tokenId: "ak-fake0002",
        tokenSecret: "as-fake0002",
        environmentName: "staging",
      },
    });
  });

  it("brings a connection whose credential had stopped working back to active", async () => {
    const keyring = await credentialKeyring();
    await insertRow({ connectionId: "mdl_stale", status: "invalid" });
    const { test } = tester({ kind: "ok", workspaceName: "acme-workspace" });

    const outcome = await saveModalConnection(depsWith(keyring, test), WORKSPACE, CREDENTIAL);

    expect(outcome).toMatchObject({
      kind: "saved",
      summary: { connectionId: "mdl_stale", status: "active" },
    });
    expect(await hasActiveModalConnection(env.DB, WORKSPACE)).toBe(true);
  });

  it("keeps two workspaces' connections apart", async () => {
    const keyring = await credentialKeyring();
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "theirs" }).test, NOW, "mdl_theirs"),
      OTHER_WORKSPACE,
      { tokenId: "ak-fake0009", tokenSecret: "as-fake0009", environmentName: null },
    );
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "mine" }).test),
      WORKSPACE,
      CREDENTIAL,
    );

    expect(await readModalConnection(env.DB, WORKSPACE)).toMatchObject({ workspaceName: "mine" });
    expect(await readModalConnection(env.DB, OTHER_WORKSPACE)).toMatchObject({
      workspaceName: "theirs",
    });
  });
});

describe("disconnectModalConnection", () => {
  it("removes the row and the sealed bytes with it", async () => {
    const keyring = await credentialKeyring();
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "acme" }).test),
      WORKSPACE,
      CREDENTIAL,
    );

    expect(await disconnectModalConnection(env.DB, WORKSPACE)).toEqual({ kind: "disconnected" });
    expect(await readModalConnection(env.DB, WORKSPACE)).toBeNull();
    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({ kind: "absent" });
  });

  it("is not_found when there was nothing to disconnect", async () => {
    expect(await disconnectModalConnection(env.DB, WORKSPACE)).toEqual({ kind: "not_found" });
  });

  it("never removes another workspace's connection", async () => {
    await insertRow({ workspaceId: OTHER_WORKSPACE });

    expect(await disconnectModalConnection(env.DB, WORKSPACE)).toEqual({ kind: "not_found" });
    expect(await readModalConnection(env.DB, OTHER_WORKSPACE)).not.toBeNull();
  });

  it("leaves the workspace free to connect again", async () => {
    const keyring = await credentialKeyring();
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "first" }).test),
      WORKSPACE,
      CREDENTIAL,
    );
    await disconnectModalConnection(env.DB, WORKSPACE);

    await expect(
      saveModalConnection(
        depsWith(keyring, tester({ kind: "ok", workspaceName: "second" }).test),
        WORKSPACE,
        CREDENTIAL,
      ),
    ).resolves.toMatchObject({ kind: "saved", summary: { workspaceName: "second" } });
  });
});

describe("openModalCredential", () => {
  it("is absent for a workspace with no connection", async () => {
    expect(await openModalCredential(env.DB, await credentialKeyring(), WORKSPACE)).toEqual({
      kind: "absent",
    });
  });

  // An inactive connection counts as none, the same answer as never having
  // connected.
  it("is absent for a connection that is not active", async () => {
    await insertRow({ status: "invalid" });

    expect(await openModalCredential(env.DB, await credentialKeyring(), WORKSPACE)).toEqual({
      kind: "absent",
    });
  });

  it("never opens another workspace's connection", async () => {
    const keyring = await credentialKeyring();
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "theirs" }).test, NOW, "mdl_theirs"),
      OTHER_WORKSPACE,
      CREDENTIAL,
    );

    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({ kind: "absent" });
  });

  it("carries the named environment through", async () => {
    const keyring = await credentialKeyring();
    await saveModalConnection(
      depsWith(keyring, tester({ kind: "ok", workspaceName: "acme" }).test),
      WORKSPACE,
      { ...CREDENTIAL, environmentName: "staging" },
    );

    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({
      kind: "opened",
      credential: { ...CREDENTIAL, environmentName: "staging" },
    });
  });

  it("is unusable when the token id will not open", async () => {
    const keyring = await credentialKeyring();
    await insertRow({ connectionId: "mdl_bad_id", tokenIdReference: "not-an-envelope" });

    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({ kind: "unusable" });
  });

  // Only a targeted corruption reaches the second half's check, for example a
  // ciphertext moved between the two columns.
  it("is unusable when the token secret will not open", async () => {
    const keyring = await credentialKeyring();
    const goodId = await sealCredential(
      keyring,
      modalTokenContext("mdl_bad_secret", WORKSPACE, "token_id"),
      CREDENTIAL.tokenId,
    );
    await insertRow({
      connectionId: "mdl_bad_secret",
      tokenIdReference: goodId,
      // The token id's ciphertext presented as the secret opens under no context
      // this row asks for.
      tokenSecretReference: goodId,
    });

    expect(await openModalCredential(env.DB, keyring, WORKSPACE)).toEqual({ kind: "unusable" });
  });
});
