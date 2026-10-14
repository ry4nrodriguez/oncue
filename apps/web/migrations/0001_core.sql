-- Migration 0001: core D1 tables (record 03, "Suggested record model" / D1).
--
-- Five tables only. Everything else in record 03's D1 list (user, workspace,
-- repository_connection, ...) belongs to a later PR that adds identity and
-- integrations (see AGENTS.md scope discipline and DESIGN.md section 9:
-- "Where a command needs an owner, take the field now and pass a
-- placeholder"). workspace_id columns below are that placeholder: a plain
-- TEXT column with no foreign key yet, so the branch and its test exist now
-- rather than being retrofitted later.

-- task: a requested unit of work, before or across sessions.
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Access pattern: list a workspace's tasks newest first.
CREATE INDEX IF NOT EXISTS idx_task_workspace_created
  ON task (workspace_id, created_at);

-- session_index: the searchable summary and current projected state of a
-- session (record 03, "Session creation ordering"). The Worker inserts a row
-- here in state 'creating' before it ever calls the session Durable Object,
-- so 'creating' must be a legal state even though it is not one of the
-- protocol's own SessionState values (active, archived, deletion_pending;
-- packages/protocol/src/states.ts). A 'creating' row is never a usable
-- session (record 03 line 142).
--
-- last_projected_sequence is the monotonic guard for this row's own outbox
-- projection: the object's outbox drain only applies an update here when the
-- incoming outbox record's sequence is greater than the value already
-- stored, so redelivery and out-of-order delivery of the same projection are
-- no-ops rather than a race. It is a same-transaction cache of the session's
-- authoritative event log (DESIGN.md G7); the Durable Object's SQLite
-- database wins if the two ever disagree.
CREATE TABLE IF NOT EXISTS session_index (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT REFERENCES task (id),
  state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'archived', 'deletion_pending')),
  title TEXT,
  last_activity_at TEXT,
  sandbox_provider_ref TEXT,
  sandbox_generation INTEGER,
  last_projected_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Access pattern: list a workspace's sessions by current state (e.g. active
-- sessions for a dashboard).
CREATE INDEX IF NOT EXISTS idx_session_index_workspace_state
  ON session_index (workspace_id, state);

-- Access pattern: the creating-row sweep (record 03 line 140) finds rows
-- stuck in 'creating' older than a bounded window. Partial so the index
-- stays small once a session leaves 'creating' for good.
CREATE INDEX IF NOT EXISTS idx_session_index_creating_sweep
  ON session_index (created_at)
  WHERE state = 'creating';

-- platform_control: global run-admission state, the MVP identity allowlist
-- version, concurrent-sandbox safety settings, and the emergency-control
-- version (record 03). Exactly one row, id fixed at 1, so a read is always
-- "the row" or "no row" and never "which row" (worker/admission.ts, G5: both
-- the Worker and the session Durable Object read this table themselves and
-- fail closed when it is unreadable).
CREATE TABLE IF NOT EXISTS platform_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_admission TEXT NOT NULL CHECK (run_admission IN ('open', 'stopped')),
  platform_concurrent_sandbox_cap INTEGER NOT NULL,
  workspace_concurrent_sandbox_cap INTEGER NOT NULL,
  allowlist_version INTEGER NOT NULL,
  emergency_control_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO platform_control (
  id,
  run_admission,
  platform_concurrent_sandbox_cap,
  workspace_concurrent_sandbox_cap,
  allowlist_version,
  emergency_control_version,
  updated_at
) VALUES (
  1,
  'open',
  50,
  3,
  1,
  1,
  '2026-09-02T00:00:00.000Z'
);

-- projection_cursor: the last applied outbox position for a session (record
-- 03). This is the guard the outbox drain checks before applying a record:
-- "guarded by projected_sequence < / last_sequence <, so redelivery and
-- out-of-order delivery are no-ops" (DESIGN.md section 7).
CREATE TABLE IF NOT EXISTS projection_cursor (
  session_id TEXT PRIMARY KEY REFERENCES session_index (session_id),
  last_applied_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- audit_entry: a queryable index of security and product actions (record
-- 03). detail is a compact, already-redacted JSON string; no secret value is
-- ever written here (AGENTS.md security rules).
CREATE TABLE IF NOT EXISTS audit_entry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  session_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'sandbox')),
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL
);

-- Access pattern: a workspace's audit log in time order.
CREATE INDEX IF NOT EXISTS idx_audit_entry_workspace_time
  ON audit_entry (workspace_id, occurred_at);

-- Access pattern: a single session's audit trail in time order.
CREATE INDEX IF NOT EXISTS idx_audit_entry_session_time
  ON audit_entry (session_id, occurred_at);
