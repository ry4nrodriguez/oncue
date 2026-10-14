import { emptyView, foldEvents } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { namedBranch } from "./branch";

describe("namedBranch", () => {
  it("is null until a push names the branch, and a commit or status on the base branch does not", () => {
    expect(namedBranch(emptyView(), null)).toBeNull();
    const onBase = foldEvents([
      makeCommittedEvent(
        "repository.status",
        { payload: { branch: "main" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent("git.committed", { payload: { branch: "main" } }, { sessionSequence: 2 }),
    ]);
    expect(namedBranch(onBase, null)).toBeNull();
    expect(namedBranch(onBase, "oncue/from-the-record-7f3a")).toBe("oncue/from-the-record-7f3a");
  });

  it("takes the latest push's branch over the session record", () => {
    const pushed = foldEvents([
      makeCommittedEvent(
        "git.push.requested",
        { payload: { pushId: "push_1", branch: "oncue/first-1111" } },
        { sessionSequence: 1 },
      ),
      makeCommittedEvent(
        "git.push.requested",
        { payload: { pushId: "push_2", branch: "oncue/second-2222" } },
        { sessionSequence: 2 },
      ),
    ]);
    expect(namedBranch(pushed, "oncue/stale-0000")).toBe("oncue/second-2222");
  });
});
