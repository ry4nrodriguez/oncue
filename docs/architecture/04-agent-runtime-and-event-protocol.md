# Agent runtime and event protocol

**Status:** Approved foundation

## Purpose

A coding harness runs the agent loop inside the sandbox. The platform has to observe that work, keep its important history, enforce approvals, and stay free to change harnesses. A bridge in the sandbox translates each harness's own activity into one typed protocol (`packages/protocol/src/`) that the session Durable Object validates, orders, stores, and broadcasts.

The protocol is OnCue's own, not a universal agent standard. It carries what the product needs and a bounded runtime-specific payload for debugging.

## Components

### The harness

The harness (OpenCode by default) runs the model conversation, chooses and invokes coding tools, reads and edits files, and runs commands with whatever authority the sandbox gives the agent's Unix user. It reaches the model only through the Model Broker's loopback relay (record 06). It owns no identity, permission, durable storage, or policy decision.

One run has one primary agent (record 12). OpenCode may start its two built-in subagents, each a child conversation the bridge tracks and reports under the "Subagents" family below; Codex runs with `agents.enabled=false` and Claude Code disallows its subagent tools.

### The sandbox bridge

The bridge (`services/bridge/src/`) runs as its own Unix user. It starts the harness through the root supervisor, holds the session's credentials, translates commands into harness requests and harness output into protocol events, sends heartbeats, redacts known secret values, uploads large output as artifacts, holds a tool call while an approval is open, and reports exits and boot failures. It makes no product decisions.

Its behaviour is one pure reducer, `step` in `agent.ts`, over a closed set of inputs (a frame from the object, a harness event, a process exit, a relay failure, an effect's result); the interpreter in `agent-io.ts` performs the effects it returns. Nothing that decides awaits, so concurrent inputs apply one at a time in arrival order.

Every OpenCode event about a conversation names it, so the bridge tells the primary agent's events from a subagent's (`subagents.ts`): a subagent's go through its own normalizer and carry its `agentId`, and only the primary agent's idle or error moves the run. An event from a conversation that is neither is dropped.

`normalize.ts` maps harness events to protocol drafts with two tables. `EVENT_TABLE` drops known kinds that mean nothing to the protocol and all reasoning parts, and turns an unknown kind into ephemeral `tool.output` under one synthetic "Unmapped runtime events" call per run. `TOOL_PART_TRANSITIONS` is total over (what the timeline was told, what the harness says now), so a result never lands without its `tool.requested` and `tool.started`. Every `message.started` gets a `message.completed`, synthesised if the turn ends without one.

`message.completed` carries the harness's token report as `usage` (`tokenUsage` in `packages/protocol/src/schema.ts`). `usedTokens` is the conversation's size after the message: the last model call's whole input (uncached, read from the prompt cache, and written to it) plus what that call wrote, reasoning included (`../decisions.md`). `inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens`, and `reasoningTokens` split it, each kind counted once; `spent` sums every call the message accounts for and is left out when that is the last call alone; `maxTokens` is the run's model's window from the catalog. `prompt` carries the Model Broker's exact counts of the last call's system prompt, the harness's tools, and OnCue's tools (record 06), and `compactsAtTokens` the size at which the harness compacts on its own where its rule was read from its source: for OpenCode 1.18.30, the window less `min(limit.output, 32000)`, the output it reserves (`SessionCompaction.isOverflow`; OnCue's config sets no `compaction` and no `limit.input`, and the supervisor never passes `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`). The broker's counts reach the bridge as the `x-oncue-prompt-tokens` header on its answer to an agent's call, keyed by the first 16 hex characters of the prompt's hash, with either the three counts or a status (`pending` or `unavailable`). The relay reads and drops it (`readPromptCounts` in `relay.ts`) and reports every successful call, header or not, to the reducer, which hands it to the normalizer as `prompt_counts`. The normalizer remembers counts by key for the run (at most 16 prompts), so a later `pending` for a prompt it has seen counted is still exact; the next `message.completed` carries the call's counts as `prompt`, or its status as `promptStatus`, and then the reading is cleared, so a message whose call had no header (one without tools) carries neither. Counts that would not fit inside the size are left out. All but the first two are optional, and an event written before the split has only `inputTokens` and `outputTokens`, with `usedTokens` as their sum. Each parser counts the kinds once: OpenCode 1.18.30 already does (one assistant message per call, `tokens.total` the five summed), Claude Code and Pi count the cache apart from input, and Codex counts the OpenAI way, so its parser takes cached and cache-write tokens out of input and reasoning out of output. Codex reports a call's tokens (`thread/tokenUsage/updated`) after its message, so the normalizer holds that `message.completed` until the report, the end of the turn, or the start of any other item (a tool, reasoning, or a second message), whichever comes first; a message released early carries no tokens and leaves the report to the next message without its own, so a model call that ended in a tool call is spent by the next message. A report with every count zero, which OpenCode puts on a message aborted before its call answered, is no reading and leaves `usage` null. Nothing writes the lifecycle events' `usage` yet.

### Runtime adapters

