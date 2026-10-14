import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = "2026-09-02T00:00:00.000Z";

describe("D1 migrations", () => {
  it("seeds exactly one platform_control row with admission open", async () => {
    const rows = await env.DB.prepare("SELECT * FROM platform_control").all();

    expect(rows.results).toEqual([
      {
        id: 1,
        run_admission: "open",
        platform_concurrent_sandbox_cap: 50,
        workspace_concurrent_sandbox_cap: 3,
        allowlist_version: 1,
        emergency_control_version: 1,
        updated_at: "2026-09-02T00:00:00.000Z",
      },
    ]);
  });

  it("creates the other four core tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task', 'session_index', 'projection_cursor', 'audit_entry')",
    ).all<{ name: string }>();

    const names = tables.results.map((row) => row.name).sort();
    expect(names).toEqual(["audit_entry", "projection_cursor", "session_index", "task"]);
  });

  it("allows 'creating' as a session_index state", async () => {
    await env.DB.prepare(
      `INSERT INTO task (id, workspace_id, title, created_by_user_id, created_at, updated_at)
       VALUES ('task_1', 'ws_1', 'Fix the bug', 'user_1', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
    ).run();

    await env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
       VALUES ('sess_1', 'ws_1', 'task_1', 'creating', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
    ).run();

    const row = await env.DB.prepare(
      "SELECT state FROM session_index WHERE session_id = 'sess_1'",
    ).first<{
      state: string;
    }>();

    expect(row).toEqual({ state: "creating" });

    await env.DB.prepare("DELETE FROM session_index WHERE session_id = 'sess_1'").run();
    await env.DB.prepare("DELETE FROM task WHERE id = 'task_1'").run();
  });
});

// Guardrails on a credential table: record 06's CHECK constraints, and the
// workspace foreign key that stops a credential row outliving its workspace.
describe("model_connection", () => {
  const workspaceId = "wsp_mc_migration";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, status, created_at, updated_at)
         VALUES ('usr_mc_migration', 'active', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'usr_mc_migration', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(workspaceId, NOW, NOW),
    ]);
    await env.DB.prepare("DELETE FROM model_connection WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
  });

  function insert(overrides: Partial<Record<string, string>> = {}) {
    const row = {
      connection_id: "mc_1",
      workspace_id: workspaceId,
      provider: "anthropic",
      auth_type: "api_key",
      credential_reference: "v1.bm9uY2U.Y2lwaGVy",
      status: "active",
      ...overrides,
    };
    return env.DB.prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference,
         status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(
        row.connection_id,
        row.workspace_id,
        row.provider,
        row.auth_type,
        row.credential_reference,
        row.status,
        NOW,
        NOW,
      )
      .run();
  }

  it("accepts each of record 06's five statuses", async () => {
    const statuses = ["active", "invalid", "expired", "revoked", "attention_required"];
    for (const [index, status] of statuses.entries()) {
      await insert({ connection_id: `mc_status_${index}`, status });
    }

    const stored = await env.DB.prepare(
      "SELECT status FROM model_connection WHERE workspace_id = ? ORDER BY connection_id",
    )
      .bind(workspaceId)
      .all<{ status: string }>();

    expect(stored.results.map((row) => row.status)).toEqual(statuses);
  });

  it("refuses a status outside record 06's five", async () => {
    await expect(insert({ status: "totally_fine" })).rejects.toThrow();
  });

  it("refuses a provider no adapter can serve", async () => {
    await expect(insert({ provider: "acme-llm" })).rejects.toThrow();
  });

  it("refuses an auth type outside the protocol's two", async () => {
    await expect(insert({ auth_type: "cookie" })).rejects.toThrow();
  });

  it("refuses a row whose workspace does not exist", async () => {
    await expect(insert({ workspace_id: "wsp_never_registered" })).rejects.toThrow();
  });
});

// `worker/github/` casts these CHECK-constrained columns instead of parsing
// them, so the CHECKs are load-bearing.
describe("github_installation", () => {
  const workspaceId = "wsp_gh_migration";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, status, created_at, updated_at)
         VALUES ('usr_gh_migration', 'active', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'usr_gh_migration', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(workspaceId, NOW, NOW),
    ]);
    await env.DB.prepare("DELETE FROM github_installation WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
  });

  function insert(overrides: Partial<Record<string, string | number>> = {}) {
    const row = {
      installation_row_id: "ghi_1",
      workspace_id: workspaceId,
      github_installation_id: 501,
      github_user_id: 9001,
      account_login: "octocat",
      account_type: "User",
      status: "active",
      user_token_reference: "v1.bm9uY2U.dXNlcg",
      refresh_token_reference: "v1.bm9uY2U.cmVmcmVzaA",
      user_token_expires_at: NOW,
      refresh_token_expires_at: NOW,
      last_verified_at: NOW,
      ...overrides,
    };
    return env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference,
         refresh_token_reference, user_token_expires_at, refresh_token_expires_at,
         last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.installation_row_id,
        row.workspace_id,
        row.github_installation_id,
        row.github_user_id,
        row.account_login,
        row.account_type,
        row.status,
        row.user_token_reference,
        row.refresh_token_reference,
        row.user_token_expires_at,
        row.refresh_token_expires_at,
        row.last_verified_at,
        NOW,
        NOW,
      )
      .run();
  }

  it("creates the table with the columns record 07 names", async () => {
    await insert();
    const row = await env.DB.prepare(
      `SELECT installation_row_id, workspace_id, github_installation_id, github_user_id,
              account_login, account_type, status, user_token_reference,
              refresh_token_reference, user_token_expires_at, refresh_token_expires_at,
              last_verified_at, created_at, updated_at
         FROM github_installation WHERE installation_row_id = 'ghi_1'`,
    ).first();

    expect(row).toEqual({
      installation_row_id: "ghi_1",
      workspace_id: workspaceId,
      github_installation_id: 501,
      github_user_id: 9001,
      account_login: "octocat",
      account_type: "User",
      status: "active",
      user_token_reference: "v1.bm9uY2U.dXNlcg",
      refresh_token_reference: "v1.bm9uY2U.cmVmcmVzaA",
      user_token_expires_at: NOW,
      refresh_token_expires_at: NOW,
      last_verified_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("accepts both of record 07's account types", async () => {
    await insert({ installation_row_id: "ghi_user", account_type: "User" });
    await insert({
      installation_row_id: "ghi_org",
      github_installation_id: 502,
      account_type: "Organization",
    });

    const stored = await env.DB.prepare(
      "SELECT account_type FROM github_installation WHERE workspace_id = ? ORDER BY installation_row_id",
    )
      .bind(workspaceId)
      .all<{ account_type: string }>();

    expect(stored.results.map((row) => row.account_type).sort()).toEqual(["Organization", "User"]);
  });

  it("refuses an account_type outside record 07's two", async () => {
    await expect(insert({ account_type: "Bot" })).rejects.toThrow();
  });

  it("accepts each of record 07's four statuses", async () => {
    const statuses = ["active", "suspended", "deleted", "unauthorized"];
    for (const [index, status] of statuses.entries()) {
      await insert({
        installation_row_id: `ghi_status_${index}`,
        github_installation_id: 600 + index,
        status,
      });
    }

    const stored = await env.DB.prepare(
      "SELECT status FROM github_installation WHERE workspace_id = ? ORDER BY installation_row_id",
    )
      .bind(workspaceId)
      .all<{ status: string }>();

    expect(stored.results.map((row) => row.status)).toEqual(statuses);
  });

  it("refuses a status outside record 07's four", async () => {
    await expect(insert({ status: "revoked" })).rejects.toThrow();
  });

  it("refuses a second installation row for the same workspace and GitHub installation id", async () => {
    await insert({ installation_row_id: "ghi_dup_1" });
    await expect(insert({ installation_row_id: "ghi_dup_2" })).rejects.toThrow();
  });
});

describe("repository_connection", () => {
  const workspaceId = "wsp_repo_migration";
  const installationRowId = "ghi_repo_migration";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, status, created_at, updated_at)
         VALUES ('usr_repo_migration', 'active', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'usr_repo_migration', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(workspaceId, NOW, NOW),
    ]);
    await env.DB.prepare("DELETE FROM repository_connection WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
    await env.DB.prepare("DELETE FROM github_installation WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
    await env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference,
         refresh_token_reference, user_token_expires_at, refresh_token_expires_at,
         last_verified_at, created_at, updated_at
       ) VALUES (?, ?, 701, 9002, 'octocat', 'User', 'active', 'v1.a.b', 'v1.a.c', ?, ?, ?, ?, ?)`,
    )
      .bind(installationRowId, workspaceId, NOW, NOW, NOW, NOW, NOW)
      .run();
  });

  function insert(overrides: Partial<Record<string, string | number>> = {}) {
    const row = {
      repository_connection_id: "rc_1",
      workspace_id: workspaceId,
      installation_row_id: installationRowId,
      github_repository_id: 801,
      full_name: "octocat/hello-world",
      default_branch: "main",
      status: "verified",
      ...overrides,
    };
    return env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.repository_connection_id,
        row.workspace_id,
        row.installation_row_id,
        row.github_repository_id,
        row.full_name,
        row.default_branch,
        row.status,
        NOW,
        NOW,
      )
      .run();
  }

  it("creates the table with the columns record 07 names", async () => {
    await insert();
    const row = await env.DB.prepare(
      `SELECT repository_connection_id, workspace_id, installation_row_id, github_repository_id,
              full_name, default_branch, status, created_at, updated_at
         FROM repository_connection WHERE repository_connection_id = 'rc_1'`,
    ).first();

    expect(row).toEqual({
      repository_connection_id: "rc_1",
      workspace_id: workspaceId,
      installation_row_id: installationRowId,
      github_repository_id: 801,
      full_name: "octocat/hello-world",
      default_branch: "main",
      status: "verified",
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("accepts both of record 07's statuses", async () => {
    await insert({ repository_connection_id: "rc_verified", status: "verified" });
    await insert({
      repository_connection_id: "rc_disconnected",
      github_repository_id: 802,
      status: "disconnected",
    });

    const stored = await env.DB.prepare(
      "SELECT status FROM repository_connection WHERE workspace_id = ? ORDER BY repository_connection_id",
    )
      .bind(workspaceId)
      .all<{ status: string }>();

    expect(stored.results.map((row) => row.status).sort()).toEqual(["disconnected", "verified"]);
  });

  it("refuses a status outside record 07's two", async () => {
    await expect(insert({ status: "pending" })).rejects.toThrow();
  });

  it("refuses a second connection row for the same workspace and GitHub repository id", async () => {
    await insert({ repository_connection_id: "rc_dup_1" });
    await expect(insert({ repository_connection_id: "rc_dup_2" })).rejects.toThrow();
  });
});

describe("webhook_delivery", () => {
  it("stores a delivery and refuses a replayed delivery id", async () => {
    await env.DB.prepare(
      `INSERT INTO webhook_delivery (delivery_id, event_name, received_at)
       VALUES ('dlv_1', 'installation', ?)`,
    )
      .bind(NOW)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO webhook_delivery (delivery_id, event_name, received_at)
         VALUES ('dlv_1', 'installation', ?)`,
      )
        .bind(NOW)
        .run(),
    ).rejects.toThrow();

    await env.DB.prepare("DELETE FROM webhook_delivery WHERE delivery_id = 'dlv_1'").run();
  });
});

// The branch columns 0004 adds; the ALTERs must stay additive.
describe("session_index github columns", () => {
  const workspaceId = "wsp_session_gh_migration";

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM session_index WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
  });

  it("carries repository_connection_id, task_branch, and base_commit_sha", async () => {
    await env.DB.prepare(
      `INSERT INTO session_index (
         session_id, workspace_id, state, repository_connection_id, task_branch,
         base_commit_sha, created_at, updated_at
       ) VALUES ('sess_gh_1', ?, 'active', NULL, 'oncue/fix-login-7f3a', 'a1b2c3d', ?, ?)`,
    )
      .bind(workspaceId, NOW, NOW)
      .run();

    const row = await env.DB.prepare(
      "SELECT task_branch, base_commit_sha, repository_connection_id FROM session_index WHERE session_id = 'sess_gh_1'",
    ).first<{
      task_branch: string;
      base_commit_sha: string;
      repository_connection_id: string | null;
    }>();

    expect(row).toEqual({
      task_branch: "oncue/fix-login-7f3a",
      base_commit_sha: "a1b2c3d",
      repository_connection_id: null,
    });

    await env.DB.prepare("DELETE FROM session_index WHERE session_id = 'sess_gh_1'").run();
  });

  it("still accepts an existing-shaped insert that omits all three new columns", async () => {
    await env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
       VALUES ('sess_gh_2', ?, 'creating', ?, ?)`,
    )
      .bind(workspaceId, NOW, NOW)
      .run();

    const row = await env.DB.prepare(
      "SELECT task_branch, base_commit_sha, repository_connection_id FROM session_index WHERE session_id = 'sess_gh_2'",
    ).first();

    expect(row).toEqual({
      task_branch: null,
      base_commit_sha: null,
      repository_connection_id: null,
    });

    await env.DB.prepare("DELETE FROM session_index WHERE session_id = 'sess_gh_2'").run();
  });
});

// A Modal token pair: the `status` CHECK that makes
// `worker/modal/connections.ts`'s cast sound, the workspace foreign key, and
// the UNIQUE that is the one-connection-per-workspace rule.
describe("modal_connection", () => {
  const workspaceId = "wsp_modal_migration";
  const otherWorkspaceId = "wsp_modal_migration_other";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, status, created_at, updated_at)
         VALUES ('usr_modal_migration', 'active', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO user (id, status, created_at, updated_at)
         VALUES ('usr_modal_migration_other', 'active', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'usr_modal_migration', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(workspaceId, NOW, NOW),
      // One owner holds at most one private workspace (0002's partial unique
      // index), so a second workspace needs a second owner.
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'usr_modal_migration_other', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(otherWorkspaceId, NOW, NOW),
    ]);
    await env.DB.prepare("DELETE FROM modal_connection").run();
  });

  function insert(overrides: Partial<Record<string, string | null>> = {}) {
    const row: Record<string, string | null> = {
      connection_id: "mdl_1",
      workspace_id: workspaceId,
      token_id_reference: "oncue1.1.bm9uY2U.aWQ",
      token_secret_reference: "oncue1.1.bm9uY2U.c2VjcmV0",
      modal_workspace_name: "acme-workspace",
      environment_name: null,
      status: "active",
      ...overrides,
    };
    return env.DB.prepare(
      `INSERT INTO modal_connection (
         connection_id, workspace_id, token_id_reference, token_secret_reference,
         modal_workspace_name, environment_name, status, last_validated_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.connection_id,
        row.workspace_id,
        row.token_id_reference,
        row.token_secret_reference,
        row.modal_workspace_name,
        row.environment_name,
        row.status,
        NOW,
        NOW,
        NOW,
      )
      .run();
  }

  it("accepts both statuses the CHECK names", async () => {
    await insert({ connection_id: "mdl_active", status: "active" });
    await insert({
      connection_id: "mdl_invalid",
      workspace_id: otherWorkspaceId,
      status: "invalid",
    });

    const stored = await env.DB.prepare(
      "SELECT status FROM modal_connection ORDER BY connection_id",
    ).all<{ status: string }>();

    expect(stored.results.map((row) => row.status)).toEqual(["active", "invalid"]);
  });

  it("refuses a status outside the CHECK", async () => {
    await expect(insert({ status: "revoked" })).rejects.toThrow();
  });

  it("refuses a second connection for the same workspace", async () => {
    await insert({ connection_id: "mdl_first" });

    await expect(insert({ connection_id: "mdl_second" })).rejects.toThrow();
  });

  it("refuses a row whose workspace does not exist", async () => {
    await expect(insert({ workspace_id: "wsp_never_registered" })).rejects.toThrow();
  });

  it("keeps environment_name nullable, which means the workspace default", async () => {
    await insert({ environment_name: null });

    const row = await env.DB.prepare(
      "SELECT environment_name, modal_workspace_name FROM modal_connection WHERE connection_id = 'mdl_1'",
    ).first<{ environment_name: string | null; modal_workspace_name: string }>();

    expect(row).toEqual({ environment_name: null, modal_workspace_name: "acme-workspace" });
  });

  it("reads a row written before 0020 as never warmed", async () => {
    await insert();

    const row = await env.DB.prepare(
      "SELECT image_warmed_release, image_warmed_at FROM modal_connection WHERE connection_id = 'mdl_1'",
    ).first();

    expect(row).toEqual({ image_warmed_release: null, image_warmed_at: null });
  });
});

// The download route relies on these CHECKs. The column stays additive so a
// running session keeps its token.
describe("artifact_index and ended_sandbox_generation", () => {
  function insertArtifact(
    overrides: {
      kind?: string;
      producer?: string;
      classification?: string;
      id?: string;
      key?: string;
    } = {},
  ) {
    return env.DB.prepare(
      `INSERT INTO artifact_index (
         artifact_id, workspace_id, session_id, run_id, kind, producer, content_type,
         byte_size, sha256, classification, object_key, expires_at, created_at
       ) VALUES (?, 'wsp_art', 'sess_art', 'run_art', ?, ?, 'text/plain', 5, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        overrides.id ?? "art_1",
        overrides.kind ?? "tool_output",
        overrides.producer ?? "tool",
        "a".repeat(64),
        overrides.classification ?? "temporary",
        overrides.key ?? "workspaces/wsp_art/sessions/sess_art/runs/run_art/art_1",
        NOW,
      )
      .run();
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM artifact_index WHERE workspace_id = 'wsp_art'").run();
  });

  it("stores an artifact the protocol can describe", async () => {
    await insertArtifact();
    const row = await env.DB.prepare(
      "SELECT kind, producer, byte_size, object_key FROM artifact_index WHERE artifact_id = 'art_1'",
    ).first();
    expect(row).toEqual({
      kind: "tool_output",
      producer: "tool",
      byte_size: 5,
      object_key: "workspaces/wsp_art/sessions/sess_art/runs/run_art/art_1",
    });
  });

  it.each([
    ["a kind the protocol does not have", { kind: "archive" }],
    ["a producer the protocol does not have", { producer: "user" }],
    ["a classification outside the two", { classification: "forever" }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(insertArtifact(overrides)).rejects.toThrow();
  });

  it("refuses a second artifact under the same object key", async () => {
    await insertArtifact();
    await expect(insertArtifact({ id: "art_2" })).rejects.toThrow();
  });

  it("adds ended_sandbox_generation as NULL for a row that does not name it", async () => {
    await env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, state, sandbox_generation, created_at, updated_at)
       VALUES ('sess_ended_1', 'wsp_art', 'active', 2, ?, ?)`,
    )
      .bind(NOW, NOW)
      .run();
    const row = await env.DB.prepare(
      "SELECT ended_sandbox_generation FROM session_index WHERE session_id = 'sess_ended_1'",
    ).first();
    expect(row).toEqual({ ended_sandbox_generation: null });
    await env.DB.prepare("DELETE FROM session_index WHERE session_id = 'sess_ended_1'").run();
  });
});

// Migration 0019: a deletion receipt outlives the index row it names. 0022
// adds the hash of the task branch the session leaves on GitHub.
describe("deletion_request after 0019 and 0022", () => {
  it("carries the receipt fields and no foreign key to session_index", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(deletion_request)").all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "id",
      "session_id",
      "workspace_id",
      "requested_by_user_id",
      "requested_at",
      "attempts",
      "last_attempt_at",
      "failed_step",
      "completed_at",
      "outcome",
      "skip_reason",
      "released_ref_hash",
    ]);
    const keys = await env.DB.prepare("PRAGMA foreign_key_list(deletion_request)").all();
    expect(keys.results).toEqual([]);
  });

  it("lets the job remove the index row while the receipt stays", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
         VALUES ('sess_receipt', 'ws_receipt', 'deletion_pending', ?, ?)`,
      ).bind(NOW, NOW),
      env.DB.prepare(
        `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
         VALUES ('del_receipt', 'sess_receipt', 'ws_receipt', 'user_receipt', ?)`,
      ).bind(NOW),
    ]);

    await env.DB.prepare("DELETE FROM session_index WHERE session_id = 'sess_receipt'").run();

    expect(
      await env.DB.prepare(
        "SELECT attempts, failed_step, completed_at FROM deletion_request WHERE id = 'del_receipt'",
      ).first(),
    ).toEqual({ attempts: 0, failed_step: null, completed_at: null });
    await expect(
      env.DB.prepare(
        "UPDATE deletion_request SET failed_step = 'elsewhere' WHERE id = 'del_receipt'",
      ).run(),
    ).rejects.toThrow();
  });

  it("finds the owed requests through the partial index", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM deletion_request WHERE completed_at IS NULL ORDER BY last_attempt_at LIMIT 5",
    ).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("idx_deletion_request_open"))).toBe(true);
  });

  it("reads a receipt that names no released branch as NULL, and finds one by its hash through the partial index", async () => {
    await env.DB.prepare(
      `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
       VALUES ('del_no_ref', 'sess_no_ref', 'ws_receipt', 'user_receipt', ?)`,
    )
      .bind(NOW)
      .run();
    expect(
      await env.DB.prepare(
        "SELECT released_ref_hash FROM deletion_request WHERE id = 'del_no_ref'",
      ).first(),
    ).toEqual({ released_ref_hash: null });

    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM deletion_request WHERE released_ref_hash = 'abc' AND completed_at > 'x' LIMIT 1",
    ).all<{ detail: string }>();
    expect(
      plan.results.some((row) => row.detail.includes("idx_deletion_request_released_ref")),
    ).toBe(true);
  });
});
