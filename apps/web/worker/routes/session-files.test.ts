import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { createGitHubDouble, githubTestSettings } from "../test/github-double";
import {
  checkRepositoryPath,
  describeFile,
  FILE_KIND_HEADER,
  type FileCache,
  handleSessionFile,
  MAX_PATH_CHARS,
  matchSessionFileRoute,
} from "./session-files";

const ORIGIN = "https://oncue.example";
const NOW = "2026-09-27T00:00:00.000Z";
const TOKENS_EXPIRE = "2099-01-01T00:00:00.000Z";
const OWNER = "user_files_owner";
const STRANGER = "user_files_stranger";
const BASE_SHA = "8beef27000000000000000000000000000000000";
const SESSION = "sess_files_mine";
const THEIR_SESSION = "sess_files_theirs";
const CONNECTION = "rpc_files_mine";
const INSTALLATION_ID = 8801;
const REPOSITORY_ID = 9901;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

type Clerk = Awaited<ReturnType<typeof createClerkDouble>>;

async function seedOwner(
  subject: string,
  connectionId: string,
  sessionId: string,
  installationId: number,
): Promise<void> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  const installation = `ins_${connectionId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference, refresh_token_reference,
         user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      installation,
      workspaceId,
      installationId,
      TOKENS_EXPIRE,
      TOKENS_EXPIRE,
      new Date().toISOString(),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'acme/widgets', 'main', 'verified', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(connectionId, workspaceId, installation, REPOSITORY_ID, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO session_index (
         session_id, workspace_id, state, repository_connection_id, base_commit_sha, created_at, updated_at
       ) VALUES (?, ?, 'active', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(sessionId, workspaceId, connectionId, BASE_SHA, NOW, NOW),
  ]);
}

function github() {
  const double = createGitHubDouble({
    users: [{ id: 42, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [42],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [{ id: REPOSITORY_ID, fullName: "acme/widgets", defaultBranch: "main" }],
    },
    refsByRepository: { "acme/widgets": { main: BASE_SHA } },
  });
  double.setFile("acme/widgets", "README.md", "# widgets\n", { ref: BASE_SHA });
  double.setFile("acme/widgets", "docs/logo.png", PNG, { ref: BASE_SHA });
  double.setFile("acme/widgets", "bin/tool", new Uint8Array([0, 1, 2, 3]), { ref: BASE_SHA });
  double.setFile("acme/widgets", "data/huge.json", new Uint8Array(1024 * 1024 + 5).fill(0x61), {
    ref: BASE_SHA,
  });
  double.setFile("acme/widgets", "link", "README.md", { ref: BASE_SHA, kind: "symlink" });
  vi.stubGlobal("fetch", double.fetchImpl);
  return double;
}

/** A cache in memory, standing in for the Worker's, so a test can see what it holds. */
function memoryCache() {
  const held = new Map<string, Response>();
  const cache: NonNullable<FileCache> = {
    async match(key) {
      const found = held.get(String(key));
      return found === undefined ? undefined : found.clone();
    },
    async put(key, response) {
      held.set(String(key), response.clone());
    },
  };
  return { cache, held };
}

async function ask(
  clerk: Clerk,
  query: string,
  options: {
    subject?: string | null;
    sessionId?: string;
    overrides?: Record<string, string | undefined>;
    cache?: FileCache;
  } = {},
) {
  const sessionId = options.sessionId ?? SESSION;
  const subject = options.subject === undefined ? OWNER : options.subject;
  const url = `${ORIGIN}/api/sessions/${sessionId}/files${query}`;
  const headers = new Headers();
  if (subject !== null) {
    const authed = await clerk.requestAs(subject, url);
    headers.set("cookie", authed.headers.get("cookie") ?? "");
  }
  return handleSessionFile(
    new Request(url, { headers }),
    {
      ...env,
      CLERK_JWT_KEY: clerk.jwtKey,
      ONCUE_USER_ALLOWLIST: `${OWNER},${STRANGER}`,
      ...(await githubTestSettings()),
      ONCUE_GITHUB_API_ORIGIN: "https://github.double",
      ...options.overrides,
    } as unknown as Env,
    sessionId,
    createAllowlistCache(),
    options.cache === undefined ? null : options.cache,
  );
}

const fileQuery = (path: string, extra = "") => `?path=${encodeURIComponent(path)}${extra}`;

beforeEach(async () => {
  await seedOwner(OWNER, CONNECTION, SESSION, INSTALLATION_ID);
  await seedOwner(STRANGER, "rpc_files_theirs", THEIR_SESSION, INSTALLATION_ID + 1);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.DB.prepare(
    `UPDATE github_installation SET status = 'active', github_installation_id = ?, last_verified_at = ?
      WHERE installation_row_id = ?`,
  )
    .bind(INSTALLATION_ID, new Date().toISOString(), `ins_${CONNECTION}`)
    .run();
  await env.DB.prepare(
    "UPDATE session_index SET repository_connection_id = ?, base_commit_sha = ? WHERE session_id = ?",
  )
    .bind(CONNECTION, BASE_SHA, SESSION)
    .run();
  await env.DB.prepare(
    "UPDATE repository_connection SET removed_at = NULL, status = 'verified' WHERE repository_connection_id = ?",
  )
    .bind(CONNECTION)
    .run();
});

describe("matching", () => {
  it("matches a GET of a session's files, and nothing else", () => {
    expect(matchSessionFileRoute("/api/sessions/sess_1/files", "GET")).toBe("sess_1");
    expect(matchSessionFileRoute("/api/sessions/sess_1/files", "POST")).toBeNull();
    expect(matchSessionFileRoute("/api/sessions/sess_1/files/x", "GET")).toBeNull();
    expect(matchSessionFileRoute("/api/sessions//files", "GET")).toBeNull();
    expect(matchSessionFileRoute("/api/sessions/%E0%A4%A/files", "GET")).toBeNull();
  });
});

describe("checkRepositoryPath", () => {
  it("takes a path as the bridge lists it", () => {
    expect(checkRepositoryPath("src/app.ts")).toEqual({ ok: true, path: "src/app.ts" });
    expect(checkRepositoryPath(".github/workflows/ci.yml")).toEqual({
      ok: true,
      path: ".github/workflows/ci.yml",
    });
    expect(checkRepositoryPath("a/..b/c")).toEqual({ ok: true, path: "a/..b/c" });
  });

  it.each([
    [null, "missing"],
    ["", "missing"],
    ["a".repeat(MAX_PATH_CHARS + 1), "too_long"],
    ["/etc/passwd", "not_a_repository_path"],
    ["src/", "not_a_repository_path"],
    ["src//app.ts", "not_a_repository_path"],
    ["../secrets", "not_a_repository_path"],
    ["src/../../x", "not_a_repository_path"],
    ["./src", "not_a_repository_path"],
    [".git/config", "not_a_repository_path"],
    ["sub/.git/HEAD", "not_a_repository_path"],
    ["src\\app.ts", "not_a_repository_path"],
    ["src/a\u0000b", "not_a_repository_path"],
    ["src/a\nb", "not_a_repository_path"],
  ])("refuses %j as %s", (raw, reason) => {
    expect(checkRepositoryPath(raw)).toEqual({ ok: false, reason });
  });
});

describe("describeFile", () => {
  it("tells text, a raster image, and anything else apart from the bytes", () => {
    expect(describeFile(new TextEncoder().encode("hello\n"), "a.ts")).toEqual({
      kind: "text",
      contentType: "text/plain; charset=utf-8",
    });
    expect(describeFile(new Uint8Array(), "empty")).toMatchObject({ kind: "text" });
    expect(describeFile(PNG, "logo.png")).toEqual({ kind: "image", contentType: "image/png" });
    expect(describeFile(new Uint8Array([0, 1, 2]), "tool")).toEqual({
      kind: "binary",
      contentType: "application/octet-stream",
    });
  });

  it("never serves markup as an image, whatever it is called", () => {
    expect(describeFile(new TextEncoder().encode("<script>x</script>"), "logo.png")).toMatchObject({
      kind: "text",
    });
    expect(
      describeFile(new TextEncoder().encode("<svg onload='x()'></svg>"), "icon.svg"),
    ).toMatchObject({ kind: "text" });
  });
});

describe("authorization", () => {
  it("answers 401 with no session, and the same 403 off the allowlist, for another workspace's session, and for no session", async () => {
    github();
    const clerk = await createClerkDouble();
    expect((await ask(clerk, fileQuery("README.md"), { subject: null })).status).toBe(401);
    expect(
      (
        await ask(clerk, fileQuery("README.md"), {
          overrides: { ONCUE_USER_ALLOWLIST: STRANGER },
        })
      ).status,
    ).toBe(403);
    expect((await ask(clerk, fileQuery("README.md"), { sessionId: THEIR_SESSION })).status).toBe(
      403,
    );
    expect((await ask(clerk, fileQuery("README.md"), { sessionId: "sess_nobody" })).status).toBe(
      403,
    );
  });

  it("refuses a bad path before anything is read from GitHub", async () => {
    const double = github();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_path",
      reason: "not_a_repository_path",
    });
    expect((await ask(clerk, "")).status).toBe(400);
    expect(double.calls).toEqual([]);
  });
});

describe("reading a file at the base commit", () => {
  it("serves text at the session's base commit under a narrowed token it revokes", async () => {
    const double = github();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# widgets\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get(FILE_KIND_HEADER)).toBe("text");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    const read = double.calls.find((call) => call.path.includes("/contents/"));
    expect(read?.path).toBe(`/repos/acme/widgets/contents/README.md`);
    const mint = double.calls.find((call) => call.path.includes("/access_tokens"));
    expect(mint?.tokenNarrowing).toEqual({
      repositoryIds: [REPOSITORY_ID],
      permissions: { contents: "read" },
    });
    expect(double.calls.some((call) => call.tokenRevoked === true)).toBe(true);
  });

  it("serves an image as its real type, inline", async () => {
    github();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("docs/logo.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get(FILE_KIND_HEADER)).toBe("image");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("serves any other binary as an opaque attachment", async () => {
    github();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("bin/tool"));
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get(FILE_KIND_HEADER)).toBe("binary");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="tool"/);
  });

  it("answers 413 with the size for a file too large to preview, and downloads it whole", async () => {
    github();
    const clerk = await createClerkDouble();
    const preview = await ask(clerk, fileQuery("data/huge.json"));
    expect(preview.status).toBe(413);
    expect(await preview.json()).toEqual({ error: "too_large", size: 1024 * 1024 + 5 });

    const download = await ask(clerk, fileQuery("data/huge.json", "&download=1"));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="huge.json"/,
    );
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await download.arrayBuffer()).byteLength).toBe(1024 * 1024 + 5);
  });

  it("answers 404 for a path the commit does not hold and 422 for a link", async () => {
    github();
    const clerk = await createClerkDouble();
    expect((await ask(clerk, fileQuery("nope.txt"))).status).toBe(404);
    expect((await ask(clerk, fileQuery("nope.txt", "&download=1"))).status).toBe(404);
    const link = await ask(clerk, fileQuery("link"));
    expect(link.status).toBe(422);
    expect(await link.json()).toEqual({ error: "not_a_file", type: "symlink" });
  });

  it("answers 413 for a download past its limit", async () => {
    const double = github();
    double.setFile("acme/widgets", "data/enormous.bin", new Uint8Array(20 * 1024 * 1024 + 1), {
      ref: BASE_SHA,
    });
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("data/enormous.bin", "&download=1"));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large_to_download" });
  });

  it("answers from the cache on a second read, after the owner check, and never caches a download", async () => {
    const double = github();
    const clerk = await createClerkDouble();
    const { cache, held } = memoryCache();
    expect(await (await ask(clerk, fileQuery("README.md"), { cache })).text()).toBe("# widgets\n");
    expect([...held.keys()]).toEqual([
      `https://session-files.oncue.invalid/${REPOSITORY_ID}/${BASE_SHA}/README.md`,
    ]);
    const reads = () => double.calls.filter((call) => call.path.includes("/contents/")).length;
    expect(reads()).toBe(1);

    const again = await ask(clerk, fileQuery("README.md"), { cache });
    expect(await again.text()).toBe("# widgets\n");
    expect(again.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(again.headers.get(FILE_KIND_HEADER)).toBe("text");
    expect(reads()).toBe(1);

    // Another workspace asking for its own session never reaches the entry.
    expect(
      (await ask(clerk, fileQuery("README.md"), { sessionId: THEIR_SESSION, cache })).status,
    ).toBe(403);

    await ask(clerk, fileQuery("data/huge.json", "&download=1"), { cache });
    expect(held.size).toBe(1);
  });
});

