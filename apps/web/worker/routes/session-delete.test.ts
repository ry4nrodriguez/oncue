import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import {
  type DeleteSessionDeps,
  extractDeleteSessionId,
  handleDeleteSession,
} from "./session-delete";

const url = "https://oncue.example/api/sessions/sess_delete";

function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM deletion_request").run();
  await env.DB.prepare("DELETE FROM session_index").run();
});

async function insertSession(sessionId: string, workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(sessionId, workspaceId, now, now)
    .run();
}

interface RecordingDeps extends DeleteSessionDeps {
  readonly calls: Array<{ sessionId: string; body: Record<string, unknown> }>;
  readonly started: string[];
}

function recordingDeps(
  answer: () => Promise<Response> = async () => Response.json({}),
): RecordingDeps {
  const calls: RecordingDeps["calls"] = [];
  const started: string[] = [];
  return {
    calls,
    started,
    async callDelete(sessionId, body) {
      calls.push({ sessionId, body });
      return answer();
    },
    startDeletion(requestId) {
      started.push(requestId);
    },
  };
}

async function stateOf(sessionId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM session_index WHERE session_id = ?")
    .bind(sessionId)
    .first<{ state: string }>();
  return row?.state ?? null;
}

async function requestsFor(sessionId: string) {
  return (
    await env.DB.prepare(
      "SELECT id, workspace_id, requested_by_user_id, completed_at FROM deletion_request WHERE session_id = ?",
    )
      .bind(sessionId)
      .all<{ id: string; workspace_id: string; requested_by_user_id: string; completed_at: null }>()
  ).results;
}

async function deleteAs(subject: string, deps: DeleteSessionDeps, overrides = {}) {
  const double = await createClerkDouble();
  return handleDeleteSession(
    await double.requestAs(subject, url),
    envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject, ...overrides }),
    "sess_delete",
    deps,
    createAllowlistCache(),
  );
}

describe("extractDeleteSessionId", () => {
  it("extracts the session id from a well-formed delete path", () => {
    expect(extractDeleteSessionId("/api/sessions/sess_1")).toBe("sess_1");
  });

  it("returns null for any other path shape", () => {
    expect(extractDeleteSessionId("/api/sessions/sess_1/client")).toBeNull();
    expect(extractDeleteSessionId("/api/sessions")).toBeNull();
    expect(extractDeleteSessionId("/api/health")).toBeNull();
  });
});

describe("handleDeleteSession", () => {
  it("denies an unauthenticated request and tells no object", async () => {
    const deps = recordingDeps();
    const response = await handleDeleteSession(
      new Request(url, { method: "DELETE" }),
      env,
      "sess_delete",
      deps,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
    expect(deps.calls).toEqual([]);
  });

  it("denies deleting a session owned by someone else, and changes nothing", async () => {
    await insertSession("sess_delete", await deriveWorkspaceId("victim"));
    const deps = recordingDeps();

    const response = await deleteAs("attacker", deps);

    expect(response.status).toBe(403);
    expect(deps.calls).toEqual([]);
    expect(deps.started).toEqual([]);
    expect(await stateOf("sess_delete")).toBe("active");
    expect(await requestsFor("sess_delete")).toEqual([]);
  });

  it("marks the row and records one request first, then tells the object and starts the job", async () => {
    const subject = "owner_deletes_own";
    const workspaceId = await deriveWorkspaceId(subject);
    await insertSession("sess_delete", workspaceId);
    const deps = recordingDeps(async () => {
      // The deletion is durable before the object hears of it.
      expect(await stateOf("sess_delete")).toBe("deletion_pending");
      expect(await requestsFor("sess_delete")).toHaveLength(1);
      return Response.json({ kind: "deleting", sandbox: "stopped" });
    });

    const response = await deleteAs(subject, deps);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sessionId: "sess_delete", state: "deletion_pending" });
    expect(deps.calls).toEqual([
      {
        sessionId: "sess_delete",
        // No controller here, so the fake driver needs no Modal pair.
        body: { requestedByUserId: await deriveUserId(subject), modalCredential: null },
      },
    ]);
    expect(await stateOf("sess_delete")).toBe("deletion_pending");
    const requests = await requestsFor("sess_delete");
    expect(requests).toEqual([
      {
        id: expect.any(String),
        workspace_id: workspaceId,
        requested_by_user_id: await deriveUserId(subject),
        completed_at: null,
      },
    ]);
    expect(deps.started).toEqual([requests[0]?.id]);
  });

  it("answers a repeated delete the same way without recording a second request", async () => {
    const subject = "owner_deletes_twice";
    await insertSession("sess_delete", await deriveWorkspaceId(subject));
    const deps = recordingDeps();

    expect((await deleteAs(subject, deps)).status).toBe(202);
    const second = await deleteAs(subject, deps);

    expect(second.status).toBe(202);
    const requests = await requestsFor("sess_delete");
    expect(requests).toHaveLength(1);
    // The object is told again (its stop may have been waiting); the job is the same one.
    expect(deps.calls).toHaveLength(2);
    expect(deps.started).toEqual([requests[0]?.id, requests[0]?.id]);
  });

  it("leaves the Modal pair to the object when the route cannot open one", async () => {
    const subject = "owner_without_modal";
    await insertSession("sess_delete", await deriveWorkspaceId(subject));
    const deps = recordingDeps();

    const response = await deleteAs(subject, deps, {
      ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://controller.example",
      ONCUE_SANDBOX_CONTROLLER_TOKEN: "token",
    });

    expect(response.status).toBe(202);
    expect(deps.calls[0]?.body).toEqual({ requestedByUserId: await deriveUserId(subject) });
  });

  for (const [what, answer] of [
    [
      "cannot be reached",
      async () => {
        throw new Error("network");
      },
    ],
    ["refuses", async () => new Response("no", { status: 500 })],
  ] as const) {
    it(`still hides the session and leaves the job owed when the object ${what}`, async () => {
      const subject = `owner_object_${what.replaceAll(" ", "_")}`;
      await insertSession("sess_delete", await deriveWorkspaceId(subject));
      const deps = recordingDeps(answer);

      const response = await deleteAs(subject, deps);

      // The job's first step tells the object again, so nothing is stranded.
      expect(response.status).toBe(202);
      expect(await stateOf("sess_delete")).toBe("deletion_pending");
      const requests = await requestsFor("sess_delete");
      expect(requests).toHaveLength(1);
      expect(deps.started).toEqual([requests[0]?.id]);
    });
  }
});
