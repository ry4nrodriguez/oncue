import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import {
  handleDisconnectModalConnection,
  handleReadModalConnection,
  handleSaveModalConnection,
} from "./modal-connection";

const BASE_URL = "https://oncue.example/api/modal-connection";
const CONTROLLER_ORIGIN = "https://oncue--controller.modal.run";
const NOW = "2026-09-08T00:00:00.000Z";

/** Short and obviously fake, so no secret scanner has to decide about them. */
const TOKEN_ID = "ak-fake0001";
const TOKEN_SECRET = "as-fake0001";

// The signing key and allowlist travel with the subject; forgetting either
// would make every case pass on a 401 or 403 for the wrong reason.
function envFor(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  overrides: {
    ONCUE_BROKER_KEYRING?: string;
    ONCUE_SANDBOX_CONTROLLER_ORIGIN?: string;
    ONCUE_SANDBOX_CONTROLLER_TOKEN?: string;
  } = {},
): Env {
  return {
    ...env,
    CLERK_JWT_KEY: double.jwtKey,
    ONCUE_USER_ALLOWLIST: subject,
    ONCUE_SANDBOX_CONTROLLER_ORIGIN: CONTROLLER_ORIGIN,
    ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token-value",
    ...overrides,
  } as unknown as Env;
}

async function requestAs(
  double: Awaited<ReturnType<typeof createClerkDouble>>,
  subject: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Request> {
  const authed = await double.requestAs(subject, BASE_URL);
  const headers = new Headers({ cookie: authed.headers.get("cookie") ?? "" });
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(BASE_URL, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
}

async function seedWorkspace(subject: string): Promise<string> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, userId, NOW, NOW),
  ]);
  return workspaceId;
}

// Stands in for the controller's `/v1/connection/test`; the route, store, and
// envelope are real, so nothing reaches Modal.
function stubController(answer: { status: number; body: unknown }): { seen: Request[] } {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    seen.push(new Request(input as string, init));
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  return { seen };
}

function accepted(workspaceName = "acme-workspace"): { status: number; body: unknown } {
  return {
    status: 200,
    body: { kind: "ok", value: { workspaceName, environments: ["main"] } },
  };
}

function refused(reason: string): { status: number; body: unknown } {
  return { status: 200, body: { kind: "failed", reason } };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM modal_connection").run();
  vi.unstubAllGlobals();
});

describe("GET /api/modal-connection", () => {
  it("refuses a caller with no session", async () => {
    const response = await handleReadModalConnection(
      new Request(BASE_URL),
      env,
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  it("answers null for a workspace that has not connected Modal", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_read");

    const response = await handleReadModalConnection(
      await requestAs(double, "user_modal_read"),
      envFor(double, "user_modal_read"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
  });

  it("answers with the summary after a save, and never a credential", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_read2");
    stubController(accepted());
    const workerEnv = envFor(double, "user_modal_read2");
    const cache = createAllowlistCache();

    await handleSaveModalConnection(
      await requestAs(double, "user_modal_read2", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      workerEnv,
      cache,
    );
    vi.unstubAllGlobals();

    const response = await handleReadModalConnection(
      await requestAs(double, "user_modal_read2"),
      workerEnv,
      cache,
    );

    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      connection: { workspaceName: "acme-workspace", environmentName: null, status: "active" },
    });
    expect(body).not.toContain(TOKEN_ID);
    expect(body).not.toContain(TOKEN_SECRET);
    expect(body).not.toContain("oncue1.");
  });
});

describe("POST /api/modal-connection", () => {
  it("refuses a caller with no session", async () => {
    const response = await handleSaveModalConnection(
      new Request(BASE_URL, { method: "POST" }),
      env,
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ["tokenId", {}],
    ["tokenId", { tokenSecret: TOKEN_SECRET }],
    ["tokenId", { tokenId: "   ", tokenSecret: TOKEN_SECRET }],
    ["tokenId", { tokenId: 7, tokenSecret: TOKEN_SECRET }],
    ["tokenSecret", { tokenId: TOKEN_ID }],
    ["tokenSecret", { tokenId: TOKEN_ID, tokenSecret: "  " }],
  ])("refuses a body missing %s without calling the controller", async (reason, body) => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_bad_body");
    const { seen } = stubController(accepted());

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_bad_body", { method: "POST", body }),
      envFor(double, "user_modal_bad_body"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", reason });
    // A bad paste is not worth a round trip, and a doomed test would still be
    // a credential leaving the control plane.
    expect(seen).toEqual([]);
  });

  it("refuses a body that is not JSON at all", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_not_json");
    const authed = await double.requestAs("user_modal_not_json", BASE_URL);

    const response = await handleSaveModalConnection(
      new Request(BASE_URL, {
        method: "POST",
        headers: new Headers({
          cookie: authed.headers.get("cookie") ?? "",
          "content-type": "application/json",
        }),
        body: "not json",
      }),
      envFor(double, "user_modal_not_json"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(400);
  });

  it("tests the pair against the controller and stores it on success", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_save");
    const { seen } = stubController(accepted("oncue-sandboxes"));

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_save", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, environmentName: "staging" },
      }),
      envFor(double, "user_modal_save"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connection: {
        workspaceName: "oncue-sandboxes",
        environmentName: "staging",
        status: "active",
      },
    });

    const call = seen[0];
    if (call === undefined) {
      throw new Error("expected one controller call");
    }
    expect(call.url).toBe(`${CONTROLLER_ORIGIN}/v1/connection/test`);
    expect(call.headers.get("x-oncue-modal-token-id")).toBe(TOKEN_ID);
    expect(call.headers.get("x-oncue-modal-environment")).toBe("staging");
  });

  it("asks the controller to prepare the image in the newly connected workspace, after the response", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_warm");
    const { seen } = stubController(accepted());
    const deferred: Promise<unknown>[] = [];

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_warm", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      envFor(double, "user_modal_warm"),
      createAllowlistCache(),
      (work) => deferred.push(work),
    );
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);

    // The connection test, then the preparation, on the stored credential.
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/connection/test",
      "/v1/prepareImage",
    ]);
    expect(seen[1]?.headers.get("x-oncue-modal-token-id")).toBe(TOKEN_ID);
  });

  it("treats a blank environment as the workspace default", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_blank_env");
    const { seen } = stubController(accepted());

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_blank_env", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, environmentName: "   " },
      }),
      envFor(double, "user_modal_blank_env"),
      createAllowlistCache(),
    );

    expect(await response.json()).toMatchObject({ connection: { environmentName: null } });
    expect(seen[0]?.headers.get("x-oncue-modal-environment")).toBeNull();
  });

  // A verdict on the paste is 422 (actionable); a controller that could not
  // answer is 503 (retry).
  it.each([
    ["invalid_credentials", 422],
    ["no_environment_access", 422],
    ["unreachable", 503],
  ] as const)("answers %s with %i and stores nothing", async (reason, status) => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace("user_modal_refused");
    stubController(refused(reason));

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_refused", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      envFor(double, "user_modal_refused"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "test_failed", reason });
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM modal_connection WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("says the controller is unavailable when it rejects OnCue's own token", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_401");
    stubController({ status: 401, body: { kind: "error", category: "credentials" } });

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_401", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      envFor(double, "user_modal_401"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "test_failed",
      reason: "controller_unavailable",
    });
  });

  it("refuses to store an untested pair when no controller is configured", async () => {
    const double = await createClerkDouble();
    const workspaceId = await seedWorkspace("user_modal_no_controller");
    const { seen } = stubController(accepted());

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_no_controller", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      envFor(double, "user_modal_no_controller", { ONCUE_SANDBOX_CONTROLLER_ORIGIN: "" }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "test_failed",
      reason: "controller_unavailable",
    });
    expect(seen).toEqual([]);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM modal_connection WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("refuses when there is no keyring to seal the pair with", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_no_keyring");
    stubController(accepted());

    const response = await handleSaveModalConnection(
      await requestAs(double, "user_modal_no_keyring", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      envFor(double, "user_modal_no_keyring", { ONCUE_BROKER_KEYRING: "" }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(503);
  });
});

