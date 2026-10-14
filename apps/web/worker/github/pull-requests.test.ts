// Drives `createGitHubDouble` end to end: a real App JWT, a token minted and
// revoked through the double, and the pull request read back from it.

import { beforeAll, describe, expect, it } from "vitest";
import { createGitHubDouble, type GitHubDouble } from "../test/github-double";
import type { GitHubAppDeps } from "./app";
import {
  cleanDescription,
  cleanTitle,
  openOrUpdateDraft,
  type PullRequestInput,
  pullRequestBody,
  VERIFICATION_END,
  VERIFICATION_START,
  verificationSection,
  withDescription,
  withSection,
} from "./pull-requests";

const INSTALLATION_ID = 9001;
const REPO = { id: 501, fullName: "acme/widgets", defaultBranch: "main" };
const SESSION_URL = "https://oncue.example/sessions/sess_1";

let privateKeyPem = "";

beforeAll(async () => {
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
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
});

function seeded(refs: Readonly<Record<string, string>> = { "oncue/task": "sha-task-1" }) {
  return createGitHubDouble({
    users: [{ id: 42, login: "octocat" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue",
        visibleToUserIds: [42],
      },
    ],
    repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
    refsByRepository: { [REPO.fullName]: { main: "sha-main-1", ...refs } },
  });
}

function depsFor(double: GitHubDouble, fetchImpl: typeof fetch = double.fetchImpl): GitHubAppDeps {
  return {
    fetchImpl,
    apiOrigin: "https://api.github.test",
    appId: "12345",
    privateKeyPem,
    now: () => Date.parse("2026-09-20T00:00:00.000Z"),
  };
}

const section = (headSha = "a".repeat(40)) =>
  verificationSection({
    outcome: "verified",
    checks: [{ name: "test", classification: "required", result: "passed", attempts: 1 }],
    warnings: [],
    sessionUrl: SESSION_URL,
    headSha,
  });

function input(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    installationId: INSTALLATION_ID,
    repositoryId: REPO.id,
    fullName: REPO.fullName,
    headBranch: "oncue/task",
    baseBranch: "main",
    title: "Add a README section",
    summary: "Adds a section describing the test command.",
    rewrite: null,
    sessionUrl: SESSION_URL,
    section: section(),
    existingNumber: null,
    ...overrides,
  };
}

/** Answers `status` and `body` for the first request whose method and path match, and passes the rest through. */
function intercept(
  double: GitHubDouble,
  match: { readonly method: string; readonly path: RegExp },
  answer: () => Response | Promise<never>,
): typeof fetch {
  let used = false;
  return async (request, init) => {
    const url = new URL(typeof request === "string" ? request : request.toString());
    if (!used && (init?.method ?? "GET") === match.method && match.path.test(url.pathname)) {
      used = true;
      return answer();
    }
    return double.fetchImpl(request, init);
  };
}

