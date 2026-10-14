# Session and run lifecycle

**Status:** Approved foundation

## Purpose

A session is an ongoing conversation about one task, usually in one repository. A run is one attempt by the agent to act on a user instruction inside it. The split lets a user stop work, come back, give feedback, and continue on the same branch without starting a disconnected task.

## Key decisions

- A session is tied to one repository and one task branch. A session may also start with no repository (`repository: null` in `apps/web/worker/routes/sessions.ts`); it then has no branch, no checks, and no checkpoint.
- A session holds many sequential runs. At most one primary run executes at a time, so a second message steers or queues work and never starts a competing writer. Sessions of the same user run independently, and background work such as uploads and projections is not a run.
- A follow-up continues the session's history and repository state. Stopping or cancelling a run never deletes the session, and a session whose last run completed or failed accepts another message.
- Messages sent during active work may steer the current run or be queued for the next run.
- A run is immutable once it reaches a terminal state. A retry or follow-up is a new run.
- The session does not own a permanent sandbox. Sandboxes are temporary generations attached to it (record 11).

## What a session and a run hold

A session holds its owner and workspace, repository and base commit, task branch, conversation and command history, runs, Git policy (record 09), approvals, sandbox generations and checkpoints, artifacts and verification evidence, and its pull-request reference. A run records its instruction, model connection, model, effort, and harness, sandbox generation, times, plan and tool events, changes, verification, and outcome or interruption reason.

## Session and run states

The session has three states (`SESSION_STATES` in `packages/protocol/src/states.ts`):

- **Active:** open to messages and runs.
- **Archived:** in the sidebar's Archived group, readable and restorable, and read-only: the object refuses a new run, a steer, an approval, an answer to the agent's question, added context (`RUN_WORK_COMMANDS` in `apps/web/worker/session/commands.ts`), and a change of approval mode or Git policy (session commands the catalog allows only while `active`); cancelling, pausing, and stopping a subagent stay open. See "Archiving" below.
- **Deletion pending:** closed to everything while deletion proceeds. The session object refuses new work, closes its browser sockets, and stops its sandbox; every route but the delete itself treats the session as missing (`authorizeSessionRequest` in `apps/web/worker/auth/authorize.ts`). Record 19 owns deletion.

The object stores the state and decides from it. `session_index.state` is written by the archive, unarchive, and delete routes once the object has agreed; a projection moves the column only out of `creating` (record 03, "Projection rules"), so a snapshot taken before an archive or a delete can never undo it.

Runs use the state machine in record 01, which is the one definition of run states and transitions. A terminal run does not make the session terminal. The interface shows a status derived from the latest run (record 13, "Status presentation").

## Starting a session

1. The user picks a repository, a branch (the default branch unless they choose another, and whether to start a new branch from it or work on it directly; record 07), model, effort, and instruction.
2. The Worker creates the session and its first run; the session object records the instruction before it requests a sandbox.
3. The sandbox is provisioned as a new generation (record 11), and the run starts once the bridge and runtime report ready.
4. The task branch is named at the first push, not at creation (record 07, "Naming the branch").

If provisioning fails, the run fails at stage `provisioning` and stays readable; the next message provisions a new generation with no loss of the original instruction.

## Follow-up messages while idle

When no run is active, a normal user message creates a new run in the same session, on the same branch, whatever the last run's outcome (record 14). If no sandbox is attached, the new generation receives a context summary composed from committed events (record 11, "Resuming a session"). The run continues on the last run's model unless the owner chose another for this message (record 15, "Changing the model within a session").

## Messages while work is running

Every message carries a command identifier and receives a durable acknowledgement or rejection; a resend with the same identifier is the same message. The composer does not ask the user to choose a delivery. It derives one from the run's state (`intentFor` in `apps/web/src/features/session/composer-state.ts`) and labels it before sending:

- **Steers this run** while the run is `running` or `waiting_for_approval`: `run.follow_up` with delivery `steer_current_run` goes into the live run at once.
- **Runs next** in any other live state, such as while the run is still being set up: `run.follow_up` with delivery `run_next` is held by the session object and released as the next run's `run.start` when the current run ends. Held messages survive the end of a sandbox generation.
- **Continue** on a paused or interrupted run whose sandbox is gone: a steer, which resumes that run on a new generation. The object refuses a `run_next` for a paused or interrupted run, and a steer to one whose sandbox is still attached (`wrong_state` in `apps/web/worker/session/commands.ts`).
- **Nothing** on a paused or interrupted run whose sandbox is still attached, or one the object is moving to a new sandbox itself, since the object would refuse any message (`waitReason` in `composer-state.ts`). The composer keeps the draft, offers Stop run in place of Send, and says why: stop the run to send a new message, or wait for the idle stop, after which Continue resumes the run. Stopping the sandbox is not suggested, because a user's stop cancels the run. A run paused because the provider rejected its key is in this state only for the seconds its checkpoint takes: its sandbox stops at once (record 11, "What counts as activity").
- **Starts the next run** when there is no run or the last one has ended, and on a paused or interrupted run once the owner has chosen another model for the next run: the object then ends that run as cancelled and starts a new one on the chosen model (record 15).

