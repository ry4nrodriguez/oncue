# Permissions, networking, and previews

**Status:** Approved foundation

## Purpose

OnCue should do useful work without asking before every command, and it should stop an agent from turning ordinary coding authority into access to private infrastructure or irreversible external actions. This record defines the permission tiers, how chat instructions become durable policy, the sandbox's outbound network policy, and the rules for application previews, which are not built yet.

## Key decisions

- Local, reversible development work runs without interrupting the user.
- Remote but reviewable Git actions follow the session's Git policy.
- Sensitive actions pause for the user's explicit approval. Approval is never inferred from silence or from a model saying the user agreed.
- Some actions are prohibited outright, whatever the model asks.
- Public HTTPS is open by default for research, documentation, packages, GitHub, and public development APIs. Private networks and cloud metadata endpoints are unreachable from repository code.
- Public OnCue and Modal endpoints are reachable over the network but useless without narrowly scoped credentials. They are protected by authorization, not by network invisibility.
- Natural-language instructions that change permissions change control-plane state, not only the model's conversation. A model tool call cannot grant authority by itself.
- Application previews, when built, pass through OnCue authentication on a browser origin separate from the application. A raw sandbox tunnel URL is never the product's preview URL.

## Permission tiers

`apps/web/worker/policy/tiers.ts` holds the tiers as a table (`TIER_ACTIONS`), in this record's order. `decideAction` answers `automatic` (tier 1), `follows_git_policy` (tier 2), `ask` or `allow` (an offered tier 3 action, depending on whether the session object holds the user's approval), or `refuse` with `not_offered`, `prohibited`, or `unknown_action`. The table covers what the control plane performs or supplies, and the coding agent's own permission asks ("Agent permissions" below). Inside the sandbox the agent has a shell, and OnCue does not put ordinary commands or file edits in the work tree behind approvals.

### Tier 1: automatic local work

Reading and searching the checkout, editing files on the session branch, running repository setup, installing development dependencies, starting declared local services, running tests, linters, type checks, and builds, using the development browser, collecting verification artifacts, reviewing local Git state, and creating local commits when the Git policy allows. This work stays inside the sandbox and is recoverable from the branch, checkpoints, or a replacement sandbox.

### Tier 2: remote but reviewable actions

Pushing the session's one branch (a new `oncue/` task branch, or the existing branch the user chose at creation to work on directly; record 07), creating or updating its draft pull request, and reading checks and pull-request state. These follow the session's Git policy (`apps/web/worker/policy/git-policy.ts`, record 07) rather than asking each time:

| Field | Values, least authority first | Default |
| --- | --- | --- |
| `commit` | `manual`, `auto` | `auto` |
| `push` | `never`, `manual`, `auto` | `manual` |
| `pullRequest` | `never`, `manual`, `auto_after_verification` | `manual` |

`commit: manual` stops the agent's own commits: the bridge's `git_commit` tool refuses while the policy it last received says `manual`, or before any policy has arrived, and tells the model why (`stepCommitTool` in `services/bridge/src/agent.ts`). A push the user directs still commits what it pushes, and the idle or lifetime checkpoint still commits and pushes under `push: manual`. Only `push: never` withholds the checkpoint's push grant (`allowsCheckpointPush`). Record 07, "Commits", gives the reasons.

### Tier 3: explicit approval

An action pauses when it crosses a boundary the defaults do not authorize. An approval names the exact action, target, session, scope, and expiry. The table lists nine such actions; the first six are offered:

- Supplying an optional development secret the user did not select at launch. The agent asks through the bridge's `secret_request` tool. The session object trusts only the name in the request, writes every field of the card itself, and expires it after ten minutes on its own clock (`APPROVAL_TTL_MS` in `apps/web/worker/session/approvals.ts`). A denied or expired request ends as `tool_denied` and the run continues without the value. An approval whose sandbox generation ended expires with `run_paused`; a decision never crosses a generation. Record 08 owns secrets.
- The coding agent's own permission asks: using files outside the project, reading a secret file, repeating the same call a third time in a row, starting a subagent, and any other ask its harness raises. "Agent permissions" below describes how they are answered.
- Enabling an unusual external development connection, expanding the network policy, and acting on an external system. These are refused as `not_offered`: the network policy is fixed when a sandbox is created and no external integration exists, so nothing could act on an approval.

### Tier 4: unavailable