describe("verificationSection", () => {
  it("says every required check passed, groups the checks, and links the session", () => {
    const text = verificationSection({
      outcome: "verified",
      checks: [
        { name: "setup", classification: "informational", result: "passed", attempts: 1 },
        { name: "test", classification: "required", result: "passed", attempts: 2 },
        { name: "lint", classification: "recommended", result: "failed", attempts: 1 },
      ],
      warnings: [],
      sessionUrl: SESSION_URL,
      headSha: "0123456789abcdef0123",
    });
    expect(text.startsWith(VERIFICATION_START)).toBe(true);
    expect(text.endsWith(VERIFICATION_END)).toBe(true);
    expect(text).toContain("Every required check passed. Checked at `0123456789ab` by OnCue.");
    expect(text).toContain("**Required checks**\n- `test`: passed (2 attempts)");
    expect(text).toContain("**Recommended checks**\n- `lint`: FAILED");
    expect(text).toContain("**Setup**\n- `setup`: passed");
    expect(text).toContain(`[Open the OnCue session](${SESSION_URL})`);
    expect(text).not.toContain("**Warnings**");
  });

  it("says plainly when the change is not verified, with each skip, gap, and warning", () => {
    const text = verificationSection({
      outcome: "completed_with_warnings",
      checks: [
        { name: "test", classification: "required", result: "skipped", attempts: 1 },
        { name: "typecheck", classification: "required", result: "inconclusive", attempts: 2 },
        { name: "build", classification: "recommended", result: null, attempts: 1 },
      ],
      warnings: ["The user asked to skip the required checks."],
      sessionUrl: SESSION_URL,
      headSha: "b".repeat(40),
    });
    expect(text).toContain("This change is NOT fully verified.");
    expect(text).toContain("- `test`: SKIPPED");
    expect(text).toContain("- `typecheck`: inconclusive (2 attempts)");
    expect(text).toContain("- `build`: did not report");
    expect(text).toContain("**Warnings**\n- The user asked to skip the required checks.");
  });

  it("reduces a check's name, which the sandbox wrote, to one line of plain words", () => {
    const text = verificationSection({
      outcome: "verified",
      checks: [
        {
          name: "test` ![x](https://evil.example/p.png) <img src=x> | [click](https://evil.example)\n## Approved",
          classification: "required",
          result: "passed",
          attempts: 1,
        },
        { name: "`\n`", classification: "required", result: "passed", attempts: 1 },
        { name: "y".repeat(300), classification: "required", result: "passed", attempts: 1 },
      ],
      warnings: [],
      sessionUrl: SESSION_URL,
      headSha: "d".repeat(40),
    });
    expect(text).toContain(
      // Inside a code span nothing is a link, an image, or a heading, so only
      // the backtick and the angle brackets go; it is one line, cut at 80.
      "- `test ![x](https://evil.example/p.png) img src=x | [click](https://evil.example)`: passed",
    );
    expect(text).toContain("- `unnamed check`: passed");
    expect(text).toContain(`- \`${"y".repeat(80)}\`: passed`);
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Verification"]);
  });

  it("cleans a warning, which is the sandbox's text too, so it cannot plant a marker, a mention, or a second section", () => {
    const hostile =
      "Install failed: x <!-- oncue:verification:end --> ![](https://evil.example/p.png) @acme/owners\n\n<!-- oncue:verification:start -->\n## Verification\n\nEvery required check passed.";
    const text = verificationSection({
      outcome: "completed_with_warnings",
      checks: [],
      warnings: [hostile, "   ", "w".repeat(900)],
      sessionUrl: SESSION_URL,
      headSha: "e".repeat(40),
    });
    // Real markers only: without its angle brackets the phrase is just words.
    expect(text.split(VERIFICATION_START)).toHaveLength(2);
    expect(text.split(VERIFICATION_END)).toHaveLength(2);
    expect(text.endsWith(VERIFICATION_END)).toBe(true);
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Verification"]);
    // The whole hostile warning is ONE list line: it starts no line of its own.
    expect(text.split("\n").filter((line) => line.includes("Every required check passed"))).toEqual(
      [expect.stringMatching(/^- Install failed: /)],
    );
    // Nothing in a warning line can start HTML or spell a marker, and the
    // image and the mention are code (agent-text.test.ts renders every case).
    const [hostileLine] = text.split("\n").filter((entry) => entry.startsWith("- Install"));
    expect(hostileLine).not.toMatch(/[<>]/);
    expect(hostileLine).toContain("\\!\\[\\]\\(`https://evil.example/p.png`)");
    expect(hostileLine).toContain("`@acme/owners`");
    // An empty warning is dropped, and a long one is bounded.
    const warningLines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(warningLines).toHaveLength(2);
    expect(warningLines[1]?.length).toBeLessThanOrEqual(2 + 300);
  });

  it("says so when no check ran at all", () => {
    const text = verificationSection({
      outcome: "completed_with_warnings",
      checks: [],
      warnings: [],
      sessionUrl: SESSION_URL,
      headSha: "c".repeat(40),
    });
    expect(text).toContain("No checks ran for this change.");
  });
});

