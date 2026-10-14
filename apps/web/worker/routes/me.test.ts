import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { createClerkDouble } from "../test/clerk-double";
import { handleMe, modelCatalog, withRuntimes } from "./me";

const url = "https://oncue.example/api/me";

function envWith(overrides: {
  CLERK_JWT_KEY?: string;
  ONCUE_USER_ALLOWLIST?: string;
  ONCUE_ENV?: string;
}): Env {
  return { ...env, ...overrides } as unknown as Env;
}

describe("handleMe", () => {
  it("returns 401 for an unauthenticated request", async () => {
    const response = await handleMe(new Request(url), env, createAllowlistCache());
    expect(response.status).toBe(401);
  });

  it("returns 403 with no clerkSubject in the hosted environment", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_blocked_hosted", url);

    const response = await handleMe(
      request,
      envWith({
        CLERK_JWT_KEY: double.jwtKey,
        ONCUE_USER_ALLOWLIST: "someone_else",
        ONCUE_ENV: "hosted" as unknown as Env["ONCUE_ENV"],
      }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "not_allowlisted" });
  });

  it("returns 403 with the caller's own Clerk subject locally", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_blocked_local", url);

    const response = await handleMe(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "someone_else" }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "not_allowlisted", clerkSubject: "user_blocked_local" });
  });

  it("registers on first use and returns the internal user and workspace ids", async () => {
    const subject = "user_me_allowed";
    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);

    const response = await handleMe(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      userId: string;
      workspaceId: string;
      setup: unknown;
    };
    expect(body.userId).toMatch(/^usr_/);
    expect(body.workspaceId).toMatch(/^wsp_/);
    // A brand-new workspace has no GitHub installation, so setup asks for that
    // first (record 13).
    expect(body.setup).toEqual({ kind: "connect_github", installUrl: null });
  });

  it("hands the image warm to the caller to run after the response", async () => {
    const subject = "user_me_warm";
    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);
    const deferred: Promise<unknown>[] = [];

    const response = await handleMe(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
      (work) => deferred.push(work),
    );

    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    // No controller is configured here, so there is nothing to warm.
    await expect(Promise.all(deferred)).resolves.toEqual([undefined]);
  });
});

describe("withRuntimes", () => {
  it("adds the allowed harnesses to a ready workspace, and leaves any other state alone", () => {
    const ready = { kind: "ready", repositories: [], modelConnections: [] };
    expect(withRuntimes(ready, undefined)).toEqual({
      ...ready,
      catalog: modelCatalog(),
      runtimes: [
        {
          id: "opencode",
          name: "OpenCode",
          providers: ["anthropic", "openai"],
          images: true,
          holdsToolCalls: true,
        },
      ],
    });
    expect(withRuntimes(ready, "not-carried")).toEqual({
      ...ready,
      runtimes: [],
      catalog: modelCatalog(),
    });
    // Both providers' models ride along, whichever keys the workspace has.
    expect(Object.keys(modelCatalog()).sort()).toEqual(["anthropic", "openai"]);
    expect(modelCatalog().openai.map((spec) => spec.modelId)).toContain("gpt-6-sol");
    const connect = { kind: "connect_github", installUrl: null };
    expect(withRuntimes(connect, undefined)).toBe(connect);
  });
});
