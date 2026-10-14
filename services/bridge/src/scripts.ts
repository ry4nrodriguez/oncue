/**
 * A script is the fixed sequence of protocol events `attachFakeBridge` plays
 * over a socket. `seven-event` and `long-stream` are built in memory with
 * `createStream`; `stale-generation` and `sequence-gap`, the two rejection
 * cases, are loaded from the committed protocol fixtures.
 */

import type { ProtocolEvent, RunId, SessionId } from "@oncue/protocol";
import { createStream } from "@oncue/protocol/testing";
import sequenceGapRaw from "../../../packages/protocol/fixtures/sequence-gap.jsonl?raw";
import staleGenerationRaw from "../../../packages/protocol/fixtures/stale-generation.jsonl?raw";
import { sevenEventScript } from "./seven-event";

export type BridgeScriptName = "seven-event" | "long-stream" | "stale-generation" | "sequence-gap";

export interface BridgeScript {
  readonly name: BridgeScriptName;
  readonly frames: readonly ProtocolEvent[];
}

const LONG_STREAM_FRAME_COUNT = 2000;

function parseJsonl(raw: string): readonly ProtocolEvent[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProtocolEvent);
}

// 2,000 durable frames for the reconnect-replay perf probe. `file.changed`
// rather than `message.delta`, because only durable events are committed and
// replayed (record 04).
function longStreamScript(): BridgeScript {
  const stream = createStream();
  for (let index = 0; index < LONG_STREAM_FRAME_COUNT; index += 1) {
    stream.emit("file.changed");
  }
  return { name: "long-stream", frames: stream.events };
}

const BRIDGE_SCRIPTS: {
  readonly [Name in BridgeScriptName]: (context: BridgeScriptContext) => BridgeScript;
} = {
  "seven-event": sevenEventScript,
  "long-stream": longStreamScript,
  "stale-generation": () => ({ name: "stale-generation", frames: parseJsonl(staleGenerationRaw) }),
  "sequence-gap": () => ({ name: "sequence-gap", frames: parseJsonl(sequenceGapRaw) }),
};

/**
 * What a real session knows that a fixture cannot: its ids, task branch, and
 * base commit. Every field is optional, because a fixture-backed script and a
 * session with no repository have nothing to supply.
 */
export interface BridgeScriptContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly branch?: string;
  readonly baseSha?: string;
}

// Every script carries placeholder session and run ids, and the session object
// rejects a frame for another session (`wrong_session`), so the ids are remapped
// onto the real ones. Only the in-memory frames change, never the fixture files.
function remapIds(script: BridgeScript, ids: BridgeScriptContext): BridgeScript {
  if (ids.sessionId === undefined && ids.runId === undefined) {
    return script;
  }
  return {
    name: script.name,
    // A null `runId` is never overwritten, so each variant's `type`/`runId`
    // pairing holds; TypeScript cannot see that across the union, hence the cast.
    frames: script.frames.map(
      (frame) =>
        ({
          ...frame,
          sessionId: ids.sessionId === undefined ? frame.sessionId : (ids.sessionId as SessionId),
          runId:
            ids.runId === undefined || frame.runId === null ? frame.runId : (ids.runId as RunId),
        }) as unknown as ProtocolEvent,
    ),
  };
}

export function loadBridgeScript(
  name: BridgeScriptName,
  context: BridgeScriptContext = {},
): BridgeScript {
  return remapIds(BRIDGE_SCRIPTS[name](context), context);
}
