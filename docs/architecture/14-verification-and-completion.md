# Verification and completion

**Status:** Approved foundation

## Purpose

A confident agent message is not proof that a task is done. When a run changes files, the bridge runs the repository's checks in the sandbox and records what ran, how each attempt ended, and where its output is stored. The session object then decides whether those records support the outcome the sandbox claims.

## Key decisions

- Every run ends in one of six outcomes. Only `verified` claims the change works, and only the session object's own records can support it.
- Checks run at the end of a run that changed files, when the user asks, and before pushing code no run's checks cover. A run that changed no files runs none.
- The check set comes from the repository (`.oncue/project.yaml` or `package.json` scripts; record 08), not from the model.
- Failed, skipped, and inconclusive checks are disclosed in the timeline and the draft pull request, never hidden behind a later pass.
- The model cannot produce `verified` with text. This does not stop a compromised sandbox from reporting a false result; Unix-user separation inside the sandbox (record 02) bounds that risk.

## Outcome states

These are record 01's six run terminals (`RUN_OUTCOMES` in `packages/protocol/src/states.ts`).

### Verified

Every required check passed, in the sandbox that finished the run, at one revision, with its log stored. Event: `run.verified`.

### Completed with warnings

The change is prepared, but a check failed, was skipped, could not run, or was inconclusive, or there was no required check. Each warning names the check and a next action. Never shown as verified. Event: `run.completed_with_warnings`.

### Done

The run changed no files: it answered, explained, or planned. No checks ran and the run claims nothing about verification; the last change's checks still describe the code. The timeline row reads "No files changed, so no checks ran." Event: `run.completed`, displayed as "Done".

### Blocked, failed, cancelled

Blocked waits on the user, access, or a decision outside the agent's authority, such as a paused model failure (record 15). Failed names its stage, for example `verification`, and keeps diagnostic output. Cancelled was stopped by the user or the control plane. None makes a completion claim; work so far stays in the session.

## When checks run

`services/bridge/src/agent.ts` decides when and `services/bridge/src/verify.ts` decides what, identically for every harness (record 04).

### After a run that changed files

When the harness reports a running run idle, the bridge measures the turn's diff. Only a measured turn with no files counts as unchanged (`changedNoFiles`): a failed snapshot or an unmeasurable turn verifies anyway, because not knowing is not the same as nothing changing. A run with no repository, or an empty measured turn, ends `run.completed` with no `verification.*` events.

### Checks on request

The rail's "Run checks" sends `run.start` with `checksOnly`, queued with trigger `checks_requested`. The bridge prompts no one: it emits `run.started`, measures the tree, and verifies even when nothing changed, so it can end `verified`. The agent's conversation continues on the next message, and the work waiting to be pushed keeps its name. If the click resumes a stopped sandbox, the bridge keeps the resume's context summary for the next prompted run.

### Before a push (checks before publishing)

The publish gate (record 07) pushes only when some run's checks describe the code. `coverFor` in `apps/web/worker/session/publish-cover.ts` walks back from the run that asked:

| Run outcome | Decision |
| --- | --- |
| Done | Changed nothing; look further back |
| Done on a checks-only run | Held: a checks-only run always verifies, so this claim is not believed |
| `verified`, `completed_with_warnings` | Covered: its check records go in the pull request |
| `cancelled` | Unchecked: start a checks-only run ("Check the code before pushing it.") and publish when it ends |
| `cancelled` checks-only run | Held: checks the user stopped are not started again |
| `failed`, `blocked`, still open | Held |
| No run left | Unchecked |

## Check set

`planChecks` in `verify.ts`, in run order:

| Check | Class | Effect |
| --- | --- | --- |
| `install` (setup) | Informational | Runs first when a lockfile is committed (`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci`) as the agent user. If it fails, later checks are `skipped` with `environment_failed`. |
| `test`, `typecheck` | Required | All must pass for `verified` |
| `lint`, `build` | Recommended | Failure is a warning only |

`dev` is never a check. With no command declared nothing runs and the run ends `completed_with_warnings`. Each check records why it applies, for example "package.json has a test script". The image has npm and pnpm but not yarn, so a yarn install fails.

The composer's "Skip required checks" toggle sets `skipRequiredChecks` on `run.start` or `run.follow_up`; it is never read from message text. Required checks are then recorded `skipped` with `user_requested`, and the run cannot be verified.

## Verification record

Each attempt emits `verification.started` and `verification.result`, and the run ends with one `verification.completed` rollup (`packages/protocol/src/families/verification.ts`). A result records the check's id, name, category, class, command, and reason; the revision and sandbox generation; attempt, duration, and exit code; the result (`passed`, `failed`, `skipped`, `inconclusive`) with its skip or inconclusive reason; the base comparison; the last 4,000 characters of output; and the log artifact as evidence.

The revision is the working-tree snapshot taken just before verification, not the clone's starting commit. Each attempt's full output uploads as a `log` artifact (record 03), cut at 25 MiB. The result cites it only once the upload settled. A log whose upload grant does not arrive within two minutes (`LOG_GRANT_WAIT_MS`), or that would exceed the run's 100 MiB artifact budget, has no evidence, and the object then refuses `verified`. A check that cannot start is `skipped` with `could_not_run` and has no log.

