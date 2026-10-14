-- The harness a session runs (the harness-adapters brief, section 4.3): the
-- session list and the session object agree on it before any sandbox exists.
-- Chosen once at creation by `resolveRuntime` (`worker/runtime/resolve.ts`)
-- and never changed. Every session from before the choice ran OpenCode, which
-- the default says. 0016 because 0015 is taken by an open branch.
ALTER TABLE session_index ADD COLUMN runtime TEXT NOT NULL DEFAULT 'opencode';
