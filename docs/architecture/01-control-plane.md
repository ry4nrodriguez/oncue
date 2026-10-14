# Control plane and session orchestration

**Status:** Approved foundation

## Purpose

The control plane accepts requests, applies platform rules, coordinates sessions, and keeps clients informed while work runs remotely. It stays responsive when an agent works for a long time or a sandbox fails.

It is built from Cloudflare Workers and SQLite-backed Durable Objects. The Worker (`apps/web/worker/index.ts`) handles stateless API concerns. One Durable Object per session (`SessionObject` in `apps/web/worker/session/session-object.ts`, with its logic in `apps/web/worker/session/object/`, built on the Cloudflare Agents SDK's `Agent`) owns that session's ordered state and realtime connections.

## Responsibilities

| Component | Owns |
|---|---|
| Worker | Authentication (Clerk session cookie), the allowlist and ownership check before routing (`worker/auth/authorize.ts`), request validation, global records in D1, routing a session id to its object, and GitHub webhooks. It returns promptly and never stays active for the length of agent work. |
| Session Durable Object | The run and sandbox state machines, the ordered event log, commands and their idempotency records, messages, approvals, Git policy, the current sandbox generation, what it owes the bridge (`bridge_dispatch`), the stop sequence (`sandbox_stop`), connected clients and their replay, and the outbox to D1 (record 03). |

Every change to a session passes through its object, which orders concurrent activity from users, webhooks, and the sandbox. One object and one SQLite database per session gives isolation (a busy session locks nothing shared), one sequence per session, local transactions (a state change, its event, and its outbox row commit together), and horizontal scale. The cost is that session databases are not globally queryable; D1 projections cover discovery and reporting.

## Run operational state model

A session stays open across runs; a terminal run does not close it. Each line below is one allowed run transition. `pnpm check-records` compares this block with `RUN_TRANSITIONS` in `packages/protocol/src/states.ts` and fails when they differ.

```text
created -> queued
created -> cancelled
queued -> provisioning
queued -> cancelled
provisioning -> ready
provisioning -> cancelled
provisioning -> failed
ready -> running
ready -> cancelled
ready -> failed
running -> waiting_for_approval
running -> paused
running -> interrupted
running -> verified
running -> completed_with_warnings
running -> completed
running -> blocked
running -> failed
running -> cancelled
waiting_for_approval -> running
waiting_for_approval -> cancelled
waiting_for_approval -> blocked
paused -> provisioning
paused -> cancelled
interrupted -> provisioning
interrupted -> cancelled
interrupted -> failed
```

`cancelled` is reachable from every non-terminal state, because a run the user cannot stop is a run the user cannot escape.

| State | Meaning |
|---|---|
| `created` | Exists durably, not yet queued. |
| `queued` | Waiting to provision or attach compute. |
| `provisioning` | A sandbox is starting or being restored. |
| `ready` | The sandbox is connected and can accept a command. |
| `running` | The agent is working. |
| `waiting_for_approval` | The next protected action needs a human decision. |
| `paused` | Durable state kept, active work stopped. |
| `interrupted` | Compute was lost; the run can resume from a durable checkpoint. |
| `verified` | Done, and every required check passed with durable evidence (record 14). |
| `completed_with_warnings` | The change is prepared, but verification is incomplete, failed, skipped, or inconclusive. |
| `completed` | Shown as "Done": the run changed no files, so no checks ran. |
| `blocked` | Cannot continue without access, information, or a decision. |
| `failed` | Stopped by an error that was not recovered. |
| `cancelled` | Stopped by the user or by policy. |

A terminal run stays readable. A follow-up creates another run in the same session on the same task branch.

### Losing a sandbox

A run and its sandbox are separate state machines (record 11 holds the sandbox's). When a sandbox leaves `active`, the run's next state depends on how it left and whether a checkpoint exists:

| Sandbox left as | Checkpoint known | Run becomes |
|---|---|---|
| `stopped` by the idle stop | either | unchanged: the idle stop starts only when no run is queued, starting, running, or waiting for approval, except a run that waits only on the user's question, which it pauses (record 12) |
| `stopped` by the user | either | `cancelled`, for a run that has not ended |
| `replaced` | yes | `interrupted`, then `provisioning` on the new generation |
| `replaced` | no | `interrupted` |
| `failed` | yes | `interrupted` |
| `failed` | no | `failed` |

A model change whose run cannot start in the attached sandbox also stops it with the idle stop's steps, with the changed run queued; that run is unchanged and starts on the next generation (record 15).

A run already in `provisioning` or `ready` when its sandbox fails moves to `failed`, because no agent work has started that a checkpoint could restore. A run in `waiting_for_approval` follows the `running` rules; the open approval is revalidated against the replacement generation. A checkpoint is known when the session has committed any `repository.checkpointed`. With none, an executing run whose sandbox the provider confirms gone fails at stage `execution`, because the task branch holds only the base commit. The generation's credentials are revoked before the loss is committed, and the loss, `sandbox.credentials_revoked`, and the run's outcome commit together.

## Commands and idempotency

Every mutating request carries a unique command id. The object stores each processed command and its result in the `command` table; a retried command gets the stored result back rather than being applied twice, so the object will return the earlier result for approvals, sandbox creation, and external actions alike. A command is accepted only when it is valid for the current state (`canIssueCommand` in `@oncue/protocol`, applied in `worker/session/commands.ts`).

## Run admission

Before a session is created or a run starts or resumes, both the Worker (`worker/routes/sessions.ts`) and the object (`decideAdmissionNow`) call `decideAdmission` in `worker/admission.ts` against the `platform_control` row in D1. An unreadable or malformed row refuses (fail closed); `run_admission = 'stopped'` refuses; work already running continues. The Worker also refuses a user who is not on the allowlist.

Not built: the concurrent-sandbox caps cannot fire, because both callers pass zero for both counts. Nothing writes `platform_control` except its seed, and there is no operator route to terminate a session by id. Record 22 describes the emergency controls; the missing parts are in `../roadmap.md`.

## Realtime connections

The object is the broadcast authority. It validates and commits an event, assigns the next session sequence, and only then broadcasts it. A client must never rely on a message that was not durably committed.

A client sends its last applied sequence on connect and receives everything after it. The server replays committed events before resuming live delivery, in batches of at most 200 events and 512 KiB (`DEFAULT_REPLAY_LIMITS` in `worker/session/replay.ts`). A batch concatenates each row's stored envelope, so replay cannot drift from what was broadcast. Hibernating WebSockets keep idle connections open without keeping the object running.

### Connection authentication

A browser cannot put an authorization header on a WebSocket upgrade. `worker/routes/ws.ts` authenticates the upgrade with the Clerk session cookie (including Clerk's suffixed `__session_<suffix>` form), resolves the user and workspace, confirms ownership, and forwards a fresh request that carries only the verified `x-oncue-user-id`. The object refuses a socket whose user is not the session's owner and stamps every command from that socket with the verified user. A denial arrives as close code 4401 or 4403 rather than an opaque 1006.

Deleting a session closes its open browser sockets with 4403 and refuses new ones (record 19). Not built: a short-lived connection ticket as an alternative to the cookie, and closing an open browser socket when the user signs out or the account is disabled.

The bridge authenticates its upgrade (`worker/routes/ws-bridge.ts`) with the bootstrap credential of one session and one sandbox generation. The Worker cannot check that credential, whose hash lives only in the object, so it hands the upgrade to the object; but first it asks D1 whether the session id was ever recorded (`isKnownSession` in `worker/session/known-session.ts`: the `session_index` row by primary key, or a deletion receipt through `idx_deletion_request_session`). An id nobody created is refused with 404 there, because waking its object would create one, schema and all, that nothing removes. The one-time bearer routes for artifacts and attachments ask the same question before they wake an object. An unreadable D1 answers yes: the object still checks the credential, and a sandbox must not lose its session to a failed read. The object compares it with the stored SHA-256 and closes sockets from any other generation (close code 4000).

## Read cost

Cloudflare bills a Durable Object by rows read, and on the Workers Free plan any daily limit blocks every Durable Object on the account until the limit resets. Every bridge frame, every client message, and every alarm rearm is a request, so a read that grows with the event log is multiplied by traffic. A full-log scan per bridge frame, fed by an unbounded replay exchange, once used a day's quota in minutes (`../history.md`). The rules:

- **Every per-frame or per-rearm read uses an index that serves its `WHERE` and its `ORDER BY`.** The duplicate-event check is one lookup on the unique `event_id` index. The event table carries `idx_event_type_generation (event_type, sandbox_generation)` and `idx_event_generation (sandbox_generation)` (`worker/session/schema.sql`), and `idx_event_primary_type`, the first of those over only the rows that carry no subagent's `agentId`, which the resume replay reads the primary agent's messages and tool calls through. A partial index serves only a query whose `WHERE` implies the index's own, so `idx_event_generation_runtime_sequence` (partial on `runtime_sequence IS NOT NULL`) cannot serve `WHERE sandbox_generation = ?`.
- **Every read is bounded.** A hot-path read walks an index and stops at the first match or a fixed limit; it never aggregates over a whole generation. Rarer reads are bounded too: the resume context reads each event type once per resume, each with its own row limit (`REPLAY_READS` in `worker/session/resume-replay.ts`).
- **Every exchange loop with the bridge is bounded on the object's side.** The sandbox is untrusted, and a buggy bridge looks the same as a hostile one. After `MAX_REPLAY_ASKS` (3) `replay_from` asks on one socket with nothing admitted in between, the object logs `replay_unavailable` and closes the socket with 4001 (`handleIngestRejection`; the count is per socket and resets when a frame is admitted). `MAX_OUTCOME_REFUSALS`, `MAX_PROPOSAL_REFUSALS`, and `MAX_APPROVAL_REFUSALS` (3 per socket; `MAX_SESSION_APPROVAL_REFUSALS`, 12 per generation) bound refused `run.verified`, `policy.proposed`, and `approval.requested` frames the same way. The bridge also stays silent when its 4,096-frame resend ring of sent frames cannot reach the sequence asked for (`replayFrom` in `services/bridge/src/agent-io.ts`), but the object does not rely on that.
- **A refused frame is not free.** It writes nothing but still pays for every read made before the refusal.

`worker/session/session-read-cost.test.ts` seeds a 5,000-row log behind a live generation and fails when a hot path's average rows read per frame passes `READ_BUDGET_PER_FRAME` (45), when the resume replay reads past its per-type bounds, and when an alarm wake that checks a lost provisioning or runs owed late stops passes `READ_BUDGET_PER_WAKE` (100; twice that for a wake that also commits events). Add a case when you add a per-frame or per-rearm read. `worker/session/session-replay-loop.test.ts` holds the replay bound against a peer that never converges. Miniflare has no quotas, so these tests are the only local signal. Nobody has yet read a hosted session's rows-read figure from Cloudflare's analytics (`../backlog.md`).

## Sandbox coordination

The object stores a logical attachment per generation (`sandbox_attachment`), not the sandbox: provider name and sandbox id, generation, connection status, runtime protocol version, and start and expiry times. Each new sandbox for a session gets a higher generation, and events from an older generation are rejected, so a replaced sandbox cannot keep writing. `last_heartbeat_at` exists in the schema but nothing writes it.

## Failure and recovery

- **Client disconnect.** The session continues; the client replays from its last applied sequence when it returns.
- **Object restart.** State is restored from SQLite. Hibernation keeps idle sockets; an eviction closes them and clients reconnect and replay. A sandbox process is never authoritative merely because it is still alive.
- **Bridge disconnect.** The object commits `runtime.disconnected` and asks the provider through `getStatus` 15 seconds after the close and again 30 seconds after that (`PROBE_DELAYS_MS` in `worker/session/lifecycle.ts`). A reconnect with the current generation clears the probe. Only a confirmed-gone answer is a loss, handled by the table above. Nothing provisions a replacement on its own; an interrupted run resumes on a new sandbox when the user continues it.
- **Duplicate or late events.** Each runtime event carries an id, the generation, and a runtime sequence. A duplicate is ignored, an old generation is rejected, and a gap is refused with a bounded replay request (record 04, and "Read cost" above).
- **Projection failure.** A failed D1 write does not roll back the session; the outbox row stays and is retried with capped backoff (record 03).

## Boundaries

The control plane does not execute repository commands, store large files in the session database, trust sandbox events without validation, take authorization decisions from client input, treat a WebSocket as durable state, or serve organization-wide reports from session databases.

There is no workflow engine. The object already gives ordered state, alarms, retries, and durable storage, and a second orchestrator would overlap it. Revisit when work spans sessions, waits for days, or needs scheduling the session state machine cannot express.

## Provisional details

These settings may change after load testing; they are not reasons to change the boundaries above.

| Setting | Current value |
|---|---|
| One event's size | 256 KiB (`LIMITS.eventBytes` in `packages/protocol/src/schema.ts`) |
| Replay batch | 200 events or 512 KiB, whichever comes first |
| Bridge heartbeat | every 15 seconds (`DEFAULT_HEARTBEAT_INTERVAL_MS` in `services/bridge/src/protocol.ts`), each with a WebSocket ping the runtime answers without waking the object; the object does not yet time out a missing one |
| Bridge reconnect | waits of 0.5 to 5 seconds with jitter; one outage gives up after 10 minutes; a link up 30 seconds ends the outage (record 04, "Failure behavior") |
| Disconnect probe | 15 seconds, then 30 |
| Automatic retry counts | not set |

Two provider limits are fixed ceilings: a Durable Object SQLite row or value cannot exceed 2 MB, and a WebSocket message received by a Durable Object cannot exceed 32 MiB. Events, batched deltas, and replay batches stay well below both.
