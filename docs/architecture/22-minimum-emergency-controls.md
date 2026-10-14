# Minimum Emergency Controls

**Status:** Approved foundation

## Purpose

OnCue runs code remotely and brokers access to models and repositories, so even the MVP needs a way to stop unsafe or malfunctioning activity quickly. This record defines three controls: stop admission of new runs, terminate one session, and revoke a credential or connection. It does not call for an administration product.

Most of the operator-facing half is not built yet. "Built today" and "Not built yet" below say exactly what exists.

## Decisions

- An authorized operator can stop all new run admission.
- A session owner can stop their session. An authorized operator can terminate a specific session by its exact identifier.
- A user can revoke their model and GitHub connections at once.
- The control plane enforces every control; neither the browser nor the agent is trusted to.
- Every emergency action writes a privacy-safe audit record.
- No admin dashboard, user-management console, or automated abuse detection.

## Control 1: Stop new runs

The global admission state lives in the single D1 row `platform_control` (`apps/web/migrations/0001_core.sql`): `run_admission` (`open` or `stopped`), a platform-wide and a per-workspace concurrent-sandbox cap, `allowlist_version`, and `emergency_control_version`.

`decideAdmission` in `apps/web/worker/admission.ts` is the one decision, called by both the Worker's session-create path (`apps/web/worker/routes/sessions.ts`) and the session Durable Object (`decideAdmissionNow` in `apps/web/worker/session/object/commit.ts`) before a run starts, continues, or resumes, including a checks-only run the object starts itself. It refuses, in this order:

1. `control_unreadable`: `readPlatformControl` turns a missing row, a malformed row, or a thrown query into `null`. Admission fails closed.
2. `admission_stopped`: the operator's switch.
3. `workspace_cap_reached`, then `platform_cap_reached`.

Stopping admission does not kill work already running; targeted termination does that. Existing sessions, diffs, and outcomes stay readable.

A create refused for `admission_stopped` shows "New sessions are paused right now. Try again shortly." in the composer (`REFUSAL_COPY` in `apps/web/src/lib/api/sessions.ts`). Inside an open session, a refused `run.start` shows the composer's generic rejection with the reason `admission_closed`.

## Control 2: Terminate one session

Termination:

1. Marks the run or session as stopping and rejects new model and tool requests.
2. Cancels the active runtime process and stops the sandbox generation.
3. Revokes the session's model, GitHub, artifact-upload, and restore credentials (`sandbox.credentials_revoked`).
4. Keeps committed events and earlier checkpoints.
5. Records who initiated it, when, and why.

It favors stopping over saving: it does not keep an unsafe sandbox alive to preserve uncommitted files. Record 11 owns the stop sequence.

## Control 3: Revoke credentials and connections

Revocation blocks new use at the control plane at once. Sandboxes hold only short-lived credentials, and the Model Broker refuses a token whose connection is not active or whose sandbox generation has ended (record 06).

GitHub-side changes arrive as verified webhooks (`apps/web/worker/github/webhooks.ts`): a revoked `github_app_authorization` disables the user's GitHub link, a deleted or suspended `installation` disables the installation, and `installation_repositories` removals disable those repository connections. Each blocks new GitHub tokens and remote operations while existing sessions stay readable.

## Operator access

Operator actions are meant to use a narrow, authenticated command or protected endpoint, never a general "run as administrator" control. Operator authority is separate from workspace ownership: an exact allowlist of operator Clerk user ids, a fresh Clerk session, and Cloudflare Access on a distinct hostname or route, all required together. Every operator action carries an exact action and target, a human-readable reason, a fresh authorization decision, an idempotency key, and an audit record.

None of this is built (see below).

## Audit record

An emergency-control audit entry holds the action type, actor id and actor type, exact target id, reason, requested and completed times, result, and the related run and sandbox generation when there is one. It never holds credentials, prompt content, source code, or raw command output. The `audit_entry` table exists for it.

## Built today

