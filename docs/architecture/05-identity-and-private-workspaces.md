# Identity and private workspaces

**Status:** Approved foundation

## Purpose

Each person signs in to a private account and gets one private workspace. Repositories, model connections, sessions, secrets, artifacts, and settings in one workspace are invisible to every other user. Clerk authenticates; an operator-managed allowlist decides who may have a workspace at all. There are no paid plans, quotas, or billing.

## Decisions

- Clerk provides sign-up, sign-in, sessions, password recovery, and identity verification.
- D1 is the authority for OnCue users, workspaces, ownership, and authorization.
- Every admitted user gets exactly one private workspace, created automatically.
- Hosted access is limited to an operator-managed allowlist of Clerk identities.
- Shared workspaces, organizations, invitations, and team roles are deferred.
- Users bring their own model keys (record 06), GitHub App installation (record 07), and Modal account (record 02). The operator funds neither model access nor compute.

## Identity and authorization are separate

Clerk answers "who is making this request?" OnCue answers "what may that person access?" A valid Clerk session grants nothing by itself: the Worker resolves the Clerk subject to an OnCue user and workspace in D1 before authorizing anything.

Clerk subjects are external references, not ownership keys. OnCue's own `usr_` and `wsp_` identifiers own resources, so the data model is not tied to one identity provider.

## How a request is authorized

`apps/web/worker/auth/` implements the rule:

1. **Validate the Clerk session.** `verifyClerkSession` (`clerk.ts`) reads the `__session` cookie (or Clerk's suffixed `__session_<suffix>` form) and verifies it against the public JWT key with no network call, with the request's own origin as the only authorized party. A request that carries an `Authorization` header is refused outright.
2. **Check the allowlist.** `ONCUE_USER_ALLOWLIST` holds exact Clerk subjects, comma or newline separated (`allowlist.ts`). Each isolate re-reads `platform_control.allowlist_version` at most once a minute, so an operator's revocation (a version bump) reaches every isolate within that window. When the version cannot be read, nobody is allowed.
3. **Resolve or register the user** (below).
4. **Resolve the resource to its workspace** from the row the server reads, never from a workspace id the client sent.
5. **Confirm the user owns that workspace.** A session being deleted then answers as missing, to its owner too, on every route but the delete itself (`authorizeSessionRequest`, record 19).
6. **Apply resource rules and perform the operation**, which is the calling route's job.

"Not found" and "not yours" are distinct internally but answer identically (403 over HTTP, close code 4403 over WebSocket), so a caller cannot learn which session ids exist. Knowing or guessing an identifier never grants access, and every D1 query that reads workspace data includes the authorized workspace.

An authenticated person who is not on the allowlist gets `not_allowlisted` and no workspace; the browser shows `BlockedScreen` (`apps/web/src/features/auth/`).

## Registration

The first authorized request registers the person (`register.ts`). The user and workspace ids are derived, not random: a SHA-256 over a fixed namespace and the Clerk subject. Registration is then four `INSERT ... ON CONFLICT DO NOTHING` statements in one atomic D1 batch (user, `external_identity` with provider `clerk`, the private workspace, and the owner membership). Two racing first requests compute the same ids, at most one workspace survives, and registering an existing subject is a no-op.

A new user starts with an empty workspace: no repositories, model connection, Modal connection, or secrets.

## Workspace rules

Every repository connection, GitHub installation link, model connection, Modal connection, development secret, session, approval, artifact, and repository setting belongs to exactly one workspace. Every request for one establishes the workspace before reading or changing it.

A workspace has one member, its owner. The membership table exists so shared workspaces can come later without a data-model change; no team interface exists.

## D1 tables

| Table | Purpose |
|---|---|
| `user` | Internal user and `status` (`0002_identity.sql`) |
| `external_identity` | Links an external identity to a user: the Clerk subject, or the GitHub user verified during App installation (provider `github`, record 07) |
| `workspace` | The ownership boundary; `kind` is always `private`, unique per owner |
| `workspace_member` | User-to-workspace membership; the only role is `owner` |
| `deletion_request` | A request to delete a session's data, and its receipt once done (record 19) |
| `audit_entry` | Created by `0001_core.sql`; nothing writes to it yet |

Security-relevant actions are recorded as structured log lines (`apps/web/worker/log.ts`, record 18), not in `audit_entry`.

## Admission and safety limits

The `platform_control` row in D1 holds the global run-admission switch (`open` or `stopped`) and two concurrent-sandbox caps, seeded at 3 per workspace and 50 across the deployment (`0001_core.sql`). `decideAdmission` (`apps/web/worker/admission.ts`) checks them before a run is admitted and fails closed when the row cannot be read.

The caps are not enforced yet: both callers (`apps/web/worker/routes/sessions.ts` and the session object's `decideAdmissionNow`) pass active-sandbox counts of zero, because nothing counts active sandboxes. Today a run is refused only when admission is `stopped` or the row is unreadable. Nothing in the product writes the switch; record 22 describes the emergency controls and what is missing.

These are operator safety limits, not credits, tiers, or quotas.

## Account lifecycle

`user.status` allows `active`, `disabled`, and `deletion_requested`. Registration writes `active` and nothing reads the column, so disabling an account or requesting its deletion does not block any work yet. Deleting an account must remove or disconnect every OnCue-owned resource, not only the Clerk account; GitHub branches, commits, pull requests, and comments stay in their repositories. Record 19 defines retention and deletion.

## Security boundaries

- The Worker validates Clerk tokens server-side; the browser never decides ownership.
- Artifact downloads are authorized on every request and streamed by the Worker from R2; no download URL is issued (record 03).
- A sandbox's bridge credential identifies one session and one sandbox generation.
- Model, GitHub, and secret credentials follow their own scoped designs (records 06, 07, and 08).

## Not built yet

- Enforcing the concurrent-sandbox caps.
- Reading `user.status`: disabling an account and requested deletion.
- Clerk webhooks: the Worker has no Clerk webhook route and receives no Clerk events.
- Writing `audit_entry`.
- A `user_preference` table: no migration creates one.
- Operator routes to stop admission, terminate a session, or revoke a credential (record 22).

**Open question.** Whether the full-page `BlockedScreen` should be replaced with a smaller denial surface, or the allowlist itself removed, is undecided. Replacing the screen is a presentation change. Removing the allowlist would change an approved foundation and record 21: anyone completing Clerk sign-up would get a workspace, rows, and calls to the operator's control plane (compute is already the user's own Modal account). Until decided, the allowlist and `BlockedScreen` stay.

## Deferred

Shared workspaces, invitations and member management, roles beyond owner, single sign-on administration, domain claiming, SCIM provisioning, billing and paid plans, and user-facing quotas.

## Conditions for reconsideration

Revisit before OnCue is offered as a broad public service, before users collaborate in one workspace, or before enterprise identity requirements arrive. Self-service registration, invitations, organization policy, abuse prevention, support tooling, and account recovery will then need their own design.
