# Minimal MVP Deployment

**Status:** Approved foundation

## Purpose

This record covers where OnCue runs and how a change reaches the hosted environment. The MVP uses two environments, local development and one shared hosted environment, and no release-management system beyond a guarded manual deploy.

## Decisions

- Developers work locally against test doubles or dedicated test resources. Early users reach one shared hosted environment. There is no staging environment.
- The browser application and the control plane run on Cloudflare (Workers, Durable Objects, D1, R2). The browser application is built from `apps/web` with Vite and the Cloudflare Vite plugin (record 24).
- Sandboxes run on Modal, in each user's own Modal workspace (record 02). The sandbox controller is the only Modal application OnCue itself deploys.
- Production customer data, production application credentials, and production infrastructure access are not available in any environment.
- A deploy is a deliberate, manual act. Nothing deploys on a merge.

Why: a small group of users does not justify staging, promotion, or canary infrastructure, and a manual deploy behind automated guards is the smallest path that keeps a broken or mis-configured build off the internet.

## Environments

### Local

`pnpm dev` and its variants compose the gitignored `apps/web/.dev.vars`, apply local D1 migrations, and run the Vite dev server with the Worker in the local Workers runtime. By default GitHub, the model provider, and the sandbox controller are local doubles; other modes swap in the real GitHub App, real Modal through `pnpm controller`, or a real model key. `AGENTS.md` lists each mode and what it spends.

The tracked `apps/web/wrangler.jsonc` is the local configuration and nothing else: `ONCUE_ENV` is the literal `local`, D1 has a placeholder id, R2 a local bucket, and `CLERK_JWT_KEY` is blank because `.dev.vars` supplies it. Test-double origins (`ONCUE_PROVIDER_DOUBLE_ORIGIN`, `ONCUE_GITHUB_API_ORIGIN`), the idle and ceiling timers, and the live-test model guard (`ONCUE_MODEL_ALLOWLIST`) are honored only when `ONCUE_ENV` is `local`.

Every root script targets local resources unless its name ends in `:hosted`, and a `:hosted` script exits 1 with `refusing: ONCUE_ENV is not hosted` unless `ONCUE_ENV=hosted` is set. Hosted data is otherwise reached only by an explicit `ONCUE_ENV=hosted pnpm wrangler:hosted … --remote` command.

### Hosted

No tracked file names a deployment. Whoever deploys describes their own in the gitignored `apps/web/deployment.json` (copied from the tracked `apps/web/deployment.example.json`): the D1 database's name and id, the R2 bucket's name, and the Clerk application's publishable key and JWKS public key. Every value in it is public by construction, an unknown field is refused, and secrets never go there. `apps/web/scripts/hosted-config.mjs` joins that file with the tracked config into the gitignored `apps/web/wrangler.hosted.json`, which is the tracked config plus an `env.hosted` block. A deployment therefore never edits a tracked file, and pulling a new revision never conflicts with it.

The hosted environment is that generated `env.hosted` block, deployed as the Worker `oncue-web-hosted`: the static client (single-page-application fallback, with `/api/*` and `/ws/*` routed to the Worker first), the Worker and its Model Broker and GitHub routes, the `SessionObject` Durable Object namespace, the hosted D1 database and R2 bucket, a five-minute cron that sweeps sessions stuck in `creating` (record 03), and Workers Logs (record 18). Wrangler does not inherit `vars` or bindings into a named environment, so the generator restates them, copying the Durable Object binding, its migrations, and the cron trigger from the tracked config so the two cannot drift (`apps/web/scripts/wrangler-config.test.mjs`).

Outside Cloudflare it depends on a Clerk application, a GitHub App whose callback and webhook URLs point at the hosted Worker, and the sandbox controller in the operator's Modal workspace.

## Configuration and secrets

| Value | Where it is set |
|---|---|
| `ONCUE_ENV`, `ONCUE_RELEASE` placeholder | written by `apps/web/scripts/hosted-config.mjs` |
| D1 database name and id, R2 bucket name, `CLERK_JWT_KEY` (a public key) | `apps/web/deployment.json` |
| `ONCUE_USER_ALLOWLIST`, `ONCUE_BROKER_KEYRING` (record 06), the six `ONCUE_GITHUB_*` App values, `ONCUE_SANDBOX_CONTROLLER_ORIGIN` and `_TOKEN`, `ONCUE_RUNTIME_ALLOWLIST` (unset allows OpenCode alone) | `ONCUE_ENV=hosted pnpm wrangler:hosted secret put <NAME>` |
| `VITE_CLERK_PUBLISHABLE_KEY` (public; inlined at build time) | `clerkPublishableKey` in `apps/web/deployment.json`, which the deploy script passes to the build |
| Controller token on the Modal side (`ONCUE_CONTROLLER_TOKEN`), and the Worker's public https origin that each sandbox's bridge dials (`ONCUE_CONTROL_PLANE_ORIGIN`) | the Modal Secret `oncue-controller-token` in the operator's Modal workspace |

`ONCUE_USER_ALLOWLIST` is deliberately absent from `vars`: a var of the same name would overwrite the secret on every deploy. `pnpm clerk:jwt-key --write` fetches `CLERK_JWT_KEY` from the Clerk application the publishable key names and saves it in the deployment file; it is run once at setup and again only if Clerk rotates its key. The client's publishable key and the Worker's verification key come from the same file, so they cannot name different Clerk applications. The run-admission switch and sandbox caps live in the D1 `platform_control` row, not in configuration (record 22). User model keys, Modal token pairs, and development secrets are sealed in D1 under the broker keyring (records 06 and 08), and none of these values reaches a sandbox.

