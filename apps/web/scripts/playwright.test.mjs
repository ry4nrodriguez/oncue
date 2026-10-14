import { describe, expect, it } from "vitest";
import { playwrightArgs } from "./playwright.mjs";

describe("playwrightArgs", () => {
  const base = ["test", "--config", "e2e/playwright.config.ts"];

  it("passes a worker count through whether or not pnpm kept a bare --", () => {
    expect(playwrightArgs(["--", "--workers=2"])).toEqual([...base, "--workers=2"]);
    expect(playwrightArgs(["--workers=2"])).toEqual([...base, "--workers=2"]);
    expect(playwrightArgs(["--", "--", "--workers=2", "e2e/github.spec.ts"])).toEqual([
      ...base,
      "--workers=2",
      "e2e/github.spec.ts",
    ]);
  });

  it("runs the whole suite with the config when given nothing", () => {
    expect(playwrightArgs([])).toEqual(base);
  });

  it("keeps a value that only contains dashes", () => {
    expect(playwrightArgs(["--grep", "a -- b"])).toEqual([...base, "--grep", "a -- b"]);
  });
});
