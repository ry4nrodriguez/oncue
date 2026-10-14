# Model access and credential broker

**Status:** Approved foundation

## Purpose

Users connect their own model access, and the provider bills them directly. OnCue offers no shared platform key, so it needs no credits, balances, or quotas. A permanent provider key never enters a sandbox: the harness reaches the model through the Model Broker with a short-lived, narrowly scoped token.

## Decisions

- A provider API key is the connection method. Anthropic and OpenAI are the supported providers.
- The user pays the provider. OnCue does not sell, reimburse, or meter model use.
- Long-lived provider credentials stay outside the sandbox; sandboxes call providers through the broker.
- One sealed envelope and keyring protect every stored user credential: model keys, GitHub user tokens, the Modal credential, and development secrets.
- Subscription logins are reviewed provider by provider and are not built. A consumer subscription is not assumed to grant API access.
- Claude Pro or Max credentials are not used through any harness.

## Subscriptions

API keys have documented behaviour and clear billing, so they are the foundation. An API account and a consumer chat subscription are different products, billed differently.

No subscription connection is built. `model_connection.auth_type` accepts `subscription`, but creation writes only `api_key`. A ChatGPT Plus or Pro connection could be offered later as an experiment through an authorized browser or device-code flow; OnCue would never ask for a password, copy cookies, or accept a pasted session token. Forwarding a subscription through the broker would mean holding and refreshing the user's OAuth tokens and reproducing the harness's subscription request path, and the terms exposure of that is why it sits outside the MVP.

OnCue connects Anthropic through API keys only. Whether a consumer subscription may be used with a third-party tool is a question for Anthropic's terms ([consumer terms](https://www.anthropic.com/legal/consumer-terms), [commercial terms](https://www.anthropic.com/legal/commercial-terms)), and the code cannot check it. Claude Code support is built but disabled and not installed in the image. We have not yet confirmed it fits Anthropic's terms for third-party products. Its adapter (record 04) routes through the broker like any other harness (`../roadmap.md`).

## Model connection record

`model_connection` (`apps/web/migrations/0003_model_connections.sql`) belongs to one workspace:

| Column | Meaning |
|---|---|
| `connection_id` | OnCue identifier |
| `workspace_id` | Owning workspace |
| `provider` | `anthropic` or `openai` (a CHECK constraint) |
| `auth_type` | `api_key` or `subscription` |
| `credential_reference` | The sealed credential envelope |
| `status` | `active`, `invalid`, `expired`, `revoked`, or `attention_required` |
| `provider_account_hint` | Non-secret label for the account |
| `expires_at` | Provider expiry, when one exists |
| `last_validated_at` | Last time the provider accepted the key: at connect or replace, and at each key check that passes |
| `created_at`, `updated_at` | Timestamps |

There is deliberately no model, default flag, or display name: the connection says which account, the run says which model (record 15), and the displayed name is derived from the provider and account hint (`apps/web/worker/broker/connections.ts`).

A create or replace validates the key against the live provider before any row is written, so a known-bad key is never stored and there is no transient "validating" status. The saved key is never shown again.

