-- Migration 0004: GitHub connections (record 07, "GitHub and Git Workflow").
--
-- Three new tables and three session_index columns. `github_installation` and
-- `repository_connection` are the two rows record 07's "Repository connection
-- flow" says D1 stores at step 6: the installation reference, and the
-- selected repository metadata, for the user's private workspace. Split into
-- two tables (not one) because they have different owners in GitHub's own
-- model: a user installs the App once and then picks repositories from it,
-- so one installation legitimately backs many `repository_connection` rows,
-- and a repository can be disconnected and reconnected without touching the
-- installation's tokens at all.
--
-- `webhook_delivery` exists only to make "Webhooks and synchronization"'s
-- at-least-once promise true: it says delivery and event identifiers are
-- stored so a repeated webhook is safe, and a PRIMARY KEY on GitHub's own
-- delivery id is what makes a replay a no-op insert failure rather than a
-- second processing pass.
--
-- No column in either GitHub table is ever readable as a credential.
-- AGENTS.md's security rules apply to every read of `user_token_reference`
-- and `refresh_token_reference` the same way they apply to
-- `model_connection.credential_reference` in 0003.

-- github_installation: one row per GitHub App installation linked to a
-- workspace. `github_installation_id` is GitHub's own identifier, and step 5
-- of the connection flow is explicit that it "is never trusted on its own;
-- GitHub documents that it can be spoofed" — every row here was created only
-- after OnCue called `GET /user/installations` with a verified user access
-- token and saw the installation in that authenticated list, never from the
-- installation id alone arriving on a redirect or a webhook.
CREATE TABLE IF NOT EXISTS github_installation (
  installation_row_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  -- GitHub's id for the installation. Kept as its own column, separate from
  -- the primary key, precisely because step 5 forbids trusting it alone: a
  -- webhook or redirect can name this value, but only the verified flow above
  -- may ever INSERT or UPDATE the row it names.
  github_installation_id INTEGER NOT NULL,
  -- The verified GitHub user who performed the authorization-code exchange at
  -- step 4, recorded so a later re-verification (step 7) confirms the SAME
  -- person, not merely that the installation still exists.
  github_user_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  -- CHECKed rather than validated in application code, matching 0003's
  -- `provider` column: GitHub's own installation target account type is
  -- always one of these two, and a third value reaching this table would
  -- mean OnCue mis-parsed a GitHub response rather than that the product
  -- gained a new legal case.
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  -- "Webhooks and synchronization"'s four disabling events collapse to one
  -- closed set: 'suspended' is an `installation` webhook's suspend action,
  -- 'deleted' is that same webhook's delete action, and 'unauthorized' is
  -- step 8's "refresh or verification fails" case, distinct from 'deleted'
  -- because the installation itself may still exist on GitHub's side. The
  -- CHECK is closed here, not in application code, for the same reason 0003
  -- closes `model_connection.status`: a fifth state is a migration, not a
  -- silently-accepted string.
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted', 'unauthorized')),
  -- Sealed credential envelopes, never plaintext, exactly as 0003's
  -- `credential_reference` and for the same reason: step 6 says the user
  -- access token and refresh token are "stored as encrypted credential
  -- envelopes under the same rules as model credentials". See
  -- `worker/broker/envelope.ts`.
  user_token_reference TEXT NOT NULL,
  refresh_token_reference TEXT NOT NULL,
  user_token_expires_at TEXT NOT NULL,
  refresh_token_expires_at TEXT NOT NULL,
  -- The clock step 7 names: "again after at most eight hours during
  -- continued work, OnCue refreshes the user token when needed and confirms
  -- ... that the user can still access the installation and repository".
  -- This column is what a session-start check compares against to decide
  -- whether that confirmation is due.
  last_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The one-installation-per-workspace-per-GitHub-installation uniqueness a
-- correct connection flow implies: re-running the flow for an installation
-- the workspace already linked must update that row, not mint a second one
-- with its own, now-stale, tokens.
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installation_workspace_github_id
  ON github_installation (workspace_id, github_installation_id);

-- Access pattern: an `installation` webhook names only GitHub's installation
-- id (never a workspace), so the handler that applies "Webhooks and
-- synchronization"'s suspend/delete transitions has to find the row by that
-- id alone.
CREATE INDEX IF NOT EXISTS idx_github_installation_github_id
  ON github_installation (github_installation_id);

-- repository_connection: one row per repository the user selected at step 3,
-- scoped to the installation that grants access to it. `full_name` and
-- `default_branch` are cached projections of GitHub state, refreshed by the
-- reconciliation action "Webhooks and synchronization" describes; they are
-- not the authoritative record of either fact, which stays with the GitHub
-- API.
CREATE TABLE IF NOT EXISTS repository_connection (
  repository_connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  installation_row_id TEXT NOT NULL REFERENCES github_installation (installation_row_id),
  github_repository_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  -- 'verified' is a repository the connection flow's authenticated-list check
  -- currently confirms; 'disconnected' is "Webhooks and synchronization"'s
  -- `installation_repositories` removal case, kept as a row rather than a
  -- delete so a session that already started on it keeps a reference to
  -- describe in its own history. There is no third state: a repository is
  -- either currently usable or it is not, and record 07 names no
  -- intermediate case.
  status TEXT NOT NULL CHECK (status IN ('verified', 'disconnected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Access pattern: re-running the connection flow for a repository the
-- workspace already selected must update that row, the same reasoning as
-- `idx_github_installation_workspace_github_id` above, one level down the
-- installation-to-repository relationship.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_connection_workspace_repo
  ON repository_connection (workspace_id, github_repository_id);

-- Access pattern: an installation being suspended or deleted must disable
-- every repository connection it backs ("installation deletion or suspension
-- disables the installation"), which is a lookup by installation, not by
-- workspace or repository.
CREATE INDEX IF NOT EXISTS idx_repository_connection_installation
  ON repository_connection (installation_row_id);

-- webhook_delivery: the at-least-once ledger "Webhooks and synchronization"
-- requires. `delivery_id` is GitHub's `X-GitHub-Delivery` header value, which
-- GitHub mints fresh per delivery attempt INCLUDING redeliveries of the same
-- underlying event, so a PRIMARY KEY on it is exactly the "delivery
-- identifiers ... are stored so repeated events are safe" guarantee: a
-- redelivered webhook fails its INSERT and the handler treats that failure as
-- "already applied", never as an error.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Access pattern: bounded retention sweep. This table exists only to answer
-- "have we seen this delivery id", so old rows carry no product value once
-- GitHub's own redelivery window has passed; a sweep by received_at is how
-- the table stays small.
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_received
  ON webhook_delivery (received_at);

-- "One branch per session" requires every session to record which repository
-- it works against, its task branch, and the exact commit it started from.
-- These three columns are nullable because a PR-05 session predates this
-- migration and because a fake-driver session (no repository connected) is
-- still a legal session; a NOT NULL constraint here would break both. The
-- foreign key is the same authorization boundary 0003 draws on
-- `model_connection`: a session may only name a repository connection that
-- exists, and D1 will not let this column outlive the row it references.
ALTER TABLE session_index ADD COLUMN repository_connection_id TEXT
  REFERENCES repository_connection (repository_connection_id);

-- The unique task-branch name record 07 mints per session, e.g.
-- `oncue/fix-login-7f3a`. Recorded so every remote Git operation in the
-- credential-boundary flow can be checked against the one ref the session is
-- allowed to touch, per "One branch per session"'s ownership rule.
ALTER TABLE session_index ADD COLUMN task_branch TEXT;

-- The exact base commit the session began from ("One branch per session").
-- Kept alongside `task_branch` rather than only in the session's own event
-- log so a durable-recovery read can answer "what did this session start
-- from" with the same one-row read `session_index` already serves for
-- everything else in this table.
ALTER TABLE session_index ADD COLUMN base_commit_sha TEXT;