Prohibited rather than approvable: production data or credentials, direct pushes to the repository's default branch or a protected branch, whether classic protection or a ruleset rule guards it (any rule type but `creation`, `branch_name_pattern`, and `tag_name_pattern` counts, record 07) (the create route refuses either as a branch to work on, failing closed when GitHub will not say which rules apply, and the object asks GitHub again whenever it mints a push grant; that the rules endpoint reports a ruleset whose bypass list names the App is unverified live, record 07), force pushes, merging pull requests, deleting remote branches or tags, creating releases or deployments, changing repository or organization settings, reading GitHub Actions secrets, reaching another user's workspace, sandbox, session, or artifact, and reaching OnCue administrative services from repository code. The credentials OnCue issues cannot do these things (record 07); the refusal in `decideAction` stops a card being offered for one. Each needs separate architecture before it could exist.

## Agent permissions

The harness asks before some actions on its own: OpenCode, under OnCue's configuration, asks before a tool uses a path outside the work tree (`external_directory`, which also covers paths named in common shell commands), before it reads a `.env` or `.env.*` file other than `.env.example` (`read`), and before the same call with the same input runs a third time in a row (`doom_loop`). Claude Code's `can_use_tool` prompts would be mapped the same way, but under OnCue's flags its file tools are allowed by name and never ask ("Harnesses" below). The bridge forwards each ask to the session object, which answers it; record 04 ("Approval flow") gives the wire. Before this, the bridge rejected every such ask unseen, so those reads and retries silently failed.

| Category | What asks | Card offers |
|---|---|---|
| Files outside the project (`outside_project`) | OpenCode `external_directory`; a Claude Code file tool on a path outside the work tree, or under `~` or a variable | Allow once, Allow for this session, Always allow, Deny |
| Secret files (`secret_file`) | OpenCode `read` of an env file; a Claude Code file tool (read, edit, write, search) on one; any ask whose resource names one | Allow once, Deny |
| Repeated action (`repeated_action`) | OpenCode `doom_loop` | Allow once, Allow for this session, Always allow, Deny |
| Starting a subagent (`start_subagent`) | OpenCode `task` for `general` or `explore` from the primary agent, within the run's limit (record 12, "Subagents") | Allow once, Allow for this session, Always allow, Deny |
| Other request (`other_request`) | anything else a harness asks | Allow once, Allow for this session, Always allow, Deny |

**Subagents.** A subagent's start is asked like any other category, so under Allow once it shows a card ("Start the explore subagent: Read the README", the description being the agent's own words) and under Allow for this session or Always allow it starts without one. It is never a secret-file ask: its resource is a built-in subagent's name and the agent's description of the task, which the object checks for that shape and refuses otherwise, so a description that mentions `.env` is still a start. The bridge refuses a start the run cannot take (a fifth running, a seventeenth in the run, a nested start, another agent's name) before it asks, with the words the model reads, so the user is never asked for a start that could not happen; a start waiting on a card holds one of the four places. A subagent's own asks (a path outside the project, a repeated call) are forwarded with its `agentId` and its own call, and the card names it ("Explore subagent: Read /etc/hosts, outside the project") when the object's `subagent` table holds it running, one keyed read made only for an ask that names one. A subagent's secret request is refused in the bridge, and OnCue's own tools are denied to subagents in OpenCode's configuration.

**Modes.** The approvals picker on its own line below the composer sets how asks are answered: **Allow once** (ask each time; the default), **Allow for this session** (don't ask again in this session), or **Always allow** (don't ask in any session). The mode covers every category except secret files, which always ask and are never saved. "Allow for this session" lives in the session object (`session_approval_mode`). "Always allow" is the workspace's default in D1 (`workspace_approval_setting`, migration 0017; migration 0021 lets a card's "Always allow" save `start_subagent` too), so it reaches every session, including ones already running. In a session a choice sends `approval.mode` for the session's half and saves the workspace's half through `PUT /api/approval-settings/default` (`always` for Always allow, `ask` otherwise), whose answer is the default now in force; the browser shows that answer, re-reads it when the window regains focus, and shows a neutral "Approvals" when it cannot read it, so the picker never shows a mode that is not in force. Saves are sent one at a time and the latest choice wins, and the write keeps the later of two choices that land out of order (`updated_at`). A session started with "Allow for this session" chosen on Home starts with it, carried in the create request. Choosing "Always allow" sets the session's own mode back to ask, so turning the default off later asks again; choosing "Allow once" or "Always allow" also clears the session's per-category "Allow for this session" answers. The picker is hidden for a harness with no permission gate (Codex and Pi).

