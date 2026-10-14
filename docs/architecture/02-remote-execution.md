# Remote execution

**Status:** Approved foundation

## Purpose

Remote execution gives each active session an isolated cloud environment where an agent does real work: the repository, language runtimes, Git, test dependencies, and a coding harness. OnCue uses Modal Sandboxes. A session has at most one active sandbox at a time, identified by `(sessionId, generation)`. A sandbox is temporary compute; stopping or replacing it loses nothing durable.

## Sandbox contents

The image is built by `base_image` in `services/sandbox-controller/images.py`, on Modal's Debian slim image with Python 3.12:

- The bridge, the root supervisor, and the runtime host: three single-file bundles built from `services/bridge`.
- OpenCode 1.18.30, a checksummed standalone binary at `/opt/opencode/opencode`.
- Codex 0.157.1 at `/opt/codex`, from the npm registry's linux-x64 tarball checked against its sha512 (see "Harnesses").
- Node.js 24.21.0 from nodejs.org, pinned by version, size, and SHA-256 and unpacked into `/usr/local` (Debian's Node 18 cannot install repositories that need a current Node), with its npm and pnpm 10.24.0. Yarn is not installed.
- Git, curl, CA certificates, `tini`, `util-linux`, and Chromium from the distribution. No browser automation library is installed.

The build fails if anything under `/usr/local`'s `bin`, `lib`, or `include`, or under a harness directory, is not owned by root or is writable by group or others (`RUNTIME_OWNERSHIP_CHECK`, `IMAGE_OWNERSHIP_CHECK`).

Repository-specific dependencies do not belong in the base image. Verification installs them from the repository's lockfile before checks run (record 14).

## Lifecycle

### 1. Prepare

The session object mints a random bootstrap credential for the new generation and stores only its SHA-256. It asks the `SandboxDriver` to `prepareImage` until the base image is built in the workspace that will run the sandbox, then to `create` a sandbox from that image (see "Images and startup"). The spec (`SandboxCreateSpec` in `apps/web/worker/sandbox/driver.ts`) carries the session id, generation, the prepared image reference, resource class, region preference, expiration policy, and the bootstrap credential; the object adds `notAfter`, the latest moment the provider may start the sandbox: 40 seconds after the create is sent (`createNotAfterMs`), 20 seconds before the driver's 60-second wait ends, so the controller gives up first. It is stored per generation (`create_deadline`) before each attempt.

### 2. Start

Modal starts the sandbox from the image. The entrypoint removes setuid and setgid files, sets umask 022, and execs `tini -s` with the root supervisor as its child. The supervisor moves the bootstrap credential from its environment into a file only the bridge user can read, opens its Unix socket, and starts the bridge as the unprivileged bridge user. The bridge dials out to the session object and reports `runtime.connected`. No harness exists yet.

### 3. Configure

After the handshake the object sends only what the session needs, as `bridge.grant` frames:

- A **Git grant** when the session has a repository: a single-use installation token scoped to `contents: read` on one repository, the branch to clone, and the base commit. The bridge clones as its own user with the token passed through an inherited file descriptor to a root-owned askpass script, never through `argv`, the environment, or a file, and revokes the token when the clone returns.
- A **model grant**: a short-lived Model Broker token, the broker origin, the model, and the session's harness (record 06).

The bridge reports `repository.status`, then asks the supervisor to hand the working tree (`/workspace`) to the agent user and start the harness with an allowlisted environment. That environment sets `TMPDIR` to `/home/oncue-agent/.tmp`, created by the image for the agent user with mode 0700, and every check gets the same. A sandbox's `/tmp` is mode 777 with no sticky bit, so any user could replace another's files there; only agent-user processes are given the private directory. `/tmp`, `/var/tmp`, and `/dev/shm` stay writable by both users; neither the bridge nor the supervisor writes to them (`../backlog.md`).

Repository commands are resolved from `.oncue/project.yaml` and `package.json` with their provenance recorded. They are not run at configure time; they run as verification checks (record 14).

### 4. Attach

The bridge polls the harness's health check through its runtime adapter and sends `runtime.ready`, naming the runtime and the version the harness reported, only once it answers. The object sends no `run.start` to a generation before its `runtime.ready` is committed; an earlier `run.start` waits in `bridge_dispatch`.

### What the session records during start

The timeline is built from committed events only, so the object records each step it drives:

- `sandbox.provisioning` before it calls the driver, and `sandbox.attached` once `start` has succeeded and `getConnection` has named the sandbox.
- On a driver failure before attach, `sandbox.stopped` with `provisioning_failed` and `run.failed` at stage `provisioning`, so the run ends instead of waiting for a bridge that will never connect.
- `sandbox.output` on the `controller` stream with a note while the workspace builds the image ("Building the sandbox image in your Modal workspace..."), how long `prepareImage`, `create` (and any retried create), `start`, and `getConnection` took, a line when a create that failed was found running and adopted, a line naming a failed generation's sandbox that could not be stopped, and, on the Modal driver, what the entrypoint printed, polled with `getOutput` every 2 seconds until the generation ends, the driver errs, 2 minutes pass, or 8 polls after `runtime.connected` (Modal surfaces a line some seconds late; `OUTPUT_POLL_*` and `OUTPUT_DRAIN_POLLS` in `session/object/constants.ts`).

Output is untrusted text: the timeline shows it verbatim, tagged by stream, and nothing in the control plane acts on it. The bridge never prints a URL, header, or token.

What the object owes the current bridge is stored as rows in `bridge_dispatch`: a command envelope or the coordinates a grant is minted from, never a credential. A grant's token is minted when the frame is sent and then dropped; a reconnect re-sends every unsettled row and re-mints. The bridge answers each with `bridge.ack` (`accepted`, or `wrong_state`, `duplicate`, `no_runtime`, `unsupported`, `malformed`), which the object commits as `command.acknowledged` with `acceptedBy: "bridge"` or as `command.rejected`.

The bridge reconnects on its own after a drop, with a budget per outage rather than per process, and detects a half-open link with WebSocket pings (record 04, "Failure behavior"). When the bridge socket closes, the object commits `runtime.disconnected` with `connection_lost` and `expectReconnect: true`, then reconciles with `getStatus` (record 01, "Failure and recovery"). Only `not_found`, `stopped`, or `failed` is a loss: the object commits `sandbox.stopped` with outcome `failed` and reason `disappeared`, with a warning naming the last checkpoint; the run follows record 01's "Losing a sandbox" table; and the generation's credentials are revoked as `sandbox.credentials_revoked`. The probe runs only for generations the Modal driver created.

### 5. Work

The harness does the task. The bridge streams normalized events, sends heartbeats, runs checks, uploads artifacts, and relays approvals (record 04).

### 6. Pause or stop

Every stop takes one path, a stored sequence of steps in the object (`worker/session/lifecycle.ts`, `sandbox_stop`): checkpoint, wait for the bridge's report (at most 90 seconds), revoke the generation's credentials, terminate, and for a planned replacement, provision the next generation. Each step is a committed event, so a repeated alarm or an evicted object finishes the sequence without repeating a step. Three things start it:

- **Idle stop:** 20 minutes after the session's last activity, when no run is queued, starting, running, or waiting for approval. `POST /api/sessions/:id/sandbox/keep-alive` holds it off for an hour. A run paused on a rejected key has no 20 minutes: its sandbox is due at once (record 11).
- **User stop:** `POST /api/sessions/:id/sandbox/stop`, confirmed in the browser. It skips the checkpoint, cancels the run, and abandons an idle stop's checkpoint wait. If the provider refuses, the credentials are already revoked and the alarm retries the terminate with capped backoff.
- **Planned replacement:** 30 minutes before Modal's 24-hour ceiling.

Cancelling a run is not a stop; it keeps the sandbox. Alarm-driven steps have no request carrying the workspace's Modal credential, so the object unseals it for that one step without storing it, and never falls back to the fake driver for a Modal generation. Record 11 owns the details.

### 7. Resume

A `run.start` with no live generation, a held message released after a stop, or Continue on a paused or interrupted run provisions a new generation with `sandbox.provisioning` reason `resume`. A command that arrives while a generation is starting joins it, and one that arrives during a stop is picked up when the stop finishes. The new Git grant names the last pushed checkpoint as the head to clone and a newer patch bundle as a restore. The first `run.start` carries the durable context summary (record 11). Resume never depends on process memory or on a provider filesystem snapshot.

## `SandboxDriver` boundary

The control plane talks to sandboxes through one small interface instead of calling Modal throughout the code:

```text
prepareImage(waitMs) -> ready with an image reference, or building
create(spec) -> sandbox reference
start(reference)
stop(reference)
destroy(reference)
getStatus(reference) -> status
execute(reference, command) -> execution reference
getConnection(reference) -> bridge connection details
getOutput(reference, since) -> entrypoint lines since the cursor, and the next cursor
createCheckpoint(reference) -> checkpoint reference
```

Every operation returns a `DriverOutcome`: a value, or a stable failure category (`capacity`, `configuration`, `image_preparation`, `credentials`, `repository_setup`, `not_found`, `conflict`, `unknown`) with a retryable flag. `attempt` in `driver.ts` is the one translation point.

Two drivers implement it: `createModalSandboxDriver` (`modal-driver.ts`) and `createFakeSandboxDriver` (`fake-driver.ts`) for tests and local development. `selectSandboxDriver` (`select.ts`) picks the real one only when the controller bindings and the workspace's Modal credential are both present. The fake, and the scripted model a workspace with no model connection would run, are for a local Worker only (`ONCUE_ENV=local`: `pnpm dev`, the end-to-end suite, Vitest). `POST /api/sessions` refuses before writing anything rather than run a session on either where it does not belong:

- 503 `controller_unconfigured` on a hosted Worker whose controller origin or token is missing, or whose origin is not https (`refuseHostedStandIn` in `apps/web/worker/routes/sessions.ts`). Home says the deployment has no working sandbox controller.
- 409 `model_connection_required` on a hosted Worker when the workspace has no active model connection, which would run a real sandbox behind the scripted model. Home asks for a model key and links to Settings, Model providers (record 15).
- 409 `modal_connection_required` on any Worker with a configured controller when the workspace's Modal credential is missing (`prepareModalCredential`).

`selectSandboxDriver` keeps its fake branches as the last guard, because the session object also selects a driver for a resume or a stop with no create request in front of it.

`execute`, `destroy`, and `createCheckpoint` are implemented but unused by the product. A durable checkpoint is a Git push or a patch bundle the bridge takes (record 07), not a provider snapshot, and `scripts/check-actor-boundary.mjs` fails `pnpm check` if the worker starts calling `createCheckpoint`, since a snapshot would copy development secrets.

The interface keeps provider ids, lifecycle quirks, and error translation out of session logic and lets tests simulate start, failure, and reconnection. It does not try to make every provider interchangeable.

## Sandbox controller

Modal's SDKs speak gRPC, which Workers cannot, and Modal has no public REST API for sandboxes. So the driver has two halves: an HTTPS client in the Worker and object, and the sandbox controller (`services/sandbox-controller/app.py`), a FastAPI app deployed on Modal that uses the Modal Python SDK. It exposes `POST /v1/<operation>` for each driver operation, plus `/v1/connection/test` for the Modal connection setup step.

Every handler is a plain function, which FastAPI runs on its thread pool, because the Modal SDK's calls block; and the deployed function takes 32 requests at once (`modal.concurrent`), so one workspace's create or image build does not queue another's. Each driver call has its own deadline: 60 seconds for `create` (`CREATE_TIMEOUT_MS`), the requested wait plus 15 seconds for `prepareImage`, and 20 seconds for the rest (`DEFAULT_CONTROLLER_TIMEOUT_MS`, `modal-driver.ts`).

Its rules:

- It authenticates the control plane with a dedicated bearer token, compared in constant time, and refuses everyone when no token is configured.
- It holds no Modal credential. The control plane sends the workspace's token pair in headers on each request, and the controller uses it for that request and keeps nothing.
- It receives sandbox specs, image references, the network policy, and the bootstrap credential for the entrypoint. It never receives model credentials, GitHub tokens, development secret values, session history, or artifacts.
- It makes no product or policy decisions.
- It holds no sandbox state apart from Modal's own. If it restarts, the Durable Object reconciles using `getStatus`. Its one memory is `prepare.py`'s: image builds under way and the ids of images already prepared, per workspace and image version. Losing it costs a build's time, never correctness, because Modal keeps every finished layer. A build holds the caller's Modal client in memory until it ends, the one place the controller keeps a credential past its request.
- Its calls are idempotent using the session identifier and generation number, so a retried create does not produce two sandboxes.
- Provider errors are translated in `errors.py` so that no exception text carrying a credential reaches a log.
- It is deployed by hand (`uv run modal deploy app.py::controller_app` from `services/sandbox-controller`); a merge deploys nothing.

The bridge inside the sandbox connects outbound to the Durable Object directly. The controller is only a lifecycle API and is not on the event path.

### Whose Modal account

Sandboxes are created in the user's own Modal workspace on a credential the user connected, and Modal bills the user, as model providers do (record 06); a shared operator account would need billing and quotas the first version does not build. That is why the controller borrows the credential per request rather than holding one: the control plane stores it sealed in `modal_connection` (record 06).

### Idempotent creation

Modal has no create-or-get for sandboxes: creating under a name a running sandbox holds raises `AlreadyExistsError`, and looking up an unused name raises `NotFoundError`. `create` in `sandboxes.py` looks the name up, creates when nothing is found, and on a collision looks up again, which tells a losing retry about the winner's sandbox.

Names are unique among running sandboxes only, so a finished sandbox frees its name and a retry could start a second one. `Sandbox.from_name` and the SDK's `Sandbox.list` see only running sandboxes, but the `SandboxList` call underneath accepts `include_finished=True` with a tag filter and then returns finished sandboxes with their names and exit codes (observed live on 2026-10-04). With it, `create` refuses a generation whose sandbox already ran and exited (`conflict`, not retryable), and `getStatus` reports such a generation `stopped` (exit 0, or 137 after OnCue's terminate) or `failed`; it answers `not_found` only for a generation Modal never had. `create` also starts nothing once the request's `notAfter` has passed, since the caller has stopped waiting and would not learn of the sandbox, and it terminates a sandbox of its own that Modal finished creating after `notAfter` (never a concurrent create's winner). How long Modal keeps finished sandboxes listable is not documented; a retry happens within a minute of the create, well inside it. Session and generation tags are the filter, and also let a person find a sandbox in Modal's console.

