import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInspectRequestPath } from "./dev-inspect";

const ROUTE = "dev/inspect";

function workerSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...workerSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("isInspectRequestPath", () => {
  it("answers the inspector route with or without a trailing slash or a query", () => {
    expect(isInspectRequestPath(`/${ROUTE}`)).toBe(true);
    expect(isInspectRequestPath(`/${ROUTE}/`)).toBe(true);
    expect(isInspectRequestPath(`/${ROUTE}?session=1`)).toBe(true);
  });

  it("answers nothing else", () => {
    expect(isInspectRequestPath(undefined)).toBe(false);
    expect(isInspectRequestPath("/")).toBe(false);
    expect(isInspectRequestPath(`/${ROUTE}/deeper`)).toBe(false);
    expect(isInspectRequestPath("/dev/home")).toBe(false);
  });
});

describe("the worker source", () => {
  // `scripts/check-no-dev-inspect.mjs` searches the built bundle, which keeps
  // doc comments, so even a comment naming the route fails the build. This
  // catches it in `pnpm check` first.
  it("never names the inspector route, not even in a comment", () => {
    // The web project runs under jsdom, where `import.meta.url` is an http
    // URL; Vitest runs each package's suite from the package's own directory.
    const files = workerSourceFiles(join(process.cwd(), "worker"));
    // A scan that found nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(ROUTE));
    expect(offenders).toEqual([]);
  });
});
