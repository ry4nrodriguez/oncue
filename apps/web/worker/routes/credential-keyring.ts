/**
 * The credential keyring, derived once per distinct secret because HKDF plus
 * `importKey` is real cost and several routes need it. Keying the cache by
 * the secret lets tests reach the unconfigured and malformed paths.
 */

import { deriveKeyring, type KeyringResult } from "../broker/envelope";

const cache = new Map<string | undefined, Promise<KeyringResult<"credential">>>();

export function cachedCredentialKeyring(
  secret: string | undefined,
): Promise<KeyringResult<"credential">> {
  const cached = cache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveKeyring(secret, "credential");
  cache.set(secret, derived);
  return derived;
}
