-- PR-12: which session owns a pull request.
--
-- GitHub's `pull_request` webhook names a repository and a pull request
-- number, and the Worker has to find the session that opened it to tell that
-- session its draft was marked ready, closed, merged, or reopened. The
-- session's own record of its pull request lives with the session (the
-- Durable Object's `pull_request` table); this column is the one fact the
-- Worker needs to route a delivery, written by the session object right after
-- GitHub answers the create. Identifiers only.
--
-- Null for a session with no pull request, which is most of them, so the index
-- is partial.
ALTER TABLE session_index ADD COLUMN pull_request_number INTEGER;

-- Access pattern: the `pull_request` webhook arm finds the session for one
-- repository connection and one number.
CREATE INDEX IF NOT EXISTS idx_session_index_pull_request
  ON session_index (repository_connection_id, pull_request_number)
  WHERE pull_request_number IS NOT NULL;
