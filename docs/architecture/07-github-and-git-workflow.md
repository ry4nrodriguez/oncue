# GitHub and Git workflow

**Status:** Approved foundation

## Purpose

The coding profile works on GitHub repositories, on an isolated branch per session, and produces changes a person reviews. Work must survive a sandbox stopping, and the agent must never be able to modify protected branches or merge its own changes.

## Decisions

- GitHub is the only source-control provider.
- Users connect repositories by installing a GitHub App and choosing which repositories it may reach.
- Each session pushes to exactly one branch: a new `oncue/` task branch named at its first push, or an existing branch the user chose at creation to work on directly.
- A session starts from an exact base commit on a branch the user chooses, the repository's default branch unless they pick another.
- Commits, pushes, and draft pull requests are governed by a per-session Git policy. A fresh session commits but neither pushes nor opens a pull request until the user turns those on.
- The agent may propose policy changes from the user's chat. Narrowing applies at once; widening needs the user's click.
- OnCue never pushes to the repository's default branch or a protected branch, force-pushes, merges, closes, or marks a pull request ready, deletes branches, creates releases, or changes repository settings.

## Why a GitHub App

A GitHub App gives repository-scoped installations and short-lived installation tokens, which are safer and easier to revoke than a pasted personal token or SSH key. Removing the installation, or a repository from it, stops new work there. GitHub code lives in `apps/web/worker/github/`; there is no general source-control provider interface, and GitLab or plain Git remotes would need one.

## GitHub App permissions

OnCue mints installation tokens for only two permissions, each narrowed to one repository: `contents` (read to clone and to read `.oncue/project.yaml`, write to push) and `pull_requests: write` with `contents: read` to open and update a draft pull request. The App's configured permission set lives in GitHub's App settings, not in this repository. It should hold no administration, environments, deployments, releases, organization, or secret-reading permission, and any new permission needs a documented product need.

The App cannot change workflow files. A push that adds or changes a file under `.github/workflows` is refused by GitHub and reported as `git.push.failed` with category `workflow_file_rejected` (`services/bridge/src/git.ts`). Nothing tells the agent about this limit in advance.

## Repository connection flow

1. The signed-in user chooses to connect GitHub.
2. GitHub runs the App installation flow.
3. The user selects repositories.
4. Because the App requests user authorization during installation, GitHub redirects to OnCue's callback with a code, which OnCue exchanges for a user access token.
5. OnCue calls `GET /user/installations` and `GET /user/installations/{installation_id}/repositories` with that token and links only installations and repositories the authenticated GitHub user can reach. The redirect's `installation_id` is never trusted on its own, since GitHub documents that it can be spoofed.
6. D1 stores the installation reference (`github_installation`), the verified GitHub user as an `external_identity` of the OnCue user (provider `github`), and the selected repositories (`repository_connection`). The user access and refresh tokens are sealed as credential envelopes under the same rules as model credentials (record 06).
7. Before each session start, OnCue refreshes the user token when it is within five minutes of expiry and, when the last verification is more than eight hours old (`INSTALLATION_REVERIFY_INTERVAL_MS`), confirms through the user-installations API that the user can still reach the installation and repository (`verifyInstallation` in `install.ts`). The same check runs before reading a repository's secret declaration or files for the session view. A running session is not re-verified.
8. If refresh or verification fails, including when GitHub is unreachable, the installation is disabled for new privileged operations and the user is asked to reconnect (`github_reverification_required`). There is no fallback to installation-only proof.
9. Verified webhooks keep the connection current (see "Webhooks and synchronization"). A webhook alone never adds an installation to a workspace.

OnCue stores installation and repository identifiers, never a permanent installation token. Installation tokens are minted per operation and actively revoked after completion or timeout; GitHub's one-hour expiry is only the fallback.

## One branch per session

When a session is created OnCue records the repository, the base branch, the exact base commit, and the Git policy. A session is the only OnCue writer to its branch. One branch per session gives clear ownership, reviewable diffs, and a durable recovery point, and keeps two agents from overwriting one working branch.