describe("when there is nothing to read, or GitHub cannot answer", () => {
  function logLines(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("api.session_file.read"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("answers 404 for a session with no repository", async () => {
    github();
    await env.DB.prepare(
      "UPDATE session_index SET repository_connection_id = NULL WHERE session_id = ?",
    )
      .bind(SESSION)
      .run();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_repository" });
  });

  it("answers 404 when the session names a connection that is not the owner's", async () => {
    github();
    await env.DB.prepare(
      "UPDATE session_index SET repository_connection_id = 'rpc_files_theirs' WHERE session_id = ?",
    )
      .bind(SESSION)
      .run();
    const clerk = await createClerkDouble();
    expect((await ask(clerk, fileQuery("README.md"))).status).toBe(404);
  });

  it("says reconnect GitHub for a repository that is no longer connected", async () => {
    github();
    await env.DB.prepare(
      "UPDATE github_installation SET status = 'deleted' WHERE installation_row_id = ?",
    )
      .bind(`ins_${CONNECTION}`)
      .run();
    const spy = vi.spyOn(console, "log");
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "github_reverification_required",
      reason: "not_connected",
    });
    expect(logLines(spy)).toEqual([
      expect.objectContaining({
        result: "reverification_required",
        errorCategory: "repository_not_connected",
        sessionId: SESSION,
      }),
    ]);
  });

  it("says reconnect GitHub when the link needs verifying again, before minting", async () => {
    const double = github();
    await env.DB.prepare(
      "UPDATE github_installation SET last_verified_at = ? WHERE installation_row_id = ?",
    )
      .bind(NOW, `ins_${CONNECTION}`)
      .run();
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "github_reverification_required",
      reason: "reverification_required",
    });
    expect(double.calls.filter((call) => call.path.includes("/access_tokens"))).toEqual([]);
  });

  it("says reconnect GitHub when the installation is gone (a 404 to the mint), and logs it without the path", async () => {
    github();
    await env.DB.prepare(
      "UPDATE github_installation SET github_installation_id = 424242 WHERE installation_row_id = ?",
    )
      .bind(`ins_${CONNECTION}`)
      .run();
    const spy = vi.spyOn(console, "log");
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "github_reverification_required",
      reason: "installation_missing",
    });
    const lines = logLines(spy);
    expect(lines).toEqual([
      expect.objectContaining({
        severity: "warn",
        result: "reverification_required",
        errorCategory: "mint_rejected_404",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("README");
    expect(JSON.stringify(lines)).not.toContain("acme/widgets");
  });

  it("answers 502 when GitHub refuses the mint for another reason", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const spy = vi.spyOn(console, "log");
    const clerk = await createClerkDouble();
    const response = await ask(clerk, fileQuery("README.md"));
    expect(response.status).toBe(502);
    expect(logLines(spy)).toEqual([
      expect.objectContaining({ result: "unreadable", errorCategory: "mint_rejected_500" }),
    ]);
  });

  it("answers 502 when the read itself fails, and logs the category", async () => {
    const double = github();
    const real = double.fetchImpl;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/contents/") ? new Response("", { status: 500 }) : real(input, init),
    );
    const spy = vi.spyOn(console, "log");
    const clerk = await createClerkDouble();
    expect((await ask(clerk, fileQuery("README.md"))).status).toBe(502);
    expect(logLines(spy)).toEqual([
      expect.objectContaining({ result: "unreadable", errorCategory: "file_rejected" }),
    ]);
  });

  it("answers 503 with no GitHub App configured", async () => {
    github();
    const clerk = await createClerkDouble();
    expect(
      (
        await ask(clerk, fileQuery("README.md"), {
          overrides: { ONCUE_GITHUB_APP_PRIVATE_KEY: "" },
        })
      ).status,
    ).toBe(503);
  });
});
