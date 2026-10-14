// Pure parsing and shaping of what crosses the object's sockets: bridge frames,
// upgrade paths, grant coordinates, and client commands.

import type { BridgeSocket } from "@oncue/bridge";
import {
  type CommandType,
  isCommandType,
  type ProtocolCommand,
  parseCommandPayload,
} from "@oncue/protocol";
import { safeJsonParse } from "../../json";

/**
 * The model grant's coordinates. `providerID` and `modelID` are OpenCode's
 * names, still read by bridges in older images; both pairs are sent so the
 * Worker and the controller can be deployed in either order.
 */
export function grantModel(
  provider: string,
  modelId: string,
): { readonly provider: string; readonly modelId: string } {
  const both = { provider, modelId, providerID: provider, modelID: modelId };
  return both;
}

// `attachFakeBridge` removes the same `handleMessage` reference it added, so
// the wrapper must be looked up by that reference: a rebuilt wrapper would
// never match on `removeEventListener` and the old listener would stay.
export function toBridgeSocket(ws: WebSocket): BridgeSocket {
  const wrapped = new WeakMap<(event: { data: unknown }) => void, EventListener>();
  return {
    send: (data: string) => ws.send(data),
    addEventListener: (type, listener) => {
      const handler = ((event: MessageEvent) => listener({ data: event.data })) as EventListener;
      wrapped.set(listener, handler);
      ws.addEventListener(type, handler);
    },
    removeEventListener: (type, listener) => {
      ws.removeEventListener(type, wrapped.get(listener) as EventListener);
    },
  };
}

/**
 * Matches the pathname `routes/ws-bridge.ts` forwards. Parsed again here
 * because this object must not rely on the route's checks.
 */
const BRIDGE_UPGRADE_PATH = /\/ws\/bridge\/[^/]+\/(\d+)$/;

export function extractBridgeGeneration(pathname: string): number | null {
  const match = BRIDGE_UPGRADE_PATH.exec(pathname);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  return Number(raw);
}

export type BridgeControlFrame = { readonly kind: "hello" } | { readonly kind: "heartbeat" };

/**
 * `bridge.hello` and `bridge.heartbeat` are the bridge's housekeeping frames,
 * not protocol events: they carry no `eventId` or sequence, so `ingestFrame`
 * would reject them. A frame recognized here never reaches `ingestFrame`.
 */
export function parseBridgeControlFrame(raw: string): BridgeControlFrame | null {
  const parsed = safeJsonParse<{ type?: unknown }>(raw);
  if (!parsed.ok) {
    return null;
  }
  if (parsed.value.type === "bridge.hello") {
    return { kind: "hello" };
  }
  if (parsed.value.type === "bridge.heartbeat") {
    return { kind: "heartbeat" };
  }
  return null;
}

export function parseIncomingCommand(
  raw: unknown,
  sessionId: string,
  issuedByUserId: string,
): ProtocolCommand | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const type = value.type;
  if (typeof type !== "string" || !isCommandType(type)) {
    return null;
  }
  const commandId = value.commandId;
  const issuedAt = value.issuedAt;
  const runId = value.runId;
  const expected = value.expected;
  if (
    typeof commandId !== "string" ||
    typeof issuedAt !== "string" ||
    typeof expected !== "object" ||
    expected === null
  ) {
    return null;
  }
  const payloadResult = parseCommandPayload(type as CommandType, value.payload);
  if (!payloadResult.ok) {
    return null;
  }
  return {
    commandId,
    sessionId,
    runId: typeof runId === "string" ? runId : null,
    issuedAt,
    issuedByUserId,
    expected,
    type,
    payload: payloadResult.value,
  } as ProtocolCommand;
}
