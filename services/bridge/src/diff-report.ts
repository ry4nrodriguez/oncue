/**
 * Shapes what the bridge's Git measured into `repository.status` and
 * `diff.updated` drafts that always fit an event. Pure.
 *
 * A patch travels inline only when it fits `inlineText` and its JSON stays
 * under `INLINE_PATCH_JSON_BYTES`, so escaped characters cannot crowd out the
 * rest of the event; otherwise it is held for a `diff` artifact, with an
 * inline cut kept for when no upload can be declared. The file list is capped
 * at `listItems`, then cut until the payload leaves `EVENT_ENVELOPE_ALLOWANCE`
 * of the 256 KB event limit. Every cut sets `truncated`.
 */

import { LIMITS, type PayloadOf } from "@oncue/protocol";
import type { DiffOutcome, FileChangeEntry, RepositoryStatusPayload } from "./git";
import { draft, type Unbranded } from "./normalize";
import type { Draft } from "./protocol";

export type DiffScope = PayloadOf<"diff.updated">["scope"];

/** The patch as the reducer hears it: the text itself, or the size of bytes the interpreter holds under the report's digest. */
export type PatchText =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "held"; readonly byteSize: number; readonly cut: string };

export interface DiffReport {
  readonly baseSha: string;
  readonly headSha: string;
  /** At most `listItems`, each path within the protocol's bound. */
  readonly files: readonly FileChangeEntry[];
  readonly additions: number;
  readonly deletions: number;
  readonly patch: PatchText;
  /** SHA-256 of the patch as read: the key held bytes are staged by, and what tells two identical diffs apart. */
  readonly digest: string;
  /** Something was cut: the patch as read, the patch inline, or the file list. */
  readonly truncated: boolean;
  /** Every path in the tree at `headSha`, for the review's file tree; empty when git could not list it. */
  readonly paths: readonly string[];
  /** SHA-256 of `paths` joined by newlines: what tells two identical trees apart, so one is uploaded once. */
  readonly treeDigest: string;
}

/** The commits a build is measured against. */
export interface DiffRefs {
  readonly branch: string;
  /** The session's recorded base. */
  readonly baseSha: string;
  /** The last durable head, which a snapshot is parented on. */
  readonly parentSha: string;
}

export interface TurnBase {
  /** The snapshot the turn's diff is measured from. */
  readonly sha: string;
  /** Null when Git could not measure it; `repository.status` then reports the clone's head with zero counts. */
  readonly status: RepositoryStatusPayload | null;
}

export type DiffBuild =
  | {
      readonly kind: "built";
      /** The snapshot everything here was measured at, and the revision verification checks. */
      readonly headSha: string;
      readonly status: RepositoryStatusPayload | null;
      /** Null when the run recorded no turn base, when it was not asked for, or when Git could not measure it. */
      readonly turn: DiffReport | null;
      readonly session: DiffReport | null;
    }
  /** The snapshot itself failed; a fixed category. */
  | { readonly kind: "failed"; readonly detail: string };

export const INLINE_PATCH_JSON_BYTES = 160 * 1024;
export const EVENT_ENVELOPE_ALLOWANCE = 16 * 1024;
export const MAX_PATH_CHARS = 4096;
export const DIFF_CONTENT_TYPE = "text/x-diff";
export const DIFF_ARTIFACT_LABELS: Readonly<Record<DiffScope, string>> = {
  turn: "Changes in this turn",
  session: "All changes in this session",
};

const encoder = new TextEncoder();

export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** The start of `text` that fits inline under both bounds. */
export function inlineCut(text: string): string {
  let cut = text.slice(0, LIMITS.inlineTextChars);
  while (cut.length > 0 && jsonBytes(cut) > INLINE_PATCH_JSON_BYTES) {
    cut = cut.slice(0, Math.floor(cut.length * 0.75));
  }
  return cut;
}

/**
 * A measured diff as the reducer hears it. `holdLarge` is false for a
 * mid-run rebuild, which never uploads: a run's artifact budget is shared
 * with its verification logs, and a rebuild can come every 15 seconds.
 */
export function reportOf(
  outcome: Extract<DiffOutcome, { kind: "ok" }>,
  digest: string,
  holdLarge: boolean,
): Omit<DiffReport, "paths" | "treeDigest"> {
  const bounded = outcome.files.filter(
    (file) =>
      file.path.length <= MAX_PATH_CHARS && (file.previousPath?.length ?? 0) <= MAX_PATH_CHARS,
  );
  const files = bounded.slice(0, LIMITS.listItems);
  const fits =
    !outcome.truncated &&
    outcome.patch.length <= LIMITS.inlineTextChars &&
    jsonBytes(outcome.patch) <= INLINE_PATCH_JSON_BYTES;
  const patch: PatchText = fits
    ? { kind: "inline", text: outcome.patch }
    : holdLarge
      ? {
          kind: "held",
          byteSize: encoder.encode(outcome.patch).byteLength,
          cut: inlineCut(outcome.patch),
        }
      : { kind: "inline", text: inlineCut(outcome.patch) };
  return {
    baseSha: outcome.baseSha,
    headSha: outcome.headSha,
    files,
    additions: outcome.additions,
    deletions: outcome.deletions,
    patch,
    digest,
    truncated: outcome.truncated || !fits || files.length < outcome.files.length,
  };
}

/** Two session diffs with this key say the same thing. */
export function diffKey(report: DiffReport): string {
  return [
    report.baseSha,
    report.digest,
    report.files.length,
    report.additions,
    report.deletions,
  ].join(":");
}

export type DiffBody = Unbranded<PayloadOf<"diff.updated">["body"]>;

function fileChangeOf(
  file: FileChangeEntry,
): Unbranded<PayloadOf<"diff.updated">["files"][number]> {
  return {
    path: file.path,
    status: file.status,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    additions: file.additions,
    deletions: file.deletions,
  };
}

/** `diff.updated` with the file list cut, if it must be, until the payload leaves room for the envelope. */
export function diffUpdatedDraft(
  runId: string,
  scope: DiffScope,
  report: DiffReport,
  body: DiffBody,
  tree: Unbranded<NonNullable<PayloadOf<"diff.updated">["tree"]>> | null = null,
): Draft<"diff.updated"> {
  const files = report.files.map(fileChangeOf);
  const cutPatch = body.kind === "inline" && report.patch.kind === "held";
  const payload = (count: number): Unbranded<PayloadOf<"diff.updated">> => ({
    scope,
    baseSha: report.baseSha,
    headSha: report.headSha,
    files: files.slice(0, count),
    additions: report.additions,
    deletions: report.deletions,
    body,
    truncated: report.truncated || cutPatch || count < files.length,
    tree,
  });
  const budget = LIMITS.eventBytes - EVENT_ENVELOPE_ALLOWANCE;
  let count = files.length;
  while (count > 0 && jsonBytes(payload(count)) > budget) {
    count = Math.floor(count * 0.75);
  }
  return draft("diff.updated", runId, payload(count));
}

export function repositoryStatusDraft(
  runId: string,
  status: RepositoryStatusPayload,
): Draft<"repository.status"> {
  return draft("repository.status", runId, { ...status });
}