### Retries, adoption, and the stop after a failure

`createOrAdopt` in `session/object/provisioning.ts` retries a retryable create failure twice, after 2 and 5 seconds. Before each retry it looks the generation up by name with `getStatus`, because a create whose answer was lost may have started the sandbox: a running sandbox is adopted and provisioning continues, an exited one fails the generation, and only `not_found` (or no answer) leads to another create. The controller's refusal above keeps a retry from ever starting a second sandbox. Other operations are not retried.

A generation that fails after any create was sent is stopped by its deterministic name, whether or not a provider id was ever recorded. On Modal the stop is sent three times: at once, 15 seconds after that one answers, and 45 seconds after the second answers, so about 0, 15, and 60 seconds after the failure plus however long each stop takes (`sweepGeneration`, `failedStopDelaysMs`). It is repeated because a create whose answer was lost can land after an earlier stop found nothing. Those stops run in the object's memory, so before the first is sent a durable late stop is owed as well (`late_stop`, written by `sweepFrom`, run by the alarm in `runLateStops`): due when the last create's `notAfter` plus 30 seconds of grace has passed, or one minute from the failure when it already has. A controller that hangs through the whole sweep, or an eviction during it, therefore still leaves a stop owed. A sweep stop that succeeds after the last create can no longer land pays the late stop; one that succeeds earlier does not, since the create could still land behind it. A late stop that fails is tried again every minute, up to five times, and only then is the sandbox named on the generation's output as possibly still running. A user's or lifecycle stop's terminate step owes a late stop too when a create's deadline is still ahead, so a stop that came while a create was out still catches a create that lands afterwards. Each rearm reads the earliest owed late stop through `idx_late_stop_due`, one row, and one wake runs at most four.

