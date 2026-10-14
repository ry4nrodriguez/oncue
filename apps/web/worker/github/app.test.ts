// Tests drive `createGitHubDouble` for real wire shapes, and the App key is a
// real RSA pair so the JWT is verified with its public key.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createGitHubDouble, type GitHubDouble } from "../test/github-double";
import {
  APP_JWT_BACKDATE_SECONDS,
  APP_JWT_LIFETIME_SECONDS,
  type GitHubAppDeps,
  githubHeaders,
  mintAppJwt,
  mintInstallationToken,
  revokeInstallationToken,
  type TokenNarrowing,
  withInstallationToken,
} from "./app";

const API_ORIGIN = "https://api.github.com";
const APP_ID = "12345";
const NOW_MS = 1_700_000_000_000;
const INSTALLATION_ID = 1001;
const USER_ID = 42;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const OTHER_REPO = { id: 502, fullName: "acme/gadgets", defaultBranch: "main" };

const NARROWING: TokenNarrowing = {
  installationId: INSTALLATION_ID,
  repositoryIds: [REPO.id],
  permissions: { contents: "write" },
};

let privateKeyPem = "";
let publicKey: CryptoKey;

async function generatePrivateKeyPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const byte of der) {
    binary += String.fromCharCode(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

beforeAll(async () => {
  const generated = await generatePrivateKeyPem();
  privateKeyPem = generated.pem;
  publicKey = generated.publicKey;
});

function seededDouble(): GitHubDouble {
  return createGitHubDouble({
    users: [{ id: USER_ID, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue",
        visibleToUserIds: [USER_ID],
      },
    ],
    repositoriesByInstallation: { [INSTALLATION_ID]: [REPO, OTHER_REPO] },
  });
}

function depsFor(fetchImpl: typeof fetch, overrides: Partial<GitHubAppDeps> = {}): GitHubAppDeps {
  return {
    fetchImpl,
    apiOrigin: API_ORIGIN,
    appId: APP_ID,
    privateKeyPem,
    now: () => NOW_MS,
    ...overrides,
  };
}

// Routes one matching request to `respond` and the rest to the double, to
// force a failure on exactly one call.
function interceptFetch(
  base: typeof fetch,
  matches: (method: string, path: string) => boolean,
  respond: () => Promise<Response>,
): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (matches(method, new URL(url).pathname)) {
      return respond();
    }
    return base(input, init);
  };
}

const connectionReset = (): Promise<Response> => Promise.reject(new Error("connection reset"));

function decodeBase64Url(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
}

