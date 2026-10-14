import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decideAdmission, readPlatformControl } from "./admission";

describe("decideAdmission", () => {
  const openControl = {
    runAdmission: "open" as const,
    platformConcurrentSandboxCap: 50,
    workspaceConcurrentSandboxCap: 3,
  };

  it("fails closed when the platform_control row could not be read", () => {
    const decision = decideAdmission(null, {
      workspaceActiveSandboxCount: 0,
      platformActiveSandboxCount: 0,
    });

    expect(decision).toEqual({ kind: "refuse", reason: "control_unreadable" });
  });

  it("refuses when run admission is stopped", () => {
    const decision = decideAdmission(
      { ...openControl, runAdmission: "stopped" },
      { workspaceActiveSandboxCount: 0, platformActiveSandboxCount: 0 },
    );

    expect(decision).toEqual({ kind: "refuse", reason: "admission_stopped" });
  });

  it("refuses when the per-workspace cap is reached", () => {
    const decision = decideAdmission(openControl, {
      workspaceActiveSandboxCount: 3,
      platformActiveSandboxCount: 0,
    });

    expect(decision).toEqual({ kind: "refuse", reason: "workspace_cap_reached" });
  });

  it("refuses when the platform-wide cap is reached", () => {
    const decision = decideAdmission(openControl, {
      workspaceActiveSandboxCount: 0,
      platformActiveSandboxCount: 50,
    });

    expect(decision).toEqual({ kind: "refuse", reason: "platform_cap_reached" });
  });

  it("admits when admission is open and both caps have room", () => {
    const decision = decideAdmission(openControl, {
      workspaceActiveSandboxCount: 1,
      platformActiveSandboxCount: 1,
    });

    expect(decision).toEqual({ kind: "admit" });
  });
});

describe("readPlatformControl", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO platform_control (
        id, run_admission, platform_concurrent_sandbox_cap, workspace_concurrent_sandbox_cap,
        allowlist_version, emergency_control_version, updated_at
      ) VALUES (1, 'open', 50, 3, 1, 1, '2026-09-02T00:00:00.000Z')
      ON CONFLICT (id) DO UPDATE SET
        run_admission = excluded.run_admission,
        platform_concurrent_sandbox_cap = excluded.platform_concurrent_sandbox_cap,
        workspace_concurrent_sandbox_cap = excluded.workspace_concurrent_sandbox_cap`,
    ).run();
  });

  it("reads the seeded row", async () => {
    const control = await readPlatformControl(env.DB);
    expect(control).toEqual({
      runAdmission: "open",
      platformConcurrentSandboxCap: 50,
      workspaceConcurrentSandboxCap: 3,
    });
  });

  it("returns null when the row is missing", async () => {
    await env.DB.prepare("DELETE FROM platform_control WHERE id = 1").run();

    const control = await readPlatformControl(env.DB);

    expect(control).toBeNull();
    await env.DB.prepare(
      `INSERT INTO platform_control (
        id, run_admission, platform_concurrent_sandbox_cap, workspace_concurrent_sandbox_cap,
        allowlist_version, emergency_control_version, updated_at
      ) VALUES (1, 'open', 50, 3, 1, 1, '2026-09-02T00:00:00.000Z')`,
    ).run();
  });

  it("returns null when the row is malformed", async () => {
    // This column has no CHECK constraint, so SQLite accepts a non-numeric value.
    await env.DB.prepare(
      "UPDATE platform_control SET platform_concurrent_sandbox_cap = 'not-a-number' WHERE id = 1",
    ).run();

    const control = await readPlatformControl(env.DB);

    expect(control).toBeNull();
  });

  it("returns null when run_admission is neither open nor stopped", async () => {
    const malformedDb = {
      prepare() {
        return {
          async first() {
            return {
              run_admission: "paused",
              platform_concurrent_sandbox_cap: 50,
              workspace_concurrent_sandbox_cap: 3,
            };
          },
        };
      },
    } as unknown as D1Database;

    const control = await readPlatformControl(malformedDb);

    expect(control).toBeNull();
  });

  it("returns null when the query itself throws", async () => {
    const throwingDb = {
      prepare() {
        throw new Error("connection lost");
      },
    } as unknown as D1Database;

    const control = await readPlatformControl(throwingDb);

    expect(control).toBeNull();
  });
});
