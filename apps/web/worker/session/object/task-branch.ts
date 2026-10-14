// Naming the task branch at the first push (record 07).

import { log } from "../../log";
import { chooseBranchName } from "../branch-naming";
import { hex4 } from "./credentials";
import type { SessionHost } from "./host";
import { latestChangeSummary } from "./store-git";
import { readDescription } from "./store-session";
import type { RepositoryBase, SessionRow } from "./types";

/**
 * Record 07: the first push names the task branch, from the name the user
 * typed, else the latest run's summary, else the session title, plus four hex
 * characters. The push webhook's incident rule reads
 * `session_index.task_branch`, so the projection is written and awaited
 * before the name is recorded or a push grant minted; otherwise the push would
 * look foreign and lock down every session of the repository. A name another
 * session holds is retried once with a suffix; a failed write leaves the
 * session unnamed and nothing is pushed. One naming runs at a time, so two
 * pushes during the same await share a name.
 */
export function nameTaskBranch(
  host: SessionHost,
  session: SessionRow,
  repository: RepositoryBase,
): Promise<string | null> {
  if (host.branchNaming !== null) {
    return host.branchNaming;
  }
  if (repository.taskBranch !== null) {
    return Promise.resolve(repository.taskBranch);
  }
  host.branchNaming = mintTaskBranch(host, session).finally(() => {
    host.branchNaming = null;
  });
  return host.branchNaming;
}

async function mintTaskBranch(host: SessionHost, session: SessionRow): Promise<string | null> {
  const sql = host.objectCtx.storage.sql;
  const requested = sql
    .exec<{ requested_name: string | null }>(
      "SELECT requested_name FROM session_branch WHERE id = 1",
    )
    .toArray()[0];
  const chosen = chooseBranchName(
    requested,
    readDescription(host.objectCtx.storage.sql)?.branchName ?? null,
    latestChangeSummary(host.objectCtx.storage.sql),
    session.title,
    hex4(),
  );
  let name = chosen;
  let written = await indexTaskBranch(host, session, name);
  if (written === "taken") {
    name = `${chosen}-${hex4()}`;
    written = await indexTaskBranch(host, session, name);
  }
  if (written !== "written") {
    log({
      timestamp: new Date().toISOString(),
      severity: "error",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.branch_named",
      result: written === "taken" ? "name_unavailable" : "index_write_failed",
      sessionId: session.id,
    });
    return null;
  }
  sql.exec("UPDATE session_repository SET task_branch = ?", name);
  sql.exec("UPDATE session_branch SET requested_name = NULL WHERE id = 1");
  // Minted, not yet pushed: no ref exists until the grant's push lands.
  sql.exec("INSERT OR REPLACE INTO task_branch_ref (id, pushed) VALUES (1, 0)");
  return name;
}

/**
 * The name's projection with the uniqueness check in the same statement, so
 * two sessions of one GitHub repository, in any workspace, never share a ref
 * for the webhook and the pull request lookup to confuse; a session working
 * directly on an existing branch holds its name from creation.
 */
async function indexTaskBranch(
  host: SessionHost,
  session: SessionRow,
  name: string,
): Promise<"written" | "taken" | "failed"> {
  try {
    const result = await host.objectEnv.DB.prepare(
      `UPDATE session_index SET task_branch = ?1
          WHERE session_id = ?2
            AND NOT EXISTS (
              SELECT 1 FROM session_index AS other
                JOIN repository_connection AS rc
                  ON rc.repository_connection_id = other.repository_connection_id
               WHERE other.task_branch = ?1
                 AND other.session_id <> ?2
                 AND rc.github_repository_id = (
                   SELECT mine.github_repository_id FROM repository_connection AS mine
                    WHERE mine.repository_connection_id = session_index.repository_connection_id))`,
    )
      .bind(name, session.id)
      .run();
    if (result.meta.changes === 1) {
      return "written";
    }
    // Nothing changed: the name is another session's, or there is no index row.
    const row = await host.objectEnv.DB.prepare(
      "SELECT 1 AS present FROM session_index WHERE session_id = ?",
    )
      .bind(session.id)
      .first<{ present: number }>();
    return row === null ? "failed" : "taken";
  } catch {
    return "failed";
  }
}
