# Comprehensive Automated Testing

**Status:** Approved foundation

## Purpose

OnCue coordinates identity, private source code, credentials, distributed session state, remote code execution, and external services, so manual checking alone cannot give enough confidence. This record defines what must be tested, at which layer, what runs today, and and the verification rules every change follows. GitHub Actions runs `pnpm check` and the end-to-end suite on every pull request (`.github/workflows/check.yml`); live tests run by hand.

"Full coverage" means every supported behavior and safety requirement has an automated test that proves it. It does not mean assertions written only to raise a percentage.

## Decisions

- Every requirement in record 21 maps to one or more automated tests.
- Every component boundary has contract coverage.
- Every supported browser workflow has an end-to-end test.
- Failure, retry, reconnect, cancellation, and recovery paths are automated.
- Authorization, isolation, credential, network, and deletion logic get complete branch coverage.
- Required live-provider tests are never replaced with mocks.
- A failing or flaky required test blocks a merge and a deploy.

## Coverage model

**Requirement coverage** is the authoritative measure: a requirement is covered only when a test proves the visible or security-relevant behavior, not an internal detail. A requirement-to-test index is not built yet.

**Branch coverage** must be complete for authentication and workspace authorization, permission and approval policy, session and run state transitions, model and GitHub credential brokerage, sandbox authorization, network policy, emergency controls, retention and deletion decisions, and secret redaction. Unreachable defensive branches are justified, not silently excluded.

**Source coverage** percentages reveal untested code; they support the two measures above and never replace them. The gates in force:

| Package | Floor | 100 percent on lines, functions, branches, and statements |
|---|---|---|
| `apps/web` (`vitest.config.ts`, istanbul; `worker/**` and `src/**`) | 80 percent | `worker/auth`, `worker/policy`, `worker/session`, `worker/broker`, `worker/sandbox`, `worker/modal`, `worker/secrets`, `worker/deletion`, `worker/github`, `worker/artifacts`, `worker/attachments`, and the protocol's `src/redact*` |
| `packages/protocol` (`vitest.config.ts`, v8) | 80 percent | `src/redact*` |
| `services/bridge` (`vitest.config.ts`, v8) | 80 percent | `redaction.ts`, `secrets.ts`, `secret-names.ts`, `supervisor-protocol.ts`, `checkpoint.ts` |
| `services/sandbox-controller` (`pyproject.toml`, branch coverage) | 95 percent | none; the uncovered remainder is Modal-only wiring the fakes replace |

The `worker/deletion` gate covers the session deletion job and its ownership checks. Every package's `test` script runs `vitest run --coverage`, so the gates apply on every `pnpm check`.

## Test layers

### Unit and integration

Unit tests are deterministic: no real network, clock, randomness, or credential unless replaced by a controlled abstraction. The Worker suite runs in the Workers runtime through `@cloudflare/vitest-pool-workers`, with real D1 migrations and Durable Objects: routing with Clerk identity claims, session objects and their SQLite transactions, projections to D1, R2 artifact authorization, the Model Broker, the sandbox driver and bridge protocol, and GitHub webhook verification and deduplication. `apps/web/vitest.config.ts` generates a fresh broker keyring per run and blanks every `ONCUE_GITHUB_*`, `ONCUE_SANDBOX_CONTROLLER_*`, approval-TTL, and runtime-allowlist binding, so a developer's `.dev.vars` cannot make a test pass with a real credential or drive real Modal.

### Contract

Each external adapter and internal boundary has a contract suite: Clerk tokens, GitHub App APIs and webhooks, model provider streaming and errors, bridge events and commands, and the sandbox controller's HTTPS interface. `pnpm check-fixtures` parses every protocol fixture through the real schemas and admission function. Fixtures contain no credentials or private content.

The sandbox controller's pytest suite covers authentication, the sandbox specification (network policy and user separation), idempotent creation, provider-error translation, and that no credential reaches a response or log line. Its Modal fakes are bound to the installed SDK's signatures and the SDK is pinned exactly (`modal==1.5.5`), so an upgrade is a re-test. Signature conformance is not behavior: what the network policy actually blocks only a live test can settle.

### Browser end-to-end

`pnpm test:e2e` covers allowlisted admission and blocked identities, workspace authorization, GitHub, model, and Modal setup, session creation, streaming and reconnect, follow-ups, approvals, stop, idle shutdown and resume, diff and verification review, chat-controlled commit, push, and draft pull request, and accessibility (an axe scan).

### Live infrastructure

Doubles make broad coverage fast, but cannot prove that real providers still behave. Live tests exercise real Modal, the real GitHub App, and a real model: sandbox creation, commands, checkpoint, stop and replacement, and the draft pull-request workflow. They run by hand on `pnpm dev:live` with `pnpm controller`, or against the hosted stack. Every live test that touches Modal or a model spends real money and needs the operator's authorization and spending cap. Live tests use one inexpensive model unless the operator chooses others; `pnpm dev:live` pins it through `ONCUE_MODEL_ALLOWLIST`.

