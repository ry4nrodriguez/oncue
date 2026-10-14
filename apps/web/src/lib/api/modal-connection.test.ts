import { describe, expect, it, vi } from "vitest";
import {
  disconnectModalConnection,
  type ModalConnectionRow,
  parseDisconnectModalConnectionResponse,
  parseReadModalConnectionResponse,
  parseSaveModalConnectionResponse,
  readModalConnection,
  saveModalConnection,
} from "./modal-connection";

const ROW: ModalConnectionRow = {
  connectionId: "mdl_1",
  workspaceName: "acme-workspace",
  environmentName: null,
  status: "active",
  lastValidatedAt: "2026-09-08T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseReadModalConnectionResponse", () => {
  it("reads a connection", () => {
    expect(parseReadModalConnectionResponse(200, { connection: ROW })).toEqual({
      kind: "read",
      connection: ROW,
    });
  });

  it("reads a named environment", () => {
    const named = { ...ROW, environmentName: "staging" };
    expect(parseReadModalConnectionResponse(200, { connection: named })).toEqual({
      kind: "read",
      connection: named,
    });
  });

  /** A workspace that has not connected Modal, which is a real answer. */
  it("reads an explicit null as no connection", () => {
    expect(parseReadModalConnectionResponse(200, { connection: null })).toEqual({
      kind: "read",
      connection: null,
    });
  });

  it.each([401, 403])("reads a %i as denied", (status) => {
    expect(parseReadModalConnectionResponse(status, {})).toEqual({ kind: "denied" });
  });

  it.each([500, 404])("reads a %i as unreachable", (status) => {
    expect(parseReadModalConnectionResponse(status, {})).toEqual({ kind: "unreachable" });
  });

  it.each([
    ["a body that is not an object", "nope"],
    ["a missing connection field", {}],
    ["a row that is not an object", { connection: 7 }],
    ["a row with no connection id", { connection: { ...ROW, connectionId: 1 } }],
    ["a row with no workspace name", { connection: { ...ROW, workspaceName: null } }],
    [
      "a row whose environment is neither null nor a string",
      { connection: { ...ROW, environmentName: 3 } },
    ],
    ["a row with a status this build does not know", { connection: { ...ROW, status: "revoked" } }],
    ["a row with no validation time", { connection: { ...ROW, lastValidatedAt: null } }],
    ["a row with no creation time", { connection: { ...ROW, createdAt: null } }],
  ])("refuses %s", (_name, body) => {
    expect(parseReadModalConnectionResponse(200, body)).toEqual({ kind: "unreachable" });
  });
});

describe("parseSaveModalConnectionResponse", () => {
  it("reads a saved connection", () => {
    expect(parseSaveModalConnectionResponse(200, { connection: ROW })).toEqual({
      kind: "saved",
      connection: ROW,
    });
  });

  it("refuses a 200 whose body is not a connection", () => {
    expect(parseSaveModalConnectionResponse(200, { connection: null })).toEqual({
      kind: "unreachable",
    });
  });

  it.each([
    ["tokenId", "tokenId"],
    ["tokenSecret", "tokenSecret"],
  ] as const)("reads a 400 naming %s", (reason, expected) => {
    expect(parseSaveModalConnectionResponse(400, { error: "invalid_request", reason })).toEqual({
      kind: "invalid",
      reason: expected,
    });
  });

  // An unrecognized 400 reason points at the first field.
  it("falls back to tokenId for a 400 reason this build does not know", () => {
    expect(parseSaveModalConnectionResponse(400, { reason: "elsewhere" })).toEqual({
      kind: "invalid",
      reason: "tokenId",
    });
  });

  it.each([
    [422, "invalid_credentials"],
    [422, "no_environment_access"],
    [503, "unreachable"],
    [503, "controller_unavailable"],
  ] as const)("reads a %i carrying %s", (status, reason) => {
    expect(parseSaveModalConnectionResponse(status, { error: "test_failed", reason })).toEqual({
      kind: "test_failed",
      reason,
    });
  });

  it("flattens a failure reason this build does not know to unreachable", () => {
    expect(parseSaveModalConnectionResponse(422, { reason: "quota_exceeded" })).toEqual({
      kind: "test_failed",
      reason: "unreachable",
    });
  });

  it.each([401, 403])("reads a %i as denied", (status) => {
    expect(parseSaveModalConnectionResponse(status, {})).toEqual({ kind: "denied" });
  });

  it("reads anything else as unreachable", () => {
    expect(parseSaveModalConnectionResponse(500, {})).toEqual({ kind: "unreachable" });
  });
});

describe("parseDisconnectModalConnectionResponse", () => {
  it.each([
    [200, { kind: "disconnected" }],
    [404, { kind: "not_found" }],
    [401, { kind: "denied" }],
    [403, { kind: "denied" }],
    [500, { kind: "unreachable" }],
  ])("reads a %i", (status, expected) => {
    expect(parseDisconnectModalConnectionResponse(status)).toEqual(expected);
  });
});

describe("the fetch wrappers", () => {
  it("read, save, and disconnect all address the singular path", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return jsonResponse(200, { connection: ROW, disconnected: true });
    });

    await readModalConnection();
    await saveModalConnection({
      tokenId: "ak-fake0001",
      tokenSecret: "as-fake0001",
      environmentName: null,
    });
    await disconnectModalConnection();

    expect(calls).toEqual([
      { url: "/api/modal-connection", method: undefined },
      { url: "/api/modal-connection", method: "POST" },
      { url: "/api/modal-connection", method: "DELETE" },
    ]);
    vi.unstubAllGlobals();
  });

  it.each([
    ["readModalConnection", readModalConnection],
    ["disconnectModalConnection", disconnectModalConnection],
  ])("%s reports an unreachable server rather than throwing", async (_name, call) => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });

    await expect(call()).resolves.toEqual({ kind: "unreachable" });
    vi.unstubAllGlobals();
  });

  it("saveModalConnection reports an unreachable server rather than throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });

    await expect(
      saveModalConnection({ tokenId: "a", tokenSecret: "b", environmentName: null }),
    ).resolves.toEqual({ kind: "unreachable" });
    vi.unstubAllGlobals();
  });

  it("treats a body that is not JSON as unreachable rather than throwing", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));

    await expect(readModalConnection()).resolves.toEqual({ kind: "unreachable" });
    vi.unstubAllGlobals();
  });
});
