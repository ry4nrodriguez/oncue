// The artifact upload and downloads through the real Worker handlers and the
// real session object.

import {
  createExecutionContext,
  env,
  listDurableObjectIds,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveWorkspaceId } from "../auth/register";
import worker from "../index";
import { sha256Hex } from "../test/bridge-credential";
import { createClerkDouble } from "../test/clerk-double";
import {
  eventsOfType,
  readyBridge,
  registerSessionWorlds,
  sessionOnRealDriver,
  type TestBridge,
  waitFor,
} from "../test/session-world";
import {
  handleDownloadArtifact,
  handleRestoreArtifact,
  handleUploadArtifact,
  matchArtifactPath,
} from "./upload";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

type World = Awaited<ReturnType<typeof sessionOnRealDriver>>;

const ORIGIN = "https://oncue.example";
// The "absent" tests pass an env without this binding.
const bucket = env.ARTIFACTS as R2Bucket;
const BYTES = new TextEncoder().encode("line 1\nline 2\n");

function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

function artifactUrl(sessionId: string, artifactId: string, restore = false): string {
  return `${ORIGIN}/api/sessions/${sessionId}/artifacts/${artifactId}${restore ? "/restore" : ""}`;
}

/** Whether a session's object has ever been woken: the cost a refusal at the route avoids. */
async function objectExists(sessionId: string): Promise<boolean> {
  const wanted = env.SESSION.idFromName(sessionId);
  return (await listDurableObjectIds(env.SESSION)).some((id) => id.equals(wanted));
}

function pathFor(sessionId: string, artifactId: string, restore = false) {
  return { sessionId, artifactId, restore };
}

interface Uploading {
  readonly world: World;
  readonly bridge: TestBridge;
  readonly token: string;
  readonly key: string;
  readonly sha256: string;
}

/** A session whose bridge has declared `artifactId` and holds its upload token. */
async function uploading(
  sessionId: string,
  options: {
    readonly workspaceId?: string;
    readonly artifactId?: string;
    readonly bytes?: number;
  } = {},
): Promise<Uploading> {
  const artifactId = options.artifactId ?? "art_1";
  const world = await sessionOnRealDriver(sessionId, {
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
  const bridge = await readyBridge(world);
  bridge.send(
    bridge.event("artifact.uploading", {
      runId: "run_1",
      payload: {
        artifactId,
        kind: "log",
        contentType: "text/plain",
        declaredBytes: options.bytes ?? BYTES.length,
        producer: "tool",
      },
    }),
  );
  await waitFor(() => bridge.grants("upload").length >= 1, "the upload grant");
  const grant = bridge.grants("upload")[0] as { token: string };
  return {
    world,
    bridge,
    token: grant.token,
    key: `workspaces/${world.workspaceId}/sessions/${sessionId}/runs/run_1/${artifactId}`,
    sha256: await sha256Hex(new TextDecoder().decode(BYTES)),
  };
}

function putRequest(
  sessionId: string,
  artifactId: string,
  options: {
    readonly token?: string | null;
    readonly sha256?: string | null;
    readonly length?: number;
    readonly body?: BodyInit | null;
  },
): Request {
  const headers: Record<string, string> = {};
  if (options.token !== null && options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.sha256 !== null && options.sha256 !== undefined) {
    headers["x-oncue-sha256"] = options.sha256;
  }
  headers["content-length"] = String(options.length ?? BYTES.length);
  return new Request(artifactUrl(sessionId, artifactId), {
    method: "PUT",
    headers,
    body: options.body === undefined ? BYTES : options.body,
  });
}

async function upload(
  sessionId: string,
  artifactId: string,
  options: Parameters<typeof putRequest>[2],
) {
  return handleUploadArtifact(
    putRequest(sessionId, artifactId, options),
    env,
    pathFor(sessionId, artifactId),
  );
}

async function artifactState(world: World, artifactId: string): Promise<string | null> {
  const rows = await runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM artifact WHERE id = ?",
      artifactId,
    ),
  ]);
  return rows[0]?.state ?? null;
}

async function failures(world: World): Promise<Array<{ stage: string; reason: string }>> {
  return (await eventsOfType(world.stub, "artifact.failed")).map((event) => {
    const { stage, reason } = event.payload as { stage: string; reason: string };
    return { stage, reason };
  });
}

/** A restore token for `artifactId`, recorded the way the object records one when it sends a git grant. */
async function seedRestoreToken(
  world: World,
  artifactId: string,
  expiresAtMs?: number,
): Promise<string> {
  const token = `restore-${crypto.randomUUID()}`;
  const hash = await sha256Hex(token);
  await runInDurableObject(world.stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO artifact_access (token_sha256, artifact_id, purpose, generation, expires_at_ms, used_at) VALUES (?,?,'restore',1,?,NULL)",
      hash,
      artifactId,
      expiresAtMs ?? Date.now() + 60_000,
    );
  });
  return token;
}

