// The deletion job (record 19) against the real D1 and R2 bindings. The
// session object is a scripted stand-in here, except in the last block,
// which runs the whole path through the route and a real object.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactObjectKey } from "../artifacts/policy";
import { attachmentObjectKey } from "../attachments/store";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import {
  deriveInstallationRowId,
  insertOrUpdateInstallation,
  replaceRepositoryConnections,
} from "../github/store";
import { handleDeleteSession, realDeleteDeps } from "../routes/session-delete";
import type { DeleteSessionResult, EraseSessionResult } from "../session/session-object";
import { createClerkDouble } from "../test/clerk-double";
import {
  eventsOfType,
  readyBridge,
  registerSessionWorlds,
  sessionOnRealDriver,
} from "../test/session-world";
import {
  ARTIFACT_ROWS_PER_ATTEMPT,
  DELETION_BATCH,
  type DeletionEnv,
  type DeletionObjects,
  type DeletionStep,
  R2_DELETE_BATCH,
  R2_LIST_PAGES,
  RETRY_WAITS,
  realDeletionObjects,
  runDeletion,
  runPendingDeletions,
} from "./job";
import { RELEASED_REF_WINDOW_MS, releasedRefHash } from "./released-refs";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const WS = "ws_del";
const OTHER_WS = "ws_other";
const SESSION = "sess_del";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const clock = () => NOW;

const OWNED_ARTIFACT = artifactObjectKey(WS, SESSION, "run_1", "art_owned");
// Under the session's prefix but named by no row: an upload that landed before its row.
const DECLARED_ONLY = artifactObjectKey(WS, SESSION, "run_1", "art_declared");
const MISPLACED = artifactObjectKey(OTHER_WS, SESSION, "run_1", "art_misplaced");
const FOREIGN_ROW = artifactObjectKey(OTHER_WS, SESSION, "run_1", "art_foreign");
const OWNED_ATTACHMENT = attachmentObjectKey(WS, "att_owned");
const WRONG_ATTACHMENT = attachmentObjectKey(OTHER_WS, "att_wrong");
const UNRELATED = artifactObjectKey(WS, "sess_unrelated", "run_1", "art_kept");

const ALL_KEYS = [
  OWNED_ARTIFACT,
  DECLARED_ONLY,
  MISPLACED,
  FOREIGN_ROW,
  OWNED_ATTACHMENT,
  WRONG_ATTACHMENT,
  UNRELATED,
];

const jobEnv: DeletionEnv = env;

