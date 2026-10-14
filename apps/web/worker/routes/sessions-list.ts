/**
 * `GET /api/sessions`: the sidebar's data source, scoped to the caller's
 * verified workspace. Lists `active` and `archived` sessions (record 13),
 * excluding `creating` and `deletion_pending`, most recently active first,
 * through `idx_session_index_workspace_state`.
 */

import { RUN_STATES, type RunState } from "@oncue/protocol";
import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";

export interface SessionListRow {
  readonly sessionId: string;
  readonly title: string | null;
  readonly state: "active" | "archived";
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  /**
   * `null` for a session without a repository. Showing a repository the session
   * is not working against would be worse than showing none.
   */
  readonly repositoryFullName: string | null;
  /** An approval or Git behavior card is open, so the sidebar marks the session "Needs you". */
  readonly waitingForUser: boolean;
  /**
   * The task branch, or `null` before the first push names it or for a session
   * with no repository.
   */
  readonly taskBranch: string | null;
  /**
   * The branch the session started from (`session_index.base_branch`, migration
   * 0018), or `null` for a session with no repository or one from before the
   * choice, which started from the default branch.
   */
  readonly baseBranch: string | null;
  /**
   * `existing_branch` when the session works directly on `taskBranch`, an
   * existing branch it pushes to; `new_branch`, the reading of an older row
   * too, when it pushes to a new `oncue/` task branch.
   */
  readonly branchMode: "new_branch" | "existing_branch";
  /** The harness the session runs (`session_index.runtime`, migration 0016), for its composer's model list. */
  readonly runtime: string;
  /**
   * The session's current run and its last projected state, so the sidebar can
   * mark a session working or finished without waking its object. An unknown
   * state is `null` rather than a guess.
   */
  readonly currentRunId: string | null;
  readonly currentRunState: RunState | null;
}

interface SessionIndexRow {
  readonly session_id: string;
  readonly title: string | null;
  readonly state: string;
  readonly last_activity_at: string | null;
  readonly created_at: string;
  readonly repository_full_name: string | null;
  readonly task_branch: string | null;
  readonly base_branch: string | null;
  readonly branch_mode: string | null;
  readonly waiting_for_user: number;
  readonly runtime: string;
  readonly current_run_id: string | null;
  readonly current_run_state: string | null;
}

function isRunState(value: string | null): value is RunState {
  return value !== null && (RUN_STATES as readonly string[]).includes(value);
}

function isListedState(value: string): value is "active" | "archived" {
  return value === "active" || value === "archived";
}

// The SQL already excludes other states; this makes the response shape
// provable here rather than assumed from the query.
function toListRow(row: SessionIndexRow): SessionListRow | null {
  if (!isListedState(row.state)) {
    return null;
  }
  return {
    sessionId: row.session_id,
    title: row.title,
    state: row.state,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    repositoryFullName: row.repository_full_name,
    taskBranch: row.task_branch,
    baseBranch: row.base_branch,
    branchMode: row.branch_mode === "existing_branch" ? "existing_branch" : "new_branch",
    waitingForUser: row.waiting_for_user === 1,
    runtime: row.runtime,
    currentRunId: row.current_run_id,
    currentRunState: isRunState(row.current_run_state) ? row.current_run_state : null,
  };
}

export async function handleListSessions(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    const status = outcome.reason === "unauthenticated" ? 401 : 403;
    return Response.json({ error: outcome.reason }, { status });
  }
  const workspaceId = actorWorkspaceId(outcome.actor);

  // LEFT JOIN: a session with no repository must still list. The join uses the
  // connection id the session row recorded, so it reaches only this workspace's
  // rows.
  const result = await env.DB.prepare(
    `SELECT si.session_id AS session_id,
            si.title AS title,
            si.state AS state,
            si.last_activity_at AS last_activity_at,
            si.created_at AS created_at,
            rc.full_name AS repository_full_name,
            si.task_branch AS task_branch,
            si.base_branch AS base_branch,
            si.branch_mode AS branch_mode,
            si.waiting_for_user AS waiting_for_user,
            si.runtime AS runtime,
            si.current_run_id AS current_run_id,
            si.current_run_state AS current_run_state
       FROM session_index AS si
       LEFT JOIN repository_connection AS rc
         ON rc.repository_connection_id = si.repository_connection_id
      WHERE si.workspace_id = ? AND si.state IN ('active', 'archived')
      ORDER BY COALESCE(si.last_activity_at, si.created_at) DESC
      LIMIT 100`,
  )
    .bind(workspaceId)
    .all<SessionIndexRow>();

  const sessions: SessionListRow[] = [];
  for (const row of result.results) {
    const listRow = toListRow(row);
    if (listRow !== null) {
      sessions.push(listRow);
    }
  }

  return Response.json({ sessions }, { status: 200 });
}
