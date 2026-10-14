import { LIMITS, parseEventJson } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import {
  DIFF_ARTIFACT_LABELS,
  DIFF_CONTENT_TYPE,
  type DiffReport,
  diffKey,
  diffUpdatedDraft,
  INLINE_PATCH_JSON_BYTES,
  inlineCut,
  jsonBytes,
  reportOf,
} from "./diff-report";
import type { DiffOutcome, FileChangeEntry } from "./git";
import type { Draft } from "./protocol";
import { bridgeConfig, type SequenceCursor, stampDraft } from "./protocol";

const BASE = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const HEAD = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const DIGEST = "ab".repeat(32);
const CONFIG = bridgeConfig(
  { sessionId: "sess_1", generation: 1, bootstrapCredential: "boot" },
  "wss://oncue.example",
);

/** `reportOf` with the tree listing fields these tests never look at. */
function fullReport(...args: Parameters<typeof reportOf>): DiffReport {
  return { ...reportOf(...args), paths: [], treeDigest: "" };
}

function outcome(overrides: Partial<Extract<DiffOutcome, { kind: "ok" }>> = {}) {
  return {
    kind: "ok" as const,
    baseSha: BASE,
    headSha: HEAD,
    files: [{ path: "README.md", status: "modified" as const, additions: 2, deletions: 1 }],
    additions: 2,
    deletions: 1,
    patch: "diff --git a/README.md b/README.md\n+two\n",
    truncated: false,
    ...overrides,
  };
}

/** The whole event as the object receives it, and whether the protocol accepts it. */
function stamped(draft: Draft): { readonly bytes: number; readonly ok: boolean } {
  const cursor: SequenceCursor = { next: 0 };
  const event = stampDraft(
    CONFIG,
    cursor,
    { newEventId: () => "evt_1", now: () => "2026-09-16T00:00:00.000Z" },
    draft,
  );
  const raw = JSON.stringify(event);
  return { bytes: Buffer.byteLength(raw, "utf8"), ok: parseEventJson(raw, "sandbox").ok };
}

