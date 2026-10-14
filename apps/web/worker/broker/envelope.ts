// The encrypted credential envelope (record 06). Only `openCredential` turns a
// sealed value back into plaintext, and its callers (`forward.ts`,
// `worker/github/install.ts`, `worker/modal/connections.ts`,
// `worker/secrets/store.ts`) are kept few enough to audit by their imports.
//
// `ONCUE_BROKER_KEYRING="2:<base64url 32 bytes>,1:<base64url 32 bytes>"`, newest
// first: the first entry seals and any entry opens what names it, so rotation
// is a prepend. HKDF derives a separate key per purpose, and `Keyring<P>` is
// branded so mixing purposes is a compile error. AES-GCM binds
// `connectionId|workspaceId|provider` as additional data, so a ciphertext
// moved to another row fails even if the authorization query has a bug.

const FORMAT = "oncue1";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export type KeyringPurpose = "credential" | "token";

declare const keyringBrand: unique symbol;

export type Keyring<P extends KeyringPurpose> = {
  readonly [keyringBrand]: P;
};

type ConcreteKeyring<P extends KeyringPurpose> = Keyring<P> & {
  readonly currentVersion: string;
  /** Held directly, since a lookup in `keys` would add an unreachable absent arm. */
  readonly currentKey: CryptoKey;
  readonly keys: ReadonlyMap<string, CryptoKey>;
};

export type KeyringResult<P extends KeyringPurpose> =
  | { readonly kind: "ok"; readonly keyring: Keyring<P> }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "malformed"; readonly detail: string };

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

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Keys are derived, never the raw bytes, so one purpose's compromise does not
 * yield the other. The version is in the info string too, so reused bytes
 * never derive the same key twice.
 */
async function deriveKey(
  raw: Uint8Array,
  purpose: KeyringPurpose,
  version: string,
): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`oncue-broker/${purpose}/v${version}`),
    },
    source,
    256,
  );
  if (purpose === "credential") {
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

type ParsedEntry =
  | { readonly kind: "ok"; readonly version: string; readonly raw: Uint8Array }
  | { readonly kind: "malformed"; readonly detail: string };

// Early returns rather than a chained condition keep every branch reachable by
// a table test.
function parseEntry(entry: string): ParsedEntry {
  const separator = entry.indexOf(":");
  if (separator === -1) {
    return { kind: "malformed", detail: "an entry is not version:key" };
  }
  const version = entry.slice(0, separator).trim();
  if (version.length === 0) {
    return { kind: "malformed", detail: "an entry has no version" };
  }
  const raw = decodeBase64Url(entry.slice(separator + 1).trim());
  if (raw === null) {
    return { kind: "malformed", detail: "a key is not base64url" };
  }
  if (raw.length !== KEY_BYTES) {
    return { kind: "malformed", detail: "a key is not 32 bytes" };
  }
  return { kind: "ok", version, raw };
}

/**
 * The head is sliced on `indexOf` rather than read as `split(",")[0]`, which
 * would add an unreachable `undefined` arm under `noUncheckedIndexedAccess`.
 */
export async function deriveKeyring<P extends KeyringPurpose>(
  secret: string | undefined,
  purpose: P,
): Promise<KeyringResult<P>> {
  if (secret === undefined) {
    return { kind: "unconfigured" };
  }
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return { kind: "unconfigured" };
  }

  const firstComma = trimmed.indexOf(",");
  const headText = firstComma === -1 ? trimmed : trimmed.slice(0, firstComma);
  const head = parseEntry(headText);
  if (head.kind === "malformed") {
    return { kind: "malformed", detail: head.detail };
  }

  const currentKey = await deriveKey(head.raw, purpose, head.version);
  const keys = new Map<string, CryptoKey>([[head.version, currentKey]]);

  // `"".split(",")` is `[""]`, so a keyring with no tail skips the loop.
  const tailEntries = firstComma === -1 ? [] : trimmed.slice(firstComma + 1).split(",");
  for (const entry of tailEntries) {
    if (entry.trim().length === 0) {
      return { kind: "malformed", detail: "an entry is empty" };
    }
    const parsed = parseEntry(entry);
    if (parsed.kind === "malformed") {
      return { kind: "malformed", detail: parsed.detail };
    }
    if (keys.has(parsed.version)) {
      return { kind: "malformed", detail: "a version appears twice" };
    }
    keys.set(parsed.version, await deriveKey(parsed.raw, purpose, parsed.version));
  }

  return {
    kind: "ok",
    // The brand is a phantom `unique symbol`, so only this cast can mint a
    // Keyring, and this is its only producer.
    keyring: { currentVersion: head.version, currentKey, keys } as unknown as ConcreteKeyring<P>,
  };
}

/** The version new values are sealed and signed under. */
export function currentVersion<P extends KeyringPurpose>(keyring: Keyring<P>): string {
  return (keyring as ConcreteKeyring<P>).currentVersion;
}

/** Branch-free: a `keyAt` lookup would add an unreachable null arm. */
export function currentKey<P extends KeyringPurpose>(keyring: Keyring<P>): CryptoKey {
  return (keyring as ConcreteKeyring<P>).currentKey;
}

/** `null` when a value names a version this deployment no longer carries. */
export function keyAt<P extends KeyringPurpose>(
  keyring: Keyring<P>,
  version: string,
): CryptoKey | null {
  return (keyring as ConcreteKeyring<P>).keys.get(version) ?? null;
}

/** The row a credential belongs to. Bound into the AEAD tag, never into the ciphertext. */
export interface CredentialContext {
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly provider: string;
}

function additionalData(context: CredentialContext): Uint8Array {
  return new TextEncoder().encode(
    `${context.connectionId}|${context.workspaceId}|${context.provider}`,
  );
}

/**
 * `oncue1.<version>.<nonce>.<ciphertext+tag>`, all base64url. The format tag
 * keeps a future format from being misparsed, and the version travels with the
 * value.
 */
export async function sealCredential(
  keyring: Keyring<"credential">,
  context: CredentialContext,
  plaintext: string,
): Promise<string> {
  const concrete = keyring as ConcreteKeyring<"credential">;
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: additionalData(context) as BufferSource,
    },
    concrete.currentKey,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return `${FORMAT}.${concrete.currentVersion}.${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(sealed))}`;
}

export type OpenResult =
  | { readonly kind: "ok"; readonly plaintext: string }
  | { readonly kind: "malformed" }
  | { readonly kind: "unknown_key_version"; readonly version: string }
  | { readonly kind: "tampered" };

/**
 * The one function that produces a plaintext credential; callers hold it for
 * one operation and never store it. A wrong key, a flipped byte, and another
 * row's ciphertext all read as `tampered`: AES-GCM cannot tell them apart.
 */
export async function openCredential(
  keyring: Keyring<"credential">,
  context: CredentialContext,
  sealed: string,
): Promise<OpenResult> {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    return { kind: "malformed" };
  }
  const [format, version, nonceText, cipherText] = parts as [string, string, string, string];
  if (format !== FORMAT) {
    return { kind: "malformed" };
  }
  const nonce = decodeBase64Url(nonceText);
  if (nonce === null) {
    return { kind: "malformed" };
  }
  const cipher = decodeBase64Url(cipherText);
  if (cipher === null) {
    return { kind: "malformed" };
  }
  const key = keyAt(keyring, version);
  if (key === null) {
    return { kind: "unknown_key_version", version };
  }
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: additionalData(context) as BufferSource,
      },
      key,
      cipher as BufferSource,
    );
  } catch {
    return { kind: "tampered" };
  }
  return { kind: "ok", plaintext: new TextDecoder().decode(opened) };
}
