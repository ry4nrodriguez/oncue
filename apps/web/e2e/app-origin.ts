/**
 * The origin the dev server answers on. The browser and Node's `fetch` resolve
 * `localhost` to different address families, so this probes each spelling and
 * caches the one that works. Tests use it for requests and for the Clerk
 * token's `azp` claim, which must match what the Worker sees.
 */

import { originsFor, type SlotPorts, slotPorts } from "../../../scripts/dev-ports.mjs";

/** Every spelling of the slot's app origin, `localhost` first. */
export function appOriginCandidates(ports: SlotPorts): readonly string[] {
  return [
    `http://localhost:${ports.app}`,
    `http://127.0.0.1:${ports.app}`,
    `http://[::1]:${ports.app}`,
  ];
}

/** The slot's app origin as the browser spells it, before `appOrigin()` has probed which answers. */
export const DEFAULT_APP_ORIGIN = originsFor(slotPorts()).app;

let resolved: string | null = null;

export async function appOrigin(): Promise<string> {
  if (resolved !== null) {
    return resolved;
  }
  const failures: string[] = [];
  for (const candidate of appOriginCandidates(slotPorts())) {
    try {
      const answer = await fetch(`${candidate}/api/health`);
      if (answer.ok) {
        resolved = candidate;
        return candidate;
      }
      failures.push(`${candidate} answered ${answer.status}`);
    } catch (error) {
      failures.push(`${candidate} ${String(error)}`);
    }
  }
  throw new Error(
    `no dev server answered /api/health on any known address: ${failures.join("; ")}`,
  );
}