**Cards.** When the mode asks, a card above the composer names what the agent wants in the object's words and offers the answers in the table. "Allow for this session" on a card saves a per-category rule in the session object (`session_approval_rule`); "Always allow" saves a per-category rule for the workspace (`workspace_approval_rule`), listed under Settings, Agent permissions, with Remove. The object decides each ask from the session's own mode and rules first, then the workspace's default and rules, read from D1 only when the session's rows do not answer; a D1 read that fails asks. The session's rows are read again inside the commit's transaction, so a mode chosen while D1 was read is the one applied. A resource that names a secret file is decided as `secret_file` whatever category the sandbox claimed. Every ask is a durable `approval.requested`; one answered by a saved choice commits with its `approval.resolved` (`automatic`) at once and never pauses the run. A run records at most 200 asks (`MAX_PERMISSION_ASKS_PER_RUN`); past that a saved choice still answers, without a record, so a long build under "Allow for this session" keeps going, and an ask that needs a card is refused. Neither past-the-cap answer counts toward closing the bridge's socket. A card nobody answers expires after ten minutes and denies. Tier 4 is unchanged: none of these answers reaches a force push, a base-branch push, a merge, deleting remote branches or tags, releases, settings, or Actions secrets, which the credentials cannot do. Pushes and pull requests stay under the session's Git policy, and development secrets keep their own card.

**What the answers bind.** The harness's gate is cooperative: anything the agent runs can answer it on loopback, and the agent's shell can read whatever its Unix user can read. The modes govern what the agent chooses to touch; the sandbox and its Unix users (record 02) remain the boundary. A denial reaches the model as the tool's error, with words telling it not to try another way, and the model goes on (`experimental.continue_loop_on_deny`; without it OpenCode ends the turn at a denied call). OpenCode answers one reject by rejecting every other pending ask of the session, so the bridge forwards none of them, and it forgets any request OpenCode reports settled (`permission.replied`). Denying a repeated action still ends the turn, because OpenCode asks it outside any tool and stops on the answer; the run ends as the agent stopping, not as a failure. A card that a reject from elsewhere settled while it was out stays until it is answered or expires, and the answer then reaches nothing; the object has no way to withdraw a card.

**Repository configuration.** OpenCode merges a repository's `opencode.json` and `.opencode/{agent,agents,mode,modes}/` files after OnCue's configuration, and resolves an agent's rules last match wins, so a committed `.opencode/agent/build.md` could re-allow questions, sub-agents, and paths outside the project. OpenCode is started with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which ignores every project source; `services/bridge/src/opencode-config-local.test.ts` resolves the agents against a hostile repository with the real binary. The switch also stops OpenCode finding the repository's `AGENTS.md` or `CLAUDE.md` by itself, so OnCue's configuration names both at the root of the work tree (OpenCode alone would read only the first it found). OpenCode also reads agent files from the agent's home at start; a sandbox's home is fresh from the image, nothing runs as the agent before OpenCode starts, and a running OpenCode does not reread them.

