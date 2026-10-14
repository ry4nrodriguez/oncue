# Security

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Please do not open a
public issue for it.

Include what you found, how to reproduce it, and what an attacker gains. If
the problem depends on a particular deployment setting, say which.

Fixes are published to `main` here. There are no maintained release branches,
so the latest `main` is the only supported version.

## What OnCue protects

OnCue runs a coding agent on a repository it does not trust, in a sandbox, on
behalf of a signed-in user. The design assumes that repository code,
dependencies, agent commands, and previews are hostile. These are the
boundaries it is built to hold, and a way through any of them is a
vulnerability:

- **Authorization stays in the control plane.** Every decision about who may
  see or change a session is made in the Worker, never in the browser, the
  sandbox, or the model.
- **Permanent credentials stay out of sandboxes.** A user's model provider
  key, their Modal token pair, the GitHub App's private key, and Clerk's keys
  never enter a sandbox. Model traffic goes through the Model Broker, and git
  pushes use short-lived installation tokens narrowed to one repository.
- **The bridge is separate from the agent.** Inside a sandbox, the bridge runs
  as its own Unix user and holds the session's short-lived tokens. The agent's
  user cannot read them.
- **A session's work goes to one branch.** OnCue refuses to start a session
  on, or push to, a repository's default branch or a protected branch, and the
  bridge pushes only to the session's own branch.
- **Workspaces are private.** One user's sessions, secrets, and artifacts are
  not readable by another user.

The architecture records in `docs/architecture/` describe each boundary; start
with records 05, 06, 07, and 09.

## Known limits

These are design limits, documented so that you can weigh them. They are not
vulnerabilities to report, though a way to make one worse is.

- **The bridge and the agent share a container.** They are separated by Unix
  users, not by a second container. That is defence in depth, and weaker than
  container isolation. Everything below that says "the bridge" rests on it.
- **The push token is not tied to one branch.** GitHub's installation tokens
  cannot name a branch, so the token the bridge holds could push to any
  unprotected branch of that one repository. The single-branch rule is the
  bridge's own check. Protect your default branch on GitHub.
- **The sandbox can reach the public internet.** Outbound HTTPS to any host is
  allowed, so code in the sandbox can send out anything it can read: the
  repository, and any development secret you attach to the session.
- **Development secrets are readable inside the sandbox.** A secret you make
  available to a session is available to the agent and to every command it
  runs. Attach only what the task needs.
- **Redaction is best effort.** OnCue removes the exact values of the
  credentials it knows from events, logs, and artifacts. An encoded, split, or
  transformed value passes. Redaction reduces accidental exposure; it is not a
  boundary.
- **Permission prompts are cooperative.** Approvals govern what the agent
  chooses to do. They are not what contains it; the sandbox is.
- **Checks are evidence, not proof.** Verification results are reported from
  inside the sandbox, by the code under test's own environment. Read them as a
  reviewer would.
- **A Modal token acts for a whole Modal workspace.** On Modal's free plan the
  token pair a user connects is not scoped, and the controller and whoever
  operates it handle it on every request. A dedicated Modal workspace is the
  safer choice.
- **Network isolation is the sandbox provider's.** A sandbox's network policy
  is enforced by Modal. Record 09 says which behaviour has been observed on a
  live sandbox and which is unverified.
- **There are no operator tools.** No admin console stops another user's
  session, disables an account, or keeps an audit trail, and the
  concurrent-sandbox limits are not enforced. Removing a user from the
  allowlist does not close a session they already have open.
- **The local development tunnel exposes the dev server.** `pnpm controller`
  opens a public tunnel to your local dev server so a real sandbox can reach
  it. While it is up, anyone who has the tunnel's address can use the local
  sign-in at `/dev/sign-in`. Use it only with accounts you can afford to
  expose, and stop it when you are done.
- **You operate your own deployment.** OnCue is self-hosted. Whoever deploys
  it holds its Cloudflare account, its GitHub App's private key, the keyring
  that seals stored credentials, and the list of users allowed to sign in.
  Protecting those is the operator's job.

## If you run OnCue

- Keep the user allowlist narrow. Anyone on it can start sandboxes and spend
  their own connected accounts' credit.
- Never put a secret in `apps/web/deployment.json` or any tracked file. Set
  secrets with `ONCUE_ENV=hosted pnpm wrangler:hosted secret put <NAME>`.
- Keep the broker keyring backed up and private. It seals every stored model
  key and Modal token; losing it makes them unreadable, and leaking it exposes
  them.
- After changing the sandbox image, its entrypoint, or the users inside it,
  re-run the bridge isolation test (`services/sandbox-controller/scripts/test_c_probe.py`)
  on a sandbox from the new image.
