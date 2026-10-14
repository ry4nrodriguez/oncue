# Data and artifact architecture

**Status:** Approved foundation

## Purpose

OnCue's data has three access patterns: a live session needs ordered, transactional state; dashboards and policy checks need queries across sessions; logs, patches, and uploaded files need cheap object storage. Each gets its own store:

| Store | Role |
|---|---|
| SQLite in each session Durable Object | Authoritative session state |
| Cloudflare D1 | Global records and queryable projections |
| Cloudflare R2 (`ARTIFACTS` binding) | Large and immutable bytes |

A transactional outbox moves selected session facts into D1.

## Storage ownership

**Session SQLite** is authoritative for facts local to a session: state and transitions, runs, messages, the ordered event log, commands and their idempotency results, approvals, sandbox generations, checkpoints, artifact metadata, and outbox rows. When a D1 projection disagrees with it, the session database wins.

**D1** holds what must be found or evaluated across sessions: identity and workspaces, connections (GitHub, model, Modal), development secret metadata and sealed values, the session index, platform controls, and indexes of artifacts and attachments. It never receives streamed tokens or command output. Provider keys, subscription tokens, and secret values are stored only sealed, never in plaintext, and never in events or projections.

**R2** holds artifact bytes (logs, patches and recovery bundles, diffs, reports, large tool output) and the files a person attaches to a message. R2 makes no access decision; every read passes the application's authorization first.

## Suggested record model

### Session database

The schema is `apps/web/worker/session/schema.sql`, applied on every wake. Every statement is `CREATE ... IF NOT EXISTS`, and a change adds a table rather than a column, because an existing object keeps the tables it already has. The event table is the source of truth; `session`, `run`, `approval`, `sandbox_attachment`, `checkpoint`, and `artifact` are snapshots written in the same transaction as the events that prove them.

| Table | Purpose |
|---|---|
| `session` | Identity, owner, state, workspace, current run, generation, runtime cursor |
| `run` | One run of agent work |
| `event` | Ordered durable events, with indexes for per-frame reads (record 01, "Read cost") |
| `command` | Processed commands and their results, for idempotency |
| `approval` | Protected actions and their decisions |
| `sandbox_attachment` | Provider reference, generation, and status per generation |
| `checkpoint` | Recoverable repository positions |
| `artifact` | Artifact identity, kind, object key, size, checksum, and state |
| `review_item` | Imported pull-request feedback. Exists; nothing writes it (record 16 is not built). |
| `outbox` | Projection rows awaiting delivery to D1 |

Tables added since, by concern:

