import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelConnection,
  listModelConnections,
  parseCreateConnectionResponse,
  parseListConnectionsResponse,
  parseRecheckConnectionResponse,
  parseReplaceCredentialResponse,
  parseRevokeConnectionResponse,
  recheckModelConnection,
  replaceModelConnectionCredential,
  revokeModelConnection,
} from "./model-connections";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROW = {
  connectionId: "conn_1",
  provider: "anthropic",
  status: "active",
  providerAccountHint: "ends 4f21",
  lastValidatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
};
/** What `ROW` parses to: the wire row plus the session count the parser defaults. */
const PARSED_ROW = { ...ROW, activeSessions: 0 };

const SPEC = {
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  effort: ["low", "medium"],
  defaultEffort: "medium",
  price: { inputPerMTok: 4, outputPerMTok: 20 },
  status: "current",
  recommended: true,
};
const CATALOG = { anthropic: [SPEC], openai: [] };
const LISTED = { catalog: CATALOG, pricesAsOf: "2026-09-23" };

describe("parseListConnectionsResponse", () => {
  it("parses an empty list", () => {
    expect(parseListConnectionsResponse(200, { connections: [], ...LISTED })).toEqual({
      kind: "listed",
      connections: [],
      catalog: CATALOG,
      pricesAsOf: "2026-09-23",
    });
  });

  it("parses a populated list, defaulting a row's session count to zero", () => {
    expect(parseListConnectionsResponse(200, { connections: [ROW], ...LISTED })).toEqual({
      kind: "listed",
      connections: [{ ...ROW, activeSessions: 0 }],
      catalog: CATALOG,
      pricesAsOf: "2026-09-23",
    });
    expect(
      parseListConnectionsResponse(200, {
        connections: [{ ...ROW, activeSessions: 2 }],
        ...LISTED,
      }),
    ).toMatchObject({ connections: [{ activeSessions: 2 }] });
  });

  it("treats a 200 body without a connections array as unreachable", () => {
    expect(parseListConnectionsResponse(200, {})).toEqual({ kind: "unreachable" });
    expect(parseListConnectionsResponse(200, null)).toEqual({ kind: "unreachable" });
  });

  it("treats a missing or malformed catalog as unreachable", () => {
    expect(parseListConnectionsResponse(200, { connections: [], pricesAsOf: "x" })).toEqual({
      kind: "unreachable",
    });
    expect(
      parseListConnectionsResponse(200, {
        connections: [],
        catalog: { anthropic: [] },
        pricesAsOf: "2026-09-23",
      }),
    ).toEqual({ kind: "unreachable" });
    expect(
      parseListConnectionsResponse(200, {
        connections: [],
        catalog: { anthropic: [{ modelId: 1 }], openai: [] },
        pricesAsOf: "2026-09-23",
      }),
    ).toEqual({ kind: "unreachable" });
    expect(parseListConnectionsResponse(200, { connections: [], catalog: CATALOG })).toEqual({
      kind: "unreachable",
    });
  });

  it("treats a row missing a field as making the whole list unreachable", () => {
    const { status: _status, ...withoutStatus } = ROW;
    expect(parseListConnectionsResponse(200, { connections: [withoutStatus], ...LISTED })).toEqual({
      kind: "unreachable",
    });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseListConnectionsResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseListConnectionsResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseListConnectionsResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("parseCreateConnectionResponse", () => {
  it("treats 201 with a valid row as created", () => {
    expect(parseCreateConnectionResponse(201, { connection: ROW })).toEqual({
      kind: "created",
      connection: PARSED_ROW,
    });
  });

  it("treats a 201 body without a valid row as unreachable", () => {
    expect(parseCreateConnectionResponse(201, {})).toEqual({ kind: "unreachable" });
  });

  it("maps a 400 body's reason to the invalid reason", () => {
    expect(
      parseCreateConnectionResponse(400, { error: "invalid_request", reason: "credential" }),
    ).toEqual({ kind: "invalid", reason: "credential" });
    expect(
      parseCreateConnectionResponse(400, { error: "invalid_request", reason: "provider" }),
    ).toEqual({ kind: "invalid", reason: "provider" });
  });

  it("defaults a 400 with an unrecognized reason to provider", () => {
    expect(parseCreateConnectionResponse(400, { error: "invalid_request" })).toEqual({
      kind: "invalid",
      reason: "provider",
    });
    expect(parseCreateConnectionResponse(400, null)).toEqual({
      kind: "invalid",
      reason: "provider",
    });
  });

  it("maps a 409 to already_connected with the connection it names", () => {
    expect(parseCreateConnectionResponse(409, { connectionId: "conn_1" })).toEqual({
      kind: "already_connected",
      connectionId: "conn_1",
    });
    expect(parseCreateConnectionResponse(409, null)).toEqual({
      kind: "already_connected",
      connectionId: "",
    });
  });

  it("maps a 422 body's category to validation_failed", () => {
    expect(
      parseCreateConnectionResponse(422, {
        error: "validation_failed",
        category: "authentication_failed",
      }),
    ).toEqual({ kind: "validation_failed", category: "authentication_failed" });
  });

  it("treats a 422 with an unrecognized category as unreachable", () => {
    expect(parseCreateConnectionResponse(422, { error: "validation_failed" })).toEqual({
      kind: "unreachable",
    });
    expect(
      parseCreateConnectionResponse(422, { error: "validation_failed", category: "made_up" }),
    ).toEqual({ kind: "unreachable" });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseCreateConnectionResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseCreateConnectionResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseCreateConnectionResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("parseReplaceCredentialResponse", () => {
  it("treats 200 with a valid row as replaced", () => {
    expect(parseReplaceCredentialResponse(200, { connection: ROW })).toEqual({
      kind: "replaced",
      connection: PARSED_ROW,
    });
  });

  it("treats a 200 body without a valid row as unreachable", () => {
    expect(parseReplaceCredentialResponse(200, {})).toEqual({ kind: "unreachable" });
  });

  it("maps a 422 body's category to validation_failed", () => {
    expect(
      parseReplaceCredentialResponse(422, { error: "validation_failed", category: "rate_limited" }),
    ).toEqual({ kind: "validation_failed", category: "rate_limited" });
  });

  it("treats a 422 with an unrecognized category as unreachable", () => {
    expect(parseReplaceCredentialResponse(422, { error: "validation_failed" })).toEqual({
      kind: "unreachable",
    });
  });

  it("treats 404 as not_found", () => {
    expect(parseReplaceCredentialResponse(404, { error: "not_found" })).toEqual({
      kind: "not_found",
    });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseReplaceCredentialResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseReplaceCredentialResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseReplaceCredentialResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("parseRevokeConnectionResponse", () => {
  it("treats 200 with a valid row as revoked", () => {
    const revoked = { ...ROW, status: "revoked" };
    expect(parseRevokeConnectionResponse(200, { connection: revoked })).toEqual({
      kind: "revoked",
      connection: { ...revoked, activeSessions: 0 },
    });
  });

  it("treats a 200 body without a valid row as unreachable", () => {
    expect(parseRevokeConnectionResponse(200, {})).toEqual({ kind: "unreachable" });
  });

  it("treats 404 as not_found", () => {
    expect(parseRevokeConnectionResponse(404, { error: "not_found" })).toEqual({
      kind: "not_found",
    });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseRevokeConnectionResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseRevokeConnectionResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseRevokeConnectionResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("listModelConnections", () => {
  it("GETs the collection and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ connections: [ROW], ...LISTED }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listModelConnections()).toEqual({
      kind: "listed",
      connections: [PARSED_ROW],
      catalog: CATALOG,
      pricesAsOf: "2026-09-23",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/model-connections");
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await listModelConnections()).toEqual({ kind: "unreachable" });
  });

  it("treats an unparseable body as unreachable rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect(await listModelConnections()).toEqual({ kind: "unreachable" });
  });
});

describe("createModelConnection", () => {
  it("POSTs the provider and credential and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ connection: ROW }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createModelConnection({ provider: "anthropic", credential: "sk-ant-x" });

    expect(result).toEqual({ kind: "created", connection: PARSED_ROW });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/model-connections");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "anthropic",
      credential: "sk-ant-x",
    });
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await createModelConnection({ provider: "openai", credential: "sk-x" })).toEqual({
      kind: "unreachable",
    });
  });
});

describe("replaceModelConnectionCredential", () => {
  it("PUTs the credential to the connection's id", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ connection: ROW }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await replaceModelConnectionCredential("conn_1", "sk-ant-new");

    expect(result).toEqual({ kind: "replaced", connection: PARSED_ROW });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/model-connections/conn_1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ credential: "sk-ant-new" });
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await replaceModelConnectionCredential("conn_1", "sk-ant-new")).toEqual({
      kind: "unreachable",
    });
  });
});

describe("revokeModelConnection", () => {
  it("POSTs to the connection's revoke endpoint", async () => {
    const revoked = { ...ROW, status: "revoked" };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ connection: revoked }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await revokeModelConnection("conn_1");

    expect(result).toEqual({ kind: "revoked", connection: { ...revoked, activeSessions: 0 } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/model-connections/conn_1/revoke");
    expect(init?.method).toBe("POST");
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await revokeModelConnection("conn_1")).toEqual({ kind: "unreachable" });
  });
});

describe("parseRecheckConnectionResponse", () => {
  it("reads what the provider said and the row afterwards", () => {
    for (const check of ["accepted", "rejected", "unreachable"] as const) {
      expect(parseRecheckConnectionResponse(200, { connection: ROW, check })).toEqual({
        kind: "checked",
        check,
        connection: { ...ROW, activeSessions: 0 },
      });
    }
  });

  it("treats a 200 it cannot read as unreachable", () => {
    expect(parseRecheckConnectionResponse(200, { connection: ROW, check: "maybe" })).toEqual({
      kind: "unreachable",
    });
    expect(parseRecheckConnectionResponse(200, { check: "accepted" })).toEqual({
      kind: "unreachable",
    });
    expect(parseRecheckConnectionResponse(200, null)).toEqual({ kind: "unreachable" });
  });

  it("names a revoked connection, a missing one, a denial, and OnCue's own failure", () => {
    expect(parseRecheckConnectionResponse(409, { error: "revoked" })).toEqual({ kind: "revoked" });
    expect(parseRecheckConnectionResponse(404, null)).toEqual({ kind: "not_found" });
    expect(parseRecheckConnectionResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseRecheckConnectionResponse(403, null)).toEqual({ kind: "denied" });
    expect(parseRecheckConnectionResponse(503, null)).toEqual({ kind: "failed" });
    expect(parseRecheckConnectionResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("recheckModelConnection", () => {
  it("POSTs to the connection's recheck endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ connection: ROW, check: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await recheckModelConnection("conn 1");

    expect(result).toEqual({
      kind: "checked",
      check: "accepted",
      connection: { ...ROW, activeSessions: 0 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/model-connections/conn%201/recheck");
    expect(init?.method).toBe("POST");
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await recheckModelConnection("conn_1")).toEqual({ kind: "unreachable" });
  });
});