**Harnesses.** OpenCode is wired end to end. Claude Code's `can_use_tool` mapping is unit-tested only, and under OnCue's flags it is reachable only for tools outside `CLAUDE_ALLOWED_TOOLS` (`claude.ts`): `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `LS` are allowed by bare name, so Claude Code never asks before a path outside the work tree or an env file, and the outside-the-project and secret-file rows above do not fire for it (`../backlog.md` B18). Codex runs with approvals off and Pi has no permission system, so the mode has no effect on either, and the picker is not shown for them.

## Chat instructions become durable policy

When the user says something like "do not push" or "push this and open a draft PR", the agent calls the `policy_propose` tool with the triggering user message and the policy it wants. The bridge serves the tool on a loopback port (`services/bridge/src/tool-server.ts`) and reports the call as a `policy.proposed` event. The session object judges it against its own rows (`decideProposal`) and refuses it when no run is running, the message is not one the user sent in that run, the run already had five proposals admitted (`MAX_PROPOSALS_PER_RUN`), the policy version is stale, the proposal touches `planApproval` or `fileEdits`, or nothing changes.

The object computes the direction field by field from the stored policy and never trusts the proposal's own claim:

1. A narrowing change applies at once and the timeline says so.
2. A widening or mixed change is held as the one open proposal until the user answers the question above the composer (record 13). Allow sends `policy.set` with the proposal's id and the policy version the question was drawn from, so a superseded proposal or a moved policy confirms nothing (`decideConfirmation`).
3. The rail's Git control writes the same policy record directly; the control is its own confirmation (`decideControl`).

The bridge enforces only the policy the object sends it. If the instruction is unclear, the agent is told to ask rather than call the tool.

## Why public internet access is allowed

Coding work needs documentation, issue reports, web search, package registries, runtime downloads, GitHub, and public test APIs. Blocking the public internet would make the agent much less useful and cause routine setup failures.

The risk is not research. It is that repository code, a dependency, or a misdirected agent copies private source or a development secret to an outside address. OnCue limits the damage by keeping production credentials out of the product, keeping permanent model and GitHub credentials out of the sandbox (records 06 and 07), and blocking private and platform destinations.

## Outbound network boundary

Every sandbox is created with `NETWORK_POLICY = {"outbound_domain_allowlist": ["*"]}` and nothing else: no CIDR allowlist and no `block_network` key (`services/sandbox-controller/images.py`, asserted by `test_images.py`). The sandbox has no inbound port and no tunnel; the bridge dials out to the session Durable Object. Model requests go through the loopback relay to the Model Broker (record 06), and remote Git operations through the bridge under short-lived tokens (record 07). The sandbox is not attached to any private network shared with other sessions.

### Provider semantics

Modal's documentation states these rules. OnCue has tested only the ones the live test below covered:

- A domain allowlist permits TLS on port 443 to the listed domains only, and a bare `"*"` allows every domain.
- Non-TLS traffic (plain HTTP, raw TCP, UDP) to addresses not on a CIDR allowlist is blocked.
- Domain and CIDR allowlists combine additively.
- `block_network` cannot be combined with either allowlist.
- An allowlist can be changed on a running sandbox only if one was set at creation.

### Why no `0.0.0.0/0` CIDR entry

Creating every sandbox with `outbound_cidr_allowlist=["0.0.0.0/0"]` would keep the option of tightening a running sandbox later. OnCue does not do it: that entry permits every protocol to every address, including raw TCP, UDP, private ranges, and the metadata address, and the additive rule means the domain list would not constrain it. The cost is that a running sandbox's policy can never be tightened. When a policy change is needed, OnCue checkpoints and replaces the sandbox instead.

Modal's sidecar transparent proxy cannot be combined with a domain allowlist either, which is one more reason the bridge is isolated by Unix users rather than a sidecar (record 02).

### What the live test showed

The policy passed a live feasibility test in real Modal sandboxes (test A; `../history.md` has the date and the full matrix). HTTPS on 443 to public hosts works, and an authenticated public API is reachable and answers 401. DNS resolves through Modal's own resolver, which `/etc/resolv.conf` names first, while UDP DNS to public resolvers is blocked. Plain HTTP on 80, raw TCP, UDP, TLS on ports other than 443, every private and link-local range, and `169.254.169.254` are blocked. IPv6 addresses resolve but IPv6 egress appears unavailable. Later sessions showed a sandbox's bridge reaching the hosted Worker and a local quick tunnel over TLS, as this record expects.

Still unverified: where Modal records a denied connection, and whether the domain match is enforced on the TLS SNI (one probe suggested so).

### Tool channels are not a boundary

OnCue's four agent tools (`policy_propose`, `secret_request`, `pull_request_describe`, `git_commit`) reach the harness over a loopback channel: MCP from the bridge's tool server for OpenCode and Claude Code, Codex's own JSON-RPC channel as dynamic tools, and OnCue's Pi extension forwarding over HTTP for Pi. Anything the agent runs can reach these ports, because the agent's processes share a Unix user with the runtime. That is acceptable because no tool grants authority: each call is judged by the session object against its own rows.

Each harness is started with telemetry, update checks, and repository-supplied configuration turned off where it has them; OpenCode's and Claude Code's permission prompts stay on and are answered as "Agent permissions" describes. The Modal sandbox with its Unix-user split is the sandbox. What each harness sends over the all-domain HTTPS policy besides model requests has not been measured in a real sandbox (`../roadmap.md`).

## Provider maturity

Modal's domain allowlist is beta and changing a running sandbox's policy is alpha. OnCue sets the policy at creation and never depends on changing it live. An SDK upgrade or a change in the provider's allowlist semantics is a reason to rerun the network test.

## Previews

Not built. No preview is served and the side panel's Preview tab says so. The planned design: an authenticated per-session host on a preview origin separate from the application, embedded as a cross-origin frame with an open-in-new-tab fallback, with access checked on every request and invalidated when the sandbox generation changes. `../roadmap.md` holds the plan.

## Failure behavior

- **Public site unavailable:** report the failure; never change policy automatically.
- **Private destination requested:** the network blocks it; private access is unavailable.
- **Network policy cannot be applied or fails its test:** do not launch hosted sandboxes under a broader provider default; keep hosted admission blocked until a tested replacement is approved.
- **Policy proposal refused:** nothing changes and the agent is told why.

## Not built yet

- Approvals for the three unoffered tier 3 actions, and any special non-TLS development connection.
- Proposals that change `planApproval` or `fileEdits`; both fields are frozen at their defaults (`proceed`, `allowed`).
- Showing the permission and network policy in the context rail.
- Previews on their separate origin.
- A stricter per-repository mode that allows only named domains.

## References

- [Modal sandbox networking and security](https://modal.com/docs/guide/sandbox-networking)
- [Modal tunnel security](https://modal.com/docs/guide/tunnels)

## Conditions for reconsideration

Revisit this design if OnCue begins handling production credentials, connects to private company networks, supports untrusted public repositories at scale, or needs complete network audit logs. Those cases may need a dedicated egress gateway, stronger workload identity, and per-repository network policy.
