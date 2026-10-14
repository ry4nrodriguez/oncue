// Composer attachments through the real handlers and routing: cookie routes
// use the Clerk double, the bridge's fetch a token seeded in a real session
// object.

import {
  createExecutionContext,
  env,
  listDurableObjectIds,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { ATTACHMENT_LIMITS } from "@oncue/protocol";
import { describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveWorkspaceId } from "../auth/register";
import worker from "../index";
import { sha256Hex } from "../test/bridge-credential";
import { createClerkDouble } from "../test/clerk-double";
import { registerSessionWorlds, sessionOnRealDriver } from "../test/session-world";
import {
  contentDisposition,
  FILE_NAME_HEADER,
  handleDiscardAttachment,
  handleFetchAttachment,
  handleUploadAttachment,
  handleViewAttachment,
  matchAttachmentRoute,
  readBounded,
} from "./routes";
import { attachmentObjectKey, claimAttachments } from "./store";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const ORIGIN = "https://oncue.example";
const bucket = env.ARTIFACTS as R2Bucket;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const TEXT = new TextEncoder().encode('{"a":1}\n');
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]);

function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

interface Person {
  readonly subject: string;
  readonly workspaceId: string;
  readonly env: Env;
  request(url: string, init?: RequestInit): Promise<Request>;
}

async function person(subject: string): Promise<Person> {
  const double = await createClerkDouble();
  const personEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });
  return {
    subject,
    workspaceId: await deriveWorkspaceId(subject),
    env: personEnv,
    async request(url, init = {}) {
      const signed = await double.requestAs(subject, url);
      const headers = new Headers(init.headers);
      headers.set("cookie", signed.headers.get("cookie") ?? "");
      return new Request(url, { ...init, headers });
    },
  };
}

async function uploadAs(
  who: Person,
  bytes: Uint8Array,
  name: string | null,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (name !== null) {
    headers[FILE_NAME_HEADER] = encodeURIComponent(name);
  }
  return handleUploadAttachment(
    await who.request(`${ORIGIN}/api/attachments`, { method: "POST", body: bytes, headers }),
    envWith({ ...who.env, ...overrides }),
    createAllowlistCache(),
  );
}

async function uploaded(who: Person, bytes: Uint8Array, name: string): Promise<string> {
  const response = await uploadAs(who, bytes, name);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { attachment: { artifactId: string } };
  return body.attachment.artifactId;
}

async function rowOf(attachmentId: string) {
  return env.DB.prepare("SELECT * FROM message_attachment WHERE attachment_id = ?")
    .bind(attachmentId)
    .first<Record<string, unknown>>();
}

async function seedSession(sessionId: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
     VALUES (?, ?, NULL, 'active', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
  )
    .bind(sessionId, workspaceId)
    .run();
}

describe("matchAttachmentRoute", () => {
  it("names the four routes and nothing else", () => {
    expect(matchAttachmentRoute("/api/attachments", "POST")).toEqual({ kind: "upload" });
    expect(matchAttachmentRoute("/api/attachments", "GET")).toBeNull();
    expect(matchAttachmentRoute("/api/attachments/att_1", "DELETE")).toEqual({
      kind: "discard",
      attachmentId: "att_1",
    });
    expect(matchAttachmentRoute("/api/attachments/att_1", "GET")).toBeNull();
    expect(matchAttachmentRoute("/api/sessions/s1/attachments/att_1", "GET")).toEqual({
      kind: "view",
      sessionId: "s1",
      attachmentId: "att_1",
    });
    expect(matchAttachmentRoute("/api/sessions/s1/attachments/att_1/content", "GET")).toEqual({
      kind: "fetch",
      sessionId: "s1",
      attachmentId: "att_1",
    });
    expect(matchAttachmentRoute("/api/sessions/s1/attachments/att_1", "PUT")).toBeNull();
    expect(matchAttachmentRoute("/api/sessions/s1/artifacts/a", "GET")).toBeNull();
  });
});

