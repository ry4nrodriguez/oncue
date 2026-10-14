import { describe, expect, it } from "vitest";
import type { SetupState } from "@/lib/api/setup";
import {
  blockedLocalHint,
  decideGateState,
  ME_RETRY_CAP_MS,
  meRetryDelay,
  parseMeResponse,
} from "./gate";

const READY: SetupState = { kind: "ready", repositories: [], modelConnections: [] };

describe("decideGateState", () => {
  it("is loading while Clerk itself has not loaded yet", () => {
    expect(decideGateState(false, false, null)).toEqual({ kind: "loading" });
    expect(decideGateState(false, true, null)).toEqual({ kind: "loading" });
  });

  it("is signed_out once loaded but not signed in", () => {
    expect(decideGateState(true, false, null)).toEqual({ kind: "signed_out" });
  });

  it("is loading once signed in but /api/me has not answered yet", () => {
    expect(decideGateState(true, true, null)).toEqual({ kind: "loading" });
    expect(decideGateState(true, true, null, false)).toEqual({ kind: "loading" });
  });

  it("is failed once signed in when /api/me failed and nothing usable came before", () => {
    expect(decideGateState(true, true, null, true)).toEqual({ kind: "failed" });
  });

  it("keeps the last usable answer through a failed refetch", () => {
    expect(
      decideGateState(
        true,
        true,
        { kind: "allowed", userId: "usr_1", workspaceId: "wsp_1", setup: READY },
        true,
      ),
    ).toEqual({ kind: "allowed", userId: "usr_1", workspaceId: "wsp_1", setup: READY });
  });

  it("never shows the failure while signed out or before Clerk loads", () => {
    expect(decideGateState(true, false, null, true)).toEqual({ kind: "signed_out" });
    expect(decideGateState(false, true, null, true)).toEqual({ kind: "loading" });
  });

  it("is blocked when /api/me reports the identity is not allowlisted", () => {
    expect(decideGateState(true, true, { kind: "blocked", clerkSubject: "user_x" })).toEqual({
      kind: "blocked",
      clerkSubject: "user_x",
    });
  });

  it("is allowed with the workspace, user id and setup once /api/me confirms registration", () => {
    expect(
      decideGateState(true, true, {
        kind: "allowed",
        userId: "usr_1",
        workspaceId: "wsp_1",
        setup: READY,
      }),
    ).toEqual({ kind: "allowed", userId: "usr_1", workspaceId: "wsp_1", setup: READY });
  });
});

describe("parseMeResponse", () => {
  it("parses a 200 body into an allowed result", () => {
    expect(parseMeResponse(200, { userId: "usr_1", workspaceId: "wsp_1", setup: READY })).toEqual({
      kind: "allowed",
      userId: "usr_1",
      workspaceId: "wsp_1",
      setup: READY,
    });
  });

  it("returns null for a 200 body missing the expected fields", () => {
    expect(parseMeResponse(200, { userId: "usr_1" })).toBeNull();
  });

  it("returns null for a 200 body with a missing or malformed setup field", () => {
    expect(parseMeResponse(200, { userId: "usr_1", workspaceId: "wsp_1" })).toBeNull();
    expect(
      parseMeResponse(200, { userId: "usr_1", workspaceId: "wsp_1", setup: { kind: "bogus" } }),
    ).toBeNull();
  });

  it("parses a 403 body with a clerkSubject (local) into a blocked result", () => {
    expect(parseMeResponse(403, { error: "not_allowlisted", clerkSubject: "user_x" })).toEqual({
      kind: "blocked",
      clerkSubject: "user_x",
    });
  });

  it("parses a 403 body with no clerkSubject (hosted) into a blocked result with null", () => {
    expect(parseMeResponse(403, { error: "not_allowlisted" })).toEqual({
      kind: "blocked",
      clerkSubject: null,
    });
  });

  it("returns null for any other status", () => {
    expect(parseMeResponse(401, { error: "unauthenticated" })).toBeNull();
    expect(parseMeResponse(500, { error: "boom" })).toBeNull();
  });

  it("returns null for a non-object body", () => {
    expect(parseMeResponse(200, null)).toBeNull();
    expect(parseMeResponse(200, "not an object")).toBeNull();
  });
});

describe("blockedLocalHint", () => {
  it("returns null when there is no subject to show", () => {
    expect(blockedLocalHint(null)).toBeNull();
  });

  it("names the subject and the file to paste it into when one is given", () => {
    const hint = blockedLocalHint("user_x");
    expect(hint).toContain("user_x");
    expect(hint).toContain(".dev.vars");
  });
});

describe("meRetryDelay", () => {
  it("doubles from one second and stops at the cap", () => {
    expect(meRetryDelay(0)).toBe(1000);
    expect(meRetryDelay(1)).toBe(1000);
    expect(meRetryDelay(2)).toBe(2000);
    expect(meRetryDelay(3)).toBe(4000);
    expect(meRetryDelay(5)).toBe(16_000);
    expect(meRetryDelay(6)).toBe(ME_RETRY_CAP_MS);
    expect(meRetryDelay(40)).toBe(ME_RETRY_CAP_MS);
  });
});
