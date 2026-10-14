/**
 * Diff builds over `git.ts`; never throws. A build snapshots the working tree
 * into a scratch index, then measures status and diffs against the commits the
 * reducer named. Builds run one at a time because they share that index, and
 * the queue keeps a mid-run rebuild from finishing after the run-end build it
 * preceded. A patch too large to travel inline is held by digest until `take`
 * hands it to `stage_upload`.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "./checkpoint";
import {
  type DiffBuild,
  type DiffRefs,
  type DiffReport,
  reportOf,
  type TurnBase,
} from "./diff-report";
import {
  DIFF_BOUNDS,
  type DiffBounds,
  diffBetween,
  type GitIo,
  listTreePaths,
  prepareCheckpointScratch,
  snapshot,
  status,
} from "./git";

export const DIFF_INDEX_FILE = "diff-index";
export const DIFF_SNAPSHOT_MESSAGE = "OnCue diff snapshot";
/** Held patches kept for staging; one run end holds at most two. */
export const HELD_PATCHES_KEPT = 4;

export interface DiffBuilder {
  /** Snapshot and status at a run's start. Null when the snapshot failed. */
  turnBase(refs: DiffRefs): Promise<TurnBase | null>;
  /** Snapshot, status, the turn's diff when `turnBaseSha` is known, and the session's. Large patches are held. */
  runEnd(refs: DiffRefs, turnBaseSha: string | null): Promise<DiffBuild>;
  /** Snapshot and the session's diff alone, inline only. */
  midRun(refs: DiffRefs): Promise<DiffBuild>;
  /** The session's diff to a commit that already exists, such as a checkpoint's. Large patches are held. */
  sessionAt(baseSha: string, headSha: string): Promise<DiffReport | null>;
  /** One commit against its parent, for `git.committed`'s file list and counts. Its patch is never held. */
  commitAt(parentSha: string, headSha: string): Promise<DiffReport | null>;
  /** The held bytes for a digest, removed from here. */
  take(digest: string): Buffer | null;
}

export function createDiffBuilder(
  workTree: string,
  scratchDir: string,
  io: GitIo,
  log: (line: string) => void,
  bounds: DiffBounds = DIFF_BOUNDS,
): DiffBuilder {
  let queue: Promise<unknown> = Promise.resolve();
  /** The parent the diff index was last built on; null when it must be rebuilt from `read-tree`. */
  let indexParent: string | null = null;
  const held = new Map<string, Buffer>();

  function serialised<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function snap(refs: DiffRefs): Promise<{ sha: string } | { failed: string }> {
    if (!(await prepareCheckpointScratch(scratchDir, `${DIFF_INDEX_FILE}.lock`))) {
      indexParent = null;
      return { failed: "scratch_unavailable" };
    }
    const reuseIndex = indexParent === refs.parentSha;
    const snapped = await snapshot(
      workTree,
      scratchDir,
      refs.parentSha,
      DIFF_SNAPSHOT_MESSAGE,
      io,
      {
        indexFile: DIFF_INDEX_FILE,
        reuseIndex,
        timeoutMs: bounds.timeoutMs,
      },
    );
    if (snapped.kind === "failed") {
      indexParent = null;
      await rm(join(scratchDir, DIFF_INDEX_FILE), { force: true }).catch(() => {});
      return { failed: snapped.detail };
    }
    indexParent = refs.parentSha;
    return { sha: snapped.sha };
  }

  async function measure(
    baseSha: string,
    headSha: string,
    holdLarge: boolean,
  ): Promise<DiffReport | null> {
    const outcome = await diffBetween(baseSha, headSha, workTree, scratchDir, io, bounds);
    if (outcome.kind === "failed") {
      log(`bridge: diff ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)} failed: ${outcome.detail}`);
      return null;
    }
    const bytes = Buffer.from(outcome.patch, "utf8");
    const digest = sha256Hex(bytes);
    const paths = (await listTreePaths(headSha, workTree, scratchDir, io, bounds.timeoutMs)) ?? [];
    const report: DiffReport = {
      ...reportOf(outcome, digest, holdLarge),
      paths,
      treeDigest: sha256Hex(Buffer.from(paths.join("\n"), "utf8")),
    };
    if (report.patch.kind === "held") {
      held.delete(digest);
      held.set(digest, bytes);
      for (const stale of [...held.keys()].slice(0, -HELD_PATCHES_KEPT)) {
        held.delete(stale);
      }
    }
    return report;
  }

  async function measureStatus(refs: DiffRefs, headSha: string) {
    const measured = await status(workTree, scratchDir, { ...refs, headSha }, io, bounds.timeoutMs);
    if (measured.kind === "failed") {
      log(`bridge: repository status failed: ${measured.detail}`);
      return null;
    }
    return measured.status;
  }

  async function build(
    refs: DiffRefs,
    turnBaseSha: string | null,
    runEnd: boolean,
  ): Promise<DiffBuild> {
    const snapped = await snap(refs);
    if ("failed" in snapped) {
      return { kind: "failed", detail: snapped.failed };
    }
    return {
      kind: "built",
      headSha: snapped.sha,
      status: runEnd ? await measureStatus(refs, snapped.sha) : null,
      turn: runEnd && turnBaseSha !== null ? await measure(turnBaseSha, snapped.sha, true) : null,
      session: await measure(refs.baseSha, snapped.sha, runEnd),
    };
  }

  return {
    turnBase: (refs) =>
      serialised(async () => {
        const snapped = await snap(refs);
        if ("failed" in snapped) {
          log(`bridge: turn base snapshot failed: ${snapped.failed}`);
          return null;
        }
        return { sha: snapped.sha, status: await measureStatus(refs, snapped.sha) };
      }),
    runEnd: (refs, turnBaseSha) => serialised(() => build(refs, turnBaseSha, true)),
    midRun: (refs) => serialised(() => build(refs, null, false)),
    sessionAt: (baseSha, headSha) =>
      serialised(async () =>
        (await prepareCheckpointScratch(scratchDir, `${DIFF_INDEX_FILE}.lock`))
          ? measure(baseSha, headSha, true)
          : null,
      ),
    commitAt: (parentSha, headSha) =>
      serialised(async () =>
        (await prepareCheckpointScratch(scratchDir, `${DIFF_INDEX_FILE}.lock`))
          ? measure(parentSha, headSha, false)
          : null,
      ),
    take(digest) {
      const bytes = held.get(digest) ?? null;
      held.delete(digest);
      return bytes;
    },
  };
}
