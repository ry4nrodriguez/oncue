import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROLLER_ORIGIN, seedModalConnection } from "../test/session-world";
import { startImageWarm } from "./image-warm";

function configured(overrides: Record<string, string> = {}): Env {
  return {
    ...env,
    ONCUE_SANDBOX_CONTROLLER_ORIGIN: CONTROLLER_ORIGIN,
    ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
    ...overrides,
  } as unknown as Env;
}

function answering(answer: () => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  asked: string[];
} {
  const asked: string[] = [];
  const fetchImpl = (async (input: string) => {
    asked.push(input);
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

function building(): Response {
  return Response.json({ kind: "ok", value: { state: "building" } });
}

const logged: string[] = [];

function captureLog(): void {
  logged.length = 0;
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startImageWarm", () => {
  it("does nothing without a controller", async () => {
    const { fetchImpl, asked } = answering(building);

    await startImageWarm(env, "ws_route_warm_none", true, fetchImpl);

    expect(asked).toEqual([]);
  });

  it("does nothing without a keyring", async () => {
    await seedModalConnection("ws_route_warm_keyring");
    const { fetchImpl, asked } = answering(building);

    await startImageWarm(
      configured({ ONCUE_BROKER_KEYRING: "" }),
      "ws_route_warm_keyring",
      true,
      fetchImpl,
    );

    expect(asked).toEqual([]);
  });

  it("asks once and logs the ask, then stays quiet while the workspace is current", async () => {
    await seedModalConnection("ws_route_warm_ok");
    const { fetchImpl, asked } = answering(building);
    captureLog();

    await startImageWarm(configured(), "ws_route_warm_ok", false, fetchImpl);
    await startImageWarm(configured(), "ws_route_warm_ok", false, fetchImpl);

    expect(asked).toEqual([`${CONTROLLER_ORIGIN}/v1/prepareImage`]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toMatchObject({
      operation: "modal.image_warm",
      result: "requested",
      severity: "info",
    });
  });

  it("logs a refusal as a warning", async () => {
    await seedModalConnection("ws_route_warm_refused");
    const { fetchImpl } = answering(() =>
      Response.json(
        { kind: "error", category: "unknown", message: "down", retryable: true },
        { status: 500 },
      ),
    );
    captureLog();

    await startImageWarm(configured(), "ws_route_warm_refused", true, fetchImpl);

    expect(JSON.parse(logged[0] as string)).toMatchObject({ result: "failed", severity: "warn" });
  });

  it("never lets a fault reach the request it rode on", async () => {
    captureLog();
    const broken = configured();
    (broken as unknown as { DB: unknown }).DB = {
      prepare: () => {
        throw new Error("database gone");
      },
    };

    await expect(
      startImageWarm(broken, "ws_route_warm_throws", true, answering(building).fetchImpl),
    ).resolves.toBeUndefined();
    expect(JSON.parse(logged[0] as string)).toMatchObject({ result: "threw" });
    expect(logged[0]).not.toContain("database gone");
  });
});
