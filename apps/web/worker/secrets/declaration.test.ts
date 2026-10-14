import { describe, expect, it } from "vitest";
import {
  type DeclaredSecrets,
  judgeLaunch,
  MAX_PROJECT_FILE_BYTES,
  planDisclosure,
  readDeclaredSecrets,
} from "./declaration";

const API = "https://api.github.double";
const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";

const FILE = [
  "version: 1",
  "secrets:",
  "  required:",
  "    - DATABASE_URL",
  "  optional:",
  "    - STRIPE_TEST_KEY",
].join("\n");

/** Standard base64 in 60-character lines, as GitHub's contents API sends it. */
function githubBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return (btoa(binary).match(/.{1,60}/g) ?? []).join("\n");
}

function contentsBody(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "file",
    encoding: "base64",
    size: new TextEncoder().encode(text).byteLength,
    content: githubBase64(text),
    ...overrides,
  };
}

function answering(response: () => Response | Promise<Response>) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return response();
  }) as typeof fetch;
  return { deps: { fetchImpl, apiOrigin: API }, seen };
}

describe("readDeclaredSecrets", () => {
  it("reads the file at the exact commit, under the token it was handed", async () => {
    const { deps, seen } = answering(() => Response.json(contentsBody(FILE)));

    expect(await readDeclaredSecrets(deps, "tok_fake", "acme/widgets", SHA)).toEqual({
      kind: "declared",
      secrets: { required: ["DATABASE_URL"], optional: ["STRIPE_TEST_KEY"] },
    });
    expect(seen).toEqual([
      {
        url: `${API}/repos/acme/widgets/contents/.oncue/project.yaml?ref=${SHA}`,
        authorization: "Bearer tok_fake",
      },
    ]);
  });

  it("reads a file with characters base64 spells with + and /", async () => {
    const text = `${FILE}\n# ~~~ÿÿÿ>>>???`;
    const { deps } = answering(() => Response.json(contentsBody(text)));
    expect((await readDeclaredSecrets(deps, "t", "acme/widgets", SHA)).kind).toBe("declared");
  });

  it.each([
    ["no project file", () => new Response("", { status: 404 })],
    ["a file with no secrets block", () => Response.json(contentsBody("version: 1"))],
    [
      "an empty secrets block",
      () => Response.json(contentsBody("secrets:\n  required:\n  optional:\n")),
    ],
  ])("reads %s as declaring nothing", async (_label, response) => {
    const { deps } = answering(response);
    expect(await readDeclaredSecrets(deps, "t", "acme/widgets", SHA)).toEqual({ kind: "none" });
  });

  it("reports a file the reader refuses with its line and reason, and supplies no names", async () => {
    const { deps } = answering(() =>
      Response.json(contentsBody("secrets:\n  required:\n    - GITHUB_TOKEN")),
    );
    expect(await readDeclaredSecrets(deps, "t", "acme/widgets", SHA)).toEqual({
      kind: "invalid",
      line: 3,
      reason: '"GITHUB_TOKEN" is a platform credential',
    });
  });

  it.each([
    [
      "an unreachable GitHub",
      () => {
        throw new Error("offline");
      },
      "unreachable",
    ],
    ["a 403", () => new Response("", { status: 403 }), "rejected"],
    ["a 500", () => new Response("", { status: 500 }), "rejected"],
    [
      "a body that is not JSON",
      () => new Response("<html>", { status: 200 }),
      "malformed_response",
    ],
    ["a JSON scalar", () => Response.json("nope"), "malformed_response"],
    ["a directory at that path", () => Response.json([{ type: "file" }]), "not_a_file"],
    ["a symlink", () => Response.json(contentsBody(FILE, { type: "symlink" })), "not_a_file"],
    ["a submodule", () => Response.json(contentsBody(FILE, { type: "submodule" })), "not_a_file"],
    [
      "a file over the cap by its size field",
      () => Response.json(contentsBody(FILE, { size: MAX_PROJECT_FILE_BYTES + 1 })),
      "too_large",
    ],
    ["no size field", () => Response.json(contentsBody(FILE, { size: "6" })), "too_large"],
    [
      "content larger than its size field admits",
      () =>
        Response.json(contentsBody(FILE, { content: "A".repeat(MAX_PROJECT_FILE_BYTES * 2 + 4) })),
      "too_large",
    ],
    [
      "another encoding",
      () => Response.json(contentsBody(FILE, { encoding: "none", content: "" })),
      "malformed_response",
    ],
    ["no content", () => Response.json(contentsBody(FILE, { content: 7 })), "malformed_response"],
    [
      "content that is not base64",
      () => Response.json(contentsBody(FILE, { content: "!!!not base64!!!" })),
      "malformed_response",
    ],
    [
      "bytes that are not UTF-8",
      () => Response.json(contentsBody(FILE, { content: btoa("\xff\xfe\xfd") })),
      "malformed_response",
    ],
  ])("reports %s as unreadable, never as declaring nothing", async (_label, response, category) => {
    const { deps } = answering(response as () => Response);
    expect(await readDeclaredSecrets(deps, "t", "acme/widgets", SHA)).toEqual({
      kind: "unreadable",
      category,
    });
  });
});

