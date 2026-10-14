-- Migration 0002: identity and private workspaces (record 05).
--
-- Five tables. Internal `user.id` / `workspace.id` values are DERIVED from
-- the Clerk subject (worker/auth/register.ts), not randomly minted, so
-- registration is four unconditional `INSERT ... ON CONFLICT DO NOTHING`
-- statements in one `db.batch()`. The constraints below are what make that
-- safe under a concurrent first sign-in: D1 `batch()` rolls the whole batch
-- back on a constraint violation, so at most one of two racing batches
-- survives and the loser's rows (including its workspace) never land.

-- user: the internal OnCue account. Status carries the record-05 account
-- lifecycle (active / disabled / deletion_requested); PR-04 only ever writes
-- 'active', the other two states belong to a later PR's transitions.
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deletion_requested')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- external_identity: the link from an external identity provider's subject
-- to an internal user. PRIMARY KEY (provider, subject) is the uniqueness
-- constraint record 05 requires on the external identity reference: a
-- second registration attempt for the same Clerk subject can never create a
-- second user.
CREATE TABLE IF NOT EXISTS external_identity (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- Access pattern: given an internal user id, list the external identities
-- linked to it (account-lifecycle and support tooling; not on the hot path,
-- which derives ids from the subject instead of querying this table).
CREATE INDEX IF NOT EXISTS idx_external_identity_user
  ON external_identity (user_id);

-- workspace: the top-level ownership boundary (record 05). `kind` is
-- constrained to 'private' because shared workspaces are deferred; widening
-- it is a future migration, not an application-level check.
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES user (id),
  kind TEXT NOT NULL CHECK (kind IN ('private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The private-workspace uniqueness constraint record 05 requires: one owner
-- can hold at most one private workspace. Partial so a future non-private
-- kind is never limited to one row per owner by this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_owner_private
  ON workspace (owner_user_id)
  WHERE kind = 'private';

-- workspace_member: user-to-workspace relationship and role. PRIMARY KEY
-- (workspace_id, user_id) makes the owner-membership insert in registration
-- idempotent the same way the other three inserts are.
CREATE TABLE IF NOT EXISTS workspace_member (
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  user_id TEXT NOT NULL REFERENCES user (id),
  role TEXT NOT NULL CHECK (role IN ('owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Access pattern: given a user, list the workspaces they belong to. Every
-- MVP user has exactly one row here, but the table (per record 05) is
-- already shaped for shared workspaces later.
CREATE INDEX IF NOT EXISTS idx_workspace_member_user
  ON workspace_member (user_id);

-- deletion_request: step 2 of record 05's account/session deletion flow.
-- PR-04 only records the request (steps 1-3: authenticated owner requests
-- it, a fresh authorization check runs, the session moves to
-- deletion_pending). Stopping sandboxes, revoking credentials, and receipt
-- fields are PR-14's 0008_operations.sql.
CREATE TABLE IF NOT EXISTS deletion_request (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session_index (session_id),
  workspace_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL
);

-- Access pattern: has this session already got a pending deletion request,
-- and a session's deletion history in time order.
CREATE INDEX IF NOT EXISTS idx_deletion_request_session
  ON deletion_request (session_id, requested_at);
