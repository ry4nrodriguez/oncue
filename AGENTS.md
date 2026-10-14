# OnCue Repository Guide

## Purpose

OnCue is a cloud-first background agent platform. The MVP runs software-development work in remote sandboxes and is designed to support other kinds of work later.

Keep this file short and current. Detailed technical decisions belong in `docs/architecture/`; dated history belongs in `docs/history.md`.

## Before you change anything

- Read `docs/architecture/README.md` and `docs/architecture/00-architecture-overview.md` before a structural decision, and the numbered record for any component you change. The records are authoritative.
- Read `docs/architecture/01-control-plane.md`, "Read cost", before touching the session Durable Object's hot paths or its exchange with the bridge. Every per-frame or per-rearm read needs an index and a bound, and every loop with the bridge is bounded on the object's side. `apps/web/worker/session/session-read-cost.test.ts` holds the budget.
- `docs/roadmap.md` lists planned work that is not built; `docs/backlog.md` lists known open defects and gaps. Add a new finding to the backlog rather than widening an unrelated change.
- `docs/decisions.md` records why things are the way they are. Check it before reversing a decision.

## Approved MVP foundations

- Coding is the first work profile.
- The product is a browser application with cloud-first remote execution.
- The frontend lives in `apps/web` and uses React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and Base UI. Vercel AI Elements supplies session-timeline component source. OnCue does not import the Vercel AI SDK; it is installed only as a peer of the `agents` package.
- Cloudflare Workers, Durable Objects, D1, and R2 form the control and data plane.
- Modal provides remote sandboxes. The coding runtime runs behind a harness adapter in the bridge; OpenCode is the only runtime enabled by default, and others are enabled per deployment with `ONCUE_RUNTIME_ALLOWLIST` (`apps/web/worker/runtime/resolve.ts`).
- Clerk provides authentication. Hosted access uses an operator-managed allowlist.
- Each user has one private workspace. Shared workspaces are deferred.
- GitHub integration uses a GitHub App and one task branch per session.
- Users bring their own model credentials. Permanent provider credentials stay outside sandboxes.
- Users bring their own sandbox compute. Each workspace connects its own Modal account, sandboxes run and bill there, and the control plane holds the sealed per-workspace Modal credential.
- The bridge is isolated from the coding agent by Unix-user separation inside one container. This is defence in depth within one container, weaker than a separate container, and chosen because Modal sidecars are not available to arbitrary user workspaces.

## Scope discipline

- Build only the MVP described in `docs/architecture/21-mvp-scope-and-completion-boundary.md`.
- Do not introduce deferred systems such as billing, shared workspaces, production-data access, multiple source-control providers, a general admin console, or a vector database.
- Do not silently change an approved foundation. Explain the trade-off and update the affected architecture record in the same change, after the maintainer approves.
- Prefer the smallest design that preserves the documented security and recovery boundaries.

## Repository layout

- `apps/web/`: browser application, Worker control plane, D1 migrations (`migrations/`), and the Playwright suite (`e2e/`).
- `packages/protocol/`: the wire protocol shared by the bridge, the session object, and the browser, with its generated fixtures.
- `services/bridge/`: the in-sandbox bridge, root supervisor, harness adapters, and Model Broker relay, bundled into the sandbox image.
- `services/sandbox-controller/`: the Python Modal application that manages sandbox lifecycle and builds the sandbox image. `scripts/test_c_probe.py` runs the bridge-isolation test against a live sandbox; `scripts/build_sandbox_image.py` pre-builds the image in the operator's workspace (each user's workspace is prepared by the controller's `prepareImage`, record 02).
- `scripts/`: root command scripts (`check.mjs`, `dev.mjs`, `controller.mjs`, `deploy-hosted.mjs`, and others).
- `docs/architecture/`: the architecture records. `docs/self-hosting/`: the guide to deploying your own copy. `docs/history.md`, `docs/decisions.md`, `docs/roadmap.md`, `docs/backlog.md`: history, decision log, planned work, open issues.

Add a package-level `AGENTS.md` only when a package needs instructions that differ from this file. The closest guide takes precedence.

## Development workflow

1. Read the relevant architecture and implementation before editing.
2. Preserve user changes and keep unrelated edits out of the task.
3. State important assumptions when repository evidence is incomplete.
4. Make small, reviewable changes with explicit boundaries.
5. Add or update automated tests with implementation changes.
6. Run the relevant checks and read their full output.
7. Summarize changed files, verification evidence, and remaining risks.

## Commands

Use pnpm 10 through corepack and Node 24. Run from the repository root.

