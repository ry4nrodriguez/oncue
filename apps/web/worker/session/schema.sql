-- The session Durable Object's SQLite schema (record 03). It runs on every
-- wake, so every statement is IF NOT EXISTS. There is no migration mechanism:
-- an existing table never gains a column, so later additions are new tables.
--
-- The event table is the source of truth; run, approval, sandbox_attachment,
-- checkpoint, artifact, and review_item are same-transaction caches of it.

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  owner_user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'deletion_pending')),
  title TEXT,
  current_run_id TEXT,
  sandbox_generation INTEGER NOT NULL DEFAULT 0,
  -- Not derivable from the event table: ephemeral frames consume a runtime
  -- sequence but are never stored. NULL before this generation's first frame.
  last_runtime_sequence INTEGER,
  protocol_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  trigger TEXT NOT NULL,
  instruction_message_id TEXT,
  continues_run_id TEXT,
  sandbox_generation INTEGER NOT NULL,
  created_by_command_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_session ON run (session_id);

-- session_sequence is the rowid, so replay is a rowid range scan. The object
-- assigns it explicitly so the stored value matches what it broadcast.
CREATE TABLE IF NOT EXISTS event (
  session_sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  run_id TEXT,
  sandbox_generation INTEGER NOT NULL,
  runtime_sequence INTEGER,
  occurred_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL
) STRICT;

-- Duplicate event ids are rejected by storage, not only in memory.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_event_id ON event (event_id);

-- One committed frame per sandbox-origin slot. Partial because control-origin
-- events have a NULL runtime_sequence.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_generation_runtime_sequence
  ON event (sandbox_generation, runtime_sequence)
  WHERE runtime_sequence IS NOT NULL;

-- Hot paths (every bridge frame, every rearm) read the log by type and by
-- generation, and Durable Objects are billed by rows read, so these reads must
-- never scan the table (record 01). The partial index above cannot serve a
-- generation-only filter, so idx_event_generation is not redundant. Entries end
-- in the rowid, so "newest of a type in a generation" is one step from the
-- index's end.
CREATE INDEX IF NOT EXISTS idx_event_type_generation ON event (event_type, sandbox_generation);
CREATE INDEX IF NOT EXISTS idx_event_generation ON event (sandbox_generation);

-- The same order without a subagent's own messages and calls, which carry its
-- `agentId` (record 12). The resume replay reads the primary agent's rows of a
-- type newest first to a bound, and a run's subagents can write far more rows
-- than it does, so that read must not walk theirs. An index on the stored JSON
-- rather than a column, because an existing table never gains one; every row
-- written before subagents has no `agentId` and is in it. SQLite refuses to
-- read JSON nested past its depth limit, which a sandbox's tool input can be,
-- so the test is guarded: such a row is stored and counted as the primary
-- agent's rather than failing its insert.
CREATE INDEX IF NOT EXISTS idx_event_primary_type ON event (event_type, sandbox_generation)
  WHERE CASE WHEN json_valid(envelope_json) THEN json_extract(envelope_json, '$.payload.agentId') END IS NULL;

-- Command idempotency (record 01): a retry returns result_json verbatim.
CREATE TABLE IF NOT EXISTS command (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  command_type TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  issued_by_user_id TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (result_kind IN ('acknowledged', 'rejected')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'approved', 'rejected', 'expired')),
  title TEXT NOT NULL,
  intended_action TEXT NOT NULL,
  category TEXT NOT NULL,
  risk TEXT NOT NULL,
  resource TEXT NOT NULL,
  requested_scope TEXT NOT NULL,
  tool_call_id TEXT,
  requested_generation INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decided_command_id TEXT,
  decided_for_generation INTEGER,
  decided_at TEXT,
  expired_effect TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_approval_run ON approval (run_id);