A provisioning asks `stoppedMeanwhile` after every provider answer, the image poll's `ready` included: a stop row for the generation, its attachment ended, or the session no longer active on that generation (a delete or archive) means the generation ended while the call was out. It then writes nothing more, since the stop recorded the outcome, and if a create was sent it runs the same stop sweep (`abandonGeneration`). The check before `sandbox.attached` is made with no await before the commit. The commit stores the sandbox's id and expiry on any attachment that has not ended, and moves its state to `attached` only from `provisioning`: a bridge is accepted while the row is `provisioning`, and its `runtime.ready` may already have moved the row to `active`, most often when the sandbox was adopted after a lost create. `provisioningInFlight` on the object names the generation its memory is provisioning, from the first image poll through a recovery, so the alarm can tell a lost provisioning from a running one; a provisioning clears it only while it still names its own generation, since a stop and a resend can start the next generation's while the old one's last call is out. Stop converges ("absent is success"). If the sweep's last stop fails, the log says `failed_sandbox_not_stopped` and the late stop stays owed. When the late stops give up, the log says `late_sandbox_left_running` and the generation's output gains one `controller` line naming the sandbox and telling the user to stop it in Modal's dashboard. A preparation that fails or runs out of time sends no create and stops nothing.

Provisioning runs in the object's memory. An object restarted or evicted meanwhile (a deploy; or, observed locally, an object with no client connected evicted about a minute into a long image build) would leave the generation `provisioning` with nothing driving it. So while a generation is `provisioning` the alarm wakes every `PROVISION_CHECK_MS` (90 seconds) after it began, and when nothing in memory drives it (`recover_provisioning` in `lifecycle.ts`, `recoverProvisioning` in `provisioning.ts`) it asks the provider by name: a running sandbox is adopted and attached, since its bridge holds the credential whose hash is stored; otherwise the generation fails with a message asking the user to send again, and the stop sweep runs. It does not call a generation lost before its last create's `notAfter` plus grace, and while the provider cannot answer it asks again at the next check, for up to 20 minutes from the start. The adopted sandbox's output is relayed after the alarm returns, so the two-minute relay does not hold the alarm's other work. Each check reads the attachment row the alarm already reads.

