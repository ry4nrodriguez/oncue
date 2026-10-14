import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isKnownSession, KNOWN_SESSION_SQL } from "./known-session";

const TIME = "2026-10-13T00:00:00.000Z";

async function seedIndexRow(sessionId: string, state: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, 'ws_known', NULL, ?, ?, ?)`,
  )
    .bind(sessionId, state, TIME, TIME)
    .run();
}

/** What a finished deletion leaves: the request as a receipt, and no index row. */
async function seedDeletionReceipt(sessionId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deletion_request
       (id, session_id, workspace_id, requested_by_user_id, requested_at, completed_at, outcome)
     VALUES (?, ?, 'ws_known', 'user_known', ?, ?, 'deleted')`,
  )
    .bind(`del_${sessionId}`, sessionId, TIME, TIME)
    .run();
}

describe("isKnownSession", () => {
  it.each(["creating", "active", "archived", "deletion_pending"])(
    "knows a session whose index row is %s",
    async (state) => {
      const sessionId = `sess_known_${state}`;
      await seedIndexRow(sessionId, state);
      expect(await isKnownSession(env.DB, sessionId)).toBe(true);
    },
  );

  it("knows a deleted session by its receipt, so its object can still end its bridge", async () => {
    await seedDeletionReceipt("sess_known_deleted");
    expect(await isKnownSession(env.DB, "sess_known_deleted")).toBe(true);
  });

  it("does not know an id nobody created", async () => {
    expect(await isKnownSession(env.DB, "sess_known_never_created")).toBe(false);
    expect(await isKnownSession(env.DB, "")).toBe(false);
  });

  it("matches the whole id, not a prefix of one", async () => {
    await seedIndexRow("sess_known_exact_match", "active");
    expect(await isKnownSession(env.DB, "sess_known_exact")).toBe(false);
    expect(await isKnownSession(env.DB, "sess_known_exact_match_and_more")).toBe(false);
  });

  it("answers yes when the database cannot be read, so a sandbox is not locked out of its session", async () => {
    const unreadable = {
      prepare() {
        throw new Error("D1 is unavailable");
      },
    } as unknown as D1Database;
    expect(await isKnownSession(unreadable, "sess_known_never_created")).toBe(true);
  });

  it("reads both tables through an index, never by scanning", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${KNOWN_SESSION_SQL}`)
      .bind("sess_plan", "sess_plan")
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(details.some((detail) => /SEARCH session_index USING .*INDEX/.test(detail))).toBe(true);
    expect(
      details.some((detail) =>
        /SEARCH deletion_request USING .*INDEX idx_deletion_request_session/.test(detail),
      ),
    ).toBe(true);
    expect(details.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });
});