### Choosing the branch

The composer's branch control, beside the repository, offers two choices (`features/repositories/BranchPicker.tsx`):

- **Start from a branch.** The session starts from the chosen branch, the repository's default branch unless the user picks another, and pushes to a new `oncue/` task branch named at the first push. A protected branch is a fine place to start, since nothing pushes to it.
- **Work directly on a branch.** The user picks an existing branch, such as an earlier pull request's, and the session pushes to that branch instead of a new one. The open pull request whose head is that branch is adopted.

The control lists branches from `GET /api/repositories/:id/branches?q=` (`worker/routes/branches.ts`), which verifies the installation as the create route does and reads under a `contents: read` token narrowed to the repository and revoked afterwards. It reads at most three pages of 100 from GitHub's branch list (`listBranches` in `worker/github/branches.ts`), keeps the names containing the search, returns at most 50 with the default branch first and the rest in GitHub's order, says when it was cut short, and looks an exact name the pages did not reach up directly. GitHub's list carries no dates, so recency would cost a call per branch; the search narrows a long list instead. Only names the bridge can push (`refs/heads/` followed by `[A-Za-z0-9._/-]`, git's ref rules, no leading `-`; `isWorkableBranchName`) are listed or accepted. A listed branch is marked protected for classic protection or for an active branch ruleset with a guarding rule, matched from the rulesets' ref conditions (`readRulesetGuards`, at most 10 rulesets, more, or a full page of 100, reading as guarding everything); a listing GitHub will not describe the rulesets for is not offered. The browser reuses a listing for a minute per repository and search. A refused row stays focusable (`aria-disabled`) so its reason is reachable, and switching to working directly drops a chosen branch the listing shows as the default or protected. The list is a convenience; the create route decides.

The create request carries `branch` and `branchMode` (`new_branch` or `existing_branch`); omitting both means the default branch and a new task branch, as every session before the choice. The Worker reads the branch under the same read token as the project file (`readRepositoryDeclaration` in `worker/secrets/disclosure.ts`): `GET /repos/{owner}/{repo}/branches/{branch}` gives its tip, which becomes the base commit, and whether GitHub protects it. For a session working directly on the branch it also reads the default branch as GitHub holds it now, since the cached one may be stale. It refuses with `branch_refused` (409) and a reason:

- `default`: the branch is the repository's default branch;
- `protected`: GitHub reports `protected: true` for it (classic branch protection), or an active ruleset applies to it with any rule other than `creation`, `branch_name_pattern`, or `tag_name_pattern` (`GET /repos/{owner}/{repo}/rules/branches/{branch}`, `readBranchRules`). The check is inverted on purpose: those three govern creating or naming a branch, and every other type, `update`, `non_fast_forward`, `deletion`, `pull_request`, `required_status_checks`, `required_signatures`, `merge_queue`, commit and file rules, and any GitHub adds later, counts as guarding pushes (`PUSH_NEUTRAL_RULES`, `guardsPushes`). One page of 100 rules is read; a full page of neutral rules fails closed, since more may follow. Branch names are escaped segment by segment in every GitHub path (`branchPath`). The branch API's flag answers for classic protection only, so a ruleset whose bypass list names the App would otherwise go unseen;
- `unconfirmed` (502): GitHub would not say which rules apply. OnCue fails closed;
- `missing`: GitHub has no such branch (a 404, or a renamed branch answering for its old name);
- `in_use`: another session of the same GitHub repository, in any workspace and any state, holds it as its branch. The holder's session id is returned only when it is the caller's own, and the composer links to it.
- `deleting`: the holder is on its way to deletion. It still holds the branch, since its object keeps working until deletion closes it and removes its `session_index` row; the refusal says so and links nothing. The deletion job's receipt removes that row (record 19), and from then on another session can work on the branch. A deletion whose sandbox cannot be stopped keeps the branch held until it finishes (`../backlog.md`). An archived session keeps its row, so it keeps its branch.