## Verification rules

These hold for every change, whether or not GitHub Actions runs `.github/workflows/check.yml` on it.

### Before a merge

Run, locally, and record the results:

1. `pnpm check`: Biome, the TypeScript typechecker, every package's Vitest suite with its coverage gate, the bridge bundle build, the sandbox controller's pytest suite (needs `uv`; fails rather than skips without it), the actor-boundary checker, `check-records`, and `check-fixtures`, stopping at the first failure (`scripts/check.mjs`).
2. `pnpm test:e2e`.
3. `pnpm test:perf`.

Check as a clean machine would: move `apps/web/.dev.vars` aside, rerun `wrangler types`, delete `apps/web/*.tsbuildinfo`, run `pnpm check`, then restore `.dev.vars` for the end-to-end suites. Miniflare and `wrangler types` both read `.dev.vars`, so a developer copy can hide a type error or a missing test setting.

A pre-commit hook runs Biome on staged files and a staged-secret scan (`.husky/pre-commit`, `apps/web/scripts/check-staged-secrets.mjs`).

### Doubles never cover for our own code

A double replaces an external service and never performs a step OnCue's own code is supposed to perform. The sandbox controller double (`apps/web/e2e/sandbox-controller-double.ts`) spawns the real bridge bundle from `services/bridge/dist/bridge.mjs`, which runs a real OpenCode, so the walkthrough exercises the same bridge a Modal sandbox runs. A double that sends an event on the real component's behalf stops finding bugs and starts hiding them.

Clerk's browser SDK is stood in for on the same terms. No Clerk key is tracked, and with none configured the dev server resolves `@clerk/react` to `apps/web/src/dev/clerk-stand-in.tsx` (`apps/web/vite-plugins/clerk-stand-in.ts`). The gate, the screens, `/dev/sign-in`'s signed session cookie, and the Worker's verification of it are OnCue's own and run unchanged. The four browser tests that inspect Clerk's own form (its theming in both themes, and the loading screen held by delaying Clerk's script) run only when a developer has put their own publishable key in `apps/web/.env.local`, and report themselves skipped otherwise, so a fresh clone needs no Clerk application and those four are not covered there.

### Test C after any image change

Any change to the sandbox image, its entrypoint, or the Unix users inside it requires re-running test C, the bridge-isolation test, on a live sandbox from the changed image before the change is trusted. Run `services/sandbox-controller/scripts/test_c_probe.py <sandbox-id>` under the Modal profile that owns the sandbox; add `--secret NAME` when the session was supplied a development secret so the secret probes run. The script exits 1 when any probe differs from what isolation requires. A version bump of anything the image carries counts as a change.

### Throughput floors

- `pnpm bench` (`packages/protocol/scripts/bench.ts`) fails if `parseEvent` validates fewer than 50,000 event envelopes per second.
- `pnpm --filter @oncue/bridge bench` (`services/bridge/scripts/bench-normalize.ts`) replays an OpenCode session through the bridge's wire parser and normalizer and fails below 10,000 events per second.

Neither runs inside `pnpm check`; run them when changing the protocol schemas or the normalizer.

## What runs today