Every Worker log line carries `environment` and `release`; `GET /api/health` returns both.

## Deploying

### The hosted Worker

`ONCUE_ENV=hosted pnpm deploy:hosted` runs `scripts/deploy-hosted.mjs`. Cloudflare access comes from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` or from `wrangler login`. The script:

1. Refuses unless `ONCUE_ENV=hosted` is set and `apps/web/deployment.json` is complete, naming every problem with the file at once, and writes `apps/web/wrangler.hosted.json`.
2. Runs `pnpm check` (record 23).
3. Builds with `CLOUDFLARE_ENV=hosted` and `ONCUE_WRANGLER_CONFIG` naming the generated config, which `apps/web/vite.config.ts` hands to the Cloudflare Vite plugin; the plugin selects the environment at build time and emits a config flattened to it.
4. Refuses if the built `apps/web/dist/oncue_web/wrangler.json` does not say `ONCUE_ENV=hosted` or binds any database other than the deployment file's. A hosted Worker that believed it was local would honor the test-double overrides, and a stale build from another deployment file would bind someone else's data.
5. Runs the three bundle guards `pnpm build` ends in: no dev inspector route, no dev harness, no secret or `.dev.vars` in the served files.
6. Runs `wrangler deploy` with `ONCUE_RELEASE` set to the short commit hash.

It does not run `pnpm test:e2e` or `pnpm test:perf`, and it does not apply D1 migrations. The operator applies those by hand with `ONCUE_ENV=hosted pnpm wrangler:hosted d1 migrations apply DB --remote` before a deploy that needs them. `pnpm wrangler:hosted` (`scripts/wrangler-hosted.mjs`) regenerates the hosted config and runs the given Wrangler command with `--env hosted --config apps/web/wrangler.hosted.json`; it refuses `deploy`, and refuses a caller's own `--env` or `--config`.

### The sandbox controller

From `services/sandbox-controller`, after `pnpm check` has built `services/bridge/dist/bridge.mjs` (the image copies it), the operator runs `uv run modal deploy app.py::controller_app` under the Modal profile that owns the controller. This publishes the controller's ASGI app with one warm container (`min_containers=1`); its origin is the Worker's `ONCUE_SANDBOX_CONTROLLER_ORIGIN`. The controller holds no Modal credential of its own: each request carries the calling workspace's Modal token pair, which the Worker opens from its sealed copy, and the sandbox is created in that workspace.

Modal caches an image per workspace, and every user's sandboxes run in their own, so a new image is built once in each user's workspace. The controller does that in `prepareImage`, apart from any create: the Worker asks for it when a workspace connects Modal and on the first `GET /api/me` after a Worker release (or six hours), and every provisioning waits for it, for up to 12 minutes, before it creates (record 02, "Images and startup"). A controller deploy needs no pre-build for users. `uv run --frozen python scripts/build_sandbox_image.py`, from the same directory and under the same Modal profile, still pre-builds the image in the operator's own workspace.

The Worker calls `/v1/prepareImage` and sends `notAfter` with each create, which an older controller refuses as an unknown route and an unknown field. So when both change, deploy the controller first, then the Worker; a newer controller serves an older Worker unchanged.

A controller deploy that changes the sandbox image, its entrypoint, or the users inside it requires a test C re-run on a sandbox from the new image (record 23).

### GitHub Actions

`.github/workflows/check.yml` defines one job, `check`, and no deploy job: a deploy needs the gitignored deployment file and is a deliberate act from an operator's machine. The workflow needs no secret and deploys nothing.

## Request path

```text
Browser
  -> Cloudflare Worker (static assets, API, WebSockets)
       -> Session Durable Object
       -> D1 and R2
       -> GitHub App
       -> Model Broker -> the user's model provider
       -> Sandbox controller on Modal -> sandbox in the user's Modal workspace
```

The browser signs in with Clerk directly; the Worker verifies Clerk session tokens locally against `CLERK_JWT_KEY` without calling Clerk. The sandbox's bridge dials back to the Worker over a WebSocket (record 04). Raw sandbox ports are not exposed.

## Failure behavior

- **A mis-configured build:** `deploy:hosted` refuses before `wrangler deploy`.
- **A missing binding or secret:** the affected operation fails rather than falling back, with two exceptions that fail soft. Without both controller values, sessions run on the built-in fake sandbox driver (`selectSandboxDriver` in `apps/web/worker/sandbox/select.ts`), so a deployment missing them looks as if it works; and a workspace with no model connection runs the scripted stand-in model. Everything else fails: with no allowlist nobody signs in; with no R2 binding the artifact routes answer `503 artifact_storage_unavailable`; a controller with no token refuses every request (`check_controller_token` in `services/sandbox-controller/app.py`).
- **A controller image without the bridge bundle:** every create fails with `image_preparation`. `pnpm check` builds the bundle so a deploy that follows it has one.

## Not built yet

- A hosted smoke or end-to-end suite, and an acceptance gate that marks a deploy usable (`../roadmap.md`).
- Deploying the controller, applying migrations, and checking the hosted stack from one command.
- Sentry or OpenTelemetry export (record 18).
- The separate preview site and Cloudflare Access on an operator endpoint (records 09 and 22; `../roadmap.md`).

## Deferred

Staging, per-change preview environments, promotion, canary or blue-green releases, automated rollback, multi-region deployment, customer production environments, and a formal schema-migration and rollback program.

## Conditions for reconsideration

Revisit when more than a small group depends on OnCue, when changes need testing against representative hosted data, or when deploy frequency makes staging or rollback worth building.
