-- Migration 0003: model connections (record 06, "Model connection record").
--
-- One table, and exactly the eleven fields record 06 lines 52 to 65 name. No
-- twelfth column: there is deliberately no `model_id`, no `is_default`, and no
-- `display_label` here. Record 15 separates "which account" (this row) from
-- "which model" (a run's own ModelRecord), and PR-06 ships one model per
-- provider owned by the provider adapter, so a model column would be a second
-- place for the same fact to go stale.
--
-- credential_reference holds the SEALED credential envelope itself, not a
-- pointer to ciphertext stored elsewhere. Record 06's rule is that plaintext
-- never reaches D1; ciphertext in D1 satisfies it, and the alternative (the
-- bytes in R2, a key here) buys no extra secrecy while adding a second store
-- to keep consistent and a second thing to delete. The envelope's own format
-- carries its key version, so this column is self-describing under rotation:
-- see worker/broker/envelope.ts.
--
-- No column here is ever readable as a credential. AGENTS.md's security rules
-- and record 06's "Credential storage" section both apply to every read of
-- this table.

CREATE TABLE IF NOT EXISTS model_connection (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  -- CHECKed rather than validated in application code, matching 0002's
  -- `workspace.kind`: widening the supported set is a future migration, so a
  -- provider name that no adapter can serve cannot reach the table at all.
  -- Record 06 approves exactly these two for the first version.
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('api_key', 'subscription')),
  credential_reference TEXT NOT NULL,
  -- Record 06 line 62's five values, in full. `expired` belongs to a
  -- subscription connection whose provider token lapsed, so no PR-06 code path
  -- writes it: both providers this PR ships are api_key. It is in the CHECK
  -- now rather than added later because the set is the record's, not this
  -- PR's, and a migration to widen a CHECK is more disruptive than one unused
  -- legal value.
  status TEXT NOT NULL CHECK (
    status IN ('active', 'invalid', 'expired', 'revoked', 'attention_required')
  ),
  provider_account_hint TEXT,
  expires_at TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Access pattern 1: `worker/setup/read.ts` reads a workspace's ACTIVE
-- connections on every /api/me, which is the request that gates first paint.
-- Access pattern 2: the model connections screen lists a workspace's
-- connections whatever their status. Both are covered by this one index; the
-- second is a prefix scan on workspace_id alone.
CREATE INDEX IF NOT EXISTS idx_model_connection_workspace_status
  ON model_connection (workspace_id, status);
