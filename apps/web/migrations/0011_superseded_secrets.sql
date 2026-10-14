-- PR-13. A replaced development secret's old row moves here instead of being
-- deleted: a sandbox that was sent the old value still holds it, and the
-- session object's redactor is rebuilt from the rows it sent, by id, after a
-- wake. Same columns as development_secret, no uniqueness on the name. A
-- deletion removes the name's rows from both tables.
CREATE TABLE IF NOT EXISTS development_secret_superseded (
  secret_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  repository_connection_id TEXT NOT NULL REFERENCES repository_connection (repository_connection_id),
  name TEXT NOT NULL,
  value_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_development_secret_superseded_scope_name
  ON development_secret_superseded (workspace_id, repository_connection_id, name);
