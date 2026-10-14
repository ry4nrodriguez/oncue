-- Model providers page (feat/ui-polish-and-model-catalog): the connection a
-- session's runs charge, projected onto the index at creation so the
-- settings page can say how many active sessions a key still serves before
-- it is revoked. The run record inside the object stays the source of truth;
-- this column is a projection of its first run's `modelConnectionId`, which
-- never changes for the life of the session (record 15: the model is chosen
-- once, on Home). NULL for sessions created before this migration and for
-- the fake driver's sessions, which charge nothing.
ALTER TABLE session_index ADD COLUMN model_connection_id TEXT;

-- Access pattern: count a workspace's active sessions per connection for the
-- Model providers page. Partial so rows without a connection stay out of it.
CREATE INDEX IF NOT EXISTS idx_session_index_model_connection
  ON session_index (workspace_id, model_connection_id, state)
  WHERE model_connection_id IS NOT NULL;
