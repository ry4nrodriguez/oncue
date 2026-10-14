import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSecret,
  getSecretRequests,
  listSecrets,
  parseDeleteSecretResponse,
  parseListSecretsResponse,
  parseSaveSecretResponse,
  parseSecretRequestsResponse,
  saveSecret,
} from "./secrets";

const SUMMARY = {
  secretId: "dsc_1",
  name: "DATABASE_URL",
  status: "active",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseListSecretsResponse", () => {
  it("reads the names", () => {
    expect(parseListSecretsResponse(200, { secrets: [SUMMARY] })).toEqual({
      kind: "listed",
      secrets: [SUMMARY],
    });
    expect(parseListSecretsResponse(200, { secrets: [] })).toEqual({ kind: "listed", secrets: [] });
  });

  it("drops a field the contract has no place for, so a value could never ride along", () => {
    const result = parseListSecretsResponse(200, {
      secrets: [{ ...SUMMARY, value: "fake-leaked-value" }],
    });
    expect(JSON.stringify(result)).not.toContain("fake-leaked-value");
  });

  it.each([401, 403])("reads %i as denied", (status) => {
    expect(parseListSecretsResponse(status, null)).toEqual({ kind: "denied" });
  });

  it.each([
    [500, null],
    [200, null],
    [200, { secrets: "no" }],
    [200, { secrets: [null] }],
    [200, { secrets: [{ ...SUMMARY, status: "leaked" }] }],
    [200, { secrets: [{ ...SUMMARY, secretId: 1 }] }],
    [200, { secrets: [{ ...SUMMARY, name: 1 }] }],
    [200, { secrets: [{ ...SUMMARY, updatedAt: 1 }] }],
  ])("reads %i %j as unreachable", (status, body) => {
    expect(parseListSecretsResponse(status, body)).toEqual({ kind: "unreachable" });
  });
});

describe("parseSaveSecretResponse", () => {
  it("reads a save, a refusal with its reason, a missing repository, and a denial", () => {
    expect(parseSaveSecretResponse(200, { secret: { ...SUMMARY, status: "unreadable" } })).toEqual({
      kind: "saved",
      secret: { ...SUMMARY, status: "unreadable" },
    });
    expect(parseSaveSecretResponse(400, { reason: "name_reserved" })).toEqual({
      kind: "invalid",
      reason: "name_reserved",
    });
    expect(parseSaveSecretResponse(404, null)).toEqual({ kind: "not_found" });
    expect(parseSaveSecretResponse(401, null)).toEqual({ kind: "denied" });
  });

  it.each([
    [400, null],
    [400, { reason: 7 }],
    [200, null],
    [200, { secret: null }],
    [503, null],
  ])("reads %i %j as unreachable", (status, body) => {
    expect(parseSaveSecretResponse(status, body)).toEqual({ kind: "unreachable" });
  });
});

describe("parseDeleteSecretResponse", () => {
  it("reads each status", () => {
    expect(parseDeleteSecretResponse(200)).toEqual({ kind: "deleted" });
    expect(parseDeleteSecretResponse(404)).toEqual({ kind: "not_found" });
    expect(parseDeleteSecretResponse(403)).toEqual({ kind: "denied" });
    expect(parseDeleteSecretResponse(500)).toEqual({ kind: "unreachable" });
  });
});