| Concern | Tables |
|---|---|
| Bridge exchange | `bridge_dispatch` (commands and grant coordinates owed to the current bridge, never a credential), `bridge_credential` (SHA-256 of each generation's bootstrap credential), `queued_message` and `queued_message_effort` (a follow-up held until the active run ends, and its effort) |
| One-time tokens | `artifact_access` (upload and restore tokens), `attachment_access` (the bridge's fetch of an attachment). Only hashes are stored. |
| Sandbox lifecycle | `sandbox_stop` (the step a stop has reached), `sandbox_probe` (when to next ask the provider about a disconnected generation), `session_runtime` (the session's harness, written once) |
| Repository and Git | `session_repository` (repository, installation, task branch, base commit), `session_branch` (the base branch and the requested name until the first push names the branch), `task_branch_ref` (whether a minted branch name has a ref yet), `session_existing_branch` (present when the session works directly on an existing branch, and whether it adopted a person's pull request), `session_policy` (Git policy and any open widening proposal), `publish` (each user push, at most one open), `pull_request` (the draft pull request and GitHub's last reported state), `pull_request_description` (the agent's latest title, body, and branch name), `run_commit_count`, `run_description_count` |
| Verification | `verification_check` (one row per check attempt, read by the completion gate), `run_verification` (the bridge's rollup, as a cross-check), `check_skip_request`, `verification_check_name` |
| Approvals, proposals, and secrets | `approval_request`, `run_approval_count`, `approval_refusal_count`, `run_message` (a steer, so a proposal can name the message that asked for it), `run_proposal_count`, `session_declaration`, `session_secret` (declared names pinned at launch and the user's selection), `secret_sent` (which secrets each generation received, to rebuild the redactor), `secret_withholding_count` |

The `*_count` tables bound what the sandbox may submit per run or generation.

### D1

D1's schema is the migrations in `apps/web/migrations/`, `0001_core.sql` through `0022_released_task_branch.sql`.

| Table | Purpose | Migration |
|---|---|---|
| `session_index` | Searchable summary and projected state; later columns add the repository, task branch, base commit, ended generation, pull request number, `waiting_for_user`, model connection, current run and its state (NULL until the session's first commit after 0015), `runtime`, and the branch the session started from and its branch mode (NULL on older rows) | 0001, 0004, 0006, 0007, 0010, 0012, 0015, 0016, 0018 |
| `platform_control` | Run admission and concurrent-sandbox caps (record 01, "Run admission") | 0001 |
| `task`, `projection_cursor`, `audit_entry` | Exist; nothing writes them | 0001 |
| `user`, `external_identity`, `workspace`, `workspace_member` | Identity, the one private workspace | 0002 |
| `deletion_request` | A session deletion's work item and then its receipt: identifiers, times, attempts, the step a failed attempt stopped at, `completed_at`, and how it closed (`deleted`, or `skipped` with a reason). Rebuilt in 0019 without its key to `session_index`, so the receipt outlives the index row. `released_ref_hash` (0022) is a hash of the task branch the session left on GitHub, kept for three days (record 19) | 0002, 0019, 0022 |
| `model_connection` | Provider, auth type, status, sealed key | 0003 |
| `github_installation`, `repository_connection`, `webhook_delivery` | GitHub App installs, repositories (`removed_at` from 0013), webhook deduplication | 0004, 0013 |
| `modal_connection` | The workspace's sealed Modal credential | 0005 |
| `artifact_index` | Globally discoverable artifact metadata | 0006 |
| `development_secret`, `development_secret_superseded` | Repository secrets, sealed, and replaced values | 0008, 0011 |
| `repository_secret_disclosure` | Secret names a repository's project file declared at its last launch | 0009 |
| `message_attachment` | A person's uploads and the message that claimed each | 0014 |

Not built: `approval_index`, `usage_summary`, `outcome`, `notification`, and `push_subscription`. Session creation does not write `task`. Subscription model connections are allowed by the `auth_type` check but nothing creates one.

## Transactional outbox

SQLite and D1 cannot share a transaction, so the object uses an outbox (`worker/session/outbox.ts`):

1. It applies the session change in SQLite.
2. In the same transaction it inserts an outbox row: id, session id, sequence, fact type, schema version, compact payload.
3. After commit it sends the row to D1.
4. D1 applies it idempotently: the `session_index` update matches only when `last_projected_sequence` is lower than the row's sequence, so redelivery and reordering are no-ops.
5. The row is deleted once applied; its existence is the pending flag.

The projection worker is the Durable Object itself: it drains the outbox after commits and from its alarm, with exponential backoff capped at five minutes, so a D1 outage never becomes a hot loop and no separate process is needed.

The session view is current immediately; a global view may briefly lag. Interfaces tolerate that rather than pretend otherwise.

## Session creation ordering

Session creation touches both stores, so its order is fixed:

1. The Worker authorizes the request and generates the session id.
2. The Worker inserts a `session_index` row in state `creating` with the workspace, repository, and harness.
3. The Worker sends the create command to the session object. From here the object is authoritative.
4. The object commits the session, the first run, and an outbox row in one transaction; the projection moves the index row to `active`.
5. If step 3 fails, the Worker returns the error and the `creating` row remains.

A `creating` row is never shown as a usable session, and the command id makes a retry of step 3 safe. A cron trigger (every five minutes, `triggers` in `apps/web/wrangler.jsonc`) runs `sweepCreatingSessions` in `worker/routes/sessions.ts`. It reads at most 100 `creating` rows older than one hour (`CREATING_SWEEP_MAX_AGE_MS`) through the partial index `idx_session_index_creating_sweep` and asks each row's object whether it ever committed a session (`/internal/exists`). Only a row whose object says no is deleted, by key and only while still `creating`. An object that did commit has a projection owed; the probe retries its outbox drain, and the row stays. An object that cannot answer keeps its row until the next run. Waking an object that never held a session lays down its empty schema; nothing else is stored.

## Projection rules

Project only facts needed outside a session, each traced to an authoritative field. One exception to "the object's SQLite wins": a projection moves `session_index.state` only out of `creating` (`applyProjectionToD1` in `worker/session/object/commit.ts`). Archiving, restoring, and deleting change the object's state first and are written to the column by their routes after the object agrees, so an outbox row taken before one of them can never undo it, and a `deletion_pending` row never moves back. Projected today: session state and title, last activity, the sandbox provider reference and generation (so a sandbox can be found without the object), the ended generation (the broker refuses its tokens), whether the session is waiting for the user, the current run and its state, the task branch, and the pull request number. The session's model connection is written when the session is created and again by the commit that changes its model (record 15): that commit's snapshot is marked, and the projection writes the current run's connection whatever the row's sequence, so the fact is neither lost behind a later snapshot nor moved backwards. Messages, token deltas, terminal streams, and large tool results stay in session storage or R2.

## Rebuilding and reconciliation

Projections must be reconstructable: read the session summary and projection position, replay missing outbox rows or write a fresh snapshot, compare with D1, repair, and audit the repair. Not built. It is required before projections back usage reporting, compliance evidence, or irreversible policy actions.

## Artifacts

An artifact is metadata (in the session, and optionally in `artifact_index`: ids, kind, producer, content type, size, checksum, classification, object key, expiry) plus immutable bytes in R2 under `workspaces/{workspace}/sessions/{session}/runs/{run}/{artifact}` (`artifactObjectKey` in `worker/artifacts/policy.ts`). The key organizes data; it is not an authorization mechanism. A changed result is a new artifact.

### Upload and download flow

Uploads go through a controlled Worker endpoint rather than presigned URLs, because a presigned URL needs an R2 S3 credential in the Worker and the binding needs none.

1. The bridge declares an artifact with `artifact.uploading`.
2. The object checks it against policy (`ARTIFACT_LIMITS`: 25 MB for one artifact, 100 MB for one run) and either commits `artifact.failed` at stage `authorize` or sends a `bridge.grant` of kind `upload` carrying a one-time token that lives ten minutes. Only the token's hash is stored. A declaration after the sandbox's stop has reached its revoke step gets no grant.
3. The bridge sends `PUT /api/sessions/:id/artifacts/:artifactId`. The Worker spends the token and streams the body through a fixed-length stream of exactly the declared size into R2 with the SHA-256 the bridge sent, which R2 verifies.
4. The control plane validates completion, size, and checksum: only after R2 accepts the object does the upload succeed. A length, checksum, or storage failure commits `artifact.failed`.
5. The session commits the artifact metadata and emits `artifact.created`; the Worker then writes `artifact_index`.

Uploads that never started are swept to `artifact.failed` after a terminate and after a loss, so nothing is left uploading, and a failed artifact no longer counts toward the run's limit.

`GET /api/sessions/:id/artifacts/:artifactId` authorizes the session's owner and streams the object as `application/octet-stream` with an attachment filename, `nosniff`, and `content-security-policy: sandbox`, never under the type the sandbox declared. A missing object answers `404 artifact_unavailable`. `GET .../restore` lets a new generation's bridge fetch a patch bundle with its own one-time token.

A checkpoint's patch bundle is essential evidence, kept for the session's life; every other artifact (check logs, diffs) is temporary and recorded with `expires_at` 90 days out. The sweep that deletes expired artifacts is not built (record 19). The hosted environment binds `ARTIFACTS` to its own bucket; an upload to it has not been observed.

### Message attachments

Attachments are the one kind of bytes a person uploads rather than the sandbox. They arrive before the message that carries them, sometimes before the session exists, so they belong to the workspace until a message claims them (`worker/attachments/`, `ATTACHMENT_LIMITS` in `packages/protocol/src/attachments.ts`):

- `POST /api/attachments` refuses a declared length over 10 MB before reading and decides the type from the bytes (`sniffAttachment`): PNG, JPEG, GIF, or WebP up to 10 MB; PDF or UTF-8 text up to 5 MB; never HTML, SVG, or script. Bytes go under `workspaces/{workspace}/attachments/{attachment}` with a Worker-minted id, and a `message_attachment` row with no session. At most 50 wait unsent per workspace, and each upload first removes that workspace's unclaimed uploads older than a day, bytes first.
- The Worker claims the first message's uploads for a new session; the object claims a later message's when it admits the command. A claimed row is never claimed by another session. At most 10 per message.
- `DELETE /api/attachments/:id` removes an unclaimed upload.
- `GET /api/sessions/:id/attachments/:attachmentId` serves the owner an image inline as its sniffed raster type and anything else as an `application/octet-stream` download, always with `nosniff`, a sandboxing content security policy, and `Cross-Origin-Resource-Policy: same-origin`.
- `GET .../attachments/:attachmentId/content` is the bridge's fetch, with a single-use token minted for that attachment and generation.

Attachments are not in `artifact_index`, which needs a run and a producer. Session deletion finds a session's claimed rows through `message_attachment.session_id` and removes their objects by exact key, never by prefix, since the key sits under the workspace, not the session (record 19).

### Unchanged repository files

OnCue stores no copy of a file the session never changed. `GET /api/sessions/:id/files?path=` (`worker/routes/session-files.ts`) reads it from GitHub at the session's base commit: one keyed D1 read of `session_index` gives the repository and commit, the object is not woken, and the read uses a `contents: read` installation token narrowed to one repository and revoked afterwards. Previews (at most 1 MiB) are cached in the Workers Cache API under the GitHub repository id, commit, and path, consulted only after the owner, repository, and installation checks pass. Downloads (at most 20 MiB) are never cached. Responses are text, a raster image recognized from its bytes, or `application/octet-stream`, always with `nosniff` and a sandboxing content security policy. Unverified: Cloudflare documents that the Cache API stores nothing on a `workers.dev` host, so whether the hosted cache ever answers depends on its domain. A miss goes to GitHub, which is correct either way.

## Retention and deletion

Conversations, decisions, and essential evidence stay until the user deletes the session or account. Temporary artifacts are recorded to expire after 90 days, but the expiry is not enforced yet and nothing is deleted (record 19; `../backlog.md`, A20). Deleting a session is a tracked operation across the object, D1, and R2, leaving only a receipt of identifiers; GitHub branches, commits, and pull requests are never deleted. Record 19 defines the policy and describes the job (`worker/deletion/job.ts`): a request whose session is not `deletion_pending` closes as skipped, the object stops its sandbox and refuses new work, R2 objects go by the session's own prefix and by exact key after an ownership check, then the D1 rows keyed by the session, then the object's own storage, and last one batch that completes the `deletion_request` and removes the `session_index` row. The object keeps a tombstone, so a late or retried create never makes a deleted session again. There are no notification rows to remove yet (record 17).

## Security and privacy

- Every record belongs to a workspace, and a session id alone grants nothing.
- Every artifact and attachment read passes an authorization check.
- Secrets are redacted before events and logs are committed (record 08).
- Checksums catch incomplete or corrupted transfers.
- Production data is never copied into a sandbox because a task asks for it.

Shared-workspace roles, key rotation, and regional placement are open.

## Why not Postgres or a vector database

Postgres would add a provider, connection management, and a second source of truth before the workload needs it. D1 is enough for global metadata, and the data-access layer avoids unusual D1-specific behavior so a move stays possible. A vector index would add ingestion, freshness, permission, and deletion work before any retrieval problem has been measured; if one is added, it is derived data, never the authority for documents or permissions.

## Failure behavior

- **D1 unavailable.** Running work continues. Creating, starting, or resuming a run needs the admission row from D1 and fails closed. Outbox rows stay pending.
- **R2 upload fails.** The artifact is never announced as created. A failed upload, missing binding, expired token, or ended generation commits `artifact.failed`.
- **Duplicate projection.** Ignored by the `last_projected_sequence` guard.
- **Missing R2 object.** A download answers `artifact_unavailable`; metadata is kept.
- **Session database unavailable.** The session pauses. D1 is never promoted to session authority.

## Conditions for reconsideration

Review the storage design when cross-session transactions become necessary, D1 limits come close, users need full-text or semantic search across large histories, retention becomes region-specific, or mutable collaborative documents become a primary artifact type.
