import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createProviderDouble, type DoubleMode } from "../test/provider-double";
import type { ConnectionDeps } from "./connections";
import { deriveKeyring, type Keyring, sealCredential } from "./envelope";
import {
  checkKey,
  checkStoredKey,
  KEY_CHECK_FRESH_MS,
  KEY_CHECK_TIMEOUT_MS,
  type KeyVerdict,
} from "./key-check";
import { PROVIDER_ADAPTERS, type ProviderAdapter } from "./providers/adapter";

const NOW = "2026-09-05T12:00:00.000Z";
const LONG_AGO = "2026-08-01T00:00:00.000Z";
const WORKSPACE = "wsp_check";
const OTHER_WORKSPACE = "wsp_check_other";
const CONNECTION = "mc_check";
/** Short enough for the secret scanner, distinctive enough to search for. */
const KEY = "sk-ant-checkcanary01";
const ORIGIN = "https://provider.double";

const originFor = (_adapter: ProviderAdapter) => ORIGIN;

function minutesBefore(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

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

/** A provider that accepts the connection and then never answers. */
function silentFetch(): { fetchImpl: typeof fetch; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    fetchImpl: (_input, init) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return new Promise<Response>(() => undefined);
    },
  };
}

describe("checkKey", () => {
  const cases: readonly [DoubleMode, KeyVerdict][] = [
    ["ok", "accepted"],
    ["auth_failed", "rejected"],
    // The key is fine; what it may not do is a model request.
    ["request_forbidden", "accepted"],
    ["rate_limited", "inconclusive"],
    // An exhausted allowance is a 429 or a 400, neither a verdict on the key.
    ["usage_limit", "inconclusive"],
    ["model_unavailable", "inconclusive"],
    ["overloaded", "inconclusive"],
  ];
  for (const provider of ["anthropic", "openai"] as const) {
    for (const [mode, verdict] of cases) {
      it(`is ${verdict} when ${provider} answers ${mode}`, async () => {
        const double = createProviderDouble(provider, mode);
        const answered = await checkKey(
          { fetchImpl: double.fetchImpl, originFor },
          PROVIDER_ADAPTERS[provider],
          KEY,
        );
        expect(answered).toBe(verdict);
        expect(double.calls.map((call) => call.url)).toEqual([`${ORIGIN}/v1/models`]);
      });
    }
  }

  it("is inconclusive when the provider cannot be reached", async () => {
    const answered = await checkKey(
      { fetchImpl: () => Promise.reject(new Error("no route")), originFor },
      PROVIDER_ADAPTERS.anthropic,
      KEY,
    );
    expect(answered).toBe("inconclusive");
  });

  it("gives up at the timeout, aborting the request, when the provider never answers", async () => {
    const silent = silentFetch();
    const started = Date.now();
    const answered = await checkKey(
      { fetchImpl: silent.fetchImpl, originFor, timeoutMs: 20 },
      PROVIDER_ADAPTERS.openai,
      KEY,
    );
    expect(answered).toBe("inconclusive");
    expect(Date.now() - started).toBeLessThan(KEY_CHECK_TIMEOUT_MS);
    expect(silent.signals).toHaveLength(1);
    expect(silent.signals[0]?.aborted).toBe(true);
  });

  it("never throws: a refusal whose body cannot be read is inconclusive", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection cut"));
      },
    });
    const answered = await checkKey(
      { fetchImpl: () => Promise.resolve(new Response(broken, { status: 401 })), originFor },
      PROVIDER_ADAPTERS.anthropic,
      KEY,
    );
    expect(answered).toBe("inconclusive");
  });

  it("leaves no timer running once the provider has answered", async () => {
    const double = createProviderDouble("anthropic");
    const answered = await checkKey(
      { fetchImpl: double.fetchImpl, originFor, timeoutMs: 30 },
      PROVIDER_ADAPTERS.anthropic,
      KEY,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(answered).toBe("accepted");
  });
});

