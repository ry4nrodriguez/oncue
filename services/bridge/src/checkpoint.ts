/**
 * Checkpoints over `git.ts`; never throws. A checkpoint is a snapshot, then
 * `pushExact` under a push grant, or `patchBetween` when there is none or the
 * push did not land. The interpreter keeps any patch bytes and the reducer
 * hears only their size (record 03).
 *
 * Every token that enters here leaves revoked, whether or not it was used.
 * Upload and restore tokens are single-use bearers and are never stored.
 */

import { createHash } from "node:crypto";
import {
  type GitIo,
  type PushFailureReason,
  type PushGrant,
  patchBetween,
  pushExact,
  type SingleUse,
  type SnapshotFailure,
  snapshot,
} from "./git";

export interface CheckpointInput {
  readonly workTree: string;
  readonly scratchDir: string;
  /** The last durable head: the clone's verified head, or the last pushed checkpoint. */
  readonly durableHeadSha: string;
  /**
   * The agent's latest `git_commit` of this generation, else the durable head
   * (record 07). The chain from the durable head is what gets pushed or bundled.
   */
  readonly parentSha: string;
  /** The session's task branch, or null until the first push's grant names it. */
  readonly sessionBranch: string | null;
  /** The branch the sandbox cloned: the base branch until the task branch is named. Never a push target. */
  readonly cloneBranch: string | null;
  /** For the commit message only. */
  readonly reason: string;
  /** A publish's own commit message. Absent for the object's checkpoints, which are named after their reason. */
  readonly message?: string | undefined;
  readonly pushGrant: SingleUse<PushGrant> | null;
  /**
   * Given while the session holds development secrets: names the files whose
   * changes hold a value, and the checkpoint then publishes nothing at all.
   */
  readonly secretPathsIn?: ((patch: string) => readonly string[]) | undefined;
}

/** Why the checkpoint ended as a bundle or a bare commit instead of a push. */
export type PushSkipped =
  | { readonly kind: "no_grant" }
  | { readonly kind: "grant_spent" }
  | { readonly kind: "refused"; readonly reason: "ref_mismatch" }
  | { readonly kind: "push_failed"; readonly reason: PushFailureReason }
  /**
   * The changes hold a supplied development secret, or could not be read to be
   * checked. Nothing leaves the sandbox: a branch is public to everyone who
   * can read the repository, and a bundle is stored outside it.
   */
  | {
      readonly kind: "withheld";
      readonly reason: "secret_in_changes" | "secret_scan_failed";
      readonly paths: readonly string[];
    };

export type CheckpointResult =
  | { readonly kind: "failed"; readonly detail: SnapshotFailure }
  | { readonly kind: "unchanged"; readonly headSha: string }
  | { readonly kind: "pushed"; readonly headSha: string; readonly tokenRevoked: boolean }
  | {
      readonly kind: "bundled";
      readonly headSha: string;
      readonly patch: string;
      readonly pushOutcome: PushSkipped;
    }
  /** Committed into the scratch objects and neither pushed nor bundled: the commit lives only in this sandbox. */
  | {
      readonly kind: "committed_only";
      readonly headSha: string;
      readonly pushOutcome: PushSkipped;
    };

function describePushSkipped(skipped: PushSkipped): string {
  switch (skipped.kind) {
    case "no_grant":
    case "grant_spent":
      return skipped.kind;
    case "refused":
    case "push_failed":
    case "withheld":
      // Never the paths: a log line is not where a file's name is reported.
      return `${skipped.kind} (${skipped.reason})`;
  }
}

/**
 * One log line for a checkpoint's outcome, built only from fixed categories
 * and a short commit id: never git's own text, a path, or a token.
 */
export function describeCheckpoint(result: CheckpointResult): string {
  switch (result.kind) {
    case "failed":
      return `checkpoint failed: ${result.detail}`;
    case "unchanged":
      return `checkpoint unchanged at ${result.headSha.slice(0, 8)}`;
    case "pushed":
      return `checkpoint pushed ${result.headSha.slice(0, 8)}; token revoked: ${result.tokenRevoked}`;
    case "bundled":
      return `checkpoint ${result.headSha.slice(0, 8)} bundled as a patch; push: ${describePushSkipped(result.pushOutcome)}`;
    case "committed_only":
      return `checkpoint ${result.headSha.slice(0, 8)} committed only; push: ${describePushSkipped(result.pushOutcome)}`;
  }
}

/**
 * A checkpoint's snapshot of the whole work tree. A tree with a huge untracked
 * directory can make `git add -A` run long; past this the checkpoint fails
 * rather than holding the stop it belongs to.
 */
export const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
/**
 * One artifact PUT or GET, body included. An artifact is at most 25 MiB, so
 * this allows well under half a megabyte a second; a hung transfer would
 * otherwise block a prompt's attachments or a restore forever.
 */
export const ARTIFACT_TRANSFER_TIMEOUT_MS = 60_000;

export function checkpointMessage(reason: string): string {
  return `OnCue checkpoint (${reason})`;
}