- **The owner's stop.** `POST /api/sessions/:id/sandbox/stop` (`apps/web/worker/routes/session-stop.ts`) runs steps 1 to 4 of Control 2 for the session's owner through the object's one stop path. A user's stop takes no new checkpoint (`beginStop` in `apps/web/worker/session/lifecycle.ts`).
- **Connection revocation.** `POST /api/model-connections/:id/revoke` revokes a model key; Settings, Model providers shows how many active sessions still use it first. `DELETE /api/modal-connection` removes the workspace's Modal connection and its sealed credential, which blocks new sessions but stops no running sandbox. `DELETE /api/repositories/:id` and `POST /api/repositories/:id/restore` hide and restore a repository inside OnCue without touching GitHub, and a removed repository refuses new sessions. Development secrets can be deleted per repository (`apps/web/worker/routes/secrets.ts`). The three GitHub webhook arms above are built.
- **Fail-closed admission.** The read and the decision in "Control 1" are built and called on both paths.
- **The identity allowlist.** `ONCUE_USER_ALLOWLIST` holds exact Clerk subjects (`apps/web/worker/auth/allowlist.ts`). Each isolate re-reads `platform_control.allowlist_version` at most every 60 seconds, and an unreadable version blocks everyone. Removing a user means changing the secret and bumping the version by hand.
- **Automatic lockdown on a foreign push.** When the push webhook sees the App's own bot push to a ref that is no session's branch, it locks down every active or archived session of that repository, up to 25 per delivery (`onPush` in `webhooks.ts`, `lockDownAfterForeignPush` in `session/object/pull-request.ts`): the Git policy becomes `push: never` and `pullRequest: never`, a live sandbox is stopped through the same path as the owner's stop with every credential revoked, and the Worker logs an `error` line with operation `github.incident.foreign_push` (record 07). A push to the branch of a session deleted within the last three days is that session's own push delivered late, not an incident (record 07). It is automatic, not an operator control, and writes no audit record.

## Not built yet

- **Nothing writes the stop switch.** `run_admission` is seeded `open` by the migration and written by nothing else. Stopping admission means editing the D1 row by hand, with no reason or activation time recorded and no operator reason shown to users.
- **The concurrent-sandbox caps cannot fire.** Both callers pass zero for both counts, so `workspace_cap_reached` and `platform_cap_reached` are unreachable outside unit tests.
- **No operator route or operator authorization.** Nothing terminates another user's session by id; there is no operator allowlist and no Cloudflare Access hostname. Every route authorizes the session's own owner.
- **No audit writer.** `audit_entry` has no reader or writer.
- **No GitHub installation revoke from OnCue**, and no revocation of subscription connections or push subscriptions, which do not exist.
- **Failure handling that depends on the above:** re-requesting provider termination with an alert when a sandbox does not stop, terminating a sandbox directly when its Durable Object is unreachable, and idempotent replay of operator commands.

`../roadmap.md` holds the plan for these; `../backlog.md` tracks the unreachable caps and the unused audit table.

## Testing requirements

Automated tests must prove: no new run starts while admission is stopped; existing records stay readable; termination affects only its target; model, GitHub, and sandbox actions fail after termination; revoked connections cannot be used by active or later sessions; duplicate emergency commands are safe; non-operators, and operators who did not pass Cloudflare Access, cannot invoke operator actions; GitHub removal webhooks disable exactly the affected connection; the caps fail closed before another sandbox is provisioned; and every emergency action produces its audit result. Today's tests cover the admission decision, the stopped switch on both paths, the owner's stop, revocation, the webhook arms, and the lockdown.

## Deferred

Admin dashboard, user suspension and moderation, automated abuse scoring, per-user or per-provider quotas, organization-wide policy, incident escalation workflow, scheduled maintenance mode, and bulk termination by search.

## Conditions for reconsideration

Expand this design when the user population grows beyond a small group, when recurring incidents need faster triage, or when several operators need role-specific access.
