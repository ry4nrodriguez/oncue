import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  isSavableCategory,
  readWorkspaceApprovals,
  removeWorkspaceRule,
  saveWorkspaceRule,
  writeWorkspaceDefault,
} from "../approvals/store";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { handleApprovalSettings, matchApprovalSettingsRoute } from "./approval-settings";

const ORIGIN = "https://oncue.example";
const NOW = "2026-10-04T00:00:00.000Z";

async function seedWorkspace(subject: string): Promise<string> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
  ]);
  return workspaceId;
}

describe("the workspace's approval store", () => {
  it("reads as ask with nothing saved when no row exists", async () => {
    expect(await readWorkspaceApprovals(env.DB, "ws_nobody")).toEqual({
      defaultMode: "ask",
      rules: [],
    });
  });

  it("writes the default, saves a rule once, and removes it", async () => {
    const workspaceId = await seedWorkspace("user_store");
    await writeWorkspaceDefault(env.DB, workspaceId, "always", NOW);
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).defaultMode).toBe("always");
    await writeWorkspaceDefault(env.DB, workspaceId, "ask", "2026-10-04T00:01:00.000Z");
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).defaultMode).toBe("ask");

    expect(await saveWorkspaceRule(env.DB, workspaceId, "outside_project", NOW)).toBe("saved");
    expect(
      await saveWorkspaceRule(env.DB, workspaceId, "outside_project", "2026-10-05T00:00:00.000Z"),
    ).toBe("saved");
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).rules).toEqual([
      { category: "outside_project", createdAt: NOW },
    ]);
    expect(await removeWorkspaceRule(env.DB, workspaceId, "outside_project")).toBe(true);
    expect(await removeWorkspaceRule(env.DB, workspaceId, "outside_project")).toBe(false);
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).rules).toEqual([]);
  });

  it("keeps the later of two defaults whose writes land out of order", async () => {
    const workspaceId = await seedWorkspace("user_store_order");
    await writeWorkspaceDefault(env.DB, workspaceId, "always", "2026-10-04T00:02:00.000Z");
    await writeWorkspaceDefault(env.DB, workspaceId, "ask", "2026-10-04T00:01:00.000Z");
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).defaultMode).toBe("always");
    // The same instant is not older: the second write wins.
    await writeWorkspaceDefault(env.DB, workspaceId, "ask", "2026-10-04T00:02:00.000Z");
    expect((await readWorkspaceApprovals(env.DB, workspaceId)).defaultMode).toBe("ask");
  });

  it("never saves secret files, in code or in the table", async () => {
    const workspaceId = await seedWorkspace("user_secret_rule");
    expect(isSavableCategory("secret_file")).toBe(false);
    expect(isSavableCategory(7)).toBe(false);
    expect(await saveWorkspaceRule(env.DB, workspaceId, "secret_file", NOW)).toBe("not_savable");
    await expect(
      env.DB.prepare(
        "INSERT INTO workspace_approval_rule (workspace_id, category, created_at) VALUES (?, 'secret_file', ?)",
      )
        .bind(workspaceId, NOW)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO workspace_approval_setting (workspace_id, default_mode, updated_at) VALUES (?, 'session', ?)",
      )
        .bind(workspaceId, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("reads a D1 answer with no rows as nothing saved, and a delete with no count as nothing removed", async () => {
    const empty = {
      prepare: () => ({ bind: () => ({ run: async () => ({ meta: {} }) }) }),
      batch: async () => [{}, {}],
    } as unknown as D1Database;
    expect(await readWorkspaceApprovals(empty, "ws_x")).toEqual({ defaultMode: "ask", rules: [] });
    expect(await removeWorkspaceRule(empty, "ws_x", "outside_project")).toBe(false);
  });

  it("drops a row the table's CHECK should have refused, and allows nothing for it", async () => {
    const odd = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => [
        { results: [{ default_mode: "sometimes" }] },
        {
          results: [
            { category: "secret_file", created_at: NOW },
            { category: "outside_project", created_at: 7 },
            { category: "repeated_action", created_at: NOW },
          ],
        },
      ],
    } as unknown as D1Database;
    expect(await readWorkspaceApprovals(odd, "ws_x")).toEqual({
      defaultMode: "ask",
      rules: [{ category: "repeated_action", createdAt: NOW }],
    });
  });

  it("keeps one workspace's settings from another's", async () => {
    const mine = await seedWorkspace("user_mine");
    const theirs = await seedWorkspace("user_theirs");
    await writeWorkspaceDefault(env.DB, theirs, "always", NOW);
    await saveWorkspaceRule(env.DB, theirs, "repeated_action", NOW);
    expect(await readWorkspaceApprovals(env.DB, mine)).toEqual({ defaultMode: "ask", rules: [] });
    expect(await removeWorkspaceRule(env.DB, mine, "repeated_action")).toBe(false);
  });
});

