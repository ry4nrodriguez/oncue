-- Settings, Repositories gains Remove (feat/ui-polish-and-model-catalog).
-- A removed repository is hidden from OnCue and refused for new sessions,
-- while the GitHub App keeps whatever access GitHub grants it: which
-- repositories the App sees is chosen on GitHub, not here (record 07), so
-- this is a preference of the workspace's, kept as a timestamp rather than a
-- status because it must survive the connection flow's re-sync, which
-- rewrites `status` for every row the installation still grants. NULL is the
-- ordinary row. Restore clears it.
ALTER TABLE repository_connection ADD COLUMN removed_at TEXT;
