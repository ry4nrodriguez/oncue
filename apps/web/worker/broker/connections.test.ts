import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createProviderDouble } from "../test/provider-double";
import {
  activeSessionsByConnection,
  type ConnectionDeps,
  createConnection,
  listActiveConnectionSummaries,
  listConnections,
  readAuthorizedConnection,
  readConnection,
  readStoredKey,
  recordKeyVerdict,
  replaceCredential,
  resolveModel,
  revokeConnection,
} from "./connections";
import { deriveKeyring, type Keyring } from "./envelope";
import { PROVIDER_ADAPTERS, type ProviderAdapter } from "./providers/adapter";

const NOW = "2026-09-05T00:00:00.000Z";
const WORKSPACE = "wsp_conn";
const OTHER_WORKSPACE = "wsp_other";
const KEY = "sk-ant-fake0001";

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
    throw new Error("expected a keyring");
  }
  return result.keyring;
}

/** The adapters only ever talk to the double here. */
function depsWith(keyring: Keyring<"credential">, fetchImpl: typeof fetch): ConnectionDeps {
  let counter = 0;
  return {
    db: env.DB,
    keyring,
    fetchImpl,
    originFor: (_adapter: ProviderAdapter) => "https://provider.double",
    now: () => NOW,
    newId: () => {
      counter += 1;
      return `mc_new_${counter}`;
    },
  };
}

async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_conn', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_conn', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES ('usr_other', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, 'usr_other', 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_WORKSPACE, NOW, NOW),
  ]);
}

