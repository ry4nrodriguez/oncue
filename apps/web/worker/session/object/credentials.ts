// Bootstrap credentials, one-time tokens, and the hashing and comparison they
// rely on.

import { deriveKeyring, type KeyringResult } from "../../broker/envelope";
import type { BootstrapCredential } from "./types";

/** Random, handed to the driver, and stored only as a hash, so this object's database cannot open a bridge socket. */
export async function mintBootstrap(): Promise<BootstrapCredential> {
  const credential = mintBootstrapCredential();
  return { credential, sha256: await sha256Hex(credential) };
}

export const newEventId = (): string => crypto.randomUUID();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes, minted once per generation and never stored in the clear. */
export function mintBootstrapCredential(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Four hex characters that keep two sessions' branch names apart (record 07). */
export function hex4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison, as `github/webhooks.ts` does for signatures: the
 * bootstrap credential is probed over the network, and an early return would
 * leak how much of a guess was right through timing.
 */
export function constantTimeEqual(expected: string, presented: string): boolean {
  // Both are SHA-256 hex digests, so the lengths agree; folding them in is free.
  let difference = expected.length ^ presented.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The token keyring, derived once per distinct secret: HKDF plus `importKey`
 * is real cost. Keying by the secret stops one test's entry shadowing another's.
 */
const tokenKeyringCache = new Map<string | undefined, Promise<KeyringResult<"token">>>();

export function cachedTokenKeyring(secret: string | undefined): Promise<KeyringResult<"token">> {
  const cached = tokenKeyringCache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const derived = deriveKeyring(secret, "token");
  tokenKeyringCache.set(secret, derived);
  return derived;
}
