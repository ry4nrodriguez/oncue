-- PR-10: artifacts in R2, and the end of a generation's model access.
--
-- Record 03's artifact model has two halves. The bytes live in R2 under
-- `workspaces/{workspace}/sessions/{session}/runs/{run}/{artifact}`, and the
-- metadata lives with the session, where the session Durable Object's own
-- `artifact` table already holds it. `artifact_index` is record 03's "compact
-- artifact index projected into D1", for discovery across sessions. It is
-- written only after R2 has confirmed the object's size and checksum and the
-- session has committed `artifact.created`. The download route reads the
-- session object, not this table.
--
-- No foreign keys. Deleting a session (record 03, PR-14) removes its
-- artifacts and these rows together; a key to `session_index` here would make
-- the deletion step that exists today fail on a session with an artifact,
-- before the step that deletes artifacts exists.
CREATE TABLE IF NOT EXISTS artifact_index (
  -- The id the bridge declared on `artifact.uploading`, and the last segment
  -- of the object key. The protocol checks only its length; the key's
  -- workspace and session prefix is OnCue's.
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- `artifactKind` and `artifactProducer` in packages/protocol/src/schema.ts
  -- and families/artifacts.ts. The CHECK is the boundary validation.
  kind TEXT NOT NULL CHECK (kind IN ('log', 'screenshot', 'recording', 'patch', 'bundle', 'report', 'diff', 'tool_output', 'file')),
  producer TEXT NOT NULL CHECK (producer IN ('tool', 'verification', 'checkpoint', 'screenshot', 'log', 'agent')),
  content_type TEXT NOT NULL,
  -- What R2 stored, not what the bridge declared: the upload refuses a body
  -- whose length differs from the declaration before anything is written.
  byte_size INTEGER NOT NULL,
  -- Hex SHA-256 R2 verified on write.
  sha256 TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('essential_evidence', 'temporary')),
  -- Stored rather than rebuilt from the other columns, so a later change to
  -- the key layout cannot orphan an object written under the earlier one.
  object_key TEXT NOT NULL UNIQUE,
  -- Record 03's 90-day expiry for temporary artifacts; NULL for essential
  -- evidence.
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- Access pattern: a session's artifacts, newest last.
CREATE INDEX IF NOT EXISTS idx_artifact_index_session ON artifact_index (session_id, created_at);

-- The highest sandbox generation of this session that has ended and had its
-- credentials revoked. `readAuthorizedConnection` refuses a model broker token
-- whose generation is at or below it, which is how record 11's idle step 6
-- ends a stopped generation's model access at once instead of when the token
-- expires. NULL until a generation ends, so every session already running
-- when this migration applies keeps working.
ALTER TABLE session_index ADD COLUMN ended_sandbox_generation INTEGER;
