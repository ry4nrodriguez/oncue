# Decisions

Significant decisions in OnCue's design, in date order. Each entry gives the date, the decision, why it was made, what was rejected, and where it lives now. The current design is described in [architecture/](architecture/README.md); what happened around each decision is in [history.md](history.md).

Later entries can supersede earlier ones. "The owner" is the project's maintainer. Much of the implementation was done with AI coding agents: "the lead" and "the builder" are those agents' roles, and a paragraph that begins "What followed in the build" records choices made while implementing rather than by the maintainer. [Terms](architecture/README.md#terms) defines the rest of the vocabulary.

## 2026-09-01 to 2026-09-20

### A Modal-hosted sandbox controller sits between the control plane and Modal
Date: 2026-09-01

Sandbox lifecycle calls go through a small Python application deployed on Modal that exposes the driver operations over authenticated HTTPS. Cloudflare Workers cannot make the outbound gRPC calls Modal's SDK relies on, Modal's JavaScript SDK is documented only for Node, Deno, and Bun, and Modal has no public REST API for sandboxes. Calling Modal from the Worker directly was not possible; Python rather than a second JavaScript service because Modal's Python SDK is the primary one. It lives in `services/sandbox-controller/` behind the `SandboxDriver` boundary (`apps/web/worker/sandbox/modal-driver.ts`) and record 02.

### GitHub installations are linked only through a user access token
Date: 2026-09-01

On the install callback OnCue exchanges the code for a user access token and links only the installations and repositories `GET /user/installations` shows that user. GitHub documents the setup URL's `installation_id` as spoofable, so trusting it would let one user attach another's installation and read their private repositories; trusting the `installation.created` webhook was rejected for the same reason. The user and refresh tokens are kept as sealed envelopes so access is revalidated at session start (bounded by the 8-hour token life), because an installation token cannot prove that the OnCue user who linked it still has access; discarding the user token after linking was rejected. Record 07; `apps/web/worker/github/install.ts`.

### GitHub tokens are narrowed per operation, used by the bridge or the control plane, and actively revoked
Date: 2026-09-01

Each Git operation gets an installation token narrowed to one repository and the permission it needs (`contents: read` to fetch, `contents: write` to push); the bridge performs the push itself, pull-request API calls run from the control plane, and the control plane revokes the token with `DELETE /installation/token` after the report rather than waiting out the one-hour expiry. GitHub cannot scope a token to a branch or a command, so session-branch enforcement comes from the bridge's exact-ref check, branch protection, revocation, and the push-webhook audit, never from token scope. A credential helper in the agent's shell was rejected because the agent could read the token. Record 07; `apps/web/worker/github/app.ts`, `services/bridge/src/git.ts`.

### The bridge and the agent run as different users, and the bootstrap credential reaches only a trusted entrypoint
Date: 2026-09-01

The agent's shell runs in the same sandbox as the bridge, so without privilege separation it could read the bridge's credentials, forge runtime events, and push with a Git token. The review required bridge-owned `0600` credential files, environment scrubbing before the agent starts, no sudo, setuid, or cross-user `ptrace`, relays bound to loopback, and the controller's `exec` never used to inject credentials. Delivering the bootstrap credential as a container-wide Modal Secret was rejected because every process inherits it. The verification gate is described honestly: the control plane stops a model from claiming `verified` in text, not a compromised sandbox from forging bridge events. Records 02, 06, 14.

### Candidate network policy: all public TLS on 443, nothing else, no silent widening
Date: 2026-09-01

Sandboxes are created with `outbound_domain_allowlist=["*"]` and no CIDR allowlist, which Modal's reference says allows all domains over TLS on 443 while blocking non-TLS traffic. The review first concluded Modal could not express the policy and retracted that. Unrestricted default egress was rejected as a fallback: if the candidate failed its live test, a revised policy would go back to the owner. It passed on 2026-09-09. Record 09; `services/sandbox-controller/images.py`.

### Previews are served from a separate registrable origin
Date: 2026-09-01

Repository code is untrusted, so a preview served under the application origin could read the user's session and call the API. Previews run on a per-session host on a separate registrable domain, authenticated by a single-use code the application mints after the ownership check, which the preview host redeems for its own host-only `Secure`, `HttpOnly`, `SameSite=None`, `Partitioned` cookie, with an open-in-new-tab fallback. A cookie set by the application for the preview host was rejected because a site cannot set cookies for another registrable domain. Not built yet: see [roadmap.md](roadmap.md) (PR-16); record 09.

### Hosted access is an operator-managed allowlist with concurrent-sandbox caps
Date: 2026-09-01

The owner replaced open registration with an exact allowlist of Clerk subjects and added per-workspace and platform-wide concurrent-sandbox caps, checked on admission. Open registration with operator-funded compute had no limit on what a stranger could spend. The caps are operator safety limits, not a quota product, and public self-service registration is deferred. Record 05 and `apps/web/worker/auth/allowlist.ts`; the caps are read but never fire, see [backlog.md](backlog.md).

### Chat instructions change policy through a structured `policy.propose` tool
Date: 2026-09-01

The owner chose a structured tool the agent calls, carrying the triggering user message and the exact before-and-after policy, over a control-plane model call that would spend the user's credential on a platform function. Restrictive changes apply at once so a prohibition is never delayed; permissive changes wait for explicit confirmation; product controls write the same record. Built in PR-12 (see the PR-12 entries below). Records 07, 09, 12.

### Operator identity needs an allowlist, a fresh session, and Cloudflare Access together
Date: 2026-09-01

The owner decided that operator actions require an exact allowlist of Clerk identifiers in protected hosted configuration, a fresh Clerk session, and Cloudflare Access on a distinct operator route, and that passing only one check grants nothing. Not built yet: see [roadmap.md](roadmap.md) (PR-14); record 22.

### Control-plane contract corrections from the review
Date: 2026-09-01

The review fixed several contracts before any code: the Worker reserves a `session_index` row as `creating` before the object's first command, the outbox projects it `active`, and stale `creating` rows are cleaned up; WebSocket upgrades authenticate from the same-origin cookie or a short-lived ticket, and the object checks the owner on every command; new-run admission fails closed when D1 cannot confirm state, while running work continues; the current sandbox reference and generation are projected to D1 for emergency termination; and a planned checkpoint-and-replace happens before Modal's 24-hour ceiling. Records 01, 03, 11, 22.

### OpenCode subagents are disabled
Date: 2026-09-01

The MVP runs one agent per session, and OpenCode's Task tool would spawn child sessions with their own model conversations. The runtime configuration denies `permission.task`, and a contract test keeps it denied across upgrades. Record 12; `services/bridge/src/opencode.ts`.

### Accepted MVP trade-offs
Date: 2026-09-01

The review accepted, without change: one shared hosted environment and no staging; no workflow engine (Durable Object alarms carry orchestration); eventually consistent D1 projections; best-effort redaction; the sandbox as a single trust domain from the agent's side, with a kernel or gVisor escape out of scope; beta and alpha Modal network features kept off the critical path; no per-request network audit log; a single region; a client-rendered SPA; and Modal and OpenCode as single vendors behind narrow adapters with no failover. Record 21.

### Build the session event log first
Date: 2026-09-02

The plan builds the session Durable Object with a fake sandbox (PR-03) before sign-in, GitHub, a model, or the sandbox. Sign-in first produces screens with nothing behind them and needs three external accounts before a local loop exists; sandbox first builds the bridge against a contract that does not yet exist. The object holds the hardest correctness (idempotency, fencing, gaps, replay, the outbox) and runs on a laptop with no account, so everything later plugs into a working loop.

### pnpm, Node 24, and Biome for the workspace
Date: 2026-09-02

The repository uses pnpm 10 through corepack with Node 24 pinned in `.node-version`, and Biome for both formatting and linting. npm workspaces hoist loosely and install slowly, Yarn adds a second lockfile format for no gain, and Bun is not the runtime Wrangler and Cloudflare's Vitest pool use. ESLint plus Prettier was rejected for one tool, one config, one run. Root `package.json`, `biome.json`.

### Vitest on the Cloudflare Workers pool, with istanbul coverage
Date: 2026-09-02

Worker, Durable Object, D1, R2, and WebSocket tests run in the real runtime through `@cloudflare/vitest-pool-workers`, not against storage mocks. The v8 coverage provider cannot instrument workerd, which has no `node:inspector`, so coverage uses istanbul and runs on every `pnpm test`, with 100 percent branch coverage required on security and state directories. `apps/web/vitest.config.ts`.

### Plain SQL migrations, React Router in library mode, one Cloudflare project
Date: 2026-09-02

D1 migrations are plain SQL files Wrangler orders and applies; an ORM would add a schema layer over a schema the records already describe. React Router runs in library mode (five areas and one dynamic route need no file conventions), rather than TanStack Router. The SPA and the Worker build from one Cloudflare Vite project in `apps/web` rather than two projects with a cross-package assets binding and two deploys. `apps/web/migrations/`, `apps/web/src/routes/`, `apps/web/vite.config.ts`.

### Valibot for the protocol schemas
Date: 2026-09-02

A measurement before PR-02 overturned the plan's default of Zod. Every candidate cleared the 50,000 parses-per-second floor by at least 26 times, so throughput decided nothing; bundle size decided it, because the browser imports the protocol package: at 64 schemas Zod cost 88,027 bytes gzipped against Valibot's 2,202. Arktype and TypeBox were also considered. `packages/protocol/src/schema.ts` is the only file that imports Valibot, so swapping it is a one-file change.

### Vercel AI Elements for the timeline, without the Vercel AI SDK
Date: 2026-09-02

AI Elements supplies timeline component source, copied in and owned, because its set already covers plans, tasks, checkpoints, commits, test results, terminal output, artifacts, file trees, and previews; building every component from Base UI, or a generic chat kit, would cover less. It does not trigger record 24's Radix reconsideration clause. The AI SDK was rejected in the browser, where its chat state assumes the client owns the message list while OnCue's history is a server-owned ordered log, and in the Model Broker, which is a credential proxy rather than a model client. The same day's spike made Base UI primitives a precondition: every shared building block is built on Base UI before a component is copied, so no Radix primitive arrives through the shadcn default registry. Record 24; `apps/web/src/components/ai-elements/`.

### The event fold lives in the protocol package
Date: 2026-09-02

The reducer from committed events to view state is in `packages/protocol/src/view.ts`, not in React, because the session object needs the same fold for admission and approval checks that the browser needs for rendering, and two folds would drift. Adding an event type is a compatible change, not a `protocolVersion` bump; command idempotency is keyed on the command path, and events are deduplicated by event id. Record 04.

### The preview gateway is built last
Date: 2026-09-02

The preview gateway needs a second registrable domain and a second Worker, none of the MVP's completion steps need it, and its Modal connect-token assumption is untested. Putting it last keeps the hosted acceptance gate free of it. See [roadmap.md](roadmap.md).

### A fresh session starts with push and draft pull request off
Date: 2026-09-02

Record 07 made push and a draft pull request the default, while records 07 and 09 require a one-click confirmation for any permissive change. Starting with remote actions off resolves the conflict with no special case: the user turns them on once and the choice lasts for the session. Built in PR-12 as `commit: auto`, `push: manual`, `pullRequest: manual`; `apps/web/worker/policy/git-policy.ts`, record 07.

### The Agents SDK is pinned at 0.16.2
Date: 2026-09-03

Release 0.17 and later pull a dependency that requires a Node version the repository did not run under `engine-strict`, so the session object pins the last release that installs; moving off the pin means moving Node first. The object never calls `setState`, never defines `initialState`, and never uses the SDK's `schedule()`, so no automatic state-sync frame reaches the bridge socket. `apps/web/package.json`, `apps/web/worker/session/session-object.ts`.

### First-run setup: GitHub is required, the model key is skippable
Date: 2026-09-03

Record 13 makes an existing GitHub installation the setup-complete condition and lets the user skip the model key and reach Home, guided from the composer. When the plan said a missing model key also routes to setup, the owner ruled on 2026-09-04 that the record wins, since redirecting on a missing key would make submitting from Home impossible. Setup state is derived from server state on every load, with no stored wizard progress. `apps/web/worker/setup/derive.ts`, record 13.

### Model connections have no user-set name or default
Date: 2026-09-04

Migration `0003_model_connections.sql` deliberately has no model id, default flag, or display label. Record 15 separates which account a run uses (the connection) from which model it runs (the run's own model record), so a model column on the connection would be a second place for the same fact to go stale. Record 06 originally promised a connection name and a personal default; the record was corrected to follow the migration during the September audits, and that change to approved text was never formally amended. Record 06; `apps/web/migrations/0003_model_connections.sql`.

### Session and run ids derive from the composer's idempotency id
Date: 2026-09-05

`POST /api/sessions` derives the session and run ids from the composer's idempotency id (RFC 4122 version 5), so a create retried after a lost response reaches the same object instead of creating a second session. Random ids plus an idempotency table were rejected as needing a migration; the ids are not a capability, because every read re-checks the workspace. The browser sends only `{ commandId, instruction }` and the Worker owns title, model, and driver choice. `apps/web/worker/routes/create-session-request.ts`.

### The composer is OnCue's own, not AI Elements' prompt input
Date: 2026-09-05

The composer carries the repository, model, and effort strip, the steer versus run-next label, draft persistence, and the idempotency id. AI Elements' `prompt-input` supplies none of that and pulls five more registry dependencies, so it was not copied in. `apps/web/src/features/session/`.

### Broker session tokens are stateless; revocation lives on the connection row
Date: 2026-09-05

Session tokens for the Model Broker are signed and scoped to one session, generation, and connection, with no token table. Every forward already reads the connection row for the ciphertext, and that row carries the status and the session's current generation, so one indexed read answers revocation with no cache. A token table would add a write per issue and refresh and a second read per forward. A refresh moves a token's expiry but never its ceiling. `apps/web/worker/broker/tokens.ts`, record 06.

### GitHub linking reuses the credential envelope and defends the callback with signed state
Date: 2026-09-06

GitHub user and refresh tokens are sealed with the same envelope as model credentials, separated by the additional authenticated data rather than a new keyring purpose. The installation row id is derived from `(workspace_id, github_installation_id)` so tokens can be sealed before the row is written. The install callback is cross-site by construction, so it is defended by a signed OAuth `state` rather than the same-origin guard; a replay within ten minutes verifies again, which is acceptable because GitHub's `code` is single-use. `apps/web/worker/github/install.ts`, `install-state.ts`.

### Every cookie-authenticated route and WebSocket upgrade is same-origin guarded by default
Date: 2026-09-06

A review found no cookie-authenticated route checked `Origin` or `Sec-Fetch-Site`, and an unguarded WebSocket upgrade let a foreign page stream a signed-in user's session. The operator ruled that PR-07 closes it: a default-deny guard sits in front of the dispatch table, a new route is protected unless listed in `SAME_ORIGIN_EXEMPTIONS`, and upgrades rest on `Origin`. `apps/web/worker/auth/same-origin.ts`.

### The hosted environment is chosen at build time and checked on the artifact
Date: 2026-09-06

`pnpm deploy:hosted` builds with `CLOUDFLARE_ENV=hosted`, reads the config the build produced, and refuses unless it says `ONCUE_ENV=hosted` and binds a real database. Checking intent instead of the artifact would miss a wrong environment block, a forgotten build, or a stale `dist`, any of which could ship a public Worker that honours local test-double overrides. The user allowlist is a Wrangler secret, absent from `env.hosted` so a var cannot silently overwrite it, and an absent allowlist denies everyone. `scripts/deploy-hosted.mjs`, `apps/web/wrangler.jsonc`.

### Sandbox compute is bring-your-own
Date: 2026-09-08

Each workspace connects its own Modal account; sandboxes are created and billed there, and the control plane holds the workspace's Modal token pair sealed with the broker's envelope, sending it with each controller request. The controller holds no Modal credential. The operator funds neither model access nor compute. Modal service users are available only on Team and Enterprise plans, so free-tier users paste a personal token with full authority over their workspace, and setup says so. Modal's OAuth client flow was noted as a lead, but it needs Modal-issued client credentials with no public registration. `apps/web/worker/modal/`, migration `0005_modal_connections.sql`, record 02.

### Unix-user separation in one container, not a Modal sidecar
Date: 2026-09-09

The bridge is isolated from the agent by running as a different Unix user inside the one sandbox container, under a root supervisor that drops privileges. The preferred alternative, a Modal Sandbox Sidecar, is restricted to allowlisted workspaces, which OnCue cannot obtain for each user's own workspace, and its credential-injecting proxy mode cannot be combined with the domain allowlist the network policy uses. Test B was closed on that availability finding without measuring isolation; test C passed on the real image the same day. The mechanism is defence in depth within one container, weaker than a separate container. If Modal opens sidecars to ordinary workspaces, test B becomes answerable again. `services/sandbox-controller/images.py`, record 02.

### The Modal SDK is pinned exactly, and an upgrade is a re-test
Date: 2026-09-09

The controller pins `modal` 1.5.5. Its release deprecates undocumented object APIs for removal in 1.6.0, and 1.6.0 makes a new sandbox backend the default, so an upgrade can change sandbox behaviour and must re-run the live tests. `services/sandbox-controller/pyproject.toml`.

### The controller is stateless and idempotent by lookup
Date: 2026-09-09

The controller keeps no map of sessions to sandboxes; every answer comes from Modal. Because Modal has no create-or-get, `create` looks up by name, creates, and on a name collision looks up again. Modal exposes no lookup for a finished sandbox, so `getStatus` answers `not_found` for anything not running, and the session object's own attachment row distinguishes a stopped generation from one that never existed. A current-generation check in the controller was deferred because it needs a contract change. `services/sandbox-controller/app.py`.

### Agent commands never start through `Sandbox.exec`; setuid files are removed at container start
Date: 2026-09-09

Test C showed that a process started through `Sandbox.exec` inherits the container's base environment, Modal Secret included, whatever user it runs as. So the controller's `execute` unsets the bootstrap variable on every call, and the agent is only ever started by the bridge's supervisor with a clean environment. The same run showed Modal's image capture keeps additions but not deletions or mode changes to files from the apt layer, so setuid and setgid binaries are removed by the entrypoint at container start, not in an image layer. `services/sandbox-controller/images.py`, record 02.

### A test double replaces an external service and never covers for OnCue's own code
Date: 2026-09-11

The fake bridge had sent `runtime.connected` on the real bridge's behalf, so every local check passed while the real bridge never sent it and the session screen sat on "Starting environment". From then on the controller double spawns the real bridge bundle in a local process, and the doubles stand in only for GitHub, the model provider, and Modal. `apps/web/e2e/`, `AGENTS.md`.

### OpenCode is pinned, and the normalizer is built against a recorded session
Date: 2026-09-11

The image installs OpenCode 1.18.30, and the normalizer maps a session recorded from that version to protocol events (the recording script refuses to write any line containing the key); unknown kinds become a debug-only tool output. OpenCode's event stream could change shape between versions, so a version bump re-records the fixture. `services/bridge/src/normalize.ts`, `services/bridge/fixtures/opencode-session-recorded.jsonl`.

### The Git token reaches git on an inherited file descriptor
Date: 2026-09-11

The bridge hands a token to git through an askpass helper that reads it from inherited file descriptor 3, fed by a pipe, so the token is never in argv, the environment, a URL, a file, or a credential helper; system and global credential helpers are disabled and the clone's push URL is `/dev/null`. A bridge-owned token file was the plan's design and was dropped as unnecessary. `services/bridge/src/git.ts`.

### `runtime.ready` waits for both OpenCode's health check and its event stream
Date: 2026-09-11

OpenCode's event stream has no replay, and a run prompted before the bridge was listening lost its events in CI. The bridge now reports `runtime.ready` only after OpenCode answers its health check and the stream delivers its first event, and each health probe races an explicit watchdog because a cold container's `fetch` timeout did not fire on Node 18. `services/bridge/src/opencode.ts`.

### A message after a finished run starts a new run
Date: 2026-09-11

`run.follow_up` is valid only on a live run, so the composer sends `run.start` continuing the last run on its model, labelled "Starts the next run", and a rejected message keeps its draft. The object's run row moves with the bridge's run events in the same transaction, and only a row with no outcome moves, so a late failure cannot overwrite a cancel. `apps/web/src/features/session/composer-state.ts`, `apps/web/worker/session/dispatch.ts`.

### The session object owns every deadline through its single alarm
Date: 2026-09-13

A pure planner (`apps/web/worker/session/lifecycle.ts`) owns one next deadline for the idle stop, planned replacement, stop steps, reconciliation probes, the outbox drain, and grant expiry, and the object arms the earliest. A scheduler in the controller was rejected: the controller is stateless and holds no Modal credential, so it could not act on a timer. A stop step is leased before its effect runs, after an unleased step spun the alarm and committed thousands of commands locally. Record 11.

### No Modal `idle_timeout`; the object's idle alarm is the only idle stop
Date: 2026-09-13

Modal counts only an `exec`'d command, stdin writes, or tunnel traffic as sandbox activity, and OnCue's sandbox has none, so `idle_timeout` acted as an absolute cap that killed every sandbox twenty minutes after creation, before any checkpoint. The controller passes no `idle_timeout`; the object stops an idle sandbox after 20 minutes of quiet (overridable locally with `ONCUE_IDLE_ALARM_SECONDS`), and Modal's 24-hour `timeout` is the backstop. Making `idle_timeout` longer than the alarm was the audit's first proposal and was rejected once the semantics were read. `services/sandbox-controller/images.py`, record 11.

### The durable checkpoint is a Git push, then a patch bundle, then a local commit
Date: 2026-09-14

At a checkpoint the bridge commits its snapshot of the work tree and pushes exactly the session branch under a `contents: write` push grant the object mints and revokes on the report. When the policy or grant forbids a push, or the push fails, it uploads a recovery patch to R2, and `repository.checkpointed` names which outcome it was (`branch_push`, `patch_bundle`, `local_commit`). Modal's filesystem snapshot (`createCheckpoint`) was rejected as provider-specific and is unused. A resumed sandbox gets the repository state and a durable context summary, not restored process memory. `services/bridge/src/checkpoint.ts`, record 11.

### Checkpoint Git runs in a bridge-owned Git directory
Date: 2026-09-14

An independent review showed that running checkpoint Git as the bridge against the agent-owned `.git` let an agent-written `core.fsmonitor`, clean filter, `pre-push` hook, or `url.*.pushInsteadOf` run as the bridge or redirect the push. Checkpoint commits are now built in a private index and object directory through git's alternates, with global and system config, hooks, the filesystem monitor, and the attributes file off, and a real-git test installs every one of them. `services/bridge/src/git.ts`, record 07.

### No checkpoints during a run
Date: 2026-09-14

A hard kill loses work since the last checkpoint, and the timeline says so. Periodic in-run pushes would bound the loss, but each mints and revokes another write token, and nothing yet measures the loss they would save. `services/bridge/src/checkpoint.ts`.

### One stop path, and a lost sandbox interrupts a run only if a checkpoint exists
Date: 2026-09-14

The user's stop, the idle stop, and the planned replacement all take the same stop sequence, which revokes credentials (committed as `sandbox.credentials_revoked`) before `sandbox.stopped`; a second termination path was rejected. When the bridge socket closes and `getStatus` agrees the sandbox is gone, a running run becomes `interrupted` with Continue if a checkpoint exists, and fails at `execution` if none does, since there is nothing to continue from. Records 01, 02, 11; `apps/web/worker/session/lifecycle.ts`.

### Artifacts upload through a controlled Worker endpoint on the R2 binding
Date: 2026-09-14

The bridge declares an artifact, the object mints a one-time upload token, the bridge streams to `PUT /api/sessions/:id/artifacts/:artifactId`, and the Worker writes R2 and commits `artifact.created` only after R2 confirms size and checksum. Presigned URLs were rejected because they need an R2 S3 credential in the Worker; the binding needs none. `apps/web/worker/artifacts/upload.ts`, record 03.

### Every hot-path read is indexed, and every loop with the bridge is bounded by the object
Date: 2026-09-16

After the 2026-09-15 incident, every read on a per-frame, per-rearm, or per-client-message path needs an index that serves its `WHERE` and `ORDER BY`, because Cloudflare bills a Durable Object by rows read and a scan multiplies by frame count. Every exchange between the object and the bridge is bounded on the object's side because the sandbox is untrusted: replay asks stop at `MAX_REPLAY_ASKS` (3) per socket, and repeated refused outcomes and proposals close the socket with 4001. `session-read-cost.test.ts` holds the budget: 45 rows a frame (40 until the status dots added one read on 2026-09-27). Record 01; `apps/web/worker/session/object/`.

### The object gates `run.verified` on its own check records
Date: 2026-09-16

The session object accepts `run.verified` only when the run has a verification summary from the current generation, each required check's newest attempt passed with its log artifact committed, all at one revision, and no user skip. Otherwise the frame is never stored, and the object commits `run.completed_with_warnings` naming every reason; repeated refusals on one socket close it with 4001. The check records live in the object's own tables, written with their events, so no D1 migration was needed. The bridge's own counts are never trusted. `apps/web/worker/session/completion.ts`, record 14.

### Which checks run, and how the user skips them
Date: 2026-09-16

The operator decided the check set: repository requirements from `.oncue/project.yaml` over detected `package.json` scripts, with `test` and `typecheck` required and `lint` and `build` recommended; checks the agent names are deferred. The user skips required checks through a structured option on the run command, never by the object reading message text. A repository that resolves no checks cannot end `verified`. With a lockfile, dependencies install from it as the agent user first, and a failed install records the required checks as skipped. `services/bridge/src/verify.ts`, `services/bridge/src/repo-config.ts`, record 14.

### Retries, base comparison, and output limits for checks
Date: 2026-09-16

A failed `test`-category check gets at most two attempts, and a pass on the second is `inconclusive` with reason `flaky`, never `passed`; a timeout is `inconclusive` and not retried. A base comparison runs only when a required check fails, re-running that check on the base revision within five minutes: a new failure ends the run `failed` at `verification`, a failure reproduced on base ends it `completed_with_warnings`. Events carry at most the last 4,000 characters of output, the full log uploads up to 25 MiB, and a run runs at most ten checks. `services/bridge/src/verify.ts`, record 14.

### Checks run as the agent user through the supervisor, with logs out of the agent's reach
Date: 2026-09-16

A check runs repository code, which is untrusted, so it runs as the agent user, never as the bridge user who holds the push grant and model token. The root supervisor gained `run_check`, `signal_check`, and `prepare_base`, and writes check output to `/var/lib/oncue/checks`, where the agent cannot read or rewrite it. `/tmp` was rejected for base checkouts and logs because the agent could plant a symlink that root would follow. This changed the image and required a test C re-run. `services/bridge/src/supervisor.ts`, `services/bridge/src/supervisor-protocol.ts`, record 02.

### Diffs come from the bridge's own Git
Date: 2026-09-16

The bridge measures diffs with its own Git in the checkpoint's scratch environment, never reading the agent's hooks, config, attributes, or index: a turn diff against a snapshot taken at run start and a session diff against the recorded base. OpenCode's own diff report was demoted to a trigger for a rebuild at most every 15 seconds, because it is the runtime's claim, not a measurement. A large patch uploads as a `diff` artifact. The change card, file tree, and Tests view start from AI Elements' Commit, File Tree, and Test Results; the diff hunks are hand-built because neither AI Elements nor shadcn/ui has a line-level diff view. `services/bridge/src/git.ts`, `apps/web/src/features/diff/`, record 13.

### Deploys are manual and merges rest on local evidence
Date: 2026-09-17

The `check` workflow was disabled in the development repository on 2026-09-17. Nothing runs on a push or pull request; a pull request is merged on local `pnpm check`, `pnpm test:e2e`, and `pnpm test:perf`, run as a clean machine would; the hosted Worker is deployed by hand with `pnpm deploy:hosted` and the controller with `modal deploy`. This supersedes deploy-on-merge, added on 2026-09-07 (GitHub #14); The public repository's workflow runs the checks and has no deploy job. D1 migrations are applied to the hosted database by hand before the merge that needs them. `AGENTS.md`.

### Work found by audit goes to a backlog, not into a plan step
Date: 2026-09-20

Gaps that no plan step owns, each with the file that proves it, go to one backlog list rather than widening a step's scope. It began with unenforced caps, unwired screens, placeholder panel tabs, and coverage gates matching no file. Each plan step's section is also audited against the code before it is built, and design forks go to the operator before building. See [backlog.md](backlog.md).

### Git policy lives in the session object, and it governs pushes made on the user's instruction
Date: 2026-09-20

The operator accepted the recommendation: the policy is the object's own `session_policy` row, read when a command, proposal, or run end arrives and never per frame; D1 carries only `session_index.pull_request_number` (migration `0007_pull_requests.sql`) so the `pull_request` webhook can find a session. The default is `commit: auto`, `push: manual`, `pullRequest: manual`. The idle and ceiling checkpoint is the object's durability push and still pushes under `manual`; only `push: never` withholds its grant, leaving the patch bundle path. `apps/web/worker/policy/git-policy.ts`, record 07.

### The agent proposes policy through a loopback tool server, and the object decides
Date: 2026-09-20

The bridge serves the `policy_propose` tool to OpenCode on a loopback port listed in `OPENCODE_CONFIG_CONTENT`; a call becomes a `policy.proposed` frame. The object treats it as untrusted: it recomputes `from`, `to`, and `direction` from its stored policy, mints the proposal id itself (after a review showed a forged proposal reusing an id could swap the change behind a live card), applies narrowing at once, holds widening as the one open proposal, and admits at most five a run. A custom-tool file written by the supervisor was the fallback and was not needed. `apps/web/worker/policy/git-policy.ts`, `services/bridge/src/opencode.ts`, record 04.

### Widening is confirmed in the timeline or the rail, and publishing reuses the checkpoint push
Date: 2026-09-20

A card in the timeline names each changed field with Confirm and Decline, and the rail's switch writes the same record through one `policy.set` command; the composer gained nothing. The user's push is `checkpoint.create` with reason `user_requested` and a push grant, so there is one push path, and the object asks for a publish only when a run ends `verified` or `completed_with_warnings`, or just after a confirmation allowed pushing. A checkpoint report ends a publish only when the object asked for one within the grant's two minutes, which a review showed was needed to stop unbounded forged reports. Record 07; `apps/web/worker/session/object/`.

### The control plane opens and updates the draft pull request
Date: 2026-09-20

After a push, the control plane creates or updates the session's draft pull request under a token narrowed to the one repository with `pull_requests: write` and `contents: read`, revoked in `finally`; no pull-request token enters the sandbox. It opens only after a `verified` or `completed_with_warnings` run, never merges, marks ready, closes, or deletes a branch, and puts a verification section built from the object's check records between two HTML comment markers, replacing only that span on update. Sandbox-written check names and warnings pass through one cleaner; its remaining gaps (bare URLs, named entities, invisible characters) were deferred to the backlog by the operator. `apps/web/worker/github/pull-requests.ts`, record 14.

### Commits are the bridge's snapshots, named from the user's instruction
Date: 2026-09-20

The operator accepted that commits are the bridge's snapshots of the work tree, parented on the last pushed head and authored by OnCue, so the pull request showed OnCue's commits rather than the agent's local history. The message was the first line of the first instruction whose work is unpushed. A second agent tool for the commit message was decided but not built in PR-12; it was superseded on 2026-09-26 by agent-authored commits (see the later entries). Record 07.

### The foreign-push incident rule acts only on the App's own pushes
Date: 2026-09-20

The push webhook treats a push as an incident only when its `sender` is the App's own bot and the ref is no session's branch, because GitHub delivers a push for every push by anyone and the original rule would have fired on the user's own push to `main`. An installation token cannot be attributed to one session, so the rule locks down every active session of that repository (at most 25 a delivery): credentials revoked, sandbox stopped with no checkpoint push, policy set to `push: never` and `pullRequest: never` by the system, a timeline row, and an `error` log line `github.incident.foreign_push`. The session stays `active` rather than gaining a terminated state, and Workers Logs were enabled so the line is kept. A review-time exemption for an API-created `oncue/` branch with no commits was accepted as a risk and later removed (2026-09-25). `apps/web/worker/github/webhooks.ts`, record 07.

## 2026-09-21 to 2026-09-28

### Development secrets live in D1 and reach the agent only as files
Date: 2026-09-21

A development secret is a D1 row per workspace, repository connection, and name (`development_secret`), its value sealed with the credential envelope; the object opens a value only when it sends it, as a `secret` grant, and holds none across a hibernation. The root supervisor writes each value to `/var/lib/oncue/secrets/<NAME>` (root-owned directory created before the agent exists, files opened `O_EXCL|O_NOFOLLOW`, readable by the agent user alone) and clears them at shutdown; checks started afterwards get the values in their environment. A file, not the agent's environment, because OpenCode starts once per generation before any run, so a value approved mid-run could never reach its environment; nothing is written under the agent's home, which would be a symlink trap. Reserved names (`PATH`, `LD_*`, `ONCUE_*`, and the like) and platform credential names (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and the like) are refused at save and again by the supervisor. Code: `apps/web/worker/secrets/`, `services/bridge/src/supervisor-protocol.ts`; record 08.

### One approval: supplying an optional secret
Date: 2026-09-21

The control plane's tier table (`apps/web/worker/policy/tiers.ts`) decides what may be asked for, and in this version exactly one action can be approved: supplying an optional development secret not selected at launch. An approval is a hard gate only for what the control plane supplies (the value does not exist in the sandbox until the object sends it); OnCue does not gate the agent's shell or edits behind cards, because the agent has a shell, and tier 4 is enforced by credentials that cannot do the thing. The sandbox's `approval.requested` is trusted for one fact, the secret's name; the object writes every field of the card itself, refuses undeclared, unsaved, already-supplied, or already-denied names and more than five a run, and counts refusals per socket and per generation. `planApproval` and `fileEdits` stay frozen (backlog A11). Code: `apps/web/worker/session/approvals.ts`; record 09.

### A run pauses on OpenCode's own permission gate
Date: 2026-09-21

The bridge's `secret_request` tool is the only tool set to `ask` in OpenCode's configuration; OpenCode holds the call and emits `permission.asked`, and the bridge replies `once` after the value is in place or `reject`, never `always`. Holding the tool server's own answer was rejected because OpenCode abandons an MCP call after exactly 60 seconds. The gate is cooperative, not a boundary: the agent's shell can reach OpenCode's loopback API, so what releases a value is only the object's grant, and the tool answers "not supplied" unless the bridge holds a value the object sent. Code: `services/bridge/src/secrets.ts`, `services/bridge/src/opencode.ts`; record 09.

### Approval expiry, denial, and generation end
Date: 2026-09-21

An approval expires ten minutes after it is asked, on the object's clock, read through a partial index on open approvals so a hibernation cannot lose it. Expiry and denial both end the held call as `tool_denied` and return the run to `running`, not `blocked`; a click racing the expiry is settled by one guarded update. An approval belongs to one generation's waiting call: when that generation ends it closes as `run_paused` and no decision is carried to a new sandbox. Code: `apps/web/worker/session/approvals.ts`; record 04.

### Secret disclosure before launch, and degraded mode
Date: 2026-09-21

Before a session exists the Worker reads `.oncue/project.yaml` at the base commit under a `contents: read` token revoked at once, with the same reader the bridge uses, and shows Required, Optional (off by default), and Missing. The disclosure is pinned to the commit read; the object judges a mid-run request against that pinned declaration, never the bridge's later read. A required name with nothing saved lets the person start anyway, and the session's runs cannot end `verified`; an unreadable project file also degrades the session rather than reading as "declares nothing". Code: `apps/web/worker/secrets/declaration.ts`, `disclosure.ts`; record 08.

### Redaction in two exact-match layers, and the checkpoint scan
Date: 2026-09-21

The bridge redacts every event, log line, streamed chunk (with a holdback so a value split across chunks is caught), and artifact byte against the values it holds; the object rebuilds its own redactor once per wake under `blockConcurrencyWhile` and closes the socket if it cannot. Both are exact-match: base64, URL-encoded, and otherwise transformed values pass, and record 08 says so. Before a checkpoint is published the bridge scans the patch; on a match nothing is pushed or bundled and `git.push.failed` with `secret_in_changes` names the files. Code: `services/bridge/src/redaction.ts`, `services/bridge/src/checkpoint.ts`; record 08.

### A checkpoint that cannot be taken says so
Date: 2026-09-22

When Git cannot stage or commit the work tree, the bridge sends the durable event `sandbox.checkpoint_failed` with a fixed category and never Git's own text, since a path the agent chose could be in it. The object marks the generation's push grants spent, settles the newest waiting publish as failed, and moves the stop on at once instead of waiting out its deadline. This replaced a silent hang found in the PR-13 live sitting. Code: `packages/protocol/src/families/sandbox.ts`, `services/bridge/src/agent-io.ts`; records 04 and 11.

### Model catalog
Date: 2026-09-23

The Worker owns a static catalog per provider: Anthropic Claude Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5, and Sonnet 4.5 (legacy); OpenAI GPT-6 Astra, Sol, and Luna. Every row (id, name, context window, maximum output, effort levels and default, thinking mode, list price) was transcribed from each provider's own documentation on the date in `PRICES_AS_OF` (2026-09-23); the recommended defaults are Opus 5.5 and GPT-6 Sol. It is static because a run record must be reproducible and the composer must never wait on a provider call, and OpenAI's model list carries no capabilities to build from; narrowing per key is backlog B11. Codex models, GPT-5.x, and other legacy models were left out. `imageInput` was added on 2026-09-27 from the model list OpenCode 1.18.30 ships, Anthropic's notes for Opus 5.5, and the owner's confirmation for GPT-6 Sol and Luna. Code: `apps/web/worker/broker/providers/catalog.ts`; record 06.

### Effort is per run, and the Model Broker enforces it
Date: 2026-09-23

Each message that starts a run carries the effort it runs at; the session's model stays fixed, and effort never changes inside a run (Anthropic's prompt-cache rule). The run record holds the level (`modelRecord.effort`, null for models without effort), OpenCode receives it as a prompt `variant`, and the broker writes the recorded level into every request (`output_config.effort` or `reasoning.effort`) and refuses a body naming another, so what the sandbox asks for and what is billed cannot disagree. Models without effort support get no thinking configuration, because the documentation gives no mapping from levels to token budgets; where a provider documents no default (GPT-6 Astra), the catalog uses `medium`. Code: `apps/web/worker/broker/effort.ts`, `forward.ts`; records 06 and 15.

### OpenAI runs through the Responses API
Date: 2026-09-23

OpenCode's OpenAI client calls `/v1/responses`, and Chat Completions has no function calling on GPT-6 Astra, so the OpenAI leg (which had never worked) moved to the Responses API end to end: the relay accepts one path per provider (`/v1/messages`, `/v1/responses`), and the broker posts to the adapter's `requestPath`. Code: `services/bridge/src/relay.ts`, `apps/web/worker/broker/providers/`; record 06.

### Live testing is pinned to one model
Date: 2026-09-23

`ONCUE_MODEL_ALLOWLIST`, honoured only when `ONCUE_ENV` is `local`, refuses any other model at session creation; `pnpm dev:live` and the live-lane fixtures set it to `claude-sonnet-4-5-20250929`, and the hosted Worker ignores it. The rule for people and agents is that live testing runs on that model only unless the operator names a sitting and its models. For the catalog the owner authorized one sitting, Opus 5.5 at `low` and GPT-6 Luna at `low` with a $1 cap each, the allowlist restored afterwards; it has not run. Live spend on feature branches follows the same pattern: each sitting is authorized by name with caps. Code: `apps/web/worker/broker/model-guard.ts`; `AGENTS.md`.

### One model key per provider
Date: 2026-09-23

Settings, Model providers shows one card per provider with Connect, Replace (under the same connection id, so sessions on it continue), and Revoke behind a dialog counting the active sessions still on the key (`session_index.model_connection_id`, migration `0012`). A second key for a connected provider is refused with 409 `already_connected`. A per-model switch and a server-side default model were declined. Code: `apps/web/src/features/settings/ModelProvidersSection.tsx`; records 06 and 13.

### Settings visual language, and removing a repository
Date: 2026-09-23

Settings uses bordered groups on the page's own background, statuses as plain words in their tone, and one accent in the app (the composer's send) with every other button neutral (`apps/web/src/components/ui/button-classes.ts`); the same rule was applied to sign-in and setup on 2026-09-27. Removing a repository is a workspace preference (`repository_connection.removed_at`, migration `0013`): hidden, refused for new sessions, restorable, and untouched by the connection flow's re-sync. Records 07 and 13.

### The task branch is named at the first push
Date: 2026-09-24

A session starts with no task branch and clones the base branch; the first push names it, so a session that never pushes leaves no branch behind, and a name is not minted from a greeting. The name lives in the side panel's Pull request tab (since GitHub #42, first from the agent's `pull_request_describe`, else the agent's latest words, with a four-hex suffix after the fixed `oncue/` prefix), and a typed name wins. The object names the branch in `nameTaskBranch` and awaits its `session_index` projection, unique per repository, before minting a push grant, so a session's own push can never reach the webhook as a foreign push; the push webhook's exemption for API-created branches was removed with the branch creator. Code: `apps/web/worker/session/branch-naming.ts`, `packages/protocol/src/branch-name.ts`; record 07.

### The Git policy question sits above the composer
Date: 2026-09-24

Of four placements drawn, the confirmation is one line above the composer, phrased as what the session may do on the repository, with Decline and Allow and no branch editing on it; the branch name moved to the Pull request tab. Approvals stay cards in the timeline. Record 13.

### The review tree shows the whole repository
Date: 2026-09-24

A tree of changed files alone gave no sense of where they sat, so the bridge lists every path at the diff's head (`git ls-tree`, at most 20,000 paths), uploads the listing beside the diff (`diff.updated.tree`), and the panel draws every path with changed files marked. Viewing an unchanged file followed on 2026-09-27. Record 13.

### Stored runs without newer fields stay readable
Date: 2026-09-25

A field added to the run record is optional on the wire, and the object reads a missing value as the old behaviour: a `run.queued` stored before effort existed reads as `effort: null`, and one stored before harnesses existed reads as OpenCode. Otherwise every session from before a change would lose its runs on replay and refuse to resume after a deploy. Code: `packages/protocol/src/schema.ts`, `apps/web/worker/session/object/`.

### Agent-authored Git: three tools, no new authority
Date: 2026-09-25

The owner asked that the agent write its own commit messages, branch name, and pull request text, and commit as it goes. The bridge's loopback tool server offers `policy_propose` (asks), `pull_request_describe`, and `git_commit` (supply text and a tree); none pushes or opens anything, and a push still happens only when the session's policy allows it, on the object's decision. `git_commit` is the bridge's own snapshot chained on the agent's previous commit, not the agent's `.git`, which keeps one push path, the exact-ref check, and the secret scan; the tool answers only once the commit exists. Bounds: one call at a time and 30 commits a run on the bridge, 50 stored per run on the object, ten descriptions a run, with no amend, squash, or force-push; a publish's own commit is told apart by the object's open publish, never the frame's word. The agent's title and body replace the text above the pull request's verification section, and what a person wrote below it is kept. Code: `services/bridge/src/tool-server.ts`, `services/bridge/src/git.ts`, `apps/web/worker/session/pr-description.ts`; records 04, 07, and 14.

### Coverage gates for the bridge and the controller
Date: 2026-09-25

The bridge gained a gate of 80 percent with 100 percent on its five secret-handling files (`services/bridge/vitest.config.ts`), and the controller a 95 percent floor (`services/sandbox-controller/pyproject.toml`), beside the web package's existing 100 percent gates on its trust-boundary directories. Record 23.

### Node 24 in the image, pinned by checksum
Date: 2026-09-26

The image installs Node 24.21.0 from nodejs.org's linux-x64 archive, pinned by version, size, and SHA-256, unpacked root-owned into `/usr/local`, instead of Debian's Node 18, which failed installs of repositories that require a newer Node (OnCue's own among them). The build fails if a Node path is missing or anything under `/usr/local`'s `bin`, `lib`, or `include` is not root's or is group- or world-writable, because a writable path there would let the agent change what root runs. Code: `NODE_INSTALL_COMMANDS` and `RUNTIME_OWNERSHIP_CHECK` in `services/sandbox-controller/images.py`; record 02.

### The agent gets a private temporary directory
Date: 2026-09-26

A sandbox's `/tmp` is 777 with no sticky bit, so any user in the container can remove or replace another's files there. The image creates `/home/oncue-agent/.tmp` (agent-owned, 0700) and the bridge names it as `TMPDIR` for OpenCode and every check; test C checks that the bridge user cannot list it. Fixing `/tmp` itself is backlog D11. Code: `agentTmpDir` in `services/bridge/src/opencode.ts`; record 02.

### Git commands are killed by process group
Date: 2026-09-26

`nodeRunGit` runs each command in its own process group and kills the group, as checks already did, because killing only the child left a time bound or output cap waiting on grandchildren that held its pipes. Code: `services/bridge/src/git.ts`.

### Pre-build the sandbox image after a controller redeploy
Date: 2026-09-26

The controller builds the image inside the first create after a deploy, which on 2026-09-26 passed the session object's deadline and orphaned a sandbox. Until a real fix lands (backlog A16), the operator runs `services/sandbox-controller/scripts/build_sandbox_image.py` right after `modal deploy`, before any session.

### Checks on demand, and the Done outcome
Date: 2026-09-26

The owner's rule: checks run when there are code changes, when asked, and before a pull request, not after every message (on OnCue's own repository a full run took about ten minutes a message). A run that changed no files, measured never assumed, ends with a sixth outcome, `run.completed`, shown as "Done": not verified and not a warning. Reusing `completed_with_warnings` with neutral styling was rejected because it would store "with warnings" for a run with none. A Done run changes no pending state. Code: `services/bridge/src/agent.ts`; records 01, 04, and 14.

### Run checks, and checks before a push
Date: 2026-09-26

The rail's "Run checks" starts a checks-only run (`run.start` with `checksOnly`, trigger `checks_requested`) that prompts no one, reuses the whole verification path, can end Verified, and keeps the agent's conversation for the next message; chat alone was rejected because Verified would then be reachable only through a run that changed code. A push goes only when some run's checks cover the code it carries, otherwise a checks-only run goes first, and the pull request cites the covering run; publishing with whatever was last checked was rejected. `coverFor` skips Done runs, treats a cancelled change as unchecked, and does not trust a sandbox's Done claim on a checks-only run, so a sandbox cannot loop the object through checks runs. Code: `apps/web/worker/session/publish-cover.ts`; records 07 and 14.

### Per-check time limit is thirty minutes
Date: 2026-09-26

OnCue's own `test` check ran past ten minutes in a hosted sandbox, and the run ended with warnings for that reason alone, so the limit rose to thirty minutes. The idle stop is not armed while a run is running, and the session's lifetime ceiling still bounds everything. Code: `CHECK_TIMEOUT_MS` in `services/bridge/src/verify.ts`, `MAX_CHECK_TIMEOUT_MS` in `services/bridge/src/supervisor-protocol.ts`; records 02 and 14.

### Change-aware checks and browser evidence are outside the MVP completion boundary
Date: 2026-09-27

The owner moved change-aware checks and browser evidence out of the completion boundary into the features that do not block MVP completion. Choosing a base branch stays inside the boundary, not yet built. Record 21.

### End-to-end lanes reach the local D1 through the dev server
Date: 2026-09-27

The suite failed above one worker because lane helpers ran `wrangler d1 execute --local`, a second process opening the SQLite file the dev server holds. Every lane now sends statements to the dev server's own D1 binding through Miniflare's local explorer route (`apps/web/e2e/local-d1.ts`), which removes the cause rather than retrying around it; resets read foreign keys from the schema (`cascade-delete.ts`) so new tables are covered. The default is two workers, the count recent runs used; four passed once and is a candidate once it has passed more often on a loaded machine. `github-perf.spec.ts` was deleted because it needed a second trunk server no command starts and its premise (branch creation on the create path) had gone. Code: `apps/web/e2e/`, `apps/web/scripts/playwright.mjs`; record 23.

### Sign-in restyles Clerk rather than replacing it
Date: 2026-09-27

Clerk's own components are themed through its appearance contract, so OnCue builds no form and never touches a password, and Clerk still owns sign-up, verification, and recovery. Every screen before Home uses one frame, a bordered panel headed by the animated wordmark, and sign-up runs in the same panel through Clerk's sign-in-or-up flow instead of Clerk's hosted page. The theme provider sits above the auth gate. Code: `apps/web/src/features/auth/AuthFrame.tsx`, `apps/web/src/lib/clerk-appearance.ts`; record 13.

### The stuck-session sweep runs every five minutes with a one-hour window
Date: 2026-09-27

The sweep of `session_index` rows stuck in `creating` existed but had no cron trigger. It now runs `*/5 * * * *` locally and in `env.hosted`, deletes at most 100 rows a sweep through a partial index, and wakes no Durable Object. The owner set the window to one hour, not five minutes, so a D1 outage during a create cannot cost a real session its index row; the sweep judges by age alone and does not ask the object. Code: `CREATING_SWEEP_MAX_AGE_MS` and `CREATING_SWEEP_BATCH` in `apps/web/worker/routes/sessions.ts`, `apps/web/wrangler.jsonc`; record 03.

### `commit: manual` covers the agent's commits only
Date: 2026-09-27

The bridge's `git_commit` refuses while the policy the object last sent says `manual`, or before any policy has arrived, so narrowing takes effect on the next call. A user-directed push's snapshot is the user's own consent, and the idle and ceiling checkpoint is durability rather than an agent commit; only `push: never` withholds it. Records 07 and 09.

### Agent-written text is cleaned for what GitHub acts on
Date: 2026-09-27

Pull request text from the agent is cleaned in its rendered form: mentions, issue references, and links into GitHub become code spans, raw HTML shows as text, control and bidirectional characters are removed, and comment markers are removed until none is left; ordinary links stay links. Commit messages lose control characters and every person-naming trailer (`Co-authored-by:`, `Signed-off-by:`, `Cc:`), cleaned again just before `commit-tree`. Code: `apps/web/worker/github/agent-text.ts`, `services/bridge/src/commit-message.ts`; records 07 and 14.

### Composer attachments
Date: 2026-09-27

An image may be up to 10 MB, any other file 5 MB, a message may carry 10, and a workspace may hold 50 unsent uploads (`ATTACHMENT_LIMITS` in `packages/protocol/src/attachments.ts`, shared by browser and Worker). The type comes from the bytes: four raster image formats and PDF by signature, anything else only as strict UTF-8 typed among plain text types, so nothing is recorded as HTML, SVG, or script; SVG is refused as an image because it can run script. Uploads belong to the workspace until a message claims them (`message_attachment`, migration `0014`; bytes in R2 under the workspace), because on Home no session exists yet; creating the session first was rejected because it would split one send into two requests with a half-created session between. A message's references are rebuilt from the Worker's own row, and images are served inline only as their raster type, everything else as a download, with `nosniff` and a sandboxing content security policy. Unsent uploads are deleted on removal and swept after a day. Code: `apps/web/worker/attachments/`, `apps/web/src/lib/api/attachments.ts`; records 03 and 13.

### Attachments reach the agent as files outside the work tree
Date: 2026-09-27

The object mints one single-use fetch token per attachment, valid ten minutes and for one generation, and stores only its hash. The bridge fetches each before it prompts, writes it under `/var/lib/oncue/attachments/`, and the supervisor's `prepare_attachments` hands the directory to the agent user, so the bridge cannot read it afterwards and no attachment is committed, pushed, or bundled. Images go to the harness as file parts and every attachment is listed by path in a note on the prompt; a model whose catalog row lacks `imageInput` gets images listed by path with a line saying it cannot view them. The Model Broker needed no change. Code: `apps/web/worker/session/attachment-access.ts`, `services/bridge/src/attachments.ts`; records 02, 04, and 12.

### Dictation stays in the browser
Date: 2026-09-27

The mic button uses the browser's Web Speech API; OnCue receives no audio, only the text the person sends, and the tooltip says the browser sends audio to its own recognition service. Where the browser has no recognition the button is not drawn. Record 13.

### Session status dots
Date: 2026-09-27

Each sidebar row shows one mark: a slow pulse through the wordmark's fire ramp while the current run is set up or running; one solid amber (`--attention`) both when a run ended unseen and when a card or a paused run waits on the user, their words telling them apart; a hollow circle otherwise, hidden from assistive technology. The owner chose one attention colour for "finished" and "needs you", a darker amber in light mode to clear 3:1 on white, and two sidebar groups, Pinned and Active, ordered by latest activity. The object projects the raw current run id and state (`session_index.current_run_id`, `current_run_state`, migration `0015`) with one extra row read per commit, and the browser maps state to mark with a total table over the run states; projecting a computed display status was rejected because it would need a second copy of the status logic in the object. The read-cost budget rose from 40 to 45 rows a frame for that one row. Code: `apps/web/src/features/home/session-activity.ts`, `Sidebar.tsx`; records 03 and 13.

### Seen marks are per browser, and the list polls only while a run works
Date: 2026-09-27

"Seen" is stored per workspace in the browser's localStorage, keyed on the ended run's id, so a second run that ends asks to be looked at again and no browser clock is compared with a server clock; a server-side mark was rejected as a table, a route, and a D1 write on every open for a mark whose loss costs one extra dot. A browser's first list counts as seen, so old sessions do not all light up. The session list is read on mount, navigation, focus, and every four seconds only while a visible tab has a working run, and it opens no Durable Object. Code: `apps/web/src/features/home/seen-runs.ts`, `session-list.ts`.

### Resume after the base branch moves
Date: 2026-09-27

A generation's clone lands on the commit the grant names, whatever the branch tip is: the bridge finds the commit in the clone's history or fetches it once by id with the same single-use token, before the token is revoked. On the base branch the tree lands on the session's base commit, because the session's diffs, checks, and pull request are measured from it; merging a newer base is the agent's or the person's choice. On the session's own task branch a newer tip someone pushed is adopted and the saved edits applied on it, falling back to the session's last push if they do not apply; a rewritten task branch lands on the session's last push, since OnCue never force-pushes. A commit or branch that is gone fails the boot with a plain sentence, and OnCue does not recreate a branch a person deleted. Code: `clone` in `services/bridge/src/git.ts`; record 07.

### Unchanged files are read from GitHub at the base commit
Date: 2026-09-27

A file the session never changed is by definition the file at the base commit, so the Worker reads it from GitHub under a revoked `contents: read` token, owner-authorized, with the repository and commit from one keyed `session_index` read and no Durable Object woken. Previews are at most 1 MiB, typed from their bytes (raster images, UTF-8 text, or a download), and cached under repository id, commit, and path after every check has passed; downloads are at most 20 MiB and not cached. The path is not checked against the tree listing, which would cost an R2 read per file. Code: `apps/web/worker/routes/session-files.ts`, `apps/web/worker/github/file-at-commit.ts`; records 03 and 13.

### Sidebar menus close when the pointer leaves
Date: 2026-09-27

A menu opened with a mouse or pen closes 300 ms after the pointer has left both its trigger and the menu; a touch never starts the timer, and a keyboard-opened menu stays open until Escape, Tab, or a choice. While a menu is open the unpinned sidebar stays revealed. Base UI's `closeDelay` was not used because it requires open-on-hover. Code: `apps/web/src/features/home/sidebar-menu.ts`.

### Speed and preview spikes are parked
Date: 2026-09-27

The owner left the agent-speed spike (GitHub #51) and the preview spike (GitHub #52) open and unmerged. Their fixes and design wait as backlog A21 and A22; previews wait on a dedicated registered domain, because a subdomain of Cloudflare's shared Workers domain would make previews same-site with the app. See `roadmap.md`.

### The coding runtime is a harness behind a runtime adapter
Date: 2026-09-27

The owner approved making OnCue harness-agnostic: the bridge drives a harness through a runtime adapter in two halves: a pure `RuntimePlan` the reducer calls (spawn plan, tool categories, the model-facing name of OnCue's tools, a small `RuntimeProfile`) and an I/O `RuntimeClient` the interpreter calls (health, subscribe, prompt, abort, reply to a held call). The profile holds only flags some shared code reads; a flag nothing reads was rejected as suggesting a fallback that does not exist. The Agent Client Protocol was rejected as the boundary because it does not cover base-URL routing, effort, or usage, and its v2 draft breaks v1; an ACP adapter can implement OnCue's interface later. A harness is supported only when it runs with no permanent credential in the sandbox, sends every model request through the broker's relay, runs as the agent user under the supervisor's allowlist, and has passed test C on the image that carries it; a CLI agent that needs its vendor's own account key in the sandbox and sends every request to that vendor was rejected on those grounds. Code: `services/bridge/src/runtime.ts`, `runtimes.ts`; records 00, 04, and 12.

### Harnesses run inside the sandbox
Date: 2026-09-27

Running each harness on a trusted host with its own tools off was rejected: OnCue's control plane cannot run native binaries, a second sandbox per session would double each person's Modal cost, every tool call would cross Cloudflare twice because a Modal sandbox accepts no inbound connection, the vendor's tuned tools would be lost, and the credential boundary would move rather than disappear. So each harness runs as the agent user under the Unix-user boundary with its own tools on, and features that duplicate OnCue (sharing, auto-update, telemetry, repository-level agent settings, subagents) are turned off in each harness's configuration. Records 02 and 09.

### The harness keeps its conversation within a generation; OnCue replays at the edges
Date: 2026-09-27

Replaying OnCue's log into a fresh harness session on every turn was rejected because it would add a cold prefill and miss the prompt cache on every message. Within one sandbox generation the harness continues its own conversation; when that is gone (resume, replacement, later a harness switch) the object composes a replay of the session from its own event log: instructions, final messages, one line per tool call, changed files, checks, plan, and policy, within about 5 percent of the model's context window, read once per resume through existing indexes. A verbatim transcript captured at the broker was deferred as a retention and deletion question. Code: `apps/web/worker/session/resume-replay.ts`, `resume-context.ts`; record 11.

### One harness per session, chosen by a resolver
Date: 2026-09-27

A session picks its harness at creation and every generation starts the same one. `resolveRuntime` checks the catalog, the operator's `ONCUE_RUNTIME_ALLOWLIST` (OpenCode alone when unset, in every environment), the model's provider, and the effort level, and refuses an incompatible pair rather than substituting; it runs again on every `run.start`. The harness is recorded on every `run.queued` and in `session_index.runtime` (migration `0016`). Switching harness mid-session is deferred: when built it will be the user's command only, because it can change who bills a request, with agent proposals as cards and a per-session bound. Code: `apps/web/worker/runtime/resolve.ts`, `packages/protocol/src/runtimes.ts`; records 04 and 15.

### The supervisor's runtime table and the runtime host
Date: 2026-09-27

The supervisor's one allowed binary became `RUNTIME_SPAWN_RULES`, a row per runtime with its exact argv and environment keys. The rule refusing keys ending in `TOKEN`, `KEY`, `SECRET`, or `PASSWORD` stays, with one exception: a key a row marks as a placeholder is accepted only when its value is exactly `oncue-relay`. Harnesses that speak over stdio run under a root-owned, read-only runtime host that starts the harness as its child and serves its pipes on one loopback port; giving the root supervisor a verb to pass pipes back was rejected as more code in the process that runs as root. Code: `services/bridge/src/supervisor-protocol.ts`, `services/bridge/src/runtime-host.ts`; record 02.

### Harness build order, and Claude Code left off
Date: 2026-09-27

The owner decided the order: Codex second, Pi third, Claude Code last, each off by default. Claude Code support is built but disabled and not installed in the image. We have not yet confirmed it fits Anthropic's terms for third-party products ([consumer terms](https://www.anthropic.com/legal/consumer-terms), [commercial terms](https://www.anthropic.com/legal/commercial-terms)). It stays off until the owner has confirmed that. Codex tools reach the harness as dynamic tools answered in the bridge, Pi's through an OnCue extension, OpenCode's and Claude Code's over the loopback MCP server; all four call the same handlers. The Claude adapter speaks Claude Code's stream-json protocol over the runtime host directly instead of embedding the Agent SDK in the bridge as the design first proposed, which keeps the proprietary SDK out of the bridge bundle with the same effect on the boundary. Code: `services/bridge/src/codex.ts`, `pi.ts`, `claude.ts`.

### One image carries every enabled harness, each in its own layer
Date: 2026-09-27

The owner chose one image carrying every enabled harness over one image per harness, on three conditions: a harness enters the image only once it is switched on (Codex is in; Pi and Claude Code are out); each harness has its own layer after the OpenCode, Node, and pnpm layer and before the bridge's files, so a version bump rebuilds only its layer and what follows; and a measurement would fall back to per-harness images if OpenCode's start was more than about a second slower. The measurement on 2026-09-28 found no difference (median 1.980 s without Codex, 1.971 s with it, over 32 interleaved warm starts each); installing Codex at session start would have added about 4 s per Codex session. Each harness is pinned by checksum, installed root-owned, and covered by the ownership check. Code: `HARNESS_LAYERS` in `services/sandbox-controller/images.py`; record 02.

## 2026-10-04 onward

### The image is prepared before a create, and a create never leaves a sandbox behind
Date: 2026-10-04

Every user's sandboxes run in their own Modal workspace, and Modal caches an image per workspace, so the first session after any image change built the image inside its own create, outlasted the Worker's 20-second deadline, and failed while the sandbox it finally produced ran on the user's account. The controller now has a separate `prepareImage` operation that builds the image in the caller's workspace on its own thread pool and answers `ready` with the image id or `building` within about 20 seconds; the session object polls it for up to 12 minutes, under the 15 minutes a pending outbound request keeps a Durable Object in memory, and then creates from the prepared image id, so a create never waits on a build. Only `building` answers get the whole 12 minutes: five failed or unanswered polls in a row fail the run, so a controller that is down costs about two minutes, not twelve. The Worker asks for the same preparation, without waiting, when a workspace connects Modal and on the first `GET /api/me` after a release or six hours (migration `0020`). Holding one create request open for the whole build was rejected: Modal answers a web request still running after 150 seconds with a redirect the caller must follow (Modal's request-timeout guide), the controller's function would need a longer timeout, and a Durable Object should not depend on one multi-minute request; a controller that answers create early and builds behind it was rejected because the object would then have to poll create, which is the same loop with a sandbox at the end.

A create that fails retryably is followed by a lookup by the generation's deterministic name: a running sandbox is adopted, an exited one fails the generation, and otherwise the create is retried twice. The controller makes a retry safe: it refuses a second sandbox for a generation whose sandbox already exited (found through Modal's `SandboxList` with `include_finished`, which the SDK's own `list` never sends), and it starts nothing after the `notAfter` deadline the object sends with each create, which ends 20 seconds before the driver stops waiting; a sandbox Modal finishes creating after that deadline is terminated by the controller itself, and the object owes one more stop once the deadline plus 30 seconds has passed. Every provisioning step asks after each provider answer whether its generation was stopped, deleted, or replaced meanwhile, and if so writes nothing and stops what it may have started. A generation that fails after any create was sent is stopped by name whether or not a provider id was recorded: three times from the object's memory, at once, 15 seconds after that stop answers, and 45 seconds after the next, so about 0, 15, and 60 seconds after the failure. Because a hung controller or an eviction can swallow all three, a durable late stop is owed before the first is sent, due when the last create can no longer land or a minute from the failure when it already cannot; the alarm retries it every minute up to five times, and only then is the sandbox named on the timeline as possibly still running. Because provisioning runs in the object's memory, which a restart or an eviction loses (seen locally about a minute into a long build with no client connected), the alarm checks a generation still provisioning every 90 seconds and recovers one nothing drives: it adopts a sandbox found running, or fails the generation and stops whatever it started. A generation whose bridge reported ready before the restart is checked the same way but never failed: it gets its sandbox id and expiry, or the expiry alone. Resuming the lost preparation was rejected for now, because a new create needs the bootstrap credential, kept only as a hash. The controller's handlers became plain functions on FastAPI's thread pool and its Modal function serves 32 requests at once, so one workspace's build no longer queues every other request. Code: `services/sandbox-controller/prepare.py`, `sandboxes.py`; `apps/web/worker/session/object/provisioning.ts`, `apps/web/worker/modal/image-warm.ts`; records 02, 11, and 20.

### The browser app reports every failure it can see
Date: 2026-10-04

The owner asked that the browser app handle failure honestly: a failed `/api/me` is an error with Retry rather than endless loading, at most one session socket is live, no send fails silently, and a button sends one command per press. Code: `apps/web/src/features/auth/AuthGate.tsx`, `apps/web/src/features/session/use-session.ts`, `use-commands.ts`; record 13.

The owner approved two choices inside that work on 2026-10-05:

- Only composer messages are held through a disconnect. One-shot controls (Stop run, Run checks, Continue, approval and policy answers, the Git switch) say "not sent" instead, because a cancel, an approval, or a Continue (which starts a billed sandbox) arriving minutes later would surprise more than a visible failure.
- For a paused or interrupted run whose sandbox is still attached (backlog A30), the composer offers no send rather than the object accepting the message. Record 01 lets such a run leave only through `provisioning` (a new generation) or `cancelled`, record 10 refuses a resume onto a live sandbox, and a held message would wait for an ending a paused run never sends; accepting it would mean the bridge resuming a paused turn in place, which is new protocol and bridge work, tracked as backlog A32. Code: `waitReason` in `apps/web/src/features/session/composer-state.ts`; record 10.

### The agent asks the user through each harness's own question tool, with no timeout
Date: 2026-10-04

The owner approved letting the agent ask the user structured questions on a card above the composer, for every harness, and decided a question never times out. Each harness asks through its own channel (OpenCode's `question` tool for the primary agent only, Claude Code's `AskUserQuestion` through `can_use_tool`, an OnCue dynamic tool for Codex because Codex refuses its own outside plan mode, and an OnCue extension tool for Pi), and the bridge maps each to one bounded shape. An OnCue MCP tool shared by every harness was rejected because OpenCode drops a tool call held open through the MCP server after 60 seconds. A deadline was rejected because the user may come back hours later; instead a run waiting only on a question counts as idle, the idle stop pauses it, and the answer resumes it on a new sandbox with the answers as its message. A message sent while the card is open dismisses the question rather than queueing behind it. When the planned replacement at the lifetime ceiling restarts a run whose question is open, the question is dismissed and the restarted run is told why, rather than carrying the answer over as a steer: the harness's waiting call is gone with the old sandbox, and a dismissal needs no second delivery path. Records 04, 12, and 13; `services/bridge/src/questions.ts`, `apps/web/worker/session/object/question-gate.ts`, `apps/web/src/features/questions/`.
### The user decides the agent's own permission asks
Date: 2026-10-04

The owner chose to replace the bridge's silent rejection of every harness permission ask (a read outside the project, a `.env` read, a repeated call) with three approval modes set from a picker below the composer: Allow once (the default), Allow for this session, and Always allow, plus a card above the composer when the mode asks. Secret files always ask and offer only Allow once or Deny, because the owner wants no secret read without a click. The control plane decides every ask: the bridge forwards it as `approval.requested` in one of four harness-neutral categories, and the session object answers from the session's mode and rules (in the object) and the workspace's default and rules (in D1), replying `once` or `reject` through the bridge and never `always`, so OnCue, not the harness, keeps the saved rules. Choosing another mode while the workspace's default is Always allow resets the default to ask, so the menu never shows a mode that is not in force. The browser saves the default through `/api/approval-settings` and shows the answer, rather than the object writing it after the command: the object's write finished after the command's answer, so the browser could not tell what was in force without a new event. Answering in the bridge from a policy the object pushed was rejected: authorization decisions stay in the control plane, and every ask stays in the session's history. The gate is cooperative, so the modes govern what the agent chooses to touch; the sandbox stays the boundary. Code: `services/bridge/src/permissions.ts`, `ask-category.ts`, `apps/web/worker/session/permission-asks.ts`, `object/permission-gate.ts`, `apps/web/worker/approvals/store.ts`; record 09.

### OpenCode ignores the repository's own configuration
Date: 2026-10-04

A repository's `.opencode/agent/build.md` was merged after OnCue's configuration and, since OpenCode resolves an agent's rules last match wins, could re-allow questions, sub-agents, and paths outside the project for the build agent. OpenCode is now started with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which ignores the repository's `opencode.json` and every `.opencode/` agent, mode, plugin, and command, and OnCue's configuration names the work tree's `AGENTS.md` and `CLAUDE.md` so instructions still load. Per-agent rules in OnCue's configuration were rejected after testing the pinned binary: a hostile file's wildcard keys (`"*": allow`) keep their position in the merged object and still win. Code: `services/bridge/src/opencode.ts`, `opencode-config-local.test.ts`; records 09 and 12.

### OpenCode's built-in subagents are allowed, bounded and shown
Date: 2026-10-04

The owner approved letting OpenCode start its two built-in subagents, `general` and `explore`, reversing "OpenCode subagents are disabled" (2026-09-01) for OpenCode only. They are bounded to four at once and sixteen a run and one level deep; the bridge holds every start at OpenCode's permission gate and refuses one past the limit or for another name before anything is shown, so the limit and the allowed names are OnCue's, not the model's. A start within the limit is the user's to allow: it goes to the session object's permission gate as the agent permission category `start_subagent` (record 09), shown as a card under Allow once and started without one under Allow for this session or Always allow, because a subagent spends the user's model credit and the owner approved routing it through the approval modes on 2026-10-07. Subagents may not call OnCue's own tools, and a question a subagent asks is dismissed, so only the primary agent asks the user for anything. The context meter sizes only the primary agent's conversation, while the session's cost includes every subagent's spend. Every subagent event carries the subagent's id and its own idle and errors never move the primary agent's run, which keeps one owner per run. A subagent's model calls use the run's relay and broker token, so they are scoped and revoked as the run's are; OnCue meters no model use, so the bound is on count, not tokens. Rejected: a separate token budget per subagent (OnCue does not meter model use), allowing a repository's own agents (an untrusted repository would choose the subagent's prompt and permissions), and nesting (no product need, and the abort cascade would have to walk a tree). Codex, Pi, and Claude Code keep their subagents off. Records 04, 12, 13; `services/bridge/src/subagents.ts`.

## 2026-10-04

### The bridge's reconnect budget is per outage, and a sent frame is the only one it may forget
Date: 2026-10-04

The bridge used to give up after eight reconnect attempts over its whole life, so the eighth Worker deploy or network blip in a long session killed the sandbox; and its 512-frame resend ring evicted the oldest frames whether or not they had been sent, so a long disconnect in a busy run silently lost timeline rows. The budget is now per outage: a link that was welcomed and stayed up 30 seconds ends the outage, waits are jittered and capped at 5 seconds, and one outage gives up after 10 minutes of wall-clock time rather than a count. A count per outage was rejected because a slow outage and a fast one need the same patience; no limit at all was rejected because a sandbox whose control plane is gone for good must stop spending. The object's stale-generation (4000) and unauthorized (4401) closes now end the bridge at once instead of being retried. The bridge also sent a reconnect's `runtime.connected` ahead of the older frames it had parked and kept it out of its ring, and stamped streamed frames it then dropped for want of a link, either of which leaves a gap the object, admitting only the next sequence, can never get past; `runtime.connected` is now stamped after the parked frames and kept, a streamed frame with no link takes no slot, and the resend ring keeps sent streamed frames too (4,096 frames, 8 MiB) so a half-open link's losses can be replayed. Unsent frames are never evicted, and no sent frame is evicted until the current link has stayed up 30 seconds, because a flushed backlog could otherwise push out the frames a half-open link lost. Unsent frames are bounded by bytes, and past the bound the bridge pauses reading OpenCode's event stream instead of dropping; this bounds the bridge's memory, not OpenCode's progress, which is not known to slow down. Ending the process at the bound was rejected because it loses the same rows and the work besides. Half-open links are detected with WebSocket pings, which Cloudflare answers without waking the object; an application-level reply from the object was rejected because it would cost a Durable Object request per heartbeat and need a coordinated Worker deploy, and the bridge enforces liveness only after a first pong, so a transport that does not answer pings behaves as before. Code: `services/bridge/src/protocol.ts`, `agent-io.ts`; records 01, 02, 04.

### A publish's own commit is reported as the user's
Date: 2026-10-05

The snapshot commit a publish makes (`publishDrafts` in `services/bridge/src/agent.ts`) is reported on `git.committed` with `authorType: "user"`, because the push happened on the person's request or under the push policy they set; a `git_commit` the agent makes stays `"agent"` (backlog A8). A review suggested `"system"`, since OnCue makes the commit and the content is the agent's; the owner chose `"user"` on 2026-10-05. Nothing reads the field for an authorization decision. Records 07 and 09.

### "Context used" is the last call's whole input plus what it wrote
Date: 2026-10-05

The composer's context gauge (record 13) needs one number for how full the model's window is. It is the latest answer's last model call: its uncached input, the input read from the prompt cache, the input written to it, and its output with reasoning, which together are what the next call reads back. Input plus output, which the bridge had sent, was rejected because with prompt caching almost all of the input sits in the cache counters: in the recorded OpenCode 1.18.30 session a call with 10,114 tokens of context reported `input` 2. The definition matches OpenCode's own (its `tokens.total` is the five summed, and each assistant message is one call) and the providers' (Anthropic's `input_tokens` excludes `cache_read_input_tokens` and `cache_creation_input_tokens`; OpenAI's Responses `input_tokens` includes `input_tokens_details.cached_tokens`, so the Codex parser subtracts it). Reasoning is counted although a provider may drop an earlier answer's reasoning from the next call, so the gauge errs high by at most that. A compaction is inferred from a fall of more than a quarter in a call's input side (uncached, cache read, cache write) between answers, never from the size, because a high-effort answer's dropped reasoning can shrink the size by more than that. OpenCode's `session.compacted`, Codex's `thread/compacted`, Claude Code's `compact_boundary`, and Pi's `compaction_end` were not mapped: no recording shows where OpenCode's falls among a compaction's messages, and each would need a protocol signal; mapping them is a follow-up. The figure is per sandbox generation, because each generation's harness starts a new conversation from the session's summary. The harness's report through the bridge is the source, not the Model Broker, because the report already rides `message.completed` and a broker-side figure would mean a Durable Object write per model call; the broker logs the provider's own counters so the two can be compared. A breakdown by system prompt, tools, and messages was left out because neither the providers nor OpenCode report one, and plan limits because each person brings their own key. Code: `services/bridge/src/normalize.ts` (`usageOf`), `apps/web/src/features/session/context-meter.ts`; records 04 and 13.

### The context meter's breakdown is the provider's own count, and comes back with the next answer
Date: 2026-10-05

The owner asked for the meter to split the context into parts, as other coding tools do, with every number exact. Neither OpenCode nor the providers report a split, so the Model Broker asks the provider: Anthropic's `count_tokens`, which is free, with the session's own key, as the owner approved. The parts are the system prompt, the harness's tools, OnCue's tools (`oncue_*`), and the conversation, which is the provider's own size for the last call less the counted parts, so the rows sum exactly. They are counted cumulatively (the minimal message, then with the system prompt, then the harness's tools, then OnCue's) so each part is a difference of two counts and nothing is double counted; the tool-use preamble falls to the harness's tools. Repository instructions were not split out: OpenCode 1.18.30 joins `AGENTS.md` into its one system block between the environment and the skills list with no end marker, so a split would be a guess. Counts reach the browser as a response header the bridge's relay reads and the next `message.completed` carries, keyed by a prefix of the prompt's hash so each answer gets its own call's counts and never the previous call's, rather than a session-object event, so the object gains no write and no read (record 01, "Read cost"); the cost is that a session's first answer, and the first after a prompt changes, shows the total and "Breakdown appears after the next answer". Counting runs after the answer is on its way, per isolate, cached by a hash of the prompt, and a failure shows no breakdown rather than an estimate. Because the key's rate limit is shared with the person's other sessions, a 429 from the counter pauses counting for that connection for a minute, and a session gets at most 10 distinct prompts counted in 10 minutes. OpenAI documents an input-token counting endpoint for the Responses API, but it could not be verified with a person's key, so OpenAI sessions show the total and say a breakdown is not available. "Until auto-compact" is shown only for OpenCode, whose rule was read from its 1.18.30 source: it compacts when an answer's `tokens.total` (the same sum as `usedTokens`) reaches the window less `min(limit.output, 32000)`. Code: `apps/web/worker/broker/prompt-counts.ts`, `services/bridge/src/relay.ts`, `apps/web/src/features/session/context-meter.ts`; records 04, 06, and 13.

## 2026-10-05 onward

### Deleting a session marks D1 first, keeps a tombstone, and a job erases every store
Date: 2026-10-05

The owner asked for session delete and archive in the app. The delete route marks `session_index` `deletion_pending` and records the `deletion_request` in one batch, then tells the session object, which stores `deletion_pending` and a tombstone, refuses new work, closes its browser sockets, and stops its sandbox through the user's stop (no checkpoint, since the content is being erased and pushed work stays on GitHub). D1 goes first so a failure after it leaves the job owing the session rather than a session stuck half deleted; the earlier route lost its mark only because projections overwrote it, which they no longer can. A job (`apps/web/worker/deletion/job.ts`) then removes R2 objects under the session's own prefix and by exact key after an ownership check, the D1 rows keyed by the session, and the object's storage, in that order so a rerun can always find what is left, and writes the receipt in the same batch that removes the index row. It touches only a session whose index row says `deletion_pending` (or is gone), closing any other request as skipped, because requests recorded by the earlier route may name sessions still in use. Attachments are never found by prefix, since they are keyed per workspace. The tombstone stays through erasure because a session id is derived from the create request, so a late or retried create would otherwise make the session again. `deletion_request` was rebuilt without its key to `session_index` (migration `0019`) rather than keeping a tombstone index row, because the receipt must outlive the row and an index row holds the title. Records 03 and 19.

### A projection moves the session's state only out of `creating`
Date: 2026-10-05

Archive, restore, and delete change the object's stored state and are written to `session_index.state` by their routes once the object agrees. The outbox projection stopped writing the column except to move a row out of `creating`. Projecting the state through the outbox was rejected: a state change commits no event, so the ordering guard skips its snapshot, and a snapshot taken before an archive or a delete would otherwise undo it when it drains. Records 03 and 10.

### Archiving stops the sandbox the idle way, and asks before cancelling a run
Date: 2026-10-05

The lead proposed and the owner accepted: archive stops the sandbox with a checkpoint (the idle stop's sequence, cause `idle`) rather than the user's no-checkpoint stop, so unpushed work is saved; the session moves to a collapsed Archived group; restoring returns it to Active, and its next message resumes it on a new sandbox through the existing resume path. A run still open is cancelled only when the request confirms it (`cancelOpenRun`); otherwise the server answers `409 run_open` and the browser asks. The stop reuses the existing cause rather than adding an `archived` cause, because the object's `sandbox_stop.cause` column has a CHECK constraint an existing table cannot change; the timeline therefore reads the stop as idle. Records 10 and 19.

### The creating sweep asks the object before deleting a row
Date: 2026-10-05

`sweepCreatingSessions` deleted `creating` rows by age alone. It now asks each row's object whether it ever committed a session and deletes only a row whose object says no; an object that cannot answer keeps its row. The cost is waking up to 100 objects per run when rows are stuck, and an object that never held a session keeps an empty schema afterwards. Record 03.

### A deletion receipt remembers the session's branch as a hash, for three days
Date: 2026-10-11

A review found that a `push` webhook delivered after a session's deletion finished locked down every session of the repository: the receipt removes the `session_index` row that says the ref is a session's branch, the branch stays on GitHub, and the App's own bot is the sender. The receipt now keeps SHA-256 over the repository's GitHub id and the full ref (`released_ref_hash`, migration `0022`), the webhook treats a ref a receipt of the last three days holds as a session's branch, and the scheduled deletion run blanks older hashes. Keeping the index row was rejected because the branch-choice work relies on its removal to release the branch, and the row holds the title. A separate table was rejected because the receipt already outlives the session and is content-free. The window is three days rather than for ever because, for as long as it lasts, a real escaped-token push to that ref would not be treated as an incident. The same review moved archived sessions into the lockdown: they keep their push policy, their archive checkpoint may still be pushing, and they push again once restored. Records 07, 19, and 22; `apps/web/worker/deletion/released-refs.ts`.

### An erase waits for stops in flight, tries a failed generation once more, and nothing is written after it
Date: 2026-10-11

A stop marks its generation ended and only then fetches and commits the sandbox's last output, so a deletion attempt running in that gap erased the object and the stop then wrote output and a snapshot carrying the title into the emptied storage. Calls carrying a stop forward are now counted like provisionings, the erase refuses while any runs and asks again after its own provider calls, and the object's commit paths refuse once the session is erased, which also covers work nothing counts (a pull-request call GitHub answers late). `commitControlEvents` asks an in-memory mark rather than the session table: a read per commit put a hot path at its read budget (record 01, "Read cost"), and only awaits in flight in the same memory can still hold the erased row. The erase also stops by name, once more, each generation that failed after a create was sent (the newest three), because their only stops were by name and the durable late stop that owed the last of them is gone either way. A refusal of that final stop is logged and the erase goes on: holding the deletion instead was rejected because a workspace whose Modal connection is gone would then never finish deleting any session with a failed generation, for a sandbox that almost always no longer exists. A deleted session's bridge is refused with close code 4401 rather than a bare 404, which the bridge would retry for ten minutes while its sandbox ran. Record 19; `apps/web/worker/session/object/session-state.ts`, `sandbox-stop.ts`, `commit.ts`.

### A deletion that stays owed is retried more and more slowly, never dropped
Date: 2026-10-11

The scheduled run retried every owed deletion every five minutes for ever. It now retries on every run for the first half hour after the request (which covers a sandbox still stopping and the late stop owed after a create), then hourly, then every six hours once the request is a day old. The pace goes by the request's age rather than its attempt count, because attempts can come quickly (a repeated request, the end-to-end lane's own scheduled runs) and must not use up the fast retries. Closing a request as failed after a number of attempts was rejected: the session is already hidden and refused everywhere, so a closed request would leave its stores undeleted with nothing owing them. Nothing shows a stuck deletion in the app yet (backlog). Record 19; `RETRY_WAITS` in `apps/web/worker/deletion/job.ts`.

### A session's one branch may be an existing branch the user chose
Date: 2026-10-05

The owner decided that a person chooses the branch a session works from, and may ask a session to work directly on an existing branch and push there. This widens "push only to the session's own branch" to "push only to the session's one branch: a new `oncue/` branch, or the existing branch the user chose at creation". The boundaries kept: the default branch and any protected branch are refused when the session is created and again before every push grant, by asking GitHub rather than trusting the install-time cache; a push grant still names exactly one ref; OnCue never force-pushes, so a branch that moved refuses the push; the push webhook knows the branch from creation; and at most one session of a repository holds a branch in any state, deletion included, judged in the same statement that takes it. Protection means classic branch protection or an active ruleset with any rule but the three that govern creating or naming a branch (the check is inverted so a rule type GitHub adds later guards by default), read per branch and failing closed; the ruleset half is unverified live until the owner approves the probe record 07 names. A person's open pull request is found by listing the head before opening anything, since GitHub refuses only an exact head-and-base duplicate; several open ones adopt none. Because sessions do not end, a branch an earlier session pushed to stays that session's: the person continues there rather than opening a second writer. A person's open pull request for the branch is adopted keeping their title, description, and base. Branch names the bridge cannot push (`REF_PATTERN`) are not offered rather than widening the bridge. The branch list is ordered default first, then GitHub's own order, because GitHub's list carries no dates and recency would cost a call per branch. The agent switching branches mid-session is deferred. Records 07, 08, and 09; code in `apps/web/worker/routes/sessions.ts`, `routes/branches.ts`, and `session/object/existing-branch.ts`.

## 2026-10-11

### The composer's bar holds one agent chip, and the sandbox's status lives only in the side panel
Date: 2026-10-11

The composer's bar held six controls: repository, branch, the Modal sandbox's status, the harness, the model, and the effort. Below 640 pixels four of them folded behind a "Details" button. The owner asked for the bar to hold three: the repository and the branch on the left, and one agent chip on the right that shows the model's name with the effort muted beside it and opens one panel for the harness ("Run with"), the model, and the effort; on a phone the chip keeps the model's name. Inside the panel the harness is a list like the model's, with all three states and every harness the deployment has not enabled still listed greyed; the effort is one row of buttons over the model's own levels, replacing the slider, with a line saying so for a model that has none; and the Claude mark keeps its own colour on the chip and in the panel. The owner also asked for the sandbox's status to leave the composer, on Home and in a session, and live only in the side panel, for the button that opens a session's side panel to carry a dot in the sandbox's tone while one is coming up or running (and none for a failed, stopped, or lost one), and for the context gauge to show on Home before a chat starts, reading 0%. The rules did not change: a session keeps its harness and model, effort levels are the model's own, and a model with none shows no effort.

What followed in the build, none of it the owner's own wording: the Modal tab now says what only the composer's indicator said ("Stopped after going idle", "Lost", and a keep-alive's end time), since it is the one place left; Home's "Modal: Connected" has no replacement, since the setup gate means Home is reached only with Modal connected; the "Details" fold is removed, and the bar instead shortens by its own width and stays one row down to 320 pixels; the panel is a dialog rather than a menu, because it stays open after a choice of harness moves the model; the effort slider and its animated fill are deleted, since nothing else used them; in a session the harness rows are text, the session's own marked "Fixed for this session"; and Home's gauge is a reading, not a button, since before the first answer there is nothing to break down. Code: `apps/web/src/features/session/AgentChip.tsx`, `Composer.tsx`, `SessionPanel.tsx`; record 13.

## 2026-10-13

### Sidebar status marks: a grey dot matrix, blue for finished, yellow for needs you, nothing otherwise
Date: 2026-10-13

This replaces the marks of "Session status dots" (2026-09-27); what a row's state is, and how it is read from the list, did not change. The owner asked for the working mark to be a grey animated dot matrix in the manner of other agent sidebars instead of the pulse through the fire colours, for a finished session to show a blue dot and one asking a question a yellow dot, and for a session not in use to show nothing instead of a hollow circle. So "finished" and "needs you" no longer share a colour.

What followed in the build, none of it the owner's own wording: the matrix is 3 by 3 and 10 pixels across, drawn a pixel past the dots' 8 pixel slot on every side because at 8 pixels it was too faint to read, with a three-dot trail stepping round the outer eight at 120 milliseconds a dot, in `--faint`; the dots at rest stay faintly visible so the mark keeps its shape; the trail was chosen over a random twinkle because every working row can then show the same frame; an unmarked row keeps its empty slot so a title does not move when its state changes; the light theme's yellow is deepened to `#b58a00` (3.2:1 on white) and its blue is `#2f6fed` (4.5:1), keeping the earlier 3:1 rule for a mark on white; reduced motion holds the first frame. No library was added: the mark is nine SVG circles and one keyframe. Code: `apps/web/src/features/home/Sidebar.tsx`, `status-matrix.ts`, `apps/web/src/styles/globals.css`; record 13.

### Sidebar rows are one line, and a long title scrolls on hover
Date: 2026-10-13

The owner asked for the time under each session's name to go, and for a name that does not fit to scroll left, like film credits, once the pointer has rested on it for about a quarter of a second, so the whole name can be read. The row is now its status slot and its title; the order of the list still follows latest activity.

What followed in the build, none of it the owner's own wording: the scroll starts on resting anywhere on the row, not only on the words; it runs at 100 pixels a second, so a longer title takes longer rather than moving faster, stops when the end shows, and resets at once when the pointer leaves; the slide is a transform rather than a moving text indent, because the indent laid the line out again on every frame and stuttered; a title that fits never moves; reduced motion keeps the title still; and the age formatter and the row's unused repository field were deleted with the line they fed. Code: `apps/web/src/features/home/Sidebar.tsx`, `sidebar-groups.ts`; record 13.

### A key is marked invalid only after the provider rejects the key itself
Date: 2026-10-13

On the hosted app a session started on an OpenAI key last validated eight days earlier: the sandbox came up, the first model request was answered 401, the broker marked the connection `invalid`, and the run paused. The owner asked for this to be handled gracefully and approved two steps. First, session creation asks the provider about the chosen key, with the free models call, before any sandbox is requested and alongside the repository read; a rejection refuses the create, keeps the draft, and says on Home which provider rejected the key, and a provider that is merely unreachable does not hold the session back. Second, a rejected model call is confirmed before the key is condemned: the broker runs the same key check, marks the connection invalid only if that is rejected too, and otherwise fails only that run; Settings gains a Re-check control.

What followed in the build, none of it the owner's own wording. A model request refused as unauthorized on a key the provider still accepts is answered `model_unavailable`: the key works and this model or endpoint is what it could not use, and of the non-retryable categories it is the one the bridge pauses on at once. `request_rejected` was rejected because the bridge leaves it to the harness, which would retry or fail in its own words. When the confirming check gets no usable answer the request is still answered `authentication_failed`, since that is what the provider said, but the connection is left alone; marking on an unconfirmed rejection was rejected as the behavior being replaced, and answering a temporary failure was rejected because the harness would retry a request the provider had refused. A key validated within ten minutes is not asked about again at creation, and a check waits three seconds at most. Every write names the sealed value that was checked, so a key replaced while the old one was being refused is not marked. The key is opened in a second broker file, `key-check.ts`, beside `forward.ts`; routing every check through the forwarding path to keep one opener was rejected because session creation and Settings have no forward to ride. A provider that answers 401 or 403 to the models call for a reason other than the key still reads as a rejection, because both adapters map those statuses to `authentication_failed` on status alone. OpenAI documents a 403 for an unsupported country or region; whether the models call returns it for a working key is unverified, and a live call from such a region is the test that would settle it. Records 06 and 15; `apps/web/worker/broker/key-check.ts`, `forward.ts`, `routes/sessions.ts`.

### Home reads the workspace's keys again whenever they may have changed
Date: 2026-10-13

After a person revoked both keys in Settings, connected a new one, and went back to Home without reloading, Home was refused three times with words that told them to pick the model again. Home's list of keys comes from `/api/me`, which nothing refreshed after a change in Settings, so Home sent the revoked connection; and the refusal's code had no sentence of its own. Settings now refreshes that list after every connect, replace, revoke, and re-check; Home refreshes it when a create is refused because of the chosen model and says what happened; and the connection Home sends is never one the list no longer holds. Having Settings and Home share one store of connections was rejected as a larger change than the defect needed. Record 15, "Refusals at session creation".

### A rejected key stops the sandbox at once, as an idle stop
Date: 2026-10-13

On the hosted app a session started on an OpenAI key the provider then rejected. The run paused, and its sandbox stayed up for the 20-minute idle period on the user's Modal credit, refusing every message meanwhile. The owner approved stopping the sandbox right away on a rejected key, with a checkpoint, so that the same session can Continue once the key is replaced, and approved the change this makes to record 11's idle rule.

How it was built is the builder's choice within that, on the lead's recommendations. The idle deadline is the last activity itself when the current run's newest pause in the generation is `run.paused` with reason `model_failure` and category `authentication_failed` (`idleDeadline` in `apps/web/worker/session/lifecycle.ts`), so the existing idle stop starts at once and nothing new is stored: the alarm finds the stop due from the run's state and the pause event until the stop row exists. Only `authentication_failed` is hurried. `usage_limit_reached` and `model_unavailable` keep the 20 minutes, because the owner approved the rejected key alone and those two can clear without the user touching the session. The object reads the category from the stored event rather than the connection's row in D1, so a broker that later confirms a rejection before reporting it changes nothing here. A keep-alive the user asked for still holds the stop off, on the reasoning that it is an explicit request to keep the machine and is bounded to an hour.

A stop cause of its own (`key_rejected`) was rejected. `sandbox_stop.cause` carries a CHECK constraint, an existing table's constraint cannot change, and the object's schema has no migrations, so a new cause needs a second table, a new picklist value on `sandbox.stopped` and `sandbox.credentials_revoked`, and fixture and record-checker changes. Archiving reused `idle` for the same reason. The cost is that the timeline reads the stop as idle and only the `run.paused` before it says why. Starting the stop directly from the frame that carries the pause was also rejected: an object evicted between that commit and the stop's first write would have no stored fact to restart from, where the deadline is derived again on every wake. Changing the bridge to checkpoint before it reports the pause was rejected because it changes the bundle, which makes the bridge-isolation test on a real sandbox owed, and the bridge already takes a checkpoint while a paused turn winds down. Records 02, 04, 10, 11, and 15; `apps/web/worker/session/object/store-lifecycle.ts` and `sandbox-lifecycle.ts`.

### The agent chip's panel is kept small
Date: 2026-10-13

The owner found the panel took too much of the screen beside the pickers of two other coding tools, and approved three changes the lead proposed. "Run with" is shown only where the deployment offers two or more harnesses, and lists only those; a harness that is not enabled is left to Settings, Harnesses. This narrows the 2026-10-11 entry above, which put the harness, the model, and the effort in one panel: the harness is still in the panel whenever there is a choice of it. The panel is 272 pixels wide, down from 300; the lead first proposed about 230, which cut off the last of an OpenAI model's six effort levels. Picking a model closes the panel, where it used to stay open; with the confirmation dialog gone, an open panel covered Send in a session. Choosing a harness or an effort still leaves it open. Record 13.

### A session's model changes between runs, on the owner's message (proposed)
Date: 2026-10-13

Status: proposed. The owner asked for "switching a model inside an existing sandbox", after a hosted session was left stuck on a key its provider rejected. Record 15 already listed a model change as approved but not built, and fixed its limits: one model per run, the owner's explicit choice, no fallback. Everything below is how the build filled that in, and none of it is the owner's own decision yet.

- **The change rides the message that starts the next run.** A `run.start` that continues the session's latest run and names another connection or model is a model change; the run's trigger is `model_change`. A separate "set model" command was rejected: the protocol already carries the model on `run.start` and the trigger in `run.queued`, effort already changes this way, and a setting that sits unused between runs would be a second source of truth for which model the next run uses. The object builds the stored record from the connection row and the catalog and reads only two ids from the browser's.
- **A paused or interrupted run ends as cancelled, and a new run continues it.** Record 15 forbids a change inside a run and record 01 lets a paused run leave only by resuming or by `cancelled`, so a paused run cannot itself move to another model. Asking the owner to stop the run first was rejected as two steps for one intent; a new terminal outcome such as "superseded" was rejected because it changes record 01's state machine.
- **In a live sandbox, OpenCode is prompted on the new model in the same process and conversation.** OpenCode reads its configuration once, so the bridge now declares every catalog model and points every provider at the relay when it starts OpenCode; a prompt already names its model. Restarting OpenCode on a new configuration also worked in a local trial (its stored conversation continued) and was rejected because the bridge would need a restart path it does not have and the object would see a runtime exit it must not treat as a loss. Always moving to a new sandbox was rejected because it costs a cold start and the owner asked for the same sandbox. Declaring a model does not let the agent reach it: the relay holds one token for one model and the Model Broker refuses any other.
- **Subagents name no model.** They were pinned to the model OpenCode started on, which a changed run's token would refuse. Unpinned, a subagent runs the model of the message that started it (observed with OpenCode 1.18.30).
- **Where the harness or bridge cannot change in place, the sandbox stops the idle way and the run starts on a new one.** That is Codex, Pi, and Claude Code, whose adapters have never run a second model, and any sandbox whose bridge predates this change. Refusing the change there was rejected: the only way on would be the user's own stop, which takes no checkpoint and loses uncommitted work.
- **An earlier token is not revoked.** As with an effort change, the relay drops it and the broker would still honour it until it expires (`backlog.md`, B32).
- **No confirmation dialog (decided by the owner).** A first version asked in a dialog before changing; the owner removed it the same day as unnecessary. Choosing a model sends nothing, and a note under the composer says what the next message will do and whose key it charges, with a way back. The owner also removed the note's lines about a smaller context window and an effort level that does not carry over; the lead kept one warning, for a conversation that does not fit the chosen model's window.

Open for the owner: whether a paused run should end as cancelled on a change; whether the fallback to a new sandbox should happen without asking; whether a change should first check the new key with the provider; and whether to mark the change in the timeline. Code: `apps/web/worker/session/model-change.ts`, `object/model-change.ts`, `dispatch.ts`; `services/bridge/src/agent.ts`, `opencode.ts`; `apps/web/src/features/session/model-switch.ts`. Record 15.

### A fresh clone needs no Clerk application
Date: 2026-10-13

`apps/web/.env` committed the publishable key of the Clerk application the owner's hosted deployment uses, so every clone would have loaded Clerk's browser SDK from it. OnCue is open source and deployed by whoever runs it, so the owner chose to stand in for the SDK by default. With no key configured, the dev server resolves `@clerk/react` to a small stand-in; `/dev/sign-in` still mints the session cookie and the Worker still verifies it, so only Clerk's SDK is replaced, which is what a double is allowed to do. The four browser tests that inspect Clerk's own form (its theming, and the loading screen held by delaying its script) run only when a developer sets their own key, and are skipped with a reason otherwise. The alternative of a throwaway Clerk application whose key is committed kept every test running for everyone but tied every clone to an account staying alive. `apps/web/vite-plugins/clerk-stand-in.ts`, `apps/web/src/dev/clerk-stand-in.tsx`, `scripts/clerk-key.mjs`.

### A deployment's own values live in a gitignored file, never in a tracked one
Date: 2026-10-13

`apps/web/wrangler.jsonc` held the owner's hosted D1 database id, bucket name, and Clerk public key, so anyone else deploying would have had to edit a tracked file and resolve a conflict on every pull. The tracked config now describes the local environment only. A deployment names its database, bucket, and Clerk application in the gitignored `apps/web/deployment.json`, and `apps/web/scripts/hosted-config.mjs` generates the Wrangler config a deploy uses from the two. The generated config keeps the `env.hosted` shape the hand-written block had, so an existing deployment resolves to the same Worker name, bindings, and Durable Object namespace as before; a flat config under a new Worker name would have orphaned its sessions. The file holds public values only and refuses unknown fields, so it cannot become a second place secrets live. The workflow's deploy job is removed with it: a deploy needs that file and stays a deliberate act from an operator's machine. This design is the implementer's, made under the owner's decision to open-source OnCue for people who deploy it themselves. `apps/web/scripts/deployment.mjs`, `scripts/deploy-hosted.mjs`, `scripts/wrangler-hosted.mjs`, record 20.

## 2026-10-14

### An id nobody created is refused before its object is woken
Date: 2026-10-14

The bridge's upgrade and the one-time bearer routes (artifact upload and restore, the bridge's attachment fetch) were forwarded to `idFromName(<the id in the path>)` unchecked, because the credential's hash is kept only in the session's object. For an id nobody created, that woke a new object, whose constructor builds the whole schema and which nothing ever removes. Anyone who could reach the Worker could spend the deployment's objects and daily quota at no cost to themselves, and on Workers Free a daily limit blocks every Durable Object on the account. Nothing was readable this way; the cost was availability.

The Worker now asks D1 first whether the id was ever a session: its `session_index` row, which is written before the object is created, or the deletion request a deleted session leaves behind. A deleted session has to keep reaching its object, which answers its bridge with the close code that ends it at once where a bare 404 would be retried for the bridge's whole outage window. The lookup is two point reads on a connect, not on a frame. It fails open: an unreadable D1 forwards as before, since the object still authenticates and the lookup guards only against waste.

Rejected: a signed prefix on the credential and the bearers that the Worker could verify without D1. It would cost no read, but it changes what the bridge is handed and what every stored token looks like, for the same result. `apps/web/worker/session/known-session.ts`, record 01.

### A harness the image does not install is refused, and not shown
Date: 2026-10-14

Each `RUNTIME_CATALOG` entry now says whether the sandbox image installs its harness (`inImage`): OpenCode and Codex do, Pi and Claude Code do not. `resolveRuntime` refuses a harness without it (`runtime_not_in_image`) before it reads `ONCUE_RUNTIME_ALLOWLIST`, so naming Claude Code or Pi there no longer offers the composer a harness whose spawn can only fail, and Settings, Harnesses and the composer list only installed harnesses. The adapters stay in the bridge. `test_images.py` fails when the flag and the image's layers disagree, which keeps the two from drifting without the Worker asking the controller what its image holds. Rejected: the allowlist alone, which let an operator enable a harness no image carries; and a controller call at each resolve, a network round trip for a fact fixed when the image is built from this tree. `apps/web/worker/runtime/resolve.ts`, `packages/protocol/src/runtimes.ts`; record 04.
