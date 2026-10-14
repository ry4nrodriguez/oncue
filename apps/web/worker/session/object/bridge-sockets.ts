// Bridge sockets: the upgrade and its credential check, the fake bridge, the
// current negotiated socket, and a bridge socket closing.

import { attachFakeBridge, type BridgePacing, loadBridgeScript } from "@oncue/bridge";
import { buildEvent, createRedactor } from "@oncue/protocol";
import { log } from "../../log";
import type { SandboxReference } from "../../sandbox/driver";
import { planSocketClosed } from "../lifecycle";
import { constantTimeEqual, sha256Hex } from "./credentials";
import type { SessionHost } from "./host";
import {
  generationEnded,
  readBridgeCredentialHash,
  readStopRow,
  writeProbe,
} from "./store-lifecycle";
import { isTombstoned } from "./store-session";
import type { BridgeAttachment, SessionRow } from "./types";
import { toBridgeSocket } from "./wire";

/**
 * Where both the fake and the real bridge end up: refuse unless redaction
 * secrets are sealed (an unprotected secret must never reach a live channel),
 * then accept the server end through the hibernatable API, tagged with the
 * generation later read back. Returns null when redaction refuses; each
 * caller answers that for its own transport.
 */
function acceptBridgeSocket(
  host: SessionHost,
  reference: SandboxReference,
  origin: string,
): InstanceType<typeof WebSocketPair> | null {
  const redactor = createRedactor(host.pendingRedactionSecrets);
  if (redactor.unprotectedCount > 0) {
    log({
      timestamp: new Date().toISOString(),
      severity: "error",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.generation_open",
      result: "refused",
      errorCategory: "unprotected_secret",
      sandboxGeneration: String(reference.generation),
      sessionId: reference.sessionId,
    });
    return null;
  }
  const pair = new WebSocketPair();
  const server = pair[0];
  host.objectCtx.acceptWebSocket(server, ["bridge", `gen:${reference.generation}`]);
  const attachment: BridgeAttachment = { origin, negotiated: false };
  server.serializeAttachment(attachment);
  return pair;
}

export function openBridgeSocket(host: SessionHost, reference: SandboxReference): void {
  // The fake dials nothing and never negotiates, so the origin is never read.
  const pair = acceptBridgeSocket(host, reference, "fake://control-plane");
  if (pair === null) {
    return;
  }
  const client = pair[1];
  // Only one end of a pair may go through `ctx.acceptWebSocket`, so the client
  // end `attachFakeBridge` drives is a plain socket that needs its own
  // `accept()` and stays non-hibernatable while attached. The real path hands
  // its client end to the Worker as the upgrade response instead.
  client.accept();
  // Spread rather than pass `undefined` (`exactOptionalPropertyTypes`): a
  // session with no repository keeps the fixture's branch, which `run.started`
  // requires.
  const script = loadBridgeScript(host.pendingScriptName, {
    sessionId: reference.sessionId,
    ...(host.pendingTaskBranch === null ? {} : { branch: host.pendingTaskBranch }),
    ...(host.pendingBaseCommitSha === null ? {} : { baseSha: host.pendingBaseCommitSha }),
  });
  const pacing: BridgePacing =
    host.pendingFramePacingMs === null
      ? { kind: "immediate" }
      : { kind: "paced", frameIntervalMs: host.pendingFramePacingMs };
  const attached = attachFakeBridge(toBridgeSocket(client), script, pacing);
  host.attachedBridges.set(reference.generation, { attached, client });
}

/**
 * Stops every in-process bridge and closes its client end. That end is not
 * hibernatable, so the object cannot quiesce until this runs.
 */
export function closeAttachedBridges(host: SessionHost): void {
  for (const { attached, client } of host.attachedBridges.values()) {
    attached.stop();
    client.close();
  }
  host.attachedBridges.clear();
}

/**
 * The bootstrap check lives here alone: only the credential's hash is stored,
 * so the Worker cannot derive it. It runs before the stale-generation check,
 * so a wrong credential learns nothing about which generation is current.
 *
 * A bridge from a superseded generation (record 11) presents a real
 * credential for a past generation, so only this object can refuse it. Both
 * refusals accept then close, with the same code and reason as a
 * stale-generation frame mid-connection, and 4401 for a wrong credential.
 */
