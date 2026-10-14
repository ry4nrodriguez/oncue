import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClerkDouble } from "../test/clerk-double";
import { actorUserId, actorWorkspaceId } from "./actor";
import { createAllowlistCache } from "./allowlist";
import { authorizeActor } from "./authorize";
import { deriveUserId, deriveWorkspaceId } from "./register";

const url = "https://oncue.example/api/me";

function envWith(overrides: { CLERK_JWT_KEY: string; ONCUE_USER_ALLOWLIST: string }): Env {
  return { ...env, ...overrides } as unknown as Env;
}

describe("authorizeActor", () => {
  it("denies an unauthenticated request", async () => {
    const result = await authorizeActor(env, new Request(url), createAllowlistCache());
    expect(result).toEqual({ kind: "denied", reason: "unauthenticated" });
  });

  it("denies a verified subject that is not on the allowlist, carrying the subject for a local-only hint", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_blocked", url);

    const result = await authorizeActor(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "someone_else" }),
      request,
      createAllowlistCache(),
    );

    expect(result).toEqual({
      kind: "denied",
      reason: "not_allowlisted",
      clerkSubject: "user_blocked",
    });
  });

  it("authorizes and registers an allowlisted subject", async () => {
    const subject = "user_allowed";
    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);

    const result = await authorizeActor(
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      request,
      createAllowlistCache(),
    );

    expect(result.kind).toBe("authorized");
    if (result.kind === "authorized") {
      expect(actorUserId(result.actor)).toBe(await deriveUserId(subject));
      expect(actorWorkspaceId(result.actor)).toBe(await deriveWorkspaceId(subject));
    }
  });
});