describe("contentDisposition", () => {
  it("keeps an ASCII fallback and the real name, so no name breaks the header", () => {
    expect(contentDisposition("inline", 'shot "1".png')).toBe(
      `inline; filename="shot _1_.png"; filename*=UTF-8''shot%20%221%22.png`,
    );
    expect(contentDisposition("attachment", "café.md")).toBe(
      `attachment; filename="caf_.md"; filename*=UTF-8''caf%C3%A9.md`,
    );
  });
});

describe("readBounded", () => {
  it("reads a body up to the limit and stops one byte past it", async () => {
    expect(await readBounded(null, 10)).toEqual(new Uint8Array(0));
    const small = new Response(new Uint8Array([1, 2, 3])).body;
    expect(await readBounded(small, 3)).toEqual(new Uint8Array([1, 2, 3]));
    const large = new Response(new Uint8Array(11)).body;
    expect(await readBounded(large, 10)).toBe("too_large");
  });
});

describe("POST /api/attachments", () => {
  it("stores an image under the workspace, typed by its bytes, unclaimed", async () => {
    const who = await person("attach_upload_png");
    const response = await uploadAs(who, PNG, "C:\\Users\\me\\screen shot.txt");
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      attachment: { artifactId: string; kind: string; contentType: string; label: string };
    };
    expect(body.attachment).toMatchObject({
      kind: "file",
      contentType: "image/png",
      byteSize: PNG.byteLength,
      label: "screen shot.txt",
    });
    const id = body.attachment.artifactId;
    expect(await rowOf(id)).toMatchObject({
      workspace_id: who.workspaceId,
      session_id: null,
      kind: "image",
      content_type: "image/png",
      object_key: attachmentObjectKey(who.workspaceId, id),
    });
    const object = await bucket.get(attachmentObjectKey(who.workspaceId, id));
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(PNG);
  });

  it("stores text under the text type its extension picks, and names a nameless upload", async () => {
    const who = await person("attach_upload_text");
    const response = await uploadAs(who, TEXT, null);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      attachment: { contentType: "text/plain", label: "attachment" },
    });
    expect(await (await uploadAs(who, TEXT, "data.json")).json()).toMatchObject({
      attachment: { contentType: "application/json" },
    });
  });

  it("is reachable through the Worker's own routing", async () => {
    const who = await person("attach_upload_routed");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      (await who.request(`${ORIGIN}/api/attachments`, {
        method: "POST",
        body: PNG,
        headers: { [FILE_NAME_HEADER]: "a.png" },
      })) as Parameters<typeof worker.fetch>[0],
      who.env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
  });

  it("refuses the unauthenticated and the un-allowlisted", async () => {
    const who = await person("attach_upload_auth");
    const anonymous = await handleUploadAttachment(
      new Request(`${ORIGIN}/api/attachments`, { method: "POST", body: PNG }),
      who.env,
      createAllowlistCache(),
    );
    expect(anonymous.status).toBe(401);
    const outsider = await uploadAs(who, PNG, "a.png", { ONCUE_USER_ALLOWLIST: "someone_else" });
    expect(outsider.status).toBe(403);
  });

  it.each([
    ["an executable", ELF, 415, "unsupported_type"],
    ["an empty file", new Uint8Array(0), 400, "empty"],
  ])("refuses %s by its bytes and stores nothing", async (_label, bytes, status, error) => {
    const who = await person(`attach_upload_refuse_${status}`);
    const response = await uploadAs(who, bytes, "innocent.png");
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM message_attachment WHERE workspace_id = ?",
    )
      .bind(who.workspaceId)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("refuses a declared length past the image limit before reading, and a text file past the file limit", async () => {
    const who = await person("attach_upload_large");
    const declared = await handleUploadAttachment(
      await who.request(`${ORIGIN}/api/attachments`, {
        method: "POST",
        body: PNG,
        headers: { "content-length": String(ATTACHMENT_LIMITS.imageBytes + 1) },
      }),
      who.env,
      createAllowlistCache(),
    );
    expect(declared.status).toBe(413);
    const bigText = new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1).fill(0x61);
    expect((await uploadAs(who, bigText, "big.txt")).status).toBe(413);
    const past = new Uint8Array(ATTACHMENT_LIMITS.imageBytes + 1);
    past.set(PNG);
    // A streamed body carries no length, so only the read can find it too long.
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(past);
        controller.close();
      },
    });
    const stream = await handleUploadAttachment(
      await who.request(`${ORIGIN}/api/attachments`, {
        method: "POST",
        body: streamed,
        // @ts-expect-error: `duplex` is required for a streamed body and missing from the type.
        duplex: "half",
      }),
      who.env,
      createAllowlistCache(),
    );
    expect(stream.status).toBe(413);
  });

  it("refuses a file name that is not percent-encoded", async () => {
    const who = await person("attach_upload_badname");
    const response = await handleUploadAttachment(
      await who.request(`${ORIGIN}/api/attachments`, {
        method: "POST",
        body: PNG,
        headers: { [FILE_NAME_HEADER]: "%E0%A4%A" },
      }),
      who.env,
      createAllowlistCache(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_name" });
  });

  it("answers 503 without the storage binding", async () => {
    const who = await person("attach_upload_nobucket");
    expect((await uploadAs(who, PNG, "a.png", { ARTIFACTS: undefined })).status).toBe(503);
  });

  it("caps a workspace's unsent uploads, and sweeps its day-old ones first", async () => {
    const who = await person("attach_upload_cap");
    const insert = (id: string, createdAt: string) =>
      env.DB.prepare(
        `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
           content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
         VALUES (?, ?, 'u', NULL, 'a.png', 'image/png', 'image', 1, 'x', ?, ?, NULL)`,
      )
        .bind(id, who.workspaceId, `k/${id}`, createdAt)
        .run();
    const fresh = new Date().toISOString();
    for (let index = 0; index < ATTACHMENT_LIMITS.unclaimedPerWorkspace; index += 1) {
      await insert(`cap_${index}`, fresh);
    }
    const refused = await uploadAs(who, PNG, "a.png");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "too_many_pending" });

    // Age one past a day: the next upload sweeps it and fits.
    await env.DB.prepare(
      "UPDATE message_attachment SET created_at = ? WHERE attachment_id = 'cap_0'",
    )
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    expect((await uploadAs(who, PNG, "a.png")).status).toBe(201);
    expect(await rowOf("cap_0")).toBeNull();
  });

  it("keeps no bytes when storage refuses them, or when the row cannot be written", async () => {
    const who = await person("attach_upload_storage");
    const refusing = {
      put: async () => {
        throw new Error("R2 down");
      },
      delete: async () => undefined,
    };
    expect((await uploadAs(who, PNG, "a.png", { ARTIFACTS: refusing })).status).toBe(502);

    const deleted: string[] = [];
    const recording = {
      put: (key: string, value: Uint8Array, options: R2PutOptions) =>
        bucket.put(key, value, options),
      delete: async (key: string) => {
        deleted.push(key);
        await bucket.delete(key);
      },
    };
    const brokenDb = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("INSERT INTO message_attachment")) {
              return statement;
            }
            return new Proxy(statement, {
              get(inner, member) {
                if (member === "bind") {
                  return () => ({ run: async () => Promise.reject(new Error("D1 down")) });
                }
                return Reflect.get(inner, member);
              },
            });
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await uploadAs(who, PNG, "a.png", { ARTIFACTS: recording, DB: brokenDb });
    expect(response.status).toBe(502);
    expect(deleted).toHaveLength(1);
    expect(await bucket.get(deleted[0] as string)).toBeNull();

    // A delete that fails as well changes nothing the person is told.
    const stuck = {
      put: recording.put,
      delete: async () => {
        throw new Error("R2 down");
      },
    };
    expect((await uploadAs(who, PNG, "a.png", { ARTIFACTS: stuck, DB: brokenDb })).status).toBe(
      502,
    );
  });
});

