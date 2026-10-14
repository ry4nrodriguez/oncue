import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_ADAPTERS } from "../broker/providers/adapter";
import { readSetup } from "./read";

// The model-connection cases connect GitHub and Modal first; otherwise they
// would stop at an earlier setup step and prove nothing about model connections.

const NOW = "2026-09-05T00:00:00.000Z";
const WORKSPACE = "wsp_setup";
const OTHER = "wsp_setup_other";
const INSTALLATION = "ghi_setup";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_setup', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_setup', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_setup_other', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_setup_other', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER, NOW, NOW),
  ]);
}

/** The token columns hold a sealed envelope in production; these tests never open one. */
async function insertInstallation(
  options: { rowId?: string; workspaceId?: string; status?: string } = {},
): Promise<string> {
  const rowId = options.rowId ?? INSTALLATION;
  await env.DB.prepare(
    `INSERT INTO github_installation (
       installation_row_id, workspace_id, github_installation_id, github_user_id,
       account_login, account_type, status, user_token_reference, refresh_token_reference,
       user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, 4001, 42, 'acme', 'Organization', ?, 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
  )
    .bind(
      rowId,
      options.workspaceId ?? WORKSPACE,
      options.status ?? "active",
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    )
    .run();
  return rowId;
}

async function insertRepository(
  connectionId: string,
  options: { workspaceId?: string; status?: string; fullName?: string; rowId?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repository_connection (
       repository_connection_id, workspace_id, installation_row_id, github_repository_id,
       full_name, default_branch, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?)`,
  )
    .bind(
      connectionId,
      options.workspaceId ?? WORKSPACE,
      options.rowId ?? INSTALLATION,
      // Unique per connection id: (workspace_id, github_repository_id) is unique.
      connectionId.length * 1000 + connectionId.charCodeAt(connectionId.length - 1),
      options.fullName ?? "acme/widgets",
      options.status ?? "verified",
      NOW,
      NOW,
    )
    .run();
}

