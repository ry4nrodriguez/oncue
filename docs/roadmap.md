# Roadmap

Planned work that is not built yet. Record 21 (`architecture/21-mvp-scope-and-completion-boundary.md`) defines when the MVP is complete; three plan steps remain before it is, and a few pieces of work are parked. Defects and smaller gaps in what exists are in [backlog.md](backlog.md); what already happened is in [history.md](history.md).

Plan-step ids (`PR-14` and so on) are stable keys that D1 migrations and [history.md](history.md) cite. They are not GitHub pull request numbers. PR-15's acceptance gate runs on the maintainer's own deployment, not yours.

Order: PR-14 can start now (its one dependency, PR-10, has merged). PR-15 needs PR-13 (merged) and PR-14. PR-16 needs PR-15 and a preview domain.

## Observability, emergency controls, and cross-storage deletion (PR-14)

**Goal.** Give the operator the three emergency controls record 22 requires, make session deletion real across every store (record 19), and finish the telemetry record 18 describes.

**Scope.**

- Operator endpoints to stop admission, terminate one session, and revoke one credential. They sit on a distinct route behind Cloudflare Access, require an operator allowlist and a fresh Clerk session together, take a reason and an idempotency key, and write an `audit_entry` row with the fields record 22 lists.
- Count active sandboxes per workspace and platform-wide so the concurrent-sandbox caps can fire (backlog A5), with an indexed query, not a scan (the Durable Object read-limit incident in [history.md](history.md)).
- Session deletion is built (record 19, `apps/web/worker/deletion/`). What remains for this step: showing a deletion that cannot finish (backlog A36), and deleting notification rows once they exist.
- Telemetry: trace context on every request, bounded metric labels, and an error reporter with record 18's strip list.
- One migration at the next free number: reserved `notification`, `push_subscription`, and `usage_summary` tables. The deletion receipt fields on `deletion_request` exist (migrations `0019` and `0022`). No notification center ships (record 17 defers it).

**Already in the code.**

- Admission: the single `platform_control` row (`apps/web/migrations/0001_core.sql`) with `run_admission` and both caps, read fail-closed by `readPlatformControl` and decided by `decideAdmission` (`apps/web/worker/admission.ts`) on both the create route and the session object. Nothing writes `run_admission`; both callers pass zero sandbox counts.
- Termination: the owner's stop, `POST /api/sessions/:id/sandbox/stop` (`apps/web/worker/routes/session-stop.ts`), runs through the object's one stop path (`beginStop` in `apps/web/worker/session/lifecycle.ts`) and revokes the session's credentials. An operator terminate can reuse it; today every route authorizes only the session's owner.
- Revocation: `POST /api/model-connections/:id/revoke`, `DELETE /api/modal-connection`, repository removal, and the GitHub webhook arms for revoked authorizations and deleted or suspended installations. There is no operator route and no way to revoke a GitHub installation from OnCue.
- Audit: `audit_entry` exists (`0001_core.sql`) with no writer.
- Deletion: `DELETE /api/sessions/:id` marks the session, tells its object, and starts the job that erases the object's storage, the D1 rows keyed by the session, and its R2 objects, then writes a receipt (`apps/web/worker/routes/session-delete.ts`, `apps/web/worker/deletion/job.ts`; record 19). Account deletion and artifact expiry are not built.
- Logging: `log()` (`apps/web/worker/log.ts`) accepts only allowlisted fields, rejected both at compile time and at run time. `traceId` and `requestId` are on the allowlist but nothing sets them. Workers Logs are enabled (`observability` in `apps/web/wrangler.jsonc`). No error reporter is installed.
- Coverage: `apps/web/vitest.config.ts` requires 100 percent branches on `worker/deletion/**`, which now holds the job.

**Acceptance.**

