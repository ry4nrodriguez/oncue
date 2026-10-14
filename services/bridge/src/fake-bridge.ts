/**
 * Plays a `BridgeScript` over a socket in place of the real bridge (record
 * 02), through the `BridgeSocketSink` seam in `worker/sandbox/fake-driver.ts`.
 * It depends only on the `send`/`addEventListener` shape every WebSocket
 * implementation shares. `replay_from` is answered as record 04 describes
 * reconnection; a fresh `playToken` cancels the previous playback loop, so
 * `cursor` is never advanced from two places.
 */

import type { ProtocolEvent } from "@oncue/protocol";
import type { BridgeScript } from "./scripts";

export interface BridgeMessageEvent {
  readonly data: unknown;
}

/** The narrow slice of the WebSocket API this file needs. A real WebSocket satisfies it structurally. */
export interface BridgeSocket {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: BridgeMessageEvent) => void): void;
}

/** Immediate waits a microtask between frames, so a test can flush with a promise; paced is for the browser inspector. */
export type BridgePacing =
  | { readonly kind: "immediate" }
  | { readonly kind: "paced"; readonly frameIntervalMs: number };

export interface AttachedBridge {
  stop(): void;
}

interface ReplayFromRequest {
  readonly type: "replay_from";
  readonly runtimeSequence: number;
}

function isReplayFromRequest(value: unknown): value is ReplayFromRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "replay_from" &&
    typeof (value as { runtimeSequence?: unknown }).runtimeSequence === "number"
  );
}

function firstIndexAtOrAfter(frames: readonly ProtocolEvent[], runtimeSequence: number): number {
  for (const [index, frame] of frames.entries()) {
    if (frame.runtimeSequence !== null && frame.runtimeSequence >= runtimeSequence) {
      return index;
    }
  }
  return frames.length;
}

export function attachFakeBridge(
  socket: BridgeSocket,
  script: BridgeScript,
  pacing: BridgePacing,
): AttachedBridge {
  let stopped = false;
  let playToken = 0;

  function schedule(step: () => void): void {
    if (pacing.kind === "immediate") {
      queueMicrotask(step);
    } else {
      setTimeout(step, pacing.frameIntervalMs);
    }
  }

  function playFrom(startIndex: number): void {
    playToken += 1;
    const token = playToken;
    let cursor = startIndex;

    const step = (): void => {
      if (stopped || token !== playToken) {
        return;
      }
      const frame = script.frames[cursor];
      if (frame === undefined) {
        return;
      }
      cursor += 1;
      socket.send(JSON.stringify(frame));
      schedule(step);
    };
    schedule(step);
  }

  function handleMessage(event: BridgeMessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : "";
    if (raw.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isReplayFromRequest(parsed)) {
      playFrom(firstIndexAtOrAfter(script.frames, parsed.runtimeSequence));
    }
  }

  socket.addEventListener("message", handleMessage);
  playFrom(0);

  return {
    stop(): void {
      stopped = true;
      socket.removeEventListener("message", handleMessage);
    },
  };
}