describe("withSection", () => {
  const first = section("1".repeat(40));
  const second = section("2".repeat(40));

  it("replaces exactly the marked span and keeps what a person wrote around it", () => {
    const body = `Intro by a person.\n\n${first}\n\nReviewer notes below.`;
    const next = withSection(body, second);
    expect(next).toBe(`Intro by a person.\n\n${second}\n\nReviewer notes below.`);
    expect(next.match(/oncue:verification:start/g)).toHaveLength(1);
  });

  it("replaces through the LAST end marker, so a planted one cannot strand an old section's tail", () => {
    const planted = `${VERIFICATION_START}\nold head\n${VERIFICATION_END} stale tail: Every required check passed.\n${VERIFICATION_END}`;
    const next = withSection(`Intro.\n\n${planted}\n\nNotes.`, second);
    expect(next).toBe(`Intro.\n\n${second}\n\nNotes.`);
    expect(next).not.toContain("stale tail");
  });

  it("appends when a person removed or reordered the markers, deleting nothing", () => {
    expect(withSection("Only my words.", second)).toBe(`Only my words.\n\n${second}`);
    expect(withSection(`${VERIFICATION_START} half`, second)).toBe(
      `${VERIFICATION_START} half\n\n${second}`,
    );
    const reordered = `${VERIFICATION_END} x ${VERIFICATION_START}`;
    expect(withSection(reordered, second)).toBe(`${reordered}\n\n${second}`);
    expect(withSection("  ", second)).toBe(second);
  });
});

describe("cleanDescription and cleanTitle", () => {
  it("keeps the agent's Markdown: headings, lists, links, and code", () => {
    const markdown =
      "## What changed\n\n- Fixed the [redirect](https://example.com/docs).\n\n```ts\nconst a = 1;\n```";
    expect(cleanDescription(markdown)).toBe(markdown);
  });

  it("turns a mention outside code into a code span, and leaves code and addresses alone", () => {
    expect(cleanDescription("Thanks @octocat and @acme/owners, cc (@hubot).")).toBe(
      "Thanks `@octocat` and `@acme/owners`, cc (`@hubot`).",
    );
    expect(cleanDescription("Mail a@b.example; `@decorator` stays.")).toBe(
      "Mail a@b.example; `@decorator` stays.",
    );
    expect(cleanDescription("```\n@Component\n```\n@after")).toBe("```\n@Component\n```\n`@after`");
  });

  it("takes out HTML comments, so no text can forge or hide a marker", () => {
    const cleaned = cleanDescription(`Fine.\n${VERIFICATION_START}\nfake\n${VERIFICATION_END}`);
    expect(cleaned).not.toContain("<!--");
    expect(cleaned).not.toContain("-->");
    expect(cleanTitle(" Fix <!-- x -->\n the  bug ")).toBe("Fix x the bug");
  });
});

describe("withDescription", () => {
  const first = section("1".repeat(40));
  const second = section("2".repeat(40));

  it("replaces the text above the section and the section, keeping what is below it", () => {
    const body = `${pullRequestBody("Old words.", SESSION_URL, first)}\n\nReviewer notes.`;
    expect(withDescription(body, "New words.", SESSION_URL, second)).toBe(
      `${pullRequestBody("New words.", SESSION_URL, second)}\n\nReviewer notes.`,
    );
  });

  it("writes no description over a body whose markers a person removed", () => {
    expect(withDescription("Only my words.", "New words.", SESSION_URL, second)).toBe(
      `Only my words.\n\n${second}`,
    );
  });
});