The same check covers a generation whose row is live but has no expiry (`provisioningUnsettled` in `lifecycle.ts`): a create landed before the restart, its bridge connected and reported ready, and the attach never ran, so nothing would ever schedule the replacement before Modal's ceiling. That sandbox ran, so the check never fails or stops it. A sandbox the provider names is attached as above; otherwise the expiry alone is stored. In a recovery the expiry counts from when the provisioning began, the earliest the sandbox can have started, so the planned replacement is never late. When only the expiry is stored and that moment has already passed (a row found long after its provisioning, whose sandbox the provider has ended), the replacement is put at least one check ahead (`storeCeiling`), because the alarm weighs the ceiling before the idle stop and would otherwise start a new sandbox at once for a session nobody may be using. Whether a live sandbox has gone is still the disconnect probe's question (record 01).

A recovery that finds its generation ended while no stop owns the ending (the session is no longer active) marks the attachment `failed` before it stops the sandbox by name, so the row does not stay `provisioning` and bring the alarm back every 90 seconds.

## Harnesses

A harness is the coding-agent program that runs the model loop in the sandbox. The bridge drives each through a runtime adapter (`services/bridge/src/runtime.ts`, registry in `runtimes.ts`) that turns the harness's own wire into the bridge's normalized events, so the rest of the bridge is harness-neutral. `RUNTIME_CATALOG` in `packages/protocol/src/runtimes.ts` is the shared list:

