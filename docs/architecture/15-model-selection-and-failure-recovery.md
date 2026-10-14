# Model selection and failure recovery

**Status:** Approved foundation

## Purpose

The user chooses which connected model does the work. OnCue never moves work to another model, connection, or provider on its own, because that changes cost, privacy terms, and output quality. When the chosen model cannot continue, the run pauses and says why.

## Key decisions

- Each run records one model, one model connection, and one effort level where the model has one.
- The model and connection are chosen on Home when the session starts; later runs keep them unless the owner names another on the message that starts the next run (see "Changing the model within a session"). Effort may change the same way. Neither changes inside a run.
- The server never picks a connection: a create request that names none, in a workspace that has one, is refused (`resolveModel` in `apps/web/worker/broker/connections.ts`).
- A workspace with no active connection runs the scripted model only on a local Worker. A hosted Worker refuses its create with `model_connection_required` (`refuseHostedStandIn` in `apps/web/worker/routes/sessions.ts`), since the session would otherwise run a real sandbox behind a placeholder.
- A session is not created on a key the provider rejects: the create route asks the provider about the chosen key first (record 06, "Key checks") and refuses with `model_key_rejected`. A provider that cannot answer does not hold the session back.
- No automatic fallback to another model, connection, or provider, and no cost- or quality-based routing.
- Provider errors map to seven stable categories. A category that waiting cannot fix pauses the run. Failure messages, events, and logs never include the credential (record 06) or prompt content.

## Model selection boundary

A model connection (record 06) is a provider account with a sealed key. Its models come from a static catalog per provider (`apps/web/worker/broker/providers/catalog.ts`) with each model's context window, documented effort levels and default, list price, and image support. A static table keeps run records reproducible and the picker free of provider calls.

`run.queued` records (`modelRecord` and `runtimeRecord` in `packages/protocol/src/schema.ts`):

- Provider, model id, model connection id, and authentication type (`api_key` or `subscription`)
- Context window, where known
- Effort in the provider's own word, or `null` for a model without one (a run stored before effort existed reads as `null`)
- Runtime and adapter versions: the harness id and the version the image pins (`runtime: { id, version }`; older runs read as OpenCode). The harness's reported version arrives on `runtime.ready`, and the bridge bundle's version, which includes the adapter, on `runtime.connected`.

The terminal event carries provider-reported usage, or `null`. No record holds hidden reasoning.

The Model Broker enforces the record on every request (`apps/web/worker/broker/effort.ts`): a body for another model or another effort level is refused, and a body with no effort gets the recorded level written in (Anthropic `output_config.effort`, OpenAI `reasoning.effort`). The recorded effort is what the provider saw, whatever the harness sent.

`ONCUE_MODEL_ALLOWLIST` narrows the models a local Worker may start a session on or change one to, as a cost guard for live testing (`apps/web/worker/broker/model-guard.ts`); a hosted Worker ignores it.

## Changing the model within a session

The owner may change the model between runs. The change rides the message that starts the next run: a `run.start` that continues the session's latest run and names another connection or model. The session object decides (`decideModelChange` in `apps/web/worker/session/model-change.ts`), and the run it queues carries the trigger `model_change`. Earlier runs keep their own model records, and nothing is changed without the owner's message.

What the object checks, in order, and refuses with fixed words as `command.rejected`:

- The start is not checks-only, which prompts no model.
- It continues the session's latest run. A start naming an older run, or none, is refused, so a browser tab that has not seen the latest run cannot move the model.
- The latest run has ended, or is `paused` or `interrupted`. A run that is still working is refused: nothing changes inside a run.
- The named connection belongs to the session's workspace and is `active`. Absent and another workspace's get one answer.
- The model is in the catalog under the connection's own provider, and the effort is one the model offers (none named opens on the model's default).
- A local Worker's `ONCUE_MODEL_ALLOWLIST` allows the model.
- The session's harness can run the provider and the effort (`resolveRuntime`, record 04). A session keeps its harness.

The record the run stores is built by the object from the connection row and the catalog. Of the record the browser sent, only the connection id and the model id are read. A start that names the latest run's own connection and model is not a change, whatever its effort, and is handled as before.

**A paused or interrupted run.** A run records one model, so it cannot be continued on another. The object ends it as `cancelled` by the owner (the only exit record 01 allows a paused run besides resuming) and queues the changed run with `continuesRunId` naming it. It does this only when nothing else would refuse the new run, so a refused change leaves the paused run as it was. This is how a run paused on a rejected key goes on: the owner picks a model on another connection.

