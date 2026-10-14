// Synchronous SQL for the repository, task branch, checkpoints, publishes, and
// the check rows a pull request cites.

import type { ProtocolEvent, ProtocolEventOf } from "@oncue/protocol";
import type { SectionCheck } from "../../github/pull-requests";
import { baseBranchOf, summaryFirstLine } from "../branch-naming";
import type { CheckpointFact } from "../lifecycle";
import type { RunForCover } from "../publish-cover";
import type { RepositoryBase, SessionRow } from "./types";

/**
 * A publish's own commit is part of a push the object asked for, so it takes
 * the ordinary path while that publish is open (one keyed read on the partial
 * index). Other commits go to `admitCommit`. The event's `policy.rule` is the
 * sandbox's word and decides nothing.
 */
export function isPublishCommit(sql: SqlStorage, event: ProtocolEvent): boolean {
  const row = sql
    .exec<{ open: number }>(
      "SELECT EXISTS(SELECT 1 FROM publish WHERE run_id = ? AND state = 'requested') AS open",
      event.runId,
    )
    .one();
  return row.open === 1;
}

export function readRepositoryBase(sql: SqlStorage): RepositoryBase | null {
  const row = sql
    .exec<{ base_sha: string; task_branch: string | null }>(
      "SELECT base_sha, task_branch FROM session_repository LIMIT 1",
    )
    .toArray()[0];
  return row === undefined ? null : { baseSha: row.base_sha, taskBranch: row.task_branch };
}

/**
 * The task branch once a ref exists for it, else null. A name minted for a
 * push grant has no ref until a push lands (a checkpoint of an unchanged tree
 * creates none), and cloning it would ask GitHub for a branch it never saw.
 */
export function pushedTaskBranch(sql: SqlStorage, taskBranch: string | null): string | null {
  if (taskBranch === null) {
    return null;
  }
  // One row at most, by its CHECK: no scan on this per-frame path.
  // `markTaskBranchPushed` sets it.
  const row = sql
    .exec<{ pushed: number }>(
      "SELECT NOT EXISTS(SELECT 1 FROM task_branch_ref WHERE pushed = 0) AS pushed",
    )
    .one();
  return row.pushed === 1 ? taskBranch : null;
}

/**
 * A push has landed: a publish reported `pushed`, or a checkpoint pushed past
 * the base (one of an unchanged tree reports `branch_push` at the base and
 * creates no ref).
 */
export function markTaskBranchPushed(sql: SqlStorage): void {
  sql.exec("UPDATE task_branch_ref SET pushed = 1 WHERE id = 1");
}

/** The branch the session started from; the clone target until the task branch is named. */
export function readBaseBranch(sql: SqlStorage): string {
  const row = sql
    .exec<{ base_branch: string }>("SELECT base_branch FROM session_branch WHERE id = 1")
    .toArray()[0];
  return baseBranchOf(row);
}

/**
 * The first line of the latest ended run's account of what changed, or null.
 * A checks-only run changed nothing, so it names nothing.
 */
export function latestChangeSummary(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ envelope_json: string }>(
      `SELECT envelope_json FROM event
          WHERE event_type IN ('run.verified', 'run.completed_with_warnings')
            AND (run_id IS NULL
              OR run_id NOT IN (SELECT id FROM run WHERE trigger = 'checks_requested'))
          ORDER BY session_sequence DESC LIMIT 1`,
    )
    .toArray()[0];
  return summaryFirstLine(row);
}

function readLatestCheckpointPayload(
  sql: SqlStorage,
): ProtocolEventOf<"repository.checkpointed">["payload"] | null {
  const raw = sql
    .exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'repository.checkpointed' ORDER BY session_sequence DESC LIMIT 1",
    )
    .toArray()[0]?.envelope_json;
  return raw === undefined
    ? null
    : (JSON.parse(raw) as ProtocolEventOf<"repository.checkpointed">).payload;
}

