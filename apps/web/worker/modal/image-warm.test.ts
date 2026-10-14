import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deriveKeyring, type Keyring } from "../broker/envelope";
import {
  CONTROLLER_ORIGIN,
  MODAL_CREDENTIAL,
  REAL_KEYRING_VALUE,
  seedModalConnection,
} from "../test/session-world";
import { type ImageWarmDeps, WARM_RETRY_MS, WARM_STALE_MS, warmWorkspaceImage } from "./image-warm";

const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");

async function keyring(): Promise<Keyring<"credential">> {
  const derived = await deriveKeyring(REAL_KEYRING_VALUE, "credential");
  if (derived.kind !== "ok") {
    throw new Error("the test runner always configures a keyring");
  }
  return derived.keyring;
}

interface Asked {
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
}

/** The controller, answering `prepareImage` with `answer` and recording each ask. */
function controller(answer: () => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  asked: Asked[];
} {
  const asked: Asked[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push({ url, body: String(init.body), headers: new Headers(init.headers) });
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

function building(): Response {
  return Response.json({ kind: "ok", value: { state: "building" } });
}

async function deps(
  fetchImpl: typeof fetch,
  overrides: Partial<ImageWarmDeps> = {},
): Promise<ImageWarmDeps> {
  return {
    db: env.DB,
    keyring: await keyring(),
    settings: { origin: CONTROLLER_ORIGIN, controllerToken: "controller-token" },
    fetchImpl,
    release: "rel-2",
    nowMs: NOW_MS,
    ...overrides,
  };
}

async function warmRow(
  workspaceId: string,
): Promise<{ image_warmed_release: string | null; image_warmed_at: string | null } | null> {
  return env.DB.prepare(
    "SELECT image_warmed_release, image_warmed_at FROM modal_connection WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first();
}

async function setWarm(workspaceId: string, release: string | null, atMs: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE modal_connection SET image_warmed_release = ?, image_warmed_at = ? WHERE workspace_id = ?",
  )
    .bind(release, new Date(atMs).toISOString(), workspaceId)
    .run();
}

describe("warmWorkspaceImage", () => {
  it("asks a workspace never asked before, with its own credential, and records the release", async () => {
    await seedModalConnection("ws_warm_new");
    const { fetchImpl, asked } = controller(building);

    const outcome = await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_new", false);

    expect(outcome).toBe("requested");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(`${CONTROLLER_ORIGIN}/v1/prepareImage`);
    // Fire and forget: the controller is asked to wait for nothing.
    expect(JSON.parse(asked[0]?.body ?? "{}")).toEqual({ waitMs: 0 });
    expect(asked[0]?.headers.get("x-oncue-modal-token-id")).toBe(MODAL_CREDENTIAL.tokenId);
    expect(asked[0]?.body).not.toContain(MODAL_CREDENTIAL.tokenSecret);
    expect(await warmRow("ws_warm_new")).toEqual({
      image_warmed_release: "rel-2",
      image_warmed_at: new Date(NOW_MS).toISOString(),
    });
  });

  it("does nothing for a workspace already asked under this release", async () => {
    await seedModalConnection("ws_warm_current");
    await setWarm("ws_warm_current", "rel-2", NOW_MS - 60_000);
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_current", false)).toBe(
      "current",
    );
    expect(asked).toEqual([]);
  });

  it("asks again after a release", async () => {
    await seedModalConnection("ws_warm_release");
    await setWarm("ws_warm_release", "rel-1", NOW_MS - WARM_RETRY_MS - 1);
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_release", false)).toBe(
      "requested",
    );
    expect(asked).toHaveLength(1);
    expect((await warmRow("ws_warm_release"))?.image_warmed_release).toBe("rel-2");
  });

  it("waits out the retry interval after a recent ask, even for a new release", async () => {
    await seedModalConnection("ws_warm_recent");
    await setWarm("ws_warm_recent", "rel-1", NOW_MS - 60_000);
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_recent", false)).toBe(
      "current",
    );
    expect(asked).toEqual([]);
  });

  it("asks again once the last ask is old, for a controller deployed without a release", async () => {
    await seedModalConnection("ws_warm_stale");
    await setWarm("ws_warm_stale", "rel-2", NOW_MS - WARM_STALE_MS - 1);
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_stale", false)).toBe(
      "requested",
    );
    expect(asked).toHaveLength(1);
  });

  it("asks at once when forced, as a new connection is", async () => {
    await seedModalConnection("ws_warm_forced");
    await setWarm("ws_warm_forced", "rel-2", NOW_MS - 1_000);
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_forced", true)).toBe(
      "requested",
    );
    expect(asked).toHaveLength(1);
  });

  it("does nothing for a workspace with no connection, or one that stopped working", async () => {
    await seedModalConnection("ws_warm_invalid");
    await env.DB.prepare("UPDATE modal_connection SET status = 'invalid' WHERE workspace_id = ?")
      .bind("ws_warm_invalid")
      .run();
    const { fetchImpl, asked } = controller(building);

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_none", true)).toBe("current");
    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_invalid", true)).toBe(
      "current",
    );
    expect(asked).toEqual([]);
  });

  it("leaves the row to be asked again later when the controller refuses", async () => {
    await seedModalConnection("ws_warm_refused");
    const { fetchImpl } = controller(() =>
      Response.json(
        { kind: "error", category: "unknown", message: "down", retryable: true },
        { status: 500 },
      ),
    );

    expect(await warmWorkspaceImage(await deps(fetchImpl), "ws_warm_refused", false)).toBe(
      "failed",
    );
    expect(await warmRow("ws_warm_refused")).toEqual({
      image_warmed_release: null,
      image_warmed_at: new Date(NOW_MS).toISOString(),
    });
    const later = controller(building);
    expect(await warmWorkspaceImage(await deps(later.fetchImpl), "ws_warm_refused", false)).toBe(
      "current",
    );
    expect(
      await warmWorkspaceImage(
        await deps(later.fetchImpl, { nowMs: NOW_MS + WARM_RETRY_MS + 1 }),
        "ws_warm_refused",
        false,
      ),
    ).toBe("requested");
  });

  it("leaves the row to be asked again when the credential will not open", async () => {
    await seedModalConnection("ws_warm_sealed");
    const other = await deriveKeyring(`1:${"A".repeat(43)}`, "credential");
    if (other.kind !== "ok") {
      throw new Error("expected a keyring");
    }
    const { fetchImpl, asked } = controller(building);

    expect(
      await warmWorkspaceImage(
        await deps(fetchImpl, { keyring: other.keyring }),
        "ws_warm_sealed",
        false,
      ),
    ).toBe("no_credential");
    expect(asked).toEqual([]);
    expect((await warmRow("ws_warm_sealed"))?.image_warmed_release).toBeNull();
  });
});
