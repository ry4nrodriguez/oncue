-- Session status dots (feat/session-status-dots). The sidebar marks each
-- session as working, waiting on the user, or finished since it was last
-- opened, and it must learn that from D1 without waking any session object.
-- `waiting_for_user` (0010) already says whether a card is open; these two say
-- which run is current and what state the object's own `run` row holds for
-- it, so the browser can tell a run in progress from one that ended, and tell
-- one ended run from the next.
--
-- Projected by the session object with every snapshot, from the object's
-- `session.current_run_id` and that run's `run.state` (record 03, "Projection
-- rules"). NULL on every existing row until its session next commits, which
-- the sidebar reads as no status at all. No index: the list reads these
-- columns off rows `idx_session_index_workspace_state` already finds.
ALTER TABLE session_index ADD COLUMN current_run_id TEXT;
ALTER TABLE session_index ADD COLUMN current_run_state TEXT;
