-- PR-13, backlog A4. Whether a session is waiting on the user's click: an
-- approval card or a Git behavior card is open. Projected by the session
-- object with every snapshot, so the sidebar's "Needs you" group can be
-- answered from D1 without opening any object. 0 or 1; every existing row is 0.
ALTER TABLE session_index ADD COLUMN waiting_for_user INTEGER NOT NULL DEFAULT 0;
