-- Composer attachments (docs/plans/briefs/composer-attachments.md).
--
-- A person uploads an image or a file before the message that carries it
-- exists, and on Home before the session exists. So an upload belongs to the
-- workspace first, with `session_id` NULL, and a message claims it: the
-- Worker when it creates a session, the session object when it admits a
-- `run.start` or `run.follow_up`. A claim sets `session_id`, and a claimed
-- row is never claimed by another session. An upload nobody claims is removed
-- after a day by the scheduled sweep, bytes first.
--
-- The bytes live in R2 under `workspaces/{workspace}/attachments/{attachment}`.
-- The key is stored rather than rebuilt, like `artifact_index.object_key`, so
-- a later change to the layout cannot orphan an object.
--
-- No foreign keys, for `artifact_index`'s reason: deleting a session (record
-- 03) must be able to remove these rows and the rows they would point at in
-- either order.
CREATE TABLE IF NOT EXISTS message_attachment (
  -- Minted by the Worker at upload, never by the browser.
  attachment_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  uploaded_by_user_id TEXT NOT NULL,
  -- NULL until a message in that session claims the upload.
  session_id TEXT,
  -- The person's file name, cleaned (`cleanAttachmentName`). Shown as text and
  -- offered as a download name; never a path.
  name TEXT NOT NULL,
  -- From the bytes (`sniffAttachment`), never from the browser. The CHECK is
  -- the boundary validation, and it holds no type a browser would render as a
  -- page.
  content_type TEXT NOT NULL CHECK (content_type IN (
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'
  )),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  -- Hex SHA-256 R2 verified on write.
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  claimed_at TEXT
);

-- Access patterns: a session's attachments, and a workspace's unclaimed
-- uploads (the per-workspace cap and the sweep).
CREATE INDEX IF NOT EXISTS idx_message_attachment_session ON message_attachment (session_id);
CREATE INDEX IF NOT EXISTS idx_message_attachment_unclaimed
  ON message_attachment (workspace_id, created_at) WHERE session_id IS NULL;
