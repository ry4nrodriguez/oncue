import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckpoint } from "./checkpoint";
import {
  applyRestore,
  CHECKPOINT_CONFIG,
  CLONE_TIMEOUT_MS,
  type CloneGrant,
  checkpointArgv,
  checkpointEnv,
  classifyCloneFailure,
  classifyPushFailure,
  clone,
  cloneArgv,
  diffBetween,
  FETCH_TIMEOUT_MS,
  fetchRevoke,
  type GitIo,
  type GitProcessResult,
  gitEnv,
  isExactSessionRef,
  killProcessGroup,
  listTreePaths,
  MAX_LISTING_BYTES,
  MAX_TREE_PATHS,
  nodeRunGit,
  PATCH_MAX_BYTES,
  PATCH_TIMEOUT_MS,
  PUSH_TIMEOUT_MS,
  type PushGrant,
  parseNameStatusZ,
  parseNumstatZ,
  patchBetween,
  prepareCheckpointScratch,
  pushArgv,
  pushExact,
  REVOKE_TIMEOUT_MS,
  type RunGitOptions,
  singleUse,
  snapshot,
  status,
} from "./git";

const GRANT: CloneGrant = {
  token: "ghs_super-secret-token",
  cloneUrl: "https://github.example/acme/widgets.git",
  branch: "oncue/fix-login-7f3a",
  baseSha: "a".repeat(40),
};

describe("singleUse", () => {
  it("yields the value once", () => {
    const grant = singleUse(GRANT);
    const first = grant.take();
    expect(first).toEqual({ kind: "taken", value: GRANT });
  });

  it("is spent after the first take, and the second take cannot see the token", () => {
    const grant = singleUse(GRANT);
    grant.take();
    const second = grant.take();
    expect(second).toEqual({ kind: "spent" });
    // The type of `second` carries no `value` at all when `kind` is "spent" --
    // this assertion is the runtime half of that guarantee.
    expect("value" in second).toBe(false);
  });
});

describe("cloneArgv", () => {
  it("builds the exact clone invocation, with an empty credential.helper", () => {
    expect(cloneArgv(GRANT, "/workspace")).toEqual([
      "git",
      "-c",
      "credential.helper=",
      "clone",
      "--branch",
      GRANT.branch,
      "--single-branch",
      GRANT.cloneUrl,
      "/workspace",
    ]);
  });

  it("never contains the token", () => {
    const argv = cloneArgv(GRANT, "/workspace");
    expect(argv.join(" ")).not.toContain(GRANT.token);
  });
});

