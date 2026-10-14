// Record 03's artifact policy. The session object applies it when the bridge
// declares an artifact, and the upload endpoint applies it again to what
// arrives. The per-artifact limit sits well under the Worker's 100 MB request
// body limit (Free and Pro plans), because uploads stream through the Worker.

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ARTIFACT_LIMITS = {
  perArtifactBytes: 25 * MIB,
  perRunBytes: 100 * MIB,
  tokenTtlMs: 10 * 60 * 1000,
  temporaryRetentionMs: 90 * DAY_MS,
} as const;

export type ArtifactKind =
  | "log"
  | "screenshot"
  | "recording"
  | "patch"
  | "bundle"
  | "report"
  | "diff"
  | "tool_output"
  | "file";

export type ArtifactProducer =
  | "tool"
  | "verification"
  | "checkpoint"
  | "screenshot"
  | "log"
  | "agent";

export type ArtifactAuthorization =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly reason: string };

/** `runBytes` is what the run's other artifacts, uploading or created, already declared. */
export function planArtifactAuthorization(
  declaredBytes: number,
  runBytes: number,
): ArtifactAuthorization {
  if (declaredBytes <= 0) {
    return { kind: "refused", reason: "An artifact must declare at least one byte." };
  }
  if (declaredBytes > ARTIFACT_LIMITS.perArtifactBytes) {
    return {
      kind: "refused",
      reason: `The artifact declared ${declaredBytes} bytes, over the ${ARTIFACT_LIMITS.perArtifactBytes} byte limit for one artifact.`,
    };
  }
  if (runBytes + declaredBytes > ARTIFACT_LIMITS.perRunBytes) {
    return {
      kind: "refused",
      reason: `The run's artifacts would reach ${runBytes + declaredBytes} bytes, over the ${ARTIFACT_LIMITS.perRunBytes} byte limit for one run.`,
    };
  }
  return { kind: "allowed" };
}

/**
 * Record 03's key layout. The artifact id is bridge-chosen, so it is the last
 * segment and cannot move an object into another run's prefix; R2 keys have no
 * path traversal.
 */
export function artifactObjectKey(
  workspaceId: string,
  sessionId: string,
  runId: string,
  artifactId: string,
): string {
  return `workspaces/${workspaceId}/sessions/${sessionId}/runs/${runId}/${artifactId}`;
}

/** A patch bundle is recovery data for the session's life; everything else expires after 90 days. */
export function classificationFor(producer: ArtifactProducer): "essential_evidence" | "temporary" {
  return producer === "checkpoint" ? "essential_evidence" : "temporary";
}

export function expiresAtFor(producer: ArtifactProducer, createdAtMs: number): string | null {
  return classificationFor(producer) === "temporary"
    ? new Date(createdAtMs + ARTIFACT_LIMITS.temporaryRetentionMs).toISOString()
    : null;
}

const LABELS: Record<ArtifactKind, string> = {
  log: "Log",
  screenshot: "Screenshot",
  recording: "Recording",
  patch: "Checkpoint patch bundle",
  bundle: "Bundle",
  report: "Report",
  diff: "Diff",
  tool_output: "Full tool output",
  file: "File",
};

export function labelFor(kind: ArtifactKind): string {
  return LABELS[kind];
}

/**
 * OnCue's own label plus the artifact id, never a sandbox-declared name. The
 * id comes from a percent-encoded path segment, so it cannot carry a quote or
 * a line break into the header.
 */
export function downloadNameFor(kind: ArtifactKind, artifactId: string): string {
  const extension = kind === "patch" || kind === "diff" ? "patch" : "txt";
  return `${LABELS[kind].toLowerCase().replaceAll(" ", "-")}-${artifactId}.${extension}`;
}