**Where the changed run starts.**

- *In the sandbox now attached*, when its harness can take another model on its next prompt and its bridge said so. The object sends a fresh `model` grant, whose token names the new connection and model (record 06), ahead of the `run.start` on the same socket, and the harness continues its own conversation. Only OpenCode does this (`liveModelSwitch` in `packages/protocol/src/runtimes.ts`): a prompt names its model, and the bridge starts OpenCode with every catalog model declared and every provider pointed at the relay, from the list the first grant of a generation carries. The bridge names the capability `model_switch` on `runtime.connected`; an older bridge bundle names none. Observed with OpenCode 1.18.30 against the provider double: a prompt for a model of an undeclared provider fails with "Model not found", and with both declared the same conversation moves from Anthropic's Messages API to OpenAI's Responses API and back. Not yet observed against a real provider (`../backlog.md`).
- *On a new generation otherwise*: no sandbox is attached, a stop is already under way, or the harness or bridge cannot change model in place. In the last case the object stops the sandbox as an idle stop does, checkpointing first (record 11). Either stop's last step starts the queued run on a new sandbox, and nothing for the changed run is sent to the one that is ending (`placeChangedRun` in `apps/web/worker/session/object/model-change.ts`). The harness there starts on the changed model, and the run's first prompt carries the context summary record 11 composes from committed events (the conversation, the plan, and the checkpoint), sized to the new model's window.

The bridge holds two lines of its own, whatever the object sent (`services/bridge/src/agent.ts`): it refuses a model grant for another model while a run is working (`wrong_state`) or once its harness has started without that model declared (`unsupported`), and it refuses a `run.start` whose record names another model than the one it holds, so no run is prompted on one model under another's name. A refused grant fails the changed run at `provisioning` (`model_grant_rejected`).

The Model Broker's enforcement is unchanged: each token names one connection, one model, and one effort, and a body for any other is refused. The grant goes ahead of the start, so the relay holds the new token before the harness is prompted. The earlier token is dropped by the relay when the new one arrives; it stays valid at the broker until it expires (ten minutes) or its generation ends, as an earlier effort's token does.

`session_index.model_connection_id` follows the latest run, so Settings' count of sessions per key stays true (record 06). The commit that changes the model marks its outbox snapshot, and the projection then writes the current run's connection (`applyProjectionToD1`).

Not checked before the change: whether the provider still accepts the new connection's key. A rejected key pauses the changed run at its first request, as it would any run.

## Failure categories

`FAILURE_POLICY` in `apps/web/worker/broker/forward.ts` maps each category (`MODEL_FAILURE_CATEGORIES` in `packages/protocol/src/states.ts`) to a fixed answer:

| Category | Meaning | Retry safe | Status |
| --- | --- | --- | --- |
| `temporary_service_failure` | Timeout, dropped connection, temporary provider error | Yes | 503 |
| `rate_limited` | Provider asks the client to wait | Yes | 429 |
| `usage_limit_reached` | Allowance or spending limit exhausted | No | 429 |
| `authentication_failed` | Key invalid, expired, or revoked | No | 403 |
| `model_unavailable` | Model removed, disabled, or not available to the account or the key | No | 404 |
| `request_rejected` | Size, policy, unsupported input, or other non-temporary refusal | No | 400 |
| `broker_failure` | OnCue could not reach the provider or use the credential | Yes | 502 |

Only `authentication_failed` can change a stored row, and only once it is confirmed. When a provider refuses a model request as unauthorized, the broker asks it about the key itself before answering (record 06, "Forwarding"):

| The key check says | The sandbox is answered | The connection |
| --- | --- | --- |
| rejected | `authentication_failed` | marked `invalid` |
| accepted | `model_unavailable` | stays `active` |
| nothing either way | `authentication_failed` | stays `active` |

`model_unavailable` is the answer for a working key because that is what it means to the user: this key cannot use this model, and the key itself needs no replacing. It also pauses the run at once, where `request_rejected` would be left to the harness. The user sees plain words for each category (`MODEL_FAILURE_WORDS` in `apps/web/src/features/session/status.ts`), never the raw provider error and never the bridge's own diagnostic (the pause's `modelFailure.message`, such as "broker answered 403: ..."), which stays in the event.

## Safe retry policy

