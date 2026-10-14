import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listRepositories,
  parseInstallUrlResponse,
  parseListRepositoriesResponse,
  parseUpdateRepositoryResponse,
  removeRepository,
  requestGitHubInstallUrl,
  restoreRepository,
} from "./repositories";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROW = {
  repositoryConnectionId: "rc_1",
  fullName: "acme/oncue",
  defaultBranch: "main",
  status: "verified",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("parseListRepositoriesResponse", () => {
  it("parses an empty list", () => {
    expect(parseListRepositoriesResponse(200, { repositories: [] })).toEqual({
      kind: "listed",
      repositories: [],
    });
  });

  it("parses a populated list, defaulting a row's removal to null", () => {
    expect(parseListRepositoriesResponse(200, { repositories: [ROW] })).toEqual({
      kind: "listed",
      repositories: [{ ...ROW, removedAt: null }],
    });
    expect(
      parseListRepositoriesResponse(200, {
        repositories: [{ ...ROW, removedAt: "2026-09-23T00:00:00.000Z" }],
      }),
    ).toMatchObject({ repositories: [{ removedAt: "2026-09-23T00:00:00.000Z" }] });
  });

  it("treats a 200 body without a repositories array as unreachable", () => {
    expect(parseListRepositoriesResponse(200, {})).toEqual({ kind: "unreachable" });
    expect(parseListRepositoriesResponse(200, null)).toEqual({ kind: "unreachable" });
  });

  it("treats a row missing a field as making the whole list unreachable", () => {
    const { status: _status, ...withoutStatus } = ROW;
    expect(parseListRepositoriesResponse(200, { repositories: [withoutStatus] })).toEqual({
      kind: "unreachable",
    });
  });

  it("treats a row with an unrecognized status as making the whole list unreachable", () => {
    expect(
      parseListRepositoriesResponse(200, {
        repositories: [{ ...ROW, status: "made_up" }],
      }),
    ).toEqual({ kind: "unreachable" });
  });

  it("treats a non-string field as making the whole list unreachable", () => {
    expect(parseListRepositoriesResponse(200, { repositories: [{ ...ROW, fullName: 7 }] })).toEqual(
      { kind: "unreachable" },
    );
    expect(
      parseListRepositoriesResponse(200, {
        repositories: [{ ...ROW, repositoryConnectionId: 7 }],
      }),
    ).toEqual({ kind: "unreachable" });
    expect(
      parseListRepositoriesResponse(200, { repositories: [{ ...ROW, defaultBranch: 7 }] }),
    ).toEqual({ kind: "unreachable" });
    expect(
      parseListRepositoriesResponse(200, { repositories: [{ ...ROW, createdAt: 7 }] }),
    ).toEqual({ kind: "unreachable" });
  });

  it("treats a non-record row as making the whole list unreachable", () => {
    expect(parseListRepositoriesResponse(200, { repositories: ["not a row"] })).toEqual({
      kind: "unreachable",
    });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseListRepositoriesResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseListRepositoriesResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats any other status as unreachable", () => {
    expect(parseListRepositoriesResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("parseInstallUrlResponse", () => {
  it("treats 201 with a string installUrl as minted", () => {
    expect(parseInstallUrlResponse(201, { installUrl: "https://github.com/apps/oncue" })).toEqual({
      kind: "minted",
      installUrl: "https://github.com/apps/oncue",
    });
  });

  it("treats a 201 body without a string installUrl as unreachable", () => {
    expect(parseInstallUrlResponse(201, {})).toEqual({ kind: "unreachable" });
    expect(parseInstallUrlResponse(201, { installUrl: 7 })).toEqual({ kind: "unreachable" });
    expect(parseInstallUrlResponse(201, null)).toEqual({ kind: "unreachable" });
  });

  it("treats 401 and 403 as denied", () => {
    expect(parseInstallUrlResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseInstallUrlResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("treats 503 as unconfigured", () => {
    expect(parseInstallUrlResponse(503, { error: "github_unconfigured" })).toEqual({
      kind: "unconfigured",
    });
  });

  it("treats any other status as unreachable", () => {
    expect(parseInstallUrlResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("listRepositories", () => {
  it("GETs the collection and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ repositories: [{ ...ROW, removedAt: null }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await listRepositories()).toEqual({
      kind: "listed",
      repositories: [{ ...ROW, removedAt: null }],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories");
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await listRepositories()).toEqual({ kind: "unreachable" });
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

    expect(await listRepositories()).toEqual({ kind: "unreachable" });
  });
});

describe("requestGitHubInstallUrl", () => {
  it("POSTs to the install-url endpoint and returns the minted URL", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ installUrl: "https://github.com/apps/oncue" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestGitHubInstallUrl();

    expect(result).toEqual({ kind: "minted", installUrl: "https://github.com/apps/oncue" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/github/install-url");
    expect(init?.method).toBe("POST");
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(await requestGitHubInstallUrl()).toEqual({ kind: "unreachable" });
  });
});

describe("parseUpdateRepositoryResponse", () => {
  it("treats 200 with a row as updated, 404 as not found, 401 and 403 as denied, the rest as unreachable", () => {
    expect(parseUpdateRepositoryResponse(200, { repository: ROW })).toEqual({
      kind: "updated",
      repository: { ...ROW, removedAt: null },
    });
    expect(parseUpdateRepositoryResponse(200, {})).toEqual({ kind: "unreachable" });
    expect(parseUpdateRepositoryResponse(404, null)).toEqual({ kind: "not_found" });
    expect(parseUpdateRepositoryResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseUpdateRepositoryResponse(403, null)).toEqual({ kind: "denied" });
    expect(parseUpdateRepositoryResponse(500, null)).toEqual({ kind: "unreachable" });
  });
});

describe("removeRepository and restoreRepository", () => {
  it("DELETEs the repository and POSTs its restore, returning the parsed row", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ repository: ROW }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await removeRepository("rc_1")).toEqual({
      kind: "updated",
      repository: { ...ROW, removedAt: null },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories/rc_1", { method: "DELETE" });
    expect(await restoreRepository("rc_1")).toMatchObject({ kind: "updated" });
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories/rc_1/restore", { method: "POST" });
  });

  it("treats a network failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await removeRepository("rc_1")).toEqual({ kind: "unreachable" });
    expect(await restoreRepository("rc_1")).toEqual({ kind: "unreachable" });
  });
});
