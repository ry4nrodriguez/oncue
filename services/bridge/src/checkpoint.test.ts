import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TRANSFER_TIMEOUT_MS,
  checkpointMessage,
  describeCheckpoint,
  downloadRestore,
  fetchArtifactIo,
  runCheckpoint,
  SNAPSHOT_TIMEOUT_MS,
  sha256Hex,
  UPLOAD_CHECKSUM_HEADER,
  uploadArtifact,
} from "./checkpoint";
import { type GitIo, type GitProcessResult, type PushGrant, singleUse } from "./git";

const WORK = "/workspace";
const SCRATCH = "/opt/oncue/checkpoint";
const PARENT = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TOKEN = "ghs_push-secret";
const GRANT: PushGrant = {
  token: TOKEN,
  cloneUrl: "https://github.example/acme/widgets.git",
  ref: "refs/heads/oncue/x",
};

interface RecordedCall {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly secretLines: readonly string[] | null;
  readonly timeoutMs?: number | undefined;
}

const OK: GitProcessResult = { code: 0, stdout: "", stderr: "" };
const out = (text: string): GitProcessResult => ({ code: 0, stdout: `${text}\n`, stderr: "" });

/** The git subcommand: the first argv entry after `git` that is neither `-c` nor a `-c` value nor a flag. */
function subcommand(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index - 1] === "-c" || argv[index]?.startsWith("-")) {
      continue;
    }
    return argv[index] ?? "";
  }
  return "";
}

function fakeGit(overrides: Partial<Record<string, GitProcessResult>> = {}) {
  const script: Record<string, GitProcessResult> = {
    "read-tree": OK,
    add: OK,
    "write-tree": out(TREE),
    "rev-parse": out("d".repeat(40)),
    "commit-tree": out(COMMIT),
    push: OK,
    diff: { code: 0, stdout: "diff --git a/f b/f\n--- a/f\n+++ b/f\n", stderr: "" },
    ...overrides,
  };
  const calls: RecordedCall[] = [];
  const revoked: string[] = [];
  const io: GitIo = {
    async runGit(argv, options, secretLines) {
      calls.push({ argv, env: options.env, secretLines, timeoutMs: options.timeoutMs });
      const sub = subcommand(argv);
      return script[sub] ?? { code: 1, stdout: "", stderr: `unscripted: ${sub}` };
    },
    async revoke(token) {
      revoked.push(token);
      return { ok: true, status: 204 };
    },
    env: { PATH: "/usr/bin", HOME: "/home/oncue-bridge" },
    askpassPath: "/opt/oncue/askpass",
  };
  return { io, calls, revoked, subs: () => calls.map((call) => subcommand(call.argv)) };
}

function input(pushGrant: PushGrant | null) {
  return {
    workTree: WORK,
    scratchDir: SCRATCH,
    durableHeadSha: PARENT,
    parentSha: PARENT,
    sessionBranch: "oncue/x",
    cloneBranch: "oncue/x",
    reason: "idle",
    pushGrant: pushGrant === null ? null : singleUse(pushGrant),
  };
}

describe("describeCheckpoint", () => {
  it("names each outcome and why a push was skipped, with a short commit id and nothing else", () => {
    const lines = [
      describeCheckpoint({ kind: "failed", detail: "add_failed" }),
      describeCheckpoint({ kind: "unchanged", headSha: PARENT }),
      describeCheckpoint({ kind: "pushed", headSha: COMMIT, tokenRevoked: true }),
      describeCheckpoint({
        kind: "bundled",
        headSha: COMMIT,
        patch: `diff --git a/secret b/secret\n+${TOKEN}\n`,
        pushOutcome: { kind: "push_failed", reason: "authentication_failed" },
      }),
      describeCheckpoint({
        kind: "bundled",
        headSha: COMMIT,
        patch: "",
        pushOutcome: { kind: "refused", reason: "ref_mismatch" },
      }),
      describeCheckpoint({
        kind: "committed_only",
        headSha: COMMIT,
        pushOutcome: { kind: "no_grant" },
      }),
      describeCheckpoint({
        kind: "committed_only",
        headSha: COMMIT,
        pushOutcome: { kind: "grant_spent" },
      }),
    ];
    expect(lines).toEqual([
      "checkpoint failed: add_failed",
      "checkpoint unchanged at aaaaaaaa",
      "checkpoint pushed cccccccc; token revoked: true",
      "checkpoint cccccccc bundled as a patch; push: push_failed (authentication_failed)",
      "checkpoint cccccccc bundled as a patch; push: refused (ref_mismatch)",
      "checkpoint cccccccc committed only; push: no_grant",
      "checkpoint cccccccc committed only; push: grant_spent",
    ]);
    // A bundle's patch can hold anything the agent wrote; none of it is logged.
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("diff --git");
  });
});