-- Keyed by generation so a replaced generation's row stays readable (record 01).
CREATE TABLE IF NOT EXISTS sandbox_attachment (
  generation INTEGER PRIMARY KEY,
  provider TEXT,
  provider_sandbox_id TEXT,
  state TEXT,
  last_heartbeat_at TEXT,
  runtime_protocol_version INTEGER,
  started_at TEXT,
  expires_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS checkpoint (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  head_sha TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  checksum TEXT,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'created', 'failed')),
  classification TEXT,
  object_key TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_item (
  id TEXT PRIMARY KEY,
  pull_request_number INTEGER NOT NULL,
  action_state TEXT NOT NULL,
  github_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A pending projection to D1. The row's existence is the pending flag; the
-- drain deletes it once applied.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  fact_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_outbox_sequence ON outbox (sequence);

-- What the object owes the current bridge. A row is an intent, never a
-- credential: `payload_json` holds only the coordinates a token is minted
-- from, at send time.
CREATE TABLE IF NOT EXISTS bridge_dispatch (
  intent_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  -- Later grant kinds are stored as 'git_grant' because existing objects keep
  -- this CHECK; payload_json holds the real kind (`DISPATCH_COLUMN_KIND`).
  kind TEXT NOT NULL CHECK (kind IN ('command', 'model_grant', 'git_grant')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'accepted', 'rejected')),
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;

-- Redelivery reads by generation and unsettled state; an ack reads the key.
CREATE INDEX IF NOT EXISTS idx_bridge_dispatch_open ON bridge_dispatch (generation, state);

-- A `run_next` follow-up waiting for the active run to end, released in
-- insertion order, one per terminal event. Survives a generation change.
CREATE TABLE IF NOT EXISTS queued_message (
  message_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  issued_by_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  held_at TEXT NOT NULL,
  released_at TEXT,
  released_run_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_queued_message_open ON queued_message (held_at) WHERE released_at IS NULL;

-- The effort a queued follow-up named. No row keeps the model record's effort;
-- a NULL `effort` means the model has no effort parameter.
CREATE TABLE IF NOT EXISTS queued_message_effort (
  message_id TEXT PRIMARY KEY,
  effort TEXT
) STRICT;

-- The bridge bootstrap credential's SHA-256, per generation. The credential
-- itself is never stored, so reading this database cannot open a bridge
-- socket. Compared in constant time.
CREATE TABLE IF NOT EXISTS bridge_credential (
  generation INTEGER PRIMARY KEY,
  credential_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- The session's repository, set at creation: identifiers only, never
-- credentials. No row means no repository and no git grant.
CREATE TABLE IF NOT EXISTS session_repository (
  session_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  -- NULL until the first push names the branch (record 07). Older objects
  -- hold the name from creation.
  task_branch TEXT,
  base_sha TEXT NOT NULL,
  git_grant_revoked INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The base branch cloned before the task branch exists, and the name the user
-- asked for, consumed when the branch is named. One row, written at creation.
CREATE TABLE IF NOT EXISTS session_branch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_branch TEXT NOT NULL,
  requested_name TEXT
) STRICT;

-- Present only when the user chose, at creation, to work directly on an
-- existing branch (record 07): `session_repository.task_branch` holds it from
-- creation, and before each push grant the object confirms with GitHub that
-- it is still there, unprotected, and not the default branch. Read when a
-- checkpoint or pull request is made, never per frame.
CREATE TABLE IF NOT EXISTS session_existing_branch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- 1 once the session adopted a pull request a person opened for the branch:
  -- its title and description stay theirs, and only the verification section
  -- is OnCue's to write.
  pull_request_adopted INTEGER NOT NULL DEFAULT 0 CHECK (pull_request_adopted IN (0, 1))
) STRICT;

-- Written when the task branch is named for a push grant (record 07). Until a
-- push lands, the name has no ref and is not a clone target. Absent on older
-- objects, whose branch always existed.
CREATE TABLE IF NOT EXISTS task_branch_ref (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- 1 once a push has landed on the branch; 0 from the mint until then.
  pushed INTEGER NOT NULL CHECK (pushed IN (0, 1))
) STRICT;

-- The latest moment a generation's create may start a sandbox (the
-- `notAfter` the driver sends). Written before each create attempt, so the
-- failed generation's stop sweep and a lost provisioning's recovery wait until
-- a create in flight can no longer land. Its own table, because CREATE TABLE
-- IF NOT EXISTS reaches existing objects and a new column would not.
CREATE TABLE IF NOT EXISTS create_deadline (
  generation INTEGER PRIMARY KEY,
  not_after_ms INTEGER NOT NULL
) STRICT;

-- A stop by name owed once a generation's last create can no longer land
-- (`create_deadline` plus grace): a stop or a sweep that ran earlier may have
-- found nothing while the create was still in flight. The alarm runs it, so it
-- survives an eviction. Rows are deleted once done.
CREATE TABLE IF NOT EXISTS late_stop (
  generation INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_late_stop_due ON late_stop (due_at_ms);

-- A generation's stop and the step it reached (`lifecycle.ts`), so a double
-- alarm or an eviction resumes rather than repeats a step.
CREATE TABLE IF NOT EXISTS sandbox_stop (
  generation INTEGER PRIMARY KEY,
  cause TEXT NOT NULL CHECK (cause IN ('idle', 'lifetime_ceiling', 'user_requested')),
  step TEXT NOT NULL CHECK (step IN ('checkpoint', 'awaiting_checkpoint', 'revoke', 'terminate', 'replace', 'done')),
  started_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  warning TEXT,
  requested_by_user_id TEXT,
  interrupted_run_id TEXT
) STRICT;

-- When to next ask the provider whether a disconnected generation still
-- exists (record 02).
CREATE TABLE IF NOT EXISTS sandbox_probe (
  generation INTEGER PRIMARY KEY,
  due_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL
) STRICT;

-- One-time tokens for an artifact upload or a patch bundle restore. Only the
-- hash is kept; `used_at` makes each token single use.
CREATE TABLE IF NOT EXISTS artifact_access (
  token_sha256 TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('upload', 'restore')),
  generation INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT
) STRICT;

-- One row per check attempt. The completion gate (record 14) reads this by
-- primary-key prefix, never the event log, so it costs only the run's rows.
CREATE TABLE IF NOT EXISTS verification_check (
  run_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  sandbox_generation INTEGER NOT NULL,
  classification TEXT NOT NULL,
  revision TEXT NOT NULL,
  result TEXT,
  evidence_artifact_id TEXT,
  PRIMARY KEY (run_id, check_id, attempt)
) STRICT;

-- The bridge's rollup, used only to cross-check the gate's own count.
CREATE TABLE IF NOT EXISTS run_verification (
  run_id TEXT PRIMARY KEY,
  required_total INTEGER NOT NULL,
  user_skipped_count INTEGER NOT NULL,
  sandbox_generation INTEGER NOT NULL
) STRICT;

-- A request to skip required checks, keyed by its instruction message; the
-- row's existence is the flag.
CREATE TABLE IF NOT EXISTS check_skip_request (
  message_id TEXT PRIMARY KEY
) STRICT;

-- The Git policy in force and at most one open proposal (records 07 and 09).
-- No row means the default. Read by key, never per frame. `open_*` are all
-- null or all set.
CREATE TABLE IF NOT EXISTS session_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy_json TEXT NOT NULL,
  open_proposal_id TEXT,
  open_base_version INTEGER,
  open_to_json TEXT
) STRICT;

