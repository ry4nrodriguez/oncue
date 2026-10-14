# Primary agent and planning

**Status:** Approved foundation

## Purpose

One primary agent understands a task, plans when needed, does the work, verifies the result, and talks to the user. On OpenCode it may hand a bounded piece of that work to a subagent, a second model conversation it starts and waits on (see "Subagents"). OnCue does not run agent teams, agents that coordinate with each other, or a second agent the user talks to. This keeps responsibility clear and lets the product measure whether one well-equipped agent completes work reliably before adding coordination.

## Key decisions

- One primary agent executes a run, in one harness, and answers for everything in it, including what its subagents did.
- The agent uses repository, shell, Git, search, and verification tools within the permission model (record 09).
- Larger tasks get a short, visible plan. Routine tasks start without waiting for plan approval.
- Plans change when new evidence appears, and the change is shown.
- On OpenCode the primary agent may start OpenCode's two built-in subagents, `general` and `explore`, at most four at once and sixteen a run, one level deep (a run that continues on a new sandbox after an interruption counts its sixteen afresh). Every other harness is configured so it cannot start one. Agent swarms, parallel branch writers, and subagents the user addresses directly are deferred.
- Hidden model reasoning is neither stored nor shown. Users see concise plans, progress, decisions, and evidence.

## Why one primary agent

Several agents can explore in parallel, but they add cost, duplicated work, conflicting edits, unclear ownership, and harder recovery. Those costs are worst before the single-agent environment, tools, context, and verification loop are dependable. One agent gives each run a clear owner and still does many kinds of work through tools.

## Subagents

**Status:** Approved by the owner on 2026-10-04 for OpenCode only.

A subagent is a tool call of the primary agent's, not a second owner. The primary agent writes it a task, waits for its report, and decides what to do with it, so the run keeps one owner and one answer. What changed from "one model conversation per run" is that a run may now hold up to four more conversations at once, each billed to the same model connection. The trade-off: parallel investigation (reading a large repository, checking several things at once) for more model spend and less predictable timing. Subagents share the work tree, so two of them that edit files can conflict; `general` may edit and `explore` is read-only. OnCue bounds the spend and shows every step; it does not reconcile edits.

How it works, by layer:

