/**
 * The local stack's ports, by slot. One machine can run several copies of the
 * stack side by side (one per worktree), each on its own slot:
 *
 *   ONCUE_PORT_SLOT=N   N from 0 to 19, default 0
 *
 *   app (Vite and the Worker)          5173 + 100·N
 *   sandbox controller (double or      5197 + 100·N
 *     `pnpm controller`)
 *   GitHub double                      5198 + 100·N
 *   model provider double              5199 + 100·N
 *   Worker inspector                   9229 + N
 *
 * Slot 0 is the original fixed layout. Every script, config, and test that
 * needs a port reads it from here, so no two places can disagree.
 */

export const PORT_SLOT_ENV = "ONCUE_PORT_SLOT";
export const MAX_PORT_SLOT = 19;

const SLOT_STRIDE = 100;
const BASE = { app: 5173, controller: 5197, github: 5198, provider: 5199 };
const INSPECTOR_BASE = 9229;

/**
 * Reads a slot from its raw environment value. Unset or empty is slot 0;
 * anything but a whole number from 0 to 19 is refused, because a typo that
 * silently fell back to slot 0 would collide with whoever is on slot 0.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parsePortSlot(raw) {
  if (raw === undefined || raw.trim() === "") {
    return 0;
  }
  const text = raw.trim();
  const slot = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(slot) || slot > MAX_PORT_SLOT) {
    throw new Error(
      `${PORT_SLOT_ENV} must be a whole number from 0 to ${MAX_PORT_SLOT}, got "${raw}". Slot N serves the app on port ${BASE.app} + 100·N.`,
    );
  }
  return slot;
}

/**
 * @param {number} slot
 * @returns {import("./dev-ports.d.mts").SlotPorts}
 */
export function portsForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_PORT_SLOT) {
    throw new Error(`port slot must be a whole number from 0 to ${MAX_PORT_SLOT}, got ${slot}`);
  }
  const shift = slot * SLOT_STRIDE;
  return {
    slot,
    app: BASE.app + shift,
    controller: BASE.controller + shift,
    github: BASE.github + shift,
    provider: BASE.provider + shift,
    inspector: INSPECTOR_BASE + slot,
  };
}

/**
 * The browser and the Worker meet on `localhost`; the doubles listen on the
 * IPv4 loopback only, so their origins name it.
 *
 * @param {import("./dev-ports.d.mts").SlotPorts} ports
 * @returns {import("./dev-ports.d.mts").SlotOrigins}
 */
export function originsFor(ports) {
  return {
    app: `http://localhost:${ports.app}`,
    controller: `http://127.0.0.1:${ports.controller}`,
    github: `http://127.0.0.1:${ports.github}`,
    provider: `http://127.0.0.1:${ports.provider}`,
  };
}

/**
 * The slot this process runs on, from `ONCUE_PORT_SLOT`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {import("./dev-ports.d.mts").SlotPorts}
 */
export function slotPorts(env = process.env) {
  return portsForSlot(parsePortSlot(env[PORT_SLOT_ENV]));
}

/**
 * The command that frees this slot's four stack ports. It names only this
 * slot's ports, so it never touches a stack another checkout runs on its own.
 *
 * @param {import("./dev-ports.d.mts").SlotPorts} ports
 * @returns {string}
 */
export function stopCommand(ports) {
  return `lsof -ti:${ports.app},${ports.controller},${ports.github},${ports.provider} | xargs kill`;
}

/** Each `.dev.vars` key that names a local double or controller, with the port it must use. */
const LOCAL_ORIGIN_KEYS = [
  ["ONCUE_GITHUB_API_ORIGIN", "github"],
  ["ONCUE_PROVIDER_DOUBLE_ORIGIN", "provider"],
  ["ONCUE_SANDBOX_CONTROLLER_ORIGIN", "controller"],
];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The `.dev.vars` lines that point this slot's Worker at a loopback port of a
 * different slot. The dev server reads `.dev.vars` once at start, and a file
 * composed for another slot would send this stack's traffic to the doubles or
 * controller another checkout is running. Remote origins are left alone.
 *
 * @param {string} devVarsText the file's contents
 * @param {import("./dev-ports.d.mts").SlotPorts} ports
 * @returns {string[]} one plain sentence per mismatch
 */
export function foreignSlotOrigins(devVarsText, ports) {
  const values = new Map();
  for (const line of devVarsText.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) {
      values.set(line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, ""));
    }
  }
  const problems = [];
  for (const [key, role] of LOCAL_ORIGIN_KEYS) {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") {
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      continue;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (port !== ports[role]) {
      problems.push(`${key} is ${value}, but slot ${ports.slot} uses port ${ports[role]}`);
    }
  }
  return problems;
}

/**
 * For a root script's top level: the slot, or a one-line error and exit 1
 * instead of a stack trace.
 *
 * @param {string} tag the script's log prefix, such as "dev"
 * @returns {import("./dev-ports.d.mts").SlotPorts}
 */
export function slotPortsOrExit(tag) {
  try {
    return slotPorts();
  } catch (error) {
    console.error(`[${tag}] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