- **`pnpm test:e2e`** (`apps/web/e2e/playwright.config.ts`, through `apps/web/scripts/playwright.mjs`) starts `pnpm dev` with its three doubles and runs Chromium projects in order: `chromium` (every lane except those below and the perf lane, on two workers by default; `--workers=N` changes it), then `walkthrough`, `forged` (the session object refuses a forged `run.verified`), `attachments`, `status-dots`, `resume-review`, `codex` (skips itself without a local `codex` binary), `bridge-drops` (the controller double cuts one session's bridge link ten times and leaves it half-open once, through a TCP proxy it owns, and the session keeps its sandbox and every timeline row), `subagents` (a real OpenCode starting subagents against the provider double's `subagents` mode), and `model-switch` (the owner changes model between two runs: the same sandbox and the same OpenCode conversation move from the double's Anthropic arm to its OpenAI arm, and after the idle stop a change back starts on a new sandbox; record 15), each alone because it reseeds shared doubles. `branch-choice`, `controller-timing`, `delete-archive`, `model-key-checks`, and `rejected-key` follow in the same chain for the same reason. The dev server and every double use the ports of the slot `ONCUE_PORT_SLOT` names (`scripts/dev-ports.mjs`; 5173, 5197, 5198, and 5199 on slot 0), so suites from different checkouts can run at once on different slots. A global setup refuses to run when the server on the slot's app port belongs to another checkout (`e2e/same-checkout.ts`). Lanes reach the local D1 through the dev server's own binding (`e2e/local-d1.ts`). Run `node apps/web/e2e/setup-local-auth.mjs` first, with the same slot, so `.dev.vars` holds the lane composition for it.
- **`pnpm test:perf`** runs `e2e/perf.spec.ts` alone on one worker: first timeline paint with 500 events under 400 ms, under five percent dropped frames while streaming 200 deltas, the review panel on a 3,000-line diff under 500 ms, and Model Broker overhead under 40 ms per request.
- **Live tests** run by hand with authorization; `../history.md` records what ran and when.

## Required end-to-end scenarios

The complete suite proves at minimum:

1. An allowlisted user reaches a private workspace, a non-allowlisted identity is rejected before workspace creation, and neither reaches another user's resources.
2. Connecting GitHub, a model, and Modal exposes no permanent credential to the sandbox.
3. A task provisions an isolated sandbox and streams durable progress.
4. Reconnect replays committed events without duplication.
5. The agent changes code, runs checks, and produces reviewable evidence.
6. The user's Git instructions control commit, push, and draft pull-request timing.
7. Sandbox shutdown and replacement preserve the session and checkpointed work.
8. Model and infrastructure failures produce the right retry, blocked, or failed behavior.
9. Approval-protected actions cannot run before approval.
10. Admission stop, targeted termination, and credential revocation are enforced.
11. Session deletion removes OnCue-owned content without touching GitHub.
12. A complete hosted workflow produces a verified result and a draft pull request.

Scenario 10 is covered only for what record 22 has built. Scenario 11 is covered locally by `worker/deletion/job.test.ts` and the `delete-archive` end-to-end project (in the chain after `model-switch`), not yet on hosted; scenario 12 waits on a hosted suite. Part of scenario 8, a model key the provider rejects, is covered by the last two projects in the chain. `model-key-checks`: Home refuses the session before anything is created and keeps the draft, Settings' Re-check restores the key once the provider accepts it, and a key revoked and replaced in Settings is the one Home sends without a reload. `rejected-key`, with `worker/session/session-lifecycle.test.ts` and `session-resume.test.ts`: when the rejection comes mid-run the sandbox checkpoints and stops at once, Continue is refused until the key is replaced, and the same run then resumes on a new sandbox (records 11 and 15).

## Security and isolation suite

The suite must include adversarial tests that try to read another user's resources, reuse a short-lived token across sessions or generations, extract long-lived credentials from the sandbox, reach metadata or private addresses, bypass approval through chat, tool output, or repository content, leak secrets into logs or events, traverse artifact keys, replay webhooks or commands, delete more than authorized, and keep using a revoked connection. A manual checklist does not substitute.

Some properties depend on the provider and can only be proven live:

- **The Modal network policy** against the full matrix (HTTPS, TLS on other ports, HTTP, raw TCP, UDP, DNS, RFC 1918 and link-local ranges, `169.254.169.254`, public Modal tunnels, public OnCue endpoints), telling a network block apart from an authentication refusal. This is test A; it has passed (record 09).
- **Bridge isolation** (test C): the agent user cannot read the bridge's files, environment, or memory, cannot escalate, cannot attach to the bridge, cannot find the credential sentinel in `/proc`, logs, or crash output, and cannot write anything root runs; with `--secret`, a supplied development secret is readable by the agent alone and appears nowhere else. It has passed on every image it was run against, but some image changes have not had their re-run yet (record 02, `../backlog.md`).
- A spoofed installation id cannot be linked to a workspace; removing a GitHub authorization, installation, or repository disables later work; a bridge Git token is narrowed to one repository and permission and revoked afterwards.

The on-change suite covers these at the decision level (for example that the driver always sets the intended network policy), which does not by itself prove isolation.

## Failure injection

Deterministic fault injection must cover restarts, WebSocket loss, duplicate, delayed, and out-of-order events, sandbox failure and termination, model timeouts, rate limits, and bad credentials, projection delay, interrupted uploads, and GitHub webhook duplication and access removal. Tests assert both the recovery and what the user sees.

## Test data and credentials

Test resources are isolated from real ones, live credentials belong to dedicated test accounts with the narrowest access, and cleanup targets exact identifiers and never broadens after a failure. Test-double overrides are honored only when `ONCUE_ENV` is `local`, and the dev sign-in and harnesses live in dev-server plugins that the build guards refuse to ship (record 20).

## Flaky tests

A flaky required test is a failing test. Retries may gather diagnostics but never turn an unstable test into a pass.

## Testability rules

Time, randomness, identifiers, and retries are injectable; providers sit behind narrow adapters; state machines and policy decisions are testable without a sandbox; event builders and validators are shared by tests and runtime (`packages/protocol/src/testing`).

## Not built yet

- Hosted smoke and end-to-end tests, a scheduled live suite, and the deploy gate that requires them.
- The requirement-to-test index and its validation.
- Cross-browser runs; every lane runs in Chromium.
- Preview isolation tests, because previews do not exist.

`../roadmap.md` holds the plan for these.

## Deferred

Large model benchmarks, a dedicated agent-evaluation platform, paid continuous load testing, high-traffic performance testing, and customer-authored test policies.

## Conditions for reconsideration

Expand this when new work profiles, source-control providers, shared workspaces, browsers, or environments are supported. Requirements may become stricter; a change may not silently remove automated proof of an existing behavior.
