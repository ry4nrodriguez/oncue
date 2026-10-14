/**
 * Playwright's global setup: stop the run when the dev server on this port
 * slot's app port was started from a different checkout.
 * `reuseExistingServer` would otherwise test another worktree's code; the dev
 * harness reports its directory at `GET /dev/checkout`.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type SlotPorts, slotPorts, stopCommand } from "../../../scripts/dev-ports.mjs";
import { appOrigin } from "./app-origin";

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
}

/**
 * What to do about a foreign server: move to a free slot, or stop it. The stop
 * command names only this slot's ports, never another slot's stack.
 */
export function foreignServerAdvice(ports: SlotPorts): string {
  return `Use a free slot (ONCUE_PORT_SLOT=N, 0 to 19) or stop it (${stopCommand(ports)}) and rerun.`;
}

export default async function sameCheckout(): Promise<void> {
  const ports = slotPorts();
  const origin = await appOrigin();
  const expected = canonical(fileURLToPath(new URL("..", import.meta.url)));
  const answer = await fetch(`${origin}/dev/checkout`).catch(() => null);
  const body = answer?.ok
    ? ((await answer.json().catch(() => null)) as { root?: unknown } | null)
    : null;
  const root = typeof body?.root === "string" ? canonical(body.root) : null;
  if (root === expected) {
    return;
  }
  const advice = foreignServerAdvice(ports);
  throw new Error(
    root === null
      ? `the server on ${origin} (port slot ${ports.slot}) does not answer /dev/checkout, so it is not this checkout's dev server (${expected}). ${advice}`
      : `the server on ${origin} (port slot ${ports.slot}) was started from ${root}, not this checkout (${expected}); the lanes would test the other checkout's code. ${advice}`,
  );
}