describe("DELETE /api/attachments/:id", () => {
  const discard = async (who: Person, id: string, overrides: Record<string, unknown> = {}) =>
    handleDiscardAttachment(
      await who.request(`${ORIGIN}/api/attachments/${id}`, { method: "DELETE" }),
      envWith({ ...who.env, ...overrides }),
      id,
      createAllowlistCache(),
    );

  it("removes an unsent upload and its bytes", async () => {
    const who = await person("attach_discard_ok");
    const id = await uploaded(who, PNG, "a.png");
    const response = await discard(who, id);
    expect(response.status).toBe(204);
    expect(await rowOf(id)).toBeNull();
    expect(await bucket.get(attachmentObjectKey(who.workspaceId, id))).toBeNull();
  });

  it("keeps a sent attachment, and another workspace's, answering as if absent", async () => {
    const who = await person("attach_discard_sent");
    const id = await uploaded(who, PNG, "a.png");
    await claimAttachments(env.DB, {
      workspaceId: who.workspaceId,
      sessionId: "sess_discard_sent",
      attachmentIds: [id],
      now: "2026-09-27T00:00:00.000Z",
    });
    expect((await discard(who, id)).status).toBe(404);
    const other = await person("attach_discard_stranger");
    const theirs = await uploaded(who, TEXT, "b.txt");
    expect((await discard(other, theirs)).status).toBe(404);
    expect(await rowOf(theirs)).not.toBeNull();
  });

  it("refuses the unauthenticated and the un-allowlisted, and needs no storage to forget a row", async () => {
    const who = await person("attach_discard_auth");
    const id = await uploaded(who, PNG, "a.png");
    const anonymous = await handleDiscardAttachment(
      new Request(`${ORIGIN}/api/attachments/${id}`, { method: "DELETE" }),
      who.env,
      id,
      createAllowlistCache(),
    );
    expect(anonymous.status).toBe(401);
    expect((await discard(who, id, { ONCUE_USER_ALLOWLIST: "nobody" })).status).toBe(403);
    expect((await discard(who, id, { ARTIFACTS: undefined })).status).toBe(204);
    const other = await uploaded(who, PNG, "b.png");
    const failing = {
      delete: async () => {
        throw new Error("R2 down");
      },
    };
    expect((await discard(who, other, { ARTIFACTS: failing })).status).toBe(204);
  });
});