| Harness | Pinned | Providers | Control | In the image |
|---|---|---|---|---|
| OpenCode (default) | 1.18.30 | Anthropic, OpenAI | loopback HTTP | yes |
| Codex | 0.157.1 | OpenAI | JSON-RPC over stdio | yes |
| Pi | 0.87.1 | Anthropic, OpenAI | JSON lines over stdio, plus an OnCue extension | no |
| Claude Code | 2.1.283 | Anthropic | JSON lines over stdio | no |

The Worker picks a session's harness once at creation (`resolveRuntime` in `apps/web/worker/runtime/resolve.ts`, stored in `session_index.runtime` and the object's `session_runtime`) and checks it again on every `run.start`. It refuses an unknown harness, one the image does not install (the catalog's `inImage`), one the operator's `ONCUE_RUNTIME_ALLOWLIST` does not name, one that cannot drive the model's provider, or an effort level it cannot send. It never substitutes another. With the allowlist unset, only OpenCode is allowed.

The supervisor starts a harness only from its row in `RUNTIME_SPAWN_RULES` (`services/bridge/src/supervisor-protocol.ts`); a request naming no runtime uses OpenCode's row.

- A `direct` row (OpenCode) starts exactly its binary.
- A `hosted` row (Codex, Pi, Claude Code) starts exactly `/usr/local/bin/node /usr/local/lib/oncue/runtime-host.mjs --port N -- <binary>` plus the flags that follow. The runtime host (`runtime-host.ts`) runs the harness as its child and serves the child's stdin and stdout on one loopback port, one client at a time, keeping up to 1 MiB of its output while nobody is attached and then reading no more until a client attaches, so the child waits on its pipe and no line (a JSON-RPC reply a turn waits on) is lost, and exits with the child. It is root-owned, mode 0444, in a root-owned 0755 directory, and holds no credential.
- Each row lists the environment keys it may pass. A row may mark a key as a placeholder, accepted only when its value is exactly `oncue-relay`, for a harness that refuses to start without a credential. Only Claude Code's `ANTHROPIC_AUTH_TOKEN` is one; the model relay drops it before attaching the broker's token.

Each enabled harness is installed in its own image layer after the OpenCode, Node, and pnpm layer (`HARNESS_LAYERS` in `images.py`), so a version bump rebuilds only its layer and what follows. Codex's layer also creates `/home/oncue-agent/.codex` (0700), which Codex needs. Pi and Claude Code have adapters and spawn rows but no layer, so a session on either cannot start in a real sandbox yet; Claude Code waits on a licensing question (`../roadmap.md`, `../decisions.md`).

## Images and startup

Modal caches each layer by its commands and everything before it, per workspace. Every user's sandboxes run in their own workspace, so each workspace builds every new image once, for minutes. That build never runs inside a create:

- `prepareImage` (`prepare.py`) builds the image in the caller's workspace on a sixteen-thread pool, forgetting a build that has run for 20 minutes without finishing so the next request starts another (a build still waiting for a free thread is not forgotten), and answers `ready` with the Modal image id, or `building` when the build has not finished within the request's `waitMs` (at most 25 seconds). A build that fails, a timeout it raises included, is answered as that failure. A call during a build joins it; a call after it is answered from memory. `image_version()` in `images.py`, a digest of `images.py` and the three bundles, says which image is current without building anything.
- Provisioning polls `prepareImage` with a 20-second wait, at least 5 seconds apart, for up to 12 minutes (`PROVISION_PACING`, `MAX_PREPARE_POLLS` in `session/object/constants.ts`), under the 15 minutes a pending outbound request keeps a Durable Object in memory. Each poll reads one row, whether the generation has ended, and a generation that ended meanwhile is abandoned before anything is created. Then `create` names the prepared image id. A build that outlasts the budget fails the run with `image_preparation` and a message saying the build continues. `building` answers may fill the whole budget; five retryable failures in a row (`MAX_PREPARE_FAILURES`), a controller that does not answer among them, fail the run at once with the last failure's category, about two minutes in when each poll times out.
- The Worker asks for the same preparation without waiting (`worker/modal/image-warm.ts`) when a workspace connects Modal, and on `GET /api/me` when the workspace's last ask was for another release, or more than six hours ago, or failed more than ten minutes ago. `modal_connection.image_warmed_release` and `image_warmed_at` (migration `0020`) record the last ask and serve as a claim, so concurrent page loads ask once. They record that an ask was made, not that a build finished.
- A create from an older Worker, which sends no image id, still builds the image inside the create.

`pnpm controller` also builds the image in the operator's workspace before it serves. The strategy has three layers: the base image (above); repository preparation (dependencies and build caches for known repositories); and the session overlay (task branch, context, short-lived credentials). Only the base image is built. Repository-preparation images and reusable caches are not (`../roadmap.md`); caches, when they exist, are disposable and never the authoritative copy of work. OnCue does not resume from a memory snapshot.

No startup-time target is set. Adding the Codex layer did not measurably change warm start time; cold start with the larger image has not been measured.

## Repository and Git state

Durable work does not depend on the sandbox filesystem. Record 07 owns the Git workflow. In short: each session owns one task branch; the default policy (`DEFAULT_SESSION_POLICY` in `worker/policy/git-policy.ts`) is `commit: auto`, `push: manual`, `pullRequest: manual`, and the idle checkpoint still pushes under `manual` (only `push: never` withholds it, and the bridge saves a patch bundle instead). The agent cannot push: the checkout's push URL cannot resolve. The bridge's only push is one checkpoint commit, on top of the agent's own `git_commit` commits, to exactly the session ref under a `push` grant. GitHub App tokens are narrowed to one repository and revoked after use; because GitHub cannot scope a token to a branch, the bridge validates the exact ref and push webhooks treat any other ref as an incident.

## Credentials and trust boundary

The sandbox runs model-generated commands, so it gets only short-lived, narrow credentials, and the bridge and the agent must not share a process environment: otherwise a shell command could read the bridge's credential and forge events.

### Why not a sidecar

A Modal sidecar container would have made the boundary a container boundary. Modal restricts sidecars to allowlisted workspaces, and OnCue creates sandboxes in each user's own workspace, so it cannot rely on them. The transparent-proxy mode that would make a credential-injecting sidecar useful also cannot be combined with the outbound domain allowlist record 09 depends on. This is an availability finding: sidecar isolation was never measured. If Modal opens sidecars to ordinary workspaces, test them before reconsidering.

### Unix-user separation

The selected mechanism is operating-system privilege separation inside one container, with three identities: root (the supervisor), the bridge user (uid 1000, `oncue-bridge`), and the agent user (uid 1001, `oncue-agent`), which runs the harness and every check. It is defence in depth, weaker than a proven container boundary: anything that escalates to the bridge user or root defeats it.

- `tini` starts the root supervisor as the entrypoint's only child. The supervisor alone receives the bootstrap credential, moves it into a bridge-owned file, removes it from its environment, and starts the bridge with an explicit environment.
- The supervisor serves a fixed set of requests on `/opt/oncue/supervisor.sock` (owned by the bridge user, mode 0600, in the bridge-owned 0700 `/opt/oncue`). The set is the privilege boundary: no general exec and no file verb, and a request outside it is refused rather than narrowed.

| Request | What it does |
|---|---|
| `chown_workspace` | Hands the working tree to the agent user. |
| `start_agent` | Starts the harness as the agent user in `/workspace`, from its `RUNTIME_SPAWN_RULES` row, with only that row's environment keys. |
| `signal`, `wait` | Signal and wait for that one process. |
| `run_check` | Runs a repository command with `/bin/sh -c` as the agent user in its own process group, in the tree or in a base checkout under `/var/lib/oncue/base/`, with the agent's environment plus `CI` and any supplied secrets, killed after at most 30 minutes. Output goes through pipes into a new file under `/var/lib/oncue/checks/` (root-owned, readable by the bridge's group, not traversable by the agent; `O_EXCL|O_NOFOLLOW`; capped at 25 MiB), and the pipes close when the check ends so a leftover process cannot rewrite a finished log. |
| `signal_check` | Sends SIGTERM or SIGKILL to a check's group. |
| `prepare_base` | Hands a base checkout the bridge wrote to the agent user, changing only entries the bridge user owns and never following a link or a second hard link. |
| `write_secret` | Writes one development secret under `/var/lib/oncue/secrets/` (root-owned, group `oncue-agent`, 0750) as a 0440 file only the agent reads, refusing reserved names, values under eight bytes or holding a newline or NUL, and more than twenty names. |
| `clear_secrets` | Removes them at shutdown. |
| `prepare_attachments` | Hands a directory of a message's attachments, written by the bridge under `/var/lib/oncue/attachments/` (root-owned, bridge group, 0771), to the agent user, so afterwards the agent reads the files and the bridge cannot. |

