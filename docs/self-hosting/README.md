# Deploy your own OnCue

This guide takes you from a clone to a working deployment on your own
accounts. Nothing is shared with anyone else's deployment: your Worker, your
database, your sign-in, your GitHub App, your sandboxes.

> [!NOTE]
> The commands that belong to this repository are tested. The whole sequence
> has not yet been walked from start to finish on brand-new accounts, and the
> steps taken in a provider's dashboard are written from how OnCue uses that
> provider, not from a recorded run. If a step does not match what you see,
> please open an issue.

Related pages: the [settings reference](reference.md) lists every value, and
[operating a deployment](operations.md) covers updates, rotation, and what to
check when something does not work.

## What you need

Accounts:

| Account | What it runs | Cost to expect |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com) | The Worker, its Durable Objects, a D1 database, an R2 bucket | Runs on the free plan for one person. On the free plan a daily limit, once hit, blocks the whole account until the next day, so use Workers Paid before you let anyone else in. R2 has to be enabled on the account, which asks for a payment method. |
| [Clerk](https://clerk.com) | Sign-in | A development application is free. |
| [GitHub](https://github.com) | A GitHub App that reads and pushes to the repositories you choose | Free. |
| [Modal](https://modal.com) | The sandbox controller, and each user's sandboxes | The controller keeps one small container warm, a few dollars a month. Sandboxes bill to whichever Modal account each user connects. |

Each person who uses the deployment also brings a model provider key
(Anthropic or OpenAI) and a Modal token pair. Those are entered in the app,
not here.

On your machine: git, Node 24 with corepack, [uv](https://docs.astral.sh/uv/),
and `openssl`.

## The order, and why

The numbered sections below follow this order:

1. Prepare the repository.
2. Cloudflare resources and the deployment file.
3. A Clerk application.
4. Database migrations, then the first Worker deploy. This gives you the
   Worker's address, which the next two steps need. Nobody can sign in yet.
5. The sandbox controller on Modal, which is told the Worker's address.
6. A GitHub App, whose callback and webhook point at the Worker.
7. The Worker's secrets, including the controller's address.
8. Yourself on the allowlist.
9. First sign-in and the in-app setup.

Run every command from the repository root unless a step says otherwise.

## 1. Prepare the repository

```bash
git clone <your fork or the repository URL> oncue && cd oncue
```

```bash
corepack enable && pnpm install
```

```bash
pnpm check
```

`pnpm check` takes a few minutes. It proves the checkout works on your machine
and builds the bridge bundle that the controller's image copies in.

## 2. Create the Cloudflare resources

Sign in to Cloudflare from the command line:

```bash
pnpm --filter @oncue/web exec wrangler login
```

Create the database. Wrangler prints a `database_id`; keep it. If Wrangler
offers to add the database to a configuration file, answer no: the tracked
configuration describes the local environment only.

```bash
pnpm --filter @oncue/web exec wrangler d1 create oncue-hosted
```

Create the bucket for artifacts:

```bash
pnpm --filter @oncue/web exec wrangler r2 bucket create oncue-hosted-artifacts
```

Now describe your deployment. This file is gitignored and holds only public
values:

```bash
cp apps/web/deployment.example.json apps/web/deployment.json
```

Open `apps/web/deployment.json` and set `d1DatabaseId` to the id Wrangler
printed. Change the two names only if you created the resources under other
names. Leave the two Clerk fields for the next step.

## 3. Create the Clerk application

In the Clerk dashboard, create an application and choose the sign-in methods
you want. OnCue renders Clerk's sign-in and sign-up in its own page, so there
is nothing else to configure there.

A Clerk development application works on any address, including the
`workers.dev` address your Worker gets. A Clerk production application needs
a domain you own; serving OnCue from a custom domain has not been tested by
this project.

Copy the application's **publishable key** (`pk_test_…` or `pk_live_…`) into
`clerkPublishableKey` in `apps/web/deployment.json`. Then fetch the public key
the Worker verifies sessions with:

```bash
pnpm clerk:jwt-key --write
```

That reads the key from Clerk's public JWKS and saves it as `clerkJwtKey`. No
Clerk secret key is used anywhere in OnCue.

## 4. Migrate the database and deploy the Worker

Apply the migrations to your database:

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted d1 migrations apply DB --remote
```

Deploy:

```bash
ONCUE_ENV=hosted pnpm deploy:hosted
```

The deploy script runs `pnpm check` again, builds, verifies that the build is
the hosted one and binds your database, and deploys. Wrangler prints the
Worker's address, which looks like
`https://oncue-web-hosted.<your-subdomain>.workers.dev`. This guide calls it
`<worker-origin>`. Check it:

```bash
curl <worker-origin>/api/health
```

It must report `"env":"hosted"`. Opening the address in a browser shows the
sign-in page, and signing in shows "Your account is not enabled on this
OnCue.", because the allowlist is still empty.

## 5. Deploy the sandbox controller

Generate the token the Worker and the controller share, and keep it somewhere
safe:

```bash
node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))'
```

The next three commands run from `services/sandbox-controller`. Sign in to
Modal:

```bash
uv run modal setup
```

Create the one Modal Secret the controller reads. It holds the token and the
address sandboxes dial back to, which must be `https`:

```bash
uv run modal secret create oncue-controller-token ONCUE_CONTROLLER_TOKEN=<the token> ONCUE_CONTROL_PLANE_ORIGIN=<worker-origin>
```

Deploy the controller:

```bash
uv run modal deploy app.py::controller_app
```

Modal prints an address ending in `.modal.run`. This guide calls it
`<controller-origin>`; use it without a path or a trailing slash. Go back to
the repository root for the remaining steps.

The controller holds no Modal credential of its own. Every request from the
Worker carries the Modal token pair of the user it is acting for, and that
user's sandboxes are created in their own Modal workspace.

## 6. Create the GitHub App

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub
App**, under your user or an organization.

| Setting | Value |
|---|---|
| Homepage URL | `<worker-origin>` |
| Callback URL | `<worker-origin>/api/github/callback` |
| Request user authorization (OAuth) during installation | On. OnCue needs the code this sends back. |
| Expire user authorization tokens | On. OnCue refuses a token that comes without a refresh token. |
| Webhook | Active, URL `<worker-origin>/api/github/webhook`, with a secret you generate |
| Repository permissions | **Contents**: read and write. **Pull requests**: read and write. **Metadata**: read-only. Nothing else. |
| Subscribe to events | **Push** and **Pull request** |
| Where can this GitHub App be installed? | Only on this account if you are its only user; any account if other people will install it on theirs. |

Do not grant the Workflows permission. Without it GitHub refuses a push that
touches `.github/workflows`, which is the intended limit.

After creating the App, collect six values:

- the **App ID** and the **Client ID** from the App's page;
- the **slug**, the last part of the App's public address
  (`https://github.com/apps/<slug>`);
- a **client secret**, which you generate on the App's page;
- the **webhook secret** you chose;
- a **private key**, which you generate on the App's page and GitHub downloads
  as a `.pem` file.

GitHub issues the private key in a format the Worker cannot read. Convert it:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <downloaded>.pem -out github-app-key.pkcs8.pem
```

The converted file starts with `-----BEGIN PRIVATE KEY-----`. Keep both files
out of the repository, and delete them once the secret is set.

## 7. Set the Worker's secrets

Generate the keyring that seals stored credentials. Back it up: every stored
model key, GitHub token, and Modal token is sealed with it, and losing it
means every user reconnects everything.

```bash
node -e 'console.log("1:" + require("node:crypto").randomBytes(32).toString("base64url"))'
```

Set each secret with the command below. Wrangler asks for the value.

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted secret put <NAME>
```

| Name | Value |
|---|---|
| `ONCUE_BROKER_KEYRING` | the keyring line you just generated |
| `ONCUE_SANDBOX_CONTROLLER_ORIGIN` | `<controller-origin>` |
| `ONCUE_SANDBOX_CONTROLLER_TOKEN` | the token from step 5 |
| `ONCUE_GITHUB_APP_ID` | the App ID |
| `ONCUE_GITHUB_APP_SLUG` | the slug |
| `ONCUE_GITHUB_CLIENT_ID` | the Client ID |
| `ONCUE_GITHUB_CLIENT_SECRET` | the client secret |
| `ONCUE_GITHUB_WEBHOOK_SECRET` | the webhook secret |
| `ONCUE_GITHUB_APP_PRIVATE_KEY` | the converted key file |

The private key has many lines, so pipe the file in rather than pasting it,
giving the path to wherever you saved the converted key:

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted secret put ONCUE_GITHUB_APP_PRIVATE_KEY < github-app-key.pkcs8.pem
```

A secret takes effect as soon as it is set, and later deploys keep it.

Two of these stop you if you skip them. Without both controller values, or
with an origin that is not `https`, every new session is refused and Home says
the deployment has no working sandbox controller. Without the keyring, model
keys, GitHub, and Modal all report that they are unavailable.

## 8. Let yourself in

Open `<worker-origin>` and sign up. You will see the same "not enabled"
notice. In the Clerk dashboard, open **Users**, select yourself, and copy
the **User ID** (it starts with `user_`).

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted secret put ONCUE_USER_ALLOWLIST
```

Enter the id. For several people, separate the ids with commas. Reload the
page; the allowlist is re-read within a minute.

## 9. Finish in the app

The app walks you through three steps:

1. **Connect GitHub.** Install your App on the repositories OnCue may work
   in.
2. **Add a model provider key.** Anthropic or OpenAI. The key is checked
   against the provider before it is stored. If you skip this step, sessions
   run a scripted stand-in model instead of a real one.
3. **Connect Modal.** Create a token at
   <https://modal.com/settings/tokens> and paste its id and secret. The pair
   is tested before it is stored, and the sandbox image then builds in your
   Modal workspace, which can take several minutes the first time.

Start a session on a small repository and ask for a small change. You should
see the sandbox start, the agent work, a change card, and an offer to push and
open a draft pull request.

## What is not included

- **Previews of a running app** are not built. They need a second Worker on
  its own domain.
- **Operator tools.** There is no admin console. Stopping all new runs or
  removing a user is a manual step; see [operations](operations.md).
- **Other coding agents.** OpenCode is the only agent enabled by default; see
  `ONCUE_RUNTIME_ALLOWLIST` in the [reference](reference.md).
