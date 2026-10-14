import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { handleCreateSession, realObjectCaller } from "./sessions";
import { extractClientSessionId, handleWebSocketUpgrade } from "./ws";

const createUrl = "https://worker/api/sessions";

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_ENV?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function createSessionAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
): Promise<string> {
  const authed = await double.requestAs(subject, createUrl);
  const request = new Request(createUrl, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authed.headers.get("cookie") ?? "" },
    body: JSON.stringify({
      commandId: `cmd_${subject}`,
      instruction: { messageId: "msg_1", text: "Fix it", attachments: [] },
    }),
  });
  const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });
  const response = await handleCreateSession(
    request,
    testEnv,
    realObjectCaller(testEnv),
    createAllowlistCache(),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

interface CloseResult {
  readonly code: number;
  readonly reason: string;
  readonly messages: readonly string[];
}

async function driveClientSocket(response: Response): Promise<CloseResult> {
  expect(response.status).toBe(101);
  const client = response.webSocket;
  if (client === null || client === undefined) {
    throw new Error("expected a webSocket on the upgrade response");
  }
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    client.addEventListener("message", (event: MessageEvent) => {
      messages.push(String(event.data));
    });
    client.addEventListener("close", (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason });
    });
    client.accept();
  });
  const result = await closed;
  return { ...result, messages };
}

describe("extractClientSessionId", () => {
  it("extracts the session id from a well-formed client path", () => {
    expect(extractClientSessionId("/ws/sessions/sess_1/client")).toBe("sess_1");
  });

  it("returns null for any other path shape", () => {
    expect(extractClientSessionId("/ws/sessions/sess_1/bridge")).toBeNull();
    expect(extractClientSessionId("/ws/sessions/client")).toBeNull();
    expect(extractClientSessionId("/api/health")).toBeNull();
  });
});

describe("handleWebSocketUpgrade", () => {
  it("returns 404 for a path with no session id", async () => {
    const response = await handleWebSocketUpgrade(
      new Request("https://worker/ws/not-a-session-path"),
      env,
      createAllowlistCache(),
    );
    expect(response.status).toBe(404);
  });

  // A socket opened with no cookie and no token must not disclose a session's
  // history.
  it("refuses an upgrade with no credential at all, and discloses nothing (the reproduced attack)", async () => {
    const double = await createClerkDouble();
    const sessionId = await createSessionAs(double, "victim_no_cred");

    const response = await handleWebSocketUpgrade(
      new Request(`https://worker/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket" },
      }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "victim_no_cred" }),
      createAllowlistCache(),
    );

    const result = await driveClientSocket(response);
    expect(result.code).toBe(4401);
    expect(result.messages).toEqual([]);
  });

  // A browser cannot attach an Authorization header to a same-origin upgrade,
  // so its presence alone means the caller is not a sanctioned browser.
  it("refuses an upgrade carrying an Authorization header, even with no cookie", async () => {
    const double = await createClerkDouble();
    const sessionId = await createSessionAs(double, "victim_auth_header");

    const response = await handleWebSocketUpgrade(
      new Request(`https://worker/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", Authorization: "Bearer forged" },
      }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "victim_auth_header" }),
      createAllowlistCache(),
    );

    const result = await driveClientSocket(response);
    expect(result.code).toBe(4401);
    expect(result.messages).toEqual([]);
  });

  // A valid cookie for one user must not open another user's session.
  it("refuses user A's valid cookie on user B's session, and discloses nothing", async () => {
    const double = await createClerkDouble();
    const sessionId = await createSessionAs(double, "victim_owner");
    const attackerRequest = await double.requestAs("attacker", "https://worker/ws");

    const testEnv = envWith({
      CLERK_JWT_KEY: double.jwtKey,
      ONCUE_USER_ALLOWLIST: "victim_owner,attacker",
    });
    const response = await handleWebSocketUpgrade(
      new Request(`https://worker/ws/sessions/${sessionId}/client?after=0`, {
        headers: {
          Upgrade: "websocket",
          cookie: attackerRequest.headers.get("cookie") ?? "",
        },
      }),
      testEnv,
      createAllowlistCache(),
    );

    const result = await driveClientSocket(response);
    expect(result.code).toBe(4403);
    expect(result.reason).toBe("forbidden");
    expect(result.messages).toEqual([]);
  });

  it("refuses an upgrade for a session that does not exist, with the same code as 'not yours'", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("no_such_session_user", "https://worker/ws");

    const response = await handleWebSocketUpgrade(
      new Request("https://worker/ws/sessions/sess_does_not_exist/client?after=0", {
        headers: { Upgrade: "websocket", cookie: request.headers.get("cookie") ?? "" },
      }),
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: "no_such_session_user",
      }),
      createAllowlistCache(),
    );

    const result = await driveClientSocket(response);
    expect(result.code).toBe(4403);
    // Byte-identical to the "not yours" refusal above. A distinct reason string
    // would hand back the existence answer the shared code withholds.
    expect(result.reason).toBe("forbidden");
    expect(result.messages).toEqual([]);
  });

  it("forwards a well-formed, authorized upgrade to the owner's own session", async () => {
    const double = await createClerkDouble();
    const sessionId = await createSessionAs(double, "owner_success");
    const ownerRequest = await double.requestAs("owner_success", "https://worker/ws");

    const response = await handleWebSocketUpgrade(
      new Request(`https://worker/ws/sessions/${sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", cookie: ownerRequest.headers.get("cookie") ?? "" },
      }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "owner_success" }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(101);
  });

  // A client-supplied x-oncue-user-id must never reach the object. Proven end to
  // end: a command sent over the socket is stamped with the verified owner's
  // id, not the forged header's.
  it("cannot impersonate anyone with a client-supplied x-oncue-user-id header", async () => {
    const double = await createClerkDouble();
    const subject = "owner_cannot_be_forged";
    const sessionId = await createSessionAs(double, subject);
    const ownerRequest = await double.requestAs(subject, "https://worker/ws");
    const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject });

    const response = await handleWebSocketUpgrade(
      new Request(`https://worker/ws/sessions/${sessionId}/client?after=0`, {
        headers: {
          Upgrade: "websocket",
          cookie: ownerRequest.headers.get("cookie") ?? "",
          "x-oncue-user-id": "forged_identity",
        },
      }),
      testEnv,
      createAllowlistCache(),
    );
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null || client === undefined) {
      throw new Error("expected a webSocket on the upgrade response");
    }
    client.accept();
    client.send(
      JSON.stringify({
        type: "command",
        command: {
          type: "checkpoint.create",
          commandId: "cmd_forged_header_check",
          runId: null,
          issuedAt: new Date().toISOString(),
          expected: { scope: "session", state: "active" },
          payload: { reason: "user_requested" },
        },
      }),
    );

    const stub = testEnv.SESSION.get(testEnv.SESSION.idFromName(sessionId));
    const expectedUserId = await deriveUserId(subject);
    let row: { issued_by_user_id: string } | undefined;
    for (let attempt = 0; attempt < 200 && row === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const rows = await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ issued_by_user_id: string }>(
          "SELECT issued_by_user_id FROM command WHERE id = 'cmd_forged_header_check'",
        ),
      ]);
      row = rows[0];
    }
    expect(row).toEqual({ issued_by_user_id: expectedUserId });
  });
});
