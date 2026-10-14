import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@oncue/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./checkpoint";
import { createDiffBuilder, DIFF_INDEX_FILE } from "./diffs";
import { type GitIo, nodeRunGit } from "./git";

const run = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const io: GitIo = {
  runGit: nodeRunGit,
  revoke: async () => ({ ok: true, status: 204 }),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  askpassPath: "/bin/true",
};

describe("createDiffBuilder against real git", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tree() {
    const root = mkdtempSync(join(tmpdir(), "oncue-diffs-"));
    roots.push(root);
    const workTree = join(root, "workspace");
    run(["init", "-q", "-b", "task", workTree], root);
    run(["config", "user.email", "test@example.com"], workTree);
    run(["config", "user.name", "Test"], workTree);
    writeFileSync(join(workTree, "README.md"), "# widgets\n");
    run(["add", "."], workTree);
    run(["commit", "-q", "-m", "base"], workTree);
    const baseSha = run(["rev-parse", "HEAD"], workTree).trim();
    const logs: string[] = [];
    const builder = createDiffBuilder(workTree, join(root, "scratch"), io, (line) =>
      logs.push(line),
    );
    return {
      workTree,
      baseSha,
      builder,
      logs,
      refs: { branch: "task", baseSha, parentSha: baseSha },
    };
  }

  it("measures a turn from its base snapshot and the session from the recorded base, holding a large patch by its digest", async () => {
    const { workTree, builder, refs } = tree();
    writeFileSync(join(workTree, "README.md"), "# widgets\nearlier\n");
    const turnBase = await builder.turnBase(refs);
    expect(turnBase?.status).toMatchObject({ ahead: 1, changedFileCount: 1, dirty: true });

    const big = "a line of the generated file\n".repeat(Math.ceil(LIMITS.inlineTextChars / 20));
    writeFileSync(join(workTree, "generated.txt"), big);
    const built = await builder.runEnd(refs, turnBase?.sha ?? null);
    expect(built.kind).toBe("built");
    if (built.kind !== "built") {
      return;
    }
    expect(built.status).toMatchObject({ headSha: built.headSha, changedFileCount: 2 });
    expect(built.turn?.baseSha).toBe(turnBase?.sha);
    expect(built.turn?.files.map((file) => file.path)).toEqual(["generated.txt"]);
    expect(built.session?.files.map((file) => file.path)).toEqual(["README.md", "generated.txt"]);
    expect(built.session?.patch.kind).toBe("held");
    expect(built.turn?.patch.kind).toBe("held");

    const digest = built.session?.digest ?? "";
    const bytes = builder.take(digest);
    expect(bytes?.toString("utf8")).toContain("+earlier");
    expect(sha256Hex(bytes ?? Buffer.alloc(0))).toBe(digest);
    expect(builder.take(digest)).toBeNull();
    expect(run(["status", "--porcelain"], workTree)).toBe(" M README.md\n?? generated.txt\n");
  });

  it("a mid-run build carries the session's diff alone and never holds its patch", async () => {
    const { workTree, builder, refs } = tree();
    writeFileSync(join(workTree, "generated.txt"), "x".repeat(LIMITS.inlineTextChars + 5));
    const built = await builder.midRun(refs);
    expect(built).toMatchObject({ kind: "built", status: null, turn: null });
    const session = built.kind === "built" ? built.session : null;
    expect(session?.patch.kind).toBe("inline");
    expect(session?.truncated).toBe(true);
    expect(builder.take(session?.digest ?? "")).toBeNull();
  });

  it("measures the session at an existing commit, such as a checkpoint's", async () => {
    const { workTree, baseSha, builder } = tree();
    writeFileSync(join(workTree, "README.md"), "# widgets\ncommitted\n");
    run(["commit", "-q", "-am", "agent commit"], workTree);
    const head = run(["rev-parse", "HEAD"], workTree).trim();
    const session = await builder.sessionAt(baseSha, head);
    expect(session).toMatchObject({ baseSha, headSha: head, additions: 1, deletions: 0 });
    expect(await builder.sessionAt(baseSha, "0".repeat(40))).toBeNull();
  });

  it("measures one commit against its parent and never holds its patch", async () => {
    const { workTree, baseSha, builder } = tree();
    writeFileSync(join(workTree, "README.md"), `# widgets\n${"line\n".repeat(20_000)}`);
    run(["commit", "-q", "-am", "a large commit"], workTree);
    const head = run(["rev-parse", "HEAD"], workTree).trim();
    const commit = await builder.commitAt(baseSha, head);
    expect(commit).toMatchObject({ baseSha, headSha: head, additions: 20_000, deletions: 0 });
    expect(commit?.files).toEqual([
      { path: "README.md", status: "modified", additions: 20_000, deletions: 0 },
    ]);
    expect(builder.take(commit?.digest ?? "")).toBeNull();
    expect(await builder.commitAt(baseSha, "0".repeat(40))).toBeNull();
  });

  it("a failed snapshot is reported and the next build starts its index over", async () => {
    const { workTree, builder, refs, logs } = tree();
    await builder.midRun(refs);
    const bad = await builder.midRun({ ...refs, parentSha: "0".repeat(40) });
    expect(bad).toEqual({ kind: "failed", detail: "read_tree_failed" });
    writeFileSync(join(workTree, "new.txt"), "new\n");
    const good = await builder.runEnd(refs, null);
    expect(good.kind === "built" ? good.session?.files.map((file) => file.path) : []).toEqual([
      "new.txt",
    ]);
    const turnBase = await builder.turnBase({ ...refs, parentSha: "0".repeat(40) });
    expect(turnBase).toBeNull();
    expect(logs).toContain("bridge: turn base snapshot failed: read_tree_failed");
  });

  it("runs builds one at a time over the one diff index, so builds asked for together all succeed in order", async () => {
    const { workTree, builder, refs } = tree();
    writeFileSync(join(workTree, "one.txt"), "1\n");
    const settled: string[] = [];
    const asked = [
      builder.midRun(refs).then((result) => settled.push(`mid:${result.kind}`)),
      builder.turnBase(refs).then((result) => settled.push(`base:${result === null}`)),
      builder.runEnd(refs, null).then((result) => settled.push(`end:${result.kind}`)),
      builder.midRun(refs).then((result) => settled.push(`mid:${result.kind}`)),
    ];
    await Promise.all(asked);
    expect(settled).toEqual(["mid:built", "base:false", "end:built", "mid:built"]);
    expect(readFileSync(join(workTree, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/task\n");
    expect(existsSync(join(workTree, ".git", DIFF_INDEX_FILE))).toBe(false);
  });
});
