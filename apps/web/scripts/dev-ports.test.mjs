// @vitest-environment node
// The root `scripts/` directory has no test runner of its own, so the port
// slot module and the controller script's plan are tested here, beside the
// other script tests `pnpm check` runs.
import { describe, expect, it } from "vitest";
import { controllerPlan } from "../../../scripts/controller.mjs";
import {
  foreignSlotOrigins,
  MAX_PORT_SLOT,
  originsFor,
  PORT_SLOT_ENV,
  parsePortSlot,
  portsForSlot,
  slotPorts,
  stopCommand,
} from "../../../scripts/dev-ports.mjs";
import { laneOriginVars } from "../e2e/setup-local-auth.mjs";

const ALL_SLOTS = Array.from({ length: MAX_PORT_SLOT + 1 }, (_, slot) => slot);
const STACK_ROLES = ["app", "controller", "github", "provider", "inspector"];

describe("slot 0", () => {
  it("is the fixed layout the stack had before slots existed", () => {
    expect(portsForSlot(0)).toEqual({
      slot: 0,
      app: 5173,
      controller: 5197,
      github: 5198,
      provider: 5199,
      inspector: 9229,
    });
    expect(originsFor(portsForSlot(0))).toEqual({
      app: "http://localhost:5173",
      controller: "http://127.0.0.1:5197",
      github: "http://127.0.0.1:5198",
      provider: "http://127.0.0.1:5199",
    });
  });

  it("is what an unset or empty ONCUE_PORT_SLOT means", () => {
    expect(slotPorts({})).toEqual(portsForSlot(0));
    expect(slotPorts({ [PORT_SLOT_ENV]: "" })).toEqual(portsForSlot(0));
    expect(slotPorts({ [PORT_SLOT_ENV]: "  " })).toEqual(portsForSlot(0));
  });

  it("writes the same three double origins into .dev.vars.lane as before", () => {
    expect(laneOriginVars(portsForSlot(0))).toEqual({
      ONCUE_PROVIDER_DOUBLE_ORIGIN: "http://127.0.0.1:5199",
      ONCUE_GITHUB_API_ORIGIN: "http://127.0.0.1:5198",
      ONCUE_SANDBOX_CONTROLLER_ORIGIN: "http://127.0.0.1:5197",
    });
  });

  it("gives the controller the same uvicorn port and tunnel target as before", () => {
    expect(controllerPlan(portsForSlot(0))).toEqual({
      uvicornArgs: [
        "run",
        "--frozen",
        "uvicorn",
        "app:api",
        "--host",
        "127.0.0.1",
        "--port",
        "5197",
      ],
      tunnelArgs: ["tunnel", "--url", "http://localhost:5173"],
    });
  });

  it("stops with the same command as before", () => {
    expect(stopCommand(portsForSlot(0))).toBe("lsof -ti:5173,5197,5198,5199 | xargs kill");
  });
});

describe("every slot", () => {
  it("follows the formula: 100 apart for the stack, one apart for the inspector", () => {
    for (const slot of ALL_SLOTS) {
      expect(portsForSlot(slot)).toEqual({
        slot,
        app: 5173 + 100 * slot,
        controller: 5197 + 100 * slot,
        github: 5198 + 100 * slot,
        provider: 5199 + 100 * slot,
        inspector: 9229 + slot,
      });
    }
  });

  it("uses five distinct ports, and no port is used by two slots or two roles", () => {
    const owner = new Map();
    for (const slot of ALL_SLOTS) {
      const ports = portsForSlot(slot);
      for (const role of STACK_ROLES) {
        const port = ports[role];
        expect(owner.get(port), `port ${port} (slot ${slot} ${role})`).toBeUndefined();
        owner.set(port, `${slot}:${role}`);
        expect(port).toBeGreaterThan(1024);
        expect(port).toBeLessThan(49152);
      }
    }
    expect(owner.size).toBe(ALL_SLOTS.length * STACK_ROLES.length);
  });

  it("points the controller at its own slot's port and tunnels to its own slot's app", () => {
    for (const slot of ALL_SLOTS) {
      const ports = portsForSlot(slot);
      const plan = controllerPlan(ports);
      expect(plan.uvicornArgs.at(-1)).toBe(String(ports.controller));
      expect(plan.tunnelArgs).toEqual(["tunnel", "--url", `http://localhost:${ports.app}`]);
    }
  });

  it("names only its own four stack ports in the stop command", () => {
    expect(stopCommand(portsForSlot(11))).toBe("lsof -ti:6273,6297,6298,6299 | xargs kill");
  });

  it("is read from ONCUE_PORT_SLOT", () => {
    expect(slotPorts({ [PORT_SLOT_ENV]: "11" }).app).toBe(6273);
    expect(slotPorts({ [PORT_SLOT_ENV]: "19" }).inspector).toBe(9248);
    expect(parsePortSlot(" 12 ")).toBe(12);
  });
});