async function insertConnection(overrides: {
  connectionId: string;
  workspaceId?: string;
  provider?: string;
  authType?: string;
  status?: string;
  sealed?: string;
  hint?: string | null;
  createdAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_connection (
       connection_id, workspace_id, provider, auth_type, credential_reference,
       status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      overrides.connectionId,
      overrides.workspaceId ?? WORKSPACE,
      overrides.provider ?? "anthropic",
      overrides.authType ?? "api_key",
      overrides.sealed ?? "oncue1.1.nonce.cipher",
      overrides.status ?? "active",
      overrides.hint === undefined ? "...0001" : overrides.hint,
      NOW,
      overrides.createdAt ?? NOW,
      NOW,
    )
    .run();
}

async function insertSession(
  sessionId: string,
  options: {
    workspaceId?: string;
    state?: string;
    generation?: number | null;
    endedGeneration?: number | null;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, ended_sandbox_generation, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      options.workspaceId ?? WORKSPACE,
      options.state ?? "active",
      options.generation === undefined ? 3 : options.generation,
      options.endedGeneration ?? null,
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await seedWorkspaces();
  await env.DB.prepare("DELETE FROM model_connection").run();
  await env.DB.prepare("DELETE FROM session_index").run();
});

describe("listConnections", () => {
  it("returns the workspace's connections newest first, whatever their status", async () => {
    await insertConnection({ connectionId: "mc_a", createdAt: "2026-09-01T00:00:00.000Z" });
    await insertConnection({
      connectionId: "mc_b",
      status: "revoked",
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    await insertConnection({ connectionId: "mc_dup_other", workspaceId: OTHER_WORKSPACE });

    const rows = await listConnections(env.DB, WORKSPACE);

    expect(rows.map((row) => row.connectionId)).toEqual(["mc_b", "mc_a"]);
    expect(rows.map((row) => row.status)).toEqual(["revoked", "active"]);
  });

  it("never returns the sealed value", async () => {
    await insertConnection({ connectionId: "mc_a", sealed: "oncue1.1.secretnonce.secretcipher" });

    const rows = await listConnections(env.DB, WORKSPACE);

    expect(JSON.stringify(rows).includes("secretcipher")).toBe(false);
  });
});

describe("listActiveConnectionSummaries", () => {
  it("returns only active rows, labelled for the setup screen", async () => {
    await insertConnection({ connectionId: "mc_a", hint: "...4f21" });
    await insertConnection({ connectionId: "mc_dead", status: "invalid" });

    expect(await listActiveConnectionSummaries(env.DB, WORKSPACE)).toEqual([
      {
        modelConnectionId: "mc_a",
        label: "anthropic ...4f21",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: PROVIDER_ADAPTERS.anthropic.models,
      },
    ]);
  });

  it("labels a connection with no hint by its provider alone", async () => {
    await insertConnection({ connectionId: "mc_a", hint: null });

    expect(await listActiveConnectionSummaries(env.DB, WORKSPACE)).toEqual([
      {
        modelConnectionId: "mc_a",
        label: "anthropic",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: PROVIDER_ADAPTERS.anthropic.models,
      },
    ]);
  });
});

describe("createConnection", () => {
  it("validates against the provider, then stores a sealed value and no plaintext", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic");

    const outcome = await createConnection(
      depsWith(keyring, double.fetchImpl),
      WORKSPACE,
      "anthropic",
      KEY,
    );
    if (outcome.kind !== "created") {
      throw new Error(`expected created, got ${outcome.kind}`);
    }

    const stored = await env.DB.prepare(
      "SELECT credential_reference, status, provider_account_hint FROM model_connection WHERE connection_id = ?",
    )
      .bind(outcome.summary.connectionId)
      .first<{
        credential_reference: string;
        status: string;
        provider_account_hint: string | null;
      }>();

    expect(stored?.status).toBe("active");
    expect(stored?.credential_reference.startsWith("oncue1.1.")).toBe(true);
    expect(stored?.credential_reference.includes(KEY)).toBe(false);
    expect(stored?.provider_account_hint).toBe("...0001");
  });

  it("writes no row at all when the provider rejects the key", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic", "auth_failed");

    const outcome = await createConnection(
      depsWith(keyring, double.fetchImpl),
      WORKSPACE,
      "anthropic",
      KEY,
    );

    expect(outcome).toEqual({ kind: "rejected", category: "authentication_failed" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM model_connection").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("refuses a second key for a provider while one is not revoked, and allows one after a revoke", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic");
    // One deps object: its id counter must not restart between creates.
    const deps = depsWith(keyring, double.fetchImpl);
    await insertConnection({ connectionId: "mc_dup_held", status: "attention_required" });

    const refused = await createConnection(deps, WORKSPACE, "anthropic", KEY);
    expect(refused).toEqual({ kind: "already_connected", connectionId: "mc_dup_held" });
    expect(double.calls).toHaveLength(0);

    // Another workspace's key and another provider's key do not count.
    await insertConnection({ connectionId: "mc_dup_other", workspaceId: OTHER_WORKSPACE });
    const openai = await createConnection(deps, WORKSPACE, "openai", "sk-proj-fake0002");
    expect(openai.kind).toBe("created");

    await revokeConnection(env.DB, WORKSPACE, "mc_dup_held", NOW);
    const after = await createConnection(deps, WORKSPACE, "anthropic", KEY);
    expect(after.kind).toBe("created");
  });

  it("stores an OpenAI connection under its own provider", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("openai");

    const outcome = await createConnection(
      depsWith(keyring, double.fetchImpl),
      WORKSPACE,
      "openai",
      "sk-proj-fake0001",
    );
    if (outcome.kind !== "created") {
      throw new Error("expected created");
    }

    expect(outcome.summary.provider).toBe("openai");
  });
});

describe("replaceCredential", () => {
  it("reseals under the same connection id and clears an invalid status", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic");
    await insertConnection({ connectionId: "mc_a", status: "invalid" });

    const outcome = await replaceCredential(
      depsWith(keyring, double.fetchImpl),
      WORKSPACE,
      "mc_a",
      KEY,
    );

    expect(outcome.kind).toBe("replaced");
    const stored = await env.DB.prepare(
      "SELECT status, credential_reference FROM model_connection WHERE connection_id = 'mc_a'",
    ).first<{ status: string; credential_reference: string }>();
    expect(stored?.status).toBe("active");
    expect(stored?.credential_reference.startsWith("oncue1.1.")).toBe(true);
  });

  it("leaves the stored value alone when the provider rejects the new key", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic", "auth_failed");
    await insertConnection({ connectionId: "mc_a", sealed: "oncue1.1.old.value" });

    const outcome = await replaceCredential(
      depsWith(keyring, double.fetchImpl),
      WORKSPACE,
      "mc_a",
      KEY,
    );

    expect(outcome).toEqual({ kind: "rejected", category: "authentication_failed" });
    const stored = await env.DB.prepare(
      "SELECT credential_reference FROM model_connection WHERE connection_id = 'mc_a'",
    ).first<{ credential_reference: string }>();
    expect(stored?.credential_reference).toBe("oncue1.1.old.value");
  });

  it("refuses a connection that does not exist", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic");

    expect(
      await replaceCredential(depsWith(keyring, double.fetchImpl), WORKSPACE, "mc_ghost", KEY),
    ).toEqual({ kind: "not_found" });
  });

  it("refuses another workspace's connection exactly as if it did not exist", async () => {
    const keyring = await credentialKeyring();
    const double = createProviderDouble("anthropic");
    await insertConnection({ connectionId: "mc_theirs", workspaceId: OTHER_WORKSPACE });

    expect(
      await replaceCredential(depsWith(keyring, double.fetchImpl), WORKSPACE, "mc_theirs", KEY),
    ).toEqual({ kind: "not_found" });
  });
});

