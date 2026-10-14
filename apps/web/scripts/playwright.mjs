#!/usr/bin/env node
/**
 * Runs Playwright with this package's config and the caller's arguments,
 * dropping every bare `--`. pnpm keeps a `--` through its layers, and
 * Playwright reads `-- --workers=2` as a file filter, so without this the
 * worker count was silently ignored.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function playwrightArgs(argv) {
  return ["test", "--config", "e2e/playwright.config.ts", ...argv.filter((arg) => arg !== "--")];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const child = spawn(process.execPath, [cli, ...playwrightArgs(process.argv.slice(2))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}