/** A grant the snapshot made unnecessary still holds a live token; take it and revoke it. */
async function revokeUnused(grant: SingleUse<PushGrant> | null, io: GitIo): Promise<void> {
  const taken = grant?.take();
  if (taken !== undefined && taken.kind === "taken") {
    await io.revoke(taken.value.token);
  }
}

export async function runCheckpoint(input: CheckpointInput, io: GitIo): Promise<CheckpointResult> {
  const { workTree, scratchDir, parentSha, durableHeadSha } = input;
  const snapped = await snapshot(
    workTree,
    scratchDir,
    parentSha,
    input.message ?? checkpointMessage(input.reason),
    io,
    { timeoutMs: SNAPSHOT_TIMEOUT_MS },
  );
  if (snapped.kind === "failed") {
    await revokeUnused(input.pushGrant, io);
    return { kind: "failed", detail: snapped.detail };
  }
  // A tree unchanged since the agent's last commit still has that commit to
  // push; only a tree unchanged since the durable head has nothing.
  const headSha = snapped.kind === "unchanged" ? parentSha : snapped.sha;
  if (headSha === durableHeadSha) {
    await revokeUnused(input.pushGrant, io);
    return { kind: "unchanged", headSha: durableHeadSha };
  }

  // Read before anything is published, when there is something to look for.
  let scanned: Awaited<ReturnType<typeof patchBetween>> | null = null;
  if (input.secretPathsIn !== undefined) {
    scanned = await patchBetween(durableHeadSha, headSha, workTree, scratchDir, io);
    const paths = scanned.kind === "ok" ? input.secretPathsIn(scanned.patch) : [];
    if (scanned.kind === "failed" || paths.length > 0) {
      await revokeUnused(input.pushGrant, io);
      return {
        kind: "committed_only",
        headSha,
        pushOutcome: {
          kind: "withheld",
          reason: scanned.kind === "failed" ? "secret_scan_failed" : "secret_in_changes",
          paths,
        },
      };
    }
  }

  let pushOutcome: PushSkipped = { kind: "no_grant" };
  if (input.pushGrant !== null) {
    const pushed = await pushExact(
      input.pushGrant,
      headSha,
      input.sessionBranch,
      workTree,
      scratchDir,
      io,
      input.cloneBranch,
    );
    switch (pushed.kind) {
      case "pushed":
        return { kind: "pushed", headSha, tokenRevoked: pushed.tokenRevoked };
      case "grant_spent":
        pushOutcome = { kind: "grant_spent" };
        break;
      case "refused":
        pushOutcome = { kind: "refused", reason: pushed.reason };
        break;
      case "push_failed":
        pushOutcome = { kind: "push_failed", reason: pushed.reason };
        break;
    }
  }

  const patch = scanned ?? (await patchBetween(durableHeadSha, headSha, workTree, scratchDir, io));
  if (patch.kind === "failed") {
    return { kind: "committed_only", headSha, pushOutcome };
  }
  return { kind: "bundled", headSha, patch: patch.patch, pushOutcome };
}

export interface UploadRequest {
  readonly url: string;
  /** The upload grant's bearer. Used for this one request and dropped. */
  readonly token: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

export interface UploadResult {
  readonly ok: boolean;
  /** Null when the request never got an answer. */
  readonly status: number | null;
}

export const UPLOAD_CHECKSUM_HEADER = "x-oncue-sha256";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `PUT url` with the bearer, the type, the length, and the checksum. 201 is the only success. Never rejects. */
export async function uploadArtifact(
  request: UploadRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  try {
    const response = await fetchImpl(request.url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${request.token}`,
        "content-type": request.contentType,
        "content-length": String(request.bytes.byteLength),
        [UPLOAD_CHECKSUM_HEADER]: request.sha256,
      },
      body: request.bytes,
      signal: AbortSignal.timeout(ARTIFACT_TRANSFER_TIMEOUT_MS),
    });
    return { ok: response.status === 201, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}

export interface DownloadRequest {
  readonly url: string;
  readonly token: string;
}

export type DownloadResult =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "failed"; readonly status: number | null };

/** `GET url` with the bearer, the body read within the same bound. Never rejects. */
export async function downloadRestore(
  request: DownloadRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadResult> {
  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: { authorization: `Bearer ${request.token}` },
      signal: AbortSignal.timeout(ARTIFACT_TRANSFER_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return { kind: "failed", status: response.status };
    }
    return { kind: "ok", bytes: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return { kind: "failed", status: null };
  }
}

/** The interpreter's seam for the two HTTP calls, so a test hands in a fake without a fake `fetch`. */
export interface ArtifactIo {
  readonly upload: (request: UploadRequest) => Promise<UploadResult>;
  readonly download: (request: DownloadRequest) => Promise<DownloadResult>;
}

export function fetchArtifactIo(fetchImpl: typeof fetch = fetch): ArtifactIo {
  return {
    upload: (request) => uploadArtifact(request, fetchImpl),
    download: (request) => downloadRestore(request, fetchImpl),
  };
}