describe("activeSessionsByConnection", () => {
  it("counts only active sessions, per connection, within the workspace", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertConnection({ connectionId: "mc_b", provider: "openai" });
    for (const [sessionId, workspaceId, state, connectionId] of [
      ["sess_a1", WORKSPACE, "active", "mc_a"],
      ["sess_a2", WORKSPACE, "active", "mc_a"],
      ["sess_a3", WORKSPACE, "archived", "mc_a"],
      ["sess_none", WORKSPACE, "active", null],
      ["sess_other", OTHER_WORKSPACE, "active", "mc_a"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, model_connection_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
        .bind(sessionId, workspaceId, state, connectionId, NOW, NOW)
        .run();
    }

    const counts = await activeSessionsByConnection(env.DB, WORKSPACE);
    expect([...counts.entries()]).toEqual([["mc_a", 2]]);
  });
});

describe("revokeConnection", () => {
  it("flips the status and destroys the sealed bytes", async () => {
    await insertConnection({ connectionId: "mc_a", sealed: "oncue1.1.keepme.secret" });

    const outcome = await revokeConnection(env.DB, WORKSPACE, "mc_a", NOW);

    expect(outcome.kind).toBe("revoked");
    const stored = await env.DB.prepare(
      "SELECT status, credential_reference FROM model_connection WHERE connection_id = 'mc_a'",
    ).first<{ status: string; credential_reference: string }>();
    expect(stored?.status).toBe("revoked");
    expect(stored?.credential_reference).toBe("");
  });

  it("refuses a connection that does not exist", async () => {
    expect(await revokeConnection(env.DB, WORKSPACE, "mc_ghost", NOW)).toEqual({
      kind: "not_found",
    });
  });

  it("refuses another workspace's connection", async () => {
    await insertConnection({ connectionId: "mc_theirs", workspaceId: OTHER_WORKSPACE });

    expect(await revokeConnection(env.DB, WORKSPACE, "mc_theirs", NOW)).toEqual({
      kind: "not_found",
    });
  });

  it("is a no-op the second time, so a retry does not resurrect a row", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await revokeConnection(env.DB, WORKSPACE, "mc_a", NOW);

    expect(await revokeConnection(env.DB, WORKSPACE, "mc_a", NOW)).toEqual({ kind: "not_found" });
  });
});

