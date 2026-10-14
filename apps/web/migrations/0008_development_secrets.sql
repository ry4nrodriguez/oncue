-- PR-13. Development secrets, record 08: a value a project needs in order to
-- run in a development sandbox, saved once per workspace and repository.
--
-- The value is stored only as `value_reference`, a `sealCredential` envelope
-- (`worker/broker/envelope.ts`) whose additional data binds this row's own
-- `secret_id`, the workspace, and the secret's name. Ciphertext copied to
-- another row, another workspace, or another name fails to open rather than
-- opening as the wrong value. No route returns it, and the only function that
-- opens it is `openDevelopmentSecrets` in `worker/secrets/store.ts`.
--
-- AGENTS.md's security rules apply to every read of `value_reference` with
-- the same force they apply to 0003's and 0005's reference columns. Only
-- development and test credentials belong here; production credentials are
-- excluded by record 08, and the names of OnCue's own platform credentials
-- are refused before a row is written (`services/bridge/src/secret-names.ts`).

CREATE TABLE IF NOT EXISTS development_secret (
  -- OnCue's own id, because it is what the envelope binds and a value the
  -- envelope binds to must be one this control plane created.
  secret_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  -- One workspace AND one repository per secret (record 08). A repository
  -- file names a secret; it never chooses which stored value that means.
  repository_connection_id TEXT NOT NULL REFERENCES repository_connection (repository_connection_id),
  -- `^[A-Z][A-Z0-9_]{0,63}$`, checked in `services/bridge/src/secret-names.ts`. Rendered
  -- in the interface and used as an environment variable's name.
  name TEXT NOT NULL,
  value_reference TEXT NOT NULL,
  -- CHECKed rather than validated in application code, as 0003's and 0005's
  -- are. 'unreadable' is the value that stopped opening (a rotated keyring
  -- that dropped its version): record 08 says the dependent process is not
  -- launched and the user is asked to replace it. A delete removes the row.
  status TEXT NOT NULL CHECK (status IN ('active', 'unreadable')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The rule "one value per name per repository per workspace", and the index
-- every read uses: the settings list and the launch disclosure read by
-- (workspace, repository connection), and a mid-run approval reads one name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_development_secret_scope_name
  ON development_secret (workspace_id, repository_connection_id, name);