describe("an invalid slot", () => {
  it.each(["20", "-1", "1.5", "abc", "1e1", "0x3", "100", "eleven"])(
    "is refused with a plain message (%s)",
    (raw) => {
      expect(() => parsePortSlot(raw)).toThrow(
        `ONCUE_PORT_SLOT must be a whole number from 0 to 19, got "${raw}"`,
      );
      expect(() => slotPorts({ [PORT_SLOT_ENV]: raw })).toThrow(/ONCUE_PORT_SLOT/);
    },
  );

  it("is refused by portsForSlot too, so no caller can build ports outside the range", () => {
    for (const slot of [-1, 20, 1.5, Number.NaN]) {
      expect(() => portsForSlot(slot)).toThrow(/port slot must be a whole number from 0 to 19/);
    }
  });
});

describe("foreignSlotOrigins", () => {
  const lane = (ports) =>
    Object.entries(laneOriginVars(ports))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

  it("accepts a .dev.vars composed for the same slot", () => {
    expect(foreignSlotOrigins(lane(portsForSlot(11)), portsForSlot(11))).toEqual([]);
    expect(foreignSlotOrigins(lane(portsForSlot(0)), portsForSlot(0))).toEqual([]);
  });

  it("names each origin that points at another slot's double or controller", () => {
    expect(foreignSlotOrigins(lane(portsForSlot(11)), portsForSlot(12))).toEqual([
      "ONCUE_GITHUB_API_ORIGIN is http://127.0.0.1:6298, but slot 12 uses port 6398",
      "ONCUE_PROVIDER_DOUBLE_ORIGIN is http://127.0.0.1:6299, but slot 12 uses port 6399",
      "ONCUE_SANDBOX_CONTROLLER_ORIGIN is http://127.0.0.1:6297, but slot 12 uses port 6397",
    ]);
  });

  it("leaves remote, blank, quoted-correct, commented, and unparseable values alone", () => {
    const text = [
      "ONCUE_SANDBOX_CONTROLLER_ORIGIN=https://controller.example.modal.run",
      "ONCUE_PROVIDER_DOUBLE_ORIGIN=",
      'ONCUE_GITHUB_API_ORIGIN="http://localhost:6398"',
      "#ONCUE_GITHUB_API_ORIGIN=http://127.0.0.1:5198",
      "ONCUE_OTHER_ORIGIN=http://127.0.0.1:1",
    ].join("\n");
    expect(foreignSlotOrigins(text, portsForSlot(12))).toEqual([]);
    expect(foreignSlotOrigins("ONCUE_GITHUB_API_ORIGIN=not a url", portsForSlot(12))).toEqual([]);
  });

  it("reads a loopback origin with no port as port 80 or 443, which no slot uses", () => {
    expect(
      foreignSlotOrigins("ONCUE_SANDBOX_CONTROLLER_ORIGIN=http://[::1]", portsForSlot(0)),
    ).toEqual(["ONCUE_SANDBOX_CONTROLLER_ORIGIN is http://[::1], but slot 0 uses port 5197"]);
    expect(
      foreignSlotOrigins("ONCUE_SANDBOX_CONTROLLER_ORIGIN=https://localhost", portsForSlot(0)),
    ).toHaveLength(1);
  });
});