The hold is judged and taken in one statement: the `session_index` insert writes the branch as `task_branch` only when no other holding row has it (`BRANCH_HOLDER_SQL` and the insert in `worker/routes/sessions.ts`, served by `idx_session_index_task_branch`, migration `0018_session_branch_choice.sql`), so two creates cannot both take a branch. A cheaper read of the same condition runs first, before attachments are claimed. A retry with the same command id reaches the same session; one that names another repository, mode, or branch is refused with `command_reused` rather than answered as the first (`sameBranchChoice`). Because sessions do not end, a branch an earlier session pushed to is held by that session; the person continues there.

`session_index.base_branch` records the branch the base commit was read from and `session_index.branch_mode` the mode; both are null on older rows, which read as the default branch and a new task branch.

### Working directly on an existing branch

The session object gets the branch as its task branch from creation (`session_repository.task_branch`) and a `session_existing_branch` row. Nothing names a branch at the first push, a name typed in the Pull request tab or given by the agent is ignored, and with no `task_branch_ref` row the branch counts as pushed, so every generation clones it at the last commit the session knows. Someone else's commits on top are kept, as on a task branch (see "Resuming after the branch moved"). The draft pull request targets the default branch read at creation, unless the branch's own pull request is adopted.

Whenever a push grant is minted, the publish's and the idle or ceiling checkpoint's, first sent or redelivered to a reconnecting bridge, the object asks GitHub again under a `contents: read` token it revokes at once (`confirmExistingBranch` in `worker/session/object/existing-branch.ts`): the branch must still exist, neither classic protection nor a guarding ruleset rule may cover it, and it must not have become the default branch. The reads share a 10-second budget (`CONFIRM_BUDGET_MS`), because the check runs inside a stop step whose lease is 30 seconds and ahead of a publish whose report must land within two minutes. Anything short of a clear yes in time, including an unreachable or slow GitHub, withholds the grant: the dispatch row is rejected so it is never redelivered, the checkpoint keeps the work as a patch bundle, and the object logs `session.existing_branch_push` with the reason. A withheld publish, a push the person asked for, also commits `git.push.withheld` with the reason and a sentence for the timeline and ends the publish failed, so no pull request describes unpushed work; an idle or ceiling checkpoint stays bundle-only. GitHub's protection would refuse some of these pushes itself, but a rule can exempt the App and the default branch may have none, so the object does not rely on it. The grant names exactly `refs/heads/<branch>`, as for a task branch.

Observed live on 2026-10-05: on a private repository of a free account, both `GET .../rules/branches/{branch}` and `GET .../rulesets` answer 403 "Upgrade to GitHub Pro or make this repository public to enable this feature" to the narrowed installation token. No ruleset can exist there, so that answer, matched on the JSON body's `message` field alone, reads as no rules (`RULESETS_NOT_IN_PLAN` in `worker/github/branches.ts`); any other refusal fails closed. **Unverified live:** that `GET /repos/{owner}/{repo}/rules/branches/{branch}` lists the rules of a ruleset whose bypass list includes the App (the endpoint documents active rules, not the caller's bypass), and that the installation's metadata access reads it and `GET /repos/{owner}/{repo}/rulesets` under the narrowed `contents: read` token. The GitHub double models GitHub's documented shapes. The probe that would confirm it, with the owner's approval since it changes repository settings: on the live-test repository, add a ruleset with an `update` rule on `refs/heads/live/guarded-*` and the App in its bypass list, create `live/guarded-1`, and check that the picker marks it protected, the create route refuses it with `protected`, and a session moved onto it by a ruleset added mid-session gets `git.push.withheld`.

OnCue still never force-pushes. A push the branch's tip has moved past is refused by GitHub as a non-fast-forward and reported as `git.push.failed` with category `non_fast_forward`; the work stays as a recovery patch.

### Naming the branch

A session has no task branch at creation, and nothing is created on GitHub then: the sandbox clones the base branch at the base commit, and `session_index.task_branch` stays null. The branch is named at the first push, the first moment it exists anywhere, so a session that never pushes leaves no branch behind.

