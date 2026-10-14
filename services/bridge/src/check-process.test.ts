import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckProcessOptions, startCheckProcess } from "./check-process";

function options(overrides: Partial<CheckProcessOptions> = {}): CheckProcessOptions {
  const dir = mkdtempSync(join(tmpdir(), "oncue-check-"));
  return {
    command: "/bin/sh",
    args: ["-c", "echo out; echo err 1>&2; exit 3"],
    cwd: dir,
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 10_000,
    outputPath: join(dir, "chk.log"),
    outputOwner: null,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

describe("startCheckProcess", () => {
  it("keeps stdout and stderr in one owner-only file and reports the exit", async () => {
    const plan = options();
    const check = startCheckProcess(spawn, plan);
    const exit = await check.exit;

    expect(exit).toMatchObject({ exitCode: 3, signal: null, timedOut: false, truncated: false });
    const text = readFileSync(plan.outputPath, "utf8");
    expect(text).toContain("out\n");
    expect(text).toContain("err\n");
    expect(exit.outputBytes).toBe(Buffer.byteLength(text));
    expect(statSync(plan.outputPath).mode & 0o777).toBe(0o600);
  });

  it("runs with exactly the environment it was given", async () => {
    const plan = options({ args: ["-c", 'printf "%s|%s" "$CI" "$HOME"'], env: { CI: "1" } });
    await startCheckProcess(spawn, plan).exit;
    expect(readFileSync(plan.outputPath, "utf8")).toBe("1|");
  });

  it("cuts output past the limit and says so", async () => {
    const plan = options({
      args: ["-c", "i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done"],
      maxOutputBytes: 100,
    });
    const exit = await startCheckProcess(spawn, plan).exit;

    expect(exit).toMatchObject({ exitCode: 0, outputBytes: 100, truncated: true });
    expect(readFileSync(plan.outputPath).byteLength).toBe(100);
  });

  it("kills the whole group at the time limit, background children included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncue-check-"));
    const marker = join(dir, "survived");
    const plan = options({
      cwd: dir,
      args: ["-c", `(sleep 2; touch ${marker}) & sleep 30`],
      timeoutMs: 300,
    });
    const exit = await startCheckProcess(spawn, plan).exit;

    expect(exit).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(() => statSync(marker)).toThrow();
  });

  it("signals the group on request", async () => {
    const check = startCheckProcess(spawn, options({ args: ["-c", "sleep 30"] }));
    check.kill("SIGTERM");
    await expect(check.exit).resolves.toMatchObject({ signal: "SIGTERM", timedOut: false });
    expect(() => check.kill("SIGKILL")).toThrow();
  });

  it("does not wait for a background process that keeps the pipes open", async () => {
    const started = Date.now();
    const plan = options({ args: ["-c", "(trap '' TERM; sleep 30) & echo done"] });
    const exit = await startCheckProcess(spawn, plan).exit;

    expect(exit.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never writes through an existing file or a symlink", () => {
    const existing = options();
    writeFileSync(existing.outputPath, "old");
    expect(() => startCheckProcess(spawn, existing)).toThrow();
    expect(readFileSync(existing.outputPath, "utf8")).toBe("old");

    const linked = options();
    const target = join(linked.cwd, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, linked.outputPath);
    expect(() => startCheckProcess(spawn, linked)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("throws when the process cannot start", () => {
    expect(() => startCheckProcess(spawn, options({ cwd: "/nowhere/at/all" }))).toThrow(
      "could not start the check",
    );
  });
});