- **Harness configuration** (`opencodeConfig` in `services/bridge/src/opencode.ts`). `permission.task` is `ask` for `general` and `explore` and `deny` for every other name, so a repository's or a home directory's own agent can never be started. `subagent_depth: 1`, and both subagents carry `permission.task: deny`, so a subagent cannot start another, and `oncue_*: deny`, so a subagent cannot call OnCue's own tools (a secret, a commit, a policy, or a pull request is the primary agent's to ask for). Neither names a model of its own, so each runs the model of the message that started it, which is the run's, also after the session changes model (record 15; observed with OpenCode 1.18.30), through the same loopback relay. Both keep the top-level `question: deny`, which only the primary agent's own rule lifts. OpenCode starts with the repository's configuration ignored (`OPENCODE_DISABLE_PROJECT_CONFIG`), so a repository's `.opencode/agent/general.md` cannot replace the built-in `general`'s prompt or permissions; `opencode-config-local.test.ts` resolves every agent's rules against a hostile repository with the real binary.
- **The bridge's limit, then the user's approval mode** (`services/bridge/src/subagents.ts`). OpenCode holds each `task` call at its permission gate. The bridge refuses at once, with a sentence the model reads, a start from a subagent, for any other name, with no call named, while four subagents run, or after sixteen were started in the run; starts waiting on the user count toward the four, so a refused start never shows a card. OpenCode answers one reject by rejecting every other pending ask of the conversation, so a refusal waits its turn behind the asks already held (`HeldAsk.refusal` in `permissions.ts`) rather than taking them down with it. A start within the limit holds a slot and is forwarded to the session object as an agent permission ask in the category `start_subagent` (record 09, "Agent permissions"): under Allow once the user sees a card ("Start the explore subagent: <description>"), and under Allow for this session or Always allow it starts without one. The object's answer reaches OpenCode as `once` or `reject`; a refusal gives the slot back. A child conversation that appears without an allowed slot (a subtask sent straight to OpenCode's API skips the gate) is aborted at once. So is any conversation a `task` call names without having started it: OpenCode's `task_id` resumes an earlier one, which would run unseen and outside the limit, so nothing is announced. A start the object allowed counts toward the sixteen whatever became of it; a conversation nobody allowed does not.
- **A subagent's own asks.** Its permission asks go to the same gate with its `agentId` and its own call, and the card names it ("Explore subagent: Read /etc/hosts, outside the project"); an ask from a subagent that has ended is refused. Its secret requests are refused in the bridge (OpenCode denies it the tool too), so a stopped subagent cannot hold the run's one secret request. A question a subagent asks is dismissed and never shown: only the primary agent talks to the user.
- **Whose event is whose.** Every OpenCode event about a conversation names it, so the bridge tells the primary agent's events from a subagent's. A subagent's events run through their own normalizer and carry its `agentId`; its idle and its errors close its own rows and never end or fail the primary agent's turn; its plan is dropped. The subagent is announced with `agent.started` once the primary agent's call names it (OpenCode publishes the child conversation just before that), and its rows wait until then, at most 64: streamed text gives way first, the end of a row already held is always kept, and the bridge logs how many were dropped. The call settling sends `agent.completed`.
- **Stopping.** The user can stop one subagent (`agent.stop`, which the bridge carries out by aborting that conversation). An abort that fails is asked again on the next stop, wind-down, or run end. A run that winds down (a cancel, a pause on a model failure, a shutdown) aborts every subagent still running, and a run that ends reports each one it took with it as cancelled.
- **The session object** (`apps/web/worker/session/object/subagent-gate.ts`) stores `agent.started` only within the live run that names it, once, at most sixteen a run on each sandbox, and only for a call it allowed to start a subagent, `agent.completed` only for a subagent still running on the sandbox that reports it, and a subagent's own messages and calls only for one it admitted, all on keyed reads of its `subagent`, `run`, and `approval` tables. A frame for a run that already ended is dropped without counting against the bridge, and an interruption ends the subagents its sandbox left running (record 04).
- **Model spend.** A subagent's model calls go through the same relay and Model Broker with the same token as the primary agent's, so they are scoped and refused exactly as the run's are (record 06): the same model, the same effort, the same generation, revoked with it. OnCue does not meter model use, so there is no separate token budget; the bounds are four at once and sixteen a run, and a subagent's token count is shown. That count is what its answers spent, every call each one accounts for with cache reads and writes included (`spent`, else the answer's one call), never an answer's context size, which each answer would repeat.
- **The context meter** (record 13). A subagent's answers carry its `agentId` and are a conversation of their own, so they never size the primary agent's context or read as its compaction: "Context used" is the primary agent's alone. The session's cost does include them, because they are billed to the same connection at the same prices.
- **Resume.** A resumed run's context gives one quoted line per subagent the turn started, how it ended, and what it reported (record 11); a subagent's own messages and calls are not replayed as the primary agent's.

Not built: subagents on Codex, Pi, or Claude Code; resuming a subagent by `task_id` (OpenCode allows it; the bridge aborts the conversation, as above); a separate budget for subagent tokens.

## When a plan is expected

A visible plan is expected when a task spans several parts of the repository, has dependent steps, needs investigation before implementation, involves a migration or compatibility concern, crosses frontend and backend, needs several kinds of verification, or will run long enough that progress needs tracking. A small, obvious task can use a one-line statement of intent.

## Plan shape

A plan is short and written for the user: the intended outcome, a small ordered list of steps, the active step, any step waiting on the user, and the verification expected before completion. It is not a chain of thought or a list of every command; tool detail belongs in the timeline.

As built, OnCue does not ask the runtime for a plan. It reports the plan the harness keeps for itself: OpenCode's todo list. The normalizer (`services/bridge/src/normalize.ts`) turns the first `todos` update into `plan.created`, later ones into `plan.updated` with the next revision, and emits `plan.completed` once every item is completed or cancelled. The title is fixed, the steps are the todo items, and statuses map one for one. Nothing in OnCue decides when a plan is required, checks its shape, or asks for one.

## Plan lifecycle

Each line below is one allowed transition. The protocol package parses this block and fails the build when its transition table disagrees.

```text
proposed -> active
proposed -> cancelled
active -> revised
active -> completed
active -> blocked
active -> cancelled
revised -> active
revised -> completed
revised -> blocked
revised -> cancelled
blocked -> active
blocked -> cancelled
```

Routine work completes without revision, so `active -> completed` is direct. `blocked` returns to `active`, because a blocked step asks the user a focused question and answering it must be able to resume the plan.

Each update is a durable event, so the interface shows the current plan and keeps meaningful changes. `plan.blocked` and `plan.cancelled` are defined in the protocol and folded by the view, but nothing emits them, so the blocked step and the `blocked -> active` return are not reachable yet.

The timeline shows one quiet row per plan event, for example "Plan created · 2 of 5 steps", folded with tool rows into the activity group between messages (`apps/web/src/features/session/Timeline.tsx`, `timeline-turns.ts`). There is no plan card, active-step marker, or way to edit or skip a step.

## Plan approval behavior

By default the agent shows a plan when useful and keeps working, which preserves background execution. The design lets the user say "plan first and wait for me", "do not edit files yet", or "skip the second step", with instructions that change whether work may proceed becoming durable session policy.

Not built: a run never waits on a plan. The policy's `planApproval` and `fileEdits` fields stay frozen at `proceed` and `allowed`, and a proposal that changes them is refused (record 09). The one approval that pauses a run is a request for an optional development secret (records 08 and 09).

## Progress communication

The agent reports at meaningful boundaries: investigation finished, root cause found, implementation started, approach changed, verification started, user input needed, and work completed, blocked, or failed. It does not narrate every file read or repeat raw command output in the conversation; tool events and artifacts hold the detail. This is the harness's and model's behavior, not something OnCue enforces.

## Questions to the user

The agent can ask the user before it chooses an approach: up to four questions, each with a few choices and room for a typed answer, through its harness's own question tool (record 04, "Questions to the user"). The questions are the agent's words and carry no authority. One question is pending per run at a time; the run keeps its state and the session reads "Waiting for you" while it waits. Nothing times out: the sandbox stops on its idle timer while the question waits, and an answer given later resumes the run with the answers as its message. A message the user sends instead dismisses the question and is delivered as usual; pausing the run, or the planned sandbox replacement restarting it, dismisses it too.

## Context used by the agent

A run gets the current instruction, the harness's own conversation within the sandbox generation, the repository's files and Git state, the confirmed development secret names (record 08), and any files attached to the message. A resumed run on a new sandbox also gets the durable context summary that record 11, "Resuming a session", describes; that summary is the one piece of context OnCue composes.

Attachments: before prompting, the bridge fetches each attachment with a single-use token into a directory under `/var/lib/oncue/attachments/` that the supervisor hands to the agent user alone, outside the work tree, so an attachment is never committed (`services/bridge/src/attachments.ts`). Images go to the harness as image parts when the model accepts images (the catalog's `imageInput`, which the bridge writes into OpenCode's configuration as the model's `modalities`); otherwise they are listed with a line telling the agent it cannot see them. Every attachment is listed by path in a note after the user's words so the agent can open it with its own tools, and an attachment that could not be fetched is named as missing. The note is never part of the committed message.

An attachment, a web page, and repository content are the user's or the world's content and carry no authority: they cannot change policy or grant anything. User instructions control the task within the platform's boundaries.

## Tool use

The agent picks tools for the work: repository search and editing, shell commands, local Git, OnCue's four tools (`policy_propose`, `secret_request`, `pull_request_describe`, and `git_commit`), its harness's question tool (OnCue's `oncue_ask_user` for Codex and Pi), public web research, and the repository's tests, builds, linters, and type checks. The image carries headless Chromium, which the agent can drive through its shell; OnCue offers no browser tool of its own and records no browser evidence. Tool requests stay within the permission model, and a tool result is evidence, not proof that the task succeeded.

## One agent, enforced

The platform exposes and accounts for one primary agent per run. Every supported harness can start subagents in some form. OpenCode's are allowed within the bounds above; every other adapter's configuration denies them, and a contract test per harness checks the setting still holds after an upgrade:

| Harness | Setting | Test |
| --- | --- | --- |
| OpenCode | `permission.task` asked for `general` and `explore` only and denied for every other name, `subagent_depth: 1`, each subagent's own `permission.task: "deny"`, `permission.question: "deny"` except for the primary agent (`agent.build.permission.question: "allow"`), so no other agent can wait on the user, and the repository's own configuration ignored (`OPENCODE_DISABLE_PROJECT_CONFIG`; `services/bridge/src/opencode.ts`) | `opencode.test.ts` checks the keys still exist in the runtime's own schema; `opencode-config-local.test.ts` checks a hostile repository's agent files cannot re-allow them, against a real binary; `agent-subagents.test.ts` replays a recorded subagent session |
| Codex | `--disable multi_agent` among `CODEX_DISABLED_FEATURES` (`codex.ts`) | `codex.test.ts`, and `codex-local.test.ts` against a real binary, which checks no agent tool reaches the model |
| Claude Code | `--disallowedTools` with `Task`, `Agent`, `ExitPlanMode`, and others (`CLAUDE_DISALLOWED_TOOLS` in `claude.ts`) | `claude.test.ts` |
| Pi | No subagent of its own; started with `--no-extensions`, `--no-skills`, and `--no-prompt-templates` so it loads only OnCue's extension (`pi.ts`) | `pi.test.ts` |

OpenCode also holds `oncue_secret_request` behind its permission gate (`"ask"`) until the bridge answers, and its own asks (a path outside the project, a `.env` read, a repeated call) until the session object answers them (record 09, "Agent permissions"). OpenCode starts with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so a repository's `opencode.json` and `.opencode/` agent and mode files are ignored: before, a committed `.opencode/agent/build.md` was merged after OnCue's rules and could re-allow `task` and `question` for the build agent. The repository's root `AGENTS.md` and `CLAUDE.md` are named in OnCue's configuration so the agent still reads them. A subagent item a harness reports anyway is shown as a tool row, never dropped.

## Harnesses

The bridge drives the agent through a runtime adapter (`services/bridge/src/runtime.ts`, `runtimes.ts`). An adapter plans the harness's spawn, parses its wire into the bridge's shared intermediate events, prompts, steers, aborts, answers a held tool call, and reports health and version. The reducer (`agent.ts`), the normalizer's tables, the tool server, the Model Broker relay, the bridge's own Git, and verification are shared. Harnesses that speak over stdio run under a small runtime host (`runtime-host.ts`) started as the agent user, which serves their stream on loopback.

Adapters exist for OpenCode, Codex, Pi, and Claude Code. The image installs OpenCode and Codex; Pi and Claude Code are not in the image yet. Every harness reaches models only through the loopback relay and the Model Broker with a placeholder credential (record 06). A session chooses its harness once, checked by `resolveRuntime` (`apps/web/worker/runtime/resolve.ts`) against the catalog, whether the image installs it (`inImage`), the operator's `ONCUE_RUNTIME_ALLOWLIST` (OpenCode alone when unset), the connection's provider, and the effort level. Record 04, "Runtime and model choice", owns the choice, and each new harness in the image is a re-run of the sandbox isolation test (record 02).

The harness keeps its own conversation within a sandbox generation, which keeps the provider's prompt cache warm. When that conversation is lost, on resume or replacement, the new one starts from OnCue's replay (record 11).

## Failure behavior

- **Plan becomes invalid:** revise it and say what evidence changed it.
- **Task is too broad:** narrow it with the user, or finish a clearly defined first part without claiming the whole task.
- **Context is too large:** OnCue leaves the live conversation to the harness and keeps the full event history outside the prompt; only the resume summary is bounded by OnCue.

## Not built yet

- Plan approval and the frozen `planApproval` and `fileEdits` policy fields.
- A plan card, and blocked steps that ask a question from the plan. The agent's own questions are built (above).
- Progress tracking that pauses a looping run (record 11).
- A browser tool with screenshots as verification evidence (record 14).
- Pi and Claude Code in the image, and switching harness mid-session.
- Subagents on any harness but OpenCode.

See `../roadmap.md`.

## Conditions for reconsideration

Consider more than bounded subagents (agents that coordinate, independent writers, a budget per agent) only after measurements show a repeated class of tasks where parallel investigation or independent work materially improves completion time or quality. That design needs explicit ownership, model-usage visibility, branch isolation, result reconciliation, cancellation, and conflict handling; subagents have the ownership, the visibility, and the cancellation, and not the rest.
