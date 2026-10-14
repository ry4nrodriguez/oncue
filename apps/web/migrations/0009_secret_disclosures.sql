-- PR-13. Its own migration rather than part of 0008: 0008 had already been
-- applied to a local database when this table was designed, and a migration
-- that has run anywhere is never edited.
--
-- The names a repository's project file declared the last time the workspace
-- launched a session on it. The disclosure card marks a name that is not in
-- this list, so a repository that starts asking for something new does not
-- get it behind a card the user has learned to click through. Names only.
CREATE TABLE IF NOT EXISTS repository_secret_disclosure (
  repository_connection_id TEXT PRIMARY KEY REFERENCES repository_connection (repository_connection_id),
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  names_json TEXT NOT NULL,
  disclosed_at TEXT NOT NULL
);