describe("runCheckpoint", () => {
  it("bounds the snapshot by wall-clock time, and one killed at its bound fails as timed_out with the grant revoked", async () => {
    const { io, calls, revoked } = fakeGit({
      add: { code: null, stdout: "", stderr: "", timedOut: true },
    });
    expect(await runCheckpoint(input(GRANT), io)).toEqual({ kind: "failed", detail: "timed_out" });
    for (const call of calls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(SNAPSHOT_TIMEOUT_MS);
    }
    expect(revoked).toEqual([TOKEN]);
  });

  it("snapshot failed: failed with the category, and an unused grant's token revoked", async () => {
    const { io, revoked, subs } = fakeGit({ add: { code: 1, stdout: "", stderr: "x" } });
    expect(await runCheckpoint(input(GRANT), io)).toEqual({ kind: "failed", detail: "add_failed" });
    expect(subs()).toEqual(["read-tree", "add"]);
    expect(revoked).toEqual([TOKEN]);
  });

  it("unchanged: names the parent and revokes the unused grant's token without a push", async () => {
    const { io, revoked, subs } = fakeGit({ "rev-parse": out(TREE) });
    expect(await runCheckpoint(input(GRANT), io)).toEqual({ kind: "unchanged", headSha: PARENT });
    expect(subs()).not.toContain("push");
    expect(revoked).toEqual([TOKEN]);
  });

  it("unchanged with no grant revokes nothing", async () => {
    const { io, revoked } = fakeGit({ "rev-parse": out(TREE) });
    expect(await runCheckpoint(input(null), io)).toEqual({ kind: "unchanged", headSha: PARENT });
    expect(revoked).toEqual([]);
  });

  it("unchanged since the agent's last commit, but ahead of the durable head: that commit is pushed as it stands", async () => {
    const TIP = "e".repeat(40);
    const { io, subs } = fakeGit({ "rev-parse": out(TREE) });
    expect(
      await runCheckpoint({ ...input(GRANT), parentSha: TIP, durableHeadSha: PARENT }, io),
    ).toEqual({ kind: "pushed", headSha: TIP, tokenRevoked: true });
    expect(subs()).toEqual(["read-tree", "add", "write-tree", "rev-parse", "push"]);
  });

  it("unchanged since the agent's last commit, with no grant: bundled from the durable head, not from the commit", async () => {
    const TIP = "e".repeat(40);
    const { io, calls } = fakeGit({ "rev-parse": out(TREE) });
    const result = await runCheckpoint(
      { ...input(null), parentSha: TIP, durableHeadSha: PARENT },
      io,
    );
    expect(result).toMatchObject({ kind: "bundled", headSha: TIP });
    const diff = calls.find((call) => subcommand(call.argv) === "diff");
    expect(diff?.argv).toContain(PARENT);
    expect(diff?.argv).toContain(TIP);
  });

  it("a new commit on top of the agent's chain is parented on the chain's tip and measured from the durable head", async () => {
    const TIP = "e".repeat(40);
    const { io, calls } = fakeGit();
    expect(
      await runCheckpoint({ ...input(null), parentSha: TIP, durableHeadSha: PARENT }, io),
    ).toMatchObject({ kind: "bundled", headSha: COMMIT });
    const commitTree = calls.find((call) => subcommand(call.argv) === "commit-tree");
    expect(commitTree?.argv).toContain(TIP);
    const diff = calls.find((call) => subcommand(call.argv) === "diff");
    expect(diff?.argv).toContain(PARENT);
    expect(diff?.argv).not.toContain(TIP);
  });

  it("committed with a grant for the session ref: pushed, and the token seen only on fd 3", async () => {
    const { io, calls, revoked, subs } = fakeGit();
    expect(await runCheckpoint(input(GRANT), io)).toEqual({
      kind: "pushed",
      headSha: COMMIT,
      tokenRevoked: true,
    });
    expect(subs()).toEqual(["read-tree", "add", "write-tree", "rev-parse", "commit-tree", "push"]);
    const push = calls.at(-1);
    expect(push?.argv).toContain(`${COMMIT}:${GRANT.ref}`);
    expect(push?.secretLines).toEqual([TOKEN]);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(TOKEN);
      expect(Object.values(call.env).join(" ")).not.toContain(TOKEN);
    }
    expect(revoked).toEqual([TOKEN]);
  });

  it("committed with no grant: bundled with the patch and no_grant", async () => {
    const { io, subs } = fakeGit();
    expect(await runCheckpoint(input(null), io)).toEqual({
      kind: "bundled",
      headSha: COMMIT,
      patch: "diff --git a/f b/f\n--- a/f\n+++ b/f\n",
      pushOutcome: { kind: "no_grant" },
    });
    expect(subs()).not.toContain("push");
    expect(subs().at(-1)).toBe("diff");
  });

  it("committed with a grant for another ref: refused without a push process, then bundled", async () => {
    const { io, subs, revoked } = fakeGit();
    expect(await runCheckpoint(input({ ...GRANT, ref: "refs/heads/main" }), io)).toMatchObject({
      kind: "bundled",
      headSha: COMMIT,
      pushOutcome: { kind: "refused", reason: "ref_mismatch" },
    });
    expect(subs()).not.toContain("push");
    expect(revoked).toEqual([TOKEN]);
  });

  it("committed with a push that fails: bundled with the classified reason", async () => {
    const { io } = fakeGit({
      push: { code: 1, stdout: "", stderr: "fatal: Authentication failed for 'https://...'" },
    });
    expect(await runCheckpoint(input(GRANT), io)).toMatchObject({
      kind: "bundled",
      pushOutcome: { kind: "push_failed", reason: "authentication_failed" },
    });
  });

  it("committed with a spent grant: bundled as grant_spent", async () => {
    const spent = singleUse(GRANT);
    spent.take();
    const { io, subs } = fakeGit();
    expect(await runCheckpoint({ ...input(null), pushGrant: spent }, io)).toMatchObject({
      kind: "bundled",
      pushOutcome: { kind: "grant_spent" },
    });
    expect(subs()).not.toContain("push");
  });

  it("committed, not pushed, and the diff fails: committed_only", async () => {
    const { io } = fakeGit({ diff: { code: 128, stdout: "", stderr: "bad object" } });
    expect(await runCheckpoint(input(null), io)).toEqual({
      kind: "committed_only",
      headSha: COMMIT,
      pushOutcome: { kind: "no_grant" },
    });
  });

  describe("with development secrets supplied", () => {
    /** Obviously fake. */
    const FAKE = "fake-secret-value-0001";
    const LEAKY = `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n+KEY=${FAKE}\n`;
    const scan = (patch: string) => (patch.includes(FAKE) ? [".env"] : []);

    it("pushes nothing and bundles nothing when the changes hold a value, and revokes the unused token", async () => {
      const { io, subs, revoked } = fakeGit({ diff: { code: 0, stdout: LEAKY, stderr: "" } });
      const result = await runCheckpoint({ ...input(GRANT), secretPathsIn: scan }, io);
      expect(result).toEqual({
        kind: "committed_only",
        headSha: COMMIT,
        pushOutcome: { kind: "withheld", reason: "secret_in_changes", paths: [".env"] },
      });
      expect(subs()).not.toContain("push");
      expect(revoked).toEqual([TOKEN]);
      expect(JSON.stringify(result)).not.toContain(FAKE);
      expect(describeCheckpoint(result)).toBe(
        `checkpoint ${COMMIT.slice(0, 8)} committed only; push: withheld (secret_in_changes)`,
      );
    });

    it("fails closed when the changes cannot be read to be scanned", async () => {
      const { io, subs } = fakeGit({ diff: { code: 128, stdout: "", stderr: "bad object" } });
      expect(await runCheckpoint({ ...input(GRANT), secretPathsIn: scan }, io)).toEqual({
        kind: "committed_only",
        headSha: COMMIT,
        pushOutcome: { kind: "withheld", reason: "secret_scan_failed", paths: [] },
      });
      expect(subs()).not.toContain("push");
    });

    it("scans before the push, then pushes clean changes as before", async () => {
      const { io, subs } = fakeGit();
      expect(await runCheckpoint({ ...input(GRANT), secretPathsIn: scan }, io)).toMatchObject({
        kind: "pushed",
      });
      expect(subs().indexOf("diff")).toBeLessThan(subs().indexOf("push"));
    });

    it("bundles clean changes that had no grant, reading the patch once", async () => {
      const { io, subs } = fakeGit();
      expect(await runCheckpoint({ ...input(null), secretPathsIn: scan }, io)).toMatchObject({
        kind: "bundled",
        pushOutcome: { kind: "no_grant" },
      });
      expect(subs().filter((sub) => sub === "diff")).toHaveLength(1);
    });
  });

  it("commits a publish under its own message, and a checkpoint under its reason", async () => {
    const messageOf = (calls: readonly RecordedCall[]) => {
      const argv = calls.find((call) => subcommand(call.argv) === "commit-tree")?.argv ?? [];
      return argv[argv.indexOf("-m") + 1];
    };
    const published = fakeGit();
    await runCheckpoint({ ...input(null), message: "Add a README section." }, published.io);
    expect(messageOf(published.calls)).toBe("Add a README section.");
    const checkpointed = fakeGit();
    await runCheckpoint(input(null), checkpointed.io);
    expect(messageOf(checkpointed.calls)).toBe(checkpointMessage("idle"));
  });

  it("names the reason in the commit message", () => {
    expect(checkpointMessage("lifetime_ceiling")).toBe("OnCue checkpoint (lifetime_ceiling)");
  });
});

