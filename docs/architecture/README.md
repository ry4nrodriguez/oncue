# OnCue architecture records

These records describe how OnCue works now: each component, its key decisions and why, its limits, and what is not built yet. Where a record and the code disagree, fix one of them. Code comments cite records by number ("record 07"), so records keep their numbers and file names.

## Records

Each record is known by the two-digit number in its file name.

- 00 — [Architecture overview](./00-architecture-overview.md)
- 01 — [Control plane and session orchestration](./01-control-plane.md)
- 02 — [Remote execution](./02-remote-execution.md)
- 03 — [Data and artifact architecture](./03-data-and-artifact-architecture.md)
- 04 — [Agent runtime and event protocol](./04-agent-runtime-and-event-protocol.md)
- 05 — [Identity and private workspaces](./05-identity-and-private-workspaces.md)
- 06 — [Model access and credential broker](./06-model-access-and-credential-broker.md)
- 07 — [GitHub and Git workflow](./07-github-and-git-workflow.md)
- 08 — [Repository environments and development secrets](./08-repository-environments-and-development-secrets.md)
- 09 — [Permissions, networking, and previews](./09-permissions-networking-and-previews.md)
- 10 — [Session and run lifecycle](./10-session-and-run-lifecycle.md)
- 11 — [Sandbox lifecycle and caching](./11-sandbox-lifecycle-and-caching.md)
- 12 — [Primary agent and planning](./12-primary-agent-and-planning.md)
- 13 — [Web interface and session experience](./13-web-interface-and-session-experience.md)
- 14 — [Verification and completion](./14-verification-and-completion.md)
- 15 — [Model selection and failure recovery](./15-model-selection-and-failure-recovery.md)
- 16 — [Pull-request review feedback](./16-pull-request-review-feedback.md)
- 17 — [Notifications](./17-notifications.md)
- 18 — [Observability and operational debugging](./18-observability-and-operational-debugging.md)
- 19 — [Data retention and deletion](./19-data-retention-and-deletion.md)
- 20 — [Minimal MVP deployment](./20-minimal-mvp-deployment.md)
- 21 — [MVP scope and completion boundary](./21-mvp-scope-and-completion-boundary.md)
- 22 — [Minimum emergency controls](./22-minimum-emergency-controls.md)
- 23 — [Comprehensive automated testing](./23-comprehensive-automated-testing.md)
- 24 — [Frontend technology stack](./24-frontend-technology-stack.md)

## Decision labels

- **Approved foundation:** chosen for the first version; new work builds on it.
- **Provisional detail:** the direction is agreed, but limits or details may change.
- **Tested:** a provider behavior observed on real infrastructure.
- **Open:** not yet decided.
- **Deferred:** deliberately left out of the first version.

## Terms

Words the records and logs use without stopping to define them.

- **Record NN:** one of the numbered documents above, cited by number ("record 07").
- **MVP:** the first complete version, bounded by record 21.
- **Control plane:** the Cloudflare Worker and its Durable Objects; everything OnCue runs outside the sandbox.
- **Session:** one task conversation with its own branch, event log, and sandbox.
- **Run:** one turn of agent work in a session, from a message to an outcome.
- **Session object, "the object":** the Durable Object that owns one session's state and event log.
- **Sandbox:** the Modal container a session's agent works in.
- **Generation:** the number of a session's current sandbox. A replacement gets the next number, and events from an older one are refused.
- **Sandbox controller, "the controller":** the small Python service on Modal that creates and stops sandboxes for the Worker.
- **Bridge:** OnCue's process inside the sandbox. It connects back to the session object, starts the agent, and relays its events.
- **Supervisor:** the root process in the sandbox that starts the bridge and the agent as separate Unix users.
- **Harness, runtime:** the coding agent program the bridge drives, such as OpenCode.
- **Runtime adapter:** the bridge code that turns one harness's output into OnCue's events.
- **Model Broker:** the Worker route that forwards model requests with the user's stored key, so the key never enters the sandbox.
- **Relay:** the bridge's loopback proxy that attaches a short-lived broker token to the agent's model requests.
- **Keyring:** `ONCUE_BROKER_KEYRING`, the secret that seals (encrypts) every stored credential.
- **Workspace:** a user's private space; there is one per user.
- **Allowlist:** the Clerk user ids allowed to sign in to a deployment.
- **Operator:** whoever deploys and runs an OnCue. In the logs, the maintainer running their own deployment.
- **Owner:** in the logs, the project's maintainer. In records 05, 15, and 22, the user who owns a session.
- **Hosted:** running as a deployed Worker (`ONCUE_ENV=hosted`), not locally. In the logs, the maintainer's own deployment.
- **Double, stand-in:** a local imitation of an outside service (GitHub, a model provider, the controller), used in development and tests.
- **Fake sandbox driver, scripted model:** the built-in stand-ins a local session uses when no controller or model key is configured.
- **Lane:** one end-to-end test file or Playwright project.
- **Walkthrough:** the end-to-end test that walks the whole user path.
- **Live test, live lane:** a test against real Modal, GitHub, or a model, which spends money.
- **Sitting:** one authorized session of live testing, with a spending cap.
- **Port slot:** `ONCUE_PORT_SLOT`, which shifts every local port so several checkouts can run side by side.
- **Clean-machine check:** `pnpm check` run with `.dev.vars` moved aside and generated types rebuilt, as a fresh clone would see it.
- **Test A:** the live test of the sandbox network policy (record 09).
- **Test B:** the Modal sidecar option; closed without running.
- **Test C:** the live test that the agent's Unix user cannot read the bridge's credentials (`services/sandbox-controller/scripts/test_c_probe.py`).
- **Spike (S0 to S6):** a time-boxed live experiment whose result decides a design.
- **Checkpoint:** the commit the bridge pushes, or the patch it saves, before a sandbox stops, so a later sandbox can resume.
- **Patch bundle:** a saved diff in R2, used when a checkpoint is not pushed.
- **Task branch:** the `oncue/...` branch a session pushes to.
- **Publish:** a push the user asked for, with its draft pull request.
- **Outbox, projection:** how session facts are copied from the session object into D1 for lists.
- **Idle stop, ceiling:** a sandbox stops after 20 idle minutes, and is replaced before Modal's 24-hour limit.
- **Plan-step id (PR-01 to PR-16):** a step of the original implementation plan, not a pull request number.
- **GitHub #N:** a pull request in the private development repository; it cannot be opened from here.
- **Backlog id (A5, B18, D17):** an item in `docs/backlog.md`. The letter is its section.

## Related documents

[`../history.md`](../history.md) is the dated account of what was built, verified, and left open. [`../decisions.md`](../decisions.md) logs each significant decision with its reasons and the alternatives rejected. [`../roadmap.md`](../roadmap.md) holds planned work that is not built, and [`../backlog.md`](../backlog.md) holds open defects and gaps. `pnpm check-records` keeps the state machines in records 01, 11, and 12 and the event and command lists in record 04 in step with `packages/protocol`.
