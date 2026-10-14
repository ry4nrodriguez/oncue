# Notifications

**Status:** Approved foundation; not built

## Purpose

OnCue runs work in the background, so users need to learn when a run finishes or needs them. Notifications are for outcomes and decisions that matter; routine progress stays in the session timeline.

There is no notification system today: no notification center, no notification or push-subscription table, no preferences, no Web Push, and no service worker. The settings screen deliberately lists no notification section (`apps/web/src/features/settings/SettingsScreen.tsx`). Record 21 lists browser push notifications among the capabilities that do not block MVP completion; see `../roadmap.md`.

## What users have instead

The Home sidebar shows a status dot on each active session, computed from the session list alone without waking any session object (`apps/web/src/features/home/session-activity.ts`):

| Dot | When |
| --- | --- |
| Working | The current run is being set up or is running |
| Needs you | An approval card or a Git behavior proposal is open, or the run is waiting for approval, paused, or interrupted |
| Finished | The current run ended and this browser has not opened the session since; the label names the outcome, for example "Verified, not opened yet" |
| None | Anything else, including archived sessions and the session on screen |

The session object projects what the dot needs onto `session_index` with every snapshot: `waiting_for_user` (migration `0010_waiting_for_user.sql`), and `current_run_id` and `current_run_state` (migration `0015_session_current_run.sql`). The browser rereads the list on navigation and focus, and every four seconds (`WORKING_POLL_MS`) while the tab is visible and some session is working; with nothing working it does not poll (`apps/web/src/features/home/session-list.ts`).

"Not opened yet" is a per-browser reading mark: the id of the last ended run the user saw, per session, kept in `localStorage` (`apps/web/src/features/home/seen-runs.ts`, at most 200 entries). It does not follow the user to another browser. The first time a browser lists a workspace, every run that already ended counts as seen, so the dot means "ended since this browser was looking".

An open session screen shows progress and outcomes live over its WebSocket (record 13). Nothing reaches a user whose OnCue tab is closed.

## Design for the notification center

These decisions stand for when the center is built.

- An in-app notification center is the durable first channel: unread count, category, session, a short message, time, and a link to the relevant state.
- Browser notifications are opt-in. Permission is requested only after the user enables the setting, never on page load. Delivery while the tab is closed uses a service worker and a Web Push subscription.
- Notifications cover action required (an approval waiting, a model connection needing attention, repository access removed, a missing secret, a conflict needing direction), run outcomes (verified, completed with warnings, blocked, failed, and cancelled when another client cancelled), and new review activity (record 16), grouped when several arrive together.
- Routine tool activity and progress never notify.
- A notification is derived from a committed event through the session's outbox, applied idempotently with a stable deduplication key, so webhook redelivery or replay never duplicates one.
- While the user is viewing the session, the browser notification may be suppressed; the in-app record is still created.
- Preferences belong to the user: in-app and browser delivery by category.

## Privacy and security rules

- Every notification belongs to one user and workspace, and opening one runs a fresh authorization check.
- Browser payloads carry at most a session title and outcome: no code, secrets, prompts, command output, or review text.
- Notification text is escaped, and an external comment cannot choose it.
- Push subscriptions are sensitive connection data and can be revoked.
- Session deletion removes or neutralizes the session's notifications (record 19).

## Out of scope

Email, Slack and other chat tools, text messages, native mobile push, organization routing and escalation, digests, and user-authored notification rules.
