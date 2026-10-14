-- Migration 0005: the workspace's Modal connection (record 02, "Sandbox
-- controller", under bring-your-own-Modal).
--
-- OnCue creates sandboxes in the USER's Modal workspace rather than its own,
-- so the token pair the sandbox controller acts on arrives per session from
-- this table. PR-08 unit 1 read that pair from three deployment bindings,
-- which was a placeholder: a deployment-wide pair would mean one Modal account
-- owning and paying for every user's sandboxes, which is the arrangement
-- bring-your-own-Modal exists to avoid. Those bindings are deleted in the same
-- change that adds this table.
--
-- One row per workspace, enforced by the UNIQUE on workspace_id rather than by
-- application code. A workspace is one person's private workspace and a person
-- has one Modal account; there is no product question a second row could
-- answer, and a table that cannot hold two makes "which one do we use" a
-- question nobody has to ask at read time.
--
-- token_id_reference and token_secret_reference hold SEALED credential
-- envelopes, exactly as 0003's `credential_reference` and 0004's two GitHub
-- token columns do, under the same scheme in `worker/broker/envelope.ts`. Both
-- halves are sealed and not just the secret: the pair is only useful together,
-- and sealing one while storing the other in the clear would put half a
-- credential in every backup for no gain. Each half binds its own provider
-- discriminator in the AEAD tag (`worker/modal/envelope-context.ts`), so a
-- ciphertext moved between the two columns, or lifted from another table,
-- fails to open rather than opening as the wrong value.
--
-- A Modal personal API token carries full authority over the user's entire
-- Modal workspace, and Modal offers scoped service users on Team and
-- Enterprise plans only. AGENTS.md's security rules apply to every read of the
-- two reference columns with the same force they apply to 0003's.

CREATE TABLE IF NOT EXISTS modal_connection (
  -- OnCue's own id, not anything Modal minted, because it is what the
  -- credential envelope binds as additional data and a value the envelope
  -- binds to must be one this control plane created. Separate from
  -- workspace_id so a disconnect and a reconnect are distinguishable rows in
  -- an audit trail rather than the same identity twice.
  connection_id TEXT PRIMARY KEY,
  -- UNIQUE is the one-connection-per-workspace rule, in the schema. The
  -- foreign key is 0003's, and for the same reason: a credential row must not
  -- outlive the workspace it belongs to.
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspace (id),
  token_id_reference TEXT NOT NULL,
  token_secret_reference TEXT NOT NULL,
  -- The Modal workspace name the credential test read back through
  -- `modal.Workspace.from_context`. Stored so the settings screen can show the
  -- user WHICH Modal workspace they connected without another round trip, and
  -- so a person who keeps a dedicated workspace for OnCue can see at a glance
  -- that they pasted the token they meant to. Not a secret and not an id.
  modal_workspace_name TEXT NOT NULL,
  -- NULL means the Modal workspace's default Environment, which is what most
  -- accounts have and what a personal token sees. Nullable rather than
  -- defaulted to a name, because "the default" is Modal's to decide and
  -- writing a guess here would send the controller to an Environment that may
  -- not exist.
  environment_name TEXT,
  -- CHECKed rather than validated in application code, matching 0003's
  -- `status` and 0004's: `worker/modal/connections.ts` casts this column
  -- instead of re-parsing it, and `migrations.test.ts` proves the constraint
  -- refuses anything outside the set, which is what makes the cast sound.
  --
  -- Two values, and only one of them is written today. 'invalid' is here for
  -- the credential that stops working after it was saved -- the user rotated
  -- it in Modal, or a service user lost its role -- which is a state the
  -- setup gate has to be able to see so it asks for the credential again. A
  -- disconnect DELETEs the row rather than adding a third value, because
  -- nothing references this table and destroying the sealed bytes is a
  -- stronger answer than flipping a column beside them.
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid')),
  last_validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- No index statement here on purpose. Every read of this table is by
-- workspace_id -- the setup gate on every /api/me, the settings screen, and
-- the per-session credential resolve -- and the UNIQUE constraint above
-- already creates the index those queries use. A second one would be the same
-- index under a different name.
