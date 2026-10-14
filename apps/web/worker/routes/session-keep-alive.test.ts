import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { createBody, eventTypes, seedSessionIndex, stubFor, waitFor } from "../test/session-world";
import { extractKeepAliveSessionId, handleKeepAlive } from "./session-keep-alive";

const url = (sessionId: string) =>
  `https://oncue.example/api/sessions/${sessionId}/sandbox/keep-alive`;

function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

/** A session on the fake driver, whose attachment is live the moment it is created. */
async function fakeSession(sessionId: string, workspaceId: string): Promise<void> {
  await seedSessionIndex(sessionId, workspaceId);
  const stub = stubFor(sessionId);
  await runInDurableObject(stub, async (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, {
      ONCUE_SANDBOX_CONTROLLER_ORIGIN: "",
      ONCUE_SANDBOX_CONTROLLER_TOKEN: "",
    });
    await instance.createSession(createBody(sessionId, { workspaceId, modalCredential: null }));
  });
  await waitFor(async () => (await eventTypes(stub)).includes("sandbox.attached"), "attachment");
}

describe("extractKeepAliveSessionId", () => {
  it("extracts the session id from the keep-alive path and nothing else", () => {
    expect(extractKeepAliveSessionId("/api/sessions/sess_1/sandbox/keep-alive")).toBe("sess_1");
    expect(extractKeepAliveSessionId("/api/sessions/sess_1/sandbox/stop")).toBeNull();
    expect(extractKeepAliveSessionId("/api/sessions//sandbox/keep-alive")).toBeNull();
  });
});

describe("handleKeepAlive", () => {
  it("denies an unauthenticated request before reaching the object", async () => {
    const response = await handleKeepAlive(
      new Request(url("sess_ka_anon"), { method: "POST" }),
      env,
      "sess_ka_anon",
      createAllowlistCache(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("denies a session owned by someone else, reading the same as a missing one", async () => {
    await seedSessionIndex("sess_ka_victim", await deriveWorkspaceId("ka_victim"));
    const double = await createClerkDouble();
    const owned = await handleKeepAlive(
      await double.requestAs("ka_attacker", url("sess_ka_victim"), { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "ka_attacker" }),
      "sess_ka_victim",
      createAllowlistCache(),
    );
    expect(owned.status).toBe(403);
    const missing = await handleKeepAlive(
      await double.requestAs("ka_attacker", url("sess_ka_nobody"), { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "ka_attacker" }),
      "sess_ka_nobody",
      createAllowlistCache(),
    );
    expect(missing.status).toBe(403);
  });

  it("answers 200 with the expiry the object recorded for the owner's live sandbox", async () => {
    const subject = "ka_owner";
    await fakeSession("sess_ka_live", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const before = Date.now();

    const response = await handleKeepAlive(
      await double.requestAs(subject, url("sess_ka_live"), { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_ka_live",
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { expiresAt: string };
    expect(Date.parse(body.expiresAt) - before).toBeGreaterThanOrEqual(60 * 60_000);
    expect(await eventTypes(stubFor("sess_ka_live"))).toContain("sandbox.keepalive.updated");
  });

  it("answers 502 when the object cannot be reached or answers with an error, as the stop does", async () => {
    const subject = "ka_owner_object_down";
    await seedSessionIndex("sess_ka_down", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();
    const withObject = (answer: () => Promise<Response>): Env =>
      ({
        ...env,
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: subject,
        SESSION: {
          idFromName: (name: string) => env.SESSION.idFromName(name),
          get: () => ({ fetch: answer }),
        },
      }) as unknown as Env;

    const unreachable = await handleKeepAlive(
      await double.requestAs(subject, url("sess_ka_down"), { method: "POST" }),
      withObject(async () => {
        throw new Error("object unreachable");
      }),
      "sess_ka_down",
      createAllowlistCache(),
    );
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toEqual({ error: "failed to reach the session object" });

    const refused = await handleKeepAlive(
      await double.requestAs(subject, url("sess_ka_down"), { method: "POST" }),
      withObject(async () => new Response("no", { status: 500 })),
      "sess_ka_down",
      createAllowlistCache(),
    );
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "the session object rejected the keep-alive" });
  });

  it("answers 409 when the object has no sandbox to keep", async () => {
    const subject = "ka_owner_idle";
    await seedSessionIndex("sess_ka_none", await deriveWorkspaceId(subject));
    const double = await createClerkDouble();

    const response = await handleKeepAlive(
      await double.requestAs(subject, url("sess_ka_none"), { method: "POST" }),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      "sess_ka_none",
      createAllowlistCache(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_running" });
  });
});