describe("reportOf", () => {
  it("keeps a small patch inline and untruncated", () => {
    expect(fullReport(outcome(), DIGEST, true)).toEqual({
      baseSha: BASE,
      headSha: HEAD,
      files: outcome().files,
      additions: 2,
      deletions: 1,
      patch: { kind: "inline", text: outcome().patch },
      digest: DIGEST,
      truncated: false,
      paths: [],
      treeDigest: "",
    });
  });

  it("holds a patch past the inline limit for an artifact, with an inline cut beside it", () => {
    const patch = "x".repeat(LIMITS.inlineTextChars + 1);
    const report = fullReport(outcome({ patch }), DIGEST, true);
    expect(report.patch).toEqual({
      kind: "held",
      byteSize: LIMITS.inlineTextChars + 1,
      cut: "x".repeat(LIMITS.inlineTextChars),
    });
    expect(report.truncated).toBe(true);
  });

  it("holds a patch whose characters fit but whose JSON would not", () => {
    const patch = "".repeat(40_000);
    const report = fullReport(outcome({ patch }), DIGEST, true);
    expect(report.patch.kind).toBe("held");
    expect(jsonBytes(report.patch.kind === "held" ? report.patch.cut : "")).toBeLessThanOrEqual(
      INLINE_PATCH_JSON_BYTES,
    );
  });

  it("holds a patch Git cut at its read bound, however small what was read", () => {
    expect(fullReport(outcome({ truncated: true }), DIGEST, true).patch.kind).toBe("held");
  });

  it("never holds a mid-run patch: the cut travels inline and says truncated", () => {
    const patch = "y".repeat(LIMITS.inlineTextChars + 10);
    const report = fullReport(outcome({ patch }), DIGEST, false);
    expect(report.patch).toEqual({ kind: "inline", text: "y".repeat(LIMITS.inlineTextChars) });
    expect(report.truncated).toBe(true);
  });

  it("caps the file list, drops a path past the protocol's bound, and says truncated", () => {
    const files: FileChangeEntry[] = Array.from({ length: LIMITS.listItems + 3 }, (_, index) => ({
      path: `f${index}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
    }));
    const long: FileChangeEntry = {
      path: "p".repeat(4097),
      status: "added",
      additions: 0,
      deletions: 0,
    };
    const renamed: FileChangeEntry = {
      path: "ok.ts",
      status: "renamed",
      previousPath: "q".repeat(4097),
      additions: 0,
      deletions: 0,
    };
    const report = fullReport(outcome({ files: [long, renamed, ...files] }), DIGEST, true);
    expect(report.files).toHaveLength(LIMITS.listItems);
    expect(report.files[0]?.path).toBe("f0.ts");
    expect(report.truncated).toBe(true);
  });
});

describe("inlineCut", () => {
  it("is the text itself when it fits, and never past either bound when it does not", () => {
    expect(inlineCut("short")).toBe("short");
    const escaped = inlineCut("".repeat(LIMITS.inlineTextChars));
    expect(escaped.length).toBeLessThanOrEqual(LIMITS.inlineTextChars);
    expect(jsonBytes(escaped)).toBeLessThanOrEqual(INLINE_PATCH_JSON_BYTES);
    expect(escaped.length).toBeGreaterThan(0);
  });
});

describe("diffKey", () => {
  it("differs when the base, the patch, or the counts do", () => {
    const report = fullReport(outcome(), DIGEST, true);
    expect(diffKey(report)).toBe(diffKey({ ...report, headSha: BASE }));
    expect(diffKey(report)).not.toBe(diffKey({ ...report, baseSha: HEAD }));
    expect(diffKey(report)).not.toBe(diffKey({ ...report, digest: "cd".repeat(32) }));
    expect(diffKey(report)).not.toBe(diffKey({ ...report, additions: 3 }));
  });
});

describe("diffUpdatedDraft", () => {
  it("carries the scope, the counts, a rename's previous path, and the body", () => {
    const report = fullReport(
      outcome({
        files: [
          { path: "b.ts", status: "renamed", previousPath: "a.ts", additions: 0, deletions: 0 },
        ],
      }),
      DIGEST,
      true,
    );
    const draft = diffUpdatedDraft("run_1", "turn", report, { kind: "inline", patch: "p" });
    expect(draft).toEqual({
      type: "diff.updated",
      runId: "run_1",
      payload: {
        scope: "turn",
        baseSha: BASE,
        headSha: HEAD,
        files: [
          { path: "b.ts", status: "renamed", previousPath: "a.ts", additions: 0, deletions: 0 },
        ],
        additions: 2,
        deletions: 1,
        body: { kind: "inline", patch: "p" },
        truncated: false,
        tree: null,
      },
    });
    expect(stamped(draft).ok).toBe(true);
  });

  it("says truncated when a held patch's cut travels inline", () => {
    const report = fullReport(
      outcome({ patch: "z".repeat(LIMITS.inlineTextChars + 1) }),
      DIGEST,
      true,
    );
    const cut = report.patch.kind === "held" ? report.patch.cut : "";
    expect(
      diffUpdatedDraft(
        "run_1",
        "session",
        { ...report, truncated: false },
        { kind: "inline", patch: cut },
      ).payload.truncated,
    ).toBe(true);
  });

  it("never exceeds the event limit: the largest file list and inline patch are cut to fit, and the object accepts the event", () => {
    const files: FileChangeEntry[] = Array.from({ length: LIMITS.listItems }, (_, index) => ({
      path: `${"deep/".repeat(800)}${index}-éé.ts`,
      status: "renamed",
      previousPath: `${"old/".repeat(1000)}${index}.ts`,
      additions: 123_456,
      deletions: 654_321,
    }));
    const patch = "é\n".repeat(200_000);
    const report: DiffReport = fullReport(outcome({ files, patch }), DIGEST, true);
    expect(report.files).toHaveLength(LIMITS.listItems);
    for (const body of [
      { kind: "inline" as const, patch: report.patch.kind === "held" ? report.patch.cut : "" },
      {
        kind: "artifact" as const,
        artifact: {
          artifactId: "art_1",
          kind: "diff" as const,
          contentType: DIFF_CONTENT_TYPE,
          byteSize: 400_000,
          label: DIFF_ARTIFACT_LABELS.session,
        },
      },
    ]) {
      const draft = diffUpdatedDraft("run_1", "session", report, body);
      const event = stamped(draft);
      expect(event.bytes).toBeLessThanOrEqual(LIMITS.eventBytes);
      expect(event.ok).toBe(true);
      expect(draft.payload.truncated).toBe(true);
      expect(draft.payload.files.length).toBeLessThan(LIMITS.listItems);
      expect(draft.payload.files.length).toBeGreaterThan(0);
      expect(draft.payload.additions).toBe(report.additions);
    }
  });
});
