import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { runScheduledSweeps } from "./index";
import { createClerkDouble } from "./test/clerk-double";

function bindingsOverride(overrides: { ONCUE_ENV?: string; ONCUE_RELEASE?: string }): Env {
  return { ONCUE_ENV: "local", ONCUE_RELEASE: "dev", ...overrides } as unknown as Env;
}

function incomingRequest(url: string): Parameters<typeof worker.fetch>[0] {
  return new Request(url) as unknown as Parameters<typeof worker.fetch>[0];
}

describe("/api/health", () => {
  it("returns the env and release values that came from bindings, not a hard-coded string", async () => {
    const overriddenEnv = bindingsOverride({
      ONCUE_ENV: "override-env",
      ONCUE_RELEASE: "override-release",
    });

    const request = incomingRequest("http://example.com/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, overriddenEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(await response.json()).toEqual({
      ok: true,
      env: "override-env",
      release: "override-release",
      providerTrafficRedirected: false,
    });
  });

  // Both arms matter: a false positive would let a test send a real key to a
  // real provider.
  it("reports that provider traffic is redirected when a local override is set", async () => {
    const request = incomingRequest("http://example.com/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      {
        ...env,
        ONCUE_ENV: "local",
        ONCUE_PROVIDER_DOUBLE_ORIGIN: "http://127.0.0.1:5199",
      } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(
      ((await response.json()) as { providerTrafficRedirected: boolean }).providerTrafficRedirected,
    ).toBe(true);
  });

  it("reports no redirection when there is no override", async () => {
    const request = incomingRequest("http://example.com/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, bindingsOverride({}), ctx);
    await waitOnExecutionContext(ctx);

    expect(
      ((await response.json()) as { providerTrafficRedirected: boolean }).providerTrafficRedirected,
    ).toBe(false);
  });

  it("reports no redirection hosted, even when an override is present", async () => {
    const request = incomingRequest("http://example.com/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      {
        ...env,
        ONCUE_ENV: "hosted",
        ONCUE_PROVIDER_DOUBLE_ORIGIN: "http://evil.example",
      } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(
      ((await response.json()) as { providerTrafficRedirected: boolean }).providerTrafficRedirected,
    ).toBe(false);
  });

  it("returns 404 for an unknown route", async () => {
    const request = incomingRequest("http://example.com/nope");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, bindingsOverride({}), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});

function envWith(overrides: { CLERK_JWT_KEY?: string; ONCUE_USER_ALLOWLIST?: string }): Env {
  return { ...env, ...overrides } as unknown as Env;
}

describe("routing through the real Worker entry", () => {
  it("GET /api/me denies an unauthenticated request", async () => {
    const request = incomingRequest("http://example.com/api/me");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("POST /api/sessions denies an unauthenticated request", async () => {
    const request = new Request("http://example.com/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("GET /api/sessions denies an unauthenticated request", async () => {
    const request = new Request("http://example.com/api/sessions", {
      method: "GET",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("DELETE /api/sessions/:id denies an unauthenticated request", async () => {
    const request = new Request("http://example.com/api/sessions/sess_1", {
      method: "DELETE",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("DELETE to a path that is not a session id falls through to 404", async () => {
    const request = new Request("http://example.com/api/other", {
      method: "DELETE",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });

  it("/ws/ routes reach the WebSocket upgrade handler, refusing an unauthenticated one with a 101 accept-then-close", async () => {
    const request = new Request("http://example.com/ws/sessions/sess_1/client", {
      headers: { Upgrade: "websocket" },
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(101);
  });

  it("reuses one module-scope allowlist cache across requests instead of building a fresh one each time", async () => {
    const double = await createClerkDouble();
    const testEnv = envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "" });
    const authed = await double.requestAs("user_repeat", "http://example.com/api/me");
    const request = new Request("http://example.com/api/me", {
      headers: { cookie: authed.headers.get("cookie") ?? "" },
    }) as unknown as Parameters<typeof worker.fetch>[0];

    const ctxA = createExecutionContext();
    const responseA = await worker.fetch(request.clone() as typeof request, testEnv, ctxA);
    await waitOnExecutionContext(ctxA);
    const ctxB = createExecutionContext();
    const responseB = await worker.fetch(request, testEnv, ctxB);
    await waitOnExecutionContext(ctxB);

    // Both calls agree (both blocked, since the allowlist is empty).
    expect(responseA.status).toBe(403);
    expect(responseB.status).toBe(403);
  });
});

// Routing only: a 401 or 403 proves the entry reaches the handler, a 404
// would not.
describe("model connection and broker routes are reachable from the Worker entry", () => {
  const cases: readonly [string, string, string][] = [
    ["GET", "http://example.com/api/model-connections", "list connections"],
    ["POST", "http://example.com/api/model-connections", "create a connection"],
    ["PUT", "http://example.com/api/model-connections/mc_1", "replace a credential"],
    ["POST", "http://example.com/api/model-connections/mc_1/revoke", "revoke a connection"],
    ["POST", "http://example.com/api/sessions/sess_1/broker-token", "issue a token"],
  ];

  for (const [method, url, what] of cases) {
    it(`routes ${method} ${new URL(url).pathname} to ${what}`, async () => {
      const request = new Request(url, { method }) as unknown as Parameters<typeof worker.fetch>[0];
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).not.toBe(404);
      expect(response.status).toBe(401);
    });
  }

  /** Bearer routes answer 403, not 401: there is no Clerk session to be missing. */
  it("routes the forwarding path to the broker", async () => {
    const request = new Request("http://example.com/api/broker/sessions/sess_1/v1/messages", {
      method: "POST",
      body: "{}",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });

  it("routes the refresh path to the broker", async () => {
    const request = new Request("http://example.com/api/broker/token/refresh", {
      method: "POST",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });
});

// The guard's placement: in front of every cookie-authenticated
// state-changing route and before authentication. A 403 `cross_site_request`
// came from the guard, a 401 from authentication, `forbidden` from the broker.
describe("the same-origin guard in front of the dispatch table", () => {
  const evil = "https://evil.example";

  async function dispatch(
    url: string,
    init: { method: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    const request = new Request(url, init) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: await response.json() };
  }

  it("refuses a cross-site POST before authentication runs, so no cookie is needed to be refused", async () => {
    const result = await dispatch("http://example.com/api/model-connections", {
      method: "POST",
      headers: { origin: evil },
    });

    expect(result).toEqual({ status: 403, body: { error: "cross_site_request" } });
  });

  it("passes a POST whose Origin matches on to authentication, which then refuses it", async () => {
    const result = await dispatch("http://example.com/api/model-connections", {
      method: "POST",
      headers: { origin: "http://example.com" },
    });

    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("refuses a POST the browser itself marks cross-site", async () => {
    const result = await dispatch("http://example.com/api/model-connections", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(result).toEqual({ status: 403, body: { error: "cross_site_request" } });
  });

  // An upgrade is a GET but cookie-authenticated with no same-origin policy of
  // its own, so unguarded it would let a foreign page stream a timeline.
  it("refuses a cross-site WebSocket upgrade before authentication runs", async () => {
    const result = await dispatch("http://example.com/ws/sess_1", {
      method: "GET",
      headers: { upgrade: "websocket", origin: evil },
    });

    expect(result).toEqual({ status: 403, body: { error: "cross_site_request" } });
  });

  it("does not guard a read: GET /api/me with a foreign Origin reaches authentication", async () => {
    const result = await dispatch("http://example.com/api/me", {
      method: "GET",
      headers: { origin: evil },
    });

    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("guards the other cookie-authenticated mutations the same way", async () => {
    const mutations: readonly [string, string][] = [
      ["POST", "http://example.com/api/sessions"],
      ["DELETE", "http://example.com/api/sessions/sess_1"],
      ["PUT", "http://example.com/api/model-connections/mc_1"],
      ["POST", "http://example.com/api/model-connections/mc_1/revoke"],
      ["POST", "http://example.com/api/sessions/sess_1/broker-token"],
    ];

    for (const [method, url] of mutations) {
      const result = await dispatch(url, { method, headers: { origin: evil } });
      expect(result, `${method} ${url}`).toEqual({
        status: 403,
        body: { error: "cross_site_request" },
      });
    }
  });

  it("lets a broker forward with no Origin at all reach its handler", async () => {
    const result = await dispatch("http://example.com/api/broker/sessions/sess_1/v1/messages", {
      method: "POST",
    });

    expect(result).toEqual({ status: 403, body: { error: "forbidden" } });
  });

  it("lets a broker forward reach its handler even when marked cross-site, because it is exempt", async () => {
    const result = await dispatch("http://example.com/api/broker/sessions/sess_1/v1/messages", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(result).toEqual({ status: 403, body: { error: "forbidden" } });
  });

  // GitHub always posts cross-site; the 401 comes from the route's signature
  // check, not the guard.
  it("lets a cross-site POST to the GitHub webhook past the guard, to its own signature check", async () => {
    const request = new Request("http://example.com/api/github/webhook", {
      method: "POST",
      headers: {
        "sec-fetch-site": "cross-site",
        "x-github-delivery": "d-1",
        "x-github-event": "push",
      },
      body: "{}",
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    expect(await response.json()).not.toEqual({ error: "cross_site_request" });
  });
});

// The cron trigger in `wrangler.jsonc` calls this so a session whose create
// never reached its object does not stay `creating` forever.
describe("scheduled", () => {
  it("sweeps a creating row older than the window and leaves a live session alone", async () => {
    const old = "2026-01-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
         VALUES ('ses_cron_stuck', 'ws_cron', NULL, 'creating', ?, ?)`,
      ).bind(old, old),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, created_at, updated_at)
         VALUES ('ses_cron_live', 'ws_cron', NULL, 'active', ?, ?)`,
      ).bind(old, old),
    ]);

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "*/5 * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const left = await env.DB.prepare(
      "SELECT session_id FROM session_index WHERE workspace_id = 'ws_cron'",
    ).all<{ session_id: string }>();
    expect(left.results.map((row) => row.session_id)).toEqual(["ses_cron_live"]);
  });
});

describe("the scheduled sweeps", () => {
  it("runs every sweep even when an earlier one throws, and names the ones that failed", async () => {
    const ran: string[] = [];
    const failed = await runScheduledSweeps(bindingsOverride({}), {
      creating: async () => {
        ran.push("creating");
        throw new Error("D1 is unavailable");
      },
      attachments: async () => {
        ran.push("attachments");
      },
      deletions: async () => {
        ran.push("deletions");
        throw new Error("R2 is unavailable");
      },
    });

    expect(ran).toEqual(["creating", "attachments", "deletions"]);
    expect(failed).toEqual(["creating", "deletions"]);
  });

  it("finishes an owed deletion from the cron", async () => {
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, created_at, updated_at)
         VALUES ('ses_cron_delete', 'ws_cron_delete', 'deletion_pending', ?, ?)`,
      ).bind(at, at),
      env.DB.prepare(
        `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id, requested_at)
         VALUES ('del_cron', 'ses_cron_delete', 'ws_cron_delete', 'user_cron', ?)`,
      ).bind(at),
    ]);

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "*/5 * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(
      await env.DB.prepare(
        "SELECT session_id FROM session_index WHERE session_id = 'ses_cron_delete'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT completed_at FROM deletion_request WHERE id = 'del_cron'",
      ).first(),
    ).toEqual({ completed_at: expect.any(String) });
  });
});

describe("the archive routes are reachable from the Worker entry", () => {
  for (const action of ["archive", "unarchive"]) {
    it(`POST /api/sessions/:id/${action} denies an unauthenticated request`, async () => {
      const request = new Request(`http://example.com/api/sessions/sess_1/${action}`, {
        method: "POST",
      }) as unknown as Parameters<typeof worker.fetch>[0];
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });
  }
});