describe("readConnection", () => {
  it("returns the caller's connection without its sealed value, and nothing for another workspace's", async () => {
    await insertConnection({ connectionId: "mc_mine", status: "invalid" });
    await insertConnection({ connectionId: "mc_theirs", workspaceId: OTHER_WORKSPACE });

    const mine = await readConnection(env.DB, WORKSPACE, "mc_mine");
    expect(mine).toEqual({
      connectionId: "mc_mine",
      provider: "anthropic",
      status: "invalid",
      providerAccountHint: "...0001",
      lastValidatedAt: NOW,
      createdAt: NOW,
    });
    expect(JSON.stringify(mine).includes("oncue1.")).toBe(false);
    expect(await readConnection(env.DB, WORKSPACE, "mc_theirs")).toBeNull();
    expect(await readConnection(env.DB, WORKSPACE, "mc_missing")).toBeNull();
  });
});

describe("readStoredKey", () => {
  it("returns the sealed value and what a check needs, only to the owning workspace", async () => {
    await insertConnection({ connectionId: "mc_key", provider: "openai", sealed: "oncue1.1.a.b" });

    expect(await readStoredKey(env.DB, WORKSPACE, "mc_key")).toEqual({
      kind: "found",
      provider: "openai",
      status: "active",
      sealed: "oncue1.1.a.b",
      lastValidatedAt: NOW,
    });
    expect(await readStoredKey(env.DB, OTHER_WORKSPACE, "mc_key")).toEqual({ kind: "absent" });
    expect(await readStoredKey(env.DB, WORKSPACE, "mc_missing")).toEqual({ kind: "absent" });
  });
});