describe("DELETE /api/modal-connection", () => {
  it("refuses a caller with no session", async () => {
    const response = await handleDisconnectModalConnection(
      new Request(BASE_URL, { method: "DELETE" }),
      env,
      createAllowlistCache(),
    );

    expect(response.status).toBe(401);
  });

  it("removes the connection, and a second call is a 404", async () => {
    const double = await createClerkDouble();
    await seedWorkspace("user_modal_delete");
    stubController(accepted());
    const workerEnv = envFor(double, "user_modal_delete");
    const cache = createAllowlistCache();
    await handleSaveModalConnection(
      await requestAs(double, "user_modal_delete", {
        method: "POST",
        body: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
      }),
      workerEnv,
      cache,
    );
    vi.unstubAllGlobals();

    const first = await handleDisconnectModalConnection(
      await requestAs(double, "user_modal_delete", { method: "DELETE" }),
      workerEnv,
      cache,
    );
    const second = await handleDisconnectModalConnection(
      await requestAs(double, "user_modal_delete", { method: "DELETE" }),
      workerEnv,
      cache,
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ disconnected: true });
    // A disconnect that quietly did nothing would leave someone believing a
    // credential was withdrawn when it never existed.
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "not_found" });
  });

  it("never removes another workspace's connection", async () => {
    const double = await createClerkDouble();
    const mine = await seedWorkspace("user_modal_mine");
    const theirs = await seedWorkspace("user_modal_theirs");
    await env.DB.prepare(
      `INSERT INTO modal_connection (
         connection_id, workspace_id, token_id_reference, token_secret_reference,
         modal_workspace_name, environment_name, status, last_validated_at,
         created_at, updated_at
       ) VALUES ('mdl_theirs', ?, 'oncue1.1.n.i', 'oncue1.1.n.s', 'theirs', NULL, 'active', ?, ?, ?)`,
    )
      .bind(theirs, NOW, NOW, NOW)
      .run();

    const response = await handleDisconnectModalConnection(
      await requestAs(double, "user_modal_mine", { method: "DELETE" }),
      envFor(double, "user_modal_mine"),
      createAllowlistCache(),
    );

    expect(response.status).toBe(404);
    expect(mine).not.toBe(theirs);
    const survived = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM modal_connection WHERE workspace_id = ?",
    )
      .bind(theirs)
      .first<{ count: number }>();
    expect(survived?.count).toBe(1);
  });
});
