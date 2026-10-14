import { describe, expect, it } from "vitest";
import { artifactObjectKey } from "../artifacts/policy";
import { attachmentObjectKey } from "../attachments/store";
import { ownsArtifactKey, ownsAttachmentKey, planObjectRemoval } from "./ownership";

describe("ownsArtifactKey", () => {
  it("accepts exactly the key OnCue writes for this workspace and session", () => {
    expect(
      ownsArtifactKey(artifactObjectKey("ws_1", "sess_1", "run_1", "art_1"), "ws_1", "sess_1"),
    ).toBe(true);
  });

  it("refuses another workspace's, another session's, or a malformed key", () => {
    const key = artifactObjectKey("ws_1", "sess_1", "run_1", "art_1");
    expect(ownsArtifactKey(key, "ws_2", "sess_1")).toBe(false);
    expect(ownsArtifactKey(key, "ws_1", "sess_10")).toBe(false);
    expect(
      ownsArtifactKey(artifactObjectKey("ws_1", "sess_10", "run_1", "a"), "ws_1", "sess_1"),
    ).toBe(false);
    expect(ownsArtifactKey("workspaces/ws_1/sessions/sess_1/runs/run_1", "ws_1", "sess_1")).toBe(
      false,
    );
    expect(ownsArtifactKey("workspaces/ws_1/sessions/sess_1/runs/run_1/", "ws_1", "sess_1")).toBe(
      false,
    );
    expect(ownsArtifactKey("workspaces/ws_1/sessions/sess_1/runs/r/a/b", "ws_1", "sess_1")).toBe(
      false,
    );
    expect(ownsArtifactKey("workspaces/ws_1/attachments/att_1", "ws_1", "sess_1")).toBe(false);
  });
});

describe("ownsAttachmentKey", () => {
  it("rebuilds the key from the workspace and id rather than trusting the row", () => {
    expect(
      ownsAttachmentKey(
        { attachmentId: "att_1", objectKey: attachmentObjectKey("ws_1", "att_1") },
        "ws_1",
      ),
    ).toBe(true);
    expect(
      ownsAttachmentKey(
        { attachmentId: "att_1", objectKey: attachmentObjectKey("ws_2", "att_1") },
        "ws_1",
      ),
    ).toBe(false);
    expect(
      ownsAttachmentKey(
        { attachmentId: "att_1", objectKey: attachmentObjectKey("ws_1", "att_2") },
        "ws_1",
      ),
    ).toBe(false);
  });
});

describe("planObjectRemoval", () => {
  it("keeps each owned key once, sorted, and counts every foreign one", () => {
    const owned = artifactObjectKey("ws_1", "sess_1", "run_1", "art_1");
    const plan = planObjectRemoval(
      "ws_1",
      "sess_1",
      [owned, owned, artifactObjectKey("ws_2", "sess_1", "run_1", "art_1")],
      [
        { attachmentId: "att_1", objectKey: attachmentObjectKey("ws_1", "att_1") },
        { attachmentId: "att_2", objectKey: attachmentObjectKey("ws_2", "att_2") },
      ],
    );
    expect(plan).toEqual({
      owned: [attachmentObjectKey("ws_1", "att_1"), owned],
      skipped: 2,
    });
  });

  it("plans nothing for a session with nothing stored", () => {
    expect(planObjectRemoval("ws_1", "sess_1", [], [])).toEqual({ owned: [], skipped: 0 });
  });
});