beforeEach(async () => {
  for (const table of [
    "deletion_request",
    "artifact_index",
    "message_attachment",
    "audit_entry",
    "projection_cursor",
    "session_index",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.ARTIFACTS.delete(ALL_KEYS);
});

async function seedSession(sessionId = SESSION, requestId = "del_1"): Promise<void> {
  const at = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO session_index (session_id, workspace_id, state, title, created_at, updated_at)
       VALUES (?, ?, 'deletion_pending', 'Fix the bug', ?, ?)`,
    ).bind(sessionId, WS, at, at),
    env.DB.prepare(
      `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
       VALUES (?, ?, ?, 'user_del', ?)`,
    ).bind(requestId, sessionId, WS, at),
  ]);
}

function artifactRow(id: string, workspaceId: string, key: string) {
  return env.DB.prepare(
    `INSERT INTO artifact_index (artifact_id, workspace_id, session_id, run_id, kind, producer, content_type,
       byte_size, sha256, classification, object_key, expires_at, created_at)
     VALUES (?, ?, ?, 'run_1', 'log', 'tool', 'text/plain', 4, 'x', 'temporary', ?, NULL, ?)`,
  ).bind(id, workspaceId, SESSION, key, NOW.toISOString());
}

function attachmentRow(id: string, workspaceId: string, key: string) {
  return env.DB.prepare(
    `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
       content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
     VALUES (?, ?, 'user_del', ?, 'notes.txt', 'text/plain', 'file', 4, 'x', ?, ?, ?)`,
  ).bind(id, workspaceId, SESSION, key, NOW.toISOString(), NOW.toISOString());
}

/** Everything a session leaves behind, plus a row and objects that are someone else's. */
async function seedStores(): Promise<void> {
  await seedSession();
  await env.DB.batch([
    artifactRow("art_owned", WS, OWNED_ARTIFACT),
    // Ours by its columns, but its key points outside this session: the row
    // goes, the object it names is not ours to touch.
    artifactRow("art_misplaced", WS, MISPLACED),
    // Another workspace's row naming this session id: left exactly as it is.
    artifactRow("art_foreign", OTHER_WS, FOREIGN_ROW),
    attachmentRow("att_owned", WS, OWNED_ATTACHMENT),
    attachmentRow("att_wrong", WS, WRONG_ATTACHMENT),
    env.DB.prepare(
      `INSERT INTO audit_entry (id, workspace_id, session_id, actor_type, action, occurred_at)
       VALUES ('aud_1', ?, ?, 'user', 'session.created', ?)`,
    ).bind(WS, SESSION, NOW.toISOString()),
    env.DB.prepare(
      "INSERT INTO projection_cursor (session_id, last_applied_sequence, updated_at) VALUES (?, 3, ?)",
    ).bind(SESSION, NOW.toISOString()),
  ]);
  for (const key of ALL_KEYS) {
    await env.ARTIFACTS.put(key, "data");
  }
}

interface Script {
  marked?: boolean;
  close?: () => Promise<DeleteSessionResult>;
  erase?: () => Promise<EraseSessionResult>;
}

function scriptedObjects(script: Script = {}): DeletionObjects & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async marked(sessionId) {
      calls.push(`marked:${sessionId}`);
      return script.marked ?? true;
    },
    async close(sessionId, requestedByUserId) {
      calls.push(`close:${sessionId}:${requestedByUserId}`);
      return script.close?.() ?? { kind: "deleting", sandbox: "stopped" };
    },
    async erase(sessionId) {
      calls.push(`erase:${sessionId}`);
      return script.erase?.() ?? { kind: "erased" };
    },
  };
}

/** A D1 whose statements and batches matching `failing` throw, like an outage on one table. */
function failingDb(failing: (sql: string) => boolean): D1Database {
  const real = env.DB;
  const sqlOf = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "bind") {
          return (...args: unknown[]) => wrap(target.bind(...args), sql);
        }
        if (["run", "all", "first", "raw"].includes(String(property)) && failing(sql)) {
          return async () => {
            throw new Error("D1 is unavailable");
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlOf.set(wrapped, sql);
    sqlOf.set(statement, sql);
    return wrapped;
  };
  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => failing(sqlOf.get(statement) ?? ""))) {
            throw new Error("D1 is unavailable");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function requestRow(id = "del_1") {
  return env.DB.prepare(
    "SELECT attempts, last_attempt_at, failed_step, completed_at FROM deletion_request WHERE id = ?",
  )
    .bind(id)
    .first<{
      attempts: number;
      last_attempt_at: string | null;
      failed_step: string | null;
      completed_at: string | null;
    }>();
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function present(keys: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const key of keys) {
    if ((await env.ARTIFACTS.head(key)) !== null) {
      found.push(key);
    }
  }
  return found;
}

/** What a finished deletion leaves: no rows of its own, only foreign objects, one receipt. */
async function expectDeleted(): Promise<void> {
  expect(await count("SELECT COUNT(*) AS n FROM session_index WHERE session_id = ?", SESSION)).toBe(
    0,
  );
  expect(
    await count(
      "SELECT COUNT(*) AS n FROM artifact_index WHERE session_id = ? AND workspace_id = ?",
      SESSION,
      WS,
    ),
  ).toBe(0);
  expect(
    await count(
      "SELECT COUNT(*) AS n FROM message_attachment WHERE session_id = ? AND workspace_id = ?",
      SESSION,
      WS,
    ),
  ).toBe(0);
  expect(await count("SELECT COUNT(*) AS n FROM audit_entry WHERE session_id = ?", SESSION)).toBe(
    0,
  );
  expect(
    await count("SELECT COUNT(*) AS n FROM projection_cursor WHERE session_id = ?", SESSION),
  ).toBe(0);
  // Another workspace's row is untouched, and so is every object not this session's.
  expect(
    await count("SELECT COUNT(*) AS n FROM artifact_index WHERE workspace_id = ?", OTHER_WS),
  ).toBe(1);
  expect(await present(ALL_KEYS)).toEqual([MISPLACED, FOREIGN_ROW, WRONG_ATTACHMENT, UNRELATED]);
  expect(await requestRow()).toMatchObject({
    failed_step: null,
    completed_at: NOW.toISOString(),
  });
}

describe("runDeletion", () => {
  it("works every step in order and writes one receipt, leaving foreign objects alone", async () => {
    await seedStores();
    const objects = scriptedObjects();

    expect(await runDeletion(jobEnv, objects, "del_1", clock)).toEqual({ kind: "completed" });

    expect(objects.calls).toEqual([`close:${SESSION}:user_del`, `erase:${SESSION}`]);
    await expectDeleted();
    expect(await requestRow()).toMatchObject({ attempts: 1, last_attempt_at: NOW.toISOString() });

    // Nothing is owed any more: a rerun does nothing and the receipt is unchanged.
    expect(await runDeletion(jobEnv, objects, "del_1", () => new Date())).toEqual({
      kind: "nothing_owed",
    });
    expect(await requestRow()).toMatchObject({ attempts: 1, completed_at: NOW.toISOString() });
    expect(objects.calls).toHaveLength(2);
  });

  it("answers nothing_owed for a request that does not exist", async () => {
    expect(await runDeletion(jobEnv, scriptedObjects(), "del_missing")).toEqual({
      kind: "nothing_owed",
    });
  });

  // A crash at each step, then a clean rerun: it converges, and the receipt
  // is written by the rerun alone.
  const crashes: ReadonlyArray<{
    readonly step: DeletionStep;
    readonly objects?: Script;
    readonly db?: (sql: string) => boolean;
    readonly bucketFails?: boolean;
  }> = [
    { step: "stop", objects: { close: () => Promise.reject(new Error("evicted")) } },
    { step: "r2", bucketFails: true },
    { step: "r2", db: (sql) => sql.includes("SELECT object_key FROM artifact_index") },
    { step: "d1", db: (sql) => sql.startsWith("DELETE FROM artifact_index") },
    { step: "object", objects: { erase: () => Promise.reject(new Error("evicted")) } },
    { step: "receipt", db: (sql) => sql.includes("SET completed_at") },
  ];

  for (const crash of crashes) {
    it(`converges after a crash at the ${crash.step} step${crash.db === undefined ? "" : " (D1)"}`, async () => {
      await seedStores();
      const bucket = env.ARTIFACTS;
      const brokenEnv: DeletionEnv = {
        ...env,
        DB: crash.db === undefined ? env.DB : failingDb(crash.db),
        ARTIFACTS:
          crash.bucketFails === true
            ? ({
                delete: async () => {
                  throw new Error("R2 is unavailable");
                },
              } as unknown as R2Bucket)
            : bucket,
      };

      expect(await runDeletion(brokenEnv, scriptedObjects(crash.objects), "del_1", clock)).toEqual({
        kind: "pending",
        step: crash.step,
      });
      expect(await requestRow()).toMatchObject({ completed_at: null, failed_step: crash.step });
      expect(
        await count("SELECT COUNT(*) AS n FROM session_index WHERE session_id = ?", SESSION),
      ).toBe(1);

      expect(await runDeletion(jobEnv, scriptedObjects(), "del_1", clock)).toEqual({
        kind: "completed",
      });
      await expectDeleted();
      expect(await requestRow()).toMatchObject({ attempts: 2 });
    });
  }

  it("waits while the sandbox is still stopping or its terminate was refused", async () => {
    await seedSession();
    for (const sandbox of ["stopping", "failed"] as const) {
      const objects = scriptedObjects({ close: async () => ({ kind: "deleting", sandbox }) });
      expect(await runDeletion(jobEnv, objects, "del_1", clock)).toEqual({
        kind: "pending",
        step: "stop",
      });
      expect(objects.calls).toHaveLength(1);
    }
  });

  it("goes on when the sandbox had already stopped or the object holds nothing", async () => {
    await seedSession();
    const first = scriptedObjects({
      close: async () => ({ kind: "deleting", sandbox: "not_running" }),
    });
    expect(await runDeletion(jobEnv, first, "del_1", clock)).toEqual({ kind: "completed" });

    await seedSession("sess_del_2", "del_2");
    const second = scriptedObjects({ close: async () => ({ kind: "no_session" }) });
    expect(await runDeletion(jobEnv, second, "del_2", clock)).toEqual({ kind: "completed" });
  });

  it("closes a request whose session is not being deleted as skipped, and never touches it", async () => {
    await seedStores();
    await env.DB.prepare("UPDATE session_index SET state = 'active' WHERE session_id = ?")
      .bind(SESSION)
      .run();
    const objects = scriptedObjects();

    expect(await runDeletion(jobEnv, objects, "del_1", clock)).toEqual({ kind: "skipped" });

    expect(objects.calls).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT completed_at, outcome, skip_reason, failed_step FROM deletion_request WHERE id = 'del_1'",
      ).first(),
    ).toEqual({
      completed_at: NOW.toISOString(),
      outcome: "skipped",
      skip_reason: "session_not_deleting",
      failed_step: null,
    });
    expect(
      await count("SELECT COUNT(*) AS n FROM session_index WHERE session_id = ?", SESSION),
    ).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM artifact_index WHERE session_id = ?", SESSION),
    ).toBe(3);
    expect((await present(ALL_KEYS)).length).toBe(ALL_KEYS.length);
    // Closed: a rerun owes nothing.
    expect(await runDeletion(jobEnv, objects, "del_1", clock)).toEqual({ kind: "nothing_owed" });
  });

  it("skips a request whose session's index row belongs to another workspace", async () => {
    await seedSession();
    await env.DB.prepare("UPDATE session_index SET workspace_id = ? WHERE session_id = ?")
      .bind(OTHER_WS, SESSION)
      .run();
    const objects = scriptedObjects();

    expect(await runDeletion(jobEnv, objects, "del_1", clock)).toEqual({ kind: "skipped" });
    expect(objects.calls).toEqual([]);
  });

  it("goes on with no index row only when the object says a delete reached it", async () => {
    await seedSession();
    await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?").bind(SESSION).run();
    const unmarked = scriptedObjects({ marked: false });

    expect(await runDeletion(jobEnv, unmarked, "del_1", clock)).toEqual({ kind: "skipped" });
    expect(unmarked.calls).toEqual([`marked:${SESSION}`]);

    await seedSession(SESSION, "del_2");
    await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?").bind(SESSION).run();
    expect(await runDeletion(jobEnv, scriptedObjects(), "del_2", clock)).toEqual({
      kind: "completed",
    });
    expect(await requestRow("del_2")).toMatchObject({ completed_at: NOW.toISOString() });
  });

  it("keeps the request owed while the object will not erase yet", async () => {
    await seedSession();
    for (const answer of [{ kind: "stopping" }, { kind: "not_deleting" }] as const) {
      expect(
        await runDeletion(jobEnv, scriptedObjects({ erase: async () => answer }), "del_1", clock),
      ).toEqual({ kind: "pending", step: "object" });
    }
    expect(await requestRow()).toMatchObject({ failed_step: "object", completed_at: null });
  });

  it("holds at R2 when a row names an object and no bucket is bound", async () => {
    await seedSession();
    await artifactRow("art_owned", WS, OWNED_ARTIFACT).run();
    const noBucket: DeletionEnv = { ...env, ARTIFACTS: undefined };

    expect(await runDeletion(noBucket, scriptedObjects(), "del_1", clock)).toEqual({
      kind: "pending",
      step: "r2",
    });
    // With nothing to remove, no bucket is needed.
    await env.DB.prepare("DELETE FROM artifact_index").run();
    expect(await runDeletion(noBucket, scriptedObjects(), "del_1", clock)).toEqual({
      kind: "completed",
    });
  });

  it("lists the session's prefix page by page and removes keys a thousand at a time", async () => {
    await seedSession();
    const keys = Array.from({ length: R2_DELETE_BATCH + 1 }, (_, index) =>
      artifactObjectKey(WS, SESSION, "run_1", `art_${String(index).padStart(5, "0")}`),
    );
    const listed: Array<{ prefix: string; cursor: string | undefined }> = [];
    const batches: number[] = [];
    const bucket = {
      list: async (options: { prefix: string; cursor?: string }) => {
        listed.push({ prefix: options.prefix, cursor: options.cursor });
        const page = options.cursor === undefined ? 0 : 1;
        return {
          objects: keys.slice(page * 1000, page * 1000 + 1000).map((key) => ({ key })),
          truncated: page === 0,
          cursor: "page_2",
        };
      },
      delete: async (chunk: string[]) => {
        batches.push(chunk.length);
      },
    } as unknown as R2Bucket;

    expect(
      await runDeletion({ ...env, ARTIFACTS: bucket }, scriptedObjects(), "del_1", clock),
    ).toEqual({ kind: "completed" });
    expect(listed).toEqual([
      { prefix: `workspaces/${WS}/sessions/${SESSION}/`, cursor: undefined },
      { prefix: `workspaces/${WS}/sessions/${SESSION}/`, cursor: "page_2" },
    ]);
    expect(batches).toEqual([R2_DELETE_BATCH, 1]);
  });

  it("removes what one attempt listed and leaves the rest owed when the prefix holds more", async () => {
    await seedSession();
    let pages = 0;
    const removed: string[] = [];
    const bucket = {
      list: async () => {
        pages += 1;
        return {
          objects: [{ key: `workspaces/${WS}/sessions/${SESSION}/runs/r/${pages}` }],
          truncated: true,
          cursor: `c${pages}`,
        };
      },
      delete: async (chunk: string[]) => {
        removed.push(...chunk);
      },
    } as unknown as R2Bucket;

    expect(
      await runDeletion({ ...env, ARTIFACTS: bucket }, scriptedObjects(), "del_1", clock),
    ).toEqual({ kind: "pending", step: "r2" });
    expect(pages).toBe(R2_LIST_PAGES);
    expect(removed).toHaveLength(R2_LIST_PAGES);
  });

  it("keeps a hash of the session's task branch on the receipt, and none for a session without one", async () => {
    await seedSession();
    await seedSession("sess_del_unnamed", "del_unnamed");
    const at = NOW.toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES ('user_del', 'active', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(at, at),
      env.DB.prepare(
        `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
         VALUES (?, 'user_del', 'private', ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(WS, at, at),
    ]);
    const installationRowId = await deriveInstallationRowId(WS, 77);
    await insertOrUpdateInstallation(env.DB, {
      installationRowId,
      workspaceId: WS,
      githubInstallationId: 77,
      githubUserId: 7,
      accountLogin: "octocat",
      accountType: "User",
      sealedUserToken: "oncue1.1.usernonce.usercipher",
      sealedRefreshToken: "oncue1.1.refreshnonce.refreshcipher",
      userTokenExpiresAt: "2026-10-05T08:00:00.000Z",
      refreshTokenExpiresAt: "2027-04-05T00:00:00.000Z",
      now: at,
    });
    await replaceRepositoryConnections(env.DB, {
      workspaceId: WS,
      installationRowId,
      repositories: [
        { githubRepositoryId: 4242, fullName: "octocat/alpha", defaultBranch: "main" },
      ],
      newId: () => "repo_del",
      now: at,
    });
    await env.DB.prepare(
      "UPDATE session_index SET repository_connection_id = 'repo_del', task_branch = ? WHERE session_id = ?",
    )
      .bind("oncue/fix-the-bug-1a2b", SESSION)
      .run();

    expect(await runDeletion(jobEnv, scriptedObjects(), "del_1", clock)).toEqual({
      kind: "completed",
    });
    expect(await runDeletion(jobEnv, scriptedObjects(), "del_unnamed", clock)).toEqual({
      kind: "completed",
    });

    const hashes = await env.DB.prepare(
      "SELECT id, released_ref_hash FROM deletion_request ORDER BY id",
    ).all<{ id: string; released_ref_hash: string | null }>();
    expect(hashes.results).toEqual([
      {
        id: "del_1",
        released_ref_hash: await releasedRefHash(4242, "refs/heads/oncue/fix-the-bug-1a2b"),
      },
      { id: "del_unnamed", released_ref_hash: null },
    ]);
    // A hash, not the name: the receipt holds no content.
    expect(JSON.stringify(hashes.results)).not.toContain("fix-the-bug");
  });

  it("reads a bounded number of artifact rows, and still empties a session that holds more", async () => {
    await seedSession();
    const extra = ARTIFACT_ROWS_PER_ATTEMPT + 1;
    for (let start = 0; start < extra; start += 50) {
      await env.DB.batch(
        Array.from({ length: Math.min(50, extra - start) }, (_unused, offset) => {
          const id = `art_many_${start + offset}`;
          return artifactRow(id, WS, artifactObjectKey(WS, SESSION, "run_1", id));
        }),
      );
    }
    // The last row's object: past the bound, found by the prefix listing.
    const beyond = artifactObjectKey(WS, SESSION, "run_1", `art_many_${extra - 1}`);
    await env.ARTIFACTS.put(beyond, "data");
    let read = -1;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            const first = results[0] as D1Result<{ object_key?: string }> | undefined;
            if (first?.results[0]?.object_key !== undefined) {
              read = first.results.length;
            }
            return results;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(await runDeletion({ ...env, DB: db }, scriptedObjects(), "del_1", clock)).toEqual({
      kind: "completed",
    });

    expect(read).toBe(ARTIFACT_ROWS_PER_ATTEMPT);
    expect(await env.ARTIFACTS.head(beyond)).toBeNull();
    expect(
      await count("SELECT COUNT(*) AS n FROM artifact_index WHERE session_id = ?", SESSION),
    ).toBe(0);
  });

  it("still answers pending when D1 refuses even the note of where it stopped", async () => {
    await seedSession();
    const db = failingDb((sql) => sql.includes("SET failed_step"));
    const objects = scriptedObjects({ close: () => Promise.reject(new Error("evicted")) });

    expect(await runDeletion({ ...env, DB: db }, objects, "del_1", clock)).toEqual({
      kind: "pending",
      step: "stop",
    });
    expect(await requestRow()).toMatchObject({ failed_step: null, completed_at: null });
  });
});

