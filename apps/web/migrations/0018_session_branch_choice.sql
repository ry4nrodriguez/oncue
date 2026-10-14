-- The branch a session works from (record 07). `base_branch` is the branch the
-- session's base commit was read from: the one chosen in the composer, or the
-- existing branch a session works on directly. `branch_mode` says whether the
-- session pushes to a new `oncue/` task branch (`new_branch`) or to that
-- existing branch (`existing_branch`), which is then `task_branch` from
-- creation. Both are NULL on every older row, which reads as the repository's
-- default branch and a new task branch, as every session before the choice.
ALTER TABLE session_index ADD COLUMN base_branch TEXT;
ALTER TABLE session_index ADD COLUMN branch_mode TEXT
  CHECK (branch_mode IS NULL OR branch_mode IN ('new_branch', 'existing_branch'));

-- At most one session of a repository holds a branch: the create route's insert
-- looks the branch up across workspaces before it takes it, and this index
-- serves that lookup instead of a scan of every session.
CREATE INDEX IF NOT EXISTS idx_session_index_task_branch
  ON session_index (task_branch)
  WHERE task_branch IS NOT NULL;