- A forced error produces one error-reporter event carrying the release and environment and no request body, cookie, or model content.
- Stopping admission through the operator route makes new sessions refuse while running ones continue, and writes an audit entry with the reason. Terminating one session by id stops its sandbox and runs record 22's steps. Revoking a model connection makes the broker refuse the next request. A valid Clerk session outside Cloudflare Access, or a non-operator identity inside it, gets 403.
- Deleting a session with artifacts leaves no R2 object under its key and no D1 rows, and writes one receipt. Killing the Worker mid-deletion and rerunning converges, with the receipt written once. A wrong-owner R2 object is left alone.
- A day of logs has no user id, repository name, or file path as a metric label.
- Unit tests cover each identity check passing alone, a repeated idempotency key, a missing reason, and a crash at each deletion step. Resume still works at the head.
- Perf: telemetry adds no more than 10 ms to p95 latency on `/api/sessions/:id` (200 requests, trunk against head, interleaved).

**Dependencies.** None open. It changes no sandbox image unless termination needs a bridge change.

## Deploy the hosted environment and pass the live acceptance gate (PR-15)

**Goal.** Make the hosted environment deployable in one ordered path and prove, against it, every requirement in record 21. This step earns the word "usable".

**Scope.**

- Extend `scripts/deploy-hosted.mjs` into record 20's ordered path: run the suites, build, record the revision, deploy the Worker and the Modal controller and image, run a hosted smoke test and end-to-end suite, and only then print `usable release=<sha>`. Any failed step stops the path.
- A hosted end-to-end suite (`apps/web/e2e/hosted/`) that walks record 21's nine steps against the hosted environment.
- A requirement coverage index that maps every record 21 requirement to a test and layer, a checker that fails on a missing, skipped, or quarantined test, and that checker added to `pnpm check`.
- Hosted configuration as Wrangler secrets and vars, never files: the user and operator allowlists, the caps, the broker keyring, and the tested network policy name.

**Already in the code.**

- The generated `apps/web/wrangler.hosted.json` (`apps/web/scripts/hosted-config.mjs`, from the gitignored `apps/web/deployment.json`) restates every binding a named environment does not inherit, sets `ONCUE_ENV` to `hosted`, binds the deployment's D1 and R2 bucket, and declares the five-minute cron trigger.
- `pnpm deploy:hosted` refuses without `ONCUE_ENV=hosted` or a complete deployment file, runs `pnpm check`, builds with `CLOUDFLARE_ENV=hosted`, refuses a built config that does not say `hosted` or does not bind the deployment file's database, runs the bundle guards, and deploys with the commit as `ONCUE_RELEASE`. It prints that the result is not yet usable. It deploys neither the controller nor migrations.
- The controller is deployed by hand (`uv run modal deploy app.py::controller_app` from `services/sandbox-controller`); `services/sandbox-controller/scripts/build_sandbox_image.py` pre-builds the image and `scripts/test_c_probe.py` reruns test C against a live sandbox.
- The local `walkthrough` lane (`apps/web/e2e/walkthrough.spec.ts`) already walks the nine steps against the doubles and a real OpenCode, and is the starting point for the hosted suite.
- The broker keyring is set on the hosted Worker (hosted sessions have run with saved keys).

**Acceptance.**