describe("runPendingDeletions", () => {
  it("works the least recently tried owed requests, a bounded batch per run", async () => {
    for (let index = 0; index < DELETION_BATCH + 1; index += 1) {
      await seedSession(`sess_batch_${index}`, `del_batch_${index}`);
    }
    // The last one was tried most recently, so it waits for the next run.
    await env.DB.prepare("UPDATE deletion_request SET last_attempt_at = ? WHERE id = ?")
      .bind(NOW.toISOString(), `del_batch_${DELETION_BATCH}`)
      .run();
    const objects = scriptedObjects();

    const outcomes = await runPendingDeletions(jobEnv, objects);

    expect(outcomes).toHaveLength(DELETION_BATCH);
    expect(outcomes.every((outcome) => outcome.kind === "completed")).toBe(true);
    expect(objects.calls).not.toContain(`close:sess_batch_${DELETION_BATCH}:user_del`);
    expect(await runPendingDeletions(jobEnv, objects, clock)).toEqual([{ kind: "completed" }]);
    expect(await runPendingDeletions(jobEnv, objects, clock)).toEqual([]);
  });
});

describe("a deletion that stays owed", () => {
  const [oldest, older] = RETRY_WAITS;
  const MINUTE = 60_000;

  /** An owed request asked for `ageMs` ago whose stop never finishes, last tried `agoMs` before now. */
  async function seedOwed(name: string, ageMs: number, agoMs: number): Promise<void> {
    await seedSession(`sess_owed_${name}`, `del_owed_${name}`);
    await env.DB.prepare(
      "UPDATE deletion_request SET requested_at = ?, attempts = 50, last_attempt_at = ?, failed_step = 'stop' WHERE id = ?",
    )
      .bind(
        new Date(NOW.getTime() - ageMs).toISOString(),
        new Date(NOW.getTime() - agoMs).toISOString(),
        `del_owed_${name}`,
      )
      .run();
  }

  it("is retried on every run while young, then hourly, then every six hours, however often it was tried", async () => {
    await seedOwed("young", older.olderThanMs - MINUTE, MINUTE);
    await seedOwed("hourly_waiting", older.olderThanMs, older.waitMs - MINUTE);
    await seedOwed("hourly_due", oldest.olderThanMs - MINUTE, older.waitMs);
    await seedOwed("slow_waiting", oldest.olderThanMs, oldest.waitMs - MINUTE);
    await seedOwed("slow_due", 30 * oldest.olderThanMs, oldest.waitMs);
    const objects = scriptedObjects({
      close: async () => ({ kind: "deleting", sandbox: "stopping" }),
    });

    const outcomes = await runPendingDeletions(jobEnv, objects, clock);

    expect(outcomes).toEqual(Array(3).fill({ kind: "pending", step: "stop" }));
    expect(objects.calls.sort()).toEqual([
      "close:sess_owed_hourly_due:user_del",
      "close:sess_owed_slow_due:user_del",
      "close:sess_owed_young:user_del",
    ]);
    // Still owed, every one: waiting closes nothing.
    expect(
      await count("SELECT COUNT(*) AS n FROM deletion_request WHERE completed_at IS NULL"),
    ).toBe(5);
  });

  it("does not hold back a newer request behind ones that are waiting", async () => {
    for (let index = 0; index < DELETION_BATCH; index += 1) {
      await seedOwed(`waiting_${index}`, oldest.olderThanMs, 2 * older.waitMs);
    }
    await seedSession("sess_owed_new", "del_owed_new");
    const objects = scriptedObjects();

    expect(await runPendingDeletions(jobEnv, objects, clock)).toEqual([{ kind: "completed" }]);
    expect(objects.calls).toEqual(["close:sess_owed_new:user_del", "erase:sess_owed_new"]);
  });
});

