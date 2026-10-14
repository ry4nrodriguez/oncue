import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import {
  extractStopSessionId,
  handleStopSandbox,
  realStopCaller,
  type StopCaller,
} from "./session-stop";

const url = "https://oncue.example/api/sessions/sess_stop/sandbox/stop";

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_ENV?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

beforeEach(async () => {
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

/** Answers what the object would, and records what the Worker handed it. */
function scriptedCaller(answer: () => Response | Promise<Response>): {
  caller: StopCaller;
  calls: { sessionId: string; body: Record<string, unknown> }[];
} {
  const calls: { sessionId: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    caller: {
      async callStop(sessionId, body) {
        calls.push({ sessionId, body });
        return answer();
      },
    },
  };
}

describe("extractStopSessionId", () => {
  it("extracts the session id from the stop path and nothing else", () => {
    expect(extractStopSessionId("/api/sessions/sess_1/sandbox/stop")).toBe("sess_1");
    expect(extractStopSessionId("/api/sessions/sess_1")).toBeNull();
    expect(extractStopSessionId("/api/sessions/sess_1/sandbox")).toBeNull();
    expect(extractStopSessionId("/api/sessions//sandbox/stop")).toBeNull();
  });
});

describe("handleStopSandbox", () => {
  it("denies an unauthenticated request before reaching the object", async () => {
    const { caller, calls } = scriptedCaller(() =>
      Response.json({ kind: "stopped", generation: 1 }),
    );
    const response = await handleStopSandbox(
      new Request(url, { method: "POST" }),
      env,
      "sess_stop",
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("denies stopping a session owned by someone else, reading the same as a missing one", async () => {
    await insertSession("sess_stop", await deriveWorkspaceId("victim"));
    const double = await createClerkDouble();
    const { caller, calls } = scriptedCaller(() =>
      Response.json({ kind: "stopped", generation: 1 }),
    );

    const response = await handleStopSandbox(
      await double.requestAs("attacker", url, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "attacker" }),
      "sess_stop",
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("hands the object the verified user and the workspace's credential, and reports the generation stopped", async () => {
    const subject = "owner_stops";
    await insertSession("sess_stop", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const { caller, calls } = scriptedCaller(() =>
      Response.json({ kind: "stopped", generation: 2 }),
    );

    const response = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_stop",
      caller,
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: "sess_stop", generation: 2 });
    expect(calls).toHaveLength(1);
    // No controller is configured in the unit environment, so the credential
    // is null and the object runs the fake, exactly as create does.
    expect(calls[0]?.body).toMatchObject({ modalCredential: null });
    expect(typeof calls[0]?.body.requestedByUserId).toBe("string");
  });

  it("answers 202 with the generation when the stop is under way but has not ended the sandbox", async () => {
    const subject = "owner_stop_pending";
    await insertSession("sess_stop", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const { caller } = scriptedCaller(() => Response.json({ kind: "stopping", generation: 3 }));

    const response = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_stop",
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sessionId: "sess_stop", generation: 3 });
  });

  it("answers 409 when the object says nothing is running", async () => {
    const subject = "owner_nothing_running";
    await insertSession("sess_stop", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const { caller } = scriptedCaller(() => Response.json({ kind: "not_running" }));

    const response = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_stop",
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_running" });
  });

  it("answers 502 with the driver's category when the provider would not stop it", async () => {
    const subject = "owner_stop_failed";
    await insertSession("sess_stop", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const { caller } = scriptedCaller(() =>
      Response.json({ kind: "failed", category: "unknown", message: "Modal did not answer." }),
    );

    const response = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_stop",
      caller,
      createAllowlistCache(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "stop_failed",
      category: "unknown",
      message: "Modal did not answer.",
    });
  });

  it("answers 502 when the object cannot be reached or rejects the call", async () => {
    const subject = "owner_object_down";
    await insertSession("sess_stop", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const settings = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });

    const thrown = scriptedCaller(() => {
      throw new Error("object unreachable");
    });
    const unreachable = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      settings,
      "sess_stop",
      thrown.caller,
      createAllowlistCache(),
    );
    expect(unreachable.status).toBe(502);

    const rejected = scriptedCaller(() => new Response("no", { status: 500 }));
    const refused = await handleStopSandbox(
      await double.requestAs(subject, url, { method: "POST" }),
      settings,
      "sess_stop",
      rejected.caller,
      createAllowlistCache(),
    );
    expect(refused.status).toBe(502);
  });

  it("realStopCaller posts to the object's internal stop path", async () => {
    const subject = "owner_real_caller";
    await insertSession("sess_stop_real", await deriveWorkspaceId(subject));
    // A fresh object with no session row answers not_running, which proves
    // the call reached the object rather than proving a stop.
    const response = await realStopCaller(env).callStop("sess_stop_real", {
      requestedByUserId: "user_1",
      modalCredential: null,
    });
    expect(await response.json()).toEqual({ kind: "not_running" });
  });
});