A workspace holds one key per provider: `POST /api/model-connections` answers 409 `already_connected` while a non-revoked key exists. `PUT /api/model-connections/:id` replaces the key under the same id, so sessions using it continue. `POST /api/model-connections/:id/revoke` revokes it. `POST /api/model-connections/:id/recheck` asks the provider about the stored key now (see "Key checks"). `GET /api/model-connections` lists them. The screen is Settings, Model providers (`apps/web/src/features/settings/ModelProvidersSection.tsx`): one card per provider with Connect, Re-check, Replace, and Revoke, where Revoke says how many active sessions still use the key (counted from `session_index.model_connection_id`, migration `0012_session_model_connection.sql`, which names the connection of the session's latest run and follows a change of model, record 15). Home and the session screen read the workspace's keys from `/api/me`, so every change made on this page refreshes that; otherwise Home would go on offering a key that was just revoked.

## Key checks

A key that validated when it was connected can stop working later: revoked at the provider, expired, or its account closed. A key check asks the provider about the stored key again with the adapter's `validate` (`GET /v1/models`, which costs nothing) and reduces the answer to one of three verdicts (`apps/web/worker/broker/key-check.ts`):

| Verdict | When | What is written |
|---|---|---|
| accepted | The provider answered the models list | `status` becomes `active` (from `active` or `invalid`) and `last_validated_at` moves |
| rejected | The provider answered `authentication_failed` (401 or 403) | An `active` connection becomes `invalid`; `last_validated_at` keeps the last good time |
| inconclusive | Anything else: a rate limit, a provider error, no route, or no answer within three seconds (`KEY_CHECK_TIMEOUT_MS`) | Nothing |

A check never throws and never outlasts its timeout, which aborts the request. Each write names the sealed value that was checked (`recordKeyVerdict` in `connections.ts`), so a verdict on a key that was replaced or revoked while the provider was being asked changes nothing.

Three things run a check:

- **Session creation** (`preflightModelKey` in `apps/web/worker/routes/sessions.ts`). After the request is admitted and before any `session_index` row or sandbox request, in parallel with the repository read. A rejected key refuses the create with 409 `model_key_rejected` (naming the provider and the connection), and Home says which provider rejected the key, keeps the draft, links to Settings, and reads the workspace's keys again. An inconclusive check starts the session anyway: an unreachable provider says nothing about the key. A key validated within the last ten minutes (`KEY_CHECK_FRESH_MS`) is not asked about, so a burst of sessions costs one provider call. The fake driver is never checked.
- **The forwarding path**, before it marks a connection invalid (see "Forwarding").
- **Settings, Re-check.** Answers `{ connection, check }` with `check` one of `accepted`, `rejected`, or `unreachable`. A revoked connection holds no key and answers 409 `revoked`; a sealed value that will not open answers 503 `broker_failure` rather than blaming the provider.

Nothing checks keys on a schedule.

## Credential storage

Credentials are never stored in plaintext in D1, R2, Durable Object storage, events, logs, or artifacts.

`apps/web/worker/broker/envelope.ts` seals a credential with AES-GCM under a key derived by HKDF from `ONCUE_BROKER_KEYRING`, a Worker secret listing key versions newest first. The newest seals; any listed version opens a value that names it, so rotation is prepending a key, not re-encrypting rows. Each value has a unique nonce and records its key version. The same secret derives, under a different purpose, the HMAC key that signs broker tokens, and the two keyrings are distinct types so one cannot be passed for the other.

The envelope binds its context as additional authenticated data: `connectionId|workspaceId|provider`, where "provider" is a discriminator per credential kind (a model provider, `github_user_token` or `github_refresh_token`, the Modal token, a development secret). A ciphertext moved to another row or presented as another kind fails in the authentication tag. Only five files outside tests import the envelope's `openCredential` (`apps/web/worker/broker/envelope.ts`): the broker's `forward.ts` and `key-check.ts` (the two places a model key exists in memory, each for one provider exchange, neither returning or logging it), `worker/github/install.ts`, `worker/modal/connections.ts` (inside `openModalCredential`), and `worker/secrets/store.ts`. Audit that set by what imports `openCredential` from the envelope module, not by grepping the bare name: the session object has a private method also named `openCredential`, a different function that opens the workspace's Modal pair by calling `openModalCredential`, and several comments mention the name.

Cloudflare Secrets Store and AI Gateway are not the per-user store, because their account-level limits and token scoping do not give a user-by-user boundary.

### The Modal credential

The Modal credential creates compute, which spends money for as long as it runs with no per-call ceiling. Modal offers scoped service users only on paid plans, so a user on the free plan connects a personal token with authority over their whole Modal workspace. Onboarding says what OnCue can do with it and recommends a dedicated Modal workspace (record 13). The credential never enters a sandbox: it is opened only in control-plane code (the Worker's routes and the session object, through `openModalCredential`), passed to the sandbox controller on the request that needs it, and never written to an event, log, artifact, or error.

## Model Broker

```text
harness in the sandbox
        |  loopback relay attaches a short-lived OnCue token
        v
OnCue Model Broker (Worker)
        |  user's decrypted provider key
        v
model provider
```

### Tokens

A broker token (`apps/web/worker/broker/tokens.ts`, format `ot1.`) is HMAC-signed and scoped to one session, one sandbox generation, one connection, one workspace, one model, and the run's effort. It is valid ten minutes (`TOKEN_TTL_MS`) and can be refreshed, but never past 24 hours from its first issue (`TOKEN_REFRESH_WINDOW_MS`), however often it is renewed. It is accepted nowhere except the broker's routes, so it cannot read sessions, repositories, artifacts, or other connections.

Tokens are signed rather than stored. Revocation needs no token table because every forward reads the connection row anyway: a revoked connection, or a generation at or below `session_index.ended_sandbox_generation` (written when the object revokes a generation's credentials, record 11), is refused on the next forward or refresh.

The object mints the token for the connection the run was recorded with and sends it as a `model` grant after the bridge's handshake (record 04). A later run in the same generation on another effort, model, or connection gets a fresh grant ahead of its `run.start`, since a token fixes all three (`planDispatch` in `apps/web/worker/session/dispatch.ts`). The relay keeps only the newest token. An earlier one is not revoked by name: it stays valid at the broker until it expires or its generation ends (`../backlog.md`). An owner-authenticated issue route (`POST /api/sessions/:id/broker-token`) exists, but the bridge does not use it.

### Forwarding

`POST /api/broker/sessions/:sessionId/v1/messages` is the one forwarding route (`forward.ts`). The broker verifies the token and that its session matches the path, reads the connection, refuses a body whose model is not the token's model, and writes the run's effort into the provider's own field (`output_config.effort` for Anthropic's Messages API, `reasoning.effort` for OpenAI's Responses API), refusing a body that names a different effort (`effort.ts`). Every refusal answers the same way. It then opens the key in memory, and the provider adapter (`providers/`) sets the credential header, pins the provider's API version, posts on the provider's own path (`/v1/messages` or `/v1/responses`), and streams the response back. Each adapter lists the extra request headers it passes upstream (`anthropic-beta` for Anthropic, none for OpenAI).

A provider that refuses a model request as unauthorized has not yet condemned the key: a key the provider still accepts may not be allowed that model or endpoint. So before anything is written the broker runs a key check with the key it already holds:

- **rejected:** the request is answered `authentication_failed` and the connection is marked `invalid`.
- **accepted:** the connection stays `active`, its `last_validated_at` moves, and the request is answered `model_unavailable`, which pauses that run alone (record 15).
- **inconclusive:** the request is answered `authentication_failed` and the connection is left alone. The run pauses; the next session's check, or Re-check, settles the key.

The check is in the response path, so it is bounded and cannot throw; the row is written outside it (`waitUntil`). Neither can turn the provider's clean refusal into a 502.

The broker records non-secret metadata and categorized failures. It does not keep the conversation; that stays with the session object and the harness.

### The relay

The harness reads its provider configuration once at start, so the bridge runs a loopback relay (`services/bridge/src/relay.ts`, `relay-server.ts`) that attaches the current token to each request. The agent may use the selected model through it but cannot read the token.

- It listens on `127.0.0.1` only and accepts two paths (`RELAY_REQUEST_PATHS`): `POST /v1/messages` and `POST /v1/responses`. Everything else is refused.
- It forwards only `content-type`, `accept`, `anthropic-version`, and `anthropic-beta`, drops any `authorization` or `x-api-key` the agent sent, and sets the bearer itself.
- It runs as the bridge's Unix user and holds the token in process memory, never in a file or an inherited environment variable. Record 02 chose Unix-user separation over a separate container; that is the weaker boundary, and the live credential-isolation test (test C) covers it.
- It refreshes on a timer at half the token's remaining life against `POST /api/broker/token/refresh`, keeps the current token when a refresh is refused, and reports every refused forward to the bridge by the broker's failure category so the run can pause (record 04).
- When the agent's client disconnects (a cancelled turn), it aborts the upstream request, so the provider stops generating what nobody will read and the user is not billed for it. It gives the broker five minutes to answer with headers and a streamed answer five minutes between bytes (`RELAY_HEADERS_TIMEOUT_MS`, `RELAY_IDLE_TIMEOUT_MS`), and a refresh thirty seconds.

Each harness points its provider at the relay with a placeholder key the relay discards: OpenCode through its Anthropic and OpenAI Responses clients, both declared whichever model it starts on, with every catalog model the grant lists, so a later run can be prompted on another model (record 15); Codex as a Responses provider with no OpenAI login (`requires_openai_auth = false`); Pi through OnCue's extension; Claude Code through `ANTHROPIC_BASE_URL`, started naming no effort so the broker writes the run's. Only OpenCode has run through the relay in a real sandbox.

## Why the permanent key stays outside the sandbox

Repository code and agent commands run in the sandbox. A permanent key in an environment variable there could be read and copied by either. A short-lived token scoped to one session, one generation, one connection, and one model limits what a sandbox compromise can take, and it is refused everywhere except the broker.

## Model selection

The Worker owns the catalog (`apps/web/worker/broker/providers/catalog.ts`): for each provider, model ids, display names, context windows, list prices as of `PRICES_AS_OF` with cache read and write prices as of `CACHE_PRICES_AS_OF` (the browser's cost estimate reads them), the effort levels each model documents, and the recommended row. A session's first `run.start` names a model and an effort from it. Session creation refuses a model the provider's catalog does not hold (`model_unavailable`) or an effort the model does not offer (`effort_unsupported`). Later runs keep the first run's model unless the owner changes it on the message that starts the next run, and the effort may change the same way (record 15). A change is checked against the same catalog, the same cost guard, and the workspace's own connection row. Each run records its provider, model, effort, connection, and harness version.

A local Worker can be pinned to certain models: `ONCUE_MODEL_ALLOWLIST`, honoured only when `ONCUE_ENV` is `local`, makes session creation refuse any other model with `model_not_allowed`, and the session object refuse a change to one (`apps/web/worker/broker/model-guard.ts`). `pnpm dev:live` sets it to the one model live testing may use. The hosted Worker ignores it.

OnCue never changes models or providers on its own (record 15).

### Prompt counts

For the context meter (record 13) the broker counts what an agent's call carries besides the conversation, exactly, with the provider's own counter and the session's own key (`apps/web/worker/broker/prompt-counts.ts`). Only Anthropic's is used: `POST /v1/messages/count_tokens`, which is free. OpenAI documents `POST /v1/responses/input_tokens`, but it has not been verified with a person's key, so OpenAI calls are not counted. Only a call that offers tools is counted, since one without (OpenCode's title request) is not the agent's turn. OnCue's tools are those named `oncue_*` (OpenCode, Codex, Pi) or `mcp__oncue__*` (Claude Code). Four counts, each with one minimal message, are made cumulatively so the parts add up: the message alone, with the system prompt, with the harness's tools, and with OnCue's `oncue_*` tools; each part is a difference, and the provider's tool-use preamble falls to the harness's tools. Counting never touches the request's path, and a body too deep to read is simply not counted: a forward answers at once with the `x-oncue-prompt-tokens` header carrying the prompt's key (16 hex characters of a SHA-256 of the prompt with its `cache_control` breakpoints removed) and the counts the isolate already holds, or a status, and starts the four counts with `waitUntil`, carrying the forward's `anthropic-beta`. Results are kept per isolate by that hash (at most 256 prompts, least recently used first out), so a prompt is counted once. A failure gives no counts, never a guess: the status stays `pending` after one failure and becomes `unavailable` after two, and the same prompt is not counted again for a minute. Two caps keep counting from using up a key's rate limit, which a person's sessions share: after the counter answers 429 the isolate counts nothing for that connection for a minute, and at most 10 distinct prompts are counted per session in 10 minutes; past either the status is `unavailable`. No prompt text is stored or logged, only hashes and integers. OpenCode 1.18.30 sends the injected `AGENTS.md` inside its one system block, after the environment and before the skills list with no end marker, so repository instructions are counted as part of the system prompt rather than split out on a guess.

## Failure behavior

- **Invalid key:** Once a key check confirms the rejection, mark the connection invalid and ask the user to replace it. At session creation this refuses the create before a sandbox exists; mid-run it pauses the run.
- **Unauthorized request on a key the provider still accepts:** Pause that run as `model_unavailable` and leave the connection active.
- **Provider limit reached:** Pause the run (`usage_limit_reached`) without trying another connection.
- **Provider outage or other temporary failure:** Left to the harness's own retries against the same selection; then the run pauses for the user.
- **Broker unavailable:** The session is preserved and the user can retry later.
- **Connection revoked during a run:** The next forward is refused.
- **Generation stopped, lost, or replaced:** Its token is refused on the next forward or refresh, through `session_index.ended_sandbox_generation`.

## Not built yet

- Subscription connections of any kind.
- A user-chosen connection name, and a default connection or model (the composer remembers the last choice per workspace in the browser).
- A scheduled key check, a check when a stopped session resumes, and a check of a connection's key before a model change runs on it (record 15): a key rejected since the session started is found by its first model request.
- A retry from a paused model failure (record 15). A paused model failure shows its category with no retry control.

## Conditions for reconsideration

Revisit if provider terms change, a harness changes its supported authentication, many users need enterprise provider accounts, or the broker becomes a latency or availability bottleneck. A platform-funded key would need its own billing, abuse, and quota design first.