-- Steers sent into a run, so a `policy.proposed` frame's message can be
-- checked by key instead of trusting the sandbox or scanning the log.
CREATE TABLE IF NOT EXISTS run_message (
  message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
) STRICT;

-- Proposals admitted per run, so a sandbox cannot fill the log with them.
CREATE TABLE IF NOT EXISTS run_proposal_count (
  run_id TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
) STRICT;

-- A publish is a push the object asked for. Push reports naming any other
-- push are refused; at most one publish per run and one open at a time. Read
-- by key, never per frame.
CREATE TABLE IF NOT EXISTS publish (
  push_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('requested', 'pushed', 'failed', 'nothing_to_push')),
  head_sha TEXT,
  requested_at TEXT NOT NULL,
  -- When the checkpoint report ending this publish arrived. Only a report with
  -- a publish waiting triggers GitHub calls, so a sandbox cannot drive them by
  -- repeating the frame.
  reported_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_publish_open ON publish (state) WHERE state = 'requested';
CREATE INDEX IF NOT EXISTS idx_publish_unreported ON publish (requested_at) WHERE reported_at IS NULL;
-- The newest publish, for the pull request a publish's report opens or updates.
CREATE INDEX IF NOT EXISTS idx_publish_requested_at ON publish (requested_at);

-- The session's draft pull request; no row means none is ever opened. `number`
-- is null until it is opened, then the same one is updated (record 07). Read
-- when a publish ends, never per frame.
CREATE TABLE IF NOT EXISTS pull_request (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_branch TEXT NOT NULL,
  app_origin TEXT NOT NULL,
  number INTEGER,
  url TEXT,
  section_version INTEGER NOT NULL DEFAULT 0,
  -- From the `pull_request` webhook. OnCue only opens drafts.
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed', 'merged'))
) STRICT;

