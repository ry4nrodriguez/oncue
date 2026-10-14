-- Session deletion (record 19): `deletion_request` becomes the deletion job's
-- work queue and, once the job finishes, its receipt.
--
-- The table is rebuilt because its `session_id` referenced `session_index`,
-- and the job's last step removes that row. A receipt has to outlive the row
-- it names, so the rebuilt table keeps the identifier without the key. SQLite
-- cannot drop a foreign key in place; nothing references this table, so it is
-- copied, dropped, and renamed.
--
-- A receipt holds identifiers, times, and status only, never content.
CREATE TABLE deletion_request_next (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  -- How many times the job has started on this request, and when it last did.
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  -- The step the last attempt stopped at, so a partial failure stays visible.
  -- NULL while nothing has failed and once the request is complete.
  failed_step TEXT CHECK (failed_step IN ('stop', 'r2', 'd1', 'object', 'receipt')),
  -- Set once, when the request is closed. NULL means the deletion is still owed.
  completed_at TEXT,
  -- How it closed: `deleted` by the batch that removes the `session_index`
  -- row, or `skipped` without touching the session when its index row was not
  -- `deletion_pending` (a request recorded before the object was told, whose
  -- session a projection had made active again). NULL while owed.
  outcome TEXT CHECK (outcome IN ('deleted', 'skipped')),
  skip_reason TEXT CHECK (skip_reason IN ('session_not_deleting'))
);

INSERT INTO deletion_request_next (id, session_id, workspace_id, requested_by_user_id, requested_at)
  SELECT id, session_id, workspace_id, requested_by_user_id, requested_at FROM deletion_request;

DROP TABLE deletion_request;

ALTER TABLE deletion_request_next RENAME TO deletion_request;

-- Access pattern: has this session already got a request, and a session's
-- deletion history in time order.
CREATE INDEX IF NOT EXISTS idx_deletion_request_session
  ON deletion_request (session_id, requested_at);

-- Access pattern: the scheduled job's next requests still owed, least
-- recently tried first. Partial so finished receipts never enter it.
CREATE INDEX IF NOT EXISTS idx_deletion_request_open
  ON deletion_request (last_attempt_at)
  WHERE completed_at IS NULL;
