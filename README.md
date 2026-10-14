# OnCue

OnCue is a background coding agent you run yourself. You give it a task in the
browser, it works in a remote sandbox on a branch of your repository, and it
comes back with a diff to review, the checks it ran, and a draft pull request.
You can close the tab while it works.

There is no hosted OnCue to sign up for. You deploy your own copy on your own
accounts, and every bill (compute, model usage) goes to accounts you control.

> [!NOTE]
> OnCue is a work in progress, and I'm actively adding features. It is
> developed in a separate repository and published here in regular updates.

## What you get

- **Sessions that outlive the tab.** Each session is a durable object in the
  control plane. The agent keeps working when you leave, and the timeline
  replays when you return.
- **Your own sandbox compute.** Sandboxes run in your Modal account. An idle
  sandbox checkpoints its work to the session's branch and stops; the next
  message resumes it.
- **Your own model keys.** You connect a provider key in the app. It is sealed
  in the control plane and never enters a sandbox; model traffic goes through
  a broker.
- **One branch per session.** OnCue pushes a session's work to its own branch,
  never to the default branch or a protected one, through a GitHub App, and
  opens a draft pull request when you allow the push.
- **Review before you merge.** A change card after each turn, a diff panel
  beside the chat, and the checks the agent ran with their results.
- **Permission prompts.** The agent asks before it does something outside the
  permissions you set. These steer the agent; the sandbox is what contains it
  ([SECURITY.md](SECURITY.md) lists the limits).

## How it fits together

```
browser ──▶ Cloudflare Worker ──▶ session Durable Object ──▶ sandbox controller ──▶ Modal sandbox
            (auth, API, broker)    (one per session)         (Python, on Modal)     (bridge + agent)
                 │                                                                        │
                 ├── D1 (workspaces, sessions, sealed credentials)                        │
                 ├── R2 (artifacts)                                                       │
                 └── Model Broker ◀──────────── model requests, no provider key ──────────┘
```

- `apps/web` is the browser application and the Worker control plane.
- `services/sandbox-controller` is a small Python service on Modal that
  creates and stops sandboxes.
- `services/bridge` runs inside each sandbox beside the coding agent and
  relays its events to the session.
- `packages/protocol` is the wire protocol the three share.

The coding agent is [OpenCode](https://opencode.ai) by default. Clerk handles
sign-in, and an allowlist you manage decides who gets in.

## Try it locally

This runs the whole application on your machine with stand-ins for GitHub, the
model provider, and the sandbox provider. It needs no accounts and costs
nothing. Sessions run the real bridge and a real OpenCode in a local process,
as your own user with no sandbox around them, against a scripted model.

You need macOS or Linux, git, Node 24, [corepack](https://nodejs.org/api/corepack.html)
(ships with Node), and OpenCode:

```bash
curl -fsSL https://opencode.ai/install | VERSION=1.18.30 bash
```

Then:

```bash
git clone https://github.com/ry4nrodriguez/oncue.git
```

```bash
cd oncue
```

```bash
corepack enable
```

```bash
pnpm install
```

```bash
pnpm dev
```

The first run asks to apply the local database migrations; answer yes. Open
the address it prints (`http://localhost:5173/dev/sign-in`). You land in a
workspace with everything already connected. `pnpm dev:fresh` starts from an
empty account instead, so you can walk the setup steps.

A few things behave differently from a real deployment:

- The stand-in model gives every message the same short scripted answer
  ("chunk-0 chunk-1 chunk-2") and changes no files. To see a real edit, switch
  it before you send a message:

  ```bash
  curl -X POST http://127.0.0.1:5199/__mode -d '{"mode":"edit_file"}'
  ```

  It then writes `health.txt` on every message until you post
  `{"mode":"ok"}`. The other modes are listed in
  `apps/web/worker/test/provider-double.ts`.
- An idle session stops after 45 seconds rather than 20 minutes, so you can
  watch a checkpoint and a resume. The next message starts it again.
- `/dev/sign-in` signs you in with no password. Keep the dev server on
  localhost: don't use the dev server's tunnel shortcut or share its address.

## Deploy your own

A deployment needs a Cloudflare account, a Clerk application, a GitHub App,
and a Modal account. The [self-hosting guide](docs/self-hosting/README.md)
walks through each in order.

## Documentation

- [Self-hosting guide](docs/self-hosting/README.md): deploy your own copy.
- [Architecture records](docs/architecture/README.md): how each part works and
  why. Start with the [overview](docs/architecture/00-architecture-overview.md);
  [Terms](docs/architecture/README.md#terms) defines the project's vocabulary.
- [AGENTS.md](AGENTS.md): the repository guide, including every command, the
  testing rules, and how changes land. Written for coding agents and useful to
  people.
- [Security](SECURITY.md): the boundaries OnCue is built to hold, its known
  limits, and how to report a vulnerability.

## Working on OnCue

```bash
pnpm check
```

runs the formatter and linter, the typechecker, every unit and integration
suite, and the repository's consistency checks. It needs
[uv](https://docs.astral.sh/uv/) for the controller's Python tests.
`pnpm test:e2e` runs the browser suite against the local stand-ins. Before the
first run, install its browser and compose the test configuration:

```bash
pnpm --filter @oncue/web exec playwright install chromium
```

```bash
node apps/web/e2e/setup-local-auth.mjs
```

[AGENTS.md](AGENTS.md) has the rest, and [CONTRIBUTING.md](CONTRIBUTING.md)
says how to propose a change.

## Licence

OnCue is licensed under the [Apache License, Version 2.0](LICENSE). Notices for
material adapted from other projects are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The names and logos of
GitHub, Anthropic, OpenAI, Modal, OpenCode, and other products belong to their
owners and are not covered by that licence; OnCue is not affiliated with or
endorsed by them. Each coding agent and provider you connect has its own
terms, which are yours to meet.