describe("the fetch wrappers", () => {
  it("send the value in the body and never in the URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ secret: SUMMARY }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveSecret("rpc 1", "DATABASE_URL", "fake-database-url-0001");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/repositories/rpc%201/secrets/DATABASE_URL");
    expect(url).not.toContain("fake-database-url");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ value: "fake-database-url-0001" });
  });

  it("list and delete by path", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? Response.json({ deleted: true }, { status: 200 })
        : Response.json({ secrets: [SUMMARY] }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listSecrets("rpc_1")).toEqual({ kind: "listed", secrets: [SUMMARY] });
    expect(await deleteSecret("rpc_1", "DATABASE_URL")).toEqual({ kind: "deleted" });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/repositories/rpc_1/secrets",
      "/api/repositories/rpc_1/secrets/DATABASE_URL",
    ]);
  });

  it("answer unreachable when the network fails or the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await listSecrets("rpc_1")).toEqual({ kind: "unreachable" });
    expect(await saveSecret("rpc_1", "A", "fake-value-0001")).toEqual({ kind: "unreachable" });
    expect(await deleteSecret("rpc_1", "A")).toEqual({ kind: "unreachable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200 })),
    );
    expect(await listSecrets("rpc_1")).toEqual({ kind: "unreachable" });
  });
});

describe("parseSecretRequestsResponse", () => {
  const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  const entry = { name: "DATABASE_URL", saved: true, isNew: false };

  // A connection that must be reconnected is its own answer, whether it comes as 403 or 409.
  it.each([409, 403, 502])(
    "reads github_reverification_required at %i as reconnect GitHub",
    (status) => {
      expect(
        parseSecretRequestsResponse(status, {
          error: "github_reverification_required",
          reason: "installation_missing",
        }),
      ).toEqual({ kind: "reconnect_github" });
    },
  );

  it("reads each state with the commit it was read at", () => {
    expect(parseSecretRequestsResponse(200, { baseSha: SHA, state: "none" })).toEqual({
      kind: "none",
      baseSha: SHA,
    });
    expect(
      parseSecretRequestsResponse(200, {
        baseSha: SHA,
        state: "declared",
        required: [{ ...entry, value: "fake-leaked-value" }],
        optional: [],
      }),
    ).toEqual({ kind: "declared", baseSha: SHA, required: [entry], optional: [] });
    expect(
      parseSecretRequestsResponse(200, { baseSha: SHA, state: "invalid", line: 3, reason: "no" }),
    ).toEqual({ kind: "invalid", baseSha: SHA, line: 3, reason: "no" });
    expect(parseSecretRequestsResponse(403, null)).toEqual({ kind: "denied" });
  });

  it.each([
    [502, { error: "unreadable" }],
    [200, null],
    [200, { state: "none" }],
    [200, { baseSha: SHA, state: "invalid", line: "3", reason: "no" }],
    [200, { baseSha: SHA, state: "invalid", line: 3 }],
    [200, { baseSha: SHA, state: "declared", required: [entry] }],
    [200, { baseSha: SHA, state: "declared", required: "x", optional: [] }],
    [200, { baseSha: SHA, state: "declared", required: [null], optional: [] }],
    [200, { baseSha: SHA, state: "declared", required: [{ ...entry, name: 1 }], optional: [] }],
    [200, { baseSha: SHA, state: "declared", required: [{ ...entry, saved: "y" }], optional: [] }],
    [200, { baseSha: SHA, state: "declared", required: [{ ...entry, isNew: 0 }], optional: [] }],
    [200, { baseSha: SHA, state: "something_else", required: [], optional: [] }],
  ])("reads %i %j as unreadable, never as asking for nothing", (status, body) => {
    expect(parseSecretRequestsResponse(status, body)).toEqual({ kind: "unreadable" });
  });

  it("reads a chosen branch that is gone as its own answer", () => {
    expect(
      parseSecretRequestsResponse(409, { error: "branch_refused", reason: "missing" }),
    ).toEqual({ kind: "branch_missing" });
  });

  it("asks by repository and answers unreadable when the network fails", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ baseSha: SHA, state: "none" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSecretRequests("rpc 1")).toEqual({ kind: "none", baseSha: SHA });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/repositories/rpc%201/secret-requests");
    await getSecretRequests("rpc_1", "release/1.4");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/repositories/rpc_1/secret-requests?branch=release%2F1.4",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getSecretRequests("rpc_1")).toEqual({ kind: "unreadable" });
  });
});