A check is no escalation, since the agent can already run any command; the supervisor adds only where the output goes. It creates its directories at start, outside `/opt/oncue`, so the bridge cannot swap one for a symlink before root writes through it. The mechanism also holds these rules:

- The agent user has no sudo, no usable setuid or setgid path, no cross-user `ptrace`, and no read access to bridge memory or files. Setuid and setgid files are deleted by the entrypoint at container start, because Modal's image capture kept additions but not deletions or mode changes to files from the package layer.
- The model relay, the tool server, and the runtime host bind only loopback.
- Remote Git runs in the bridge, never through a credential helper the agent's shell can reach.
- The agent is started only by the bridge through the supervisor, never by the controller's `execute`. Modal puts a sandbox's Secret into the container's base environment, which every `Sandbox.exec` inherits, so `execute` unsets the bootstrap credential; the product does not call it.

The control plane still treats the sandbox as fallible: it validates events, fences generations, narrows and revokes tokens, and audits pushes through GitHub webhooks. Verification evidence and repository state the bridge reports are trusted only as far as the sandbox is uncompromised.

### Test C

`services/sandbox-controller/scripts/test_c_probe.py` tests this boundary live against a real sandbox: the agent user cannot read the bootstrap file or the bridge's or PID 1's environment or memory, cannot `ptrace`, has no `su`, `sudo`, setuid file, or capability, and can write nothing root runs; the bridge cannot read supplied secrets, placed attachments, or the agent's temporary and Codex directories; and `--secret NAME` checks that a supplied value appears nowhere else. A change to the image, the entrypoint, or the users is a re-run of test C, not a version bump. It has passed on every image it ran on. It last ran on the Node 24 image and has not run on any later one, including those that add the attachments directory, the runtime host, and Codex (`../backlog.md`). `../history.md` lists each run.