## Flaky and inconclusive checks

A check gets at most two attempts, and only a failed `test` check gets the second. A pass on the second attempt is `inconclusive` with reason `flaky`, never `passed`. A check that reaches thirty minutes (`CHECK_TIMEOUT_MS`) is `inconclusive` with reason `timeout`, and is neither retried nor compared with the base. Every attempt keeps its own events and log.

## Baseline failures

When a required check fails, the bridge checks the session's base revision out under `/var/lib/oncue/base/`, installs from the lockfile if any, and re-runs that check there once, all within five minutes (`BASE_COMPARISON_BUDGET_MS`). The checkout is reused for a second failing check.

- Fails on base too: `reproduced_on_base`. The run ends `completed_with_warnings`.
- Passes on base: `new_failure`. The run ends `failed` at stage `verification`.
- Base cannot be built, or the re-run times out or cannot start: `not_comparable`, which ends `completed_with_warnings`.
- No base recorded: `not_compared`, which ends `failed`.

The base tree is read from objects in the agent-owned work tree, so a comparison only chooses between failed and completed with warnings; it never makes a run verified.

## Bounds

- At most ten checks per run, thirty minutes per attempt, two attempts per check, five minutes per base comparison.
- Verification runs before the terminal event, while the run is still `running`, and the object does not arm its idle stop for a running run (record 11).
- A cancel, checkpoint, or shutdown during verification sends SIGTERM to the check's process group and SIGKILL five seconds later, keeps the committed records, and emits nothing more.

## Completion gate

The bridge proposes an outcome (`proposedOutcome` in `verify.ts`): every required check's latest attempt passed gives `verified`; a newly failing required check gives `failed`; anything else gives `completed_with_warnings`.

`judgeVerifiedClaim` in `apps/web/worker/session/completion.ts` is the control plane's half. It reads the object's own `verification_check` and `run_verification` tables, written in the same transaction as the events that carry them, never the bridge's summary text. A `run.verified` is accepted only when:

- The run has not already ended.
- A `verification.completed` rollup exists from the attached generation and lists no user skip.
- At least one required check was recorded, and no fewer than the rollup claims.
- Each required check's newest attempt ran in the attached generation, passed, and cites a log whose upload finished.
- All required checks ran at one revision.
- The session did not start without a required development secret or with an unreadable project file (record 08).

Otherwise the claim is never stored: the object commits `run.completed_with_warnings` with one warning per failed condition (`REFUSAL_WARNINGS`), unless the run had already ended. After more than three refused claims on one socket (`MAX_OUTCOME_REFUSALS`) the object closes it with code 4001.

## User-facing completion summary

Every terminal event carries a `completionSummary` (`packages/protocol/src/families/lifecycle.ts`): what changed, why, verification performed, limitations, and an optional next step, with evidence, branch, pull-request number, usage, and duration. The timeline's outcome row shows the outcome and warnings; the review panel's Tests tab lists each check with its full output (record 13).

## Pull-request presentation

`verificationSection` in `apps/web/worker/github/pull-requests.ts` writes the draft pull request's section between `<!-- oncue:verification:start -->` and `<!-- oncue:verification:end -->`: a headline ("Every required check passed." or "This change is NOT fully verified. Read the warnings below."), the revision, required, recommended, and setup checks by newest attempt with result and attempt count, the covering run's warnings, and a link to the session. Results come from the object's rows.

Check names and warnings are the sandbox's words, so `apps/web/worker/github/agent-text.ts` cleans them before GitHub renders them: a name goes in a code span, cut at 80 characters; a warning becomes one line of at most 300 characters with URLs, mentions, and issue references in code spans, Markdown marks escaped, and angle brackets and invisible characters removed.

An update replaces everything from the first start marker through the last end marker, so a planted end marker cannot strand stale text. If a person removed the markers, the section is appended instead. Text outside the markers is kept.

Above the section is the agent's title and body from its `pull_request_describe` tool (record 07), or the session's title. `cleanDescription` keeps the Markdown but removes HTML comment markers, shows raw HTML as text, and puts mentions, issue references, and GitHub links in code spans, so a description cannot forge a marker, notify anyone, or close an issue. Other links are left to GitHub's sanitizer; the agent already writes the diff, so its description is no new channel. An update rewrites the description only when the agent gave a new one, and never over a body whose markers were removed.

## Limits

- When a publish pushed nothing new, the section's revision comes from the sandbox's own checkpoint report, so a lying sandbox can name a revision that was never pushed (`../backlog.md`).
- Verification logs are temporary artifacts recorded with an `expires_at` 90 days out, but nothing enforces the expiry yet, so no log is deleted (record 19; `../backlog.md`, A20). When expiry is built, the check rows that cite a log remain.
- A repository that declares trivial commands is verified by its own standard.

## Not built yet

- Change-aware checks the agent selects or promotes to required.
- Browser verification of frontend changes (run the app, exercise the change, capture screenshots). Nothing produces browser evidence.
- User instructions beyond the skip toggle, such as asking for an extra check or skipping one named check.
- Verification profiles for work other than coding.

See `../roadmap.md`. OnCue's own test policy is record 23.
