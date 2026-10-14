# Sandbox lifecycle and caching

**Status:** Approved foundation

## Purpose

The durable session outlives its compute. A Modal sandbox exists only while a session needs a machine: OnCue checkpoints work, stops idle compute, and resumes on a replacement when the user returns. Caching may shorten startup but is never the only copy of session work or of a secret.

`apps/web/worker/session/lifecycle.ts` plans this lifecycle as pure values; the session object (`session-object.ts` and `session/object/sandbox-lifecycle.ts`) carries it out through its single alarm.

## Key decisions

- A sandbox runs while the agent is working, and stops after about 20 minutes without activity, with a checkpoint first.
- A sandbox whose run paused because the provider rejected its key stops at once, with a checkpoint first. Nothing can run on it until the key is replaced, and the run then continues on a new sandbox.
- The user can keep it running longer for a bounded period.
- Modal's 24-hour lifetime cap is met by a planned replacement, not a provider termination.
- A resume uses a new sandbox with the same branch, history, configuration, and artifacts, never restored process memory.
- One session has at most one active primary sandbox.
- Secret-bearing snapshots are never used for recovery.

## What survives a sandbox

Session and run history, the task branch and pushed checkpoints, patch bundles in R2, policy and approvals, verification records, artifacts, and attachment and generation records all live outside the sandbox. Processes, temporary files, caches, and unpushed changes inside a stopped sandbox are not assumed to survive.

## Sandbox lifecycle

Each line below is one allowed transition. The protocol package parses this block and fails the build when its transition table disagrees.

```text
requested -> provisioning
provisioning -> ready
provisioning -> failed
ready -> attached
ready -> failed
attached -> active
attached -> stopped
attached -> failed
attached -> replaced
active -> idle
active -> stopped
active -> failed
active -> replaced
idle -> active
idle -> checkpointing
idle -> failed
idle -> replaced
checkpointing -> stopped
checkpointing -> failed
checkpointing -> replaced
```

`attached -> stopped` and `active -> stopped` are the user's stop from the Modal panel, which ends the sandbox at once without a checkpoint. `checkpointing -> replaced` is the planned replacement before the lifetime cap.

`stopped`, `failed`, and `replaced` end a sandbox. Every new or replacement sandbox is a new attachment with a higher generation number that starts again at `requested`. Events and credentials from an older generation are rejected.

## What counts as activity

The idle deadline is twenty minutes after the newest event the current generation committed, ignoring `sandbox.output`, `sandbox.idle`, `sandbox.keepalive.updated`, `sandbox.credentials_revoked`, and `runtime.disconnected`. A bridge reconnect (`runtime.connected`) counts. No idle deadline is set while a run is queued, provisioning, ready, running, or waiting for an approval, except a running run that waits only on the user's answer to a question (record 12): it is idle, and the idle stop pauses it (`run.paused`, `idle_stop`) so the answer can resume it. A keep-alive pushes the deadline out to its expiry (`idleDeadline` in `lifecycle.ts`).

One pause has no twenty minutes to wait. When the current run's newest pause in the generation is the bridge's `run.paused` with reason `model_failure` and category `authentication_failed`, the idle deadline is the last activity itself, so the idle stop below starts as soon as the pause is stored. Every model request from that sandbox would be refused until the key is replaced, a message cannot reach a paused run whose sandbox is attached (record 10), and Continue needs a new sandbox, so waiting would only spend the user's Modal credit. The stop is the ordinary idle stop: it checkpoints, its events say `idle`, and the run stays `paused` for Continue (record 15). A keep-alive the user asked for still holds it off until the keep-alive ends. The other two pausing categories, `usage_limit_reached` and `model_unavailable`, keep the twenty minutes.

The object goes by the category in the stored event, not by the connection's row in D1, and reads it only while the run is paused: one row from the end of `idx_event_type_generation` on each rearm (`readRejectedKeyPause` in `session/object/store-lifecycle.ts`; record 01, "Read cost"). The stop needs no new stored state. The alarm finds it due from the run's state and the pause on every wake until the stop row exists, and from the stop row after that, so an early alarm, a second alarm, or an object evicted between any two steps arrives at the same stop.

Leaving a browser tab open does not keep a sandbox alive.

## Idle shutdown

The idle stop is the session object's alarm, not Modal's. Modal's `idle_timeout` counts a sandbox as active only while it has an `exec`'d command, stdin being written, or an open tunnel connection. OnCue's sandbox has none of these, because the bridge dials out, so Modal's timer would never reset and would stop a working sandbox twenty minutes after it started. The controller therefore passes no `idle_timeout`; Modal's 24-hour `timeout` is the only provider backstop (`_EXPIRATION_POLICIES` in `services/sandbox-controller/images.py`).

