# Operating a deployment

## Updating

Pull the new revision and run `pnpm install`. Then, in this order:

1. **Migrations**, if `apps/web/migrations/` gained files:

   ```bash
   ONCUE_ENV=hosted pnpm wrangler:hosted d1 migrations apply DB --remote
   ```

2. **The controller**, if anything under `services/sandbox-controller` or
   `services/bridge` changed. From the repository root, `pnpm check` (or
   `pnpm --filter @oncue/bridge build`) rebuilds the bridge bundle the image
   copies; then, from `services/sandbox-controller`:

   ```bash
   uv run modal deploy app.py::controller_app
   ```

3. **The Worker**:

   ```bash
   ONCUE_ENV=hosted pnpm deploy:hosted
   ```

The controller goes before the Worker because a newer controller serves an
older Worker, and not the other way round. `curl <worker-origin>/api/health`
reports the release that is live.

After a change to the sandbox image, its entrypoint, or the Unix users inside
it, re-run the bridge isolation test on a sandbox built from the new image. Start
a session, take its sandbox id from the session's Modal panel, and from
`services/sandbox-controller` run
`uv run python scripts/test_c_probe.py <sandbox-id> > results.json`. It exits
with an error if any check fails.

## Who can sign in

Change `ONCUE_USER_ALLOWLIST` with `secret put`. Adding someone takes effect
within a minute.

Anyone can create an account in your Clerk application; the allowlist is what
lets them in. You can also restrict sign-ups in the Clerk dashboard.

To remove someone, change the secret and then advance the allowlist version,
which makes every Worker instance re-read the list:

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted d1 execute DB --remote --command "UPDATE platform_control SET allowlist_version = allowlist_version + 1 WHERE id = 1"
```

Removal blocks their next request. It does not close a session they already
have open in a browser, stop a sandbox that is running, or delete what they
stored. Their sandboxes run in their own Modal account, where they stop at
the idle limit.

## Stopping all new runs

There is no admin console. To stop new runs across the deployment:

```bash
ONCUE_ENV=hosted pnpm wrangler:hosted d1 execute DB --remote --command "UPDATE platform_control SET run_admission = 'stopped' WHERE id = 1"
```

Set it back to `'open'` to resume. This does not stop sandboxes that are
already running; each user stops their own from the session.

## Rotating secrets

- **Broker keyring.** Put a new entry with a new version number in front and
  keep the old entries: `2:<new key>,1:<old key>`. New values are sealed with
  the first entry, and existing ones still open with theirs. Removing an old
  entry makes everything sealed with it unreadable.
- **Controller token.** Update the Modal Secret, redeploy the controller so
  its container starts with the new value
  (`uv run modal deploy app.py::controller_app`), then set the Worker's
  `ONCUE_SANDBOX_CONTROLLER_TOKEN`. Between the last two steps new sandboxes
  fail to start.
- **GitHub App private key or client secret.** Generate a new one on the App's
  page, convert a new private key to PKCS#8, and set the secret again.
- **Clerk's signing key.** If Clerk rotates it, run
  `pnpm clerk:jwt-key --write` and deploy the Worker.

## When something does not work

| What you see | Likely cause |
|---|---|
| "Your account is not enabled on this OnCue." | Your Clerk user id is not in `ONCUE_USER_ALLOWLIST`, or the migrations have not been applied. Without the `platform_control` row nobody is let in. |
| Every request is treated as signed out | `clerkJwtKey` does not belong to the Clerk application whose publishable key was built in. Both come from `deployment.json`; run `pnpm clerk:jwt-key --write` and deploy. |
| Connecting GitHub fails immediately | One of the six GitHub values or the keyring is missing, or the private key was not converted to PKCS#8. |
| GitHub sends you back with "wasn't completed" | The App is missing "Request user authorization (OAuth) during installation", or its callback URL is not `<worker-origin>/api/github/callback`. |
| Pushes and pull requests never show up in a session | The webhook URL or secret is wrong, or the App is not subscribed to Push and Pull request. |
| Connecting Modal says the controller is unavailable | `ONCUE_SANDBOX_CONTROLLER_ORIGIN` or `_TOKEN` is missing on the Worker, or the keyring is. |
| Home says "This deployment has no working sandbox controller" | `ONCUE_SANDBOX_CONTROLLER_ORIGIN` or `_TOKEN` is missing on the Worker, or the origin is not `https`. |
| Home says "Add a model key in Settings before starting a session." | The workspace has no active model key. A hosted Worker never runs the scripted model; add a key under Model providers. |
| A sandbox never gets past "Starting" | The Modal Secret's `ONCUE_CONTROL_PLANE_ORIGIN` is not the Worker's `https` address (fix the Secret, then redeploy the controller), the bridge bundle was not built before the controller was deployed, or the image is still building in that user's Modal workspace. |
| Uploads and artifacts fail | The R2 bucket named in `deployment.json` does not exist. |

Worker logs are in the Cloudflare dashboard under the Worker's
**Observability** tab. Every line carries the environment and the release.

## Running it locally against real services

The repository guide, [AGENTS.md](../../AGENTS.md), describes the local modes.
`pnpm dev` needs no accounts. `pnpm dev:real` runs the local server against
your own Clerk application, GitHub App, and controller. It needs
`VITE_CLERK_PUBLISHABLE_KEY=<your key>` in `apps/web/.env.local`, and a file
you write yourself, `apps/web/.dev.vars.real`, holding the same names as the
Worker secrets in the [reference](reference.md) plus `CLERK_JWT_KEY` (which
`pnpm clerk:jwt-key` prints), one `NAME=value` per line. Both files are
gitignored.