`chooseBranchName` (`apps/web/worker/session/branch-naming.ts`) takes, in order: a name the person typed in the side panel's Pull request tab, a name the agent gave through `pull_request_describe`, and otherwise `oncue/<slug>-<4 hex>` with the slug from the first line of the latest run's summary (a checks-only run's is skipped) or the session title. `packages/protocol/src/branch-name.ts` says what a name may be. A typed or agent name is not suffixed unless another session of the same GitHub repository, in any workspace, already holds it, including one working directly on an existing branch of that name. Once named, a later description changes nothing.

Before any push grant is minted, the object writes the name to `session_index.task_branch` and awaits it, because the push webhook's incident rule reads the index to recognize the ref as a session's own. A session working directly on an existing branch has it there from creation. A failed write leaves the session unnamed and pushes nothing. The bridge learns the name from the push grant's ref.

A later generation clones the task branch only once a push has actually landed on it; a name minted for a push that found nothing to push has no ref behind it (the object's `task_branch_ref` row), so the next generation clones the base branch again and keeps the name.

### Resuming after the branch moved

Every generation clones one branch and must land on one commit: the base branch at the base commit until a push lands, then the task branch at the last pushed checkpoint (the git grant's head), with any saved patch bundle applied on top. The branch tip on GitHub may differ. When it does, `clone` in `services/bridge/src/git.ts` looks for the commit in the clone's history and, if it is missing, fetches it once by id with the same single-use token before the token is revoked. All of this happens before the tree is handed to the agent user, and the token reaches Git only on file descriptor 3. The token is revoked on every path out of `clone`, a failed clone included. The clone may run ten minutes and the fetch two (`CLONE_TIMEOUT_MS`, `FETCH_TIMEOUT_MS`), a push five (`PUSH_TIMEOUT_MS`), and a checkpoint's patch two minutes and 64 MiB (`PATCH_TIMEOUT_MS`, `PATCH_MAX_BYTES`, a failure past either rather than a partial patch); each bound kills the command's whole process group. A failed clone or push is classified from git's stderr with quoted URLs, paths, and refs removed, from the HTTP status git reports, and, for a push, from the summary of each refused ref in `--porcelain` output, never from a bare number or word that could be part of a commit id or a branch name (`classifyCloneFailure`, `classifyPushFailure`). A clone killed at its bound is reported as timed out, with a sentence saying the repository may be too large, not as a passing network failure.

- **The base branch moved on** (before the first push): the tree is checked out at the base commit on a local branch of the base branch's name, whichever branch the session started from. Merging the newer base is the agent's or the person's choice.
- **Someone pushed on top of the task branch,** or of the existing branch a session works on: the tree is at the newer tip, keeping their commits, and the saved edits are applied there; if they do not apply, the tree goes back to the session's own last push and they are applied on that, and GitHub will refuse the next push as a non-fast-forward rather than anything being overwritten.
- **The task branch was rewritten** but the checkpoint is still on GitHub: the tree is at the session's last push, and the next push is refused as a non-fast-forward.
- **The commit is gone from GitHub:** the boot fails with a sentence telling the person to start a new session from the branch as it is now.
- **The branch is gone:** the boot fails, asking the person to restore the branch on GitHub and send their message again. OnCue does not recreate it, because the idle checkpoint would then push a branch a person deleted.

A failed boot is not held against the session: the next message makes a new generation.

## Credential boundary for Git operations

Local Git needs no credential. Remote operations go through the bridge:

1. The user, the policy, or a stop asks for a clone, push, or pull-request action.
2. The session object checks the Git policy and session state.
3. For a clone or push, the control plane mints an installation token narrowed to the one repository and the minimum permission: `contents: read` to clone, `contents: write` to push. GitHub cannot narrow a token to a command or a branch.
4. The bridge user runs Git itself. The token never reaches the agent's shell through a credential helper or environment variable.
5. The token is revoked after the bridge reports or after a short timeout (ten minutes for a clone grant, two minutes for a push grant). For a push the bridge revokes the token itself on every path; the object revokes it again, and records GitHub's 401 on that second revocation as revoked once the bridge has reported.
6. Pull-request API calls run in the control plane under a separately narrowed token that never reaches the sandbox.
7. Results and revocation outcomes are recorded as events.

The App's private key and every permanent platform credential stay out of the sandbox.

### Checkpoints and snapshots

A checkpoint is taken when OnCue stops a sandbox for idleness or its lifetime ceiling, and for a publish; the user's own stop takes none. The object sends a `push` grant naming exactly `refs/heads/<task branch>`, then `checkpoint.create`.

By then the work tree belongs to the agent's Unix user, so the bridge builds commits in a private index and object directory of its own, reading the tree's objects through Git alternates. It reads nothing from the work tree's `.git` but objects, because a config, hook, or attributes file the agent wrote there could run code as the bridge or redirect the push. Every command runs with `GIT_DIR` set to a bridge-owned directory holding only `HEAD` and refs, global and system config off, and hooks, the filesystem monitor, and attributes disabled; patches are taken with external diff and textconv off. The agent's own `HEAD`, index, and refs are never changed. The push names the clone URL and a plain refspec, never a remote and never `--force`, and any ref other than the task branch is refused before a process starts. With no push grant, or when the push fails, the bridge uploads a recovery patch against the last pushed head, and `repository.checkpointed` says which happened: `branch_push`, `patch_bundle`, or `local_commit` when the upload failed too.

Review diffs come from the same machinery, never from the harness's report. The bridge snapshots the tree into the same object directory through a separate private index, kept between snapshots so a rebuild hashes only what changed, and compares commits only (the base, the run-start snapshot, the run-end snapshot, or a checkpoint head). Each file carries its status (added, modified, deleted, or renamed with its old path) and line counts. One measurement stops after 60 seconds, reads at most 5 MiB of patch (setting `truncated`), and reads at most 16 MiB of each listing (`DIFF_BOUNDS`, `MAX_LISTING_BYTES`). When and how large these events are is record 04's.

### The incident rule

A `contents: write` token can push to any unprotected branch; its fields do not name a ref. Branch confinement therefore comes from the bridge's exact-ref check, GitHub branch protection (recommended on the base branch), token revocation, and push-webhook auditing.

GitHub sends a push webhook for every push by anyone, so the rule applies only when the sender is the App's own bot (`<slug>[bot]`, type `Bot`) and the ref is no session's branch in that repository: a task branch once named, or the existing branch a session works on, written to `session_index.task_branch` at creation. The branch a session merely started from is not its own. A person's push is not an incident. A deleted session's branch stays on GitHub while its `session_index` row goes, so a ref no live session holds whose hash a deletion receipt of the last three days holds also counts as a session's branch (`wasReleasedRef` in `apps/web/worker/deletion/released-refs.ts`, record 19): a push delivered late or redelivered after the deletion is not an incident. A live session's row is read first, so a session that took the branch over is recognised as its holder whatever a receipt says. A token is scoped to a repository, not a session, so every active or archived session of the repository (at most 25 per delivery, `MAX_INCIDENT_SESSIONS`) is locked down; an archived one is included because its archive checkpoint may still be pushing and because it pushes again once restored. For each, its policy becomes `push: never` and `pullRequest: never` by `system`, which also withholds the next checkpoint's push grant, and a live sandbox is stopped through the user's stop path, which takes no checkpoint and revokes every credential. The session keeps its state, active or archived, and pushes again only after the user widens the policy. The operator's alert is an `error` log line with operation `github.incident.foreign_push` and no payload text.

## Default Git behavior

A fresh session's policy is `commit: auto`, `push: manual`, `pullRequest: manual` (`DEFAULT_SESSION_POLICY` in `apps/web/worker/policy/git-policy.ts`). `manual` means off until the user turns it on. `push: auto` pushes after each run that ends verified, with warnings, or Done, once some run's checks cover the code (record 04, "Publishing"). `pullRequest: auto_after_verification` opens or updates a draft after such a push, and needs `push: auto` too.

The idle and ceiling checkpoint is the object's own durability push, not the user's, and it goes to the task branch under `push: manual` too. Only `push: never` stops it; then the work is kept as a patch bundle.

Once the user has turned pushing and pull requests on, a session works only on its branch, commits at coherent checkpoints, pushes them, runs the required checks before calling a change ready, keeps its draft pull request a draft, and never merges.

## User control through chat

The user can change Git behaviour in ordinary words: "do not commit until I tell you", "push the branch but do not open a pull request", "open a draft pull request after the tests pass", "do not push anything from this session". The agent turns these into its `policy_propose` tool with the fields to change and a rationale; the session object owns the policy (record 04 has the protocol). Narrowing takes effect at once. Widening waits for the user to confirm the exact change with one click, and no remote action relies on a pending proposal. The rail's controls write the same policy directly. An ambiguous instruction should make the agent ask rather than propose.

## Commits

The agent commits as it goes through the `git_commit` tool, which takes a message. The bridge's own Git makes the commit: a snapshot of the work tree parented on the agent's previous commit in this generation, or on the durable head for the first, so the commits form a chain that the next push carries with the agent's messages. The tool answers once the commit exists, and each commit is reported as `git.committed` with `authorType: agent`, the message, the files, and the verification state at the time of commit. It pushes nothing. A publish's own snapshot commit, made because the user's push policy asked for the push, is reported with `authorType: user`, since asking for the push is consent to commit what it carries; the author recorded in Git is `OnCue` either way.

`stepCommitTool` (`services/bridge/src/agent.ts`) refuses when no run is active, when the policy the object last sent says `commit: manual` or no policy has arrived yet, while a checkpoint or another commit is in progress, and after 30 commits in a run. The object stores a reported agent commit only while its run is live, at most 50 a run (`run_commit_count`), and tells a publish's own commit apart by the publish it has open. Commits the agent makes with `git commit` in its shell are never pushed.

A publish or checkpoint commits its snapshot on top of the chain when the tree changed since the agent's last commit; an unchanged tree adds no commit and the push carries the chain as it stands. A patch bundle is measured from the durable head, so it holds the chain's content without its messages. A chain never pushed is lost with the sandbox, as any unpushed work is; the idle checkpoint normally pushes it. A publish's own commit message is the title the agent gave through `pull_request_describe`, or else the first line of the first unpushed instruction, cut to 72 characters. Every commit the bridge makes has the author `OnCue <checkpoint@oncue.invalid>` (`CHECKPOINT_AUTHOR`).

`commit: manual` governs the agent's commits only. A user-directed push still commits the snapshot it pushes, since asking for the push is consent to commit it, and the durability checkpoint still commits under `commit: manual`.

Every message the bridge commits passes through `cleanCommitMessage` (`services/bridge/src/commit-message.ts`): control and format characters are removed (newlines and tabs kept), and every trailer that names a person (`Co-authored-by:`, `Signed-off-by:`, any `...-by:`, `Cc:`) is dropped, because GitHub credits a co-author's address and the others claim a sign-off nobody gave. `git_commit` cleans before it measures, so a message that is only a trailer is refused as blank; a snapshot left with no message is named "Update from OnCue".

OnCue never force-pushes, so a pushed commit is corrected with another commit.

## Draft pull requests

After a publish, under a policy that allows it, the control plane opens the session's draft pull request or updates the one it owns (`openOrUpdateDraft` in `apps/web/worker/github/pull-requests.ts`), under a token narrowed to the repository with `pull_requests: write` and `contents: read` and revoked in a `finally`. The title and body are the agent's from `pull_request_describe` when it gave them, cleaned by the control plane (`cleanDescription`, record 14), and otherwise come from the session. The verification section is built from the session object's own check records for the covering run and sits between the markers `<!-- oncue:verification:start -->` and `<!-- oncue:verification:end -->`; a later update replaces only that span and keeps what a person wrote around it, and a body whose markers were removed gets the section appended. A branch with nothing ahead of its base opens nothing. A failed publish opens nothing. When GitHub answers that a pull request with the same head and base already exists, the session adopts it. On an existing branch the user chose, the open pull requests for the head are listed before anything is opened (`adoptOpenPullRequest`), because GitHub refuses only an exact head-and-base duplicate and a person's pull request into another base would not stop a second draft: exactly one is adopted, keeping the person's title, description, and base while OnCue writes only its verification section (`session_existing_branch.pull_request_adopted`); several open nothing and are logged as `ambiguous`, since which one the person meant cannot be told; none opens a draft into the default branch. The session records the adopted pull request's draft state as GitHub reports it. OnCue never marks the pull request ready, merges, closes, or deletes its branch.

The same pull request is updated as later work is pushed. Importing review feedback into the session is not built (record 16).

## Base-branch changes and conflicts

The base branch may advance during a session. The bridge never fetches after the clone, so `repository.status` always reports `behind: 0` and OnCue does not track the latest base. The user can ask the agent to merge or rebase on the session branch, resolve conflicts, and rerun checks; a pushed branch is never rewritten.

If GitHub refuses a push, the checkpoint keeps the work as a recovery patch in R2 rather than retrying.

## Removing a repository

Which repositories the App can reach is chosen on GitHub. Settings, Repositories also offers Remove, for someone who granted the App a whole account and wants OnCue to show only some repositories. Removal sets `repository_connection.removed_at` (migration `0013_repository_removed.sql`), hides the repository, and refuses new sessions on it (`resolveRepository` answers `not_connected`); existing sessions keep their history. It is a timestamp rather than a status because the connection flow's re-sync rewrites `status` and must not undo it. The dialog says the App keeps its GitHub access. Removed repositories are listed with Restore (`DELETE /api/repositories/:id`, `POST /api/repositories/:id/restore`). Only a repository the App lost reads "Disconnected".

## Webhooks and synchronization

Verified GitHub webhooks update repository and pull-request state in D1 (`apps/web/worker/github/webhooks.ts`). The `sha256=` signature is checked before anything else, and each delivery id is recorded in `webhook_delivery` so a redelivery is safe. Five events are handled:

- `github_app_authorization`: revocation disables the user's GitHub link.
- `installation`: deletion or suspension disables the installation; accepting new permissions refreshes metadata but never adds an installation to a workspace without the verified user-link flow.
- `installation_repositories`: removed repositories are disabled; the rest are untouched.
- `push`: the incident rule above.
- `pull_request`: `closed` (merged or not), `reopened`, `ready_for_review`, and `converted_to_draft` reach the session through `session_index.pull_request_number` (migration `0007_pull_requests.sql`), and the session commits `pull_request.state_changed` once per real change. The number is written the first time the session learns it, whether it opened the pull request or adopted the one GitHub already had for its branch. Once a person closes or merges it, the session never writes to it again and opens no second one. A delivery GitHub never made leaves the session's view stale.

GitHub is authoritative for GitHub state; session events are authoritative for what the agent attempted and observed. A reconciliation action that refreshes stale projections when webhooks lag is not built.

## Not built yet

- Switching branch during a session; the branch is fixed at creation.
- Telling the person, rather than only the log, when several open pull requests for an existing branch kept the session from adopting one.
- Ordering the branch list by recent activity.
- Re-verifying the installation during a running session.
- Tracking the latest base commit.
- Review, comment, and check webhooks, and importing review feedback (record 16).
- Webhook reconciliation.

## Deferred

Automatic merging, direct pushes to base branches, force pushes, branch deletion, releases, deployments, repository or organization administration, GitHub Actions secrets, other source-control providers, several sessions writing one branch, and attaching a session to an existing pull request other than the open one for the branch it works on.

## Conditions for reconsideration

Revisit when workspaces become collaborative, when unrelated existing pull requests become a common starting point, or when other source-control providers become a product requirement.