The broker forwards each request once. The harness in the sandbox retries temporary failures itself (OpenCode does; the other harnesses' retry behavior is untested), and two retry loops around one request would compound, so the broker returns the category and whether a retry is safe, and the run decides.

The bridge (`services/bridge/src/agent.ts`) pauses the run at once for `authentication_failed`, `usage_limit_reached`, and `model_unavailable`: `run.paused` with reason `model_failure`, the category, a message, and `retries: 0`, and the current turn is aborted. Other categories are logged and left to the harness.

## Pause and recovery

A paused model failure shows as "needs you", and the session says why in three places that read one module (`apps/web/src/features/session/model-failure.ts`), so they cannot disagree:

- **The timeline.** The pause is a row of its own, "Paused" with "Model request failed: the provider rejected the model key." beneath it. It stands on the timeline like an outcome, never inside a folded group (record 13). Each pause row keeps its own reason, since a run can pause more than once.
- **The note under the composer.** The same sentence, then what to do next. This is the note a reader sees with the session details unpinned, which is how every chat opens.
- **The context rail,** when pinned, with the same words. It offers no retry control; another model is chosen from the composer's chip, below.

What to do next depends on where the run's connection stands and whether its sandbox is still up. A connection that is `invalid`, `expired`, or `attention_required` is **replaceable**: replacing the key keeps the connection's id and returns it to `active` (`replaceCredential`), so the same run continues. A connection that was revoked or deleted is **gone**: nothing brings it back, so the work moves to a new session.

| Connection | Sandbox still up | Sandbox stopped |
| --- | --- | --- |
| Replaceable | "Replace the key under Settings, Model providers, then come back here to continue the run." Stop run is offered and no send. | The same sentence, and the composer is disabled. The sentence does not change when the sandbox stops, which can be seconds after the pause. |
| Active | For a rejected key, "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it." Then, for any failure: a message cannot reach the run yet, so stop the run to send a new one, or wait for the sandbox to stop. | The same sentence for a rejected key, then "Send a message to continue the run from its last checkpoint." The composer's send reads Continue, and so does the rail. |
| Gone | "The key this run used has since been removed. Add a working key under Settings, Model providers, then start a new session to continue the work." | The same, and the composer is disabled. |

An active connection after `authentication_failed` has two causes the screen cannot tell apart: the key was replaced since, or the provider's refusal never marked it. So the note claims neither; it says what Settings shows and where to replace the key if the refusal repeats. Wherever the way forward may be in Settings (a rejected key, or a connection that is not active), the note, the rail, and the pause row the run is stopped on link to Settings, Model providers. A finished run whose next message needs a connection that is not active gets the same two answers without a failure to lead with (`KEY_GUIDANCE`, record 10).

A paused run does not hold off the idle stop. For `usage_limit_reached` and `model_unavailable` the sandbox stops after the usual twenty minutes without activity. For `authentication_failed` it stops at once: the session object reads the category from the stored `run.paused` and starts the idle stop without waiting, checkpoint first, unless a keep-alive the user asked for is still running (record 11, "What counts as activity"). Until the key is replaced that sandbox can run nothing, and Continue starts a new one in any case, so keeping it would only cost the user money.

Once the sandbox has stopped, Continue is offered while the run's connection is active. Replacing a key keeps the connection's id and returns it to `active` (`replaceCredential`), so the same run continues from the stop's checkpoint on a new sandbox; a Re-check in Settings that the provider accepts does the same. Until then Continue is refused with `wrong_state` (record 10, "Retry and interruption"), Continue is hidden, and the composer is disabled with guidance to add a working key, as for a finished run whose next message needs that connection. Nothing resumes a paused run but the user: if the run pauses on a rejected key again after Continue, its new sandbox stops the same way and waits for the next Continue, so each further sandbox costs one click.

The object acts on the category the sandbox reported, and the sandbox is untrusted. A sandbox that reports a rejected key it did not meet only gets itself checkpointed and stopped early.

The other way on is another model. The composer's agent chip stays open on a paused or interrupted run, also when the box is disabled, and choosing a model on an active connection there continues the work as a new run (see "Changing the model within a session"). When the note under the composer points to Settings, Model providers and another active connection exists, a line beneath it points at the model menu; once a model is chosen, the note about the next run replaces both. The owner chooses; OnCue never does. The object's refusal of a resume on an inactive connection still ends "start a new session", which is no longer the only way on (`../backlog.md`).

The connections a session screen holds came with the page (`GET /api/me`), so a key rejected or replaced since is not in them. When a run pauses on a model failure the screen reads them again, and says nothing about the key's state until that answer arrives. While the run waits on a replaceable key it reads them again on every return to the tab (`apps/web/src/lib/use-refresh-on-return.ts`), so a key replaced in Settings or another tab is seen without a reload.

### On Home

`GET /api/me` reports a workspace's replaceable connections beside its active ones, in `setup.inactiveModelConnections` (`listInactiveConnectionSummaries` in `apps/web/worker/setup/read.ts`): the connection's id, provider, status, and how many active sessions are on it. The field is present only when there is such a connection. A revoked connection is not reported, because its provider takes a new key. `modelConnections` still lists only active connections, and the create route still accepts only those (`resolveModel`).

Home shows each one in two places (record 13). A banner above the composer names the provider and the sessions, for example "The OpenAI key was rejected. 2 active sessions use it and can't continue until the key is replaced.", with "Replace the key" linking to Settings, Model providers. The picker lists that provider's models greyed, each with "Key rejected" (or "Key expired", "Key needs attention") and Replace, which goes to the same place; none can be chosen. While a banner is on screen Home reads `GET /api/me` again on arrival and on every return to the tab.

## Refusals at session creation

Home shows why a create was refused and keeps the draft (`createFailureCopy` in `apps/web/src/lib/api/sessions.ts`). Four refusals are about the workspace's keys, so Home also reads them again and links to Settings, Model providers:

| The Worker answers | Home says |
| --- | --- |
| 409 `model_key_rejected` | "OpenAI rejected this key. Replace it in Settings or pick another model." (the provider it names) |
| 409 `not_active`, 403 `not_usable` | "That model's key was removed or is no longer accepted. Pick a model again, or add a key in Settings." |
| 400 `connection_required` | "Your model keys changed since this page loaded. Pick a model and send again." |
| 409 `model_connection_required` (hosted only: the workspace has no active connection) | "Add a model key in Settings before starting a session." |

The connection Home sends is the one picked on the page, else the remembered one, else the oldest key, and never one the list no longer holds (`liveModelConnectionId` in `apps/web/src/features/home/model-choice.ts`).

## Cost and privacy clarity

The Home picker names each model under its provider with the connection it charges; Settings, Model providers lists prices. Only the named connection is charged, another workspace's is never offered, and OnCue gives no price estimate.

## Interface behavior

The composer's agent chip shows the current run's model and effort; the context rail does not (record 13). It reads "Model unavailable" when the run's connection was deleted or is not active, whether or not the workspace holds another key, rather than naming another connection. The effort in the chip's panel opens on the current run's level and sets the next run's; a model without effort shows none.

While a run is working the chip's model is text. Between runs, and on a paused or interrupted run, its panel lists every model on the workspace's active connections. Choosing another opens no dialog and sends nothing. The chip shows the chosen model, and a note under the composer (`model-switch.ts`, rendered in `SessionScreen.tsx`) says the next message starts a run on it, the effort that run opens on, and the connection charged, with "Keep the current model" as the way back. The same note warns only when the conversation is larger than the chosen model's context window or within a fifth of filling it, since earlier turns are then summarized or dropped. A window that is merely smaller and an effort level that does not carry over are not said in words: the context meter shows the new window at once and the chip shows the effort. The owner removed those two lines on 2026-10-13 as unneeded. On a paused or interrupted run it also says that run ends when the message is sent. The next message carries the choice. The choice belongs to the run it was made against and is dropped once another run starts. A refusal from the object shows under the composer like any other.

The note does not say whether the model reads images, because the browser's catalog does not carry that. The turn that starts a changed run is marked in the timeline with a row, "Model changed from Opus 5.5 to Haiku 4.5" (`ModelChangeRow` in `Timeline.tsx`, from the run's `model_change` trigger and the model of the run it continues). The context meter measures against the window of the model that reads the conversation next: the chosen model's from the moment it is chosen, then the changed run's, taken from the catalog until that model's first answer reports its own (record 13, "Context meter").

## Not built yet

See `../roadmap.md`.

- A check of the new connection's key against the provider before a model change starts a run.
- Changing the model on a message held for the next run (`run.follow_up` with `run_next`), which names an effort but no model.
- A changed model in a live sandbox for Codex, Pi, and Claude Code, which today move to a new sandbox.
- A retry of the same model from the pause, and reconnecting from the picker. The `retry` trigger exists in the protocol; nothing starts such a run.
- An OnCue-owned retry loop with bounded backoff and duplicate-turn protection.

Automatic fallback, cost- or quality-based routing, platform-funded backup credentials, splitting one run across models, and model voting are out of scope.
