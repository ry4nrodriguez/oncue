import { describe, expect, it } from "vitest";
import {
  ARTIFACT_LIMITS,
  artifactObjectKey,
  classificationFor,
  downloadNameFor,
  expiresAtFor,
  labelFor,
  planArtifactAuthorization,
} from "./policy";

describe("planArtifactAuthorization", () => {
  it("allows an artifact within both limits, up to the edges", () => {
    expect(planArtifactAuthorization(5 * 1024 * 1024, 0)).toEqual({ kind: "allowed" });
    expect(planArtifactAuthorization(ARTIFACT_LIMITS.perArtifactBytes, 0)).toEqual({
      kind: "allowed",
    });
    expect(planArtifactAuthorization(1, ARTIFACT_LIMITS.perRunBytes - 1)).toEqual({
      kind: "allowed",
    });
  });

  it("refuses an empty declaration", () => {
    expect(planArtifactAuthorization(0, 0)).toMatchObject({ kind: "refused" });
  });

  it("refuses one artifact over its limit", () => {
    expect(planArtifactAuthorization(ARTIFACT_LIMITS.perArtifactBytes + 1, 0)).toEqual({
      kind: "refused",
      reason: `The artifact declared ${ARTIFACT_LIMITS.perArtifactBytes + 1} bytes, over the ${ARTIFACT_LIMITS.perArtifactBytes} byte limit for one artifact.`,
    });
  });

  it("refuses an artifact that would take the run over its limit", () => {
    expect(planArtifactAuthorization(2, ARTIFACT_LIMITS.perRunBytes - 1)).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/limit for one run/),
    });
  });
});

describe("where and how long", () => {
  it("keys the object by OnCue ids in record 03's layout", () => {
    expect(artifactObjectKey("wsp_1", "sess_1", "run_1", "art_1")).toBe(
      "workspaces/wsp_1/sessions/sess_1/runs/run_1/art_1",
    );
  });

  it("keeps a checkpoint bundle and expires everything else after 90 days", () => {
    expect(classificationFor("checkpoint")).toBe("essential_evidence");
    expect(expiresAtFor("checkpoint", 0)).toBeNull();
    expect(classificationFor("tool")).toBe("temporary");
    expect(expiresAtFor("tool", 0)).toBe(
      new Date(ARTIFACT_LIMITS.temporaryRetentionMs).toISOString(),
    );
  });

  it("names a download from OnCue's own label and id", () => {
    expect(labelFor("tool_output")).toBe("Full tool output");
    expect(downloadNameFor("tool_output", "art_1")).toBe("full-tool-output-art_1.txt");
    expect(downloadNameFor("patch", "art_2")).toBe("checkpoint-patch-bundle-art_2.patch");
    expect(downloadNameFor("diff", "art_3")).toBe("diff-art_3.patch");
  });
});