describe("recordKeyVerdict", () => {
  const LATER = "2026-09-06T00:00:00.000Z";
  const SEALED = "oncue1.1.checked.key";
  const key = { workspaceId: WORKSPACE, connectionId: "mc_v", sealed: SEALED };

  async function stored(): Promise<{
    status: string;
    last_validated_at: string;
    updated_at: string;
  }> {
    const row = await env.DB.prepare(
      "SELECT status, last_validated_at, updated_at FROM model_connection WHERE connection_id = 'mc_v'",
    ).first<{ status: string; last_validated_at: string; updated_at: string }>();
    if (row === null) {
      throw new Error("expected the connection row");
    }
    return row;
  }

  it.each([
    ["active", "accepted", { status: "active", last_validated_at: LATER, updated_at: LATER }],
    ["invalid", "accepted", { status: "active", last_validated_at: LATER, updated_at: LATER }],
    ["active", "rejected", { status: "invalid", last_validated_at: NOW, updated_at: LATER }],
    ["invalid", "rejected", { status: "invalid", last_validated_at: NOW, updated_at: NOW }],
    // Statuses a key check does not own are left as they are, either way.
    ["expired", "accepted", { status: "expired", last_validated_at: NOW, updated_at: NOW }],
    [
      "attention_required",
      "rejected",
      {
        status: "attention_required",
        last_validated_at: NOW,
        updated_at: NOW,
      },
    ],
  ] as const)(
    "on a connection that is %s, %s leaves the expected row",
    async (status, verdict, expected) => {
      await insertConnection({ connectionId: "mc_v", status, sealed: SEALED });
      await recordKeyVerdict(env.DB, key, verdict, LATER);
      expect(await stored()).toEqual(expected);
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "writes nothing for a verdict of %s on a sealed value the row no longer holds",
    async (verdict) => {
      await insertConnection({
        connectionId: "mc_v",
        status: verdict === "accepted" ? "invalid" : "active",
        sealed: "oncue1.1.replaced.since",
      });
      await recordKeyVerdict(env.DB, key, verdict, LATER);
      expect((await stored()).updated_at).toBe(NOW);
    },
  );

  it("writes nothing through another workspace's id", async () => {
    await insertConnection({ connectionId: "mc_v", sealed: SEALED });
    await recordKeyVerdict(env.DB, { ...key, workspaceId: OTHER_WORKSPACE }, "rejected", LATER);
    expect((await stored()).status).toBe("active");
  });
});

describe("resolveModel", () => {
  it("falls back to the fake driver when the workspace has no active connection", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, { commandId: "c1" })).toEqual({ kind: "fake" });
  });

  it("falls back to the fake driver when a body is not an object at all", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, "not an object")).toEqual({ kind: "fake" });
  });

  it("still falls back when the only connection is revoked", async () => {
    await insertConnection({ connectionId: "mc_dead", status: "revoked" });

    expect(await resolveModel(env.DB, WORKSPACE, {})).toEqual({ kind: "fake" });
  });

  // Falling back would hand a workspace with real provider access a scripted
  // transcript presented as an agent run.
  it("refuses a request that names nothing once an active connection exists", async () => {
    await insertConnection({ connectionId: "mc_a" });

    expect(await resolveModel(env.DB, WORKSPACE, { commandId: "c1" })).toEqual({
      kind: "refused",
      reason: "connection_required",
    });
  });

  it("refuses a connection id that is not a string", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: 7 })).toEqual({
      kind: "refused",
      reason: "malformed",
    });
  });

  it("refuses an empty connection id", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "" })).toEqual({
      kind: "refused",
      reason: "malformed",
    });
  });

  it("refuses an id that does not exist", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_ghost" })).toEqual({
      kind: "refused",
      reason: "not_usable",
    });
  });

  /** Indistinguishable from "does not exist", so ids cannot be probed. */
  it("refuses another workspace's connection with the same answer as a missing one", async () => {
    await insertConnection({ connectionId: "mc_theirs", workspaceId: OTHER_WORKSPACE });

    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_theirs" })).toEqual({
      kind: "refused",
      reason: "not_usable",
    });
  });

  it("tells the owner when their own connection is not active", async () => {
    await insertConnection({ connectionId: "mc_a", status: "invalid" });

    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a" })).toEqual({
      kind: "refused",
      reason: "not_active",
    });
  });

  it("resolves an active connection to the adapter's model, never a client's", async () => {
    await insertConnection({ connectionId: "mc_a" });

    expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a" })).toEqual({
      kind: "resolved",
      model: {
        provider: "anthropic",
        modelId: PROVIDER_ADAPTERS.anthropic.defaultModel.modelId,
        modelConnectionId: "mc_a",
        authenticationType: "api_key",
        contextWindow: PROVIDER_ADAPTERS.anthropic.defaultModel.contextWindow,
        // Nothing named an effort, so the run gets the model's own default.
        effort: PROVIDER_ADAPTERS.anthropic.defaultModel.defaultEffort,
      },
    });
  });

  // No route writes `subscription` yet, but record 06's CHECK allows it, so the
  // ModelRecord must carry it through rather than flatten it to api_key.
  it("carries a subscription connection's authentication type through", async () => {
    await insertConnection({ connectionId: "mc_sub", authType: "subscription" });

    const resolved = await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_sub" });
    if (resolved.kind !== "resolved") {
      throw new Error(`expected resolved, got ${resolved.kind}`);
    }

    expect(resolved.model.authenticationType).toBe("subscription");
  });

  it("records the catalog model the body names, at that model's own default effort", async () => {
    await insertConnection({ connectionId: "mc_a" });
    const resolved = await resolveModel(env.DB, WORKSPACE, {
      modelConnectionId: "mc_a",
      modelId: "claude-sonnet-5",
    });
    expect(resolved).toMatchObject({
      kind: "resolved",
      model: { modelId: "claude-sonnet-5", contextWindow: 1_000_000, effort: "high" },
    });
  });

  it("refuses a model the catalog does not list for the provider, whatever its shape", async () => {
    await insertConnection({ connectionId: "mc_a" });
    for (const modelId of ["gpt-6-sol", "claude-opus-9", 7, null]) {
      expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a", modelId })).toEqual(
        { kind: "refused", reason: "model_unavailable" },
      );
    }
  });

  it("records a named effort the model documents, and refuses one it does not", async () => {
    await insertConnection({ connectionId: "mc_a" });
    const low = await resolveModel(env.DB, WORKSPACE, {
      modelConnectionId: "mc_a",
      modelId: "claude-opus-5-5",
      effort: "low",
    });
    expect(low).toMatchObject({ kind: "resolved", model: { effort: "low" } });
    // `none` is OpenAI's word; no Claude model documents it.
    expect(
      await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a", effort: "none" }),
    ).toEqual({ kind: "refused", reason: "effort_unsupported" });
    // A model with effort must run at one; null is not a level for it.
    expect(
      await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a", effort: null }),
    ).toEqual({ kind: "refused", reason: "effort_unsupported" });
  });

  it("records null effort for a model with no effort parameter, and nothing else", async () => {
    await insertConnection({ connectionId: "mc_a" });
    const haiku = { modelConnectionId: "mc_a", modelId: "claude-haiku-4-5-20251001" };
    expect(await resolveModel(env.DB, WORKSPACE, haiku)).toMatchObject({
      kind: "resolved",
      model: { modelId: "claude-haiku-4-5-20251001", effort: null },
    });
    expect(await resolveModel(env.DB, WORKSPACE, { ...haiku, effort: null })).toMatchObject({
      kind: "resolved",
      model: { effort: null },
    });
    expect(await resolveModel(env.DB, WORKSPACE, { ...haiku, effort: "low" })).toEqual({
      kind: "refused",
      reason: "effort_unsupported",
    });
  });

  it("refuses an effort that is not a level at all as malformed", async () => {
    await insertConnection({ connectionId: "mc_a" });
    for (const effort of [3, "very high", { level: "high" }]) {
      expect(await resolveModel(env.DB, WORKSPACE, { modelConnectionId: "mc_a", effort })).toEqual({
        kind: "refused",
        reason: "malformed",
      });
    }
  });

  it("ignores an array body rather than reading an index off it", async () => {
    expect(await resolveModel(env.DB, WORKSPACE, ["modelConnectionId"])).toEqual({ kind: "fake" });
  });
});