describe("a released branch's hash", () => {
  it("is blanked by the scheduled run once the window has passed, and kept until then", async () => {
    const insert = (id: string, agoMs: number) =>
      env.DB.prepare(
        `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id,
           requested_at, completed_at, outcome, released_ref_hash)
         VALUES (?, ?, ?, 'user_del', ?, ?, 'deleted', 'abc123')`,
      ).bind(
        id,
        `sess_${id}`,
        WS,
        NOW.toISOString(),
        new Date(NOW.getTime() - agoMs).toISOString(),
      );
    await env.DB.batch([
      insert("del_recent", RELEASED_REF_WINDOW_MS - 1000),
      insert("del_old", RELEASED_REF_WINDOW_MS),
    ]);

    expect(await runPendingDeletions(jobEnv, scriptedObjects(), clock)).toEqual([]);

    const rows = await env.DB.prepare(
      "SELECT id, released_ref_hash, completed_at FROM deletion_request ORDER BY id",
    ).all<{ id: string; released_ref_hash: string | null; completed_at: string }>();
    expect(rows.results.map((row) => [row.id, row.released_ref_hash])).toEqual([
      ["del_old", null],
      ["del_recent", "abc123"],
    ]);
    // The receipt itself stays.
    expect(rows.results.every((row) => row.completed_at !== null)).toBe(true);
  });
});

