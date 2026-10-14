import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { atMostOne, exactlyOne } from "./sql";

describe("atMostOne", () => {
  it("returns found for a row that exists", async () => {
    const statement = env.DB.prepare("SELECT id FROM platform_control WHERE id = 1");
    const result = await atMostOne<{ id: number }>(statement);
    expect(result).toEqual({ kind: "found", row: { id: 1 } });
  });

  it("returns absent when no row matches", async () => {
    const statement = env.DB.prepare("SELECT id FROM platform_control WHERE id = 2");
    const result = await atMostOne<{ id: number }>(statement);
    expect(result).toEqual({ kind: "absent" });
  });
});

describe("exactlyOne", () => {
  it("returns the row when it exists", async () => {
    const statement = env.DB.prepare("SELECT id FROM platform_control WHERE id = 1");
    const row = await exactlyOne<{ id: number }>(statement, "expected the platform_control row");
    expect(row).toEqual({ id: 1 });
  });

  it("throws the supplied message when no row matches", async () => {
    const statement = env.DB.prepare("SELECT id FROM platform_control WHERE id = 2");
    await expect(
      exactlyOne<{ id: number }>(statement, "expected the platform_control row"),
    ).rejects.toThrow("expected the platform_control row");
  });
});
