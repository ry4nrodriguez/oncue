import { describe, expect, it } from "vitest";
import {
  checkoutAnswer,
  DEV_APP_COOKIE,
  devSignInOrigin,
  harnessEntryFor,
  signOutRedirect,
} from "./dev-harness";

describe("devSignInOrigin", () => {
  it("is the plain http origin on localhost", () => {
    expect(devSignInOrigin("localhost:5173")).toBe("http://localhost:5173");
    expect(devSignInOrigin(undefined, undefined, 5173)).toBe("http://localhost:5173");
  });

  it("falls back to the port slot's app port only when no Host header came", () => {
    expect(devSignInOrigin(undefined, undefined, 6273)).toBe("http://localhost:6273");
    expect(devSignInOrigin("localhost:6273", undefined, 5173)).toBe("http://localhost:6273");
  });

  it("is https behind a tunnel that forwards https, so the Worker's authorized-party check matches", () => {
    expect(devSignInOrigin("example.trycloudflare.com", "https")).toBe(
      "https://example.trycloudflare.com",
    );
  });

  it("stays http for any other forwarded value", () => {
    expect(devSignInOrigin("example.trycloudflare.com", "http")).toBe(
      "http://example.trycloudflare.com",
    );
    expect(devSignInOrigin("example.trycloudflare.com", "https,http")).toBe(
      "http://example.trycloudflare.com",
    );
  });
});

describe("harnessEntryFor", () => {
  it("matches the harness paths, with or without a trailing slash", () => {
    expect(harnessEntryFor("/dev/session")?.module).toBe("/src/dev/session-harness.tsx");
    expect(harnessEntryFor("/dev/session/")?.module).toBe("/src/dev/session-harness.tsx");
    expect(harnessEntryFor("/dev/home")?.module).toBe("/src/dev/home-harness.tsx");
  });

  it("keeps the query string out of the match", () => {
    expect(harnessEntryFor("/dev/session?fixture=approval")?.title).toBe("OnCue session harness");
  });

  it("claims nothing else, so every other path still reaches the worker", () => {
    expect(harnessEntryFor("/")).toBeNull();
    expect(harnessEntryFor("/dev/inspect")).toBeNull();
    expect(harnessEntryFor("/api/health")).toBeNull();
    expect(harnessEntryFor(undefined)).toBeNull();
  });
});

describe("checkoutAnswer", () => {
  it("names the directory the server was started from, on its one path only", () => {
    expect(checkoutAnswer("/dev/checkout", "/work/apps/web")).toBe('{"root":"/work/apps/web"}');
    expect(checkoutAnswer("/dev/checkout/?x=1", "/work/apps/web")).toBe(
      '{"root":"/work/apps/web"}',
    );
    expect(checkoutAnswer("/dev/checkouts", "/work/apps/web")).toBeNull();
    expect(checkoutAnswer("/api/health", "/work/apps/web")).toBeNull();
    expect(checkoutAnswer(undefined, "/work/apps/web")).toBeNull();
  });
});

describe("signOutRedirect", () => {
  it("expires both cookies the local sign-in set and returns to the gate", () => {
    const redirect = signOutRedirect("/dev/sign-out");
    expect(redirect?.location).toBe("/");
    expect(redirect?.cookies).toEqual([
      "__session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0",
      `${DEV_APP_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`,
    ]);
  });

  it("matches its one path, with or without a trailing slash or a query", () => {
    expect(signOutRedirect("/dev/sign-out/")).not.toBeNull();
    expect(signOutRedirect("/dev/sign-out?x=1")).not.toBeNull();
    expect(signOutRedirect("/dev/sign-outs")).toBeNull();
    expect(signOutRedirect("/dev/sign-in")).toBeNull();
    expect(signOutRedirect("/")).toBeNull();
  });
});