describe("the whole deletion through the route and a real session object", () => {
  it("stops the sandbox, removes every row and object the session owns, erases the object, and writes one receipt", async () => {
    const subject = "owner_whole_delete";
    const workspaceId = await deriveWorkspaceId(subject);
    const sessionId = "sess_whole_delete";
    const world = await sessionOnRealDriver(sessionId, { workspaceId });
    await readyBridge(world, 1, { closeOnShutdown: true });
    const artifactKey = artifactObjectKey(workspaceId, sessionId, "run_1", "art_whole");
    const attachmentKey = attachmentObjectKey(workspaceId, "att_whole");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO artifact (id, session_id, run_id, kind, content_type, state, object_key, created_at)
         VALUES ('art_whole', ?, 'run_1', 'log', 'text/plain', 'created', ?, ?)`,
        sessionId,
        artifactKey,
        NOW.toISOString(),
      );
    });
    await env.DB.prepare(
      `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
         content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
       VALUES ('att_whole', ?, ?, ?, 'notes.txt', 'text/plain', 'file', 4, 'x', ?, ?, ?)`,
    )
      .bind(
        workspaceId,
        await deriveUserId(subject),
        sessionId,
        attachmentKey,
        NOW.toISOString(),
        NOW.toISOString(),
      )
      .run();
    await env.ARTIFACTS.put(artifactKey, "log");
    await env.ARTIFACTS.put(attachmentKey, "notes");

    const deferred: Promise<unknown>[] = [];
    const deps = realDeleteDeps(
      env,
      (requestId) => runDeletion(env, realDeletionObjects(env), requestId),
      (work) => deferred.push(work),
    );
    const double = await createClerkDouble();
    const response = await handleDeleteSession(
      await double.requestAs(subject, `https://oncue.example/api/sessions/${sessionId}`),
      { ...env, CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject } as unknown as Env,
      sessionId,
      deps,
      createAllowlistCache(),
    );
    expect(response.status).toBe(202);
    expect(await Promise.all(deferred)).toEqual([{ kind: "completed" }]);

    expect(world.controllerCalls.some((call) => call.operation === "stop")).toBe(true);
    expect(
      await count("SELECT COUNT(*) AS n FROM session_index WHERE session_id = ?", sessionId),
    ).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM message_attachment WHERE session_id = ?", sessionId),
    ).toBe(0);
    expect(await present([artifactKey, attachmentKey])).toEqual([]);
    expect(await runInDurableObject(world.stub, (instance) => instance.readSession())).toBeNull();
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
    const receipts = await env.DB.prepare(
      "SELECT session_id, workspace_id, completed_at FROM deletion_request WHERE session_id = ?",
    )
      .bind(sessionId)
      .all<{ session_id: string; workspace_id: string; completed_at: string | null }>();
    expect(receipts.results).toEqual([
      { session_id: sessionId, workspace_id: workspaceId, completed_at: expect.any(String) },
    ]);

    // The route now treats the session as gone.
    const again = await handleDeleteSession(
      await double.requestAs(subject, `https://oncue.example/api/sessions/${sessionId}`),
      { ...env, CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject } as unknown as Env,
      sessionId,
      deps,
      createAllowlistCache(),
    );
    expect(again.status).toBe(403);
  });

  it("reports an object that answers with an error as a failed step", async () => {
    const failing = {
      ...env,
      SESSION: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => new Response("no", { status: 500 }) }),
      },
    } as unknown as Env;
    const objects = realDeletionObjects(failing);
    await expect(objects.close("sess_x", "user_x")).rejects.toThrow("answered 500");
    await expect(objects.erase("sess_x")).rejects.toThrow("answered 500");
    await expect(objects.marked("sess_x")).rejects.toThrow("answered 500");
  });
});
