import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { actorUserId, actorWorkspaceId } from "./actor";
import { checkAllowlist, createAllowlistCache } from "./allowlist";
import { deriveUserId, deriveWorkspaceId, registerActor } from "./register";

describe("registerActor", () => {
  it("creates a user, identity, private workspace, and owner membership on first sign-in", async () => {
    const subject = "user_first";

    const actor = await registerActor(env.DB, subject);

    const userId = await deriveUserId(subject);
    const workspaceId = await deriveWorkspaceId(subject);
    expect(actorUserId(actor)).toBe(userId);
    expect(actorWorkspaceId(actor)).toBe(workspaceId);

    const userRow = await env.DB.prepare("SELECT status FROM user WHERE id = ?")
      .bind(userId)
      .first();
    expect(userRow).toEqual({ status: "active" });

    const identityRow = await env.DB.prepare(
      "SELECT user_id FROM external_identity WHERE provider = 'clerk' AND subject = ?",
    )
      .bind(subject)
      .first();
    expect(identityRow).toEqual({ user_id: userId });

    const workspaceRow = await env.DB.prepare(
      "SELECT owner_user_id, kind FROM workspace WHERE id = ?",
    )
      .bind(workspaceId)
      .first();
    expect(workspaceRow).toEqual({ owner_user_id: userId, kind: "private" });

    const memberRow = await env.DB.prepare(
      "SELECT role FROM workspace_member WHERE workspace_id = ? AND user_id = ?",
    )
      .bind(workspaceId, userId)
      .first();
    expect(memberRow).toEqual({ role: "owner" });
  });

  it("is idempotent on a repeated sign-in", async () => {
    const subject = "user_repeat";

    const first = await registerActor(env.DB, subject);
    const second = await registerActor(env.DB, subject);

    expect(actorUserId(second)).toBe(actorUserId(first));
    expect(actorWorkspaceId(second)).toBe(actorWorkspaceId(first));

    const { results } = await env.DB.prepare("SELECT id FROM workspace WHERE owner_user_id = ?")
      .bind(actorUserId(first))
      .all();
    expect(results).toHaveLength(1);
  });

  it("leaves exactly one workspace after two concurrent first sign-ins for the same subject", async () => {
    const subject = "user_concurrent";

    const [a, b] = await Promise.all([
      registerActor(env.DB, subject),
      registerActor(env.DB, subject),
    ]);

    expect(actorUserId(a)).toBe(actorUserId(b));
    expect(actorWorkspaceId(a)).toBe(actorWorkspaceId(b));

    const { results } = await env.DB.prepare("SELECT id FROM workspace WHERE owner_user_id = ?")
      .bind(actorUserId(a))
      .all();
    expect(results).toHaveLength(1);
  });

  it("never creates a user row for a subject the allowlist blocks", async () => {
    const subject = "user_blocked";
    const cache = createAllowlistCache();

    const decision = await checkAllowlist(env.DB, "user_allowed_only", cache, Date.now(), subject);

    expect(decision).toEqual({ kind: "blocked" });
    const userId = await deriveUserId(subject);
    const userRow = await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(userId).first();
    expect(userRow).toBeNull();
  });
});
