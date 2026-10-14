-- Agent permissions (record 09, "Agent permissions"): how a workspace answers
-- the coding agent's own permission asks across sessions. A session's own
-- mode and rules live in its Durable Object; these are the workspace's.
--
-- No row means the default, `ask`: every ask shows a card unless the session
-- says otherwise. `always` answers every category but secret files.
CREATE TABLE workspace_approval_setting (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace (id),
  default_mode TEXT NOT NULL CHECK (default_mode IN ('ask', 'always')),
  updated_at TEXT NOT NULL
);

-- A category the user chose "Always allow" for on a card. Secret files can
-- never be saved: they ask in every mode.
CREATE TABLE workspace_approval_rule (
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  category TEXT NOT NULL CHECK (category IN ('outside_project', 'repeated_action', 'other_request')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, category)
);
