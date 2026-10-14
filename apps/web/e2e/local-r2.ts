/**
 * The tests' way to read the local R2 bucket while the dev server runs, through
 * Miniflare's local explorer (`/cdn-cgi/local/explorer/api/r2/...`), inside the
 * process that owns the bucket, as `local-d1.ts` does for D1.
 */

import { appOrigin } from "./app-origin";

const EXPLORER_PATH = "/cdn-cgi/local/explorer/api/r2/buckets";

interface ExplorerList<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly result_info?: { readonly cursor?: string; readonly is_truncated?: string };
}

async function readJson<T>(response: Response): Promise<ExplorerList<T>> {
  const answer = (await response.json().catch(() => null)) as ExplorerList<T> | null;
  if (!response.ok || answer?.success !== true) {
    throw new Error(`local R2: the explorer answered ${response.status}`);
  }
  return answer;
}

/** The one bucket the dev server binds (`ARTIFACTS`). */
async function bucketUrl(): Promise<string> {
  const base = `${await appOrigin()}${EXPLORER_PATH}`;
  const answer = await readJson<{ buckets?: { name?: string }[] }>(await fetch(base));
  const buckets = answer.result?.buckets ?? [];
  const name = buckets[0]?.name;
  if (buckets.length !== 1 || name === undefined) {
    throw new Error(`local R2: expected one bound bucket, found ${buckets.length}`);
  }
  return `${base}/${encodeURIComponent(name)}`;
}

/** Every key under `prefix`, across pages. */
export async function listR2Keys(prefix: string): Promise<string[]> {
  const url = await bucketUrl();
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ prefix, per_page: "1000" });
    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }
    const answer = await readJson<{ key: string }[]>(await fetch(`${url}/objects?${query}`));
    keys.push(...(answer.result ?? []).map((object) => object.key));
    cursor = answer.result_info?.is_truncated === "true" ? answer.result_info.cursor : undefined;
    if (cursor === undefined) {
      return keys;
    }
  }
}

/** Whether an object is stored under exactly this key. */
export async function r2ObjectExists(key: string): Promise<boolean> {
  const response = await fetch(`${await bucketUrl()}/objects/${encodeURIComponent(key)}`, {
    headers: { "cf-metadata-only": "true" },
  });
  if (response.status === 404) {
    return false;
  }
  await readJson(response);
  return true;
}