describe("gitEnv", () => {
  it("is exactly PATH, HOME, GIT_ASKPASS, GIT_TERMINAL_PROMPT, GIT_CONFIG_NOSYSTEM", () => {
    const env = gitEnv({
      env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
      askpassPath: "/opt/oncue/askpass",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/oncue-bridge",
      GIT_ASKPASS: "/opt/oncue/askpass",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });

  it("never contains a token, because it has no token to contain", () => {
    const env = gitEnv({
      env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
      askpassPath: "/opt/oncue/askpass",
    });
    expect(Object.values(env).join(" ")).not.toContain(GRANT.token);
  });
});

interface RecordedCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly secretLines: readonly string[] | null;
  readonly options: RunGitOptions;
}

function fakeIo(
  script: (call: RecordedCall) => GitProcessResult,
  revokeResult: { ok: boolean; status: number | null } = { ok: true, status: 204 },
): { io: GitIo; calls: RecordedCall[]; revokedWith: string[] } {
  const calls: RecordedCall[] = [];
  const revokedWith: string[] = [];
  const io: GitIo = {
    async runGit(argv, options, secretLines) {
      const call = { argv, cwd: options.cwd, env: options.env, secretLines, options };
      calls.push(call);
      return script(call);
    },
    async revoke(token) {
      revokedWith.push(token);
      return revokeResult;
    },
    env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
    askpassPath: "/opt/oncue/askpass",
  };
  return { io, calls, revokedWith };
}

const OK: GitProcessResult = { code: 0, stdout: "", stderr: "" };

describe("clone", () => {
  it("returns grant_spent without running anything when the grant was already taken", async () => {
    const grant = singleUse(GRANT);
    grant.take();
    const { io, calls } = fakeIo(() => OK);
    const outcome = await clone(grant, "/workspace", io);
    expect(outcome).toEqual({ kind: "grant_spent" });
    expect(calls).toHaveLength(0);
  });

  it("clones, verifies HEAD, sets pushurl to /dev/null, and revokes the token", async () => {
    const { io, calls, revokedWith } = fakeIo((call) => {
      if (call.argv.includes("rev-parse")) {
        return { code: 0, stdout: `${GRANT.baseSha}\n`, stderr: "" };
      }
      return OK;
    });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: GRANT.baseSha,
      tokenRevoked: true,
      landing: "at_tip",
      fallbackSha: null,
    });

    expect(calls[0]?.argv).toEqual(cloneArgv(GRANT, "/workspace"));
    expect(calls[0]?.secretLines).toEqual([GRANT.token]);
    // rev-parse and the pushurl config run inside the cloned tree, with no secret.
    expect(calls[1]?.cwd).toBe("/workspace");
    expect(calls[1]?.secretLines).toBeNull();
    const pushurlCall = calls.find((call) => call.argv.some((arg) => arg.includes("pushurl")));
    expect(pushurlCall?.argv).toEqual(["git", "config", "remote.origin.pushurl", "/dev/null"]);
    expect(pushurlCall?.secretLines).toBeNull();

    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("never puts the token in argv or env across the whole run", async () => {
    const { io, calls } = fakeIo((call) => {
      if (call.argv.includes("rev-parse")) {
        return { code: 0, stdout: `${GRANT.baseSha}\n`, stderr: "" };
      }
      return OK;
    });
    await clone(singleUse(GRANT), "/workspace", io);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(GRANT.token);
      expect(Object.values(call.env).join(" ")).not.toContain(GRANT.token);
    }
    // The only place it appears at all is the dedicated secretLines channel,
    // and only on the very first (clone) call.
    const withSecret = calls.filter((call) => call.secretLines !== null);
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]?.secretLines).toEqual([GRANT.token]);
  });

  const TIP = "b".repeat(40);

  /** A tip past the grant's commit, with each probe answered as `answers` says. */
  function movedIo(answers: { present: readonly boolean[]; ancestor?: boolean; reset?: boolean }) {
    const present = [...answers.present];
    return fakeIo((call) => {
      if (call.argv.includes("rev-parse")) {
        return { code: 0, stdout: `${TIP}\n`, stderr: "" };
      }
      if (call.argv.includes("cat-file")) {
        return { code: present.shift() === true ? 0 : 1, stdout: "", stderr: "" };
      }
      if (call.argv.includes("merge-base")) {
        return { code: answers.ancestor === true ? 0 : 1, stdout: "", stderr: "" };
      }
      if (call.argv.includes("reset")) {
        return { code: answers.reset === false ? 128 : 0, stdout: "", stderr: "" };
      }
      return OK;
    });
  }

  it("a base branch that moved on lands on the grant's commit, found in the clone's history, with no fetch", async () => {
    const { io, calls, revokedWith } = movedIo({ present: [true] });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: GRANT.baseSha,
      tokenRevoked: true,
      landing: "base_moved",
      fallbackSha: null,
    });
    expect(calls.some((call) => call.argv.includes("fetch"))).toBe(false);
    const reset = calls.find((call) => call.argv.includes("reset"));
    expect(reset?.argv).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "reset",
      "-q",
      "--hard",
      GRANT.baseSha,
    ]);
    expect(reset?.cwd).toBe("/workspace");
    expect(reset?.secretLines).toBeNull();
    // The check and the move both happen before the push URL is poisoned and
    // the token revoked, which is before anything is handed over.
    const resetAt = calls.findIndex((call) => call.argv.includes("reset"));
    const pushurlAt = calls.findIndex((call) => call.argv.includes("remote.origin.pushurl"));
    expect(resetAt).toBeGreaterThan(0);
    expect(resetAt).toBeLessThan(pushurlAt);
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("a commit the clone lacks is fetched once by id, with the token on fd 3 only", async () => {
    const { io, calls, revokedWith } = movedIo({ present: [false, true] });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toMatchObject({
      kind: "cloned",
      headSha: GRANT.baseSha,
      landing: "base_moved",
    });
    const fetches = calls.filter((call) => call.argv.includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.argv).toEqual([
      "git",
      "-c",
      "credential.helper=",
      "fetch",
      "--no-tags",
      "-q",
      "origin",
      GRANT.baseSha,
    ]);
    expect(fetches[0]?.cwd).toBe("/workspace");
    expect(fetches[0]?.secretLines).toEqual([GRANT.token]);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(GRANT.token);
      expect(Object.values(call.env).join(" ")).not.toContain(GRANT.token);
    }
    // The clone and the fetch, and nothing else, were handed the token.
    expect(calls.filter((call) => call.secretLines !== null)).toHaveLength(2);
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("a commit GitHub no longer has is commit_missing, after exactly one fetch, and the token is revoked", async () => {
    const { io, calls, revokedWith } = movedIo({ present: [false, false] });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "commit_missing",
      expected: GRANT.baseSha,
      branchTip: TIP,
      tokenRevoked: true,
    });
    expect(calls.filter((call) => call.argv.includes("fetch"))).toHaveLength(1);
    expect(calls.some((call) => call.argv.includes("reset"))).toBe(false);
    expect(calls.some((call) => call.argv.includes("pushurl"))).toBe(false);
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("the session's own branch moved ahead: the newer tip is kept, and the session's push is the fallback", async () => {
    const { io, calls } = movedIo({ present: [true], ancestor: true });
    const outcome = await clone(singleUse({ ...GRANT, ownBranch: true }), "/workspace", io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: TIP,
      tokenRevoked: true,
      landing: "branch_ahead",
      fallbackSha: GRANT.baseSha,
    });
    expect(calls.find((call) => call.argv.includes("merge-base"))?.argv).toEqual([
      "git",
      "merge-base",
      "--is-ancestor",
      GRANT.baseSha,
      TIP,
    ]);
    expect(calls.some((call) => call.argv.includes("reset"))).toBe(false);
  });

  it("the session's own branch rewritten on GitHub lands on the session's own push", async () => {
    const { io } = movedIo({ present: [true], ancestor: false });
    const outcome = await clone(singleUse({ ...GRANT, ownBranch: true }), "/workspace", io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: GRANT.baseSha,
      tokenRevoked: true,
      landing: "branch_rewritten",
      fallbackSha: null,
    });
  });

  it("a base branch that moved never asks whether its tip descends: a newer base is never taken", async () => {
    const { io, calls } = movedIo({ present: [true], ancestor: true });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toMatchObject({ headSha: GRANT.baseSha, landing: "base_moved" });
    expect(calls.some((call) => call.argv.includes("merge-base"))).toBe(false);
  });

  it("a checkout that fails is verify_failed, and the token is still revoked", async () => {
    const { io, revokedWith } = movedIo({ present: [true], reset: false });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "verify_failed",
      detail: "could not check out the expected commit",
    });
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it.each(["main", "-o", "HEAD~1", "a".repeat(39), "A".repeat(40)])(
    "a grant whose commit is %s runs no git at all, and the token is revoked",
    async (baseSha) => {
      const { io, calls, revokedWith } = fakeIo(() => OK);
      const outcome = await clone(singleUse({ ...GRANT, baseSha }), "/workspace", io);
      expect(outcome).toEqual({
        kind: "verify_failed",
        detail: "the grant's commit is not a commit id",
      });
      expect(calls).toHaveLength(0);
      expect(revokedWith).toEqual([GRANT.token]);
    },
  );

  it("reports clone_failed, classified, and revokes the single-use token, which nothing else will spend", async () => {
    const { io, revokedWith } = fakeIo(() => ({
      code: 128,
      stdout: "",
      stderr: "fatal: Authentication failed for URL",
    }));
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "clone_failed",
      reason: "authentication_failed",
      tokenRevoked: true,
    });
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("says when the revoke after a failed clone did not land", async () => {
    const { io, revokedWith } = fakeIo(
      () => ({ code: 128, stdout: "", stderr: "fatal: Could not resolve host: github.com" }),
      { ok: false, status: null },
    );
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({ kind: "clone_failed", reason: "network", tokenRevoked: false });
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("bounds the clone and the follow-up fetch by wall-clock time, and a clone killed at its bound says it timed out", async () => {
    const { io, calls, revokedWith } = fakeIo((call) =>
      call.argv.includes("clone") ? { code: null, stdout: "", stderr: "", timedOut: true } : OK,
    );
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({ kind: "clone_failed", reason: "timed_out", tokenRevoked: true });
    expect(calls[0]?.options.timeoutMs).toBe(CLONE_TIMEOUT_MS);
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("gives the fetch by commit id its own bound", async () => {
    const tip = "f".repeat(40);
    const { io, calls } = fakeIo((call) => {
      if (call.argv.includes("rev-parse")) {
        return { code: 0, stdout: `${tip}\n`, stderr: "" };
      }
      if (call.argv.includes("cat-file")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      return OK;
    });
    await clone(singleUse(GRANT), "/workspace", io);
    const fetch = calls.find((call) => call.argv.includes("fetch"));
    expect(fetch?.options.timeoutMs).toBe(FETCH_TIMEOUT_MS);
    expect(fetch?.secretLines).toEqual([GRANT.token]);
  });

  it("reports verify_failed when rev-parse HEAD does not produce a commit, and revokes the token", async () => {
    const { io, revokedWith } = fakeIo((call) => {
      if (call.argv.includes("rev-parse")) {
        return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      return OK;
    });
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "verify_failed",
      detail: "git rev-parse HEAD did not produce a commit",
    });
    expect(revokedWith).toEqual([GRANT.token]);
  });

  it("surfaces revoke failure as tokenRevoked: false rather than throwing", async () => {
    const { io } = fakeIo(
      (call) =>
        call.argv.includes("rev-parse")
          ? { code: 0, stdout: `${GRANT.baseSha}\n`, stderr: "" }
          : OK,
      { ok: false, status: 500 },
    );
    const outcome = await clone(singleUse(GRANT), "/workspace", io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: GRANT.baseSha,
      tokenRevoked: false,
      landing: "at_tip",
      fallbackSha: null,
    });
  });
});

describe("classifyCloneFailure", () => {
  // Git's own stderr for each case, as `git clone` over HTTPS prints it.
  it.each<[string, string, string]>([
    [
      "bad credentials",
      "Cloning into '/workspace'...\nremote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/widgets.git/'",
      "authentication_failed",
    ],
    [
      "no credentials and no prompt",
      "Cloning into '/workspace'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "authentication_failed",
    ],
    [
      "an HTTP 403",
      "Cloning into '/workspace'...\nremote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403",
      "authentication_failed",
    ],
    [
      "a repository that is not there",
      "Cloning into '/workspace'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/widgets.git/' not found",
      "not_found",
    ],
    ["GitHub's short form", "remote: Not Found", "not_found"],
    [
      "a missing repository whose name holds 403",
      "Cloning into '/workspace'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/http-403-pages.git/' not found",
      "not_found",
    ],
    [
      "an HTTP 404",
      "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 404",
      "not_found",
    ],
    [
      "a deleted branch",
      "Cloning into '/workspace'...\nwarning: Could not find remote branch oncue/x to clone.\nfatal: Remote branch oncue/x not found in upstream origin",
      "branch_missing",
    ],
    [
      "a deleted branch whose name holds 403 and network",
      "Cloning into '/workspace'...\nwarning: Could not find remote branch fix-403-network to clone.\nfatal: Remote branch fix-403-network not found in upstream origin",
      "branch_missing",
    ],
    [
      "an unresolvable host",
      "Cloning into '/workspace'...\nfatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com",
      "network",
    ],
    [
      "a refused connection",
      "fatal: unable to access 'https://github.com/acme/widgets.git/': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server",
      "network",
    ],
    [
      "a connection dropped mid-transfer",
      "error: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer, errno 104\nfatal: early EOF",
      "network",
    ],
    [
      "a server error",
      "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 502",
      "network",
    ],
    [
      "a path that names a cause, with an unrelated failure",
      "Cloning into '/tmp/authentication failed network'...\nfatal: something entirely unexpected",
      "unknown",
    ],
  ])("classifies %s", (_name, stderr, expected) => {
    expect(classifyCloneFailure(stderr)).toBe(expected);
  });

  it("calls a clone killed at its time bound timed out, not a passing network failure", () => {
    expect(classifyCloneFailure("Cloning into '/workspace'...", true)).toBe("timed_out");
  });
});

const PUSH_TOKEN = "ghs_push-token-never-in-argv";
const WORK = "/workspace";
const SCRATCH = "/opt/oncue/checkpoint";
const SESSION_BRANCH = "oncue/fix-login-7f3a";
const SESSION_REF = `refs/heads/${SESSION_BRANCH}`;
const PARENT = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "c".repeat(40);

function pushGrant(overrides: Partial<PushGrant> = {}): PushGrant {
  return { token: PUSH_TOKEN, cloneUrl: GRANT.cloneUrl, ref: SESSION_REF, ...overrides };
}

describe("checkpointEnv and checkpointArgv", () => {
  it("takes git's directory, index, and new objects from the scratch dir, never the tree's .git, and reads the tree's objects as alternates", () => {
    const env = checkpointEnv(
      { env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" }, askpassPath: "/opt/oncue/askpass" },
      WORK,
      SCRATCH,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/oncue-bridge",
      GIT_ASKPASS: "/opt/oncue/askpass",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_DIR: "/opt/oncue/checkpoint/git",
      GIT_WORK_TREE: "/workspace",
      GIT_INDEX_FILE: "/opt/oncue/checkpoint/index",
      GIT_OBJECT_DIRECTORY: "/opt/oncue/checkpoint/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/workspace/.git/objects",
      GIT_AUTHOR_NAME: "OnCue",
      GIT_AUTHOR_EMAIL: "checkpoint@oncue.invalid",
      GIT_COMMITTER_NAME: "OnCue",
      GIT_COMMITTER_EMAIL: "checkpoint@oncue.invalid",
    });
  });

  it("marks the tree safe and turns off hooks, the filesystem monitor, and the attributes file on every invocation", () => {
    expect(checkpointArgv(WORK, "write-tree")).toEqual([
      "git",
      "-c",
      "safe.directory=/workspace",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "write-tree",
    ]);
  });
});

describe("isExactSessionRef", () => {
  it.each([
    [SESSION_REF, SESSION_BRANCH, true],
    ["refs/heads/main", SESSION_BRANCH, false],
    [`+${SESSION_REF}`, SESSION_BRANCH, false],
    ["refs/tags/v1", "v1", false],
    ["refs/heads/oncue/x/../main", "oncue/x/../main", false],
    ["refs/heads/oncue//x", "oncue//x", false],
    ["refs/heads/oncue/x.lock", "oncue/x.lock", false],
    ["refs/heads/oncue/x/", "oncue/x/", false],
    ["refs/heads/oncue/x y", "oncue/x y", false],
    ["refs/heads/oncue/x:y", "oncue/x:y", false],
  ])("%s for session branch %s -> %s", (ref, branch, expected) => {
    expect(isExactSessionRef(ref, branch)).toBe(expected);
  });

  it("with no session branch yet holds the ref to its shape and refuses the branch the sandbox cloned", () => {
    // The object's grant names the branch; the bridge checks the shape...
    expect(isExactSessionRef(SESSION_REF, null, "main")).toBe(true);
    expect(isExactSessionRef("refs/heads/oncue/x/../main", null, "main")).toBe(false);
    expect(isExactSessionRef("refs/tags/v1", null, "main")).toBe(false);
    // ...and never lets a grant push to the base branch, whatever the object said.
    expect(isExactSessionRef("refs/heads/main", null, "main")).toBe(false);
    expect(isExactSessionRef("refs/heads/main", null, null)).toBe(true);
    // Once named, the clone branch no longer matters: the name is the check.
    expect(isExactSessionRef(SESSION_REF, SESSION_BRANCH, "main")).toBe(true);
  });
});

describe("pushArgv", () => {
  it("names the URL and a plain refspec, with no force and no remote name", () => {
    expect(pushArgv(WORK, GRANT.cloneUrl, COMMIT, SESSION_REF)).toEqual([
      "git",
      "-c",
      "credential.helper=",
      "-c",
      "safe.directory=/workspace",
      ...CHECKPOINT_CONFIG,
      "push",
      "--porcelain",
      GRANT.cloneUrl,
      `${COMMIT}:${SESSION_REF}`,
    ]);
  });
});

describe("classifyPushFailure", () => {
  const SHA_WITH_403 = "4030c0ffee4030c0ffee4030c0ffee4030c0ffee";
  const URL_LINE = "To https://github.com/acme/widgets.git";
  const FAILED_REFS = "error: failed to push some refs to 'https://github.com/acme/widgets.git'";
  // `git push --porcelain`'s stdout and stderr for each case, as git prints them.
  it.each<[string, string, string, string]>([
    [
      "a workflow change the App may not push",
      `${URL_LINE}\n!\t${COMMIT}:refs/heads/oncue/ci\t[remote rejected] (refusing to allow a GitHub App to create or update workflow \`.github/workflows/ci.yml\` without \`workflows\` permission)\nDone`,
      FAILED_REFS,
      "workflow_file_rejected",
    ],
    [
      "a non-fast-forward whose commit id holds 403",
      `${URL_LINE}\n!\t${SHA_WITH_403}:refs/heads/oncue/fix-403\t[rejected] (non-fast-forward)\nDone`,
      `${FAILED_REFS}\nhint: Updates were rejected because the tip of your current branch is behind`,
      "rejected",
    ],
    [
      "a fetch-first refusal on a branch named for the network",
      `${URL_LINE}\n!\t${COMMIT}:refs/heads/oncue/network-permission-to-retry\t[rejected] (fetch first)\nDone`,
      FAILED_REFS,
      "rejected",
    ],
    [
      "a protected branch",
      `${URL_LINE}\n!\t${COMMIT}:refs/heads/main\t[remote rejected] (protected branch hook declined)\nDone`,
      `remote: error: GH006: Protected branch update failed for refs/heads/main.\n${FAILED_REFS}`,
      "rejected",
    ],
    [
      "GitHub's protected-branch text alone",
      "",
      "remote: error: GH006: Protected branch update failed",
      "rejected",
    ],
    [
      "an App without write access",
      "",
      "remote: Permission to acme/widgets.git denied to oncue-app[bot].\nfatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 403",
      "authentication_failed",
    ],
    [
      "a revoked token",
      "",
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/widgets.git/'",
      "authentication_failed",
    ],
    [
      "an unresolvable host",
      "",
      "fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com",
      "network",
    ],
    ["a dropped remote", "", "fatal: Could not read from remote repository.", "network"],
    [
      "a server error",
      "",
      "fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: 500",
      "network",
    ],
    ["something else entirely", "", "something else entirely", "unknown"],
  ])("classifies %s", (_name, stdout, stderr, expected) => {
    expect(classifyPushFailure({ stdout, stderr })).toBe(expected);
  });

  it("calls a push killed at its time bound a network failure", () => {
    expect(classifyPushFailure({ stdout: "", stderr: "" }, true)).toBe("network");
  });
});

/** A fake runner scripted by git subcommand, for the checkpoint functions. */
function checkpointIo(
  overrides: Partial<Record<string, GitProcessResult>> = {},
  revokeResult: { ok: boolean; status: number | null } = { ok: true, status: 204 },
) {
  const stdout = (text: string): GitProcessResult => ({ code: 0, stdout: `${text}\n`, stderr: "" });
  const script: Record<string, GitProcessResult> = {
    "read-tree": OK,
    add: OK,
    "write-tree": stdout(TREE),
    "rev-parse": stdout("d".repeat(40)),
    "commit-tree": stdout(COMMIT),
    push: OK,
    diff: { code: 0, stdout: "diff --git a/f b/f\n", stderr: "" },
    apply: OK,
    commit: OK,
    ...overrides,
  };
  return fakeIo((call) => {
    const sub = call.argv.find(
      (arg, index) =>
        index > 0 && call.argv[index - 1] !== "-c" && !arg.startsWith("-") && arg !== "git",
    );
    return script[sub ?? ""] ?? { code: 1, stdout: "", stderr: `unscripted: ${sub}` };
  }, revokeResult);
}

describe("parseNameStatusZ", () => {
  it("is empty on empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("reads added, modified, deleted, type-changed, renamed, and copied records", () => {
    const captured = [
      "A",
      "new.ts",
      "M",
      "src/git.ts",
      "D",
      "gone.ts",
      "T",
      "link",
      "R087",
      "old name.ts",
      "new name.ts",
      "C100",
      "a.ts",
      "b.ts",
      "",
    ].join("\0");
    expect(parseNameStatusZ(captured)).toEqual([
      { path: "new.ts", status: "added" },
      { path: "src/git.ts", status: "modified" },
      { path: "gone.ts", status: "deleted" },
      { path: "link", status: "modified" },
      { path: "new name.ts", status: "renamed", previousPath: "old name.ts" },
      { path: "b.ts", status: "added" },
    ]);
  });

  it("drops a record the output cut short", () => {
    expect(parseNameStatusZ("M\0kept.ts\0M\0cut.t")).toEqual([
      { path: "kept.ts", status: "modified" },
    ]);
    expect(parseNameStatusZ("R100\0old.ts\0new.t")).toEqual([]);
  });
});

