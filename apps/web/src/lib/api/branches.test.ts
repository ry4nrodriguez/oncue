import { afterEach, describe, expect, it, vi } from "vitest";
import { listBranches, parseListBranchesResponse } from "./branches";

afterEach(() => {
  vi.unstubAllGlobals();
});

const LISTED = {
  defaultBranch: "main",
  branches: [
    { name: "main", protected: true, default: true },
    { name: "feature/login", protected: false, default: false },
  ],
  truncated: false,
};

describe("parseListBranchesResponse", () => {
  it("reads the listing", () => {
    expect(parseListBranchesResponse(200, LISTED)).toEqual({ kind: "listed", ...LISTED });
    expect(parseListBranchesResponse(200, { ...LISTED, truncated: true })).toMatchObject({
      truncated: true,
    });
    // An older body with no flag is not truncated.
    const { truncated: _dropped, ...withoutFlag } = LISTED;
    expect(parseListBranchesResponse(200, withoutFlag)).toMatchObject({ truncated: false });
  });

  it("reads a signed-out caller, a connection to reconnect, and anything else as unreachable", () => {
    expect(parseListBranchesResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseListBranchesResponse(403, {})).toEqual({ kind: "denied" });
    expect(parseListBranchesResponse(409, { error: "github_reverification_required" })).toEqual({
      kind: "reconnect_github",
    });
    expect(parseListBranchesResponse(409, { error: "other" })).toEqual({ kind: "unreachable" });
    expect(parseListBranchesResponse(502, { error: "github_unreachable" })).toEqual({
      kind: "unreachable",
    });
    expect(parseListBranchesResponse(200, null)).toEqual({ kind: "unreachable" });
    expect(parseListBranchesResponse(200, { ...LISTED, defaultBranch: 7 })).toEqual({
      kind: "unreachable",
    });
    expect(parseListBranchesResponse(200, { ...LISTED, branches: "no" })).toEqual({
      kind: "unreachable",
    });
    expect(
      parseListBranchesResponse(200, { ...LISTED, branches: [{ name: "x", protected: "no" }] }),
    ).toEqual({ kind: "unreachable" });
    expect(parseListBranchesResponse(200, { ...LISTED, branches: [null] })).toEqual({
      kind: "unreachable",
    });
  });
});

describe("listBranches", () => {
  it("asks for the repository's branches, with a trimmed search only when there is one", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json(LISTED));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listBranches("rc 1", "  ")).toEqual({ kind: "listed", ...LISTED });
    await listBranches("rc_1", " feature/lo ");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/repositories/rc%201/branches",
      "/api/repositories/rc_1/branches?q=feature%2Flo",
    ]);
  });

  it("reads a failed fetch or a body that is not JSON as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    expect(await listBranches("rc_1", "")).toEqual({ kind: "unreachable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 200 })),
    );
    expect(await listBranches("rc_1", "")).toEqual({ kind: "unreachable" });
  });
});