describe("readAuthorizedConnection", () => {
  const claims = {
    sessionId: "sess_1",
    workspaceId: WORKSPACE,
    connectionId: "mc_a",
    sandboxGeneration: 3,
  };

  it("authorizes a live session against its own active connection", async () => {
    await insertConnection({ connectionId: "mc_a", sealed: "oncue1.1.n.c" });
    await insertSession("sess_1");

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({
      kind: "authorized",
      provider: "anthropic",
      sealed: "oncue1.1.n.c",
    });
  });

  it("denies when the connection does not exist", async () => {
    await insertSession("sess_1");

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  it("denies when the session does not exist", async () => {
    await insertConnection({ connectionId: "mc_a" });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  /** A token minted for one session cannot act on another. */
  it("denies a session belonging to another workspace", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertSession("sess_1", { workspaceId: OTHER_WORKSPACE });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  it("denies when the connection belongs to another workspace", async () => {
    await insertConnection({ connectionId: "mc_a", workspaceId: OTHER_WORKSPACE });
    await insertSession("sess_1");

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  /** Revocation lands on the very next forward, with no cache between. */
  it("denies a revoked connection", async () => {
    await insertConnection({ connectionId: "mc_a", status: "revoked" });
    await insertSession("sess_1");

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  it("denies once the session is no longer active", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertSession("sess_1", { state: "archived" });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  // Record 03's stale-generation rule at the D1 layer: a token must not outlive
  // its sandbox.
  it("denies a token from a generation the session has moved past", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertSession("sess_1", { generation: 4 });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  // A stopped sandbox keeps its generation number until a resume replaces it,
  // so the ended generation's token stops working (record 11).
  it("denies a token from a generation the session object has stopped and revoked", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertSession("sess_1", { generation: 3, endedGeneration: 3 });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });

  it("still authorizes the current generation after an older one ended", async () => {
    await insertConnection({ connectionId: "mc_a", sealed: "oncue1.1.n.c" });
    await insertSession("sess_1", { generation: 3, endedGeneration: 2 });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({
      kind: "authorized",
      provider: "anthropic",
      sealed: "oncue1.1.n.c",
    });
  });

  it("denies a session whose generation has not been projected yet", async () => {
    await insertConnection({ connectionId: "mc_a" });
    await insertSession("sess_1", { generation: null });

    expect(await readAuthorizedConnection(env.DB, claims)).toEqual({ kind: "denied" });
  });
});
