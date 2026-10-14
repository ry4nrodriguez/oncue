-- A subagent's start is an agent permission ask (record 09, "Agent
-- permissions"; record 12, "Subagents"), so a card's "Always allow" may save
-- it for the workspace like the other savable categories. SQLite cannot widen
-- a CHECK in place, so the table is rebuilt with every saved row kept.
-- Nothing references this table, so dropping the old one breaks no key.
-- 0021 because 0018 to 0020 are taken by open branches.
CREATE TABLE workspace_approval_rule_next (
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  category TEXT NOT NULL CHECK (
    category IN ('outside_project', 'repeated_action', 'start_subagent', 'other_request')
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, category)
);

INSERT INTO workspace_approval_rule_next (workspace_id, category, created_at)
SELECT workspace_id, category, created_at FROM workspace_approval_rule;

DROP TABLE workspace_approval_rule;

ALTER TABLE workspace_approval_rule_next RENAME TO workspace_approval_rule;