describe("checkStoredKey", () => {
  let keyring: Keyring<"credential">;

  function depsWith(
    fetchImpl: typeof fetch,
  ): Pick<ConnectionDeps, "db" | "keyring" | "fetchImpl" | "originFor" | "now"> {
    return { db: env.DB, keyring, fetchImpl, originFor, now: () => NOW };
  }

  async function insert(
    options: {
      workspaceId?: string;
      provider?: "anthropic" | "openai";
      status?: string;
      sealed?: string;
      lastValidatedAt?: string | null;
    } = {},
  ): Promise<string> {
    const workspaceId = options.workspaceId ?? WORKSPACE;
    const provider = options.provider ?? "anthropic";
    const sealed =
      options.sealed ??
      (await sealCredential(keyring, { connectionId: CONNECTION, workspaceId, provider }, KEY));
    await env.DB.prepare(
      `INSERT INTO model_connection (
         connection_id, workspace_id, provider, auth_type, credential_reference,
         status, provider_account_hint, expires_at, last_validated_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'api_key', ?, ?, '...ry01', NULL, ?, ?, ?)`,
    )
      .bind(
        CONNECTION,
        workspaceId,
        provider,
        sealed,
        options.status ?? "active",
        options.lastValidatedAt === undefined ? LONG_AGO : options.lastValidatedAt,
        LONG_AGO,
        LONG_AGO,
      )
      .run();
    return sealed;
  }

  async function row(): Promise<{
    status: string;
    last_validated_at: string | null;
    updated_at: string;
    credential_reference: string;
  }> {
    const found = await env.DB.prepare(
      "SELECT status, last_validated_at, updated_at, credential_reference FROM model_connection WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .first<{
        status: string;
        last_validated_at: string | null;
        updated_at: string;
        credential_reference: string;
      }>();
    if (found === null) {
      throw new Error("expected the connection row");
    }
    return found;
  }

  const target = { workspaceId: WORKSPACE, connectionId: CONNECTION };

  beforeEach(async () => {
    keyring = await credentialKeyring();
    await env.DB.batch(
      [
        ["usr_check", WORKSPACE],
        ["usr_check_other", OTHER_WORKSPACE],
      ].flatMap(([user, workspace]) => [
        env.DB.prepare(
          `INSERT INTO user (id, status, created_at, updated_at)
           VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(user, NOW, NOW),
        env.DB.prepare(
          `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
           VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(workspace, user, NOW, NOW),
      ]),
    );
    await env.DB.prepare("DELETE FROM model_connection").run();
  });

  it("answers absent for an id that does not exist, without asking the provider", async () => {
    const double = createProviderDouble("anthropic");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "absent" });
    expect(double.calls).toEqual([]);
  });

  it("answers absent for another workspace's connection, and leaves it alone", async () => {
    await insert({ workspaceId: OTHER_WORKSPACE });
    const double = createProviderDouble("anthropic", "auth_failed");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "absent" });
    expect(double.calls).toEqual([]);
    expect((await row()).status).toBe("active");
  });

  it("refuses a revoked connection, which holds no key to check", async () => {
    await insert({ status: "revoked", sealed: "" });
    const double = createProviderDouble("anthropic");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "no_key" });
    expect(double.calls).toEqual([]);
    expect((await row()).status).toBe("revoked");
  });

  it("accepts a working key and moves its validation time", async () => {
    await insert();
    const double = createProviderDouble("anthropic");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "accepted" });
    expect(double.calls.map((call) => call.headers["x-api-key"])).toEqual([KEY]);
    expect(await row()).toMatchObject({
      status: "active",
      last_validated_at: NOW,
      updated_at: NOW,
    });
  });

  it("returns an invalid connection to active when the provider accepts its key", async () => {
    await insert({ status: "invalid", provider: "openai" });
    const double = createProviderDouble("openai");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "accepted" });
    expect(await row()).toMatchObject({ status: "active", last_validated_at: NOW });
  });

  it("marks the connection invalid when the provider rejects its key, keeping the last good validation", async () => {
    await insert();
    const double = createProviderDouble("anthropic", "auth_failed");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "rejected" });
    expect(await row()).toMatchObject({
      status: "invalid",
      last_validated_at: LONG_AGO,
      updated_at: NOW,
    });
  });

  it("leaves an already invalid connection as it was when the provider rejects it again", async () => {
    await insert({ status: "invalid" });
    const double = createProviderDouble("anthropic", "auth_failed");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "rejected" });
    expect(await row()).toMatchObject({ status: "invalid", updated_at: LONG_AGO });
  });

  it.each(["rate_limited", "overloaded"] as const)(
    "changes nothing when the provider answers %s",
    async (mode) => {
      await insert();
      const double = createProviderDouble("anthropic", mode);
      expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({
        kind: "inconclusive",
      });
      expect(await row()).toMatchObject({
        status: "active",
        last_validated_at: LONG_AGO,
        updated_at: LONG_AGO,
      });
    },
  );

  it("changes nothing, and stops waiting, when the provider never answers", async () => {
    await insert({ status: "invalid" });
    const silent = silentFetch();
    expect(await checkStoredKey(depsWith(silent.fetchImpl), target, { timeoutMs: 20 })).toEqual({
      kind: "inconclusive",
    });
    expect(silent.signals[0]?.aborted).toBe(true);
    expect(await row()).toMatchObject({ status: "invalid", updated_at: LONG_AGO });
  });

  it("says unusable, without asking the provider, when the sealed value will not open", async () => {
    await insert({ sealed: "oncue1.1.nonce.cipher" });
    const double = createProviderDouble("anthropic", "auth_failed");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "unusable" });
    expect(double.calls).toEqual([]);
    expect((await row()).status).toBe("active");
  });

  describe("with a freshness window", () => {
    const fresh = { freshForMs: KEY_CHECK_FRESH_MS };

    it("does not ask about an active key validated inside the window", async () => {
      await insert({ lastValidatedAt: minutesBefore(NOW, 9) });
      const double = createProviderDouble("anthropic", "auth_failed");
      expect(await checkStoredKey(depsWith(double.fetchImpl), target, fresh)).toEqual({
        kind: "fresh",
      });
      expect(double.calls).toEqual([]);
      expect((await row()).status).toBe("active");
    });

    it("asks once the last validation is older than the window", async () => {
      await insert({ lastValidatedAt: minutesBefore(NOW, 10) });
      const double = createProviderDouble("anthropic");
      expect(await checkStoredKey(depsWith(double.fetchImpl), target, fresh)).toEqual({
        kind: "accepted",
      });
      expect(double.calls).toHaveLength(1);
    });

    it("asks about a key that was never validated", async () => {
      await insert({ lastValidatedAt: null });
      const double = createProviderDouble("anthropic");
      expect(await checkStoredKey(depsWith(double.fetchImpl), target, fresh)).toEqual({
        kind: "accepted",
      });
      expect(double.calls).toHaveLength(1);
    });

    it("asks about a connection that is not active, however recently it validated", async () => {
      await insert({ status: "invalid", lastValidatedAt: minutesBefore(NOW, 1) });
      const double = createProviderDouble("anthropic", "auth_failed");
      expect(await checkStoredKey(depsWith(double.fetchImpl), target, fresh)).toEqual({
        kind: "rejected",
      });
      expect(double.calls).toHaveLength(1);
    });

    it("lets a burst of checks cost one provider call", async () => {
      await insert();
      const double = createProviderDouble("anthropic");
      const deps = depsWith(double.fetchImpl);
      expect(await checkStoredKey(deps, target, fresh)).toEqual({ kind: "accepted" });
      expect(await checkStoredKey(deps, target, fresh)).toEqual({ kind: "fresh" });
      expect(await checkStoredKey(deps, target, fresh)).toEqual({ kind: "fresh" });
      expect(double.calls).toHaveLength(1);
    });
  });

  it("asks every time when no window is given, even just after a validation", async () => {
    await insert({ lastValidatedAt: NOW });
    const double = createProviderDouble("anthropic");
    expect(await checkStoredKey(depsWith(double.fetchImpl), target)).toEqual({ kind: "accepted" });
    expect(double.calls).toHaveLength(1);
  });

  it("does not condemn a key that was replaced while the old one was being checked", async () => {
    await insert();
    const replacement = await sealCredential(
      keyring,
      { connectionId: CONNECTION, workspaceId: WORKSPACE, provider: "anthropic" },
      "sk-ant-replacement01",
    );
    const rejecting = createProviderDouble("anthropic", "auth_failed");
    const fetchImpl: typeof fetch = async (input, init) => {
      await env.DB.prepare(
        "UPDATE model_connection SET credential_reference = ? WHERE connection_id = ?",
      )
        .bind(replacement, CONNECTION)
        .run();
      return rejecting.fetchImpl(input, init);
    };
    expect(await checkStoredKey(depsWith(fetchImpl), target)).toEqual({ kind: "rejected" });
    expect(await row()).toMatchObject({ status: "active", credential_reference: replacement });
  });

  it("does not bring back a connection revoked while its key was being checked", async () => {
    await insert({ status: "invalid" });
    const accepting = createProviderDouble("anthropic");
    const fetchImpl: typeof fetch = async (input, init) => {
      await env.DB.prepare(
        "UPDATE model_connection SET status = 'revoked', credential_reference = '' WHERE connection_id = ?",
      )
        .bind(CONNECTION)
        .run();
      return accepting.fetchImpl(input, init);
    };
    expect(await checkStoredKey(depsWith(fetchImpl), target)).toEqual({ kind: "accepted" });
    expect(await row()).toMatchObject({ status: "revoked", credential_reference: "" });
  });

  it("puts no part of the key in what it returns or stores", async () => {
    await insert();
    for (const mode of ["ok", "auth_failed", "overloaded"] as const) {
      const outcome = await checkStoredKey(
        depsWith(createProviderDouble("anthropic", mode).fetchImpl),
        target,
      );
      expect(JSON.stringify(outcome).includes("checkcanary")).toBe(false);
    }
    const stored = await env.DB.prepare("SELECT * FROM model_connection WHERE connection_id = ?")
      .bind(CONNECTION)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(stored).includes("checkcanary")).toBe(false);
  });
});
