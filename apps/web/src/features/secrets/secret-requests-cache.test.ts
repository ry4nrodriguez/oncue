import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetSecretRequests, prefetchSecretRequests } from "./secret-requests-cache";

afterEach(() => {
  forgetSecretRequests();
  vi.unstubAllGlobals();
});

describe("prefetchSecretRequests", () => {
  it("asks once per repository while the answer is fresh, drops an unreadable one, and asks again once stale", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 503 })
          : Response.json({ baseSha: "a".repeat(40), state: "none" });
      }),
    );
    expect((await prefetchSecretRequests("rc_1", null, 0)).kind).toBe("unreadable");
    // Not kept: the next ask goes out again and gets the real answer.
    expect((await prefetchSecretRequests("rc_1", null, 1)).kind).toBe("none");
    expect((await prefetchSecretRequests("rc_1", null, 2)).kind).toBe("none");
    expect(calls).toBe(2);
    // Stale after five minutes: asked again.
    await prefetchSecretRequests("rc_1", null, 5 * 60 * 1000 + 3);
    expect(calls).toBe(3);
    // Forgotten: asked again at once.
    forgetSecretRequests("rc_1");
    await prefetchSecretRequests("rc_1", null, 4);
    expect(calls).toBe(4);
  });

  it("does not keep an answer that asks to reconnect GitHub, so the read after reconnecting is fresh", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? Response.json(
              { error: "github_reverification_required", reason: "installation_missing" },
              { status: 409 },
            )
          : Response.json({ baseSha: "a".repeat(40), state: "none" });
      }),
    );
    expect((await prefetchSecretRequests("rc_2", null, 0)).kind).toBe("reconnect_github");
    expect((await prefetchSecretRequests("rc_2", null, 1)).kind).toBe("none");
    expect(calls).toBe(2);
  });

  it("keeps each branch's answer apart, reads at the branch asked for, and forgets every branch of a repository", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes("branch=gone")
          ? Response.json({ error: "branch_refused", reason: "missing" }, { status: 409 })
          : Response.json({ baseSha: "a".repeat(40), state: "none" });
      }),
    );
    await prefetchSecretRequests("rc_3", null, 0);
    await prefetchSecretRequests("rc_3", "release/1.4", 0);
    await prefetchSecretRequests("rc_3", "release/1.4", 1);
    expect(urls).toEqual([
      "/api/repositories/rc_3/secret-requests",
      "/api/repositories/rc_3/secret-requests?branch=release%2F1.4",
    ]);
    // A branch that is gone is not kept: the next ask may find it restored.
    expect((await prefetchSecretRequests("rc_3", "gone", 2)).kind).toBe("branch_missing");
    await prefetchSecretRequests("rc_3", "gone", 3);
    expect(urls).toHaveLength(4);
    forgetSecretRequests("rc_3");
    await prefetchSecretRequests("rc_3", "release/1.4", 4);
    expect(urls).toHaveLength(5);
  });
});