describe("matchArtifactPath", () => {
  it("matches an artifact and its restore, and nothing else", () => {
    expect(matchArtifactPath("/api/sessions/sess_1/artifacts/art_1")).toEqual({
      sessionId: "sess_1",
      artifactId: "art_1",
      restore: false,
    });
    expect(matchArtifactPath("/api/sessions/sess_1/artifacts/art_1/restore")).toEqual({
      sessionId: "sess_1",
      artifactId: "art_1",
      restore: true,
    });
    expect(matchArtifactPath("/api/sessions/sess_1/artifacts")).toBeNull();
    expect(matchArtifactPath("/api/sessions/sess_1/artifacts/art_1/other")).toBeNull();
  });
});

describe("PUT /api/sessions/:id/artifacts/:artifactId", () => {
  it("stores the bytes under record 03's key, commits artifact.created after R2 confirms, and writes the index", async () => {
    const { world, token, key, sha256 } = await uploading("sess_upload_ok");

    const response = await upload(world.sessionId, "art_1", { token, sha256 });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ artifactId: "art_1" });
    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    expect(await object?.text()).toBe("line 1\nline 2\n");
    expect(object?.httpMetadata?.contentType).toBe("text/plain");
    expect((await eventsOfType(world.stub, "artifact.created"))[0]?.payload).toMatchObject({
      artifact: { artifactId: "art_1", byteSize: BYTES.length },
      checksum: { algorithm: "sha256", value: sha256 },
    });
    expect(await artifactState(world, "art_1")).toBe("created");
    const indexed = await env.DB.prepare(
      "SELECT workspace_id, session_id, run_id, kind, producer, content_type, byte_size, sha256, classification, object_key FROM artifact_index WHERE artifact_id = ?",
    )
      .bind("art_1")
      .first();
    expect(indexed).toEqual({
      workspace_id: "ws_1",
      session_id: world.sessionId,
      run_id: "run_1",
      kind: "log",
      producer: "tool",
      content_type: "text/plain",
      byte_size: BYTES.length,
      sha256,
      classification: "temporary",
      object_key: key,
    });
    // The token was spent by the upload.
    expect((await upload(world.sessionId, "art_1", { token, sha256 })).status).toBe(403);
  });

  it("is reachable through the Worker's own routing", async () => {
    const { world, token, sha256 } = await uploading("sess_upload_routed");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      putRequest(world.sessionId, "art_1", { token, sha256 }) as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
  });

  it("refuses a checksum that does not match the bytes, and keeps nothing", async () => {
    const { world, token, key } = await uploading("sess_upload_checksum");

    const response = await upload(world.sessionId, "art_1", { token, sha256: "0".repeat(64) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "checksum_mismatch" });
    expect(await bucket.get(key)).toBeNull();
    expect(await failures(world)).toEqual([
      { stage: "validate", reason: expect.stringMatching(/checksum did not match/) },
    ]);
    expect(await artifactState(world, "art_1")).toBe("failed");
    expect(await eventsOfType(world.stub, "artifact.created")).toEqual([]);
  });

  it.each([
    ["a malformed checksum header", { sha256: "not-hex" }],
    ["no checksum header", { sha256: null }],
    ["a length other than the declared one", { length: BYTES.length + 1 }],
    ["no body", { body: null }],
  ] as const)("refuses an upload with %s before reading it", async (_name, options) => {
    const { world, token, key, sha256 } = await uploading(`sess_upload_invalid_${_name.length}`);

    const response = await upload(world.sessionId, "art_1", { token, sha256, ...options });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "upload_invalid" });
    expect(await bucket.get(key)).toBeNull();
    expect(await failures(world)).toEqual([
      { stage: "validate", reason: expect.stringMatching(/declared length and a SHA-256/) },
    ]);
    expect(await artifactState(world, "art_1")).toBe("failed");
  });

  it("answers 502 and records the failure when the body ends short of the declared length", async () => {
    const { world, token, key, sha256 } = await uploading("sess_upload_short");
    const short = new ReadableStream({
      start(controller) {
        controller.enqueue(BYTES.slice(0, 3));
        controller.close();
      },
    });

    const response = await upload(world.sessionId, "art_1", { token, sha256, body: short });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upload_failed" });
    expect(await bucket.get(key)).toBeNull();
    expect(await failures(world)).toEqual([
      { stage: "upload", reason: "Storage did not accept the upload." },
    ]);
    expect(await artifactState(world, "art_1")).toBe("failed");
  });

  it.each([
    ["no bearer", async (_u: Uploading): Promise<string | null> => null],
    [
      "a token already spent",
      async (u: Uploading): Promise<string | null> => {
        await upload(u.world.sessionId, "art_1", { token: u.token, sha256: u.sha256 });
        return u.token;
      },
    ],
    [
      "a restore token",
      async (u: Uploading): Promise<string | null> => seedRestoreToken(u.world, "art_1"),
    ],
    [
      "an expired token",
      async (u: Uploading): Promise<string | null> => {
        await runInDurableObject(u.world.stub, (_instance, state) => {
          state.storage.sql.exec("UPDATE artifact_access SET expires_at_ms = ?", Date.now() - 1);
        });
        return u.token;
      },
    ],
  ] as const)("refuses %s with 403 and reads no bytes", async (name, tokenFor) => {
    const u = await uploading(`sess_upload_refused_${name.replaceAll(" ", "_")}`);
    const token = await tokenFor(u);
    const eventsBefore = (await eventsOfType(u.world.stub, "artifact.failed")).length;

    const response = await upload(u.world.sessionId, "art_1", { token, sha256: u.sha256 });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect((await eventsOfType(u.world.stub, "artifact.failed")).length).toBe(eventsBefore);
  });

  it("answers 503 without the storage binding once the token is spent, and records the artifact failed", async () => {
    const { world, token, sha256 } = await uploading("sess_upload_no_bucket");
    const response = await handleUploadArtifact(
      putRequest(world.sessionId, "art_1", { token, sha256 }),
      envWith({ ARTIFACTS: undefined }),
      pathFor(world.sessionId, "art_1"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "artifact_storage_unavailable" });
    // The refusal is on the timeline, and the artifact no longer counts against
    // the run's budget.
    expect((await eventsOfType(world.stub, "artifact.failed"))[0]?.payload).toEqual({
      artifactId: "art_1",
      stage: "upload",
      reason: "Artifact storage is not configured on this deployment.",
      retryable: false,
    });
    expect(await artifactState(world, "art_1")).toBe("failed");
    expect((await upload(world.sessionId, "art_1", { token, sha256 })).status).toBe(403);
  });

  it("refuses a bearer for a session nobody created, and wakes no object to check it", async () => {
    const sessionId = "sess_upload_never_created";
    const response = await handleUploadArtifact(
      putRequest(sessionId, "art_1", { token: "any-bearer", sha256: "0".repeat(64) }),
      env,
      pathFor(sessionId, "art_1"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await objectExists(sessionId)).toBe(false);
  });

  it("refuses a request with no bearer before it asks whether storage exists", async () => {
    const { world, sha256 } = await uploading("sess_upload_no_bucket_no_token");
    const response = await handleUploadArtifact(
      putRequest(world.sessionId, "art_1", { token: null, sha256 }),
      envWith({ ARTIFACTS: undefined }),
      pathFor(world.sessionId, "art_1"),
    );
    expect(response.status).toBe(403);
    expect(await artifactState(world, "art_1")).toBe("uploading");
  });

  it("deletes the stored bytes and answers 409 when the session no longer wants the artifact", async () => {
    const { world, token, key, sha256 } = await uploading("sess_upload_unwanted");
    // The body closes a second after its bytes, and the session marks the
    // artifact failed in that second: the object refuses the completion.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(BYTES);
        setTimeout(() => controller.close(), 1_000);
      },
    });
    const pending = upload(world.sessionId, "art_1", { token, sha256, body });
    await waitFor(
      async () =>
        (
          await runInDurableObject(world.stub, (_instance, state) => [
            ...state.storage.sql.exec<{ used_at: string | null }>(
              "SELECT used_at FROM artifact_access",
            ),
          ])
        ).every((row) => row.used_at !== null),
      "the token to be spent",
    );
    await world.stub.fetch("https://do/internal/artifacts/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifactId: "art_1", stage: "upload", reason: "abandoned" }),
    });

    const response = await pending;

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "upload_refused" });
    expect(await bucket.get(key)).toBeNull();
    expect(await eventsOfType(world.stub, "artifact.created")).toEqual([]);
  });

  it("still answers 201 when D1 refuses the index row: discovery is lost, the artifact is not", async () => {
    const { world, token, sha256 } = await uploading("sess_upload_index_refused");
    await env.DB.prepare(
      "CREATE TRIGGER refuse_index BEFORE INSERT ON artifact_index BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ).run();
    try {
      const response = await upload(world.sessionId, "art_1", { token, sha256 });
      expect(response.status).toBe(201);
      expect(await eventsOfType(world.stub, "artifact.created")).toHaveLength(1);
      expect(
        await env.DB.prepare("SELECT artifact_id FROM artifact_index WHERE session_id = ?")
          .bind(world.sessionId)
          .first(),
      ).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_index").run();
    }
  });
});

