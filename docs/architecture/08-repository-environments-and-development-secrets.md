# Repository environments and development secrets

**Status:** Approved foundation

## Purpose

A remote agent is useful only if it can prepare, run, and check the repository. OnCue combines automatic detection with an optional, version-controlled `.oncue/project.yaml`, and supplies narrowly limited development secrets when a project cannot run without them.

## Decisions

- OnCue detects conventional project commands automatically.
- A repository may add `.oncue/project.yaml` for predictable setup and checks. It holds configuration and secret names, never values.
- Users save secret values in OnCue settings, per repository. Pasting one into chat does not save it.
- The secrets a session will receive are disclosed before launch.
- Only development and test credentials are supported. Production credentials, live payment keys, production databases, deployment keys, and cloud administrator credentials are excluded.
- A secret placed in the sandbox is treated as readable by the agent and by repository code.
- Anything reusable (images, caches, snapshots) is prepared before secrets arrive, and no secret-bearing sandbox is ever snapshotted.

## Configuration layers

The bridge resolves commands right after it clones the base commit (`services/bridge/src/repo-config.ts`), in this order, later layers winning:

1. **Platform defaults.**
2. **Detection.** `package.json` scripts named `test`, `lint`, `typecheck`, `build`, and `dev`, run with pnpm, yarn, or npm according to the lockfile present (npm when there is none). The lockfile also gives the install command (`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci`); with no lockfile there is no install. Detection is best-effort: it makes conventional projects work with no setup and is not expected to understand every repository.
3. **`.oncue/project.yaml`.** A small reader accepts only `version`, `commands` (the same five names), `preview` (`port` and `health_path`), and `secrets` (`required` and `optional` lists of names). Any other key, a list outside `secrets`, an anchor or alias, or deeper nesting is rejected with its line number and reason. A command the file names wins over detection.

No layer can enable production access or override a platform security boundary. Each resolved command carries its source (`platform default`, `detected`, or `.oncue/project.yaml`), and the bridge writes the resolved definition into the session's output as one `environment definition:` line, each command cut at 200 characters.

When at least one check command resolved, verification runs the install first, then `test` and `typecheck` as required checks and `lint` and `build` as recommended ones; `dev` is never a check (record 14).

An invalid file is ignored for commands, and the bridge resolves from detection alone. For secrets it matters earlier: see "Per-session disclosure".

## Validation and trust

The repository file is code-controlled input, not platform policy. Setup commands run inside the sandbox as the agent user. The file cannot ask for production credentials, another user's resources, OnCue credentials, base-branch writes, weaker isolation, or unauthenticated public ports; the reader has no key that could express any of these.

## Development secret storage

A saved secret belongs to one workspace and one repository connection (`development_secret`, migration `0008_development_secrets.sql`; `apps/web/worker/secrets/store.ts`). The value is sealed with the credential envelope (record 06) and never returned to the browser. The routes are in `apps/web/worker/routes/secrets.ts`: list names, save or replace a value, delete, and read what the project file asks for.

- **Names** match `^[A-Z][A-Z0-9_]{0,63}$`; reserved names and platform-credential names are refused; a file may declare at most 20, and a name in both lists is rejected (`services/bridge/src/secret-names.ts`).
- **Values** shorter than eight characters are refused because the redactor cannot protect them; values over 32 KiB are refused so they fit the supervisor's cap on one environment value; values containing a newline, carriage return, or NUL are refused because they could smuggle a second value.
- **Status** is `active`, or `unreadable` when the value cannot be decrypted, which asks the user to save it again.
- **A replaced value's old row is kept**, superseded (`0011_superseded_secrets.sql`), because a sandbox that was sent it still holds it. The object records which rows each generation was sent, by id, before the frame leaves, and rebuilds its redactor from those rows after a wake. Deleting a secret destroys the live row and its superseded copies.

The file can say `DATABASE_URL` is required but cannot choose which stored value is used; the name is resolved only after workspace and repository ownership are confirmed.

## Per-session disclosure

Before a session is created, the Worker reads `.oncue/project.yaml` at the base commit, on the branch the session starts from (record 07), under a `contents: read` token it revokes at once (`apps/web/worker/secrets/disclosure.ts`), so the disclosure comes from the control plane's own read, never from a sandbox. The composer's early read (`GET /api/repositories/:id/secret-requests`) verifies the GitHub installation first and answers `github_reverification_required` when it needs reconnecting, so the composer says so rather than that the file could not be read.

The disclosure card sits above the composer and blocks the first send. It groups names as **Required**, **Optional** (the user chooses whether to include each), and **Missing** (declared, nothing saved). An invalid file is shown with its line and reason, and the user may start without secrets. The user's answer travels with session creation and is judged again against the Worker's own read. A card drawn before the branch moved is refused with `base_moved` (409) naming the new tip, and the composer reads the card again there and shows it. What the launch disclosed is stored as names in the session object, remembered per repository (`0009_secret_disclosures.sql`), and recorded once as `secrets.disclosed`. Only names are ever recorded.