-- A check's display name for the verification section. Sandbox text, never
-- evidence; cleaned before it reaches a pull request body.
CREATE TABLE IF NOT EXISTS verification_check_name (
  run_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (run_id, check_id)
) STRICT;

-- Serves "is one open" and "earliest expiry" on each rearm. Partial, so
-- closed approvals cost those reads nothing.
CREATE INDEX IF NOT EXISTS idx_approval_open ON approval (expires_at) WHERE state = 'requested';

-- `sandbox_ref` is the sandbox's own request id, used only to tell the bridge
-- which call was answered; never shown, stored in an event, or accepted from a
-- browser. `delivered_generation` is set when the bridge acknowledges the value.
CREATE TABLE IF NOT EXISTS approval_request (
  approval_id TEXT PRIMARY KEY,
  sandbox_ref TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  delivered_generation INTEGER
) STRICT;

-- Approvals admitted per run; one keyed row, so the bound costs one read.
CREATE TABLE IF NOT EXISTS run_approval_count (
  run_id TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
) STRICT;

-- Counted refusals per generation: a reconnect does not reset it, and a new
-- sandbox starts clean so an earlier generation's refusals do not last forever.
CREATE TABLE IF NOT EXISTS approval_refusal_count (
  generation INTEGER PRIMARY KEY,
  refused INTEGER NOT NULL
) STRICT;

-- Whether the launch's project file was refused; such a session cannot end
-- verified, since the file may name a required secret. One row.
CREATE TABLE IF NOT EXISTS session_declaration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  invalid INTEGER NOT NULL CHECK (invalid IN (0, 1))
) STRICT;

-- Secrets sent to a generation, written before the frame leaves, so the
-- redactor can be rebuilt after a wake by row id even if the value was since
-- replaced. Names and ids only.
CREATE TABLE IF NOT EXISTS secret_sent (
  generation INTEGER NOT NULL,
  secret_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (generation, secret_id)
) STRICT;

-- Bounds the unrequested `secret_in_changes` push reports stored per generation.
CREATE TABLE IF NOT EXISTS secret_withholding_count (
  generation INTEGER PRIMARY KEY,
  stored INTEGER NOT NULL
) STRICT;

-- The secret declaration pinned at launch (record 08); mid-run requests are
-- judged against it, never the bridge's later read. Names only. `selected`
-- marks names confirmed at launch.
CREATE TABLE IF NOT EXISTS session_secret (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('required', 'optional')),
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  supplied_generation INTEGER
) STRICT;

-- The latest agent description of its pull request (record 07).
-- `applied_version` is what the pull request last took, so it is rewritten
-- only when there is something new. Never read per frame.
CREATE TABLE IF NOT EXISTS pull_request_description (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT,
  body TEXT,
  branch_name TEXT,
  version INTEGER NOT NULL,
  applied_version INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Descriptions admitted per run; one keyed row, so the bound costs one read.
CREATE TABLE IF NOT EXISTS run_description_count (
  run_id TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
) STRICT;

-- Agent commits admitted per run: the object's own bound on rows from an
-- untrusted peer, looser than the bridge's (record 07).
CREATE TABLE IF NOT EXISTS run_commit_count (
  run_id TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
) STRICT;

-- One-time tokens for the bridge to fetch a message's attachment
-- (docs/decisions.md). Separate because `artifact_access`'s CHECK cannot gain
-- a purpose on existing objects. Only the hash is kept.
CREATE TABLE IF NOT EXISTS attachment_access (
  token_sha256 TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT
) STRICT;

-- The session's harness, written once at creation. No row means OpenCode.
-- Never read per frame.
CREATE TABLE IF NOT EXISTS session_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  runtime_id TEXT NOT NULL
) STRICT;