describe("matchApprovalSettingsRoute", () => {
  it("names the three routes and nothing else", () => {
    expect(matchApprovalSettingsRoute("/api/approval-settings", "GET")).toEqual({ kind: "read" });
    expect(matchApprovalSettingsRoute("/api/approval-settings/default", "PUT")).toEqual({
      kind: "set_default",
    });
    expect(
      matchApprovalSettingsRoute("/api/approval-settings/rules/outside_project", "DELETE"),
    ).toEqual({ kind: "remove_rule", category: "outside_project" });
    expect(matchApprovalSettingsRoute("/api/approval-settings", "POST")).toBeNull();
    expect(matchApprovalSettingsRoute("/api/approval-settings/rules/", "DELETE")).toBeNull();
    expect(matchApprovalSettingsRoute("/api/approval-settings/rules/a/b", "DELETE")).toBeNull();
    expect(matchApprovalSettingsRoute("/api/approval-settings/default", "GET")).toBeNull();
  });
});

describe("handleApprovalSettings", () => {
  async function setup(subject: string) {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace(subject);
    const routeEnv = {
      ...env,
      CLERK_JWT_KEY: double.jwtKey,
      ONCUE_USER_ALLOWLIST: subject,
    } as unknown as Env;
    const cache = createAllowlistCache();
    async function call(path: string, method: string, body?: unknown) {
      const authed = await double.requestAs(subject, `${ORIGIN}${path}`);
      const request = new Request(`${ORIGIN}${path}`, {
        method,
        headers: { cookie: authed.headers.get("cookie") ?? "", "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const route = matchApprovalSettingsRoute(path, method);
      if (route === null) {
        throw new Error(`no route for ${method} ${path}`);
      }
      return handleApprovalSettings(route, request, routeEnv, cache, () => NOW);
    }
    return { workspaceId, call, double, routeEnv, cache };
  }

  it("reads, sets the default, and removes a saved rule for the signed-in workspace", async () => {
    const { workspaceId, call } = await setup("user_route");
    expect(await (await call("/api/approval-settings", "GET")).json()).toEqual({
      defaultMode: "ask",
      rules: [],
    });
    const set = await call("/api/approval-settings/default", "PUT", { mode: "always" });
    expect(await set.json()).toEqual({ defaultMode: "always", rules: [] });

    await saveWorkspaceRule(env.DB, workspaceId, "repeated_action", NOW);
    const removed = await call("/api/approval-settings/rules/repeated_action", "DELETE");
    expect(await removed.json()).toEqual({ defaultMode: "always", rules: [] });
  });

  it("drops every saved rule when the default goes back to asking, and keeps them otherwise", async () => {
    const { workspaceId, call } = await setup("user_route_clear");
    await saveWorkspaceRule(env.DB, workspaceId, "outside_project", NOW);
    const always = await call("/api/approval-settings/default", "PUT", { mode: "always" });
    expect(((await always.json()) as { rules: unknown[] }).rules).toHaveLength(1);
    const ask = await call("/api/approval-settings/default", "PUT", { mode: "ask" });
    expect(await ask.json()).toEqual({ defaultMode: "ask", rules: [] });
  });

  it("refuses a mode it does not know and a category it cannot save", async () => {
    const { call } = await setup("user_route_bad");
    for (const mode of ["session", "once", undefined, 3]) {
      const answer = await call("/api/approval-settings/default", "PUT", { mode });
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({ error: "invalid_request", reason: "mode" });
    }
    const secret = await call("/api/approval-settings/rules/secret_file", "DELETE");
    expect(secret.status).toBe(400);
    const nonsense = await call("/api/approval-settings/rules/everything", "DELETE");
    expect(await nonsense.json()).toEqual({ error: "invalid_request", reason: "category" });
  });

  it("refuses a body that is not JSON, and stamps a change with the Worker's clock", async () => {
    const { double, routeEnv, cache, workspaceId } = await setup("user_route_clock");
    const authed = await double.requestAs(
      "user_route_clock",
      `${ORIGIN}/api/approval-settings/default`,
    );
    const cookie = authed.headers.get("cookie") ?? "";
    const garbled = await handleApprovalSettings(
      { kind: "set_default" },
      new Request(`${ORIGIN}/api/approval-settings/default`, {
        method: "PUT",
        headers: { cookie },
        body: "not json",
      }),
      routeEnv,
      cache,
    );
    expect(garbled.status).toBe(400);
    const before = Date.now();
    const set = await handleApprovalSettings(
      { kind: "set_default" },
      new Request(`${ORIGIN}/api/approval-settings/default`, {
        method: "PUT",
        headers: { cookie },
        body: JSON.stringify({ mode: "always" }),
      }),
      routeEnv,
      cache,
    );
    expect(set.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT updated_at FROM workspace_approval_setting WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .first<{ updated_at: string }>();
    expect(Date.parse(row?.updated_at ?? "")).toBeGreaterThanOrEqual(before - 1000);
  });

  it("answers 401 without a session and 403 off the allowlist", async () => {
    const { routeEnv, cache, double } = await setup("user_route_auth");
    const anonymous = await handleApprovalSettings(
      { kind: "read" },
      new Request(`${ORIGIN}/api/approval-settings`),
      routeEnv,
      cache,
    );
    expect(anonymous.status).toBe(401);
    const stranger = await double.requestAs("user_not_listed", `${ORIGIN}/api/approval-settings`);
    const refused = await handleApprovalSettings(
      { kind: "read" },
      new Request(`${ORIGIN}/api/approval-settings`, {
        headers: { cookie: stranger.headers.get("cookie") ?? "" },
      }),
      routeEnv,
      cache,
    );
    expect(refused.status).toBe(403);
  });
});