interface RecordedFetch {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeFetch(answer: (() => Response) | Error) {
  const requests: RecordedFetch[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    requests.push({
      url: String(url),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    });
    if (answer instanceof Error) {
      throw answer;
    }
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, signals };
}

const BYTES = new TextEncoder().encode("diff --git a/f b/f\n");

describe("uploadArtifact", () => {
  it("PUTs the bytes with the bearer, the type, the length, and the checksum; 201 is ok", async () => {
    const { fetchImpl, requests } = fakeFetch(() => new Response(null, { status: 201 }));
    const result = await uploadArtifact(
      {
        url: "https://oncue.example/artifacts/art_1",
        token: "up_secret",
        bytes: BYTES,
        contentType: "text/x-diff",
        sha256: sha256Hex(BYTES),
      },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, status: 201 });
    expect(requests).toEqual([
      {
        url: "https://oncue.example/artifacts/art_1",
        method: "PUT",
        headers: {
          authorization: "Bearer up_secret",
          "content-type": "text/x-diff",
          "content-length": String(BYTES.byteLength),
          [UPLOAD_CHECKSUM_HEADER]: sha256Hex(BYTES),
        },
        body: BYTES,
      },
    ]);
  });

  it("any other status is not ok, and the status is reported", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 403 }));
    expect(
      await uploadArtifact(
        { url: "https://x", token: "t", bytes: BYTES, contentType: "text/x-diff", sha256: "0" },
        fetchImpl,
      ),
    ).toEqual({ ok: false, status: 403 });
  });

  it("a thrown fetch is not ok with no status, never a rejection", async () => {
    const { fetchImpl } = fakeFetch(new Error("ECONNRESET"));
    expect(
      await uploadArtifact(
        { url: "https://x", token: "t", bytes: BYTES, contentType: "text/x-diff", sha256: "0" },
        fetchImpl,
      ),
    ).toEqual({ ok: false, status: null });
  });
});