describe("GET /api/sessions/:sessionId/attachments/:id", () => {
  async function sent(subject: string, sessionId: string, bytes: Uint8Array, name: string) {
    const who = await person(subject);
    await seedSession(sessionId, who.workspaceId);
    const id = await uploaded(who, bytes, name);
    await claimAttachments(env.DB, {
      workspaceId: who.workspaceId,
      sessionId,
      attachmentIds: [id],
      now: "2026-09-27T00:00:00.000Z",
    });
    const view = async (as: Person = who, overrides: Record<string, unknown> = {}) =>
      handleViewAttachment(
        await as.request(`${ORIGIN}/api/sessions/${sessionId}/attachments/${id}`),
        envWith({ ...as.env, ...overrides }),
        { sessionId, attachmentId: id },
        createAllowlistCache(),
      );
    return { who, id, view };
  }

  it("serves an image inline as the raster type its bytes were, and never lets it run", async () => {
    const { view } = await sent("attach_view_image", "sess_view_image", PNG, "screen.png");
    const response = await view();
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": `inline; filename="screen.png"; filename*=UTF-8''screen.png`,
      "cache-control": "private, max-age=3600",
      "content-length": String(PNG.byteLength),
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("serves anything else as an opaque download", async () => {
    const svg = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    const { view } = await sent("attach_view_file", "sess_view_file", svg, "picture.svg");
    const response = await view();
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("refuses everyone but the owner", async () => {
    const { who, view, id } = await sent("attach_view_owner", "sess_view_owner", PNG, "a.png");
    const stranger = await person("attach_view_stranger");
    expect((await view(stranger)).status).toBe(403);
    const anonymous = await handleViewAttachment(
      new Request(`${ORIGIN}/api/sessions/sess_view_owner/attachments/${id}`),
      who.env,
      { sessionId: "sess_view_owner", attachmentId: id },
      createAllowlistCache(),
    );
    expect(anonymous.status).toBe(401);
  });

  it("answers 404 for an upload no message in this session claimed, and for bytes that are gone", async () => {
    const { who, view, id } = await sent("attach_view_gone", "sess_view_gone", PNG, "a.png");
    const unsent = await uploaded(who, PNG, "b.png");
    const response = await handleViewAttachment(
      await who.request(`${ORIGIN}/api/sessions/sess_view_gone/attachments/${unsent}`),
      who.env,
      { sessionId: "sess_view_gone", attachmentId: unsent },
      createAllowlistCache(),
    );
    expect(response.status).toBe(404);
    await bucket.delete(attachmentObjectKey(who.workspaceId, id));
    expect((await view()).status).toBe(404);
  });

  it("answers 503 without the storage binding", async () => {
    const { view } = await sent("attach_view_nobucket", "sess_view_nobucket", PNG, "a.png");
    expect((await view(undefined, { ARTIFACTS: undefined })).status).toBe(503);
  });
});

describe("GET /api/sessions/:sessionId/attachments/:id/content (the bridge's fetch)", () => {
  async function fetchWorld(sessionId: string) {
    const world = await sessionOnRealDriver(sessionId);
    const who = await person(`attach_fetch_${sessionId}`);
    // The workspace of the session the driver made; the upload is placed there.
    const id = crypto.randomUUID();
    const key = attachmentObjectKey(world.workspaceId, id);
    await bucket.put(key, PNG);
    await env.DB.prepare(
      `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
         content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
       VALUES (?, ?, 'u', ?, 'a.png', 'image/png', 'image', ?, 'x', ?, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
    )
      .bind(id, world.workspaceId, sessionId, PNG.byteLength, key)
      .run();
    const seed = async (generation = 1, expiresAtMs = Date.now() + 60_000) => {
      const token = `fetch-${crypto.randomUUID()}`;
      const hash = await sha256Hex(token);
      await runInDurableObject(world.stub, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO attachment_access (token_sha256, attachment_id, generation, expires_at_ms, used_at) VALUES (?,?,?,?,NULL)",
          hash,
          id,
          generation,
          expiresAtMs,
        );
      });
      return token;
    };
    const fetchWith = (token: string | null, overrides: Record<string, unknown> = {}) =>
      handleFetchAttachment(
        new Request(`${ORIGIN}/api/sessions/${sessionId}/attachments/${id}/content`, {
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        }),
        envWith(overrides),
        { sessionId, attachmentId: id },
      );
    return { world, who, id, key, seed, fetchWith };
  }

  it("hands the bytes to the token's holder exactly once", async () => {
    const { seed, fetchWith } = await fetchWorld("sess_fetch_once");
    const token = await seed();
    const response = await fetchWith(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect((await fetchWith(token)).status).toBe(403);
  });

  it("refuses a bearer for a session nobody created, and wakes no object to check it", async () => {
    const sessionId = "sess_fetch_never_created";
    const response = await handleFetchAttachment(
      new Request(`${ORIGIN}/api/sessions/${sessionId}/attachments/att_1/content`, {
        headers: { authorization: "Bearer any-bearer" },
      }),
      env,
      { sessionId, attachmentId: "att_1" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    const wanted = env.SESSION.idFromName(sessionId);
    expect((await listDurableObjectIds(env.SESSION)).some((id) => id.equals(wanted))).toBe(false);
  });

  it("refuses no token, a wrong token, another generation's, and an expired one", async () => {
    const { seed, fetchWith } = await fetchWorld("sess_fetch_refused");
    expect((await fetchWith(null)).status).toBe(403);
    expect((await fetchWith("not-a-token")).status).toBe(403);
    expect((await fetchWith(await seed(2))).status).toBe(403);
    expect((await fetchWith(await seed(1, Date.now() - 1))).status).toBe(403);
  });

  it("answers 503 without storage and 404 when the bytes, or the row, are gone", async () => {
    const { seed, fetchWith, key, id } = await fetchWorld("sess_fetch_gone");
    expect((await fetchWith(await seed(), { ARTIFACTS: undefined })).status).toBe(503);
    await bucket.delete(key);
    expect((await fetchWith(await seed())).status).toBe(404);
    await env.DB.prepare("DELETE FROM message_attachment WHERE attachment_id = ?").bind(id).run();
    expect((await fetchWith(await seed())).status).toBe(404);
  });
});