Each harness sits behind a runtime adapter (`runtime.ts`). Its pure half, `RuntimePlan` (pinned version, providers, port, a `profile` of facts shared code branches on, `planSpawn`, `toolCategory`, and `presentToolName`), is what the reducer calls. One profile fact is `modelSwitch`: `per_prompt` for a harness whose running process takes another model on its next prompt (OpenCode), `none` for one that keeps the model it started on. `promptableModels` gives the models a process was started for. Its I/O half, `RuntimeClient` (`health`, `prompt`, `abort`, `replyHeld`, `replyQuestion`, OpenCode's `pendingQuestions`, and one `subscribe` stream), is what the interpreter calls. Each client's parser produces `RuntimeEvent`, the bridge's one intermediate vocabulary, so nothing above the adapter reads a harness's own shapes. `runtimes.ts` is the registry of adapters; `RUNTIME_CATALOG` in `packages/protocol/src/runtimes.ts` is the list the bridge, the object, and the browser share.

Stdio harnesses run under the runtime host (`runtime-host.ts`): the supervisor starts it as the agent user, it starts the harness with piped stdio, and it serves that stdio on one loopback port to one client at a time. It holds no credential.

OnCue's four agent tools (`policy_propose`, `pull_request_describe`, `git_commit`, and `secret_request`) are served by the bridge's loopback tool server (`tool-server.ts`) and reach each harness through its own channel.

| Harness | Pinned | Providers | Control | Tools reach it by | Evidence |
|---|---|---|---|---|---|
| OpenCode (`opencode.ts`) | 1.18.30 | Anthropic, OpenAI | HTTP on loopback | MCP from the tool server; OpenCode's permission gate holds `secret_request` and its own asks (record 09, "Agent permissions") | Normalizer built against a recorded session; runs in every live sandbox |
| Codex (`codex.ts`, `codex-client.ts`, `codex-wire.ts`) | 0.157.1 | OpenAI (Responses API only) | JSON-RPC to the app-server under the runtime host | Dynamic tools answered by the bridge, which holds `secret_request` itself | Parser built from Codex's generated bindings and a recording of the macOS build against a scripted model; never run against a real model or in a Modal sandbox |
| Pi (`pi.ts`, `pi-client.ts`, `pi-wire.ts`, `pi-extension.ts`) | 0.87.1 | Anthropic, OpenAI | JSON lines to RPC mode under the runtime host | OnCue's Pi extension registers the relay as the provider, forwards the tools, and holds `secret_request` through Pi's extension UI protocol | Built from Pi's documentation; has run against no Pi |
| Claude Code (`claude.ts`, `claude-client.ts`, `claude-wire.ts`) | 2.1.283 | Anthropic | stream-json with the Agent SDK's control protocol (`initialize`, `interrupt`, `set_model`), without the SDK | MCP from the tool server; every `can_use_tool` prompt comes to the bridge, which holds `secret_request` and forwards the rest as permission asks | Built from the Agent SDK's type declarations; has run against no Claude Code |

Whatever the harness, a held call reaches the reducer as the same permission event: OnCue's secret tool goes to `secrets.ts`, and every other ask to `permissions.ts`, after the adapter's `classifyAsk` (`ask-category.ts`) has put it in one of record 09's categories. A question for the user reaches it as the same `question_asked` event, so `questions.ts` is shared (see "Questions to the user"). An interrupted turn reads like OpenCode's abort. OpenCode is started with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so a repository's `opencode.json` and `.opencode/` agents, modes, plugins, and commands are ignored and cannot loosen OnCue's permission rules; its root `AGENTS.md` and `CLAUDE.md` are named in OnCue's own configuration instead. Codex offers its tools through its "code mode" `exec` tool rather than as top-level tools. Pi's messages carry no ids, so its mapper numbers them.

The sandbox image (`services/sandbox-controller/images.py`) installs OpenCode and Codex. It does not install Pi or Claude Code (`PI_BINARY` and `CLAUDE_BINARY` in `supervisor-protocol.ts` name paths no image fills). Each catalog entry's `inImage` says whether the image installs that harness, and `test_images.py` fails when it disagrees with the image's layers; `resolveRuntime` refuses a harness without it even when `ONCUE_RUNTIME_ALLOWLIST` names it, and the browser does not list it. Claude Code support is built but disabled and not installed in the image. We have not yet confirmed it fits Anthropic's terms for third-party products ([consumer terms](https://www.anthropic.com/legal/consumer-terms), [commercial terms](https://www.anthropic.com/legal/commercial-terms)). See `../roadmap.md`.

### Session Durable Object

The object validates, orders, stores, and broadcasts events. It decides whether a command is valid for the session's state and whether a decision can release a waiting action. It judges every sandbox claim against its own rows (records 01 and 14).

## Choosing the harness

A session runs one harness, chosen at creation and never changed. `resolveRuntime` (`apps/web/worker/runtime/resolve.ts`) accepts a harness only when it is in `RUNTIME_CATALOG`, the image installs it (`inImage`), the operator's `ONCUE_RUNTIME_ALLOWLIST` names it (OpenCode alone when unset, in every environment), it can drive the model's provider through the broker, and it can send the run's effort. It refuses an incompatible pair and never substitutes another.

The choice is stored in `session_index.runtime` (migration `0016_session_runtime.sql`) and the object's `session_runtime` row, recorded on every `run.queued`, and named on every model grant. The object resolves it again on every `run.start`, so an allowlist change reaches the next run; a refusal is `command.rejected` with reason `unsupported`. The bridge refuses a grant naming a harness it lacks (`unsupported`) or a different one from the one it runs (`wrong_state`). The grant's model is `{ provider, modelId }`; the object also sends OpenCode's `providerID` and `modelID` for older bridges. The grant also lists every catalog model with its limits (`catalog`), which a `per_prompt` harness is configured for at start. The harness never changes, but the model may between runs (record 15): a later grant naming another model replaces the one held when no run is working and the started harness was configured for it, and is refused otherwise (`wrong_state` while a run works, `unsupported` for a model the process was not started for). A `run.start` whose record names another model than the one held is refused (`wrong_state`).

## How a run moves through the bridge

- `runtime.connected` carries the bridge version and names the runtime `none`, because the bridge connects before any harness exists. Its `capabilities` are the bridge's own; `model_switch` says the bridge configures a harness for the grant's listed models and refuses a grant its harness cannot honour, and the object changes model in a live sandbox only for a bridge that names it. `runtime.ready` follows only after the harness's health check answers, and carries the name and version the harness reported.
- `run.started` is sent when the harness has accepted the prompt, a different fact from the bridge's acknowledgement of the command. The object never sends `run.start` before it has committed `runtime.ready` for the generation.
- A todo update becomes `plan.created`, `plan.updated`, or `plan.completed`.
- When the harness goes idle, the run is not over. In a repository the bridge measures the tree with its own Git. A turn that changed no files, or any run with no repository, ends `run.completed` ("Done") with no checks. Otherwise the run verifies the snapshot it measured (record 14): the bridge runs the resolved checks through the supervisor as the agent user and ends the run `run.verified`, `run.failed` at stage `verification`, or `run.completed_with_warnings`, each with a summary. A changed run in a repository with no declared checks ends `run.completed_with_warnings`.
- A checks-only run (`run.start` with `checksOnly`) prompts no one: the bridge emits `run.started`, measures the tree, and verifies.
- A cancel, checkpoint, or shutdown during verification signals the running check, keeps the records already committed, and adds no terminal event of the bridge's own.

## Event envelope

```json
{
  "eventId": "unique-event-id",
  "sessionId": "session-id",
  "runId": "run-id",
  "sandboxGeneration": 3,
  "runtimeSequence": 42,
  "type": "tool.completed",
  "occurredAt": "2026-09-01T12:00:00.000Z",
  "protocolVersion": 1,
  "payload": {}
}
```

`eventId` makes redelivery safe. `sandboxGeneration` rejects events from a replaced sandbox. `runtimeSequence` detects gaps and duplicates from the sandbox and is null on events the control plane mints. `type` selects the payload schema. `occurredAt` is the producer's clock. After validation the object adds `sessionSequence` and `committedAt`; clients order by session sequence.

Each event type declares a scope (`run` or `session`), an origin (`sandbox`, `control`, or `either`), and a durability (`packages/protocol/src/define.ts`). Only `message.delta`, `tool.output`, and `runtime.heartbeat` are ephemeral: the object redacts and broadcasts them but does not store them.

## Initial event families

### Lifecycle

- `runtime.connected`
- `runtime.ready`
- `runtime.heartbeat`
- `run.queued`
- `run.started`
- `run.paused`
- `run.interrupted`
- `run.verified`
- `run.completed_with_warnings`
- `run.completed`
- `run.blocked`
- `run.failed`
- `run.cancelled`
- `runtime.disconnected`

`run.completed_with_warnings` comes from either side: the bridge ends a run with it, and the object commits it in place of a `run.verified` its check records do not support (record 14). The refused `run.verified` is never stored, and after three refusals on one bridge socket (`MAX_OUTCOME_REFUSALS`) the next closes the socket with 4001. The bridge's liveness signal is a `bridge.heartbeat` frame every 15 seconds; nothing emits `runtime.heartbeat` or `run.blocked` yet. With each heartbeat the bridge sends a WebSocket ping, which Cloudflare's runtime answers without waking the object; once a pong has come back, two heartbeat intervals with nothing heard from the object mean the link is half-open, and the bridge drops it and reconnects (see "Failure behavior"). A link with no pong four intervals after its welcome says so once in the sandbox's output, since such a link is never timed out; whether the hosted edge answers pings is unverified.

### Messages and reasoning summaries

- `message.started`
- `message.delta`
- `message.completed`
- `status.updated`

Raw model reasoning is never stored or shown. Nothing emits `status.updated` yet.

### Plans

- `plan.created`
- `plan.updated`
- `plan.completed`
- `plan.blocked`
- `plan.cancelled`

Plan events carry a user-facing outcome, ordered steps, the active step, and status. Nothing emits `plan.blocked` or `plan.cancelled` yet.

### Tools

- `tool.requested`
- `tool.started`
- `tool.output`
- `tool.completed`
- `tool.failed`

Tool events carry a category, a display name, timing, result status, and artifact references. Output cut inline is uploaded as a `tool_output` artifact.

### Files and repository state

- `file.changed`
- `repository.status`
- `repository.checkpointed`
- `diff.updated`

`diff.updated` has a `scope`: `turn` is what one run changed, measured from a snapshot taken when the run started; `session` is everything since the session's recorded base. It may name a `tree` artifact listing every path at its head (record 13). Both events come from the bridge's own Git (record 07), never from the harness's report. They are sent:

- **At run start.** Before the prompt reaches the harness, the bridge snapshots the tree as the turn's base and sends `repository.status` after `run.started`. It is sent on every run in a repository, even when Git could not measure, because it also tells the object the clone's Git grant has done its job; then it names the clone's head with zero counts.
- **At run end.** Before any verification frame: `repository.status` for the end snapshot, `diff.updated` scope `turn` (left out when nothing changed), and `diff.updated` scope `session`.
- **At a checkpoint.** A checkpoint charged to a run sends `diff.updated` scope `session` at the checkpoint's head before `repository.checkpointed`, unless it matches the last one sent.
- **During a run.** The harness's own diff report only asks for a rebuild. The bridge rebuilds at most once every 15 seconds (`DIFF_REBUILD_INTERVAL_MS`), never two at once, and sends only a `session` diff, and nothing when it matches the last.

`repository.status` counts against the recorded base: `ahead` is commits from the base to the snapshot, `behind` is always 0 because the bridge never fetches after the clone, `dirty` says the tree differs from the last pushed head, and `untrackedFileCount` counts paths the last pushed head lacks.

### Git and pull requests

- `git.committed`
- `git.push.requested`
- `git.push.completed`
- `git.push.failed`
- `git.push.withheld`
- `pull_request.described`
- `pull_request.created`
- `pull_request.updated`
- `pull_request.state_changed`

Git events record the commit, parent, author type, branch, and the policy rule that allowed the operation. Pull-request events record the number, state, and verification-section version.

`pull_request.described` comes from the agent's `pull_request_describe` tool: an optional title, body, and branch name, with no authority. The object admits it only during the run it names while that run is live (running, waiting for approval, or paused), at most ten a run (`MAX_DESCRIPTIONS_PER_RUN`), and keeps the latest value of each field.

`git.committed` from the sandbox is either a publish's own commit or an agent commit made through `git_commit` (record 07, "Commits"). The object stores an agent commit only while its run is live and at most 50 a run (`MAX_COMMITS_PER_RUN`), and tells a publish's commit apart by the publish it has open, never by the frame's own `policy.rule`.

### Policy and commands

- `policy.proposed`
- `policy.updated`
- `policy.declined`
- `command.acknowledged`
- `command.rejected`
- `message.queued`
- `sandbox.keepalive.updated`

Policy events record the policy before and after, the triggering message, who proposed it, its direction, and how it was confirmed. Command events give every command identifier a durable answer.

### Sandbox lifecycle

- `sandbox.provisioning`
- `sandbox.attached`
- `sandbox.idle`
- `sandbox.checkpointed`
- `sandbox.checkpoint_failed`
- `sandbox.output`
- `sandbox.stopped`
- `sandbox.replaced`
- `sandbox.credentials_revoked`

These carry the generation. `sandbox.checkpoint_failed` names a fixed category (`add_failed`, `commit_failed`, `timed_out`, and others), never Git's text, which could hold a path the agent chose; a stop waiting on that checkpoint moves on at once rather than waiting out its 90 seconds. `sandbox.credentials_revoked` records the stop's revoke step: each of the `model`, `git`, `push`, and `upload` grants is `revoked`, `not_held`, or `failed`. `sandbox.output` relays what the sandbox printed before the bridge could report, plus the control plane's notes on provider calls; it is untrusted text and never drives a row's state.

### Pull-request feedback

- `review.imported`
- `review.updated`
- `review.selected`
- `review.addressed`
- `review.dismissed`

Review events are defined for record 16; nothing emits them yet.

### Verification

- `verification.started`
- `verification.result`
- `verification.completed`

`verification.started` says why the check applies (record 14). A result names the check, command, outcome, duration, and evidence. Outcomes are `passed`, `failed`, `skipped`, and `inconclusive`.

### Approvals

- `approval.requested`
- `approval.resolved`
- `approval.expired`
- `approval.mode_changed`
- `secrets.disclosed`
- `secrets.supplied`

`secrets.disclosed` records what a launch disclosed (record 08): the commit the project file was read at and the names supplied, withheld, and missing. `secrets.supplied` records that the bridge answered a secret grant: the names, the approval it answered (null for a launch's selection), and `delivered`, true only when the supervisor wrote every file. An approval card reads "Supplied" from this event, never from `approval.resolved`. Neither event has a field a value could go in.

`approval.requested` may carry `toolCategory`, the kind of tool behind a harness permission ask, which picks the card's verb, and `agentId`, the subagent whose call asked (record 12); the object keeps `agentId` only for a subagent its `subagent` table holds running, and absent means the primary agent. `approval.resolved` may carry `scope` (`once`, `session`, or `always`: what the answer covers) and `automatic` (a saved choice answered, not a click); both are absent on older events and on secrets. `approval.mode_changed` records the composer's approval menu: `ask`, `session`, or `always` (record 09).

### Questions

- `question.asked`
- `question.answered`
- `question.dismissed`

`question.asked` is the agent asking the user up to four questions through its harness's own question tool (see "Questions to the user"): each a header, the question, up to six choices with a description, whether several may be chosen, and whether the user may type an answer of their own. The text is the agent's and carries no authority. `question.answered` carries one list of answers per question, in order (the chosen labels and any typed text; empty is a skipped question), and `question.dismissed` a reason: `user`, `message_sent`, `run_paused` (the user paused the run), `run_ended`, or `sandbox_replaced` (the planned replacement restarted the run). Both are the control plane's.

### Artifacts

- `artifact.uploading`
- `artifact.created`
- `artifact.failed`

`artifact.created` refers to durable metadata, never to a sandbox path.

### Subagents

- `agent.started`
- `agent.completed`

A subagent is a second model conversation the primary agent starts through its harness, allowed for OpenCode only (record 12, "Subagents"). `agent.started` names the subagent (`agentId`, OpenCode's child session id), the primary agent's call that started it (`parentToolCallId`), which built-in subagent it is (`general` or `explore`), the description, the prompt cut to 4 KiB with `promptTruncated`, and the model. Every message and tool event the subagent produces carries the same `agentId`, an optional field absent on the primary agent's events and on every older stored event, so the browser keeps them off the session's timeline: the call that started the subagent is one row there, and the subagent's own work opens in the side panel's Agents view (record 13). `agent.completed` gives the status (`completed`, `failed`, or `cancelled`), its token count, tool calls, and duration, and what it reported back cut to 4 KiB. The object stores `agent.started` only within the live run that names it, once per `agentId`, at most sixteen a run on one sandbox generation (`MAX_AGENTS_PER_RUN`; the bridge counts from zero in each sandbox), and only when its `parentToolCallId` is a call the object itself allowed to start a subagent (an approved `start_subagent` ask of that run on that generation, which no other subagent has taken; past the run's 200 recorded asks a saved choice leaves no row, and the object does not refuse), `agent.completed` only for a subagent its `subagent` table holds as running in that run on that generation, which may be after its run ended, and a message or tool event that carries an `agentId` only for a subagent it admitted in that run on that generation. These judgements read the `subagent`, `run`, and `approval` tables by key or count by run, never the log. A frame the rows do not support is not stored and counts against the socket with the other refused claims, unless its run has already ended: a cancel commits the run's end before the bridge hears of it, so what an honest bridge sent meanwhile is dropped uncounted. `agent.completed` comes from either side: when a run is interrupted, the object commits one with status `cancelled` for each subagent the lost sandbox left running, since nothing else will report them.

## Commands sent to the runtime

The control plane's commands (`packages/protocol/src/commands.ts`):

- `run.start`
- `run.follow_up`
- `run.pause`
- `run.cancel`
- `approval.resolve`
- `approval.mode`
- `question.resolve`
- `context.add`
- `agent.stop`
- `checkpoint.create`
- `policy.set`
- `runtime.shutdown`

Each command has a unique identifier and the session or run state it expects. `run.start` and `run.follow_up` may carry `skipRequiredChecks` (absent means false; nothing infers a skip from message text) and up to ten `attachments`. The control plane claims each upload for the session before planning the command and puts its own record of it in the command, so the committed content type, size, and label are the Worker's; a reference it cannot claim rejects the command `unsupported`. `run.follow_up` may carry `effort` for the next run (record 15).

Only six commands reach the bridge, as `bridge.command` frames carrying the committed envelope: `run.start`, `run.follow_up`, `run.cancel`, `agent.stop`, `checkpoint.create`, and `runtime.shutdown`. The object refuses `agent.stop` unless that subagent of the run is running in its `subagent` table; the bridge aborts that subagent's conversation and the subagent ends with `agent.completed`, status `cancelled`. The frame also carries the run id the bridge's events will use. The rest are handled in the object: `run.pause` commits `run.paused` without telling the bridge; `approval.resolve`, `approval.mode`, `question.resolve`, and `policy.set` are described below; `context.add` is acknowledged and does nothing yet. A client's own `checkpoint.create` is acknowledged and goes no further; the bridge only receives the ones the object issues.

A `run.start` that opens a resumed or replacement generation carries `context`, record 11's durable context summary, which the bridge prepends to the prompt and which is never part of the committed command. A `run.start` or steered follow-up with attachments carries one fetch per attachment, each with a single-use bearer the object mints for that generation, valid ten minutes (`ATTACHMENT_TOKEN_TTL_MS`) and stored only as a hash.

### Acknowledgement

The bridge answers each command and grant with `bridge.ack` after validation and before any work: `accepted`, or `rejected` with `wrong_state`, `duplicate` (a new command for a message already prompted), `no_runtime`, `unsupported`, or `malformed`. The object records acceptance as `command.acknowledged` with `acceptedBy: "bridge"` and a rejection as `command.rejected`. Acceptance means the bridge took responsibility, not that the work succeeded. A redelivered command or grant gets the acknowledgement it got the first time.

### Follow-ups and Continue

A `run_next` follow-up is held until the active run ends, then issued as a new `run.start` with `continuesRunId` and trigger `queued_message`. A `steer_current_run` follow-up is prompted into the live conversation at once; on a `paused` or `interrupted` run it is Continue, which provisions a new generation and sends the message as that run's `run.start` (refused `wrong_state` while a sandbox is live or starting, as is a `run_next` follow-up on such a run). `run.cancel` aborts the turn and leaves the harness up; the object commits `run.cancelled` itself.

### Credentials

Credentials travel as `bridge.grant` frames, each with its own grant id:

- `model`: a Model Broker token for the generation, naming the harness, model, effort, and the catalog's facts about the model.
- `git`: a single-use `contents: read` installation token for the clone, naming the branch, the base, the commit the clone must land on, and optionally a patch bundle to restore with its own one-time download token.
- `push`: a single-use `contents: write` token for one checkpoint push, naming exactly `refs/heads/<task branch>` and the parent to build on. The bridge refuses any other destination before the token reaches a process, and the object revokes the token after the bridge reports, or two minutes (`PUSH_GRANT_TIMEOUT_MS`) after sending it.
- `upload`: a one-time bearer for one declared artifact, answering `artifact.uploading`.
- `secret`: development secret values for the supervisor to write (record 08), sent after `runtime.ready` for a launch's selection and after the user's click for an approval.

### Policy

`policy.set` is the user's side of the Git policy (records 07 and 09) and never reaches the bridge. Its payload is `confirm` or `decline` for the one open proposal (by `proposalId`; `confirm` also names the `policyVersion` the card showed), or `set` to write `commit`, `push`, and `pullRequest` from a product control. `confirm` and `set` may carry `branchName` for the first push. The agent cannot issue it.

The agent's `policy_propose` tool becomes a `policy.proposed` event, which the object judges against its own rows: it mints the `proposalId` and rewrites `from`, `to`, and `direction` to what it computed (`apps/web/worker/policy/git-policy.ts`), commits `policy.updated` at once for a change that only narrows, and holds a widening or mixed change as the single open proposal. At most five proposals are admitted per run; proposing what is already so is refused without counting; a refused proposal is never stored; and a socket with a fourth refused proposal (`MAX_PROPOSAL_REFUSALS`) is closed with 4001.

The object sends `bridge.policy` with the policy in force when the runtime is ready and on every `policy.updated`, so the bridge's proposals and `git_commit` see the current policy. It is advisory, never acknowledged, and never sent in answer to a frame.

### Publishing

A publish is the user's push, sent as the same `checkpoint.create` a stop sends, with reason `user_requested` and a `push` grant ahead of it. The object asks for one after a run ends or when a `policy.set` has just allowed pushing, and only under `push: auto`, with a bridge attached, no stop under way, the run not yet published, and no other publish open within its grant's two minutes. The code must be covered by some run's checks (`coverFor` in `apps/web/worker/session/publish-cover.ts`); when none covers it, a checks-only run goes first (record 14).

The object commits `git.push.requested` with `headSha` null. The bridge commits its snapshot on top of the agent's `git_commit` chain, pushes, and reports `git.committed` and `git.push.completed` or `git.push.failed` (category `workflow_file_rejected` when GitHub refuses a `.github/workflows` change) before `repository.checkpointed`. The object stores a push result only for a publish it asked for and has not heard about, with one exception: `git.push.failed` with category `secret_in_changes` is stored from a generation that holds a secret, because it is how any checkpoint says it published nothing (record 08). The object commits `git.push.withheld` itself when it gives a publish no push grant because the existing branch the session works on is no longer one it may push to (record 07); the view reads it as a failed push.

The checkpoint report ends a publish only when one is waiting within its two minutes; the object then revokes the push token and opens or updates the pull request (record 07). A report naming a local commit or patch bundle is a failed publish; a `repository.checkpointed` with no publish waiting reaches GitHub not at all; a `sandbox.checkpoint_failed` settles the newest waiting publish as failed. The report's `kind` is the sandbox's word, so a false `branch_push` is settled as nothing to push (`../backlog.md`).

### Approvals

`approval.resolve` is the user's answer to an open approval and never reaches the bridge as a command. Its payload is the `approvalId`, the decision, and for a harness permission ask an optional `scope` (`once`, `session`, or `always`); who decided is the user verified on the socket, and when is the object's clock. The object refuses (`unsupported`) a scope the card does not offer: anything but `once` on a secret or a secret file, and any scope on a denial. The bridge learns the outcome from a `bridge.approval` frame (see "Approval flow").

`approval.mode` is the approvals picker below the composer (record 09): `ask`, `session`, or `always`. The object commits `approval.mode_changed` and writes the session's own mode (`session` for `session`, `ask` otherwise); for `ask` and `always` it also clears the session's per-category rules. The workspace's default is not the command's: the browser saves it through `/api/approval-settings`, whose answer is what is in force.

## Delivery and ordering

The protocol assumes at-least-once delivery. Safety comes from unique command and event ids, monotonic sequences, idempotent commits, explicit acknowledgement, gap detection with replay, and generation checks.

The object admits only the next runtime sequence of the generation, so the bridge keeps its sequence whole. It never drops a durable frame it has not sent: frames stamped while no link is up wait in its outbox and go out, in order, when the next link is welcomed, and that link's `runtime.connected` is stamped after them. A streamed frame made while no link is up is dropped before it takes a sequence slot. Of the frames it has sent, durable and streamed alike, committed or not, it keeps the latest 4,096, up to 8 MiB (`OUTBOX_RING`, `OUTBOX_SENT_MAX_BYTES` in `agent-io.ts`), to answer a replay, because a frame of either kind lost on a link that died half-open leaves a gap only a resend fills; a replayed streamed frame arrives late, and a client ignores a delta for a message it already holds whole. "Sent" means only handed to the socket, so nothing is evicted while no link is up or until the current link has stayed up 30 seconds: the frames a half-open link lost are what the object asks for first, and the flush of a long backlog must not push them out. A repeated `replay_from` for a sequence already replayed on the same link is ignored. Unsent frames are bounded by bytes instead (`OUTBOX_UNSENT_MAX_BYTES`, 32 MiB): past it the bridge stops reading OpenCode's event stream until a link drains the outbox. That bounds the bridge's memory and loses no timeline row; it is not known to slow OpenCode, which keeps running and may buffer what goes unread itself (unverified against OpenCode 1.18.30). The other harnesses' channels are not paused; their output during one outage is bounded by the outage's ten-minute window below. A frame ahead of the expected sequence is refused as a gap and answered with `replay_from`; the bridge re-sends from there if its ring still reaches back, and otherwise sends nothing. The object asks at most three times per socket with nothing admitted between (`MAX_REPLAY_ASKS`), then logs `replay_unavailable` and closes with 4001; a generation that cannot get back in step ends through loss reconciliation. Every loop with the bridge is bounded on the object's side because an unbounded replay exchange once exhausted the account's Durable Object reads (`../history.md`). The object never fabricates missing tool outcomes, and a gap larger than the ring is not recoverable.

Events originate in the sandbox, where the agent also runs. The object validates shape, generation, and sequence but cannot prove an event reflects reality. The Unix-user separation of record 02 protects the bridge's credentials from the agent, and external effects are audited independently, so verification records are evidence trusted to the extent the sandbox is intact.

## Streaming without overwhelming storage

Ephemeral events (`message.delta`, `tool.output`) are broadcast live and not stored. Completed messages, tool results, errors, approvals, lifecycle changes, and verification results are durable in the object's own storage.

A check's output is never streamed. Each attempt produces at most three frames: `verification.started` before the process runs; `artifact.uploading` for its full log once it ends (kind `log`, at most 25 MiB, cut with a marker past that); and `verification.result` with at most the last 4,000 characters and the log as evidence. A run has at most ten checks (`MAX_CHECKS_PER_RUN`), and each attempt runs at most thirty minutes (`CHECK_TIMEOUT_MS`). `verification.completed` and the terminal event follow the last check. A log that would pass the run's 100 MiB artifact budget is recorded without evidence.

A diff is never streamed either. A patch travels inline in `diff.updated` only up to 64 KiB and while its JSON stays under 160 KiB; the file list holds at most 500 entries and is cut further until the event leaves 16 KiB of the 256 KiB event limit for the envelope. Past that, at run end and at a checkpoint, the whole patch (at most 5 MiB as read) uploads as one `diff` artifact announced just before the `diff.updated` that names it, and a turn and session diff with identical bytes share one artifact. A mid-run rebuild never uploads. Every cut sets `truncated`.

## Approval flow

1. The bridge emits `approval.requested` before the action and holds the tool call.
2. The object commits the request and moves the run to `waiting_for_approval`.
3. The person approves or rejects. A narrower action is a new request.
4. The object commits the decision and tells the bridge with a `bridge.approval` frame.
5. The bridge acts only on an outcome for the call it is holding.

Approval is never inferred from silence, a model message, or a client-only state change.

Record 09's tier table (`apps/web/worker/policy/tiers.ts`) allows two kinds of request: supplying an optional development secret that was not selected at launch, and the harness's own permission asks (`outside_project`, `secret_file`, `repeated_action`, `start_subagent`, `other_request`; record 09, "Agent permissions", describes how those are answered). The protocol's other categories (`external_connection`, `network_expansion`, `external_action`) have nothing that could act on an approval and are refused. For a secret:

- The request is trusted for one fact, that a tool call waits for the secret named in `resource`. The object refuses a request while another is open or outside the running run, a sixth in a run (`MAX_APPROVALS_PER_RUN`), a name not declared optional at launch, one already supplied to this generation or denied in this run, and one with no saved value. Refusals are never stored; those only a hostile or broken bridge would send are counted, and the fourth on a socket closes it with 4001.
- The object mints the `approvalId` and writes the title, risk, scope, and `expiresAt` itself, discarding the sandbox's versions.
- `bridge.approval` carries `pending` with the expiry, then `approved`, `denied`, `expired`, or `refused`, and is never acknowledged. `approved` releases nothing by itself: the value arrives in a `secret` grant, and a bridge with no value answers "not supplied".
- An approval expires ten minutes after it was asked (`APPROVAL_TTL_MS`, shortened locally by `ONCUE_APPROVAL_TTL_SECONDS`), on the object's alarm. Expiry and denial both deny the tool call and return the run to `running`.
- No decision outlives its generation: when the generation ends or the run stops waiting, the object closes the approval with effect `run_paused`, and a resumed run asks again. A decision racing the end is refused `unknown_approval` or `stale_generation`.

For a harness permission ask the bridge forwards one ask at a time (`permissions.ts`, at most 16 held), and a secret request waits while a permission card is out, as a permission ask waits behind a secret card. It is trusted for the category, the resource it names, and the tool's kind. The resource is the tool and its path or paths, never a command's text, or for `start_subagent` the built-in subagent's name and the agent's description of the task, a shape the object checks; it is redacted like every frame and only then cut to 200 characters, so a value straddling the cut is still caught. The object writes the card itself (`permission-asks.ts`, `object/permission-gate.ts`), records at most 200 a run (`MAX_PERMISSION_ASKS_PER_RUN`; past that a saved choice answers unrecorded and an ask needing a card is refused, uncounted), and either commits the request with an automatic `approval.resolved` at once, leaving the run `running`, or opens the card and moves the run to `waiting_for_approval`. The bridge then hears `allowed` (it replies `once`), `denied`, `expired`, or `refused` (it replies `reject` with words that tell the model to continue without it). It never replies `always`, because OnCue keeps the saved rules. Refusals share the secret gate's counters and limits; a repeat while a card is open is not counted. The same ten-minute expiry applies. The bridge arms its own deadline when it sends an ask and again on `pending`, 45 seconds past the card's expiry (`DEADLINE_GRACE_MS`), so the object's expiry or a late click arrives first and an answer lost on the way cannot hold the queue; the secret card's backstop waits the same grace.

## Questions to the user

The agent may ask the user up to four questions, each with up to six choices and room for a typed answer, before it chooses an approach. Every harness asks through its own channel, and the bridge turns each into one shape (`services/bridge/src/questions.ts`):

| Harness | How it asks | How it is answered |
|---|---|---|
| OpenCode | Its own `question` tool, allowed for the primary agent alone; the `question.asked` server event | `POST /question/{id}/reply` with one list per question, or `/reject` |
| Claude Code | `AskUserQuestion`, which is offered but never pre-allowed, so it arrives as `can_use_tool` | `allow` with the original questions and an answer keyed by each question's text, or `deny` |
| Codex | OnCue's dynamic tool `oncue_ask_user`, because Codex refuses its own question tool outside plan mode | The tool's result text, one line per question and answer |
| Pi | OnCue's extension tool `oncue_ask_user`, which opens a dialog titled `oncue.question` | The dialog's value, which the extension returns as the tool's result |

OpenCode drops a tool call held open through OnCue's MCP tool server after 60 seconds, which is why questions use each harness's own channel. None of these channels has a deadline. Only OpenCode's path runs end to end in tests; the other three are unit-tested against their documented shapes.

1. The bridge bounds the questions (four, six choices, the protocol's text limits), keeps positions so answers line up, redacts them with every other draft, and sends `question.asked` under its own reference. One question waits at a time: a second, or one asked with no running run, is dismissed at once, and the harness is told which ("Only one question can wait at a time; ask again after the first is answered", or that no run is active) rather than that the user dismissed it. OpenCode's reject carries no text, so its model hears only that the question was rejected. OpenCode keeps a waiting question across a gap in its event stream, so after each reconnect the bridge reads `GET /question` and offers what is pending; the question it already waits on, offered again, changes nothing.
2. The object admits it only from the session's current run while it is running or waiting for an approval, at most ten a run (`MAX_QUESTIONS_PER_RUN`) and only when none is open. It mints the `questionId`, stores the bridge's reference, and the sidebar's "Needs you" reads it. A refusal is never stored; the bridge is told `refused`, and a fourth counted refusal on a socket (`MAX_QUESTION_REFUSALS`) closes it with 4001.
3. `question.resolve` answers (one list per question) or dismisses the open question. The object commits `question.answered` or `question.dismissed` and tells the waiting harness through a `bridge.question` frame, never acknowledged, which it sends again when that generation's bridge reconnects.
4. A message the user sends while the question waits dismisses it (`message_sent`) before the message is delivered, and so does the user's pause (`run_paused`), which would otherwise hold the answer until the sandbox idled. A run that ends, fails (a lost runtime included), or that the bridge pauses dismisses it (`run_ended`). The planned replacement at the lifetime ceiling dismisses it as it interrupts the run (`sandbox_replaced`): the harness's call does not exist on the new sandbox, and the restarted run's context says the question went unanswered so the agent can ask again. The object counts a question as waiting for the idle timer only when it belongs to the current run and the current sandbox generation.

There is no timeout. A running run that waits only on a question counts as idle, so the sandbox stops on its normal timer; the idle stop pauses the run (`run.paused`, `idle_stop`) and the question stays open. An answer to a paused or interrupted run resumes it on a new sandbox, like Continue, and is refused in the same words as Continue when the run's model connection is not active. The run's message is "Answers to your questions:" with each question and answer quoted and clipped as the resume context quotes them, and the whole within one message's bound; the resume context (record 11) also replays each question and what became of it, a dismissed one with why.

## Coding work profile

The platform, not the harness, owns what makes repository work a coding session: how the repository and base commit are provided (record 07), which checks run (records 08 and 14), the Git policy (record 07), and which approvals exist (record 09). That is why a second harness runs the same kind of work under the same rules. There is no general work-profile mechanism yet; other profiles (research, documents) would reuse the lifecycle, message, tool, approval, artifact, and verification families and add types only when a real need appears.

## Versioning

Every envelope carries `protocolVersion`, which is 1 (`PROTOCOL_VERSION` in `envelope.ts`); the object refuses any other value as `unsupported_version`. There is no version negotiation and no check of the bridge version before work is accepted. Compatible changes add optional fields or new event types, and readers accept older payload shapes (for example a stored `run.queued` without `effort`); stored events are never rewritten. Every image records its bridge version and, through `runtime.ready`, the harness version.

## Failure behavior

- **Harness exits:** The bridge sends `runtime.disconnected` with `runtime_exited` or `runtime_crashed` and the exit code, and a run still waiting on the agent ends `run.failed` at `execution`. The harness is not restarted.
- **Boot fails:** A clone, chown, start, or health failure sends `runtime.disconnected` with reason `boot_failed` and `expectReconnect` false; the object ends the generation as a failed provisioning.
- **Bridge reconnects:** The bridge's reconnect budget is per outage, not per process (`createReconnectPolicy` in `services/bridge/src/protocol.ts`). Waits start at 0.5 seconds, double to at most 5, and are jittered between half and all of that. A link that was welcomed and answered for 30 seconds (measured to the last frame or pong heard, not to when its silence was noticed) ends the outage before it, so a sandbox survives any number of separate drops (Worker deploys, object restarts, network blips). One outage, attempts and short-lived links together, gives up after ten minutes, and the bridge exits. The object's close codes 4000 (stale generation, before or after the handshake) and 4401 (a credential it does not accept, or a session that was deleted) end the bridge at once, since every attempt would get the same answer; 4001 and every other close are reconnected after. The WebSocket upgrade has a 20-second bound, and an opened socket that is not welcomed within two heartbeat intervals is dropped.
- **Bridge disconnects:** The object waits for a reconnect and asks the provider through `getStatus` 15 and then 30 seconds after the close. Only a confirmed-gone sandbox is a loss: an executing run becomes `run.interrupted` when a checkpoint exists and `run.failed` at `execution` when none does (record 01).
- **Event rejected:** The object refuses it and, for the bounded cases above, closes the socket; the bridge reconnects.
- **Approval expires:** The tool call is denied and the run continues without the value.
- **Large output fails to upload:** The bridge emits `artifact.failed`; the tool result keeps its inline cut and claims no durable artifact. The protocol's `incomplete` tool-result kind is defined for this and not yet emitted.
- **Client disconnects:** Work continues.
- **Model token refused:** The relay reports the broker's category. On `authentication_failed`, `usage_limit_reached`, or `model_unavailable` the bridge sends `run.paused` with reason `model_failure` and aborts the turn. Other failures are left to the harness's own retries. On `authentication_failed` the object then stops the sandbox at once, with a checkpoint (record 11). Same-model retry and model switching from a paused run are not built (record 15).

## Not built yet

- Emitting `runtime.heartbeat`, `status.updated`, `run.blocked`, `plan.blocked`, `plan.cancelled`, and the review family.
- `context.add` delivery to the harness.
- Recovery from a replay gap larger than the bridge's ring.
- Protocol version negotiation.
- Pi and Claude Code in the sandbox image, and any live run of Codex, Pi, or Claude Code (`../roadmap.md`), including their question channels.

## Non-goals

Exposing raw harness events as the public API, preserving hidden reasoning, a universal agent protocol, storing every output byte, letting the sandbox approve its own actions, and exactly-once delivery.

## Conditions for reconsideration

Revisit the harness choice if a harness cannot expose the events OnCue needs, hold a tool call for approval, drive the supported models, recover sessions, or give reliable tool control. Revise the protocol when a real work profile cannot express its progress or evidence without leaning on opaque runtime payloads.
