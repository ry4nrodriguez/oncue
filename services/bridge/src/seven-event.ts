// The fake bridge's `seven-event` script, in its own module so plain Node can
// load it: `scripts.ts` imports fixtures with `?raw`, which only Vite and the
// bridge's build resolve.

import { createStream } from "@oncue/protocol/testing";
import type { BridgeScript, BridgeScriptContext } from "./scripts";

/**
 * The acceptance stream as the runtime sends it: run.started, three
 * message.delta, message.completed, run.verified, sandbox-origin with
 * contiguous runtimeSequence 0..5. It stands in for the runtime behind the
 * bridge, never for the bridge, so it does not send `runtime.connected` (the
 * bridge's own frame): a fake-driver session shows no connected row.
 *
 * `run.started` carries the session's task branch and base commit when the
 * caller has them, so the rail reads the branch the same way as with a real
 * bridge.
 */
export function sevenEventScript(context: BridgeScriptContext): BridgeScript {
  const stream = createStream();
  stream.emit(
    "run.started",
    // An absent branch keeps the fixture's default: a session with no
    // repository has no branch, and `run.started` requires one.
    context.branch === undefined
      ? {}
      : {
          payload: {
            branch: context.branch,
            ...(context.baseSha === undefined ? {} : { baseSha: context.baseSha }),
          },
        },
  );
  stream.emit("message.delta");
  stream.emit("message.delta");
  stream.emit("message.delta");
  stream.emit("message.completed");
  stream.emit("run.verified");
  return { name: "seven-event", frames: stream.events };
}
