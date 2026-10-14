# Data retention and deletion

**Status:** Approved foundation; session deletion and archiving built, retention expiry and account deletion not

## Purpose

OnCue keeps session history, expires large temporary data, and lets a user delete a session and its stored artifacts across every OnCue store without touching their GitHub resources. Session deletion and archiving are built; the 90-day expiry is recorded but not enforced.

## Key decisions

- Session history stays until the user deletes the session or account.
- Artifacts have two retention classes, fixed at creation: essential evidence, kept with the session, and temporary, deleted after 90 days.
- Deleting a session never deletes its GitHub branch, commits, or pull request; they belong to the repository.
- Deletion is not recoverable and there is no trash. Archiving deletes nothing.

## Data classes

### Durable session record

The session object's database (record 03) holds messages, runs, plans, approvals, Git and pull-request references, check records, and model and runtime records; D1 holds the index row and projections. All of it stays until deletion. Nothing compacts high-volume progress output yet.

### Artifacts

`classificationFor` in `apps/web/worker/artifacts/policy.ts` fixes the class from the producer when the bridge declares an artifact:

| Class | What | Retention |
| --- | --- | --- |
| `essential_evidence` | Checkpoint patch bundles, the recovery data for work not yet on GitHub | Kept with the session; `expires_at` is NULL |
| `temporary` | Everything else, including verification logs and tool output | `expires_at` set to 90 days after creation (`ARTIFACT_LIMITS.temporaryRetentionMs`) |

`apps/web/worker/artifacts/upload.ts` writes the class and `expires_at` into D1's `artifact_index` (migration `0006_artifacts.sql`). Nothing reads `expires_at` yet, so no temporary artifact is ever removed. When a verification log expires, the check rows that cite it remain (record 14).

### Message attachments

Composer attachments go to R2 before the message is sent. `sweepUnclaimedAttachments` (`apps/web/worker/attachments/store.ts`) deletes uploads no message claimed within a day, bytes first, on each upload and from the scheduled handler. A claimed attachment stays with the session.

### Sandbox data

The sandbox's files, processes, and temporary credentials exist only while it runs. An ordinary stop checkpoints repository state first (record 11); development secret values are cleared at shutdown (record 08).

### Workspace connections

Removals the user makes take effect at once: revoking a model connection blanks its sealed credential and marks it `revoked`; disconnecting Modal deletes the `modal_connection` row; deleting a development secret deletes its row; removing a repository sets `repository_connection.removed_at` (migration `0013_repository_removed.sql`), which Restore clears.

### Operational telemetry

Worker log lines carry identifiers, not content (record 18). Their retention is Cloudflare's Workers Logs retention; the design target of 30 days is not configured.

## Scheduled work

`scheduled()` in `apps/web/worker/index.ts` runs every five minutes (the `triggers.crons` entry in `apps/web/wrangler.jsonc`). It runs three sweeps through `runScheduledSweeps`, each on its own, so one that throws is logged (`scheduled.sweep`, `failed`) and the others still run:

- `sweepCreatingSessions` removes `session_index` rows left in `creating` for more than an hour whose object confirms it never committed a session (record 03).
- `sweepUnclaimedAttachments` removes uploads no message claimed within a day.
- `runPendingDeletions` works up to five owed deletion requests, least recently tried first (`DELETION_BATCH`, through the partial index `idx_deletion_request_open`). A request is retried on every run for the first half hour after it was asked for, then once an hour, and once it is a day old every six hours (`RETRY_WAITS`), so a deletion that cannot finish wakes its object and the provider a bounded number of times a day; a request still waiting never holds a newer one back. The pace goes by the request's age, not its attempt count, so attempts that come quickly use up nothing. The same run blanks the released-branch hash on receipts older than three days (see "The job").

It does not expire artifacts.

## Session deletion

The confirmation, offered from the session row's menu in the sidebar and from the session screen (`features/home/SessionMenu.tsx`), says what is erased (the conversation, diffs, logs, attachments, and artifacts stored in OnCue) and what stays (the GitHub branch and any pull request). There is no trash.

### The request

`DELETE /api/sessions/:id` (`apps/web/worker/routes/session-delete.ts`):