/** The two reference columns hold sealed envelopes in production; these tests never open one. */
async function insertModalConnection(
  options: { workspaceId?: string; status?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO modal_connection (
       connection_id, workspace_id, token_id_reference, token_secret_reference,
       modal_workspace_name, environment_name, status, last_validated_at,
       created_at, updated_at
     ) VALUES (?, ?, 'oncue1.1.n.i', 'oncue1.1.n.s', 'acme-workspace', NULL, ?, ?, ?, ?)`,
  )
    .bind(
      `mdl_${options.workspaceId ?? WORKSPACE}`,
      options.workspaceId ?? WORKSPACE,
      options.status ?? "active",
      NOW,
      NOW,
      NOW,
    )
    .run();
}

async function insertConnection(
  connectionId: string,
  options: {
    workspaceId?: string;
    status?: string;
    hint?: string | null;
    provider?: string;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'api_key', 'oncue1.1.n.c', ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      connectionId,
      options.workspaceId ?? WORKSPACE,
      options.provider ?? "anthropic",
      options.status ?? "active",
      options.hint === undefined ? "...4f21" : options.hint,
      NOW,
      NOW,
      NOW,
    )
    .run();
}

async function insertSession(
  sessionId: string,
  connectionId: string,
  options: { workspaceId?: string; state?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, model_connection_id, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      options.workspaceId ?? WORKSPACE,
      options.state ?? "active",
      connectionId,
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await seed();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM session_index"),
    env.DB.prepare("DELETE FROM model_connection"),
    env.DB.prepare("DELETE FROM modal_connection"),
    env.DB.prepare("DELETE FROM repository_connection"),
    env.DB.prepare("DELETE FROM github_installation"),
  ]);
});

describe("readSetup, the GitHub half", () => {
  it("asks a workspace with no installation to connect GitHub", async () => {
    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_github",
      installUrl: null,
    });
  });

  // The user cannot work through these from here; they must authorize again.
  it.each(["suspended", "deleted", "unauthorized"])(
    "asks a workspace whose installation is %s to connect GitHub",
    async (status) => {
      await insertInstallation({ status });
      await insertRepository("rc_1");

      expect(await readSetup(env.DB, WORKSPACE)).toEqual({
        kind: "connect_github",
        installUrl: null,
      });
    },
  );

  it("is stuck on no_repositories when the installation reaches nothing", async () => {
    await insertInstallation();

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "github_stuck",
      reason: "no_repositories",
    });
  });

  // `resolveRepository` would refuse a disconnected repository on submit.
  it("is stuck on no_repositories when every repository is disconnected", async () => {
    await insertInstallation();
    await insertRepository("rc_gone", { status: "disconnected" });

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "github_stuck",
      reason: "no_repositories",
    });
  });

  it("never reports another workspace's installation", async () => {
    await insertInstallation({ rowId: "ghi_theirs", workspaceId: OTHER });
    await insertRepository("rc_theirs", { workspaceId: OTHER, rowId: "ghi_theirs" });

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_github",
      installUrl: null,
    });
  });
});

describe("readSetup, the Modal half", () => {
  beforeEach(async () => {
    await insertInstallation();
    await insertRepository("rc_1", { fullName: "acme/widgets" });
  });

  it("asks a workspace with no Modal connection to connect one", async () => {
    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_modal",
      modelConnections: [],
    });
  });

  // A credential that stopped working cannot create a sandbox, so it does not
  // satisfy the gate.
  it("asks a workspace whose Modal connection is invalid to connect one", async () => {
    await insertModalConnection({ status: "invalid" });

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_modal",
      modelConnections: [],
    });
  });

  it("never reports another workspace's Modal connection", async () => {
    await insertModalConnection({ workspaceId: OTHER });

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_modal",
      modelConnections: [],
    });
  });

  // The browser decides which card to show first, so it needs the list.
  it("carries the workspace's model connections into connect_modal", async () => {
    await insertConnection("mc_1");

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "connect_modal",
      modelConnections: [
        {
          modelConnectionId: "mc_1",
          label: "anthropic ...4f21",
          provider: "anthropic",
          modelId: "claude-opus-5-5",
          models: PROVIDER_ADAPTERS.anthropic.models,
        },
      ],
    });
  });

  it("never carries a token envelope into the setup payload", async () => {
    await insertModalConnection();

    expect(JSON.stringify(await readSetup(env.DB, WORKSPACE)).includes("oncue1.")).toBe(false);
  });
});

describe("readSetup, the model-connection half", () => {
  beforeEach(async () => {
    await insertInstallation();
    await insertRepository("rc_1", { fullName: "acme/widgets" });
    await insertModalConnection();
  });

  it("is ready with no model connections when the workspace has none", async () => {
    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "ready",
      repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/widgets" }],
      modelConnections: [],
    });
  });

  it("reports the workspace's active connections", async () => {
    await insertConnection("mc_1");

    expect(await readSetup(env.DB, WORKSPACE)).toEqual({
      kind: "ready",
      repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/widgets" }],
      modelConnections: [
        {
          modelConnectionId: "mc_1",
          label: "anthropic ...4f21",
          provider: "anthropic",
          modelId: "claude-opus-5-5",
          models: PROVIDER_ADAPTERS.anthropic.models,
        },
      ],
    });
  });

  // `resolveModel` would refuse a revoked or invalid connection on submit.
  it("leaves out connections that are not active", async () => {
    await insertConnection("mc_revoked", { status: "revoked" });
    await insertConnection("mc_invalid", { status: "invalid" });

    const setup = await readSetup(env.DB, WORKSPACE);
    if (setup.kind !== "ready") {
      throw new Error(`expected ready, got ${setup.kind}`);
    }
    expect(setup.modelConnections).toEqual([]);
  });

  it("never reports another workspace's connection", async () => {
    await insertConnection("mc_theirs", { workspaceId: OTHER });
    await insertConnection("mc_theirs_bad", { workspaceId: OTHER, status: "invalid" });

    const setup = await readSetup(env.DB, WORKSPACE);
    if (setup.kind !== "ready") {
      throw new Error(`expected ready, got ${setup.kind}`);
    }
    expect(setup.modelConnections).toEqual([]);
    expect(setup.inactiveModelConnections).toBeUndefined();
  });

  // Home says what happened to the key; the create route still takes only an active one.
  it("names a key that stopped working, with the active sessions still on it", async () => {
    await insertConnection("mc_good");
    await insertConnection("mc_bad", { provider: "openai", status: "invalid" });
    await insertSession("sess_a", "mc_bad");
    await insertSession("sess_b", "mc_bad");
    await insertSession("sess_archived", "mc_bad", { state: "archived" });
    await insertSession("sess_good", "mc_good");

    const setup = await readSetup(env.DB, WORKSPACE);
    if (setup.kind !== "ready") {
      throw new Error(`expected ready, got ${setup.kind}`);
    }
    expect(setup.modelConnections.map((connection) => connection.modelConnectionId)).toEqual([
      "mc_good",
    ]);
    expect(setup.inactiveModelConnections).toEqual([
      { modelConnectionId: "mc_bad", provider: "openai", status: "invalid", activeSessions: 2 },
    ]);
  });

  it.each(["invalid", "expired", "attention_required"])(
    "reports a key whose status is %s, with no session on it",
    async (status) => {
      await insertConnection("mc_bad", { status });

      const setup = await readSetup(env.DB, WORKSPACE);
      if (setup.kind !== "ready") {
        throw new Error(`expected ready, got ${setup.kind}`);
      }
      expect(setup.inactiveModelConnections).toEqual([
        { modelConnectionId: "mc_bad", provider: "anthropic", status, activeSessions: 0 },
      ]);
    },
  );

  // A revoked key cannot be replaced in place; its provider takes a new one.
  it("leaves a revoked key out, and the field with it", async () => {
    await insertConnection("mc_revoked", { status: "revoked" });
    await insertSession("sess_a", "mc_revoked");

    const setup = await readSetup(env.DB, WORKSPACE);
    if (setup.kind !== "ready") {
      throw new Error(`expected ready, got ${setup.kind}`);
    }
    expect("inactiveModelConnections" in setup).toBe(false);
  });

  it("never carries a credential or a token envelope into the setup payload", async () => {
    await insertConnection("mc_1");

    expect(JSON.stringify(await readSetup(env.DB, WORKSPACE)).includes("oncue1.")).toBe(false);
  });
});
