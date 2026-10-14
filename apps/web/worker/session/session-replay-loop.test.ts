// A bridge that cannot satisfy `replay_from` (its ring no longer holds the
// missing frame) must not be able to spin the object in a replay loop. The
// sandbox is untrusted, so the bound belongs on the object's side.

import { describe, expect, it, vi } from "vitest";
import {
  connectBridge,
  eventCount,
  eventsOfType,
  readyBridge,
  registerSessionWorlds,
  sessionOnRealDriver,
  settle,
  waitFor,
} from "../test/session-world";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

describe("a bridge that cannot replay what the object asks for", () => {
  it("is cut off instead of trading the same frame forever", async () => {
    const world = await sessionOnRealDriver("ses_replay_loop");
    await readyBridge(world);
    const before = await eventCount(world.stub);

    // A bridge whose frames start far past what the object expects, so every
    // one of them is a gap, and whose ring cannot reach back to the frame the
    // object asks for: it answers a replay with what it has.
    const stuck = await connectBridge(world, 1, { sequenceStart: 900_000 });
    await stuck.hello();
    const aheadOfTheGap = JSON.stringify(stuck.event("tool.completed"));

    let asks = 0;
    let closed = false;
    stuck.client.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === "replay_from") {
        asks += 1;
        // Guard the test itself: a runaway loop must not hang the suite.
        if (asks <= 50) {
          stuck.client.send(aheadOfTheGap);
        }
      }
    });
    stuck.client.addEventListener("close", () => {
      closed = true;
    });

    stuck.client.send(aheadOfTheGap);
    await waitFor(async () => {
      await settle();
      return closed || asks >= 50;
    }, "the object to stop asking");

    expect(asks).toBeLessThanOrEqual(5);
    expect(closed).toBe(true);
    // None of the flood was stored: every frame of it was refused. The close
    // itself commits the generation's `runtime.disconnected`, so the log grows
    // by that one event and no more.
    expect(await eventsOfType(world.stub, "tool.completed")).toEqual([]);
    expect(await eventCount(world.stub)).toBeLessThanOrEqual(before + 1);
  });
});