### Credential rules

Credentials are scoped to one session and purpose and reach the sandbox only when needed. Long-lived model and GitHub credentials stay outside it; only disclosed development secrets enter it, never production credentials (record 08). Secret values are redacted from events, logs, and artifacts. Stopping or replacing a sandbox revokes its access. The network policy is `outbound_domain_allowlist=["*"]`: public TLS is allowed and private destinations are blocked (record 09).

## Resource controls

| Limit | Value |
|---|---|
| CPU and memory | one class, `standard`: 1 CPU requested and 2 allowed, 2 GiB memory requested and 4 GiB allowed (`_RESOURCE_CLASSES` in `images.py`) |
| Lifetime | Modal `timeout` of 24 hours; no Modal `idle_timeout`, because the bridge's outbound connection never counts as activity and it would kill working sandboxes |
| Idle | 20 minutes, enforced by the object |
| One check | 30 minutes (`CHECK_TIMEOUT_MS` in `services/bridge/src/verify.ts`, `MAX_CHECK_TIMEOUT_MS` in the supervisor) |
| Artifacts | 25 MB each, 100 MB per run (record 03) |
| The bridge's own network calls | clone 10 minutes, its follow-up fetch 2, push 5, checkpoint snapshot 5, checkpoint patch 2 (records 07); each artifact or attachment transfer 60 seconds (`ARTIFACT_TRANSFER_TIMEOUT_MS` in `checkpoint.ts`); a token revocation 15 seconds; the model relay 5 minutes to the broker's headers and 5 minutes between streamed bytes or to read a refusal's body, and a cancelled turn aborts its upstream request (`relay-server.ts`) |