describe("artifact transfers are bounded", () => {
  it("gives the upload and the download each a live deadline signal", async () => {
    const { fetchImpl, signals } = fakeFetch(() => new Response(BYTES, { status: 200 }));
    await uploadArtifact(
      { url: "https://x", token: "t", bytes: BYTES, contentType: "text/x-diff", sha256: "0" },
      fetchImpl,
    );
    await downloadRestore({ url: "https://x", token: "t" }, fetchImpl);
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    expect(ARTIFACT_TRANSFER_TIMEOUT_MS).toBe(60_000);
  });

  it("a download whose body is cut off by the deadline is failed with no status", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(BYTES);
              controller.error(new DOMException("The operation timed out.", "TimeoutError"));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await downloadRestore({ url: "https://x", token: "t" }, fetchImpl)).toEqual({
      kind: "failed",
      status: null,
    });
  });
});

describe("downloadRestore", () => {
  it("GETs with the bearer and returns the bytes on 200", async () => {
    const { fetchImpl, requests } = fakeFetch(() => new Response(BYTES, { status: 200 }));
    const result = await downloadRestore(
      { url: "https://oncue.example/artifacts/art_1", token: "dl_secret" },
      fetchImpl,
    );
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? [...result.bytes] : []).toEqual([...BYTES]);
    expect(requests[0]).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer dl_secret" },
    });
  });

  it("a 403 is failed with the status", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 403 }));
    expect(await downloadRestore({ url: "https://x", token: "t" }, fetchImpl)).toEqual({
      kind: "failed",
      status: 403,
    });
  });

  it("a thrown fetch is failed with no status", async () => {
    const { fetchImpl } = fakeFetch(new Error("boom"));
    expect(await downloadRestore({ url: "https://x", token: "t" }, fetchImpl)).toEqual({
      kind: "failed",
      status: null,
    });
  });

  it("fetchArtifactIo routes both calls through the given fetch", async () => {
    const { fetchImpl, requests } = fakeFetch(() => new Response(null, { status: 201 }));
    const io = fetchArtifactIo(fetchImpl);
    await io.upload({ url: "https://u", token: "t", bytes: BYTES, contentType: "x", sha256: "0" });
    await io.download({ url: "https://d", token: "t" });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["PUT", "https://u"],
      ["GET", "https://d"],
    ]);
  });
});

describe("sha256Hex", () => {
  it("is the lowercase hex digest", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