A session is degraded, and none of its runs can end `verified`, when a required name has nothing saved, when a required value has not yet been acknowledged by the current generation's bridge, or when it started from an invalid file (which may have named a required secret). The warning appears on the timeline and on every outcome.

"Supplied" and "approved" are different facts: the object records `secrets.supplied` only when the bridge acknowledges that the supervisor wrote the file.

### Asking during a run

The agent can ask for an optional name the user left unticked through the `secret_request` tool. The harness's permission mechanism holds the call (record 04 says how for each harness); the bridge asks the session object, which judges the request against its own rows (declared optional, saved, not already supplied to this generation, not denied in this run, at most five per run) and writes the approval card itself, expiring after ten minutes on its own clock. Silence denies. The gate is cooperative, since the agent user can reach the harness's loopback API, but answering it releases nothing: a value exists in the sandbox only when the object sends it after the user's click. Record 04 has the approval frames and record 09 the tier table.

## Where a value goes

The value is opened by the session object only when it sends it, in a `secret` grant over the bridge's socket: after `runtime.ready` for the launch's selection, and after the click for an approval. The object keeps names, never values, across hibernation. A grant the bridge never answers is settled as not delivered after two minutes.

The bridge passes the value to the root supervisor, which writes `/var/lib/oncue/secrets/<NAME>` in a directory it creates at start (owner root, group the agent's, mode 0750). Each file is created fresh with `O_EXCL | O_NOFOLLOW`, owner root, group the agent's, mode 0440, so only the agent user (and root) can read it. There is no combined env file. The supervisor adds the values to the environment of the checks it starts and to nothing else; the harness's own environment is untouched, and the tool's answer tells the agent the file's path. The launch's first prompt waits until the files are in place. The supervisor removes the files at `runtime.shutdown` and again whenever the bridge ends; a new generation starts with none and a resumed session is sent the launch's selection again.

On its way the value passes through the memory of the session object, the bridge, and the supervisor, which test C shows the agent cannot read. It never enters the bridge's environment, a file the bridge owns, an event, a log line, or an artifact. One exception: a check that prints its environment writes the value into its output file under `/var/lib/oncue/checks/`, which root writes and the bridge's group reads so the bridge can redact it before upload; that file lives for the sandbox's life.

The provider's filesystem snapshot is never taken while secrets can exist: `scripts/check-actor-boundary.mjs` fails `pnpm check` if the session lifecycle starts calling it.

## The unavoidable sandbox boundary

When an application reads a secret from a file or environment variable, other code in the same sandbox can usually read it too. Encryption protects a value stored and in transit, not in use. So every credential must be safe to expose in a temporary development machine: a payment provider's test key, a temporary test-database password, a narrow development token, a credential minted for the session. Never production payment keys, production database credentials, deployment or cloud administrator credentials, or permanent GitHub App or model-provider credentials.

## Redaction and publishing

The bridge knows the exact values it received and redacts them from every event payload, log line, streamed chunk (each stream holds back a tail that could be the start of a value, so a value split across chunks is still caught), and the bytes of every artifact it uploads (`services/bridge/src/redaction.ts`). The session object keeps its own redactor as a second layer. Both match exact values only: an encoded, transformed, or split value passes, as does one inside a binary file's patch. Redaction reduces accidental exposure; it is not a boundary.

While a session holds secrets, every checkpoint is scanned before anything is published. On a match, or when the patch cannot be read, the bridge pushes nothing, makes no patch bundle, revokes the unused push token, and reports `git.push.failed` with category `secret_in_changes`, naming at most five files and counting the rest. The object stores at most three such reports per generation. The work stays in the sandbox until the user removes the value from the files.

When a session ends, secret files are removed, session-issued credentials are revoked or expire, and anything else disappears with the sandbox.

## Failure behavior

- **Configuration is invalid:** The disclosure card names the line and reason; the user may start without secrets, and the session is degraded. The bridge resolves commands from detection.
- **Required secret is missing:** The session starts degraded and cannot end a run `verified`.
- **Secret cannot be decrypted:** The row becomes `unreadable`, nothing is sent, the card or launch row says "not delivered", and the user is asked to save it again. A required one keeps the session degraded.
- **Setup or check command fails:** Its log is kept, redacted, and names the command (record 14).

## Not built yet

- Session instructions as a configuration layer.
- Detection beyond `package.json` and lockfiles (runtime version files, Python projects, Dockerfiles and Compose, frameworks, documented setup steps), and a setup proposal the user can correct.
- `runtimes`, `setup`, and `services` in `.oncue/project.yaml`, local development services, browser verification starting points, cache-invalidation files, and approved network needs.
- Serving a preview: a declared `preview` is resolved and logged, and nothing serves it (record 09).
- Prepared environments, dependency caches, and snapshots, and recording the image version and lockfile checksums with the session.
- OnCue proposing a `.oncue/project.yaml` through a session branch.

See `../roadmap.md`.

## Conditions for reconsideration

Revisit before production access is introduced, when repositories need complex private-network dependencies, or when a sidecar or similar proxy becomes available that keeps secret values away from repository code while staying usable. Record 02 closed the sidecar path on provider availability.
