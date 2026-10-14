// The hosted allowlist (record 05): exact Clerk subjects in
// `ONCUE_USER_ALLOWLIST`, comma or newline separated. An isolate re-reads
// `allowlist_version` at most once per 60 seconds, so a revocation reaches
// every isolate within one TTL without a D1 read per request. A version that
// cannot be read fails closed: nobody is allowed.

import { atMostOne } from "../sql";

const ALLOWLIST_CACHE_TTL_MS = 60_000;

export type AllowlistCacheEntry = {
  readonly version: number;
  readonly allowlist: ReadonlySet<string>;
  readonly checkedAt: number;
};

export type AllowlistCache = {
  current: AllowlistCacheEntry | null;
};

export function createAllowlistCache(): AllowlistCache {
  return { current: null };
}

export function isCacheFresh(entry: AllowlistCacheEntry | null, now: number): boolean {
  if (entry === null) {
    return false;
  }
  return now - entry.checkedAt < ALLOWLIST_CACHE_TTL_MS;
}

export function parseAllowlist(raw: string): ReadonlySet<string> {
  const entries = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

export function isAllowlisted(allowlist: ReadonlySet<string>, subject: string): boolean {
  return allowlist.has(subject);
}

type AllowlistVersionRow = {
  readonly allowlist_version: unknown;
};

export async function readAllowlistVersion(db: D1Database): Promise<number | null> {
  const result = await atMostOne<AllowlistVersionRow>(
    db.prepare("SELECT allowlist_version FROM platform_control WHERE id = 1"),
  );
  if (result.kind === "absent") {
    return null;
  }
  if (typeof result.row.allowlist_version !== "number") {
    return null;
  }
  return result.row.allowlist_version;
}

export type AllowlistDecision = { readonly kind: "allowed" } | { readonly kind: "blocked" };

function decideFromAllowlist(allowlist: ReadonlySet<string>, subject: string): AllowlistDecision {
  if (isAllowlisted(allowlist, subject)) {
    return { kind: "allowed" };
  }
  return { kind: "blocked" };
}

/**
 * `rawAllowlist` is `undefined` until the hosted secret is set; an absent list
 * denies everyone.
 */
export async function checkAllowlist(
  db: D1Database,
  rawAllowlist: string | undefined,
  cache: AllowlistCache,
  now: number,
  subject: string,
): Promise<AllowlistDecision> {
  const cached = cache.current;
  if (cached !== null && isCacheFresh(cached, now)) {
    return decideFromAllowlist(cached.allowlist, subject);
  }
  const version = await readAllowlistVersion(db);
  if (version === null) {
    cache.current = null;
    return { kind: "blocked" };
  }
  const allowlist = parseAllowlist(rawAllowlist ?? "");
  cache.current = { version, allowlist, checkedAt: now };
  return decideFromAllowlist(allowlist, subject);
}