-- A subagent the run's agent started (record 12), written with its
-- `agent.started` and its `agent.completed`. Read by key when one of those
-- two frames, one of its own messages or calls, or a stop arrives, and by run
-- (at most `MAX_AGENTS_PER_RUN` rows a sandbox generation) when one starts or
-- its run is interrupted.
CREATE TABLE IF NOT EXISTS subagent (
  agent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_generation INTEGER NOT NULL,
  parent_tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result_summary TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_subagent_run ON subagent (run_id, status);

-- Counts a run's subagents on one sandbox generation, as the bridge counts
-- them: a run continued on a new sandbox starts again from none.
CREATE INDEX IF NOT EXISTS idx_subagent_run_generation ON subagent (run_id, sandbox_generation);

-- Serves "did the object allow this call to start a subagent" by key when one
-- is announced (record 12).
CREATE INDEX IF NOT EXISTS idx_approval_tool_call ON approval (tool_call_id);

-- The session's approval mode for the agent's own permission asks (record 09):
-- 'ask' or 'session'. No row is 'ask'; 'always' is the workspace's, in D1.
-- Read by its key once per ask.
CREATE TABLE IF NOT EXISTS session_approval_mode (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'session'))
) STRICT;

-- Categories a card allowed for the rest of this session; one row each, so
-- the read is bounded by the number of categories.
CREATE TABLE IF NOT EXISTS session_approval_rule (
  category TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

-- `approval_request`'s twin for a permission ask: the sandbox's own reference,
-- used only to tell the bridge which held call was answered, and the category,
-- which decides which answers a card may offer.
CREATE TABLE IF NOT EXISTS permission_request (
  approval_id TEXT PRIMARY KEY,
  sandbox_ref TEXT NOT NULL,
  category TEXT NOT NULL
) STRICT;

-- Permission asks admitted per run; one keyed row, so the bound costs one read.
CREATE TABLE IF NOT EXISTS run_permission_count (
  run_id TEXT PRIMARY KEY,
  asked INTEGER NOT NULL
) STRICT;

-- Questions the agent asked the user (record 12). `sandbox_ref` is the
-- bridge's own reference, used only to tell it which question was answered;
-- never shown or accepted from a browser. `questions_json` and `answers_json`
-- let an answer given after the sandbox stopped become the resumed run's
-- message. At most one is open.
CREATE TABLE IF NOT EXISTS question (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'dismissed')),
  sandbox_ref TEXT NOT NULL,
  requested_generation INTEGER NOT NULL,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  asked_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;

-- Serves "is one open" on every commit and rearm. Partial, so settled
-- questions cost those reads nothing.
CREATE INDEX IF NOT EXISTS idx_question_open ON question (asked_at) WHERE state = 'open';

-- Serves a reconnecting bridge's "what became of my question": its generation's newest.
CREATE INDEX IF NOT EXISTS idx_question_generation ON question (requested_generation);

-- Questions admitted per run; one keyed row, so the bound costs one read.
CREATE TABLE IF NOT EXISTS run_question_count (
  run_id TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
) STRICT;

-- Written once a delete reaches this object, including before any session
-- exists, and kept through erasure. A session id is derived from the create
-- request, so a create retried after a delete, or one that arrives after the
-- delete, would otherwise make the session again. Create and both socket
-- upgrades refuse while the row exists. Holds a time and nothing else.
CREATE TABLE IF NOT EXISTS session_tombstone (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  deleted_at TEXT NOT NULL
) STRICT;
