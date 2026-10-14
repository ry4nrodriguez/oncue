/**
 * GitHub App JWTs and installation tokens (record 07).
 *
 * The App private key becomes a non-extractable, sign-only `CryptoKey` and is
 * never returned, logged, or placed in a result; an installation token reaches
 * only the `work` callback of `withInstallationToken`. Tokens are always
 * narrowed to named repositories and permissions, and revoked in a `finally`.
 */

import { isPlainObject, readStringField } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";

export interface GitHubAppDeps {
  readonly fetchImpl: typeof fetch;
  readonly apiOrigin: string;
  readonly appId: string;
  /** PKCS#8. Read once, imported once per JWT, never copied anywhere. */
  readonly privateKeyPem: string;
  /** Epoch milliseconds, injected so a test owns the clock. */
  readonly now: () => number;
}

// GitHub allows 60 seconds of clock drift on `iat` and caps `exp` at ten
// minutes; backdating fully and stopping a minute short leaves headroom.
export const APP_JWT_BACKDATE_SECONDS = 60;
export const APP_JWT_LIFETIME_SECONDS = 540;

const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Standard base64, not base64url: a PEM body is the former. */
function decodeBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// PKCS#8 only. GitHub downloads App keys as PKCS#1, which WebCrypto cannot
// import, so an unconverted key is refused by its header with a clear reason.
function derFromPem(pem: string): Uint8Array | null {
  const begin = pem.indexOf(PEM_BEGIN);
  if (begin === -1) {
    return null;
  }
  const bodyStart = begin + PEM_BEGIN.length;
  const end = pem.indexOf(PEM_END, bodyStart);
  if (end === -1) {
    return null;
  }
  return decodeBase64(pem.slice(bodyStart, end).replace(/\s+/g, ""));
}

// Non-extractable and sign-only, so nothing later can read the key back.
async function importSigningKey(pem: string): Promise<CryptoKey | null> {
  const der = derFromPem(pem);
  if (der === null) {
    return null;
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return null;
  }
}

export type AppJwtOutcome =
  | { readonly kind: "signed"; readonly jwt: string }
  | { readonly kind: "refused"; readonly reason: "private_key_malformed" };

/** RS256, the only algorithm GitHub accepts for an App JWT. */
export async function mintAppJwt(deps: GitHubAppDeps): Promise<AppJwtOutcome> {
  const key = await importSigningKey(deps.privateKeyPem);
  if (key === null) {
    return { kind: "refused", reason: "private_key_malformed" };
  }
  const nowSeconds = Math.floor(deps.now() / 1000);
  const encoder = new TextEncoder();
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
        exp: nowSeconds + APP_JWT_LIFETIME_SECONDS,
        iss: deps.appId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(signingInput) as BufferSource,
  );
  return { kind: "signed", jwt: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}` };
}

// GitHub answers a request without a `user-agent` with 403, and a Worker's
// `fetch` sets none.
export function githubHeaders(bearer: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("x-github-api-version", "2022-11-28");
  headers.set("user-agent", "oncue");
  return headers;
}

// The one place a GitHub `fetch` may reject: a transport failure becomes
// `null`, which each caller maps to `unreachable`.
export function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  return fetchImpl(url, init).catch(() => null);
}

/** Record 07 step 3: one repository, the minimum permissions, nothing implied. */
export interface TokenNarrowing {
  readonly installationId: number;
  /** Must be non-empty. Empty is refused, because empty means "all". */
  readonly repositoryIds: readonly number[];
  readonly permissions: Readonly<Record<string, "read" | "write">>;
}

export type UpstreamFailureCategory = "unreachable" | "rejected" | "malformed_response";

// `status` is null only for `unreachable`, when GitHub never answered.
export interface UpstreamFailure {
  readonly kind: "failed";
  readonly category: UpstreamFailureCategory;
  readonly status: number | null;
}

export type MintRefusal = "private_key_malformed" | "empty_repository_list";

export type MintFailure =
  | { readonly kind: "refused"; readonly reason: MintRefusal }
  | UpstreamFailure;

export type MintOutcome = { readonly kind: "minted"; readonly token: string } | MintFailure;

function tokenIn(text: string): string | null {
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    return null;
  }
  if (!isPlainObject(parsed.value)) {
    return null;
  }
  return readStringField(parsed.value, "token");
}

/**
 * GitHub treats an empty `repository_ids` as every repository the
 * installation can see, so an empty list is refused before any request.
 */
export async function mintInstallationToken(
  deps: GitHubAppDeps,
  narrowing: TokenNarrowing,
): Promise<MintOutcome> {
  if (narrowing.repositoryIds.length === 0) {
    return { kind: "refused", reason: "empty_repository_list" };
  }
  const signed = await mintAppJwt(deps);
  if (signed.kind === "refused") {
    return signed;
  }
  const headers = githubHeaders(signed.jwt);
  headers.set("content-type", "application/json");
  const upstream = await githubFetch(
    deps.fetchImpl,
    `${deps.apiOrigin}/app/installations/${narrowing.installationId}/access_tokens`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository_ids: narrowing.repositoryIds,
        permissions: narrowing.permissions,
      }),
    },
  );
  if (upstream === null) {
    return { kind: "failed", category: "unreachable", status: null };
  }
  if (upstream.status !== 201) {
    return { kind: "failed", category: "rejected", status: upstream.status };
  }
  const token = tokenIn(await upstream.text());
  if (token === null) {
    return { kind: "failed", category: "malformed_response", status: upstream.status };
  }
  return { kind: "minted", token };
}

export type RevokeVerdict =
  | { readonly kind: "revoked" }
  | {
      readonly kind: "failed";
      readonly category: "unreachable" | "rejected";
      readonly status: number | null;
    };

// A verdict, never a throw: this runs in a `finally`, where an exception would
// replace whatever `work` was reporting.
export async function revokeInstallationToken(
  deps: GitHubAppDeps,
  token: string,
): Promise<RevokeVerdict> {
  const upstream = await githubFetch(deps.fetchImpl, `${deps.apiOrigin}/installation/token`, {
    method: "DELETE",
    headers: githubHeaders(token),
  });
  if (upstream === null) {
    return { kind: "failed", category: "unreachable", status: null };
  }
  if (upstream.status !== 204) {
    return { kind: "failed", category: "rejected", status: upstream.status };
  }
  return { kind: "revoked" };
}

export type WithTokenOutcome<T> =
  | { readonly kind: "ran"; readonly result: T; readonly revocation: RevokeVerdict }
  | { readonly kind: "not_minted"; readonly failure: MintFailure };

/**
 * Mint, run `work`, revoke. Revocation is in a `finally`, so a throwing `work`
 * still revokes; the verdict is returned so callers can report it.
 */
export async function withInstallationToken<T>(
  deps: GitHubAppDeps,
  narrowing: TokenNarrowing,
  work: (token: string) => Promise<T>,
): Promise<WithTokenOutcome<T>> {
  const minted = await mintInstallationToken(deps, narrowing);
  if (minted.kind !== "minted") {
    return { kind: "not_minted", failure: minted };
  }
  let result: T;
  let revocation: RevokeVerdict;
  try {
    result = await work(minted.token);
  } finally {
    revocation = await revokeInstallationToken(deps, minted.token);
  }
  return { kind: "ran", result, revocation };
}