Disk, process-count, and per-command limits other than checks are not set. The provider's enforced limits are the final protection.

## Modal coordination primitives

Modal Queues and Dicts are not used. If they are, they may hold execution-side coordination only, never sessions, approvals, audit records, or results.

## Failure and recovery

### Provisioning failure

The driver translates provider errors into the stable categories above, and a permanent failure leaves the session readable with the category. A retryable `prepareImage` failure is asked again within the preparation budget, up to five times in a row, and a retryable `create` failure is looked up and retried as "Retries, adoption, and the stop after a failure" describes; no other operation is retried on the flag.

### Bridge fails to connect

The sandbox is not marked ready. No retry is automatic: a driver failure before `sandbox.attached`, or a bridge that reports `runtime.disconnected` with `boot_failed` (the clone, hand-over, start, or health check failed) and `expectReconnect: false`, ends the generation as a failed provisioning, and a later message provisions a new one. The object sets no deadline for a bridge that never connects at all.

### Process crash

The harness is not restarted. The bridge sends `runtime.disconnected` with `runtime_exited` or `runtime_crashed`; a run still waiting on the agent ends `run.failed`, while a run already measuring its diff or running checks finishes those.

### Sandbox loss

The session stays available. A replacement starts from the base commit, the pushed checkpoint or patch bundle, the event history, and artifacts. Changes since the last checkpoint may be lost.

### Provider outage

New sessions fail clearly; existing sessions show their last known state. There is no failover to another provider.

## Not built

- Repository-preparation images and reusable caches.
- Retry of retryable failures beyond `prepareImage` and `create`, a connect deadline, and supervised harness restart.
- Resuming a lost provisioning's preparation or create: recovery adopts a sandbox already running, or fails the generation, because the bootstrap credential a new create needs is kept only as a hash.
- Pi and Claude Code in the image.
- Browser-based checks and screenshots, though Chromium is installed.
- Previews.

`../roadmap.md` and `../backlog.md` track them.

## Conditions for reconsideration

Review Modal if measured startup time, cost, regions, resource ceilings, security controls, or reliability are unacceptable. The `SandboxDriver` makes that change possible without touching session semantics.