The object has one alarm for everything that needs time (outbox retries, grant deadlines, the idle deadline, the lifetime ceiling, stop steps, reconciliation probes, the check on a generation whose provisioning is unsettled, and owed late stops) and arms the earliest. A local environment may shorten the idle deadline and the ceiling with `ONCUE_IDLE_ALARM_SECONDS` and `ONCUE_CEILING_SECONDS`; a hosted one ignores both. Defaults are in `DEFAULT_LIFECYCLE_SETTINGS`.

An idle stop runs these steps:

1. Stop accepting new runtime commands for the generation.
2. Ask the bridge for a checkpoint and wait up to ninety seconds for its report.
3. The bridge captures Git status and the current commit.
4. It pushes the checkpoint under a push grant, unless the Git policy is `push: never` (record 09).
5. When the push is unavailable, it stores the change as a patch bundle in R2 instead. Run logs are not uploaded.
6. Revoke the generation's credentials and commit `sandbox.credentials_revoked`: the push token is revoked at GitHub, the Model Broker refuses the generation's model token for forwards and renewals alike, unspent upload and restore tokens are cancelled, and an upload that never started commits `artifact.failed`.
7. Terminate the compute. The generation's end is written to D1 again before every terminate attempt, so a refused terminate cannot leave a running sandbox holding a model token the broker still accepts.
8. Mark the attachment stopped and commit `sandbox.stopped`.

Two things besides the alarm start these steps: archiving a session (record 10), and a model change whose run cannot start in the attached sandbox (record 15). In the second, the changed run is already queued; the stop leaves it queued, and its last step starts it on a new generation.

A session with no repository skips the checkpoint. OnCue does not silently discard the sandbox when a checkpoint fails: a checkpoint that does not report in time, a bridge that is not connected, or a bridge that refuses the checkpoint moves the stop on with a warning on `sandbox.stopped`. A bridge that tried and could not take the checkpoint says so at once with `sandbox.checkpoint_failed`, and that reason becomes the warning. When Git could not take a snapshot at all there is nothing to bundle, and the warning is all there is.

### Stop steps and races

Every stop step is leased (`STEP_LEASE_MS`) and the alarm armed for the lease's end before the step's effect runs. A step's result applies only while the stored stop still holds the lease that step ran under (step, attempt count, and due time), so a late result from a replaced attempt changes nothing and cannot move a stop backwards.

- A user's stop during an idle stop or a planned replacement joins it: no step repeats, a checkpoint still being taken is abandoned, every event not yet committed says `user_requested`, and it ends with `sandbox.stopped` and `run.cancelled` with no replacement.
- A replacement not yet provisioned is cancelled the same way; the old sandbox is already terminated, so the run it would have resumed is cancelled. Once the replacement's generation exists, the user's stop is an ordinary stop of that generation.
- A stop during an ordinary resume, before its generation exists, answers `not_running`, and a run cancelled during that wait is not started.
- Only open runs are cancelled; a run that already reached its outcome keeps it.
- A GitHub token whose mint returns after the stop reached its revoke step is revoked at GitHub and never sent to the bridge.
- The stop route answers `202` while a stop is under way but has not ended the sandbox.

## Keep-alive requests

"Keep running for an hour" in the Modal panel calls `POST /api/sessions/:id/sandbox/keep-alive`. Each request records `sandbox.keepalive.updated` with an expiry an hour away, or at the planned replacement if that is sooner, and the idle deadline waits for it. Keep-alive does not change checkpoint rules or guarantee machine identity.

## Lifetime ceiling

Modal caps a sandbox's life at 24 hours. Thirty minutes before that ceiling, keep-alive or not, the object runs the stop sequence with a checkpoint, commits `run.interrupted` with reason `sandbox_replaced` for an executing run, then `sandbox.replaced` and `sandbox.provisioning` with reason `replacement` on the next generation, which resumes that run on its own.

## Resuming a session

When a message needs compute and no sandbox is attached:

1. The object checks that the run's model connection is active (record 10) and provisions a new generation from the base image. The generation's harness starts on the model of the run that opens it, which is another model than the last generation's when the owner changed it (record 15).
2. The bridge clones the repository and restores the task branch, and applies the latest patch bundle when one was stored.
3. The confirmed development secrets are sent again after `runtime.ready`, ahead of the run's first command; a new generation starts with none (record 08).
4. The runtime starts, and the run begins once the bridge reports ready.