describe("parseNumstatZ", () => {
  it("is empty on empty output", () => {
    expect(parseNumstatZ("").size).toBe(0);
  });

  it("keys counts by the new path, reads renames, and counts a binary file's - - as zero", () => {
    const captured = ["12\t3\tsrc/git.ts", "-\t-\tlogo.png", "4\t1\t", "old.ts", "new.ts", ""].join(
      "\0",
    );
    expect([...parseNumstatZ(captured)]).toEqual([
      ["src/git.ts", { additions: 12, deletions: 3 }],
      ["logo.png", { additions: 0, deletions: 0 }],
      ["new.ts", { additions: 4, deletions: 1 }],
    ]);
  });

  it("keeps a tab inside a path and drops a record the output cut short", () => {
    expect([...parseNumstatZ("1\t0\ta\tb.ts\0" + "2\t2\tcut")]).toEqual([
      ["a\tb.ts", { additions: 1, deletions: 0 }],
    ]);
    expect([...parseNumstatZ("x\ty\tz.ts\0")]).toEqual([["z.ts", { additions: 0, deletions: 0 }]]);
    expect(parseNumstatZ("garbage\0").size).toBe(0);
  });
});

describe("nodeRunGit bounds", () => {
  // A compound `sh -c` keeps its command as a child (Debian's `dash` does even
  // for one command), so a grandchild holds the runner's pipes; killing only
  // the child would leave the runner waiting on it.
  it("stops a grandchild at the time bound instead of waiting for it", async () => {
    const started = Date.now();
    const result = await nodeRunGit(
      ["sh", "-c", "sleep 5; true"],
      { cwd: ".", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 50 },
      null,
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops a grandchild at the stdout cap instead of waiting for it", async () => {
    const started = Date.now();
    const result = await nodeRunGit(
      ["sh", "-c", "yes 0123456789; true"],
      { cwd: ".", env: { PATH: process.env.PATH ?? "" }, maxStdoutBytes: 1000 },
      null,
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(1000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a process past its time limit and says so", async () => {
    const result = await nodeRunGit(
      ["sleep", "5"],
      { cwd: ".", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 50 },
      null,
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("keeps exactly the stdout limit, stops the process, and says so", async () => {
    const result = await nodeRunGit(
      ["sh", "-c", "yes 0123456789"],
      { cwd: ".", env: { PATH: process.env.PATH ?? "" }, maxStdoutBytes: 1000 },
      null,
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(1000);
    expect(result.timedOut).toBeUndefined();
  });

  it("reports neither when the process ends on its own", async () => {
    const result = await nodeRunGit(
      ["sh", "-c", "printf ok"],
      { cwd: ".", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000, maxStdoutBytes: 10 },
      null,
    );
    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
  });
});

describe("diffBetween and status with a fake runner", () => {
  function diffIo(scripted: (argv: readonly string[]) => GitProcessResult | null = () => null) {
    return fakeIo((call) => {
      const answer = scripted(call.argv);
      if (answer !== null) {
        return answer;
      }
      if (call.argv.includes("rev-list")) {
        return { code: 0, stdout: "2\n", stderr: "" };
      }
      if (call.argv.includes("rev-parse")) {
        return { code: 0, stdout: `${TREE}\n${"e".repeat(40)}\n`, stderr: "" };
      }
      return OK;
    });
  }

  it("runs every command in the scratch environment with the diff flags and a bound on what it reads", async () => {
    const { io, calls } = diffIo();
    await diffBetween(PARENT, COMMIT, WORK, SCRATCH, io, { timeoutMs: 5_000, maxPatchBytes: 123 });
    expect(calls.map((call) => call.argv.slice(-3))).toEqual([
      ["-z", PARENT, COMMIT],
      ["-z", PARENT, COMMIT],
      ["-M", PARENT, COMMIT],
    ]);
    for (const call of calls) {
      expect(call.argv.slice(0, 16)).toEqual([
        ...checkpointArgv(WORK, "-c", "core.quotePath=false", "diff"),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "-M",
      ]);
      expect(call.options.env).toEqual(checkpointEnv(io, WORK, SCRATCH));
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(5_000);
    }
    expect(calls.map((call) => call.options.maxStdoutBytes)).toEqual([
      MAX_LISTING_BYTES,
      MAX_LISTING_BYTES,
      123,
    ]);
  });

  it.each([
    ["--name-status", "listing_failed"],
    ["--numstat", "counts_failed"],
    [COMMIT, "patch_failed"],
  ])("a failing %s is %s, and a timed-out one is timed_out", async (marker, detail) => {
    const failing = (timedOut: boolean) =>
      diffIo((argv) =>
        argv.includes(marker) && (marker !== COMMIT || !argv.includes("-z"))
          ? {
              code: timedOut ? null : 128,
              stdout: "",
              stderr: "fatal",
              ...(timedOut ? { timedOut } : {}),
            }
          : null,
      ).io;
    expect(await diffBetween(PARENT, COMMIT, WORK, SCRATCH, failing(false))).toEqual({
      kind: "failed",
      detail,
    });
    expect(await diffBetween(PARENT, COMMIT, WORK, SCRATCH, failing(true))).toEqual({
      kind: "failed",
      detail: "timed_out",
    });
  });

  it("keeps a patch cut at its limit and says truncated", async () => {
    const { io } = diffIo((argv) =>
      argv.includes("-z")
        ? null
        : { code: null, stdout: "diff --git a", stderr: "", stdoutTruncated: true },
    );
    expect(await diffBetween(PARENT, COMMIT, WORK, SCRATCH, io)).toMatchObject({
      kind: "ok",
      patch: "diff --git a",
      truncated: true,
    });
  });

  it.each([
    ["rev-list", "count_failed"],
    ["rev-parse", "tree_failed"],
    ["--numstat", "diff_failed"],
    ["--diff-filter=A", "diff_failed"],
  ])("status: a failing %s is %s", async (marker, detail) => {
    const { io } = diffIo((argv) =>
      argv.includes(marker) ? { code: 128, stdout: "", stderr: "fatal" } : null,
    );
    const refs = { branch: "b", baseSha: PARENT, parentSha: PARENT, headSha: COMMIT };
    expect(await status(WORK, SCRATCH, refs, io)).toEqual({ kind: "failed", detail });
  });
});

describe("snapshot", () => {
  it("reads the parent tree into the private index, adds everything, and commits when the tree differs", async () => {
    const { io, calls } = checkpointIo();
    const outcome = await snapshot(WORK, SCRATCH, PARENT, "OnCue checkpoint (idle)", io);
    expect(outcome).toEqual({ kind: "committed", sha: COMMIT });
    expect(calls.map((call) => call.argv.slice(3 + CHECKPOINT_CONFIG.length))).toEqual([
      ["read-tree", PARENT],
      ["add", "-A"],
      ["write-tree"],
      ["rev-parse", `${PARENT}^{tree}`],
      ["commit-tree", TREE, "-p", PARENT, "-m", "OnCue checkpoint (idle)"],
    ]);
    for (const call of calls) {
      expect(call.argv.slice(0, 3)).toEqual(["git", "-c", `safe.directory=${WORK}`]);
      expect(call.cwd).toBe(WORK);
      expect(call.env.GIT_INDEX_FILE).toBe(`${SCRATCH}/index`);
      expect(call.env.GIT_OBJECT_DIRECTORY).toBe(`${SCRATCH}/objects`);
      expect(call.secretLines).toBeNull();
    }
  });

  // Whatever path a message took, what reaches `commit-tree` is cleaned.
  it.each([
    [
      "a person trailer and a terminal escape",
      `Fix${String.fromCharCode(0x1b)}[2J it\n\nCo-authored-by: x <x@y>`,
      "Fix[2J it",
    ],
    ["nothing left", "Signed-off-by: x", "Update from OnCue"],
  ])("cleans the message it commits: %s", async (_name, message, committed) => {
    const { io, calls } = checkpointIo();
    await snapshot(WORK, SCRATCH, PARENT, message, io);
    expect(calls.at(-1)?.argv.slice(-2)).toEqual(["-m", committed]);
  });

  it("is unchanged, naming the parent, when the written tree equals the parent's tree", async () => {
    const { io, calls } = checkpointIo({
      "rev-parse": { code: 0, stdout: `${TREE}\n`, stderr: "" },
    });
    expect(await snapshot(WORK, SCRATCH, PARENT, "m", io)).toEqual({
      kind: "unchanged",
      sha: PARENT,
    });
    expect(calls.some((call) => call.argv.includes("commit-tree"))).toBe(false);
  });

  it.each([
    ["read-tree", "read_tree_failed"],
    ["add", "add_failed"],
    ["write-tree", "write_tree_failed"],
    ["rev-parse", "parent_unreadable"],
    ["commit-tree", "commit_failed"],
  ])("a failing %s is the fixed category %s, never git's text", async (sub, detail) => {
    const { io } = checkpointIo({
      [sub]: { code: 128, stdout: "", stderr: "fatal: /workspace/secret-path.txt" },
    });
    expect(await snapshot(WORK, SCRATCH, PARENT, "m", io)).toEqual({ kind: "failed", detail });
  });
});

describe("pushExact", () => {
  it("pushes the exact session ref with the token on fd 3 only, then revokes", async () => {
    const { io, calls, revokedWith } = checkpointIo();
    const outcome = await pushExact(
      singleUse(pushGrant()),
      COMMIT,
      SESSION_BRANCH,
      WORK,
      SCRATCH,
      io,
    );
    expect(outcome).toEqual({ kind: "pushed", tokenRevoked: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(pushArgv(WORK, GRANT.cloneUrl, COMMIT, SESSION_REF));
    expect(calls[0]?.secretLines).toEqual([PUSH_TOKEN]);
    expect(calls[0]?.argv.join(" ")).not.toContain(PUSH_TOKEN);
    expect(Object.values(calls[0]?.env ?? {}).join(" ")).not.toContain(PUSH_TOKEN);
    expect(calls[0]?.env.GIT_OBJECT_DIRECTORY).toBe(`${SCRATCH}/objects`);
    expect(revokedWith).toEqual([PUSH_TOKEN]);
  });

  it("bounds the push by wall-clock time, and a push killed at its bound is a network failure whose token is still revoked", async () => {
    const { io, calls, revokedWith } = checkpointIo({
      push: { code: null, stdout: "", stderr: "", timedOut: true },
    });
    const outcome = await pushExact(
      singleUse(pushGrant()),
      COMMIT,
      SESSION_BRANCH,
      WORK,
      SCRATCH,
      io,
    );
    expect(outcome).toEqual({ kind: "push_failed", reason: "network", tokenRevoked: true });
    expect(calls[0]?.options.timeoutMs).toBe(PUSH_TIMEOUT_MS);
    expect(revokedWith).toEqual([PUSH_TOKEN]);
  });

  it("classifies a refused push from porcelain stdout, not from the commit id in it", async () => {
    const { io } = checkpointIo({
      push: {
        code: 1,
        stdout: `To https://github.com/acme/widgets.git\n!\t${"4030".repeat(10)}:${SESSION_REF}\t[rejected] (non-fast-forward)\nDone\n`,
        stderr: "error: failed to push some refs to 'https://github.com/acme/widgets.git'\n",
      },
    });
    const outcome = await pushExact(
      singleUse(pushGrant()),
      COMMIT,
      SESSION_BRANCH,
      WORK,
      SCRATCH,
      io,
    );
    expect(outcome).toEqual({ kind: "push_failed", reason: "rejected", tokenRevoked: true });
  });

  it.each([
    ["another branch", "refs/heads/main", SESSION_BRANCH],
    ["a traversal", "refs/heads/oncue/x/../main", "oncue/x/../main"],
    ["a force refspec", `+${SESSION_REF}`, SESSION_BRANCH],
    ["a tag", "refs/tags/v1", SESSION_BRANCH],
  ])(
    "refuses %s before any process sees the token, and still revokes it",
    async (_what, ref, branch) => {
      const { io, calls, revokedWith } = checkpointIo();
      const outcome = await pushExact(
        singleUse(pushGrant({ ref })),
        COMMIT,
        branch,
        WORK,
        SCRATCH,
        io,
      );
      expect(outcome).toEqual({ kind: "refused", reason: "ref_mismatch", tokenRevoked: true });
      expect(calls).toHaveLength(0);
      expect(revokedWith).toEqual([PUSH_TOKEN]);
    },
  );

  it("a spent grant runs nothing and revokes nothing", async () => {
    const grant = singleUse(pushGrant());
    grant.take();
    const { io, calls, revokedWith } = checkpointIo();
    expect(await pushExact(grant, COMMIT, SESSION_BRANCH, WORK, SCRATCH, io)).toEqual({
      kind: "grant_spent",
    });
    expect(calls).toHaveLength(0);
    expect(revokedWith).toEqual([]);
  });

  it("classifies a failed push and revokes anyway", async () => {
    const { io, revokedWith } = checkpointIo(
      { push: { code: 1, stdout: "", stderr: "! [rejected] non-fast-forward" } },
      { ok: false, status: 500 },
    );
    expect(
      await pushExact(singleUse(pushGrant()), COMMIT, SESSION_BRANCH, WORK, SCRATCH, io),
    ).toEqual({
      kind: "push_failed",
      reason: "rejected",
      tokenRevoked: false,
    });
    expect(revokedWith).toEqual([PUSH_TOKEN]);
  });
});

describe("patchBetween and applyRestore with a fake runner", () => {
  it("diffs parent to commit over the scratch objects", async () => {
    const { io, calls } = checkpointIo();
    expect(await patchBetween(PARENT, COMMIT, WORK, SCRATCH, io)).toEqual({
      kind: "ok",
      patch: "diff --git a/f b/f\n",
    });
    expect(calls[0]?.argv.slice(3 + CHECKPOINT_CONFIG.length)).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      PARENT,
      COMMIT,
    ]);
    expect(calls[0]?.env.GIT_OBJECT_DIRECTORY).toBe(`${SCRATCH}/objects`);
  });

  it("reports a failed diff as failed", async () => {
    const { io } = checkpointIo({ diff: { code: 128, stdout: "", stderr: "bad object" } });
    expect(await patchBetween(PARENT, COMMIT, WORK, SCRATCH, io)).toEqual({ kind: "failed" });
  });

  it("bounds the diff in time and in the patch bytes it reads", async () => {
    const { io, calls } = checkpointIo();
    await patchBetween(PARENT, COMMIT, WORK, SCRATCH, io);
    expect(calls[0]?.options.timeoutMs).toBe(PATCH_TIMEOUT_MS);
    expect(calls[0]?.options.maxStdoutBytes).toBe(PATCH_MAX_BYTES);
  });

  it.each<[string, GitProcessResult]>([
    ["ran past its time", { code: null, stdout: "diff --git a/f", stderr: "", timedOut: true }],
    [
      "ran past its byte bound",
      { code: null, stdout: "diff --git a/f", stderr: "", stdoutTruncated: true },
    ],
  ])("fails rather than return part of a patch when the diff %s", async (_why, diff) => {
    const { io } = checkpointIo({ diff });
    expect(await patchBetween(PARENT, COMMIT, WORK, SCRATCH, io)).toEqual({ kind: "failed" });
  });

  it("applies with --index, commits as OnCue on the ordinary environment, and reads HEAD", async () => {
    const { io, calls } = checkpointIo();
    expect(await applyRestore(WORK, "/opt/oncue/checkpoint/restore.patch", io)).toEqual({
      kind: "restored",
      headSha: "d".repeat(40),
    });
    expect(calls.map((call) => call.argv.slice(3 + CHECKPOINT_CONFIG.length))).toEqual([
      ["apply", "--index", "/opt/oncue/checkpoint/restore.patch"],
      [
        "-c",
        "user.name=OnCue",
        "-c",
        "user.email=checkpoint@oncue.invalid",
        "commit",
        "-q",
        "-m",
        "Restore the OnCue checkpoint bundle",
      ],
      ["rev-parse", "HEAD"],
    ]);
    for (const call of calls) {
      expect(call.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
      expect(call.env.GIT_INDEX_FILE).toBeUndefined();
    }
  });

  it.each([
    ["apply", "apply_failed"],
    ["commit", "commit_failed"],
  ])("a failing %s is %s", async (sub, detail) => {
    const { io } = checkpointIo({ [sub]: { code: 1, stdout: "", stderr: "no" } });
    expect(await applyRestore(WORK, "/p", io)).toEqual({ kind: "failed", detail });
  });
});

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A bare origin with one commit on `task-branch`, and a `GitIo` over real git with a faked revoke. */
function realOrigin(root: string) {
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "work");
  git(["init", "--bare", "-q", bareDir], root);
  git(["init", "-q", workDir], root);
  git(["config", "user.email", "test@example.com"], workDir);
  git(["config", "user.name", "Test"], workDir);
  git(["checkout", "-q", "-b", "task-branch"], workDir);
  writeFileSync(join(workDir, "file.txt"), "hello\n");
  writeFileSync(join(workDir, "gone.txt"), "to be deleted\n");
  git(["add", "file.txt", "gone.txt"], workDir);
  git(["commit", "-q", "-m", "initial"], workDir);
  const baseSha = git(["rev-parse", "HEAD"], workDir).trim();
  git(["remote", "add", "origin", bareDir], workDir);
  git(["push", "-q", "origin", "task-branch"], workDir);

  const revoked: string[] = [];
  const io: GitIo = {
    runGit: nodeRunGit,
    // The real revoke call is a live network request to GitHub; these tests
    // prove the git mechanics, so revoke is faked as in the unit tests.
    async revoke(token) {
      revoked.push(token);
      return { ok: true, status: 204 };
    },
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    // Never invoked: a local filesystem "clone URL" needs no credential
    // prompt, so askpass is never exec'd. It still has to be a string.
    askpassPath: "/bin/true",
  };
  return { bareDir, baseSha, io, revoked };
}

/** Every path under `.git` with its size, so a checkpoint can be shown to have written none of them. */
function gitDirListing(target: string): string[] {
  return readdirSync(join(target, ".git"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("clone + status against real git", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clones a local bare repository, verifies HEAD, and reports a clean status", async () => {
    const root = mkdtempSync(join(tmpdir(), "oncue-git-"));
    dirsToClean.push(root);
    const target = join(root, "clone");
    const { bareDir, baseSha, io, revoked } = realOrigin(root);

    const grant: CloneGrant = {
      token: "unused-in-this-test",
      cloneUrl: bareDir,
      branch: "task-branch",
      baseSha,
    };
    const outcome = await clone(singleUse(grant), target, io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: baseSha,
      tokenRevoked: true,
      landing: "at_tip",
      fallbackSha: null,
    });
    expect(revoked).toEqual(["unused-in-this-test"]);

    const pushurl = readFileSync(join(target, ".git", "config"), "utf8");
    expect(pushurl).toContain("pushurl = /dev/null");

    // A push from inside the tree is refused for every ref, the task branch
    // included: the agent has no push; only the bridge's checkpoint does.
    for (const refspec of ["HEAD", "HEAD:refs/heads/task-branch", "HEAD:refs/heads/other"]) {
      let stderr = "";
      try {
        execFileSync("git", ["push", "origin", refspec], { cwd: target, stdio: "pipe" });
      } catch (error) {
        stderr = String((error as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr).toContain("'/dev/null' does not appear to be a git repository");
    }
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(baseSha);

    // The token was handed to askpass over a descriptor, never to a file:
    // nothing git wrote under the clone holds it, and no helper is set.
    const gitDir = join(target, ".git");
    for (const name of ["config", "HEAD", "packed-refs"]) {
      expect(readFileSync(join(gitDir, name), "utf8")).not.toContain(grant.token);
    }
    expect(git(["config", "--list", "--show-origin"], target)).not.toContain(grant.token);
    // The clone's own config, not the machine's: git.ts runs git with the
    // system config disabled and this test's git does not.
    let helper = "";
    try {
      helper = git(["config", "--local", "--get-all", "credential.helper"], target).trim();
    } catch {
      // exit 1: the key is unset, which is the point.
    }
    expect(helper).toBe("");

    const scratch = join(root, "checkpoint");
    expect(await prepareCheckpointScratch(scratch)).toBe(true);
    const refs = { branch: "task-branch", baseSha, parentSha: baseSha, headSha: baseSha };
    expect(await status(target, scratch, refs, io)).toEqual({
      kind: "ok",
      status: {
        branch: "task-branch",
        headSha: baseSha,
        baseSha,
        ahead: 0,
        behind: 0,
        dirty: false,
        changedFileCount: 0,
        untrackedFileCount: 0,
        additions: 0,
        deletions: 0,
      },
    });
  });
});

/**
 * Record 07, "Resuming after the branch moved", against real git. The origin is
 * served over `file://` so git copies only what the branch reaches, as a clone
 * from GitHub does; a plain path would hard-link every object and hide the fetch.
 */
describe("clone when the branch moved, against real git", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function movedOrigin() {
    const root = mkdtempSync(join(tmpdir(), "oncue-git-moved-"));
    dirsToClean.push(root);
    const origin = realOrigin(root);
    const workDir = join(root, "work");
    // GitHub answers a fetch by id for a commit no branch reaches; this is
    // git's own switch for the same.
    git(["config", "uploadpack.allowAnySHA1InWant", "true"], origin.bareDir);
    const commitAndPush = (file: string, text: string) => {
      writeFileSync(join(workDir, file), text);
      git(["add", file], workDir);
      git(["commit", "-q", "-m", `add ${file}`], workDir);
      git(["push", "-q", "origin", "task-branch"], workDir);
      return git(["rev-parse", "HEAD"], workDir).trim();
    };
    /** Replace the branch's history: a new root commit, force-pushed. */
    const rewrite = () => {
      git(["checkout", "-q", "--orphan", "rewritten"], workDir);
      git(["rm", "-q", "-r", "--cached", "."], workDir);
      writeFileSync(join(workDir, "fresh.txt"), "a new history\n");
      git(["add", "fresh.txt"], workDir);
      git(["commit", "-q", "-m", "rewritten"], workDir);
      git(["push", "-q", "--force", "origin", "rewritten:task-branch"], workDir);
      return git(["rev-parse", "HEAD"], workDir).trim();
    };
    const grant = (ownBranch: boolean): CloneGrant => ({
      token: "unused-in-this-test",
      cloneUrl: `file://${origin.bareDir}`,
      branch: "task-branch",
      baseSha: origin.baseSha,
      ownBranch,
    });
    return {
      ...origin,
      root,
      workDir,
      target: join(root, "clone"),
      commitAndPush,
      rewrite,
      grant,
    };
  }

  it("a tip that is the grant's commit is unchanged: at_tip, no fetch", async () => {
    const o = movedOrigin();
    const outcome = await clone(singleUse(o.grant(false)), o.target, o.io);
    expect(outcome).toMatchObject({ kind: "cloned", headSha: o.baseSha, landing: "at_tip" });
    expect(git(["rev-parse", "HEAD"], o.target).trim()).toBe(o.baseSha);
  });

  it("the base branch moved ahead: the tree is at the session's base on its branch, and a saved patch applies on top", async () => {
    const o = movedOrigin();
    // The saved edits, taken against the base as a checkpoint takes them.
    git(["checkout", "-q", "-b", "edits"], o.workDir);
    writeFileSync(join(o.workDir, "file.txt"), "hello, edited\n");
    git(["commit", "-q", "-am", "edit"], o.workDir);
    const patchPath = join(o.root, "restore.patch");
    writeFileSync(patchPath, git(["diff", "--binary", o.baseSha, "HEAD"], o.workDir));
    git(["checkout", "-q", "task-branch"], o.workDir);
    const moved = o.commitAndPush("later.txt", "someone else's work on main\n");

    const outcome = await clone(singleUse(o.grant(false)), o.target, o.io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: o.baseSha,
      tokenRevoked: true,
      landing: "base_moved",
      fallbackSha: null,
    });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], o.target).trim()).toBe("task-branch");
    expect(git(["rev-parse", "task-branch"], o.target).trim()).toBe(o.baseSha);
    expect(git(["status", "--porcelain"], o.target)).toBe("");
    expect(existsSync(join(o.target, "later.txt"))).toBe(false);
    // The branch on GitHub is untouched.
    expect(git(["rev-parse", "task-branch"], o.bareDir).trim()).toBe(moved);
    expect(readFileSync(join(o.target, ".git", "config"), "utf8")).toContain("pushurl = /dev/null");
    expect(o.revoked).toEqual(["unused-in-this-test"]);

    const restored = await applyRestore(o.target, patchPath, o.io);
    expect(restored.kind).toBe("restored");
    expect(readFileSync(join(o.target, "file.txt"), "utf8")).toBe("hello, edited\n");
    expect(git(["rev-parse", "HEAD~1"], o.target).trim()).toBe(o.baseSha);
  });

  it("the base is no longer on the branch but GitHub still has it: one fetch by id brings it back", async () => {
    const o = movedOrigin();
    o.rewrite();
    const outcome = await clone(singleUse(o.grant(false)), o.target, o.io);
    expect(outcome).toMatchObject({
      kind: "cloned",
      headSha: o.baseSha,
      landing: "base_moved",
    });
    expect(git(["rev-parse", "HEAD"], o.target).trim()).toBe(o.baseSha);
    expect(readFileSync(join(o.target, "file.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(o.target, "fresh.txt"))).toBe(false);
  });

  it("the base is gone from GitHub: commit_missing, and the token is revoked", async () => {
    const o = movedOrigin();
    const tip = o.rewrite();
    git(["reflog", "expire", "--expire=now", "--all"], o.bareDir);
    git(["gc", "-q", "--prune=now"], o.bareDir);
    const outcome = await clone(singleUse(o.grant(false)), o.target, o.io);
    expect(outcome).toEqual({
      kind: "commit_missing",
      expected: o.baseSha,
      branchTip: tip,
      tokenRevoked: true,
    });
    expect(o.revoked).toEqual(["unused-in-this-test"]);
  });

  it("someone pushed on top of the session's task branch: their commits are kept and the tree is at the new tip", async () => {
    const o = movedOrigin();
    const theirs = o.commitAndPush("theirs.txt", "a person's fix\n");
    const outcome = await clone(singleUse(o.grant(true)), o.target, o.io);
    expect(outcome).toEqual({
      kind: "cloned",
      headSha: theirs,
      tokenRevoked: true,
      landing: "branch_ahead",
      fallbackSha: o.baseSha,
    });
    expect(readFileSync(join(o.target, "theirs.txt"), "utf8")).toBe("a person's fix\n");
    expect(git(["rev-parse", "task-branch"], o.bareDir).trim()).toBe(theirs);
  });

  it("the session's task branch was rewritten on GitHub: the tree is at the session's own push, and GitHub keeps theirs", async () => {
    const o = movedOrigin();
    const tip = o.rewrite();
    const outcome = await clone(singleUse(o.grant(true)), o.target, o.io);
    expect(outcome).toMatchObject({
      kind: "cloned",
      headSha: o.baseSha,
      landing: "branch_rewritten",
      fallbackSha: null,
    });
    expect(git(["rev-parse", "HEAD"], o.target).trim()).toBe(o.baseSha);
    expect(git(["rev-parse", "task-branch"], o.bareDir).trim()).toBe(tip);
  });

  it("a branch deleted on GitHub is clone_failed branch_missing", async () => {
    const o = movedOrigin();
    git(["push", "-q", "origin", "HEAD:refs/heads/other"], o.workDir);
    git(["push", "-q", "origin", "--delete", "task-branch"], o.workDir);
    const outcome = await clone(singleUse(o.grant(true)), o.target, o.io);
    expect(outcome).toEqual({ kind: "clone_failed", reason: "branch_missing", tokenRevoked: true });
  });
});

describe("checkpoint against real git", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function clonedWorkTree() {
    const root = mkdtempSync(join(tmpdir(), "oncue-ckpt-"));
    dirsToClean.push(root);
    const origin = realOrigin(root);
    const target = join(root, "clone");
    const scratch = join(root, "checkpoint");
    expect(await prepareCheckpointScratch(scratch)).toBe(true);
    const cloned = await clone(
      singleUse({
        token: "unused",
        cloneUrl: origin.bareDir,
        branch: "task-branch",
        baseSha: origin.baseSha,
      }),
      target,
      origin.io,
    );
    expect(cloned.kind).toBe("cloned");
    return { ...origin, root, target, scratch };
  }

  it("a clean tree is unchanged and nothing under .git is written", async () => {
    const { target, scratch, baseSha, io } = await clonedWorkTree();
    const before = gitDirListing(target);
    expect(await snapshot(target, scratch, baseSha, "m", io)).toEqual({
      kind: "unchanged",
      sha: baseSha,
    });
    expect(gitDirListing(target)).toEqual(before);
  });

  it("snapshots a dirty tree without touching HEAD, the index, or the objects, and pushes only the exact session ref", async () => {
    const { target, scratch, baseSha, bareDir, io, revoked } = await clonedWorkTree();
    writeFileSync(join(target, "file.txt"), "hello\nworld\n");
    writeFileSync(join(target, "new.txt"), "new\n");
    rmSync(join(target, "gone.txt"));
    // The clone carries no identity, and a clean machine may have no global one.
    git(
      [
        "-c",
        "user.name=Agent",
        "-c",
        "user.email=agent@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "the agent's own commit",
      ],
      target,
    );
    const agentHead = git(["rev-parse", "HEAD"], target).trim();
    const statusBefore = git(["status", "--porcelain"], target);
    const objectsBefore = readdirSync(join(target, ".git", "objects"), { recursive: true });
    const gitDirBefore = gitDirListing(target);

    const snapped = await snapshot(target, scratch, baseSha, "OnCue checkpoint (idle)", io);
    expect(snapped.kind).toBe("committed");
    const sha = snapped.kind === "committed" ? snapped.sha : "";

    expect(git(["rev-parse", "HEAD"], target).trim()).toBe(agentHead);
    expect(git(["status", "--porcelain"], target)).toBe(statusBefore);
    expect(readdirSync(join(target, ".git", "objects"), { recursive: true })).toEqual(
      objectsBefore,
    );
    expect(gitDirListing(target)).toEqual(gitDirBefore);
    expect(readdirSync(join(scratch, "objects")).length).toBeGreaterThan(0);

    // The checkpoint commit is parented on the durable head, not on the
    // agent's commit, so the remote sees a fast-forward from where it is.
    const env = checkpointEnv(io, target, scratch);
    const parent = execFileSync("git", ["rev-parse", `${sha}^`], {
      cwd: target,
      env,
      encoding: "utf8",
    });
    expect(parent.trim()).toBe(baseSha);
    const shown = execFileSync("git", ["show", "--stat", "--format=%an <%ae> %s", sha], {
      cwd: target,
      env,
      encoding: "utf8",
    });
    expect(shown).toContain("OnCue <checkpoint@oncue.invalid> OnCue checkpoint (idle)");
    expect(shown).toContain("new.txt");
    expect(shown).toContain("gone.txt");

    for (const [ref, branch] of [
      ["refs/heads/main", "task-branch"],
      ["refs/heads/oncue/x/../main", "oncue/x/../main"],
      ["+refs/heads/task-branch", "task-branch"],
      ["refs/tags/v1", "task-branch"],
    ] as const) {
      const refused = await pushExact(
        singleUse({ token: PUSH_TOKEN, cloneUrl: bareDir, ref }),
        sha,
        branch,
        target,
        scratch,
        io,
      );
      expect(refused).toEqual({ kind: "refused", reason: "ref_mismatch", tokenRevoked: true });
    }
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(baseSha);
    expect(() => git(["rev-parse", "--verify", "refs/heads/main"], bareDir)).toThrow();

    const pushed = await pushExact(
      singleUse({ token: PUSH_TOKEN, cloneUrl: bareDir, ref: "refs/heads/task-branch" }),
      sha,
      "task-branch",
      target,
      scratch,
      io,
    );
    expect(pushed).toEqual({ kind: "pushed", tokenRevoked: true });
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(sha);
    expect(git(["rev-parse", "HEAD"], target).trim()).toBe(agentHead);
    expect(git(["status", "--porcelain"], target)).toBe(statusBefore);
    expect(gitDirListing(target)).toEqual(gitDirBefore);
    expect(revoked.filter((token) => token === PUSH_TOKEN)).toHaveLength(5);
    for (const name of ["config", "HEAD"]) {
      expect(readFileSync(join(target, ".git", name), "utf8")).not.toContain(PUSH_TOKEN);
    }
  });

  it("runs nothing the agent configured and pushes only where the grant says, however the tree's .git is set up", async () => {
    const { root, target, scratch, baseSha, bareDir, io } = await clonedWorkTree();
    const markers = join(root, "markers");
    mkdirSync(markers);
    const script = (name: string) => {
      const path = join(root, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch "${join(markers, name)}"\ncat\n`, { mode: 0o755 });
      return path;
    };
    const decoy = join(root, "decoy.git");
    git(["init", "--bare", "-q", decoy], root);
    // Everything below is what the agent's uid can write once the tree is
    // handed over. No git command runs in `target` after this point, because
    // the test's own git would obey it.
    appendFileSync(
      join(target, ".git", "config"),
      [
        "[core]",
        `\tfsmonitor = ${script("fsmonitor")}`,
        `\thooksPath = ${join(target, ".git", "hooks")}`,
        '[filter "evil"]',
        `\tclean = ${script("filter")}`,
        "[diff]",
        `\texternal = ${script("external-diff")}`,
        '[diff "evil"]',
        `\ttextconv = ${script("textconv")}`,
        `[url "${decoy}"]`,
        `\tpushInsteadOf = ${bareDir}`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(target, ".git", "hooks"), { recursive: true });
    writeFileSync(join(target, ".git", "hooks", "pre-push"), readFileSync(script("pre-push")), {
      mode: 0o755,
    });
    writeFileSync(join(target, ".gitattributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(target, "file.txt"), "hello\nagent\n");

    const snapped = await snapshot(target, scratch, baseSha, "OnCue checkpoint (idle)", io);
    expect(snapped.kind).toBe("committed");
    const sha = snapped.kind === "committed" ? snapped.sha : "";
    const pushed = await pushExact(
      singleUse({ token: PUSH_TOKEN, cloneUrl: bareDir, ref: "refs/heads/task-branch" }),
      sha,
      "task-branch",
      target,
      scratch,
      io,
    );
    const patch = await patchBetween(baseSha, sha, target, scratch, io);

    expect(readdirSync(markers)).toEqual([]);
    expect(pushed).toEqual({ kind: "pushed", tokenRevoked: true });
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(sha);
    expect(git(["for-each-ref"], decoy)).toBe("");
    expect(git(["show", `${sha}:file.txt`], bareDir)).toBe("hello\nagent\n");
    expect(patch.kind === "ok" ? patch.patch : "").toContain("+agent");
  });

  it("a failed push leaves a patch bundle that applyRestore replays on a fresh clone", async () => {
    const { root, target, scratch, baseSha, bareDir, io } = await clonedWorkTree();
    writeFileSync(join(target, "file.txt"), "hello\nworld\n");
    writeFileSync(join(target, "new.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    rmSync(join(target, "gone.txt"));
    const snapped = await snapshot(target, scratch, baseSha, "m", io);
    const sha = snapped.kind === "committed" ? snapped.sha : "";
    expect(sha).not.toBe("");

    const pushed = await pushExact(
      singleUse({
        token: PUSH_TOKEN,
        cloneUrl: join(root, "does-not-exist.git"),
        ref: "refs/heads/task-branch",
      }),
      sha,
      "task-branch",
      target,
      scratch,
      io,
    );
    expect(pushed.kind).toBe("push_failed");
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(baseSha);

    const patch = await patchBetween(baseSha, sha, target, scratch, io);
    expect(patch.kind).toBe("ok");
    const text = patch.kind === "ok" ? patch.patch : "";
    expect(text).toContain("GIT binary patch");
    expect(text).toContain("deleted file mode");

    const fresh = join(root, "fresh");
    const cloned = await clone(
      singleUse({ token: "unused", cloneUrl: bareDir, branch: "task-branch", baseSha }),
      fresh,
      io,
    );
    expect(cloned.kind).toBe("cloned");
    const patchPath = join(scratch, "restore.patch");
    writeFileSync(patchPath, text);
    const restored = await applyRestore(fresh, patchPath, io);
    expect(restored.kind).toBe("restored");
    expect(readFileSync(join(fresh, "file.txt"), "utf8")).toBe("hello\nworld\n");
    expect(readFileSync(join(fresh, "new.bin"))).toEqual(Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    expect(() => readFileSync(join(fresh, "gone.txt"))).toThrow();
    expect(git(["status", "--porcelain"], fresh)).toBe("");
    expect(git(["log", "-1", "--format=%an %s"], fresh).trim()).toBe(
      "OnCue Restore the OnCue checkpoint bundle",
    );
    expect(git(["rev-parse", "HEAD^"], fresh).trim()).toBe(baseSha);
  });

  /**
   * A push grant naming `refs/heads/main`, as a confused or hostile control-plane
   * frame might send, on real git: nothing may reach the repository, not `main`
   * and not the session branch, because a grant for the wrong ref is not a grant
   * for the right one.
   */
  it("a grant naming main pushes nothing anywhere, starts no push process, and is revoked", async () => {
    const { target, scratch, baseSha, bareDir, io, revoked } = await clonedWorkTree();
    git(["branch", "main", baseSha], bareDir);
    writeFileSync(join(target, "file.txt"), "changed by the agent\n");
    const pushes: string[][] = [];
    const watched: GitIo = {
      ...io,
      runGit: (argv, options, secretLines) => {
        if (argv.includes("push")) {
          pushes.push([...argv]);
        }
        return io.runGit(argv, options, secretLines);
      },
    };

    const result = await runCheckpoint(
      {
        workTree: target,
        scratchDir: scratch,
        durableHeadSha: baseSha,
        parentSha: baseSha,
        sessionBranch: "task-branch",
        cloneBranch: null,
        reason: "user_requested",
        message: "Add a README section.",
        pushGrant: singleUse({ token: PUSH_TOKEN, cloneUrl: bareDir, ref: "refs/heads/main" }),
      },
      watched,
    );

    expect(result).toMatchObject({
      kind: "bundled",
      pushOutcome: { kind: "refused", reason: "ref_mismatch" },
    });
    expect(pushes).toEqual([]);
    expect(git(["rev-parse", "main"], bareDir).trim()).toBe(baseSha);
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(baseSha);
    // The clone's own token was revoked by the helper; the refused push's is the last.
    expect(revoked.at(-1)).toBe(PUSH_TOKEN);
  });

  it("pushes to the grant's repository even when the tree's .git rewrites that URL", async () => {
    const { root, target, scratch, baseSha, bareDir, io } = await clonedWorkTree();
    const decoy = join(root, "decoy.git");
    git(["init", "--bare", "-q", decoy], root);
    appendFileSync(
      join(target, ".git", "config"),
      [
        `[url "${decoy}"]`,
        `\tpushInsteadOf = ${bareDir}`,
        `[remote "${bareDir}"]`,
        `\tpushurl = ${decoy}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(target, "file.txt"), "hello\nagent\n");

    const snapped = await snapshot(target, scratch, baseSha, "OnCue checkpoint (idle)", io);
    const sha = snapped.kind === "committed" ? snapped.sha : "";
    const pushed = await pushExact(
      singleUse({ token: PUSH_TOKEN, cloneUrl: bareDir, ref: "refs/heads/task-branch" }),
      sha,
      "task-branch",
      target,
      scratch,
      io,
    );

    expect(pushed).toEqual({ kind: "pushed", tokenRevoked: true });
    expect(git(["rev-parse", "task-branch"], bareDir).trim()).toBe(sha);
    expect(git(["for-each-ref"], decoy)).toBe("");
  });

  it("clears an index lock an interrupted checkpoint left, so the next one runs", async () => {
    const { target, scratch, baseSha, io } = await clonedWorkTree();
    writeFileSync(join(scratch, "index.lock"), "");
    writeFileSync(join(target, "file.txt"), "hello\nagain\n");

    expect(await prepareCheckpointScratch(scratch)).toBe(true);
    expect((await snapshot(target, scratch, baseSha, "m", io)).kind).toBe("committed");
  });
});

describe("diffs against real git", () => {
  const dirsToClean: string[] = [];
  const DIFF_INDEX = { indexFile: "diff-index" } as const;

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** An origin whose base has a file to modify, delete, rename, and a binary one, cloned the way the bridge clones. */
  async function clonedBase() {
    const root = mkdtempSync(join(tmpdir(), "oncue-diff-"));
    dirsToClean.push(root);
    const origin = realOrigin(root);
    const seed = join(root, "work");
    writeFileSync(join(seed, "keep.txt"), "one\ntwo\nthree\n");
    writeFileSync(
      join(seed, "old-name.txt"),
      Array.from({ length: 20 }, (_, line) => `line ${line}\n`).join(""),
    );
    writeFileSync(join(seed, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "base"], seed);
    git(["push", "-q", "origin", "task-branch"], seed);
    const baseSha = git(["rev-parse", "HEAD"], seed).trim();
    const target = join(root, "clone");
    const scratch = join(root, "checkpoint");
    expect(await prepareCheckpointScratch(scratch)).toBe(true);
    const cloned = await clone(
      singleUse({ token: "unused", cloneUrl: origin.bareDir, branch: "task-branch", baseSha }),
      target,
      origin.io,
    );
    expect(cloned.kind).toBe("cloned");
    return { root, target, scratch, baseSha, io: origin.io };
  }

  /** What the agent owns under `.git` that a bridge read must leave as it was. */
  function agentGitState(target: string) {
    return {
      head: readFileSync(join(target, ".git", "HEAD"), "utf8"),
      index: readFileSync(join(target, ".git", "index")).toString("base64"),
      listing: gitDirListing(target),
    };
  }

  function editLikeAnAgent(target: string) {
    writeFileSync(join(target, "keep.txt"), "one\n2\nthree\nfour\n");
    rmSync(join(target, "gone.txt"));
    const moved = readFileSync(join(target, "old-name.txt"));
    rmSync(join(target, "old-name.txt"));
    writeFileSync(join(target, "new-name.txt"), moved);
    writeFileSync(join(target, "logo.bin"), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    writeFileSync(join(target, "untracked.txt"), "fresh\nfile\n");
  }

  it("lists added, modified, deleted, renamed, and binary files with their counts and patch, and leaves the agent's index and HEAD alone", async () => {
    const { target, scratch, baseSha, io } = await clonedBase();
    editLikeAnAgent(target);
    git(["add", "keep.txt"], target);
    const porcelain = git(["status", "--porcelain"], target);
    const before = agentGitState(target);

    const snapped = await snapshot(target, scratch, baseSha, "turn", io, DIFF_INDEX);
    expect(snapped.kind).toBe("committed");
    const head = snapped.kind === "committed" ? snapped.sha : "";
    const refs = { branch: "task-branch", baseSha, parentSha: baseSha, headSha: head };
    const measured = await status(target, scratch, refs, io);
    const diff = await diffBetween(baseSha, head, target, scratch, io);

    expect(agentGitState(target)).toEqual(before);
    expect(git(["status", "--porcelain"], target)).toBe(porcelain);
    expect(git(["rev-parse", "HEAD"], target).trim()).toBe(baseSha);

    expect(diff.kind).toBe("ok");
    if (diff.kind !== "ok") {
      return;
    }
    expect([...diff.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 },
      { path: "keep.txt", status: "modified", additions: 2, deletions: 1 },
      { path: "logo.bin", status: "modified", additions: 0, deletions: 0 },
      {
        path: "new-name.txt",
        status: "renamed",
        previousPath: "old-name.txt",
        additions: 0,
        deletions: 0,
      },
      { path: "untracked.txt", status: "added", additions: 2, deletions: 0 },
    ]);
    expect(diff).toMatchObject({
      baseSha,
      headSha: head,
      additions: 4,
      deletions: 2,
      truncated: false,
    });
    expect(diff.patch).toContain("+four");
    expect(diff.patch).toContain("rename from old-name.txt");
    expect(diff.patch).toContain("Binary files a/logo.bin and b/logo.bin differ");

    expect(measured).toEqual({
      kind: "ok",
      status: {
        branch: "task-branch",
        headSha: head,
        baseSha,
        ahead: 1,
        behind: 0,
        dirty: true,
        changedFileCount: 5,
        untrackedFileCount: 2,
        additions: 4,
        deletions: 2,
      },
    });
  });

  it("measures a turn from its own snapshot, and a reused index still sees every later change", async () => {
    const { target, scratch, baseSha, io } = await clonedBase();
    writeFileSync(join(target, "keep.txt"), "one\ntwo\nthree\nearlier\n");
    const first = await snapshot(target, scratch, baseSha, "turn base", io, DIFF_INDEX);
    const turnBase = first.kind === "committed" ? first.sha : "";
    editLikeAnAgent(target);
    const second = await snapshot(target, scratch, baseSha, "end", io, {
      ...DIFF_INDEX,
      reuseIndex: true,
    });
    const end = second.kind === "committed" ? second.sha : "";
    const fresh = await snapshot(target, scratch, baseSha, "end", io, DIFF_INDEX);

    const turn = await diffBetween(turnBase, end, target, scratch, io);
    expect(turn.kind === "ok" ? turn.files.map((file) => file.path).sort() : []).toEqual([
      "gone.txt",
      "keep.txt",
      "logo.bin",
      "new-name.txt",
      "untracked.txt",
    ]);
    const freshSha = fresh.kind === "committed" ? fresh.sha : "";
    expect(await diffBetween(end, freshSha, target, scratch, io)).toMatchObject({
      kind: "ok",
      files: [],
      patch: "",
    });
  });

  it("runs nothing the agent configured, whatever its config and attributes say", async () => {
    const { root, target, scratch, baseSha, io } = await clonedBase();
    const markers = join(root, "markers");
    mkdirSync(markers);
    const script = (name: string, output: string) => {
      const path = join(root, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch "${join(markers, name)}"\necho ${output}\n`, {
        mode: 0o755,
      });
      return path;
    };
    // Written the way the agent's uid can once the tree is handed over. No
    // git command runs in `target` after this, because the test's own git
    // would obey it.
    appendFileSync(
      join(target, ".git", "config"),
      [
        "[core]",
        `\tfsmonitor = ${script("fsmonitor", "")}`,
        `\tpager = ${script("pager", "PAGED")}`,
        `\thooksPath = ${join(root, "hooks")}`,
        '[filter "evil"]',
        `\tclean = ${script("clean", "CLEANED")}`,
        `\tsmudge = ${script("smudge", "SMUDGED")}`,
        "[diff]",
        `\texternal = ${script("external-diff", "EXTERNAL")}`,
        '[diff "evil"]',
        `\ttextconv = ${script("textconv", "CONVERTED")}`,
        `\tcommand = ${script("diff-driver", "DRIVEN")}`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(root, "hooks"));
    for (const hook of ["post-index-change", "reference-transaction", "post-commit"]) {
      writeFileSync(join(root, "hooks", hook), readFileSync(script(hook, "")), { mode: 0o755 });
    }
    mkdirSync(join(target, ".git", "info"), { recursive: true });
    writeFileSync(join(target, ".git", "info", "attributes"), "* diff=evil filter=evil\n");
    writeFileSync(join(target, ".gitattributes"), "* diff=evil filter=evil\n");
    writeFileSync(join(target, "keep.txt"), "one\ntwo\nthree\nagent\n");
    const before = agentGitState(target);

    const snapped = await snapshot(target, scratch, baseSha, "end", io, DIFF_INDEX);
    const head = snapped.kind === "committed" ? snapped.sha : "";
    const refs = { branch: "task-branch", baseSha, parentSha: baseSha, headSha: head };
    const measured = await status(target, scratch, refs, io);
    const diff = await diffBetween(baseSha, head, target, scratch, io);

    expect(readdirSync(markers)).toEqual([]);
    expect(agentGitState(target)).toEqual(before);
    expect(measured.kind).toBe("ok");
    expect(diff.kind).toBe("ok");
    const patch = diff.kind === "ok" ? diff.patch : "";
    expect(patch).toContain("+agent");
    for (const output of ["CONVERTED", "EXTERNAL", "DRIVEN", "CLEANED", "PAGED"]) {
      expect(patch).not.toContain(output);
    }
    // The control: git run the ordinary way in the agent's tree does obey
    // that config, so an empty marker directory above is the scratch
    // environment's doing and not a script that could never run.
    expect(git(["diff", "HEAD"], target)).toContain("DRIVEN");
    expect(readdirSync(markers)).toContain("diff-driver");
  });

  it("cuts a patch past its size bound and says truncated, keeping every file's counts", async () => {
    const { target, scratch, baseSha, io } = await clonedBase();
    writeFileSync(
      join(target, "big.txt"),
      Array.from({ length: 20_000 }, (_, line) => `a long enough line number ${line}\n`).join(""),
    );
    const snapped = await snapshot(target, scratch, baseSha, "end", io, DIFF_INDEX);
    const head = snapped.kind === "committed" ? snapped.sha : "";

    const diff = await diffBetween(baseSha, head, target, scratch, io, {
      timeoutMs: 60_000,
      maxPatchBytes: 10_000,
    });
    expect(diff).toMatchObject({
      kind: "ok",
      truncated: true,
      additions: 20_000,
      files: [{ path: "big.txt", status: "added", additions: 20_000, deletions: 0 }],
    });
    expect(Buffer.byteLength(diff.kind === "ok" ? diff.patch : "")).toBeLessThanOrEqual(10_000);
  });

  it("fails timed_out, never hanging, past its time bound", async () => {
    const { target, scratch, baseSha, io } = await clonedBase();
    writeFileSync(join(target, "keep.txt"), "changed\n");
    const snapped = await snapshot(target, scratch, baseSha, "end", io, DIFF_INDEX);
    const head = snapped.kind === "committed" ? snapped.sha : "";
    const slow: GitIo = {
      ...io,
      runGit: (argv, options, secretLines) =>
        nodeRunGit(["sh", "-c", "sleep 5", ...argv.slice(0, 0)], options, secretLines),
    };
    expect(
      await diffBetween(baseSha, head, target, scratch, slow, { timeoutMs: 50, maxPatchBytes: 1 }),
    ).toEqual({ kind: "failed", detail: "timed_out" });
    expect(
      await snapshot(target, scratch, baseSha, "end", slow, { ...DIFF_INDEX, timeoutMs: 50 }),
    ).toEqual({ kind: "failed", detail: "timed_out" });
    expect(
      await status(
        target,
        scratch,
        { branch: "b", baseSha, parentSha: baseSha, headSha: head },
        slow,
        50,
      ),
    ).toEqual({ kind: "failed", detail: "timed_out" });
  });
});

describe("listTreePaths", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every path of the snapshot's tree, nested and unquoted, without touching the agent's git dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "oncue-tree-"));
    dirsToClean.push(root);
    const origin = realOrigin(root);
    const seed = join(root, "work");
    mkdirSync(join(seed, "src", "deep"), { recursive: true });
    writeFileSync(join(seed, "src", "deep", "index.ts"), "export {};\n");
    writeFileSync(join(seed, "src", "caf\u00e9 note.md"), "# hi\n");
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "tree"], seed);
    git(["push", "-q", "origin", "task-branch"], seed);
    const baseSha = git(["rev-parse", "HEAD"], seed).trim();
    const target = join(root, "clone");
    const scratch = join(root, "checkpoint");
    expect(await prepareCheckpointScratch(scratch)).toBe(true);
    const cloned = await clone(
      singleUse({ token: "unused", cloneUrl: origin.bareDir, branch: "task-branch", baseSha }),
      target,
      origin.io,
    );
    expect(cloned.kind).toBe("cloned");
    const before = gitDirListing(target);

    const paths = await listTreePaths(baseSha, target, scratch, origin.io);
    expect(paths).toEqual(["file.txt", "gone.txt", "src/caf\u00e9 note.md", "src/deep/index.ts"]);
    expect(gitDirListing(target)).toEqual(before);
    // A commit that is not there lists nothing, and says so with null.
    expect(await listTreePaths("f".repeat(40), target, scratch, origin.io)).toBeNull();
  });

  it("runs ls-tree in the scratch environment, splits on NUL, and cuts a listing past the ceiling", async () => {
    const many = Array.from({ length: MAX_TREE_PATHS + 5 }, (_, index) => `p${index}`).join("\0");
    const { io, calls } = fakeIo(() => ({ code: 0, stdout: `${many}\0`, stderr: "" }));
    const paths = await listTreePaths(COMMIT, WORK, SCRATCH, io, 5_000);
    expect(paths).toHaveLength(MAX_TREE_PATHS);
    expect(paths?.[0]).toBe("p0");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.slice(-5)).toEqual(["ls-tree", "-r", "--name-only", "-z", COMMIT]);
    expect(calls[0]?.env.GIT_DIR).toBe(`${SCRATCH}/git`);
    expect(calls[0]?.options.timeoutMs).toBeLessThanOrEqual(5_000);

    const failing = fakeIo(() => ({ code: 128, stdout: "", stderr: "fatal: not a tree" }));
    expect(await listTreePaths(COMMIT, WORK, SCRATCH, failing.io)).toBeNull();
    const slow = fakeIo(() => ({ code: 0, stdout: "", stderr: "", timedOut: true }));
    expect(await listTreePaths(COMMIT, WORK, SCRATCH, slow.io)).toBeNull();
  });
});

describe("killProcessGroup", () => {
  it("kills the child alone when it has no pid", () => {
    const signals: string[] = [];
    killProcessGroup({
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
    });
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("falls back to the child alone when its group is already gone", () => {
    const signals: string[] = [];
    // A pid above any the kernel hands out names no process group, so the group kill throws.
    killProcessGroup({
      pid: 2 ** 22 + 7,
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
    });
    expect(signals).toEqual(["SIGKILL"]);
  });
});

describe("fetchRevoke", () => {
  it("bounds the revocation request, and a request that never answers is not ok with no status", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const ok = fetchRevoke((async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    await expect(ok("ghs_x")).resolves.toEqual({ ok: true, status: 204 });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(REVOKE_TIMEOUT_MS).toBe(15_000);

    const hung = fetchRevoke((async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch);
    await expect(hung("ghs_x")).resolves.toEqual({ ok: false, status: null });
  });
});
