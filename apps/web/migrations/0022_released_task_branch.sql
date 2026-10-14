-- Session deletion (record 19): the receipt also remembers, for a few days and
-- as a hash only, the task branch its session pushed to.
--
-- The receipt batch removes the `session_index` row, and that row is how the
-- `push` webhook knows a ref is a session's branch. The branch itself stays on
-- GitHub, so a push delivered late, or redelivered, after the receipt would
-- look like the App pushing outside any session and lock down every session
-- of the repository (record 07). The webhook treats a ref whose hash a recent
-- receipt holds as a session branch.
--
-- The value is SHA-256 over the GitHub repository id and the full ref, never
-- the branch name, and the scheduled deletion sweep blanks it once the window
-- has passed (`worker/deletion/released-refs.ts`). NULL for a session with no
-- task branch and on every receipt written before this column.
ALTER TABLE deletion_request ADD COLUMN released_ref_hash TEXT;

-- Access pattern: the webhook's one lookup by hash, and the sweep's blanking
-- of old ones. Partial, so receipts without a hash never enter it.
CREATE INDEX IF NOT EXISTS idx_deletion_request_released_ref
  ON deletion_request (released_ref_hash)
  WHERE released_ref_hash IS NOT NULL;