describe("GET /api/sessions/:id/artifacts/:artifactId", () => {
  async function ownerWorld(subject: string, sessionId: string) {
    const workspaceId = await deriveWorkspaceId(subject);
    const u = await uploading(sessionId, { workspaceId });
    const response = await upload(sessionId, "art_1", { token: u.token, sha256: u.sha256 });
    expect(response.status).toBe(201);
    const double = await createClerkDouble();
    const ownerEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });
    const download = async (as: string, overrides: Record<string, unknown> = {}) =>
      handleDownloadArtifact(
        await double.requestAs(as, artifactUrl(sessionId, "art_1")),
        envWith({ ...ownerEnv, ...overrides }),
        pathFor(sessionId, "art_1"),
        createAllowlistCache(),
      );
    return { ...u, double, ownerEnv, download };
  }

  it("streams the owner's artifact as an opaque attachment, and nobody else's", async () => {
    const subject = "artifact_owner";
    const { key, download, ownerEnv } = await ownerWorld(subject, "sess_download_ok");

    const response = await download(subject);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
      "content-length": String(BYTES.length),
      "content-disposition": 'attachment; filename="log-art_1.txt"',
    });
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("line 1\nline 2\n");

    const unauthenticated = await handleDownloadArtifact(
      new Request(artifactUrl("sess_download_ok", "art_1")),
      ownerEnv,
      pathFor("sess_download_ok", "art_1"),
      createAllowlistCache(),
    );
    expect(unauthenticated.status).toBe(401);
    const stranger = await download("artifact_stranger", {
      ONCUE_USER_ALLOWLIST: "artifact_stranger",
    });
    expect(stranger.status).toBe(403);
    expect(await bucket.get(key)).not.toBeNull();
  });

  it("answers 404 for an artifact that was never created and for one whose object is gone", async () => {
    const subject = "artifact_owner_gone";
    const { key, download, double, ownerEnv } = await ownerWorld(subject, "sess_download_gone");

    const missing = await handleDownloadArtifact(
      await double.requestAs(subject, artifactUrl("sess_download_gone", "art_none")),
      ownerEnv,
      pathFor("sess_download_gone", "art_none"),
      createAllowlistCache(),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "artifact_unavailable" });

    await bucket.delete(key);
    const gone = await download(subject);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "artifact_unavailable" });
  });

  it("answers 503 without the storage binding, after authorization", async () => {
    const subject = "artifact_owner_nobucket";
    const { download } = await ownerWorld(subject, "sess_download_nobucket");
    const response = await download(subject, { ARTIFACTS: undefined });
    expect(response.status).toBe(503);
    expect(
      await download("artifact_stranger_2", {
        ARTIFACTS: undefined,
        ONCUE_USER_ALLOWLIST: "artifact_stranger_2",
      }),
    ).toMatchObject({ status: 403 });
  });
});