export function readLastCheckpoint(sql: SqlStorage): CheckpointFact | null {
  const payload = readLatestCheckpointPayload(sql);
  return payload === null
    ? null
    : { checkpointId: payload.checkpointId, kind: payload.kind, headSha: payload.headSha };
}

/** The commit a new generation clones: the newest pushed checkpoint, or where the session began. */
export function readDurableHeadSha(sql: SqlStorage, baseSha: string): string {
  const row = sql
    .exec<{ head_sha: string }>(
      "SELECT head_sha FROM checkpoint WHERE kind = 'branch_push' AND head_sha IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    )
    .toArray()[0];
  return row === undefined ? baseSha : row.head_sha;
}

/** A patch bundle is restored only while it is the newest checkpoint: a later push already carries its work. */
export function readRestoreArtifactId(sql: SqlStorage): string | null {
  const payload = readLatestCheckpointPayload(sql);
  return payload?.kind === "patch_bundle"
    ? (payload.bundle as NonNullable<typeof payload.bundle>).artifactId
    : null;
}

/** The runs a publish's cover is judged over, newest first, back to the session's first (`coverFor`). */
export function readRunsForCover(sql: SqlStorage, fromRunId: string): RunForCover[] {
  return sql
    .exec<{ id: string; outcome: string | null; trigger: string }>(
      `SELECT id, outcome, trigger FROM run
          WHERE queued_at <= (SELECT queued_at FROM run WHERE id = ?1)
          ORDER BY queued_at DESC, rowid DESC`,
      fromRunId,
    )
    .toArray();
}

/** Each check's newest attempt, from the gate's own rows. */
export function readSectionChecks(sql: SqlStorage, runId: string): SectionCheck[] {
  const rows = sql
    .exec<{
      check_id: string;
      name: string | null;
      attempt: number;
      classification: SectionCheck["classification"];
      result: SectionCheck["result"];
    }>(
      `SELECT c.check_id AS check_id, n.name AS name, c.attempt AS attempt, c.classification AS classification, c.result AS result
           FROM verification_check AS c
           LEFT JOIN verification_check_name AS n ON n.run_id = c.run_id AND n.check_id = c.check_id
          WHERE c.run_id = ?
          ORDER BY c.check_id, c.attempt`,
      runId,
    )
    .toArray();
  const newest = new Map<string, SectionCheck>();
  for (const row of rows) {
    newest.set(row.check_id, {
      // A check recorded before its name was kept still reads as something.
      name: row.name ?? row.check_id,
      classification: row.classification,
      result: row.result,
      attempts: row.attempt,
    });
  }
  return [...newest.values()];
}

/** The warnings the run ended with, via `idx_event_type_generation`, newest first. Read only when a pull request is written. */
export function readRunWarnings(sql: SqlStorage, session: SessionRow, runId: string): string[] {
  const rows = sql
    .exec<{ envelope_json: string }>(
      "SELECT envelope_json FROM event WHERE event_type = 'run.completed_with_warnings' AND sandbox_generation = ? AND run_id = ? ORDER BY session_sequence DESC LIMIT 1",
      session.sandboxGeneration,
      runId,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined) {
    return [];
  }
  const event = JSON.parse(row.envelope_json) as ProtocolEventOf<"run.completed_with_warnings">;
  return event.payload.warnings.map((warning) => warning.text);
}

export function settlePublish(
  sql: SqlStorage,
  pushId: string,
  state: "pushed" | "failed" | "nothing_to_push",
  headSha: string | null,
): void {
  sql.exec(
    "UPDATE publish SET state = ?, head_sha = ? WHERE push_id = ? AND state = 'requested'",
    state,
    headSha,
    pushId,
  );
  if (state === "pushed") {
    markTaskBranchPushed(sql);
  }
}

/** Whether a `git.push.*` report names the push this object asked for and has not yet heard about. */
export function publishIsOpen(sql: SqlStorage, pushId: string): boolean {
  return (
    sql
      .exec<{ open: number }>(
        "SELECT EXISTS(SELECT 1 FROM publish WHERE push_id = ? AND state = 'requested') AS open",
        pushId,
      )
      .one().open === 1
  );
}