export async function handleBridgeUpgrade(
  host: SessionHost,
  generation: number,
  presented: string | null,
  origin: string,
): Promise<Response> {
  if (isTombstoned(host.objectCtx.storage.sql)) {
    // A deleted session's bridge is refused with the code that ends it at
    // once. A bare 404 reads as a failed connect, which it would retry for
    // its whole outage window while its sandbox kept running.
    return acceptThenCloseBridge(4401, "unauthorized");
  }
  const session = host.readSession();
  if (session === null) {
    return new Response("session not found", { status: 404 });
  }
  const expected = readBridgeCredentialHash(host.objectCtx.storage.sql, generation);
  if (presented === null || expected === null) {
    return acceptThenCloseBridge(4401, "unauthorized");
  }
  if (!constantTimeEqual(expected, await sha256Hex(presented))) {
    return acceptThenCloseBridge(4401, "unauthorized");
  }
  if (session.sandboxGeneration !== generation) {
    return acceptThenCloseBridge(4000, "stale generation");
  }
  const reference: SandboxReference = { sessionId: session.id, generation };
  const pair = acceptBridgeSocket(host, reference, origin);
  if (pair === null) {
    return new Response("redaction secrets not sealed", { status: 500 });
  }
  return new Response(null, { status: 101, webSocket: pair[1] });
}

/**
 * Accept then close: `ws` reads a bare non-101 answer only as a failed
 * connect, so a refusal with its own reason has to be a coded close.
 */
function acceptThenCloseBridge(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  const client = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * A bridge socket closing is recorded, or the timeline would show a dead
 * sandbox as connected. The object knows only that it closed, so the event
 * says `connection_lost` with `expectReconnect` true: the bridge retries while
 * its sandbox lives. Whether the sandbox is gone is `getStatus`'s question.
 *
 * A stale generation's socket closing records nothing; `sandbox.replaced`
 * settles it. A client socket closing is not a session event.
 */
export async function webSocketClose(host: SessionHost, ws: WebSocket): Promise<void> {
  const tags = host.objectCtx.getTags(ws);
  if (!tags.includes("bridge")) {
    return;
  }
  const session = host.readSession();
  if (session === null) {
    return;
  }
  if (!tags.includes(`gen:${session.sandboxGeneration}`)) {
    return;
  }
  // A generation the object stopped, or one that failed, is over; its bridge
  // leaving is a consequence. So is a stop past its checkpoint, which closes
  // the bridge and records it in its own events.
  if (generationEnded(host.objectCtx.storage.sql, session.sandboxGeneration)) {
    return;
  }
  const stopStep = readStopRow(host.objectCtx.storage.sql, session.sandboxGeneration)?.step;
  if (stopStep === "revoke" || stopStep === "terminate" || stopStep === "replace") {
    return;
  }
  const now = new Date().toISOString();
  host.commitControlEvents(
    session,
    [
      buildEvent("runtime.disconnected", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: {
          reason: "connection_lost",
          detail:
            "The bridge's connection to the control plane closed. It reconnects on its own while its sandbox is running.",
          exitCode: null,
          diagnostics: [],
          expectReconnect: true,
        },
      }),
    ],
    now,
    () => undefined,
  );
  // Record 02: whether the sandbox is gone is the provider's answer, asked
  // a little later.
  const probe = planSocketClosed(host.lifecycleView(session, Date.now()));
  if (probe !== null) {
    writeProbe(host.objectCtx.storage.sql, probe);
    await host.rearm();
  }
}

// The shell half of `dispatch.ts`: rows and events in one transaction, then
// one frame at a time, minting each grant at send time and dropping it.

/** The negotiated, open bridge socket for the current generation, or null. Never a stale one or the fake's. */
export function currentBridge(
  host: SessionHost,
  session: SessionRow,
): { readonly ws: WebSocket; readonly origin: string } | null {
  const genTag = `gen:${session.sandboxGeneration}`;
  for (const ws of host.objectCtx.getWebSockets("bridge")) {
    const attachment = ws.deserializeAttachment() as BridgeAttachment | null;
    if (
      attachment?.negotiated &&
      host.objectCtx.getTags(ws).includes(genTag) &&
      ws.readyState === WebSocket.OPEN
    ) {
      return { ws, origin: attachment.origin };
    }
  }
  return null;
}
