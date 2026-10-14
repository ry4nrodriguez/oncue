# Pull-request review feedback

**Status:** Approved foundation; mostly not built

## Purpose

The design brings reviewer feedback on an OnCue pull request back to the session that opened it, lets the user pick which comments the agent addresses, and has the agent update the same branch and pull request.

Only the pull request and its state changes are built. Importing and acting on reviews is not; record 21 does not require it for the MVP (see `../roadmap.md`).

## What is built

- The control plane opens and updates the session's draft pull request, and the session object keeps its number in its own `pull_request` table (record 07).
- The `pull_request` webhook arm in `apps/web/worker/github/webhooks.ts`: a pull request marked ready, converted to a draft, closed, merged, or reopened on GitHub reaches the session that opened it as `pull_request.state_changed`. The session is found through `session_index.pull_request_number` (migration `0007_pull_requests.sql`); a pull request no session opened is ignored.
- The protocol and storage shapes for review items, with no producer:
  - Five events in `packages/protocol/src/families/review.ts`: `review.imported`, `review.updated`, `review.selected`, `review.addressed`, and `review.dismissed`. Nothing in the Worker, the session object, or the bridge emits them.
  - The browser's view fold (`packages/protocol/src/view.ts`) folds them into review items and an unresolved count, but no screen reads the result.
  - The `review_items` command target in `packages/protocol/src/commands.ts` and the `review_feedback` run trigger are unused.
  - The session object's `review_item` table (`apps/web/worker/session/schema.sql`) has no reads or writes.

## What is not built

- No webhook arm for `pull_request_review`, `pull_request_review_comment`, or `issue_comment`. The handled deliveries (`HANDLED_EVENTS`) are `github_app_authorization`, `installation`, `installation_repositories`, `push`, and `pull_request`; any other event is acknowledged and ignored.
- No unresolved-review projection in D1.
- No review list, selection, or dismiss control in the session screen.
- No continuation run for selected feedback, and no reply posting.

The rest of this record is the design those pieces are meant to fill.

## Design decisions

- Review comments on an OnCue-created pull request are imported into its original session, with author and code location.
- The user chooses whether the agent addresses one comment, a selection, or all unresolved comments. Comments never start agent work on their own.
- Follow-up changes use the same session branch and pull request, and relevant checks run again (record 14) before feedback is marked addressed.
- Review text is untrusted external input. It never overrides system policy, permissions, or the user's instructions, and the interface identifies bot and automated reviewers.
- GitHub stays authoritative for comment text, authorship, location, resolution, and review state. The session is authoritative for what OnCue imported and how the agent responded.

## Ingestion flow

1. GitHub sends a signed review or comment webhook.
2. The Worker verifies the signature and deduplicates the delivery, as it does for every webhook today.
3. It rechecks repository access, finds the session through D1, and fetches GitHub state when the webhook lacks context.
4. The session commits `review.imported` or `review.updated`, stores the item, and projects its unresolved count to D1. Redeliveries and edits update the existing item.

## Review-task model

Each item records its GitHub ids, author and source type, times, file path, line, side, and commit when available, thread relationship, GitHub state, whether its location is outdated, and OnCue's action state.

OnCue action states (`REVIEW_ACTION_STATES` in `packages/protocol/src/states.ts`):

- **Unreviewed:** imported, not yet classified by the user
- **Selected:** chosen for agent work
- **In progress:** included in an active run
- **Addressed:** the agent made and verified a response
- **Dismissed:** the user chose not to act on it
- **Needs clarification:** ambiguous, or in conflict with policy
- **Outdated:** GitHub no longer maps it to the current diff

"Addressed" is OnCue's work state. It never changes a reviewer's approval or claims the reviewer accepted the result. A comment whose change could not be completed or verified stays in need of attention.

## Agent workflow

Selected feedback starts a continuation run (trigger `review_feedback`) with the comments, their locations, nearby code, the diff, the thread, and the session's plan and check history. The agent confirms each comment still applies, updates the branch, runs the checks, and reports per item.

First, OnCue compares the remote branch with its last known commit: compatible commits from others refresh the checkpoint, and divergent history or a force push pauses for the user. It never overwrites a reviewer's changes silently. Replies are drafts; posting one follows the session's Git policy (record 07), and the agent never resolves a thread or impersonates the user.

## Out of scope

Automatically starting work for every new comment, attaching a session to a pull request it did not open, merging after approval, resolving reviewer threads automatically, non-GitHub review sources, and several sessions responding on one branch.