- `ONCUE_ENV=hosted pnpm deploy:hosted` ends with `usable release=<sha>` and the hosted URL serves sign-in.
- An allowlisted identity completes the nine steps on a representative repository, including stop and resume and a draft pull request, and a second full pass is green with nothing retried.
- A non-allowlisted identity creates no workspace and starts no compute.
- The network matrix and test C hold on a hosted sandbox, including test C with a supplied secret (backlog D2).
- Filling the platform cap refuses the next start before any Modal call (needs PR-14's counting).
- Stop and resume, a draft pull request with its verification section and a revoked token, and a deletion that leaves R2 and D1 clean while the GitHub branch remains, all on hosted.
- The coverage index maps every record 21 requirement to a passing test.
- Perf: hosted cold start median at most 120 s and hosted p95 API latency at most 300 ms, recorded beside the local numbers.

**Dependencies and prerequisites.**

- PR-14.
- The hosted Worker and controller run a recent release with every migration applied, and test C passes on a sandbox from that image.
- The operator confirms the GitHub App's callback and webhook URLs point at the hosted Worker (backlog D2).
- Before anyone but its operator uses a deployment: its Cloudflare account should be on Workers Paid with a budget alert, because on Workers Free any daily limit blocks the whole account. The image no longer has to be warmed by hand in each user's Modal workspace: it is prepared there at Modal connect, after a release, and before every create (record 02, "Images and startup"), once the hosted Worker and controller run that change.

## Serve previews on a separate origin (PR-16)

**Goal.** The side panel's Preview tab shows the repository's running dev server, with reload, full screen, and open in a new tab, while repository code never runs on OnCue's origin or sees its cookies. This step is outside the record 21 completion gate and ordered last so the gate does not wait on it.

**Design.** A feasibility spike on real Modal and a full design are on GitHub #52's branch (open, unmerged). Record 09's "Previews" section states the rules at a high level; the full design moves there when #52 merges or this step starts (backlog C5). In short:

- A dedicated registrable domain used only for previews, one host per session (`<session>.<preview-domain>`), served by a second Worker (`apps/preview/`). `workers.dev` cannot be used: it is one site for cookies, so the app's cookies would ride along on preview requests.
- The app mints a single-use code bound to user, session, generation, host, and a 60-second expiry; the preview Worker redeems it once against the session object and sets its own `__Host-`, `Secure; HttpOnly; SameSite=None; Partitioned` cookie. The app cookie never reaches the preview host.
- The preview Worker forwards HTTP and WebSocket traffic through a Modal connect token scoped to the sandbox and port, sent as Modal's cookie so the sandbox never sees it. The spike showed a request without the token gets 401, a token dies with its sandbox, loopback is unreachable, and streaming, WebSockets, and Vite hot reload work. Modal's plain tunnels are never used: they give anyone a public URL.
- The dev server starts on the person's click through a new supervisor request, as the agent user, behind a small relay inside the sandbox. Access ends on stop, idle stop, a new generation, stopping the preview, or the cookie's expiry. A preview request is activity for the idle timer; an idle WebSocket is not.
- Suggested split: the preview process in the sandbox (image change, new test C probes); the domain and Worker skeleton; codes, grants, and tokens; the finished Preview tab with a three-browser Playwright lane; then the live lanes.

**Already in the code.** The Preview tab is a placeholder (`COMING` in `apps/web/src/features/session/SessionPanel.tsx`). The bridge already parses the `preview` key of `.oncue/project.yaml` (port and health path; `services/bridge/src/repo-config.ts`). The controller exposes no inbound port (`connection_url` in `services/sandbox-controller/sandboxes.py`).

**Acceptance.** The preview renders in Chromium and Firefox, and in WebKit either renders or falls back to a new tab. The app cookie is absent from preview requests and invisible to preview JavaScript, and the app API is unauthenticated from it. A reused code, another user, a stopped session, a replaced generation, and a raw tunnel URL are all refused. Perf: median open at most 3 s and forwarding overhead at most 80 ms. Unit tests cover code reuse, expiry, wrong host, wrong generation, and wrong user. The operator reviews screenshots and a short video before merge.

**Dependencies.** PR-15, and the owner buying the preview domain. Untested so far: tokens older than 20 minutes, streaming through Cloudflare's edge, and real browsers.

## Completion gaps no step owns

Record 21 lists a gap that no plan step covers: revoking the GitHub App installation from inside OnCue. It is tracked with the other unscheduled controls in backlog A20.

## Parked work

### Agent speed (GitHub #51)

Open and unmerged. It measured real Modal sessions: a new session takes about 20 s, about 10 s of it before the model hears the task, and 5 s of that is one OpenCode health probe that hangs to its full 5-second timeout on 10 of 11 starts. A follow-up in a running sandbox takes 4 to 5 s, nearly all model time; a resume after an idle stop is a full cold start. It ranks eleven fixes. The cheapest is a short timeout for the health probe (still `REQUEST_TIMEOUT_MS` in `services/bridge/src/opencode.ts`). Larger ones are installing dependencies in the background at start, showing the answer before the checks finish, keeping sandboxes warm longer or resuming warm, caching dependencies, and running independent checks side by side. Two need owner decisions: whether the answer shows before checks, and how long to keep a sandbox. The branch also adds broker timing fields that are not on `main`. It found backlog A23 and B15.

### Previews (GitHub #52)

Open and unmerged, waiting on the preview domain. Its spike and design are summarized under PR-16 above.

### Sub-agents, ask-the-user prompts, and per-user image builds (GitHub #58)

Open, docs only. It proposes two backlog items. Sub-agents are now built for OpenCode alone (record 12, "Subagents"): its built-in `general` and `explore`, bounded, started under the user's approval mode, and shown as one timeline row for the call that started each, with its work in the side panel's Agents view. What follows describes the other harnesses. Sub-agents were off in every harness (OpenCode's `task` permission is denied in `services/bridge/src/opencode.ts`; Codex runs with `agents.enabled=false`; Claude Code's `Agent` tool is denied in `services/bridge/src/claude.ts`), because their steps would not appear in the timeline, their model calls are not bounded by the run's limits, and nothing checks that they follow the approval and secret rules. Turning them on needs protocol events nested under the parent run, per-run limits, and a test C probe. The agent's ask-the-user prompts now reach a question card above the composer in every harness (record 04, "Questions to the user"). It also widens backlog A16 to every user's Modal workspace; A16 has since been resolved in that wider form (the resolved list in `history.md`).

### Harnesses other than OpenCode

The runtime-adapter boundary is built: `RUNTIME_CATALOG` in `packages/protocol/src/runtimes.ts` lists OpenCode 1.18.30, Codex 0.157.1, Pi 0.87.1, and Claude Code 2.1.283, and `resolveRuntime` (`apps/web/worker/runtime/resolve.ts`) allows only a harness the image installs (the catalog's `inImage`) that `ONCUE_RUNTIME_ALLOWLIST` names, OpenCode alone when unset. Settings, Harnesses lists only the harnesses the image installs, and shows "Not available yet" for one the deployment has not enabled (`apps/web/src/features/settings/HarnessesSection.tsx`). One image carries every enabled harness, each in its own layer (`HARNESS_LAYERS` in `services/sandbox-controller/images.py`); only Codex is installed today. Before each can be enabled:

- **Codex** (in the image, off): spike S3, one Codex session in a real Modal sandbox (its own sandbox off under gVisor, what else it contacts, a `secret_request` held ten minutes, the parser against a real stream) with a real recording; then a controller redeploy and test C with a Codex session live. Needs the operator to name a sitting and an OpenAI model.
- **Pi** (adapter in the bridge, not in the image): spike S5 (the extension holds `secret_request`, forwards OnCue's tools, stays offline), then the image layer, `inImage` set in the catalog, a redeploy, and test C. Its wire parser is built from Pi's documentation only.
- **Claude Code** (adapter in the bridge, not in the image): Claude Code support is built but disabled and not installed in the image. We have not yet confirmed it fits Anthropic's terms for third-party products ([consumer terms](https://www.anthropic.com/legal/consumer-terms), [commercial terms](https://www.anthropic.com/legal/commercial-terms)). That check, S0, comes first. Then a real recording, spikes S1 (it works through the relay unchanged) and S2 (the bridge drives it through the runtime host and holds a call past 60 seconds), the image layer, `inImage` set in the catalog, and test C.
- **S4** (image size and cold start) has run: adding Codex did not measurably slow sandbox starts, so one shared image stays. **S6** (cold against warm turns, and whether the richer resume replay stops a resumed agent from repeating work) has not run.

## Risks still live

- **Durable Object read cost.** The 2026-09-15 incident (an unbounded replay exchange multiplying a full event-log scan) is fixed, but no one has read the rows-read count of a hosted session since. Every per-frame or per-rearm read needs an index, and every loop with the bridge must be bounded on the object's side. The recovery record 04 once described for a gap larger than the bridge's 512-frame resend ring is not built.
- **Harness wire formats.** Each harness is pinned by version, and its normalizer is built against a recorded or documented session. A version bump means re-recording and re-running the parser tests; Pi's and Claude Code's parsers have never seen a real session.
- **Workers tracing cost.** The plan noted that Workers native tracing becomes billed in October 2026 (unverified here). Watch the Cloudflare bill after PR-14's telemetry ships.

- **Live lanes spend money.** Every Modal, GitHub, and model lane needs the operator's authorization for that sitting and its caps.
- **Vendored timeline components.** AI Elements components are OnCue source; re-running their installer overwrites local edits. Update one component at a time and review the diff.