The new sandbox does not pretend to restore hidden process memory. The agent receives an explicit durable context summary and the current repository state. The summary is composed from committed events alone (`apps/web/worker/session/resume-context.ts` and `resume-replay.ts`): that the environment is fresh, the repository, branch, and head, whether a bundle was restored, what work was lost with the previous sandbox, and then a replay of the session. The replay has one entry per earlier run, oldest first: the instruction and any messages sent into it, one line per tool call (name, category, outcome, and the paths its input named), the files it changed from the bridge's own diff, each check's last result, the outcome, and the agent's last message. The plan's last state and the Git policy follow.

Everything the user, the agent, or the sandbox wrote is quoted and clipped so it cannot read as an instruction from OnCue. The replay fits about 5 percent of the model's context window, between 8,000 and 64,000 characters (`RESUME_CONTEXT_LIMITS`), and drops the oldest runs first, saying how many. The object composes it once per resume from one bounded read per event type (`REPLAY_READS`), each walking `idx_event_type_generation` from its newest end, so a long log costs the bounds and not the log. It is sent with the resumed run's first prompt and is not committed as a message.

## Cache layers

The design has four layers: the base image (operating system, runtimes, browser, bridge, harnesses), a prepared repository environment (dependencies, tools, local-service images), shared build caches keyed by repository inputs, and the session overlay (branch, files, runtime state, temporary credentials), which is never shared.

Only the base image exists: `services/sandbox-controller/images.py` builds one image for every sandbox, so every resume starts from it and a fresh clone. Modal caches it per workspace, so the image is prepared in each user's workspace at Modal connect, after a release, and before every create, never inside one (record 02, "Images and startup"). When prepared environments exist, a change to the image, bridge, security patches, setup definition, runtime version files, lockfiles, build configuration, or declared cache inputs must invalidate them, and reuse must be validated with a clean rebuild as the fallback.

## Secret and snapshot rules

- No filesystem snapshot is taken. The driver's `createCheckpoint` has no caller in the session lifecycle, and `scripts/check-actor-boundary.mjs` fails `pnpm check` if one appears, so a sandbox holding `/var/lib/oncue/secrets/` is never captured.
- Memory snapshots are not used.
- Reusable images and caches, when built, must be created before any development secret enters the sandbox, and session credentials are never written into shared caches.
- Recovery uses Git, bundles, events, and artifacts.

## Failure behavior

- **Provisioning fails:** a retryable failure while the image is prepared is asked again within the preparation budget, up to five times in a row, and a retryable create failure is looked up by name, adopted if the sandbox runs, and otherwise retried twice (record 02, "Retries, adoption, and the stop after a failure"). Any other driver failure ends the generation with `sandbox.stopped` (`provisioning_failed`) and fails the run at stage `provisioning`. A bridge that gives up (`runtime.disconnected` with `expectReconnect: false`, for example `boot_failed`) fails a run that had not started at `provisioning` and one that had at `execution` (`planRuntimeLoss` in `dispatch.ts`). Once a create was sent, the failed generation's sandbox is stopped by name whether or not its id was ever learned: on Modal three times, about 0, 15, and 60 seconds after the failure, with a durable late stop owed from the start that the alarm retries every minute up to five times. A sandbox the late stops could not stop is named on the generation's output. The next message provisions a new generation (record 02).
- **Checkpoint push disallowed or failed:** store a patch bundle in R2 when there is a patch to bundle.
- **Sandbox disappears before a checkpoint:** recover from the latest pushed branch or bundle and disclose the possible loss. The loss is recorded only once the provider confirms the sandbox is gone, and its credentials are revoked before the loss commits; an object evicted in between asks the provider again and revokes again (record 01, "Losing a sandbox").
- **Old sandbox reconnects:** OnCue may start a replacement generation and let the old bridge reconnect; its credential names a past generation and is refused.

## Not built yet

- Progress tracking. A run that stays live without progress holds its sandbox until the idle stop or the ceiling. The protocol reserves a `no_progress` pause reason that nothing emits.
- A stop cause of its own for a rejected key. The stop is recorded as `idle`, because the `sandbox_stop.cause` column's CHECK constraint cannot change on an existing table; the `run.paused` before it says why.
- An early stop for a run paused on `usage_limit_reached` or `model_unavailable`, and for a paused run that a planned replacement carried to a new sandbox, whose pause is in the generation before.
- Prepared repository environments, shared build caches, and cache invalidation.
- Keeping a sandbox alive for preview activity; previews are not built (record 09).
- Recreating declared local services on resume.

See `../roadmap.md`.

## Conditions for reconsideration

Revisit this design if startup measurements show the 20-minute idle policy causes too much delay, if repository environments cannot be reproduced from declared inputs, or if provider snapshot technology can prove that secrets and cross-user state stay isolated.
