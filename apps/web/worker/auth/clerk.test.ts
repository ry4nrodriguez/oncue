import { describe, expect, it } from "vitest";
import { createClerkDouble } from "../test/clerk-double";
import { verifyClerkSession } from "./clerk";

const url = "https://oncue.example/api/me";

describe("verifyClerkSession", () => {
  it("refuses when an Authorization header is present at all", async () => {
    const double = await createClerkDouble();
    const request = new Request(url, {
      headers: { authorization: "Bearer whatever", cookie: "__session=irrelevant" },
    });

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "unverified" });
  });

  it("refuses when there is no cookie header at all", async () => {
    const double = await createClerkDouble();
    const request = new Request(url);

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "unverified" });
  });

  it("refuses when the cookie header has no __session entry", async () => {
    const double = await createClerkDouble();
    const request = new Request(url, { headers: { cookie: "other=value; another=thing" } });

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "unverified" });
  });

  it("refuses a token forged with a different key", async () => {
    const double = await createClerkDouble();
    const token = await double.forgedFor("user_a", url);
    const request = new Request(url, { headers: { cookie: `__session=${token}` } });

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "unverified" });
  });

  it("refuses an expired token", async () => {
    const double = await createClerkDouble();
    const token = await double.expiredFor("user_a", url);
    const request = new Request(url, { headers: { cookie: `__session=${token}` } });

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "unverified" });
  });

  it("verifies a valid session token and returns the subject", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_a", url);

    const result = await verifyClerkSession(request, double.jwtKey);

    expect(result).toEqual({ kind: "verified", subject: "user_a" });
  });

  // Clerk's client may write only the suffixed form (the suffix comes from the
  // publishable key).
  it("verifies a suffixed __session_<suffix> cookie when the plain one is absent", async () => {
    const double = await createClerkDouble();
    const token = (await double.requestAs("user_a", url)).headers
      .get("cookie")
      ?.replace(/^__session=/, "");
    const request = new Request(url, {
      headers: { cookie: `__client_uat=1; __session_maQXYLqq=${token}; other=x` },
    });

    expect(await verifyClerkSession(request, double.jwtKey)).toEqual({
      kind: "verified",
      subject: "user_a",
    });
  });

  it("tries the plain cookie first and falls through a stale or forged one to a live suffixed one", async () => {
    const double = await createClerkDouble();
    const live = (await double.requestAs("user_a", url)).headers
      .get("cookie")
      ?.replace(/^__session=/, "");
    const forged = await double.forgedFor("user_b", url);
    const request = new Request(url, {
      headers: {
        cookie: `__session=${forged}; __session_bare; __session_abc=${live}; __session_=nothing`,
      },
    });

    expect(await verifyClerkSession(request, double.jwtKey)).toEqual({
      kind: "verified",
      subject: "user_a",
    });
    // Two bad candidates and no good one is still a refusal.
    const allBad = new Request(url, {
      headers: { cookie: `__session=${forged}; __session_abc=${forged}` },
    });
    expect(await verifyClerkSession(allBad, double.jwtKey)).toEqual({ kind: "unverified" });
  });
});
