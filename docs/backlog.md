# Backlog

Known defects and gaps in what is built. Planned work (plan steps PR-14 to PR-16 and parked spikes) is in [roadmap.md](roadmap.md); this file holds what is wrong or missing in what exists.

Ids are stable because code comments cite them. An id is never reused. Resolved items leave this file and are listed in [history.md](history.md). A24 and A25 are reserved for the two items GitHub #58 proposes (sub-agents and the agent's ask-the-user prompts; see the roadmap). Many items in section D concern the maintainer's own deployment. If you hit something not listed, open an issue.

## A. Users meet these today

### A5. The concurrent-sandbox caps never fire

`decideAdmission` refuses on `workspace_cap_reached` and `platform_cap_reached` (`apps/web/worker/admission.ts`), but both callers pass `workspaceActiveSandboxCount: 0` and `platformActiveSandboxCount: 0` (`handleCreateSession` in `apps/web/worker/routes/sessions.ts`, `decideAdmissionNow` in `apps/web/worker/session/object/commit.ts`). Counting active sandboxes with a query that does not scan is part of PR-14.

### A10. A sandbox that lies about its checkpoint can put a wrong commit in the pull request body

When a publish pushes nothing new, the verification section's revision comes from `readDurableHeadSha` (`session/object/store-git.ts`, called by `maybeOpenPullRequest` in `session/object/pull-request.ts`, reading the `checkpoint` table), which the sandbox's own `repository.checkpointed` frame writes. A sandbox that falsely reports a `branch_push` gets a revision that was never pushed into the body; GitHub still shows the true branch. Fix: read the branch head from GitHub under the pull-request token before writing the body.

### A11. `planApproval` and `fileEdits` are policy fields with no mechanism

`SessionPolicy` carries both (`packages/protocol/src/families/policy.ts`) and `DEFAULT_SESSION_POLICY` sets them (`apps/web/worker/policy/git-policy.ts`), but nothing reads them: no run waits for a plan and no edit is blocked. `decideProposal` in `git-policy.ts` refuses any proposal that changes either, so the gap is not half-honored. Building each needs a mechanism, tier-table entries, and a card.

### A12. Settings, Repositories once fired about 800 identical secrets requests on one load

Observed on 2026-09-22: opening Settings, Repositories sent a burst of identical `GET /api/repositories/:id/secrets` requests, each a paid request on the hosted Worker. The cause was not found; `RepositorySecrets` loads once per mount with a stable callback (its `reload`, `apps/web/src/features/secrets/RepositorySecrets.tsx`) and the code is unchanged since, so the loop is elsewhere or intermittent. No lane counts requests per resource, which is how it went unnoticed.

### A14. The deployed sandbox controller bills every hour of the day

`min_containers=1` on the controller function (the `@controller_app.function` decorator on `fastapi_app` in `services/sandbox-controller/app.py`, with its reason in the comment block above `CONTROLLER_APP_NAME`) keeps one container warm, about $5 a month whether or not any session runs. It is an owner decision: keep the warm container, or set `min_containers=0` and accept a slower first session after a quiet spell, and record the choice beside the setting.

### A19. A session with no repository cannot create one

