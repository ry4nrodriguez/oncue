import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkAllowlist,
  createAllowlistCache,
  isAllowlisted,
  isCacheFresh,
  parseAllowlist,
  readAllowlistVersion,
} from "./allowlist";

describe("parseAllowlist", () => {
  it("splits on commas and newlines, trims whitespace, and drops empty entries", () => {
    const allowlist = parseAllowlist(" user_a,  user_b\nuser_c \n\n,user_a");

    expect(allowlist).toEqual(new Set(["user_a", "user_b", "user_c"]));
  });

  it("returns an empty set for an empty string", () => {
    expect(parseAllowlist("")).toEqual(new Set());
  });
});

describe("isAllowlisted", () => {
  it("is true for a member and false for a non-member", () => {
    const allowlist = parseAllowlist("user_a");

    expect(isAllowlisted(allowlist, "user_a")).toBe(true);
    expect(isAllowlisted(allowlist, "user_b")).toBe(false);
  });
});

describe("isCacheFresh", () => {
  it("is false when there is no cached entry", () => {
    expect(isCacheFresh(null, 0)).toBe(false);
  });

  it("is true within the TTL window and false once it has elapsed", () => {
    const entry = { version: 1, allowlist: new Set<string>(), checkedAt: 1_000 };

    expect(isCacheFresh(entry, 1_000 + 59_000)).toBe(true);
    expect(isCacheFresh(entry, 1_000 + 60_000)).toBe(false);
  });
});

async function setAllowlistVersion(version: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_control (
      id, run_admission, platform_concurrent_sandbox_cap, workspace_concurrent_sandbox_cap,
      allowlist_version, emergency_control_version, updated_at
    ) VALUES (1, 'open', 50, 3, ?, 1, '2026-09-02T00:00:00.000Z')
    ON CONFLICT (id) DO UPDATE SET allowlist_version = excluded.allowlist_version`,
  )
    .bind(version)
    .run();
}

async function restorePlatformControlRow(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_control (
      id, run_admission, platform_concurrent_sandbox_cap, workspace_concurrent_sandbox_cap,
      allowlist_version, emergency_control_version, updated_at
    ) VALUES (1, 'open', 50, 3, 1, 1, '2026-09-02T00:00:00.000Z')`,
  ).run();
}

describe("readAllowlistVersion", () => {
  beforeEach(async () => {
    await setAllowlistVersion(7);
  });

  it("reads the seeded version", async () => {
    expect(await readAllowlistVersion(env.DB)).toBe(7);
  });

  it("returns null when the row is missing", async () => {
    await env.DB.prepare("DELETE FROM platform_control WHERE id = 1").run();

    expect(await readAllowlistVersion(env.DB)).toBeNull();

    await restorePlatformControlRow();
  });

  it("returns null when allowlist_version is not a number", async () => {
    const malformedDb = {
      prepare() {
        return {
          async first() {
            return { allowlist_version: "not-a-number" };
          },
        };
      },
    } as unknown as D1Database;

    expect(await readAllowlistVersion(malformedDb)).toBeNull();
  });
});

describe("checkAllowlist", () => {
  beforeEach(async () => {
    await setAllowlistVersion(3);
  });

  // Every hosted deployment starts with the secret unset, so it must deny.
  it("denies everyone when the binding is absent", async () => {
    const cache = createAllowlistCache();

    const decision = await checkAllowlist(env.DB, undefined, cache, 1_000, "user_a");

    expect(decision).toEqual({ kind: "blocked" });
    expect(cache.current).toEqual({ version: 3, allowlist: new Set(), checkedAt: 1_000 });
  });

  it("reads platform_control on a cold cache and allows a listed subject", async () => {
    const cache = createAllowlistCache();

    const decision = await checkAllowlist(env.DB, "user_a,user_b", cache, 1_000, "user_a");

    expect(decision).toEqual({ kind: "allowed" });
    expect(cache.current).toEqual({
      version: 3,
      allowlist: new Set(["user_a", "user_b"]),
      checkedAt: 1_000,
    });
  });

  it("blocks a subject that is not on the list", async () => {
    const cache = createAllowlistCache();

    const decision = await checkAllowlist(env.DB, "user_a", cache, 1_000, "user_x");

    expect(decision).toEqual({ kind: "blocked" });
  });

  it("reuses a fresh cached entry without reading platform_control again", async () => {
    const cache = createAllowlistCache();
    await checkAllowlist(env.DB, "user_a", cache, 1_000, "user_a");
    const poisonedDb = {
      prepare() {
        throw new Error("must not read platform_control while the cache is fresh");
      },
    } as unknown as D1Database;

    const decision = await checkAllowlist(poisonedDb, "user_a", cache, 1_000 + 1_000, "user_a");

    expect(decision).toEqual({ kind: "allowed" });
  });

  it("re-reads platform_control once the cache has gone stale", async () => {
    const cache = createAllowlistCache();
    await checkAllowlist(env.DB, "user_a", cache, 1_000, "user_a");

    const decision = await checkAllowlist(env.DB, "user_b", cache, 1_000 + 60_000, "user_b");

    expect(decision).toEqual({ kind: "allowed" });
    expect(cache.current).not.toBeNull();
    if (cache.current !== null) {
      expect(cache.current.allowlist).toEqual(new Set(["user_b"]));
    }
  });

  it("fails closed and clears the cache when the version cannot be read", async () => {
    await env.DB.prepare("DELETE FROM platform_control WHERE id = 1").run();
    const cache = createAllowlistCache();

    const decision = await checkAllowlist(env.DB, "user_a", cache, 1_000, "user_a");

    expect(decision).toEqual({ kind: "blocked" });
    expect(cache.current).toBeNull();

    await restorePlatformControlRow();
  });
});