const DECLARED: DeclaredSecrets = {
  required: ["DATABASE_URL", "REDIS_URL"],
  optional: ["STRIPE_TEST_KEY", "SENTRY_DSN"],
};

describe("planDisclosure", () => {
  it("groups by the declaration and marks what is saved and what is new since the last launch", () => {
    expect(
      planDisclosure(DECLARED, ["DATABASE_URL", "SENTRY_DSN", "UNRELATED"], ["DATABASE_URL"]),
    ).toEqual({
      required: [
        { name: "DATABASE_URL", saved: true, isNew: false },
        { name: "REDIS_URL", saved: false, isNew: true },
      ],
      optional: [
        { name: "STRIPE_TEST_KEY", saved: false, isNew: true },
        { name: "SENTRY_DSN", saved: true, isNew: true },
      ],
    });
  });

  it("marks nothing new on a repository's first launch", () => {
    const disclosure = planDisclosure(DECLARED, [], null);
    expect([...disclosure.required, ...disclosure.optional].some((entry) => entry.isNew)).toBe(
      false,
    );
  });
});

describe("judgeLaunch", () => {
  const saved = ["DATABASE_URL", "REDIS_URL", "STRIPE_TEST_KEY"];

  it("launches a repository that declares nothing, selection or not", () => {
    expect(judgeLaunch(null, [], null)).toEqual({
      kind: "launch",
      pinned: [],
      missingRequired: [],
    });
  });

  it("refuses a repository that declares anything until the card was answered", () => {
    expect(judgeLaunch(DECLARED, saved, null)).toEqual({
      kind: "refuse",
      reason: "disclosure_required",
    });
  });

  it("pins every declared name, selecting saved required ones and only the optional ones ticked", () => {
    expect(
      judgeLaunch(DECLARED, saved, { optional: ["STRIPE_TEST_KEY"], startWithoutMissing: false }),
    ).toEqual({
      kind: "launch",
      pinned: [
        { name: "DATABASE_URL", kind: "required", selected: true },
        { name: "REDIS_URL", kind: "required", selected: true },
        { name: "STRIPE_TEST_KEY", kind: "optional", selected: true },
        { name: "SENTRY_DSN", kind: "optional", selected: false },
      ],
      missingRequired: [],
    });
  });

  it("refuses a ticked name the file does not declare optional, a required one included", () => {
    for (const name of ["DEPLOY_KEY", "DATABASE_URL"]) {
      expect(
        judgeLaunch(DECLARED, [...saved, "DEPLOY_KEY"], {
          optional: [name],
          startWithoutMissing: false,
        }),
      ).toEqual({ kind: "refuse", reason: "undeclared_name" });
    }
  });

  it("refuses a ticked name with nothing saved", () => {
    expect(
      judgeLaunch(DECLARED, saved, { optional: ["SENTRY_DSN"], startWithoutMissing: false }),
    ).toEqual({ kind: "refuse", reason: "unsaved_name" });
  });

  it("needs an explicit start-anyway when a required name is missing, and then records which", () => {
    const missing = ["DATABASE_URL"];
    expect(judgeLaunch(DECLARED, missing, { optional: [], startWithoutMissing: false })).toEqual({
      kind: "refuse",
      reason: "missing_required",
    });
    expect(judgeLaunch(DECLARED, missing, { optional: [], startWithoutMissing: true })).toEqual({
      kind: "launch",
      pinned: [
        { name: "DATABASE_URL", kind: "required", selected: true },
        { name: "REDIS_URL", kind: "required", selected: false },
        { name: "STRIPE_TEST_KEY", kind: "optional", selected: false },
        { name: "SENTRY_DSN", kind: "optional", selected: false },
      ],
      missingRequired: ["REDIS_URL"],
    });
  });
});
