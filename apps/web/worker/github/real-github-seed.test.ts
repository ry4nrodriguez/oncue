// The live helper in `scripts/real-github-seed.ts` writes rows the Worker
// must treat exactly like the install flow's. It is tested here, in the
// Worker's own runtime and D1, against the Worker's own readers.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  dotenvValue,
  lookUpRealRepository,
  NO_USER_TOKEN_MARKER,
  parseRepositoryFlag,
  type RealRepository,
  realGitHubApp,
  realGitHubStatements,
} from "../../scripts/real-github-seed";
import { deriveWorkspaceId } from "../auth/register";
import { encodeBase64Url } from "../base64url";
import { deriveKeyring } from "../broker/envelope";
import { type GitHubAppDeps, mintInstallationToken } from "./app";
import {
  type GitHubInstallDeps,
  INSTALLATION_REVERIFY_INTERVAL_MS,
  USER_TOKEN_REFRESH_MARGIN_MS,
  verifyInstallation,
} from "./install";
import { deriveInstallationRowId, readAuthorizedRepository } from "./store";

const API = "https://api.github.double";
const T0 = Date.parse("2026-10-04T00:00:00.000Z");
const INSTALLATION_ID = 777;
const REPOSITORY_ID = 555;
const LOOKUP_TOKEN = "ghs_lookup_token_never_printed";

