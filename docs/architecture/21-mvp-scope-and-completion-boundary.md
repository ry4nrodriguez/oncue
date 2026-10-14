# MVP Scope and Completion Boundary

**Status:** Approved foundation

## Purpose

This record defines what the MVP must do before it is complete, what is deliberately left out, and how much of the boundary is built. The MVP proves one complete cloud coding workflow through the browser. Running infrastructure alone does not make it complete.

## Completion statement

The MVP is complete when an allowlisted user can:

1. Sign up and enter a private workspace.
2. Connect an authorized GitHub repository.
3. Connect a supported model with their own credential, and their own Modal account for compute.
4. Start a coding session from the browser.
5. Watch durable streamed progress and talk to the agent.
6. Stop the work and resume it in a replacement sandbox without losing the session or repository state.
7. Review the changes and the verification evidence.
8. Tell the agent when to commit, push, or open a draft pull request.
9. Receive a draft pull request containing the change and its verification summary.

Every step must work in the shared hosted environment and be covered by automated tests (record 23).

## Required capabilities

### Account and workspace

- Clerk sign-in plus the operator-managed allowlist (record 05).
- One private workspace per user, with OnCue authorizing every workspace resource.
- A way to delete a session and its stored OnCue content (record 19).
- Per-workspace and platform-wide concurrent-sandbox caps (record 22).

### Connections

- Install the GitHub App on chosen repositories.
- Add a model API-key connection, check its status without revealing it, and revoke it.
- Connect the workspace's Modal account.
- Revoke a GitHub connection.

### Sessions and runs

- Choose a connected repository and model, and give the task in the composer.
- Work on an isolated task branch, one per session (record 07).
- Provision one Modal sandbox and start the coding runtime with the repository and task.
- Stream committed messages, plans, tool activity, and status; keep working when the browser disconnects; reconnect without duplicates.
- Send follow-ups that steer or queue work, and stop or cancel a run.
- Checkpoint before idle shutdown and resume from the branch, event history, and saved artifacts.

### Review and evidence

- Show the diff, the branch, and commit state.
- Run the repository's own checks and show their results.
- Distinguish the run outcomes `run.verified`, `run.completed_with_warnings`, `run.completed` (shown as Done: nothing changed, so no checks ran), `run.blocked`, `run.failed`, and `run.cancelled` (record 14).
- Never claim a verified result without passing evidence.

### Git output

- Commit, push, and pull-request timing follows chat-controlled policy (records 07 and 09).
- Push only through short-lived GitHub App access, only to the session's one branch: a new task branch, or the existing branch the user chose to work on.
- Create or update one draft pull request with the summary, verification results, and warnings.
- Never push to the default branch or a protected branch, or merge the pull request.

## Required safety properties

- One user cannot read or control another user's sessions, artifacts, credentials, repositories, or previews.
- Long-lived model, GitHub, and Modal credentials never enter the sandbox.
- Only disclosed development secrets enter a session (record 08).
- Private and metadata network destinations stay blocked, and public OnCue endpoints reject sandbox requests without scoped authorization (record 09).
- Sensitive actions go through the permission and approval model (record 09).
- Durable work survives sandbox replacement at checkpoints (record 11).
- Emergency controls can stop new runs, terminate one session, and revoke credentials (record 22).
- An identity outside the allowlist cannot create a workspace or start compute.
- The concurrent-sandbox caps fail closed before more Modal compute starts.

## Completion evidence

- Automated tests for every requirement in this record.
- Live hosted end-to-end tests against the shared environment.
- A real coding session on a representative repository, including stop and resume.
- A verified change with reviewable evidence, and a user-directed commit, push, and draft pull request.
- Passing private-workspace isolation and secret-boundary tests.
- No known critical or high-severity security defect in the workflow.

## What is built

Steps 1 to 9 are built. The `walkthrough` lane of `pnpm test:e2e` drives them end to end against the local doubles and a real OpenCode: setup, a task, a streamed run, a change card, a Verified outcome from the repository's own checks, a push and draft pull request after the user allows it, the idle stop with a pushed checkpoint and revoked credentials, and a resume on a new sandbox generation. The same path has run against real Modal, the real GitHub App, and a real model (`../history.md`).

Also built:

- The credential boundary. Long-lived credentials stay in the control plane; the sandbox holds short-lived session credentials, and the model token reaches a loopback relay under a separate Unix user (records 02 and 06).
- The Modal network policy and the bridge's Unix-user isolation, both tested live (records 09 and 02; test C must be re-run after each image change, record 23).
- Verified outcomes that the session object accepts only when its own stored check records support them (record 14).
- Development secrets with a disclosure card before launch, mid-run requests the user approves, and redaction (record 08).
- Revoking a model key, and removing or restoring a repository inside OnCue (`repository_connection.removed_at`).
- Adapters for harnesses other than OpenCode, none part of the completion boundary. Codex is in the image and off until the operator names it in `ONCUE_RUNTIME_ALLOWLIST` (`apps/web/worker/runtime/resolve.ts`). Pi and Claude Code are not installed in the image, so they cannot be enabled: `resolveRuntime` refuses them whatever the allowlist names.

## What is not built yet

- **Emergency controls.** No operator writes the run-admission switch, the sandbox caps cannot fire because nothing counts sandboxes, and there is no operator route or audit writer (record 22).
- **Hosted end-to-end tests and the acceptance gate.** No hosted smoke or end-to-end suite exists; CI runs the local suites against the doubles only (records 20 and 23).
- **A requirement-to-test index.** Nothing maps the requirements above to tests, so "every requirement has a test" cannot be shown.
- **Revoking the GitHub App installation from OnCue.** An installation deleted or suspended on GitHub is honored through the `installation` webhook, but OnCue cannot revoke it itself.
- **Previews.** Not built, so preview isolation holds only because there are no previews.

`../roadmap.md` holds the plan for each; `../backlog.md` holds the defects.

## Not required for completion

These may land after the core boundary without changing the platform design:

- Pull-request review-comment continuation (record 16).
- Browser push notifications (record 17).
- More model providers and subscription connections.
- Advanced repository environment tuning.
- Operational dashboards.
- Automated expiry of temporary artifacts beyond basic deletion.
- Change-aware verification, and browser or screenshot evidence. The repository's own checks are the evidence the boundary requires.

## Deferred beyond the MVP

Shared workspaces, non-coding work profiles, multiple active agents in one session, automatic model fallback, automatic pull-request merging, production infrastructure or data access, billing and quotas, public self-service registration, administrative dashboards and abuse management, multiple hosted environments, and a formal repository compatibility matrix.

## Scope-change rule

A feature enters the completion boundary only when the core workflow cannot be safe, usable, or reviewable without it. Convenience, future scale, or competitive completeness are not enough. Adding a required capability updates this record and its test coverage before implementation begins.

## Conditions for reconsideration

Reconsider when a required step cannot be delivered safely without an omitted capability, or when early use shows people cannot reach a reviewable result through the defined path.