Several checkouts can run a local stack side by side, each on its own port slot: `ONCUE_PORT_SLOT=N`, a whole number from 0 to 19 (default 0; any other value stops the command with a plain error). Slot N uses app (Vite and the Worker) `5173 + 100·N`, sandbox controller (double or `pnpm controller`) `5197 + 100·N`, GitHub double `5198 + 100·N`, provider double `5199 + 100·N`, and Worker inspector `9229 + N`; slot 0 is the original layout. Give every command for one stack the same slot (`ONCUE_PORT_SLOT=3 pnpm dev`, `ONCUE_PORT_SLOT=3 node apps/web/e2e/setup-local-auth.mjs`, `ONCUE_PORT_SLOT=3 pnpm test:e2e`, `ONCUE_PORT_SLOT=3 pnpm controller`), and stop only your own slot's ports. `scripts/dev-ports.mjs` holds the formula. The real App's install flow (`pnpm dev:real`, `pnpm dev:live`) returns to the App's registered callback URL on port 5173, so it finishes only on slot 0; on another slot, `ONCUE_PORT_SLOT=N pnpm --filter @oncue/web exec tsx scripts/seed-local.ts --real-github-repo <owner>/<name>` writes the installation and repository rows instead (`apps/web/scripts/real-github-seed.ts`).