1. `authorizeSessionRequest` runs the fresh check: signed in, allowlisted, and the owner. This route alone still authorizes a session already `deletion_pending`, so a repeated delete gets the same answer.
2. One D1 batch marks `session_index` `deletion_pending` and inserts a `deletion_request` unless one is already open. From that moment the list leaves the session out, every other route answers it as missing, and the job owes it, so a failure anywhere later cannot strand the session half deleted.
3. The session object is then told (`deleteSession` in `apps/web/worker/session/object/session-state.ts`). It writes a tombstone, stores `deletion_pending`, and from then on refuses every new run, steer, approval, and added context (`commands.ts`), closes its browser sockets with 4403, refuses new ones, ends any bridge that dials back with close code 4401 (which the bridge does not retry, record 04; a bare refusal it would retry for ten minutes while its sandbox ran), and starts no resume. It stops its sandbox through the user's stop (`stopGeneration` in `session/object/sandbox-stop.ts`): no checkpoint, since the content is being erased and pushed work stays on GitHub; every credential the generation held revoked; terminate. A message held for the next run is not released. If the object cannot be reached, the job's first step tells it instead.
4. The route answers 202 and starts the job's first attempt after the response (`waitUntil`).

A projection never moves the row back: it changes `session_index.state` only out of `creating` (record 03).

**The tombstone** (`session_tombstone` in the object) is written even when the object holds no session yet, and survives erasure. A session id is derived from the create request, so without it a create that arrives after the delete, or one retried with the same command id, would make the session again. `createSession` refuses on it (`plan: "deleted"`), and the create route then removes its own `creating` row, hands the request's attachment claims back to the workspace when that row was its own to remove (`releaseClaims`, so the unclaimed sweep removes them; the uploads of a session still `deletion_pending` stay claimed for the job), and answers 410 `session_deleted`.

**A sandbox asked for when the delete arrives.** The delete's stop asks the provider to end a sandbox by name; one whose create has not answered yet does not exist, so the provider reports it gone. Provisioning (record 02) checks after every provider answer, the image build's polls included, whether the generation now has a stop or the session left `active`, and then creates nothing more and stops by name whatever a create may have started (`stoppedMeanwhile` and `abandonGeneration` in `session/object/provisioning.ts`), with a late stop by name owed until that create can no longer land (`late_stop`). It also writes nothing for a session no longer `active`, and asks the provider nothing when the generation ended during the run's dispatch; `createSession` mints the bootstrap before its commit, so no await sits between the commit and provisioning. Provisioning, and the stop sweep after a failed or abandoned generation, count themselves in `provisioningsPending` from their first line, and every call carrying a stop forward counts itself in `stopsAdvancing`, because a stop marks its generation ended and only then fetches and commits the sandbox's last output. The object will not erase while any of these is pending, a resume is committing, the alarm is recovering a provisioning (`provisioningInFlight`), an attachment is still starting, or a late stop is owed (`sandboxWorkUnderWay` in `session-state.ts`), and it asks again after its own provider calls, just before it erases. So no `late_stop` row is ever erased unpaid, and none is left in an object with no session for the alarm to find. After an eviction mid-create, the attachment still `provisioning` keeps the erase waiting until the alarm's recovery abandons the generation and stops it by name.

### The job

`runDeletion` in `apps/web/worker/deletion/job.ts` works one request through the same steps on every attempt, each safe to repeat:

| Step | What it does |
|---|---|
| guard | Proceeds only when the session's index row is `deletion_pending` for the request's workspace, or, with the row already gone, when the object says a delete reached it (its tombstone, read without changing anything). Otherwise it closes the request with `outcome = 'skipped'` and `skip_reason = 'session_not_deleting'` and touches nothing. Requests recorded by the earlier route, whose object was never told and whose projection made the session active again, end this way. |
| `stop` | Tells the object again; a stop still under way or refused by the provider leaves the request owed. The object opens its own Modal pair. |
| `r2` | Removes, in batches of 1,000 keys, every object under the session's own prefix `workspaces/<workspace>/sessions/<session>/`, built from the request's ids (at most ten listing pages per attempt; the rest waits for the next), which catches an upload no row names; plus the artifact keys `artifact_index` names (at most 1,000 rows an attempt, `ARTIFACT_ROWS_PER_ATTEMPT`; every artifact's key is under the prefix, so the listing removes the rest) and every claimed attachment's key from `message_attachment.session_id`, each only when it is exactly the key OnCue would write for this workspace and session (`worker/deletion/ownership.ts`). An attachment's key is rebuilt from the workspace and its id, never trusted from the row, and attachments are never found by prefix since they live under the workspace. Anything else is left alone and counted in the log. |
| `d1` | Deletes `artifact_index`, `message_attachment`, `audit_entry`, and `projection_cursor` rows keyed by the session and the request's workspace. Another workspace's row naming the same session id stays. |
| `object` | The object closes every socket, deletes its alarm and all its storage, and lays its empty schema and the tombstone down again. It refuses while its sandbox has not stopped, one may still be made, or a stop is still writing. Just before, it stops by name once more each generation that failed after a create was sent (the newest three, `stopFailedGenerations` in `provisioning.ts`): those were only ever stopped by name, and nothing else will try again once the object is empty. A refusal of that last stop is logged (`session.deletion`, `failed_sandbox_not_stopped`) and the erase goes on. |
| `receipt` | One batch sets `completed_at`, `outcome = 'deleted'`, and `released_ref_hash` on every open request for the session and deletes the `session_index` row. |

R2 goes before the rows that name its keys, so a rerun after a crash can still find what is left. A failed attempt records `failed_step`, `attempts`, and `last_attempt_at` and leaves `completed_at` NULL; only the receipt or the guard closes a request, so a rerun converges and the receipt is written once. The scheduled handler retries every owed request until it closes.

The receipt is the `deletion_request` row itself (migration `0019_deletion_receipts.sql`): request id, session id, workspace id, requesting user, request time, attempts, last attempt, completion time, outcome, and skip reason. It holds no content.

**The released branch.** The session's task branch stays on GitHub while its index row, which is how the `push` webhook knows a ref is a session's, is removed. A push delivered late or redelivered after the receipt would then read as the App pushing outside every session and lock down every session of the repository (record 07). So the receipt also keeps `released_ref_hash` (migration `0022_released_task_branch.sql`): SHA-256 over the repository's GitHub id and the full ref, never the branch name, read from the index row just before the batch. The webhook treats a ref whose hash a receipt closed within three days holds as a session's branch (`RELEASED_REF_WINDOW_MS` in `worker/deletion/released-refs.ts`), and the scheduled run blanks the hash after that, so an old receipt holds identifiers and times only. The window is short on purpose: for that long, the App's own push to that ref is not treated as an incident. The branch may be a person's own, when the session worked directly on an existing branch (record 07); it is hashed the same way. Removing the index row is also what releases the branch, so another session may take it at once, and the webhook reads live sessions' rows before any receipt, so that session is known as the branch's holder whatever the receipt says. The rebuild in 0019 dropped the row's key to `session_index`, whose row the receipt outlives.

An object woken after erasure (the job's rerun, a stale socket, a late create) holds empty tables and the tombstone only. Work that was already in flight when the erase ran, such as a pull-request call GitHub had not yet answered, writes nothing when it resumes: `planAndCommit` refuses a command when it finds no session row, and `commitControlEvents` refuses once the instance has erased its session, a mark kept in memory (`erased`) so no commit pays a read for it (`session/object/commit.ts`). Only work in flight in that same memory can hold the erased session's row, and a restart leaves none. Notification rows do not exist yet (record 17).

**Before deploying:** read the hosted `deletion_request` table. Requests recorded by the earlier route are closed as `skipped` unless their session is still `deletion_pending`, in which case they are carried out.

### Limits

- A stop owes a late stop by name until the generation's last create can no longer land (record 02: the create deadline plus its grace, about 70 s after the create). The erase waits for it, so a deletion requested soon after a session started finishes on the scheduled run after that, up to about six minutes later. The session is hidden and closed from the request on.

- A deletion whose stop can never finish, for example because the workspace's Modal connection was removed while a sandbox ran, stays owed with `failed_step = 'stop'` until the connection returns, retried at the slowing pace above. Nothing shows it in the app; an operator reads it in D1 (`../backlog.md`).
- A sandbox of a failed generation that refuses even the erase's last stop is left to the workspace's Modal account: the timeline note that named it is erased with the session, and only the log line remains (`../backlog.md`).
- A pull-request call already sent to GitHub when the delete arrives still opens or updates that pull request there; the erased session records nothing of it.
- OnCue cannot recall what it already sent to GitHub or a model provider.

## Account deletion

Not built. The design extends session deletion to the whole workspace: stop sessions, delete credentials, secrets, sessions, artifacts, notifications, and metadata, disconnect from the GitHub App, and close the Clerk identity, leaving only a non-content receipt. `user.status` allows `deletion_requested`, but nothing writes it.

## Archive

Archiving deletes nothing (record 10, "Archiving"). It makes the session read-only, cancels an open run only after the user confirms, and stops the sandbox the way an idle stop does, checkpointing first so unpushed work is saved. The session moves to the sidebar's Archived group, collapsed at the bottom. Unarchive returns it to Active, and its next message resumes it on a new sandbox.

## Automatic artifact expiry

Not built. The design: a scheduled job finds temporary artifacts past `expires_at`, lets any running download or verification finish, deletes the R2 object, and keeps only metadata (kind, size, checksum, creation and deletion time), never content or a usable URL. Promoting an artifact to essential is an explicit, audited action.

## GitHub and providers

Deleting a session or account never deletes branches, commits, pull requests, comments, or checks. OnCue cannot recall content already sent to GitHub or a model provider.

## Out of scope

User-configurable retention, organization policies and legal holds, regional rules, automatic deletion of GitHub resources, recoverable trash or grace periods, export before delete, and formal deletion commitments.
