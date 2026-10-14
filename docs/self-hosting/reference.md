# Settings reference

Every value a deployment has, and where it lives. The
[deployment guide](README.md) sets each of them in order.

## `apps/web/deployment.json`

Gitignored, public values only. An unknown field is refused, so a secret
cannot be left here by mistake. Copy it from `apps/web/deployment.example.json`.

| Field | Meaning |
|---|---|
| `d1DatabaseName` | The D1 database's name. |
| `d1DatabaseId` | The id `wrangler d1 create` printed. |
| `r2BucketName` | The R2 bucket for artifacts and attachments. |
| `clerkPublishableKey` | Your Clerk application's publishable key. It is built into the browser bundle. |
| `clerkJwtKey` | The public key the Worker verifies Clerk sessions with. `pnpm clerk:jwt-key --write` fills it in. |

`pnpm deploy:hosted` and `pnpm wrangler:hosted` join this file with the
tracked `apps/web/wrangler.jsonc` into the gitignored
`apps/web/wrangler.hosted.json`. The Worker is always named
`oncue-web-hosted`.

## Worker secrets

Set with `ONCUE_ENV=hosted pnpm wrangler:hosted secret put <NAME>`.

| Name | Required | What it is | If it is missing |
|---|---|---|---|
| `ONCUE_USER_ALLOWLIST` | yes | The Clerk user ids allowed in, separated by commas or new lines. | Nobody can sign in. |
| `ONCUE_BROKER_KEYRING` | yes | `<version>:<32 random bytes, base64url>`, newest first, comma-separated. Seals stored credentials and signs broker tokens. | Model keys, GitHub, and Modal are unavailable. |
| `ONCUE_SANDBOX_CONTROLLER_ORIGIN` | yes | The controller's `https://….modal.run` address, no path. | Every new session is refused with `controller_unconfigured`, and Home says the deployment has no working sandbox controller. A non-`https` origin counts as missing. |
| `ONCUE_SANDBOX_CONTROLLER_TOKEN` | yes | The token shared with the controller. It grants no Modal authority. | The same. |
| `ONCUE_GITHUB_APP_ID` | yes | The GitHub App's id. | GitHub cannot be connected. |
| `ONCUE_GITHUB_APP_SLUG` | yes | The App's slug, from its public address. | The same. |
| `ONCUE_GITHUB_APP_PRIVATE_KEY` | yes | The App's private key as PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`). | The same. An unconverted key is reported as malformed. |
| `ONCUE_GITHUB_CLIENT_ID` | yes | The App's OAuth client id. | The same. |
| `ONCUE_GITHUB_CLIENT_SECRET` | yes | The App's OAuth client secret. | The same. |
| `ONCUE_GITHUB_WEBHOOK_SECRET` | yes | Verifies each webhook's signature. | Webhooks are refused. |
| `ONCUE_RUNTIME_ALLOWLIST` | no | The coding agents users may choose, comma-separated, for example `opencode,codex`. Only OpenCode and Codex are installed in the sandbox image; OnCue refuses any other name, including `pi` and `claude`. | OpenCode alone. |

The Worker also gets three plain values the deploy writes for you: `ONCUE_ENV`
(`hosted`), `ONCUE_RELEASE` (the commit), and `CLERK_JWT_KEY` (from the
deployment file).

Settings named `ONCUE_PROVIDER_DOUBLE_ORIGIN`, `ONCUE_GITHUB_API_ORIGIN`,
`ONCUE_MODEL_ALLOWLIST`, `ONCUE_IDLE_ALARM_SECONDS`, `ONCUE_CEILING_SECONDS`,
and `ONCUE_APPROVAL_TTL_SECONDS` exist for local development. A hosted Worker
ignores them.

## The controller's Modal Secret

One Modal Secret, named `oncue-controller-token`, in the Modal workspace that
runs the controller.

| Key | Value |
|---|---|
| `ONCUE_CONTROLLER_TOKEN` | The same token as the Worker's `ONCUE_SANDBOX_CONTROLLER_TOKEN`. Without it the controller refuses every request. |
| `ONCUE_CONTROL_PLANE_ORIGIN` | The Worker's `https` address. Each sandbox's bridge dials it. |

## The GitHub App

| Setting | Value |
|---|---|
| Callback URL | `<worker-origin>/api/github/callback` |
| Webhook URL | `<worker-origin>/api/github/webhook` |
| Request user authorization (OAuth) during installation | On |
| Expire user authorization tokens | On |
| Repository permissions | Contents: read and write. Pull requests: read and write. Metadata: read-only. |
| Events | Push, Pull request |

## Coding agents

| Agent | Works with | State |
|---|---|---|
| OpenCode | Anthropic, OpenAI | Default, and the only one enabled when `ONCUE_RUNTIME_ALLOWLIST` is unset. |
| Codex | OpenAI | In the sandbox image but off by default. It has not been run in a real Modal sandbox. |
| Pi, Claude Code | | Not in the sandbox image. OnCue refuses them even if the allowlist names them, and Settings does not list them. |

## Models

The models users can choose are a fixed list in
`apps/web/worker/broker/providers/catalog.ts`. A session's model is fixed when
its first run starts.
