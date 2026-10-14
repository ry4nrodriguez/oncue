import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import {
  finishRun,
  readyBridge,
  registerSessionWorlds,
  sessionOnRealDriver,
} from "../test/session-world";
import {
  type ArchiveCaller,
  handleArchiveSession,
  matchArchiveRoute,
  realArchiveCaller,
} from "./session-archive";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const SESSION = "sess_archive_route";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?").bind(SESSION).run();
});

async function insertSession(workspaceId: string, state = "active"): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(SESSION, workspaceId, state, now, now)
    .run();
}

async function indexState(sessionId = SESSION): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
    .bind(sessionId)
    .first<{ state: string }>();
  return row?.state ?? null;
}

function recordingCaller(answer: () => Promise<Response>): ArchiveCaller & {
  readonly calls: Array<{ path: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    async call(_sessionId, path, body) {
      calls.push({ path, body });
      return answer();
    },
  };
}

async function post(
  subject: string,
  action: "archive" | "unarchive",
  caller: ArchiveCaller,
  body?: unknown,
  sessionId = SESSION,
) {
  const double = await createClerkDouble();
  const url = `https://oncue.example/api/sessions/${sessionId}/${action}`;
  const request = await double.requestAs(subject, url, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleArchiveSession(
    request,
    { ...env, CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject } as unknown as Env,
    matchArchiveRoute(new URL(url).pathname, "POST") as NonNullable<
      ReturnType<typeof matchArchiveRoute>
    >,
    caller,
    createAllowlistCache(),
  );
}

describe("matchArchiveRoute", () => {
  it("matches both actions by POST only", () => {
    expect(matchArchiveRoute("/api/sessions/s1/archive", "POST")).toEqual({
      sessionId: "s1",
      archived: true,
    });
    expect(matchArchiveRoute("/api/sessions/s1/unarchive", "POST")).toEqual({
      sessionId: "s1",
      archived: false,
    });
    expect(matchArchiveRoute("/api/sessions/s1/archive", "GET")).toBeNull();
    expect(matchArchiveRoute("/api/sessions/s1/rename", "POST")).toBeNull();
    expect(matchArchiveRoute("/api/sessions/s1", "POST")).toBeNull();
  });
});

describe("handleArchiveSession", () => {
  const archived = async () => Response.json({ kind: "archived", sandbox: "stopped" });

  it("denies an unauthenticated request", async () => {
    const caller = recordingCaller(archived);
    const response = await handleArchiveSession(
      new Request(`https://oncue.example/api/sessions/${SESSION}/archive`, { method: "POST" }),
      env,
      { sessionId: SESSION, archived: true },
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
    expect(caller.calls).toEqual([]);
  });

  it("denies someone else's session and one being deleted, telling no object", async () => {
    await insertSession(await deriveWorkspaceId("victim_archive"));
    const caller = recordingCaller(archived);
    expect((await post("attacker_archive", "archive", caller)).status).toBe(403);

    await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?").bind(SESSION).run();
    await insertSession(await deriveWorkspaceId("owner_deleting_archive"), "deletion_pending");
    expect((await post("owner_deleting_archive", "archive", caller)).status).toBe(403);
    expect(caller.calls).toEqual([]);
  });

  it("asks the object first, then marks the row archived", async () => {
    const subject = "owner_archives";
    await insertSession(await deriveWorkspaceId(subject));
    const caller = recordingCaller(async () => {
      expect(await indexState()).toBe("active");
      return archived();
    });

    const response = await post(subject, "archive", caller);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: SESSION, state: "archived" });
    expect(caller.calls).toEqual([
      {
        path: "archive",
        body: {
          requestedByUserId: await deriveUserId(subject),
          cancelOpenRun: false,
          modalCredential: null,
        },
      },
    ]);
    expect(await indexState()).toBe("archived");
  });

  it("passes the user's confirmation that an open run may be cancelled", async () => {
    const subject = "owner_confirms";
    await insertSession(await deriveWorkspaceId(subject));
    const caller = recordingCaller(archived);

    await post(subject, "archive", caller, { cancelOpenRun: true });
    await post(subject, "archive", caller, "not an object");
    await post(subject, "archive", caller, { cancelOpenRun: "yes" });

    expect(caller.calls.map((call) => call.body.cancelOpenRun)).toEqual([true, false, false]);
  });

  it("omits the Modal pair when the route cannot open one", async () => {
    const subject = "owner_no_modal_archive";
    await insertSession(await deriveWorkspaceId(subject));
    const caller = recordingCaller(archived);
    const double = await createClerkDouble();
    const url = `https://oncue.example/api/sessions/${SESSION}/archive`;
    await handleArchiveSession(
      await double.requestAs(subject, url, { method: "POST" }),
      {
        ...env,
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://controller.example",
        ONCUE_SANDBOX_CONTROLLER_TOKEN: "token",
      } as unknown as Env,
      { sessionId: SESSION, archived: true },
      caller,
      createAllowlistCache(),
    );
    expect(caller.calls[0]?.body).toEqual({
      requestedByUserId: await deriveUserId(subject),
      cancelOpenRun: false,
    });
  });

  it("answers 409 run_open and changes nothing when a run is open and unconfirmed", async () => {
    const subject = "owner_run_open";
    await insertSession(await deriveWorkspaceId(subject));
    const response = await post(
      subject,
      "archive",
      recordingCaller(async () => Response.json({ kind: "run_open" })),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "run_open" });
    expect(await indexState()).toBe("active");
  });

  it("answers 403 when the object is deleting or holds no session", async () => {
    const subject = "owner_object_gone";
    await insertSession(await deriveWorkspaceId(subject));
    for (const kind of ["deleting", "no_session"]) {
      const response = await post(
        subject,
        "archive",
        recordingCaller(async () => Response.json({ kind })),
      );
      expect(response.status).toBe(403);
    }
    expect(await indexState()).toBe("active");
  });

  it("answers 502 when the object cannot be reached or refuses", async () => {
    const subject = "owner_object_down_archive";
    await insertSession(await deriveWorkspaceId(subject));
    const thrown = await post(
      subject,
      "archive",
      recordingCaller(async () => {
        throw new Error("network");
      }),
    );
    expect(thrown.status).toBe(502);
    const refused = await post(
      subject,
      "archive",
      recordingCaller(async () => new Response("no", { status: 500 })),
    );
    expect(refused.status).toBe(502);
    expect(await indexState()).toBe("active");
  });

  it("restores an archived row to active", async () => {
    const subject = "owner_restores";
    await insertSession(await deriveWorkspaceId(subject), "archived");
    const caller = recordingCaller(async () => Response.json({ kind: "active" }));

    const response = await post(subject, "unarchive", caller);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: SESSION, state: "active" });
    expect(caller.calls).toEqual([{ path: "unarchive", body: {} }]);
    expect(await indexState()).toBe("active");
  });

  it("archives a row still creating once the object agrees, so a projection owed cannot write an older state", async () => {
    const subject = "owner_archives_creating";
    await insertSession(await deriveWorkspaceId(subject), "creating");

    const response = await post(subject, "archive", recordingCaller(archived));

    expect(response.status).toBe(200);
    expect(await indexState()).toBe("archived");
    // The projection's own statement: it moves the state only out of `creating`.
    await env.DB.prepare(
      "UPDATE session_index SET state = CASE WHEN state = 'creating' THEN 'active' ELSE state END WHERE session_id = ?",
    )
      .bind(SESSION)
      .run();
    expect(await indexState()).toBe("archived");
  });

  it("leaves a row being deleted alone even when the object answered before the delete", async () => {
    const subject = "owner_archives_deleting";
    await insertSession(await deriveWorkspaceId(subject), "active");
    const caller = recordingCaller(async () => {
      // The delete's mark lands while the object is answering.
      await env.DB.prepare(
        "UPDATE session_index SET state = 'deletion_pending' WHERE session_id = ?",
      )
        .bind(SESSION)
        .run();
      return archived();
    });

    await post(subject, "archive", caller);

    expect(await indexState()).toBe("deletion_pending");
  });

  it("archives and restores a real session through the object", async () => {
    const subject = "owner_real_archive";
    const workspaceId = await deriveWorkspaceId(subject);
    const sessionId = "sess_archive_route_real";
    const world = await sessionOnRealDriver(sessionId, { workspaceId });
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    await finishRun(world, bridge);

    const archivedResponse = await post(
      subject,
      "archive",
      realArchiveCaller(env),
      undefined,
      sessionId,
    );
    expect(archivedResponse.status).toBe(200);
    expect(await indexState(sessionId)).toBe("archived");

    const restored = await post(subject, "unarchive", realArchiveCaller(env), undefined, sessionId);
    expect(restored.status).toBe(200);
    expect(await indexState(sessionId)).toBe("active");
  });
});