describe("GET /api/sessions/:id/artifacts/:artifactId/restore", () => {
  async function created(sessionId: string) {
    const u = await uploading(sessionId);
    expect((await upload(sessionId, "art_1", { token: u.token, sha256: u.sha256 })).status).toBe(
      201,
    );
    return u;
  }

  const restore = (
    sessionId: string,
    token: string | null,
    overrides: Record<string, unknown> = {},
  ) =>
    handleRestoreArtifact(
      new Request(artifactUrl(sessionId, "art_1", true), {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
      envWith(overrides),
      pathFor(sessionId, "art_1", true),
    );

  it("hands the bundle to its one-time bearer exactly once", async () => {
    const { world } = await created("sess_restore_ok");
    const token = await seedRestoreToken(world, "art_1");

    const response = await restore(world.sessionId, token);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("line 1\nline 2\n");

    expect((await restore(world.sessionId, token)).status).toBe(403);
    expect((await restore(world.sessionId, null)).status).toBe(403);
    expect((await restore(world.sessionId, "not-a-token")).status).toBe(403);
  });

  it("refuses a bearer for a session nobody created, and wakes no object to check it", async () => {
    const sessionId = "sess_restore_never_created";
    const response = await restore(sessionId, "any-bearer");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await objectExists(sessionId)).toBe(false);
  });

  it("answers 503 without the storage binding and 404 when the object is gone", async () => {
    const { world, key } = await created("sess_restore_gone");
    const token = await seedRestoreToken(world, "art_1");

    expect((await restore(world.sessionId, token, { ARTIFACTS: undefined })).status).toBe(503);
    await bucket.delete(key);
    const gone = await restore(world.sessionId, token);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "artifact_unavailable" });
  });
});
