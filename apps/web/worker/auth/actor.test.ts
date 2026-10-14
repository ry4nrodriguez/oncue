import { describe, expect, it } from "vitest";
import { actorUserId, actorWorkspaceId, constructActor } from "./actor";

describe("constructActor", () => {
  it("round-trips the user id and workspace id it was constructed with", () => {
    const actor = constructActor("usr_abc", "wsp_def");

    expect(actorUserId(actor)).toBe("usr_abc");
    expect(actorWorkspaceId(actor)).toBe("wsp_def");
  });
});
