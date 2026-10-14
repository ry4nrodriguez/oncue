# Observability and operational debugging

**Status:** Approved foundation; partly built

## Purpose

Operators need enough evidence to explain failures across the browser, control plane, Model Broker, GitHub integration, and sandbox, without turning prompts, code, secrets, or tool output into logs. Today OnCue has structured Worker logs and little else; metrics, traces, error reporting, dashboards, and alerts are not built.

## Key decisions

- Log fields come from an allowlist. A field is emitted only if the log definition permits it; later redaction is not relied on.
- Logs carry identifiers and categories, never content: no credentials, cookies, development secrets, messages, prompts, model responses, file contents, diffs, raw terminal output, screenshots, review text, or signed URLs.
- Metrics and traces, when added, follow OpenTelemetry conventions, and Sentry is the planned error reporter.
- Product history and operational telemetry stay separate. The session's event log (record 03) is durable, workspace-scoped product data; telemetry is operator-only with short retention, and neither substitutes for the other.

## What is built

### Worker structured logs

`log` in `apps/web/worker/log.ts` writes one JSON line per call through `console.log`. The allowed fields are timestamp, severity, service, release, environment, region, request id, trace id, session id, run id, sandbox generation, delivery id, operation, result, duration, retry count, error category, and provider, plus four integers only the Model Broker writes: input, output, cache-read, and cache-write tokens. The type rejects any other field at compile time and the function throws on one at run time.

| Service | Operations logged |
| --- | --- |
| `web-worker` | `api.health`, `api.sessions.create`, `api.secret_requests.read`, `api.session_file.read`, `github.install` |
| `model-broker` | `broker.forward`, with provider and failure category (record 15); `broker.forward.usage` once an answer's last byte has passed, with the provider's usage counters read out of the stream in the provider's own meaning (Anthropic counts the cache apart from input, OpenAI inside it; `broker/stream-usage.ts`), so the bridge's token figures can be checked against the provider's. Numbers only, never content. The prompt counts the broker makes for the context meter (record 06) are not logged |
| `github-webhook` | Signature checks and deliveries; `github.incident.foreign_push` at severity `error` when the GitHub App itself pushes to a ref outside every session branch (records 07 and 22) |
| `session-object` | Provisioning, ingest, outcome refusals, attachments, generation opening, grants, branch naming, pull-request publishing, and redactor rebuilds |

`release` and `environment` come from `ONCUE_RELEASE` and `ONCUE_ENV`. `pnpm deploy:hosted` sets them to the short commit hash and `hosted`.

### Cloudflare configuration

`apps/web/wrangler.jsonc` enables Workers Logs (`observability.enabled`, `head_sampling_rate: 1`), inherited by the hosted environment, so every hosted log line persists in Cloudflare's dashboard. Locally the lines appear in the dev server's output; `wrangler tail` streams them from a deployed Worker. Workers tracing is not configured.

### Health and release

`GET /api/health` returns `env`, `release`, and whether provider traffic is redirected to a stand-in, so an operator can confirm which build is live.

### Sandbox controller

`services/sandbox-controller/app.py` logs one line per failed provider operation with the operation, result, error category, whether it is retryable, and a fixed message, and no identifiers beyond those.

### Bridge and supervisor

The bridge and the root supervisor write plain-text lines to the sandbox's standard output (`services/bridge/src/main.ts`, `services/bridge/src/supervisor.ts`), not the structured format, and OnCue does not collect them.

### User-visible diagnostics

The session screen shows product-safe failure detail from committed events: a failed run's stage and message, a paused model failure's category in plain words (record 15), a refused completion claim's warnings (record 14), and the sandbox's lifecycle rows (record 13). No diagnostic identifier is shown that an operator could look up.

## Limits

- Nothing generates or propagates request or trace ids, so the `requestId` and `traceId` fields are never set and a request cannot be followed from the Worker into the session object, the controller, or the sandbox.
- Bridge and supervisor output is unstructured and is not collected.
- Log retention is Cloudflare's Workers Logs retention for the account's plan; OnCue sets none. The design target of 30 days for operational telemetry is not configured anywhere.
- There is no audited operator path to a user's session content. An operator debugging a report has the logs above and nothing else.

## Not built yet

See `../roadmap.md`.

- **Metrics** with bounded labels (never user, session, or repository ids, messages, or paths): request and event-commit latency and errors, sandbox start and readiness, bridge disconnects, model failures and token usage, verification outcomes, projection delay, upload failures, and webhook delay.
- **Traces** for session creation, sandbox startup, an agent turn, a model request, a GitHub operation, and an artifact upload, with context passed in explicit headers between trusted services only. Workers' native tracing is the intended latency source, because Sentry's server-side spans on Workers report zero duration (a provider behavior not tested here).
- **Error reports** to Sentry with release and route, stripped of request bodies, credentials, cookies, authorization headers, model content, tool output, and code. Expected outcomes, such as a failing user test, are not errors.
- **Dashboards and alerts** for session reliability, sandbox startup, broker failures, projection health, webhooks, and errors by release, with a time window and minimum volume so one expected error pages no one.
- **Structured bridge logs** and a short diagnostic id in the session screen that an operator can correlate with telemetry.

Recording full sessions for replay, storing prompts or code in telemetry, customer dashboards, billing metering, SIEM integration, automated remediation, and a long-term analytics warehouse are out of scope.
