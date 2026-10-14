// The sandbox row once OpenCode passes its health check (`runtime.ready`,
// record 04). Lives outside the spec because Biome forbids exports from tests.

import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";

export async function expectRuntimeReady(row: Locator): Promise<void> {
  await expect(row).toContainText("opencode 1.18.30 is ready", { timeout: 90_000 });
}
