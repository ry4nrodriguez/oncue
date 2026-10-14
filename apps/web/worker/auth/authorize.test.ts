import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClerkDouble } from "../test/clerk-double";
import { actorUserId, actorWorkspaceId } from "./actor";
import { createAllowlistCache } from "./allowlist";
import {
  AUTHORIZE_DENIAL_HTTP_STATUS,
  AUTHORIZE_DENIAL_WS_CLOSE_CODE,
  type AuthorizeDenialReason,
  authorizeSessionRequest,
} from "./authorize";
import { deriveUserId, deriveWorkspaceId } from "./register";

const url = "https://oncue.example/ws/sessions/sess_1/client";

function envWith(overrides: { CLERK_JWT_KEY: string; ONCUE_USER_ALLOWLIST: string }): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function insertSession(
  sessionId: string,
  workspaceId: string,
  state = "active",
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, workspaceId, state, now, now)
    .run();
}

describe("authorizeSessionRequest", () => {
  // Step 1: validate the Clerk session.
  it("denies an unauthenticated request", async () => {
    const request = new Request(url);

    const result = await authorizeSessionRequest(
      env,
      request,
      "sess_unauth",
      createAllowlistCache(),
    );

    expect(result).toEqual({ kind: "denied", reason: "unauthenticated" });
  });

  // The allowlist gates registration.
  it("denies a verified subject that is not on the allowlist", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_not_allowed", url);

    const result = await authorizeSessionRequest(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "user_someone_else" }),
      request,
      "sess_blocked",
      createAllowlistCache(),
    );

    expect(result).toEqual({ kind: "denied", reason: "not_allowlisted" });
  });

  // Step 3: resolve the resource to its workspace; no row at all.
  it("denies access to a session that does not exist", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_no_session", url);

    const result = await authorizeSessionRequest(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "user_no_session" }),
      request,
      "sess_missing",
      createAllowlistCache(),
    );

    expect(result).toEqual({ kind: "denied", reason: "resource_not_found" });
  });

  // Step 4: confirm the actor owns the resolved workspace.
  it("denies cross-workspace access to a session owned by someone else", async () => {
    const victimWorkspaceId = await deriveWorkspaceId("victim_subject");
    await insertSession("sess_cross", victimWorkspaceId);
    const double = await createClerkDouble();
    const request = await double.requestAs("attacker_subject", url);

    const result = await authorizeSessionRequest(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "attacker_subject" }),
      request,
      "sess_cross",
      createAllowlistCache(),
    );

    expect(result).toEqual({ kind: "denied", reason: "not_owner" });
  });

  it("authorizes an allowlisted owner for their own session", async () => {
    const subject = "owner_subject";
    const workspaceId = await deriveWorkspaceId(subject);
    await insertSession("sess_owned", workspaceId);
    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);

    const result = await authorizeSessionRequest(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      request,
      "sess_owned",
      createAllowlistCache(),
    );

    expect(result.kind).toBe("authorized");
    if (result.kind === "authorized") {
      expect(actorWorkspaceId(result.actor)).toBe(workspaceId);
      expect(actorUserId(result.actor)).toBe(await deriveUserId(subject));
    }
  });
});

describe("authorizeSessionRequest: a session being deleted", () => {
  async function ask(
    subject: string,
    sessionId: string,
    options?: { readonly allowDeletionPending?: boolean },
  ) {
    const double = await createClerkDouble();
    return authorizeSessionRequest(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      await double.requestAs(subject, url),
      sessionId,
      createAllowlistCache(),
      options,
    );
  }

  it("reads as missing to its owner on every route but the delete", async () => {
    const subject = "owner_deleting";
    await insertSession("sess_deleting", await deriveWorkspaceId(subject), "deletion_pending");

    expect(await ask(subject, "sess_deleting")).toEqual({
      kind: "denied",
      reason: "resource_not_found",
    });
    expect(await ask(subject, "sess_deleting", { allowDeletionPending: false })).toEqual({
      kind: "denied",
      reason: "resource_not_found",
    });
    expect((await ask(subject, "sess_deleting", { allowDeletionPending: true })).kind).toBe(
      "authorized",
    );
  });

  it("is still someone else's to anyone else, even to the delete route", async () => {
    await insertSession(
      "sess_deleting_victim",
      await deriveWorkspaceId("victim_deleting"),
      "deletion_pending",
    );

    expect(
      await ask("attacker_deleting", "sess_deleting_victim", { allowDeletionPending: true }),
    ).toEqual({ kind: "denied", reason: "not_owner" });
  });

  it("leaves an archived session readable by its owner", async () => {
    const subject = "owner_archived";
    await insertSession("sess_archived_auth", await deriveWorkspaceId(subject), "archived");

    expect((await ask(subject, "sess_archived_auth")).kind).toBe("authorized");
  });
});

describe("authorize denial code mappings", () => {
  it("maps every denial reason to an HTTP status and a WebSocket close code", () => {
    const reasons: readonly AuthorizeDenialReason[] = [
      "unauthenticated",
      "not_allowlisted",
      "resource_not_found",
      "not_owner",
    ];

    for (const reason of reasons) {
      expect(typeof AUTHORIZE_DENIAL_HTTP_STATUS[reason]).toBe("number");
      expect(typeof AUTHORIZE_DENIAL_WS_CLOSE_CODE[reason]).toBe("number");
    }
  });

  it("makes 'not yours' and 'does not exist' indistinguishable from the outside", () => {
    expect(AUTHORIZE_DENIAL_HTTP_STATUS.resource_not_found).toBe(
      AUTHORIZE_DENIAL_HTTP_STATUS.not_owner,
    );
    expect(AUTHORIZE_DENIAL_WS_CLOSE_CODE.resource_not_found).toBe(
      AUTHORIZE_DENIAL_WS_CLOSE_CODE.not_owner,
    );
  });
});