describe("openOrUpdateDraft", () => {
  it("opens a draft with the summary, the session, and the section, under a narrowed token it revokes", async () => {
    const double = seeded();
    const outcome = await openOrUpdateDraft(depsFor(double), input());
    expect(outcome).toEqual({
      kind: "created",
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      headSha: "sha-task-1",
      draft: true,
      rewritten: false,
      revocation: { kind: "revoked" },
    });
    expect(double.pullRequests[0]).toMatchObject({
      title: "Add a README section",
      head: "oncue/task",
      base: "main",
      draft: true,
      body: pullRequestBody("Adds a section describing the test command.", SESSION_URL, section()),
    });
    const mint = double.calls.find((call) => call.tokenNarrowing !== undefined);
    expect(mint?.tokenNarrowing).toEqual({
      repositoryIds: [REPO.id],
      permissions: { pull_requests: "write", contents: "read" },
    });
    expect(double.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
      tokenRevoked: true,
    });
  });

  it("updates the pull request it owns: the section is replaced, a person's words are kept", async () => {
    const double = seeded();
    await openOrUpdateDraft(depsFor(double), input({ section: section("1".repeat(40)) }));
    const opened = double.pullRequests[0]?.body ?? "";
    double.editPullRequestBody(1, `${opened}\n\nPlease also check the docs. — a reviewer`);
    double.setRef(REPO.fullName, "oncue/task", "sha-task-2");

    const outcome = await openOrUpdateDraft(
      depsFor(double),
      input({ existingNumber: 1, section: section("2".repeat(40)) }),
    );
    expect(outcome).toMatchObject({ kind: "updated", number: 1, headSha: "sha-task-2" });
    const body = double.pullRequests[0]?.body ?? "";
    expect(body).toContain("Checked at `222222222222`");
    expect(body).not.toContain("Checked at `111111111111`");
    expect(body.match(/oncue:verification:start/g)).toHaveLength(1);
    expect(body).toContain("Please also check the docs. — a reviewer");
    expect(double.pullRequests).toHaveLength(1);
  });

  it("rewrites the title and the description when the agent gave new ones, keeping a reviewer's notes", async () => {
    const double = seeded();
    await openOrUpdateDraft(depsFor(double), input({ section: section("1".repeat(40)) }));
    const opened = double.pullRequests[0]?.body ?? "";
    double.editPullRequestBody(1, `${opened}\n\nReviewer notes.`);

    const outcome = await openOrUpdateDraft(
      depsFor(double),
      input({
        existingNumber: 1,
        section: section("2".repeat(40)),
        rewrite: { title: "Document the test command", summary: "## Why\n\nAsked by @octocat." },
      }),
    );
    expect(outcome).toMatchObject({ kind: "updated", rewritten: true });
    const pullRequest = double.pullRequests[0];
    expect(pullRequest?.title).toBe("Document the test command");
    expect(pullRequest?.body).toBe(
      `${pullRequestBody("## Why\n\nAsked by `@octocat`.", SESSION_URL, section("2".repeat(40)))}\n\nReviewer notes.`,
    );
    expect(pullRequest?.body).not.toContain("Adds a section describing");
  });

  it("adopts the open pull request GitHub says already exists for its branch", async () => {
    const double = seeded();
    await openOrUpdateDraft(depsFor(double), input());
    const outcome = await openOrUpdateDraft(
      depsFor(double),
      input({ section: section("3".repeat(40)) }),
    );
    expect(outcome).toMatchObject({ kind: "updated", number: 1 });
    expect(double.pullRequests).toHaveLength(1);
    expect(double.pullRequests[0]?.body).toContain("Checked at `333333333333`");
  });

  describe("on an existing branch the user chose to work on", () => {
    const person = (base: string, head = "oncue/task") => ({
      number: 0,
      fullName: REPO.fullName,
      title: "A person's title",
      head,
      base,
      headSha: "sha-task-1",
      draft: false,
      state: "open" as const,
      body: "Their own words.",
    });
    function withPullRequests(...pulls: ReturnType<typeof person>[]) {
      return createGitHubDouble({
        users: [{ id: 42, login: "octocat" }],
        installations: [
          {
            installationId: INSTALLATION_ID,
            account: { login: "acme", type: "Organization" },
            appSlug: "oncue",
            visibleToUserIds: [42],
          },
        ],
        repositoriesByInstallation: { [INSTALLATION_ID]: [REPO] },
        refsByRepository: {
          [REPO.fullName]: { main: "sha-main-1", develop: "sha-dev-1", "oncue/task": "sha-task-1" },
        },
        pullRequests: pulls.map((pull, index) => ({ ...pull, number: index + 1 })),
      });
    }

    it("adopts the one open pull request for the head, whatever its base, keeping the person's words", async () => {
      const double = withPullRequests(person("develop"));
      const outcome = await openOrUpdateDraft(
        depsFor(double),
        input({
          rewrite: { title: "Agent title", summary: "Agent summary." },
          section: section("4".repeat(40)),
          adoptOpenPullRequest: true,
        }),
      );
      expect(outcome).toMatchObject({ kind: "updated", number: 1, rewritten: false, draft: false });
      expect(double.pullRequests).toHaveLength(1);
      expect(double.pullRequests[0]).toMatchObject({ title: "A person's title", base: "develop" });
      expect(double.pullRequests[0]?.body).toContain("Their own words.");
      expect(double.pullRequests[0]?.body).not.toContain("Agent summary.");
      expect(double.pullRequests[0]?.body).toContain("Checked at `444444444444`");
      // Listed before anything was opened: no POST reached GitHub.
      expect(
        double.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")),
      ).toBe(false);
    });

    it("opens nothing when several open pull requests have the head", async () => {
      const double = withPullRequests(person("develop"), person("main"));
      expect(
        await openOrUpdateDraft(depsFor(double), input({ adoptOpenPullRequest: true })),
      ).toEqual({ kind: "ambiguous", revocation: { kind: "revoked" } });
      expect(double.pullRequests).toHaveLength(2);
    });

    it("opens a draft when the head has none, and fails when GitHub will not list them", async () => {
      const double = withPullRequests(person("main", "elsewhere"));
      expect(
        await openOrUpdateDraft(depsFor(double), input({ adoptOpenPullRequest: true })),
      ).toMatchObject({ kind: "created", number: 2 });

      const listing = intercept(double, { method: "GET", path: /\/pulls$/ }, () =>
        Response.json({ message: "Server Error" }, { status: 500 }),
      );
      expect(
        await openOrUpdateDraft(depsFor(double, listing), input({ adoptOpenPullRequest: true })),
      ).toMatchObject({ kind: "failed", status: null });

      const malformed = intercept(double, { method: "GET", path: /\/pulls$/ }, () =>
        Response.json([{ number: "seven" }], { status: 200 }),
      );
      expect(
        await openOrUpdateDraft(depsFor(double, malformed), input({ adoptOpenPullRequest: true })),
      ).toMatchObject({ kind: "failed", status: null });
    });
  });

  it("opens a second pull request for a head whose only open one targets another base, as GitHub does", async () => {
    const double = seeded({ "oncue/task": "sha-task-1", develop: "sha-dev-1" });
    await openOrUpdateDraft(depsFor(double), input({ baseBranch: "develop" }));
    expect(await openOrUpdateDraft(depsFor(double), input())).toMatchObject({
      kind: "created",
      number: 2,
    });
  });

  it("reports a branch with nothing ahead of its base, and still revokes", async () => {
    const double = seeded({ "oncue/task": "sha-main-1" });
    expect(await openOrUpdateDraft(depsFor(double), input())).toEqual({
      kind: "no_commits",
      revocation: { kind: "revoked" },
    });
    expect(double.pullRequests).toEqual([]);
  });

  it("reports a missing pull-request permission, whether GitHub refuses the token or the call", async () => {
    const atMint = seeded();
    atMint.setMode("pull_requests_not_granted");
    expect(await openOrUpdateDraft(depsFor(atMint), input())).toEqual({
      kind: "permission_missing",
      revocation: null,
    });

    const atCall = seeded();
    const refused = intercept(atCall, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    );
    expect(await openOrUpdateDraft(depsFor(atCall, refused), input())).toMatchObject({
      kind: "permission_missing",
      revocation: { kind: "revoked" },
    });
  });

  it("reports any other refusal with its status, and an unreachable GitHub with none", async () => {
    const double = seeded();
    const broken = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ message: "Server Error" }, { status: 500 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, broken), input())).toMatchObject({
      kind: "failed",
      status: 500,
    });
    const unreachable = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Promise.reject(new Error("network")),
    );
    expect(await openOrUpdateDraft(depsFor(double, unreachable), input())).toMatchObject({
      kind: "failed",
      status: null,
      revocation: { kind: "revoked" },
    });
  });

  it("reports a created answer it cannot read, and a 422 it does not recognise", async () => {
    const double = seeded();
    const unreadable = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ number: "one" }, { status: 201 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, unreadable), input())).toMatchObject({
      kind: "failed",
      status: 201,
    });
    const notJson = intercept(
      double,
      { method: "POST", path: /\/pulls$/ },
      () => new Response("<html>", { status: 201 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, notJson), input())).toMatchObject({
      kind: "failed",
      status: 201,
    });
    const headless = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ number: 1, html_url: "https://x", head: "nope" }, { status: 201 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, headless), input())).toMatchObject({
      kind: "failed",
    });
    const other = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ message: "Validation Failed" }, { status: 422 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, other), input())).toMatchObject({
      kind: "failed",
      status: 422,
    });
  });

  it("falls back to the refusal when GitHub says one exists and lists none", async () => {
    const double = seeded();
    const claims = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json(
        { message: "A pull request already exists for acme:oncue/task." },
        { status: 422 },
      ),
    );
    expect(await openOrUpdateDraft(depsFor(double, claims), input())).toMatchObject({
      kind: "failed",
      status: 422,
    });
  });

  it("falls back to the refusal when the listing is not a list", async () => {
    const double = seeded();
    const claims = intercept(double, { method: "POST", path: /\/pulls$/ }, () =>
      Response.json({ message: "A pull request already exists." }, { status: 422 }),
    );
    const notAList = intercept(
      { ...double, fetchImpl: claims },
      { method: "GET", path: /\/pulls$/ },
      () => Response.json({ message: "Server Error" }, { status: 500 }),
    );
    expect(await openOrUpdateDraft(depsFor(double, notAList), input())).toMatchObject({
      kind: "failed",
      status: 422,
    });
  });

  it("reports an update it cannot read or cannot write", async () => {
    const double = seeded();
    await openOrUpdateDraft(depsFor(double), input());
    expect(await openOrUpdateDraft(depsFor(double), input({ existingNumber: 99 }))).toMatchObject({
      kind: "failed",
      status: 404,
    });
    const patchFails = intercept(double, { method: "PATCH", path: /\/pulls\/1$/ }, () =>
      Response.json({ message: "Server Error" }, { status: 502 }),
    );
    expect(
      await openOrUpdateDraft(depsFor(double, patchFails), input({ existingNumber: 1 })),
    ).toMatchObject({ kind: "failed", status: 502 });
    const bodyless = intercept(double, { method: "GET", path: /\/pulls\/1$/ }, () =>
      Response.json(
        { number: 1, html_url: "https://x", head: { sha: "s" }, body: null },
        { status: 200 },
      ),
    );
    expect(
      await openOrUpdateDraft(depsFor(double, bodyless), input({ existingNumber: 1 })),
    ).toMatchObject({ kind: "updated", draft: true });
    expect(double.pullRequests[0]?.body).toBe(section());
  });

  // Record 07: OnCue never merges, marks ready, closes, or deletes a branch. The
  // only calls are the token's mint and revocation and GET, POST, and a
  // body-only PATCH on `/pulls`.
  it("nothing here can merge, close, mark ready, or delete a branch", async () => {
    const double = seeded();
    const patches: unknown[] = [];
    const recording: typeof fetch = async (request, init) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
      }
      return double.fetchImpl(request, init);
    };
    await openOrUpdateDraft(depsFor(double, recording), input());
    await openOrUpdateDraft(depsFor(double, recording), input({ existingNumber: 1 }));
    await openOrUpdateDraft(depsFor(double, recording), input());

    const calls = double.calls.map((call) => `${call.method} ${call.path}`);
    const allowed =
      /^(POST \/app\/installations\/\d+\/access_tokens|DELETE \/installation\/token|(GET|POST) \/repos\/acme\/widgets\/pulls|(GET|PATCH) \/repos\/acme\/widgets\/pulls\/1)$/;
    expect(calls.filter((call) => !allowed.test(call))).toEqual([]);
    expect(calls.some((call) => /merge|\/git\/refs|\/branches/.test(call))).toBe(false);
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(Object.keys(patch as Record<string, unknown>)).toEqual(["body"]);
    }
    expect(double.pullRequests[0]).toMatchObject({ draft: true, state: "open" });
  });

  it("reports a token that could not be minted for any other reason", async () => {
    const double = seeded();
    double.setMode("token_mint_fails");
    expect(await openOrUpdateDraft(depsFor(double), input())).toEqual({
      kind: "failed",
      status: 401,
      revocation: null,
    });
    expect(
      await openOrUpdateDraft({ ...depsFor(double), privateKeyPem: "not a key" }, input()),
    ).toEqual({ kind: "failed", status: null, revocation: null });
  });
});
