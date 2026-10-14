// Session model tokens (record 06). A token is accepted only by the broker's
// forwarding route and is scoped to one session, sandbox generation,
// connection, and model.
//
// Tokens are signed, not stored. The forward already reads the connection row
// for its ciphertext, and that row carries the status and current generation,
// so revocation takes effect on the next forward with no token table.
//
// `expiresAt` is short and is what a forward checks. `refreshableUntil` is
// copied unchanged into every renewal, so a leaked token is bounded by its
// first issue. `expiresAt` is capped at `refreshableUntil`, so a forward
// checks one clock.

import type { EffortLevel } from "@oncue/protocol";
import { currentKey, currentVersion, type Keyring, keyAt } from "./envelope";
import { isEffortLevel } from "./providers/catalog";

const FORMAT = "ot1";

/** Short enough that a stolen token is stale quickly, long enough not to churn. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** The ceiling a refresh can never push past. */
export const TOKEN_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Everything a token may act on. */
export interface TokenScope {
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly modelId: string;
  /** The run's effort, which the broker writes into every request (effort.ts); `null` for a model with none. */
  readonly effort: EffortLevel | null;
}

export interface TokenClaims extends TokenScope {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly refreshableUntil: number;
}

/** Short keys: the token travels on every model request. */
interface WireClaims {
  readonly sid: string;
  readonly gen: number;
  readonly cid: string;
  readonly wid: string;
  readonly mid: string;
  eff: EffortLevel | null;
  readonly iat: number;
  readonly exp: number;
  readonly rex: number;
}

export type TokenRejection =
  | "malformed"
  | "unknown_key_version"
  | "bad_signature"
  | "expired"
  | "not_refreshable";

export type TokenCheck =
  | { readonly kind: "valid"; readonly claims: TokenClaims }
  | { readonly kind: "rejected"; readonly reason: TokenRejection };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toWire(claims: TokenClaims): WireClaims {
  return {
    sid: claims.sessionId,
    gen: claims.sandboxGeneration,
    cid: claims.connectionId,
    wid: claims.workspaceId,
    mid: claims.modelId,
    eff: claims.effort,
    iat: claims.issuedAt,
    exp: claims.expiresAt,
    rex: claims.refreshableUntil,
  };
}

/**
 * Every field is checked despite the signature, so a token from an older
 * Worker reads as malformed rather than as `undefined` in a comparison.
 */
function fromWire(raw: unknown): TokenClaims | null {
  if (typeof raw !== "object") {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const wire = raw as Record<string, unknown>;
  if (typeof wire.sid !== "string") {
    return null;
  }
  if (typeof wire.gen !== "number") {
    return null;
  }
  if (typeof wire.cid !== "string") {
    return null;
  }
  if (typeof wire.wid !== "string") {
    return null;
  }
  if (typeof wire.mid !== "string") {
    return null;
  }
  if (!(wire.eff === null || isEffortLevel(wire.eff))) {
    return null;
  }
  if (typeof wire.iat !== "number") {
    return null;
  }
  if (typeof wire.exp !== "number") {
    return null;
  }
  if (typeof wire.rex !== "number") {
    return null;
  }
  return {
    sessionId: wire.sid,
    sandboxGeneration: wire.gen,
    connectionId: wire.cid,
    workspaceId: wire.wid,
    modelId: wire.mid,
    effort: wire.eff,
    issuedAt: wire.iat,
    expiresAt: wire.exp,
    refreshableUntil: wire.rex,
  };
}

async function sign(keyring: Keyring<"token">, claims: TokenClaims): Promise<string> {
  const version = currentVersion(keyring);
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(toWire(claims))));
  const signedInput = `${FORMAT}.${version}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    currentKey(keyring),
    new TextEncoder().encode(signedInput) as BufferSource,
  );
  return `${signedInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** A brand new token. The refresh ceiling is set here and never moves again. */
export function mintToken(
  keyring: Keyring<"token">,
  scope: TokenScope,
  now: number,
): Promise<string> {
  const refreshableUntil = now + TOKEN_REFRESH_WINDOW_MS;
  return sign(keyring, {
    ...scope,
    issuedAt: now,
    expiresAt: Math.min(now + TOKEN_TTL_MS, refreshableUntil),
    refreshableUntil,
  });
}

/** The same scope and ceiling with a later expiry; the runtime just sends a new bearer. */
export function renewToken(
  keyring: Keyring<"token">,
  claims: TokenClaims,
  now: number,
): Promise<string> {
  return sign(keyring, {
    sessionId: claims.sessionId,
    sandboxGeneration: claims.sandboxGeneration,
    connectionId: claims.connectionId,
    workspaceId: claims.workspaceId,
    modelId: claims.modelId,
    effort: claims.effort,
    issuedAt: now,
    expiresAt: Math.min(now + TOKEN_TTL_MS, claims.refreshableUntil),
    refreshableUntil: claims.refreshableUntil,
  });
}

/**
 * The signature is verified before the claims are parsed, so only bytes this
 * control plane produced are parsed. The key version sits outside the signed
 * payload; a wrong one fails the verify.
 */
async function readSigned(keyring: Keyring<"token">, token: string): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 4) {
    return { kind: "rejected", reason: "malformed" };
  }
  const [format, version, payload, signatureText] = parts as [string, string, string, string];
  if (format !== FORMAT) {
    return { kind: "rejected", reason: "malformed" };
  }
  const key = keyAt(keyring, version);
  if (key === null) {
    return { kind: "rejected", reason: "unknown_key_version" };
  }
  const signature = decodeBase64Url(signatureText);
  if (signature === null) {
    return { kind: "rejected", reason: "malformed" };
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    new TextEncoder().encode(`${FORMAT}.${version}.${payload}`) as BufferSource,
  );
  if (!verified) {
    return { kind: "rejected", reason: "bad_signature" };
  }
  const claimsBytes = decodeBase64Url(payload);
  if (claimsBytes === null) {
    return { kind: "rejected", reason: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(claimsBytes));
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }
  const claims = fromWire(parsed);
  if (claims === null) {
    return { kind: "rejected", reason: "malformed" };
  }
  return { kind: "valid", claims };
}

/** One clock: `mintToken` caps the expiry at the refresh ceiling. */
export async function checkForForward(
  keyring: Keyring<"token">,
  token: string,
  now: number,
): Promise<TokenCheck> {
  const signed = await readSigned(keyring, token);
  if (signed.kind === "rejected") {
    return signed;
  }
  if (now >= signed.claims.expiresAt) {
    return { kind: "rejected", reason: "expired" };
  }
  return signed;
}

/** An expired token is the normal input here; only the fixed ceiling cannot be passed. */
export async function checkForRefresh(
  keyring: Keyring<"token">,
  token: string,
  now: number,
): Promise<TokenCheck> {
  const signed = await readSigned(keyring, token);
  if (signed.kind === "rejected") {
    return signed;
  }
  if (now >= signed.claims.refreshableUntil) {
    return { kind: "rejected", reason: "not_refreshable" };
  }
  return signed;
}
