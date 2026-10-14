/**
 * A bridge that lies, as a compromised sandbox image would: it sends a bare
 * `run.verified` with no verification record behind it. The controller double
 * starts it only for a session named through `POST /__forge`, with the same
 * inputs and handshake as the real bridge. It tests the object's refusal and
 * does not do our code's work: a double never covers for our own code, which
 * is why it is opt-in per session.
 *
 * Run as its own process: `node --import tsx e2e/forged-bridge.ts`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProtocolEvent } from "@oncue/protocol";
import { makeEvent } from "@oncue/protocol/testing";
import { buildAckFrame } from "../../../services/bridge/src/frames";
import {
  type BridgeIo,
  type BridgeLink,
  bridgeConfig,
  bridgeConnectHeaders,
  bridgeConnectUrl,
  type Outbound,
  runLink,
  type SequenceCursor,
} from "../../../services/bridge/src/protocol";
import { sevenEventScript } from "../../../services/bridge/src/seven-event";

/** Long enough apart that the session screen streams the message rather than drawing it whole. */
const FRAME_GAP_MS = 150;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`forged bridge: ${name} is not set`);
  }
  return value;
}

const identity = {
  sessionId: required("ONCUE_SESSION_ID"),
  generation: Number(required("ONCUE_SANDBOX_GENERATION")),
  bootstrapCredential: readFileSync(required("ONCUE_BOOTSTRAP_FILE"), "utf8").trim(),
};
const config = bridgeConfig(identity, required("ONCUE_CONTROL_PLANE_ORIGIN"), {
  bridgeVersion: "forged",
});

const io: BridgeIo = {
  connect(url, headers) {
    return new Promise<BridgeLink>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http/, "ws"), { headers });
      socket.addEventListener("open", () =>
        resolve({
          send: (text) => socket.send(text),
          close: () => socket.close(),
          onMessage: (listener) =>
            socket.addEventListener("message", (event) => listener(String(event.data))),
          onClose: (listener) => socket.addEventListener("close", () => listener()),
        }),
      );
      socket.addEventListener("error", () => reject(new Error("forged bridge: connect failed")));
    });
  },
  startHeartbeat(intervalMs, tick) {
    const handle = setInterval(tick, intervalMs);
    return () => clearInterval(handle);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Never the URL or the headers: one of those is the bootstrap credential.
  log: (line) => process.stdout.write(`${line}\n`),
  newEventId: () => randomUUID(),
  now: () => new Date().toISOString(),
};

const cursor: SequenceCursor = { next: 0 };

/** Re-stamps a scripted or builder event as this generation's next sandbox frame. */
function stamp(event: ProtocolEvent, runId: string | null): ProtocolEvent {
  const runtimeSequence = cursor.next;
  cursor.next += 1;
  return {
    ...event,
    eventId: io.newEventId(),
    sessionId: identity.sessionId,
    runId: event.runId === null ? null : runId,
    sandboxGeneration: identity.generation,
    runtimeSequence,
    occurredAt: io.now(),
  } as ProtocolEvent;
}

const played = new Set<string>();
let outbound: Outbound | null = null;

const link = await io.connect(bridgeConnectUrl(config), bridgeConnectHeaders(config));
const outcome = await runLink(config, io, link, cursor, {
  onLinkUp(up) {
    outbound = up;
    io.log("forged bridge: claiming the runtime is ready");
    up.sendEvent(
      stamp(
        makeEvent("runtime.ready", {
          payload: { runtimeName: "forged", runtimeVersion: "0", healthChecks: [], startupMs: 0 },
        }) as ProtocolEvent,
        null,
      ),
    );
  },
  onLinkDown() {
    outbound = null;
  },
  onFrame(frame) {
    if (frame.kind !== "command" || outbound === null) {
      return;
    }
    const { command, runId } = frame.frame;
    if (command.type === "runtime.shutdown") {
      link.close();
      return;
    }
    if (command.type !== "run.start" || runId === null || played.has(runId)) {
      return;
    }
    played.add(runId);
    const up = outbound;
    up.sendAck(
      buildAckFrame(
        { sessionId: identity.sessionId, generation: identity.generation },
        { commandId: command.commandId },
        { kind: "accepted" },
      ),
    );
    io.log(`forged bridge: playing seven-event for ${runId}, ending in a bare run.verified`);
    void (async () => {
      for (const scripted of sevenEventScript({}).frames) {
        await io.sleep(FRAME_GAP_MS);
        up.sendEvent(stamp(scripted, runId));
      }
    })();
  },
});
io.log(`forged bridge: link ended (${outcome.kind})`);
process.exit(0);