async function pkcs8Pem(): Promise<string> {
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
  const body = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** GitHub as the helper sees it: one installation on one repository. */
function fakeGitHub(overrides: { installation?: number; listed?: boolean; revoke?: number } = {}): {
  readonly calls: Call[];
  readonly fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, authorization, body });
    if (method === "GET" && url === `${API}/repos/owner-1/test-repo/installation`) {
      return Response.json(
        { id: INSTALLATION_ID, account: { id: 99, login: "owner-1", type: "User" } },
        { status: overrides.installation ?? 200 },
      );
    }
    if (method === "POST" && url === `${API}/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const repositories =
        overrides.listed === false
          ? []
          : [{ id: REPOSITORY_ID, full_name: "owner-1/test-repo", default_branch: "trunk" }];
      return Response.json({ token: LOOKUP_TOKEN, repositories }, { status: 201 });
    }
    if (method === "DELETE" && url === `${API}/installation/token`) {
      return new Response(null, { status: overrides.revoke ?? 204 });
    }
    throw new Error(`unexpected GitHub call ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function appDeps(fetchImpl: typeof fetch): Promise<GitHubAppDeps> {
  return {
    fetchImpl,
    apiOrigin: API,
    appId: "123",
    privateKeyPem: await pkcs8Pem(),
    now: () => T0,
  };
}

const REPOSITORY = { owner: "owner-1", name: "test-repo" };

describe("lookUpRealRepository", () => {
  it("reads the installation with the App JWT, then the repository from one narrowed mint it revokes", async () => {
    const github = fakeGitHub();
    const found = await lookUpRealRepository(await appDeps(github.fetchImpl), REPOSITORY);

    expect(found).toEqual({
      installationId: INSTALLATION_ID,
      accountId: 99,
      accountLogin: "owner-1",
      accountType: "User",
      repositoryId: REPOSITORY_ID,
      fullName: "owner-1/test-repo",
      defaultBranch: "trunk",
      revoked: true,
    });
    expect(github.calls.map((call) => `${call.method} ${call.url.slice(API.length)}`)).toEqual([
      "GET /repos/owner-1/test-repo/installation",
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      "DELETE /installation/token",
    ]);
    expect(github.calls[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(github.calls[1]?.body).toEqual({
      repositories: ["test-repo"],
      permissions: { metadata: "read" },
    });
    expect(github.calls[2]?.authorization).toBe(`Bearer ${LOOKUP_TOKEN}`);
  });

  it("says the App is not installed when GitHub answers 404, minting nothing", async () => {
    const github = fakeGitHub({ installation: 404 });
    await expect(lookUpRealRepository(await appDeps(github.fetchImpl), REPOSITORY)).rejects.toThrow(
      "the App is not installed on owner-1/test-repo",
    );
    expect(github.calls).toHaveLength(1);
  });

  it("revokes the token even when the repository is missing from the answer, and never names it", async () => {
    const github = fakeGitHub({ listed: false });
    const failure = await lookUpRealRepository(await appDeps(github.fetchImpl), REPOSITORY).catch(
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("does not list owner-1/test-repo");
    expect((failure as Error).message).not.toContain(LOOKUP_TOKEN);
    expect(github.calls.at(-1)?.method).toBe("DELETE");
  });

  it("reports a revocation GitHub refused instead of hiding it", async () => {
    const github = fakeGitHub({ revoke: 500 });
    const found = await lookUpRealRepository(await appDeps(github.fetchImpl), REPOSITORY);
    expect(found.revoked).toBe(false);
  });

  it("refuses a private key the Worker could not import, before any request", async () => {
    const github = fakeGitHub();
    await expect(
      lookUpRealRepository(
        { ...(await appDeps(github.fetchImpl)), privateKeyPem: "not a key" },
        REPOSITORY,
      ),
    ).rejects.toThrow(/PKCS#8/);
    expect(github.calls).toHaveLength(0);
  });
});

describe("the rows realGitHubStatements writes", () => {
  const SUBJECT = "user_real_github_seed";
  const found: RealRepository = {
    installationId: INSTALLATION_ID,
    accountId: 99,
    accountLogin: "owner-1",
    accountType: "User",
    repositoryId: REPOSITORY_ID,
    fullName: "owner-1/test-repo",
    defaultBranch: "trunk",
    revoked: true,
  };

  async function written(): Promise<{
    readonly workspaceId: string;
    readonly installationRowId: string;
    readonly keyringSecret: string;
  }> {
    const keyringSecret = `1:${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const { statements, validUntil } = await realGitHubStatements({
      subject: SUBJECT,
      keyringSecret,
      repository: found,
      nowMs: T0,
      repositoryConnectionId: "rc_real_seed",
    });
    expect(validUntil).toBe(new Date(T0 + INSTALLATION_REVERIFY_INTERVAL_MS).toISOString());
    expect(statements.join("\n")).not.toContain(NO_USER_TOKEN_MARKER);
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    const workspaceId = await deriveWorkspaceId(SUBJECT);
    return {
      workspaceId,
      installationRowId: await deriveInstallationRowId(workspaceId, INSTALLATION_ID),
      keyringSecret,
    };
  }

  async function installDeps(
    keyringSecret: string,
    nowMs: number,
    calls: string[],
  ): Promise<GitHubInstallDeps> {
    const credential = await deriveKeyring(keyringSecret, "credential");
    const token = await deriveKeyring(keyringSecret, "token");
    if (credential.kind !== "ok" || token.kind !== "ok") {
      throw new Error("expected keyrings");
    }
    return {
      db: env.DB,
      credentialKeyring: credential.keyring,
      tokenKeyring: token.keyring,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new Error("no GitHub call is expected");
      }) as typeof fetch,
      apiOrigin: API,
      webOrigin: "https://github.double",
      clientId: "Iv1.test",
      clientSecret: "test",
      release: "test",
      environment: "local",
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
      newId: () => "rc_unused",
    };
  }

  it("resolve as a verified repository under an active installation, as session creation reads them", async () => {
    const { workspaceId } = await written();
    const read = await readAuthorizedRepository(env.DB, workspaceId, "rc_real_seed");
    expect(read.kind === "found" && read.row).toMatchObject({
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: REPOSITORY_ID,
      fullName: "owner-1/test-repo",
      defaultBranch: "trunk",
      status: "verified",
      installationStatus: "active",
      removedAt: null,
    });
  });

  it("pass re-verification from the row alone inside the window, with no GitHub call", async () => {
    const { installationRowId, workspaceId, keyringSecret } = await written();
    const calls: string[] = [];
    const late = T0 + INSTALLATION_REVERIFY_INTERVAL_MS - USER_TOKEN_REFRESH_MARGIN_MS - 1;
    const outcome = await verifyInstallation(
      await installDeps(keyringSecret, late, calls),
      workspaceId,
      installationRowId,
    );
    expect(outcome.kind).toBe("verified");
    expect(calls).toEqual([]);
  });

  it("lapse to unauthorized after the window, still without a GitHub call, and a rerun restores them", async () => {
    const { installationRowId, workspaceId, keyringSecret } = await written();
    const calls: string[] = [];
    const lapsed = T0 + INSTALLATION_REVERIFY_INTERVAL_MS - USER_TOKEN_REFRESH_MARGIN_MS;
    const outcome = await verifyInstallation(
      await installDeps(keyringSecret, lapsed, calls),
      workspaceId,
      installationRowId,
    );
    expect(outcome).toEqual({ kind: "refused", reason: "reverification_required" });
    expect(calls).toEqual([]);
    const status = await env.DB.prepare(
      "SELECT status FROM github_installation WHERE installation_row_id = ?",
    )
      .bind(installationRowId)
      .first<{ status: string }>();
    expect(status?.status).toBe("unauthorized");

    await written();
    const restored = await readAuthorizedRepository(env.DB, workspaceId, "rc_real_seed");
    expect(restored.kind === "found" && restored.row.installationStatus).toBe("active");
  });

  it("give the mint a session's git grant makes exactly the installation and repository GitHub named", async () => {
    const { workspaceId } = await written();
    const read = await readAuthorizedRepository(env.DB, workspaceId, "rc_real_seed");
    if (read.kind !== "found") {
      throw new Error("expected the seeded repository");
    }
    const requests: Call[] = [];
    const minted = await mintInstallationToken(
      await appDeps((async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          url: String(input),
          authorization: null,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ token: "ghs_minted" }, { status: 201 });
      }) as typeof fetch),
      {
        installationId: read.row.githubInstallationId,
        repositoryIds: [read.row.githubRepositoryId],
        permissions: { contents: "read" },
      },
    );
    expect(minted).toEqual({ kind: "minted", token: "ghs_minted" });
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${API}/app/installations/${INSTALLATION_ID}/access_tokens`,
        authorization: null,
        body: { repository_ids: [REPOSITORY_ID], permissions: { contents: "read" } },
      },
    ]);
  });
});

describe("the helper's inputs", () => {
  it("takes a repository only as owner/name", () => {
    expect(parseRepositoryFlag("octo-org/example-repo")).toEqual({
      owner: "octo-org",
      name: "example-repo",
    });
    for (const bad of [undefined, "", "example-repo", "a/b/c", "a/", "/b", "a b/c"]) {
      expect(() => parseRepositoryFlag(bad)).toThrow(/owner\/name/);
    }
  });

  it("reads a quoted dotenv PEM as the Worker does, with its line breaks restored", () => {
    expect(dotenvValue('"line one\\nline two"')).toBe("line one\nline two");
    expect(dotenvValue("plain")).toBe("plain");
    expect(dotenvValue(undefined)).toBeUndefined();
  });

  it("uses the real App only when the composed .dev.vars names the same one", () => {
    const real = new Map([
      ["ONCUE_GITHUB_APP_ID", "123"],
      [
        "ONCUE_GITHUB_APP_PRIVATE_KEY",
        '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"',
      ],
    ]);
    expect(realGitHubApp(real, new Map([["ONCUE_GITHUB_APP_ID", "123"]]))).toEqual({
      appId: "123",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      apiOrigin: "https://api.github.com",
    });
    expect(
      realGitHubApp(
        real,
        new Map([
          ["ONCUE_GITHUB_APP_ID", "123"],
          ["ONCUE_GITHUB_API_ORIGIN", "http://127.0.0.1:6298"],
        ]),
      ).apiOrigin,
    ).toBe("http://127.0.0.1:6298");
    expect(() => realGitHubApp(real, new Map([["ONCUE_GITHUB_APP_ID", "1"]]))).toThrow(
      /does not use the real GitHub App/,
    );
    expect(() => realGitHubApp(new Map(), new Map())).toThrow(/needs the real App/);
  });
});