describe("mintAppJwt", () => {
  it("signs an RS256 JWT whose header, claims, and signature all check out against the public key", async () => {
    const outcome = await mintAppJwt(depsFor(seededDouble().fetchImpl));
    expect(outcome.kind).toBe("signed");
    if (outcome.kind !== "signed") {
      return;
    }

    const [header, payload, signature] = outcome.jwt.split(".") as [string, string, string];
    expect(decodeJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const nowSeconds = Math.floor(NOW_MS / 1000);
    expect(decodeJson(payload)).toEqual({
      iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
      exp: nowSeconds + APP_JWT_LIFETIME_SECONDS,
      iss: APP_ID,
    });
    expect(APP_JWT_LIFETIME_SECONDS).toBeLessThan(10 * 60);

    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  it("does not verify under a different key, so the signature is doing real work", async () => {
    const outcome = await mintAppJwt(depsFor(seededDouble().fetchImpl));
    if (outcome.kind !== "signed") {
      throw new Error("expected a signed JWT");
    }
    const other = await generatePrivateKeyPem();
    const [header, payload, signature] = outcome.jwt.split(".") as [string, string, string];
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      other.publicKey,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(false);
  });

  it.each([
    [
      "a PKCS#1 key, which carries a different BEGIN marker",
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
    ],
    ["a PEM with a BEGIN marker and no END marker", "-----BEGIN PRIVATE KEY-----\nAAAA\n"],
    [
      "a PEM whose body is not base64",
      "-----BEGIN PRIVATE KEY-----\n!!!not base64!!!\n-----END PRIVATE KEY-----\n",
    ],
    [
      "a PEM whose body is base64 but not a PKCS#8 key",
      `-----BEGIN PRIVATE KEY-----\n${btoa("definitely not a key")}\n-----END PRIVATE KEY-----\n`,
    ],
  ])(
    "refuses %s as private_key_malformed, and the refusal never carries the PEM",
    async (_, pem) => {
      const outcome = await mintAppJwt(depsFor(seededDouble().fetchImpl, { privateKeyPem: pem }));
      expect(outcome).toEqual({ kind: "refused", reason: "private_key_malformed" });
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE KEY");
    },
  );
});

describe("githubHeaders", () => {
  it("carries the bearer, the API version, the JSON accept, and a user-agent GitHub insists on", () => {
    const headers = githubHeaders("abc");
    expect(headers.get("authorization")).toBe("Bearer abc");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("oncue");
  });
});

describe("mintInstallationToken", () => {
  it("refuses an empty repository list before any request exists", async () => {
    const double = seededDouble();
    const outcome = await mintInstallationToken(depsFor(double.fetchImpl), {
      ...NARROWING,
      repositoryIds: [],
    });
    expect(outcome).toEqual({ kind: "refused", reason: "empty_repository_list" });
    expect(double.calls).toHaveLength(0);
  });

  it("mints a token, and the double recorded exactly the narrowing it was asked for", async () => {
    const double = seededDouble();
    const outcome = await mintInstallationToken(depsFor(double.fetchImpl), NARROWING);
    expect(outcome.kind).toBe("minted");
    if (outcome.kind !== "minted") {
      return;
    }
    expect(outcome.token).toMatch(/^ghs_/);

    expect(double.calls).toHaveLength(1);
    const call = double.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(call?.hadAuthorization).toBe(true);
    expect(call?.tokenNarrowing).toEqual({
      repositoryIds: [REPO.id],
      permissions: { contents: "write" },
    });
  });

  it("refuses when the private key is malformed, without reaching the network", async () => {
    const double = seededDouble();
    const outcome = await mintInstallationToken(
      depsFor(double.fetchImpl, { privateKeyPem: "not a pem" }),
      NARROWING,
    );
    expect(outcome).toEqual({ kind: "refused", reason: "private_key_malformed" });
    expect(double.calls).toHaveLength(0);
  });

  it("reports GitHub's rejection as a category and a status, never a body", async () => {
    const double = seededDouble();
    double.setMode("token_mint_fails");
    const outcome = await mintInstallationToken(depsFor(double.fetchImpl), NARROWING);
    expect(outcome).toEqual({ kind: "failed", category: "rejected", status: 401 });
  });

  it("reports a fetch that rejects as unreachable with no status", async () => {
    const double = seededDouble();
    const fetchImpl = interceptFetch(
      double.fetchImpl,
      (method) => method === "POST",
      connectionReset,
    );
    const outcome = await mintInstallationToken(depsFor(fetchImpl), NARROWING);
    expect(outcome).toEqual({ kind: "failed", category: "unreachable", status: null });
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["a JSON array", "[]"],
    ["an object with no token", "{}"],
  ])("reports a 201 carrying %s as malformed_response", async (_, body) => {
    const double = seededDouble();
    const fetchImpl = interceptFetch(
      double.fetchImpl,
      (method) => method === "POST",
      async () => new Response(body, { status: 201 }),
    );
    const outcome = await mintInstallationToken(depsFor(fetchImpl), NARROWING);
    expect(outcome).toEqual({ kind: "failed", category: "malformed_response", status: 201 });
  });
});

describe("revokeInstallationToken", () => {
  it("revokes a minted token, and neither the verdict nor the double's record carries it", async () => {
    const double = seededDouble();
    const deps = depsFor(double.fetchImpl);
    const minted = await mintInstallationToken(deps, NARROWING);
    if (minted.kind !== "minted") {
      throw new Error("expected a minted token");
    }
    const verdict = await revokeInstallationToken(deps, minted.token);
    expect(verdict).toEqual({ kind: "revoked" });

    const revocation = double.calls.at(-1);
    expect(revocation?.method).toBe("DELETE");
    expect(revocation?.path).toBe("/installation/token");
    expect(revocation?.tokenRevoked).toBe(true);
    expect(JSON.stringify(double.calls)).not.toContain(minted.token);
    expect(JSON.stringify(verdict)).not.toContain(minted.token);
  });

  it("reports a rejected revocation as a category and a status", async () => {
    const double = seededDouble();
    double.setMode("revoke_fails");
    const verdict = await revokeInstallationToken(depsFor(double.fetchImpl), "ghs_whatever");
    expect(verdict).toEqual({ kind: "failed", category: "rejected", status: 401 });
  });

  it("reports a fetch that rejects as unreachable", async () => {
    const double = seededDouble();
    const fetchImpl = interceptFetch(
      double.fetchImpl,
      (method) => method === "DELETE",
      connectionReset,
    );
    const verdict = await revokeInstallationToken(depsFor(fetchImpl), "ghs_whatever");
    expect(verdict).toEqual({ kind: "failed", category: "unreachable", status: null });
  });
});

describe("withInstallationToken", () => {
  it("hands the token to work, returns work's result with the revocation verdict, and revokes", async () => {
    const double = seededDouble();
    let seen = "";
    const outcome = await withInstallationToken(
      depsFor(double.fetchImpl),
      NARROWING,
      async (token) => {
        seen = token;
        return { answer: 42 };
      },
    );
    expect(seen).toMatch(/^ghs_/);
    expect(outcome).toEqual({
      kind: "ran",
      result: { answer: 42 },
      revocation: { kind: "revoked" },
    });
    expect(JSON.stringify(outcome)).not.toContain(seen);

    const revocation = double.calls.at(-1);
    expect(revocation?.tokenRevoked).toBe(true);
  });

  it("returns not_minted, and never runs work, when the mint is refused", async () => {
    const double = seededDouble();
    const work = vi.fn(async () => "never");
    const outcome = await withInstallationToken(
      depsFor(double.fetchImpl),
      { ...NARROWING, repositoryIds: [] },
      work,
    );
    expect(outcome).toEqual({
      kind: "not_minted",
      failure: { kind: "refused", reason: "empty_repository_list" },
    });
    expect(work).not.toHaveBeenCalled();
    expect(double.calls).toHaveLength(0);
  });

  it("still revokes when work throws, and then lets the throw continue", async () => {
    const double = seededDouble();
    await expect(
      withInstallationToken(depsFor(double.fetchImpl), NARROWING, async () => {
        throw new Error("work exploded");
      }),
    ).rejects.toThrow("work exploded");

    const revocation = double.calls.at(-1);
    expect(revocation?.method).toBe("DELETE");
    expect(revocation?.tokenRevoked).toBe(true);
  });

  it("reports a failed revocation beside the result rather than hiding it", async () => {
    const double = seededDouble();
    const outcome = await withInstallationToken(depsFor(double.fetchImpl), NARROWING, async () => {
      double.setMode("revoke_fails");
      return "done";
    });
    expect(outcome).toEqual({
      kind: "ran",
      result: "done",
      revocation: { kind: "failed", category: "rejected", status: 401 },
    });
  });
});
