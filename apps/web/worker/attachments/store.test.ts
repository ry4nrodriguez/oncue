import { env } from "cloudflare:test";
import { ATTACHMENT_LIMITS } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  attachmentObjectKey,
  claimAttachments,
  readSessionAttachment,
  releaseClaims,
  SWEEP_BATCH,
  sweepUnclaimedAttachments,
} from "./store";

const bucket = env.ARTIFACTS as R2Bucket;
const NOW = "2026-09-27T12:00:00.000Z";

async function seed(
  workspaceId: string,
  options: {
    readonly sessionId?: string | null;
    readonly createdAt?: string;
    readonly put?: boolean;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const key = attachmentObjectKey(workspaceId, id);
  if (options.put !== false) {
    await bucket.put(key, new Uint8Array([1, 2, 3]));
  }
  await env.DB.prepare(
    `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
       content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
     VALUES (?, ?, 'u', ?, 'a.png', 'image/png', 'image', 3, 'x', ?, ?, NULL)`,
  )
    .bind(id, workspaceId, options.sessionId ?? null, key, options.createdAt ?? NOW)
    .run();
  return id;
}

async function exists(id: string): Promise<boolean> {
  return (
    (await env.DB.prepare("SELECT 1 AS one FROM message_attachment WHERE attachment_id = ?")
      .bind(id)
      .first()) !== null
  );
}

describe("claimAttachments", () => {
  const claim = (workspaceId: string, sessionId: string, attachmentIds: readonly string[]) =>
    claimAttachments(env.DB, { workspaceId, sessionId, attachmentIds, now: NOW });

  it("claims nothing, and reads nothing, for a message without attachments", async () => {
    expect(await claim("ws_store_empty", "s", [])).toEqual({ kind: "claimed", refs: [] });
  });

  it("refuses more than a message may carry, and one named twice", async () => {
    const ids = Array.from(
      { length: ATTACHMENT_LIMITS.perMessage + 1 },
      (_value, index) => `x${index}`,
    );
    expect(await claim("ws_store_many", "s", ids)).toMatchObject({ kind: "refused" });
    const id = await seed("ws_store_twice");
    expect(await claim("ws_store_twice", "s", [id, id])).toEqual({
      kind: "refused",
      detail: "the same attachment is named twice",
    });
  });

  it("claims again for the session that already has it, in the order named", async () => {
    const first = await seed("ws_store_again");
    const second = await seed("ws_store_again");
    const once = await claim("ws_store_again", "sess_again", [second, first]);
    expect(once).toMatchObject({
      kind: "claimed",
      refs: [{ artifactId: second }, { artifactId: first }],
    });
    expect(await claim("ws_store_again", "sess_again", [first])).toMatchObject({ kind: "claimed" });
    expect(await claim("ws_store_again", "sess_other", [first])).toMatchObject({ kind: "refused" });
  });

  it("refuses when another session takes one between the read and the write", async () => {
    const id = await seed("ws_store_race");
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("UPDATE message_attachment")) {
              // The other session wins first.
              return {
                bind: () => ({
                  run: async () => {
                    await target
                      .prepare(
                        "UPDATE message_attachment SET session_id = 'sess_winner' WHERE attachment_id = ?",
                      )
                      .bind(id)
                      .run();
                    return target
                      .prepare(sql)
                      .bind("sess_loser", NOW, "ws_store_race", id, "sess_loser")
                      .run();
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await claimAttachments(racing, {
        workspaceId: "ws_store_race",
        sessionId: "sess_loser",
        attachmentIds: [id],
        now: NOW,
      }),
    ).toMatchObject({ kind: "refused" });
  });
});

describe("releaseClaims", () => {
  async function owner(id: string): Promise<unknown> {
    return env.DB.prepare(
      "SELECT session_id, claimed_at FROM message_attachment WHERE attachment_id = ?",
    )
      .bind(id)
      .first();
  }

  it("hands only the named uploads back, and only from that session and workspace", async () => {
    const named = await seed("ws_store_release");
    const kept = await seed("ws_store_release");
    const other = await seed("ws_store_release");
    await claimAttachments(env.DB, {
      workspaceId: "ws_store_release",
      sessionId: "sess_release",
      attachmentIds: [named, kept],
      now: NOW,
    });
    await claimAttachments(env.DB, {
      workspaceId: "ws_store_release",
      sessionId: "sess_someone_else",
      attachmentIds: [other],
      now: NOW,
    });

    await releaseClaims(env.DB, {
      workspaceId: "ws_store_release",
      sessionId: "sess_release",
      attachmentIds: [named, other],
    });

    expect(await owner(named)).toEqual({ session_id: null, claimed_at: null });
    expect(await owner(kept)).toEqual({ session_id: "sess_release", claimed_at: NOW });
    expect(await owner(other)).toEqual({ session_id: "sess_someone_else", claimed_at: NOW });
  });

  it("does nothing for a message without attachments", async () => {
    await expect(
      releaseClaims(env.DB, { workspaceId: "ws_x", sessionId: "s", attachmentIds: [] }),
    ).resolves.toBeUndefined();
  });
});

describe("readSessionAttachment", () => {
  it("finds a claimed attachment of its session and nothing else", async () => {
    const id = await seed("ws_store_read", { sessionId: "sess_read" });
    expect(await readSessionAttachment(env.DB, "sess_read", id)).toMatchObject({
      name: "a.png",
      kind: "image",
    });
    expect(await readSessionAttachment(env.DB, "sess_other", id)).toBeNull();
  });
});

describe("sweepUnclaimedAttachments", () => {
  const OLD = "2020-01-01T00:00:00.000Z";

  it("removes day-old unclaimed uploads, bytes first, and keeps fresh and claimed ones", async () => {
    const stale = await seed("ws_sweep_all", { createdAt: OLD });
    const fresh = await seed("ws_sweep_all", { createdAt: new Date().toISOString() });
    const claimed = await seed("ws_sweep_all", { createdAt: OLD, sessionId: "sess_kept" });
    const removed = await sweepUnclaimedAttachments(env.DB, bucket);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await exists(stale)).toBe(false);
    expect(await bucket.get(attachmentObjectKey("ws_sweep_all", stale))).toBeNull();
    expect(await exists(fresh)).toBe(true);
    expect(await exists(claimed)).toBe(true);
    expect(SWEEP_BATCH).toBe(100);
  });

  it("sweeps one workspace only when asked to", async () => {
    const mine = await seed("ws_sweep_mine", { createdAt: OLD });
    const theirs = await seed("ws_sweep_theirs", { createdAt: OLD });
    expect(await sweepUnclaimedAttachments(env.DB, bucket, new Date(), "ws_sweep_mine")).toBe(1);
    expect(await exists(mine)).toBe(false);
    expect(await exists(theirs)).toBe(true);
  });

  it("does nothing without storage, and keeps a row whose bytes it could not delete", async () => {
    const id = await seed("ws_sweep_fail", { createdAt: OLD });
    expect(await sweepUnclaimedAttachments(env.DB, undefined, new Date(), "ws_sweep_fail")).toBe(0);
    const failing = {
      delete: async () => {
        throw new Error("R2 down");
      },
    } as unknown as R2Bucket;
    expect(await sweepUnclaimedAttachments(env.DB, failing, new Date(), "ws_sweep_fail")).toBe(0);
    expect(await exists(id)).toBe(true);
  });
});