A steer that cannot be delivered yet stays as a pending command row and is sent when the bridge reconnects and the runtime is ready (`planDispatch` in `apps/web/worker/session/dispatch.ts`).

## Stop, cancel, and pause

- **Stop current work:** `run.cancel` ends the run as cancelled and keeps the sandbox. It is valid from any state the run has not ended in, including a paused or interrupted run whose sandbox is gone. Stopping the sandbox itself (the Modal panel) also cancels an open run, and takes no checkpoint, so work since the last checkpoint is lost (record 11).
- **Pause:** keeps the plan and checkpoint so the same run can resume. The object admits a `run.pause` command and records `run.paused`, but nothing in the interface sends one and it never reaches the bridge. In practice only the bridge pauses a run, when a model request fails (record 06).
- **Cancel a queued instruction:** not built. No command removes a held message.

Stopping a run never deletes commits, patches, artifacts, messages, or verification evidence already stored.

## Retry and interruption

OnCue retries neither a run nor a sandbox start on its own (record 11, "Failure behavior"). The only automatic retries of a model request are the harness's own; the Model Broker adds none (`apps/web/worker/broker/forward.ts`).

A resume that would start a new sandbox, either a `run.start` with none attached or a Continue on a paused or interrupted run, first checks that the run's model connection is active. A `run.start` that changes the model is checked against the connection it names instead (record 15). If it is not, the command is refused with `wrong_state` and the fixed reason "this run's model connection is not active; add a working key under Settings, Model providers and start a new session", and no sandbox starts. A broken key therefore cannot spend compute on a run that would pause again at its first model request.

A run that already reached an outcome, the user's cancel for example, is never failed a second time by a provisioning failure, a refused model grant, or a failed token mint that arrives later. An interrupted run resumes from its last durable checkpoint; OnCue does not assume an unacknowledged push or pull-request update failed without checking.

## Archiving

Archiving is organizational, not deletion: an archived session keeps its conversation, runs, branch, artifacts, and audit history, and restoring it returns it to the list. Archiving alone never starts deletion or changes an artifact's retention (record 19).

`POST /api/sessions/:id/archive` and `POST /api/sessions/:id/unarchive` (`apps/web/worker/routes/session-archive.ts`) ask the session object first (`archiveSession` and `unarchiveSession` in `apps/web/worker/session/object/session-state.ts`), then write the index row.

- **Archive** stores `archived`, then stops the sandbox the way an idle stop does (cause `idle`): with a repository and a connected bridge it checkpoints first, so unpushed work is saved, then revokes and terminates (record 11). A sandbox still starting has nothing to save and takes the user's stop instead. A stop already under way finishes as it began.
- **An open run** is never cancelled silently. Without `cancelOpenRun: true` the object answers `run_open` and the route answers 409; the browser then asks first. With it, the object admits a `run.cancel` as the owner before the stop, so the run ends `cancelled`, and its open permission asks and its open question end with it. A run paused on a question is open too, so it is cancelled the same way. A message held for the next run stays held; an archived session starts no run.
- **Unarchive** stores `active` and starts nothing. The next message is a `run.start` with no sandbox attached, which resumes the session on a new generation through the usual resume path (record 11, "Resuming a session").
- Archiving a session being deleted, or one the object never committed, answers 403 like a missing session. A row still `creating` whose object holds the session is written `archived` like an active one, so the projection still owed cannot write an older state over it.

## Failure behavior

- **Duplicate submission:** the command identifier returns the existing command and run.
- **Sandbox disappears:** an executing run becomes interrupted and resumes from its checkpoint when the user continues it (record 01, "Losing a sandbox").

## Not built yet

- A pause control, and cancelling a queued message.
- Starting from a revision other than a branch's tip.

## Conditions for reconsideration

Revisit this design if sessions need several simultaneous writers, if one task must coordinate several repositories, or if non-coding workflows need dependent runs that a sequential conversation cannot represent.