Nothing in the Worker creates a GitHub repository. Offering to create one (private or public, with the user's approval) needs the GitHub App's Administration permission, which only the operator can grant, and a new approval card. Not scheduled.

### A20. Records promise user controls that nothing builds or schedules

Not built: changing the model on a message held for the next run (`run.follow_up` carries `effort` but no model, `packages/protocol/src/commands.ts`; a change between runs is built, record 15), renaming a session, notifications, sidebar search, pause and retry on a run, retry after a model failure, the 90-day artifact expiry (`artifact_index.expires_at` is written in `apps/web/worker/artifacts/upload.ts` and never read), disabling an account (`user.status` is only ever written `'active'`, `registerActor` in `apps/web/worker/auth/register.ts`), a Clerk webhook route, and record 11's progress watchdog and cache layers. Each needs an owner or a "deferred" line in its record.

### A21. The speed spike's fixes are parked

GitHub #51 (open, unmerged) measured a new session at about 20 s, 5 s of it one OpenCode health probe that hangs to its full timeout; the probe still uses `REQUEST_TIMEOUT_MS` (`health` in `createOpenCodeClient`, `services/bridge/src/opencode.ts`). Its ranked fixes wait on owner decisions; see the roadmap's parked work.

### A22. Previews wait on a dedicated domain

GitHub #52 (open, unmerged) showed previews can be kept private with Modal connect tokens, but they need a registrable domain the operator has not bought. The Preview tab is a placeholder (`COMING` in `apps/web/src/features/session/SessionPanel.tsx`). See the roadmap's PR-16.

### A23. A session with no repository cannot write its work tree

The bridge hands `/workspace` to the agent user only after a clone (the `chown_workspace` effect in `stepCloneSettled`, `services/bridge/src/agent.ts`); the no-repository arm moves straight to `{ kind: "none" }` (the model grant in `stepGrant`, same file), leaving the tree owned by the bridge user, so the agent's writes fail. Fix: take the same ownership step when nothing is cloned, with a bridge test and a test C probe that the bridge's files stay out of reach.

### A26. The create route reports a dead installation as an unreadable declaration

When GitHub answers a token mint with 404 for an installation verified within the last eight hours, the create route answers `secrets_unreadable` (`prepareTaskBranch` in `apps/web/worker/routes/sessions.ts`) rather than `github_reverification_required`. The Home prefetch catches this first (`apps/web/worker/routes/secrets.ts`), so a person usually sees "Reconnect GitHub" before sending. Marking the installation row unauthorized on a 404 mint would make every route refuse the same way.

### A28. The status dot says "Needs you" during a ceiling replacement

A run replaced at the sandbox lifetime ceiling is `interrupted` for the few seconds before the next generation starts, and `interrupted` maps to `needs_you` (`RUN_PHASE` in `apps/web/src/features/home/session-activity.ts`) because the projected state does not carry the reason. The session screen says "Resuming" at the same moment.

### A29. The side panel is squeezed at phone width

The conversation panel's `minSize` is 360 px and the side panel's is 320 px (`apps/web/src/features/session/SessionScreen.tsx`, the `ResizablePanelGroup`), which cannot both fit at 375 px, so the review panel opens as a narrow strip beside the timeline. The Agents view is squeezed the same way: a subagent's detail keeps its meta line and prompt whole by wrapping them, but its steps are cut to a few characters a row ("gh … · 1 action"). The side panel needs a small-screen layout (for example, over the timeline).

### A32. A paused run with its sandbox still up cannot take a message

A run paused (for example by a model failure) while its sandbox is still attached takes no message: the composer offers Stop run and explains (`waitReason` in `apps/web/src/features/session/composer-state.ts`), because record 01 lets such a run leave only through `provisioning` or `cancelled` and record 10 refuses a resume onto a live sandbox. The person must stop the run and send again, or wait for the idle stop and Continue. Resuming the paused turn in place needs a protocol command and bridge support, then a composer intent that uses it. A run paused on a rejected key no longer waits there: its sandbox stops at once (record 11), unless a keep-alive is running.

### A31. A paused run waiting on a question shows "Working"

When an idle stop pauses a run whose question card is still open, the timeline's activity group keeps its "Working" shimmer, because it reads the run as in progress whenever the run has no outcome, while the status dot and the side panel correctly say the run needs you. The group should treat a paused run, or an open question, as not working.

### A34. A subagent started while OpenCode's event stream was down is never shown

The bridge learns of a subagent from OpenCode's `session.created` for the child conversation and from the primary agent's `task` part that names it, both on OpenCode's event stream (`services/bridge/src/subagents.ts`). When that stream drops and the bridge subscribes again (`subscribeLoop` in `services/bridge/src/agent-io.ts`), it re-reads only the questions OpenCode is waiting on. A child whose `session.created` fell in the gap is unknown to the bridge, so its rows are dropped as another conversation's and it is never announced, while its slot waits; and a `task` part that settled during the gap leaves its subagent "running" and holding one of the run's four places until the run ends. Fix: on `server_connected` during a run, read the run's children (`GET /session/{id}/children`) and the primary agent's `task` parts, and feed them through the same reducer inputs; a reducer test with a dropped stream should cover it. Found in review; not reproduced.

### A35. Stopping or resuming a subagent has rough edges

Three things the user can meet. A `task` call that resumes an earlier subagent (`task_id`) is aborted by the bridge (`refuseResume` in `services/bridge/src/subagents.ts`), but its permission ask arrives before the part that carries `task_id`, so under Allow once the user still sees a card and allows a start that is then aborted, and the model reads only "Task cancelled" with no reason; refusing in turn through `HeldAsk.refusal` once the input is known would say why. A subagent's abort that fails is retried on the next stop, but the bridge does not report the failure, so the Agents view can only give the Stop button back after fifteen seconds ("It is still running. Try again."); an event for a failed stop would let it say so at once. A run paused by an idle stop whose bridge did not report its subagents keeps their rows `running` until the run starts on a new sandbox, because the session object ends orphaned subagents only on `run.interrupted` (`orphanedAgentEnds` in `apps/web/worker/session/object/subagent-gate.ts`). In the Agents view at phone width, finished rows read "General  Failed" with no separator, the detail's title truncates, and a wrapped fact line can end on a trailing "·".

### A36. A deletion that cannot finish is invisible in the app

A deletion whose sandbox cannot be stopped (the workspace's Modal connection was removed while it ran, or the provider keeps refusing) stays owed: the session is hidden and refused everywhere, the job retries it hourly and then every six hours (`RETRY_WAITS` in `apps/web/worker/deletion/job.ts`), and nothing tells the user or an operator except `deletion_request.failed_step` in D1 and a `session.deletion` `pending` log line per attempt. Once sessions can hold a GitHub branch through their index row, such a session also keeps its branch held with nothing on screen to explain it. Show owed deletions somewhere the owner can see, and alert on one that has waited more than a day.

### A33. Every branch search re-reads the repository's rulesets

Each debounced search in the branch picker (`apps/web/worker/routes/branches.ts`) mints and revokes a token and reads up to three pages of branches, the rulesets list, up to ten rulesets, and an exact-name lookup: up to about 17 GitHub calls per keystroke pause, against the installation's 5,000 an hour. The rulesets do not depend on the search text. Fix: read them once per picker opening, or cache them per repository for a minute.

### A37. A sandbox killed for running out of memory reads as stopped or lost

Modal kills a sandbox that exceeds its memory with SIGKILL, the same exit code 137 its own terminate produces, and the controller reads 137 as `stopped` (`SIGKILL_EXIT` and `state_from_exit` in `services/sandbox-controller/sandboxes.py`). A hosted session on 2026-10-05 that ran a repository's three test suites at once ended this way: the bridge's link dropped, the object's probe found the sandbox gone, and the run failed as "sandbox lost" with nothing saying memory. The controller cannot tell the two kills apart from the code alone; it needs Modal's own reason for the exit, or the object's knowledge that it sent no stop.

### A38. The sandbox is too small for a repository's heavy checks

A session's sandbox asks for 1 CPU and 2 GB, bursting to 2 CPUs and 4 GB (`"standard"` in `services/sandbox-controller/images.py`). OnCue's own test suites run together exceed that (A37). There is no larger size and no setting; record 02 names only the one.

### A39. A run is shown paused after a model failure the harness went on past

The bridge pauses a run on `authentication_failed`, `usage_limit_reached`, and `model_unavailable` (`PAUSING_CATEGORIES` in `services/bridge/src/agent.ts`). On hosted on 2026-10-05 OpenAI answered one call with 401 and the bridge reported `run.paused`, while OpenCode kept working, so the timeline said paused beside a run that showed "Working". The pause should either stop the harness's turn or be cleared by the next call that succeeds.

For `authentication_failed` the mismatch now lasts only as long as the stop takes: the session object checkpoints and stops the sandbox as soon as it stores the pause (record 11, "What counts as activity"), and the stop's `runtime.shutdown` ends the harness. Three things remain.

- Why the bridge's abort did not stop that turn was never found. For `usage_limit_reached` and `model_unavailable` a harness that carries on still shows "Working" beside a paused run until the idle stop.
- One 401 that the provider would not have repeated now stops the sandbox, where before it only paused the run. The run continues from the checkpoint, on a new sandbox, after a cold start.
- The object lets `run.started` move a paused run back to `running` (`applyRunRow` in `apps/web/worker/session/object/store-session.ts`), a move record 01's machine does not have. The bridge's reducer cannot send one after its own pause, but a sandbox that does calls the early stop off if the frame lands before the alarm, and leaves a run that reads running on a stopped sandbox if it lands during the stop. Stop run clears either. The idle stop's own pause of a run that waited on a question has the same gap.

### A40. Several open pull requests for one branch adopt none, without a word

A session working directly on an existing branch adopts that branch's open pull request. When the branch is the head of more than one, it adopts none and opens none, and only the log says why (`ambiguous` in `apps/web/worker/github/pull-requests.ts`). The timeline should say so, which needs a new event in record 04.

### A41. The models of a provider with no key fail contrast in Settings

Settings, Model providers greys the catalog of a provider with no key by drawing the rows at 55 percent opacity (`ModelRows` in `apps/web/src/features/settings/ModelProvidersSection.tsx`). axe measures the model's name at 4:1 and its line of facts at 2.1:1 on the light theme, both under the 4.5:1 that WCAG AA asks of text this size. No lane audits the page with one provider unconnected, which is how it went unnoticed; `e2e/model-key-checks.spec.ts` audits only the connected provider's card for this reason.

### A42. A stopped session resumes on a key nobody has checked

The key check at session creation (record 06, "Key checks") does not run when a stopped session is resumed, so a key rejected since the session started is found only by the resumed run's first model request, after the sandbox is up. A check before the resume would save that sandbox.

### A43. The object's refusal of a resume still says a new session is the only way on from a refused key

The session object's refusal of a resume on an inactive connection ends "and start a new session" (`findRejection` in `apps/web/worker/session/commands.ts`; record 10 quotes it). A rejected key can be replaced in place and the run continued, and since a session's model can be changed (record 15), choosing a model on another active connection also continues the work. The notes under the composer say both; the object's message should too.

### A44. A rejected key reads as no key in two places

A key the provider rejected is `invalid`, not gone, but two surfaces count only active keys. A harness whose only provider key was rejected shows Connect, to Settings, Harnesses (`harnessOptions` in `apps/web/src/features/harnesses/harness-state.ts`), where the key is not replaced. `/setup` offers the add-a-model step while no key is active (`setupScreenOf` in `apps/web/src/features/setup/setup-step.ts`), and its form answers `already_connected` for a provider that holds a rejected key (`createConnection` in `apps/web/worker/broker/connections.ts`); Home no longer links there when a key banner is showing, so the step is reached only by typing the address. Both should send the person to Settings, Model providers to replace the key.

### A45. The session details' Continue button fails contrast

The rail's Continue is white 12 px text on the accent (`bg-accent text-white` in `apps/web/src/features/session/ContextRail.tsx`), a contrast of 3.44 against the 4.5 that text this size needs; axe reports it as serious. No lane audited a screen that shows it until the replaced-key state did, and `e2e/a11y.spec.ts` audits that state with the details unpinned for this reason. Fix the button's colours, then audit the state pinned.

### A46. A remembered model is dropped when its key was revoked and a new one connected

Home remembers the last model chosen as a connection id and a model id (`apps/web/src/features/home/model-choice.ts`). Replacing a key keeps the connection id, so the memory survives it. Revoking a key and connecting a new one for the same provider gives a new id: `HomeRoute` (`apps/web/src/routes/routes.tsx`) then finds the remembered connection gone and drops the model id with it, so the composer opens on the oldest key's recommended model even though the remembered model is offered again. Fix: when the remembered connection is gone, prefer an active connection whose catalog lists the remembered model.

### A47. A sandbox stopped for a rejected key would read as stopped for going idle

The timeline's sandbox row and the Modal tab word a stop from its recorded reason: "Sandbox stopped after going idle" (`STOPPED_LABEL` in `packages/protocol/src/view.ts`) and "Stopped after going idle" (`sandboxStateLabel` in `apps/web/src/features/session/SessionPanel.tsx`). A stop made because the run paused on a rejected key, if it is recorded with the `idle` reason, reads as if the person had walked away, beside a pause row that says the key was rejected. Neither place knows the run's pause: the row's title is folded from the stop event alone and the tab is given only the sandbox. Fix: give the stop its own reason, or let both read the run's pause and say "Stopped after the model key was rejected".

### A48. The note for a model change cannot say whether the model reads images

The note under the composer (`model-switch.ts`) lists a smaller context window and an effort level that does not carry over, and says nothing about image input, because the model list the browser gets (`ModelSpecSummary` in `apps/web/src/lib/api/setup.ts`) does not carry the catalog's `imageInput`. Add the field to the summary and a line to the note.

### A49. A model change is not checked against the provider before its run starts

The session object checks a changed model against the connection row's status and the catalog (`decideModelChange` in `apps/web/worker/session/model-change.ts`), not against the provider. A key the provider has stopped accepting, or one without access to the model (see also B11), fails at the run's first request, after any new sandbox has started, and pauses the run. Check the named connection's key against the provider, as saving a key does (`validate` in `apps/web/worker/broker/providers/`), before a paused run is ended or a sandbox stopped for the change.

## B. Invisible today, costly later

### B3. Tables and events nothing uses

`audit_entry`, `projection_cursor`, and `task` (`apps/web/migrations/0001_core.sql`) are never read or written by the Worker; `artifact_index` and `workspace_member` are written and never read. In the session object, `review_item` has no reader or writer and `sandbox_attachment.last_heartbeat_at` is never written (both tables in `apps/web/worker/session/schema.sql`) while the bridge heartbeat is parsed and dropped (`parseBridgeControlFrame` in `session/object/wire.ts`). The protocol's five `review.*` events, `plan.blocked`, `plan.cancelled`, `status.updated`, `runtime.heartbeat`, and the `context.add` command have no producer. The audit table (PR-14 writes it) and the heartbeat column (use it or drop it) matter most.

### B11. The Anthropic catalog is not narrowed to what a key can use

The picker offers every row of `ANTHROPIC_MODELS` (`apps/web/worker/broker/providers/catalog.ts`) on every Anthropic connection, and key validation reads `/v1/models` only for its status (`validate` in `apps/web/worker/broker/providers/anthropic.ts`). A key without access to a model fails on the first forward, after the session and sandbox exist. Store the models and effort levels the key may use and intersect the catalog with them.

### B12. OpenCode carries effort as a prompt `variant`

The bridge passes a run's effort as the prompt's `variant` (`createOpenCodeClient` in `services/bridge/src/opencode.ts`) on OpenCode 1.18.30 (`RUNTIME_CATALOG` in `packages/protocol/src/runtimes.ts`); the Model Broker writes the level into every request regardless (`apps/web/worker/broker/effort.ts`). When OpenCode is next upgraded, re-check whether effort became a first-class setting and whether the variant reaches the wire.

### B15. `pnpm dev:modal` cannot clone a repository

Under `pnpm dev:modal` the sandbox is real but GitHub is the local double, and the clone URL points at `127.0.0.1`, which a Modal sandbox cannot reach; `pnpm controller`'s tunnel exposes only the dev server (`openQuickTunnel` in `scripts/controller.mjs`). Either tunnel the GitHub double too, or document that `dev:modal` supports sessions without a repository only.

### B18. Claude Code's file tools never ask before a path outside the project or an env file

`CLAUDE_ALLOWED_TOOLS` (`services/bridge/src/claude.ts`) allows `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, and `LS` by bare name, so Claude Code never sends `can_use_tool` for them, and `classifyClaudeAsk`'s outside-the-project and secret-file rows cannot fire (record 09, "Harnesses"). Narrowing the allow rules to the work tree, the secrets directory, and the attachments directory (`Read(//workspace/**)` and the like) and adding `ask` rules for env files would make them fire, but Claude Code's rule matching for absolute paths and for `Glob` and `Grep`, and whether `--settings` ask rules apply under `--setting-sources ""`, are unverified. Needs a run of the pinned Claude Code against the scripted model before it is enabled for anyone.

### B19. Subagent tracking trusts what a well-behaved OpenCode sends

Found in review, none reproduced. A child conversation no `task` call ever names stays held and unannounced until the run ends. Slots match a new conversation by subagent name, not by call, so a start and a resume of the same name in one turn can leave a slot counted until its call settles. An ask from a conversation the run never heard of is shown as the primary agent's, and an agent that prompts OpenCode's HTTP API on loopback, rather than through `task`, can still run a conversation the bridge drops the events of. The bridge relies on OpenCode publishing `session.created` before the `task` part that names the child (true in the recorded 1.18.30 trace); if an upgrade flipped that, every subagent would be aborted at its start, so the fixture must be recorded again on upgrade. `askingSubagent` (`apps/web/worker/session/object/permission-gate.ts`) checks a subagent's run and status but not its sandbox generation. The browser's view keys tool calls by id across the primary agent and every subagent (`packages/protocol/src/view.ts`), so a provider that repeated an id across conversations would fold two calls into one row; Anthropic's and OpenAI's ids are unique. The session object's `idx_event_primary_type` index adds one index row to every stored event without an `agentId`, and is built on each existing object's first wake after the deploy.

### B20. A bridge test that spawns a real child can fail under load

`runtime-host.test.ts`, "refuses arguments it does not understand", once got a null exit code instead of 64 while `pnpm check` ran beside other test runs, and passed three times alone. The child was probably killed by a signal before it exited. The test should wait for its own child and tell an exit from a signal.

### B21. A sandbox that refuses the erase's last stop is forgotten with its session

Before erasing, the session object stops by name once more each generation that failed after a create was sent, the newest three (`stopFailedGenerations` in `apps/web/worker/session/object/provisioning.ts`). If the provider refuses, the erase goes on, and the timeline note that named the sandbox is erased with the session; a `session.deletion` log line with result `failed_sandbox_not_stopped` is all that remains. An older failed generation past the three is not tried at all. A durable place for sandboxes OnCue could not stop, outside the session object, would let the owner be told after the session is gone.

### B22. The deletion job reads a session's attachment rows without a bound

`removeObjects` in `apps/web/worker/deletion/job.ts` bounds its `artifact_index` read, whose keys the prefix listing also finds, but reads every `message_attachment` row of the session in one statement, because attachments live under the workspace and are found only by row. The count is bounded by messages times the per-message attachment limit, so it is small today. Deleting attachments and their rows a page at a time would bound it properly.

### B23. Timing tests beyond B20 fail when the machine is busy

With several test runs at once (a load average above 20), these have each failed and then passed alone: `apps/web/src/features/home/sidebar-menu.test.tsx` (a timing assertion), the bridge's `verify-io` tests, and the session object's lifecycle, resume, and dispatch suites. Separately, the first Playwright project run against a dev server that has just started can spend its whole timeout on its first page load; the same project passes once the server has served a page. `pnpm check` stops at the first failure, so one of these hides the suites after it. On 2026-10-13, with four checkouts running tests at once, two more joined the list: the bridge's `git.test.ts` ("stops a grandchild at the time bound"), and `session-read-cost.test.ts` ("reads only the stops it runs when they succeed"), which counted eight stops where one alarm runs four. That test inserts its owed late stops and then calls `alarm()` itself, so a rearm still in flight from an earlier commit can arm the runtime's own alarm for the same rows, and both run them.

### B24. Port slot 15 is accepted and cannot serve

`ONCUE_PORT_SLOT=15` puts the controller on port 6697, which Node's `fetch` refuses as a blocked port, so the Worker cannot reach the controller double. `scripts/dev-ports.mjs` accepts the slot. It should refuse it, or skip the blocked ports.

### B25. A hung image build holds a controller worker until a restart

`prepareImage` builds on a thread pool (`services/sandbox-controller/prepare.py`). A build still running after 20 minutes is forgotten and the next request starts another, but a Python thread cannot be stopped, so the hung one keeps its worker until the controller restarts. Sixteen of them would stop every preparation.

### B26. The bridge's liveness check can cut a healthy link on a starved sandbox

After a first pong, two ticks with nothing heard end the link (`LIVENESS_SILENT_TICKS` in `services/bridge/src/protocol.ts`). On the hosted session of A37 the bridge dropped and redialled its link while the sandbox's one CPU was saturated by tests, before the kill. The reconnect is cheap and lost nothing, but the timer measures the bridge's own scheduling as well as the network.

### B27. The context meter's compaction rule and tool split are OpenCode's

"Until auto-compact" is shown only for OpenCode, from its 1.18.30 rule, and the breakdown's "OnCue's tools" row is the tools named `oncue_*` (`apps/web/src/features/session/context-meter.ts`, `apps/web/worker/broker/prompt-counts.ts`). Codex, Pi, and Claude Code compact by their own rules and name OnCue's tools differently, so their sessions will show no threshold and may file OnCue's tools under the harness's.

### B28. Local stacks on different port slots sign each other out

A browser keeps one cookie jar for `localhost` whatever the port, so `/dev/sign-in` on one slot replaces the `__session` cookie of every other slot's stack, which then answers `/api/me` with 401 and shows "Not signed in locally". Opening each stack on its own hostname (`http://oncue14.localhost:6573`) avoids it, because the dev sign-in and the Worker both key on the request's own origin; `pnpm dev*` still prints `localhost` URLs (`scripts/dev.mjs`).

### B29. The alarm replaces at the ceiling before it idle-stops a row that woke late

`planAlarm` (`apps/web/worker/session/lifecycle.ts`) weighs the ceiling before the idle stop, so a live attachment found past both starts a replacement sandbox when it would otherwise have been stopped for idleness. The image warm-up's recovery met this with a row whose ceiling was stored late, and now stores it one check ahead; the order itself is unchanged.

### B30. The permission, question, and approval gates do not check for an erase

A commit with no session row is refused (`host.erased` in `apps/web/worker/session/object/commit.ts`), but the three gates commit in their own transactions and do not consult it. It is reachable only when a bridge frame is mid-judgement across a whole stop and erase.

### B31. An adopted pull request's body can lose a concurrent edit

OnCue reads an adopted pull request's body and then patches it with its verification section (`apps/web/worker/github/pull-requests.ts`). An edit the person saves between the two calls is overwritten. GitHub offers no conditional update for a pull request body; narrowing the window, or re-reading and comparing before the patch, would reduce it.

### B32. A superseded model token stays valid at the broker until it expires

A run on another effort, model, or connection gets a fresh model grant in the same sandbox generation (`planDispatch` in `apps/web/worker/session/dispatch.ts`), and the relay keeps only the newest token. The broker checks a token's signature, generation, and connection (`readAuthorizedConnection` in `apps/web/worker/broker/connections.ts`), not whether it is the session's newest, so the earlier token would still be honoured for its remaining ten minutes, and through a refresh for up to 24 hours from its first issue, if something presented it. Nothing does: the token lives only in the relay's memory under the bridge's Unix user. This has been true of an effort change since effort levels shipped and is now true of a model change. Closing it means the broker comparing a token's model and connection with the session's current run (a column on `session_index`, or a grant counter in the token).

### B33. A `run.start` on the session's own model stores the browser's record unchecked, and is admitted while a run is open

The session object rebuilds a run's model record only when the start changes the model (record 15). For a start naming the latest run's connection and model, the stored record's `contextWindow`, `authenticationType`, and `effort` are the browser's (`planBody` in `apps/web/worker/session/commands.ts`); an effort the model does not offer is not refused there, only on `run.follow_up` (`effortAccepted` in `apps/web/worker/session/object/commit.ts`), and the Model Broker then refuses the run's requests. Separately, the object admits a client's `run.start` while the current run is still open (the catalog checks only the session's state); the bridge refuses it (`wrong_state`), leaving a queued run that never starts. Build the same-model record from the previous run's and the catalog, and refuse a start while a run is open.

### B34. A bridge test's cleanup can fail on a directory still being written

`services/bridge/src/agent-io.test.ts`, "stages a cut tool output as utf-8 and uploads it as text on its grant", failed once in `pnpm check` on 2026-10-13 with `ENOTEMPTY` from the `rmSync` in its `afterEach`, on a busy machine, and passed alone. Something the test started was still writing into its temporary directory when the cleanup ran. The cleanup should wait for what the test started, or retry (`rmSync` takes `maxRetries`).

### B35. Two Playwright chains run side by side and break each other

Every lane project that serves the controller double is meant to run alone, one after another, through `dependencies` (`apps/web/e2e/playwright.config.ts`). `branch-choice` names none, so it starts with the first project, and `controller-timing` and `delete-archive` follow it beside the main chain. A full `pnpm test:e2e` at two workers on 2026-10-13 ran `controller-timing` during the walkthrough: the walkthrough's sandbox stayed on "Starting a sandbox" while the double was in its image-building mode, and `controller-timing` counted the walkthrough's create as a second one. Both pass alone with `--no-deps`. Fix: make `branch-choice` depend on `subagents`.

### B36. A hosted deployment whose controller settings go missing resumes and stops existing sessions on the fake

The create route refuses a hosted deployment with no usable controller (`refuseHostedStandIn` in `apps/web/worker/routes/sessions.ts`), but the session object selects its own driver for a resume, a replacement, and the alarm's stops (`provisionGeneration` in `apps/web/worker/session/object/provisioning.ts`, `driverForGeneration` in `session/object/sandbox-lifecycle.ts`). If the controller origin or token is removed, or the origin is changed to plain HTTP, after sessions exist, a resume with a Modal credential provisions a fake generation, and a stop of a Modal generation is answered by the fake while the real sandbox keeps running until its own lifetime limit ends it. Fix: on a non-local Worker, fail the resume with a fixed category and refuse to hand a Modal generation to the fake, as `driverForGeneration` already does for a missing credential.

## C. Documentation debt

### C5. The full preview design is not in record 09

Record 09's "Previews" section (`docs/architecture/09-permissions-networking-and-previews.md`) states the rules at a high level (a separate authenticated origin, a cross-origin frame with a new-tab fallback, access checked per request and ended with the generation) and says previews are not built. The worked design (the code-for-cookie exchange, Modal connect tokens, the in-sandbox relay, the new test C probes) exists only on the preview spike's branch (GitHub #52, open) and in summary under the roadmap's PR-16. Move it into record 09 when #52 merges or PR-16 starts.

### C6. A migration comment names a migration that does not exist

The comment above `deletion_request` in `apps/web/migrations/0002_identity.sql` says the deletion receipt fields are "PR-14's 0008_operations.sql"; `0008` is `0008_development_secrets.sql` and the next free number is `0017`. The migration is applied to the hosted D1, so reword the comment when PR-14 adds its migration.

## D. Found during live runs

### D2. Two operator checks after PR-13 are still owed

Test C with `--secret` (`services/sandbox-controller/scripts/test_c_probe.py`) has not run on a hosted sandbox that was supplied a secret. And no record confirms that the GitHub App's callback and webhook URLs point at the hosted Worker again after the live sittings, so the hosted webhook arms (push, pull request) and a hosted install are unconfirmed.

### D3. The model catalog's live sitting has not run

The authorized sitting (Opus 5.5 at `low` and GPT-6 Luna at `low`, $1 each) has not run. The OpenAI Responses path has run live on GPT-6 Sol, but Luna and the Anthropic effort field on the wire have not been observed.

### D4. Local Wrangler state grows without bound

Nothing prunes `apps/web/.wrangler/state/v3`, which the lanes fill; it can reach tens of GB. Clear it on a quiet day, or have the lane setup prune old state.

### D11. `/tmp` in the sandbox has no sticky bit

A sandbox's `/tmp` is mode 777, not 1777 (the comment above `AGENT_TMP_DIR` in `services/sandbox-controller/images.py`), so any user in the container can remove or rename another's files there. The agent's tools use their own `TMPDIR`, but a program the bridge user runs, Git included, may still write there. Fix: set `/tmp` to 1777 in the entrypoint as root before anything starts, add a test C probe, and re-run test C.

### D12. Three checks-on-demand questions a review could not confirm

A tree change between runs (a formatter's output, a process left running) is covered by no run's checks, because the bridge compares only each run's own start and end; no code compares against the tree the last checks ran on. `startChecksBeforePublish` (`session/object/publish.ts`) reads the session before awaiting `decideAdmissionNow` and plans with that stale row, so a `run.start`, `policy.set`, or stop in the gap is untraced. And a sandbox that forges `run.completed` on a run that changed files gets its push cited against older checks, which the trust model accepts because a sandbox can already fake passing checks.

### D13. An unexpected controller failure on create fails the run with no detail

During a live sitting one create returned HTTP 500 with the controller's catch-all message ("The controller met a failure it does not recognise", `services/sandbox-controller/errors.py`). No sandbox was created, and the resumed run failed at provisioning. The controller should log the exception's type so the failure can be translated, and the Worker could retry a create that failed before any sandbox existed.

### D15. The ruleset-bypass probe has not run

Records 07 and 09 mark one point unverified live: that GitHub's rules endpoint reports a ruleset whose bypass list names the App. The probe adds a ruleset to the live-test repository, so it needs the owner's approval.

### D16. Three things seen once in live sittings, not reproduced

A `run.start` sent straight after Allow was refused with `wrong_state`. A publish showed "Push requested" and went no further when the run had changed no files. A hosted session on a repository that carries both `.claude/skills` and `.agents/skills` printed "duplicate skill name" warnings from OpenCode, although OpenCode is started with the repository's own configuration ignored. Each needs a test that reproduces it before it is worth a fix.

### D17. The merges of 2026-10-11 have had no live run or test C

GitHub #69, #72, and #75 and their review fixes were merged and deployed on the clean-machine check and the end-to-end suites against the doubles. Not run on the deployed stack: test C on the deployed image, a session that works directly on an existing branch, a cold image prepared through `prepareImage`, and a delete and an archive.

### D18. A model change has run only against the doubles

Changing a session's model (record 15) has run against the provider double and a real OpenCode 1.18.30 on a developer machine: in one sandbox across both providers, and on a new sandbox after an idle stop (the `model-switch` end-to-end project). It has not run against a real provider or in a Modal sandbox. Unobserved there: OpenCode carrying a conversation with one provider's reasoning and tool-call blocks to the other provider's API; the prompt cache's cost on the first call after a change; and the image's OpenCode starting with both providers declared. The bridge bundle changed, so test C is owed on an image built from it. Needs a sitting the owner names, with its models and caps.