- `pnpm install` installs the whole workspace.
- `pnpm dev` starts a working app with no accounts and no cost. It composes `apps/web/.dev.vars` from the test fixtures, applies local migrations, builds the bridge bundle, starts the three doubles (GitHub on 5198, the model provider on 5199, the sandbox controller on 5197, on slot 0), seeds a workspace with everything connected, starts the dev server, and prints `http://localhost:5173/dev/sign-in` (the slot's app port). Sessions run the real bridge bundle in a local process spawned by the controller double. It sets `ONCUE_IDLE_ALARM_SECONDS=45`, so an idle local sandbox checkpoints and stops after 45 seconds and the next message resumes it. `ONCUE_IDLE_ALARM_SECONDS` and `ONCUE_CEILING_SECONDS` are honored only when `ONCUE_ENV` is `local`.
- `pnpm dev` and its doubles need no Clerk application. No Clerk key is tracked, and with none configured the dev server stands in for Clerk's browser SDK (`apps/web/vite-plugins/clerk-stand-in.ts`, `apps/web/src/dev/clerk-stand-in.tsx`): `/dev/sign-in` mints the session cookie, the Worker verifies it as it verifies Clerk's, and "Sign out" goes to `/dev/sign-out`. Put your own `VITE_CLERK_PUBLISHABLE_KEY` in the gitignored `apps/web/.env.local` and the real SDK is used instead.
- `pnpm dev:fresh` is `pnpm dev` with a new subject that has no rows, for walking the three setup steps. The GitHub double serves the App's install page.
- `pnpm dev:modal` runs the GitHub and provider doubles and seeds your real Modal token pair from `~/.modal.toml`; run `pnpm controller` beside it for real sandboxes.
- `pnpm dev:real` composes `.dev.vars` from `apps/web/.dev.vars.real` and starts only the dev server: real Clerk sign-in, real GitHub, and whatever controller that file names. It refuses to start without a publishable key in `apps/web/.env.local`. `pnpm dev:real --local-controller` points it at the local controller on the slot's controller port (5197 on slot 0) instead; you sign in and complete setup yourself, and every session creates a real Modal sandbox.
- `pnpm dev:live` uses `.dev.vars.real` with the local controller and no doubles, and signs in through `/dev/sign-in` instead of Clerk. It seeds your Modal pair from `~/.modal.toml` and your provider key from the macOS keychain item named by `ONCUE_LIVE_MODEL_KEY_SERVICE`. The GitHub App's callback URL must point at the tunnel `pnpm controller` opens. Every session is a real Modal sandbox that spends real credit; an idle sandbox stops after the object's default 20 minutes.
- `pnpm controller` serves the real Python sandbox controller locally with uvicorn on the slot's controller port (5197 on slot 0), using the controller token from `.dev.vars`. A sandbox's bridge dials `ONCUE_CONTROL_PLANE_ORIGIN`, which must be an https origin the sandbox can reach; if it is unset, the script opens a `cloudflared` quick tunnel to the slot's local dev server. `pnpm controller --dry-run` prints the port and tunnel target and exits without building or serving. It builds the sandbox image before serving. Restart it after any bridge change, because the image is what sandboxes run. Running it spends real Modal credit, which needs the authorization of whoever pays for it.
- `pnpm build` builds the client and Worker bundles, then fails if the bundle contains the dev inspector, a dev harness, or anything shaped like a secret.
- `pnpm check` runs Biome, the typechecker, Vitest, the bridge bundle build, the controller's pytest suite (needs `uv` on PATH), the actor-boundary checker, the record checker, and the fixture checker, in that order, stopping at the first failure. The bridge build comes before the controller because the controller's image copies `services/bridge/dist/bridge.mjs`; a controller deployed without it starts cleanly and can create no sandbox.
- `pnpm test` runs the Vitest suites in every package.
- `pnpm test:e2e` runs the Playwright suite against the dev server at two workers by default (`pnpm test:e2e --workers=N` to change it). Run `node apps/web/e2e/setup-local-auth.mjs` first, with the same `ONCUE_PORT_SLOT`, so `.dev.vars` is the test composition for that slot. With no Clerk key configured the suite runs against the stand-in, and the four tests that inspect Clerk's own form are skipped; with your own key in `apps/web/.env.local` they run too. Every test reaches the local D1 through the dev server's binding (`apps/web/e2e/local-d1.ts`), and a run refuses to start when the server on its slot's app port belongs to another checkout. After the `chromium` project, the projects that share the doubles run one at a time, in a chain. The first of them, `walkthrough`, walks the full user path against the doubles and a real OpenCode: setup, a task, verified checks, the review panel, a draft pull request after the user allows the push, an idle stop with a pushed checkpoint, resume on a new generation, and "Run checks".
- `pnpm test:perf` runs the perf test alone on one worker; it measures paint time and cannot share workers.
- `pnpm format` and `pnpm lint` run Biome; `pnpm typecheck` typechecks every package.
- `pnpm db:migrate:local` applies D1 migrations to the local database.
- `pnpm check-records` fails when the state machines or event list in `packages/protocol` disagree with records 01, 04, 11, and 12. `pnpm check-fixtures` parses every protocol fixture through the real schemas.
- `pnpm bench` measures protocol parse throughput against the floor in record 23.
- `pnpm deploy:hosted` deploys the hosted Worker (see Deployment).
- `pnpm wrangler:hosted <command>` runs a Wrangler command against the hosted deployment, for migrations, secrets, and reads (see Deployment).
- `pnpm clerk:jwt-key` prints the PEM for `CLERK_JWT_KEY` from Clerk's public JWKS, for `.dev.vars.real`; `pnpm clerk:jwt-key --write` saves it into `apps/web/deployment.json`. Run it when a deployment is first set up and again only if Clerk rotates that key.

## Local configuration

Local configuration is three gitignored files under `apps/web/`, plus `.env.local` if you use your own Clerk application (above). `.dev.vars.real` holds your real values (Clerk public key, allowlist, GitHub App, hosted controller) and no script writes to it. `.dev.vars.lane` holds the test fixtures `e2e/setup-local-auth.mjs` generates, reusing the secrets it finds so saved rows stay readable. `.dev.vars` is generated from one of those two by `scripts/dev-vars.mjs` on every `pnpm dev*` run and by the setup script. Never edit `.dev.vars` by hand; the next run overwrites it.

Miniflare and `wrangler types` both read `.dev.vars`. A test that forgets a setting can silently pick up a real credential, so `apps/web/vitest.config.ts` blanks every `ONCUE_GITHUB_*` and `ONCUE_SANDBOX_CONTROLLER_*` binding. The generated `Env` type on a developer machine can also hide a type error a clean machine would report.

## Testing and verification

- Follow `docs/architecture/23-comprehensive-automated-testing.md`.
- Cover every supported requirement and meaningful failure path. Give security, isolation, credential, state-transition, and deletion logic complete branch coverage.
- Use unit tests for local logic, integration tests for boundaries, and end-to-end tests for user-critical flows.
- A double replaces an external service and never does our own code's work. The moment a double does something our code is supposed to do, it hides bugs instead of finding them. This is why the controller double runs the real bridge bundle.
- Do not replace required live-provider tests with mocks.
- A pull request is merged on local evidence, recorded in its description, whether or not a workflow also ran. Before a merge, check as a clean machine would: move `.dev.vars` aside, rerun `wrangler types`, delete `apps/web/*.tsbuildinfo`, run `pnpm check`, then restore `.dev.vars` and run `pnpm test:e2e` and `pnpm test:perf`.
- Any change to the sandbox image, its entrypoint, the supervisor, the bridge bundle, or the Unix users inside the image requires re-running test C (the bridge-isolation test) on a real sandbox from that image with `services/sandbox-controller/scripts/test_c_probe.py`. Do not present Modal network or bridge-isolation behavior as proven beyond what `docs/history.md` records.
- Stored records must stay readable: a new field on a persisted shape is optional and defaults to the old behavior.
- If a required check cannot run, say why and do not call the result verified. Never claim a check passed that was not run.

## Deployment

Nothing deploys on merge. Each step is deliberate and done only when the user asks.

- A deployment's own values: the tracked `apps/web/wrangler.jsonc` describes the local environment only. The hosted D1 database, R2 bucket, and Clerk application are named in the gitignored `apps/web/deployment.json` (template: `apps/web/deployment.example.json`), which holds public values only; secrets are Wrangler secrets. `apps/web/scripts/hosted-config.mjs` joins the two into the gitignored `apps/web/wrangler.hosted.json`. Never put a deployment's values in a tracked file.
- The hosted Worker: `ONCUE_ENV=hosted pnpm deploy:hosted`, from a machine with `apps/web/deployment.json` filled in and Cloudflare access (`wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). It refuses an incomplete deployment file, runs `pnpm check`, builds from the generated config with `CLOUDFLARE_ENV=hosted`, refuses if the built config is not `ONCUE_ENV=hosted` or does not bind the deployment file's database, runs the bundle guards, and deploys with the commit as `ONCUE_RELEASE`. `/api/health` reports the deployed release. It does not deploy the controller or apply migrations.
- D1 migrations: number a new migration after the highest file in `apps/web/migrations/`. Apply migrations to the hosted database by hand with `ONCUE_ENV=hosted pnpm wrangler:hosted d1 migrations apply DB --remote` before deploying a Worker that needs them. Read the hosted `d1_migrations` table to see what is applied. Never edit a migration that has been applied.
- Hosted secrets: `ONCUE_ENV=hosted pnpm wrangler:hosted secret put <NAME>`. A bare `wrangler --env hosted` finds no such environment, because it exists only in the generated config.
- The sandbox controller: `uv run modal deploy app.py::controller_app` from `services/sandbox-controller`, before a Worker that depends on it; `scripts/build_sandbox_image.py` pre-builds the image in the operator's workspace. A changed image means a test C re-run.

Naming rule: every root script targets local resources unless its name ends in `:hosted`. A `:hosted` script refuses to run unless `ONCUE_ENV=hosted` is set, and otherwise exits 1 with `refusing: ONCUE_ENV is not hosted`.

## Plan-step ids

`PR-01` through `PR-16` are plan-step ids, not GitHub pull request numbers; the two sequences drift. D1 migrations and `docs/history.md` cite plan-step ids. Write `GitHub #N` when you mean a pull request, never a bare `PR #N`. Keep plan-step ids, GitHub numbers, dates, and backlog ids out of code comments.

## Code guidelines

- Use TypeScript strict mode.
- Keep modules focused and interfaces explicit.
- Validate data at browser, webhook, provider, and sandbox trust boundaries.
- Keep authorization decisions in the trusted control plane, never in the browser or the model.
- Treat repository code, dependencies, agent commands, and previews as untrusted.
- Keep provider-specific behavior behind the documented adapter boundaries.
- Use durable identifiers and idempotency for retried external operations.
- Write comments that explain why, in one or two plain sentences. No process history in comments.
- Follow the repository's formatter and linter (Biome).

## Security rules

- Never commit credentials, access tokens, cookies, private keys, `.env` files, a deployment's `apps/web/deployment.json`, or production data.
- Never print secrets in logs, test output, session events, or artifacts.
- Do not place permanent model, GitHub, Clerk, or infrastructure credentials in a sandbox.
- Use least-privilege, short-lived credentials and revoke them when the architecture requires it.
- Keep previews on the separate authenticated preview origin.
- Production credentials and production-data access are unavailable in the MVP.
- Do not weaken network, authorization, preview, or bridge isolation to make a test pass.
- Live provider work that can spend money or create external resources requires the explicit authorization of whoever pays for it.

## Git and external actions

- Do not commit, push, open a pull request, merge, deploy, or change an external service unless the user asks.
- Changes land through pull requests, one branch from current `main` per change. Never push directly to a protected or base branch. [CONTRIBUTING.md](CONTRIBUTING.md) says how an outside contributor proposes a change and how it lands.
- A pull request's description records what ran: the local checks with their results, any live test with what it exercised, and anything that did not run. After a merge, deploy, or live verification, add a dated entry to `docs/history.md`.
- Do not force-push or rewrite shared history.
- Do not discard unrelated or user-authored working-tree changes.
- Prefer non-destructive, reversible operations, and report any external resource created or changed.

## Documentation

- Use clear, direct language and define uncommon terms.
- Update links and dependent records when moving or deleting documentation.
- Record unresolved provider behavior as unverified and name the test needed to resolve it.
- When something ships, is deployed, or is verified live, add a dated entry to `docs/history.md`. Record a significant decision in `docs/decisions.md`.
