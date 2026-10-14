/**
 * The signed OAuth `state` for a GitHub App installation: the install
 * callback's CSRF defence. The callback is a GitHub-initiated cross-site GET,
 * so the same-origin guard cannot apply; the state proves the flow was started
 * by this control plane for this signed-in user, so a forged callback cannot
 * link an attacker's installation into a victim's workspace.
 *
 * Signed with the existing token keyring rather than stored. A state can be
 * replayed within its window, which is acceptable because GitHub's `code` is
 * single-use and the route checks the workspace. A random nonce makes each
 * state unique per click.
 */

import { decodeBase64Url, encodeBase64Url } from "../base64url";
import { currentKey, currentVersion, type Keyring, keyAt } from "../broker/envelope";

// Not `ghs`, `ghu`, `gho`, or `ghp`: the bundle secret scanner matches GitHub's
// token prefixes, and an install URL must not look like a leaked credential.
const FORMAT = "ois1";

/** Long enough to install an App and pick repositories, short enough that a leaked URL goes stale. */
export const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

const NONCE_BYTES = 16;

export interface InstallStateClaims {
  readonly workspaceId: string;
  readonly userId: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Short keys: this value travels in a URL a user's browser carries to GitHub and back. */
interface WireClaims {
  readonly wid: string;
  readonly uid: string;
  readonly non: string;
  readonly iat: number;
  readonly exp: number;
}

export type InstallStateRejection =
  | "malformed"
  | "unknown_key_version"
  | "bad_signature"
  | "expired";

export type InstallStateCheck =
  | { readonly kind: "valid"; readonly claims: InstallStateClaims }
  | { readonly kind: "rejected"; readonly reason: InstallStateRejection };

// Every field is checked even after the signature: a state minted by an older
// Worker could otherwise reach the workspace comparison as `undefined` and
// read as someone else's.
function fromWire(raw: unknown): InstallStateClaims | null {
  if (typeof raw !== "object") {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const wire = raw as Record<string, unknown>;
  if (typeof wire.wid !== "string") {
    return null;
  }
  if (typeof wire.uid !== "string") {
    return null;
  }
  if (typeof wire.non !== "string") {
    return null;
  }
  if (typeof wire.iat !== "number") {
    return null;
  }
  if (typeof wire.exp !== "number") {
    return null;
  }
  return {
    workspaceId: wire.wid,
    userId: wire.uid,
    nonce: wire.non,
    issuedAt: wire.iat,
    expiresAt: wire.exp,
  };
}

function toWire(claims: InstallStateClaims): WireClaims {
  return {
    wid: claims.workspaceId,
    uid: claims.userId,
    non: claims.nonce,
    iat: claims.issuedAt,
    exp: claims.expiresAt,
  };
}

export interface InstallStateSubject {
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * `ois1.<key version>.<payload>.<signature>`, base64url after the tag. The key
 * version sits outside the signed payload because it chooses the key; naming
 * the wrong one fails verification.
 */
export async function mintInstallState(
  keyring: Keyring<"token">,
  subject: InstallStateSubject,
  now: number,
): Promise<string> {
  const claims: InstallStateClaims = {
    workspaceId: subject.workspaceId,
    userId: subject.userId,
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
    issuedAt: now,
    expiresAt: now + INSTALL_STATE_TTL_MS,
  };
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

/**
 * Verifies the signature before parsing, so `JSON.parse` only sees bytes this
 * control plane produced. Answers only "did we mint this, and is it fresh";
 * the route compares the workspace against its authenticated actor.
 */
export async function checkInstallState(
  keyring: Keyring<"token">,
  state: string,
  now: number,
): Promise<InstallStateCheck> {
  const parts = state.split(".");
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
  if (now >= claims.expiresAt) {
    return { kind: "rejected", reason: "expired" };
  }
  return { kind: "valid", claims };
}
