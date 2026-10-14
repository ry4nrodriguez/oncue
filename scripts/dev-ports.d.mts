// Types for `dev-ports.mjs`, which root scripts run as plain JavaScript and
// the web package's TypeScript imports.

export interface SlotPorts {
  readonly slot: number;
  readonly app: number;
  readonly controller: number;
  readonly github: number;
  readonly provider: number;
  readonly inspector: number;
}

export interface SlotOrigins {
  readonly app: string;
  readonly controller: string;
  readonly github: string;
  readonly provider: string;
}

export const PORT_SLOT_ENV: "ONCUE_PORT_SLOT";
export const MAX_PORT_SLOT: number;
export function parsePortSlot(raw: string | undefined): number;
export function portsForSlot(slot: number): SlotPorts;
export function originsFor(ports: SlotPorts): SlotOrigins;
export function slotPorts(env?: Record<string, string | undefined>): SlotPorts;
export function stopCommand(ports: SlotPorts): string;
export function foreignSlotOrigins(devVarsText: string, ports: SlotPorts): string[];
export function slotPortsOrExit(tag: string): SlotPorts;
