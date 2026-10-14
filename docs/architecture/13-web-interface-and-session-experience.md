# Web interface and session experience

**Status:** Approved foundation

## Purpose

OnCue is a browser workspace for starting, supervising, steering, and reviewing background agent sessions. The conversation is the center; diffs, checks, command output, and pull-request state appear when relevant, without turning the product into a cloud IDE. It should stay calm and easy to scan under a lot of agent activity.

The code is in `apps/web/src`: routes in `routes/routes.tsx`, screens under `features/`. Record 24 defines the frontend stack.

## Key decisions

- A browser application, supervisory rather than a desktop-IDE replacement.
- Home is a session sidebar beside a centered task composer.
- The session screen centers the conversation and its timeline, with a context rail of current facts and a composer that stays available.
- Diffs, checks, command output, the sandbox, the pull request, and subagents open in one side panel with a tab per view.
- Tool activity is visible but quieter than user and agent messages.
- Light and dark themes share one set of semantic tokens.
- Status never relies on colour alone.

## Routes and areas

| Route | Screen |
| --- | --- |
| `/` | Home: the composer, inside the app shell with the session sidebar |
| `/sessions/:sessionId` | Session |
| `/setup` | First-run setup, outside the shell |
| `/settings/profile`, `/settings/repositories`, `/settings/model-providers`, `/settings/harnesses`, `/settings/agent-permissions`, `/settings/modal` | Settings, which replaces the shell while open |

`/repositories` and `/model-connections` redirect into Settings; the GitHub install callback still lands on the first. Settings and the shell sit behind the same setup gate, so a workspace without GitHub or Modal lands on `/setup`.

Settings has six sections and no others:

- **Profile:** who is signed in, from the identity provider.
- **Repositories:** connect GitHub, see which repositories the App reaches, open a repository's development secrets, and remove a repository from OnCue or restore it (record 07, "Removing a repository"). A reachable repository has no badge; a lost one reads "Disconnected".
- **Model providers:** one card per provider, connected or not. Connect a key, re-check it with the provider (the card then says whether the provider accepted it, rejected it, or could not be reached), replace it in place, or revoke it after a dialog that says how many active sessions still use it. Each change refreshes the keys Home lists. Beneath each card, every model the key unlocks with its list price, context window, and effort levels. One key per provider (record 06).
- **Harnesses:** one row per harness the image installs (the catalog's `inImage`) with its mark, name, and state: "Ready", a Connect to Model providers for the key it lacks, or "Not available yet" when this deployment has not enabled it (record 12).
- **Agent permissions:** the workspace's default for the coding agent's own permission asks ("Allow once" or "Always allow", with a button to switch), and each category saved with "Always allow" on a card, with when it was saved and Remove (record 09, "Agent permissions"; `features/settings/AgentPermissionsSection.tsx`).
- **Modal:** the connected Modal workspace, replace its credential, or disconnect it.

Repositories and Modal sit together because each is an outside account the user granted and can revoke here, and both live in Settings because they are visited rarely.

A repository's Secrets control opens its saved names and a name-and-value form, one repository at a time (record 08). A value is sent once: the field clears as the request leaves, no response returns it, and a saved secret can be replaced or removed but never read. The section says only development and test values belong there.

## Home screen

### Session sidebar

The sidebar is hidden by default and slides in when the pointer reaches the left edge; its button pins it open, and it can be resized between 200 and 420 pixels. It holds the wordmark and pin control, "New session", three groups, and at its foot the account menu (Settings, Sign out) and the theme menu (Light, Dark, System).

The groups are **Pinned**, **Active**, and **Archived** (`features/home/sidebar-groups.ts`), each ordered by latest activity, newest first. A row's pin button ("Pin chat") moves it to Pinned; pins are remembered in the browser per workspace (`features/home/pins.ts`), not on the server. Active holds every other open session, working, waiting, or finished. Archived sessions sit in their own group at the bottom, closed until opened; archiving takes a session out of Pinned and restoring puts it back. Each row is one line: a status slot and the title. A title that does not fit ends in an ellipsis; once the pointer has rested on the row for a quarter of a second it slides left at 100 pixels a second until its end shows, and resets at once when the pointer leaves (`useTitleScroll` in `features/home/Sidebar.tsx`). Reduced motion keeps it still.

Each row also has an options menu ("Options for" and the title; `features/home/SessionMenu.tsx`), shown on hover and focus, with **Archive** or **Unarchive** and **Delete**:

- **Archive** happens at once when no run is open. With a run open, by the list's reading or the server's (`409 run_open`), a dialog says archiving cancels the run, checkpoints the sandbox's work, and stops it, and archives only on "Cancel the run and archive".
- **Delete** always asks first. The dialog says it erases the conversation, diffs, logs, attachments, and artifacts stored in OnCue and stops the sandbox, that it cannot be undone, and that the GitHub branch and any pull request stay on GitHub.
- The list shows the change at once (`applyLocalChanges` in `features/home/session-list.ts`) and reads again; a deleted session leaves the list immediately, and deleting the session on screen returns to Home. A failure is said in the dialog.

Every row has one status slot, all one size so the titles line up, read from `GET /api/sessions` alone without opening a session object:

- **Working:** a grey 3 by 3 dot matrix while the current run is being set up or run. A three-dot trail steps round the eight outer dots, 120 milliseconds a dot (`features/home/status-matrix.ts`); every working row shows the same frame, and reduced motion holds the first frame still.
- **Finished:** a solid blue dot (`--finished`) when the current run ended and the session has not been opened since, with words such as "Done, not opened yet". Opening the session clears it. Seen runs are remembered per browser and workspace (`seen-runs.ts`), and a browser's first list counts as seen.
- **Needs you:** a solid yellow dot (`--attention`) while a card waits on the user (`session_index.waiting_for_user`: an approval, a Git policy proposal, or the agent's question) or the run waits for approval, is paused, or is interrupted. Its words are "Needs you".
- **Anything else:** nothing. The slot stays empty and is hidden from assistive technology.

A meaningful mark's words are its accessible name. The list is fetched again on every route change, on focus, when the tab becomes visible, and when the identity is read again (`GET /api/me`), and polls every 4 seconds only while the tab is visible and some run is working (`features/home/session-list.ts`). A fresh read replaces the rows on screen; it never blanks them first.

#### Sidebar menus

The account and theme menus share one behaviour (`features/home/sidebar-menu.ts`). A click opens a menu. One opened with a mouse or pen closes once the pointer has been outside both trigger and menu for 300 ms, so a diagonal move into the menu never closes it; a touch never starts that timer, and a keyboard-opened menu stays until Escape, Tab, or a choice. An open menu holds the unpinned sidebar revealed, because the menu is portaled outside it, and unpinning closes every menu. The timer is OnCue's because Base UI's close delay requires opening on hover.

### Starting canvas

The main area holds an animated ASCII fire wordmark and the composer, whose placeholder reads "Ask or build anything". On Home the composer carries the add menu, the dictation button, and Send, and its strip carries the repository, the branch (record 07, "Choosing the branch"), and one agent chip for the harness, the model, and its effort (see "Bottom composer"). It says nothing about Modal: the setup gate means Home is reached only with Modal connected, and Settings, Modal shows the account.

If setup is incomplete the canvas guides them through the missing setup rather than letting a task fail later: a line above the composer names the missing step with a "Finish setup" link. It does not disable the composer. A workspace without Modal never reaches Home.

A model key that stopped working is named above the composer too, one line per key with a caution mark (record 15, "On Home"): which provider, what happened, how many active sessions are on it, and a "Replace the key" link to Settings, Model providers. It stands in for the "Finish setup" line when the workspace's only key is the one that stopped, since that key is replaced, not added. The composer stays enabled for the keys that work.

The disclosure card for development secrets (record 08) appears above the composer when a submit needs the user's answer.

## First-run setup

- Clerk renders sign-in and sign-up through its own component, themed by `lib/clerk-appearance.ts` so it follows OnCue's tokens in light and dark, with no card or shadow of Clerk's, neutral bordered buttons, Clerk's heading hidden, and its development-mode strip off. `SignIn` runs `withSignUp`, so an unknown address continues into sign-up in the same form. Nothing links to Clerk's hosted pages.
- Sign-in, the blocked notice, and every setup step share one frame (`features/auth/AuthFrame.tsx`): one bordered panel on the page background, opening with the animated ASCII wordmark (`components/brand/FireWordmark.tsx`, at most 30 frames a second, one still frame under reduced motion). The page scrolls rather than cutting off a tall step and does not overflow a 375-pixel phone. A step is its counter, a title, one line, and the action. The blocked notice offers Sign out.
- Loading (`features/auth/LoadingScreen.tsx`) is the same wordmark with a shimmering "Loading", while Clerk loads, while the gate waits on `/api/me`, and while Clerk's form mounts. `index.html` sets the theme and canvas colour before any script runs, so dark mode shows no white flash.
- A failed `/api/me` (a thrown fetch, any status other than 200 or 403, or a body that does not parse) is not loading. Before anything is on screen the gate shows "OnCue couldn't reach the server." in the same frame, with Retry and Sign out (`features/auth/MeFailedScreen.tsx`), and retries on its own from one second, doubling to 30 seconds (`meRetryDelay` in `features/auth/gate.ts`). A failed refetch after a save keeps the last good answer and the app on screen, including an open session's socket, and retries behind it.
- Setup is three steps in order of dependence: connect GitHub, add a model connection, connect Modal. GitHub is mandatory because a session needs an installation to clone and push, and Modal because every sandbox runs in the user's own Modal workspace (record 02); a composer that looked ready and failed on submit would be worse than one more step. The model step can be skipped ("Skip for now" is remembered for the tab, `features/setup/setup-skip.ts`). A local Worker then runs sessions on the scripted model; a hosted one refuses the send with `model_connection_required` until a key is added (record 15).
- `/setup` derives its step from server state on every load (`features/setup/setup-step.ts`), because the GitHub install and the Modal token both happen off the site. Setup is complete when a GitHub installation and a working Modal connection exist; no flag is stored, and a user who skipped the model key is not looped back.
- Steps are full-page routes, not dialogs, so redirects and the back button behave.

### Failure states

One GitHub screen covers three cases, each with a retry and a sign-out: the user came back without installing, the App reaches no repositories, or the install waits on an organization admin's approval, which the copy says the user cannot resolve themselves.

The Modal failure that matters is not a bad token: a Modal service user starts with No Access on every Environment, so a valid credential can see nothing. The step says so before the user leaves for Modal, and the error says so again.

### Copy requirements

- A user who signed in with GitHub would read "Connect GitHub" as a bug, so the step says repository access is separate from signing in.
- The Modal step says Modal's Starter plan is free with $30 of monthly compute credit, that Modal requires a payment method on file (the copy never says "no credit card"), and that a Starter user pastes a personal token with full authority over their Modal workspace, so a dedicated workspace is recommended (`features/modal-connection/modal-connection-copy.ts`). These are Modal's published terms, not something OnCue checks.

Workspace creation is automatic (record 05). Secrets are disclosed at session launch (record 08), not during setup.

## Session screen

The session screen has a compact header, the timeline, the context rail, and the composer at the bottom. The sidebar behaves as on Home.

### Header

The header carries:

- the connection state, only while it is degraded (connecting, reconnecting, or offline), as a dot with its words;
- "Pin session details" while the rail is unpinned;
- the side panel's toggle ("Open side panel", "Close side panel"). Since the composer no longer shows the sandbox, the toggle carries a small dot while the sandbox is coming up (caution, pulsing) or running (positive), and none before a sandbox or once it has stopped, failed, or been lost, since the run's own state says what went wrong; its name and tooltip then add the state, for example "Open side panel. Sandbox running". A press does what it always did.
- the session's options menu, the same one the sidebar row offers (Archive or Unarchive, Delete).

It carries no title, run status, repository, or branch; the sidebar, composer strip, rail, and review panel name those. The header remains compact, and detailed information belongs in the context rail or the side panel. The sandbox's state in words and its stop control live in the side panel's Modal tab alone (`features/session/SessionHeader.tsx`).

### Timeline

The timeline shows user instructions, agent messages, plan events, approval cards, the agent's questions, tool activity, change cards and checks, artifacts, Git commits, pushes, and pull-request updates, and run outcomes. Messages get the strongest emphasis; tool calls and status events are smaller, quieter rows that expand for detail.

It reads in the order things happened. Within a turn, the agent's work folds into closed groups where it happened (`features/session/timeline-turns.ts`, `ActivityGroup.tsx`): a run of tool calls, plan steps, and artifacts is one group with a one-line headline, the text the agent then wrote stands under it, and the next calls form the next group. A message opened and closed with no words shows nothing and does not split a group. While a group is the live edge of a run, its headline is the running tool, shimmering, with the action count beside it; once the run has written past it, the headline settles to what the group did, for example "Ran 4 commands, read 2 files (1 failed) · 4s". The checks a run ends with are their own group after the change card ("Checks · 5 passed", or "2 of 5 failed"), and the run's outcome row stands beneath it, never inside a group. A pause on a model failure stands on the timeline the same way, because the run waits on the person and a folded row would hide why. Groups start closed and stay as the reader left them. Each turn ends with a "Copy response" button that copies its agent messages as Markdown.

Agent messages stream. The open message renders the text received so far, marked busy for assistive technology, and is replaced by the committed message on `message.completed`. Deltas are not durable: a message with no words yet, because none arrived or a reconnect dropped the buffer, is not drawn, and buffered text is never presented as history. Tool rows open from the streamed request, show running once started, and close on the committed result.

Large logs are not inlined. An artifact row downloads its artifact and reads "Artifact unavailable" when the object is gone.

#### Subagents on the timeline

The primary agent's call that started a subagent (record 12) stands on the timeline as one row of its own, never inside an activity group: a diamond mark, the primary agent's description of the task, a word only when it failed or was stopped, and a chevron (`features/session/agents/AgentLaunchRow.tsx`). The description shimmers while the subagent runs, and the row's accessible name says "Running" then too; with motion turned down, where nothing shimmers, the row shows that word. Clicking it opens that subagent's detail in the side panel. Nothing the subagent said or ran appears on the timeline; its rows carry its `agentId` and the fold keeps them on its own timeline (`view.agents`). While any subagent runs, a pill reads "1 running agent" or "N running agents" and opens the Agents view. It stands on the line that says what the primary agent is doing now, right after that line's words, when the timeline ends on one (the live activity group); otherwise it takes a line of its own at the bottom of the timeline. A subagent still running when its run ended reads as stopped.

#### Changes, checks, and outcomes

A turn that changed files ends with a change card: "Edited N files" with the turn's added and removed lines, one row per file with its own counts, the first three files shown and the rest behind "Show N more files", and a Review button that opens the review panel on that turn (`features/diff/ChangeCard.tsx`). The card has no undo, commit, or push control.

Each check is one row with an icon and its state in words (pending, running, passed, failed, skipped, inconclusive, or "not finished" when its run ended first) and a "Full output" link to its latest attempt's log. A quiet "Checks finished" row gives the count of required checks that passed; it does not repeat the sandbox's proposed outcome, which the session object may refuse.

A finished run has one outcome row (`features/verification/outcomes.tsx`): the outcome's label and tone, then its required checks on one line, which opens the Tests tab on that run. Completed with warnings lists each warning with its recommended action, Done says "No files changed, so no checks ran.", Failed names the stage and error, and Blocked names what it waits on. A run paused on a model failure has a row of its own (`features/session/PausedRow.tsx`): "Paused" in the caution tone, the failure in plain words beneath it ("Model request failed: the provider rejected the model key."), and, on the pause the run is still stopped on, a link to Settings, Model providers when that is the way forward (record 15). Any other pause stays a quiet "Run paused" row inside its group. Every string from a payload renders as text.

#### Action rows

A tool call and a sandbox lifecycle step are different shapes underneath, correlated by different identifiers, and stay separate item kinds, but they share one row component (`features/session/ActionRow.tsx`):

- **The mark names the actor.** Each category and provider maps to one mark from a single table, so a reader sees that a push landed on GitHub or a sandbox came from Modal.
- **The label comes from the event's data,** for example "Cloning `owner/repository`", never an adjective like "Working". A label that cannot be built from the event means the row is wrong.
- **Four visible states:** requested, running, completed, failed. Requested matters because a call waiting on an approval sits there indefinitely. A failure is legible without expanding, and its category tells a policy denial from a timeout.
- **Collapsed, the row says what is happening now; expanded, how it got there:** the steps with their offsets, then the facts, arguments, and output. A sandbox row's facts are its provider identifier and a live duration.
- **Output is a bounded tail, and says so.** Output events are not replayed on reconnect, so a panel missing output says it is missing rather than drawing an empty box.
- **A settled call shows what it printed.** The bridge's `tool.completed` carries the redacted inline result (`value.output`, cut to the inline limit). The expanded row and the Terminal pane show it in monospace, preferring it over a streamed tail because it survives a reload, show its last 40 lines until asked for more, and say how many characters the bridge cut.
- **Work in progress shimmers** (`shimmer` in `styles/globals.css`): a highlight crosses the text every two seconds in a seamless loop, stands still under reduced motion, and does not restart on streamed updates.
- **A row that expands is a control,** with an accessible name, an expanded state, and keyboard operation.

### Context rail

The rail answers "What is happening, where is the work, and what needs me?" without reading the whole timeline (`features/session/ContextRail.tsx`). It holds, top to bottom:

- What needs the user, when anything does: a model failure in plain words with what to do next (record 15, "Pause and recovery"), "An approval is waiting" (which scrolls to the card), "The agent asked you a question" (which brings the question card into view; while a question is open it stands in for Continue, since the answer resumes the run), or, for a paused or interrupted run with no live sandbox, why the work stopped with Continue beneath it. Continue sends a steer that resumes the run on a new sandbox; the stop's unsaved-work warning appears as plain text. A run interrupted for the planned replacement resumes on its own and offers nothing.
- The session's changes in one line ("+72 -3 · 4 files"), which opens the review panel on all of them, or "No changes yet".
- The task branch, or "Branch named at the first push", with the branch the session started from beneath it, or "Existing branch, pushed to directly" for a session working on one (record 07). The Pull request tab says the same, and the base of the pull request once there is one.
- The pull request (its number and state), which opens the side panel's Pull request tab, or "No pull request yet".
- The Git behavior in one line, such as "Commits · Does not push", with one control beneath it ("Push and open a draft pull request" or "Stop pushing") that writes the same policy record a confirmed proposal does (record 09). On a session with no branch yet it sends the name chosen in the Pull request tab, or the suggestion.
- The latest run's outcome with its required checks ("Verified · test passed"), which opens the Tests tab, and "Run checks" once that run has ended: a checks-only run that prompts no one and can end Verified (record 14, "Checks on request").

The rail prints no fact before it exists and does not count events; the repository, model, and effort are the composer strip's, and the sandbox's state is the side panel's Modal tab's. It floats as a card at the top right, is pinned by default on screens at least 1024 pixels wide, and is hidden while the side panel is open.

### Decisions above the composer

A Git policy proposal that widens authority (record 09) is not a card in the timeline but one line above the composer, for example "Allow pushes after each run and a draft PR after each push on acme/widgets?", with Decline and Allow (`features/policy/PolicyCard.tsx`). It names every field that moves with its new value, cannot scroll away, and Allow sends the proposal's id and the policy version the line was drawn from. The timeline keeps the settled row naming each field that moved, from and to. The branch's name is not asked here: a first push takes the name from the Pull request tab, or the suggestion (record 07). Secret approvals remain cards in the timeline (`features/approvals/ApprovalCard.tsx`).

The agent's questions (record 12) wait in a card directly above the composer, the composer's width (`features/questions/QuestionCard.tsx`). Its header holds a counter such as "1/4" when there are several (read to a screen reader as "Question 1 of 4"), the question, a collapse chevron, and × to dismiss, which waits while an answer is on its way. The choices scroll within the card past a height bound, so the header, Skip and Next, and the composer stay on screen in a short window or on a phone. Each choice is a row with its label, a muted description, and its number key; a single choice is a radio and several are checkboxes, and a chosen row shows a check. A radio or checkbox is named by its label and described by its description; the number is hidden from a screen reader. Choosing a chosen single choice again, by click or number, keeps it. An "Other" row takes a typed answer when the agent allows one. Skip and Next sit at the foot, Next with its ⌘↵ hint, and on the last question Next reads Submit. With focus in the expanded card, a number with no modifier picks its row, ⌘↵ or Ctrl+↵ goes on, and Escape folds the card to one line, "Asking: <header>"; a folded card answers no key. Folding moves focus to Expand and opening it moves focus to Collapse, and when the card closes with focus in it, focus goes to the composer. A polite live region announces a card as it opens. The card's frame and rows are shared primitives (`components/decision/DecisionCard.tsx`) for any card that asks for a choice, and are neutral: no accent colour. On the timeline each question is one folded row, "Asking <header>" while it waits and "Asked N questions" once settled, that opens to each question and the answer given or "Skipped", or, for a dismissed question, "Dismissed" or "Not answered" with why (the user's ×, a message sent instead, the user's pause, the run ending, or the sandbox replaced); it stands in for the asking call's own tool row.
The coding agent's own permission ask (record 09, "Agent permissions") is a card above the composer too (`features/approvals/PermissionCard.tsx`), in the question card's frame (`components/decision/DecisionCard.tsx`): a header with the one plain line saying what the agent wants ("Read /etc/hosts, outside the project") and a collapse chevron, a muted line with its category and the time it is denied if nobody answers, and a footer of neutral answers, Allow once (filled), Allow for this session, Always allow, and Deny, which wrap at phone width. It has no ×: an ask is answered, or denied when its time runs out. A secret file offers only Allow once and Deny. The buttons are off while an answer is on its way and once it is accepted; an answer the object refused, that could not be sent, or that got no reply in time gives them back with the reason under the line. The screen keys the card by the approval, so a new ask never inherits the last one's state. Once settled it leaves one folded line in the timeline: "Allowed once: read /etc/hosts, outside the project", "Allowed for this session: …", "Always allowed: …", "Denied: …", or "Denied, no answer in time: …". An ask a saved choice answered appears only as that line.

One decision card shows at a time. When the agent's question and a permission ask are both open, the question card shows and the permission card waits behind it, because the run is paused on the question; the permission card appears once the question is answered or dismissed, and its ten-minute expiry keeps running meanwhile. A Git policy question (above) is a separate line and can show beside either.

### Bottom composer

The composer (`features/session/Composer.tsx`) stays available during and after work, except on an archived session: there the timeline stays readable and the composer gives way to a notice, "This session is archived.", with an **Unarchive** button (`features/session/ArchivedNotice.tsx`). Everything that would answer the agent or change the session goes with the composer: the approvals picker, the context meter, the question card, the permission card, the Git question above the composer, the note about the run, and the Agents view's stop button. The object refuses each of those commands on an archived session anyway (record 10). Once restored, the composer returns and the next message resumes the session on a new sandbox. It labels what a send will do, derived from the run's state (record 10): "Steers this run", "Runs next", "Starts the next run", or "Continue". "Stop run" beside it sends `run.cancel` for any run that has not ended, including a paused or interrupted one whose sandbox is gone; it keeps the sandbox, unlike stopping the sandbox in the Modal panel. One note under the composer says why a run stopped or takes no message now: the model failure it is paused on, with what to do next and a link to Settings, Model providers when that is where (record 15); otherwise the key its next message needs; otherwise that its sandbox is still running or being replaced. A submitted message reuses one command identifier until it is accepted, and the draft is kept locally per session.

The strip is one row: the repository and the branch on the left, one agent chip on the right. The owner chose this on 2026-10-11 over a strip of six controls (`docs/decisions.md`).

- **Repository** on Home; a session's strip names its repository.
- **Branch** on Home only (record 07, "Choosing the branch").
- **Agent chip** (`AgentChip.tsx`): one control for which harness runs, which model it drives, and at what effort. Closed, it shows the model's name under its provider's mark, the effort muted beside it, and a chevron, for example "Opus 5.5 medium", and is named for assistive technology "Model: Opus 5.5, medium effort". Open, it is one panel, 272 pixels wide, holding up to three groups, top to bottom. It stays open after a choice of harness, which can move the model, and of effort; picking a model closes it, so it never covers Send. The owner asked on 2026-10-13 for the panel to be smaller (`docs/decisions.md`):
  - **Run with** (`RuntimePicker.tsx`): shown only where this deployment offers two or more harnesses, since with one there is no choice to show. It lists each offered harness with its mark, name, and a check on the chosen one, and a small Connect to Settings, Harnesses for one whose key is missing. A harness the deployment has not enabled is not listed here; Settings, Harnesses still shows it as "Not available yet". A harness the image does not install is listed nowhere. The choice goes on the create request only when the operator enables more than one harness. A session keeps its harness, so there the group is one line of text, its own harness with "Fixed for this session", and nothing can be chosen or followed.
  - **Model** (`ModelPicker.tsx`): every model of every provider once, never with a key's label, as provider mark, name, and check, with a Connect to Settings, Model providers for a provider with no key. A provider whose key stopped working has its models greyed, each with the reason in words ("Key rejected") and Replace, a link to the same page; none of them can be chosen (record 15). The Claude mark is drawn in its own colour here, on the chip, and on Claude Code's row. Choosing a harness that cannot run the chosen model moves to one it can, and the reverse. On Home the recommended model is selected until the user picks another, and the browser remembers the last choice per workspace. In a session the group names the current run's model as text while a run is working. Between runs, and on a paused or interrupted run, it lists the workspace's models as on Home, and choosing another is carried by the next message, with a note under the composer saying so (record 15, "Changing the model within a session").
  - **Effort** (`EffortPicker.tsx`): one row of buttons, a button per level, over the model's own levels in the provider's words and the catalog's order (four, five, or six of them), the chosen one raised and pressed; each button is as wide as its word, so six fit one row at the panel's width on a 320-pixel screen. A model with no effort parameter gets the line "<model> has no effort setting." in place of the row, and the chip then shows the model's name alone. Switching models keeps the composer's one rule: a chosen level applies only to the model it was chosen for, so another model starts on its own catalog default rather than a level it may not offer. On Home it sets the first run's effort; in a session it sets the next run's, so a queued message or a new run may change it and a steer never does (records 06 and 15).

  The panel is a dialog, not a menu, because it stays open after a choice of harness or effort. Focus enters at its first row, the up and down arrows move between rows and on into the effort's levels, Tab reaches every row and level, and Escape closes it and returns to the chip. The panel opens directly below the chip, or above it where there is more room, with its end on the chip's end, and never beside it. It is capped to the room on that side, and the model list scrolls inside it, so "Run with" where it is shown, the "Model" heading, and the effort stay in view; on a screen under 640 pixels tall its rows tighten to leave the list a row. With no choice of harness, no model connection, and nothing a key would unlock, the chip reads "No model connected" and does not open.

The strip never folds or wraps. Its controls shorten by the strip's own width (a CSS size container), not the window's, since the side panel narrows the pane: below 560 pixels the repository shows only the part after the slash; below 460 the chip drops the effort and keeps the model's name; below 400 the repository and branch lose their chevrons and all three tighten their padding. Past that the repository's name truncates first, down to a floor, then the branch's label; the chip never shrinks below its words and truncates the model's name only beyond half the strip. `e2e/composer-bar.spec.ts` holds this at 1280, 768, 375, and 320 pixels on Home and in a session, in both themes.

The composer does not show the sandbox. Its state, its duration, why it stopped ("Stopped after going idle", "Lost"), a keep-alive's end, and "Stop sandbox" are in the side panel's Modal tab, reached from the header's toggle.

Beside and below the box:

- **Add menu (+):** "Add photos and files", and "Skip required checks", a toggle for the next message only, shown as a chip while on, sent as the structured `skipRequiredChecks` flag, cleared once a send is accepted, and meaning the run cannot end verified (record 14).
- **Approvals:** not in the strip but on its own line directly below the composer box, at the left: how the agent's own permission asks are answered (record 09). It names the mode in force in plain words ("Allow once", "This session", "Always allow"), with no icon, and opens "How should agent actions be approved?" with three rows, each a name, a one-line description, and a check on the current one: Allow once ("Ask me each time the agent needs something outside the usual."), Allow for this session ("Don't ask again in this session."), and Always allow ("Don't ask in any session. You can change this in Settings."). When the workspace's setting cannot be read it says "Approvals" and checks no row. On Home it shows the mode the next session starts with; in a session it sends `approval.mode` and saves the workspace's half (`features/approvals/ApprovalModeMenu.tsx`). It is hidden for a harness with no permission gate (Codex, Pi).
- **Dictation and Send.**

Attachments come from the picker, a drop on the composer, or a paste (pasted text still types). Each file is checked in the browser with the protocol's rules before upload (PNG, JPEG, GIF, or WebP images up to 10 MB, PDFs and text files up to 5 MB, ten a message; `ATTACHMENT_LIMITS` in `packages/protocol/src/attachments.ts`) and again by the Worker. A strip above the message box shows an image thumbnail or a named chip for each file with its upload progress, a remove button, and the reason for a refusal. The message sends once every file has uploaded; a refused file holds the send until removed. On the timeline a message shows its images as thumbnails and other files as chips that download, served by the Worker to the session's owner. A thumbnail opens a viewer that steps through the message's images, closes with Escape, and offers Download.

Dictation uses the browser's own speech recognition and is not drawn where there is none (`use-dictation.ts`). Interim words appear in the box and a second click stops. OnCue receives no audio, only the sent text, and the tooltip says the browser's service hears it.

### Context meter

Under the chat box's bottom-right corner, its own control rather than one of the composer's, a session shows a ring and a percent that fill as the conversation fills the model's window, turning caution at 80 percent and danger at 95 (`features/session/ContextMeter.tsx`). It is a button named, for example, "Context: 33% of 200k used". Before a chat starts, Home shows the same ring empty and "0%" in the same place, across from the approvals picker (`ContextMeterAtRest`). There it is a reading named "Context: 0% used", not a button: with no conversation there is nothing to break down, and its tooltip says the context is empty until the first answer.

Its popover is headed "Context window" with used / window (percent), for example "623.3k / 1M (62%)", and a chevron; under it one bar segmented by part over a track of free space, then the session's estimated cost at the catalog's list prices, cache prices included, marked as an estimate. Clicking the header expands one row per part, each with its colour, its tokens, and its share of the window to one decimal ("1.0%", "0.0%"); the header's own percent is whole: System prompt, Tools (the harness's own, with the provider's tool-use preamble), OnCue tools (`oncue_*`), Conversation in the blue, and Free space. A part the prompt does not have is left out. The rows stay open across openings. Where the harness's compaction rule is known (OpenCode 1.18.30, record 04), a line says how far the conversation is from it, for example "120k until auto-compact".

Every number is exact or absent, never estimated. The size is the primary agent's latest answer's `usage.usedTokens` in the current sandbox generation (record 04); a subagent's answers, which carry its `agentId`, are its own conversation and never size the gauge or read as a compaction, though the cost counts them (record 12, "Subagents"). It is the provider's own total; the system prompt and the two kinds of tools are the provider's own counts from the Model Broker (record 06); the conversation is the size less those, so the rows sum to the size exactly. When the broker had not counted a prompt by its answer, which is usual for a session's first answer and after a prompt changes, the popover says "Breakdown appears after the next answer."; when the broker could not count it (repeated failures, a rate limit, or the session's budget) it says "Breakdown unavailable for now."; and an answer whose call carried no counts, such as one without tools, says "No breakdown for this answer." A provider whose counter OnCue does not use (OpenAI, so far) shows the size and says a breakdown isn't available for it. The view derivation is `features/session/context-meter.ts`: the ring is empty until the first answer and starts over when a new generation starts the conversation from the session's summary, which the popover says; an answer that reports no tokens (one cancelled before its call answered) is skipped; and a fall of more than a quarter in a call's input (uncached, cache read, and cache write, leaving out output and reasoning, which a provider drops from the next call) between two answers in one generation is read as the harness compacting, which the popover notes from what size to what. The estimate says it runs low when an OpenAI call read past the 272K tokens OpenAI's short-context prices cover. There are no plan limits, since each person brings their own key. The window is the latest answer's own `maxTokens`, or the catalog's for the run's model before any answer. After a change of model it is the catalog's window for the model that reads the conversation next, from the moment that model is chosen until its first answer, and the earlier model's compaction point is not shown (record 15).

## Side panel

Specialized views open beside the timeline in one side panel with a tab per view (`features/session/SessionPanel.tsx`). The header's toggle opens the panel on a list of its views, never on a view the reader did not choose; choosing one opens it as a tab, and the panel's `+` offers every tab not yet open. Closing the last tab returns to the list; only the panel's own close hides it. A control that names a view (a change card's Review, the rail's pull request line) opens that view directly; the Modal tab is opened from the list or the `+`. Opening, closing, and switching tabs change only screen state and send no command, and the timeline keeps the reader's row in place as the split narrows or widens. The sidebar, the conversation, and the panel share one background; a hairline is the only divider between them, and nothing is drawn under the header.

- **Modal:** the sandbox as Modal sees it, and the only place its state is shown: its state in words ("Starting", "Running", "Stopped", "Stopped after going idle", "Failed", or "Lost" when the control plane lost it), provider identifier, a live duration, "Kept alive until" a time while a keep-alive holds, its lifecycle steps with offsets, the controller's timings and everything the entrypoint printed while starting, verbatim and tagged by stream, "Stop sandbox" behind a confirmation, and "Keep running for an hour" while it runs (record 11).
- **Review:** the review panel, below.
- **Pull request:** the branch and its pull request (`PullRequestPane.tsx`). Before the first push the branch's name is chosen here, opening on the name the agent gave through `pull_request_describe`, else a suggestion `oncue/<slug>-<hex>` from the agent's latest words (`branch-suggestion.ts`, record 07); after it the name is fixed. The pull request is named and linked to GitHub, where it is read; nothing is edited here.
- **Terminal:** a read-only console of live or stored command output (`TerminalPane.tsx`): each tool call as a command line with its output, streaming while it runs, and each check with its result and a link to its log. It is not a shell and sends nothing into the sandbox.
- **Agents:** the session's subagents (`features/session/agents/AgentsPane.tsx`). **Running** lists each one newest first as a bordered row: its description; its type and a live duration ("General · 21s"); its model by the catalog's name, its tokens so far, its tool uses, and what it is doing now in words ("Running a command", "Reading a file", "Thinking"), each set apart by a middle dot; a "View transcript" link; and a stop button (a square) that sends `agent.stop` for it and reads "Stopping" from the press until its end arrives; the session screen keeps that state, so it survives switching tabs and opening a transcript and coming back, and any outcome but the object's acceptance (a refusal, no answer in time, not sent while reconnecting) frees the button and says why under the row. An accepted stop that has not ended the subagent within 15 seconds frees it too, with "It is still running. Try again.", because the bridge does not report an abort that failed and a second stop makes it try again; the subagent's end clears the state at once. **Finished N** is collapsible, each row its description, type, and "Completed", "Stopped", or "Failed", and a trash button clears the finished list for this screen (not the record). A row opens the subagent's detail: a back arrow and its description, then one line of "Model" and its name, type, and status with its duration, which wraps between those facts in a narrow panel and never cuts the status word, then the prompt the primary agent wrote, in a quiet block folded to about eight lines with "Show more" and "Show less", then its own steps drawn as the timeline draws the primary agent's (activity groups, its words beneath them), and once it ended what it reported. A subagent whose run ended without its own end being reported (a lost sandbox) shows the time up to the run's end. It updates live while the subagent runs. Each subagent's detail starts fresh, its prompt folded and scrolled to the top. Opening a detail moves focus to its heading, and the back arrow returns focus to that subagent's row in the list, or to the view itself when the row is no longer listed. Closing the Agents tab, or opening it from the list of views, returns to the list; a timeline row always opens its own subagent. Every string in it is the sandbox's and renders as text or as the same markdown an agent message does.
- **Preview:** not built. The tab says previews are not available yet (record 09).

### Review panel

The review panel splits the screen with the conversation through a resizable divider, half the width to start, and has two tabs, **Diff** and **Tests** (`features/diff/ReviewPanel.tsx`). It opens from the rail's changes line (all changes), a change card's Review (that turn), or an outcome row or the rail's outcome line (Tests). Patch and output text is untrusted and renders as text only.

**Diff** shows the diff chosen by a scope menu, "Last turn" or "All changes", with the totals and the branch and short commit. Each file is a section whose header stays in view, with its hunks line by line, a `+` or `-` in the gutter as well as colour, and unchanged runs the patch left out collapsed to "N unmodified lines". A diff that was uploaded as an artifact, was truncated, or runs past 3,000 lines (`MAX_RENDERED_DIFF_LINES`) reads "Diff too large to show here", lists the files with their counts, and offers "Download diff" when there is an artifact.

**Tests** lists every check the run recorded with its classification, result, duration, and attempts (each attempt when there was more than one), the base comparison when one ran, the output summary as preformatted text, and "Full output", which downloads the log through the Worker.

#### The file tree

Beside the diff, a file tree (`features/diff/ChangedFileTree.tsx`) shows the whole repository at the diff's head, from a listing the bridge uploads beside each diff (`diff.updated.tree`, one path per line, at most 20,000 paths; `MAX_TREE_PATHS` in `services/bridge/src/git.ts`). The session's changed files are marked, and a deleted file stays listed. Every folder starts closed; a folder holding changed files at any depth carries a small green dot and count whose accessible name is, for example, "contains 3 changed files". A typed filter shows its matches open, and a selected file opens its folders. Selecting a changed file scrolls the diff to it. Without a listing, the tree shows the changed files alone.

#### Viewing a file the session left alone

Selecting a file the session never changed, in any turn, shows it read-only in place of the diff, as the session's base commit has it (`features/diff/FileContentView.tsx`). The Worker reads it from GitHub (`GET /api/sessions/:id/files?path=`, `apps/web/worker/routes/session-files.ts`, record 03), so it shows while the sandbox is stopped. Text is drawn in the diff's type with line numbers, as text only, up to 5,000 lines; a raster image is drawn from its bytes; any other binary, and a file over 1 MiB, offers a download. A dead GitHub connection says to reconnect GitHub. A file an earlier turn changed is only named under "Last turn", since the base commit's copy is not what it is now.

## Status presentation

Session status is plain language derived from the latest run (`displayStatusOf` in `packages/protocol/src/view.ts`, words in `features/session/status.ts`):

Idle, Starting environment, Working, Waiting for approval, Waiting for you, Paused, Resuming, Verified, Completed with warnings, Done, Blocked, Failed, Cancelled.

The list covers every run outcome in record 14, the in-flight states a user sees before a run finishes, and Idle for a session with no run. "Waiting for you" is a run paused on a model failure, a lack of progress, or an expired approval, or any unfinished run while the agent's question is open. An interrupted run reads "Resuming" only when OnCue is replacing its sandbox and will resume it itself; any other interruption reads "Paused", because nothing resumes until the user continues.

The status drives what the rail asks for and what the composer offers. It is not printed in the header: during a start the fact a reader wants is the sandbox's, which the timeline's sandbox row and the side panel's Modal tab show with a live duration. When a status needs action, the rail says what is needed and the sidebar's mark says "Needs you". A model failure is also said on the timeline and under the composer, which are on screen while the rail is unpinned.

## Realtime and reconnect

Only committed session events render as durable history. Streaming may show partial content, but a reconnect resumes from the last applied sequence number and replays missed committed events before returning to live delivery. The connection states are Connecting, Live, Reconnecting, Caught up, and Offline, which reads "Offline · unsent message" when the composer holds unsent input (`ConnectionBadge.tsx`), so offline with unsent input reads differently from a plain disconnect. An unsent draft stays local, and a submitted message's command identifier stops a reconnect from creating a duplicate run.

At most one socket is live (`features/session/use-session.ts`). Opening one detaches and closes the last, and anything a detached socket does later is ignored. A handshake that has not opened in 10 seconds is abandoned. The backoff (500 ms doubling to 8 s) starts over only after a socket has stayed open for 10 seconds, so a server that accepts and closes at once is not redialled every half second. Coming back online redials at once unless a socket is already open. While the browser reports itself offline, a socket is still tried every 8 seconds, because `navigator.onLine` can be wrong and the `online` event may never come.

Every send is followed to the object's answer, and none fails silently (`features/session/use-commands.ts`):

- A message sent while disconnected is held and written when a socket opens. The box is read-only while it waits, a line under the composer says it will send on reconnect, and "Don't send" withdraws it before it leaves. While reconnecting with nothing held, the line says a message sent now waits for the connection. The command identifier makes the eventual send one message.
- A sent message with no answer in 15 seconds keeps its draft and identifier, and the line says it was not confirmed and that sending again cannot deliver it twice. A resend whose answer has since arrived settles at once.
- One-shot controls (Stop run, Run checks, Continue, the Git switch, policy Allow and Decline, approval Approve and Deny) are not held: a press while disconnected says it was not sent. Continue in particular starts a billed sandbox, so it never leaves late. Each is off while its command is out, so a double click is one command, stays off once accepted until the run, approval, or proposal it acted on changes, and is freed with the reason when the object refuses it or does not answer. A press after no answer reuses the unanswered command's identifier, so the object applies it at most once; any answer, or a send that never left, means the next press is a new command.

A code block shows its code as plain text until it is highlighted, and stays plain for a language shiki does not bundle or a grammar that fails to load. The review tree says when the repository listing could not be fetched, shows the changed files alone, and offers Retry.

## Visual language

Settings pages are bordered, not filled: a group of rows is a rounded border on the page background with a line between rows, never a panel of another colour. A status is a word in its tone ("Active" and "Connected" in green, "Disconnected" and "Not working" in red) with nothing drawn around it. The app has one accent, the composer's send button; every other button is neutral and bordered on the page background, so it reads the same in both themes. Destructive confirmations keep that chrome and colour only the word. The screens before Home, Clerk's sign-in included, follow the same rules.

Surfaces are neutral, borders thin, containers softly rounded, and shadows limited, with colour reserved for status, warnings, and actions. Light and dark themes use the same semantic tokens rather than separate component designs; the theme menu offers Light, Dark, and System.

## Responsive behavior

Desktop is the complete experience. On narrower screens the sidebar stays hidden until revealed, the rail starts unpinned and spans the width when shown, and the setup frame fits a 375-pixel phone. There is no separate mobile layout. Reading, messaging, stopping work, and answering approvals should work on a phone; full review and debugging may remain desktop-oriented.

## Accessibility

- Every primary action is keyboard reachable, and focus order follows the visible layout.
- Status never depends on colour alone.
- Motion respects reduced-motion preferences.
- Panels announce opening and closing to assistive technology.
- Timeline updates do not move keyboard focus.
- Text and controls meet contrast targets in both themes.

`apps/web/e2e/a11y.spec.ts` runs axe on Home and the session screen and fails on serious or critical findings.

## Not built yet

- Session search and renaming a session.
- Choosing a starting branch or revision (`../roadmap.md`).
- Showing permission and network policy in the rail.
- A pause control, a retry control, and a switch-model or retry control on a model failure.
- A File tab, a Browser evidence tab, and an Artifacts tab; an artifact is a timeline row that downloads it.
- Previews (record 09).
- An in-app notification center and browser notifications. When built, a notification opens the exact session and action, routine progress creates none, and browser notification text excludes source code, secrets, command output, and full comments.
- A designed sign-in screen; the product shows Clerk's own.

## Non-goals

Recreating a desktop IDE, a permanent multi-pane terminal layout, production dashboards, productivity scoring, social feeds or public session discovery, and complex workspace customization.

## Conditions for reconsideration

Revisit this design after usability testing shows whether the context rail, timeline density, side panel, and session navigation stay clear across long sessions and large diffs.
